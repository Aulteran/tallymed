import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { deployment } from '../apps/marketing/lib/deployment.mjs';

const output = new URL('../apps/marketing/out/', import.meta.url);
const home = await readFile(new URL('index.html', output), 'utf8');
const roadmap = await readFile(new URL('roadmap/index.html', output), 'utf8');
assert.match(home, /In development/);
assert.ok(home.includes('href="' + deployment.basePath + '/roadmap/"'));
assert.ok(home.includes('src="' + deployment.basePath + '/ledger.svg"'));
assert.ok(home.includes('src="' + deployment.basePath + '/_next/'));
if (deployment.source) assert.ok(home.includes('href="' + deployment.source + '"'));
for (const id of ['hero-title', 'problem-title', 'features-title', 'preview-title', 'flow-title', 'host-title', 'ai-title', 'progress-title', 'faq-title']) {
  assert.ok(home.includes('id="' + id + '"'), 'Missing home section ' + id);
}
assert.match(home, /fictional/i);
assert.match(home, /planned/i);
assert.ok(home.includes('rel="canonical" href="' + deployment.url + '/"'));
assert.ok(home.includes('content="' + deployment.url + '/og.png"'));
assert.ok(roadmap.includes('rel="canonical" href="' + deployment.url + '/roadmap/"'));
const sitemap = await readFile(new URL('sitemap.xml', output), 'utf8');
assert.ok(sitemap.includes('<loc>' + deployment.url + '/</loc>') && sitemap.includes('<loc>' + deployment.url + '/roadmap/</loc>'));
assert.ok((await stat(new URL('og.png', output))).size > 0);
assert.match(roadmap, /Development Roadmap/);
assert.match(roadmap, /Application Foundation/);
for (const name of await readdir(output, { recursive: true })) {
  const path = name.replaceAll('\\', '/');
  if ((await stat(new URL(path, output))).isDirectory()) continue;
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
