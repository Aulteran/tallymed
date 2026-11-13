// Use cases for HSA reimbursements: eligibility decisions with evidence, claim reservations, receipts, releases and reversals.
// Every mutation authorizes, validates, locks, writes and audits in one transaction. HSA writers lock the payments behind the
// allocations they touch (ascending id) before reading any figure, the first step of the global lock order (payments, bills,
// plans), and take no bill or plan lock at all, so they can never lock out of order. Money is bigint cents. HSA rows never touch
// payment_entries: a receipt does not change a bill or provider balance.
import { randomUUID } from 'node:crypto';
import { authorize, type Actor } from '../authz.ts';
import { withSnapshot, withTransaction, type Pool, type Queryable } from '../db.ts';
import { AppError } from '../errors.ts';
import { recordAudit } from '../repositories/audit.ts';
import * as repo from '../repositories/hsa.ts';
import * as paymentRepo from '../repositories/payments.ts';
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
 * safe. Every figure is read after this returns.
 */
async function lockForAllocations(tx: Queryable, actor: Actor, allocationIds: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(allocationIds)];
  const links = await repo.allocationPayments(tx, actor.householdId, unique);
  if (links.length !== unique.length) throw new AppError('not_found');
  const paymentIds = [...new Set(links.map((l) => l.paymentId))];
  const locked = await paymentRepo.lockPayments(tx, actor.householdId, paymentIds);
  if (locked.length !== paymentIds.length) throw new AppError('not_found');
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
  if (!allocation) throw new AppError('not_found');
  const [decisions, lines, entries, history] = await Promise.all([
    repo.listDecisions(pool, actor.householdId, allocationId), repo.linesOfAllocation(pool, actor.householdId, allocationId),
    repo.listEntriesOfAllocation(pool, actor.householdId, allocationId), repo.history(pool, actor.householdId, 'allocationId', allocationId),
  ]);
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
  const [lines, entries, history] = await Promise.all([
    repo.linesOfClaim(pool, actor.householdId, claimId), repo.listEntriesOfClaim(pool, actor.householdId, claimId), repo.history(pool, actor.householdId, 'claimId', claimId),
  ]);
  return { claim, lines, entries, history };
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
  const [entries, history] = await Promise.all([
    repo.listEntriesOfReceipt(pool, actor.householdId, receiptId), repo.history(pool, actor.householdId, 'receiptId', receiptId),
  ]);
  return { receipt, entries, history };
}

// ---------- writes ----------

/**
 * Records an eligibility decision for one payment allocation. A decision is a user judgment with rationale and evidence; a date,
 * a category or a suggestion alone never certifies eligibility. Decisions are immutable rows, the latest is current, and
 * lowering one below what is pending or received is allowed: nothing already received is lost, the allocation shows as "needs
 * review" and new claims are frozen until the excess is resolved. `version` is the number of decisions the person saw.
 */
export async function recordDecision(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string; replayed: boolean }> {
  authorize(actor, 'expenses:write');
  const { csrf: _csrf, idempotencyKey, allocationId, version, ...d } = parse(hsaSchemas.decide, input);
  const id = randomUUID();
  return withRetry(() => withTransaction(pool, async (tx) => {
    const replayId = await idempotent(tx, actor, 'hsa.decide', idempotencyKey, { allocationId, version, ...d }, id);
    if (replayId) return { id: replayId, replayed: true };
    const links = await lockForAllocations(tx, actor, [allocationId]);
    const before = await freshAllocation(tx, actor, allocationId);
    if (before.decisionCount !== version) throw new AppError('stale_version', 'The eligibility decision changed since you loaded it. Reload and decide again.');
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
    const links = await lockForAllocations(tx, actor, lines.map((l) => l.allocationId));
    if (c.reference && await repo.claimReferenceExists(tx, actor.householdId, c.reference)) throw new AppError('conflict', 'A claim with that reference was already recorded');
    await repo.insertClaim(tx, { id: claimId, householdId: actor.householdId, userId: actor.userId, submittedOn: c.submittedOn, administrator: c.administrator, reference: c.reference, note: c.note });
    const eventId = randomUUID();
    let total = 0n;
    for (const line of [...lines].sort(byId((l) => l.allocationId))) {
      const before = await freshAllocation(tx, actor, line.allocationId);
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
  const { csrf: _csrf, idempotencyKey, claimId: _claim, allocationId: _alloc, ...d } = parse(hsaSchemas.releaseLine, input);
  const id = randomUUID();
  return withRetry(() => withTransaction(pool, async (tx) => {
    const replayId = await idempotent(tx, actor, 'hsa.release', idempotencyKey, d, id);
    if (replayId) return { id: replayId, replayed: true };
    const [probe] = await repo.linesById(tx, actor.householdId, [d.lineId]);
    if (!probe) throw new AppError('not_found');
    await lockForAllocations(tx, actor, [probe.allocationId]);
    const [line] = await repo.linesById(tx, actor.householdId, [d.lineId]);
    if (!line) throw new AppError('not_found');
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
  const { csrf: _csrf, idempotencyKey, lines, ...r } = parse(hsaSchemas.recordReceipt, input);
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
    const links = await lockForAllocations(tx, actor, lines.map((l) => l.allocationId));
    const total = sum(lines.map((l) => l.amount));
    await repo.insertReceipt(tx, {
      id: receiptId, householdId: actor.householdId, userId: actor.userId, receivedOn: r.receivedOn, amountCents: total, origin: 'external', source: r.source,
      reference: r.reference, evidenceType: r.evidenceType, evidenceNote: r.evidenceNote, note: r.note,
    });
    const eventId = randomUUID();
    for (const l of [...lines].sort(byId((x) => x.allocationId))) {
      const before = await freshAllocation(tx, actor, l.allocationId);
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
  const { csrf: _csrf, idempotencyKey, allocationId: _alloc, ...d } = parse(hsaSchemas.reverseReceipt, input);
  const eventId = randomUUID();
  return withRetry(() => withTransaction(pool, async (tx) => {
    const replayId = await idempotent(tx, actor, 'hsa.receipt_reverse', idempotencyKey, d, eventId);
    if (replayId) return { id: replayId, replayed: true };
    const probe = await repo.receiptEntries(tx, actor.householdId, d.receiptId);
    if (probe.length === 0) throw new AppError('not_found');
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
        csv += row([a.allocationId, a.paymentId, a.paidOn, a.memberName, a.billLabel, num(a.netCents), a.decisionStatus ?? 'unknown', num(a.decidedCents), num(a.ceilingCents), num(a.pendingCents), num(a.receivedCents), num(a.availableCents), num(a.needsReviewCents)]);
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
