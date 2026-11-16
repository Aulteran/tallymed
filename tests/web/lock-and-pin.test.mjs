// Keep me signed in, the session lock and the security PIN. All data is fabricated.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as handlers from '../../apps/web/server/http.ts';
import { authenticate, LOCK_SERVER_SLACK_SECONDS } from '../../apps/web/server/services/auth.ts';
import { digest } from '../../apps/web/server/tokens.ts';
import { safeReturnPath } from '../../apps/web/server/validation.ts';
import { hashPassword, hashPin, verifyPin } from '../../apps/web/server/passwords.ts';
import { insertUser } from '../../apps/web/server/repositories/users.ts';
import { freshDatabase, loginJson, ORIGIN, PASSWORD, post, seedHousehold, skipDb, testConfig } from './helpers.mjs';

const PIN = '135790';
const NEW_PIN = '246802';
const code = async (res) => (await res.clone().json()).error?.code;
const tokenOf = (cookie) => cookie.split('=')[1];

async function setup(overrides = {}) {
  const db = await freshDatabase();
  const config = testConfig(overrides, db.url);
  const ctx = { config, pool: db.pool };
  const ids = await seedHousehold(db.pool);
  const login = (extra = {}, password = PASSWORD) =>
    handlers.handleLogin(post('/api/auth/login', { email: 'admin@example.test', password, ...extra }, { type: 'json' }), ctx);
  const session = async (extra = {}) => {
    const res = await login(extra);
    const data = await res.clone().json();
    const cookie = res.headers.get('set-cookie').split(';')[0];
    return { res, cookie, csrf: data.csrfToken, token: tokenOf(cookie), maxAge: Number(/Max-Age=(\d+)/.exec(res.headers.get('set-cookie'))?.[1]) };
  };
  const api = (fn, path, body, who, extra = {}) =>
    fn(post(path, body, { type: 'json', cookie: who.cookie, headers: { 'x-csrf-token': who.csrf }, ...extra }), ctx);
  const setPin = (who, pin = PIN) => api(handlers.handleChangePin, '/api/auth/change-pin', { newPin: pin, confirmPin: pin }, who);
  const lock = (who) => api(handlers.handleLock, '/api/auth/lock', {}, who);
  const unlock = (who, pin, extra = {}) => api(handlers.handleUnlock, '/api/auth/unlock', { pin }, who, extra);
  const sessionRow = async (who) => (await db.pool.query(
    'select remember, locked_at, pin_failures, revoked_at, revoked_reason, last_seen_at, expires_at from sessions where token_hash = $1', [digest(who.token)])).rows[0];
  const age = (who, seconds) => db.pool.query(
    `update sessions set last_seen_at = now() - make_interval(secs => $2) where token_hash = $1`, [digest(who.token), seconds]);
  const member = (who) => api((req, c) => handlers.handleExpenseAction(req, c, 'members/create'), '/api/expenses/members/create', { name: 'Pat Example' }, who);
  return { db, ctx, config, ...ids, login, session, api, setPin, lock, unlock, sessionRow, age, member };
}

test('safeReturnPath only returns same-site application paths', () => {
  assert.equal(safeReturnPath('/bills/abc?x=1'), '/bills/abc?x=1');
  for (const bad of ['//evil.test', 'https://evil.test', '/\\evil.test', '/locked', '/login?x=1', '/api/auth/logout', '', undefined, 'bills', `/${'a'.repeat(400)}`, '/a b']) {
    assert.equal(safeReturnPath(bad), '/', String(bad));
  }
});

test('a PIN is hashed with Argon2id and checked without revealing a missing hash', async () => {
  const h = await hashPin(PIN);
  assert.match(h, /^\$argon2id\$/);
  assert.ok(!h.includes(PIN));
  assert.equal(await verifyPin(h, PIN), true);
  assert.equal(await verifyPin(h, NEW_PIN), false);
  assert.equal(await verifyPin(null, PIN), false);
  assert.equal(await verifyPin(h, '12345'), false);
  await assert.rejects(hashPin('12345'));
  await assert.rejects(hashPin('12345a'));
  await assert.rejects(hashPin('1234567'));
});

test('keep me signed in: a longer session only when asked, and unchecked sign-in is exactly as before', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const plain = await t.session();
    const near = (a, b) => assert.ok(Math.abs(a - b) <= 2, `${a} is not near ${b}`);
    near(plain.maxAge, t.config.sessionAbsoluteSeconds);
    assert.equal((await t.sessionRow(plain)).remember, false);
    const off = await t.session({ remember: false });
    near(off.maxAge, t.config.sessionAbsoluteSeconds);
    const kept = await t.session({ remember: 'on' });
    near(kept.maxAge, t.config.rememberSessionAbsoluteSeconds);
    assert.ok(t.config.rememberSessionAbsoluteSeconds > t.config.sessionAbsoluteSeconds);
    const row = await t.sessionRow(kept);
    assert.equal(row.remember, true);
    assert.ok(Math.abs(row.expires_at.getTime() - (Date.now() + t.config.rememberSessionAbsoluteSeconds * 1000)) < 10_000);
    // Idle: a plain session dies after the normal idle limit, a kept one lives through it.
    const idle = t.config.sessionIdleSeconds + 600;
    await t.age(plain, idle); await t.age(kept, idle);
    assert.equal(await authenticate(t.db.pool, t.config, plain.token), null);
    assert.ok(await authenticate(t.db.pool, t.config, kept.token));
    await t.age(kept, t.config.rememberSessionIdleSeconds + 600);
    assert.equal(await authenticate(t.db.pool, t.config, kept.token), null);
    // The restricted session of a temporary password is never a kept one.
    const adminSession = await t.session();
    const opId = await insertUser(t.db.pool, { householdId: t.householdId, email: 'op@example.test', displayName: 'Op', role: 'operator', passwordHash: await hashPassword(PASSWORD) });
    const version = (await t.db.pool.query('select version from users where id = $1', [opId])).rows[0].version;
    const reset = await t.api(handlers.handleResetPassword, '/api/operators/reset-password', { userId: opId, version }, adminSession);
    const temporary = (await reset.json()).temporaryPassword;
    const res = await handlers.handleLogin(post('/api/auth/login', { email: 'op@example.test', password: temporary, remember: 'on' }, { type: 'json' }), t.ctx);
    assert.equal(res.status, 200);
    const restricted = { token: tokenOf(res.headers.get('set-cookie').split(';')[0]) };
    assert.ok(Number(/Max-Age=(\d+)/.exec(res.headers.get('set-cookie'))[1]) <= t.config.passwordChangeSessionSeconds);
    assert.equal((await t.sessionRow(restricted)).remember, false);
  } finally { await t.db.drop(); }
});

test('changing the password keeps a remembered session remembered', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const kept = await t.session({ remember: 'on' });
    const res = await t.api(handlers.handleChangePassword, '/api/auth/change-password',
      { currentPassword: PASSWORD, newPassword: 'a different long passphrase 9', confirmPassword: 'a different long passphrase 9' }, kept);
    assert.equal(res.status, 200);
    const fresh = { token: tokenOf(res.headers.get('set-cookie').split(';')[0]) };
    assert.equal((await t.sessionRow(fresh)).remember, true);
  } finally { await t.db.drop(); }
});

test('PIN at account creation: hashed, confirmed, optional at the API, never stored or logged in clear', { skip: skipDb }, async () => {
  const db = await freshDatabase();
  try {
    const ctx = { config: testConfig({ TALLYMED_SETUP_TOKEN: 'k7Qz4mVx9LpR2wTn8YbH5cJd3FgS6aUe' }, db.url), pool: db.pool };
    const body = { setupToken: 'k7Qz4mVx9LpR2wTn8YbH5cJd3FgS6aUe', householdName: 'Example Family', email: 'admin@example.test', displayName: 'Alex Example', password: PASSWORD };
    const mismatch = await handlers.handleSetup(post('/api/setup', { ...body, pin: PIN, confirmPin: NEW_PIN }, { type: 'json' }), ctx);
    assert.equal(mismatch.status, 400);
    const short = await handlers.handleSetup(post('/api/setup', { ...body, pin: '1234', confirmPin: '1234' }, { type: 'json' }), ctx);
    assert.equal(short.status, 400);
    assert.equal((await db.pool.query('select 1 from households')).rowCount, 0);
    const ok = await handlers.handleSetup(post('/api/setup', { ...body, pin: PIN, confirmPin: PIN }, { type: 'json' }), ctx);
    assert.equal(ok.status, 201);
    const user = (await db.pool.query('select pin_hash, pin_changed_at from users')).rows[0];
    assert.match(user.pin_hash, /^\$argon2id\$/);
    assert.ok(user.pin_changed_at);
    const dump = JSON.stringify((await db.pool.query('select * from users')).rows) + JSON.stringify((await db.pool.query('select * from audit_events')).rows);
    assert.ok(!dump.includes(PIN));
  } finally { await db.drop(); }
});

test('an invitation carries the new person\'s PIN; an account without one is allowed and never locks', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const admin = await t.session();
    const accept = async (email, extra) => {
      const inv = await t.api(handlers.handleInvite, '/api/operators/invite', { email, role: 'operator' }, admin);
      const token = (await inv.json()).link.split('/').pop();
      return handlers.handleAcceptInvitation(post('/api/invitations/accept', { token, displayName: 'Sam Example', password: PASSWORD, ...extra }, { type: 'json' }), t.ctx);
    };
    assert.equal((await accept('sam@example.test', { pin: PIN, confirmPin: PIN })).status, 201);
    assert.equal((await accept('lee@example.test', {})).status, 201);
    const rows = (await t.db.pool.query('select email, pin_hash from users where email in ($1, $2) order by email', ['lee@example.test', 'sam@example.test'])).rows;
    assert.equal(rows[0].pin_hash, null);
    assert.match(rows[1].pin_hash, /^\$argon2id\$/);
    const lee = await loginJson(handlers, t.ctx, 'lee@example.test');
    assert.equal((await t.lock({ cookie: lee.cookie, csrf: lee.csrf })).status, 409);
  } finally { await t.db.drop(); }
});

test('an account without a PIN is never locked, even after a long quiet spell', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const me = await t.session();
    assert.equal((await t.lock(me)).status, 409);
    await t.age(me, 3000);
    const actor = await authenticate(t.db.pool, t.config, me.token);
    assert.equal(actor.locked, false);
    assert.equal(actor.hasPin, false);
    assert.equal((await t.member(me)).status < 300, true);
  } finally { await t.db.drop(); }
});

test('locking: every authenticated route and read refuses a locked session; sign-out and unlock still work; the session survives', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const me = await t.session();
    assert.equal((await t.setPin(me)).status, 200);
    assert.equal((await t.member(me)).status < 300, true);
    assert.equal((await t.lock(me)).status, 200);
    assert.equal((await t.lock(me)).status, 200, 'locking twice is harmless');
    const row = await t.sessionRow(me);
    assert.ok(row.locked_at);
    assert.equal(row.revoked_at, null);
    // Closed by default: a mutation, a password change, a PIN change, a heartbeat and a read all answer 423.
    assert.equal(await code(await t.member(me)), 'locked');
    assert.equal((await t.member(me)).status, 423);
    assert.equal((await t.api(handlers.handleChangePassword, '/api/auth/change-password', { currentPassword: PASSWORD, newPassword: 'another long passphrase 3', confirmPassword: 'another long passphrase 3' }, me)).status, 423);
    assert.equal((await t.api(handlers.handleChangePin, '/api/auth/change-pin', { currentPin: PIN, newPin: NEW_PIN, confirmPin: NEW_PIN }, me)).status, 423);
    assert.equal((await t.api(handlers.handleHeartbeat, '/api/auth/heartbeat', {}, me)).status, 423);
    const read = await handlers.handleHsaExport(new Request('http://app.internal:3000/api/hsa/export', { headers: { cookie: me.cookie } }), t.ctx);
    assert.equal(read.status, 423);
    // A browser form post goes to the PIN screen.
    const html = await handlers.handleExpenseAction(post('/api/expenses/members/create', { name: 'X', csrf: me.csrf }, { cookie: me.cookie, html: true }), t.ctx, 'members/create');
    assert.equal(html.status, 303);
    assert.match(html.headers.get('location'), /\/locked$/);
    const cookieBefore = me.cookie;
    assert.equal((await t.unlock(me, PIN)).status, 200);
    assert.equal(me.cookie, cookieBefore, 'the session cookie is not replaced');
    assert.equal((await t.sessionRow(me)).locked_at, null);
    assert.equal((await t.member(me)).status < 300, true);
    // Sign-out works while locked.
    await t.lock(me);
    const out = await t.api(handlers.handleLogout, '/api/auth/logout', {}, me);
    assert.equal(out.status, 200);
    assert.equal(await authenticate(t.db.pool, t.config, me.token), null);
  } finally { await t.db.drop(); }
});

test('idle lock is decided on the server, persists, and a locked session is not kept fresh', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const me = await t.session({ remember: 'on' });
    await t.setPin(me);
    await t.age(me, t.config.lockIdleSeconds - 60);
    assert.equal((await authenticate(t.db.pool, t.config, me.token)).locked, false);
    // The server waits a minute beyond the browser's timer, so it never locks someone the browser still counts as active.
    await t.age(me, t.config.lockIdleSeconds + LOCK_SERVER_SLACK_SECONDS - 20);
    assert.equal((await authenticate(t.db.pool, t.config, me.token)).locked, false);
    await t.age(me, t.config.lockIdleSeconds + LOCK_SERVER_SLACK_SECONDS + 30);
    const before = (await t.sessionRow(me)).last_seen_at;
    const locked = await authenticate(t.db.pool, t.config, me.token);
    assert.equal(locked.locked, true);
    const row = await t.sessionRow(me);
    assert.ok(row.locked_at, 'stored at once');
    assert.equal(row.last_seen_at.getTime(), before.getTime(), 'no touch while locked');
    assert.equal((await authenticate(t.db.pool, t.config, me.token)).locked, true);
    assert.equal((await t.member(me)).status, 423);
    const audits = (await t.db.pool.query(`select detail from audit_events where action = 'auth.session_locked'`)).rows;
    assert.deepEqual(audits.map((a) => a.detail.reason), ['idle']);
    assert.equal((await t.unlock(me, PIN)).status, 200);
    assert.equal((await authenticate(t.db.pool, t.config, me.token)).locked, false);
    // Activity keeps the session unlocked: a heartbeat refreshes last_seen.
    await t.age(me, 100);
    assert.equal((await t.api(handlers.handleHeartbeat, '/api/auth/heartbeat', {}, me)).status, 200);
    assert.ok(Date.now() - (await t.sessionRow(me)).last_seen_at.getTime() < 20_000);
  } finally { await t.db.drop(); }
});

test('wrong PINs are counted before they are checked and end the session at the limit', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const me = await t.session();
    await t.setPin(me);
    await t.lock(me);
    for (const left of [4, 3, 2, 1]) {
      const res = await t.unlock(me, '000000');
      assert.equal(res.status, 401);
      assert.equal(await code(res), 'invalid_pin');
      assert.equal((await res.json()).remaining, left);
    }
    assert.equal((await t.sessionRow(me)).pin_failures, 4);
    const last = await t.unlock(me, '000000');
    assert.equal(last.status, 401);
    assert.equal(await code(last), 'pin_attempts_exceeded');
    assert.match(last.headers.get('set-cookie'), /Max-Age=0/);
    const row = await t.sessionRow(me);
    assert.equal(row.revoked_reason, 'pin_attempts_exceeded');
    // Even the right PIN no longer helps: the person signs in with the password.
    assert.equal((await t.unlock(me, PIN)).status, 401);
    assert.equal(await authenticate(t.db.pool, t.config, me.token), null);
    assert.equal((await t.session()).res.status, 200);
    const audit = (await t.db.pool.query(`select detail from audit_events where action = 'auth.pin_lockout'`)).rows;
    assert.equal(audit.length, 1);
  } finally { await t.db.drop(); }
});

test('a correct PIN resets the count; the count is per session', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const a = await t.session(); const b = await t.session();
    await t.setPin(a); await t.lock(a); await t.lock(b);
    for (let i = 0; i < 3; i++) await t.unlock(a, '000000');
    assert.equal((await t.sessionRow(b)).pin_failures, 0);
    assert.equal((await t.unlock(a, PIN)).status, 200);
    assert.equal((await t.sessionRow(a)).pin_failures, 0);
    await t.lock(a);
    for (let i = 0; i < 4; i++) assert.equal((await t.unlock(a, '000000')).status, 401);
    assert.equal((await t.unlock(a, PIN)).status, 200, 'four wrong guesses earlier did not carry over');
  } finally { await t.db.drop(); }
});

test('a concurrent burst of guesses cannot try more PINs than the limit', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const me = await t.session();
    await t.setPin(me);
    await t.lock(me);
    const guesses = Array.from({ length: 40 }, (_, i) => String(100000 + i * 7919).slice(0, 6));
    assert.ok(!guesses.includes(PIN));
    const results = await Promise.all(guesses.map((g) => t.unlock(me, g)));
    assert.ok(results.every((r) => r.status === 401));
    const codes = await Promise.all(results.map(code));
    assert.ok(codes.filter((c) => c === 'invalid_pin').length < 5, 'at most four guesses are ever checked and answered as wrong');
    assert.equal((await t.sessionRow(me)).revoked_reason, 'pin_attempts_exceeded');
    assert.equal((await t.db.pool.query(`select 1 from audit_events where action = 'auth.pin_lockout'`)).rowCount, 1, 'one audit row however large the burst');
    // The count only ever goes up on this session: the right PIN, tried after the burst, is refused.
    assert.equal((await t.unlock(me, PIN)).status, 401);
  } finally { await t.db.drop(); }
});

test('browser form posts: unlock returns to the page, a wrong PIN shows the attempts left, the limit goes to sign-in', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const me = await t.session();
    await t.setPin(me);
    await t.lock(me);
    const form = (pin, next = '/bills/xyz?page=2') => handlers.handleUnlock(
      post('/api/auth/unlock', { pin, next, csrf: me.csrf }, { cookie: me.cookie, html: true }), t.ctx);
    const wrong = await form('000000');
    assert.equal(wrong.status, 303);
    assert.equal(new URL(wrong.headers.get('location')).pathname + new URL(wrong.headers.get('location')).search,
      `/locked?error=invalid_pin&left=4&next=${encodeURIComponent('/bills/xyz?page=2')}`);
    const evil = await form(PIN, 'https://evil.test/');
    assert.equal(new URL(evil.headers.get('location'), ORIGIN).pathname, '/');
    await t.lock(me);
    const ok = await form(PIN);
    assert.equal(new URL(ok.headers.get('location')).pathname, '/bills/xyz');
    await t.lock(me);
    let res;
    for (let i = 0; i < 5; i++) res = await form('000000');
    assert.equal(new URL(res.headers.get('location')).pathname, '/login');
    assert.match(res.headers.get('location'), /error=pin_attempts_exceeded/);
  } finally { await t.db.drop(); }
});

test('setting and changing the PIN: first needs no proof, a change needs the PIN or the password, nothing is signed out', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const me = await t.session(); const other = await t.session();
    assert.equal((await t.api(handlers.handleChangePin, '/api/auth/change-pin', { newPin: '12', confirmPin: '12' }, me)).status, 400);
    assert.equal((await t.api(handlers.handleChangePin, '/api/auth/change-pin', { newPin: PIN, confirmPin: NEW_PIN }, me)).status, 400);
    assert.equal((await t.setPin(me)).status, 200);
    const hash = (await t.db.pool.query('select pin_hash from users')).rows[0].pin_hash;
    // Changing needs proof.
    assert.equal((await t.api(handlers.handleChangePin, '/api/auth/change-pin', { newPin: NEW_PIN, confirmPin: NEW_PIN }, me)).status, 400);
    assert.equal((await t.api(handlers.handleChangePin, '/api/auth/change-pin', { currentPin: '000000', newPin: NEW_PIN, confirmPin: NEW_PIN }, me)).status, 401);
    assert.equal((await t.api(handlers.handleChangePin, '/api/auth/change-pin', { currentPassword: 'not the password at all', newPin: NEW_PIN, confirmPin: NEW_PIN }, me)).status, 403);
    assert.equal((await t.db.pool.query('select pin_hash from users')).rows[0].pin_hash, hash);
    // A password manager may fill the password beside a typed PIN: the PIN decides.
    assert.equal((await t.api(handlers.handleChangePin, '/api/auth/change-pin', { currentPin: '000000', currentPassword: PASSWORD, newPin: NEW_PIN, confirmPin: NEW_PIN }, me)).status, 401);
    assert.equal((await t.api(handlers.handleChangePin, '/api/auth/change-pin', { currentPin: PIN, currentPassword: 'a stray autofilled value', newPin: NEW_PIN, confirmPin: NEW_PIN }, me)).status, 200);
    assert.equal((await t.sessionRow(me)).pin_failures, 0);
    // A forgotten PIN is replaced with the account password.
    assert.equal((await t.api(handlers.handleChangePin, '/api/auth/change-pin', { currentPassword: PASSWORD, newPin: PIN, confirmPin: PIN }, me)).status, 200);
    // Nothing was signed out, and the PIN still works after a lock.
    assert.ok(await authenticate(t.db.pool, t.config, other.token));
    await t.lock(me);
    assert.equal((await t.unlock(me, NEW_PIN)).status, 401);
    assert.equal((await t.unlock(me, PIN)).status, 200);
    const audit = (await t.db.pool.query(`select action, detail from audit_events where action like 'auth.pin%' order by id`)).rows;
    assert.deepEqual(audit.map((a) => a.action), ['auth.pin_set', 'auth.pin_change_failed', 'auth.pin_changed', 'auth.pin_changed']);
    assert.deepEqual(audit.filter((a) => a.action !== 'auth.pin_change_failed').map((a) => a.detail.proof), ['none', 'pin', 'password']);
    assert.ok(!JSON.stringify((await t.db.pool.query('select * from audit_events')).rows).match(new RegExp(`${PIN}|${NEW_PIN}`)));
  } finally { await t.db.drop(); }
});

test('wrong current PINs on the change form count against the session like unlock attempts', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const me = await t.session();
    await t.setPin(me);
    for (let i = 0; i < 4; i++) assert.equal((await t.api(handlers.handleChangePin, '/api/auth/change-pin', { currentPin: '000000', newPin: NEW_PIN, confirmPin: NEW_PIN }, me)).status, 401);
    const last = await t.api(handlers.handleChangePin, '/api/auth/change-pin', { currentPin: '000000', newPin: NEW_PIN, confirmPin: NEW_PIN }, me);
    assert.equal(await code(last), 'pin_attempts_exceeded');
    assert.equal(await authenticate(t.db.pool, t.config, me.token), null);
  } finally { await t.db.drop(); }
});

test('the lock cannot be set or cleared by someone else\'s session, nor without the CSRF token', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const me = await t.session();
    await t.setPin(me);
    const noCsrf = await handlers.handleLock(post('/api/auth/lock', {}, { type: 'json', cookie: me.cookie }), t.ctx);
    assert.equal(noCsrf.status, 403);
    const anon = await handlers.handleUnlock(post('/api/auth/unlock', { pin: PIN }, { type: 'json' }), t.ctx);
    assert.equal(anon.status, 401);
    const cross = await handlers.handleLock(post('/api/auth/lock', {}, { type: 'json', cookie: me.cookie, origin: 'https://evil.test', headers: { 'x-csrf-token': me.csrf } }), t.ctx);
    assert.equal(cross.status, 403);
    assert.equal((await t.sessionRow(me)).locked_at, null);
  } finally { await t.db.drop(); }
});

test('a backup keeps the PIN hash but no session lock state, and the schema upgrade leaves existing accounts without a PIN', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const cols = (await t.db.pool.query(`select column_name from information_schema.columns where table_name = 'users' and column_name like 'pin%' order by 1`)).rows.map((r) => r.column_name);
    assert.deepEqual(cols, ['pin_changed_at', 'pin_hash']);
    assert.equal((await t.db.pool.query('select pin_hash from users')).rows[0].pin_hash, null);
    await assert.rejects(t.db.pool.query(`update users set pin_changed_at = now() where pin_hash is null`));
  } finally { await t.db.drop(); }
});

test('a locked session is refused by every gated action and read; only lock, unlock and sign-out answer', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const me = await t.session();
    await t.setPin(me);
    await t.lock(me);
    const inv = handlers.actionInventory();
    const refused = async (res, what) => { assert.equal(res.status, 423, what); assert.equal(await code(res), 'locked', what); };
    const h = { 'x-csrf-token': me.csrf };
    for (const a of inv.expenses) await refused(await handlers.handleExpenseAction(post(`/api/expenses/${a}`, {}, { type: 'json', cookie: me.cookie, headers: h }), t.ctx, a), a);
    for (const a of inv.documents) await refused(await handlers.handleDocumentAction(post(`/api/documents/${a}`, {}, { type: 'json', cookie: me.cookie, headers: h }), t.ctx, a), a);
    for (const a of inv.assistant) await refused(await handlers.handleAssistantAction(post(`/api/assistant/${a}`, {}, { type: 'json', cookie: me.cookie, headers: h }), t.ctx, a), a);
    for (const a of inv.settings) await refused(await handlers.handleSettingsAction(post(`/api/settings/${a}`, {}, { type: 'json', cookie: me.cookie, headers: h }), t.ctx, a), a);
    for (const [fn, p] of [[handlers.handleInvite, '/api/operators/invite'], [handlers.handleUpdateOperator, '/api/operators/update'],
      [handlers.handleResetPassword, '/api/operators/reset-password'], [handlers.handleRevokeInvitation, '/api/operators/invitations/revoke']]) {
      await refused(await t.api(fn, p, {}, me), p);
    }
    const get = (p) => new Request(`http://app.internal:3000${p}`, { headers: { cookie: me.cookie } });
    await refused(await handlers.handleHsaExport(get('/api/hsa/export'), t.ctx), 'hsa export');
    const id = '11111111-1111-4111-8111-111111111111';
    await refused(await handlers.handleDocumentDownload(get(`/api/documents/download/${id}`), t.ctx, id), 'download');
    // The same account on another, unlocked session is unaffected.
    const other = await t.session();
    assert.notEqual((await handlers.handleHsaExport(new Request('http://app.internal:3000/api/hsa/export', { headers: { cookie: other.cookie } }), t.ctx)).status, 423);
  } finally { await t.db.drop(); }
});
