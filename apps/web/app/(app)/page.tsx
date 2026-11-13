import Link from 'next/link';
import { listMembers, listProviders, expenseOverview } from '../../server/services/expenses.ts';
import { Banner, flat, load, Money, Options, requireSession, type SearchParams } from '../components/ui.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Overview · TallyMed' };

export default async function Overview({ searchParams }: { searchParams: SearchParams }) {
  const { ctx, actor } = await requireSession();
  const params = await flat(searchParams);
  const filter = (extra: Record<string, string> = {}) => `/bills?${new URLSearchParams({ ...pick(params), ...extra })}`;
  const [members, providers] = await Promise.all([
    listMembers(ctx.pool, actor, { archived: 'yes', limit: 100 }), listProviders(ctx.pool, actor, { archived: 'yes', limit: 100 }),
  ]);
  const { data, invalid } = await load(() => expenseOverview(ctx.pool, actor, pick(params)), null);
  const t = data?.totals;
  return <main className="wide">
    <h1>Overview</h1>
    <Banner invalid={invalid} />
    <form method="get" className="card row" aria-label="Filters">
      <div><label htmlFor="memberId">Family member</label>
        <select id="memberId" name="memberId" defaultValue={params.memberId ?? ''}><Options items={members.items.map((m) => ({ id: m.id, name: m.name, archived: m.archivedAt !== null }))} blank="Everyone" /></select></div>
      <div><label htmlFor="providerId">Provider</label>
        <select id="providerId" name="providerId" defaultValue={params.providerId ?? ''}><Options items={providers.items.map((m) => ({ id: m.id, name: m.name, archived: m.archivedAt !== null }))} blank="All providers" /></select></div>
      <div><label htmlFor="from">Statements from</label><input id="from" name="from" type="date" defaultValue={params.from} /></div>
      <div><label htmlFor="to">Statements to</label><input id="to" name="to" type="date" defaultValue={params.to} /></div>
      <div><button type="submit">Apply</button> <Link href="/">Clear</Link></div>
    </form>
    {t && <>
      <section className="metrics" aria-label="Household responsibility">
        <Link href={filter({ status: 'confirmed' })}><div className="card"><span>Confirmed responsibility</span><strong><Money cents={t.confirmedResponsibilityCents} /></strong><span className="muted">{t.confirmedCount} bills, after adjustments</span></div></Link>
        <Link href={filter({ status: 'estimate' })}><div className="card"><span>Estimated, not confirmed</span><strong><Money cents={t.estimatedResponsibilityCents} /></strong><span className="muted">{t.estimateCount} estimates, kept separate</span></div></Link>
        <Link href={filter({ status: 'confirmed' })}><div className="card"><span>Confirmed open balance</span><strong><Money cents={t.confirmedOpenBalanceCents} /></strong><span className="muted">Equals responsibility until payments are recorded (planned)</span></div></Link>
        <Link href={filter({ awaitingVisit: 'yes' })}><div className="card"><span>Bills awaiting a visit</span><strong>{t.awaitingVisitCount}</strong></div></Link>
      </section>
      <div className="card">
        <h2>Bills awaiting a visit</h2>
        {data!.awaitingVisit.length === 0 ? <p>None. Every bill in this view is linked to a visit.</p> : <ul>{data!.awaitingVisit.map((b) => <li key={b.id}><Link href={`/bills/${b.id}`}>{b.providerName} · {b.memberName} · {b.statementDate}</Link></li>)}</ul>}
      </div>
      <div className="card">
        <h2>Estimates to confirm</h2>
        {data!.estimates.length === 0 ? <p>No estimated amounts.</p> : <ul>{data!.estimates.map((b) => <li key={b.id}><Link href={`/bills/${b.id}`}>{b.providerName} · {b.memberName} · {b.statementDate}</Link> <Money cents={b.responsibilityCents} /></li>)}</ul>}
      </div>
      <div className="card">
        <h2>Possible duplicates</h2>
        {data!.possibleDuplicates.length === 0 ? <p>No similar bills found.</p> : <ul>{data!.possibleDuplicates.map((b) => <li key={b.id}><Link href={`/bills/${b.id}`}>{b.providerName} · {b.providerReference ?? 'no reference'} · {b.statementDate}</Link></li>)}</ul>}
        <p className="muted">Hints only. TallyMed never merges bills automatically.</p>
      </div>
    </>}
    <p className="muted">Amounts are in USD. Payments, payment plans, HSA reimbursements and document management are planned and not available yet.</p>
  </main>;
}

const pick = (p: Record<string, string>) => Object.fromEntries(['memberId', 'providerId', 'from', 'to'].filter((k) => p[k]).map((k) => [k, p[k]!]));
