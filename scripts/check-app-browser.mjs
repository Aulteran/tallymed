// Browser workflow check for the private app's expense screens, using synthetic data only.
// Run `npm run build -w @tallymed/web` first. Requires TALLYMED_TEST_DATABASE_URL (a disposable PostgreSQL
// server) and Playwright's Chromium (or CHROMIUM_PATH). The app runs on loopback over http, which the canonical
// origin rules allow, so no proxy is needed here; HTTPS behaviour is covered by `npm run test:proxy`.
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync } from 'node:fs';
import net from 'node:net';
import pg from 'pg';
import { chromium } from 'playwright';

const ADMIN_URL = process.env.TALLYMED_TEST_DATABASE_URL;
if (!ADMIN_URL) throw new Error('TALLYMED_TEST_DATABASE_URL is required');
const server = 'apps/web/.next/standalone/apps/web/server.js';
if (!existsSync(server)) throw new Error('Run `npm run build -w @tallymed/web` first');

// The standalone server needs the static assets copied next to it, as the Dockerfile does.
cpSync('apps/web/.next/static', 'apps/web/.next/standalone/apps/web/.next/static', { recursive: true });

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const dbName = `tallymed_ui_${randomBytes(5).toString('hex')}`;
const password = 'synthetic passphrase for tests';
let app;
let browser;
const ok = (name) => console.log(`ok - ${name}`);

async function cleanup() {
  await browser?.close().catch(() => {});
  app?.kill('SIGTERM');
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${dbName} with (force)`).catch(() => {});
  await admin.end();
}

try {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`create database ${dbName}`);
  await admin.end();
  const dbUrl = new URL(ADMIN_URL);
  dbUrl.pathname = `/${dbName}`;
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env, DATABASE_URL: dbUrl.href, TALLYMED_CANONICAL_ORIGIN: origin, TALLYMED_SOURCE_URL: 'https://github.com/example/tallymed',
    NEXT_TELEMETRY_DISABLED: '1', TALLYMED_BOOTSTRAP_EMAIL: 'admin@example.test', TALLYMED_BOOTSTRAP_NAME: 'Alex Example', TALLYMED_HOUSEHOLD_NAME: 'Example Family',
  };
  let r = spawnSync('node', ['apps/web/cli/migrate.ts'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  r = spawnSync('node', ['apps/web/cli/bootstrap.ts'], { env, input: `${password}\n`, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  app = spawn('node', [server], { env: { ...env, PORT: String(port), HOSTNAME: '127.0.0.1', NODE_ENV: 'production' }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    if (await new Promise((res) => net.connect(port, '127.0.0.1').on('connect', function () { this.end(); res(true); }).on('error', () => res(false)))) break;
    await new Promise((res) => setTimeout(res, 200));
  }

  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await (await browser.newContext()).newPage();
  const a11y = async (name) => {
    const { violations } = await new AxeBuilder({ page }).analyze();
    assert.deepEqual(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html + " " + n.any.map((a) => a.message).join(";")).join(" | ")}`), [], `accessibility on ${name}`);
  };
  const text = () => page.locator('main').innerText();

  await page.goto(`${origin}/login`);
  await page.fill('#email', 'admin@example.test');
  await page.fill('#password', password);
  await page.click('button[type=submit]');
  await page.waitForURL(`${origin}/`);
  assert.match(await text(), /Overview/);
  await a11y('overview');
  ok('sign in lands on the expense overview');

  await page.goto(`${origin}/members`);
  await page.fill('#name', 'Pat Example');
  await page.click('form[action="/api/expenses/members/create"] button[type=submit]');
  await page.waitForURL(/\/members\/[0-9a-f-]{36}$/);
  await a11y('member detail');
  await page.goto(`${origin}/providers`);
  await page.fill('#name', 'Example Clinic');
  await page.click('form[action="/api/expenses/providers/create"] button[type=submit]');
  await page.waitForURL(/\/providers\/[0-9a-f-]{36}$/);
  await page.goto(`${origin}/providers`);
  await page.fill('#name', 'Example Lab');
  await page.selectOption('#kind', 'lab');
  await page.click('form[action="/api/expenses/providers/create"] button[type=submit]');
  await page.waitForURL(/\/providers\/[0-9a-f-]{36}$/);
  ok('member and providers created');

  await page.goto(`${origin}/visits`);
  await page.selectOption('#v-member', { label: 'Pat Example' });
  await page.selectOption('#v-provider', { label: 'Example Clinic' });
  await page.fill('#serviceDate', '2026-02-14');
  await page.fill('#description', 'Knee injury');
  await page.click('form[action="/api/expenses/visits/create"] button[type=submit]');
  await page.waitForURL(/\/visits\/[0-9a-f-]{36}$/);
  await a11y('visit detail');
  ok('visit recorded');

  const enterBill = async ({ provider, reference, amount, responsibility, status, visit }) => {
    await page.goto(`${origin}/bills/new`);
    await page.selectOption('#memberId', { label: 'Pat Example' });
    await page.selectOption('#providerId', { label: provider });
    if (visit) await page.selectOption('#visitId', { index: 1 });
    await page.fill('#providerReference', reference);
    await page.fill('#statementDate', '2026-02-20');
    await page.fill('#originalAmount', amount);
    if (responsibility) await page.fill('#responsibilityAmount', responsibility);
    await page.selectOption('#amountStatus', status);
    await page.click('form[action="/api/expenses/bills/create"] button[type=submit]');
  };
  await page.goto(`${origin}/bills/new`);
  await a11y('bill entry');
  await enterBill({ provider: 'Example Clinic', reference: 'INV-1', amount: '300.00', responsibility: '120.50', status: 'confirmed', visit: true });
  await page.waitForURL(/\/bills\/[0-9a-f-]{36}$/);
  const billUrl = page.url();
  assert.match(await text(), /\$120\.50/);
  await enterBill({ provider: 'Example Lab', reference: 'LAB-1', amount: '80.10', status: 'estimate' });
  await page.waitForURL(/\/bills\/[0-9a-f-]{36}$/);
  assert.match(await text(), /Awaiting visit assignment/);
  ok('two provider bills entered, one awaiting a visit');

  // Duplicate hint warns, preserves what was typed, and saves only when confirmed.
  await enterBill({ provider: 'Example Clinic', reference: 'inv 1', amount: '301.00', status: 'confirmed' });
  await page.waitForURL(/\/bills\/new\?/);
  assert.match(await text(), /similar bill already exists/);
  assert.equal(await page.inputValue('#originalAmount'), '301.00');
  assert.equal(await page.inputValue('#statementDate'), '2026-02-20');
  await a11y('bill entry with duplicate warning');
  await page.check('input[name=confirmDuplicate]');
  await page.click('form[action="/api/expenses/bills/create"] button[type=submit]');
  await page.waitForURL(/\/bills\/[0-9a-f-]{36}$/);
  assert.match(await text(), /Possible duplicate/);
  ok('duplicate warning keeps input and requires confirmation');

  // Adjustments: an invalid amount keeps the form, a valid one changes responsibility.
  await page.goto(billUrl);
  await a11y('bill detail');
  await page.fill('#amount', '-25.005');
  await page.fill('#effectiveDate', '2026-03-01');
  await page.fill('#reason', 'EOB allowed amount');
  await page.evaluate(() => document.querySelector('#amount').removeAttribute('pattern'));
  await page.click('form[action="/api/expenses/adjustments/create"] button[type=submit]');
  await page.waitForURL(/error=invalid_input/);
  assert.equal(await page.inputValue('#amount'), '-25.005');
  await page.fill('#amount', '-25.50');
  await page.click('form[action="/api/expenses/adjustments/create"] button[type=submit]');
  await page.waitForURL(`${billUrl}`);
  assert.match(await text(), /\$95\.00/);
  ok('adjustment posted and responsibility recomputed ($120.50 - $25.50)');

  // Payments: record cash against the bill, refund part of it, and see the bill balance follow the posted events.
  const billId = billUrl.split('/').pop();
  await page.goto(`${origin}/payments?billId=${billId}`);
  await a11y('payments list and entry form');
  await page.fill('#paidOn', '2026-03-05');
  await page.fill('#amount', '100.00');
  await page.fill('#reference', 'CARD-1234');
  await page.fill('#allocateAmount', '95.00');
  await page.click('form[action="/api/expenses/payments/create"] button[type=submit]');
  await page.waitForURL(/\/payments\/[0-9a-f-]{36}$/);
  const paymentUrl = page.url();
  assert.match(await text(), /Applied to bills\s*\n?\s*\$95\.00/);
  assert.match(await text(), /Unapplied\s*\n?\s*\$5\.00/);
  await a11y('payment detail');
  await page.fill('form[action="/api/expenses/payments/refund"] input[name=amount]', '10.00');
  await page.fill('form[action="/api/expenses/payments/refund"] input[name=reason]', 'Provider refund after review');
  await page.click('form[action="/api/expenses/payments/refund"] button[type=submit]');
  await page.waitForURL(paymentUrl);
  assert.match(await text(), /Net cash paid\s*\n?\s*\$90\.00/);
  await page.goto(billUrl);
  assert.match(await text(), /Net payments applied\s*\n?\s*\$85\.00/);
  assert.match(await text(), /Open balance\s*\n?\s*\$10\.00/);
  await a11y('bill detail with payments');
  ok('payment recorded, refunded in part, and the bill balance follows ($95.00 - $85.00 net applied)');

  // A payment plan is an obligation. Matching an installment references the cash and changes no balance.
  await page.goto(`${origin}/plans`);
  await a11y('plans list and form');
  await page.fill('#name', 'Clinic plan');
  await page.selectOption('#providerId', { label: 'Example Clinic' });
  await page.selectOption('#billId', { value: billId });
  await page.fill('#totalAmount', '30.00');
  await page.fill('#installmentCount', '3');
  await page.fill('#firstDueDate', '2026-01-15');
  await page.click('form[action="/api/expenses/plans/create"] button[type=submit]');
  await page.waitForURL(/\/plans\/[0-9a-f-]{36}$/);
  const planUrl = page.url();
  assert.match(await text(), /Overdue/);
  await page.selectOption('#installmentId', { index: 1 });
  await page.selectOption('#allocationId', { index: 1 });
  await page.fill('#amount', '5.00');
  await page.click('form[action="/api/expenses/plans/match"] button[type=submit]');
  await page.waitForURL(planUrl);
  assert.match(await text(), /Matched to payments\s*\n?\s*\$5\.00/);
  assert.match(await text(), /Partial/);
  await a11y('plan detail');
  await page.goto(billUrl);
  assert.match(await text(), /Open balance\s*\n?\s*\$10\.00/);
  await page.goto(`${origin}/`);
  assert.match(await text(), /Overdue installments\s*\n?\s*\$25\.00/);
  await a11y('overview with payments and plans');
  ok('plan created, installment partly matched, bill balance unchanged, overdue queue on the overview');

  await page.goto(`${origin}/`);
  const overview = await text();
  assert.match(overview, /Bills awaiting a visit\s*\n?\s*2/);
  assert.match(overview, /Estimated, not confirmed/);
  await page.goto(`${origin}/bills?awaitingVisit=yes`);
  assert.match(await text(), /LAB-1/);
  await a11y('bills list');
  await page.setViewportSize({ width: 390, height: 800 });
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth, width: window.innerWidth,
    wide: [...document.querySelectorAll('body *:not(thead *)')].filter((e) => e.tagName !== 'THEAD' && e.getBoundingClientRect().right > window.innerWidth + 1)
      .map((e) => `${e.tagName}.${e.className}#${e.id}:${Math.round(e.getBoundingClientRect().left)}-${Math.round(e.getBoundingClientRect().right)}:${getComputedStyle(e).display}`).slice(0, 8),
  }));
  assert.ok(overflow.scrollWidth <= overflow.width, `no horizontal page scroll on a phone: ${JSON.stringify(overflow)}`);
  for (const path of [paymentUrl, planUrl, `${origin}/payments`, `${origin}/plans`]) {
    await page.goto(path);
    const o = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, width: window.innerWidth }));
    assert.ok(o.scrollWidth <= o.width, `no horizontal page scroll on a phone at ${path}: ${JSON.stringify(o)}`);
  }
  ok('overview queues and filtered list work; phone layout does not overflow');
} finally {
  await cleanup();
}
