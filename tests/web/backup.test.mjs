// Server-wide backup and restore: archive format, encryption, completeness, exclusion of secrets, exact round trip of the ledger,
// refusals (not empty, wrong version, changed or doctored archives), the admin download route, the setup restore route and the CLI.
// Synthetic data only.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import test from 'node:test';
import { promisify } from 'node:util';
import { gunzipSync, gzipSync } from 'node:zlib';
import * as handlers from '../../apps/web/server/http.ts';
import {
  BackupError, DATA_ENTRY, MANIFEST_ENTRY, TAR_END, decryptStream, encryptStream, readTar, tarEntry, tarHeader,
} from '../../apps/web/server/backup/archive.ts';
import { createBackup, restoreArchive, verifyArchive } from '../../apps/web/server/backup/engine.ts';
import { ledgerSummary, ledgerViolations } from '../../apps/web/server/backup/ledger.ts';
import { BACKUP_TABLES, EXCLUDED_TABLES } from '../../apps/web/server/backup/tables.ts';
import { migrate } from '../../apps/web/server/migrate.ts';
import { hashPassword } from '../../apps/web/server/passwords.ts';
import * as assistant from '../../apps/web/server/services/assistant.ts';
import { authenticate } from '../../apps/web/server/services/auth.ts';
import { isBootstrapped } from '../../apps/web/server/services/bootstrap.ts';
import { resetBackupStateForTests } from '../../apps/web/server/services/backup.ts';
import { verifyStorage } from '../../apps/web/server/services/documents.ts';
import * as docs from '../../apps/web/server/services/documents.ts';
import * as svc from '../../apps/web/server/services/expenses.ts';
import * as hsa from '../../apps/web/server/services/hsa.ts';
import * as hsaRepo from '../../apps/web/server/repositories/hsa.ts';
import * as pay from '../../apps/web/server/services/payments.ts';
import * as plans from '../../apps/web/server/services/plans.ts';
import { resetSettingsLimitersForTests } from '../../apps/web/server/services/settings.ts';
import { resetSetupState, setSetupOutput } from '../../apps/web/server/setup-token.ts';
import { csrfFor, digest } from '../../apps/web/server/tokens.ts';
import { PDF_FILE, PNG_FILE, docFixture, tempStore } from './document-helpers.mjs';
import { ORIGIN, PASSWORD, freshDatabase, loginJson, post, skipDb, testConfig } from './helpers.mjs';

const run = promisify(execFile);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const code = (c) => (e) => e instanceof BackupError && e.code === c;
const SETUP_TOKEN = 'Vq3Zx8Lm1Rt6Yp0Kd4Wn7Jc2Hs5Bg9Fe-Ua_MoTiXl';
const SMTP_CIPHERTEXT = 'v1.abcdef01.c2VjcmV0LW5vbmNl.c2VjcmV0LXRhZw.c210cC1wYXNzd29yZC1jaXBoZXJ0ZXh0';

async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}
const tarOf = (entries) => Readable.from([Buffer.concat([...entries.flatMap(([name, content]) => tarEntry(name, content)), TAR_END])]);
const manifestEntry = [MANIFEST_ENTRY, Buffer.from('{}')];

/** Writes a backup to a file and returns its path and outcome. */
async function backupTo(dir, pool, store, passphrase = null) {
  const backup = createBackup(pool, store, { passphrase });
  const file = path.join(dir, backup.filename);
  await pipeline(backup.stream, createWriteStream(file));
  return { file, outcome: await backup.done, backup };
}

/**
 * Rebuilds a plain archive after letting `mutate` change its entries, with every checksum in the manifest recomputed. This is what
 * someone who can edit a backup could produce: internally consistent, so only the database-level checks can refuse it.
 */
async function rewrite(file, mutate) {
  const entries = await collect(readTar(Readable.from([gunzipSync(readFileSync(file))])));
  const manifest = JSON.parse(entries.pop().content.toString('utf8'));
  const list = entries.map((e) => ({ name: e.name, content: e.content }));
  await mutate(list, manifest);
  manifest.entries = list.map((e) => ({ path: e.name, size: e.content.length, sha256: sha(e.content) }));
  for (const t of manifest.tables) {
    const parts = list.filter((e) => DATA_ENTRY.exec(e.name)?.[1] === t.name);
    const all = Buffer.concat(parts.map((p) => p.content));
    t.parts = parts.length;
    t.rows = all.toString('utf8').split('\n').length - 1;
    t.sha256 = sha(all);
  }
  const docsIn = list.filter((e) => e.name.startsWith('documents/'));
  manifest.documents = { count: docsIn.length, bytes: docsIn.reduce((n, e) => n + e.content.length, 0) };
  const out = `${file}.rewritten`;
  writeFileSync(out, gzipSync(Buffer.concat([
    ...list.flatMap((e) => tarEntry(e.name, e.content)), ...tarEntry(MANIFEST_ENTRY, Buffer.from(JSON.stringify(manifest))), TAR_END,
  ])));
  return out;
}
const editRows = (list, table, fn) => {
  const part = list.find((e) => DATA_ENTRY.exec(e.name)?.[1] === table);
  const rows = part.content.toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
  part.content = Buffer.from(fn(rows).map((r) => JSON.stringify(r)).join('\n') + '\n');
};

/** A household with every kind of record the ledger knows, built through the real services. */
async function richFixture() {
  const t = await docFixture();
  const pool = t.db.pool;
  const actor = t.actor;
  const m = await t.member();
  const p = await t.provider();
  const visit = await svc.createVisit(pool, actor, { memberId: m, providerId: p, serviceDate: '2026-01-05', description: 'Annual check' }, 'r');
  const a = await t.bill({ memberId: m, providerId: p, originalAmount: '300.00', visitId: visit.id });
  const b = await t.bill({ memberId: m, providerId: p, originalAmount: '120.45' });
  const c = await t.bill({ memberId: m, providerId: p, originalAmount: '80.00' });
  await t.bill({ memberId: m, providerId: p, originalAmount: '55.55', amountStatus: 'estimate' });
  // Adjustments, one of them reversed.
  await t.adjust(b.id, '-20.40');
  const wrong = await t.adjust(c.id, '-5.00');
  await svc.reverseAdjustment(pool, actor, { idempotencyKey: t.key(), billId: c.id, adjustmentId: wrong.id, reason: 'Entered on the wrong bill' }, 'r');
  // Payments: split allocation, partial allocation, refund and its reversal, an allocation reversal, a voided payment.
  const p1 = await t.pay1({ amount: '250.00', allocations: [{ billId: a.id, amount: '150.00' }, { billId: b.id, amount: '75.05' }] });
  const p2 = await t.pay1({ amount: '60.00', billId: c.id, allocateAmount: '40.00' });
  const allocs = (await t.payment(p1.id)).allocations;
  const allocA = allocs.find((x) => x.billId === a.id).allocationId;
  const allocB = allocs.find((x) => x.billId === b.id).allocationId;
  const refund = await t.refund(p1.id, { allocationId: allocB, amount: '10.00' });
  const refund2 = await t.refund(p1.id, { allocationId: allocB, amount: '3.00' });
  await pay.reverseRefund(pool, actor, { idempotencyKey: t.key(), eventId: refund2.id, effectiveDate: '2026-05-02', reason: 'Entered in error' }, 'r');
  const allocC = (await t.payment(p2.id)).allocations[0].allocationId;
  await pay.reverseAllocation(pool, actor, { idempotencyKey: t.key(), allocationId: allocC, amount: '5.00', effectiveDate: '2026-05-03', reason: 'Wrong bill' }, 'r');
  const p3 = await t.pay1({ amount: '12.34' });
  await pay.voidPayment(pool, actor, { idempotencyKey: t.key(), paymentId: p3.id, voidedOn: '2026-04-02', reason: 'Entered twice' }, 'r');
  // A plan with a match, then a revision that carries it forward; a second plan that is cancelled.
  const plan = await plans.createPlan(pool, actor, { idempotencyKey: t.key(), name: 'Clinic plan', providerId: p, billId: a.id, totalAmount: '300.00', installmentCount: '3', firstDueDate: '2026-06-01', cadence: 'monthly' }, 'r');
  const d0 = await plans.getPlanDetail(pool, actor, plan.id, { asOf: '2026-07-15' });
  await plans.matchInstallment(pool, actor, { idempotencyKey: t.key(), installmentId: d0.installments[0].id, allocationId: allocA, amount: '100.00' }, 'r');
  const d1 = await plans.getPlanDetail(pool, actor, plan.id, { asOf: '2026-07-15' });
  await plans.revisePlan(pool, actor, { idempotencyKey: t.key(), planId: plan.id, version: d1.plan.version, reason: 'Lower monthly amount', totalAmount: '300.00', installmentCount: '6', firstDueDate: '2026-06-01', cadence: 'monthly' }, 'r');
  const plan2 = await plans.createPlan(pool, actor, { idempotencyKey: t.key(), name: 'Short plan', providerId: p, billId: c.id, totalAmount: '40.00', installmentCount: '2', firstDueDate: '2026-08-01', cadence: 'monthly' }, 'r');
  const d2 = await plans.getPlanDetail(pool, actor, plan2.id, { asOf: '2026-07-15' });
  await plans.cancelPlan(pool, actor, { planId: plan2.id, version: d2.plan.version, reason: 'Paid in full instead' }, 'r');
  // HSA: decision, claim, partial receipt, a receipt that is reversed, a released line, and a refund after the claim (needs review stays possible).
  const decide = async (allocationId, amount) => hsa.recordDecision(pool, actor, {
    idempotencyKey: t.key(), allocationId, version: String((await hsaRepo.getAllocation(pool, actor.householdId, allocationId)).decisionCount), status: 'eligible', eligibleAmount: amount,
    rationale: 'Qualified medical expense per plan rules', evidenceType: 'receipt', evidenceNote: 'Receipt on file', decidedOn: '2026-04-05',
  }, 'r');
  await decide(allocA, '120.00');
  await decide(allocA, '110.00');
  const claim = await hsa.submitClaim(pool, actor, { idempotencyKey: t.key(), submittedOn: '2026-04-10', administrator: 'Example HSA Bank', reference: 'CLM-1', lines: [{ allocationId: allocA, amount: '90.00' }] }, 'r');
  const line = (await hsaRepo.linesOfClaim(pool, actor.householdId, claim.id))[0];
  const receipt = await hsa.recordReceipt(pool, actor, { idempotencyKey: t.key(), receivedOn: '2026-04-20', source: 'administrator_transfer', lines: [{ lineId: line.lineId ?? line.id, amount: '30.00' }] }, 'r');
  const receipt2 = await hsa.recordReceipt(pool, actor, { idempotencyKey: t.key(), receivedOn: '2026-04-22', source: 'administrator_transfer', lines: [{ lineId: line.lineId ?? line.id, amount: '10.00' }] }, 'r');
  await hsa.reverseReceipt(pool, actor, { idempotencyKey: t.key(), receiptId: receipt2.id, effectiveDate: '2026-05-02', reason: 'Returned by the bank' }, 'r');
  await hsa.releaseClaimLine(pool, actor, { idempotencyKey: t.key(), lineId: line.lineId ?? line.id, kind: 'reject', amount: '20.00', effectiveDate: '2026-04-25', reason: 'Administrator response' }, 'r');
  await hsa.recordExternalReceipt(pool, actor, {
    idempotencyKey: t.key(), receivedOn: '2026-04-21', source: 'hsa_debit_card', evidenceType: 'statement', evidenceNote: 'Card statement line', lines: [{ allocationId: allocA, amount: '5.00' }],
  }, 'r');
  // Documents: two versions, attachments to a bill and a receipt, one removed document.
  const doc = await t.up(PNG_FILE(), { title: 'Statement January' });
  await docs.addDocumentVersion(t.deps, actor, { idempotencyKey: t.key(), documentId: doc.id, version: '1', file: PDF_FILE() }, 'r');
  await docs.attachDocument(pool, actor, { idempotencyKey: t.key(), documentId: doc.id, targetType: 'bill', targetId: a.id, note: 'Statement' }, 'r');
  await docs.attachDocument(pool, actor, { idempotencyKey: t.key(), documentId: doc.id, targetType: 'hsa_receipt', targetId: receipt.id }, 'r');
  const gone = await t.up(PNG_FILE(), { title: 'Duplicate scan' });
  await docs.removeDocument(pool, actor, { id: gone.id, version: '1', reason: 'Duplicate scan' }, 'r');
  // A second person, an assistant credential with a proposal, settings, and the things a backup must leave behind.
  await pool.query(`insert into users (household_id, email, display_name, role, password_hash) values ($1, 'standard@example.test', 'Sam Example', 'operator', $2)`, [actor.householdId, await hashPassword(PASSWORD)]);
  const client = await assistant.createClient(pool, actor, { name: 'Example assistant', expiryDays: 30, documentsRead: 'yes', proposalsCreate: 'yes' }, 'r');
  const version = (await pool.query(`select id from document_versions where document_id = $1 and version_no = 2`, [doc.id])).rows[0].id;
  await pool.query(
    `insert into document_match_proposals (id, household_id, client_id, document_id, document_version_id, document_version_no, target_type, bill_id, target_version, rationale, confidence)
     values ($1, $2, $3, $4, $5, 2, 'bill', $6, 1, 'Same provider and statement date.', 'high')`,
    [randomUUID(), actor.householdId, client.id, doc.id, version, b.id]);
  await pool.query(`insert into server_settings (group_key, value, updated_by) values ('general', '{"sessionIdleSeconds": 1800}', $1), ('documents', '{"documentMaxMb": 12}', $1)`, [actor.userId]);
  await pool.query(`insert into server_settings (group_key, value, secret_ciphertext, updated_by) values ('email', '{"host": "smtp.example.test", "port": 587, "username": "mailer", "fromAddress": "tallymed@example.test"}', $2, $1)`, [actor.userId, SMTP_CIPHERTEXT]);
  await pool.query(`insert into server_settings (group_key, value, updated_by) values ('proxy', '{"trustedProxies": ["10.9.8.7"]}', $1)`, [actor.userId]);
  const invitation = randomBytes(32);
  await pool.query(`insert into invitations (household_id, email, role, token_hash, invited_by, expires_at) values ($1, 'invited@example.test', 'operator', $2, $3, now() + interval '1 day')`, [actor.householdId, invitation, actor.userId]);
  return { ...t, bills: { a, b, c }, payments: { p1, p2, p3 }, plan, plan2, claim, receipt, doc, gone, client, allocA, refund, invitation };
}

/** Everything the application reports about the ledger, read through the services the pages use. */
async function figures(pool, actor, f) {
  const bills = [];
  for (const b of (await svc.listBills(pool, actor, {})).items) bills.push((await svc.getBillDetail(pool, actor, b.id)).bill);
  bills.sort((x, y) => String(x.id).localeCompare(String(y.id)));
  const strip = (v) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
  return strip({
    bills,
    cash: await pay.cashSummary(pool, actor),
    payments: await Promise.all(Object.values(f.payments).map((p) => pay.getPaymentDetail(pool, actor, p.id))),
    plans: [await plans.getPlanDetail(pool, actor, f.plan.id, { asOf: '2026-07-15' }), await plans.getPlanDetail(pool, actor, f.plan2.id, { asOf: '2026-07-15' })],
    hsa: await hsaRepo.getAllocation(pool, actor.householdId, f.allocA),
    document: await docs.getDocumentDetail(pool, actor, f.doc.id),
    summary: { ...(await ledgerSummary(pool)), auditEvents: null },
  });
}

async function emptyTarget() {
  const db = await freshDatabase();
  const ts = tempStore();
  return { db, ts, store: ts.store, async drop() { ts.cleanup(); await db.drop(); } };
}
const tableCounts = async (pool) => Object.fromEntries(await Promise.all(BACKUP_TABLES.map(async (t) => [t.name, (await pool.query(`select count(*)::int n from ${t.name}`)).rows[0].n])));

// ---------- archive format ----------

test('the tar reader accepts only the fixed entry names, in order, and refuses everything else', async () => {
  const good = [['data/users.000001.ndjson', Buffer.from('{}\n')], ['documents/' + 'ab'.repeat(16), Buffer.from('x')], manifestEntry];
  assert.deepEqual((await collect(readTar(tarOf(good)))).map((e) => [e.name, e.kind]), [
    ['data/users.000001.ndjson', 'data'], ['documents/' + 'ab'.repeat(16), 'document'], ['manifest.json', 'manifest']]);
  const refused = async (entries, pattern, raw) => assert.rejects(collect(readTar(raw ?? tarOf(entries))), (e) => code('invalid_archive')(e) && pattern.test(e.message));
  await refused([['../../etc/passwd', Buffer.from('x')], manifestEntry], /unexpected name/);
  await refused([['/etc/passwd', Buffer.from('x')], manifestEntry], /unexpected name/);
  await refused([['data/../users.000001.ndjson', Buffer.from('x')], manifestEntry], /unexpected name/);
  await refused([['documents/../../x', Buffer.from('x')], manifestEntry], /unexpected name/);
  await refused([['data/users.000001.ndjson', Buffer.from('a')], ['data/users.000001.ndjson', Buffer.from('b')], manifestEntry], /twice/);
  await refused([manifestEntry, ['data/users.000001.ndjson', Buffer.from('a')]], /after its manifest/);
  await refused([['documents/' + 'ab'.repeat(16), Buffer.from('x')], ['data/users.000001.ndjson', Buffer.from('a')], manifestEntry], /unexpected order/);
  await refused([['data/users.000001.ndjson', Buffer.from('a')]], /no manifest/);
  // A symbolic link, a hard link and a directory are not regular files.
  for (const type of ['2', '1', '5', 'L', 'x']) {
    const h = tarHeader('documents/' + 'cd'.repeat(16), 0);
    h.write(type, 156, 'ascii');
    h.write('        ', 148, 'ascii');
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    await refused(null, /not a regular file/, Readable.from([Buffer.concat([h, ...tarEntry(...manifestEntry), TAR_END])]));
  }
  // A damaged header, an oversized entry, a cut-off stream and data after the end marker.
  const bad = tarHeader('manifest.json', 2);
  bad[0] ^= 1;
  await refused(null, /damaged entry header/, Readable.from([Buffer.concat([bad, Buffer.alloc(512), TAR_END])]));
  await refused(null, /larger than allowed/, Readable.from([Buffer.concat([tarHeader('data/users.000001.ndjson', 64 * 1024 * 1024), TAR_END])]));
  const whole = Buffer.concat([...tarEntry('data/users.000001.ndjson', Buffer.alloc(2000, 0x61)), ...tarEntry(...manifestEntry), TAR_END]);
  await refused(null, /incomplete|middle of an entry/, Readable.from([whole.subarray(0, 900)]));
  await refused(null, /end marker is missing/, Readable.from([whole.subarray(0, whole.length - 1024)]));
  await refused(null, /after its end marker/, Readable.from([Buffer.concat([whole, Buffer.alloc(512, 1)])]));
});

test('passphrase encryption round-trips and detects a wrong passphrase, a changed byte, a dropped frame and a cut-off file', async () => {
  const plain = randomBytes(200_000);
  const sealed = Buffer.concat(await collect(Readable.from([plain.subarray(0, 70_000), plain.subarray(70_000)]).pipe(encryptStream('correct horse battery'))));
  assert.equal(sealed.subarray(0, 8).toString(), 'TMBKENC1');
  assert.equal(sealed.indexOf(plain.subarray(0, 32)), -1, 'ciphertext does not contain the plaintext');
  const open = async (bytes, pass = 'correct horse battery') => Buffer.concat(await collect(Readable.from([bytes]).pipe(decryptStream(pass))));
  assert.ok((await open(sealed)).equals(plain));
  // Chunk boundaries do not matter.
  const pieces = [];
  for (let i = 0; i < sealed.length; i += 777) pieces.push(sealed.subarray(i, i + 777));
  assert.ok(Buffer.concat(await collect(Readable.from(pieces).pipe(decryptStream('correct horse battery')))).equals(plain));
  await assert.rejects(open(sealed, 'incorrect horse battery'), code('passphrase_wrong'));
  const flipped = Buffer.from(sealed);
  flipped[sealed.length - 40] ^= 1;
  await assert.rejects(open(flipped), code('invalid_archive'));
  const salted = Buffer.from(sealed);
  salted[10] ^= 1;
  await assert.rejects(open(salted), code('passphrase_wrong'));
  await assert.rejects(open(sealed.subarray(0, sealed.length - 50)), code('invalid_archive'));
  // Dropping the final frame (a clean cut at a frame boundary) is still detected: the last frame is flagged in its nonce.
  const frame = 4 + 65536 + 16;
  await assert.rejects(open(sealed.subarray(0, 27 + frame * 3)), code('invalid_archive'));
  // Reordering two frames fails authentication.
  const swapped = Buffer.concat([sealed.subarray(0, 27), sealed.subarray(27 + frame, 27 + 2 * frame), sealed.subarray(27, 27 + frame), sealed.subarray(27 + 2 * frame)]);
  await assert.rejects(open(swapped), (e) => e instanceof BackupError);
  // Key-derivation settings in the header are bounded, so a crafted file cannot demand unbounded memory.
  const greedy = Buffer.from(sealed);
  greedy[24] = 30;
  await assert.rejects(open(greedy), (e) => code('invalid_archive')(e) && /unsupported key settings/.test(e.message));
  // An empty input still produces an authenticated, non-empty container.
  const empty = Buffer.concat(await collect(Readable.from([]).pipe(encryptStream('correct horse battery'))));
  assert.equal((await open(empty)).length, 0);
});

test('every table of the schema is either backed up or deliberately left out', { skip: skipDb }, async () => {
  const db = await freshDatabase();
  try {
    const all = (await db.pool.query(`select tablename from pg_tables where schemaname = 'public' order by 1`)).rows.map((r) => r.tablename);
    const included = BACKUP_TABLES.map((t) => t.name);
    assert.equal(new Set(included).size, included.length);
    for (const name of all) {
      assert.ok(included.includes(name) !== (name in EXCLUDED_TABLES), `${name} must be in exactly one of BACKUP_TABLES and EXCLUDED_TABLES (apps/web/server/backup/tables.ts)`);
    }
    for (const name of [...included, ...Object.keys(EXCLUDED_TABLES)]) assert.ok(all.includes(name), `${name} is not a table`);
    // The order is a valid load order: every foreign key points at the same table or an earlier one.
    const fks = (await db.pool.query(`select conrelid::regclass::text as child, confrelid::regclass::text as parent from pg_constraint where contype = 'f'`)).rows;
    for (const fk of fks) {
      if (!included.includes(fk.child)) continue;
      assert.ok(included.includes(fk.parent), `${fk.child} references ${fk.parent}, which is not backed up`);
      assert.ok(included.indexOf(fk.parent) <= included.indexOf(fk.child), `${fk.parent} must come before ${fk.child}`);
    }
  } finally {
    await db.drop();
  }
});

// ---------- round trip ----------

test('a backup restores into an empty installation with every figure, document and audit row identical', { skip: skipDb }, async () => {
  const f = await richFixture();
  const target = await emptyTarget();
  try {
    assert.deepEqual(await ledgerViolations(f.db.pool), []);
    const live = await figures(f.db.pool, f.actor, f);
    const liveCounts = await tableCounts(f.db.pool);
    const { file, outcome, backup } = await backupTo(f.ts.dir, f.db.pool, f.store);
    assert.match(backup.filename, /^tallymed-backup-\d{8}T\d{6}Z\.tar\.gz$/);
    assert.equal(outcome.sha256, sha(readFileSync(file)));
    assert.equal(outcome.documents, 3);

    // The file is an ordinary gzip-compressed tar that standard tools can list.
    const listing = (await run('tar', ['-tzf', file])).stdout.trim().split('\n');
    assert.equal(listing.at(-1), 'manifest.json');
    assert.ok(listing.includes('data/payment_entries.000001.ndjson'));
    assert.equal(listing.filter((l) => l.startsWith('documents/')).length, 3);

    const verified = await verifyArchive(file);
    const m = verified.manifest;
    assert.equal(m.format, 'tallymed-backup');
    assert.equal(m.app.version, JSON.parse(readFileSync(new URL('../../apps/web/package.json', import.meta.url), 'utf8')).version);
    assert.equal(m.database.migrations.at(-1).version, '0011');
    assert.deepEqual(m.tables.map((t) => t.name), BACKUP_TABLES.map((t) => t.name));
    for (const t of m.tables) {
      const expected = t.name === 'server_settings' ? 2 : liveCounts[t.name];
      assert.equal(t.rows, expected, t.name);
    }
    for (const name of ['payment_entries', 'payment_voids', 'installment_matches', 'plan_revisions', 'hsa_entries', 'hsa_eligibility_decisions', 'document_attachments', 'document_match_proposals', 'mcp_clients', 'bill_adjustments', 'idempotency_records']) {
      assert.ok(m.tables.find((t) => t.name === name).rows > 0, `${name} is exercised by the fixture`);
    }
    assert.equal(m.ledger.openBalanceCents, live.summary.openBalanceCents);

    const result = await restoreArchive(target.db.pool, target.store, file, { via: 'cli' });
    assert.equal(result.backupId, m.backupId);
    assert.equal(result.archiveSha256, outcome.sha256);
    const pool = target.db.pool;

    // Sessions are not restored: the old cookie means nothing, and signing in with the same password works.
    assert.equal(await authenticate(pool, f.config, f.cookie.split('=')[1]), null);
    const ctx = { config: testConfig({}, target.db.url), pool, store: target.store };
    const signedIn = await loginJson(handlers, ctx, 'admin@example.test');
    assert.equal(signedIn.res.status, 200);
    const actor = await authenticate(pool, ctx.config, signedIn.cookie.split('=')[1]);
    assert.equal(actor.userId, f.actor.userId);
    assert.equal(actor.householdId, f.actor.householdId);
    assert.equal((await loginJson(handlers, ctx, 'standard@example.test')).res.status, 200);

    // Every reported figure is identical, cent for cent.
    const restored = await figures(pool, actor, f);
    assert.deepEqual(restored, live);
    assert.deepEqual(await ledgerViolations(pool), []);

    // Row counts: identical, except settings groups that are left out; the audit log gained the restore and the two sign-ins.
    const counts = await tableCounts(pool);
    for (const [name, n] of Object.entries(liveCounts)) {
      if (name === 'server_settings') assert.equal(counts[name], 2);
      else if (name === 'audit_events') assert.equal(counts[name], n + 3);
      else assert.equal(counts[name], n, name);
    }
    const audit = (await pool.query(`select action, actor_user_id, detail from audit_events where action = 'backup.restored'`)).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actor_user_id, null);
    assert.equal(audit[0].detail.archiveSha256, outcome.sha256);
    assert.equal(audit[0].detail.via, 'cli');
    // The original audit rows kept their ids, order, actors and times.
    const auditOf = async (p) => (await p.query(`select id, action, actor_user_id, entity_id, detail, occurred_at from audit_events where id <= $1 order by id`, [liveCounts.audit_events])).rows;
    assert.deepEqual(await auditOf(pool), (await auditOf(f.db.pool)).slice(0, liveCounts.audit_events));

    // Documents: every available version is on the new volume with its recorded checksum; nothing extra.
    const report = await verifyStorage(pool, target.store);
    assert.deepEqual([report.checked, report.ok, report.missing.length, report.corrupt.length, report.unreferenced.length, report.quarantined.length], [3, 3, 0, 0, 0, 0]);
    const download = await docs.downloadDocument(pool, target.store, actor, f.doc.id, 1, 'r');
    assert.equal(sha(download.bytes), sha((await docs.downloadDocument(f.db.pool, f.store, f.actor, f.doc.id, 1, 'r')).bytes));

    // The database guards are back in force and the sequences continue after the restored rows.
    await assert.rejects(pool.query(`update audit_events set action = 'x'`), /append-only/);
    await assert.rejects(pool.query(`delete from payment_entries`), /append-only/);
    await assert.rejects(pool.query(`update payments set amount_cents = 1`), /append-only/);
    const disabled = (await pool.query(`select count(*)::int n from pg_trigger where not tgisinternal and tgenabled <> 'O'`)).rows[0].n;
    assert.equal(disabled, 0, 'no trigger is left disabled');
    await assert.rejects(pay.recordPayment(pool, actor, { idempotencyKey: randomUUID(), paidOn: '2026-06-01', amount: '500.00', method: 'card', billId: f.bills.c.id, allocateAmount: '500.00' }, 'r'), { code: 'conflict' });
    const fresh = await pay.recordPayment(pool, actor, { idempotencyKey: randomUUID(), paidOn: '2026-06-01', amount: '10.00', method: 'card', billId: f.bills.c.id, allocateAmount: '10.00' }, 'r');
    const seqs = (await pool.query(`select max(seq)::int as max, (select seq::int from payment_entries where payment_id = $1) as mine from payment_entries`, [fresh.id])).rows[0];
    assert.equal(seqs.mine, seqs.max);
    // One logical request still has one effect after a restore: a replayed key returns the original result.
    assert.equal((await pool.query(`select count(*)::int n from idempotency_records`)).rows[0].n, liveCounts.idempotency_records + 1);

    // A second restore into the now populated installation is refused and changes nothing.
    const before = await tableCounts(pool);
    await assert.rejects(restoreArchive(pool, target.store, file, { via: 'cli' }), code('not_empty'));
    assert.deepEqual(await tableCounts(pool), before);
  } finally {
    await target.drop();
    await f.drop();
  }
});

test('secrets and sign-in state never enter a backup', { skip: skipDb }, async () => {
  const f = await richFixture();
  const target = await emptyTarget();
  try {
    const token = (await f.db.pool.query(`select token_hash from mcp_clients`)).rows[0].token_hash;
    const session = digest(f.cookie.split('=')[1]);
    const { file } = await backupTo(f.ts.dir, f.db.pool, f.store);
    const tar = gunzipSync(readFileSync(file));
    const text = tar.toString('latin1');
    for (const [what, needle] of [
      ['the encrypted SMTP password', SMTP_CIPHERTEXT], ['the SMTP relay', 'smtp.example.test'], ['the SMTP user', 'mailer'], ['the trusted proxy list', '10.9.8.7'],
      ['the assistant token digest', token.toString('hex')], ['a session token digest', session.toString('hex')], ['an invitation token digest', f.invitation.toString('hex')],
      ['an invited address', 'invited@example.test'], ['the proxy secret', f.config.proxySecret],
    ]) assert.equal(text.includes(needle), false, `${what} must not be in the backup`);
    const names = (await collect(readTar(Readable.from([tar])))).map((e) => e.name);
    for (const excluded of Object.keys(EXCLUDED_TABLES)) assert.equal(names.some((n) => n.startsWith(`data/${excluded}.`)), false, excluded);

    await restoreArchive(target.db.pool, target.store, file, { via: 'cli' });
    const pool = target.db.pool;
    assert.deepEqual((await pool.query(`select group_key, secret_ciphertext from server_settings order by 1`)).rows, [
      { group_key: 'documents', secret_ciphertext: null }, { group_key: 'general', secret_ciphertext: null }]);
    for (const table of ['sessions', 'invitations', 'password_resets', 'login_attempts', 'password_reset_requests']) {
      assert.equal((await pool.query(`select count(*)::int n from ${table}`)).rows[0].n, 0, table);
    }
    // The assistant client is kept for the proposal's history, but its credential is replaced by a digest no token can produce.
    const client = (await pool.query(`select id, name, token_hash from mcp_clients`)).rows[0];
    assert.equal(client.name, 'Example assistant');
    assert.notEqual(client.token_hash.toString('hex'), token.toString('hex'));
    assert.equal(client.token_hash.toString('hex'), sha(`tallymed-backup:no-credential:${client.id}`));
  } finally {
    await target.drop();
    await f.drop();
  }
});

test('an encrypted backup needs its passphrase and restores exactly', { skip: skipDb }, async () => {
  const f = await richFixture();
  const target = await emptyTarget();
  try {
    const { file, backup } = await backupTo(f.ts.dir, f.db.pool, f.store, 'a long household passphrase');
    assert.match(backup.filename, /\.tar\.gz\.enc$/);
    const bytes = readFileSync(file);
    assert.equal(bytes.subarray(0, 8).toString(), 'TMBKENC1');
    assert.equal(bytes.includes(Buffer.from('admin@example.test')), false);
    assert.equal(bytes.includes(Buffer.from([0x1f, 0x8b, 0x08])) && bytes.indexOf(Buffer.from('manifest.json')) >= 0, false);
    await assert.rejects(verifyArchive(file), code('passphrase_required'));
    await assert.rejects(verifyArchive(file, 'not the household passphrase'), code('passphrase_wrong'));
    await assert.rejects(restoreArchive(target.db.pool, target.store, file, { via: 'cli', passphrase: 'not the household passphrase' }), code('passphrase_wrong'));
    assert.equal((await tableCounts(target.db.pool)).households, 0);
    const result = await restoreArchive(target.db.pool, target.store, file, { via: 'cli', passphrase: 'a long household passphrase' });
    assert.equal(result.documents, 3);
    assert.deepEqual(await ledgerSummary(target.db.pool).then((s) => ({ ...s, auditEvents: null })), { ...(await ledgerSummary(f.db.pool)), auditEvents: null });
  } finally {
    await target.drop();
    await f.drop();
  }
});

// ---------- refusals ----------

test('a changed, cut-off or doctored backup is refused and leaves the target empty', { skip: skipDb }, async () => {
  const f = await richFixture();
  const target = await emptyTarget();
  const untouched = async () => {
    const counts = await tableCounts(target.db.pool);
    assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 0, 'the database is still empty');
    const listed = await target.store.list();
    assert.deepEqual([listed.objects.length, listed.quarantine.length], [0, 0], 'no document file was left behind');
    assert.equal((await target.db.pool.query(`select count(*)::int n from pg_trigger where not tgisinternal and tgenabled <> 'O'`)).rows[0].n, 0);
  };
  const refused = async (file, c, pattern) => {
    await assert.rejects(restoreArchive(target.db.pool, target.store, file, { via: 'cli' }), (e) => code(c)(e) && (!pattern || pattern.test(e.message)));
    await untouched();
  };
  try {
    const { file } = await backupTo(f.ts.dir, f.db.pool, f.store);
    const bytes = readFileSync(file);
    const variant = (name, content) => { const p = path.join(f.ts.dir, name); writeFileSync(p, content); return p; };

    // Not a backup at all, a cut-off download, and a flipped byte.
    await refused(variant('note.txt', Buffer.from('this is not a backup')), 'invalid_archive', /not a TallyMed backup/);
    await refused(variant('cut.tar.gz', bytes.subarray(0, bytes.length - 200)), 'invalid_archive');
    const flipped = Buffer.from(bytes);
    flipped[Math.floor(bytes.length / 2)] ^= 0xff;
    await refused(variant('flipped.tar.gz', flipped), 'invalid_archive');
    // A valid archive whose content was edited without updating the manifest.
    const entries = await collect(readTar(Readable.from([gunzipSync(bytes)])));
    const edited = entries.map((e) => [e.name, e.name.startsWith('data/bills.') ? Buffer.from(e.content.toString().replace('"original_cents":30000', '"original_cents":30001')) : e.content]);
    await refused(variant('edited.tar.gz', gzipSync(Buffer.concat([...edited.flatMap(([n, c]) => tarEntry(n, c)), TAR_END]))), 'invalid_archive', /do not match its manifest/);
    // An entry removed, and the manifest missing.
    const fewer = entries.filter((e) => !e.name.startsWith('documents/')).map((e) => [e.name, e.content]);
    await refused(variant('fewer.tar.gz', gzipSync(Buffer.concat([...fewer.flatMap(([n, c]) => tarEntry(n, c)), TAR_END]))), 'invalid_archive');
    await refused(variant('headless.tar.gz', gzipSync(Buffer.concat([...entries.slice(0, -1).flatMap((e) => tarEntry(e.name, e.content)), TAR_END]))), 'invalid_archive', /no manifest/);
    // A newer format version and an unknown table.
    await refused(await rewrite(file, (_l, m) => { m.formatVersion = 2; }), 'incompatible');
    await refused(await rewrite(file, (l) => { l.unshift({ name: 'data/secrets.000001.ndjson', content: Buffer.from('{}\n') }); }), 'incompatible');

    // Doctored but internally consistent archives: every checksum matches, so the database-level checks decide.
    // 1. An adjustment that would make a bill's responsibility negative.
    await refused(await rewrite(file, (l) => editRows(l, 'bill_adjustments', (rows) => { rows[0].amount_cents = -99_999_999; return rows; })), 'verification_failed', /ledger rule.*responsibility/);
    // 2. A refund larger than its allocation.
    await refused(await rewrite(file, (l) => editRows(l, 'payment_entries', (rows) => { rows.find((r) => r.kind === 'refund').amount_cents = -900_000; return rows; })), 'verification_failed', /ledger rule/);
    // 3. Cash applied to a bill whose amounts were never confirmed.
    await refused(await rewrite(file, (l) => editRows(l, 'bills', (rows) => rows.map((r) => ({ ...r, amount_status: 'estimate', confirmed_at: null, confirmed_by: null })))), 'verification_failed', /confirmed amounts/);
    // 4. A schedule whose installments no longer add up.
    await refused(await rewrite(file, (l) => editRows(l, 'plan_installments', (rows) => { rows[0].amount_cents += 1; return rows; })), 'verification_failed', /add up to its total/);
    // 5. A reimbursement receipt that is no longer allocated in full.
    await refused(await rewrite(file, (l) => editRows(l, 'hsa_receipts', (rows) => { rows[0].amount_cents += 100; return rows; })), 'verification_failed', /allocated in full/);
    // 6. A value the table's own checks refuse, and a row pointing at a record that is not there.
    await refused(await rewrite(file, (l) => editRows(l, 'payments', (rows) => { rows[0].amount_cents = -5; return rows; })), 'verification_failed', /database refused/);
    await refused(await rewrite(file, (l) => editRows(l, 'bills', (rows) => { rows[0].provider_id = randomUUID(); return rows; })), 'verification_failed', /database refused/);
    // 7. An unknown field is not silently dropped: the restored table would no longer equal the backup.
    await refused(await rewrite(file, (l) => editRows(l, 'providers', (rows) => rows.map((r) => ({ ...r, is_admin: true })))), 'verification_failed', /does not match the backup exactly/);
    // 8. Ledger totals in the manifest that the rows do not add up to.
    await refused(await rewrite(file, (_l, m) => { m.ledger.openBalanceCents = '1'; }), 'verification_failed', /totals differ/);
    // 9. A document whose bytes are not the ones its record describes, and a document that is missing.
    await refused(await rewrite(file, (l) => { const d = l.find((e) => e.name.startsWith('documents/')); d.content = Buffer.concat([d.content, Buffer.from('x')]); }), 'verification_failed', /document in the backup does not match/);
    await refused(await rewrite(file, (l) => { l.splice(l.findIndex((e) => e.name.startsWith('documents/')), 1); }), 'verification_failed', /missing a document/);
    // 10. No administrator who could sign in afterwards.
    await refused(await rewrite(file, (l) => editRows(l, 'users', (rows) => rows.map((r) => ({ ...r, status: 'disabled' })))), 'verification_failed', /no administrator/);

    // The untouched file still restores after all of that.
    assert.equal((await restoreArchive(target.db.pool, target.store, file, { via: 'cli' })).documents, 3);
  } finally {
    await target.drop();
    await f.drop();
  }
});

test('a backup refuses to start from an inconsistent document volume and needs storage for documents', { skip: skipDb }, async () => {
  const f = await docFixture();
  const target = await emptyTarget();
  try {
    await f.up();
    const { file } = await backupTo(f.ts.dir, f.db.pool, f.store);
    await assert.rejects(restoreArchive(target.db.pool, null, file, { via: 'cli' }), code('storage_unavailable'));
    await assert.rejects(backupTo(f.ts.dir, f.db.pool, null), code('storage_unavailable'));
    const key = (await f.db.pool.query(`select storage_key from document_versions`)).rows[0].storage_key;
    const objectPath = path.join(f.ts.dir, 'objects', key.slice(0, 2), key);
    const original = readFileSync(objectPath);
    writeFileSync(objectPath, Buffer.concat([original, Buffer.from('tampered')]));
    await assert.rejects(backupTo(f.ts.dir, f.db.pool, f.store), (e) => code('source_inconsistent')(e) && /checksum/.test(e.message));
    rmSync(objectPath);
    await assert.rejects(backupTo(f.ts.dir, f.db.pool, f.store), (e) => code('source_inconsistent')(e) && /missing/.test(e.message));
    // The snapshot is released after a failure: no transaction is left open.
    const idle = (await f.db.pool.query(`select count(*)::int n from pg_stat_activity where datname = current_database() and state = 'idle in transaction'`)).rows[0].n;
    assert.equal(idle, 0);
  } finally {
    await target.drop();
    await f.drop();
  }
});

test('a backup from an older database version is refused by the app and loaded then upgraded by the command', { skip: skipDb }, async () => {
  const old = await freshDatabase({ migrateAll: false });
  const ts = tempStore();
  const target = await emptyTarget();
  const blank = await freshDatabase({ migrateAll: false });
  const behind = await freshDatabase({ migrateAll: false });
  try {
    await migrate(old.pool, { upTo: '0010' });
    const h = (await old.pool.query(`insert into households (name) values ('Example Family') returning id`)).rows[0].id;
    const u = (await old.pool.query(`insert into users (household_id, email, display_name, role, password_hash) values ($1, 'admin@example.test', 'Alex Example', 'admin', $2) returning id`, [h, await hashPassword(PASSWORD)])).rows[0].id;
    await old.pool.query(`insert into bootstrap_state (household_id, admin_user_id) values ($1, $2)`, [h, u]);
    await old.pool.query(`insert into audit_events (household_id, actor_user_id, action, entity_type) values ($1, $2, 'bootstrap.completed', 'household')`, [h, u]);
    const { file } = await backupTo(ts.dir, old.pool, null);
    assert.equal((await verifyArchive(file)).manifest.database.migrations.at(-1).version, '0010');

    // The web restore only loads a backup of exactly its own database version.
    await assert.rejects(restoreArchive(target.db.pool, target.store, file, { via: 'setup' }), (e) => code('incompatible')(e) && /server is newer.*backup command/.test(e.message));
    await migrate(behind.pool, { upTo: '0009' });
    await assert.rejects(restoreArchive(behind.pool, null, file, { via: 'setup' }), (e) => code('incompatible')(e) && /server is older/.test(e.message));

    // The command prepares an empty database at the backup's version, loads it, then applies the newer migrations.
    const env = { ...process.env, DATABASE_URL: blank.url, TALLYMED_DOCUMENTS_DIR: '' };
    const out = await run(process.execPath, ['apps/web/cli/backup.ts', 'restore', file], { env });
    assert.match(out.stdout, /"migrationsAppliedAfterRestore": \[\s*"0011"\s*\]/);
    assert.equal((await blank.pool.query(`select max(version) v from schema_migrations`)).rows[0].v, '0011');
    assert.equal((await blank.pool.query(`select email from users`)).rows[0].email, 'admin@example.test');
    assert.equal((await blank.pool.query(`select count(*)::int n from audit_events where action = 'backup.restored'`)).rows[0].n, 1);
    const ctx = { config: testConfig({}, blank.url), pool: blank.pool };
    assert.equal((await loginJson(handlers, ctx, 'admin@example.test')).res.status, 200);
  } finally {
    await behind.drop();
    await blank.drop();
    await target.drop();
    ts.cleanup();
    await old.drop();
  }
});

// ---------- admin route ----------

const backupRequest = (body, o) => post('/api/settings/backup', body, o);
async function download(f, body = {}, o = {}) {
  const res = await handlers.handleSettingsAction(backupRequest({ currentPassword: PASSWORD, ...body }, { cookie: f.cookie, headers: { 'x-csrf-token': f.csrf }, type: 'json', ...o }), f.ctx, 'backup');
  return { res, bytes: res.status === 200 ? Buffer.from(await res.arrayBuffer()) : null };
}
const settle = async (pool, action, n = 1) => {
  for (let i = 0; i < 100; i++) {
    const rows = (await pool.query(`select action, detail, actor_user_id, entity_id from audit_events where action = $1 order by id`, [action])).rows;
    if (rows.length >= n) return rows;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no ${action} audit row`);
};

test('the backup download is admin-only, needs the password again, and is audited with the checksum of the file', { skip: skipDb }, async () => {
  resetSettingsLimitersForTests();
  resetBackupStateForTests();
  const f = await richFixture();
  const target = await emptyTarget();
  try {
    assert.ok(handlers.actionInventory().settings.includes('backup'));
    // Not signed in, wrong origin, missing CSRF token.
    assert.equal((await handlers.handleSettingsAction(backupRequest({ currentPassword: PASSWORD }, { type: 'json' }), f.ctx, 'backup')).status, 401);
    assert.equal((await download(f, {}, { origin: 'https://evil.example' })).res.status, 403);
    assert.equal((await download(f, {}, { headers: {} })).res.status, 403);
    // A Standard user is refused even with a valid session and password.
    const standard = await loginJson(handlers, f.ctx, 'standard@example.test');
    const refused = await handlers.handleSettingsAction(backupRequest({ currentPassword: PASSWORD }, { cookie: standard.cookie, headers: { 'x-csrf-token': csrfFor(standard.cookie.split('=')[1]) }, type: 'json' }), f.ctx, 'backup');
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).error.code, 'forbidden');
    // Wrong password, mismatched or short passphrase, unknown field.
    const wrong = await download(f, { currentPassword: 'not the password at all' });
    assert.equal((await wrong.res.json()).error.code, 'reauth_failed');
    assert.equal((await download(f, { passphrase: 'a long household passphrase', passphraseConfirm: 'a different passphrase' })).res.status, 400);
    assert.equal((await download(f, { passphrase: 'short', passphraseConfirm: 'short' })).res.status, 400);
    assert.equal((await download(f, { includeSecrets: 'yes' })).res.status, 400);
    assert.equal((await f.db.pool.query(`select count(*)::int n from audit_events where action like 'backup.%'`)).rows[0].n, 0);
    // A browser form post with a wrong password goes back to the page with the message.
    const form = await handlers.handleSettingsAction(post('/api/settings/backup', { currentPassword: 'nope nope nope', csrf: f.csrf }, { cookie: f.cookie, html: true }), f.ctx, 'backup');
    assert.equal(form.status, 303);
    assert.equal(form.headers.get('location'), `${ORIGIN}/settings/backup?error=reauth_failed`);
    resetSettingsLimitersForTests();

    // The download itself.
    const ok = await download(f);
    assert.equal(ok.res.status, 200);
    assert.equal(ok.res.headers.get('content-type'), 'application/octet-stream');
    assert.match(ok.res.headers.get('content-disposition'), /^attachment; filename="tallymed-backup-\d{8}T\d{6}Z\.tar\.gz"$/);
    assert.equal(ok.res.headers.get('cache-control'), 'private, no-store');
    const [started] = await settle(f.db.pool, 'backup.started');
    const [completed] = await settle(f.db.pool, 'backup.completed');
    assert.equal(started.actor_user_id, f.actor.userId);
    assert.equal(completed.entity_id, ok.res.headers.get('x-tallymed-backup-id'));
    assert.deepEqual([completed.detail.sha256, completed.detail.bytes, completed.detail.encrypted, completed.detail.documents], [sha(ok.bytes), ok.bytes.length, false, 3]);
    // Nothing secret is in the audit detail.
    assert.equal(JSON.stringify([started.detail, completed.detail]).includes(PASSWORD), false);
    const file = path.join(f.ts.dir, 'downloaded.tar.gz');
    writeFileSync(file, ok.bytes);
    // The backup's own start row is inside the snapshot or not, but its figures restore exactly either way.
    const result = await restoreArchive(target.db.pool, target.store, file, { via: 'cli' });
    assert.equal(result.ledger.openBalanceCents, (await ledgerSummary(f.db.pool)).openBalanceCents);

    // With a passphrase the file is encrypted and the passphrase is not recorded anywhere.
    const sealed = await download(f, { passphrase: 'a long household passphrase', passphraseConfirm: 'a long household passphrase' });
    assert.equal(sealed.res.status, 200);
    assert.match(sealed.res.headers.get('content-disposition'), /\.tar\.gz\.enc"$/);
    assert.equal(sealed.bytes.subarray(0, 8).toString(), 'TMBKENC1');
    const done = await settle(f.db.pool, 'backup.completed', 2);
    assert.equal(done[1].detail.encrypted, true);
    assert.equal(JSON.stringify((await f.db.pool.query(`select detail from audit_events`)).rows).includes('household passphrase'), false);

    // A cancelled download is recorded as not finished, and the next backup can start.
    const cancelled = await handlers.handleSettingsAction(backupRequest({ currentPassword: PASSWORD }, { cookie: f.cookie, headers: { 'x-csrf-token': f.csrf }, type: 'json' }), f.ctx, 'backup');
    await cancelled.body.cancel();
    const [failed] = await settle(f.db.pool, 'backup.failed');
    assert.equal(failed.detail.reason, 'download_cancelled');
    for (let i = 0; i < 50 && (await download(f)).res.status !== 200; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal((await settle(f.db.pool, 'backup.completed', 3)).length, 3);
  } finally {
    await target.drop();
    await f.drop();
  }
});

// ---------- setup restore route ----------

const enc = (s) => Buffer.from(s, 'utf8').toString('base64url');
function restoreRequest(bytes, { token = SETUP_TOKEN, passphrase, origin = ORIGIN, type = 'application/octet-stream', length } = {}) {
  const h = new Headers({ 'content-type': type });
  if (origin) h.set('origin', origin);
  if (token !== null) h.set('x-setup-token', enc(token));
  if (passphrase) h.set('x-backup-passphrase', enc(passphrase));
  if (length !== undefined) h.set('content-length', String(length));
  return new Request('http://app.internal:3000/api/setup/restore', { method: 'POST', headers: h, body: bytes, duplex: 'half' });
}

test('the setup page restores a backup only with the setup token and only into an empty installation', { skip: skipDb }, async () => {
  resetBackupStateForTests();
  resetSetupState();
  const previous = setSetupOutput(() => undefined);
  const f = await richFixture();
  const target = await emptyTarget();
  const second = await emptyTarget();
  try {
    const plain = readFileSync((await backupTo(f.ts.dir, f.db.pool, f.store)).file);
    const sealed = readFileSync((await backupTo(f.ts.dir, f.db.pool, f.store, 'a long household passphrase')).file);
    const config = testConfig({ TALLYMED_SETUP_TOKEN: SETUP_TOKEN, TALLYMED_DOCUMENTS_DIR: target.ts.dir }, target.db.url);
    const ctx = { config, pool: target.db.pool, store: target.store };
    const call = async (bytes, o) => {
      const res = await handlers.handleSetupRestore(restoreRequest(bytes, o), ctx);
      return { status: res.status, data: await res.json() };
    };
    const empty = async () => assert.equal((await tableCounts(target.db.pool)).households, 0);

    // An installation that is already set up answers 404, like the setup route.
    assert.equal((await handlers.handleSetupRestore(restoreRequest(plain), f.ctx)).status, 404);
    // Origin, media type and token checks come before the upload is read.
    assert.equal((await call(plain, { origin: 'https://evil.example' })).data.error.code, 'csrf_failed');
    assert.equal((await call(plain, { type: 'multipart/form-data; boundary=x' })).status, 415);
    assert.equal((await call(plain, { token: null })).data.error.code, 'invalid_setup_token');
    assert.equal((await call(plain, { token: 'wrong-token-wrong-token-wrong-token-1234' })).data.error.code, 'invalid_setup_token');
    await empty();
    // Size limits: declared and actual.
    const small = { ...ctx, config: { ...config, restoreMaxBytes: 1000 } };
    assert.equal((await handlers.handleSetupRestore(restoreRequest(plain, { length: plain.length }), small)).status, 413);
    assert.equal((await handlers.handleSetupRestore(restoreRequest(plain), small)).status, 413);
    // A file that is not a backup, and an encrypted one without or with the wrong passphrase.
    assert.equal((await call(Buffer.from('not a backup'))).data.error.code, 'backup_invalid');
    assert.equal((await call(sealed)).data.error.code, 'backup_passphrase');
    assert.equal((await call(sealed, { passphrase: 'not the right passphrase' })).data.error.code, 'backup_passphrase');
    await empty();
    assert.equal(await isBootstrapped(target.db.pool), false);
    assert.equal(existsSync(path.join(target.ts.dir, 'restore-tmp')) && (await import('node:fs')).readdirSync(path.join(target.ts.dir, 'restore-tmp')).length > 0, false, 'no upload is left on disk');

    // The real thing, with a passphrase that contains non-ASCII characters handled by the header encoding.
    resetSetupState();
    const ok = await call(sealed, { passphrase: 'a long household passphrase' });
    assert.equal(ok.status, 201);
    assert.equal(ok.data.documents, 3);
    assert.equal(ok.data.openBalanceCents, (await ledgerSummary(f.db.pool)).openBalanceCents);
    assert.equal(await isBootstrapped(target.db.pool), true);
    const audit = (await target.db.pool.query(`select detail, request_id from audit_events where action = 'backup.restored'`)).rows[0];
    assert.equal(audit.detail.via, 'setup');
    assert.match(audit.request_id, /^[0-9a-f-]{36}$/);
    assert.equal((await loginJson(handlers, ctx, 'admin@example.test')).res.status, 200);
    // Setup and restore are both closed afterwards, for everyone, with or without the token.
    assert.equal((await call(plain)).status, 404);
    const setup = await handlers.handleSetup(post('/api/setup', { setupToken: SETUP_TOKEN, householdName: 'Other', displayName: 'Other', email: 'other@example.test', password: PASSWORD }, { type: 'json' }), ctx);
    assert.equal(setup.status, 404);
    assert.equal((await target.db.pool.query(`select count(*)::int n from households`)).rows[0].n, 1);

    // Setting up first closes the restore path: the two can never both succeed.
    resetSetupState();
    const config2 = testConfig({ TALLYMED_SETUP_TOKEN: SETUP_TOKEN }, second.db.url);
    const ctx2 = { config: config2, pool: second.db.pool, store: second.store };
    const created = await handlers.handleSetup(post('/api/setup', { setupToken: SETUP_TOKEN, householdName: 'New Family', displayName: 'New Admin', email: 'new@example.test', password: PASSWORD }, { type: 'json' }), ctx2);
    assert.equal(created.status, 201);
    assert.equal((await handlers.handleSetupRestore(restoreRequest(plain), ctx2)).status, 404);
    await assert.rejects(restoreArchive(second.db.pool, second.store, path.join(f.ts.dir, 'x'), { via: 'setup' }), () => true);
    assert.equal((await second.db.pool.query(`select count(*)::int n from users`)).rows[0].n, 1);
  } finally {
    setSetupOutput(previous);
    resetSetupState();
    await second.drop();
    await target.drop();
    await f.drop();
  }
});

test('too many wrong setup tokens lock the restore like they lock setup', { skip: skipDb }, async () => {
  resetBackupStateForTests();
  resetSetupState();
  const previous = setSetupOutput(() => undefined);
  const target = await emptyTarget();
  try {
    const ctx = { config: testConfig({ TALLYMED_SETUP_TOKEN: SETUP_TOKEN }, target.db.url), pool: target.db.pool, store: target.store };
    const codes = [];
    for (let i = 0; i < 11; i++) codes.push((await (await handlers.handleSetupRestore(restoreRequest(Buffer.from('x'), { token: `wrong-token-${i}-wrong-token-wrong-token` }), ctx)).json()).error.code);
    assert.deepEqual([...new Set(codes.slice(0, 10))], ['invalid_setup_token']);
    assert.equal(codes[10], 'rate_limited');
    // The right token is refused too while the budget is spent.
    assert.equal((await handlers.handleSetupRestore(restoreRequest(Buffer.from('x')), ctx)).status, 429);
  } finally {
    setSetupOutput(previous);
    resetSetupState();
    await target.drop();
  }
});

// ---------- command line ----------

test('the backup command creates, verifies and restores, and reports a damaged file', { skip: skipDb }, async () => {
  const f = await richFixture();
  const target = await emptyTarget();
  const work = mkdtempSync(path.join(tmpdir(), 'tallymed-backup-cli-'));
  const cli = (args, env) => run(process.execPath, ['apps/web/cli/backup.ts', ...args], { env: { ...process.env, TALLYMED_BACKUP_PASSPHRASE: '', ...env } });
  try {
    const source = { DATABASE_URL: f.db.url, TALLYMED_DOCUMENTS_DIR: f.ts.dir };
    const file = path.join(work, 'backup.tar.gz');
    const created = JSON.parse((await cli(['create', file], source)).stdout);
    assert.deepEqual([created.ok, created.verified, created.documents, created.sha256], [true, true, 3, sha(readFileSync(file))]);
    assert.equal((await f.db.pool.query(`select detail from audit_events where action = 'backup.completed'`)).rows[0].detail.via, 'cli');
    // An existing file is never overwritten, and it is left as it was.
    await assert.rejects(cli(['create', file], source), (e) => e.code === 1 && /EEXIST|exists/.test(e.stderr));
    assert.equal(sha(readFileSync(file)), created.sha256);

    const verified = JSON.parse((await cli(['verify', file], {})).stdout);
    assert.equal(verified.ok, true);
    assert.equal(verified.databaseVersion, '0011');
    assert.equal(verified.ledger.openBalanceCents, (await ledgerSummary(f.db.pool)).openBalanceCents);
    assert.equal(JSON.stringify(verified).includes('example.test'), false, 'verify prints counts and checksums, not records');
    const damaged = path.join(work, 'damaged.tar.gz');
    const bytes = Buffer.from(readFileSync(file));
    bytes[bytes.length - 300] ^= 0xff;
    writeFileSync(damaged, bytes);
    await assert.rejects(cli(['verify', damaged], {}), (e) => e.code === 1 && /Backup verify failed/.test(e.stderr));
    await assert.rejects(cli(['verify'], {}), (e) => e.code === 2);

    const sealedFile = path.join(work, 'sealed.tar.gz.enc');
    await cli(['create', sealedFile], { ...source, TALLYMED_BACKUP_PASSPHRASE: 'a long household passphrase' });
    await assert.rejects(cli(['verify', sealedFile], {}), (e) => e.code === 1 && /encrypted/.test(e.stderr));
    await assert.rejects(cli(['create', path.join(work, 'weak.enc')], { ...source, TALLYMED_BACKUP_PASSPHRASE: 'short' }), (e) => e.code === 1);
    assert.equal(existsSync(path.join(work, 'weak.enc')), false);

    const destination = { DATABASE_URL: target.db.url, TALLYMED_DOCUMENTS_DIR: target.ts.dir, TALLYMED_BACKUP_PASSPHRASE: 'a long household passphrase' };
    const restored = await cli(['restore', sealedFile], destination);
    assert.match(restored.stdout, /Restore complete and verified/);
    const report = await verifyStorage(target.db.pool, target.store);
    assert.deepEqual([report.checked, report.ok], [3, 3]);
    // The second backup saw the first backup's audit row; everything else is the same ledger.
    assert.deepEqual({ ...(await ledgerSummary(target.db.pool)), auditEvents: null }, { ...(await ledgerSummary(f.db.pool)), auditEvents: null });
    await assert.rejects(cli(['restore', sealedFile], destination), (e) => e.code === 1 && /already holds data/.test(e.stderr));
  } finally {
    rmSync(work, { recursive: true, force: true });
    await target.drop();
    await f.drop();
  }
});

test('the ledger checks name the rule a database breaks', { skip: skipDb }, async () => {
  const f = await richFixture();
  try {
    assert.deepEqual(await ledgerViolations(f.db.pool), []);
    // Break two rules behind the guards' back (the triggers are switched off only for this test's statements).
    const c = await f.db.pool.connect();
    try {
      await c.query('begin');
      await c.query('alter table payment_entries disable trigger user');
      await c.query('alter table plan_installments disable trigger user');
      await c.query(`update payment_entries set amount_cents = amount_cents * 100 where kind = 'allocation' and bill_id = $1`, [f.bills.a.id]);
      await c.query(`update plan_installments set amount_cents = amount_cents + 7 where id = (select id from plan_installments order by id limit 1)`);
      const broken = await ledgerViolations(c);
      assert.ok(broken.some((b) => /applied cash plus refunds never exceed a payment \(1 record\)/.test(b)), broken.join('\n'));
      assert.ok(broken.some((b) => /installments that add up to its total/.test(b)), broken.join('\n'));
      assert.equal(broken.join(' ').includes(f.bills.a.id), false, 'the report names rules and counts, not records');
      await c.query('rollback');
    } finally {
      c.release();
    }
  } finally {
    await f.drop();
  }
});

