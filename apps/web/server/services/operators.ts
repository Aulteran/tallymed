import type { AppConfig } from '../config.ts';
import { AppError } from '../errors.ts';
import { isUniqueViolation, withTransaction, type Pool } from '../db.ts';
import { authorize, type Actor, type Role } from '../authz.ts';
import { hashPassword } from '../passwords.ts';
import { recordAudit } from '../repositories/audit.ts';
import {
  expireOpenInvitationsFor, findOpenInvitation, insertInvitation, listOpenInvitations, markInvitationAccepted,
  revokeOpenInvitation,
} from '../repositories/invitations.ts';
import { revokeUserSessions } from '../repositories/sessions.ts';
import {
  countUsableAdminsExcluding, findUserByEmail, findUserInHousehold, insertUser, listUsers, updateUserRoleStatus,
} from '../repositories/users.ts';
import { listPending } from '../repositories/password-resets.ts';
import { digest, newToken } from '../tokens.ts';
import { ADMIN_LOCK } from './credentials.ts';
import { parse, schemas } from '../validation.ts';


/** Accounts with their pending temporary-password state (never any secret) for the operator list. */
export async function listOperators(pool: Pool, actor: Actor) {
  authorize(actor, 'operators:manage');
  const [users, pending] = await Promise.all([listUsers(pool, actor.householdId), listPending(pool, actor.householdId)]);
  const byUser = new Map(pending.map((p) => [p.userId, p]));
  return users.map((u) => ({ ...u, pendingReset: byUser.get(u.id) ?? null }));
}

/** One account for the reset confirmation page. A missing account and one in another household look the same. */
export async function getOperatorForReset(pool: Pool, actor: Actor, id: string) {
  authorize(actor, 'operators:manage');
  const u = await findUserInHousehold(pool, actor.householdId, id);
  if (!u) throw new AppError('not_found');
  const { passwordHash: _omit, ...rest } = u;
  return rest;
}

export async function listInvitations(pool: Pool, actor: Actor) {
  authorize(actor, 'operators:manage');
  return listOpenInvitations(pool, actor.householdId);
}

/** Admin-only. Revoking frees the address, so re-issuing is revoke followed by a new invitation. */
export async function revokeInvitation(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<void> {
  authorize(actor, 'operators:manage');
  const data = parse(schemas.revokeInvitation, input);
  await withTransaction(pool, async (tx) => {
    if (!(await revokeOpenInvitation(tx, actor.householdId, data.invitationId))) throw new AppError('not_found');
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'operator.invitation_revoked', entityType: 'invitation',
      entityId: data.invitationId, requestId,
    });
  });
}

/** Admin-only. The raw token is returned once; only its SHA-256 digest is stored. */
export async function inviteOperator(
  pool: Pool, config: AppConfig, actor: Actor, input: unknown, requestId: string,
): Promise<{ token: string; expiresAt: Date; email: string }> {
  authorize(actor, 'operators:manage');
  const data = parse(schemas.invite, input);
  if (await findUserByEmail(pool, data.email)) throw new AppError('conflict', 'An account already exists for that address');
  const token = newToken();
  const expiresAt = new Date(Date.now() + config.invitationSeconds * 1000);
  try {
    await withTransaction(pool, async (tx) => {
      await expireOpenInvitationsFor(tx, actor.householdId, data.email);
      const id = await insertInvitation(tx, {
        householdId: actor.householdId, email: data.email, role: data.role, tokenHash: digest(token),
        invitedBy: actor.userId, expiresAt,
      });
      await recordAudit(tx, {
        householdId: actor.householdId, actorUserId: actor.userId, action: 'operator.invited', entityType: 'invitation',
        entityId: id, requestId, detail: { role: data.role },
      });
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError('conflict', 'An invitation is already open for that address');
    throw error;
  }
  return { token, expiresAt, email: data.email };
}

/** Public endpoint: the invitation token is the credential. Errors are uniform to avoid token probing. */
export async function acceptInvitation(pool: Pool, input: unknown, requestId: string): Promise<{ userId: string }> {
  const data = parse(schemas.accept, input);
  const tokenHash = digest(data.token);
  // Cheap precheck before spending Argon2 time on unknown tokens.
  if (!(await findOpenInvitation(pool, tokenHash))) throw new AppError('not_found', 'Invitation is invalid or expired');
  const passwordHash = await hashPassword(data.password);
  try {
    return await withTransaction(pool, async (tx) => {
      const invitation = await findOpenInvitation(tx, tokenHash);
      if (!invitation) throw new AppError('not_found', 'Invitation is invalid or expired');
      const userId = await insertUser(tx, {
        householdId: invitation.householdId, email: invitation.email, displayName: data.displayName,
        role: invitation.role, passwordHash,
      });
      await markInvitationAccepted(tx, invitation.id);
      await recordAudit(tx, {
        householdId: invitation.householdId, actorUserId: userId, action: 'operator.accepted_invitation',
        entityType: 'user', entityId: userId, requestId, detail: { role: invitation.role },
      });
      return { userId };
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError('conflict', 'An account already exists for that address');
    throw error;
  }
}

/**
 * Admin-only role/status change guarded by the row version. Any change to privileges revokes every
 * session of the target so the new privilege level is never mixed with an old session.
 */
export async function updateOperator(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<void> {
  authorize(actor, 'operators:manage');
  const data = parse(schemas.updateOperator, input);
  await withTransaction(pool, async (tx) => {
    await tx.query('select pg_advisory_xact_lock($1, hashtext($2))', [ADMIN_LOCK, actor.householdId]);
    const target = await findUserInHousehold(tx, actor.householdId, data.userId, true);
    if (!target) throw new AppError('not_found');
    if (target.version !== data.version) throw new AppError('stale_version');
    const changed = target.role !== data.role || target.status !== data.status;
    if (!changed) return;
    const losesAdmin = target.role === 'admin' && target.status === 'active' && !(data.role === 'admin' && data.status === 'active');
    // Count only administrators who can actually sign in: an account waiting to change a temporary password does not count.
    if (losesAdmin && (await countUsableAdminsExcluding(tx, actor.householdId, target.id)) < 1) {
      throw new AppError('conflict', 'The household must keep at least one active administrator');
    }
    if (!(await updateUserRoleStatus(tx, actor.householdId, target.id, data.version, data.role as Role, data.status))) {
      throw new AppError('stale_version');
    }
    const revoked = await revokeUserSessions(tx, target.id, 'privilege_change');
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'operator.updated', entityType: 'user',
      entityId: target.id, requestId,
      detail: { fromRole: target.role, toRole: data.role, fromStatus: target.status, toStatus: data.status, sessionsRevoked: revoked },
    });
  });
}
