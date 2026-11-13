// SQL only for documents, versions and attachments. Every query is scoped by household_id; services own authorization,
// locking order, transactions, storage and audit.
import type { Queryable } from '../db.ts';
import { decodeCursor, pageOf, type Page } from '../pagination.ts';
import type { DocumentFilter } from '../validation.ts';

export type TargetType = 'bill' | 'visit' | 'bill_adjustment' | 'hsa_receipt' | 'hsa_eligibility_decision';
export type DocumentKind = 'bill' | 'eob' | 'receipt' | 'statement' | 'provider_letter' | 'plan_document' | 'other';

export interface DocumentRow {
  id: string; title: string; kind: DocumentKind; note: string; version: number; removedAt: Date | null; removalReason: string | null;
  createdAt: Date; createdByName: string | null; versionCount: number; activeAttachments: number;
  currentVersionId: string; currentVersionNo: number; mediaType: string; sizeBytes: string; sha256: string; originalName: string; state: 'available' | 'purged';
  /** The database's own rendering of created_at, used as the keyset cursor so microseconds survive the round trip. */
  sortKey: string;
}

export interface VersionRow {
  id: string; documentId: string; versionNo: number; storageKey: string; sha256: string; sizeBytes: string; mediaType: string; originalName: string;
  state: 'available' | 'purged'; createdAt: Date; createdByName: string | null;
}

export interface AttachmentRow {
  id: string; documentId: string; documentTitle: string; documentVersionId: string; versionNo: number; currentVersionNo: number; targetType: TargetType; targetId: string;
  billId: string | null; allocationId: string | null; note: string; createdAt: Date; createdByName: string | null;
  detachedAt: Date | null; detachedByName: string | null; detachReason: string | null; mediaType: string; sha256: string; documentRemoved: boolean;
}

const DOC_SELECT = `select d.id, d.title, d.kind, d.note, d.version, d.removed_at as "removedAt", d.removal_reason as "removalReason", d.created_at as "createdAt",
    u.display_name as "createdByName", d.created_at::text as "sortKey",
    (select count(*) from document_versions x where x.document_id = d.id)::int as "versionCount",
    (select count(*) from document_attachments a where a.document_id = d.id and a.detached_at is null)::int as "activeAttachments",
    v.id as "currentVersionId", v.version_no as "currentVersionNo", v.media_type as "mediaType", v.size_bytes::text as "sizeBytes",
    encode(v.sha256, 'hex') as sha256, v.original_name as "originalName", v.state
  from documents d
  join users u on u.id = d.created_by
  join lateral (select * from document_versions x where x.document_id = d.id order by x.version_no desc limit 1) v on true`;

export async function getDocument(db: Queryable, householdId: string, id: string): Promise<DocumentRow | null> {
  const { rows } = await db.query<DocumentRow>(`${DOC_SELECT} where d.household_id = $1 and d.id = $2`, [householdId, id]);
  return rows[0] ?? null;
}

const like = (v: string) => `%${v.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export async function listDocuments(db: Queryable, householdId: string, f: DocumentFilter): Promise<Page<DocumentRow>> {
  const params: unknown[] = [householdId];
  const where = ['d.household_id = $1', 'd.removed_at is null'];
  if (f.kind) where.push(`d.kind = $${params.push(f.kind)}`);
  if (f.q) where.push(`(d.title ilike $${params.push(like(f.q))} or v.original_name ilike $${params.length})`);
  if (f.unmatched) where.push('not exists (select 1 from document_attachments a where a.document_id = d.id and a.detached_at is null)');
  const cur = decodeCursor(f.cursor, 2);
  if (cur) where.push(`(d.created_at, d.id) < ($${params.push(cur[0])}::timestamptz, $${params.push(cur[1])}::uuid)`);
  const { rows } = await db.query<DocumentRow>(
    `${DOC_SELECT} where ${where.join(' and ')} order by d.created_at desc, d.id desc limit $${params.push(f.limit + 1)}`, params);
  return pageOf(rows, f.limit, (r) => [r.sortKey, r.id]);
}

/** Documents offered by the attach pickers: newest first, bounded, and never those already attached to the given target. */
export async function pickDocuments(db: Queryable, householdId: string, q: string | undefined, exclude: { type: TargetType; id: string } | null, limit = 50): Promise<DocumentRow[]> {
  const params: unknown[] = [householdId];
  const where = ['d.household_id = $1', 'd.removed_at is null'];
  if (q) where.push(`(d.title ilike $${params.push(like(q))} or v.original_name ilike $${params.length})`);
  if (exclude) where.push(`not exists (select 1 from document_attachments a where a.document_id = d.id and a.detached_at is null and a.target_type = $${params.push(exclude.type)} and a.target_id = $${params.push(exclude.id)})`);
  const { rows } = await db.query<DocumentRow>(`${DOC_SELECT} where ${where.join(' and ')} order by d.created_at desc, d.id desc limit $${params.push(limit)}`, params);
  return rows;
}

export async function unmatchedCount(db: Queryable, householdId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `select count(*)::int as n from documents d where d.household_id = $1 and d.removed_at is null
       and not exists (select 1 from document_attachments a where a.document_id = d.id and a.detached_at is null)`, [householdId]);
  return rows[0]!.n;
}

export async function unmatchedQueue(db: Queryable, householdId: string, limit: number): Promise<DocumentRow[]> {
  const { rows } = await db.query<DocumentRow>(
    `${DOC_SELECT} where d.household_id = $1 and d.removed_at is null
       and not exists (select 1 from document_attachments a where a.document_id = d.id and a.detached_at is null)
     order by d.created_at desc, d.id desc limit $2`, [householdId, limit]);
  return rows;
}

const VERSION_SELECT = `select v.id, v.document_id as "documentId", v.version_no as "versionNo", v.storage_key as "storageKey", encode(v.sha256, 'hex') as sha256,
    v.size_bytes::text as "sizeBytes", v.media_type as "mediaType", v.original_name as "originalName", v.state, v.created_at as "createdAt", u.display_name as "createdByName"
  from document_versions v join users u on u.id = v.created_by`;

export async function listVersions(db: Queryable, householdId: string, documentId: string): Promise<VersionRow[]> {
  const { rows } = await db.query<VersionRow>(`${VERSION_SELECT} where v.household_id = $1 and v.document_id = $2 order by v.version_no desc`, [householdId, documentId]);
  return rows;
}

/** One version of a document (the newest when versionNo is omitted). */
export async function getVersion(db: Queryable, householdId: string, documentId: string, versionNo?: number): Promise<VersionRow | null> {
  const { rows } = await db.query<VersionRow>(
    `${VERSION_SELECT} where v.household_id = $1 and v.document_id = $2 ${versionNo === undefined ? '' : 'and v.version_no = $3'} order by v.version_no desc limit 1`,
    versionNo === undefined ? [householdId, documentId] : [householdId, documentId, versionNo]);
  return rows[0] ?? null;
}

/** Locks the document row. Every document writer takes this lock before it reads or writes the document's versions or links. */
export async function lockDocument(db: Queryable, householdId: string, id: string): Promise<{ id: string; version: number; removedAt: Date | null } | null> {
  const { rows } = await db.query<{ id: string; version: number; removedAt: Date | null }>(
    `select id, version, removed_at as "removedAt" from documents where household_id = $1 and id = $2 for no key update`, [householdId, id]);
  return rows[0] ?? null;
}

export async function insertDocument(db: Queryable, d: { id: string; householdId: string; userId: string; title: string; kind: DocumentKind; note: string }): Promise<void> {
  await db.query(`insert into documents (id, household_id, title, kind, note, created_by) values ($1, $2, $3, $4, $5, $6)`, [d.id, d.householdId, d.title, d.kind, d.note, d.userId]);
}

export async function insertVersion(db: Queryable, v: {
  id: string; householdId: string; userId: string; documentId: string; versionNo: number; storageKey: string; sha256: Buffer; sizeBytes: number; mediaType: string; originalName: string;
}): Promise<void> {
  await db.query(
    `insert into document_versions (id, household_id, document_id, version_no, storage_key, sha256, size_bytes, media_type, original_name, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [v.id, v.householdId, v.documentId, v.versionNo, v.storageKey, v.sha256, v.sizeBytes, v.mediaType, v.originalName, v.userId]);
}

export async function updateDocument(db: Queryable, householdId: string, id: string, version: number, v: { title: string; kind: DocumentKind; note: string }): Promise<boolean> {
  const r = await db.query(
    `update documents set title = $4, kind = $5, note = $6, version = version + 1, updated_at = now()
     where household_id = $1 and id = $2 and version = $3 and removed_at is null`, [householdId, id, version, v.title, v.kind, v.note]);
  return r.rowCount === 1;
}

export async function bumpVersion(db: Queryable, householdId: string, id: string): Promise<void> {
  await db.query(`update documents set version = version + 1, updated_at = now() where household_id = $1 and id = $2`, [householdId, id]);
}

export async function markRemoved(db: Queryable, householdId: string, id: string, version: number, userId: string, reason: string): Promise<boolean> {
  const r = await db.query(
    `update documents set removed_at = now(), removed_by = $4, removal_reason = $5, version = version + 1, updated_at = now()
     where household_id = $1 and id = $2 and version = $3 and removed_at is null`, [householdId, id, version, userId, reason]);
  return r.rowCount === 1;
}

export async function storedBytes(db: Queryable, householdId: string): Promise<bigint> {
  const { rows } = await db.query<{ total: string }>(
    `select coalesce(sum(size_bytes), 0)::text as total from document_versions where household_id = $1 and state = 'available'`, [householdId]);
  return BigInt(rows[0]!.total);
}

/** Another document already holds identical bytes (an upload hint, never an automatic merge). */
export async function findByChecksum(db: Queryable, householdId: string, sha256: Buffer): Promise<{ documentId: string; title: string } | null> {
  const { rows } = await db.query<{ documentId: string; title: string }>(
    `select d.id as "documentId", d.title from document_versions v join documents d on d.id = v.document_id
     where v.household_id = $1 and v.sha256 = $2 and d.removed_at is null order by v.created_at limit 1`, [householdId, sha256]);
  return rows[0] ?? null;
}

// ---------- attachments ----------

export interface TargetColumns { billId: string | null; visitId: string | null; adjustmentBillId: string | null; adjustmentId: string | null; receiptId: string | null; decisionId: string | null }

export function targetColumns(type: TargetType, id: string, billId?: string): TargetColumns {
  const none: TargetColumns = { billId: null, visitId: null, adjustmentBillId: null, adjustmentId: null, receiptId: null, decisionId: null };
  switch (type) {
    case 'bill': return { ...none, billId: id };
    case 'visit': return { ...none, visitId: id };
    case 'bill_adjustment': return { ...none, adjustmentId: id, adjustmentBillId: billId ?? null };
    case 'hsa_receipt': return { ...none, receiptId: id };
    default: return { ...none, decisionId: id };
  }
}

export async function insertAttachment(db: Queryable, a: {
  id: string; householdId: string; userId: string; documentId: string; versionId: string; type: TargetType; targetId: string; billId?: string; note: string;
}): Promise<void> {
  const t = targetColumns(a.type, a.targetId, a.billId);
  await db.query(
    `insert into document_attachments (id, household_id, document_id, document_version_id, target_type, bill_id, visit_id, adjustment_bill_id, adjustment_id, hsa_receipt_id, hsa_decision_id, note, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [a.id, a.householdId, a.documentId, a.versionId, a.type, t.billId, t.visitId, t.adjustmentBillId, t.adjustmentId, t.receiptId, t.decisionId, a.note, a.userId]);
}

const ATTACHMENT_SELECT = `select a.id, a.document_id as "documentId", d.title as "documentTitle", a.document_version_id as "documentVersionId", v.version_no as "versionNo",
    (select max(x.version_no) from document_versions x where x.document_id = a.document_id)::int as "currentVersionNo",
    a.target_type as "targetType", a.target_id as "targetId", coalesce(a.bill_id, a.adjustment_bill_id) as "billId",
    (select x.allocation_id from hsa_eligibility_decisions x where x.id = a.hsa_decision_id) as "allocationId", a.note, a.created_at as "createdAt",
    cu.display_name as "createdByName", a.detached_at as "detachedAt", du.display_name as "detachedByName", a.detach_reason as "detachReason",
    v.media_type as "mediaType", encode(v.sha256, 'hex') as sha256, (d.removed_at is not null) as "documentRemoved"
  from document_attachments a
  join documents d on d.household_id = a.household_id and d.id = a.document_id
  join document_versions v on v.id = a.document_version_id
  join users cu on cu.id = a.created_by
  left join users du on du.id = a.detached_by`;

export async function getAttachment(db: Queryable, householdId: string, id: string): Promise<AttachmentRow | null> {
  const { rows } = await db.query<AttachmentRow>(`${ATTACHMENT_SELECT} where a.household_id = $1 and a.id = $2`, [householdId, id]);
  return rows[0] ?? null;
}

export async function attachmentsOfDocument(db: Queryable, householdId: string, documentId: string): Promise<AttachmentRow[]> {
  const { rows } = await db.query<AttachmentRow>(`${ATTACHMENT_SELECT} where a.household_id = $1 and a.document_id = $2 order by a.created_at desc, a.id desc`, [householdId, documentId]);
  return rows;
}

/** Link history of one record: active links first, then detached ones, newest first. Bounded. */
export async function attachmentsOfTarget(db: Queryable, householdId: string, type: TargetType, targetId: string, limit = 100): Promise<AttachmentRow[]> {
  const { rows } = await db.query<AttachmentRow>(
    `${ATTACHMENT_SELECT} where a.household_id = $1 and a.target_type = $2 and a.target_id = $3
     order by (a.detached_at is not null), a.created_at desc, a.id desc limit $4`, [householdId, type, targetId, limit]);
  return rows;
}

export async function activeAttachmentCount(db: Queryable, householdId: string, documentId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from document_attachments where household_id = $1 and document_id = $2 and detached_at is null`, [householdId, documentId]);
  return rows[0]!.n;
}

/** Active links on one record (exact, not capped) and whether one document is already among them. */
export async function activeTargetLinks(db: Queryable, householdId: string, type: TargetType, targetId: string, documentId: string): Promise<{ total: number; hasDocument: boolean }> {
  const { rows } = await db.query<{ total: number; has: boolean }>(
    `select count(*)::int as total, coalesce(bool_or(document_id = $4), false) as has from document_attachments
     where household_id = $1 and target_type = $2 and target_id = $3 and detached_at is null`, [householdId, type, targetId, documentId]);
  return { total: rows[0]!.total, hasDocument: rows[0]!.has };
}

/** Detaches an active link once. False means it was already detached (a concurrent request won). */
export async function markDetached(db: Queryable, householdId: string, id: string, userId: string, reason: string): Promise<boolean> {
  const r = await db.query(
    `update document_attachments set detached_at = now(), detached_by = $3, detach_reason = $4 where household_id = $1 and id = $2 and detached_at is null`,
    [householdId, id, userId, reason]);
  return r.rowCount === 1;
}

/** Locks the record a link points at, in the global lock order (bills first). Immutable targets take a share lock. */
export async function lockTarget(db: Queryable, householdId: string, type: TargetType, id: string, billId?: string): Promise<boolean> {
  if (type === 'bill' || type === 'bill_adjustment') {
    const { rows } = await db.query(`select id from bills where household_id = $1 and id = $2 for no key update`, [householdId, type === 'bill' ? id : billId]);
    return rows.length === 1;
  }
  const table = type === 'visit' ? 'visits' : type === 'hsa_receipt' ? 'hsa_receipts' : 'hsa_eligibility_decisions';
  const { rows } = await db.query(`select id from ${table} where household_id = $1 and id = $2 for key share`, [householdId, id]);
  return rows.length === 1;
}

export async function documentHistory(db: Queryable, householdId: string, documentId: string): Promise<Array<{ id: string; action: string; actorName: string | null; occurredAt: Date; detail: Record<string, unknown> }>> {
  const { rows } = await db.query(
    `select e.id::text, e.action, u.display_name as "actorName", e.occurred_at as "occurredAt", e.detail
     from audit_events e left join users u on u.id = e.actor_user_id
     where e.household_id = $1 and e.action like 'document.%' and e.detail ->> 'documentId' = $2 order by e.id`, [householdId, documentId]);
  return rows;
}

// ---------- maintenance ----------

export async function allAvailableVersions(db: Queryable, after: string | null, limit: number): Promise<Array<{ id: string; storageKey: string; sha256: string; sizeBytes: string; documentId: string; versionNo: number }>> {
  const { rows } = await db.query(
    `select id, storage_key as "storageKey", encode(sha256, 'hex') as sha256, size_bytes::text as "sizeBytes", document_id as "documentId", version_no as "versionNo"
     from document_versions where state = 'available' and ($1::uuid is null or id > $1::uuid) order by id limit $2`, [after, limit]);
  return rows;
}

export async function knownStorageKeys(db: Queryable, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const { rows } = await db.query<{ storage_key: string }>(`select storage_key from document_versions where storage_key = any($1::text[])`, [keys]);
  return new Set(rows.map((r) => r.storage_key));
}

/** Versions of removed documents whose retention window has passed and whose bytes are still stored. */
export async function purgeCandidates(db: Queryable, olderThanDays: number, limit: number): Promise<Array<{ id: string; storageKey: string; documentId: string; householdId: string }>> {
  const { rows } = await db.query(
    `select v.id, v.storage_key as "storageKey", v.document_id as "documentId", v.household_id as "householdId"
     from document_versions v join documents d on d.id = v.document_id
     where v.state = 'available' and d.removed_at is not null and d.removed_at <= now() - make_interval(days => $1) order by v.id limit $2`, [olderThanDays, limit]);
  return rows;
}

export async function purgeCount(db: Queryable, olderThanDays: number): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `select count(*)::int as n from document_versions v join documents d on d.id = v.document_id
     where v.state = 'available' and d.removed_at is not null and d.removed_at <= now() - make_interval(days => $1)`, [olderThanDays]);
  return rows[0]!.n;
}

export async function availableVersionCount(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from document_versions where state = 'available'`);
  return rows[0]!.n;
}

export async function markPurged(db: Queryable, id: string): Promise<void> {
  await db.query(`update document_versions set state = 'purged', purged_at = now() where id = $1 and state = 'available'`, [id]);
}
