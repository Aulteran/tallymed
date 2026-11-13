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
  const done = roadmap.filter((item) => item.status === 'Complete').length;
  return <>
    <section className="page-head">
      <div className="frame">
        <h1>Development Roadmap</h1>
        <p className="intro">TallyMed is built in the open, one area at a time. {done} of {roadmap.length} planned areas are complete.</p>
      </div>
    </section>
    <section className="frame roadmap">
      <ol className="milestones">{roadmap.map(({ name, status, description }, index) =>
        <li key={name} data-status={status}>
          <span className="step" aria-hidden="true">{index + 1}</span>
          <div><h2>{name}</h2><p>{description}</p></div>
          <p className="badge" data-status={status}>{status}</p>
        </li>
      )}</ol>
    </section>
  </>;
}
