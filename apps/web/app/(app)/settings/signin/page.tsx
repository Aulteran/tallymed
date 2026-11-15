import { notFound } from 'next/navigation';
import { can } from '../../../../server/authz.ts';
import { DEFAULT_SCOPES, loadSigninView } from '../../../../server/services/signin.ts';
import { AddDialog } from '../../../components/AddDialog.tsx';
import { Banner, Csrf, dateOf, flatWithFlash, requireSession, roleLabel, type SearchParams } from '../../../components/ui.tsx';
import { ConfirmPassword, SettingsTabs, savedMessage } from '../../../components/settings.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Sign-in settings · TallyMed' };

const PROBLEMS: Record<string, string> = {
  disabled: 'Off', incomplete: 'Not complete: an issuer and a client ID are needed',
  secrets_key_missing: 'Not available: the server has no TALLYMED_SECRETS_KEY', secret_unreadable: 'Not available: the saved client secret cannot be read',
};
const TEST_RESULTS: Record<string, string> = {
  incomplete: 'Save an issuer and a client ID first.',
  target_blocked: 'The issuer resolves to an address this server is not allowed to connect to (loopback, link-local or a cloud metadata address).',
  unreachable: 'The provider could not be reached from the TallyMed server. Check the issuer address, DNS and the firewall.',
  bad_response: 'The provider did not answer with a discovery document at /.well-known/openid-configuration under the issuer address.',
  issuer_mismatch: 'The provider describes itself with a different issuer than the one saved here. Copy the issuer exactly as the provider shows it.',
  metadata_invalid: 'The provider\'s discovery document is missing an https endpoint, or it does not support the authorization code flow with PKCE (S256).',
  jwks_invalid: 'The provider\'s signing keys could not be read.',
};
const PROVIDER_NAMES: Record<string, string> = { generic: 'OpenID Connect', google: 'Google', microsoft: 'Microsoft Entra ID' };

export default async function SigninSettingsPage({ searchParams }: { searchParams: SearchParams }) {
  const { ctx, actor, csrf } = await requireSession();
  if (!can(actor, 'settings:manage')) notFound();
  const q = await flatWithFlash(searchParams, '/settings/signin');
  const v = await loadSigninView(ctx.pool, ctx.config, actor);
  const s = v.value;
  const saved = savedMessage(q.saved);
  const provider = q.provider ?? s.provider ?? 'generic';
  // A failed save comes back with `add=1`, so its message shows in the reopened dialog; other errors (unlink, test) stay on the page.
  const editing = q.add === '1';
  const configured = Boolean(s.clientId && s.issuer);
  const providerOn = v.problem === null;
  const passwordKeptOn = s.passwordLoginDisabled && v.passwordLogin;

  return <main id="main" className="wide signin-settings">
    <div className="page-head">
      <h1>Sign-in</h1>
      <AddDialog label={configured ? 'Edit provider' : 'Set up provider'} title="Identity provider" icon={configured ? 'key' : 'plus'} secondary={configured} requiredNote={false} open={editing}>
        {editing && q.error && <Banner code={q.error} />}
        <form method="post" action="/api/settings/signin" className="provider-form">
          <Csrf token={csrf} /><input type="hidden" name="version" value={v.version} />
          <p className="muted">Register this redirect address with the provider: <code>{v.callbackUrl}</code></p>
          <label><input type="checkbox" name="enabled" value="yes" defaultChecked={s.enabled === true} /> Offer sign-in with this provider</label>

          <label htmlFor="provider">Provider type</label>
          <select id="provider" name="provider" defaultValue={provider}>
            <option value="generic">OpenID Connect (any provider)</option>
            <option value="google">Google</option>
            <option value="microsoft">Microsoft Entra ID</option>
          </select>
          <div className="only-generic">
            <label htmlFor="issuer">Issuer URL</label>
            <input id="issuer" name="issuer" inputMode="url" maxLength={300} defaultValue={q.issuer ?? (s.provider === 'generic' || !s.provider ? s.issuer ?? '' : '')} placeholder="https://auth.example.com/application/o/tallymed/" autoComplete="off" />
            <p className="muted">Where the provider publishes <code>/.well-known/openid-configuration</code>.</p>
          </div>
          <div className="only-microsoft">
            <label htmlFor="tenant">Directory (tenant) ID</label>
            <input id="tenant" name="tenant" maxLength={64} defaultValue={q.tenant ?? s.tenant ?? ''} placeholder="00000000-0000-0000-0000-000000000000" autoComplete="off" />
            <p className="muted">A single directory; &quot;common&quot; is not accepted. Entra ID must send the optional claims <code>email</code> and <code>xms_edov</code>.</p>
          </div>

          <label htmlFor="clientId">Client ID</label>
          <input id="clientId" name="clientId" maxLength={200} defaultValue={q.clientId ?? s.clientId ?? ''} autoComplete="off" />
          <label htmlFor="clientSecret">Client secret</label>
          <input id="clientSecret" name="clientSecret" type="password" maxLength={512} autoComplete="new-password" placeholder={v.secretState === 'saved' ? 'Saved. Type to replace it.' : 'Not needed for a public client'} />
          <p className="muted">Stored encrypted. Changing the issuer or client ID removes the saved secret.</p>
          {v.secretState !== 'none' && <label><input type="checkbox" name="clearSecret" value="yes" /> Remove the saved secret</label>}

          <label htmlFor="buttonLabel">Name on the sign-in button</label>
          <input id="buttonLabel" name="buttonLabel" maxLength={40} defaultValue={q.buttonLabel ?? s.buttonLabel ?? ''} placeholder={v.label} />

          <details open={Boolean(q.scopes) || undefined}>
            <summary>Advanced: scopes</summary>
            <label htmlFor="scopes">Scopes</label>
            <input id="scopes" name="scopes" maxLength={200} defaultValue={q.scopes ?? s.scopes ?? DEFAULT_SCOPES} autoComplete="off" />
            <p className="muted">Separated by spaces; must include <code>openid</code> and <code>email</code>.</p>
          </details>

          <details open={s.autoProvision === true || undefined}>
            <summary>New accounts</summary>
            <label><input type="checkbox" name="autoProvision" value="yes" defaultChecked={s.autoProvision === true} /> Create a Standard account for a verified address that has none</label>
            <label htmlFor="allowedDomains">Allowed email domains</label>
            <input id="allowedDomains" name="allowedDomains" maxLength={1000} defaultValue={q.allowedDomains ?? (s.allowedDomains ?? []).join(' ')} placeholder="example.com" autoComplete="off" />
            <p className="muted">Only these domains. Administrators are never created this way.</p>
          </details>

          <h3>Password sign-in</h3>
          <label><input type="checkbox" name="passwordLoginDisabled" value="yes" defaultChecked={s.passwordLoginDisabled === true} /> Turn off signing in with a password</label>
          <p className="muted">{v.youSignedIn
            ? 'Allowed: you have signed in through this provider.'
            : 'Sign in once through the provider yourself first.'} Passwords come back on their own if the provider stops working; if it is down, start the server with <code>TALLYMED_PASSWORD_LOGIN=on</code>.</p>

          <ConfirmPassword id="signin-pw" />
          <button type="submit">Save sign-in settings</button>
        </form>
      </AddDialog>
    </div>
    <p>Let people sign in with an OpenID Connect provider such as Authentik, Keycloak, Google or Microsoft Entra ID.</p>
    <SettingsTabs current="/settings/signin" />

    {!editing && <Banner code={q.error} />}
    {saved && <p role="status" className="card">{saved}</p>}
    {q.tested === 'ok' && <p role="status" className="card">The provider answered: its discovery document names this issuer and its signing keys were read. Sign out and use the provider button to try it.</p>}
    {q.tested && q.tested !== 'ok' && <p role="alert" className="error">Connection test failed: {TEST_RESULTS[q.tested] ?? PROBLEMS[q.tested] ?? 'the provider could not be checked.'}</p>}
    {!v.secretsKeyAvailable && <p role="note" className="card">Provider sign-in needs <code>TALLYMED_SECRETS_KEY</code> in the server environment (<code>openssl rand -base64 32</code>), then a restart.</p>}
    {v.secretState === 'unreadable' && v.secretsKeyAvailable && <p role="alert" className="error">The saved client secret cannot be read with the current <code>TALLYMED_SECRETS_KEY</code>. Enter it again and save.</p>}
    {v.allowInsecure && <p role="alert" className="error"><code>TALLYMED_OIDC_ALLOW_INSECURE_ISSUER</code> is set, so providers without TLS are accepted. Use it only with a local test provider.</p>}

    <section className="card" aria-labelledby="signin-status">
      <h2 id="signin-status">Status</h2>
      <ul className="status-list">
        <li><span>Provider sign-in:</span> {providerOn ? <span className="pill">On</span> : <span className="pill neutral">{PROBLEMS[v.problem!]}</span>}</li>
        <li><span>Password sign-in:</span> {v.passwordLogin ? <span className="pill">On</span> : <span className="pill neutral">Off</span>}
          {passwordKeptOn && <span className="muted"> kept on because {v.forcePasswordLogin ? 'TALLYMED_PASSWORD_LOGIN=on is set' : 'provider sign-in is not usable or no active administrator is linked to it'}</span>}</li>
        {configured && <li><span>Provider:</span> {s.buttonLabel || v.label} <span className="muted">· {PROVIDER_NAMES[s.provider ?? 'generic']} · client <code>{s.clientId}</code> · secret {v.secretState === 'none' ? 'none' : v.secretState === 'saved' ? 'saved' : 'unreadable'}</span></li>}
        <li><span>Redirect address:</span> <code>{v.callbackUrl}</code></li>
      </ul>
      {configured
        ? <form method="post" action="/api/settings/signin/test" className="status-actions">
          <Csrf token={csrf} />
          <button type="submit" className="secondary">Test connection</button>
          <span className="muted">Reads the discovery document and signing keys. Changes nothing.</span>
        </form>
        : <p className="muted">No provider yet. Use <strong>Set up provider</strong> to add one; password sign-in keeps working.</p>}
    </section>

    <section className="card" aria-labelledby="signin-linked">
      <h2 id="signin-linked">Linked accounts</h2>
      <p className="muted">People are matched to the account with the same <strong>verified</strong> email address, so use only a provider that checks people own their address.</p>
      {v.identities.length === 0 ? <p className="muted">Nobody has signed in through a provider yet.</p> : <table className="stack"><thead><tr><th>Account</th><th>Role</th><th>Linked</th><th>Last provider sign-in</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>
        {v.identities.map((i) => <tr key={i.id}>
          <td data-label="Account">{i.displayName}<br /><span className="muted">{i.email}{i.status === 'disabled' ? ' (disabled)' : ''}</span></td>
          <td data-label="Role">{roleLabel(i.role)}</td>
          <td data-label="Linked">{dateOf(i.createdAt)}<br /><span className="muted">{i.createdVia === 'provisioned' ? 'account created at first sign-in' : 'matched by verified email'}{i.current ? '' : ', earlier provider'}</span></td>
          <td data-label="Last provider sign-in">{i.lastLoginAt ? dateOf(i.lastLoginAt) : 'Never'}</td>
          <td data-label="Actions"><details className="unlink">
            <summary>Remove link</summary>
            <form method="post" action="/api/settings/signin/unlink" className="row-form">
              <Csrf token={csrf} /><input type="hidden" name="identityId" value={i.id} />
              <label htmlFor={`unlink-${i.id}`}>Your password, to remove the link of {i.displayName}</label>
              <input id={`unlink-${i.id}`} name="currentPassword" type="password" autoComplete="current-password" required maxLength={256} />
              <button type="submit" className="secondary">Remove</button>
            </form>
            <p className="muted">Signs them out; the account stays active.</p>
          </details></td>
        </tr>)}
      </tbody></table>}
    </section>
  </main>;
}
