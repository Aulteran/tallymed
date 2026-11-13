import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain', '.xml': 'application/xml', '.json': 'application/json' };
export const outDir = fileURLToPath(new URL('../apps/marketing/out/', import.meta.url));

/** Serves the static export under basePath, as GitHub Pages would. Returns { origin, close }. */
export async function serveExport(basePath = '') {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (basePath && path !== basePath && !path.startsWith(basePath + '/')) { res.writeHead(404).end('Not found'); return; }
    let rel = normalize(path.slice(basePath.length) || '/');
    if (rel.includes('..')) { res.writeHead(400).end(); return; }
    if (rel.endsWith('/')) rel += 'index.html';
    try {
      const body = await readFile(join(outDir, rel));
      res.writeHead(200, { 'content-type': types[extname(rel)] ?? 'application/octet-stream' }).end(body);
    } catch { res.writeHead(404).end('Not found'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { origin: 'http://127.0.0.1:' + server.address().port, close: () => new Promise((r) => server.close(r)) };
}
