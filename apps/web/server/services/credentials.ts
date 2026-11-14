import { randomInt } from 'node:crypto';
import type { AppConfig } from '../config.ts';
import { AppError } from '../errors.ts';
import { withTransaction, type Pool, type Queryable } from '../db.ts';
import { authorize, type Actor } from '../authz.ts';
import { assertPasswordPolicy, hashPassword, verifyPassword } from '../passwords.ts';
import { recordAudit } from '../repositories/audit.ts';
import { completePending, insertReset, supersedePending, type ResetKind } from '../repositories/password-resets.ts';
import { insertSession, revokeUserSessions } from '../repositories/sessions.ts';
import { clearAccountFailures, countRecentFailures, lockThrottleKeys, pruneKeys, recordAttempt } from '../repositories/throttle.ts';
import {
  countUsableAdminsExcluding, findUserInHousehold, setChosenPassword, setTemporaryPassword, type UserRow,
} from '../repositories/users.ts';
import { digest, newToken } from '../tokens.ts';
import { parse, schemas } from '../validation.ts';
import { MAX_ACCOUNT_FAILURES, THROTTLE_WINDOW_SECONDS } from './auth.ts';

/** Shared with operator role and status changes so privilege and credential changes for one household never interleave. */
export const ADMIN_LOCK = 7_203_403;

// 31 symbols without 0/O/1/I/L lookalikes. Four groups of five give about 99 bits, far beyond online guessing, and the throttle
// still applies to every sign-in.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const GROUPS = 4;
const GROUP_LENGTH = 5;

/** A random temporary password such as `K7M2P-9QXWD-FA3TH-6NBCR`. Uses the operating system's CSPRNG with unbiased selection. */
export function generateTemporaryPassword(): string {
  const groups: string[] = [];
  for (let g = 0; g < GROUPS; g++) {
    let part = '';
    for (let i = 0; i < GROUP_LENGTH; i++) part += ALPHABET[randomInt(ALPHABET.length)];
    groups.push(part);
  }
  return groups.join('-');
}

export interface PendingPasswordView { state: 'open' | 'expired' | 'used'; expiresAt: Date }

export interface IssuedTemporaryPassword {
  /** Shown to the administrator once. Only its Argon2id hash is stored, and it is never logged or audited. */
  temporaryPassword: string;
  expiresAt: Date;
  email: string;
  displayName: string;
}

/**
 * The one place an administrator-issued temporary credential is created. It replaces the password hash (the old password stops working immediately), requires a change at the next sign-in, retires
 * any earlier pending credential, signs every session out, clears the sign-in lockout, and records the credential without
 * its secret. Self-service (emailed) credentials deliberately do not use this: replacing the password on request would let a
 * stranger lock an account out, so they stay beside the password until used (see forgot-password.ts and login in auth.ts).
 */
export async function issueTemporaryCredential(
  tx: Queryable, config: Pick<AppConfig, 'temporaryPasswordSeconds'>,
  args: { target: UserRow; kind: Extract<ResetKind, 'admin_temporary'>; issuedBy: string | null; passwordHash: string; revokeReason: string },
): Promise<{ resetId: string; expiresAt: Date; sessionsRevoked: number }> {
  await supersedePending(tx, args.target.id);
  await setTemporaryPassword(tx, args.target.id, args.passwordHash);
  const sessionsRevoked = await revokeUserSessions(tx, args.target.id, args.revokeReason);
  await clearAccountFailures(tx, digest(args.target.email.trim().toLowerCase()));
  const expiresAt = new Date(Date.now() + config.temporaryPasswordSeconds * 1000);
  const resetId = await insertReset(tx, {
    householdId: args.target.householdId, userId: args.target.id, kind: args.kind, issuedBy: args.issuedBy, expiresAt,
  });
  return { resetId, expiresAt, sessionsRevoked };
}

/**
 * Administrator-issued temporary password. An administrator cannot reset their own password here (they use Change password),
 * a disabled account is not reset, the optimistic version stops a double submit from issuing two different secrets, and the
 * household lock makes two administrators resetting each other serialize: the second sees its own session already revoked.
 */
export async function resetOperatorPassword(
  pool: Pool, config: AppConfig, actor: Actor, input: unknown, requestId: string,
): Promise<IssuedTemporaryPassword> {
  authorize(actor, 'operators:manage');
  const data = parse(schemas.resetPassword, input);
  if (data.userId === actor.userId) throw new AppError('self_reset_blocked');
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  return withTransaction(pool, async (tx) => {
    await tx.query('select pg_advisory_xact_lock($1, hashtext($2))', [ADMIN_LOCK, actor.householdId]);
    // Re-verify the actor under the lock: privileges or the session may have changed since the request was authenticated.
    const live = await tx.query<{ ok: boolean }>(
      `select true as ok from sessions s join users u on u.id = s.user_id
        where s.id = $1 and u.id = $2 and s.revoked_at is null and s.expires_at > now() and u.status = 'active'
          and u.role = 'admin' and not u.must_change_password`,
      [actor.sessionId, actor.userId],
    );
    if (live.rowCount !== 1) throw new AppError('unauthenticated');
    const target = await findUserInHousehold(tx, actor.householdId, data.userId, true);
    if (!target) throw new AppError('not_found');
    if (target.version !== data.version) throw new AppError('stale_version');
    if (target.status !== 'active') throw new AppError('reset_not_allowed', 'Enable the account before resetting its password');
    // Defense in depth: the household must keep an active administrator with a usable password besides the account being reset.
    if (target.role === 'admin' && (await countUsableAdminsExcluding(tx, actor.householdId, target.id)) < 1) {
      throw new AppError('reset_not_allowed', 'The household must keep at least one active administrator');
    }
    const issued = await issueTemporaryCredential(tx, config, {
      target, kind: 'admin_temporary', issuedBy: actor.userId, passwordHash, revokeReason: 'password_reset',
    });
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'auth.password_reset_issued', entityType: 'user',
      entityId: target.id, requestId,
      detail: { kind: 'admin_temporary', expiresAt: issued.expiresAt.toISOString(), sessionsRevoked: issued.sessionsRevoked },
    });
    return { temporaryPassword, expiresAt: issued.expiresAt, email: target.email, displayName: target.displayName };
  });
}

const CHANGE_THROTTLE_PREFIX = 'password-change:';
const changeKey = (userId: string) => digest(`${CHANGE_THROTTLE_PREFIX}${userId}`);

export interface ChangePasswordResult { token: string; expiresAt: Date; sessionsRevoked: number }

/**
 * Replaces the signed-in person's password. A normal change needs the current password (guesses are throttled per account, so a
 * stolen session cannot be used to guess it); a forced change after a temporary password does not, because the sign-in that
 * produced this restricted session was the proof. Every session of the account is revoked and a fresh one is returned so the
 * person stays signed in on this device only.
 */
export async function changePassword(
  pool: Pool, config: AppConfig, actor: Actor, input: unknown, requestId: string,
): Promise<ChangePasswordResult> {
  const data = parse(schemas.changePassword, input);
  const forced = actor.mustChangePassword;
  assertPasswordPolicy(data.newPassword);
  if (data.newPassword !== data.confirmPassword) throw new AppError('invalid_input', 'The new passwords do not match');
  const user = await findUserInHousehold(pool, actor.householdId, actor.userId);
  if (!user || user.status !== 'active') throw new AppError('unauthenticated');

  let failuresBefore = 0;
  if (!forced) {
    if (!data.currentPassword) throw new AppError('invalid_input');
    const key = changeKey(user.id);
    // Reserve the attempt before verifying, as sign-in does, so a concurrent burst cannot exceed the limit.
    failuresBefore = await withTransaction(pool, async (tx) => {
      await lockThrottleKeys(tx, key, null);
      await pruneKeys(tx, key, null, THROTTLE_WINDOW_SECONDS);
      const failures = await countRecentFailures(tx, key, null, THROTTLE_WINDOW_SECONDS);
      if (failures.account >= MAX_ACCOUNT_FAILURES) throw new AppError('rate_limited', 'Too many attempts', THROTTLE_WINDOW_SECONDS);
      await recordAttempt(tx, key, 'untrusted', false);
      return failures.account;
    });
    if (!(await verifyPassword(user.passwordHash, data.currentPassword))) {
      if (failuresBefore === 0) {
        await recordAudit(pool, {
          householdId: user.householdId, actorUserId: user.id, action: 'auth.password_change_failed', entityType: 'user', entityId: user.id, requestId,
        });
      } else if (failuresBefore + 1 === MAX_ACCOUNT_FAILURES) {
        await recordAudit(pool, {
          householdId: user.householdId, actorUserId: user.id, action: 'auth.password_change_locked', entityType: 'user', entityId: user.id, requestId,
        });
      }
      throw new AppError('invalid_input', 'The current password is not correct');
    }
    await clearAccountFailures(pool, key);
  }
  if (await verifyPassword(user.passwordHash, data.newPassword)) {
    throw new AppError('invalid_input', 'Choose a password different from the current one');
  }
  const passwordHash = await hashPassword(data.newPassword);
  const token = newToken();
  const expiresAt = new Date(Date.now() + config.sessionAbsoluteSeconds * 1000);
  return withTransaction(pool, async (tx) => {
    const locked = await findUserInHousehold(tx, actor.householdId, actor.userId, true);
    // The session, the credential that was verified and the restriction must all be unchanged since this request began.
    const live = await tx.query('select 1 from sessions where id = $1 and revoked_at is null and expires_at > now()', [actor.sessionId]);
    if (!locked || locked.status !== 'active' || locked.passwordHash !== user.passwordHash || locked.mustChangePassword !== forced || live.rowCount !== 1) {
      throw new AppError('unauthenticated');
    }
    await setChosenPassword(tx, locked.id, passwordHash);
    await completePending(tx, locked.id);
    const sessionsRevoked = await revokeUserSessions(tx, locked.id, 'password_changed');
    const sessionId = await insertSession(tx, { userId: locked.id, householdId: locked.householdId, tokenHash: digest(token), expiresAt });
    if (!forced) await clearAccountFailures(tx, changeKey(locked.id));
    await recordAudit(tx, {
      householdId: locked.householdId, actorUserId: locked.id, action: 'auth.password_changed', entityType: 'user', entityId: locked.id, requestId,
      detail: { forced, sessionsRevoked, newSessionId: sessionId },
    });
    return { token, expiresAt, sessionsRevoked };
  });
}
