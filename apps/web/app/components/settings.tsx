import Link from 'next/link';

const TABS = [
  { href: '/settings', label: 'General' },
  { href: '/settings/proxy', label: 'Reverse proxy' },
  { href: '/settings/email', label: 'Email (SMTP)' },
] as const;

export function SettingsTabs({ current }: { current: (typeof TABS)[number]['href'] }) {
  return <nav className="tabs" aria-label="Settings sections">
    {TABS.map((t) => t.href === current
      ? <strong key={t.href} aria-current="page">{t.label}</strong>
      : <Link key={t.href} href={t.href}>{t.label}</Link>)}
  </nav>;
}

const SAVED: Record<string, string> = {
  general: 'General settings saved.', documents: 'Document limits saved.', proxy: 'Reverse proxy settings saved.',
  email: 'Email settings saved. Send a test email to check them.', email_cleared: 'Email settings removed.',
};
export const savedMessage = (code: string | undefined) => (code ? SAVED[code] ?? null : null);

/** Password confirmation field every settings form ends with. */
export function ConfirmPassword({ id }: { id: string }) {
  return <>
    <label htmlFor={id}>Your password</label>
    <input id={id} name="currentPassword" type="password" autoComplete="current-password" required maxLength={256} />
    <p className="muted">Re-enter your own password to confirm this change. It is checked again on the server.</p>
  </>;
}
