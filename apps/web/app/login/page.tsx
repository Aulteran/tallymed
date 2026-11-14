import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { appContext } from '../../server/context.ts';
import { pageSession } from '../../server/http.ts';
import { isBootstrapped } from '../../server/services/bootstrap.ts';
import { AuthShell } from '../components/AuthShell.tsx';
import { errorMessage } from '../components/messages.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Sign in · TallyMed' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = appContext();
  const existing = await pageSession(ctx, await headers());
  if (existing) redirect(existing.actor.mustChangePassword ? '/password/change' : '/');
  const params = await searchParams;
  const ready = await isBootstrapped(ctx.pool);
  const error = errorMessage(params.error);
  return <AuthShell>
    {params.notice === 'account_created' && <p role="status">Account created. Sign in to continue.</p>}
    {params.notice === 'setup_complete' && <p role="status">Administrator created. Sign in to continue.</p>}
    {!ready
      ? <div className="card"><h1>Setup required</h1>
        <p>No administrator exists yet. <a href="/setup">Create the first administrator</a> with the setup token from your server configuration or console output.</p></div>
      : <form className="card" method="post" action="/api/auth/login">
        <h1>Sign in</h1>
        <p>Your household's medical expense ledger.</p>
        {error && <p className="error" role="alert">{error}</p>}
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="username" required maxLength={254} />
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required maxLength={128} />
        <button type="submit">Sign in</button>
        <p className="muted">Forgot your password?</p>
        <a className="button secondary" href="/password/forgot">Reset password</a>
      </form>}
  </AuthShell>;
}
