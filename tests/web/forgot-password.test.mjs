// "Forgot password" by email: no account enumeration, limits, audit, no lockout or takeover by a stranger's request, and the
// emailed temporary password reusing the forced-change mechanism. A fake local mail server records the messages. Synthetic data only.
import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { resetEmailLimiterForTests } from '../../apps/web/server/email.ts';
import * as handlers from '../../apps/web/server/http.ts';
import { setLogSink } from '../../apps/web/server/log.ts';
import { hashPassword } from '../../apps/web/server/passwords.ts';
import { insertUser } from '../../apps/web/server/repositories/users.ts';
import { resetForgotPasswordLimiterForTests } from '../../apps/web/server/services/forgot-password.ts';
import {
  freshDatabase, loginJson, PASSWORD, post, PROXY_SECRET, seedHousehold, skipDb, testConfig,
} from './helpers.mjs';

const SAM = 'sam@example.test';
const SAM_PASSWORD = 'operator pass phrase 2026';
const NEW_PASSWORD = 'a brand new passphrase 7';
const TEMP = /[A-HJKMNP-Z2-9]{5}(?:-[A-HJKMNP-Z2-9]{5}){3}/;
const code = async (res) => (await res.clone().json().catch(() => ({}))).error?.code;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(25);
  }
}

/** A minimal SMTP server that records envelopes. Plain text only. */
function fakeSmtp() {
  const mail = []; const sockets = new Set();
  const server = net.createServer((s) => {
    let cur = null;
    sockets.add(s); s.on('close', () => sockets.delete(s));
    s.write('220 fake.test ESMTP\r\n'); let buf = ''; let data = null;
    s.on('data', (d) => {
      buf += d.toString('latin1');
      for (;;) {
        if (data !== null) { const i = buf.indexOf('\r\n.\r\n'); if (i < 0) return; cur.data = data + buf.slice(0, i); buf = buf.slice(i + 5); data = null; mail.push(cur); cur = null; s.write('250 queued\r\n'); continue; }
        const i = buf.indexOf('\r\n'); if (i < 0) return; const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (/^EHLO/i.test(line)) s.write('250-fake.test\r\n250 8BITMIME\r\n');
        else if (/^MAIL FROM/i.test(line)) { cur = { from: line, to: [] }; s.write('250 ok\r\n'); }
        else if (/^RCPT TO/i.test(line)) { cur.to.push(line); s.write('250 ok\r\n'); }
        else if (/^DATA/i.test(line)) { data = ''; s.write('354 go\r\n'); }
        else if (/^QUIT/i.test(line)) { s.end('221 bye\r\n'); return; } else s.write('250 ok\r\n');
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ mail, port: server.address().port, close: () => { for (const s of sockets) s.destroy(); server.close(); } })));
}

async function setup({ smtp = true, port } = {}) {
  const db = await freshDatabase();
  const config = testConfig({}, db.url);
  const ctx = { config, pool: db.pool };
  const ids = await seedHousehold(db.pool);
  const server = smtp ? await fakeSmtp() : null;
  if (smtp) {
    await db.pool.query(
      `insert into server_settings (group_key, value) values ('email', $1::jsonb)`,
      [JSON.stringify({ host: '127.0.0.1', port: port ?? server.port, security: 'none', fromAddress: 'tallymed@example.test', fromName: 'TallyMed', allowRestrictedTargets: true })],
    );
  }
  const add = async (email, role = 'operator', password = SAM_PASSWORD) =>
    insertUser(db.pool, { householdId: ids.householdId, email, displayName: email.split('@')[0], role, passwordHash: await hashPassword(password) });
  await add(SAM);
  resetEmailLimiterForTests(); resetForgotPasswordLimiterForTests();
  const forgot = (email, extra = {}) => handlers.handleForgotPassword(post('/api/auth/forgot-password', { email }, { type: 'json', ...extra }), ctx);
  const login = (email, password, extra) => loginJson(handlers, ctx, email, password, extra);
  const q = async (sql, args = []) => (await db.pool.query(sql, args)).rows;
  const audit = async (like) => q(`select action, detail from audit_events where action like $1 order by id`, [like]);
  const close = async () => { server?.close(); await db.drop(); };
  return { db, ctx, config, ids, server, add, forgot, login, q, audit, close };
}

const logsOf = async (fn) => {
  const lines = [];
  setLogSink((l) => lines.push(l));
  try { return { result: await fn(), lines }; } finally { setLogSink((l) => process.stderr.write(l + '\n')); }
};

test('without SMTP the request is refused with a pointer to the administrator and records nothing', { skip: skipDb }, async () => {
  const t = await setup({ smtp: false });
  try {
    const res = await t.forgot(SAM);
    assert.equal(res.status, 409);
    assert.equal(await code(res), 'email_not_configured');
    assert.equal((await t.q('select count(*)::int n from password_reset_requests'))[0].n, 0);
    assert.equal((await t.q('select count(*)::int n from password_resets'))[0].n, 0);
    // The browser form post goes back to the page with the explanation.
    const html = await handlers.handleForgotPassword(post('/api/auth/forgot-password', { email: SAM }, { html: true }), t.ctx);
    assert.equal(html.status, 303);
    assert.match(html.headers.get('location'), /\/password\/forgot\?error=email_not_configured$/);
  } finally { await t.close(); }
});

test('same response for a known, unknown, disabled and malformed-case address; mail only to the account address', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    await t.add('off@example.test');
    await t.q(`update users set status = 'disabled' where email = 'off@example.test'`);
    const bodies = [];
    for (const e of [SAM, 'nobody@example.test', 'off@example.test', 'SAM@Example.Test']) {
      const res = await t.forgot(e);
      assert.equal(res.status, 200, e);
      bodies.push(await res.text());
    }
    assert.ok(bodies.every((b) => b === bodies[0]), 'identical bodies');
    // Browser form posts get one identical redirect too.
    const loc = [];
    for (const e of ['sam@example.test', 'ghost@example.test']) loc.push((await handlers.handleForgotPassword(post('/api/auth/forgot-password', { email: e }, { html: true }), t.ctx)).headers.get('location'));
    assert.equal(loc[0], loc[1]);
    assert.match(loc[0], /\/password\/forgot\?notice=sent$/);
    await until(() => t.server.mail.length >= 1);
    await sleep(300);
    assert.equal(t.server.mail.length, 1, 'only the active, known account gets mail (the second request is inside the gap)');
    assert.deepEqual(t.server.mail[0].to, ['RCPT TO:<sam@example.test>']);
    assert.match(t.server.mail[0].data, /Subject: Your TallyMed temporary password/);
    assert.match(t.server.mail[0].data, TEMP);
    assert.ok(!/https?:\/\//.test(t.server.mail[0].data), 'no link to poison');
    // Malformed input is a format error that says nothing about accounts.
    assert.equal((await t.forgot('not an address')).status, 400);
    assert.equal((await t.forgot('a@b.test\r\nBcc: x@y.test')).status, 400);
    assert.equal((await t.q('select count(*)::int n from password_resets'))[0].n, 1);
  } finally { await t.close(); }
});

test('a request cannot lock out or take over the account: password, sessions and lockout counters are untouched', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const sam = await t.login(SAM, SAM_PASSWORD);
    assert.equal(sam.res.status, 200);
    const before = (await t.q(`select password_hash, must_change_password, version from users where email = $1`, [SAM]))[0];
    const attemptsBefore = (await t.q('select count(*)::int n from login_attempts'))[0].n;
    assert.equal((await t.forgot(SAM)).status, 200);
    await until(() => t.server.mail.length === 1);
    const after = (await t.q(`select password_hash, must_change_password, version from users where email = $1`, [SAM]))[0];
    assert.deepEqual(after, before);
    assert.equal((await t.q('select count(*)::int n from login_attempts'))[0].n, attemptsBefore, 'sign-in throttle untouched');
    // The old password and the existing session still work.
    const again = await t.login(SAM, SAM_PASSWORD);
    assert.equal(again.res.status, 200);
    assert.equal(again.data.passwordChangeRequired, undefined);
    assert.equal((await handlers.handleLogout(post('/api/auth/logout', {}, { type: 'json', cookie: sam.cookie, headers: { 'x-csrf-token': sam.csrf } }), t.ctx)).status, 200);
    // Hammering requests cannot lock sign-in either, even from the limits' point of view.
    for (let i = 0; i < 12; i++) await t.forgot(SAM);
    assert.equal((await t.login(SAM, SAM_PASSWORD)).res.status, 200);
    assert.equal((await t.q(`select count(*)::int n from password_resets where kind = 'email_temporary'`))[0].n, 1, 'one credential: the rest were refused by the gap');
  } finally { await t.close(); }
});

test('the emailed secret is hashed at rest, never logged or audited, and audit rows exist for request and delivery', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const { lines } = await logsOf(async () => { await t.forgot(SAM); await until(() => t.server.mail.length === 1); await until(async () => (await t.audit('auth.password_reset_email_sent')).length === 1); });
    const temp = t.server.mail[0].data.match(TEMP)[0];
    const row = (await t.q(`select kind, status, secret_hash, issued_by from password_resets`))[0];
    assert.equal(row.kind, 'email_temporary');
    assert.equal(row.status, 'open');
    assert.equal(row.issued_by, null);
    assert.match(row.secret_hash, /^\$argon2id\$/);
    const dump = JSON.stringify([await t.q('select * from audit_events'), await t.q('select * from login_attempts'), await t.q('select * from password_reset_requests'), await t.q('select * from sessions'), lines]);
    assert.ok(!dump.includes(temp), 'secret appears nowhere but the email');
    assert.ok(!dump.includes(SAM), 'address appears in no audit, request log or log line');
    assert.equal((await t.audit('auth.password_reset_requested')).length, 1);
    assert.equal((await t.audit('auth.password_reset_email_sent')).length, 1);
  } finally { await t.close(); }
});

test('signing in with the emailed password forces a change, ends other sessions, and works once', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const old = await t.login(SAM, SAM_PASSWORD);
    await t.forgot(SAM);
    await until(() => t.server.mail.length === 1);
    const temp = t.server.mail[0].data.match(TEMP)[0];
    const sam = await t.login(SAM, temp);
    assert.equal(sam.res.status, 200);
    assert.equal(sam.data.passwordChangeRequired, true);
    assert.equal((await t.audit('auth.temporary_password_used')).length, 1);
    // The earlier session is gone, the old password no longer works, and the restricted session reaches only the change page.
    assert.equal((await handlers.handleExpenseAction(post('/api/expenses/members/create', { name: 'X' }, { type: 'json', cookie: old.cookie, headers: { 'x-csrf-token': old.csrf } }), t.ctx, 'members/create')).status, 401);
    assert.equal((await t.login(SAM, SAM_PASSWORD)).res.status, 401);
    const gated = await handlers.handleExpenseAction(post('/api/expenses/members/create', { name: 'X' }, { type: 'json', cookie: sam.cookie, headers: { 'x-csrf-token': sam.csrf } }), t.ctx, 'members/create');
    assert.equal(await code(gated), 'password_change_required');
    const change = await handlers.handleChangePassword(post('/api/auth/change-password', { newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD, page: 'required' }, { type: 'json', cookie: sam.cookie, headers: { 'x-csrf-token': sam.csrf } }), t.ctx);
    assert.equal(change.status, 200);
    assert.equal((await t.q(`select status from password_resets`))[0].status, 'completed');
    // Used up: it is no longer a password, and the new one works.
    assert.equal((await t.login(SAM, temp)).res.status, 401);
    const fresh = await t.login(SAM, NEW_PASSWORD);
    assert.equal(fresh.res.status, 200);
    assert.equal(fresh.data.passwordChangeRequired, undefined);
  } finally { await t.close(); }
});

test('signing in with the real password cancels a pending emailed credential; an expired one never works', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    await t.forgot(SAM);
    await until(() => t.server.mail.length === 1);
    const temp = t.server.mail[0].data.match(TEMP)[0];
    assert.equal((await t.login(SAM, SAM_PASSWORD)).res.status, 200);
    assert.equal((await t.q(`select status from password_resets`))[0].status, 'superseded');
    assert.equal((await t.audit('auth.password_reset_cancelled')).length, 1);
    assert.equal((await t.login(SAM, temp)).res.status, 401);
    // Expiry: a fresh credential past its time is refused with the generic error.
    await t.q(`update password_resets set created_at = now() - interval '3 hours'`);
    await t.q(`delete from password_reset_requests`);
    await t.forgot(SAM);
    await until(() => t.server.mail.length === 2);
    const second = t.server.mail[1].data.match(TEMP)[0];
    await t.q(`update password_resets set expires_at = now() + interval '1 second', created_at = now() - interval '1 hour' where status = 'open'`);
    await sleep(1200);
    assert.equal((await t.login(SAM, second)).res.status, 401);
    assert.equal((await t.login(SAM, SAM_PASSWORD)).res.status, 200);
  } finally { await t.close(); }
});

test('per-account gap and daily cap: extra requests look identical but send nothing', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const bodies = [];
    for (let i = 0; i < 3; i++) bodies.push(await (await t.forgot(SAM)).text());
    await until(() => t.server.mail.length === 1);
    await sleep(300);
    assert.equal(t.server.mail.length, 1, 'second and third are inside the ten minute gap');
    assert.ok(bodies.every((b) => b === bodies[0]));
    // Age the credentials past the gap: the daily cap of three still holds.
    for (let n = 2; n <= 5; n++) {
      await t.q(`update password_resets set created_at = now() - interval '11 minutes'`);
      await t.q('delete from password_reset_requests');
      assert.equal((await t.forgot(SAM)).status, 200);
      await sleep(250);
      assert.equal(t.server.mail.length, Math.min(n, 3), `after request ${n}`);
    }
    assert.equal((await t.audit('auth.password_reset_limited')).length, 1, 'the cap is audited once, not per refused request');
    // After a day the allowance returns.
    await t.q(`update password_resets set created_at = now() - interval '25 hours', expires_at = now() - interval '24 hours'`);
    await t.q('delete from password_reset_requests');
    await t.forgot(SAM);
    await until(() => t.server.mail.length === 4);
  } finally { await t.close(); }
});

test('per-address and per-client limits do not depend on whether the account exists', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    // Per submitted address: five an hour, then the same generic answer with nothing recorded.
    const statuses = [];
    for (let i = 0; i < 8; i++) statuses.push((await t.forgot('ghost@example.test')).status);
    assert.deepEqual(statuses, Array(8).fill(200));
    assert.equal((await t.q('select count(*)::int n from password_reset_requests'))[0].n, 5, 'refused requests are not recorded, so the window cannot be stretched');
    // Per client address (a trusted proxy supplies it): ten an hour across different addresses, then 429, for any address.
    const via = (ip) => ({ headers: { 'x-tallymed-proxy-secret': PROXY_SECRET, 'x-forwarded-for': ip, 'x-forwarded-proto': 'https' } });
    for (let i = 0; i < 10; i++) assert.equal((await t.forgot(`u${i}@example.test`, via('203.0.113.7'))).status, 200);
    for (const e of ['u11@example.test', SAM]) {
      const res = await t.forgot(e, via('203.0.113.7'));
      assert.equal(res.status, 429, e);
      assert.equal(await code(res), 'rate_limited');
    }
    assert.equal((await t.forgot(SAM, via('203.0.113.8'))).status, 200, 'another client is unaffected');
    // Requests never touch the sign-in throttle, so they cannot lock anyone out.
    assert.equal((await t.q('select count(*)::int n from login_attempts'))[0].n, 0);
  } finally { await t.close(); }
});

test('reset mail has its own process budget below the shared email cap', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    for (let i = 0; i < 24; i++) await t.add(`user${i}@example.test`);
    for (let i = 0; i < 24; i++) assert.equal((await t.forgot(`user${i}@example.test`, { headers: { 'x-tallymed-proxy-secret': PROXY_SECRET, 'x-forwarded-for': `198.51.100.${i + 1}`, 'x-forwarded-proto': 'https' } })).status, 200);
    await until(() => t.server.mail.length === 20);
    await sleep(500);
    assert.equal(t.server.mail.length, 20);
    assert.equal((await t.q('select count(*)::int n from password_resets'))[0].n, 20, 'over-budget requests create no credential');
  } finally { await t.close(); }
});

test('an administrator-issued or already-used temporary credential is never replaced by a request', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const admin = await t.login('admin@example.test', PASSWORD);
    const id = (await t.q('select id, version from users where email = $1', [SAM]))[0];
    const reset = await handlers.handleResetPassword(post('/api/operators/reset-password', { userId: id.id, version: id.version }, { type: 'json', cookie: admin.cookie, headers: { 'x-csrf-token': admin.csrf } }), t.ctx);
    const { temporaryPassword } = await reset.json();
    assert.equal((await t.forgot(SAM)).status, 200);
    await sleep(400);
    assert.equal(t.server.mail.length, 0);
    assert.equal((await t.q(`select count(*)::int n from password_resets where kind = 'email_temporary'`))[0].n, 0);
    assert.equal((await t.login(SAM, temporaryPassword)).data.passwordChangeRequired, true);
  } finally { await t.close(); }
});

test('delivery failure is invisible to the requester, retires the credential, is audited by category and still counts', { skip: skipDb }, async () => {
  const t = await setup({ port: 1 }); // nothing listens: connection refused
  try {
    const res = await t.forgot(SAM);
    assert.equal(res.status, 200);
    await until(async () => (await t.audit('auth.password_reset_email_failed')).length === 1);
    assert.deepEqual((await t.audit('auth.password_reset_email_failed'))[0].detail, { reason: 'connect_failed' });
    assert.equal((await t.q('select status from password_resets'))[0].status, 'superseded');
    assert.equal((await t.login(SAM, SAM_PASSWORD)).res.status, 200);
    // Repeating immediately is inside the account gap, so a failing relay is not hammered.
    await t.forgot(SAM);
    await sleep(300);
    assert.equal((await t.q('select count(*)::int n from password_resets'))[0].n, 1);
  } finally { await t.close(); }
});

test('the endpoint is origin protected, JSON and form capable, and needs no session', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    assert.equal((await t.forgot(SAM, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await t.forgot(SAM, { origin: null })).status, 403);
    assert.equal((await handlers.handleForgotPassword(post('/api/auth/forgot-password', { email: SAM, extra: 'x' }, { type: 'json' }), t.ctx)).status, 400);
    assert.equal((await handlers.handleForgotPassword(post('/api/auth/forgot-password', { email: SAM }, { type: 'form' }), t.ctx)).status, 200);
    assert.equal((await t.q('select count(*)::int n from password_reset_requests'))[0].n, 1, 'forged-origin and malformed requests are not counted');
  } finally { await t.close(); }
});

test('an abandoned emailed reset can be recovered from: once it expires a new request issues a new credential', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    await t.forgot(SAM);
    await until(() => t.server.mail.length === 1);
    const first = t.server.mail[0].data.match(TEMP)[0];
    const restricted = await t.login(SAM, first);
    assert.equal(restricted.data.passwordChangeRequired, true);
    // While the used credential is still live a request changes nothing, even after the gap (nobody can displace it).
    await t.q(`update password_resets set created_at = now() - interval '11 minutes'`);
    await t.q('delete from password_reset_requests');
    await t.forgot(SAM);
    await sleep(300);
    assert.equal(t.server.mail.length, 1);
    // The person walks away: the session ends and the credential expires. Both the old password and the first temporary one are dead.
    await t.q(`update sessions set revoked_at = now() where revoked_at is null`);
    await t.q(`update password_resets set expires_at = now() - interval '1 second', created_at = now() - interval '2 hours'`);
    await t.q('delete from password_reset_requests');
    assert.equal((await t.login(SAM, SAM_PASSWORD)).res.status, 401);
    assert.equal(await code((await t.login(SAM, first)).res), 'temporary_password_expired');
    // A new request now issues a new credential, and it works.
    assert.equal((await t.forgot(SAM)).status, 200);
    await until(() => t.server.mail.length === 2);
    const second = t.server.mail[1].data.match(TEMP)[0];
    assert.notEqual(second, first);
    const again = await t.login(SAM, second);
    assert.equal(again.data.passwordChangeRequired, true);
    const change = await handlers.handleChangePassword(post('/api/auth/change-password', { newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD, page: 'required' }, { type: 'json', cookie: again.cookie, headers: { 'x-csrf-token': again.csrf } }), t.ctx);
    assert.equal(change.status, 200);
    assert.equal((await t.login(SAM, NEW_PASSWORD)).res.status, 200);
  } finally { await t.close(); }
});

test('the request table holds no client address in the clear', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    await t.forgot(SAM, { headers: { 'x-tallymed-proxy-secret': PROXY_SECRET, 'x-forwarded-for': '203.0.113.50', 'x-forwarded-proto': 'https' } });
    await t.forgot('ghost@example.test');
    const rows = await t.q('select client_ip from password_reset_requests');
    assert.ok(rows.every((r) => /^[0-9a-f]{64}$/.test(r.client_ip)), JSON.stringify(rows));
    assert.ok(!JSON.stringify(rows).includes('203.0.113.50'));
  } finally { await t.close(); }
});
