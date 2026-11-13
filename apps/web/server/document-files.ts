// Upload validation for documents. Everything about a file comes from its bytes, never from the name or the declared type:
// the declared type and the extension must agree with what the content sniffer found, or the upload is refused.
// Allowlist (conservative starter default, recorded in DECISIONS.md): PDF, PNG, JPEG.
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { AppError } from './errors.ts';

export const DOCUMENT_MEDIA_TYPES = ['application/pdf', 'image/png', 'image/jpeg'] as const;
export type DocumentMediaType = (typeof DOCUMENT_MEDIA_TYPES)[number];

const EXTENSIONS: Record<DocumentMediaType, { allowed: string[]; canonical: string }> = {
  'application/pdf': { allowed: ['pdf'], canonical: 'pdf' },
  'image/png': { allowed: ['png'], canonical: 'png' },
  'image/jpeg': { allowed: ['jpg', 'jpeg'], canonical: 'jpg' },
};

export const DEFAULT_MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const MAX_PIXELS = 50_000_000;
const MAX_SIDE = 30_000;

const reject = (message: string) => new AppError('unsupported_media_type', message);

/** Strict structural checks. Returns the media type, or null when the bytes are none of the allowed formats. */
export function sniffMediaType(bytes: Uint8Array): DocumentMediaType | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return validPng(b) ? 'image/png' : null;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return validJpeg(b) ? 'image/jpeg' : null;
  if (b.length >= 8 && b.subarray(0, 5).toString('latin1') === '%PDF-') return validPdf(b) ? 'application/pdf' : null;
  return null;
}

/** Chunks are walked and checksummed; the file must end exactly at IEND, so nothing can ride behind the image. */
function validPng(b: Buffer): boolean {
  let i = 8;
  let first = true;
  let sawData = false;
  while (i + 12 <= b.length) {
    const len = b.readUInt32BE(i);
    const type = b.toString('latin1', i + 4, i + 8);
    if (len > b.length || i + 12 + len > b.length) return false;
    if (!/^[A-Za-z]{4}$/.test(type)) return false;
    const critical = type[0]! >= 'A' && type[0]! <= 'Z';
    if (critical && !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type)) return false;
    if (b.readUInt32BE(i + 8 + len) !== crc32(b.subarray(i + 4, i + 8 + len))) return false;
    if (first) {
      if (type !== 'IHDR' || len !== 13) return false;
      const w = b.readUInt32BE(i + 8);
      const h = b.readUInt32BE(i + 12);
      if (w < 1 || h < 1 || w > MAX_SIDE || h > MAX_SIDE || w * h > MAX_PIXELS) return false;
      first = false;
    } else if (type === 'IHDR') {
      return false;
    }
    if (type === 'IDAT') sawData = true;
    i += 12 + len;
    if (type === 'IEND') return len === 0 && sawData && i === b.length;
  }
  return false;
}

/** Marker segments are walked up to the scan, the frame size is bounded, and the file must end at the end-of-image marker. */
function validJpeg(b: Buffer): boolean {
  if (b.length < 4 || b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) return false;
  let i = 2;
  let sized = false;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return false;
    while (b[i + 1] === 0xff) i++;
    const marker = b[i + 1]!;
    if (marker === 0x00 || marker === 0xd8) return false;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9) return sized;
    const len = b.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > b.length) return false;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (len < 8) return false;
      const h = b.readUInt16BE(i + 5);
      const w = b.readUInt16BE(i + 7);
      if (w < 1 || h < 1 || w * h > MAX_PIXELS) return false;
      sized = true;
    }
    if (marker === 0xda) return sized; // entropy-coded data follows; the end marker was checked above
    i += 2 + len;
  }
  return false;
}

const PDF_ACTIVE = /\/(JavaScript|JS|Launch|EmbeddedFiles?|RichMedia|OpenAction|AA|XFA|SubmitForm|ImportData|GoToR|GoToE|Encrypt)(?![A-Za-z0-9])/;

/**
 * A PDF must start with its header at byte 0, end with an EOF marker, and show no archive trailer (so it is not also a ZIP) or
 * active content: scripts, launch actions, embedded files, rich media, form submission and encryption (which hides content
 * from this check). Name escapes (`/J#61vaScript`) are decoded before the scan. This is a conservative heuristic, not a full
 * parser: content inside compressed object streams is not visible to it, so downloads are also attachment-only and sandboxed.
 */
function validPdf(b: Buffer): boolean {
  if (!/^%PDF-(1\.[0-7]|2\.0)[\r\n]/.test(b.subarray(0, 12).toString('latin1'))) return false;
  const tail = b.subarray(Math.max(0, b.length - 1024)).toString('latin1');
  if (!/%%EOF\s*$/.test(tail)) return false;
  if (hasZipTrailer(b)) return false;
  const text = b.toString('latin1').replace(/#([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
  return !PDF_ACTIVE.test(text);
}

/** True when an end-of-central-directory record sits within the maximum distance from the end (a ZIP polyglot). */
function hasZipTrailer(b: Buffer): boolean {
  const from = Math.max(0, b.length - (22 + 65535));
  return b.subarray(from).includes(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
}

/** A display name only: no path parts, no control or bidirectional characters, a small character set and a bounded length. */
export function sanitizeFilename(raw: string, mediaType: DocumentMediaType): string {
  const base = (raw.normalize('NFC').split(/[\\/]/).pop() ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .trim();
  const dot = base.lastIndexOf('.');
  const stem = (dot > 0 ? base.slice(0, dot) : base)
    .replace(/[^\p{L}\p{N} ._()-]/gu, '_').replace(/_{2,}/g, '_').replace(/^[.\s_-]+/, '').trim().slice(0, 90);
  return `${stem || 'document'}.${EXTENSIONS[mediaType].canonical}`;
}

export function titleFromFilename(safeName: string): string {
  return safeName.replace(/\.[^.]+$/, '').slice(0, 120) || 'Document';
}

export interface InspectedFile {
  mediaType: DocumentMediaType;
  size: number;
  sha256: Buffer;
  safeName: string;
}

/**
 * Validates an uploaded file. Throws a client-safe AppError and returns nothing sensitive. Size is checked first, then the
 * content, then the declared type and the extension against the content.
 */
export function inspectUpload(file: { name: string; type: string; bytes: Uint8Array }, maxBytes = DEFAULT_MAX_DOCUMENT_BYTES): InspectedFile {
  if (file.bytes.byteLength === 0) throw new AppError('invalid_input', 'The file is empty');
  if (file.bytes.byteLength > maxBytes) throw new AppError('payload_too_large', 'The file is larger than the upload limit');
  const sniffed = sniffMediaType(file.bytes);
  if (!sniffed) throw reject('Only valid PDF, PNG and JPEG files without active content are accepted');
  const declared = file.type.split(';')[0]!.trim().toLowerCase();
  if (declared && declared !== 'application/octet-stream' && declared !== sniffed) throw reject('The file contents do not match its declared type');
  const dot = file.name.lastIndexOf('.');
  const ext = dot >= 0 ? file.name.slice(dot + 1).trim().toLowerCase() : '';
  if (ext && !EXTENSIONS[sniffed].allowed.includes(ext)) throw reject('The file contents do not match its extension');
  return { mediaType: sniffed, size: file.bytes.byteLength, sha256: createHash('sha256').update(file.bytes).digest(), safeName: sanitizeFilename(file.name, sniffed) };
}

/** Content-Disposition with a plain ASCII name (the display name is already restricted) and an RFC 5987 form. */
export function contentDisposition(disposition: 'attachment' | 'inline', safeName: string): string {
  const ascii = safeName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_');
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safeName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}
