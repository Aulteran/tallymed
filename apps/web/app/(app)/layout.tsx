import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { can } from '../../server/authz.ts';
import { appContext } from '../../server/context.ts';
import { pageSession } from '../../server/http.ts';
import { pendingProposalCount } from '../../server/services/assistant.ts';
import { Lockup } from '../components/brand.tsx';
import { ShellNav, type NavGroup } from '../components/ShellNav.tsx';
import { AccountMenu } from '../components/AccountMenu.tsx';
import { readTheme } from '../components/theme.ts';

export const dynamic = 'force-dynamic';

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?';

export default async function ShellLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const session = await pageSession(appContext(), await headers());
  if (!session) redirect('/login');
  if (session.actor.mustChangePassword) redirect('/password/change');
  const { actor, csrf } = session;
  const pending = await pendingProposalCount(appContext().pool, actor);
  const admin: NavGroup['items'] = [
    ...(can(actor, 'operators:manage') ? [{ href: '/users', label: 'Users', icon: 'users' }] : []),
    ...(can(actor, 'settings:manage') ? [{ href: '/settings', label: 'Server settings', icon: 'settings' }] : []),
    ...(can(actor, 'assistant:manage') ? [{ href: '/assistant', label: 'Assistant', icon: 'assistant' }] : []),
  ];
  const groups: NavGroup[] = [
    { items: [{ href: '/', label: 'Overview', icon: 'overview' }] },
    { label: 'Ledger', items: [
      { href: '/visits', label: 'Visits', icon: 'visits' }, { href: '/bills', label: 'Bills', icon: 'bills' },
      { href: '/payments', label: 'Payments', icon: 'payments' }, { href: '/plans', label: 'Payment Plans', icon: 'plans' },
      { href: '/hsa', label: 'HSA', icon: 'hsa' },
    ] },
    { label: 'Records', items: [
      { href: '/documents', label: 'Documents', icon: 'documents' }, { href: '/proposals', label: 'Proposals', icon: 'proposals', count: pending },
    ] },
    { label: 'Household', items: [{ href: '/members', label: 'Family', icon: 'family' }, { href: '/providers', label: 'Providers', icon: 'providers' }] },
    ...(admin.length > 0 ? [{ label: 'Settings', items: admin }] : []),
  ];
  return <>
    <a className="skip" href="#main">Skip to content</a>
    <header className="shell">
      <div className="shell-bar">
        <Link href="/" className="brand"><Lockup onDark title="TallyMed overview" /></Link>
      </div>
      <ShellNav groups={groups}>
        <AccountMenu displayName={actor.displayName} initials={initials(actor.displayName)} csrf={csrf} initialTheme={await readTheme()} />
      </ShellNav>
    </header>
    {children}
  </>;
}
