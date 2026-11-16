import { errorMessage } from '../../../components/messages.ts';
import { flat, requireSession, type SearchParams } from '../../../components/ui.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Security PIN · TallyMed' };

export default async function SecurityPinPage({ searchParams }: { searchParams: SearchParams }) {
  const { csrf, actor } = await requireSession();
  const params = await flat(searchParams);
  const error = errorMessage(params.error);
  const left = Number(params.left);
  const has = actor.hasPin;
  return <main id="main">
    <h1>{has ? 'Change PIN' : 'Set a PIN'}</h1>
    <p>{has
      ? 'Your six-digit PIN unlocks TallyMed after it locks. Changing it does not sign you out anywhere.'
      : 'A six-digit PIN lets TallyMed lock itself when you step away, without signing you out. Once it is set, the screen locks after a few minutes without activity and you enter the PIN to continue.'}</p>
    {error && <p className="error" role="alert">{error}{Number.isInteger(left) && left > 0 ? ` ${left} ${left === 1 ? 'attempt' : 'attempts'} left before you are signed out.` : ''}</p>}
    <form className="card" method="post" action="/api/auth/change-pin">
      <input type="hidden" name="csrf" value={csrf} />
      {has && <>
        <label htmlFor="currentPin">Current PIN</label>
        <input id="currentPin" name="currentPin" type="password" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="off" className="pin-input" />
        <p className="muted">Forgot it? Leave this empty and enter your account password instead.</p>
        <label htmlFor="currentPassword">Account password (only if you forgot the PIN)</label>
        <input id="currentPassword" name="currentPassword" type="password" maxLength={128} autoComplete="current-password" />
      </>}
      <label htmlFor="newPin">New PIN (six digits)</label>
      <input id="newPin" name="newPin" type="password" inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} required autoComplete="off" className="pin-input" />
      <label htmlFor="confirmPin">Confirm new PIN</label>
      <input id="confirmPin" name="confirmPin" type="password" inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} required autoComplete="off" className="pin-input" />
      <button type="submit">{has ? 'Change PIN' : 'Set PIN'}</button>
    </form>
  </main>;
}
