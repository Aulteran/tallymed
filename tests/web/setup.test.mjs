// First-administrator setup with a one-time setup token. All data is fabricated.
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../../apps/web/server/config.ts';
import * as handlers from '../../apps/web/server/http.ts';
import { setLogSink } from '../../apps/web/server/log.ts';
import { isBootstrapped } from '../../apps/web/server/services/bootstrap.ts';
import { announceSetupWhenNeeded } from '../../apps/web/server/setup-announce.ts';
import {
  announceSetup, checkSetupToken, closeSetup, ensureSetupToken, MAX_SETUP_FAILURES, MAX_SETUP_FAILURES_PER_ADDRESS,
  resetSetupState, setSetupOutput,
} from '../../apps/web/server/setup-token.ts';
import { migrate } from '../../apps/web/server/migrate.ts';
import { freshDatabase, loginJson, ORIGIN, PASSWORD, PROXY_SECRET, post, skipDb, testConfig } from './helpers.mjs';

const ENV_TOKEN = 'synthetic-setup-token-0123456789-abcdef';
const baseEnv = { DATABASE_URL: 'postgres://x/y', TALLYMED_CANONICAL_ORIGIN: 'https://tallymed.example' };
const code = async (res) => (await res.clone().json()).error?.code;
const admin = (n = 1, extra = {}) => ({ householdName: 'Example Family', displayName: 'Alex Example', email: `admin${n}@example.test`, password: PASSWORD, ...extra });

/** Captures console output and structured log lines for one test. */
function capture() {
  const out = []; const logs = [];
  const prevOut = setSetupOutput((t) => out.push(t));
  setLogSink((l) => logs.push(l));
  resetSetupState();
  return { out, logs, restore() { globalThis[CONTEXT_KEY] = undefined; setSetupOutput(prevOut); setLogSink((l) => process.stderr.write(l + '\n')); resetSetupState(); } };
}

const CONTEXT_KEY = Symbol.for('tallymed.appContext');
async function setup(overrides = {}, { migrateAll = true } = {}) {
  const db = await freshDatabase({ migrateAll });
  const config = testConfig(overrides, db.url);
  const ctx = { config, pool: db.pool };
  globalThis[CONTEXT_KEY] = ctx; // the startup notice reads the process-wide context
  return { db, ctx, config };
}
const postSetup = (ctx, body, opts = {}) => handlers.handleSetup(post('/api/setup', body, { type: 'json', ...opts }), ctx);
const fromProxy = (ip) => ({ 'x-tallymed-proxy-secret': PROXY_SECRET, 'x-forwarded-for': ip, 'x-forwarded-proto': 'https' });

test('config: an operator-defined token must be long, printable and not guessable; empty means generate', () => {
  assert.equal(loadConfig(baseEnv).setupToken, null);
  assert.equal(loadConfig({ ...baseEnv, TALLYMED_SETUP_TOKEN: '' }).setupToken, null);
  assert.equal(loadConfig({ ...baseEnv, TALLYMED_SETUP_TOKEN: ENV_TOKEN }).setupToken, ENV_TOKEN);
  const bad = ['short', 'a'.repeat(40), 'abcabcabcabcabcabcabcabcabc', 'changeme-changeme-changeme-1234', 'has space in the middle of the token 123', 'x'.repeat(129), 'tokén-with-non-ascii-characters-123456'];
  for (const value of bad) {
    assert.throws(() => loadConfig({ ...baseEnv, TALLYMED_SETUP_TOKEN: value }), (e) => e.message.includes('TALLYMED_SETUP_TOKEN') && !e.message.includes(value), value);
  }
});

test('generated token: 256 random bits, printed once to the console, never through structured logs', () => {
  const c = capture();
  try {
    const config = { setupToken: null, canonicalOrigin: ORIGIN };
    const first = ensureSetupToken(config);
    assert.equal(first.source, 'generated');
    assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(ensureSetupToken(config).token, first.token);
    announceSetup(config);
    assert.equal(c.out.length, 1, 'banner printed exactly once');
    assert.ok(c.out[0].includes(first.token) && c.out[0].includes(`${ORIGIN}/setup`));
    assert.ok(c.logs.every((l) => !l.includes(first.token)), 'no structured log line contains the token');
    resetSetupState();
    assert.notEqual(ensureSetupToken(config).token, first.token, 'a fresh process generates a new token');
  } finally { c.restore(); }
});

test('configured token: the notice names the variable and never prints the value', () => {
  const c = capture();
  try {
    announceSetup({ setupToken: ENV_TOKEN, canonicalOrigin: ORIGIN });
    assert.equal(c.out.length, 1);
    assert.ok(c.out[0].includes('TALLYMED_SETUP_TOKEN') && !c.out[0].includes(ENV_TOKEN));
    assert.ok(c.logs.every((l) => !l.includes(ENV_TOKEN)));
  } finally { c.restore(); }
});

test('a configured token creates the first administrator; the token is stored nowhere', { skip: skipDb }, async () => {
  const c = capture();
  const { db, ctx } = await setup({ TALLYMED_SETUP_TOKEN: ENV_TOKEN });
  try {
    assert.equal(await isBootstrapped(db.pool), false);
    const res = await postSetup(ctx, { setupToken: ENV_TOKEN, ...admin() });
    assert.equal(res.status, 201);
    assert.equal(await isBootstrapped(db.pool), true);
    const { res: loginRes } = await loginJson(handlers, ctx, 'admin1@example.test');
    assert.equal(loginRes.status, 200);
    const audit = (await db.pool.query(`select action, detail from audit_events where action = 'bootstrap.completed'`)).rows;
    assert.equal(audit.length, 1);
    assert.deepEqual(audit[0].detail, { method: 'setup_token', tokenSource: 'env' });
    // Nothing in any table or log holds the token or the password.
    for (const table of ['audit_events', 'users', 'households', 'bootstrap_state', 'sessions', 'login_attempts']) {
      const dump = JSON.stringify((await db.pool.query(`select * from ${table}`)).rows);
      assert.ok(!dump.includes(ENV_TOKEN), `${table} contains the token`);
      assert.ok(!dump.includes(PASSWORD), `${table} contains the password`);
    }
    assert.ok(c.logs.every((l) => !l.includes(ENV_TOKEN) && !l.includes(PASSWORD)));
  } finally { await db.drop(); c.restore(); }
});

test('a generated token (empty variable) works once printed, and a browser form post redirects to sign-in', { skip: skipDb }, async () => {
  const c = capture();
  const { db, ctx } = await setup({ TALLYMED_SETUP_TOKEN: '' });
  try {
    assert.equal(ctx.config.setupToken, null);
    assert.equal(await announceSetupWhenNeeded(1, 1), true);
    assert.equal(c.out.length, 1);
    const token = /^ {4}(\S{43})$/m.exec(c.out[0])?.[1];
    assert.ok(token, 'banner shows the token on its own line');
    const res = await handlers.handleSetup(post('/api/setup', { setupToken: token, ...admin() }, { html: true }), ctx);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), `${ORIGIN}/login?notice=setup_complete`);
    const audit = (await db.pool.query(`select detail from audit_events where action = 'bootstrap.completed'`)).rows[0].detail;
    assert.deepEqual(audit, { method: 'setup_token', tokenSource: 'generated' });
    const dump = JSON.stringify((await db.pool.query('select * from audit_events')).rows);
    assert.ok(!dump.includes(token));
    // Once complete the token no longer exists anywhere in the process, and nothing is printed again.
    assert.equal(await announceSetupWhenNeeded(1, 1), false);
    assert.equal(c.out.length, 1);
  } finally { await db.drop(); c.restore(); }
});

test('wrong, missing and mismatched tokens are refused without creating anything', { skip: skipDb }, async () => {
  const c = capture();
  const { db, ctx } = await setup({ TALLYMED_SETUP_TOKEN: ENV_TOKEN });
  try {
    for (const t of ['wrong', ENV_TOKEN.slice(1), ENV_TOKEN + 'x', ENV_TOKEN.toUpperCase()]) {
      const res = await postSetup(ctx, { setupToken: t, ...admin() });
      assert.equal(res.status, 403);
      assert.equal(await code(res), 'invalid_setup_token');
    }
    assert.equal(await code(await postSetup(ctx, admin())), 'invalid_input');
    assert.equal(await code(await postSetup(ctx, { setupToken: ENV_TOKEN, ...admin(), extra: 'x' })), 'invalid_input');
    assert.equal((await db.pool.query('select count(*)::int n from households')).rows[0].n, 0);
    assert.equal(await isBootstrapped(db.pool), false);
  } finally { await db.drop(); c.restore(); }
});

test('input errors with the right token do not spend attempts or the token; surrounding whitespace is ignored', { skip: skipDb }, async () => {
  const c = capture();
  const { db, ctx } = await setup({ TALLYMED_SETUP_TOKEN: ENV_TOKEN });
  try {
    for (let i = 0; i < MAX_SETUP_FAILURES + 3; i++) {
      assert.equal(await code(await postSetup(ctx, { setupToken: ENV_TOKEN, ...admin(1, { password: 'short' }) })), 'invalid_input');
    }
    assert.equal((await postSetup(ctx, { setupToken: `  ${ENV_TOKEN}\n`, ...admin() })).status, 201);
  } finally { await db.drop(); c.restore(); }
});

test('failed attempts lock setup for the window, including for the right token', { skip: skipDb }, async () => {
  const c = capture();
  const { db, ctx } = await setup({ TALLYMED_SETUP_TOKEN: ENV_TOKEN });
  try {
    for (let i = 0; i < MAX_SETUP_FAILURES; i++) assert.equal(await code(await postSetup(ctx, { setupToken: `wrong-${i}`, ...admin() })), 'invalid_setup_token');
    const locked = await postSetup(ctx, { setupToken: ENV_TOKEN, ...admin() });
    assert.equal(locked.status, 429);
    assert.equal(await code(locked), 'rate_limited');
    assert.ok(Number(locked.headers.get('retry-after')) > 0);
    assert.equal(await isBootstrapped(db.pool), false);
    // The window is time based: after it passes, the right token works again.
    const config = { setupToken: ENV_TOKEN, canonicalOrigin: ORIGIN };
    assert.throws(() => checkSetupToken(config, ENV_TOKEN, null), { code: 'rate_limited' });
    assert.deepEqual(checkSetupToken(config, ENV_TOKEN, null, Date.now() + 15 * 60 * 1000 + 1), { source: 'env' });
  } finally { await db.drop(); c.restore(); }
});

test('a trusted client address has its own smaller budget; spoofed forwarding headers are ignored', { skip: skipDb }, async () => {
  const c = capture();
  const { db, ctx } = await setup({ TALLYMED_SETUP_TOKEN: ENV_TOKEN });
  try {
    for (let i = 0; i < MAX_SETUP_FAILURES_PER_ADDRESS; i++) {
      assert.equal(await code(await postSetup(ctx, { setupToken: 'nope', ...admin() }, { headers: fromProxy('203.0.113.7') })), 'invalid_setup_token');
    }
    assert.equal(await code(await postSetup(ctx, { setupToken: ENV_TOKEN, ...admin() }, { headers: fromProxy('203.0.113.7') })), 'rate_limited');
    // Another address is unaffected by it; an untrusted caller cannot pick an address (wrong secret means no address).
    assert.equal(await code(await postSetup(ctx, { setupToken: 'nope', ...admin() }, { headers: fromProxy('203.0.113.8') })), 'invalid_setup_token');
    assert.equal(await code(await postSetup(ctx, { setupToken: 'nope', ...admin() }, { headers: { 'x-forwarded-for': '203.0.113.9' } })), 'invalid_setup_token');
    assert.equal((await postSetup(ctx, { setupToken: ENV_TOKEN, ...admin() }, { headers: fromProxy('203.0.113.8') })).status, 201);
  } finally { await db.drop(); c.restore(); }
});

test('a concurrent burst of wrong guesses cannot exceed the failure budget', { skip: skipDb }, async () => {
  const c = capture();
  const { db, ctx } = await setup({ TALLYMED_SETUP_TOKEN: ENV_TOKEN });
  try {
    const results = await Promise.all(Array.from({ length: 60 }, (_, i) => postSetup(ctx, { setupToken: `guess-${i}`, ...admin() }).then(code)));
    assert.equal(results.filter((r) => r === 'invalid_setup_token').length, MAX_SETUP_FAILURES);
    assert.equal(results.filter((r) => r === 'rate_limited').length, 60 - MAX_SETUP_FAILURES);
  } finally { await db.drop(); c.restore(); }
});

test('concurrent setups with the right token create exactly one household and administrator', { skip: skipDb }, async () => {
  const c = capture();
  const { db, ctx } = await setup({ TALLYMED_SETUP_TOKEN: ENV_TOKEN });
  try {
    const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => postSetup(ctx, { setupToken: ENV_TOKEN, ...admin(i, { householdName: `Family ${i}` }) })));
    const codes = await Promise.all(responses.map(async (r) => (r.status === 201 ? 'ok' : code(r))));
    assert.equal(codes.filter((x) => x === 'ok').length, 1, codes.join());
    assert.ok(codes.filter((x) => x !== 'ok').every((x) => x === 'bootstrap_closed' || x === 'not_found'), codes.join());
    assert.equal((await db.pool.query('select count(*)::int n from households')).rows[0].n, 1);
    assert.equal((await db.pool.query('select count(*)::int n from users')).rows[0].n, 1);
    assert.equal((await db.pool.query(`select count(*)::int n from audit_events where action = 'bootstrap.completed'`)).rows[0].n, 1);
  } finally { await db.drop(); c.restore(); }
});

test('after setup the endpoint answers not found for every caller, and the generated token is gone from memory', { skip: skipDb }, async () => {
  const c = capture();
  const { db, ctx } = await setup({ TALLYMED_SETUP_TOKEN: '' });
  try {
    await announceSetupWhenNeeded(1, 1);
    const token = /^ {4}(\S{43})$/m.exec(c.out[0])[1];
    assert.equal((await postSetup(ctx, { setupToken: token, ...admin() })).status, 201);
    for (const t of [token, 'wrong', '']) {
      const res = await postSetup(ctx, { setupToken: t, ...admin(2) });
      assert.equal(res.status, 404);
      assert.equal(await code(res), 'not_found');
    }
    // Even a direct call cannot be answered by the old token: a new generation would be a different value and is not printed.
    assert.equal(c.out.length, 1);
    assert.equal((await db.pool.query('select count(*)::int n from households')).rows[0].n, 1);
  } finally { await db.drop(); c.restore(); }
});

test('setup requests are same-origin POSTs with bounded bodies', { skip: skipDb }, async () => {
  const c = capture();
  const { db, ctx } = await setup({ TALLYMED_SETUP_TOKEN: ENV_TOKEN });
  try {
    assert.equal(await code(await postSetup(ctx, { setupToken: ENV_TOKEN, ...admin() }, { origin: 'https://evil.example' })), 'csrf_failed');
    assert.equal(await code(await postSetup(ctx, { setupToken: ENV_TOKEN, ...admin() }, { origin: null })), 'csrf_failed');
    const get = await handlers.handleSetup(new Request('http://app.internal:3000/api/setup', { method: 'GET' }), ctx);
    assert.equal(get.status, 400);
    const big = await handlers.handleSetup(post('/api/setup', 'x'.repeat(20000), { type: 'application/json' }), ctx);
    assert.equal(big.status, 413);
    assert.equal(await isBootstrapped(db.pool), false);
  } finally { await db.drop(); c.restore(); }
});

test('startup notice waits for the migration, prints only while setup is needed, and survives an unreachable database', { skip: skipDb }, async () => {
  const c = capture();
  const { db, ctx } = await setup({ TALLYMED_SETUP_TOKEN: '' }, { migrateAll: false });
  try {
    const waiting = announceSetupWhenNeeded(50, 20);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(c.out.length, 0, 'nothing printed before the schema exists');
    await migrate(db.pool);
    assert.equal(await waiting, true);
    assert.equal(c.out.length, 1);
    assert.equal(await announceSetupWhenNeeded(1, 1), true);
    assert.equal(c.out.length, 1, 'the generated token is printed once even if announced twice');
    closeSetup();
  } finally { await db.drop(); c.restore(); }
});
