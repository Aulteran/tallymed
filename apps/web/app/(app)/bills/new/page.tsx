import Link from 'next/link';
import { pickParties, pickVisits } from '../../../../server/services/expenses.ts';
import { AMOUNT_SOURCES, Banner, Csrf, flatWithFlash, label, NarrowForm, newKey, Options, q80, requireSession, Truncated, type SearchParams } from '../../../components/ui.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Enter a bill · TallyMed' };

export default async function NewBill({ searchParams }: { searchParams: SearchParams }) {
  const { ctx, actor, csrf } = await requireSession();
  const p = await flatWithFlash(searchParams, '/bills/new');
  const [members, providers, visits] = await Promise.all([
    pickParties(ctx.pool, actor, 'members', { q: q80(p.memberQ), currentId: p.memberId }),
    pickParties(ctx.pool, actor, 'providers', { q: q80(p.providerQ), currentId: p.providerId }),
    pickVisits(ctx.pool, actor, { memberId: p.memberId, q: q80(p.visitQ), currentId: p.visitId }).catch(() => ({ items: [], truncated: false })),
  ]);
  return <main>
    <h1>Enter a bill</h1>
    <Banner code={p.error} />
    {(members.truncated || providers.truncated || visits.truncated || p.memberQ || p.providerQ || p.visitQ) && <>
      {members.truncated && <Truncated what="family members" />}{providers.truncated && <Truncated what="providers" />}{visits.truncated && <Truncated what="visits" />}
      <NarrowForm fields={[{ name: 'memberQ', label: 'Find a family member' }, { name: 'providerQ', label: 'Find a provider' }, { name: 'visitQ', label: 'Find a visit' }]} values={p} />
    </>}
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
