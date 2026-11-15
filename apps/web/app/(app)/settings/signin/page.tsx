import { notFound } from 'next/navigation';
import { can } from '../../../../server/authz.ts';
import { DEFAULT_SCOPES, loadSigninView } from '../../../../server/services/signin.ts';
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

export default async function SigninSettingsPage({ searchParams }: { searchParams: SearchParams }) {
  const { ctx, actor, csrf } = await requireSession();
  if (!can(actor, 'settings:manage')) notFound();
  const q = await flatWithFlash(searchParams, '/settings/signin');
  const v = await loadSigninView(ctx.pool, ctx.config, actor);
  const s = v.value;
  const saved = savedMessage(q.saved);
  const provider = q.provider ?? s.provider ?? 'generic';
  return <main id="main" className="wide">
    <h1>Sign-in</h1>
    <p>Optional. Let people sign in with an identity provider that supports OpenID Connect, such as Authentik, Keycloak, Google or Microsoft Entra ID. Signing in with a password keeps working unless you turn it off below.</p>
    <SettingsTabs current="/settings/signin" />
    <Banner code={q.error} />
    {saved && <p role="status" className="card">{saved}</p>}
    {q.tested === 'ok' && <p role="status" className="card">The provider answered: its discovery document names this issuer and its signing keys were read. Sign out and use the provider button to try a sign-in.</p>}
    {q.tested && q.tested !== 'ok' && <p role="alert" className="error">Connection test failed: {TEST_RESULTS[q.tested] ?? PROBLEMS[q.tested] ?? 'the provider could not be checked.'}</p>}
    {!v.secretsKeyAvailable && <p role="note" className="card">The server has no <code>TALLYMED_SECRETS_KEY</code>, so provider sign-in cannot be turned on. Set the key (<code>openssl rand -base64 32</code>) in the server environment and restart.</p>}
    {v.secretState === 'unreadable' && v.secretsKeyAvailable && <p role="alert" className="error">The saved client secret cannot be read with the current <code>TALLYMED_SECRETS_KEY</code>. Enter it again and save.</p>}
    {v.allowInsecure && <p role="alert" className="error">This server was started with <code>TALLYMED_OIDC_ALLOW_INSECURE_ISSUER</code>, which accepts providers without TLS. Use that only with a local test provider.</p>}

    <div className="card">
      <h2>Status</h2>
      <p>Provider sign-in: {v.problem === null ? <span className="pill">On</span> : <span className="pill neutral">{PROBLEMS[v.problem]}</span>}</p>
      <p>Password sign-in: {v.passwordLogin ? <span className="pill">On</span> : <span className="pill neutral">Off</span>}
        {s.passwordLoginDisabled && v.passwordLogin && <span className="muted"> (switched off in the settings, but kept on because {v.forcePasswordLogin ? 'the server was started with TALLYMED_PASSWORD_LOGIN=on' : 'provider sign-in is not usable or no active administrator has signed in through it'})</span>}</p>
      <h3>Redirect address to register with the provider</h3>
      <p><code>{v.callbackUrl}</code></p>
      <p className="muted">Also called the callback URL or redirect URI. It is built from this server's public address (<code>TALLYMED_CANONICAL_ORIGIN</code>), which is the address people use behind your reverse proxy, never from request headers. Register it exactly as shown.</p>
    </div>

    <form className="card" method="post" action="/api/settings/signin">
      <h2>Provider</h2><Csrf token={csrf} /><input type="hidden" name="version" value={v.version} />
      <label><input type="checkbox" name="enabled" value="yes" defaultChecked={s.enabled === true} /> Offer sign-in with this provider</label>
      <label htmlFor="provider">Provider type</label>
      <select id="provider" name="provider" defaultValue={provider}>
        <option value="generic">OpenID Connect (any provider)</option>
        <option value="google">Google</option>
        <option value="microsoft">Microsoft Entra ID</option>
      </select>
      <label htmlFor="issuer">Issuer URL (OpenID Connect only)</label>
      <input id="issuer" name="issuer" type="url" maxLength={300} defaultValue={q.issuer ?? (s.provider === 'generic' || !s.provider ? s.issuer ?? '' : '')} placeholder="https://auth.example.com/application/o/tallymed/" autoComplete="off" />
      <p className="muted">The address under which the provider publishes <code>/.well-known/openid-configuration</code>. For Google the issuer is fixed (<code>https://accounts.google.com</code>) and this field is ignored.</p>
      <label htmlFor="tenant">Directory (tenant) ID (Microsoft only)</label>
      <input id="tenant" name="tenant" maxLength={64} defaultValue={q.tenant ?? s.tenant ?? ''} placeholder="00000000-0000-0000-0000-000000000000" autoComplete="off" />
      <p className="muted">One directory only. The shared "common" endpoint is not accepted, because it would let any Microsoft directory vouch for an address. Entra ID must also be set to send the optional claims <code>email</code> and <code>xms_edov</code>; see the documentation.</p>
      <label htmlFor="clientId">Client ID</label>
      <input id="clientId" name="clientId" maxLength={200} defaultValue={q.clientId ?? s.clientId ?? ''} autoComplete="off" />
      <label htmlFor="clientSecret">Client secret</label>
      <input id="clientSecret" name="clientSecret" type="password" maxLength={512} autoComplete="new-password" placeholder={v.secretState === 'saved' ? 'A secret is saved. Type to replace it.' : ''} />
      <p className="muted">Stored encrypted and never shown again. Leave empty to keep the saved secret. A public client that uses PKCE only needs none.</p>
      {v.secretState !== 'none' && <label><input type="checkbox" name="clearSecret" value="yes" /> Remove the saved secret</label>}
      <label htmlFor="scopes">Scopes</label>
      <input id="scopes" name="scopes" maxLength={200} defaultValue={q.scopes ?? s.scopes ?? DEFAULT_SCOPES} autoComplete="off" />
      <p className="muted">Separated by spaces. <code>openid</code> is required, and <code>email</code> is needed to match people to their accounts.</p>
      <label htmlFor="buttonLabel">Name on the sign-in button</label>
      <input id="buttonLabel" name="buttonLabel" maxLength={40} defaultValue={q.buttonLabel ?? s.buttonLabel ?? ''} placeholder={v.label} />

      <h3>Who can sign in</h3>
      <p>Someone who signs in through the provider is matched to the TallyMed account with the same email address, but only when the provider states that the address is verified. After the first sign-in the account stays linked to that provider identity. Invite people on the Users page as before.</p>
      <label><input type="checkbox" name="autoProvision" value="yes" defaultChecked={s.autoProvision === true} /> Create a Standard account for a verified address that has no account yet</label>
      <label htmlFor="allowedDomains">Email domains that may get a new account</label>
      <input id="allowedDomains" name="allowedDomains" maxLength={1000} defaultValue={q.allowedDomains ?? (s.allowedDomains ?? []).join(' ')} placeholder="example.com" autoComplete="off" />
      <p className="muted">Off unless ticked, and only for the domains listed. New accounts are always Standard: an administrator is never created this way.</p>

      <h3>Password sign-in</h3>
      <label><input type="checkbox" name="passwordLoginDisabled" value="yes" defaultChecked={s.passwordLoginDisabled === true} /> Turn off signing in with a password</label>
      <p className="muted">{v.youSignedIn
        ? 'You have signed in through this provider, so you can turn passwords off.'
        : 'Not available yet: save the provider settings, sign out, and sign in once through the provider yourself. Changing the issuer, client ID or secret needs that again.'} Passwords come back by themselves if provider sign-in is switched off or stops being usable, or when no active administrator is linked to it. If the provider itself is down, start the server once with <code>TALLYMED_PASSWORD_LOGIN=on</code>.</p>
      <ConfirmPassword id="signin-pw" />
      <button type="submit">Save sign-in settings</button>
    </form>

    <form className="card" method="post" action="/api/settings/signin/test">
      <h2>Test the connection</h2><Csrf token={csrf} />
      <p>Reads the provider's discovery document and signing keys with the saved settings. It does not sign anyone in and changes nothing.</p>
      <button type="submit" className="secondary">Test connection</button>
    </form>

    <div className="card">
      <h2>Linked accounts</h2>
      {v.identities.length === 0 ? <p className="muted">Nobody has signed in through a provider yet.</p> : <table className="stack"><thead><tr><th>Account</th><th>Role</th><th>Linked</th><th>Last provider sign-in</th><th>Remove</th></tr></thead><tbody>
        {v.identities.map((i) => <tr key={i.id}>
          <td data-label="Account">{i.displayName}<br /><span className="muted">{i.email}{i.status === 'disabled' ? ' (disabled)' : ''}</span></td>
          <td data-label="Role">{roleLabel(i.role)}</td>
          <td data-label="Linked">{dateOf(i.createdAt)}<br /><span className="muted">{i.createdVia === 'provisioned' ? 'account created at first sign-in' : 'matched by verified email'}{i.current ? '' : ', earlier provider'}</span></td>
          <td data-label="Last provider sign-in">{i.lastLoginAt ? dateOf(i.lastLoginAt) : 'Never'}</td>
          <td data-label="Remove"><form method="post" action="/api/settings/signin/unlink" className="row-form">
            <Csrf token={csrf} /><input type="hidden" name="identityId" value={i.id} />
            <label htmlFor={`unlink-${i.id}`} className="sr-only">Your password, to remove the link of {i.displayName}</label>
            <input id={`unlink-${i.id}`} name="currentPassword" type="password" autoComplete="current-password" required maxLength={256} placeholder="Your password" />
            <button type="submit" className="secondary">Remove link</button>
          </form></td>
        </tr>)}
      </tbody></table>}
      <p className="muted">Removing a link does not sign the person out or disable the account. The next provider sign-in with the same verified address links it again; disable the account on the Users page to stop that.</p>
    </div>
  </main>;
}
