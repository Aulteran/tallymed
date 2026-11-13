// SQL for the assistant settings page and the in-app proposal review, run by the web app with its full database role.
// Every query is scoped by household_id; services own authorization, lock order, transactions and audit.
import type { Queryable } from '../db.ts';
import { decodeCursor, pageOf, type Page } from '../pagination.ts';
import type { ProposalFilter } from '../validation.ts';
import type { McpScope } from './mcp.ts';

export interface ClientRow {
  id: string; name: string; scopes: McpScope[]; expiresAt: Date; lastUsedAt: Date | null; revokedAt: Date | null; revokedByName: string | null;
  createdAt: Date; createdByName: string | null; active: boolean; pendingProposals: number;
}

export async function insertClient(db: Queryable, c: { id: string; householdId: string; userId: string; name: string; tokenHash: Buffer; scopes: McpScope[]; expiryDays: number }): Promise<Date> {
  const { rows } = await db.query<{ expires_at: Date }>(
    `insert into mcp_clients (id, household_id, name, token_hash, scopes, expires_at, created_by)
     values ($1, $2, $3, $4, $5, now() + make_interval(days => $6), $7) returning expires_at`,
    [c.id, c.householdId, c.name, c.tokenHash, c.scopes, c.expiryDays, c.userId]);
  return rows[0]!.expires_at;
}

export async function listClients(db: Queryable, householdId: string): Promise<ClientRow[]> {
  const { rows } = await db.query<ClientRow>(
    `select c.id, c.name, c.scopes, c.expires_at as "expiresAt", c.last_used_at as "lastUsedAt", c.revoked_at as "revokedAt", ru.display_name as "revokedByName",
            c.created_at as "createdAt", cu.display_name as "createdByName", (c.revoked_at is null and c.expires_at > now()) as active,
            (select count(*)::int from document_match_proposals p where p.client_id = c.id and p.status = 'pending') as "pendingProposals"
       from mcp_clients c join users cu on cu.id = c.created_by left join users ru on ru.id = c.revoked_by
      where c.household_id = $1 order by c.created_at desc, c.id desc limit 100`, [householdId]);
  return rows;
}

export async function activeClientCount(db: Queryable, householdId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from mcp_clients where household_id = $1 and revoked_at is null and expires_at > now()`, [householdId]);
  return rows[0]!.n;
}

/** Revokes once. Null means it was already revoked (or is not in this household). */
export async function revokeClient(db: Queryable, householdId: string, id: string, userId: string): Promise<{ name: string } | null> {
  const { rows } = await db.query<{ name: string }>(
    `update mcp_clients set revoked_at = now(), revoked_by = $3 where household_id = $1 and id = $2 and revoked_at is null returning name`, [householdId, id, userId]);
  return rows[0] ?? null;
}

export interface ProposalRow {
  id: string; status: 'pending' | 'approved' | 'rejected'; confidence: 'low' | 'medium' | 'high'; rationale: string; createdAt: Date; sortKey: string;
  documentId: string; documentTitle: string; documentKind: string; documentNote: string; documentRemoved: boolean; documentRevision: number; pinnedVersionNo: number; documentVersionId: string; currentVersionNo: number;
  fileName: string; mediaType: string; sizeBytes: string; sha256: string;
  targetType: 'bill' | 'visit'; targetId: string; targetVersion: number; targetVersionNow: number | null;
  targetProvider: string | null; targetMember: string | null; targetDate: string | null; targetReference: string | null; targetDescription: string | null;
  alreadyAttached: boolean; clientId: string; clientName: string; clientRevoked: boolean;
  decidedAt: Date | null; decidedByName: string | null; decisionNote: string | null; attachmentId: string | null; version: number;
  /** Pending and no longer safe to approve as proposed. */
  stale: boolean;
}

const PROPOSAL_SELECT = `select p.id, p.status, p.confidence, p.rationale, p.created_at as "createdAt", p.created_at::text as "sortKey",
    p.document_id as "documentId", d.title as "documentTitle", d.kind as "documentKind", d.note as "documentNote", (d.removed_at is not null) as "documentRemoved", d.version as "documentRevision",
    p.document_version_no as "pinnedVersionNo", p.document_version_id as "documentVersionId", (select max(x.version_no) from document_versions x where x.document_id = p.document_id)::int as "currentVersionNo",
    pv.original_name as "fileName", pv.media_type as "mediaType", pv.size_bytes::text as "sizeBytes", encode(pv.sha256, 'hex') as sha256,
    p.target_type as "targetType", p.target_id as "targetId", p.target_version as "targetVersion", coalesce(b.version, vi.version) as "targetVersionNow",
    coalesce(b.provider_name_snapshot, vi.provider_name_snapshot) as "targetProvider", coalesce(b.member_name_snapshot, vi.member_name_snapshot) as "targetMember",
    coalesce(b.statement_date, vi.service_date)::text as "targetDate", b.provider_reference as "targetReference", vi.description as "targetDescription",
    exists (select 1 from document_attachments a where a.household_id = p.household_id and a.document_id = p.document_id and a.target_type = p.target_type
             and a.target_id = p.target_id and a.detached_at is null) as "alreadyAttached",
    p.client_id as "clientId", c.name as "clientName", (c.revoked_at is not null) as "clientRevoked",
    p.decided_at as "decidedAt", du.display_name as "decidedByName", p.decision_note as "decisionNote", p.attachment_id as "attachmentId", p.version,
    (p.status = 'pending' and (d.removed_at is not null
       or p.document_version_no <> (select max(x.version_no) from document_versions x where x.document_id = p.document_id)
       or coalesce(b.version, vi.version) is distinct from p.target_version
       or exists (select 1 from document_attachments a where a.household_id = p.household_id and a.document_id = p.document_id and a.target_type = p.target_type
                   and a.target_id = p.target_id and a.detached_at is null)
       or c.revoked_at is not null)) as stale
  from document_match_proposals p
  join documents d on d.household_id = p.household_id and d.id = p.document_id
  join document_versions pv on pv.id = p.document_version_id
  join mcp_clients c on c.household_id = p.household_id and c.id = p.client_id
  left join bills b on b.household_id = p.household_id and b.id = p.bill_id
  left join visits vi on vi.household_id = p.household_id and vi.id = p.visit_id
  left join users du on du.id = p.decided_by`;

export async function getProposal(db: Queryable, householdId: string, id: string): Promise<ProposalRow | null> {
  const { rows } = await db.query<ProposalRow>(`${PROPOSAL_SELECT} where p.household_id = $1 and p.id = $2`, [householdId, id]);
  return rows[0] ?? null;
}

export async function listProposals(db: Queryable, householdId: string, f: ProposalFilter): Promise<Page<ProposalRow>> {
  const params: unknown[] = [householdId];
  const where = ['p.household_id = $1'];
  if (f.status) where.push(`p.status = $${params.push(f.status)}`);
  const cur = decodeCursor(f.cursor, 2);
  if (cur) where.push(`(p.created_at, p.id) < ($${params.push(cur[0])}::timestamptz, $${params.push(cur[1])}::uuid)`);
  const { rows } = await db.query<ProposalRow>(`${PROPOSAL_SELECT} where ${where.join(' and ')} order by p.created_at desc, p.id desc limit $${params.push(f.limit + 1)}`, params);
  return pageOf(rows, f.limit, (r) => [r.sortKey, r.id]);
}

export async function pendingProposalCount(db: Queryable, householdId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from document_match_proposals where household_id = $1 and status = 'pending'`, [householdId]);
  return rows[0]!.n;
}

/** Locks the proposal row so a decision and a concurrent decision serialize. Taken after the target and document locks. */
export async function lockProposal(db: Queryable, householdId: string, id: string): Promise<boolean> {
  const { rows } = await db.query(`select id from document_match_proposals where household_id = $1 and id = $2 for update`, [householdId, id]);
  return rows.length === 1;
}

export async function markApproved(db: Queryable, householdId: string, id: string, userId: string, attachmentId: string): Promise<boolean> {
  const r = await db.query(
    `update document_match_proposals set status = 'approved', decided_by = $3, decided_at = now(), attachment_id = $4, version = version + 1
      where household_id = $1 and id = $2 and status = 'pending'`, [householdId, id, userId, attachmentId]);
  return r.rowCount === 1;
}

export async function markRejected(db: Queryable, householdId: string, id: string, userId: string, reason: string): Promise<boolean> {
  const r = await db.query(
    `update document_match_proposals set status = 'rejected', decided_by = $3, decided_at = now(), decision_note = $4, version = version + 1
      where household_id = $1 and id = $2 and status = 'pending'`, [householdId, id, userId, reason]);
  return r.rowCount === 1;
}
