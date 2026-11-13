// SQL only for payments, allocations, refunds and reversals. Every query is scoped by household_id; services own
// authorization, locking order, transactions and audit. Money columns come back as decimal strings.
import type { Queryable } from '../db.ts';
import { decodeCursor, pageOf, type Page } from '../pagination.ts';
import type { PaymentFilter } from '../validation.ts';

export type EntryKind = 'allocation' | 'allocation_reversal' | 'refund' | 'unapplied_refund' | 'refund_reversal';

export interface Payment {
  id: string; paidOn: string; amountCents: string; method: string; reference: string | null; note: string;
  createdByName: string | null; createdAt: Date; voided: boolean; voidReason: string | null; voidedOn: string | null;
  /** Net cash applied to bills (allocations less reversals and net refunds). */
  appliedCents: string;
  /** Cash returned to the household (refunds less refund reversals). */
  refundedCents: string;
  /** Net cash still held by the payment and not applied to any bill. Zero for a voided payment. */
  unappliedCents: string;
  /** Cash actually paid after refunds. Zero for a voided payment. */
  netCashCents: string;
}

const PAYMENT_FROM = `from payments p
  left join users u on u.id = p.created_by
  left join payment_voids v on v.household_id = p.household_id and v.payment_id = p.id
  left join lateral (select
      coalesce(sum(e.amount_cents) filter (where e.bill_id is not null), 0) as applied,
      -coalesce(sum(e.amount_cents) filter (where e.kind in ('refund', 'unapplied_refund', 'refund_reversal')), 0) as refunded
    from payment_entries e where e.household_id = p.household_id and e.payment_id = p.id) c on true`;
const PAYMENT_COLS = `p.id, p.paid_on::text as "paidOn", p.amount_cents::text as "amountCents", p.method, p.reference, p.note,
  u.display_name as "createdByName", p.created_at as "createdAt", (v.payment_id is not null) as voided, v.reason as "voidReason",
  v.voided_on::text as "voidedOn", c.applied::text as "appliedCents", c.refunded::text as "refundedCents",
  (case when v.payment_id is null then p.amount_cents - c.refunded - c.applied else 0 end)::text as "unappliedCents",
  (case when v.payment_id is null then p.amount_cents - c.refunded else 0 end)::text as "netCashCents"`;

export async function getPayment(db: Queryable, householdId: string, id: string): Promise<Payment | null> {
  const { rows } = await db.query<Payment>(`select ${PAYMENT_COLS} ${PAYMENT_FROM} where p.household_id = $1 and p.id = $2`, [householdId, id]);
  return rows[0] ?? null;
}

/** Locks payment rows (ascending id) for the transaction. Read cash figures only after this returns. */
export async function lockPayments(db: Queryable, householdId: string, ids: string[]): Promise<string[]> {
  const sorted = [...new Set(ids)].sort();
  const { rows } = await db.query<{ id: string }>(
    `select id from payments where household_id = $1 and id = any($2::uuid[]) order by id for update`, [householdId, sorted]);
  return rows.map((r) => r.id);
}

export async function listPayments(db: Queryable, householdId: string, f: PaymentFilter): Promise<Page<Payment>> {
  const params: unknown[] = [householdId];
  const where = ['p.household_id = $1'];
  if (f.from) where.push(`p.paid_on >= $${params.push(f.from)}`);
  if (f.to) where.push(`p.paid_on <= $${params.push(f.to)}`);
  if (f.q) where.push(`(p.reference ilike $${params.push(`%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)} or p.note ilike $${params.length})`);
  if (f.unapplied) where.push(`v.payment_id is null and p.amount_cents - c.refunded - c.applied > 0`);
  if (f.billId) where.push(`exists (select 1 from payment_entries e where e.household_id = p.household_id and e.payment_id = p.id and e.kind = 'allocation' and e.bill_id = $${params.push(f.billId)})`);
  if (f.memberId) where.push(`exists (select 1 from payment_entries e join bills b on b.household_id = e.household_id and b.id = e.bill_id
    where e.household_id = p.household_id and e.payment_id = p.id and e.kind = 'allocation' and b.member_id = $${params.push(f.memberId)})`);
  if (f.providerId) where.push(`exists (select 1 from payment_entries e join bills b on b.household_id = e.household_id and b.id = e.bill_id
    where e.household_id = p.household_id and e.payment_id = p.id and e.kind = 'allocation' and b.provider_id = $${params.push(f.providerId)})`);
  const cur = decodeCursor(f.cursor, 2);
  if (cur) where.push(`(p.paid_on, p.id) < ($${params.push(cur[0])}::date, $${params.push(cur[1])}::uuid)`);
  const { rows } = await db.query<Payment>(
    `select ${PAYMENT_COLS} ${PAYMENT_FROM} where ${where.join(' and ')} order by p.paid_on desc, p.id desc limit $${params.push(f.limit + 1)}`, params);
  return pageOf(rows, f.limit, (r) => [r.paidOn, r.id]);
}

export interface CashTotals { paymentCount: number; unappliedCents: string; netCashCents: string }

/** Cash held by payments but not applied to a bill, and cash actually paid after refunds. Voided payments count zero. */
export async function cashTotals(db: Queryable, householdId: string): Promise<CashTotals> {
  const { rows } = await db.query<CashTotals>(
    `select count(*)::int as "paymentCount",
       coalesce(sum(case when v.payment_id is null then p.amount_cents - c.refunded - c.applied else 0 end), 0)::text as "unappliedCents",
       coalesce(sum(case when v.payment_id is null then p.amount_cents - c.refunded else 0 end), 0)::text as "netCashCents"
     ${PAYMENT_FROM} where p.household_id = $1`, [householdId]);
  return rows[0]!;
}

export interface Entry {
  id: string; seq: string; eventId: string; kind: EntryKind; billId: string | null; allocationId: string | null; reversesEntryId: string | null;
  amountCents: string; effectiveDate: string; reason: string; createdByName: string | null; createdAt: Date;
  billLabel: string | null; memberName: string | null;
}

export async function listEntries(db: Queryable, householdId: string, paymentId: string): Promise<Entry[]> {
  const { rows } = await db.query<Entry>(
    `select e.id, e.seq::text, e.event_id as "eventId", e.kind, e.bill_id as "billId", e.allocation_id as "allocationId",
       e.reverses_entry_id as "reversesEntryId", e.amount_cents::text as "amountCents", e.effective_date::text as "effectiveDate", e.reason,
       u.display_name as "createdByName", e.created_at as "createdAt",
       case when b.id is not null then pr.name || coalesce(' ' || b.provider_reference, '') end as "billLabel", m.name as "memberName"
     from payment_entries e
     left join users u on u.id = e.created_by
     left join bills b on b.household_id = e.household_id and b.id = e.bill_id
     left join providers pr on pr.household_id = b.household_id and pr.id = b.provider_id
     left join family_members m on m.household_id = b.household_id and m.id = b.member_id
     where e.household_id = $1 and e.payment_id = $2 order by e.seq`, [householdId, paymentId]);
  return rows;
}

export interface AllocationNet {
  allocationId: string; paymentId: string; billId: string; paidOn: string; allocatedCents: string; reversedCents: string;
  refundedCents: string; netCents: string; memberId: string; providerId: string; billLabel: string; memberName: string;
  /** Plan matches still counted against this allocation (current schedule revisions only). */
  matchedCents: string;
}

const ALLOCATION_SELECT = `select n.allocation_id as "allocationId", n.payment_id as "paymentId", n.bill_id as "billId", n.paid_on::text as "paidOn",
    n.allocated_cents::text as "allocatedCents", n.reversed_cents::text as "reversedCents", n.refunded_cents::text as "refundedCents",
    n.net_cents::text as "netCents", b.member_id as "memberId", b.provider_id as "providerId",
    pr.name || coalesce(' ' || b.provider_reference, '') as "billLabel", m.name as "memberName",
    (select coalesce(sum(x.amount_cents), 0) from installment_matches x join plan_revisions r on r.id = x.revision_id
       where x.household_id = n.household_id and x.allocation_id = n.allocation_id
         and r.revision_no = (select max(q.revision_no) from plan_revisions q where q.plan_id = x.plan_id))::text as "matchedCents"
  from allocation_net n
  join bills b on b.household_id = n.household_id and b.id = n.bill_id
  join providers pr on pr.household_id = b.household_id and pr.id = b.provider_id
  join family_members m on m.household_id = b.household_id and m.id = b.member_id`;

export async function getAllocation(db: Queryable, householdId: string, id: string): Promise<AllocationNet | null> {
  const { rows } = await db.query<AllocationNet>(`${ALLOCATION_SELECT} where n.household_id = $1 and n.allocation_id = $2`, [householdId, id]);
  return rows[0] ?? null;
}

export async function listAllocationsOfPayment(db: Queryable, householdId: string, paymentId: string): Promise<AllocationNet[]> {
  const { rows } = await db.query<AllocationNet>(
    `${ALLOCATION_SELECT} where n.household_id = $1 and n.payment_id = $2 order by n.allocation_id`, [householdId, paymentId]);
  return rows;
}

export interface AllocationNetFilter { billIds?: string[]; paymentIds?: string[]; memberId?: string; from?: string; to?: string; limit: number; after?: { paidOn: string; allocationId: string } }

/** Net cash per allocation, used by balances, plans and HSA reconciliation. Newest payments first, bounded. */
export async function listAllocationsNet(db: Queryable, householdId: string, f: AllocationNetFilter): Promise<AllocationNet[]> {
  const params: unknown[] = [householdId];
  const where = ['n.household_id = $1'];
  if (f.billIds) where.push(`n.bill_id = any($${params.push(f.billIds)}::uuid[])`);
  if (f.paymentIds) where.push(`n.payment_id = any($${params.push(f.paymentIds)}::uuid[])`);
  if (f.memberId) where.push(`b.member_id = $${params.push(f.memberId)}`);
  if (f.from) where.push(`n.paid_on >= $${params.push(f.from)}`);
  if (f.to) where.push(`n.paid_on <= $${params.push(f.to)}`);
  if (f.after) where.push(`(n.paid_on, n.allocation_id) < ($${params.push(f.after.paidOn)}::date, $${params.push(f.after.allocationId)}::uuid)`);
  const { rows } = await db.query<AllocationNet>(
    `${ALLOCATION_SELECT} where ${where.join(' and ')} order by n.paid_on desc, n.allocation_id desc limit $${params.push(f.limit)}`, params);
  return rows;
}

/** Allocations of the given bills that still hold cash not matched to a plan, with the selected one always kept. */
export async function listMatchableAllocations(db: Queryable, householdId: string, billIds: string[], currentId: string | null, limit: number): Promise<AllocationNet[]> {
  const { rows } = await db.query<AllocationNet>(
    `select * from (${ALLOCATION_SELECT} where n.household_id = $1 and n.bill_id = any($2::uuid[])) a
     where (a."netCents"::bigint - a."matchedCents"::bigint > 0 or a."allocationId" = $3::uuid)
     order by (a."allocationId" = $3::uuid) desc, a."paidOn" desc, a."allocationId" desc limit $4`, [householdId, billIds, currentId, limit]);
  return rows;
}

export interface BillPaymentLine {
  entryId: string; paymentId: string; kind: EntryKind; amountCents: string; effectiveDate: string; reason: string; paidOn: string;
  method: string; reference: string | null; allocationId: string | null; createdByName: string | null; paymentVoided: boolean;
}

/** Every posted entry that touches a bill, oldest first by ledger sequence (not by clock). */
export async function listBillLedger(db: Queryable, householdId: string, billId: string): Promise<BillPaymentLine[]> {
  const { rows } = await db.query<BillPaymentLine>(
    `select e.id as "entryId", e.payment_id as "paymentId", e.kind, e.amount_cents::text as "amountCents", e.effective_date::text as "effectiveDate",
       e.reason, p.paid_on::text as "paidOn", p.method, p.reference, e.allocation_id as "allocationId", u.display_name as "createdByName",
       exists (select 1 from payment_voids v where v.payment_id = p.id) as "paymentVoided"
     from payment_entries e join payments p on p.household_id = e.household_id and p.id = e.payment_id
     left join users u on u.id = e.created_by
     where e.household_id = $1 and e.bill_id = $2 order by e.seq`, [householdId, billId]);
  return rows;
}

export async function insertPayment(db: Queryable, v: {
  id: string; householdId: string; userId: string; paidOn: string; amountCents: bigint; method: string; reference: string | null; note: string;
}): Promise<void> {
  await db.query(
    `insert into payments (id, household_id, paid_on, amount_cents, method, reference, note, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [v.id, v.householdId, v.paidOn, v.amountCents.toString(), v.method, v.reference, v.note, v.userId]);
}

export async function insertEntry(db: Queryable, v: {
  id: string; householdId: string; userId: string; paymentId: string; eventId: string; kind: EntryKind; billId: string | null;
  allocationId: string | null; reversesEntryId?: string | null; amountCents: bigint; effectiveDate: string; reason: string;
}): Promise<void> {
  await db.query(
    `insert into payment_entries (id, household_id, payment_id, event_id, kind, bill_id, allocation_id, reverses_entry_id, amount_cents, effective_date, reason, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [v.id, v.householdId, v.paymentId, v.eventId, v.kind, v.billId, v.allocationId, v.reversesEntryId ?? null, v.amountCents.toString(), v.effectiveDate, v.reason, v.userId]);
}

export async function insertVoid(db: Queryable, v: { householdId: string; userId: string; paymentId: string; reason: string; voidedOn: string }): Promise<void> {
  await db.query(`insert into payment_voids (payment_id, household_id, reason, voided_on, created_by) values ($1, $2, $3, $4, $5)`,
    [v.paymentId, v.householdId, v.reason, v.voidedOn, v.userId]);
}

export interface RefundEntry { id: string; paymentId: string; kind: 'refund' | 'unapplied_refund'; billId: string | null; allocationId: string | null; amountCents: bigint; reversed: boolean }

/** The un-reversed or reversed refund entries of one refund event. */
export async function listRefundEvent(db: Queryable, householdId: string, eventId: string): Promise<RefundEntry[]> {
  const { rows } = await db.query<{ id: string; payment_id: string; kind: 'refund' | 'unapplied_refund'; bill_id: string | null; allocation_id: string | null; amount_cents: string; reversed: boolean }>(
    `select e.id, e.payment_id, e.kind, e.bill_id, e.allocation_id, e.amount_cents::text, exists (select 1 from payment_entries r where r.reverses_entry_id = e.id) as reversed
     from payment_entries e where e.household_id = $1 and e.event_id = $2 and e.kind in ('refund', 'unapplied_refund') order by e.seq`, [householdId, eventId]);
  return rows.map((r) => ({ id: r.id, paymentId: r.payment_id, kind: r.kind, billId: r.bill_id, allocationId: r.allocation_id, amountCents: BigInt(r.amount_cents), reversed: r.reversed }));
}

export interface PaymentHistoryEvent {
  id: string; action: string; entityType: string; entityId: string | null; actorName: string | null; occurredAt: Date;
  detail: Record<string, string | number | boolean | null>;
}

/** Audit events for a payment and its allocations, in audit sequence order (commit-independent of clocks). */
export async function paymentHistory(db: Queryable, householdId: string, paymentId: string): Promise<PaymentHistoryEvent[]> {
  const { rows } = await db.query<PaymentHistoryEvent>(
    `select e.id::text, e.action, e.entity_type as "entityType", e.entity_id as "entityId", u.display_name as "actorName",
       e.occurred_at as "occurredAt", e.detail
     from audit_events e left join users u on u.id = e.actor_user_id
     where e.household_id = $1 and (e.detail ->> 'paymentId' = $2 or (e.entity_type = 'payment' and e.entity_id = $2))
     order by e.id`, [householdId, paymentId]);
  return rows;
}

export interface PayableBill { id: string; label: string; statementDate: string; openBalanceCents: string }

/**
 * Confirmed bills with an open balance, for allocation selects. Bounded to `limit` rows (one extra row tells the caller the
 * list was cut), and the bill passed as `currentId` is always included even when it is paid or outside the window.
 */
export async function listPayableBills(db: Queryable, householdId: string, o: { q?: string; currentId?: string | null; limit: number }): Promise<PayableBill[]> {
  const params: unknown[] = [householdId, o.currentId ?? null];
  // The search narrows the candidates only; the current bill is always kept, whatever the search says.
  let search = 'true';
  if (o.q) search = `(x.provider_reference ilike $${params.push(`%${o.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)} or x.provider_name ilike $${params.length} or x.member_name ilike $${params.length})`;
  const { rows } = await db.query<PayableBill>(
    `select * from (select b.id, m.name || ' · ' || pr.name || coalesce(' ' || b.provider_reference, '') as label, b.statement_date::text as "statementDate",
       (b.base_responsibility_cents + coalesce((select sum(a.amount_cents) from bill_adjustments a where a.household_id = b.household_id and a.bill_id = b.id), 0)
         - coalesce((select sum(e.amount_cents) from payment_entries e where e.household_id = b.household_id and e.bill_id = b.id), 0))::text as "openBalanceCents",
       b.id = $2::uuid as is_current, b.provider_reference, pr.name as provider_name, m.name as member_name
     from bills b join family_members m on m.household_id = b.household_id and m.id = b.member_id
     join providers pr on pr.household_id = b.household_id and pr.id = b.provider_id
     where b.household_id = $1 and (b.amount_status = 'confirmed' or b.id = $2::uuid)) x
     where x.is_current or (x."openBalanceCents"::bigint > 0 and ${search})
     order by x.is_current desc, x."statementDate" desc, x.id desc limit $${params.push(o.limit)}`, params);
  return rows.map(({ id, label, statementDate, openBalanceCents }) => ({ id, label, statementDate, openBalanceCents }));
}
