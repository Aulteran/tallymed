import Link from 'next/link';
import { can } from '../../../../server/authz.ts';
import { formatCents } from '../../../../server/money.ts';
import { pickPaymentMethods } from '../../../../server/services/payment-methods.ts';
import { getPaymentDetail, pickPayableBills } from '../../../../server/services/payments.ts';
import { ConfirmDialog } from '../../../components/ConfirmDialog.tsx';
import {
  Banner, Csrf, dateOf, flatWithFlash, label, load, methodName, Money, NarrowForm, newKey, Options, q80, requireSession, todayUtc, Truncated, type SearchParams,
} from '../../../components/ui.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Payment · TallyMed' };

export default async function PaymentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { ctx, actor, csrf } = await requireSession();
  const { id } = await params;
  const q = await flatWithFlash(searchParams, `/payments/${id}`);
  const { data } = await load(() => getPaymentDetail(ctx.pool, actor, id), null);
  const { payment: pm, allocations, entries, refunds, history } = data!;
  const bills = await pickPayableBills(ctx.pool, actor, { q: q80(q.billQ), currentId: q.billId });
  const methods = await pickPaymentMethods(ctx.pool, actor, pm.paidWithId);
  const live = !pm.voided;
  const unapplied = BigInt(pm.unappliedCents);
  const key = (name: string) => <input type="hidden" name="idempotencyKey" value={newKey()} data-for={name} />;
  const base = (<><Csrf token={csrf} /><input type="hidden" name="paymentId" value={pm.id} /></>);
  const admin = can(actor, 'records:remove');
  // A payment paid directly from an HSA: administrators may also pick a card with no HSA link (which releases the funding); others keep same-account HSA cards.
  const methodChoices = methods.items.filter((m) => m.id === pm.paidWithId || (pm.hsaAccountId ? (m.hsaAccountId === pm.hsaAccountId || (admin && !m.hsaAccountId)) : !m.hsaAccountId));
  const canVoid = live && BigInt(pm.appliedCents) === 0n && BigInt(pm.refundedCents) === 0n;
  return <main id="main" className="wide">
    <p className="crumb"><Link href="/payments">← Payments</Link></p>
    <div className="page-head">
      <h1>Payment of <Money cents={pm.amountCents} /> on {pm.paidOn}</h1>
      {admin && live && <ConfirmDialog id="delete-payment" label="Delete payment" title="Delete this payment?">
        <form method="post" action="/api/expenses/payments/remove">
          {base}{key('remove')}
          <p>This deletes the payment of <Money cents={pm.amountCents} /> on {pm.paidOn}{pm.reference ? ` (${pm.reference})` : ''}. It disappears from the payment lists.</p>
          <ul>
            <li>Cash applied to bills is returned, so those bills&apos; balances go up.</li>
            <li>Matches to payment plan installments are released. Undo does not restore them.</li>
            <li>You can undo this for 3 minutes, or until your next action.</li>
          </ul>
          <p className="muted">A payment with refunds that have not been reversed, or with HSA claims, cannot be deleted.</p>
          <label htmlFor="remove-why">Reason</label><input id="remove-why" name="reason" required maxLength={500} defaultValue={q.reason ?? 'Removed by administrator'} />
          <div className="modal-actions"><button type="submit" className="danger">Delete payment</button></div>
        </form>
      </ConfirmDialog>}
    </div>
    <p>{label(pm.method)}{pm.paidWithName ? ` · paid with ${methodName(pm.paidWithName, pm.paidWithLastFour)}${pm.paidWithArchived ? ' (archived)' : ''}` : ''}{pm.reference ? ` · ${pm.reference}` : ''} · recorded by {pm.createdByName ?? 'unknown'} {dateOf(pm.createdAt)} {pm.voided && <span className="pill warn">Voided</span>}</p>
    {pm.hsaAccountId && <div className="card" role="note"><strong>Paid directly from {pm.hsaAccountName}.</strong> This was paid with an HSA card at the point of service, so the HSA has already paid it. There is nothing to claim and no eligibility decision. A refund below returns cash to the HSA.</div>}
    {pm.hsaIneligible && <p className="muted" role="note">This payment was recorded as ineligible for HSA, so nothing can be claimed on it.</p>}
    {pm.note && <p>{pm.note}</p>}
    <Banner code={q.error} />
    {pm.voided && <div className="card" role="note"><strong>Voided on {pm.voidedOn}.</strong> {pm.voidReason}. A voided payment holds no cash and cannot be applied or refunded.</div>}
    <section className="metrics" aria-label="Cash">
      <div className="card"><span>Paid</span><strong><Money cents={pm.amountCents} /></strong></div>
      <div className="card"><span>Refunded to you</span><strong><Money cents={pm.refundedCents} /></strong></div>
      <div className="card"><span>Net cash paid</span><strong><Money cents={pm.netCashCents} /></strong></div>
      <div className="card"><span>Applied to bills</span><strong><Money cents={pm.appliedCents} /></strong></div>
      <div className="card"><span>Unapplied</span><strong><Money cents={pm.unappliedCents} /></strong><span className="muted">Cash not yet applied to a bill</span></div>
    </section>
    {live && <form className="card" method="post" action="/api/expenses/payments/paid-with">
      {base}{key('paid-with')}
      <h2>Paid with</h2>
      <p className="muted">Which saved card or account paid this. It changes no amount or balance, and each change is kept in the history below. A card linked to an HSA account can be chosen only when the payment is recorded; a payment paid directly from an HSA can change to another card of the same account{admin ? ', or (administrators only) to a card with no HSA link' : ''}. <Link href="/payment-methods">Manage payment methods</Link></p>
      <label htmlFor="paidWithId">Payment method</label>
      <select id="paidWithId" name="paidWithId" defaultValue={pm.paidWithId ?? ''}><Options items={methodChoices.map((m) => ({ id: m.id, name: methodName(m.nickname, m.lastFour), archived: m.archivedAt !== null }))} blank={pm.hsaAccountId ? undefined : 'Not recorded'} /></select>
      {pm.hsaAccountId && admin && <p className="muted" role="note">Choosing a card with no HSA link makes this an ordinary payment that can be claimed from an HSA like any other. You can undo that for 3 minutes, or until your next action.</p>}
      <button type="submit" className="secondary">Save</button>
    </form>}
    <div className="card"><h2>Applied to bills</h2>
      {allocations.length === 0 ? <p>Nothing has been applied to a bill yet.</p> : <table className="stack">
        <thead><tr><th>Bill</th><th className="num">Allocated</th><th className="num">Moved back</th><th className="num">Refunded</th><th className="num">Net applied</th><th className="num">Matched to a plan</th><th>HSA</th></tr></thead>
        <tbody>{allocations.map((a) => <tr key={a.allocationId}>
          <td data-label="Bill"><Link href={`/bills/${a.billId}`}>{a.memberName} · {a.billLabel}</Link></td>
          <td data-label="Allocated" className="num"><Money cents={a.allocatedCents} /></td><td data-label="Moved back" className="num"><Money cents={a.reversedCents} /></td>
          <td data-label="Refunded" className="num"><Money cents={a.refundedCents} /></td><td data-label="Net applied" className="num"><Money cents={a.netCents} /></td>
          <td data-label="Matched to a plan" className="num"><Money cents={a.matchedCents} /></td>
          <td data-label="HSA"><Link href={`/hsa/allocations/${a.allocationId}`}>Reimbursement</Link></td>
        </tr>)}</tbody>
      </table>}
    </div>
    {live && allocations.filter((a) => BigInt(a.netCents) > 0n).map((a) => <div className="card" key={a.allocationId}>
      <h2>Correct or refund: {a.memberName} · {a.billLabel}</h2>
      <p className="muted">Net applied <Money cents={a.netCents} />. Moving cash back to unapplied is a correction. A refund records cash the provider returned to you and raises the bill balance.</p>
      <form method="post" action="/api/expenses/payments/unapply">
        {base}{key('unapply')}<input type="hidden" name="allocationId" value={a.allocationId} />
        <label htmlFor={`u-amt-${a.allocationId}`}>Amount to move back (blank moves all)</label><input id={`u-amt-${a.allocationId}`} name="amount" inputMode="decimal" pattern="\d{1,12}(\.\d{1,2})?" />
        <label htmlFor={`u-date-${a.allocationId}`}>Effective date</label><input id={`u-date-${a.allocationId}`} name="effectiveDate" type="date" required defaultValue={todayUtc()} />
        <label htmlFor={`u-why-${a.allocationId}`}>Reason</label><input id={`u-why-${a.allocationId}`} name="reason" required maxLength={500} />
        <button type="submit" className="secondary">Move back to unapplied</button>
      </form>
      <form method="post" action="/api/expenses/payments/refund">
        {base}{key('refund')}<input type="hidden" name="allocationId" value={a.allocationId} />
        <label htmlFor={`r-amt-${a.allocationId}`}>Refund amount (USD)</label><input id={`r-amt-${a.allocationId}`} name="amount" inputMode="decimal" required pattern="\d{1,12}(\.\d{1,2})?" />
        <label htmlFor={`r-date-${a.allocationId}`}>Date refunded</label><input id={`r-date-${a.allocationId}`} name="effectiveDate" type="date" required defaultValue={todayUtc()} />
        <label htmlFor={`r-why-${a.allocationId}`}>Reason</label><input id={`r-why-${a.allocationId}`} name="reason" required maxLength={500} />
        <button type="submit" className="secondary">Record refund</button>
      </form>
    </div>)}
    {live && unapplied > 0n && <>
      {(bills.truncated || q.billQ) && <>{bills.truncated && <Truncated what="bills" />}<NarrowForm fields={[{ name: 'billQ', label: 'Find a bill' }]} values={q} /></>}
      <form className="card" method="post" action="/api/expenses/payments/allocate">
        <h2>Apply unapplied cash to a bill</h2>{base}{key('allocate')}
        <p className="muted">Up to <Money cents={pm.unappliedCents} /> can be applied, and never more than the open balance of the bill.</p>
        <label htmlFor="billId">Bill</label>
        <select id="billId" name="billId" required defaultValue={q.billId ?? ''}><Options items={bills.items.map((b) => ({ id: b.id, name: `${b.label} · ${b.statementDate} · open ${formatCents(b.openBalanceCents)}` }))} blank="Choose…" /></select>
        <label htmlFor="allocateAmount">Amount (USD)</label><input id="allocateAmount" name="allocateAmount" inputMode="decimal" required pattern="\d{1,12}(\.\d{1,2})?" defaultValue={q.allocateAmount} />
        <button type="submit">Apply</button>
      </form>
      <form className="card" method="post" action="/api/expenses/payments/refund">
        <h2>Refund unapplied cash</h2>{base}{key('refund-unapplied')}
        <label htmlFor="ua-amount">Amount (USD)</label><input id="ua-amount" name="amount" inputMode="decimal" required pattern="\d{1,12}(\.\d{1,2})?" />
        <label htmlFor="ua-date">Date refunded</label><input id="ua-date" name="effectiveDate" type="date" required defaultValue={todayUtc()} />
        <label htmlFor="ua-why">Reason</label><input id="ua-why" name="reason" required maxLength={500} />
        <button type="submit" className="secondary">Record refund</button>
      </form>
    </>}
    {refunds.length > 0 && <div className="card"><h2>Refunds</h2>
      <table className="stack"><thead><tr><th>Date</th><th className="num">Amount</th><th>Status</th></tr></thead>
        <tbody>{refunds.map((r) => <tr key={r.eventId}><td data-label="Date">{r.effectiveDate}</td><td data-label="Amount" className="num"><Money cents={r.totalCents} /></td>
          <td data-label="Status">{r.reversed ? 'Reversed' : live ? (
            <form method="post" action="/api/expenses/payments/refund-reverse">
              {base}{key('rr')}<input type="hidden" name="eventId" value={r.eventId} /><input type="hidden" name="effectiveDate" value={todayUtc()} />
              <label htmlFor={`rr-${r.eventId}`}>Reason for reversing</label><input id={`rr-${r.eventId}`} name="reason" required maxLength={500} />
              <button type="submit" className="secondary">Reverse refund</button>
            </form>) : 'Recorded'}</td></tr>)}</tbody>
      </table></div>}
    {canVoid && <form className="card" method="post" action="/api/expenses/payments/void">
      <h2>Void this payment</h2>{base}{key('void')}<input type="hidden" name="voidedOn" value={todayUtc()} />
      <p className="muted">Use this only for a payment recorded in error, such as a duplicate or one that never cleared. Nothing is applied or refunded, so no balance changes. This cannot be undone.</p>
      <label htmlFor="void-why">Reason</label><input id="void-why" name="reason" required maxLength={500} />
      <button type="submit" className="secondary">Void payment</button>
    </form>}
    <div className="card"><h2>Ledger</h2>
      <table className="stack"><thead><tr><th>Effective</th><th>Entry</th><th>Bill</th><th className="num">Amount</th><th>Reason</th><th>Entered by</th></tr></thead>
        <tbody>{entries.map((e) => <tr key={e.id}><td data-label="Effective">{e.effectiveDate}</td><td data-label="Entry">{label(e.kind)}</td>
          <td data-label="Bill">{e.billId ? <Link href={`/bills/${e.billId}`}>{e.memberName} · {e.billLabel}</Link> : 'Unapplied cash'}</td>
          <td data-label="Amount" className="num"><Money cents={e.amountCents} /></td><td data-label="Reason">{e.reason}</td><td data-label="Entered by">{e.createdByName ?? ''} {dateOf(e.createdAt)}</td></tr>)}</tbody></table>
      <p className="muted">Entries are immutable. Corrections appear as new linked entries.</p>
    </div>
    <div className="card"><h2>History</h2>
      <ol>{history.map((e) => <li key={e.id}><strong>{label(e.action.replace('.', ' '))}</strong> by {e.actorName ?? 'unknown'} · {dateOf(e.occurredAt)}</li>)}</ol>
    </div>
  </main>;
}
