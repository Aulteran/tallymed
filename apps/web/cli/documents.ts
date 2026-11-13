// Operator commands for the private document volume.
//   node apps/web/cli/documents.ts verify    compare every stored version with its recorded size and SHA-256 (read-only); exit 1 on a problem
//   node apps/web/cli/documents.ts cleanup [--apply] [--force]
//                                            list (dry run, the default) or, with --apply, remove abandoned files and purge bytes of removed
//                                            documents past the retention window. --apply refuses when the database does not appear to match
//                                            the volume; --force overrides that after you have checked with verify.
// Both need DATABASE_URL and TALLYMED_DOCUMENTS_DIR. Output lists document and version numbers, never file names or titles.
import { parseDocumentsDir } from '../server/config.ts';
import { createPool } from '../server/db.ts';
import { cleanupStorage, verifyStorage } from '../server/services/documents.ts';
import { FileObjectStore } from '../server/storage.ts';

const command = process.argv[2];
const url = process.env.DATABASE_URL;
let dir: string | null = null;
try {
  dir = parseDocumentsDir(process.env.TALLYMED_DOCUMENTS_DIR);
} catch (error) {
  console.error((error as Error).message);
  process.exit(2);
}
if (!url || !dir || (command !== 'verify' && command !== 'cleanup')) {
  console.error('Usage: DATABASE_URL=... TALLYMED_DOCUMENTS_DIR=/path node apps/web/cli/documents.ts verify|cleanup');
  process.exit(2);
}
const pool = createPool(url, 2);
const store = new FileObjectStore(dir);
try {
  if (command === 'verify') {
    const report = await verifyStorage(pool, store);
    console.log(JSON.stringify(report, null, 2));
    if (report.missing.length || report.corrupt.length) process.exitCode = 1;
  } else {
    const days = Number(process.env.TALLYMED_DOCUMENT_RETENTION_DAYS ?? 30);
    if (!Number.isInteger(days) || days < 0 || days > 3650) throw new Error('TALLYMED_DOCUMENT_RETENTION_DAYS must be an integer from 0 to 3650');
    const flags = process.argv.slice(3);
    if (flags.some((f) => f !== '--apply' && f !== '--force')) throw new Error('Unknown option. Use --apply and optionally --force.');
    console.log(JSON.stringify(await cleanupStorage(pool, store, { retentionDays: days, apply: flags.includes('--apply'), force: flags.includes('--force') }), null, 2));
  }
} catch (error) {
  console.error('Document command failed:', (error as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
