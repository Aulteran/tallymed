import Link from 'next/link';
import { listMembers, listProviders, expenseOverview } from '../../server/services/expenses.ts';
import { cashSummary } from '../../server/services/payments.ts';
import { unmatchedSummary } from '../../server/services/documents.ts';
import { hsaQueues, hsaSummary } from '../../server/services/hsa.ts';
import { installmentSummary, listInstallmentQueue } from '../../server/services/plans.ts';
import { AllocationLink } from '../components/hsa.tsx';
import { NeedsAttention } from '../components/NeedsAttention.tsx';
import { Banner, flat, load, Money, Options, requireSession, todayUtc, type SearchParams } from '../components/ui.tsx';

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
  const unmatched = await unmatchedSummary(ctx.pool, actor, 5);
  const hsaLink = (state: string) => `/hsa?${new URLSearchParams({ ...hsaScope, state })}`;
  const t = data?.totals;
  const share = (part: string, whole: string) => { const w = BigInt(whole); if (w <= 0n) return 0; const p = BigInt(part) * 100n / w; return Number(p < 0n ? 0n : p > 100n ? 100n : p); };
  const paidPct = t ? share((BigInt(t.confirmedResponsibilityCents) - BigInt(t.confirmedOpenBalanceCents)).toString(), t.confirmedResponsibilityCents) : 0;
  const overdueNow = BigInt(due.overdueCents) > 0n;
  const hsaParts = [
    { key: 'available', label: 'HSA available', cents: hsaTotals.availableCents, note: 'Eligible, not yet claimed' },
    { key: 'pending', label: 'HSA pending', cents: hsaTotals.pendingCents, note: 'Reserved by open claims' },
    { key: 'received', label: 'HSA received', cents: hsaTotals.receivedCents, note: 'Reimbursed; provider balances unchanged' },
  ];
  // Geometry only: flex weights for the bar. Money is never computed from these numbers.
  const hsaTotal = hsaParts.reduce((sum, part) => sum + BigInt(part.cents), 0n);
  const plural = (n: string | number, one: string, many: string) => `${n} ${Number(n) === 1 ? one : many}`;
  return <main id="main" className="wide overview">
    <div className="page-head"><h1>Overview</h1></div>
    {params.notice === 'password_changed' && <p role="status">Your password was changed. Every other session was signed out.</p>}
    {params.notice === 'pin_set' && <p role="status">Your PIN was set. The screen now locks after a few minutes without activity.</p>}
    {params.notice === 'pin_changed' && <p role="status">Your PIN was changed.</p>}
    {params.error && <Banner code={params.error} />}
    <Banner invalid={invalid} />
    <form method="get" className="row filters" aria-label="Filters">
      <div><label htmlFor="memberId">Family member</label>
        <select id="memberId" name="memberId" defaultValue={params.memberId ?? ''}><Options items={members.items.map((m) => ({ id: m.id, name: m.name, archived: m.archivedAt !== null }))} blank="Everyone" /></select></div>
      <div><label htmlFor="providerId">Provider</label>
        <select id="providerId" name="providerId" defaultValue={params.providerId ?? ''}><Options items={providers.items.map((m) => ({ id: m.id, name: m.name, archived: m.archivedAt !== null }))} blank="All providers" /></select></div>
      <div><label htmlFor="from">Statements from</label><input id="from" name="from" type="date" defaultValue={params.from} /></div>
      <div><label htmlFor="to">Statements to</label><input id="to" name="to" type="date" defaultValue={params.to} /></div>
      <div><button type="submit" className="secondary">Apply</button> <Link href="/">Clear</Link></div>
    </form>
    {t && <>
      <section className="key-figures" aria-label="Key figures">
        <Link href={filter({ status: 'confirmed' })} className="key-figure primary">
          <span className="key-label">Confirmed open balance</span>
          <strong><Money cents={t.confirmedOpenBalanceCents} /></strong>
          <span className="progress" aria-hidden="true"><span style={{ width: `${paidPct}%` }} /></span>
          <span className="key-note">{paidPct}% paid of <Money cents={t.confirmedResponsibilityCents} /> confirmed responsibility</span>
        </Link>
        <Link href="/plans?state=upcoming" className="key-figure">
          <span className="key-label">Upcoming installments</span>
          <strong><Money cents={due.upcomingCents} /></strong>
          <span className="key-note">{plural(due.upcomingCount, 'installment', 'installments')} not yet due · all family</span>
        </Link>
        <Link href="/plans?state=overdue" className={overdueNow ? 'key-figure warn' : 'key-figure'}>
          <span className="key-label">Overdue installments</span>
          <strong><Money cents={due.overdueCents} /></strong>
          <span className="key-note">{overdueNow && <span className="pill warn">Past due</span>} {plural(due.overdueCount, 'installment', 'installments')} past due · all family</span>
        </Link>
      </section>
      <NeedsAttention sources={{
        overdue: overdue.items, needsReview: hsaQueue.needsReview, unmatched,
        awaitingVisit: data!.awaitingVisit, estimates: data!.estimates, duplicates: data!.possibleDuplicates,
      }} />
      <div className="secondary-grid">
        <section className="card compact" aria-labelledby="sec-hsa">
          <h2 id="sec-hsa">HSA reimbursements</h2>
          {hsaTotal > 0n
            ? <div className="stack-bar" aria-hidden="true">{hsaParts.map((part) => BigInt(part.cents) > 0n && <span key={part.key} className={`seg seg-${part.key}`} style={{ flexGrow: Number(BigInt(part.cents) * 1000n / hsaTotal) || 1 }} />)}</div>
            : <p className="muted">No HSA amounts in this view yet.</p>}
          <ul className="figure-list">
            {hsaParts.map((part) => <li key={part.key}><Link href={hsaLink(part.key)}><span className={`swatch seg-${part.key}`} aria-hidden="true" /><span className="fig-label">{part.label}<span className="fig-note">{part.note}</span></span><span className="fig-value"><Money cents={part.cents} /></span></Link></li>)}
            <li className={BigInt(hsaTotals.needsReviewCents) > 0n ? 'is-warn' : undefined}><Link href={hsaLink('needs_review')}><span className="swatch" aria-hidden="true" /><span className="fig-label">HSA needs review<span className="fig-note">{plural(hsaTotals.needsReviewCount, 'payment above its ceiling', 'payments above their ceiling')}</span></span><span className="fig-value"><Money cents={hsaTotals.needsReviewCents} /></span></Link></li>
          </ul>
          {hsaQueue.available.length > 0 && <>
            <h3>Ready to claim</h3>
            <ul className="rows small">{hsaQueue.available.map((a) => <li key={a.allocationId}><AllocationLink a={a} /> <Money cents={a.availableCents} /></li>)}</ul>
          </>}
        </section>
        <section className="card compact" aria-labelledby="sec-more">
          <h2 id="sec-more">Other figures</h2>
          <ul className="figure-list">
            <li><Link href={filter({ status: 'confirmed' })}><span className="fig-label">Confirmed responsibility<span className="fig-note">{plural(t.confirmedCount, 'bill', 'bills')}, after adjustments</span></span><span className="fig-value"><Money cents={t.confirmedResponsibilityCents} /></span></Link></li>
            <li><Link href={filter({ status: 'estimate' })}><span className="fig-label">Estimated, not confirmed<span className="fig-note">{plural(t.estimateCount, 'estimate', 'estimates')}, kept separate</span></span><span className="fig-value"><Money cents={t.estimatedResponsibilityCents} /></span></Link></li>
            <li><Link href="/payments?unapplied=yes"><span className="fig-label">Unapplied cash<span className="fig-note">Paid but not applied to a bill · all family</span></span><span className="fig-value"><Money cents={cash.unappliedCents} /></span></Link></li>
            {BigInt(t.confirmedCreditCents) > 0n && <li><Link href={filter({ status: 'confirmed' })}><span className="fig-label">Provider credits<span className="fig-note">Payments applied above responsibility</span></span><span className="fig-value"><Money cents={t.confirmedCreditCents} /></span></Link></li>}
            <li><Link href={filter({ awaitingVisit: 'yes' })}><span className="fig-label">Bills awaiting a visit<span className="fig-note">Not linked to a visit yet</span></span><span className="fig-value num">{t.awaitingVisitCount}</span></Link></li>
          </ul>
        </section>
      </div>
    </>}
    <p className="muted footnote">Amounts are in USD. Installments and unapplied cash cover the whole family. HSA figures use payment dates, so the statement-date filters do not apply to them.</p>
  </main>;
}

const isId = (v: string | undefined): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const pick = (p: Record<string, string>) => Object.fromEntries(['memberId', 'providerId', 'from', 'to'].filter((k) => p[k]).map((k) => [k, p[k]!]));
