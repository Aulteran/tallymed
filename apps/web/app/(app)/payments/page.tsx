import Link from 'next/link';
import { formatCents } from '../../../server/money.ts';
import { pickParties } from '../../../server/services/expenses.ts';
import { cashSummary, listPayments, pickPayableBills } from '../../../server/services/payments.ts';
import { AddDialog } from '../../components/AddDialog.tsx';
import {
  Banner, Csrf, Empty, flatWithFlash, label, load, Money, NarrowForm, newKey, Options, Pager, PAYMENT_METHODS, pick, q80, requireSession, todayUtc, Truncated, type SearchParams,
} from '../../components/ui.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Payments · TallyMed' };

export default async function PaymentsPage({ searchParams }: { searchParams: SearchParams }) {
  const { ctx, actor, csrf } = await requireSession();
  const p = await flatWithFlash(searchParams, '/payments');
  const [members, providers, bills, cash] = await Promise.all([
    pickParties(ctx.pool, actor, 'members', { archived: true, q: q80(p.memberQ), currentId: p.memberId }), pickParties(ctx.pool, actor, 'providers', { archived: true, q: q80(p.providerQ), currentId: p.providerId }),
    pickPayableBills(ctx.pool, actor, { q: q80(p.billQ), currentId: p.billId }), cashSummary(ctx.pool, actor),
  ]);
  const filters = Object.fromEntries(['q', 'memberId', 'providerId', 'from', 'to', 'unapplied'].filter((k) => p[k]).map((k) => [k, p[k]!]));
  const { data, invalid } = await load(() => listPayments(ctx.pool, actor, { ...filters, cursor: p.cursor }), { items: [], nextCursor: null });
  const opt = (r: typeof members) => r.items.map((i) => ({ id: i.id, name: i.name, archived: i.archivedAt !== null }));
  const open = !!p.error || p.add === '1' || !!p.billId;
  return <main id="main" className="wide">
    <div className="page-head">
      <h1>Payments</h1>
      <AddDialog label="Record payment" title="Record a payment" open={open} keep={pick(p, ['q', 'memberId', 'providerId', 'from', 'to', 'unapplied', 'billId', 'billQ', 'memberQ', 'providerQ'])}>
        {p.error && <Banner code={p.error} />}
        {(bills.truncated || p.billQ) && <>
          {bills.truncated && <Truncated what="bills" />}
          <NarrowForm inDialog fields={[{ name: 'billQ', label: 'Find a bill to apply to' }]} values={p} />
        </>}
        <form method="post" action="/api/expenses/payments/create">
          <Csrf token={csrf} /><input type="hidden" name="idempotencyKey" value={newKey()} />
          <p className="muted">Record cash the household actually paid. A payment is a posted event: it cannot be edited, only corrected with linked entries.</p>
          <label htmlFor="paidOn">Date paid</label><input id="paidOn" name="paidOn" type="date" required defaultValue={p.paidOn ?? todayUtc()} />
          <label htmlFor="amount">Amount (USD)</label><input id="amount" name="amount" inputMode="decimal" required pattern="\d{1,12}(\.\d{1,2})?" placeholder="125.00" defaultValue={p.amount} />
          <label htmlFor="method">Method</label><select id="method" name="method" defaultValue={p.method ?? 'card'}>{PAYMENT_METHODS.map((m) => <option key={m} value={m}>{label(m)}</option>)}</select>
          <label htmlFor="reference">Reference (optional)</label><input id="reference" name="reference" maxLength={80} defaultValue={p.reference} />
          <label htmlFor="note">Note (optional)</label><input id="note" name="note" maxLength={500} defaultValue={p.note} />
          <label htmlFor="billId">Apply to a bill (optional)</label>
          <select id="billId" name="billId" defaultValue={p.billId ?? ''}><Options items={bills.items.map((b) => ({ id: b.id, name: `${b.label} · ${b.statementDate} · open ${formatCents(b.openBalanceCents)}` }))} blank="Leave unapplied for now" /></select>
          <label htmlFor="allocateAmount">Amount to apply (blank applies the whole payment)</label><input id="allocateAmount" name="allocateAmount" inputMode="decimal" pattern="\d{1,12}(\.\d{1,2})?" defaultValue={p.allocateAmount} />
          <button type="submit">Record payment</button>
          <p className="muted">Only bills with confirmed amounts and an open balance are listed. You can apply the rest to other bills from the payment page.</p>
        </form>
      </AddDialog>
    </div>
    <Banner invalid={invalid} />
    <section className="metrics" aria-label="Cash">
      <Link href="/payments"><div className="card"><span>Net cash paid</span><strong><Money cents={cash.netCashCents} /></strong><span className="muted">{cash.paymentCount} payments, after refunds</span></div></Link>
      <Link href="/payments?unapplied=yes"><div className="card"><span>Unapplied cash</span><strong><Money cents={cash.unappliedCents} /></strong><span className="muted">Paid but not applied to a bill yet</span></div></Link>
    </section>
    <form method="get" className="card row" role="search">
      <div><label htmlFor="q">Search reference or note</label><input id="q" name="q" defaultValue={p.q} /></div>
      <div><label htmlFor="memberId">Family member</label><select id="memberId" name="memberId" defaultValue={p.memberId ?? ''}><Options items={opt(members)} blank="Everyone" /></select></div>
      <div><label htmlFor="providerId">Provider</label><select id="providerId" name="providerId" defaultValue={p.providerId ?? ''}><Options items={opt(providers)} blank="All providers" /></select></div>
      <div><label htmlFor="from">Paid from</label><input id="from" name="from" type="date" defaultValue={p.from} /></div>
      <div><label htmlFor="to">Paid to</label><input id="to" name="to" type="date" defaultValue={p.to} /></div>
      <div><label className="checkbox"><input type="checkbox" name="unapplied" value="yes" defaultChecked={p.unapplied === 'yes'} /> Has unapplied cash</label></div>
      <div><button type="submit">Filter</button> <Link href="/payments">Clear</Link></div>
    </form>
    {data.items.length === 0 ? <Empty>No payments match.</Empty> : <table className="stack">
      <thead><tr><th>Paid</th><th>Method and reference</th><th className="num">Amount</th><th className="num">Applied to bills</th><th className="num">Refunded</th><th className="num">Unapplied</th></tr></thead>
      <tbody>{data.items.map((x) => <tr key={x.id}>
        <td data-label="Paid"><Link href={`/payments/${x.id}`}>{x.paidOn}</Link> {x.voided && <span className="pill warn">Voided</span>}</td>
        <td data-label="Method and reference">{label(x.method)} {x.reference ?? ''}</td>
        <td data-label="Amount" className="num"><Money cents={x.amountCents} /></td><td data-label="Applied to bills" className="num"><Money cents={x.appliedCents} /></td>
        <td data-label="Refunded" className="num"><Money cents={x.refundedCents} /></td><td data-label="Unapplied" className="num"><Money cents={x.unappliedCents} /></td>
      </tr>)}</tbody>
    </table>}
    <Pager base="/payments" params={filters} next={data.nextCursor} />
    {(members.truncated || providers.truncated || p.memberQ || p.providerQ) && <>
      {members.truncated && <Truncated what="family members" />}{providers.truncated && <Truncated what="providers" />}
      <NarrowForm fields={[{ name: 'memberQ', label: 'Find a family member' }, { name: 'providerQ', label: 'Find a provider' }]} values={p} />
    </>}
  </main>;
}
