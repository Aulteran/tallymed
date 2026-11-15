// Sign-in with an OpenID Connect provider, against a mock provider on loopback: the protocol checks (state, nonce, PKCE, signature,
// issuer, audience, time), who may sign in (verified email match, never a new administrator, provisioning off by default), the
// administrator settings (secret handling, audit, validation) and the rules that keep password sign-in from being lost. Synthetic data only.
import assert from 'node:assert/strict';
import { createHash, createSign, generateKeyPairSync, randomBytes, sign as signRaw } from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import * as handlers from '../../apps/web/server/http.ts';
import { discover, OidcError, providerUrl, requestJson, resetOidcCachesForTests, verifyIdToken } from '../../apps/web/server/oidc.ts';
import { hashPassword } from '../../apps/web/server/passwords.ts';
import { insertUser } from '../../apps/web/server/repositories/users.ts';
import { authenticate } from '../../apps/web/server/services/auth.ts';
import { resetSettingsLimitersForTests } from '../../apps/web/server/services/settings.ts';
import { resetSigninLimitersForTests, signinState } from '../../apps/web/server/services/signin.ts';
import { cookieFrom, freshDatabase, loginJson, ORIGIN, PASSWORD, post, seedHousehold, skipDb, testConfig } from './helpers.mjs';

const KEY = 'k7Qz4mVx9LpR2wTn8YbH5cJd3FgS6aUeXo1Nq0Ds5Ew='; // fabricated, 32 bytes base64
const CLIENT_ID = 'tallymed-test-client';
const CLIENT_SECRET = 'synthetic-client-secret-0123456789';
const CALLBACK = `${ORIGIN}/api/auth/oidc/callback`;
const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

function signJwt(header, claims, privateKey) {
  const body = `${b64(header)}.${b64(claims)}`;
  let signature = '';
  if (header.alg === 'RS256') signature = createSign('sha256').update(body).sign(privateKey).toString('base64url');
  else if (header.alg === 'ES256') signature = signRaw('sha256', Buffer.from(body), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  else if (header.alg === 'HS256') signature = createHash('sha256').update(body).digest('base64url'); // deliberately not a real MAC
  return `${body}.${signature}`;
}

/** A small OpenID Connect provider: discovery, keys and a token endpoint that checks the client, the code, the redirect and PKCE. */
async function mockProvider() {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const weak = generateKeyPairSync('rsa', { modulusLength: 1024 });
  const jwk = (key, kid, alg) => ({ ...key.publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg });
  const codes = new Map();
  const p = {
    keys: [jwk(rsa, 'rsa-1', 'RS256'), jwk(ec, 'ec-1', 'ES256'), jwk(weak, 'weak-1', 'RS256')],
    rsa, ec, other, weak, requests: [], tokenCalls: 0,
    /** Changes to the next ID token, applied by the token endpoint: `{ header, claims, key }`. */
    next: null,
    metadata: null,
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, p.issuer);
    p.requests.push(`${req.method} ${url.pathname}`);
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/.well-known/openid-configuration') return json(200, p.metadata ?? {
      issuer: p.issuer, authorization_endpoint: `${p.issuer}/authorize`, token_endpoint: `${p.issuer}/token`, jwks_uri: `${p.issuer}/jwks`,
      response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_basic'],
    });
    if (url.pathname === '/jwks') return json(200, { keys: p.keys });
    if (url.pathname === '/redirect') { res.writeHead(302, { location: `${p.issuer}/jwks` }); return res.end(); }
    if (url.pathname === '/huge') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ pad: 'x'.repeat(700_000) })); }
    if (url.pathname === '/token' && req.method === 'POST') {
      let text = '';
      req.on('data', (c) => { text += c; });
      req.on('end', () => {
        p.tokenCalls += 1;
        const form = new URLSearchParams(text);
        const basic = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString();
        const entry = codes.get(form.get('code'));
        codes.delete(form.get('code')); // single use
        const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
        if (basic !== `${CLIENT_ID}:${CLIENT_SECRET}` || form.get('grant_type') !== 'authorization_code' || !entry
            || entry.redirectUri !== form.get('redirect_uri') || entry.challenge !== challenge) return json(400, { error: 'invalid_grant' });
        const now = Math.floor(Date.now() / 1000);
        const n = p.next ?? {};
        p.next = null;
        const claims = { iss: p.issuer, aud: CLIENT_ID, iat: now, exp: now + 300, nonce: entry.nonce, ...entry.claims, ...(n.claims ?? {}) };
        json(200, { token_type: 'Bearer', access_token: 'unused', id_token: signJwt({ alg: 'RS256', kid: 'rsa-1', ...(n.header ?? {}) }, claims, n.key ?? rsa.privateKey) });
      });
      return undefined;
    }
    return json(404, { error: 'not_found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  p.issuer = `http://127.0.0.1:${server.address().port}`;
  /** What the person's browser and the provider do between the two TallyMed requests: sign in at the provider, come back with a code. */
  p.approve = (location, claims) => {
    const q = new URL(location).searchParams;
    const code = randomBytes(12).toString('base64url');
    codes.set(code, { claims, nonce: q.get('nonce'), challenge: q.get('code_challenge'), redirectUri: q.get('redirect_uri') });
    return `${q.get('redirect_uri')}?code=${code}&state=${q.get('state')}`;
  };
  p.close = () => new Promise((resolve) => server.close(resolve));
  return p;
}

const SIGNIN = (issuer, over = {}) => ({
  version: 0, currentPassword: PASSWORD, enabled: 'yes', provider: 'generic', issuer, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
  scopes: 'openid email profile', allowedDomains: '', ...over,
});
const act = (ctx, who, action, body) =>
  handlers.handleSettingsAction(post(`/api/settings/${action}`, body, { type: 'json', cookie: who.cookie, headers: { 'x-csrf-token': who.csrf } }), ctx, action);
const err = async (res) => (await res.clone().json()).error?.code;
const get = (pathAndQuery, cookie) => new Request(`http://app.internal:3000${pathAndQuery}`, { headers: cookie ? { cookie } : {} });
const errorOf = (res) => new URL(res.headers.get('location')).searchParams.get('error');
const version = async (db) => (await db.pool.query(`select coalesce(max(version),0)::int v from server_settings where group_key = 'signin'`)).rows[0].v;
const audit = async (db, like) => (await db.pool.query(`select action, entity_id, detail from audit_events where action like $1 order by id`, [like])).rows;

async function setup(overrides = {}, { configure = true } = {}) {
  resetOidcCachesForTests(); resetSigninLimitersForTests(); resetSettingsLimitersForTests();
  const provider = await mockProvider();
  const db = await freshDatabase();
  const config = testConfig({ TALLYMED_SECRETS_KEY: KEY, TALLYMED_OIDC_ALLOW_INSECURE_ISSUER: 'true', ...overrides }, db.url);
  const ctx = { config, pool: db.pool };
  await seedHousehold(db.pool);
  const householdId = (await db.pool.query('select id from households')).rows[0].id;
  const addUser = (email, role = 'operator') => hashPassword(PASSWORD).then((passwordHash) => insertUser(db.pool, { householdId, email, displayName: 'Sam Example', role, passwordHash }));
  const admin = await loginJson(handlers, ctx, 'admin@example.test');
  if (configure) assert.equal((await act(ctx, admin, 'signin', SIGNIN(provider.issuer))).status, 200);
  /** Start at TallyMed, approve at the provider, return to TallyMed. `tamper` may change the callback URL or the cookie. */
  const signIn = async (claims, tamper = {}) => {
    const start = await handlers.handleOidcStart(get('/api/auth/oidc/start'), ctx);
    assert.equal(start.status, 303);
    const flowCookie = cookieFrom(start);
    const back = new URL(provider.approve(start.headers.get('location'), claims));
    for (const [k, v] of Object.entries(tamper.query ?? {})) { if (v === null) back.searchParams.delete(k); else back.searchParams.set(k, v); }
    const cookie = tamper.cookie === undefined ? flowCookie : tamper.cookie;
    const res = await handlers.handleOidcCallback(get(`${back.pathname}${back.search}`, cookie ?? undefined), ctx);
    const session = res.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('__Host-tallymed_session=')) ?? null;
    return { start, res, flowCookie, back, session, location: res.headers.get('location') };
  };
  const drop = async () => { await provider.close(); await db.drop(); };
  return { provider, db, ctx, config, admin, householdId, addUser, signIn, drop };
}
const ADMIN_CLAIMS = { sub: 'subject-admin', email: 'admin@example.test', email_verified: true, name: 'Alex Example' };

// ---------- protocol code, no database ----------

test('provider URLs and outbound requests: https only, no internal addresses, no redirects, bounded size', async () => {
  assert.equal(providerUrl('http://auth.example.test', false), null);
  assert.equal(providerUrl('https://user:pw@auth.example.test', false), null);
  assert.equal(providerUrl('https://auth.example.test/#x', false), null);
  assert.equal(providerUrl('ftp://auth.example.test', true), null);
  assert.ok(providerUrl('https://auth.example.test/realms/home', false));
  const p = await mockProvider();
  try {
    const reason = (promise) => promise.then(() => 'accepted', (e) => (e instanceof OidcError ? e.reason : `other:${e}`));
    // Loopback and plain http are refused unless the test switch is on; metadata and unspecified addresses always.
    assert.equal(await reason(requestJson(`${p.issuer}/jwks`, false)), 'metadata_invalid');
    assert.equal(await reason(requestJson('https://127.0.0.1:9/jwks', false)), 'target_blocked');
    assert.equal(await reason(requestJson('https://[::1]:9/jwks', false)), 'target_blocked');
    assert.equal(await reason(requestJson('https://localhost:9/jwks', false)), 'target_blocked');
    assert.equal(await reason(requestJson('http://169.254.169.254/latest', true)), 'target_blocked');
    assert.equal(await reason(requestJson('http://0.0.0.0:9/x', true)), 'target_blocked');
    assert.equal(await reason(requestJson(`${p.issuer}/redirect`, true)), 'bad_response');
    assert.equal(await reason(requestJson(`${p.issuer}/huge`, true)), 'bad_response');
    assert.equal((await requestJson(`${p.issuer}/jwks`, true)).status, 200);
  } finally {
    await p.close();
  }
});

test('discovery refuses a document for another issuer, non-https endpoints and a provider without S256', async () => {
  resetOidcCachesForTests();
  const p = await mockProvider();
  try {
    const good = { issuer: p.issuer, authorization_endpoint: `${p.issuer}/authorize`, token_endpoint: `${p.issuer}/token`, jwks_uri: `${p.issuer}/jwks` };
    const reason = async (metadata) => { p.metadata = metadata; return discover(p.issuer, true, true).then(() => 'accepted', (e) => e.reason); };
    assert.equal(await reason({ ...good, issuer: 'https://other.example.test' }), 'issuer_mismatch');
    assert.equal(await reason({ ...good, token_endpoint: 'javascript:alert(1)' }), 'metadata_invalid');
    assert.equal(await reason({ ...good, jwks_uri: undefined }), 'metadata_invalid');
    assert.equal(await reason({ ...good, code_challenge_methods_supported: ['plain'] }), 'metadata_invalid');
    assert.equal(await reason({ ...good, response_types_supported: ['id_token'] }), 'metadata_invalid');
    assert.equal(await reason(good), 'accepted');
    // With the switch off, the same http document is not even fetched.
    assert.equal(await discover(p.issuer, false, true).then(() => 'accepted', (e) => e.reason), 'metadata_invalid');
  } finally {
    await p.close();
  }
});

test('ID token verification: signature, algorithm, issuer, audience, time window and nonce', async () => {
  resetOidcCachesForTests();
  const p = await mockProvider();
  try {
    const metadata = { issuer: p.issuer, authorizationEndpoint: `${p.issuer}/authorize`, tokenEndpoint: `${p.issuer}/token`, jwksUri: `${p.issuer}/jwks`, tokenAuthMethods: ['client_secret_basic'] };
    const client = { issuer: p.issuer, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, scopes: 'openid', allowInsecure: true };
    const now = Math.floor(Date.now() / 1000);
    const base = { iss: p.issuer, aud: CLIENT_ID, sub: 's1', iat: now, exp: now + 300, nonce: 'n1', email: 'a@example.test', email_verified: true };
    const rs = (claims, header = {}, key = p.rsa.privateKey) => signJwt({ alg: 'RS256', kid: 'rsa-1', ...header }, claims, key);
    const check = (token, m = metadata) => verifyIdToken(token, m, client, 'n1').then((c) => c, (e) => e.reason);

    assert.deepEqual(await check(rs(base)), { issuer: p.issuer, subject: 's1', email: 'a@example.test', emailVerified: true, name: null });
    assert.equal((await check(signJwt({ alg: 'ES256', kid: 'ec-1' }, base, p.ec.privateKey))).subject, 's1');
    // Unsigned, shared-secret and unknown algorithms.
    assert.equal(await check(`${b64({ alg: 'none' })}.${b64(base)}.`), 'signature_invalid');
    assert.equal(await check(signJwt({ alg: 'HS256', kid: 'rsa-1' }, base, null)), 'signature_invalid');
    assert.equal(await check(rs(base, { alg: 'constructor' })), 'signature_invalid');
    // Another key, an unknown key id, a changed payload, an algorithm that does not belong to the key, a 1024-bit key.
    assert.equal(await check(rs(base, {}, p.other.privateKey)), 'signature_invalid');
    assert.equal(await check(rs(base, { kid: 'missing' })), 'signature_invalid');
    const [h, , s] = rs(base).split('.');
    assert.equal(await check(`${h}.${b64({ ...base, email: 'admin@example.test' })}.${s}`), 'signature_invalid');
    assert.equal(await check(signJwt({ alg: 'ES256', kid: 'rsa-1' }, base, p.ec.privateKey)), 'signature_invalid');
    assert.equal(await check(rs(base, { kid: 'weak-1' }, p.weak.privateKey)), 'signature_invalid');
    assert.equal(await check(rs(base, { crit: ['x'] })), 'token_invalid');
    assert.equal(await check('not.a.token'), 'token_invalid');
    assert.equal(await check(undefined), 'token_invalid');
    // Claims.
    assert.equal(await check(rs({ ...base, iss: 'https://other.example.test' })), 'claims_invalid');
    assert.equal(await check(rs({ ...base, aud: 'another-client' })), 'claims_invalid');
    assert.equal(await check(rs({ ...base, aud: [CLIENT_ID, 'another-client'] })), 'claims_invalid');
    assert.equal((await check(rs({ ...base, aud: [CLIENT_ID, 'another-client'], azp: CLIENT_ID }))).subject, 's1');
    assert.equal(await check(rs({ ...base, azp: 'another-client' })), 'claims_invalid');
    assert.equal(await check(rs({ ...base, exp: now - 120 })), 'claims_invalid');
    assert.equal(await check(rs({ ...base, iat: now + 600 })), 'claims_invalid');
    assert.equal(await check(rs({ ...base, iat: now - 7200, exp: now + 300 })), 'claims_invalid');
    assert.equal(await check(rs({ ...base, nbf: now + 600 })), 'claims_invalid');
    assert.equal(await check(rs({ ...base, nonce: 'n2' })), 'nonce_mismatch');
    assert.equal(await check(rs({ ...base, nonce: undefined })), 'nonce_mismatch');
    assert.equal(await check(rs({ ...base, sub: '' })), 'claims_invalid');
    assert.equal(await check(rs({ ...base, sub: 42 })), 'claims_invalid');
    // Only a literal true verifies an address; Microsoft's domain-verified claim counts only for Microsoft's issuer.
    assert.equal((await check(rs({ ...base, email_verified: 'true' }))).emailVerified, false);
    assert.equal((await check(rs({ ...base, email_verified: undefined }))).emailVerified, false);
    assert.equal((await check(rs({ ...base, email_verified: undefined, xms_edov: true }))).emailVerified, false);
    const ms = 'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0';
    assert.equal((await check(rs({ ...base, iss: ms, email_verified: undefined, xms_edov: true }), { ...metadata, issuer: ms })).emailVerified, true);
    assert.equal((await check(rs({ ...base, iss: ms, email_verified: undefined }), { ...metadata, issuer: ms })).emailVerified, false);
  } finally {
    await p.close();
  }
});

// ---------- settings ----------

test('sign-in settings: admin only, password confirmed, validated, secret encrypted and never returned or audited', { skip: skipDb }, async () => {
  const t = await setup({}, { configure: false });
  try {
    await t.addUser('sam@example.test');
    const sam = await loginJson(handlers, t.ctx, 'sam@example.test');
    const issuer = t.provider.issuer;
    assert.equal(await err(await act(t.ctx, sam, 'signin', SIGNIN(issuer))), 'forbidden');
    assert.equal(await err(await act(t.ctx, t.admin, 'signin', SIGNIN(issuer, { currentPassword: 'not the password' }))), 'reauth_failed');
    resetSettingsLimitersForTests();
    const bad = async (over) => assert.equal(await err(await act(t.ctx, t.admin, 'signin', SIGNIN(issuer, over))), 'invalid_input', JSON.stringify(over));
    await bad({ issuer: 'ftp://auth.example.test' });
    await bad({ issuer: 'https://auth.example.test/?x=1' });
    await bad({ issuer: 'https://user:pw@auth.example.test' });
    await bad({ issuer: '' });
    await bad({ clientId: '' });
    await bad({ scopes: 'email profile' });
    await bad({ scopes: 'openid "quoted"' });
    await bad({ provider: 'github' });
    await bad({ provider: 'microsoft', tenant: 'common' });
    await bad({ provider: 'microsoft', tenant: '' });
    await bad({ autoProvision: 'yes', allowedDomains: '' });
    await bad({ allowedDomains: 'not a domain!' });
    await bad({ passwordLoginDisabled: 'yes', enabled: '' });
    await bad({ surprise: 'field' });
    assert.equal(await version(t.db), 0);

    assert.equal((await act(t.ctx, t.admin, 'signin', SIGNIN(issuer, { buttonLabel: 'Home login' }))).status, 200);
    const row = (await t.db.pool.query(`select value, secret_ciphertext from server_settings where group_key = 'signin'`)).rows[0];
    assert.equal(JSON.stringify(row.value).includes(CLIENT_SECRET), false);
    assert.match(row.secret_ciphertext, /^v1\./);
    assert.equal(row.secret_ciphertext.includes(CLIENT_SECRET), false);
    assert.deepEqual([row.value.enabled, row.value.issuer, row.value.autoProvision, row.value.passwordLoginDisabled], [true, issuer, false, false]);
    const [saved] = await audit(t.db, 'settings.signin_updated');
    assert.equal(saved.detail.clientSecret, 'set');
    assert.equal(JSON.stringify(await audit(t.db, '%')).includes(CLIENT_SECRET), false);
    assert.deepEqual(await signinState(t.db.pool, t.config), { oidcLabel: 'Home login', passwordLogin: true });
    // A stale form is refused; an empty secret keeps the saved one.
    assert.equal(await err(await act(t.ctx, t.admin, 'signin', SIGNIN(issuer))), 'stale_version');
    assert.equal((await act(t.ctx, t.admin, 'signin', SIGNIN(issuer, { version: 1, clientSecret: '' }))).status, 200);
    assert.equal((await t.db.pool.query(`select secret_ciphertext from server_settings where group_key = 'signin'`)).rows[0].secret_ciphertext, row.secret_ciphertext);

    // Presets fix the issuer; Microsoft needs one directory.
    assert.equal((await act(t.ctx, t.admin, 'signin', SIGNIN('https://ignored.example.test', { version: 2, provider: 'google' }))).status, 200);
    assert.equal((await t.db.pool.query(`select value->>'issuer' i from server_settings where group_key = 'signin'`)).rows[0].i, 'https://accounts.google.com');
    assert.equal((await act(t.ctx, t.admin, 'signin', SIGNIN('', { version: 3, provider: 'microsoft', tenant: '11111111-2222-3333-4444-555555555555' }))).status, 200);
    assert.equal((await t.db.pool.query(`select value->>'issuer' i from server_settings where group_key = 'signin'`)).rows[0].i, 'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0');

    // The connection test reports the provider's state and is audited.
    assert.equal((await act(t.ctx, t.admin, 'signin', SIGNIN(issuer, { version: 4 }))).status, 200);
    assert.equal(await err(await act(t.ctx, sam, 'signin/test', {})), 'forbidden');
    assert.equal((await (await act(t.ctx, t.admin, 'signin/test', {})).json()).result, 'ok');
    t.provider.metadata = { issuer: 'https://other.example.test' };
    assert.equal((await (await act(t.ctx, t.admin, 'signin/test', {})).json()).result, 'issuer_mismatch');
    assert.deepEqual((await audit(t.db, 'settings.signin_tested')).map((a) => a.detail.result), ['ok', 'issuer_mismatch']);
  } finally {
    await t.drop();
  }
});

test('without a secrets key provider sign-in cannot be turned on and the sign-in page offers passwords only', { skip: skipDb }, async () => {
  const t = await setup({ TALLYMED_SECRETS_KEY: '' }, { configure: false });
  try {
    assert.equal(await err(await act(t.ctx, t.admin, 'signin', SIGNIN(t.provider.issuer))), 'secrets_key_missing');
    assert.deepEqual(await signinState(t.db.pool, t.config), { oidcLabel: null, passwordLogin: true });
    const res = await handlers.handleOidcStart(get('/api/auth/oidc/start'), t.ctx);
    assert.equal(errorOf(res), 'sso_unavailable');
    assert.equal(t.provider.requests.length, 0);
  } finally {
    await t.drop();
  }
});

// ---------- the flow ----------

test('sign-in through the provider: PKCE, state and nonce are sent, the account is matched by verified email and then by subject', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const r = await t.signIn(ADMIN_CLAIMS);
    // The authorization request.
    const sent = new URL(r.start.headers.get('location'));
    assert.equal(`${sent.origin}${sent.pathname}`, `${t.provider.issuer}/authorize`);
    const q = sent.searchParams;
    assert.deepEqual([q.get('response_type'), q.get('client_id'), q.get('redirect_uri'), q.get('scope'), q.get('code_challenge_method')],
      ['code', CLIENT_ID, CALLBACK, 'openid email profile', 'S256']);
    for (const k of ['state', 'nonce', 'code_challenge']) assert.match(q.get(k), /^[A-Za-z0-9_-]{43}$/);
    assert.equal(sent.href.includes(CLIENT_SECRET), false);
    // The flow cookie: host-bound, not readable by scripts, short-lived, and opaque (no state, nonce or verifier in the clear).
    const set = r.start.headers.get('set-cookie');
    assert.match(set, /^__Host-tallymed_oidc=v1\.[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/);
    assert.equal(set.includes(q.get('state')) || set.includes(q.get('nonce')), false);
    assert.equal(r.start.headers.get('cache-control'), 'no-store');

    // The callback: a session for the existing administrator, the flow cookie cleared.
    assert.equal(r.res.status, 303);
    assert.equal(r.location, `${ORIGIN}/`);
    assert.ok(r.res.headers.getSetCookie().some((c) => /^__Host-tallymed_oidc=; .*Max-Age=0/.test(c)));
    const actor = await authenticate(t.db.pool, t.config, r.session.split('=')[1]);
    assert.equal(actor.role, 'admin');
    const users = (await t.db.pool.query(`select count(*)::int n from users`)).rows[0].n;
    assert.equal(users, 1);
    const identity = (await t.db.pool.query(`select issuer, subject, email_at_link, created_via, last_login_at from user_identities`)).rows;
    assert.equal(identity.length, 1);
    assert.deepEqual([identity[0].issuer, identity[0].subject, identity[0].email_at_link, identity[0].created_via], [t.provider.issuer, 'subject-admin', 'admin@example.test', 'email_match']);
    assert.ok(identity[0].last_login_at);
    assert.deepEqual((await audit(t.db, 'auth.oidc_%')).map((a) => [a.action, a.detail.via]), [['auth.oidc_linked', 'email_match']]);
    const logins = await audit(t.db, 'auth.login');
    assert.equal(logins.at(-1).detail.method, 'oidc');
    // Nothing from the provider's answer is kept beyond the link: no tokens, no code.
    assert.equal(JSON.stringify(await audit(t.db, '%')).includes('unused'), false);

    // Later sign-ins follow the subject, even if the address at the provider changed or is no longer verified. No second link.
    const again = await t.signIn({ sub: 'subject-admin', email: 'someone.else@example.test', email_verified: false });
    assert.equal(again.location, `${ORIGIN}/`);
    assert.equal((await authenticate(t.db.pool, t.config, again.session.split('=')[1])).userId, actor.userId);
    assert.equal((await t.db.pool.query(`select count(*)::int n from user_identities`)).rows[0].n, 1);

    // Signing in again rotates the previous session of the same browser.
    const start = await handlers.handleOidcStart(get('/api/auth/oidc/start'), t.ctx);
    const back = new URL(t.provider.approve(start.headers.get('location'), ADMIN_CLAIMS));
    const third = await handlers.handleOidcCallback(get(`${back.pathname}${back.search}`, `${cookieFrom(start)}; ${again.session}`), t.ctx);
    assert.equal(third.status, 303);
    assert.equal(await authenticate(t.db.pool, t.config, again.session.split('=')[1]), null);
  } finally {
    await t.drop();
  }
});

test('the callback refuses a missing, foreign or reused flow, a wrong state, provider errors and a bad token', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const sessions = async () => (await t.db.pool.query(`select count(*)::int n from sessions`)).rows[0].n;
    const before = await sessions();
    const failed = async (r, code = 'sso_failed') => {
      assert.equal(r.res.status, 303);
      assert.equal(new URL(r.location).pathname, '/login');
      assert.equal(errorOf(r.res), code);
      assert.equal(r.session, null);
    };
    // No cookie (an answer delivered to another browser), a cookie from another flow, a changed or missing state.
    await failed(await t.signIn(ADMIN_CLAIMS, { cookie: null }));
    const otherFlow = cookieFrom(await handlers.handleOidcStart(get('/api/auth/oidc/start'), t.ctx));
    await failed(await t.signIn(ADMIN_CLAIMS, { cookie: otherFlow }));
    await failed(await t.signIn(ADMIN_CLAIMS, { cookie: '__Host-tallymed_oidc=v1.forged.aaaa.bbbb.cccc' }));
    await failed(await t.signIn(ADMIN_CLAIMS, { query: { state: 'A'.repeat(43) } }));
    await failed(await t.signIn(ADMIN_CLAIMS, { query: { state: null } }));
    const calls = t.provider.tokenCalls;
    assert.equal(calls, 0, 'the provider is not contacted for a flow that fails these checks');
    // The provider reported an error, or sent no code, or names another issuer.
    await failed(await t.signIn(ADMIN_CLAIMS, { query: { error: 'access_denied', code: null } }));
    await failed(await t.signIn(ADMIN_CLAIMS, { query: { code: null } }));
    await failed(await t.signIn(ADMIN_CLAIMS, { query: { iss: 'https://other.example.test' } }));
    assert.equal(t.provider.tokenCalls, 0);
    // A code that was already used: the same answer replayed with the same cookie.
    const ok = await t.signIn(ADMIN_CLAIMS);
    assert.equal(ok.location, `${ORIGIN}/`);
    const replay = await handlers.handleOidcCallback(get(`${ok.back.pathname}${ok.back.search}`, ok.flowCookie), t.ctx);
    assert.equal(errorOf(replay), 'sso_failed');
    // A code issued to a different PKCE challenge (an intercepted code used from another flow).
    const a = await handlers.handleOidcStart(get('/api/auth/oidc/start'), t.ctx);
    const b = await handlers.handleOidcStart(get('/api/auth/oidc/start'), t.ctx);
    const codeForA = new URL(t.provider.approve(a.headers.get('location'), ADMIN_CLAIMS)).searchParams.get('code');
    const stateOfB = new URL(b.headers.get('location')).searchParams.get('state');
    assert.equal(errorOf(await handlers.handleOidcCallback(get(`/api/auth/oidc/callback?code=${codeForA}&state=${stateOfB}`, cookieFrom(b)), t.ctx)), 'sso_failed');
    // Tokens the provider should never produce.
    resetSigninLimitersForTests();
    const now = Math.floor(Date.now() / 1000);
    for (const next of [
      { claims: { nonce: 'another-nonce' } }, { claims: { aud: 'another-client' } }, { claims: { iss: 'https://other.example.test' } },
      { claims: { exp: now - 3600 } }, { key: t.provider.other.privateKey }, { header: { alg: 'none' } }, { claims: { sub: undefined } },
    ]) {
      t.provider.next = next;
      await failed(await t.signIn(ADMIN_CLAIMS));
    }
    assert.equal(await sessions(), before + 1);
    assert.equal((await t.db.pool.query(`select count(*)::int n from user_identities`)).rows[0].n, 1);
    // Duplicate parameters are refused outright, and only GET is accepted.
    assert.equal(errorOf(await handlers.handleOidcCallback(get('/api/auth/oidc/callback?code=a&code=b&state=x', ok.flowCookie), t.ctx)), 'sso_failed');
    assert.equal(errorOf(await handlers.handleOidcStart(post('/api/auth/oidc/start', {}), t.ctx)), 'sso_failed');
  } finally {
    await t.drop();
  }
});

test('who may sign in: verified email only, no silent second link, disabled accounts refused, nobody is created by default', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    const samId = await t.addUser('sam@example.test');
    const refused = async (claims, code = 'sso_no_account') => {
      const r = await t.signIn(claims);
      assert.equal(errorOf(r.res), code, JSON.stringify(claims));
      assert.equal(r.session, null);
    };
    // The provider does not vouch for the address: no match, however well the address fits an administrator.
    await refused({ sub: 'x1', email: 'admin@example.test', email_verified: false });
    await refused({ sub: 'x1', email: 'admin@example.test' });
    await refused({ sub: 'x1', email: 'admin@example.test', email_verified: 'true' });
    await refused({ sub: 'x1' });
    await refused({ sub: 'x1', email: 'not an address', email_verified: true });
    // A verified address with no account: nothing is created unless an administrator allowed it.
    await refused({ sub: 'x2', email: 'stranger@example.test', email_verified: true });
    assert.equal((await t.db.pool.query(`select count(*)::int n from users`)).rows[0].n, 2);
    assert.equal((await t.db.pool.query(`select count(*)::int n from user_identities`)).rows[0].n, 0);

    // Address case does not matter; the first verified sign-in links the account.
    const sam = await t.signIn({ sub: 'subject-sam', email: 'Sam@Example.test', email_verified: true });
    assert.equal(sam.location, `${ORIGIN}/`);
    assert.equal((await authenticate(t.db.pool, t.config, sam.session.split('=')[1])).userId, samId);
    // A second provider identity claiming the same address is not linked and is recorded for the administrator.
    await refused({ sub: 'subject-impostor', email: 'sam@example.test', email_verified: true }, 'sso_failed');
    assert.deepEqual((await audit(t.db, 'auth.oidc_refused')).map((a) => [a.entity_id, a.detail.reason]), [[samId, 'identity_conflict']]);
    assert.equal((await t.db.pool.query(`select subject from user_identities where user_id = $1`, [samId])).rows[0].subject, 'subject-sam');

    // A disabled account is refused both by subject and by address, and gets no session.
    await t.db.pool.query(`update users set status = 'disabled' where id = $1`, [samId]);
    await refused({ sub: 'subject-sam', email: 'sam@example.test', email_verified: true });
    const pat = await t.addUser('pat@example.test');
    await t.db.pool.query(`update users set status = 'disabled' where id = $1`, [pat]);
    await refused({ sub: 'subject-pat', email: 'pat@example.test', email_verified: true });
    assert.equal((await t.db.pool.query(`select count(*)::int n from user_identities where user_id = $1`, [pat])).rows[0].n, 0);

    // An account that must replace a temporary password is sent to do that; the session stays restricted.
    const lee = await t.addUser('lee@example.test');
    await t.db.pool.query(`update users set must_change_password = true where id = $1`, [lee]);
    const restricted = await t.signIn({ sub: 'subject-lee', email: 'lee@example.test', email_verified: true });
    assert.equal(restricted.location, `${ORIGIN}/password/change`);
    assert.equal((await authenticate(t.db.pool, t.config, restricted.session.split('=')[1])).mustChangePassword, true);
  } finally {
    await t.drop();
  }
});

test('new accounts are created only when allowed, only for listed domains, and always as Standard users', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    assert.equal((await act(t.ctx, t.admin, 'signin', SIGNIN(t.provider.issuer, { version: 1, clientSecret: '', autoProvision: 'yes', allowedDomains: 'example.test, family.example' }))).status, 200);
    const outside = await t.signIn({ sub: 'n0', email: 'new@elsewhere.test', email_verified: true });
    assert.equal(errorOf(outside.res), 'sso_no_account');
    // A look-alike domain is not a listed domain.
    assert.equal(errorOf((await t.signIn({ sub: 'n0', email: 'new@notexample.test', email_verified: true })).res), 'sso_no_account');
    assert.equal(errorOf((await t.signIn({ sub: 'n0', email: 'new@example.test.evil.test', email_verified: true })).res), 'sso_no_account');
    assert.equal(errorOf((await t.signIn({ sub: 'n0', email: 'new@example.test', email_verified: false })).res), 'sso_no_account');
    assert.equal((await t.db.pool.query(`select count(*)::int n from users`)).rows[0].n, 1);

    // Claims that ask for more are ignored: the account is a Standard user in the one household.
    const made = await t.signIn({ sub: 'n1', email: 'New.Person@Example.test', email_verified: true, name: '  Robin\u0007 Example  ', role: 'admin', groups: ['admins'], is_admin: true });
    assert.equal(made.location, `${ORIGIN}/`);
    const actor = await authenticate(t.db.pool, t.config, made.session.split('=')[1]);
    assert.deepEqual([actor.role, actor.displayName, actor.householdId], ['operator', 'Robin Example', t.householdId]);
    const user = (await t.db.pool.query(`select email, role, status, must_change_password from users where id = $1`, [actor.userId])).rows[0];
    assert.deepEqual(user, { email: 'New.Person@Example.test', role: 'operator', status: 'active', must_change_password: false });
    assert.deepEqual((await audit(t.db, 'auth.oidc_user_created')).map((a) => [a.entity_id, a.detail.role]), [[actor.userId, 'operator']]);
    assert.equal((await t.db.pool.query(`select created_via from user_identities where user_id = $1`, [actor.userId])).rows[0].created_via, 'provisioned');
    // The random password is not one anybody knows: password sign-in with obvious guesses fails.
    for (const guess of ['', PASSWORD, 'n1', 'New.Person@Example.test']) {
      assert.notEqual((await loginJson(handlers, t.ctx, 'new.person@example.test', guess)).res.status, 200);
    }
    // The second sign-in finds the same account; no duplicate.
    const again = await t.signIn({ sub: 'n1', email: 'new.person@example.test', email_verified: true });
    assert.equal((await authenticate(t.db.pool, t.config, again.session.split('=')[1])).userId, actor.userId);
    assert.equal((await t.db.pool.query(`select count(*)::int n from users`)).rows[0].n, 2);
    assert.equal((await t.db.pool.query(`select count(*)::int n from users where role = 'admin'`)).rows[0].n, 1);
  } finally {
    await t.drop();
  }
});

// ---------- keeping a way in ----------

test('password sign-in can be turned off only after the administrator signed in through the provider, and comes back when that stops holding', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    await t.addUser('sam@example.test');
    const off = (over = {}) => SIGNIN(t.provider.issuer, { clientSecret: '', passwordLoginDisabled: 'yes', ...over });
    const state = () => signinState(t.db.pool, t.config);
    const passwordWorks = async (email = 'admin@example.test') => (await loginJson(handlers, t.ctx, email)).res.status === 200;

    // Not before the acting administrator has signed in through this provider.
    assert.equal(await err(await act(t.ctx, t.admin, 'signin', off({ version: 1 }))), 'sso_not_proven');
    // Someone else signing in through the provider proves nothing about the administrator.
    assert.equal((await t.signIn({ sub: 'subject-sam', email: 'sam@example.test', email_verified: true })).location, `${ORIGIN}/`);
    assert.equal(await err(await act(t.ctx, t.admin, 'signin', off({ version: 1 }))), 'sso_not_proven');
    assert.equal((await t.signIn(ADMIN_CLAIMS)).location, `${ORIGIN}/`);
    // Not together with a change of provider, client or secret: the proof was for the saved configuration.
    assert.equal(await err(await act(t.ctx, t.admin, 'signin', off({ version: 1, clientId: 'another-client' }))), 'sso_not_proven');
    assert.equal(await err(await act(t.ctx, t.admin, 'signin', off({ version: 1, clientSecret: 'a-new-secret-value' }))), 'sso_not_proven');
    assert.equal(await err(await act(t.ctx, t.admin, 'signin', off({ version: 1, issuer: 'https://other.example.test' }))), 'sso_not_proven');
    assert.equal((await state()).passwordLogin, true);

    assert.equal((await act(t.ctx, t.admin, 'signin', off({ version: 1 }))).status, 200);
    assert.deepEqual(await state(), { oidcLabel: 'single sign-on', passwordLogin: false });
    // Passwords are refused for everyone, with their own message, before any password work, and without counting toward lockout.
    for (let i = 0; i < 8; i++) {
      const r = await loginJson(handlers, t.ctx, 'admin@example.test');
      assert.equal(r.res.status, 403);
      assert.equal(await err(r.res), 'password_login_disabled');
    }
    assert.equal(await passwordWorks('sam@example.test'), false);
    assert.equal((await t.db.pool.query(`select count(*)::int n from login_attempts`)).rows[0].n, 0);
    // Existing sessions and provider sign-in keep working; so does password confirmation for settings.
    assert.equal((await t.signIn(ADMIN_CLAIMS)).location, `${ORIGIN}/`);
    assert.ok(await authenticate(t.db.pool, t.config, t.admin.cookie.split('=')[1]));

    // Break-glass: the environment switch, read at start-up.
    const forced = { config: testConfig({ TALLYMED_SECRETS_KEY: KEY, TALLYMED_OIDC_ALLOW_INSECURE_ISSUER: 'true', TALLYMED_PASSWORD_LOGIN: 'on' }, t.db.url), pool: t.db.pool };
    assert.equal((await loginJson(handlers, forced, 'admin@example.test')).res.status, 200);
    assert.equal((await signinState(t.db.pool, forced.config)).passwordLogin, true);
    // The stored client secret becomes unreadable (the secrets key changed or was removed): provider sign-in is unusable, passwords return.
    const rekeyed = testConfig({ TALLYMED_SECRETS_KEY: 'Zq7Wm3Kx9Rv2Lp5NhY8cTb4Jd6FgS1aUeXo0Ab1Cd2E=', TALLYMED_OIDC_ALLOW_INSECURE_ISSUER: 'true' }, t.db.url);
    assert.deepEqual(await signinState(t.db.pool, rekeyed), { oidcLabel: null, passwordLogin: true });
    assert.deepEqual(await signinState(t.db.pool, testConfig({ TALLYMED_OIDC_ALLOW_INSECURE_ISSUER: 'true' }, t.db.url)), { oidcLabel: null, passwordLogin: true });

    // The last linked administrator loses the link (or the role, or is disabled): passwords return by themselves.
    assert.equal(await passwordWorks(), false);
    const adminLink = (await t.db.pool.query(`select i.id from user_identities i join users u on u.id = i.user_id where u.role = 'admin'`)).rows[0].id;
    assert.equal(await err(await act(t.ctx, t.admin, 'signin/unlink', { identityId: adminLink, currentPassword: 'wrong password' })), 'reauth_failed');
    resetSettingsLimitersForTests();
    assert.equal((await act(t.ctx, t.admin, 'signin/unlink', { identityId: adminLink, currentPassword: PASSWORD })).status, 200);
    assert.deepEqual((await audit(t.db, 'auth.oidc_unlinked')).map((a) => a.detail.issuer), [t.provider.issuer]);
    assert.equal((await state()).passwordLogin, true);
    assert.equal(await passwordWorks(), true);
    assert.equal(await err(await act(t.ctx, t.admin, 'signin/unlink', { identityId: adminLink, currentPassword: PASSWORD })), 'not_found');
    // Linked again, passwords are off again; a demoted or disabled administrator does not count.
    assert.equal((await t.signIn(ADMIN_CLAIMS)).location, `${ORIGIN}/`);
    assert.equal((await state()).passwordLogin, false);
    await t.db.pool.query(`update users set role = 'operator' where email = 'admin@example.test'`);
    assert.equal((await state()).passwordLogin, true);
    await t.db.pool.query(`update users set role = 'admin' where email = 'admin@example.test'`);
    assert.equal((await state()).passwordLogin, false);

    // Turning provider sign-in off turns passwords back on in the same save.
    const fresh = await t.signIn(ADMIN_CLAIMS);
    const who = { cookie: fresh.session, csrf: (await import('../../apps/web/server/tokens.ts')).csrfFor(fresh.session.split('=')[1]) };
    assert.equal(await err(await act(t.ctx, who, 'signin', SIGNIN(t.provider.issuer, { version: 2, clientSecret: '', enabled: '', passwordLoginDisabled: 'yes' }))), 'invalid_input');
    assert.equal((await act(t.ctx, who, 'signin', SIGNIN(t.provider.issuer, { version: 2, clientSecret: '', enabled: '' }))).status, 200);
    assert.deepEqual(await state(), { oidcLabel: null, passwordLogin: true });
    assert.equal(errorOf(await handlers.handleOidcStart(get('/api/auth/oidc/start'), t.ctx)), 'sso_unavailable');
  } finally {
    await t.drop();
  }
});

test('sign-in attempts through the provider are limited per client and an unreachable provider fails closed', { skip: skipDb }, async () => {
  const t = await setup();
  try {
    let limited = null;
    for (let i = 0; i < 40 && !limited; i++) {
      const res = await handlers.handleOidcStart(get('/api/auth/oidc/start'), t.ctx);
      if (errorOf(res) === 'rate_limited') limited = i;
    }
    assert.equal(limited, 30);
    resetSigninLimitersForTests(); resetOidcCachesForTests();
    await t.provider.close();
    t.provider.close = async () => {};
    const res = await handlers.handleOidcStart(get('/api/auth/oidc/start'), t.ctx);
    assert.equal(errorOf(res), 'sso_unavailable');
    // Password sign-in is untouched by a provider outage.
    assert.equal((await loginJson(handlers, t.ctx, 'admin@example.test')).res.status, 200);
  } finally {
    await t.drop();
  }
});
