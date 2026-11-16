import Link from 'next/link';
import { can } from '../../../../../server/authz.ts';
import { formatCents, parseNonNegativeUsd } from '../../../../../server/money.ts';
import type { PlanProposalPlan } from '../../../../../server/plan-proposal.ts';
import { reviewPlanProposal } from '../../../../../server/services/assistant.ts';
import { ProgressPreviewPanel } from '../../../../components/PlanPreview.tsx';
import { Banner, Csrf, dateOf, flatWithFlash, label, load, newKey, requireSession, type SearchParams } from '../../../../components/ui.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Payment plan proposal · TallyMed' };

const usd = (v: string) => formatCents(parseNonNegativeUsd(v));

/** The assistant's schedule, in words. Amounts are re-read from the validated canonical strings, never from client text. */
function scheduleText(s: PlanProposalPlan['schedule']): string {
  if (s.mode === 'list') return `${s.installments.length} listed installment${s.installments.length === 1 ? '' : 's'}, from ${s.installments.map((i) => i.dueDate).sort()[0]}`;
  if (s.mode === 'total') return `${usd(s.totalAmount)} in ${s.installmentCount} installment${s.installmentCount === 1 ? '' : 's'}, ${s.cadence}, first due ${s.firstDueDate}`;
  return `${usd(s.installmentAmount)} per installment${s.installmentCount !== undefined ? `, ${s.installmentCount} installments` : ''}${s.totalAmount !== undefined ? `, total ${usd(s.totalAmount)}` : ''}, ${s.cadence}, first due ${s.firstDueDate}`;
}

export default async function PlanProposalPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { ctx, actor, csrf } = await requireSession();
  const { id } = await params;
  const q = await flatWithFlash(searchParams, `/proposals/plans/${id}`);
  const { data: r } = await load(() => reviewPlanProposal(ctx.pool, actor, id), null);
  const { proposal: pr, plan, bills, problems, preview, previewError, previewDigest } = r!;
  const writer = can(actor, 'expenses:write');
  const pill = pr.status === 'pending' ? 'pill warn' : pr.status === 'approved' ? 'pill' : 'pill neutral';
  return <main id="main" className="wide">
    <p className="crumb"><Link href="/proposals">← Proposals</Link></p>
    <h1>Payment plan proposal{plan ? `: ${plan.name}` : ''}</h1>
    <p><span className={pill}>{label(pr.status)}</span> · from {pr.clientName} · {dateOf(pr.createdAt)}</p>
    <Banner code={q.error} />
    <p className="muted" role="note">Everything below that the assistant supplied (the plan name, the note) is shown as plain text and was not checked. Compare the plan with your bills and payments yourself. Nothing is created until you approve it.</p>
    {problems.length > 0 && <div className="card" role="alert"><h2>Cannot be approved</h2><ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul>
      <p>You cannot approve this proposal as it stands. Reject it, then enter the plan yourself if it is right.</p></div>}

    <div className="card"><h2>Note from the assistant</h2><p style={{ whiteSpace: 'pre-wrap' }}>{pr.note}</p></div>

    {plan && <div className="card"><h2>The proposed plan</h2>
      <ul>
        <li><strong>Name:</strong> {plan.name}</li>
        <li><strong>Started:</strong> {plan.startedOn}</li>
        <li><strong>Original schedule:</strong> {scheduleText(plan.schedule)}</li>
        <li><strong>Payments already made:</strong> {plan.matchExisting ? 'Matched to the installments (payments applied to these bills since the start date)' : 'Not matched'}</li>
        <li><strong>Restructured:</strong> {plan.restructure ? `Yes: the unpaid rest restarts ${plan.restructure.restartOn} at ${usd(plan.restructure.amountPerInstallment)} per installment, ${plan.restructure.cadence}` : 'No'}</li>
      </ul></div>}

    <div className="card"><h2>Bills</h2>
      {bills.length === 0 ? <p>No bill of this proposal could be found.</p> : <table className="stack">
        <thead><tr><th>Bill</th><th>Member</th><th>Statement</th><th className="num">Open balance</th></tr></thead>
        <tbody>{bills.map((b) => <tr key={b.id}>
          <td data-label="Bill"><Link href={`/bills/${b.id}`}>{b.providerName}{b.providerReference ? ` · ${b.providerReference}` : ''}</Link></td>
          <td data-label="Member">{b.memberName}</td><td data-label="Statement">{b.statementDate}</td><td data-label="Open balance" className="num">{formatCents(b.openBalanceCents)}</td>
        </tr>)}</tbody></table>}</div>

    {preview && <ProgressPreviewPanel result={{ progress: preview }} hint="This is what approving would create, computed the same way as the form for a plan already in progress. TallyMed checks again, under locks, that it has not changed." />}
    {previewError && <ProgressPreviewPanel result={{ error: previewError }} />}

    {pr.status === 'pending' && writer && <>
      {preview && previewDigest && <form className="card" method="post" action="/api/assistant/proposals/plan-approve">
        <h2>Approve</h2><Csrf token={csrf} /><input type="hidden" name="idempotencyKey" value={newKey()} /><input type="hidden" name="proposalId" value={pr.id} />
        <input type="hidden" name="previewDigest" value={previewDigest} />
        <p className="muted">Creates the plan exactly as the preview shows, with the payments it matches, and moves no cash.</p>
        <button type="submit">Approve and create plan</button>
      </form>}
      <form className="card" method="post" action="/api/assistant/proposals/plan-reject">
        <h2>Reject</h2><Csrf token={csrf} /><input type="hidden" name="proposalId" value={pr.id} />
        <label htmlFor="reason">Reason (optional)</label><input id="reason" name="reason" maxLength={300} defaultValue={q.reason} />
        <button type="submit" className="secondary">Reject</button>
      </form>
    </>}
    {pr.status !== 'pending' && <div className="card"><h2>Decision</h2>
      <p>{label(pr.status)}{pr.decidedByName ? ` by ${pr.decidedByName}` : ''}{pr.decidedAt ? ` · ${dateOf(pr.decidedAt)}` : ''}{pr.decisionNote ? ` · ${pr.decisionNote}` : ''}</p>
      {pr.planId && <p>The plan was created: <Link href={`/plans/${pr.planId}`}>open the plan</Link>.</p>}</div>}
  </main>;
}
