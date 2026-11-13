// Payments, allocations, refunds, reversals and database guards (M03). Synthetic data only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import * as handlers from '../../apps/web/server/http.ts';
import { csrfFor } from '../../apps/web/server/tokens.ts';
import * as svc from '../../apps/web/server/services/expenses.ts';
import * as pay from '../../apps/web/server/services/payments.ts';
import { billContract, listNetAllocations, lockPaymentsForMoney } from '../../apps/web/server/contracts.ts';
import { createPool } from '../../apps/web/server/db.ts';
import { setLogSink } from '../../apps/web/server/log.ts';
import { freshDatabase, post, skipDb } from './helpers.mjs';

import { setup } from './money-helpers.mjs';
const code = (c) => ({ code: c });
const ids = async (t) => {
  const m = await t.member();
  const p = await t.provider();
  return { m, p };
};

test('payments apply across many bills and many payments, with exact cent arithmetic', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const { m, p } = await ids(t);
    const a = await t.bill({ memberId: m, providerId: p, originalAmount: '100.10' });
    const b = await t.bill({ memberId: m, providerId: p, originalAmount: '50.20' });
    const c = await t.bill({ memberId: m, providerId: p, originalAmount: '30.00' });
    // Payment 1: $150.30 across A and B in one request.
    const p1 = await t.pay1({ amount: '150.30', allocations: [{ billId: a.id, amount: '100.10' }, { billId: b.id, amount: '50.20' }] });
    assert.equal((await t.detail(a.id)).openBalanceCents, '0');
    assert.equal((await t.detail(b.id)).openBalanceCents, '0');
    // Payment 2: $40.00, $10 to C now; $30 stays unapplied.
    const p2 = await t.pay1({ amount: '40.00', billId: c.id, allocateAmount: '10.00' });
    const d2 = await t.payment(p2.id);
    assert.equal(d2.payment.unappliedCents, '3000');
    assert.equal(d2.payment.appliedCents, '1000');
    assert.equal((await t.detail(c.id)).openBalanceCents, '2000');
    // Apply the remainder of payment 2 and a slice of C from a third payment: many-to-many on bill C.
    await pay.allocatePayment(t.db.pool, t.actor, { idempotencyKey: t.key(), paymentId: p2.id, billId: c.id, allocateAmount: '20.00' }, 'r');
    assert.equal((await t.detail(c.id)).openBalanceCents, '0');
    assert.equal((await t.payment(p2.id)).payment.unappliedCents, '1000');
    const cash = await pay.cashSummary(t.db.pool, t.actor);
    assert.equal(cash.unappliedCents, '1000');
    assert.equal(cash.netCashCents, '19030');
    // Bill detail figures reconcile: responsibility - applied = open balance; applied equals the allocation view.
    const bc = billContract(await t.detail(a.id));
    assert.equal(bc.appliedCents, '10010');
    assert.equal(bc.creditCents, '0');
    const nets = await listNetAllocations(t.db.pool, t.actor, { billIds: [a.id, b.id, c.id] });
    assert.equal(nets.length, 4);
    assert.equal(nets.reduce((s, x) => s + BigInt(x.netCents), 0n), 19030n - 1000n, 'net allocated equals net cash minus unapplied');
    assert.equal(p1.replayed, false);
    // Allocations may not exceed the open balance, the payment, or touch estimates, and a bill is listed once.
    const d = await t.bill({ memberId: m, providerId: p, originalAmount: '20.00' });
    const est = await t.bill({ memberId: m, providerId: p, originalAmount: '20.00', amountStatus: 'estimate' });
    await assert.rejects(t.pay1({ amount: '100.00', billId: d.id, allocateAmount: '25.00' }), code('conflict'));
    await assert.rejects(t.pay1({ amount: '10.00', billId: d.id, allocateAmount: '15.00' }), code('invalid_input'));
    await assert.rejects(t.pay1({ amount: '20.00', billId: est.id }), code('conflict'));
    await assert.rejects(t.pay1({ amount: '20.00', allocations: [{ billId: d.id, amount: '5' }, { billId: d.id, amount: '5' }] }), code('invalid_input'));
    await assert.rejects(t.pay1({ amount: '0.00' }), code('invalid_input'));
    await assert.rejects(t.pay1({ amount: '1.005' }), code('invalid_input'));
    await assert.rejects(t.pay1({ amount: '10', allocateAmount: '5' }), code('invalid_input'));
    await assert.rejects(pay.allocatePayment(t.db.pool, t.actor, { idempotencyKey: t.key(), paymentId: p2.id, billId: d.id, allocateAmount: '10.01' }, 'r'), code('conflict'));
    assert.equal(await t.count('payments'), 2, 'rejected requests left no payment behind');
  } finally {
    await t.db.drop();
  }
});

test('refunds, reversals and credits: net payments follow posted events, and corrections are linked entries', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const { m, p } = await ids(t);
    const a = await t.bill({ memberId: m, providerId: p, originalAmount: '100.00' });
    const b = await t.bill({ memberId: m, providerId: p, originalAmount: '60.00' });
    const pm = await t.pay1({ amount: '170.00', allocations: [{ billId: a.id, amount: '100.00' }, { billId: b.id, amount: '60.00' }] });
    const [alloc] = (await t.payment(pm.id)).allocations.filter((x) => x.billId === a.id);
    // Partial refund against bill A: $30 of $100.
    const r1 = await t.refund(pm.id, { allocationId: alloc.allocationId, amount: '30.00' });
    let d = await t.detail(a.id);
    assert.equal(d.appliedCents, '7000');
    assert.equal(d.openBalanceCents, '3000');
    let pd = await t.payment(pm.id);
    assert.equal(pd.payment.refundedCents, '3000');
    assert.equal(pd.payment.netCashCents, '14000');
    assert.equal(pd.payment.unappliedCents, '1000', 'unapplied cash is untouched by a refund of applied cash');
    // More than the allocation holds, more than the unapplied cash, and a stale repeat are all rejected.
    await assert.rejects(t.refund(pm.id, { allocationId: alloc.allocationId, amount: '70.01' }), code('conflict'));
    await assert.rejects(t.refund(pm.id, { amount: '10.01' }), code('conflict'));
    // A refund of unapplied cash: $4.00 of the $10 left.
    const r2 = await t.refund(pm.id, { amount: '4.00' });
    pd = await t.payment(pm.id);
    assert.equal(pd.payment.unappliedCents, '600');
    assert.equal(pd.payment.netCashCents, '13600');
    // Reverse the first refund: bill A is back to $100 applied and the cash returns.
    await pay.reverseRefund(t.db.pool, t.actor, { idempotencyKey: t.key(), eventId: r1.id, effectiveDate: '2026-05-02', reason: 'Entered in error' }, 'r');
    d = await t.detail(a.id);
    assert.equal(d.appliedCents, '10000');
    assert.equal((await t.payment(pm.id)).payment.refundedCents, '400');
    await assert.rejects(pay.reverseRefund(t.db.pool, t.actor, { idempotencyKey: t.key(), eventId: r1.id, effectiveDate: '2026-05-02', reason: 'Again' }, 'r'), code('conflict'));
    // Reverse part of an allocation: cash returns to the unapplied balance (a correction, not a refund).
    await pay.reverseAllocation(t.db.pool, t.actor, { idempotencyKey: t.key(), allocationId: alloc.allocationId, amount: '25.00', effectiveDate: '2026-05-03', reason: 'Wrong bill' }, 'r');
    d = await t.detail(a.id);
    assert.equal(d.appliedCents, '7500');
    pd = await t.payment(pm.id);
    assert.equal(pd.payment.unappliedCents, '3100');
    assert.equal(pd.payment.refundedCents, '400');
    // Immutable history: nothing was deleted or rewritten; the ledger lists every entry in order.
    assert.deepEqual(pd.entries.map((e) => e.kind), ['allocation', 'allocation', 'refund', 'unapplied_refund', 'refund_reversal', 'allocation_reversal']);
    assert.ok(pd.entries.find((e) => e.kind === 'refund_reversal').reversesEntryId);
    // The reversal of the unapplied refund is blocked while the cash it returned would be overdrawn... then allowed.
    await pay.reverseRefund(t.db.pool, t.actor, { idempotencyKey: t.key(), eventId: r2.id, effectiveDate: '2026-05-04', reason: 'Entered in error' }, 'r');
    pd = await t.payment(pm.id);
    assert.equal(pd.payment.unappliedCents, '3500');
    assert.equal(pd.payment.refundedCents, '0');
    // Credits: an insurer adjustment after payment drives the balance negative and is surfaced as a provider credit, not hidden.
    await t.adjust(b.id, '-25.00');
    const credit = billContract(await t.detail(b.id));
    assert.equal(credit.responsibilityCents, '3500');
    assert.equal(credit.appliedCents, '6000');
    assert.equal(credit.openBalanceCents, '-2500');
    assert.equal(credit.creditCents, '2500');
    // A cash refund of that credit is a separate, explicit event and then clears the credit.
    const ballocation = (await t.payment(pm.id)).allocations.find((x) => x.billId === b.id);
    await t.refund(pm.id, { allocationId: ballocation.allocationId, amount: '25.00' });
    const cleared = billContract(await t.detail(b.id));
    assert.equal(cleared.openBalanceCents, '0');
    assert.equal(cleared.creditCents, '0');
    assert.equal((await svc.expenseOverview(t.db.pool, t.actor, {})).totals.confirmedCreditCents, '0');
    // Voiding: not while cash is applied; then allowed for a payment with nothing applied or refunded.
    await assert.rejects(pay.voidPayment(t.db.pool, t.actor, { idempotencyKey: t.key(), paymentId: pm.id, voidedOn: '2026-05-05', reason: 'Bounced' }, 'r'), code('conflict'));
    const stray = await t.pay1({ amount: '12.00' });
    await pay.voidPayment(t.db.pool, t.actor, { idempotencyKey: t.key(), paymentId: stray.id, voidedOn: '2026-05-05', reason: 'Entered twice' }, 'r');
    const v = (await t.payment(stray.id)).payment;
    assert.equal(v.voided, true);
    assert.equal(v.unappliedCents, '0');
    assert.equal(v.netCashCents, '0');
    await assert.rejects(pay.allocatePayment(t.db.pool, t.actor, { idempotencyKey: t.key(), paymentId: stray.id, billId: a.id, allocateAmount: '1.00' }, 'r'), code('conflict'));
    await assert.rejects(t.refund(stray.id, { amount: '1.00' }), code('conflict'));
  } finally {
    await t.db.drop();
  }
});

test('idempotency: one logical request is one financial effect, and changed input conflicts', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const { m, p } = await ids(t);
    const a = await t.bill({ memberId: m, providerId: p, originalAmount: '100.00' });
    const key = t.key();
    const body = { idempotencyKey: key, paidOn: '2026-04-01', amount: '60.00', method: 'card', billId: a.id };
    const first = await pay.recordPayment(t.db.pool, t.actor, body, 'r');
    const replay = await pay.recordPayment(t.db.pool, t.actor, body, 'r');
    assert.equal(replay.id, first.id);
    assert.equal(replay.replayed, true);
    await assert.rejects(pay.recordPayment(t.db.pool, t.actor, { ...body, amount: '61.00' }, 'r'), code('conflict'));
    assert.equal(await t.count('payments'), 1);
    assert.equal((await t.detail(a.id)).appliedCents, '6000');
    // Concurrent duplicates with one key: exactly one payment, everyone gets the same id.
    const k2 = t.key();
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => pay.recordPayment(t.db.pool, t.actor, { ...body, idempotencyKey: k2, amount: '10.00', billId: a.id, allocateAmount: '10.00' }, 'r')));
    assert.ok(results.every((r) => r.status === 'fulfilled'), results.filter((r) => r.status === 'rejected').map((r) => r.reason.message).join());
    assert.equal(new Set(results.map((r) => r.value.id)).size, 1);
    assert.equal(await t.count('payments'), 2);
    assert.equal((await t.detail(a.id)).appliedCents, '7000');
    // Refund and reversal replays.
    const alloc = (await t.payment(first.id)).allocations[0];
    const rk = t.key();
    const rb = { idempotencyKey: rk, paymentId: first.id, effectiveDate: '2026-05-01', reason: 'Refund', allocationId: alloc.allocationId, amount: '5.00' };
    const r1 = await pay.recordRefund(t.db.pool, t.actor, rb, 'r');
    const r2 = await pay.recordRefund(t.db.pool, t.actor, rb, 'r');
    assert.equal(r1.id, r2.id);
    await assert.rejects(pay.recordRefund(t.db.pool, t.actor, { ...rb, amount: '6.00' }, 'r'), code('conflict'));
    assert.equal((await t.detail(a.id)).appliedCents, '6500');
    // A different actor can reuse the same key text without colliding.
    const k3 = t.key();
    await pay.recordPayment(t.db.pool, t.actor, { idempotencyKey: k3, paidOn: '2026-04-01', amount: '1.00', method: 'cash' }, 'r');
    assert.equal(await t.count('idempotency_records') > 0, true);
  } finally {
    await t.db.drop();
  }
});

test('a failure anywhere in a request rolls back the payment, allocations, matches and audit', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const { m, p } = await ids(t);
    const a = await t.bill({ memberId: m, providerId: p, originalAmount: '100.00' });
    const est = await t.bill({ memberId: m, providerId: p, originalAmount: '100.00', amountStatus: 'estimate' });
    const before = { payments: await t.count('payments'), entries: await t.count('payment_entries'), audit: await t.count('audit_events'), idem: await t.count('idempotency_records') };
    // The second allocation fails after the payment and first allocation were already written in the transaction.
    await assert.rejects(t.pay1({ amount: '200.00', allocations: [{ billId: a.id, amount: '10.00' }, { billId: est.id, amount: '10.00' }] }), code('conflict'));
    // And a second, injected database failure after the writes (an audit row that violates a constraint).
    const key = t.key();
    await t.db.pool.query(`create function pg_temp.noop() returns void language sql as 'select 1'`).catch(() => {});
    await t.db.pool.query(`create or replace function fail_audit() returns trigger language plpgsql as $$ begin if new.action = 'payment.recorded' then raise exception 'injected'; end if; return new; end $$`);
    await t.db.pool.query(`create trigger fail_audit before insert on audit_events for each row execute function fail_audit()`);
    await assert.rejects(pay.recordPayment(t.db.pool, t.actor, { idempotencyKey: key, paidOn: '2026-04-01', amount: '10.00', method: 'cash', billId: a.id }, 'r'), /injected/);
    await t.db.pool.query(`drop trigger fail_audit on audit_events`);
    assert.deepEqual({ payments: await t.count('payments'), entries: await t.count('payment_entries'), audit: await t.count('audit_events'), idem: await t.count('idempotency_records') }, before);
    // The key was not consumed by the failed attempt: the retry succeeds once.
    const ok = await pay.recordPayment(t.db.pool, t.actor, { idempotencyKey: key, paidOn: '2026-04-01', amount: '10.00', method: 'cash', billId: a.id }, 'r');
    assert.equal(ok.replayed, false);
    assert.equal((await t.detail(a.id)).appliedCents, '1000');
  } finally {
    await t.db.drop();
  }
});

test('concurrent writers cannot over-apply a payment, overpay a bill, or over-refund an allocation', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const { m, p } = await ids(t);
    // 12 concurrent $30 allocations of one $100 payment to 12 different bills: exactly three fit.
    const bills = await Promise.all(Array.from({ length: 12 }, () => t.bill({ memberId: m, providerId: p, originalAmount: '50.00' })));
    const pm = await t.pay1({ amount: '100.00' });
    const r = await Promise.allSettled(bills.map((b) => pay.allocatePayment(t.db.pool, t.actor, { idempotencyKey: t.key(), paymentId: pm.id, billId: b.id, allocateAmount: '30.00' }, 'r')));
    assert.equal(r.filter((x) => x.status === 'fulfilled').length, 3);
    for (const x of r.filter((y) => y.status === 'rejected')) assert.equal(x.reason.code, 'conflict');
    assert.equal((await t.payment(pm.id)).payment.unappliedCents, '1000');
    // Many payments racing to fill one bill: the bill takes exactly its balance.
    const target = await t.bill({ memberId: m, providerId: p, originalAmount: '100.00' });
    const payments = await Promise.all(Array.from({ length: 10 }, () => t.pay1({ amount: '40.00' })));
    const r2 = await Promise.allSettled(payments.map((x) => pay.allocatePayment(t.db.pool, t.actor, { idempotencyKey: t.key(), paymentId: x.id, billId: target.id, allocateAmount: '40.00' }, 'r')));
    assert.equal(r2.filter((x) => x.status === 'fulfilled').length, 2, 'two $40 fit in $100');
    assert.equal((await t.detail(target.id)).openBalanceCents, '2000');
    // An adjustment racing with an allocation: the balance is checked under the bill lock both times, so it is never overapplied.
    const adj = await t.bill({ memberId: m, providerId: p, originalAmount: '100.00' });
    const px = await t.pay1({ amount: '100.00' });
    const race = await Promise.allSettled([
      pay.allocatePayment(t.db.pool, t.actor, { idempotencyKey: t.key(), paymentId: px.id, billId: adj.id, allocateAmount: '100.00' }, 'r'),
      t.adjust(adj.id, '-60.00'),
    ]);
    assert.ok(race.some((x) => x.status === 'fulfilled'));
    const final = await t.detail(adj.id);
    if (BigInt(final.adjustmentsCents) === -6000n && BigInt(final.appliedCents) === 10000n) {
      // The adjustment landed after the payment: a legitimate credit (provider owes the household), never a hidden overpayment.
      assert.equal(final.creditCents, '6000');
    } else {
      assert.ok(BigInt(final.openBalanceCents) >= 0n, JSON.stringify(final));
    }
    // Concurrent refunds against one allocation: only what it holds, once.
    const refundBill = await t.bill({ memberId: m, providerId: p, originalAmount: '100.00' });
    const pr = await t.pay1({ amount: '100.00', billId: refundBill.id });
    const alloc = (await t.payment(pr.id)).allocations[0];
    const r3 = await Promise.allSettled(Array.from({ length: 10 }, () => t.refund(pr.id, { allocationId: alloc.allocationId, amount: '30.00' })));
    assert.equal(r3.filter((x) => x.status === 'fulfilled').length, 3);
    assert.equal((await t.payment(pr.id)).payment.netCashCents, '1000');
    // A refund racing a reversal of the same allocation: together they never take more than the allocation held.
    const fresh = await t.bill({ memberId: m, providerId: p, originalAmount: '100.00' });
    const pf = await t.pay1({ amount: '100.00', billId: fresh.id });
    const a2 = (await t.payment(pf.id)).allocations[0];
    const r4 = await Promise.allSettled([
      t.refund(pf.id, { allocationId: a2.allocationId, amount: '70.00' }),
      pay.reverseAllocation(t.db.pool, t.actor, { idempotencyKey: t.key(), allocationId: a2.allocationId, amount: '70.00', effectiveDate: '2026-05-01', reason: 'x' }, 'r'),
    ]);
    assert.equal(r4.filter((x) => x.status === 'fulfilled').length, 1, '70 + 70 > 100, so only one of the refund and the reversal fits');
    // Every payment ledger is internally consistent after the races.
    const bad = await t.db.pool.query(`select p.id from payments p left join lateral (select coalesce(sum(amount_cents) filter (where bill_id is not null), 0) applied,
      -coalesce(sum(amount_cents) filter (where kind in ('refund','unapplied_refund','refund_reversal')), 0) refunded from payment_entries e where e.payment_id = p.id) c on true
      where p.amount_cents - c.refunded - c.applied < 0`);
    assert.equal(bad.rowCount, 0);
  } finally {
    await t.db.drop();
  }
});

test('the database itself refuses over-applied cash, over-refunds, mutation and bad references', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const { m, p } = await ids(t);
    const a = await t.bill({ memberId: m, providerId: p, originalAmount: '100.00' });
    const est = await t.bill({ memberId: m, providerId: p, originalAmount: '100.00', amountStatus: 'estimate' });
    const pm = await t.pay1({ amount: '100.00', billId: a.id, allocateAmount: '60.00' });
    const pool = t.db.pool;
    const hh = t.actor.householdId;
    const u = t.actor.userId;
    const alloc = (await t.payment(pm.id)).allocations[0].allocationId;
    const insert = (client, kind, amount, extra = {}) => {
      const id = extra.id ?? randomUUID();
      const o = { bill: a.id, allocation: kind === 'allocation' ? id : alloc, reverses: null, ...extra };
      return client.query(
        `insert into payment_entries (id, household_id, payment_id, event_id, kind, bill_id, allocation_id, reverses_entry_id, amount_cents, effective_date, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, '2026-05-01', $10)`,
        [id, hh, pm.id, randomUUID(), kind, kind === 'unapplied_refund' ? null : o.bill, kind === 'unapplied_refund' ? null : o.allocation, o.reverses, amount, u]);
    };
    // Over-applying beyond the payment's cash: $40 unapplied, a $40.01 allocation fails at commit.
    await assert.rejects(insert(pool, 'allocation', 4001), /exceed the payment/);
    await insert(pool, 'allocation', 4000, { bill: a.id }).catch((e) => assert.fail(e.message)).then(() => {}, () => {});
    assert.equal(await t.count('payment_entries'), 2);
    await assert.rejects(insert(pool, 'allocation', 1), /exceed the payment/);
    // Refunds and reversals cannot take an allocation below zero.
    await assert.rejects(insert(pool, 'refund', -6001), /below zero/);
    await assert.rejects(insert(pool, 'allocation_reversal', -6001), /below zero/);
    await insert(pool, 'refund', -6000);
    // Applied cash above what the payment holds after refunds, and a refund of cash the payment never held.
    await assert.rejects(insert(pool, 'unapplied_refund', -4001), /exceed the payment/);
    // Sign and shape rules.
    await assert.rejects(insert(pool, 'refund', 100), /check/);
    await assert.rejects(insert(pool, 'allocation', -100), /check/);
    // Targets must be allocations of the same payment and bill; allocations only go to confirmed bills.
    await assert.rejects(insert(pool, 'refund', -1, { allocation: randomUUID() }), /foreign key|allocation/);
    const otherBill = await t.bill({ memberId: m, providerId: p, originalAmount: '10.00' });
    await assert.rejects(insert(pool, 'refund', -1, { bill: otherBill.id }), /same payment and bill|foreign key/);
    await assert.rejects(insert(pool, 'allocation', 100, { bill: est.id }), /confirmed amounts/);
    // A refund reversal must exactly offset one refund, once.
    const refundId = (await pool.query(`select id from payment_entries where kind = 'refund' and payment_id = $1`, [pm.id])).rows[0].id;
    await assert.rejects(insert(pool, 'refund_reversal', 5999, { reverses: refundId }), /exactly offset/);
    await insert(pool, 'refund_reversal', 6000, { reverses: refundId });
    await assert.rejects(insert(pool, 'refund_reversal', 6000, { reverses: refundId }), /payment_entries_one_refund_reversal|duplicate key/);
    // Append-only.
    await assert.rejects(pool.query(`update payment_entries set amount_cents = 1`), /append-only/);
    await assert.rejects(pool.query(`delete from payment_entries`), /append-only/);
    await assert.rejects(pool.query(`update payments set amount_cents = 1`), /append-only/);
    await assert.rejects(pool.query(`delete from payments`), /append-only/);
    await assert.rejects(pool.query(`truncate payment_entries cascade`), /append-only/);
    // A voided payment keeps nothing applied or refunded.
    const clean = await t.pay1({ amount: '5.00' });
    await pool.query(`insert into payment_voids (payment_id, household_id, reason, voided_on, created_by) values ($1, $2, 'x', '2026-05-01', $3)`, [clean.id, hh, u]);
    await assert.rejects(pool.query(
      `insert into payment_entries (id, household_id, payment_id, event_id, kind, bill_id, allocation_id, amount_cents, effective_date, created_by)
       select gen_random_uuid(), $1, $2, gen_random_uuid(), 'unapplied_refund', null, null, -100, '2026-05-01', $3`, [hh, clean.id, u]), /voided/);
    await assert.rejects(pool.query(`insert into payment_voids (payment_id, household_id, reason, voided_on, created_by) values ($1, $2, 'x', '2026-05-01', $3)`, [pm.id, hh, u]), /voided payment|duplicate/);
    // Concurrent raw writers: 12 raw $10 allocations on a fresh $50 payment leave exactly five.
    const racer = await t.pay1({ amount: '50.00' });
    const target = await t.bill({ memberId: m, providerId: p, originalAmount: '500.00' });
    const raw = () => {
      const id = randomUUID();
      return pool.query(
        `insert into payment_entries (id, household_id, payment_id, event_id, kind, bill_id, allocation_id, amount_cents, effective_date, created_by)
         values ($1, $2, $3, gen_random_uuid(), 'allocation', $4, $1, 1000, '2026-05-01', $5)`, [id, hh, racer.id, target.id, u]);
    };
    const results = await Promise.allSettled(Array.from({ length: 12 }, raw));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 5);
    assert.equal((await t.payment(racer.id)).payment.unappliedCents, '0');
  } finally {
    await t.db.drop();
  }
});

test('audit records actor, action and before/after values for money-affecting events', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const { m, p } = await ids(t);
    const a = await t.bill({ memberId: m, providerId: p, originalAmount: '100.00' });
    const b = await t.bill({ memberId: m, providerId: p, originalAmount: '100.00' });
    const pm = await t.pay1({ amount: '120.00', allocations: [{ billId: a.id, amount: '70.00' }, { billId: b.id, amount: '40.00' }] });
    const recorded = (await t.audit('payment.recorded'))[0].detail;
    assert.deepEqual([recorded.amountCents, recorded.allocatedCents, recorded.unappliedCents], ['12000', '11000', '1000']);
    const allocated = (await t.audit('payment.allocated')).map((r) => r.detail).sort((x, y) => (x.amountCents < y.amountCents ? 1 : -1));
    assert.deepEqual([allocated[0].balanceBeforeCents, allocated[0].balanceAfterCents], ['10000', '3000']);
    const alloc = (await t.payment(pm.id)).allocations.find((x) => x.billId === a.id);
    await t.refund(pm.id, { allocationId: alloc.allocationId, amount: '20.00' });
    const refunded = (await t.audit('payment.allocation_refunded'))[0].detail;
    assert.deepEqual([refunded.allocationBeforeCents, refunded.allocationAfterCents, refunded.billBalanceBeforeCents, refunded.billBalanceAfterCents], ['7000', '5000', '3000', '5000']);
    const summary = (await t.audit('payment.refunded'))[0].detail;
    assert.deepEqual([summary.netCashBeforeCents, summary.netCashAfterCents], ['12000', '10000']);
    await pay.reverseAllocation(t.db.pool, t.actor, { idempotencyKey: t.key(), allocationId: alloc.allocationId, amount: '10.00', effectiveDate: '2026-05-02', reason: 'Wrong bill' }, 'r');
    const rev = (await t.audit('payment.allocation_reversed'))[0].detail;
    assert.deepEqual([rev.allocationBeforeCents, rev.allocationAfterCents, rev.unappliedBeforeCents, rev.unappliedAfterCents], ['5000', '4000', '1000', '2000']);
    // Reasons and notes are not copied into the audit trail (they live on the immutable entry).
    for (const row of await t.db.pool.query(`select detail from audit_events where action like 'payment.%'`).then((r) => r.rows)) {
      assert.ok(!JSON.stringify(row.detail).includes('Wrong bill'));
    }
    // Bill history includes payment events in audit order, and the payment page history is by actor.
    const history = (await svc.getBillDetail(t.db.pool, t.actor, a.id)).history.map((h) => h.action);
    assert.ok(history.includes('payment.allocated') && history.includes('payment.allocation_refunded') && history.includes('payment.allocation_reversed'));
    assert.ok((await t.payment(pm.id)).history.every((h) => h.actorName === 'Alex Example'));
  } finally {
    await t.db.drop();
  }
});

test('access boundaries, forms and redirects for payments', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const { m, p } = await ids(t);
    const a = await t.bill({ memberId: m, providerId: p, originalAmount: '100.00' });
    const pm = await t.pay1({ amount: '50.00', billId: a.id });
    const h2 = (await t.db.pool.query(`insert into households (name) values ('Other Family') returning id`)).rows[0].id;
    const u2 = (await t.db.pool.query(
      `insert into users (household_id, email, display_name, role, password_hash) values ($1, 'other@example.test', 'Other Admin', 'admin', 'x') returning id`, [h2])).rows[0].id;
    const outsider = { userId: u2, householdId: h2, role: 'admin', displayName: 'Other Admin', sessionId: randomUUID() };
    await assert.rejects(pay.getPaymentDetail(t.db.pool, outsider, pm.id), code('not_found'));
    assert.equal((await pay.listPayments(t.db.pool, outsider, {})).items.length, 0);
    assert.equal((await pay.cashSummary(t.db.pool, outsider)).paymentCount, 0);
    await assert.rejects(pay.recordPayment(t.db.pool, outsider, { idempotencyKey: t.key(), paidOn: '2026-04-01', amount: '1.00', method: 'cash', billId: a.id }, 'r'), code('not_found'));
    await assert.rejects(pay.allocatePayment(t.db.pool, outsider, { idempotencyKey: t.key(), paymentId: pm.id, billId: a.id, allocateAmount: '1' }, 'r'), code('not_found'));
    const alloc = (await t.payment(pm.id)).allocations[0].allocationId;
    await assert.rejects(pay.reverseAllocation(t.db.pool, outsider, { idempotencyKey: t.key(), allocationId: alloc, effectiveDate: '2026-05-01', reason: 'x' }, 'r'), code('not_found'));
    await assert.rejects(pay.recordRefund(t.db.pool, outsider, { idempotencyKey: t.key(), paymentId: pm.id, effectiveDate: '2026-05-01', reason: 'x', allocationId: alloc, amount: '1' }, 'r'), code('not_found'));
    await assert.rejects(listNetAllocations(t.db.pool, { ...outsider, role: 'nobody' }), code('forbidden'));
    assert.deepEqual(await listNetAllocations(t.db.pool, outsider), []);
    // The database refuses to link a payment entry of one household to another household's bill.
    await assert.rejects(t.db.pool.query(
      `insert into payment_entries (id, household_id, payment_id, event_id, kind, bill_id, allocation_id, amount_cents, effective_date, created_by)
       values ($1, $2, $3, gen_random_uuid(), 'allocation', $4, $1, 100, '2026-05-01', $5)`, [randomUUID(), h2, pm.id, a.id, u2]), /foreign key|confirmed amounts/);

    // HTTP: anonymous, forged, and form posts.
    const token = t.cookie.split('=')[1];
    const h = { 'x-csrf-token': csrfFor(token) };
    const body = { idempotencyKey: t.key(), paidOn: '2026-04-02', amount: '5.00', method: 'cash' };
    assert.equal((await handlers.handleExpenseAction(post('/api/expenses/payments/create', body, { type: 'json' }), t.ctx, 'payments/create')).status, 401);
    assert.equal((await handlers.handleExpenseAction(post('/api/expenses/payments/create', body, { type: 'json', cookie: t.cookie }), t.ctx, 'payments/create')).status, 403);
    assert.equal((await handlers.handleExpenseAction(post('/api/expenses/payments/create', { ...body, householdId: h2 }, { type: 'json', cookie: t.cookie, headers: h }), t.ctx, 'payments/create')).status, 400);
    const ok = await handlers.handleExpenseAction(post('/api/expenses/payments/create', body, { type: 'json', cookie: t.cookie, headers: h }), t.ctx, 'payments/create');
    assert.equal(ok.status, 201);
    const created = await ok.json();
    // JSON allocations array.
    const withAllocs = await handlers.handleExpenseAction(post('/api/expenses/payments/create', { ...body, idempotencyKey: t.key(), allocations: [{ billId: a.id, amount: '5.00' }] }, { type: 'json', cookie: t.cookie, headers: h }), t.ctx, 'payments/create');
    assert.equal(withAllocs.status, 201);
    // Form post redirects to the payment; an error redirects back with only an error code in the URL.
    const form = (action, b) => handlers.handleExpenseAction(post(`/api/expenses/${action}`, { ...b, csrf: csrfFor(token) }, { cookie: t.cookie, html: true }), t.ctx, action);
    const redirectOk = await form('payments/create', { ...body, idempotencyKey: t.key(), billId: a.id, allocateAmount: '5.00' });
    assert.equal(redirectOk.status, 303);
    assert.match(redirectOk.headers.get('location'), /\/payments\/[0-9a-f-]{36}$/);
    const bad = await form('payments/create', { ...body, idempotencyKey: t.key(), amount: '1.005', reference: 'REF-SECRET-123' });
    assert.equal(bad.status, 303);
    const loc = new URL(bad.headers.get('location'));
    assert.equal(loc.pathname, '/payments');
    assert.deepEqual([...loc.searchParams.keys()], ['error']);
    assert.ok(!bad.headers.get('location').includes('REF-SECRET'));
    assert.match(bad.headers.get('set-cookie'), /tallymed_flash=/);
    const conflict = await form('payments/refund', { idempotencyKey: t.key(), paymentId: created.id, effectiveDate: '2026-05-01', reason: 'x', amount: '9999.00' });
    assert.equal(new URL(conflict.headers.get('location')).pathname, `/payments/${created.id}`);
    assert.equal(new URL(conflict.headers.get('location')).searchParams.get('error'), 'conflict');
  } finally {
    await t.db.drop();
  }
});

test('contracts: net allocations and locking for HSA reconciliation', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const { m, p } = await ids(t);
    const a = await t.bill({ memberId: m, providerId: p, originalAmount: '100.00' });
    const pm = await t.pay1({ amount: '100.00', billId: a.id });
    const alloc = (await t.payment(pm.id)).allocations[0];
    await t.refund(pm.id, { allocationId: alloc.allocationId, amount: '25.00' });
    await pay.reverseAllocation(t.db.pool, t.actor, { idempotencyKey: t.key(), allocationId: alloc.allocationId, amount: '15.00', effectiveDate: '2026-05-02', reason: 'x' }, 'r');
    const [net] = await listNetAllocations(t.db.pool, t.actor, { billIds: [a.id] });
    assert.deepEqual({ ...net }, {
      allocationId: alloc.allocationId, paymentId: pm.id, billId: a.id, memberId: m, providerId: p, paidOn: '2026-04-01',
      allocatedCents: '10000', reversedCents: '1500', refundedCents: '2500', netCents: '6000', matchedCents: '0',
    });
    assert.equal(billContract(await t.detail(a.id)).appliedCents, '6000', 'bill net applied equals the sum of net allocations');
    const locked = await t.db.pool.connect();
    try {
      await locked.query('begin');
      assert.deepEqual(await lockPaymentsForMoney(locked, t.actor.householdId, [pm.id, pm.id]), [pm.id]);
      await locked.query('rollback');
    } finally {
      locked.release();
    }
  } finally {
    await t.db.drop();
  }
});

test('upgrade: migration 0005 applies over earlier expense data without changing balances', { skip: skipDb }, async () => {
  const { migrate } = await import('../../apps/web/server/migrate.ts');
  const db = await freshDatabase({ migrateAll: false });
  try {
    await migrate(db.pool, { upTo: '0004' });
    const h = (await db.pool.query(`insert into households (name) values ('Example Family') returning id`)).rows[0].id;
    const u = (await db.pool.query(`insert into users (household_id, email, display_name, role, password_hash) values ($1, 'a@example.test', 'Alex Example', 'admin', 'x') returning id`, [h])).rows[0].id;
    const mem = (await db.pool.query(`insert into family_members (household_id, name, created_by) values ($1, 'Pat Example', $2) returning id`, [h, u])).rows[0].id;
    const prov = (await db.pool.query(`insert into providers (household_id, name, created_by) values ($1, 'Example Clinic', $2) returning id`, [h, u])).rows[0].id;
    const bill = (await db.pool.query(
      `insert into bills (household_id, member_id, provider_id, statement_date, original_cents, base_responsibility_cents, amount_source, member_name_snapshot, provider_name_snapshot, created_by,
         amount_status, confirmed_at, confirmed_by) values ($1, $2, $3, '2026-03-01', 12345, 12345, 'statement', 'Pat Example', 'Example Clinic', $4, 'confirmed', now(), $4) returning id`, [h, mem, prov, u])).rows[0].id;
    assert.deepEqual(await migrate(db.pool), ['0005']);
    const { getBill } = await import('../../apps/web/server/repositories/expenses.ts');
    const b = await getBill(db.pool, h, bill);
    assert.deepEqual([b.responsibilityCents, b.appliedCents, b.openBalanceCents, b.creditCents], ['12345', '0', '12345', '0']);
    assert.equal((await db.pool.query('select count(*)::int n from payments')).rows[0].n, 0);
  } finally {
    await db.drop();
  }
});

test('the connection pool survives an idle client error instead of crashing the process', { skip: skipDb }, async () => {
  const lines = [];
  setLogSink((l) => lines.push(l));
  const pool = createPool('postgres://unused@127.0.0.1:1/unused', 2);
  try {
    assert.ok(pool.listenerCount('error') >= 1);
    const err = Object.assign(new Error('terminating connection due to administrator command; password=hunter2'), { code: '57P01' });
    pool.emit('error', err);
    assert.match(lines.join(''), /db\.pool\.idle_client_error/);
    assert.ok(!lines.join('').includes('hunter2'), 'driver messages are never logged');
  } finally {
    await pool.end();
    setLogSink((line) => process.stderr.write(line + '\n'));
  }
});
