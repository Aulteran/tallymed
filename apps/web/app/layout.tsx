import type { Metadata } from 'next';
import './globals.css';
import { SourceNotice } from './components/SourceNotice.tsx';

export const metadata: Metadata = { title: 'TallyMed', robots: { index: false, follow: false } };

export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}<SourceNotice /></body></html>;
}
