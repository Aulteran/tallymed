// Use cases for payment plans: schedule creation and revision, partial installment matching and the upcoming/overdue views.
// A plan match references an existing payment allocation. It never creates, moves or double counts cash. Lock order is
// payments, then bills, then plans (see services/payments.ts).
import { randomUUID } from 'node:crypto';
import { authorize, type Actor } from '../authz.ts';
import { withTransaction, type Pool, type Queryable } from '../db.ts';
import { AppError } from '../errors.ts';
import { MAX_CENTS } from '../money.ts';
import { recordAudit } from '../repositories/audit.ts';
import * as expenseRepo from '../repositories/expenses.ts';
import * as payments from '../repositories/payments.ts';
import * as repo from '../repositories/plans.ts';
import { paymentFilterSchemas, parse, paymentSchemas, schemas } from '../validation.ts';
import { requireActive } from './expenses.ts';
import { idempotent, todayUtc, withRetry } from './support.ts';

const cents = (v: bigint) => v.toString();
const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

// ---------- schedule building (pure) ----------

export interface ScheduleLine { dueDate: string; amountCents: bigint }
export interface Schedule { cadence: 'weekly' | 'biweekly' | 'monthly' | 'custom'; lines: ScheduleLine[]; totalCents: bigint }

function parts(date: string): [number, number, number] {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return [y, m, d];
}
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Due date of installment `index` (0-based). Monthly dates keep the first day of month, clamped to the month's last day. */
export function dueDateAt(first: string, cadence: 'weekly' | 'biweekly' | 'monthly', index: number): string {
  const [y, m, d] = parts(first);
  if (cadence === 'monthly') {
    const total = (m - 1) + index;
    const year = y + Math.floor(total / 12);
    const month = total % 12;
    const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return iso(Date.UTC(year, month, Math.min(d, last)));
  }
  return iso(Date.UTC(y, m - 1, d) + index * (cadence === 'weekly' ? 7 : 14) * 86_400_000);
}

/**
 * Builds a schedule from either an explicit installment list (custom cadence) or a total, a count, a first due date and a
 * cadence. Generated totals split exactly: the first (total mod count) installments carry one extra cent. No floats.
 */
export function buildSchedule(d: {
  cadence: 'weekly' | 'biweekly' | 'monthly' | 'custom'; totalAmount: bigint | null; installmentCount: number | null; firstDueDate: string | null;
  installments?: Array<{ dueDate: string; amount: bigint }>;
}): Schedule {
  if (d.installments && d.installments.length > 0) {
    if (d.totalAmount !== null || d.installmentCount !== null || d.firstDueDate !== null) throw new AppError('invalid_input', 'Give either a generated schedule or a list of installments');
    const lines = d.installments.map((i, n) => ({ ...i, n })).sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.n - b.n))
      .map((i) => ({ dueDate: i.dueDate, amountCents: i.amount }));
    const totalCents = sum(lines.map((l) => l.amountCents));
    if (totalCents > MAX_CENTS) throw new AppError('invalid_input', 'Amount out of range');
    return { cadence: 'custom', lines, totalCents };
  }
  if (d.cadence === 'custom' || d.totalAmount === null || d.installmentCount === null || d.firstDueDate === null) {
    throw new AppError('invalid_input', 'Give a total, a number of installments, a first due date and a cadence');
  }
  const n = BigInt(d.installmentCount);
  if (d.totalAmount < n) throw new AppError('invalid_input', 'Each installment must be at least one cent');
  const base = d.totalAmount / n;
  const extra = Number(d.totalAmount % n);
  const lines = Array.from({ length: d.installmentCount }, (_, i) => ({
    dueDate: dueDateAt(d.firstDueDate!, d.cadence as 'weekly' | 'biweekly' | 'monthly', i), amountCents: base + (i < extra ? 1n : 0n),
  }));
  if (lines[lines.length - 1]!.dueDate > '2100-01-01') throw new AppError('invalid_input', 'Due date out of range');
  return { cadence: d.cadence, lines, totalCents: d.totalAmount };
}

// ---------- reads ----------

const asOfDate = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : todayUtc());

export async function listPlans(pool: Pool, actor: Actor, raw: unknown, asOf?: string) {
  authorize(actor, 'expenses:read');
  return repo.listPlans(pool, actor.householdId, parse(paymentFilterSchemas.plan, raw), asOfDate(asOf));
}

export async function listInstallmentQueue(pool: Pool, actor: Actor, raw: unknown) {
  authorize(actor, 'expenses:read');
  const f = parse(paymentFilterSchemas.installments, raw);
  return repo.installmentQueue(pool, actor.householdId, f, asOfDate(f.asOf));
}

export async function installmentSummary(pool: Pool, actor: Actor, asOf?: string) {
  authorize(actor, 'expenses:read');
  return repo.installmentTotals(pool, actor.householdId, asOfDate(asOf));
}

/** How many matchable allocations a plan page lists before it is marked as truncated. */
export const MATCH_PICK_LIMIT = 100;

export async function getPlanDetail(pool: Pool, actor: Actor, id: string, o: { asOf?: string; allocationId?: string | null } = {}) {
  authorize(actor, 'expenses:read');
  const planId = parse(schemas.id, id);
  const asOf = asOfDate(o.asOf);
  const plan = await repo.getPlan(pool, actor.householdId, planId, asOf);
  if (!plan) throw new AppError('not_found');
  const billIds = await repo.planBillIds(pool, actor.householdId, planId);
  const current = o.allocationId && schemas.id.safeParse(o.allocationId).success ? o.allocationId : null;
  const [bills, revisions, installments, matches, history, allocations] = await Promise.all([
    expenseRepo.getBills(pool, actor.householdId, billIds),
    repo.listRevisions(pool, actor.householdId, planId),
    repo.listInstallments(pool, actor.householdId, plan.revisionId, asOf),
    repo.listMatches(pool, actor.householdId, planId),
    repo.planHistory(pool, actor.householdId, planId),
    payments.listMatchableAllocations(pool, actor.householdId, billIds, current, MATCH_PICK_LIMIT + 1),
  ]);
  return { plan, bills, revisions, installments, matches, history, allocations: allocations.slice(0, MATCH_PICK_LIMIT), allocationsTruncated: allocations.length > MATCH_PICK_LIMIT, asOf };
}

// ---------- writes ----------

/** Locks the payments that back a plan's matches, then the plan itself (payments before plans), re-checking for new matches. */
async function lockPlanWithPayments(tx: Queryable, actor: Actor, planId: string): Promise<{ status: 'active' | 'cancelled'; version: number }> {
  const locked = new Set<string>();
  for (let i = 0; i < 4; i++) {
    const wanted = (await repo.paymentsMatchedByPlan(tx, actor.householdId, planId)).filter((p) => !locked.has(p));
    if (wanted.length > 0) for (const p of await payments.lockPayments(tx, actor.householdId, wanted)) locked.add(p);
    const [plan] = await repo.lockPlans(tx, actor.householdId, [planId]);
    if (!plan) throw new AppError('not_found');
    const missing = (await repo.paymentsMatchedByPlan(tx, actor.householdId, planId)).filter((p) => !locked.has(p));
    if (missing.length === 0) return plan;
  }
  throw new AppError('conflict', 'The plan is changing. Try again.');
}

export async function createPlan(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string; replayed: boolean }> {
  authorize(actor, 'expenses:write');
  const { csrf: _csrf, idempotencyKey, ...d } = parse(paymentSchemas.createPlan, input);
  const schedule = buildSchedule(d);
  const id = randomUUID();
  return withRetry(() => withTransaction(pool, async (tx) => {
    const replayId = await idempotent(tx, actor, 'plan.create', idempotencyKey, { ...d, lines: schedule.lines, idempotencyKey: undefined }, id);
    if (replayId) return { id: replayId, replayed: true };
    await requireActive(tx, 'providers', actor.householdId, d.providerId);
    const locks = await expenseRepo.lockBills(tx, actor.householdId, d.billIds);
    if (locks.length !== d.billIds.length) throw new AppError('not_found');
    for (const b of locks) {
      if (b.providerId !== d.providerId) throw new AppError('invalid_input', 'Every bill in a plan must belong to the plan\'s provider');
      if (b.amountStatus !== 'confirmed') throw new AppError('conflict', 'A plan can only cover bills with confirmed amounts');
    }
    await repo.insertPlan(tx, { id, householdId: actor.householdId, userId: actor.userId, providerId: d.providerId, name: d.name });
    for (const b of [...d.billIds].sort()) await repo.insertPlanBill(tx, actor.householdId, id, b);
    await repo.insertRevision(tx, {
      id: randomUUID(), householdId: actor.householdId, userId: actor.userId, planId: id, revisionNo: 1, totalCents: schedule.totalCents, cadence: schedule.cadence,
      reason: 'Initial schedule', installments: schedule.lines.map((l) => ({ id: randomUUID(), ...l })),
    });
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'plan.created', entityType: 'payment_plan', entityId: id, requestId,
      detail: {
        planId: id, providerId: d.providerId, billCount: d.billIds.length, totalCents: cents(schedule.totalCents), cadence: schedule.cadence,
        installmentCount: schedule.lines.length, firstDueDate: schedule.lines[0]!.dueDate, lastDueDate: schedule.lines[schedule.lines.length - 1]!.dueDate,
        scopeOpenBalanceCents: cents(sum(locks.map((b) => b.baseResponsibilityCents + b.adjustmentsCents - b.appliedCents))),
      },
    });
    return { id, replayed: false };
  }));
}

/**
 * Replaces the schedule with a new immutable revision. Earlier revisions and their matched history stay as they were. Matches
 * carry forward onto the new installments in due-date order as new match rows that point at the same allocations, so no cash
 * is created, moved or counted twice. A revision cannot drop the total below what is already matched.
 */
export async function revisePlan(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string; replayed: boolean }> {
  authorize(actor, 'expenses:write');
  const { csrf: _csrf, idempotencyKey, planId, version, reason, ...rest } = parse(paymentSchemas.revisePlan, input);
  const schedule = buildSchedule(rest);
  const revisionId = randomUUID();
  return withRetry(() => withTransaction(pool, async (tx) => {
    const replayId = await idempotent(tx, actor, 'plan.revise', idempotencyKey, { planId, version, reason, lines: schedule.lines, cadence: schedule.cadence }, revisionId);
    if (replayId) return { id: replayId, replayed: true };
    const lock = await lockPlanWithPayments(tx, actor, planId);
    if (lock.version !== version) throw new AppError('stale_version');
    if (lock.status !== 'active') throw new AppError('conflict', 'That plan was cancelled');
    const cur = (await repo.currentRevision(tx, actor.householdId, planId))!;
    const before = await repo.getPlan(tx, actor.householdId, planId, todayUtc());
    const pairs = await repo.currentMatchPairs(tx, actor.householdId, planId);
    const matched = sum(pairs.map((p) => p.cents));
    if (matched > schedule.totalCents) throw new AppError('conflict', 'The new schedule total is less than what is already matched');
    const installments = schedule.lines.map((l) => ({ id: randomUUID(), ...l }));
    const filled = installments.map(() => 0n);
    const carried: Array<{ installmentIndex: number; pair: (typeof pairs)[number]; amount: bigint }> = [];
    let j = 0;
    for (const pair of pairs) {
      let left = pair.cents;
      while (left > 0n) {
        while (j < installments.length && filled[j]! >= installments[j]!.amountCents) j++;
        if (j >= installments.length) throw new AppError('conflict', 'The new schedule cannot hold what is already matched');
        const take = installments[j]!.amountCents - filled[j]! < left ? installments[j]!.amountCents - filled[j]! : left;
        filled[j]! += take;
        left -= take;
        carried.push({ installmentIndex: j, pair, amount: take });
      }
    }
    const revisionNo = cur.revisionNo + 1;
    await repo.insertRevision(tx, {
      id: revisionId, householdId: actor.householdId, userId: actor.userId, planId, revisionNo, totalCents: schedule.totalCents, cadence: schedule.cadence, reason, installments,
    });
    for (const c of carried) {
      await repo.insertMatch(tx, {
        id: randomUUID(), householdId: actor.householdId, userId: actor.userId, planId, revisionId, installmentId: installments[c.installmentIndex]!.id,
        paymentId: c.pair.paymentId, allocationId: c.pair.allocationId, billId: c.pair.billId, kind: 'match', amountCents: c.amount, carried: true,
        reason: `Carried forward from revision ${cur.revisionNo}`,
      });
    }
    await repo.touchPlan(tx, actor.householdId, planId);
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'plan.revised', entityType: 'payment_plan', entityId: planId, requestId,
      detail: {
        planId, fromRevisionNo: cur.revisionNo, toRevisionNo: revisionNo, fromTotalCents: cents(cur.totalCents), toTotalCents: cents(schedule.totalCents),
        fromInstallmentCount: before!.installmentCount, toInstallmentCount: installments.length, fromCadence: cur.cadence, toCadence: schedule.cadence,
        carriedMatchedCents: cents(matched), firstDueDate: installments[0]!.dueDate, lastDueDate: installments[installments.length - 1]!.dueDate,
      },
    });
    return { id: planId, replayed: false };
  }));
}

export async function cancelPlan(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string }> {
  authorize(actor, 'expenses:write');
  const { csrf: _csrf, ...d } = parse(paymentSchemas.cancelPlan, input);
  return withRetry(() => withTransaction(pool, async (tx) => {
    const [lock] = await repo.lockPlans(tx, actor.householdId, [d.planId]);
    if (!lock) throw new AppError('not_found');
    if (lock.version !== d.version) throw new AppError('stale_version');
    if (lock.status !== 'active') throw new AppError('conflict', 'That plan was already cancelled');
    const plan = (await repo.getPlan(tx, actor.householdId, d.planId, todayUtc()))!;
    await repo.cancelPlan(tx, actor.householdId, d.planId, d.version, d.reason);
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'plan.cancelled', entityType: 'payment_plan', entityId: d.planId, requestId,
      detail: { planId: d.planId, totalCents: plan.totalCents, matchedCents: plan.matchedCents, unpaidCents: cents(BigInt(plan.totalCents) - BigInt(plan.matchedCents)) },
    });
    return { id: d.planId };
  }));
}

/**
 * Matches part or all of an installment to an existing allocation. Locks the allocation's payment first, then the plan, and
 * checks the installment's unpaid amount and the allocation's unmatched cash against the locked, current figures.
 */
export async function matchInstallment(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string; replayed: boolean }> {
  authorize(actor, 'expenses:write');
  const { csrf: _csrf, planId: _redirect, idempotencyKey, ...d } = parse(paymentSchemas.matchInstallment, input);
  const id = randomUUID();
  return withRetry(() => withTransaction(pool, async (tx) => {
    const replayId = await idempotent(tx, actor, 'plan.match', idempotencyKey, d, id);
    if (replayId) return { id: replayId, replayed: true };
    const asOf = todayUtc();
    const probe = await repo.getInstallment(tx, actor.householdId, d.installmentId, asOf);
    const alloc0 = await payments.getAllocation(tx, actor.householdId, d.allocationId);
    if (!probe || !alloc0) throw new AppError('not_found');
    await payments.lockPayments(tx, actor.householdId, [alloc0.paymentId]);
    const [plan] = await repo.lockPlans(tx, actor.householdId, [probe.planId]);
    if (!plan) throw new AppError('not_found');
    if (plan.status !== 'active') throw new AppError('conflict', 'That plan was cancelled');
    const inst = (await repo.getInstallment(tx, actor.householdId, d.installmentId, asOf))!;
    const alloc = (await payments.getAllocation(tx, actor.householdId, d.allocationId))!;
    if (!inst.planCurrent) throw new AppError('conflict', 'That installment belongs to an earlier version of the schedule');
    if (!(await repo.planBillIds(tx, actor.householdId, inst.planId)).includes(alloc.billId)) throw new AppError('invalid_input', 'That payment was not applied to a bill in this plan');
    const unpaid = BigInt(inst.unpaidCents);
    const free = BigInt(alloc.netCents) - BigInt(alloc.matchedCents);
    if (d.amount > unpaid) throw new AppError('conflict', 'That is more than the installment still owes');
    if (d.amount > free) throw new AppError('conflict', 'That is more than the payment allocation has left to match');
    const revisionId = inst.revisionId;
    await repo.insertMatch(tx, {
      id, householdId: actor.householdId, userId: actor.userId, planId: inst.planId, revisionId, installmentId: inst.id, paymentId: alloc.paymentId,
      allocationId: alloc.allocationId, billId: alloc.billId, kind: 'match', amountCents: d.amount, carried: false, reason: '',
    });
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'plan.installment_matched', entityType: 'payment_plan', entityId: inst.planId, requestId,
      detail: {
        planId: inst.planId, installmentId: inst.id, paymentId: alloc.paymentId, allocationId: alloc.allocationId, amountCents: cents(d.amount),
        installmentMatchedBeforeCents: inst.matchedCents, installmentMatchedAfterCents: cents(BigInt(inst.matchedCents) + d.amount),
        allocationUnmatchedBeforeCents: cents(free), allocationUnmatchedAfterCents: cents(free - d.amount),
      },
    });
    return { id, replayed: false };
  }));
}

/** Removes part of a match (a correction, not a cash event). Posts a linked negative entry with a reason. */
export async function unmatchInstallment(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string; replayed: boolean }> {
  authorize(actor, 'expenses:write');
  const { csrf: _csrf, planId: _redirect, idempotencyKey, ...d } = parse(paymentSchemas.unmatchInstallment, input);
  const id = randomUUID();
  return withRetry(() => withTransaction(pool, async (tx) => {
    const replayId = await idempotent(tx, actor, 'plan.unmatch', idempotencyKey, d, id);
    if (replayId) return { id: replayId, replayed: true };
    const asOf = todayUtc();
    const probe = await repo.getInstallment(tx, actor.householdId, d.installmentId, asOf);
    const alloc0 = await payments.getAllocation(tx, actor.householdId, d.allocationId);
    if (!probe || !alloc0) throw new AppError('not_found');
    await payments.lockPayments(tx, actor.householdId, [alloc0.paymentId]);
    await repo.lockPlans(tx, actor.householdId, [probe.planId]);
    const inst = (await repo.getInstallment(tx, actor.householdId, d.installmentId, asOf))!;
    if (!inst.planCurrent) throw new AppError('conflict', 'That installment belongs to an earlier version of the schedule');
    const matched = await repo.matchedNet(tx, actor.householdId, inst.id, d.allocationId);
    if (d.amount > matched) throw new AppError('conflict', 'That is more than is matched to this installment');
    await repo.insertMatch(tx, {
      id, householdId: actor.householdId, userId: actor.userId, planId: inst.planId, revisionId: inst.revisionId, installmentId: inst.id, paymentId: alloc0.paymentId,
      allocationId: d.allocationId, billId: alloc0.billId, kind: 'unmatch', amountCents: -d.amount, carried: false, reason: d.reason,
    });
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'plan.installment_unmatched', entityType: 'payment_plan', entityId: inst.planId, requestId,
      detail: {
        planId: inst.planId, installmentId: inst.id, allocationId: d.allocationId, amountCents: cents(d.amount),
        installmentMatchedBeforeCents: inst.matchedCents, installmentMatchedAfterCents: cents(BigInt(inst.matchedCents) - d.amount),
      },
    });
    return { id, replayed: false };
  }));
}
