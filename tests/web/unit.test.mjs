import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadConfig, parseCanonicalOrigin, sourceUrl } from '../../apps/web/server/config.ts';
import { redact } from '../../apps/web/server/log.ts';
import { can, authorize, assertHousehold } from '../../apps/web/server/authz.ts';
import { clientInfo } from '../../apps/web/server/proxy.ts';
import { hashPassword, verifyPassword } from '../../apps/web/server/passwords.ts';

const base = { DATABASE_URL: 'postgres://x/y', TALLYMED_CANONICAL_ORIGIN: 'https://tallymed.example' };

test('canonical origin requires https except loopback and rejects paths and credentials', () => {
  assert.deepEqual(parseCanonicalOrigin('https://tallymed.example/'), { origin: 'https://tallymed.example', secure: true });
  assert.deepEqual(parseCanonicalOrigin('http://localhost:3001'), { origin: 'http://localhost:3001', secure: false });
  for (const bad of [undefined, '', 'http://tallymed.example', 'https://u:p@tallymed.example', 'https://tallymed.example/app', 'https://tallymed.example?x=1', 'ftp://x', 'nope']) {
    assert.throws(() => parseCanonicalOrigin(bad), undefined, String(bad));
  }
});

test('config validates secrets, ttls and the source link', () => {
  assert.throws(() => loadConfig({ ...base, TALLYMED_PROXY_SECRET: 'short' }));
  assert.throws(() => loadConfig({ ...base, TALLYMED_SESSION_ABSOLUTE_SECONDS: '5' }));
  assert.throws(() => loadConfig({ TALLYMED_CANONICAL_ORIGIN: base.TALLYMED_CANONICAL_ORIGIN }));
  const c = loadConfig(base);
  assert.equal(c.proxySecret, null);
  assert.equal(c.secureCookies, true);
  assert.equal(sourceUrl('https://github.com/example/tallymed'), 'https://github.com/example/tallymed');
  assert.equal(sourceUrl('javascript:alert(1)'), null);
  assert.equal(sourceUrl('https://u:p@x.example'), null);
});

test('proxy headers are ignored without the secret', () => {
  const c = loadConfig({ ...base, TALLYMED_PROXY_SECRET: 's'.repeat(32) });
  assert.deepEqual(clientInfo(new Headers({ 'x-forwarded-for': '1.1.1.1' }), c), { trustedProxy: false, trustedBy: null, peer: null, ip: null });
  assert.deepEqual(clientInfo(new Headers({ 'x-tallymed-proxy-secret': 's'.repeat(32), 'x-forwarded-for': '6.6.6.6, 1.1.1.1' }), c), { trustedProxy: true, trustedBy: 'secret', peer: null, ip: '1.1.1.1' });
  assert.deepEqual(clientInfo(new Headers({ 'x-tallymed-proxy-secret': 's'.repeat(32) }), c), { trustedProxy: true, trustedBy: 'secret', peer: null, ip: null });
});

test('redaction removes credentials, cookies, tokens and emails', () => {
  const out = redact({ password: 'p', Authorization: 'Bearer x', cookie: 'c', nested: { csrfToken: 't', ok: 1, email: 'a@example.test' }, list: [{ sessionId: 's' }] });
  assert.equal(JSON.stringify(out).includes('Bearer'), false);
  assert.deepEqual(out.nested, { csrfToken: '[redacted]', ok: 1, email: '[redacted]' });
  assert.equal(out.list[0].sessionId, '[redacted]');
});

test('capabilities and household scope', () => {
  const admin = { userId: 'u', householdId: 'h1', role: 'admin', displayName: 'A', sessionId: 's' };
  const op = { ...admin, role: 'operator' };
  assert.ok(can(admin, 'operators:manage') && !can(op, 'operators:manage') && can(op, 'household:read'));
  assert.throws(() => authorize(op, 'operators:manage'), { code: 'forbidden' });
  assert.throws(() => assertHousehold(op, 'h2'), { code: 'not_found' });
  assert.doesNotThrow(() => assertHousehold(op, 'h1'));
});

test('passwords use argon2id and enforce length', async () => {
  const h = await hashPassword('correct horse battery staple');
  assert.match(h, /^\$argon2id\$/);
  assert.equal(await verifyPassword(h, 'correct horse battery staple'), true);
  assert.equal(await verifyPassword(h, 'wrong'), false);
  assert.equal(await verifyPassword(null, 'anything'), false);
  await assert.rejects(hashPassword('short'), { code: 'invalid_input' });
});

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    if (['node_modules', '.next'].includes(e)) continue;
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

test('private app boundaries: client code never imports server modules; routes stay thin', () => {
  for (const file of walk('apps/web')) {
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const src = readFileSync(file, 'utf8');
    if (/^['"]use client['"]/m.test(src)) assert.ok(!/server\//.test(src), `${file} is a client component importing server code`);
    assert.ok(!src.includes('dangerouslySetInnerHTML'), file);
    if (file.includes(`${path.sep}app${path.sep}`) && !file.includes('components')) {
      assert.ok(!/from 'pg'|@node-rs\/argon2/.test(src), `${file} must reach PostgreSQL and hashing only through server/ services`);
    }
  }
});
