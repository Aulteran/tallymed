// Shared fixture for the payments and plans tests. All data is fabricated.
import { randomUUID } from 'node:crypto';
import * as handlers from '../../apps/web/server/http.ts';
import * as svc from '../../apps/web/server/services/expenses.ts';
import * as pay from '../../apps/web/server/services/payments.ts';
import { authenticate } from '../../apps/web/server/services/auth.ts';
import { freshDatabase, loginJson, seedHousehold, testConfig } from './helpers.mjs';

export async function setup() {
  const db = await freshDatabase();
  const config = testConfig({}, db.url);
  const ctx = { config, pool: db.pool };
  await seedHousehold(db.pool);
  const { cookie } = await loginJson(handlers, ctx, 'admin@example.test');
  const actor = await authenticate(db.pool, config, cookie.split('=')[1]);
  const key = () => randomUUID();
  const member = (name = 'Pat Example') => svc.createMember(db.pool, actor, { name }, 'r').then((r) => r.id);
  const provider = (name = 'Example Clinic') => svc.createProvider(db.pool, actor, { name, kind: 'clinician' }, 'r').then((r) => r.id);
  let n = 0;
  const bill = (o) => svc.createBill(db.pool, actor, {
    idempotencyKey: key(), statementDate: new Date(Date.UTC(2026, 0, 1 + ++n)).toISOString().slice(0, 10), originalAmount: '100.00', amountStatus: 'confirmed', amountSource: 'statement', providerReference: `B-${n}`, ...o,
  }, 'r');
  const adjust = (billId, amount) => svc.addAdjustment(db.pool, actor, {
    idempotencyKey: key(), billId, amount, category: 'insurer_adjustment', effectiveDate: '2026-03-10', reason: 'EOB', source: 'eob',
  }, 'r');
  const pay1 = (o) => pay.recordPayment(db.pool, actor, { idempotencyKey: key(), paidOn: '2026-04-01', amount: '100.00', method: 'card', ...o }, 'r');
  const detail = (id) => svc.getBillDetail(db.pool, actor, id).then((d) => d.bill);
  const payment = (id) => pay.getPaymentDetail(db.pool, actor, id);
  const refund = (paymentId, o) => pay.recordRefund(db.pool, actor, { idempotencyKey: key(), paymentId, effectiveDate: '2026-05-01', reason: 'Provider refund', ...o }, 'r');
  const count = async (table) => (await db.pool.query(`select count(*)::int n from ${table}`)).rows[0].n;
  const audit = async (action) => (await db.pool.query(`select detail, entity_type, entity_id from audit_events where action = $1 order by id`, [action])).rows;
  return { db, ctx, config, actor, cookie, key, member, provider, bill, adjust, pay1, detail, payment, refund, count, audit };
}
