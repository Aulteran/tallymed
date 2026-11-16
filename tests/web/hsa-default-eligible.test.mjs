// Default-eligible HSA reimbursements and the payment-level ineligible marker (migration 0019). Fabricated data only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import * as handlers from '../../apps/web/server/http.ts';
import { csrfFor } from '../../apps/web/server/tokens.ts';
import { undo } from '../../apps/web/server/services/undo.ts';
import { ledgerSummary, ledgerViolations } from '../../apps/web/server/backup/ledger.ts';
import { listHsaFigures } from '../../apps/web/server/contracts.ts';
import * as hsaRepo from '../../apps/web/server/repositories/hsa.ts';
import * as acc from '../../apps/web/server/services/hsa-accounts.ts';
import * as hsa from '../../apps/web/server/services/hsa.ts';
import * as pm from '../../apps/web/server/services/payment-methods.ts';
import * as pay from '../../apps/web/server/services/payments.ts';
import { setup } from './money-helpers.mjs';
import { post, skipDb } from './helpers.mjs';

const code = (c) => ({ code: c });
const ids = async (t, paymentId) => (await t.payment(paymentId)).allocations.map((a) => a.allocationId);
const figs = (t, id) => hsaRepo.getAllocation(t.db.pool, t.actor.householdId, id);
const decide = (t, allocationId, status, amount) => hsa.recordDecision(t.db.pool, t.actor, {
  idempotencyKey: t.key(), allocationId, version: String(0), status, ...(amount ? { eligibleAmount: amount } : {}),
  rationale: 'Reviewed', evidenceType: 'receipt', evidenceNote: 'Receipt', decidedOn: '2026-04-05',
}, 'r');
const claim = (t, allocationId, amount) => hsa.submitClaim(t.db.pool, t.actor, { idempotencyKey: t.key(), submittedOn: '2026-04-10', administrator: 'Example HSA Bank', lines: [{ allocationId, amount }] }, 'r');
const external = (t, allocationId, amount) => hsa.recordExternalReceipt(t.db.pool, t.actor, {
  idempotencyKey: t.key(), receivedOn: '2026-04-21', source: 'hsa_debit_card', evidenceType: 'statement', evidenceNote: 'Statement line', lines: [{ allocationId, amount }] }, 'r');
const inTx = async (t, fn) => {
  const c = await t.db.pool.connect();
  try { await c.query('begin'); await fn(c); await c.query('commit'); } catch (e) { await c.query('rollback').catch(() => undefined); throw e; } finally { c.release(); }
};
const marker = (c, t, paymentId) => c.query(`insert into payment_hsa_ineligible (payment_id, household_id, created_by) values ($1, $2, $3)`, [paymentId, t.actor.householdId, t.actor.userId]);
const funding = (c, t, paymentId, accountId) => c.query(`insert into payment_hsa_funding (payment_id, household_id, hsa_account_id, created_by) values ($1, $2, $3, $4)`, [paymentId, t.actor.householdId, accountId, t.actor.userId]);
/** A raw reservation (claim plus entry) in one transaction, so the commit-time guard alone judges it. */
const rawReserve = (t, a, cents) => inTx(t, async (c) => {
  const claimId = randomUUID(); const entryId = randomUUID();
  await hsaRepo.insertClaim(c, { id: claimId, householdId: t.actor.householdId, userId: t.actor.userId, submittedOn: '2026-04-10', administrator: 'Bank', reference: null, note: '' });
  await hsaRepo.insertEntry(c, { id: entryId, householdId: t.actor.householdId, userId: t.actor.userId, paymentId: a.paymentId, allocationId: a.allocationId, billId: a.billId, eventId: randomUUID(),
    kind: 'reserve', claimId, lineId: entryId, receiptId: null, amountCents: BigInt(cents), effectiveDate: '2026-04-10', reason: '' });
});
async function fixture() {
  const t = await setup();
  const m = await t.member(); const p = await t.provider();
  return { ...t, m, p, async paid(amount, o = {}) {
    const b = await t.bill({ memberId: m, providerId: p, originalAmount: amount });
    const pmt = await t.pay1({ amount, billId: b.id, allocateAmount: amount, ...o });
    return { id: pmt.id, allocationId: (await ids(t, pmt.id))[0], billId: b.id };
  } };
}
const account = async (t) => {
  const a = await acc.createHsaAccount(t.db.pool, t.actor, { name: 'Family HSA', administrator: 'Example HSA Bank', lastFour: '7788' }, 'r');
  const c = await pm.createPaymentMethod(t.db.pool, t.actor, { nickname: 'HSA Visa', kind: 'hsa_fsa_card', lastFour: '0042', hsaAccountId: a.id }, 'r');
  return { a, c };
};

test('a payment with no decision is eligible for its whole net cash: claim, external receipt, refund lowers the ceiling', { skip: skipDb }, async () => {
  const t = await fixture();
  try {
    const x = await t.paid('100.00');
    const f = await figs(t, x.allocationId);
    assert.deepEqual([f.decisionStatus, f.markedIneligible, f.ceilingCents, f.availableCents], [null, false, '10000', '10000']);
    await assert.rejects(claim(t, x.allocationId, '100.01'), code('conflict'));
    const c = await claim(t, x.allocationId, '60.00');
    assert.ok(c.id);
    await external(t, x.allocationId, '40.00');
    assert.deepEqual((await figs(t, x.allocationId)).availableCents, '0');
    assert.equal(await t.count('hsa_eligibility_decisions'), 0, 'no decision was needed');
    await t.refund(x.id, { allocationId: x.allocationId, amount: '30.00' });
    const g = await figs(t, x.allocationId);
    assert.deepEqual([g.netCents, g.ceilingCents, g.needsReviewCents], ['7000', '7000', '30' + '00']);
  } finally { await t.db.drop(); }
});

test('the ceiling rule: decisions, marker, pending and direct payments agree in the view, the commit-time guard and the backup totals', { skip: skipDb }, async () => {
  const t = await fixture();
  try {
    const { c } = await account(t);
    const none = await t.paid('50.00');
    const elig = await t.paid('50.00'); await decide(t, elig.allocationId, 'eligible', '20.00');
    const over = await t.paid('50.00'); await decide(t, over.allocationId, 'eligible', '50.00');
    const inel = await t.paid('50.00'); await decide(t, inel.allocationId, 'ineligible');
    const pend = await t.paid('50.00'); await decide(t, pend.allocationId, 'pending');
    const marked = await t.paid('50.00', { hsaIneligible: 'yes' });
    const direct = await t.paid('50.00', { paidWithId: c.id });
    const cases = [[none, '5000'], [elig, '2000'], [over, '5000'], [inel, '0'], [pend, '5000'], [marked, '0'], [direct, '0']];
    let sum = 0n;
    for (const [x, ceiling] of cases) {
      const f = await figs(t, x.allocationId);
      assert.equal(f.ceilingCents, ceiling, `view ceiling for ${x.allocationId}`);
      sum += BigInt(ceiling);
      const a = { paymentId: x.id, allocationId: x.allocationId, billId: x.billId };
      // The guard agrees: one cent above the ceiling is refused, the ceiling itself fits (a zero ceiling takes nothing, and the direct and marked
      // cases are refused by their own guards as well, which is fine: nothing can be reserved).
      await assert.rejects(rawReserve(t, a, BigInt(ceiling) + 1n), /exceed the eligible ceiling|paid directly|removed/);
      if (BigInt(ceiling) > 0n) { await rawReserve(t, a, ceiling); assert.equal((await figs(t, x.allocationId)).availableCents, '0'); }
    }
    assert.equal((await ledgerSummary(t.db.pool)).hsaEligibleCents, sum.toString(), 'the backup total reads the same view');
    const listed = (await listHsaFigures(t.db.pool, t.actor, { limit: 100 })).items;
    assert.equal(listed.reduce((s, r) => s + BigInt(r.ceilingCents), 0n), sum);
    assert.deepEqual(listed.filter((r) => r.markedIneligible).map((r) => r.paymentId), [marked.id]);
  } finally { await t.db.drop(); }
});

test('the marker: ceiling zero, claims and decisions refused, audited, written only at creation, immutable', { skip: skipDb }, async () => {
  const t = await fixture();
  try {
    const key = t.key();
    const b = await t.bill({ memberId: t.m, providerId: t.p, originalAmount: '80.00' });
    const first = await t.pay1({ idempotencyKey: key, amount: '100.00', billId: b.id, allocateAmount: '80.00', hsaIneligible: true });
    const replay = await t.pay1({ idempotencyKey: key, amount: '100.00', billId: b.id, allocateAmount: '80.00', hsaIneligible: true });
    assert.equal(replay.replayed, true);
    assert.equal(await t.count('payment_hsa_ineligible'), 1, 'a replay writes no second marker');
    const [al] = await ids(t, first.id);
    const f = await figs(t, al);
    assert.deepEqual([f.markedIneligible, f.ceilingCents, f.availableCents, f.decisionStatus], [true, '0', '0', null]);
    assert.equal((await t.payment(first.id)).payment.hsaIneligible, true);
    await assert.rejects(claim(t, al, '1.00'), /ineligible for HSA/);
    await assert.rejects(external(t, al, '1.00'), /ineligible for HSA/);
    await assert.rejects(decide(t, al, 'eligible', '10.00'), /ineligible for HSA/);
    // Cash applied later to another bill is still on a marked payment.
    const b2 = await t.bill({ memberId: t.m, providerId: t.p, originalAmount: '20.00' });
    await pay.allocatePayment(t.db.pool, t.actor, { idempotencyKey: t.key(), paymentId: first.id, billId: b2.id, allocateAmount: '20.00' }, 'r');
    for (const id of await ids(t, first.id)) assert.equal((await figs(t, id)).ceilingCents, '0');
    // An eligible decision written by raw SQL cannot lift a marker.
    await inTx(t, (c) => hsaRepo.insertDecision(c, { id: randomUUID(), householdId: t.actor.householdId, userId: t.actor.userId, paymentId: first.id, allocationId: al, billId: b.id,
      status: 'eligible', eligibleCents: 1000n, rationale: 'x', evidenceType: 'receipt', evidenceNote: 'x', contextNote: '', decidedOn: '2026-04-05' }));
    assert.equal((await figs(t, al)).ceilingCents, '0');
    const rec = (await t.audit('payment.recorded')).find((r) => r.detail.paymentId === first.id);
    assert.equal(rec.detail.hsaIneligible, true);
    const plain = await t.pay1({ amount: '10.00' });
    assert.equal((await t.audit('payment.recorded')).find((r) => r.detail.paymentId === plain.id).detail.hsaIneligible, false);
    assert.equal((await t.payment(plain.id)).payment.hsaIneligible, false);
    assert.equal(await t.count('payment_hsa_ineligible'), 1);
    await assert.rejects(t.db.pool.query(`update payment_hsa_ineligible set created_by = created_by`), /append-only|immutable/);
    await assert.rejects(t.db.pool.query(`delete from payment_hsa_ineligible`), /append-only|immutable/);
    await assert.rejects(t.db.pool.query(`truncate payment_hsa_ineligible`), /append-only|immutable/);
    // The export and the state filter see it.
    const csv = (await hsa.exportHsa(t.db.pool, t.actor, {}, 'r')).csv;
    assert.match(csv.split('\r\n')[0], /payment_marked_ineligible$/);
    assert.ok((await hsa.listHsaAllocations(t.db.pool, t.actor, { state: 'ineligible', limit: '100' })).items.some((r) => r.allocationId === al));
  } finally { await t.db.drop(); }
});

test('the marker is refused on a payment paid directly from an HSA, in the service and in the database, in both orders', { skip: skipDb }, async () => {
  const t = await fixture();
  try {
    const { a, c } = await account(t);
    const before = await t.count('payments');
    await assert.rejects(t.pay1({ amount: '30.00', paidWithId: c.id, hsaIneligible: 'yes' }), code('invalid_input'));
    assert.deepEqual([await t.count('payments'), await t.count('payment_hsa_ineligible'), await t.count('payment_hsa_funding')], [before, 0, 0], 'nothing was left behind');
    // Database: marker on a direct payment, funding on a marked payment, and both in one transaction in either order.
    const direct = await t.pay1({ amount: '30.00', paidWithId: c.id });
    await assert.rejects(inTx(t, (cl) => marker(cl, t, direct.id)), /cannot also be marked ineligible/);
    const marked = await t.pay1({ amount: '30.00', hsaIneligible: 'yes' });
    await assert.rejects(inTx(t, (cl) => funding(cl, t, marked.id, a.id)), /marked ineligible/);
    const fresh1 = await t.pay1({ amount: '5.00' }); const fresh2 = await t.pay1({ amount: '5.00' });
    await assert.rejects(inTx(t, async (cl) => { await marker(cl, t, fresh1.id); await funding(cl, t, fresh1.id, a.id); }), /marked ineligible for HSA cannot be paid directly|cannot also be marked ineligible/);
    await assert.rejects(inTx(t, async (cl) => { await funding(cl, t, fresh2.id, a.id); await marker(cl, t, fresh2.id); }), /marked ineligible for HSA cannot be paid directly|cannot also be marked ineligible/);
    // Releasing a direct funding makes the payment ordinary, so a marker fits; reinstating it afterwards is then refused.
    const ev = (cl, pid, action) => cl.query(`insert into payment_hsa_funding_events (household_id, payment_id, action, created_by) values ($1, $2, $3, $4)`, [t.actor.householdId, pid, action, t.actor.userId]);
    await inTx(t, (cl) => ev(cl, direct.id, 'release'));
    await inTx(t, (cl) => marker(cl, t, direct.id));
    await assert.rejects(inTx(t, (cl) => ev(cl, direct.id, 'reinstate')), /marked ineligible/);
    // Restored data that breaks the rule (triggers off) is named by the ledger checks.
    await t.db.pool.query('alter table payment_hsa_funding_events disable trigger user');
    await t.db.pool.query(`insert into payment_hsa_funding_events (household_id, payment_id, action, created_by) values ($1, $2, 'reinstate', $3)`, [t.actor.householdId, direct.id, t.actor.userId]);
    await t.db.pool.query('alter table payment_hsa_funding_events enable trigger user');
    assert.ok((await ledgerViolations(t.db.pool)).some((v) => /marked ineligible for HSA is not paid directly/.test(v)));
  } finally { await t.db.drop(); }
});

test('a payment with the marker can still be removed and the removal undone: the marker is not a decision', { skip: skipDb }, async () => {
  const t = await fixture();
  try {
    const x = await t.paid('40.00', { hsaIneligible: 'yes' });
    assert.equal(await t.count('hsa_eligibility_decisions'), 0);
    await pay.removePayment(t.db.pool, t.actor, { idempotencyKey: t.key(), paymentId: x.id, reason: 'Fabricated duplicate entry' }, 'r');
    assert.equal((await hsa.listHsaAllocations(t.db.pool, t.actor, { limit: '100' })).items.length, 0, 'a removed payment has no HSA row');
    assert.equal(await t.count('payment_hsa_ineligible'), 1, 'the marker row stays as history');
    // Undo re-posts the allocation as a new one; the marker belongs to the payment, so the restored allocation still has a zero ceiling.
    await undo(t.db.pool, t.actor, { idempotencyKey: t.key() }, 'r');
    const live = (await Promise.all((await ids(t, x.id)).map((id) => figs(t, id)))).filter((f) => f.netCents !== '0');
    assert.equal(live.length, 1);
    const g = live[0];
    assert.deepEqual([g.markedIneligible, g.ceilingCents, g.availableCents], [true, '0', '0']);
  } finally { await t.db.drop(); }
});

test('the payment form accepts the checkbox (on or yes) and a JSON boolean; an unchecked form leaves no marker', { skip: skipDb }, async () => {
  const t = await fixture();
  try {
    const token = t.cookie.split('=')[1];
    const send = (extra) => handlers.handleExpenseAction(
      post('/api/expenses/payments/create', { idempotencyKey: t.key(), paidOn: '2026-04-01', amount: '10.00', method: 'card', csrf: csrfFor(token), ...extra }, { cookie: t.cookie, html: true }), t.ctx, 'payments/create');
    for (const extra of [{ hsaIneligible: 'on' }, { hsaIneligible: 'yes' }, {}]) assert.ok([200, 302, 303].includes((await send(extra)).status));
    assert.equal(await t.count('payments'), 3);
    assert.equal(await t.count('payment_hsa_ineligible'), 2);
  } finally { await t.db.drop(); }
});
