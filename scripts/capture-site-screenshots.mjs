// Captures the product screenshots used on the marketing site, from the real app running locally on FABRICATED data only.
// Run `npm run build -w @tallymed/web` first. Requires TALLYMED_TEST_DATABASE_URL (a disposable PostgreSQL server),
// Playwright's Chromium (or CHROMIUM_PATH) and TALLYMED_SCREENSHOT_DIR (output folder). Never point this at a real deployment:
// it creates its own throwaway database and household, and drops the database when it finishes.
// Output: one PNG per view and colour scheme, named <view>-<light|dark>.png. The site ships them as compressed WebP
// (see apps/marketing/public/screens/README.md for the conversion).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { chromium } from 'playwright';

const ADMIN_URL = process.env.TALLYMED_TEST_DATABASE_URL;
const outDir = process.env.TALLYMED_SCREENSHOT_DIR;
if (!ADMIN_URL || !outDir) throw new Error('TALLYMED_TEST_DATABASE_URL and TALLYMED_SCREENSHOT_DIR are required');
const server = 'apps/web/.next/standalone/apps/web/server.js';
if (!existsSync(server)) throw new Error('Run `npm run build -w @tallymed/web` first');
mkdirSync(outDir, { recursive: true });
cpSync('apps/web/.next/static', 'apps/web/.next/standalone/apps/web/.next/static', { recursive: true });

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const dbName = `tallymed_shots_${randomBytes(5).toString('hex')}`;
const password = 'synthetic passphrase for screenshots';
const setupToken = randomBytes(24).toString('base64url');
let app;
let browser;

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
    ...process.env, TALLYMED_DOCUMENTS_DIR: mkdtempSync(path.join(tmpdir(), 'tallymed-shots-docs-')), DATABASE_URL: dbUrl.href,
    TALLYMED_CANONICAL_ORIGIN: origin, TALLYMED_SOURCE_URL: 'https://github.com/example/tallymed', NEXT_TELEMETRY_DISABLED: '1', TALLYMED_SETUP_TOKEN: setupToken,
  };
  const migrated = spawnSync('node', ['apps/web/cli/migrate.ts'], { env, encoding: 'utf8' });
  assert.equal(migrated.status, 0, migrated.stderr);
  app = spawn('node', [server], { env: { ...env, PORT: String(port), HOSTNAME: '127.0.0.1', NODE_ENV: 'production' }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    if (await new Promise((res) => net.connect(port, '127.0.0.1').on('connect', function () { this.end(); res(true); }).on('error', () => res(false)))) break;
    await new Promise((res) => setTimeout(res, 200));
  }

  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const newPage = async (colorScheme) => {
    const page = await (await browser.newContext({ colorScheme, viewport: { width: 1440, height: 900 } })).newPage();
    return page;
  };
  const signIn = async (page) => {
    await page.goto(`${origin}/login`);
    await page.fill('#email', 'alex@example.test');
    await page.fill('#password', password);
    await page.click('button[type=submit]');
    await page.waitForURL(`${origin}/`);
  };

  // --- Fabricated household: names, providers, dates and amounts are all invented. -----------------------------------
  const page = await newPage('light');
  await page.goto(`${origin}/setup`);
  await page.fill('#setupToken', setupToken);
  await page.fill('#householdName', 'Example Family');
  await page.fill('#displayName', 'Alex Example');
  await page.fill('#email', 'alex@example.test');
  await page.fill('#password', password);
  await page.click('button[type=submit]');
  await page.waitForURL(`${origin}/login?notice=setup_complete`);
  await signIn(page);

  const add = async (listPath, button, formAction, fill) => {
    await page.goto(`${origin}${listPath}`);
    await page.click(`.page-head .page-action button:has-text("${button}")`);
    await page.locator('dialog.form-modal').waitFor({ state: 'visible' });
    await fill();
    await page.click(`form[action="${formAction}"] button[type=submit]`);
    await page.waitForURL(/\/[0-9a-f-]{36}$/);
  };
  for (const name of ['Alex Example', 'Pat Example', 'Sam Example']) await add('/members', 'Add family member', '/api/expenses/members/create', () => page.fill('#name', name));
  for (const [name, kind] of [['Example Clinic', 'clinician'], ['Sample Imaging', 'facility'], ['Sample Pharmacy', 'pharmacy'], ['Example Lab', 'lab'], ['Sample Dental', 'clinician']]) {
    await add('/providers', 'Add provider', '/api/expenses/providers/create', async () => { await page.fill('#name', name); await page.selectOption('#kind', kind); });
  }
  const visit = (member, provider, date, description) => add('/visits', 'Add visit', '/api/expenses/visits/create', async () => {
    await page.selectOption('#v-member', { label: member }); await page.selectOption('#v-provider', { label: provider });
    await page.fill('#serviceDate', date); await page.fill('#description', description);
  });
  await visit('Pat Example', 'Example Clinic', '2026-08-14', 'Knee injury follow-up');
  await visit('Sam Example', 'Sample Dental', '2026-09-02', 'Dental cleaning and X-rays');
  await visit('Alex Example', 'Sample Imaging', '2026-08-26', 'MRI scan');

  const bill = async ({ member, provider, reference, date, amount, responsibility, status, visitDescription }) => {
    await page.goto(`${origin}/bills/new`);
    await page.selectOption('#memberId', { label: member });
    await page.selectOption('#providerId', { label: provider });
    if (visitDescription) await page.selectOption('#visitId', { label: await page.locator('#visitId option', { hasText: visitDescription }).first().textContent() });
    await page.fill('#providerReference', reference);
    await page.fill('#statementDate', date);
    await page.fill('#originalAmount', amount);
    if (responsibility) await page.fill('#responsibilityAmount', responsibility);
    await page.selectOption('#amountStatus', status);
    await page.click('form[action="/api/expenses/bills/create"] button[type=submit]');
    await page.waitForURL(/\/bills\/[0-9a-f-]{36}$/);
    return page.url().split('/').pop();
  };
  const clinicBill = await bill({ member: 'Pat Example', provider: 'Example Clinic', reference: 'INV-2041', date: '2026-08-20', amount: '300.00', responsibility: '120.50', status: 'confirmed', visitDescription: 'Example Clinic' });
  const imagingBill = await bill({ member: 'Alex Example', provider: 'Sample Imaging', reference: 'MRI-7733', date: '2026-09-05', amount: '1200.00', responsibility: '450.00', status: 'confirmed', visitDescription: 'Sample Imaging' });
  const dentalBill = await bill({ member: 'Sam Example', provider: 'Sample Dental', reference: 'D-5518', date: '2026-09-10', amount: '190.00', responsibility: '95.00', status: 'confirmed', visitDescription: 'Sample Dental' });
  const pharmacyBill = await bill({ member: 'Pat Example', provider: 'Sample Pharmacy', reference: 'RX-90312', date: '2026-09-18', amount: '42.18', status: 'confirmed' });
  await bill({ member: 'Pat Example', provider: 'Example Lab', reference: 'LAB-1180', date: '2026-10-02', amount: '186.40', status: 'estimate' });

  const pay = async (billId, paidOn, amount, reference, allocate) => {
    await page.goto(`${origin}/payments?billId=${billId}`);
    await page.locator('dialog.form-modal').waitFor({ state: 'visible' });
    await page.fill('#paidOn', paidOn);
    await page.fill('#amount', amount);
    await page.fill('#reference', reference);
    await page.fill('#allocateAmount', allocate);
    await page.click('form[action="/api/expenses/payments/create"] button[type=submit]');
    await page.waitForURL(/\/payments\/[0-9a-f-]{36}$/);
  };
  await pay(clinicBill, '2026-09-01', '120.50', 'CARD-0412', '120.50');
  await pay(dentalBill, '2026-09-22', '95.00', 'CARD-0412', '95.00');
  await pay(pharmacyBill, '2026-09-18', '42.18', 'CARD-0412', '42.18');
  await pay(imagingBill, '2026-09-20', '75.00', 'ACH-2209', '75.00');
  await pay(imagingBill, '2026-10-16', '50.00', 'ACH-2257', '50.00');

  // A six-installment plan on the imaging bill: the first installment paid, the second part-paid, the third overdue.
  await add('/plans', 'Create plan', '/api/expenses/plans/create', async () => {
    await page.fill('#name', 'Imaging payment plan'); await page.selectOption('#providerId', { label: 'Sample Imaging' });
    await page.selectOption('#billId', { value: imagingBill }); await page.fill('#totalAmount', '450.00');
    await page.fill('#installmentCount', '6'); await page.fill('#firstDueDate', '2026-09-20');
  });
  const planUrl = page.url();
  for (const [amount, paidOn] of [['75.00', '2026-09-20'], ['50.00', '2026-10-16']]) {
    await page.selectOption('#installmentId', { index: 1 });
    await page.selectOption('#allocationId', { label: await page.locator('#allocationId option', { hasText: paidOn }).first().textContent() });
    await page.fill('#amount', amount);
    await page.click('form[action="/api/expenses/plans/match"] button[type=submit]');
    await page.waitForURL(planUrl);
  }

  // HSA: decide eligibility on three payments, claim one, and record a partial reimbursement.
  await page.goto(`${origin}/hsa`);
  const hrefs = await page.locator('a[href^="/hsa/allocations/"]').evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute('href')))]);
  assert.ok(hrefs.length >= 3, `expected HSA payments, found ${hrefs.length}`);
  let claimed = false;
  for (const href of hrefs) {
    await page.goto(`${origin}/hsa`);
    // The first money cell of the payment's row is its net cash; the whole amount is decided eligible.
    const netCash = (await page.locator(`tr:has(a[href="${href}"]) td`).nth(2).innerText()).replace(/[$,]/g, '').trim();
    await page.goto(`${origin}${href}`);
    await page.selectOption('#status', 'eligible');
    await page.fill('#eligibleAmount', netCash);
    await page.fill('#rationale', 'Qualified medical expense');
    await page.selectOption('#evidenceType', 'receipt');
    await page.fill('#evidenceNote', 'Receipt on file');
    await page.click('form[action="/api/expenses/hsa/decide"] button[type=submit]');
    await page.waitForURL(`${origin}${href}`);
    if (!claimed) {
      claimed = true;
      await page.fill('form[action="/api/expenses/hsa/claim"] #amount', netCash);
      await page.fill('#administrator', 'Example HSA Bank');
      await page.fill('#reference', 'CLM-0001');
      await page.click('form[action="/api/expenses/hsa/claim"] button[type=submit]');
      await page.waitForURL(/\/hsa\/claims\/[0-9a-f-]{36}$/);
      await page.fill('form[action="/api/expenses/hsa/receipt"] input[name=amount]', '25.00');
      await page.click('form[action="/api/expenses/hsa/receipt"] button[type=submit]');
      await page.waitForURL(/\/hsa\/receipts\/[0-9a-f-]{36}$/);
    }
  }

  // --- Capture: viewport-sized shots in light and dark. ---------------------------------------------------------------
  const views = [['overview', '/'], ['visits', '/visits'], ['bills', '/bills'], ['plan', planUrl.replace(origin, '')], ['hsa', '/hsa']];
  for (const scheme of ['light', 'dark']) {
    const p = scheme === 'light' ? page : await newPage('dark');
    if (scheme === 'dark') await signIn(p);
    for (const [name, route] of views) {
      await p.goto(`${origin}${route}`, { waitUntil: 'networkidle' });
      await p.evaluate(() => window.scrollTo(0, 0));
      await p.screenshot({ path: path.join(outDir, `${name}-${scheme}.png`) });
    }
  }
  console.log('screenshots written to', outDir);
} finally {
  await browser?.close().catch(() => {});
  app?.kill('SIGTERM');
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${dbName} with (force)`).catch(() => {});
  await admin.end();
}
