// Use cases for document management: upload through quarantine and validation, versions, typed attachments with link history,
// authorized download, removal, and the storage verification and cleanup commands.
//
// Order of writes (see DECISIONS.md, Document Management): bytes are validated, written to quarantine, read back and checksummed,
// then promoted into the object area; only then does one transaction record the rows. A failure at any step removes the object,
// and a crash between promote and commit leaves an unreferenced object that `cleanupStorage` removes after a grace period. A row
// therefore never points at bytes that were not stored and verified. Document writers take the parent record's lock first
// (bills in the global money order), then the document row, and never a payment or plan lock.
import { createHash, randomUUID } from 'node:crypto';
import { authorize, type Actor } from '../authz.ts';
import type { AppConfig } from '../config.ts';
import { resolveAttachmentTarget } from '../contracts.ts';
import { withTransaction, type Pool, type Queryable } from '../db.ts';
import { inspectUpload, titleFromFilename } from '../document-files.ts';
import { AppError } from '../errors.ts';
import { log, logError } from '../log.ts';
import { recordAudit } from '../repositories/audit.ts';
import * as repo from '../repositories/documents.ts';
import { newStorageKey, type ObjectStore } from '../storage.ts';
import { documentFilterSchemas, documentSchemas, parse, schemas } from '../validation.ts';
import { idempotent, withRetry, type Detail } from './support.ts';

export type DocumentLimits = Pick<AppConfig, 'documentMaxBytes' | 'documentQuotaBytes' | 'documentRetentionDays'>;
export interface DocumentDeps { pool: Pool; store: ObjectStore | null; limits: DocumentLimits }

const need = (store: ObjectStore | null): ObjectStore => {
  if (!store) throw new AppError('storage_unavailable', 'Document storage is not configured');
  return store;
};
const hex = (b: Buffer) => b.toString('hex');

// ---------- reads ----------

export async function listDocuments(pool: Pool, actor: Actor, raw: unknown) {
  authorize(actor, 'expenses:read');
  return repo.listDocuments(pool, actor.householdId, parse(documentFilterSchemas.list, raw));
}

export async function getDocumentDetail(pool: Pool, actor: Actor, id: string) {
  authorize(actor, 'expenses:read');
  const documentId = parse(schemas.id, id);
  const document = await repo.getDocument(pool, actor.householdId, documentId);
  if (!document) throw new AppError('not_found');
  const [versions, attachments, history] = await Promise.all([
    repo.listVersions(pool, actor.householdId, documentId), repo.attachmentsOfDocument(pool, actor.householdId, documentId), repo.documentHistory(pool, actor.householdId, documentId),
  ]);
  return { document, versions, attachments, history };
}

/** Link history of one record (active links first). The target must exist in the actor's household. */
export async function listAttachments(pool: Pool | Queryable, actor: Actor, type: string, id: string) {
  const target = await resolveAttachmentTarget(pool, actor, type, id);
  return repo.attachmentsOfTarget(pool, actor.householdId, target.type, target.id);
}

/** Documents offered when attaching to a record: a bounded search that leaves out those already attached to it. */
export async function pickDocuments(pool: Pool, actor: Actor, raw: unknown, exclude: { type: repo.TargetType; id: string } | null) {
  authorize(actor, 'expenses:read');
  return repo.pickDocuments(pool, actor.householdId, parse(documentFilterSchemas.picker, raw).q, exclude);
}

export async function unmatchedSummary(pool: Pool, actor: Actor, limit = 5) {
  authorize(actor, 'expenses:read');
  const [count, items] = await Promise.all([repo.unmatchedCount(pool, actor.householdId), repo.unmatchedQueue(pool, actor.householdId, limit)]);
  return { count, items };
}

// ---------- upload ----------

interface Stored { key: string }

/** Quarantine, verify what was written, then promote. Any failure removes whatever was written and reports storage as unavailable. */
async function storeVerified(store: ObjectStore, bytes: Uint8Array, sha256: Buffer): Promise<Stored> {
  const key = newStorageKey();
  try {
    await store.putQuarantine(key, bytes);
    const back = await store.readQuarantine(key);
    if (back.length !== bytes.byteLength || !createHash('sha256').update(back).digest().equals(sha256)) throw new Error('stored bytes differ');
    await store.promote(key);
    return { key };
  } catch (error) {
    logError('documents.store_failed', error);
    await store.remove(key).catch(() => undefined);
    throw new AppError('storage_unavailable', 'The file could not be stored');
  }
}

async function discard(store: ObjectStore, key: string): Promise<void> {
  try {
    await store.remove(key);
  } catch (error) {
    // The unreferenced object is removed by the cleanup command; never mask the original outcome.
    logError('documents.discard_failed', error);
  }
}

/** Serializes quota checks per household. The lock is held to the end of the transaction. */
async function lockQuota(tx: Queryable, householdId: string, add: number, limits: DocumentLimits): Promise<void> {
  await tx.query(`select pg_advisory_xact_lock(hashtextextended('documents:' || $1::text, 0))`, [householdId]);
  const used = await repo.storedBytes(tx, householdId);
  if (used + BigInt(add) > BigInt(limits.documentQuotaBytes)) throw new AppError('payload_too_large', 'The household document storage limit has been reached');
}

function counts(before: number, after: number): Detail {
  return { activeAttachmentsBefore: before, activeAttachmentsAfter: after, unmatchedBefore: before === 0, unmatchedAfter: after === 0 };
}

/**
 * Stores a new document (version 1). The file is validated by content before anything is written. Optionally attaches it to one
 * record in the same transaction. One idempotency key is one document: a replay returns the first result and removes the
 * duplicate object it just stored.
 */
export async function uploadDocument({ pool, store, limits }: DocumentDeps, actor: Actor, input: unknown, requestId: string): Promise<{ id: string; replayed: boolean }> {
  authorize(actor, 'expenses:write');
  const objects = need(store);
  const d = parse(documentSchemas.upload, input);
  const file = inspectUpload(d.file, limits.documentMaxBytes);
  const title = d.title ?? titleFromFilename(file.safeName);
  const documentId = randomUUID();
  const versionId = randomUUID();
  const stored = await storeVerified(objects, d.file.bytes, file.sha256);
  try {
    const result = await withRetry(() => withTransaction(pool, async (tx) => {
      const replayId = await idempotent(tx, actor, 'document.upload', d.idempotencyKey, {
        sha256: hex(file.sha256), size: file.size, name: file.safeName, title, kind: d.kind, note: d.note, targetType: d.targetType, targetId: d.targetId,
      }, documentId);
      if (replayId) return { id: replayId, replayed: true };
      let target: Awaited<ReturnType<typeof resolveAttachmentTarget>> | null = null;
      if (d.targetType && d.targetId) {
        target = await resolveAttachmentTarget(tx, actor, d.targetType, d.targetId);
        if (!await repo.lockTarget(tx, actor.householdId, target.type, target.id, target.billId)) throw new AppError('not_found');
      }
      if (!d.confirmDuplicate && await repo.findByChecksum(tx, actor.householdId, file.sha256)) {
        throw new AppError('duplicate_document', 'A document with identical contents already exists');
      }
      await lockQuota(tx, actor.householdId, file.size, limits);
      await repo.insertDocument(tx, { id: documentId, householdId: actor.householdId, userId: actor.userId, title, kind: d.kind, note: d.note });
      await repo.insertVersion(tx, {
        id: versionId, householdId: actor.householdId, userId: actor.userId, documentId, versionNo: 1, storageKey: stored.key, sha256: file.sha256,
        sizeBytes: file.size, mediaType: file.mediaType, originalName: file.safeName,
      });
      await recordAudit(tx, {
        householdId: actor.householdId, actorUserId: actor.userId, action: 'document.uploaded', entityType: 'document', entityId: documentId, requestId,
        detail: { documentId, versionId, versionNo: 1, kind: d.kind, mediaType: file.mediaType, sizeBytes: file.size, sha256: hex(file.sha256), ...counts(0, 0) },
      });
      if (target) {
        const attachmentId = randomUUID();
        await repo.insertAttachment(tx, { id: attachmentId, householdId: actor.householdId, userId: actor.userId, documentId, versionId, type: target.type, targetId: target.id, billId: target.billId, note: '' });
        await recordAudit(tx, {
          householdId: actor.householdId, actorUserId: actor.userId, action: 'document.attached', entityType: 'document', entityId: documentId, requestId,
          detail: { documentId, attachmentId, versionId, versionNo: 1, targetType: target.type, targetId: target.id, targetAttachmentsBefore: 0, targetAttachmentsAfter: 1, ...counts(0, 1) },
        });
      }
      return { id: documentId, replayed: false };
    }));
    if (result.replayed) await discard(objects, stored.key);
    return result;
  } catch (error) {
    await discard(objects, stored.key);
    throw error;
  }
}

/** Adds a new immutable version. Earlier versions and the links pinned to them stay as they were. `version` is the version count the person saw. */
export async function addDocumentVersion({ pool, store, limits }: DocumentDeps, actor: Actor, input: unknown, requestId: string): Promise<{ id: string; replayed: boolean }> {
  authorize(actor, 'expenses:write');
  const objects = need(store);
  const d = parse(documentSchemas.addVersion, input);
  const file = inspectUpload(d.file, limits.documentMaxBytes);
  const versionId = randomUUID();
  const stored = await storeVerified(objects, d.file.bytes, file.sha256);
  try {
    const result = await withRetry(() => withTransaction(pool, async (tx) => {
      const replayId = await idempotent(tx, actor, 'document.version', d.idempotencyKey, {
        documentId: d.documentId, version: d.version, sha256: hex(file.sha256), size: file.size, name: file.safeName,
      }, versionId);
      if (replayId) return { id: d.documentId, replayed: true };
      const locked = await repo.lockDocument(tx, actor.householdId, d.documentId);
      if (!locked || locked.removedAt) throw new AppError('not_found');
      const before = await repo.getVersion(tx, actor.householdId, d.documentId);
      if (!before) throw new AppError('not_found');
      if (before.versionNo !== d.version) throw new AppError('stale_version', 'The document has a newer version than the one you saw. Reload and try again.');
      if (!d.confirmDuplicate && before.sha256 === hex(file.sha256)) throw new AppError('duplicate_document', 'That is identical to the current version');
      await lockQuota(tx, actor.householdId, file.size, limits);
      await repo.insertVersion(tx, {
        id: versionId, householdId: actor.householdId, userId: actor.userId, documentId: d.documentId, versionNo: before.versionNo + 1, storageKey: stored.key,
        sha256: file.sha256, sizeBytes: file.size, mediaType: file.mediaType, originalName: file.safeName,
      });
      await repo.bumpVersion(tx, actor.householdId, d.documentId);
      await recordAudit(tx, {
        householdId: actor.householdId, actorUserId: actor.userId, action: 'document.version_added', entityType: 'document', entityId: d.documentId, requestId,
        detail: {
          documentId: d.documentId, versionId, versionBeforeNo: before.versionNo, versionAfterNo: before.versionNo + 1, sha256Before: before.sha256, sha256After: hex(file.sha256),
          sizeBeforeBytes: Number(before.sizeBytes), sizeAfterBytes: file.size, mediaTypeBefore: before.mediaType, mediaTypeAfter: file.mediaType,
        },
      });
      return { id: d.documentId, replayed: false };
    }));
    if (result.replayed) await discard(objects, stored.key);
    return result;
  } catch (error) {
    await discard(objects, stored.key);
    throw error;
  }
}

// ---------- metadata, removal, links ----------

export async function updateDocument(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string }> {
  authorize(actor, 'expenses:write');
  const d = parse(documentSchemas.update, input);
  return withTransaction(pool, async (tx) => {
    const locked = await repo.lockDocument(tx, actor.householdId, d.id);
    if (!locked || locked.removedAt) throw new AppError('not_found');
    const before = await repo.getDocument(tx, actor.householdId, d.id);
    if (!before || before.version !== d.version) throw new AppError('stale_version');
    if (!await repo.updateDocument(tx, actor.householdId, d.id, d.version, { title: d.title, kind: d.kind, note: d.note })) throw new AppError('stale_version');
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'document.updated', entityType: 'document', entityId: d.id, requestId,
      detail: { documentId: d.id, kindBefore: before.kind, kindAfter: d.kind, titleChanged: before.title !== d.title, noteChanged: before.note !== d.note },
    });
    return { id: d.id };
  });
}

/**
 * Removes a document that no record uses. Removal is a tombstone: the row, the checksum and the link history stay, the document
 * disappears from lists and downloads, and its bytes are purged by the cleanup command after the retention window. A document
 * with active links must be detached first, so evidence never vanishes under a record. The database guard enforces the same rule
 * at commit when a link and a removal race.
 */
export async function removeDocument(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string }> {
  authorize(actor, 'expenses:write');
  const d = parse(documentSchemas.remove, input);
  return withRetry(() => withTransaction(pool, async (tx) => {
    const locked = await repo.lockDocument(tx, actor.householdId, d.id);
    if (!locked || locked.removedAt) throw new AppError('not_found');
    const before = await repo.getDocument(tx, actor.householdId, d.id);
    if (!before || before.version !== d.version) throw new AppError('stale_version');
    const active = await repo.activeAttachmentCount(tx, actor.householdId, d.id);
    if (active > 0) throw new AppError('conflict', 'Detach this document from every record before removing it');
    if (!await repo.markRemoved(tx, actor.householdId, d.id, d.version, actor.userId, d.reason)) throw new AppError('stale_version');
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'document.removed', entityType: 'document', entityId: d.id, requestId,
      detail: { documentId: d.id, removedBefore: false, removedAfter: true, versionCount: before.versionCount, activeAttachmentsBefore: active, activeAttachmentsAfter: 0 },
    });
    return { id: d.id };
  }));
}

/** Links the document's current version to one record. The link names the version, so later versions never change what a record's evidence was. */
export async function attachDocument(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string; replayed: boolean }> {
  authorize(actor, 'expenses:write');
  const d = parse(documentSchemas.attach, input);
  const attachmentId = randomUUID();
  return withRetry(() => withTransaction(pool, async (tx) => {
    const replayId = await idempotent(tx, actor, 'document.attach', d.idempotencyKey, { documentId: d.documentId, targetType: d.targetType, targetId: d.targetId, note: d.note }, attachmentId);
    if (replayId) return { id: replayId, replayed: true };
    const target = await resolveAttachmentTarget(tx, actor, d.targetType, d.targetId);
    // Parent record first (a bill in the money lock order), then the document.
    if (!await repo.lockTarget(tx, actor.householdId, target.type, target.id, target.billId)) throw new AppError('not_found');
    const locked = await repo.lockDocument(tx, actor.householdId, d.documentId);
    if (!locked || locked.removedAt) throw new AppError('not_found');
    const version = await repo.getVersion(tx, actor.householdId, d.documentId);
    if (!version || version.state !== 'available') throw new AppError('not_found');
    const before = await repo.activeAttachmentCount(tx, actor.householdId, d.documentId);
    const onTarget = await repo.activeTargetLinks(tx, actor.householdId, target.type, target.id, d.documentId);
    if (onTarget.hasDocument) throw new AppError('conflict', 'That document is already attached to that record');
    await repo.insertAttachment(tx, { id: attachmentId, householdId: actor.householdId, userId: actor.userId, documentId: d.documentId, versionId: version.id, type: target.type, targetId: target.id, billId: target.billId, note: d.note });
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'document.attached', entityType: 'document', entityId: d.documentId, requestId,
      detail: {
        documentId: d.documentId, attachmentId, versionId: version.id, versionNo: version.versionNo, targetType: target.type, targetId: target.id,
        targetAttachmentsBefore: onTarget.total, targetAttachmentsAfter: onTarget.total + 1, ...counts(before, before + 1),
      },
    });
    return { id: d.documentId, replayed: false };
  }));
}

/** Ends a link. The row stays as history with who ended it and why; the document returns to the unmatched queue when it was its last link. */
export async function detachDocument(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string }> {
  authorize(actor, 'expenses:write');
  const d = parse(documentSchemas.detach, input);
  return withRetry(() => withTransaction(pool, async (tx) => {
    // The target columns of a link never change, so this unlocked probe only decides which locks to take.
    const probe = await repo.getAttachment(tx, actor.householdId, d.attachmentId);
    if (!probe) throw new AppError('not_found');
    if (!await repo.lockTarget(tx, actor.householdId, probe.targetType, probe.targetId, probe.billId ?? undefined)) throw new AppError('not_found');
    const locked = await repo.lockDocument(tx, actor.householdId, probe.documentId);
    if (!locked) throw new AppError('not_found');
    const link = await repo.getAttachment(tx, actor.householdId, d.attachmentId);
    if (!link || link.detachedAt) throw new AppError('conflict', 'That attachment was already detached');
    const before = await repo.activeAttachmentCount(tx, actor.householdId, link.documentId);
    const onTarget = (await repo.activeTargetLinks(tx, actor.householdId, link.targetType, link.targetId, link.documentId)).total;
    if (!await repo.markDetached(tx, actor.householdId, d.attachmentId, actor.userId, d.reason)) throw new AppError('conflict', 'That attachment was already detached');
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'document.detached', entityType: 'document', entityId: link.documentId, requestId,
      detail: {
        documentId: link.documentId, attachmentId: d.attachmentId, versionId: link.documentVersionId, versionNo: link.versionNo, targetType: link.targetType, targetId: link.targetId,
        targetAttachmentsBefore: onTarget, targetAttachmentsAfter: onTarget - 1, ...counts(before, before - 1),
      },
    });
    return { id: link.documentId };
  }));
}

// ---------- download ----------

export interface DownloadedDocument { bytes: Buffer; mediaType: string; filename: string; versionNo: number }

/**
 * Returns the bytes of one version after authorization, a household-scoped lookup and an integrity check against the stored
 * checksum. Bytes whose size or checksum differ are never served. The media type is the one recorded from the content, not
 * anything the client sent.
 */
export async function downloadDocument(pool: Pool, store: ObjectStore | null, actor: Actor, id: string, versionNo: number | undefined, requestId: string): Promise<DownloadedDocument> {
  authorize(actor, 'expenses:read');
  const objects = need(store);
  const documentId = parse(schemas.id, id);
  const document = await repo.getDocument(pool, actor.householdId, documentId);
  if (!document || document.removedAt) throw new AppError('not_found');
  const version = await repo.getVersion(pool, actor.householdId, documentId, versionNo);
  if (!version || version.state !== 'available') throw new AppError('not_found');
  let bytes: Buffer;
  try {
    bytes = await objects.read(version.storageKey);
  } catch (error) {
    logError('documents.read_failed', error, { requestId, documentId, versionNo: version.versionNo });
    throw new AppError('storage_unavailable', 'The file is not available');
  }
  if (String(bytes.length) !== version.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== version.sha256) {
    log('error', 'documents.integrity_mismatch', { requestId, documentId, versionNo: version.versionNo });
    throw new AppError('storage_unavailable', 'The file failed its integrity check');
  }
  await recordAudit(pool, {
    householdId: actor.householdId, actorUserId: actor.userId, action: 'document.downloaded', entityType: 'document', entityId: documentId, requestId,
    detail: { documentId, versionNo: version.versionNo },
  });
  return { bytes, mediaType: version.mediaType, filename: version.originalName, versionNo: version.versionNo };
}

// ---------- maintenance (operator commands, not request handlers) ----------

export interface VerifyReport {
  checked: number; ok: number;
  missing: Array<{ documentId: string; versionNo: number }>;
  corrupt: Array<{ documentId: string; versionNo: number }>;
  /** Stored files no row refers to (an interrupted upload or a restore that brought extra files). */
  unreferenced: string[];
  quarantined: string[];
}

/**
 * Compares every available version's metadata with the stored file: present, same size, same SHA-256. Run it after a restore
 * (database and volume restored together) and before trusting a backup. It reads files and changes nothing.
 */
export async function verifyStorage(pool: Pool, store: ObjectStore): Promise<VerifyReport> {
  const report: VerifyReport = { checked: 0, ok: 0, missing: [], corrupt: [], unreferenced: [], quarantined: [] };
  let after: string | null = null;
  for (;;) {
    const page = await repo.allAvailableVersions(pool, after, 200);
    if (page.length === 0) break;
    for (const v of page) {
      report.checked++;
      let bytes: Buffer;
      try {
        bytes = await store.read(v.storageKey);
      } catch {
        report.missing.push({ documentId: v.documentId, versionNo: v.versionNo });
        continue;
      }
      if (String(bytes.length) === v.sizeBytes && createHash('sha256').update(bytes).digest('hex') === v.sha256) report.ok++;
      else report.corrupt.push({ documentId: v.documentId, versionNo: v.versionNo });
    }
    after = page[page.length - 1]!.id;
  }
  const { objects, quarantine } = await store.list();
  const known = await repo.knownStorageKeys(pool, objects.map((o) => o.key));
  report.unreferenced = objects.filter((o) => !known.has(o.key)).map((o) => o.key);
  report.quarantined = quarantine.map((q) => q.key);
  return report;
}

export interface CleanupReport { quarantineRemoved: number; unreferencedRemoved: number; purged: number }

/**
 * Removes abandoned files and purges expired ones. Quarantined files and objects with no row are removed only once older than
 * `graceMs`, so an upload that is still between promote and commit is never touched. Bytes of removed documents are deleted after
 * the retention window and their versions marked purged (metadata and checksum stay). Safe to run repeatedly and while serving.
 */
export async function cleanupStorage(pool: Pool, store: ObjectStore, opts: { graceMs?: number; retentionDays: number; now?: number }): Promise<CleanupReport> {
  const now = opts.now ?? Date.now();
  const grace = opts.graceMs ?? 60 * 60 * 1000;
  const report: CleanupReport = { quarantineRemoved: 0, unreferencedRemoved: 0, purged: 0 };
  const { objects, quarantine } = await store.list();
  for (const q of quarantine) {
    if (now - q.modifiedMs >= grace) {
      await store.removeQuarantine(q.key);
      report.quarantineRemoved++;
    }
  }
  const old = objects.filter((o) => now - o.modifiedMs >= grace);
  const known = await repo.knownStorageKeys(pool, old.map((o) => o.key));
  for (const o of old) {
    if (!known.has(o.key)) {
      await store.remove(o.key);
      report.unreferencedRemoved++;
    }
  }
  for (;;) {
    const batch = await repo.purgeCandidates(pool, opts.retentionDays, 100);
    if (batch.length === 0) break;
    for (const v of batch) {
      await store.remove(v.storageKey);
      await withTransaction(pool, async (tx) => {
        await repo.markPurged(tx, v.id);
        await recordAudit(tx, { householdId: v.householdId, actorUserId: null, action: 'document.purged', entityType: 'document', entityId: v.documentId, detail: { documentId: v.documentId, versionId: v.id } });
      });
      report.purged++;
    }
  }
  return report;
}
