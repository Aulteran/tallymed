import type { Queryable } from '../db.ts';

const LOCK_ACCOUNT = 7_203_501;
const LOCK_IP = 7_203_502;

export async function recordAttempt(db: Queryable, emailHash: Buffer, ip: string, succeeded: boolean): Promise<void> {
  await db.query('insert into login_attempts (email_hash, client_ip, succeeded) values ($1, $2, $3)', [emailHash, ip, succeeded]);
}

/**
 * Serializes throttle decisions per account (and per trusted client address) for the rest of the
 * transaction. Locks are always taken account first, then address, so they cannot deadlock.
 */
export async function lockThrottleKeys(db: Queryable, emailHash: Buffer, ip: string | null): Promise<void> {
  await db.query('select pg_advisory_xact_lock($1, hashtext($2))', [LOCK_ACCOUNT, emailHash.toString('hex')]);
  if (ip) await db.query('select pg_advisory_xact_lock($1, hashtext($2))', [LOCK_IP, ip]);
}

/** Removes expired rows for these keys. Indexed, so cheap enough to run on every login. */
export async function pruneKeys(db: Queryable, emailHash: Buffer, ip: string | null, olderThanSeconds: number): Promise<void> {
  await db.query(
    `delete from login_attempts
      where attempted_at < now() - make_interval(secs => $3) and (email_hash = $1 or ($2::text is not null and client_ip = $2))`,
    [emailHash, ip, olderThanSeconds],
  );
}

export async function countRecentFailures(
  db: Queryable, emailHash: Buffer, ip: string | null, windowSeconds: number,
): Promise<{ account: number; ip: number }> {
  const r = await db.query<{ account: string; ip: string }>(
    `select count(*) filter (where email_hash = $1) as account,
            count(*) filter (where $2::text is not null and client_ip = $2) as ip
       from login_attempts
      where succeeded = false and attempted_at > now() - make_interval(secs => $3)
        and (email_hash = $1 or client_ip = $2)`,
    [emailHash, ip, windowSeconds],
  );
  return { account: Number(r.rows[0]!.account), ip: Number(r.rows[0]!.ip) };
}

export async function clearAccountFailures(db: Queryable, emailHash: Buffer): Promise<void> {
  await db.query('delete from login_attempts where email_hash = $1 and succeeded = false', [emailHash]);
}

export async function pruneAttempts(db: Queryable, olderThanSeconds: number): Promise<void> {
  await db.query('delete from login_attempts where attempted_at < now() - make_interval(secs => $1)', [olderThanSeconds]);
}
