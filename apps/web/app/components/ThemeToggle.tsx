'use client';
import { useState } from 'react';
import { Icon } from './icons.tsx';

export type Theme = 'system' | 'light' | 'dark';
const NEXT: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
const LABEL: Record<Theme, string> = { system: 'System', light: 'Light', dark: 'Dark' };
const ICON: Record<Theme, string> = { system: 'auto', light: 'sun', dark: 'moon' };
export const THEME_COOKIE = 'tallymed_theme';

/**
 * Cycles system, light and dark. The choice is a display preference only: it is kept in a first-party cookie that holds one
 * of two fixed words, so the server can render the right theme without an inline script. No account data is involved.
 */
export function ThemeToggle({ initial }: { initial: Theme }) {
  const [theme, setTheme] = useState<Theme>(initial);
  const choose = () => {
    const next = NEXT[theme];
    setTheme(next);
    const root = document.documentElement;
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    if (next === 'system') {
      delete root.dataset.theme;
      document.cookie = `${THEME_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
    } else {
      root.dataset.theme = next;
      document.cookie = `${THEME_COOKIE}=${next}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
    }
  };
  return <button type="button" className="theme-toggle" onClick={choose} aria-label={`Theme: ${LABEL[theme]}. Change theme`}>
    <Icon name={ICON[theme]} /> {LABEL[theme]}
  </button>;
}
