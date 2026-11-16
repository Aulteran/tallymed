// Database layer of administrator removal (with undo) of HSA decisions, claims and receipts (migration 0020): the removal events, the live views,
// the commit-time guards, claim references among live claims, the backup and the upgrade. Exercised with raw SQL and the existing services;
// the removal services themselves are tested elsewhere. Real PostgreSQL, fabricated data only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import test from 'node:test';
import { createBackup, restoreArchive, verifyArchive } from '../../apps/web/server/backup/engine.ts';
import { ledgerSummary, ledgerViolations } from '../../apps/web/server/backup/ledger.ts';
import { BACKUP_TABLES, tablesAt } from '../../apps/web/server/backup/tables.ts';
import { migrate } from '../../apps/web/server/migrate.ts';
import * as hsaRepo from '../../apps/web/server/repositories/hsa.ts';
import * as payRepo from '../../apps/web/server/repositories/payments.ts';
import * as hsa from '../../apps/web/server/services/hsa.ts';
import * as pay from '../../apps/web/server/services/payments.ts';
import { tempStore } from './document-helpers.mjs';
import { freshDatabase, skipDb } from './helpers.mjs';
import { setup } from './money-helpers.mjs';

const code = (c) => ({ code: c });
const one = async (pool, sql, params = []) => (await pool.query(sql, params)).rows[0];
const inTx = async (pool, fn) => {
  const c = await pool.connect();
  try { await c.query('begin'); const r = await fn(c); await c.query('commit'); return r; } catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
};

/** A removal or restore event for one record; several events in one transaction commit together. */
const event = (t, client, kind, id, action, userId = t.actor.userId, householdId = t.actor.householdId) => client.query(
  `insert into hsa_removal_events (household_id, kind, record_id, action, reason, created_by) values ($1, $2, $3, $4, 'Fabricated test', $5)`,
  [householdId, kind, id, action, userId]);
const act = (t, kind, id, action) => inTx(t.db.pool, (c) => event(t, c, kind, id, action));
const remove = (t, kind, id) => act(t, kind, id, 'remove');
const restore = (t, kind, id) => act(t, kind, id, 'restore');
const status = (t, alloc) => one(t.db.pool, `select * from hsa_allocation_status where allocation_id = $1`, [alloc]);
const figs = (r) => [r.ceiling_cents, r.pending_cents, r.received_cents, r.available_cents, r.needs_review_cents].map(String);
const eventCount = async (t) => (await one(t.db.pool, `select count(*)::int n from hsa_removal_events`)).n;

/** A fixture: a member, a provider and helpers that build allocations, decisions, claims and receipts through the services. */
async function fixture() {
  const t = await setup();
  const m = await t.member();
  const p = await t.provider();
  const pool = t.db.pool;
  const actor = t.actor;
  return {
    ...t, m, p,
    async alloc({ bill = '200.00', paid = '100.00', paidOn = '2026-04-01' } = {}) {
      const b = await t.bill({ memberId: m, providerId: p, originalAmount: bill });
      const pm = await t.pay1({ amount: paid, paidOn, billId: b.id });
      const [a] = (await t.payment(pm.id)).allocations;
      return { bill: b, payment: pm, allocationId: a.allocationId, paymentId: pm.id };
    },
    async decide(allocationId, status, amount, o = {}) {
      const cur = await hsaRepo.getAllocation(pool, actor.householdId, allocationId);
      return hsa.recordDecision(pool, actor, {
        idempotencyKey: t.key(), allocationId, version: String(cur.decisionCount), status, ...(amount ? { eligibleAmount: amount } : {}),
        rationale: 'Qualified medical expense per plan rules', evidenceType: 'receipt', evidenceNote: 'Pharmacy receipt on file', decidedOn: '2026-04-05', ...o,
      }, 'r');
    },
    claim: (lines, o = {}) => hsa.submitClaim(pool, actor, { idempotencyKey: t.key(), submittedOn: '2026-04-10', administrator: 'Example HSA Bank', lines, ...o }, 'r'),
    line: async (claimId, n = 0) => (await hsaRepo.linesOfClaim(pool, actor.householdId, claimId))[n],
    receipt: (lines, o = {}) => hsa.recordReceipt(pool, actor, { idempotencyKey: t.key(), receivedOn: '2026-04-20', source: 'administrator_transfer', lines, ...o }, 'r'),
    external: (lines, o = {}) => hsa.recordExternalReceipt(pool, actor, {
      idempotencyKey: t.key(), receivedOn: '2026-04-21', source: 'hsa_debit_card', evidenceType: 'statement', evidenceNote: 'Card statement line', lines, ...o,
    }, 'r'),
  };
}

// ---------- the upgrade ----------

/** A populated 0018 database built with real inserts: every kind of HSA row, a direct HSA payment, a refund that causes needs-review. */
async function populate0018(db) {
  const q = async (sql, p = []) => (await db.pool.query(sql, p)).rows[0];
  const h = (await q(`insert into households (name) values ('Example Family') returning id`)).id;
  const u = (await q(`insert into users (household_id, email, display_name, role, password_hash) values ($1, 'a@example.test', 'Alex Example', 'admin', 'x') returning id`, [h])).id;
  const mem = (await q(`insert into family_members (household_id, name, created_by) values ($1, 'Pat Example', $2) returning id`, [h, u])).id;
  const pr = (await q(`insert into providers (household_id, name, kind, created_by) values ($1, 'Example Clinic', 'clinician', $2) returning id`, [h, u])).id;
  const mkBill = (cents, date) => q(
    `insert into bills (household_id, member_id, provider_id, statement_date, original_cents, base_responsibility_cents, amount_status, amount_source, member_name_snapshot, provider_name_snapshot, confirmed_at, confirmed_by, created_by)
     values ($1, $2, $3, $4, $5, $5, 'confirmed', 'statement', 'Pat Example', 'Example Clinic', now(), $6, $6) returning id`, [h, mem, pr, date, cents, u]).then((r) => r.id);
  const [billA, billC, billD] = [await mkBill(30000, '2026-01-02'), await mkBill(10000, '2026-01-03'), await mkBill(20000, '2026-01-04')];
  const acct = (await q(`insert into hsa_accounts (household_id, name, administrator, created_by) values ($1, 'Family HSA', 'Example HSA Bank', $2) returning id`, [h, u])).id;
  const mkPay = (cents, date) => q(`insert into payments (household_id, paid_on, amount_cents, method, created_by) values ($1, $2, $3, 'card', $4) returning id`, [h, date, cents, u]).then((r) => r.id);
  const allocate = async (payment, bill, cents, date) => {
    const id = randomUUID();
    await q(`insert into payment_entries (id, household_id, payment_id, event_id, kind, bill_id, allocation_id, amount_cents, effective_date, created_by) values ($1, $2, $3, $4, 'allocation', $5, $1, $6, $7, $8)`, [id, h, payment, randomUUID(), bill, cents, date, u]);
    return id;
  };
  const refund = (payment, bill, alloc, cents) => q(
    `insert into payment_entries (id, household_id, payment_id, event_id, kind, bill_id, allocation_id, amount_cents, effective_date, reason, created_by) values (gen_random_uuid(), $1, $2, gen_random_uuid(), 'refund', $3, $4, $5, '2026-05-01', 'Provider refund', $6)`,
    [h, payment, bill, alloc, -cents, u]);
  const decision = (payment, alloc, bill, status, cents, date) => q(
    `insert into hsa_eligibility_decisions (id, household_id, payment_id, allocation_id, bill_id, status, eligible_cents, rationale, evidence_type, evidence_note, decided_on, created_by)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'Qualified expense', $7, $8, $9, $10) returning id`,
    [h, payment, alloc, bill, status, cents, status === 'pending' ? null : 'eob', status === 'pending' ? null : 'EOB 1', date, u]).then((r) => r.id);
  const claimWithLine = async (payment, alloc, bill, cents, reference, date) => {
    const claim = randomUUID(); const line = randomUUID();
    await inTx(db.pool, async (c) => {
      await c.query(`insert into hsa_claims (id, household_id, submitted_on, administrator, reference, created_by) values ($1, $2, $3, 'Example HSA Bank', $4, $5)`, [claim, h, date, reference, u]);
      await c.query(`insert into hsa_entries (id, household_id, payment_id, allocation_id, bill_id, event_id, kind, claim_id, line_id, amount_cents, effective_date, created_by)
                     values ($1, $2, $3, $4, $5, gen_random_uuid(), 'reserve', $6, $1, $7, $8, $9)`, [line, h, payment, alloc, bill, claim, cents, date, u]);
    });
    return { claim, line };
  };
  const claimReceipt = async (payment, alloc, bill, claim, line, cents, date) => {
    const receipt = randomUUID();
    await inTx(db.pool, async (c) => {
      await c.query(`insert into hsa_receipts (id, household_id, received_on, amount_cents, origin, source, created_by) values ($1, $2, $3, $4, 'claim', 'administrator_transfer', $5)`, [receipt, h, date, cents, u]);
      await c.query(`insert into hsa_entries (id, household_id, payment_id, allocation_id, bill_id, event_id, kind, claim_id, line_id, receipt_id, amount_cents, effective_date, created_by)
                     values (gen_random_uuid(), $1, $2, $3, $4, gen_random_uuid(), 'receipt', $5, $6, $7, $8, $9, $10)`, [h, payment, alloc, bill, claim, line, receipt, cents, date, u]);
    });
    return receipt;
  };
  // P1: 150.00 paid, 120.00 applied to bill A, 20.00 refunded; a pending then an eligible decision (80.00), a 50.00 claim and a 20.00 partial receipt.
  const p1 = await mkPay(15000, '2026-04-01');
  const al1 = await allocate(p1, billA, 12000, '2026-04-01');
  await refund(p1, billA, al1, 2000);
  await decision(p1, al1, billA, 'pending', 0, '2026-05-01');
  const d1 = await decision(p1, al1, billA, 'eligible', 8000, '2026-05-02');
  const c1 = await claimWithLine(p1, al1, billA, 5000, 'EX-100', '2026-05-03');
  const r1 = await claimReceipt(p1, al1, billA, c1.claim, c1.line, 2000, '2026-05-10');
  // P2: 60.00 paid directly from the HSA.
  const p2 = await mkPay(6000, '2026-04-02');
  await q(`insert into payment_hsa_funding (payment_id, household_id, hsa_account_id, created_by) values ($1, $2, $3, $4)`, [p2, h, acct, u]);
  await allocate(p2, billC, 6000, '2026-04-02');
  // P4: 200.00 paid to bill D, a 100.00 decision, a 60.00 claim fully received, a 30.00 external receipt, then a 150.00 refund: needs review.
  const p4 = await mkPay(20000, '2026-04-04');
  const al4 = await allocate(p4, billD, 20000, '2026-04-04');
  const d4 = await decision(p4, al4, billD, 'eligible', 10000, '2026-05-04');
  const c2 = await claimWithLine(p4, al4, billD, 6000, 'EX-200', '2026-05-05');
  const r2 = await claimReceipt(p4, al4, billD, c2.claim, c2.line, 6000, '2026-05-12');
  const r3 = randomUUID();
  await inTx(db.pool, async (c) => {
    await c.query(`insert into hsa_receipts (id, household_id, received_on, amount_cents, origin, source, evidence_type, evidence_note, created_by) values ($1, $2, '2026-05-15', 3000, 'external', 'hsa_debit_card', 'statement', 'Card statement line', $3)`, [r3, h, u]);
    await c.query(`insert into hsa_entries (id, household_id, payment_id, allocation_id, bill_id, event_id, kind, receipt_id, amount_cents, effective_date, created_by)
                   values (gen_random_uuid(), $1, $2, $3, $4, gen_random_uuid(), 'external_receipt', $5, 3000, '2026-05-15', $6)`, [h, p4, al4, billD, r3, u]);
  });
  await refund(p4, billD, al4, 15000);
  return { h, u, p1, p2, p4, al1, al4, d1, d4, c1, c2, r1, r2, r3 };
}

const allStatus = (pool) => pool.query(`select * from hsa_allocation_status order by allocation_id`).then((r) => r.rows);

test('upgrade: a database populated at 0018 (decisions, a claim, a partial and an external receipt, a direct HSA payment, a refund that needs review) reports the same figures at 0019', { skip: skipDb }, async () => {
  const db = await freshDatabase({ migrateAll: false });
  try {
    await migrate(db.pool, { upTo: '0018' });
    const x = await populate0018(db);
    assert.deepEqual(await ledgerViolations(db.pool), [], 'the fabricated 0018 data is itself consistent');
    const before = { status: await allStatus(db.pool), ledger: await ledgerSummary(db.pool), counts: {} };
    for (const n of ['hsa_eligibility_decisions', 'hsa_claims', 'hsa_receipts', 'hsa_entries']) before.counts[n] = (await one(db.pool, `select count(*)::int n from ${n}`)).n;
    // The data really is populated: every state is there.
    assert.equal(before.status.length, 3);
    const byAlloc = new Map(before.status.map((r) => [r.allocation_id, r]));
    assert.deepEqual(figs(byAlloc.get(x.al1)), ['8000', '3000', '2000', '3000', '0']);
    assert.equal(byAlloc.get(x.al1).decision_count, 2);
    assert.equal(byAlloc.get(x.al4).needs_review_cents, '4000', 'a refund pushed received above the ceiling');
    assert.equal(before.status.filter((r) => r.direct_hsa).length, 1);
    assert.deepEqual(before.counts, { hsa_eligibility_decisions: 3, hsa_claims: 2, hsa_receipts: 3, hsa_entries: 5 });

    assert.deepEqual(await migrate(db.pool), ['0019', '0020']);
    const after = { status: await allStatus(db.pool), ledger: await ledgerSummary(db.pool) };
    assert.equal(after.ledger.removedHsaRecords, '0');
    delete after.ledger.removedHsaRecords;
    assert.deepEqual(after.status, before.status, 'every hsa_allocation_status row is identical, column for column');
    assert.deepEqual(after.ledger, before.ledger, 'ledgerSummary is identical');
    assert.deepEqual(await ledgerViolations(db.pool), []);
    // The live views equal the base tables while nothing is removed.
    assert.equal((await one(db.pool, `select count(*)::int n from hsa_live_entries`)).n, before.counts.hsa_entries);
    assert.equal((await one(db.pool, `select count(*)::int n from hsa_live_decisions`)).n, before.counts.hsa_eligibility_decisions);
    assert.deepEqual((await db.pool.query(`select * from hsa_live_entries order by seq`)).rows, (await db.pool.query(`select * from hsa_entries order by seq`)).rows);

    // The application's own readers agree with the figures taken before the upgrade.
    const actor = { userId: x.u, householdId: x.h, role: 'admin', displayName: 'Alex Example', sessionId: randomUUID(), mustChangePassword: false };
    const sums = (k) => before.status.reduce((a, r) => a + BigInt(r[k]), 0n).toString();
    const totals = await hsa.hsaSummary(db.pool, actor, {});
    assert.deepEqual([totals.eligibleCents, totals.pendingCents, totals.receivedCents, totals.availableCents, totals.needsReviewCents],
      [sums('ceiling_cents'), sums('pending_cents'), sums('received_cents'), sums('available_cents'), sums('needs_review_cents')]);
    assert.equal((await hsaRepo.listDecisions(db.pool, x.h, x.al1)).length, 2);
    assert.equal((await hsaRepo.listClaims(db.pool, x.h, { limit: 10 })).items.length, 2);
    assert.equal((await hsaRepo.listReceipts(db.pool, x.h, { limit: 10 })).items.length, 3);
    assert.equal((await hsaRepo.getClaim(db.pool, x.h, x.c1.claim)).pendingCents, '3000');
    // Removal events are empty and the old payment-removal blockers are unchanged (HSA records block removing a payment).
    assert.equal(await eventCount({ db }), 0);
    assert.deepEqual(await payRepo.removalBlockers(db.pool, x.h, x.p1), { refunds: true, hsa: true });
  } finally { await db.drop(); }
});

// ---------- events ----------

test('removal events are immutable, alternate per record, name a record of their household and are indexed for the newest-first read', { skip: skipDb }, async () => {
  const t = await fixture();
  try {
    const a = await t.alloc();
    const d = await t.decide(a.allocationId, 'eligible', '60.00');
    const c = await t.claim([{ allocationId: a.allocationId, amount: '20.00' }]);
    assert.equal((await one(t.db.pool, `select hsa_record_removed('decision', $1) as v`, [d.id])).v, false);
    await remove(t, 'decision', d.id).then(() => assert.fail('a decision supporting pending cash must not be removable'), (e) => assert.match(e.message, /increase the excess above the eligible ceiling/));
    // Alternation: a restore of a live record and a second removal are refused, and nothing is left behind.
    await assert.rejects(restore(t, 'claim', c.id), /is not removed/);
    await remove(t, 'claim', c.id);
    assert.equal((await one(t.db.pool, `select hsa_record_removed('claim', $1) as v`, [c.id])).v, true);
    await assert.rejects(remove(t, 'claim', c.id), /already removed/);
    // A record is judged by its kind: the same id under another kind is unknown.
    await assert.rejects(remove(t, 'receipt', c.id), /unknown HSA record/);
    // Another household's record is unknown to this household's event.
    const other = (await one(t.db.pool, `insert into households (name) values ('Other Family') returning id`)).id;
    await assert.rejects(inTx(t.db.pool, (cl) => event(t, cl, 'claim', c.id, 'restore', t.actor.userId, other)), /unknown HSA record/);
    await restore(t, 'claim', c.id);
    assert.deepEqual((await t.db.pool.query(`select action from hsa_removal_events where record_id = $1 order by seq`, [c.id])).rows.map((r) => r.action), ['remove', 'restore']);
    assert.equal(await eventCount(t), 2);
    for (const sql of [`update hsa_removal_events set reason = 'x'`, `delete from hsa_removal_events`, `truncate hsa_removal_events`]) {
      await assert.rejects(t.db.pool.query(sql), /append-only|immutable|cannot/i, sql);
    }
    // Bad shapes are refused by the table's own checks.
    await assert.rejects(t.db.pool.query(`insert into hsa_removal_events (household_id, kind, record_id, action, created_by) values ($1, 'entry', $2, 'remove', $3)`, [t.actor.householdId, c.id, t.actor.userId]), /unknown HSA record|hsa_removal_events_kind_check/);
    await assert.rejects(t.db.pool.query(`insert into hsa_removal_events (household_id, kind, record_id, action, reason, created_by) values ($1, 'claim', $2, 'remove', $3, $4)`, [t.actor.householdId, c.id, 'x'.repeat(501), t.actor.userId]), /hsa_removal_events_reason_check/);
    assert.ok((await one(t.db.pool, `select count(*)::int n from pg_indexes where tablename = 'hsa_removal_events' and indexdef like '%(household_id, kind, record_id, seq DESC)%'`)).n === 1);
  } finally { await t.db.drop(); }
});

// ---------- guards: leaf-first, ceiling, line open ----------

test('a receipt can be removed and restored: figures return exactly, lists and totals follow, and a reversed receipt goes with its reversal', { skip: skipDb }, async () => {
  const t = await fixture();
  try {
    const a = await t.alloc();
    await t.decide(a.allocationId, 'eligible', '80.00');
    const c = await t.claim([{ allocationId: a.allocationId, amount: '50.00' }]);
    const line = await t.line(c.id);
    const r = await t.receipt([{ lineId: line.lineId, amount: '20.00' }]);
    const ext = await t.external([{ allocationId: a.allocationId, amount: '10.00' }]);
    const before = await status(t, a.allocationId);
    assert.deepEqual(figs(before), ['8000', '3000', '3000', '2000', '0']);
    const entriesBefore = (await t.db.pool.query(`select * from hsa_live_entries order by seq`)).rows;

    await remove(t, 'receipt', r.id);
    assert.deepEqual(figs(await status(t, a.allocationId)), ['8000', '5000', '1000', '2000', '0'], 'the claim line returns to pending; received falls');
    assert.equal((await hsaRepo.getClaim(t.db.pool, t.actor.householdId, c.id)).pendingCents, '5000');
    assert.equal(await hsaRepo.getReceipt(t.db.pool, t.actor.householdId, r.id), null);
    assert.deepEqual((await hsaRepo.listReceipts(t.db.pool, t.actor.householdId, { limit: 10 })).items.map((x) => x.id), [ext.id]);
    assert.equal((await hsaRepo.linesOfClaim(t.db.pool, t.actor.householdId, c.id))[0].pendingCents, '5000');
    assert.equal((await hsaRepo.listEntriesOfAllocation(t.db.pool, t.actor.householdId, a.allocationId)).filter((e) => e.receiptId === r.id).length, 0);
    const totals = await hsa.hsaSummary(t.db.pool, t.actor, {});
    assert.deepEqual([totals.pendingCents, totals.receivedCents], ['5000', '1000']);
    assert.equal((await ledgerSummary(t.db.pool)).removedHsaRecords, '1');
    assert.deepEqual(await ledgerViolations(t.db.pool), []);
    // The rows themselves were never touched.
    assert.equal((await one(t.db.pool, `select count(*)::int n from hsa_entries where receipt_id = $1`, [r.id])).n, 1);

    await restore(t, 'receipt', r.id);
    assert.deepEqual(await status(t, a.allocationId), before, 'an exact inverse');
    assert.deepEqual((await t.db.pool.query(`select * from hsa_live_entries order by seq`)).rows, entriesBefore);
    assert.equal((await ledgerSummary(t.db.pool)).removedHsaRecords, '0');

    // A reversed receipt: its reversal entry has the same receipt id, so both leave and return together.
    await hsa.reverseReceipt(t.db.pool, t.actor, { idempotencyKey: t.key(), receiptId: r.id, effectiveDate: '2026-05-02', reason: 'Returned by the bank' }, 'r');
    const reversed = await status(t, a.allocationId);
    assert.deepEqual(figs(reversed), ['8000', '3000', '1000', '4000', '0'], 'a reversal lowers received but does not return the line to pending');
    await remove(t, 'receipt', r.id);
    assert.deepEqual(figs(await status(t, a.allocationId)), ['8000', '5000', '1000', '2000', '0'], 'removing the reversed receipt and its reversal returns the line to pending');
    assert.equal((await one(t.db.pool, `select count(*)::int n from hsa_live_entries where receipt_id = $1`, [r.id])).n, 0);
    await restore(t, 'receipt', r.id);
    assert.deepEqual(await status(t, a.allocationId), reversed);
    // An external receipt leaves and returns the same way.
    await remove(t, 'receipt', ext.id);
    assert.deepEqual(figs(await status(t, a.allocationId)), ['8000', '3000', '0', '5000', '0']);
    await restore(t, 'receipt', ext.id);
    assert.deepEqual(await status(t, a.allocationId), reversed);
  } finally { await t.db.drop(); }
});

test('leaf-first: a claim with a live receipt cannot be removed; receipt, then claim, then decision; restores in the other order', { skip: skipDb }, async () => {
  const t = await fixture();
  try {
    const a = await t.alloc();
    const d = await t.decide(a.allocationId, 'eligible', '80.00');
    const c = await t.claim([{ allocationId: a.allocationId, amount: '50.00' }], { reference: 'REF-LEAF' });
    const r = await t.receipt([{ lineId: (await t.line(c.id)).lineId, amount: '20.00' }]);
    const before = await status(t, a.allocationId);

    await assert.rejects(remove(t, 'claim', c.id), /live reimbursement cannot be removed/);
    assert.equal(await eventCount(t), 0, 'a refused removal leaves no event');
    await assert.rejects(remove(t, 'decision', d.id), /increase the excess above the eligible ceiling/);

    await remove(t, 'receipt', r.id);
    await remove(t, 'claim', c.id);
    assert.deepEqual(figs(await status(t, a.allocationId)), ['8000', '0', '0', '8000', '0'], 'the allocation is available again');
    assert.equal(await hsaRepo.getClaim(t.db.pool, t.actor.householdId, c.id), null);
    assert.deepEqual((await hsaRepo.listClaims(t.db.pool, t.actor.householdId, { limit: 10 })).items, []);
    assert.deepEqual(await hsaRepo.linesOfAllocation(t.db.pool, t.actor.householdId, a.allocationId), []);
    assert.equal((await one(t.db.pool, `select count(*)::int n from hsa_live_entries`)).n, 0);
    await remove(t, 'decision', d.id);
    assert.deepEqual(figs(await status(t, a.allocationId)), ['0', '0', '0', '0', '0']);
    assert.equal((await status(t, a.allocationId)).decision_count, 0);
    assert.equal((await status(t, a.allocationId)).decision_id, null);
    assert.deepEqual(await hsaRepo.listDecisions(t.db.pool, t.actor.householdId, a.allocationId), []);
    assert.equal((await ledgerSummary(t.db.pool)).removedHsaRecords, '3');
    assert.deepEqual(await ledgerViolations(t.db.pool), []);
    // With every HSA record removed the allocation has no HSA history, and the payment can be removed.
    assert.deepEqual(await payRepo.removalBlockers(t.db.pool, t.actor.householdId, a.paymentId), { refunds: false, hsa: false });

    // Restoring: the receipt cannot come back before its claim, and the claim needs a live decision to stay under the ceiling.
    await assert.rejects(restore(t, 'receipt', r.id), /while its claim is removed/);
    await assert.rejects(restore(t, 'claim', c.id), /exceed the eligible ceiling/);
    await restore(t, 'decision', d.id);
    await restore(t, 'claim', c.id);
    await restore(t, 'receipt', r.id);
    assert.deepEqual(await status(t, a.allocationId), before, 'exact inverse after all three restores');
    assert.equal((await ledgerSummary(t.db.pool)).removedHsaRecords, '0');
    assert.deepEqual(await ledgerViolations(t.db.pool), []);
  } finally { await t.db.drop(); }
});

test('removing a decision that supports cash is refused, and restoring a decision above what is pending is refused (ceiling)', { skip: skipDb }, async () => {
  const t = await fixture();
  try {
    const a = await t.alloc();
    const d1 = await t.decide(a.allocationId, 'eligible', '100.00');
    const d2 = await t.decide(a.allocationId, 'eligible', '80.00');
    assert.equal((await status(t, a.allocationId)).decision_id, d2.id);
    // Removing the current decision falls back to the earlier one: nothing pending, so it is allowed.
    await remove(t, 'decision', d2.id);
    assert.deepEqual(figs(await status(t, a.allocationId)), ['10000', '0', '0', '10000', '0']);
    assert.equal((await status(t, a.allocationId)).decision_count, 1);
    const c = await t.claim([{ allocationId: a.allocationId, amount: '90.00' }]);
    // The restore would put the ceiling at 80.00 below the 90.00 pending.
    await assert.rejects(restore(t, 'decision', d2.id), /exceed the eligible ceiling \(allocation [0-9a-f-]+, ceiling 8000, pending 9000, received 0\)/);
    // Removing the only decision that supports the pending cash is refused as well.
    await assert.rejects(remove(t, 'decision', d1.id), /increase the excess above the eligible ceiling \(allocation [0-9a-f-]+, ceiling 0, pending 9000/);
    await remove(t, 'claim', c.id);
    await restore(t, 'decision', d2.id);
    assert.deepEqual(figs(await status(t, a.allocationId)), ['8000', '0', '0', '8000', '0']);
    // A removed decision is not the current one even when it is the newest by time; a removed older decision leaves the newer one current.
    await remove(t, 'decision', d1.id);
    assert.equal((await status(t, a.allocationId)).decision_id, d2.id);
    assert.deepEqual(await ledgerViolations(t.db.pool), []);
  } finally { await t.db.drop(); }
});

test('a restore that would take a claim line below zero (line open < 0) or pending below zero is refused', { skip: skipDb }, async () => {
  const t = await fixture();
  try {
    const a = await t.alloc();
    await t.decide(a.allocationId, 'eligible', '100.00');
    const c1 = await t.claim([{ allocationId: a.allocationId, amount: '50.00' }]);
    const c2 = await t.claim([{ allocationId: a.allocationId, amount: '50.00' }]);
    const line1 = await t.line(c1.id);
    const r1 = await t.receipt([{ lineId: line1.lineId, amount: '20.00' }]);
    await remove(t, 'receipt', r1.id);
    // The line takes the whole 50.00 through another receipt; the allocation as a whole still has pending cash (the second claim).
    const r2 = await t.receipt([{ lineId: line1.lineId, amount: '50.00' }]);
    assert.deepEqual(figs(await status(t, a.allocationId)), ['10000', '5000', '5000', '0', '0']);
    await assert.rejects(restore(t, 'receipt', r1.id), /cannot be paid or released beyond its reservation/);
    // With nothing else pending the same restore trips the pending-below-zero rule first.
    await remove(t, 'claim', c2.id);
    await assert.rejects(restore(t, 'receipt', r1.id), /below zero/);
    assert.equal(await eventCount(t), 2);
    assert.ok(r2.id);
    assert.deepEqual(await ledgerViolations(t.db.pool), []);
  } finally { await t.db.drop(); }
});

// ---------- restore refused by the payment ----------

test('restore is refused on a removed, a voided and a direct-HSA payment; removing the payment works once its HSA records are removed', { skip: skipDb }, async () => {
  const t = await fixture();
  try {
    // Removed payment.
    const a = await t.alloc();
    const d = await t.decide(a.allocationId, 'eligible', '60.00');
    const c = await t.claim([{ allocationId: a.allocationId, amount: '20.00' }]);
    const r = await t.receipt([{ lineId: (await t.line(c.id)).lineId, amount: '5.00' }]);
    await assert.rejects(pay.removePayment(t.db.pool, t.actor, { idempotencyKey: t.key(), paymentId: a.paymentId, reason: 'Fabricated' }, 'r'), code('conflict'));
    for (const [kind, id] of [['receipt', r.id], ['claim', c.id], ['decision', d.id]]) await remove(t, kind, id);
    await pay.removePayment(t.db.pool, t.actor, { idempotencyKey: t.key(), paymentId: a.paymentId, reason: 'Fabricated duplicate' }, 'r');
    for (const [kind, id] of [['decision', d.id], ['claim', c.id], ['receipt', r.id]]) await assert.rejects(restore(t, kind, id), /the payment is removed/);
    assert.deepEqual(await ledgerViolations(t.db.pool), []);

    // Voided payment (no applied cash).
    const b = await t.bill({ memberId: t.m, providerId: t.p, originalAmount: '100.00' });
    const pm = await t.pay1({ amount: '40.00', billId: b.id });
    const al = (await t.payment(pm.id)).allocations[0].allocationId;
    const d2 = await t.decide(al, 'eligible', '40.00');
    await remove(t, 'decision', d2.id);
    // Reverse the allocation through the ledger, then void the payment.
    await t.db.pool.query(
      `insert into payment_entries (id, household_id, payment_id, event_id, kind, bill_id, allocation_id, amount_cents, effective_date, reason, created_by)
       select gen_random_uuid(), $1, $2, gen_random_uuid(), 'allocation_reversal', bill_id, id, -(select sum(x.amount_cents) from payment_entries x where x.allocation_id = a.id), '2026-04-05', 'Fabricated', $3
         from payment_entries a where a.payment_id = $2 and a.kind = 'allocation'
          and (select sum(x.amount_cents) from payment_entries x where x.allocation_id = a.id) > 0`, [t.actor.householdId, pm.id, t.actor.userId]);
    await pay.voidPayment(t.db.pool, t.actor, { idempotencyKey: t.key(), paymentId: pm.id, voidedOn: '2026-04-06', reason: 'Fabricated' }, 'r');
    await assert.rejects(restore(t, 'decision', d2.id), /the payment is voided/);

    // Paid directly from an HSA after the decision was removed: allowed (removed records are absent), and then the restore is refused.
    const acct = (await one(t.db.pool, `insert into hsa_accounts (household_id, name, administrator, created_by) values ($1, 'Family HSA', 'Example HSA Bank', $2) returning id`, [t.actor.householdId, t.actor.userId])).id;
    const e = await t.alloc();
    const d3 = await t.decide(e.allocationId, 'eligible', '30.00');
    const fund = () => t.db.pool.query(`insert into payment_hsa_funding (payment_id, household_id, hsa_account_id, created_by) values ($1, $2, $3, $4)`, [e.paymentId, t.actor.householdId, acct, t.actor.userId]);
    await assert.rejects(fund(), /already has HSA claims or decisions/);
    await remove(t, 'decision', d3.id);
    await fund();
    await assert.rejects(restore(t, 'decision', d3.id), /paid directly from an HSA/);
    assert.equal((await status(t, e.allocationId)).direct_hsa, true);
    assert.equal((await status(t, e.allocationId)).decision_count, 0);
    assert.deepEqual(await ledgerViolations(t.db.pool), []);
    // After a release the payment is ordinary again and the removed decision can come back.
    await t.db.pool.query(`insert into payment_hsa_funding_events (household_id, payment_id, action, created_by) values ($1, $2, 'release', $3)`, [t.actor.householdId, e.paymentId, t.actor.userId]);
    await restore(t, 'decision', d3.id);
    assert.deepEqual(figs(await status(t, e.allocationId)), ['3000', '0', '0', '3000', '0']);
    // And reinstating the direct funding follows the same rule: refused while a live decision exists, allowed with only removed ones.
    const reinstate = () => t.db.pool.query(`insert into payment_hsa_funding_events (household_id, payment_id, action, created_by) values ($1, $2, 'reinstate', $3)`, [t.actor.householdId, e.paymentId, t.actor.userId]);
    await assert.rejects(reinstate(), /already has HSA claims or decisions/);
    await remove(t, 'decision', d3.id);
    await reinstate();
    assert.equal((await one(t.db.pool, `select payment_is_direct_hsa($1) as v`, [e.paymentId])).v, true);
    await assert.rejects(restore(t, 'decision', d3.id), /paid directly from an HSA/);
    assert.deepEqual(await ledgerViolations(t.db.pool), []);
  } finally { await t.db.drop(); }
});

// ---------- claim references ----------

test('a deleted claim\'s reference can be entered again; restoring it is refused while a live claim holds the reference; concurrent inserts of one reference are serialized', { skip: skipDb }, async () => {
  const t = await fixture();
  try {
    const a = await t.alloc();
    await t.decide(a.allocationId, 'eligible', '100.00');
    const c1 = await t.claim([{ allocationId: a.allocationId, amount: '10.00' }], { reference: 'Ref-Reuse-1' });
    // A live duplicate is refused by the service and by the database (case-insensitive), with the old constraint name so the mapping holds.
    await assert.rejects(t.claim([{ allocationId: a.allocationId, amount: '10.00' }], { reference: 'REF-REUSE-1' }), code('conflict'));
    await assert.rejects(t.db.pool.query(`insert into hsa_claims (id, household_id, submitted_on, administrator, reference, created_by) values (gen_random_uuid(), $1, '2026-05-01', 'x', 'ref-reuse-1', $2)`, [t.actor.householdId, t.actor.userId]),
      (e) => e.code === '23505' && e.constraint === 'hsa_claims_reference_unique');
    assert.equal(await one(t.db.pool, `select count(*)::int n from pg_indexes where indexname = 'hsa_claims_reference_unique'`).then((r) => r.n), 0);

    await remove(t, 'claim', c1.id);
    const c2 = await t.claim([{ allocationId: a.allocationId, amount: '10.00' }], { reference: 'ref-reuse-1' });
    assert.ok(c2.id);
    await assert.rejects(restore(t, 'claim', c1.id), (e) => e.code === '23505' && e.constraint === 'hsa_claims_reference_unique');
    assert.equal(await eventCount(t), 1);
    await remove(t, 'claim', c2.id);
    await restore(t, 'claim', c1.id);
    assert.deepEqual(figs(await status(t, a.allocationId)), ['10000', '1000', '0', '9000', '0']);
    // A claim without a reference is never a duplicate.
    await t.claim([{ allocationId: a.allocationId, amount: '10.00' }]);
    await t.claim([{ allocationId: a.allocationId, amount: '10.00' }]);
    assert.deepEqual(await ledgerViolations(t.db.pool), []);

    // Concurrent inserts of one new reference: the second waits for the first and is then refused.
    const insert = (c) => c.query(`insert into hsa_claims (id, household_id, submitted_on, administrator, reference, created_by) values (gen_random_uuid(), $1, '2026-05-02', 'x', 'RACE-1', $2)`, [t.actor.householdId, t.actor.userId]);
    const c3 = await t.db.pool.connect(); const c4 = await t.db.pool.connect();
    try {
      await c3.query('begin'); await c4.query('begin');
      await insert(c3);
      const second = insert(c4).then(() => 'inserted', (e) => e);
      await new Promise((r) => setTimeout(r, 300));
      await c3.query('commit');
      const outcome = await second;
      assert.equal(outcome.code, '23505');
      await c4.query('rollback');
    } finally { c3.release(); c4.release(); }
    assert.equal((await one(t.db.pool, `select count(*)::int n from hsa_claims where reference = 'RACE-1'`)).n, 1);
  } finally { await t.db.drop(); }
});

// ---------- direct SQL cannot bypass ----------

test('direct SQL cannot bypass the removal guards: entries on removed records, partial removal sets, and events written without the checks', { skip: skipDb }, async () => {
  const t = await fixture();
  try {
    const a = await t.alloc();
    await t.decide(a.allocationId, 'eligible', '100.00');
    const c = await t.claim([{ allocationId: a.allocationId, amount: '50.00' }]);
    const line = await t.line(c.id);
    const r = await t.receipt([{ lineId: line.lineId, amount: '20.00' }]);
    const raw = (client, sql, params) => client.query(sql, params);
    const newEntry = (client, kind, o) => raw(client,
      `insert into hsa_entries (id, household_id, payment_id, allocation_id, bill_id, event_id, kind, claim_id, line_id, receipt_id, amount_cents, effective_date, created_by)
       values (gen_random_uuid(), $1, $2, $3, $4, gen_random_uuid(), $5, $6, $7, $8, $9, '2026-05-05', $10)`,
      [t.actor.householdId, a.paymentId, a.allocationId, a.bill.id, kind, o.claim ?? null, o.line ?? null, o.receipt ?? null, o.cents, t.actor.userId]);

    // A removal and a restore of the same record in one transaction nets to a restore and is judged as one.
    await inTx(t.db.pool, async (cl) => { await event(t, cl, 'receipt', r.id, 'remove'); await event(t, cl, 'receipt', r.id, 'restore'); });
    assert.equal(await eventCount(t), 2);
    // Removing the receipt and the claim together in one transaction is allowed (the claim has no live receipt left at commit).
    await inTx(t.db.pool, async (cl) => { await event(t, cl, 'claim', c.id, 'remove'); await event(t, cl, 'receipt', r.id, 'remove'); });
    assert.equal((await one(t.db.pool, `select hsa_record_removed('claim', $1) as v`, [c.id])).v, true);
    // No new entry on a removed claim or receipt, even by raw SQL.
    await assert.rejects(inTx(t.db.pool, (cl) => newEntry(cl, 'reject', { claim: c.id, line: line.lineId, cents: 1000 })), /removed claim or reimbursement takes no new entries/);
    await assert.rejects(inTx(t.db.pool, (cl) => newEntry(cl, 'cancel', { claim: c.id, line: line.lineId, cents: 1000 })), /removed claim or reimbursement takes no new entries/);
    // Restoring only the receipt (its claim stays removed) is refused at commit, and a restore of the claim brings the figures back.
    await assert.rejects(restore(t, 'receipt', r.id), /while its claim is removed/);
    await restore(t, 'claim', c.id);
    await restore(t, 'receipt', r.id);
    await assert.rejects(remove(t, 'claim', c.id), /live reimbursement cannot be removed/);
    assert.deepEqual(await ledgerViolations(t.db.pool), []);

    // Hand-made inconsistency is named by the ledger rules (what a backup restore re-checks): a live receipt on a removed claim, a duplicate live reference.
    const probe = await t.db.pool.connect();
    try {
      await probe.query('begin');
      await probe.query(`alter table hsa_removal_events disable trigger user`);
      await event(t, probe, 'claim', c.id, 'remove');
      const broken = await ledgerViolations(probe);
      assert.ok(broken.some((x) => /live HSA receipt never has entries on a removed claim/.test(x)), broken.join('; '));
      await probe.query('rollback');
    } finally { probe.release(); }
    const dup = await t.db.pool.connect();
    try {
      await dup.query('begin');
      await dup.query(`alter table hsa_claims disable trigger user`);
      await dup.query(`insert into hsa_claims (id, household_id, submitted_on, administrator, reference, created_by) values (gen_random_uuid(), $1, '2026-05-01', 'x', 'DUPE', $2), (gen_random_uuid(), $1, '2026-05-01', 'x', 'dupe', $2)`, [t.actor.householdId, t.actor.userId]);
      assert.ok((await ledgerViolations(dup)).some((x) => /no two live HSA claims .* share a reference/.test(x)));
      await dup.query('rollback');
    } finally { dup.release(); }
    // Alternation is a ledger rule too: two removals in a row, written with the triggers off, are named.
    const alt = await t.db.pool.connect();
    try {
      await alt.query('begin');
      await alt.query(`alter table hsa_removal_events disable trigger user`);
      await event(t, alt, 'claim', c.id, 'remove'); await event(t, alt, 'claim', c.id, 'remove');
      assert.ok((await ledgerViolations(alt)).some((x) => /removal events alternate/.test(x)));
      await alt.query('rollback');
    } finally { alt.release(); }
  } finally { await t.db.drop(); }
});

// ---------- backup ----------

test('backup: removed HSA records round-trip (create, verify, restore) with the removal events, the live figures and the new total', { skip: skipDb }, async () => {
  const t = await fixture();
  const ts = tempStore();
  const target = await freshDatabase();
  try {
    const spec = BACKUP_TABLES.find((x) => x.name === 'hsa_removal_events');
    assert.deepEqual([spec.since, spec.orderBy], ['0020', 'seq']);
    const names = BACKUP_TABLES.map((x) => x.name);
    for (const dep of ['hsa_eligibility_decisions', 'hsa_claims', 'hsa_receipts', 'hsa_entries']) assert.ok(names.indexOf('hsa_removal_events') > names.indexOf(dep), `after ${dep}`);
    assert.ok(!tablesAt(['0018']).some((x) => x.name === 'hsa_removal_events'));
    assert.ok(tablesAt(['0018', '0019', '0020']).some((x) => x.name === 'hsa_removal_events'));

    const a = await t.alloc();
    const d = await t.decide(a.allocationId, 'eligible', '80.00');
    const c = await t.claim([{ allocationId: a.allocationId, amount: '50.00' }], { reference: 'BK-1' });
    const r = await t.receipt([{ lineId: (await t.line(c.id)).lineId, amount: '20.00' }]);
    await remove(t, 'receipt', r.id);
    await remove(t, 'claim', c.id);
    await restore(t, 'claim', c.id);
    await remove(t, 'claim', c.id);
    const b = await t.alloc({ paid: '60.00', paidOn: '2026-04-02' });
    await t.decide(b.allocationId, 'eligible', '30.00');
    assert.ok(d.id);
    const live = await ledgerSummary(t.db.pool);
    assert.equal(live.removedHsaRecords, '2');
    assert.deepEqual(await ledgerViolations(t.db.pool), []);

    const backup = createBackup(t.db.pool, ts.store, { passphrase: null });
    const file = path.join(ts.dir, backup.filename);
    await pipeline(backup.stream, createWriteStream(file));
    await backup.done;
    const verified = await verifyArchive(file);
    assert.equal(verified.manifest.ledger.removedHsaRecords, '2');
    assert.equal(verified.manifest.tables.find((x) => x.name === 'hsa_removal_events').rows, 4);

    await restoreArchive(target.pool, null, file, { via: 'cli' });
    const events = `seq, id, household_id, kind, record_id, action, reason, created_by, created_at`;
    assert.deepEqual((await target.pool.query(`select ${events} from hsa_removal_events order by seq`)).rows, (await t.db.pool.query(`select ${events} from hsa_removal_events order by seq`)).rows);
    assert.deepEqual(await allStatus(target.pool), await allStatus(t.db.pool), 'every live figure is identical');
    assert.equal((await ledgerSummary(target.pool)).removedHsaRecords, '2');
    assert.deepEqual(await ledgerViolations(target.pool), []);
    assert.equal((await one(target.pool, `select hsa_record_removed('claim', $1) as v`, [c.id])).v, true);
    assert.equal((await one(target.pool, `select hsa_record_removed('receipt', $1) as v`, [r.id])).v, true);
    // The restored database keeps working: the removal events continue their sequence and the guards are live again.
    await assert.rejects(inTx(target.pool, (cl) => cl.query(`insert into hsa_removal_events (household_id, kind, record_id, action, created_by) values ($1, 'claim', $2, 'remove', $3)`, [t.actor.householdId, c.id, t.actor.userId])), /already removed/);
    await inTx(target.pool, (cl) => cl.query(`insert into hsa_removal_events (household_id, kind, record_id, action, created_by) values ($1, 'claim', $2, 'restore', $3)`, [t.actor.householdId, c.id, t.actor.userId]));
    assert.equal((await one(target.pool, `select count(*)::int n from hsa_removal_events`)).n, 5);
    assert.ok((await one(target.pool, `select max(seq)::int n from hsa_removal_events`)).n > 4, 'the identity sequence continues after the restored rows');
  } finally { await target.drop(); ts.cleanup(); await t.db.drop(); }
});

test('backup: a backup made before 0020 restores, and the upgrade then leaves every figure as it was', { skip: skipDb }, async () => {
  const old = await freshDatabase({ migrateAll: false });
  const target = await freshDatabase({ migrateAll: false });
  const ts = tempStore();
  try {
    await migrate(old.pool, { upTo: '0018' });
    const x = await populate0018(old);
    // The restore needs somebody who can sign in afterwards.
    await old.pool.query(`insert into bootstrap_state (household_id, admin_user_id) values ($1, $2)`, [x.h, x.u]);
    await old.pool.query(`update users set password_hash = 'x', must_change_password = false where id = $1`, [x.u]);
    assert.ok(!tablesAt(['0018']).some((s) => s.name === 'hsa_removal_events'));
    const before = { status: await allStatus(old.pool), ledger: await ledgerSummary(old.pool) };
    assert.equal(before.ledger.removedHsaRecords, undefined, 'a database older than 0020 reports no such total');

    const backup = createBackup(old.pool, ts.store, { passphrase: null });
    const file = path.join(ts.dir, backup.filename);
    await pipeline(backup.stream, createWriteStream(file));
    await backup.done;
    const verified = await verifyArchive(file);
    assert.equal(verified.manifest.database.migrations.at(-1).version, '0018');
    assert.equal(verified.manifest.ledger.removedHsaRecords, undefined);
    assert.ok(!verified.manifest.tables.some((s) => s.name === 'hsa_removal_events'));

    await migrate(target.pool, { upTo: '0018' });
    await restoreArchive(target.pool, null, file, { via: 'cli' });
    assert.deepEqual(await allStatus(target.pool), before.status);
    assert.deepEqual(await ledgerViolations(target.pool), []);
    assert.deepEqual(await migrate(target.pool), ['0019', '0020']);
    const after = await ledgerSummary(target.pool);
    assert.equal(after.removedHsaRecords, '0');
    delete after.removedHsaRecords;
    assert.deepEqual(after, { ...before.ledger, auditEvents: after.auditEvents });
    assert.deepEqual(await allStatus(target.pool), before.status);
    assert.deepEqual(await ledgerViolations(target.pool), []);
  } finally { ts.cleanup(); await target.drop(); await old.drop(); }
});

// ---------- undo slot ----------

test('the undo slot accepts the three HSA removal kinds and still refuses an unknown one', { skip: skipDb }, async () => {
  const t = await fixture();
  try {
    const slot = (kind) => t.db.pool.query(
      `insert into undo_actions (user_id, household_id, kind, entity_id, expires_at) values ($1, $2, $3, gen_random_uuid(), now() + interval '3 minutes')
       on conflict (user_id) do update set kind = excluded.kind`, [t.actor.userId, t.actor.householdId, kind]);
    for (const kind of ['payment_remove', 'plan_remove', 'method_change', 'hsa_decision_remove', 'hsa_claim_remove', 'hsa_receipt_remove']) await slot(kind);
    await assert.rejects(slot('hsa_entry_remove'), /undo_actions_kind_check/);
  } finally { await t.db.drop(); }
});

// ---------- needs-review allocations: removals must not make the excess worse ----------

test('on an allocation that already needs review a removal may reduce or keep the excess but never enlarge it, and a restore may not leave an excess', { skip: skipDb }, async () => {
  const t = await fixture();
  try {
    const a = await t.alloc({ bill: '200.00', paid: '100.00' });
    const d0 = await t.decide(a.allocationId, 'eligible', '100.00');
    const d1 = await t.decide(a.allocationId, 'eligible', '100.00');
    const c1 = await t.claim([{ allocationId: a.allocationId, amount: '60.00' }]);
    const r1 = await t.receipt([{ lineId: (await t.line(c1.id)).lineId, amount: '60.00' }]);
    const ext = await t.external([{ allocationId: a.allocationId, amount: '40.00' }]);
    // A refund of 50.00 cuts the net cash: ceiling 5000 against received 10000, an excess of 5000.
    await t.refund(a.paymentId, { allocationId: a.allocationId, amount: '50.00' });
    const excess = async () => (await status(t, a.allocationId)).needs_review_cents;
    assert.equal(await excess(), '5000');

    // An unrelated (older) decision: the excess is unchanged, so the removal is allowed.
    await remove(t, 'decision', d0.id);
    assert.equal(await excess(), '5000');
    // The decision that sets the ceiling: removing it would enlarge the excess, so it is refused.
    await assert.rejects(remove(t, 'decision', d1.id), /increase the excess above the eligible ceiling/);
    assert.equal(await excess(), '5000');
    // A claim receipt returns its cash to pending: the excess stays the same, allowed.
    await remove(t, 'receipt', r1.id);
    assert.deepEqual(figs(await status(t, a.allocationId)).slice(1), ['6000', '4000', '0', '5000']);
    // An external receipt lowers the excess.
    await remove(t, 'receipt', ext.id);
    assert.equal(await excess(), '1000');
    // The claim now has no live receipt; removing it clears the excess.
    await remove(t, 'claim', c1.id);
    assert.equal(await excess(), '0');
    // Restores stay strict: a restore may never create or leave an excess.
    await assert.rejects(restore(t, 'claim', c1.id), /exceed the eligible ceiling/);
    await restore(t, 'receipt', ext.id);
    assert.equal(await excess(), '0', 'restoring within the ceiling is fine');
    await assert.rejects(restore(t, 'claim', c1.id), /exceed the eligible ceiling/, 'the claim would now leave an excess');
    await assert.rejects(restore(t, 'receipt', r1.id), /while its claim is removed/);
    assert.deepEqual(await ledgerViolations(t.db.pool), []);
  } finally { await t.db.drop(); }
});
