import Link from 'next/link';
import { pickParties } from '../../../server/services/expenses.ts';
import { listHsaAccounts } from '../../../server/services/hsa-accounts.ts';
import { hsaSummary, listHsaAllocations } from '../../../server/services/hsa.ts';
import { AddDialog } from '../../components/AddDialog.tsx';
import { AllocationLink, DecisionPill } from '../../components/hsa.tsx';
import { Banner, Csrf, Empty, flatWithFlash, load, Money, Options, Pager, q80, requireSession, Truncated, type SearchParams } from '../../components/ui.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HSA · TallyMed' };

const STATES: Array<[string, string]> = [
  ['', 'All payments'], ['undecided', 'Not decided yet'], ['eligible', 'Eligible'], ['available', 'Available to claim'], ['pending', 'Has pending claims'], ['received', 'Has reimbursements received'],
  ['needs_review', 'Needs review'], ['ineligible', 'Ineligible'],
];

export default async function HsaPage({ searchParams }: { searchParams: SearchParams }) {
  const { ctx, actor, csrf } = await requireSession();
  const p = await flatWithFlash(searchParams, '/hsa');
  const [members, providers] = await Promise.all([
    pickParties(ctx.pool, actor, 'members', { archived: true, q: q80(p.memberQ), currentId: p.memberId }), pickParties(ctx.pool, actor, 'providers', { archived: true, q: q80(p.providerQ), currentId: p.providerId }),
  ]);
  const scope = Object.fromEntries(['memberId', 'providerId', 'from', 'to'].filter((k) => p[k]).map((k) => [k, p[k]!]));
  const showArchived = p.accountsArchived === 'yes';
  const filters = { ...scope, ...(p.state ? { state: p.state } : {}) };
  /** The address of this page: the payment filters plus the accounts toggle (the toggle is not a payment filter, so it never reaches the service). */
  const view = { ...filters, ...(showArchived ? { accountsArchived: 'yes' } : {}) };
  const accounts = await load(() => listHsaAccounts(ctx.pool, actor, { archived: showArchived }), { items: [], truncated: false });
  const open = !!p.error || p.add === '1';
  const totals = await load(() => hsaSummary(ctx.pool, actor, scope), null);
  const list = await load(() => listHsaAllocations(ctx.pool, actor, { ...filters, cursor: p.cursor }), { items: [], nextCursor: null });
  const t = totals.data;
  const link = (state: string) => `/hsa?${new URLSearchParams({ ...scope, state, ...(showArchived ? { accountsArchived: 'yes' } : {}) })}`;
  const archivedToggle = `/hsa?${new URLSearchParams({ ...scope, ...(p.state ? { state: p.state } : {}), ...(showArchived ? {} : { accountsArchived: 'yes' }) })}`;
  const exportLink = (kind: string) => `/api/hsa/export?${new URLSearchParams({ ...scope, kind })}`;
  const opt = (r: typeof members) => r.items.map((i) => ({ id: i.id, name: i.name, archived: i.archivedAt !== null }));
  return <main id="main" className="wide">
    <div className="page-head">
      <h1>HSA</h1>
      <AddDialog label="Add HSA account" open={open} keep={view}>
        {p.error && <Banner code={p.error} />}
        <form method="post" action="/api/expenses/hsa-accounts/create">
          <Csrf token={csrf} />
          <p className="muted">Name your HSA, then say whether it has a spending card. A card you add here is saved on <Link href="/payment-methods">Payment methods</Link> and linked to this account, so a payment recorded with it is paid directly from the HSA and there is nothing to claim. Enter only the last four digits, never a full account or card number.</p>
          <label htmlFor="name">Name</label><input id="name" name="name" required maxLength={60} placeholder="Family HSA" defaultValue={p.name} />
          <label htmlFor="administrator">Administrator (optional)</label><input id="administrator" name="administrator" maxLength={80} placeholder="Example HSA Bank" defaultValue={p.administrator} />
          <label htmlFor="lastFour">Account last four digits (optional)</label><input id="lastFour" name="lastFour" inputMode="numeric" pattern="\d{4}" maxLength={4} placeholder="0000" defaultValue={p.lastFour} />
          <label className="checkbox" htmlFor="hasCard"><input id="hasCard" type="checkbox" name="hasCard" value="yes" defaultChecked={p.hasCard === 'yes'} /> This account also has a spending card</label>
          <div className="conditional-fields">
            <label htmlFor="cardNickname">Card nickname</label><input id="cardNickname" name="cardNickname" maxLength={60} placeholder="HSA Visa" defaultValue={p.cardNickname} />
            <label htmlFor="cardLastFour">Card last four digits (optional)</label><input id="cardLastFour" name="cardLastFour" inputMode="numeric" maxLength={4} placeholder="0000" defaultValue={p.cardLastFour} />
            <p className="muted">The card is saved as an HSA/FSA card payment method. A nickname is required when this box is ticked, and it must not match an active payment method's nickname.</p>
          </div>
          <button type="submit">Add HSA account</button>
        </form>
      </AddDialog>
    </div>
    <Banner invalid={totals.invalid || list.invalid || accounts.invalid} />
    <section aria-labelledby="hsa-accounts-heading">
      <h2 id="hsa-accounts-heading">Accounts</h2>
      {accounts.data.truncated && <Truncated what="HSA accounts" />}
      {accounts.data.items.length === 0 ? <Empty>No HSA accounts yet. Add one, and tick the spending card box to record payments paid directly from the HSA.</Empty> : <table className="stack">
        <thead><tr><th>HSA account</th><th>Administrator</th><th className="num">Paid directly</th><th className="num">Net cash</th><th>Status</th></tr></thead>
        <tbody>{accounts.data.items.map((a) => <tr key={a.id}>
          <td data-label="HSA account"><Link href={`/hsa/accounts/${a.id}`}>{a.name}{a.lastFour ? ` ••${a.lastFour}` : ''}</Link></td>
          <td data-label="Administrator">{a.administrator}</td>
          <td data-label="Paid directly" className="num">{a.paymentCount}</td>
          <td data-label="Net cash" className="num"><Money cents={a.netCashCents} /></td>
          <td data-label="Status">{a.archivedAt ? <span className="pill warn">Archived</span> : <span className="pill">Active</span>}</td>
        </tr>)}</tbody>
      </table>}
      <p className="muted">Paid directly and net cash count whole payments made with this account's cards, whether or not they are applied to bills, and ignore the filters below; the "Paid directly from HSA" total further down counts only cash applied to bills in the filtered view. Net cash follows the cash summary: refunds are subtracted and voided payments count zero. <Link href={archivedToggle}>{showArchived ? 'Hide archived accounts' : 'Show archived accounts'}</Link></p>
    </section>
    <h2>Reimbursements</h2>
    <p className="muted">Eligibility is your decision, with a reason and evidence. Claims reserve amounts and receipts reconcile to specific payments. Received reimbursements are not household cash and never change a provider balance. TallyMed does not submit claims to an administrator or decide tax treatment.</p>
    <form method="get" className="card row" role="search" aria-label="Filters">
      <div><label htmlFor="memberId">Family member</label><select id="memberId" name="memberId" defaultValue={p.memberId ?? ''}><Options items={opt(members)} blank="Everyone" /></select></div>
      <div><label htmlFor="providerId">Provider</label><select id="providerId" name="providerId" defaultValue={p.providerId ?? ''}><Options items={opt(providers)} blank="All providers" /></select></div>
      <div><label htmlFor="from">Paid from</label><input id="from" name="from" type="date" defaultValue={p.from} /></div>
      <div><label htmlFor="to">Paid to</label><input id="to" name="to" type="date" defaultValue={p.to} /></div>
      <div><label htmlFor="state">Show</label><select id="state" name="state" defaultValue={p.state ?? ''}>{STATES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
      <div>{showArchived && <input type="hidden" name="accountsArchived" value="yes" />}<button type="submit">Filter</button> <Link href="/hsa">Clear</Link></div>
    </form>
    {t && <section className="metrics" aria-label="HSA totals">
      <Link href={link('eligible')}><div className="card"><span>Eligible</span><strong><Money cents={t.eligibleCents} /></strong><span className="muted">Confirmed eligible net cash, {t.allocationCount} payments</span></div></Link>
      <Link href={link('available')}><div className="card accent"><span>Available</span><strong><Money cents={t.availableCents} /></strong><span className="muted">Eligible less pending and received</span></div></Link>
      <Link href={link('pending')}><div className="card"><span>Pending</span><strong><Money cents={t.pendingCents} /></strong><span className="muted">Reserved by claims not yet paid</span></div></Link>
      <Link href={link('received')}><div className="card"><span>Received</span><strong><Money cents={t.receivedCents} /></strong><span className="muted">Reimbursements, less reversals</span></div></Link>
      <Link href={link('needs_review')}><div className={BigInt(t.needsReviewCents) > 0n ? 'card warn' : 'card'}><span>Needs review</span><strong><Money cents={t.needsReviewCents} /></strong><span className="muted">{t.needsReviewCount} {Number(t.needsReviewCount) === 1 ? 'payment above its ceiling' : 'payments above their ceiling'}</span></div></Link>
      {t.directCount > 0 && <div className="card"><span>Paid directly from HSA</span><strong><Money cents={t.paidDirectlyCents} /></strong><span className="muted">Applied to bills, {t.directCount} {t.directCount === 1 ? 'allocation' : 'allocations'}; made with an HSA card, nothing to claim</span></div>}
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
    <Pager base="/hsa" params={view} next={list.data.nextCursor} />
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
