// Fixtures for the optional-assistant tests (M06): the document fixture plus a restricted MCP database role, an MCP listener on a
// free loopback port, a real MCP SDK client and a raw HTTP helper for the negative cases. All data is fabricated.
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createPool } from '../../apps/web/server/db.ts';
import { loadMcpConfig } from '../../apps/web/server/mcp-config.ts';
import { startListener } from '../../apps/web/mcp/listener.ts';
import * as assistant from '../../apps/web/server/services/assistant.ts';
import * as docs from '../../apps/web/server/services/documents.ts';
import * as svc from '../../apps/web/server/services/expenses.ts';
import { hashPassword } from '../../apps/web/server/passwords.ts';
import { PASSWORD } from './helpers.mjs';
import { PNG_FILE, PDF_FILE, docFixture } from './document-helpers.mjs';

export const ALL = { documentsRead: 'yes', recordsRead: 'yes', documentsContent: 'yes', proposalsCreate: 'yes' };

export async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

/** A POST/GET with full control over headers (fetch refuses to set Host). Returns status, headers and the parsed JSON body. */
export function raw(port, { method = 'POST', path = '/mcp', headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    const h = { host: host ?? `127.0.0.1:${port}`, ...headers };
    if (payload !== undefined && !Object.keys(h).some((k) => k.toLowerCase() === 'content-type')) h['content-type'] = 'application/json';
    h.accept ??= 'application/json, text/event-stream';
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // Not JSON.
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export const rpcCall = (name, args = {}, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

export async function mcpFixture({ listener: over = {}, limits = {} } = {}) {
  const t = await docFixture({ limits });
  const role = `tallymed_mcp_t_${randomBytes(4).toString('hex')}`;
  await t.db.pool.query(`create role ${role} login password 'mcp-test-password'`);
  await t.db.pool.query(`select tallymed_apply_mcp_grants($1)`, [role]);
  const url = new URL(t.db.url);
  url.username = role;
  url.password = 'mcp-test-password';
  const mcpPool = createPool(url.href, 4);
  const port = await freePort();
  const config = {
    ...loadMcpConfig({ TALLYMED_MCP_ENABLED: 'true', TALLYMED_MCP_DATABASE_URL: url.href, TALLYMED_MCP_PORT: String(port) }),
    contentMaxBytes: 1024 * 1024, ...over,
  };
  const listener = await startListener({ config, pool: mcpPool, store: t.store });
  const clients = [];
  const fx = {
    ...t, role, mcpPool, mcpUrl: url.href, port, config, listener, endpoint: new URL(`http://127.0.0.1:${port}/mcp`),
    /** Creates an assistant credential through the real service; returns the token (shown once) and the client id. */
    async client(scopes = ALL, o = {}) {
      return assistant.createClient(t.db.pool, t.actor, { name: o.name ?? 'Example assistant', expiryDays: 30, ...scopes }, 'r');
    },
    /** An MCP SDK client connected with a bearer token. */
    async connect(token) {
      const c = new Client({ name: 'example-assistant', version: '1.0.0' });
      await c.connect(new StreamableHTTPClientTransport(fx.endpoint, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      clients.push(c);
      return c;
    },
    async tool(c, name, args = {}) {
      const r = await c.callTool({ name, arguments: args });
      let data = r.structuredContent;
      if (!data) {
        try {
          data = JSON.parse(r.content[0].text);
        } catch {
          // The SDK's own argument validation answers in prose.
          data = { error: { code: 'invalid_input', message: r.content[0].text } };
        }
      }
      return { isError: !!r.isError, data, content: r.content };
    },
    /** A bill and a visit for one member and provider, and an unmatched document. */
    async scene() {
      const m = await t.member();
      const p = await t.provider();
      const bill = await t.bill({ memberId: m, providerId: p, originalAmount: '120.00', providerReference: 'INV-1001' });
      const visit = await svc.createVisit(t.db.pool, t.actor, { memberId: m, providerId: p, serviceDate: '2026-02-01', description: 'Checkup' }, 'r');
      const doc = await t.up(PNG_FILE(), { title: 'Statement February' });
      return { m, p, bill, visit, doc };
    },
    async secondOperator(role = 'operator', email = 'op@example.test') {
      await t.db.pool.query(`insert into users (household_id, email, display_name, role, password_hash) values ($1, $2, 'Op Example', $3, $4)`,
        [t.actor.householdId, email, role, await hashPassword(PASSWORD)]);
      const { loginJson } = await import('./helpers.mjs');
      const handlers = await import('../../apps/web/server/http.ts');
      const r = await loginJson(handlers, t.ctx, email);
      const { authenticate } = await import('../../apps/web/server/services/auth.ts');
      return { cookie: r.cookie, csrf: r.csrf, actor: await authenticate(t.db.pool, t.config, r.cookie.split('=')[1]) };
    },
    /** Counts of every table an MCP tool must never change. */
    async protectedCounts() {
      const tables = ['bills', 'bill_adjustments', 'visits', 'payments', 'payment_entries', 'hsa_claims', 'hsa_entries', 'hsa_eligibility_decisions', 'documents', 'document_versions',
        'document_attachments', 'users', 'sessions', 'family_members', 'providers'];
      const out = {};
      for (const tb of tables) out[tb] = (await t.db.pool.query(`select count(*)::int n from ${tb}`)).rows[0].n;
      return out;
    },
    async drop() {
      for (const c of clients) await c.close().catch(() => undefined);
      await fx.listener.close();
      await mcpPool.end();
      await t.drop();
      const pg = (await import('pg')).default;
      const admin = new pg.Client({ connectionString: process.env.TALLYMED_TEST_DATABASE_URL });
      await admin.connect();
      await admin.query(`drop role if exists ${role}`);
      await admin.end();
    },
  };
  return fx;
}

export { PNG_FILE, PDF_FILE, docs, assistant, svc };
