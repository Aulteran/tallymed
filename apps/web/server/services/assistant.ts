// Use cases for the optional assistant: managing MCP client credentials (administrators) and the in-app review of document-match
// proposals (any operator who can edit records). A proposal is only ever applied here, by a signed-in person, after the document
// and the target are rechecked under locks; the MCP listener has no path to this code and no database right to the tables it writes.
//
// Lock order for an approval: the target record (a bill in the global money order, so before payments' later locks), then the
// document, then the proposal row. Nothing else is locked, and `lockConflicts` should stay zero in tests.
import { randomUUID } from 'node:crypto';
import { authorize, type Actor } from '../authz.ts';
import { withTransaction, type Pool } from '../db.ts';
import { AppError } from '../errors.ts';
import { recordAudit } from '../repositories/audit.ts';
import * as assistant from '../repositories/assistant.ts';
import * as docs from '../repositories/documents.ts';
import { MCP_SCOPES, type McpScope } from '../repositories/mcp.ts';
import { digest, newToken } from '../tokens.ts';
import { assistantFilterSchemas, assistantSchemas, parse, schemas } from '../validation.ts';
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
    'documents:read': d.documentsRead, 'records:read': d.recordsRead, 'documents:content': d.documentsContent, 'proposals:create': d.proposalsCreate,
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
    if (!await docs.lockTarget(tx, actor.householdId, probe.targetType, probe.targetId)) throw new AppError('stale_version', 'The record is no longer available');
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
