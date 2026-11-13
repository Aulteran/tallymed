import Link from 'next/link';
import { formatCents } from '../../../server/money.ts';
import { pickParties } from '../../../server/services/expenses.ts';
import { pickPayableBills } from '../../../server/services/payments.ts';
import { listInstallmentQueue, listPlans } from '../../../server/services/plans.ts';
import {
  Banner, CADENCES, Csrf, flatWithFlash, label, load, Money, NarrowForm, newKey, Options, Pager, q80, requireSession, StatePill, todayUtc, Truncated, type SearchParams,
} from '../../components/ui.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Payment Plans · TallyMed' };

export default async function PlansPage({ searchParams }: { searchParams: SearchParams }) {
  const { ctx, actor, csrf } = await requireSession();
  const p = await flatWithFlash(searchParams, '/plans');
  const asOf = todayUtc();
  const [providers, bills] = await Promise.all([
    pickParties(ctx.pool, actor, 'providers', { q: q80(p.providerQ), currentId: p.providerId }), pickPayableBills(ctx.pool, actor, { q: q80(p.billQ), currentId: p.billId }),
  ]);
  const filters = Object.fromEntries(['q', 'status', 'providerId'].filter((k) => p[k]).map((k) => [k, p[k]!]));
  const { data, invalid } = await load(() => listPlans(ctx.pool, actor, { ...filters, cursor: p.cursor }, asOf), { items: [], nextCursor: null });
  const queue = await load(() => listInstallmentQueue(ctx.pool, actor, { state: p.state, asOf, limit: 25 }), { items: [], nextCursor: null });
  return <main className="wide">
    <h1>Payment Plans</h1>
    <Banner code={p.error} invalid={invalid} />
    <div className="card"><h2>Installments due</h2>
      <p className="row"><Link href="/plans?state=overdue">Overdue</Link> <Link href="/plans?state=upcoming">Upcoming</Link> <Link href="/plans">All unpaid</Link></p>
      {queue.data.items.length === 0 ? <p>Nothing is due in this view.</p> : <table className="stack">
        <thead><tr><th>Due</th><th>Plan</th><th>Provider</th><th>Family</th><th className="num">Installment</th><th className="num">Still owed</th><th>Status</th></tr></thead>
        <tbody>{queue.data.items.map((i) => <tr key={i.installmentId}>
          <td data-label="Due">{i.dueDate}</td><td data-label="Plan"><Link href={`/plans/${i.planId}`}>{i.planName}</Link> #{i.seq}</td><td data-label="Provider">{i.providerName}</td><td data-label="Family">{i.memberNames}</td>
          <td data-label="Installment" className="num"><Money cents={i.amountCents} /></td><td data-label="Still owed" className="num"><Money cents={i.unpaidCents} /></td>
          <td data-label="Status"><StatePill state={i.state} overdue={i.overdue} /></td>
        </tr>)}</tbody>
      </table>}
      <p className="muted">Late means the due date has passed and part of the installment is still unmatched. Dates use UTC.</p>
    </div>
    <form method="get" className="card row" role="search">
      <div><label htmlFor="q">Search plans</label><input id="q" name="q" defaultValue={p.q} /></div>
      <div><label htmlFor="status">Status</label><select id="status" name="status" defaultValue={p.status ?? ''}><option value="">All</option><option value="active">Active</option><option value="cancelled">Cancelled</option></select></div>
      <div><button type="submit">Filter</button> <Link href="/plans">Clear</Link></div>
    </form>
    {data.items.length === 0 ? <p>No payment plans yet.</p> : <table className="stack">
      <thead><tr><th>Plan</th><th>Provider</th><th className="num">Total</th><th className="num">Matched</th><th>Installments</th><th>Next due</th><th>Status</th></tr></thead>
      <tbody>{data.items.map((x) => <tr key={x.id}>
        <td data-label="Plan"><Link href={`/plans/${x.id}`}>{x.name}</Link></td><td data-label="Provider">{x.providerName}</td>
        <td data-label="Total" className="num"><Money cents={x.totalCents} /></td><td data-label="Matched" className="num"><Money cents={x.matchedCents} /></td>
        <td data-label="Installments">{x.installmentCount} · {label(x.cadence)}</td><td data-label="Next due">{x.nextDueDate ?? 'None'} {x.overdueCount > 0 && x.status === 'active' && <span className="pill warn">{x.overdueCount} overdue</span>}</td>
        <td data-label="Status">{x.status === 'cancelled' ? <span className="pill warn">Cancelled</span> : <span className="pill">Active</span>}</td>
      </tr>)}</tbody>
    </table>}
    <Pager base="/plans" params={filters} next={data.nextCursor} />
    {(providers.truncated || bills.truncated || p.providerQ || p.billQ) && <>
      {providers.truncated && <Truncated what="providers" />}{bills.truncated && <Truncated what="bills" />}
      <NarrowForm fields={[{ name: 'providerQ', label: 'Find a provider' }, { name: 'billQ', label: 'Find a bill' }]} values={p} />
    </>}
    <form className="card" method="post" action="/api/expenses/plans/create">
      <h2>Create a payment plan</h2><Csrf token={csrf} /><input type="hidden" name="idempotencyKey" value={newKey()} />
      <p className="muted">A plan is an obligation: its installments schedule amounts to pay, and creating one moves no cash. Record the actual payments on the Payments page, then match them to installments.</p>
      <label htmlFor="name">Plan name</label><input id="name" name="name" required maxLength={120} defaultValue={p.name} />
      <label htmlFor="providerId">Provider</label><select id="providerId" name="providerId" required defaultValue={p.providerId ?? ''}><Options items={providers.items.map((x) => ({ id: x.id, name: x.name }))} blank="Choose…" /></select>
      <label htmlFor="billId">Bill covered by the plan</label>
      <select id="billId" name="billId" required defaultValue={p.billId ?? ''}><Options items={bills.items.map((b) => ({ id: b.id, name: `${b.label} · ${b.statementDate} · open ${formatCents(b.openBalanceCents)}` }))} blank="Choose…" /></select>
      <p className="muted">The bill must be from the chosen provider and have confirmed amounts.</p>
      <label htmlFor="totalAmount">Total to pay (USD)</label><input id="totalAmount" name="totalAmount" inputMode="decimal" required pattern="\d{1,12}(\.\d{1,2})?" defaultValue={p.totalAmount} />
      <label htmlFor="installmentCount">Number of installments</label><input id="installmentCount" name="installmentCount" type="number" min={1} max={120} required defaultValue={p.installmentCount} />
      <label htmlFor="firstDueDate">First due date</label><input id="firstDueDate" name="firstDueDate" type="date" required defaultValue={p.firstDueDate} />
      <label htmlFor="cadence">Cadence</label><select id="cadence" name="cadence" defaultValue={p.cadence ?? 'monthly'}>{CADENCES.map((c) => <option key={c} value={c}>{label(c)}</option>)}</select>
      <button type="submit">Create plan</button>
      <p className="muted">Installments split the total exactly; any extra cents go to the earliest installments.</p>
    </form>
  </main>;
}
