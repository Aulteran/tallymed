import Link from 'next/link';
import { listProviders } from '../../../server/services/expenses.ts';
import { AddDialog } from '../../components/AddDialog.tsx';
import { Banner, Csrf, Empty, label, flatWithFlash, load, Pager, pick, requireSession, type SearchParams } from '../../components/ui.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Providers · TallyMed' };
const KINDS = ['facility', 'clinician', 'lab', 'pharmacy', 'other'];

export default async function Page({ searchParams }: { searchParams: SearchParams }) {
  const { ctx, actor, csrf } = await requireSession();
  const params = await flatWithFlash(searchParams, '/providers');
  const { data, invalid } = await load(() => listProviders(ctx.pool, actor, { q: params.q, archived: params.archived, cursor: params.cursor }), { items: [], nextCursor: null });
  const keep = pick(params, ['q', 'archived']);
  const open = !!params.error || params.add === '1';
  return <main id="main">
    <div className="page-head">
      <h1>Providers</h1>
      <AddDialog label="Add provider" open={open} keep={keep}>
        {params.error && <Banner code={params.error} />}
        <form method="post" action="/api/expenses/providers/create">
          <Csrf token={csrf} />
          <label htmlFor="name">Name</label><input id="name" name="name" required maxLength={120} defaultValue={params.name} />
          <label htmlFor="kind">Type</label><select id="kind" name="kind" defaultValue={params.kind ?? "clinician"}>{KINDS.map((k) => <option key={k}>{k}</option>)}</select>
          <label htmlFor="notes">Notes</label><textarea id="notes" name="notes" maxLength={2000} defaultValue={params.notes} />
          <button type="submit">Add provider</button>
        </form>
      </AddDialog>
    </div>
    <Banner invalid={invalid} />
    <form method="get" className="card row" role="search">
      <div><label htmlFor="q">Search by name</label><input id="q" name="q" defaultValue={params.q} /></div>
      <div><label className="checkbox"><input type="checkbox" name="archived" value="yes" defaultChecked={params.archived === 'yes'} /> Include archived</label></div>
      <div><button type="submit">Search</button></div>
    </form>
    {data.items.length === 0 ? <Empty>No matching records.</Empty> : <table className="stack">
      <thead><tr><th>Name</th><th>Type</th><th>Status</th></tr></thead>
      <tbody>{data.items.map((i) => <tr key={i.id}>
        <td data-label="Name"><Link href={`/providers/${i.id}`}>{i.name}</Link></td>
        <td data-label="Type">{i.kind ? label(i.kind) : ""}</td>
        <td data-label="Status">{i.archivedAt ? <span className="pill warn">Archived</span> : <span className="pill">Active</span>}</td>
      </tr>)}</tbody>
    </table>}
    <Pager base="/providers" params={keep} next={data.nextCursor} />
  </main>;
}
