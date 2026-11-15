// Use cases for saved payment methods (the named cards and accounts a household pays with) and for recording which one paid a payment.
// A payment header is immutable, so "paid with" is an append-only history beside it; changing it never touches an amount, an allocation
// or a balance. Lock order: payments, bills, plans, then the payment method row last.
import { randomUUID } from 'node:crypto';
import { authorize, type Actor } from '../authz.ts';
import { isUniqueViolation, withTransaction, type Pool, type Queryable } from '../db.ts';
import { AppError } from '../errors.ts';
import { recordAudit } from '../repositories/audit.ts';
import * as repo from '../repositories/payment-methods.ts';
import * as payRepo from '../repositories/payments.ts';
import { paymentSchemas, parse, schemas } from '../validation.ts';
import { idempotent, withRetry } from './support.ts';

const NICKNAME_TAKEN = 'You already have an active payment method with that nickname';

export async function listPaymentMethods(pool: Pool, actor: Actor, o: { archived?: boolean } = {}) {
  authorize(actor, 'expenses:read');
  const [list, use] = await Promise.all([
    repo.listMethods(pool, actor.householdId, { archived: o.archived ?? false }),
    repo.methodUse(pool, payRepo.PAYMENT_FROM, actor.householdId),
  ]);
  const byId = new Map(use.map((u) => [u.methodId, u]));
  return {
    truncated: list.truncated,
    items: list.items.map((m) => ({ ...m, paymentCount: byId.get(m.id)?.paymentCount ?? 0, netCashCents: byId.get(m.id)?.netCashCents ?? '0' })),
    /** Payments with no method recorded. */
    unassigned: byId.get(null) ?? { methodId: null, paymentCount: 0, netCashCents: '0' },
  };
}

/** For a "paid with" select: active methods, plus the current choice even if it was archived since. */
export async function pickPaymentMethods(pool: Pool, actor: Actor, currentId?: string | null) {
  authorize(actor, 'expenses:read');
  return repo.listMethods(pool, actor.householdId, { archived: false, currentId: currentId && /^[0-9a-f-]{36}$/i.test(currentId) ? currentId : null });
}

export async function getPaymentMethod(pool: Pool, actor: Actor, id: string) {
  authorize(actor, 'expenses:read');
  const m = await repo.getMethod(pool, actor.householdId, parse(schemas.id, id));
  if (!m) throw new AppError('not_found');
  return m;
}

export async function createPaymentMethod(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string }> {
  authorize(actor, 'expenses:write');
  const d = parse(paymentSchemas.createPaymentMethod, input);
  try {
    return await withTransaction(pool, async (tx) => {
      const id = await repo.insertMethod(tx, { householdId: actor.householdId, userId: actor.userId, nickname: d.nickname, kind: d.kind, lastFour: d.lastFour });
      await recordAudit(tx, {
        householdId: actor.householdId, actorUserId: actor.userId, action: 'payment_method.created', entityType: 'payment_method', entityId: id, requestId,
        detail: { paymentMethodId: id, kind: d.kind, hasLastFour: d.lastFour !== null },
      });
      return { id };
    });
  } catch (e) {
    if (isUniqueViolation(e, 'payment_methods_active_nickname')) throw new AppError('conflict', NICKNAME_TAKEN);
    throw e;
  }
}

export async function updatePaymentMethod(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string }> {
  authorize(actor, 'expenses:write');
  const d = parse(paymentSchemas.updatePaymentMethod, input);
  try {
    return await withTransaction(pool, async (tx) => {
      const current = await repo.getMethod(tx, actor.householdId, d.id, 'update');
      if (!current) throw new AppError('not_found');
      if (current.version !== d.version) throw new AppError('stale_version');
      await repo.updateMethod(tx, actor.householdId, d.id, d.version, { nickname: d.nickname, kind: d.kind, lastFour: d.lastFour });
      await recordAudit(tx, {
        householdId: actor.householdId, actorUserId: actor.userId, action: 'payment_method.updated', entityType: 'payment_method', entityId: d.id, requestId,
        detail: { paymentMethodId: d.id, renamed: current.nickname !== d.nickname, kindChanged: current.kind !== d.kind, lastFourChanged: current.lastFour !== d.lastFour },
      });
      return { id: d.id };
    });
  } catch (e) {
    if (isUniqueViolation(e, 'payment_methods_active_nickname')) throw new AppError('conflict', NICKNAME_TAKEN);
    throw e;
  }
}

export async function archivePaymentMethod(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string }> {
  authorize(actor, 'expenses:write');
  const d = parse(paymentSchemas.archivePaymentMethod, input);
  try {
    return await withTransaction(pool, async (tx) => {
      const current = await repo.getMethod(tx, actor.householdId, d.id, 'update');
      if (!current) throw new AppError('not_found');
      if (current.version !== d.version) throw new AppError('stale_version');
      await repo.setMethodArchived(tx, actor.householdId, d.id, d.version, d.archived);
      await recordAudit(tx, {
        householdId: actor.householdId, actorUserId: actor.userId, action: `payment_method.${d.archived ? 'archived' : 'unarchived'}`, entityType: 'payment_method', entityId: d.id, requestId,
        detail: { paymentMethodId: d.id },
      });
      return { id: d.id };
    });
  } catch (e) {
    // Restoring a method whose nickname an active one has taken since.
    if (isUniqueViolation(e, 'payment_methods_active_nickname')) throw new AppError('conflict', 'Another active payment method uses that nickname. Rename one of them first.');
    throw e;
  }
}

/** Checks a method can take new payments. The caller's transaction takes a share lock, so an archive cannot slip in before commit. */
export async function requireActiveMethod(tx: Queryable, actor: Actor, methodId: string): Promise<void> {
  const m = await repo.getMethod(tx, actor.householdId, methodId, 'share');
  if (!m) throw new AppError('not_found');
  if (m.archivedAt) throw new AppError('conflict', 'That payment method is archived. Restore it or choose another.');
}

/**
 * Sets or clears which saved method paid an existing payment. Appends one history row and one audit event; nothing about the payment's
 * money changes. The payment is locked first (the global lock order), the method row last.
 */
export async function setPaidWith(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string; replayed: boolean }> {
  authorize(actor, 'expenses:write');
  const { csrf: _csrf, idempotencyKey, paymentId, paidWithId } = parse(paymentSchemas.setPaidWith, input);
  return withRetry(() => withTransaction(pool, async (tx) => {
    const replayId = await idempotent(tx, actor, 'payment.set_paid_with', idempotencyKey, { paymentId, paidWithId }, paymentId);
    if (replayId) return { id: replayId, replayed: true };
    const locked = await payRepo.lockPayments(tx, actor.householdId, [paymentId]);
    if (locked.length === 0) throw new AppError('not_found');
    const payment = await payRepo.getPayment(tx, actor.householdId, paymentId);
    if (!payment) throw new AppError('not_found');
    if (payment.voided) throw new AppError('conflict', 'A voided payment cannot be changed');
    const before = await repo.currentMethodId(tx, actor.householdId, paymentId);
    if (before === paidWithId) return { id: paymentId, replayed: false };
    if (paidWithId) await requireActiveMethod(tx, actor, paidWithId);
    await repo.insertAssignment(tx, { id: randomUUID(), householdId: actor.householdId, userId: actor.userId, paymentId, methodId: paidWithId });
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'payment.paid_with_changed', entityType: 'payment', entityId: paymentId, requestId,
      detail: { paymentId, fromPaymentMethodId: before, toPaymentMethodId: paidWithId },
    });
    return { id: paymentId, replayed: false };
  }));
}
