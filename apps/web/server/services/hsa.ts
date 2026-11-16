// Use cases for HSA reimbursements: eligibility decisions with evidence, claim reservations, receipts, releases and reversals.
// Every mutation authorizes, validates, locks, writes and audits in one transaction. HSA writers lock the payments behind the
// allocations they touch (ascending id) before reading any figure, the first step of the global lock order (payments, bills,
// plans), and take no bill or plan lock at all, so they can never lock out of order. Money is bigint cents. HSA rows never touch
// payment_entries: a receipt does not change a bill or provider balance.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { authorize, can, type Actor } from '../authz.ts';
import { withSnapshot, withTransaction, type Pool, type Queryable } from '../db.ts';
import { AppError } from '../errors.ts';
import { recordAudit } from '../repositories/audit.ts';
import * as repo from '../repositories/hsa.ts';
import * as paymentRepo from '../repositories/payments.ts';
import { setUndoSlot, type UndoKind } from '../repositories/undo.ts';
import { hsaFilterSchemas, hsaSchemas, parse, schemas } from '../validation.ts';
import { idempotent, withRetry, type Detail } from './support.ts';

const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
const cents = (v: bigint) => v.toString();
const byId = <T,>(key: (x: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);

/** Before and after figures of one allocation, for audit detail that keeps the money trail of every consequential change. */
function figures(before: repo.HsaAllocation, after: repo.HsaAllocation): Detail {
  return {
    ceilingBeforeCents: before.ceilingCents, ceilingAfterCents: after.ceilingCents, pendingBeforeCents: before.pendingCents, pendingAfterCents: after.pendingCents,
    receivedBeforeCents: before.receivedCents, receivedAfterCents: after.receivedCents, availableBeforeCents: before.availableCents, availableAfterCents: after.availableCents,
    needsReviewBeforeCents: before.needsReviewCents, needsReviewAfterCents: after.needsReviewCents,
  };
}

/**
 * Locks the payments behind the allocations (ascending id). The allocation-to-payment link never changes, so the unlocked probe is
 * safe. Every figure is read after this returns. With `newExposure` (a decision, a claim or an external reimbursement) a removed or
 * voided payment is refused: it would gain HSA rows that can never be undone, and a removed payment could then not be removed again.
 * Settling what already exists (release, receipt, reversal) passes no flag and stays possible.
 */
async function lockForAllocations(tx: Queryable, actor: Actor, allocationIds: string[], o: { newExposure?: boolean } = {}): Promise<Map<string, string>> {
  const unique = [...new Set(allocationIds)];
  const links = await repo.allocationPayments(tx, actor.householdId, unique);
  if (links.length !== unique.length) throw new AppError('not_found');
  const paymentIds = [...new Set(links.map((l) => l.paymentId))];
  const locked = await paymentRepo.lockPayments(tx, actor.householdId, paymentIds);
  if (locked.length !== paymentIds.length) throw new AppError('not_found');
  if (o.newExposure && (await repo.closedPayments(tx, actor.householdId, paymentIds)).length > 0) {
    throw new AppError('conflict', 'That payment was removed or voided, so it takes no eligibility decisions, claims or reimbursements.');
  }
  return new Map(links.map((l) => [l.allocationId, l.paymentId]));
}

async function freshAllocation(tx: Queryable, actor: Actor, id: string): Promise<repo.HsaAllocation> {
  const a = await repo.getAllocation(tx, actor.householdId, id);
  if (!a) throw new AppError('not_found');
  return a;
}

// ---------- reads ----------

export async function hsaSummary(pool: Pool | Queryable, actor: Actor, raw: unknown) {
  authorize(actor, 'expenses:read');
  return repo.totals(pool, actor.householdId, parse(hsaFilterSchemas.scope, raw));
}

export async function listHsaAllocations(pool: Pool | Queryable, actor: Actor, raw: unknown) {
  authorize(actor, 'expenses:read');
  return repo.listAllocations(pool, actor.householdId, parse(hsaFilterSchemas.allocations, raw));
}

/** Actionable queues for the overview: allocations with available cash, and allocations that need review. */
export async function hsaQueues(pool: Pool | Queryable, actor: Actor, raw: unknown, limit = 5) {
  authorize(actor, 'expenses:read');
  const scope = parse(hsaFilterSchemas.scope, raw);
  const [available, needsReview] = await Promise.all([
    repo.queue(pool, actor.householdId, 'available', scope, limit), repo.queue(pool, actor.householdId, 'needs_review', scope, limit),
  ]);
  return { available, needsReview };
}

export async function getHsaAllocationDetail(pool: Pool, actor: Actor, id: string) {
  authorize(actor, 'expenses:read');
  const allocationId = parse(schemas.id, id);
  const allocation = await repo.getAllocation(pool, actor.householdId, allocationId);
  if (!allocation || await repo.paymentRemoved(pool, actor.householdId, allocation.paymentId)) throw new AppError('not_found');
  const admin = can(actor, 'records:remove');
  const [rows, lines, entries, history, deletable] = await Promise.all([
    repo.listDecisions(pool, actor.householdId, allocationId), repo.linesOfAllocation(pool, actor.householdId, allocationId),
    repo.listEntriesOfAllocation(pool, actor.householdId, allocationId), repo.history(pool, actor.householdId, 'allocationId', allocationId),
    admin ? repo.decisionsDeletable(pool, actor.householdId, allocationId) : Promise.resolve(null),
  ]);
  // `deletable` is for administrators only (operators get null): whether Delete is available on that decision, and why not.
  const decisions = rows.map((d) => ({ ...d, deletable: deletable ? deletable.get(d.id) ?? null : null }));
  return { allocation, decisions, lines, entries, history };
}

export async function listHsaClaims(pool: Pool, actor: Actor, raw: unknown) {
  authorize(actor, 'expenses:read');
  return repo.listClaims(pool, actor.householdId, parse(hsaFilterSchemas.claims, raw));
}

export async function getHsaClaimDetail(pool: Pool, actor: Actor, id: string) {
  authorize(actor, 'expenses:read');
  const claimId = parse(schemas.id, id);
  const claim = await repo.getClaim(pool, actor.householdId, claimId);
  if (!claim) throw new AppError('not_found');
  const [lines, entries, history, deletable] = await Promise.all([
    repo.linesOfClaim(pool, actor.householdId, claimId), repo.listEntriesOfClaim(pool, actor.householdId, claimId), repo.history(pool, actor.householdId, 'claimId', claimId),
    can(actor, 'records:remove') ? repo.claimDeletable(pool, actor.householdId, claimId) : Promise.resolve(null),
  ]);
  return { claim, lines, entries, history, deletable };
}

export async function listHsaReceipts(pool: Pool, actor: Actor, raw: unknown) {
  authorize(actor, 'expenses:read');
  const f = parse(hsaFilterSchemas.claims, raw);
  return repo.listReceipts(pool, actor.householdId, { cursor: f.cursor, limit: f.limit });
}

export async function getHsaReceiptDetail(pool: Pool, actor: Actor, id: string) {
  authorize(actor, 'expenses:read');
  const receiptId = parse(schemas.id, id);
  const receipt = await repo.getReceipt(pool, actor.householdId, receiptId);
  if (!receipt) throw new AppError('not_found');
  const [entries, history, deletable] = await Promise.all([
    repo.listEntriesOfReceipt(pool, actor.householdId, receiptId), repo.history(pool, actor.householdId, 'receiptId', receiptId),
    can(actor, 'records:remove') ? repo.receiptDeletable(pool, actor.householdId, receiptId) : Promise.resolve(null),
  ]);
  return { receipt, entries, history, deletable };
}

// ---------- writes ----------

/**
 * Records an eligibility decision for one payment allocation. A decision is a user judgment with rationale and evidence; a date,
 * a category or a suggestion alone never certifies eligibility. Decisions are immutable rows, the latest is current, and
 * lowering one below what is pending or received is allowed: nothing already received is lost, the allocation shows as "needs
 * review" and new claims are frozen until the excess is resolved. `version` is the decision version the person saw (every decision and every removal or restore of one counts).
 */
export async function recordDecision(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string; replayed: boolean }> {
  authorize(actor, 'expenses:write');
  const { csrf: _csrf, idempotencyKey, allocationId, version, ...d } = parse(hsaSchemas.decide, input);
  const id = randomUUID();
  return withRetry(() => withTransaction(pool, async (tx) => {
    const replayId = await idempotent(tx, actor, 'hsa.decide', idempotencyKey, { allocationId, version, ...d }, id);
    if (replayId) return { id: replayId, replayed: true };
    const links = await lockForAllocations(tx, actor, [allocationId], { newExposure: true });
    const before = await freshAllocation(tx, actor, allocationId);
    if (before.directHsa) throw new AppError('conflict', 'This payment was paid directly from an HSA at the point of service, so there is nothing to claim and no eligibility decision to record.');
    if (before.decisionVersion !== version) throw new AppError('stale_version', 'The eligibility decision changed since you loaded it. Reload and decide again.');
    const eligible = d.status === 'eligible' ? d.eligibleAmount! : 0n;
    if (eligible > BigInt(before.netCents)) throw new AppError('conflict', 'The eligible amount is more than the net cash this allocation still holds');
    await repo.insertDecision(tx, {
      id, householdId: actor.householdId, userId: actor.userId, paymentId: links.get(allocationId)!, allocationId, billId: before.billId, status: d.status,
      eligibleCents: eligible, rationale: d.rationale, evidenceType: d.evidenceType, evidenceNote: d.evidenceNote, contextNote: d.contextNote, decidedOn: d.decidedOn,
    });
    const after = await freshAllocation(tx, actor, allocationId);
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'hsa.decision_recorded', entityType: 'hsa_allocation', entityId: allocationId, requestId,
      detail: {
        allocationId, paymentId: before.paymentId, billId: before.billId, decisionId: id, status: d.status, previousStatus: before.decisionStatus, decidedOn: d.decidedOn,
        evidenceType: d.evidenceType, eligibleBeforeCents: before.decidedCents, eligibleAfterCents: cents(eligible), netCashCents: before.netCents, ...figures(before, after),
      },
    });
    return { id, replayed: false };
  }));
}

/**
 * Submits a claim. Each line reserves cents against one allocation, within what is still available (the ceiling less pending
 * and received) and only while the allocation has nothing to review. Payments lock first, in ascending id, so two claims (or a
 * claim and a refund) cannot interleave; the commit-time guard re-checks the same limit. One idempotency key is one claim.
 */
export async function submitClaim(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string; replayed: boolean }> {
  authorize(actor, 'expenses:write');
  const { csrf: _csrf, idempotencyKey, lines, ...c } = parse(hsaSchemas.submitClaim, input);
  const claimId = randomUUID();
  return withRetry(() => withTransaction(pool, async (tx) => {
    const replayId = await idempotent(tx, actor, 'hsa.claim', idempotencyKey, { ...c, lines }, claimId);
    if (replayId) return { id: replayId, replayed: true };
    const links = await lockForAllocations(tx, actor, lines.map((l) => l.allocationId), { newExposure: true });
    if (c.reference && await repo.claimReferenceExists(tx, actor.householdId, c.reference)) throw new AppError('conflict', 'A claim with that reference was already recorded');
    await repo.insertClaim(tx, { id: claimId, householdId: actor.householdId, userId: actor.userId, submittedOn: c.submittedOn, administrator: c.administrator, reference: c.reference, note: c.note });
    const eventId = randomUUID();
    let total = 0n;
    for (const line of [...lines].sort(byId((l) => l.allocationId))) {
      const before = await freshAllocation(tx, actor, line.allocationId);
      if (before.directHsa) throw new AppError('conflict', 'This payment was paid directly from an HSA at the point of service, so there is nothing to claim and no eligibility decision to record.');
      if (BigInt(before.needsReviewCents) > 0n) throw new AppError('conflict', 'This payment needs review (pending or received reimbursement is above its eligible amount). Resolve that before claiming more.');
      if (line.amount > BigInt(before.availableCents)) throw new AppError('conflict', 'That claim is more than the amount still available for this payment');
      const lineId = randomUUID();
      await repo.insertEntry(tx, {
        id: lineId, householdId: actor.householdId, userId: actor.userId, paymentId: links.get(line.allocationId)!, allocationId: line.allocationId, billId: before.billId,
        eventId, kind: 'reserve', claimId, lineId, receiptId: null, amountCents: line.amount, effectiveDate: c.submittedOn, reason: '',
      });
      const after = await freshAllocation(tx, actor, line.allocationId);
      await recordAudit(tx, {
        householdId: actor.householdId, actorUserId: actor.userId, action: 'hsa.reserved', entityType: 'hsa_allocation', entityId: line.allocationId, requestId,
        detail: { allocationId: line.allocationId, paymentId: before.paymentId, claimId, lineId, eventId, amountCents: cents(line.amount), ...figures(before, after) },
      });
      total += line.amount;
    }
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'hsa.claim_submitted', entityType: 'hsa_claim', entityId: claimId, requestId,
      detail: { claimId, eventId, submittedOn: c.submittedOn, lineCount: lines.length, amountCents: cents(total), hasReference: c.reference !== null },
    });
    return { id: claimId, replayed: false };
  }));
}

/** Rejects or cancels the open reservation of a claim line (all of it by default), releasing the amount back to available. */
export async function releaseClaimLine(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string; replayed: boolean }> {
  authorize(actor, 'expenses:write');
  const { csrf: _csrf, idempotencyKey, claimId, allocationId, ...d } = parse(hsaSchemas.releaseLine, input);
  const id = randomUUID();
  return withRetry(() => withTransaction(pool, async (tx) => {
    const replayId = await idempotent(tx, actor, 'hsa.release', idempotencyKey, d, id);
    if (replayId) return { id: replayId, replayed: true };
    const [probe] = await repo.linesById(tx, actor.householdId, [d.lineId]);
    if (!probe) throw new AppError('not_found');
    await lockForAllocations(tx, actor, [probe.allocationId]);
    const [line] = await repo.linesById(tx, actor.householdId, [d.lineId]);
    if (!line) throw new AppError('not_found');
    // The form's claim and payment fields only steer redirects; a mismatch means a mixed-up or tampered request.
    if ((claimId && claimId !== line.claimId) || (allocationId && allocationId !== line.allocationId)) throw new AppError('invalid_input');
    const open = BigInt(line.pendingCents);
    const amount = d.amount ?? open;
    if (open <= 0n) throw new AppError('conflict', 'Nothing is left to release on that claim line');
    if (amount > open) throw new AppError('conflict', 'That is more than is still reserved on the claim line');
    const before = await freshAllocation(tx, actor, line.allocationId);
    await repo.insertEntry(tx, {
      id, householdId: actor.householdId, userId: actor.userId, paymentId: line.paymentId, allocationId: line.allocationId, billId: line.billId, eventId: randomUUID(),
      kind: d.kind, claimId: line.claimId, lineId: line.lineId, receiptId: null, amountCents: amount, effectiveDate: d.effectiveDate, reason: d.reason,
    });
    const after = await freshAllocation(tx, actor, line.allocationId);
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: d.kind === 'reject' ? 'hsa.rejected' : 'hsa.canceled', entityType: 'hsa_allocation', entityId: line.allocationId, requestId,
      detail: {
        allocationId: line.allocationId, paymentId: line.paymentId, claimId: line.claimId, lineId: line.lineId, amountCents: cents(amount),
        linePendingBeforeCents: cents(open), linePendingAfterCents: cents(open - amount), ...figures(before, after),
      },
    });
    return { id, replayed: false };
  }));
}

/**
 * Records a reimbursement received for claim lines. One receipt can pay several lines (a split) and one line can be paid by
 * several receipts (partial payments). Each amount is limited to what the line still has reserved, so received cash moves
 * pending to received and never changes the ceiling. A receipt is allocated in full: its amount is the sum of its lines.
 */
export async function recordReceipt(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string; replayed: boolean }> {
  authorize(actor, 'expenses:write');
  const { csrf: _csrf, idempotencyKey, lines, claimId: _claimId, ...r0 } = parse(hsaSchemas.recordReceipt, input);
  const r = { ...r0, claimId: _claimId };
  const receiptId = randomUUID();
  return withRetry(() => withTransaction(pool, async (tx) => {
    const replayId = await idempotent(tx, actor, 'hsa.receipt', idempotencyKey, { ...r, lines }, receiptId);
    if (replayId) return { id: replayId, replayed: true };
    const probe = await repo.linesById(tx, actor.householdId, lines.map((l) => l.lineId));
    if (probe.length !== lines.length) throw new AppError('not_found');
    await lockForAllocations(tx, actor, probe.map((l) => l.allocationId));
    const fresh = new Map((await repo.linesById(tx, actor.householdId, lines.map((l) => l.lineId))).map((l) => [l.lineId, l]));
    const total = sum(lines.map((l) => l.amount));
    for (const l of lines) {
      const line = fresh.get(l.lineId);
      if (!line) throw new AppError('not_found');
      if (r.claimId && r.claimId !== line.claimId) throw new AppError('invalid_input');
      if (l.amount > BigInt(line.pendingCents)) throw new AppError('conflict', 'That receipt is more than is still reserved on the claim line');
    }
    await repo.insertReceipt(tx, {
      id: receiptId, householdId: actor.householdId, userId: actor.userId, receivedOn: r.receivedOn, amountCents: total, origin: 'claim', source: r.source,
      reference: r.reference, evidenceType: r.evidenceType, evidenceNote: r.evidenceNote, note: r.note,
    });
    const eventId = randomUUID();
    for (const l of [...lines].sort(byId((x) => x.lineId))) {
      const line = fresh.get(l.lineId)!;
      const before = await freshAllocation(tx, actor, line.allocationId);
      await repo.insertEntry(tx, {
        id: randomUUID(), householdId: actor.householdId, userId: actor.userId, paymentId: line.paymentId, allocationId: line.allocationId, billId: line.billId, eventId,
        kind: 'receipt', claimId: line.claimId, lineId: line.lineId, receiptId, amountCents: l.amount, effectiveDate: r.receivedOn, reason: '',
      });
      const after = await freshAllocation(tx, actor, line.allocationId);
      await recordAudit(tx, {
        householdId: actor.householdId, actorUserId: actor.userId, action: 'hsa.receipt_allocated', entityType: 'hsa_allocation', entityId: line.allocationId, requestId,
        detail: {
          allocationId: line.allocationId, paymentId: line.paymentId, claimId: line.claimId, lineId: line.lineId, receiptId, eventId, amountCents: cents(l.amount),
          linePendingBeforeCents: line.pendingCents, linePendingAfterCents: cents(BigInt(line.pendingCents) - l.amount), ...figures(before, after),
        },
      });
    }
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'hsa.receipt_recorded', entityType: 'hsa_receipt', entityId: receiptId, requestId,
      detail: { receiptId, eventId, origin: 'claim', source: r.source, receivedOn: r.receivedOn, amountCents: cents(total), lineCount: lines.length },
    });
    return { id: receiptId, replayed: false };
  }));
}

/**
 * Records a reimbursement that was not initiated from a claim in this ledger (a debit-card purchase, a portal payout). It needs
 * an explicit source and evidence and follows the same rules as a claim: it reconciles to specific allocations and must fit
 * the amount still available, so an ineligible or undecided payment needs its eligibility decision first.
 */
export async function recordExternalReceipt(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string; replayed: boolean }> {
  authorize(actor, 'expenses:write');
  const { csrf: _csrf, idempotencyKey, lines, ...r } = parse(hsaSchemas.recordExternalReceipt, input);
  const receiptId = randomUUID();
  return withRetry(() => withTransaction(pool, async (tx) => {
    const replayId = await idempotent(tx, actor, 'hsa.external_receipt', idempotencyKey, { ...r, lines }, receiptId);
    if (replayId) return { id: replayId, replayed: true };
    const links = await lockForAllocations(tx, actor, lines.map((l) => l.allocationId), { newExposure: true });
    const total = sum(lines.map((l) => l.amount));
    await repo.insertReceipt(tx, {
      id: receiptId, householdId: actor.householdId, userId: actor.userId, receivedOn: r.receivedOn, amountCents: total, origin: 'external', source: r.source,
      reference: r.reference, evidenceType: r.evidenceType, evidenceNote: r.evidenceNote, note: r.note,
    });
    const eventId = randomUUID();
    for (const l of [...lines].sort(byId((x) => x.allocationId))) {
      const before = await freshAllocation(tx, actor, l.allocationId);
      if (before.directHsa) throw new AppError('conflict', 'This payment was paid directly from an HSA at the point of service, so there is nothing to claim and no eligibility decision to record.');
      if (BigInt(before.needsReviewCents) > 0n) throw new AppError('conflict', 'This payment needs review (pending or received reimbursement is above its eligible amount). Resolve that before recording more.');
      if (l.amount > BigInt(before.availableCents)) throw new AppError('conflict', 'That reimbursement is more than the amount still available for this payment. Record or raise its eligibility decision first.');
      await repo.insertEntry(tx, {
        id: randomUUID(), householdId: actor.householdId, userId: actor.userId, paymentId: links.get(l.allocationId)!, allocationId: l.allocationId, billId: before.billId, eventId,
        kind: 'external_receipt', claimId: null, lineId: null, receiptId, amountCents: l.amount, effectiveDate: r.receivedOn, reason: '',
      });
      const after = await freshAllocation(tx, actor, l.allocationId);
      await recordAudit(tx, {
        householdId: actor.householdId, actorUserId: actor.userId, action: 'hsa.external_receipt_allocated', entityType: 'hsa_allocation', entityId: l.allocationId, requestId,
        detail: { allocationId: l.allocationId, paymentId: before.paymentId, receiptId, eventId, amountCents: cents(l.amount), ...figures(before, after) },
      });
    }
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'hsa.receipt_recorded', entityType: 'hsa_receipt', entityId: receiptId, requestId,
      detail: { receiptId, eventId, origin: 'external', source: r.source, evidenceType: r.evidenceType, receivedOn: r.receivedOn, amountCents: cents(total), lineCount: lines.length },
    });
    return { id: receiptId, replayed: false };
  }));
}

/**
 * Corrects a receipt recorded in error (or returned) with linked, opposite entries covering the whole receipt. The receipt stays
 * in the history. Received goes down and nothing returns to pending, so the amount becomes available again for a new claim.
 */
export async function reverseReceipt(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string; replayed: boolean }> {
  authorize(actor, 'expenses:write');
  const { csrf: _csrf, idempotencyKey, allocationId, ...d } = parse(hsaSchemas.reverseReceipt, input);
  const eventId = randomUUID();
  return withRetry(() => withTransaction(pool, async (tx) => {
    const replayId = await idempotent(tx, actor, 'hsa.receipt_reverse', idempotencyKey, d, eventId);
    if (replayId) return { id: replayId, replayed: true };
    const probe = await repo.receiptEntries(tx, actor.householdId, d.receiptId);
    if (probe.length === 0) throw new AppError('not_found');
    if (allocationId && !probe.some((e) => e.allocationId === allocationId)) throw new AppError('invalid_input');
    await lockForAllocations(tx, actor, probe.map((e) => e.allocationId));
    const entries = await repo.receiptEntries(tx, actor.householdId, d.receiptId);
    if (entries.some((e) => e.reversed)) throw new AppError('conflict', 'That receipt was already reversed');
    let total = 0n;
    for (const e of [...entries].sort(byId((x) => x.allocationId + x.id))) {
      const before = await freshAllocation(tx, actor, e.allocationId);
      if (e.amountCents > BigInt(before.receivedCents)) throw new AppError('conflict', 'That receipt is more than the reimbursement recorded as received');
      await repo.insertEntry(tx, {
        id: randomUUID(), householdId: actor.householdId, userId: actor.userId, paymentId: e.paymentId, allocationId: e.allocationId, billId: e.billId, eventId,
        kind: 'receipt_reversal', claimId: e.claimId, lineId: e.lineId, receiptId: d.receiptId, reversesEntryId: e.id, amountCents: e.amountCents,
        effectiveDate: d.effectiveDate, reason: d.reason,
      });
      const after = await freshAllocation(tx, actor, e.allocationId);
      await recordAudit(tx, {
        householdId: actor.householdId, actorUserId: actor.userId, action: 'hsa.receipt_entry_reversed', entityType: 'hsa_allocation', entityId: e.allocationId, requestId,
        detail: { allocationId: e.allocationId, paymentId: e.paymentId, claimId: e.claimId, lineId: e.lineId, receiptId: d.receiptId, eventId, entryId: e.id, amountCents: cents(e.amountCents), ...figures(before, after) },
      });
      total += e.amountCents;
    }
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'hsa.receipt_reversed', entityType: 'hsa_receipt', entityId: d.receiptId, requestId,
      detail: { receiptId: d.receiptId, eventId, effectiveDate: d.effectiveDate, amountCents: cents(total), entryCount: entries.length },
    });
    return { id: eventId, replayed: false };
  }));
}

// ---------- administrator removal and restore (undo) ----------

type RemovalKind = repo.RemovalKind;
const REMOVAL: Record<RemovalKind, { noun: string; slot: UndoKind; removed: string; restored: string; entityType: string; target: 'hsa_decision' | 'hsa_claim' | 'hsa_receipt' }> = {
  decision: { noun: 'eligibility decision', slot: 'hsa_decision_remove', removed: 'hsa.decision_removed', restored: 'hsa.decision_restored', entityType: 'hsa_allocation', target: 'hsa_decision' },
  claim: { noun: 'claim', slot: 'hsa_claim_remove', removed: 'hsa.claim_removed', restored: 'hsa.claim_restored', entityType: 'hsa_claim', target: 'hsa_claim' },
  receipt: { noun: 'reimbursement', slot: 'hsa_receipt_remove', removed: 'hsa.receipt_removed', restored: 'hsa.receipt_restored', entityType: 'hsa_receipt', target: 'hsa_receipt' },
};

/** Summed before and after figures of the allocations a removal or restore touches: cents only, no free text. */
function sumFigures(before: repo.HsaAllocation[], after: repo.HsaAllocation[]): Detail {
  const t = (xs: repo.HsaAllocation[], f: 'pendingCents' | 'receivedCents' | 'availableCents' | 'needsReviewCents') => cents(sum(xs.map((a) => BigInt(a[f]))));
  return {
    pendingBeforeCents: t(before, 'pendingCents'), pendingAfterCents: t(after, 'pendingCents'), receivedBeforeCents: t(before, 'receivedCents'), receivedAfterCents: t(after, 'receivedCents'),
    availableBeforeCents: t(before, 'availableCents'), availableAfterCents: t(after, 'availableCents'), needsReviewBeforeCents: t(before, 'needsReviewCents'), needsReviewAfterCents: t(after, 'needsReviewCents'),
  };
}

/** Maps what the removal guard (migration 0020) raises to a sentence the person can act on. Anything else passes through. */
function mapRemovalError(e: unknown, kind: RemovalKind, action: repo.RemovalAction): unknown {
  if (e instanceof AppError) return e;
  const err = e as { code?: string; constraint?: string; message?: string };
  const msg = String(err?.message ?? '');
  const undoNote = action === 'restore' ? 'This cannot be undone: ' : '';
  if (err?.code === '23505' && err.constraint === 'hsa_claims_reference_unique') {
    return new AppError('conflict', 'This cannot be undone: a newer claim now uses the same reference. Delete or change that claim first.');
  }
  if (err?.code !== '23514') return e;
  if (/unknown HSA record/.test(msg)) return new AppError('not_found');
  if (/already removed/.test(msg)) return new AppError('conflict', `That ${REMOVAL[kind].noun} was already deleted`);
  if (/is not removed/.test(msg)) return new AppError('conflict', 'Nothing to undo');
  if (/remove its reimbursements first/.test(msg)) return new AppError('conflict', `${repo.MSG_CLAIM_HAS_RECEIPTS}. A claim with a reimbursement cannot be deleted.`);
  if (/would increase the excess above the eligible ceiling/.test(msg)) {
    return new AppError('conflict', kind === 'decision' ? repo.MSG_DECISION_SUPPORTS : kind === 'receipt' ? repo.MSG_RECEIPT_SUPPORTS : 'Deleting this claim would leave more reimbursement than the payment supports');
  }
  if (/exceed the eligible ceiling/.test(msg)) return new AppError('conflict', action === 'restore'
    ? 'Undoing this deletion would put pending plus received reimbursement above what the payment\'s eligible amount supports, so this deletion cannot be undone. Enter the record again instead if it is still wanted.'
    : 'That change would put pending plus received reimbursement above what the payment\'s eligible amount supports.');
  if (/payment is removed/.test(msg)) return new AppError('conflict', `${undoNote}the payment was removed, so its HSA records stay deleted.`);
  if (/payment is voided/.test(msg)) return new AppError('conflict', `${undoNote}the payment was voided, so its HSA records stay deleted.`);
  if (/paid directly from an HSA/.test(msg)) return new AppError('conflict', `${undoNote}the payment is now paid directly from an HSA, so it has no claims or decisions.`);
  if (/while its claim is removed/.test(msg)) return new AppError('conflict', `${undoNote}its claim is deleted. Restore the claim first.`);
  if (/allocated in full|cover every entry/.test(msg)) return new AppError('conflict', `${undoNote}the reimbursement no longer matches its claim lines.`);
  return new AppError('conflict', 'That change would break a reimbursement limit. Reload and check the current figures.');
}

/** Probes the record, locks the payments behind it (ascending id) and reads it again, so every figure read afterwards is under the locks. */
async function lockedRecord(tx: Queryable, actor: Actor, kind: RemovalKind, id: string): Promise<repo.RemovalRecord | null> {
  const probe = await repo.getRemovalRecord(tx, actor.householdId, kind, id);
  if (!probe) return null;
  const locked = await paymentRepo.lockPayments(tx, actor.householdId, probe.paymentIds);
  if (locked.length !== probe.paymentIds.length) return null;
  return repo.getRemovalRecord(tx, actor.householdId, kind, id);
}

/** Appends the event and runs the commit-time guard now (instead of at commit), so a refusal is raised here and can be explained. */
async function postRemovalEvent(tx: Queryable, actor: Actor, kind: RemovalKind, id: string, action: repo.RemovalAction, reason: string): Promise<string> {
  try {
    const eventId = await repo.insertRemovalEvent(tx, { kind, recordId: id, action, reason, householdId: actor.householdId, userId: actor.userId });
    await tx.query('set constraints hsa_removal_events_guard immediate');
    return eventId;
  } catch (e) {
    throw mapRemovalError(e, kind, action);
  }
}

function removalDetail(kind: RemovalKind, rec: repo.RemovalRecord, eventId: string, before: repo.HsaAllocation[], after: repo.HsaAllocation[]): Detail {
  const ids: Detail = kind === 'decision' ? { decisionId: rec.id, allocationId: rec.allocationId, paymentId: rec.paymentIds[0] ?? null }
    : kind === 'claim' ? { claimId: rec.id } : { receiptId: rec.id, claimId: rec.claimId };
  return { ...ids, eventId, allocationCount: rec.allocationIds.length, amountCents: rec.cents, ...sumFigures(before, after) };
}

async function removeRecord(
  pool: Pool, actor: Actor, kind: RemovalKind, v: { id: string; reason: string; key: string; steer?: (r: repo.RemovalRecord) => boolean }, requestId: string,
): Promise<{ id: string; replayed: boolean }> {
  const meta = REMOVAL[kind];
  return withRetry(() => withTransaction(pool, async (tx) => {
    const replayId = await idempotent(tx, actor, meta.removed.replace('removed', 'remove'), v.key, { id: v.id, reason: v.reason }, v.id);
    if (replayId) return { id: replayId, replayed: true };
    const rec = await lockedRecord(tx, actor, kind, v.id);
    if (!rec) throw new AppError('not_found');
    if (v.steer && !v.steer(rec)) throw new AppError('invalid_input');
    if (rec.removed) throw new AppError('conflict', `That ${meta.noun} was already deleted`);
    const before = await repo.getAllocations(tx, actor.householdId, rec.allocationIds);
    const eventId = await postRemovalEvent(tx, actor, kind, v.id, 'remove', v.reason);
    const after = await repo.getAllocations(tx, actor.householdId, rec.allocationIds);
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: meta.removed, entityType: meta.entityType,
      entityId: kind === 'decision' ? rec.allocationId : rec.id, requestId, detail: removalDetail(kind, rec, eventId, before, after),
    });
    await setUndoSlot(tx, actor, { kind: meta.slot, entityId: rec.id, payload: { recordId: rec.id } });
    return { id: rec.id, replayed: false };
  }));
}

/**
 * Administrator removal of an eligibility decision. Nothing is deleted: a removal marker hides it, and undo restores it exactly. Refused when
 * it would leave more pending plus received than the remaining ceiling supports and that is worse than before (the guard's "not worse than
 * before" rule, so stale decisions can still be cleaned up on an allocation that already needs review).
 */
export async function removeHsaDecision(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string; replayed: boolean }> {
  authorize(actor, 'records:remove');
  const { idempotencyKey, decisionId, allocationId, reason } = parse(hsaSchemas.removeDecision, input);
  return removeRecord(pool, actor, 'decision', { id: decisionId, reason, key: idempotencyKey, steer: (r) => !allocationId || allocationId === r.allocationId }, requestId);
}

/** Administrator removal of a whole claim (its reserve, reject and cancel entries stop counting). Leaf-first: refused while a live reimbursement has entries on it. */
export async function removeHsaClaim(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string; replayed: boolean }> {
  authorize(actor, 'records:remove');
  const { idempotencyKey, claimId, reason } = parse(hsaSchemas.removeClaim, input);
  return removeRecord(pool, actor, 'claim', { id: claimId, reason, key: idempotencyKey }, requestId);
}

/** Administrator removal of a reimbursement receipt: its entries stop counting, claim lines return to pending and received falls. */
export async function removeHsaReceipt(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string; replayed: boolean }> {
  authorize(actor, 'records:remove');
  const { idempotencyKey, receiptId, claimId, reason } = parse(hsaSchemas.removeReceipt, input);
  return removeRecord(pool, actor, 'receipt', { id: receiptId, reason, key: idempotencyKey, steer: (r) => !claimId || claimId === r.claimId }, requestId);
}

const restorePayload = z.strictObject({ recordId: z.uuid() });

/**
 * The inverse of a removal, used only by undo and called inside its transaction (the caller authorized `records:remove`). Locks the payments
 * first, requires the record to be removed right now (else "Nothing to undo"), appends a `restore` event and runs the commit guard at once. The
 * guard is strict for a restore: nothing may exceed the ceiling, and the payment must still be live and not paid directly from an HSA. Returns
 * the page the undo redirect lands on.
 */
export async function restoreHsaRecord(
  tx: Queryable, actor: Actor, kind: RemovalKind, recordId: string, requestId: string, payload: unknown = { recordId },
): Promise<{ target: 'hsa_decision' | 'hsa_claim' | 'hsa_receipt'; path: string }> {
  const parsed = restorePayload.safeParse(payload);
  if (!parsed.success || parsed.data.recordId !== recordId) throw new AppError('conflict', 'Nothing to undo');
  const meta = REMOVAL[kind];
  const rec = await lockedRecord(tx, actor, kind, recordId);
  if (!rec || !rec.removed) throw new AppError('conflict', 'Nothing to undo');
  const before = await repo.getAllocations(tx, actor.householdId, rec.allocationIds);
  const eventId = await postRemovalEvent(tx, actor, kind, recordId, 'restore', 'Restored by undo');
  const after = await repo.getAllocations(tx, actor.householdId, rec.allocationIds);
  await recordAudit(tx, {
    householdId: actor.householdId, actorUserId: actor.userId, action: meta.restored, entityType: meta.entityType,
    entityId: kind === 'decision' ? rec.allocationId : rec.id, requestId, detail: removalDetail(kind, rec, eventId, before, after),
  });
  const page = await repo.recordPage(tx, actor.householdId, recordId);
  if (!page) throw new AppError('conflict', 'Nothing to undo');
  return { target: meta.target, path: page.path };
}

/**
 * Whether Delete is available on one record, and why not, from the rules the database guard enforces (leaf-first for a claim, "not worse than
 * before" for a decision or a receipt). For administrators only. The detail reads carry the same shape as `deletable`.
 */
export async function hsaRecordDeletable(pool: Pool | Queryable, actor: Actor, kind: RemovalKind, id: string): Promise<repo.Deletable> {
  authorize(actor, 'records:remove');
  const recordId = parse(schemas.id, id);
  const rec = await repo.getRemovalRecord(pool, actor.householdId, kind, recordId);
  if (!rec) throw new AppError('not_found');
  if (rec.removed) return { deletable: false, reason: repo.MSG_ALREADY_REMOVED };
  if (kind === 'claim') return repo.claimDeletable(pool, actor.householdId, recordId);
  if (kind === 'receipt') return repo.receiptDeletable(pool, actor.householdId, recordId);
  return (await repo.decisionsDeletable(pool, actor.householdId, rec.allocationId!)).get(recordId) ?? { deletable: false, reason: repo.MSG_ALREADY_REMOVED };
}


// ---------- scoped export ----------

const MAX_EXPORT_ROWS = 20_000;
const textCell = (v: string | null | undefined): string => {
  let s = v ?? '';
  // Spreadsheet formula injection: a cell that starts with one of these is read as a formula, so it is prefixed with a quote.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** A numeric cell (integer cents, possibly negative) is written as is; only text cells are neutralized. */
interface NumCell { n: string }
const num = (v: string | bigint | number): NumCell => ({ n: String(v) });
const row = (cells: Array<string | null | undefined | NumCell>) => `${cells.map((c) => (typeof c === 'object' && c !== null ? c.n : textCell(c))).join(',')}\r\n`;

const PENDING_EFFECT: Record<repo.HsaEntryKind, 1 | -1 | 0> = { reserve: 1, receipt: -1, reject: -1, cancel: -1, external_receipt: 0, receipt_reversal: 0 };
const RECEIVED_EFFECT: Record<repo.HsaEntryKind, 1 | -1 | 0> = { reserve: 0, receipt: 1, reject: 0, cancel: 0, external_receipt: 1, receipt_reversal: -1 };

/**
 * Scoped CSV export read from one consistent snapshot. `allocations` has one row per payment allocation plus a TOTAL row that
 * equals the sum of the rows; `events` has every posted entry with its signed effect on pending and received, so the figures
 * can be rebuilt from the history; `decisions` has every eligibility decision. Cells that could be read as formulas are neutralized.
 */
export async function exportHsa(pool: Pool, actor: Actor, raw: unknown, requestId: string): Promise<{ filename: string; csv: string; rows: number }> {
  authorize(actor, 'expenses:read');
  const scope = parse(hsaFilterSchemas.exportScope, raw);
  const { kind, ...filter } = scope;
  const tooMany = () => new AppError('invalid_input', 'That export is too large. Narrow it with a family member or date range.');
  const result = await withSnapshot(pool, async (db) => {
    if (kind === 'allocations') {
      const items = await repo.allAllocations(db, actor.householdId, filter, MAX_EXPORT_ROWS);
      if (!items) throw tooMany();
      let csv = row(['allocation_id', 'payment_id', 'paid_on', 'family_member', 'bill', 'net_cash_cents', 'decision', 'decided_eligible_cents', 'eligible_ceiling_cents', 'pending_cents', 'received_cents', 'available_cents', 'needs_review_cents']);
      const t = { net: 0n, ceiling: 0n, pending: 0n, received: 0n, available: 0n, review: 0n, decided: 0n };
      for (const a of items) {
        csv += row([a.allocationId, a.paymentId, a.paidOn, a.memberName, a.billLabel, num(a.netCents), a.directHsa ? 'paid_directly_from_hsa' : (a.decisionStatus ?? 'unknown'), num(a.decidedCents), num(a.ceilingCents), num(a.pendingCents), num(a.receivedCents), num(a.availableCents), num(a.needsReviewCents)]);
        t.net += BigInt(a.netCents); t.decided += BigInt(a.decidedCents); t.ceiling += BigInt(a.ceilingCents); t.pending += BigInt(a.pendingCents);
        t.received += BigInt(a.receivedCents); t.available += BigInt(a.availableCents); t.review += BigInt(a.needsReviewCents);
      }
      csv += row(['TOTAL', '', '', '', `${items.length} allocations`, num(t.net), '', num(t.decided), num(t.ceiling), num(t.pending), num(t.received), num(t.available), num(t.review)]);
      return { csv, rows: items.length };
    }
    if (kind === 'events') {
      const items = await repo.entriesInScope(db, actor.householdId, filter, MAX_EXPORT_ROWS);
      if (!items) throw tooMany();
      let csv = row(['seq', 'event_id', 'kind', 'effective_date', 'allocation_id', 'payment_id', 'paid_on', 'family_member', 'bill', 'claim_id', 'line_id', 'receipt_id', 'reverses_entry_id', 'amount_cents', 'pending_effect_cents', 'received_effect_cents']);
      for (const e of items) {
        const a = BigInt(e.amountCents);
        csv += row([e.seq, e.eventId, e.kind, e.effectiveDate, e.allocationId, e.paymentId, e.paidOn, e.memberName, e.billLabel, e.claimId, e.lineId, e.receiptId, e.reversesEntryId,
          num(a), num(a * BigInt(PENDING_EFFECT[e.kind])), num(a * BigInt(RECEIVED_EFFECT[e.kind]))]);
      }
      return { csv, rows: items.length };
    }
    const items = await repo.decisionsInScope(db, actor.householdId, filter, MAX_EXPORT_ROWS);
    if (!items) throw tooMany();
    let csv = row(['decision_id', 'allocation_id', 'payment_id', 'paid_on', 'family_member', 'bill', 'status', 'eligible_cents', 'decided_on', 'evidence_type', 'evidence_note', 'rationale']);
    for (const d of items) csv += row([d.id, d.allocationId, d.paymentId, d.paidOn, d.memberName, d.billLabel, d.status, num(d.eligibleCents), d.decidedOn, d.evidenceType, d.evidenceNote, d.rationale]);
    return { csv, rows: items.length };
  });
  await recordAudit(pool, {
    householdId: actor.householdId, actorUserId: actor.userId, action: 'hsa.exported', entityType: 'hsa_export', requestId,
    detail: { kind, rows: result.rows, memberScoped: filter.memberId !== null && filter.memberId !== undefined, hasDateRange: Boolean(filter.from || filter.to) },
  });
  return { filename: `tallymed-hsa-${kind}.csv`, csv: result.csv, rows: result.rows };
}
