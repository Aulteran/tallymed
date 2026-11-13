import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import { deployment } from '../lib/deployment.mjs';
import { links, ogImages, siteDescription, tagline } from '../lib/site';
import './site.css';

export const metadata: Metadata = {
  metadataBase: new URL(deployment.url + '/'),
  title: { default: 'TallyMed · ' + tagline, template: '%s | TallyMed' },
  description: siteDescription,
  icons: deployment.basePath + '/ledger.svg',
  openGraph: {
    type: 'website',
    siteName: 'TallyMed',
    title: 'TallyMed · ' + tagline,
    description: siteDescription,
    images: ogImages,
  },
  twitter: { card: 'summary_large_image', images: ogImages },
};

export const viewport: Viewport = { themeColor: '#102432' };

export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>
    <a className="skip" href="#main">Skip to content</a>
    <header className="frame">
      <Link className="brand" href="/">
        {/* A local, unoptimized vector works on a static Pages host. */}
        <img src={deployment.basePath + '/ledger.svg'} alt="" width={36} height={36} /> TallyMed
      </Link>
      <nav aria-label="Main"><Link href="/roadmap/">Roadmap</Link> <a href={links.source}>GitHub</a></nav>
    </header>
    <main id="main">{children}</main>
    <footer className="frame">
      <span>© TallyMed contributors · <a href={links.license}>GNU AGPL v3</a></span>
      <nav aria-label="Footer">
        <a href={links.source}>Source</a>
        <a href={links.docs}>Documentation</a>
        <a href={links.contributing}>Contribute</a>
      </nav>
    </footer>
  </body></html>;
}
