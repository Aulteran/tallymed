import { AuthShell } from '../../components/AuthShell.tsx';
import { errorMessage } from '../../components/messages.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Accept invitation · TallyMed', referrer: 'strict-origin' };

export default async function InvitePage({ params, searchParams }: {
  params: Promise<{ token: string }>; searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await params;
  const error = errorMessage((await searchParams).error);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return <AuthShell><div className="card"><h1>Invitation</h1><p className="error">This invitation link is not valid.</p></div></AuthShell>;
  return <AuthShell>
    <form className="card" method="post" action="/api/invitations/accept">
      <h1>Create your TallyMed account</h1>
      {error && <p className="error" role="alert">{error}</p>}
      <input type="hidden" name="token" value={token} />
      <label htmlFor="displayName">Your name</label>
      <input id="displayName" name="displayName" required maxLength={80} autoComplete="name" />
      <label htmlFor="password">Password (12 to 128 characters)</label>
      <input id="password" name="password" type="password" required minLength={12} maxLength={128} autoComplete="new-password" />
      <button type="submit">Create account</button>
    </form>
  </AuthShell>;
}
