import Link from 'next/link';
import { AttachmentsPanel } from '../../../../components/documents.tsx';
import { getHsaAllocationDetail } from '../../../../../server/services/hsa.ts';
import { AMOUNT_PATTERN, DecisionPill, EvidenceOptions, FigureCards, LineStatusPill, SourceOptions } from '../../../../components/hsa.tsx';
import { Banner, Csrf, dateOf, flatWithFlash, label, load, Money, newKey, q80, requireSession, todayUtc, type SearchParams } from '../../../../components/ui.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HSA payment · TallyMed' };

export default async function HsaAllocationPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { ctx, actor, csrf } = await requireSession();
  const { id } = await params;
  const q = await flatWithFlash(searchParams, `/hsa/allocations/${id}`);
  const { data } = await load(() => getHsaAllocationDetail(ctx.pool, actor, id), null);
  const { allocation: a, decisions, lines, entries, history } = data!;
  const base = <><Csrf token={csrf} /><input type="hidden" name="allocationId" value={a.allocationId} /></>;
  const key = <input type="hidden" name="idempotencyKey" value={newKey()} />;
  const frozen = BigInt(a.needsReviewCents) > 0n;
  const canClaim = !frozen && BigInt(a.availableCents) > 0n;
  const current = decisions[0];
  return <main className="wide">
    <h1>HSA: {a.memberName} · {a.billLabel}</h1>
    <p><DecisionPill a={a} /> Paid {a.paidOn} · <Link href={`/payments/${a.paymentId}`}>payment</Link> · <Link href={`/bills/${a.billId}`}>bill</Link> · <Link href="/hsa">All HSA payments</Link></p>
    <Banner code={q.error} />
    <FigureCards a={a} />
    {frozen && <div className="card" role="alert"><strong>This payment needs review.</strong> Pending plus received reimbursement is above its eligible ceiling, usually after a refund, a reversal or a lower decision. Real receipts stay on record. New claims are frozen until you cancel or reject pending amounts, reverse a receipt that was returned, or record a new decision with evidence.</div>}
    <form className="card" method="post" action="/api/expenses/hsa/decide">
      <h2>Eligibility decision</h2>{base}{key}<input type="hidden" name="version" value={a.decisionCount} />
      <p className="muted">{current ? <>Current: {label(current.status)}{current.status === 'eligible' ? <> <Money cents={current.eligibleCents} /></> : null}, decided {current.decidedOn}. A new decision replaces it and keeps this one in the history.</> : 'No decision yet. Until you decide, this payment contributes nothing to available totals.'} A date or category alone does not make a payment eligible: record why, and what evidence supports it.</p>
      <label htmlFor="status">Decision</label>
      <select id="status" name="status" defaultValue={q.status ?? 'eligible'}><option value="eligible">Eligible (part or all)</option><option value="ineligible">Not eligible</option><option value="pending">Pending, still checking</option></select>
      <label htmlFor="eligibleAmount">Eligible amount (USD, only for eligible; at most <Money cents={a.netCents} />)</label>
      <input id="eligibleAmount" name="eligibleAmount" inputMode="decimal" pattern={AMOUNT_PATTERN} defaultValue={q.eligibleAmount} />
      <label htmlFor="rationale">Rationale</label><input id="rationale" name="rationale" required maxLength={500} defaultValue={q.rationale} />
      <label htmlFor="evidenceType">Evidence (required unless pending)</label>
      <select id="evidenceType" name="evidenceType" defaultValue={q.evidenceType ?? ''}><option value="">None yet</option><EvidenceOptions /></select>
      <label htmlFor="evidenceNote">Evidence reference</label><input id="evidenceNote" name="evidenceNote" maxLength={300} defaultValue={q.evidenceNote} placeholder="For example: pharmacy receipt dated 2026-04-01" />
      <label htmlFor="contextNote">Plan context (optional)</label><input id="contextNote" name="contextNote" maxLength={300} defaultValue={q.contextNote} placeholder="For example: plan year or account used" />
      <label htmlFor="decidedOn">Decision date</label><input id="decidedOn" name="decidedOn" type="date" required defaultValue={q.decidedOn ?? todayUtc()} />
      <button type="submit">Record decision</button>
    </form>
    {canClaim && <form className="card" method="post" action="/api/expenses/hsa/claim">
      <h2>Submit a claim</h2>{base}{key}
      <p className="muted">Records a claim you submitted to your HSA administrator and reserves the amount. Up to <Money cents={a.availableCents} /> is available. TallyMed does not send the claim.</p>
      <label htmlFor="amount">Amount (USD)</label><input id="amount" name="amount" inputMode="decimal" required pattern={AMOUNT_PATTERN} defaultValue={q.amount} />
      <label htmlFor="submittedOn">Date submitted</label><input id="submittedOn" name="submittedOn" type="date" required defaultValue={q.submittedOn ?? todayUtc()} />
      <label htmlFor="administrator">Administrator</label><input id="administrator" name="administrator" required maxLength={80} defaultValue={q.administrator} />
      <label htmlFor="reference">Claim reference (optional, unique)</label><input id="reference" name="reference" maxLength={80} defaultValue={q.reference} />
      <label htmlFor="note">Note (optional)</label><input id="note" name="note" maxLength={500} defaultValue={q.note} />
      <button type="submit">Submit claim</button>
    </form>}
    {canClaim && <form className="card" method="post" action="/api/expenses/hsa/external-receipt">
      <h2>Record a reimbursement not claimed here</h2>{base}{key}
      <p className="muted">For money the HSA already paid or reimbursed outside TallyMed. It needs a source and evidence, and it must fit the amount still available (<Money cents={a.availableCents} />).</p>
      <label htmlFor="x-amount">Amount (USD)</label><input id="x-amount" name="amount" inputMode="decimal" required pattern={AMOUNT_PATTERN} />
      <label htmlFor="x-date">Date received</label><input id="x-date" name="receivedOn" type="date" required defaultValue={todayUtc()} />
      <label htmlFor="x-source">Source</label><select id="x-source" name="source"><SourceOptions /></select>
      <label htmlFor="x-ref">Reference (optional)</label><input id="x-ref" name="reference" maxLength={80} />
      <label htmlFor="x-ev">Evidence</label><select id="x-ev" name="evidenceType" required><EvidenceOptions /></select>
      <label htmlFor="x-evn">Evidence reference</label><input id="x-evn" name="evidenceNote" required maxLength={300} />
      <label htmlFor="x-note">Note (optional)</label><input id="x-note" name="note" maxLength={500} />
      <button type="submit">Record reimbursement</button>
    </form>}
    <div className="card"><h2>Claim lines</h2>
      {lines.length === 0 ? <p>No claims for this payment yet.</p> : <table className="stack">
        <thead><tr><th>Claim</th><th>Status</th><th className="num">Reserved</th><th className="num">Pending</th><th className="num">Received</th><th className="num">Rejected</th><th className="num">Canceled</th></tr></thead>
        <tbody>{lines.map((l) => <tr key={l.lineId}>
          <td data-label="Claim"><Link href={`/hsa/claims/${l.claimId}`}>Open claim</Link></td><td data-label="Status"><LineStatusPill status={l.status} /></td>
          <td data-label="Reserved" className="num"><Money cents={l.reservedCents} /></td><td data-label="Pending" className="num"><Money cents={l.pendingCents} /></td>
          <td data-label="Received" className="num"><Money cents={l.receivedCents} /></td><td data-label="Rejected" className="num"><Money cents={l.rejectedCents} /></td>
          <td data-label="Canceled" className="num"><Money cents={l.canceledCents} /></td>
        </tr>)}</tbody></table>}
    </div>
    <div className="card"><h2>Decisions</h2>
      {decisions.length === 0 ? <p>None yet.</p> : <table className="stack">
        <thead><tr><th>Decided</th><th>Decision</th><th className="num">Eligible</th><th>Rationale</th><th>Evidence</th><th>By</th></tr></thead>
        <tbody>{decisions.map((d) => <tr key={d.id}><td data-label="Decided">{d.decidedOn}</td><td data-label="Decision">{label(d.status)}</td><td data-label="Eligible" className="num"><Money cents={d.eligibleCents} /></td>
          <td data-label="Rationale">{d.rationale}</td><td data-label="Evidence">{d.evidenceType ? `${label(d.evidenceType)}: ${d.evidenceNote ?? ''}` : 'None'}{d.contextNote ? ` · ${d.contextNote}` : ''}</td>
          <td data-label="By">{d.createdByName ?? ''} {dateOf(d.createdAt)}</td></tr>)}</tbody></table>}
      <p className="muted">Decisions are immutable. The newest one is current.</p>
    </div>
    <div className="card"><h2>Ledger</h2>
      {entries.length === 0 ? <p>No claim or receipt entries.</p> : <table className="stack">
        <thead><tr><th>Effective</th><th>Entry</th><th className="num">Amount</th><th>Links</th><th>Reason</th><th>Entered by</th></tr></thead>
        <tbody>{entries.map((e) => <tr key={e.id}><td data-label="Effective">{e.effectiveDate}</td><td data-label="Entry">{label(e.kind)}</td><td data-label="Amount" className="num"><Money cents={e.amountCents} /></td>
          <td data-label="Links">{e.claimId && <Link href={`/hsa/claims/${e.claimId}`}>Claim</Link>} {e.receiptId && <Link href={`/hsa/receipts/${e.receiptId}`}>Receipt</Link>}</td>
          <td data-label="Reason">{e.reason}</td><td data-label="Entered by">{e.createdByName ?? ''} {dateOf(e.createdAt)}</td></tr>)}</tbody></table>}
      <p className="muted">Entries are immutable. Corrections appear as new linked entries.</p>
    </div>
    {current ? <AttachmentsPanel ctx={ctx} actor={actor} csrf={csrf} type="hsa_eligibility_decision" id={current.id} returnTo={`/hsa/allocations/${a.allocationId}`} q={q80(q.docq)} title="Evidence for the current eligibility decision" />
      : <p className="muted">Record an eligibility decision to attach evidence documents to it.</p>}
    <div className="card"><h2>History</h2>
      <ol>{history.map((e) => <li key={e.id}><strong>{label(e.action.replace(/[._]/g, ' ').replace(/^hsa /, ''))}</strong> by {e.actorName ?? 'unknown'} · {dateOf(e.occurredAt)}</li>)}</ol>
    </div>
  </main>;
}
