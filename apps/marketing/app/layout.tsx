import type { Metadata } from 'next';
import Link from 'next/link';
import { deployment } from '../lib/deployment.mjs';
import './site.css';

export const metadata: Metadata = {
  title: { default: 'TallyMed', template: '%s | TallyMed' },
  description: 'A self-hosted medical expense tracker in development for one household.',
  icons: deployment.basePath + '/ledger.svg',
};

export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>
    <a className="skip" href="#main">Skip to content</a>
    <header className="frame">
      <Link className="brand" href="/">
        {/* A local, unoptimized vector works on a static Pages host. */}
        <img src={deployment.basePath + '/ledger.svg'} alt="" width={36} height={36} /> TallyMed
      </Link>
      <nav aria-label="Main"><Link href="/roadmap/">Roadmap</Link></nav>
    </header>
    <main id="main">{children}</main>
    <footer className="frame">
      <span>GNU AGPL v3</span>
      {deployment.source && <a href={deployment.source}>Source on GitHub</a>}
    </footer>
  </body></html>;
}
