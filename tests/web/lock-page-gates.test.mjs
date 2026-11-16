// The lock must close every page, not only the API. These checks read the page sources, because the pages run inside Next.js and cannot be
// called from a unit test; scripts/check-app-browser.mjs exercises the same gates in a real browser. Removing a gate fails here first.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const app = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../apps/web/app');
const read = (...p) => readFileSync(path.join(app, ...p), 'utf8');
const pages = (dir = app, base = '') => readdirSync(dir).flatMap((name) => {
  const full = path.join(dir, name);
  if (statSync(full).isDirectory()) return pages(full, `${base}/${name}`);
  return name === 'page.tsx' ? [base || '/'] : [];
});

// Pages that render no household data or that sit outside the signed-in app, and why each is allowed to skip requireSession.
const NO_HOUSEHOLD_DATA = {
  '/setup': 'first-administrator form, exists only before an administrator does',
  '/setup/restore': 'restore form, exists only before an administrator does',
  '/invite/[token]': 'account creation from an invitation link',
  '/login': 'sign-in form; redirects an existing session onward',
  '/password/forgot': 'reset request form; redirects an existing session onward',
  '/password/change': 'restricted temporary-password session only; shows a form and nothing else',
  '/locked': 'the PIN screen itself; renders no records',
};

test('every page that can show household data starts at requireSession, which refuses a locked session', () => {
  const gated = [];
  for (const page of pages()) {
    if (page in NO_HOUSEHOLD_DATA) continue;
    const source = read(...page.split('/').filter(Boolean), 'page.tsx');
    gated.push(page);
    assert.match(source, /requireSession\(/, `${page} must authenticate through requireSession (or be added to the allowlist with a reason)`);
  }
  assert.ok(gated.length > 20, 'the page list was found');
});

test('requireSession and the app layout both redirect a locked session to the PIN screen before any data loads', () => {
  const ui = read('components', 'ui.tsx');
  const body = ui.slice(ui.indexOf('export async function requireSession'), ui.indexOf('/** First value of each query parameter'));
  assert.match(body, /session\.actor\.locked\) redirect\('\/locked'\)/);
  assert.ok(body.indexOf("redirect('/locked')") < body.indexOf('return {'), 'the redirect comes before the session is handed to the page');
  const layout = read('(app)', 'layout.tsx');
  assert.match(layout, /session\.actor\.locked\) redirect\('\/locked'\)/);
  assert.ok(layout.indexOf("redirect('/locked')") < layout.indexOf('pendingProposalCount('), 'the layout redirects before it queries anything');
});

test('the PIN screen renders no household data and unlocks only through the server', () => {
  const locked = read('locked', 'page.tsx');
  assert.match(locked, /if \(!session\.actor\.locked\) redirect\(next\)/, 'an unlocked session is sent on');
  assert.match(locked, /action="\/api\/auth\/unlock"/);
  assert.ok(!/server\/(services|repositories)\//.test(locked.replace(/server\/services\/\w+\.ts/g, (m) => (m.includes('pin') ? m : ''))), 'no ledger service is imported');
  assert.ok(!/(expenses|payments|hsa|documents)\.ts/.test(locked), 'no record service is imported');
});
