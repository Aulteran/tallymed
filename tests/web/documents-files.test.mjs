// Document file validation, filename sanitisation, the private object store and storage configuration. No database needed.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { contentDisposition, inspectUpload, sanitizeFilename, sniffMediaType } from '../../apps/web/server/document-files.ts';
import { parseDocumentsDir } from '../../apps/web/server/config.ts';
import { FileObjectStore, newStorageKey } from '../../apps/web/server/storage.ts';
import { deflateSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
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

test('large scanned PDFs are not refused because compressed or binary stream data happens to contain a two-byte name', () => {
  const scan = (bytes, dictExtra = '') => Buffer.concat([
    Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog ${dictExtra} >>\nendobj\n2 0 obj\n<< /Length ${bytes.length} /Filter /DCTDecode >>\nstream\n`, 'latin1'),
    bytes, Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1'),
  ]);
  // Stream bodies that certainly contain names that would match the scan if it looked inside streams.
  const withNames = Buffer.concat([randomBytes(2 * 1024 * 1024), Buffer.from('/JS /AA /Launch /OpenAction /Encrypt'), randomBytes(2 * 1024 * 1024)]);
  assert.equal(sniffMediaType(scan(withNames)), 'application/pdf');
  for (let i = 0; i < 6; i++) assert.equal(sniffMediaType(scan(randomBytes(5 * 1024 * 1024))), 'application/pdf', `random 5 MB stream ${i}`);
  assert.equal(sniffMediaType(scan(randomBytes(10 * 1024 * 1024 - 1024))), 'application/pdf', 'random stream near the default limit');
  // The same names in a dictionary outside any stream are still refused, even in a file with a large stream.
  assert.equal(sniffMediaType(scan(randomBytes(1024 * 1024), '/AA << >>')), null);
  assert.equal(sniffMediaType(scan(randomBytes(1024 * 1024), '/OpenAction << /S /JavaScript /JS (x) >>')), null);
  assert.equal(sniffMediaType(scan(randomBytes(1024), '/JS (x)')), null);
  // A name that only appears after the last stream is still outside every stream.
  assert.equal(sniffMediaType(Buffer.concat([scan(randomBytes(1024)).subarray(0, -7), Buffer.from('2 0 obj << /Launch >> endobj\n%%EOF\n')])), null);
});

test('names are recognised as a reader sees them: fake stream markers, comments and strings cannot hide or fake anything', () => {
  const wrap = (objs) => Buffer.from(`%PDF-1.5\n${objs}\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`, 'latin1');
  const js = '<< /Type /Catalog /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>';
  // A) active content wrapped in comment lines that look like stream markers
  assert.equal(sniffMediaType(wrap(`%stream\n1 0 obj\n${js}\nendobj\n%endstream`)), null);
  assert.equal(sniffMediaType(wrap(`%stream\n1 0 obj\n<< /Type /Catalog /Launch 1 0 R >>\nendobj\n%endstream`)), null);
  assert.equal(sniffMediaType(wrap(`% stream\n(stream\n)\n1 0 obj\n${js}\nendobj\n(endstream)`)), null);
  // A real stream whose dictionary is followed by hidden objects after its (verified) length
  assert.equal(sniffMediaType(wrap(`2 0 obj\n<< /Length 3 >>\nstream\nabc\nendstream\nendobj\n1 0 obj\n${js}\nendobj`)), null);
  // B/C) an object stream whose dictionary holds strings that used to confuse the dictionary search
  const evil = deflateSync(Buffer.from(`1 0 ${js}`, 'latin1'));
  const objstm = (extra, data = evil) => Buffer.concat([
    Buffer.from(`%PDF-1.5\n4 0 obj\n<< /Type /ObjStm /N 1 /First 4 ${extra} /Length ${data.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
    data, Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1'),
  ]);
  for (const extra of ['', '/X (obj)', '/X (endobj endstream obj)', `/X (${'obj endobj '.repeat(1000)})`, '/X <6f626a> /Y (stream\n)', '/Y % obj\n/Z 1']) {
    assert.equal(sniffMediaType(objstm(extra)), null, extra.slice(0, 30));
  }
  const launch = deflateSync(Buffer.from('1 0 << /Type /Catalog /Launch 3 0 R >>'));
  assert.equal(sniffMediaType(objstm('/X (obj)', launch)), null, 'Launch inside an object stream');
  // a stream keyword inside a string must not swallow the objects after it
  assert.equal(sniffMediaType(wrap(`1 0 obj\n<< /Title (stream\n) >>\nendobj\n2 0 obj\n${js}\nendobj\n3 0 obj\n<< /T (\nendstream) >>`)), null);
  // B4) file attachments without an /EmbeddedFile name
  assert.equal(sniffMediaType(wrap('1 0 obj\n<< /Subtype /FileAttachment /FS << /EF << /F 2 0 R >> >> >>\nendobj')), null);
  assert.equal(sniffMediaType(wrap('1 0 obj\n<< /FS << /EF << /F 2 0 R >> >> >>\nendobj')), null);
  // unparseable structure is refused rather than guessed
  assert.equal(sniffMediaType(wrap('1 0 obj\n<< /A [ 1 2 >>\nendobj')), null, 'mismatched delimiters');
  assert.equal(sniffMediaType(wrap('1 0 obj\n<< /A (unterminated\nendobj')), null, 'open string');
  assert.equal(sniffMediaType(wrap('1 0 obj\n<< /Length 3 >>\nstream\nabc\nendobj')), null, 'no endstream');
  assert.equal(sniffMediaType(wrap('1 0 obj\nstream\nabc\nendstream\nendobj')), null, 'stream without a dictionary');
  // ordinary structure is still accepted, including an indirect /Length and an unfiltered object stream
  assert.equal(sniffMediaType(wrap('1 0 obj\n<< /Length 2 0 R >>\nstream\nBT (hi) Tj ET\nendstream\nendobj\n2 0 obj\n12\nendobj')), 'application/pdf');
  assert.equal(sniffMediaType(wrap('1 0 obj\n<< /Length 5 >>\nstream\n/JS /A\nendstream\nendobj')), 'application/pdf', 'names inside a plain content stream are data');
  assert.equal(sniffMediaType(objstm('', Buffer.from('1 0 << /Type /Catalog >>'))), null, 'flate filter with raw data is corrupt');
});

test('scanning an adversarial PDF takes linear time', () => {
  const head = '%PDF-1.4\n';
  const tail = '\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n';
  const size = 10 * 1024 * 1024 - 1024;
  const adversarial = {
    'tiny streams with no object keyword': 'stream\nendstream'.repeat(Math.floor(size / 16)),
    'tiny real streams': '1 0 obj << /Length 0 >> stream\nendstream endobj\n'.repeat(Math.floor(size / 46)),
    'one-letter names': '/A '.repeat(Math.floor(size / 3)),
    'near-miss names': '/JSX /Au /EFx /OpenActio '.repeat(Math.floor(size / 25)),
    'nested arrays and dictionaries': '[<<'.repeat(30) + '>>]'.repeat(30) + ' '.repeat(100) + '(a)'.repeat(Math.floor(size / 3 / 2)),
    'tiny object streams': '<< /Type /ObjStm /Length 0 >> stream\nendstream '.repeat(Math.floor(size / 44)),
  };
  for (const [name, body] of Object.entries(adversarial)) {
    const file = Buffer.from(head + body.slice(0, size) + tail, 'latin1');
    const t = process.hrtime.bigint();
    sniffMediaType(file);
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    assert.ok(ms < 1000, `${name}: ${ms.toFixed(0)} ms`);
  }
});

test('a JPEG may carry zero padding after its end marker but nothing else', () => {
  const j = jpeg();
  assert.equal(sniffMediaType(Buffer.concat([j, Buffer.alloc(512)])), 'image/jpeg');
  assert.equal(sniffMediaType(Buffer.concat([j, Buffer.from('\n')])), null);
  assert.equal(sniffMediaType(Buffer.concat([j, Buffer.alloc(8), Buffer.from('x')])), null);
  assert.equal(sniffMediaType(Buffer.concat([j, Buffer.alloc(70_000)])), null, 'padding is bounded');
});
