// SQL only for HSA eligibility decisions, claims, receipts and their entries. Every query is scoped by household_id; services own
// authorization, locking order, transactions and audit. Money columns come back as decimal strings of integer cents.
import type { Queryable } from '../db.ts';
import { decodeCursor, pageOf, type Page } from '../pagination.ts';
import type { HsaAllocationFilter, HsaClaimFilter, HsaScope } from '../validation.ts';

export type DecisionStatus = 'eligible' | 'ineligible' | 'pending';
export type HsaEntryKind = 'reserve' | 'receipt' | 'external_receipt' | 'receipt_reversal' | 'reject' | 'cancel';
export type LineStatus = 'submitted' | 'partially_fulfilled' | 'fulfilled' | 'rejected' | 'canceled' | 'reversed';

/** One payment allocation with its current decision and every reconciliation figure (see docs/ledger.md). */
export interface HsaAllocation {
  allocationId: string; paymentId: string; billId: string; paidOn: string; memberId: string; memberName: string; providerId: string;
  providerName: string; billLabel: string;
  /** Net cash held by the allocation after reversals and refunds. */
  netCents: string;
  decisionId: string | null; decisionStatus: DecisionStatus | null; decisionCount: number;
  /** Eligible cents the person decided on. The ceiling is the lesser of this and the net cash. */
  decidedCents: string;
  ceilingCents: string; pendingCents: string; receivedCents: string; availableCents: string; needsReviewCents: string;
}

const ALLOCATION_SELECT = `select s.allocation_id as "allocationId", s.payment_id as "paymentId", s.bill_id as "billId", s.paid_on::text as "paidOn",
    b.member_id as "memberId", m.name as "memberName", b.provider_id as "providerId", pr.name as "providerName",
    pr.name || coalesce(' ' || b.provider_reference, '') as "billLabel", s.net_cents::text as "netCents",
    s.decision_id as "decisionId", s.decision_status as "decisionStatus", s.decision_count as "decisionCount", s.decided_cents::text as "decidedCents",
    s.ceiling_cents::text as "ceilingCents", s.pending_cents::text as "pendingCents", s.received_cents::text as "receivedCents",
    s.available_cents::text as "availableCents", s.needs_review_cents::text as "needsReviewCents"
  from hsa_allocation_status s
  join bills b on b.household_id = s.household_id and b.id = s.bill_id
  join providers pr on pr.household_id = b.household_id and pr.id = b.provider_id
  join family_members m on m.household_id = b.household_id and m.id = b.member_id`;

export async function getAllocation(db: Queryable, householdId: string, id: string): Promise<HsaAllocation | null> {
  const { rows } = await db.query<HsaAllocation>(`${ALLOCATION_SELECT} where s.household_id = $1 and s.allocation_id = $2`, [householdId, id]);
  return rows[0] ?? null;
}

export async function getAllocations(db: Queryable, householdId: string, ids: string[]): Promise<HsaAllocation[]> {
  const { rows } = await db.query<HsaAllocation>(
    `${ALLOCATION_SELECT} where s.household_id = $1 and s.allocation_id = any($2::uuid[]) order by s.allocation_id`, [householdId, [...new Set(ids)].sort()]);
  return rows;
}

/** The payment behind each allocation. Allocation-to-payment links never change, so this probe is safe before the locks are taken. */
export async function allocationPayments(db: Queryable, householdId: string, ids: string[]): Promise<Array<{ allocationId: string; paymentId: string }>> {
  const { rows } = await db.query<{ allocationId: string; paymentId: string }>(
    `select id as "allocationId", payment_id as "paymentId" from payment_entries where household_id = $1 and kind = 'allocation' and id = any($2::uuid[])`,
    [householdId, [...new Set(ids)]]);
  return rows;
}

function scopeWhere(f: HsaScope & { state?: string }, params: unknown[]): string[] {
  const where = ['s.household_id = $1'];
  if (f.memberId) where.push(`b.member_id = $${params.push(f.memberId)}`);
  if (f.providerId) where.push(`b.provider_id = $${params.push(f.providerId)}`);
  if (f.from) where.push(`s.paid_on >= $${params.push(f.from)}`);
  if (f.to) where.push(`s.paid_on <= $${params.push(f.to)}`);
  switch (f.state) {
    case 'undecided': where.push(`s.net_cents > 0 and (s.decision_status is null or s.decision_status = 'pending')`); break;
    case 'eligible': where.push(`s.ceiling_cents > 0`); break;
    case 'available': where.push(`s.available_cents > 0`); break;
    case 'pending': where.push(`s.pending_cents > 0`); break;
    case 'received': where.push(`s.received_cents > 0`); break;
    case 'needs_review': where.push(`s.needs_review_cents > 0`); break;
    case 'ineligible': where.push(`s.decision_status = 'ineligible'`); break;
    default: break;
  }
  return where;
}

export async function listAllocations(db: Queryable, householdId: string, f: HsaAllocationFilter): Promise<Page<HsaAllocation>> {
  const params: unknown[] = [householdId];
  const where = scopeWhere(f, params);
  const cur = decodeCursor(f.cursor, 2);
  if (cur) where.push(`(s.paid_on, s.allocation_id) < ($${params.push(cur[0])}::date, $${params.push(cur[1])}::uuid)`);
  const { rows } = await db.query<HsaAllocation>(
    `${ALLOCATION_SELECT} where ${where.join(' and ')} order by s.paid_on desc, s.allocation_id desc limit $${params.push(f.limit + 1)}`, params);
  return pageOf(rows, f.limit, (r) => [r.paidOn, r.allocationId]);
}

/** Every allocation in scope, newest first, for exports. Fails closed when the scope is larger than `cap`. */
export async function allAllocations(db: Queryable, householdId: string, f: HsaScope, cap: number): Promise<HsaAllocation[] | null> {
  const params: unknown[] = [householdId];
  const where = scopeWhere(f, params);
  const { rows } = await db.query<HsaAllocation>(
    `${ALLOCATION_SELECT} where ${where.join(' and ')} order by s.paid_on desc, s.allocation_id desc limit $${params.push(cap + 1)}`, params);
  return rows.length > cap ? null : rows;
}

export interface HsaTotals {
  allocationCount: number; undecidedCount: number; needsReviewCount: number;
  eligibleCents: string; pendingCents: string; receivedCents: string; availableCents: string; needsReviewCents: string;
}

/** One statement, so every figure comes from the same snapshot. `eligibleCents` is the sum of ceilings (confirmed eligible net cash). */
export async function totals(db: Queryable, householdId: string, f: HsaScope): Promise<HsaTotals> {
  const params: unknown[] = [householdId];
  const where = scopeWhere(f, params);
  const { rows } = await db.query<HsaTotals>(
    `select count(*)::int as "allocationCount",
       (count(*) filter (where s.net_cents > 0 and (s.decision_status is null or s.decision_status = 'pending')))::int as "undecidedCount",
       (count(*) filter (where s.needs_review_cents > 0))::int as "needsReviewCount",
       coalesce(sum(s.ceiling_cents), 0)::text as "eligibleCents", coalesce(sum(s.pending_cents), 0)::text as "pendingCents",
       coalesce(sum(s.received_cents), 0)::text as "receivedCents", coalesce(sum(s.available_cents), 0)::text as "availableCents",
       coalesce(sum(s.needs_review_cents), 0)::text as "needsReviewCents"
     from hsa_allocation_status s join bills b on b.household_id = s.household_id and b.id = s.bill_id
     where ${where.join(' and ')}`, params);
  return rows[0]!;
}

// ---------- eligibility decisions ----------

export interface Decision {
  id: string; allocationId: string; status: DecisionStatus; eligibleCents: string; rationale: string; evidenceType: string | null;
  evidenceNote: string | null; contextNote: string; decidedOn: string; createdByName: string | null; createdAt: Date;
}

export async function listDecisions(db: Queryable, householdId: string, allocationId: string): Promise<Decision[]> {
  const { rows } = await db.query<Decision>(
    `select d.id, d.allocation_id as "allocationId", d.status, d.eligible_cents::text as "eligibleCents", d.rationale, d.evidence_type as "evidenceType",
       d.evidence_note as "evidenceNote", d.context_note as "contextNote", d.decided_on::text as "decidedOn", u.display_name as "createdByName", d.created_at as "createdAt"
     from hsa_eligibility_decisions d left join users u on u.id = d.created_by
     where d.household_id = $1 and d.allocation_id = $2 order by d.seq desc`, [householdId, allocationId]);
  return rows;
}

export async function insertDecision(db: Queryable, v: {
  id: string; householdId: string; userId: string; paymentId: string; allocationId: string; billId: string; status: DecisionStatus; eligibleCents: bigint;
  rationale: string; evidenceType: string | null; evidenceNote: string | null; contextNote: string; decidedOn: string;
}): Promise<void> {
  await db.query(
    `insert into hsa_eligibility_decisions (id, household_id, payment_id, allocation_id, bill_id, status, eligible_cents, rationale, evidence_type, evidence_note, context_note, decided_on, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [v.id, v.householdId, v.paymentId, v.allocationId, v.billId, v.status, v.eligibleCents.toString(), v.rationale, v.evidenceType, v.evidenceNote, v.contextNote, v.decidedOn, v.userId]);
}

// ---------- claims, receipts and entries ----------

export async function insertClaim(db: Queryable, v: { id: string; householdId: string; userId: string; submittedOn: string; administrator: string; reference: string | null; note: string }): Promise<void> {
  await db.query(`insert into hsa_claims (id, household_id, submitted_on, administrator, reference, note, created_by) values ($1, $2, $3, $4, $5, $6, $7)`,
    [v.id, v.householdId, v.submittedOn, v.administrator, v.reference, v.note, v.userId]);
}

export async function claimReferenceExists(db: Queryable, householdId: string, reference: string): Promise<boolean> {
  const { rows } = await db.query(`select 1 from hsa_claims where household_id = $1 and lower(reference) = lower($2)`, [householdId, reference]);
  return rows.length > 0;
}

export async function insertReceipt(db: Queryable, v: {
  id: string; householdId: string; userId: string; receivedOn: string; amountCents: bigint; origin: 'claim' | 'external'; source: string; reference: string | null;
  evidenceType: string | null; evidenceNote: string | null; note: string;
}): Promise<void> {
  await db.query(
    `insert into hsa_receipts (id, household_id, received_on, amount_cents, origin, source, reference, evidence_type, evidence_note, note, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [v.id, v.householdId, v.receivedOn, v.amountCents.toString(), v.origin, v.source, v.reference, v.evidenceType, v.evidenceNote, v.note, v.userId]);
}

export async function insertEntry(db: Queryable, v: {
  id: string; householdId: string; userId: string; paymentId: string; allocationId: string; billId: string; eventId: string; kind: HsaEntryKind;
  claimId: string | null; lineId: string | null; receiptId: string | null; reversesEntryId?: string | null; amountCents: bigint; effectiveDate: string; reason: string;
}): Promise<void> {
  await db.query(
    `insert into hsa_entries (id, household_id, payment_id, allocation_id, bill_id, event_id, kind, claim_id, line_id, receipt_id, reverses_entry_id, amount_cents, effective_date, reason, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [v.id, v.householdId, v.paymentId, v.allocationId, v.billId, v.eventId, v.kind, v.claimId, v.lineId, v.receiptId, v.reversesEntryId ?? null, v.amountCents.toString(), v.effectiveDate, v.reason, v.userId]);
}

/** A claim line: one reservation against one allocation, with the figures derived from its entries. */
export interface Line {
  lineId: string; claimId: string; allocationId: string; paymentId: string; billId: string; memberName: string; billLabel: string; paidOn: string;
  reservedCents: string; receivedGrossCents: string; reversedCents: string; rejectedCents: string; canceledCents: string;
  /** reserved - paid - rejected - canceled: what is still reserved. */
  pendingCents: string;
  /** Paid less reversed. */
  receivedCents: string;
  status: LineStatus;
}

const LINE_SELECT = `select x.*, x.reserved - x.gross - x.rejected - x.canceled as pending_raw from (
    select r.id as line_id, r.claim_id, r.allocation_id, r.payment_id, r.bill_id, r.amount_cents as reserved,
      coalesce(sum(e.amount_cents) filter (where e.kind = 'receipt'), 0)::bigint as gross,
      coalesce(sum(e.amount_cents) filter (where e.kind = 'receipt_reversal'), 0)::bigint as reversed,
      coalesce(sum(e.amount_cents) filter (where e.kind = 'reject'), 0)::bigint as rejected,
      coalesce(sum(e.amount_cents) filter (where e.kind = 'cancel'), 0)::bigint as canceled
    from hsa_entries r left join hsa_entries e on e.household_id = r.household_id and e.line_id = r.id and e.id <> r.id
    where r.household_id = $1 and r.kind = 'reserve' and %FILTER%
    group by r.id) x`;

interface LineRow {
  line_id: string; claim_id: string; allocation_id: string; payment_id: string; bill_id: string; reserved: string; gross: string; reversed: string;
  rejected: string; canceled: string; pending_raw: string; member_name: string; bill_label: string; paid_on: string;
}

function lineOf(r: LineRow): Line {
  const reserved = BigInt(r.reserved), gross = BigInt(r.gross), pending = BigInt(r.pending_raw), rejected = BigInt(r.rejected);
  // Status follows what is actually received (paid less reversed), so a fully reversed receipt never reads as fulfilled.
  const received = gross - BigInt(r.reversed);
  let status: LineStatus;
  if (pending > 0n) status = received > 0n ? 'partially_fulfilled' : 'submitted';
  else if (received === reserved) status = 'fulfilled';
  else if (received > 0n) status = 'partially_fulfilled';
  else if (rejected > 0n) status = 'rejected';
  else if (BigInt(r.canceled) > 0n) status = 'canceled';
  else status = 'reversed';
  return {
    lineId: r.line_id, claimId: r.claim_id, allocationId: r.allocation_id, paymentId: r.payment_id, billId: r.bill_id, memberName: r.member_name,
    billLabel: r.bill_label, paidOn: r.paid_on, reservedCents: r.reserved, receivedGrossCents: r.gross, reversedCents: r.reversed, rejectedCents: r.rejected,
    canceledCents: r.canceled, pendingCents: r.pending_raw, receivedCents: (gross - BigInt(r.reversed)).toString(), status,
  };
}

async function lines(db: Queryable, householdId: string, filter: string, extra: unknown[]): Promise<Line[]> {
  const { rows } = await db.query<LineRow>(
    `select y.line_id, y.claim_id, y.allocation_id, y.payment_id, y.bill_id, y.reserved::text, y.gross::text, y.reversed::text, y.rejected::text, y.canceled::text,
       y.pending_raw::text, m.name as member_name, pr.name || coalesce(' ' || b.provider_reference, '') as bill_label, p.paid_on::text as paid_on
     from (${LINE_SELECT.replace('%FILTER%', filter)}) y
     join bills b on b.household_id = $1 and b.id = y.bill_id
     join providers pr on pr.household_id = b.household_id and pr.id = b.provider_id
     join family_members m on m.household_id = b.household_id and m.id = b.member_id
     join payments p on p.household_id = $1 and p.id = y.payment_id
     order by p.paid_on desc, y.allocation_id, y.line_id`, [householdId, ...extra]);
  return rows.map(lineOf);
}

export const linesOfClaim = (db: Queryable, householdId: string, claimId: string) => lines(db, householdId, 'r.claim_id = $2', [claimId]);
export const linesOfAllocation = (db: Queryable, householdId: string, allocationId: string) => lines(db, householdId, 'r.allocation_id = $2', [allocationId]);
export const linesById = (db: Queryable, householdId: string, ids: string[]) => lines(db, householdId, 'r.id = any($2::uuid[])', [[...new Set(ids)]]);

export interface Claim {
  id: string; submittedOn: string; administrator: string; reference: string | null; note: string; createdByName: string | null; createdAt: Date;
  lineCount: number; reservedCents: string; pendingCents: string; receivedCents: string; open: boolean;
}

const CLAIM_SELECT = `select c.id, c.submitted_on::text as "submittedOn", c.administrator, c.reference, c.note, u.display_name as "createdByName", c.created_at as "createdAt",
    a.lines as "lineCount", a.reserved::text as "reservedCents", a.pending::text as "pendingCents", a.received::text as "receivedCents", (a.pending > 0) as open
  from hsa_claims c left join users u on u.id = c.created_by
  cross join lateral (select (count(*) filter (where e.kind = 'reserve'))::int as lines,
      coalesce(sum(e.amount_cents) filter (where e.kind = 'reserve'), 0)::bigint as reserved,
      (coalesce(sum(e.amount_cents) filter (where e.kind = 'reserve'), 0) - coalesce(sum(e.amount_cents) filter (where e.kind in ('receipt', 'reject', 'cancel')), 0))::bigint as pending,
      (coalesce(sum(e.amount_cents) filter (where e.kind = 'receipt'), 0) - coalesce(sum(e.amount_cents) filter (where e.kind = 'receipt_reversal' and e.line_id is not null), 0))::bigint as received
    from hsa_entries e where e.household_id = c.household_id and e.claim_id = c.id) a`;

export async function getClaim(db: Queryable, householdId: string, id: string): Promise<Claim | null> {
  const { rows } = await db.query<Claim>(`${CLAIM_SELECT} where c.household_id = $1 and c.id = $2`, [householdId, id]);
  return rows[0] ?? null;
}

export async function listClaims(db: Queryable, householdId: string, f: HsaClaimFilter): Promise<Page<Claim>> {
  const params: unknown[] = [householdId];
  const where = ['c.household_id = $1'];
  if (f.status === 'open') where.push('a.pending > 0');
  if (f.status === 'closed') where.push('a.pending = 0');
  const cur = decodeCursor(f.cursor, 2);
  if (cur) where.push(`(c.submitted_on, c.id) < ($${params.push(cur[0])}::date, $${params.push(cur[1])}::uuid)`);
  const { rows } = await db.query<Claim>(`${CLAIM_SELECT} where ${where.join(' and ')} order by c.submitted_on desc, c.id desc limit $${params.push(f.limit + 1)}`, params);
  return pageOf(rows, f.limit, (r) => [r.submittedOn, r.id]);
}

export interface Receipt {
  id: string; receivedOn: string; amountCents: string; origin: 'claim' | 'external'; source: string; reference: string | null; evidenceType: string | null;
  evidenceNote: string | null; note: string; createdByName: string | null; createdAt: Date; reversed: boolean; entryCount: number;
}

const RECEIPT_SELECT = `select r.id, r.received_on::text as "receivedOn", r.amount_cents::text as "amountCents", r.origin, r.source, r.reference, r.evidence_type as "evidenceType",
    r.evidence_note as "evidenceNote", r.note, u.display_name as "createdByName", r.created_at as "createdAt",
    exists (select 1 from hsa_entries x where x.household_id = r.household_id and x.receipt_id = r.id and x.kind = 'receipt_reversal') as reversed,
    (select count(*)::int from hsa_entries x where x.household_id = r.household_id and x.receipt_id = r.id and x.kind in ('receipt', 'external_receipt')) as "entryCount"
  from hsa_receipts r left join users u on u.id = r.created_by`;

export async function getReceipt(db: Queryable, householdId: string, id: string): Promise<Receipt | null> {
  const { rows } = await db.query<Receipt>(`${RECEIPT_SELECT} where r.household_id = $1 and r.id = $2`, [householdId, id]);
  return rows[0] ?? null;
}

export async function listReceipts(db: Queryable, householdId: string, f: { cursor?: string; limit: number }): Promise<Page<Receipt>> {
  const params: unknown[] = [householdId];
  const where = ['r.household_id = $1'];
  const cur = decodeCursor(f.cursor, 2);
  if (cur) where.push(`(r.received_on, r.id) < ($${params.push(cur[0])}::date, $${params.push(cur[1])}::uuid)`);
  const { rows } = await db.query<Receipt>(`${RECEIPT_SELECT} where ${where.join(' and ')} order by r.received_on desc, r.id desc limit $${params.push(f.limit + 1)}`, params);
  return pageOf(rows, f.limit, (r) => [r.receivedOn, r.id]);
}

export interface ReceiptEntry { id: string; kind: HsaEntryKind; paymentId: string; allocationId: string; billId: string; lineId: string | null; claimId: string | null; amountCents: bigint; reversed: boolean }

/** The receipt entries (not the reversals) of one receipt, with whether each was reversed. */
export async function receiptEntries(db: Queryable, householdId: string, receiptId: string): Promise<ReceiptEntry[]> {
  const { rows } = await db.query<{ id: string; kind: HsaEntryKind; payment_id: string; allocation_id: string; bill_id: string; line_id: string | null; claim_id: string | null; amount_cents: string; reversed: boolean }>(
    `select e.id, e.kind, e.payment_id, e.allocation_id, e.bill_id, e.line_id, e.claim_id, e.amount_cents::text,
       exists (select 1 from hsa_entries r where r.reverses_entry_id = e.id) as reversed
     from hsa_entries e where e.household_id = $1 and e.receipt_id = $2 and e.kind in ('receipt', 'external_receipt') order by e.seq`, [householdId, receiptId]);
  return rows.map((r) => ({ id: r.id, kind: r.kind, paymentId: r.payment_id, allocationId: r.allocation_id, billId: r.bill_id, lineId: r.line_id, claimId: r.claim_id, amountCents: BigInt(r.amount_cents), reversed: r.reversed }));
}

export interface EntryRow {
  id: string; seq: string; eventId: string; kind: HsaEntryKind; allocationId: string; claimId: string | null; lineId: string | null; receiptId: string | null;
  reversesEntryId: string | null; amountCents: string; effectiveDate: string; reason: string; createdByName: string | null; createdAt: Date;
  claimReference: string | null; memberName: string; billLabel: string; paymentId: string; paidOn: string;
}

const ENTRY_SELECT = `select e.id, e.seq::text, e.event_id as "eventId", e.kind, e.allocation_id as "allocationId", e.claim_id as "claimId", e.line_id as "lineId",
    e.receipt_id as "receiptId", e.reverses_entry_id as "reversesEntryId", e.amount_cents::text as "amountCents", e.effective_date::text as "effectiveDate", e.reason,
    u.display_name as "createdByName", e.created_at as "createdAt", c.reference as "claimReference", m.name as "memberName",
    pr.name || coalesce(' ' || b.provider_reference, '') as "billLabel", e.payment_id as "paymentId", p.paid_on::text as "paidOn"
  from hsa_entries e
  left join users u on u.id = e.created_by
  left join hsa_claims c on c.household_id = e.household_id and c.id = e.claim_id
  join bills b on b.household_id = e.household_id and b.id = e.bill_id
  join providers pr on pr.household_id = b.household_id and pr.id = b.provider_id
  join family_members m on m.household_id = b.household_id and m.id = b.member_id
  join payments p on p.household_id = e.household_id and p.id = e.payment_id`;

export async function listEntriesOfAllocation(db: Queryable, householdId: string, allocationId: string): Promise<EntryRow[]> {
  const { rows } = await db.query<EntryRow>(`${ENTRY_SELECT} where e.household_id = $1 and e.allocation_id = $2 order by e.seq`, [householdId, allocationId]);
  return rows;
}

export async function listEntriesOfClaim(db: Queryable, householdId: string, claimId: string): Promise<EntryRow[]> {
  const { rows } = await db.query<EntryRow>(`${ENTRY_SELECT} where e.household_id = $1 and e.claim_id = $2 order by e.seq`, [householdId, claimId]);
  return rows;
}

export async function listEntriesOfReceipt(db: Queryable, householdId: string, receiptId: string): Promise<EntryRow[]> {
  const { rows } = await db.query<EntryRow>(`${ENTRY_SELECT} where e.household_id = $1 and e.receipt_id = $2 order by e.seq`, [householdId, receiptId]);
  return rows;
}

/** Every entry of the allocations in scope, in ledger order, for exports. Fails closed above `cap`. */
export async function entriesInScope(db: Queryable, householdId: string, f: HsaScope, cap: number): Promise<EntryRow[] | null> {
  const params: unknown[] = [householdId];
  const where = ['e.household_id = $1'];
  if (f.memberId) where.push(`b.member_id = $${params.push(f.memberId)}`);
  if (f.providerId) where.push(`b.provider_id = $${params.push(f.providerId)}`);
  if (f.from) where.push(`p.paid_on >= $${params.push(f.from)}`);
  if (f.to) where.push(`p.paid_on <= $${params.push(f.to)}`);
  const { rows } = await db.query<EntryRow>(`${ENTRY_SELECT} where ${where.join(' and ')} order by e.seq limit $${params.push(cap + 1)}`, params);
  return rows.length > cap ? null : rows;
}

export interface ScopedDecision extends Decision { paymentId: string; paidOn: string; memberName: string; billLabel: string }

export async function decisionsInScope(db: Queryable, householdId: string, f: HsaScope, cap: number): Promise<ScopedDecision[] | null> {
  const params: unknown[] = [householdId];
  const where = ['d.household_id = $1'];
  if (f.memberId) where.push(`b.member_id = $${params.push(f.memberId)}`);
  if (f.providerId) where.push(`b.provider_id = $${params.push(f.providerId)}`);
  if (f.from) where.push(`p.paid_on >= $${params.push(f.from)}`);
  if (f.to) where.push(`p.paid_on <= $${params.push(f.to)}`);
  const { rows } = await db.query<ScopedDecision>(
    `select d.id, d.allocation_id as "allocationId", d.status, d.eligible_cents::text as "eligibleCents", d.rationale, d.evidence_type as "evidenceType",
       d.evidence_note as "evidenceNote", d.context_note as "contextNote", d.decided_on::text as "decidedOn", u.display_name as "createdByName", d.created_at as "createdAt",
       d.payment_id as "paymentId", p.paid_on::text as "paidOn", m.name as "memberName", pr.name || coalesce(' ' || b.provider_reference, '') as "billLabel"
     from hsa_eligibility_decisions d left join users u on u.id = d.created_by
     join bills b on b.household_id = d.household_id and b.id = d.bill_id
     join providers pr on pr.household_id = b.household_id and pr.id = b.provider_id
     join family_members m on m.household_id = b.household_id and m.id = b.member_id
     join payments p on p.household_id = d.household_id and p.id = d.payment_id
     where ${where.join(' and ')} order by d.seq limit $${params.push(cap + 1)}`, params);
  return rows.length > cap ? null : rows;
}

export interface HsaHistoryEvent {
  id: string; action: string; entityType: string; entityId: string | null; actorName: string | null; occurredAt: Date;
  detail: Record<string, string | number | boolean | null>;
}

/** Audit events about an allocation, a claim or a receipt, in audit sequence order (independent of clocks). */
export async function history(db: Queryable, householdId: string, key: 'allocationId' | 'claimId' | 'receiptId', id: string): Promise<HsaHistoryEvent[]> {
  const { rows } = await db.query<HsaHistoryEvent>(
    `select e.id::text, e.action, e.entity_type as "entityType", e.entity_id as "entityId", u.display_name as "actorName", e.occurred_at as "occurredAt", e.detail
     from audit_events e left join users u on u.id = e.actor_user_id
     where e.household_id = $1 and e.action like 'hsa.%' and e.detail ->> $2 = $3 order by e.id`, [householdId, key, id]);
  return rows;
}

/** Overview queue: allocations with something to act on, most urgent first. */
export async function queue(db: Queryable, householdId: string, kind: 'available' | 'needs_review', f: HsaScope, limit: number): Promise<HsaAllocation[]> {
  const params: unknown[] = [householdId];
  const where = scopeWhere({ ...f, state: kind }, params);
  const { rows } = await db.query<HsaAllocation>(
    `${ALLOCATION_SELECT} where ${where.join(' and ')} order by ${kind === 'available' ? 's.available_cents' : 's.needs_review_cents'} desc, s.paid_on desc, s.allocation_id desc limit $${params.push(limit)}`, params);
  return rows;
}
