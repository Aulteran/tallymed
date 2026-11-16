import Link from 'next/link';
import { formatCents } from '../../../server/money.ts';
import { pickParties } from '../../../server/services/expenses.ts';
import { pickPayableBills } from '../../../server/services/payments.ts';
import { listFormState, withInstallmentList, withInstRowValues } from '../../../server/plan-installments.ts';
import { billIdsOfPreview, hasPreviewValues, PREVIEW_KEEP, withBillTicks } from '../../../server/plan-preview-form.ts';
import { listInstallmentQueue, listPlans, previewNewPlan, previewPlanInProgress } from '../../../server/services/plans.ts';
import { AddDialog } from '../../components/AddDialog.tsx';
import { PlanPreviewPanel, PreviewButton, ProgressPreviewPanel, TRIMMED_LIST_PREVIEW, tryPreview } from '../../components/PlanPreview.tsx';
import { PlanScheduleFields } from '../../components/PlanScheduleFields.tsx';
import {
  Banner, CADENCES, Csrf, Empty, flatWithFlash, label, load, Money, NarrowForm, newKey, Options, Pager, pick, q80, requireSession, StatePill, todayUtc, Truncated, type SearchParams,
} from '../../components/ui.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Payment Plans · TallyMed' };

export default async function PlansPage({ searchParams }: { searchParams: SearchParams }) {
  const { ctx, actor, csrf } = await requireSession();
  const p = withInstRowValues(withBillTicks(await flatWithFlash(searchParams, '/plans')));
  // Two forms share this page. The values a Preview or an error kept belong to the one they came from, so the other starts empty.
  const fromProgress = p.dialog === 'progress' || p.preview === 'progress';
  const formKeys = new Set([...PREVIEW_KEEP, 'flashTrimmed']);
  const blank = Object.fromEntries(Object.entries(p).filter(([k]) => !formKeys.has(k) && !k.startsWith('inst.') && !k.startsWith('bill_')));
  const c = fromProgress ? blank : p;
  const pv = fromProgress ? p : blank;
  // Bills ticked before a Preview stay ticked (they come back from the flash cookie, not the address).
  const ticked = new Set(billIdsOfPreview(c));
  const tickedProgress = new Set(billIdsOfPreview(pv));
  const asOf = todayUtc();
  const [providers, bills] = await Promise.all([
    pickParties(ctx.pool, actor, 'providers', { q: q80(p.providerQ), currentId: p.providerId }), pickPayableBills(ctx.pool, actor, { q: q80(p.billQ), currentId: p.billId }),
  ]);
  const filters = Object.fromEntries(['q', 'status', 'providerId'].filter((k) => p[k]).map((k) => [k, p[k]!]));
  const { data, invalid } = await load(() => listPlans(ctx.pool, actor, { ...filters, cursor: p.cursor }, asOf), { items: [], nextCursor: null });
  const queue = await load(() => listInstallmentQueue(ctx.pool, actor, { state: p.state, asOf, limit: 25 }), { items: [], nextCursor: null });
  const byProvider = [...Map.groupBy(bills.items, (b) => b.providerName)].sort(([a], [b]) => a.localeCompare(b));
  const open = (!!p.error && !fromProgress) || p.add === '1' || p.preview === 'create';
  const progressOpen = (!!p.error && fromProgress) || p.add === 'progress' || p.preview === 'progress';
  const preview = p.preview === 'create' && hasPreviewValues(p) ? (p.flashTrimmed ? TRIMMED_LIST_PREVIEW : await tryPreview(() => previewNewPlan(ctx.pool, actor, withInstallmentList(p)))) : null;
  const progressPreview = p.preview === 'progress' && hasPreviewValues(p) ? (p.flashTrimmed ? TRIMMED_LIST_PREVIEW : await tryPreview(() => previewPlanInProgress(ctx.pool, actor, withInstallmentList(p)), true)) : null;
  const keepFilters = pick(p, ['q', 'status', 'providerId', 'state', 'billId', 'providerQ', 'billQ']);
  return <main id="main" className="wide">
    <div className="page-head">
      <h1>Payment Plans</h1>
      <AddDialog label="Create plan" title="Create a payment plan" open={open} keep={keepFilters}>
        {open && p.error && <Banner code={p.error} />}
        {(bills.truncated || p.billQ) && <>
          {bills.truncated && <Truncated what="bills" />}
          <NarrowForm inDialog fields={[{ name: 'billQ', label: 'Find a bill' }]} values={p} />
        </>}
        <form method="post" action="/api/expenses/plans/create">
          <Csrf token={csrf} /><input type="hidden" name="idempotencyKey" value={newKey()} />
          <p className="muted">A plan is an obligation: its installments schedule amounts to pay, and creating one moves no cash. Record the actual payments on the Payments page, then match them to installments.</p>
          <label htmlFor="name">Plan name</label><input id="name" name="name" required maxLength={120} defaultValue={c.name} />
          <fieldset>
            <legend>Bills covered by the plan</legend>
            {bills.items.length === 0 ? <p className="muted">No bills with an open balance. Enter and confirm a bill first.</p> : byProvider.map(([providerName, items]) => <div key={providerName} role="group" aria-label={providerName}>
              <h3>{providerName}</h3>
              {items.map((b) => <label key={b.id} className="checkbox">
                <input id={`bill_${b.id}`} type="checkbox" name={`bill_${b.id}`} value="on" defaultChecked={p.billId === b.id || ticked.has(b.id)} /> {b.label} · {b.statementDate} · open {formatCents(b.openBalanceCents)}</label>)}
            </div>)}
            <p className="muted">Tick every bill the plan covers, from one provider or several (a hospital often bills one visit under different names). All of them must have confirmed amounts. The plan is listed under each provider it covers.</p>
          </fieldset>
          <label htmlFor="startedOn">Plan start date (optional)</label><input id="startedOn" name="startedOn" type="date" max={asOf} defaultValue={c.startedOn} />
          <p className="muted">When the plan began, if that was before today. Leave empty for today. It is a label only; the real time of entry is kept in the history.</p>
          <label className="checkbox"><input id="matchExisting" type="checkbox" name="matchExisting" value="on" defaultChecked={(p.error && !fromProgress) || p.preview === 'create' ? c.matchExisting !== undefined : true} /> Match payments made since the start date</label>
          <p className="muted">Payments made on or after the start date and already applied to the ticked bills are matched to the earliest installments, oldest payment first, so those installments show as paid. This only links to cash already recorded; it adds no cash and changes no bill balance. The first due date can be in the past.</p>
          <PlanScheduleFields idPrefix="new" defaults={{ inputMode: c.inputMode, totalAmount: c.totalAmount, installmentCount: c.installmentCount, installmentAmount: c.installmentAmount, remainder: c.remainder, firstDueDate: c.firstDueDate, cadence: c.cadence, ...listFormState(c) }} />
          {preview && <PlanPreviewPanel result={preview} />}
          <div className="actions"><button type="submit">Create plan</button><PreviewButton kind="create" /></div>
          <p className="muted">Installments always add up exactly to the total. A plan is saved even if its total differs from the bills' open balance; the difference is shown on the plan.</p>
        </form>
      </AddDialog>
      <AddDialog label="Add a plan already in progress" title="Add a plan that's already in progress" icon={null} secondary marker="progress" open={progressOpen} keep={keepFilters}>
        {progressOpen && p.error && <Banner code={p.error} />}
        {(bills.truncated || p.billQ) && <>
          {bills.truncated && <Truncated what="bills" />}
          <NarrowForm inDialog marker="progress" idPrefix="np" fields={[{ name: 'billQ', label: 'Find a bill' }]} values={p} />
        </>}
        <form method="post" action="/api/expenses/plans/create-in-progress">
          <Csrf token={csrf} /><input type="hidden" name="idempotencyKey" value={newKey()} /><input type="hidden" name="dialog" value="progress" />
          <p className="muted">For a plan that started months ago and may have been restructured since. Enter the original agreement, let your payments fill it, and say how it was restructured: it is all saved together, or not at all. This moves no cash; it only links to payments you already recorded.</p>
          <fieldset>
            <legend>The plan</legend>
            <label htmlFor="ip-name">Plan name</label><input id="ip-name" name="name" required maxLength={120} defaultValue={pv.name} />
            <fieldset>
              <legend>Bills covered by the plan</legend>
              {bills.items.length === 0 ? <p className="muted">No bills with an open balance. Enter and confirm a bill first.</p> : byProvider.map(([providerName, items]) => <div key={providerName} role="group" aria-label={providerName}>
                <h3>{providerName}</h3>
                {items.map((b) => <label key={b.id} className="checkbox">
                  <input id={`ip-bill_${b.id}`} type="checkbox" name={`bill_${b.id}`} value="on" defaultChecked={tickedProgress.has(b.id)} /> {b.label} · {b.statementDate} · open {formatCents(b.openBalanceCents)}</label>)}
              </div>)}
              <p className="muted">Tick every bill the plan covers. All of them must have confirmed amounts.</p>
            </fieldset>
          </fieldset>
          <fieldset>
            <legend>The original agreement</legend>
            <label htmlFor="ip-startedOn">Plan start date</label><input id="ip-startedOn" name="startedOn" type="date" required max={asOf} defaultValue={pv.startedOn} />
            <p className="muted">When the plan began. Payments made on or after this date can be matched. The first due date below can be in the past.</p>
            <PlanScheduleFields idPrefix="ip" defaults={{ inputMode: pv.inputMode, totalAmount: pv.totalAmount, installmentCount: pv.installmentCount, installmentAmount: pv.installmentAmount, remainder: pv.remainder, firstDueDate: pv.firstDueDate, cadence: pv.cadence, ...listFormState(pv) }} />
          </fieldset>
          <fieldset>
            <legend>Payments you've already made</legend>
            <label className="checkbox"><input id="ip-matchExisting" type="checkbox" name="matchExisting" value="on" defaultChecked={fromProgress && (p.error || p.preview) ? pv.matchExisting !== undefined : true} /> Match my payments to these bills since the start date</label>
            <p className="muted">Payments applied to the ticked bills on or after the start date fill the earliest installments of the original agreement, oldest payment first, so those installments show as paid.</p>
          </fieldset>
          <fieldset>
            <legend>Was the plan restructured?</legend>
            <label className="checkbox"><input id="ip-restructured-no" type="radio" name="restructured" value="no" defaultChecked={pv.restructured !== 'yes'} /> No, it still follows the original agreement</label>
            <label className="checkbox"><input id="ip-restructured-yes" type="radio" name="restructured" value="yes" defaultChecked={pv.restructured === 'yes'} /> Yes, the rest was scheduled again</label>
            <p className="muted">If yes, the installments that your payments fully paid stay exactly as they are. The total still to schedule is not typed: it is the original plan total minus those paid installments, and the preview shows it. The restart date cannot be before the last paid installment's due date. Ignored when "No" is chosen.</p>
            <label htmlFor="ip-restartOn">Restart date (first due date of the rest)</label><input id="ip-restartOn" name="restartOn" type="date" defaultValue={pv.restartOn} />
            <label htmlFor="ip-restartAmount">Amount per installment (USD)</label><input id="ip-restartAmount" name="restartAmount" inputMode="decimal" pattern="\d{1,12}(\.\d{1,2})?" defaultValue={pv.restartAmount} />
            <label htmlFor="ip-restartCadence">Cadence</label>
            <select id="ip-restartCadence" name="restartCadence" defaultValue={pv.restartCadence ?? 'monthly'}>{CADENCES.map((x) => <option key={x} value={x}>{label(x)}</option>)}</select>
            <p className="muted">The last restarted installment is smaller if the total does not divide evenly.</p>
          </fieldset>
          <fieldset>
            <legend>Reason</legend>
            <label htmlFor="ip-reason">Why the plan was restructured (needed when you answered Yes)</label><input id="ip-reason" name="reason" maxLength={500} defaultValue={pv.reason} />
            <p className="muted">Kept with the restructured schedule in the plan's history.</p>
          </fieldset>
          {progressPreview && <ProgressPreviewPanel result={progressPreview} />}
          <div className="actions"><button type="submit">Save plan</button><PreviewButton kind="progress" /></div>
          <p className="muted">Nothing is saved until you press Save plan. Preview shows the original schedule, what your payments fill, and the plan after the restructure, with the same rules as the save.</p>
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
