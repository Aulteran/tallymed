import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { deployment } from '../apps/marketing/lib/deployment.mjs';

const output = new URL('../apps/marketing/out/', import.meta.url);
const home = await readFile(new URL('index.html', output), 'utf8');
const roadmap = await readFile(new URL('roadmap/index.html', output), 'utf8');
assert.match(home, /In development/);
assert.ok(home.includes('href="' + deployment.basePath + '/roadmap/"'));
assert.ok(home.includes('src="' + deployment.basePath + '/ledger.svg"'));
assert.ok(home.includes('src="' + deployment.basePath + '/_next/'));
if (deployment.source) assert.ok(home.includes('href="' + deployment.source + '"'));
assert.match(roadmap, /Development Roadmap/);
assert.match(roadmap, /Application Foundation/);
for (const name of await readdir(output, { recursive: true })) {
  const path = name.replaceAll('\\', '/');
  assert.doesNotMatch(path, /\bM\d{2,}\b/i, 'Internal ID found in public path: ' + path);
  // Framework chunks can contain SVG path commands such as M16. Scan the app's chunks and route data.
  const frameworkAsset = path.startsWith('_next/') && !path.startsWith('_next/static/chunks/app/');
  if (!frameworkAsset && /\.(html|txt|json|rsc|js|map|xml)$/.test(path)) {
    const content = await readFile(new URL(path, output), 'utf8');
    const id = content.match(/\bM\d{2,}\b/i)?.[0];
    assert.ok(!id, 'Internal ID ' + id + ' found in public output: ' + path);
  }
}
console.log('Marketing export verified at ' + (deployment.basePath || '/'));
