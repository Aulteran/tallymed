import type { Queryable } from '../db.ts';

export interface IdentityRow {
  id: string; userId: string; householdId: string; issuer: string; subject: string; emailAtLink: string;
  createdVia: 'email_match' | 'provisioned'; createdAt: Date; lastLoginAt: Date | null;
}

const COLUMNS = `i.id, i.user_id as "userId", i.household_id as "householdId", i.issuer, i.subject, i.email_at_link as "emailAtLink",
  i.created_via as "createdVia", i.created_at as "createdAt", i.last_login_at as "lastLoginAt"`;

export async function findIdentity(db: Queryable, issuer: string, subject: string): Promise<IdentityRow | null> {
  const r = await db.query<IdentityRow>(`select ${COLUMNS} from user_identities i where i.issuer = $1 and i.subject = $2`, [issuer, subject]);
  return r.rows[0] ?? null;
}

export async function findIdentityOfUser(db: Queryable, userId: string, issuer: string): Promise<IdentityRow | null> {
  const r = await db.query<IdentityRow>(`select ${COLUMNS} from user_identities i where i.user_id = $1 and i.issuer = $2`, [userId, issuer]);
  return r.rows[0] ?? null;
}

export async function insertIdentity(
  db: Queryable, i: { userId: string; householdId: string; issuer: string; subject: string; emailAtLink: string; createdVia: IdentityRow['createdVia'] },
): Promise<string> {
  const r = await db.query<{ id: string }>(
    `insert into user_identities (user_id, household_id, issuer, subject, email_at_link, created_via) values ($1, $2, $3, $4, $5, $6) returning id`,
    [i.userId, i.householdId, i.issuer, i.subject, i.emailAtLink, i.createdVia],
  );
  return r.rows[0]!.id;
}

export async function touchIdentity(db: Queryable, id: string): Promise<void> {
  await db.query('update user_identities set last_login_at = now() where id = $1', [id]);
}

export async function deleteIdentity(db: Queryable, householdId: string, id: string): Promise<IdentityRow | null> {
  const r = await db.query<IdentityRow>(
    `delete from user_identities i where i.household_id = $1 and i.id = $2 returning ${COLUMNS}`, [householdId, id]);
  return r.rows[0] ?? null;
}

export interface LinkedAccount extends IdentityRow { email: string; displayName: string; role: 'admin' | 'operator'; status: 'active' | 'disabled' }

export async function listIdentities(db: Queryable, householdId: string): Promise<LinkedAccount[]> {
  const r = await db.query<LinkedAccount>(
    `select ${COLUMNS}, u.email, u.display_name as "displayName", u.role, u.status
       from user_identities i join users u on u.id = i.user_id where i.household_id = $1 order by i.created_at, i.id`, [householdId]);
  return r.rows;
}

/** True when an active administrator has actually signed in through this issuer. Password sign-in can only be off while this holds. */
export async function adminHasSignedInWith(db: Queryable, issuer: string, userId?: string): Promise<boolean> {
  const r = await db.query(
    `select 1 from user_identities i join users u on u.id = i.user_id
      where i.issuer = $1 and i.last_login_at is not null and u.role = 'admin' and u.status = 'active' and ($2::uuid is null or u.id = $2) limit 1`,
    [issuer, userId ?? null]);
  return (r.rowCount ?? 0) > 0;
}
