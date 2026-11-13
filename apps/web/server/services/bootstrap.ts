import { AppError } from '../errors.ts';
import { isUniqueViolation, withTransaction, type Pool } from '../db.ts';
import { hashPassword } from '../passwords.ts';
import { recordAudit } from '../repositories/audit.ts';
import { insertUser } from '../repositories/users.ts';
import { parse, schemas } from '../validation.ts';

const BOOTSTRAP_LOCK = 7_203_402;

export async function isBootstrapped(pool: Pool): Promise<boolean> {
  const r = await pool.query('select 1 from bootstrap_state');
  return r.rowCount === 1;
}

/**
 * One-time local setup: creates the household and first administrator, then closes bootstrap.
 * Invoked only by the local CLI. A second call fails with bootstrap_closed, enforced both by this
 * check and by the bootstrap_state primary key.
 */
export async function bootstrapAdmin(pool: Pool, input: unknown): Promise<{ householdId: string; adminUserId: string }> {
  const data = parse(schemas.bootstrap, input);
  const passwordHash = await hashPassword(data.password);
  try {
    return await withTransaction(pool, async (tx) => {
      await tx.query('select pg_advisory_xact_lock($1)', [BOOTSTRAP_LOCK]);
      if ((await tx.query('select 1 from bootstrap_state')).rowCount) throw new AppError('bootstrap_closed');
      const h = await tx.query<{ id: string }>('insert into households (name) values ($1) returning id', [data.householdName]);
      const householdId = h.rows[0]!.id;
      const adminUserId = await insertUser(tx, {
        householdId, email: data.email, displayName: data.displayName, role: 'admin', passwordHash,
      });
      await tx.query('insert into bootstrap_state (household_id, admin_user_id) values ($1, $2)', [householdId, adminUserId]);
      await recordAudit(tx, {
        householdId, actorUserId: adminUserId, action: 'bootstrap.completed', entityType: 'household', entityId: householdId,
      });
      return { householdId, adminUserId };
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError('bootstrap_closed');
    throw error;
  }
}
