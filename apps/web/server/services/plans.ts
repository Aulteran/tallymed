// Use cases for payment plans: schedule creation and revision, partial installment matching and the upcoming/overdue views.
// A plan match references an existing payment allocation. It never creates, moves or double counts cash. Lock order is
// payments, then bills, then plans (see services/payments.ts).
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { authorize, type Actor } from '../authz.ts';
import { withTransaction, type Pool, type Queryable } from '../db.ts';
import { AppError } from '../errors.ts';
import { MAX_CENTS } from '../money.ts';
import { recordAudit } from '../repositories/audit.ts';
import * as expenseRepo from '../repositories/expenses.ts';
import * as payments from '../repositories/payments.ts';
import * as repo from '../repositories/plans.ts';
import { paymentFilterSchemas, parse, paymentSchemas, schemas } from '../validation.ts';
import { setUndoSlot } from '../repositories/undo.ts';
import { requireActive } from './expenses.ts';
import { idempotent, RetryTransaction, todayUtc, withRetry } from './support.ts';

const REMOVED_MESSAGE = 'That plan was removed';
const cents = (v: bigint) => v.toString();
const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

// ---------- schedule building (pure) ----------

/** `keepFrom` (internal only, never accepted from a client) names the earlier installment a kept line continues. */
export interface ScheduleLine { dueDate: string; amountCents: bigint; keepFrom?: string }
export interface Schedule {
  cadence: 'weekly' | 'biweekly' | 'monthly' | 'custom'; lines: ScheduleLine[]; totalCents: bigint;
  /** True when the lines were generated from a total or an amount, false for an explicit list. */
  generated: boolean;
  /** How the lines were produced; the rounding warning only applies to a price-and-count split. */
  inputMode: 'total' | 'per_installment' | 'list';
  /** A total the person entered that the schedule did not use (installments x amount), for the mismatch warning. */
  expectedTotalCents: bigint | null;
}

export type Remainder = 'earliest' | 'last_extra' | 'last_short';
export const MAX_INSTALLMENTS = 120;

/**
 * Splits a total over n installments. `earliest` (the original behavior) puts one extra cent on each of the first (total mod n)
 * installments. `last_extra` puts every leftover cent on the last one. `last_short` gives every installment the rounded-up
 * amount and lets the last take what is left, so it is the smaller one. All bigint, no floats.
 */
export function splitTotal(total: bigint, n: number, remainder: Remainder): bigint[] {
  const count = BigInt(n);
  if (total < count) throw new AppError('invalid_input', 'Each installment must be at least one cent');
  const base = total / count;
  const extra = total % count;
  if (extra === 0n) return Array.from({ length: n }, () => base);
  if (remainder === 'last_extra') return Array.from({ length: n }, (_, i) => (i === n - 1 ? base + extra : base));
  if (remainder === 'last_short') {
    const each = base + 1n;
    const last = total - each * (count - 1n);
    if (last < 1n) throw new AppError('invalid_input', 'That split leaves nothing for the last installment; use fewer installments or another remainder choice');
    return Array.from({ length: n }, (_, i) => (i === n - 1 ? last : each));
  }
  return Array.from({ length: n }, (_, i) => base + (i < Number(extra) ? 1n : 0n));
}

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
  installments?: Array<{ dueDate: string; amount: bigint; keepFrom?: string }>;
  /** "total" (default): this many installments at this much price. "per_installment": at this much paid per installment. */
  inputMode?: 'total' | 'per_installment'; installmentAmount?: bigint | null; remainder?: Remainder;
}): Schedule {
  const mode = d.inputMode ?? 'total';
  const amount = d.installmentAmount ?? null;
  if (d.installments && d.installments.length > 0) {
    if (d.totalAmount !== null || d.installmentCount !== null || d.firstDueDate !== null || amount !== null) throw new AppError('invalid_input', 'Give either a generated schedule or a list of installments');
    const lines = d.installments.map((i, n) => ({ ...i, n })).sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.n - b.n))
      .map((i) => ({ dueDate: i.dueDate, amountCents: i.amount, ...(i.keepFrom ? { keepFrom: i.keepFrom } : {}) }));
    const totalCents = sum(lines.map((l) => l.amountCents));
    if (totalCents > MAX_CENTS) throw new AppError('invalid_input', 'Amount out of range');
    return { cadence: 'custom', lines, totalCents, generated: false, inputMode: 'list', expectedTotalCents: null };
  }
  if (d.cadence === 'custom' || d.firstDueDate === null) throw new AppError('invalid_input', 'Give a total or an amount per installment, a first due date and a cadence');
  let amounts: bigint[];
  let expectedTotalCents: bigint | null = null;
  if (mode === 'per_installment') {
    // At this much per installment. With a count the total is count x amount (a total that was also entered is only compared, in a warning).
    // With a total and no count, the count is the total divided by the amount rounded up and the last installment takes what is left.
    if (amount === null) throw new AppError('invalid_input', 'Give the amount paid per installment');
    if (d.installmentCount === null && d.totalAmount === null) throw new AppError('invalid_input', 'Give a number of installments or a total');
    if (d.installmentCount !== null) {
      amounts = Array.from({ length: d.installmentCount }, () => amount);
      expectedTotalCents = d.totalAmount;
    } else {
      const total = d.totalAmount!;
      const n = (total + amount - 1n) / amount;
      if (n > BigInt(MAX_INSTALLMENTS)) throw new AppError('invalid_input', `That needs ${n.toString()} installments; the most is ${MAX_INSTALLMENTS}`);
      amounts = Array.from({ length: Number(n) }, (_, i) => (i === Number(n) - 1 ? total - amount * (n - 1n) : amount));
    }
  } else {
    if (amount !== null) throw new AppError('invalid_input', 'An amount per installment needs the per-installment input mode');
    if (d.totalAmount === null || d.installmentCount === null) throw new AppError('invalid_input', 'Give a total, a number of installments, a first due date and a cadence');
    amounts = splitTotal(d.totalAmount, d.installmentCount, d.remainder ?? 'earliest');
  }
  const totalCents = sum(amounts);
  if (totalCents > MAX_CENTS) throw new AppError('invalid_input', 'Amount out of range');
  const lines = amounts.map((amountCents, i) => ({ dueDate: dueDateAt(d.firstDueDate!, d.cadence as 'weekly' | 'biweekly' | 'monthly', i), amountCents }));
  if (lines[lines.length - 1]!.dueDate > '2100-01-01') throw new AppError('invalid_input', 'Due date out of range');
  return { cadence: d.cadence, lines, totalCents, generated: true, inputMode: mode, expectedTotalCents };
}

/**
 * Keeps already paid installments exactly as they are and appends a generated schedule for the rest. Kept lines come first in the
 * list so they win same-date ties. The result is a custom schedule; each kept line remembers the installment it continues.
 */
export function keepPaidSchedule(kept: Array<{ id: string; dueDate: string; amountCents: bigint }>, rest: Schedule): Schedule {
  const built = buildSchedule({
    cadence: 'custom', totalAmount: null, installmentCount: null, firstDueDate: null,
    installments: [...kept.map((k) => ({ dueDate: k.dueDate, amount: k.amountCents, keepFrom: k.id })), ...rest.lines.map((l) => ({ dueDate: l.dueDate, amount: l.amountCents }))],
  });
  return { ...built, expectedTotalCents: rest.expectedTotalCents };
}

export interface MatchPair { installmentId: string; allocationId: string; paymentId: string; billId: string; cents: bigint }
export interface CarriedMatch<P extends MatchPair> { installmentIndex: number; pair: P; amount: bigint; keptFrom: string | null }

/**
 * Decides where current matches land on a new schedule. A match on a kept installment follows that installment (identity), so its
 * allocations stay on the same line. Every other match fills the non-kept installments in due-date order, as before. With no kept
 * lines this is exactly the original greedy carry-forward.
 */
export function carryMatches<P extends MatchPair>(pairs: P[], installments: Array<{ amountCents: bigint; keepFrom?: string }>): CarriedMatch<P>[] {
  const out: CarriedMatch<P>[] = [];
  const filled = installments.map(() => 0n);
  const keptIndex = new Map(installments.map((x, i) => [x.keepFrom, i] as const).filter(([k]) => k !== undefined));
  const loose: P[] = [];
  for (const pair of pairs) {
    const i = keptIndex.get(pair.installmentId);
    if (i === undefined) { loose.push(pair); continue; }
    if (filled[i]! + pair.cents > installments[i]!.amountCents) throw new AppError('conflict', 'A kept installment holds more than its amount');
    filled[i]! += pair.cents;
    out.push({ installmentIndex: i, pair, amount: pair.cents, keptFrom: pair.installmentId });
  }
  let j = 0;
  for (const pair of loose) {
    let left = pair.cents;
    while (left > 0n) {
      while (j < installments.length && (installments[j]!.keepFrom !== undefined || filled[j]! >= installments[j]!.amountCents)) j++;
      if (j >= installments.length) throw new AppError('conflict', 'The new schedule cannot hold what is already matched');
      const room = installments[j]!.amountCents - filled[j]!;
      const take = room < left ? room : left;
      filled[j]! += take;
      left -= take;
      out.push({ installmentIndex: j, pair, amount: take, keptFrom: null });
    }
  }
  return out;
}

export type PlanWarning =
  | { code: 'total_mismatch'; expectedCents: string; computedCents: string; differenceCents: string }
  | { code: 'bill_balance_mismatch'; planBasisCents: string; openBalanceCents: string; differenceCents: string; direction: 'above' | 'below' }
  | { code: 'unequal_installments'; minCents: string; maxCents: string; distinct: number };

/**
 * Pure and advisory: never blocks a save. `matchedCents` is cash already matched to the plan, so the plan is compared with what
 * is still unpaid rather than with a balance that already excludes that cash. `openBalanceCents` is signed (a credit can make it negative).
 */
export function planWarnings(d: { schedule: Schedule; openBalanceCents: bigint | null; matchedCents: bigint }): PlanWarning[] {
  const out: PlanWarning[] = [];
  const { schedule } = d;
  if (schedule.expectedTotalCents !== null && schedule.expectedTotalCents !== schedule.totalCents) {
    out.push({ code: 'total_mismatch', expectedCents: schedule.expectedTotalCents.toString(), computedCents: schedule.totalCents.toString(), differenceCents: (schedule.totalCents - schedule.expectedTotalCents).toString() });
  }
  if (d.openBalanceCents !== null) {
    const basis = schedule.totalCents - d.matchedCents;
    if (basis !== d.openBalanceCents) {
      out.push({
        code: 'bill_balance_mismatch', planBasisCents: basis.toString(), openBalanceCents: d.openBalanceCents.toString(),
        differenceCents: (basis - d.openBalanceCents).toString(), direction: basis > d.openBalanceCents ? 'above' : 'below',
      });
    }
  }
  if (schedule.generated && schedule.inputMode === 'total') {
    const amounts = schedule.lines.map((l) => l.amountCents);
    const min = amounts.reduce((a, b) => (b < a ? b : a));
    const max = amounts.reduce((a, b) => (b > a ? b : a));
    // Only a difference that rounding explains (under one cent per installment). A deliberately smaller last installment is not rounding.
    if (min !== max && max - min < BigInt(amounts.length)) out.push({ code: 'unequal_installments', minCents: min.toString(), maxCents: max.toString(), distinct: new Set(amounts.map(String)).size });
  }
  return out;
}

// ---------- reads ----------

const asOfDate = (v?: string) => {
  if (v === undefined || v === '') return todayUtc();
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T00:00:00Z`) : Number.NaN;
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== v) throw new AppError('invalid_input', 'Enter the as-of date as YYYY-MM-DD');
  return v;
};

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

/** `includeRemoved` is internal (restore only); a removed plan is otherwise not found. */
export async function getPlanDetail(pool: Pool, actor: Actor, id: string, o: { asOf?: string; allocationId?: string | null; includeRemoved?: boolean } = {}) {
  authorize(actor, 'expenses:read');
  const planId = parse(schemas.id, id);
  const asOf = asOfDate(o.asOf);
  const plan = await repo.getPlan(pool, actor.householdId, planId, asOf, { includeRemoved: o.includeRemoved === true });
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

/**
 * Locks the payments that back a plan's matches, then the plan itself (payments before plans). If a match for a payment we have
 * not locked appears once the plan is locked, a payment lock must not be taken while holding the plan: the transaction is
 * restarted (RetryTransaction) so the larger set is locked in the documented order from the start.
 */
async function lockPlanWithPayments(tx: Queryable, actor: Actor, planId: string): Promise<{ status: 'active' | 'cancelled'; version: number; removed: boolean }> {
  const wanted = await repo.paymentsMatchedByPlan(tx, actor.householdId, planId);
  const locked = new Set(wanted.length > 0 ? await payments.lockPayments(tx, actor.householdId, wanted) : []);
  const [plan] = await repo.lockPlans(tx, actor.householdId, [planId]);
  if (!plan) throw new AppError('not_found');
  const after = await repo.paymentsMatchedByPlan(tx, actor.householdId, planId);
  if (after.some((p) => !locked.has(p))) throw new RetryTransaction();
  return plan;
}

// ---------- matching existing cash (references only) ----------

export interface FillSlot { id: string; left: bigint }
export interface FillSource { allocationId: string; paymentId: string; billId: string; free: bigint }
export interface FillMatch { installmentId: string; source: FillSource; amount: bigint }

/**
 * Pure. Pairs unmatched allocation cash with installments: the oldest payment fills the earliest installment first, and an
 * allocation or an installment can be split across several pairs. Never matches more than either side holds.
 */
export function fillInstallments(sources: FillSource[], slots: FillSlot[]): FillMatch[] {
  const out: FillMatch[] = [];
  const left = slots.map((x) => x.left);
  let j = 0;
  for (const source of sources) {
    let free = source.free;
    while (free > 0n) {
      while (j < slots.length && left[j]! <= 0n) j++;
      if (j >= slots.length) return out;
      const take = left[j]! < free ? left[j]! : free;
      left[j]! -= take;
      free -= take;
      out.push({ installmentId: slots[j]!.id, source, amount: take });
    }
  }
  return out;
}

/** Locks every payment that holds an allocation on these bills, in id order, before bills and plans are locked. */
async function lockBillPayments(tx: Queryable, actor: Actor, billIds: string[]): Promise<Set<string>> {
  const ids = await payments.paymentIdsOnBills(tx, actor.householdId, billIds);
  return new Set(ids.length > 0 ? await payments.lockPayments(tx, actor.householdId, ids) : []);
}

/** Reads the unmatched allocations of payments made on or after `since` (UTC date); a payment that appeared after the locks were taken restarts the transaction. */
async function unmatchedCash(tx: Queryable, actor: Actor, billIds: string[], locked: Set<string>, since: string): Promise<FillSource[]> {
  const rows = await payments.listUnmatchedAllocations(tx, actor.householdId, billIds);
  if (rows.some((r) => !locked.has(r.paymentId))) throw new RetryTransaction();
  return rows.filter((r) => r.paidOn >= since).map((r) => ({ allocationId: r.allocationId, paymentId: r.paymentId, billId: r.billId, free: BigInt(r.netCents) - BigInt(r.matchedCents) }));
}

async function insertFill(tx: Queryable, actor: Actor, planId: string, revisionId: string, fill: FillMatch[], reason: string): Promise<void> {
  for (const f of fill) {
    await repo.insertMatch(tx, {
      id: randomUUID(), householdId: actor.householdId, userId: actor.userId, planId, revisionId, installmentId: f.installmentId,
      paymentId: f.source.paymentId, allocationId: f.source.allocationId, billId: f.source.billId, kind: 'match', amountCents: f.amount, carried: false, reason,
    });
  }
}

/** The form sends one checkbox per bill (`bill_<id>`, since a form field name can appear once); JSON callers send `billIds`. */
function withBillChecks(input: unknown): unknown {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return input;
  const { ...rest } = input as Record<string, unknown>;
  const checked: string[] = [];
  for (const k of Object.keys(rest)) {
    const m = /^bill_([0-9a-f-]{36})$/.exec(k);
    if (!m) continue;
    if (rest[k] === 'on' || rest[k] === 'yes') checked.push(m[1]!);
    delete rest[k];
  }
  if (checked.length > 0 && !rest.billIds && !rest.billId) rest.billIds = checked;
  return rest;
}

export async function createPlan(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string; replayed: boolean }> {
  authorize(actor, 'expenses:write');
  const { csrf: _csrf, idempotencyKey, ...d } = parse(paymentSchemas.createPlan, withBillChecks(input));
  const schedule = buildSchedule(d);
  // The start date is the household's own label (UTC calendar date, never in the future). The real entry time stays in created_at and the audit trail.
  const startedOn = d.startedOn ?? todayUtc();
  if (startedOn > todayUtc()) throw new AppError('invalid_input', 'The plan start date cannot be in the future');
  const id = randomUUID();
  return withRetry(() => withTransaction(pool, async (tx) => {
    const replayId = await idempotent(tx, actor, 'plan.create', idempotencyKey, { ...d, lines: schedule.lines, idempotencyKey: undefined }, id);
    if (replayId) return { id: replayId, replayed: true };
    const lockedPayments = d.matchExisting ? await lockBillPayments(tx, actor, d.billIds) : new Set<string>();
    const locks = await expenseRepo.lockBills(tx, actor.householdId, d.billIds);
    if (locks.length !== d.billIds.length) throw new AppError('not_found');
    // The bills may come from several providers (a hospital often bills one visit under different names). A plan has no provider
    // of its own; every provider behind the bills must still be active.
    const providerIds = [...new Set(locks.map((b) => b.providerId))].sort();
    for (const pid of providerIds) await requireActive(tx, 'providers', actor.householdId, pid);
    for (const b of locks) {
      if (b.amountStatus !== 'confirmed') throw new AppError('conflict', 'A plan can only cover bills with confirmed amounts');
    }
    await repo.insertPlan(tx, { id, householdId: actor.householdId, userId: actor.userId, name: d.name, startedOn });
    for (const b of [...d.billIds].sort()) await repo.insertPlanBill(tx, actor.householdId, id, b);
    const revisionId = randomUUID();
    const installments = schedule.lines.map((l) => ({ id: randomUUID(), ...l }));
    await repo.insertRevision(tx, {
      id: revisionId, householdId: actor.householdId, userId: actor.userId, planId: id, revisionNo: 1, totalCents: schedule.totalCents, cadence: schedule.cadence,
      reason: 'Initial schedule', installments,
    });
    // Optionally reference cash that was already applied to these bills. Nothing is created or moved: only match rows are added.
    const fill = d.matchExisting
      ? fillInstallments(await unmatchedCash(tx, actor, d.billIds, lockedPayments, startedOn), installments.map((i) => ({ id: i.id, left: i.amountCents })))
      : [];
    await insertFill(tx, actor, id, revisionId, fill, 'Matched an existing payment when the plan was created');
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'plan.created', entityType: 'payment_plan', entityId: id, requestId,
      detail: {
        planId: id, providerIds: providerIds.join(','), providerCount: providerIds.length, billCount: d.billIds.length, totalCents: cents(schedule.totalCents), cadence: schedule.cadence,
        installmentCount: schedule.lines.length, firstDueDate: schedule.lines[0]!.dueDate, lastDueDate: schedule.lines[schedule.lines.length - 1]!.dueDate,
        scopeOpenBalanceCents: cents(sum(locks.map((b) => b.baseResponsibilityCents + b.adjustmentsCents - b.appliedCents))),
        startedOn, matchExisting: !!d.matchExisting, matchedExistingCents: cents(sum(fill.map((f) => f.amount))), matchedExistingAllocations: new Set(fill.map((f) => f.source.allocationId)).size,
        inputMode: d.inputMode, remainder: d.remainder, expectedTotalCents: schedule.expectedTotalCents === null ? null : cents(schedule.expectedTotalCents), computedTotalCents: cents(schedule.totalCents),
        warningCodes: planWarnings({
          schedule, matchedCents: sum(fill.map((f) => f.amount)),
          openBalanceCents: sum(locks.map((b) => b.baseResponsibilityCents + b.adjustmentsCents - b.appliedCents)),
        }).map((w) => w.code).join(','),
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
  const { csrf: _csrf, idempotencyKey, planId, version, reason, reviseMode, ...rest } = parse(paymentSchemas.revisePlan, input);
  // In keep_paid mode this is the schedule for the unpaid rest only (firstDueDate is the restart date). Built before any lock to validate early.
  const restSchedule = buildSchedule(rest);
  const revisionId = randomUUID();
  return withRetry(() => withTransaction(pool, async (tx) => {
    // The fingerprint of a plain replace stays exactly as it was; the mode joins it only when kept installments are involved.
    const fingerprint = { planId, version, reason, lines: restSchedule.lines, cadence: restSchedule.cadence, ...(reviseMode === 'keep_paid' ? { reviseMode } : {}), ...(restSchedule.expectedTotalCents !== null ? { expectedTotalCents: cents(restSchedule.expectedTotalCents) } : {}) };
    const replayId = await idempotent(tx, actor, 'plan.revise', idempotencyKey, fingerprint, revisionId);
    if (replayId) return { id: replayId, replayed: true };
    const lock = await lockPlanWithPayments(tx, actor, planId);
    if (lock.removed) throw new AppError('conflict', REMOVED_MESSAGE);
    if (lock.version !== version) throw new AppError('stale_version');
    if (lock.status !== 'active') throw new AppError('conflict', 'That plan was cancelled');
    const cur = (await repo.currentRevision(tx, actor.householdId, planId))!;
    const before = await repo.getPlan(tx, actor.householdId, planId, todayUtc());
    const pairs = await repo.currentMatchPairs(tx, actor.householdId, planId);
    const matched = sum(pairs.map((p) => p.cents));
    // Fully paid installments are read under the lock, so what is kept is exactly what is paid when the revision is written.
    let kept: Array<{ id: string; dueDate: string; amountCents: bigint }> = [];
    if (reviseMode === 'keep_paid') {
      const current = await repo.listInstallments(tx, actor.householdId, cur.id, todayUtc());
      kept = current.filter((i) => BigInt(i.unpaidCents) === 0n).map((i) => ({ id: i.id, dueDate: i.dueDate, amountCents: BigInt(i.amountCents) }));
      if (kept.length === current.length) throw new AppError('conflict', 'Every installment is already paid, so there is nothing left to restart');
    }
    const schedule = kept.length > 0 ? keepPaidSchedule(kept, restSchedule) : restSchedule;
    if (schedule.lines.length > MAX_INSTALLMENTS) throw new AppError('invalid_input', `A plan can have at most ${MAX_INSTALLMENTS} installments; kept and new installments together come to ${schedule.lines.length}`);
    if (matched > schedule.totalCents) throw new AppError('conflict', 'The new schedule total is less than what is already matched');
    const installments = schedule.lines.map((l) => ({ id: randomUUID(), ...l }));
    const carried = carryMatches(pairs, installments);
    const keptCents = sum(kept.map((k) => k.amountCents));
    // Advisory: the entered-total and rounding checks describe what was typed (the new rest); the balance check compares the whole plan with the bills.
    const planBills = await expenseRepo.getBills(tx, actor.householdId, await repo.planBillIds(tx, actor.householdId, planId));
    const billsOpen = sum(planBills.map((b) => BigInt(b.openBalanceCents)));
    const revisionWarnings = [
      ...planWarnings({ schedule: restSchedule, openBalanceCents: null, matchedCents: 0n }),
      ...planWarnings({ schedule, openBalanceCents: billsOpen, matchedCents: matched }).filter((w) => w.code === 'bill_balance_mismatch'),
    ];
    const revisionNo = cur.revisionNo + 1;
    await repo.insertRevision(tx, {
      id: revisionId, householdId: actor.householdId, userId: actor.userId, planId, revisionNo, totalCents: schedule.totalCents, cadence: schedule.cadence, reason, installments,
    });
    for (const c of carried) {
      await repo.insertMatch(tx, {
        id: randomUUID(), householdId: actor.householdId, userId: actor.userId, planId, revisionId, installmentId: installments[c.installmentIndex]!.id,
        paymentId: c.pair.paymentId, allocationId: c.pair.allocationId, billId: c.pair.billId, kind: 'match', amountCents: c.amount, carried: true,
        reason: c.keptFrom ? `Kept from revision ${cur.revisionNo}` : `Carried forward from revision ${cur.revisionNo}`,
      });
    }
    await repo.touchPlan(tx, actor.householdId, planId);
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'plan.revised', entityType: 'payment_plan', entityId: planId, requestId,
      detail: {
        planId, fromRevisionNo: cur.revisionNo, toRevisionNo: revisionNo, fromTotalCents: cents(cur.totalCents), toTotalCents: cents(schedule.totalCents),
        fromInstallmentCount: before!.installmentCount, toInstallmentCount: installments.length, fromCadence: cur.cadence, toCadence: schedule.cadence,
        carriedMatchedCents: cents(matched), firstDueDate: installments[0]!.dueDate, lastDueDate: installments[installments.length - 1]!.dueDate,
        reviseMode, keptInstallmentCount: kept.length, keptCents: cents(keptCents), rescheduledCount: restSchedule.lines.length, rescheduledCents: cents(restSchedule.totalCents),
        inputMode: rest.inputMode, remainder: rest.remainder, expectedTotalCents: restSchedule.expectedTotalCents === null ? null : cents(restSchedule.expectedTotalCents), computedTotalCents: cents(restSchedule.totalCents),
        warningCodes: revisionWarnings.map((w) => w.code).join(','),
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
    if (lock.removed) throw new AppError('conflict', REMOVED_MESSAGE);
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

/** Renames a plan, active or cancelled. A label only: no schedule, match, payment or balance changes. Takes the plan lock alone, like cancel. */
export async function renamePlan(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string }> {
  authorize(actor, 'expenses:write');
  const { csrf: _csrf, ...d } = parse(paymentSchemas.renamePlan, input);
  return withRetry(() => withTransaction(pool, async (tx) => {
    const [lock] = await repo.lockPlans(tx, actor.householdId, [d.planId]);
    if (!lock) throw new AppError('not_found');
    if (lock.removed) throw new AppError('conflict', REMOVED_MESSAGE);
    const plan = (await repo.getPlan(tx, actor.householdId, d.planId, todayUtc()))!;
    await repo.renamePlan(tx, actor.householdId, d.planId, d.name);
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'plan.renamed', entityType: 'payment_plan', entityId: d.planId, requestId,
      detail: { planId: d.planId, renamed: plan.name !== d.name, status: lock.status },
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
    if (plan.removed) throw new AppError('conflict', REMOVED_MESSAGE);
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

/**
 * Matches all cash already applied to the plan's bills and not yet matched to a plan, oldest payment first, onto the earliest
 * installments that still owe. References only: no cash, allocation or bill balance changes. Locks payments, then the plan.
 */
export async function matchExistingPayments(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string; replayed: boolean }> {
  authorize(actor, 'expenses:write');
  const { csrf: _csrf, idempotencyKey, ...d } = parse(paymentSchemas.matchExistingPayments, input);
  const id = randomUUID();
  return withRetry(() => withTransaction(pool, async (tx) => {
    const replayId = await idempotent(tx, actor, 'plan.match_existing', idempotencyKey, d, id);
    if (replayId) return { id: replayId, replayed: true };
    const billIds = await repo.planBillIds(tx, actor.householdId, d.planId);
    if (billIds.length === 0) throw new AppError('not_found');
    const locked = await lockBillPayments(tx, actor, billIds);
    const [plan] = await repo.lockPlans(tx, actor.householdId, [d.planId]);
    if (!plan) throw new AppError('not_found');
    if (plan.removed) throw new AppError('conflict', REMOVED_MESSAGE);
    const plan0 = (await repo.getPlan(tx, actor.householdId, d.planId, todayUtc()))!;
    if (plan.version !== d.version) throw new AppError('stale_version');
    if (plan.status !== 'active') throw new AppError('conflict', 'That plan was cancelled');
    const cur = (await repo.currentRevision(tx, actor.householdId, d.planId))!;
    const open = (await repo.listInstallments(tx, actor.householdId, cur.id, todayUtc())).filter((i) => BigInt(i.unpaidCents) > 0n);
    const fill = fillInstallments(await unmatchedCash(tx, actor, billIds, locked, plan0.startedOn), open.map((i) => ({ id: i.id, left: BigInt(i.unpaidCents) })));
    if (fill.length === 0) throw new AppError('conflict', 'There is no unmatched payment cash, or nothing left owed on the schedule');
    await insertFill(tx, actor, d.planId, cur.id, fill, 'Matched an existing payment in bulk');
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'plan.existing_payments_matched', entityType: 'payment_plan', entityId: d.planId, requestId,
      detail: {
        planId: d.planId, startedOn: plan0.startedOn, revisionNo: cur.revisionNo, matchCount: fill.length, allocationCount: new Set(fill.map((f) => f.source.allocationId)).size,
        installmentCount: new Set(fill.map((f) => f.installmentId)).size, matchedCents: cents(sum(fill.map((f) => f.amount))),
      },
    });
    return { id: d.planId, replayed: false };
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
    const [plan] = await repo.lockPlans(tx, actor.householdId, [probe.planId]);
    if (!plan) throw new AppError('not_found');
    if (plan.removed) throw new AppError('conflict', REMOVED_MESSAGE);
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

// ---------- removal and restore (administrators only) ----------

const releasedMatch = z.strictObject({
  installmentId: z.string().uuid(), allocationId: z.string().uuid(), paymentId: z.string().uuid(), revisionId: z.string().uuid(), cents: z.string().regex(/^[1-9][0-9]*$/),
});
const planRemovalPayload = z.strictObject({ wasActive: z.boolean(), releasedMatches: z.array(releasedMatch) });

/**
 * Hides a plan. An active plan first releases every live match with negative match rows (the same pattern as "unmatch", audited as
 * plan.match_released), so no cash or balance is touched and no payment changes; a cancelled plan keeps its matches as history and is
 * only hidden. Locks: the payments behind the plan's matches, then the plan (the global order). Sets the actor's undo slot.
 */
export async function removePlan(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string; replayed: boolean }> {
  authorize(actor, 'records:remove');
  const { csrf: _csrf, idempotencyKey, planId, version, reason } = parse(paymentSchemas.removePlan, input);
  return withRetry(() => withTransaction(pool, async (tx) => {
    const replayId = await idempotent(tx, actor, 'plan.remove', idempotencyKey, { planId, version, reason }, planId);
    if (replayId) return { id: replayId, replayed: true };
    const lock = await lockPlanWithPayments(tx, actor, planId);
    if (lock.removed) throw new AppError('conflict', 'That plan was already removed');
    if (lock.version !== version) throw new AppError('stale_version');
    const plan = (await repo.getPlan(tx, actor.householdId, planId, todayUtc()))!;
    const released: Array<z.infer<typeof releasedMatch>> = [];
    if (lock.status === 'active') {
      const cur = (await repo.currentRevision(tx, actor.householdId, planId))!;
      for (const m of await repo.currentMatchPairs(tx, actor.householdId, planId)) {
        await repo.insertMatch(tx, {
          id: randomUUID(), householdId: actor.householdId, userId: actor.userId, planId, revisionId: cur.id, installmentId: m.installmentId,
          paymentId: m.paymentId, allocationId: m.allocationId, billId: m.billId, kind: 'unmatch', amountCents: -m.cents, carried: false, reason: 'Released because the plan was removed',
        });
        await recordAudit(tx, {
          householdId: actor.householdId, actorUserId: actor.userId, action: 'plan.match_released', entityType: 'payment_plan', entityId: planId, requestId,
          detail: { planId, installmentId: m.installmentId, paymentId: m.paymentId, allocationId: m.allocationId, amountCents: cents(m.cents), matchedBeforeCents: cents(m.cents), matchedAfterCents: '0' },
        });
        released.push({ installmentId: m.installmentId, allocationId: m.allocationId, paymentId: m.paymentId, revisionId: cur.id, cents: cents(m.cents) });
      }
    }
    if (!(await repo.removePlanRow(tx, actor.householdId, planId, version, actor.userId, reason))) throw new AppError('stale_version');
    const releasedCents = sum(released.map((m) => BigInt(m.cents)));
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'plan.removed', entityType: 'payment_plan', entityId: planId, requestId,
      detail: {
        planId, status: lock.status, totalCents: plan.totalCents, matchedBeforeCents: plan.matchedCents, releasedMatchCount: released.length, releasedMatchCents: cents(releasedCents),
        matchedAfterCents: cents(BigInt(plan.matchedCents) - releasedCents), revisionNo: plan.revisionNo, installmentCount: plan.installmentCount,
      },
    });
    await setUndoSlot(tx, actor, { kind: 'plan_remove', entityId: planId, payload: { wasActive: lock.status === 'active', releasedMatches: released } satisfies z.infer<typeof planRemovalPayload> });
    return { id: planId, replayed: false };
  }));
}

/**
 * The inverse of removePlan, used only by undo inside its transaction (the caller authorized `records:remove`). Shows the plan again and,
 * if it is active, re-posts each released match within the usual limits: the installment must still owe it, and the allocation must still
 * have that much net cash unmatched. A match that no longer fits is skipped and listed in the audit. Nothing about cash changes.
 */
export async function restorePlan(tx: Queryable, actor: Actor, planId: string, rawPayload: unknown, requestId: string): Promise<{ restoredCount: number; skippedCount: number }> {
  const parsed = planRemovalPayload.safeParse(rawPayload);
  if (!parsed.success) throw new AppError('conflict', 'Nothing to undo');
  const payload = parsed.data;
  // Payments first (the matches' payments), then the plan.
  const paymentIds = [...new Set(payload.releasedMatches.map((m) => m.paymentId))];
  if (paymentIds.length > 0) await payments.lockPayments(tx, actor.householdId, paymentIds);
  const [lock] = await repo.lockPlans(tx, actor.householdId, [planId]);
  if (!lock) throw new AppError('not_found');
  if (!lock.removed) throw new AppError('conflict', 'That plan is no longer removed');
  await repo.restorePlanRow(tx, actor.householdId, planId);
  const asOf = todayUtc();
  const skipped: Array<{ installmentId: string; allocationId: string; cents: bigint }> = [];
  let restored = 0n;
  let restoredCount = 0;
  if (payload.wasActive && lock.status === 'active') {
    for (const m of payload.releasedMatches) {
      const amount = BigInt(m.cents);
      const inst = await repo.getInstallment(tx, actor.householdId, m.installmentId, asOf);
      const alloc = await payments.getAllocation(tx, actor.householdId, m.allocationId);
      const fits = inst !== null && alloc !== null && inst.planId === planId && inst.planCurrent && alloc.paymentId === m.paymentId
        && amount <= BigInt(inst.unpaidCents) && amount <= BigInt(alloc.netCents) - BigInt(alloc.matchedCents);
      if (!fits) { skipped.push({ installmentId: m.installmentId, allocationId: m.allocationId, cents: amount }); continue; }
      await repo.insertMatch(tx, {
        id: randomUUID(), householdId: actor.householdId, userId: actor.userId, planId, revisionId: inst.revisionId, installmentId: m.installmentId,
        paymentId: alloc.paymentId, allocationId: alloc.allocationId, billId: alloc.billId, kind: 'match', amountCents: amount, carried: false, reason: 'Restored by undo',
      });
      restored += amount;
      restoredCount++;
    }
  }
  await recordAudit(tx, {
    householdId: actor.householdId, actorUserId: actor.userId, action: 'plan.restored', entityType: 'payment_plan', entityId: planId, requestId,
    detail: {
      planId, wasActive: payload.wasActive, releasedMatchCount: payload.releasedMatches.length, restoredMatchCount: restoredCount, restoredCents: cents(restored),
      skippedMatchCount: skipped.length, skippedCents: cents(sum(skipped.map((k) => k.cents))),
      skippedInstallmentIds: skipped.map((k) => k.installmentId).join(','), skippedAllocationIds: skipped.map((k) => k.allocationId).join(','),
    },
  });
  return { restoredCount, skippedCount: skipped.length };
}
