import Link from 'next/link';
import { getHsaReceiptDetail } from '../../../../../server/services/hsa.ts';
import { Banner, Csrf, dateOf, flatWithFlash, label, load, Money, newKey, requireSession, todayUtc, type SearchParams } from '../../../../components/ui.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HSA reimbursement · TallyMed' };

export default async function HsaReceiptPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { ctx, actor, csrf } = await requireSession();
  const { id } = await params;
  const q = await flatWithFlash(searchParams, `/hsa/receipts/${id}`);
  const { data } = await load(() => getHsaReceiptDetail(ctx.pool, actor, id), null);
  const { receipt: r, entries, history } = data!;
  return <main className="wide">
    <h1>Reimbursement of <Money cents={r.amountCents} /> on {r.receivedOn}</h1>
    <p>{label(r.source)}{r.reference ? ` · ${r.reference}` : ''} · {r.origin === 'claim' ? 'Paid against claim lines' : 'Not claimed here'} · recorded by {r.createdByName ?? 'unknown'} {dateOf(r.createdAt)} {r.reversed && <span className="pill warn">Reversed</span>} · <Link href="/hsa/claims">All claims</Link></p>
    {r.evidenceType && <p>Evidence: {label(r.evidenceType)}{r.evidenceNote ? `: ${r.evidenceNote}` : ''}</p>}
    {r.note && <p>{r.note}</p>}
    <Banner code={q.error} />
    <p className="muted">This is not household cash. It reduces what is pending or available for the payments below and never changes a bill or provider balance.</p>
    <div className="card"><h2>Applied to</h2>
      <table className="stack"><thead><tr><th>Effective</th><th>Entry</th><th>Payment</th><th className="num">Amount</th><th>Reason</th></tr></thead>
        <tbody>{entries.map((e) => <tr key={e.id}><td data-label="Effective">{e.effectiveDate}</td><td data-label="Entry">{label(e.kind)}{e.claimId && <> · <Link href={`/hsa/claims/${e.claimId}`}>claim</Link></>}</td>
          <td data-label="Payment"><Link href={`/hsa/allocations/${e.allocationId}`}>{e.memberName} · {e.billLabel}</Link></td><td data-label="Amount" className="num"><Money cents={e.amountCents} /></td><td data-label="Reason">{e.reason}</td></tr>)}</tbody></table>
    </div>
    {!r.reversed && <form className="card" method="post" action="/api/expenses/hsa/receipt-reverse">
      <h2>Reverse this reimbursement</h2><Csrf token={csrf} /><input type="hidden" name="receiptId" value={r.id} /><input type="hidden" name="idempotencyKey" value={newKey()} />
      <p className="muted">Use this when it was recorded in error or the money was returned. The whole receipt is reversed with linked entries and stays in the history. The amount becomes available to claim again.</p>
      <label htmlFor="effectiveDate">Effective date</label><input id="effectiveDate" name="effectiveDate" type="date" required defaultValue={q.effectiveDate ?? todayUtc()} />
      <label htmlFor="reason">Reason</label><input id="reason" name="reason" required maxLength={500} defaultValue={q.reason} />
      <button type="submit" className="secondary">Reverse reimbursement</button>
    </form>}
    <div className="card"><h2>History</h2>
      <ol>{history.map((e) => <li key={e.id}><strong>{label(e.action.replace(/[._]/g, ' ').replace(/^hsa /, ''))}</strong> by {e.actorName ?? 'unknown'} · {dateOf(e.occurredAt)}</li>)}</ol>
    </div>
  </main>;
}
