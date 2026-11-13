// HSA reimbursements (M04): eligibility decisions, claim reservations, receipts, releases, reversals, review states, concurrency,
// database guards and exports. Synthetic data only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import * as handlers from '../../apps/web/server/http.ts';
import { csrfFor } from '../../apps/web/server/tokens.ts';
import * as pay from '../../apps/web/server/services/payments.ts';
import * as hsa from '../../apps/web/server/services/hsa.ts';
import * as hsaRepo from '../../apps/web/server/repositories/hsa.ts';
import { retryStats } from '../../apps/web/server/services/support.ts';
import { billContract, listHsaFigures, listNetAllocations } from '../../apps/web/server/contracts.ts';
import * as svc from '../../apps/web/server/services/expenses.ts';
import { authenticate } from '../../apps/web/server/services/auth.ts';
import { migrate } from '../../apps/web/server/migrate.ts';
import { freshDatabase, loginJson, post, seedHousehold, skipDb, testConfig } from './helpers.mjs';
import { setup } from './money-helpers.mjs';

const code = (c) => ({ code: c });

/** Fixture: a member, a provider and helpers that build allocations, decisions, claims and receipts. */
async function fixture() {
  const t = await setup();
  const m = await t.member();
  const p = await t.provider();
  const pool = t.db.pool;
  const actor = t.actor;
  return {
    ...t, m, p,
    /** A confirmed bill paid in part or in full by one payment: returns the allocation. */
    async alloc({ bill = '120.00', paid = '75.00', paidOn = '2026-04-01' } = {}) {
      const b = await t.bill({ memberId: m, providerId: p, originalAmount: bill });
      const pm = await t.pay1({ amount: paid, paidOn, billId: b.id });
      const [a] = (await t.payment(pm.id)).allocations;
      return { bill: b, payment: pm, allocationId: a.allocationId, paymentId: pm.id };
    },
    figs: (id) => hsaRepo.getAllocation(pool, actor.householdId, id),
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
    release: (lineId, kind, o = {}) => hsa.releaseClaimLine(pool, actor, { idempotencyKey: t.key(), lineId, kind, effectiveDate: '2026-04-25', reason: 'Administrator response', ...o }, 'r'),
    reverse: (receiptId, o = {}) => hsa.reverseReceipt(pool, actor, { idempotencyKey: t.key(), receiptId, effectiveDate: '2026-05-02', reason: 'Returned by the bank', ...o }, 'r'),
  };
}
const figsOf = (a) => [a.ceilingCents, a.pendingCents, a.receivedCents, a.availableCents, a.needsReviewCents];

/** Rebuilds an allocation's figures from the raw ledger rows only (no view), the independent reconciliation. */
async function rebuild(pool, allocationId) {
  const { rows: net } = await pool.query(`select coalesce(sum(amount_cents), 0)::bigint n from payment_entries where allocation_id = $1`, [allocationId]);
  const { rows: dec } = await pool.query(`select eligible_cents from hsa_eligibility_decisions where allocation_id = $1 order by seq desc limit 1`, [allocationId]);
  const { rows: ent } = await pool.query(`select kind, amount_cents from hsa_entries where allocation_id = $1`, [allocationId]);
  let pending = 0n, received = 0n;
  for (const e of ent) {
    const a = BigInt(e.amount_cents);
    if (e.kind === 'reserve') pending += a;
    else if (['receipt', 'reject', 'cancel'].includes(e.kind)) pending -= a;
    if (['receipt', 'external_receipt'].includes(e.kind)) received += a;
    if (e.kind === 'receipt_reversal') received -= a;
  }
  const eligible = BigInt(dec[0]?.eligible_cents ?? 0);
  const n = BigInt(net[0].n);
  const ceiling = eligible < n ? eligible : n;
  const avail = ceiling - pending - received;
  const over = pending + received - ceiling;
  return [ceiling, pending, received, avail > 0n ? avail : 0n, over > 0n ? over : 0n].map(String);
}
const assertReconciles = async (t, allocationId) => assert.deepEqual(figsOf(await t.figs(allocationId)), await rebuild(t.db.pool, allocationId));

test('the ledger example: a $120 bill with $75 paid, $60 eligible, $50 claimed and $20 received', { skip: skipDb }, async () => {
  const t = await fixture();
  try {
    const a = await t.alloc({ bill: '120.00', paid: '75.00' });
    const snapshot = async () => ({
      bill: billContract(await t.detail(a.bill.id)), cash: await pay.cashSummary(t.db.pool, t.actor), net: await listNetAllocations(t.db.pool, t.actor, {}),
      payment: (await t.payment(a.paymentId)).payment, ledger: (await t.db.pool.query(`select count(*)::int n, coalesce(sum(amount_cents), 0)::text s from payment_entries`)).rows[0],
    });
    const before = await snapshot();
    assert.equal(before.bill.openBalanceCents, '4500', 'provider balance is $45');
    // Undecided means unknown: it contributes zero, and a claim is refused.
    assert.deepEqual(figsOf(await t.figs(a.allocationId)), ['0', '0', '0', '0', '0']);
    await assert.rejects(t.claim([{ allocationId: a.allocationId, amount: '1.00' }]), code('conflict'));
    await t.decide(a.allocationId, 'eligible', '60.00');
    assert.deepEqual(figsOf(await t.figs(a.allocationId)), ['6000', '0', '0', '6000', '0']);
    const claim = await t.claim([{ allocationId: a.allocationId, amount: '50.00' }]);
    const line = await t.line(claim.id);
    assert.equal(line.status, 'submitted');
    await t.receipt([{ lineId: line.lineId, amount: '20.00' }]);
    const f = await t.figs(a.allocationId);
    assert.deepEqual(figsOf(f), ['6000', '3000', '2000', '1000', '0'], '$30 pending, $20 reimbursed, $10 available');
    assert.equal((await t.line(claim.id)).status, 'partially_fulfilled');
    // Provider balances and every cash figure are exactly as before: receipts are not household cash.
    assert.deepEqual(await snapshot(), before);
    await assertReconciles(t, a.allocationId);
    const totals = await hsa.hsaSummary(t.db.pool, t.actor, {});
    assert.deepEqual([totals.eligibleCents, totals.pendingCents, totals.receivedCents, totals.availableCents, totals.needsReviewCents], ['6000', '3000', '2000', '1000', '0']);
  } finally {
    await t.db.drop();
  }
});

test('eligibility decisions need evidence and a user decision; pending and unknown contribute zero; stale forms are refused', { skip: skipDb }, async () => {
  const t = await fixture();
  try {
    const a = await t.alloc({ bill: '100.00', paid: '80.00' });
    const base = (o) => ({ idempotencyKey: t.key(), allocationId: a.allocationId, version: '0', status: 'eligible', eligibleAmount: '40.00', rationale: 'Dental exam', evidenceType: 'eob', evidenceNote: 'EOB line 3', decidedOn: '2026-04-05', ...o });
    // Evidence is required to certify or to rule out; a pending note is allowed without it.
    await assert.rejects(hsa.recordDecision(t.db.pool, t.actor, base({ evidenceType: undefined, evidenceNote: undefined }), 'r'), code('invalid_input'));
    await assert.rejects(hsa.recordDecision(t.db.pool, t.actor, base({ rationale: '' }), 'r'), code('invalid_input'));
    await assert.rejects(hsa.recordDecision(t.db.pool, t.actor, base({ eligibleAmount: undefined }), 'r'), code('invalid_input'));
    await assert.rejects(hsa.recordDecision(t.db.pool, t.actor, base({ status: 'ineligible' }), 'r'), code('invalid_input'), 'ineligible carries no amount');
    await assert.rejects(hsa.recordDecision(t.db.pool, t.actor, base({ eligibleAmount: '40.005' }), 'r'), code('invalid_input'));
    await assert.rejects(hsa.recordDecision(t.db.pool, t.actor, base({ eligibleAmount: '80.01' }), 'r'), code('conflict'), 'more than the net cash');
    assert.equal(await t.count('hsa_eligibility_decisions'), 0);
    const first = await hsa.recordDecision(t.db.pool, t.actor, base({ status: 'pending', eligibleAmount: undefined, evidenceType: undefined, evidenceNote: undefined, rationale: 'Waiting for the EOB' }), 'r');
    assert.deepEqual(figsOf(await t.figs(a.allocationId)), ['0', '0', '0', '0', '0'], 'pending contributes zero');
    // A stale form (it saw no decision, one exists now) is refused; the right version works.
    await assert.rejects(hsa.recordDecision(t.db.pool, t.actor, base({}), 'r'), code('stale_version'));
    await hsa.recordDecision(t.db.pool, t.actor, base({ version: '1' }), 'r');
    assert.deepEqual(figsOf(await t.figs(a.allocationId)), ['4000', '0', '0', '4000', '0']);
    // Idempotent replay: the same key and input returns the first result; changed input conflicts.
    const key = t.key();
    const one = await hsa.recordDecision(t.db.pool, t.actor, base({ idempotencyKey: key, version: '2', eligibleAmount: '30.00' }), 'r');
    const again = await hsa.recordDecision(t.db.pool, t.actor, base({ idempotencyKey: key, version: '2', eligibleAmount: '30.00' }), 'r');
    assert.equal(again.id, one.id);
    assert.equal(again.replayed, true);
    await assert.rejects(hsa.recordDecision(t.db.pool, t.actor, base({ idempotencyKey: key, version: '2', eligibleAmount: '31.00' }), 'r'), code('conflict'));
    assert.equal(await t.count('hsa_eligibility_decisions'), 3);
    // History is kept, newest first, and the decision before is untouched.
    const detail = await hsa.getHsaAllocationDetail(t.db.pool, t.actor, a.allocationId);
    assert.deepEqual(detail.decisions.map((d) => [d.status, d.eligibleCents]), [['eligible', '3000'], ['eligible', '4000'], ['pending', '0']]);
    assert.ok(first.id);
    // Audit keeps before and after values and no free text.
    const rows = await t.audit('hsa.decision_recorded');
    assert.equal(rows.length, 3);
    const last = rows[2].detail;
    assert.equal(last.eligibleBeforeCents, '4000');
    assert.equal(last.eligibleAfterCents, '3000');
    assert.equal(last.availableBeforeCents, '4000');
    assert.equal(last.availableAfterCents, '3000');
    assert.ok(!JSON.stringify(rows).includes('Dental exam') && !JSON.stringify(rows).includes('EOB line 3'));
    // Ineligible rules cash out entirely.
    await hsa.recordDecision(t.db.pool, t.actor, { ...base({ version: '3', status: 'ineligible', eligibleAmount: undefined, rationale: 'Cosmetic' }) }, 'r');
    assert.deepEqual(figsOf(await t.figs(a.allocationId)), ['0', '0', '0', '0', '0']);
  } finally {
    await t.db.drop();
  }
});

test('claims reserve within the ceiling: concurrent duplicates cannot over-reserve, references are unique and one key is one claim', { skip: skipDb }, async () => {
  const t = await fixture();
  try {
    const a = await t.alloc({ bill: '100.00', paid: '100.00' });
    await t.decide(a.allocationId, 'eligible', '60.00');
    await assert.rejects(t.claim([{ allocationId: a.allocationId, amount: '60.01' }]), code('conflict'));
    await assert.rejects(t.claim([{ allocationId: a.allocationId, amount: '0' }]), code('invalid_input'));
    await assert.rejects(t.claim([{ allocationId: a.allocationId, amount: '10' }, { allocationId: a.allocationId, amount: '10' }]), code('invalid_input'));
    await assert.rejects(t.claim([{ allocationId: randomUUID(), amount: '10' }]), code('not_found'));
    assert.equal(await t.count('hsa_claims'), 0, 'rejected claims left nothing behind');
    // Eight simultaneous $20 claims on a $60 ceiling: exactly three fit, the rest are refused and nothing deadlocks.
    const before = { ...retryStats };
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => t.claim([{ allocationId: a.allocationId, amount: '20.00' }])));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3);
    for (const r of results.filter((x) => x.status === 'rejected')) assert.equal(r.reason.code, 'conflict');
    assert.deepEqual(figsOf(await t.figs(a.allocationId)), ['6000', '6000', '0', '0', '0']);
    assert.equal(retryStats.lockConflicts - before.lockConflicts, 0);
    await assertReconciles(t, a.allocationId);
    // Release one, then a replay of the very same request key returns the original claim and posts nothing new.
    const b = await t.alloc({ bill: '50.00', paid: '50.00' });
    await t.decide(b.allocationId, 'eligible', '50.00');
    const key = t.key();
    const lines = [{ allocationId: b.allocationId, amount: '30.00' }];
    const one = await t.claim(lines, { idempotencyKey: key, reference: 'CLM-1001' });
    const two = await t.claim(lines, { idempotencyKey: key, reference: 'CLM-1001' });
    assert.deepEqual([two.id, two.replayed], [one.id, true]);
    await assert.rejects(t.claim([{ allocationId: b.allocationId, amount: '31.00' }], { idempotencyKey: key, reference: 'CLM-1001' }), code('conflict'));
    // The same administrator reference is a duplicate submission, whatever the case.
    await assert.rejects(t.claim([{ allocationId: b.allocationId, amount: '5.00' }], { reference: 'clm-1001' }), code('conflict'));
    assert.deepEqual(figsOf(await t.figs(b.allocationId)), ['5000', '3000', '0', '2000', '0']);
    // Two lines in one claim across two allocations commit together or not at all.
    const c = await t.alloc({ bill: '40.00', paid: '40.00' });
    await t.decide(c.allocationId, 'eligible', '10.00');
    await assert.rejects(t.claim([{ allocationId: b.allocationId, amount: '10.00' }, { allocationId: c.allocationId, amount: '10.01' }]), code('conflict'));
    assert.deepEqual(figsOf(await t.figs(b.allocationId)), ['5000', '3000', '0', '2000', '0'], 'the first line was rolled back with the claim');
    const both = await t.claim([{ allocationId: b.allocationId, amount: '10.00' }, { allocationId: c.allocationId, amount: '10.00' }]);
    assert.equal((await hsaRepo.linesOfClaim(t.db.pool, t.actor.householdId, both.id)).length, 2);
  } finally {
    await t.db.drop();
  }
});

test('partial receipts, split receipts, releases of rejected and canceled reserves, and linked receipt reversals', { skip: skipDb }, async () => {
  const t = await fixture();
  try {
    const a = await t.alloc({ bill: '100.00', paid: '100.00' });
    const b = await t.alloc({ bill: '100.00', paid: '100.00' });
    await t.decide(a.allocationId, 'eligible', '100.00');
    await t.decide(b.allocationId, 'eligible', '100.00');
    const claim = await t.claim([{ allocationId: a.allocationId, amount: '70.00' }, { allocationId: b.allocationId, amount: '30.00' }], { reference: 'CLM-A' });
    const lines = await hsaRepo.linesOfClaim(t.db.pool, t.actor.householdId, claim.id);
    const la = lines.find((l) => l.allocationId === a.allocationId);
    const lb = lines.find((l) => l.allocationId === b.allocationId);
    // A split receipt pays both lines; a partial receipt pays part of one. Over-paying a line is refused as a whole.
    await assert.rejects(t.receipt([{ lineId: la.lineId, amount: '70.01' }]), code('conflict'));
    await assert.rejects(t.receipt([{ lineId: la.lineId, amount: '10.00' }, { lineId: lb.lineId, amount: '30.01' }]), code('conflict'));
    assert.equal(await t.count('hsa_receipts'), 0);
    const split = await t.receipt([{ lineId: la.lineId, amount: '40.00' }, { lineId: lb.lineId, amount: '10.00' }], { reference: 'EFT-1' });
    const partial = await t.receipt([{ lineId: la.lineId, amount: '5.00' }]);
    assert.deepEqual(figsOf(await t.figs(a.allocationId)), ['10000', '2500', '4500', '3000', '0']);
    assert.deepEqual(figsOf(await t.figs(b.allocationId)), ['10000', '2000', '1000', '7000', '0']);
    assert.equal((await t.line(claim.id, 0)).status, 'partially_fulfilled');
    // Reject what is left on the first line: the reservation is released back to available and the paid part stays.
    await t.release(la.lineId, 'reject');
    assert.deepEqual(figsOf(await t.figs(a.allocationId)), ['10000', '0', '4500', '5500', '0']);
    const lineA = (await hsaRepo.linesOfClaim(t.db.pool, t.actor.householdId, claim.id)).find((l) => l.lineId === la.lineId);
    assert.equal(lineA.status, 'partially_fulfilled', 'paid in part, rest released');
    await assert.rejects(t.release(la.lineId, 'cancel'), code('conflict'), 'nothing left to release');
    // Cancel part of the second line, then a full cancel of a fresh line gives status canceled.
    await t.release(lb.lineId, 'cancel', { amount: '5.00' });
    assert.deepEqual(figsOf(await t.figs(b.allocationId)), ['10000', '1500', '1000', '7500', '0']);
    await assert.rejects(t.release(lb.lineId, 'cancel', { amount: '15.01' }), code('conflict'));
    const c2 = await t.claim([{ allocationId: a.allocationId, amount: '20.00' }]);
    await t.release((await t.line(c2.id)).lineId, 'cancel');
    assert.equal((await t.line(c2.id)).status, 'canceled');
    const c3 = await t.claim([{ allocationId: a.allocationId, amount: '20.00' }]);
    await t.release((await t.line(c3.id)).lineId, 'reject');
    assert.equal((await t.line(c3.id)).status, 'rejected');
    assert.deepEqual(figsOf(await t.figs(a.allocationId)), ['10000', '0', '4500', '5500', '0'], 'released reserves return to available');
    // Reverse the split receipt: received drops, nothing returns to pending, and the amount is available to claim again.
    const rev = await t.reverse(split.id);
    assert.equal(rev.replayed, false);
    assert.deepEqual(figsOf(await t.figs(a.allocationId)), ['10000', '0', '500', '9500', '0']);
    assert.deepEqual(figsOf(await t.figs(b.allocationId)), ['10000', '1500', '0', '8500', '0']);
    await assert.rejects(t.reverse(split.id), code('conflict'), 'a receipt is reversed once');
    const detail = await hsa.getHsaReceiptDetail(t.db.pool, t.actor, split.id);
    assert.equal(detail.receipt.reversed, true);
    assert.equal(detail.entries.filter((e) => e.kind === 'receipt_reversal').length, 2);
    assert.ok(detail.entries.filter((e) => e.kind === 'receipt_reversal').every((e) => e.reversesEntryId !== null));
    // The reversed amount can be claimed again, but not beyond the ceiling.
    await t.claim([{ allocationId: a.allocationId, amount: '95.00' }]);
    await assert.rejects(t.claim([{ allocationId: a.allocationId, amount: '0.01' }]), code('conflict'));
    assert.ok(partial.id);
    for (const x of [a, b]) await assertReconciles(t, x.allocationId);
    // Concurrent double reversal: one wins.
    const dup = await t.alloc({ bill: '20.00', paid: '20.00' });
    await t.decide(dup.allocationId, 'eligible', '20.00');
    const cl = await t.claim([{ allocationId: dup.allocationId, amount: '20.00' }]);
    const rc = await t.receipt([{ lineId: (await t.line(cl.id)).lineId, amount: '20.00' }]);
    const race = await Promise.allSettled([t.reverse(rc.id), t.reverse(rc.id), t.reverse(rc.id)]);
    assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1);
    assert.deepEqual(figsOf(await t.figs(dup.allocationId)), ['2000', '0', '0', '2000', '0']);
  } finally {
    await t.db.drop();
  }
});

test('external reimbursements need an explicit source and evidence and obey the same ceiling', { skip: skipDb }, async () => {
  const t = await fixture();
  try {
    const a = await t.alloc({ bill: '90.00', paid: '90.00' });
    await assert.rejects(t.external([{ allocationId: a.allocationId, amount: '10.00' }]), code('conflict'), 'undecided: nothing is available');
    await t.decide(a.allocationId, 'eligible', '50.00');
    await assert.rejects(t.external([{ allocationId: a.allocationId, amount: '10.00' }], { evidenceType: undefined }), code('invalid_input'));
    await assert.rejects(t.external([{ allocationId: a.allocationId, amount: '10.00' }], { evidenceNote: undefined }), code('invalid_input'));
    await assert.rejects(t.external([{ allocationId: a.allocationId, amount: '10.00' }], { source: 'unknown' }), code('invalid_input'));
    await assert.rejects(t.external([{ allocationId: a.allocationId, amount: '50.01' }]), code('conflict'));
    const ext = await t.external([{ allocationId: a.allocationId, amount: '35.00' }], { reference: 'POS-77' });
    assert.deepEqual(figsOf(await t.figs(a.allocationId)), ['5000', '0', '3500', '1500', '0']);
    // The external receipt competes with claims for the same ceiling.
    await assert.rejects(t.claim([{ allocationId: a.allocationId, amount: '15.01' }]), code('conflict'));
    await t.claim([{ allocationId: a.allocationId, amount: '15.00' }]);
    assert.deepEqual(figsOf(await t.figs(a.allocationId)), ['5000', '1500', '3500', '0', '0']);
    const rec = await hsa.getHsaReceiptDetail(t.db.pool, t.actor, ext.id);
    assert.equal(rec.receipt.origin, 'external');
    assert.equal(rec.receipt.evidenceType, 'statement');
    await t.reverse(ext.id);
    assert.deepEqual(figsOf(await t.figs(a.allocationId)), ['5000', '1500', '0', '3500', '0']);
    // Split external receipt across two allocations is all or nothing.
    const b = await t.alloc({ bill: '30.00', paid: '30.00' });
    await t.decide(b.allocationId, 'eligible', '10.00');
    await assert.rejects(t.external([{ allocationId: a.allocationId, amount: '5.00' }, { allocationId: b.allocationId, amount: '10.01' }]), code('conflict'));
    assert.deepEqual(figsOf(await t.figs(a.allocationId)), ['5000', '1500', '0', '3500', '0']);
    await t.external([{ allocationId: a.allocationId, amount: '5.00' }, { allocationId: b.allocationId, amount: '10.00' }]);
    for (const x of [a, b]) await assertReconciles(t, x.allocationId);
  } finally {
    await t.db.drop();
  }
});

test('a refund, an allocation reversal or a lower decision after a claim or receipt freezes the allocation for review without losing history', { skip: skipDb }, async () => {
  const t = await fixture();
  try {
    // Refund after reimbursement.
    const a = await t.alloc({ bill: '100.00', paid: '100.00' });
    await t.decide(a.allocationId, 'eligible', '100.00');
    const claim = await t.claim([{ allocationId: a.allocationId, amount: '60.00' }]);
    const line = await t.line(claim.id);
    await t.receipt([{ lineId: line.lineId, amount: '25.00' }]);
    assert.deepEqual(figsOf(await t.figs(a.allocationId)), ['10000', '3500', '2500', '4000', '0']);
    // The provider refunds $50: net cash falls to $50, the ceiling follows, pending + received ($60) exceeds it by $10.
    await t.refund(a.paymentId, { allocationId: a.allocationId, amount: '50.00' });
    assert.deepEqual(figsOf(await t.figs(a.allocationId)), ['5000', '3500', '2500', '0', '1000']);
    const queues = await hsa.hsaQueues(t.db.pool, t.actor, {});
    assert.deepEqual(queues.needsReview.map((x) => x.allocationId), [a.allocationId]);
    // Frozen: no new claim or external receipt, however small. Real receipts stay.
    await assert.rejects(t.claim([{ allocationId: a.allocationId, amount: '0.01' }]), code('conflict'));
    await assert.rejects(t.external([{ allocationId: a.allocationId, amount: '0.01' }]), code('conflict'));
    const rows = (await hsa.getHsaAllocationDetail(t.db.pool, t.actor, a.allocationId)).entries;
    assert.deepEqual(rows.map((r) => r.kind), ['reserve', 'receipt'], 'history is untouched');
    // More cash may still be received on the open reservation (it is real); the excess stays visible.
    await t.receipt([{ lineId: line.lineId, amount: '5.00' }]);
    assert.deepEqual(figsOf(await t.figs(a.allocationId)), ['5000', '3000', '3000', '0', '1000']);
    // Resolve: cancel the remaining reservation. Received ($30) is below the $50 ceiling again, so the freeze lifts.
    await t.release(line.lineId, 'cancel');
    assert.deepEqual(figsOf(await t.figs(a.allocationId)), ['5000', '0', '3000', '2000', '0']);
    await t.claim([{ allocationId: a.allocationId, amount: '20.00' }]);
    // A refund reversal restores the cash and the ceiling.
    const refundEvent = (await t.payment(a.paymentId)).refunds[0].eventId;
    await pay.reverseRefund(t.db.pool, t.actor, { idempotencyKey: t.key(), eventId: refundEvent, effectiveDate: '2026-06-01', reason: 'Refund was recorded twice' }, 'r');
    assert.deepEqual(figsOf(await t.figs(a.allocationId)), ['10000', '2000', '3000', '5000', '0']);
    await assertReconciles(t, a.allocationId);

    // Allocation reversal (cash moved back to unapplied) is the same review case.
    const b = await t.alloc({ bill: '80.00', paid: '80.00' });
    await t.decide(b.allocationId, 'eligible', '80.00');
    const cb = await t.claim([{ allocationId: b.allocationId, amount: '80.00' }]);
    await pay.reverseAllocation(t.db.pool, t.actor, { idempotencyKey: t.key(), allocationId: b.allocationId, amount: '30.00', effectiveDate: '2026-05-01', reason: 'Wrong bill' }, 'r');
    assert.deepEqual(figsOf(await t.figs(b.allocationId)), ['5000', '8000', '0', '0', '3000']);
    await t.release((await t.line(cb.id)).lineId, 'reject', { amount: '30.00' });
    assert.deepEqual(figsOf(await t.figs(b.allocationId)), ['5000', '5000', '0', '0', '0']);

    // Eligible ceiling reduction by a new decision: prior receipts are kept, duplicates and new claims are refused.
    const c = await t.alloc({ bill: '100.00', paid: '100.00' });
    await t.decide(c.allocationId, 'eligible', '60.00');
    const cc = await t.claim([{ allocationId: c.allocationId, amount: '40.00' }]);
    await t.receipt([{ lineId: (await t.line(cc.id)).lineId, amount: '20.00' }]);
    await t.claim([{ allocationId: c.allocationId, amount: '20.00' }]);
    assert.deepEqual(figsOf(await t.figs(c.allocationId)), ['6000', '4000', '2000', '0', '0']);
    await t.decide(c.allocationId, 'eligible', '35.00', { rationale: 'Only part of the visit qualified' });
    assert.deepEqual(figsOf(await t.figs(c.allocationId)), ['3500', '4000', '2000', '0', '2500']);
    assert.equal((await hsa.getHsaAllocationDetail(t.db.pool, t.actor, c.allocationId)).decisions.length, 2);
    await assert.rejects(t.claim([{ allocationId: c.allocationId, amount: '1.00' }]), code('conflict'));
    await t.decide(c.allocationId, 'eligible', '60.00', { rationale: 'Evidence found for the rest' });
    assert.deepEqual(figsOf(await t.figs(c.allocationId)), ['6000', '4000', '2000', '0', '0']);
    // Audit keeps the before and after money trail for the review states.
    const audit = await t.audit('hsa.reserved');
    assert.ok(audit.every((r) => r.detail.pendingBeforeCents !== undefined && r.detail.pendingAfterCents !== undefined && r.detail.needsReviewAfterCents !== undefined));
    for (const x of [a, b, c]) await assertReconciles(t, x.allocationId);
  } finally {
    await t.db.drop();
  }
});

test('concurrent claims, refunds, receipts and releases: opposing multi-payment writers do not deadlock and nothing is over-reserved', { skip: skipDb }, async () => {
  const t = await fixture();
  try {
    const allocs = [];
    for (let i = 0; i < 4; i++) {
      const x = await t.alloc({ bill: '100.00', paid: '100.00', paidOn: `2026-04-0${i + 1}` });
      await t.decide(x.allocationId, 'eligible', '100.00');
      allocs.push(x);
    }
    const before = { ...retryStats };
    const ops = [];
    // Opposing line orders across four payments, many at once, each wanting more than all of them can take together.
    for (let i = 0; i < 6; i++) {
      const order = i % 2 === 0 ? allocs : [...allocs].reverse();
      ops.push(t.claim(order.map((x) => ({ allocationId: x.allocationId, amount: '30.00' }))));
    }
    // Refunds and allocation reversals racing the claims, on the same payments (payments lock first, in the same order).
    for (const x of allocs) ops.push(t.refund(x.paymentId, { allocationId: x.allocationId, amount: '20.00' }));
    const settled = await Promise.allSettled(ops);
    for (const r of settled.filter((x) => x.status === 'rejected')) assert.ok(['conflict', 'stale_version'].includes(r.reason.code), String(r.reason.message ?? r.reason));
    assert.equal(retryStats.lockConflicts - before.lockConflicts, 0, 'no deadlock or serialization retry was needed');
    for (const x of allocs) {
      const f = await t.figs(x.allocationId);
      // Claims at most reached the ceiling at the time they were made; a later refund can only create review, never hide it.
      assert.ok(BigInt(f.pendingCents) <= 10000n);
      await assertReconciles(t, x.allocationId);
    }
    assert.equal(settled.slice(0, 6).filter((r) => r.status === 'fulfilled').length >= 1, true);

    // Receipts and releases race on the same lines: pending never goes below zero.
    const x = await t.alloc({ bill: '100.00', paid: '100.00' });
    await t.decide(x.allocationId, 'eligible', '100.00');
    const claim = await t.claim([{ allocationId: x.allocationId, amount: '100.00' }]);
    const line = await t.line(claim.id);
    const race = await Promise.allSettled([
      ...Array.from({ length: 6 }, () => t.receipt([{ lineId: line.lineId, amount: '30.00' }])),
      ...Array.from({ length: 4 }, () => t.release(line.lineId, 'cancel', { amount: '30.00' })),
    ]);
    for (const r of race.filter((y) => y.status === 'rejected')) assert.equal(r.reason.code, 'conflict');
    const f = await t.figs(x.allocationId);
    assert.ok(BigInt(f.pendingCents) >= 0n && BigInt(f.receivedCents) >= 0n);
    const l = await t.line(claim.id);
    assert.equal(BigInt(l.pendingCents) + BigInt(l.receivedGrossCents) + BigInt(l.canceledCents), 10000n, 'the line always adds up to what was reserved');
    await assertReconciles(t, x.allocationId);
    assert.equal(retryStats.lockConflicts - before.lockConflicts, 0);
  } finally {
    await t.db.drop();
  }
});

test('database guards: raw writers cannot over-reserve, over-pay, skip evidence, edit or delete, even concurrently', { skip: skipDb }, async () => {
  const t = await fixture();
  try {
    const hh = t.actor.householdId;
    const u = t.actor.userId;
    const pool = t.db.pool;
    const a = await t.alloc({ bill: '100.00', paid: '100.00' });
    await t.decide(a.allocationId, 'eligible', '60.00');
    const claim = await t.claim([{ allocationId: a.allocationId, amount: '10.00' }]);
    const line = await t.line(claim.id);
    const entry = async (db, o) => db.query(
      `insert into hsa_entries (id, household_id, payment_id, allocation_id, bill_id, event_id, kind, claim_id, line_id, receipt_id, reverses_entry_id, amount_cents, effective_date, created_by)
       values ($1, $2, $3, $4, $5, gen_random_uuid(), $6, $7, $8, $9, $10, $11, '2026-05-01', $12)`,
      [o.id ?? randomUUID(), hh, a.paymentId, a.allocationId, a.bill.id, o.kind, o.claimId ?? null, o.lineId ?? null, o.receiptId ?? null, o.reverses ?? null, o.cents, u]);
    const newClaim = async (db) => { const id = randomUUID(); await db.query(`insert into hsa_claims (id, household_id, submitted_on, administrator, created_by) values ($1, $2, '2026-05-01', 'Example HSA Bank', $3)`, [id, hh, u]); return id; };
    const reserve = async (db, cents) => { const id = randomUUID(); const c = await newClaim(db); await entry(db, { id, kind: 'reserve', claimId: c, lineId: id, cents }); };
    // A direct reservation above the ceiling fails at commit.
    await assert.rejects(reserve(pool, 5001), /exceed the eligible ceiling/);
    // Concurrent raw reservations: only what fits is committed ($50 is left of $60; ten raw $10 writers, five fit).
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => reserve(pool, 1000)));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 5);
    for (const r of results.filter((x) => x.status === 'rejected')) assert.match(r.reason.message, /exceed the eligible ceiling/);
    assert.deepEqual(figsOf(await t.figs(a.allocationId)), ['6000', '6000', '0', '0', '0']);
    // A line cannot be paid or released beyond its reservation, nor a receipt left unallocated or partly reversed.
    // Each attempt runs in one transaction with its receipt header, since a header alone is refused at commit.
    const withReceipt = async (cents, fn) => {
      const c = await pool.connect();
      const rid = randomUUID();
      try {
        await c.query('begin');
        await c.query(`insert into hsa_receipts (id, household_id, received_on, amount_cents, origin, source, created_by) values ($1, $2, '2026-05-02', $3, 'claim', 'other', $4)`, [rid, hh, cents, u]);
        await fn(c, rid);
        await c.query('commit');
      } catch (e) {
        await c.query('rollback').catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    };
    await assert.rejects(withReceipt(1100, (c, rid) => entry(c, { kind: 'receipt', claimId: claim.id, lineId: line.lineId, receiptId: rid, cents: 1100 })), /beyond its reservation/);
    await assert.rejects(entry(pool, { kind: 'cancel', claimId: claim.id, lineId: line.lineId, cents: 1001 }), /beyond its reservation/);
    // A receipt header with no entries, or with entries that do not add up, never commits.
    await assert.rejects(withReceipt(1000, async () => {}), /allocated in full/);
    await assert.rejects(withReceipt(1000, (c, rid) => entry(c, { kind: 'receipt', claimId: claim.id, lineId: line.lineId, receiptId: rid, cents: 400 })), /allocated in full/);
    await assert.rejects(withReceipt(1000, (c, rid) => entry(c, { kind: 'receipt', claimId: randomUUID(), lineId: line.lineId, receiptId: rid, cents: 1000 })), /foreign key|same claim/);
    assert.equal(await t.count('hsa_receipts'), 0, 'no orphan receipt header was left behind');
    // Kind and reference rules: wrong receipt origin, reversing a non-receipt.
    await assert.rejects(withReceipt(1000, (c, rid) => entry(c, { kind: 'external_receipt', receiptId: rid, cents: 1000 })), /receipt does not match/);
    await assert.rejects(withReceipt(1000, (c, rid) => entry(c, { kind: 'receipt_reversal', receiptId: rid, reverses: line.lineId, cents: 1000 })), /exactly offset|foreign key/);
    // Evidence: an external receipt without evidence, and a decision without evidence.
    await assert.rejects(pool.query(`insert into hsa_receipts (id, household_id, received_on, amount_cents, origin, source, created_by) values (gen_random_uuid(), $1, '2026-05-02', 100, 'external', 'other', $2)`, [hh, u]), /check/);
    await assert.rejects(pool.query(
      `insert into hsa_eligibility_decisions (id, household_id, payment_id, allocation_id, bill_id, status, eligible_cents, rationale, decided_on, created_by)
       values (gen_random_uuid(), $1, $2, $3, $4, 'eligible', 100, 'x', '2026-05-01', $5)`, [hh, a.paymentId, a.allocationId, a.bill.id, u]), /check/);
    // A decision above the net cash is refused at commit; a decision on a non-allocation entry is refused.
    await assert.rejects(pool.query(
      `insert into hsa_eligibility_decisions (id, household_id, payment_id, allocation_id, bill_id, status, eligible_cents, rationale, evidence_type, evidence_note, decided_on, created_by)
       values (gen_random_uuid(), $1, $2, $3, $4, 'eligible', 10001, 'x', 'receipt', 'y', '2026-05-01', $5)`, [hh, a.paymentId, a.allocationId, a.bill.id, u]), /net cash/);
    // Immutability, including truncate (needs a committed receipt to act on).
    await t.receipt([{ lineId: line.lineId, amount: '1.00' }]);
    for (const table of ['hsa_entries', 'hsa_claims', 'hsa_receipts', 'hsa_eligibility_decisions']) {
      await assert.rejects(pool.query(`update ${table} set household_id = household_id`), /append-only/);
      await assert.rejects(pool.query(`delete from ${table}`), /append-only/);
      await assert.rejects(pool.query(`truncate ${table} cascade`), /append-only/);
    }
    // Another household cannot reference this allocation.
    const h2 = (await pool.query(`insert into households (name) values ('Other Family') returning id`)).rows[0].id;
    const c2 = randomUUID();
    await pool.query(`insert into hsa_claims (id, household_id, submitted_on, administrator, created_by) values ($1, $2, '2026-05-01', 'x', $3)`, [c2, h2, u]);
    await assert.rejects(pool.query(
      `insert into hsa_entries (id, household_id, payment_id, allocation_id, bill_id, event_id, kind, claim_id, line_id, amount_cents, effective_date, created_by)
       values ($1, $2, $3, $4, $5, gen_random_uuid(), 'reserve', $6, $1, 100, '2026-05-01', $7)`, [randomUUID(), h2, a.paymentId, a.allocationId, a.bill.id, c2, u]), /payment allocation|foreign key/);
  } finally {
    await t.db.drop();
  }
});

test('a refund racing a claim and raw refund writers leave pending plus received explainable: the guard sees the committed net cash', { skip: skipDb }, async () => {
  const t = await fixture();
  try {
    const pool = t.db.pool;
    const a = await t.alloc({ bill: '100.00', paid: '100.00' });
    await t.decide(a.allocationId, 'eligible', '100.00');
    // Raw writers: a claim and a refund in separate transactions, both opened before either commits. Whichever commits second
    // is checked against the other's committed rows after taking the payment lock.
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      const hh = t.actor.householdId;
      const u = t.actor.userId;
      await c1.query('begin');
      await c2.query('begin');
      const cid = randomUUID();
      await c1.query(`insert into hsa_claims (id, household_id, submitted_on, administrator, created_by) values ($1, $2, '2026-05-01', 'Example HSA Bank', $3)`, [cid, hh, u]);
      const rid = randomUUID();
      await c1.query(
        `insert into hsa_entries (id, household_id, payment_id, allocation_id, bill_id, event_id, kind, claim_id, line_id, amount_cents, effective_date, created_by)
         values ($1, $2, $3, $4, $5, gen_random_uuid(), 'reserve', $6, $1, 8000, '2026-05-01', $7)`, [rid, hh, a.paymentId, a.allocationId, a.bill.id, cid, u]);
      await c2.query(
        `insert into payment_entries (id, household_id, payment_id, event_id, kind, bill_id, allocation_id, amount_cents, effective_date, created_by)
         values (gen_random_uuid(), $1, $2, gen_random_uuid(), 'refund', $3, $4, -5000, '2026-05-01', $5)`, [hh, a.paymentId, a.bill.id, a.allocationId, u]);
      await c2.query('commit');
      // The claim now fails its commit-time check: the allocation only holds $50 and the ceiling follows net cash.
      await assert.rejects(c1.query('commit'), /exceed the eligible ceiling/);
    } finally {
      await c1.query('rollback').catch(() => {});
      c1.release();
      c2.release();
    }
    assert.deepEqual(figsOf(await t.figs(a.allocationId)), ['5000', '0', '0', '5000', '0']);
    // The other order is allowed and lands in needs review.
    const b = await t.alloc({ bill: '100.00', paid: '100.00' });
    await t.decide(b.allocationId, 'eligible', '100.00');
    await t.claim([{ allocationId: b.allocationId, amount: '80.00' }]);
    await t.refund(b.paymentId, { allocationId: b.allocationId, amount: '50.00' });
    assert.deepEqual(figsOf(await t.figs(b.allocationId)), ['5000', '8000', '0', '0', '3000']);
  } finally {
    await t.db.drop();
  }
});

test('reports: totals equal the sum of allocations and of the event history, filters scope them, and the export reconciles', { skip: skipDb }, async () => {
  const t = await fixture();
  try {
    const m2 = await t.member('Sam Example');
    const a = await t.alloc({ bill: '100.00', paid: '100.00', paidOn: '2026-03-01' });
    const b2 = await t.bill({ memberId: m2, providerId: t.p, originalAmount: '50.00' });
    const pm2 = await t.pay1({ amount: '50.00', paidOn: '2026-06-01', billId: b2.id });
    const alloc2 = (await t.payment(pm2.id)).allocations[0].allocationId;
    await t.decide(a.allocationId, 'eligible', '70.00');
    await t.decide(alloc2, 'eligible', '50.00');
    const c1 = await t.claim([{ allocationId: a.allocationId, amount: '40.00' }, { allocationId: alloc2, amount: '25.00' }]);
    const aLine = (await hsaRepo.linesOfClaim(t.db.pool, t.actor.householdId, c1.id)).find((l) => l.allocationId === a.allocationId);
    await t.receipt([{ lineId: aLine.lineId, amount: '15.00' }]);
    await t.external([{ allocationId: alloc2, amount: '10.00' }]);
    const undecided = await t.alloc({ bill: '30.00', paid: '30.00', paidOn: '2026-03-15' });
    const all = await hsa.hsaSummary(t.db.pool, t.actor, {});
    const rows = (await hsa.listHsaAllocations(t.db.pool, t.actor, { limit: '100' })).items;
    assert.equal(rows.length, 3);
    for (const k of ['ceilingCents', 'pendingCents', 'receivedCents', 'availableCents', 'needsReviewCents']) {
      const key = { ceilingCents: 'eligibleCents' }[k] ?? k;
      assert.equal(all[key], rows.reduce((s, r) => s + BigInt(r[k]), 0n).toString(), k);
    }
    assert.equal(all.undecidedCount, 1);
    // Event history rebuilds the same pending and received totals.
    const events = (await t.db.pool.query(`select kind, amount_cents from hsa_entries`)).rows;
    const pend = events.reduce((s, e) => s + BigInt(e.amount_cents) * ({ reserve: 1n, receipt: -1n, reject: -1n, cancel: -1n }[e.kind] ?? 0n), 0n);
    const recv = events.reduce((s, e) => s + BigInt(e.amount_cents) * ({ receipt: 1n, external_receipt: 1n, receipt_reversal: -1n }[e.kind] ?? 0n), 0n);
    assert.deepEqual([all.pendingCents, all.receivedCents], [pend.toString(), recv.toString()]);
    // Filters scope the totals and the list consistently.
    const sam = await hsa.hsaSummary(t.db.pool, t.actor, { memberId: m2 });
    assert.deepEqual([sam.eligibleCents, sam.pendingCents, sam.receivedCents, sam.availableCents], ['5000', '2500', '1000', '1500']);
    const dated = await hsa.hsaSummary(t.db.pool, t.actor, { from: '2026-05-01', to: '2026-06-30' });
    assert.deepEqual(dated, sam);
    const filtered = await hsa.listHsaAllocations(t.db.pool, t.actor, { state: 'available', limit: '100' });
    assert.ok(filtered.items.every((r) => BigInt(r.availableCents) > 0n));
    assert.deepEqual((await hsa.listHsaAllocations(t.db.pool, t.actor, { state: 'undecided' })).items.map((r) => r.allocationId), [undecided.allocationId]);
    // Cursor paging follows the newest-first order without losing or repeating a row.
    const p1 = await hsa.listHsaAllocations(t.db.pool, t.actor, { limit: '2' });
    const p2 = await hsa.listHsaAllocations(t.db.pool, t.actor, { limit: '2', cursor: p1.nextCursor });
    assert.deepEqual([...p1.items, ...p2.items].map((r) => r.allocationId), rows.map((r) => r.allocationId));
    assert.equal(p2.nextCursor, null);
    const figures = await listHsaFigures(t.db.pool, t.actor, { memberId: m2 });
    assert.deepEqual(figures.items.map((r) => [r.allocationId, r.availableCents]), [[alloc2, '1500']]);
    // Export: the allocation rows plus a TOTAL row that equals the sum; the events rebuild pending and received; formulas are neutralized.
    const exp = await hsa.exportHsa(t.db.pool, t.actor, {}, 'r');
    const lines = exp.csv.trim().split('\r\n');
    const total = lines.at(-1).split(',');
    assert.equal(total[0], 'TOTAL');
    assert.deepEqual([total[8], total[9], total[10], total[11]], [all.eligibleCents, all.pendingCents, all.receivedCents, all.availableCents]);
    const ev = await hsa.exportHsa(t.db.pool, t.actor, { kind: 'events' }, 'r');
    const evLines = ev.csv.trim().split('\r\n').slice(1).map((l) => l.split(','));
    assert.equal(evLines.length, events.length);
    assert.equal(evLines.reduce((s, c) => s + BigInt(c[14]), 0n).toString(), pend.toString());
    assert.equal(evLines.reduce((s, c) => s + BigInt(c[15]), 0n).toString(), recv.toString());
    const scoped = await hsa.exportHsa(t.db.pool, t.actor, { kind: 'events', memberId: m2 }, 'r');
    assert.equal(scoped.rows, 2, 'the scoped export holds only that member\'s entries (one reserve and one external receipt)');
    const decisions = await hsa.exportHsa(t.db.pool, t.actor, { kind: 'decisions' }, 'r');
    assert.equal(decisions.rows, 2);
    await assert.rejects(hsa.exportHsa(t.db.pool, t.actor, { kind: 'nope' }, 'r'), code('invalid_input'));
    const evil = await t.member('=HYPERLINK("http://example.test","x")');
    const eb = await t.bill({ memberId: evil, providerId: t.p, originalAmount: '10.00' });
    const ep = await t.pay1({ amount: '10.00', billId: eb.id });
    const ea = (await t.payment(ep.id)).allocations[0].allocationId;
    await t.decide(ea, 'eligible', '10.00');
    const csv = (await hsa.exportHsa(t.db.pool, t.actor, { memberId: evil }, 'r')).csv;
    assert.ok(csv.includes(`"'=HYPERLINK(""http://example.test"",""x"")"`), csv);
    const auditExport = await t.audit('hsa.exported');
    assert.ok(auditExport.length >= 4 && auditExport.every((r) => r.detail.rows !== undefined));
  } finally {
    await t.db.drop();
  }
});

test('access boundaries, form posts and the export route', { skip: skipDb }, async () => {
  const t = await fixture();
  try {
    const a = await t.alloc({ bill: '100.00', paid: '100.00' });
    await t.decide(a.allocationId, 'eligible', '60.00');
    const claim = await t.claim([{ allocationId: a.allocationId, amount: '20.00' }]);
    const line = await t.line(claim.id);
    const h2 = (await t.db.pool.query(`insert into households (name) values ('Other Family') returning id`)).rows[0].id;
    const u2 = (await t.db.pool.query(
      `insert into users (household_id, email, display_name, role, password_hash) values ($1, 'other@example.test', 'Other Admin', 'admin', 'x') returning id`, [h2])).rows[0].id;
    const outsider = { userId: u2, householdId: h2, role: 'admin', displayName: 'Other Admin', sessionId: randomUUID() };
    await assert.rejects(hsa.getHsaAllocationDetail(t.db.pool, outsider, a.allocationId), code('not_found'));
    await assert.rejects(hsa.getHsaClaimDetail(t.db.pool, outsider, claim.id), code('not_found'));
    await assert.rejects(hsa.recordDecision(t.db.pool, outsider, { idempotencyKey: t.key(), allocationId: a.allocationId, version: '1', status: 'ineligible', rationale: 'x', evidenceType: 'other', evidenceNote: 'y', decidedOn: '2026-05-01' }, 'r'), code('not_found'));
    await assert.rejects(hsa.submitClaim(t.db.pool, outsider, { idempotencyKey: t.key(), submittedOn: '2026-05-01', administrator: 'x', lines: [{ allocationId: a.allocationId, amount: '1' }] }, 'r'), code('not_found'));
    await assert.rejects(hsa.recordReceipt(t.db.pool, outsider, { idempotencyKey: t.key(), receivedOn: '2026-05-01', source: 'other', lines: [{ lineId: line.lineId, amount: '1' }] }, 'r'), code('not_found'));
    await assert.rejects(hsa.releaseClaimLine(t.db.pool, outsider, { idempotencyKey: t.key(), lineId: line.lineId, kind: 'cancel', effectiveDate: '2026-05-01', reason: 'x' }, 'r'), code('not_found'));
    assert.equal((await hsa.listHsaAllocations(t.db.pool, outsider, {})).items.length, 0);
    assert.equal((await hsa.hsaSummary(t.db.pool, outsider, {})).eligibleCents, '0');
    assert.equal((await hsa.exportHsa(t.db.pool, outsider, {}, 'r')).rows, 0);
    assert.deepEqual(figsOf(await t.figs(a.allocationId)), ['6000', '2000', '0', '4000', '0'], 'the outsider changed nothing');
    // Form posts go through the shared pipeline: CSRF, redirects with no values in the URL, errors back to the same page.
    const token = t.cookie.split('=')[1];
    const form = (action, b) => handlers.handleExpenseAction(post(`/api/expenses/${action}`, { ...b, csrf: csrfFor(token) }, { cookie: t.cookie, html: true }), t.ctx, action);
    const noCsrf = await handlers.handleExpenseAction(post('/api/expenses/hsa/claim', { idempotencyKey: t.key() }, { cookie: t.cookie, html: true }), t.ctx, 'hsa/claim');
    assert.equal(new URL(noCsrf.headers.get('location')).searchParams.get('error'), 'csrf_failed');
    const ok = await form('hsa/claim', { idempotencyKey: t.key(), allocationId: a.allocationId, amount: '10.00', submittedOn: '2026-05-02', administrator: 'Example HSA Bank', reference: 'CLM-WEB-1' });
    assert.equal(ok.status, 303);
    assert.match(ok.headers.get('location'), /\/hsa\/claims\/[0-9a-f-]{36}$/);
    assert.ok(!ok.headers.get('location').includes('CLM-WEB-1'));
    const bad = await form('hsa/claim', { idempotencyKey: t.key(), allocationId: a.allocationId, amount: '1000.00', submittedOn: '2026-05-02', administrator: 'Example HSA Bank', reference: 'CLM-SECRET-2' });
    const loc = new URL(bad.headers.get('location'));
    assert.deepEqual([loc.pathname, [...loc.searchParams.keys()]], [`/hsa/allocations/${a.allocationId}`, ['error']]);
    assert.ok(!bad.headers.get('location').includes('CLM-SECRET'), 'typed values travel in the flash cookie, not the URL');
    const rec = await form('hsa/receipt', { idempotencyKey: t.key(), claimId: claim.id, lineId: line.lineId, amount: '5.00', receivedOn: '2026-05-03', source: 'administrator_transfer' });
    assert.match(rec.headers.get('location'), /\/hsa\/receipts\/[0-9a-f-]{36}$/);
    const ext = await form('hsa/external-receipt', { idempotencyKey: t.key(), allocationId: a.allocationId, amount: '5.00', receivedOn: '2026-05-03', source: 'hsa_debit_card', evidenceType: 'statement', evidenceNote: 'Card line' });
    assert.match(ext.headers.get('location'), /\/hsa\/receipts\/[0-9a-f-]{36}$/);
    const dec = await form('hsa/decide', { idempotencyKey: t.key(), allocationId: a.allocationId, version: '1', status: 'ineligible', rationale: 'Reviewed again', evidenceType: 'eob', evidenceNote: 'EOB 2', decidedOn: '2026-05-04' });
    assert.equal(dec.headers.get('location'), `https://tallymed.test/hsa/allocations/${a.allocationId}`);
    const rel = await form('hsa/release', { idempotencyKey: t.key(), claimId: claim.id, lineId: line.lineId, kind: 'cancel', effectiveDate: '2026-05-05', reason: 'Withdrawn' });
    assert.equal(rel.headers.get('location'), `https://tallymed.test/hsa/claims/${claim.id}`);
    const anon = await handlers.handleHsaExport(new Request('http://app.internal:3000/api/hsa/export'), t.ctx);
    assert.equal(anon.status, 401);
    const res = await handlers.handleHsaExport(new Request('http://app.internal:3000/api/hsa/export?kind=allocations', { headers: { cookie: t.cookie } }), t.ctx);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(await res.text(), /^allocation_id,/);
    const post405 = await handlers.handleHsaExport(new Request('http://app.internal:3000/api/hsa/export', { method: 'POST', headers: { cookie: t.cookie } }), t.ctx);
    assert.equal(post405.status, 400);
    const badScope = await handlers.handleHsaExport(new Request('http://app.internal:3000/api/hsa/export?memberId=nope', { headers: { cookie: t.cookie } }), t.ctx);
    assert.equal(badScope.status, 400);
  } finally {
    await t.db.drop();
  }
});

test('upgrade over payment data from the prior schema: existing allocations start undecided and HSA works on them', { skip: skipDb }, async () => {
  const db = await freshDatabase({ migrateAll: false });
  try {
    await migrate(db.pool, { upTo: '0005' });
    const config = testConfig({}, db.url);
    const ctx = { config, pool: db.pool };
    await seedHousehold(db.pool);
    const { cookie } = await loginJson(handlers, ctx, 'admin@example.test');
    const actor = await authenticate(db.pool, config, cookie.split('=')[1]);
    const m = (await svc.createMember(db.pool, actor, { name: 'Pat Example' }, 'r')).id;
    const p = (await svc.createProvider(db.pool, actor, { name: 'Example Clinic', kind: 'clinician' }, 'r')).id;
    const b = await svc.createBill(db.pool, actor, { idempotencyKey: randomUUID(), memberId: m, providerId: p, statementDate: '2026-01-05', originalAmount: '120.00', amountStatus: 'confirmed', amountSource: 'statement' }, 'r');
    const pm = await pay.recordPayment(db.pool, actor, { idempotencyKey: randomUUID(), paidOn: '2026-04-01', amount: '75.00', method: 'card', billId: b.id }, 'r');
    const refundable = (await pay.getPaymentDetail(db.pool, actor, pm.id)).allocations[0];
    await pay.recordRefund(db.pool, actor, { idempotencyKey: randomUUID(), paymentId: pm.id, allocationId: refundable.allocationId, amount: '15.00', effectiveDate: '2026-05-01', reason: 'Provider refund' }, 'r');
    assert.deepEqual(await migrate(db.pool), ['0006']);
    const a = await hsaRepo.getAllocation(db.pool, actor.householdId, refundable.allocationId);
    assert.deepEqual([a.netCents, a.decisionStatus, ...figsOf(a)], ['6000', null, '0', '0', '0', '0', '0']);
    await hsa.recordDecision(db.pool, actor, { idempotencyKey: randomUUID(), allocationId: a.allocationId, version: '0', status: 'eligible', eligibleAmount: '60.00', rationale: 'Qualified', evidenceType: 'eob', evidenceNote: 'EOB', decidedOn: '2026-05-02' }, 'r');
    const c = await hsa.submitClaim(db.pool, actor, { idempotencyKey: randomUUID(), submittedOn: '2026-05-03', administrator: 'Example HSA Bank', lines: [{ allocationId: a.allocationId, amount: '60.00' }] }, 'r');
    assert.ok(c.id);
    assert.deepEqual(figsOf(await hsaRepo.getAllocation(db.pool, actor.householdId, a.allocationId)), ['6000', '6000', '0', '0', '0']);
    assert.equal(billContract(await svc.getBillDetail(db.pool, actor, b.id).then((d) => d.bill)).openBalanceCents, '6000', 'only the payment refund moved the provider balance');
  } finally {
    await db.drop();
  }
});

test('review follow-ups: status follows net received, mixed-up form ids are refused, the figures contract caps its page, and a received filter exists', { skip: skipDb }, async () => {
  const t = await fixture();
  try {
    const a = await t.alloc({ bill: '100.00', paid: '100.00' });
    const b = await t.alloc({ bill: '100.00', paid: '100.00' });
    await t.decide(a.allocationId, 'eligible', '100.00');
    await t.decide(b.allocationId, 'eligible', '100.00');
    const c1 = await t.claim([{ allocationId: a.allocationId, amount: '40.00' }]);
    const c2 = await t.claim([{ allocationId: b.allocationId, amount: '30.00' }]);
    const l1 = await t.line(c1.id);
    const l2 = await t.line(c2.id);
    // A fully reversed receipt no longer reads as fulfilled, and the claim is closed with nothing received.
    const full = await t.receipt([{ lineId: l1.lineId, amount: '40.00' }]);
    assert.equal((await t.line(c1.id)).status, 'fulfilled');
    await t.reverse(full.id);
    const after = await t.line(c1.id);
    assert.deepEqual([after.status, after.receivedCents, after.pendingCents], ['reversed', '0', '0']);
    const claim = await hsa.getHsaClaimDetail(t.db.pool, t.actor, c1.id);
    assert.deepEqual([claim.claim.receivedCents, claim.claim.open], ['0', false]);
    // A partly reversed line (paid in two receipts, one reversed) is partially fulfilled; a reversal with pending left is submitted.
    const r1 = await t.receipt([{ lineId: l2.lineId, amount: '10.00' }]);
    await t.receipt([{ lineId: l2.lineId, amount: '5.00' }]);
    await t.reverse(r1.id);
    assert.deepEqual([(await t.line(c2.id)).status, (await t.line(c2.id)).receivedCents], ['partially_fulfilled', '500']);
    const c3 = await t.claim([{ allocationId: a.allocationId, amount: '10.00' }]);
    const r3 = await t.receipt([{ lineId: (await t.line(c3.id)).lineId, amount: '4.00' }]);
    await t.reverse(r3.id);
    assert.equal((await t.line(c3.id)).status, 'submitted');
    // Mixed-up claim or payment ids on a form are refused instead of silently ignored.
    await assert.rejects(hsa.releaseClaimLine(t.db.pool, t.actor, { idempotencyKey: t.key(), claimId: c1.id, lineId: l2.lineId, kind: 'cancel', effectiveDate: '2026-05-01', reason: 'x' }, 'r'), code('invalid_input'));
    await assert.rejects(hsa.releaseClaimLine(t.db.pool, t.actor, { idempotencyKey: t.key(), allocationId: a.allocationId, lineId: l2.lineId, kind: 'cancel', effectiveDate: '2026-05-01', reason: 'x' }, 'r'), code('invalid_input'));
    await assert.rejects(t.receipt([{ lineId: l2.lineId, amount: '1.00' }], { claimId: c1.id }), code('invalid_input'));
    await assert.rejects(t.reverse(r1.id, { allocationId: a.allocationId }), code('invalid_input'));
    await hsa.releaseClaimLine(t.db.pool, t.actor, { idempotencyKey: t.key(), claimId: c2.id, allocationId: b.allocationId, lineId: l2.lineId, kind: 'cancel', effectiveDate: '2026-05-01', reason: 'Matching ids work' }, 'r');
    // The figures contract caps an oversized page limit instead of rejecting it.
    const page = await listHsaFigures(t.db.pool, t.actor, { limit: 500 });
    assert.equal(page.items.length, 2);
    assert.equal((await listHsaFigures(t.db.pool, t.actor, { limit: 0 })).items.length, 1);
    // The received filter lists allocations with reimbursements received.
    assert.deepEqual((await hsa.listHsaAllocations(t.db.pool, t.actor, { state: 'received' })).items.map((r) => r.allocationId), [b.allocationId]);
  } finally {
    await t.db.drop();
  }
});
