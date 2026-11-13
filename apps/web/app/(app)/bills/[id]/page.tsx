import Link from 'next/link';
import { getBillDetail, listProviders, listVisits } from '../../../../server/services/expenses.ts';
import { centsToUsdInput } from '../../../../server/money.ts';
import {
  ADJUSTMENT_CATEGORIES, AMOUNT_SOURCES, Banner, Csrf, dateOf, flat, label, load, Money, newKey, Options, requireSession, type SearchParams,
} from '../../../components/ui.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Bill · TallyMed' };

export default async function BillPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { ctx, actor, csrf } = await requireSession();
  const { id } = await params;
  const q = await flat(searchParams);
  const { data } = await load(() => getBillDetail(ctx.pool, actor, id), null);
  const { bill: b, adjustments, duplicates, history } = data!;
  const [providers, visits] = await Promise.all([
    listProviders(ctx.pool, actor, { archived: 'yes', limit: 100 }), listVisits(ctx.pool, actor, { memberId: b.memberId, limit: 100 }),
  ]);
  const estimate = b.amountStatus === 'estimate';
  const hidden = (<><Csrf token={csrf} /><input type="hidden" name="id" value={b.id} /><input type="hidden" name="version" value={b.version} /></>);
  return <main className="wide">
    <h1>{b.providerName} bill {b.providerReference ?? ''}</h1>
    <p>
      <Link href={`/members/${b.memberId}`}>{b.memberName}</Link> {b.memberArchived && <span className="pill warn">Member archived</span>} ·
      {' '}<Link href={`/providers/${b.providerId}`}>{b.providerName}</Link> {b.providerArchived && <span className="pill warn">Provider archived</span>} ·
      {' '}{estimate ? <span className="pill warn">Estimate</span> : <span className="pill">Confirmed</span>}
    </p>
    <Banner code={q.error} />
    {duplicates.length > 0 && <div className="card" role="note"><strong>Possible duplicate.</strong> Similar bills for this provider:
      <ul>{duplicates.map((d) => <li key={d.id}><Link href={`/bills/${d.id}`}>{d.providerReference ?? 'No reference'} · {d.statementDate} · <Money cents={d.originalCents} /></Link></li>)}</ul>
      <span className="muted">This is only a hint. Nothing is merged automatically.</span></div>}
    <section className="metrics" aria-label="Amounts">
      <div className="card"><span>Billed amount</span><strong><Money cents={b.originalCents} /></strong></div>
      <div className="card"><span>Base household responsibility</span><strong><Money cents={b.baseResponsibilityCents} /></strong></div>
      <div className="card"><span>Adjustments</span><strong><Money cents={b.adjustmentsCents} /></strong></div>
      <div className="card"><span>Household responsibility</span><strong><Money cents={b.responsibilityCents} /></strong></div>
      <div className="card"><span>Open balance</span><strong><Money cents={b.openBalanceCents} /></strong><span className="muted">No payments are recorded yet (planned), so this equals responsibility.</span></div>
    </section>
    <div className="card"><h2>Provenance</h2>
      <p>Amounts from {label(b.amountSource)}{b.sourceNote ? `: ${b.sourceNote}` : ''}. Entered {dateOf(b.createdAt)}{b.confirmedAt ? `, confirmed ${dateOf(b.confirmedAt)}` : ', not yet confirmed'}.</p>
      {b.providerNameAtEntry !== b.providerName && <p className="muted">Provider name at entry: {b.providerNameAtEntry}. Member name at entry: {b.memberNameAtEntry}.</p>}
      {estimate && <form method="post" action="/api/expenses/bills/confirm">{hidden}<button type="submit">Confirm these amounts</button></form>}
    </div>
    <form className="card" method="post" action="/api/expenses/bills/update">
      <h2>Details</h2>{hidden}
      <label htmlFor="providerId">Billing provider</label>
      <select id="providerId" name="providerId" defaultValue={b.providerId ?? ''}><Options items={providers.items.map((p) => ({ id: p.id, name: p.name, archived: p.archivedAt !== null }))} /></select>
      <label htmlFor="providerReference">Provider reference</label><input id="providerReference" name="providerReference" maxLength={80} defaultValue={b.providerReference ?? ''} />
      <label htmlFor="statementDate">Statement date</label><input id="statementDate" name="statementDate" type="date" required defaultValue={b.statementDate} />
      <label htmlFor="dueDate">Due date</label><input id="dueDate" name="dueDate" type="date" defaultValue={b.dueDate ?? ''} />
      {estimate ? <>
        <label htmlFor="originalAmount">Billed amount (USD)</label><input id="originalAmount" name="originalAmount" inputMode="decimal" defaultValue={centsToUsdInput(b.originalCents)} />
        <label htmlFor="responsibilityAmount">Base household responsibility (USD)</label><input id="responsibilityAmount" name="responsibilityAmount" inputMode="decimal" defaultValue={centsToUsdInput(b.baseResponsibilityCents)} />
        <label htmlFor="amountSource">Source of amounts</label>
        <select id="amountSource" name="amountSource" defaultValue={b.amountSource}>{AMOUNT_SOURCES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select>
      </> : <p className="muted">Confirmed amounts change only through adjustments below.</p>}
      <label htmlFor="sourceNote">Source note</label><input id="sourceNote" name="sourceNote" maxLength={500} defaultValue={b.sourceNote} />
      <label htmlFor="notes">Notes</label><textarea id="notes" name="notes" maxLength={2000} defaultValue={b.notes} />
      <button type="submit">Save details</button>
    </form>
    <form className="card" method="post" action="/api/expenses/bills/assign-visit">
      <h2>Visit</h2>{hidden}
      <p>{b.visitId ? <>Linked to <Link href={`/visits/${b.visitId}`}>the visit on {b.visitDate}</Link>.</> : 'This bill is awaiting visit assignment.'}</p>
      <label htmlFor="visitId">Assign to a visit for {b.memberName}</label>
      <select id="visitId" name="visitId" defaultValue={b.visitId ?? ''}><Options items={visits.items.map((v) => ({ id: v.id, name: `${v.serviceDate} · ${v.providerName}` }))} blank="Awaiting visit assignment" /></select>
      <button type="submit">Save visit link</button>
    </form>
    <div className="card"><h2>Responsibility adjustments</h2>
      {adjustments.length === 0 ? <p>No adjustments. An insurer adjustment changes responsibility and is not a household payment.</p> : <table className="stack">
        <thead><tr><th>Effective</th><th>Category</th><th className="num">Amount</th><th>Reason and source</th><th>Entered by</th><th>Status</th></tr></thead>
        <tbody>{adjustments.map((a) => <tr key={a.id}>
          <td data-label="Effective">{a.effectiveDate}</td><td data-label="Category">{label(a.category)}</td>
          <td data-label="Amount" className="num"><Money cents={a.amountCents} /></td>
          <td data-label="Reason and source">{a.reason} ({label(a.source)}{a.sourceNote ? `: ${a.sourceNote}` : ''})</td>
          <td data-label="Entered by">{a.createdByName ?? ''} {dateOf(a.createdAt)}</td>
          <td data-label="Status">{a.reversesAdjustmentId ? 'Reversal entry' : a.reversedByAdjustmentId ? 'Reversed' : (
            <form method="post" action="/api/expenses/adjustments/reverse">
              <Csrf token={csrf} /><input type="hidden" name="idempotencyKey" value={newKey()} /><input type="hidden" name="billId" value={b.id} /><input type="hidden" name="adjustmentId" value={a.id} />
              <label htmlFor={`rev-${a.id}`}>Reason for reversing</label><input id={`rev-${a.id}`} name="reason" required maxLength={500} />
              <button type="submit" className="secondary">Reverse</button>
            </form>)}</td>
        </tr>)}</tbody>
      </table>}
    </div>
    <form className="card" method="post" action="/api/expenses/adjustments/create">
      <h2>Add an adjustment</h2>
      <Csrf token={csrf} /><input type="hidden" name="idempotencyKey" value={newKey()} /><input type="hidden" name="billId" value={b.id} />
      <label htmlFor="amount">Amount (USD, negative lowers what the household owes)</label>
      <input id="amount" name="amount" inputMode="decimal" required pattern="-?\d{1,12}(\.\d{1,2})?" placeholder="-25.00" defaultValue={q.amount} />
      <label htmlFor="category">Category</label>
      <select id="category" name="category" defaultValue={q.category ?? 'insurer_adjustment'}>{ADJUSTMENT_CATEGORIES.map((c) => <option key={c} value={c}>{label(c)}</option>)}</select>
      <label htmlFor="effectiveDate">Effective date</label><input id="effectiveDate" name="effectiveDate" type="date" required defaultValue={q.effectiveDate} />
      <label htmlFor="reason">Reason</label><input id="reason" name="reason" required maxLength={500} defaultValue={q.reason} />
      <label htmlFor="source">Source</label>
      <select id="source" name="source" defaultValue={q.source ?? 'eob'}>{AMOUNT_SOURCES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select>
      <label htmlFor="sourceNote">Source note (optional)</label><input id="sourceNote" name="sourceNote" maxLength={500} defaultValue={q.sourceNote} />
      <button type="submit">Post adjustment</button>
    </form>
    <div className="card"><h2>History</h2>
      <ol>{history.map((e) => <li key={e.id}><strong>{label(e.action.replace('.', ' '))}</strong> by {e.actorName ?? 'unknown'} · {dateOf(e.occurredAt)}</li>)}</ol>
    </div>
  </main>;
}
