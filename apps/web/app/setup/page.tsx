import { notFound } from 'next/navigation';
import { appContext } from '../../server/context.ts';
import { isBootstrapped } from '../../server/services/bootstrap.ts';
import { ensureSetupToken } from '../../server/setup-token.ts';
import { errorMessage } from '../components/messages.ts';
import { flatWithFlash } from '../components/ui.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'First-time setup · TallyMed' };

/** Exists only while no administrator does. Once setup is complete this route is a plain 404. */
export default async function SetupPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = appContext();
  if (await isBootstrapped(ctx.pool)) notFound();
  // Guarantees a token exists (and was printed to the console if the server generated it) before anyone can submit the form.
  ensureSetupToken(ctx.config);
  const params = await searchParams;
  const error = errorMessage(params.error);
  const kept = await flatWithFlash(searchParams, '/setup');
  return <main>
    <h1>Set up TallyMed</h1>
    <form className="card" method="post" action="/api/setup">
      <h2>Create the first administrator</h2>
      <p>Enter the setup token from <code>TALLYMED_SETUP_TOKEN</code>, or the one the server printed to its console when it started.</p>
      {error && <p className="error" role="alert">{error}</p>}
      <label htmlFor="setupToken">Setup token</label>
      <input id="setupToken" name="setupToken" type="password" required maxLength={200} autoComplete="off" spellCheck={false} />
      <label htmlFor="householdName">Household name</label>
      <input id="householdName" name="householdName" required maxLength={120} defaultValue={kept.householdName ?? ''} />
      <label htmlFor="displayName">Your name</label>
      <input id="displayName" name="displayName" required maxLength={80} autoComplete="name" defaultValue={kept.displayName ?? ''} />
      <label htmlFor="email">Email</label>
      <input id="email" name="email" type="email" required maxLength={254} autoComplete="username" defaultValue={kept.email ?? ''} />
      <label htmlFor="password">Password (12 to 128 characters)</label>
      <input id="password" name="password" type="password" required minLength={12} maxLength={128} autoComplete="new-password" />
      <button type="submit">Create administrator</button>
    </form>
  </main>;
}
