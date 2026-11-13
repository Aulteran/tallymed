// Document management (M05): upload workflow and validation over HTTP, authorized download, typed attachments with link history,
// versions, removal, concurrency, database guards, storage failures and cleanup, and metadata/checksum restore. Synthetic data only.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import * as handlers from '../../apps/web/server/http.ts';
import * as docs from '../../apps/web/server/services/documents.ts';
import * as hsa from '../../apps/web/server/services/hsa.ts';
import * as hsaRepo from '../../apps/web/server/repositories/hsa.ts';
import { resolveAttachmentTarget } from '../../apps/web/server/contracts.ts';
import { FileObjectStore } from '../../apps/web/server/storage.ts';
import { retryStats } from '../../apps/web/server/services/support.ts';
import * as svc from '../../apps/web/server/services/expenses.ts';
import { skipDb } from './helpers.mjs';
import { PDF_FILE, PNG_FILE, docFixture, file, jpeg, pdf, png, upload } from './document-helpers.mjs';

const code = (c) => ({ code: c });
const errCode = async (res) => (await res.clone().json()).error?.code;
const storedKeys = async (store) => (await store.list()).objects.map((o) => o.key);
const rows = async (t, sql, params = []) => (await t.db.pool.query(sql, params)).rows;
const count = async (t, table) => (await rows(t, `select count(*)::int n from ${table}`))[0].n;

/** A confirmed bill, a visit, an adjustment and an HSA decision plus receipt, all synthetic. */
async function records(t) {
  const m = await t.member();
  const p = await t.provider();
  const bill = await t.bill({ memberId: m, providerId: p, originalAmount: '120.00' });
  const visit = await svc.createVisit(t.db.pool, t.actor, { memberId: m, providerId: p, serviceDate: '2026-02-01' }, 'r');
  const adj = await t.adjust(bill.id, '-10.00');
  const pm = await t.pay1({ amount: '75.00', billId: bill.id, paidOn: '2026-04-01' });
  const [a] = (await t.payment(pm.id)).allocations;
  const cur = await hsaRepo.getAllocation(t.db.pool, t.actor.householdId, a.allocationId);
  const decision = await hsa.recordDecision(t.db.pool, t.actor, {
    idempotencyKey: t.key(), allocationId: a.allocationId, version: String(cur.decisionCount), status: 'eligible', eligibleAmount: '60.00',
    rationale: 'Qualified expense', evidenceType: 'receipt', evidenceNote: 'Pharmacy receipt on file', decidedOn: '2026-04-05',
  }, 'r');
  const claim = await hsa.submitClaim(t.db.pool, t.actor, { idempotencyKey: t.key(), submittedOn: '2026-04-10', administrator: 'Example HSA Bank', lines: [{ allocationId: a.allocationId, amount: '50.00' }] }, 'r');
  const line = (await hsaRepo.linesOfClaim(t.db.pool, t.actor.householdId, claim.id))[0];
  const receipt = await hsa.recordReceipt(t.db.pool, t.actor, { idempotencyKey: t.key(), receivedOn: '2026-04-20', source: 'administrator_transfer', lines: [{ lineId: line.lineId, amount: '20.00' }] }, 'r');
  return { m, p, bill, visit, adj, decision: decision.id, receipt: receipt.id, allocationId: a.allocationId };
}

test('uploading over HTTP stores a private object and records the metadata and an audit event', { skip: skipDb }, async () => {
  const t = await docFixture();
  try {
    const f = PNG_FILE();
    const res = await t.http('upload', { idempotencyKey: randomUUID(), title: 'Lab results', kind: 'receipt', note: 'synthetic' }, { ...f, name: '../../Private Name.png' });
    assert.equal(res.status, 201);
    const { id } = await res.json();
    const [v] = await rows(t, `select * from document_versions where document_id = $1`, [id]);
    assert.equal(v.media_type, 'image/png');
    assert.equal(Number(v.size_bytes), f.bytes.length);
    assert.equal(v.sha256.toString('hex'), (await import('node:crypto')).createHash('sha256').update(f.bytes).digest('hex'));
    assert.equal(v.original_name, 'Private Name.png');
    assert.match(v.storage_key, /^[0-9a-f]{32}$/);
    assert.ok(!v.storage_key.includes('Private'));
    assert.deepEqual(await storedKeys(t.store), [v.storage_key]);
    assert.equal((await t.store.list()).quarantine.length, 0, 'nothing is left in quarantine');
    // The audit event carries checksums and counts, not the title, note or file name.
    const [ev] = await t.audit('document.uploaded');
    assert.equal(ev.detail.sha256, v.sha256.toString('hex'));
    assert.equal(ev.detail.unmatchedAfter, true);
    assert.ok(!JSON.stringify(ev.detail).match(/Private|Lab results|synthetic/));
    // It lands in the unmatched queue, and the list is household scoped.
    assert.equal((await docs.unmatchedSummary(t.db.pool, t.actor)).count, 1);
    assert.equal((await docs.listDocuments(t.db.pool, t.actor, { unmatched: 'on' })).items.length, 1);
    const o = await t.other();
    assert.equal((await docs.listDocuments(t.db.pool, o.actor, {})).items.length, 0);
    assert.equal((await docs.unmatchedSummary(t.db.pool, o.actor)).count, 0);
  } finally {
    await t.drop();
  }
});

test('invalid uploads are refused with no row and no stored file', { skip: skipDb }, async () => {
  const t = await docFixture({ limits: { documentMaxBytes: 4096 } });
  try {
    const key = () => ({ idempotencyKey: randomUUID() });
    const cases = [
      ['content and type mismatch', file(png(), 'a.pdf', 'application/pdf'), 415],
      ['declared type mismatch', file(png(), 'a.png', 'application/pdf'), 415],
      ['HTML renamed to png', file(Buffer.from('<html><script>alert(1)</script></html>'), 'a.png', 'image/png'), 415],
      ['SVG', file(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'a.svg', 'image/svg+xml'), 415],
      ['PDF with a script', file(pdf({ body: '/OpenAction << /S /JavaScript /JS (x) >>' }), 'a.pdf', 'application/pdf'), 415],
      ['empty file', file(Buffer.alloc(0), 'a.png', 'image/png'), 400],
      ['over the size limit', file(Buffer.concat([png(), Buffer.alloc(5000)]), 'a.png', 'image/png'), 413],
    ];
    for (const [name, f, status] of cases) {
      const res = await t.http('upload', key(), f);
      assert.equal(res.status, status, name);
    }
    // Missing file, two files, an unknown field and a non-multipart body.
    assert.equal((await t.http('upload', key(), null)).status, 400);
    const fd = new FormData();
    fd.set('idempotencyKey', randomUUID());
    fd.append('file', new Blob([png()], { type: 'image/png' }), 'a.png');
    fd.append('file', new Blob([png()], { type: 'image/png' }), 'b.png');
    const two = new Request('http://app.internal:3000/api/documents/upload', { method: 'POST', headers: { origin: 'https://tallymed.test', cookie: t.cookie, 'x-csrf-token': t.csrf }, body: fd });
    assert.equal((await handlers.handleDocumentAction(two, t.ctx, 'upload')).status, 400);
    assert.equal((await t.http('upload', { ...key(), admin: 'true' }, PNG_FILE())).status, 400);
    assert.equal((await t.http('upload', { ...key(), file2: 'x' }, PNG_FILE())).status, 400);
    const json = await handlers.handleDocumentAction(new Request('http://app.internal:3000/api/documents/upload', {
      method: 'POST', headers: { origin: 'https://tallymed.test', cookie: t.cookie, 'x-csrf-token': t.csrf, 'content-type': 'application/json' }, body: '{}',
    }), t.ctx, 'upload');
    assert.equal(json.status, 415);
    assert.equal(await count(t, 'documents'), 0);
    assert.equal(await count(t, 'document_versions'), 0);
    assert.deepEqual(await t.store.list(), { objects: [], quarantine: [] });
    // A browser form post is redirected back with an error code, including for size and type errors.
    const html = await t.http('upload', key(), file(png(), 'a.pdf', 'application/pdf'), { html: true });
    assert.equal(html.status, 303);
    assert.match(html.headers.get('location'), /\/documents\?error=unsupported_media_type$/);
    // Hostile names are accepted only as sanitized display names; the stored key is unrelated to them.
    for (const name of ['../../../etc/passwd.png', 'a\\b\\c.png', 'x\u0000.png', 'con<script>.png', '..png']) {
      const res = await t.http('upload', key(), { ...PNG_FILE(), name });
      assert.equal(res.status, 201, name);
    }
    for (const r of await rows(t, 'select original_name, storage_key from document_versions')) {
      assert.match(r.original_name, /^[\p{L}\p{N} ._()-]+\.png$/u);
      assert.match(r.storage_key, /^[0-9a-f]{32}$/);
    }
  } finally {
    await t.drop();
  }
});

test('upload and delete requests need a session, a CSRF token and the canonical origin, and the body is not read first', { skip: skipDb }, async () => {
  const t = await docFixture();
  try {
    const fields = { idempotencyKey: randomUUID() };
    const f = PNG_FILE();
    const anon = await handlers.handleDocumentAction(upload('upload', fields, f, { csrf: t.csrf }), t.ctx, 'upload');
    assert.equal(anon.status, 401);
    // Authentication happens before the multipart body is buffered: a body over the limit from an anonymous caller is a 401, not a 413.
    const big = await handlers.handleDocumentAction(upload('upload', fields, { bytes: Buffer.alloc(11 * 1024 * 1024, 1), name: 'a.png', type: 'image/png' }, {}), t.ctx, 'upload');
    assert.equal(big.status, 401);
    assert.equal((await t.http('upload', fields, f, { csrf: '' })).status, 403, 'missing token');
    assert.equal((await handlers.handleDocumentAction(upload('upload', fields, f, { cookie: t.cookie, csrf: 'forged' }), t.ctx, 'upload')).status, 403);
    assert.equal((await t.http('upload', fields, f, { origin: 'https://evil.test' })).status, 403);
    assert.equal((await t.http('upload', fields, f, { origin: null })).status, 403);
    assert.equal((await t.http('upload', fields, f, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    const get = await handlers.handleDocumentAction(new Request('http://app.internal:3000/api/documents/upload', { method: 'GET', headers: { cookie: t.cookie } }), t.ctx, 'upload');
    assert.equal(get.status, 400);
    const { id } = await t.up();
    const d = await docs.getDocumentDetail(t.db.pool, t.actor, id);
    const remove = { id, version: String(d.document.version), reason: 'Scanned twice' };
    const { post } = await import('./helpers.mjs');
    for (const [label, opts, status] of [
      ['anonymous', { headers: {} }, 401], ['no csrf', { cookie: t.cookie }, 403], ['cross origin', { cookie: t.cookie, origin: 'https://evil.test', headers: { 'x-csrf-token': t.csrf } }, 403],
    ]) {
      assert.equal((await handlers.handleDocumentAction(post('/api/documents/remove', remove, opts), t.ctx, 'remove')).status, status, label);
    }
    assert.equal((await t.post('nope', {})).status, 404);
    assert.equal(await count(t, 'documents'), 1);
    assert.equal((await rows(t, 'select removed_at from documents'))[0].removed_at, null);
    assert.equal(await count(t, 'document_versions'), 1);
  } finally {
    await t.drop();
  }
});

test('download is authenticated and household scoped, with safe headers and verified bytes', { skip: skipDb }, async () => {
  const t = await docFixture();
  try {
    const png1 = PNG_FILE();
    const { id: imageId } = await t.up(png1, {});
    const { id: pdfId } = await t.up(PDF_FILE(), {});
    const res = await t.get(imageId);
    assert.equal(res.status, 200);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), png1.bytes);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-disposition'), /^attachment; filename="scan\.png"/);
    assert.match(res.headers.get('cache-control'), /no-store/);
    assert.match(res.headers.get('content-security-policy'), /sandbox/);
    assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.ok(!res.url.includes('sha') && !res.headers.get('location'));
    // Inline is allowed for images only; a PDF is always an attachment.
    assert.match((await t.get(imageId, '?disposition=inline')).headers.get('content-disposition'), /^inline;/);
    assert.match((await t.get(pdfId, '?disposition=inline')).headers.get('content-disposition'), /^attachment;/);
    assert.equal((await t.get(pdfId)).headers.get('content-type'), 'application/pdf');
    // Unknown, malformed, other-household, anonymous and bad-version requests.
    assert.equal((await t.get(randomUUID())).status, 404);
    assert.equal((await t.get('not-a-uuid')).status, 400);
    assert.equal((await t.get(imageId, '?version=9')).status, 404);
    assert.equal((await t.get(imageId, '?version=1;x')).status, 400);
    assert.equal((await t.get(imageId, '', { cookie: 'tallymed_session=bogus' })).status, 401);
    const o = await t.other();
    assert.equal((await t.get(imageId, '', { cookie: o.cookie })).status, 404);
    assert.equal((await t.get(randomUUID(), '', { cookie: o.cookie })).status, 404);
    const post = await handlers.handleDocumentDownload(new Request(`http://app.internal:3000/api/documents/download/${imageId}`, { method: 'POST', headers: { cookie: t.cookie } }), t.ctx, imageId);
    assert.equal(post.status, 400);
    // Downloads are audited with the document and version only.
    const ev = await t.audit('document.downloaded');
    assert.ok(ev.length >= 2);
    assert.deepEqual(Object.keys(ev[0].detail).sort(), ['documentId', 'versionNo']);
    // A foreign household cannot detach, attach, update or remove it either.
    const bill = await t.bill({ memberId: await t.member(), providerId: await t.provider() });
    await assert.rejects(docs.attachDocument(t.db.pool, o.actor, { idempotencyKey: t.key(), documentId: imageId, targetType: 'bill', targetId: bill.id }, 'r'), code('not_found'));
    await assert.rejects(docs.updateDocument(t.db.pool, o.actor, { id: imageId, version: '1', title: 'x', kind: 'other' }, 'r'), code('not_found'));
    await assert.rejects(docs.removeDocument(t.db.pool, o.actor, { id: imageId, version: '1', reason: 'x' }, 'r'), code('not_found'));
    await assert.rejects(docs.getDocumentDetail(t.db.pool, o.actor, imageId), code('not_found'));
    await assert.rejects(docs.uploadDocument(t.deps, o.actor, { idempotencyKey: t.key(), file: PNG_FILE(), targetType: 'bill', targetId: bill.id }, 'r'), code('not_found'));
  } finally {
    await t.drop();
  }
});

test('downloads refuse bytes that fail the stored checksum or are missing, and removed documents', { skip: skipDb }, async () => {
  const t = await docFixture();
  try {
    const { id } = await t.up();
    const [v] = await rows(t, 'select storage_key from document_versions');
    const objectFile = path.join(t.ts.dir, 'objects', v.storage_key.slice(0, 2), v.storage_key);
    const original = readFileSync(objectFile);
    const flipped = Buffer.from(original);
    flipped[flipped.length - 20] ^= 1;
    writeFileSync(objectFile, flipped);
    const bad = await t.get(id);
    assert.equal(bad.status, 503);
    assert.equal(await errCode(bad), 'storage_unavailable');
    writeFileSync(objectFile, original.subarray(0, original.length - 1));
    assert.equal((await t.get(id)).status, 503, 'truncated');
    writeFileSync(objectFile, original);
    assert.equal((await t.get(id)).status, 200);
    const d = await docs.getDocumentDetail(t.db.pool, t.actor, id);
    await docs.removeDocument(t.db.pool, t.actor, { id, version: String(d.document.version), reason: 'Duplicate scan' }, 'r');
    assert.equal((await t.get(id)).status, 404);
    assert.equal((await docs.listDocuments(t.db.pool, t.actor, {})).items.length, 0);
    assert.equal((await docs.unmatchedSummary(t.db.pool, t.actor)).count, 0);
  } finally {
    await t.drop();
  }
});

test('failed storage writes leave no rows and no files', { skip: skipDb }, async () => {
  const faults = {};
  const wrap = (real) => new Proxy(real, {
    get(target, prop) {
      if (faults[prop]) return async (...args) => faults[prop](target, ...args);
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const t = await docFixture({ store: wrap });
  try {
    const attempt = () => t.up(PNG_FILE());
    faults.putQuarantine = async () => { throw new Error('disk full'); };
    await assert.rejects(attempt(), code('storage_unavailable'));
    delete faults.putQuarantine;
    // Partial write: the stored bytes differ from what was received.
    faults.readQuarantine = async (store, key) => (await store.readQuarantine(key)).subarray(1);
    await assert.rejects(attempt(), code('storage_unavailable'));
    delete faults.readQuarantine;
    faults.promote = async () => { throw new Error('rename failed'); };
    await assert.rejects(attempt(), code('storage_unavailable'));
    delete faults.promote;
    assert.equal(await count(t, 'documents'), 0);
    assert.deepEqual(await t.ts.store.list(), { objects: [], quarantine: [] });
    // A database failure after the object was promoted removes the object (duplicate content here).
    const first = PNG_FILE();
    await t.up(first);
    await assert.rejects(t.up(first), code('duplicate_document'));
    assert.equal((await t.ts.store.list()).objects.length, 1);
    // Removing the object fails during cleanup: the original error still wins and the file is left for the cleanup command.
    faults.remove = async () => { throw new Error('cannot remove'); };
    await assert.rejects(t.up(first), code('duplicate_document'));
    delete faults.remove;
    assert.equal((await t.ts.store.list()).objects.length, 2);
    const report = await docs.cleanupStorage(t.db.pool, t.ts.store, { graceMs: 0, retentionDays: 30 });
    assert.equal(report.unreferencedRemoved, 1);
    assert.equal((await t.ts.store.list()).objects.length, 1);
    // Storage that is not configured is a clear, retryable error rather than a crash.
    await assert.rejects(docs.uploadDocument({ ...t.deps, store: null }, t.actor, { idempotencyKey: t.key(), file: PNG_FILE() }, 'r'), code('storage_unavailable'));
    const off = await handlers.handleDocumentAction(upload('upload', { idempotencyKey: randomUUID() }, PNG_FILE(), { cookie: t.cookie, csrf: t.csrf }), { ...t.ctx, store: null }, 'upload');
    assert.equal(off.status, 503);
  } finally {
    await t.drop();
  }
});

test('an idempotency key is one document: replays return the first result and clean up the duplicate bytes', { skip: skipDb }, async () => {
  const t = await docFixture();
  try {
    const key = randomUUID();
    const f = PNG_FILE();
    const a = await t.up(f, { idempotencyKey: key });
    const b = await t.up(f, { idempotencyKey: key });
    assert.equal(b.id, a.id);
    assert.equal(b.replayed, true);
    assert.equal(await count(t, 'documents'), 1);
    assert.equal((await t.store.list()).objects.length, 1);
    await assert.rejects(t.up(PNG_FILE(), { idempotencyKey: key }), code('conflict'));
    assert.equal((await t.store.list()).objects.length, 1);
    // Eight concurrent submissions of one logical upload produce one document and one object.
    const k2 = randomUUID();
    const g = PDF_FILE();
    const results = await Promise.all(Array.from({ length: 8 }, () => t.up(g, { idempotencyKey: k2 })));
    assert.equal(new Set(results.map((r) => r.id)).size, 1);
    assert.equal(results.filter((r) => !r.replayed).length, 1);
    assert.equal(await count(t, 'documents'), 2);
    assert.equal((await t.store.list()).objects.length, 2);
  } finally {
    await t.drop();
  }
});

test('identical content is flagged until the person confirms, and the household quota holds under concurrent uploads', { skip: skipDb }, async () => {
  const f = PNG_FILE();
  const t = await docFixture({ limits: { documentQuotaBytes: PNG_FILE().bytes.length * 5 + 10 } });
  try {
    await t.up(f);
    await assert.rejects(t.up(f), code('duplicate_document'));
    const again = await t.up(f, { confirmDuplicate: 'yes' });
    assert.ok(again.id);
    // Quota is 5 files; two are stored. Twelve distinct concurrent uploads may add at most three more.
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => t.up(PNG_FILE())));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    assert.equal(ok, 3);
    for (const r of results.filter((r) => r.status === 'rejected')) assert.equal(r.reason.code, 'payload_too_large');
    assert.equal(await count(t, 'document_versions'), 5);
    assert.equal((await t.store.list()).objects.length, 5, 'rejected uploads leave no objects');
  } finally {
    await t.drop();
  }
});

test('documents attach to bills, visits, adjustments, HSA decisions and receipts with pinned versions and link history', { skip: skipDb }, async () => {
  const t = await docFixture();
  try {
    const r = await records(t);
    const { id } = await t.up(PDF_FILE());
    const targets = [['bill', r.bill.id], ['visit', r.visit.id], ['bill_adjustment', r.adj.id], ['hsa_receipt', r.receipt], ['hsa_eligibility_decision', r.decision]];
    for (const [type, targetId] of targets) {
      await docs.attachDocument(t.db.pool, t.actor, { idempotencyKey: t.key(), documentId: id, targetType: type, targetId, note: 'EOB' }, 'r');
      const list = await docs.listAttachments(t.db.pool, t.actor, type, targetId);
      assert.equal(list.length, 1, type);
      assert.equal(list[0].documentId, id);
      assert.equal(list[0].versionNo, 1);
      assert.equal((await resolveAttachmentTarget(t.db.pool, t.actor, type, targetId)).type, type);
    }
    assert.equal((await docs.unmatchedSummary(t.db.pool, t.actor)).count, 0, 'matched documents leave the queue');
    await assert.rejects(docs.attachDocument(t.db.pool, t.actor, { idempotencyKey: t.key(), documentId: id, targetType: 'bill', targetId: r.bill.id }, 'r'), code('conflict'));
    // The attach event records before and after counts and no free text.
    const events = await t.audit('document.attached');
    assert.equal(events.length, 5);
    assert.deepEqual([events[0].detail.activeAttachmentsBefore, events[0].detail.activeAttachmentsAfter, events[0].detail.unmatchedBefore, events[0].detail.unmatchedAfter], [0, 1, true, false]);
    assert.equal(events[4].detail.activeAttachmentsAfter, 5);
    assert.ok(!JSON.stringify(events).includes('EOB'));
    // A new version does not move existing evidence: links stay pinned to the version they were made with.
    const detail = await docs.getDocumentDetail(t.db.pool, t.actor, id);
    await docs.addDocumentVersion(t.deps, t.actor, { idempotencyKey: t.key(), documentId: id, version: '1', file: PDF_FILE() }, 'r');
    const after = await docs.listAttachments(t.db.pool, t.actor, 'bill', r.bill.id);
    assert.equal(after[0].versionNo, 1);
    assert.equal(after[0].currentVersionNo, 2);
    assert.equal((await t.get(id, '?version=1')).status, 200);
    assert.equal((await t.get(id)).status, 200);
    const versions = (await docs.getDocumentDetail(t.db.pool, t.actor, id)).versions;
    assert.deepEqual(versions.map((v) => v.versionNo), [2, 1]);
    assert.notEqual(versions[0].sha256, versions[1].sha256);
    // A stale version number is refused, an identical file is flagged, and the version event shows before and after checksums.
    await assert.rejects(docs.addDocumentVersion(t.deps, t.actor, { idempotencyKey: t.key(), documentId: id, version: '1', file: PDF_FILE() }, 'r'), code('stale_version'));
    const same = PDF_FILE();
    await docs.addDocumentVersion(t.deps, t.actor, { idempotencyKey: t.key(), documentId: id, version: '2', file: same }, 'r');
    await assert.rejects(docs.addDocumentVersion(t.deps, t.actor, { idempotencyKey: t.key(), documentId: id, version: '3', file: same }, 'r'), code('duplicate_document'));
    const [, ev2] = await t.audit('document.version_added');
    assert.equal(ev2.detail.versionBeforeNo, 2);
    assert.notEqual(ev2.detail.sha256Before, ev2.detail.sha256After);
    // Re-attaching the new version means detaching and attaching again; the history keeps both links.
    const link = (await docs.listAttachments(t.db.pool, t.actor, 'bill', r.bill.id))[0];
    await docs.detachDocument(t.db.pool, t.actor, { attachmentId: link.id, reason: 'Superseded by a newer scan' }, 'r');
    await docs.attachDocument(t.db.pool, t.actor, { idempotencyKey: t.key(), documentId: id, targetType: 'bill', targetId: r.bill.id }, 'r');
    const history = await docs.listAttachments(t.db.pool, t.actor, 'bill', r.bill.id);
    assert.deepEqual(history.map((h) => [h.versionNo, h.detachedAt === null]), [[3, true], [1, false]]);
    assert.equal(history[1].detachReason, 'Superseded by a newer scan');
    const [det] = await t.audit('document.detached');
    assert.deepEqual([det.detail.targetAttachmentsBefore, det.detail.targetAttachmentsAfter, det.detail.activeAttachmentsBefore, det.detail.activeAttachmentsAfter], [1, 0, 5, 4]);
    assert.ok(detail.document.id === id);
    // Unknown and foreign targets, bad types and a removed document are refused.
    for (const [type, targetId] of [['bill', randomUUID()], ['payment', r.bill.id], ['bill_adjustment', r.bill.id], ['hsa_receipt', r.decision]]) {
      await assert.rejects(docs.attachDocument(t.db.pool, t.actor, { idempotencyKey: t.key(), documentId: id, targetType: type, targetId }, 'r'), (e) => ['not_found', 'invalid_input'].includes(e.code), type);
    }
  } finally {
    await t.drop();
  }
});

test('a document with links cannot be removed, and a removed document is a tombstone', { skip: skipDb }, async () => {
  const t = await docFixture();
  try {
    const r = await records(t);
    const { id } = await t.up();
    await docs.attachDocument(t.db.pool, t.actor, { idempotencyKey: t.key(), documentId: id, targetType: 'bill', targetId: r.bill.id }, 'r');
    const v = async () => String((await docs.getDocumentDetail(t.db.pool, t.actor, id)).document.version);
    await assert.rejects(docs.removeDocument(t.db.pool, t.actor, { id, version: await v(), reason: 'Mistake' }, 'r'), code('conflict'));
    const link = (await docs.listAttachments(t.db.pool, t.actor, 'bill', r.bill.id))[0];
    await docs.detachDocument(t.db.pool, t.actor, { attachmentId: link.id, reason: 'Wrong bill' }, 'r');
    await assert.rejects(docs.detachDocument(t.db.pool, t.actor, { attachmentId: link.id, reason: 'again' }, 'r'), code('conflict'));
    await assert.rejects(docs.removeDocument(t.db.pool, t.actor, { id, version: '99', reason: 'Mistake' }, 'r'), code('stale_version'));
    await docs.removeDocument(t.db.pool, t.actor, { id, version: await v(), reason: 'Mistake' }, 'r');
    const [ev] = await t.audit('document.removed');
    assert.deepEqual([ev.detail.removedBefore, ev.detail.removedAfter, ev.detail.activeAttachmentsBefore], [false, true, 0]);
    await assert.rejects(docs.attachDocument(t.db.pool, t.actor, { idempotencyKey: t.key(), documentId: id, targetType: 'bill', targetId: r.bill.id }, 'r'), code('not_found'));
    await assert.rejects(docs.removeDocument(t.db.pool, t.actor, { id, version: '3', reason: 'again' }, 'r'), code('not_found'));
    await assert.rejects(docs.updateDocument(t.db.pool, t.actor, { id, version: '3', title: 'x', kind: 'other' }, 'r'), code('not_found'));
    // Metadata and the link history remain after removal.
    assert.equal(await count(t, 'documents'), 1);
    assert.equal(await count(t, 'document_attachments'), 1);
    assert.equal((await docs.getDocumentDetail(t.db.pool, t.actor, id)).document.removedAt instanceof Date, true);
  } finally {
    await t.drop();
  }
});

test('concurrent attach, detach and remove keep links and files consistent', { skip: skipDb }, async () => {
  const t = await docFixture();
  try {
    const r = await records(t);
    retryStats.lockConflicts = 0;
    // Double attach: exactly one active link.
    const { id } = await t.up();
    const attach = () => docs.attachDocument(t.db.pool, t.actor, { idempotencyKey: t.key(), documentId: id, targetType: 'bill', targetId: r.bill.id }, 'r');
    const settled = await Promise.allSettled(Array.from({ length: 6 }, attach));
    assert.equal(settled.filter((s) => s.status === 'fulfilled').length, 1);
    for (const s of settled.filter((x) => x.status === 'rejected')) assert.equal(s.reason.code, 'conflict');
    assert.equal((await rows(t, `select count(*)::int n from document_attachments where detached_at is null`))[0].n, 1);
    // Double detach: one winner.
    const link = (await docs.listAttachments(t.db.pool, t.actor, 'bill', r.bill.id))[0];
    const d = await Promise.allSettled(Array.from({ length: 6 }, () => docs.detachDocument(t.db.pool, t.actor, { attachmentId: link.id, reason: 'duplicate' }, 'r')));
    assert.equal(d.filter((s) => s.status === 'fulfilled').length, 1);
    assert.equal((await t.audit('document.detached')).length, 1);
    // Attach racing removal: whichever wins, a removed document never keeps an active link.
    for (let i = 0; i < 12; i++) {
      const doc = await t.up();
      const ver = String((await docs.getDocumentDetail(t.db.pool, t.actor, doc.id)).document.version);
      const outcome = await Promise.allSettled([
        docs.attachDocument(t.db.pool, t.actor, { idempotencyKey: t.key(), documentId: doc.id, targetType: 'bill', targetId: r.bill.id }, 'r'),
        docs.removeDocument(t.db.pool, t.actor, { id: doc.id, version: ver, reason: 'race' }, 'r'),
      ]);
      for (const o of outcome.filter((x) => x.status === 'rejected')) assert.ok(['conflict', 'not_found', 'stale_version'].includes(o.reason.code), o.reason.code);
      const bad = await rows(t, `select d.id from documents d where d.removed_at is not null and exists (select 1 from document_attachments a where a.document_id = d.id and a.detached_at is null)`);
      assert.equal(bad.length, 0, 'a removed document has no active link');
    }
    // Concurrent uploads and removals never lose an object that a row needs, or keep a row without its object.
    const report = await docs.verifyStorage(t.db.pool, t.store);
    assert.deepEqual([report.missing.length, report.corrupt.length, report.unreferenced.length], [0, 0, 0]);
    assert.equal(retryStats.lockConflicts, 0, 'no lock-cycle retries');
  } finally {
    await t.drop();
  }
});

test('attaching to a bill and applying payments together follow the lock order without deadlocks', { skip: skipDb }, async () => {
  const t = await docFixture();
  try {
    const m = await t.member();
    const p = await t.provider();
    const bills = await Promise.all([t.bill({ memberId: m, providerId: p }), t.bill({ memberId: m, providerId: p })]);
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push((await t.up()).id);
    retryStats.lockConflicts = 0;
    const work = [];
    ids.forEach((id, i) => {
      const b = bills[i % 2];
      work.push(docs.attachDocument(t.db.pool, t.actor, { idempotencyKey: t.key(), documentId: id, targetType: 'bill', targetId: b.id }, 'r'));
      work.push(t.pay1({ amount: '5.00', billId: bills[(i + 1) % 2].id, paidOn: '2026-04-01' }));
      work.push(svc.addAdjustment(t.db.pool, t.actor, { idempotencyKey: t.key(), billId: b.id, amount: '-0.01', category: 'correction', effectiveDate: '2026-03-10', reason: 'rounding', source: 'manual' }, 'r'));
    });
    const settled = await Promise.allSettled(work);
    assert.deepEqual(settled.filter((s) => s.status === 'rejected').map((s) => s.reason.code ?? s.reason.message), []);
    assert.equal(retryStats.lockConflicts, 0);
  } finally {
    await t.drop();
  }
});

test('the database refuses changes that break document, version and link invariants', { skip: skipDb }, async () => {
  const t = await docFixture();
  try {
    const r = await records(t);
    const { id } = await t.up();
    await docs.attachDocument(t.db.pool, t.actor, { idempotencyKey: t.key(), documentId: id, targetType: 'bill', targetId: r.bill.id }, 'r');
    const sql = (q, p) => t.db.pool.query(q, p);
    // Versions are immutable (apart from purging), documents and link history cannot be deleted or truncated.
    await assert.rejects(sql(`update document_versions set sha256 = decode(repeat('00', 32), 'hex')`), /immutable/);
    await assert.rejects(sql(`update document_versions set storage_key = repeat('a', 32)`), /immutable/);
    await assert.rejects(sql(`update document_versions set size_bytes = 5`), /immutable/);
    await assert.rejects(sql(`delete from document_versions`), /immutable/);
    await assert.rejects(sql(`delete from documents`), /cannot be deleted/);
    await assert.rejects(sql(`delete from document_attachments`), /append-only/);
    await assert.rejects(sql(`truncate document_attachments`), /cannot be truncated/);
    await assert.rejects(sql(`truncate documents cascade`), /cannot be truncated/);
    await assert.rejects(sql(`update document_attachments set note = 'rewrite'`), /can only be detached/);
    await assert.rejects(sql(`update document_attachments set document_version_id = gen_random_uuid()`), /can only be detached|foreign key/);
    // A removed document cannot hold an active link, even through raw SQL at commit.
    await assert.rejects(sql(`update documents set removed_at = now(), removed_by = created_by, removal_reason = 'raw'`), /removed document cannot have active attachments/);
    // Typed columns must match the type; a foreign household's target is refused by the composite key.
    const base = `insert into document_attachments (id, household_id, document_id, document_version_id, target_type, %COLS%, created_by)
      select gen_random_uuid(), d.household_id, d.id, v.id, %VALS%, d.created_by from documents d join document_versions v on v.document_id = d.id`;
    await assert.rejects(sql(base.replace('%COLS%', 'visit_id').replace('%VALS%', `'bill', '${r.visit.id}'`)), /check/);
    await assert.rejects(sql(base.replace('%COLS%', 'bill_id, visit_id').replace('%VALS%', `'bill', '${r.bill.id}', '${r.visit.id}'`)), /check/);
    await assert.rejects(sql(base.replace('%COLS%', 'bill_id').replace('%VALS%', `'payment', '${r.bill.id}'`)), /check/);
    const h2 = (await rows(t, `insert into households (name) values ('Other') returning id`))[0].id;
    const u2 = (await rows(t, `insert into users (household_id, email, display_name, role, password_hash) values ($1, 'x@example.test', 'X', 'admin', 'x') returning id`, [h2]))[0].id;
    await sql(`insert into documents (id, household_id, title, kind, created_by) values ('00000000-0000-4000-8000-000000000001', $1, 'T', 'other', $2)`, [h2, u2]);
    await sql(`insert into document_versions (id, household_id, document_id, version_no, storage_key, sha256, size_bytes, media_type, original_name, created_by)
      values ('00000000-0000-4000-8000-000000000002', $1, '00000000-0000-4000-8000-000000000001', 1, repeat('b', 32), decode(repeat('11', 32), 'hex'), 3, 'image/png', 'a.png', $2)`, [h2, u2]);
    await assert.rejects(sql(`insert into document_attachments (id, household_id, document_id, document_version_id, target_type, bill_id, created_by)
      values (gen_random_uuid(), $1, '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'bill', $2, $3)`, [h2, r.bill.id, u2]), /foreign key/);
    // Storage keys and media types are constrained, and a link needs an available version of its own document.
    await assert.rejects(sql(`insert into document_versions (id, household_id, document_id, version_no, storage_key, sha256, size_bytes, media_type, original_name, created_by)
      values (gen_random_uuid(), $1, '00000000-0000-4000-8000-000000000001', 2, '../../etc/passwd', decode(repeat('11', 32), 'hex'), 3, 'image/png', 'a.png', $2)`, [h2, u2]), /check/);
    await assert.rejects(sql(`insert into document_versions (id, household_id, document_id, version_no, storage_key, sha256, size_bytes, media_type, original_name, created_by)
      values (gen_random_uuid(), $1, '00000000-0000-4000-8000-000000000001', 2, repeat('c', 32), decode(repeat('11', 32), 'hex'), 3, 'text/html', 'a.html', $2)`, [h2, u2]), /check/);
    await assert.rejects(sql(`insert into document_versions (id, household_id, document_id, version_no, storage_key, sha256, size_bytes, media_type, original_name, created_by)
      values (gen_random_uuid(), $1, '00000000-0000-4000-8000-000000000001', 1, repeat('d', 32), decode(repeat('11', 32), 'hex'), 3, 'image/png', 'a.png', $2)`, [h2, u2]), /document_versions_document_id_version_no_key/);
    // Purging is the one allowed version change, and it cannot be undone.
    await sql(`update document_versions set state = 'purged', purged_at = now() where id = '00000000-0000-4000-8000-000000000002'`);
    await assert.rejects(sql(`update document_versions set state = 'available', purged_at = null where id = '00000000-0000-4000-8000-000000000002'`), /immutable/);
    // A new link cannot point at a purged version (this household has a visit to link to).
    const m2 = (await rows(t, `insert into family_members (household_id, name, created_by) values ($1, 'M', $2) returning id`, [h2, u2]))[0].id;
    const p2 = (await rows(t, `insert into providers (household_id, name, created_by) values ($1, 'P', $2) returning id`, [h2, u2]))[0].id;
    const v2 = (await rows(t, `insert into visits (household_id, member_id, provider_id, service_date, member_name_snapshot, provider_name_snapshot, created_by)
      values ($1, $2, $3, '2026-01-01', 'M', 'P', $4) returning id`, [h2, m2, p2, u2]))[0].id;
    await assert.rejects(sql(`insert into document_attachments (id, household_id, document_id, document_version_id, target_type, visit_id, created_by)
      values (gen_random_uuid(), $1, '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'visit', $2, $3)`, [h2, v2, u2]), /available document version/);
  } finally {
    await t.drop();
  }
});

test('verify and cleanup: restored metadata matches stored checksums; orphans, quarantine and expired bytes are handled', { skip: skipDb }, async () => {
  const t = await docFixture();
  try {
    const a = await t.up(PNG_FILE());
    const b = await t.up(PDF_FILE());
    const c = await t.up(PNG_FILE());
    const clean = await docs.verifyStorage(t.db.pool, t.store);
    assert.deepEqual([clean.checked, clean.ok, clean.missing.length, clean.corrupt.length, clean.unreferenced.length], [3, 3, 0, 0, 0]);

    // A restore brings the database and the volume back together: a copy of the volume verifies against the metadata.
    const restoredDir = mkdtempSync(path.join(tmpdir(), 'tallymed-restore-'));
    cpSync(t.ts.dir, restoredDir, { recursive: true });
    const restored = new FileObjectStore(restoredDir);
    const ok = await docs.verifyStorage(t.db.pool, restored);
    assert.equal(ok.ok, 3);
    // Damage in the restored copy is reported by document and version: one missing, one with changed bytes, one stray file.
    const keys = Object.fromEntries((await rows(t, 'select document_id, storage_key from document_versions')).map((r) => [r.document_id, r.storage_key]));
    const fileOf = (key) => path.join(restoredDir, 'objects', key.slice(0, 2), key);
    writeFileSync(fileOf(keys[a.id]), Buffer.concat([readFileSync(fileOf(keys[a.id])), Buffer.from('x')]));
    await restored.remove(keys[b.id]);
    await restored.putQuarantine('f'.repeat(32), Buffer.from('partial'));
    await restored.putQuarantine('e'.repeat(32), Buffer.from('partial'));
    await restored.promote('e'.repeat(32));
    const bad = await docs.verifyStorage(t.db.pool, restored);
    assert.deepEqual(bad.corrupt, [{ documentId: a.id, versionNo: 1 }]);
    assert.deepEqual(bad.missing, [{ documentId: b.id, versionNo: 1 }]);
    assert.deepEqual(bad.unreferenced, ['e'.repeat(32)]);
    assert.deepEqual(bad.quarantined, ['f'.repeat(32)]);
    assert.equal(bad.ok, 1);

    // Cleanup respects the grace period: nothing fresh is removed.
    await t.store.putQuarantine('1'.repeat(32), Buffer.from('half-written'));
    await t.store.putQuarantine('2'.repeat(32), Buffer.from('promoted but not yet committed'));
    await t.store.promote('2'.repeat(32));
    const fresh = await docs.cleanupStorage(t.db.pool, t.store, { retentionDays: 30 });
    assert.deepEqual(fresh, { quarantineRemoved: 0, unreferencedRemoved: 0, purged: 0 });
    const later = await docs.cleanupStorage(t.db.pool, t.store, { retentionDays: 30, now: Date.now() + 2 * 3600 * 1000 });
    assert.deepEqual(later, { quarantineRemoved: 1, unreferencedRemoved: 1, purged: 0 });
    assert.equal((await docs.verifyStorage(t.db.pool, t.store)).ok, 3, 'referenced objects are never removed');

    // Removed documents keep their bytes through the retention window and are then purged, with metadata kept.
    const ver = String((await docs.getDocumentDetail(t.db.pool, t.actor, c.id)).document.version);
    await docs.removeDocument(t.db.pool, t.actor, { id: c.id, version: ver, reason: 'Duplicate' }, 'r');
    assert.equal((await docs.cleanupStorage(t.db.pool, t.store, { retentionDays: 30 })).purged, 0);
    assert.equal((await docs.cleanupStorage(t.db.pool, t.store, { retentionDays: 0 })).purged, 1);
    assert.equal((await docs.cleanupStorage(t.db.pool, t.store, { retentionDays: 0 })).purged, 0, 'idempotent');
    assert.equal((await rows(t, `select state from document_versions where document_id = $1`, [c.id]))[0].state, 'purged');
    assert.equal((await t.store.list()).objects.length, 2);
    assert.equal((await docs.verifyStorage(t.db.pool, t.store)).ok, 2);
    assert.equal((await t.audit('document.purged')).length, 1);
    assert.deepEqual(readdirSync(path.join(restoredDir, 'quarantine')).length, 1);
  } finally {
    await t.drop();
  }
});

test('migration 0007 upgrades a database that already holds money records', { skip: skipDb }, async () => {
  const { freshDatabase } = await import('./helpers.mjs');
  const { migrate } = await import('../../apps/web/server/migrate.ts');
  const db = await freshDatabase({ migrateAll: false });
  try {
    await migrate(db.pool, { upTo: '0006' });
    assert.equal((await db.pool.query(`select to_regclass('documents') as t`)).rows[0].t, null);
    await migrate(db.pool);
    for (const table of ['documents', 'document_versions', 'document_attachments']) assert.ok((await db.pool.query(`select to_regclass($1) as t`, [table])).rows[0].t, table);
    assert.deepEqual(await migrate(db.pool), []);
  } finally {
    await db.drop();
  }
});

test('the operator command verifies the volume, exits non-zero on damage and prints no titles or names', { skip: skipDb }, async () => {
  const { spawnSync } = await import('node:child_process');
  const t = await docFixture();
  try {
    const { id } = await t.up({ ...PNG_FILE(), name: 'Secret Clinic Statement.png' }, { title: 'Secret Clinic Statement' });
    const env = { ...process.env, DATABASE_URL: t.db.url, TALLYMED_DOCUMENTS_DIR: t.ts.dir };
    const run = (cmd) => spawnSync('node', ['apps/web/cli/documents.ts', cmd], { env, encoding: 'utf8' });
    let r = run('verify');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).ok, 1);
    const [v] = await rows(t, 'select storage_key from document_versions');
    writeFileSync(path.join(t.ts.dir, 'objects', v.storage_key.slice(0, 2), v.storage_key), Buffer.from('damaged'));
    r = run('verify');
    assert.equal(r.status, 1);
    assert.deepEqual(JSON.parse(r.stdout).corrupt, [{ documentId: id, versionNo: 1 }]);
    assert.ok(!/Secret/.test(r.stdout + r.stderr));
    assert.equal(spawnSync('node', ['apps/web/cli/documents.ts', 'bogus'], { env, encoding: 'utf8' }).status, 2);
    assert.equal(spawnSync('node', ['apps/web/cli/documents.ts', 'verify'], { env: { ...env, TALLYMED_DOCUMENTS_DIR: 'relative/dir' }, encoding: 'utf8' }).status, 2);
    r = run('cleanup');
    assert.equal(r.status, 0, r.stderr);
  } finally {
    await t.drop();
  }
});
