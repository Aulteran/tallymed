// SQL used by the MCP listener, which connects as the restricted `tallymed_mcp` role (see migration 0008). Every statement here is a
// read of the granted columns, an insert of one proposal, or the client's last-used time. Nothing here can change a bill, payment,
// document or attachment, and every query is scoped by the authenticated client's household.
import type { Queryable } from '../db.ts';
import { decodeCursor, pageOf, type Page } from '../pagination.ts';

export type McpScope = 'documents:read' | 'records:read' | 'documents:content' | 'proposals:create';
export const MCP_SCOPES: readonly McpScope[] = ['documents:read', 'records:read', 'documents:content', 'proposals:create'];

export interface McpClientRow { id: string; householdId: string; name: string; scopes: McpScope[]; expiresAt: Date; revokedAt: Date | null; lastUsedAt: Date | null; active: boolean }

export async function findClientByDigest(db: Queryable, digest: Buffer): Promise<McpClientRow | null> {
  const { rows } = await db.query<McpClientRow>(
    `select id, household_id as "householdId", name, scopes, expires_at as "expiresAt", revoked_at as "revokedAt", last_used_at as "lastUsedAt",
            (revoked_at is null and expires_at > now()) as active
       from mcp_clients where token_hash = $1`, [digest]);
  return rows[0] ?? null;
}

/** Records use at most once a minute, so a busy client does not turn every call into a write. */
export async function touchClient(db: Queryable, id: string): Promise<void> {
  await db.query(`update mcp_clients set last_used_at = now() where id = $1 and (last_used_at is null or last_used_at < now() - interval '1 minute')`, [id]);
}

export interface McpDocument {
  id: string; title: string; kind: string; note: string; version: number; fileName: string; mediaType: string; sizeBytes: string; sha256: string;
  addedAt: Date; pendingProposals: number; sortKey: string;
}

export async function listUnmatchedDocuments(db: Queryable, householdId: string, limit: number, cursorRaw: string | undefined): Promise<Page<McpDocument>> {
  const params: unknown[] = [householdId];
  const where = [`d.household_id = $1`, `d.removed_at is null`,
    `not exists (select 1 from document_attachments a where a.household_id = d.household_id and a.document_id = d.id and a.detached_at is null)`];
  const cur = decodeCursor(cursorRaw, 2);
  if (cur) where.push(`(d.created_at, d.id) < ($${params.push(cur[0])}::timestamptz, $${params.push(cur[1])}::uuid)`);
  const { rows } = await db.query<McpDocument>(
    `select d.id, d.title, d.kind, d.note, v.version_no as version, v.original_name as "fileName", v.media_type as "mediaType", v.size_bytes::text as "sizeBytes",
            encode(v.sha256, 'hex') as sha256, d.created_at as "addedAt", d.created_at::text as "sortKey",
            (select count(*)::int from document_match_proposals p where p.household_id = d.household_id and p.document_id = d.id and p.status = 'pending') as "pendingProposals"
       from documents d
       join document_versions v on v.household_id = d.household_id and v.document_id = d.id
        and v.version_no = (select max(x.version_no) from document_versions x where x.document_id = d.id)
      where ${where.join(' and ')} and v.state = 'available'
      order by d.created_at desc, d.id desc limit $${params.push(limit + 1)}`, params);
  return pageOf(rows, limit, (r) => [r.sortKey, r.id]);
}

export interface McpRecord {
  type: 'bill' | 'visit'; id: string; memberName: string; providerName: string; version: number;
  providerReference: string | null; statementDate: string | null; dueDate: string | null; amountStatus: string | null; responsibilityCents: string | null;
  serviceDate: string | null; description: string | null; sortKey: string;
}

/** Bills or visits that no document is attached to yet. Money is read-only decimal-string cents, as in the app's contracts. */
export async function listRecordsNeedingDocuments(db: Queryable, householdId: string, type: 'bill' | 'visit', limit: number, cursorRaw: string | undefined): Promise<Page<McpRecord>> {
  const params: unknown[] = [householdId];
  const cur = decodeCursor(cursorRaw, 2);
  if (type === 'bill') {
    const where = ['b.household_id = $1', `not exists (select 1 from document_attachments a where a.household_id = b.household_id and a.target_type = 'bill' and a.target_id = b.id and a.detached_at is null)`];
    if (cur) where.push(`(b.statement_date, b.id) < ($${params.push(cur[0])}::date, $${params.push(cur[1])}::uuid)`);
    const { rows } = await db.query<McpRecord>(
      `select 'bill' as type, b.id, b.member_name_snapshot as "memberName", b.provider_name_snapshot as "providerName", b.version, b.provider_reference as "providerReference",
              b.statement_date::text as "statementDate", b.due_date::text as "dueDate", b.amount_status as "amountStatus",
              (b.base_responsibility_cents + coalesce((select sum(j.amount_cents) from bill_adjustments j where j.household_id = b.household_id and j.bill_id = b.id), 0))::text as "responsibilityCents",
              null::text as "serviceDate", null::text as description, b.statement_date::text as "sortKey"
         from bills b where ${where.join(' and ')} order by b.statement_date desc, b.id desc limit $${params.push(limit + 1)}`, params);
    return pageOf(rows, limit, (r) => [r.sortKey, r.id]);
  }
  const where = ['v.household_id = $1', `not exists (select 1 from document_attachments a where a.household_id = v.household_id and a.target_type = 'visit' and a.target_id = v.id and a.detached_at is null)`];
  if (cur) where.push(`(v.service_date, v.id) < ($${params.push(cur[0])}::date, $${params.push(cur[1])}::uuid)`);
  const { rows } = await db.query<McpRecord>(
    `select 'visit' as type, v.id, v.member_name_snapshot as "memberName", v.provider_name_snapshot as "providerName", v.version, null::text as "providerReference",
            null::text as "statementDate", null::text as "dueDate", null::text as "amountStatus", null::text as "responsibilityCents",
            v.service_date::text as "serviceDate", v.description, v.service_date::text as "sortKey"
       from visits v where ${where.join(' and ')} order by v.service_date desc, v.id desc limit $${params.push(limit + 1)}`, params);
  return pageOf(rows, limit, (r) => [r.sortKey, r.id]);
}

export interface McpVersion { id: string; versionNo: number; storageKey: string; sha256: string; sizeBytes: string; mediaType: string; state: string }

/** The current version of one live document, with what the content tool needs to read and verify it. */
export async function currentVersion(db: Queryable, householdId: string, documentId: string): Promise<McpVersion | null> {
  const { rows } = await db.query<McpVersion>(
    `select v.id, v.version_no as "versionNo", v.storage_key as "storageKey", encode(v.sha256, 'hex') as sha256, v.size_bytes::text as "sizeBytes", v.media_type as "mediaType", v.state
       from documents d join document_versions v on v.household_id = d.household_id and v.document_id = d.id
      where d.household_id = $1 and d.id = $2 and d.removed_at is null order by v.version_no desc limit 1`, [householdId, documentId]);
  return rows[0] ?? null;
}

export interface ProposalInput {
  id: string; householdId: string; clientId: string; documentId: string; targetType: 'bill' | 'visit'; targetId: string; rationale: string; confidence: 'low' | 'medium' | 'high';
}

/**
 * Inserts one proposal from a single statement that reads the document's current version and the target's current version in the
 * same snapshot it writes them, so a proposal always names versions that were current together. Nothing is locked: if either
 * changes afterwards the proposal is stale and approval refuses it. No row means the document or target is missing or gone, the
 * target already has the document attached, or the exact suggestion already exists (the caller tells them apart).
 */
export async function insertProposal(db: Queryable, p: ProposalInput): Promise<boolean> {
  const bill = p.targetType === 'bill';
  const { rows } = await db.query(
    `insert into document_match_proposals (id, household_id, client_id, document_id, document_version_id, document_version_no, target_type, bill_id, visit_id, target_version, rationale, confidence)
     select $1, $2, $3, d.id, v.id, v.version_no, $5, ${bill ? 't.id, null' : 'null, t.id'}, t.version, $7, $8
       from documents d
       join document_versions v on v.household_id = d.household_id and v.document_id = d.id and v.state = 'available'
        and v.version_no = (select max(x.version_no) from document_versions x where x.document_id = d.id)
       join ${bill ? 'bills' : 'visits'} t on t.household_id = d.household_id and t.id = $6
      where d.household_id = $2 and d.id = $4 and d.removed_at is null
        and not exists (select 1 from document_attachments a where a.household_id = d.household_id and a.document_id = d.id
                         and a.target_type = $5 and a.target_id = t.id and a.detached_at is null)
     on conflict do nothing returning id`,
    [p.id, p.householdId, p.clientId, p.documentId, p.targetType, p.targetId, p.rationale, p.confidence]);
  return rows.length === 1;
}

export type ProposalGap = 'missing' | 'already_attached' | 'already_proposed';

/** Explains why insertProposal wrote nothing. Reads only. */
export async function proposalGap(db: Queryable, p: ProposalInput): Promise<ProposalGap> {
  const col = p.targetType === 'bill' ? 'bills' : 'visits';
  const { rows } = await db.query<{ doc: boolean; target: boolean; attached: boolean; proposed: boolean }>(
    `select exists (select 1 from documents d where d.household_id = $1 and d.id = $2 and d.removed_at is null) as doc,
            exists (select 1 from ${col} t where t.household_id = $1 and t.id = $3) as target,
            exists (select 1 from document_attachments a where a.household_id = $1 and a.document_id = $2 and a.target_type = $4 and a.target_id = $3 and a.detached_at is null) as attached,
            exists (select 1 from document_match_proposals q where q.household_id = $1 and q.document_id = $2 and q.target_type = $4 and q.target_id = $3
                     and q.document_version_no = (select max(x.version_no) from document_versions x where x.document_id = $2)) as proposed`,
    [p.householdId, p.documentId, p.targetId, p.targetType]);
  const r = rows[0]!;
  if (!r.doc || !r.target) return 'missing';
  if (r.attached) return 'already_attached';
  return r.proposed ? 'already_proposed' : 'missing';
}

export async function pendingCounts(db: Queryable, clientId: string, householdId: string): Promise<{ client: number; household: number }> {
  const { rows } = await db.query<{ client: number; household: number }>(
    `select count(*) filter (where client_id = $1)::int as client, count(*)::int as household
       from document_match_proposals where household_id = $2 and status = 'pending'`, [clientId, householdId]);
  return rows[0]!;
}

export interface McpProposal {
  id: string; documentId: string; documentVersion: number; targetType: string; targetId: string; confidence: string; status: string; createdAt: Date; decidedAt: Date | null; sortKey: string;
}

/** A client sees only its own proposals and their outcome, never who decided or the decision note. */
export async function listClientProposals(db: Queryable, clientId: string, status: string | undefined, limit: number, cursorRaw: string | undefined): Promise<Page<McpProposal>> {
  const params: unknown[] = [clientId];
  const where = ['client_id = $1'];
  if (status) where.push(`status = $${params.push(status)}`);
  const cur = decodeCursor(cursorRaw, 2);
  if (cur) where.push(`(created_at, id) < ($${params.push(cur[0])}::timestamptz, $${params.push(cur[1])}::uuid)`);
  const { rows } = await db.query<McpProposal>(
    `select id, document_id as "documentId", document_version_no as "documentVersion", target_type as "targetType", target_id as "targetId", confidence, status,
            created_at as "createdAt", decided_at as "decidedAt", created_at::text as "sortKey"
       from document_match_proposals where ${where.join(' and ')} order by created_at desc, id desc limit $${params.push(limit + 1)}`, params);
  return pageOf(rows, limit, (r) => [r.sortKey, r.id]);
}
