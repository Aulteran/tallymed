import type { Queryable } from '../db.ts';

export type ResetKind = 'admin_temporary' | 'email_temporary';
export type ResetStatus = 'open' | 'used' | 'completed' | 'superseded';

export interface PasswordResetRow {
  id: string;
  householdId: string;
  userId: string;
  kind: ResetKind;
  status: ResetStatus;
  expiresAt: Date;
  /** Computed by the database clock so every comparison uses one time source. */
  expired: boolean;
}

const COLUMNS = `id, household_id as "householdId", user_id as "userId", kind, status, expires_at as "expiresAt",
  (expires_at <= now()) as expired`;

/** Retires any temporary credential still pending for the account (a new reset replaces it). */
export async function supersedePending(db: Queryable, userId: string): Promise<number> {
  const r = await db.query(`update password_resets set status = 'superseded' where user_id = $1 and status in ('open', 'used')`, [userId]);
  return r.rowCount ?? 0;
}

export async function insertReset(
  db: Queryable,
  r: { householdId: string; userId: string; kind: ResetKind; issuedBy: string | null; expiresAt: Date; secretHash?: string | null },
): Promise<string> {
  const x = await db.query<{ id: string }>(
    `insert into password_resets (household_id, user_id, kind, issued_by, expires_at, secret_hash) values ($1, $2, $3, $4, $5, $6) returning id`,
    [r.householdId, r.userId, r.kind, r.issuedBy, r.expiresAt, r.secretHash ?? null],
  );
  return x.rows[0]!.id;
}

/** The temporary credential still pending for the account (open or already used to sign in), if any. */
export async function findPending(db: Queryable, userId: string, lock = false): Promise<PasswordResetRow | null> {
  const r = await db.query<PasswordResetRow>(
    `select ${COLUMNS} from password_resets where user_id = $1 and status in ('open', 'used')
      order by created_at desc limit 1${lock ? ' for update' : ''}`,
    [userId],
  );
  return r.rows[0] ?? null;
}

/** Marks an open, unexpired credential used. Returns false when it was already used, expired or replaced. */
export async function markUsed(db: Queryable, id: string): Promise<boolean> {
  const r = await db.query(
    `update password_resets set status = 'used', used_at = now() where id = $1 and status = 'open' and expires_at > now()`, [id]);
  return r.rowCount === 1;
}

export async function completePending(db: Queryable, userId: string): Promise<void> {
  await db.query(
    `update password_resets set status = 'completed', completed_at = now(), used_at = coalesce(used_at, now())
      where user_id = $1 and status in ('open', 'used')`,
    [userId],
  );
}

export interface PendingSummary { userId: string; state: 'open' | 'expired' | 'used'; expiresAt: Date }

/** Pending temporary credentials of a household, for the administrator's operator list. No secrets exist to return. */
export async function listPending(db: Queryable, householdId: string): Promise<PendingSummary[]> {
  const r = await db.query<{ userId: string; status: 'open' | 'used'; expiresAt: Date; expired: boolean }>(
    `select user_id as "userId", status, expires_at as "expiresAt", (expires_at <= now()) as expired
       from password_resets where household_id = $1 and status in ('open', 'used')`,
    [householdId],
  );
  return r.rows.map((x) => ({ userId: x.userId, expiresAt: x.expiresAt, state: x.status === 'used' ? 'used' : x.expired ? 'expired' : 'open' }));
}

export interface EmailResetSecret { id: string; secretHash: string; expired: boolean }

/** The emailed temporary credential that has not been used yet (its hash is held here, not in users.password_hash). */
export async function findOpenEmailReset(db: Queryable, userId: string, lock = false): Promise<EmailResetSecret | null> {
  const r = await db.query<EmailResetSecret>(
    `select id, secret_hash as "secretHash", (expires_at <= now()) as expired from password_resets
      where user_id = $1 and kind = 'email_temporary' and status = 'open'${lock ? ' for update' : ''}`,
    [userId],
  );
  return r.rows[0] ?? null;
}

/** Retires an unused emailed credential (the person signed in with their password, or delivery failed). Returns how many were retired. */
export async function supersedeOpenEmailResets(db: Queryable, userId: string, onlyId?: string): Promise<number> {
  const r = await db.query(
    `update password_resets set status = 'superseded'
      where user_id = $1 and kind = 'email_temporary' and status = 'open' and ($2::uuid is null or id = $2)`,
    [userId, onlyId ?? null],
  );
  return r.rowCount ?? 0;
}

/** Emailed credentials created for the account: how many in the last day and how many seconds since the newest. */
export async function emailResetHistory(db: Queryable, userId: string): Promise<{ lastDay: number; sinceNewestSeconds: number | null }> {
  const r = await db.query<{ n: string; since: string | null }>(
    `select count(*) as n, extract(epoch from now() - max(created_at)) as since from password_resets
      where user_id = $1 and kind = 'email_temporary' and created_at > now() - interval '24 hours'`,
    [userId],
  );
  return { lastDay: Number(r.rows[0]!.n), sinceNewestSeconds: r.rows[0]!.since === null ? null : Number(r.rows[0]!.since) };
}

/** Request log for the self-service limits. Keyed by digests, written for known and unknown addresses alike. */
export async function lockRequestKeys(db: Queryable, emailHash: Buffer, ip: string): Promise<void> {
  await db.query('select pg_advisory_xact_lock(7203601, hashtext($1))', [emailHash.toString('hex')]);
  await db.query('select pg_advisory_xact_lock(7203602, hashtext($1))', [ip]);
}

export async function countRequests(db: Queryable, emailHash: Buffer, ip: string, windowSeconds: number): Promise<{ address: number; ip: number }> {
  await db.query(`delete from password_reset_requests where requested_at < now() - interval '24 hours'`);
  const r = await db.query<{ address: string; ip: string }>(
    `select count(*) filter (where email_hash = $1) as address, count(*) filter (where client_ip = $2) as ip
       from password_reset_requests
      where requested_at > now() - make_interval(secs => $3) and (email_hash = $1 or client_ip = $2)`,
    [emailHash, ip, windowSeconds],
  );
  return { address: Number(r.rows[0]!.address), ip: Number(r.rows[0]!.ip) };
}

export async function recordRequest(db: Queryable, emailHash: Buffer, ip: string): Promise<void> {
  await db.query('insert into password_reset_requests (email_hash, client_ip) values ($1, $2)', [emailHash, ip]);
}
