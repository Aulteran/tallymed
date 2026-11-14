import { notFound } from 'next/navigation';
import { can } from '../../../server/authz.ts';
import { MAX_ACCOUNT_FAILURES, MAX_IP_FAILURES, THROTTLE_WINDOW_SECONDS } from '../../../server/services/auth.ts';
import { loadSettingsView } from '../../../server/services/settings.ts';
import { MAX_UPLOADS_PER_MINUTE, MAX_CONCURRENT_UPLOADS } from '../../../server/http.ts';
import { SENDS_PER_HOUR } from '../../../server/email.ts';
import { Banner, Csrf, flatWithFlash, requireSession, type SearchParams } from '../../components/ui.tsx';
import { ConfirmPassword, SettingsTabs, savedMessage } from '../../components/settings.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Server settings · TallyMed' };

const yesNo = (v: boolean) => (v ? 'Set' : 'Not set');

export default async function SettingsPage({ searchParams }: { searchParams: SearchParams }) {
  const { ctx, actor, csrf } = await requireSession();
  if (!can(actor, 'settings:manage')) notFound();
  const q = await flatWithFlash(searchParams, '/settings');
  const v = await loadSettingsView(ctx.pool, ctx.config, actor);
  const g = v.general.value; const d = v.documents.value; const def = v.defaults; const c = ctx.config;
  const saved = savedMessage(q.saved);
  const m = (s: number | null | undefined) => (s ? String(Math.round(s / 60)) : '');
  return <main id="main" className="wide">
    <h1>Server settings</h1>
    <p>Settings an administrator can change without restarting the server. Anything left blank uses the value from the server's environment or the built-in default. Every change is recorded in the audit log.</p>
    <SettingsTabs current="/settings" />
    <Banner code={q.error} />
    {saved && <p role="status" className="card">{saved}</p>}

    <form className="card" method="post" action="/api/settings/general">
      <h2>General</h2><Csrf token={csrf} /><input type="hidden" name="version" value={v.general.version} />
      <label htmlFor="sourceUrl">Corresponding-source link (https)</label>
      <input id="sourceUrl" name="sourceUrl" type="url" maxLength={300} defaultValue={q.sourceUrl ?? g.sourceUrl ?? ''} placeholder={def.sourceUrl ?? 'https://'} />
      <p className="muted">Shown in the footer of every page, as the AGPL requires for a running build.</p>
      <label htmlFor="sessionAbsoluteMinutes">Maximum session length (minutes, at least 5)</label>
      <input id="sessionAbsoluteMinutes" name="sessionAbsoluteMinutes" type="number" min={5} max={43200} defaultValue={q.sessionAbsoluteMinutes ?? m(g.sessionAbsoluteSeconds)} placeholder={m(def.sessionAbsoluteSeconds)} />
      <label htmlFor="sessionIdleMinutes">Sign out after inactivity (minutes)</label>
      <input id="sessionIdleMinutes" name="sessionIdleMinutes" type="number" min={5} max={10080} defaultValue={q.sessionIdleMinutes ?? m(g.sessionIdleSeconds)} placeholder={m(def.sessionIdleSeconds)} />
      <label htmlFor="invitationMinutes">Invitation links expire after (minutes)</label>
      <input id="invitationMinutes" name="invitationMinutes" type="number" min={5} max={20160} defaultValue={q.invitationMinutes ?? m(g.invitationSeconds)} placeholder={m(def.invitationSeconds)} />
      <p className="muted">Current: sessions {m(c.sessionAbsoluteSeconds)} minutes at most, {m(c.sessionIdleSeconds)} minutes idle; invitations {m(c.invitationSeconds)} minutes. Existing sessions keep the length they were issued with; the inactivity limit applies at once.</p>
      <ConfirmPassword id="general-pw" />
      <button type="submit">Save general settings</button>
    </form>

    <form className="card" method="post" action="/api/settings/documents">
      <h2>Documents</h2><Csrf token={csrf} /><input type="hidden" name="version" value={v.documents.version} />
      <label htmlFor="documentMaxMb">Largest file (MB, 1 to 25)</label>
      <input id="documentMaxMb" name="documentMaxMb" type="number" min={1} max={25} defaultValue={q.documentMaxMb ?? d.documentMaxMb ?? ''} placeholder={String(def.documentMaxBytes / 1048576)} />
      <label htmlFor="documentQuotaMb">Storage per household (MB)</label>
      <input id="documentQuotaMb" name="documentQuotaMb" type="number" min={10} max={1048576} defaultValue={q.documentQuotaMb ?? d.documentQuotaMb ?? ''} placeholder={String(def.documentQuotaBytes / 1048576)} />
      <label htmlFor="documentRetentionDays">Keep removed documents for (days, 0 to 3650)</label>
      <input id="documentRetentionDays" name="documentRetentionDays" type="number" min={0} max={3650} defaultValue={q.documentRetentionDays ?? d.documentRetentionDays ?? ''} placeholder={String(def.documentRetentionDays)} />
      <p className="muted">The cleanup command reads the retention value from here as well. The document volume itself is set by the server environment (see below).</p>
      <ConfirmPassword id="documents-pw" />
      <button type="submit">Save document limits</button>
    </form>

    <div className="card">
      <h2>Set by the server environment (read only)</h2>
      <p className="muted">These control how the server starts and what it trusts, so they are not editable here. Change them in the server's environment file and restart. Secret values are never shown.</p>
      <table className="stack"><thead><tr><th>Setting</th><th>Value</th></tr></thead><tbody>
        <tr><td data-label="Setting">Public address (TALLYMED_CANONICAL_ORIGIN)</td><td data-label="Value">{c.canonicalOrigin}</td></tr>
        <tr><td data-label="Setting">Secure cookies</td><td data-label="Value">{c.secureCookies ? 'On (https)' : 'Off (http, loopback development only)'}</td></tr>
        <tr><td data-label="Setting">Database (DATABASE_URL)</td><td data-label="Value">Configured, not shown</td></tr>
        <tr><td data-label="Setting">Proxy shared secret (TALLYMED_PROXY_SECRET)</td><td data-label="Value">{yesNo(c.proxySecret !== null)}</td></tr>
        <tr><td data-label="Setting">Secrets key (TALLYMED_SECRETS_KEY)</td><td data-label="Value">{yesNo(c.secretsKey !== null)}</td></tr>
        <tr><td data-label="Setting">Document volume (TALLYMED_DOCUMENTS_DIR)</td><td data-label="Value">{c.documentsDir ? 'Configured' : 'Not configured: uploads are off'}</td></tr>
        <tr><td data-label="Setting">Assistant (MCP) listener</td><td data-label="Value">Separate service, configured only by its own environment; see Assistant</td></tr>
        <tr><td data-label="Setting">Listener address, port and TLS</td><td data-label="Value">Set by the container and the reverse proxy</td></tr>
      </tbody></table>
    </div>

    <div className="card">
      <h2>Built-in limits (read only)</h2>
      <ul>
        <li>Sign-in: {MAX_ACCOUNT_FAILURES} failures per account and {MAX_IP_FAILURES} per client address in {THROTTLE_WINDOW_SECONDS / 60} minutes. The client address is the real client only when the request comes through a trusted reverse proxy (see Reverse proxy).</li>
        <li>Uploads: {MAX_UPLOADS_PER_MINUTE} attempts per person per minute and {MAX_CONCURRENT_UPLOADS} at once, counted per server process.</li>
        <li>Settings changes: 5 wrong passwords per administrator per 15 minutes; 3 test emails per administrator per 5 minutes; {SENDS_PER_HOUR} emails per hour in total.</li>
      </ul>
    </div>
  </main>;
}
