// Payment plans: schedules, revisions, installment matching and their interaction with payments (M03). Synthetic data only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import * as handlers from '../../apps/web/server/http.ts';
import { csrfFor } from '../../apps/web/server/tokens.ts';
import * as pay from '../../apps/web/server/services/payments.ts';
import * as plans from '../../apps/web/server/services/plans.ts';
import { AppError } from '../../apps/web/server/errors.ts';
import { retryStats } from '../../apps/web/server/services/support.ts';
import { withInstallmentList, withInstRowValues } from '../../apps/web/server/plan-installments.ts';
import { withBillTicks } from '../../apps/web/server/plan-preview-form.ts';
import { readFlash } from '../../apps/web/server/flash.ts';
import { post, skipDb } from './helpers.mjs';
import { setup } from './money-helpers.mjs';

const code = (c) => ({ code: c });
const AS_OF = '2026-07-15';

async function planSetup(t, { bill = '300.00', installments = 3, total = '300.00', first = '2026-06-01', cadence = 'monthly' } = {}) {
  const m = await t.member();
  const p = await t.provider();
  const b = await t.bill({ memberId: m, providerId: p, originalAmount: bill });
  const create = (o = {}) => plans.createPlan(t.db.pool, t.actor, {
    idempotencyKey: t.key(), name: 'Clinic plan', billId: b.id, totalAmount: total, installmentCount: String(installments), firstDueDate: first, cadence, startedOn: '2026-01-01', ...o,
  }, 'r');
  const plan = await create();
  const detail = (id = plan.id, o = {}) => plans.getPlanDetail(t.db.pool, t.actor, id, { asOf: AS_OF, ...o });
  const match = (installmentId, allocationId, amount) => plans.matchInstallment(t.db.pool, t.actor, { idempotencyKey: t.key(), installmentId, allocationId, amount }, 'r');
  const ledgerSnapshot = async () => JSON.stringify([
    (await t.db.pool.query(`select id, amount_cents::text from payments order by id`)).rows,
    (await t.db.pool.query(`select id, kind, amount_cents::text from payment_entries order by seq`)).rows,
    (await t.detail(b.id)).openBalanceCents,
  ]);
  return { m, p, b, plan, create, detail, match, ledgerSnapshot };
}

test('schedules split exactly in cents, with month-end clamping and explicit lists', () => {
  const s = plans.buildSchedule({ cadence: 'monthly', totalAmount: 10000n, installmentCount: 3, firstDueDate: '2026-01-31' });
  assert.deepEqual(s.lines.map((l) => l.amountCents), [3334n, 3333n, 3333n]);
  assert.deepEqual(s.lines.map((l) => l.dueDate), ['2026-01-31', '2026-02-28', '2026-03-31']);
  assert.equal(s.lines.reduce((a, l) => a + l.amountCents, 0n), 10000n);
  assert.deepEqual(plans.buildSchedule({ cadence: 'weekly', totalAmount: 700n, installmentCount: 3, firstDueDate: '2026-12-25' }).lines.map((l) => l.dueDate), ['2026-12-25', '2027-01-01', '2027-01-08']);
  assert.deepEqual(plans.buildSchedule({ cadence: 'biweekly', totalAmount: 300n, installmentCount: 2, firstDueDate: '2026-02-20' }).lines.map((l) => l.dueDate), ['2026-02-20', '2026-03-06']);
  assert.deepEqual(plans.dueDateAt('2026-11-30', 'monthly', 3), '2027-02-28');
  const explicit = plans.buildSchedule({ cadence: 'custom', totalAmount: null, installmentCount: null, firstDueDate: null, installments: [{ dueDate: '2026-08-01', amount: 500n }, { dueDate: '2026-06-01', amount: 250n }] });
  assert.deepEqual(explicit.lines.map((l) => l.dueDate), ['2026-06-01', '2026-08-01']);
  assert.equal(explicit.totalCents, 750n);
  assert.throws(() => plans.buildSchedule({ cadence: 'monthly', totalAmount: 2n, installmentCount: 3, firstDueDate: '2026-01-01' }), AppError);
  assert.throws(() => plans.buildSchedule({ cadence: 'custom', totalAmount: null, installmentCount: null, firstDueDate: null }), AppError);
  assert.throws(() => plans.buildSchedule({ cadence: 'monthly', totalAmount: 100n, installmentCount: 1, firstDueDate: '2026-01-01', installments: [{ dueDate: '2026-01-01', amount: 1n }] }), AppError);
});

test('creating a schedule and matching installments never creates or changes cash', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const s = await planSetup(t);
    // The plan is an obligation: no payment, allocation or balance changed.
    assert.equal(await t.count('payments'), 0);
    assert.equal((await t.detail(s.b.id)).openBalanceCents, '30000');
    const d0 = await s.detail();
    assert.deepEqual(d0.installments.map((i) => [i.dueDate, i.amountCents, i.state]), [['2026-06-01', '10000', 'unpaid'], ['2026-07-01', '10000', 'unpaid'], ['2026-08-01', '10000', 'unpaid']]);
    assert.equal(d0.plan.totalCents, '30000');
    // $150 of real cash is applied to the bill. Then it is matched across installments: $100 to #1 and $50 to #2.
    const pm = await t.pay1({ amount: '150.00', billId: s.b.id });
    const alloc = (await t.payment(pm.id)).allocations[0].allocationId;
    const before = await s.ledgerSnapshot();
    await s.match(d0.installments[0].id, alloc, '100.00');
    await s.match(d0.installments[1].id, alloc, '50.00');
    assert.equal(await s.ledgerSnapshot(), before, 'matching is a reference to cash that already exists');
    assert.equal((await t.detail(s.b.id)).openBalanceCents, '15000');
    const d1 = await s.detail();
    assert.deepEqual(d1.installments.map((i) => [i.state, i.matchedCents, i.unpaidCents, i.overdue]), [['paid', '10000', '0', false], ['partial', '5000', '5000', true], ['unpaid', '0', '10000', false]]);
    // The allocation is fully matched: its cash cannot be counted twice, by this or any other installment.
    await assert.rejects(s.match(d1.installments[2].id, alloc, '0.01'), code('conflict'));
    // An installment cannot be matched beyond what it owes, and a match must use an allocation to one of the plan's bills.
    const pm2 = await t.pay1({ amount: '500.00' });
    const other = await t.bill({ memberId: s.m, providerId: s.p, originalAmount: '80.00' });
    await pay.allocatePayment(t.db.pool, t.actor, { idempotencyKey: t.key(), paymentId: pm2.id, billId: s.b.id, allocateAmount: '150.00' }, 'r');
    await pay.allocatePayment(t.db.pool, t.actor, { idempotencyKey: t.key(), paymentId: pm2.id, billId: other.id, allocateAmount: '80.00' }, 'r');
    const allocs2 = (await t.payment(pm2.id)).allocations;
    await assert.rejects(s.match(d1.installments[1].id, allocs2.find((a) => a.billId === s.b.id).allocationId, '50.01'), code('conflict'));
    await assert.rejects(s.match(d1.installments[1].id, allocs2.find((a) => a.billId === other.id).allocationId, '10.00'), code('invalid_input'));
    await assert.rejects(s.match(randomUUID(), alloc, '1.00'), code('not_found'));
    await assert.rejects(s.match(d1.installments[1].id, randomUUID(), '1.00'), code('not_found'));
    // Upcoming and overdue views, soonest first, as of a fixed date.
    const overdue = await plans.listInstallmentQueue(t.db.pool, t.actor, { state: 'overdue', asOf: AS_OF });
    assert.deepEqual(overdue.items.map((i) => [i.dueDate, i.unpaidCents, i.state]), [['2026-07-01', '5000', 'partial']]);
    const upcoming = await plans.listInstallmentQueue(t.db.pool, t.actor, { state: 'upcoming', asOf: AS_OF });
    assert.deepEqual(upcoming.items.map((i) => [i.dueDate, i.unpaidCents, i.state]), [['2026-08-01', '10000', 'unpaid']]);
    assert.equal((await plans.listInstallmentQueue(t.db.pool, t.actor, { asOf: AS_OF })).items.length, 2);
    const totals = await plans.installmentSummary(t.db.pool, t.actor, AS_OF);
    assert.deepEqual([totals.overdueCount, totals.overdueCents, totals.upcomingCount, totals.upcomingCents], [1, '5000', 1, '10000']);
    assert.equal((await plans.listInstallmentQueue(t.db.pool, t.actor, { asOf: AS_OF, memberId: s.m })).items.length, 2);
    assert.equal((await plans.listInstallmentQueue(t.db.pool, t.actor, { asOf: AS_OF, memberId: randomUUID() })).items.length, 0);
    // Matching the rest of the second installment from the second payment turns the overdue item into paid.
    await s.match(d1.installments[1].id, allocs2.find((a) => a.billId === s.b.id).allocationId, '50.00');
    assert.equal((await plans.listInstallmentQueue(t.db.pool, t.actor, { state: 'overdue', asOf: AS_OF })).items.length, 0);
    // Removing part of a match is a linked negative entry with a reason, and the cash is untouched.
    const snap = await s.ledgerSnapshot();
    await plans.unmatchInstallment(t.db.pool, t.actor, { idempotencyKey: t.key(), installmentId: d1.installments[1].id, allocationId: alloc, amount: '20.00', reason: 'Wrong installment' }, 'r');
    assert.equal(await s.ledgerSnapshot(), snap);
    const d2 = await s.detail();
    assert.equal(d2.installments[1].matchedCents, '8000');
    await assert.rejects(plans.unmatchInstallment(t.db.pool, t.actor, { idempotencyKey: t.key(), installmentId: d1.installments[1].id, allocationId: alloc, amount: '31.00', reason: 'x' }, 'r'), code('conflict'));
    assert.deepEqual(d2.matches.map((m) => [m.kind, m.amountCents]), [['match', '10000'], ['match', '5000'], ['match', '5000'], ['unmatch', '-2000']]);
    // Audit: before and after values for the matched installment.
    const audit = (await t.audit('plan.installment_matched'))[0].detail;
    assert.deepEqual([audit.installmentMatchedBeforeCents, audit.installmentMatchedAfterCents, audit.allocationUnmatchedBeforeCents, audit.allocationUnmatchedAfterCents], ['0', '10000', '15000', '5000']);
  } finally {
    await t.db.drop();
  }
});

test('schedule revisions keep matched history, carry matches forward without new cash, and cannot go below matched', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const s = await planSetup(t);
    const pm = await t.pay1({ amount: '150.00', billId: s.b.id });
    const alloc = (await t.payment(pm.id)).allocations[0].allocationId;
    const d0 = await s.detail();
    await s.match(d0.installments[0].id, alloc, '100.00');
    await s.match(d0.installments[1].id, alloc, '50.00');
    const cash = JSON.stringify((await t.db.pool.query(`select count(*)::int n, sum(amount_cents)::text s from payment_entries`)).rows);
    const revise = (o) => plans.revisePlan(t.db.pool, t.actor, { idempotencyKey: t.key(), planId: s.plan.id, version: d0.plan.version, reason: 'Hardship, longer plan', ...o }, 'r');
    // Cannot drop below what is matched, a stale form is rejected, and a failed revision leaves nothing behind.
    await assert.rejects(revise({ totalAmount: '100.00', installmentCount: '2', firstDueDate: '2026-09-01' }), code('conflict'));
    await assert.rejects(revise({ version: d0.plan.version + 5, totalAmount: '300.00', installmentCount: '2', firstDueDate: '2026-09-01' }), code('stale_version'));
    assert.equal(await t.count('plan_revisions'), 1);
    // A longer schedule: six installments of $50 starting in September. $150 matched carries onto the first three.
    const key = t.key();
    const body = { idempotencyKey: key, planId: s.plan.id, version: d0.plan.version, reason: 'Hardship, longer plan', totalAmount: '300.00', installmentCount: '6', firstDueDate: '2026-09-01', cadence: 'monthly' };
    const rev = await plans.revisePlan(t.db.pool, t.actor, body, 'r');
    const replay = await plans.revisePlan(t.db.pool, t.actor, body, 'r');
    assert.equal(replay.replayed, true);
    assert.equal(await t.count('plan_revisions'), 2, 'a replayed revision is one revision');
    const d1 = await s.detail();
    assert.equal(d1.plan.revisionNo, 2);
    assert.deepEqual(d1.installments.map((i) => [i.dueDate, i.amountCents, i.matchedCents, i.state]), [
      ['2026-09-01', '5000', '5000', 'paid'], ['2026-10-01', '5000', '5000', 'paid'], ['2026-11-01', '5000', '5000', 'paid'],
      ['2026-12-01', '5000', '0', 'unpaid'], ['2027-01-01', '5000', '0', 'unpaid'], ['2027-02-01', '5000', '0', 'unpaid'],
    ]);
    // Earlier revision and its matches are exactly as they were.
    assert.equal(d1.revisions.length, 2);
    const rev1 = d1.revisions[0];
    assert.deepEqual([rev1.revisionNo, rev1.installmentCount, rev1.matchedCents, rev1.totalCents], [1, 3, '15000', '30000']);
    assert.equal(d1.matches.filter((m) => m.revisionNo === 1).length, 2);
    assert.equal(d1.matches.filter((m) => m.revisionNo === 2).every((m) => m.carried), true);
    assert.equal(JSON.stringify((await t.db.pool.query(`select count(*)::int n, sum(amount_cents)::text s from payment_entries`)).rows), cash, 'revising created no cash');
    assert.equal((await t.detail(s.b.id)).openBalanceCents, '15000');
    // Old installments cannot be matched any more, and the overdue view uses only the current revision.
    await assert.rejects(s.match(d0.installments[2].id, alloc, '1.00'), code('conflict'));
    assert.equal((await plans.listInstallmentQueue(t.db.pool, t.actor, { state: 'overdue', asOf: AS_OF })).items.length, 0);
    assert.equal(rev.replayed, false);
    // Audit has from and to values.
    const a = (await t.audit('plan.revised'))[0].detail;
    assert.deepEqual([a.fromRevisionNo, a.toRevisionNo, a.fromInstallmentCount, a.toInstallmentCount, a.fromTotalCents, a.toTotalCents, a.carriedMatchedCents], [1, 2, 3, 6, '30000', '30000', '15000']);
    // Explicit list in a third revision (custom cadence).
    await plans.revisePlan(t.db.pool, t.actor, {
      idempotencyKey: t.key(), planId: s.plan.id, version: d1.plan.version, reason: 'Agreed dates',
      installments: [{ dueDate: '2026-10-15', amount: '150.00' }, { dueDate: '2026-12-15', amount: '150.00' }],
    }, 'r');
    const d2 = await s.detail();
    assert.deepEqual(d2.installments.map((i) => [i.matchedCents, i.state]), [['15000', 'paid'], ['0', 'unpaid']]);
    assert.equal(d2.plan.cadence, 'custom');
  } finally {
    await t.db.drop();
  }
});

test('refunds and allocation reversals release plan matches they no longer back', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const s = await planSetup(t);
    const pm = await t.pay1({ amount: '150.00', billId: s.b.id });
    const alloc = (await t.payment(pm.id)).allocations[0].allocationId;
    const d0 = await s.detail();
    await s.match(d0.installments[0].id, alloc, '100.00');
    await s.match(d0.installments[1].id, alloc, '50.00');
    // Refund $60: the allocation holds $90, so $60 of matches (latest due first) is released in the same transaction.
    await t.refund(pm.id, { allocationId: alloc, amount: '60.00' });
    const d1 = await s.detail();
    assert.deepEqual(d1.installments.map((i) => i.matchedCents), ['9000', '0', '0']);
    const released = await t.audit('plan.match_released');
    assert.equal(released.length, 2);
    assert.deepEqual([released[0].detail.matchedBeforeCents, released[0].detail.matchedAfterCents], ['5000', '0']);
    assert.deepEqual([released[1].detail.matchedBeforeCents, released[1].detail.matchedAfterCents], ['10000', '9000']);
    // The refund itself is explicit cash history; a reversal of the allocation (not a refund) releases matches too.
    await pay.reverseAllocation(t.db.pool, t.actor, { idempotencyKey: t.key(), allocationId: alloc, amount: '40.00', effectiveDate: '2026-05-01', reason: 'Wrong bill' }, 'r');
    assert.deepEqual((await s.detail()).installments.map((i) => i.matchedCents), ['5000', '0', '0']);
    // The database refuses matches that exceed what the allocation holds, even when written directly.
    await assert.rejects(t.db.pool.query(
      `insert into installment_matches (id, household_id, plan_id, revision_id, installment_id, payment_id, allocation_id, bill_id, kind, amount_cents, created_by)
       select gen_random_uuid(), $1, i.plan_id, i.revision_id, i.id, $2, $3, $4, 'match', 5001, $5 from plan_installments i where i.id = $6`,
      [t.actor.householdId, pm.id, alloc, s.b.id, t.actor.userId, d0.installments[2].id]), /exceed what the allocation still holds/);
    // A plan that is cancelled drops out of the queues but keeps its history.
    const plan = await s.detail();
    await assert.rejects(plans.cancelPlan(t.db.pool, t.actor, { planId: s.plan.id, version: 99, reason: 'x' }, 'r'), code('stale_version'));
    await plans.cancelPlan(t.db.pool, t.actor, { planId: s.plan.id, version: plan.plan.version, reason: 'Paid in full elsewhere' }, 'r');
    assert.equal((await plans.listInstallmentQueue(t.db.pool, t.actor, { asOf: AS_OF })).items.length, 0);
    assert.equal((await s.detail()).plan.status, 'cancelled');
    await assert.rejects(s.match(d0.installments[1].id, alloc, '1.00'), code('conflict'));
    await assert.rejects(plans.cancelPlan(t.db.pool, t.actor, { planId: s.plan.id, version: plan.plan.version + 1, reason: 'again' }, 'r'), code('conflict'));
    assert.equal((await plans.listPlans(t.db.pool, t.actor, { status: 'active' }, AS_OF)).items.length, 0);
    assert.equal((await plans.listPlans(t.db.pool, t.actor, { status: 'cancelled' }, AS_OF)).items.length, 1);
  } finally {
    await t.db.drop();
  }
});

test('concurrent matching, refunds and revisions never count cash twice', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const s = await planSetup(t, { bill: '1000.00', installments: 10, total: '1000.00' });
    const pm = await t.pay1({ amount: '100.00', billId: s.b.id });
    const alloc = (await t.payment(pm.id)).allocations[0].allocationId;
    const d = await s.detail();
    // 10 concurrent $30 matches of a $100 allocation spread over different installments: exactly three fit.
    const r = await Promise.allSettled(d.installments.map((i) => s.match(i.id, alloc, '30.00')));
    assert.equal(r.filter((x) => x.status === 'fulfilled').length, 3);
    for (const x of r.filter((y) => y.status === 'rejected')) assert.equal(x.reason.code, 'conflict');
    // A refund racing a match: whatever order wins, matched never exceeds what the allocation holds.
    const a = await t.db.pool.query(`select allocation_id from allocation_net limit 1`);
    const race = await Promise.allSettled([
      t.refund(pm.id, { allocationId: alloc, amount: '95.00' }),
      s.match(d.installments[5].id, alloc, '10.00'),
      s.match(d.installments[6].id, alloc, '10.00'),
      plans.revisePlan(t.db.pool, t.actor, { idempotencyKey: t.key(), planId: s.plan.id, version: d.plan.version, reason: 'Race', totalAmount: '1000.00', installmentCount: '5', firstDueDate: '2027-01-01' }, 'r'),
    ]);
    assert.ok(race.every((x) => x.status === 'fulfilled' || ['conflict', 'stale_version'].includes(x.reason.code)), race.filter((x) => x.status === 'rejected').map((x) => x.reason.message || x.reason.code).join());
    assert.ok(a.rowCount >= 1);
    const bad = await t.db.pool.query(`
      select n.allocation_id from allocation_net n
      where n.net_cents < (select coalesce(sum(m.amount_cents), 0) from installment_matches m join plan_revisions r on r.id = m.revision_id
        where m.allocation_id = n.allocation_id and r.revision_no = (select max(x.revision_no) from plan_revisions x where x.plan_id = m.plan_id))`);
    assert.equal(bad.rowCount, 0, 'no allocation is matched beyond its net cash');
    const net = (await t.payment(pm.id)).allocations[0];
    assert.ok(BigInt(net.matchedCents) <= BigInt(net.netCents));
    // Per-installment sums stay within each installment.
    const over = await t.db.pool.query(`select i.id from plan_installments i where (select coalesce(sum(amount_cents), 0) from installment_matches m where m.installment_id = i.id) not between 0 and i.amount_cents`);
    assert.equal(over.rowCount, 0);
  } finally {
    await t.db.drop();
  }
});

test('plan creation rules, idempotency, rollback and database guards on schedules', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const m = await t.member();
    const p = await t.provider();
    const p2 = await t.provider('Other Lab');
    const b = await t.bill({ memberId: m, providerId: p, originalAmount: '100.00' });
    const other = await t.bill({ memberId: m, providerId: p2, originalAmount: '100.00' });
    const est = await t.bill({ memberId: m, providerId: p, originalAmount: '100.00', amountStatus: 'estimate' });
    const base = { name: 'Plan', billId: b.id, totalAmount: '100.00', installmentCount: '4', firstDueDate: '2026-06-01', cadence: 'monthly' };
    const create = (o = {}) => plans.createPlan(t.db.pool, t.actor, { idempotencyKey: t.key(), ...base, ...o }, 'r');
    // Rules: confirmed bills, known records, at least one bill, positive installments. Bills of other providers are allowed.
    await assert.rejects(create({ billId: est.id }), code('conflict'));
    await assert.rejects(create({ billId: randomUUID() }), code('not_found'));
    await assert.rejects(create({ billId: undefined }), code('invalid_input'));
    await assert.rejects(create({ totalAmount: '0.03' }), code('invalid_input'));
    await assert.rejects(create({ providerId: p }), code('invalid_input'), 'a plan no longer takes a provider of its own');
    await assert.rejects(create({ billId: undefined, billIds: [b.id, b.id] }), code('invalid_input'));
    await assert.rejects(create({ installmentCount: '121' }), code('invalid_input'));
    await assert.rejects(create({ installmentCount: undefined }), code('invalid_input'));
    assert.equal(await t.count('payment_plans'), 0, 'rejected requests left nothing behind');
    // A plan can cover several bills of one provider.
    const b2 = await t.bill({ memberId: m, providerId: p, originalAmount: '40.00' });
    const key = t.key();
    const one = await plans.createPlan(t.db.pool, t.actor, { idempotencyKey: key, ...base, billId: undefined, billIds: [b.id, b2.id], totalAmount: '140.00' }, 'r');
    const again = await plans.createPlan(t.db.pool, t.actor, { idempotencyKey: key, ...base, billId: undefined, billIds: [b.id, b2.id], totalAmount: '140.00' }, 'r');
    assert.equal(again.id, one.id);
    await assert.rejects(plans.createPlan(t.db.pool, t.actor, { idempotencyKey: key, ...base, billId: undefined, billIds: [b.id, b2.id], totalAmount: '141.00' }, 'r'), code('conflict'));
    assert.equal(await t.count('payment_plans'), 1);
    assert.equal(await t.count('payment_plan_bills'), 2);
    const detail = await plans.getPlanDetail(t.db.pool, t.actor, one.id, { asOf: AS_OF });
    assert.equal(detail.bills.length, 2);
    assert.equal(detail.installments.reduce((a, i) => a + BigInt(i.amountCents), 0n), 14000n);
    const created = (await t.audit('plan.created'))[0].detail;
    assert.deepEqual([created.totalCents, created.installmentCount, created.billCount, created.scopeOpenBalanceCents], ['14000', 4, 2, '14000']);
    // Concurrent identical creates make one plan.
    const k2 = t.key();
    const racers = await Promise.allSettled(Array.from({ length: 6 }, () => plans.createPlan(t.db.pool, t.actor, { idempotencyKey: k2, ...base }, 'r')));
    assert.ok(racers.every((r) => r.status === 'fulfilled'));
    assert.equal(new Set(racers.map((r) => r.value.id)).size, 1);
    assert.equal(await t.count('payment_plans'), 2);
    // A plan can be listed with paging and filters.
    assert.equal((await plans.listPlans(t.db.pool, t.actor, { q: 'plan', limit: 1 }, AS_OF)).nextCursor !== null, true);
    assert.equal((await plans.listPlans(t.db.pool, t.actor, { providerId: p2 }, AS_OF)).items.length, 0);
    assert.equal((await plans.listPlans(t.db.pool, t.actor, { providerId: p }, AS_OF)).items.length, 2);
    void other;
    // Database guards: revisions must total their installments; schedule rows are append-only.
    const pool = t.db.pool;
    const hh = t.actor.householdId;
    await assert.rejects(pool.query(
      `insert into plan_revisions (id, household_id, plan_id, revision_no, total_cents, cadence, reason, created_by) values (gen_random_uuid(), $1, $2, 9, 1000, 'custom', 'x', $3)`,
      [hh, one.id, t.actor.userId]), /add up to its total/);
    const rid = randomUUID();
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`insert into plan_revisions (id, household_id, plan_id, revision_no, total_cents, cadence, reason, created_by) values ($1, $2, $3, 9, 1000, 'custom', 'x', $4)`, [rid, hh, one.id, t.actor.userId]);
      await client.query(`insert into plan_installments (id, household_id, plan_id, revision_id, seq, due_date, amount_cents) values (gen_random_uuid(), $1, $2, $3, 1, '2026-06-01', 999)`, [hh, one.id, rid]);
      await assert.rejects(client.query('commit'), /add up to its total/);
    } finally {
      client.release();
    }
    await assert.rejects(pool.query(`update plan_installments set amount_cents = 1`), /append-only/);
    await assert.rejects(pool.query(`delete from plan_revisions`), /append-only/);
    await assert.rejects(pool.query(`truncate installment_matches`), /append-only/);
    await assert.rejects(pool.query(`delete from payment_plan_bills`), /append-only/);
  } finally {
    await t.db.drop();
  }
});

test('plan access boundaries, form posts and the overview and bill figures', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const s = await planSetup(t);
    const h2 = (await t.db.pool.query(`insert into households (name) values ('Other Family') returning id`)).rows[0].id;
    const u2 = (await t.db.pool.query(
      `insert into users (household_id, email, display_name, role, password_hash) values ($1, 'other@example.test', 'Other Admin', 'admin', 'x') returning id`, [h2])).rows[0].id;
    const outsider = { userId: u2, householdId: h2, role: 'admin', displayName: 'Other Admin', sessionId: randomUUID() };
    await assert.rejects(plans.getPlanDetail(t.db.pool, outsider, s.plan.id), code('not_found'));
    assert.equal((await plans.listPlans(t.db.pool, outsider, {})).items.length, 0);
    assert.equal((await plans.installmentSummary(t.db.pool, outsider, AS_OF)).upcomingCount, 0);
    const d = await s.detail();
    await assert.rejects(plans.revisePlan(t.db.pool, outsider, { idempotencyKey: t.key(), planId: s.plan.id, version: 1, reason: 'x', totalAmount: '10', installmentCount: '1', firstDueDate: '2026-09-01' }, 'r'), code('not_found'));
    await assert.rejects(plans.cancelPlan(t.db.pool, outsider, { planId: s.plan.id, version: 1, reason: 'x' }, 'r'), code('not_found'));
    await assert.rejects(plans.createPlan(t.db.pool, outsider, { idempotencyKey: t.key(), name: 'x', billId: s.b.id, totalAmount: '10', installmentCount: '1', firstDueDate: '2026-09-01' }, 'r'), code('not_found'));
    // A plan cannot reference another household's bill (database level).
    const spare = await t.bill({ memberId: s.m, providerId: s.p, originalAmount: '10.00' });
    await assert.rejects(t.db.pool.query(`insert into payment_plan_bills (household_id, plan_id, bill_id) values ($1, $2, $3)`, [h2, s.plan.id, spare.id]), /foreign key/);
    // Forms.
    const token = t.cookie.split('=')[1];
    const form = (action, b) => handlers.handleExpenseAction(post(`/api/expenses/${action}`, { ...b, csrf: csrfFor(token) }, { cookie: t.cookie, html: true }), t.ctx, action);
    const ok = await form('plans/create', { idempotencyKey: t.key(), name: 'Second plan', billId: s.b.id, totalAmount: '90.00', installmentCount: '3', firstDueDate: '2026-09-01', cadence: 'monthly' });
    assert.equal(ok.status, 303);
    assert.match(ok.headers.get('location'), /\/plans\/[0-9a-f-]{36}$/);
    const bad = await form('plans/create', { idempotencyKey: t.key(), name: 'Bad plan', billId: s.b.id, totalAmount: '90.005', installmentCount: '3', firstDueDate: '2026-09-01' });
    const loc = new URL(bad.headers.get('location'));
    assert.deepEqual([loc.pathname, [...loc.searchParams.keys()]], ['/plans', ['error']]);
    const matchBad = await form('plans/match', { idempotencyKey: t.key(), planId: s.plan.id, installmentId: d.installments[0].id, allocationId: randomUUID(), amount: '1.00' });
    assert.equal(new URL(matchBad.headers.get('location')).pathname, `/plans/${s.plan.id}`);
    const pm = await t.pay1({ amount: '100.00', billId: s.b.id });
    const alloc = (await t.payment(pm.id)).allocations[0].allocationId;
    const matchOk = await form('plans/match', { idempotencyKey: t.key(), planId: s.plan.id, installmentId: d.installments[0].id, allocationId: alloc, amount: '100.00' });
    assert.equal(matchOk.headers.get('location'), `https://tallymed.test/plans/${s.plan.id}`);
    // Overview figures: open balance is responsibility minus applied; the queue counts agree with the plan view.
    const { expenseOverview } = await import('../../apps/web/server/services/expenses.ts');
    const overview = await expenseOverview(t.db.pool, t.actor, {});
    assert.equal(overview.totals.confirmedOpenBalanceCents, '21000', 'bill A $200 open plus the spare $10 bill');
    assert.equal(overview.totals.confirmedResponsibilityCents, '31000');
    const bill = await t.detail(s.b.id);
    assert.deepEqual([bill.responsibilityCents, bill.appliedCents, bill.openBalanceCents], ['30000', '10000', '20000']);
    const summary = await pay.billPaymentSummary(t.db.pool, t.actor, s.b.id);
    assert.equal(summary.plans.length, 2);
    assert.equal(summary.ledger.length, 1);
  } finally {
    await t.db.drop();
  }
});

test('fillInstallments pairs the oldest cash with the earliest installments and never over-matches', () => {
  const src = (allocationId, free) => ({ allocationId, paymentId: `p-${allocationId}`, billId: 'b', free });
  const slots = [{ id: 'i1', left: 100n }, { id: 'i2', left: 100n }, { id: 'i3', left: 0n }, { id: 'i4', left: 50n }];
  const out = plans.fillInstallments([src('a', 120n), src('b', 100n), src('c', 0n)], slots);
  assert.deepEqual(out.map((m) => [m.installmentId, m.source.allocationId, m.amount]), [['i1', 'a', 100n], ['i2', 'a', 20n], ['i2', 'b', 80n], ['i4', 'b', 20n]]);
  assert.deepEqual(plans.fillInstallments([src('a', 500n)], slots).map((m) => m.amount), [100n, 100n, 50n]);
  assert.deepEqual(plans.fillInstallments([], slots), []);
  assert.deepEqual(plans.fillInstallments([src('a', 10n)], []), []);
});

test('creating a plan can match payments already made on several bills, as references only', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const m = await t.member();
    const p = await t.provider('Example Hospital');
    const b1 = await t.bill({ memberId: m, providerId: p, originalAmount: '300.00' });
    const b2 = await t.bill({ memberId: m, providerId: p, originalAmount: '100.00' });
    const outsideBill = await t.bill({ memberId: m, providerId: p, originalAmount: '100.00' });
    // Past cash: $120 and $100 on the first bill, $50 on the second, and $30 on a bill the plan will not cover.
    await t.pay1({ paidOn: '2026-04-20', amount: '100.00', billId: b1.id });
    await t.pay1({ paidOn: '2026-03-01', amount: '120.00', billId: b1.id });
    await t.pay1({ paidOn: '2026-03-15', amount: '50.00', billId: b2.id });
    await t.pay1({ paidOn: '2026-03-20', amount: '30.00', billId: outsideBill.id });
    const snapshot = async () => JSON.stringify([
      (await t.db.pool.query(`select id, amount_cents::text from payments order by id`)).rows,
      (await t.db.pool.query(`select id, kind, amount_cents::text from payment_entries order by seq`)).rows,
      (await t.detail(b1.id)).openBalanceCents, (await t.detail(b2.id)).openBalanceCents,
    ]);
    const before = await snapshot();
    const key = t.key();
    const input = { idempotencyKey: key, name: 'ER visit plan', [`bill_${b1.id}`]: 'on', [`bill_${b2.id}`]: 'on', matchExisting: 'on', startedOn: '2026-01-01', totalAmount: '400.00', installmentCount: '4', firstDueDate: '2026-04-01', cadence: 'monthly' };
    const plan = await plans.createPlan(t.db.pool, t.actor, input, 'r');
    assert.equal(await snapshot(), before, 'matching existing cash creates no cash and changes no balance');
    const d = await plans.getPlanDetail(t.db.pool, t.actor, plan.id, { asOf: AS_OF });
    assert.equal(d.bills.length, 2);
    // Oldest payment first: $120 pays #1 and part of #2, $50 and then $100 finish #2 and start #3. The unrelated bill is untouched.
    assert.deepEqual(d.installments.map((i) => [i.matchedCents, i.state]), [['10000', 'paid'], ['10000', 'paid'], ['7000', 'partial'], ['0', 'unpaid']]);
    assert.equal(d.plan.matchedCents, '27000');
    assert.equal(d.matches.every((x) => x.kind === 'match' && !x.carried), true);
    assert.equal(d.allocations.length, 0, 'every allocation on the plan bills is fully matched');
    const created = (await t.audit('plan.created'))[0].detail;
    assert.deepEqual([created.matchExisting, created.matchedExistingCents, created.matchedExistingAllocations], [true, '27000', 3]);
    // A retry replays the same plan and adds nothing.
    const again = await plans.createPlan(t.db.pool, t.actor, input, 'r');
    assert.deepEqual([again.id, again.replayed], [plan.id, true]);
    assert.equal(await t.count('installment_matches'), 5);
    // Without the option nothing is matched, and cash that is already matched is not offered to a second plan.
    const plain = await plans.createPlan(t.db.pool, t.actor, { ...input, idempotencyKey: t.key(), name: 'Plain plan', matchExisting: undefined }, 'r');
    assert.equal((await plans.getPlanDetail(t.db.pool, t.actor, plain.id, { asOf: AS_OF })).plan.matchedCents, '0');
    const second = await plans.createPlan(t.db.pool, t.actor, { ...input, idempotencyKey: t.key(), name: 'Second plan' }, 'r');
    assert.equal((await plans.getPlanDetail(t.db.pool, t.actor, second.id, { asOf: AS_OF })).plan.matchedCents, '0', 'cash matched to one plan is not counted again');
    assert.equal(await t.count('installment_matches'), 5);
    // Cash larger than the plan: the surplus stays unmatched.
    const big = await t.bill({ memberId: m, providerId: p, originalAmount: '500.00' });
    await t.pay1({ paidOn: '2026-05-01', amount: '500.00', billId: big.id });
    const small = await plans.createPlan(t.db.pool, t.actor, { ...input, idempotencyKey: t.key(), name: 'Small plan', billId: undefined, [`bill_${b1.id}`]: undefined, [`bill_${b2.id}`]: undefined, [`bill_${big.id}`]: 'on', totalAmount: '200.00', installmentCount: '2' }, 'r');
    const ds = await plans.getPlanDetail(t.db.pool, t.actor, small.id, { asOf: AS_OF });
    assert.deepEqual([ds.plan.matchedCents, ds.installments.map((i) => i.state)], ['20000', ['paid', 'paid']]);
    assert.equal(ds.allocations[0].netCents, '50000');
    assert.equal(BigInt(ds.allocations[0].netCents) - BigInt(ds.allocations[0].matchedCents), 30000n);
    assert.equal(await t.count('installment_matches'), 7);
  } finally {
    await t.db.drop();
  }
});

test('matching all existing payments on a plan is bounded, idempotent and safe under concurrency', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const s = await planSetup(t, { bill: '300.00', installments: 3, total: '300.00', first: '2026-06-01' });
    const run = (o = {}) => plans.matchExistingPayments(t.db.pool, t.actor, { idempotencyKey: t.key(), planId: s.plan.id, version: 1, ...o }, 'r');
    await assert.rejects(run(), code('conflict'), 'nothing to match yet');
    await t.pay1({ paidOn: '2026-05-01', amount: '150.00', billId: s.b.id });
    await t.pay1({ paidOn: '2026-05-20', amount: '90.00', billId: s.b.id });
    const before = await s.ledgerSnapshot();
    await assert.rejects(run({ version: 7 }), code('stale_version'));
    const key = t.key();
    const first = await run({ idempotencyKey: key });
    assert.equal(first.replayed, false);
    assert.equal((await run({ idempotencyKey: key })).replayed, true);
    assert.equal(await s.ledgerSnapshot(), before, 'references only');
    const d = await s.detail();
    assert.deepEqual(d.installments.map((i) => [i.matchedCents, i.state]), [['10000', 'paid'], ['10000', 'paid'], ['4000', 'partial']]);
    assert.equal(await t.count('installment_matches'), 4);
    const audit = (await t.audit('plan.existing_payments_matched'))[0].detail;
    assert.deepEqual([audit.matchCount, audit.allocationCount, audit.matchedCents], [4, 2, '24000']);
    // Nothing is left to match until more cash is applied. Then only the new cash is used, up to what the schedule still owes.
    await assert.rejects(run(), code('conflict'));
    await t.pay1({ paidOn: '2026-06-10', amount: '50.00', billId: s.b.id });
    await run();
    assert.equal((await s.detail()).plan.matchedCents, '29000');
    // A removed match frees its cash again, and the bulk action offers it once more (a correction, never an edit).
    const alloc = d.matches[0].allocationId;
    await plans.unmatchInstallment(t.db.pool, t.actor, { idempotencyKey: t.key(), installmentId: d.installments[0].id, allocationId: alloc, amount: '40.00', reason: 'Wrong plan' }, 'r');
    await run();
    assert.equal((await s.detail()).plan.matchedCents, '29000');
    // Concurrent runs never count cash twice.
    const s2 = await planSetup(t, { bill: '1000.00', installments: 10, total: '1000.00', first: '2026-06-01' });
    for (const n of [1, 2, 3]) await t.pay1({ paidOn: `2026-05-0${n}`, amount: '70.00', billId: s2.b.id });
    const race = await Promise.allSettled(Array.from({ length: 5 }, () => plans.matchExistingPayments(t.db.pool, t.actor, { idempotencyKey: t.key(), planId: s2.plan.id, version: 1 }, 'r')));
    assert.equal(race.filter((x) => x.status === 'fulfilled').length, 1);
    for (const x of race.filter((y) => y.status === 'rejected')) assert.equal(x.reason.code, 'conflict');
    assert.equal((await s2.detail()).plan.matchedCents, '21000');
    const over = await t.db.pool.query(`select n.allocation_id from allocation_net n where n.net_cents < (select coalesce(sum(m.amount_cents), 0) from installment_matches m where m.allocation_id = n.allocation_id)`);
    assert.equal(over.rowCount, 0);
    // A cancelled plan takes no new matches, and another household cannot use the action.
    await plans.cancelPlan(t.db.pool, t.actor, { planId: s.plan.id, version: (await s.detail()).plan.version, reason: 'Paid off elsewhere' }, 'r');
    await t.pay1({ paidOn: '2026-06-11', amount: '10.00', billId: s.b.id });
    await assert.rejects(run({ version: (await s.detail()).plan.version }), code('conflict'));
    const h2 = (await t.db.pool.query(`insert into households (name) values ('Other Family') returning id`)).rows[0].id;
    const u2 = (await t.db.pool.query(`insert into users (household_id, email, display_name, role, password_hash) values ($1, 'other@example.test', 'Other Admin', 'admin', 'x') returning id`, [h2])).rows[0].id;
    const outsider = { userId: u2, householdId: h2, role: 'admin', displayName: 'Other Admin', sessionId: randomUUID() };
    await assert.rejects(plans.matchExistingPayments(t.db.pool, outsider, { idempotencyKey: t.key(), planId: s2.plan.id, version: 1 }, 'r'), code('not_found'));
    // The form route redirects back to the plan.
    const token = t.cookie.split('=')[1];
    const res = await handlers.handleExpenseAction(post('/api/expenses/plans/match-existing', { idempotencyKey: t.key(), planId: s2.plan.id, version: 1, csrf: csrfFor(token) }, { cookie: t.cookie, html: true }), t.ctx, 'plans/match-existing');
    assert.equal(new URL(res.headers.get('location')).pathname, `/plans/${s2.plan.id}`);
  } finally {
    await t.db.drop();
  }
});

test('a plan can carry its own start date, and only payments made since then are matched', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const m = await t.member();
    const p = await t.provider();
    const b = await t.bill({ memberId: m, providerId: p, originalAmount: '300.00' });
    await t.pay1({ paidOn: '2026-01-10', amount: '100.00', billId: b.id });
    await t.pay1({ paidOn: '2026-03-05', amount: '60.00', billId: b.id });
    await t.pay1({ paidOn: '2026-03-05', amount: '40.00', billId: b.id });
    const base = { name: 'Dated plan', billId: b.id, totalAmount: '300.00', installmentCount: '3', firstDueDate: '2026-03-01', cadence: 'monthly', matchExisting: 'on' };
    const plan = await plans.createPlan(t.db.pool, t.actor, { idempotencyKey: t.key(), ...base, startedOn: '2026-03-01' }, 'r');
    const d = await plans.getPlanDetail(t.db.pool, t.actor, plan.id, { asOf: AS_OF });
    // The January payment predates the plan and stays out; the two March payments are matched.
    assert.deepEqual([d.plan.startedOn, d.plan.matchedCents], ['2026-03-01', '10000']);
    assert.equal(d.allocations.length, 1, 'the January payment is still unmatched cash');
    assert.equal(d.allocations[0].paidOn, '2026-01-10');
    // The start date is a label: the real entry time is kept, and the audit trail records both.
    const row = (await t.db.pool.query(`select created_at::date::text as created, started_on::text as started from payment_plans where id = $1`, [plan.id])).rows[0];
    assert.notEqual(row.created, row.started);
    assert.equal((await t.audit('plan.created'))[0].detail.startedOn, '2026-03-01');
    // The bulk action uses the plan's start date too, so the January payment is still not offered.
    await assert.rejects(plans.matchExistingPayments(t.db.pool, t.actor, { idempotencyKey: t.key(), planId: plan.id, version: 1 }, 'r'), code('conflict'));
    // Without a date the plan starts today (UTC) and earlier payments are not matched.
    const today = await plans.createPlan(t.db.pool, t.actor, { idempotencyKey: t.key(), ...base, name: 'Today plan' }, 'r');
    const dt = await plans.getPlanDetail(t.db.pool, t.actor, today.id, { asOf: AS_OF });
    assert.deepEqual([dt.plan.startedOn, dt.plan.matchedCents], [new Date().toISOString().slice(0, 10), '0']);
    // Dates must be real, not in the future and not absurd.
    for (const bad of ['2999-01-01', '1800-01-01', '2026-02-30', 'soon']) await assert.rejects(plans.createPlan(t.db.pool, t.actor, { idempotencyKey: t.key(), ...base, startedOn: bad }, 'r'), code('invalid_input'));
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    await assert.rejects(plans.createPlan(t.db.pool, t.actor, { idempotencyKey: t.key(), ...base, startedOn: tomorrow }, 'r'), code('invalid_input'));
    assert.equal(await t.count('payment_plans'), 2);
  } finally {
    await t.db.drop();
  }
});

test('one plan covers bills from several providers: label, filters, matching across all its bills, refunds release matches', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const m = await t.member();
    const hospital = await t.provider('Example Hospital Services');
    const physicians = await t.provider('Example Physician Group');
    const lab = await t.provider('Unrelated Lab');
    const facility = await t.bill({ memberId: m, providerId: hospital, originalAmount: '300.00' });
    const doctor = await t.bill({ memberId: m, providerId: physicians, originalAmount: '200.00' });
    const unrelated = await t.bill({ memberId: m, providerId: lab, originalAmount: '50.00' });
    const estimate = await t.bill({ memberId: m, providerId: physicians, originalAmount: '90.00', amountStatus: 'estimate' });
    const p1 = await t.pay1({ paidOn: '2026-03-01', amount: '100.00', billId: facility.id });
    const p2 = await t.pay1({ paidOn: '2026-03-10', amount: '80.00', billId: doctor.id });
    await t.pay1({ paidOn: '2026-03-12', amount: '50.00', billId: unrelated.id });
    const snapshot = async () => JSON.stringify([
      (await t.db.pool.query(`select id, amount_cents::text from payments order by id`)).rows,
      (await t.db.pool.query(`select id, kind, amount_cents::text from payment_entries order by seq`)).rows,
      (await t.detail(facility.id)).openBalanceCents, (await t.detail(doctor.id)).openBalanceCents,
    ]);
    const before = await snapshot();
    const input = { idempotencyKey: t.key(), name: 'ER visit plan', [`bill_${facility.id}`]: 'on', [`bill_${doctor.id}`]: 'on', matchExisting: 'on', startedOn: '2026-01-01', totalAmount: '500.00', installmentCount: '5', firstDueDate: '2026-04-01', cadence: 'monthly' };
    // Still only confirmed bills, and every named bill must exist.
    await assert.rejects(plans.createPlan(t.db.pool, t.actor, { ...input, idempotencyKey: t.key(), [`bill_${estimate.id}`]: 'on' }, 'r'), code('conflict'));
    assert.equal(await t.count('payment_plans'), 0);
    const plan = await plans.createPlan(t.db.pool, t.actor, input, 'r');
    assert.equal(await snapshot(), before, 'a cross-provider plan creates no cash and changes no balance');
    const d = await plans.getPlanDetail(t.db.pool, t.actor, plan.id, { asOf: AS_OF });
    assert.deepEqual(d.plan.providerNames, ['Example Hospital Services', 'Example Physician Group']);
    assert.equal(d.plan.payee, 'Example Hospital Services and 1 more');
    assert.equal(d.plan.billCount, 2);
    // Payments on both providers' bills match, oldest first: $100 pays #1.
    assert.deepEqual(d.installments.map((i) => i.matchedCents), ['10000', '8000', '0', '0', '0']);
    assert.deepEqual([...new Set(d.matches.map((x) => x.billId))].sort(), [facility.id, doctor.id].sort());
    const created = (await t.audit('plan.created'))[0].detail;
    assert.deepEqual([created.providerCount, created.billCount, created.matchedExistingCents], [2, 2, '18000']);
    // The plan is listed under each provider it covers and under none it does not; search finds it by either name.
    const list = (o) => plans.listPlans(t.db.pool, t.actor, o, AS_OF).then((r) => r.items.map((x) => x.id));
    assert.deepEqual(await list({ providerId: hospital }), [plan.id]);
    assert.deepEqual(await list({ providerId: physicians }), [plan.id]);
    assert.deepEqual(await list({ providerId: lab }), []);
    assert.deepEqual(await list({ q: 'physician' }), [plan.id]);
    const queue = await plans.listInstallmentQueue(t.db.pool, t.actor, { providerId: physicians, asOf: AS_OF });
    assert.equal(queue.items.length > 0 && queue.items.every((i) => i.planId === plan.id), true);
    assert.equal(queue.items[0].payee, 'Example Hospital Services and 1 more');
    assert.equal((await plans.listInstallmentQueue(t.db.pool, t.actor, { providerId: lab, asOf: AS_OF })).items.length, 0);
    // Cash applied later to either provider's bill can be matched, and the bulk action sees both providers' bills.
    await t.pay1({ paidOn: '2026-05-01', amount: '60.00', billId: doctor.id });
    await plans.matchExistingPayments(t.db.pool, t.actor, { idempotencyKey: t.key(), planId: plan.id, version: d.plan.version }, 'r');
    assert.deepEqual((await plans.getPlanDetail(t.db.pool, t.actor, plan.id, { asOf: AS_OF })).installments.map((i) => i.matchedCents), ['10000', '10000', '4000', '0', '0']);
    // A cash match is still never over-counted: the other plan cannot take already matched cash.
    const rival = await plans.createPlan(t.db.pool, t.actor, { ...input, idempotencyKey: t.key(), name: 'Second view' }, 'r');
    assert.equal((await plans.getPlanDetail(t.db.pool, t.actor, rival.id, { asOf: AS_OF })).plan.matchedCents, '0');
    // A refund on the physician payment releases matches (latest due first), whichever provider's bill it was applied to.
    const alloc2 = (await t.payment(p2.id)).allocations[0].allocationId;
    await t.refund(p2.id, { allocationId: alloc2, amount: '50.00' });
    const after = await plans.getPlanDetail(t.db.pool, t.actor, plan.id, { asOf: AS_OF });
    assert.equal(after.installments.reduce((a, i) => a + BigInt(i.matchedCents), 0n), 24000n - 5000n, 'matches never exceed the cash that is left');
    assert.equal((await t.audit('plan.match_released')).length > 0, true);
    // The facility payment is untouched by that refund.
    const alloc1 = (await t.payment(p1.id)).allocations[0].allocationId;
    assert.equal(after.matches.filter((x) => x.allocationId === alloc1).reduce((a, x) => a + BigInt(x.amountCents), 0n), 10000n);
    // The database accepts bills of any provider for a plan, but still only confirmed ones, even by raw SQL.
    await assert.rejects(t.db.pool.query(`insert into payment_plan_bills (household_id, plan_id, bill_id) values ($1, $2, $3)`, [t.actor.householdId, plan.id, estimate.id]), /confirmed/);
  } finally {
    await t.db.drop();
  }
});

test('migration 0013 keeps existing single-provider plans, their matches and their provider listing', { skip: skipDb }, async () => {
  const { freshDatabase, seedHousehold } = await import('./helpers.mjs');
  const { migrate } = await import('../../apps/web/server/migrate.ts');
  const svc = await import('../../apps/web/server/services/expenses.ts');
  const db = await freshDatabase({ migrateAll: false });
  try {
    await migrate(db.pool, { upTo: '0012' });
    const { householdId, adminUserId } = await seedHousehold(db.pool);
    const actor = { userId: adminUserId, householdId, role: 'admin', displayName: 'Alex Example', sessionId: randomUUID(), mustChangePassword: false };
    const m = (await svc.createMember(db.pool, actor, { name: 'Pat Example' }, 'r')).id;
    const p = (await svc.createProvider(db.pool, actor, { name: 'Example Clinic', kind: 'clinician' }, 'r')).id;
    const other = (await svc.createProvider(db.pool, actor, { name: 'Other Lab', kind: 'clinician' }, 'r')).id;
    const b = await svc.createBill(db.pool, actor, { idempotencyKey: randomUUID(), memberId: m, providerId: p, statementDate: '2026-01-05', originalAmount: '200.00', amountStatus: 'confirmed', amountSource: 'statement' }, 'r');
    const pm = await pay.recordPayment(db.pool, actor, { idempotencyKey: randomUUID(), paidOn: '2026-03-01', amount: '50.00', method: 'card', billId: b.id }, 'r');
    // Read straight from the ledger: the payment detail query reads tables that a later migration adds.
    const alloc = (await db.pool.query(`select id from payment_entries where payment_id = $1 and kind = 'allocation'`, [pm.id])).rows[0].id;
    // An existing plan as the previous schema stored it: one provider on the plan, bills of that provider, one matched installment.
    const planId = randomUUID(), revId = randomUUID(), instId = randomUUID(), instId2 = randomUUID();
    const c = await db.pool.connect();
    try {
      await c.query('begin');
      await c.query(`insert into payment_plans (id, household_id, provider_id, name, started_on, created_by) values ($1, $2, $3, 'Old plan', '2026-01-01', $4)`, [planId, householdId, p, adminUserId]);
      await c.query(`insert into payment_plan_bills (household_id, plan_id, bill_id) values ($1, $2, $3)`, [householdId, planId, b.id]);
      await c.query(`insert into plan_revisions (id, household_id, plan_id, revision_no, total_cents, cadence, reason, created_by) values ($1, $2, $3, 1, 20000, 'monthly', 'Initial schedule', $4)`, [revId, householdId, planId, adminUserId]);
      await c.query(`insert into plan_installments (id, household_id, plan_id, revision_id, seq, due_date, amount_cents) values ($1, $2, $3, $4, 1, '2026-04-01', 10000), ($5, $2, $3, $4, 2, '2026-05-01', 10000)`, [instId, householdId, planId, revId, instId2]);
      await c.query(`insert into installment_matches (id, household_id, plan_id, revision_id, installment_id, payment_id, allocation_id, bill_id, kind, amount_cents, created_by) values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, 'match', 5000, $8)`, [householdId, planId, revId, instId, pm.id, alloc, b.id, adminUserId]);
      await c.query('commit');
    } finally {
      c.release();
    }
    assert.deepEqual(await migrate(db.pool), ['0013', '0014', '0015', '0016', '0017', '0018']);
    // Nothing in the ledger changed, and the plan still reads the same.
    assert.deepEqual((await db.pool.query(`select count(*)::int n, sum(amount_cents)::text s from installment_matches`)).rows[0], { n: 1, s: '5000' });
    assert.deepEqual((await db.pool.query(`select count(*)::int n, sum(amount_cents)::text s from payment_entries`)).rows[0], { n: 1, s: '5000' });
    assert.equal((await db.pool.query(`select 1 from information_schema.columns where table_name = 'payment_plans' and column_name = 'provider_id'`)).rowCount, 0);
    const d = await plans.getPlanDetail(db.pool, actor, planId, { asOf: AS_OF });
    assert.deepEqual([d.plan.payee, d.plan.providerNames, d.plan.matchedCents, d.plan.totalCents], ['Example Clinic', ['Example Clinic'], '5000', '20000']);
    assert.deepEqual(d.installments.map((i) => [i.matchedCents, i.state]), [['5000', 'partial'], ['0', 'unpaid']]);
    const listed = (id) => plans.listPlans(db.pool, actor, { providerId: id }, AS_OF).then((r) => r.items.map((x) => x.id));
    assert.deepEqual([await listed(p), await listed(other)], [[planId], []]);
    // After the upgrade a bill of another provider can join a new plan, and the old rules about amounts still hold.
    const b2 = await svc.createBill(db.pool, actor, { idempotencyKey: randomUUID(), memberId: m, providerId: other, statementDate: '2026-01-06', originalAmount: '40.00', amountStatus: 'confirmed', amountSource: 'statement' }, 'r');
    const np = await plans.createPlan(db.pool, actor, { idempotencyKey: randomUUID(), name: 'New plan', billIds: [b.id, b2.id], totalAmount: '240.00', installmentCount: '2', firstDueDate: '2026-06-01', startedOn: '2026-01-01', cadence: 'monthly' }, 'r');
    assert.equal((await plans.getPlanDetail(db.pool, actor, np.id, { asOf: AS_OF })).plan.payee, 'Example Clinic and 1 more');
  } finally {
    await db.drop();
  }
});

// ---------- input modes, remainder choices, warnings and keep-paid scheduling (pure, no database) ----------

test('a total can be split with the cents on the earliest, on the last, or with a smaller last installment', () => {
  assert.deepEqual(plans.splitTotal(10000n, 3, 'earliest'), [3334n, 3333n, 3333n]);
  assert.deepEqual(plans.splitTotal(10000n, 3, 'last_extra'), [3333n, 3333n, 3334n]);
  assert.deepEqual(plans.splitTotal(10000n, 3, 'last_short'), [3334n, 3334n, 3332n]);
  for (const r of ['earliest', 'last_extra', 'last_short']) {
    assert.deepEqual(plans.splitTotal(900n, 3, r), [300n, 300n, 300n]);
    assert.equal(plans.splitTotal(10001n, 7, r).reduce((a, b) => a + b, 0n), 10001n);
  }
  assert.deepEqual(plans.splitTotal(777n, 1, 'last_short'), [777n]);
  // Rounding up would leave nothing for the last installment.
  assert.throws(() => plans.splitTotal(5n, 4, 'last_short'), AppError);
  assert.throws(() => plans.splitTotal(3n, 4, 'earliest'), AppError);
  // The default stays the original behavior.
  const s = plans.buildSchedule({ cadence: 'monthly', totalAmount: 10000n, installmentCount: 3, firstDueDate: '2026-01-31' });
  assert.deepEqual(s.lines.map((l) => l.amountCents), [3334n, 3333n, 3333n]);
  assert.equal(s.generated, true);
  assert.equal(plans.buildSchedule({ cadence: 'monthly', totalAmount: 10000n, installmentCount: 3, firstDueDate: '2026-01-31', remainder: 'last_short' }).lines[2].amountCents, 3332n);
});

test('paid per installment: count times amount, or a total with a smaller last installment, and a mismatch is reported', () => {
  const base = { cadence: 'monthly', firstDueDate: '2026-03-21', inputMode: 'per_installment' };
  const counted = plans.buildSchedule({ ...base, totalAmount: null, installmentCount: 3, installmentAmount: 3333n });
  assert.equal(counted.totalCents, 9999n); // no rounding: 3 x 33.33
  assert.equal(counted.expectedTotalCents, null);
  assert.deepEqual(plans.planWarnings({ schedule: counted, openBalanceCents: null, matchedCents: 0n }), []);
  // The count and a total are both given and do not agree: still saved as count x amount, with a warning that shows the difference.
  const both = plans.buildSchedule({ ...base, totalAmount: 10000n, installmentCount: 3, installmentAmount: 3333n });
  assert.equal(both.totalCents, 9999n);
  assert.deepEqual(plans.planWarnings({ schedule: both, openBalanceCents: null, matchedCents: 0n }), [{ code: 'total_mismatch', expectedCents: '10000', computedCents: '9999', differenceCents: '-1' }]);
  // A total and an amount, no count: as many full installments as fit and a smaller last one for the rest.
  const derived = plans.buildSchedule({ ...base, totalAmount: 68293n, installmentCount: null, installmentAmount: 10000n });
  assert.deepEqual(derived.lines.map((l) => l.amountCents), [10000n, 10000n, 10000n, 10000n, 10000n, 10000n, 8293n]);
  assert.equal(derived.lines[6].dueDate, '2026-09-21');
  assert.equal(derived.totalCents, 68293n);
  assert.throws(() => plans.buildSchedule({ ...base, totalAmount: null, installmentCount: null, installmentAmount: 10000n }), AppError);
  assert.throws(() => plans.buildSchedule({ ...base, totalAmount: null, installmentCount: 3, installmentAmount: null }), AppError);
  assert.throws(() => plans.buildSchedule({ ...base, totalAmount: 1_000_000n, installmentCount: null, installmentAmount: 100n }), AppError); // more than 120 installments
  assert.throws(() => plans.buildSchedule({ cadence: 'monthly', firstDueDate: '2026-03-21', totalAmount: 100n, installmentCount: 2, installmentAmount: 50n }), AppError); // amount needs its mode
});

test('warnings compare the plan with the bills without ever blocking, and show the signed difference', () => {
  const sched = plans.buildSchedule({ cadence: 'monthly', totalAmount: 10000n, installmentCount: 3, firstDueDate: '2026-01-01' });
  const codes = (d) => plans.planWarnings({ schedule: sched, ...d }).map((w) => w.code);
  assert.deepEqual(codes({ openBalanceCents: 10000n, matchedCents: 0n }), ['unequal_installments']); // only the one-cent rounding
  assert.deepEqual(codes({ openBalanceCents: null, matchedCents: 0n }), ['unequal_installments']);
  // Cash already matched is compared with what is left, not with a balance that already excludes it.
  assert.deepEqual(codes({ openBalanceCents: 7500n, matchedCents: 2500n }), ['unequal_installments']);
  const above = plans.planWarnings({ schedule: sched, openBalanceCents: 9000n, matchedCents: 0n }).find((w) => w.code === 'bill_balance_mismatch');
  assert.deepEqual(above, { code: 'bill_balance_mismatch', planBasisCents: '10000', openBalanceCents: '9000', differenceCents: '1000', direction: 'above' });
  const below = plans.planWarnings({ schedule: sched, openBalanceCents: 12000n, matchedCents: 0n }).find((w) => w.code === 'bill_balance_mismatch');
  assert.equal(below.direction, 'below');
  assert.equal(below.differenceCents, '-2000');
  // A credit can make the balance negative.
  assert.equal(plans.planWarnings({ schedule: sched, openBalanceCents: -500n, matchedCents: 0n }).find((w) => w.code === 'bill_balance_mismatch').direction, 'above');
  const exact = plans.buildSchedule({ cadence: 'monthly', totalAmount: 9000n, installmentCount: 3, firstDueDate: '2026-01-01' });
  assert.deepEqual(plans.planWarnings({ schedule: exact, openBalanceCents: 9000n, matchedCents: 0n }), []);
});

test('keeping paid installments carries each kept installment\'s own payments, not whatever fits first', () => {
  const kept = [{ id: 'a', dueDate: '2026-06-01', amountCents: 25000n }, { id: 'c', dueDate: '2026-08-01', amountCents: 25000n }];
  const rest = plans.buildSchedule({ cadence: 'monthly', totalAmount: 50000n, installmentCount: 3, firstDueDate: '2026-10-01', remainder: 'last_short' });
  const s = plans.keepPaidSchedule(kept, rest);
  assert.deepEqual(s.lines.map((l) => [l.dueDate, l.amountCents]), [['2026-06-01', 25000n], ['2026-08-01', 25000n], ['2026-10-01', 16667n], ['2026-11-01', 16667n], ['2026-12-01', 16666n]]);
  assert.equal(s.totalCents, 100000n);
  assert.equal(s.cadence, 'custom');
  assert.deepEqual(s.lines.map((l) => l.keepFrom), ['a', 'c', undefined, undefined, undefined]);
  // Old schedule: four installments of 250.00. #a and #c are paid in full and #b holds a 40.00 partial match.
  const pair = (installmentId, allocationId, cents) => ({ installmentId, allocationId, paymentId: `p-${allocationId}`, billId: 'bill', cents });
  const pairs = [pair('a', 'A1', 25000n), pair('b', 'B1', 4000n), pair('c', 'C1', 25000n)];
  const placed = plans.carryMatches(pairs, s.lines).map((c) => [c.pair.allocationId, c.installmentIndex, c.amount]);
  assert.deepEqual(placed, [['A1', 0, 25000n], ['C1', 1, 25000n], ['B1', 2, 4000n]]);
  // Without the identity link the partial match would take room on the kept 08-01 line and push a paid payment onto a new one.
  const naive = plans.carryMatches(pairs, s.lines.map(({ amountCents }) => ({ amountCents }))).map((c) => [c.pair.allocationId, c.installmentIndex, c.amount]);
  assert.notDeepEqual(naive, placed);
  assert.deepEqual(naive.filter((x) => x[0] === 'C1').map((x) => x[1]), [1, 2]);
  // Replacing the whole schedule (nothing kept) is unchanged: matches fill from the first installment in due order.
  const replaced = plans.carryMatches(pairs, plans.buildSchedule({ cadence: 'monthly', totalAmount: 100000n, installmentCount: 4, firstDueDate: '2026-06-01' }).lines)
    .map((c) => [c.pair.allocationId, c.installmentIndex, c.amount]);
  assert.deepEqual(replaced, [['A1', 0, 25000n], ['B1', 1, 4000n], ['C1', 1, 21000n], ['C1', 2, 4000n]]);
  // Matches that do not fit the loose installments are refused, never dropped.
  assert.throws(() => plans.carryMatches([pair('x', 'X1', 90000n)], s.lines), AppError);
});

test('plans can be created per installment, with the leftover on the last one, and warn without blocking', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    // Bill is $300.00 (a fabricated household). The plan says $100.00 per installment for 4 installments: $400.00, more than the bill.
    const s = await planSetup(t, { installments: 3, total: '300.00' });
    const key = t.key();
    const body = { idempotencyKey: key, name: 'Per installment', billId: s.b.id, inputMode: 'per_installment', installmentAmount: '100.00', installmentCount: '4', totalAmount: '', firstDueDate: '2026-09-01', startedOn: '2026-01-01', matchExisting: 'off' };
    const created = await plans.createPlan(t.db.pool, t.actor, body, 'r');
    assert.equal((await plans.createPlan(t.db.pool, t.actor, body, 'r')).replayed, true);
    const d = await s.detail(created.id);
    assert.equal(d.plan.totalCents, '40000'); // saved even though it is above the bill's open balance
    assert.deepEqual(d.installments.map((i) => i.amountCents), ['10000', '10000', '10000', '10000']);
    const audit = (await t.audit('plan.created')).find((a) => a.detail.planId === created.id).detail;
    assert.equal(audit.inputMode, 'per_installment');
    assert.equal(audit.warningCodes, 'bill_balance_mismatch');
    assert.deepEqual([audit.expectedTotalCents, audit.computedTotalCents], [null, '40000']);
    // A count and a total that disagree are saved as count x amount, and both figures are recorded so the plan page can show the difference.
    const off = await plans.createPlan(t.db.pool, t.actor, { ...body, idempotencyKey: t.key(), name: 'Off by a cent', installmentAmount: '33.33', installmentCount: '3', totalAmount: '100.00' }, 'r');
    const offAudit = (await t.audit('plan.created')).find((a) => a.detail.planId === off.id).detail;
    assert.deepEqual([offAudit.expectedTotalCents, offAudit.computedTotalCents, offAudit.warningCodes.includes('total_mismatch')], ['10000', '9999', true]);
    // A total and an amount with no count: three full installments and a smaller last one, and no warning when it equals the open balance.
    const derived = await plans.createPlan(t.db.pool, t.actor, { ...body, idempotencyKey: t.key(), name: 'Derived', installmentCount: '', totalAmount: '300.00', installmentAmount: '110.00' }, 'r');
    const dd = await s.detail(derived.id);
    assert.deepEqual(dd.installments.map((i) => i.amountCents), ['11000', '11000', '8000']);
    assert.equal((await t.audit('plan.created')).find((a) => a.detail.planId === derived.id).detail.warningCodes, '');
    // The leftover cents on the last installment instead of the first ones.
    const last = await plans.createPlan(t.db.pool, t.actor, { ...body, idempotencyKey: t.key(), name: 'Last', inputMode: 'total', installmentAmount: '', installmentCount: '7', totalAmount: '300.00', remainder: 'last_extra' }, 'r');
    const dl = await s.detail(last.id);
    assert.equal(dl.installments.reduce((a, i) => a + BigInt(i.amountCents), 0n), 30000n);
    assert.equal(dl.installments[6].amountCents, '4290');
    assert.equal(dl.installments[0].amountCents, '4285');
    // An amount per installment with the total mode is refused.
    await assert.rejects(plans.createPlan(t.db.pool, t.actor, { ...body, idempotencyKey: t.key(), inputMode: 'total', totalAmount: '300.00' }, 'r'), code('invalid_input'));
    assert.equal(await t.count('payments'), 0, 'no mode of plan creation moves cash');
  } finally {
    await t.db.drop();
  }
});

test('keep-paid revision keeps paid installments with their own payments and restarts the rest from a date', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const s = await planSetup(t); // $300.00 as 3 x $100.00 due 06-01, 07-01, 08-01
    const pm = await t.pay1({ amount: '150.00', billId: s.b.id });
    const alloc = (await t.payment(pm.id)).allocations[0].allocationId;
    const d0 = await s.detail();
    await s.match(d0.installments[0].id, alloc, '100.00'); // #1 paid in full
    await s.match(d0.installments[1].id, alloc, '50.00'); // #2 half paid
    const snapshot = await s.ledgerSnapshot();
    const revise = (o) => plans.revisePlan(t.db.pool, t.actor, {
      idempotencyKey: t.key(), planId: s.plan.id, version: d0.plan.version, reason: 'Provider restructured', reviseMode: 'keep_paid', cadence: 'monthly', ...o,
    }, 'r');
    // The rest: $200.00 owed at $60.00 per installment from 2026-09-01 -> 60, 60, 60, 20.
    const body = { idempotencyKey: t.key(), planId: s.plan.id, version: d0.plan.version, reason: 'Provider restructured', reviseMode: 'keep_paid', cadence: 'monthly', inputMode: 'per_installment', installmentAmount: '60.00', totalAmount: '200.00', firstDueDate: '2026-09-01' };
    const rev = await plans.revisePlan(t.db.pool, t.actor, body, 'r');
    assert.equal((await plans.revisePlan(t.db.pool, t.actor, body, 'r')).replayed, true);
    assert.equal(rev.replayed, false);
    assert.equal(await t.count('plan_revisions'), 2, 'a replayed revision is one revision');
    const d1 = await s.detail();
    assert.deepEqual(d1.installments.map((i) => [i.dueDate, i.amountCents, i.matchedCents, i.state]), [
      ['2026-06-01', '10000', '10000', 'paid'], ['2026-09-01', '6000', '5000', 'partial'], ['2026-10-01', '6000', '0', 'unpaid'],
      ['2026-11-01', '6000', '0', 'unpaid'], ['2026-12-01', '2000', '0', 'unpaid'],
    ]);
    assert.equal(d1.plan.totalCents, '30000');
    assert.equal(d1.plan.cadence, 'custom');
    // The kept installment holds the same payment, and the partial match followed into the first new installment. Revision 1 is untouched.
    const carried = d1.matches.filter((m) => m.revisionNo === 2);
    assert.deepEqual(carried.map((m) => [m.installmentSeq, m.amountCents, m.carried, m.reason]), [
      [1, '10000', true, 'Kept from revision 1'], [2, '5000', true, 'Carried forward from revision 1'],
    ]);
    assert.equal(d1.revisions[0].installmentCount, 3);
    assert.equal(d1.matches.filter((m) => m.revisionNo === 1).length, 2);
    assert.equal(await s.ledgerSnapshot(), snapshot, 'revising moved no cash and changed no balance');
    const a = (await t.audit('plan.revised'))[0].detail;
    assert.deepEqual([a.reviseMode, a.keptInstallmentCount, a.keptCents, a.rescheduledCount, a.rescheduledCents, a.inputMode], ['keep_paid', 1, '10000', 4, '20000', 'per_installment']);
    // A stale form is refused and leaves nothing behind.
    await assert.rejects(revise({ version: d0.plan.version, totalAmount: '200.00', installmentCount: '2', firstDueDate: '2026-12-01' }), code('stale_version'));
    assert.equal(await t.count('plan_revisions'), 2);
    // Keeping paid installments in a plan whose installments are all paid is refused.
    const full = await s.create({ name: 'All paid', totalAmount: '100.00', installmentCount: '1', firstDueDate: '2026-06-01' });
    const pm2 = await t.pay1({ amount: '100.00', billId: s.b.id });
    const alloc2 = (await t.payment(pm2.id)).allocations[0].allocationId;
    const df = await s.detail(full.id);
    await s.match(df.installments[0].id, alloc2, '100.00');
    await assert.rejects(plans.revisePlan(t.db.pool, t.actor, { idempotencyKey: t.key(), planId: full.id, version: df.plan.version, reason: 'x', reviseMode: 'keep_paid', totalAmount: '50.00', installmentCount: '1', firstDueDate: '2026-09-01' }, 'r'), code('conflict'));
  } finally {
    await t.db.drop();
  }
});

test('a plan can be renamed at any time, including after it is cancelled, without touching money or the schedule', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const s = await planSetup(t);
    const d0 = await s.detail();
    const snapshot = await s.ledgerSnapshot();
    const rename = (name, planId = s.plan.id) => plans.renamePlan(t.db.pool, t.actor, { planId, name }, 'r');
    await rename('Hospital plan, first version');
    assert.equal((await s.detail()).plan.name, 'Hospital plan, first version');
    await plans.cancelPlan(t.db.pool, t.actor, { planId: s.plan.id, version: (await s.detail()).plan.version, reason: 'Provider restructured the plan' }, 'r');
    const cancelled = await s.detail();
    assert.equal(cancelled.plan.status, 'cancelled');
    await rename('Cancelled: replaced by the March plan');
    const after = await s.detail();
    assert.equal(after.plan.name, 'Cancelled: replaced by the March plan');
    assert.equal(after.plan.status, 'cancelled');
    assert.equal(after.plan.version, cancelled.plan.version, 'a rename does not make open forms stale');
    assert.deepEqual(after.installments.map((i) => i.amountCents), d0.installments.map((i) => i.amountCents));
    assert.equal(await s.ledgerSnapshot(), snapshot);
    const audits = await t.audit('plan.renamed');
    assert.equal(audits.length, 2);
    assert.deepEqual(audits.map((a) => [a.detail.renamed, a.detail.status]).sort(), [[true, 'active'], [true, 'cancelled']]);
    assert.equal(JSON.stringify(audits).includes('Cancelled: replaced'), false, 'no name text is copied into the audit');
    await assert.rejects(rename('   '), (e) => e instanceof AppError);
    await assert.rejects(rename('Nobody\'s plan', randomUUID()), code('not_found'));
  } finally {
    await t.db.drop();
  }
});

test('restructuring a plan after payments: keep the first installment, restart the rest, then match the payments already made', { skip: skipDb }, async () => {
  // Fabricated figures with the same shape as a real restructure: one payment at the original rate, then smaller monthly payments,
  // and a last installment that is only the remainder. The bill is $720.50.
  const t = await setup();
  try {
    const m = await t.member();
    const p = await t.provider();
    const b = await t.bill({ memberId: m, providerId: p, originalAmount: '720.50' });
    const pays = [['2026-01-21', '60.00'], ['2026-02-21', '55.00'], ['2026-03-21', '55.00'], ['2026-04-21', '55.00'], ['2026-05-21', '55.00'], ['2026-06-21', '55.00']];
    for (const [paidOn, amount] of pays) await t.pay1({ paidOn, amount, billId: b.id });
    // The original plan: $60.00 x 12 from January 21, matching nothing automatically.
    const plan = await plans.createPlan(t.db.pool, t.actor, {
      idempotencyKey: t.key(), name: 'Original plan', billId: b.id, inputMode: 'per_installment', installmentAmount: '60.00', installmentCount: '12',
      firstDueDate: '2026-01-21', cadence: 'monthly', startedOn: '2026-01-01',
    }, 'r');
    const detail = () => plans.getPlanDetail(t.db.pool, t.actor, plan.id, { asOf: AS_OF });
    const d0 = await detail();
    assert.equal(d0.plan.matchedCents, '0');
    // Hand-match the January payment to installment 1 (60.00 equals it exactly).
    const jan = d0.allocations.find((a) => a.paidOn === '2026-01-21');
    await plans.matchInstallment(t.db.pool, t.actor, { idempotencyKey: t.key(), installmentId: d0.installments[0].id, allocationId: jan.allocationId, amount: '60.00' }, 'r');
    const d1 = await detail();
    assert.equal(d1.installments[0].state, 'paid');
    // Keep installment 1, and schedule the rest: $660.50 still to schedule at $55.00 each, count worked out, restarting Feb 21.
    await plans.revisePlan(t.db.pool, t.actor, {
      idempotencyKey: t.key(), planId: plan.id, version: d1.plan.version, reason: 'Provider restructured', reviseMode: 'keep_paid', inputMode: 'per_installment',
      installmentAmount: '55.00', totalAmount: '660.50', firstDueDate: '2026-02-21', cadence: 'monthly',
    }, 'r');
    const d2 = await detail();
    assert.equal(d2.plan.totalCents, '72050', 'the plan total equals the bill');
    assert.equal(d2.installments.length, 14);
    assert.deepEqual([d2.installments[0].dueDate, d2.installments[0].amountCents, d2.installments[0].state], ['2026-01-21', '6000', 'paid']);
    assert.deepEqual([d2.installments[1].dueDate, d2.installments[1].amountCents, d2.installments[12].dueDate, d2.installments[13].dueDate, d2.installments[13].amountCents],
      ['2026-02-21', '5500', '2027-01-21', '2027-02-21', '50']);
    // Until the payments are matched, the plan schedules more than the bill owes, and the page says so (the gap is the cash already paid).
    assert.equal(d2.plan.matchedCents, '6000');
    // Match the payments already made, oldest first onto the earliest installments that still owe.
    await plans.matchExistingPayments(t.db.pool, t.actor, { idempotencyKey: t.key(), planId: plan.id, version: d2.plan.version }, 'r');
    const d3 = await detail();
    assert.deepEqual(d3.installments.slice(0, 7).map((i) => i.state), ['paid', 'paid', 'paid', 'paid', 'paid', 'paid', 'unpaid']);
    assert.deepEqual(d3.installments.slice(0, 6).map((i) => i.matchedCents), ['6000', '5500', '5500', '5500', '5500', '5500']);
    assert.equal(d3.plan.matchedCents, '33500');
    // The plan now schedules exactly what the bill still owes: no balance gap.
    assert.equal(String(BigInt(d3.plan.totalCents) - BigInt(d3.plan.matchedCents)), (await t.detail(b.id)).openBalanceCents);
  } finally {
    await t.db.drop();
  }
});

test('a keep-paid revision racing matches never double counts cash and causes no lock-order retries', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const s = await planSetup(t);
    const pm = await t.pay1({ amount: '150.00', billId: s.b.id });
    const alloc = (await t.payment(pm.id)).allocations[0].allocationId;
    const d0 = await s.detail();
    await s.match(d0.installments[0].id, alloc, '100.00');
    retryStats.lockConflicts = 0;
    const revise = plans.revisePlan(t.db.pool, t.actor, {
      idempotencyKey: t.key(), planId: s.plan.id, version: d0.plan.version, reason: 'Restructured', reviseMode: 'keep_paid', inputMode: 'per_installment',
      installmentAmount: '60.00', totalAmount: '200.00', firstDueDate: '2026-09-01', cadence: 'monthly',
    }, 'r');
    // Several matches of the same $50.00 left on the allocation, aimed at the old second installment, race the revision.
    const matches = [1, 2, 3].map(() => s.match(d0.installments[1].id, alloc, '50.00'));
    const results = await Promise.allSettled([revise, ...matches]);
    for (const r of results.slice(1)) if (r.status === 'rejected') assert.ok(['conflict'].includes(r.reason.code), `unexpected ${r.reason?.code}`);
    assert.equal(results[0].status, 'fulfilled', String(results[0].reason?.code));
    assert.equal(retryStats.lockConflicts, 0, 'no lock-cycle retries');
    // However the race fell, the current schedule never holds more than the cash, nor more than an installment's amount.
    const d1 = await s.detail();
    const matched = d1.installments.reduce((a, i) => a + BigInt(i.matchedCents), 0n);
    assert.ok(matched <= 15000n, `matched ${matched} exceeds the $150.00 applied`);
    for (const i of d1.installments) assert.ok(BigInt(i.matchedCents) <= BigInt(i.amountCents));
    assert.equal(d1.installments[0].state, 'paid');
    assert.equal((await t.detail(s.b.id)).openBalanceCents, '15000');
  } finally {
    await t.db.drop();
  }
});

test('rounding is only warned about for a price and count split, not for a worked-out last installment', () => {
  const warn = (sched) => plans.planWarnings({ schedule: sched, openBalanceCents: null, matchedCents: 0n }).map((w) => w.code);
  const derived = plans.buildSchedule({ cadence: 'monthly', firstDueDate: '2026-03-21', inputMode: 'per_installment', totalAmount: 29999n, installmentCount: null, installmentAmount: 10000n });
  assert.deepEqual(derived.lines.map((l) => l.amountCents), [10000n, 10000n, 9999n]);
  assert.deepEqual(warn(derived), []);
  assert.deepEqual(warn(plans.buildSchedule({ cadence: 'monthly', firstDueDate: '2026-03-21', totalAmount: 10000n, installmentCount: 3 })), ['unequal_installments']);
  // Explicit and kept lists are never flagged for rounding.
  assert.deepEqual(warn(plans.keepPaidSchedule([{ id: 'a', dueDate: '2026-01-01', amountCents: 5000n }], plans.buildSchedule({ cadence: 'monthly', firstDueDate: '2026-02-01', totalAmount: 10000n, installmentCount: 3 }))), []);
});

test('revisions record every warning in the audit, refuse more than 120 installments, and tie the replay key to the entered total', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const s = await planSetup(t); // $300.00 bill, 3 x $100.00
    const d0 = await s.detail();
    const revise = (o) => plans.revisePlan(t.db.pool, t.actor, { idempotencyKey: t.key(), planId: s.plan.id, version: d0.plan.version, reason: 'Change', cadence: 'monthly', ...o }, 'r');
    const lastCodes = async () => (await t.audit('plan.revised')).at(-1).detail.warningCodes;
    // A replacement schedule of $900.00 on a $300.00 bill: the balance warning is recorded, and the save still succeeds.
    await revise({ totalAmount: '900.00', installmentCount: '3', firstDueDate: '2026-09-01' });
    assert.equal(await lastCodes(), 'bill_balance_mismatch');
    // A schedule that equals the balance records nothing.
    const d1 = await s.detail();
    await plans.revisePlan(t.db.pool, t.actor, { idempotencyKey: t.key(), planId: s.plan.id, version: d1.plan.version, reason: 'Back', totalAmount: '300.00', installmentCount: '3', firstDueDate: '2026-09-01', cadence: 'monthly' }, 'r');
    assert.equal(await lastCodes(), '');
    // Keeping a paid installment and leaving the pre-filled whole total makes the plan exceed the bill, and that is recorded.
    const pm = await t.pay1({ amount: '100.00', billId: s.b.id });
    const alloc = (await t.payment(pm.id)).allocations[0].allocationId;
    const d2 = await s.detail();
    await s.match(d2.installments[0].id, alloc, '100.00');
    const d3 = await s.detail();
    await plans.revisePlan(t.db.pool, t.actor, { idempotencyKey: t.key(), planId: s.plan.id, version: d3.plan.version, reason: 'Keep', reviseMode: 'keep_paid', totalAmount: '300.00', installmentCount: '3', firstDueDate: '2026-12-01', cadence: 'monthly' }, 'r');
    assert.equal(await lastCodes(), 'bill_balance_mismatch');
    assert.equal((await s.detail()).plan.totalCents, '40000');
    // More than 120 installments in total (kept plus new) is refused and nothing is written.
    const before = await t.count('plan_revisions');
    const d4 = await s.detail();
    await assert.rejects(plans.revisePlan(t.db.pool, t.actor, { idempotencyKey: t.key(), planId: s.plan.id, version: d4.plan.version, reason: 'Too many', reviseMode: 'keep_paid', totalAmount: '1200.00', installmentCount: '120', firstDueDate: '2027-06-01', cadence: 'monthly' }, 'r'), code('invalid_input'));
    assert.equal(await t.count('plan_revisions'), before);
    // The same key with a different entered total is a conflict, not a replay that hides the mismatch.
    const key = t.key();
    const base = { idempotencyKey: key, planId: s.plan.id, version: d4.plan.version, reason: 'Per', inputMode: 'per_installment', installmentAmount: '100.00', installmentCount: '3', firstDueDate: '2027-01-01', cadence: 'monthly' };
    await plans.revisePlan(t.db.pool, t.actor, { ...base, totalAmount: '300.00' }, 'r');
    assert.equal((await plans.revisePlan(t.db.pool, t.actor, { ...base, totalAmount: '300.00' }, 'r')).replayed, true);
    await assert.rejects(plans.revisePlan(t.db.pool, t.actor, { ...base, totalAmount: '250.00' }, 'r'), code('conflict'));
  } finally {
    await t.db.drop();
  }
});

test('what a keep-paid revision keeps is decided under the lock when an installment becomes paid at the same moment', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const s = await planSetup(t);
    const pm = await t.pay1({ amount: '200.00', billId: s.b.id });
    const alloc = (await t.payment(pm.id)).allocations[0].allocationId;
    const d0 = await s.detail();
    await s.match(d0.installments[0].id, alloc, '100.00');
    retryStats.lockConflicts = 0;
    const revise = plans.revisePlan(t.db.pool, t.actor, {
      idempotencyKey: t.key(), planId: s.plan.id, version: d0.plan.version, reason: 'Restructured', reviseMode: 'keep_paid', inputMode: 'per_installment',
      installmentAmount: '60.00', totalAmount: '200.00', firstDueDate: '2026-09-01', cadence: 'monthly',
    }, 'r');
    const results = await Promise.allSettled([revise, s.match(d0.installments[1].id, alloc, '100.00')]);
    assert.equal(results[0].status, 'fulfilled', String(results[0].reason?.code));
    if (results[1].status === 'rejected') assert.equal(results[1].reason.code, 'conflict');
    assert.equal(retryStats.lockConflicts, 0);
    const kept = (await t.audit('plan.revised')).at(-1).detail.keptInstallmentCount;
    const d1 = await s.detail();
    // Whatever the order, the installments kept are exactly those fully paid at the moment of the revision, and every one of them is still paid.
    assert.ok(kept === 1 || kept === 2, `kept ${kept}`);
    for (let i = 0; i < kept; i++) assert.equal(d1.installments[i].state, 'paid');
    assert.equal(d1.installments.length, kept + 4);
    const matched = d1.installments.reduce((a, i) => a + BigInt(i.matchedCents), 0n);
    assert.ok(matched <= 20000n);
    assert.equal(d1.plan.totalCents, String(BigInt(kept) * 10000n + 20000n));
  } finally {
    await t.db.drop();
  }
});

test('revision composition is one function for the save and the preview, and refuses what the save refuses', () => {
  // $500.00 still to schedule at $45.00 from 2026-09-01: eleven installments of $45.00 and a smaller last one of $5.00.
  const rest = plans.buildSchedule({ cadence: 'monthly', totalAmount: 50000n, installmentCount: null, firstDueDate: '2026-09-01', inputMode: 'per_installment', installmentAmount: 4500n });
  assert.deepEqual(rest.lines.map((l) => l.amountCents), [...Array.from({ length: 11 }, () => 4500n), 500n]);
  const current = [
    { id: 'a', dueDate: '2026-01-01', amountCents: '5000', unpaidCents: '0' }, { id: 'b', dueDate: '2026-02-01', amountCents: '5000', unpaidCents: '0' },
    { id: 'c', dueDate: '2026-03-01', amountCents: '5000', unpaidCents: '2500' },
  ];
  const kept = plans.keptInstallments(current);
  assert.deepEqual(kept.map((k) => [k.id, k.amountCents]), [['a', 5000n], ['b', 5000n]]);
  const s = plans.composeRevision({ restSchedule: rest, kept, reviseMode: 'keep_paid', currentCount: 3, matchedCents: 10000n });
  assert.equal(s.lines.length, 14);
  assert.equal(s.totalCents, 60000n);
  assert.deepEqual(s.lines.slice(0, 2).map((l) => l.keepFrom), ['a', 'b']);
  assert.equal(s.lines.at(-1).amountCents, 500n);
  // Nothing left to restart, a total below what is matched and the installment cap are refused, as the save refuses them.
  assert.throws(() => plans.composeRevision({ restSchedule: rest, kept, reviseMode: 'keep_paid', currentCount: 2, matchedCents: 0n }), code('conflict'));
  assert.throws(() => plans.composeRevision({ restSchedule: rest, kept: [], reviseMode: 'replace', currentCount: 3, matchedCents: 60000n }), code('conflict'));
  const long = plans.buildSchedule({ cadence: 'monthly', totalAmount: 12000n, installmentCount: 120, firstDueDate: '2026-09-01' });
  assert.throws(() => plans.composeRevision({ restSchedule: long, kept, reviseMode: 'keep_paid', currentCount: 3, matchedCents: 0n }), code('invalid_input'));
  // Warnings: what was typed (the entered total against count x amount) and the whole plan against the bills.
  const typed = plans.buildSchedule({ cadence: 'monthly', totalAmount: 50000n, installmentCount: 12, firstDueDate: '2026-09-01', inputMode: 'per_installment', installmentAmount: 4500n });
  const codes = plans.revisionWarnings({ restSchedule: typed, schedule: plans.keepPaidSchedule(kept, typed), billsOpenCents: 50000n, matchedCents: 10000n }).map((w) => w.code);
  assert.deepEqual(codes, ['total_mismatch', 'bill_balance_mismatch']);
});

test('a restructure post keeps the paid installments and their matches and ends with a smaller last installment; the preview shows the same and writes nothing', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const s = await planSetup(t, { bill: '600.00', installments: 12, total: '600.00', first: '2026-01-01' }); // 12 x $50.00
    const pm = await t.pay1({ amount: '100.00', billId: s.b.id });
    const alloc = (await t.payment(pm.id)).allocations[0].allocationId;
    const d0 = await s.detail();
    await s.match(d0.installments[0].id, alloc, '50.00');
    await s.match(d0.installments[1].id, alloc, '50.00'); // two installments fully paid, $500.00 left
    const snapshot = await s.ledgerSnapshot();
    const fields = { totalAmount: '500.00', installmentAmount: '45.00', firstDueDate: '2026-09-01', cadence: 'monthly', inputMode: 'per_installment', reviseMode: 'keep_paid' };
    const countAll = async () => [await t.count('plan_revisions'), await t.count('plan_installments'), await t.count('installment_matches'), await t.count('audit_events')];
    const before = await countAll();
    const preview = await plans.previewPlanRevision(t.db.pool, t.actor, s.plan.id, fields);
    assert.deepEqual(preview.rows.map((r) => [r.amountCents, r.kept]), [['5000', true], ['5000', true], ...Array.from({ length: 11 }, () => ['4500', false]), ['500', false]]);
    assert.deepEqual([preview.count, preview.keptCount, preview.newCount, preview.totalCents, preview.newCents], [14, 2, 12, '60000', '50000']);
    assert.deepEqual(preview.warnings, [], 'the plan still matches what the bill owes');
    assert.deepEqual(await countAll(), before, 'the preview wrote nothing, not even an audit event');
    assert.equal(await s.ledgerSnapshot(), snapshot);
    // The same refusals as the save, shown instead of a table.
    await assert.rejects(plans.previewPlanRevision(t.db.pool, t.actor, s.plan.id, { totalAmount: '50.00', installmentCount: '1', firstDueDate: '2026-09-01' }), code('conflict'));
    await assert.rejects(plans.previewPlanRevision(t.db.pool, t.actor, s.plan.id, { ...fields, installmentAmount: '' }), AppError);
    // Post it as the dialog does (a `dialog` marker the service never sees), with no installment count.
    const token = t.cookie.split('=')[1];
    const form = (b) => handlers.handleExpenseAction(post('/api/expenses/plans/revise', { ...b, csrf: csrfFor(token) }, { cookie: t.cookie, html: true }), t.ctx, 'plans/revise');
    const res = await form({ idempotencyKey: t.key(), planId: s.plan.id, version: d0.plan.version, reason: 'Provider restructured', dialog: 'restructure', ...fields });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), `https://tallymed.test/plans/${s.plan.id}`);
    const d1 = await s.detail();
    assert.deepEqual(d1.installments.map((i) => i.amountCents), preview.rows.map((r) => r.amountCents));
    assert.deepEqual(d1.installments.map((i) => i.dueDate), [d0.installments[0].dueDate, d0.installments[1].dueDate, ...preview.rows.slice(2).map((r) => r.dueDate)]);
    assert.deepEqual(d1.installments.slice(0, 2).map((i) => [i.matchedCents, i.state]), [['5000', 'paid'], ['5000', 'paid']]);
    assert.equal(d1.installments.at(-1).amountCents, '500');
    assert.equal(d1.plan.totalCents, '60000');
    assert.equal(d1.plan.installmentCount, 14);
    assert.deepEqual(d1.matches.filter((m) => m.revisionNo === 2).map((m) => [m.installmentSeq, m.amountCents, m.carried, m.reason]), [
      [1, '5000', true, 'Kept from revision 1'], [2, '5000', true, 'Kept from revision 1'],
    ]);
    assert.equal(await s.ledgerSnapshot(), snapshot, 'restructuring moved no cash');
    // A refused post comes back to the dialog: the marker is kept with the typed values (a stale version here).
    const stale = await form({ idempotencyKey: t.key(), planId: s.plan.id, version: d0.plan.version, reason: 'Again', dialog: 'restructure', ...fields });
    assert.match(new URL(stale.headers.get('location')).search, /error=stale_version/);
    const flash = JSON.parse(Buffer.from(stale.headers.get('set-cookie').split(';')[0].split('=')[1], 'base64url').toString('utf8'));
    assert.deepEqual([flash.v.dialog, flash.v.installmentAmount, flash.v.reason], ['restructure', '45.00', 'Again']);
  } finally {
    await t.db.drop();
  }
});

test('previewing a new plan shows the schedule and the warnings the plan would get, and creates nothing', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const s = await planSetup(t, { bill: '600.00' });
    const before = [await t.count('plan_revisions'), await t.count('audit_events')];
    const preview = await plans.previewNewPlan(t.db.pool, t.actor, { [`bill_${s.b.id}`]: 'on', totalAmount: '500.00', installmentCount: '3', firstDueDate: '2026-09-01', cadence: 'monthly', startedOn: '2026-01-01' });
    assert.deepEqual(preview.rows.map((r) => r.amountCents), ['16667', '16667', '16666']);
    assert.equal(preview.totalCents, '50000');
    assert.deepEqual(preview.warnings.map((w) => w.code), ['bill_balance_mismatch', 'unequal_installments']);
    // Per installment with a count and a total that disagree: the same mismatch warning the plan would carry.
    const mismatch = await plans.previewNewPlan(t.db.pool, t.actor, { [`bill_${s.b.id}`]: 'on', inputMode: 'per_installment', installmentAmount: '50.00', installmentCount: '12', totalAmount: '500.00', firstDueDate: '2026-09-01' });
    assert.deepEqual([mismatch.totalCents, mismatch.warnings.map((w) => w.code)], ['60000', ['total_mismatch']]);
    await assert.rejects(plans.previewNewPlan(t.db.pool, t.actor, { inputMode: 'per_installment', totalAmount: '500.00', firstDueDate: '2026-09-01' }), AppError);
    await assert.rejects(plans.previewNewPlan(t.db.pool, t.actor, { totalAmount: '500.00', installmentCount: '3', firstDueDate: '2026-09-01', startedOn: '2100-01-01' }), AppError);
    assert.deepEqual([await t.count('plan_revisions'), await t.count('audit_events')], before);
  } finally {
    await t.db.drop();
  }
});

// ---------- suggested matches ----------

/** Three $100.00 installments and three payments applied to the bill: $60.00, $70.00 and $40.00, oldest first. */
async function suggestionSetup(t) {
  const s = await planSetup(t, { bill: '300.00', installments: 3, total: '300.00', first: '2026-06-01' });
  for (const [paidOn, amount] of [['2026-05-20', '60.00'], ['2026-05-25', '70.00'], ['2026-06-02', '40.00']]) await t.pay1({ paidOn, amount, billId: s.b.id });
  const suggest = () => plans.suggestPlanMatches(t.db.pool, t.actor, s.plan.id);
  const apply = (rows, o = {}) => plans.applySuggestedMatches(t.db.pool, t.actor, {
    idempotencyKey: t.key(), planId: s.plan.id, version: 1,
    rows: rows.map((r) => ({ installmentId: r.installmentId, allocationId: r.allocationId, amount: (Number(r.amountCents) / 100).toFixed(2) })), ...o,
  }, 'r');
  const pairs = async () => (await t.db.pool.query(`select installment_id, allocation_id, amount_cents::text from installment_matches order by installment_id, allocation_id`)).rows
    .map((r) => `${r.installment_id}:${r.allocation_id}:${r.amount_cents}`);
  return { ...s, suggest, apply, pairs };
}

test('the reason for a suggestion is the fill order, or the same amount paid near the due date', () => {
  const base = { dueDate: '2026-06-10', paidOn: '2026-06-03', amountCents: 5000n, installmentUnpaidCents: 5000n };
  assert.equal(plans.suggestionWhy(base), 'Same amount, paid near the due date');
  assert.equal(plans.suggestionWhy({ ...base, paidOn: '2026-06-17' }), 'Same amount, paid near the due date', 'seven days either way');
  assert.equal(plans.suggestionWhy({ ...base, paidOn: '2026-06-18' }), 'Oldest unmatched payment, earliest unpaid installment');
  assert.equal(plans.suggestionWhy({ ...base, paidOn: '2026-06-02' }), 'Oldest unmatched payment, earliest unpaid installment');
  assert.equal(plans.suggestionWhy({ ...base, amountCents: 4000n }), 'Oldest unmatched payment, earliest unpaid installment');
});

test('suggested matches are the pure fill, apply exactly what was shown, and are references only', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const s = await suggestionSetup(t);
    const shown = await s.suggest();
    assert.deepEqual(shown.map((x) => [x.installmentSeq, x.dueDate, x.paidOn, x.paymentAmountCents, x.amountCents]), [
      [1, '2026-06-01', '2026-05-20', '6000', '6000'], [1, '2026-06-01', '2026-05-25', '7000', '4000'], [2, '2026-07-01', '2026-05-25', '7000', '3000'], [2, '2026-07-01', '2026-06-02', '4000', '4000'],
    ]);
    assert.deepEqual(shown.map((x) => x.why), Array(4).fill('Oldest unmatched payment, earliest unpaid installment'));
    // The same pure function over the same inputs gives the same pairs (no arithmetic of its own in the read).
    const d0 = await s.detail();
    const sources = shown.reduce((m, x) => m.set(x.allocationId, { allocationId: x.allocationId, paymentId: x.paymentId, billId: x.billId, free: 0n }), new Map());
    assert.equal(sources.size, 3);
    assert.equal(await t.count('installment_matches'), 0, 'the read wrote nothing');
    const before = await s.ledgerSnapshot();
    const key = t.key();
    const first = await s.apply(shown, { idempotencyKey: key });
    assert.deepEqual([first.id, first.replayed], [s.plan.id, false]);
    const replay = await s.apply(shown, { idempotencyKey: key });
    assert.deepEqual([replay.id, replay.replayed], [s.plan.id, true]);
    await assert.rejects(s.apply(shown.slice(1), { idempotencyKey: key }), code('conflict'), 'the same key with other rows');
    assert.equal(await t.count('installment_matches'), 4);
    assert.equal(await s.ledgerSnapshot(), before, 'references only');
    const d1 = await s.detail();
    assert.deepEqual(d1.installments.map((i) => [i.matchedCents, i.state]), [['10000', 'paid'], ['7000', 'partial'], ['0', 'unpaid']]);
    const written = (await s.pairs()).sort();
    assert.deepEqual(written, shown.map((x) => `${x.installmentId}:${x.allocationId}:${x.amountCents}`).sort());
    assert.deepEqual(await s.suggest(), [], 'nothing left to suggest');
    const audits = await t.audit('plan.suggestions_applied');
    assert.equal(audits.length, 1, 'one event, none for the replay');
    const a = audits[0].detail;
    assert.deepEqual([a.matchCount, a.skippedCount, a.allocationCount, a.installmentCount, a.matchedCents], [4, 0, 3, 2, '17000']);
    assert.deepEqual(a.installmentIds.split(',').sort(), [d1.installments[0].id, d1.installments[1].id].sort());
    assert.equal(a.allocationIds.split(',').length, 3);
    assert.ok(Object.values(a).every((v) => typeof v === 'number' || /^[0-9a-f,-]*$/.test(v)), 'counts, cents and ids only, no free text');
    assert.equal(d0.plan.version, d1.plan.version, 'match writes do not bump the plan version');
    assert.deepEqual(d1.matches.map((m) => m.reason), Array(4).fill('Matched a suggested payment'));
  } finally {
    await t.db.drop();
  }
});

test('applying a subset matches only those rows, and the rest is suggested again', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const s = await suggestionSetup(t);
    const shown = await s.suggest();
    await s.apply([shown[0], shown[2], shown[3]]);
    assert.equal(await t.count('installment_matches'), 3);
    const d = await s.detail();
    assert.deepEqual(d.installments.map((i) => i.matchedCents), ['6000', '7000', '0']);
    const again = await s.suggest();
    assert.deepEqual(again.map((x) => [x.installmentId, x.allocationId, x.amountCents]), [[shown[1].installmentId, shown[1].allocationId, shown[1].amountCents]]);
    const a = (await t.audit('plan.suggestions_applied'))[0].detail;
    assert.deepEqual([a.suggestedCount, a.matchCount, a.skippedCount], [4, 3, 1]);
  } finally {
    await t.db.drop();
  }
});

test('suggestions that changed since they were shown are refused whole, and nothing is written', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const s = await suggestionSetup(t);
    const shown = await s.suggest();
    // A manual match takes the cash and the installment room between render and submit.
    await s.match(shown[0].installmentId, shown[0].allocationId, '30.00');
    const before = [await t.count('installment_matches'), await t.count('audit_events')];
    await assert.rejects(s.apply(shown), (e) => e.code === 'conflict' && /changed/.test(e.message));
    assert.deepEqual([await t.count('installment_matches'), await t.count('audit_events')], before);
    // The fresh suggestions apply. Altered amounts, unknown pairs, a stale version, a bad body and a cancelled plan are refused.
    const fresh = await s.suggest();
    await assert.rejects(s.apply([{ ...fresh[0], amountCents: String(BigInt(fresh[0].amountCents) - 1n) }]), code('conflict'));
    await assert.rejects(s.apply([{ ...fresh[0], allocationId: randomUUID() }]), code('conflict'));
    await assert.rejects(s.apply(fresh, { version: 9 }), code('stale_version'));
    await assert.rejects(s.apply([]), code('invalid_input'));
    await assert.rejects(s.apply([fresh[0], fresh[0]]), code('invalid_input'));
    await assert.rejects(s.apply(fresh, { extra: 'x' }), code('invalid_input'));
    assert.equal(await t.count('installment_matches'), before[0]);
    await s.apply(fresh);
    assert.equal(await t.count('installment_matches'), before[0] + fresh.length);
    await plans.cancelPlan(t.db.pool, t.actor, { planId: s.plan.id, version: 1, reason: 'Paid elsewhere' }, 'r');
    await assert.rejects(s.apply(fresh, { version: 2 }), code('conflict'));
    assert.deepEqual(await plans.suggestPlanMatches(t.db.pool, t.actor, s.plan.id), [], 'a cancelled plan suggests nothing');
    const h2 = (await t.db.pool.query(`insert into households (name) values ('Other Family') returning id`)).rows[0].id;
    const u2 = (await t.db.pool.query(`insert into users (household_id, email, display_name, role, password_hash) values ($1, 'other@example.test', 'Other Admin', 'admin', 'x') returning id`, [h2])).rows[0].id;
    const outsider = { userId: u2, householdId: h2, role: 'admin', displayName: 'Other Admin', sessionId: randomUUID() };
    await assert.rejects(plans.suggestPlanMatches(t.db.pool, outsider, s.plan.id), code('not_found'));
    await assert.rejects(plans.applySuggestedMatches(t.db.pool, outsider, { idempotencyKey: t.key(), planId: s.plan.id, version: 2, rows: [{ installmentId: fresh[0].installmentId, allocationId: fresh[0].allocationId, amount: '1.00' }] }, 'r'), code('not_found'));
  } finally {
    await t.db.drop();
  }
});

test('concurrent applies of the same suggestions match once, never count cash twice and take no lock-cycle retries', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const s = await suggestionSetup(t);
    const shown = await s.suggest();
    retryStats.lockConflicts = 0;
    const race = await Promise.allSettled(Array.from({ length: 6 }, () => s.apply(shown)));
    assert.equal(race.filter((x) => x.status === 'fulfilled').length, 1);
    for (const x of race.filter((y) => y.status === 'rejected')) assert.equal(x.reason.code, 'conflict');
    assert.equal(retryStats.lockConflicts, 0, 'no lock-cycle retries');
    assert.equal(await t.count('installment_matches'), 4);
    // The same key replayed concurrently is one write.
    const s2 = await suggestionSetup(t);
    const shown2 = await s2.suggest();
    const key = t.key();
    const replays = await Promise.allSettled(Array.from({ length: 4 }, () => s2.apply(shown2, { idempotencyKey: key })));
    assert.ok(replays.every((x) => x.status === 'fulfilled' && x.value.id === s2.plan.id));
    assert.equal(replays.filter((x) => !x.value.replayed).length, 1);
    // A manual match racing an apply: whichever lands second is refused, and the cash is never over-matched.
    const s3 = await suggestionSetup(t);
    const shown3 = await s3.suggest();
    const mixed = await Promise.allSettled([s3.apply(shown3), s3.match(shown3[0].installmentId, shown3[0].allocationId, '10.00')]);
    for (const x of mixed) if (x.status === 'rejected') assert.equal(x.reason.code, 'conflict');
    assert.equal(retryStats.lockConflicts, 0);
    const over = await t.db.pool.query(`select n.allocation_id from allocation_net n where n.net_cents < (select coalesce(sum(m.amount_cents), 0) from installment_matches m where m.allocation_id = n.allocation_id)`);
    assert.equal(over.rowCount, 0);
  } finally {
    await t.db.drop();
  }
});

test('the apply route reads the ticked rows of the card (sug.N.*), skips unticked ones and returns to the plan', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const s = await suggestionSetup(t);
    const shown = await s.suggest();
    const token = t.cookie.split('=')[1];
    const body = { idempotencyKey: t.key(), planId: s.plan.id, version: 1, csrf: csrfFor(token) };
    shown.forEach((x, n) => {
      body[`sug.${n}.installmentId`] = x.installmentId; body[`sug.${n}.allocationId`] = x.allocationId; body[`sug.${n}.amount`] = (Number(x.amountCents) / 100).toFixed(2);
      if (n !== 1) body[`sug.${n}.apply`] = '1'; // the unticked box is not sent
    });
    const res = await handlers.handleExpenseAction(post('/api/expenses/plans/apply-suggestions', body, { cookie: t.cookie, html: true }), t.ctx, 'plans/apply-suggestions');
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), `https://tallymed.test/plans/${s.plan.id}`);
    assert.equal(await t.count('installment_matches'), 3);
    // Nothing ticked is refused with the form's error code, and nothing changes.
    const none = { ...body, idempotencyKey: t.key() };
    for (const k of Object.keys(none)) if (k.endsWith('.apply')) delete none[k];
    const refused = await handlers.handleExpenseAction(post('/api/expenses/plans/apply-suggestions', none, { cookie: t.cookie, html: true }), t.ctx, 'plans/apply-suggestions');
    assert.match(new URL(refused.headers.get('location')).search, /error=invalid_input/);
    assert.equal(await t.count('installment_matches'), 3);
    // The old rows (already applied) are now stale: a conflict.
    const stale = await handlers.handleExpenseAction(post('/api/expenses/plans/apply-suggestions', { ...body, idempotencyKey: t.key() }, { cookie: t.cookie, html: true }), t.ctx, 'plans/apply-suggestions');
    assert.match(new URL(stale.headers.get('location')).search, /error=conflict/);
    assert.equal(await t.count('installment_matches'), 3);
  } finally {
    await t.db.drop();
  }
});

// ---------- the POST preview ----------

test('the preview route writes nothing and redirects with only a marker; the typed values wait in the flash cookie', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const s = await suggestionSetup(t);
    const token = t.cookie.split('=')[1];
    const tables = ['payments', 'payment_entries', 'payment_plans', 'plan_revisions', 'plan_installments', 'installment_matches', 'audit_events', 'idempotency_records', 'bills'];
    const counts = async () => JSON.stringify([await Promise.all(tables.map((x) => t.count(x))), await s.ledgerSnapshot()]);
    const before = await counts();
    const run = (b, o = {}) => handlers.handleExpenseAction(post('/api/expenses/plans/preview', { csrf: csrfFor(token), ...b }, { cookie: t.cookie, html: true, ...o }), t.ctx, 'plans/preview');
    const fields = { totalAmount: '90.00', installmentCount: '3', firstDueDate: '2026-09-01', cadence: 'monthly', inputMode: 'total', remainder: 'earliest', reviseMode: 'replace' };
    const res = await run({ preview: 'revise', planId: s.plan.id, idempotencyKey: t.key(), version: 1, reason: 'Provider asked for smaller payments', ...fields });
    assert.equal(res.status, 303);
    const loc = new URL(res.headers.get('location'));
    assert.equal(loc.pathname, `/plans/${s.plan.id}`);
    assert.equal(loc.search, '?preview=revise', 'only the marker is in the address');
    assert.ok(!res.headers.get('location').includes('Provider') && !res.headers.get('location').includes(token));
    const cookie = res.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    const flash = JSON.parse(Buffer.from(cookie.split(';')[0].split('=')[1], 'base64url').toString('utf8'));
    assert.equal(flash.p, `/plans/${s.plan.id}`, 'bound to the page');
    assert.equal(flash.v.reason, 'Provider asked for smaller payments');
    assert.equal(flash.v.totalAmount, '90.00');
    for (const k of ['csrf', 'idempotencyKey', 'version', 'planId', 'preview']) assert.ok(!(k in flash.v), `${k} stays out of the cookie`);
    assert.equal(await counts(), before, 'a preview writes nothing, not even an audit event');
    // The page reads those values and runs the same read-only preview as before.
    const preview = await plans.previewPlanRevision(t.db.pool, t.actor, s.plan.id, flash.v);
    assert.deepEqual(preview.rows.map((r) => r.amountCents), ['3000', '3000', '3000']);
    // A new plan: the ticked bills travel as bill.<n>; the address is `/plans?preview=create`.
    const created = await run({ preview: 'create', name: 'Another plan', [`bill_${s.b.id}`]: 'on', startedOn: '2026-01-01', ...fields });
    assert.equal(new URL(created.headers.get('location')).pathname + new URL(created.headers.get('location')).search, '/plans?preview=create');
    const cflash = JSON.parse(Buffer.from(created.headers.get('set-cookie').split(';')[0].split('=')[1], 'base64url').toString('utf8'));
    assert.deepEqual([cflash.p, cflash.v['bill.0'], cflash.v.name], ['/plans', s.b.id, 'Another plan']);
    // The CSRF token is required, a bad marker or page is refused, and none of it writes.
    const noToken = await handlers.handleExpenseAction(post('/api/expenses/plans/preview', { preview: 'revise', planId: s.plan.id, ...fields }, { cookie: t.cookie, html: true }), t.ctx, 'plans/preview');
    assert.match(new URL(noToken.headers.get('location')).search, /error=csrf_failed/);
    assert.equal((await run({ preview: 'other', planId: s.plan.id, ...fields })).status, 400);
    assert.equal((await run({ preview: 'revise', planId: '../x', ...fields })).status, 400);
    assert.equal(await counts(), before);
  } finally {
    await t.db.drop();
  }
});

// ---------- suggested matches: refusals that need a plan in another state ----------

test('applying suggestions is refused on a cancelled plan, a removed plan and a stale version, and a replayed key with other rows is a conflict', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    // A cancelled plan.
    const a = await suggestionSetup(t);
    const shownA = await a.suggest();
    await plans.cancelPlan(t.db.pool, t.actor, { planId: a.plan.id, version: 1, reason: 'Paid elsewhere' }, 'r');
    await assert.rejects(a.apply(shownA, { version: 2 }), code('conflict'));
    await assert.rejects(a.apply(shownA, { version: 1 }), code('stale_version'), 'the old version is stale, not applied');
    // A removed plan (administrator): nothing is applied whichever version the form carries.
    const b = await suggestionSetup(t);
    const shownB = await b.suggest();
    await plans.removePlan(t.db.pool, t.actor, { idempotencyKey: t.key(), planId: b.plan.id, version: 1, reason: 'Entered twice' }, 'r');
    for (const version of [1, 2, 3]) await assert.rejects(b.apply(shownB, { version }), (e) => e instanceof AppError && ['conflict', 'not_found'].includes(e.code));
    // A stale version on an active plan: the plan moved on (a revision) after the card was drawn.
    const c = await suggestionSetup(t);
    const shownC = await c.suggest();
    await plans.revisePlan(t.db.pool, t.actor, { idempotencyKey: t.key(), planId: c.plan.id, version: 1, reason: 'Smaller payments', totalAmount: '300.00', installmentCount: '6', firstDueDate: '2026-06-01', cadence: 'monthly' }, 'r');
    await assert.rejects(c.apply(shownC), code('stale_version'));
    // The same key replayed with other rows is a conflict, with the same rows a replay.
    const d = await suggestionSetup(t);
    const shownD = await d.suggest();
    const key = t.key();
    const first = await d.apply(shownD.slice(0, 2), { idempotencyKey: key });
    assert.equal(first.replayed, false);
    assert.equal((await d.apply(shownD.slice(0, 2), { idempotencyKey: key })).replayed, true);
    const matches = await t.count('installment_matches');
    await assert.rejects(d.apply(shownD, { idempotencyKey: key }), code('conflict'));
    await assert.rejects(d.apply(shownD.slice(0, 1), { idempotencyKey: key }), code('conflict'));
    assert.equal(await t.count('installment_matches'), matches, 'the conflicting replay matched nothing');
    assert.equal(await t.count('installment_matches where plan_id = \'' + a.plan.id + '\''), 0, 'the cancelled plan matched nothing');
  } finally {
    await t.db.drop();
  }
});

// ---------- "List each installment" ----------

const LIST_ROWS = [['2026-09-01', '75.25'], ['2026-10-01', '40.00'], ['2026-11-01', '40.00'], ['2026-12-01', '40.00'], ['2027-01-01', '4.75']];
const LIST_AMOUNTS = ['7525', '4000', '4000', '4000', '475'];
/** The generated-mode fields a browser still posts next to a list, which a list ignores. */
const IGNORED = { totalAmount: '999.00', installmentCount: '7', installmentAmount: '1.00', firstDueDate: '2030-01-01', cadence: 'weekly', remainder: 'last_short' };

async function listSetup(t) {
  const s = await planSetup(t, { bill: '200.00', installments: 2, total: '200.00' });
  const token = t.cookie.split('=')[1];
  const form = (action, body) => handlers.handleExpenseAction(post(`/api/expenses/${action}`, { csrf: csrfFor(token), ...body }, { cookie: t.cookie, html: true }), t.ctx, action);
  const table = Object.fromEntries(LIST_ROWS.flatMap(([d, a], i) => [[`inst.${i}.dueDate`, d], [`inst.${i}.amount`, a]]));
  // The 12 rows of the form: the rows after the typed ones are blank.
  const padded = { ...table, ...Object.fromEntries(Array.from({ length: 12 - LIST_ROWS.length }, (_, k) => [`inst.${k + LIST_ROWS.length}.dueDate`, '']).concat(Array.from({ length: 12 - LIST_ROWS.length }, (_, k) => [`inst.${k + LIST_ROWS.length}.amount`, '']))) };
  const text = ['9/1/2026\t$75.25', '', '2026-10-01, 40', '2026-11-01 40.00', '12/1/2026 40.00', '2027-01-01 $4.75'].join('\r\n');
  const planCount = () => t.count('payment_plans');
  const shape = (d) => d.installments.map((i) => [i.dueDate, i.amountCents]);
  return { ...s, form, table, padded, text, planCount, shape };
}

test('a plan created from the table rows or from pasted text is the same schedule, in cents, and the generated fields are ignored', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const s = await listSetup(t);
    const base = { name: 'Listed plan', [`bill_${s.b.id}`]: 'on', startedOn: '2026-01-01', inputMode: 'list', ...IGNORED };
    const before = await s.planCount();
    const fromRows = await s.form('plans/create', { ...base, idempotencyKey: t.key(), ...s.padded, installmentsText: '' });
    assert.equal(fromRows.status, 303);
    const idA = new URL(fromRows.headers.get('location')).pathname.split('/')[2];
    const fromText = await s.form('plans/create', { ...base, idempotencyKey: t.key(), name: 'Pasted plan', installmentsText: s.text, ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`inst.${i}.dueDate`, '']).concat(Array.from({ length: 12 }, (_, i) => [`inst.${i}.amount`, '']))) });
    assert.equal(fromText.status, 303);
    const idB = new URL(fromText.headers.get('location')).pathname.split('/')[2];
    assert.equal(await s.planCount(), before + 2);
    const a = await s.detail(idA);
    const b = await s.detail(idB);
    assert.deepEqual(s.shape(a), LIST_ROWS.map(([d], i) => [d, LIST_AMOUNTS[i]]));
    assert.deepEqual(s.shape(b), s.shape(a));
    for (const d of [a, b]) {
      assert.equal(d.plan.totalCents, '20000');
      assert.equal(d.plan.cadence, 'custom');
      assert.equal(d.plan.installmentCount, 5);
    }
    assert.equal(await t.count('payments'), 0, 'a plan moves no cash');
    // A listed plan in the audit trail records the cents it was saved with, and nothing the person typed as free text.
    const created = (await t.audit('plan.created')).find((x) => x.entity_id === idA);
    assert.equal(created.detail.computedTotalCents, '20000');
    // The idempotency key makes a replayed post one plan.
    const key = t.key();
    const post1 = await s.form('plans/create', { ...base, idempotencyKey: key, name: 'Replay plan', ...s.padded });
    const post2 = await s.form('plans/create', { ...base, idempotencyKey: key, name: 'Replay plan', ...s.padded });
    assert.equal(post1.headers.get('location'), post2.headers.get('location'));
    assert.equal(await s.planCount(), before + 3);
    // With another input mode the table and the text are ignored, even when they are garbage.
    const generated = await s.form('plans/create', { name: 'Generated plan', [`bill_${s.b.id}`]: 'on', startedOn: '2026-01-01', idempotencyKey: t.key(), inputMode: 'total', totalAmount: '90.00', installmentCount: '3', firstDueDate: '2026-09-01', cadence: 'monthly', 'inst.0.dueDate': 'garbage', 'inst.0.amount': '??', installmentsText: 'not a schedule' });
    assert.equal(generated.status, 303);
    const g = await s.detail(new URL(generated.headers.get('location')).pathname.split('/')[2]);
    assert.deepEqual(s.shape(g), [['2026-09-01', '3000'], ['2026-10-01', '3000'], ['2026-11-01', '3000']]);
  } finally {
    await t.db.drop();
  }
});

test('a list given as both table rows and pasted text, or with a bad line, is refused, writes nothing and keeps what was typed', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const s = await listSetup(t);
    const base = { name: 'Listed plan', [`bill_${s.b.id}`]: 'on', inputMode: 'list', idempotencyKey: t.key(), ...IGNORED };
    const before = JSON.stringify([await s.planCount(), await t.count('idempotency_records'), await t.count('audit_events')]);
    const both = await s.form('plans/create', { ...base, ...s.table, installmentsText: s.text });
    assert.match(new URL(both.headers.get('location')).search, /error=invalid_input/);
    // The typed rows and the text wait in the flash cookie, the rows as one text.
    const flash = readFlash(both.headers.get('set-cookie').split(';')[0].split('=')[1], '/plans');
    assert.equal(flash.installmentsText, s.text.replaceAll('\r\n', '\n'));
    assert.equal(flash.instRows.split('\n').length, 5);
    assert.equal(flash.inputMode, 'list');
    assert.equal(flash['bill.0'], s.b.id, 'the ticked bill is kept too, so fixing the list does not mean ticking it again');
    const values = withInstRowValues(flash);
    assert.equal(values['inst.4.amount'], '4.75');
    const bad = await s.form('plans/create', { ...base, idempotencyKey: t.key(), installmentsText: '2026-09-01 75.25\n2026-10-01 forty\n\n2026-11-01 40.001' });
    assert.match(new URL(bad.headers.get('location')).search, /error=invalid_input/);
    const none = await s.form('plans/create', { ...base, idempotencyKey: t.key() });
    assert.match(new URL(none.headers.get('location')).search, /error=invalid_input/);
    assert.equal(JSON.stringify([await s.planCount(), await t.count('idempotency_records'), await t.count('audit_events')]), before);
    // As JSON the message carries the line numbers.
    await assert.rejects(async () => plans.createPlan(t.db.pool, t.actor, withInstallmentList({ ...base, installmentsText: '2026-09-01 75.25\n\n2026-10-01 forty' }), 'r'), (e) => e.code === 'invalid_input' && e.message === 'Line 3: amount is not a number');
  } finally {
    await t.db.drop();
  }
});

test('revising with a list replaces the schedule, or with keep_paid describes only the unpaid rest', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const s = await planSetup(t); // $300.00 as 3 x $100.00 due 06-01, 07-01, 08-01
    const token = t.cookie.split('=')[1];
    const form = (body) => handlers.handleExpenseAction(post('/api/expenses/plans/revise', { csrf: csrfFor(token), ...body }, { cookie: t.cookie, html: true }), t.ctx, 'plans/revise');
    const pm = await t.pay1({ amount: '100.00', billId: s.b.id });
    const alloc = (await t.payment(pm.id)).allocations[0].allocationId;
    const d0 = await s.detail();
    await s.match(d0.installments[0].id, alloc, '100.00'); // #1 paid in full
    const common = () => ({ idempotencyKey: t.key(), planId: s.plan.id, reason: 'Provider restructured', inputMode: 'list', ...IGNORED });
    // Replace: the whole schedule is the list ($200.00, uneven), and the $100.00 match carries onto the earliest installments.
    const replaced = await form({ ...common(), version: String(d0.plan.version), reviseMode: 'replace', installmentsText: LIST_ROWS.map(([d, a]) => `${d} ${a}`).join('\n') });
    assert.equal(replaced.status, 303);
    assert.equal(new URL(replaced.headers.get('location')).pathname, `/plans/${s.plan.id}`);
    assert.equal(new URL(replaced.headers.get('location')).search, '');
    const d1 = await s.detail();
    assert.deepEqual(d1.installments.map((i) => [i.dueDate, i.amountCents, i.matchedCents]), [['2026-09-01', '7525', '7525'], ['2026-10-01', '4000', '2475'], ['2026-11-01', '4000', '0'], ['2026-12-01', '4000', '0'], ['2027-01-01', '475', '0']]);
    assert.equal(d1.plan.totalCents, '20000');
    // keep_paid: the first installment is not fully paid any more (it is $75.25 with $75.25 matched = paid; the second is partly paid), so the rest is listed again.
    const kept = await form({ ...common(), version: String(d1.plan.version), reviseMode: 'keep_paid', ...Object.fromEntries([['2026-12-01', '60.00'], ['2027-02-01', '$14.75']].flatMap(([d, a], i) => [[`inst.${i}.dueDate`, d], [`inst.${i}.amount`, a]])) });
    assert.equal(kept.status, 303, kept.headers.get('location'));
    const d2 = await s.detail();
    assert.deepEqual(d2.installments.map((i) => [i.dueDate, i.amountCents, i.matchedCents]), [['2026-09-01', '7525', '7525'], ['2026-12-01', '6000', '2475'], ['2027-02-01', '1475', '0']]);
    assert.equal(d2.plan.totalCents, '15000', 'the kept installment plus the listed rest');
    const a = (await t.audit('plan.revised')).at(-1).detail;
    assert.deepEqual([a.reviseMode, a.keptInstallmentCount, a.keptCents, a.rescheduledCount, a.rescheduledCents], ['keep_paid', 1, '7525', 2, '7475']);
    // A bad list in a revision is refused and leaves the plan as it was.
    const revisions = await t.count('plan_revisions');
    const refused = await form({ ...common(), version: String(d2.plan.version), reviseMode: 'replace', installmentsText: '2027-03-01 oops' });
    assert.match(new URL(refused.headers.get('location')).search, /error=invalid_input/);
    assert.equal(await t.count('plan_revisions'), revisions);
  } finally {
    await t.db.drop();
  }
});

test('a preview of a list writes nothing, shows the listed rows exactly, and equals what is saved', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const s = await listSetup(t);
    const tables = ['payments', 'payment_entries', 'payment_plans', 'plan_revisions', 'plan_installments', 'installment_matches', 'audit_events', 'idempotency_records', 'bills'];
    const counts = async () => JSON.stringify(await Promise.all(tables.map((x) => t.count(x))));
    const before = await counts();
    const body = { name: 'Previewed list', [`bill_${s.b.id}`]: 'on', startedOn: '2026-01-01', inputMode: 'list', ...IGNORED, ...s.padded, installmentsText: '' };
    const res = await s.form('plans/preview', { preview: 'create', ...body });
    assert.equal(res.status, 303);
    assert.equal(new URL(res.headers.get('location')).search, '?preview=create');
    assert.equal(await counts(), before);
    // What the page does: read the flash, put the table back, convert and preview.
    const values = withBillTicks(withInstRowValues(readFlash(res.headers.get('set-cookie').split(';')[0].split('=')[1], '/plans')));
    assert.equal(values.inputMode, 'list');
    const preview = await plans.previewNewPlan(t.db.pool, t.actor, withInstallmentList(values));
    assert.deepEqual(preview.rows.map((r) => [r.dueDate, r.amountCents, r.kept]), LIST_ROWS.map(([d], i) => [d, LIST_AMOUNTS[i], false]));
    assert.deepEqual([preview.count, preview.totalCents], [5, '20000']);
    assert.deepEqual(preview.warnings, [], 'the bill owes $200.00 and the list adds up to it');
    assert.equal(await counts(), before, 'building the preview wrote nothing');
    // Saving the same form values gives exactly the previewed schedule.
    const saved = await s.form('plans/create', { idempotencyKey: t.key(), ...body });
    const d = await s.detail(new URL(saved.headers.get('location')).pathname.split('/')[2]);
    assert.deepEqual(s.shape(d), preview.rows.map((r) => [r.dueDate, r.amountCents]));
    assert.equal(d.plan.totalCents, preview.totalCents);
    // A list that does not match the bill shows the balance warning; a bad list is an error with every line (the page lists them).
    const off = await plans.previewNewPlan(t.db.pool, t.actor, withInstallmentList({ ...values, 'inst.4.amount': '9.75' }));
    assert.deepEqual(off.warnings.map((w) => [w.code, w.differenceCents]), [['bill_balance_mismatch', '500']]);
    assert.throws(() => withInstallmentList({ ...values, 'inst.1.amount': 'x', 'inst.3.dueDate': '2026-02-30' }), (e) => e.lines.length === 2 && e.lines[0] === 'Row 2: amount is not a number');
    // The revise preview of a list: replace, and keep_paid with nothing paid.
    const rev = await plans.previewPlanRevision(t.db.pool, t.actor, s.plan.id, withInstallmentList({ inputMode: 'list', reviseMode: 'replace', installmentsText: '2026-09-01 150.00\n2026-10-01 50.00' }));
    assert.deepEqual(rev.rows.map((r) => [r.dueDate, r.amountCents]), [['2026-09-01', '15000'], ['2026-10-01', '5000']]);
    assert.equal(await counts(), JSON.stringify(await Promise.all(tables.map((x) => t.count(x)))));
  } finally {
    await t.db.drop();
  }
});
