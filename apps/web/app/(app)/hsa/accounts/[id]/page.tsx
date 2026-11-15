import Link from 'next/link';
import { getHsaAccount } from '../../../../../server/services/hsa-accounts.ts';
import { Banner, Csrf, dateOf, flat, load, requireSession, type SearchParams } from '../../../../components/ui.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'HSA account · TallyMed' };

export default async function HsaAccountPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { ctx, actor, csrf } = await requireSession();
  const { id } = await params;
  const q = await flat(searchParams);
  const { data: a } = await load(() => getHsaAccount(ctx.pool, actor, id), null);
  return <main id="main">
    <p className="crumb"><Link href="/hsa">← HSA</Link></p>
    <h1>{a!.name}{a!.lastFour ? ` ••${a!.lastFour}` : ''} {a!.archivedAt && <span className="pill warn">Archived</span>}</h1>
    <Banner code={q.error} />
    <form className="card" method="post" action="/api/expenses/hsa-accounts/update">
      <Csrf token={csrf} /><input type="hidden" name="id" value={a!.id} /><input type="hidden" name="version" value={a!.version} />
      <label htmlFor="name">Name</label><input id="name" name="name" required maxLength={60} defaultValue={a!.name} />
      <label htmlFor="administrator">Administrator (optional)</label><input id="administrator" name="administrator" maxLength={80} defaultValue={a!.administrator} />
      <label htmlFor="lastFour">Last four digits (optional)</label><input id="lastFour" name="lastFour" inputMode="numeric" pattern="\d{4}" maxLength={4} defaultValue={a!.lastFour ?? ''} />
      <button type="submit">Save changes</button> <span className="muted">Updated {dateOf(a!.updatedAt)}. Only the last four digits are kept, never a full number.</span>
    </form>
    <form className="card" method="post" action="/api/expenses/hsa-accounts/archive">
      <Csrf token={csrf} /><input type="hidden" name="id" value={a!.id} /><input type="hidden" name="version" value={a!.version} />
      {a!.archivedAt
        ? <><p>This HSA account is archived. Payments already paid directly from it keep the link. Restore it to record new direct payments with its cards.</p><button type="submit" className="secondary">Restore HSA account</button></>
        : <><p>Archiving blocks new direct payments from this account (a payment recorded with one of its cards is refused). Payments already paid from it keep the link.</p>
          <input type="hidden" name="archived" value="yes" /><button type="submit" className="secondary">Archive HSA account</button></>}
    </form>
    <p><Link href="/payment-methods">Payment methods</Link> · <Link href="/hsa">HSA</Link></p>
  </main>;
}
