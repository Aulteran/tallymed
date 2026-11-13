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

test('published favicon matches the shared mark', () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
  assert.equal(read('../apps/marketing/public/ledger.svg'), read('../packages/brand/ledger.svg'));
});
