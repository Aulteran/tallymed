// Upload validation for documents. Everything about a file comes from its bytes, never from the name or the declared type:
// the declared type and the extension must agree with what the content sniffer found, or the upload is refused.
// Allowlist (conservative starter default, recorded in DECISIONS.md): PDF, PNG, JPEG.
import { createHash } from 'node:crypto';
import { crc32, inflateSync } from 'node:zlib';
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

/**
 * Marker segments are walked up to the scan, the frame size is bounded, and the file must end at the end-of-image marker.
 * Zero padding after it (some scanners and cameras write it) is allowed up to 64 KB; any other trailing byte is refused.
 */
function validJpeg(full: Buffer): boolean {
  let end = full.length;
  while (end > 0 && full[end - 1] === 0 && full.length - end <= 65536) end--;
  if (full.length - end > 65536) return false;
  const b = full.subarray(0, end);
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

const FORBIDDEN_NAMES = new Set([
  'JavaScript', 'JS', 'Launch', 'EmbeddedFile', 'EmbeddedFiles', 'EF', 'FileAttachment', 'RichMedia', 'OpenAction', 'AA', 'XFA',
  'SubmitForm', 'ImportData', 'GoToR', 'GoToE', 'Encrypt',
]);
// Names the scanner records from a stream dictionary, to decide whether the stream is an object stream and how it is encoded.
const DICT_NAMES = new Set([
  'ObjStm', 'Filter', 'FlateDecode', 'Fl', 'Predictor', 'Crypt', 'DecodeParms', 'DP', 'F', 'FFilter',
  'ASCIIHexDecode', 'AHx', 'ASCII85Decode', 'A85', 'LZWDecode', 'LZW', 'RunLengthDecode', 'RL', 'CCITTFaxDecode', 'CCF', 'DCTDecode', 'DCT', 'JBIG2Decode', 'JPXDecode',
]);
const OTHER_FILTERS = new Set(['ASCIIHexDecode', 'AHx', 'ASCII85Decode', 'A85', 'LZWDecode', 'LZW', 'RunLengthDecode', 'RL', 'CCITTFaxDecode', 'CCF', 'DCTDecode', 'DCT', 'JBIG2Decode', 'JPXDecode', 'Crypt']);

const WS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1;
const NAME_START = new Uint8Array(256); // first byte of a name worth looking up (or an escape, which can hide any first byte)
for (const n of [...FORBIDDEN_NAMES, ...DICT_NAMES]) NAME_START[n.charCodeAt(0)] = 1;
NAME_START[0x23] = 1;

const MAX_OBJSTMS = 4096;
const MAX_DEPTH = 64;
const MAX_INFLATED_TOTAL = 16 * 1024 * 1024;

interface DictInfo { objstm: boolean; filter: boolean; flate: number; other: boolean; predictor: boolean; len: number; lenState: number; lenKeys: number }
interface ScanState { budget: number; objstms: number }

const unescapeName = (s: string) => s.replace(/#([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));

/**
 * A PDF must start with its header at byte 0, end with an EOF marker, and show no archive trailer (so it is not also a ZIP). The
 * body is then tokenized in one linear pass (see `scanPdf`) and refused when it names scripts, launch actions, embedded files, rich
 * media, form submission or encryption (which hides content from this check). This is a conservative filter, not a guarantee of
 * safety: the real controls are that downloads are attachment-only, sandboxed and nosniff, and a person opening a saved PDF in a
 * local reader should treat it as untrusted.
 */
function validPdf(b: Buffer): boolean {
  if (!/^%PDF-(1\.[0-7]|2\.0)[\r\n]/.test(b.subarray(0, 12).toString('latin1'))) return false;
  const tail = b.subarray(Math.max(0, b.length - 1024)).toString('latin1');
  if (!/%%EOF\s*$/.test(tail)) return false;
  if (hasZipTrailer(b)) return false;
  return scanPdf(b, { budget: MAX_INFLATED_TOTAL, objstms: 0 }, false);
}

/**
 * One pass over the bytes, never revisiting any: comments, strings, hex strings, names, arrays, dictionaries and keywords are
 * recognised as a reader would, so a name only counts where it is a name (not in a comment, string or stream body) and a fake
 * `stream` or `obj` inside a comment or string means nothing. Stream bodies are skipped using a direct /Length that is verified to
 * end at `endstream`, else the first `endstream` after the body starts; stream bodies of object streams (/Type /ObjStm) are
 * inflated (bounded) and scanned the same way. Everything the pass cannot parse unambiguously refuses the file: unbalanced
 * delimiters, an unterminated string, a `stream` keyword without a dictionary, a missing `endstream`, an object stream with an
 * encoding other than a single plain Flate, a corrupt or oversized object stream, or too many object streams.
 */
function scanPdf(b: Buffer, st: ScanState, inObjStm: boolean): boolean {
  const n = b.length;
  // Open containers: kind (0x3c dictionary, 0x5b array), the keys seen so far (dictionaries) and where the dictionary is in its
  // key/value rhythm: 0 expects a key, 1 expects the start of a value, 2 and 3 follow the first and second integer of `N G R`.
  const kinds: number[] = [];
  const keys: (Set<string> | null)[] = [];
  const states: number[] = [];
  let cur: DictInfo | null = null;
  let last: DictInfo | null = null;
  let afterDict = false;
  let openAction = false;
  let i = 0;

  /** A value that is not a name or a container (number, string, keyword). Returns false when it sits where a key must be. */
  const value = (kind: 0 | 1 | 2): boolean => { // 0 other, 1 integer, 2 the keyword R
    const d = kinds.length - 1;
    if (d < 0 || kinds[d] !== 0x3c) return true;
    const s = states[d]!;
    if (s === 0) return false;
    states[d] = s === 1 && kind === 1 ? 2 : s === 2 && kind === 1 ? 3 : 0;
    return true;
  };
  /** A container opens in value position; closing it completes the parent's value. */
  const open = (kind: number): boolean => {
    const d = kinds.length - 1;
    if (d >= MAX_DEPTH) return false;
    if (d >= 0 && kinds[d] === 0x3c && states[d] !== 1) return false;
    kinds.push(kind);
    keys.push(null);
    states.push(0);
    return true;
  };
  const close = (kind: number): boolean => {
    if (kinds.pop() !== kind) return false;
    keys.pop();
    states.pop();
    const d = kinds.length - 1;
    if (d >= 0 && kinds[d] === 0x3c) states[d] = 0;
    return true;
  };

  while (i < n) {
    const c = b[i]!;
    if (WS[c]) { i++; continue; }
    if (c === 0x25) { // comment to end of line
      while (i < n && b[i] !== 10 && b[i] !== 13) i++;
      continue;
    }
    const hadDict = afterDict;
    afterDict = false;
    // /OpenAction may only be followed by an array (a view destination); a dictionary or reference could be an action.
    if (openAction) {
      if (c !== 0x5b) return false;
      openAction = false;
    }
    const top = kinds.length === 1 && kinds[0] === 0x3c ? cur : null;
    // Position in `/Length N` or `/Length N G R` (indirect) while directly inside the object's dictionary.
    const lenStep = (isInt: boolean, text: string | null) => {
      if (!top || top.lenState === 0) return;
      if (top.lenState === 1) { if (isInt) { top.len = Number(text); top.lenState = 2; } else top.lenState = 0; }
      else if (top.lenState === 2) { if (isInt) top.lenState = 3; else top.lenState = 0; }
      else { if (text === 'R') top.len = -1; top.lenState = 0; }
    };
    if (c === 0x28) { // string
      let j = i + 1;
      let nest = 1;
      while (j < n) {
        const ch = b[j]!;
        if (ch === 0x5c) j += 2;
        else if (ch === 0x28) { nest++; j++; }
        else if (ch === 0x29) { if (--nest === 0) break; j++; }
        else j++;
      }
      if (j >= n || !value(0)) return false;
      lenStep(false, null);
      i = j + 1;
    } else if (c === 0x3c) {
      if (b[i + 1] === 0x3c) {
        const fresh = kinds.length === 0;
        if (!open(0x3c)) return false;
        if (fresh) cur = { objstm: false, filter: false, flate: 0, other: false, predictor: false, len: -1, lenState: 0, lenKeys: 0 };
        lenStep(false, null);
        i += 2;
      } else {
        const j = b.indexOf(0x3e, i + 1);
        if (j < 0 || !value(0)) return false;
        lenStep(false, null);
        i = j + 1;
      }
    } else if (c === 0x3e) {
      if (b[i + 1] !== 0x3e || !close(0x3c)) return false;
      i += 2;
      if (kinds.length === 0) { last = cur; afterDict = true; }
    } else if (c === 0x5b) {
      if (!open(0x5b)) return false;
      lenStep(false, null);
      i++;
    } else if (c === 0x5d) {
      if (!close(0x5b)) return false;
      i++;
    } else if (c === 0x7b || c === 0x7d) {
      i++;
    } else if (c === 0x29) {
      return false; // a stray closing parenthesis is not valid syntax
    } else if (c === 0x2f) { // name
      let j = i + 1;
      let hash = false;
      while (j < n && !WS[b[j]!] && !DELIM[b[j]!]) { if (b[j] === 0x23) hash = true; j++; }
      const len = j - i - 1;
      const d = kinds.length - 1;
      const inDict = d >= 0 && kinds[d] === 0x3c;
      const isKey = inDict && states[d] !== 1; // key position (after a complete value, including `N G R`)
      let name: string | null = null;
      if (isKey || (len > 0 && len <= 42 && (hash || (len <= 14 && NAME_START[b[i + 1]!]!)))) {
        const raw = b.toString('latin1', i + 1, j);
        name = hash ? unescapeName(raw) : raw;
      }
      if (name !== null) {
        if (name === 'OpenAction') openAction = true;
        else if (FORBIDDEN_NAMES.has(name)) return false;
        if (kinds.length > 0 && cur && DICT_NAMES.has(name)) {
          if (name === 'ObjStm') cur.objstm = true;
          else if (name === 'Filter') cur.filter = true;
          else if (name === 'FlateDecode' || name === 'Fl') cur.flate++;
          else if (name === 'Predictor') cur.predictor = true;
          else if (OTHER_FILTERS.has(name)) cur.other = true;
        }
      }
      if (inDict) {
        if (isKey) {
          // A repeated key is ambiguous: readers disagree about which of the two counts.
          let seen = keys[d]!;
          if (!seen) keys[d] = seen = new Set();
          if (seen.has(name!)) return false;
          seen.add(name!);
          states[d] = 1;
        } else {
          states[d] = 0;
        }
      }
      if (top) {
        top.lenState = isKey && name === 'Length' ? 1 : 0;
        if (top.lenState === 1) top.lenKeys++;
      }
      i = j;
    } else { // keyword or number
      let j = i + 1;
      while (j < n && !WS[b[j]!] && !DELIM[b[j]!]) j++;
      const len = j - i;
      if (len === 6 && b.toString('latin1', i, j) === 'stream') {
        if (inObjStm || kinds.length !== 0 || !hadDict || !last) return false;
        let start: number;
        if (b[j] === 13 && b[j + 1] === 10) start = j + 2;
        else if (b[j] === 10) start = j + 1;
        else return false;
        // The first `endstream` after the body starts. A direct /Length must end exactly there: if it ends later, readers that
        // trust the keyword and readers that trust the length would parse different objects, so the file is refused.
        const idx = b.indexOf('endstream', start, 'latin1');
        if (idx < 0) return false;
        let bodyEnd = idx;
        let verified = false;
        if (last.len >= 0 && start + last.len <= n) {
          let p = start + last.len;
          const stop = p + 4;
          while (p < stop && p < n && WS[b[p]!]) p++;
          if (b.toString('latin1', p, p + 9) === 'endstream') {
            if (p !== idx) return false;
            bodyEnd = start + last.len;
            verified = true;
          }
        }
        if (last.objstm) {
          // Its body is decoded and read, so where it ends must not depend on which reader looks (a literal `endstream` inside
          // compressed data could otherwise steer the scan): a direct /Length that ends at `endstream` is required.
          if (!verified || ++st.objstms > MAX_OBJSTMS) return false;
          let body = b.subarray(start, bodyEnd);
          if (last.filter) {
            if (last.flate !== 1 || last.other || last.predictor || st.budget < 1) return false;
            try {
              body = inflateSync(body, { finishFlush: 2 /* Z_SYNC_FLUSH */, maxOutputLength: st.budget });
            } catch {
              return false;
            }
          }
          st.budget -= body.length;
          if (st.budget < 0 || !scanPdf(body, st, true)) return false;
        }
        i = idx + 9;
        last = null;
        continue;
      }
      let isInt = len <= 10;
      for (let k = i; isInt && k < j; k++) if (b[k]! < 48 || b[k]! > 57) isInt = false;
      if (!value(isInt ? 1 : len === 1 && b[i] === 82 ? 2 : 0)) return false;
      lenStep(isInt, top && top.lenState > 0 ? b.toString('latin1', i, j) : null);
      i = j;
    }
  }
  return kinds.length === 0 && !openAction;
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
