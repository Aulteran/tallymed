'use client';
import { useId, useRef, useState, type KeyboardEvent } from 'react';

const views = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'plans', label: 'Payment Plans' },
  { id: 'hsa', label: 'HSA' },
] as const;
type ViewId = (typeof views)[number]['id'];

function Dashboard() {
  return <>
    <dl className="stats">
      <div><dt>Open balance</dt><dd>$1,240.00</dd></div>
      <div><dt>Paid this year</dt><dd>$865.50</dd></div>
      <div><dt>Reimbursable</dt><dd>$420.00</dd></div>
    </dl>
    <h4>Needs attention</h4>
    <ul className="rows">
      <li><span>Unmatched statement</span><span>Example Clinic · received this week</span></li>
      <li><span>Installment overdue</span><span>Sample Imaging · $75.00</span></li>
      <li><span>Eligible payment to review</span><span>Sample Pharmacy · $42.18</span></li>
    </ul>
  </>;
}

function Plans() {
  return <>
    <p className="plan-head"><strong>Sample Imaging</strong> · $450.00 in 6 monthly installments</p>
    <table>
      <caption className="sr-only">Fictional installment schedule</caption>
      <thead><tr><th scope="col">Due</th><th scope="col">Amount</th><th scope="col">State</th></tr></thead>
      <tbody>
        <tr><th scope="row">Jan 15</th><td>$75.00</td><td><span className="badge" data-tone="ok">Paid</span></td></tr>
        <tr><th scope="row">Feb 15</th><td>$75.00</td><td><span className="badge" data-tone="ok">Paid</span></td></tr>
        <tr><th scope="row">Mar 15</th><td>$75.00</td><td><span className="badge" data-tone="warn">Partial · $50.00</span></td></tr>
        <tr><th scope="row">Apr 15</th><td>$75.00</td><td><span className="badge" data-tone="warn">Overdue</span></td></tr>
        <tr><th scope="row">May 15</th><td>$75.00</td><td><span className="badge" data-tone="neutral">Upcoming</span></td></tr>
        <tr><th scope="row">Jun 15</th><td>$75.00</td><td><span className="badge" data-tone="neutral">Upcoming</span></td></tr>
      </tbody>
    </table>
  </>;
}

function Hsa() {
  return <>
    <dl className="stats">
      <div><dt>Available to claim</dt><dd>$420.00</dd></div>
      <div><dt>Pending claims</dt><dd>$180.00</dd></div>
      <div><dt>Reimbursed</dt><dd>$310.25</dd></div>
    </dl>
    <h4>Payments by eligibility</h4>
    <ul className="rows">
      <li><span>Sample Pharmacy · $42.18</span><span>Confirmed eligible</span></li>
      <li><span>Example Clinic · $180.00</span><span>Claim submitted</span></li>
      <li><span>Sample Dental · $95.00</span><span>Needs review</span></li>
    </ul>
  </>;
}

export default function Preview() {
  const [active, setActive] = useState<ViewId>('dashboard');
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const base = useId();

  function onKeyDown(event: KeyboardEvent, index: number) {
    const last = views.length - 1;
    const next = { ArrowRight: index === last ? 0 : index + 1, ArrowLeft: index === 0 ? last : index - 1, Home: 0, End: last }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setActive(views[next].id);
    refs.current[views[next].id]?.focus();
  }

  return <div className="preview">
    <p className="preview-note"><strong>Conceptual preview.</strong> Every name and amount is fictional, and every feature shown is planned, not available yet.</p>
    <div role="tablist" aria-label="Preview views" className="tabs">
      {views.map((view, index) => <button
        key={view.id}
        ref={(el) => { refs.current[view.id] = el; }}
        role="tab"
        type="button"
        id={`${base}-tab-${view.id}`}
        aria-selected={active === view.id}
        aria-controls={`${base}-panel-${view.id}`}
        tabIndex={active === view.id ? 0 : -1}
        onClick={() => setActive(view.id)}
        onKeyDown={(event) => onKeyDown(event, index)}
      >{view.label}</button>)}
    </div>
    {views.map((view) => <div
      key={view.id}
      role="tabpanel"
      id={`${base}-panel-${view.id}`}
      aria-labelledby={`${base}-tab-${view.id}`}
      hidden={active !== view.id}
      tabIndex={0}
      className="panel"
    >
      {view.id === 'dashboard' && <Dashboard />}
      {view.id === 'plans' && <Plans />}
      {view.id === 'hsa' && <Hsa />}
    </div>)}
  </div>;
}
