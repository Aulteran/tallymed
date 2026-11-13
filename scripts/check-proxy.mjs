// HTTPS reverse-proxy and network-boundary check for the private app, using synthetic data only.
// Builds nothing: run `npm run build -w @tallymed/web` first. Requires TALLYMED_TEST_DATABASE_URL
// (a disposable PostgreSQL server) and openssl. A test-only Node proxy stands in for the operator's
// TLS proxy and applies the documented header policy (strip client values, set secret and forwarded headers).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';

const ADMIN_URL = process.env.TALLYMED_TEST_DATABASE_URL;
if (!ADMIN_URL) throw new Error('TALLYMED_TEST_DATABASE_URL is required');
const server = 'apps/web/.next/standalone/apps/web/server.js';
if (!existsSync(server)) throw new Error('Run `npm run build -w @tallymed/web` first');

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const tmp = mkdtempSync(path.join(os.tmpdir(), 'tallymed-proxy-'));
const dbName = `tallymed_proxy_${randomBytes(5).toString('hex')}`;
const secret = randomBytes(24).toString('hex');
const password = 'synthetic passphrase for tests';
const children = [];
let proxy;
const results = [];
const ok = (name) => { results.push(name); console.log(`ok - ${name}`); };

async function cleanup() {
  proxy?.close();
  for (const c of children) c.kill('SIGTERM');
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${dbName} with (force)`).catch(() => {});
  await admin.end();
  rmSync(tmp, { recursive: true, force: true });
}

try {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`create database ${dbName}`);
  await admin.end();
  const dbUrl = new URL(ADMIN_URL);
  dbUrl.pathname = `/${dbName}`;

  const [upstreamPort, proxyPort] = [await freePort(), await freePort()];
  const origin = `https://localhost:${proxyPort}`;
  const env = {
    ...process.env, DATABASE_URL: dbUrl.href, TALLYMED_CANONICAL_ORIGIN: origin, TALLYMED_PROXY_SECRET: secret,
    TALLYMED_SOURCE_URL: 'https://github.com/example/tallymed', NEXT_TELEMETRY_DISABLED: '1',
  };
  const r = spawnSync('node', ['apps/web/cli/migrate.ts'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  ok('CLI migration works');

  const key = path.join(tmp, 'key.pem'); const crt = path.join(tmp, 'crt.pem');
  const ssl = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', crt,
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { encoding: 'utf8' });
  assert.equal(ssl.status, 0, ssl.stderr);
  const ca = readFileSync(crt);

  const app = spawn('node', [server], { env: { ...env, PORT: String(upstreamPort), HOSTNAME: '127.0.0.1', NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(app);
  let appLog = '';
  app.stdout.on('data', (d) => { appLog += d; }); app.stderr.on('data', (d) => { appLog += d; });
  for (let i = 0; i < 100; i++) {
    if (await new Promise((res) => net.connect(upstreamPort, '127.0.0.1').on('connect', function () { this.end(); res(true); }).on('error', () => res(false)))) break;
    await new Promise((res) => setTimeout(res, 200));
  }

  // Test-only TLS proxy implementing the documented policy.
  proxy = https.createServer({ key: readFileSync(key), cert: ca }, (req, res) => {
    if (req.url.startsWith('/mcp')) { res.writeHead(404).end(); return; } // the web proxy never forwards to MCP
    const headers = { ...req.headers };
    for (const h of Object.keys(headers)) if (/^(x-forwarded-|x-real-ip|forwarded$|x-tallymed-proxy-secret$)/i.test(h)) delete headers[h];
    Object.assign(headers, { 'x-tallymed-proxy-secret': secret, 'x-forwarded-for': req.socket.remoteAddress, 'x-forwarded-proto': 'https', 'x-forwarded-host': `localhost:${proxyPort}` });
    const up = http.request({ host: '127.0.0.1', port: upstreamPort, method: req.method, path: req.url, headers }, (u) => { res.writeHead(u.statusCode, u.headers); u.pipe(res); });
    up.on('error', () => res.writeHead(502).end());
    req.pipe(up);
  }).listen(proxyPort, '127.0.0.1');

  const request = (method, p, { headers = {}, body, via = 'proxy' } = {}) => new Promise((resolve, reject) => {
    const lib = via === 'proxy' ? https : http;
    const rq = lib.request({ host: via === 'proxy' ? 'localhost' : '127.0.0.1', port: via === 'proxy' ? proxyPort : upstreamPort, method, path: p, ca, headers: { ...headers, ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) } }, (res) => {
      let data = ''; res.on('data', (d) => { data += d; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    rq.on('error', reject); rq.end(body);
  });
  const form = { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' };

  // First administrator through the web setup page. TALLYMED_SETUP_TOKEN is unset here, so the server generated a token
  // at startup and printed it to its console; the built server's startup hook must have done so.
  for (let i = 0; i < 50 && !/ {4}[A-Za-z0-9_-]{43}\n/.test(appLog); i++) await new Promise((res) => setTimeout(res, 100));
  const setupToken = / {4}([A-Za-z0-9_-]{43})\n/.exec(appLog)?.[1];
  assert.ok(setupToken, 'the server printed a generated setup token at startup');
  assert.ok(appLog.includes(`${origin}/setup`));
  assert.equal([...appLog.matchAll(new RegExp(setupToken, 'g'))].length, 1, 'the token is printed exactly once');
  let res = await request('GET', '/setup');
  assert.equal(res.status, 200);
  assert.match(res.body, /Create the first administrator/);
  assert.ok(!res.body.includes(setupToken));
  res = await request('GET', '/login');
  assert.match(res.body, /href="\/setup"/);
  const setupForm = (t, email = 'admin@example.test') => new URLSearchParams({ setupToken: t, householdName: 'Example Family', displayName: 'Alex Example', email, password }).toString();
  res = await request('POST', '/api/setup', { headers: { ...form, origin }, body: setupForm('not-the-token') });
  assert.equal(res.status, 303);
  assert.match(res.headers.location, /\/setup\?error=invalid_setup_token$/);
  res = await request('POST', '/api/setup', { headers: { ...form, origin: 'https://evil.example' }, body: setupForm(setupToken) });
  assert.match(res.headers.location, /\/setup\?error=csrf_failed$/);
  res = await request('POST', '/api/setup', { headers: { ...form, origin }, body: setupForm(setupToken) });
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, `${origin}/login?notice=setup_complete`);
  assert.equal((await request('GET', '/setup')).status, 404);
  res = await request('POST', '/api/setup', { headers: { ...form, origin }, body: setupForm(setupToken, 'second@example.test') });
  assert.match(res.headers.location, /\/setup\?error=not_found$/);
  assert.ok(!appLog.includes(password), 'the password never reaches the server log');
  ok('web setup: generated token printed once at startup, wrong token and cross-origin refused, one administrator created, /setup is 404 afterwards');
  const creds = (email, pw) => new URLSearchParams({ email, password: pw }).toString();

  res = await request('GET', '/healthz');
  assert.equal(res.status, 200);
  res = await request('GET', '/login');
  assert.equal(res.status, 200);
  assert.match(res.body, /Sign in/);
  assert.match(res.body, /GNU Affero General Public License/);
  assert.match(res.body, /href="https:\/\/github\.com\/example\/tallymed"/);
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  ok('HTTPS sign-in page loads through the proxy with license/source notice and security headers');

  res = await request('POST', '/api/auth/login', { headers: { ...form, origin: 'https://evil.example' }, body: creds('admin@example.test', password) });
  assert.equal(res.status, 303); // HTML clients are redirected back to /login with an error
  assert.match(res.headers.location, /\/login\?error=csrf_failed$/);
  assert.equal(res.headers['set-cookie'], undefined);
  ok('cross-origin sign-in is rejected through the proxy');

  res = await request('POST', '/api/auth/login', { headers: { ...form, origin, 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http', 'x-forwarded-for': '6.6.6.6', 'x-tallymed-proxy-secret': 'forged' }, body: creds('admin@example.test', password) });
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, `${origin}/`);
  const set = res.headers['set-cookie'][0];
  assert.match(set, /^__Host-tallymed_session=/);
  for (const a of ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/']) assert.ok(set.includes(a), a);
  const cookie = set.split(';')[0];
  ok('HTTPS sign-in redirects to the canonical origin and sets a __Host- Secure HttpOnly cookie despite forged headers');

  res = await request('GET', '/', { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.match(res.body, /Overview/);
  assert.match(res.body, /Operators/);
  assert.equal((await request('GET', '/operators', { headers: { cookie } })).status, 200);
  res = await request('GET', '/', { headers: { 'x-forwarded-host': 'evil.example' } });
  assert.ok([302, 303, 307].includes(res.status));
  assert.ok(!String(res.headers.location).includes('evil.example'));
  assert.match(String(res.headers.location), /\/login/);
  ok('authenticated shell renders; anonymous requests redirect to sign-in without echoing forged hosts');

  const csrf = /name="csrf" value="([^"]+)"/.exec((await request('GET', '/', { headers: { cookie } })).body)?.[1];
  assert.ok(csrf);
  const invite = (c, o = origin) => request('POST', '/api/operators/invite', { headers: { ...form, cookie, origin: o }, body: new URLSearchParams({ csrf: c, email: 'sam@example.test', role: 'operator' }).toString() });
  assert.match((await invite('wrong')).headers.location, /error=csrf_failed/);
  assert.match((await invite(csrf, 'https://evil.example')).headers.location, /error=csrf_failed/);
  res = await invite(csrf);
  assert.equal(res.status, 201);
  assert.match(res.body, new RegExp(`${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/invite/[A-Za-z0-9_-]{43}`));
  assert.equal(res.headers['cache-control'], 'no-store');
  ok('state change needs the CSRF token and canonical Origin; invitation link uses the canonical origin');

  res = await request('POST', '/api/auth/login', { headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ email: 'a@example.test', password: 'x'.repeat(20000) }) });
  assert.equal(res.status, 413);
  assert.equal((await request('GET', '/mcp')).status, 404);
  ok('oversized bodies are refused and the web proxy exposes no MCP path');

  res = await request('POST', '/api/auth/logout', { headers: { ...form, cookie, origin }, body: new URLSearchParams({ csrf }).toString() });
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, `${origin}/login`);
  assert.match(res.headers['set-cookie'][0], /Max-Age=0/);
  res = await request('GET', '/', { headers: { cookie } });
  assert.match(String(res.headers.location), /\/login/);
  ok('logout revokes the session server-side');

  // Direct-to-upstream requests (bypassing the proxy) cannot claim trusted forwarded headers.
  const probe = new pg.Client({ connectionString: dbUrl.href });
  await probe.connect();
  await request('POST', '/api/auth/login', { via: 'direct', headers: { ...form, origin, 'x-forwarded-for': '203.0.113.50', 'x-forwarded-proto': 'https' }, body: creds('x@example.test', 'wrong passphrase!!') });
  await request('POST', '/api/auth/login', { via: 'direct', headers: { ...form, origin, 'x-tallymed-proxy-secret': 'not-the-secret', 'x-forwarded-for': '203.0.113.51' }, body: creds('x@example.test', 'wrong passphrase!!') });
  const seen = (await probe.query(`select distinct client_ip from login_attempts where succeeded = false`)).rows.map((x) => x.client_ip);
  assert.ok(!seen.some((ip) => ip.startsWith('203.0.113.')), `spoofed addresses recorded: ${seen}`);
  res = await request('POST', '/api/auth/login', { via: 'direct', headers: { ...form, origin, 'x-tallymed-proxy-secret': secret, 'x-forwarded-proto': 'http' }, body: creds('admin@example.test', password) });
  assert.match(res.headers.location, /error=forbidden/);
  await probe.end();
  ok('direct upstream requests with spoofed forwarded headers are not trusted; plain-http from the trusted proxy is refused');

  // Network boundary: the upstream listens on loopback only, and Compose keeps the database private.
  const external = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
  if (external) {
    const reachable = await new Promise((resolve) => net.connect({ host: external.address, port: upstreamPort, timeout: 1500 }).on('connect', function () { this.destroy(); resolve(true); }).on('error', () => resolve(false)).on('timeout', function () { this.destroy(); resolve(false); }));
    assert.equal(reachable, false, 'upstream must not be reachable on a non-loopback address');
    ok(`upstream is not reachable on ${external.address}`);
  } else {
    console.log('skip - no non-loopback interface to probe; upstream loopback binding not verified from outside');
  }
  const compose = readFileSync('compose.yaml', 'utf8');
  assert.match(compose, /"127\.0\.0\.1:\$\{TALLYMED_WEB_PORT:-3001\}:3000"/);
  const dbBlock = compose.slice(compose.indexOf('  db:'), compose.indexOf('  web:'));
  assert.ok(!/ports:/.test(dbBlock), 'the database must not publish ports');
  ok('Compose publishes only the loopback web port and never the database');
  if (/error|ECONN/i.test(appLog) && /password|hunter|cookie/i.test(appLog)) throw new Error('application log may contain sensitive data');
  console.log(`# ${results.length} checks passed`);
} catch (error) {
  console.error('FAILED:', error.message);
  process.exitCode = 1;
} finally {
  await cleanup();
}
