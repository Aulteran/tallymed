import type { Queryable } from '../db.ts';

export async function recordAttempt(db: Queryable, emailHash: Buffer, ip: string, succeeded: boolean): Promise<void> {
  await db.query('insert into login_attempts (email_hash, client_ip, succeeded) values ($1, $2, $3)', [emailHash, ip, succeeded]);
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
