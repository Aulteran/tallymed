// Reproducible performance check: byte budgets on the static export plus a throttled-free load timing.
// The JavaScript budget covers the Next.js and React baseline (about 290 KB gzip) plus a small allowance.
// Budgets are deterministic and do not depend on the machine. Build first (npm run build:marketing).
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import { deployment } from '../apps/marketing/lib/deployment.mjs';
import { outDir, serveExport } from './static-server.mjs';

const budgets = { javascriptGzip: 320 * 1024, cssGzip: 20 * 1024, homeHtmlGzip: 30 * 1024, imageEach: 120 * 1024 };
const sizes = { javascriptGzip: 0, cssGzip: 0 };
const files = (await readdir(outDir, { recursive: true })).map((f) => f.replaceAll('\\', '/'));
for (const file of files) {
  if (!/\.(js|css|png|svg)$/.test(file) || (await stat(outDir + file)).isDirectory()) continue;
  const bytes = await readFile(outDir + file);
  if (file.endsWith('.js')) sizes.javascriptGzip += gzipSync(bytes).length;
  else if (file.endsWith('.css')) sizes.cssGzip += gzipSync(bytes).length;
  else assert.ok(bytes.length <= budgets.imageEach, file + ' is ' + bytes.length + ' bytes; budget ' + budgets.imageEach);
}
sizes.homeHtmlGzip = gzipSync(await readFile(outDir + 'index.html')).length;
for (const [key, budget] of Object.entries(budgets)) if (key in sizes) assert.ok(sizes[key] <= budget, key + ' ' + sizes[key] + ' exceeds ' + budget);

// Rendering budgets measured in Chromium with a mobile viewport. Thresholds are generous to stay stable in CI.
const server = await serveExport(deployment.basePath);
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  const external = [];
  page.on('request', (r) => { if (!r.url().startsWith(server.origin)) external.push(r.url()); });
  await page.addInitScript(() => {
    window.__cls = 0;
    new PerformanceObserver((list) => { for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
  });
  await page.goto(server.origin + deployment.basePath + '/', { waitUntil: 'networkidle' });
  const { cls, fcp } = await page.evaluate(() => ({ cls: window.__cls, fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? 0 }));
  assert.deepEqual(external, [], 'The site must not request third-party hosts');
  assert.ok(cls < 0.1, 'Cumulative layout shift ' + cls);
  assert.ok(fcp < 3000, 'First contentful paint ' + Math.round(fcp) + ' ms');
  console.log('Performance verified:', JSON.stringify({ ...sizes, cls: Number(cls.toFixed(3)), fcpMs: Math.round(fcp) }));
} finally {
  await browser.close();
  await server.close();
}
