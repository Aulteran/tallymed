import Link from 'next/link';
import { pickParties } from '../../../server/services/expenses.ts';
import { hsaSummary, listHsaAllocations } from '../../../server/services/hsa.ts';
import { AllocationLink, DecisionPill } from '../../components/hsa.tsx';
import { Banner, Empty, flat, load, Money, Options, Pager, q80, requireSession, type SearchParams } from '../../components/ui.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HSA · TallyMed' };

const STATES: Array<[string, string]> = [
  ['', 'All payments'], ['undecided', 'Not decided yet'], ['eligible', 'Eligible'], ['available', 'Available to claim'], ['pending', 'Has pending claims'], ['received', 'Has reimbursements received'],
  ['needs_review', 'Needs review'], ['ineligible', 'Ineligible'],
];

export default async function HsaPage({ searchParams }: { searchParams: SearchParams }) {
  const { ctx, actor } = await requireSession();
  const p = await flat(searchParams);
  const [members, providers] = await Promise.all([
    pickParties(ctx.pool, actor, 'members', { archived: true, q: q80(p.memberQ), currentId: p.memberId }), pickParties(ctx.pool, actor, 'providers', { archived: true, q: q80(p.providerQ), currentId: p.providerId }),
  ]);
  const scope = Object.fromEntries(['memberId', 'providerId', 'from', 'to'].filter((k) => p[k]).map((k) => [k, p[k]!]));
  const filters = { ...scope, ...(p.state ? { state: p.state } : {}) };
  const totals = await load(() => hsaSummary(ctx.pool, actor, scope), null);
  const list = await load(() => listHsaAllocations(ctx.pool, actor, { ...filters, cursor: p.cursor }), { items: [], nextCursor: null });
  const t = totals.data;
  const link = (state: string) => `/hsa?${new URLSearchParams({ ...scope, state })}`;
  const exportLink = (kind: string) => `/api/hsa/export?${new URLSearchParams({ ...scope, kind })}`;
  const opt = (r: typeof members) => r.items.map((i) => ({ id: i.id, name: i.name, archived: i.archivedAt !== null }));
  return <main id="main" className="wide">
    <h1>HSA reimbursements</h1>
    <Banner invalid={totals.invalid || list.invalid} />
    <p className="muted">Eligibility is your decision, with a reason and evidence. Claims reserve amounts and receipts reconcile to specific payments. Received reimbursements are not household cash and never change a provider balance. TallyMed does not submit claims to an administrator or decide tax treatment.</p>
    <form method="get" className="card row" role="search" aria-label="Filters">
      <div><label htmlFor="memberId">Family member</label><select id="memberId" name="memberId" defaultValue={p.memberId ?? ''}><Options items={opt(members)} blank="Everyone" /></select></div>
      <div><label htmlFor="providerId">Provider</label><select id="providerId" name="providerId" defaultValue={p.providerId ?? ''}><Options items={opt(providers)} blank="All providers" /></select></div>
      <div><label htmlFor="from">Paid from</label><input id="from" name="from" type="date" defaultValue={p.from} /></div>
      <div><label htmlFor="to">Paid to</label><input id="to" name="to" type="date" defaultValue={p.to} /></div>
      <div><label htmlFor="state">Show</label><select id="state" name="state" defaultValue={p.state ?? ''}>{STATES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
      <div><button type="submit">Filter</button> <Link href="/hsa">Clear</Link></div>
    </form>
    {t && <section className="metrics" aria-label="HSA totals">
      <Link href={link('eligible')}><div className="card"><span>Eligible</span><strong><Money cents={t.eligibleCents} /></strong><span className="muted">Confirmed eligible net cash, {t.allocationCount} payments</span></div></Link>
      <Link href={link('available')}><div className="card accent"><span>Available</span><strong><Money cents={t.availableCents} /></strong><span className="muted">Eligible less pending and received</span></div></Link>
      <Link href={link('pending')}><div className="card"><span>Pending</span><strong><Money cents={t.pendingCents} /></strong><span className="muted">Reserved by claims not yet paid</span></div></Link>
      <Link href={link('received')}><div className="card"><span>Received</span><strong><Money cents={t.receivedCents} /></strong><span className="muted">Reimbursements, less reversals</span></div></Link>
      <Link href={link('needs_review')}><div className={BigInt(t.needsReviewCents) > 0n ? 'card warn' : 'card'}><span>Needs review</span><strong><Money cents={t.needsReviewCents} /></strong><span className="muted">{t.needsReviewCount} {Number(t.needsReviewCount) === 1 ? 'payment above its ceiling' : 'payments above their ceiling'}</span></div></Link>
      <Link href={link('undecided')}><div className="card"><span>Not decided yet</span><strong>{t.undecidedCount}</strong><span className="muted">Payments with no eligibility decision</span></div></Link>
    </section>}
    {list.data.items.length === 0 ? <Empty>No payments match. Record a payment and apply it to a bill first, then decide its eligibility here.</Empty> : <table className="stack">
      <caption className="muted">One row per payment allocation. Open a row to decide eligibility, claim or record a reimbursement.</caption>
      <thead><tr><th>Payment</th><th>Decision</th><th className="num">Net cash</th><th className="num">Ceiling</th><th className="num">Pending</th><th className="num">Received</th><th className="num">Available</th><th className="num">Needs review</th></tr></thead>
      <tbody>{list.data.items.map((a) => <tr key={a.allocationId}>
        <td data-label="Payment"><AllocationLink a={a} /></td><td data-label="Decision"><DecisionPill a={a} /></td>
        <td data-label="Net cash" className="num"><Money cents={a.netCents} /></td><td data-label="Ceiling" className="num"><Money cents={a.ceilingCents} /></td>
        <td data-label="Pending" className="num"><Money cents={a.pendingCents} /></td><td data-label="Received" className="num"><Money cents={a.receivedCents} /></td>
        <td data-label="Available" className="num"><Money cents={a.availableCents} /></td><td data-label="Needs review" className="num"><Money cents={a.needsReviewCents} /></td>
      </tr>)}</tbody>
    </table>}
    <Pager base="/hsa" params={filters} next={list.data.nextCursor} />
    <div className="card"><h2>Claims and receipts</h2>
      <p className="actions"><Link className="button secondary" href="/hsa/claims">Claims and reimbursements received</Link></p>
      <h3>Export this view (CSV)</h3>
      <p className="muted">Uses the family member, provider and date filters above. Rows and totals come from one consistent snapshot.</p>
      <ul>
        <li><a href={exportLink('allocations')}>Payments with their figures and a total row</a></li>
        <li><a href={exportLink('events')}>Every claim, receipt, release and reversal entry</a></li>
        <li><a href={exportLink('decisions')}>Every eligibility decision with its evidence</a></li>
      </ul>
    </div>
  </main>;
}
