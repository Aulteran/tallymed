// Shared helpers for private-app tests. All data is fabricated. Database tests require a disposable
// PostgreSQL server: set TALLYMED_TEST_DATABASE_URL to a superuser-capable URL (any database name).
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createPool } from '../../apps/web/server/db.ts';
import { loadConfig } from '../../apps/web/server/config.ts';
import { migrate } from '../../apps/web/server/migrate.ts';
import { bootstrapAdmin } from '../../apps/web/server/services/bootstrap.ts';

export const ADMIN_URL = process.env.TALLYMED_TEST_DATABASE_URL;
if (!ADMIN_URL && process.env.CI) throw new Error('TALLYMED_TEST_DATABASE_URL is required in CI');
export const skipDb = ADMIN_URL ? false : 'set TALLYMED_TEST_DATABASE_URL to run PostgreSQL tests';
export const ORIGIN = 'https://tallymed.test';
export const PROXY_SECRET = 'proxy-secret-for-tests-0123456789abcdef';
export const PASSWORD = 'correct horse battery staple';

/** Creates an isolated database and returns a pool plus cleanup. */
export async function freshDatabase({ migrateAll = true } = {}) {
  const name = `tallymed_t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const pool = createPool(url.href, 6);
  if (migrateAll) await migrate(pool);
  return {
    pool, url: url.href, name,
    async drop() {
      await pool.end();
      const c = new pg.Client({ connectionString: ADMIN_URL });
      await c.connect();
      await c.query(`drop database if exists ${name} with (force)`);
      await c.end();
    },
  };
}

export function testConfig(overrides = {}, databaseUrl = 'postgres://unused/unused') {
  return loadConfig({
    DATABASE_URL: databaseUrl, TALLYMED_CANONICAL_ORIGIN: ORIGIN, TALLYMED_PROXY_SECRET: PROXY_SECRET, ...overrides,
  });
}

export async function seedHousehold(pool, { name = 'Example Family', email = 'admin@example.test' } = {}) {
  return bootstrapAdmin(pool, { householdName: name, email, displayName: 'Alex Example', password: PASSWORD });
}

export function post(path, body, { cookie, origin = ORIGIN, headers = {}, type = 'form', html = false } = {}) {
  const h = new Headers({ ...headers });
  if (origin) h.set('origin', origin);
  if (cookie) h.set('cookie', cookie);
  if (html) h.set('accept', 'text/html');
  let payload;
  if (type === 'json') {
    h.set('content-type', 'application/json');
    payload = JSON.stringify(body);
  } else if (type === 'form') {
    h.set('content-type', 'application/x-www-form-urlencoded');
    payload = new URLSearchParams(body).toString();
  } else {
    payload = body;
    if (type) h.set('content-type', type);
  }
  return new Request(`http://app.internal:3000${path}`, { method: 'POST', headers: h, body: payload });
}

export function cookieFrom(response) {
  const set = response.headers.get('set-cookie');
  return set ? set.split(';')[0] : null;
}

export async function loginJson(handlers, ctx, email, password = PASSWORD, extra = {}) {
  const res = await handlers.handleLogin(post('/api/auth/login', { email, password }, { type: 'json', ...extra }), ctx);
  const data = await res.clone().json().catch(() => ({}));
  return { res, cookie: cookieFrom(res), csrf: data.csrfToken, data };
}
