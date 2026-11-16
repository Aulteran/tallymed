// "Add a plan that's already in progress": one guided form, one save (docs/contracts.md, "A plan already in progress"). Fabricated data only.
// A plan that started ten months ago: 12 installments of $60.00 over two bills ($720.00), the first three paid on their due dates, then
// restructured from the fourth month. Dates are worked from today, so the plan is always ten months old.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as handlers from '../../apps/web/server/http.ts';
import { csrfFor } from '../../apps/web/server/tokens.ts';
import { readFlash } from '../../apps/web/server/flash.ts';
import { withInstallmentList } from '../../apps/web/server/plan-installments.ts';
import { withBillTicks } from '../../apps/web/server/plan-preview-form.ts';
import * as plans from '../../apps/web/server/services/plans.ts';
import { retryStats } from '../../apps/web/server/services/support.ts';
import { post, skipDb } from './helpers.mjs';
import { setup } from './money-helpers.mjs';

const code = (c) => ({ code: c });
const monthStart = (back) => { const n = new Date(); return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - back, 1)).toISOString().slice(0, 10); };
const START = () => monthStart(10);
/** Due date of installment `i` (0-based) of the original agreement. */
const due = (i) => monthStart(10 - i);
const today = () => new Date().toISOString().slice(0, 10);
const TABLES = ['payment_plans', 'plan_revisions', 'plan_installments', 'installment_matches', 'payment_plan_bills', 'idempotency_records', 'audit_events'];

async function progressSetup(t, { paid = 3 } = {}) {
  const m = await t.member();
  const p = await t.provider();
  const a = await t.bill({ memberId: m, providerId: p, originalAmount: '400.00' });
  const b = await t.bill({ memberId: m, providerId: p, originalAmount: '320.00' });
  const bills = [a.id, b.id];
  // Payments on the first due dates, spread over both bills.
  for (let i = 0; i < paid; i++) await t.pay1({ paidOn: due(i), amount: '60.00', billId: bills[i % 2] });
  const input = (o = {}) => ({
    idempotencyKey: t.key(), name: 'Imaging plan', [`bill_${a.id}`]: 'on', [`bill_${b.id}`]: 'on', startedOn: START(), matchExisting: 'on',
    inputMode: 'per_installment', installmentAmount: '60.00', installmentCount: '12', firstDueDate: START(), cadence: 'monthly',
    restructured: 'yes', restartOn: due(3), restartAmount: '45.00', restartCadence: 'monthly', reason: 'Provider restructured the plan', ...o,
  });
  const run = (o) => plans.createPlanInProgress(t.db.pool, t.actor, input(o), 'req-progress');
  const detail = (id) => plans.getPlanDetail(t.db.pool, t.actor, id, { asOf: today() });
  const counts = async () => JSON.stringify(await Promise.all(TABLES.map((x) => t.count(x))));
  return { m, p, a, b, input, run, detail, counts };
}

test('a plan in progress with a restructure is saved in one step: original agreement, matches on the paid installments, then the new schedule', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const s = await progressSetup(t);
    const before = await s.counts();
    const saved = await s.run();
    assert.equal(saved.replayed, false);
    const d = await s.detail(saved.id);
    // Plan total: the original $720.00 (3 kept x $60.00 + 12 x $45.00 = $540.00 still to schedule).
    assert.equal(d.plan.totalCents, '72000');
    assert.equal(d.plan.status, 'active');
    assert.equal(d.plan.startedOn, START());
    assert.deepEqual(d.revisions.map((r) => [r.revisionNo, r.totalCents, r.installmentCount, r.reason, r.cadence]), [
      [1, '72000', 12, 'Initial schedule', 'monthly'], [2, '72000', 15, 'Provider restructured the plan', 'custom'],
    ]);
    assert.deepEqual(d.installments.map((i) => [i.dueDate, i.amountCents, i.matchedCents, i.state]), [
      [due(0), '6000', '6000', 'paid'], [due(1), '6000', '6000', 'paid'], [due(2), '6000', '6000', 'paid'],
      ...Array.from({ length: 12 }, (_, k) => [monthStart(7 - k), '4500', '0', 'unpaid']),
    ]);
    assert.equal(d.plan.matchedCents, '18000');
    // The matches are the existing cash by reference: revision 1 holds the fill, revision 2 carries the kept ones (marked carried, kept from revision 1).
    const ledger = d.matches.map((m) => [m.kind, m.revisionNo, m.installmentSeq, m.amountCents, m.carried, m.reason]);
    assert.deepEqual(ledger.filter((x) => x[1] === 1), [1, 2, 3].map((seq) => ['match', 1, seq, '6000', false, 'Matched an existing payment when the plan was created']));
    assert.deepEqual(ledger.filter((x) => x[1] === 2), [1, 2, 3].map((seq) => ['match', 2, seq, '6000', true, 'Kept from revision 1']));
    // No cash moved: three payments of $60.00 and the bills' balances are the payments' doing alone.
    assert.equal(await t.count('payments'), 3);
    assert.equal((await t.detail(s.a.id)).openBalanceCents, '28000');
    assert.equal((await t.detail(s.b.id)).openBalanceCents, '26000');
    // Audit: the events the separate steps record, with one request id, plus one summary. Counts and cents only, no names or reasons.
    const events = (await t.db.pool.query(`select action, request_id, detail from audit_events where entity_id = $1 order by id`, [saved.id])).rows;
    assert.deepEqual(events.map((e) => e.action), ['plan.created', 'plan.revised', 'plan.created_in_progress']);
    assert.equal(new Set(events.map((e) => e.request_id)).size, 1);
    const [created, revised, summary] = events.map((e) => e.detail);
    assert.deepEqual([created.totalCents, created.installmentCount, created.matchedExistingCents, created.matchedExistingAllocations, created.inputMode, created.remainder, created.warningCodes], ['72000', 12, '18000', 3, 'per_installment', null, '']);
    assert.deepEqual([revised.reviseMode, revised.fromRevisionNo, revised.toRevisionNo, revised.keptInstallmentCount, revised.keptCents, revised.rescheduledCount, revised.rescheduledCents, revised.toTotalCents, revised.carriedMatchedCents, revised.remainder, revised.warningCodes],
      ['keep_paid', 1, 2, 3, '18000', 12, '54000', '72000', '18000', null, '']);
    assert.deepEqual(summary, {
      planId: saved.id, billCount: 2, startedOn: START(), matchExisting: true, matchedCents: '18000', matchedAllocations: 3, originalTotalCents: '72000', originalInstallmentCount: 12,
      restructured: true, keptInstallmentCount: 3, keptCents: '18000', restCents: '54000', restInstallmentCount: 12, restartOn: due(3), finalTotalCents: '72000', finalInstallmentCount: 15,
    });
    assert.ok(!JSON.stringify(events).includes('Provider restructured') && !JSON.stringify(events).includes('Imaging'), 'no free text in the audit trail');
    assert.equal(await t.count('payment_plans'), 1);
    assert.notEqual(await s.counts(), before);
  } finally {
    await t.db.drop();
  }
});

test('a restructure that leaves a remainder: $50.00 each is 10 installments and a last one of $40.00', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const s = await progressSetup(t);
    const saved = await s.run({ restartAmount: '50.00' });
    const d = await s.detail(saved.id);
    assert.equal(d.plan.totalCents, '72000');
    assert.deepEqual(d.installments.slice(3).map((i) => i.amountCents), [...Array(10).fill('5000'), '4000']);
    assert.equal(d.installments.length, 14);
    assert.equal(d.revisions[1].installmentCount, 14);
    const revised = (await t.audit('plan.revised'))[0].detail;
    assert.deepEqual([revised.rescheduledCount, revised.rescheduledCents, revised.remainder, revised.inputMode], [11, '54000', null, 'per_installment']);
    // Weekly and biweekly restarts work too (previewed: the cash is already matched to the plan saved above).
    const fresh = await progressSetup(t);
    const weekly = await plans.previewPlanInProgress(t.db.pool, t.actor, { ...fresh.input({ restartCadence: 'weekly', restartAmount: '90.00' }), idempotencyKey: undefined });
    assert.deepEqual(weekly.plan.rows.slice(3).map((r) => r.amountCents), Array(6).fill('9000'));
    assert.equal(weekly.plan.rows[4].dueDate > weekly.plan.rows[3].dueDate, true);
  } finally {
    await t.db.drop();
  }
});

test('without a restructure the plan is created and its payments matched, in one step with no second revision', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const s = await progressSetup(t);
    // "No" ignores the restart fields a form without JavaScript still sends, and the reason.
    const saved = await s.run({ restructured: 'no' });
    const d = await s.detail(saved.id);
    assert.deepEqual(d.revisions.map((r) => r.revisionNo), [1]);
    assert.equal(d.plan.totalCents, '72000');
    assert.deepEqual(d.installments.map((i) => i.state).slice(0, 4), ['paid', 'paid', 'paid', 'unpaid']);
    assert.equal(d.installments.length, 12);
    assert.deepEqual((await t.audit('plan.revised')).length, 0);
    const summary = (await t.audit('plan.created_in_progress'))[0].detail;
    assert.deepEqual([summary.restructured, summary.keptInstallmentCount, summary.restCents, summary.restInstallmentCount, summary.restartOn, summary.finalTotalCents, summary.matchedCents], [false, 0, null, null, null, '72000', '18000']);
    // The matches are plain revision-1 matches (not carried).
    assert.deepEqual(d.matches.map((m) => [m.revisionNo, m.carried]), [[1, false], [1, false], [1, false]]);
    // Without matching and without a restructure it is simply a plan entered with its start date.
    const bare = await s.run({ restructured: 'no', matchExisting: undefined, name: 'No matching', idempotencyKey: t.key() });
    const b = await s.detail(bare.id);
    assert.equal(b.plan.matchedCents, '0');
    assert.deepEqual(b.revisions.map((r) => r.revisionNo), [1]);
    // A reason is only needed when the plan was restructured.
    assert.ok(await s.run({ restructured: 'no', reason: '', name: 'No reason', matchExisting: undefined, idempotencyKey: t.key() }));
  } finally {
    await t.db.drop();
  }
});

test('the original agreement can be listed installment by installment', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const s = await progressSetup(t);
    // Four listed installments (three of $60.00 paid, one of $60.00 owed) restructured to $45.00 each: $60.00 is $45.00 and $15.00.
    const rows = [0, 1, 2, 3].map((i) => ({ dueDate: due(i), amount: '60.00' }));
    const saved = await plans.createPlanInProgress(t.db.pool, t.actor, {
      idempotencyKey: t.key(), name: 'Listed in progress', billIds: [s.a.id, s.b.id], startedOn: START(), matchExisting: 'on', installments: rows,
      restructured: 'yes', restartOn: due(3), restartAmount: '45.00', reason: 'Listed and restructured',
    }, 'r');
    const d = await s.detail(saved.id);
    assert.deepEqual(d.installments.map((i) => i.amountCents), ['6000', '6000', '6000', '4500', '1500']);
    assert.equal(d.plan.totalCents, '24000');
    const created = (await t.audit('plan.created'))[0].detail;
    assert.deepEqual([created.inputMode, created.remainder, created.cadence], ['list', null, 'custom']);
    // The same through the form: the table rows (and the pasted text) are read by the route's prepare step.
    const token = t.cookie.split('=')[1];
    const other = await progressSetup(t); // bills of its own, so the cash of the plan above is not in the way
    const form = { csrf: csrfFor(token), idempotencyKey: t.key(), dialog: 'progress', name: 'Listed by form', [`bill_${other.a.id}`]: 'on', [`bill_${other.b.id}`]: 'on', startedOn: START(), matchExisting: 'on', inputMode: 'list',
      totalAmount: '', installmentCount: '', firstDueDate: '', cadence: 'monthly', restructured: 'yes', restartOn: due(3), restartAmount: '45.00', restartCadence: 'monthly', reason: 'Listed and restructured',
      installmentsText: rows.map((r) => `${r.dueDate} ${r.amount}`).join('\n') };
    const res = await handlers.handleExpenseAction(post('/api/expenses/plans/create-in-progress', form, { cookie: t.cookie, html: true }), t.ctx, 'plans/create-in-progress');
    assert.equal(res.status, 303);
    const id = new URL(res.headers.get('location')).pathname.split('/')[2];
    assert.deepEqual((await s.detail(id)).installments.map((i) => i.amountCents), ['6000', '6000', '6000', '4500', '1500']);
    assert.equal(res.headers.get('location').includes('error'), false);
  } finally {
    await t.db.drop();
  }
});

test('every refusal writes nothing: one transaction, one decision before the first write', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const s = await progressSetup(t);
    const before = await s.counts();
    const refuse = async (o, c, message) => {
      await assert.rejects(s.run({ idempotencyKey: t.key(), ...o }), (e) => e.code === c && (!message || message.test(e.message)), JSON.stringify(o));
      assert.equal(await s.counts(), before, `no row written for ${JSON.stringify(o)}`);
    };
    // The restart date is before the last kept installment's due date (the third).
    await refuse({ restartOn: due(1) }, 'conflict', /before the last kept installment/);
    await refuse({ restartOn: START() }, 'conflict', /before the last kept installment/);
    // Nothing is fully paid after matching: no matching, or a start date after the payments.
    await refuse({ matchExisting: undefined }, 'conflict', /nothing to keep/);
    await refuse({ startedOn: due(3), firstDueDate: due(3), restartOn: due(3) }, 'conflict', /nothing to keep/);
    // The kept and the new installments together may not pass 120: 3 kept and 118 new.
    await refuse({ restartAmount: '4.58' }, 'invalid_input', /at most 120/);
    // The new schedule alone may not pass 120 either.
    await refuse({ restartAmount: '1.00' }, 'invalid_input', /most is 120/);
    // Missing or unusable fields.
    await refuse({ restartOn: '' }, 'invalid_input', /restart date/);
    await refuse({ restartAmount: '' }, 'invalid_input', /amount per installment/);
    await refuse({ reason: '   ' }, 'invalid_input', /reason/);
    await refuse({ startedOn: '' }, 'invalid_input');
    await refuse({ startedOn: monthStart(-1) }, 'invalid_input', /future/);
    await refuse({ name: '' }, 'invalid_input');
    await refuse({ inputMode: 'total', installmentAmount: '60.00' }, 'invalid_input');
    await refuse({ [`bill_${s.a.id}`]: undefined, [`bill_${s.b.id}`]: undefined }, 'invalid_input');
    await assert.rejects(plans.createPlanInProgress(t.db.pool, t.actor, { ...s.input(), unexpected: 'x' }, 'r'), code('invalid_input'));
    // A bill that is not confirmed or does not exist.
    await assert.rejects(s.run({ idempotencyKey: t.key(), [`bill_00000000-0000-4000-8000-000000000000`]: 'on', [`bill_${s.a.id}`]: undefined, [`bill_${s.b.id}`]: undefined }), code('not_found'));
    assert.equal(await s.counts(), before);
    // Everything already paid: the payments cover all of a three-installment plan.
    const m = await t.member();
    const c = await t.bill({ memberId: m, providerId: s.p, originalAmount: '90.00' });
    for (let i = 0; i < 3; i++) await t.pay1({ paidOn: due(i), amount: '30.00', billId: c.id });
    const beforeAll = await s.counts();
    await assert.rejects(s.run({ idempotencyKey: t.key(), [`bill_${s.a.id}`]: undefined, [`bill_${s.b.id}`]: undefined, [`bill_${c.id}`]: 'on', installmentAmount: '30.00', installmentCount: '3', restartOn: due(3) }), (e) => e.code === 'conflict' && /already paid/.test(e.message));
    assert.equal(await s.counts(), beforeAll);
  } finally {
    await t.db.drop();
  }
});

test('a failure after the plan rows are written rolls the whole save back (one transaction)', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const s = await progressSetup(t);
    const before = await s.counts();
    // A constraint that only the summary audit event can trip: after revision 2 and its matches are written.
    await t.db.pool.query(`
      create function fail_summary() returns trigger language plpgsql as $$ begin raise exception 'summary refused' using errcode = 'P0001'; end $$;
      create trigger fail_summary before insert on audit_events for each row when (new.action = 'plan.created_in_progress') execute function fail_summary();`);
    await assert.rejects(s.run());
    assert.equal(await s.counts(), before, 'the plan, both revisions, the matches, the audit events and the idempotency record are all gone');
    await t.db.pool.query(`drop trigger fail_summary on audit_events; drop function fail_summary();`);
    assert.ok(await s.run(), 'and the same form saves once the failure is gone');
    assert.equal(await t.count('payment_plans'), 1);
  } finally {
    await t.db.drop();
  }
});

test('one idempotency key: a replay returns the same plan, other details with the same key conflict, and a changed cash picture does not break a replay', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const s = await progressSetup(t);
    const key = t.key();
    const first = await s.run({ idempotencyKey: key });
    const after = await s.counts();
    const again = await s.run({ idempotencyKey: key });
    assert.deepEqual([again.id, again.replayed], [first.id, true]);
    assert.equal(await s.counts(), after, 'a replay writes nothing');
    assert.equal(await t.count('payment_plans'), 1);
    // The key is the one key of the whole save: no key is claimed per step.
    assert.equal((await t.db.pool.query(`select count(*)::int n from idempotency_records where operation like 'plan.%'`)).rows[0].n, 1);
    assert.equal((await t.db.pool.query(`select operation from idempotency_records where operation like 'plan.%'`)).rows[0].operation, 'plan.create_in_progress');
    for (const other of [{ name: 'Another name' }, { restartAmount: '50.00' }, { restartOn: due(4) }, { reason: 'A different reason' }, { startedOn: monthStart(11) }, { matchExisting: undefined }, { restructured: 'no' }, { installmentCount: '11' }]) {
      await assert.rejects(s.run({ idempotencyKey: key, ...other }), code('conflict'), JSON.stringify(other));
    }
    assert.equal(await s.counts(), after);
    // More cash arrives afterwards: the same request is still a replay of the same plan.
    await t.pay1({ paidOn: due(3), amount: '60.00', billId: s.a.id });
    assert.equal((await s.run({ idempotencyKey: key })).replayed, true);
    // The bill ticks are a set: their order does not matter.
    assert.equal((await s.run({ idempotencyKey: key, [`bill_${s.b.id}`]: 'on', [`bill_${s.a.id}`]: 'on' })).replayed, true);
  } finally {
    await t.db.drop();
  }
});

test('two identical submissions with different keys never match the same cash twice, in the global lock order', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const s = await progressSetup(t);
    retryStats.lockConflicts = 0;
    const results = await Promise.allSettled([s.run({ idempotencyKey: t.key() }), s.run({ idempotencyKey: t.key() })]);
    assert.equal(retryStats.lockConflicts, 0, 'no lock-cycle retries');
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    assert.equal(ok.length, 1, 'the cash is matched once; the other submission finds nothing left to keep');
    assert.equal(failed.length, 1);
    assert.equal(failed[0].reason.code, 'conflict');
    assert.equal(await t.count('payment_plans'), 1);
    // Cash is referenced once: current matches per allocation never exceed the allocation's cash.
    const over = (await t.db.pool.query(`
      select a.allocation_id from (select m.allocation_id, sum(m.amount_cents) matched from installment_matches m
        join plan_revisions r on r.id = m.revision_id where r.revision_no = (select max(x.revision_no) from plan_revisions x where x.plan_id = r.plan_id) group by m.allocation_id) a
      join allocation_net n on n.allocation_id = a.allocation_id where a.matched > n.net_cents`)).rows;
    assert.deepEqual(over, []);
    assert.equal((await t.db.pool.query(`select coalesce(sum(amount_cents), 0)::text s from installment_matches`)).rows[0].s, '36000', 'three matches in revision 1 and the same three carried onto revision 2');
    // Without a restructure the loser still saves a plan, with nothing left to match.
    const t2 = await Promise.allSettled([s.run({ idempotencyKey: t.key(), restructured: 'no', name: 'Plain A' }), s.run({ idempotencyKey: t.key(), restructured: 'no', name: 'Plain B' })]);
    assert.equal(t2.every((r) => r.status === 'fulfilled'), true);
    assert.equal(retryStats.lockConflicts, 0);
    assert.equal((await t.db.pool.query(`select coalesce(sum(amount_cents), 0)::text s from installment_matches`)).rows[0].s, '36000', 'no cash is matched a third time');
  } finally {
    await t.db.drop();
  }
});

test('the preview is the save: same installments, same total, same warnings, and it writes nothing', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const s = await progressSetup(t);
    const token = t.cookie.split('=')[1];
    const before = await s.counts();
    const fields = (o = {}) => { const { idempotencyKey: _k, ...rest } = s.input(o); return rest; };
    // Through the route: only a marker in the address, the values in the flash cookie, nothing written.
    const res = await handlers.handleExpenseAction(post('/api/expenses/plans/preview', { csrf: csrfFor(token), preview: 'progress', dialog: 'progress', ...fields() }, { cookie: t.cookie, html: true }), t.ctx, 'plans/preview');
    assert.equal(res.status, 303);
    const loc = new URL(res.headers.get('location'));
    assert.equal(loc.pathname + loc.search, '/plans?preview=progress');
    assert.ok(!res.headers.get('location').includes('Provider'));
    const values = withBillTicks(readFlash(res.headers.get('set-cookie').split(';')[0].split('=')[1], '/plans'));
    assert.equal(values.restartAmount, '45.00');
    assert.equal(values.restructured, 'yes');
    assert.equal(await s.counts(), before);
    const preview = await plans.previewPlanInProgress(t.db.pool, t.actor, withInstallmentList(values));
    assert.equal(await s.counts(), before, 'building the preview wrote nothing, not even an audit event');
    assert.deepEqual(preview.original.rows.slice(0, 4).map((r) => [r.dueDate, r.amountCents, r.matchedCents, r.state]), [
      [due(0), '6000', '6000', 'paid'], [due(1), '6000', '6000', 'paid'], [due(2), '6000', '6000', 'paid'], [due(3), '6000', '0', 'unpaid'],
    ]);
    assert.deepEqual([preview.original.rows.length, preview.original.totalCents, preview.original.matchedCents], [12, '72000', '18000']);
    assert.deepEqual([preview.restructured, preview.stillToScheduleCents, preview.plan.keptCount, preview.plan.newCount, preview.plan.newCents, preview.plan.totalCents, preview.plan.count], [true, '54000', 3, 12, '54000', '72000', 15]);
    assert.deepEqual(preview.plan.warnings, []);
    // The remainder variant and the no-restructure form agree as well.
    const p2 = await plans.previewPlanInProgress(t.db.pool, t.actor, fields({ restartAmount: '50.00', name: 'Variant' }));
    assert.deepEqual(p2.plan.rows.slice(3).map((r) => r.amountCents), [...Array(10).fill('5000'), '4000']);
    const p3 = await plans.previewPlanInProgress(t.db.pool, t.actor, fields({ restructured: 'no' }));
    assert.deepEqual([p3.restructured, p3.stillToScheduleCents, p3.plan.count, p3.plan.keptCount], [false, null, 12, 0]);
    // The preview refuses what the save refuses, with the same words, and its notes explain the matching.
    await assert.rejects(plans.previewPlanInProgress(t.db.pool, t.actor, fields({ restartOn: due(1) })), (e) => e.code === 'conflict' && /before the last kept installment/.test(e.message));
    await assert.rejects(plans.previewPlanInProgress(t.db.pool, t.actor, fields({ matchExisting: undefined })), (e) => e.code === 'conflict' && /nothing to keep/.test(e.message));
    assert.ok(preview.plan.notes.some((n) => /\$180\.00 of payments already applied/.test(n)));
    // Saving the same values (last: it takes the cash the variants above only previewed) gives exactly what was previewed.
    const saved = await s.run();
    const d = await s.detail(saved.id);
    assert.deepEqual(d.installments.map((i) => [i.dueDate, i.amountCents]), preview.plan.rows.map((r) => [r.dueDate, r.amountCents]));
    assert.deepEqual(d.installments.map((i) => i.state === 'paid'), preview.plan.rows.map((r) => r.kept));
    assert.equal(d.plan.totalCents, preview.plan.totalCents);
    assert.deepEqual(d.revisions[0].installmentCount, preview.original.rows.length);
    // The route refuses a preview of a bad marker or without the token, like the other previews.
    assert.equal((await handlers.handleExpenseAction(post('/api/expenses/plans/preview', { csrf: csrfFor(token), preview: 'progres', ...fields() }, { cookie: t.cookie, html: true }), t.ctx, 'plans/preview')).status, 400);
  } finally {
    await t.db.drop();
  }
});

test('a refused form post goes back to the plans page with its values kept and the dialog marker', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const s = await progressSetup(t);
    const token = t.cookie.split('=')[1];
    const before = await s.counts();
    const body = { ...s.input({ restartOn: due(1) }), csrf: csrfFor(token), dialog: 'progress' };
    const res = await handlers.handleExpenseAction(post('/api/expenses/plans/create-in-progress', body, { cookie: t.cookie, html: true }), t.ctx, 'plans/create-in-progress');
    assert.equal(res.status, 303);
    assert.match(res.headers.get('location'), /\/plans\?error=conflict$/);
    const flash = readFlash(res.headers.get('set-cookie').split(';')[0].split('=')[1], '/plans');
    assert.deepEqual([flash.name, flash.dialog, flash.restructured, flash.restartOn, flash.reason, flash['bill.0'] !== undefined, flash.startedOn], ['Imaging plan', 'progress', 'yes', due(1), 'Provider restructured the plan', true, START()]);
    assert.ok(!('idempotencyKey' in flash) && !('csrf' in flash));
    assert.equal(await s.counts(), before);
    // A good post redirects to the new plan.
    const ok = await handlers.handleExpenseAction(post('/api/expenses/plans/create-in-progress', { ...s.input(), csrf: csrfFor(token), dialog: 'progress' }, { cookie: t.cookie, html: true }), t.ctx, 'plans/create-in-progress');
    assert.match(new URL(ok.headers.get('location')).pathname, /^\/plans\/[0-9a-f-]{36}$/);
    // JSON callers send billIds and a real boolean.
    const j = await progressSetup(t); // bills of its own: the cash above is matched
    const json = await handlers.handleExpenseAction(post('/api/expenses/plans/create-in-progress', {
      csrf: csrfFor(token), idempotencyKey: t.key(), name: 'JSON plan', billIds: [j.a.id, j.b.id], startedOn: START(), matchExisting: true, inputMode: 'per_installment', installmentAmount: '60.00', installmentCount: '12', firstDueDate: START(),
      restructured: true, restartOn: due(3), restartAmount: '45.00', reason: 'By JSON',
    }, { cookie: t.cookie, type: 'json' }), t.ctx, 'plans/create-in-progress');
    assert.equal(json.status, 201);
  } finally {
    await t.db.drop();
  }
});
