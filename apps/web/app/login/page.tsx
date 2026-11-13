import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { appContext } from '../../server/context.ts';
import { pageActor } from '../../server/http.ts';
import { isBootstrapped } from '../../server/services/bootstrap.ts';
import { errorMessage } from '../components/messages.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Sign in · TallyMed' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = appContext();
  if (await pageActor(ctx, await headers())) redirect('/');
  const params = await searchParams;
  const ready = await isBootstrapped(ctx.pool);
  const error = errorMessage(params.error);
  return <main>
    <h1>TallyMed</h1>
    {params.notice === 'account_created' && <p role="status">Account created. Sign in to continue.</p>}
    {params.notice === 'setup_complete' && <p role="status">Administrator created. Sign in to continue.</p>}
    {!ready
      ? <div className="card"><h2>Setup required</h2>
        <p>No administrator exists yet. <a href="/setup">Create the first administrator</a> with the setup token from your server configuration or console output.</p></div>
      : <form className="card" method="post" action="/api/auth/login">
        <h2>Sign in</h2>
        {error && <p className="error" role="alert">{error}</p>}
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="username" required maxLength={254} />
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required maxLength={128} />
        <button type="submit">Sign in</button>
      </form>}
  </main>;
}
