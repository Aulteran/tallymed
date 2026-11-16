// SQL only for HSA accounts, the link from an HSA card (a saved payment method) to its account, and payments paid directly from an HSA.
// Every query is scoped by household_id; services own authorization, locking, transactions and audit. Never stores a card or account
// number: a name, the administrator and the last four digits at most.
import type { Queryable } from '../db.ts';

export type Lock = 'update' | 'share' | false;

export interface HsaAccount {
  id: string; name: string; administrator: string; lastFour: string | null; archivedAt: Date | null; version: number; createdAt: Date; updatedAt: Date;
}
const COLS = `a.id, a.name, a.administrator, a.last_four as "lastFour", a.archived_at as "archivedAt", a.version, a.created_at as "createdAt", a.updated_at as "updatedAt"`;

export async function getAccount(db: Queryable, householdId: string, id: string, lock: Lock = false): Promise<HsaAccount | null> {
  const { rows } = await db.query<HsaAccount>(
    `select ${COLS} from hsa_accounts a where a.household_id = $1 and a.id = $2${lock ? ` for ${lock} of a` : ''}`, [householdId, id]);
  return rows[0] ?? null;
}

/** A household has a few accounts; the list is capped. `currentId` keeps one archived account visible in a select. */
export const ACCOUNT_LIST_LIMIT = 100;
export async function listAccounts(db: Queryable, householdId: string, o: { archived: boolean; currentId?: string | null }): Promise<{ items: HsaAccount[]; truncated: boolean }> {
  const { rows } = await db.query<HsaAccount>(
    `select ${COLS} from hsa_accounts a where a.household_id = $1 and (a.archived_at is null or $2::boolean or a.id = $3::uuid)
     order by (a.archived_at is not null), lower(a.name), a.id limit $4`, [householdId, o.archived, o.currentId ?? null, ACCOUNT_LIST_LIMIT + 1]);
  return { items: rows.slice(0, ACCOUNT_LIST_LIMIT), truncated: rows.length > ACCOUNT_LIST_LIMIT };
}

export async function insertAccount(db: Queryable, v: { householdId: string; userId: string; name: string; administrator: string; lastFour: string | null }): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into hsa_accounts (household_id, name, administrator, last_four, created_by) values ($1, $2, $3, $4, $5) returning id`,
    [v.householdId, v.name, v.administrator, v.lastFour, v.userId]);
  return rows[0]!.id;
}

export async function updateAccount(db: Queryable, householdId: string, id: string, version: number, v: { name: string; administrator: string; lastFour: string | null }): Promise<boolean> {
  const r = await db.query(
    `update hsa_accounts set name = $4, administrator = $5, last_four = $6, version = version + 1, updated_at = now()
     where household_id = $1 and id = $2 and version = $3`, [householdId, id, version, v.name, v.administrator, v.lastFour]);
  return r.rowCount === 1;
}

export async function setAccountArchived(db: Queryable, householdId: string, id: string, version: number, archived: boolean): Promise<boolean> {
  const r = await db.query(
    `update hsa_accounts set archived_at = case when $4::boolean then coalesce(archived_at, now()) else null end, version = version + 1, updated_at = now()
     where household_id = $1 and id = $2 and version = $3`, [householdId, id, version, archived]);
  return r.rowCount === 1;
}

/** The HSA account a saved payment method draws from, or null. Read after the method row is locked, so the link cannot change under the caller. */
export async function linkOfMethod(db: Queryable, householdId: string, methodId: string, lock: Lock = false): Promise<string | null> {
  const { rows } = await db.query<{ accountId: string }>(
    `select hsa_account_id as "accountId" from payment_method_hsa_links where household_id = $1 and method_id = $2${lock ? ` for ${lock}` : ''}`, [householdId, methodId]);
  return rows[0]?.accountId ?? null;
}

export async function setLink(db: Queryable, v: { householdId: string; userId: string; methodId: string; accountId: string | null }): Promise<void> {
  if (v.accountId === null) {
    await db.query(`delete from payment_method_hsa_links where household_id = $1 and method_id = $2`, [v.householdId, v.methodId]);
    return;
  }
  await db.query(
    `insert into payment_method_hsa_links (method_id, household_id, hsa_account_id, created_by) values ($1, $2, $3, $4)
     on conflict (method_id) do update set hsa_account_id = excluded.hsa_account_id`, [v.methodId, v.householdId, v.accountId, v.userId]);
}

/** The HSA account that paid a payment directly, or null for an ordinary payment (or one whose funding was released). */
export async function fundingOfPayment(db: Queryable, householdId: string, paymentId: string): Promise<string | null> {
  const { rows } = await db.query<{ accountId: string }>(
    `select hsa_account_id as "accountId" from payment_hsa_funding where household_id = $1 and payment_id = $2 and payment_is_direct_hsa(payment_id)`, [householdId, paymentId]);
  return rows[0]?.accountId ?? null;
}

/** Appends a release (the payment becomes an ordinary, claimable payment) or a reinstatement of its direct HSA funding. */
export async function insertFundingEvent(db: Queryable, v: { householdId: string; userId: string; paymentId: string; action: 'release' | 'reinstate' }): Promise<void> {
  await db.query(`insert into payment_hsa_funding_events (household_id, payment_id, action, created_by) values ($1, $2, $3, $4)`, [v.householdId, v.paymentId, v.action, v.userId]);
}

export async function insertFunding(db: Queryable, v: { householdId: string; userId: string; paymentId: string; accountId: string }): Promise<void> {
  await db.query(
    `insert into payment_hsa_funding (payment_id, household_id, hsa_account_id, created_by) values ($1, $2, $3, $4)`, [v.paymentId, v.householdId, v.accountId, v.userId]);
}

export interface AccountUse { accountId: string; paymentCount: number; netCashCents: string }

/** Per account: payments paid directly and their net cash, by the cash summary's definition. `from` is the payments query's FROM clause. */
export async function accountUse(db: Queryable, from: string, householdId: string): Promise<AccountUse[]> {
  const { rows } = await db.query<AccountUse>(
    `select hf.hsa_account_id as "accountId", count(*)::int as "paymentCount",
       coalesce(sum(case when v.payment_id is null then p.amount_cents - c.refunded else 0 end), 0)::text as "netCashCents"
     ${from} where p.household_id = $1 and hf.payment_id is not null group by hf.hsa_account_id`, [householdId]);
  return rows;
}
