import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import Link from 'next/link';
import { deployment } from '../lib/deployment.mjs';
import { links, ogImages, siteDescription, tagline } from '../lib/site';
import { Lockup } from './components/Brand';
import './site.css';

// Served from this site (SIL Open Font License, see packages/brand/fonts/OFL.txt). Nothing is fetched from another host.
const montserrat = localFont({ src: './fonts/montserrat-latin-variable.woff2', weight: '500 800', display: 'swap', variable: '--font-montserrat' });

export const metadata: Metadata = {
  metadataBase: new URL(deployment.url + '/'),
  title: { default: 'TallyMed · ' + tagline, template: '%s | TallyMed' },
  description: siteDescription,
  icons: {
    icon: [
      { url: deployment.basePath + '/icon.svg', type: 'image/svg+xml' },
      { url: deployment.basePath + '/favicon.ico', sizes: '32x32' },
    ],
    apple: deployment.basePath + '/apple-touch-icon.png',
  },
  openGraph: {
    type: 'website',
    siteName: 'TallyMed',
    title: 'TallyMed · ' + tagline,
    description: siteDescription,
    images: ogImages,
  },
  twitter: { card: 'summary_large_image', images: ogImages },
};

export const viewport: Viewport = { themeColor: '#0B2942' };

export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" className={montserrat.variable}><body>
    <a className="skip" href="#main">Skip to content</a>
    <header className="site-header">
      <div className="frame bar">
        <Link className="brand" href="/"><Lockup /></Link>
        <nav aria-label="Main"><Link href="/roadmap/">Roadmap</Link><a href={links.docs}>Docs</a><a className="button small" href={links.source}>GitHub</a></nav>
      </div>
    </header>
    <main id="main">{children}</main>
    <footer className="site-footer">
      <div className="frame bar">
        <span>© TallyMed contributors · <a href={links.license}>GNU AGPL v3</a></span>
        <nav aria-label="Footer">
          <a href={links.source}>Source</a>
          <a href={links.docs}>Documentation</a>
          <a href={links.contributing}>Contribute</a>
        </nav>
      </div>
    </footer>
  </body></html>;
}
