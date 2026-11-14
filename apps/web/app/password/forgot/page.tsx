import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { appContext } from '../../../server/context.ts';
import { isEmailConfigured } from '../../../server/email.ts';
import { pageSession } from '../../../server/http.ts';
import { isBootstrapped } from '../../../server/services/bootstrap.ts';
import { refreshRuntimeConfig } from '../../../server/settings.ts';
import { AuthShell } from '../../components/AuthShell.tsx';
import { errorMessage } from '../../components/messages.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Reset password · TallyMed' };

/** Signed-out page. With email set up it asks for an address and always answers the same way; without it, it says to ask an administrator. */
export default async function ForgotPasswordPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = appContext();
  const existing = await pageSession(ctx, await headers());
  if (existing) redirect(existing.actor.mustChangePassword ? '/password/change' : '/account/password');
  if (!(await isBootstrapped(ctx.pool))) redirect('/login');
  await refreshRuntimeConfig(ctx.config, ctx.pool);
  const params = await searchParams;
  const configured = await isEmailConfigured(ctx.pool, ctx.config);
  const error = errorMessage(params.error);
  return <AuthShell>
    {!configured
      ? <div className="card">
        <h1>Reset password</h1>
        <p>This server is not set up to send email, so passwords cannot be reset here. Ask a TallyMed administrator to reset your
          password. They will give you a temporary password, and you will be asked to choose a new one the first time you sign in with it.</p>
        <a className="button secondary" href="/login">Back to sign in</a>
      </div>
      : params.notice === 'sent'
        ? <div className="card">
          <h1>Check your email</h1>
          <p role="status">If that address belongs to an active TallyMed account, a temporary password has been sent to it. It works once and
            expires within the hour. Your current password keeps working until you sign in with the temporary one.</p>
          <p className="muted">Nothing arrived after a few minutes? Check your spam folder, then wait ten minutes before asking again, or ask an administrator.</p>
          <a className="button secondary" href="/login">Back to sign in</a>
        </div>
        : <form className="card" method="post" action="/api/auth/forgot-password">
          <h1>Reset password</h1>
          <p>Enter the email address of your account. If it matches an active account, we email a temporary password to it.</p>
          {error && <p className="error" role="alert">{error}</p>}
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" autoComplete="username" required maxLength={254} />
          <button type="submit">Email me a temporary password</button>
          <p className="muted"><a href="/login">Back to sign in</a></p>
        </form>}
  </AuthShell>;
}
