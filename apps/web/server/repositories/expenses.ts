// SQL only. Every query is scoped by household_id; services own authorization, transactions and audit.
// Money columns come back as decimal strings (bigint); dates are ISO date strings.
import type { Queryable } from '../db.ts';
import { decodeCursor, pageOf, type Page } from '../pagination.ts';
import type { BillFilter, PartyFilter, VisitFilter } from '../validation.ts';

export type Lock = 'update' | 'share' | false;
const lockSql = (alias: string, lock: Lock) => (lock ? ` for ${lock} of ${alias}` : '');
const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

// ---------- family members and providers ----------

export interface Party {
  id: string; name: string; notes: string; archivedAt: Date | null; version: number; createdAt: Date; updatedAt: Date;
  dateOfBirth?: string | null; kind?: string;
}
export type PartyTable = 'family_members' | 'providers';
const EXTRA: Record<PartyTable, string> = { family_members: `t.date_of_birth::text as "dateOfBirth"`, providers: 't.kind' };
const PARTY_COLS = (table: PartyTable) =>
  `t.id, t.name, t.notes, ${EXTRA[table]}, t.archived_at as "archivedAt", t.version, t.created_at as "createdAt", t.updated_at as "updatedAt"`;

export async function getParty(db: Queryable, table: PartyTable, householdId: string, id: string, lock: Lock = false): Promise<Party | null> {
  const { rows } = await db.query<Party>(
    `select ${PARTY_COLS(table)} from ${table} t where t.household_id = $1 and t.id = $2${lockSql('t', lock)}`, [householdId, id]);
  return rows[0] ?? null;
}

export async function listParties(db: Queryable, table: PartyTable, householdId: string, f: PartyFilter): Promise<Page<Party>> {
  const params: unknown[] = [householdId];
  const where = ['t.household_id = $1'];
  if (!f.archived) where.push('t.archived_at is null');
  if (f.q) where.push(`t.name ilike $${params.push(like(f.q))}`);
  const cur = decodeCursor(f.cursor, 2);
  if (cur) where.push(`(lower(t.name), t.id) > ($${params.push(cur[0])}, $${params.push(cur[1])}::uuid)`);
  const { rows } = await db.query<Party>(
    `select ${PARTY_COLS(table)} from ${table} t where ${where.join(' and ')} order by lower(t.name), t.id limit $${params.push(f.limit + 1)}`, params);
  return pageOf(rows, f.limit, (r) => [r.name.toLowerCase(), r.id]);
}

export async function insertMember(db: Queryable, v: { householdId: string; userId: string; name: string; dateOfBirth: string | null; notes: string }): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into family_members (household_id, name, date_of_birth, notes, created_by) values ($1, $2, $3, $4, $5) returning id`,
    [v.householdId, v.name, v.dateOfBirth, v.notes, v.userId]);
  return rows[0]!.id;
}

export async function updateMember(db: Queryable, householdId: string, id: string, version: number, v: { name: string; dateOfBirth: string | null; notes: string }): Promise<boolean> {
  const r = await db.query(
    `update family_members set name = $4, date_of_birth = $5, notes = $6, version = version + 1, updated_at = now()
     where household_id = $1 and id = $2 and version = $3`, [householdId, id, version, v.name, v.dateOfBirth, v.notes]);
  return r.rowCount === 1;
}

export async function insertProvider(db: Queryable, v: { householdId: string; userId: string; name: string; kind: string; notes: string }): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into providers (household_id, name, kind, notes, created_by) values ($1, $2, $3, $4, $5) returning id`,
    [v.householdId, v.name, v.kind, v.notes, v.userId]);
  return rows[0]!.id;
}

export async function updateProvider(db: Queryable, householdId: string, id: string, version: number, v: { name: string; kind: string; notes: string }): Promise<boolean> {
  const r = await db.query(
    `update providers set name = $4, kind = $5, notes = $6, version = version + 1, updated_at = now()
     where household_id = $1 and id = $2 and version = $3`, [householdId, id, version, v.name, v.kind, v.notes]);
  return r.rowCount === 1;
}

export async function setArchived(db: Queryable, table: PartyTable, householdId: string, id: string, version: number, archived: boolean): Promise<boolean> {
  const r = await db.query(
    `update ${table} set archived_at = case when $4 then coalesce(archived_at, now()) else null end, version = version + 1, updated_at = now()
     where household_id = $1 and id = $2 and version = $3`, [householdId, id, version, archived]);
  return r.rowCount === 1;
}

// ---------- visits ----------

export interface Visit {
  id: string; memberId: string; providerId: string; serviceDate: string; description: string; notes: string;
  memberName: string; providerName: string; memberNameAtEntry: string; providerNameAtEntry: string;
  memberArchived: boolean; providerArchived: boolean; billCount: number; version: number; createdAt: Date; updatedAt: Date;
}
const VISIT_SELECT = `select v.id, v.member_id as "memberId", v.provider_id as "providerId", v.service_date::text as "serviceDate",
    v.description, v.notes, m.name as "memberName", p.name as "providerName",
    v.member_name_snapshot as "memberNameAtEntry", v.provider_name_snapshot as "providerNameAtEntry",
    (m.archived_at is not null) as "memberArchived", (p.archived_at is not null) as "providerArchived",
    (select count(*)::int from bills b where b.household_id = v.household_id and b.visit_id = v.id) as "billCount",
    v.version, v.created_at as "createdAt", v.updated_at as "updatedAt"
  from visits v
  join family_members m on m.household_id = v.household_id and m.id = v.member_id
  join providers p on p.household_id = v.household_id and p.id = v.provider_id`;

export async function getVisit(db: Queryable, householdId: string, id: string, lock: Lock = false): Promise<Visit | null> {
  const { rows } = await db.query<Visit>(`${VISIT_SELECT} where v.household_id = $1 and v.id = $2${lockSql('v', lock)}`, [householdId, id]);
  return rows[0] ?? null;
}

export async function listVisits(db: Queryable, householdId: string, f: VisitFilter): Promise<Page<Visit>> {
  const params: unknown[] = [householdId];
  const where = ['v.household_id = $1'];
  if (f.memberId) where.push(`v.member_id = $${params.push(f.memberId)}`);
  if (f.providerId) where.push(`v.provider_id = $${params.push(f.providerId)}`);
  if (f.from) where.push(`v.service_date >= $${params.push(f.from)}`);
  if (f.to) where.push(`v.service_date <= $${params.push(f.to)}`);
  if (f.q) where.push(`(v.description ilike $${params.push(like(f.q))} or p.name ilike $${params.length})`);
  const cur = decodeCursor(f.cursor, 2);
  if (cur) where.push(`(v.service_date, v.id) < ($${params.push(cur[0])}::date, $${params.push(cur[1])}::uuid)`);
  const { rows } = await db.query<Visit>(
    `${VISIT_SELECT} where ${where.join(' and ')} order by v.service_date desc, v.id desc limit $${params.push(f.limit + 1)}`, params);
  return pageOf(rows, f.limit, (r) => [r.serviceDate, r.id]);
}

export async function insertVisit(db: Queryable, v: {
  householdId: string; userId: string; memberId: string; providerId: string; serviceDate: string; description: string; notes: string;
  memberName: string; providerName: string;
}): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into visits (household_id, member_id, provider_id, service_date, description, notes, member_name_snapshot, provider_name_snapshot, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [v.householdId, v.memberId, v.providerId, v.serviceDate, v.description, v.notes, v.memberName, v.providerName, v.userId]);
  return rows[0]!.id;
}

export async function updateVisit(db: Queryable, householdId: string, id: string, version: number, v: {
  providerId: string; providerName: string | null; serviceDate: string; description: string; notes: string;
}): Promise<boolean> {
  const r = await db.query(
    `update visits set provider_id = $4, provider_name_snapshot = coalesce($5, provider_name_snapshot), service_date = $6,
       description = $7, notes = $8, version = version + 1, updated_at = now()
     where household_id = $1 and id = $2 and version = $3`,
    [householdId, id, version, v.providerId, v.providerName, v.serviceDate, v.description, v.notes]);
  return r.rowCount === 1;
}

// ---------- bills ----------

export interface Bill {
  id: string; memberId: string; providerId: string; visitId: string | null; providerReference: string | null;
  statementDate: string; dueDate: string | null; originalCents: string; baseResponsibilityCents: string;
  adjustmentsCents: string; responsibilityCents: string;
  /** Open balance. Equals responsibility until payments exist (a later milestone). */
  openBalanceCents: string;
  amountStatus: 'estimate' | 'confirmed'; amountSource: string; sourceNote: string; notes: string;
  memberName: string; providerName: string; memberNameAtEntry: string; providerNameAtEntry: string;
  memberArchived: boolean; providerArchived: boolean; visitDate: string | null; possibleDuplicate: boolean;
  confirmedAt: Date | null; version: number; createdAt: Date; updatedAt: Date;
}

const BILL_FROM = `from bills b
  join family_members m on m.household_id = b.household_id and m.id = b.member_id
  join providers p on p.household_id = b.household_id and p.id = b.provider_id
  left join visits v on v.household_id = b.household_id and v.id = b.visit_id
  left join lateral (select coalesce(sum(a.amount_cents), 0) as total from bill_adjustments a
    where a.household_id = b.household_id and a.bill_id = b.id) adj on true`;
const BILL_COLS = `b.id, b.member_id as "memberId", b.provider_id as "providerId", b.visit_id as "visitId",
  b.provider_reference as "providerReference", b.statement_date::text as "statementDate", b.due_date::text as "dueDate",
  b.original_cents::text as "originalCents", b.base_responsibility_cents::text as "baseResponsibilityCents",
  adj.total::text as "adjustmentsCents", (b.base_responsibility_cents + adj.total)::text as "responsibilityCents",
  (b.base_responsibility_cents + adj.total)::text as "openBalanceCents",
  b.amount_status as "amountStatus", b.amount_source as "amountSource", b.source_note as "sourceNote", b.notes,
  m.name as "memberName", p.name as "providerName", b.member_name_snapshot as "memberNameAtEntry",
  b.provider_name_snapshot as "providerNameAtEntry", (m.archived_at is not null) as "memberArchived",
  (p.archived_at is not null) as "providerArchived", v.service_date::text as "visitDate",
  ${duplicateExists('b')} as "possibleDuplicate",
  b.confirmed_at as "confirmedAt", b.version, b.created_at as "createdAt", b.updated_at as "updatedAt"`;

/**
 * Hint rule: same provider and the same normalized reference, or same provider, member, statement date and original amount.
 * It only warns; bills are never merged automatically.
 */
function duplicateExists(alias: string): string {
  return `exists (select 1 from bills o where o.household_id = ${alias}.household_id and o.id <> ${alias}.id
    and o.provider_id = ${alias}.provider_id
    and ((${alias}.reference_norm <> '' and o.reference_norm = ${alias}.reference_norm)
      or (o.member_id = ${alias}.member_id and o.statement_date = ${alias}.statement_date and o.original_cents = ${alias}.original_cents)))`;
}

export async function getBill(db: Queryable, householdId: string, id: string): Promise<Bill | null> {
  const { rows } = await db.query<Bill>(`select ${BILL_COLS} ${BILL_FROM} where b.household_id = $1 and b.id = $2`, [householdId, id]);
  return rows[0] ?? null;
}

function billWhere(householdId: string, f: Omit<BillFilter, 'cursor' | 'limit'>, params: unknown[]): string[] {
  params.push(householdId);
  const where = ['b.household_id = $1'];
  if (f.memberId) where.push(`b.member_id = $${params.push(f.memberId)}`);
  if (f.providerId) where.push(`b.provider_id = $${params.push(f.providerId)}`);
  if (f.visitId) where.push(`b.visit_id = $${params.push(f.visitId)}`);
  if (f.status) where.push(`b.amount_status = $${params.push(f.status)}`);
  if (f.awaitingVisit) where.push('b.visit_id is null');
  if (f.duplicates) where.push(duplicateExists('b'));
  if (f.from) where.push(`b.statement_date >= $${params.push(f.from)}`);
  if (f.to) where.push(`b.statement_date <= $${params.push(f.to)}`);
  if (f.q) where.push(`(b.provider_reference ilike $${params.push(like(f.q))} or p.name ilike $${params.length})`);
  return where;
}

export async function listBills(db: Queryable, householdId: string, f: BillFilter): Promise<Page<Bill>> {
  const params: unknown[] = [];
  const where = billWhere(householdId, f, params);
  const cur = decodeCursor(f.cursor, 2);
  if (cur) where.push(`(b.statement_date, b.id) < ($${params.push(cur[0])}::date, $${params.push(cur[1])}::uuid)`);
  const { rows } = await db.query<Bill>(
    `select ${BILL_COLS} ${BILL_FROM} where ${where.join(' and ')} order by b.statement_date desc, b.id desc limit $${params.push(f.limit + 1)}`, params);
  return pageOf(rows, f.limit, (r) => [r.statementDate, r.id]);
}

export interface BillTotals {
  billCount: number; confirmedCount: number; estimateCount: number; awaitingVisitCount: number;
  confirmedResponsibilityCents: string; estimatedResponsibilityCents: string;
  confirmedOpenBalanceCents: string; estimatedOpenBalanceCents: string;
}

/** One consistent aggregate over the filtered bills. Confirmed and estimated amounts are never summed together. */
export async function billTotals(db: Queryable, householdId: string, f: Omit<BillFilter, 'cursor' | 'limit'>): Promise<BillTotals> {
  const params: unknown[] = [];
  const where = billWhere(householdId, f, params);
  const { rows } = await db.query<BillTotals>(
    `select count(*)::int as "billCount",
       (count(*) filter (where b.amount_status = 'confirmed'))::int as "confirmedCount",
       (count(*) filter (where b.amount_status = 'estimate'))::int as "estimateCount",
       (count(*) filter (where b.visit_id is null))::int as "awaitingVisitCount",
       coalesce(sum(b.base_responsibility_cents + adj.total) filter (where b.amount_status = 'confirmed'), 0)::text as "confirmedResponsibilityCents",
       coalesce(sum(b.base_responsibility_cents + adj.total) filter (where b.amount_status = 'estimate'), 0)::text as "estimatedResponsibilityCents",
       coalesce(sum(b.base_responsibility_cents + adj.total) filter (where b.amount_status = 'confirmed'), 0)::text as "confirmedOpenBalanceCents",
       coalesce(sum(b.base_responsibility_cents + adj.total) filter (where b.amount_status = 'estimate'), 0)::text as "estimatedOpenBalanceCents"
     ${BILL_FROM} where ${where.join(' and ')}`, params);
  return rows[0]!;
}

export interface BillLock {
  id: string; memberId: string; providerId: string; visitId: string | null; version: number;
  originalCents: bigint; baseResponsibilityCents: bigint; amountStatus: 'estimate' | 'confirmed'; adjustmentsCents: bigint;
}

/**
 * Locks one bill row for the transaction. Every writer that changes a bill or its adjustments takes this lock first, so
 * the responsibility check and the write cannot interleave with another writer. Downstream money services must call
 * lockBills (sorted by id) when they touch several bills.
 */
export async function lockBills(db: Queryable, householdId: string, ids: string[]): Promise<BillLock[]> {
  const sorted = [...new Set(ids)].sort();
  const { rows } = await db.query<{
    id: string; member_id: string; provider_id: string; visit_id: string | null; version: number; original_cents: string;
    base_responsibility_cents: string; amount_status: 'estimate' | 'confirmed';
  }>(
    `select id, member_id, provider_id, visit_id, version, original_cents::text, base_responsibility_cents::text, amount_status
     from bills where household_id = $1 and id = any($2::uuid[]) order by id for update`, [householdId, sorted]);
  const out: BillLock[] = [];
  for (const r of rows) {
    const total = await db.query<{ total: string }>(
      `select coalesce(sum(amount_cents), 0)::text as total from bill_adjustments where household_id = $1 and bill_id = $2`, [householdId, r.id]);
    out.push({
      id: r.id, memberId: r.member_id, providerId: r.provider_id, visitId: r.visit_id, version: r.version,
      originalCents: BigInt(r.original_cents), baseResponsibilityCents: BigInt(r.base_responsibility_cents),
      amountStatus: r.amount_status, adjustmentsCents: BigInt(total.rows[0]!.total),
    });
  }
  return out;
}

export async function insertBill(db: Queryable, v: {
  id: string; householdId: string; userId: string; memberId: string; providerId: string; visitId: string | null;
  providerReference: string | null; statementDate: string; dueDate: string | null; originalCents: bigint; baseCents: bigint;
  status: 'estimate' | 'confirmed'; source: string; sourceNote: string; notes: string; memberName: string; providerName: string;
}): Promise<void> {
  await db.query(
    `insert into bills (id, household_id, member_id, provider_id, visit_id, provider_reference, statement_date, due_date, original_cents,
       base_responsibility_cents, amount_status, amount_source, source_note, notes, member_name_snapshot, provider_name_snapshot,
       confirmed_at, confirmed_by, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
       case when $11 = 'confirmed' then now() end, case when $11 = 'confirmed' then $17::uuid end, $17)`,
    [v.id, v.householdId, v.memberId, v.providerId, v.visitId, v.providerReference, v.statementDate, v.dueDate, v.originalCents.toString(),
      v.baseCents.toString(), v.status, v.source, v.sourceNote, v.notes, v.memberName, v.providerName, v.userId]);
}

export async function updateBill(db: Queryable, householdId: string, id: string, version: number, v: {
  providerId: string; providerName: string | null; providerReference: string | null; statementDate: string; dueDate: string | null;
  originalCents: bigint; baseCents: bigint; source: string; sourceNote: string; notes: string;
}): Promise<boolean> {
  const r = await db.query(
    `update bills set provider_id = $4, provider_name_snapshot = coalesce($5, provider_name_snapshot), provider_reference = $6,
       statement_date = $7, due_date = $8, original_cents = $9, base_responsibility_cents = $10, amount_source = $11,
       source_note = $12, notes = $13, version = version + 1, updated_at = now()
     where household_id = $1 and id = $2 and version = $3`,
    [householdId, id, version, v.providerId, v.providerName, v.providerReference, v.statementDate, v.dueDate,
      v.originalCents.toString(), v.baseCents.toString(), v.source, v.sourceNote, v.notes]);
  return r.rowCount === 1;
}

export async function confirmBill(db: Queryable, householdId: string, id: string, version: number, userId: string): Promise<boolean> {
  const r = await db.query(
    `update bills set amount_status = 'confirmed', confirmed_at = now(), confirmed_by = $4, version = version + 1, updated_at = now()
     where household_id = $1 and id = $2 and version = $3 and amount_status = 'estimate'`, [householdId, id, version, userId]);
  return r.rowCount === 1;
}

export async function setBillVisit(db: Queryable, householdId: string, id: string, version: number, visitId: string | null): Promise<boolean> {
  const r = await db.query(
    `update bills set visit_id = $4, version = version + 1, updated_at = now() where household_id = $1 and id = $2 and version = $3`,
    [householdId, id, version, visitId]);
  return r.rowCount === 1;
}

/** Bumps the version after an adjustment so a stale edit form cannot overwrite figures it never saw. */
export async function touchBill(db: Queryable, householdId: string, id: string): Promise<void> {
  await db.query(`update bills set version = version + 1, updated_at = now() where household_id = $1 and id = $2`, [householdId, id]);
}

export async function findDuplicateBills(db: Queryable, householdId: string, c: {
  providerId: string; memberId: string; providerReference: string | null; statementDate: string; originalCents: bigint; excludeId?: string;
}): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `select o.id from bills o where o.household_id = $1 and o.provider_id = $2 and ($7::uuid is null or o.id <> $7)
       and (($3 <> '' and o.reference_norm = $3)
         or (o.member_id = $4 and o.statement_date = $5 and o.original_cents = $6))
     order by o.statement_date desc, o.id limit 10`,
    [householdId, c.providerId, normalizeReference(c.providerReference), c.memberId, c.statementDate, c.originalCents.toString(), c.excludeId ?? null]);
  return rows.map((r) => r.id);
}

/** Must match the generated column bills.reference_norm for ASCII input: lower case with non-alphanumerics removed. */
export function normalizeReference(ref: string | null): string {
  return (ref ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export async function listDuplicatesOf(db: Queryable, householdId: string, id: string): Promise<Array<{
  id: string; providerReference: string | null; statementDate: string; originalCents: string;
}>> {
  const { rows } = await db.query(
    `select o.id, o.provider_reference as "providerReference", o.statement_date::text as "statementDate", o.original_cents::text as "originalCents"
     from bills b join bills o on o.household_id = b.household_id and o.id <> b.id and o.provider_id = b.provider_id
       and ((b.reference_norm <> '' and o.reference_norm = b.reference_norm)
         or (o.member_id = b.member_id and o.statement_date = b.statement_date and o.original_cents = b.original_cents))
     where b.household_id = $1 and b.id = $2 order by o.statement_date desc, o.id limit 10`, [householdId, id]);
  return rows;
}

// ---------- adjustments ----------

export interface Adjustment {
  id: string; billId: string; amountCents: string; category: string; effectiveDate: string; reason: string; source: string;
  sourceNote: string; reversesAdjustmentId: string | null; reversedByAdjustmentId: string | null; createdBy: string | null;
  createdByName: string | null; createdAt: Date;
}

export async function listAdjustments(db: Queryable, householdId: string, billId: string): Promise<Adjustment[]> {
  const { rows } = await db.query<Adjustment>(
    `select a.id, a.bill_id as "billId", a.amount_cents::text as "amountCents", a.category, a.effective_date::text as "effectiveDate",
       a.reason, a.source, a.source_note as "sourceNote", a.reverses_adjustment_id as "reversesAdjustmentId",
       (select r.id from bill_adjustments r where r.reverses_adjustment_id = a.id) as "reversedByAdjustmentId",
       a.created_by as "createdBy", u.display_name as "createdByName", a.created_at as "createdAt"
     from bill_adjustments a left join users u on u.id = a.created_by
     where a.household_id = $1 and a.bill_id = $2 order by a.created_at, a.id`, [householdId, billId]);
  return rows;
}

export async function getAdjustment(db: Queryable, householdId: string, billId: string, id: string): Promise<{
  id: string; amountCents: bigint; category: string; reversedBy: string | null;
} | null> {
  const { rows } = await db.query<{ id: string; amount_cents: string; category: string; reversed_by: string | null }>(
    `select a.id, a.amount_cents::text, a.category, (select r.id from bill_adjustments r where r.reverses_adjustment_id = a.id) as reversed_by
     from bill_adjustments a where a.household_id = $1 and a.bill_id = $2 and a.id = $3`, [householdId, billId, id]);
  const r = rows[0];
  return r ? { id: r.id, amountCents: BigInt(r.amount_cents), category: r.category, reversedBy: r.reversed_by } : null;
}

export async function insertAdjustment(db: Queryable, v: {
  id: string; householdId: string; billId: string; userId: string; amountCents: bigint; category: string; effectiveDate: string;
  reason: string; source: string; sourceNote: string; reverses: string | null;
}): Promise<void> {
  await db.query(
    `insert into bill_adjustments (id, household_id, bill_id, amount_cents, category, effective_date, reason, source, source_note,
       reverses_adjustment_id, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [v.id, v.householdId, v.billId, v.amountCents.toString(), v.category, v.effectiveDate, v.reason, v.source, v.sourceNote, v.reverses, v.userId]);
}

// ---------- idempotency ----------

/**
 * Claims a logical request inside the caller's transaction. Concurrent claims of the same key serialize on the unique
 * index; the loser sees the winner's committed row. Returns the stored result for an exact replay.
 */
export async function claimIdempotency(db: Queryable, v: {
  householdId: string; actorUserId: string; operation: string; key: string; fingerprint: string; resultId: string;
}): Promise<{ replay: false } | { replay: true; resultId: string; sameInput: boolean }> {
  const ins = await db.query(
    `insert into idempotency_records (household_id, actor_user_id, operation, idempotency_key, fingerprint, result_entity_id)
     values ($1, $2, $3, $4, $5, $6) on conflict (household_id, actor_user_id, operation, idempotency_key) do nothing`,
    [v.householdId, v.actorUserId, v.operation, v.key, v.fingerprint, v.resultId]);
  if (ins.rowCount === 1) return { replay: false };
  const { rows } = await db.query<{ fingerprint: string; result_entity_id: string }>(
    `select fingerprint, result_entity_id from idempotency_records
     where household_id = $1 and actor_user_id = $2 and operation = $3 and idempotency_key = $4`,
    [v.householdId, v.actorUserId, v.operation, v.key]);
  const r = rows[0]!;
  return { replay: true, resultId: r.result_entity_id, sameInput: r.fingerprint === v.fingerprint };
}

// ---------- history ----------

export interface HistoryEvent {
  id: string; action: string; entityType: string; entityId: string | null; actorName: string | null; occurredAt: Date;
  detail: Record<string, string | number | boolean | null>;
}

/** Chronological audit events for a bill and its adjustments. */
export async function billHistory(db: Queryable, householdId: string, billId: string): Promise<HistoryEvent[]> {
  const { rows } = await db.query<HistoryEvent>(
    `select e.id::text, e.action, e.entity_type as "entityType", e.entity_id as "entityId", u.display_name as "actorName",
       e.occurred_at as "occurredAt", e.detail
     from audit_events e left join users u on u.id = e.actor_user_id
     where e.household_id = $1 and ((e.entity_type = 'bill' and e.entity_id = $2)
       or (e.entity_type = 'bill_adjustment' and e.detail ->> 'billId' = $2))
     order by e.occurred_at, e.id`, [householdId, billId]);
  return rows;
}
