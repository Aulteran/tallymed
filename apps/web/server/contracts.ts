// Stable contracts for downstream milestones (payments, plans, HSA, documents, MCP). See docs/contracts.md.
import { authorize, type Actor } from './authz.ts';
import type { Pool, Queryable } from './db.ts';
import { AppError } from './errors.ts';
import * as repo from './repositories/expenses.ts';
import { parse, schemas } from './validation.ts';

/** Every entity ID is a server-generated, canonical lower-case UUID that never changes and is never reused. */
export const ENTITY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Entity types a document attachment can target. Later milestones add their own types here, one writer per change. */
export const ATTACHMENT_TARGET_TYPES = ['bill', 'visit', 'bill_adjustment'] as const;
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
  const { rows } = await pool.query<{ bill_id: string }>(
    `select bill_id from bill_adjustments where household_id = $1 and id = $2`, [actor.householdId, entityId]);
  if (!rows[0]) throw new AppError('not_found');
  return { type: 'bill_adjustment', id: entityId, billId: rows[0].bill_id, label: 'Bill adjustment' };
}

/** Wire shape for a bill: every amount is a decimal string of integer cents. */
export interface BillContract {
  id: string; memberId: string; providerId: string; visitId: string | null; providerReference: string | null;
  statementDate: string; dueDate: string | null; amountStatus: 'estimate' | 'confirmed';
  originalCents: string; baseResponsibilityCents: string; adjustmentsCents: string; responsibilityCents: string; openBalanceCents: string;
  version: number;
}

export function billContract(b: repo.Bill): BillContract {
  return {
    id: b.id, memberId: b.memberId, providerId: b.providerId, visitId: b.visitId, providerReference: b.providerReference,
    statementDate: b.statementDate, dueDate: b.dueDate, amountStatus: b.amountStatus, originalCents: b.originalCents,
    baseResponsibilityCents: b.baseResponsibilityCents, adjustmentsCents: b.adjustmentsCents, responsibilityCents: b.responsibilityCents,
    openBalanceCents: b.openBalanceCents, version: b.version,
  };
}

/**
 * Locking contract for services that move money against bills (M03 and later): call inside one transaction, with all
 * affected bill IDs, before reading balances. Rows lock in ascending ID order so concurrent multi-bill writes cannot deadlock.
 * Bill responsibility = base responsibility + sum of adjustments. Open balance = responsibility minus net applied payments.
 */
export const lockBillsForMoney = repo.lockBills;
