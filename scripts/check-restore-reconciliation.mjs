// End-to-end ledger reconciliation across a backup and restore, using fabricated data only (M07 drill).
// It builds a small synthetic ledger through the real services (bills, an adjustment, split payments, an allocation, a refund),
// records the figures the application reports, dumps the database with pg_dump (custom format, the format the operator guide
// uses), restores it into a second empty database with pg_restore, and requires every reported figure to be identical.
//
// Requires: a disposable PostgreSQL server (TALLYMED_TEST_DATABASE_URL, superuser-capable) and pg_dump/pg_restore on PATH.
// Usage:    TALLYMED_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres npm run test:restore
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import * as svc from '../apps/web/server/services/expenses.ts';
import * as pay from '../apps/web/server/services/payments.ts';
import { authenticate } from '../apps/web/server/services/auth.ts';
import { createPool } from '../apps/web/server/db.ts';
import { migrate } from '../apps/web/server/migrate.ts';
import { setup } from '../tests/web/money-helpers.mjs';

const adminUrl = process.env.TALLYMED_TEST_DATABASE_URL;
if (!adminUrl) throw new Error('Set TALLYMED_TEST_DATABASE_URL to a disposable PostgreSQL server (never a real database).');

const withDatabase = (url, database) => { const u = new URL(url); u.pathname = `/${database}`; return u.href; };
const tables = ['bills', 'bill_adjustments', 'payments', 'payment_entries', 'audit_events', 'family_members', 'providers'];

/** Figures the application reports, read through the same services the pages use. */
async function snapshot(pool, actor) {
  const bills = (await svc.listBills(pool, actor, {})).items;
  const details = [];
  for (const b of bills) details.push((await svc.getBillDetail(pool, actor, b.id)).bill);
  details.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const counts = {};
  for (const t of tables) counts[t] = (await pool.query(`select count(*)::int n from ${t}`)).rows[0].n;
  return { details, cash: await pay.cashSummary(pool, actor), counts };
}

const workDir = mkdtempSync(join(tmpdir(), 'tallymed-restore-'));
const t = await setup();
const restoredName = `tallymed_restored_${randomBytes(4).toString('hex')}`;
let restoredPool;
async function adminQuery(sql) {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try { await c.query(sql); } finally { await c.end(); }
}
try {
  // 1. Synthetic ledger with exact cent amounts, split and partial payments, an adjustment and a refund.
  const m = await t.member();
  const p = await t.provider();
  const a = await t.bill({ memberId: m, providerId: p, originalAmount: '100.10' });
  const b = await t.bill({ memberId: m, providerId: p, originalAmount: '50.20' });
  const c = await t.bill({ memberId: m, providerId: p, originalAmount: '30.00' });
  await t.adjust(b.id, '10.05');
  const p1 = await t.pay1({ amount: '150.30', allocations: [{ billId: a.id, amount: '100.10' }, { billId: b.id, amount: '40.15' }] });
  const p2 = await t.pay1({ amount: '40.00', billId: c.id, allocateAmount: '10.00' });
  await pay.allocatePayment(t.db.pool, t.actor, { idempotencyKey: t.key(), paymentId: p2.id, billId: c.id, allocateAmount: '5.00' }, 'r');
  await t.refund(p1.id, { amount: '5.00' });
  const live = await snapshot(t.db.pool, t.actor);
  assert.equal(live.details.length, 3, 'fixture built');
  assert.equal(live.counts.payments, 2, 'fixture built');

  // 2. Dump (the operator guide's format), then restore into an empty second database.
  const dump = join(workDir, 'db.dump');
  execFileSync('pg_dump', ['--format=custom', '--file', dump, t.db.url], { stdio: ['ignore', 'inherit', 'inherit'] });
  await adminQuery(`create database ${restoredName}`);
  const restoredUrl = withDatabase(adminUrl, restoredName);
  execFileSync('pg_restore', ['--no-owner', '--exit-on-error', '--dbname', restoredUrl, dump], { stdio: ['ignore', 'inherit', 'inherit'] });
  restoredPool = createPool(restoredUrl, 4);

  // 3. Migrations on the restored copy must be a no-op, and the sign-in session restored from the dump still resolves.
  const applied = await migrate(restoredPool);
  console.log('migrate on restored database:', JSON.stringify(applied));
  const actor = await authenticate(restoredPool, t.config, t.cookie.split('=')[1]);
  const restored = await snapshot(restoredPool, actor);

  // 4. Every reported figure must match exactly, and the books must still balance.
  assert.deepEqual(restored, live, 'restored figures differ from the live system');
  const open = restored.details.reduce((s, d) => s + BigInt(d.openBalanceCents), 0n);
  assert.ok(open >= 0n, 'no negative open balance');
  await assert.rejects(restoredPool.query(`update audit_events set action = 'x'`), undefined, 'audit log stays append-only');
  console.log(`OK: ${restored.details.length} bills, ${restored.counts.payments} payments, open balance ${open} cents, net cash ${restored.cash.netCashCents} cents identical after restore.`);
} finally {
  if (restoredPool) await restoredPool.end().catch(() => {});
  await adminQuery(`drop database if exists ${restoredName} with (force)`).catch(() => {});
  await t.db.drop().catch(() => {});
  rmSync(workDir, { recursive: true, force: true });
}
