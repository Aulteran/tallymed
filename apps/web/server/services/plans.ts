// Use cases for payment plans: schedule creation and revision, partial installment matching and the upcoming/overdue views.
// A plan match references an existing payment allocation. It never creates, moves or double counts cash. Lock order is
// payments, then bills, then plans (see services/payments.ts).
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { authorize, type Actor } from '../authz.ts';
import { withTransaction, type Pool, type Queryable } from '../db.ts';
import { AppError } from '../errors.ts';
import { formatCents, MAX_CENTS } from '../money.ts';
import { recordAudit } from '../repositories/audit.ts';
import * as expenseRepo from '../repositories/expenses.ts';
import * as payments from '../repositories/payments.ts';
import * as repo from '../repositories/plans.ts';
import { createPlanInProgressPreviewSchema, createPlanPreviewSchema, paymentFilterSchemas, parse, paymentSchemas, schedulePreviewSchema, schemas } from '../validation.ts';
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
/** The leftover-cents choice for the audit detail: only a price-and-count schedule reads it; null for the other modes, so the record never shows a default that was not used. */
const remainderUsed = (mode: Schedule['inputMode'], remainder: Remainder | undefined): Remainder | null => (mode === 'total' ? (remainder ?? 'earliest') : null);

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

/** A fully paid installment of the current schedule: what a keep_paid revision holds on to. */
export interface KeptInstallment { id: string; dueDate: string; amountCents: bigint }

/** Pure. The fully paid installments of a schedule (nothing still owed), in schedule order. */
export function keptInstallments(current: Array<{ id: string; dueDate: string; amountCents: string; unpaidCents: string }>): KeptInstallment[] {
  return current.filter((i) => BigInt(i.unpaidCents) === 0n).map((i) => ({ id: i.id, dueDate: i.dueDate, amountCents: BigInt(i.amountCents) }));
}

/**
 * Pure. The schedule a revision would save, and the refusals that go with it: with keep_paid the fully paid installments are
 * kept ahead of the new rest, nothing may be left already paid, the plan cannot exceed the installment cap, and the total
 * cannot fall below what is already matched. The service and the form preview both call this, so what the preview shows is what is saved.
 */
export function composeRevision(d: { restSchedule: Schedule; kept: KeptInstallment[]; reviseMode: 'replace' | 'keep_paid'; currentCount: number; matchedCents: bigint }): Schedule {
  if (d.reviseMode === 'keep_paid' && d.kept.length === d.currentCount) throw new AppError('conflict', 'Every installment is already paid, so there is nothing left to restart');
  const schedule = d.kept.length > 0 ? keepPaidSchedule(d.kept, d.restSchedule) : d.restSchedule;
  if (schedule.lines.length > MAX_INSTALLMENTS) throw new AppError('invalid_input', `A plan can have at most ${MAX_INSTALLMENTS} installments; kept and new installments together come to ${schedule.lines.length}`);
  if (d.matchedCents > schedule.totalCents) throw new AppError('conflict', 'The new schedule total is less than what is already matched');
  return schedule;
}

/** Pure. Advisory: the entered-total and rounding checks describe what was typed (the new rest); the balance check compares the whole plan with the bills. */
export function revisionWarnings(d: { restSchedule: Schedule; schedule: Schedule; billsOpenCents: bigint | null; matchedCents: bigint }): PlanWarning[] {
  return [
    ...planWarnings({ schedule: d.restSchedule, openBalanceCents: null, matchedCents: 0n }),
    ...planWarnings({ schedule: d.schedule, openBalanceCents: d.billsOpenCents, matchedCents: d.matchedCents }).filter((w) => w.code === 'bill_balance_mismatch'),
  ];
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

// ---------- previews (read only) ----------

/** What a form would save, worked out with the same pure functions as the write. Nothing is written, locked or audited. */
export interface PlanPreview {
  rows: Array<{ dueDate: string; amountCents: string; kept: boolean }>;
  totalCents: string; count: number; keptCount: number; newCount: number; newCents: string;
  warnings: PlanWarning[]; notes: string[];
}

function previewOf(schedule: Schedule, restSchedule: Schedule, warnings: PlanWarning[], notes: string[]): PlanPreview {
  const fresh = schedule.lines.filter((l) => !l.keepFrom);
  return {
    rows: schedule.lines.map((l) => ({ dueDate: l.dueDate, amountCents: cents(l.amountCents), kept: l.keepFrom !== undefined })),
    totalCents: cents(schedule.totalCents), count: schedule.lines.length, keptCount: schedule.lines.length - fresh.length, newCount: fresh.length,
    newCents: cents(restSchedule.totalCents), warnings, notes,
  };
}

/**
 * The schedule creating a plan would save, from the same form fields (a `bill_<id>` tick per bill). An invalid schedule throws the
 * same AppError the save would. Cash that would be matched on save is worked out read-only with the same fill, so the warnings agree.
 */
export async function previewNewPlan(pool: Pool, actor: Actor, raw: unknown): Promise<PlanPreview> {
  authorize(actor, 'expenses:write');
  const d = parse(createPlanPreviewSchema, raw);
  const { billIds = [] } = (withBillChecks(raw) ?? {}) as { billIds?: string[] };
  const schedule = buildSchedule(d);
  const startedOn = d.startedOn ?? todayUtc();
  if (startedOn > todayUtc()) throw new AppError('invalid_input', 'The plan start date cannot be in the future');
  const notes: string[] = [];
  let openBalanceCents: bigint | null = null;
  let matchedCents = 0n;
  const bills = billIds.length > 0 ? await expenseRepo.getBills(pool, actor.householdId, billIds) : [];
  if (billIds.length === 0 || bills.length !== billIds.length) notes.push('Tick the bills the plan covers to compare the plan with what they owe.');
  else {
    openBalanceCents = sum(bills.map((b) => BigInt(b.openBalanceCents)));
    if (d.matchExisting) {
      const sources = (await payments.listUnmatchedAllocations(pool, actor.householdId, billIds)).filter((r) => r.paidOn >= startedOn)
        .map((r) => ({ allocationId: r.allocationId, paymentId: r.paymentId, billId: r.billId, free: BigInt(r.netCents) - BigInt(r.matchedCents) }));
      matchedCents = sum(fillInstallments(sources, schedule.lines.map((l, i) => ({ id: String(i), left: l.amountCents }))).map((f) => f.amount));
      if (matchedCents > 0n) notes.push(`${formatCents(matchedCents)} of payments already applied to these bills would be matched to the earliest installments when the plan is created.`);
    }
  }
  return previewOf(schedule, schedule, planWarnings({ schedule, matchedCents, openBalanceCents }), notes);
}

/**
 * The schedule a revision would save for this plan, including kept paid installments (shown first, marked kept) and the refusals the
 * save would make (total below what is matched, nothing left to restart, too many installments). Nothing is written.
 */
export async function previewPlanRevision(pool: Pool, actor: Actor, planId: string, raw: unknown): Promise<PlanPreview> {
  authorize(actor, 'expenses:write');
  const { reviseMode, ...rest } = parse(schedulePreviewSchema, raw);
  const restSchedule = buildSchedule(rest);
  const id = parse(schemas.id, planId);
  const plan = await repo.getPlan(pool, actor.householdId, id, todayUtc());
  if (!plan) throw new AppError('not_found');
  if (plan.status !== 'active') throw new AppError('conflict', 'That plan was cancelled');
  const cur = (await repo.currentRevision(pool, actor.householdId, id))!;
  const matched = sum((await repo.currentMatchPairs(pool, actor.householdId, id)).map((p) => p.cents));
  let kept: KeptInstallment[] = [];
  let currentCount = 0;
  if (reviseMode === 'keep_paid') {
    const current = await repo.listInstallments(pool, actor.householdId, cur.id, todayUtc());
    currentCount = current.length;
    kept = keptInstallments(current);
  }
  const schedule = composeRevision({ restSchedule, kept, reviseMode, currentCount, matchedCents: matched });
  const bills = await expenseRepo.getBills(pool, actor.householdId, await repo.planBillIds(pool, actor.householdId, id));
  const warnings = revisionWarnings({ restSchedule, schedule, billsOpenCents: sum(bills.map((b) => BigInt(b.openBalanceCents))), matchedCents: matched });
  return previewOf(schedule, restSchedule, warnings, []);
}

// ---------- a plan already in progress (one guided form, one save) ----------

/** A restructure of an in-progress plan: the rest is scheduled again from `restartOn`, `amountCents` per installment, at `cadence`. */
export interface InProgressRestructure { restartOn: string; amountCents: bigint; cadence: 'weekly' | 'biweekly' | 'monthly' }

export interface InProgressComposition {
  original: Schedule;
  /** The existing cash the original schedule would take (slot ids are line indexes), and what each original line would hold. */
  fill: FillMatch[]; lineMatched: bigint[]; matchedCents: bigint;
  /** The fully paid original lines a restructure keeps (ids are line indexes; empty without a restructure). */
  kept: KeptInstallment[];
  /** The generated schedule for the unpaid rest (null without a restructure), and the plan as it would stand after the save. */
  rest: Schedule | null; final: Schedule; warnings: PlanWarning[];
  /** Matched cash on lines that are not fully paid: it would move onto the new schedule in date order. */
  looseMatchedCents: bigint;
}

/**
 * Pure. Everything "Add a plan that's already in progress" decides, from the original schedule, the cash already applied to the bills
 * (from the start date on) and the optional restructure: which installments the cash fills, which are then fully paid and kept, the
 * total still to schedule (original total minus the kept installments, never typed), the new rest, the plan as saved and its warnings.
 * The preview and the save both call this, so what the preview shows is what the save writes. The refusals are `conflict`, since they
 * depend on the cash: nothing fully paid to keep, everything already paid, a restart date before the last kept installment, and
 * the caps `composeRevision` checks.
 */
export function composeInProgress(d: { original: Schedule; sources: FillSource[]; restructure: InProgressRestructure | null; openBalanceCents: bigint | null }): InProgressComposition {
  const { original } = d;
  const fill = fillLines(d.sources, original.lines);
  const lineMatched = original.lines.map(() => 0n);
  for (const f of fill) lineMatched[Number(f.installmentId)]! += f.amount;
  const matchedCents = sum(lineMatched);
  const whole = { original, fill, lineMatched, matchedCents };
  const originalWarnings = planWarnings({ schedule: original, openBalanceCents: d.openBalanceCents, matchedCents });
  if (!d.restructure) return { ...whole, kept: [], rest: null, final: original, warnings: originalWarnings, looseMatchedCents: 0n };
  const kept = keptInstallments(original.lines.map((l, i) => ({ id: String(i), dueDate: l.dueDate, amountCents: l.amountCents.toString(), unpaidCents: (l.amountCents - lineMatched[i]!).toString() })));
  if (kept.length === 0) throw new AppError('conflict', 'No installment is fully paid after matching your payments, so there is nothing to keep. Check the start date and that the payments are applied to these bills, or enter the plan with its new terms instead');
  if (kept.length === original.lines.length) throw new AppError('conflict', 'Every installment is already paid, so there is nothing left to restart');
  const lastKeptDue = kept.reduce((a, k) => (k.dueDate > a ? k.dueDate : a), '');
  if (d.restructure.restartOn < lastKeptDue) throw new AppError('conflict', `The restart date cannot be before the last kept installment's due date (${lastKeptDue})`);
  const keptCents = sum(kept.map((k) => k.amountCents));
  const rest = buildSchedule({
    cadence: d.restructure.cadence, totalAmount: original.totalCents - keptCents, installmentCount: null, firstDueDate: d.restructure.restartOn,
    inputMode: 'per_installment', installmentAmount: d.restructure.amountCents,
  });
  const final = composeRevision({ restSchedule: rest, kept, reviseMode: 'keep_paid', currentCount: original.lines.length, matchedCents });
  // What was typed for the original (a total that did not agree, rounding) plus the whole plan's comparison with the bills.
  const warnings = [...originalWarnings.filter((w) => w.code !== 'bill_balance_mismatch'), ...revisionWarnings({ restSchedule: rest, schedule: final, billsOpenCents: d.openBalanceCents, matchedCents })];
  return { ...whole, kept, rest, final, warnings, looseMatchedCents: matchedCents - keptCents };
}

/** What the "already in progress" form would save: the original schedule with what existing cash fills, and the plan as it would stand. Nothing is written. */
export interface ProgressPreview {
  original: { rows: Array<{ dueDate: string; amountCents: string; matchedCents: string; state: 'paid' | 'partial' | 'unpaid' }>; totalCents: string; matchedCents: string };
  restructured: boolean;
  /** The total still to schedule after the kept installments (null without a restructure). */
  stillToScheduleCents: string | null;
  plan: PlanPreview;
}

/** The restructure of an in-progress form, or null when "No" is chosen (the restart fields are then ignored). A missing field is the sentence to show. */
function progressRestructure(d: { restructured?: boolean; restartOn: string | null; restartAmount: bigint | null; restartCadence: 'weekly' | 'biweekly' | 'monthly'; reason: string }): InProgressRestructure | null {
  if (!d.restructured) return null;
  if (d.restartOn === null || d.restartAmount === null) throw new AppError('invalid_input', 'Give the restart date and the amount per installment, or choose "No" for the restructure');
  if (d.reason === '') throw new AppError('invalid_input', 'Give the reason the plan was restructured');
  return { restartOn: d.restartOn, amountCents: d.restartAmount, cadence: d.restartCadence };
}

/**
 * The plan "Add a plan already in progress" would save, from the same form fields (a `bill_<id>` tick per bill), worked out by
 * `composeInProgress` with the same read of unmatched cash as the save (read only here: no lock, no write, no audit). An invalid
 * form throws the same AppError the save would.
 */
export async function previewPlanInProgress(pool: Pool, actor: Actor, raw: unknown): Promise<ProgressPreview> {
  authorize(actor, 'expenses:write');
  const d = parse(createPlanInProgressPreviewSchema, raw);
  const { billIds = [] } = (withBillChecks(raw) ?? {}) as { billIds?: string[] };
  const original = buildSchedule(d);
  if (d.startedOn === null) throw new AppError('invalid_input', 'Enter the date the plan started');
  if (d.startedOn > todayUtc()) throw new AppError('invalid_input', 'The plan start date cannot be in the future');
  const restructure = progressRestructure(d);
  const notes: string[] = [];
  const bills = billIds.length > 0 ? await expenseRepo.getBills(pool, actor.householdId, billIds) : [];
  const known = billIds.length > 0 && bills.length === billIds.length;
  if (!known) notes.push('Tick the bills the plan covers to match your payments and to compare the plan with what they owe.');
  const sources = known && d.matchExisting ? await unmatchedCash(pool, actor, billIds, null, d.startedOn) : [];
  const c = composeInProgress({ original, sources, restructure, openBalanceCents: known ? sum(bills.map((b) => BigInt(b.openBalanceCents))) : null });
  if (c.matchedCents > 0n) notes.push(`${formatCents(c.matchedCents)} of payments already applied to these bills would be matched to the earliest installments of the original schedule.`);
  if (c.looseMatchedCents > 0n) notes.push(`${formatCents(c.looseMatchedCents)} of payments only partly fill an installment, so they would move onto the new schedule in date order.`);
  const rows = original.lines.map((l, i) => ({
    dueDate: l.dueDate, amountCents: cents(l.amountCents), matchedCents: cents(c.lineMatched[i]!),
    state: c.lineMatched[i]! >= l.amountCents ? 'paid' as const : c.lineMatched[i]! > 0n ? 'partial' as const : 'unpaid' as const,
  }));
  return {
    original: { rows, totalCents: cents(original.totalCents), matchedCents: cents(c.matchedCents) }, restructured: restructure !== null,
    stillToScheduleCents: c.rest === null ? null : cents(c.rest.totalCents),
    plan: previewOf(c.final, c.rest ?? c.final, c.warnings, notes),
  };
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

/** A source of unmatched cash with what the suggestion list shows about it. */
export type CashSource = FillSource & { paidOn: string; netCents: string };

/**
 * Reads the unmatched allocations of payments made on or after `since` (UTC date). With `locked` (the write path) a payment that appeared
 * after the locks were taken restarts the transaction; without it (the read-only suggestions) there is nothing to restart.
 */
async function unmatchedCash(tx: Queryable, actor: Actor, billIds: string[], locked: Set<string> | null, since: string): Promise<CashSource[]> {
  const rows = await payments.listUnmatchedAllocations(tx, actor.householdId, billIds);
  if (locked && rows.some((r) => !locked.has(r.paymentId))) throw new RetryTransaction();
  return rows.filter((r) => r.paidOn >= since).map((r) => ({
    allocationId: r.allocationId, paymentId: r.paymentId, billId: r.billId, free: BigInt(r.netCents) - BigInt(r.matchedCents), paidOn: r.paidOn, netCents: r.netCents,
  }));
}

/** Everything the fill of an existing plan reads: the same inputs for the read-only suggestions and for the writes that apply them. */
interface FillInputs { revisionId: string; revisionNo: number; startedOn: string; open: repo.Installment[]; sources: CashSource[] }

async function fillInputs(tx: Queryable, actor: Actor, planId: string, billIds: string[], locked: Set<string> | null): Promise<FillInputs> {
  const asOf = todayUtc();
  const plan = (await repo.getPlan(tx, actor.householdId, planId, asOf))!;
  const cur = (await repo.currentRevision(tx, actor.householdId, planId))!;
  const open = (await repo.listInstallments(tx, actor.householdId, cur.id, asOf)).filter((i) => BigInt(i.unpaidCents) > 0n);
  return { revisionId: cur.id, revisionNo: cur.revisionNo, startedOn: plan.startedOn, open, sources: await unmatchedCash(tx, actor, billIds, locked, plan.startedOn) };
}

/** Pure given the inputs: the one place the existing-cash fill is computed for a plan, used by the suggestions, the bulk match and the apply. */
const fillOf = (i: FillInputs): FillMatch[] => fillInstallments(i.sources, i.open.map((x) => ({ id: x.id, left: BigInt(x.unpaidCents) })));

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

/** Pure. Pairs unmatched cash with the lines of a schedule not yet saved; a slot id is the line's index, spelled as text. */
const fillLines = (sources: FillSource[], lines: ScheduleLine[]): FillMatch[] => fillInstallments(sources, lines.map((l, i) => ({ id: String(i), left: l.amountCents })));

/** The bills a new plan covers, locked and checked (payments first when existing cash is matched, then the bills): the first half of every plan creation. */
interface CreateScope { lockedPayments: Set<string>; locks: Awaited<ReturnType<typeof expenseRepo.lockBills>>; providerIds: string[]; openBalanceCents: bigint }

async function lockCreateScope(tx: Queryable, actor: Actor, billIds: string[], matchExisting: boolean): Promise<CreateScope> {
  const lockedPayments = matchExisting ? await lockBillPayments(tx, actor, billIds) : new Set<string>();
  const locks = await expenseRepo.lockBills(tx, actor.householdId, billIds);
  if (locks.length !== billIds.length) throw new AppError('not_found');
  // The bills may come from several providers (a hospital often bills one visit under different names). A plan has no provider
  // of its own; every provider behind the bills must still be active.
  const providerIds = [...new Set(locks.map((b) => b.providerId))].sort();
  for (const pid of providerIds) await requireActive(tx, 'providers', actor.householdId, pid);
  for (const b of locks) {
    if (b.amountStatus !== 'confirmed') throw new AppError('conflict', 'A plan can only cover bills with confirmed amounts');
  }
  return { lockedPayments, locks, providerIds, openBalanceCents: sum(locks.map((b) => b.baseResponsibilityCents + b.adjustmentsCents - b.appliedCents)) };
}

/**
 * The second half of every plan creation, inside the caller's transaction and under the locks of `lockCreateScope`: the plan, its bills,
 * revision 1, the matches of `fill` (slot ids are line indexes) and the `plan.created` audit event. `createPlan` and
 * `createPlanInProgress` both call it, so a plan entered in one step is recorded exactly like a plan entered in several.
 */
async function writeNewPlan(tx: Queryable, actor: Actor, requestId: string, c: {
  id: string; name: string; billIds: string[]; startedOn: string; schedule: Schedule; remainder: Remainder | undefined; matchExisting: boolean; scope: CreateScope; fill: FillMatch[];
}): Promise<{ revisionId: string; installments: Array<ScheduleLine & { id: string }> }> {
  const { id, schedule, scope, fill } = c;
  await repo.insertPlan(tx, { id, householdId: actor.householdId, userId: actor.userId, name: c.name, startedOn: c.startedOn });
  for (const b of [...c.billIds].sort()) await repo.insertPlanBill(tx, actor.householdId, id, b);
  const revisionId = randomUUID();
  const installments = schedule.lines.map((l) => ({ id: randomUUID(), ...l }));
  await repo.insertRevision(tx, {
    id: revisionId, householdId: actor.householdId, userId: actor.userId, planId: id, revisionNo: 1, totalCents: schedule.totalCents, cadence: schedule.cadence,
    reason: 'Initial schedule', installments,
  });
  // Optionally reference cash that was already applied to these bills. Nothing is created or moved: only match rows are added.
  await insertFill(tx, actor, id, revisionId, fill.map((f) => ({ ...f, installmentId: installments[Number(f.installmentId)]!.id })), 'Matched an existing payment when the plan was created');
  await recordAudit(tx, {
    householdId: actor.householdId, actorUserId: actor.userId, action: 'plan.created', entityType: 'payment_plan', entityId: id, requestId,
    detail: {
      planId: id, providerIds: scope.providerIds.join(','), providerCount: scope.providerIds.length, billCount: c.billIds.length, totalCents: cents(schedule.totalCents), cadence: schedule.cadence,
      installmentCount: schedule.lines.length, firstDueDate: schedule.lines[0]!.dueDate, lastDueDate: schedule.lines[schedule.lines.length - 1]!.dueDate,
      scopeOpenBalanceCents: cents(scope.openBalanceCents),
      startedOn: c.startedOn, matchExisting: c.matchExisting, matchedExistingCents: cents(sum(fill.map((f) => f.amount))), matchedExistingAllocations: new Set(fill.map((f) => f.source.allocationId)).size,
      inputMode: schedule.inputMode, remainder: remainderUsed(schedule.inputMode, c.remainder), expectedTotalCents: schedule.expectedTotalCents === null ? null : cents(schedule.expectedTotalCents), computedTotalCents: cents(schedule.totalCents),
      warningCodes: planWarnings({ schedule, matchedCents: sum(fill.map((f) => f.amount)), openBalanceCents: scope.openBalanceCents }).map((w) => w.code).join(','),
    },
  });
  return { revisionId, installments };
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
    const scope = await lockCreateScope(tx, actor, d.billIds, !!d.matchExisting);
    const fill = d.matchExisting ? fillLines(await unmatchedCash(tx, actor, d.billIds, scope.lockedPayments, startedOn), schedule.lines) : [];
    await writeNewPlan(tx, actor, requestId, { id, name: d.name, billIds: d.billIds, startedOn, schedule, remainder: d.remainder, matchExisting: !!d.matchExisting, scope, fill });
    return { id, replayed: false };
  }));
}

/**
 * The write half of every revision, inside the caller's transaction with the plan locked: the new immutable revision, the matches carried
 * onto it and the `plan.revised` audit event. `kept` and `restSchedule` are decided by the caller (`revisePlan` reads the kept installments
 * under its plan lock; `createPlanInProgress` composes them before it writes anything), so the revision is saved the same way for both.
 */
async function writeRevision(tx: Queryable, actor: Actor, requestId: string, c: {
  planId: string; revisionId: string; reason: string; reviseMode: 'replace' | 'keep_paid'; restSchedule: Schedule; remainder: Remainder | undefined; kept: KeptInstallment[]; currentCount: number;
}): Promise<void> {
  const { planId, revisionId, reason, reviseMode, restSchedule, kept } = c;
  const cur = (await repo.currentRevision(tx, actor.householdId, planId))!;
  const before = await repo.getPlan(tx, actor.householdId, planId, todayUtc());
  const pairs = await repo.currentMatchPairs(tx, actor.householdId, planId);
  const matched = sum(pairs.map((p) => p.cents));
  const schedule = composeRevision({ restSchedule, kept, reviseMode, currentCount: c.currentCount, matchedCents: matched });
  const installments = schedule.lines.map((l) => ({ id: randomUUID(), ...l }));
  const carried = carryMatches(pairs, installments);
  const keptCents = sum(kept.map((k) => k.amountCents));
  const planBills = await expenseRepo.getBills(tx, actor.householdId, await repo.planBillIds(tx, actor.householdId, planId));
  const revisionWarningList = revisionWarnings({ restSchedule, schedule, billsOpenCents: sum(planBills.map((b) => BigInt(b.openBalanceCents))), matchedCents: matched });
  const revisionNo = cur.revisionNo + 1;
  await repo.insertRevision(tx, {
    id: revisionId, householdId: actor.householdId, userId: actor.userId, planId, revisionNo, totalCents: schedule.totalCents, cadence: schedule.cadence, reason, installments,
  });
  for (const m of carried) {
    await repo.insertMatch(tx, {
      id: randomUUID(), householdId: actor.householdId, userId: actor.userId, planId, revisionId, installmentId: installments[m.installmentIndex]!.id,
      paymentId: m.pair.paymentId, allocationId: m.pair.allocationId, billId: m.pair.billId, kind: 'match', amountCents: m.amount, carried: true,
      reason: m.keptFrom ? `Kept from revision ${cur.revisionNo}` : `Carried forward from revision ${cur.revisionNo}`,
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
      inputMode: restSchedule.inputMode, remainder: remainderUsed(restSchedule.inputMode, c.remainder), expectedTotalCents: restSchedule.expectedTotalCents === null ? null : cents(restSchedule.expectedTotalCents), computedTotalCents: cents(restSchedule.totalCents),
      warningCodes: revisionWarningList.map((w) => w.code).join(','),
    },
  });
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
    // Fully paid installments are read under the lock, so what is kept is exactly what is paid when the revision is written.
    let kept: KeptInstallment[] = [];
    let currentCount = 0;
    if (reviseMode === 'keep_paid') {
      const current = await repo.listInstallments(tx, actor.householdId, cur.id, todayUtc());
      currentCount = current.length;
      kept = keptInstallments(current);
    }
    await writeRevision(tx, actor, requestId, { planId, revisionId, reason, reviseMode, restSchedule, remainder: rest.remainder, kept, currentCount });
    return { id: planId, replayed: false };
  }));
}

/**
 * "Add a plan that's already in progress": one guided form, one save. Creates the plan with its original agreement (revision 1), matches
 * the payments already applied to its bills and, when the plan was restructured, saves revision 2 (the fully paid installments kept as
 * they are, the rest scheduled again from the restart date) in ONE transaction under ONE idempotency key. Locks run in the global order,
 * payments (those on the ticked bills, when matching), then bills; the plan row is new, so no plan lock is waited for. Everything is decided
 * by `composeInProgress` before the first write, so a refusal writes nothing, and the writes are the ones `createPlan` and `revisePlan`
 * make (`writeNewPlan`, `writeRevision`): the audit trail holds `plan.created` and `plan.revised` as the separate steps would
 * record them, then one `plan.created_in_progress` summary (ids, counts and cents, no free text). The reason is stored only on the revision.
 */
export async function createPlanInProgress(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string; replayed: boolean }> {
  authorize(actor, 'expenses:write');
  const { csrf: _csrf, idempotencyKey, ...d } = parse(paymentSchemas.createPlanInProgress, withBillChecks(input));
  const original = buildSchedule(d);
  if (d.startedOn > todayUtc()) throw new AppError('invalid_input', 'The plan start date cannot be in the future');
  const restructure = progressRestructure(d);
  const reason = restructure ? d.reason : '';
  const id = randomUUID();
  const revisionId = randomUUID();
  // The logical input only (never anything read from the database), so a replay after the cash changed is still a replay.
  const fingerprint = {
    name: d.name, billIds: [...d.billIds].sort(), startedOn: d.startedOn, matchExisting: !!d.matchExisting, lines: original.lines, cadence: original.cadence,
    expectedTotalCents: original.expectedTotalCents === null ? null : cents(original.expectedTotalCents), restructure, reason,
  };
  return withRetry(() => withTransaction(pool, async (tx) => {
    const replayId = await idempotent(tx, actor, 'plan.create_in_progress', idempotencyKey, fingerprint, id);
    if (replayId) return { id: replayId, replayed: true };
    const scope = await lockCreateScope(tx, actor, d.billIds, !!d.matchExisting);
    const sources = d.matchExisting ? await unmatchedCash(tx, actor, d.billIds, scope.lockedPayments, d.startedOn) : [];
    const c = composeInProgress({ original, sources, restructure, openBalanceCents: scope.openBalanceCents });
    const created = await writeNewPlan(tx, actor, requestId, { id, name: d.name, billIds: d.billIds, startedOn: d.startedOn, schedule: original, remainder: d.remainder, matchExisting: !!d.matchExisting, scope, fill: c.fill });
    if (c.rest) {
      // The database checks every new match at commit ("only the current schedule of an active plan"). Revision 2 makes revision 1 stale, so the
      // matches just written are checked now, while revision 1 is still the current one; revision 2's carried matches are then checked as they are written.
      await tx.query('set constraints installment_matches_guard immediate');
      const kept = c.kept.map((k) => ({ ...k, id: created.installments[Number(k.id)]!.id }));
      await writeRevision(tx, actor, requestId, { planId: id, revisionId, reason, reviseMode: 'keep_paid', restSchedule: c.rest, remainder: undefined, kept, currentCount: original.lines.length });
    }
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'plan.created_in_progress', entityType: 'payment_plan', entityId: id, requestId,
      detail: {
        planId: id, billCount: d.billIds.length, startedOn: d.startedOn, matchExisting: !!d.matchExisting, matchedCents: cents(c.matchedCents), matchedAllocations: new Set(c.fill.map((f) => f.source.allocationId)).size,
        originalTotalCents: cents(original.totalCents), originalInstallmentCount: original.lines.length, restructured: restructure !== null,
        keptInstallmentCount: c.kept.length, keptCents: cents(sum(c.kept.map((k) => k.amountCents))), restCents: c.rest ? cents(c.rest.totalCents) : null, restInstallmentCount: c.rest ? c.rest.lines.length : null,
        restartOn: restructure ? restructure.restartOn : null, finalTotalCents: cents(c.final.totalCents), finalInstallmentCount: c.final.lines.length,
      },
    });
    return { id, replayed: false };
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
    if (plan.version !== d.version) throw new AppError('stale_version');
    if (plan.status !== 'active') throw new AppError('conflict', 'That plan was cancelled');
    const inputs = await fillInputs(tx, actor, d.planId, billIds, locked);
    const fill = fillOf(inputs);
    if (fill.length === 0) throw new AppError('conflict', 'There is no unmatched payment cash, or nothing left owed on the schedule');
    await insertFill(tx, actor, d.planId, inputs.revisionId, fill, 'Matched an existing payment in bulk');
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'plan.existing_payments_matched', entityType: 'payment_plan', entityId: d.planId, requestId,
      detail: {
        planId: d.planId, startedOn: inputs.startedOn, revisionNo: inputs.revisionNo, matchCount: fill.length, allocationCount: new Set(fill.map((f) => f.source.allocationId)).size,
        installmentCount: new Set(fill.map((f) => f.installmentId)).size, matchedCents: cents(sum(fill.map((f) => f.amount))),
      },
    });
    return { id: d.planId, replayed: false };
  }));
}

// ---------- suggested matches (read, then apply the rows the person kept) ----------

/** One suggested match, as the plan page shows it. The ids and the amount are what the apply checks against a fresh computation. */
export interface SuggestedMatch {
  installmentId: string; installmentSeq: number; dueDate: string; installmentUnpaidCents: string;
  allocationId: string; paymentId: string; paidOn: string; paymentAmountCents: string; billId: string;
  amountCents: string; why: string;
}

const DAY_MS = 86_400_000;
const NEAR_DAYS = 7;
const dayNumber = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);

/**
 * Pure. Why a pair was suggested: always the fill order (oldest unmatched payment onto the earliest installment that still owes), and
 * when the match is exactly what the installment still owes and the payment was made within seven days of the due date, that too.
 */
export function suggestionWhy(v: { dueDate: string; paidOn: string; amountCents: bigint; installmentUnpaidCents: bigint }): string {
  const near = Math.abs(dayNumber(v.paidOn) - dayNumber(v.dueDate)) <= NEAR_DAYS;
  if (near && v.amountCents === v.installmentUnpaidCents) return 'Same amount, paid near the due date';
  return 'Oldest unmatched payment, earliest unpaid installment';
}

/**
 * What "Match selected" on the plan page offers: the same fill the bulk match would apply, worked out read-only from the same inputs
 * (`fillInputs` and `fillOf`). Nothing is locked or written, so by the time a row is submitted it may be out of date; the apply
 * recomputes under the locks and refuses a row that no longer matches.
 */
export async function suggestPlanMatches(pool: Pool, actor: Actor, planId: string): Promise<SuggestedMatch[]> {
  authorize(actor, 'expenses:read');
  const id = parse(schemas.id, planId);
  const plan = await repo.getPlan(pool, actor.householdId, id, todayUtc());
  if (!plan) throw new AppError('not_found');
  if (plan.status !== 'active') return [];
  const billIds = await repo.planBillIds(pool, actor.householdId, id);
  if (billIds.length === 0) return [];
  const inputs = await fillInputs(pool, actor, id, billIds, null);
  const fill = fillOf(inputs);
  const byId = new Map(inputs.open.map((i) => [i.id, i]));
  const paymentIds = [...new Set(fill.map((f) => f.source.paymentId))];
  const amounts = new Map(await Promise.all(paymentIds.map(async (pid) => [pid, (await payments.getPayment(pool, actor.householdId, pid))?.amountCents ?? '0'] as const)));
  return fill.map((f) => {
    const inst = byId.get(f.installmentId)!;
    const source = f.source as CashSource;
    return {
      installmentId: inst.id, installmentSeq: inst.seq, dueDate: inst.dueDate, installmentUnpaidCents: inst.unpaidCents, allocationId: source.allocationId,
      paymentId: source.paymentId, paidOn: source.paidOn, paymentAmountCents: amounts.get(source.paymentId)!, billId: source.billId, amountCents: cents(f.amount),
      why: suggestionWhy({ dueDate: inst.dueDate, paidOn: source.paidOn, amountCents: f.amount, installmentUnpaidCents: BigInt(inst.unpaidCents) }),
    };
  });
}

/**
 * Applies the suggested matches the person left ticked. Locks the payments on the plan's bills, then the plan (the global order), and
 * recomputes the suggestions with the same fill; every submitted row must equal one of them (installment, allocation and amount) or the
 * whole request is refused with `conflict` and nothing is written. Subsets are fine: each row only ever takes part of what the fill
 * gave it. References only: no cash, allocation or bill balance changes. Match rows do not bump the plan version, as every match write.
 */
export async function applySuggestedMatches(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string; replayed: boolean }> {
  authorize(actor, 'expenses:write');
  const { csrf: _csrf, idempotencyKey, planId, version, rows } = parse(paymentSchemas.applySuggestedMatches, input);
  const sorted = rows.map((r) => ({ installmentId: r.installmentId, allocationId: r.allocationId, amount: r.amount }))
    .sort((a, b) => (a.installmentId === b.installmentId ? (a.allocationId < b.allocationId ? -1 : 1) : (a.installmentId < b.installmentId ? -1 : 1)));
  return withRetry(() => withTransaction(pool, async (tx) => {
    const replayId = await idempotent(tx, actor, 'plan.apply_suggestions', idempotencyKey, { planId, version, rows: sorted }, planId);
    if (replayId) return { id: replayId, replayed: true };
    const billIds = await repo.planBillIds(tx, actor.householdId, planId);
    if (billIds.length === 0) throw new AppError('not_found');
    const locked = await lockBillPayments(tx, actor, billIds);
    const [plan] = await repo.lockPlans(tx, actor.householdId, [planId]);
    if (!plan) throw new AppError('not_found');
    if (plan.removed) throw new AppError('conflict', REMOVED_MESSAGE);
    if (plan.version !== version) throw new AppError('stale_version');
    if (plan.status !== 'active') throw new AppError('conflict', 'That plan was cancelled');
    const inputs = await fillInputs(tx, actor, planId, billIds, locked);
    const current = new Map(fillOf(inputs).map((f) => [`${f.installmentId}:${f.source.allocationId}`, f]));
    const chosen: FillMatch[] = [];
    for (const r of sorted) {
      const f = current.get(`${r.installmentId}:${r.allocationId}`);
      if (!f || f.amount !== r.amount) throw new AppError('conflict', 'The suggestions changed; review them again');
      chosen.push(f);
    }
    await insertFill(tx, actor, planId, inputs.revisionId, chosen, 'Matched a suggested payment');
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'plan.suggestions_applied', entityType: 'payment_plan', entityId: planId, requestId,
      detail: {
        planId, revisionNo: inputs.revisionNo, suggestedCount: current.size, matchCount: chosen.length, skippedCount: current.size - chosen.length,
        allocationCount: new Set(chosen.map((f) => f.source.allocationId)).size, installmentCount: new Set(chosen.map((f) => f.installmentId)).size,
        matchedCents: cents(sum(chosen.map((f) => f.amount))), installmentIds: [...new Set(chosen.map((f) => f.installmentId))].join(','),
        allocationIds: [...new Set(chosen.map((f) => f.source.allocationId))].sort().join(','),
      },
    });
    return { id: planId, replayed: false };
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
  // Payments first (every payment the plan ever matched, which includes the released matches' payments), then the plan.
  const lock = await lockPlanWithPayments(tx, actor, planId);
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
  // A removed plan's matches counted as nothing while it was hidden, so the cash may have been matched to another plan since. Showing the
  // plan again counts them again: release, latest due date first, whatever an allocation no longer holds beyond its other matches (listed
  // with the skipped ones). This is how a cancelled plan, which keeps its matches as history, comes back; an active plan's matches were
  // released at removal, so for it nothing is left to release here.
  const cur = await repo.currentRevision(tx, actor.householdId, planId);
  const pairs = (await repo.currentMatchPairs(tx, actor.householdId, planId)).reverse();
  const byAllocation = new Map<string, typeof pairs>();
  for (const m of pairs) byAllocation.set(m.allocationId, [...(byAllocation.get(m.allocationId) ?? []), m]);
  for (const [allocationId, list] of [...byAllocation].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const alloc = await payments.getAllocation(tx, actor.householdId, allocationId);
    let excess = alloc ? BigInt(alloc.matchedCents) - BigInt(alloc.netCents) : sum(list.map((m) => m.cents));
    for (const m of list) {
      if (excess <= 0n) break;
      const take = m.cents < excess ? m.cents : excess;
      await repo.insertMatch(tx, {
        id: randomUUID(), householdId: actor.householdId, userId: actor.userId, planId, revisionId: cur!.id, installmentId: m.installmentId,
        paymentId: m.paymentId, allocationId, billId: m.billId, kind: 'unmatch', amountCents: -take, carried: false, reason: 'Released by undo because the cash is matched elsewhere',
      });
      skipped.push({ installmentId: m.installmentId, allocationId, cents: take });
      excess -= take;
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
