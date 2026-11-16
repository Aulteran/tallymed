// HSA accounts, HSA cards and payments paid directly from an HSA. Fabricated names and figures only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { listHsaFigures } from '../../apps/web/server/contracts.ts';
import * as hsaRepo from '../../apps/web/server/repositories/hsa.ts';
import * as acc from '../../apps/web/server/services/hsa-accounts.ts';
import * as hsa from '../../apps/web/server/services/hsa.ts';
import * as pm from '../../apps/web/server/services/payment-methods.ts';
import * as pay from '../../apps/web/server/services/payments.ts';
import { retryStats } from '../../apps/web/server/services/support.ts';
import { ledgerViolations } from '../../apps/web/server/backup/ledger.ts';
import { setup } from './money-helpers.mjs';
import { skipDb } from './helpers.mjs';

const code = (c) => ({ code: c });
const account = (t, o = {}) => acc.createHsaAccount(t.db.pool, t.actor, { name: 'Family HSA', administrator: 'Example HSA Bank', lastFour: '7788', ...o }, 'r');
const card = (t, hsaAccountId, o = {}) => pm.createPaymentMethod(t.db.pool, t.actor, { nickname: 'HSA Visa', kind: 'hsa_fsa_card', lastFour: '0042', hsaAccountId, ...o }, 'r');
const decide = (t, allocationId) => hsa.recordDecision(t.db.pool, t.actor, {
  idempotencyKey: t.key(), allocationId, version: '0', status: 'eligible', eligibleAmount: '10.00', rationale: 'Qualified', evidenceType: 'receipt', evidenceNote: 'Receipt', decidedOn: '2026-04-05',
}, 'r');
const alloc = async (t, paymentId) => (await t.payment(paymentId)).allocations[0].allocationId;

test('accounts: create, validate, rename, archive; labels only, never a number that could move money', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const a = await account(t);
    await assert.rejects(account(t, { name: 'family hsa' }), code('conflict'));
    for (const lastFour of ['12345', '12a4', '4111111111111111']) await assert.rejects(account(t, { name: `Bad ${lastFour}`, lastFour }), code('invalid_input'));
    // A name or administrator is a label: a long digit run is refused, separators ignored (any non-digit separator in a name is a label).
    for (const name of ['123456789012', '1234 5678 9012', '1234-5678-9012']) await assert.rejects(account(t, { name }), code('invalid_input'));
    await assert.rejects(account(t, { name: 'Ok', administrator: '1234 5678 9012 3456' }), code('invalid_input'));
    await assert.rejects(account(t, { name: 'x', routingNumber: '021000021' }), code('invalid_input'));
    await assert.rejects(t.db.pool.query(`insert into hsa_accounts (household_id, name, created_by) values ($1, '1234 5678 9012', $2)`, [t.actor.householdId, t.actor.userId]), /check/);
    const cur = await acc.getHsaAccount(t.db.pool, t.actor, a.id);
    await acc.updateHsaAccount(t.db.pool, t.actor, { id: a.id, version: cur.version, name: 'Joint HSA', administrator: 'Other Bank', lastFour: '' }, 'r');
    await assert.rejects(acc.updateHsaAccount(t.db.pool, t.actor, { id: a.id, version: cur.version, name: 'Stale', administrator: '', lastFour: '' }, 'r'), code('stale_version'));
    await acc.archiveHsaAccount(t.db.pool, t.actor, { id: a.id, version: cur.version + 1, archived: 'yes' }, 'r');
    assert.equal((await acc.listHsaAccounts(t.db.pool, t.actor)).items.length, 0);
    assert.equal((await acc.listHsaAccounts(t.db.pool, t.actor, { archived: true })).items.length, 1);
    await assert.rejects(t.db.pool.query('delete from hsa_accounts'), /never deleted/);
    const audit = JSON.stringify([...await t.audit('hsa_account.created'), ...await t.audit('hsa_account.updated')]);
    assert.ok(!audit.includes('Joint HSA') && !audit.includes('7788') && !audit.includes('Example HSA Bank'), 'audit rows hold ids and flags only');
  } finally { await t.db.drop(); }
});

test('an account created with a spending card saves the card as a linked HSA/FSA payment method in the same step', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const a = await account(t, { hasCard: 'yes', cardNickname: 'HSA Visa', cardLastFour: '0042' });
    assert.ok(a.paymentMethodId);
    const methods = await pm.listPaymentMethods(t.db.pool, t.actor);
    assert.equal(methods.items.length, 1);
    assert.equal(methods.items[0].id, a.paymentMethodId);
    assert.equal(methods.items[0].kind, 'hsa_fsa_card');
    assert.equal(methods.items[0].lastFour, '0042');
    assert.equal(methods.items[0].hsaAccountId, a.id, 'linked without a second step');
    // Both records are audited the same way as when created separately, and the audit holds ids and flags only.
    const created = await t.audit('hsa_account.created');
    assert.equal(created[0].detail.withSpendingCard, true);
    const pmAudit = await t.audit('payment_method.created');
    assert.equal(pmAudit.length, 1);
    assert.equal(pmAudit[0].detail.hsaAccountId, a.id);
    assert.ok(!JSON.stringify([...created, ...pmAudit]).includes('HSA Visa'));
    // The card works at once: a payment recorded with it is paid directly from the account.
    const bill = await t.bill({ memberId: await t.member(), providerId: await t.provider(), originalAmount: '80.00' });
    const p = await t.pay1({ amount: '25.00', billId: bill.id, paidWithId: a.paymentMethodId });
    assert.equal((await t.payment(p.id)).payment.hsaAccountId, a.id);
    // No card requested: an ordinary account, no method, and card text left in the form is ignored.
    const plain = await account(t, { name: 'No card HSA', cardNickname: 'Ignored', cardLastFour: '9999' });
    assert.equal(plain.paymentMethodId, null);
    assert.equal((await pm.listPaymentMethods(t.db.pool, t.actor)).items.length, 1);
    // Stale card text with the box unticked is ignored, even if it would be invalid.
    assert.equal((await account(t, { name: 'Stale text', cardNickname: 'x'.repeat(80), cardLastFour: '12' })).paymentMethodId, null);
    // A ticked box needs a valid nickname and last four.
    await assert.rejects(account(t, { name: 'Needs nick', hasCard: 'yes', cardNickname: '' }), code('invalid_input'));
    await assert.rejects(account(t, { name: 'Bad four', hasCard: 'yes', cardNickname: 'Card', cardLastFour: '12' }), code('invalid_input'));
    await assert.rejects(account(t, { name: 'Number', hasCard: 'yes', cardNickname: '4111 1111 1111 1111' }), code('invalid_input'));
  } finally { await t.db.drop(); }
});

test('a spending card that cannot be saved leaves no HSA account behind', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    await pm.createPaymentMethod(t.db.pool, t.actor, { nickname: 'HSA Visa', kind: 'credit_card', lastFour: '' }, 'r');
    await assert.rejects(account(t, { hasCard: 'yes', cardNickname: 'hsa visa' }), code('conflict'));
    assert.equal((await acc.listHsaAccounts(t.db.pool, t.actor, { archived: true })).items.length, 0, 'the account was rolled back');
    assert.equal((await t.audit('hsa_account.created')).length, 0);
    // The same name works once the card nickname is free.
    const a = await account(t, { hasCard: 'yes', cardNickname: 'Second HSA Visa' });
    assert.ok(a.paymentMethodId);
  } finally { await t.db.drop(); }
});

test('cards: only an HSA/FSA card can be linked, only to an active account; the link can change without touching old payments', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const a = await account(t); const b = await account(t, { name: 'Second HSA', lastFour: '' });
    await assert.rejects(pm.createPaymentMethod(t.db.pool, t.actor, { nickname: 'Plain Visa', kind: 'credit_card', lastFour: '', hsaAccountId: a.id }, 'r'), code('invalid_input'));
    await assert.rejects(card(t, randomUUID()), code('not_found'));
    const c = await card(t, a.id);
    assert.equal((await pm.getPaymentMethod(t.db.pool, t.actor, c.id)).hsaAccountName, 'Family HSA');
    // A card without a link is only a label: its payments stay claimable.
    const unlinked = await card(t, undefined, { nickname: 'Old HSA card', lastFour: '' });
    assert.equal((await pm.getPaymentMethod(t.db.pool, t.actor, unlinked.id)).hsaAccountId, null);
    const m = await t.member(); const p = await t.provider();
    const bill = await t.bill({ memberId: m, providerId: p, originalAmount: '80.00' });
    const direct = await t.pay1({ amount: '30.00', billId: bill.id, paidWithId: c.id });
    // Relinking the card to another account does not rewrite the payment already recorded.
    const cur = await pm.getPaymentMethod(t.db.pool, t.actor, c.id);
    await pm.updatePaymentMethod(t.db.pool, t.actor, { id: c.id, version: cur.version, nickname: 'HSA Visa', kind: 'hsa_fsa_card', lastFour: '0042', hsaAccountId: b.id }, 'r');
    assert.equal((await t.payment(direct.id)).payment.hsaAccountName, 'Family HSA');
    // Changing the card's type away from HSA/FSA is refused while it names an account, and unlinking is allowed.
    const cur2 = await pm.getPaymentMethod(t.db.pool, t.actor, c.id);
    await assert.rejects(pm.updatePaymentMethod(t.db.pool, t.actor, { id: c.id, version: cur2.version, nickname: 'HSA Visa', kind: 'credit_card', lastFour: '', hsaAccountId: b.id }, 'r'), code('invalid_input'));
    await pm.updatePaymentMethod(t.db.pool, t.actor, { id: c.id, version: cur2.version, nickname: 'HSA Visa', kind: 'credit_card', lastFour: '', hsaAccountId: '' }, 'r');
    assert.equal((await pm.getPaymentMethod(t.db.pool, t.actor, c.id)).hsaAccountId, null);
    // An archived account cannot be linked.
    const arch = await acc.getHsaAccount(t.db.pool, t.actor, b.id);
    await acc.archiveHsaAccount(t.db.pool, t.actor, { id: b.id, version: arch.version, archived: 'yes' }, 'r');
    await assert.rejects(card(t, b.id, { nickname: 'Another' }), code('conflict'));
  } finally { await t.db.drop(); }
});

test('paying with an HSA card records a direct payment: nothing to claim, decide or reimburse, and every HSA figure follows', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const m = await t.member(); const p = await t.provider();
    const a = await account(t); const c = await card(t, a.id);
    const billD = await t.bill({ memberId: m, providerId: p, originalAmount: '100.00' });
    const billO = await t.bill({ memberId: m, providerId: p, originalAmount: '60.00' });
    const direct = await t.pay1({ amount: '100.00', billId: billD.id, paidWithId: c.id });
    const ordinary = await t.pay1({ amount: '60.00', billId: billO.id });
    const dp = (await t.payment(direct.id)).payment;
    assert.deepEqual([dp.hsaAccountId, dp.hsaAccountName, dp.paidWithName], [a.id, 'Family HSA', 'HSA Visa']);
    assert.equal((await t.payment(ordinary.id)).payment.hsaAccountId, null);
    assert.equal((await t.detail(billD.id)).openBalanceCents, '0', 'applying the cash works exactly as for any payment');
    const rec = (await t.audit('payment.recorded')).find((r) => r.detail.paymentId === direct.id).detail;
    assert.deepEqual([rec.paidDirectlyFromHsa, rec.hsaAccountId], [true, a.id]);

    const da = await alloc(t, direct.id); const oa = await alloc(t, ordinary.id);
    const figs = await hsaRepo.getAllocation(t.db.pool, t.actor.householdId, da);
    assert.deepEqual([figs.directHsa, figs.availableCents, figs.ceilingCents, figs.pendingCents, figs.receivedCents, figs.needsReviewCents], [true, '0', '0', '0', '0', '0']);
    // No claim, reimbursement or decision on a direct payment, with a message that says why.
    await assert.rejects(hsa.submitClaim(t.db.pool, t.actor, { idempotencyKey: t.key(), submittedOn: '2026-04-10', administrator: 'Bank', lines: [{ allocationId: da, amount: '10.00' }] }, 'r'), /paid directly from an HSA/);
    await assert.rejects(hsa.recordExternalReceipt(t.db.pool, t.actor, { idempotencyKey: t.key(), receivedOn: '2026-04-21', source: 'hsa_debit_card', evidenceType: 'statement', evidenceNote: 'x', lines: [{ allocationId: da, amount: '10.00' }] }, 'r'), /paid directly from an HSA/);
    await assert.rejects(decide(t, da), /paid directly from an HSA/);
    assert.equal(await t.count('hsa_entries'), 0);
    assert.equal(await t.count('hsa_eligibility_decisions'), 0);
    // The ordinary payment is claimable as before.
    await decide(t, oa);
    const ordFigs = await hsaRepo.getAllocation(t.db.pool, t.actor.householdId, oa);
    assert.deepEqual([ordFigs.directHsa, ordFigs.availableCents], [false, '1000']);

    const totals = await hsa.hsaSummary(t.db.pool, t.actor, {});
    assert.deepEqual([totals.directCount, totals.paidDirectlyCents, totals.undecidedCount, totals.availableCents, totals.eligibleCents], [1, '10000', 0, '1000', '1000']);
    const contract = (await listHsaFigures(t.db.pool, t.actor)).items.find((x) => x.allocationId === da);
    assert.deepEqual([contract.directHsa, contract.availableCents], [true, '0']);
    // The undecided queue never asks for a decision on a direct payment.
    assert.equal((await hsa.listHsaAllocations(t.db.pool, t.actor, { state: 'undecided' })).items.length, 0);

    // A refund of a direct payment returns cash to the HSA: net cash falls, and the account figures follow the cash summary.
    await t.refund(direct.id, { allocationId: da, amount: '25.00' });
    const use = await acc.listHsaAccounts(t.db.pool, t.actor);
    assert.deepEqual([use.items[0].paymentCount, use.items[0].netCashCents], [1, '7500']);
    assert.equal((await hsa.hsaSummary(t.db.pool, t.actor, {})).paidDirectlyCents, '7500');
    assert.deepEqual(await ledgerViolations(t.db.pool), []);
    // Voiding an unapplied direct payment counts zero.
    const free = await t.pay1({ amount: '9.00', paidWithId: c.id });
    await pay.voidPayment(t.db.pool, t.actor, { idempotencyKey: t.key(), paymentId: free.id, voidedOn: '2026-04-02', reason: 'Entered in error' }, 'r');
    assert.equal((await acc.listHsaAccounts(t.db.pool, t.actor)).items[0].netCashCents, '7500');
  } finally { await t.db.drop(); }
});

test('the database refuses both directions: HSA entries on a direct payment, and direct funding on a payment with HSA entries', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const m = await t.member(); const p = await t.provider();
    const a = await account(t); const c = await card(t, a.id);
    const bill1 = await t.bill({ memberId: m, providerId: p, originalAmount: '50.00' });
    const bill2 = await t.bill({ memberId: m, providerId: p, originalAmount: '50.00' });
    const direct = await t.pay1({ amount: '50.00', billId: bill1.id, paidWithId: c.id });
    const ordinary = await t.pay1({ amount: '50.00', billId: bill2.id });
    const da = await alloc(t, direct.id); const oa = await alloc(t, ordinary.id);
    const insertDecision = (client, paymentId, allocationId, billId) => hsaRepo.insertDecision(client, {
      id: randomUUID(), householdId: t.actor.householdId, userId: t.actor.userId, paymentId, allocationId, billId, status: 'eligible', eligibleCents: 1000n,
      rationale: 'Qualified', evidenceType: 'receipt', evidenceNote: 'x', contextNote: '', decidedOn: '2026-04-05',
    });
    const inTx = async (fn) => { const c2 = await t.db.pool.connect(); try { await c2.query('begin'); await fn(c2); await c2.query('commit'); } catch (e) { await c2.query('rollback'); throw e; } finally { c2.release(); } };
    // Direction 1: a decision on a direct payment is refused at commit.
    await assert.rejects(inTx((c2) => insertDecision(c2, direct.id, da, bill1.id)), /paid directly from an HSA/);
    // Direction 2: an ordinary payment with a decision cannot be turned into a direct payment, by SQL or any other writer.
    await decide(t, oa);
    await assert.rejects(t.db.pool.query(`insert into payment_hsa_funding (payment_id, household_id, hsa_account_id, created_by) values ($1, $2, $3, $4)`,
      [ordinary.id, t.actor.householdId, a.id, t.actor.userId]), /already has HSA/);
    // Funding is append-only, and refuses an archived account and another household's account.
    await assert.rejects(t.db.pool.query(`update payment_hsa_funding set hsa_account_id = hsa_account_id`), /append-only/);
    await assert.rejects(t.db.pool.query(`delete from payment_hsa_funding`), /append-only/);
    const free = await t.pay1({ amount: '5.00' });
    const arch = await account(t, { name: 'Closed HSA' });
    await acc.archiveHsaAccount(t.db.pool, t.actor, { id: arch.id, version: 1, archived: 'yes' }, 'r');
    await assert.rejects(t.db.pool.query(`insert into payment_hsa_funding (payment_id, household_id, hsa_account_id, created_by) values ($1, $2, $3, $4)`,
      [free.id, t.actor.householdId, arch.id, t.actor.userId]), /archived/);
    const h2 = (await t.db.pool.query(`insert into households (name) values ('Other Family') returning id`)).rows[0].id;
    await assert.rejects(t.db.pool.query(`insert into payment_hsa_funding (payment_id, household_id, hsa_account_id, created_by) values ($1, $2, $3, $4)`,
      [free.id, h2, a.id, t.actor.userId]), /foreign key/);
    // A restored database that broke the rule is reported by the ledger checks (restore loads with triggers off).
    await t.db.pool.query('alter table payment_hsa_funding disable trigger user');
    await t.db.pool.query(`insert into payment_hsa_funding (payment_id, household_id, hsa_account_id, created_by) values ($1, $2, $3, $4)`, [ordinary.id, t.actor.householdId, a.id, t.actor.userId]);
    await t.db.pool.query('alter table payment_hsa_funding enable trigger user');
    const broken = await ledgerViolations(t.db.pool);
    assert.equal(broken.length, 1);
    assert.match(broken[0], /^a payment paid directly from an HSA has no HSA claim, reimbursement or eligibility decision/);
  } finally { await t.db.drop(); }
});

test('paid with and direct HSA payment agree: the HSA funding is written only when the payment is recorded', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const a = await account(t); const b = await account(t, { name: 'Second HSA', lastFour: '' });
    const c1 = await card(t, a.id); const c2 = await card(t, a.id, { nickname: 'HSA Mastercard', lastFour: '' }); const other = await card(t, b.id, { nickname: 'Other HSA card', lastFour: '' });
    const plain = await pm.createPaymentMethod(t.db.pool, t.actor, { nickname: 'Plain Visa', kind: 'credit_card', lastFour: '' }, 'r');
    const set = (paymentId, paidWithId) => pm.setPaidWith(t.db.pool, t.actor, { idempotencyKey: t.key(), paymentId, paidWithId }, 'r');
    // An ordinary payment cannot be relabelled with an HSA-linked card (that would claim it was paid by the HSA without being so).
    const ordinary = await t.pay1({ amount: '20.00' });
    await assert.rejects(set(ordinary.id, c1.id), /only be chosen when the payment is recorded/);
    await set(ordinary.id, plain.id);
    // A direct payment keeps an HSA card of the same account and cannot be cleared or moved off HSA.
    const direct = await t.pay1({ amount: '20.00', paidWithId: c1.id });
    await set(direct.id, c2.id);
    assert.equal((await t.payment(direct.id)).payment.paidWithName, 'HSA Mastercard');
    await assert.rejects(set(direct.id, plain.id), /paid directly from an HSA/);
    await assert.rejects(set(direct.id, other.id), /same HSA account/);
    await assert.rejects(set(direct.id, null), /paid directly from an HSA/);
    assert.equal((await t.payment(direct.id)).payment.hsaAccountId, a.id);
    // An archived account makes the whole payment fail: it never falls back to an ordinary, claimable payment.
    const cur = await acc.getHsaAccount(t.db.pool, t.actor, b.id);
    await acc.archiveHsaAccount(t.db.pool, t.actor, { id: b.id, version: cur.version, archived: 'yes' }, 'r');
    const before = await t.count('payments');
    await assert.rejects(t.pay1({ amount: '7.00', paidWithId: other.id }), code('conflict'));
    assert.equal(await t.count('payments'), before);
    assert.equal(await t.count('payment_method_assignments'), 3, 'no half-recorded assignment either');
  } finally { await t.db.drop(); }
});

test('archiving an HSA account races recording a direct payment: never a direct payment into an archived account, no lock cycles', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    retryStats.lockConflicts = 0;
    for (let i = 0; i < 10; i += 1) {
      const a = await account(t, { name: `Race HSA ${i}`, lastFour: '' }); const c = await card(t, a.id, { nickname: `Race card ${i}`, lastFour: '' });
      const v = (await acc.getHsaAccount(t.db.pool, t.actor, a.id)).version;
      const [rec, arch] = await Promise.allSettled([t.pay1({ amount: '1.00', paidWithId: c.id }), acc.archiveHsaAccount(t.db.pool, t.actor, { id: a.id, version: v, archived: 'yes' }, 'r')]);
      for (const r of [rec, arch]) if (r.status === 'rejected') assert.ok(['conflict', 'stale_version'].includes(r.reason.code), `unexpected ${r.reason?.code ?? r.reason}`);
      assert.equal(arch.status, 'fulfilled');
      const funded = (await t.db.pool.query(`select count(*)::int n from payment_hsa_funding where hsa_account_id = $1`, [a.id])).rows[0].n;
      assert.equal(funded, rec.status === 'fulfilled' ? 1 : 0, 'a payment exists exactly when its recording succeeded, and it is direct');
    }
    // A direct payment racing a claim on that payment's allocation cannot both commit (guards at commit under the payment lock).
    assert.equal(retryStats.lockConflicts, 0, 'no lock-cycle retries');
    assert.deepEqual(await ledgerViolations(t.db.pool), []);
  } finally { await t.db.drop(); }
});

test('existing HSA figures are unchanged for ordinary payments: the new view equals the old definition, and a direct payment adds a zero row', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const m = await t.member(); const p = await t.provider();
    const a = await account(t); const c = await card(t, a.id);
    const mk = async (amount) => { const b = await t.bill({ memberId: m, providerId: p, originalAmount: amount }); const pmt = await t.pay1({ amount, billId: b.id }); return { pmt, al: await alloc(t, pmt.id) }; };
    const x = await mk('100.00'); const y = await mk('80.00'); const z = await mk('40.00');
    // Claim, partial receipt, an external reimbursement, and a refund that leaves reimbursement above the ceiling (needs review).
    const dec = (al, amt) => hsa.recordDecision(t.db.pool, t.actor, { idempotencyKey: t.key(), allocationId: al, version: '0', status: 'eligible', eligibleAmount: amt, rationale: 'Qualified', evidenceType: 'receipt', evidenceNote: 'r', decidedOn: '2026-04-05' }, 'r');
    await dec(x.al, '100.00'); await dec(y.al, '80.00');
    const claim = await hsa.submitClaim(t.db.pool, t.actor, { idempotencyKey: t.key(), submittedOn: '2026-04-10', administrator: 'Bank', lines: [{ allocationId: x.al, amount: '60.00' }] }, 'r');
    const line = (await hsaRepo.linesOfClaim(t.db.pool, t.actor.householdId, claim.id))[0];
    await hsa.recordReceipt(t.db.pool, t.actor, { idempotencyKey: t.key(), receivedOn: '2026-04-20', source: 'administrator_transfer', lines: [{ lineId: line.lineId, amount: '20.00' }] }, 'r');
    await hsa.recordExternalReceipt(t.db.pool, t.actor, { idempotencyKey: t.key(), receivedOn: '2026-04-21', source: 'hsa_debit_card', evidenceType: 'statement', evidenceNote: 's', lines: [{ allocationId: y.al, amount: '70.00' }] }, 'r');
    await t.refund(y.pmt.id, { allocationId: y.al, amount: '30.00' });
    const direct = await t.pay1({ amount: '25.00', paidWithId: c.id, billId: (await t.bill({ memberId: m, providerId: p, originalAmount: '25.00' })).id });
    const dAl = await alloc(t, direct.id);
    // The original (migration 0006) view definition, run against the same data.
    const OLD = `select s.allocation_id, s.net_cents, s.decision_status, s.ceiling_cents, s.pending_cents, s.received_cents,
         greatest(0, s.ceiling_cents - s.pending_cents - s.received_cents) as available_cents,
         greatest(0, s.pending_cents + s.received_cents - s.ceiling_cents) as needs_review_cents
      from (select n.allocation_id, n.net_cents::bigint as net_cents, d.status as decision_status, least(coalesce(d.eligible_cents, 0), n.net_cents::bigint) as ceiling_cents,
             h.pending_cents::bigint as pending_cents, h.received_cents::bigint as received_cents
        from allocation_net n
        left join lateral (select x.status, x.eligible_cents from hsa_eligibility_decisions x where x.allocation_id = n.allocation_id order by x.seq desc limit 1) d on true
        cross join lateral (select
            coalesce(sum(e.amount_cents) filter (where e.kind = 'reserve'), 0) - coalesce(sum(e.amount_cents) filter (where e.kind in ('receipt', 'reject', 'cancel')), 0) as pending_cents,
            coalesce(sum(e.amount_cents) filter (where e.kind in ('receipt', 'external_receipt')), 0) - coalesce(sum(e.amount_cents) filter (where e.kind = 'receipt_reversal'), 0) as received_cents
          from hsa_entries e where e.allocation_id = n.allocation_id) h) s order by s.allocation_id`;
    const cols = 'allocation_id, net_cents, decision_status, ceiling_cents, pending_cents, received_cents, available_cents, needs_review_cents';
    const oldRows = (await t.db.pool.query(OLD)).rows.filter((r) => r.allocation_id !== dAl);
    const newRows = (await t.db.pool.query(`select ${cols} from hsa_allocation_status where not direct_hsa order by allocation_id`)).rows;
    assert.deepEqual(newRows, oldRows, 'every ordinary allocation reads exactly as before');
    assert.ok(newRows.some((r) => BigInt(r.needs_review_cents) > 0n), 'the fixture includes a needs-review case');
    const d = (await t.db.pool.query(`select net_cents, available_cents, needs_review_cents, ceiling_cents from hsa_allocation_status where allocation_id = $1`, [dAl])).rows[0];
    assert.deepEqual(d, { net_cents: '2500', available_cents: '0', needs_review_cents: '0', ceiling_cents: '0' });
    assert.deepEqual(await ledgerViolations(t.db.pool), []);
  } finally { await t.db.drop(); }
});

test('a card relinked after use leaves recorded payments alone; choosing the current card again changes nothing', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const a = await account(t);
    // An unlinked HSA/FSA card pays an ordinary payment; linking the card later does not make that payment direct, and re-saving it is a no-op.
    const c = await card(t, undefined, { nickname: 'Old HSA card', lastFour: '' });
    const ordinary = await t.pay1({ amount: '20.00', paidWithId: c.id });
    const cur = await pm.getPaymentMethod(t.db.pool, t.actor, c.id);
    await pm.updatePaymentMethod(t.db.pool, t.actor, { id: c.id, version: cur.version, nickname: 'Old HSA card', kind: 'hsa_fsa_card', lastFour: '', hsaAccountId: a.id }, 'r');
    const set = (paymentId, paidWithId) => pm.setPaidWith(t.db.pool, t.actor, { idempotencyKey: t.key(), paymentId, paidWithId }, 'r');
    await set(ordinary.id, c.id);
    const o = (await t.payment(ordinary.id)).payment;
    assert.deepEqual([o.paidWithId, o.hsaAccountId], [c.id, null], 'still an ordinary, claimable payment with its card kept');
    assert.equal(await t.count('payment_method_assignments'), 1, 'choosing the current card again wrote nothing');
    // A direct payment whose card is unlinked afterwards keeps its card and its funding.
    const direct = await t.pay1({ amount: '20.00', paidWithId: c.id });
    const cur2 = await pm.getPaymentMethod(t.db.pool, t.actor, c.id);
    await pm.updatePaymentMethod(t.db.pool, t.actor, { id: c.id, version: cur2.version, nickname: 'Old HSA card', kind: 'hsa_fsa_card', lastFour: '', hsaAccountId: '' }, 'r');
    await set(direct.id, c.id);
    const d = (await t.payment(direct.id)).payment;
    assert.deepEqual([d.paidWithId, d.hsaAccountId], [c.id, a.id]);
    assert.equal(await t.count('payment_method_assignments'), 2);
  } finally { await t.db.drop(); }
});

test('guards race at commit: a direct funding and an HSA decision on the same payment cannot both commit, in any order', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const m = await t.member(); const p = await t.provider();
    const a = await account(t);
    const insertDecision = (client, ids) => hsaRepo.insertDecision(client, {
      id: randomUUID(), householdId: t.actor.householdId, userId: t.actor.userId, paymentId: ids.paymentId, allocationId: ids.allocationId, billId: ids.billId, status: 'eligible', eligibleCents: 1000n,
      rationale: 'Qualified', evidenceType: 'receipt', evidenceNote: 'x', contextNote: '', decidedOn: '2026-04-05',
    });
    const funding = (client, paymentId) => client.query(`insert into payment_hsa_funding (payment_id, household_id, hsa_account_id, created_by) values ($1, $2, $3, $4)`, [paymentId, t.actor.householdId, a.id, t.actor.userId]);
    const fresh = async () => {
      const bill = await t.bill({ memberId: m, providerId: p, originalAmount: '20.00' });
      const pmt = await t.pay1({ amount: '20.00', billId: bill.id });
      return { paymentId: pmt.id, allocationId: await alloc(t, pmt.id), billId: bill.id };
    };
    const open = async () => { const c = await t.db.pool.connect(); await c.query('begin'); return c; };
    const outcome = async (promise) => promise.then(() => 'ok', () => 'refused');
    const counts = async (ids) => [
      (await t.db.pool.query(`select count(*)::int n from payment_hsa_funding where payment_id = $1`, [ids.paymentId])).rows[0].n,
      (await t.db.pool.query(`select count(*)::int n from hsa_eligibility_decisions where payment_id = $1`, [ids.paymentId])).rows[0].n,
    ];
    // 1. Both open; the funding commits first, then the decision's commit-time guard sees it.
    let ids = await fresh(); let fa = await open(); let da = await open();
    await funding(fa, ids.paymentId); await insertDecision(da, ids);
    assert.equal(await outcome(fa.query('commit')), 'ok');
    assert.equal(await outcome(da.query('commit')), 'refused');
    fa.release(); await da.query('rollback').catch(() => {}); da.release();
    assert.deepEqual(await counts(ids), [1, 0]);
    // 2. Both open; the decision starts committing first (its guard waits for the funding's payment lock), then the funding commits.
    ids = await fresh(); fa = await open(); da = await open();
    await funding(fa, ids.paymentId); await insertDecision(da, ids);
    const pending = outcome(da.query('commit'));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await outcome(fa.query('commit')), 'ok');
    assert.equal(await pending, 'refused');
    fa.release(); await da.query('rollback').catch(() => {}); da.release();
    assert.deepEqual(await counts(ids), [1, 0]);
    // 3. The decision commits first: the funding insert is then refused outright.
    ids = await fresh(); da = await open();
    await insertDecision(da, ids); await da.query('commit'); da.release();
    fa = await open();
    assert.equal(await outcome(funding(fa, ids.paymentId)), 'refused');
    await fa.query('rollback'); fa.release();
    assert.deepEqual(await counts(ids), [0, 1]);
    assert.deepEqual(await ledgerViolations(t.db.pool), []);
  } finally { await t.db.drop(); }
});

test('a partly applied direct payment: the HSA card counts what was applied, the account counts the whole payment, and the export marks it', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const m = await t.member(); const p = await t.provider();
    const a = await account(t); const c = await card(t, a.id);
    const bill = await t.bill({ memberId: m, providerId: p, originalAmount: '60.00' });
    const direct = await t.pay1({ amount: '100.00', billId: bill.id, allocateAmount: '60.00', paidWithId: c.id });
    const totals = await hsa.hsaSummary(t.db.pool, t.actor, {});
    assert.deepEqual([totals.directCount, totals.paidDirectlyCents], [1, '6000'], 'the HSA page counts cash applied to bills');
    assert.equal((await acc.listHsaAccounts(t.db.pool, t.actor)).items[0].netCashCents, '10000', 'the account counts the whole payment');
    assert.equal((await t.payment(direct.id)).payment.unappliedCents, '4000');
    // The export marks the row instead of calling it undecided.
    const out = await hsa.exportHsa(t.db.pool, t.actor, { kind: 'allocations' }, 'r');
    assert.match(out.csv, /paid_directly_from_hsa/);
    assert.doesNotMatch(out.csv, /,unknown,/);
    // Dotted or slashed account-number-like labels are refused too (best effort; another separator would pass).
    for (const name of ['1234.5678.9012', '1234/5678/9012', '1234_5678_9012']) await assert.rejects(account(t, { name }), code('invalid_input'));
  } finally { await t.db.drop(); }
});
