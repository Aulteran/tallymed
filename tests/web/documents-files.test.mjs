// Document file validation, filename sanitisation, the private object store and storage configuration. No database needed.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { contentDisposition, inspectUpload, sanitizeFilename, sniffMediaType } from '../../apps/web/server/document-files.ts';
import { parseDocumentsDir } from '../../apps/web/server/config.ts';
import { FileObjectStore, newStorageKey } from '../../apps/web/server/storage.ts';
import { deflateSync } from 'node:zlib';
import { jpeg, pdf, png, tempStore } from './document-helpers.mjs';

test('valid PDF, PNG and JPEG are recognised from their bytes', () => {
  assert.equal(sniffMediaType(png()), 'image/png');
  assert.equal(sniffMediaType(jpeg()), 'image/jpeg');
  assert.equal(sniffMediaType(pdf()), 'application/pdf');
});

test('content that merely resembles an allowed type is refused', () => {
  const good = png();
  assert.equal(sniffMediaType(Buffer.concat([good, Buffer.from('<script>x</script>')])), null, 'data after IEND');
  const badCrc = Buffer.from(good);
  badCrc[badCrc.length - 20] ^= 0xff;
  assert.equal(sniffMediaType(badCrc), null, 'bad chunk checksum');
  assert.equal(sniffMediaType(good.subarray(0, good.length - 7)), null, 'truncated');
  assert.equal(sniffMediaType(png({ w: 40_000, h: 2 })), null, 'oversized dimensions');
  const j = jpeg();
  assert.equal(sniffMediaType(Buffer.concat([j, Buffer.from('PK\x05\x06')])), null, 'JPEG with trailing data');
  assert.equal(sniffMediaType(j.subarray(0, j.length - 2)), null, 'JPEG without end marker');
  assert.equal(sniffMediaType(Buffer.from('<html><script>alert(1)</script></html>')), null);
  assert.equal(sniffMediaType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  assert.equal(sniffMediaType(Buffer.from('GIF89a\x01\x00\x01\x00')), null);
  assert.equal(sniffMediaType(Buffer.concat([Buffer.from('junk'), pdf()])), null, 'bytes before the PDF header');
  assert.equal(sniffMediaType(Buffer.alloc(0)), null);
});

test('PDFs with active content, archive trailers or hidden names are refused', () => {
  for (const body of ['/OpenAction << /S /JavaScript /JS (app.alert(1)) >>', '/AA << >>', '/Launch', '/EmbeddedFiles 3 0 R', '/Encrypt 4 0 R', '/RichMedia 1 0 R']) {
    assert.equal(sniffMediaType(pdf({ body })), null, body);
  }
  assert.equal(sniffMediaType(pdf({ body: '/J#61vaScript 1 0 R' })), null, 'escaped name');
  assert.equal(sniffMediaType(Buffer.concat([pdf(), Buffer.from('\nPK\x05\x06' + '\0'.repeat(18))])), null, 'ZIP end record (polyglot)');
  assert.equal(sniffMediaType(Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n')), null, 'no EOF marker');
  assert.equal(sniffMediaType(pdf({ body: '/Title (JavaScripture)' })), 'application/pdf', 'harmless text is allowed');
});

test('declared type, extension and size must agree with the content', () => {
  const ok = inspectUpload({ name: 'Scan.PNG', type: 'image/png', bytes: png() });
  assert.equal(ok.mediaType, 'image/png');
  assert.equal(ok.safeName, 'Scan.png');
  assert.equal(ok.sha256.length, 32);
  assert.throws(() => inspectUpload({ name: 'a.pdf', type: 'application/pdf', bytes: png() }), { code: 'unsupported_media_type' });
  assert.throws(() => inspectUpload({ name: 'a.png', type: 'application/pdf', bytes: png() }), { code: 'unsupported_media_type' });
  assert.throws(() => inspectUpload({ name: 'a.pdf', type: '', bytes: png() }), { code: 'unsupported_media_type' }, 'extension disagrees');
  assert.throws(() => inspectUpload({ name: 'a.png', type: 'image/png', bytes: Buffer.from('not an image') }), { code: 'unsupported_media_type' });
  assert.throws(() => inspectUpload({ name: 'a.png', type: 'image/png', bytes: Buffer.alloc(0) }), { code: 'invalid_input' });
  assert.throws(() => inspectUpload({ name: 'a.png', type: 'image/png', bytes: png() }, 10), { code: 'payload_too_large' });
  // Unlabelled uploads are accepted when the content is valid; the recorded type is always the sniffed one.
  assert.equal(inspectUpload({ name: 'noext', type: 'application/octet-stream', bytes: pdf() }).mediaType, 'application/pdf');
  assert.equal(inspectUpload({ name: 'x.jpeg', type: 'image/jpeg', bytes: jpeg() }).safeName, 'x.jpg');
});

test('filenames are display-only: no paths, controls, bidirectional marks or long names', () => {
  assert.equal(sanitizeFilename('../../etc/passwd', 'image/png'), 'passwd.png');
  assert.equal(sanitizeFilename('C:\\Users\\x\\..\\secret.pdf', 'application/pdf'), 'secret.pdf');
  assert.equal(sanitizeFilename('a\u0000b\r\nc.png', 'image/png'), 'abc.png');
  assert.equal(sanitizeFilename('invoice\u202egpj.exe', 'image/jpeg'), 'invoicegpj.jpg');
  assert.equal(sanitizeFilename('.hidden', 'image/png'), 'hidden.png');
  assert.equal(sanitizeFilename('', 'image/png'), 'document.png');
  assert.equal(sanitizeFilename('<script>.png', 'image/png'), 'script_.png');
  assert.ok(sanitizeFilename('x'.repeat(500) + '.png', 'image/png').length <= 94);
  const header = contentDisposition('attachment', sanitizeFilename('we"ird\r\nname;.png', 'image/png'));
  assert.ok(!/[\r\n]/.test(header));
  assert.match(header, /^attachment; filename="[^"]*"; filename\*=UTF-8''/);
  assert.match(contentDisposition('attachment', 'Résumé.pdf'), /filename="R_sum_\.pdf"; filename\*=UTF-8''R%C3%A9sum%C3%A9\.pdf/);
});

test('the document volume must be an absolute path outside the web root', () => {
  assert.equal(parseDocumentsDir(undefined), null);
  assert.equal(parseDocumentsDir('/var/lib/tallymed/documents/'), '/var/lib/tallymed/documents');
  for (const bad of ['relative/dir', '/', '/srv/app/public/docs', '/srv/../etc', '/srv/app/.next/x', '/a//b/../c', './x']) {
    assert.throws(() => parseDocumentsDir(bad), /TALLYMED_DOCUMENTS_DIR/, bad);
  }
});

test('the object store only accepts generated keys, never overwrites and keeps private permissions', async () => {
  const t = tempStore();
  try {
    assert.throws(() => new FileObjectStore('relative'), /absolute/);
    const key = newStorageKey();
    assert.match(key, /^[0-9a-f]{32}$/);
    for (const bad of ['../x', 'a/b', '', 'G'.repeat(32), key + '0', '..%2f..%2fetc%2fpasswd', key.toUpperCase()]) {
      await assert.rejects(t.store.putQuarantine(bad, Buffer.from('x')), /invalid storage key/, bad);
      await assert.rejects(t.store.read(bad), /invalid storage key/, bad);
      await assert.rejects(t.store.remove(bad), /invalid storage key/, bad);
    }
    await t.store.putQuarantine(key, Buffer.from('hello'));
    await assert.rejects(t.store.putQuarantine(key, Buffer.from('again')), /EEXIST/);
    assert.equal(statSync(path.join(t.dir, 'quarantine', key)).mode & 0o777, 0o600);
    await assert.rejects(t.store.read(key), /ENOENT/, 'quarantined bytes are not served');
    await t.store.promote(key);
    assert.equal((await t.store.read(key)).toString(), 'hello');
    assert.ok(existsSync(path.join(t.dir, 'objects', key.slice(0, 2), key)));
    assert.equal(statSync(path.join(t.dir, 'objects')).mode & 0o777, 0o700);
    const listed = await t.store.list();
    assert.deepEqual(listed.objects.map((o) => o.key), [key]);
    await t.store.remove(key);
    await t.store.remove(key);
    assert.equal((await t.store.list()).objects.length, 0);
  } finally {
    t.cleanup();
  }
});

test('the object store never writes through a planted link', async () => {
  const t = tempStore();
  try {
    const key = newStorageKey();
    await t.store.putQuarantine(newStorageKey(), Buffer.from('init'));
    const outside = path.join(t.dir, 'outside.txt');
    writeFileSync(outside, 'secret');
    symlinkSync(outside, path.join(t.dir, 'quarantine', key));
    await assert.rejects(t.store.putQuarantine(key, Buffer.from('overwrite')));
    assert.equal((await import('node:fs')).readFileSync(outside, 'utf8'), 'secret');
    mkdirSync(path.join(t.dir, 'objects', key.slice(0, 2)), { recursive: true });
    symlinkSync(outside, path.join(t.dir, 'objects', key.slice(0, 2), key));
    await assert.rejects(t.store.read(key));
  } finally {
    t.cleanup();
  }
});

/** A PDF 1.5 file whose catalog sits inside an object stream with the given filter and contents. */
const objStmPdf = (inner, { filter = '/FlateDecode', data = deflateSync(Buffer.from(inner, 'latin1')), extra = '' } = {}) => Buffer.concat([
  Buffer.from(`%PDF-1.5\n4 0 obj\n<< /Type /ObjStm /N 1 /First 8 /Length ${data.length} ${filter ? `/Filter ${filter}` : ''} ${extra} >>\nstream\n`, 'latin1'),
  data, Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1'),
]);

test('active content hidden in compressed object streams is found, and uninspectable streams are refused', () => {
  const evil = '1 0 << /Type /Catalog /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>';
  assert.equal(sniffMediaType(objStmPdf(evil)), null, 'Flate object stream with a script');
  assert.equal(sniffMediaType(objStmPdf('1 0 << /Type /Catalog /J#61vaScript 3 0 R >>')), null, 'escaped name inside the stream');
  assert.equal(sniffMediaType(objStmPdf('1 0 << /Type /Catalog /Pages 2 0 R >>')), 'application/pdf', 'a clean object stream is accepted');
  assert.equal(sniffMediaType(objStmPdf(evil, { filter: '[/ASCII85Decode /FlateDecode]' })), null, 'filter chain cannot be inspected');
  assert.equal(sniffMediaType(objStmPdf(evil, { filter: '/LZWDecode' })), null, 'other filter');
  assert.equal(sniffMediaType(objStmPdf(evil, { filter: '', data: Buffer.from(evil) })), null, 'unfiltered stream with a script');
  assert.equal(sniffMediaType(objStmPdf('x', { extra: '/DecodeParms << /Predictor 12 >>' })), null, 'predictor changes the decoded bytes');
  assert.equal(sniffMediaType(objStmPdf('x', { data: Buffer.from('not flate data') })), null, 'corrupt stream');
  assert.equal(sniffMediaType(objStmPdf('', { data: deflateSync(Buffer.alloc(80 * 1024 * 1024)) })), null, 'expansion beyond the budget');
});
