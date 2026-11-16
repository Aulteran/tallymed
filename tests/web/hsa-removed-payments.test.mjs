// The HSA side hides removed payments and the zero-net leftovers of a removal and undo (real PostgreSQL, fabricated data only).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import * as hsaRepo from '../../apps/web/server/repositories/hsa.ts';
import * as acc from '../../apps/web/server/services/hsa-accounts.ts';
import * as hsa from '../../apps/web/server/services/hsa.ts';
import * as pm from '../../apps/web/server/services/payment-methods.ts';
import * as pay from '../../apps/web/server/services/payments.ts';
import { undo } from '../../apps/web/server/services/undo.ts';
import { skipDb } from './helpers.mjs';
import { setup } from './money-helpers.mjs';

const remove = (t, paymentId) => pay.removePayment(t.db.pool, t.actor, { idempotencyKey: randomUUID(), paymentId, reason: 'Fabricated duplicate entry' }, 'r');
const undoIt = (t) => undo(t.db.pool, t.actor, { idempotencyKey: randomUUID() }, 'r');
const decide = (t, allocationId, amount = '10.00', version = '0') => hsa.recordDecision(t.db.pool, t.actor, {
  idempotencyKey: randomUUID(), allocationId, version, status: 'eligible', eligibleAmount: amount,
  rationale: 'Qualified medical expense', evidenceType: 'receipt', evidenceNote: 'Pharmacy receipt on file', decidedOn: '2026-04-05',
}, 'r');
const reverse = (t, allocationId, amount) => pay.reverseAllocation(t.db.pool, t.actor, { idempotencyKey: randomUUID(), allocationId, amount, effectiveDate: '2026-05-03', reason: 'Wrong bill' }, 'r');

/** Everything the HSA side shows, from every read path, so they can be compared with each other and across the removal. */
async function hsaView(t) {
  const list = [];
  for (let cursor; ;) {
    const page = await hsa.listHsaAllocations(t.db.pool, t.actor, { limit: '2', cursor });
    list.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  const all = await hsaRepo.allAllocations(t.db.pool, t.actor.householdId, {}, 1000);
  const csv = (await hsa.exportHsa(t.db.pool, t.actor, { kind: 'allocations' }, 'r')).csv.trim().split('\n');
  const totals = await hsa.hsaSummary(t.db.pool, t.actor, {});
  const queues = await hsa.hsaQueues(t.db.pool, t.actor, {}, 50);
  const undecided = (await hsa.listHsaAllocations(t.db.pool, t.actor, { state: 'undecided' })).items;
  return { ids: list.map((a) => a.allocationId).sort(), allIds: all.map((a) => a.allocationId).sort(), csvRows: csv.length - 2, totals, queues, undecided, list };
}
const figures = async (t, billIds) => ({
  summary: await pay.cashSummary(t.db.pool, t.actor),
  bills: await Promise.all(billIds.map(async (id) => (await t.detail(id)).openBalanceCents)),
  payments: (await pay.listPayments(t.db.pool, t.actor, {})).items.map((x) => [x.id, x.netCashCents]).sort(),
  methods: (await pm.listPaymentMethods(t.db.pool, t.actor)).items.map((m) => [m.id, m.paymentCount, m.netCashCents]),
  accounts: (await acc.listHsaAccounts(t.db.pool, t.actor)).items.map((a) => [a.id, a.paymentCount, a.netCashCents]),
});
const agree = (v) => {
  assert.deepEqual(v.ids, v.allIds, 'list and export enumerate the same rows');
  assert.equal(v.csvRows, v.ids.length, 'the CSV has one row per listed allocation');
  assert.equal(v.totals.allocationCount, v.ids.length, 'the count matches the list');
  assert.equal(v.list.filter((a) => a.netCents === '0' && a.decisionCount === 0 && a.pendingCents === '0' && a.receivedCents === '0').length, 0, 'no zero-net row without HSA history');
};

const allocIds = async (t, paymentId) => (await t.db.pool.query(`select id from payment_entries where payment_id = $1 and kind = 'allocation' order by seq`, [paymentId])).rows.map((r) => r.id);
const rowsOf = (v, paymentId) => v.list.filter((r) => r.paymentId === paymentId);

test('a removed payment has no row or count on the HSA side, and undo shows each restored allocation exactly once', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const m = await t.member(); const p = await t.provider();
    const a = await acc.createHsaAccount(t.db.pool, t.actor, { name: 'Family HSA', administrator: 'Example HSA Bank', lastFour: '7788' }, 'r');
    const card = await pm.createPaymentMethod(t.db.pool, t.actor, { nickname: 'HSA Visa', kind: 'hsa_fsa_card', lastFour: '0042', hsaAccountId: a.id }, 'r');
    const keepBill = await t.bill({ memberId: m, providerId: p, originalAmount: '50.00' });
    const dirBill = await t.bill({ memberId: m, providerId: p, originalAmount: '80.00' });
    const ordBill = await t.bill({ memberId: m, providerId: p, originalAmount: '60.00' });
    const bills = [keepBill.id, dirBill.id, ordBill.id];
    const keep = await t.pay1({ amount: '50.00', billId: keepBill.id, allocateAmount: '50.00' });
    await decide(t, (await allocIds(t, keep.id))[0], '50.00');
    const baseView = await hsaView(t); const baseFig = await figures(t, bills);

    const direct = await t.pay1({ amount: '80.00', billId: dirBill.id, allocateAmount: '80.00', paidWithId: card.id });
    const ordinary = await t.pay1({ amount: '60.00', billId: ordBill.id, allocateAmount: '60.00' }); // no decision yet: in the undecided queue
    const fullView = await hsaView(t); const fullFig = await figures(t, bills);
    agree(fullView);
    assert.equal(fullView.ids.length, 3);
    assert.deepEqual([fullView.totals.directCount, fullView.totals.undecidedCount], [1, 1]);

    for (const x of [direct, ordinary]) {
      const [orig] = await allocIds(t, x.id);
      await remove(t, x.id);
      const v = await hsaView(t);
      agree(v);
      assert.equal(rowsOf(v, x.id).length, 0, 'no list row');
      assert.ok(!v.allIds.includes(orig) && !v.undecided.some((r) => r.paymentId === x.id));
      assert.ok(![...v.queues.available, ...v.queues.needsReview].some((r) => r.paymentId === x.id), 'no queue row');
      await assert.rejects(hsa.getHsaAllocationDetail(t.db.pool, t.actor, orig), { code: 'not_found' });
      // The other pages already agree: the payment is gone from the list and the cash summary, and its bill is open again.
      const fig = await figures(t, bills);
      assert.ok(!fig.payments.some((r) => r[0] === x.id));
      assert.equal(fig.summary.paymentCount, fullFig.summary.paymentCount - 1);
      assert.equal(fig.bills[x === direct ? 1 : 2], x === direct ? '8000' : '6000');

      await undoIt(t);
      const back = await hsaView(t);
      agree(back);
      assert.equal(rowsOf(back, x.id).length, 1, 'exactly one row for the restored allocation');
      assert.ok(!back.allIds.includes(orig), 'the original reversed allocation is not listed beside the new one');
      assert.equal(rowsOf(back, x.id)[0].netCents, x === direct ? '8000' : '6000');
      const [restored] = (await allocIds(t, x.id)).slice(-1);
      assert.equal(rowsOf(back, x.id)[0].allocationId, restored);
      assert.equal(back.ids.length, 3);
      assert.deepEqual(back.totals, fullView.totals, 'the same HSA figures as before the removal');
      assert.deepEqual(await figures(t, bills), fullFig, 'the same cash, balance, method and account figures as before the removal');
    }

    // Both removed at once: only the untouched payment remains on the HSA side.
    await remove(t, direct.id); await remove(t, ordinary.id);
    const gone = await hsaView(t);
    agree(gone);
    assert.deepEqual([gone.ids, gone.totals], [baseView.ids, baseView.totals], 'the HSA side is what it was before the payments existed');
    const figs = await figures(t, bills);
    assert.deepEqual([figs.summary, figs.payments, figs.methods, figs.accounts], [baseFig.summary, baseFig.payments, baseFig.methods, baseFig.accounts]);
    // The record-level reads on the HSA side list no HSA activity of a removed payment either (removal is refused when it holds any).
    assert.equal((await hsa.exportHsa(t.db.pool, t.actor, { kind: 'events' }, 'r')).rows, 0);
    assert.equal((await hsa.exportHsa(t.db.pool, t.actor, { kind: 'decisions' }, 'r')).rows, 1, 'only the decision of the kept payment');
  } finally { await t.db.drop(); }
});

test('a fully reversed allocation is hidden unless it has HSA history; counts, totals and exports agree with the list', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const m = await t.member(); const p = await t.provider();
    const mk = async (amount) => { const b = await t.bill({ memberId: m, providerId: p, originalAmount: amount }); const x = await t.pay1({ amount, billId: b.id, allocateAmount: amount }); return { b, x, al: (await allocIds(t, x.id))[0] }; };
    await mk('40.00'); const plain = await mk('30.00'); const decided = await mk('20.00'); const claimed = await mk('25.00');
    await decide(t, decided.al, '20.00');
    await decide(t, claimed.al, '25.00');
    await hsa.submitClaim(t.db.pool, t.actor, { idempotencyKey: randomUUID(), submittedOn: '2026-04-10', administrator: 'Example HSA Bank', lines: [{ allocationId: claimed.al, amount: '10.00' }] }, 'r');
    assert.equal((await hsaView(t)).ids.length, 4);

    await reverse(t, plain.al, '30.00'); // by hand, no HSA history
    await reverse(t, decided.al, '20.00'); // by hand, with a decision
    const v = await hsaView(t);
    assert.ok(!v.allIds.includes(plain.al), 'a zero-net allocation without history is hidden');
    assert.ok(v.allIds.includes(decided.al), 'a zero-net allocation with a decision stays');
    assert.equal(v.list.find((r) => r.allocationId === decided.al).netCents, '0');
    assert.deepEqual(v.ids, v.allIds); assert.equal(v.csvRows, 3); assert.equal(v.totals.allocationCount, 3);
    assert.equal(v.undecided.length, 1, 'only the live allocation still needs a decision');
    assert.ok(v.queues.needsReview.every((r) => r.allocationId !== plain.al));

    // A claim on the allocation keeps it visible even when its cash is reversed (the claim above the net cash is a needs-review case).
    await reverse(t, claimed.al, '25.00');
    const w = await hsaView(t);
    assert.ok(w.allIds.includes(claimed.al), 'a zero-net allocation with a claim stays visible');
    const row = w.list.find((r) => r.allocationId === claimed.al);
    assert.deepEqual([row.netCents, row.pendingCents, row.needsReviewCents], ['0', '1000', '1000']);
    assert.deepEqual(w.ids, w.allIds); assert.equal(w.csvRows, 3); assert.equal(w.totals.allocationCount, 3);
    assert.equal(w.totals.needsReviewCount, 1);
  } finally { await t.db.drop(); }
});

test('the HSA account payment count leaves out a voided direct payment', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const a = await acc.createHsaAccount(t.db.pool, t.actor, { name: 'Family HSA', administrator: 'Example HSA Bank', lastFour: '7788' }, 'r');
    const card = await pm.createPaymentMethod(t.db.pool, t.actor, { nickname: 'HSA Visa', kind: 'hsa_fsa_card', lastFour: '0042', hsaAccountId: a.id }, 'r');
    const one = await t.pay1({ amount: '10.00', paidWithId: card.id });
    await t.pay1({ amount: '15.00', paidWithId: card.id });
    await pay.voidPayment(t.db.pool, t.actor, { idempotencyKey: randomUUID(), paymentId: one.id, voidedOn: '2026-04-02', reason: 'Entered in error' }, 'r');
    const row = (await acc.listHsaAccounts(t.db.pool, t.actor)).items.find((x) => x.id === a.id);
    assert.deepEqual([row.paymentCount, row.netCashCents], [1, '1500']);
  } finally { await t.db.drop(); }
});
