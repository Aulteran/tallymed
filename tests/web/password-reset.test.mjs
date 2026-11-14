import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as handlers from '../../apps/web/server/http.ts';
import { setLogSink } from '../../apps/web/server/log.ts';
import { hashPassword } from '../../apps/web/server/passwords.ts';
import { insertUser } from '../../apps/web/server/repositories/users.ts';
import { authenticate } from '../../apps/web/server/services/auth.ts';
import { generateTemporaryPassword, issueTemporaryCredential, resetOperatorPassword } from '../../apps/web/server/services/credentials.ts';
import {
  freshDatabase, loginJson, PASSWORD, post, seedHousehold, skipDb, testConfig,
} from './helpers.mjs';

const OP_PASSWORD = 'operator pass phrase 2026';
const NEW_PASSWORD = 'a brand new passphrase 7';
const code = async (res) => (await res.clone().json()).error?.code;

async function setup(overrides = {}) {
  const db = await freshDatabase();
  const config = testConfig(overrides, db.url);
  const ctx = { config, pool: db.pool };
  const ids = await seedHousehold(db.pool);
  const add = async (email, role = 'operator', password = OP_PASSWORD) =>
    insertUser(db.pool, { householdId: ids.householdId, email, displayName: email.split('@')[0], role, passwordHash: await hashPassword(password) });
  const login = (email, password) => loginJson(handlers, ctx, email, password);
  const admin = await login('admin@example.test', PASSWORD);
  const api = (fn, path, body, who, extra = {}) => fn(post(path, body, { type: 'json', cookie: who.cookie, headers: { 'x-csrf-token': who.csrf }, ...extra }), ctx);
  const userId = async (email) => (await db.pool.query('select id from users where email = $1', [email])).rows[0].id;
  const version = async (email) => (await db.pool.query('select version from users where email = $1', [email])).rows[0].version;
  const reset = async (who, email, extra = {}) =>
    api(handlers.handleResetPassword, '/api/operators/reset-password', { userId: await userId(email), version: await version(email), ...extra }, who);
  return { db, ctx, config, ...ids, add, login, admin, api, userId, version, reset };
}

/** Collects everything the server logs while `fn` runs. */
async function capturingLogs(fn) {
  const lines = [];
  setLogSink((line) => lines.push(line));
  try {
    return { result: await fn(), lines };
  } finally {
    setLogSink((line) => process.stderr.write(line + '\n'));
  }
}

test('temporary passwords are random, well formed and meet the password policy', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const p = generateTemporaryPassword();
    assert.match(p, /^[A-HJKMNP-Z2-9]{5}(-[A-HJKMNP-Z2-9]{5}){3}$/);
    assert.ok(p.length >= 12 && p.length <= 128);
    seen.add(p);
  }
  assert.equal(seen.size, 500);
});

test('admin reset: secret shown once, hashed at rest, never logged or audited; old password and sessions die', { skip: skipDb }, async () => {
  const { db, ctx, admin, add, login, reset } = await setup();
  try {
    await add('sam@example.test');
    const sam = await login('sam@example.test', OP_PASSWORD);
    assert.equal((await authenticate(db.pool, ctx.config, sam.cookie.split('=')[1]))?.mustChangePassword, false);
    const { result: res, lines } = await capturingLogs(() => reset(admin, 'sam@example.test'));
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const { temporaryPassword, expiresAt } = await res.json();
    assert.match(temporaryPassword, /^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/);
    assert.ok(new Date(expiresAt) > new Date());
    // Never stored in the clear: the users row holds an Argon2id hash, the reset row holds no secret column at all.
    const row = (await db.pool.query(`select password_hash, must_change_password from users where email = 'sam@example.test'`)).rows[0];
    assert.match(row.password_hash, /^\$argon2id\$/);
    assert.equal(row.must_change_password, true);
    const cols = (await db.pool.query(`select column_name from information_schema.columns where table_name = 'password_resets'`)).rows.map((r) => r.column_name);
    assert.ok(!cols.some((c) => /pass|secret|hash|token/.test(c)), cols.join());
    // Nothing the server wrote, in any table or log, contains the secret.
    const dump = JSON.stringify([
      (await db.pool.query('select * from audit_events')).rows, (await db.pool.query('select * from password_resets')).rows,
      (await db.pool.query('select * from login_attempts')).rows, (await db.pool.query('select * from sessions')).rows, lines,
    ]);
    assert.ok(!dump.includes(temporaryPassword));
    assert.ok(!dump.includes(OP_PASSWORD));
    const audit = (await db.pool.query(`select * from audit_events where action = 'auth.password_reset_issued'`)).rows;
    assert.equal(audit.length, 1);
    assert.deepEqual(Object.keys(audit[0].detail).sort(), ['expiresAt', 'kind', 'sessionsRevoked']);
    assert.equal(audit[0].detail.sessionsRevoked, 1);
    // The old password and the old session stop working at once.
    assert.equal((await login('sam@example.test', OP_PASSWORD)).res.status, 401);
    assert.equal(await authenticate(db.pool, ctx.config, sam.cookie.split('=')[1]), null);
    // The HTML result page is never cached and does not leak a referrer.
    const html = await handlers.handleResetPassword(post('/api/operators/reset-password', { userId: await db.pool.query(`select id from users where email='sam@example.test'`).then((r) => r.rows[0].id), version: (await db.pool.query(`select version from users where email='sam@example.test'`)).rows[0].version }, { cookie: admin.cookie, html: true, headers: { 'x-csrf-token': admin.csrf } }), ctx);
    assert.equal(html.status, 201);
    assert.equal(html.headers.get('cache-control'), 'no-store');
    assert.equal(html.headers.get('referrer-policy'), 'no-referrer');
    assert.match(await html.text(), /<code>[A-Z2-9-]{23}<\/code>/);
  } finally {
    await db.drop();
  }
});

test('temporary sign-in opens a restricted session; changing the password ends the restriction and revokes everything else', { skip: skipDb }, async () => {
  const { db, ctx, admin, add, login, reset, api } = await setup();
  try {
    await add('sam@example.test');
    const { temporaryPassword } = await (await reset(admin, 'sam@example.test')).json();
    const t = await login('sam@example.test', temporaryPassword);
    assert.equal(t.res.status, 200);
    assert.equal(t.data.passwordChangeRequired, true);
    const maxAge = Number(/Max-Age=(\d+)/.exec(t.res.headers.get('set-cookie'))[1]);
    assert.ok(maxAge <= ctx.config.passwordChangeSessionSeconds, `restricted cookie lives ${maxAge}s`);
    const html = await handlers.handleLogin(post('/api/auth/login', { email: 'sam@example.test', password: temporaryPassword }, { html: true }), ctx);
    assert.equal(html.status, 303, 'second use of the same temporary password is refused');
    assert.equal(new URL(html.headers.get('location')).searchParams.get('error'), 'temporary_password_expired');
    assert.equal((await login('sam@example.test', temporaryPassword)).data.error.code, 'temporary_password_expired');
    // Validation: mismatch, short, same as the temporary password.
    const change = (body) => api(handlers.handleChangePassword, '/api/auth/change-password', body, t);
    assert.equal(await code(await change({ newPassword: NEW_PASSWORD, confirmPassword: 'something else entirely' })), 'invalid_input');
    assert.equal(await code(await change({ newPassword: 'short', confirmPassword: 'short' })), 'invalid_input');
    assert.equal(await code(await change({ newPassword: temporaryPassword, confirmPassword: temporaryPassword })), 'invalid_input');
    assert.equal((await db.pool.query(`select must_change_password from users where email='sam@example.test'`)).rows[0].must_change_password, true);
    const ok = await change({ newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
    assert.equal(ok.status, 200);
    const fresh = { cookie: ok.headers.get('set-cookie').split(';')[0], csrf: (await ok.json()).csrfToken };
    assert.notEqual(fresh.cookie, t.cookie);
    assert.equal(await authenticate(db.pool, ctx.config, t.cookie.split('=')[1]), null, 'the restricted session is replaced');
    assert.equal((await authenticate(db.pool, ctx.config, fresh.cookie.split('=')[1]))?.mustChangePassword, false);
    // The temporary password is dead; the new one works and is a normal session.
    assert.equal((await login('sam@example.test', temporaryPassword)).res.status, 401);
    const again = await login('sam@example.test', NEW_PASSWORD);
    assert.equal(again.res.status, 200);
    assert.equal(again.data.passwordChangeRequired, undefined);
    const state = (await db.pool.query(`select status, used_at is not null as used, completed_at is not null as done from password_resets`)).rows;
    assert.deepEqual(state, [{ status: 'completed', used: true, done: true }]);
    const actions = (await db.pool.query(`select action, detail from audit_events where action like 'auth.%' order by id`)).rows;
    assert.ok(actions.some((a) => a.action === 'auth.temporary_password_used'));
    const changed = actions.find((a) => a.action === 'auth.password_changed');
    assert.equal(changed.detail.forced, true);
    const dump = JSON.stringify(actions);
    for (const secret of [temporaryPassword, NEW_PASSWORD, 'argon2']) assert.ok(!dump.includes(secret));
  } finally {
    await db.drop();
  }
});

test('a temporary password is single use, even when two sign-ins race', { skip: skipDb }, async () => {
  const { db, admin, add, login, reset } = await setup();
  try {
    await add('sam@example.test');
    const { temporaryPassword } = await (await reset(admin, 'sam@example.test')).json();
    const results = await Promise.all([1, 2, 3, 4].map(() => login('sam@example.test', temporaryPassword)));
    assert.equal(results.filter((r) => r.res.status === 200).length, 1);
    for (const r of results.filter((r) => r.res.status !== 200)) assert.equal(r.data.error.code, 'temporary_password_expired');
    assert.equal((await db.pool.query(`select count(*)::int n from sessions where revoked_at is null and user_id = (select id from users where email='sam@example.test')`)).rows[0].n, 1);
  } finally {
    await db.drop();
  }
});

test('a temporary password expires, and the error does not reveal anything to someone without the right password', { skip: skipDb }, async () => {
  const { db, admin, add, login, reset } = await setup();
  try {
    await add('sam@example.test');
    const { temporaryPassword } = await (await reset(admin, 'sam@example.test')).json();
    await db.pool.query(`update password_resets set created_at = now() - interval '2 hours', expires_at = now() - interval '1 minute'`);
    const late = await login('sam@example.test', temporaryPassword);
    assert.equal(late.res.status, 401);
    assert.equal(late.data.error.code, 'temporary_password_expired');
    const wrong = await login('sam@example.test', 'not the temporary password');
    const unknown = await login('nobody@example.test', 'not the temporary password');
    assert.equal(wrong.res.status, 401);
    assert.deepEqual(wrong.data, unknown.data, 'a wrong password and an unknown account look identical');
    // The administrator list marks it expired, and a new reset recovers the account.
    const again = await (await reset(admin, 'sam@example.test')).json();
    assert.equal((await login('sam@example.test', again.temporaryPassword)).res.status, 200);
    assert.deepEqual((await db.pool.query(`select status from password_resets order by created_at`)).rows.map((r) => r.status), ['superseded', 'used']);
  } finally {
    await db.drop();
  }
});

test('the restricted session itself is short-lived', { skip: skipDb }, async () => {
  const { db, ctx, admin, add, login, reset } = await setup();
  try {
    await add('sam@example.test');
    const { temporaryPassword } = await (await reset(admin, 'sam@example.test')).json();
    const t = await login('sam@example.test', temporaryPassword);
    const token = t.cookie.split('=')[1];
    const secs = (await db.pool.query(`select extract(epoch from expires_at - created_at) s from sessions where user_id = (select id from users where email='sam@example.test') and revoked_at is null`)).rows[0].s;
    assert.ok(secs <= ctx.config.passwordChangeSessionSeconds + 1);
    await db.pool.query(`update sessions set expires_at = now() - interval '1 second' where revoked_at is null and user_id = (select id from users where email='sam@example.test')`);
    assert.equal(await authenticate(db.pool, ctx.config, token), null);
  } finally {
    await db.drop();
  }
});

test('a later reset supersedes the earlier temporary password; concurrent double submit issues exactly one', { skip: skipDb }, async () => {
  const { db, admin, add, login, reset, api, userId, version } = await setup();
  try {
    await add('sam@example.test');
    const first = await (await reset(admin, 'sam@example.test')).json();
    const second = await (await reset(admin, 'sam@example.test')).json();
    assert.equal((await login('sam@example.test', first.temporaryPassword)).res.status, 401);
    assert.equal((await login('sam@example.test', second.temporaryPassword)).res.status, 200);
    // Same form (same version) submitted twice at once: one wins, the other is a stale-version conflict.
    await add('pat@example.test');
    const body = { userId: await userId('pat@example.test'), version: await version('pat@example.test') };
    const both = await Promise.all([1, 2, 3].map(() => api(handlers.handleResetPassword, '/api/operators/reset-password', body, admin)));
    const statuses = both.map((r) => r.status).sort();
    assert.deepEqual(statuses, [201, 409, 409]);
    assert.equal((await db.pool.query(`select count(*)::int n from password_resets where status = 'open' and user_id = $1`, [body.userId])).rows[0].n, 1);
  } finally {
    await db.drop();
  }
});

test('reset rules: self, disabled accounts, non-admins, other households, stale versions', { skip: skipDb }, async () => {
  const { db, ctx, admin, add, login, reset, api, userId, version } = await setup();
  try {
    await add('sam@example.test');
    await add('off@example.test');
    await db.pool.query(`update users set status = 'disabled' where email = 'off@example.test'`);
    assert.equal(await code(await reset(admin, 'admin@example.test')), 'self_reset_blocked');
    assert.equal(await code(await reset(admin, 'off@example.test')), 'reset_not_allowed');
    assert.equal(await code(await reset(admin, 'sam@example.test', { version: 99 })), 'stale_version');
    assert.equal(await code(await api(handlers.handleResetPassword, '/api/operators/reset-password', { userId: '11111111-1111-4111-8111-111111111111', version: 1 }, admin)), 'not_found');
    const sam = await login('sam@example.test', OP_PASSWORD);
    assert.equal(await code(await api(handlers.handleResetPassword, '/api/operators/reset-password', { userId: await userId('admin@example.test'), version: await version('admin@example.test') }, sam)), 'forbidden');
    // Another household's account looks exactly like a missing one.
    const h2 = (await db.pool.query(`insert into households (name) values ('Other Family') returning id`)).rows[0].id;
    const other = await insertUser(db.pool, { householdId: h2, email: 'x@other.test', displayName: 'X', role: 'operator', passwordHash: await hashPassword(OP_PASSWORD) });
    assert.equal(await code(await api(handlers.handleResetPassword, '/api/operators/reset-password', { userId: other, version: 1 }, admin)), 'not_found');
    assert.equal((await login('x@other.test', OP_PASSWORD)).res.status, 200);
    // Extra or malformed fields are rejected, and a missing CSRF token is refused.
    assert.equal(await code(await reset(admin, 'sam@example.test', { password: 'chosen' })), 'invalid_input');
    assert.equal((await handlers.handleResetPassword(post('/api/operators/reset-password', { userId: await userId('sam@example.test'), version: 1 }, { type: 'json', cookie: admin.cookie }), ctx)).status, 403);
    assert.equal((await db.pool.query(`select count(*)::int n from password_resets`)).rows[0].n, 0, 'none of the refused requests issued a credential');
  } finally {
    await db.drop();
  }
});

test('two administrators resetting each other cannot lock the household out; a stale actor is refused', { skip: skipDb }, async () => {
  const { db, ctx, admin, add, login, reset, api, userId, version } = await setup();
  try {
    await add('boss@example.test', 'admin');
    const boss = await login('boss@example.test', OP_PASSWORD);
    const both = await Promise.all([
      reset(admin, 'boss@example.test'),
      api(handlers.handleResetPassword, '/api/operators/reset-password', { userId: await userId('admin@example.test'), version: await version('admin@example.test') }, boss),
    ]);
    assert.deepEqual(both.map((r) => r.status).sort(), [201, 401], 'the second reset sees its own session already revoked');
    const usable = (await db.pool.query(`select count(*)::int n from users where role = 'admin' and status = 'active' and not must_change_password`)).rows[0].n;
    assert.ok(usable >= 1);
    // The service itself refuses an actor whose privileges changed after the request was authenticated.
    await add('late@example.test', 'admin');
    const lateSession = await login('late@example.test', OP_PASSWORD);
    const actor = await authenticate(db.pool, ctx.config, lateSession.cookie.split('=')[1]);
    await db.pool.query(`update users set role = 'operator' where email = 'late@example.test'`);
    await assert.rejects(resetOperatorPassword(db.pool, ctx.config, actor, { userId: await userId('admin@example.test'), version: await version('admin@example.test') }, 'r'), { code: 'unauthenticated' });
  } finally {
    await db.drop();
  }
});

test('lockout applies to temporary passwords and an administrator reset clears it', { skip: skipDb }, async () => {
  const { db, admin, add, login, reset } = await setup();
  try {
    await add('sam@example.test');
    const { temporaryPassword } = await (await reset(admin, 'sam@example.test')).json();
    for (let i = 0; i < 5; i++) assert.equal((await login('sam@example.test', `wrong guess number ${i}`)).res.status, 401);
    const locked = await login('sam@example.test', temporaryPassword);
    assert.equal(locked.res.status, 429, 'even the right temporary password is refused while locked');
    const fresh = await (await reset(admin, 'sam@example.test')).json();
    assert.equal((await login('sam@example.test', fresh.temporaryPassword)).res.status, 200);
  } finally {
    await db.drop();
  }
});

// ---- the gate ----

const routeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../apps/web/app/api');
function routeFiles(dir = routeDir, base = '') {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? routeFiles(full, `${base}/${name}`) : name === 'route.ts' ? [base] : [];
  });
}

// Every API route and what the password-change gate does to it. A new route fails the inventory test until it is classified here.
const CLASSIFIED = {
  '/auth/login': 'public', '/invitations/accept': 'public', '/setup': 'public',
  '/auth/logout': 'allowed', '/auth/change-password': 'allowed',
  '/operators/invite': 'gated', '/operators/update': 'gated', '/operators/reset-password': 'gated', '/operators/invitations/revoke': 'gated',
  '/expenses/[...action]': 'gated', '/documents/[...action]': 'gated', '/assistant/[...action]': 'gated',
  '/documents/download/[id]': 'gated-get', '/hsa/export': 'gated-get',
};

test('every API route is classified for the password-change gate', () => {
  assert.deepEqual(routeFiles().sort(), Object.keys(CLASSIFIED).sort());
  const inv = handlers.actionInventory();
  assert.ok(inv.expenses.length > 20 && inv.documents.length > 3 && inv.assistant.length > 2, 'catch-all actions are enumerated');
});

test('an account with a temporary password reaches nothing but change-password and sign-out', { skip: skipDb }, async () => {
  const { db, ctx, admin, add, login, reset, api } = await setup();
  try {
    await add('sam@example.test');
    const { temporaryPassword } = await (await reset(admin, 'sam@example.test')).json();
    const sam = await login('sam@example.test', temporaryPassword);
    assert.equal(sam.data.passwordChangeRequired, true);
    const gated = async (res) => { assert.equal(res.status, 403); assert.equal(await code(res), 'password_change_required'); };
    const inv = handlers.actionInventory();
    const run = (fn, p) => api(fn, p, {}, sam);
    for (const a of inv.expenses) await gated(await handlers.handleExpenseAction(post(`/api/expenses/${a}`, {}, { type: 'json', cookie: sam.cookie, headers: { 'x-csrf-token': sam.csrf } }), ctx, a));
    for (const a of inv.documents) await gated(await handlers.handleDocumentAction(post(`/api/documents/${a}`, {}, { type: 'json', cookie: sam.cookie, headers: { 'x-csrf-token': sam.csrf } }), ctx, a));
    for (const a of inv.assistant) await gated(await handlers.handleAssistantAction(post(`/api/assistant/${a}`, {}, { type: 'json', cookie: sam.cookie, headers: { 'x-csrf-token': sam.csrf } }), ctx, a));
    await gated(await run(handlers.handleInvite, '/api/operators/invite'));
    await gated(await run(handlers.handleUpdateOperator, '/api/operators/update'));
    await gated(await run(handlers.handleResetPassword, '/api/operators/reset-password'));
    await gated(await run(handlers.handleRevokeInvitation, '/api/operators/invitations/revoke'));
    const get = (p) => new Request(`http://app.internal:3000${p}`, { headers: { cookie: sam.cookie } });
    await gated(await handlers.handleHsaExport(get('/api/hsa/export'), ctx));
    await gated(await handlers.handleDocumentDownload(get('/api/documents/download/11111111-1111-4111-8111-111111111111'), ctx, '11111111-1111-4111-8111-111111111111'));
    // A browser form post is sent to the change-password page instead of an error page.
    const html = await handlers.handleExpenseAction(post('/api/expenses/members/create', { name: 'X' }, { cookie: sam.cookie, html: true, headers: { 'x-csrf-token': sam.csrf } }), ctx, 'members/create');
    assert.equal(html.status, 303);
    assert.equal(new URL(html.headers.get('location')).pathname, '/password/change');
    // Sign-out is allowed for a restricted session.
    assert.equal((await api(handlers.handleLogout, '/api/auth/logout', {}, sam)).status, 200);
    assert.equal((await db.pool.query(`select count(*)::int n from households`)).rows[0].n, 1);
  } finally {
    await db.drop();
  }
});

test('a signed-in account that never had a temporary password is not gated', { skip: skipDb }, async () => {
  const { db, ctx, admin } = await setup();
  try {
    const res = await handlers.handleExpenseAction(post('/api/expenses/members/create', { name: 'Pat Example' }, { type: 'json', cookie: admin.cookie, headers: { 'x-csrf-token': admin.csrf } }), ctx, 'members/create');
    assert.ok(res.status < 300, `status ${res.status}`);
  } finally {
    await db.drop();
  }
});

// ---- normal change-password ----

test('change password needs the current password, is throttled, revokes other sessions and keeps this device signed in', { skip: skipDb }, async () => {
  const { db, ctx, add, login, api } = await setup();
  try {
    await add('sam@example.test');
    const a = await login('sam@example.test', OP_PASSWORD);
    const b = await login('sam@example.test', OP_PASSWORD);
    const change = (body, who = a) => api(handlers.handleChangePassword, '/api/auth/change-password', body, who);
    assert.equal(await code(await change({ newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD })), 'invalid_input', 'current password is required');
    assert.equal(await code(await change({ currentPassword: OP_PASSWORD, newPassword: OP_PASSWORD, confirmPassword: OP_PASSWORD })), 'invalid_input', 'must differ');
    assert.equal(await code(await change({ currentPassword: OP_PASSWORD, newPassword: 'short', confirmPassword: 'short' })), 'invalid_input');
    assert.equal(await code(await change({ currentPassword: 'wrong current password', newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD })), 'invalid_input');
    const ok = await change({ currentPassword: OP_PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.sessionsRevoked, 2);
    assert.equal(await authenticate(db.pool, ctx.config, a.cookie.split('=')[1]), null);
    assert.equal(await authenticate(db.pool, ctx.config, b.cookie.split('=')[1]), null);
    const fresh = ok.headers.get('set-cookie').split(';')[0];
    assert.ok(await authenticate(db.pool, ctx.config, fresh.split('=')[1]));
    assert.equal((await login('sam@example.test', OP_PASSWORD)).res.status, 401);
    assert.equal((await login('sam@example.test', NEW_PASSWORD)).res.status, 200);
    // Wrong-current guesses are throttled per account even with a valid session.
    const c = await login('sam@example.test', NEW_PASSWORD);
    let last;
    for (let i = 0; i < 6; i++) last = await change({ currentPassword: `wrong guess ${i} xxxxxxx`, newPassword: OP_PASSWORD, confirmPassword: OP_PASSWORD }, c);
    assert.equal(last.status, 429);
    assert.equal(await code(await change({ currentPassword: NEW_PASSWORD, newPassword: OP_PASSWORD, confirmPassword: OP_PASSWORD }, c)), 'rate_limited', 'right password refused while locked');
    const audit = JSON.stringify((await db.pool.query(`select action, detail from audit_events where action like 'auth.password%'`)).rows);
    for (const secret of [OP_PASSWORD, NEW_PASSWORD, 'wrong guess', 'argon2']) assert.ok(!audit.includes(secret));
    assert.ok(audit.includes('auth.password_changed') && audit.includes('auth.password_change_failed') && audit.includes('auth.password_change_locked'));
  } finally {
    await db.drop();
  }
});

test('change password needs a session and a CSRF token', { skip: skipDb }, async () => {
  const { db, ctx, add, login } = await setup();
  try {
    await add('sam@example.test');
    const sam = await login('sam@example.test', OP_PASSWORD);
    const body = { currentPassword: OP_PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD };
    assert.equal((await handlers.handleChangePassword(post('/api/auth/change-password', body, { type: 'json' }), ctx)).status, 401);
    assert.equal((await handlers.handleChangePassword(post('/api/auth/change-password', body, { type: 'json', cookie: sam.cookie }), ctx)).status, 403);
    assert.equal((await handlers.handleChangePassword(post('/api/auth/change-password', body, { type: 'json', cookie: sam.cookie, origin: 'https://evil.example', headers: { 'x-csrf-token': sam.csrf } }), ctx)).status, 403);
    assert.equal((await login('sam@example.test', OP_PASSWORD)).res.status, 200, 'nothing changed');
  } finally {
    await db.drop();
  }
});

// ---- model reuse ----

test('the credential model is reusable by a later delivery channel', { skip: skipDb }, async () => {
  const { db, ctx, add, login } = await setup();
  try {
    await add('sam@example.test');
    const { rows: [target] } = await db.pool.query(`select id, household_id as "householdId", email, version from users where email = 'sam@example.test'`);
    const hash = await hashPassword('delivered by another channel 1');
    const issued = await (async () => {
      const c = await db.pool.connect();
      try {
        await c.query('begin');
        const r = await issueTemporaryCredential(c, ctx.config, { target, kind: 'email_temporary', issuedBy: null, passwordHash: hash, revokeReason: 'self_service_reset' });
        await c.query('commit');
        return r;
      } finally { c.release(); }
    })();
    assert.ok(issued.expiresAt > new Date());
    const t = await login('sam@example.test', 'delivered by another channel 1');
    assert.equal(t.data.passwordChangeRequired, true);
    assert.equal((await db.pool.query(`select kind, issued_by from password_resets`)).rows[0].kind, 'email_temporary');
  } finally {
    await db.drop();
  }
});

test('migration 0009 upgrades existing accounts: nobody is forced to change a password and open sessions keep working', { skip: skipDb }, async () => {
  const db = await freshDatabase({ migrateAll: false });
  try {
    const { migrate } = await import('../../apps/web/server/migrate.ts');
    await migrate(db.pool, { upTo: '0008' });
    await seedHousehold(db.pool);
    await db.pool.query(`insert into sessions (user_id, household_id, token_hash, expires_at)
      select id, household_id, decode(repeat('ab', 32), 'hex'), now() + interval '1 hour' from users`);
    assert.deepEqual(await migrate(db.pool), ['0009']);
    const u = (await db.pool.query('select must_change_password, password_changed_at from users')).rows[0];
    assert.deepEqual(u, { must_change_password: false, password_changed_at: null });
    assert.equal((await db.pool.query('select count(*)::int n from sessions where revoked_at is null')).rows[0].n, 1);
    // The table refuses a second open credential for one account and an unknown kind.
    const { rows: [x] } = await db.pool.query('select id, household_id from users');
    const ins = (kind = 'admin_temporary') => db.pool.query(`insert into password_resets (household_id, user_id, kind, expires_at) values ($1, $2, $3, now() + interval '1 hour')`, [x.household_id, x.id, kind]);
    await ins();
    await assert.rejects(ins(), { code: '23505' });
    await assert.rejects(ins('other'), { code: '23514' });
  } finally {
    await db.drop();
  }
});
