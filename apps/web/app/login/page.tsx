import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { appContext } from '../../server/context.ts';
import { pageSession } from '../../server/http.ts';
import { isBootstrapped } from '../../server/services/bootstrap.ts';
import { signinState } from '../../server/services/signin.ts';
import { AuthShell } from '../components/AuthShell.tsx';
import { errorMessage } from '../components/messages.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Sign in · TallyMed' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = appContext();
  const existing = await pageSession(ctx, await headers());
  if (existing) redirect(existing.actor.mustChangePassword ? '/password/change' : existing.actor.locked ? '/locked' : '/');
  const params = await searchParams;
  const ready = await isBootstrapped(ctx.pool);
  const error = errorMessage(params.error);
  const signin = ready ? await signinState(ctx.pool, ctx.config) : { oidcLabel: null, passwordLogin: true };
  return <AuthShell>
    {params.notice === 'account_created' && <p role="status">Account created. Sign in to continue.</p>}
    {params.notice === 'setup_complete' && <p role="status">Administrator created. Sign in to continue.</p>}
    {!ready
      ? <div className="card"><h1>Setup required</h1>
        <p>No administrator exists yet. <a href="/setup">Create the first administrator</a> with the setup token from your server configuration or console output.</p></div>
      : <div className="card">
        <h1>Sign in</h1>
        <p>Your household's medical expense ledger.</p>
        {error && <p className="error" role="alert">{error}</p>}
        {/* A plain link: the server sets the flow cookie and redirects to the provider. Not prefetched, so no flow starts by itself. */}
        {signin.oidcLabel && <p><a className="button" href="/api/auth/oidc/start" rel="nofollow">Sign in with {signin.oidcLabel}</a></p>}
        {signin.passwordLogin
          ? <form method="post" action="/api/auth/login">
            {signin.oidcLabel && <p className="muted">Or use your TallyMed password.</p>}
            <label htmlFor="email">Email</label>
            <input id="email" name="email" type="email" autoComplete="username" required maxLength={254} />
            <label htmlFor="password">Password</label>
            <input id="password" name="password" type="password" autoComplete="current-password" required maxLength={128} />
            <label><input type="checkbox" name="remember" value="on" /> Keep me signed in</label>
            <p className="muted">Stays signed in on this browser for up to {Math.round(ctx.config.rememberSessionAbsoluteSeconds / 86400)} days. Do not use it on a shared computer. If you have set a PIN, the screen still locks when you step away.</p>
            <button type="submit" className={signin.oidcLabel ? 'secondary' : undefined}>Sign in</button>
            <p className="muted">Forgot your password?</p>
            <a className="button secondary" href="/password/forgot">Reset password</a>
          </form>
          : <p className="muted">Password sign-in is turned off on this server.</p>}
      </div>}
  </AuthShell>;
}
