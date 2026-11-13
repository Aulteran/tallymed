import Link from 'next/link';
import { listMembers } from '../../../server/services/expenses.ts';
import { Banner, Csrf, flat, load, Pager, requireSession, type SearchParams } from '../../components/ui.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Family members · TallyMed' };

export default async function Page({ searchParams }: { searchParams: SearchParams }) {
  const { ctx, actor, csrf } = await requireSession();
  const params = await flat(searchParams);
  const { data, invalid } = await load(() => listMembers(ctx.pool, actor, { q: params.q, archived: params.archived, cursor: params.cursor }), { items: [], nextCursor: null });
  return <main>
    <h1>Family members</h1>
    <Banner code={params.error} invalid={invalid} />
    <form method="get" className="card row" role="search">
      <div><label htmlFor="q">Search by name</label><input id="q" name="q" defaultValue={params.q} /></div>
      <div><label className="checkbox"><input type="checkbox" name="archived" value="yes" defaultChecked={params.archived === 'yes'} /> Include archived</label></div>
      <div><button type="submit">Search</button></div>
    </form>
    {data.items.length === 0 ? <p>No matching records.</p> : <table className="stack">
      <thead><tr><th>Name</th><th>Date of birth</th><th>Status</th></tr></thead>
      <tbody>{data.items.map((i) => <tr key={i.id}>
        <td data-label="Name"><Link href={`/members/${i.id}`}>{i.name}</Link></td>
        <td data-label="Date of birth">{i.dateOfBirth ?? ''}</td>
        <td data-label="Status">{i.archivedAt ? <span className="pill warn">Archived</span> : <span className="pill">Active</span>}</td>
      </tr>)}</tbody>
    </table>}
    <Pager base="/members" params={Object.fromEntries(Object.entries({ q: params.q, archived: params.archived }).filter(([, v]) => v) as Array<[string, string]>)} next={data.nextCursor} />
    <form className="card" method="post" action="/api/expenses/members/create">
      <h2>Add family member</h2>
      <Csrf token={csrf} />
      <label htmlFor="name">Name</label><input id="name" name="name" required maxLength={80} defaultValue={params.name} />
      <label htmlFor="dateOfBirth">Date of birth (optional)</label><input id="dateOfBirth" name="dateOfBirth" type="date" defaultValue={params.dateOfBirth} />
      <label htmlFor="notes">Notes</label><textarea id="notes" name="notes" maxLength={2000} defaultValue={params.notes} />
      <button type="submit">Add family member</button>
    </form>
  </main>;
}
