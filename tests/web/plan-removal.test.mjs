// Plan removal and its undo (services, HTTP pipeline, backup, upgrade). Real PostgreSQL, fabricated data only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import test from 'node:test';
import { createBackup, restoreArchive, verifyArchive } from '../../apps/web/server/backup/engine.ts';
import { ledgerSummary, ledgerViolations } from '../../apps/web/server/backup/ledger.ts';
import { BACKUP_TABLES } from '../../apps/web/server/backup/tables.ts';
import * as handlers from '../../apps/web/server/http.ts';
import { migrate } from '../../apps/web/server/migrate.ts';
import { getUndoSlot } from '../../apps/web/server/repositories/undo.ts';
import * as pay from '../../apps/web/server/services/payments.ts';
import * as plans from '../../apps/web/server/services/plans.ts';
import { retryStats } from '../../apps/web/server/services/support.ts';
import { undo } from '../../apps/web/server/services/undo.ts';
import { csrfFor } from '../../apps/web/server/tokens.ts';
import { tempStore } from './document-helpers.mjs';
import { freshDatabase, post, skipDb } from './helpers.mjs';
import { setup } from './money-helpers.mjs';

const code = (c) => ({ code: c });
const REASON = 'Fabricated duplicate plan';
const AS_OF = '2026-07-15';

const removePlan = (t, plan, o = {}, actor = t.actor) => plans.removePlan(t.db.pool, actor, { idempotencyKey: randomUUID(), planId: plan.id, version: String(plan.version ?? 1), reason: REASON, ...o }, 'r');
const undoIt = (t, o = {}, actor = t.actor) => undo(t.db.pool, actor, { idempotencyKey: randomUUID(), ...o }, 'r');
const slotRows = async (t) => (await t.db.pool.query(`select user_id, kind, entity_id, payload from undo_actions`)).rows;
const planRow = async (t, id) => (await t.db.pool.query(`select status, version, removed_at, removed_by, removed_reason from payment_plans where id = $1`, [id])).rows[0];
const liveMatches = async (t, planId) => (await t.db.pool.query(
  `select installment_id, allocation_id, sum(amount_cents)::text c from installment_matches where plan_id = $1 group by installment_id, allocation_id having sum(amount_cents) <> 0 order by installment_id, allocation_id`, [planId])).rows;

/** A second administrator, an operator and an administrator of another household (fabricated rows; service calls need no sessions). */
async function people(t) {
  const q = (sql, p) => t.db.pool.query(sql, p);
  const mk = async (householdId, email, role) => {
    const id = (await q(`insert into users (household_id, email, display_name, role, password_hash) values ($1, $2, $3, $4, 'x') returning id`, [householdId, email, email, role])).rows[0].id;
    return { userId: id, householdId, role, displayName: email, sessionId: randomUUID(), mustChangePassword: false };
  };
  const h2 = (await q(`insert into households (name) values ('Other Family') returning id`)).rows[0].id;
  return { admin2: await mk(t.actor.householdId, 'admin2@example.test', 'admin'), operator: await mk(t.actor.householdId, 'op@example.test', 'operator'), outsider: await mk(h2, 'outsider@example.test', 'admin') };
}

/** A $300 bill, a 3-installment plan, a $150 payment on it matched $100 to installment 1 and $50 to installment 2. */
async function fixture(t, { match = true } = {}) {
  const m = await t.member(); const p = await t.provider();
  const bill = await t.bill({ memberId: m, providerId: p, originalAmount: '300.00' });
  const created = await plans.createPlan(t.db.pool, t.actor, {
    idempotencyKey: t.key(), name: 'Clinic plan', billId: bill.id, totalAmount: '300.00', installmentCount: '3', firstDueDate: '2026-06-01', cadence: 'monthly', startedOn: '2026-01-01',
  }, 'r');
  const detail = (o = {}) => plans.getPlanDetail(t.db.pool, t.actor, created.id, { asOf: AS_OF, ...o });
  const d0 = await detail();
  const payment = await t.pay1({ amount: '150.00', billId: bill.id });
  const alloc = (await t.payment(payment.id)).allocations[0].allocationId;
  if (match) {
    await plans.matchInstallment(t.db.pool, t.actor, { idempotencyKey: t.key(), installmentId: d0.installments[0].id, allocationId: alloc, amount: '100.00' }, 'r');
    await plans.matchInstallment(t.db.pool, t.actor, { idempotencyKey: t.key(), installmentId: d0.installments[1].id, allocationId: alloc, amount: '50.00' }, 'r');
  }
  const plan = (await detail()).plan;
  const cash = async () => JSON.stringify([
    (await t.db.pool.query(`select id, amount_cents::text from payments order by id`)).rows,
    (await t.db.pool.query(`select id, kind, amount_cents::text from payment_entries order by seq`)).rows,
    (await t.detail(bill.id)).openBalanceCents, await pay.cashSummary(t.db.pool, t.actor),
  ]);
  return { m, p, bill, created, plan, detail, d0, payment, alloc, cash };
}

const visible = async (t, planId) => ({
  list: (await plans.listPlans(t.db.pool, t.actor, {}, AS_OF)).items.some((x) => x.id === planId),
  queue: (await plans.listInstallmentQueue(t.db.pool, t.actor, { asOf: AS_OF })).items.some((x) => x.planId === planId),
  billPage: (await pay.billPaymentSummary(t.db.pool, t.actor, (await t.db.pool.query(`select bill_id from payment_plan_bills where plan_id = $1`, [planId])).rows[0].bill_id)).plans.some((x) => x.id === planId),
});

test('removing an active plan releases its matches and hides it everywhere; cash, payments and bill balances are untouched', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const f = await fixture(t);
    const cashBefore = await f.cash();
    const summaryBefore = await plans.installmentSummary(t.db.pool, t.actor, AS_OF);
    assert.deepEqual(await visible(t, f.plan.id), { list: true, queue: true, billPage: true });
    const out = await removePlan(t, f.plan);
    assert.equal(out.replayed, false);
    assert.equal(await f.cash(), cashBefore, 'no payment, entry, balance or cash figure changed');
    assert.deepEqual(await visible(t, f.plan.id), { list: false, queue: false, billPage: false });
    await assert.rejects(f.detail(), code('not_found'));
    const row = await planRow(t, f.plan.id);
    assert.equal(row.version, f.plan.version + 1);
    assert.equal(row.removed_by, t.actor.userId);
    assert.equal(row.removed_reason, REASON);
    assert.notEqual(row.removed_at, null);
    assert.deepEqual(await liveMatches(t, f.plan.id), [], 'every live match was released with a negative row');
    assert.equal((await t.db.pool.query(`select count(*)::int n from installment_matches where kind = 'unmatch' and plan_id = $1`, [f.plan.id])).rows[0].n, 2);
    const summaryAfter = await plans.installmentSummary(t.db.pool, t.actor, AS_OF);
    assert.equal(summaryAfter.overdueCount, 0);
    assert.equal(summaryAfter.upcomingCount, 0);
    assert.notDeepEqual(summaryAfter, summaryBefore);
    // The detail of a removed plan is reachable only through the internal option.
    const internal = await f.detail({ includeRemoved: true });
    assert.equal(internal.plan.removedReason, REASON);
    // Audit: ids and cents only, flat scalars.
    const released = await t.audit('plan.match_released');
    assert.equal(released.length, 2);
    const [removed] = await t.audit('plan.removed');
    assert.equal(removed.entity_type, 'payment_plan');
    assert.equal(removed.detail.planId, f.plan.id);
    assert.equal(removed.detail.releasedMatchCount, 2);
    assert.equal(removed.detail.releasedMatchCents, '15000');
    assert.equal(removed.detail.matchedAfterCents, '0');
    for (const v of Object.values(removed.detail)) assert.ok(['string', 'number', 'boolean'].includes(typeof v) || v === null);
    assert.ok(!JSON.stringify(removed.detail).includes(REASON), 'the free-text reason stays out of the audit detail');
    // The slot holds the inverse.
    const [slot] = await slotRows(t);
    assert.equal(slot.kind, 'plan_remove');
    assert.equal(slot.entity_id, f.plan.id);
    assert.equal(slot.payload.wasActive, true);
    assert.deepEqual(slot.payload.releasedMatches.map((m) => [m.installmentId, m.allocationId, m.paymentId, m.cents]),
      [[f.d0.installments[0].id, f.alloc, f.payment.id, '10000'], [f.d0.installments[1].id, f.alloc, f.payment.id, '5000']]);
    assert.ok(slot.payload.releasedMatches.every((m) => typeof m.revisionId === 'string'));
    assert.deepEqual(await ledgerViolations(t.db.pool), []);
  } finally { await t.db.drop(); }
});

test('undo restores the plan and its matches exactly', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const f = await fixture(t);
    const before = { detail: await f.detail(), cash: await f.cash(), matches: await liveMatches(t, f.plan.id), summary: await plans.installmentSummary(t.db.pool, t.actor, AS_OF) };
    await removePlan(t, f.plan);
    const out = await undoIt(t);
    assert.deepEqual([out.id, out.replayed, out.target], [f.plan.id, false, 'plan']);
    assert.deepEqual(await slotRows(t), [], 'the slot is consumed');
    const after = await f.detail();
    assert.deepEqual(after.installments, before.detail.installments, 'every installment shows the same matched, unpaid and state figures');
    assert.deepEqual(await liveMatches(t, f.plan.id), before.matches);
    assert.equal(after.plan.matchedCents, before.detail.plan.matchedCents);
    assert.equal(after.plan.removedAt, null);
    assert.equal((await planRow(t, f.plan.id)).removed_reason, null);
    assert.equal(await f.cash(), before.cash);
    assert.deepEqual(await plans.installmentSummary(t.db.pool, t.actor, AS_OF), before.summary);
    assert.deepEqual(await visible(t, f.plan.id), { list: true, queue: true, billPage: true });
    const [restored] = await t.audit('plan.restored');
    assert.deepEqual([restored.detail.restoredMatchCount, restored.detail.restoredCents, restored.detail.skippedMatchCount], [2, '15000', 0]);
    // A second undo has nothing to do, and the plan can be removed again.
    await assert.rejects(undoIt(t), (e) => e.code === 'conflict' && e.message === 'Nothing to undo');
    await removePlan(t, { id: f.plan.id, version: (await planRow(t, f.plan.id)).version });
    assert.deepEqual(await visible(t, f.plan.id), { list: false, queue: false, billPage: false });
    assert.deepEqual(await ledgerViolations(t.db.pool), []);
  } finally { await t.db.drop(); }
});

test('undo skips and lists a match that no longer fits (allocation shrank, allocation matched elsewhere)', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    // 1. The allocation shrank while the plan was removed: $150 -> $110. The first match ($100) fits, the second ($50) no longer does.
    const f = await fixture(t);
    await removePlan(t, f.plan);
    await pay.reverseAllocation(t.db.pool, t.actor, { idempotencyKey: t.key(), allocationId: f.alloc, amount: '40.00', effectiveDate: '2026-05-01', reason: 'Wrong bill' }, 'r');
    await undoIt(t);
    assert.deepEqual((await liveMatches(t, f.plan.id)).map((r) => [r.installment_id, r.c]), [[f.d0.installments[0].id, '10000']]);
    const [r1] = await t.audit('plan.restored');
    assert.deepEqual([r1.detail.restoredMatchCount, r1.detail.restoredCents, r1.detail.skippedMatchCount, r1.detail.skippedCents], [1, '10000', 1, '5000']);
    assert.equal(r1.detail.skippedInstallmentIds, f.d0.installments[1].id);
    assert.equal(r1.detail.skippedAllocationIds, f.alloc);
    assert.deepEqual(await ledgerViolations(t.db.pool), []);

    // 2. A removed plan's cash is matched to another plan meanwhile: the allocation has nothing free, so nothing is restored.
    const g = await fixture(t);
    await removePlan(t, g.plan);
    const second = await plans.createPlan(t.db.pool, t.actor, {
      idempotencyKey: t.key(), name: 'Second plan', billId: g.bill.id, totalAmount: '300.00', installmentCount: '3', firstDueDate: '2026-06-01', cadence: 'monthly', startedOn: '2026-01-01',
    }, 'r');
    const sd = await plans.getPlanDetail(t.db.pool, t.actor, second.id, { asOf: AS_OF });
    await plans.matchInstallment(t.db.pool, t.actor, { idempotencyKey: t.key(), installmentId: sd.installments[0].id, allocationId: g.alloc, amount: '100.00' }, 'r');
    await plans.matchInstallment(t.db.pool, t.actor, { idempotencyKey: t.key(), installmentId: sd.installments[1].id, allocationId: g.alloc, amount: '50.00' }, 'r');
    await undoIt(t);
    assert.deepEqual(await liveMatches(t, g.plan.id), []);
    const restored = await t.audit('plan.restored');
    assert.deepEqual([restored[1].detail.restoredMatchCount, restored[1].detail.skippedMatchCount, restored[1].detail.skippedCents], [0, 2, '15000']);
    assert.equal(restored[1].detail.planId, g.plan.id);
    // The plan is back and visible even though none of its matches could return.
    assert.equal((await plans.getPlanDetail(t.db.pool, t.actor, g.plan.id, { asOf: AS_OF })).plan.matchedCents, '0');
  } finally { await t.db.drop(); }
});

test('a cancelled plan is only hidden: matches stay as history and undo shows it again unchanged', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const f = await fixture(t);
    await plans.cancelPlan(t.db.pool, t.actor, { planId: f.plan.id, version: String(f.plan.version), reason: 'Paid another way' }, 'r');
    const cancelled = (await f.detail()).plan;
    const matches = await liveMatches(t, f.plan.id);
    const cash = await f.cash();
    await removePlan(t, cancelled);
    assert.deepEqual(await liveMatches(t, f.plan.id), matches, 'no negative rows for a cancelled plan');
    assert.equal((await t.db.pool.query(`select count(*)::int n from installment_matches where kind = 'unmatch'`)).rows[0].n, 0);
    assert.equal(await f.cash(), cash);
    await assert.rejects(f.detail(), code('not_found'));
    assert.equal((await visible(t, f.plan.id)).list, false);
    const [slot] = await slotRows(t);
    assert.deepEqual([slot.payload.wasActive, slot.payload.releasedMatches], [false, []]);
    await undoIt(t);
    const back = await f.detail();
    assert.equal(back.plan.status, 'cancelled');
    assert.deepEqual(await liveMatches(t, f.plan.id), matches);
    const [removed] = await t.audit('plan.removed');
    assert.deepEqual([removed.detail.status, removed.detail.releasedMatchCount], ['cancelled', 0]);
  } finally { await t.db.drop(); }
});

test('refusals: already removed, every plan-mutating service on a removed plan, stale version, operator, other household, bad input', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const f = await fixture(t);
    const { operator, outsider } = await people(t);
    const unpaidInstallment = f.d0.installments[2].id;
    // Authorization and scoping come before anything else.
    await assert.rejects(removePlan(t, f.plan, {}, operator), code('forbidden'));
    await assert.rejects(removePlan(t, f.plan, {}, outsider), code('not_found'));
    await assert.rejects(removePlan(t, f.plan, { planId: randomUUID() }), code('not_found'));
    await assert.rejects(removePlan(t, f.plan, { version: '99' }), code('stale_version'));
    await assert.rejects(removePlan(t, f.plan, { reason: 'x'.repeat(501) }), code('invalid_input'));
    await assert.rejects(undoIt(t, {}, operator), code('forbidden'));
    assert.equal((await planRow(t, f.plan.id)).removed_at, null, 'nothing changed');
    assert.equal((await slotRows(t)).length, 0);

    await removePlan(t, f.plan, { reason: '' });
    assert.equal((await planRow(t, f.plan.id)).removed_reason, 'Removed by administrator', 'a blank reason takes the default');
    // Cross-household: the other administrator cannot see, remove or undo it either.
    await assert.rejects(removePlan(t, { id: f.plan.id, version: (await planRow(t, f.plan.id)).version }, {}, outsider), code('not_found'));
    await assert.rejects(undoIt(t, {}, outsider), (e) => e.code === 'conflict' && e.message === 'Nothing to undo');
    // Removing again.
    await assert.rejects(removePlan(t, { id: f.plan.id, version: (await planRow(t, f.plan.id)).version }), (e) => e.code === 'conflict' && /already removed/.test(e.message));
    // Every mutation of a removed plan is a conflict with the same message.
    const gone = (e) => e.code === 'conflict' && e.message === 'That plan was removed';
    const v = String((await planRow(t, f.plan.id)).version);
    const schedule = { totalAmount: '300.00', installmentCount: '3', firstDueDate: '2026-06-01', cadence: 'monthly' };
    await assert.rejects(plans.revisePlan(t.db.pool, t.actor, { idempotencyKey: t.key(), planId: f.plan.id, version: v, reason: 'Change', ...schedule }, 'r'), gone);
    await assert.rejects(plans.renamePlan(t.db.pool, t.actor, { planId: f.plan.id, name: 'New name' }, 'r'), gone);
    await assert.rejects(plans.cancelPlan(t.db.pool, t.actor, { planId: f.plan.id, version: v, reason: 'Cancel' }, 'r'), gone);
    await assert.rejects(plans.matchInstallment(t.db.pool, t.actor, { idempotencyKey: t.key(), installmentId: unpaidInstallment, allocationId: f.alloc, amount: '10.00' }, 'r'), gone);
    await assert.rejects(plans.matchExistingPayments(t.db.pool, t.actor, { idempotencyKey: t.key(), planId: f.plan.id, version: v }, 'r'), gone);
    await assert.rejects(plans.unmatchInstallment(t.db.pool, t.actor, { idempotencyKey: t.key(), installmentId: f.d0.installments[0].id, allocationId: f.alloc, amount: '1.00', reason: 'Fix' }, 'r'), gone);
    assert.deepEqual(await liveMatches(t, f.plan.id), []);
    assert.equal((await planRow(t, f.plan.id)).status, 'active');
    // The database refuses a direct match to a removed plan as well (the guard of migration 0017).
    await assert.rejects(t.db.pool.query(
      `insert into installment_matches (id, household_id, plan_id, revision_id, installment_id, payment_id, allocation_id, bill_id, kind, amount_cents, created_by)
       select $1, household_id, plan_id, revision_id, id, $3, $4, $5, 'match', 100, $6 from plan_installments where id = $2`,
      [randomUUID(), unpaidInstallment, f.payment.id, f.alloc, f.bill.id, t.actor.userId]), /removed plan/);
    // A removed plan is not found by id for any reader.
    await assert.rejects(plans.getPlanDetail(t.db.pool, outsider, f.plan.id), code('not_found'));
  } finally { await t.db.drop(); }
});

test('the plan slot expires after the window and is superseded by the next mutation; another administrator cannot use it', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const f = await fixture(t);
    const { admin2 } = await people(t);
    // Expiry, by the database clock.
    await removePlan(t, f.plan);
    assert.equal((await getUndoSlot(t.db.pool, t.actor)).kind, 'plan_remove');
    await t.db.pool.query(`update undo_actions set expires_at = now() - interval '1 second' where user_id = $1`, [t.actor.userId]);
    assert.equal(await getUndoSlot(t.db.pool, t.actor), null);
    await assert.rejects(undoIt(t), (e) => e.code === 'conflict' && e.message === 'Nothing to undo');
    await assert.rejects(f.detail(), code('not_found'));
    assert.equal((await planRow(t, f.plan.id)).removed_reason, REASON, 'still removed');

    // Another administrator has no slot of their own, and cannot use this user's.
    const g = await fixture(t);
    await removePlan(t, g.plan);
    await assert.rejects(undoIt(t, {}, admin2), (e) => e.code === 'conflict' && e.message === 'Nothing to undo');
    assert.equal((await slotRows(t)).length, 1);

    // Supersession by a later removal: the slot now holds that action and the plan removal can no longer be undone.
    const p2 = await t.pay1({ amount: '20.00' });
    await pay.removePayment(t.db.pool, t.actor, { idempotencyKey: randomUUID(), paymentId: p2.id, reason: REASON }, 'r');
    const [slot] = await slotRows(t);
    assert.equal(slot.kind, 'payment_remove');
    await undoIt(t);
    await assert.rejects(g.detail(), code('not_found'));

    // Supersession through the HTTP pipeline: any other mutation by the same user clears the slot first.
    const token = t.cookie.split('=')[1];
    const csrf = csrfFor(token);
    const act = (name, body) => handlers.handleExpenseAction(post(`/api/expenses/${name}`, { ...body }, { type: 'json', cookie: t.cookie, headers: { 'x-csrf-token': csrf } }), t.ctx, name);
    const h = await fixture(t);
    const removed = await act('plans/remove', { idempotencyKey: randomUUID(), planId: h.plan.id, version: h.plan.version, reason: REASON });
    assert.equal(removed.status, 200);
    assert.equal((await slotRows(t)).length, 1);
    assert.equal((await act('members/create', { name: 'Someone Else' })).status, 201);
    assert.deepEqual(await slotRows(t), [], 'the next mutation superseded the plan slot');
    assert.equal((await act('undo', { idempotencyKey: randomUUID() })).status, 409);
    await assert.rejects(h.detail(), code('not_found'));
  } finally { await t.db.drop(); }
});

test('the HTTP action removes a plan, redirects the page to /plans, and undo redirects back to the plan; replay returns the first result', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const f = await fixture(t);
    const token = t.cookie.split('=')[1];
    const csrf = csrfFor(token);
    const form = (name, body) => handlers.handleExpenseAction(post(`/api/expenses/${name}`, body, { type: 'form', html: true, cookie: t.cookie, headers: { 'x-csrf-token': csrf } }), t.ctx, name);
    const key = randomUUID();
    const out = await form('plans/remove', { csrf, idempotencyKey: key, planId: f.plan.id, version: String(f.plan.version), reason: '' });
    assert.equal(out.status, 303);
    assert.equal(new URL(out.headers.get('location'), 'https://tallymed.test').pathname, '/plans');
    // A replay of the same key is a no-op that answers the same way, even though the version moved on.
    const again = await plans.removePlan(t.db.pool, t.actor, { idempotencyKey: key, planId: f.plan.id, version: String(f.plan.version), reason: 'Removed by administrator' }, 'r');
    assert.deepEqual([again.id, again.replayed], [f.plan.id, true]);
    assert.equal(await t.count('audit_events where action = \'plan.removed\''), 1);
    assert.equal((await t.db.pool.query(`select count(*)::int n from installment_matches where kind = 'unmatch'`)).rows[0].n, 2);
    // Same key with different input is refused.
    await assert.rejects(removePlan(t, f.plan, { idempotencyKey: key, reason: 'Another reason' }), code('conflict'));
    const undone = await form('undo', { csrf, idempotencyKey: randomUUID() });
    assert.equal(undone.status, 303);
    assert.equal(new URL(undone.headers.get('location'), 'https://tallymed.test').pathname, `/plans/${f.plan.id}`);
    assert.equal((await f.detail()).plan.matchedCents, '15000');
    // A replay of the undo key answers with the same plan and changes nothing.
    const uk = randomUUID();
    await removePlan(t, { id: f.plan.id, version: (await planRow(t, f.plan.id)).version });
    const first = await undoIt(t, { idempotencyKey: uk });
    const replay = await undoIt(t, { idempotencyKey: uk });
    assert.deepEqual([first.target, replay.target, replay.replayed, replay.id], ['plan', 'plan', true, f.plan.id]);
    assert.equal(await t.count('audit_events where action = \'plan.restored\''), 2);
  } finally { await t.db.drop(); }
});

test('removing races matching: one order wins, matches never survive a committed removal, no lock cycles', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    retryStats.lockConflicts = 0;
    const m = await t.member(); const p = await t.provider();
    for (let i = 0; i < 8; i += 1) {
      const bill = await t.bill({ memberId: m, providerId: p, originalAmount: '300.00' });
      const created = await plans.createPlan(t.db.pool, t.actor, {
        idempotencyKey: t.key(), name: `Plan ${i}`, billId: bill.id, totalAmount: '300.00', installmentCount: '3', firstDueDate: '2026-06-01', cadence: 'monthly', startedOn: '2026-01-01',
      }, 'r');
      const d = await plans.getPlanDetail(t.db.pool, t.actor, created.id, { asOf: AS_OF });
      const pm = await t.pay1({ amount: '150.00', billId: bill.id });
      const alloc = (await t.payment(pm.id)).allocations[0].allocationId;
      // Odd rounds start with an existing match, so the removal has a payment to lock; even rounds start empty.
      if (i % 2 === 1) await plans.matchInstallment(t.db.pool, t.actor, { idempotencyKey: t.key(), installmentId: d.installments[0].id, allocationId: alloc, amount: '40.00' }, 'r');
      const [rm, mt] = await Promise.allSettled([
        removePlan(t, d.plan),
        plans.matchInstallment(t.db.pool, t.actor, { idempotencyKey: t.key(), installmentId: d.installments[1].id, allocationId: alloc, amount: '60.00' }, 'r'),
      ]);
      if (rm.status === 'rejected') assert.equal(rm.reason.code, 'conflict', `unexpected ${rm.reason?.message}`);
      if (mt.status === 'rejected') assert.equal(mt.reason.code, 'conflict', `unexpected ${mt.reason?.message}`);
      assert.equal(rm.status, 'fulfilled', 'the removal always wins eventually');
      assert.deepEqual(await liveMatches(t, created.id), [], 'whichever order, a removed plan holds no live match');
      assert.notEqual((await planRow(t, created.id)).removed_at, null);
      assert.equal((await t.detail(bill.id)).openBalanceCents, '15000', 'the bill balance only ever reflects cash');
    }
    assert.equal(retryStats.lockConflicts, 0, 'no deadlocks or serialization failures');
    assert.deepEqual(await ledgerViolations(t.db.pool), []);
  } finally { await t.db.drop(); }
});

test('backup: a removed plan and a removed payment round-trip (create, verify, restore) with their totals and columns intact', { skip: skipDb }, async () => {
  const t = await setup();
  const ts = tempStore();
  const target = await freshDatabase();
  try {
    const f = await fixture(t);
    const other = await t.pay1({ amount: '25.00' });
    await pay.removePayment(t.db.pool, t.actor, { idempotencyKey: randomUUID(), paymentId: other.id, reason: REASON }, 'r');
    await removePlan(t, f.plan);
    assert.equal((await t.db.pool.query(`select count(*)::int n from payment_plans where removed_at is not null`)).rows[0].n, 1);
    const live = await ledgerSummary(t.db.pool);
    assert.equal(live.removedPlans, '1');
    assert.equal(live.removedPayments, '1');

    const backup = createBackup(t.db.pool, ts.store, { passphrase: null });
    const file = path.join(ts.dir, backup.filename);
    await pipeline(backup.stream, createWriteStream(file));
    await backup.done;
    const verified = await verifyArchive(file);
    assert.equal(verified.manifest.ledger.removedPlans, '1');
    assert.equal(verified.manifest.ledger.removedPayments, '1');
    assert.ok(verified.manifest.tables.find((x) => x.name === 'payment_plans').rows >= 1);

    await restoreArchive(target.pool, null, file, { via: 'cli' });
    const cols = `id, status, version, removed_at, removed_by, removed_reason`;
    const want = (await t.db.pool.query(`select ${cols} from payment_plans order by id`)).rows;
    const got = (await target.pool.query(`select ${cols} from payment_plans order by id`)).rows;
    assert.deepEqual(got, want, 'removed_at, removed_by and removed_reason come back as they were');
    assert.ok(got.some((r) => r.removed_at !== null && r.removed_reason === REASON));
    assert.deepEqual(await ledgerSummary(target.pool), { ...(await ledgerSummary(t.db.pool)), auditEvents: (await ledgerSummary(target.pool)).auditEvents });
    assert.equal((await ledgerSummary(target.pool)).removedPlans, '1');
    assert.equal((await target.pool.query(`select payment_is_removed($1) as v`, [other.id])).rows[0].v, true);
    assert.deepEqual(await ledgerViolations(target.pool), []);
    assert.equal((await target.pool.query(`select count(*)::int n from undo_actions`)).rows[0].n, 0, 'the undo slot is not backed up');
    // The restored removal is final: the schedule and its history are all still there, and the matches stay released.
    assert.equal((await target.pool.query(`select count(*)::int n from installment_matches`)).rows[0].n, 4);
    assert.ok(BACKUP_TABLES.some((x) => x.name === 'payment_plans'));
  } finally { await target.drop(); ts.cleanup(); await t.db.drop(); }
});

test('backup: an older database has no removed-plan total and a restore from it into a newer schema is not flagged', { skip: skipDb }, async () => {
  const db = await freshDatabase({ migrateAll: false });
  try {
    await migrate(db.pool, { upTo: '0016' });
    assert.equal((await ledgerSummary(db.pool)).removedPlans, undefined);
    assert.equal((await ledgerSummary(db.pool)).removedPayments, undefined);
    await migrate(db.pool);
    assert.equal((await ledgerSummary(db.pool)).removedPlans, '0');
  } finally { await db.drop(); }
});

test('upgrade: migration 0017 over a database populated at 0016 keeps its plan, schedule and matches; the services then remove and restore it', { skip: skipDb }, async () => {
  const db = await freshDatabase({ migrateAll: false });
  try {
    await migrate(db.pool, { upTo: '0016' });
    const q = async (sql, p = []) => (await db.pool.query(sql, p)).rows[0];
    const h = (await q(`insert into households (name) values ('Example Family') returning id`)).id;
    const u = (await q(`insert into users (household_id, email, display_name, role, password_hash) values ($1, 'a@example.test', 'Alex Example', 'admin', 'x') returning id`, [h])).id;
    const mem = (await q(`insert into family_members (household_id, name, created_by) values ($1, 'Pat Example', $2) returning id`, [h, u])).id;
    const pr = (await q(`insert into providers (household_id, name, kind, created_by) values ($1, 'Example Clinic', 'clinician', $2) returning id`, [h, u])).id;
    const bill = (await q(
      `insert into bills (household_id, member_id, provider_id, statement_date, original_cents, base_responsibility_cents, amount_status, amount_source, member_name_snapshot, provider_name_snapshot, confirmed_at, confirmed_by, created_by)
       values ($1, $2, $3, '2026-01-02', 30000, 30000, 'confirmed', 'statement', 'Pat Example', 'Example Clinic', now(), $4, $4) returning id`, [h, mem, pr, u])).id;
    const payment = (await q(`insert into payments (household_id, paid_on, amount_cents, method, created_by) values ($1, '2026-04-01', 15000, 'card', $2) returning id`, [h, u])).id;
    const alloc = randomUUID();
    await q(`insert into payment_entries (id, household_id, payment_id, event_id, kind, bill_id, allocation_id, amount_cents, effective_date, created_by)
             values ($1, $2, $3, $4, 'allocation', $5, $1, 15000, '2026-04-01', $6)`, [alloc, h, payment, randomUUID(), bill, u]);
    const plan = (await q(`insert into payment_plans (household_id, name, started_on, created_by) values ($1, 'Clinic plan', '2026-01-01', $2) returning id`, [h, u])).id;
    await q(`insert into payment_plan_bills (household_id, plan_id, bill_id) values ($1, $2, $3)`, [h, plan, bill]);
    const rev = randomUUID();
    const insts = [randomUUID(), randomUUID(), randomUUID()];
    const c = await db.pool.connect();
    try {
      await c.query('begin');
      await c.query(`insert into plan_revisions (id, household_id, plan_id, revision_no, total_cents, cadence, reason, created_by) values ($1, $2, $3, 1, 30000, 'monthly', 'Initial schedule', $4)`, [rev, h, plan, u]);
      for (const [i, id] of insts.entries()) {
        await c.query(`insert into plan_installments (id, household_id, plan_id, revision_id, seq, due_date, amount_cents) values ($1, $2, $3, $4, $5, $6, 10000)`, [id, h, plan, rev, i + 1, `2026-0${6 + i}-01`]);
      }
      await c.query(`insert into installment_matches (id, household_id, plan_id, revision_id, installment_id, payment_id, allocation_id, bill_id, kind, amount_cents, created_by)
                     values ($1, $2, $3, $4, $5, $6, $7, $8, 'match', 10000, $9)`, [randomUUID(), h, plan, rev, insts[0], payment, alloc, bill, u]);
      await c.query('commit');
    } catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
    const before = {
      plans: (await db.pool.query(`select id, name, status, version, created_at from payment_plans`)).rows,
      matches: (await db.pool.query(`select * from installment_matches`)).rows,
      installments: (await db.pool.query(`select * from plan_installments order by seq`)).rows,
    };
    assert.deepEqual(await migrate(db.pool), ['0017', '0018', '0019', '0020', '0021']);
    assert.deepEqual((await db.pool.query(`select id, name, status, version, created_at from payment_plans`)).rows, before.plans);
    assert.deepEqual((await db.pool.query(`select * from installment_matches`)).rows, before.matches);
    assert.deepEqual((await db.pool.query(`select * from plan_installments order by seq`)).rows, before.installments);
    assert.deepEqual((await q(`select removed_at, removed_by, removed_reason from payment_plans where id = $1`, [plan])), { removed_at: null, removed_by: null, removed_reason: null });
    assert.deepEqual(await ledgerViolations(db.pool), []);
    assert.equal((await ledgerSummary(db.pool)).removedPlans, '0');
    // The all-or-none check applies to old rows too.
    await assert.rejects(db.pool.query(`update payment_plans set removed_at = now() where id = $1`, [plan]), /payment_plans_removed_all_or_none/);

    // The upgraded plan shows, then removal and undo work on it through the services.
    const actor = { userId: u, householdId: h, role: 'admin', displayName: 'Alex Example', sessionId: randomUUID(), mustChangePassword: false };
    const detail = await plans.getPlanDetail(db.pool, actor, plan, { asOf: AS_OF });
    assert.equal(detail.plan.matchedCents, '10000');
    assert.equal(detail.plan.removedAt, null);
    await plans.removePlan(db.pool, actor, { idempotencyKey: randomUUID(), planId: plan, version: String(detail.plan.version), reason: REASON }, 'r');
    await assert.rejects(plans.getPlanDetail(db.pool, actor, plan, { asOf: AS_OF }), code('not_found'));
    assert.equal((await ledgerSummary(db.pool)).removedPlans, '1');
    assert.deepEqual(await ledgerViolations(db.pool), []);
    const out = await undo(db.pool, actor, { idempotencyKey: randomUUID() }, 'r');
    assert.equal(out.target, 'plan');
    assert.equal((await plans.getPlanDetail(db.pool, actor, plan, { asOf: AS_OF })).plan.matchedCents, '10000');
    assert.equal((await ledgerSummary(db.pool)).removedPlans, '0');
  } finally { await db.drop(); }
});
