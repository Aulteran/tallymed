import Link from 'next/link';
import { getProvider, listBills, listVisits } from '../../../../server/services/expenses.ts';
import { Banner, Csrf, dateOf, flat, load, Money, requireSession, type SearchParams } from '../../../components/ui.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Provider · TallyMed' };
const KINDS = ['facility', 'clinician', 'lab', 'pharmacy', 'other'];

export default async function ProviderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { ctx, actor, csrf } = await requireSession();
  const { id } = await params;
  const q = await flat(searchParams);
  const { data: p } = await load(() => getProvider(ctx.pool, actor, id), null);
  const visits = await listVisits(ctx.pool, actor, { providerId: id, limit: 10 });
  const bills = await listBills(ctx.pool, actor, { providerId: id, limit: 10 });
  return <main id="main">
    <p className="crumb"><Link href="/providers">← Providers</Link></p>
    <h1>{p!.name} {p!.archivedAt && <span className="pill warn">Archived</span>}</h1>
    <Banner code={q.error} />
    <form className="card" method="post" action="/api/expenses/providers/update">
      <Csrf token={csrf} /><input type="hidden" name="id" value={p!.id} /><input type="hidden" name="version" value={p!.version} />
      <label htmlFor="name">Name</label><input id="name" name="name" required maxLength={120} defaultValue={p!.name} />
      <label htmlFor="kind">Type</label><select id="kind" name="kind" defaultValue={p!.kind}>{KINDS.map((k) => <option key={k}>{k}</option>)}</select>
      <label htmlFor="notes">Notes</label><textarea id="notes" name="notes" maxLength={2000} defaultValue={p!.notes} />
      <button type="submit">Save changes</button> <span className="muted">Updated {dateOf(p!.updatedAt)}. Existing bills and visits keep the name they were entered with.</span>
    </form>
    <form className="card" method="post" action="/api/expenses/providers/archive">
      <Csrf token={csrf} /><input type="hidden" name="id" value={p!.id} /><input type="hidden" name="version" value={p!.version} />
      {p!.archivedAt
        ? <><p>This provider is archived. Existing visits and bills keep their link. Restore to add new records.</p><button type="submit" className="secondary">Restore provider</button></>
        : <><p>Archiving hides this provider from new visits and bills. History and existing links are kept.</p>
          <input type="hidden" name="archived" value="yes" /><button type="submit" className="secondary">Archive provider</button></>}
    </form>
    <div className="card"><h2>Recent visits</h2>
      {visits.items.length === 0 ? <p>No visits.</p> : <ul className="rows">{visits.items.map((v) => <li key={v.id}><Link href={`/visits/${v.id}`}>{v.serviceDate} · {v.memberName}</Link></li>)}</ul>}</div>
    <div className="card"><h2>Recent bills</h2>
      {bills.items.length === 0 ? <p>No bills.</p> : <ul className="rows">{bills.items.map((b) => <li key={b.id}><Link href={`/bills/${b.id}`}>{b.statementDate} · {b.memberName}</Link> <Money cents={b.responsibilityCents} /></li>)}</ul>}
      <Link href={`/bills?providerId=${p!.id}`}>All bills</Link></div>
  </main>;
}
