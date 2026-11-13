// Fixtures for the document tests: tiny valid files built in code (synthetic content only) and a multipart request builder.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { FileObjectStore } from '../../apps/web/server/storage.ts';
import { ORIGIN, PASSWORD, loginJson } from './helpers.mjs';
import { hashPassword } from '../../apps/web/server/passwords.ts';
import * as handlers from '../../apps/web/server/http.ts';
import { setup } from './money-helpers.mjs';
import * as hsa from '../../apps/web/server/services/hsa.ts';
import { authenticate } from '../../apps/web/server/services/auth.ts';
import { csrfFor } from '../../apps/web/server/tokens.ts';

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/** A valid PNG. `salt` makes the bytes (and so the checksum) unique through a text chunk. */
export function png({ w = 2, h = 2, salt = randomBytes(6).toString('hex') } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w, 0x7f)])));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('tEXt', Buffer.from(`note\0${salt}`)),
    chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A structurally valid JPEG (one scan of filler). */
export function jpeg({ w = 4, h = 4, salt = randomBytes(6).toString('hex') } = {}) {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0]);
  const comment = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, salt.length + 2]), Buffer.from(salt)]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 63, 0]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), comment, sof, sos, Buffer.from([0x12, 0x34, 0x56]), Buffer.from([0xff, 0xd9])]);
}

export function pdf({ body = '', salt = randomBytes(6).toString('hex') } = {}) {
  return Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Title (Example ${salt}) ${body} >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`, 'latin1');
}

export function tempStore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'tallymed-docs-'));
  return { dir, store: new FileObjectStore(dir), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A multipart POST. `file` is { bytes, name, type } or null; fields are plain strings. */
export function upload(action, fields, file, { cookie, csrf, origin = ORIGIN, headers = {}, html = false, path: url } = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  if (file) fd.set('file', new Blob([file.bytes], { type: file.type ?? '' }), file.name ?? 'upload.bin');
  const h = new Headers(headers);
  if (origin) h.set('origin', origin);
  if (cookie) h.set('cookie', cookie);
  if (csrf) h.set('x-csrf-token', csrf);
  if (html) h.set('accept', 'text/html');
  return new Request(url ?? `http://app.internal:3000/api/documents/${action}`, { method: 'POST', headers: h, body: fd });
}

export const file = (bytes, name, type) => ({ bytes, name, type });
export const PNG_FILE = (o = {}) => file(png(o), 'scan.png', 'image/png');
export const PDF_FILE = (o = {}) => file(pdf(o), 'statement.pdf', 'application/pdf');

/** Fixture: the money fixture plus a private temp store, a signed-in session and a second household. */
export async function docFixture({ limits = {}, store: storeOverride } = {}) {
  const t = await setup();
  const ts = tempStore();
  const store = storeOverride ? storeOverride(ts.store) : ts.store;
  const config = { ...t.config, ...limits };
  const ctx = { config, pool: t.db.pool, store };
  const { cookie } = await loginJson(handlers, ctx, 'admin@example.test');
  const csrf = csrfFor(cookie.split('=')[1]);
  const deps = { pool: t.db.pool, store, limits: config };
  return {
    ...t, ctx, config, store, ts, deps, cookie, csrf,
    /** A second household with its own administrator and a real session. */
    async other() {
      const h2 = (await t.db.pool.query(`insert into households (name) values ('Other Family') returning id`)).rows[0].id;
      await t.db.pool.query(`insert into users (household_id, email, display_name, role, password_hash) values ($1, 'other@example.test', 'Other Admin', 'admin', $2)`, [h2, await hashPassword(PASSWORD)]);
      const r = await loginJson(handlers, ctx, 'other@example.test');
      const token = r.cookie.split('=')[1];
      return { cookie: r.cookie, csrf: csrfFor(token), actor: await authenticate(t.db.pool, config, token) };
    },
    http: (action, fields, f, o = {}) => handlers.handleDocumentAction(upload(action, fields, f, { cookie, csrf, ...o }), ctx, action),
    async post(action, body, o = {}) {
      const { post } = await import('./helpers.mjs');
      return handlers.handleDocumentAction(post(`/api/documents/${action}`, body, { cookie, headers: { 'x-csrf-token': csrf }, ...o }), ctx, action);
    },
    get: (id, query = '', { cookie: c = cookie } = {}) => handlers.handleDocumentDownload(
      new Request(`http://app.internal:3000/api/documents/download/${id}${query}`, { headers: { cookie: c } }), ctx, id),
    async up(f = PNG_FILE(), o = {}) {
      const { uploadDocument } = await import('../../apps/web/server/services/documents.ts');
      return uploadDocument(deps, t.actor, { idempotencyKey: randomUUID(), file: f, kind: 'receipt', ...o }, 'r');
    },
    async drop() {
      ts.cleanup();
      await t.db.drop();
    },
  };
}
export { hsa };
