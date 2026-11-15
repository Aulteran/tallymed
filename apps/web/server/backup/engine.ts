// Creating, verifying and restoring a TallyMed backup archive. No authorization happens here: the callers (services/backup.ts for the web
// app, cli/backup.ts for the operator) decide who may run these and write the audit rows around them.
//
// Archive layout (inside gzip, inside optional encryption; see archive.ts):
//   data/<table>.<part>.ndjson   one JSON object per row, tables in foreign-key order, parts of a few megabytes
//   documents/<storage key>      the bytes of every available document version
//   manifest.json                last entry: format and schema version, per-table row counts and SHA-256, per-entry size and SHA-256,
//                                ledger totals. Because it is written last, a cut-off download has no manifest and is refused.
//
// A backup reads one repeatable-read snapshot, so the tables are consistent with each other. A restore loads into an empty database inside
// one transaction and commits only after every check passed; a failure rolls everything back and removes the files it wrote.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { Readable, Transform as TransformStream_, pipeline as pipelineCallback, type Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import packageJson from '../../package.json' with { type: 'json' };
import type { Pool } from '../db.ts';
import { BOOTSTRAP_LOCK } from '../setup-token.ts';
import type { ObjectStore } from '../storage.ts';
import {
  BackupError, DATA_ENTRY, DOCUMENT_ENTRY, ENCRYPTION_MAGIC, GZIP_MAGIC, MANIFEST_ENTRY, MAX_DATA_PART_BYTES, TAR_END,
  dataEntryName, decryptStream, documentEntryName, encryptStream, limitStream, readTar, tarEntry, type ArchiveEntry,
} from './archive.ts';
import { ledgerSummary, ledgerViolations } from './ledger.ts';
import { BACKUP_TABLES, EXCLUDED_TABLES, tablesAt, exportQuery, identityColumns, pinOutputFormat, quoteIdent, tableColumns, type TableSpec } from './tables.ts';

export const BACKUP_FORMAT = 'tallymed-backup';
export const BACKUP_FORMAT_VERSION = 1;
const PART_TARGET_BYTES = 8 * 1024 * 1024;
const FETCH_ROWS = 500;
const INSERT_ROWS = 500;

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const manifestSchema = z.strictObject({
  format: z.literal(BACKUP_FORMAT),
  formatVersion: z.number().int().min(1).max(1000),
  backupId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  app: z.strictObject({ name: z.string().max(60), version: z.string().max(60) }),
  database: z.strictObject({
    serverVersion: z.string().max(60),
    migrations: z.array(z.strictObject({ version: z.string().regex(/^\d{4}$/), name: z.string().max(120), checksum: hex64 })).min(1).max(5000),
  }),
  tables: z.array(z.strictObject({
    name: z.string().regex(/^[a-z_]{1,60}$/), columns: z.array(z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/)).min(1).max(200),
    rows: count, parts: count, sha256: hex64,
  })).max(500),
  documents: z.strictObject({ count, bytes: count }),
  excluded: z.array(z.string().max(60)).max(500),
  ledger: z.record(z.string().max(60), z.string().regex(/^-?\d{1,30}$/)),
  entries: z.array(z.strictObject({ path: z.string().max(100), size: count, sha256: hex64 })),
});
export type BackupManifest = z.infer<typeof manifestSchema>;

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

// ---------- create ----------

export interface BackupOutcome {
  backupId: string; createdAt: string; encrypted: boolean; bytes: number; sha256: string; rows: number; documents: number; documentBytes: number;
}
export interface CreatedBackup {
  backupId: string; createdAt: string; filename: string; encrypted: boolean;
  /** The archive bytes. Reading it drives the export; destroying it cancels the backup and releases the database snapshot. */
  stream: Readable;
  /** Settles when the whole archive was read (or the backup failed or was cancelled). */
  done: Promise<BackupOutcome>;
}

async function* produce(pool: Pool, store: ObjectStore | null, meta: { backupId: string; createdAt: string }, totals: { rows: number; documents: number; documentBytes: number }): AsyncGenerator<Buffer> {
  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query('begin isolation level repeatable read read only');
    inTransaction = true;
    await pinOutputFormat(client);
    const entries: BackupManifest['entries'] = [];
    const tables: BackupManifest['tables'] = [];
    const entry = (name: string, content: Buffer): Buffer[] => {
      entries.push({ path: name, size: content.length, sha256: sha256(content) });
      return tarEntry(name, content);
    };
    const migrations = await client.query<{ version: string; name: string; checksum: string }>('select version, name, checksum from schema_migrations order by version');
    for (const spec of tablesAt(migrations.rows.map((m) => m.version))) {
      const columns = await tableColumns(client, spec.name);
      if (columns.length === 0) throw new BackupError('incompatible', 'The database is missing a table this version of TallyMed expects. Run the migration command first.');
      await client.query(`declare backup_rows no scroll cursor for ${exportQuery(spec, columns)}`);
      const digest = createHash('sha256');
      let rows = 0;
      let parts = 0;
      let lines: Buffer[] = [];
      let size = 0;
      const flush = (): Buffer[] => {
        const content = Buffer.concat(lines);
        lines = [];
        size = 0;
        digest.update(content);
        return entry(dataEntryName(spec.name, ++parts), content);
      };
      for (;;) {
        const page = await client.query<{ line: string }>(`fetch ${FETCH_ROWS} from backup_rows`);
        for (const row of page.rows) {
          const line = Buffer.from(`${row.line}\n`, 'utf8');
          if (line.length > MAX_DATA_PART_BYTES) throw new BackupError('source_inconsistent', 'A record is too large to back up.');
          if (size > 0 && size + line.length > PART_TARGET_BYTES) yield* flush();
          lines.push(line);
          size += line.length;
          rows++;
        }
        if (page.rows.length < FETCH_ROWS) break;
      }
      if (size > 0) yield* flush();
      await client.query('close backup_rows');
      tables.push({ name: spec.name, columns, rows, parts, sha256: digest.digest('hex') });
      totals.rows += rows;
    }
    // Every available document version, verified against its recorded size and checksum as it is read: a backup never carries a file the
    // database would not vouch for, and never silently skips one.
    const versions = await client.query<{ key: string; size: string; sha256: string }>(
      `select storage_key as key, size_bytes::text as size, encode(sha256, 'hex') as sha256 from document_versions where state = 'available' order by storage_key`);
    if (versions.rows.length > 0 && !store) throw new BackupError('storage_unavailable', 'Document storage is not configured on this server, but the database lists stored documents.');
    for (const v of versions.rows) {
      let bytes: Buffer;
      try {
        bytes = await store!.read(v.key);
      } catch {
        throw new BackupError('source_inconsistent', 'A stored document file is missing. Run the documents verify command, fix the document volume, then try again.');
      }
      if (String(bytes.length) !== v.size || sha256(bytes) !== v.sha256) {
        throw new BackupError('source_inconsistent', 'A stored document file does not match its recorded checksum. Run the documents verify command, then try again.');
      }
      totals.documents++;
      totals.documentBytes += bytes.length;
      yield* entry(documentEntryName(v.key), bytes);
    }
    const server = await client.query<{ server_version: string }>('show server_version');
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT, formatVersion: BACKUP_FORMAT_VERSION, backupId: meta.backupId, createdAt: meta.createdAt,
      app: { name: packageJson.name, version: packageJson.version },
      database: { serverVersion: server.rows[0]!.server_version.slice(0, 60), migrations: migrations.rows },
      tables,
      documents: { count: totals.documents, bytes: totals.documentBytes },
      excluded: Object.keys(EXCLUDED_TABLES),
      ledger: await ledgerSummary(client),
      entries,
    };
    await client.query('commit');
    inTransaction = false;
    yield* tarEntry(MANIFEST_ENTRY, Buffer.from(JSON.stringify(manifest, null, 1), 'utf8'));
    yield TAR_END;
  } finally {
    if (inTransaction) await client.query('rollback').catch(() => undefined);
    client.release();
  }
}

/** Starts a backup. Nothing is read until the stream is consumed. With a passphrase the archive is encrypted. */
export function createBackup(pool: Pool, store: ObjectStore | null, opts: { passphrase?: string | null; now?: Date } = {}): CreatedBackup {
  const backupId = randomUUID();
  const createdAt = (opts.now ?? new Date()).toISOString();
  const encrypted = !!opts.passphrase;
  const totals = { rows: 0, documents: 0, documentBytes: 0 };
  const hash = createHash('sha256');
  let bytes = 0;
  const meter = new TransformStream_({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      bytes += chunk.length;
      callback(null, chunk);
    },
  });
  const stages: Array<Readable | Transform> = [Readable.from(produce(pool, store, { backupId, createdAt }, totals), { objectMode: false }), createGzip({ level: 6 })];
  if (opts.passphrase) stages.push(encryptStream(opts.passphrase));
  const done = pipeline([...stages, meter] as unknown as [Readable, ...Transform[]])
    .then(() => ({ backupId, createdAt, encrypted, bytes, sha256: hash.digest('hex'), ...totals }));
  done.catch(() => undefined);
  const stamp = createdAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return { backupId, createdAt, encrypted, filename: `tallymed-backup-${stamp}.tar.gz${encrypted ? '.enc' : ''}`, stream: meter, done };
}

// ---------- read and verify ----------

const ZLIB_DAMAGE = new Set(['Z_DATA_ERROR', 'Z_BUF_ERROR', 'Z_STREAM_ERROR', 'ERR_STREAM_PREMATURE_CLOSE']);

/**
 * Streams the archive once and hands each entry to `onEntry`. Detects the container (encrypted or plain gzip) from the first bytes, bounds
 * the expanded size relative to the file, and returns the size and SHA-256 of the file as stored.
 */
async function scanArchive(file: string, passphrase: string | null, onEntry: (entry: ArchiveEntry, index: number) => Promise<void>): Promise<{ bytes: number; sha256: string; encrypted: boolean }> {
  const size = (await stat(file)).size;
  const handle = await open(file, 'r');
  const head = Buffer.alloc(ENCRYPTION_MAGIC.length);
  try {
    await handle.read(head, 0, head.length, 0);
  } finally {
    await handle.close();
  }
  const encrypted = head.equals(ENCRYPTION_MAGIC);
  if (!encrypted && !head.subarray(0, 2).equals(GZIP_MAGIC)) throw new BackupError('invalid_archive', 'This file is not a TallyMed backup.');
  if (encrypted && !passphrase) throw new BackupError('passphrase_required', 'This backup is encrypted. Enter the passphrase it was made with.');
  const hash = createHash('sha256');
  let bytes = 0;
  const raw = createReadStream(file);
  raw.on('data', (chunk) => {
    hash.update(chunk);
    bytes += chunk.length;
  });
  // A generous bound on expansion: text compresses well, documents hardly at all. It stops a small crafted file from expanding without end.
  const limit = Math.min(size * 200 + 256 * 1024 * 1024, 1024 ** 4);
  const stages = [raw, ...(encrypted ? [decryptStream(passphrase!)] : []), createGunzip(), limitStream(limit)];
  const last = pipelineCallback(stages as unknown as [Readable, ...Transform[]], () => undefined) as unknown as Readable;
  try {
    let index = 0;
    for await (const entry of readTar(last as AsyncIterable<Buffer>)) await onEntry(entry, index++);
  } catch (error) {
    raw.destroy();
    if (error instanceof BackupError) throw error;
    if (ZLIB_DAMAGE.has((error as { code?: string })?.code ?? '')) throw new BackupError('invalid_archive', 'The backup file is damaged or incomplete.');
    throw error;
  }
  return { bytes, sha256: hash.digest('hex'), encrypted };
}

function parseManifest(content: Buffer): BackupManifest {
  let value: unknown;
  try {
    value = JSON.parse(content.toString('utf8'));
  } catch {
    throw new BackupError('invalid_archive', 'The backup manifest is not readable.');
  }
  const head = value as { format?: unknown; formatVersion?: unknown } | null;
  if (!head || head.format !== BACKUP_FORMAT) throw new BackupError('invalid_archive', 'The backup manifest is not a TallyMed manifest.');
  if (head.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new BackupError('incompatible', 'This backup uses a newer or unknown backup format. Restore it with the TallyMed version that made it, or upgrade this server first.');
  }
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) throw new BackupError('invalid_archive', 'The backup manifest is not valid.');
  return parsed.data;
}

export interface VerifiedArchive { manifest: BackupManifest; bytes: number; sha256: string; encrypted: boolean }

/**
 * Reads the whole archive and proves it is complete and unchanged: every entry is listed in the manifest with the same size and SHA-256,
 * nothing is missing or extra, each table's parts add up to the recorded row count and checksum, and the tables are the ones this version
 * backs up. Needs no database. Throws a BackupError that says what is wrong.
 */
export async function verifyArchive(file: string, passphrase: string | null = null): Promise<VerifiedArchive> {
  const seen: BackupManifest['entries'] = [];
  const order = new Map(BACKUP_TABLES.map((t, i) => [t.name, i]));
  const tables = new Map<string, { hash: ReturnType<typeof createHash>; rows: number; parts: number }>();
  let lastTable = -1;
  let documents = 0;
  let documentBytes = 0;
  let manifest: BackupManifest | null = null;
  const file_ = await scanArchive(file, passphrase, async (entry) => {
    if (entry.kind === 'manifest') {
      manifest = parseManifest(entry.content);
      return;
    }
    seen.push({ path: entry.name, size: entry.content.length, sha256: sha256(entry.content) });
    if (entry.kind === 'document') {
      documents++;
      documentBytes += entry.content.length;
      return;
    }
    const m = DATA_ENTRY.exec(entry.name)!;
    const index = order.get(m[1]!);
    if (index === undefined) throw new BackupError('incompatible', 'The backup contains a table this version of TallyMed does not know.');
    const state = tables.get(m[1]!) ?? { hash: createHash('sha256'), rows: 0, parts: 0 };
    if (index < lastTable || Number(m[2]) !== state.parts + 1) throw new BackupError('invalid_archive', 'The backup data files are out of order.');
    lastTable = index;
    if (entry.content.length === 0 || entry.content[entry.content.length - 1] !== 0x0a) throw new BackupError('invalid_archive', 'A backup data file is cut off.');
    state.parts++;
    for (const b of entry.content) if (b === 0x0a) state.rows++;
    state.hash.update(entry.content);
    tables.set(m[1]!, state);
  });
  const mf = manifest as BackupManifest | null;
  if (!mf) throw new BackupError('invalid_archive', 'The backup file has no manifest. It is incomplete.');
  const same = mf.entries.length === seen.length && mf.entries.every((e, i) => e.path === seen[i]!.path && e.size === seen[i]!.size && e.sha256 === seen[i]!.sha256);
  if (!same) throw new BackupError('invalid_archive', 'The backup contents do not match its manifest. The file was changed or is damaged.');
  const expectedTables = tablesAt(mf.database.migrations.map((m) => m.version));
  if (mf.tables.length !== expectedTables.length || mf.tables.some((t, i) => t.name !== expectedTables[i]!.name)) {
    throw new BackupError('incompatible', 'This backup was made by a different version of TallyMed (its list of tables differs).');
  }
  for (const t of mf.tables) {
    const state = tables.get(t.name);
    const digest = state ? state.hash.digest('hex') : sha256(Buffer.alloc(0));
    if ((state?.rows ?? 0) !== t.rows || (state?.parts ?? 0) !== t.parts || digest !== t.sha256) {
      throw new BackupError('invalid_archive', 'A table in the backup does not match its recorded checksum.');
    }
  }
  if (mf.documents.count !== documents || mf.documents.bytes !== documentBytes) {
    throw new BackupError('invalid_archive', 'The documents in the backup do not match its manifest.');
  }
  return { manifest: mf, ...file_ };
}

// ---------- restore ----------

export interface RestoreResult {
  backupId: string; createdAt: string; rows: number; documents: number; householdId: string; archiveSha256: string; ledger: Record<string, string>;
}

const targetMigrations = async (client: PoolClient) => {
  try {
    return (await client.query<{ version: string; checksum: string }>('select version, checksum from schema_migrations order by version')).rows;
  } catch (error) {
    if ((error as { code?: string })?.code === '42P01') return [];
    throw error;
  }
};

/** Which way the schema of a database differs from the backup's: used by the command line to load at the backup's version, then upgrade. */
export function compareSchema(manifest: BackupManifest, target: Array<{ version: string; checksum: string }>): 'same' | 'target_behind' | 'target_ahead' | 'diverged' {
  const source = manifest.database.migrations;
  const shared = Math.min(source.length, target.length);
  for (let i = 0; i < shared; i++) if (source[i]!.version !== target[i]!.version || source[i]!.checksum !== target[i]!.checksum) return 'diverged';
  return source.length === target.length ? 'same' : source.length > target.length ? 'target_behind' : 'target_ahead';
}

async function assertRestorable(client: PoolClient, manifest: BackupManifest): Promise<void> {
  const relation = compareSchema(manifest, await targetMigrations(client));
  const backupVersion = manifest.database.migrations[manifest.database.migrations.length - 1]!.version;
  if (relation === 'target_ahead') {
    throw new BackupError('incompatible', `This backup was made at database version ${backupVersion}, and this server is newer. Restore it with the backup command into a new, empty database: the command loads the backup at its own version and then upgrades it.`);
  }
  if (relation === 'target_behind') {
    throw new BackupError('incompatible', `This backup was made at database version ${backupVersion}, and this server is older. Upgrade TallyMed (and run the migration command) before restoring.`);
  }
  if (relation === 'diverged') throw new BackupError('incompatible', 'This backup was made by a different build of TallyMed: its database migrations do not match this server.');
  for (const t of manifest.tables) {
    const columns = await tableColumns(client, t.name);
    if (columns.length !== t.columns.length || columns.some((c, i) => c !== t.columns[i])) {
      throw new BackupError('incompatible', 'This backup does not match the database layout of this server.');
    }
  }
  for (const spec of tablesAt(manifest.database.migrations.map((m) => m.version))) {
    const r = await client.query(`select 1 from ${quoteIdent(spec.name)} limit 1`);
    if (r.rowCount) throw new BackupError('not_empty', 'This TallyMed already holds data. A backup can only be restored into a new, empty installation.');
  }
}

async function tableDigest(client: PoolClient, spec: TableSpec, columns: string[]): Promise<{ rows: number; sha256: string }> {
  await client.query(`declare restore_check no scroll cursor for ${exportQuery(spec, columns)}`);
  const digest = createHash('sha256');
  let rows = 0;
  for (;;) {
    const page = await client.query<{ line: string }>(`fetch ${FETCH_ROWS} from restore_check`);
    for (const row of page.rows) digest.update(`${row.line}\n`, 'utf8');
    rows += page.rows.length;
    if (page.rows.length < FETCH_ROWS) break;
  }
  await client.query('close restore_check');
  return { rows, sha256: digest.digest('hex') };
}

const DATABASE_REFUSAL = /^(22|23)/;

/**
 * Restores a verified archive into an empty, migrated database and document store. Everything happens in one transaction under the setup
 * lock: the archive is verified first, loaded, then each table is exported again and compared with the backup, the ledger rules and totals
 * are checked, and every document is compared with its recorded checksum before it is stored. Any failure leaves the database as it was
 * and removes the document files written so far.
 */
export async function restoreArchive(
  pool: Pool, store: ObjectStore | null, file: string,
  opts: { passphrase?: string | null; via: 'setup' | 'cli'; requestId?: string | null },
): Promise<RestoreResult> {
  const passphrase = opts.passphrase ?? null;
  const { manifest } = await verifyArchive(file, passphrase);
  if (manifest.documents.count > 0 && !store) {
    throw new BackupError('storage_unavailable', 'This backup contains documents, but document storage is not configured on this server (TALLYMED_DOCUMENTS_DIR).');
  }
  const client = await pool.connect();
  const written: string[] = [];
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock($1)', [BOOTSTRAP_LOCK]);
    await pinOutputFormat(client);
    await assertRestorable(client, manifest);
    const present = tablesAt(manifest.database.migrations.map((m) => m.version));
    const specs = new Map(BACKUP_TABLES.map((t) => [t.name, t]));
    const columns = new Map(manifest.tables.map((t) => [t.name, t.columns]));
    // Insert-time triggers judge new entries against the present state of other rows; history is loaded as recorded and checked as a whole below.
    for (const spec of present) await client.query(`alter table ${quoteIdent(spec.name)} disable trigger user`);
    let dataFinished = false;
    let expected = new Map<string, { size: string; sha256: string }>();
    let householdId = '';
    const finishData = async () => {
      dataFinished = true;
      for (const spec of present) {
        await client.query(`alter table ${quoteIdent(spec.name)} enable trigger user`);
        for (const column of await identityColumns(client, spec.name)) {
          await client.query(
            `select setval(pg_get_serial_sequence($1, $2), coalesce((select max(${quoteIdent(column)}) from ${quoteIdent(spec.name)}), 0) + 1, false)`,
            [`public.${spec.name}`, column]);
        }
      }
      for (const t of manifest.tables) {
        const now = await tableDigest(client, specs.get(t.name)!, t.columns);
        if (now.rows !== t.rows || now.sha256 !== t.sha256) {
          throw new BackupError('verification_failed', 'The restored data does not match the backup exactly. Nothing was restored.');
        }
      }
      const broken = await ledgerViolations(client);
      if (broken.length) throw new BackupError('verification_failed', `The backup breaks a ledger rule, so nothing was restored: ${broken.join('; ')}.`);
      const summary = await ledgerSummary(client);
      const keys = new Set([...Object.keys(summary), ...Object.keys(manifest.ledger)]);
      for (const key of keys) {
        // A backup of a database older than 0017 has no removed-payment total; restored into a newer schema that total can only be zero.
        if (key === 'removedPayments' && manifest.ledger[key] === undefined && summary[key] === '0') continue;
        if (summary[key] !== manifest.ledger[key]) throw new BackupError('verification_failed', 'The restored ledger totals differ from the totals recorded in the backup. Nothing was restored.');
      }
      const state = await client.query<{ household_id: string }>('select household_id from bootstrap_state');
      const admins = await client.query(`select 1 from users where role = 'admin' and status = 'active' and not must_change_password limit 1`);
      if (state.rowCount !== 1 || !admins.rowCount) {
        throw new BackupError('verification_failed', 'The backup has no administrator who could sign in afterwards. Nothing was restored.');
      }
      householdId = state.rows[0]!.household_id;
      const versions = await client.query<{ key: string; size: string; sha256: string }>(
        `select storage_key as key, size_bytes::text as size, encode(sha256, 'hex') as sha256 from document_versions where state = 'available'`);
      expected = new Map(versions.rows.map((v) => [v.key, { size: v.size, sha256: v.sha256 }]));
    };
    let scanned: { sha256: string };
    try {
      scanned = await scanArchive(file, passphrase, async (entry, index) => {
        if (entry.kind === 'manifest') return;
        const listed = manifest.entries[index];
        const digest = sha256(entry.content);
        if (!listed || listed.path !== entry.name || listed.size !== entry.content.length || listed.sha256 !== digest) {
          throw new BackupError('invalid_archive', 'The backup file changed while it was being restored. Nothing was restored.');
        }
        if (entry.kind === 'data') {
          const table = DATA_ENTRY.exec(entry.name)![1]!;
          const list = columns.get(table)!.map(quoteIdent).join(', ');
          const lines = entry.content.toString('utf8').split('\n');
          lines.pop();
          for (let i = 0; i < lines.length; i += INSERT_ROWS) {
            await client.query(
              `insert into ${quoteIdent(table)} (${list}) overriding system value select ${list} from json_populate_recordset(null::${quoteIdent(table)}, $1::json)`,
              [`[${lines.slice(i, i + INSERT_ROWS).join(',')}]`]);
          }
          return;
        }
        if (!dataFinished) await finishData();
        const key = DOCUMENT_ENTRY.exec(entry.name)![1]!;
        const want = expected.get(key);
        if (!want || want.size !== String(entry.content.length) || want.sha256 !== digest) {
          throw new BackupError('verification_failed', 'A document in the backup does not match the record that describes it. Nothing was restored.');
        }
        expected.delete(key);
        // A key that already exists on the volume is refused and left alone; only files this restore created are removed on failure.
        await store!.putQuarantine(key, entry.content);
        try {
          await store!.promote(key);
        } catch (error) {
          await store!.removeQuarantine(key).catch(() => undefined);
          throw error;
        }
        written.push(key);
      });
      if (!dataFinished) await finishData();
    } catch (error) {
      const code = (error as { code?: string })?.code ?? '';
      if (error instanceof BackupError) throw error;
      if (DATABASE_REFUSAL.test(code)) throw new BackupError('verification_failed', 'The database refused the backup data because it breaks one of its rules. Nothing was restored.');
      if (code === '42501') throw new BackupError('incompatible', 'The database user must own the TallyMed tables to restore a backup. Use the same database user that ran the migrations.');
      throw error;
    }
    if (expected.size > 0) throw new BackupError('verification_failed', 'The backup is missing a document file that its records describe. Nothing was restored.');
    const rows = manifest.tables.reduce((n, t) => n + t.rows, 0);
    await client.query(
      `insert into audit_events (household_id, actor_user_id, action, entity_type, entity_id, request_id, detail) values ($1, null, 'backup.restored', 'backup', $2, $3, $4)`,
      [householdId, manifest.backupId, opts.requestId ?? null, JSON.stringify({
        via: opts.via, backupCreatedAt: manifest.createdAt, rows, documents: manifest.documents.count, archiveSha256: scanned.sha256,
        schemaVersion: manifest.database.migrations[manifest.database.migrations.length - 1]!.version,
      })]);
    await client.query('commit');
    return { backupId: manifest.backupId, createdAt: manifest.createdAt, rows, documents: manifest.documents.count, householdId, archiveSha256: scanned.sha256, ledger: manifest.ledger };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    if (store) for (const key of written) await store.remove(key).catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
