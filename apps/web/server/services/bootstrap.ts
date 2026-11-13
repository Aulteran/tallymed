import type { AppConfig } from '../config.ts';
import { AppError } from '../errors.ts';
import { log } from '../log.ts';
import { checkSetupToken, closeSetup } from '../setup-token.ts';
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
 * Creates the household and first administrator, then closes setup. Internal: the only caller that accepts a request is
 * `completeSetup`, which checks the setup token first. A second call fails with bootstrap_closed, enforced by an advisory
 * lock in the transaction and by the bootstrap_state primary key, so concurrent attempts produce exactly one household.
 */
export async function bootstrapAdmin(
  pool: Pool, input: unknown, opts: { requestId?: string; detail?: Record<string, string> } = {},
): Promise<{ householdId: string; adminUserId: string }> {
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
        requestId: opts.requestId, detail: opts.detail,
      });
      return { householdId, adminUserId };
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError('bootstrap_closed');
    throw error;
  }
}

/**
 * Web setup: the first administrator is created only by someone who presents the setup token. Order matters: a closed
 * installation answers not_found before anything else (no hint that a setup page ever existed), the cheap token check and
 * its attempt limit run before the password is hashed, and the token itself is never written anywhere.
 */
export async function completeSetup(
  pool: Pool, config: Pick<AppConfig, 'setupToken' | 'canonicalOrigin'>, input: unknown,
  ctx: { ip: string | null; requestId: string },
): Promise<{ householdId: string; adminUserId: string }> {
  if (await isBootstrapped(pool)) throw new AppError('not_found');
  const { setupToken, ...admin } = parse(schemas.setup, input);
  const { source } = checkSetupToken(config, setupToken, ctx.ip);
  const result = await bootstrapAdmin(pool, admin, { requestId: ctx.requestId, detail: { method: 'setup_token', tokenSource: source } });
  closeSetup();
  log('info', 'setup.completed', { requestId: ctx.requestId });
  return result;
}
