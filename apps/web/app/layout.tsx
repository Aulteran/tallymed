import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'TallyMed · Development shell' };

export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
