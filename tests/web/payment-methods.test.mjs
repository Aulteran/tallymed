// Saved payment methods and "paid with" on payments. Fabricated nicknames and figures only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import * as handlers from '../../apps/web/server/http.ts';
import { migrate } from '../../apps/web/server/migrate.ts';
import * as pm from '../../apps/web/server/services/payment-methods.ts';
import * as pay from '../../apps/web/server/services/payments.ts';
import { retryStats } from '../../apps/web/server/services/support.ts';
import { csrfFor } from '../../apps/web/server/tokens.ts';
import { freshDatabase, post, skipDb } from './helpers.mjs';
import { setup } from './money-helpers.mjs';

const code = (c) => ({ code: c });
const method = (t, o = {}) => pm.createPaymentMethod(t.db.pool, t.actor, { nickname: 'Example Visa', kind: 'credit_card', lastFour: '0001', ...o }, 'r');
const setPaidWith = (t, paymentId, paidWithId, key = randomUUID()) => pm.setPaidWith(t.db.pool, t.actor, { idempotencyKey: key, paymentId, paidWithId }, 'r');

test('methods: create, validate, rename, archive and restore; only a nickname and last four digits are accepted', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const a = await method(t);
    await assert.rejects(method(t, { nickname: 'example visa', lastFour: '0002' }), code('conflict'), 'active nicknames are unique, ignoring case');
    for (const lastFour of ['4111111111111111', '12345', '12a4', '123'])
      await assert.rejects(method(t, { nickname: `Bad ${lastFour}`, lastFour }), code('invalid_input'), `refuses ${lastFour.length} characters`);
    // A nickname is a label: a pasted card or account number is refused, with or without separators, by validation and by the table itself.
    for (const nickname of ['4111111111111111', '4111 1111 1111 1111', '4111-1111-1111-1111', 'Visa 123456789'])
      await assert.rejects(method(t, { nickname, lastFour: '' }), code('invalid_input'), `refuses ${nickname}`);
    await assert.rejects(t.db.pool.query(`insert into payment_methods (household_id, nickname, kind, created_by) values ($1, '4111 1111 1111 1111', 'other', $2)`, [t.actor.householdId, t.actor.userId]), /check/);
    await method(t, { nickname: 'Visa 4242 and 1234', lastFour: '' });
    await assert.rejects(method(t, { nickname: 'x', kind: 'gift_card' }), code('invalid_input'));
    await assert.rejects(method(t, { nickname: 'x', cvv: '123' }), code('invalid_input'), 'unknown fields are refused');
    const b = await method(t, { nickname: 'Joint Checking', kind: 'bank_account', lastFour: '' });
    const list = await pm.listPaymentMethods(t.db.pool, t.actor);
    assert.deepEqual(list.items.map((m) => [m.nickname, m.lastFour, m.paymentCount, m.netCashCents]), [['Example Visa', '0001', 0, '0'], ['Joint Checking', null, 0, '0'], ['Visa 4242 and 1234', null, 0, '0']]);

    const cur = await pm.getPaymentMethod(t.db.pool, t.actor, a.id);
    await pm.updatePaymentMethod(t.db.pool, t.actor, { id: a.id, version: cur.version, nickname: 'Family Visa', kind: 'credit_card', lastFour: '0009' }, 'r');
    await assert.rejects(pm.updatePaymentMethod(t.db.pool, t.actor, { id: a.id, version: cur.version, nickname: 'Stale', kind: 'credit_card', lastFour: '' }, 'r'), code('stale_version'));
    await assert.rejects(pm.updatePaymentMethod(t.db.pool, t.actor, { id: a.id, version: cur.version + 1, nickname: 'Joint Checking', kind: 'credit_card', lastFour: '' }, 'r'), code('conflict'));

    let v = (await pm.getPaymentMethod(t.db.pool, t.actor, b.id)).version;
    await pm.archivePaymentMethod(t.db.pool, t.actor, { id: b.id, version: v, archived: 'yes' }, 'r');
    assert.equal((await pm.listPaymentMethods(t.db.pool, t.actor)).items.length, 2, 'archived methods with no payments are hidden by default');
    assert.equal((await pm.listPaymentMethods(t.db.pool, t.actor, { archived: true })).items.length, 3);
    // An archived nickname can be reused; restoring it then collides with the active one.
    await method(t, { nickname: 'Joint Checking', kind: 'bank_account' });
    v = (await pm.getPaymentMethod(t.db.pool, t.actor, b.id)).version;
    await assert.rejects(pm.archivePaymentMethod(t.db.pool, t.actor, { id: b.id, version: v, archived: '' }, 'r'), code('conflict'));

    // Methods are never deleted, even by direct SQL.
    await assert.rejects(t.db.pool.query('delete from payment_methods'), /never deleted/);
    await assert.rejects(t.db.pool.query('truncate payment_methods cascade'), /append-only/);
    const audits = (await t.audit('payment_method.created')).concat(await t.audit('payment_method.updated'));
    assert.ok(audits.length >= 3);
    assert.ok(!JSON.stringify(audits).includes('Family Visa') && !JSON.stringify(audits).includes('0009'), 'audit rows hold ids and flags, never nicknames or digits');
  } finally { await t.db.drop(); }
});

test('recording a payment with a method: shown on the payment, list, filter, bill ledger and totals; nothing about the money changes', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const m = await t.member(); const p = await t.provider();
    const visa = await method(t); const bank = await method(t, { nickname: 'Joint Checking', kind: 'bank_account', lastFour: '' });
    const bill = await t.bill({ memberId: m, providerId: p, originalAmount: '200.00' });
    const none = await t.pay1({ amount: '10.00' });
    const a = await t.pay1({ amount: '120.00', billId: bill.id, paidWithId: visa.id });
    const b = await t.pay1({ amount: '40.00', paidWithId: bank.id });
    const detail = await t.payment(a.id);
    assert.deepEqual([detail.payment.paidWithId, detail.payment.paidWithName, detail.payment.paidWithLastFour, detail.payment.paidWithArchived], [visa.id, 'Example Visa', '0001', false]);
    assert.equal((await t.payment(none.id)).payment.paidWithId, null);
    assert.equal((await t.detail(bill.id)).openBalanceCents, '8000', 'applying cash works exactly as before');
    assert.equal((await t.audit('payment.recorded')).find((r) => r.detail.paymentId === a.id).detail.paymentMethodId, visa.id);

    const only = (f) => pay.listPayments(t.db.pool, t.actor, f).then((r) => r.items.map((x) => x.id).sort());
    assert.deepEqual(await only({ paidWith: visa.id }), [a.id]);
    assert.deepEqual(await only({ paidWith: 'none' }), [none.id]);
    assert.equal((await only({})).length, 3);
    await assert.rejects(pay.listPayments(t.db.pool, t.actor, { paidWith: 'not-an-id' }), code('invalid_input'));

    // Bill ledger names the method.
    const ledger = await (await import('../../apps/web/server/repositories/payments.ts')).listBillLedger(t.db.pool, t.actor.householdId, bill.id);
    assert.equal(ledger[0].paidWithName, 'Example Visa');

    // Per-method totals follow the cash summary: refunds subtract, voided counts zero.
    await t.refund(a.id, { allocationId: (await t.payment(a.id)).allocations[0].allocationId, amount: '20.00' });
    await pay.voidPayment(t.db.pool, t.actor, { idempotencyKey: t.key(), paymentId: b.id, voidedOn: '2026-04-02', reason: 'Entered in error' }, 'r');
    const use = await pm.listPaymentMethods(t.db.pool, t.actor);
    const row = (id) => use.items.find((x) => x.id === id);
    assert.deepEqual([row(visa.id).paymentCount, row(visa.id).netCashCents], [1, '10000']);
    assert.deepEqual([row(bank.id).paymentCount, row(bank.id).netCashCents], [1, '0']);
    assert.deepEqual([use.unassigned.paymentCount, use.unassigned.netCashCents], [1, '1000']);
    const cash = await pay.cashSummary(t.db.pool, t.actor);
    assert.equal(BigInt(cash.netCashCents), 10000n + 0n + 1000n, 'method totals add up to the cash summary');
    // Replay of the same key does not record twice; a different method with the same key is refused.
    const key = t.key();
    const body = { idempotencyKey: key, paidOn: '2026-04-03', amount: '5.00', method: 'card', paidWithId: visa.id };
    const r1 = await pay.recordPayment(t.db.pool, t.actor, body, 'r'); const r2 = await pay.recordPayment(t.db.pool, t.actor, body, 'r');
    assert.deepEqual([r1.replayed, r2.replayed, r1.id === r2.id], [false, true, true]);
    await assert.rejects(pay.recordPayment(t.db.pool, t.actor, { ...body, paidWithId: bank.id }, 'r'), code('conflict'));
    assert.equal(await t.count('payment_method_assignments'), 3);
    // Archiving a method that holds cash keeps it listed, so the figures still add up to the cash summary.
    const sum = (u) => u.items.reduce((s, x) => s + BigInt(x.netCashCents), 0n) + BigInt(u.unassigned.netCashCents);
    assert.equal(sum(await pm.listPaymentMethods(t.db.pool, t.actor)), BigInt((await pay.cashSummary(t.db.pool, t.actor)).netCashCents));
    await pm.archivePaymentMethod(t.db.pool, t.actor, { id: visa.id, version: (await pm.getPaymentMethod(t.db.pool, t.actor, visa.id)).version, archived: 'yes' }, 'r');
    const after = await pm.listPaymentMethods(t.db.pool, t.actor);
    assert.ok(after.items.some((x) => x.id === visa.id && x.archivedAt && x.netCashCents === '10500'), 'an archived method holding cash stays listed');
    assert.equal(sum(after), BigInt((await pay.cashSummary(t.db.pool, t.actor)).netCashCents), 'totals still reconcile with an archived method');
    // A crafted filter or current-choice value is refused or ignored, never a database error.
    await assert.rejects(pay.listPayments(t.db.pool, t.actor, { paidWith: 'a'.repeat(36) }), code('invalid_input'));
    assert.deepEqual((await pm.pickPaymentMethods(t.db.pool, t.actor, 'a'.repeat(36))).items.every((x) => x.archivedAt === null), true);

  } finally { await t.db.drop(); }
});

test('setting, changing and clearing paid with: append-only history, audited, refused for archived methods and voided payments', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const visa = await method(t); const hsa = await method(t, { nickname: 'HSA Card', kind: 'hsa_fsa_card', lastFour: '0002' });
    const a = await t.pay1({ amount: '50.00' });
    await setPaidWith(t, a.id, visa.id);
    await setPaidWith(t, a.id, hsa.id);
    assert.equal((await t.payment(a.id)).payment.paidWithId, hsa.id);
    const same = await setPaidWith(t, a.id, hsa.id);
    assert.equal(same.replayed, false);
    assert.equal(await t.count('payment_method_assignments'), 2, 'choosing the current method again writes nothing');
    const key = t.key();
    await setPaidWith(t, a.id, null, key);
    assert.equal((await setPaidWith(t, a.id, null, key)).replayed, true);
    assert.equal((await t.payment(a.id)).payment.paidWithId, null);
    const history = (await t.payment(a.id)).history.filter((h) => h.action === 'payment.paid_with_changed');
    assert.deepEqual(history.map((h) => [h.detail.fromPaymentMethodId, h.detail.toPaymentMethodId]), [[null, visa.id], [visa.id, hsa.id], [hsa.id, null]]);
    // The payment header itself is untouched, and history rows cannot be edited.
    assert.equal((await t.payment(a.id)).payment.amountCents, '5000');
    await assert.rejects(t.db.pool.query(`update payment_method_assignments set method_id = null`), /append-only/);
    await assert.rejects(t.db.pool.query(`delete from payment_method_assignments`), /append-only/);

    // Archived methods: refused for new choices (service and database), but old payments keep them.
    await setPaidWith(t, a.id, visa.id);
    const v = (await pm.getPaymentMethod(t.db.pool, t.actor, visa.id)).version;
    await pm.archivePaymentMethod(t.db.pool, t.actor, { id: visa.id, version: v, archived: 'yes' }, 'r');
    const cur = (await t.payment(a.id)).payment;
    assert.deepEqual([cur.paidWithId, cur.paidWithArchived], [visa.id, true]);
    const b = await t.pay1({ amount: '5.00' });
    await assert.rejects(setPaidWith(t, b.id, visa.id), code('conflict'));
    await assert.rejects(t.pay1({ amount: '5.00', paidWithId: visa.id }), code('conflict'));
    assert.equal(await t.count('payments'), 2, 'a refused paid-with leaves no half-recorded payment');
    await assert.rejects(t.db.pool.query(`insert into payment_method_assignments (id, household_id, payment_id, method_id, created_by) values ($1, $2, $3, $4, $5)`,
      [randomUUID(), t.actor.householdId, b.id, visa.id, t.actor.userId]), /archived/);
    const picks = await pm.pickPaymentMethods(t.db.pool, t.actor, visa.id);
    assert.deepEqual(picks.items.map((x) => x.nickname).sort(), ['Example Visa', 'HSA Card'], 'the select keeps the current archived choice');

    // A voided payment is closed to changes. An unknown method is not found.
    await pay.voidPayment(t.db.pool, t.actor, { idempotencyKey: t.key(), paymentId: b.id, voidedOn: '2026-04-02', reason: 'Entered in error' }, 'r');
    await assert.rejects(setPaidWith(t, b.id, hsa.id), code('conflict'));
    await assert.rejects(setPaidWith(t, a.id, randomUUID()), code('not_found'));
    await assert.rejects(setPaidWith(t, randomUUID(), hsa.id), code('not_found'));
  } finally { await t.db.drop(); }
});

test('another household cannot see, use or change this household\'s methods; read-only roles cannot write', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const mine = await method(t);
    const pay1 = await t.pay1({ amount: '10.00' });
    const h2 = (await t.db.pool.query(`insert into households (name) values ('Other Family') returning id`)).rows[0].id;
    const u2 = (await t.db.pool.query(`insert into users (household_id, email, display_name, role, password_hash) values ($1, 'other@example.test', 'Other Admin', 'admin', 'x') returning id`, [h2])).rows[0].id;
    const outsider = { userId: u2, householdId: h2, role: 'admin', displayName: 'Other Admin', sessionId: randomUUID() };
    await assert.rejects(pm.getPaymentMethod(t.db.pool, outsider, mine.id), code('not_found'));
    assert.equal((await pm.listPaymentMethods(t.db.pool, outsider)).items.length, 0);
    await assert.rejects(pm.setPaidWith(t.db.pool, outsider, { idempotencyKey: t.key(), paymentId: pay1.id, paidWithId: mine.id }, 'r'), code('not_found'));
    const theirs = await pm.createPaymentMethod(t.db.pool, outsider, { nickname: 'Other Card', kind: 'credit_card', lastFour: '' }, 'r');
    await assert.rejects(setPaidWith(t, pay1.id, theirs.id), code('not_found'), 'a method of another household cannot be chosen');
    await assert.rejects(pay.recordPayment(t.db.pool, t.actor, { idempotencyKey: t.key(), paidOn: '2026-04-01', amount: '1.00', method: 'card', paidWithId: theirs.id }, 'r'), code('not_found'));
    await assert.rejects(t.db.pool.query(`insert into payment_method_assignments (id, household_id, payment_id, method_id, created_by) values ($1, $2, $3, $4, $5)`,
      [randomUUID(), t.actor.householdId, pay1.id, theirs.id, t.actor.userId]), /foreign key/);
    await assert.rejects(pm.createPaymentMethod(t.db.pool, { ...t.actor, role: 'nobody' }, { nickname: 'x', kind: 'other', lastFour: '' }, 'r'));

    // HTTP: forged requests are refused, a form post records the method, and a failed form keeps the choice.
    const token = t.cookie.split('=')[1];
    const h = { 'x-csrf-token': csrfFor(token) };
    const body = { idempotencyKey: t.key(), paidOn: '2026-04-02', amount: '5.00', method: 'cash', paidWithId: mine.id };
    assert.equal((await handlers.handleExpenseAction(post('/api/expenses/payments/create', body, { type: 'json' }), t.ctx, 'payments/create')).status, 401);
    assert.equal((await handlers.handleExpenseAction(post('/api/expenses/payments/create', body, { type: 'json', cookie: t.cookie }), t.ctx, 'payments/create')).status, 403);
    const ok = await handlers.handleExpenseAction(post('/api/expenses/payments/create', body, { type: 'json', cookie: t.cookie, headers: h }), t.ctx, 'payments/create');
    assert.equal(ok.status, 201);
    assert.equal((await t.payment((await ok.json()).id)).payment.paidWithId, mine.id);
    const created = await handlers.handleExpenseAction(post('/api/expenses/payment-methods/create', { nickname: 'Form Card', kind: 'debit_card', lastFour: '0042' }, { type: 'json', cookie: t.cookie, headers: h }), t.ctx, 'payment-methods/create');
    assert.equal(created.status, 201);
    const set = await handlers.handleExpenseAction(post('/api/expenses/payments/paid-with', { idempotencyKey: t.key(), paymentId: pay1.id, paidWithId: (await created.json()).id }, { type: 'json', cookie: t.cookie, headers: h }), t.ctx, 'payments/paid-with');
    assert.equal(set.status, 200);
  } finally { await t.db.drop(); }
});

test('archiving races recording: a payment never ends up linked to a method that was archived first, and no lock cycles occur', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    retryStats.lockConflicts = 0;
    for (let i = 0; i < 12; i += 1) {
      const m = await method(t, { nickname: `Race Card ${i}`, lastFour: '' });
      const v = (await pm.getPaymentMethod(t.db.pool, t.actor, m.id)).version;
      const [rec, arch] = await Promise.allSettled([
        t.pay1({ amount: '1.00', paidWithId: m.id }),
        pm.archivePaymentMethod(t.db.pool, t.actor, { id: m.id, version: v, archived: 'yes' }, 'r'),
      ]);
      for (const r of [rec, arch]) if (r.status === 'rejected') assert.ok(['conflict', 'stale_version'].includes(r.reason.code), `unexpected ${r.reason?.code ?? r.reason}`);
      assert.equal(arch.status, 'fulfilled', 'the archive always succeeds');
      // The recorded payment (if any) was linked before the archive committed: the link and the archived flag agree with a serial order.
      const rows = (await t.db.pool.query(`select 1 from payment_method_assignments where method_id = $1`, [m.id])).rows;
      assert.ok(rows.length === 0 ? rec.status === 'rejected' : rec.status === 'fulfilled', 'a payment exists exactly when its recording succeeded');
    }
    // Concurrent changes to one payment's method serialize under the payment lock.
    const m1 = await method(t, { nickname: 'Swap One', lastFour: '' }); const m2 = await method(t, { nickname: 'Swap Two', lastFour: '' });
    const p = await t.pay1({ amount: '3.00' });
    await Promise.all([setPaidWith(t, p.id, m1.id), setPaidWith(t, p.id, m2.id), setPaidWith(t, p.id, m1.id)]);
    const last = (await t.db.pool.query(`select method_id from payment_method_assignments where payment_id = $1 order by seq desc limit 1`, [p.id])).rows[0].method_id;
    assert.equal((await t.payment(p.id)).payment.paidWithId, last);
    assert.equal(retryStats.lockConflicts, 0, 'no lock-cycle retries');
  } finally { await t.db.drop(); }
});

test('upgrade: migration 0015 leaves earlier payments exactly as they were, with no method recorded', { skip: skipDb }, async () => {
  const db = await freshDatabase({ migrateAll: false });
  try {
    await migrate(db.pool, { upTo: '0014' });
    const h = (await db.pool.query(`insert into households (name) values ('Example Family') returning id`)).rows[0].id;
    const u = (await db.pool.query(`insert into users (household_id, email, display_name, role, password_hash) values ($1, 'a@example.test', 'Alex Example', 'admin', 'x') returning id`, [h])).rows[0].id;
    await db.pool.query(`insert into payments (household_id, paid_on, amount_cents, method, created_by) values ($1, '2026-03-01', 12345, 'card', $2)`, [h, u]);
    const before = (await db.pool.query('select * from payments')).rows;
    assert.deepEqual(await migrate(db.pool), ['0015', '0016', '0017']);
    assert.deepEqual((await db.pool.query('select * from payments')).rows, before);
    const { listPayments, cashTotals } = await import('../../apps/web/server/repositories/payments.ts');
    const page = await listPayments(db.pool, h, { limit: 25 });
    assert.deepEqual([page.items.length, page.items[0].amountCents, page.items[0].paidWithId], [1, '12345', null]);
    assert.equal((await cashTotals(db.pool, h)).netCashCents, '12345');
    // The restricted assistant role gets nothing on the new tables.
    const role = `tallymed_mcp_pm_${Math.random().toString(16).slice(2, 8)}`;
    await db.pool.query(`create role ${role} login password 'x-test-password'`);
    try {
      await db.pool.query(`select tallymed_apply_mcp_grants($1)`, [role]);
      const priv = (await db.pool.query(`select has_table_privilege($1, 'payment_methods', 'SELECT') as m, has_table_privilege($1, 'payment_method_assignments', 'SELECT') as a`, [role])).rows[0];
      assert.deepEqual(priv, { m: false, a: false });
    } finally {
      await db.pool.query(`select tallymed_apply_mcp_grants($1)`, [role]).catch(() => {});
      await db.pool.query(`drop owned by ${role}`).catch(() => {});
      await db.pool.query(`drop role if exists ${role}`);
    }
  } finally { await db.drop(); }
});
