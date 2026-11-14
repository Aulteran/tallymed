import { notFound } from 'next/navigation';
import { can } from '../../../../server/authz.ts';
import { FAILURE_TEXT, type EmailFailure } from '../../../../server/email.ts';
import { loadSettingsView } from '../../../../server/services/settings.ts';
import { SMTP_PORTS } from '../../../../server/settings.ts';
import { Banner, Csrf, flatWithFlash, requireSession, type SearchParams } from '../../../components/ui.tsx';
import { ConfirmPassword, SettingsTabs, savedMessage } from '../../../components/settings.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Email settings · TallyMed' };

export default async function EmailSettingsPage({ searchParams }: { searchParams: SearchParams }) {
  const { ctx, actor, csrf } = await requireSession();
  if (!can(actor, 'settings:manage')) notFound();
  const q = await flatWithFlash(searchParams, '/settings/email');
  const v = await loadSettingsView(ctx.pool, ctx.config, actor);
  const e = v.email.value;
  const saved = savedMessage(q.saved);
  const tested = q.tested === 'sent' ? 'ok' : q.tested && q.tested in FAILURE_TEXT ? FAILURE_TEXT[q.tested as EmailFailure] : null;
  return <main id="main" className="wide">
    <h1>Email (SMTP)</h1>
    <p>Optional. TallyMed uses email only for features that need it, such as sending a temporary password. Without email everything else works, and an administrator can hand over a temporary password directly.</p>
    <SettingsTabs current="/settings/email" />
    <Banner code={q.error} />
    {saved && <p role="status" className="card">{saved}</p>}
    {q.tested === 'sent' && <p role="status" className="card">Test email sent to your address ({actor.displayName}). Check your inbox.</p>}
    {tested && tested !== 'ok' && <p role="alert" className="error">Test email failed: {tested}</p>}
    {!v.secretsKeyAvailable && <p role="note" className="card">The server has no <code>TALLYMED_SECRETS_KEY</code>, so a relay password cannot be stored. Relays that need no login still work. Set the key (<code>openssl rand -base64 32</code>) in the server environment and restart to store a password.</p>}
    {v.passwordState === 'unreadable' && <p role="alert" className="error">The saved SMTP password cannot be read with the current TALLYMED_SECRETS_KEY. Enter it again and save.</p>}

    <form className="card" method="post" action="/api/settings/email">
      <h2>Mail server</h2><Csrf token={csrf} /><input type="hidden" name="version" value={v.email.version} />
      <p className="muted">Status: {v.emailConfigured ? <span className="pill">Configured</span> : <span className="pill neutral">Not configured</span>}</p>
      <label htmlFor="host">Host</label>
      <input id="host" name="host" required maxLength={253} defaultValue={q.host ?? e.host ?? ''} placeholder="smtp.example.com" autoComplete="off" />
      <label htmlFor="port">Port</label>
      <select id="port" name="port" defaultValue={q.port ?? String(e.port ?? 587)}>{SMTP_PORTS.map((p) => <option key={p} value={p}>{p}</option>)}</select>
      <label htmlFor="security">Connection security</label>
      <select id="security" name="security" defaultValue={q.security ?? e.security ?? 'starttls'}>
        <option value="starttls">STARTTLS (usually port 587)</option>
        <option value="tls">TLS from the start (usually port 465)</option>
        <option value="none">None (only for a relay without a login)</option>
      </select>
      <label htmlFor="username">Username (leave empty if the relay needs none)</label>
      <input id="username" name="username" maxLength={254} defaultValue={q.username ?? e.username ?? ''} autoComplete="off" />
      <label htmlFor="password">Password</label>
      <input id="password" name="password" type="password" maxLength={256} autoComplete="new-password" placeholder={v.passwordState === 'saved' ? 'A password is saved. Type to replace it.' : ''} />
      <p className="muted">Stored encrypted and never shown again. Leave empty to keep the saved password.</p>
      {v.passwordState !== 'none' && <label><input type="checkbox" name="clearPassword" value="yes" /> Remove the saved password</label>}
      <label htmlFor="fromAddress">From address</label>
      <input id="fromAddress" name="fromAddress" type="email" required maxLength={254} defaultValue={q.fromAddress ?? e.fromAddress ?? ''} placeholder="tallymed@example.com" />
      <label htmlFor="fromName">From name</label>
      <input id="fromName" name="fromName" maxLength={80} defaultValue={q.fromName ?? e.fromName ?? ''} placeholder="TallyMed" />
      <label><input type="checkbox" name="allowRestrictedTargets" value="yes" defaultChecked={e.allowRestrictedTargets === true} /> Allow loopback and link-local addresses <span className="muted">(only if the relay really runs on this machine; cloud metadata addresses are always blocked)</span></label>
      <ConfirmPassword id="email-pw" />
      <button type="submit">Save email settings</button>
    </form>

    {v.emailConfigured && <>
      <form className="card" method="post" action="/api/settings/email/test">
        <h2>Send a test email</h2><Csrf token={csrf} />
        <p>Sends one message to your own address, <strong>{actor.displayName}</strong>'s sign-in email, and reports the result. At most three tests every five minutes.</p>
        <button type="submit" className="secondary">Send test email</button>
      </form>
      <form className="card" method="post" action="/api/settings/email/clear">
        <h2>Remove email settings</h2><Csrf token={csrf} /><input type="hidden" name="version" value={v.email.version} />
        <p>Deletes the saved server, login and password. Features that send email will report that email is not set up.</p>
        <ConfirmPassword id="email-clear-pw" />
        <button type="submit" className="secondary">Remove email settings</button>
      </form>
    </>}
  </main>;
}
