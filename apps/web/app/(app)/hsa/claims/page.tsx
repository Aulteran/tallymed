import Link from 'next/link';
import { listHsaClaims, listHsaReceipts } from '../../../../server/services/hsa.ts';
import { Banner, flat, label, load, Money, Pager, requireSession, type SearchParams } from '../../../components/ui.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HSA claims · TallyMed' };

export default async function HsaClaimsPage({ searchParams }: { searchParams: SearchParams }) {
  const { ctx, actor } = await requireSession();
  const p = await flat(searchParams);
  const filters: Record<string, string> = p.status ? { status: p.status } : {};
  const claims = await load(() => listHsaClaims(ctx.pool, actor, { ...filters, cursor: p.cursor }), { items: [], nextCursor: null });
  const receipts = await load(() => listHsaReceipts(ctx.pool, actor, { cursor: p.rcursor, limit: '10' }), { items: [], nextCursor: null });
  return <main id="main" className="wide">
    <p className="crumb"><Link href="/hsa">← HSA reimbursements</Link></p>
    <h1>HSA claims and reimbursements</h1>
    <p className="tabs"><Link href="/hsa/claims" aria-current={!p.status ? 'true' : undefined}>All claims</Link><Link href="/hsa/claims?status=open" aria-current={p.status === 'open' ? 'true' : undefined}>Open claims</Link><Link href="/hsa/claims?status=closed" aria-current={p.status === 'closed' ? 'true' : undefined}>Closed claims</Link></p>
    <Banner invalid={claims.invalid || receipts.invalid} />
    <div className="card"><h2>Claims</h2>
      {claims.data.items.length === 0 ? <p>No claims. Submit one from a payment's HSA page.</p> : <table className="stack">
        <thead><tr><th>Submitted</th><th>Administrator and reference</th><th className="num">Lines</th><th className="num">Reserved</th><th className="num">Pending</th><th className="num">Received</th><th>Status</th></tr></thead>
        <tbody>{claims.data.items.map((c) => <tr key={c.id}>
          <td data-label="Submitted"><Link href={`/hsa/claims/${c.id}`}>{c.submittedOn}</Link></td><td data-label="Administrator and reference">{c.administrator} {c.reference ?? ''}</td>
          <td data-label="Lines" className="num">{c.lineCount}</td><td data-label="Reserved" className="num"><Money cents={c.reservedCents} /></td>
          <td data-label="Pending" className="num"><Money cents={c.pendingCents} /></td><td data-label="Received" className="num"><Money cents={c.receivedCents} /></td>
          <td data-label="Status"><span className={c.open ? 'pill warn' : 'pill neutral'}>{c.open ? 'Open' : 'Closed'}</span></td>
        </tr>)}</tbody></table>}
      <Pager base="/hsa/claims" params={filters} next={claims.data.nextCursor} />
    </div>
    <div className="card"><h2>Reimbursements received</h2>
      {receipts.data.items.length === 0 ? <p>None recorded.</p> : <table className="stack">
        <thead><tr><th>Received</th><th>Source</th><th>Origin</th><th className="num">Amount</th><th>Status</th></tr></thead>
        <tbody>{receipts.data.items.map((r) => <tr key={r.id}>
          <td data-label="Received"><Link href={`/hsa/receipts/${r.id}`}>{r.receivedOn}</Link></td><td data-label="Source">{label(r.source)} {r.reference ?? ''}</td>
          <td data-label="Origin">{r.origin === 'claim' ? 'Claim' : 'Not claimed here'}</td><td data-label="Amount" className="num"><Money cents={r.amountCents} /></td>
          <td data-label="Status">{r.reversed ? <span className="pill warn">Reversed</span> : <span className="pill">Recorded</span>}</td>
        </tr>)}</tbody></table>}
      {receipts.data.nextCursor && <p><Link href={`/hsa/claims?${new URLSearchParams({ ...filters, ...(p.cursor ? { cursor: p.cursor } : {}), rcursor: receipts.data.nextCursor })}`}>More reimbursements</Link></p>}
    </div>
  </main>;
}
