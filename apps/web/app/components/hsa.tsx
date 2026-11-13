import Link from 'next/link';
import { Money, label } from './ui.tsx';
import type { HsaAllocation, LineStatus } from '../../server/repositories/hsa.ts';

export const EVIDENCE_TYPES = ['receipt', 'eob', 'statement', 'provider_letter', 'plan_document', 'other'] as const;
export const RECEIPT_SOURCES = ['administrator_transfer', 'hsa_debit_card', 'portal_reimbursement', 'other'] as const;
export const AMOUNT_PATTERN = '\\d{1,12}(\\.\\d{1,2})?';

export const EvidenceOptions = () => <>{EVIDENCE_TYPES.map((v) => <option key={v} value={v}>{label(v)}</option>)}</>;
export const SourceOptions = () => <>{RECEIPT_SOURCES.map((v) => <option key={v} value={v}>{label(v)}</option>)}</>;

export const LINE_LABEL: Record<LineStatus, string> = {
  submitted: 'Submitted', partially_fulfilled: 'Partially fulfilled', fulfilled: 'Fulfilled', rejected: 'Rejected', canceled: 'Canceled', reversed: 'Receipt reversed',
};
export const LineStatusPill = ({ status }: { status: LineStatus }) => <span className={status === 'fulfilled' ? 'pill' : 'pill warn'}>{LINE_LABEL[status]}</span>;

export function DecisionPill({ a }: { a: Pick<HsaAllocation, 'decisionStatus' | 'needsReviewCents'> }) {
  if (BigInt(a.needsReviewCents) > 0n) return <span className="pill warn">Needs review</span>;
  if (a.decisionStatus === 'eligible') return <span className="pill">Eligible</span>;
  if (a.decisionStatus === 'ineligible') return <span className="pill">Ineligible</span>;
  return <span className="pill warn">{a.decisionStatus === 'pending' ? 'Decision pending' : 'Not decided'}</span>;
}

/** The five figures of one allocation, each labelled so the screen never shows a bare number. */
export function FigureCards({ a }: { a: HsaAllocation }) {
  return <section className="metrics" aria-label="HSA figures">
    <div className="card"><span>Net cash paid</span><strong><Money cents={a.netCents} /></strong><span className="muted">After refunds and reversals</span></div>
    <div className="card"><span>Eligible ceiling</span><strong><Money cents={a.ceilingCents} /></strong><span className="muted">Decided <Money cents={a.decidedCents} />, never above net cash</span></div>
    <div className="card"><span>Pending</span><strong><Money cents={a.pendingCents} /></strong><span className="muted">Reserved by open claims</span></div>
    <div className="card"><span>Received</span><strong><Money cents={a.receivedCents} /></strong><span className="muted">Reimbursements, less reversals</span></div>
    <div className="card"><span>Available</span><strong><Money cents={a.availableCents} /></strong><span className="muted">Can still be claimed</span></div>
    {BigInt(a.needsReviewCents) > 0n && <div className="card" role="note"><span>Needs review</span><strong><Money cents={a.needsReviewCents} /></strong><span className="muted">Pending plus received is above the ceiling. New claims are frozen.</span></div>}
  </section>;
}

export const AllocationLink = ({ a }: { a: Pick<HsaAllocation, 'allocationId' | 'memberName' | 'billLabel' | 'paidOn'> }) =>
  <Link href={`/hsa/allocations/${a.allocationId}`}>{a.memberName} · {a.billLabel} · paid {a.paidOn}</Link>;
