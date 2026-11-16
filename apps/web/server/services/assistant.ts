// Use cases for the optional assistant: managing MCP client credentials (administrators) and the in-app review of document-match
// and payment plan proposals (any operator who can edit records). A proposal is only ever applied here, by a signed-in person, after the
// document or the bills are rechecked under locks; the MCP listener has no path to this code and no database right to the tables it writes
// (the plan tables included: it can only insert a pending `plan_proposals` row).
//
// Lock order for a document approval: the target record (a bill in the global money order, so before payments' later locks), then the
// document, then the proposal row. Nothing else is locked, and `lockConflicts` should stay zero in tests.
//
// Lock order for a plan approval is the global order, payments (those on the plan's bills, when matching), then bills (ascending id), then plans
// (the new plan row is inserted by this transaction, so no plan lock is ever waited for), and the proposal row LAST, as for a document: the only
// other code that locks a proposal row is a rejection, which takes nothing else, and the MCP listener only inserts, so no transaction holds a
// proposal row while waiting for a payment or a bill.
import { createHash, randomUUID } from 'node:crypto';
import { authorize, can, type Actor } from '../authz.ts';
import { withTransaction, type Pool } from '../db.ts';
import { AppError } from '../errors.ts';
import { recordAudit } from '../repositories/audit.ts';
import * as assistant from '../repositories/assistant.ts';
import * as docs from '../repositories/documents.ts';
import * as expenseRepo from '../repositories/expenses.ts';
import { MCP_SCOPES, type McpScope } from '../repositories/mcp.ts';
import { planProposalFormInput, readPlanProposalPayload, type PlanProposalPlan } from '../plan-proposal.ts';
import { digest, newToken } from '../tokens.ts';
import { assistantFilterSchemas, assistantSchemas, parse, paymentSchemas, schemas } from '../validation.ts';
import { prepareInProgress, previewPlanInProgress, progressPreviewOf, saveInProgress, type ProgressPreview } from './plans.ts';
import { idempotent, withRetry } from './support.ts';

/** At most this many usable client credentials per household, so a mistake cannot leave dozens of live tokens. */
export const MAX_ACTIVE_CLIENTS = 10;

// ---------- clients ----------

export async function listClients(pool: Pool, actor: Actor) {
  authorize(actor, 'assistant:manage');
  return assistant.listClients(pool, actor.householdId);
}

/** Administrator only. The token is returned once to the caller; only its SHA-256 digest is stored. */
export async function createClient(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string; token: string; expiresAt: Date; name: string; scopes: McpScope[] }> {
  authorize(actor, 'assistant:manage');
  const d = parse(assistantSchemas.createClient, input);
  const scopes = MCP_SCOPES.filter((s) => ({
    'documents:read': d.documentsRead, 'records:read': d.recordsRead, 'documents:content': d.documentsContent, 'proposals:create': d.proposalsCreate, 'plans:propose': d.plansPropose,
  } as Record<McpScope, boolean | undefined>)[s]);
  if (scopes.length === 0) throw new AppError('invalid_input', 'Choose at least one permission');
  const id = randomUUID();
  const token = `tmcp_${newToken()}`;
  const expiresAt = await withTransaction(pool, async (tx) => {
    await tx.query(`select pg_advisory_xact_lock(hashtextextended('mcp-clients:' || $1::text, 0))`, [actor.householdId]);
    if (await assistant.activeClientCount(tx, actor.householdId) >= MAX_ACTIVE_CLIENTS) {
      throw new AppError('conflict', 'Revoke an assistant credential you no longer use before creating another');
    }
    const expires = await assistant.insertClient(tx, { id, householdId: actor.householdId, userId: actor.userId, name: d.name, tokenHash: digest(token), scopes, expiryDays: d.expiryDays });
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'assistant.client_created', entityType: 'mcp_client', entityId: id, requestId,
      detail: { clientId: id, scopes: scopes.join(','), expiryDays: d.expiryDays },
    });
    return expires;
  });
  return { id, token, expiresAt, name: d.name, scopes };
}

/** Administrator only. Takes effect on the client's next request; revocation is permanent. */
export async function revokeClient(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string }> {
  authorize(actor, 'assistant:manage');
  const d = parse(assistantSchemas.revokeClient, input);
  await withTransaction(pool, async (tx) => {
    if (!await assistant.revokeClient(tx, actor.householdId, d.clientId, actor.userId)) throw new AppError('conflict', 'That credential does not exist or was already revoked');
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'assistant.client_revoked', entityType: 'mcp_client', entityId: d.clientId, requestId,
      detail: { clientId: d.clientId, reason: d.reason },
    });
  });
  return { id: d.clientId };
}

// ---------- proposals ----------

export async function listProposals(pool: Pool, actor: Actor, raw: unknown) {
  authorize(actor, 'expenses:read');
  return assistant.listProposals(pool, actor.householdId, parse(assistantFilterSchemas.proposals, raw));
}

export async function getProposal(pool: Pool, actor: Actor, id: string) {
  authorize(actor, 'expenses:read');
  const p = await assistant.getProposal(pool, actor.householdId, parse(schemas.id, id));
  if (!p) throw new AppError('not_found');
  return p;
}

export async function pendingProposalCount(pool: Pool, actor: Actor): Promise<number> {
  authorize(actor, 'expenses:read');
  return assistant.pendingProposalCount(pool, actor.householdId);
}

/**
 * Applies a proposal: attaches the document version the person reviewed to the record they reviewed, once. Refused when the
 * document has a newer version or was removed, the record changed since the proposal, the document is already attached there,
 * the proposing client has been revoked, the proposal was already decided, or the person's view was out of date.
 */
export async function approveProposal(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string; replayed: boolean }> {
  authorize(actor, 'expenses:write');
  const d = parse(assistantSchemas.approve, input);
  const attachmentId = randomUUID();
  return withRetry(() => withTransaction(pool, async (tx) => {
    const replay = await idempotent(tx, actor, 'proposal.approve', d.idempotencyKey, { proposalId: d.proposalId, documentVersion: d.documentVersion, targetVersion: d.targetVersion, documentRevision: d.documentRevision }, attachmentId);
    if (replay) return { id: d.proposalId, replayed: true };
    // The target type and id of a proposal never change, so this unlocked read only decides which locks to take.
    const probe = await assistant.getProposal(tx, actor.householdId, d.proposalId);
    if (!probe) throw new AppError('not_found');
    if (!await docs.lockTarget(tx, actor.householdId, probe.targetType, probe.targetId, undefined, { live: true })) throw new AppError('stale_version', 'The record is no longer available');
    const lockedDoc = await docs.lockDocument(tx, actor.householdId, probe.documentId);
    if (!await assistant.lockProposal(tx, actor.householdId, d.proposalId)) throw new AppError('not_found');
    const p = await assistant.getProposal(tx, actor.householdId, d.proposalId);
    if (!p) throw new AppError('not_found');
    if (p.status !== 'pending') throw new AppError('conflict', 'That proposal was already decided');
    if (p.clientRevoked) throw new AppError('conflict', 'The assistant credential that made this proposal has been revoked. Reject it, or attach the document yourself.');
    if (!lockedDoc || lockedDoc.removedAt || p.documentRemoved) throw new AppError('stale_version', 'The document was removed since the proposal');
    // What the person saw must still be what the proposal names, and what the proposal names must still be current.
    if (d.documentVersion !== p.pinnedVersionNo || d.targetVersion !== p.targetVersion) throw new AppError('stale_version', 'This proposal changed since you opened it. Reload and review it again.');
    // The title, kind and note the person read belong to the document row; an edit since then means they approved something else.
    if (d.documentRevision !== lockedDoc.version) throw new AppError('stale_version', 'The document was edited since you opened this proposal. Reload and review it again.');
    if (p.currentVersionNo !== p.pinnedVersionNo) throw new AppError('stale_version', 'The document has a newer version than the one proposed. Reject this proposal and review the new version.');
    if (p.targetVersionNow !== p.targetVersion) throw new AppError('stale_version', 'The record changed since the proposal was made. Reject it and review the current record.');
    const version = await docs.getVersion(tx, actor.householdId, p.documentId, p.pinnedVersionNo);
    if (!version || version.state !== 'available' || version.id !== p.documentVersionId) throw new AppError('stale_version', 'The proposed file is no longer available');
    const onTarget = await docs.activeTargetLinks(tx, actor.householdId, p.targetType, p.targetId, p.documentId);
    if (onTarget.hasDocument) throw new AppError('conflict', 'That document is already attached to that record');
    const before = await docs.activeAttachmentCount(tx, actor.householdId, p.documentId);
    await docs.insertAttachment(tx, {
      id: attachmentId, householdId: actor.householdId, userId: actor.userId, documentId: p.documentId, versionId: version.id, type: p.targetType, targetId: p.targetId,
      note: 'Matched from an assistant proposal',
    });
    if (!await assistant.markApproved(tx, actor.householdId, p.id, actor.userId, attachmentId)) throw new AppError('conflict', 'That proposal was already decided');
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'proposal.approved', entityType: 'document_match_proposal', entityId: p.id, requestId,
      detail: { proposalId: p.id, clientId: p.clientId, documentId: p.documentId, versionNo: version.versionNo, targetType: p.targetType, targetId: p.targetId, targetVersion: p.targetVersion, attachmentId, confidence: p.confidence },
    });
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'document.attached', entityType: 'document', entityId: p.documentId, requestId,
      detail: {
        documentId: p.documentId, attachmentId, versionId: version.id, versionNo: version.versionNo, targetType: p.targetType, targetId: p.targetId, proposalId: p.id,
        targetAttachmentsBefore: onTarget.total, targetAttachmentsAfter: onTarget.total + 1, attachmentsBefore: before, attachmentsAfter: before + 1,
      },
    });
    return { id: p.id, replayed: false };
  }));
}

/** Rejects a pending proposal with a reason. Always allowed on a pending proposal, including a stale one or one from a revoked client. */
export async function rejectProposal(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string }> {
  authorize(actor, 'expenses:write');
  const d = parse(assistantSchemas.reject, input);
  return withRetry(() => withTransaction(pool, async (tx) => {
    if (!await assistant.lockProposal(tx, actor.householdId, d.proposalId)) throw new AppError('not_found');
    const p = await assistant.getProposal(tx, actor.householdId, d.proposalId);
    if (!p) throw new AppError('not_found');
    if (p.status !== 'pending') throw new AppError('conflict', 'That proposal was already decided');
    if (!await assistant.markRejected(tx, actor.householdId, p.id, actor.userId, d.reason)) throw new AppError('conflict', 'That proposal was already decided');
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'proposal.rejected', entityType: 'document_match_proposal', entityId: p.id, requestId,
      detail: { proposalId: p.id, clientId: p.clientId, documentId: p.documentId, targetType: p.targetType, targetId: p.targetId, wasStale: p.stale },
    });
    return { id: p.id };
  }));
}

// ---------- payment plan proposals ----------

/** The fingerprint of a preview: the approval carries the one the person saw and recomputes it under the locks, so approving creates exactly what was shown. */
export const previewDigest = (preview: ProgressPreview) => createHash('sha256').update(JSON.stringify(preview)).digest('hex');

export async function listPlanProposals(pool: Pool, actor: Actor, raw: unknown) {
  authorize(actor, 'expenses:read');
  return assistant.listPlanProposals(pool, actor.householdId, parse(assistantFilterSchemas.planProposals, raw));
}

/** What a reviewer needs about one bill of a proposal. */
export interface ReviewBill { id: string; providerName: string; memberName: string; statementDate: string; providerReference: string | null; openBalanceCents: string }

/** A bill as seen at review (a read) or under the approval's lock: the same few facts either way. */
interface BillFacts { id: string; version: number; confirmed: boolean; openCents: bigint }

/**
 * Why a proposal cannot be approved as it stands, from the bills it names: every one must still be in the household, have a confirmed amount, still
 * owe something and be at the version the assistant proposed against. Pure, so the review page and the approval under locks refuse the same things.
 */
export function billProblems(billIds: string[], pinned: Record<string, number>, facts: BillFacts[]): string[] {
  const out: string[] = [];
  const byId = new Map(facts.map((f) => [f.id, f]));
  if (billIds.some((id) => !byId.has(id))) out.push('A bill in this proposal is not in your household\'s records.');
  const here = billIds.map((id) => byId.get(id)).filter((f): f is BillFacts => f !== undefined);
  if (here.some((f) => !f.confirmed)) out.push('A bill in this proposal no longer has a confirmed amount.');
  if (here.some((f) => f.confirmed && f.openCents <= 0n)) out.push('A bill in this proposal has nothing left to pay.');
  if (here.some((f) => pinned[f.id] !== f.version)) out.push('A bill in this proposal was edited after the proposal was made.');
  return out;
}

export interface PlanProposalReview {
  proposal: assistant.PlanProposalRow;
  /** The payload read with the strict schema; null when the stored JSON is not a valid proposal. */
  plan: PlanProposalPlan | null;
  bills: ReviewBill[];
  /** Why a pending proposal cannot be approved as it stands (empty when it can). */
  problems: string[];
  /** The full preview, only for a pending proposal that can be approved and a reviewer who can approve it. */
  preview: ProgressPreview | null;
  /** The sentence to show in place of the preview when the app would refuse it. */
  previewError: string | null;
  previewDigest: string | null;
}

/** The review of one plan proposal: who proposed it, the plain-text note, the bills, and the same preview the in-progress form shows. Reads only. */
export async function reviewPlanProposal(pool: Pool, actor: Actor, id: string): Promise<PlanProposalReview> {
  authorize(actor, 'expenses:read');
  const proposal = await assistant.getPlanProposal(pool, actor.householdId, parse(schemas.id, id));
  if (!proposal) throw new AppError('not_found');
  const plan = readPlanProposalPayload(proposal.payload);
  const out: PlanProposalReview = { proposal, plan, bills: [], problems: [], preview: null, previewError: null, previewDigest: null };
  if (!plan) {
    if (proposal.status === 'pending') out.problems.push('This proposal is not valid and cannot be approved. Reject it.');
    return out;
  }
  const bills = await expenseRepo.getBills(pool, actor.householdId, plan.billIds);
  out.bills = plan.billIds.map((b) => bills.find((x) => x.id === b)).filter((b): b is NonNullable<typeof b> => b !== undefined)
    .map((b) => ({ id: b.id, providerName: b.providerName, memberName: b.memberName, statementDate: b.statementDate, providerReference: b.providerReference, openBalanceCents: b.openBalanceCents }));
  if (proposal.status !== 'pending') return out;
  out.problems = billProblems(plan.billIds, proposal.billVersions, bills.map((b) => ({ id: b.id, version: b.version, confirmed: b.amountStatus === 'confirmed', openCents: BigInt(b.openBalanceCents) })));
  if (proposal.clientRevoked) out.problems.push('The credential that made this proposal was revoked. Reject it, or enter the plan yourself.');
  if (out.problems.length > 0 || !can(actor, 'expenses:write')) return out;
  try {
    out.preview = await previewPlanInProgress(pool, actor, planProposalFormInput(plan));
    out.previewDigest = previewDigest(out.preview);
  } catch (error) {
    // What the save would refuse (nothing fully paid to keep, a restart before the last kept installment, ...) is the sentence to show.
    if (!(error instanceof AppError) || error.code === 'internal' || error.code === 'not_found') throw error;
    out.previewError = error.message !== error.code ? error.message : 'The plan cannot be created as proposed.';
  }
  return out;
}

/**
 * Creates the plan a proposal describes, once. In ONE transaction under ONE idempotency key (`proposal.plan_approve`): the stored payload is read
 * again with the strict schema, the payments on the bills and then the bills are locked (the global order), the plan is composed by the very code the
 * in-progress form saves with (`saveInProgress`), and only then, before the first write, the proposal row is locked and rechecked: still pending, its
 * credential not revoked, every bill still confirmed, owing and unedited, and the composed preview identical to the one the person approved.
 * Any refusal writes nothing. Then the plan is written exactly as the form writes it, the proposal is marked approved with the plan's id, and the
 * audit trail gets the plan events (the summary one marked as coming from this proposal) and `assistant.plan_proposal_approved`.
 */
export async function approvePlanProposal(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string; planId: string; replayed: boolean }> {
  authorize(actor, 'expenses:write');
  const d = parse(assistantSchemas.approvePlan, input);
  const planId = randomUUID();
  return withRetry(() => withTransaction(pool, async (tx) => {
    const replayed = await idempotent(tx, actor, 'proposal.plan_approve', d.idempotencyKey, { proposalId: d.proposalId, previewDigest: d.previewDigest }, planId);
    if (replayed) return { id: d.proposalId, planId: replayed, replayed: true };
    // The payload, client and household of a proposal never change (a database trigger), so this unlocked read only decides which locks to take.
    const probe = await assistant.getPlanProposal(tx, actor.householdId, d.proposalId);
    if (!probe) throw new AppError('not_found');
    const plan = readPlanProposalPayload(probe.payload);
    if (!plan) throw new AppError('conflict', 'This proposal is not valid and cannot be approved. Reject it.');
    const { csrf: _csrf, idempotencyKey: _key, ...form } = parse(paymentSchemas.createPlanInProgress, { ...planProposalFormInput(plan), idempotencyKey: d.idempotencyKey });
    const prepared = prepareInProgress(form);
    const saved = await saveInProgress(tx, actor, requestId, planId, prepared, {
      summaryExtra: { fromAssistantProposal: true, assistantProposalId: probe.id },
      // The payments and bills are locked: now the proposal row (last in the order), and every recheck that needs only them.
      async locked(scope) {
        if (!await assistant.lockPlanProposal(tx, actor.householdId, d.proposalId)) throw new AppError('not_found');
        const p = await assistant.getPlanProposal(tx, actor.householdId, d.proposalId);
        if (!p) throw new AppError('not_found');
        if (p.status !== 'pending') throw new AppError('conflict', 'That proposal was already decided');
        if (p.clientRevoked) throw new AppError('conflict', 'The assistant credential that made this proposal has been revoked. Reject it, or enter the plan yourself.');
        const problems = billProblems(plan.billIds, p.billVersions, scope.locks.map((b) => ({
          id: b.id, version: b.version, confirmed: b.amountStatus === 'confirmed', openCents: b.baseResponsibilityCents + b.adjustmentsCents - b.appliedCents,
        })));
        if (problems.length > 0) throw new AppError('stale_version', problems[0]);
      },
      // Composed from the cash as it is under the locks: it must be the plan the person was shown.
      async gate(c) {
        if (previewDigest(progressPreviewOf(prepared.original, prepared.restructure, c, [])) !== d.previewDigest) {
          throw new AppError('stale_version', 'The plan this proposal would create changed since you opened it (a payment, a bill or the date). Reload and review it again.');
        }
      },
    });
    if (!await assistant.markPlanApproved(tx, actor.householdId, probe.id, actor.userId, planId)) throw new AppError('conflict', 'That proposal was already decided');
    const c = saved.composition;
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'assistant.plan_proposal_approved', entityType: 'plan_proposal', entityId: probe.id, requestId,
      detail: {
        proposalId: probe.id, clientId: probe.clientId, planId, billCount: plan.billIds.length, startedOn: plan.startedOn, matchExisting: plan.matchExisting,
        matchedCents: c.matchedCents.toString(), keptInstallmentCount: c.kept.length, restructured: plan.restructure !== undefined,
        finalTotalCents: saved.final.totalCents.toString(), finalInstallmentCount: saved.final.installmentCount,
      },
    });
    return { id: probe.id, planId, replayed: false };
  }));
}

/** Rejects a pending plan proposal, with an optional reason kept on the proposal (never in the audit trail). Always allowed while it is pending. */
export async function rejectPlanProposal(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string }> {
  authorize(actor, 'expenses:write');
  const d = parse(assistantSchemas.rejectPlan, input);
  return withRetry(() => withTransaction(pool, async (tx) => {
    if (!await assistant.lockPlanProposal(tx, actor.householdId, d.proposalId)) throw new AppError('not_found');
    const p = await assistant.getPlanProposal(tx, actor.householdId, d.proposalId);
    if (!p) throw new AppError('not_found');
    if (p.status !== 'pending') throw new AppError('conflict', 'That proposal was already decided');
    if (!await assistant.markPlanRejected(tx, actor.householdId, p.id, actor.userId, d.reason === '' ? null : d.reason)) throw new AppError('conflict', 'That proposal was already decided');
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'assistant.plan_proposal_rejected', entityType: 'plan_proposal', entityId: p.id, requestId,
      detail: { proposalId: p.id, clientId: p.clientId, hadReason: d.reason !== '' },
    });
    return { id: p.id };
  }));
}
