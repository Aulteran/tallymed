// Container format of a TallyMed backup: a gzip-compressed tar stream, optionally wrapped in passphrase encryption.
//
// The tar writer and reader are deliberately tiny and strict. A backup holds only three kinds of regular files whose names come from a
// fixed pattern (`data/<table>.<part>.ndjson`, `documents/<storage key>`, `manifest.json`), in that order, each of a bounded size. The reader
// rejects everything else: links, directories, devices, long-name extensions, path separators beyond the one fixed directory, duplicate
// names, bad header checksums and trailing data. No name from an archive is ever used as a file system path.
//
// Encryption (optional): scrypt derives a 256-bit key from the passphrase and a random salt; the gzip stream is cut into 64 KiB frames, each
// sealed with AES-256-GCM. The nonce is the frame counter plus a "last frame" flag and the header is authenticated with every frame, so
// frames cannot be reordered, dropped, truncated or moved to another file without detection.
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';

export type BackupErrorCode =
  | 'invalid_archive' | 'passphrase_required' | 'passphrase_wrong' | 'too_large' | 'incompatible' | 'not_empty' | 'source_inconsistent'
  | 'storage_unavailable' | 'verification_failed';

/** A refusal with a message that is safe to show: it never contains record content, file names from the archive or secrets. */
export class BackupError extends Error {
  readonly code: BackupErrorCode;
  constructor(code: BackupErrorCode, message: string) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
  }
}

// ---------- tar ----------

const BLOCK = 512;
export const MAX_DATA_PART_BYTES = 32 * 1024 * 1024;
/** The database refuses document versions above this size (document_versions.size_bytes). */
export const MAX_DOCUMENT_BYTES = 26_214_400;
export const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
export const MAX_ENTRIES = 2_000_000;

export const DATA_ENTRY = /^data\/([a-z_]{1,60})\.(\d{6})\.ndjson$/;
export const DOCUMENT_ENTRY = /^documents\/([0-9a-f]{32})$/;
export const MANIFEST_ENTRY = 'manifest.json';

export const dataEntryName = (table: string, part: number) => `data/${table}.${String(part).padStart(6, '0')}.ndjson`;
export const documentEntryName = (key: string) => `documents/${key}`;

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

/** One ustar header block for a regular file. Fixed owner, mode and time, so the same content always gives the same bytes. */
export function tarHeader(name: string, size: number): Buffer {
  if (Buffer.byteLength(name) > 99 || !Number.isSafeInteger(size) || size < 0 || size > 0o77777777777) throw new Error('unsupported tar entry');
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 'ascii');
  h.write(octal(0o600, 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii');
  h.write(octal(0, 8), 116, 'ascii');
  h.write(octal(size, 12), 124, 'ascii');
  h.write(octal(0, 12), 136, 'ascii');
  h.write('        ', 148, 'ascii');
  h.write('0', 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return h;
}

/** Header, content and zero padding to the next block. */
export function tarEntry(name: string, content: Buffer): Buffer[] {
  const pad = (BLOCK - (content.length % BLOCK)) % BLOCK;
  return pad ? [tarHeader(name, content.length), content, Buffer.alloc(pad)] : [tarHeader(name, content.length), content];
}

export const TAR_END = Buffer.alloc(BLOCK * 2);

/** Pulls exact byte counts from a chunked source. */
class ByteReader {
  private readonly source: AsyncIterator<Buffer>;
  private chunks: Buffer[] = [];
  private buffered = 0;
  private ended = false;
  constructor(source: AsyncIterable<Buffer>) {
    this.source = source[Symbol.asyncIterator]();
  }

  /** Exactly `n` bytes, or null at a clean end of input before the first byte. A partial read is an error. */
  async read(n: number): Promise<Buffer | null> {
    while (this.buffered < n && !this.ended) {
      const next = await this.source.next();
      if (next.done) this.ended = true;
      else if (next.value.length) {
        this.chunks.push(next.value);
        this.buffered += next.value.length;
      }
    }
    if (this.buffered === 0 && n > 0) return null;
    if (this.buffered < n) throw new BackupError('invalid_archive', 'The backup file ends in the middle of an entry. It is incomplete or damaged.');
    const all = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks);
    const out = all.subarray(0, n);
    const rest = all.subarray(n);
    this.chunks = rest.length ? [rest] : [];
    this.buffered = rest.length;
    return out;
  }
}

export interface ArchiveEntry { name: string; kind: 'data' | 'document' | 'manifest'; content: Buffer }

const isZero = (b: Buffer) => b.every((v) => v === 0);

function parseHeader(h: Buffer): { name: string; size: number } {
  const stored = Number.parseInt(h.subarray(148, 156).toString('ascii').replace(/[\0 ]+$/, '').trim() || 'x', 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
  if (!Number.isInteger(stored) || stored !== sum) throw new BackupError('invalid_archive', 'The backup file has a damaged entry header.');
  const type = h[156]!;
  // Regular files only: no links, directories, devices, or the extensions that carry long or relative names.
  if (type !== 0x30 && type !== 0) throw new BackupError('invalid_archive', 'The backup file contains an entry that is not a regular file.');
  if (h[345] !== 0 || h[157] !== 0) throw new BackupError('invalid_archive', 'The backup file contains an entry with a link or a name prefix.');
  const end = h.indexOf(0);
  const name = h.subarray(0, end < 0 || end > 100 ? 100 : end).toString('latin1');
  const sizeText = h.subarray(124, 136).toString('ascii').replace(/[\0 ]+$/, '');
  if (!/^[0-7]{1,11}$/.test(sizeText)) throw new BackupError('invalid_archive', 'The backup file has an entry with an unreadable size.');
  return { name, size: Number.parseInt(sizeText, 8) };
}

/**
 * Reads a decompressed tar stream entry by entry. Each entry is small enough to hold in memory (the caps above), so callers get whole
 * buffers. The order is fixed: data parts, then documents, then the manifest as the last entry, then the end marker and nothing else.
 */
export async function* readTar(source: AsyncIterable<Buffer>): AsyncGenerator<ArchiveEntry> {
  const reader = new ByteReader(source);
  const seen = new Set<string>();
  let stage = 0;
  let count = 0;
  let manifest = false;
  for (;;) {
    const header = await reader.read(BLOCK);
    if (header === null) throw new BackupError('invalid_archive', 'The backup file is incomplete: its end marker is missing.');
    if (isZero(header)) {
      for (;;) {
        const rest = await reader.read(BLOCK);
        if (rest === null) break;
        if (!isZero(rest)) throw new BackupError('invalid_archive', 'The backup file has data after its end marker.');
      }
      if (!manifest) throw new BackupError('invalid_archive', 'The backup file has no manifest. It is incomplete.');
      return;
    }
    if (manifest) throw new BackupError('invalid_archive', 'The backup file has entries after its manifest.');
    const { name, size } = parseHeader(header);
    const kind: ArchiveEntry['kind'] | null = DATA_ENTRY.test(name) ? 'data' : DOCUMENT_ENTRY.test(name) ? 'document' : name === MANIFEST_ENTRY ? 'manifest' : null;
    if (kind === null) throw new BackupError('invalid_archive', 'The backup file contains an entry with an unexpected name.');
    const limit = kind === 'data' ? MAX_DATA_PART_BYTES : kind === 'document' ? MAX_DOCUMENT_BYTES : MAX_MANIFEST_BYTES;
    if (size > limit) throw new BackupError('invalid_archive', 'The backup file contains an entry that is larger than allowed.');
    if (seen.has(name)) throw new BackupError('invalid_archive', 'The backup file contains the same entry twice.');
    if (++count > MAX_ENTRIES) throw new BackupError('invalid_archive', 'The backup file contains too many entries.');
    seen.add(name);
    const rank = kind === 'data' ? 0 : kind === 'document' ? 1 : 2;
    if (rank < stage) throw new BackupError('invalid_archive', 'The backup file has its entries in an unexpected order.');
    stage = rank;
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    const body = padded === 0 ? Buffer.alloc(0) : await reader.read(padded);
    if (body === null) throw new BackupError('invalid_archive', 'The backup file ends in the middle of an entry. It is incomplete or damaged.');
    if (kind === 'manifest') manifest = true;
    // Copy out of the (possibly large, shared) read buffer so a caller can keep the entry without pinning it.
    yield { name, kind, content: Buffer.from(body.subarray(0, size)) };
  }
}

// ---------- passphrase encryption ----------

export const ENCRYPTION_MAGIC = Buffer.from('TMBKENC1', 'ascii');
export const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);
const SALT_BYTES = 16;
const HEADER_BYTES = ENCRYPTION_MAGIC.length + SALT_BYTES + 3;
const FRAME_BYTES = 64 * 1024;
const TAG_BYTES = 16;
// scrypt N = 2^16, r = 8, p = 2: about 64 MiB of memory for one derivation per backup or restore.
const SCRYPT = { logN: 16, r: 8, p: 2 };
export const MIN_PASSPHRASE_LENGTH = 12;
export const MAX_PASSPHRASE_LENGTH = 256;

function deriveKey(passphrase: string, salt: Buffer, logN: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(Buffer.from(passphrase.normalize('NFKC'), 'utf8'), salt, 32, { N: 2 ** logN, r, p, maxmem: 256 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function nonce(counter: number, last: boolean): Buffer {
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(BigInt(counter), 0);
  n[11] = last ? 1 : 0;
  return n;
}

/** Wraps a byte stream in the encrypted container. The passphrase is used once to derive the key and is not kept. */
export function encryptStream(passphrase: string): Transform {
  const salt = randomBytes(SALT_BYTES);
  const header = Buffer.concat([ENCRYPTION_MAGIC, salt, Buffer.from([SCRYPT.logN, SCRYPT.r, SCRYPT.p])]);
  const keyReady = deriveKey(passphrase, salt, SCRYPT.logN, SCRYPT.r, SCRYPT.p);
  let pending: Buffer = Buffer.alloc(0);
  let counter = 0;
  let started = false;
  const seal = (key: Buffer, plain: Buffer, last: boolean): Buffer => {
    const cipher = createCipheriv('aes-256-gcm', key, nonce(counter++, last));
    cipher.setAAD(header);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(plain.length, 0);
    return Buffer.concat([length, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, callback: TransformCallback) {
      keyReady.then((key) => {
        if (!started) {
          started = true;
          this.push(header);
        }
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        // Keep at least one byte back so the final frame, which carries the "last" flag, is produced by flush.
        while (pending.length > FRAME_BYTES) {
          this.push(seal(key, pending.subarray(0, FRAME_BYTES), false));
          pending = pending.subarray(FRAME_BYTES);
        }
        callback();
      }, callback);
    },
    flush(callback: TransformCallback) {
      keyReady.then((key) => {
        if (!started) this.push(header);
        this.push(seal(key, pending, true));
        callback();
      }, callback);
    },
  });
}

/** Reverses encryptStream. A wrong passphrase, a damaged byte or a cut-off file is an error; no unauthenticated byte is ever passed on. */
export function decryptStream(passphrase: string): Transform {
  let pending: Buffer = Buffer.alloc(0);
  let header: Buffer | null = null;
  let key: Buffer | null = null;
  let counter = 0;
  let finished = false;
  const step = async (stream: Transform): Promise<void> => {
    if (!header) {
      if (pending.length < HEADER_BYTES) return;
      header = Buffer.from(pending.subarray(0, HEADER_BYTES));
      pending = pending.subarray(HEADER_BYTES);
      if (!header.subarray(0, ENCRYPTION_MAGIC.length).equals(ENCRYPTION_MAGIC)) throw new BackupError('invalid_archive', 'This is not an encrypted TallyMed backup.');
      const [logN, r, p] = [header[24]!, header[25]!, header[26]!];
      // Bounded parameters: a crafted header cannot make the server spend unbounded memory or time deriving a key.
      if (logN < 14 || logN > 17 || r !== 8 || p < 1 || p > 4) throw new BackupError('invalid_archive', 'The encrypted backup uses unsupported key settings.');
      key = await deriveKey(passphrase, header.subarray(ENCRYPTION_MAGIC.length, ENCRYPTION_MAGIC.length + SALT_BYTES), logN, r, p);
    }
    for (;;) {
      if (pending.length < 4) return;
      const length = pending.readUInt32BE(0);
      if (length > FRAME_BYTES) throw new BackupError('invalid_archive', 'The encrypted backup is damaged.');
      const total = 4 + length + TAG_BYTES;
      if (pending.length < total) return;
      if (finished) throw new BackupError('invalid_archive', 'The encrypted backup has data after its end.');
      const body = pending.subarray(4, 4 + length);
      const tag = pending.subarray(4 + length, total);
      // The frame does not say whether it is the last one; try the nonce for "more follows" first, then "last". Either way the tag decides.
      let plain: Buffer | null = null;
      for (const last of [false, true]) {
        try {
          const decipher = createDecipheriv('aes-256-gcm', key!, nonce(counter, last));
          decipher.setAAD(header);
          decipher.setAuthTag(tag);
          plain = Buffer.concat([decipher.update(body), decipher.final()]);
          finished = last;
          break;
        } catch {
          plain = null;
        }
      }
      if (plain === null) {
        throw counter === 0
          ? new BackupError('passphrase_wrong', 'The passphrase is not correct for this backup, or the file is damaged.')
          : new BackupError('invalid_archive', 'The encrypted backup is damaged.');
      }
      counter++;
      pending = pending.subarray(total);
      if (plain.length) stream.push(plain);
    }
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, callback: TransformCallback) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      step(this).then(() => callback(), callback);
    },
    flush(callback: TransformCallback) {
      step(this).then(() => {
        if (!finished || pending.length) callback(new BackupError('invalid_archive', 'The encrypted backup is cut off. It is incomplete.'));
        else callback();
      }, callback);
    },
  });
}

/** Counts bytes and fails once more than `limit` have passed, so a small file cannot expand without bound. */
export function limitStream(limit: number): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback: TransformCallback) {
      total += chunk.length;
      if (total > limit) callback(new BackupError('too_large', 'The backup expands to more data than this server accepts.'));
      else callback(null, chunk);
    },
  });
}
