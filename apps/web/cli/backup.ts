// Operator commands for server-wide backups. The same archive the administrator's Backup page downloads.
//   node apps/web/cli/backup.ts create <file>    write a backup of the whole installation to <file> (refuses to overwrite)
//   node apps/web/cli/backup.ts verify <file>    check a backup file end to end without touching a database; exit 1 if it is not intact
//   node apps/web/cli/backup.ts restore <file>   load a backup into an EMPTY database and document volume, then verify the result
// create and restore need DATABASE_URL, and TALLYMED_DOCUMENTS_DIR when documents are stored. An encrypted backup takes its passphrase
// from the TALLYMED_BACKUP_PASSPHRASE environment variable (never from the command line, which other users of the machine can read).
// restore accepts a database that has no tables yet or that was migrated but never set up. When the backup is older than this build it
// loads the backup at the backup's own database version and then applies the newer migrations.
// Output is counts and checksums only, never record content.
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { BackupError, MIN_PASSPHRASE_LENGTH } from '../server/backup/archive.ts';
import { compareSchema, createBackup, restoreArchive, verifyArchive, type BackupManifest } from '../server/backup/engine.ts';
import { parseDocumentsDir } from '../server/config.ts';
import { createPool, type Pool } from '../server/db.ts';
import { listMigrations, migrate } from '../server/migrate.ts';
import { FileObjectStore } from '../server/storage.ts';

const [command, file] = process.argv.slice(2);
const usage = () => {
  console.error('Usage: node apps/web/cli/backup.ts create|verify|restore <file>');
  process.exit(2);
};
if (!file || process.argv.length !== 4 || (command !== 'create' && command !== 'verify' && command !== 'restore')) usage();
const passphrase = process.env.TALLYMED_BACKUP_PASSPHRASE || null;

const describe = (m: BackupManifest) => ({
  backupId: m.backupId, createdAt: m.createdAt, appVersion: m.app.version,
  databaseVersion: m.database.migrations[m.database.migrations.length - 1]!.version,
  records: m.tables.reduce((n, t) => n + t.rows, 0), tables: Object.fromEntries(m.tables.filter((t) => t.rows > 0).map((t) => [t.name, t.rows])),
  documents: m.documents.count, documentBytes: m.documents.bytes, ledger: m.ledger,
});

function resources(): { pool: Pool; store: FileObjectStore | null } {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const dir = parseDocumentsDir(process.env.TALLYMED_DOCUMENTS_DIR);
  return { pool: createPool(url, 2), store: dir ? new FileObjectStore(dir) : null };
}

/** Brings an unmigrated or older empty database to the backup's schema version, so the backup loads at the version it was made with. */
async function prepareSchema(pool: Pool, manifest: BackupManifest): Promise<void> {
  const known = new Map(listMigrations().map((m) => [m.version, m.checksum]));
  for (const m of manifest.database.migrations) {
    if (known.get(m.version) !== m.checksum) {
      throw new BackupError('incompatible', `This build of TallyMed does not have database migration ${m.version} as the backup recorded it. Use the TallyMed version that made the backup, or a newer one.`);
    }
  }
  const applied = await pool.query<{ version: string; checksum: string }>('select version, checksum from schema_migrations order by version')
    .then((r) => r.rows, (error: { code?: string }) => { if (error.code === '42P01') return []; throw error; });
  if (compareSchema(manifest, applied) === 'target_behind') {
    await migrate(pool, { upTo: manifest.database.migrations[manifest.database.migrations.length - 1]!.version });
  }
}

let pool: Pool | null = null;
try {
  if (command === 'verify') {
    const v = await verifyArchive(file!, passphrase);
    console.log(JSON.stringify({ ok: true, encrypted: v.encrypted, bytes: v.bytes, sha256: v.sha256, ...describe(v.manifest) }, null, 2));
  } else if (command === 'create') {
    if (passphrase !== null && passphrase.length < MIN_PASSPHRASE_LENGTH) throw new Error(`TALLYMED_BACKUP_PASSPHRASE must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
    const r = resources();
    pool = r.pool;
    const backup = createBackup(r.pool, r.store, { passphrase });
    try {
      await pipeline(backup.stream, createWriteStream(file!, { flags: 'wx', mode: 0o600 }));
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') await rm(file!, { force: true });
      throw error;
    }
    const outcome = await backup.done;
    // Read the file back in full: a backup is reported as made only after it verified.
    await verifyArchive(file!, passphrase);
    await r.pool.query(
      `insert into audit_events (household_id, actor_user_id, action, entity_type, entity_id, detail)
       select household_id, null, 'backup.completed', 'backup', $1, $2 from bootstrap_state`,
      [outcome.backupId, JSON.stringify({ via: 'cli', encrypted: outcome.encrypted, bytes: outcome.bytes, sha256: outcome.sha256, rows: outcome.rows, documents: outcome.documents })]);
    console.log(JSON.stringify({ ok: true, verified: true, file, ...outcome }, null, 2));
  } else {
    const r = resources();
    pool = r.pool;
    const { manifest } = await verifyArchive(file!, passphrase);
    await prepareSchema(r.pool, manifest);
    const result = await restoreArchive(r.pool, r.store, file!, { passphrase, via: 'cli' });
    const upgraded = await migrate(r.pool);
    console.log(JSON.stringify({ ok: true, restored: describe(manifest), archiveSha256: result.archiveSha256, migrationsAppliedAfterRestore: upgraded }, null, 2));
    console.log('Restore complete and verified. Start the web service, sign in with an account from the backup, and re-enter the email and reverse proxy settings.');
  }
} catch (error) {
  console.error(`Backup ${command} failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  if (pool) await pool.end();
}
