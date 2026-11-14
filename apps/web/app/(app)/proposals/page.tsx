import Link from 'next/link';
import { listProposals } from '../../../server/services/assistant.ts';
import { Banner, dateOf, Empty, flat, label, load, Pager, requireSession, type SearchParams } from '../../components/ui.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Proposals · TallyMed' };

export default async function ProposalsPage({ searchParams }: { searchParams: SearchParams }) {
  const { ctx, actor } = await requireSession();
  const q = await flat(searchParams);
  const status = q.status ?? 'pending';
  const { data, invalid } = await load(() => listProposals(ctx.pool, actor, { status: status === 'all' ? undefined : status, cursor: q.cursor, limit: q.limit }), { items: [], nextCursor: null });
  return <main id="main" className="wide">
    <h1>Proposals</h1>
    <Banner code={q.error} invalid={invalid} />
    <p className="muted">An assistant suggested these document matches. Nothing changes until you approve one. Open a proposal to see the document, the record and the reason given, then approve or reject it.</p>
    <p className="tabs">{['pending', 'approved', 'rejected', 'all'].map((s) => (s === status ? <strong key={s}>{label(s)}</strong> : <Link key={s} href={`/proposals?status=${s}`}>{label(s)}</Link>))}</p>
    <div className="card">
      {data.items.length === 0 ? <Empty>No {status === 'all' ? '' : status} proposals.</Empty> : <table className="stack">
        <thead><tr><th>Document</th><th>Record</th><th>Confidence</th><th>From</th><th>Status</th></tr></thead>
        <tbody>{data.items.map((p) => <tr key={p.id}>
          <td data-label="Document"><Link href={`/proposals/${p.id}`}>{p.documentTitle}</Link></td>
          <td data-label="Record">{label(p.targetType)} · {p.targetProvider} · {p.targetDate}</td>
          <td data-label="Confidence">{label(p.confidence)}</td>
          <td data-label="From">{p.clientName} · {dateOf(p.createdAt)}</td>
          <td data-label="Status"><span className={p.status === 'pending' ? 'pill warn' : p.status === 'approved' ? 'pill' : 'pill neutral'}>{label(p.status)}</span>{p.stale && <> <span className="pill warn">Out of date</span></>}</td>
        </tr>)}</tbody>
      </table>}
      <Pager base="/proposals" params={{ status }} next={data.nextCursor} />
    </div>
  </main>;
}
