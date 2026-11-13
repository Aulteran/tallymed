// Regression tests for the M03 review findings: refund reversal, commit-time guards, lock order and contract paging.
// Synthetic data only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { listNetAllocations } from '../../apps/web/server/contracts.ts';
import * as pay from '../../apps/web/server/services/payments.ts';
import * as plans from '../../apps/web/server/services/plans.ts';
import { retryStats } from '../../apps/web/server/services/support.ts';
import * as payRepo from '../../apps/web/server/repositories/payments.ts';
import { skipDb } from './helpers.mjs';
import { setup } from './money-helpers.mjs';

const code = (c) => ({ code: c });
const reverse = (t, eventId, o = {}) => pay.reverseRefund(t.db.pool, t.actor, { idempotencyKey: t.key(), eventId, effectiveDate: '2026-05-02', reason: 'Entered in error', ...o }, 'r');

test('reversing a refund returns unapplied cash and never overpays a bill that was paid again meanwhile', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const m = await t.member();
    const p = await t.provider();
    const a = await t.bill({ memberId: m, providerId: p, originalAmount: '100.00' });
    const pm = await t.pay1({ amount: '100.00', billId: a.id });
    const alloc = (await t.payment(pm.id)).allocations[0].allocationId;
    const r1 = await t.refund(pm.id, { allocationId: alloc, amount: '40.00' });
    // Another payment settles the bill in the meantime. Reversing the refund would apply $140 to a $100 bill.
    await t.pay1({ amount: '40.00', billId: a.id });
    assert.equal((await t.detail(a.id)).openBalanceCents, '0');
    await assert.rejects(reverse(t, r1.id), code('conflict'));
    assert.equal((await t.payment(pm.id)).payment.refundedCents, '4000', 'the refused reversal changed nothing');
    // A refund of unapplied cash reverses even when the bills are fully paid; the cash returns to unapplied.
    const pm2 = await t.pay1({ amount: '25.00' });
    const r2 = await t.refund(pm2.id, { amount: '10.00' });
    assert.equal((await t.payment(pm2.id)).payment.unappliedCents, '1500');
    await reverse(t, r2.id);
    assert.equal((await t.payment(pm2.id)).payment.unappliedCents, '2500');
    const [row] = (await t.audit('payment.refund_reversed')).slice(-1);
    assert.equal(row.detail.netCashBeforeCents, '1500');
    assert.equal(row.detail.netCashAfterCents, '2500', 'reversing a refund raises net cash');
    assert.equal(row.detail.unappliedBeforeCents, '1500');
    assert.equal(row.detail.unappliedAfterCents, '2500');
  } finally {
    await t.db.drop();
  }
});

test('the database refuses allocations beyond a bill\'s open balance, even from concurrent raw writers', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const m = await t.member();
    const p = await t.provider();
    const bill = await t.bill({ memberId: m, providerId: p, originalAmount: '50.00' });
    const hh = t.actor.householdId;
    const u = t.actor.userId;
    const payments = [];
    for (let i = 0; i < 8; i++) payments.push(await t.pay1({ amount: '20.00' }));
    const raw = (paymentId) => {
      const id = randomUUID();
      return t.db.pool.query(
        `insert into payment_entries (id, household_id, payment_id, event_id, kind, bill_id, allocation_id, amount_cents, effective_date, created_by)
         values ($1, $2, $3, gen_random_uuid(), 'allocation', $4, $1, 2000, '2026-05-01', $5)`, [id, hh, paymentId, bill.id, u]);
    };
    const results = await Promise.allSettled(payments.map((x) => raw(x.id)));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2, '$50 open balance takes two $20 allocations');
    for (const r of results.filter((x) => x.status === 'rejected')) assert.match(r.reason.message, /open balance/);
    assert.equal((await t.detail(bill.id)).openBalanceCents, '1000');
  } finally {
    await t.db.drop();
  }
});

test('the database caps an installment under concurrent raw matches and refuses stale or foreign targets', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const m = await t.member();
    const p = await t.provider();
    const other = await t.provider('Other Clinic');
    const b = await t.bill({ memberId: m, providerId: p, originalAmount: '400.00' });
    const plan = await plans.createPlan(t.db.pool, t.actor, {
      idempotencyKey: t.key(), name: 'Plan', providerId: p, billId: b.id, totalAmount: '400.00', installmentCount: '4', firstDueDate: '2026-06-01', cadence: 'monthly',
    }, 'r');
    const hh = t.actor.householdId;
    const u = t.actor.userId;
    const pms = [];
    for (let i = 0; i < 8; i++) pms.push(await t.pay1({ amount: '30.00', billId: b.id }));
    const allocs = await Promise.all(pms.map(async (x) => (await t.payment(x.id)).allocations[0].allocationId));
    const d = await plans.getPlanDetail(t.db.pool, t.actor, plan.id, { asOf: '2026-07-15' });
    const inst = d.installments[0];
    const rawMatch = (i, k, amount, kind = 'match') => t.db.pool.query(
      `insert into installment_matches (id, household_id, plan_id, revision_id, installment_id, payment_id, allocation_id, bill_id, kind, amount_cents, created_by)
       select gen_random_uuid(), $1, i.plan_id, i.revision_id, i.id, $2, $3, $4, $7, $5, $6 from plan_installments i where i.id = $8`,
      [hh, pms[k].id, allocs[k], b.id, amount, u, kind, i.id]);
    // Eight concurrent $30 raw matches against a $100 installment, each backed by its own allocation: exactly three commit.
    const results = await Promise.allSettled(allocs.map((_, k) => rawMatch(inst, k, 3000)));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3);
    const free = results.map((r, i) => (r.status === 'rejected' ? i : -1)).filter((i) => i >= 0);
    // A new revision makes the old installment stale: raw matches to it are refused.
    const cur = await plans.getPlanDetail(t.db.pool, t.actor, plan.id, { asOf: '2026-07-15' });
    await plans.revisePlan(t.db.pool, t.actor, { idempotencyKey: t.key(), planId: plan.id, version: cur.plan.version, reason: 'Reschedule', totalAmount: '400.00', installmentCount: '2', firstDueDate: '2026-09-01' }, 'r');
    await assert.rejects(rawMatch(inst, free[0], 1000), /current schedule of an active plan/);
    // A cancelled plan takes no new raw matches.
    const after = await plans.getPlanDetail(t.db.pool, t.actor, plan.id, { asOf: '2026-07-15' });
    await plans.cancelPlan(t.db.pool, t.actor, { planId: plan.id, version: after.plan.version, reason: 'Done' }, 'r');
    await assert.rejects(rawMatch(after.installments[0], free[1], 1000), /current schedule of an active plan/);
    // A plan cannot link a bill of another provider, or a bill without a confirmed amount, even by raw SQL.
    const foreign = await t.bill({ memberId: m, providerId: other, originalAmount: '10.00' });
    await assert.rejects(t.db.pool.query(`insert into payment_plan_bills (household_id, plan_id, bill_id) values ($1, $2, $3)`, [hh, plan.id, foreign.id]), /provider|confirmed/);
  } finally {
    await t.db.drop();
  }
});

test('one global lock order: opposing multi-payment writers do not deadlock and retries stay unused', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const m = await t.member();
    const p = await t.provider();
    const bills = [];
    for (let i = 0; i < 3; i++) bills.push(await t.bill({ memberId: m, providerId: p, originalAmount: '300.00' }));
    const pms = [];
    for (let i = 0; i < 3; i++) pms.push(await t.pay1({ amount: '300.00', allocations: bills.map((b) => ({ billId: b.id, amount: '100.00' })) }));
    const allocsOf = async (pm) => (await t.payment(pm.id)).allocations;
    const plan = await plans.createPlan(t.db.pool, t.actor, {
      idempotencyKey: t.key(), name: 'Plan', providerId: p, billIds: bills.map((b) => b.id), totalAmount: '900.00', installmentCount: '9', firstDueDate: '2026-06-01', cadence: 'monthly',
    }, 'r');
    const d0 = await plans.getPlanDetail(t.db.pool, t.actor, plan.id, { asOf: '2026-07-15' });
    let k = 0;
    for (const pm of pms) for (const a of await allocsOf(pm)) {
      await plans.matchInstallment(t.db.pool, t.actor, { idempotencyKey: t.key(), installmentId: d0.installments[k++].id, allocationId: a.allocationId, amount: '100.00' }, 'r');
    }
    const before = { ...retryStats };
    const ops = [];
    for (const pm of pms) {
      const al = await allocsOf(pm);
      // Refund lines in opposite orders, across payments and bills, racing plan revisions and voids of other payments.
      const lines = al.map((a) => ({ allocationId: a.allocationId, amount: '10.00' }));
      ops.push(t.refund(pm.id, { lines }), t.refund(pm.id, { lines: [...lines].reverse() }));
      ops.push(pay.reverseAllocation(t.db.pool, t.actor, { idempotencyKey: t.key(), allocationId: al[0].allocationId, amount: '5.00', effectiveDate: '2026-05-01', reason: 'Fix' }, 'r'));
    }
    const cur = await plans.getPlanDetail(t.db.pool, t.actor, plan.id, { asOf: '2026-07-15' });
    ops.push(plans.revisePlan(t.db.pool, t.actor, { idempotencyKey: t.key(), planId: plan.id, version: cur.plan.version, reason: 'Race', totalAmount: '900.00', installmentCount: '3', firstDueDate: '2027-01-01' }, 'r'));
    const settled = await Promise.allSettled(ops);
    for (const r of settled.filter((x) => x.status === 'rejected')) assert.ok(['conflict', 'stale_version', 'invalid_input'].includes(r.reason.code), String(r.reason.message ?? r.reason));
    assert.equal(retryStats.lockConflicts - before.lockConflicts, 0, 'no deadlock or serialization retry was needed');
  } finally {
    await t.db.drop();
  }
});

test('contracts: net allocations page with a cursor, payable bills keep the current bill, and as-of dates are validated', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const m = await t.member();
    const p = await t.provider('Searchable Clinic');
    const bills = [];
    for (let i = 0; i < 5; i++) bills.push(await t.bill({ memberId: m, providerId: p, originalAmount: '10.00' }));
    for (const b of bills) await t.pay1({ amount: '10.00', billId: b.id });
    const first = await listNetAllocations(t.db.pool, t.actor, { limit: 2 });
    assert.equal(first.items.length, 2);
    assert.ok(first.nextCursor);
    const seen = new Set(first.items.map((x) => x.allocationId));
    let cursor = first.nextCursor;
    while (cursor) {
      const next = await listNetAllocations(t.db.pool, t.actor, { limit: 2, cursor });
      for (const x of next.items) { assert.ok(!seen.has(x.allocationId), 'no row repeats across pages'); seen.add(x.allocationId); }
      cursor = next.nextCursor;
    }
    assert.equal(seen.size, 5);
    assert.equal((await listNetAllocations(t.db.pool, t.actor, { limit: 5 })).nextCursor, null);
    await assert.rejects(listNetAllocations(t.db.pool, t.actor, { cursor: 'nope' }), code('invalid_input'));
    // The payable list keeps the current bill even when it is paid off or does not match the search.
    const open = await t.bill({ memberId: m, providerId: p, originalAmount: '20.00', providerReference: 'ZZ-OPEN' });
    const listed = await payRepo.listPayableBills(t.db.pool, t.actor.householdId, { q: 'ZZ-OPEN', currentId: bills[0].id, limit: 10 });
    assert.deepEqual(listed.map((x) => x.id), [bills[0].id, open.id]);
    const none = await payRepo.listPayableBills(t.db.pool, t.actor.householdId, { q: 'no-such-text', currentId: bills[0].id, limit: 10 });
    assert.deepEqual(none.map((x) => x.id), [bills[0].id]);
    // As-of dates must be real dates.
    for (const bad of ['2026-02-30', '2026-13-01', 'yesterday', '2026-7-1']) await assert.rejects(plans.listPlans(t.db.pool, t.actor, {}, bad), code('invalid_input'));
    await plans.listPlans(t.db.pool, t.actor, {}, '2026-02-28');
  } finally {
    await t.db.drop();
  }
});

test('a match for a new payment appearing under a held plan lock restarts the transaction instead of deadlocking', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const m = await t.member();
    const p = await t.provider();
    const b = await t.bill({ memberId: m, providerId: p, originalAmount: '2000.00' });
    const plan = await plans.createPlan(t.db.pool, t.actor, {
      idempotencyKey: t.key(), name: 'Plan', providerId: p, billId: b.id, totalAmount: '1500.00', installmentCount: '15', firstDueDate: '2026-06-01', cadence: 'monthly',
    }, 'r');
    const hh = t.actor.householdId;
    const u = t.actor.userId;
    const before = { ...retryStats };
    for (let round = 0; round < 15; round++) {
      const pm = await t.pay1({ amount: '100.00', billId: b.id });
      const alloc = (await t.payment(pm.id)).allocations[0].allocationId;
      const d = await plans.getPlanDetail(t.db.pool, t.actor, plan.id, { asOf: '2026-07-15' });
      const raw = await t.db.pool.connect();
      try {
        await raw.query('begin');
        await raw.query('select id from payment_plans where id = $1 for update', [plan.id]);
        // The revision blocks on the plan lock held by the raw transaction.
        const revise = plans.revisePlan(t.db.pool, t.actor, { idempotencyKey: t.key(), planId: plan.id, version: d.plan.version, reason: 'Race', totalAmount: '1500.00', installmentCount: '15', firstDueDate: '2027-01-01' }, 'r');
        await new Promise((r) => setTimeout(r, 60));
        await raw.query(
          `insert into installment_matches (id, household_id, plan_id, revision_id, installment_id, payment_id, allocation_id, bill_id, kind, amount_cents, created_by)
           select gen_random_uuid(), $1, i.plan_id, i.revision_id, i.id, $2, $3, $4, 'match', 1000, $5 from plan_installments i where i.id = $6`,
          [hh, pm.id, alloc, b.id, u, d.installments[0].id]);
        await raw.query('commit');
        // A refund on the new payment races the revision: it takes the payment lock, then needs the plan.
        const refund = t.refund(pm.id, { allocationId: alloc, amount: '95.00' });
        const settled = await Promise.allSettled([revise, refund]);
        for (const r of settled) if (r.status === 'rejected') assert.ok(['conflict', 'stale_version'].includes(r.reason.code), String(r.reason.message ?? r.reason));
        assert.equal(settled[1].status, 'fulfilled');
      } finally {
        raw.release();
      }
    }
    assert.equal(retryStats.lockConflicts - before.lockConflicts, 0, 'no deadlock: the restart takes locks in the documented order');
    assert.ok(retryStats.replanned - before.replanned >= 1, 'the transaction was restarted at least once');
  } finally {
    await t.db.drop();
  }
});
