import { notFound } from 'next/navigation';
import { can } from '../../../../server/authz.ts';
import { MIN_PASSPHRASE_LENGTH } from '../../../../server/backup/archive.ts';
import { BACKUP_TABLES, EXCLUDED_TABLES } from '../../../../server/backup/tables.ts';
import { recentBackupEvents } from '../../../../server/services/backup.ts';
import { Banner, Csrf, dateOf, flatWithFlash, requireSession, type SearchParams } from '../../../components/ui.tsx';
import { ConfirmPassword, SettingsTabs } from '../../../components/settings.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Backup · TallyMed' };

const size = (bytes: number) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const FAILURES: Record<string, string> = {
  source_inconsistent: 'a stored document did not match its record', storage_unavailable: 'document storage was not available',
  download_cancelled: 'the download was cancelled or the connection dropped', internal: 'an unexpected error (see the server log)',
};

export default async function BackupPage({ searchParams }: { searchParams: SearchParams }) {
  const { ctx, actor, csrf } = await requireSession();
  if (!can(actor, 'settings:manage')) notFound();
  const q = await flatWithFlash(searchParams, '/settings/backup');
  const events = await recentBackupEvents(ctx.pool, actor);
  return <main id="main" className="wide">
    <h1>Backup</h1>
    <p>Download one file that holds everything this TallyMed has recorded, so it can be restored into a new installation. The file is made from a single consistent snapshot while the app keeps running.</p>
    <SettingsTabs current="/settings/backup" />
    <Banner code={q.error} />

    <form className="card" method="post" action="/api/settings/backup">
      <h2>Download a backup</h2><Csrf token={csrf} />
      <p>The backup contains medical and financial records and every stored document. Treat the file like the records themselves: keep it somewhere private, and prefer setting a passphrase.</p>
      <label htmlFor="passphrase">Passphrase to encrypt the file (optional, at least {MIN_PASSPHRASE_LENGTH} characters)</label>
      <input id="passphrase" name="passphrase" type="password" autoComplete="new-password" minLength={MIN_PASSPHRASE_LENGTH} maxLength={256} />
      <label htmlFor="passphraseConfirm">Repeat the passphrase</label>
      <input id="passphraseConfirm" name="passphraseConfirm" type="password" autoComplete="new-password" maxLength={256} />
      <p className="muted">With a passphrase the file is encrypted (AES-256-GCM, key derived with scrypt) and cannot be opened without it. The passphrase is not stored anywhere: if it is lost, that backup is lost. Without one the file is an ordinary compressed archive that anyone holding it can read.</p>
      <ConfirmPassword id="backup-pw" />
      <button type="submit">Download backup</button>
      <p className="muted">The download starts when the server has checked your password. Large document collections take a while; keep this page open until the file is complete. A file that was cut off is recognised as incomplete and refused on restore.</p>
    </form>

    <div className="card">
      <h2>What is in the file</h2>
      <ul>
        <li>Every record: the household and its people, providers, visits, bills and adjustments, payments, refunds and payment plans, HSA decisions, claims and receipts, documents with all their versions and attachments, assistant proposals, and the complete audit log ({BACKUP_TABLES.length} tables).</li>
        <li>The file of every stored document version, each checked against its recorded checksum while the backup is made.</li>
        <li>User accounts with their password hashes, so everyone signs in on the restored server with the password they already have.</li>
        <li>The General and Documents settings from this area.</li>
        <li>A manifest with the database version, the row count and SHA-256 of every table and file, and the ledger totals at the time of the backup.</li>
      </ul>
      <h3>Never included</h3>
      <ul>
        {Object.entries(EXCLUDED_TABLES).filter(([name]) => name !== 'schema_migrations').map(([name, why]) => <li key={name}>{why}</li>)}
        <li>The email (SMTP) settings and password and the reverse proxy list. They describe this server's network; enter them again on the new server.</li>
        <li>Assistant credentials. Tokens stop working; create new ones after a restore.</li>
        <li>Anything from the server environment: the database password, the secrets key, the proxy secret and the setup token.</li>
      </ul>
    </div>

    <div className="card">
      <h2>Restoring</h2>
      <p>A backup is restored into a new, empty TallyMed, never over an installation that already holds data. Install the same TallyMed version, run the migration command, open the setup page and choose <strong>Restore from a backup</strong> instead of creating the first administrator. You need the setup token, the file and, if you set one, the passphrase.</p>
      <p>The restore verifies every checksum before it writes anything, loads everything in one step, then compares each table and the ledger totals with the backup. If anything differs nothing is restored. On the server the same is available as <code>node apps/web/cli/backup.ts create | verify | restore</code>; <code>verify</code> checks a file without a database.</p>
    </div>

    <div className="card">
      <h2>Recent backups</h2>
      {events.length === 0 ? <p className="muted">No backup has been made from this page yet.</p> : <table className="stack"><thead><tr><th>When</th><th>What</th><th>By</th><th>Details</th></tr></thead><tbody>
        {events.map((e, i) => <tr key={i}>
          <td data-label="When">{dateOf(e.occurredAt)}</td>
          <td data-label="What">{e.action === 'backup.completed' ? 'Backup downloaded' : e.action === 'backup.restored' ? 'Restored from a backup' : 'Backup did not finish'}</td>
          <td data-label="By">{e.actorName ?? (e.action === 'backup.restored' ? 'Setup' : 'Server command')}</td>
          <td data-label="Details">{e.action === 'backup.completed'
            ? <>{size(Number(e.detail.bytes ?? 0))}, {String(e.detail.rows ?? 0)} records, {String(e.detail.documents ?? 0)} documents, {e.detail.encrypted ? 'encrypted' : 'not encrypted'}<br /><span className="muted">SHA-256 <code>{String(e.detail.sha256 ?? '')}</code></span></>
            : e.action === 'backup.restored'
              ? <>{String(e.detail.rows ?? 0)} records and {String(e.detail.documents ?? 0)} documents from the backup of {String(e.detail.backupCreatedAt ?? '').slice(0, 16).replace('T', ' ')} UTC</>
              : <>Reason: {FAILURES[String(e.detail.reason)] ?? FAILURES.internal}</>}</td>
        </tr>)}
      </tbody></table>}
      <p className="muted">Compare the SHA-256 here with the file you saved (<code>sha256sum</code> on Linux and macOS, <code>Get-FileHash</code> on Windows) to confirm the download is complete and unchanged.</p>
    </div>
  </main>;
}
