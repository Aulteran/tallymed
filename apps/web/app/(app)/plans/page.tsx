import Link from 'next/link';
import { formatCents } from '../../../server/money.ts';
import { pickParties } from '../../../server/services/expenses.ts';
import { pickPayableBills } from '../../../server/services/payments.ts';
import { listInstallmentQueue, listPlans, previewNewPlan } from '../../../server/services/plans.ts';
import { AddDialog } from '../../components/AddDialog.tsx';
import { PlanPreviewPanel, PreviewButton, SaveButton, tryPreview } from '../../components/PlanPreview.tsx';
import { PlanScheduleFields } from '../../components/PlanScheduleFields.tsx';
import {
  Banner, Empty, flatWithFlash, label, load, Money, NarrowForm, newKey, Options, Pager, pick, q80, requireSession, StatePill, todayUtc, Truncated, type SearchParams,
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
  const byProvider = [...Map.groupBy(bills.items, (b) => b.providerName)].sort(([a], [b]) => a.localeCompare(b));
  const open = !!p.error || p.add === '1' || p.preview === 'create';
  const preview = p.preview === 'create' ? await tryPreview(() => previewNewPlan(ctx.pool, actor, p)) : null;
  return <main id="main" className="wide">
    <div className="page-head">
      <h1>Payment Plans</h1>
      <AddDialog label="Create plan" title="Create a payment plan" open={open} keep={pick(p, ['q', 'status', 'providerId', 'state', 'billId', 'providerQ', 'billQ'])}>
        {p.error && <Banner code={p.error} />}
        {(bills.truncated || p.billQ) && <>
          {bills.truncated && <Truncated what="bills" />}
          <NarrowForm inDialog fields={[{ name: 'billQ', label: 'Find a bill' }]} values={p} />
        </>}
        <form method="post" action="/api/expenses/plans/create">
          <input type="hidden" name="idempotencyKey" value={newKey()} />
          <p className="muted">A plan is an obligation: its installments schedule amounts to pay, and creating one moves no cash. Record the actual payments on the Payments page, then match them to installments.</p>
          <label htmlFor="name">Plan name</label><input id="name" name="name" required maxLength={120} defaultValue={p.name} />
          <fieldset>
            <legend>Bills covered by the plan</legend>
            {bills.items.length === 0 ? <p className="muted">No bills with an open balance. Enter and confirm a bill first.</p> : byProvider.map(([providerName, items]) => <div key={providerName} role="group" aria-label={providerName}>
              <h3>{providerName}</h3>
              {items.map((b) => <label key={b.id} className="checkbox">
                <input id={`bill_${b.id}`} type="checkbox" name={`bill_${b.id}`} value="on" defaultChecked={p.billId === b.id} /> {b.label} · {b.statementDate} · open {formatCents(b.openBalanceCents)}</label>)}
            </div>)}
            <p className="muted">Tick every bill the plan covers, from one provider or several (a hospital often bills one visit under different names). All of them must have confirmed amounts. The plan is listed under each provider it covers.</p>
          </fieldset>
          <label htmlFor="startedOn">Plan start date (optional)</label><input id="startedOn" name="startedOn" type="date" max={asOf} defaultValue={p.startedOn} />
          <p className="muted">When the plan began, if that was before today. Leave empty for today. It is a label only; the real time of entry is kept in the history.</p>
          <label className="checkbox"><input id="matchExisting" type="checkbox" name="matchExisting" value="on" defaultChecked={p.error || p.preview ? p.matchExisting !== undefined : true} /> Match payments made since the start date</label>
          <p className="muted">Payments made on or after the start date and already applied to the ticked bills are matched to the earliest installments, oldest payment first, so those installments show as paid. This only links to cash already recorded; it adds no cash and changes no bill balance. The first due date can be in the past.</p>
          <PlanScheduleFields idPrefix="new" defaults={{ inputMode: p.inputMode, totalAmount: p.totalAmount, installmentCount: p.installmentCount, installmentAmount: p.installmentAmount, remainder: p.remainder, firstDueDate: p.firstDueDate, cadence: p.cadence }} />
          {preview && <PlanPreviewPanel result={preview} />}
          <div className="actions"><SaveButton csrf={csrf}>Create plan</SaveButton><PreviewButton action="/plans" kind="create" /></div>
          <p className="muted">Installments always add up exactly to the total. A plan is saved even if its total differs from the bills' open balance; the difference is shown on the plan.</p>
        </form>
      </AddDialog>
    </div>
    <Banner invalid={invalid} />
    <div className="card"><h2>Installments due</h2>
      <p className="tabs"><Link href="/plans?state=overdue">Overdue</Link><Link href="/plans?state=upcoming">Upcoming</Link><Link href="/plans">All unpaid</Link></p>
      {queue.data.items.length === 0 ? <p>Nothing is due in this view.</p> : <table className="stack">
        <thead><tr><th>Due</th><th>Plan</th><th>Providers</th><th>Family</th><th className="num">Installment</th><th className="num">Still owed</th><th>Status</th></tr></thead>
        <tbody>{queue.data.items.map((i) => <tr key={i.installmentId}>
          <td data-label="Due">{i.dueDate}</td><td data-label="Plan"><Link href={`/plans/${i.planId}`}>{i.planName}</Link> #{i.seq}</td><td data-label="Providers" title={i.providerNames.join(', ')}>{i.payee}</td><td data-label="Family">{i.memberNames}</td>
          <td data-label="Installment" className="num"><Money cents={i.amountCents} /></td><td data-label="Still owed" className="num"><Money cents={i.unpaidCents} /></td>
          <td data-label="Status"><StatePill state={i.state} overdue={i.overdue} /></td>
        </tr>)}</tbody>
      </table>}
      <p className="muted">Late means the due date has passed and part of the installment is still unmatched. Dates use UTC.</p>
    </div>
    <form method="get" className="card row" role="search">
      <div><label htmlFor="q">Search plans</label><input id="q" name="q" defaultValue={p.q} /></div>
      <div><label htmlFor="providerId">Provider</label><select id="providerId" name="providerId" defaultValue={p.providerId ?? ''}><Options items={providers.items.map((x) => ({ id: x.id, name: x.name }))} blank="Any" /></select></div>
      <div><label htmlFor="status">Status</label><select id="status" name="status" defaultValue={p.status ?? ''}><option value="">All</option><option value="active">Active</option><option value="cancelled">Cancelled</option></select></div>
      <div><button type="submit">Filter</button> <Link href="/plans">Clear</Link></div>
    </form>
    {data.items.length === 0 ? <Empty>No payment plans yet.</Empty> : <table className="stack">
      <thead><tr><th>Plan</th><th>Providers</th><th className="num">Total</th><th className="num">Matched</th><th>Installments</th><th>Next due</th><th>Status</th></tr></thead>
      <tbody>{data.items.map((x) => <tr key={x.id}>
        <td data-label="Plan"><Link href={`/plans/${x.id}`}>{x.name}</Link></td><td data-label="Providers" title={x.providerNames.join(', ')}>{x.payee}</td>
        <td data-label="Total" className="num"><Money cents={x.totalCents} /></td><td data-label="Matched" className="num"><Money cents={x.matchedCents} /></td>
        <td data-label="Installments">{x.installmentCount} · {label(x.cadence)}</td><td data-label="Next due">{x.nextDueDate ?? 'None'} {x.overdueCount > 0 && x.status === 'active' && <span className="pill warn">{x.overdueCount} overdue</span>}</td>
        <td data-label="Status">{x.status === 'cancelled' ? <span className="pill warn">Cancelled</span> : <span className="pill">Active</span>}</td>
      </tr>)}</tbody>
    </table>}
    <Pager base="/plans" params={filters} next={data.nextCursor} />
  </main>;
}
