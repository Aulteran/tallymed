// Migration 0018: no new HSA exposure on a removed or voided payment, and cash matched to a removed plan counts as nothing.
// Real PostgreSQL, fabricated data only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import test from 'node:test';
import { createBackup, restoreArchive, verifyArchive } from '../../apps/web/server/backup/engine.ts';
import { ledgerSummary, ledgerViolations } from '../../apps/web/server/backup/ledger.ts';
import * as hsa from '../../apps/web/server/services/hsa.ts';
import * as pay from '../../apps/web/server/services/payments.ts';
import * as plans from '../../apps/web/server/services/plans.ts';
import { retryStats } from '../../apps/web/server/services/support.ts';
import { undo } from '../../apps/web/server/services/undo.ts';
import { tempStore } from './document-helpers.mjs';
import { freshDatabase, skipDb } from './helpers.mjs';
import { setup } from './money-helpers.mjs';

const AS_OF = '2026-07-15';
const REASON = 'Fabricated duplicate';
const code = (c) => ({ code: c });

const decide = (t, allocationId, o = {}) => hsa.recordDecision(t.db.pool, t.actor, {
  idempotencyKey: randomUUID(), allocationId, version: '0', status: 'ineligible', rationale: 'Reviewed, not a qualified expense', evidenceType: 'receipt',
  evidenceNote: 'Pharmacy receipt on file', decidedOn: '2026-04-05', ...o,
}, 'r');
const removePayment = (t, id) => pay.removePayment(t.db.pool, t.actor, { idempotencyKey: randomUUID(), paymentId: id, reason: REASON }, 'r');
const undoIt = (t, actor = t.actor) => undo(t.db.pool, actor, { idempotencyKey: randomUUID() }, 'r');
const removePlan = (t, plan, actor = t.actor) => plans.removePlan(t.db.pool, actor, { idempotencyKey: randomUUID(), planId: plan.id, version: String(plan.version), reason: REASON }, 'r');
const decisionCount = async (t) => (await t.db.pool.query(`select count(*)::int n from hsa_eligibility_decisions`)).rows[0].n;
const inTx = async (pool, fn) => {
  const c = await pool.connect();
  try { await c.query('begin'); const r = await fn(c); await c.query('commit'); return r; } catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
};
const insertDecision = (t, client, paymentId, allocationId, billId) => client.query(
  `insert into hsa_eligibility_decisions (id, household_id, payment_id, allocation_id, bill_id, status, eligible_cents, rationale, evidence_type, evidence_note, decided_on, created_by)
   values (gen_random_uuid(), $1, $2, $3, $4, 'ineligible', 0, 'Reviewed', 'receipt', 'Receipt on file', '2026-04-05', $5)`, [t.actor.householdId, paymentId, allocationId, billId, t.actor.userId]);

async function secondAdmin(t) {
  const id = (await t.db.pool.query(`insert into users (household_id, email, display_name, role, password_hash) values ($1, 'admin2@example.test', 'Admin Two', 'admin', 'x') returning id`, [t.actor.householdId])).rows[0].id;
  return { userId: id, householdId: t.actor.householdId, role: 'admin', displayName: 'Admin Two', sessionId: randomUUID(), mustChangePassword: false };
}

// ---------- gap 1: HSA decisions on a removed or voided payment ----------

test('a removed payment takes no HSA decision, claim or reimbursement (service and database); undo reopens it and removal stays possible', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const m = await t.member(); const p = await t.provider();
    const bill = await t.bill({ memberId: m, providerId: p, originalAmount: '100.00' });
    const pm = await t.pay1({ amount: '60.00', billId: bill.id });
    const [al] = (await t.payment(pm.id)).allocations;
    await removePayment(t, pm.id);

    // The service refuses every kind of new HSA exposure with a clear conflict, and records nothing (not even an "ineligible" decision).
    const gone = (e) => e.code === 'conflict' && /removed or voided/.test(e.message);
    await assert.rejects(decide(t, al.allocationId), gone);
    await assert.rejects(hsa.submitClaim(t.db.pool, t.actor, { idempotencyKey: randomUUID(), submittedOn: '2026-04-10', administrator: 'Example HSA Bank', lines: [{ allocationId: al.allocationId, amount: '5.00' }] }, 'r'), gone);
    await assert.rejects(hsa.recordExternalReceipt(t.db.pool, t.actor, {
      idempotencyKey: randomUUID(), receivedOn: '2026-04-11', source: 'hsa_debit_card', evidenceType: 'statement', evidenceNote: 'Card line', lines: [{ allocationId: al.allocationId, amount: '5.00' }],
    }, 'r'), gone);
    assert.equal(await decisionCount(t), 0);
    // The database refuses a direct write too, at commit.
    await assert.rejects(inTx(t.db.pool, (c) => insertDecision(t, c, pm.id, al.allocationId, bill.id)), /removed payment takes no claims, reimbursements or eligibility decisions/);
    assert.equal(await decisionCount(t), 0);
    // Reads are unaffected.
    assert.equal((await hsa.hsaSummary(t.db.pool, t.actor, {})).availableCents, '0');

    // The refusal left the undo slot alone: undo restores the payment, and then a decision works.
    await undoIt(t);
    assert.equal((await t.detail(bill.id)).openBalanceCents, '4000');
    const alBack = (await t.payment(pm.id)).allocations.find((a) => a.netCents !== '0');
    await decide(t, alBack.allocationId, { status: 'eligible', eligibleAmount: '10.00' });
    assert.equal(await decisionCount(t), 1);
    // With a decision on it the payment cannot be removed again (the documented rule), and nothing else changed.
    await assert.rejects(removePayment(t, pm.id), (e) => e.code === 'conflict' && /HSA/.test(e.message));
    assert.deepEqual(await ledgerViolations(t.db.pool), []);
  } finally { await t.db.drop(); }
});

test('a payment that was refused a decision while removed can be restored and removed again; HSA writes on a live payment are unaffected', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const m = await t.member(); const p = await t.provider();
    const bill = await t.bill({ memberId: m, providerId: p, originalAmount: '100.00' });
    const pm = await t.pay1({ amount: '60.00', billId: bill.id });
    const [al] = (await t.payment(pm.id)).allocations;
    await removePayment(t, pm.id);
    await assert.rejects(decide(t, al.allocationId), code('conflict'));
    await undoIt(t);
    // Removal is still possible: the refused attempt left no decision behind.
    await removePayment(t, pm.id);
    await undoIt(t);
    const alBack = (await t.payment(pm.id)).allocations.find((a) => a.netCents !== '0');
    // Ordinary flow on the restored payment: decision, claim, receipt, reversal.
    await decide(t, alBack.allocationId, { status: 'eligible', eligibleAmount: '40.00' });
    const claim = await hsa.submitClaim(t.db.pool, t.actor, { idempotencyKey: randomUUID(), submittedOn: '2026-04-10', administrator: 'Example HSA Bank', lines: [{ allocationId: alBack.allocationId, amount: '25.00' }] }, 'r');
    assert.ok(claim.id);
    assert.deepEqual(await ledgerViolations(t.db.pool), []);
  } finally { await t.db.drop(); }
});

test('a voided payment takes no HSA decision (service and database); settling an earlier claim stays possible', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const m = await t.member(); const p = await t.provider();
    const bill = await t.bill({ memberId: m, providerId: p, originalAmount: '100.00' });
    const pm = await t.pay1({ amount: '60.00', billId: bill.id });
    const [al] = (await t.payment(pm.id)).allocations;
    await pay.reverseAllocation(t.db.pool, t.actor, { idempotencyKey: t.key(), allocationId: al.allocationId, amount: '60.00', effectiveDate: '2026-05-01', reason: 'Wrong bill' }, 'r');
    await pay.voidPayment(t.db.pool, t.actor, { idempotencyKey: t.key(), paymentId: pm.id, reason: 'Recorded in error', voidedOn: '2026-05-02' }, 'r');
    await assert.rejects(decide(t, al.allocationId), (e) => e.code === 'conflict' && /removed or voided/.test(e.message));
    assert.equal(await decisionCount(t), 0);
    await assert.rejects(inTx(t.db.pool, (c) => insertDecision(t, c, pm.id, al.allocationId, bill.id)), /voided payment takes no claims, reimbursements or eligibility decisions/);
    assert.equal(await decisionCount(t), 0);
    assert.deepEqual(await ledgerViolations(t.db.pool), []);
  } finally { await t.db.drop(); }
});

test('the HSA entry guard refuses a new reservation or external reimbursement on a removed or voided payment, but not settling an existing claim', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const m = await t.member(); const p = await t.provider();
    const bill = await t.bill({ memberId: m, providerId: p, originalAmount: '100.00' });
    // The ceiling guard of 0006 refuses a reservation on cash that is gone first; switch it off here to see this guard on its own.
    await t.db.pool.query(`alter table hsa_entries disable trigger hsa_entries_guard`);
    await t.db.pool.query(`alter table hsa_receipts disable trigger hsa_receipts_guard`);
    const reserve = (client, paymentId, allocationId) => async () => {
      const claim = randomUUID(); const line = randomUUID();
      await client.query(`insert into hsa_claims (id, household_id, submitted_on, administrator, created_by) values ($1, $2, '2026-05-03', 'Example HSA Bank', $3)`, [claim, t.actor.householdId, t.actor.userId]);
      await client.query(`insert into hsa_entries (id, household_id, payment_id, allocation_id, bill_id, event_id, kind, claim_id, line_id, amount_cents, effective_date, created_by)
                          values ($1, $2, $3, $4, $5, gen_random_uuid(), 'reserve', $6, $1, 500, '2026-05-03', $7)`, [line, t.actor.householdId, paymentId, allocationId, bill.id, claim, t.actor.userId]);
    };
    const attempt = (paymentId, allocationId) => inTx(t.db.pool, async (c) => reserve(c, paymentId, allocationId)());

    const removed = await t.pay1({ amount: '60.00', billId: bill.id });
    const [alRemoved] = (await t.payment(removed.id)).allocations;
    await removePayment(t, removed.id);
    await assert.rejects(attempt(removed.id, alRemoved.allocationId), /removed payment takes no claims/);

    const voided = await t.pay1({ amount: '30.00', billId: bill.id });
    const [alVoided] = (await t.payment(voided.id)).allocations;
    await pay.reverseAllocation(t.db.pool, t.actor, { idempotencyKey: t.key(), allocationId: alVoided.allocationId, amount: '30.00', effectiveDate: '2026-05-01', reason: 'Wrong bill' }, 'r');
    await pay.voidPayment(t.db.pool, t.actor, { idempotencyKey: t.key(), paymentId: voided.id, reason: 'Recorded in error', voidedOn: '2026-05-02' }, 'r');
    await assert.rejects(attempt(voided.id, alVoided.allocationId), /voided payment takes no claims/);

    // An external reimbursement is new exposure as well.
    await assert.rejects(inTx(t.db.pool, async (c) => {
      const receipt = randomUUID();
      await c.query(`insert into hsa_receipts (id, household_id, received_on, amount_cents, origin, source, evidence_type, evidence_note, created_by) values ($1, $2, '2026-05-10', 500, 'external', 'hsa_debit_card', 'statement', 'Card line', $3)`, [receipt, t.actor.householdId, t.actor.userId]);
      await c.query(`insert into hsa_entries (id, household_id, payment_id, allocation_id, bill_id, event_id, kind, receipt_id, amount_cents, effective_date, created_by)
                     values (gen_random_uuid(), $1, $2, $3, $4, gen_random_uuid(), 'external_receipt', $5, 500, '2026-05-10', $6)`, [t.actor.householdId, voided.id, alVoided.allocationId, bill.id, receipt, t.actor.userId]);
    }), /voided payment takes no claims/);

    // A live payment is unaffected, and a claim made while it was live can still be released after it was voided (history is settled, not extended).
    const live = await t.pay1({ amount: '40.00', billId: bill.id });
    const [alLive] = (await t.payment(live.id)).allocations;
    await attempt(live.id, alLive.allocationId);
    assert.equal((await t.db.pool.query(`select count(*)::int n from hsa_entries`)).rows[0].n, 1);
    const line = (await t.db.pool.query(`select id, claim_id from hsa_entries`)).rows[0];
    await t.db.pool.query(`insert into payment_voids (payment_id, household_id, reason, voided_on, created_by) values ($1, $2, 'Recorded in error', '2026-05-20', $3)`, [live.id, t.actor.householdId, t.actor.userId]).catch(() => {});
    await inTx(t.db.pool, (c) => c.query(
      `insert into hsa_entries (id, household_id, payment_id, allocation_id, bill_id, event_id, kind, claim_id, line_id, amount_cents, effective_date, created_by)
       values (gen_random_uuid(), $1, $2, $3, $4, gen_random_uuid(), 'cancel', $5, $6, 500, '2026-05-21', $7)`, [t.actor.householdId, live.id, alLive.allocationId, bill.id, line.claim_id, line.id, t.actor.userId]));
    assert.equal((await t.db.pool.query(`select count(*)::int n from hsa_entries`)).rows[0].n, 2);
  } finally { await t.db.drop(); }
});

test('backup restore bypasses the new guards: a decision on a voided payment written before this fix still restores', { skip: skipDb }, async () => {
  const t = await setup();
  const ts = tempStore();
  const target = await freshDatabase();
  try {
    const m = await t.member(); const p = await t.provider();
    const bill = await t.bill({ memberId: m, providerId: p, originalAmount: '100.00' });
    const pm = await t.pay1({ amount: '60.00', billId: bill.id });
    const [al] = (await t.payment(pm.id)).allocations;
    await decide(t, al.allocationId);
    // Legacy history: the payment was later reversed and voided (possible before 0018), leaving a decision on a voided payment.
    await pay.reverseAllocation(t.db.pool, t.actor, { idempotencyKey: t.key(), allocationId: al.allocationId, amount: '60.00', effectiveDate: '2026-05-01', reason: 'Wrong bill' }, 'r');
    await pay.voidPayment(t.db.pool, t.actor, { idempotencyKey: t.key(), paymentId: pm.id, reason: 'Recorded in error', voidedOn: '2026-05-02' }, 'r');
    assert.equal(await decisionCount(t), 1);
    assert.deepEqual(await ledgerViolations(t.db.pool), []);
    const backup = createBackup(t.db.pool, ts.store, { passphrase: null });
    const file = path.join(ts.dir, backup.filename);
    await pipeline(backup.stream, createWriteStream(file));
    await backup.done;
    await verifyArchive(file);
    await restoreArchive(target.pool, null, file, { via: 'cli' });
    assert.equal((await target.pool.query(`select count(*)::int n from hsa_eligibility_decisions`)).rows[0].n, 1);
    assert.deepEqual(await ledgerViolations(target.pool), []);
    // The guards are back on after the restore.
    await assert.rejects(inTx(target.pool, (c) => c.query(
      `insert into hsa_eligibility_decisions (id, household_id, payment_id, allocation_id, bill_id, status, eligible_cents, rationale, evidence_type, evidence_note, decided_on, created_by)
       values (gen_random_uuid(), $1, $2, $3, $4, 'ineligible', 0, 'Again', 'receipt', 'Receipt', '2026-05-03', $5)`, [t.actor.householdId, pm.id, al.allocationId, bill.id, t.actor.userId])), /voided payment takes no/);
  } finally { await target.drop(); ts.cleanup(); await t.db.drop(); }
});

// ---------- gap 2: matches of a removed plan ----------

/** A $300 bill, a plan with three $100 installments, a $100 payment on it matched in full to installment 1; the plan is then cancelled and removed. */
async function removedCancelled(t, admin = t.actor) {
  const m = await t.member(); const p = await t.provider();
  const bill = await t.bill({ memberId: m, providerId: p, originalAmount: '300.00' });
  const mkPlan = (name) => plans.createPlan(t.db.pool, admin, {
    idempotencyKey: t.key(), name, billId: bill.id, totalAmount: '300.00', installmentCount: '3', firstDueDate: '2026-06-01', cadence: 'monthly', startedOn: '2026-01-01',
  }, 'r');
  const detail = (id) => plans.getPlanDetail(t.db.pool, t.actor, id, { asOf: AS_OF });
  const old = await mkPlan('Old plan');
  const payment = await t.pay1({ amount: '100.00', billId: bill.id });
  const [alloc] = (await t.payment(payment.id)).allocations;
  const d0 = await detail(old.id);
  await plans.matchInstallment(t.db.pool, admin, { idempotencyKey: t.key(), installmentId: d0.installments[0].id, allocationId: alloc.allocationId, amount: '100.00' }, 'r');
  await plans.cancelPlan(t.db.pool, admin, { planId: old.id, version: String((await detail(old.id)).plan.version), reason: 'Paid another way' }, 'r');
  await removePlan(t, (await detail(old.id)).plan, admin);
  const allocation = async () => (await pay.getPaymentDetail(t.db.pool, t.actor, payment.id)).allocations[0];
  return { bill, old, payment, alloc: alloc.allocationId, mkPlan, detail, allocation };
}

const counted = async (t, allocationId) => (await t.db.pool.query(
  `select coalesce(sum(m.amount_cents), 0)::text s from installment_matches m join payment_plans p on p.id = m.plan_id and p.removed_at is null
    join plan_revisions r on r.id = m.revision_id where m.allocation_id = $1 and r.revision_no = (select max(revision_no) from plan_revisions x where x.plan_id = m.plan_id)`, [allocationId])).rows[0].s;

test('a removed cancelled plan frees its cash: the allocation can be matched to a new plan up to its net cash, and the figures reconcile', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const f = await removedCancelled(t);
    // Before the fix the removed plan's 100.00 stayed counted; now the allocation shows nothing matched and is offered as unmatched cash.
    const a0 = await f.allocation();
    assert.deepEqual([a0.netCents, a0.matchedCents], ['10000', '0']);
    const next = await f.mkPlan('New plan');
    const d = await f.detail(next.id);
    assert.deepEqual(d.allocations.map((a) => [a.allocationId, a.netCents, a.matchedCents]), [[f.alloc, '10000', '0']], 'the unmatched cash picker offers it');
    // Up to its net cash, and not a cent more.
    await plans.matchInstallment(t.db.pool, t.actor, { idempotencyKey: t.key(), installmentId: d.installments[0].id, allocationId: f.alloc, amount: '100.00' }, 'r');
    await assert.rejects(plans.matchInstallment(t.db.pool, t.actor, { idempotencyKey: t.key(), installmentId: d.installments[1].id, allocationId: f.alloc, amount: '0.01' }, 'r'), code('conflict'));
    const a1 = await f.allocation();
    assert.deepEqual([a1.netCents, a1.matchedCents], ['10000', '10000']);
    assert.equal(await counted(t, f.alloc), a1.matchedCents, 'the displayed matched cash is exactly what the guard counts');
    assert.equal((await f.detail(next.id)).plan.matchedCents, '10000');
    // The removed plan stays hidden everywhere, and unmatching on it stays refused (it is invisible).
    await assert.rejects(f.detail(f.old.id), code('not_found'));
    assert.equal((await plans.listPlans(t.db.pool, t.actor, {}, AS_OF)).items.some((x) => x.id === f.old.id), false);
    await assert.rejects(inTx(t.db.pool, (c) => c.query(
      `insert into installment_matches (id, household_id, plan_id, revision_id, installment_id, payment_id, allocation_id, bill_id, kind, amount_cents, created_by)
       select gen_random_uuid(), m.household_id, m.plan_id, m.revision_id, (select i.id from plan_installments i where i.plan_id = m.plan_id and i.seq = 2), m.payment_id, m.allocation_id, m.bill_id, 'match', 100, m.created_by
         from installment_matches m where m.plan_id = $1 limit 1`, [f.old.id])), /removed plan/);
    // The database guard counts the same way: a direct match above the net cash is refused, with the removed plan's rows still in place.
    await assert.rejects(inTx(t.db.pool, (c) => c.query(
      `insert into installment_matches (id, household_id, plan_id, revision_id, installment_id, payment_id, allocation_id, bill_id, kind, amount_cents, created_by)
       values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, 'match', 1, $8)`, [t.actor.householdId, next.id, d.plan.revisionId, d.installments[1].id, f.payment.id, f.alloc, f.bill.id, t.actor.userId])), /plan matches would exceed/);
    assert.deepEqual(await ledgerViolations(t.db.pool), []);
    assert.equal((await t.detail(f.bill.id)).openBalanceCents, '20000', 'cash and balances never moved');
  } finally { await t.db.drop(); }
});

test('undo of the removal of a cancelled plan skips a match that was meanwhile given to a new plan, and lists it', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const admin2 = await secondAdmin(t);
    // The first administrator removes; the second matches the freed cash (a mutation by the same user would replace the undo slot).
    const f = await removedCancelled(t);
    const next = await f.mkPlan('New plan');
    const d = await f.detail(next.id);
    await plans.matchInstallment(t.db.pool, admin2, { idempotencyKey: t.key(), installmentId: d.installments[0].id, allocationId: f.alloc, amount: '100.00' }, 'r');
    const before = (await t.db.pool.query(`select count(*)::int n from installment_matches`)).rows[0].n;
    await undoIt(t);
    // The cancelled plan is back with its history; its match is released because the cash is taken, the new plan keeps it, and nothing is double counted.
    const back = await f.detail(f.old.id);
    assert.equal(back.plan.status, 'cancelled');
    assert.equal(back.plan.matchedCents, '0');
    assert.equal((await f.detail(next.id)).plan.matchedCents, '10000');
    const a = await f.allocation();
    assert.deepEqual([a.netCents, a.matchedCents], ['10000', '10000']);
    assert.equal(await counted(t, f.alloc), '10000');
    assert.equal((await t.db.pool.query(`select count(*)::int n from installment_matches`)).rows[0].n, before + 1, 'one release row, appended; history is never rewritten');
    const [restored] = (await t.audit('plan.restored')).slice(-1);
    assert.deepEqual([restored.detail.skippedMatchCount, restored.detail.skippedCents, restored.detail.restoredMatchCount], [1, '10000', 0]);
    assert.equal(restored.detail.skippedAllocationIds, f.alloc);
    assert.deepEqual(await ledgerViolations(t.db.pool), []);
  } finally { await t.db.drop(); }
});

test('undo of the removal of a cancelled plan with no contest restores its match exactly', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const f = await removedCancelled(t);
    const rowsBefore = (await t.db.pool.query(`select count(*)::int n from installment_matches`)).rows[0].n;
    await undoIt(t);
    const back = await f.detail(f.old.id);
    assert.deepEqual([back.plan.status, back.plan.matchedCents, back.installments.map((i) => i.matchedCents)], ['cancelled', '10000', ['10000', '0', '0']]);
    const a = await f.allocation();
    assert.deepEqual([a.netCents, a.matchedCents], ['10000', '10000']);
    assert.equal((await t.db.pool.query(`select count(*)::int n from installment_matches`)).rows[0].n, rowsBefore, 'no row was added or released');
    const [restored] = (await t.audit('plan.restored')).slice(-1);
    assert.deepEqual([restored.detail.skippedMatchCount, restored.detail.skippedCents], [0, '0']);
    assert.deepEqual(await ledgerViolations(t.db.pool), []);
  } finally { await t.db.drop(); }
});

test('removing an active plan and undoing it is unchanged; a refund still releases only the matches of plans that are shown', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const admin2 = await secondAdmin(t);
    const m = await t.member(); const p = await t.provider();
    const bill = await t.bill({ memberId: m, providerId: p, originalAmount: '300.00' });
    const mk = (name) => plans.createPlan(t.db.pool, t.actor, { idempotencyKey: t.key(), name, billId: bill.id, totalAmount: '300.00', installmentCount: '3', firstDueDate: '2026-06-01', cadence: 'monthly', startedOn: '2026-01-01' }, 'r');
    const detail = (id) => plans.getPlanDetail(t.db.pool, t.actor, id, { asOf: AS_OF });
    const old = await mk('Old plan');
    const payment = await t.pay1({ amount: '100.00', billId: bill.id });
    const [alloc] = (await t.payment(payment.id)).allocations;
    const d0 = await detail(old.id);
    await plans.matchInstallment(t.db.pool, t.actor, { idempotencyKey: t.key(), installmentId: d0.installments[0].id, allocationId: alloc.allocationId, amount: '100.00' }, 'r');
    await removePlan(t, (await detail(old.id)).plan);
    const next = await mk('New plan');
    const dn = await detail(next.id);
    await plans.matchInstallment(t.db.pool, admin2, { idempotencyKey: t.key(), installmentId: dn.installments[0].id, allocationId: alloc.allocationId, amount: '60.00' }, 'r');
    await undoIt(t);
    // As before: the active plan's released 100.00 match does not fit the 40.00 of cash left, so it is skipped whole and listed.
    assert.equal((await detail(old.id)).plan.matchedCents, '0');
    const [restored] = (await t.audit('plan.restored')).slice(-1);
    assert.deepEqual([restored.detail.restoredMatchCount, restored.detail.restoredCents, restored.detail.skippedMatchCount, restored.detail.skippedCents], [0, '0', 1, '10000']);
    assert.equal(await counted(t, alloc.allocationId), '6000');
    await t.refund(payment.id, { allocationId: alloc.allocationId, amount: '50.00' });
    assert.equal(await counted(t, alloc.allocationId), '5000', 'a refund releases matches so they never exceed the cash left');
    assert.deepEqual(await ledgerViolations(t.db.pool), []);
  } finally { await t.db.drop(); }
});

test('backup: a removed cancelled plan whose cash is matched to a new plan round-trips (create, verify, restore) and the ledger rules hold', { skip: skipDb }, async () => {
  const t = await setup();
  const ts = tempStore();
  const target = await freshDatabase();
  try {
    const f = await removedCancelled(t);
    const next = await f.mkPlan('New plan');
    const d = await f.detail(next.id);
    await plans.matchInstallment(t.db.pool, t.actor, { idempotencyKey: t.key(), installmentId: d.installments[0].id, allocationId: f.alloc, amount: '100.00' }, 'r');
    assert.deepEqual(await ledgerViolations(t.db.pool), []);
    const backup = createBackup(t.db.pool, ts.store, { passphrase: null });
    const file = path.join(ts.dir, backup.filename);
    await pipeline(backup.stream, createWriteStream(file));
    await backup.done;
    const verified = await verifyArchive(file);
    assert.equal(verified.manifest.ledger.removedPlans, '1');
    await restoreArchive(target.pool, null, file, { via: 'cli' });
    assert.deepEqual(await ledgerViolations(target.pool), []);
    const live = await ledgerSummary(t.db.pool); const restored = await ledgerSummary(target.pool);
    assert.deepEqual({ ...restored, auditEvents: live.auditEvents }, live);
    assert.equal((await target.pool.query(`select count(*)::int n from installment_matches`)).rows[0].n, (await t.db.pool.query(`select count(*)::int n from installment_matches`)).rows[0].n);
  } finally { await target.drop(); ts.cleanup(); await t.db.drop(); }
});

test('a new-plan match races the undo of a removed cancelled plan: one order wins, nothing is double counted, no lock cycles', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    retryStats.lockConflicts = 0;
    const admin2 = await secondAdmin(t);
    for (let i = 0; i < 6; i += 1) {
      const f = await removedCancelled(t);
      const next = await f.mkPlan(`New plan ${i}`);
      const d = await f.detail(next.id);
      const [restore, match] = await Promise.allSettled([
        undoIt(t),
        plans.matchInstallment(t.db.pool, admin2, { idempotencyKey: t.key(), installmentId: d.installments[0].id, allocationId: f.alloc, amount: '100.00' }, 'r'),
      ]);
      assert.equal(restore.status, 'fulfilled', `the undo always succeeds (${restore.reason?.message})`);
      if (match.status === 'rejected') assert.equal(match.reason.code, 'conflict', `unexpected ${match.reason?.message}`);
      // Either the match won (and the undo released the old plan's contested match) or the undo won (and the match was refused for lack of cash).
      assert.equal(await counted(t, f.alloc), '10000', 'exactly the net cash is counted, never more');
      const a = await f.allocation();
      assert.equal(a.matchedCents, '10000');
      if (match.status === 'fulfilled') assert.equal((await f.detail(f.old.id)).plan.matchedCents, '0');
      else assert.equal((await f.detail(f.old.id)).plan.matchedCents, '10000');
    }
    assert.equal(retryStats.lockConflicts, 0, 'no deadlocks or serialization failures');
    assert.deepEqual(await ledgerViolations(t.db.pool), []);
  } finally { await t.db.drop(); }
});
