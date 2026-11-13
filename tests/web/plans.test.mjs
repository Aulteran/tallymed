// Payment plans: schedules, revisions, installment matching and their interaction with payments (M03). Synthetic data only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import * as handlers from '../../apps/web/server/http.ts';
import { csrfFor } from '../../apps/web/server/tokens.ts';
import * as pay from '../../apps/web/server/services/payments.ts';
import * as plans from '../../apps/web/server/services/plans.ts';
import { AppError } from '../../apps/web/server/errors.ts';
import { post, skipDb } from './helpers.mjs';
import { setup } from './money-helpers.mjs';

const code = (c) => ({ code: c });
const AS_OF = '2026-07-15';

async function planSetup(t, { bill = '300.00', installments = 3, total = '300.00', first = '2026-06-01', cadence = 'monthly' } = {}) {
  const m = await t.member();
  const p = await t.provider();
  const b = await t.bill({ memberId: m, providerId: p, originalAmount: bill });
  const create = (o = {}) => plans.createPlan(t.db.pool, t.actor, {
    idempotencyKey: t.key(), name: 'Clinic plan', providerId: p, billId: b.id, totalAmount: total, installmentCount: String(installments), firstDueDate: first, cadence, ...o,
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
    const base = { name: 'Plan', providerId: p, billId: b.id, totalAmount: '100.00', installmentCount: '4', firstDueDate: '2026-06-01', cadence: 'monthly' };
    const create = (o = {}) => plans.createPlan(t.db.pool, t.actor, { idempotencyKey: t.key(), ...base, ...o }, 'r');
    // Rules: provider match, confirmed bills, known records, at least one bill, positive installments.
    await assert.rejects(create({ billId: other.id }), code('invalid_input'));
    await assert.rejects(create({ billId: est.id }), code('conflict'));
    await assert.rejects(create({ billId: randomUUID() }), code('not_found'));
    await assert.rejects(create({ billId: undefined }), code('invalid_input'));
    await assert.rejects(create({ totalAmount: '0.03' }), code('invalid_input'));
    await assert.rejects(create({ providerId: randomUUID() }), code('not_found'));
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
    await assert.rejects(plans.createPlan(t.db.pool, outsider, { idempotencyKey: t.key(), name: 'x', providerId: s.p, billId: s.b.id, totalAmount: '10', installmentCount: '1', firstDueDate: '2026-09-01' }, 'r'), code('not_found'));
    // A plan cannot reference another household's bill (database level).
    const spare = await t.bill({ memberId: s.m, providerId: s.p, originalAmount: '10.00' });
    await assert.rejects(t.db.pool.query(`insert into payment_plan_bills (household_id, plan_id, bill_id) values ($1, $2, $3)`, [h2, s.plan.id, spare.id]), /foreign key/);
    // Forms.
    const token = t.cookie.split('=')[1];
    const form = (action, b) => handlers.handleExpenseAction(post(`/api/expenses/${action}`, { ...b, csrf: csrfFor(token) }, { cookie: t.cookie, html: true }), t.ctx, action);
    const ok = await form('plans/create', { idempotencyKey: t.key(), name: 'Second plan', providerId: s.p, billId: s.b.id, totalAmount: '90.00', installmentCount: '3', firstDueDate: '2026-09-01', cadence: 'monthly' });
    assert.equal(ok.status, 303);
    assert.match(ok.headers.get('location'), /\/plans\/[0-9a-f-]{36}$/);
    const bad = await form('plans/create', { idempotencyKey: t.key(), name: 'Bad plan', providerId: s.p, billId: s.b.id, totalAmount: '90.005', installmentCount: '3', firstDueDate: '2026-09-01' });
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
