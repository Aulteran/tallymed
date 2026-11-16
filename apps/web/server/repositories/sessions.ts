import type { Queryable } from '../db.ts';
import type { Actor } from '../authz.ts';

export async function insertSession(
  db: Queryable, s: { userId: string; householdId: string; tokenHash: Buffer; expiresAt: Date; remember?: boolean },
): Promise<string> {
  const r = await db.query<{ id: string }>(
    `insert into sessions (user_id, household_id, token_hash, expires_at, remember) values ($1, $2, $3, $4, $5) returning id`,
    [s.userId, s.householdId, s.tokenHash, s.expiresAt, s.remember ?? false],
  );
  return r.rows[0]!.id;
}

export type ActiveSession = Omit<Actor, 'locked'> & { lastSeenAt: Date; lockedAt: Date | null };

/**
 * Returns the session only while it is unexpired, unrevoked and not idle for an active user. A session started with "Keep me signed in"
 * is measured against `rememberIdleSeconds`; every other session is measured exactly as before.
 */
export async function findActiveSession(
  db: Queryable, tokenHash: Buffer, idleSeconds: number, rememberIdleSeconds: number = idleSeconds,
): Promise<ActiveSession | null> {
  const r = await db.query<ActiveSession>(
    `select s.id as "sessionId", u.id as "userId", s.household_id as "householdId", u.role,
            u.display_name as "displayName", u.must_change_password as "mustChangePassword", s.last_seen_at as "lastSeenAt",
            s.remember, s.locked_at as "lockedAt", (u.pin_hash is not null) as "hasPin"
       from sessions s join users u on u.id = s.user_id
      where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now()
        and s.last_seen_at > now() - make_interval(secs => case when s.remember then $3::double precision else $2::double precision end)
        and u.status = 'active'`,
    [tokenHash, idleSeconds, rememberIdleSeconds],
  );
  return r.rows[0] ?? null;
}

/** Locks the session. Returns true only for the call that changed it, so the audit trail gets one row per lock. */
export async function markSessionLocked(db: Queryable, id: string): Promise<boolean> {
  const r = await db.query(`update sessions set locked_at = now() where id = $1 and locked_at is null and revoked_at is null`, [id]);
  return r.rowCount === 1;
}

/**
 * Counts a PIN attempt before the PIN is checked, atomically, so a concurrent burst cannot try more guesses than the limit.
 * Returns the number of attempts including this one, or null when the session is gone.
 */
export async function reservePinAttempt(db: Queryable, id: string): Promise<number | null> {
  const r = await db.query<{ n: number }>(
    `update sessions set pin_failures = pin_failures + 1 where id = $1 and revoked_at is null and expires_at > now() returning pin_failures as n`, [id]);
  return r.rows[0]?.n ?? null;
}

/** A correct PIN: opens the session, forgives earlier wrong guesses and counts as activity. */
export async function unlockSessionRow(db: Queryable, id: string): Promise<boolean> {
  const r = await db.query(
    `update sessions set locked_at = null, pin_failures = 0, last_seen_at = now() where id = $1 and revoked_at is null and expires_at > now()`, [id]);
  return r.rowCount === 1;
}

/** A correct PIN proven for another purpose (changing the PIN) forgives earlier wrong guesses without changing the lock. */
export async function clearPinAttempts(db: Queryable, id: string): Promise<void> {
  await db.query(`update sessions set pin_failures = 0 where id = $1`, [id]);
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
