// Administrator removal (with undo) of HSA eligibility decisions, claims and reimbursement receipts: services, undo slot, HTTP pipeline,
// refusal messages, concurrency, audit rows, document links and backup. Real PostgreSQL, fabricated data only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import test from 'node:test';
import { createBackup, restoreArchive, verifyArchive } from '../../apps/web/server/backup/engine.ts';
import { ledgerSummary, ledgerViolations } from '../../apps/web/server/backup/ledger.ts';
import * as handlers from '../../apps/web/server/http.ts';
import * as hsaRepo from '../../apps/web/server/repositories/hsa.ts';
import { getUndoSlot } from '../../apps/web/server/repositories/undo.ts';
import * as docs from '../../apps/web/server/services/documents.ts';
import * as hsa from '../../apps/web/server/services/hsa.ts';
import * as pay from '../../apps/web/server/services/payments.ts';
import { retryStats } from '../../apps/web/server/services/support.ts';
import { undo } from '../../apps/web/server/services/undo.ts';
import { csrfFor } from '../../apps/web/server/tokens.ts';
import { PDF_FILE, docFixture, tempStore } from './document-helpers.mjs';
import { freshDatabase, post, skipDb } from './helpers.mjs';

const code = (c) => ({ code: c });
const REASON = 'Fabricated entry made twice';
const NOTE = 'Fabricated pharmacy receipt note';
const RATIONALE = 'Fabricated rationale about a prescription';
const MSG_DECISION = 'Deleting this decision would leave more reimbursement than it supports; delete or release the claims first';

/** Fixture: a member, a provider and helpers that build allocations, decisions, claims and receipts, plus the removal actions. */
async function fixture() {
  const t = await docFixture();
  const m = await t.member();
  const p = await t.provider();
  const pool = t.db.pool;
  const actor = t.actor;
  const f = {
    ...t, m, p,
    async alloc({ bill = '120.00', paid = '75.00', paidOn = '2026-04-01' } = {}) {
      const b = await t.bill({ memberId: m, providerId: p, originalAmount: bill });
      const pm = await t.pay1({ amount: paid, paidOn, billId: b.id });
      const [a] = (await t.payment(pm.id)).allocations;
      return { bill: b, payment: pm, allocationId: a.allocationId, paymentId: pm.id };
    },
    figs: (id) => hsaRepo.getAllocation(pool, actor.householdId, id),
    async decide(allocationId, status, amount, o = {}) {
      const cur = await hsaRepo.getAllocation(pool, actor.householdId, allocationId);
      return hsa.recordDecision(pool, actor, {
        idempotencyKey: t.key(), allocationId, version: String(cur.decisionVersion), status, ...(amount ? { eligibleAmount: amount } : {}),
        rationale: RATIONALE, evidenceType: 'receipt', evidenceNote: NOTE, decidedOn: '2026-04-05', ...o,
      }, 'r');
    },
    claim: (lines, o = {}) => hsa.submitClaim(pool, actor, { idempotencyKey: t.key(), submittedOn: '2026-04-10', administrator: 'Example HSA Bank', lines, ...o }, 'r'),
    line: async (claimId, n = 0) => (await hsaRepo.linesOfClaim(pool, actor.householdId, claimId))[n],
    receipt: (lines, o = {}) => hsa.recordReceipt(pool, actor, { idempotencyKey: t.key(), receivedOn: '2026-04-20', source: 'administrator_transfer', lines, ...o }, 'r'),
    external: (lines, o = {}) => hsa.recordExternalReceipt(pool, actor, {
      idempotencyKey: t.key(), receivedOn: '2026-04-21', source: 'hsa_debit_card', evidenceType: 'statement', evidenceNote: NOTE, lines, ...o,
    }, 'r'),
  };
  return f;
}

const svcOf = { decision: [hsa.removeHsaDecision, 'decisionId'], claim: [hsa.removeHsaClaim, 'claimId'], receipt: [hsa.removeHsaReceipt, 'receiptId'] };
const rm = (t, kind, id, o = {}, actor = t.actor) => svcOf[kind][0](t.db.pool, actor, { idempotencyKey: randomUUID(), [svcOf[kind][1]]: id, reason: REASON, ...o }, 'r');
const undoIt = (t, o = {}, actor = t.actor) => undo(t.db.pool, actor, { idempotencyKey: randomUUID(), ...o }, 'r');
const slotOf = (t, actor = t.actor) => getUndoSlot(t.db.pool, actor);
const slotRows = async (t) => (await t.db.pool.query(`select user_id, kind, entity_id, payload from undo_actions`)).rows;
const events = async (t, kind, id) => (await t.db.pool.query(`select action from hsa_removal_events where kind = $1 and record_id = $2 order by seq`, [kind, id])).rows.map((r) => r.action);
const figsOf = (a) => [a.ceilingCents, a.pendingCents, a.receivedCents, a.availableCents, a.needsReviewCents];

/** An operator, a second administrator and an administrator of another household (fabricated rows; service calls need no session). */
async function people(t) {
  const q = (sql, p) => t.db.pool.query(sql, p);
  const mk = async (householdId, email, role) => {
    const id = (await q(`insert into users (household_id, email, display_name, role, password_hash) values ($1, $2, $3, $4, 'x') returning id`, [householdId, email, email, role])).rows[0].id;
    return { userId: id, householdId, role, displayName: email, sessionId: randomUUID(), mustChangePassword: false };
  };
  const h2 = (await q(`insert into households (name) values ('Other Family') returning id`)).rows[0].id;
  return { admin2: await mk(t.actor.householdId, 'admin2@example.test', 'admin'), operator: await mk(t.actor.householdId, 'op@example.test', 'operator'), outsider: await mk(h2, 'outsider@example.test', 'admin') };
}

/** Every figure, list, queue and export a removal and its undo must leave exactly as it was. */
async function snap(t) {
  const pool = t.db.pool, actor = t.actor;
  const csv = async (kind) => (await hsa.exportHsa(pool, actor, { kind }, 'r')).csv;
  // decisionVersion counts removal events on purpose (a delete and an undo invalidate stale forms), so it is not part of the unchanged figures.
  const allocs = (await hsa.listHsaAllocations(pool, actor, {})).items.map(({ decisionVersion, ...x }) => x);
  const details = [];
  for (const a of allocs) {
    const d = await hsa.getHsaAllocationDetail(pool, actor, a.allocationId);
    details.push({ id: a.allocationId, decisions: d.decisions.map(({ deletable, ...x }) => x), lines: d.lines, entries: d.entries });
  }
  const noVersion = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === 'decisionVersion' ? undefined : x)));
  return noVersion({
    totals: await hsa.hsaSummary(pool, actor, {}), allocs, details, claims: (await hsa.listHsaClaims(pool, actor, {})).items,
    receipts: (await hsa.listHsaReceipts(pool, actor, {})).items, queues: await hsa.hsaQueues(pool, actor, {}),
    exports: [await csv('allocations'), await csv('events'), await csv('decisions')],
    status: (await pool.query(`select * from hsa_allocation_status order by allocation_id`)).rows,
    summary: await pay.cashSummary(pool, actor),
  });
}

/** The standard chain: a $75 payment, $60 eligible, a $50 claim with one $20 reimbursement (pending 30, received 20, available 10). */
async function chain(t, o = {}) {
  const a = await t.alloc(o);
  const d = await t.decide(a.allocationId, 'eligible', '60.00');
  const c = await t.claim([{ allocationId: a.allocationId, amount: '50.00' }], { reference: o.reference ?? 'CLM-1' });
  const line = await t.line(c.id);
  const r = await t.receipt([{ lineId: line.lineId, amount: '20.00' }]);
  return { a, d, c, r, line };
}

test('the full flow: receipt, claim, decision in that order, then the payment; undo of each step restores exact figures', { skip: skipDb }, async () => {
  const t = await fixture();
  try {
    const { a, d, c, r } = await chain(t);
    const id = a.allocationId;
    assert.deepEqual(figsOf(await t.figs(id)), ['6000', '3000', '2000', '1000', '0']);
    const full = await snap(t);

    // Out of order: the decision supports pending cash, the claim has a live reimbursement. Nothing is written by a refusal.
    await assert.rejects(rm(t, 'decision', d.id), (e) => e.code === 'conflict' && e.message === MSG_DECISION);
    await assert.rejects(rm(t, 'claim', c.id), (e) => e.code === 'conflict' && /^Delete its reimbursements first/.test(e.message));
    await assert.rejects(pay.removePayment(t.db.pool, t.actor, { idempotencyKey: randomUUID(), paymentId: a.paymentId, reason: REASON }, 'r'), /HSA claims/);
    assert.equal(await t.count('hsa_removal_events'), 0);
    assert.equal((await slotRows(t)).length, 0, 'a refusal sets no undo slot');

    // The deletable helpers (the UI shows the reason instead of failing) agree with those refusals; operators get null.
    const detail = await hsa.getHsaAllocationDetail(t.db.pool, t.actor, id);
    assert.deepEqual(detail.decisions[0].deletable, { deletable: false, reason: MSG_DECISION });
    assert.deepEqual((await hsa.getHsaClaimDetail(t.db.pool, t.actor, c.id)).deletable, { deletable: false, reason: 'Delete its reimbursements first' });
    assert.deepEqual((await hsa.getHsaReceiptDetail(t.db.pool, t.actor, r.id)).deletable, { deletable: true, reason: null });
    assert.deepEqual(await hsa.hsaRecordDeletable(t.db.pool, t.actor, 'decision', d.id), { deletable: false, reason: MSG_DECISION });
    assert.deepEqual(await hsa.hsaRecordDeletable(t.db.pool, t.actor, 'claim', c.id), { deletable: false, reason: 'Delete its reimbursements first' });
    const { operator } = await people(t);
    assert.equal((await hsa.getHsaAllocationDetail(t.db.pool, operator, id)).decisions[0].deletable, null);
    assert.equal((await hsa.getHsaClaimDetail(t.db.pool, operator, c.id)).deletable, null);
    assert.equal((await hsa.getHsaReceiptDetail(t.db.pool, operator, r.id)).deletable, null);
    await assert.rejects(hsa.hsaRecordDeletable(t.db.pool, operator, 'claim', c.id), code('forbidden'));

    // 1. Delete the reimbursement: its amount returns to pending, received falls; it leaves lists and exports.
    assert.deepEqual(await rm(t, 'receipt', r.id), { id: r.id, replayed: false });
    assert.deepEqual(figsOf(await t.figs(id)), ['6000', '5000', '0', '1000', '0']);
    const s1 = await snap(t);
    assert.equal(s1.receipts.length, 0);
    assert.equal(s1.totals.receivedCents, '0');
    await assert.rejects(hsa.getHsaReceiptDetail(t.db.pool, t.actor, r.id), code('not_found'));
    assert.ok(!s1.exports[1].includes(r.id), 'the events export has no entry of the removed receipt');
    assert.deepEqual(await slotOf(t).then((s) => [s.kind, s.entityId]), ['hsa_receipt_remove', r.id]);
    assert.deepEqual((await slotRows(t))[0].payload, { recordId: r.id });
    await assert.rejects(rm(t, 'receipt', r.id), (e) => e.code === 'conflict' && /already deleted/.test(e.message));
    const u1 = await undoIt(t);
    assert.deepEqual([u1.id, u1.target, u1.path], [r.id, 'hsa_receipt', `/hsa/receipts/${r.id}`]);
    assert.deepEqual(await snap(t), full, 'figures, lists, queues, exports and totals are identical after the undo');
    assert.equal((await slotRows(t)).length, 0);
    assert.deepEqual(await events(t, 'receipt', r.id), ['remove', 'restore']);

    // 2. Receipt, then claim; undo the claim.
    await rm(t, 'receipt', r.id);
    const afterReceipt = await snap(t);
    assert.deepEqual(afterReceipt, s1);
    await rm(t, 'claim', c.id);
    assert.deepEqual(figsOf(await t.figs(id)), ['6000', '0', '0', '6000', '0']);
    const s2 = await snap(t);
    assert.equal(s2.claims.length, 0);
    await assert.rejects(hsa.getHsaClaimDetail(t.db.pool, t.actor, c.id), code('not_found'));
    const u2 = await undoIt(t);
    assert.deepEqual([u2.id, u2.target, u2.path], [c.id, 'hsa_claim', `/hsa/claims/${c.id}`]);
    assert.deepEqual(await snap(t), s1);

    // 3. Claim again, then the decision; undo the decision (it lands on the allocation page).
    await rm(t, 'claim', c.id);
    assert.deepEqual(await hsa.hsaRecordDeletable(t.db.pool, t.actor, 'decision', d.id), { deletable: true, reason: null });
    await rm(t, 'decision', d.id);
    assert.deepEqual(figsOf(await t.figs(id)), ['0', '0', '0', '0', '0']);
    const s3 = await snap(t);
    assert.equal((await hsa.getHsaAllocationDetail(t.db.pool, t.actor, id)).decisions.length, 0);
    assert.equal((await t.figs(id)).decisionStatus, null);
    const u3 = await undoIt(t);
    assert.deepEqual([u3.id, u3.target, u3.path], [d.id, 'hsa_decision', `/hsa/allocations/${id}`]);
    assert.deepEqual(await snap(t), s2);
    await rm(t, 'decision', d.id);
    assert.deepEqual(await snap(t), s3);

    // With every HSA record deleted the payment can be removed, and its undo restores the payment.
    const cash = await pay.cashSummary(t.db.pool, t.actor);
    await pay.removePayment(t.db.pool, t.actor, { idempotencyKey: randomUUID(), paymentId: a.paymentId, reason: REASON }, 'r');
    await assert.rejects(t.payment(a.paymentId), code('not_found'));
    assert.equal((await hsa.listHsaAllocations(t.db.pool, t.actor, {})).items.length, 0);
    await undoIt(t);
    assert.deepEqual(await pay.cashSummary(t.db.pool, t.actor), cash);
    assert.equal((await t.payment(a.paymentId)).payment.id, a.paymentId);
    assert.deepEqual(await ledgerViolations(t.db.pool), []);
    assert.deepEqual(await events(t, 'decision', d.id), ['remove', 'restore', 'remove']);
    assert.equal(await t.count('hsa_eligibility_decisions'), 1, 'nothing was deleted');
  } finally { await t.db.drop(); }
});

test('an external reimbursement and a multi-allocation claim can be deleted and restored; undo of a decision leaves older decisions alone', { skip: skipDb }, async () => {
  const t = await fixture();
  try {
    const a = await t.alloc();
    const b = await t.alloc({ paid: '40.00', paidOn: '2026-04-02' });
    await t.decide(a.allocationId, 'eligible', '60.00');
    await t.decide(b.allocationId, 'eligible', '40.00');
    const c = await t.claim([{ allocationId: a.allocationId, amount: '30.00' }, { allocationId: b.allocationId, amount: '20.00' }]);
    const ext = await t.external([{ allocationId: a.allocationId, amount: '10.00' }]);
    const before = await snap(t);
    await rm(t, 'receipt', ext.id);
    assert.equal((await t.figs(a.allocationId)).receivedCents, '0');
    await undoIt(t);
    await rm(t, 'claim', c.id);
    assert.deepEqual([(await t.figs(a.allocationId)).pendingCents, (await t.figs(b.allocationId)).pendingCents], ['0', '0']);
    const audit = await t.audit('hsa.claim_removed');
    assert.deepEqual([audit[0].detail.allocationCount, audit[0].detail.amountCents, audit[0].detail.pendingBeforeCents, audit[0].detail.pendingAfterCents], [2, '5000', '5000', '0']);
    await undoIt(t);
    assert.deepEqual(await snap(t), before);

    // An older decision is deletable only by the not-worse rule: the newest one decides the ceiling.
    const d1 = await t.decide(b.allocationId, 'eligible', '30.00'); // lowers the ceiling below the $20 claim? no: 30 >= 20
    const detail = await hsa.getHsaAllocationDetail(t.db.pool, t.actor, b.allocationId);
    assert.equal(detail.decisions.length, 2);
    assert.equal(detail.decisions[0].id, d1.id);
    await rm(t, 'decision', detail.decisions[1].id); // removing the OLDER one does not change the ceiling
    assert.equal((await t.figs(b.allocationId)).ceilingCents, '3000');
    await undoIt(t);
    assert.equal((await t.figs(b.allocationId)).decisionCount, 2);
  } finally { await t.db.drop(); }
});

test('administrators only: operators are forbidden everywhere, other households and unknown ids are not found, already deleted is a conflict', { skip: skipDb }, async () => {
  const t = await fixture();
  try {
    const { operator, outsider } = await people(t);
    const { d, c, r } = await chain(t);
    for (const [kind, id] of [['decision', d.id], ['claim', c.id], ['receipt', r.id]]) {
      await assert.rejects(rm(t, kind, id, {}, operator), code('forbidden'));
      await assert.rejects(rm(t, kind, randomUUID(), {}, operator), code('forbidden'));
      await assert.rejects(rm(t, kind, id, {}, outsider), code('not_found'));
      await assert.rejects(rm(t, kind, randomUUID()), code('not_found'));
    }
    await assert.rejects(undoIt(t, {}, operator), code('forbidden'));
    assert.equal(await t.count('hsa_removal_events'), 0);
    assert.equal((await slotRows(t)).length, 0);
    // Over HTTP an operator session gets 403 as well (the capability is checked by the service, behind the same pipeline).
    await assert.rejects(hsa.removeHsaReceipt(t.db.pool, operator, { idempotencyKey: randomUUID(), receiptId: r.id }, 'r'), code('forbidden'));
    // Bad input and a steering field that does not belong to the record.
    await assert.rejects(rm(t, 'decision', 'not-a-uuid'), code('invalid_input'));
    await assert.rejects(rm(t, 'decision', d.id, { allocationId: randomUUID() }), code('invalid_input'));
    await assert.rejects(rm(t, 'receipt', r.id, { claimId: randomUUID() }), code('invalid_input'));
    // A blank reason falls back to the default; the text is kept on the event, not in the audit row.
    await rm(t, 'receipt', r.id, { reason: '   ' });
    assert.equal((await t.db.pool.query(`select reason from hsa_removal_events where record_id = $1`, [r.id])).rows[0].reason, 'Removed by administrator');
    await assert.rejects(rm(t, 'receipt', r.id), (e) => e.code === 'conflict' && /already deleted/.test(e.message));
    assert.equal(await t.count('hsa_removal_events'), 1);
  } finally { await t.db.drop(); }
});

test('one key is one removal and one undo; a different request on the same key is a conflict', { skip: skipDb }, async () => {
  const t = await fixture();
  try {
    const { c, r } = await chain(t);
    const key = randomUUID();
    assert.equal((await rm(t, 'receipt', r.id, { idempotencyKey: key })).replayed, false);
    assert.equal((await rm(t, 'receipt', r.id, { idempotencyKey: key })).replayed, true);
    await assert.rejects(rm(t, 'receipt', r.id, { idempotencyKey: key, reason: 'A different reason' }), code('conflict'));
    assert.deepEqual(await events(t, 'receipt', r.id), ['remove']);
    assert.equal((await t.audit('hsa.receipt_removed')).length, 1);
    const uk = randomUUID();
    assert.equal((await undoIt(t, { idempotencyKey: uk })).replayed, false);
    const again = await undoIt(t, { idempotencyKey: uk });
    assert.deepEqual([again.replayed, again.id, again.target, again.path], [true, r.id, 'hsa_receipt', `/hsa/receipts/${r.id}`], 'a replay answers although the slot is gone');
    assert.deepEqual(await events(t, 'receipt', r.id), ['remove', 'restore']);
    await assert.rejects(undoIt(t), (e) => e.code === 'conflict' && e.message === 'Nothing to undo');
    // A claim removal replay too (the claim is removable once its receipt is gone).
    await rm(t, 'receipt', r.id);
    const k2 = randomUUID();
    await rm(t, 'claim', c.id, { idempotencyKey: k2 });
    assert.equal((await rm(t, 'claim', c.id, { idempotencyKey: k2 })).replayed, true);
    assert.equal((await t.audit('hsa.claim_removed')).length, 1);
  } finally { await t.db.drop(); }
});

test('the undo slot: expiry by the database clock, another administrator, supersession by the next mutation through the HTTP pipeline', { skip: skipDb }, async () => {
  const t = await fixture();
  try {
    const { admin2 } = await people(t);
    const { a, d, c, r } = await chain(t);
    const csrf = csrfFor(t.cookie.split('=')[1]);
    const act = (name, body, o = {}) => handlers.handleExpenseAction(post(`/api/expenses/${name}`, { ...(name.startsWith('members/') ? {} : { idempotencyKey: randomUUID() }), ...body }, { type: 'json', cookie: t.cookie, headers: { 'x-csrf-token': csrf }, ...o }), t.ctx, name);
    const form = (name, body) => handlers.handleExpenseAction(post(`/api/expenses/${name}`, { idempotencyKey: randomUUID(), ...body }, { type: 'form', html: true, cookie: t.cookie, headers: { 'x-csrf-token': csrf } }), t.ctx, name);

    // Removal and undo over HTTP; the redirects land on the right pages.
    assert.equal((await act('hsa/receipt-remove', { receiptId: r.id })).status, 200);
    assert.equal((await slotRows(t)).length, 1);
    const back = await form('undo', {});
    assert.equal(back.status, 303);
    assert.equal(new URL(back.headers.get('location')).pathname, `/hsa/receipts/${r.id}`);
    const rr = await form('hsa/receipt-remove', { receiptId: r.id, claimId: c.id });
    assert.equal(new URL(rr.headers.get('location')).pathname, `/hsa/claims/${c.id}`);
    const rc = await form('hsa/claim-remove', { claimId: c.id });
    assert.equal(new URL(rc.headers.get('location')).pathname, '/hsa/claims');
    const uc = await form('undo', {});
    assert.equal(new URL(uc.headers.get('location')).pathname, `/hsa/claims/${c.id}`);
    // A refusal over a form lands on the record's page with the error code; over JSON it is 409.
    const refused = await form('hsa/claim-remove', { claimId: r.id });
    assert.equal(new URL(refused.headers.get('location')).pathname, `/hsa/claims/${r.id}`);
    await act('hsa/claim-remove', { claimId: c.id }).then((x) => assert.equal(x.status, 200));
    await form('undo', {});
    await form('hsa/receipt-remove', { receiptId: r.id }); await form('undo', {});
    // A decision: removal needs the claims gone first; the form carries the allocation only to steer the redirect.
    await act('hsa/receipt-remove', { receiptId: r.id }); await act('hsa/claim-remove', { claimId: c.id });
    const rd = await form('hsa/decision-remove', { decisionId: d.id, allocationId: a.allocationId });
    assert.equal(new URL(rd.headers.get('location')).pathname, `/hsa/allocations/${a.allocationId}`);
    const ud = await form('undo', {});
    assert.equal(new URL(ud.headers.get('location')).pathname, `/hsa/allocations/${a.allocationId}`);
    assert.equal((await t.figs(a.allocationId)).decisionStatus, 'eligible');

    // Another administrator has no slot for it.
    await assert.rejects(undoIt(t, {}, admin2), (e) => e.code === 'conflict' && e.message === 'Nothing to undo');
    // The next mutation supersedes the slot, even a failing one; undo then has nothing to do and the record stays deleted.
    const c3 = await t.claim([{ allocationId: a.allocationId, amount: '10.00' }], { reference: 'CLM-3' });
    await act('hsa/claim-remove', { claimId: c3.id });
    assert.equal((await slotRows(t)).length, 1);
    assert.equal((await act('members/create', { name: 'Sam Example' })).status, 201);
    assert.equal((await slotRows(t)).length, 0);
    assert.equal((await act('undo', {})).status, 409);
    assert.deepEqual(await events(t, 'claim', c3.id), ['remove']);
    await act('hsa/claim-remove', { claimId: randomUUID() }).then((x) => assert.equal(x.status, 404));

    // Expiry by the database clock: an expired slot reads as absent and restores nothing.
    const c2 = await t.claim([{ allocationId: a.allocationId, amount: '10.00' }], { reference: 'CLM-2' });
    await rm(t, 'claim', c2.id);
    await t.db.pool.query(`update undo_actions set expires_at = now() - interval '1 second' where user_id = $1`, [t.actor.userId]);
    assert.equal(await slotOf(t), null);
    await assert.rejects(undoIt(t), (e) => e.code === 'conflict' && e.message === 'Nothing to undo');
    assert.deepEqual(await events(t, 'claim', c2.id), ['remove']);
  } finally { await t.db.drop(); }
});

test('a stale slot payload or a record that is no longer removed is "Nothing to undo"', { skip: skipDb }, async () => {
  const t = await fixture();
  try {
    const { c, r } = await chain(t);
    await rm(t, 'receipt', r.id);
    await t.db.pool.query(`update undo_actions set payload = $2::jsonb where user_id = $1`, [t.actor.userId, JSON.stringify({ recordId: randomUUID() })]);
    await assert.rejects(undoIt(t), (e) => e.code === 'conflict' && e.message === 'Nothing to undo');
    await t.db.pool.query(`update undo_actions set payload = '{}'::jsonb where user_id = $1`, [t.actor.userId]);
    await assert.rejects(undoIt(t), (e) => e.code === 'conflict' && e.message === 'Nothing to undo');
    assert.deepEqual(await events(t, 'receipt', r.id), ['remove'], 'nothing restored');
    // The record was restored some other way (here by SQL): the slot is stale.
    await t.db.pool.query(`update undo_actions set payload = $2::jsonb where user_id = $1`, [t.actor.userId, JSON.stringify({ recordId: r.id })]);
    await t.db.pool.query(`insert into hsa_removal_events (household_id, kind, record_id, action, created_by) values ($1, 'receipt', $2, 'restore', $3)`, [t.actor.householdId, r.id, t.actor.userId]);
    await assert.rejects(undoIt(t), (e) => e.code === 'conflict' && e.message === 'Nothing to undo');
    assert.ok(c.id);
  } finally { await t.db.drop(); }
});

test('the not-worse-than-before rule from the service side: on an allocation that needs review, deleting a claim that reduces the excess works, deleting the decision is refused', { skip: skipDb }, async () => {
  const t = await fixture();
  try {
    const a = await t.alloc();
    const d = await t.decide(a.allocationId, 'eligible', '60.00');
    const c1 = await t.claim([{ allocationId: a.allocationId, amount: '30.00' }], { reference: 'A-1' });
    const c2 = await t.claim([{ allocationId: a.allocationId, amount: '20.00' }], { reference: 'A-2' });
    assert.deepEqual(figsOf(await t.figs(a.allocationId)), ['6000', '5000', '0', '1000', '0']);
    // A refund of $40 takes the net cash to $35: the ceiling is $35 and $50 is pending, so $15 needs review.
    const [al] = (await t.payment(a.paymentId)).allocations;
    await t.refund(a.paymentId, { allocationId: al.allocationId, amount: '40.00' });
    assert.deepEqual(figsOf(await t.figs(a.allocationId)), ['3500', '5000', '0', '0', '1500']);
    const decisionRow = (await hsa.getHsaAllocationDetail(t.db.pool, t.actor, a.allocationId)).decisions[0];
    assert.deepEqual(decisionRow.deletable, { deletable: false, reason: MSG_DECISION });
    assert.equal((await hsa.getHsaClaimDetail(t.db.pool, t.actor, c2.id)).deletable.deletable, true);
    await assert.rejects(rm(t, 'decision', d.id), (e) => e.code === 'conflict' && e.message === MSG_DECISION);
    // Deleting the $20 claim reduces the excess to zero: allowed, and the undo is refused until the ceiling can carry it again.
    await rm(t, 'claim', c2.id);
    assert.deepEqual(figsOf(await t.figs(a.allocationId)), ['3500', '3000', '0', '500', '0']);
    await undoIt(t).then(() => assert.fail('restoring would recreate the excess'), (e) => {
      assert.equal(e.code, 'conflict');
      assert.match(e.message, /^Undoing this deletion would put pending plus received reimbursement above what the payment.s eligible amount supports, so this deletion cannot be undone\. Enter the record again instead/);
    });
    assert.deepEqual(figsOf(await t.figs(a.allocationId)), ['3500', '3000', '0', '500', '0'], 'the refused undo changed nothing');
    assert.equal((await slotRows(t)).length, 1, 'the slot stays until it expires');
    // Deleting the claim that leaves the excess unchanged is fine too (the excess never grows): here it is zero and stays zero.
    await rm(t, 'claim', c1.id);
    assert.deepEqual(figsOf(await t.figs(a.allocationId)), ['3500', '0', '0', '3500', '0']);
    assert.deepEqual(await ledgerViolations(t.db.pool), []);
  } finally { await t.db.drop(); }
});

test('restore refusals: payment removed meanwhile, claim reference reused, ceiling exceeded after a refund; re-entering a deleted reference works', { skip: skipDb }, async () => {
  const t = await fixture();
  try {
    const { admin2 } = await people(t);
    // Payment removed meanwhile (by another administrator): the first administrator's undo is refused cleanly.
    const x = await chain(t);
    await rm(t, 'receipt', x.r.id); await rm(t, 'claim', x.c.id); await rm(t, 'decision', x.d.id);
    await pay.removePayment(t.db.pool, admin2, { idempotencyKey: randomUUID(), paymentId: x.a.paymentId, reason: REASON }, 'r');
    await assert.rejects(undoIt(t), (e) => e.code === 'conflict' && /^This cannot be undone: the payment was removed/.test(e.message));
    assert.deepEqual(await events(t, 'decision', x.d.id), ['remove']);
    await t.db.pool.query(`delete from undo_actions`);

    // A claim reference taken again after the claim was deleted.
    const y = await t.alloc({ paidOn: '2026-04-03' });
    await t.decide(y.allocationId, 'eligible', '60.00');
    const first = await t.claim([{ allocationId: y.allocationId, amount: '20.00' }], { reference: 'Ref-77' });
    await rm(t, 'claim', first.id);
    const second = await t.claim([{ allocationId: y.allocationId, amount: '20.00' }], { reference: 'REF-77' });
    assert.ok(second.id, 'the same reference (any case) is free again once its claim is deleted');
    await assert.rejects(t.claim([{ allocationId: y.allocationId, amount: '5.00' }], { reference: 'ref-77' }), (e) => e.code === 'conflict' && /already recorded/.test(e.message));
    // A service call does not pass the HTTP pipeline, so the slot still holds the first removal: its undo is refused (the reference is in use).
    await undoIt(t).then(() => assert.fail('the reference is in use by a newer claim'), (e) => {
      assert.equal(e.code, 'conflict');
      assert.match(e.message, /^This cannot be undone: a newer claim now uses the same reference/);
    });
    assert.deepEqual(await events(t, 'claim', first.id), ['remove']);

    // Ceiling exceeded after the payment was refunded: the claim cannot come back.
    const z = await t.alloc({ paidOn: '2026-04-04' });
    await t.decide(z.allocationId, 'eligible', '60.00');
    const cz = await t.claim([{ allocationId: z.allocationId, amount: '30.00' }], { reference: 'Z-1' });
    await rm(t, 'claim', cz.id);
    const [al] = (await t.payment(z.paymentId)).allocations;
    await t.refund(z.paymentId, { allocationId: al.allocationId, amount: '60.00' });
    assert.equal((await t.figs(z.allocationId)).ceilingCents, '1500');
    await assert.rejects(undoIt(t), (e) => e.code === 'conflict' && /^Undoing this deletion would put pending plus received reimbursement above what the payment.s eligible amount supports, so this deletion cannot be undone\. Enter the record again instead/.test(e.message));
    assert.deepEqual(await events(t, 'claim', cz.id), ['remove']);
    assert.deepEqual(await ledgerViolations(t.db.pool), []);
  } finally { await t.db.drop(); }
});

test('concurrency: a removal races a new receipt, claim or decision on the same allocation (8 rounds), and two undos race each other', { skip: skipDb }, async () => {
  const t = await fixture();
  try {
    retryStats.lockConflicts = 0;
    const settled = (res, ok = []) => {
      for (const x of res) if (x.status === 'rejected') assert.ok(['conflict', 'not_found', 'stale_version'].includes(x.reason.code), `unexpected ${x.reason?.code} ${x.reason?.message}`);
      return res.map((x) => x.status);
    };
    for (let i = 0; i < 8; i += 1) {
      const a = await t.alloc({ bill: '120.00', paid: '75.00', paidOn: `2026-04-${String(10 + i).padStart(2, '0')}` });
      const d = await t.decide(a.allocationId, 'eligible', '60.00');
      const c = await t.claim([{ allocationId: a.allocationId, amount: '30.00' }], { reference: `RACE-${i}` });
      const line = await t.line(c.id);
      let results;
      if (i % 3 === 0) {
        // Removing the claim vs a receipt on its line: either the receipt lands first (removal refused) or the claim goes first (receipt finds nothing).
        results = settled(await Promise.allSettled([rm(t, 'claim', c.id), t.receipt([{ lineId: line.lineId, amount: '10.00' }])]));
        assert.ok(!(results[0] === 'fulfilled' && results[1] === 'fulfilled'), 'a claim cannot be deleted with a live reimbursement');
      } else if (i % 3 === 1) {
        // Removing the decision vs a new claim: both cannot succeed (the decision supports the new claim; the removal needs no pending).
        await hsa.releaseClaimLine(t.db.pool, t.actor, { idempotencyKey: randomUUID(), lineId: line.lineId, kind: 'cancel', effectiveDate: '2026-04-25', reason: 'Fabricated cancel' }, 'r');
        results = settled(await Promise.allSettled([rm(t, 'decision', d.id), t.claim([{ allocationId: a.allocationId, amount: '10.00' }], { reference: `RACE-B-${i}` })]));
        assert.ok(!(results[0] === 'fulfilled' && results[1] === 'fulfilled'), 'a removed decision cannot also back a new claim');
      } else {
        // Removing a claim vs recording a newer decision: unrelated writers do not exclude each other.
        const cur = await t.figs(a.allocationId);
        results = settled(await Promise.allSettled([
          rm(t, 'claim', c.id), hsa.recordDecision(t.db.pool, t.actor, {
            idempotencyKey: randomUUID(), allocationId: a.allocationId, version: String(cur.decisionVersion), status: 'eligible', eligibleAmount: '70.00',
            rationale: RATIONALE, evidenceType: 'receipt', evidenceNote: NOTE, decidedOn: '2026-04-06',
          }, 'r'),
        ]));
        assert.ok(results.every((s) => s === 'fulfilled'), 'unrelated writers do not exclude each other');
      }
      const f = await t.figs(a.allocationId);
      assert.equal(f.needsReviewCents, '0', `round ${i}: no excess created`);
      assert.deepEqual(await ledgerViolations(t.db.pool), [], `round ${i}`);
    }
    // Two undos at once (different keys): one restores, the other finds nothing.
    const a = await t.alloc({ paidOn: '2026-06-01' });
    await t.decide(a.allocationId, 'eligible', '60.00');
    const c = await t.claim([{ allocationId: a.allocationId, amount: '30.00' }], { reference: 'UNDO-2X' });
    await rm(t, 'claim', c.id);
    const both = await Promise.allSettled([undoIt(t), undoIt(t)]);
    assert.equal(both.filter((x) => x.status === 'fulfilled').length, 1);
    const lost = both.find((x) => x.status === 'rejected');
    assert.deepEqual([lost.reason.code, lost.reason.message], ['conflict', 'Nothing to undo']);
    assert.deepEqual(await events(t, 'claim', c.id), ['remove', 'restore']);
    assert.equal(retryStats.lockConflicts, 0, 'no deadlocks or serialization failures');
    assert.deepEqual(await ledgerViolations(t.db.pool), []);
  } finally { await t.db.drop(); }
});

test('audit rows hold ids and cents only: never the reason, notes, rationale or reference text', { skip: skipDb }, async () => {
  const t = await fixture();
  try {
    const { d, c, r } = await chain(t, { reference: 'CLM-SECRET-REF' });
    await rm(t, 'receipt', r.id); await undoIt(t);
    await rm(t, 'receipt', r.id); await rm(t, 'claim', c.id); await undoIt(t);
    await rm(t, 'claim', c.id); await rm(t, 'decision', d.id); await undoIt(t);
    const rows = (await t.db.pool.query(`select action, entity_type, detail from audit_events where action ~ '^hsa\\.(decision|claim|receipt)_(removed|restored)$' order by id`)).rows;
    assert.deepEqual(rows.map((x) => x.action), [
      'hsa.receipt_removed', 'hsa.receipt_restored', 'hsa.receipt_removed', 'hsa.claim_removed', 'hsa.claim_restored', 'hsa.claim_removed', 'hsa.decision_removed', 'hsa.decision_restored',
    ]);
    const text = JSON.stringify(rows);
    for (const secret of [REASON, 'Restored by undo', NOTE, RATIONALE, 'CLM-SECRET-REF', 'Example HSA Bank']) assert.ok(!text.includes(secret), `${secret} leaked into the audit trail`);
    for (const x of rows) for (const [k, v] of Object.entries(x.detail)) {
      assert.ok(v === null || typeof v === 'boolean' || typeof v === 'number' || /^(-?\d+|[0-9a-f-]{36})$/.test(v), `${x.action}.${k} = ${v} is not an id or cents`);
    }
    const first = rows[0].detail;
    assert.deepEqual([first.receiptId, first.allocationCount, first.amountCents, first.pendingBeforeCents, first.pendingAfterCents, first.receivedBeforeCents, first.receivedAfterCents, first.availableBeforeCents, first.availableAfterCents],
      [r.id, 1, '2000', '3000', '5000', '2000', '0', '1000', '1000']);
    assert.equal(rows[6].entity_type, 'hsa_allocation');
    assert.equal(rows[6].detail.decisionId, d.id);
    // The reason is on the removal event only.
    assert.equal((await t.db.pool.query(`select count(*)::int n from hsa_removal_events where reason = $1`, [REASON])).rows[0].n, 5);
  } finally { await t.db.drop(); }
});

test('documents: a removed decision or receipt takes no new attachment; existing links stay and every list still works', { skip: skipDb }, async () => {
  const t = await fixture();
  try {
    const { d, c, r } = await chain(t);
    const up1 = await t.up(PDF_FILE());
    const up2 = await t.up(PDF_FILE());
    const attach = (documentId, targetType, targetId) => docs.attachDocument(t.db.pool, t.actor, { idempotencyKey: randomUUID(), documentId, targetType, targetId, note: 'Evidence' }, 'r');
    await attach(up1.id, 'hsa_receipt', r.id);
    await attach(up1.id, 'hsa_eligibility_decision', d.id);
    await rm(t, 'receipt', r.id);
    await rm(t, 'claim', c.id);
    await rm(t, 'decision', d.id);
    // New links to removed records are refused, through attach and through upload-and-attach.
    await assert.rejects(attach(up2.id, 'hsa_receipt', r.id), code('not_found'));
    await assert.rejects(attach(up2.id, 'hsa_eligibility_decision', d.id), code('not_found'));
    await assert.rejects(docs.uploadDocument(t.deps, t.actor, { idempotencyKey: randomUUID(), title: 'Scan', kind: 'receipt', note: '', targetType: 'hsa_receipt', targetId: r.id, file: PDF_FILE() }, 'r'), code('not_found'));
    // The document keeps its two links and says that their targets are deleted; nothing throws.
    const detail = await docs.getDocumentDetail(t.db.pool, t.actor, up1.id);
    assert.equal(detail.attachments.length, 2);
    assert.deepEqual(detail.attachments.map((x) => [x.targetType, x.targetRemoved, x.detachedAt]).sort(), [['hsa_eligibility_decision', true, null], ['hsa_receipt', true, null]]);
    assert.ok(detail.attachments.every((x) => x.targetId));
    assert.equal(detail.document.activeAttachments, 2);
    assert.equal((await docs.listDocuments(t.db.pool, t.actor, {})).items.length, 2);
    assert.equal((await docs.unmatchedSummary(t.db.pool, t.actor)).count, 1, 'only the unattached document is unmatched');
    // A link of a removed record can still be detached (detach is unchanged).
    const receiptLink = detail.attachments.find((x) => x.targetType === 'hsa_receipt');
    await docs.detachDocument(t.db.pool, t.actor, { attachmentId: receiptLink.id, reason: 'Not needed' }, 'r');
    // The slot holds the decision's removal: after the undo its link reads as live and the decision takes new links again.
    await undoIt(t);
    const live = await docs.getDocumentDetail(t.db.pool, t.actor, up1.id);
    assert.deepEqual(live.attachments.map((x) => [x.targetType, x.targetRemoved]).sort(), [['hsa_eligibility_decision', false], ['hsa_receipt', true]]);
    await attach(up2.id, 'hsa_eligibility_decision', d.id);
    assert.equal((await docs.listAttachments(t.db.pool, t.actor, 'hsa_eligibility_decision', d.id)).length, 2);
  } finally { t.ts.cleanup(); await t.db.drop(); }
});

test('backup: removed HSA records round-trip through the services (create, verify, restore) with the same live figures', { skip: skipDb }, async () => {
  const t = await fixture();
  const ts = tempStore();
  const target = await freshDatabase();
  try {
    const { a, d, c, r } = await chain(t);
    const keep = await t.alloc({ paid: '30.00', paidOn: '2026-04-09' });
    await t.decide(keep.allocationId, 'eligible', '30.00');
    await rm(t, 'receipt', r.id); await rm(t, 'claim', c.id); await undoIt(t);
    await rm(t, 'claim', c.id);
    assert.ok(d.id && a.allocationId);
    const live = await ledgerSummary(t.db.pool);
    assert.equal(live.removedHsaRecords, '2');
    assert.deepEqual(await ledgerViolations(t.db.pool), []);
    const status = async (pool) => (await pool.query(`select * from hsa_allocation_status order by allocation_id`)).rows;

    const backup = createBackup(t.db.pool, ts.store, { passphrase: null });
    const file = path.join(ts.dir, backup.filename);
    await pipeline(backup.stream, createWriteStream(file));
    await backup.done;
    const verified = await verifyArchive(file);
    assert.equal(verified.manifest.ledger.removedHsaRecords, '2');
    await restoreArchive(target.pool, null, file, { via: 'cli' });
    assert.deepEqual(await status(target.pool), await status(t.db.pool), 'every live figure is identical after the restore');
    assert.equal((await ledgerSummary(target.pool)).removedHsaRecords, '2');
    assert.deepEqual(await ledgerViolations(target.pool), []);
    assert.equal((await target.pool.query(`select hsa_record_removed('claim', $1) as v`, [c.id])).rows[0].v, true);
    // The restored database serves the same reads through the services (the target has no sessions; read the repository directly).
    const claims = await hsaRepo.listClaims(target.pool, t.actor.householdId, { limit: 50, status: 'all' });
    assert.equal(claims.items.length, 0);
    assert.equal((await hsaRepo.getRemovalRecord(target.pool, t.actor.householdId, 'claim', c.id)).removed, true);
  } finally { await target.drop(); ts.cleanup(); t.ts.cleanup(); await t.db.drop(); }
});

test('decision form version: a stale form is refused after a delete plus a new decision, after only a delete, after only an undo; a fresh form works', { skip: skipDb }, async () => {
  const t = await fixture();
  try {
    const a = await t.alloc();
    const d1 = await t.decide(a.allocationId, 'eligible', '60.00');
    const submit = (version, o = {}) => hsa.recordDecision(t.db.pool, t.actor, {
      idempotencyKey: randomUUID(), allocationId: a.allocationId, version: String(version), status: 'eligible', eligibleAmount: '40.00',
      rationale: RATIONALE, evidenceType: 'receipt', evidenceNote: NOTE, decidedOn: '2026-04-05', ...o,
    }, 'r');
    const versionNow = async () => (await t.figs(a.allocationId)).decisionVersion;
    const stale = code('stale_version');

    // Loaded with one decision; delete it and record another: the live count is 1 again, but the form must be refused.
    const v1 = await versionNow();
    await rm(t, 'decision', d1.id);
    assert.notEqual(await versionNow(), v1, 'a removal changes the version');
    await t.decide(a.allocationId, 'eligible', '50.00');
    assert.equal((await t.figs(a.allocationId)).decisionCount, 1);
    await assert.rejects(submit(v1), stale);

    // Only a delete after loading.
    const v2 = await versionNow();
    const live = (await t.figs(a.allocationId)).decisionId;
    await rm(t, 'decision', live);
    await assert.rejects(submit(v2), stale);

    // Only an undo after loading.
    const v3 = await versionNow();
    await undoIt(t);
    assert.notEqual(await versionNow(), v3, 'a restore changes the version');
    await assert.rejects(submit(v3), stale);

    // A fresh form works.
    await submit(await versionNow());
    assert.equal((await t.figs(a.allocationId)).decidedCents, '4000');
  } finally { await t.db.drop(); }
});
