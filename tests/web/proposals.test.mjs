// In-app proposal review (M06): approval attaches exactly the reviewed document version to exactly the reviewed record, once;
// stale, repeated, concurrent, rejected and revoked-client cases; authorization; database guards; and the HTTP routes.
// Synthetic data only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import * as handlers from '../../apps/web/server/http.ts';
import { hashPassword } from '../../apps/web/server/passwords.ts';
import { retryStats } from '../../apps/web/server/services/support.ts';
import { PASSWORD, post, skipDb } from './helpers.mjs';
import { PDF_FILE, PNG_FILE, assistant, docs, mcpFixture, svc } from './mcp-helpers.mjs';

const rows = async (t, sql, params = []) => (await t.db.pool.query(sql, params)).rows;
const one = async (t, sql, params = []) => (await rows(t, sql, params))[0];
const attachments = (t) => rows(t, `select * from document_attachments order by created_at`);

/** A scene with one proposal made through the real MCP tool. */
async function proposed(t, over = {}) {
  const s = await t.scene();
  const token = (await t.client()).token;
  const c = await t.connect(token);
  const args = { documentId: s.doc.id, targetType: 'bill', targetId: s.bill.id, confidence: 'high', rationale: 'Same provider and statement date.', ...over };
  const r = await t.tool(c, 'propose_document_match', args);
  assert.equal(r.isError, false, JSON.stringify(r.data));
  return { s, c, token, args, id: r.data.proposalId };
}
/** Approves as a reviewer who has just loaded the page: the document revision defaults to the live one. */
const approve = async (t, id, over = {}, actor = t.actor) => {
  const documentRevision = (await one(t, `select d.version from documents d join document_match_proposals p on p.document_id = d.id where p.id = $1`, [id]))?.version ?? 1;
  return assistant.approveProposal(t.db.pool, actor, { idempotencyKey: randomUUID(), proposalId: id, documentVersion: 1, targetVersion: 1, documentRevision, ...over }, 'r');
};
const reject = (t, id, over = {}, actor = t.actor) => assistant.rejectProposal(t.db.pool, actor, { proposalId: id, reason: 'Not the right bill', ...over }, 'r');

test('approving attaches the reviewed document version to the reviewed record once, with provenance', { skip: skipDb }, async () => {
  const t = await mcpFixture();
  try {
    const { s, c, id } = await proposed(t);
    const detail = await assistant.getProposal(t.db.pool, t.actor, id);
    assert.equal(detail.status, 'pending');
    assert.equal(detail.stale, false);
    assert.equal(detail.documentTitle, 'Statement February');
    assert.equal(detail.targetProvider, 'Example Clinic');
    assert.equal(detail.clientName, 'Example assistant');
    assert.equal((await assistant.pendingProposalCount(t.db.pool, t.actor)), 1);
    assert.equal((await attachments(t)).length, 0);

    const key = randomUUID();
    const ok = await approve(t, id, { idempotencyKey: key });
    assert.deepEqual(ok, { id, replayed: false });
    const [a] = await attachments(t);
    assert.equal(a.document_id, s.doc.id);
    assert.equal(a.target_type, 'bill');
    assert.equal(a.target_id, s.bill.id);
    assert.equal(a.created_by, t.actor.userId);
    assert.equal(a.detached_at, null);
    const v1 = await one(t, `select id from document_versions where document_id = $1 and version_no = 1`, [s.doc.id]);
    assert.equal(a.document_version_id, v1.id);
    const p = await one(t, `select * from document_match_proposals where id = $1`, [id]);
    assert.equal(p.status, 'approved');
    assert.equal(p.decided_by, t.actor.userId);
    assert.equal(p.attachment_id, a.id);
    assert.equal(p.version, 2);
    // The same request again is a replay: no second attachment, no second decision.
    assert.deepEqual(await approve(t, id, { idempotencyKey: key }), { id, replayed: true });
    assert.equal((await attachments(t)).length, 1);
    // A new request on a decided proposal is refused.
    await assert.rejects(approve(t, id), { code: 'conflict' });
    await assert.rejects(reject(t, id), { code: 'conflict' });
    // Provenance and audit.
    const audit = await rows(t, `select action, detail, actor_user_id from audit_events where action in ('proposal.created', 'proposal.approved', 'document.attached') order by id`);
    assert.deepEqual(audit.map((r) => r.action), ['proposal.created', 'proposal.approved', 'document.attached']);
    const approved = audit[1];
    assert.equal(approved.actor_user_id, t.actor.userId);
    assert.equal(approved.detail.proposalId, id);
    assert.equal(approved.detail.attachmentId, a.id);
    assert.equal(approved.detail.clientId, p.client_id);
    assert.equal(audit[2].detail.proposalId, id);
    // The document leaves the unmatched list the assistant sees, and the client sees the outcome.
    assert.deepEqual((await t.tool(c, 'list_unmatched_documents')).data.documents.map((d) => d.id), []);
    assert.equal((await t.tool(c, 'list_my_proposals')).data.proposals[0].status, 'approved');
    assert.equal((await t.tool(c, 'list_records_needing_documents', { type: 'bill' })).data.records.length, 0);
    // Detail shows the decision.
    const after = await assistant.getProposal(t.db.pool, t.actor, id);
    assert.equal(after.decidedByName, 'Alex Example');
    assert.equal(after.attachmentId, a.id);
  } finally {
    await t.drop();
  }
});

test('simultaneous approvals and approve-versus-reject races decide a proposal exactly once without lock conflicts', { skip: skipDb }, async () => {
  const t = await mcpFixture();
  try {
    const conflictsBefore = retryStats.lockConflicts;
    const { id } = await proposed(t);
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => approve(t, id)));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    for (const r of results.filter((x) => x.status === 'rejected')) assert.equal(r.reason.code, 'conflict');
    assert.equal((await attachments(t)).length, 1);
    // Approve against reject on a fresh proposal.
    const second = await proposed(t);
    const race = await Promise.allSettled([approve(t, second.id), reject(t, second.id), approve(t, second.id), reject(t, second.id)]);
    assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1);
    const p = await one(t, `select status, attachment_id from document_match_proposals where id = $1`, [second.id]);
    assert.equal((await attachments(t)).length, p.status === 'approved' ? 2 : 1);
    assert.equal(p.status === 'approved', p.attachment_id !== null);
    assert.equal(retryStats.lockConflicts, conflictsBefore);
    // An approval racing a manual attach of the same pair: one attachment.
    const third = await proposed(t);
    const manual = docs.attachDocument(t.db.pool, t.actor, { idempotencyKey: randomUUID(), documentId: third.s.doc.id, targetType: 'bill', targetId: third.s.bill.id }, 'r');
    const both = await Promise.allSettled([manual, approve(t, third.id)]);
    assert.equal(both.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal((await rows(t, `select 1 from document_attachments where document_id = $1 and target_id = $2 and detached_at is null`, [third.s.doc.id, third.s.bill.id])).length, 1);
    assert.equal(retryStats.lockConflicts, conflictsBefore);
  } finally {
    await t.drop();
  }
});

test('a newer document version makes the proposal stale; approval is refused and a fresh proposal for the new version works', { skip: skipDb }, async () => {
  const t = await mcpFixture();
  try {
    const { s, c, id } = await proposed(t);
    await docs.addDocumentVersion(t.deps, t.actor, { idempotencyKey: randomUUID(), documentId: s.doc.id, version: 1, file: PNG_FILE() }, 'r');
    const d = await assistant.getProposal(t.db.pool, t.actor, id);
    assert.equal(d.stale, true);
    assert.equal(d.currentVersionNo, 2);
    assert.equal(d.pinnedVersionNo, 1);
    await assert.rejects(approve(t, id), { code: 'stale_version' });
    await assert.rejects(approve(t, id, { documentVersion: 2 }), { code: 'stale_version' });
    assert.equal((await attachments(t)).length, 0);
    assert.equal((await one(t, `select status from document_match_proposals where id = $1`, [id])).status, 'pending');
    await reject(t, id, { reason: 'Document replaced' });
    // The assistant may propose the new version; the old pair is already decided.
    const again = await t.tool(c, 'propose_document_match', { documentId: s.doc.id, targetType: 'bill', targetId: s.bill.id, confidence: 'high', rationale: 'Re-checked the new version' });
    assert.equal(again.isError, false);
    const p2 = await one(t, `select document_version_no from document_match_proposals where id = $1`, [again.data.proposalId]);
    assert.equal(p2.document_version_no, 2);
    await approve(t, again.data.proposalId, { documentVersion: 2 });
    const [a] = await attachments(t);
    assert.equal((await one(t, `select version_no from document_versions where id = $1`, [a.document_version_id])).version_no, 2);
  } finally {
    await t.drop();
  }
});

test('an edited bill, a removed document, an existing link or a view that moved on each refuse approval', { skip: skipDb }, async () => {
  const t = await mcpFixture();
  try {
    // The bill is edited after the proposal.
    const a = await proposed(t);
    await svc.updateBill(t.db.pool, t.actor, { id: a.s.bill.id, version: 1, providerId: a.s.p, providerReference: 'INV-1001', statementDate: '2026-01-02', notes: 'edited' }, 'r');
    assert.equal((await assistant.getProposal(t.db.pool, t.actor, a.id)).stale, true);
    await assert.rejects(approve(t, a.id), { code: 'stale_version' });
    await assert.rejects(approve(t, a.id, { targetVersion: 2 }), { code: 'stale_version' });
    // The person's view is not the proposal's version.
    const b = await proposed(t);
    await assert.rejects(approve(t, b.id, { documentVersion: 7 }), { code: 'stale_version' });
    await assert.rejects(approve(t, b.id, { targetVersion: 3 }), { code: 'stale_version' });
    // The document is removed.
    const c = await proposed(t);
    await docs.removeDocument(t.db.pool, t.actor, { id: c.s.doc.id, version: 1, reason: 'uploaded by mistake' }, 'r');
    assert.equal((await assistant.getProposal(t.db.pool, t.actor, c.id)).stale, true);
    await assert.rejects(approve(t, c.id), { code: 'stale_version' });
    // Someone attached the same pair by hand first.
    const d = await proposed(t);
    await docs.attachDocument(t.db.pool, t.actor, { idempotencyKey: randomUUID(), documentId: d.s.doc.id, targetType: 'bill', targetId: d.s.bill.id }, 'r');
    const flagged = await assistant.getProposal(t.db.pool, t.actor, d.id);
    assert.equal(flagged.alreadyAttached, true);
    assert.equal(flagged.stale, true);
    await assert.rejects(approve(t, d.id), { code: 'conflict' });
    assert.equal((await attachments(t)).length, 1);
    // Unknown and malformed ids.
    await assert.rejects(approve(t, randomUUID()), { code: 'not_found' });
    await assert.rejects(assistant.approveProposal(t.db.pool, t.actor, { proposalId: 'x' }, 'r'), { code: 'invalid_input' });
    await assert.rejects(assistant.approveProposal(t.db.pool, t.actor, { idempotencyKey: randomUUID(), proposalId: a.id, documentVersion: 1, targetVersion: 1, documentRevision: 1, extra: 'x' }, 'r'), { code: 'invalid_input' });
    // Every refusal left the proposals pending and the lists intact.
    assert.equal((await assistant.listProposals(t.db.pool, t.actor, { status: 'pending' })).items.length, 4);
  } finally {
    await t.drop();
  }
});

test('a rejected proposal stays rejected, keeps its reason and cannot be raised again for the same version', { skip: skipDb }, async () => {
  const t = await mcpFixture();
  try {
    const { s, c, args, id } = await proposed(t);
    await assert.rejects(reject(t, id, { reason: '' }), { code: 'invalid_input' });
    assert.deepEqual(await reject(t, id, { reason: 'Different provider' }), { id });
    const p = await one(t, `select * from document_match_proposals where id = $1`, [id]);
    assert.equal(p.status, 'rejected');
    assert.equal(p.decision_note, 'Different provider');
    assert.equal(p.attachment_id, null);
    assert.equal((await attachments(t)).length, 0);
    await assert.rejects(approve(t, id), { code: 'conflict' });
    await assert.rejects(reject(t, id), { code: 'conflict' });
    // The assistant sees the outcome but not the reason, and cannot raise the same pair again.
    const mine = (await t.tool(c, 'list_my_proposals', { status: 'rejected' })).data.proposals;
    assert.equal(mine.length, 1);
    assert.ok(!JSON.stringify(mine).includes('Different provider'));
    const retry = await t.tool(c, 'propose_document_match', args);
    assert.equal(retry.data.error.code, 'conflict');
    assert.match(retry.data.error.message, /already proposed/);
    // A different record is a different proposal.
    const other = await t.tool(c, 'propose_document_match', { ...args, targetType: 'visit', targetId: s.visit.id });
    assert.equal(other.isError, false);
    const audit = await rows(t, `select detail from audit_events where action = 'proposal.rejected'`);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].detail.wasStale, false);
    assert.ok(!JSON.stringify(audit).includes('Different provider'));
  } finally {
    await t.drop();
  }
});

test('editing the document after the reviewer opened the proposal refuses the approval', { skip: skipDb }, async () => {
  const t = await mcpFixture();
  try {
    const a = await proposed(t);
    const seen = (await one(t, `select version from documents where id = $1`, [a.s.doc.id])).version;
    await docs.updateDocument(t.db.pool, t.actor, { id: a.s.doc.id, version: String(seen), title: 'A different title', kind: 'other' }, 'r');
    await assert.rejects(approve(t, a.id, { documentRevision: seen }), { code: 'stale_version' });
    assert.equal((await attachments(t)).length, 0);
    const now = (await assistant.getProposal(t.db.pool, t.actor, a.id)).documentRevision;
    assert.equal(now, seen + 1);
    await approve(t, a.id, { documentRevision: now });
    assert.equal((await attachments(t)).length, 1);
  } finally {
    await t.drop();
  }
});

test('revoking the proposing credential blocks approval of its proposals but not rejection', { skip: skipDb }, async () => {
  const t = await mcpFixture();
  try {
    const a = await proposed(t);
    const client = (await rows(t, `select client_id from document_match_proposals where id = $1`, [a.id]))[0].client_id;
    await assistant.revokeClient(t.db.pool, t.actor, { clientId: client, reason: 'key leaked' }, 'r');
    // The reason a person gave is kept in the audit trail.
    assert.equal((await rows(t, `select detail from audit_events where action = 'assistant.client_revoked'`))[0].detail.reason, 'key leaked');
    const d = await assistant.getProposal(t.db.pool, t.actor, a.id);
    assert.equal(d.clientRevoked, true);
    assert.equal(d.stale, true);
    await assert.rejects(approve(t, a.id), { code: 'conflict' });
    assert.equal((await attachments(t)).length, 0);
    await reject(t, a.id, { reason: 'Credential revoked' });
    const listed = await assistant.listClients(t.db.pool, t.actor);
    assert.equal(listed[0].active, false);
    assert.equal(listed[0].pendingProposals, 0);
  } finally {
    await t.drop();
  }
});

test('access: operators review, only administrators manage credentials, and another household sees and decides nothing', { skip: skipDb }, async () => {
  const t = await mcpFixture();
  try {
    const op = await t.secondOperator('operator');
    const other = await t.other();
    const a = await proposed(t);
    // Operators can read, approve and reject; they cannot create or revoke credentials or list them.
    assert.equal((await assistant.listProposals(t.db.pool, op.actor, {})).items.length, 1);
    await assert.rejects(assistant.createClient(t.db.pool, op.actor, { name: 'x', expiryDays: 5, documentsRead: 'yes' }, 'r'), { code: 'forbidden' });
    await assert.rejects(assistant.listClients(t.db.pool, op.actor), { code: 'forbidden' });
    const cl = (await rows(t, `select id from mcp_clients`))[0].id;
    await assert.rejects(assistant.revokeClient(t.db.pool, op.actor, { clientId: cl, reason: 'x' }, 'r'), { code: 'forbidden' });
    // Another household's administrator cannot see, approve, reject or revoke anything of this household's.
    assert.deepEqual((await assistant.listProposals(t.db.pool, other.actor, {})).items, []);
    assert.deepEqual(await assistant.listClients(t.db.pool, other.actor), []);
    await assert.rejects(assistant.getProposal(t.db.pool, other.actor, a.id), { code: 'not_found' });
    await assert.rejects(approve(t, a.id, {}, other.actor), { code: 'not_found' });
    await assert.rejects(reject(t, a.id, {}, other.actor), { code: 'not_found' });
    await assert.rejects(assistant.revokeClient(t.db.pool, other.actor, { clientId: cl, reason: 'x' }, 'r'), { code: 'conflict' });
    assert.equal((await one(t, `select status from document_match_proposals where id = $1`, [a.id])).status, 'pending');
    assert.equal((await one(t, `select revoked_at from mcp_clients where id = $1`, [cl])).revoked_at, null);
    // An operator's approval is recorded under that operator.
    await approve(t, a.id, {}, op.actor);
    assert.equal((await one(t, `select decided_by from document_match_proposals where id = $1`, [a.id])).decided_by, op.actor.userId);
    // At most ten usable credentials.
    for (let i = 0; i < 9; i++) await t.client({ documentsRead: 'yes' }, { name: `c${i}` });
    await assert.rejects(t.client({ documentsRead: 'yes' }), { code: 'conflict' });
  } finally {
    await t.drop();
  }
});

test('the database refuses to rewrite, delete, double-decide or mis-attribute proposals', { skip: skipDb }, async () => {
  const t = await mcpFixture();
  try {
    const a = await proposed(t);
    const q = (sql, params = []) => t.db.pool.query(sql, params);
    await assert.rejects(q(`update document_match_proposals set target_version = 9 where id = $1`, [a.id]), /immutable except for its decision/);
    await assert.rejects(q(`update document_match_proposals set rationale = 'x' where id = $1`, [a.id]), /immutable/);
    await assert.rejects(q(`update document_match_proposals set client_id = gen_random_uuid() where id = $1`, [a.id]), /violates foreign key|immutable/);
    await assert.rejects(q(`delete from document_match_proposals where id = $1`, [a.id]), /cannot be deleted/);
    await assert.rejects(q(`truncate document_match_proposals`), /truncated/);
    await assert.rejects(q(`update document_match_proposals set status = 'pending' where id = $1`, [a.id]), /pending|check/);
    // Approval needs the matching attachment.
    await assert.rejects(q(`update document_match_proposals set status = 'approved', decided_by = $2, decided_at = now(), attachment_id = null where id = $1`, [a.id, t.actor.userId]), /must name the attachment|check|violates/);
    const stray = await t.up(PDF_FILE(), { title: 'Stray', targetType: 'bill', targetId: a.s.bill.id });
    const link = (await rows(t, `select id from document_attachments where document_id = $1`, [stray.id]))[0].id;
    await assert.rejects(q(`update document_match_proposals set status = 'approved', decided_by = $2, decided_at = now(), attachment_id = $3 where id = $1`, [a.id, t.actor.userId, link]),
      /must name the attachment/);
    // Decided by a user of another household.
    const other = await t.other();
    await assert.rejects(q(`update document_match_proposals set status = 'rejected', decided_by = $2, decided_at = now(), decision_note = 'x' where id = $1`, [a.id, other.actor.userId]), /own household/);
    // One proposal ever per document version and record.
    await assert.rejects(q(`insert into document_match_proposals (id, household_id, client_id, document_id, document_version_id, document_version_no, target_type, bill_id, target_version, rationale, confidence)
      select gen_random_uuid(), household_id, client_id, document_id, document_version_id, document_version_no, target_type, bill_id, target_version, 'dup', 'low' from document_match_proposals where id = $1`, [a.id]), /duplicate key/);
    // A proposal cannot name anything but a bill or visit, or both.
    await assert.rejects(q(`insert into document_match_proposals (id, household_id, client_id, document_id, document_version_id, document_version_no, target_type, bill_id, visit_id, target_version, rationale, confidence)
      select gen_random_uuid(), household_id, client_id, document_id, document_version_id, document_version_no, 'bill', bill_id, gen_random_uuid(), 1, 'x', 'low' from document_match_proposals where id = $1`, [a.id]), /check|violates/);
    await assert.rejects(q(`insert into document_match_proposals (id, household_id, client_id, document_id, document_version_id, document_version_no, target_type, bill_id, target_version, rationale, confidence)
      select gen_random_uuid(), household_id, client_id, document_id, document_version_id, document_version_no, 'hsa_receipt', bill_id, 1, 'x', 'low' from document_match_proposals where id = $1`, [a.id]), /check|violates/);
    // Still pending, and a normal decision still works.
    assert.equal((await one(t, `select status from document_match_proposals where id = $1`, [a.id])).status, 'pending');
    await approve(t, a.id);
  } finally {
    await t.drop();
  }
});

// ---------- HTTP routes ----------

const api = (t, action, body, { cookie = t.cookie, csrf = t.csrf, origin, type = 'json', html = false, headers = {} } = {}) =>
  handlers.handleAssistantAction(post(`/api/assistant/${action}`, body, { cookie, origin, type, html, headers: { ...(csrf ? { 'x-csrf-token': csrf } : {}), ...headers } }), t.ctx, action);

test('the assistant routes need a session, the canonical origin and a CSRF token, and unknown actions are 404', { skip: skipDb }, async () => {
  const t = await mcpFixture();
  try {
    const a = await proposed(t);
    const body = { idempotencyKey: randomUUID(), proposalId: a.id, documentVersion: 1, targetVersion: 1, documentRevision: 1 };
    assert.equal((await api(t, 'proposals/approve', body, { cookie: '' })).status, 401);
    assert.equal((await api(t, 'proposals/approve', body, { csrf: null })).status, 403);
    assert.equal((await api(t, 'proposals/approve', body, { csrf: 'wrong' })).status, 403);
    assert.equal((await api(t, 'proposals/approve', body, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await api(t, 'proposals/approve', { ...body, extra: 1 })).status, 400);
    assert.equal((await api(t, 'proposals/nope', body)).status, 404);
    assert.equal((await handlers.handleAssistantAction(new Request('http://app.internal:3000/api/assistant/proposals/approve'), t.ctx, 'proposals/approve')).status, 400);
    assert.equal((await attachments(t)).length, 0);
    const ok = await api(t, 'proposals/approve', body);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, id: a.id, replayed: false });
    // Browser form posts redirect back to the proposal, with an error code and never the typed values in the URL.
    const b = await proposed(t);
    await svc.updateBill(t.db.pool, t.actor, { id: b.s.bill.id, version: 1, providerId: b.s.p, providerReference: 'INV-1001', statementDate: '2026-01-02', notes: 'x' }, 'r');
    const stale = await api(t, 'proposals/approve', { idempotencyKey: randomUUID(), proposalId: b.id, documentVersion: '1', targetVersion: '1', documentRevision: '1' }, { type: 'form', html: true });
    assert.equal(stale.status, 303);
    assert.equal(new URL(stale.headers.get('location')).pathname, `/proposals/${b.id}`);
    assert.equal(new URL(stale.headers.get('location')).search, '?error=stale_version');
    const rej = await api(t, 'proposals/reject', { proposalId: b.id, reason: 'Edited since' }, { type: 'form', html: true });
    assert.equal(rej.status, 303);
    assert.equal(new URL(rej.headers.get('location')).search, '');
  } finally {
    await t.drop();
  }
});

test('creating a credential over HTTP shows the token once, and operators cannot', { skip: skipDb }, async () => {
  const t = await mcpFixture();
  try {
    const op = await t.secondOperator('operator');
    const denied = await api(t, 'clients/create', { name: 'x', expiryDays: 10, documentsRead: 'yes' }, { cookie: op.cookie, csrf: op.csrf });
    assert.equal(denied.status, 403);
    const none = await api(t, 'clients/create', { name: 'x', expiryDays: 10 });
    assert.equal(none.status, 400);
    const res = await api(t, 'clients/create', { name: 'Desk assistant', expiryDays: '30', documentsRead: 'yes', proposalsCreate: 'yes' }, { type: 'form', html: true });
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const html = await res.text();
    const token = /tmcp_[A-Za-z0-9_-]{43}/.exec(html)[0];
    assert.match(html, /shown once/);
    assert.ok(html.includes('documents:read, proposals:create'));
    const clients = await assistant.listClients(t.db.pool, t.actor);
    assert.equal(clients.length, 1);
    assert.ok(!JSON.stringify(clients).includes(token));
    const c = await t.connect(token);
    assert.deepEqual((await c.listTools()).tools.map((x) => x.name).sort(), ['list_my_proposals', 'list_unmatched_documents', 'propose_document_match']);
    const revoke = await api(t, 'clients/revoke', { clientId: clients[0].id, reason: 'done testing' });
    assert.equal(revoke.status, 200);
    assert.equal((await api(t, 'clients/revoke', { clientId: clients[0].id, reason: 'again' })).status, 409);
    const days = await api(t, 'clients/create', { name: 'x', expiryDays: 4000, documentsRead: 'yes' });
    assert.equal(days.status, 400);
    const page = await api(t, 'clients/create', { name: 'Name <script>alert(1)</script>', expiryDays: 1, documentsRead: 'yes' }, { html: true });
    assert.ok(!(await page.text()).includes('<script>alert'));
    void hashPassword; void PASSWORD;
  } finally {
    await t.drop();
  }
});
