import Link from 'next/link';
import { listMembers, listProviders, expenseOverview } from '../../server/services/expenses.ts';
import { cashSummary } from '../../server/services/payments.ts';
import { hsaQueues, hsaSummary } from '../../server/services/hsa.ts';
import { installmentSummary, listInstallmentQueue } from '../../server/services/plans.ts';
import { AllocationLink } from '../components/hsa.tsx';
import { Banner, flat, load, Money, Options, requireSession, StatePill, todayUtc, type SearchParams } from '../components/ui.tsx';

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
  const asOf = todayUtc();
  const [cash, due, overdue] = await Promise.all([
    cashSummary(ctx.pool, actor), installmentSummary(ctx.pool, actor, asOf), listInstallmentQueue(ctx.pool, actor, { state: 'overdue', asOf, limit: 5, ...(isId(params.memberId) ? { memberId: params.memberId } : {}), ...(isId(params.providerId) ? { providerId: params.providerId } : {}) }),
  ]);
  const hsaScope = { ...(isId(params.memberId) ? { memberId: params.memberId } : {}), ...(isId(params.providerId) ? { providerId: params.providerId } : {}) };
  const [hsaTotals, hsaQueue] = await Promise.all([hsaSummary(ctx.pool, actor, hsaScope), hsaQueues(ctx.pool, actor, hsaScope, 5)]);
  const hsaLink = (state: string) => `/hsa?${new URLSearchParams({ ...hsaScope, state })}`;
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
        <Link href={filter({ status: 'confirmed' })}><div className="card"><span>Confirmed open balance</span><strong><Money cents={t.confirmedOpenBalanceCents} /></strong><span className="muted">Responsibility minus net payments applied</span></div></Link>
        {BigInt(t.confirmedCreditCents) > 0n && <Link href={filter({ status: 'confirmed' })}><div className="card"><span>Provider credits</span><strong><Money cents={t.confirmedCreditCents} /></strong><span className="muted">Payments applied above responsibility</span></div></Link>}
        <Link href="/payments?unapplied=yes"><div className="card"><span>Unapplied cash</span><strong><Money cents={cash.unappliedCents} /></strong><span className="muted">Paid but not applied to a bill (all family)</span></div></Link>
        <Link href="/plans?state=overdue"><div className="card"><span>Overdue installments</span><strong><Money cents={due.overdueCents} /></strong><span className="muted">{due.overdueCount} installments past due (all family)</span></div></Link>
        <Link href="/plans?state=upcoming"><div className="card"><span>Upcoming installments</span><strong><Money cents={due.upcomingCents} /></strong><span className="muted">{due.upcomingCount} installments not yet due (all family)</span></div></Link>
        <Link href={filter({ awaitingVisit: 'yes' })}><div className="card"><span>Bills awaiting a visit</span><strong>{t.awaitingVisitCount}</strong></div></Link>
      </section>
      <section className="metrics" aria-label="HSA reimbursements">
        <Link href={hsaLink('available')}><div className="card"><span>HSA available</span><strong><Money cents={hsaTotals.availableCents} /></strong><span className="muted">Eligible and not yet claimed (statement dates do not filter this)</span></div></Link>
        <Link href={hsaLink('pending')}><div className="card"><span>HSA pending</span><strong><Money cents={hsaTotals.pendingCents} /></strong><span className="muted">Reserved by open claims</span></div></Link>
        <Link href={hsaLink('received')}><div className="card"><span>HSA received</span><strong><Money cents={hsaTotals.receivedCents} /></strong><span className="muted">Not household cash; provider balances unchanged</span></div></Link>
        <Link href={hsaLink('needs_review')}><div className="card"><span>HSA needs review</span><strong><Money cents={hsaTotals.needsReviewCents} /></strong><span className="muted">{hsaTotals.needsReviewCount} payments above their ceiling</span></div></Link>
      </section>
      <div className="card">
        <h2>Available HSA reimbursements</h2>
        {hsaQueue.available.length === 0 ? <p>Nothing is available to claim in this view. <Link href={hsaLink('undecided')}>{hsaTotals.undecidedCount} payments have no eligibility decision.</Link></p> : <ul>{hsaQueue.available.map((a) => <li key={a.allocationId}><AllocationLink a={a} /> <Money cents={a.availableCents} /></li>)}</ul>}
      </div>
      <div className="card">
        <h2>HSA payments that need review</h2>
        {hsaQueue.needsReview.length === 0 ? <p>None. Pending and received amounts fit within every eligible ceiling.</p> : <ul>{hsaQueue.needsReview.map((a) => <li key={a.allocationId}><AllocationLink a={a} /> <Money cents={a.needsReviewCents} /></li>)}</ul>}
      </div>
      <div className="card">
        <h2>Overdue installments</h2>
        {overdue.items.length === 0 ? <p>No installments are overdue in this view.</p> : <ul>{overdue.items.map((i) => <li key={i.installmentId}><Link href={`/plans/${i.planId}`}>{i.planName} #{i.seq} · due {i.dueDate}</Link> <Money cents={i.unpaidCents} /> <StatePill state={i.state} overdue /></li>)}</ul>}
      </div>
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
    <p className="muted">Amounts are in USD. Document management is planned and not available yet. HSA figures use payment dates; the statement-date filters above do not apply to them.</p>
  </main>;
}

const isId = (v: string | undefined): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const pick = (p: Record<string, string>) => Object.fromEntries(['memberId', 'providerId', 'from', 'to'].filter((k) => p[k]).map((k) => [k, p[k]!]));
