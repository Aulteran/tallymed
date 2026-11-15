import Link from 'next/link';
import { listHsaAccounts } from '../../../server/services/hsa-accounts.ts';
import { AddDialog } from '../../components/AddDialog.tsx';
import { Banner, Csrf, Empty, flatWithFlash, load, Money, pick, requireSession, Truncated, type SearchParams } from '../../components/ui.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HSA accounts · TallyMed' };

export default async function HsaAccountsPage({ searchParams }: { searchParams: SearchParams }) {
  const { ctx, actor, csrf } = await requireSession();
  const p = await flatWithFlash(searchParams, '/hsa-accounts');
  const { data, invalid } = await load(() => listHsaAccounts(ctx.pool, actor, { archived: p.archived === 'yes' }), { items: [], truncated: false });
  const keep = pick(p, ['archived']);
  const open = !!p.error || p.add === '1';
  return <main id="main">
    <div className="page-head">
      <h1>HSA accounts</h1>
      <AddDialog label="Add HSA account" open={open} keep={keep}>
        {p.error && <Banner code={p.error} />}
        <form method="post" action="/api/expenses/hsa-accounts/create">
          <Csrf token={csrf} />
          <p className="muted">Name the HSA accounts your household has, then link an HSA card to one on <Link href="/payment-methods">Payment methods</Link>. A payment recorded with that card is paid directly from the HSA, so there is nothing to claim. Enter only the last four digits, never a full account or card number.</p>
          <label htmlFor="name">Name</label><input id="name" name="name" required maxLength={60} placeholder="Family HSA" defaultValue={p.name} />
          <label htmlFor="administrator">Administrator (optional)</label><input id="administrator" name="administrator" maxLength={80} placeholder="Example HSA Bank" defaultValue={p.administrator} />
          <label htmlFor="lastFour">Last four digits (optional)</label><input id="lastFour" name="lastFour" inputMode="numeric" pattern="\d{4}" maxLength={4} placeholder="0000" defaultValue={p.lastFour} />
          <button type="submit">Add HSA account</button>
        </form>
      </AddDialog>
    </div>
    <Banner invalid={invalid} />
    <form method="get" className="card row" role="search">
      <div><label className="checkbox"><input type="checkbox" name="archived" value="yes" defaultChecked={p.archived === 'yes'} /> Include archived</label></div>
      <div><button type="submit">Show</button></div>
    </form>
    {data.truncated && <Truncated what="HSA accounts" />}
    {data.items.length === 0 ? <Empty>No HSA accounts yet. Add one, then link an HSA card to it to record payments paid directly from the HSA.</Empty> : <table className="stack">
      <thead><tr><th>HSA account</th><th>Administrator</th><th className="num">Paid directly</th><th className="num">Net cash</th><th>Status</th></tr></thead>
      <tbody>{data.items.map((a) => <tr key={a.id}>
        <td data-label="HSA account"><Link href={`/hsa-accounts/${a.id}`}>{a.name}{a.lastFour ? ` ••${a.lastFour}` : ''}</Link></td>
        <td data-label="Administrator">{a.administrator}</td>
        <td data-label="Paid directly" className="num">{a.paymentCount}</td>
        <td data-label="Net cash" className="num"><Money cents={a.netCashCents} /></td>
        <td data-label="Status">{a.archivedAt ? <span className="pill warn">Archived</span> : <span className="pill">Active</span>}</td>
      </tr>)}</tbody>
    </table>}
    <p className="muted">Net cash follows the cash summary: refunds are subtracted and voided payments count zero. Eligibility, claims and reimbursements are tracked on the <Link href="/hsa">HSA</Link> page.</p>
  </main>;
}
