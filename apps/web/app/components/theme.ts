import { cookies } from 'next/headers';
import type { Theme } from './ThemeToggle.tsx';

/** The pinned theme from the display-preference cookie. Anything other than the two fixed words means "follow the system". */
export async function readTheme(): Promise<Theme> {
  const value = (await cookies()).get('tallymed_theme')?.value;
  return value === 'light' || value === 'dark' ? value : 'system';
}
