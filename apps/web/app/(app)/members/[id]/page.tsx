import Link from 'next/link';
import { getMember, listBills, listVisits } from '../../../../server/services/expenses.ts';
import { Banner, Csrf, dateOf, flat, load, Money, requireSession, type SearchParams } from '../../../components/ui.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Family member · TallyMed' };

export default async function MemberPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { ctx, actor, csrf } = await requireSession();
  const { id } = await params;
  const q = await flat(searchParams);
  const { data: m } = await load(() => getMember(ctx.pool, actor, id), null);
  const visits = await listVisits(ctx.pool, actor, { memberId: id, limit: 10 });
  const bills = await listBills(ctx.pool, actor, { memberId: id, limit: 10 });
  return <main id="main">
    <p className="crumb"><Link href="/members">← Family members</Link></p>
    <h1>{m!.name} {m!.archivedAt && <span className="pill warn">Archived</span>}</h1>
    <Banner code={q.error} />
    <form className="card" method="post" action="/api/expenses/members/update">
      <Csrf token={csrf} /><input type="hidden" name="id" value={m!.id} /><input type="hidden" name="version" value={m!.version} />
      <label htmlFor="name">Name</label><input id="name" name="name" required maxLength={80} defaultValue={m!.name} />
      <label htmlFor="dateOfBirth">Date of birth (optional)</label><input id="dateOfBirth" name="dateOfBirth" type="date" defaultValue={m!.dateOfBirth ?? ''} />
      <label htmlFor="notes">Notes</label><textarea id="notes" name="notes" maxLength={2000} defaultValue={m!.notes} />
      <button type="submit">Save changes</button> <span className="muted">Updated {dateOf(m!.updatedAt)}</span>
    </form>
    <form className="card" method="post" action="/api/expenses/members/archive">
      <Csrf token={csrf} /><input type="hidden" name="id" value={m!.id} /><input type="hidden" name="version" value={m!.version} />
      {m!.archivedAt
        ? <><p>This member is archived. Existing visits and bills keep their link. Restore to add new records.</p><button type="submit" className="secondary">Restore member</button></>
        : <><p>Archiving hides this member from new visits and bills. History and existing links are kept.</p>
          <input type="hidden" name="archived" value="yes" /><button type="submit" className="secondary">Archive member</button></>}
    </form>
    <div className="card"><h2>Recent visits</h2>
      {visits.items.length === 0 ? <p>No visits.</p> : <ul className="rows">{visits.items.map((v) => <li key={v.id}><Link href={`/visits/${v.id}`}>{v.serviceDate} · {v.providerName}</Link></li>)}</ul>}
      <Link href={`/visits?memberId=${m!.id}`}>All visits</Link></div>
    <div className="card"><h2>Recent bills</h2>
      {bills.items.length === 0 ? <p>No bills.</p> : <ul className="rows">{bills.items.map((b) => <li key={b.id}><Link href={`/bills/${b.id}`}>{b.statementDate} · {b.providerName}</Link> <Money cents={b.responsibilityCents} /></li>)}</ul>}
      <Link href={`/bills?memberId=${m!.id}`}>All bills</Link></div>
  </main>;
}
