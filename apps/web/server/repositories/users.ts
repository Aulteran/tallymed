import type { Queryable } from '../db.ts';
import type { Role } from '../authz.ts';

export interface UserRow {
  id: string;
  householdId: string;
  email: string;
  displayName: string;
  role: Role;
  status: 'active' | 'disabled';
  passwordHash: string;
  version: number;
}

const COLUMNS = `id, household_id as "householdId", email, display_name as "displayName", role, status,
  password_hash as "passwordHash", version`;

export async function findUserByEmail(db: Queryable, email: string): Promise<UserRow | null> {
  const r = await db.query<UserRow>(`select ${COLUMNS} from users where lower(email) = lower($1)`, [email]);
  return r.rows[0] ?? null;
}

export async function findUserInHousehold(db: Queryable, householdId: string, id: string, lock = false): Promise<UserRow | null> {
  const r = await db.query<UserRow>(
    `select ${COLUMNS} from users where household_id = $1 and id = $2${lock ? ' for update' : ''}`,
    [householdId, id],
  );
  return r.rows[0] ?? null;
}

export async function listUsers(db: Queryable, householdId: string): Promise<Omit<UserRow, 'passwordHash'>[]> {
  const r = await db.query<UserRow>(`select ${COLUMNS} from users where household_id = $1 order by created_at, id`, [householdId]);
  return r.rows.map(({ passwordHash: _omit, ...rest }) => rest);
}

export async function insertUser(
  db: Queryable,
  u: { householdId: string; email: string; displayName: string; role: Role; passwordHash: string },
): Promise<string> {
  const r = await db.query<{ id: string }>(
    `insert into users (household_id, email, display_name, role, password_hash)
     values ($1, $2, $3, $4, $5) returning id`,
    [u.householdId, u.email, u.displayName, u.role, u.passwordHash],
  );
  return r.rows[0]!.id;
}

export async function countActiveAdmins(db: Queryable, householdId: string): Promise<number> {
  const r = await db.query<{ n: string }>(
    `select count(*) as n from users where household_id = $1 and role = 'admin' and status = 'active'`, [householdId]);
  return Number(r.rows[0]!.n);
}

/** Optimistic update: returns false when the version no longer matches. */
export async function updateUserRoleStatus(
  db: Queryable, householdId: string, id: string, version: number, role: Role, status: 'active' | 'disabled',
): Promise<boolean> {
  const r = await db.query(
    `update users set role = $4, status = $5, version = version + 1, updated_at = now()
     where household_id = $1 and id = $2 and version = $3`,
    [householdId, id, version, role, status],
  );
  return r.rowCount === 1;
}

export async function updatePasswordHash(db: Queryable, id: string, passwordHash: string): Promise<void> {
  await db.query(`update users set password_hash = $2, version = version + 1, updated_at = now() where id = $1`, [id, passwordHash]);
}
