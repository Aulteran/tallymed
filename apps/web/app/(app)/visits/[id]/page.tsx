import Link from 'next/link';
import { getVisit, listProviders } from '../../../../server/services/expenses.ts';
import { Banner, Csrf, flat, load, Money, Options, requireSession, type SearchParams } from '../../../components/ui.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Visit · TallyMed' };

export default async function VisitPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { ctx, actor, csrf } = await requireSession();
  const { id } = await params;
  const q = await flat(searchParams);
  const { data } = await load(() => getVisit(ctx.pool, actor, id), null);
  const { visit: v, bills } = data!;
  const providers = await listProviders(ctx.pool, actor, { archived: 'yes', limit: 100 });
  return <main>
    <h1>Visit on {v.serviceDate}</h1>
    <p>{v.memberName} · <Link href={`/members/${v.memberId}`}>profile</Link> · {v.providerName} {v.providerArchived && <span className="pill warn">Provider archived</span>}</p>
    {v.providerNameAtEntry !== v.providerName && <p className="muted">Entered as {v.providerNameAtEntry}.</p>}
    <Banner code={q.error} />
    <form className="card" method="post" action="/api/expenses/visits/update">
      <Csrf token={csrf} /><input type="hidden" name="id" value={v.id} /><input type="hidden" name="version" value={v.version} />
      <label htmlFor="providerId">Visit provider</label>
      <select id="providerId" name="providerId" defaultValue={v.providerId ?? ''}><Options items={providers.items.map((p) => ({ id: p.id, name: p.name, archived: p.archivedAt !== null }))} /></select>
      <label htmlFor="serviceDate">Service date</label><input id="serviceDate" name="serviceDate" type="date" required defaultValue={v.serviceDate} />
      <label htmlFor="description">Description</label><input id="description" name="description" maxLength={200} defaultValue={v.description} />
      <label htmlFor="notes">Notes</label><textarea id="notes" name="notes" maxLength={2000} defaultValue={v.notes} />
      <button type="submit">Save changes</button>
    </form>
    <div className="card">
      <h2>Bills for this visit</h2>
      {bills.length === 0 ? <p>No bills linked yet.</p> : <table className="stack">
        <thead><tr><th>Billing provider</th><th>Reference</th><th>Status</th><th>Responsibility</th></tr></thead>
        <tbody>{bills.map((b) => <tr key={b.id}>
          <td data-label="Billing provider"><Link href={`/bills/${b.id}`}>{b.providerName}</Link></td><td data-label="Reference">{b.providerReference ?? ''}</td>
          <td data-label="Status">{b.amountStatus}</td><td data-label="Responsibility" className="num"><Money cents={b.responsibilityCents} /></td>
        </tr>)}</tbody>
      </table>}
      <p><Link href={`/bills/new?memberId=${v.memberId}&visitId=${v.id}`}>Add a bill to this visit</Link></p>
    </div>
  </main>;
}
