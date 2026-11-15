import Link from 'next/link';
import { pickHsaAccounts } from '../../../server/services/hsa-accounts.ts';
import { listPaymentMethods } from '../../../server/services/payment-methods.ts';
import { AddDialog } from '../../components/AddDialog.tsx';
import { Banner, Csrf, Empty, flatWithFlash, load, Money, METHOD_KINDS, methodKindLabel, methodName, Options, pick, requireSession, Truncated, type SearchParams } from '../../components/ui.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Payment methods · TallyMed' };

export default async function PaymentMethodsPage({ searchParams }: { searchParams: SearchParams }) {
  const { ctx, actor, csrf } = await requireSession();
  const p = await flatWithFlash(searchParams, '/payment-methods');
  const { data, invalid } = await load(() => listPaymentMethods(ctx.pool, actor, { archived: p.archived === 'yes' }),
    { items: [], truncated: false, unassigned: { methodId: null, paymentCount: 0, netCashCents: '0' } });
  const accounts = await pickHsaAccounts(ctx.pool, actor, p.hsaAccountId);
  const keep = pick(p, ['archived']);
  const open = !!p.error || p.add === '1';
  return <main id="main">
    <div className="page-head">
      <h1>Payment methods</h1>
      <AddDialog label="Add payment method" open={open} keep={keep}>
        {p.error && <Banner code={p.error} />}
        <form method="post" action="/api/expenses/payment-methods/create">
          <Csrf token={csrf} />
          <p className="muted">Name the cards and accounts you pay bills with, then choose one when you record a payment. Enter only the last four digits, never a full card or account number. Each active nickname must be unique.</p>
          <label htmlFor="nickname">Nickname</label><input id="nickname" name="nickname" required maxLength={60} placeholder="Family Visa" defaultValue={p.nickname} />
          <label htmlFor="kind">Type</label><select id="kind" name="kind" defaultValue={p.kind ?? 'credit_card'}>{METHOD_KINDS.map((k) => <option key={k} value={k}>{methodKindLabel(k)}</option>)}</select>
          <label htmlFor="lastFour">Last four digits (optional)</label><input id="lastFour" name="lastFour" inputMode="numeric" pattern="\d{4}" maxLength={4} placeholder="0000" defaultValue={p.lastFour} />
          <label htmlFor="hsaAccountId">HSA account (HSA/FSA cards only)</label>
          <select id="hsaAccountId" name="hsaAccountId" defaultValue={p.hsaAccountId ?? ''}><Options items={accounts.items.map((a) => ({ id: a.id, name: a.name, archived: a.archivedAt !== null }))} blank="Not linked" /></select>
          <p className="muted">Link an HSA/FSA card to an HSA account and a payment recorded with it is paid directly from that HSA: nothing to claim. Without a link the card is only a label. <Link href="/hsa?add=1">Add an HSA account</Link></p>
          <button type="submit">Add payment method</button>
        </form>
      </AddDialog>
    </div>
    <Banner invalid={invalid} />
    <form method="get" className="card row" role="search">
      <div><label className="checkbox"><input type="checkbox" name="archived" value="yes" defaultChecked={p.archived === 'yes'} /> Include archived</label></div>
      <div><button type="submit">Show</button></div>
    </form>
    {data.truncated && <Truncated what="payment methods" />}
    {data.items.length === 0 ? <Empty>No payment methods yet. Add one to record which card or account paid a bill.</Empty> : <table className="stack">
      <thead><tr><th>Payment method</th><th>Type</th><th>HSA account</th><th className="num">Payments</th><th className="num">Net cash paid</th><th>Status</th></tr></thead>
      <tbody>{data.items.map((m) => <tr key={m.id}>
        <td data-label="Payment method"><Link href={`/payment-methods/${m.id}`}>{methodName(m.nickname, m.lastFour)}</Link></td>
        <td data-label="Type">{methodKindLabel(m.kind)}</td>
        <td data-label="HSA account">{m.hsaAccountName ?? ''}</td>
        <td data-label="Payments" className="num"><Link href={`/payments?paidWith=${m.id}`}>{m.paymentCount}</Link></td>
        <td data-label="Net cash paid" className="num"><Money cents={m.netCashCents} /></td>
        <td data-label="Status">{m.archivedAt ? <span className="pill warn">Archived</span> : <span className="pill">Active</span>}</td>
      </tr>)}</tbody>
    </table>}
    <p className="muted">Without a method recorded: <Link href="/payments?paidWith=none">{data.unassigned.paymentCount} payments</Link>, <Money cents={data.unassigned.netCashCents} /> net cash. Totals follow the cash summary: refunds are subtracted and voided payments count zero.</p>
  </main>;
}
