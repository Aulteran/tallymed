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
  db: Queryable, r: { householdId: string; userId: string; kind: ResetKind; issuedBy: string | null; expiresAt: Date },
): Promise<string> {
  const x = await db.query<{ id: string }>(
    `insert into password_resets (household_id, user_id, kind, issued_by, expires_at) values ($1, $2, $3, $4, $5) returning id`,
    [r.householdId, r.userId, r.kind, r.issuedBy, r.expiresAt],
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
