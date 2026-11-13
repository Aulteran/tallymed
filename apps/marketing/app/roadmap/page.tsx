import type { Metadata } from 'next';
import roadmap from '../../lib/roadmap.json';
import { absoluteUrl, ogImages } from '../../lib/site';

export const metadata: Metadata = {
  title: 'Development Roadmap',
  description: 'Follow the planned development of TallyMed.',
  alternates: { canonical: absoluteUrl('/roadmap/') },
  openGraph: { url: absoluteUrl('/roadmap/'), images: ogImages },
};

export default function Roadmap() {
  return <section className="frame roadmap">
    <h1>Development Roadmap</h1>
    <ul className="milestones">{roadmap.map(({ name, status, description }) =>
      <li key={name}><p className="status">{status}</p><h2>{name}</h2><p>{description}</p></li>
    )}</ul>
  </section>;
}
