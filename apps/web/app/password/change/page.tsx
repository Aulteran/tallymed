import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { appContext } from '../../../server/context.ts';
import { pageSession } from '../../../server/http.ts';
import { AuthShell } from '../../components/AuthShell.tsx';
import { errorMessage } from '../../components/messages.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Choose a new password · TallyMed' };

/** The only page an account holding a temporary password can use. Outside the app shell so nothing else is reachable from it. */
export default async function RequiredPasswordChangePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await pageSession(appContext(), await headers());
  if (!session) redirect('/login');
  if (!session.actor.mustChangePassword) redirect('/account/password');
  const error = errorMessage((await searchParams).error);
  return <AuthShell>
    <form className="card" method="post" action="/api/auth/change-password">
      <h1>Choose a new password</h1>
      <p>You signed in with a temporary password. Choose your own password to continue. You have a few minutes to do this, and
        the temporary password cannot be used again.</p>
      {error && <p className="error" role="alert">{error}</p>}
      <input type="hidden" name="csrf" value={session.csrf} />
      <input type="hidden" name="page" value="required" />
      <label htmlFor="newPassword">New password (12 to 128 characters)</label>
      <input id="newPassword" name="newPassword" type="password" required minLength={12} maxLength={128} autoComplete="new-password" />
      <label htmlFor="confirmPassword">Confirm new password</label>
      <input id="confirmPassword" name="confirmPassword" type="password" required minLength={12} maxLength={128} autoComplete="new-password" />
      <button type="submit">Save password and continue</button>
    </form>
    <form method="post" action="/api/auth/logout" className="auth-secondary">
      <input type="hidden" name="csrf" value={session.csrf} />
      <button type="submit" className="secondary">Sign out</button>
    </form>
  </AuthShell>;
}
