'use client';
import { useState, type FormEvent } from 'react';
import { errorMessage } from './messages.ts';

interface Restored { backupCreatedAt: string; records: number; documents: number }

const encode = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/**
 * Sends the chosen backup file as the request body so the server can stream it to disk; a form post would make the server hold the whole
 * file in memory. The setup token and passphrase go in headers of this same-origin request and are never put in the address.
 */
export function RestoreForm({ maxMb, documentsConfigured }: { maxMb: number; documentsConfigured: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Restored | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const file = form.get('file');
    const token = String(form.get('setupToken') ?? '');
    const passphrase = String(form.get('passphrase') ?? '');
    if (!(file instanceof File) || file.size === 0) { setError('Choose the backup file.'); return; }
    if (file.size > maxMb * 1048576) { setError(`That file is larger than this server accepts here (${maxMb} MB). Restore it with the backup command on the server instead.`); return; }
    setBusy(true);
    setError(null);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream', Accept: 'application/json', 'X-Setup-Token': encode(token) };
      if (passphrase) headers['X-Backup-Passphrase'] = encode(passphrase);
      const res = await fetch('/api/setup/restore', { method: 'POST', headers, body: file, credentials: 'same-origin' });
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: { code?: string; message?: string } } & Partial<Restored> | null;
      if (res.ok && data?.ok) setDone({ backupCreatedAt: String(data.backupCreatedAt), records: Number(data.records), documents: Number(data.documents) });
      else {
        const code = data?.error?.code;
        const detail = data?.error?.message;
        // Restore refusals carry a specific, safe explanation from the server; everything else uses the standard wording.
        setError(code && code.startsWith('backup_') && detail && detail !== code ? detail : code === 'not_found' ? 'This installation has already been set up.' : errorMessage(code ?? 'internal'));
      }
    } catch {
      setError('The upload did not complete. Check the connection and any upload size limit on your reverse proxy, then try again.');
    } finally {
      setBusy(false);
    }
  };
  if (done) {
    return <div role="status">
      <p><strong>Restore complete.</strong> {done.records} records and {done.documents} documents were restored from the backup made {done.backupCreatedAt.slice(0, 16).replace('T', ' ')} UTC, and every checksum matched.</p>
      <p>Email settings, the reverse proxy list and assistant credentials are not part of a backup: set them up again in Server settings. If you use the assistant, run its <code>setup-role</code> command again.</p>
      <p><a className="button" href="/login">Sign in</a></p>
    </div>;
  }
  return <form onSubmit={submit}>
    {error && <p className="error" role="alert">{error}</p>}
    {!documentsConfigured && <p className="muted">Document storage is not configured on this server, so a backup that contains documents will be refused.</p>}
    <label htmlFor="setupToken">Setup token</label>
    <input id="setupToken" name="setupToken" type="password" required maxLength={200} autoComplete="off" spellCheck={false} />
    <p className="muted">The value of <code>TALLYMED_SETUP_TOKEN</code>, or the token the server printed to its console when it started.</p>
    <label htmlFor="file">Backup file (.tar.gz or .tar.gz.enc, up to {maxMb} MB)</label>
    <input id="file" name="file" type="file" required />
    <label htmlFor="passphrase">Passphrase (only if the backup is encrypted)</label>
    <input id="passphrase" name="passphrase" type="password" maxLength={256} autoComplete="off" />
    <button type="submit" disabled={busy}>{busy ? 'Restoring…' : 'Restore backup'}</button>
    {busy && <p role="status" className="muted">Uploading, verifying every checksum and loading the records. This can take several minutes for a large backup. Keep this page open.</p>}
  </form>;
}
