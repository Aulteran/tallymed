// SQL only for payment plans, schedule revisions, installments and matches. Household-scoped; services own locking and audit.
import type { Queryable } from '../db.ts';
import { decodeCursor, pageOf, type Page } from '../pagination.ts';
import type { InstallmentFilter, PlanFilter } from '../validation.ts';

export type InstallmentState = 'paid' | 'partial' | 'unpaid';

export interface Plan {
  id: string; name: string; providerId: string; providerName: string; status: 'active' | 'cancelled'; cancelReason: string | null;
  cancelledAt: Date | null; version: number; createdAt: Date; createdSort: string; revisionId: string; revisionNo: number; totalCents: string;
  cadence: string; installmentCount: number; matchedCents: string; billCount: number; nextDueDate: string | null; overdueCount: number;
}

const MATCHED = `coalesce((select sum(m.amount_cents) from installment_matches m where m.installment_id = i.id), 0)`;
const PLAN_SELECT = `select p.id, p.name, p.provider_id as "providerId", pr.name as "providerName", p.status, p.cancel_reason as "cancelReason",
    p.cancelled_at as "cancelledAt", p.version, p.created_at as "createdAt", p.created_at::text as "createdSort", r.id as "revisionId",
    r.revision_no as "revisionNo", r.total_cents::text as "totalCents", r.cadence,
    (select count(*)::int from plan_installments i where i.revision_id = r.id) as "installmentCount",
    (select coalesce(sum(m.amount_cents), 0) from installment_matches m where m.revision_id = r.id)::text as "matchedCents",
    (select count(*)::int from payment_plan_bills pb where pb.plan_id = p.id) as "billCount",
    (select min(i.due_date) from plan_installments i where i.revision_id = r.id and i.amount_cents > ${MATCHED})::text as "nextDueDate",
    (select count(*)::int from plan_installments i where i.revision_id = r.id and i.amount_cents > ${MATCHED} and i.due_date < $2::date) as "overdueCount"
  from payment_plans p
  join providers pr on pr.household_id = p.household_id and pr.id = p.provider_id
  join lateral (select x.* from plan_revisions x where x.plan_id = p.id order by x.revision_no desc limit 1) r on true`;

export async function getPlan(db: Queryable, householdId: string, id: string, asOf: string): Promise<Plan | null> {
  const { rows } = await db.query<Plan>(`${PLAN_SELECT} where p.household_id = $1 and p.id = $3`, [householdId, asOf, id]);
  return rows[0] ?? null;
}

/** Locks plan rows (ascending id). */
export async function lockPlans(db: Queryable, householdId: string, ids: string[]): Promise<Array<{ id: string; status: 'active' | 'cancelled'; version: number }>> {
  const { rows } = await db.query<{ id: string; status: 'active' | 'cancelled'; version: number }>(
    `select id, status, version from payment_plans where household_id = $1 and id = any($2::uuid[]) order by id for update`, [householdId, [...new Set(ids)].sort()]);
  return rows;
}

export async function listPlans(db: Queryable, householdId: string, f: PlanFilter, asOf: string): Promise<Page<Plan>> {
  const params: unknown[] = [householdId, asOf];
  const where = ['p.household_id = $1'];
  if (f.status) where.push(`p.status = $${params.push(f.status)}`);
  if (f.providerId) where.push(`p.provider_id = $${params.push(f.providerId)}`);
  if (f.q) where.push(`(p.name ilike $${params.push(`%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)} or pr.name ilike $${params.length})`);
  const cur = decodeCursor(f.cursor, 2);
  if (cur) where.push(`(p.created_at, p.id) < ($${params.push(cur[0])}::timestamptz, $${params.push(cur[1])}::uuid)`);
  const { rows } = await db.query<Plan>(`${PLAN_SELECT} where ${where.join(' and ')} order by p.created_at desc, p.id desc limit $${params.push(f.limit + 1)}`, params);
  return pageOf(rows, f.limit, (r) => [r.createdSort, r.id]);
}

export async function planBillIds(db: Queryable, householdId: string, planId: string): Promise<string[]> {
  const { rows } = await db.query<{ bill_id: string }>(`select bill_id from payment_plan_bills where household_id = $1 and plan_id = $2 order by bill_id`, [householdId, planId]);
  return rows.map((r) => r.bill_id);
}

export interface Installment {
  id: string; revisionId: string; seq: number; dueDate: string; amountCents: string; matchedCents: string; unpaidCents: string;
  state: InstallmentState; overdue: boolean;
}

const INSTALLMENT_COLS = `i.id, i.revision_id as "revisionId", i.seq, i.due_date::text as "dueDate", i.amount_cents::text as "amountCents",
  ${MATCHED}::text as "matchedCents", (i.amount_cents - ${MATCHED})::text as "unpaidCents",
  (case when ${MATCHED} >= i.amount_cents then 'paid' when ${MATCHED} > 0 then 'partial' else 'unpaid' end) as state,
  (i.amount_cents > ${MATCHED} and i.due_date < $3::date) as overdue`;

export async function listInstallments(db: Queryable, householdId: string, revisionId: string, asOf: string): Promise<Installment[]> {
  const { rows } = await db.query<Installment>(
    `select ${INSTALLMENT_COLS} from plan_installments i where i.household_id = $1 and i.revision_id = $2 order by i.seq`, [householdId, revisionId, asOf]);
  return rows;
}

export async function getInstallment(db: Queryable, householdId: string, id: string, asOf: string): Promise<(Installment & { planId: string; planCurrent: boolean }) | null> {
  const { rows } = await db.query<Installment & { planId: string; planCurrent: boolean }>(
    `select ${INSTALLMENT_COLS}, i.plan_id as "planId",
       (i.revision_id = (select x.id from plan_revisions x where x.plan_id = i.plan_id order by x.revision_no desc limit 1)) as "planCurrent"
     from plan_installments i where i.household_id = $1 and i.id = $2`, [householdId, id, asOf]);
  return rows[0] ?? null;
}

export interface Revision { id: string; revisionNo: number; totalCents: string; cadence: string; reason: string; createdByName: string | null; createdAt: Date; installmentCount: number; matchedCents: string }

export async function listRevisions(db: Queryable, householdId: string, planId: string): Promise<Revision[]> {
  const { rows } = await db.query<Revision>(
    `select r.id, r.revision_no as "revisionNo", r.total_cents::text as "totalCents", r.cadence, r.reason, u.display_name as "createdByName", r.created_at as "createdAt",
       (select count(*)::int from plan_installments i where i.revision_id = r.id) as "installmentCount",
       (select coalesce(sum(m.amount_cents), 0) from installment_matches m where m.revision_id = r.id)::text as "matchedCents"
     from plan_revisions r left join users u on u.id = r.created_by where r.household_id = $1 and r.plan_id = $2 order by r.revision_no`, [householdId, planId]);
  return rows;
}

export async function currentRevision(db: Queryable, householdId: string, planId: string): Promise<{ id: string; revisionNo: number; totalCents: bigint; cadence: string } | null> {
  const { rows } = await db.query<{ id: string; revision_no: number; total_cents: string; cadence: string }>(
    `select id, revision_no, total_cents::text, cadence from plan_revisions where household_id = $1 and plan_id = $2 order by revision_no desc limit 1`, [householdId, planId]);
  const r = rows[0];
  return r ? { id: r.id, revisionNo: r.revision_no, totalCents: BigInt(r.total_cents), cadence: r.cadence } : null;
}

export interface MatchLine {
  id: string; kind: 'match' | 'unmatch'; amountCents: string; revisionNo: number; installmentSeq: number; dueDate: string; allocationId: string; paymentId: string;
  billId: string; carried: boolean; reason: string; createdByName: string | null; createdAt: Date; paidOn: string; reference: string | null;
}

/** Every match entry of a plan across all revisions, in ledger order. */
export async function listMatches(db: Queryable, householdId: string, planId: string): Promise<MatchLine[]> {
  const { rows } = await db.query<MatchLine>(
    `select m.id, m.kind, m.amount_cents::text as "amountCents", r.revision_no as "revisionNo", i.seq as "installmentSeq", i.due_date::text as "dueDate",
       m.allocation_id as "allocationId", m.payment_id as "paymentId", m.bill_id as "billId", m.carried, m.reason, u.display_name as "createdByName",
       m.created_at as "createdAt", p.paid_on::text as "paidOn", p.reference
     from installment_matches m
     join plan_installments i on i.id = m.installment_id join plan_revisions r on r.id = m.revision_id
     join payments p on p.id = m.payment_id left join users u on u.id = m.created_by
     where m.household_id = $1 and m.plan_id = $2 order by m.seq`, [householdId, planId]);
  return rows;
}

/** Net matched amount per (installment, allocation) of the current revision, oldest due date first. */
export async function currentMatchPairs(db: Queryable, householdId: string, planId: string): Promise<Array<{
  installmentId: string; allocationId: string; paymentId: string; billId: string; dueDate: string; seq: number; cents: bigint;
}>> {
  const { rows } = await db.query<{ installment_id: string; allocation_id: string; payment_id: string; bill_id: string; due_date: string; seq: number; cents: string }>(
    `select m.installment_id, m.allocation_id, m.payment_id, m.bill_id, i.due_date::text, i.seq, sum(m.amount_cents)::text as cents
     from installment_matches m join plan_installments i on i.id = m.installment_id
     where m.household_id = $1 and m.plan_id = $2 and m.revision_id = (select x.id from plan_revisions x where x.plan_id = $2 order by x.revision_no desc limit 1)
     group by m.installment_id, m.allocation_id, m.payment_id, m.bill_id, i.due_date, i.seq
     having sum(m.amount_cents) > 0 order by i.due_date, i.seq, m.allocation_id`, [householdId, planId]);
  return rows.map((r) => ({ installmentId: r.installment_id, allocationId: r.allocation_id, paymentId: r.payment_id, billId: r.bill_id, dueDate: r.due_date, seq: r.seq, cents: BigInt(r.cents) }));
}

/** Current-revision matches of one allocation across plans, latest due date first (the first to release when cash shrinks). */
export async function currentMatchesOfAllocation(db: Queryable, householdId: string, allocationId: string): Promise<Array<{
  planId: string; revisionId: string; installmentId: string; paymentId: string; billId: string; cents: bigint;
}>> {
  const { rows } = await db.query<{ plan_id: string; revision_id: string; installment_id: string; payment_id: string; bill_id: string; cents: string }>(
    `select m.plan_id, m.revision_id, m.installment_id, m.payment_id, m.bill_id, sum(m.amount_cents)::text as cents
     from installment_matches m join plan_installments i on i.id = m.installment_id
     where m.household_id = $1 and m.allocation_id = $2
       and m.revision_id = (select x.id from plan_revisions x where x.plan_id = m.plan_id order by x.revision_no desc limit 1)
     group by m.plan_id, m.revision_id, m.installment_id, m.payment_id, m.bill_id, i.due_date, i.seq
     having sum(m.amount_cents) > 0 order by i.due_date desc, i.seq desc, m.installment_id`, [householdId, allocationId]);
  return rows.map((r) => ({ planId: r.plan_id, revisionId: r.revision_id, installmentId: r.installment_id, paymentId: r.payment_id, billId: r.bill_id, cents: BigInt(r.cents) }));
}

/** Plans that currently hold matches of the allocation, for locking before a refund or reversal releases them. */
export async function plansMatchingAllocation(db: Queryable, householdId: string, allocationId: string): Promise<string[]> {
  const { rows } = await db.query<{ plan_id: string }>(`select distinct plan_id from installment_matches where household_id = $1 and allocation_id = $2 order by plan_id`, [householdId, allocationId]);
  return rows.map((r) => r.plan_id);
}

/** Payments that hold matches of the plan, for locking in payment-then-plan order. */
export async function paymentsMatchedByPlan(db: Queryable, householdId: string, planId: string): Promise<string[]> {
  const { rows } = await db.query<{ payment_id: string }>(`select distinct payment_id from installment_matches where household_id = $1 and plan_id = $2 order by payment_id`, [householdId, planId]);
  return rows.map((r) => r.payment_id);
}

export async function matchedNet(db: Queryable, householdId: string, installmentId: string, allocationId: string): Promise<bigint> {
  const { rows } = await db.query<{ total: string }>(
    `select coalesce(sum(amount_cents), 0)::text as total from installment_matches where household_id = $1 and installment_id = $2 and allocation_id = $3`, [householdId, installmentId, allocationId]);
  return BigInt(rows[0]!.total);
}

export async function insertPlan(db: Queryable, v: { id: string; householdId: string; userId: string; providerId: string; name: string }): Promise<void> {
  await db.query(`insert into payment_plans (id, household_id, provider_id, name, created_by) values ($1, $2, $3, $4, $5)`, [v.id, v.householdId, v.providerId, v.name, v.userId]);
}

export async function insertPlanBill(db: Queryable, householdId: string, planId: string, billId: string): Promise<void> {
  await db.query(`insert into payment_plan_bills (household_id, plan_id, bill_id) values ($1, $2, $3)`, [householdId, planId, billId]);
}

export async function insertRevision(db: Queryable, v: {
  id: string; householdId: string; userId: string; planId: string; revisionNo: number; totalCents: bigint; cadence: string; reason: string;
  installments: Array<{ id: string; dueDate: string; amountCents: bigint }>;
}): Promise<void> {
  await db.query(`insert into plan_revisions (id, household_id, plan_id, revision_no, total_cents, cadence, reason, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [v.id, v.householdId, v.planId, v.revisionNo, v.totalCents.toString(), v.cadence, v.reason, v.userId]);
  for (const [i, inst] of v.installments.entries()) {
    await db.query(`insert into plan_installments (id, household_id, plan_id, revision_id, seq, due_date, amount_cents) values ($1, $2, $3, $4, $5, $6, $7)`,
      [inst.id, v.householdId, v.planId, v.id, i + 1, inst.dueDate, inst.amountCents.toString()]);
  }
}

export async function insertMatch(db: Queryable, v: {
  id: string; householdId: string; userId: string; planId: string; revisionId: string; installmentId: string; paymentId: string; allocationId: string;
  billId: string; kind: 'match' | 'unmatch'; amountCents: bigint; carried: boolean; reason: string;
}): Promise<void> {
  await db.query(
    `insert into installment_matches (id, household_id, plan_id, revision_id, installment_id, payment_id, allocation_id, bill_id, kind, amount_cents, carried, reason, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [v.id, v.householdId, v.planId, v.revisionId, v.installmentId, v.paymentId, v.allocationId, v.billId, v.kind, v.amountCents.toString(), v.carried, v.reason, v.userId]);
}

export async function cancelPlan(db: Queryable, householdId: string, id: string, version: number, reason: string): Promise<boolean> {
  const r = await db.query(
    `update payment_plans set status = 'cancelled', cancel_reason = $4, cancelled_at = now(), version = version + 1, updated_at = now()
     where household_id = $1 and id = $2 and version = $3 and status = 'active'`, [householdId, id, version, reason]);
  return r.rowCount === 1;
}

export async function touchPlan(db: Queryable, householdId: string, id: string): Promise<void> {
  await db.query(`update payment_plans set version = version + 1, updated_at = now() where household_id = $1 and id = $2`, [householdId, id]);
}

export interface QueueItem {
  installmentId: string; planId: string; planName: string; providerName: string; memberNames: string; seq: number; dueDate: string;
  amountCents: string; matchedCents: string; unpaidCents: string; state: InstallmentState; overdue: boolean;
}

/** Unpaid installments of active plans' current revisions: overdue (due before asOf) and upcoming. Soonest due first. */
export async function installmentQueue(db: Queryable, householdId: string, f: InstallmentFilter, asOf: string): Promise<Page<QueueItem>> {
  const params: unknown[] = [householdId, asOf];
  const where = [`p.household_id = $1`, `p.status = 'active'`, `i.amount_cents > ${MATCHED}`,
    `i.revision_id = (select x.id from plan_revisions x where x.plan_id = p.id order by x.revision_no desc limit 1)`];
  if (f.state === 'overdue') where.push('i.due_date < $2::date');
  if (f.state === 'upcoming') where.push('i.due_date >= $2::date');
  if (f.planId) where.push(`p.id = $${params.push(f.planId)}`);
  if (f.providerId) where.push(`p.provider_id = $${params.push(f.providerId)}`);
  if (f.memberId) where.push(`exists (select 1 from payment_plan_bills pb join bills b on b.household_id = pb.household_id and b.id = pb.bill_id
    where pb.plan_id = p.id and b.member_id = $${params.push(f.memberId)})`);
  const cur = decodeCursor(f.cursor, 2);
  if (cur) where.push(`(i.due_date, i.id) > ($${params.push(cur[0])}::date, $${params.push(cur[1])}::uuid)`);
  const { rows } = await db.query<QueueItem>(
    `select i.id as "installmentId", p.id as "planId", p.name as "planName", pr.name as "providerName",
       coalesce((select string_agg(distinct m.name, ', ' order by m.name) from payment_plan_bills pb join bills b on b.household_id = pb.household_id and b.id = pb.bill_id
         join family_members m on m.household_id = b.household_id and m.id = b.member_id where pb.plan_id = p.id), '') as "memberNames",
       i.seq, i.due_date::text as "dueDate", i.amount_cents::text as "amountCents", ${MATCHED}::text as "matchedCents",
       (i.amount_cents - ${MATCHED})::text as "unpaidCents", (case when ${MATCHED} > 0 then 'partial' else 'unpaid' end) as state, (i.due_date < $2::date) as overdue
     from plan_installments i join payment_plans p on p.household_id = i.household_id and p.id = i.plan_id
     join providers pr on pr.household_id = p.household_id and pr.id = p.provider_id
     where ${where.join(' and ')} order by i.due_date, i.id limit $${params.push(f.limit + 1)}`, params);
  return pageOf(rows, f.limit, (r) => [r.dueDate, r.installmentId]);
}

export interface QueueTotals { overdueCount: number; overdueCents: string; upcomingCount: number; upcomingCents: string }

export async function installmentTotals(db: Queryable, householdId: string, asOf: string): Promise<QueueTotals> {
  const { rows } = await db.query<QueueTotals>(
    `select (count(*) filter (where i.due_date < $2::date))::int as "overdueCount",
       coalesce(sum(i.amount_cents - ${MATCHED}) filter (where i.due_date < $2::date), 0)::text as "overdueCents",
       (count(*) filter (where i.due_date >= $2::date))::int as "upcomingCount",
       coalesce(sum(i.amount_cents - ${MATCHED}) filter (where i.due_date >= $2::date), 0)::text as "upcomingCents"
     from plan_installments i join payment_plans p on p.household_id = i.household_id and p.id = i.plan_id
     where p.household_id = $1 and p.status = 'active' and i.amount_cents > ${MATCHED}
       and i.revision_id = (select x.id from plan_revisions x where x.plan_id = p.id order by x.revision_no desc limit 1)`, [householdId, asOf]);
  return rows[0]!;
}

export async function planHistory(db: Queryable, householdId: string, planId: string): Promise<Array<{
  id: string; action: string; actorName: string | null; occurredAt: Date; detail: Record<string, string | number | boolean | null>;
}>> {
  const { rows } = await db.query(
    `select e.id::text, e.action, u.display_name as "actorName", e.occurred_at as "occurredAt", e.detail
     from audit_events e left join users u on u.id = e.actor_user_id
     where e.household_id = $1 and (e.detail ->> 'planId' = $2 or (e.entity_type = 'payment_plan' and e.entity_id = $2)) order by e.id`, [householdId, planId]);
  return rows;
}
