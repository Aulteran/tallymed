import type { Queryable } from '../db.ts';
import type { Role } from '../authz.ts';

export interface InvitationRow { id: string; householdId: string; email: string; role: Role }

export async function insertInvitation(
  db: Queryable,
  i: { householdId: string; email: string; role: Role; tokenHash: Buffer; invitedBy: string; expiresAt: Date },
): Promise<string> {
  const r = await db.query<{ id: string }>(
    `insert into invitations (household_id, email, role, token_hash, invited_by, expires_at)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [i.householdId, i.email, i.role, i.tokenHash, i.invitedBy, i.expiresAt],
  );
  return r.rows[0]!.id;
}

/** Locks and returns an open, unexpired invitation by token digest. */
export async function findOpenInvitation(db: Queryable, tokenHash: Buffer): Promise<InvitationRow | null> {
  const r = await db.query<InvitationRow>(
    `select id, household_id as "householdId", email, role from invitations
      where token_hash = $1 and accepted_at is null and revoked_at is null and expires_at > now() for update`,
    [tokenHash],
  );
  return r.rows[0] ?? null;
}

export async function markInvitationAccepted(db: Queryable, id: string): Promise<void> {
  await db.query('update invitations set accepted_at = now() where id = $1', [id]);
}

export async function expireOpenInvitationsFor(db: Queryable, householdId: string, email: string): Promise<void> {
  await db.query(
    `update invitations set revoked_at = now()
      where household_id = $1 and lower(email) = lower($2) and accepted_at is null and revoked_at is null and expires_at <= now()`,
    [householdId, email],
  );
}
