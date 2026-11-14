import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '../../../../../server/authz.ts';
import { AppError } from '../../../../../server/errors.ts';
import { getOperatorForReset } from '../../../../../server/services/operators.ts';
import { errorMessage } from '../../../../components/messages.ts';
import { flat, requireSession, type SearchParams } from '../../../../components/ui.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Reset password · TallyMed' };

export default async function ResetPasswordPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { id } = await params;
  const { ctx, actor, csrf } = await requireSession();
  if (!can(actor, 'operators:manage') || !/^[0-9a-f-]{36}$/.test(id)) notFound();
  let target;
  try {
    target = await getOperatorForReset(ctx.pool, actor, id);
  } catch (error) {
    if (error instanceof AppError && error.code === 'not_found') notFound();
    throw error;
  }
  const error = errorMessage((await flat(searchParams)).error);
  const self = target.id === actor.userId;
  return <main id="main">
    <h1>Reset password for {target.displayName}</h1>
    <p>{target.email}</p>
    {error && <p className="error" role="alert">{error}</p>}
    {self ? <p role="note">This is your own account, so it cannot be reset here. To set a new password, use <Link href="/account/password">Change password</Link> in the user menu.</p>
      : target.status !== 'active' ? <p role="note">This account is disabled. Enable it before resetting its password.</p>
        : <form className="card" method="post" action="/api/operators/reset-password">
          <h2>What happens</h2>
          <ul>
            <li>A one-time temporary password is created and shown to you once. TallyMed does not keep it.</li>
            <li>{target.displayName}'s current password stops working immediately and they are signed out everywhere.</li>
            <li>The temporary password works once and expires after a few hours. They must choose a new password before they can do anything else.</li>
          </ul>
          <input type="hidden" name="csrf" value={csrf} />
          <input type="hidden" name="userId" value={target.id} />
          <input type="hidden" name="version" value={target.version} />
          <button type="submit">Create temporary password</button>
        </form>}
  </main>;
}
