import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { appContext } from '../../server/context.ts';
import { pageSession } from '../../server/http.ts';
import { safeReturnPath } from '../../server/validation.ts';
import { AuthShell } from '../components/AuthShell.tsx';
import { errorMessage } from '../components/messages.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Locked · TallyMed' };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * The PIN screen for a locked session. It sits outside the app shell and renders no household data, so a locked session reads nothing.
 * A plain form post: it works without scripts, and unlocking returns to the page the person was on. Wrong PINs are counted on the server.
 */
export default async function LockedPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await pageSession(appContext(), await headers());
  if (!session) redirect('/login');
  const params = await searchParams;
  const next = safeReturnPath(first(params.next));
  if (session.actor.mustChangePassword) redirect('/password/change');
  if (!session.actor.locked) redirect(next);
  const error = errorMessage(first(params.error));
  const left = Number(first(params.left));
  return <AuthShell>
    <form className="card" method="post" action="/api/auth/unlock">
      <h1>Locked</h1>
      <p>You are still signed in as {session.actor.displayName}. Enter your six-digit PIN to continue.</p>
      {error && <p className="error" role="alert">{error}{Number.isInteger(left) && left > 0 ? ` ${left} ${left === 1 ? 'attempt' : 'attempts'} left before you are signed out.` : ''}</p>}
      <input type="hidden" name="csrf" value={session.csrf} />
      <input type="hidden" name="next" value={next} />
      <label htmlFor="pin">PIN</label>
      <input id="pin" name="pin" type="password" inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} required
        autoComplete="off" autoFocus className="pin-input" />
      <button type="submit">Unlock</button>
    </form>
    <form method="post" action="/api/auth/logout" className="auth-secondary">
      <input type="hidden" name="csrf" value={session.csrf} />
      <button type="submit" className="secondary">Sign out instead</button>
    </form>
  </AuthShell>;
}
