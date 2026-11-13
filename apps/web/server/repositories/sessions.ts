import type { Queryable } from '../db.ts';
import type { Actor } from '../authz.ts';

export async function insertSession(
  db: Queryable, s: { userId: string; householdId: string; tokenHash: Buffer; expiresAt: Date },
): Promise<string> {
  const r = await db.query<{ id: string }>(
    `insert into sessions (user_id, household_id, token_hash, expires_at) values ($1, $2, $3, $4) returning id`,
    [s.userId, s.householdId, s.tokenHash, s.expiresAt],
  );
  return r.rows[0]!.id;
}

/** Returns the actor only for an unexpired, unrevoked, non-idle session of an active user. */
export async function findActiveSession(db: Queryable, tokenHash: Buffer, idleSeconds: number): Promise<(Actor & { lastSeenAt: Date }) | null> {
  const r = await db.query<Actor & { lastSeenAt: Date }>(
    `select s.id as "sessionId", u.id as "userId", s.household_id as "householdId", u.role,
            u.display_name as "displayName", s.last_seen_at as "lastSeenAt"
       from sessions s join users u on u.id = s.user_id
      where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now()
        and s.last_seen_at > now() - make_interval(secs => $2) and u.status = 'active'`,
    [tokenHash, idleSeconds],
  );
  return r.rows[0] ?? null;
}

export async function touchSession(db: Queryable, id: string): Promise<void> {
  await db.query('update sessions set last_seen_at = now() where id = $1', [id]);
}

export async function revokeSession(db: Queryable, id: string, reason: string): Promise<void> {
  await db.query(`update sessions set revoked_at = now(), revoked_reason = $2 where id = $1 and revoked_at is null`, [id, reason]);
}

export async function revokeUserSessions(db: Queryable, userId: string, reason: string): Promise<number> {
  const r = await db.query(
    `update sessions set revoked_at = now(), revoked_reason = $2 where user_id = $1 and revoked_at is null`, [userId, reason]);
  return r.rowCount ?? 0;
}
