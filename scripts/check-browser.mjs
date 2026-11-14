// Browser checks against the static export: layouts, keyboard, focus, reduced motion, contrast, accessibility.
// Build first (npm run build:marketing). Uses the same env vars as the export.
import assert from 'node:assert/strict';
import { AxeBuilder } from '@axe-core/playwright';
import { chromium } from 'playwright';
import { deployment } from '../apps/marketing/lib/deployment.mjs';
import { serveExport } from './static-server.mjs';

const viewports = { phone: { width: 390, height: 844 }, tablet: { width: 820, height: 1180 }, desktop: { width: 1440, height: 900 } };
const sections = ['hero-title', 'problem-title', 'features-title', 'preview-title', 'flow-title', 'host-title', 'ai-title', 'progress-title', 'faq-title'];
const server = await serveExport(deployment.basePath);
const base = server.origin + deployment.basePath;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };

async function audit(page, label) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const summary = results.violations.map((v) => v.id + ' (' + v.nodes.map((n) => n.target.join(' ')).join('; ') + ')');
  ok(summary.length === 0, 'Accessibility violations on ' + label + ': ' + summary.join(', '));
}

try {
  for (const colorScheme of ['light', 'dark']) {
    for (const [name, viewport] of Object.entries(viewports)) {
      const context = await browser.newContext({ viewport, colorScheme });
      const page = await context.newPage();
      const failures = [];
      page.on('response', (r) => { if (r.status() >= 400) failures.push(r.status() + ' ' + r.url()); });
      page.on('pageerror', (e) => failures.push(String(e)));
      for (const route of ['/', '/roadmap/']) {
        const label = route + ' ' + name + ' ' + colorScheme;
        await page.goto(base + route, { waitUntil: 'networkidle' });
        ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Horizontal overflow on ' + label);
        await audit(page, label);
        if (route === '/') for (const id of sections) ok(await page.locator('#' + id).isVisible(), 'Missing section ' + id + ' on ' + label);
      }
      ok(failures.length === 0, 'Failed requests or page errors on ' + name + ': ' + failures.join(', '));
      await context.close();
    }
  }

  // Keyboard navigation, focus visibility and the preview tablist.
  const context = await browser.newContext({ viewport: viewports.desktop });
  const page = await context.newPage();
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.keyboard.press('Tab');
  ok(await page.evaluate(() => document.activeElement?.textContent === 'Skip to content'), 'Skip link is first in tab order');
  ok(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle !== 'none'), 'Skip link shows focus');
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    const visible = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return true;
      const s = getComputedStyle(el);
      return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2;
    });
    ok(visible, 'Tab stop ' + i + ' has a visible focus indicator');
  }
  await page.locator('role=tab[name="Dashboard"]').focus();
  await page.keyboard.press('ArrowRight');
  ok(await page.locator('role=tab[name="Bills"]').getAttribute('aria-selected') === 'true', 'ArrowRight selects next tab');
  ok(await page.locator('role=tab[name="Bills"]').evaluate((el) => el === document.activeElement), 'Focus follows the selected tab');
  await page.getByRole('tabpanel').getByRole('img').scrollIntoViewIfNeeded();
  ok(await page.getByRole('tabpanel').getByRole('img').evaluate((el) => el.complete && el.naturalWidth === 1440), 'Bills screenshot is visible and loaded');
  await page.keyboard.press('End');
  ok(await page.locator('role=tab[name="HSA"]').getAttribute('aria-selected') === 'true', 'End selects last tab');
  await page.keyboard.press('ArrowRight');
  ok(await page.locator('role=tab[name="Dashboard"]').getAttribute('aria-selected') === 'true', 'Tabs wrap around');
  const previewText = await page.locator('#preview-title ~ .preview').innerText();
  ok(/fictional/i.test(previewText) && !/conceptual|not available yet/i.test(previewText), 'Screenshots are labelled as fictional data, not as a concept');
  const heroImage = page.locator('.hero-art img');
  ok(await heroImage.getAttribute('alt') && await heroImage.getAttribute('width') === '1440' && await heroImage.getAttribute('height') === '900', 'Hero screenshot has alt text and dimensions');
  await page.getByText('Can I use TallyMed today?').focus();
  await page.keyboard.press('Enter');
  ok(await page.locator('details[open]').count() === 1, 'FAQ opens with keyboard');
  await context.close();

  // Reduced motion removes transitions and smooth scrolling.
  const reduced = await browser.newContext({ viewport: viewports.desktop, reducedMotion: 'reduce' });
  const rPage = await reduced.newPage();
  await rPage.goto(base + '/', { waitUntil: 'networkidle' });
  const motion = await rPage.evaluate(() => ({
    transition: getComputedStyle(document.querySelector('.button')).transitionDuration,
    scroll: getComputedStyle(document.documentElement).scrollBehavior,
  }));
  ok(/^0s(, 0s)*$/.test(motion.transition) && motion.scroll === 'auto', 'Reduced motion disables transitions and smooth scroll');
  await reduced.close();

  // Metadata and real links.
  const meta = await browser.newContext();
  const mPage = await meta.newPage();
  await mPage.goto(base + '/', { waitUntil: 'networkidle' });
  const read = (sel, attr) => mPage.locator(sel).first().getAttribute(attr);
  ok(await read('link[rel=canonical]', 'href') === deployment.url + '/', 'Canonical URL matches deployment');
  const og = await read('meta[property="og:image"]', 'content');
  ok(og === deployment.url + '/og.png', 'Open Graph image URL: ' + og);
  const imageResponse = await mPage.request.get(base + '/og.png');
  ok(imageResponse.ok() && imageResponse.headers()['content-type'] === 'image/png', 'Open Graph image is served');
  const sitemap = await (await mPage.request.get(base + '/sitemap.xml')).text();
  ok(sitemap.includes('<loc>' + deployment.url + '/</loc>') && sitemap.includes('<loc>' + deployment.url + '/roadmap/</loc>'), 'Sitemap lists both pages');
  const hrefs = await mPage.locator('a[href^="https://github.com/"]').evaluateAll((els) => els.map((e) => e.href));
  ok(hrefs.length >= 5 && hrefs.every((h) => h.startsWith(deployment.source ?? 'https://github.com/Aulteran/tallymed')), 'GitHub links point at the configured repository');
  await meta.close();
  console.log('Browser checks passed (' + checks + ' assertions) at ' + (deployment.basePath || '/'));
} finally {
  await browser.close();
  await server.close();
}
