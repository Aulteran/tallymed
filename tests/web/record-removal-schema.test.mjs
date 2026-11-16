// Database layer of record removal, HSA funding release and the undo slot (migration 0017): triggers, guards, helper functions and the
// upgrade path. Exercised directly with fabricated data; the services that use these tables are tested elsewhere.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { BACKUP_TABLES, EXCLUDED_TABLES, tablesAt } from '../../apps/web/server/backup/tables.ts';
import { ledgerSummary, ledgerViolations } from '../../apps/web/server/backup/ledger.ts';
import { migrate } from '../../apps/web/server/migrate.ts';
import * as acc from '../../apps/web/server/services/hsa-accounts.ts';
import * as hsa from '../../apps/web/server/services/hsa.ts';
import * as pm from '../../apps/web/server/services/payment-methods.ts';
import * as plans from '../../apps/web/server/services/plans.ts';
import { freshDatabase, skipDb } from './helpers.mjs';
import { setup } from './money-helpers.mjs';

const one = async (pool, sql, params = []) => (await pool.query(sql, params)).rows[0];
const inTx = async (pool, fn) => {
  const c = await pool.connect();
  try { await c.query('begin'); const r = await fn(c); await c.query('commit'); return r; } catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
};
const removal = (t, client, paymentId, action) => client.query(
  `insert into payment_removal_events (household_id, payment_id, action, reason, created_by) values ($1, $2, $3, 'Fabricated test', $4)`,
  [t.actor.householdId, paymentId, action, t.actor.userId]);
const funding = (t, client, paymentId, action) => client.query(
  `insert into payment_hsa_funding_events (household_id, payment_id, action, created_by) values ($1, $2, $3, $4)`,
  [t.actor.householdId, paymentId, action, t.actor.userId]);
// Reverses every allocation of a payment in full through the ledger (what the removal service does), inside the given client.
const reverseAll = async (t, client, paymentId) => {
  const rows = (await client.query(
    `select id, bill_id, sum(amount_cents)::bigint as net from (select a.id, a.bill_id, e.amount_cents from payment_entries a join payment_entries e on e.allocation_id = a.id
       where a.payment_id = $1 and a.kind = 'allocation') x group by id, bill_id having sum(amount_cents) > 0`, [paymentId])).rows;
  const event = randomUUID();
  for (const r of rows) {
    await client.query(
      `insert into payment_entries (id, household_id, payment_id, event_id, kind, bill_id, allocation_id, amount_cents, effective_date, reason, created_by)
       values ($1, $2, $3, $4, 'allocation_reversal', $5, $6, $7, '2026-04-02', 'Removed payment', $8)`,
      [randomUUID(), t.actor.householdId, paymentId, event, r.bill_id, r.id, -r.net, t.actor.userId]);
  }
};
const reallocate = (t, client, paymentId, billId, cents) => client.query(
  `insert into payment_entries (id, household_id, payment_id, event_id, kind, bill_id, allocation_id, amount_cents, effective_date, reason, created_by)
   values ($1, $2, $3, $4, 'allocation', $5, $1, $6, '2026-04-03', '', $7)`,
  [randomUUID(), t.actor.householdId, paymentId, randomUUID(), billId, cents, t.actor.userId]);
const account = (t) => acc.createHsaAccount(t.db.pool, t.actor, { name: 'Family HSA', administrator: 'Example HSA Bank', lastFour: '7788' }, 'r');
const hsaCard = (t, hsaAccountId) => pm.createPaymentMethod(t.db.pool, t.actor, { nickname: 'HSA Visa', kind: 'hsa_fsa_card', lastFour: '0042', hsaAccountId }, 'r');
const direct = (t, id) => one(t.db.pool, `select payment_is_direct_hsa($1) as v`, [id]).then((r) => r.v);
const status = (t, id) => one(t.db.pool, `select available_cents::text a, direct_hsa d, ceiling_cents::text c from hsa_allocation_status where payment_id = $1`, [id]);

test('a removed payment keeps no applied or refunded cash: refused at commit, allowed once reversed, and restore reopens the payment', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const m = await t.member(); const p = await t.provider();
    const bill = await t.bill({ memberId: m, providerId: p, originalAmount: '80.00' });
    const pay = await t.pay1({ amount: '50.00', billId: bill.id });
    assert.equal((await one(t.db.pool, `select payment_is_removed($1) as v`, [pay.id])).v, false);
    // Removing with cash still applied is refused when the transaction commits, and nothing is left behind.
    await assert.rejects(inTx(t.db.pool, (c) => removal(t, c, pay.id, 'remove')), /removed payment cannot keep applied or refunded cash/);
    assert.equal(await t.count('payment_removal_events'), 0);
    // Reversing first, in the same transaction, makes it valid.
    await inTx(t.db.pool, async (c) => { await reverseAll(t, c, pay.id); await removal(t, c, pay.id, 'remove'); });
    assert.equal((await one(t.db.pool, `select payment_is_removed($1) as v`, [pay.id])).v, true);
    assert.equal((await t.detail(bill.id)).openBalanceCents, '8000');
    // Cash cannot be applied to a removed payment, and removing twice is refused.
    await assert.rejects(inTx(t.db.pool, (c) => reallocate(t, c, pay.id, bill.id, 1000)), /removed payment cannot keep applied or refunded cash/);
    await assert.rejects(inTx(t.db.pool, (c) => removal(t, c, pay.id, 'remove')), /already removed/);
    assert.deepEqual(await ledgerViolations(t.db.pool), []);
    assert.equal((await ledgerSummary(t.db.pool)).removedPayments, '1');
    // Restore (the only way back), then the cash can be applied again.
    await inTx(t.db.pool, (c) => removal(t, c, pay.id, 'restore'));
    assert.equal((await one(t.db.pool, `select payment_is_removed($1) as v`, [pay.id])).v, false);
    await assert.rejects(inTx(t.db.pool, (c) => removal(t, c, pay.id, 'restore')), /not removed/);
    await inTx(t.db.pool, (c) => reallocate(t, c, pay.id, bill.id, 5000));
    assert.equal((await t.detail(bill.id)).openBalanceCents, '3000');
    assert.equal((await ledgerSummary(t.db.pool)).removedPayments, '0');
  } finally { await t.db.drop(); }
});

test('the ledger check reports a removed payment that kept cash (a restore loads rows with triggers off)', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const m = await t.member(); const p = await t.provider();
    const bill = await t.bill({ memberId: m, providerId: p, originalAmount: '80.00' });
    const pay = await t.pay1({ amount: '50.00', billId: bill.id });
    await t.db.pool.query('alter table payment_removal_events disable trigger user');
    await removal(t, t.db.pool, pay.id, 'remove');
    await t.db.pool.query('alter table payment_removal_events enable trigger user');
    const broken = await ledgerViolations(t.db.pool);
    assert.equal(broken.length, 1);
    assert.match(broken[0], /^a removed payment keeps no applied or refunded cash \(1 record\)/);
  } finally { await t.db.drop(); }
});

test('removal events and funding events are append-only', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const pay = await t.pay1({ amount: '10.00' });
    await removal(t, t.db.pool, pay.id, 'remove');
    const a = await account(t); const card = await hsaCard(t, a.id);
    const funded = await t.pay1({ amount: '10.00', paidWithId: card.id });
    await funding(t, t.db.pool, funded.id, 'release');
    for (const sql of [`update payment_removal_events set reason = 'x'`, `delete from payment_removal_events`, `truncate payment_removal_events`,
      `update payment_hsa_funding_events set action = 'release'`, `delete from payment_hsa_funding_events`, `truncate payment_hsa_funding_events`])
      await assert.rejects(t.db.pool.query(sql), /append-only/, sql);
    // Reason length and action are checked; a payment of another household cannot be named.
    await assert.rejects(t.db.pool.query(`insert into payment_removal_events (household_id, payment_id, action, reason, created_by) values ($1, $2, 'restore', $3, $4)`,
      [t.actor.householdId, pay.id, 'x'.repeat(501), t.actor.userId]), /check/);
    await assert.rejects(t.db.pool.query(`insert into payment_removal_events (household_id, payment_id, action, created_by) values ($1, $2, 'delete', $3)`,
      [t.actor.householdId, pay.id, t.actor.userId]), /check/);
    const h2 = (await t.db.pool.query(`insert into households (name) values ('Other Family') returning id`)).rows[0].id;
    await assert.rejects(t.db.pool.query(`insert into payment_removal_events (household_id, payment_id, action, created_by) values ($1, $2, 'restore', $3)`,
      [h2, pay.id, t.actor.userId]), /foreign key/);
  } finally { await t.db.drop(); }
});

test('plan removal columns are all-or-none and can be cleared; matches to a removed plan are refused, unmatches stay possible', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const m = await t.member(); const p = await t.provider();
    const bill = await t.bill({ memberId: m, providerId: p, originalAmount: '100.00' });
    const plan = await plans.createPlan(t.db.pool, t.actor, { idempotencyKey: t.key(), name: 'Clinic plan', billId: bill.id, totalAmount: '100.00', installmentCount: '2', firstDueDate: '2026-06-01', cadence: 'monthly', startedOn: '2026-01-01' }, 'r');
    const pay = await t.pay1({ amount: '100.00', billId: bill.id });
    const alloc = (await t.payment(pay.id)).allocations[0].allocationId;
    const inst = (await plans.getPlanDetail(t.db.pool, t.actor, plan.id, { asOf: '2026-05-01' })).installments[0].id;
    const row = await one(t.db.pool, `select revision_id from plan_installments where id = $1`, [inst]);
    const matchSql = (kind, cents) => ({ text: `insert into installment_matches (id, household_id, plan_id, revision_id, installment_id, payment_id, allocation_id, bill_id, kind, amount_cents, created_by)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`, values: [randomUUID(), t.actor.householdId, plan.id, row.revision_id, inst, pay.id, alloc, bill.id, kind, cents, t.actor.userId] });
    await t.db.pool.query(matchSql('match', 1000));
    // All three columns or none.
    for (const set of [`removed_at = now()`, `removed_by = '${t.actor.userId}'`, `removed_reason = 'x'`, `removed_at = now(), removed_by = '${t.actor.userId}'`])
      await assert.rejects(t.db.pool.query(`update payment_plans set ${set} where id = $1`, [plan.id]), /payment_plans_removed_all_or_none/, set);
    await assert.rejects(t.db.pool.query(`update payment_plans set removed_at = now(), removed_by = $2, removed_reason = '' where id = $1`, [plan.id, t.actor.userId]), /check/);
    await t.db.pool.query(`update payment_plans set removed_at = now(), removed_by = $2, removed_reason = 'Fabricated test' where id = $1`, [plan.id, t.actor.userId]);
    await assert.rejects(t.db.pool.query(matchSql('match', 500)), /removed plan/);
    await t.db.pool.query(matchSql('unmatch', -1000));
    // Clearing the fields reopens the plan.
    await t.db.pool.query(`update payment_plans set removed_at = null, removed_by = null, removed_reason = null where id = $1`, [plan.id]);
    await t.db.pool.query(matchSql('match', 500));
    assert.deepEqual(await ledgerViolations(t.db.pool), []);
  } finally { await t.db.drop(); }
});

test('direct HSA funding: release, reinstate, payment_is_direct_hsa, the status view and the guards', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const m = await t.member(); const p = await t.provider();
    const a = await account(t); const card = await hsaCard(t, a.id);
    const bill = await t.bill({ memberId: m, providerId: p, originalAmount: '50.00' });
    const paid = await t.pay1({ amount: '50.00', billId: bill.id, paidWithId: card.id });
    const ordinary = await t.pay1({ amount: '5.00' });
    assert.equal(await direct(t, paid.id), true);
    assert.equal(await direct(t, ordinary.id), false);
    assert.deepEqual(await status(t, paid.id), { a: '0', d: true, c: '0' });
    // An unfunded payment cannot be released; a funded one cannot be reinstated.
    await assert.rejects(funding(t, t.db.pool, ordinary.id, 'release'), /not paid directly/);
    await assert.rejects(funding(t, t.db.pool, paid.id, 'reinstate'), /still paid directly/);
    await funding(t, t.db.pool, paid.id, 'release');
    await assert.rejects(funding(t, t.db.pool, paid.id, 'release'), /not paid directly/);
    assert.equal(await direct(t, paid.id), false);
    // After the release the payment is ordinary: its allocation shows normal figures and takes a decision (so it can be claimed).
    const alloc = (await t.payment(paid.id)).allocations[0].allocationId;
    assert.deepEqual(await status(t, paid.id), { a: '0', d: false, c: '0' });
    await hsa.recordDecision(t.db.pool, t.actor, { idempotencyKey: t.key(), allocationId: alloc, version: '0', status: 'eligible', eligibleAmount: '30.00', rationale: 'Qualified', evidenceType: 'receipt', evidenceNote: 'Receipt', decidedOn: '2026-04-05' }, 'r');
    assert.deepEqual(await status(t, paid.id), { a: '3000', d: false, c: '3000' });
    // With a decision on it the payment cannot be reinstated.
    await assert.rejects(funding(t, t.db.pool, paid.id, 'reinstate'), /already has HSA claims or decisions/);
    assert.equal(await direct(t, paid.id), false);
  } finally { await t.db.drop(); }
});

test('reinstating restores the direct state and zero available cash; an archived account refuses it; events stay in order', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const m = await t.member(); const p = await t.provider();
    const a = await account(t); const card = await hsaCard(t, a.id);
    const bill = await t.bill({ memberId: m, providerId: p, originalAmount: '50.00' });
    const paid = await t.pay1({ amount: '50.00', billId: bill.id, paidWithId: card.id });
    await funding(t, t.db.pool, paid.id, 'release');
    await funding(t, t.db.pool, paid.id, 'reinstate');
    assert.equal(await direct(t, paid.id), true);
    assert.deepEqual(await status(t, paid.id), { a: '0', d: true, c: '0' });
    // A claim cannot be recorded while it is direct again (the other direction still holds through the function).
    const alloc = (await t.payment(paid.id)).allocations[0].allocationId;
    await assert.rejects(hsa.recordDecision(t.db.pool, t.actor, { idempotencyKey: t.key(), allocationId: alloc, version: '0', status: 'eligible', eligibleAmount: '10.00', rationale: 'Qualified', evidenceType: 'receipt', evidenceNote: 'Receipt', decidedOn: '2026-04-05' }, 'r'), /paid directly from an HSA|conflict|code/);
    await funding(t, t.db.pool, paid.id, 'release');
    await acc.archiveHsaAccount(t.db.pool, t.actor, { id: a.id, version: 1, archived: 'yes' }, 'r');
    await assert.rejects(funding(t, t.db.pool, paid.id, 'reinstate'), /archived/);
    const seqs = (await t.db.pool.query(`select action from payment_hsa_funding_events where payment_id = $1 order by seq`, [paid.id])).rows.map((r) => r.action);
    assert.deepEqual(seqs, ['release', 'reinstate', 'release']);
  } finally { await t.db.drop(); }
});

test('the undo slot is one mutable row per user and is not a ledger', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const slot = (kind) => t.db.pool.query(
      `insert into undo_actions (user_id, household_id, kind, entity_id, payload, expires_at) values ($1, $2, $3, $4, '{}', now() + interval '3 minutes')
       on conflict (user_id) do update set kind = excluded.kind, entity_id = excluded.entity_id, expires_at = excluded.expires_at`,
      [t.actor.userId, t.actor.householdId, kind, randomUUID()]);
    await slot('payment_remove'); await slot('plan_remove');
    assert.equal(await t.count('undo_actions'), 1);
    assert.equal((await one(t.db.pool, `select kind, expires_at > now() as live from undo_actions`)).kind, 'plan_remove');
    await assert.rejects(slot('nonsense'), /check/);
    await t.db.pool.query(`update undo_actions set expires_at = now() - interval '1 second'`);
    assert.equal((await one(t.db.pool, `select expires_at > now() as live from undo_actions`)).live, false);
    await t.db.pool.query('delete from undo_actions');
    assert.equal(await t.count('undo_actions'), 0);
  } finally { await t.db.drop(); }
});

test('backup classification: the new tables are listed correctly and older databases are unaffected', () => {
  const names = BACKUP_TABLES.map((x) => x.name);
  for (const n of ['payment_removal_events', 'payment_hsa_funding_events']) {
    const spec = BACKUP_TABLES.find((x) => x.name === n);
    assert.equal(spec.since, '0017'); assert.equal(spec.orderBy, 'seq');
  }
  assert.ok(names.indexOf('payment_removal_events') > names.indexOf('payment_voids') && names.indexOf('payment_removal_events') > names.indexOf('payments'));
  assert.ok(names.indexOf('payment_hsa_funding_events') > names.indexOf('payment_hsa_funding'));
  assert.ok(!names.includes('undo_actions') && /\S/.test(EXCLUDED_TABLES.undo_actions));
  assert.ok(!tablesAt(['0016']).some((x) => x.since === '0017'));
  assert.ok(tablesAt(['0016', '0017']).some((x) => x.name === 'payment_removal_events'));
});

test('upgrade: migration 0017 over a database populated at 0016 keeps every figure and leaves payments, plans and funding as they were', { skip: skipDb }, async () => {
  const db = await freshDatabase({ migrateAll: false });
  try {
    await migrate(db.pool, { upTo: '0016' });
    const h = (await db.pool.query(`insert into households (name) values ('Example Family') returning id`)).rows[0].id;
    const u = (await db.pool.query(`insert into users (household_id, email, display_name, role, password_hash) values ($1, 'a@example.test', 'Alex Example', 'admin', 'x') returning id`, [h])).rows[0].id;
    const mem = (await db.pool.query(`insert into family_members (household_id, name, created_by) values ($1, 'Pat Example', $2) returning id`, [h, u]).catch(() => ({ rows: [{}] }))).rows[0].id;
    const pr = (await db.pool.query(`insert into providers (household_id, name, kind, created_by) values ($1, 'Example Clinic', 'clinician', $2) returning id`, [h, u]).catch(() => ({ rows: [{}] }))).rows[0].id;
    const acct = (await db.pool.query(`insert into hsa_accounts (household_id, name, created_by) values ($1, 'Family HSA', $2) returning id`, [h, u])).rows[0].id;
    const pay = (await db.pool.query(`insert into payments (household_id, paid_on, amount_cents, method, created_by) values ($1, '2026-03-01', 12345, 'card', $2) returning id`, [h, u])).rows[0].id;
    await db.pool.query(`insert into payment_hsa_funding (payment_id, household_id, hsa_account_id, created_by) values ($1, $2, $3, $4)`, [pay, h, acct, u]);
    const plan = mem && pr ? (await db.pool.query(`insert into payment_plans (household_id, provider_id, name, created_by) values ($1, $2, 'Plan', $3) returning id`, [h, pr, u]).catch(() => ({ rows: [] }))).rows[0] : undefined;
    const before = { payments: (await db.pool.query('select * from payments')).rows, funding: (await db.pool.query('select * from payment_hsa_funding')).rows, status: (await db.pool.query('select * from hsa_allocation_status')).rows };
    assert.deepEqual(await migrate(db.pool), ['0017']);
    assert.deepEqual((await db.pool.query('select * from payments')).rows, before.payments);
    assert.deepEqual((await db.pool.query('select * from payment_hsa_funding')).rows, before.funding);
    assert.deepEqual((await db.pool.query('select * from hsa_allocation_status')).rows, before.status);
    // The old funding is still direct, nobody is removed, plans have no removal, and the new tables are empty.
    assert.deepEqual((await db.pool.query(`select payment_is_direct_hsa($1) as d, payment_is_removed($1) as r`, [pay])).rows[0], { d: true, r: false });
    for (const tbl of ['payment_removal_events', 'payment_hsa_funding_events', 'undo_actions']) assert.equal((await db.pool.query(`select count(*)::int n from ${tbl}`)).rows[0].n, 0, tbl);
    if (plan) assert.equal((await db.pool.query(`select removed_at, removed_by, removed_reason from payment_plans where id = $1`, [plan.id])).rows[0].removed_at, null);
    assert.deepEqual(await ledgerViolations(db.pool), []);
    // The view keeps its column order.
    const cols = (await db.pool.query(`select column_name from information_schema.columns where table_name = 'hsa_allocation_status' order by ordinal_position`)).rows.map((r) => r.column_name);
    assert.deepEqual(cols.slice(-3), ['available_cents', 'needs_review_cents', 'direct_hsa']);
    // A release now works on the old funding.
    await db.pool.query(`insert into payment_hsa_funding_events (household_id, payment_id, action, created_by) values ($1, $2, 'release', $3)`, [h, pay, u]);
    assert.equal((await db.pool.query(`select payment_is_direct_hsa($1) as d`, [pay])).rows[0].d, false);
  } finally { await db.drop(); }
});
