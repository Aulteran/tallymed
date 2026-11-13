import Link from 'next/link';
import { formatCents } from '../../../../server/money.ts';
import { getPlanDetail } from '../../../../server/services/plans.ts';
import {
  Banner, CADENCES, Csrf, dateOf, flatWithFlash, label, load, Money, newKey, Options, requireSession, StatePill, todayUtc, type SearchParams,
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
  return <main className="wide">
    <h1>{plan.name}</h1>
    <p><Link href="/plans">All plans</Link> · {plan.providerName} · {active ? <span className="pill">Active</span> : <span className="pill warn">Cancelled</span>} · schedule version {plan.revisionNo}</p>
    <Banner code={q.error} />
    {!active && <div className="card" role="note"><strong>Cancelled {plan.cancelledAt ? dateOf(plan.cancelledAt) : ''}.</strong> {plan.cancelReason}. History is kept; no new matches or revisions.</div>}
    <section className="metrics" aria-label="Plan totals">
      <div className="card"><span>Plan total</span><strong><Money cents={plan.totalCents} /></strong><span className="muted">{plan.installmentCount} installments, {label(plan.cadence)}</span></div>
      <div className="card"><span>Matched to payments</span><strong><Money cents={plan.matchedCents} /></strong><span className="muted">References to cash already recorded</span></div>
      <div className="card"><span>Still to match</span><strong><Money cents={(BigInt(plan.totalCents) - BigInt(plan.matchedCents)).toString()} /></strong></div>
    </section>
    <div className="card"><h2>Bills covered</h2>
      <table className="stack"><thead><tr><th>Bill</th><th className="num">Responsibility</th><th className="num">Applied payments</th><th className="num">Open balance</th></tr></thead>
        <tbody>{bills.map((b) => <tr key={b.id}><td data-label="Bill"><Link href={`/bills/${b.id}`}>{b.memberName} · {b.statementDate} {b.providerReference ?? ''}</Link></td>
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
      <h2>Revise the schedule</h2>{base}{key()}<input type="hidden" name="version" value={plan.version} />
      <p className="muted">A revision replaces the schedule going forward. Earlier schedules and what was matched on them stay in the history, and matches carry onto the new installments in date order. The new total cannot be below what is already matched.</p>
      <label htmlFor="rv-total">New total (USD)</label><input id="rv-total" name="totalAmount" inputMode="decimal" required pattern="\d{1,12}(\.\d{1,2})?" defaultValue={q.totalAmount ?? formatCents(plan.totalCents).replace(/[$,]/g, '')} />
      <label htmlFor="rv-count">Number of installments</label><input id="rv-count" name="installmentCount" type="number" min={1} max={120} required defaultValue={q.installmentCount ?? plan.installmentCount} />
      <label htmlFor="rv-first">First due date</label><input id="rv-first" name="firstDueDate" type="date" required defaultValue={q.firstDueDate} />
      <label htmlFor="rv-cadence">Cadence</label><select id="rv-cadence" name="cadence" defaultValue={q.cadence ?? 'monthly'}>{CADENCES.map((c) => <option key={c} value={c}>{label(c)}</option>)}</select>
      <label htmlFor="rv-why">Reason</label><input id="rv-why" name="reason" required maxLength={500} defaultValue={q.reason} />
      <button type="submit">Save new schedule</button>
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
