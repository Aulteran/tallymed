import Link from 'next/link';
import { deployment } from '../lib/deployment.mjs';

export default function Home() {
  return <section className="hero">
    <div className="frame">
      <p className="status">Open source · In development</p>
      <h1>Medical expenses,<br /> accounted for.</h1>
      <p className="intro">TallyMed is a planned self-hosted tracker for your family’s medical bills, payment plans, receipts, and HSA reimbursements.</p>
      <div className="actions">
        <Link className="button" href="/roadmap/">See the roadmap</Link>
        {deployment.source && <a href={deployment.source}>View on GitHub</a>}
      </div>
    </div>
  </section>;
}
