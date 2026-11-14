import type { ReactNode } from 'react';
import { StackedLockup } from './brand.tsx';
import { ThemeToggle } from './ThemeToggle.tsx';
import { readTheme } from './theme.ts';

/** Centred layout for the signed-out pages: sign-in, first-time setup, invitation and not-found. */
export async function AuthShell({ children }: { children: ReactNode }) {
  return <main id="main" className="auth">
    <div className="theme-corner"><ThemeToggle initial={await readTheme()} /></div>
    <div className="auth-brand"><StackedLockup /></div>
    {children}
  </main>;
}
