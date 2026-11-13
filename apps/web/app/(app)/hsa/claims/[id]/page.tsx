import Link from 'next/link';
import { getHsaClaimDetail } from '../../../../../server/services/hsa.ts';
import { AMOUNT_PATTERN, LineStatusPill, SourceOptions } from '../../../../components/hsa.tsx';
import { Banner, Csrf, dateOf, flatWithFlash, label, load, Money, newKey, requireSession, todayUtc, type SearchParams } from '../../../../components/ui.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HSA claim · TallyMed' };

export default async function HsaClaimPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { ctx, actor, csrf } = await requireSession();
  const { id } = await params;
  const q = await flatWithFlash(searchParams, `/hsa/claims/${id}`);
  const { data } = await load(() => getHsaClaimDetail(ctx.pool, actor, id), null);
  const { claim, lines, entries, history } = data!;
  const base = <><Csrf token={csrf} /><input type="hidden" name="claimId" value={claim.id} /></>;
  const key = <input type="hidden" name="idempotencyKey" value={newKey()} />;
  return <main className="wide">
    <h1>Claim submitted {claim.submittedOn}</h1>
    <p>{claim.administrator}{claim.reference ? ` · ${claim.reference}` : ''} · by {claim.createdByName ?? 'unknown'} {dateOf(claim.createdAt)} <span className={claim.open ? 'pill warn' : 'pill'}>{claim.open ? 'Open' : 'Closed'}</span> · <Link href="/hsa/claims">All claims</Link></p>
    {claim.note && <p>{claim.note}</p>}
    <Banner code={q.error} />
    <section className="metrics" aria-label="Claim totals">
      <div className="card"><span>Reserved</span><strong><Money cents={claim.reservedCents} /></strong></div>
      <div className="card"><span>Pending</span><strong><Money cents={claim.pendingCents} /></strong><span className="muted">Still reserved</span></div>
      <div className="card"><span>Received</span><strong><Money cents={claim.receivedCents} /></strong><span className="muted">Less reversals</span></div>
    </section>
    {lines.map((l) => <div className="card" key={l.lineId}>
      <h2><Link href={`/hsa/allocations/${l.allocationId}`}>{l.memberName} · {l.billLabel}</Link> <LineStatusPill status={l.status} /></h2>
      <p>Reserved <Money cents={l.reservedCents} /> · pending <Money cents={l.pendingCents} /> · received <Money cents={l.receivedCents} />{BigInt(l.reversedCents) > 0n && <> (<Money cents={l.reversedCents} /> reversed)</>} · rejected <Money cents={l.rejectedCents} /> · canceled <Money cents={l.canceledCents} /></p>
      {BigInt(l.pendingCents) > 0n && <>
        <form method="post" action="/api/expenses/hsa/receipt">
          <h3>Record a reimbursement received</h3>{base}{key}<input type="hidden" name="lineId" value={l.lineId} />
          <p className="muted">Up to <Money cents={l.pendingCents} /> for this line. A receipt moves the amount from pending to received.</p>
          <label htmlFor={`r-amt-${l.lineId}`}>Amount (USD)</label><input id={`r-amt-${l.lineId}`} name="amount" inputMode="decimal" required pattern={AMOUNT_PATTERN} />
          <label htmlFor={`r-date-${l.lineId}`}>Date received</label><input id={`r-date-${l.lineId}`} name="receivedOn" type="date" required defaultValue={todayUtc()} />
          <label htmlFor={`r-src-${l.lineId}`}>Source</label><select id={`r-src-${l.lineId}`} name="source"><SourceOptions /></select>
          <label htmlFor={`r-ref-${l.lineId}`}>Reference (optional)</label><input id={`r-ref-${l.lineId}`} name="reference" maxLength={80} />
          <button type="submit">Record reimbursement</button>
        </form>
        <form method="post" action="/api/expenses/hsa/release">
          <h3>Reject or cancel the reserved amount</h3>{base}{key}<input type="hidden" name="lineId" value={l.lineId} />
          <p className="muted">Releases the reservation back to available. Anything already received stays.</p>
          <label htmlFor={`x-kind-${l.lineId}`}>What happened</label><select id={`x-kind-${l.lineId}`} name="kind"><option value="reject">Rejected by the administrator</option><option value="cancel">Canceled by me</option></select>
          <label htmlFor={`x-amt-${l.lineId}`}>Amount (blank releases all)</label><input id={`x-amt-${l.lineId}`} name="amount" inputMode="decimal" pattern={AMOUNT_PATTERN} />
          <label htmlFor={`x-date-${l.lineId}`}>Effective date</label><input id={`x-date-${l.lineId}`} name="effectiveDate" type="date" required defaultValue={todayUtc()} />
          <label htmlFor={`x-why-${l.lineId}`}>Reason</label><input id={`x-why-${l.lineId}`} name="reason" required maxLength={500} />
          <button type="submit" className="secondary">Release reservation</button>
        </form>
      </>}
    </div>)}
    <div className="card"><h2>Ledger</h2>
      <table className="stack"><thead><tr><th>Effective</th><th>Entry</th><th>Payment</th><th className="num">Amount</th><th>Reason</th><th>Entered by</th></tr></thead>
        <tbody>{entries.map((e) => <tr key={e.id}><td data-label="Effective">{e.effectiveDate}</td><td data-label="Entry">{label(e.kind)}{e.receiptId && <> · <Link href={`/hsa/receipts/${e.receiptId}`}>receipt</Link></>}</td>
          <td data-label="Payment"><Link href={`/hsa/allocations/${e.allocationId}`}>{e.memberName} · {e.billLabel}</Link></td><td data-label="Amount" className="num"><Money cents={e.amountCents} /></td>
          <td data-label="Reason">{e.reason}</td><td data-label="Entered by">{e.createdByName ?? ''} {dateOf(e.createdAt)}</td></tr>)}</tbody></table>
      <p className="muted">Entries are immutable. Corrections appear as new linked entries.</p>
    </div>
    <div className="card"><h2>History</h2>
      <ol>{history.map((e) => <li key={e.id}><strong>{label(e.action.replace(/[._]/g, ' ').replace(/^hsa /, ''))}</strong> by {e.actorName ?? 'unknown'} · {dateOf(e.occurredAt)}</li>)}</ol>
    </div>
  </main>;
}
