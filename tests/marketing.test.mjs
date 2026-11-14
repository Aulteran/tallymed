import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { resolveDeployment } from '../apps/marketing/lib/deployment.mjs';

test('marketing deployment supports root and repository subpath', () => {
  assert.equal(resolveDeployment({ SITE_ORIGIN: 'https://tallymed.example' }).url, 'https://tallymed.example');
  assert.deepEqual(resolveDeployment({
    SITE_ORIGIN: 'https://example.github.io',
    NEXT_PUBLIC_BASE_PATH: '/tallymed',
    TALLYMED_REPOSITORY: 'example/tallymed',
  }), {
    basePath: '/tallymed',
    url: 'https://example.github.io/tallymed',
    source: 'https://github.com/example/tallymed',
  });
});

test('marketing rejects invalid deployment configuration', () => {
  for (const env of [
    { NEXT_PUBLIC_BASE_PATH: 'tallymed/' },
    { NEXT_PUBLIC_BASE_PATH: '//elsewhere' },
    { SITE_ORIGIN: 'https://host.example/path' },
    { TALLYMED_REPOSITORY: 'owner/repo?x=y' },
  ]) assert.throws(() => resolveDeployment(env));
});

test('public roadmap content contains descriptions and no internal IDs', () => {
  const raw = readFileSync(new URL('../apps/marketing/lib/roadmap.json', import.meta.url), 'utf8');
  assert.doesNotMatch(raw, /\bM\d{2,}\b/i);
  const rows = JSON.parse(raw);
  assert.ok(rows.length > 0);
  const names = new Set();
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ['description', 'name', 'status']);
    assert.ok(row.name.trim() && row.description.trim());
    assert.match(row.status, /^(Planned|In development|Complete)$/);
    assert.ok(!names.has(row.name));
    names.add(row.name);
  }
});

test('published icons, fonts and logo geometry match the shared brand package', () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url));
  const same = (copy, source) => assert.ok(read(copy).equals(read('../packages/brand/' + source)), copy + ' differs from packages/brand/' + source);
  same('../apps/marketing/public/icon.svg', 'app-icon.svg');
  same('../apps/marketing/public/favicon.ico', 'favicon.ico');
  same('../apps/marketing/public/apple-touch-icon.png', 'app-icon-180.png');
  same('../apps/web/app/icon.svg', 'app-icon.svg');
  same('../apps/web/app/favicon.ico', 'favicon.ico');
  same('../apps/web/app/apple-icon.png', 'app-icon-180.png');
  for (const app of ['marketing', 'web']) same('../apps/' + app + '/app/fonts/montserrat-latin-variable.woff2', 'fonts/montserrat-latin-variable.woff2');
  // The SVG files and the inline logo components draw from one geometry file.
  const { mark, wordmark } = JSON.parse(read('../packages/brand/paths.json'));
  for (const file of ['lockup.svg', 'lockup-on-dark.svg']) {
    const svg = read('../packages/brand/' + file).toString();
    for (const d of [...Object.values(mark), wordmark.tally, wordmark.med]) assert.ok(svg.includes('d="' + d + '"'), file + ' is out of step with paths.json');
  }
});

test('brand assets use the concept palette and embed no raster image or outside reference', () => {
  for (const file of ['mark.svg', 'mark-on-dark.svg', 'wordmark.svg', 'wordmark-on-dark.svg', 'lockup.svg', 'lockup-on-dark.svg', 'lockup-stacked.svg', 'lockup-stacked-on-dark.svg', 'app-icon.svg', 'app-icon-maskable.svg']) {
    const svg = readFileSync(new URL('../packages/brand/' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(svg, /<image|data:|href=|url\(|<script|<text/i, file);
    assert.match(svg, /#14B8A6/, file + ' uses the brand teal');
    for (const colour of svg.match(/#[0-9a-f]{6}/gi)) assert.match(colour, /^#(0B2942|14B8A6|FFFFFF)$/i, file + ' uses ' + colour);
  }
});

test('the apps load no font, style or script from another host', () => {
  for (const file of ['../apps/web/app/globals.css', '../apps/marketing/app/site.css', '../apps/web/app/layout.tsx', '../apps/marketing/app/layout.tsx']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /https?:\/\/|@import\s+url|next\/font\/google/, file);
  }
});
