// Use cases for HSA accounts. An HSA account is a label (name, administrator, last four digits); nothing here moves money. A payment is
// paid directly from an HSA only by recording it with an HSA card (see services/payments.ts), never afterwards.
// Lock order: payments, bills, plans, payment method, then the HSA account last.
import { authorize, type Actor } from '../authz.ts';
import { isUniqueViolation, withTransaction, type Pool, type Queryable } from '../db.ts';
import { AppError } from '../errors.ts';
import { recordAudit } from '../repositories/audit.ts';
import * as repo from '../repositories/hsa-accounts.ts';
import * as payRepo from '../repositories/payments.ts';
import { paymentSchemas, parse, schemas } from '../validation.ts';
import { insertMethodWithLink, PAYMENT_METHOD_NICKNAME_TAKEN } from './payment-methods.ts';
export { requireActiveAccount } from './hsa-account-guard.ts';

const NAME_TAKEN = 'You already have an active HSA account with that name';

export async function listHsaAccounts(pool: Pool, actor: Actor, o: { archived?: boolean } = {}) {
  authorize(actor, 'expenses:read');
  const [list, use] = await Promise.all([
    repo.listAccounts(pool, actor.householdId, { archived: true }),
    repo.accountUse(pool, payRepo.PAYMENT_FROM, actor.householdId),
  ]);
  const byId = new Map(use.map((u) => [u.accountId, u]));
  // An archived account stays listed while payments were paid directly from it, so the figures stay visible.
  const shown = list.items.filter((a) => !a.archivedAt || o.archived || (byId.get(a.id)?.paymentCount ?? 0) > 0);
  return { truncated: list.truncated, items: shown.map((a) => ({ ...a, paymentCount: byId.get(a.id)?.paymentCount ?? 0, netCashCents: byId.get(a.id)?.netCashCents ?? '0' })) };
}

/** For a select: active accounts, plus the current choice even if it was archived since. */
export async function pickHsaAccounts(pool: Pool, actor: Actor, currentId?: string | null) {
  authorize(actor, 'expenses:read');
  const current = schemas.id.safeParse(currentId);
  return repo.listAccounts(pool, actor.householdId, { archived: false, currentId: current.success ? current.data : null });
}

export async function getHsaAccount(pool: Pool, actor: Actor, id: string) {
  authorize(actor, 'expenses:read');
  const a = await repo.getAccount(pool, actor.householdId, parse(schemas.id, id));
  if (!a) throw new AppError('not_found');
  return a;
}

/**
 * Creates an HSA account and, when the household says it also has a spending card, saves that card as an HSA/FSA payment method linked to
 * the account. One transaction: a card that cannot be saved (for example a nickname already in use) leaves no account behind either.
 */
export async function createHsaAccount(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string; paymentMethodId: string | null }> {
  authorize(actor, 'expenses:write');
  const d = parse(paymentSchemas.createHsaAccount, input);
  try {
    return await withTransaction(pool, async (tx) => {
      const id = await repo.insertAccount(tx, { householdId: actor.householdId, userId: actor.userId, name: d.name, administrator: d.administrator, lastFour: d.lastFour });
      await recordAudit(tx, {
        householdId: actor.householdId, actorUserId: actor.userId, action: 'hsa_account.created', entityType: 'hsa_account', entityId: id, requestId,
        detail: { hsaAccountId: id, hasLastFour: d.lastFour !== null, hasAdministrator: d.administrator !== '', withSpendingCard: d.card !== null },
      });
      const paymentMethodId = d.card ? await insertMethodWithLink(tx, actor, { ...d.card, hsaAccountId: id }, requestId) : null;
      return { id, paymentMethodId };
    });
  } catch (e) {
    if (isUniqueViolation(e, 'hsa_accounts_active_name')) throw new AppError('conflict', NAME_TAKEN);
    if (isUniqueViolation(e, 'payment_methods_active_nickname')) throw new AppError('conflict', PAYMENT_METHOD_NICKNAME_TAKEN);
    throw e;
  }
}

export async function updateHsaAccount(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string }> {
  authorize(actor, 'expenses:write');
  const d = parse(paymentSchemas.updateHsaAccount, input);
  try {
    return await withTransaction(pool, async (tx) => {
      const current = await repo.getAccount(tx, actor.householdId, d.id, 'update');
      if (!current) throw new AppError('not_found');
      if (current.version !== d.version) throw new AppError('stale_version');
      await repo.updateAccount(tx, actor.householdId, d.id, d.version, { name: d.name, administrator: d.administrator, lastFour: d.lastFour });
      await recordAudit(tx, {
        householdId: actor.householdId, actorUserId: actor.userId, action: 'hsa_account.updated', entityType: 'hsa_account', entityId: d.id, requestId,
        detail: { hsaAccountId: d.id, renamed: current.name !== d.name, administratorChanged: current.administrator !== d.administrator, lastFourChanged: current.lastFour !== d.lastFour },
      });
      return { id: d.id };
    });
  } catch (e) {
    if (isUniqueViolation(e, 'hsa_accounts_active_name')) throw new AppError('conflict', NAME_TAKEN);
    throw e;
  }
}

export async function archiveHsaAccount(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string }> {
  authorize(actor, 'expenses:write');
  const d = parse(paymentSchemas.archiveHsaAccount, input);
  try {
    return await withTransaction(pool, async (tx) => {
      const current = await repo.getAccount(tx, actor.householdId, d.id, 'update');
      if (!current) throw new AppError('not_found');
      if (current.version !== d.version) throw new AppError('stale_version');
      await repo.setAccountArchived(tx, actor.householdId, d.id, d.version, d.archived);
      await recordAudit(tx, {
        householdId: actor.householdId, actorUserId: actor.userId, action: `hsa_account.${d.archived ? 'archived' : 'unarchived'}`, entityType: 'hsa_account', entityId: d.id, requestId,
        detail: { hsaAccountId: d.id },
      });
      return { id: d.id };
    });
  } catch (e) {
    if (isUniqueViolation(e, 'hsa_accounts_active_name')) throw new AppError('conflict', 'Another active HSA account uses that name. Rename one of them first.');
    throw e;
  }
}
