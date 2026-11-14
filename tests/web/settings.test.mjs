// Administrator settings: authorization, password confirmation, validation, audit, secret handling, concurrency, runtime effect, the SMTP helper
// against a local fake mail server, and trusted-proxy handling (including spoofed forwarded headers). Synthetic data only.
import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { loadConfig, parseSecretsKey, parseTrustedProxies } from '../../apps/web/server/config.ts';
import { deliver, resolveSmtpTarget, resetEmailLimiterForTests } from '../../apps/web/server/email.ts';
import * as handlers from '../../apps/web/server/http.ts';
import { classifyAddress, normalizeIp, parseTrustedEntry } from '../../apps/web/server/ip.ts';
import { stampPeer } from '../../apps/web/server/peer.ts';
import { clientInfo } from '../../apps/web/server/proxy.ts';
import { SlidingWindowLimiter } from '../../apps/web/server/rate-limit.ts';
import { hashPassword } from '../../apps/web/server/passwords.ts';
import { insertUser } from '../../apps/web/server/repositories/users.ts';
import { decryptSecret, encryptSecret } from '../../apps/web/server/secrets.ts';
import { resetSettingsLimitersForTests } from '../../apps/web/server/services/settings.ts';
import { freshDatabase, loginJson, PASSWORD, post, seedHousehold, skipDb, testConfig } from './helpers.mjs';

const KEY = 'k7Qz4mVx9LpR2wTn8YbH5cJd3FgS6aUeXo1Nq0Ds5Ew='; // fabricated, 32 bytes base64
const peerHeaders = (ip) => { const h = {}; stampPeer(h, ip); return h; };
const err = async (res) => (await res.clone().json()).error?.code;

async function setup(overrides = {}) {
  const db = await freshDatabase();
  const config = testConfig({ TALLYMED_SECRETS_KEY: KEY, ...overrides }, db.url);
  const ctx = { config, pool: db.pool };
  const ids = await seedHousehold(db.pool);
  const admin = await loginJson(handlers, ctx, 'admin@example.test');
  const operatorId = await insertUser(db.pool, { householdId: ids.householdId ?? (await db.pool.query('select id from households')).rows[0].id, email: 'sam@example.test', displayName: 'Sam Example', role: 'operator', passwordHash: await hashPassword(PASSWORD) });
  const sam = await loginJson(handlers, ctx, 'sam@example.test');
  resetSettingsLimitersForTests(); resetEmailLimiterForTests();
  return { db, ctx, config, admin, sam, operatorId };
}
const act = (ctx, who, action, body, extra = {}) =>
  handlers.handleSettingsAction(post(`/api/settings/${action}`, body, { type: 'json', cookie: who.cookie, headers: { 'x-csrf-token': who.csrf, ...(extra.headers ?? {}) }, ...extra }), ctx, action);
const version = async (db, g) => (await db.pool.query('select coalesce(max(version),0)::int v from server_settings where group_key = $1', [g])).rows[0].v;
const audit = async (db) => (await db.pool.query(`select action, entity_id, detail from audit_events where action like 'settings.%' order by id`)).rows;
const EMAIL = (over = {}) => ({ version: 0, currentPassword: PASSWORD, host: 'mail.example.test', port: 587, security: 'starttls', username: '', password: '', fromAddress: 'tallymed@example.test', fromName: 'TallyMed', ...over });

test('ip helpers: parsing, trusted entries and address classes', () => {
  assert.equal(normalizeIp('::ffff:10.1.2.3'), '10.1.2.3');
  assert.equal(normalizeIp('2001:DB8::1'), '2001:db8:0:0:0:0:0:1');
  assert.equal(normalizeIp('not an ip'), null);
  for (const ok of ['192.168.1.10', '10.0.0.0/8', '172.18.0.0/16', '2001:db8::10', '2001:db8::/32']) assert.ok(!('error' in parseTrustedEntry(ok)), ok);
  for (const bad of ['0.0.0.0/0', '::/0', '1.2.3.4/7', '2001::/16', 'example.com', '1.2.3.4/33', '1.2.3.4/x', '1.2.3.4/8/9', '', '256.1.1.1']) assert.ok('error' in parseTrustedEntry(bad), bad);
  const classes = { '8.8.8.8': 'public', '10.1.1.1': 'private', '192.168.0.5': 'private', '127.0.0.1': 'loopback', '::1': 'loopback', '169.254.169.254': 'metadata', '169.254.1.1': 'link_local',
    'fe80::1': 'link_local', '0.0.0.0': 'unspecified', '::': 'unspecified', '224.0.0.1': 'multicast', '100.100.100.200': 'metadata', 'fd00:ec2::254': 'metadata', '::ffff:127.0.0.1': 'loopback',
    '::ffff:169.254.169.254': 'metadata', '64:ff9b::a9fe:a9fe': 'metadata', '2002:7f00:1::1': 'loopback', '2606:4700::1111': 'public' };
  for (const [ip, c] of Object.entries(classes)) assert.equal(classifyAddress(ip), c, ip);
});

test('secrets key: validated, never echoed; encryption binds purpose and key', () => {
  assert.equal(parseSecretsKey(''), null);
  assert.ok(parseSecretsKey(KEY));
  for (const bad of ['short', 'not base64 !!', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=']) assert.throws(() => parseSecretsKey(bad), (e) => !e.message.includes(bad));
  const key = parseSecretsKey(KEY);
  const sealed = encryptSecret(key, 'email.smtp_password', 'hunter-two-example');
  assert.ok(!sealed.includes('hunter'));
  assert.notEqual(sealed, encryptSecret(key, 'email.smtp_password', 'hunter-two-example'));
  assert.deepEqual(decryptSecret(key, 'email.smtp_password', sealed), { status: 'ok', value: 'hunter-two-example' });
  assert.equal(decryptSecret(key, 'other.purpose', sealed).status, 'corrupt');
  assert.equal(decryptSecret(parseSecretsKey('Zq7Wm3Kx9Rv2Lp5NhY8cTb4Jd6FgS1aUeXo0Ab1Cd2E='), 'email.smtp_password', sealed).status, 'key_mismatch');
  assert.equal(decryptSecret(key, 'email.smtp_password', sealed.slice(0, -3) + 'AAA').status, 'corrupt');
  assert.throws(() => parseTrustedProxies('10.0.0.0/4'), /too broad/);
  assert.deepEqual(parseTrustedProxies('10.0.0.1, 172.18.0.0/16'), ['10.0.0.1', '172.18.0.0/16']);
});

test('sliding window limiter counts, expires and is bounded', () => {
  let t = 0;
  const l = new SlidingWindowLimiter(2, 1000, () => t, 3);
  assert.equal(l.take('a'), null); assert.equal(l.take('a'), null); assert.ok(l.take('a') >= 1);
  t = 1500; assert.equal(l.take('a'), null);
  for (const k of ['b', 'c', 'd', 'e']) l.take(k);
  assert.ok(l.hits.size <= 3);
});

test('smtp target policy: every resolved address is checked, loopback/link-local only by explicit allow, metadata never', async () => {
  const fixed = (...a) => async () => a;
  assert.deepEqual(await resolveSmtpTarget('x', false, fixed('93.184.216.34')), { ok: true, address: '93.184.216.34' });
  assert.deepEqual(await resolveSmtpTarget('x', false, fixed('192.168.1.5')), { ok: true, address: '192.168.1.5' });
  assert.equal((await resolveSmtpTarget('x', false, fixed('127.0.0.1'))).reason, 'target_blocked');
  assert.equal((await resolveSmtpTarget('x', true, fixed('127.0.0.1'))).ok, true);
  assert.equal((await resolveSmtpTarget('x', false, fixed('169.254.1.1'))).reason, 'target_blocked');
  assert.equal((await resolveSmtpTarget('x', true, fixed('169.254.169.254'))).reason, 'target_blocked');
  assert.equal((await resolveSmtpTarget('x', true, fixed('93.184.216.34', '169.254.169.254'))).reason, 'target_blocked'); // mixed answers refuse the host
  assert.equal((await resolveSmtpTarget('x', true, fixed('0.0.0.0'))).reason, 'target_blocked');
  assert.equal((await resolveSmtpTarget('x', false, async () => { throw new Error('nx'); })).reason, 'host_unresolved');
  assert.equal((await deliver({ host: 'x', port: 25, security: 'none', username: null, password: null, fromAddress: 'a@example.test', fromName: 'T', allowRestrictedTargets: false },
    { to: 'b@example.test', subject: 's', text: 't' }, 'h', { lookup: fixed('169.254.169.254') })).reason, 'target_blocked');
});

/** A minimal SMTP server that records envelopes. Plain text only. */
function fakeSmtp() {
  const mail = []; let cur = null; const sockets = new Set();
  const server = net.createServer((s) => {
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

test('settings are admin-only, CSRF and origin protected, and need the administrator password', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const body = EMAIL();
    assert.equal((await handlers.handleSettingsAction(post('/api/settings/email', body, { type: 'json' }), t.ctx, 'email')).status, 401);
    assert.equal((await act(t.ctx, t.sam, 'email', body)).status, 403);
    assert.equal(await err(await act(t.ctx, t.sam, 'email', body)), 'forbidden');
    assert.equal((await act(t.ctx, t.admin, 'email', body, { headers: { 'x-csrf-token': 'x'.repeat(40) } })).status, 403);
    assert.equal((await act(t.ctx, t.admin, 'email', body, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await act(t.ctx, t.admin, 'nope', body)).status, 404);
    assert.equal(await err(await act(t.ctx, t.admin, 'email', EMAIL({ currentPassword: 'wrong password 123' }))), 'reauth_failed');
    assert.equal((await t.db.pool.query('select count(*)::int n from server_settings')).rows[0].n, 0);
    // Five wrong passwords lock the confirmation, even for the right password.
    for (let i = 0; i < 4; i++) await act(t.ctx, t.admin, 'email', EMAIL({ currentPassword: 'wrong password 123' }));
    assert.equal((await act(t.ctx, t.admin, 'email', EMAIL())).status, 429);
    resetSettingsLimitersForTests();
    assert.equal((await act(t.ctx, t.admin, 'email', EMAIL())).status, 200);
    // An operator cannot reach the test or clear actions either.
    assert.equal((await act(t.ctx, t.sam, 'email/test', {})).status, 403);
    assert.equal((await act(t.ctx, t.sam, 'proxy', { version: 0, currentPassword: PASSWORD, trustedProxies: '10.0.0.1' })).status, 403);
    assert.equal((await t.db.pool.query(`select count(*)::int n from server_settings where group_key = 'proxy'`)).rows[0].n, 0);
  } finally { await t.db.drop(); }
});

test('validation: hosts, ports, security, addresses, limits and proxy lists', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    let v = 0;
    const bad = async (over) => assert.equal((await act(t.ctx, t.admin, 'email', EMAIL({ version: v, ...over }))).status, 400, JSON.stringify(over));
    for (const over of [{ host: 'http://evil' }, { host: 'a b' }, { host: '' }, { host: 'x'.repeat(300) }, { port: 22 }, { port: 'x' }, { security: 'ssl' }, { fromAddress: 'nope' },
      { fromAddress: 'a@b.test\r\nBcc: x@y.test' }, { security: 'none', username: 'u' }, { security: 'none', password: 'p' }, { username: 'u' }, { username: 'u\nx', password: 'p' }]) await bad(over);
    assert.equal((await act(t.ctx, t.admin, 'general', { version: 0, currentPassword: PASSWORD, sessionAbsoluteMinutes: '60', sessionIdleMinutes: '120' })).status, 400);
    assert.equal((await act(t.ctx, t.admin, 'general', { version: 0, currentPassword: PASSWORD, sourceUrl: 'javascript:alert(1)' })).status, 400);
    assert.equal((await act(t.ctx, t.admin, 'general', { version: 0, currentPassword: PASSWORD, sessionIdleMinutes: '0' })).status, 400);
    assert.equal((await act(t.ctx, t.admin, 'documents', { version: 0, currentPassword: PASSWORD, documentMaxMb: '26' })).status, 400);
    assert.equal((await act(t.ctx, t.admin, 'documents', { version: 0, currentPassword: PASSWORD, documentMaxMb: '20', documentQuotaMb: '10' })).status, 400);
    for (const list of ['0.0.0.0/0', '::/0', '10.0.0.0/4', 'proxy.example.com', '10.0.0.1\n999.1.1.1', Array.from({ length: 21 }, (_, i) => `10.0.0.${i}`).join(' ')]) {
      assert.equal((await act(t.ctx, t.admin, 'proxy', { version: 0, currentPassword: PASSWORD, trustedProxies: list })).status, 400, list);
    }
    assert.equal((await t.db.pool.query('select count(*)::int n from server_settings')).rows[0].n, 0);
    assert.equal((await act(t.ctx, t.admin, 'email', EMAIL({ port: 2525 }))).status, 200);
  } finally { await t.db.drop(); }
});

test('smtp password: encrypted at rest, never returned, never audited or logged, kept on blank, cleared on request', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const secret = 'zz-example-smtp-pass-9981';
    const res = await act(t.ctx, t.admin, 'email', EMAIL({ username: 'relay-user', password: secret }));
    assert.equal(res.status, 200);
    const row = (await t.db.pool.query(`select value, secret_ciphertext from server_settings where group_key = 'email'`)).rows[0];
    assert.ok(!JSON.stringify(row).includes(secret));
    assert.ok(row.secret_ciphertext.startsWith('v1.'));
    assert.ok(!JSON.stringify(await audit(t.db)).includes(secret));
    assert.ok(!JSON.stringify(await audit(t.db)).includes('relay-user'));
    const a = (await audit(t.db)).at(-1);
    assert.equal(a.detail.password, 'set'); assert.equal(a.detail.group, 'email'); assert.equal(a.detail.username, 'changed');
    // Rendering data for the page never carries the ciphertext or the secret.
    const { loadSettingsView } = await import('../../apps/web/server/services/settings.ts');
    const actor = { userId: t.admin.userId, householdId: (await t.db.pool.query('select id from households')).rows[0].id, role: 'admin', displayName: 'A', sessionId: 's' };
    const view = await loadSettingsView(t.db.pool, t.config, actor);
    assert.ok(!JSON.stringify(view).includes(secret) && !JSON.stringify(view).includes('v1.'));
    assert.equal(view.passwordState, 'saved');
    // Blank password keeps the saved one; changing other fields works.
    assert.equal((await act(t.ctx, t.admin, 'email', EMAIL({ version: 1, username: 'relay-user', password: '', port: 465, security: 'tls' }))).status, 200);
    assert.equal((await t.db.pool.query(`select secret_ciphertext from server_settings where group_key = 'email'`)).rows[0].secret_ciphertext, row.secret_ciphertext);
    // Removing the username drops the password; a username without any password is refused.
    assert.equal((await act(t.ctx, t.admin, 'email', EMAIL({ version: 2, username: 'relay-user', clearPassword: 'yes' }))).status, 400);
    assert.equal((await act(t.ctx, t.admin, 'email', EMAIL({ version: 2, username: '' }))).status, 200);
    assert.equal((await t.db.pool.query(`select secret_ciphertext from server_settings where group_key = 'email'`)).rows[0].secret_ciphertext, null);
    assert.equal((await audit(t.db)).at(-1).detail.password, 'cleared');
    // A wrong key is reported as unreadable, not as an error that leaks anything.
    await act(t.ctx, t.admin, 'email', EMAIL({ version: 3, username: 'u2', password: secret }));
    const other = { ...t.config, secretsKey: parseSecretsKey('Zq7Wm3Kx9Rv2Lp5NhY8cTb4Jd6FgS1aUeXo0Ab1Cd2E=') };
    assert.equal((await loadSettingsView(t.db.pool, other, actor)).passwordState, 'unreadable');
  } finally { await t.db.drop(); }
});

test('smtp password cannot be saved without a secrets key, but a relay without a login can', { skip: skipDb }, async () => {
  const t = await setup({ TALLYMED_SECRETS_KEY: '' });
  try {
    const res = await act(t.ctx, t.admin, 'email', EMAIL({ username: 'u', password: 'p-example-1234' }));
    assert.equal(await err(res), 'secrets_key_missing');
    assert.equal((await t.db.pool.query('select count(*)::int n from server_settings')).rows[0].n, 0);
    assert.equal((await act(t.ctx, t.admin, 'email', EMAIL())).status, 200);
  } finally { await t.db.drop(); }
});

test('concurrent saves of one version: exactly one wins; audit records every change with values', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const results = await Promise.all([1, 2, 3, 4].map((n) => act(t.ctx, t.admin, 'general', { version: 0, currentPassword: PASSWORD, sessionIdleMinutes: String(30 + n) })));
    const codes = results.map((r) => r.status).sort();
    assert.deepEqual(codes, [200, 409, 409, 409]);
    assert.equal(await version(t.db, 'general'), 1);
    assert.equal((await audit(t.db)).length, 1);
    const second = await act(t.ctx, t.admin, 'general', { version: 1, currentPassword: PASSWORD, sessionIdleMinutes: '45' });
    assert.equal(second.status, 200);
    const a = (await audit(t.db)).at(-1);
    assert.equal(a.action, 'settings.updated');
    assert.ok(a.detail['sessionIdleSeconds.from'] !== undefined && a.detail['sessionIdleSeconds.to'] === 2700);
    // An unchanged save writes nothing.
    assert.equal((await act(t.ctx, t.admin, 'general', { version: 2, currentPassword: PASSWORD, sessionIdleMinutes: '45' })).status, 200);
    assert.equal(await version(t.db, 'general'), 2);
  } finally { await t.db.drop(); }
});

test('stored settings take effect at once and clearing a field restores the environment value', { skip: skipDb }, async () => {
  const t = await setup({ TALLYMED_SESSION_IDLE_SECONDS: '7200', TALLYMED_SOURCE_URL: 'https://example.test/env' });
  try {
    assert.equal(t.config.sessionIdleSeconds, 7200);
    assert.equal((await act(t.ctx, t.admin, 'general', { version: 0, currentPassword: PASSWORD, sessionIdleMinutes: '10', sessionAbsoluteMinutes: '600', sourceUrl: 'https://example.test/src' })).status, 200);
    assert.equal(t.config.sessionIdleSeconds, 600);
    assert.equal(t.config.sessionAbsoluteSeconds, 36000);
    assert.equal(t.config.sourceUrl, 'https://example.test/src');
    assert.equal((await act(t.ctx, t.admin, 'documents', { version: 0, currentPassword: PASSWORD, documentMaxMb: '3', documentQuotaMb: '50', documentRetentionDays: '0' })).status, 200);
    assert.equal(t.config.documentMaxBytes, 3 * 1048576); assert.equal(t.config.documentRetentionDays, 0);
    assert.equal((await act(t.ctx, t.admin, 'general', { version: 1, currentPassword: PASSWORD })).status, 200);
    assert.equal(t.config.sessionIdleSeconds, 7200);
    assert.equal(t.config.sourceUrl, 'https://example.test/env');
  } finally { await t.db.drop(); }
});

test('test email goes only to the administrator, reports failures by category, is rate limited and audited', { skip: skipDb }, async () => {
  const smtp = await fakeSmtp();
  const t = await setup();
  try {
    assert.equal((await act(t.ctx, t.admin, 'email/test', {})).status, 200); // not configured: reported, not thrown
    assert.equal((await (await act(t.ctx, t.admin, 'email/test', {})).json()).result, 'not_configured');
    resetSettingsLimitersForTests();
    // Loopback relay is refused until explicitly allowed.
    await act(t.ctx, t.admin, 'email', EMAIL({ host: '127.0.0.1', port: 2525, security: 'none' }));
    assert.equal((await (await act(t.ctx, t.admin, 'email/test', {})).json()).result, 'target_blocked');
    // Unreachable (nothing listens on the allowed port) is a connection failure.
    await act(t.ctx, t.admin, 'email', EMAIL({ version: 1, host: '127.0.0.1', port: 2525, security: 'none', allowRestrictedTargets: 'yes' }));
    assert.equal((await (await act(t.ctx, t.admin, 'email/test', {})).json()).result, 'connect_failed');
    resetSettingsLimitersForTests();
    // A real exchange. The fake server listens on an ephemeral port, so the allowed-port list is bypassed by editing the stored row directly.
    await t.db.pool.query(`update server_settings set value = jsonb_set(value, '{port}', $1::jsonb) where group_key = 'email'`, [String(smtp.port)]);
    const ok = await act(t.ctx, t.admin, 'email/test', {});
    assert.equal((await ok.json()).result, 'sent');
    assert.equal(smtp.mail.length, 1);
    assert.deepEqual(smtp.mail[0].to, ['RCPT TO:<admin@example.test>']);
    assert.ok(smtp.mail[0].data.includes('Subject: TallyMed test email'));
    assert.ok(smtp.mail[0].data.includes('Auto-Submitted: auto-generated'));
    // Rate limit: three per window per administrator.
    assert.equal((await act(t.ctx, t.admin, 'email/test', {})).status, 200);
    assert.equal((await act(t.ctx, t.admin, 'email/test', {})).status, 200);
    assert.equal((await act(t.ctx, t.admin, 'email/test', {})).status, 429);
    const tests = (await audit(t.db)).filter((a) => a.action === 'settings.email_tested');
    assert.ok(tests.length >= 4); assert.equal(tests.at(-1).detail.sent, true);
    assert.ok(!JSON.stringify(tests).includes('admin@example.test'));
    // The helper refuses malformed messages and header injection.
    const { sendEmail } = await import('../../apps/web/server/email.ts');
    for (const m of [{ to: 'a@b.test\r\nBcc: x@y.test', subject: 's', text: 't' }, { to: 'a@b.test', subject: 's\r\nBcc: x@y.test', text: 't' }, { to: 'nope', subject: 's', text: 't' }, { to: 'a@b.test', subject: 's', text: '' }]) {
      assert.deepEqual(await sendEmail({ db: t.db.pool, config: t.config }, m, { purpose: 'test' }), { sent: false, reason: 'invalid_message' });
    }
    // Clearing removes everything.
    assert.equal((await act(t.ctx, t.admin, 'email/clear', { version: await version(t.db, 'email'), currentPassword: PASSWORD })).status, 200);
    assert.equal((await sendEmail({ db: t.db.pool, config: t.config }, { to: 'a@b.test', subject: 's', text: 't' }, { purpose: 'test' })).reason, 'not_configured');
  } finally { smtp.close(); await t.db.drop(); }
});

test('trusted proxies: nothing trusted by default; address list, chains, mapped addresses, and forged stamps', () => {
  const none = testConfig();
  assert.deepEqual(none.trustedProxies, []);
  const spoof = { ...peerHeaders('203.0.113.7'), 'x-forwarded-for': '1.1.1.1', 'x-forwarded-proto': 'https' };
  assert.equal(clientInfo(new Headers(spoof), none).trustedProxy, false);
  const c = testConfig({ TALLYMED_TRUSTED_PROXIES: '10.0.0.0/8, 192.168.1.5, 2001:db8::/32' });
  const from = (peer, xff) => clientInfo(new Headers({ ...peerHeaders(peer), ...(xff ? { 'x-forwarded-for': xff } : {}) }), c);
  assert.deepEqual(from('10.1.2.3', '198.51.100.20'), { trustedProxy: true, trustedBy: 'address', ip: '198.51.100.20', peer: '10.1.2.3' });
  assert.equal(from('::ffff:10.1.2.3', '198.51.100.20').ip, '198.51.100.20');
  assert.equal(from('192.168.1.5', '198.51.100.20').trustedBy, 'address');
  assert.equal(from('192.168.1.6', '198.51.100.20').trustedProxy, false);
  assert.equal(from('2001:db8::5', '198.51.100.20').trustedProxy, true);
  // Client-supplied left part never counts; trusted hops on the right are skipped.
  assert.equal(from('10.1.2.3', '6.6.6.6, 198.51.100.20, 10.9.9.9').ip, '198.51.100.20');
  assert.equal(from('10.1.2.3', '6.6.6.6, 198.51.100.20').ip, '198.51.100.20');
  assert.equal(from('10.1.2.3', 'garbage, 198.51.100.20').ip, '198.51.100.20');
  assert.equal(from('10.1.2.3', '198.51.100.20, garbage').ip, null);
  assert.equal(from('10.1.2.3', undefined).ip, null);
  assert.equal(from('10.1.2.3', '10.4.4.4').ip, '10.4.4.4');
  // A peer header without a valid signature (a client trying to claim a trusted address) is ignored.
  const forged = clientInfo(new Headers({ 'x-tallymed-peer': '10.1.2.3', 'x-tallymed-peer-sig': 'AAAA', 'x-forwarded-for': '1.1.1.1' }), c);
  assert.deepEqual(forged, { trustedProxy: false, trustedBy: null, ip: null, peer: null });
  assert.equal(clientInfo(new Headers({ 'x-tallymed-peer': '10.1.2.3', 'x-forwarded-for': '1.1.1.1' }), c).trustedProxy, false);
  // The signature belongs to its address: changing the address invalidates it.
  const h = peerHeaders('203.0.113.7'); h['x-tallymed-peer'] = '10.1.2.3';
  assert.equal(clientInfo(new Headers(h), c).trustedProxy, false);
  // The shared secret still works alongside the list.
  const s = testConfig({ TALLYMED_PROXY_SECRET: 's'.repeat(32), TALLYMED_TRUSTED_PROXIES: '10.0.0.1' });
  assert.equal(clientInfo(new Headers({ 'x-tallymed-proxy-secret': 's'.repeat(32), 'x-forwarded-for': '1.1.1.1' }), s).trustedBy, 'secret');
});

test('proxy settings: saved by the administrator, precedence over the environment, audited, and spoofed headers cannot bypass lockouts', { skip: skipDb }, async () => {
  const t = await setup({ TALLYMED_PROXY_SECRET: '', TALLYMED_TRUSTED_PROXIES: '10.9.9.9' });
  try {
    const tr = (ip, xff) => ({ headers: { ...peerHeaders(ip), 'x-forwarded-for': xff, 'x-forwarded-proto': 'https' } });
    assert.equal(clientInfo(new Headers(tr('10.9.9.9', '1.1.1.1').headers), t.config).trustedProxy, true);
    assert.equal((await act(t.ctx, t.admin, 'proxy', { version: 0, currentPassword: PASSWORD, trustedProxies: '172.18.0.0/16\n192.168.1.10' })).status, 200);
    assert.deepEqual(t.config.trustedProxies, ['172.18.0.0/16', '192.168.1.10']);
    assert.equal(clientInfo(new Headers(tr('10.9.9.9', '1.1.1.1').headers), t.config).trustedProxy, false); // the stored list replaces the environment list
    assert.equal(clientInfo(new Headers(tr('172.18.0.1', '1.1.1.1').headers), t.config).ip, '1.1.1.1');
    const a = (await audit(t.db)).at(-1);
    assert.equal(a.action, 'settings.proxy_updated'); assert.equal(a.detail['trustedProxies.to'], '172.18.0.0/16 192.168.1.10');
    // An empty stored list means trust nothing, even though the environment has one.
    assert.equal((await act(t.ctx, t.admin, 'proxy', { version: 1, currentPassword: PASSWORD, trustedProxies: '' })).status, 200);
    assert.deepEqual(t.config.trustedProxies, []);
    assert.equal((await act(t.ctx, t.admin, 'proxy', { version: 2, currentPassword: PASSWORD, useEnvironment: 'yes' })).status, 200);
    assert.deepEqual(t.config.trustedProxies, ['10.9.9.9']);
    await act(t.ctx, t.admin, 'proxy', { version: 3, currentPassword: PASSWORD, trustedProxies: '172.18.0.1' });

    // Spoofing: an untrusted peer forging X-Forwarded-For with ever-new addresses (and a forged peer stamp) never reaches the throttle
    // keys: its attempts are recorded under 'untrusted' and the per-account lockout still applies.
    const attacker = { headers: { ...peerHeaders('203.0.113.50') } };
    for (let i = 0; i < 25; i++) {
      await loginJson(handlers, t.ctx, `nobody${i}@example.test`, 'wrong password!!', { headers: { ...attacker.headers, 'x-forwarded-for': `198.51.100.${i}`, 'x-tallymed-peer': '172.18.0.1' } });
    }
    assert.deepEqual((await t.db.pool.query('select distinct client_ip from login_attempts')).rows.map((r) => r.client_ip), ['untrusted']);
    // The per-account lockout also holds against rotating forged addresses.
    for (let i = 0; i < 5; i++) await loginJson(handlers, t.ctx, 'admin@example.test', 'wrong password!!', { headers: { ...attacker.headers, 'x-forwarded-for': `198.51.100.${100 + i}` } });
    const locked = await loginJson(handlers, t.ctx, 'admin@example.test', PASSWORD, { headers: { ...attacker.headers, 'x-forwarded-for': '198.51.100.99' } });
    assert.equal(locked.res.status, 429);
    // Through the trusted proxy the real client address is what is counted, so another client is unaffected.
    const other = await loginJson(handlers, t.ctx, 'sam@example.test', PASSWORD, tr('172.18.0.1', '192.0.2.44'));
    assert.equal(other.res.status, 200);
    for (let i = 0; i < 20; i++) await loginJson(handlers, t.ctx, `x${i}@example.test`, 'wrong password!!', tr('172.18.0.1', '192.0.2.99'));
    assert.ok((await t.db.pool.query(`select count(*)::int n from login_attempts where client_ip = '192.0.2.99'`)).rows[0].n >= 20);
    assert.equal((await loginJson(handlers, t.ctx, 'sam@example.test', PASSWORD, tr('172.18.0.1', '192.0.2.99'))).res.status, 429);
    assert.equal((await loginJson(handlers, t.ctx, 'sam@example.test', PASSWORD, tr('172.18.0.1', '192.0.2.45'))).res.status, 200);
  } finally { await t.db.drop(); }
});

test('config: trusted proxy and secrets key environment values are validated', () => {
  assert.throws(() => loadConfig({ DATABASE_URL: 'postgres://x/y', TALLYMED_CANONICAL_ORIGIN: 'https://t.example', TALLYMED_TRUSTED_PROXIES: 'nope' }), /TALLYMED_TRUSTED_PROXIES/);
  assert.throws(() => loadConfig({ DATABASE_URL: 'postgres://x/y', TALLYMED_CANONICAL_ORIGIN: 'https://t.example', TALLYMED_SECRETS_KEY: 'tooshort' }), /TALLYMED_SECRETS_KEY/);
});
