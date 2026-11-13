import Link from 'next/link';
import { listMembers, listProviders, listVisits } from '../../../../server/services/expenses.ts';
import { AMOUNT_SOURCES, Banner, Csrf, flat, label, newKey, Options, requireSession, type SearchParams } from '../../../components/ui.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Enter a bill · TallyMed' };

export default async function NewBill({ searchParams }: { searchParams: SearchParams }) {
  const { ctx, actor, csrf } = await requireSession();
  const p = await flat(searchParams);
  const [members, providers, visits] = await Promise.all([
    listMembers(ctx.pool, actor, { limit: 100 }), listProviders(ctx.pool, actor, { limit: 100 }),
    listVisits(ctx.pool, actor, { ...(p.memberId ? { memberId: p.memberId } : {}), limit: 100 }).catch(() => ({ items: [] })),
  ]);
  return <main>
    <h1>Enter a bill</h1>
    <Banner code={p.error} />
    <form className="card" method="post" action="/api/expenses/bills/create">
      <Csrf token={csrf} /><input type="hidden" name="idempotencyKey" value={newKey()} />
      <label htmlFor="memberId">Family member</label>
      <select id="memberId" name="memberId" required defaultValue={p.memberId ?? ''}><Options items={members.items.map((m) => ({ id: m.id, name: m.name }))} blank="Choose…" /></select>
      <label htmlFor="providerId">Billing provider</label>
      <select id="providerId" name="providerId" required defaultValue={p.providerId ?? ''}><Options items={providers.items.map((m) => ({ id: m.id, name: m.name }))} blank="Choose…" /></select>
      <label htmlFor="visitId">Visit (optional, leave blank if the visit is not recorded yet)</label>
      <select id="visitId" name="visitId" defaultValue={p.visitId ?? ''}><Options items={visits.items.map((v) => ({ id: v.id, name: `${v.serviceDate} · ${v.memberName} · ${v.providerName}` }))} blank="Awaiting visit assignment" /></select>
      <label htmlFor="providerReference">Provider reference or account number</label>
      <input id="providerReference" name="providerReference" maxLength={80} defaultValue={p.providerReference} />
      <label htmlFor="statementDate">Statement date</label><input id="statementDate" name="statementDate" type="date" required defaultValue={p.statementDate} />
      <label htmlFor="dueDate">Due date (optional)</label><input id="dueDate" name="dueDate" type="date" defaultValue={p.dueDate} />
      <label htmlFor="originalAmount">Billed amount (USD)</label>
      <input id="originalAmount" name="originalAmount" inputMode="decimal" required pattern="\d{1,12}(\.\d{1,2})?" placeholder="0.00" defaultValue={p.originalAmount} />
      <label htmlFor="responsibilityAmount">Household responsibility (USD, blank means the full billed amount)</label>
      <input id="responsibilityAmount" name="responsibilityAmount" inputMode="decimal" pattern="\d{1,12}(\.\d{1,2})?" placeholder="same as billed" defaultValue={p.responsibilityAmount} />
      <label htmlFor="amountStatus">Are these amounts confirmed?</label>
      <select id="amountStatus" name="amountStatus" defaultValue={p.amountStatus ?? 'confirmed'}><option value="confirmed">Confirmed</option><option value="estimate">Estimate</option></select>
      <label htmlFor="amountSource">Where the amounts came from</label>
      <select id="amountSource" name="amountSource" defaultValue={p.amountSource ?? 'statement'}>{AMOUNT_SOURCES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select>
      <label htmlFor="sourceNote">Source note (optional)</label><input id="sourceNote" name="sourceNote" maxLength={500} defaultValue={p.sourceNote} />
      <label htmlFor="notes">Notes</label><textarea id="notes" name="notes" maxLength={2000} defaultValue={p.notes} />
      {p.error === 'duplicate_warning' && <label className="checkbox"><input type="checkbox" name="confirmDuplicate" value="yes" /> Save anyway. I checked the possible duplicate. <Link href={`/bills?providerId=${p.providerId ?? ''}`}>See this provider's bills</Link></label>}
      <button type="submit">Save bill</button>
    </form>
  </main>;
}
