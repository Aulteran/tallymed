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
import * as pay from '../../apps/web/server/services/payments.ts';
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

// Raw-SQL view of the money the application reports, valid on the 0016 schema and on later ones (the services' own reads need 0017's
// removal functions). The same function runs before and after the upgrade, and the services' answers after it are compared with it.
async function legacyFigures(pool) {
  const rows = async (sql) => (await pool.query(sql)).rows;
  const payments = await rows(`select p.id, p.amount_cents::text as amount, p.method,
      coalesce((select sum(e.amount_cents) from payment_entries e where e.payment_id = p.id and e.bill_id is not null), 0)::text as applied,
      (-coalesce((select sum(e.amount_cents) from payment_entries e where e.payment_id = p.id and e.kind in ('refund', 'unapplied_refund', 'refund_reversal')), 0))::text as refunded,
      exists (select 1 from payment_voids v where v.payment_id = p.id) as voided,
      (select a.method_id from payment_method_assignments a where a.payment_id = p.id order by a.seq desc limit 1) as method_id,
      (select f.hsa_account_id from payment_hsa_funding f where f.payment_id = p.id) as account_id
    from payments p order by p.id`);
  const shaped = payments.map((x) => {
    const net = x.voided ? 0n : BigInt(x.amount) - BigInt(x.refunded);
    return { ...x, unapplied: (x.voided ? 0n : BigInt(x.amount) - BigInt(x.refunded) - BigInt(x.applied)).toString(), net: net.toString() };
  });
  const sumBy = (key) => {
    const m = new Map();
    for (const x of shaped) { const k = x[key] ?? null; const c = m.get(k) ?? { count: 0, net: 0n }; c.count++; c.net += BigInt(x.net); m.set(k, c); }
    return [...m].map(([k, c]) => [k, c.count, c.net.toString()]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  };
  const hsaStatus = await rows(`select allocation_id, payment_id, net_cents::text n, decision_status, ceiling_cents::text c, pending_cents::text pe, received_cents::text r,
      available_cents::text a, needs_review_cents::text nr, direct_hsa from hsa_allocation_status order by allocation_id`);
  const plan = await rows(`select p.id, p.status, (select coalesce(sum(m.amount_cents), 0)::text from installment_matches m where m.plan_id = p.id) as matched,
      (select array_agg(coalesce((select sum(m.amount_cents) from installment_matches m where m.installment_id = i.id), 0)::text order by i.seq) from plan_installments i where i.plan_id = p.id) as per_installment
    from payment_plans p order by p.id`);
  return {
    cash: { count: shaped.length, unapplied: shaped.reduce((t, x) => t + BigInt(x.unapplied), 0n).toString(), net: shaped.reduce((t, x) => t + BigInt(x.net), 0n).toString() },
    payments: shaped, methods: sumBy('method_id'), accounts: sumBy('account_id'), hsaStatus, plan,
    bills: await rows(`select b.id, (b.base_responsibility_cents + coalesce((select sum(a.amount_cents) from bill_adjustments a where a.bill_id = b.id), 0)
        - coalesce((select sum(e.amount_cents) from payment_entries e where e.bill_id = b.id), 0))::text as open_cents from bills b order by b.id`),
    ledger: await ledgerSummary(pool),
  };
}

test('upgrade: a database populated at 0016 (plan with a match, refund, HSA decision and claim, direct HSA payment, adjustment, void) reports the same figures at 0018', { skip: skipDb }, async () => {
  const db = await freshDatabase({ migrateAll: false });
  try {
    await migrate(db.pool, { upTo: '0016' });
    const q = async (sql, p = []) => (await db.pool.query(sql, p)).rows[0];
    const h = (await q(`insert into households (name) values ('Example Family') returning id`)).id;
    const u = (await q(`insert into users (household_id, email, display_name, role, password_hash) values ($1, 'a@example.test', 'Alex Example', 'admin', 'x') returning id`, [h])).id;
    const mem = (await q(`insert into family_members (household_id, name, created_by) values ($1, 'Pat Example', $2) returning id`, [h, u])).id;
    const pr = (await q(`insert into providers (household_id, name, kind, created_by) values ($1, 'Example Clinic', 'clinician', $2) returning id`, [h, u])).id;
    const mkBill = (cents, date) => q(
      `insert into bills (household_id, member_id, provider_id, statement_date, original_cents, base_responsibility_cents, amount_status, amount_source, member_name_snapshot, provider_name_snapshot, confirmed_at, confirmed_by, created_by)
       values ($1, $2, $3, $4, $5, $5, 'confirmed', 'statement', 'Pat Example', 'Example Clinic', now(), $6, $6) returning id`, [h, mem, pr, date, cents, u]).then((r) => r.id);
    const [billA, billC] = [await mkBill(30000, '2026-01-02'), await mkBill(10000, '2026-01-03')];
    // An insurer adjustment lowers what the household owes on the first bill.
    await q(`insert into bill_adjustments (household_id, bill_id, amount_cents, category, effective_date, reason, source, created_by) values ($1, $2, -2000, 'insurer_adjustment', '2026-03-10', 'EOB', 'eob', $3)`, [h, billA, u]);
    // Saved payment methods: an ordinary card and an HSA card linked to an HSA account.
    const acct = (await q(`insert into hsa_accounts (household_id, name, administrator, created_by) values ($1, 'Family HSA', 'Example HSA Bank', $2) returning id`, [h, u])).id;
    const card = (await q(`insert into payment_methods (household_id, nickname, kind, last_four, created_by) values ($1, 'Everyday Visa', 'credit_card', '1111', $2) returning id`, [h, u])).id;
    const hsaCard = (await q(`insert into payment_methods (household_id, nickname, kind, last_four, created_by) values ($1, 'HSA Visa', 'hsa_fsa_card', '2222', $2) returning id`, [h, u])).id;
    await q(`insert into payment_method_hsa_links (method_id, household_id, hsa_account_id, created_by) values ($1, $2, $3, $4)`, [hsaCard, h, acct, u]);
    const mkPay = (cents, date) => q(`insert into payments (household_id, paid_on, amount_cents, method, created_by) values ($1, $2, $3, 'card', $4) returning id`, [h, date, cents, u]).then((r) => r.id);
    const assign = (payment, method) => q(`insert into payment_method_assignments (id, household_id, payment_id, method_id, created_by) values (gen_random_uuid(), $1, $2, $3, $4)`, [h, payment, method, u]);
    const allocate = async (payment, bill, cents, date) => {
      const id = randomUUID();
      await q(`insert into payment_entries (id, household_id, payment_id, event_id, kind, bill_id, allocation_id, amount_cents, effective_date, created_by) values ($1, $2, $3, $4, 'allocation', $5, $1, $6, $7, $8)`, [id, h, payment, randomUUID(), bill, cents, date, u]);
      return id;
    };
    // P1: 150.00 paid with the card, 120.00 applied to the first bill, then 20.00 refunded.
    const p1 = await mkPay(15000, '2026-04-01');
    await assign(p1, card);
    const al1 = await allocate(p1, billA, 12000, '2026-04-01');
    await q(`insert into payment_entries (id, household_id, payment_id, event_id, kind, bill_id, allocation_id, amount_cents, effective_date, reason, created_by) values (gen_random_uuid(), $1, $2, gen_random_uuid(), 'refund', $3, $4, -2000, '2026-05-01', 'Provider refund', $5)`, [h, p1, billA, al1, u]);
    // P2: 60.00 paid directly from the HSA through its card, applied to the second bill.
    const p2 = await mkPay(6000, '2026-04-02');
    await assign(p2, hsaCard);
    await q(`insert into payment_hsa_funding (payment_id, household_id, hsa_account_id, created_by) values ($1, $2, $3, $4)`, [p2, h, acct, u]);
    await allocate(p2, billC, 6000, '2026-04-02');
    // P3: recorded in error and voided.
    const p3 = await mkPay(3000, '2026-04-03');
    await q(`insert into payment_voids (payment_id, household_id, reason, voided_on, created_by) values ($1, $2, 'Recorded twice', '2026-04-04', $3)`, [p3, h, u]);
    // A three-installment plan with 100.00 of P1's cash matched to the first installment.
    const plan = (await q(`insert into payment_plans (household_id, name, started_on, created_by) values ($1, 'Clinic plan', '2026-01-01', $2) returning id`, [h, u])).id;
    await q(`insert into payment_plan_bills (household_id, plan_id, bill_id) values ($1, $2, $3)`, [h, plan, billA]);
    const rev = randomUUID(); const insts = [randomUUID(), randomUUID(), randomUUID()];
    await inTx(db.pool, async (c) => {
      await c.query(`insert into plan_revisions (id, household_id, plan_id, revision_no, total_cents, cadence, reason, created_by) values ($1, $2, $3, 1, 30000, 'monthly', 'Initial schedule', $4)`, [rev, h, plan, u]);
      for (const [i, id] of insts.entries()) {
        await c.query(`insert into plan_installments (id, household_id, plan_id, revision_id, seq, due_date, amount_cents) values ($1, $2, $3, $4, $5, $6, 10000)`, [id, h, plan, rev, i + 1, `2026-0${6 + i}-01`]);
      }
      await c.query(`insert into installment_matches (id, household_id, plan_id, revision_id, installment_id, payment_id, allocation_id, bill_id, kind, amount_cents, created_by)
                     values ($1, $2, $3, $4, $5, $6, $7, $8, 'match', 10000, $9)`, [randomUUID(), h, plan, rev, insts[0], p1, al1, billA, u]);
    });
    // An HSA decision on P1's remaining cash (80.00 eligible of 100.00), a 50.00 claim and a 20.00 receipt against it.
    await q(`insert into hsa_eligibility_decisions (id, household_id, payment_id, allocation_id, bill_id, status, eligible_cents, rationale, evidence_type, evidence_note, decided_on, created_by)
             values (gen_random_uuid(), $1, $2, $3, $4, 'eligible', 8000, 'Qualified expense', 'eob', 'EOB 1', '2026-05-02', $5)`, [h, p1, al1, billA, u]);
    const claim = randomUUID(); const line = randomUUID(); const receipt = randomUUID();
    await inTx(db.pool, async (c) => {
      await c.query(`insert into hsa_claims (id, household_id, submitted_on, administrator, created_by) values ($1, $2, '2026-05-03', 'Example HSA Bank', $3)`, [claim, h, u]);
      await c.query(`insert into hsa_entries (id, household_id, payment_id, allocation_id, bill_id, event_id, kind, claim_id, line_id, amount_cents, effective_date, created_by)
                     values ($1, $2, $3, $4, $5, gen_random_uuid(), 'reserve', $6, $1, 5000, '2026-05-03', $7)`, [line, h, p1, al1, billA, claim, u]);
      await c.query(`insert into hsa_receipts (id, household_id, received_on, amount_cents, origin, source, created_by) values ($1, $2, '2026-05-10', 2000, 'claim', 'administrator_transfer', $3)`, [receipt, h, u]);
      await c.query(`insert into hsa_entries (id, household_id, payment_id, allocation_id, bill_id, event_id, kind, claim_id, line_id, receipt_id, amount_cents, effective_date, created_by)
                     values (gen_random_uuid(), $1, $2, $3, $4, gen_random_uuid(), 'receipt', $5, $6, $7, 2000, '2026-05-10', $8)`, [h, p1, al1, billA, claim, line, receipt, u]);
    });
    assert.deepEqual(await ledgerViolations(db.pool), [], 'the fabricated 0016 data is itself consistent');
    const before = await legacyFigures(db.pool);
    // The data really is populated: every kind of record is there and the figures are what the inserts imply.
    assert.deepEqual([before.cash.count, before.cash.net, before.cash.unapplied], [3, '19000', '3000']);
    assert.deepEqual(before.hsaStatus.map((r) => [r.n, r.c, r.pe, r.r, r.a, r.direct_hsa]).sort(), [['10000', '8000', '3000', '2000', '3000', false], ['6000', '0', '0', '0', '0', true]].sort());
    assert.deepEqual(before.plan.map((r) => [r.matched, r.per_installment]), [['10000', ['10000', '0', '0']]]);
    assert.equal(before.ledger.voidedPayments, '1');
    assert.equal(before.ledger.matchedCents, '10000');

    assert.deepEqual(await migrate(db.pool), ['0017', '0018', '0019', '0020', '0021']);
    const after = await legacyFigures(db.pool);
    // 0017 adds two totals to the summary; they are zero here and every other figure is untouched.
    assert.deepEqual([after.ledger.removedPayments, after.ledger.removedPlans], ['0', '0']);
    assert.equal(after.ledger.removedHsaRecords, '0'); delete after.ledger.removedPayments; delete after.ledger.removedPlans; delete after.ledger.removedHsaRecords;
    assert.deepEqual(after, before, 'the same figures after the upgrade');
    assert.deepEqual(await ledgerViolations(db.pool), []);
    assert.equal((await ledgerSummary(db.pool)).removedPayments, '0');

    // The application's own reads now agree with the figures taken before the upgrade.
    const actor = { userId: u, householdId: h, role: 'admin', displayName: 'Alex Example', sessionId: randomUUID(), mustChangePassword: false };
    const cash = await pay.cashSummary(db.pool, actor);
    assert.deepEqual([cash.paymentCount, cash.unappliedCents, cash.netCashCents], [before.cash.count, before.cash.unapplied, before.cash.net]);
    const listed = (await pay.listPayments(db.pool, actor, {})).items.map((x) => ({ id: x.id, applied: x.appliedCents, refunded: x.refundedCents, unapplied: x.unappliedCents, net: x.netCashCents, voided: x.voided })).sort((a, b) => (a.id < b.id ? -1 : 1));
    assert.deepEqual(listed, before.payments.map((x) => ({ id: x.id, applied: x.applied, refunded: x.refunded, unapplied: x.unapplied, net: x.net, voided: x.voided })));
    const methods = (await pm.listPaymentMethods(db.pool, actor)).items.map((x) => [x.id, x.paymentCount, x.netCashCents]);
    for (const [id, count, net] of before.methods.filter((x) => x[0] !== null)) assert.deepEqual(methods.find((x) => x[0] === id), [id, count, net]);
    const accounts = (await acc.listHsaAccounts(db.pool, actor)).items.map((x) => [x.id, x.paymentCount, x.netCashCents]);
    assert.deepEqual(accounts.find((x) => x[0] === acct), [acct, 1, '6000']);
    const totals = await hsa.hsaSummary(db.pool, actor, {});
    assert.deepEqual([totals.eligibleCents, totals.pendingCents, totals.receivedCents, totals.availableCents, totals.paidDirectlyCents], ['8000', '3000', '2000', '3000', '6000']);
    const detail = await plans.getPlanDetail(db.pool, actor, plan, { asOf: '2026-05-15' });
    assert.deepEqual([detail.plan.matchedCents, ...detail.installments.map((i) => i.matchedCents)], ['10000', '10000', '0', '0']);
    assert.deepEqual((await pay.getPaymentDetail(db.pool, actor, p1)).allocations.map((a) => [a.netCents, a.matchedCents]), [['10000', '10000']]);
  } finally { await db.drop(); }
});
