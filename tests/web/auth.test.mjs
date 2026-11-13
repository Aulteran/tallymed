import assert from 'node:assert/strict';
import test from 'node:test';
import * as handlers from '../../apps/web/server/http.ts';
import { csrfFor } from '../../apps/web/server/tokens.ts';
import { bootstrapAdmin, isBootstrapped } from '../../apps/web/server/services/bootstrap.ts';
import { authenticate } from '../../apps/web/server/services/auth.ts';
import {
  freshDatabase, loginJson, ORIGIN, PASSWORD, PROXY_SECRET, post, seedHousehold, skipDb, testConfig,
} from './helpers.mjs';

async function setup(overrides = {}) {
  const db = await freshDatabase();
  const config = testConfig(overrides, db.url);
  const ctx = { config, pool: db.pool };
  const ids = await seedHousehold(db.pool);
  return { db, ctx, config, ...ids };
}
const code = async (res) => (await res.clone().json()).error?.code;

test('bootstrap creates one administrator and closes permanently', { skip: skipDb }, async () => {
  const db = await freshDatabase();
  try {
    assert.equal(await isBootstrapped(db.pool), false);
    await assert.rejects(bootstrapAdmin(db.pool, { householdName: 'F', email: 'a@example.test', displayName: 'A', password: 'short' }), { code: 'invalid_input' });
    await assert.rejects(bootstrapAdmin(db.pool, { householdName: 'F', email: 'not-an-email', displayName: 'A', password: PASSWORD }), { code: 'invalid_input' });
    await seedHousehold(db.pool);
    assert.equal(await isBootstrapped(db.pool), true);
    await assert.rejects(seedHousehold(db.pool, { name: 'Other', email: 'other@example.test' }), { code: 'bootstrap_closed' });
    assert.equal((await db.pool.query('select count(*)::int n from households')).rows[0].n, 1);
    const stored = (await db.pool.query('select password_hash from users')).rows[0].password_hash;
    assert.match(stored, /^\$argon2id\$/);
    assert.ok(!stored.includes(PASSWORD));
  } finally {
    await db.drop();
  }
});

test('concurrent bootstrap attempts produce exactly one household', { skip: skipDb }, async () => {
  const db = await freshDatabase();
  try {
    const results = await Promise.allSettled([1, 2, 3, 4].map((i) =>
      seedHousehold(db.pool, { name: `F${i}`, email: `a${i}@example.test` })));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    for (const r of results.filter((r) => r.status === 'rejected')) assert.equal(r.reason.code, 'bootstrap_closed');
    assert.equal((await db.pool.query('select count(*)::int n from households')).rows[0].n, 1);
  } finally {
    await db.drop();
  }
});

test('login issues a hardened session cookie; sessions store only a digest', { skip: skipDb }, async () => {
  const { db, ctx } = await setup();
  try {
    const { res, cookie } = await loginJson(handlers, ctx, 'admin@example.test');
    assert.equal(res.status, 200);
    const set = res.headers.get('set-cookie');
    assert.match(set, /^__Host-tallymed_session=/);
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) assert.ok(set.includes(attr), attr);
    assert.ok(!set.includes('Domain'));
    const token = cookie.split('=')[1];
    const row = (await db.pool.query('select encode(token_hash, \'hex\') h from sessions')).rows[0];
    assert.notEqual(row.h, token);
    assert.equal((await db.pool.query(`select count(*)::int n from sessions where token_hash = $1`, [Buffer.from(token)])).rows[0].n, 0);
    // Loopback http development: no Secure attribute, no __Host- prefix.
    const dev = { ...ctx, config: testConfig({ TALLYMED_CANONICAL_ORIGIN: 'http://127.0.0.1:3001' }, db.url) };
    const devRes = await handlers.handleLogin(post('/api/auth/login', { email: 'admin@example.test', password: PASSWORD }, { type: 'json', origin: 'http://127.0.0.1:3001' }), dev);
    assert.match(devRes.headers.get('set-cookie'), /^tallymed_session=.*HttpOnly/);
    assert.ok(!devRes.headers.get('set-cookie').includes('Secure'));
  } finally {
    await db.drop();
  }
});

test('failed logins are generic, throttled per account and not bypassed by spoofed headers', { skip: skipDb }, async () => {
  const { db, ctx } = await setup();
  try {
    const bad = await loginJson(handlers, ctx, 'admin@example.test', 'wrong password!!');
    const unknown = await loginJson(handlers, ctx, 'nobody@example.test', 'wrong password!!');
    assert.equal(bad.res.status, 401);
    assert.deepEqual(await bad.res.clone().json(), await unknown.res.clone().json());
    for (let i = 0; i < 4; i++) {
      // Rotating spoofed forwarded addresses must not reset the account counter.
      await loginJson(handlers, ctx, 'admin@example.test', 'wrong password!!', { headers: { 'x-forwarded-for': `203.0.113.${i}` } });
    }
    const locked = await loginJson(handlers, ctx, 'admin@example.test', PASSWORD, { headers: { 'x-forwarded-for': '198.51.100.9' } });
    assert.equal(locked.res.status, 429);
    assert.ok(locked.res.headers.get('retry-after'));
    assert.equal(locked.cookie, null);
    // Other accounts are unaffected by an attacker's untrusted addresses.
    assert.equal((await loginJson(handlers, ctx, 'nobody@example.test')).res.status, 401);
    // Failed logins left audit rows without credentials or emails.
    const audit = (await db.pool.query(`select detail::text d from audit_events where action = 'auth.login_failed'`)).rows;
    assert.ok(audit.length >= 5 && audit.every((r) => r.d === '{}'));
  } finally {
    await db.drop();
  }
});

test('successful login clears account failures; per-IP throttle applies only to trusted client addresses', { skip: skipDb }, async () => {
  const { db, ctx } = await setup();
  try {
    for (let i = 0; i < 3; i++) await loginJson(handlers, ctx, 'admin@example.test', 'wrong password!!');
    assert.equal((await loginJson(handlers, ctx, 'admin@example.test')).res.status, 200);
    assert.equal((await db.pool.query(`select count(*)::int n from login_attempts where succeeded = false`)).rows[0].n, 0);
    const trusted = { 'x-tallymed-proxy-secret': PROXY_SECRET, 'x-forwarded-for': '10.9.9.9, 192.0.2.44', 'x-forwarded-proto': 'https' };
    for (let i = 0; i < 20; i++) await loginJson(handlers, ctx, `u${i}@example.test`, 'wrong password!!', { headers: trusted });
    const blocked = await loginJson(handlers, ctx, 'fresh@example.test', 'wrong password!!', { headers: trusted });
    assert.equal(blocked.res.status, 429);
    const ips = (await db.pool.query('select distinct client_ip from login_attempts where succeeded = false')).rows.map((r) => r.client_ip);
    assert.deepEqual(ips, ['192.0.2.44']);
  } finally {
    await db.drop();
  }
});

test('logout revokes the session; expired, idle and revoked sessions are rejected', { skip: skipDb }, async () => {
  const { db, ctx, config } = await setup();
  try {
    const { cookie, csrf } = await loginJson(handlers, ctx, 'admin@example.test');
    const token = cookie.split('=')[1];
    assert.ok(await authenticate(db.pool, config, token));
    const out = await handlers.handleLogout(post('/api/auth/logout', {}, { type: 'json', cookie, headers: { 'x-csrf-token': csrf } }), ctx);
    assert.equal(out.status, 200);
    assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal(await authenticate(db.pool, config, token), null);
    assert.equal((await db.pool.query('select revoked_reason r from sessions')).rows[0].r, 'logout');
    // Replaying the revoked cookie fails on a protected route.
    const replay = await handlers.handleLogout(post('/api/auth/logout', {}, { type: 'json', cookie, headers: { 'x-csrf-token': csrf } }), ctx);
    assert.equal(replay.status, 401);

    const a = await loginJson(handlers, ctx, 'admin@example.test');
    await db.pool.query(`update sessions set expires_at = now() - interval '1 second' where revoked_at is null`);
    assert.equal(await authenticate(db.pool, config, a.cookie.split('=')[1]), null);

    const b = await loginJson(handlers, ctx, 'admin@example.test');
    await db.pool.query(`update sessions set last_seen_at = now() - interval '3 hours' where revoked_at is null and expires_at > now()`);
    assert.equal(await authenticate(db.pool, config, b.cookie.split('=')[1]), null);
    assert.equal(await authenticate(db.pool, config, 'x'.repeat(43)), null);
    assert.equal(await authenticate(db.pool, config, null), null);
  } finally {
    await db.drop();
  }
});

test('login rotates: a presented prior session is revoked and tokens are unique', { skip: skipDb }, async () => {
  const { db, ctx, config } = await setup();
  try {
    const first = await loginJson(handlers, ctx, 'admin@example.test');
    const second = await loginJson(handlers, ctx, 'admin@example.test', PASSWORD, { cookie: first.cookie });
    assert.notEqual(first.cookie, second.cookie);
    assert.equal(await authenticate(db.pool, config, first.cookie.split('=')[1]), null);
    assert.ok(await authenticate(db.pool, config, second.cookie.split('=')[1]));
    // A client-chosen session cookie is never adopted.
    const fixed = `__Host-tallymed_session=${'A'.repeat(43)}`;
    const third = await loginJson(handlers, ctx, 'admin@example.test', PASSWORD, { cookie: fixed });
    assert.notEqual(third.cookie, fixed);
  } finally {
    await db.drop();
  }
});

test('CSRF and origin validation on state changes', { skip: skipDb }, async () => {
  const { db, ctx } = await setup();
  try {
    const { cookie, csrf } = await loginJson(handlers, ctx, 'admin@example.test');
    const attempt = (opts) => handlers.handleInvite(post('/api/operators/invite', { email: 'op@example.test', role: 'operator' }, { type: 'json', cookie, ...opts }), ctx);
    const goodHeaders = { 'x-csrf-token': csrf };
    assert.equal(await code(await attempt({ headers: {} })), 'csrf_failed'); // no token
    assert.equal(await code(await attempt({ headers: { 'x-csrf-token': csrfFor('A'.repeat(43)) } })), 'csrf_failed'); // wrong token
    assert.equal(await code(await attempt({ headers: goodHeaders, origin: 'https://evil.example' })), 'csrf_failed');
    assert.equal(await code(await attempt({ headers: goodHeaders, origin: null })), 'csrf_failed'); // missing Origin and Referer
    assert.equal(await code(await attempt({ headers: goodHeaders, origin: 'null' })), 'csrf_failed');
    assert.equal(await code(await attempt({ headers: { ...goodHeaders, 'sec-fetch-site': 'cross-site' } })), 'csrf_failed');
    assert.equal(await code(await attempt({ headers: { ...goodHeaders, 'sec-fetch-site': 'same-site' } })), 'csrf_failed');
    // Referer fallback from the canonical origin is accepted; foreign Referer is not.
    assert.equal((await attempt({ headers: { ...goodHeaders, referer: `${ORIGIN}/operators` }, origin: null })).status, 201);
    assert.equal(await code(await handlers.handleInvite(post('/api/operators/invite', { email: 'z@example.test', role: 'operator' }, { type: 'json', cookie, origin: null, headers: { ...goodHeaders, referer: 'https://evil.example/x' } }), ctx)), 'csrf_failed');
    // Cross-origin login attempts (login CSRF) are rejected too.
    const login = await handlers.handleLogin(post('/api/auth/login', { email: 'admin@example.test', password: PASSWORD }, { type: 'json', origin: 'https://evil.example' }), ctx);
    assert.equal(login.status, 403);
    assert.equal(login.headers.get('set-cookie'), null);
    // CSRF from form field works for HTML forms.
    const form = await handlers.handleLogout(post('/api/auth/logout', { csrf }, { cookie, html: true }), ctx);
    assert.equal(form.status, 303);
    assert.equal(form.headers.get('location'), `${ORIGIN}/login`);
    // No session -> unauthenticated, regardless of token.
    assert.equal((await handlers.handleLogout(post('/api/auth/logout', {}, { type: 'json', headers: { 'x-csrf-token': csrf } }), ctx)).status, 401);
    // Only POST is accepted.
    const get = await handlers.handleLogout(new Request('http://app.internal/api/auth/logout', { method: 'GET' }), ctx);
    assert.equal(get.status, 400);
  } finally {
    await db.drop();
  }
});

test('malicious forwarded headers cannot change origin, redirects, cookies or throttle identity', { skip: skipDb }, async () => {
  const { db, ctx } = await setup();
  try {
    const evil = { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http', 'x-forwarded-for': '1.2.3.4', host: 'evil.example', forwarded: 'for=1.2.3.4;host=evil.example;proto=http' };
    // Untrusted client: forwarded headers are ignored; behavior and redirects stay canonical.
    const res = await handlers.handleLogin(post('/api/auth/login', { email: 'admin@example.test', password: PASSWORD }, { html: true, headers: evil }), ctx);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), `${ORIGIN}/`);
    assert.match(res.headers.get('set-cookie'), /Secure/);
    // An evil Origin matching the forged host is still rejected.
    const forged = await handlers.handleLogin(post('/api/auth/login', { email: 'admin@example.test', password: PASSWORD }, { origin: 'https://evil.example', headers: evil }), ctx);
    assert.equal(forged.status, 403);
    // A wrong proxy secret is the same as none.
    const wrong = await handlers.handleLogin(post('/api/auth/login', { email: 'x@example.test', password: 'wrong password!!' }, { headers: { ...evil, 'x-tallymed-proxy-secret': 'z'.repeat(40) } }), ctx);
    assert.equal(wrong.status, 401);
    assert.deepEqual((await db.pool.query('select distinct client_ip from login_attempts')).rows.map((r) => r.client_ip), ['untrusted']);
    // Without a configured secret, even a "correct-looking" header is ignored.
    const none = { ...ctx, config: testConfig({ TALLYMED_PROXY_SECRET: '' }, db.url) };
    await handlers.handleLogin(post('/api/auth/login', { email: 'y@example.test', password: 'wrong password!!' }, { headers: { 'x-tallymed-proxy-secret': PROXY_SECRET, 'x-forwarded-for': '9.9.9.9' } }), none);
    assert.ok(!(await db.pool.query(`select 1 from login_attempts where client_ip = '9.9.9.9'`)).rowCount);
    // A trusted proxy reporting plain http for an https canonical origin is refused.
    const insecure = await handlers.handleLogin(post('/api/auth/login', { email: 'admin@example.test', password: PASSWORD }, { headers: { 'x-tallymed-proxy-secret': PROXY_SECRET, 'x-forwarded-proto': 'http' } }), ctx);
    assert.equal(insecure.status, 403);
    // Malformed forwarded address from the trusted proxy is dropped, not stored.
    await handlers.handleLogin(post('/api/auth/login', { email: 'q@example.test', password: 'wrong password!!' }, { headers: { 'x-tallymed-proxy-secret': PROXY_SECRET, 'x-forwarded-for': "'; drop table users;--" } }), ctx);
    assert.equal((await db.pool.query(`select 1 from login_attempts where client_ip like '%drop%'`)).rowCount, 0);
  } finally {
    await db.drop();
  }
});

test('request bodies are bounded, typed and strictly validated', { skip: skipDb }, async () => {
  const { db, ctx } = await setup();
  try {
    const big = await handlers.handleLogin(post('/api/auth/login', { email: 'a@example.test', password: 'x'.repeat(20_000) }, { type: 'json' }), ctx);
    assert.equal(big.status, 413);
    const streamed = new Request('http://app.internal/api/auth/login', {
      method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"a":"' + 'x'.repeat(9000) + '"}')); c.close(); } }), duplex: 'half',
    });
    assert.equal((await handlers.handleLogin(streamed, ctx)).status, 413);
    assert.equal((await handlers.handleLogin(post('/api/auth/login', 'email=a', { type: 'text/plain' }), ctx)).status, 415);
    assert.equal((await handlers.handleLogin(post('/api/auth/login', '{bad', { type: 'application/json' }), ctx)).status, 400);
    assert.equal((await handlers.handleLogin(post('/api/auth/login', '[1]', { type: 'application/json' }), ctx)).status, 400);
    assert.equal((await handlers.handleLogin(post('/api/auth/login', { email: 'admin@example.test', password: PASSWORD, extra: 'x' }, { type: 'json' }), ctx)).status, 400);
    assert.equal((await handlers.handleLogin(post('/api/auth/login', 'email=a%40example.test&email=b%40example.test&password=x', { type: 'application/x-www-form-urlencoded' }), ctx)).status, 400);
    assert.equal((await handlers.handleLogin(post('/api/auth/login', { email: 'x'.repeat(300), password: 'p' }, { type: 'json' }), ctx)).status, 400);
    const err = await handlers.handleLogin(post('/api/auth/login', { email: 'bad', password: 'p' }, { type: 'json' }), ctx);
    assert.deepEqual(Object.keys((await err.json()).error).sort(), ['code', 'message']);
  } finally {
    await db.drop();
  }
});

test('authorization: operators cannot manage accounts; invitations are single-use and household scoped', { skip: skipDb }, async () => {
  const { db, ctx, householdId } = await setup();
  try {
    const admin = await loginJson(handlers, ctx, 'admin@example.test');
    const invite = await handlers.handleInvite(post('/api/operators/invite', { email: 'Sam@Example.test', role: 'operator' }, { type: 'json', cookie: admin.cookie, headers: { 'x-csrf-token': admin.csrf } }), ctx);
    assert.equal(invite.status, 201);
    const { link } = await invite.json();
    assert.ok(link.startsWith(`${ORIGIN}/invite/`));
    const token = link.split('/').pop();
    const stored = (await db.pool.query(`select encode(token_hash,'hex') h, email from invitations`)).rows[0];
    assert.notEqual(stored.h, token);
    assert.equal(stored.email, 'sam@example.test');
    // Duplicate open invitation conflicts.
    const dup = await handlers.handleInvite(post('/api/operators/invite', { email: 'sam@example.test', role: 'operator' }, { type: 'json', cookie: admin.cookie, headers: { 'x-csrf-token': admin.csrf } }), ctx);
    assert.equal(dup.status, 409);
    // Accept; weak password rejected without consuming the invitation.
    const weak = await handlers.handleAcceptInvitation(post('/api/invitations/accept', { token, displayName: 'Sam Example', password: 'short' }, { type: 'json' }), ctx);
    assert.equal(weak.status, 400);
    const ok = await handlers.handleAcceptInvitation(post('/api/invitations/accept', { token, displayName: 'Sam Example', password: PASSWORD }, { type: 'json' }), ctx);
    assert.equal(ok.status, 201);
    const again = await handlers.handleAcceptInvitation(post('/api/invitations/accept', { token, displayName: 'Mallory', password: PASSWORD }, { type: 'json' }), ctx);
    assert.equal(again.status, 404);
    assert.equal((await handlers.handleAcceptInvitation(post('/api/invitations/accept', { token: 'A'.repeat(43), displayName: 'X', password: PASSWORD }, { type: 'json' }), ctx)).status, 404);

    const sam = await loginJson(handlers, ctx, 'sam@example.test');
    assert.equal(sam.res.status, 200);
    const samHeaders = { 'x-csrf-token': sam.csrf };
    assert.equal((await handlers.handleInvite(post('/api/operators/invite', { email: 'x@example.test', role: 'admin' }, { type: 'json', cookie: sam.cookie, headers: samHeaders }), ctx)).status, 403);
    const samId = (await db.pool.query(`select id, version from users where email = 'sam@example.test'`)).rows[0];
    assert.equal((await handlers.handleUpdateOperator(post('/api/operators/update', { userId: samId.id, version: samId.version, role: 'admin', status: 'active' }, { type: 'json', cookie: sam.cookie, headers: samHeaders }), ctx)).status, 403);

    // Expired invitations are refused.
    const inv2 = await handlers.handleInvite(post('/api/operators/invite', { email: 'late@example.test', role: 'operator' }, { type: 'json', cookie: admin.cookie, headers: { 'x-csrf-token': admin.csrf } }), ctx);
    const t2 = (await inv2.json()).link.split('/').pop();
    await db.pool.query(`update invitations set expires_at = now() - interval '1 minute' where lower(email) = 'late@example.test'`);
    assert.equal((await handlers.handleAcceptInvitation(post('/api/invitations/accept', { token: t2, displayName: 'L', password: PASSWORD }, { type: 'json' }), ctx)).status, 404);

    // A user from another household is invisible and untouchable by this household's admin.
    const h2 = (await db.pool.query(`insert into households (name) values ('Other Family') returning id`)).rows[0].id;
    const foreign = (await db.pool.query(`insert into users (household_id, email, display_name, role, password_hash) values ($1, 'f@example.test', 'Fay Foreign', 'operator', 'x') returning id, version`, [h2])).rows[0];
    const cross = await handlers.handleUpdateOperator(post('/api/operators/update', { userId: foreign.id, version: foreign.version, role: 'admin', status: 'active' }, { type: 'json', cookie: admin.cookie, headers: { 'x-csrf-token': admin.csrf } }), ctx);
    assert.equal(cross.status, 404);
    assert.equal((await db.pool.query(`select role from users where id = $1`, [foreign.id])).rows[0].role, 'operator');
    const { listOperators } = await import('../../apps/web/server/services/operators.ts');
    const { authenticate: auth } = await import('../../apps/web/server/services/auth.ts');
    const actor = await auth(db.pool, ctx.config, admin.cookie.split('=')[1]);
    assert.equal(actor.householdId, householdId);
    assert.ok((await listOperators(db.pool, actor)).every((u) => u.householdId === householdId));
    const audit = (await db.pool.query(`select action from audit_events where household_id = $1 order by id`, [householdId])).rows.map((r) => r.action);
    assert.ok(['bootstrap.completed', 'operator.invited', 'operator.accepted_invitation', 'auth.login'].every((a) => audit.includes(a)));
  } finally {
    await db.drop();
  }
});

test('privilege changes revoke sessions, respect versions and keep one admin', { skip: skipDb }, async () => {
  const { db, ctx, config, adminUserId } = await setup();
  try {
    const admin = await loginJson(handlers, ctx, 'admin@example.test');
    const h = { 'x-csrf-token': admin.csrf };
    const adminToken = admin.cookie.split('=')[1];
    const invite = await handlers.handleInvite(post('/api/operators/invite', { email: 'sam@example.test', role: 'operator' }, { type: 'json', cookie: admin.cookie, headers: h }), ctx);
    await handlers.handleAcceptInvitation(post('/api/invitations/accept', { token: (await invite.json()).link.split('/').pop(), displayName: 'Sam', password: PASSWORD }, { type: 'json' }), ctx);
    const sam = await loginJson(handlers, ctx, 'sam@example.test');
    const row = (await db.pool.query(`select id, version from users where email = 'sam@example.test'`)).rows[0];
    const update = (body, cookie = admin.cookie) => handlers.handleUpdateOperator(post('/api/operators/update', body, { type: 'json', cookie, headers: h }), ctx);
    assert.equal((await update({ userId: row.id, version: row.version + 5, role: 'admin', status: 'active' })).status, 409);
    assert.equal(await code(await update({ userId: row.id, version: row.version + 5, role: 'admin', status: 'active' })), 'stale_version');
    assert.ok(await authenticate(db.pool, config, sam.cookie.split('=')[1]));
    assert.equal((await update({ userId: row.id, version: row.version, role: 'admin', status: 'active' })).status, 200);
    assert.equal(await authenticate(db.pool, config, sam.cookie.split('=')[1]), null, 'role change revokes target sessions');
    // Stale version on replay.
    assert.equal(await code(await update({ userId: row.id, version: row.version, role: 'operator', status: 'active' })), 'stale_version');
    // Disabled users cannot sign in.
    const sam2 = (await db.pool.query(`select version from users where id = $1`, [row.id])).rows[0];
    assert.equal((await update({ userId: row.id, version: sam2.version, role: 'admin', status: 'disabled' })).status, 200);
    assert.equal((await loginJson(handlers, ctx, 'sam@example.test')).res.status, 401);
    // The last active administrator cannot be removed or disabled.
    const self = (await db.pool.query(`select version from users where id = $1`, [adminUserId])).rows[0];
    const last = await update({ userId: adminUserId, version: self.version, role: 'operator', status: 'active' });
    assert.equal(await code(last), 'conflict');
    assert.ok(await authenticate(db.pool, config, adminToken));
  } finally {
    await db.drop();
  }
});

test('internal errors never leak details', { skip: skipDb }, async () => {
  const { db, ctx } = await setup();
  const broken = { ...ctx, pool: { query: async () => { throw new Error('connection to secret-host failed password=hunter2'); } } };
  const lines = [];
  const { setLogSink } = await import('../../apps/web/server/log.ts');
  setLogSink((l) => lines.push(l));
  try {
    const res = await handlers.handleLogin(post('/api/auth/login', { email: 'admin@example.test', password: PASSWORD }, { type: 'json' }), broken);
    assert.equal(res.status, 500);
    const text = await res.text();
    assert.ok(!text.includes('secret-host') && !text.includes('hunter2'));
    assert.ok(!lines.join('\n').includes('hunter2') && !lines.join('\n').includes(PASSWORD));
  } finally {
    setLogSink((l) => process.stderr.write(l + '\n'));
    await db.drop();
  }
});
