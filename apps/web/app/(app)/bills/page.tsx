import Link from 'next/link';
import { listBills, listMembers, listProviders } from '../../../server/services/expenses.ts';
import { Banner, flat, load, Money, Options, Pager, requireSession, type SearchParams } from '../../components/ui.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Bills · TallyMed' };
const KEYS = ['q', 'memberId', 'providerId', 'visitId', 'status', 'awaitingVisit', 'duplicates', 'from', 'to'];

export default async function BillsPage({ searchParams }: { searchParams: SearchParams }) {
  const { ctx, actor } = await requireSession();
  const p = await flat(searchParams);
  const [members, providers] = await Promise.all([
    listMembers(ctx.pool, actor, { archived: 'yes', limit: 100 }), listProviders(ctx.pool, actor, { archived: 'yes', limit: 100 }),
  ]);
  const filters = Object.fromEntries(KEYS.filter((k) => p[k]).map((k) => [k, p[k]!]));
  const { data, invalid } = await load(() => listBills(ctx.pool, actor, { ...filters, cursor: p.cursor }), { items: [], nextCursor: null });
  const opt = (r: typeof members) => r.items.map((i) => ({ id: i.id, name: i.name, archived: i.archivedAt !== null }));
  return <main className="wide">
    <h1>Bills</h1>
    <Banner code={p.error} invalid={invalid} />
    <p><Link href="/bills/new">Enter a bill</Link></p>
    <form method="get" className="card row" role="search">
      <div><label htmlFor="q">Search reference or provider</label><input id="q" name="q" defaultValue={p.q} /></div>
      <div><label htmlFor="memberId">Family member</label><select id="memberId" name="memberId" defaultValue={p.memberId ?? ''}><Options items={opt(members)} blank="Everyone" /></select></div>
      <div><label htmlFor="providerId">Provider</label><select id="providerId" name="providerId" defaultValue={p.providerId ?? ''}><Options items={opt(providers)} blank="All providers" /></select></div>
      <div><label htmlFor="status">Amounts</label><select id="status" name="status" defaultValue={p.status ?? ''}><option value="">All</option><option value="confirmed">Confirmed</option><option value="estimate">Estimates</option></select></div>
      <div><label htmlFor="from">Statements from</label><input id="from" name="from" type="date" defaultValue={p.from} /></div>
      <div><label htmlFor="to">Statements to</label><input id="to" name="to" type="date" defaultValue={p.to} /></div>
      <div><label className="checkbox"><input type="checkbox" name="awaitingVisit" value="yes" defaultChecked={p.awaitingVisit === 'yes'} /> Awaiting a visit</label>
        <label className="checkbox"><input type="checkbox" name="duplicates" value="yes" defaultChecked={p.duplicates === 'yes'} /> Possible duplicates</label></div>
      <div><button type="submit">Filter</button> <Link href="/bills">Clear</Link></div>
    </form>
    {data.items.length === 0 ? <p>No bills match.</p> : <table className="stack">
      <thead><tr><th>Statement</th><th>Family member</th><th>Provider</th><th>Reference</th><th>Amounts</th><th>Visit</th><th className="num">Responsibility</th></tr></thead>
      <tbody>{data.items.map((b) => <tr key={b.id}>
        <td data-label="Statement"><Link href={`/bills/${b.id}`}>{b.statementDate}</Link></td>
        <td data-label="Family member">{b.memberName}</td><td data-label="Provider">{b.providerName}</td>
        <td data-label="Reference">{b.providerReference ?? ''} {b.possibleDuplicate && <span className="pill warn">Possible duplicate</span>}</td>
        <td data-label="Amounts">{b.amountStatus === 'estimate' ? <span className="pill warn">Estimate</span> : <span className="pill">Confirmed</span>}</td>
        <td data-label="Visit">{b.visitId ? <Link href={`/visits/${b.visitId}`}>{b.visitDate}</Link> : <span className="pill warn">Awaiting visit</span>}</td>
        <td data-label="Responsibility" className="num"><Money cents={b.responsibilityCents} /></td>
      </tr>)}</tbody>
    </table>}
    <Pager base="/bills" params={filters} next={data.nextCursor} />
  </main>;
}
