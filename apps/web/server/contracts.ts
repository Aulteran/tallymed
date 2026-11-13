// Stable contracts for downstream milestones (payments, plans, HSA, documents, MCP). See docs/contracts.md.
import { authorize, type Actor } from './authz.ts';
import type { Pool, Queryable } from './db.ts';
import { AppError } from './errors.ts';
import * as repo from './repositories/expenses.ts';
import * as hsaRepo from './repositories/hsa.ts';
import * as paymentRepo from './repositories/payments.ts';
import { hsaFilterSchemas, parse, schemas } from './validation.ts';

/** Every entity ID is a server-generated, canonical lower-case UUID that never changes and is never reused. */
export const ENTITY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Entity types a document attachment can target. Later milestones add their own types here, one writer per change. */
export const ATTACHMENT_TARGET_TYPES = ['bill', 'visit', 'bill_adjustment', 'hsa_receipt', 'hsa_eligibility_decision'] as const;
export type AttachmentTargetType = (typeof ATTACHMENT_TARGET_TYPES)[number];

export interface AttachmentTarget {
  type: AttachmentTargetType;
  id: string;
  /** Present for adjustments, which are addressed through their bill. */
  billId?: string;
  label: string;
}

/**
 * Resolves an attachment target inside the actor's household. A missing record and another household's record are
 * indistinguishable (not_found). Attachment tables must additionally use a composite foreign key on
 * (household_id, <target id>) so the database enforces the same boundary.
 */
export async function resolveAttachmentTarget(pool: Pool | Queryable, actor: Actor, type: string, id: string): Promise<AttachmentTarget> {
  authorize(actor, 'expenses:read');
  if (!(ATTACHMENT_TARGET_TYPES as readonly string[]).includes(type)) throw new AppError('invalid_input', 'Unknown attachment target type');
  const entityId = parse(schemas.id, id);
  if (type === 'bill') {
    const b = await repo.getBill(pool, actor.householdId, entityId);
    if (!b) throw new AppError('not_found');
    return { type, id: b.id, label: `${b.providerName} bill ${b.providerReference ?? ''}`.trim() };
  }
  if (type === 'visit') {
    const v = await repo.getVisit(pool, actor.householdId, entityId);
    if (!v) throw new AppError('not_found');
    return { type, id: v.id, label: `${v.memberName} visit on ${v.serviceDate}` };
  }
  if (type === 'hsa_receipt') {
    const { rows } = await pool.query<{ received_on: string }>(`select received_on::text from hsa_receipts where household_id = $1 and id = $2`, [actor.householdId, entityId]);
    if (!rows[0]) throw new AppError('not_found');
    return { type, id: entityId, label: `HSA reimbursement received ${rows[0].received_on}` };
  }
  if (type === 'hsa_eligibility_decision') {
    const { rows } = await pool.query<{ decided_on: string }>(`select decided_on::text from hsa_eligibility_decisions where household_id = $1 and id = $2`, [actor.householdId, entityId]);
    if (!rows[0]) throw new AppError('not_found');
    return { type, id: entityId, label: `HSA eligibility decision of ${rows[0].decided_on}` };
  }
  const { rows } = await pool.query<{ bill_id: string }>(
    `select bill_id from bill_adjustments where household_id = $1 and id = $2`, [actor.householdId, entityId]);
  if (!rows[0]) throw new AppError('not_found');
  return { type: 'bill_adjustment', id: entityId, billId: rows[0].bill_id, label: 'Bill adjustment' };
}

/** Wire shape for a bill: every amount is a decimal string of integer cents. */
export interface BillContract {
  id: string; memberId: string; providerId: string; visitId: string | null; providerReference: string | null;
  statementDate: string; dueDate: string | null; amountStatus: 'estimate' | 'confirmed';
  originalCents: string; baseResponsibilityCents: string; adjustmentsCents: string; responsibilityCents: string;
  appliedCents: string; openBalanceCents: string; creditCents: string;
  version: number;
}

export function billContract(b: repo.Bill): BillContract {
  return {
    id: b.id, memberId: b.memberId, providerId: b.providerId, visitId: b.visitId, providerReference: b.providerReference,
    statementDate: b.statementDate, dueDate: b.dueDate, amountStatus: b.amountStatus, originalCents: b.originalCents,
    baseResponsibilityCents: b.baseResponsibilityCents, adjustmentsCents: b.adjustmentsCents, responsibilityCents: b.responsibilityCents,
    appliedCents: b.appliedCents, openBalanceCents: b.openBalanceCents, creditCents: b.creditCents, version: b.version,
  };
}

/**
 * Locking contract for services that move money against bills (M03 and later): call inside one transaction, with all
 * affected bill IDs, before reading balances. Rows lock in ascending ID order so concurrent multi-bill writes cannot deadlock.
 * Bill responsibility = base responsibility + sum of adjustments. Open balance = responsibility minus net applied payments.
 */
export const lockBillsForMoney = repo.lockBills;

// ---------- payments (M03): stable net-payment and refund interface for HSA reconciliation (M04) ----------

/**
 * Net cash per payment allocation, the ceiling that HSA eligibility and reservations sit under. All amounts are decimal
 * strings of integer cents. `netCents = allocatedCents - reversedCents - refundedCents` (voided payments hold zero).
 * `refundedCents` already nets out refund reversals, so a later refund shows up here and lowers `netCents`; a claim line
 * that now exceeds its ceiling is the caller's "needs review" case. `matchedCents` is plan matching, not cash.
 */
export interface NetAllocationContract {
  allocationId: string; paymentId: string; billId: string; memberId: string; providerId: string; paidOn: string;
  allocatedCents: string; reversedCents: string; refundedCents: string; netCents: string; matchedCents: string;
}

export interface NetAllocationPage { items: NetAllocationContract[]; nextCursor: string | null }

/**
 * One page of net allocations, newest first. `nextCursor` is non-null when more rows exist; pass it back as `cursor`. A caller
 * that needs every allocation (a reconciliation or ceiling check) must follow cursors until it is null: a result is never
 * silently truncated.
 */
export async function listNetAllocations(pool: Pool | Queryable, actor: Actor, filter: { billIds?: string[]; paymentIds?: string[]; memberId?: string; from?: string; to?: string; limit?: number; cursor?: string } = {}): Promise<NetAllocationPage> {
  authorize(actor, 'expenses:read');
  const { cursor, ...rest } = filter;
  let after: { paidOn: string; allocationId: string } | undefined;
  if (cursor) {
    const m = /^(\d{4}-\d{2}-\d{2})_([0-9a-f-]{36})$/.exec(cursor);
    if (!m) throw new AppError('invalid_input', 'That page cursor is not valid');
    after = { paidOn: m[1]!, allocationId: m[2]! };
  }
  const limit = Math.max(1, Math.min(filter.limit ?? 500, 1000));
  const rows = await paymentRepo.listAllocationsNet(pool, actor.householdId, { ...rest, limit: limit + 1, after });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({
      allocationId: r.allocationId, paymentId: r.paymentId, billId: r.billId, memberId: r.memberId, providerId: r.providerId, paidOn: r.paidOn,
      allocatedCents: r.allocatedCents, reversedCents: r.reversedCents, refundedCents: r.refundedCents, netCents: r.netCents, matchedCents: r.matchedCents,
    })),
    nextCursor: rows.length > limit && last ? `${last.paidOn}_${last.allocationId}` : null,
  };
}

/**
 * Locking contract for services that depend on net cash (HSA reservations and receipts): inside one transaction, lock the
 * payments behind the allocations (`lockPaymentsForMoney`, ascending id), then the bills if needed (`lockBillsForMoney`), then
 * read `listNetAllocations`. Refunds, reversals and plan releases take the same payment lock first, so a ceiling check and
 * its write cannot interleave with a refund. Global lock order: payments (ascending id), then bills (ascending id), then plans (ascending id); never take an earlier kind while holding a later one.
 */
export const lockPaymentsForMoney = paymentRepo.lockPayments;

// ---------- HSA reimbursements (M04): stable figures for reports, exports and the MCP (M06) ----------

/**
 * HSA reconciliation figures per payment allocation, all decimal strings of integer cents. `ceilingCents` is the lesser of the
 * decided eligible amount and `netCents` (zero while undecided, pending or ineligible). `pendingCents` is open reserved cents,
 * `receivedCents` is receipts less their reversals, `availableCents = max(0, ceiling - pending - received)` and
 * `needsReviewCents = max(0, pending + received - ceiling)`. HSA rows never alter bill or payment figures.
 */
export interface HsaAllocationContract {
  allocationId: string; paymentId: string; billId: string; memberId: string; providerId: string; paidOn: string; netCents: string;
  decisionStatus: 'eligible' | 'ineligible' | 'pending' | null; ceilingCents: string; pendingCents: string; receivedCents: string;
  availableCents: string; needsReviewCents: string;
}

/** One page of HSA figures, newest payment first; follow `nextCursor` until null for every row. Filters match the HSA screens. */
export async function listHsaFigures(pool: Pool | Queryable, actor: Actor, filter: { memberId?: string; providerId?: string; from?: string; to?: string; state?: string; limit?: number; cursor?: string } = {}): Promise<{ items: HsaAllocationContract[]; nextCursor: string | null }> {
  authorize(actor, 'expenses:read');
  const page = await hsaRepo.listAllocations(pool, actor.householdId, parse(hsaFilterSchemas.allocations, { ...filter, limit: String(Math.max(1, Math.min(filter.limit ?? 100, 100))) }));
  return {
    items: page.items.map((a) => ({
      allocationId: a.allocationId, paymentId: a.paymentId, billId: a.billId, memberId: a.memberId, providerId: a.providerId, paidOn: a.paidOn, netCents: a.netCents,
      decisionStatus: a.decisionStatus, ceilingCents: a.ceilingCents, pendingCents: a.pendingCents, receivedCents: a.receivedCents,
      availableCents: a.availableCents, needsReviewCents: a.needsReviewCents,
    })),
    nextCursor: page.nextCursor,
  };
}
