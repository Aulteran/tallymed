import Link from 'next/link';
import { listVisits, pickParties } from '../../../server/services/expenses.ts';
import { AddDialog } from '../../components/AddDialog.tsx';
import { Banner, Csrf, Empty, flatWithFlash, load, NarrowForm, Options, Pager, pick, q80, requireSession, Truncated, type SearchParams } from '../../components/ui.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Visits · TallyMed' };

export default async function VisitsPage({ searchParams }: { searchParams: SearchParams }) {
  const { ctx, actor, csrf } = await requireSession();
  const p = await flatWithFlash(searchParams, '/visits');
  const [members, providers, activeMembers, activeProviders] = await Promise.all([
    pickParties(ctx.pool, actor, 'members', { archived: true, q: q80(p.memberQ), currentId: p.memberId }),
    pickParties(ctx.pool, actor, 'providers', { archived: true, q: q80(p.providerQ), currentId: p.providerId }),
    pickParties(ctx.pool, actor, 'members', { q: q80(p.memberQ), currentId: p.memberId }),
    pickParties(ctx.pool, actor, 'providers', { q: q80(p.providerQ), currentId: p.providerId }),
  ]);
  const filters = Object.fromEntries(['q', 'memberId', 'providerId', 'from', 'to'].filter((k) => p[k]).map((k) => [k, p[k]!]));
  const { data, invalid } = await load(() => listVisits(ctx.pool, actor, { ...filters, cursor: p.cursor }), { items: [], nextCursor: null });
  const truncated = members.truncated || providers.truncated || activeMembers.truncated || activeProviders.truncated;
  const opt = (r: typeof members) => r.items.map((i) => ({ id: i.id, name: i.name, archived: i.archivedAt !== null }));
  const open = !!p.error || p.add === '1';
  return <main id="main" className="wide">
    <div className="page-head">
      <h1>Visits</h1>
      <AddDialog label="Add visit" open={open} keep={pick(p, ['q', 'memberId', 'providerId', 'from', 'to', 'memberQ', 'providerQ'])}>
        {p.error && <Banner code={p.error} />}
        <form method="post" action="/api/expenses/visits/create">
          <Csrf token={csrf} />
          <label htmlFor="v-member">Family member</label><select id="v-member" name="memberId" required defaultValue={p.memberId ?? ''}><Options items={opt(activeMembers)} blank="Choose…" /></select>
          <label htmlFor="v-provider">Provider</label><select id="v-provider" name="providerId" required defaultValue={p.providerId ?? ''}><Options items={opt(activeProviders)} blank="Choose…" /></select>
          <label htmlFor="serviceDate">Service date</label><input id="serviceDate" name="serviceDate" type="date" required defaultValue={p.serviceDate} />
          <label htmlFor="description">Description (optional)</label><input id="description" name="description" maxLength={200} defaultValue={p.description} />
          <label htmlFor="notes">Notes</label><textarea id="notes" name="notes" maxLength={2000} defaultValue={p.notes} />
          <button type="submit">Add visit</button>
          <p className="muted">One visit can have bills from several providers, such as a facility, a clinician and a lab. Add each bill from the Bills page.</p>
        </form>
      </AddDialog>
    </div>
    <Banner invalid={invalid} />
    {(truncated || p.memberQ || p.providerQ) && <>
      {(members.truncated || activeMembers.truncated) && <Truncated what="family members" />}{(providers.truncated || activeProviders.truncated) && <Truncated what="providers" />}
      <NarrowForm fields={[{ name: 'memberQ', label: 'Find a family member' }, { name: 'providerQ', label: 'Find a provider' }]} values={p} />
    </>}
    <form method="get" className="card row" role="search">
      <div><label htmlFor="q">Search</label><input id="q" name="q" defaultValue={p.q} /></div>
      <div><label htmlFor="memberId">Family member</label><select id="memberId" name="memberId" defaultValue={p.memberId ?? ''}><Options items={opt(members)} blank="Everyone" /></select></div>
      <div><label htmlFor="providerId">Provider</label><select id="providerId" name="providerId" defaultValue={p.providerId ?? ''}><Options items={opt(providers)} blank="All providers" /></select></div>
      <div><label htmlFor="from">From</label><input id="from" name="from" type="date" defaultValue={p.from} /></div>
      <div><label htmlFor="to">To</label><input id="to" name="to" type="date" defaultValue={p.to} /></div>
      <div><button type="submit">Filter</button></div>
    </form>
    {data.items.length === 0 ? <Empty>No visits match.</Empty> : <table className="stack">
      <thead><tr><th>Date</th><th>Family member</th><th>Provider</th><th>Description</th><th>Bills</th></tr></thead>
      <tbody>{data.items.map((v) => <tr key={v.id}>
        <td data-label="Date"><Link href={`/visits/${v.id}`}>{v.serviceDate}</Link></td><td data-label="Family member">{v.memberName}</td>
        <td data-label="Provider">{v.providerName}</td><td data-label="Description">{v.description}</td><td data-label="Bills">{v.billCount}</td>
      </tr>)}</tbody>
    </table>}
    <Pager base="/visits" params={filters} next={data.nextCursor} />
  </main>;
}
