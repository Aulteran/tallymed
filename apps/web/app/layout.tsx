import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import './globals.css';
import { SourceNotice } from './components/SourceNotice.tsx';
import { readTheme } from './components/theme.ts';

// Bundled with the app (SIL Open Font License, see packages/brand/fonts/OFL.txt). No font is fetched from another host.
const montserrat = localFont({ src: './fonts/montserrat-latin-variable.woff2', weight: '500 800', display: 'swap', variable: '--font-montserrat' });

export const metadata: Metadata = { title: 'TallyMed', robots: { index: false, follow: false } };
export const viewport: Viewport = { themeColor: '#0B2942' };

export default async function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  const theme = await readTheme();
  return <html lang="en" className={montserrat.variable} data-theme={theme === 'system' ? undefined : theme}>
    <body>{children}<SourceNotice /></body>
  </html>;
}
