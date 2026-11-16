import Link from 'next/link';
import { ConfirmDialog } from '../../../components/ConfirmDialog.tsx';
import { AddDialog } from '../../../components/AddDialog.tsx';
import { PlanPreviewPanel, PreviewButton, SaveButton, tryPreview } from '../../../components/PlanPreview.tsx';
import { PlanScheduleFields } from '../../../components/PlanScheduleFields.tsx';
import { can } from '../../../../server/authz.ts';
import { centsToUsdInput, formatCents } from '../../../../server/money.ts';
import { getPlanDetail, previewPlanRevision } from '../../../../server/services/plans.ts';
import {
  Banner, Csrf, CADENCES, dateOf, flatWithFlash, label, load, Money, newKey, Options, requireSession, StatePill, todayUtc, type SearchParams,
} from '../../../components/ui.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Payment plan · TallyMed' };

export default async function PlanPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { ctx, actor, csrf } = await requireSession();
  const { id } = await params;
  const q = await flatWithFlash(searchParams, `/plans/${id}`);
  const { data } = await load(() => getPlanDetail(ctx.pool, actor, id, { allocationId: q.allocationId }), null);
  const { plan, bills, revisions, installments, matches, history, allocations, allocationsTruncated } = data!;
  const active = plan.status === 'active';
  // A refused rename or restructure comes back with the typed values; its pop-up reopens with the message. Other errors show on the page.
  const renameFailed = !!q.error && q.name !== undefined;
  const renameOpen = renameFailed || q.add === '1';
  // The restructure dialog and the full revise form share field names, so each reads the query only when it is the one that was used.
  const restructureUsed = q.dialog === 'restructure' || q.preview === 'restructure';
  const restructureFailed = !!q.error && q.dialog === 'restructure';
  const restructureOpen = restructureFailed || q.add === 'restructure' || q.preview === 'restructure';
  const rv = restructureUsed ? {} : q;
  const rs = restructureUsed ? q : {};
  const base = (<><Csrf token={csrf} /><input type="hidden" name="planId" value={plan.id} /></>);
  const key = () => <input type="hidden" name="idempotencyKey" value={newKey()} />;
  // Net matched per installment and allocation in the current schedule, for the remove-match form.
  const pairs = new Map<string, { installmentId: string; allocationId: string; seq: number; cents: bigint; paidOn: string }>();
  const seqOf = new Map(installments.map((i) => [i.seq, i.id]));
  for (const m of matches.filter((x) => x.revisionNo === plan.revisionNo)) {
    const installmentId = seqOf.get(m.installmentSeq)!;
    const k = `${installmentId}:${m.allocationId}`;
    const cur = pairs.get(k) ?? { installmentId, allocationId: m.allocationId, seq: m.installmentSeq, cents: 0n, paidOn: m.paidOn };
    cur.cents += BigInt(m.amountCents);
    pairs.set(k, cur);
  }
  const matchedPairs = [...pairs.values()].filter((x) => x.cents > 0n);
  const open = installments.filter((i) => i.state !== 'paid');
  // Fully paid means nothing still owed: the same test a "keep paid" revision uses under the lock.
  const paid = installments.filter((i) => BigInt(i.unpaidCents) === 0n);
  const paidCount = paid.length;
  const paidCents = paid.reduce((t, i) => t + BigInt(i.amountCents), 0n);
  // Advisory only: what the plan still schedules (total minus what is matched) against what the bills still owe. Never blocks anything.
  const stillScheduled = BigInt(plan.totalCents) - BigInt(plan.matchedCents);
  const billsOpen = bills.reduce((t, b) => t + BigInt(b.openBalanceCents), 0n);
  const balanceGap = stillScheduled - billsOpen;
  // Warnings recorded when the current schedule was saved (a total that did not match count x amount, installments that differ by rounding).
  const saved = [...history].reverse().find((e) => e.action === 'plan.created' || e.action === 'plan.revised');
  const enteredCents = saved?.detail.expectedTotalCents ? BigInt(String(saved.detail.expectedTotalCents)) : null;
  const computedCents = saved?.detail.computedTotalCents ? BigInt(String(saved.detail.computedTotalCents)) : null;
  const totalGap = enteredCents !== null && computedCents !== null ? computedCents - enteredCents : 0n;
  const roundingNote = String(saved?.detail.warningCodes ?? '').split(',').includes('unequal_installments');
  const stillToSchedule = BigInt(plan.totalCents) - paidCents;
  const canRestructure = active && paidCount > 0 && paidCount < installments.length;
  const planAction = `/plans/${plan.id}`;
  const scheduleOf = (v: Record<string, string>, fields: string[]) => Object.fromEntries(fields.filter((f) => v[f] !== undefined).map((f) => [f, v[f]!]));
  const revisePreview = q.preview === 'revise' && active
    ? await tryPreview(() => previewPlanRevision(ctx.pool, actor, plan.id, scheduleOf(q, ['totalAmount', 'installmentCount', 'firstDueDate', 'cadence', 'inputMode', 'installmentAmount', 'remainder', 'reviseMode']))) : null;
  const restructurePreview = q.preview === 'restructure' && canRestructure
    ? await tryPreview(() => previewPlanRevision(ctx.pool, actor, plan.id, { ...scheduleOf(q, ['totalAmount', 'installmentAmount', 'firstDueDate', 'cadence']), inputMode: 'per_installment', reviseMode: 'keep_paid' })) : null;
  const unmatched = allocations.filter((a) => BigInt(a.netCents) > BigInt(a.matchedCents));
  const unmatchedCents = unmatched.reduce((t, a) => t + BigInt(a.netCents) - BigInt(a.matchedCents), 0n);
  return <main id="main" className="wide">
    <p className="crumb"><Link href="/plans">← Payment plans</Link></p>
    <div className="page-head">
      <h1>{plan.name}</h1>
      <AddDialog label="Rename" title="Rename payment plan" icon={null} secondary requiredNote={false} open={renameOpen}>
        {renameFailed && <Banner code={q.error} />}
        <form method="post" action="/api/expenses/plans/rename">
          {base}
          <p className="muted">The name is only a label. You can change it at any time, including after the plan is cancelled.</p>
          <label htmlFor="plan-name">Plan name</label><input id="plan-name" name="name" required maxLength={120} defaultValue={q.name ?? plan.name} />
          <button type="submit">Rename</button>
        </form>
      </AddDialog>
      {canRestructure && <AddDialog label="Plan was restructured" title="The plan was restructured" icon={null} secondary marker="restructure" open={restructureOpen}>
        {restructureFailed && <Banner code={q.error} />}
        <form method="post" action="/api/expenses/plans/revise">
          <input type="hidden" name="planId" value={plan.id} />{key()}<input type="hidden" name="version" value={plan.version} />
          <input type="hidden" name="dialog" value="restructure" /><input type="hidden" name="reviseMode" value="keep_paid" /><input type="hidden" name="inputMode" value="per_installment" />
          <p>{paidCount} installment{paidCount === 1 ? ' is' : 's are'} fully paid ({formatCents(paidCents.toString())}). Still to schedule: <strong>{formatCents(stillToSchedule.toString())}</strong>.</p>
          <p className="muted">The paid installments stay exactly as they are, with their own payments. The rest is scheduled again from the date below at the amount you give; the last installment is smaller if the total does not divide evenly. No cash or bill balance changes.</p>
          <label htmlFor="rs-amount">Amount per installment (USD)</label><input id="rs-amount" name="installmentAmount" inputMode="decimal" required pattern="\d{1,12}(\.\d{1,2})?" defaultValue={rs.installmentAmount} />
          <label htmlFor="rs-total">Total still to schedule (USD)</label><input id="rs-total" name="totalAmount" inputMode="decimal" required pattern="\d{1,12}(\.\d{1,2})?" defaultValue={rs.totalAmount ?? centsToUsdInput(stillToSchedule)} />
          <label htmlFor="rs-first">Restart from (first due date of the unpaid rest)</label><input id="rs-first" name="firstDueDate" type="date" required defaultValue={rs.firstDueDate} />
          <label htmlFor="rs-cadence">Cadence</label>
          <select id="rs-cadence" name="cadence" defaultValue={rs.cadence ?? 'monthly'}>{CADENCES.map((c) => <option key={c} value={c}>{label(c)}</option>)}</select>
          <label htmlFor="rs-why">Reason</label><input id="rs-why" name="reason" required maxLength={500} defaultValue={rs.reason} />
          {restructurePreview && <PlanPreviewPanel result={restructurePreview} />}
          <div className="modal-actions"><SaveButton csrf={csrf}>Save new schedule</SaveButton><PreviewButton action={planAction} kind="restructure" /></div>
        </form>
      </AddDialog>}
      {can(actor, 'records:remove') && <ConfirmDialog id="delete-plan" label="Delete plan" title="Delete this payment plan?">
        <form method="post" action="/api/expenses/plans/remove">
          {base}{key()}<input type="hidden" name="version" value={plan.version} />
          <p>This deletes the plan &quot;{plan.name}&quot;. Its schedule and its matches to payments are removed.</p>
          <ul>
            <li>Payments and bills are kept. No cash or bill balance changes.</li>
            <li>You can undo this for 3 minutes, or until your next action.</li>
          </ul>
          <label htmlFor="remove-plan-why">Reason</label><input id="remove-plan-why" name="reason" required maxLength={500} defaultValue="Removed by administrator" />
          <div className="modal-actions"><button type="submit" className="danger">Delete plan</button></div>
        </form>
      </ConfirmDialog>}
    </div>
    <p>{plan.providerNames.length > 1 ? <span title="One plan covering bills from several providers">{plan.providerNames.join(', ')}</span> : plan.payee} · started {plan.startedOn} (recorded {dateOf(plan.createdAt)}) · {active ? <span className="pill">Active</span> : <span className="pill warn">Cancelled</span>} · schedule version {plan.revisionNo}</p>
    {!renameFailed && !restructureFailed && <Banner code={q.error} />}
    {totalGap !== 0n && enteredCents !== null && computedCents !== null && <div className="card" role="note"><strong>The entered total did not match the installments.</strong> When this schedule was saved you entered a total of {formatCents(enteredCents.toString())}, but the installments entered come to {formatCents(computedCents.toString())}, {formatCents((totalGap < 0n ? -totalGap : totalGap).toString())} {totalGap > 0n ? 'more' : 'less'}. The schedule was saved as the installments add up. Revise it if that is not what you meant.</div>}
    {roundingNote && <div className="card" role="note"><strong>Some installments differ by a few cents.</strong> The total does not divide evenly, so the leftover cents were placed as you chose when the schedule was saved.</div>}
    {active && balanceGap !== 0n && <div className="card" role="note"><strong>Check the plan against the bills.</strong> The plan still schedules {formatCents(stillScheduled.toString())} (its total minus what is matched), and the bills it covers still owe {formatCents(billsOpen.toString())}: the plan is {formatCents((balanceGap < 0n ? -balanceGap : balanceGap).toString())} {balanceGap > 0n ? 'above' : 'below'} the balance. {balanceGap > 0n ? 'Payments cannot be applied above a bill\'s open balance, so the last installments may not be payable in full.' : 'The installments will not clear the bills on their own.'} {unmatchedCents > 0n ? ` ${formatCents(unmatchedCents.toString())} of payments applied to these bills is not matched to any installment yet, which can explain it: use Match all existing payments.` : ''} This is only a warning. Revise the schedule or record a bill adjustment if it is not what you expect.</div>}
    {!active && <div className="card" role="note"><strong>Cancelled {plan.cancelledAt ? dateOf(plan.cancelledAt) : ''}.</strong> {plan.cancelReason}. History is kept; no new matches or revisions.</div>}
    <section className="metrics" aria-label="Plan totals">
      <div className="card"><span>Plan total</span><strong><Money cents={plan.totalCents} /></strong><span className="muted">{plan.installmentCount} installments, {label(plan.cadence)}</span></div>
      <div className="card"><span>Matched to payments</span><strong><Money cents={plan.matchedCents} /></strong><span className="muted">References to cash already recorded</span></div>
      <div className="card"><span>Still to match</span><strong><Money cents={(BigInt(plan.totalCents) - BigInt(plan.matchedCents)).toString()} /></strong></div>
    </section>
    <div className="card"><h2>Bills covered</h2>
      <table className="stack"><thead><tr><th>Bill</th><th>Provider</th><th className="num">Responsibility</th><th className="num">Applied payments</th><th className="num">Open balance</th></tr></thead>
        <tbody>{bills.map((b) => <tr key={b.id}><td data-label="Bill"><Link href={`/bills/${b.id}`}>{b.memberName} · {b.statementDate} {b.providerReference ?? ''}</Link></td><td data-label="Provider">{b.providerName}</td>
          <td data-label="Responsibility" className="num"><Money cents={b.responsibilityCents} /></td><td data-label="Applied payments" className="num"><Money cents={b.appliedCents} /></td><td data-label="Open balance" className="num"><Money cents={b.openBalanceCents} /></td></tr>)}</tbody></table>
      <p className="muted">The plan does not change bill balances. Only recorded payments do.</p>
    </div>
    <div className="card"><h2>Current schedule</h2>
      <table className="stack"><thead><tr><th>#</th><th>Due</th><th className="num">Installment</th><th className="num">Matched</th><th className="num">Still owed</th><th>Status</th></tr></thead>
        <tbody>{installments.map((i) => <tr key={i.id}><td data-label="#">{i.seq}</td><td data-label="Due">{i.dueDate}</td><td data-label="Installment" className="num"><Money cents={i.amountCents} /></td>
          <td data-label="Matched" className="num"><Money cents={i.matchedCents} /></td><td data-label="Still owed" className="num"><Money cents={i.unpaidCents} /></td>
          <td data-label="Status"><StatePill state={i.state} overdue={i.overdue && active} /></td></tr>)}</tbody></table>
      <p className="muted">Status as of {data!.asOf} (UTC).</p>
    </div>
    {active && open.length > 0 && unmatched.length > 0 && <form className="card" method="post" action="/api/expenses/plans/match-existing">
      <h2>Match all existing payments</h2>{base}{key()}<input type="hidden" name="version" value={plan.version} />
      <p>{unmatched.length}{allocationsTruncated ? '+' : ''} payment{unmatched.length === 1 ? '' : 's'} applied to this plan's bills ({formatCents(unmatchedCents.toString())}{allocationsTruncated ? '+' : ''}) not yet matched to any installment.</p>
      <p className="muted">Only payments made on or after the plan's start date ({plan.startedOn}) are used. Matches them to the earliest installments that still owe, oldest payment first. It only links to cash already recorded: no cash is added and no bill balance changes. You can remove a match afterwards.</p>
      <button type="submit">Match all existing payments</button>
    </form>}
    {active && open.length > 0 && <form className="card" method="post" action="/api/expenses/plans/match">
      <h2>Match a payment to an installment</h2>{base}{key()}
      <p className="muted">Pick a payment already applied to one of this plan's bills. A match records that the money covers the installment; it never adds cash or changes the bill balance. You can match part of an installment.</p>
      <label htmlFor="installmentId">Installment</label>
      <select id="installmentId" name="installmentId" required defaultValue={q.installmentId ?? ''}><Options items={open.map((i) => ({ id: i.id, name: `#${i.seq} due ${i.dueDate} · owes ${formatCents(i.unpaidCents)}` }))} blank="Choose…" /></select>
      <label htmlFor="allocationId">Payment applied to a plan bill</label>
      <select id="allocationId" name="allocationId" required defaultValue={q.allocationId ?? ''}><Options items={allocations.map((a) => ({ id: a.allocationId, name: `${a.paidOn} · ${a.billLabel} · ${formatCents((BigInt(a.netCents) - BigInt(a.matchedCents)).toString())} left to match` }))} blank="Choose…" /></select>
      {allocationsTruncated && <p className="muted" role="note">Only the first 100 payments are listed; the current choice is always kept.</p>}
      <label htmlFor="amount">Amount to match (USD)</label><input id="amount" name="amount" inputMode="decimal" required pattern="\d{1,12}(\.\d{1,2})?" defaultValue={q.amount} />
      <button type="submit">Match</button>
    </form>}
    {active && matchedPairs.length > 0 && <div className="card"><h2>Remove part of a match</h2>
      <p className="muted">A removal is a linked correction with a reason. The payment and the bill balance are not touched.</p>
      {matchedPairs.map((x) => <form key={`${x.installmentId}:${x.allocationId}`} method="post" action="/api/expenses/plans/unmatch">
        {base}{key()}<input type="hidden" name="installmentId" value={x.installmentId} /><input type="hidden" name="allocationId" value={x.allocationId} />
        <p>Installment #{x.seq} has <Money cents={x.cents.toString()} /> matched from the payment of {x.paidOn}.</p>
        <label htmlFor={`un-amount-${x.installmentId}-${x.allocationId}`}>Amount to remove (USD)</label><input id={`un-amount-${x.installmentId}-${x.allocationId}`} name="amount" inputMode="decimal" required pattern="\d{1,12}(\.\d{1,2})?" />
        <label htmlFor={`un-why-${x.installmentId}-${x.allocationId}`}>Reason</label><input id={`un-why-${x.installmentId}-${x.allocationId}`} name="reason" required maxLength={500} />
        <button type="submit" className="secondary">Remove match</button>
      </form>)}
    </div>}
    {active && <form className="card" method="post" action="/api/expenses/plans/revise">
      <h2>Revise the schedule</h2><input type="hidden" name="planId" value={plan.id} />{key()}<input type="hidden" name="version" value={plan.version} />
      <p className="muted">A revision replaces the schedule going forward. Earlier schedules and what was matched on them stay in the history, and matches carry onto the new installments in date order. The new total cannot be below what is already matched.</p>
      <fieldset>
        <legend>What should the revision do?</legend>
        <label className="checkbox"><input id="rv-replace" type="radio" name="reviseMode" value="replace" defaultChecked={rv.reviseMode !== 'keep_paid'} /> Replace the whole schedule</label>
        <label className="checkbox"><input id="rv-keep" type="radio" name="reviseMode" value="keep_paid" defaultChecked={rv.reviseMode === 'keep_paid'} /> Keep the installments that are fully paid, and restart the rest from the date below</label>
        <p className="muted">When keeping paid installments, the total and amounts below describe only the unpaid rest. The paid installments stay exactly as they are, with their own payments, and the plan total becomes what they hold plus the new rest.{' '}
          {paidCount > 0 ? `Right now ${paidCount} installment${paidCount === 1 ? ' is' : 's are'} fully paid (${formatCents(paidCents.toString())}), so the part still to schedule is the plan total minus that: ${formatCents((BigInt(plan.totalCents) - paidCents).toString())}. Enter that figure as the total when keeping paid installments.` : 'No installment is fully paid yet.'}</p>
      </fieldset>
      <p className="muted">The total and the number of installments start empty so that nothing from the current schedule is reused by mistake. For reference, the current schedule is {plan.installmentCount} installments totalling {formatCents(plan.totalCents)}. With &quot;At this much paid per installment&quot;, leave the number of installments empty to have it worked out from the total, with a smaller last installment for what is left.</p>
      <PlanScheduleFields idPrefix="rv" restart={rv.reviseMode === 'keep_paid'} defaults={{
        inputMode: rv.inputMode, totalAmount: rv.totalAmount, installmentCount: rv.installmentCount,
        installmentAmount: rv.installmentAmount, remainder: rv.remainder, firstDueDate: rv.firstDueDate, cadence: rv.cadence }} />
      <label htmlFor="rv-why">Reason</label><input id="rv-why" name="reason" required maxLength={500} defaultValue={rv.reason} />
      {revisePreview && <PlanPreviewPanel result={revisePreview} />}
      <div className="actions"><SaveButton csrf={csrf}>Save new schedule</SaveButton><PreviewButton action={planAction} kind="revise" /></div>
    </form>}
    <div className="card"><h2>Schedule versions</h2>
      <table className="stack"><thead><tr><th>Version</th><th>Created</th><th className="num">Total</th><th>Installments</th><th className="num">Matched</th><th>Reason</th></tr></thead>
        <tbody>{revisions.map((r) => <tr key={r.id}><td data-label="Version">{r.revisionNo}{r.revisionNo === plan.revisionNo && ' (current)'}</td><td data-label="Created">{r.createdByName ?? ''} {dateOf(r.createdAt)}</td>
          <td data-label="Total" className="num"><Money cents={r.totalCents} /></td><td data-label="Installments">{r.installmentCount} · {label(r.cadence)}</td><td data-label="Matched" className="num"><Money cents={r.matchedCents} /></td><td data-label="Reason">{r.reason}</td></tr>)}</tbody></table>
    </div>
    <div className="card"><h2>Match history</h2>
      {matches.length === 0 ? <p>No payments have been matched yet.</p> : <table className="stack">
        <thead><tr><th>Entry</th><th>Version and installment</th><th className="num">Amount</th><th>Payment</th><th>Note</th><th>By</th></tr></thead>
        <tbody>{matches.map((m) => <tr key={m.id}><td data-label="Entry">{label(m.kind)}{m.carried ? ' (carried forward)' : ''}</td><td data-label="Version and installment">v{m.revisionNo} #{m.installmentSeq} due {m.dueDate}</td>
          <td data-label="Amount" className="num"><Money cents={m.amountCents} /></td><td data-label="Payment"><Link href={`/payments/${m.paymentId}`}>{m.paidOn} {m.reference ?? ''}</Link></td>
          <td data-label="Note">{m.reason}</td><td data-label="By">{m.createdByName ?? ''} {dateOf(m.createdAt)}</td></tr>)}</tbody></table>}
    </div>
    {active && <form className="card" method="post" action="/api/expenses/plans/cancel">
      <h2>Cancel this plan</h2>{base}<input type="hidden" name="version" value={plan.version} />
      <p className="muted">Cancelling stops the installments from showing as due. Matches and history stay. Payments and bill balances do not change. This cannot be undone.</p>
      <label htmlFor="cancel-why">Reason</label><input id="cancel-why" name="reason" required maxLength={500} defaultValue={q.reason} />
      <button type="submit" className="secondary">Cancel plan</button>
    </form>}
    <div className="card"><h2>History</h2>
      <ol>{history.map((e) => <li key={e.id}><strong>{label(e.action.replace('.', ' '))}</strong> by {e.actorName ?? 'unknown'} · {dateOf(e.occurredAt)}</li>)}</ol>
    </div>
  </main>;
}
