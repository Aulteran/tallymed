import Link from 'next/link';
import { listMembers, listProviders, listVisits } from '../../../server/services/expenses.ts';
import { Banner, Csrf, flat, load, Options, Pager, requireSession, type SearchParams } from '../../components/ui.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Visits · TallyMed' };

export default async function VisitsPage({ searchParams }: { searchParams: SearchParams }) {
  const { ctx, actor, csrf } = await requireSession();
  const p = await flat(searchParams);
  const [members, providers, activeMembers, activeProviders] = await Promise.all([
    listMembers(ctx.pool, actor, { archived: 'yes', limit: 100 }), listProviders(ctx.pool, actor, { archived: 'yes', limit: 100 }),
    listMembers(ctx.pool, actor, { limit: 100 }), listProviders(ctx.pool, actor, { limit: 100 }),
  ]);
  const filters = Object.fromEntries(['q', 'memberId', 'providerId', 'from', 'to'].filter((k) => p[k]).map((k) => [k, p[k]!]));
  const { data, invalid } = await load(() => listVisits(ctx.pool, actor, { ...filters, cursor: p.cursor }), { items: [], nextCursor: null });
  const opt = (r: typeof members) => r.items.map((i) => ({ id: i.id, name: i.name, archived: i.archivedAt !== null }));
  return <main className="wide">
    <h1>Visits</h1>
    <Banner code={p.error} invalid={invalid} />
    <form method="get" className="card row" role="search">
      <div><label htmlFor="q">Search</label><input id="q" name="q" defaultValue={p.q} /></div>
      <div><label htmlFor="memberId">Family member</label><select id="memberId" name="memberId" defaultValue={p.memberId ?? ''}><Options items={opt(members)} blank="Everyone" /></select></div>
      <div><label htmlFor="providerId">Provider</label><select id="providerId" name="providerId" defaultValue={p.providerId ?? ''}><Options items={opt(providers)} blank="All providers" /></select></div>
      <div><label htmlFor="from">From</label><input id="from" name="from" type="date" defaultValue={p.from} /></div>
      <div><label htmlFor="to">To</label><input id="to" name="to" type="date" defaultValue={p.to} /></div>
      <div><button type="submit">Filter</button></div>
    </form>
    {data.items.length === 0 ? <p>No visits match.</p> : <table className="stack">
      <thead><tr><th>Date</th><th>Family member</th><th>Provider</th><th>Description</th><th>Bills</th></tr></thead>
      <tbody>{data.items.map((v) => <tr key={v.id}>
        <td data-label="Date"><Link href={`/visits/${v.id}`}>{v.serviceDate}</Link></td><td data-label="Family member">{v.memberName}</td>
        <td data-label="Provider">{v.providerName}</td><td data-label="Description">{v.description}</td><td data-label="Bills">{v.billCount}</td>
      </tr>)}</tbody>
    </table>}
    <Pager base="/visits" params={filters} next={data.nextCursor} />
    <form className="card" method="post" action="/api/expenses/visits/create">
      <h2>Record a visit</h2><Csrf token={csrf} />
      <label htmlFor="v-member">Family member</label><select id="v-member" name="memberId" required defaultValue={p.memberId ?? ''}><Options items={opt(activeMembers)} blank="Choose…" /></select>
      <label htmlFor="v-provider">Provider</label><select id="v-provider" name="providerId" required defaultValue={p.providerId ?? ''}><Options items={opt(activeProviders)} blank="Choose…" /></select>
      <label htmlFor="serviceDate">Service date</label><input id="serviceDate" name="serviceDate" type="date" required defaultValue={p.serviceDate} />
      <label htmlFor="description">Description (optional)</label><input id="description" name="description" maxLength={200} defaultValue={p.description} />
      <label htmlFor="notes">Notes</label><textarea id="notes" name="notes" maxLength={2000} defaultValue={p.notes} />
      <button type="submit">Record visit</button>
      <p className="muted">One visit can have bills from several providers, such as a facility, a clinician and a lab. Add each bill from the Bills page.</p>
    </form>
  </main>;
}
