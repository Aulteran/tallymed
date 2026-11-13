import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { can } from '../../server/authz.ts';
import { appContext } from '../../server/context.ts';
import { pageActor } from '../../server/http.ts';

export const dynamic = 'force-dynamic';

export default async function ShellLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const session = await pageActor(appContext(), await headers());
  if (!session) redirect('/login');
  const { actor, csrf } = session;
  return <>
    <header className="shell">
      <strong>TallyMed</strong>
      <nav aria-label="Primary">
        <Link href="/">Overview</Link>
        <Link href="/visits">Visits</Link>
        <Link href="/bills">Bills</Link>
        <Link href="/members">Family</Link>
        <Link href="/providers">Providers</Link>
        {can(actor, 'operators:manage') && <Link href="/operators">Operators</Link>}
      </nav>
      <span>{actor.displayName} ({actor.role})</span>
      <form method="post" action="/api/auth/logout">
        <input type="hidden" name="csrf" value={csrf} />
        <button type="submit">Sign out</button>
      </form>
    </header>
    {children}
  </>;
}
