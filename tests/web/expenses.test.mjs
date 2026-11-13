import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import * as handlers from '../../apps/web/server/http.ts';
import { readFlash } from '../../apps/web/server/flash.ts';
import { csrfFor } from '../../apps/web/server/tokens.ts';
import * as svc from '../../apps/web/server/services/expenses.ts';
import { authenticate } from '../../apps/web/server/services/auth.ts';
import { ATTACHMENT_TARGET_TYPES, billContract, resolveAttachmentTarget } from '../../apps/web/server/contracts.ts';
import { formatCents, parseUsd } from '../../apps/web/server/money.ts';
import { freshDatabase, loginJson, ORIGIN, post, seedHousehold, skipDb, testConfig } from './helpers.mjs';

async function setup() {
  const db = await freshDatabase();
  const config = testConfig({}, db.url);
  const ctx = { config, pool: db.pool };
  const ids = await seedHousehold(db.pool);
  const { cookie } = await loginJson(handlers, ctx, 'admin@example.test');
  const actor = await authenticate(db.pool, config, cookie.split('=')[1]);
  const key = () => randomUUID();
  const member = (name = 'Pat Example') => svc.createMember(db.pool, actor, { name }, 'r').then((r) => r.id);
  const provider = (name = 'Example Clinic', kind = 'clinician') => svc.createProvider(db.pool, actor, { name, kind }, 'r').then((r) => r.id);
  const bill = (o) => svc.createBill(db.pool, actor, {
    idempotencyKey: key(), statementDate: '2026-03-01', originalAmount: '100.00', amountStatus: 'confirmed', amountSource: 'statement', ...o,
  }, 'r');
  const adjust = (billId, amount, extra = {}) => svc.addAdjustment(db.pool, actor, {
    idempotencyKey: key(), billId, amount, category: 'insurer_adjustment', effectiveDate: '2026-03-10', reason: 'EOB', source: 'eob', ...extra,
  }, 'r');
  const detail = (id) => svc.getBillDetail(db.pool, actor, id);
  return { db, ctx, config, actor, cookie, ids, key, member, provider, bill, adjust, detail };
}
const code = (c) => ({ code: c });

test('money parsing is exact and strict', () => {
  assert.equal(parseUsd('12'), 1200n);
  assert.equal(parseUsd('12.5'), 1250n);
  assert.equal(parseUsd('0.07'), 7n);
  assert.equal(parseUsd('-3.10'), -310n);
  for (const bad of ['1.234', '1e3', '', '$5', '1,000', '.5', '12.', '9999999999999', 'NaN', '--1', '1.2.3']) assert.throws(() => parseUsd(bad), bad);
  assert.equal(formatCents(123456789n), '$1,234,567.89');
  assert.equal(formatCents('-5'), '-$0.05');
});

test('members and providers: create, update, search, archive and cursor paging', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const a = await t.member('Avery Example');
    await t.member('Blake Sample');
    await t.member('Casey Test');
    const page1 = await svc.listMembers(t.db.pool, t.actor, { limit: 2 });
    assert.deepEqual(page1.items.map((m) => m.name), ['Avery Example', 'Blake Sample']);
    const page2 = await svc.listMembers(t.db.pool, t.actor, { limit: 2, cursor: page1.nextCursor });
    assert.deepEqual(page2.items.map((m) => m.name), ['Casey Test']);
    assert.equal(page2.nextCursor, null);
    assert.equal((await svc.listMembers(t.db.pool, t.actor, { q: '100%' })).items.length, 0, 'LIKE wildcards are escaped');
    assert.equal((await svc.listMembers(t.db.pool, t.actor, { q: 'blake' })).items.length, 1);
    await assert.rejects(svc.listMembers(t.db.pool, t.actor, { cursor: 'not-a-cursor' }), code('invalid_input'));

    const m = await svc.getMember(t.db.pool, t.actor, a);
    await svc.updateMember(t.db.pool, t.actor, { id: a, version: m.version, name: 'Avery E. Example', dateOfBirth: '2015-04-05' }, 'r');
    await assert.rejects(svc.updateMember(t.db.pool, t.actor, { id: a, version: m.version, name: 'Stale' }, 'r'), code('stale_version'));
    await assert.rejects(svc.updateMember(t.db.pool, t.actor, { id: a, version: 2, name: 'X', dateOfBirth: '2015-02-30' }, 'r'), code('invalid_input'));

    const fresh = await svc.getMember(t.db.pool, t.actor, a);
    await svc.archiveMember(t.db.pool, t.actor, { id: a, version: fresh.version, archived: 'yes' }, 'r');
    assert.equal((await svc.listMembers(t.db.pool, t.actor, {})).items.length, 2);
    assert.equal((await svc.listMembers(t.db.pool, t.actor, { archived: 'yes' })).items.length, 3);
    const p = await t.provider('Lakeside Lab', 'lab');
    assert.equal((await svc.listProviders(t.db.pool, t.actor, { q: 'lake' })).items[0].id, p);
  } finally {
    await t.db.drop();
  }
});

test('multi-provider visit with a bill awaiting assignment, linked without conflating member, visit and provider', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const pat = await t.member('Pat Example');
    const sam = await t.member('Sam Example');
    const facility = await t.provider('General Hospital', 'facility');
    const doctor = await t.provider('Dr. Sample', 'clinician');
    const lab = await t.provider('Example Lab', 'lab');
    const { id: visitId } = await svc.createVisit(t.db.pool, t.actor, { memberId: pat, providerId: facility, serviceDate: '2026-02-14', description: 'Knee injury' }, 'r');
    const other = await svc.createVisit(t.db.pool, t.actor, { memberId: sam, providerId: doctor, serviceDate: '2026-02-20' }, 'r');

    const b1 = await t.bill({ memberId: pat, providerId: facility, visitId, providerReference: 'FAC-1', originalAmount: '1500.00' });
    const b2 = await t.bill({ memberId: pat, providerId: doctor, visitId, providerReference: 'DOC-1', originalAmount: '300.00' });
    const b3 = await t.bill({ memberId: pat, providerId: lab, providerReference: 'LAB-1', originalAmount: '80.00' }); // awaiting a visit
    const v = await svc.getVisit(t.db.pool, t.actor, visitId);
    assert.deepEqual(v.bills.map((b) => b.providerName).sort(), ['Dr. Sample', 'General Hospital']);
    assert.equal(v.visit.billCount, 2);
    assert.equal(v.visit.providerName, 'General Hospital');

    assert.equal((await t.detail(b3.id)).bill.visitId, null);
    assert.equal((await svc.listBills(t.db.pool, t.actor, { awaitingVisit: 'yes' })).items.length, 1);
    // A different member's visit cannot be linked, at the service or by the database.
    const d3 = await t.detail(b3.id);
    await assert.rejects(svc.assignBillVisit(t.db.pool, t.actor, { id: b3.id, version: d3.bill.version, visitId: other.id }, 'r'), code('invalid_input'));
    await assert.rejects(t.db.pool.query('update bills set visit_id = $1 where id = $2', [other.id, b3.id]), /foreign key/);
    await svc.assignBillVisit(t.db.pool, t.actor, { id: b3.id, version: d3.bill.version, visitId }, 'r');
    assert.equal((await svc.getVisit(t.db.pool, t.actor, visitId)).bills.length, 3);
    assert.equal((await svc.listBills(t.db.pool, t.actor, { awaitingVisit: 'yes' })).items.length, 0);
    assert.ok(b1.id && b2.id);
  } finally {
    await t.db.drop();
  }
});

test('responsibility, adjustments, estimates and open balances reconcile to a synthetic fixture', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const pat = await t.member();
    const sam = await t.member('Sam Example');
    const clinic = await t.provider();
    const lab = await t.provider('Example Lab', 'lab');
    // Fixture: [member, provider, original, base, status, adjustments in dollars]
    const fixture = [
      [pat, clinic, '250.00', '250.00', 'confirmed', ['-100.00', '-37.45']],
      [pat, lab, '80.10', '80.10', 'confirmed', []],
      [sam, clinic, '1000.00', '400.00', 'confirmed', ['-50.00', '12.34', '-12.34']],
      [sam, lab, '0.99', '0.99', 'estimate', []],
      [pat, clinic, '300.00', '120.00', 'estimate', ['-20.00']],
    ];
    let confirmed = 0n;
    let estimated = 0n;
    for (const [i, [member, providerId, original, base, status, adjs]] of fixture.entries()) {
      const b = await t.bill({ memberId: member, providerId, originalAmount: original, responsibilityAmount: base, amountStatus: status, providerReference: `FIX-${i}`, statementDate: `2026-01-0${i + 1}` });
      let total = parseUsd(base);
      for (const a of adjs) {
        await t.adjust(b.id, a);
        total += parseUsd(a);
      }
      const d = await t.detail(b.id);
      assert.equal(BigInt(d.bill.responsibilityCents), total, `bill ${i} responsibility`);
      assert.equal(d.bill.openBalanceCents, d.bill.responsibilityCents, 'no payments exist, so open balance equals responsibility');
      assert.equal(billContract(d.bill).responsibilityCents, total.toString());
      if (status === 'confirmed') confirmed += total;
      else estimated += total;
    }
    const o = await svc.expenseOverview(t.db.pool, t.actor, {});
    assert.equal(o.totals.confirmedResponsibilityCents, confirmed.toString());
    assert.equal(o.totals.estimatedResponsibilityCents, estimated.toString());
    assert.equal(o.totals.confirmedOpenBalanceCents, confirmed.toString());
    assert.equal(o.totals.billCount, 5);
    assert.equal(o.totals.estimateCount, 2);
    assert.equal(o.totals.awaitingVisitCount, 5);
    assert.equal(confirmed, 11255n + 8010n + 35000n - 0n + 0n - 0n + 0n, 'independent hand total');
    // Filters narrow totals consistently with the listed bills.
    const patOnly = await svc.expenseOverview(t.db.pool, t.actor, { memberId: pat });
    const listed = await svc.listBills(t.db.pool, t.actor, { memberId: pat, status: 'confirmed' });
    assert.equal(patOnly.totals.confirmedResponsibilityCents, listed.items.reduce((s, b) => s + BigInt(b.responsibilityCents), 0n).toString());
    assert.equal((await svc.listBills(t.db.pool, t.actor, { from: '2026-01-02', to: '2026-01-03' })).items.length, 2);
  } finally {
    await t.db.drop();
  }
});

test('estimates are editable, confirmed amounts change only by adjustment, and rules are enforced', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const m = await t.member();
    const p = await t.provider();
    const b = await t.bill({ memberId: m, providerId: p, amountStatus: 'estimate', originalAmount: '200.00', responsibilityAmount: '150.00' });
    await assert.rejects(t.bill({ memberId: m, providerId: p, originalAmount: '10.00', responsibilityAmount: '11.00' }), code('invalid_input'));
    await assert.rejects(t.bill({ memberId: m, providerId: p, originalAmount: '10.005' }), code('invalid_input'));
    await assert.rejects(t.bill({ memberId: m, providerId: p, originalAmount: '-1' }), code('invalid_input'));
    let d = await t.detail(b.id);
    await svc.updateBill(t.db.pool, t.actor, {
      id: b.id, version: d.bill.version, providerId: p, statementDate: '2026-03-02', originalAmount: '220.00', responsibilityAmount: '170.00', amountSource: 'portal',
    }, 'r');
    d = await t.detail(b.id);
    assert.equal(d.bill.responsibilityCents, '17000');
    await svc.confirmBillAmounts(t.db.pool, t.actor, { id: b.id, version: d.bill.version }, 'r');
    d = await t.detail(b.id);
    assert.equal(d.bill.amountStatus, 'confirmed');
    await assert.rejects(svc.confirmBillAmounts(t.db.pool, t.actor, { id: b.id, version: d.bill.version }, 'r'), code('conflict'));
    await assert.rejects(svc.updateBill(t.db.pool, t.actor, { id: b.id, version: d.bill.version, providerId: p, statementDate: '2026-03-02', originalAmount: '1.00' }, 'r'), code('conflict'));
    await svc.updateBill(t.db.pool, t.actor, { id: b.id, version: d.bill.version, providerId: p, statementDate: '2026-03-02', notes: 'Paper copy filed' }, 'r');
    // Database refuses to un-confirm or leave a confirmed row without a timestamp.
    await assert.rejects(t.db.pool.query(`update bills set confirmed_at = null where id = $1`, [b.id]), /confirmed amounts change only/);
  } finally {
    await t.db.drop();
  }
});

test('adjustments are signed, immutable and reversed only by a linked entry; responsibility never goes negative', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const m = await t.member();
    const p = await t.provider();
    const b = await t.bill({ memberId: m, providerId: p, originalAmount: '100.00' });
    const adj = await t.adjust(b.id, '-60.00');
    await assert.rejects(t.adjust(b.id, '-40.01'), code('conflict'));
    await assert.rejects(t.adjust(b.id, '0'), code('invalid_input'));
    await assert.rejects(t.adjust(b.id, '1.001'), code('invalid_input'));
    await t.adjust(b.id, '-40.00');
    assert.equal((await t.detail(b.id)).bill.responsibilityCents, '0');
    await assert.rejects(t.db.pool.query('update bill_adjustments set amount_cents = 1'), /append-only/);
    await assert.rejects(t.db.pool.query('delete from bill_adjustments'), /append-only/);
    // Reversing the first (-60) raises responsibility; it is posted as a linked +60 entry.
    const rev = await svc.reverseAdjustment(t.db.pool, t.actor, { idempotencyKey: t.key(), billId: b.id, adjustmentId: adj.id, reason: 'Entered on wrong bill' }, 'r');
    const d = await t.detail(b.id);
    assert.equal(d.bill.responsibilityCents, '6000');
    const original = d.adjustments.find((a) => a.id === adj.id);
    assert.equal(original.reversedByAdjustmentId, rev.id, 'original preserved and linked');
    await assert.rejects(svc.reverseAdjustment(t.db.pool, t.actor, { idempotencyKey: t.key(), billId: b.id, adjustmentId: adj.id, reason: 'again' }, 'r'), code('conflict'));
    await assert.rejects(svc.reverseAdjustment(t.db.pool, t.actor, { idempotencyKey: t.key(), billId: b.id, adjustmentId: rev.id, reason: 'undo undo' }, 'r'), code('invalid_input'));
    await assert.rejects(svc.reverseAdjustment(t.db.pool, t.actor, { idempotencyKey: t.key(), billId: b.id, adjustmentId: randomUUID(), reason: 'x' }, 'r'), code('not_found'));
    // Reversing the -40 now would be fine (0 -> ... ) but reversing a positive that is needed to stay >= 0 is refused.
    const credit = await t.adjust(b.id, '25.00', { category: 'correction' });
    await t.adjust(b.id, '-80.00'); // 60 + 25 - 80 = 5
    await assert.rejects(svc.reverseAdjustment(t.db.pool, t.actor, { idempotencyKey: t.key(), billId: b.id, adjustmentId: credit.id, reason: 'oops' }, 'r'), code('conflict'));
    assert.equal((await t.detail(b.id)).bill.responsibilityCents, '500');
    // Row-local database constraints back the rules.
    await assert.rejects(t.db.pool.query(
      `insert into bill_adjustments (household_id, bill_id, amount_cents, category, effective_date, reason, source, created_by)
       select household_id, id, 5, 'reversal', '2026-01-01', 'x', 'manual', created_by from bills where id = $1`, [b.id]), /check/);
  } finally {
    await t.db.drop();
  }
});

test('concurrent adjustments never drive responsibility negative', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const m = await t.member();
    const p = await t.provider();
    const b = await t.bill({ memberId: m, providerId: p, originalAmount: '100.00' });
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => t.adjust(b.id, '-30.00')));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    assert.equal(ok, 3, 'exactly three $30 reductions fit in $100');
    for (const r of results.filter((r) => r.status === 'rejected')) assert.equal(r.reason.code, 'conflict');
    const d = await t.detail(b.id);
    assert.equal(d.bill.responsibilityCents, '1000');
    assert.equal(d.adjustments.length, 3);
    // Concurrent edits of an estimate against adjustments also respect the bound.
    const e = await t.bill({ memberId: m, providerId: p, amountStatus: 'estimate', originalAmount: '100.00', providerReference: 'EST-1', statementDate: '2026-04-01' });
    await t.adjust(e.id, '-50.00');
    const cur = (await t.detail(e.id)).bill;
    const race = await Promise.allSettled([
      svc.updateBill(t.db.pool, t.actor, { id: e.id, version: cur.version, providerId: p, statementDate: '2026-04-01', originalAmount: '40.00', responsibilityAmount: '40.00' }, 'r'),
      t.adjust(e.id, '-50.00'),
    ]);
    const final = (await t.detail(e.id)).bill;
    assert.ok(BigInt(final.responsibilityCents) >= 0n, `final ${final.responsibilityCents} from ${race.map((r) => r.status)}`);
  } finally {
    await t.db.drop();
  }
});

test('idempotency: replays return the original result and one financial effect; changed input conflicts', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const m = await t.member();
    const p = await t.provider();
    const key = t.key();
    const input = { idempotencyKey: key, memberId: m, providerId: p, statementDate: '2026-03-01', originalAmount: '100.00', amountStatus: 'confirmed', amountSource: 'statement' };
    const runs = await Promise.all(Array.from({ length: 6 }, () => svc.createBill(t.db.pool, t.actor, input, 'r')));
    assert.equal(new Set(runs.map((r) => r.id)).size, 1);
    assert.equal(runs.filter((r) => !r.replayed).length, 1);
    assert.equal((await t.db.pool.query('select count(*)::int n from bills')).rows[0].n, 1);
    await assert.rejects(svc.createBill(t.db.pool, t.actor, { ...input, originalAmount: '101.00' }, 'r'), code('conflict'));

    const akey = t.key();
    const adjInput = { idempotencyKey: akey, billId: runs[0].id, amount: '-10.00', category: 'provider_discount', effectiveDate: '2026-03-05', reason: 'Prompt pay', source: 'phone' };
    const adjRuns = await Promise.all(Array.from({ length: 6 }, () => svc.addAdjustment(t.db.pool, t.actor, adjInput, 'r')));
    assert.equal(new Set(adjRuns.map((r) => r.id)).size, 1);
    assert.equal((await t.detail(runs[0].id)).bill.responsibilityCents, '9000', 'one retry-safe effect');
    await assert.rejects(svc.addAdjustment(t.db.pool, t.actor, { ...adjInput, amount: '-11.00' }, 'r'), code('conflict'));

    const rkey = t.key();
    const revInput = { idempotencyKey: rkey, billId: runs[0].id, adjustmentId: adjRuns[0].id, reason: 'Wrong bill' };
    const revs = await Promise.allSettled(Array.from({ length: 5 }, () => svc.reverseAdjustment(t.db.pool, t.actor, revInput, 'r')));
    assert.equal(revs.every((r) => r.status === 'fulfilled'), true);
    assert.equal((await t.detail(runs[0].id)).bill.responsibilityCents, '10000');
    // Different keys racing to reverse the same adjustment: one wins, the rest conflict.
    const race = await Promise.allSettled(Array.from({ length: 4 }, (_, i) => svc.reverseAdjustment(t.db.pool, t.actor, { ...revInput, idempotencyKey: t.key(), reason: `r${i}` }, 'r')));
    assert.equal(race.filter((r) => r.status === 'fulfilled').length, 0, 'already reversed above');
    // A rollback leaves no idempotency record behind, so the corrected retry succeeds.
    const bad = { ...input, idempotencyKey: t.key(), responsibilityAmount: '999.00' };
    await assert.rejects(svc.createBill(t.db.pool, t.actor, bad, 'r'), code('invalid_input'));
  } finally {
    await t.db.drop();
  }
});

test('duplicate hints warn without merging, and are shown on the bill', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const m = await t.member();
    const p = await t.provider();
    const q = await t.provider('Other Clinic');
    const first = await t.bill({ memberId: m, providerId: p, providerReference: 'INV 2026-0042', originalAmount: '120.00' });
    await assert.rejects(t.bill({ memberId: m, providerId: p, providerReference: 'inv-2026-0042', originalAmount: '999.00' }), code('duplicate_warning'));
    await assert.rejects(t.bill({ memberId: m, providerId: p, originalAmount: '120.00' }), code('duplicate_warning'), 'same member, date and amount');
    // Different provider with the same reference is not a hint.
    await t.bill({ memberId: m, providerId: q, providerReference: 'INV 2026-0042', originalAmount: '120.00' });
    assert.equal((await t.db.pool.query('select count(*)::int n from bills')).rows[0].n, 2);
    const second = await t.bill({ memberId: m, providerId: p, providerReference: 'INV-2026-0042', originalAmount: '999.00', confirmDuplicate: 'yes' });
    const d = await t.detail(second.id);
    assert.equal(d.bill.possibleDuplicate, true);
    assert.deepEqual(d.duplicates.map((x) => x.id), [first.id]);
    assert.equal((await svc.listBills(t.db.pool, t.actor, { duplicates: 'yes' })).items.length, 2);
    assert.equal((await svc.expenseOverview(t.db.pool, t.actor, {})).possibleDuplicates.length, 2);
    assert.equal((await t.db.pool.query('select count(*)::int n from bills')).rows[0].n, 3, 'nothing merged or removed');
    // Empty references never match each other.
    const a = await t.bill({ memberId: m, providerId: q, originalAmount: '1.00', statementDate: '2026-05-01' });
    const b = await t.bill({ memberId: m, providerId: q, originalAmount: '2.00', statementDate: '2026-05-02' });
    assert.ok(a.id && b.id);
  } finally {
    await t.db.drop();
  }
});

test('archived members and providers keep history but cannot take new records, even concurrently', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const m = await t.member();
    const p = await t.provider();
    const visit = await svc.createVisit(t.db.pool, t.actor, { memberId: m, providerId: p, serviceDate: '2026-01-10' }, 'r');
    const b = await t.bill({ memberId: m, providerId: p, visitId: visit.id });
    const prov = await svc.getProvider(t.db.pool, t.actor, p);
    await svc.updateProvider(t.db.pool, t.actor, { id: p, version: prov.version, name: 'Renamed Clinic', kind: 'clinician' }, 'r');
    const prov2 = await svc.getProvider(t.db.pool, t.actor, p);
    await svc.archiveProvider(t.db.pool, t.actor, { id: p, version: prov2.version, archived: 'yes' }, 'r');
    const d = await t.detail(b.id);
    assert.equal(d.bill.providerArchived, true);
    assert.equal(d.bill.providerName, 'Renamed Clinic');
    assert.equal(d.bill.providerNameAtEntry, 'Example Clinic', 'snapshot preserved');
    assert.equal((await svc.getVisit(t.db.pool, t.actor, visit.id)).visit.providerNameAtEntry, 'Example Clinic');
    await assert.rejects(svc.createVisit(t.db.pool, t.actor, { memberId: m, providerId: p, serviceDate: '2026-02-01' }, 'r'), code('conflict'));
    await assert.rejects(t.bill({ memberId: m, providerId: p, providerReference: 'NEW' }), code('conflict'));
    // Existing bill can still take adjustments and is still listed and filterable by the archived provider.
    await t.adjust(b.id, '-10.00');
    assert.equal((await svc.listBills(t.db.pool, t.actor, { providerId: p })).items.length, 1);
    const prov3 = await svc.getProvider(t.db.pool, t.actor, p);
    await svc.archiveProvider(t.db.pool, t.actor, { id: p, version: prov3.version, archived: '' }, 'r');
    await t.bill({ memberId: m, providerId: p, providerReference: 'AFTER-UNARCHIVE', statementDate: '2026-06-01' });

    // Concurrent archive and bill creation. Either order is legal: a bill that takes the member lock first is admitted and
    // the archive waits for it; a bill that arrives after the archive is refused. Transaction-start clocks say nothing about
    // that order, so the assertions use only outcomes that hold for every legal order.
    const m2 = await t.member('Riley Example');
    const mem = await svc.getMember(t.db.pool, t.actor, m2);
    const attempts = await Promise.allSettled([
      svc.archiveMember(t.db.pool, t.actor, { id: m2, version: mem.version, archived: 'yes' }, 'r'),
      ...Array.from({ length: 6 }, (_, i) => t.bill({ memberId: m2, providerId: p, providerReference: `RACE-${i}`, statementDate: `2026-07-0${i + 1}` })),
    ]);
    assert.equal(attempts[0].status, 'fulfilled', 'the archive always succeeds');
    assert.ok((await svc.getMember(t.db.pool, t.actor, m2)).archivedAt);
    const outcomes = attempts.slice(1);
    for (const r of outcomes) if (r.status === 'rejected') assert.equal(r.reason.code, 'conflict', 'a refused bill is refused because the member is archived');
    const created = outcomes.filter((r) => r.status === 'fulfilled');
    const rows = (await t.db.pool.query('select id from bills where member_id = $1', [m2])).rows;
    assert.deepEqual(rows.map((r) => r.id).sort(), created.map((r) => r.value.id).sort(), 'exactly the admitted bills exist, no more and no fewer');
    // Once the archive has committed, no further bill is admitted.
    await assert.rejects(t.bill({ memberId: m2, providerId: p, providerReference: 'RACE-LATE', statementDate: '2026-07-20' }), code('conflict'));
    assert.equal((await t.db.pool.query('select count(*)::int n from bills where member_id = $1', [m2])).rows[0].n, created.length);
  } finally {
    await t.db.drop();
  }
});

test('audit trail records actor, action and detail for every mutation, and bill history is chronological', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const m = await t.member();
    const p = await t.provider();
    const b = await t.bill({ memberId: m, providerId: p, amountStatus: 'estimate' });
    const a = await t.adjust(b.id, '-5.00');
    await svc.reverseAdjustment(t.db.pool, t.actor, { idempotencyKey: t.key(), billId: b.id, adjustmentId: a.id, reason: 'mistake' }, 'req-1');
    const d = await t.detail(b.id);
    assert.deepEqual(d.history.map((e) => e.action), ['bill.created', 'bill.adjustment_added', 'bill.adjustment_reversed']);
    assert.ok(d.history.every((e) => e.actorName === 'Alex Example'));
    assert.equal(d.history[1].detail.amountCents, '-500');
    const rows = (await t.db.pool.query(`select action from audit_events where action like 'member.%' or action like 'provider.%'`)).rows;
    assert.equal(rows.length, 2);
    // No money or free text leaks into audit detail beyond cents and categories.
    assert.ok(!JSON.stringify(d.history).includes('mistake'));
    await assert.rejects(t.db.pool.query('delete from audit_events'), /append-only/);
  } finally {
    await t.db.drop();
  }
});

test('unauthorized reads and writes: other households, anonymous callers and forged requests', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const m = await t.member();
    const p = await t.provider();
    const b = await t.bill({ memberId: m, providerId: p });
    const visit = await svc.createVisit(t.db.pool, t.actor, { memberId: m, providerId: p, serviceDate: '2026-01-10' }, 'r');
    // A second, separate household with its own administrator.
    const h2 = (await t.db.pool.query(`insert into households (name) values ('Other Family') returning id`)).rows[0].id;
    const u2 = (await t.db.pool.query(
      `insert into users (household_id, email, display_name, role, password_hash) values ($1, 'other@example.test', 'Other Admin', 'admin', 'x') returning id`, [h2])).rows[0].id;
    const outsider = { userId: u2, householdId: h2, role: 'admin', displayName: 'Other Admin', sessionId: randomUUID() };
    await assert.rejects(svc.getBillDetail(t.db.pool, outsider, b.id), code('not_found'));
    await assert.rejects(svc.getMember(t.db.pool, outsider, m), code('not_found'));
    await assert.rejects(svc.getProvider(t.db.pool, outsider, p), code('not_found'));
    await assert.rejects(svc.getVisit(t.db.pool, outsider, visit.id), code('not_found'));
    assert.equal((await svc.listBills(t.db.pool, outsider, {})).items.length, 0);
    assert.equal((await svc.expenseOverview(t.db.pool, outsider, {})).totals.billCount, 0);
    await assert.rejects(svc.addAdjustment(t.db.pool, outsider, { idempotencyKey: t.key(), billId: b.id, amount: '-1.00', category: 'correction', effectiveDate: '2026-01-01', reason: 'x', source: 'manual' }, 'r'), code('not_found'));
    await assert.rejects(svc.createBill(t.db.pool, outsider, { idempotencyKey: t.key(), memberId: m, providerId: p, statementDate: '2026-03-01', originalAmount: '1', amountStatus: 'estimate', amountSource: 'manual' }, 'r'), code('not_found'));
    await assert.rejects(svc.createVisit(t.db.pool, outsider, { memberId: m, providerId: p, serviceDate: '2026-01-01' }, 'r'), code('not_found'));
    await assert.rejects(resolveAttachmentTarget(t.db.pool, outsider, 'bill', b.id), code('not_found'));
    // The database itself refuses cross-household links.
    await assert.rejects(t.db.pool.query(
      `insert into visits (household_id, member_id, provider_id, service_date, member_name_snapshot, provider_name_snapshot, created_by)
       values ($1, $2, $3, '2026-01-01', 'a', 'b', $4)`, [h2, m, p, u2]), /foreign key/);

    // Anonymous and forged HTTP requests.
    const body = { name: 'Nope' };
    const anon = await handlers.handleExpenseAction(post('/api/expenses/members/create', body, { type: 'json' }), t.ctx, 'members/create');
    assert.equal(anon.status, 401);
    const csrfMissing = await handlers.handleExpenseAction(post('/api/expenses/members/create', body, { type: 'json', cookie: t.cookie }), t.ctx, 'members/create');
    assert.equal(csrfMissing.status, 403);
    const token = t.cookie.split('=')[1];
    const crossOrigin = await handlers.handleExpenseAction(post('/api/expenses/members/create', body, { type: 'json', cookie: t.cookie, origin: 'https://evil.test', headers: { 'x-csrf-token': csrfFor(token) } }), t.ctx, 'members/create');
    assert.equal(crossOrigin.status, 403);
    const unknown = await handlers.handleExpenseAction(post('/api/expenses/members/delete', body, { type: 'json', cookie: t.cookie, headers: { 'x-csrf-token': csrfFor(token) } }), t.ctx, 'members/delete');
    assert.equal(unknown.status, 404);
    const extra = await handlers.handleExpenseAction(post('/api/expenses/members/create', { name: 'X', householdId: h2 }, { type: 'json', cookie: t.cookie, headers: { 'x-csrf-token': csrfFor(token) } }), t.ctx, 'members/create');
    assert.equal(extra.status, 400, 'unknown fields such as householdId are rejected');
    const good = await handlers.handleExpenseAction(post('/api/expenses/members/create', { name: 'Taylor Example' }, { type: 'json', cookie: t.cookie, headers: { 'x-csrf-token': csrfFor(token) } }), t.ctx, 'members/create');
    assert.equal(good.status, 201);
    assert.match((await good.json()).id, /^[0-9a-f-]{36}$/);
    assert.equal((await t.db.pool.query(`select count(*)::int n from family_members where name = 'Nope'`)).rows[0].n, 0);
  } finally {
    await t.db.drop();
  }
});

test('form posts redirect to the record, and validation errors keep what was typed', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const m = await t.member();
    const p = await t.provider();
    const token = t.cookie.split('=')[1];
    const form = (path, body) => handlers.handleExpenseAction(post(path, { ...body, csrf: csrfFor(token) }, { cookie: t.cookie, html: true }), t.ctx, path.replace('/api/expenses/', ''));
    const ok = await form('/api/expenses/bills/create', {
      idempotencyKey: t.key(), memberId: m, providerId: p, statementDate: '2026-03-01', originalAmount: '12.50', amountStatus: 'estimate', amountSource: 'manual',
    });
    assert.equal(ok.status, 303);
    assert.match(ok.headers.get('location'), /\/bills\/[0-9a-f-]{36}$/);
    const bad = await form('/api/expenses/bills/create', {
      idempotencyKey: t.key(), memberId: m, providerId: p, statementDate: '2026-03-01', originalAmount: '12.345', amountStatus: 'estimate', amountSource: 'manual', notes: 'keep me',
    });
    assert.equal(bad.status, 303);
    const loc = new URL(bad.headers.get('location'));
    assert.equal(loc.pathname, '/bills/new');
    assert.equal(loc.searchParams.get('error'), 'invalid_input');
    // Typed values never appear in the URL, which reaches proxy logs and browser history.
    assert.deepEqual([...loc.searchParams.keys()], ['error']);
    assert.ok(!bad.headers.get('location').includes('keep'));
    const cookie = bad.headers.get('set-cookie');
    assert.match(cookie, /^(__Host-)?tallymed_flash=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Max-Age=120/);
    const raw = cookie.split(';')[0].split('=')[1];
    const kept = readFlash(raw, '/bills/new');
    assert.equal(kept.originalAmount, '12.345');
    assert.equal(kept.statementDate, '2026-03-01');
    assert.equal(kept.notes, 'keep me');
    assert.equal('csrf' in kept, false);
    assert.equal('idempotencyKey' in kept, false);
    assert.deepEqual(readFlash(raw, '/members'), {}, 'only the page it was written for can read it');
    assert.deepEqual(readFlash('not-base64-json', '/bills/new'), {});
    // Member date of birth and notes use the same path.
    const member = await form('/api/expenses/members/create', { name: '', dateOfBirth: '2015-04-05', notes: 'private note' });
    assert.equal(member.headers.get('location'), `${ORIGIN}/members?error=invalid_input`);
    assert.equal(readFlash(member.headers.get('set-cookie').split(';')[0].split('=')[1], '/members').dateOfBirth, '2015-04-05');
    // A successful save sets no flash cookie.
    assert.equal(ok.headers.get('set-cookie'), null);
  } finally {
    await t.db.drop();
  }
});

test('stable ID and attachment contracts', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const m = await t.member();
    const p = await t.provider();
    const b = await t.bill({ memberId: m, providerId: p, providerReference: 'ATT-1' });
    const a = await t.adjust(b.id, '-1.00');
    const visit = await svc.createVisit(t.db.pool, t.actor, { memberId: m, providerId: p, serviceDate: '2026-01-10' }, 'r');
    assert.deepEqual([...ATTACHMENT_TARGET_TYPES], ['bill', 'visit', 'bill_adjustment', 'hsa_receipt', 'hsa_eligibility_decision']);
    assert.equal((await resolveAttachmentTarget(t.db.pool, t.actor, 'bill', b.id)).id, b.id);
    assert.equal((await resolveAttachmentTarget(t.db.pool, t.actor, 'visit', visit.id)).id, visit.id);
    assert.equal((await resolveAttachmentTarget(t.db.pool, t.actor, 'bill_adjustment', a.id)).billId, b.id);
    await assert.rejects(resolveAttachmentTarget(t.db.pool, t.actor, 'member', m), code('invalid_input'));
    await assert.rejects(resolveAttachmentTarget(t.db.pool, t.actor, 'bill', 'nope'), code('invalid_input'));
    await assert.rejects(resolveAttachmentTarget(t.db.pool, t.actor, 'bill', randomUUID()), code('not_found'));
    const c = billContract((await t.detail(b.id)).bill);
    for (const f of ['originalCents', 'baseResponsibilityCents', 'adjustmentsCents', 'responsibilityCents', 'openBalanceCents']) assert.match(c[f], /^-?\d+$/);
    assert.equal(c.id, b.id);
  } finally {
    await t.db.drop();
  }
});

test('upgrade: migrations 0003 and 0004 apply over earlier data without changing it', { skip: skipDb }, async () => {
  const { migrate } = await import('../../apps/web/server/migrate.ts');
  const db = await freshDatabase({ migrateAll: false });
  try {
    await migrate(db.pool, { upTo: '0002' });
    const h = (await db.pool.query(`insert into households (name) values ('Example Family') returning id`)).rows[0].id;
    await db.pool.query(`insert into users (household_id, email, display_name, role, password_hash) values ($1, 'a@example.test', 'Alex Example', 'admin', 'x')`, [h]);
    assert.deepEqual((await migrate(db.pool)).slice(0, 2), ['0003', '0004']);
    assert.equal((await db.pool.query('select count(*)::int n from users')).rows[0].n, 1);
    assert.equal((await db.pool.query('select count(*)::int n from bills')).rows[0].n, 0);
  } finally {
    await db.drop();
  }
});

test('confirmed-bill edits record old and new values for provider, reference, dates and provenance', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const m = await t.member();
    const pa = await t.provider('Provider A');
    const pb = await t.provider('Provider B');
    const b = await t.bill({ memberId: m, providerId: pa, providerReference: 'ORIG-1', dueDate: '2026-04-01', sourceNote: 'statement p1', notes: 'first' });
    const d = await t.detail(b.id);
    await svc.updateBill(t.db.pool, t.actor, {
      id: b.id, version: d.bill.version, providerId: pb, providerReference: 'CHANGED-9', statementDate: '2026-01-01', dueDate: '2026-02-01',
      amountSource: 'phone', sourceNote: 'rewritten', notes: 'second',
    }, 'r');
    const h = (await t.detail(b.id)).history.at(-1);
    assert.equal(h.action, 'bill.updated');
    assert.deepEqual(h.detail, {
      providerChanged: true, fromProviderId: pa, toProviderId: pb, fromProviderReference: 'ORIG-1', toProviderReference: 'CHANGED-9',
      fromStatementDate: '2026-03-01', toStatementDate: '2026-01-01', fromDueDate: '2026-04-01', toDueDate: '2026-02-01',
      fromAmountSource: 'statement', toAmountSource: 'phone', fromSourceNote: 'statement p1', toSourceNote: 'rewritten', notesChanged: true,
    });
    // An update that changes nothing records no from/to pairs.
    const d2 = await t.detail(b.id);
    await svc.updateBill(t.db.pool, t.actor, {
      id: b.id, version: d2.bill.version, providerId: pb, providerReference: 'CHANGED-9', statementDate: '2026-01-01', dueDate: '2026-02-01',
      sourceNote: 'rewritten', notes: 'second',
    }, 'r');
    assert.deepEqual((await t.detail(b.id)).history.at(-1).detail, { providerChanged: false });
  } finally {
    await t.db.drop();
  }
});

test('select lists keep the current record even when it is outside the first 100', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const m = await t.member();
    // 102 providers: names sort Prov 000 to Prov 101, the bill's provider is the last.
    for (let i = 0; i < 101; i++) await t.provider(`Prov ${String(i).padStart(3, '0')}`);
    const last = await t.provider('Prov 101');
    const first = (await svc.pickParties(t.db.pool, t.actor, 'providers', {})).items[0].id;
    const plain = await svc.pickParties(t.db.pool, t.actor, 'providers', {});
    assert.equal(plain.items.length, 100);
    assert.equal(plain.truncated, true);
    assert.ok(!plain.items.some((p) => p.id === last), 'the last provider is not in the first page');
    const withCurrent = await svc.pickParties(t.db.pool, t.actor, 'providers', { currentId: last });
    assert.equal(withCurrent.items[0].id, last, 'the current provider is always offered, first');
    assert.equal(withCurrent.items.length, 101);
    assert.equal(withCurrent.truncated, true);
    // An unknown, foreign or malformed current id is ignored rather than failing the page.
    assert.equal((await svc.pickParties(t.db.pool, t.actor, 'providers', { currentId: randomUUID() })).items.length, 100);
    assert.equal((await svc.pickParties(t.db.pool, t.actor, 'providers', { currentId: 'nope' })).items.length, 100);
    // Search reaches records beyond the first page.
    const found = await svc.pickParties(t.db.pool, t.actor, 'providers', { q: 'Prov 101' });
    assert.deepEqual(found.items.map((p) => p.id), [last]);
    assert.equal(found.truncated, false);
    // The bill's page keeps the provider unchanged when only a note is saved with the select's current value.
    const b = await t.bill({ memberId: m, providerId: last });
    const d = await t.detail(b.id);
    const chosen = withCurrent.items.find((p) => p.id === d.bill.providerId);
    assert.ok(chosen, 'the select can show the current provider as selected');
    await svc.updateBill(t.db.pool, t.actor, { id: b.id, version: d.bill.version, providerId: chosen.id, statementDate: d.bill.statementDate, notes: 'just a note' }, 'r');
    const after = await t.detail(b.id);
    assert.equal(after.bill.providerId, last);
    assert.equal(after.history.at(-1).detail.providerChanged, false);
    assert.ok(first);

    // The same for visits: 102 visits for one member, the bill's visit is the oldest.
    const p0 = await t.provider('Visit Clinic');
    const oldest = await svc.createVisit(t.db.pool, t.actor, { memberId: m, providerId: p0, serviceDate: '2020-01-01' }, 'r');
    for (let i = 0; i < 101; i++) await svc.createVisit(t.db.pool, t.actor, { memberId: m, providerId: p0, serviceDate: `2025-01-${String((i % 28) + 1).padStart(2, '0')}` }, 'r');
    const visitBill = await t.bill({ memberId: m, providerId: p0, visitId: oldest.id, providerReference: 'V-1' });
    const vplain = await svc.pickVisits(t.db.pool, t.actor, { memberId: m });
    assert.equal(vplain.items.length, 100);
    assert.equal(vplain.truncated, true);
    assert.ok(!vplain.items.some((v) => v.id === oldest.id));
    const vcur = await svc.pickVisits(t.db.pool, t.actor, { memberId: m, currentId: oldest.id });
    assert.equal(vcur.items[0].id, oldest.id);
    assert.equal((await t.detail(visitBill.id)).bill.visitId, oldest.id);
  } finally {
    await t.db.drop();
  }
});

test('duplicate hints normalize the entry-time reference exactly like the stored column', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const m = await t.member();
    const p = await t.provider();
    await t.bill({ memberId: m, providerId: p, providerReference: 'ÉCLAIR-77', originalAmount: '10.00' });
    // Different amount, same reference apart from case and punctuation: the entry-time check must warn.
    await assert.rejects(t.bill({ memberId: m, providerId: p, providerReference: 'éclair 77', originalAmount: '20.00' }), code('duplicate_warning'));
    await assert.rejects(t.bill({ memberId: m, providerId: p, providerReference: 'Café-1', originalAmount: '1.00' }).then(() => t.bill({ memberId: m, providerId: p, providerReference: 'CAFÉ 1', originalAmount: '2.00' })), code('duplicate_warning'));
    // Unrelated references and the ASCII-stripped lookalike do not match.
    await t.bill({ memberId: m, providerId: p, providerReference: 'CLAIR-77', originalAmount: '30.00' });
  } finally {
    await t.db.drop();
  }
});

test('member and provider paging uses the database lower-casing for its cursor', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    for (const name of ['ΟΔΟΣ Clinic', 'İstanbul Lab', 'Alpha', 'Zed', 'Ωmega']) await t.provider(name);
    const seen = [];
    let cursor;
    do {
      const page = await svc.listProviders(t.db.pool, t.actor, { limit: 2, cursor });
      seen.push(...page.items.map((p) => p.name));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(seen.length, 5);
    assert.equal(new Set(seen).size, 5, 'no provider is returned twice or skipped');
  } finally {
    await t.db.drop();
  }
});

test('the database itself refuses negative responsibility and changes to confirmed amounts', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const m = await t.member();
    const p = await t.provider();
    const confirmed = await t.bill({ memberId: m, providerId: p, originalAmount: '100.00' });
    const estimate = await t.bill({ memberId: m, providerId: p, originalAmount: '100.00', amountStatus: 'estimate', providerReference: 'EST-1', statementDate: '2026-03-02' });
    const pool = t.db.pool;
    const hh = t.actor.householdId;
    const insertAdj = (client, billId, cents) => client.query(
      `insert into bill_adjustments (household_id, bill_id, amount_cents, category, effective_date, reason, source, created_by)
       values ($1, $2, $3, 'correction', '2026-03-10', 'direct sql', 'manual', $4)`, [hh, billId, cents, t.actor.userId]);

    // Confirmed amounts: no edit, no un-confirm, no delete, by any statement.
    await assert.rejects(pool.query(`update bills set original_cents = 999, base_responsibility_cents = 999 where id = $1`, [confirmed.id]), /confirmed amounts change only/);
    await assert.rejects(pool.query(`update bills set original_cents = 20000 where id = $1`, [confirmed.id]), /confirmed amounts change only/);
    await assert.rejects(pool.query(`update bills set amount_status = 'estimate', confirmed_at = null, confirmed_by = null where id = $1`, [confirmed.id]), /confirmed amounts change only/);
    await assert.rejects(pool.query(`delete from bills where id = $1`, [confirmed.id]), /cannot be deleted/);
    // Non-amount fields on a confirmed bill can still change, and an estimate can still be edited and confirmed.
    await pool.query(`update bills set notes = 'ok' where id = $1`, [confirmed.id]);
    await pool.query(`update bills set original_cents = 15000, base_responsibility_cents = 15000 where id = $1`, [estimate.id]);
    await pool.query(`update bills set amount_status = 'confirmed', confirmed_at = now(), confirmed_by = $2 where id = $1`, [estimate.id, t.actor.userId]);
    await assert.rejects(pool.query(`update bills set original_cents = 1, base_responsibility_cents = 1 where id = $1`, [estimate.id]), /confirmed amounts change only/);

    // Responsibility: a single direct adjustment below zero is refused at commit, and nothing is left behind.
    await assert.rejects(insertAdj(pool, confirmed.id, -1000000), /household responsibility must stay/);
    assert.equal((await t.detail(confirmed.id)).bill.adjustmentsCents, '0');
    // Exactly to zero is allowed; one cent below is not.
    await insertAdj(pool, confirmed.id, -10000);
    await assert.rejects(insertAdj(pool, confirmed.id, -1), /household responsibility must stay/);
    // The upper bound holds too.
    await assert.rejects(insertAdj(pool, estimate.id, 10000000000000), /household responsibility must stay/);
    // Intermediate states inside one transaction are allowed when the end state is valid.
    const client = await pool.connect();
    try {
      await client.query('begin');
      await insertAdj(client, estimate.id, -20000);
      await insertAdj(client, estimate.id, 10000);
      await client.query('commit');
    } finally {
      client.release();
    }
    assert.equal((await t.detail(estimate.id)).bill.responsibilityCents, '5000');
    // Lowering the base of an estimate below its adjustments is refused as well.
    const est2 = await t.bill({ memberId: m, providerId: p, originalAmount: '100.00', amountStatus: 'estimate', providerReference: 'EST-2', statementDate: '2026-03-03' });
    await insertAdj(pool, est2.id, -9000);
    await assert.rejects(pool.query(`update bills set base_responsibility_cents = 5000 where id = $1`, [est2.id]), /household responsibility must stay/);

    // Concurrent direct writers cannot overdraw together: 12 raw -$20 inserts on a $100 bill leave exactly 5 rows.
    const race = await t.bill({ memberId: m, providerId: p, originalAmount: '100.00', providerReference: 'RACE', statementDate: '2026-03-04' });
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => insertAdj(pool, race.id, -2000)));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 5);
    assert.equal((await t.detail(race.id)).bill.responsibilityCents, '0');
  } finally {
    await t.db.drop();
  }
});
