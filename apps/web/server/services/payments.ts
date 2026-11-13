// Use cases for payments, allocations, refunds and reversals. Every mutation authorizes, validates, locks, writes and audits
// in one transaction. Lock order is always: payments (ascending id), then bills (ascending id), then plans (ascending id).
// Money is bigint cents and every amount comes from posted rows read after the locks are held.
import { randomUUID } from 'node:crypto';
import { authorize, type Actor } from '../authz.ts';
import { withTransaction, type Pool, type Queryable } from '../db.ts';
import { AppError } from '../errors.ts';
import { recordAudit } from '../repositories/audit.ts';
import * as expenseRepo from '../repositories/expenses.ts';
import * as repo from '../repositories/payments.ts';
import * as plans from '../repositories/plans.ts';
import { paymentFilterSchemas, parse, paymentSchemas, schemas } from '../validation.ts';
import { idempotent, withRetry, type Detail } from './support.ts';

const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
const cents = (v: bigint) => v.toString();

// ---------- reads ----------

export async function listPayments(pool: Pool, actor: Actor, raw: unknown) {
  authorize(actor, 'expenses:read');
  return repo.listPayments(pool, actor.householdId, parse(paymentFilterSchemas.payment, raw));
}

export async function cashSummary(pool: Pool, actor: Actor) {
  authorize(actor, 'expenses:read');
  return repo.cashTotals(pool, actor.householdId);
}

export async function getPaymentDetail(pool: Pool, actor: Actor, id: string) {
  authorize(actor, 'expenses:read');
  const paymentId = parse(schemas.id, id);
  const payment = await repo.getPayment(pool, actor.householdId, paymentId);
  if (!payment) throw new AppError('not_found');
  const [entries, allocations, history] = await Promise.all([
    repo.listEntries(pool, actor.householdId, paymentId),
    repo.listAllocationsOfPayment(pool, actor.householdId, paymentId),
    repo.paymentHistory(pool, actor.householdId, paymentId),
  ]);
  // Refund events: entries sharing an event id. A refund is reversed when every refund entry of the event has a reversal.
  const reversedIds = new Set(entries.filter((e) => e.kind === 'refund_reversal').map((e) => e.reversesEntryId));
  const events = new Map<string, { eventId: string; effectiveDate: string; totalCents: bigint; reversed: boolean }>();
  for (const e of entries) {
    if (e.kind !== 'refund' && e.kind !== 'unapplied_refund') continue;
    const ev = events.get(e.eventId) ?? { eventId: e.eventId, effectiveDate: e.effectiveDate, totalCents: 0n, reversed: true };
    ev.totalCents += -BigInt(e.amountCents);
    ev.reversed &&= reversedIds.has(e.id);
    events.set(e.eventId, ev);
  }
  const refunds = [...events.values()].map((e) => ({ ...e, totalCents: e.totalCents.toString() }));
  return { payment, entries, allocations, refunds, history };
}

/** Bills that can still take cash, for allocation selects: at most `limit`, plus the current choice. */
export async function pickPayableBills(pool: Pool, actor: Actor, o: { q?: string; currentId?: string | null }) {
  authorize(actor, 'expenses:read');
  const limit = 100;
  const current = o.currentId && schemas.id.safeParse(o.currentId).success ? o.currentId : null;
  const rows = await repo.listPayableBills(pool, actor.householdId, { q: o.q, currentId: current, limit: limit + 1 });
  return { items: rows.slice(0, limit), truncated: rows.length > limit };
}

/** Payment ledger and plan membership for one bill, shown on the bill page. */
export async function billPaymentSummary(pool: Pool, actor: Actor, billId: string) {
  authorize(actor, 'expenses:read');
  const id = parse(schemas.id, billId);
  const ledger = await repo.listBillLedger(pool, actor.householdId, id);
  const { rows: planRows } = await pool.query<{ id: string; name: string; status: string }>(
    `select p.id, p.name, p.status from payment_plan_bills pb join payment_plans p on p.household_id = pb.household_id and p.id = pb.plan_id
     where pb.household_id = $1 and pb.bill_id = $2 order by p.created_at desc, p.id`, [actor.householdId, id]);
  return { ledger, plans: planRows };
}

// ---------- shared write steps ----------

interface AllocationRequest { billId: string; amount: bigint }

/**
 * Applies cash to bills inside the caller's transaction. Locks the bills (ascending id) before reading balances, requires
 * confirmed amounts, never lets an allocation exceed the bill's open balance, and audits balance before and after.
 */
async function applyAllocations(tx: Queryable, actor: Actor, paymentId: string, eventId: string, requests: AllocationRequest[], effectiveDate: string, requestId: string): Promise<bigint[]> {
  if (requests.length === 0) return [];
  if (new Set(requests.map((r) => r.billId)).size !== requests.length) throw new AppError('invalid_input', 'List each bill once');
  const locks = await expenseRepo.lockBills(tx, actor.householdId, requests.map((r) => r.billId));
  const byId = new Map(locks.map((l) => [l.id, l]));
  const ids: bigint[] = [];
  for (const r of [...requests].sort((a, b) => (a.billId < b.billId ? -1 : 1))) {
    const bill = byId.get(r.billId);
    if (!bill) throw new AppError('not_found');
    if (bill.amountStatus !== 'confirmed') throw new AppError('conflict', 'Payments can only be applied to bills with confirmed amounts');
    const before = bill.baseResponsibilityCents + bill.adjustmentsCents - bill.appliedCents;
    if (r.amount > before) throw new AppError('conflict', 'That amount is more than the bill\'s open balance. Leave the extra cash unapplied or record the credit separately.');
    const entryId = randomUUID();
    await repo.insertEntry(tx, {
      id: entryId, householdId: actor.householdId, userId: actor.userId, paymentId, eventId, kind: 'allocation', billId: r.billId, allocationId: entryId,
      amountCents: r.amount, effectiveDate, reason: '',
    });
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'payment.allocated', entityType: 'payment_allocation', entityId: entryId, requestId,
      detail: { paymentId, billId: r.billId, eventId, amountCents: cents(r.amount), balanceBeforeCents: cents(before), balanceAfterCents: cents(before - r.amount) },
    });
    ids.push(r.amount);
  }
  return ids;
}

/**
 * After an allocation shrinks (reversal or refund), plan matches may no longer be backed by cash. Release the excess in the
 * same transaction, latest due date first, so a match never counts cash the household no longer holds. The caller holds the
 * payment lock; the plans lock after it (payments, then bills, then plans).
 */
async function releaseMatchesToFit(tx: Queryable, actor: Actor, allocationId: string, remaining: bigint, requestId: string): Promise<void> {
  const planIds = await plans.plansMatchingAllocation(tx, actor.householdId, allocationId);
  if (planIds.length === 0) return;
  await plans.lockPlans(tx, actor.householdId, planIds);
  const matches = await plans.currentMatchesOfAllocation(tx, actor.householdId, allocationId);
  const total = sum(matches.map((m) => m.cents));
  let excess = total - remaining;
  if (excess <= 0n) return;
  for (const m of matches) {
    if (excess <= 0n) break;
    const take = m.cents < excess ? m.cents : excess;
    await plans.insertMatch(tx, {
      id: randomUUID(), householdId: actor.householdId, userId: actor.userId, planId: m.planId, revisionId: m.revisionId, installmentId: m.installmentId,
      paymentId: m.paymentId, allocationId, billId: m.billId, kind: 'unmatch', amountCents: -take, carried: false, reason: 'Released because the allocation was reduced',
    });
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'plan.match_released', entityType: 'payment_plan', entityId: m.planId, requestId,
      detail: { planId: m.planId, installmentId: m.installmentId, allocationId, amountCents: cents(take), matchedBeforeCents: cents(m.cents), matchedAfterCents: cents(m.cents - take) },
    });
    excess -= take;
  }
}

async function lockedPayment(tx: Queryable, actor: Actor, paymentId: string): Promise<repo.Payment> {
  const locked = await repo.lockPayments(tx, actor.householdId, [paymentId]);
  if (locked.length === 0) throw new AppError('not_found');
  const p = await repo.getPayment(tx, actor.householdId, paymentId);
  if (!p) throw new AppError('not_found');
  return p;
}

// ---------- payments ----------

/**
 * Records one actual payment, optionally applying it to bills in the same transaction. Posted rows are immutable; the
 * payment, its allocations and the audit trail commit together or not at all. One idempotency key is one payment.
 */
export async function recordPayment(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string; replayed: boolean }> {
  authorize(actor, 'expenses:write');
  const { csrf: _csrf, idempotencyKey, allocations, ...fields } = parse(paymentSchemas.createPayment, input);
  if (sum(allocations.map((a) => a.amount)) > fields.amount) throw new AppError('invalid_input', 'The allocations are more than the payment amount');
  const id = randomUUID();
  return withRetry(() => withTransaction(pool, async (tx) => {
    const replayId = await idempotent(tx, actor, 'payment.create', idempotencyKey, { ...fields, allocations }, id);
    if (replayId) return { id: replayId, replayed: true };
    await repo.insertPayment(tx, { id, householdId: actor.householdId, userId: actor.userId, paidOn: fields.paidOn, amountCents: fields.amount, method: fields.method, reference: fields.reference, note: fields.note });
    const applied = sum(await applyAllocations(tx, actor, id, randomUUID(), allocations, fields.paidOn, requestId));
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'payment.recorded', entityType: 'payment', entityId: id, requestId,
      detail: { paymentId: id, amountCents: cents(fields.amount), method: fields.method, paidOn: fields.paidOn, allocatedCents: cents(applied), unappliedCents: cents(fields.amount - applied), billCount: allocations.length },
    });
    return { id, replayed: false };
  }));
}

/** Applies a payment's unapplied cash to more bills. Cannot apply more than the payment still holds. */
export async function allocatePayment(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string; replayed: boolean }> {
  authorize(actor, 'expenses:write');
  const { csrf: _csrf, idempotencyKey, paymentId, allocations } = parse(paymentSchemas.allocatePayment, input);
  return withRetry(() => withTransaction(pool, async (tx) => {
    const replayId = await idempotent(tx, actor, 'payment.allocate', idempotencyKey, { paymentId, allocations }, paymentId);
    if (replayId) return { id: replayId, replayed: true };
    const payment = await lockedPayment(tx, actor, paymentId);
    if (payment.voided) throw new AppError('conflict', 'That payment was voided');
    const total = sum(allocations.map((a) => a.amount));
    const unapplied = BigInt(payment.unappliedCents);
    if (total > unapplied) throw new AppError('conflict', 'That is more than the unapplied cash left on this payment');
    await applyAllocations(tx, actor, paymentId, randomUUID(), allocations, payment.paidOn, requestId);
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'payment.applied', entityType: 'payment', entityId: paymentId, requestId,
      detail: { paymentId, amountCents: cents(total), unappliedBeforeCents: cents(unapplied), unappliedAfterCents: cents(unapplied - total), billCount: allocations.length },
    });
    return { id: paymentId, replayed: false };
  }));
}

/** Returns applied cash to the payment's unapplied balance (a correction, not a cash event). Posts a linked reversal entry. */
export async function reverseAllocation(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string; replayed: boolean }> {
  authorize(actor, 'expenses:write');
  const { csrf: _csrf, paymentId: _redirect, idempotencyKey, ...d } = parse(paymentSchemas.reverseAllocation, input);
  const id = randomUUID();
  return withRetry(() => withTransaction(pool, async (tx) => {
    const replayId = await idempotent(tx, actor, 'payment.unapply', idempotencyKey, d, id);
    if (replayId) return { id: replayId, replayed: true };
    const found = await repo.getAllocation(tx, actor.householdId, d.allocationId);
    if (!found) throw new AppError('not_found');
    const payment = await lockedPayment(tx, actor, found.paymentId);
    await expenseRepo.lockBills(tx, actor.householdId, [found.billId]);
    const alloc = await repo.getAllocation(tx, actor.householdId, d.allocationId);
    if (!alloc) throw new AppError('not_found');
    const remaining = BigInt(alloc.netCents);
    const amount = d.amount ?? remaining;
    if (amount <= 0n || amount > remaining) throw new AppError('conflict', 'That is more than the allocation still holds');
    const bill = await expenseRepo.getBill(tx, actor.householdId, alloc.billId);
    await repo.insertEntry(tx, {
      id, householdId: actor.householdId, userId: actor.userId, paymentId: payment.id, eventId: randomUUID(), kind: 'allocation_reversal', billId: alloc.billId,
      allocationId: alloc.allocationId, amountCents: -amount, effectiveDate: d.effectiveDate, reason: d.reason,
    });
    await releaseMatchesToFit(tx, actor, alloc.allocationId, remaining - amount, requestId);
    const unapplied = BigInt(payment.unappliedCents);
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'payment.allocation_reversed', entityType: 'payment_allocation', entityId: alloc.allocationId, requestId,
      detail: {
        paymentId: payment.id, billId: alloc.billId, amountCents: cents(amount), allocationBeforeCents: cents(remaining), allocationAfterCents: cents(remaining - amount),
        billBalanceBeforeCents: bill!.openBalanceCents, billBalanceAfterCents: cents(BigInt(bill!.openBalanceCents) + amount),
        unappliedBeforeCents: cents(unapplied), unappliedAfterCents: cents(unapplied + amount),
      },
    });
    return { id, replayed: false };
  }));
}

/**
 * Records cash the provider returned. Refund lines reduce specific allocations (the bill balance goes back up); an unapplied
 * part reduces the payment's unapplied cash. Nothing is inferred from a lower statement total. The result id is the refund event.
 */
export async function recordRefund(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string; replayed: boolean }> {
  authorize(actor, 'expenses:write');
  const { csrf: _csrf, idempotencyKey, ...d } = parse(paymentSchemas.recordRefund, input);
  if (new Set(d.lines.map((l) => l.allocationId)).size !== d.lines.length) throw new AppError('invalid_input', 'List each allocation once');
  const eventId = randomUUID();
  return withRetry(() => withTransaction(pool, async (tx) => {
    const replayId = await idempotent(tx, actor, 'payment.refund', idempotencyKey, d, eventId);
    if (replayId) return { id: replayId, replayed: true };
    const payment = await lockedPayment(tx, actor, d.paymentId);
    if (payment.voided) throw new AppError('conflict', 'That payment was voided');
    const allocations = await repo.listAllocationsOfPayment(tx, actor.householdId, d.paymentId);
    const byId = new Map(allocations.map((a) => [a.allocationId, a]));
    const billIds = d.lines.map((l) => byId.get(l.allocationId)?.billId ?? '');
    if (billIds.some((b) => b === '')) throw new AppError('not_found');
    const locks = await expenseRepo.lockBills(tx, actor.householdId, billIds);
    // Running open balance per bill, so several lines on one bill each audit the true before and after.
    const balance = new Map(locks.map((l) => [l.id, l.baseResponsibilityCents + l.adjustmentsCents - l.appliedCents]));
    // Re-read allocation figures now that the payment and bills are locked.
    const fresh = new Map((await repo.listAllocationsOfPayment(tx, actor.householdId, d.paymentId)).map((a) => [a.allocationId, a]));
    const unappliedBefore = BigInt(payment.unappliedCents);
    const unappliedPart = d.unappliedCents ?? 0n;
    if (unappliedPart > unappliedBefore) throw new AppError('conflict', 'That is more than the unapplied cash left on this payment');
    let total = unappliedPart;
    for (const line of [...d.lines].sort((a, b) => (a.allocationId < b.allocationId ? -1 : 1))) {
      const alloc = fresh.get(line.allocationId)!;
      const remaining = BigInt(alloc.netCents);
      if (line.amount > remaining) throw new AppError('conflict', 'That refund is more than the allocation still holds');
      const entryId = randomUUID();
      await repo.insertEntry(tx, {
        id: entryId, householdId: actor.householdId, userId: actor.userId, paymentId: payment.id, eventId, kind: 'refund', billId: alloc.billId,
        allocationId: alloc.allocationId, amountCents: -line.amount, effectiveDate: d.effectiveDate, reason: d.reason,
      });
      await releaseMatchesToFit(tx, actor, alloc.allocationId, remaining - line.amount, requestId);
      const balanceBefore = balance.get(alloc.billId)!;
      balance.set(alloc.billId, balanceBefore + line.amount);
      await recordAudit(tx, {
        householdId: actor.householdId, actorUserId: actor.userId, action: 'payment.allocation_refunded', entityType: 'payment_allocation', entityId: alloc.allocationId, requestId,
        detail: {
          paymentId: payment.id, billId: alloc.billId, eventId, amountCents: cents(line.amount), allocationBeforeCents: cents(remaining), allocationAfterCents: cents(remaining - line.amount),
          billBalanceBeforeCents: cents(balanceBefore), billBalanceAfterCents: cents(balanceBefore + line.amount),
        },
      });
      total += line.amount;
    }
    if (unappliedPart > 0n) {
      await repo.insertEntry(tx, {
        id: randomUUID(), householdId: actor.householdId, userId: actor.userId, paymentId: payment.id, eventId, kind: 'unapplied_refund', billId: null, allocationId: null,
        amountCents: -unappliedPart, effectiveDate: d.effectiveDate, reason: d.reason,
      });
    }
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'payment.refunded', entityType: 'payment', entityId: payment.id, requestId,
      detail: {
        paymentId: payment.id, eventId, amountCents: cents(total), fromAllocationsCents: cents(total - unappliedPart), fromUnappliedCents: cents(unappliedPart),
        netCashBeforeCents: payment.netCashCents, netCashAfterCents: cents(BigInt(payment.netCashCents) - total),
        unappliedBeforeCents: cents(unappliedBefore), unappliedAfterCents: cents(unappliedBefore - unappliedPart),
      },
    });
    return { id: eventId, replayed: false };
  }));
}

/** Corrects a refund recorded in error with linked, opposite entries. The refund stays in the history. */
export async function reverseRefund(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string; replayed: boolean }> {
  authorize(actor, 'expenses:write');
  const { csrf: _csrf, paymentId: _redirect, idempotencyKey, ...d } = parse(paymentSchemas.reverseRefund, input);
  const newEventId = randomUUID();
  return withRetry(() => withTransaction(pool, async (tx) => {
    const replayId = await idempotent(tx, actor, 'payment.refund_reverse', idempotencyKey, d, newEventId);
    if (replayId) return { id: replayId, replayed: true };
    const probe = await repo.listRefundEvent(tx, actor.householdId, d.eventId);
    if (probe.length === 0) throw new AppError('not_found');
    const payment = await lockedPayment(tx, actor, probe[0]!.paymentId);
    if (payment.voided) throw new AppError('conflict', 'That payment was voided');
    const entries = await repo.listRefundEvent(tx, actor.householdId, d.eventId);
    if (entries.some((e) => e.reversed)) throw new AppError('conflict', 'That refund was already reversed');
    const billIds = entries.flatMap((e) => (e.billId ? [e.billId] : []));
    const locks = billIds.length ? await expenseRepo.lockBills(tx, actor.householdId, billIds) : [];
    const balance = new Map(locks.map((l) => [l.id, l.baseResponsibilityCents + l.adjustmentsCents - l.appliedCents]));
    const unappliedBefore = BigInt(payment.unappliedCents);
    const unappliedEntries = sum(entries.filter((e) => e.kind === 'unapplied_refund').map((e) => -e.amountCents));
    if (unappliedEntries > unappliedBefore) throw new AppError('conflict', 'That refund cannot be reversed because the cash it returned was applied since. Reverse that allocation first.');
    let total = 0n;
    for (const e of entries) {
      const amount = -e.amountCents;
      await repo.insertEntry(tx, {
        id: randomUUID(), householdId: actor.householdId, userId: actor.userId, paymentId: payment.id, eventId: newEventId, kind: 'refund_reversal', billId: e.billId,
        allocationId: e.allocationId, reversesEntryId: e.id, amountCents: amount, effectiveDate: d.effectiveDate, reason: d.reason,
      });
      total += amount;
      if (e.billId) {
        const before = balance.get(e.billId)!;
        balance.set(e.billId, before - amount);
        await recordAudit(tx, {
          householdId: actor.householdId, actorUserId: actor.userId, action: 'payment.allocation_refund_reversed', entityType: 'payment_allocation', entityId: e.allocationId, requestId,
          detail: { paymentId: payment.id, billId: e.billId, eventId: d.eventId, amountCents: cents(amount), billBalanceBeforeCents: cents(before), billBalanceAfterCents: cents(before - amount) },
        });
      }
    }
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'payment.refund_reversed', entityType: 'payment', entityId: payment.id, requestId,
      detail: { paymentId: payment.id, eventId: d.eventId, amountCents: cents(total), netCashBeforeCents: payment.netCashCents, netCashAfterCents: cents(BigInt(payment.netCashCents) + total) },
    });
    return { id: newEventId, replayed: false };
  }));
}

/** Marks a payment as recorded in error. Allowed only when nothing is applied or refunded, so no balance moves. */
export async function voidPayment(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string; replayed: boolean }> {
  authorize(actor, 'expenses:write');
  const { csrf: _csrf, idempotencyKey, ...d } = parse(paymentSchemas.voidPayment, input);
  return withRetry(() => withTransaction(pool, async (tx) => {
    const replayId = await idempotent(tx, actor, 'payment.void', idempotencyKey, d, d.paymentId);
    if (replayId) return { id: replayId, replayed: true };
    const payment = await lockedPayment(tx, actor, d.paymentId);
    if (payment.voided) throw new AppError('conflict', 'That payment was already voided');
    if (BigInt(payment.appliedCents) !== 0n || BigInt(payment.refundedCents) !== 0n) {
      throw new AppError('conflict', 'Reverse the payment\'s allocations and refunds before voiding it');
    }
    await repo.insertVoid(tx, { householdId: actor.householdId, userId: actor.userId, paymentId: d.paymentId, reason: d.reason, voidedOn: d.voidedOn });
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'payment.voided', entityType: 'payment', entityId: d.paymentId, requestId,
      detail: { paymentId: d.paymentId, amountCents: payment.amountCents, voidedOn: d.voidedOn },
    });
    return { id: d.paymentId, replayed: false };
  }));
}

export type { Detail };
