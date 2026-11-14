'use client';
import { useEffect, useState } from 'react';
import { Icon } from './icons.tsx';

export type Theme = 'system' | 'light' | 'dark';
export const THEMES: Theme[] = ['system', 'light', 'dark'];
const NEXT: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
export const THEME_LABEL: Record<Theme, string> = { system: 'System', light: 'Light', dark: 'Dark' };
export const THEME_ICON: Record<Theme, string> = { system: 'auto', light: 'sun', dark: 'moon' };
export const THEME_COOKIE = 'tallymed_theme';
const THEME_EVENT = 'tallymed:theme';

/**
 * The theme choice is a display preference only: it is kept in a first-party cookie that holds one of two fixed words, so the
 * server can render the right theme without an inline script. No account data is involved. Every control on the page that
 * shows the theme stays in step through a window event.
 */
export function useTheme(initial: Theme): [Theme, (next: Theme) => void] {
  const [theme, setState] = useState<Theme>(initial);
  useEffect(() => {
    const on = (e: Event) => setState((e as CustomEvent<Theme>).detail);
    window.addEventListener(THEME_EVENT, on);
    return () => window.removeEventListener(THEME_EVENT, on);
  }, []);
  const setTheme = (next: Theme) => {
    const root = document.documentElement;
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    if (next === 'system') {
      delete root.dataset.theme;
      document.cookie = `${THEME_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
    } else {
      root.dataset.theme = next;
      document.cookie = `${THEME_COOKIE}=${next}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
    }
    window.dispatchEvent(new CustomEvent<Theme>(THEME_EVENT, { detail: next }));
  };
  return [theme, setTheme];
}

/** Icon button that cycles system, light and dark. The icon shows the current choice; the name is in the label and tooltip. */
export function ThemeToggle({ initial }: { initial: Theme }) {
  const [theme, setTheme] = useTheme(initial);
  const name = `Theme: ${THEME_LABEL[theme]}. Change theme`;
  return <button type="button" className="theme-toggle icon-button" onClick={() => setTheme(NEXT[theme])} aria-label={name} title={name}>
    <Icon name={THEME_ICON[theme]} />
  </button>;
}
