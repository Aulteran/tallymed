// SQL only for saved payment methods and the history of which method paid a payment. Every query is scoped by household_id; services own
// authorization, locking, transactions and audit. Never stores a full card or account number: a nickname and the last four digits at most.
import type { Queryable } from '../db.ts';

export type Lock = 'update' | 'share' | false;
export const METHOD_KINDS = ['credit_card', 'debit_card', 'hsa_fsa_card', 'bank_account', 'other'] as const;

export interface PaymentMethod {
  id: string; nickname: string; kind: string; lastFour: string | null; archivedAt: Date | null; version: number; createdAt: Date; updatedAt: Date;
}
const COLS = `m.id, m.nickname, m.kind, m.last_four as "lastFour", m.archived_at as "archivedAt", m.version, m.created_at as "createdAt", m.updated_at as "updatedAt"`;

export async function getMethod(db: Queryable, householdId: string, id: string, lock: Lock = false): Promise<PaymentMethod | null> {
  const { rows } = await db.query<PaymentMethod>(
    `select ${COLS} from payment_methods m where m.household_id = $1 and m.id = $2${lock ? ` for ${lock} of m` : ''}`, [householdId, id]);
  return rows[0] ?? null;
}

/** A household has a handful of methods; the list is capped so a page can never grow without bound. `truncated` says more exist. */
export const METHOD_LIST_LIMIT = 100;
export async function listMethods(db: Queryable, householdId: string, o: { archived: boolean; currentId?: string | null }): Promise<{ items: PaymentMethod[]; truncated: boolean }> {
  const { rows } = await db.query<PaymentMethod>(
    `select ${COLS} from payment_methods m where m.household_id = $1 and (m.archived_at is null or $2::boolean or m.id = $3::uuid)
     order by (m.archived_at is not null), lower(m.nickname), m.id limit $4`, [householdId, o.archived, o.currentId ?? null, METHOD_LIST_LIMIT + 1]);
  return { items: rows.slice(0, METHOD_LIST_LIMIT), truncated: rows.length > METHOD_LIST_LIMIT };
}

export async function insertMethod(db: Queryable, v: { householdId: string; userId: string; nickname: string; kind: string; lastFour: string | null }): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into payment_methods (household_id, nickname, kind, last_four, created_by) values ($1, $2, $3, $4, $5) returning id`,
    [v.householdId, v.nickname, v.kind, v.lastFour, v.userId]);
  return rows[0]!.id;
}

export async function updateMethod(db: Queryable, householdId: string, id: string, version: number, v: { nickname: string; kind: string; lastFour: string | null }): Promise<boolean> {
  const r = await db.query(
    `update payment_methods set nickname = $4, kind = $5, last_four = $6, version = version + 1, updated_at = now()
     where household_id = $1 and id = $2 and version = $3`, [householdId, id, version, v.nickname, v.kind, v.lastFour]);
  return r.rowCount === 1;
}

export async function setMethodArchived(db: Queryable, householdId: string, id: string, version: number, archived: boolean): Promise<boolean> {
  const r = await db.query(
    `update payment_methods set archived_at = case when $4::boolean then coalesce(archived_at, now()) else null end, version = version + 1, updated_at = now()
     where household_id = $1 and id = $2 and version = $3`, [householdId, id, version, archived]);
  return r.rowCount === 1;
}

/** The method currently recorded for a payment, or null when none (never recorded, or cleared). */
export async function currentMethodId(db: Queryable, householdId: string, paymentId: string): Promise<string | null> {
  const { rows } = await db.query<{ methodId: string | null }>(
    `select method_id as "methodId" from payment_method_assignments where household_id = $1 and payment_id = $2 order by seq desc limit 1`, [householdId, paymentId]);
  return rows[0]?.methodId ?? null;
}

export async function insertAssignment(db: Queryable, v: { id: string; householdId: string; userId: string; paymentId: string; methodId: string | null }): Promise<void> {
  await db.query(
    `insert into payment_method_assignments (id, household_id, payment_id, method_id, created_by) values ($1, $2, $3, $4, $5)`,
    [v.id, v.householdId, v.paymentId, v.methodId, v.userId]);
}

export interface MethodUse { methodId: string | null; paymentCount: number; netCashCents: string }

/**
 * Per current method (null: no method recorded): how many payments and how much cash, using the same definition as the cash summary
 * (voided counts zero, refunds are subtracted). `from` is the payments query's FROM clause, so the definition lives in one place.
 */
export async function methodUse(db: Queryable, from: string, householdId: string): Promise<MethodUse[]> {
  const { rows } = await db.query<MethodUse>(
    `select cur.method_id as "methodId", count(*)::int as "paymentCount",
       coalesce(sum(case when v.payment_id is null then p.amount_cents - c.refunded else 0 end), 0)::text as "netCashCents"
     ${from} where p.household_id = $1 group by cur.method_id`, [householdId]);
  return rows;
}
