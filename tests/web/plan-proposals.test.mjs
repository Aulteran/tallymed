// Payment plan proposals: an assistant with the separate `plans:propose` scope suggests a plan that is already in progress, and a signed-in
// person reviews a full preview and approves or rejects it in the app (docs/contracts.md, "Assistant proposals"). Covers the MCP tool (scope,
// strict payload, caps), the database role (insert a pending proposal and nothing else), the approval (exactly the previewed plan, once, under the
// global lock order, with audit) and the HTTP routes. Fabricated data only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as handlers from '../../apps/web/server/http.ts';
import { MAX_PROPOSED_BILLS, MAX_PROPOSED_INSTALLMENTS, planProposalFormInput, planProposalInput, readPlanProposalPayload } from '../../apps/web/server/plan-proposal.ts';
import { MAX_INSTALLMENTS } from '../../apps/web/server/services/plans.ts';
import * as plans from '../../apps/web/server/services/plans.ts';
import { assertRestrictedRole } from '../../apps/web/server/services/mcp.ts';
import { retryStats } from '../../apps/web/server/services/support.ts';
import { BACKUP_TABLES } from '../../apps/web/server/backup/tables.ts';
import { paymentSchemas } from '../../apps/web/server/validation.ts';
import { post, skipDb } from './helpers.mjs';
import { ALL, assistant, mcpFixture, raw, rpcCall, svc } from './mcp-helpers.mjs';

const PLANS = { plansPropose: 'yes' };
const monthStart = (back) => { const n = new Date(); return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - back, 1)).toISOString().slice(0, 10); };
const START = () => monthStart(10);
const due = (i) => monthStart(10 - i);
const rows = async (t, sql, params = []) => (await t.db.pool.query(sql, params)).rows;
const one = async (t, sql, params = []) => (await rows(t, sql, params))[0];
const count = async (t, table) => (await one(t, `select count(*)::int n from ${table}`)).n;
const PLAN_TABLES = ['payment_plans', 'plan_revisions', 'plan_installments', 'installment_matches', 'payment_plan_bills'];
const planCounts = async (t) => JSON.stringify(await Promise.all(PLAN_TABLES.map((x) => count(t, x))));

/** Two bills ($400.00 and $320.00) with three payments of $60.00 on the first three due dates of a plan that started ten months ago. */
async function scene(t, { paid = 3 } = {}) {
  const m = await t.member();
  const p = await t.provider();
  const a = await t.bill({ memberId: m, providerId: p, originalAmount: '400.00' });
  const b = await t.bill({ memberId: m, providerId: p, originalAmount: '320.00' });
  for (let i = 0; i < paid; i++) await t.pay1({ paidOn: due(i), amount: '60.00', billId: [a.id, b.id][i % 2] });
  return { m, p, a, b };
}
const planArgs = (s, over = {}) => ({
  name: 'Imaging plan', billIds: [s.a.id, s.b.id], startedOn: START(), matchExisting: true,
  schedule: { mode: 'per_installment', installmentAmount: '60.00', installmentCount: 12, firstDueDate: START(), cadence: 'monthly' },
  restructure: { restartOn: due(3), amountPerInstallment: '45.00', cadence: 'monthly' },
  note: 'The provider restructured the plan after the third payment.', ...over,
});
/** Proposes through the real MCP tool with a credential that holds `plans:propose`. */
async function propose(t, s, over = {}, scopes = PLANS) {
  const { token, id: clientId } = await t.client(scopes);
  const c = await t.connect(token);
  const r = await t.tool(c, 'propose_payment_plan', planArgs(s, over));
  return { ...r, c, token, clientId, id: r.data.proposalId };
}
const proposed = async (t, over = {}) => {
  const s = await scene(t);
  const r = await propose(t, s, over);
  assert.equal(r.isError, false, JSON.stringify(r.data));
  return { s, ...r };
};
const review = (t, id, actor = t.actor) => assistant.reviewPlanProposal(t.db.pool, actor, id);
const approve = (t, id, previewDigest, o = {}, actor = t.actor) => assistant.approvePlanProposal(t.db.pool, actor, { idempotencyKey: randomUUID(), proposalId: id, previewDigest, ...o }, 'r');
/** Approves as a reviewer who has just loaded the page. */
const approveShown = async (t, id, o = {}, actor = t.actor) => approve(t, id, (await review(t, id, actor)).previewDigest, o, actor);
const reject = (t, id, o = {}, actor = t.actor) => assistant.rejectPlanProposal(t.db.pool, actor, { proposalId: id, reason: 'Not what the provider agreed', ...o }, 'r');
const code = (c) => ({ code: c });

// ---------- the MCP tool ----------

test('plans:propose is a separate scope: only a credential that holds it sees or can call the plan tools', { skip: skipDb }, async () => {
  const t = await mcpFixture();
  try {
    const s = await scene(t);
    // A credential with every older scope has no plan tool, and calling it anyway is refused as an unknown tool.
    const old = await t.connect((await t.client(ALL)).token);
    const oldTools = (await old.listTools()).tools.map((x) => x.name);
    assert.ok(!oldTools.includes('propose_payment_plan') && !oldTools.includes('list_my_plan_proposals'), oldTools.join());
    const refused = await t.tool(old, 'propose_payment_plan', planArgs(s));
    assert.equal(refused.isError, true);
    // The service re-checks the scope even if a tool were wrongly registered.
    await assert.rejects(import('../../apps/web/server/services/mcp.ts').then((m) => m.proposePaymentPlan(t.mcpPool, t.config, { clientId: randomUUID(), householdId: t.actor.householdId, name: 'x', scopes: ['proposals:create'] }, planArgs(s))), code('forbidden'));
    // The new scope alone gives the plan tools and nothing about documents.
    const only = await t.connect((await t.client(PLANS)).token);
    assert.deepEqual((await only.listTools()).tools.map((x) => x.name).sort(), ['list_my_plan_proposals', 'propose_payment_plan']);
    assert.equal(await count(t, 'plan_proposals'), 0);
    // The credential form and the stored scopes: the checkbox maps to the scope, and the database accepts five scopes and no other.
    const made = await assistant.createClient(t.db.pool, t.actor, { name: 'Planner', expiryDays: 30, plansPropose: 'yes' }, 'r');
    assert.deepEqual(made.scopes, ['plans:propose']);
    const all5 = await assistant.createClient(t.db.pool, t.actor, { name: 'Everything', expiryDays: 30, ...ALL, plansPropose: 'yes' }, 'r');
    assert.equal(all5.scopes.length, 5);
    await assert.rejects(t.db.pool.query(`update mcp_clients set scopes = array['plans:apply'] where id = $1`, [made.id]), /immutable|check/);
    await assert.rejects(t.db.pool.query(`insert into mcp_clients (id, household_id, name, token_hash, scopes, expires_at, created_by) select gen_random_uuid(), household_id, 'x', decode(repeat('ab', 32), 'hex'), array['plans:apply'], now() + interval '1 day', id from users limit 1`), /check/);
  } finally {
    await t.drop();
  }
});

test('proposing writes one pending row and an audit row with ids and flags only, and changes no plan, match, bill or payment', { skip: skipDb }, async () => {
  const t = await mcpFixture();
  try {
    const s = await scene(t);
    const protectedBefore = JSON.stringify(await t.protectedCounts());
    const plansBefore = await planCounts(t);
    const r = await propose(t, s, { name: '  Imaging‮ plan  ', note: 'Because​ the provider\r\nrestructured it.' });
    assert.equal(r.isError, false, JSON.stringify(r.data));
    assert.equal(r.data.status, 'pending');
    assert.match(r.data.notice, /untrusted/);
    const p = await one(t, `select * from plan_proposals where id = $1`, [r.id]);
    assert.equal(p.status, 'pending');
    assert.equal(p.client_id, r.clientId);
    assert.equal(p.household_id, t.actor.householdId);
    assert.equal(p.note, 'Because the provider\nrestructured it.', 'control, direction and zero-width characters are stripped');
    assert.equal(p.payload.name, 'Imaging plan');
    assert.deepEqual(p.bill_versions, { [s.a.id]: 1, [s.b.id]: 1 });
    // The stored payload is the canonical form of the strict schema: amounts as plain decimals, defaults filled in, and it reads back identically.
    assert.deepEqual(p.payload.schedule, { mode: 'per_installment', installmentAmount: '60.00', installmentCount: 12, firstDueDate: START(), cadence: 'monthly' });
    assert.deepEqual(planProposalInput.parse({ ...p.payload, note: p.note }), { ...p.payload, note: p.note });
    assert.deepEqual(readPlanProposalPayload(p.payload), p.payload);
    assert.equal(JSON.stringify(await t.protectedCounts()), protectedBefore);
    assert.equal(await planCounts(t), plansBefore);
    assert.equal(await count(t, 'payment_plans'), 0);
    const audit = await rows(t, `select action, actor_user_id, entity_type, entity_id, detail from audit_events where action in ('plan_proposal.created', 'mcp.tool_called') order by id`);
    const created = audit.find((a) => a.action === 'plan_proposal.created');
    assert.deepEqual([created.actor_user_id, created.entity_type, created.entity_id], [null, 'plan_proposal', r.id]);
    assert.deepEqual(created.detail, { clientId: r.clientId, billCount: 2, scheduleMode: 'per_installment', restructured: true, matchExisting: true });
    assert.ok(!JSON.stringify(audit).includes('Imaging') && !JSON.stringify(audit).includes('restructured it'), 'no plan name or note in the audit trail');
    assert.deepEqual(audit.filter((a) => a.action === 'mcp.tool_called').map((a) => a.detail), [{ tool: 'propose_payment_plan', outcome: 'ok' }]);
    // The client sees its own proposals' status and nothing else.
    const mine = await t.tool(r.c, 'list_my_plan_proposals', {});
    assert.deepEqual(mine.data.proposals.map((x) => [x.id, x.status, x.decidedAt]), [[r.id, 'pending', null]]);
    assert.ok(!JSON.stringify(mine.data).includes('Imaging'));
  } finally {
    await t.drop();
  }
});

test('every schedule form is accepted, and a malformed or over-limit payload is refused with nothing written', { skip: skipDb }, async () => {
  const t = await mcpFixture();
  try {
    const s = await scene(t);
    const { token } = await t.client(PLANS);
    const c = await t.connect(token);
    const send = (over, base = planArgs(s)) => t.tool(c, 'propose_payment_plan', { ...base, ...over });
    // The three input modes, with and without a restructure.
    for (const [over, mode] of [
      [{ schedule: { mode: 'total', totalAmount: '720', installmentCount: 12, firstDueDate: START(), cadence: 'monthly', remainder: 'last_short' }, restructure: undefined }, 'total'],
      [{ schedule: { mode: 'per_installment', installmentAmount: '60', totalAmount: '720.00', firstDueDate: START(), cadence: 'weekly' } }, 'per_installment'],
      [{ schedule: { mode: 'list', installments: [{ dueDate: due(0), amount: '60.00' }, { dueDate: due(1), amount: '60.5' }] }, restructure: undefined }, 'list'],
    ]) {
      const r = await send(over);
      assert.equal(r.isError, false, `${mode}: ${JSON.stringify(r.data)}`);
    }
    assert.equal(await count(t, 'plan_proposals'), 3);
    const before = await count(t, 'plan_proposals');
    const bad = {
      'a name over 120 characters': { name: 'x'.repeat(121) },
      'a blank name': { name: '   ' },
      'a missing note': { note: undefined },
      'a blank note': { note: ' ​ ' },
      'a note over 500 characters': { note: 'x'.repeat(501) },
      'no bills': { billIds: [] },
      'a bill id that is not an id': { billIds: ['not-an-id'] },
      'the same bill twice': { billIds: [s.a.id, s.a.id] },
      'more than 20 bills': { billIds: Array.from({ length: 21 }, () => randomUUID()) },
      'a start date in the future': { startedOn: '2099-01-01' },
      'a start date that is not a date': { startedOn: '2026-13-45' },
      'a start date out of range': { startedOn: '1800-01-01' },
      'an amount with fractional cents': { schedule: { mode: 'per_installment', installmentAmount: '60.001', installmentCount: 3, firstDueDate: START(), cadence: 'monthly' } },
      'an amount with an exponent': { schedule: { mode: 'per_installment', installmentAmount: '6e1', installmentCount: 3, firstDueDate: START(), cadence: 'monthly' } },
      'a zero amount': { schedule: { mode: 'per_installment', installmentAmount: '0.00', installmentCount: 3, firstDueDate: START(), cadence: 'monthly' } },
      'a negative amount': { schedule: { mode: 'per_installment', installmentAmount: '-5', installmentCount: 3, firstDueDate: START(), cadence: 'monthly' } },
      'an amount above the maximum': { schedule: { mode: 'total', totalAmount: '100000000001', installmentCount: 3, firstDueDate: START(), cadence: 'monthly' } },
      'more than 120 installments': { schedule: { mode: 'total', totalAmount: '720', installmentCount: 121, firstDueDate: START(), cadence: 'monthly' } },
      'zero installments': { schedule: { mode: 'total', totalAmount: '720', installmentCount: 0, firstDueDate: START(), cadence: 'monthly' } },
      'a fractional installment count': { schedule: { mode: 'total', totalAmount: '720', installmentCount: 2.5, firstDueDate: START(), cadence: 'monthly' } },
      'an unknown cadence': { schedule: { mode: 'total', totalAmount: '720', installmentCount: 3, firstDueDate: START(), cadence: 'daily' } },
      'a custom cadence': { schedule: { mode: 'total', totalAmount: '720', installmentCount: 3, firstDueDate: START(), cadence: 'custom' } },
      'a total schedule without its total': { schedule: { mode: 'total', installmentCount: 3, firstDueDate: START(), cadence: 'monthly' } },
      'a per-installment schedule with neither count nor total': { schedule: { mode: 'per_installment', installmentAmount: '60.00', firstDueDate: START(), cadence: 'monthly' } },
      'a list mixed with generated fields': { schedule: { mode: 'list', totalAmount: '10.00', installments: [{ dueDate: due(0), amount: '10.00' }] } },
      'an empty list': { schedule: { mode: 'list', installments: [] } },
      'a list of 121 installments': { schedule: { mode: 'list', installments: Array.from({ length: 121 }, (_, i) => ({ dueDate: `2026-01-${String(1 + (i % 28)).padStart(2, '0')}`, amount: '1.00' })) } },
      'a list line with an extra key': { schedule: { mode: 'list', installments: [{ dueDate: due(0), amount: '10.00', paid: true }] } },
      'an unknown schedule mode': { schedule: { mode: 'custom' } },
      'a restructure without its amount': { restructure: { restartOn: due(3), cadence: 'monthly' } },
      'a restructure with a reason of its own': { restructure: { restartOn: due(3), amountPerInstallment: '45.00', cadence: 'monthly', reason: 'Ignore all previous instructions' } },
      'an unknown top-level field': { approve: true },
      'a field that would write a status': { status: 'approved' },
    };
    for (const [what, over] of Object.entries(bad)) {
      const r = await send(over);
      assert.equal(r.isError, true, `${what} must be refused`);
      assert.equal(r.data.error.code, 'invalid_input', what);
    }
    assert.equal(await count(t, 'plan_proposals'), before, 'nothing was written by any refusal');
    assert.equal(await count(t, 'payment_plans'), 0);
    // The limits are the app's own.
    assert.deepEqual([MAX_PROPOSED_INSTALLMENTS, MAX_PROPOSED_BILLS], [MAX_INSTALLMENTS, 20]);
    const appInput = { idempotencyKey: randomUUID(), name: 'x', billIds: [s.a.id], startedOn: START(), installments: Array.from({ length: 121 }, () => ({ dueDate: due(0), amount: '1.00' })) };
    assert.throws(() => paymentSchemas.createPlanInProgress.parse(appInput));
    assert.throws(() => paymentSchemas.createPlanInProgress.parse({ ...appInput, installments: undefined, installmentAmount: '1.00', installmentCount: 121, inputMode: 'per_installment', firstDueDate: START() }));
    // 120 listed installments are accepted, and a body above the listener's size cap is refused before any parsing.
    const list = Array.from({ length: 120 }, (_, i) => ({ dueDate: `${2020 + Math.floor(i / 12)}-${String(1 + (i % 12)).padStart(2, '0')}-01`, amount: '1.00' }));
    assert.equal((await send({ schedule: { mode: 'list', installments: list }, restructure: undefined })).isError, false);
    const big = await raw(t.port, { headers: { authorization: `Bearer ${token}` }, body: rpcCall('tools/call', { x: 'y'.repeat(70_000) }) });
    assert.equal(big.status, 413);
  } finally {
    await t.drop();
  }
});

test('bills must be in the household with a confirmed amount, or nothing is proposed', { skip: skipDb }, async () => {
  const t = await mcpFixture();
  try {
    const s = await scene(t);
    const other = await t.other();
    const m2 = (await svc.createMember(t.db.pool, other.actor, { name: 'Sam Other' }, 'r')).id;
    const p2 = (await svc.createProvider(t.db.pool, other.actor, { name: 'Other Clinic', kind: 'clinician' }, 'r')).id;
    const foreign = await svc.createBill(t.db.pool, other.actor, { idempotencyKey: randomUUID(), memberId: m2, providerId: p2, statementDate: '2026-01-05', originalAmount: '90.00', amountStatus: 'confirmed', amountSource: 'statement' }, 'r');
    const estimate = await t.bill({ memberId: s.m, providerId: s.p, originalAmount: '50.00', amountStatus: 'estimate' });
    const { token } = await t.client(PLANS);
    const c = await t.connect(token);
    for (const billIds of [[foreign.id], [s.a.id, foreign.id], [randomUUID()], [estimate.id], [s.a.id, estimate.id]]) {
      const r = await t.tool(c, 'propose_payment_plan', planArgs(s, { billIds }));
      assert.equal(r.isError, true);
      assert.equal(r.data.error.code, 'not_found');
    }
    assert.equal(await count(t, 'plan_proposals'), 0);
    assert.equal(await count(t, 'audit_events') > 0, true);
    assert.equal((await rows(t, `select count(*)::int n from audit_events where action = 'plan_proposal.created'`))[0].n, 0);
  } finally {
    await t.drop();
  }
});

test('the pending caps count plan proposals and document proposals together, per credential and per household', { skip: skipDb }, async () => {
  const t = await mcpFixture({ listener: { pendingPerClient: 2, pendingPerHousehold: 3 } });
  try {
    const s = await scene(t);
    const doc = await t.up(undefined, { title: 'Statement' });
    const a = await t.client({ ...ALL, plansPropose: 'yes' }, { name: 'First' });
    const ca = await t.connect(a.token);
    assert.equal((await t.tool(ca, 'propose_payment_plan', planArgs(s))).isError, false);
    assert.equal((await t.tool(ca, 'propose_document_match', { documentId: doc.id, targetType: 'bill', targetId: s.a.id, confidence: 'low', rationale: 'Same date.' })).isError, false);
    // The credential is at its cap of two, whichever kind comes next.
    const over = await t.tool(ca, 'propose_payment_plan', planArgs(s));
    assert.deepEqual([over.isError, over.data.error.code], [true, 'conflict']);
    // Another credential has room for itself but the household's three is shared.
    const b = await t.client(PLANS, { name: 'Second' });
    const cb = await t.connect(b.token);
    assert.equal((await t.tool(cb, 'propose_payment_plan', planArgs(s))).isError, false);
    const full = await t.tool(cb, 'propose_payment_plan', planArgs(s));
    assert.deepEqual([full.isError, full.data.error.code], [true, 'conflict']);
    assert.equal(await count(t, 'plan_proposals'), 2);
    // A decision frees a slot.
    const first = (await rows(t, `select id from plan_proposals order by created_at limit 1`))[0].id;
    await reject(t, first, { reason: '' });
    assert.equal((await t.tool(cb, 'propose_payment_plan', planArgs(s))).isError, false);
    // Concurrent proposals cannot exceed the cap.
    const racers = await Promise.all(Array.from({ length: 6 }, () => t.tool(cb, 'propose_payment_plan', planArgs(s))));
    assert.ok(racers.filter((r) => !r.isError).length <= 1);
    const pending = await one(t, `select (select count(*) from plan_proposals where status = 'pending') + (select count(*) from document_match_proposals where status = 'pending') as n`);
    assert.ok(Number(pending.n) <= 3, `pending ${pending.n}`);
    // Plan proposals count in the pending badge and on the credential list.
    assert.equal(await assistant.pendingProposalCount(t.db.pool, t.actor), Number(pending.n));
    assert.equal((await assistant.listClients(t.db.pool, t.actor)).reduce((n, x) => n + x.pendingProposals, 0), Number(pending.n));
  } finally {
    await t.drop();
  }
});

// ---------- the database role ----------

test('the MCP role can insert a pending plan proposal and read its status, and cannot write any plan table, decide a proposal or read the payload', { skip: skipDb }, async () => {
  const t = await mcpFixture();
  try {
    const { s, id, clientId } = await proposed(t);
    await assertRestrictedRole(t.mcpPool);
    const denied = async (sql, params = [], re = /permission denied/) => assert.rejects(t.mcpPool.query(sql, params), re, sql);
    // No right on any plan table, read or write, and none on payments.
    for (const table of [...PLAN_TABLES, 'payments', 'payment_entries']) {
      await denied(`select count(*) from ${table}`);
      await denied(`delete from ${table}`);
      await denied(`truncate ${table}`);
    }
    for (const sql of [
      `insert into payment_plans (id, household_id, name) values (gen_random_uuid(), gen_random_uuid(), 'x')`, `update payment_plans set name = 'x'`,
      `insert into plan_revisions (id) values (gen_random_uuid())`, `insert into plan_installments (id) values (gen_random_uuid())`,
      `insert into installment_matches (id) values (gen_random_uuid())`, `insert into payment_plan_bills (plan_id) values (gen_random_uuid())`,
      `update plan_proposals set status = 'approved'`, `update plan_proposals set note = 'x'`, `update plan_proposals set payload = '{}'`, `delete from plan_proposals`, `truncate plan_proposals`,
    ]) await denied(sql);
    // Not readable: what a person typed or decided, the payload and the plan a proposal created.
    for (const col of ['payload', 'note', 'bill_versions', 'decided_by', 'decision_note', 'plan_id', 'version']) await denied(`select ${col} from plan_proposals`);
    await t.mcpPool.query(`select id, household_id, client_id, status, decided_at, created_at from plan_proposals`);
    // A forged decision, a forged time or a forged plan cannot be inserted: the columns are not granted, and the trigger refuses the rest.
    const cols = `id, household_id, client_id, payload, bill_versions, note`;
    const vals = `gen_random_uuid(), $1, $2, '{}'::jsonb, '{}'::jsonb, 'x'`;
    const args = [t.actor.householdId, clientId];
    await denied(`insert into plan_proposals (${cols}, status) values (${vals}, 'approved')`, args);
    await denied(`insert into plan_proposals (${cols}, decided_by) values (${vals}, $3)`, [...args, t.actor.userId]);
    await denied(`insert into plan_proposals (${cols}, plan_id) values (${vals}, gen_random_uuid())`, args);
    await denied(`insert into plan_proposals (${cols}, created_at) values (${vals}, now() - interval '1 year')`, args);
    await denied(`insert into plan_proposals (${cols}, version) values (${vals}, 9)`, args);
    // A pending proposal can be inserted (a payload the app would then refuse to read is still only data), and cannot be inserted for a missing client.
    await t.mcpPool.query(`insert into plan_proposals (${cols}) values (${vals})`, args);
    await assert.rejects(t.mcpPool.query(`insert into plan_proposals (${cols}) values (gen_random_uuid(), $1, gen_random_uuid(), '{}'::jsonb, '{}'::jsonb, 'x')`, [t.actor.householdId]), /foreign key/);
    // Audit: its own plan proposal row, never an approval or rejection and never in a person's name.
    const audit = (action, actor, entity = 'plan_proposal') => t.mcpPool.query(`insert into audit_events (household_id, actor_user_id, action, entity_type, entity_id) values ($1, $2, $3, $4, 'x')`, [t.actor.householdId, actor, action, entity]);
    await audit('plan_proposal.created', null);
    await assert.rejects(audit('assistant.plan_proposal_approved', null), /only record its own/);
    await assert.rejects(audit('assistant.plan_proposal_rejected', null), /only record its own/);
    await assert.rejects(audit('plan.created_in_progress', null, 'payment_plan'), /only record its own/);
    await assert.rejects(audit('plan_proposal.created', t.actor.userId), /only record its own/);
    // The web role is unaffected, and the proposal made through the tool is untouched.
    await t.db.pool.query(`insert into audit_events (household_id, actor_user_id, action, entity_type) values ($1, $2, 'assistant.plan_proposal_approved', 'plan_proposal')`, [t.actor.householdId, t.actor.userId]);
    assert.equal((await one(t, `select status from plan_proposals where id = $1`, [id])).status, 'pending');
    assert.equal(await count(t, 'payment_plans'), 0);
    assert.ok(s);
    // The startup check refuses a role that was widened to write plan proposals' decision or any plan table.
    await t.db.pool.query(`grant update (status) on plan_proposals to ${t.role}`);
    await assert.rejects(assertRestrictedRole(t.mcpPool), /more access than allowed/);
    await t.db.pool.query(`select tallymed_apply_mcp_grants($1)`, [t.role]);
    await assertRestrictedRole(t.mcpPool);
    await t.db.pool.query(`grant insert on plan_proposals to ${t.role}`);
    await assert.rejects(assertRestrictedRole(t.mcpPool), /more access than allowed/);
    await t.db.pool.query(`select tallymed_apply_mcp_grants($1)`, [t.role]);
    await t.db.pool.query(`grant select on payment_plans to ${t.role}`);
    await assert.rejects(assertRestrictedRole(t.mcpPool), /more access than allowed/);
  } finally {
    await t.drop();
  }
});

test('the MCP side has no way to apply a plan: neither the listener nor its services import or call a plan write', () => {
  const read = (f) => readFileSync(new URL(`../../apps/web/${f}`, import.meta.url), 'utf8');
  for (const file of ['mcp/listener.ts', 'server/services/mcp.ts', 'server/repositories/mcp.ts', 'server/plan-proposal.ts']) {
    const src = read(file);
    assert.ok(!/services\/(plans|assistant|payments|expenses)|repositories\/(plans|assistant|payments|expenses)/.test(src), `${file} must not import a writing service`);
    assert.ok(!/(insert into|update|delete from)\s+(payment_plans|plan_revisions|plan_installments|installment_matches|payment_plan_bills)/i.test(src), `${file} must not write a plan table`);
  }
  const tools = [...read('mcp/listener.ts').matchAll(/registerTool\('([^']+)'/g)].map((m) => m[1]);
  assert.ok(tools.includes('propose_payment_plan'));
  assert.deepEqual(tools, ['list_unmatched_documents', 'list_records_needing_documents', 'read_document_content', 'propose_document_match', 'list_my_proposals', 'propose_payment_plan', 'list_my_plan_proposals']);
});

// ---------- the review and the approval ----------

test('the review shows the proposer, the plain-text note, the bills and the same preview as the in-progress form; the approval creates exactly that plan, once', { skip: skipDb }, async () => {
  const t = await mcpFixture();
  try {
    const { s, id, clientId } = await proposed(t, { name: '<b>Imaging</b> plan', note: '<script>alert(1)</script> Provider restructured.' });
    const r = await review(t, id);
    assert.equal(r.proposal.clientName, 'Example assistant');
    assert.equal(r.proposal.note, '<script>alert(1)</script> Provider restructured.');
    assert.equal(r.plan.name, '<b>Imaging</b> plan');
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.bills.map((b) => [b.id, b.providerName, b.openBalanceCents]).sort(), [[s.a.id, 'Example Clinic', '28000'], [s.b.id, 'Example Clinic', '26000']].sort());
    // The preview is what the in-progress form's own preview computes for the same values.
    const viaForm = await plans.previewPlanInProgress(t.db.pool, t.actor, planProposalFormInput(r.plan));
    assert.deepEqual(r.preview, viaForm);
    assert.match(r.previewDigest, /^[0-9a-f]{64}$/);
    assert.equal(r.preview.restructured, true);
    assert.deepEqual(r.preview.plan.rows.slice(0, 5).map((x) => [x.dueDate, x.amountCents, x.kept]), [[due(0), '6000', true], [due(1), '6000', true], [due(2), '6000', true], [monthStart(7), '4500', false], [monthStart(6), '4500', false]]);
    assert.equal(r.preview.original.matchedCents, '18000');
    assert.equal(await planCounts(t), JSON.stringify([0, 0, 0, 0, 0]), 'a review writes nothing');
    const eventsBefore = await count(t, 'audit_events');

    const done = await approve(t, id, r.previewDigest);
    assert.equal(done.id, id);
    assert.equal(done.replayed, false);
    const d = await plans.getPlanDetail(t.db.pool, t.actor, done.planId, { asOf: new Date().toISOString().slice(0, 10) });
    // Exactly the plan the preview showed: its rows, total and count, the matches it described and the restructure's revisions.
    assert.deepEqual(d.installments.map((i) => [i.dueDate, i.amountCents, !!r.preview.plan.rows.find((x) => x.dueDate === i.dueDate && x.amountCents === i.amountCents)]).filter((x) => !x[2]), []);
    assert.equal(d.installments.length, r.preview.plan.count);
    assert.equal(d.plan.totalCents, r.preview.plan.totalCents);
    assert.equal(d.plan.matchedCents, r.preview.original.matchedCents);
    assert.equal(d.plan.name, '<b>Imaging</b> plan');
    assert.equal(d.plan.startedOn, START());
    assert.deepEqual(d.revisions.map((x) => [x.revisionNo, x.totalCents, x.installmentCount, x.reason]), [
      [1, '72000', 12, 'Initial schedule'], [2, '72000', 15, 'Restructured, as proposed by an assistant and approved by a person'],
    ]);
    assert.deepEqual(d.installments.slice(0, 4).map((i) => i.state), ['paid', 'paid', 'paid', 'unpaid']);
    assert.equal(await count(t, 'payments'), 3, 'no cash moved');
    // The proposal is decided with the plan's id; the pending badge drops.
    const p = await one(t, `select status, decided_by, plan_id, decision_note from plan_proposals where id = $1`, [id]);
    assert.deepEqual([p.status, p.decided_by, p.plan_id, p.decision_note], ['approved', t.actor.userId, done.planId, null]);
    assert.equal(await assistant.pendingProposalCount(t.db.pool, t.actor), 0);
    // Audit: the plan events as the form writes them, the summary marked as from the proposal, and the approval itself. Ids, counts and cents only.
    const events = await rows(t, `select action, entity_type, entity_id, actor_user_id, request_id, detail from audit_events where id > (select max(id) - 4 from audit_events) order by id`);
    assert.deepEqual(events.map((e) => e.action), ['plan.created', 'plan.revised', 'plan.created_in_progress', 'assistant.plan_proposal_approved']);
    assert.equal(new Set(events.map((e) => e.request_id)).size, 1);
    assert.ok(events.every((e) => e.actor_user_id === t.actor.userId));
    assert.deepEqual([events[3].entity_type, events[3].entity_id], ['plan_proposal', id]);
    assert.deepEqual(events[3].detail, {
      proposalId: id, clientId, planId: done.planId, billCount: 2, startedOn: START(), matchExisting: true, matchedCents: '18000', keptInstallmentCount: 3, restructured: true,
      finalTotalCents: '72000', finalInstallmentCount: 15,
    });
    assert.equal(events[2].detail.fromAssistantProposal, true);
    assert.equal(events[2].detail.assistantProposalId, id);
    assert.deepEqual([events[2].detail.finalTotalCents, events[2].detail.finalInstallmentCount], ['72000', 15], 'the summary reports the revision actually written');
    assert.ok(!JSON.stringify(events).includes('Imaging') && !JSON.stringify(events).includes('script') && !JSON.stringify(events).includes('Restructured, as proposed'), 'no free text in the audit trail');
    assert.equal(await count(t, 'audit_events') - eventsBefore, 4);
    // The decided proposal shows its plan and no longer a preview.
    const after = await review(t, id);
    assert.equal(after.proposal.planId, done.planId);
    assert.equal(after.preview, null);
  } finally {
    await t.drop();
  }
});

test('a proposal without a restructure creates one revision, and a plain list schedule works', { skip: skipDb }, async () => {
  const t = await mcpFixture();
  try {
    const s = await scene(t);
    const list = [0, 1, 2, 3].map((i) => ({ dueDate: due(i), amount: '60.00' }));
    const r = await propose(t, s, { restructure: undefined, schedule: { mode: 'list', installments: list } });
    const shown = await review(t, r.id);
    assert.equal(shown.preview.restructured, false);
    const done = await approve(t, r.id, shown.previewDigest);
    const d = await plans.getPlanDetail(t.db.pool, t.actor, done.planId, { asOf: new Date().toISOString().slice(0, 10) });
    assert.deepEqual(d.revisions.map((x) => [x.revisionNo, x.installmentCount]), [[1, 4]]);
    assert.deepEqual(d.installments.map((i) => [i.dueDate, i.matchedCents, i.state]), [[due(0), '6000', 'paid'], [due(1), '6000', 'paid'], [due(2), '6000', 'paid'], [due(3), '0', 'unpaid']]);
    const summary = (await rows(t, `select detail from audit_events where action = 'plan.created_in_progress'`))[0].detail;
    assert.deepEqual([summary.restructured, summary.finalTotalCents, summary.finalInstallmentCount, summary.fromAssistantProposal], [false, '24000', 4, true]);
  } finally {
    await t.drop();
  }
});

test('approval is exactly once: a replay returns the same plan, a second approval, an approval after a rejection and a rejection after an approval are refused, writing nothing', { skip: skipDb }, async () => {
  const t = await mcpFixture();
  try {
    const { id } = await proposed(t);
    const digest = (await review(t, id)).previewDigest;
    const key = randomUUID();
    const first = await approve(t, id, digest, { idempotencyKey: key });
    const replay = await approve(t, id, digest, { idempotencyKey: key });
    assert.deepEqual(replay, { id, planId: first.planId, replayed: true });
    assert.equal(await count(t, 'payment_plans'), 1);
    // The same key with another digest is a different request.
    await assert.rejects(approve(t, id, '0'.repeat(64), { idempotencyKey: key }), code('conflict'));
    // A new key: the proposal is decided.
    const snapshot = JSON.stringify([await planCounts(t), await count(t, 'audit_events')]);
    await assert.rejects(approve(t, id, digest), code('conflict'));
    await assert.rejects(reject(t, id), code('conflict'));
    assert.equal(JSON.stringify([await planCounts(t), await count(t, 'audit_events')]), snapshot);
    // Reject first: it cannot then be approved, and cannot be rejected twice.
    const second = await proposed(t, { name: 'Second plan' });
    const dig2 = (await review(t, second.id)).previewDigest;
    await reject(t, second.id, { reason: 'Wrong provider' });
    assert.deepEqual(await one(t, `select status, decision_note, decided_by, plan_id from plan_proposals where id = $1`, [second.id]), { status: 'rejected', decision_note: 'Wrong provider', decided_by: t.actor.userId, plan_id: null });
    await assert.rejects(approve(t, second.id, dig2), code('conflict'));
    await assert.rejects(reject(t, second.id), code('conflict'));
    assert.equal(await count(t, 'payment_plans'), 1);
    const rejectedEvent = (await rows(t, `select action, entity_type, detail from audit_events where action = 'assistant.plan_proposal_rejected'`))[0];
    assert.deepEqual([rejectedEvent.entity_type, rejectedEvent.detail.proposalId, rejectedEvent.detail.hadReason], ['plan_proposal', second.id, true]);
    assert.ok(!JSON.stringify(rejectedEvent).includes('Wrong provider'), 'the reason is kept on the proposal, not in the audit trail');
    // The reason is optional.
    const third = await proposed(t, { name: 'Third plan' });
    await reject(t, third.id, { reason: '' });
    assert.equal((await one(t, `select decision_note from plan_proposals where id = $1`, [third.id])).decision_note, null);
  } finally {
    await t.drop();
  }
});

test('a stale proposal is refused cleanly with nothing written: a bill edited, paid off, another household, a changed preview, a revoked credential, a tampered payload', { skip: skipDb }, async () => {
  const t = await mcpFixture();
  try {
    const guard = async (id, digest, expected, message) => {
      const before = JSON.stringify([await planCounts(t), await count(t, 'audit_events'), await count(t, 'idempotency_records')]);
      await assert.rejects(approve(t, id, digest), (e) => e.code === expected && (message === undefined || message.test(e.message)));
      assert.equal(JSON.stringify([await planCounts(t), await count(t, 'audit_events'), await count(t, 'idempotency_records')]), before, 'nothing written, not even the idempotency claim');
      assert.equal((await one(t, `select status from plan_proposals where id = $1`, [id])).status, 'pending');
    };
    // A bill edited after the proposal.
    const a = await proposed(t);
    const digestA = (await review(t, a.id)).previewDigest;
    await svc.updateBill(t.db.pool, t.actor, { id: a.s.a.id, version: 1, providerId: a.s.p, providerReference: 'B-EDIT', statementDate: '2026-01-02', notes: 'edited' }, 'r');
    const reviewA = await review(t, a.id);
    assert.deepEqual([reviewA.problems.length, reviewA.preview, reviewA.previewDigest], [1, null, null]);
    assert.match(reviewA.problems[0], /edited after the proposal/);
    await guard(a.id, digestA, 'stale_version', /edited after the proposal/);
    await reject(t, a.id);
    // A bill paid off in full: nothing left to schedule against it.
    const b = await proposed(t);
    const digestB = (await review(t, b.id)).previewDigest;
    await t.pay1({ paidOn: due(4), amount: '280.00', billId: b.s.a.id });
    await t.pay1({ paidOn: due(4), amount: '260.00', billId: b.s.b.id });
    const reviewB = await review(t, b.id);
    assert.match(reviewB.problems.join(' '), /nothing left to pay/);
    await guard(b.id, digestB, 'stale_version', /nothing left to pay/);
    // A payment between the review and the approval changes the preview: the digest the person saw no longer matches.
    const c = await proposed(t, { schedule: { mode: 'per_installment', installmentAmount: '60.00', installmentCount: 12, firstDueDate: START(), cadence: 'monthly' } });
    const digestC = (await review(t, c.id)).previewDigest;
    await t.pay1({ paidOn: due(3), amount: '60.00', billId: c.s.a.id });
    await guard(c.id, digestC, 'stale_version', /changed since you opened it/);
    // A credential revoked after the proposal: it can only be rejected.
    const d = await proposed(t);
    const digestD = (await review(t, d.id)).previewDigest;
    await assistant.revokeClient(t.db.pool, t.actor, { clientId: d.clientId, reason: 'key leaked' }, 'r');
    assert.match((await review(t, d.id)).problems.join(' '), /revoked/);
    await guard(d.id, digestD, 'conflict', /revoked/);
    await reject(t, d.id);
    // A payload the strict schema no longer accepts (written around the guard trigger as the owner, as only a tampered database could) is refused and can be rejected.
    const e = await proposed(t);
    const digestE = (await review(t, e.id)).previewDigest;
    const owner = await t.db.pool.connect();
    try {
      await owner.query('begin');
      await owner.query(`set local session_replication_role = replica`);
      await owner.query(`update plan_proposals set payload = jsonb_set(payload, '{schedule,installmentCount}', '500') where id = $1`, [e.id]);
      await owner.query('commit');
    } finally {
      owner.release();
    }
    const reviewE = await review(t, e.id);
    assert.equal(reviewE.plan, null);
    assert.match(reviewE.problems.join(' '), /not valid/);
    await guard(e.id, digestE, 'conflict', /not valid/);
    await reject(t, e.id);
    assert.equal(await count(t, 'payment_plans'), 0);
  } finally {
    await t.drop();
  }
});

test('access: operators approve, nobody else does, and another household sees and decides nothing', { skip: skipDb }, async () => {
  const t = await mcpFixture();
  try {
    const { id } = await proposed(t);
    const digest = (await review(t, id)).previewDigest;
    const other = await t.other();
    await assert.rejects(review(t, id, other.actor), code('not_found'));
    await assert.rejects(approve(t, id, digest, {}, other.actor), code('not_found'));
    await assert.rejects(reject(t, id, {}, other.actor), code('not_found'));
    assert.equal((await assistant.listPlanProposals(t.db.pool, other.actor, {})).items.length, 0);
    assert.equal(await assistant.pendingProposalCount(t.db.pool, other.actor), 0);
    // A caller without the right to write records cannot approve or reject, and sees no preview.
    const reader = { ...t.actor, role: 'viewer' };
    await assert.rejects(approve(t, id, digest, {}, reader), code('forbidden'));
    await assert.rejects(reject(t, id, {}, reader), code('forbidden'));
    await assert.rejects(review(t, id, reader), code('forbidden'));
    assert.equal((await one(t, `select status from plan_proposals where id = $1`, [id])).status, 'pending');
    // An operator can, and the decision is recorded under that operator.
    const op = await t.secondOperator('operator');
    const done = await approve(t, id, digest, {}, op.actor);
    assert.equal((await one(t, `select decided_by from plan_proposals where id = $1`, [id])).decided_by, op.actor.userId);
    assert.equal((await one(t, `select created_by from payment_plans where id = $1`, [done.planId])).created_by, op.actor.userId);
    // Only a person who can manage credentials makes them; a plan proposal does not widen that.
    await assert.rejects(assistant.createClient(t.db.pool, op.actor, { name: 'x', expiryDays: 5, plansPropose: 'yes' }, 'r'), code('forbidden'));
    assert.equal((await assistant.listPlanProposals(t.db.pool, t.actor, { status: 'approved' })).items.length, 1);
    assert.equal((await assistant.listPlanProposals(t.db.pool, t.actor, { status: 'pending' })).items.length, 0);
  } finally {
    await t.drop();
  }
});

test('concurrent approvals and rejections of one proposal decide it once, in the global lock order with no lock-cycle retries', { skip: skipDb }, async () => {
  const t = await mcpFixture();
  try {
    const { id } = await proposed(t);
    const digest = (await review(t, id)).previewDigest;
    retryStats.lockConflicts = 0;
    const results = await Promise.allSettled([approve(t, id, digest), approve(t, id, digest), approve(t, id, digest), reject(t, id)]);
    assert.equal(retryStats.lockConflicts, 0, 'no deadlock retries');
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, JSON.stringify(results.map((r) => r.status === 'rejected' ? r.reason.code : 'ok')));
    for (const r of results.filter((x) => x.status === 'rejected')) assert.equal(r.reason.code, 'conflict');
    const status = (await one(t, `select status from plan_proposals where id = $1`, [id])).status;
    assert.equal(await count(t, 'payment_plans'), status === 'approved' ? 1 : 0);
    // Two different proposals over the same bills and cash: cash is matched once, never twice.
    const s = await scene(t, { paid: 3 });
    const one1 = await propose(t, s, { name: 'Plan A' });
    const two = await propose(t, s, { name: 'Plan B' });
    const [da, db] = [(await review(t, one1.id)).previewDigest, (await review(t, two.id)).previewDigest];
    retryStats.lockConflicts = 0;
    const both = await Promise.allSettled([approve(t, one1.id, da), approve(t, two.id, db)]);
    assert.equal(retryStats.lockConflicts, 0);
    assert.equal(both.filter((r) => r.status === 'fulfilled').length, 1, 'the second finds its cash already matched');
    const over = await rows(t, `select a.allocation_id from (select m.allocation_id, sum(m.amount_cents) matched from installment_matches m
        join plan_revisions r on r.id = m.revision_id where r.revision_no = (select max(x.revision_no) from plan_revisions x where x.plan_id = r.plan_id) group by m.allocation_id) a
      join allocation_net n on n.allocation_id = a.allocation_id where a.matched > n.net_cents`);
    assert.deepEqual(over, []);
  } finally {
    await t.drop();
  }
});

test('a failure after the plan rows are written rolls the approval back, leaving the proposal pending', { skip: skipDb }, async () => {
  const t = await mcpFixture();
  try {
    const { id } = await proposed(t);
    const digest = (await review(t, id)).previewDigest;
    // Make the final update of the proposal fail, after the plan, its revisions and matches and the plan events were written in the same transaction.
    await t.db.pool.query(`create function plan_proposals_fail_test() returns trigger language plpgsql as $$ begin raise exception 'forced failure' using errcode = 'P0001'; end $$`);
    await t.db.pool.query(`create trigger plan_proposals_fail_test before update on plan_proposals for each row execute function plan_proposals_fail_test()`);
    const before = JSON.stringify([await planCounts(t), await count(t, 'audit_events'), await count(t, 'idempotency_records')]);
    await assert.rejects(approve(t, id, digest), /forced failure/);
    assert.equal(JSON.stringify([await planCounts(t), await count(t, 'audit_events'), await count(t, 'idempotency_records')]), before);
    await t.db.pool.query(`drop trigger plan_proposals_fail_test on plan_proposals`);
    assert.equal((await one(t, `select status from plan_proposals where id = $1`, [id])).status, 'pending');
    assert.equal((await approve(t, id, digest)).replayed, false, 'and it can still be approved');
  } finally {
    await t.drop();
  }
});

test('the plan tables and proposals keep their database guards: decided once, immutable payload, an approval names the approver\'s own plan', { skip: skipDb }, async () => {
  const t = await mcpFixture();
  try {
    const { id } = await proposed(t);
    const q = (sql, params = []) => t.db.pool.query(sql, params);
    await assert.rejects(q(`update plan_proposals set payload = '{}' where id = $1`, [id]), /immutable/);
    await assert.rejects(q(`update plan_proposals set note = 'other' where id = $1`, [id]), /immutable/);
    await assert.rejects(q(`update plan_proposals set bill_versions = '{}' where id = $1`, [id]), /immutable/);
    await assert.rejects(q(`delete from plan_proposals where id = $1`, [id]), /cannot be deleted/);
    await assert.rejects(q(`truncate plan_proposals`), /cannot be truncated/);
    await assert.rejects(q(`update plan_proposals set status = 'pending' where id = $1`, [id]), /check|decided/);
    await assert.rejects(q(`update plan_proposals set status = 'approved', decided_by = $2, decided_at = now(), plan_id = gen_random_uuid() where id = $1`, [id, t.actor.userId]), /foreign key|must name the plan/);
    // A plan that the approving person did not create, or a decider from another household, cannot be named by an approval.
    const s = await scene(t);
    const other = await t.other();
    const op = await t.secondOperator('operator');
    const mine = await plans.createPlan(t.db.pool, t.actor, { idempotencyKey: randomUUID(), name: 'Mine', billIds: [s.a.id], inputMode: 'total', totalAmount: '100.00', installmentCount: '2', firstDueDate: '2026-12-01', cadence: 'monthly' }, 'r');
    await assert.rejects(q(`update plan_proposals set status = 'approved', decided_by = $2, decided_at = now(), plan_id = $3 where id = $1`, [id, other.actor.userId, mine.id]), /own household/);
    await assert.rejects(q(`update plan_proposals set status = 'approved', decided_by = $2, decided_at = now(), plan_id = $3 where id = $1`, [id, op.actor.userId, mine.id]), /approving person created/);
    // One plan comes from at most one proposal.
    await q(`update plan_proposals set status = 'approved', decided_by = $2, decided_at = now(), plan_id = $3 where id = $1`, [id, t.actor.userId, mine.id]);
    const again = await proposed(t, { name: 'Again' });
    await assert.rejects(q(`update plan_proposals set status = 'approved', decided_by = $2, decided_at = now(), plan_id = $3 where id = $1`, [again.id, t.actor.userId, mine.id]), /duplicate key/);
    // Rejection with no reason, then decided once.
    await q(`update plan_proposals set status = 'rejected', decided_by = $2, decided_at = now() where id = $1`, [again.id, t.actor.userId]);
    await assert.rejects(q(`update plan_proposals set status = 'rejected', decided_by = $2, decided_at = now(), decision_note = 'again' where id = $1`, [again.id, t.actor.userId]), /decided once/);
    await assert.rejects(q(`update plan_proposals set status = 'applied' where id = $1`, [again.id]), /check|decided/);
    // A status that is not in the vocabulary, and a plan proposal that is not an object.
    await assert.rejects(q(`insert into plan_proposals (id, household_id, client_id, payload, bill_versions, note) select gen_random_uuid(), household_id, client_id, '[]', '{}', 'x' from plan_proposals limit 1`), /check/);
    await assert.rejects(q(`insert into plan_proposals (id, household_id, client_id, payload, bill_versions, note) select gen_random_uuid(), household_id, client_id, '{}', '{}', '' from plan_proposals limit 1`), /check/);
    await assert.rejects(q(`insert into plan_proposals (id, household_id, client_id, payload, bill_versions, note, status) select gen_random_uuid(), household_id, client_id, '{}', '{}', 'x', 'approved' from plan_proposals limit 1`), /pending and undecided/);
  } finally {
    await t.drop();
  }
});

// ---------- HTTP routes ----------

const api = (t, action, body, { cookie = t.cookie, csrf = t.csrf, origin, type = 'json', html = false, headers = {} } = {}) =>
  handlers.handleAssistantAction(post(`/api/assistant/${action}`, body, { cookie, origin, type, html, headers: { ...(csrf ? { 'x-csrf-token': csrf } : {}), ...headers } }), t.ctx, action);

test('the plan approval and rejection routes need a session, the canonical origin and a CSRF token; an approval lands on the new plan', { skip: skipDb }, async () => {
  const t = await mcpFixture();
  try {
    const { id } = await proposed(t);
    const digest = (await review(t, id)).previewDigest;
    const body = { idempotencyKey: randomUUID(), proposalId: id, previewDigest: digest };
    assert.equal((await api(t, 'proposals/plan-approve', body, { cookie: '' })).status, 401);
    assert.equal((await api(t, 'proposals/plan-approve', body, { csrf: null })).status, 403);
    assert.equal((await api(t, 'proposals/plan-approve', body, { csrf: 'wrong' })).status, 403);
    assert.equal((await api(t, 'proposals/plan-approve', body, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await api(t, 'proposals/plan-approve', { ...body, extra: 1 })).status, 400);
    assert.equal((await api(t, 'proposals/plan-approve', { ...body, previewDigest: 'short' })).status, 400);
    assert.equal((await api(t, 'proposals/plan-reject', { proposalId: id }, { csrf: null })).status, 403);
    assert.equal(await count(t, 'payment_plans'), 0);
    const ok = await api(t, 'proposals/plan-approve', body);
    assert.equal(ok.status, 201);
    const json = await ok.json();
    assert.deepEqual([json.ok, json.id, json.replayed], [true, id, false]);
    assert.equal(await count(t, 'payment_plans'), 1);
    assert.equal((await api(t, 'proposals/plan-approve', body)).status, 200, 'a replay of the same key is not a second plan');
    assert.equal(await count(t, 'payment_plans'), 1);
    // A browser form post redirects: a refusal back to the proposal with the code only, an approval to the plan.
    const stale = await api(t, 'proposals/plan-approve', { ...body, idempotencyKey: randomUUID() }, { type: 'form', html: true });
    assert.equal(stale.status, 303);
    assert.equal(new URL(stale.headers.get('location')).pathname, `/proposals/plans/${id}`);
    assert.match(new URL(stale.headers.get('location')).search, /^\?error=/);
    const second = await proposed(t, { name: 'Another' });
    const rej = await api(t, 'proposals/plan-reject', { proposalId: second.id, reason: '' }, { type: 'form', html: true });
    assert.equal(rej.status, 303);
    assert.equal(new URL(rej.headers.get('location')).pathname, `/proposals/plans/${second.id}`);
    assert.equal((await one(t, `select status from plan_proposals where id = $1`, [second.id])).status, 'rejected');
    // An approval from a browser lands on the plan page.
    const third = await proposed(t, { name: 'Third' });
    const landed = await api(t, 'proposals/plan-approve', { idempotencyKey: randomUUID(), proposalId: third.id, previewDigest: (await review(t, third.id)).previewDigest }, { type: 'form', html: true });
    assert.equal(landed.status, 303);
    assert.match(new URL(landed.headers.get('location')).pathname, /^\/plans\/[0-9a-f-]{36}$/);
    assert.equal(new URL(landed.headers.get('location')).search, '');
  } finally {
    await t.drop();
  }
});

// ---------- migration, backup ----------

test('plan proposals are in the backup like document proposals, after the tables they point to, and restore with their payload', { skip: skipDb }, async () => {
  const names = BACKUP_TABLES.map((x) => x.name);
  const at = (n) => names.indexOf(n);
  assert.ok(at('plan_proposals') > at('payment_plans') && at('plan_proposals') > at('mcp_clients') && at('plan_proposals') > at('users'));
  assert.equal(BACKUP_TABLES.find((x) => x.name === 'plan_proposals').since, '0019');
  assert.ok(!BACKUP_TABLES.find((x) => x.name === 'plan_proposals').replace, 'the whole row is kept: it holds no secret');
});
