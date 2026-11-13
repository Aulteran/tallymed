import type { Metadata } from 'next';
import Link from 'next/link';
import roadmap from '../lib/roadmap.json';
import { absoluteUrl, links, ogImages, siteDescription } from '../lib/site';
import { faq, features, steps } from './components/Content';
import Preview from './components/Preview';

export const metadata: Metadata = {
  alternates: { canonical: absoluteUrl('/') },
  openGraph: { url: absoluteUrl('/'), images: ogImages },
};

export default function Home() {
  const active = roadmap.filter((item) => item.status === 'In development');
  const done = roadmap.filter((item) => item.status === 'Complete').length;
  return <>
    <section className="hero" aria-labelledby="hero-title">
      <div className="frame">
        <p className="status">Open source · In development</p>
        <h1 id="hero-title">Medical expenses,<br /> accounted for.</h1>
        <p className="intro">{siteDescription}</p>
        <div className="actions">
          <a className="button" href={links.source}>View on GitHub</a>
          <a className="textlink" href={links.features}>Explore planned features</a>
        </div>
      </div>
    </section>

    <section className="frame section" aria-labelledby="problem-title">
      <h2 id="problem-title">Medical costs arrive from everywhere</h2>
      <p className="lead">One visit can produce bills from a facility, a clinician and a lab. Some are paid in installments, some are partly covered, and some are worth an HSA claim later. The details end up in email, paper and spreadsheets, and it is hard to say what is still owed or what can be reimbursed.</p>
      <p className="lead">TallyMed is being built to keep providers, family members, installments and HSA claims in one traceable ledger.</p>
    </section>

    <section id="features" className="band" aria-labelledby="features-title">
      <div className="frame section">
        <h2 id="features-title">What TallyMed is planned to do</h2>
        <ul className="cards">{features.map(({ title, text }) =>
          <li key={title}><h3>{title}</h3><p>{text}</p></li>)}</ul>
      </div>
    </section>

    <section className="frame section" aria-labelledby="preview-title">
      <h2 id="preview-title">A look at the planned interface</h2>
      <p className="lead">Switch between views to see how the app is intended to work.</p>
      <Preview />
    </section>

    <section className="band" aria-labelledby="flow-title">
      <div className="frame section">
        <h2 id="flow-title">From visit to reimbursement</h2>
        <ol className="steps">{steps.map(({ title, text }) =>
          <li key={title}><h3>{title}</h3><p>{text}</p></li>)}</ol>
      </div>
    </section>

    <section className="frame section" aria-labelledby="host-title">
      <h2 id="host-title">Self-hosted and open source</h2>
      <p className="lead">TallyMed is planned to run with Docker Compose on your own network, behind a reverse proxy you control. The code is open, and the license is the GNU AGPL v3.</p>
      <ul className="inline-links">
        <li><a href={links.source}>Source code</a></li>
        <li><a href={links.license}>AGPL v3 license</a></li>
        <li><a href={links.docs}>Development documentation</a></li>
      </ul>
    </section>

    <section className="band" aria-labelledby="ai-title">
      <div className="frame section">
        <h2 id="ai-title">Optional AI assistance, with you in charge</h2>
        <p className="lead">AI is planned as an optional helper and is never required. An approved local client may request the data it is scoped to and propose a document match. Nothing changes until a signed-in person approves it.</p>
        <figure className="example">
          <figcaption>Illustration of a planned approval, using fictional data</figcaption>
          <dl>
            <div><dt>Proposal</dt><dd>Link “statement-march.pdf” to the Example Clinic bill</dd></div>
            <div><dt>Evidence</dt><dd>Matching provider, statement date and $180.00 balance</dd></div>
            <div><dt>Decision</dt><dd>Waiting for a person to approve or reject</dd></div>
          </dl>
        </figure>
        <h3>What an outside provider may receive</h3>
        <p>TallyMed itself does not send records to an AI provider. The assistant works through a local-network connection, but the client you choose decides where the data it reads goes. If that client uses a cloud-hosted model, the records and document text it requests can reach that provider. Using it is an explicit opt-in, and a local model keeps the data on your network.</p>
      </div>
    </section>

    <section className="frame section" aria-labelledby="progress-title">
      <h2 id="progress-title">Development progress</h2>
      <p className="lead">{done} of {roadmap.length} planned areas complete. {active.length > 0 && <>Now in development: {active.map((item) => item.name).join(', ')}.</>}</p>
      <Link className="button" href="/roadmap/">See the full roadmap</Link>
    </section>

    <section className="band" aria-labelledby="faq-title">
      <div className="frame section">
        <h2 id="faq-title">Questions</h2>
        <div className="faq">{faq.map(({ q, a }) =>
          <details key={q}><summary>{q}</summary><p>{a}</p></details>)}</div>
      </div>
    </section>
  </>;
}
