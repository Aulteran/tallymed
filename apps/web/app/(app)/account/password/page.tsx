import { errorMessage } from '../../../components/messages.ts';
import { flat, requireSession, type SearchParams } from '../../../components/ui.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Change password · TallyMed' };

export default async function ChangePasswordPage({ searchParams }: { searchParams: SearchParams }) {
  const { csrf } = await requireSession();
  const error = errorMessage((await flat(searchParams)).error);
  return <main id="main">
    <h1>Change password</h1>
    <p>Choose a new password for your own account. Changing it signs you out of every other device.</p>
    {error && <p className="error" role="alert">{error}</p>}
    <form className="card" method="post" action="/api/auth/change-password">
      <input type="hidden" name="csrf" value={csrf} />
      <input type="hidden" name="page" value="account" />
      <label htmlFor="currentPassword">Current password</label>
      <input id="currentPassword" name="currentPassword" type="password" required maxLength={128} autoComplete="current-password" />
      <label htmlFor="newPassword">New password (12 to 128 characters)</label>
      <input id="newPassword" name="newPassword" type="password" required minLength={12} maxLength={128} autoComplete="new-password" />
      <label htmlFor="confirmPassword">Confirm new password</label>
      <input id="confirmPassword" name="confirmPassword" type="password" required minLength={12} maxLength={128} autoComplete="new-password" />
      <button type="submit">Change password</button>
    </form>
  </main>;
}
