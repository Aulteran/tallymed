import Link from 'next/link';
import { getPaymentMethod } from '../../../../server/services/payment-methods.ts';
import { Banner, Csrf, dateOf, flat, label, load, METHOD_KINDS, methodName, requireSession, type SearchParams } from '../../../components/ui.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Payment method · TallyMed' };

export default async function PaymentMethodPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { ctx, actor, csrf } = await requireSession();
  const { id } = await params;
  const q = await flat(searchParams);
  const { data: m } = await load(() => getPaymentMethod(ctx.pool, actor, id), null);
  return <main id="main">
    <p className="crumb"><Link href="/payment-methods">← Payment methods</Link></p>
    <h1>{methodName(m!.nickname, m!.lastFour)} {m!.archivedAt && <span className="pill warn">Archived</span>}</h1>
    <Banner code={q.error} />
    <form className="card" method="post" action="/api/expenses/payment-methods/update">
      <Csrf token={csrf} /><input type="hidden" name="id" value={m!.id} /><input type="hidden" name="version" value={m!.version} />
      <label htmlFor="nickname">Nickname</label><input id="nickname" name="nickname" required maxLength={60} defaultValue={m!.nickname} />
      <label htmlFor="kind">Type</label><select id="kind" name="kind" defaultValue={m!.kind}>{METHOD_KINDS.map((k) => <option key={k} value={k}>{label(k)}</option>)}</select>
      <label htmlFor="lastFour">Last four digits (optional)</label><input id="lastFour" name="lastFour" inputMode="numeric" pattern="\d{4}" maxLength={4} defaultValue={m!.lastFour ?? ''} />
      <button type="submit">Save changes</button> <span className="muted">Updated {dateOf(m!.updatedAt)}. Payments show the current nickname. Only the last four digits are kept, never a full number.</span>
    </form>
    <form className="card" method="post" action="/api/expenses/payment-methods/archive">
      <Csrf token={csrf} /><input type="hidden" name="id" value={m!.id} /><input type="hidden" name="version" value={m!.version} />
      {m!.archivedAt
        ? <><p>This payment method is archived. Payments already paid with it keep the link. Restore it to choose it for new payments.</p><button type="submit" className="secondary">Restore payment method</button></>
        : <><p>Archiving hides this payment method from new payments. Payments already paid with it keep the link.</p>
          <input type="hidden" name="archived" value="yes" /><button type="submit" className="secondary">Archive payment method</button></>}
    </form>
    <p><Link href={`/payments?paidWith=${m!.id}`}>Payments paid with this method</Link></p>
  </main>;
}
