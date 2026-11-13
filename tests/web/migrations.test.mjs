import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { listMigrations, migrate } from '../../apps/web/server/migrate.ts';
import { freshDatabase, skipDb } from './helpers.mjs';

const tables = async (pool) =>
  (await pool.query(`select table_name from information_schema.tables where table_schema = 'public' order by 1`)).rows.map((r) => r.table_name);

test('migration files are ordered, unique and named', () => {
  const versions = listMigrations().map((m) => m.version);
  assert.deepEqual(versions, [...versions].sort());
  assert.equal(new Set(versions).size, versions.length);
  assert.ok(versions.length >= 2);
});

test('fresh migration creates the schema and is idempotent', { skip: skipDb }, async () => {
  const db = await freshDatabase({ migrateAll: false });
  try {
    const applied = await migrate(db.pool);
    assert.deepEqual(applied, listMigrations().map((m) => m.version));
    for (const t of ['households', 'users', 'sessions', 'audit_events', 'bootstrap_state', 'invitations', 'login_attempts', 'schema_migrations', 'family_members', 'providers', 'visits', 'bills', 'bill_adjustments', 'idempotency_records', 'payments', 'payment_entries', 'payment_voids', 'payment_plans', 'plan_revisions', 'plan_installments', 'installment_matches', 'hsa_eligibility_decisions', 'hsa_claims', 'hsa_receipts', 'hsa_entries']) {
      assert.ok((await tables(db.pool)).includes(t), t);
    }
    assert.deepEqual(await migrate(db.pool), []);
  } finally {
    await db.drop();
  }
});

test('upgrade from the prior schema preserves existing synthetic data', { skip: skipDb }, async () => {
  const db = await freshDatabase({ migrateAll: false });
  try {
    await migrate(db.pool, { upTo: '0001' });
    assert.ok(!(await tables(db.pool)).includes('invitations'));
    const h = (await db.pool.query(`insert into households (name) values ('Example Family') returning id`)).rows[0].id;
    const u = (await db.pool.query(
      `insert into users (household_id, email, display_name, role, password_hash) values ($1, 'a@example.test', 'Alex Example', 'admin', 'x') returning id`, [h])).rows[0].id;
    await db.pool.query(`insert into audit_events (household_id, actor_user_id, action, entity_type) values ($1, $2, 'seed', 'user')`, [h, u]);
    const applied = await migrate(db.pool);
    assert.ok(applied.length >= 1 && !applied.includes('0001'));
    assert.ok((await tables(db.pool)).includes('invitations'));
    assert.equal((await db.pool.query('select count(*)::int n from users')).rows[0].n, 1);
    assert.equal((await db.pool.query('select count(*)::int n from audit_events')).rows[0].n, 1);
    // The upgraded schema enforces its new constraints on old rows' household.
    await db.pool.query(
      `insert into invitations (household_id, email, role, token_hash, invited_by, expires_at)
       values ($1, 'b@example.test', 'operator', decode(repeat('ab', 32), 'hex'), $2, now() + interval '1 day')`, [h, u]);
    await assert.rejects(db.pool.query(
      `insert into invitations (household_id, email, role, token_hash, invited_by, expires_at)
       values ($1, 'B@example.test', 'operator', decode(repeat('cd', 32), 'hex'), $2, now() + interval '1 day')`, [h, u]), /invitations_open_email_key/);
  } finally {
    await db.drop();
  }
});

test('an edited, already-applied migration is rejected', { skip: skipDb }, async () => {
  const db = await freshDatabase({ migrateAll: false });
  const dir = mkdtempSync(path.join(tmpdir(), 'tallymed-mig-'));
  try {
    cpSync(path.resolve('apps/web/db/migrations'), dir, { recursive: true });
    await migrate(db.pool, { dir });
    appendFileSync(path.join(dir, '0001_core.sql'), '\n-- tampered\n');
    await assert.rejects(migrate(db.pool, { dir }), /changed after it was applied/);
  } finally {
    await db.drop();
  }
});

test('a failing migration rolls back completely', { skip: skipDb }, async () => {
  const db = await freshDatabase({ migrateAll: false });
  const dir = mkdtempSync(path.join(tmpdir(), 'tallymed-mig-'));
  try {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path.join(dir, '0001_bad.sql'), 'create table t1 (id int); select * from does_not_exist;');
    await assert.rejects(migrate(db.pool, { dir }));
    assert.ok(!(await tables(db.pool)).includes('t1'));
    assert.equal((await db.pool.query('select count(*)::int n from schema_migrations')).rows[0].n, 0);
  } finally {
    await db.drop();
  }
});

test('audit events are append-only and bootstrap state is a singleton', { skip: skipDb }, async () => {
  const db = await freshDatabase();
  try {
    const { seedHousehold } = await import('./helpers.mjs');
    const { householdId, adminUserId } = await seedHousehold(db.pool);
    await assert.rejects(db.pool.query(`update audit_events set action = 'x'`), /append-only/);
    await assert.rejects(db.pool.query(`delete from audit_events`), /append-only/);
    await assert.rejects(db.pool.query(`truncate audit_events`), /append-only/);
    await assert.rejects(db.pool.query(`insert into bootstrap_state (household_id, admin_user_id) values ($1, $2)`, [householdId, adminUserId]), /duplicate key/);
  } finally {
    await db.drop();
  }
});
