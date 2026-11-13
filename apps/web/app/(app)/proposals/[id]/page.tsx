import Link from 'next/link';
import { can } from '../../../../server/authz.ts';
import { getProposal } from '../../../../server/services/assistant.ts';
import { formatBytes, mediaLabel } from '../../../components/documents.tsx';
import { Banner, Csrf, dateOf, flatWithFlash, label, load, newKey, requireSession, type SearchParams } from '../../../components/ui.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Proposal · TallyMed' };

export default async function ProposalPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { ctx, actor, csrf } = await requireSession();
  const { id } = await params;
  const q = await flatWithFlash(searchParams, `/proposals/${id}`);
  const { data: p } = await load(() => getProposal(ctx.pool, actor, id), null);
  const pr = p!;
  const here = `/proposals/${pr.id}`;
  const recordHref = pr.targetType === 'bill' ? `/bills/${pr.targetId}` : `/visits/${pr.targetId}`;
  const writer = can(actor, 'expenses:write');
  const reasons: string[] = [];
  if (pr.status === 'pending') {
    if (pr.documentRemoved) reasons.push('The document was removed.');
    if (pr.currentVersionNo !== pr.pinnedVersionNo) reasons.push(`The document now has version ${pr.currentVersionNo}; this proposal is about version ${pr.pinnedVersionNo}.`);
    if (pr.targetVersionNow !== pr.targetVersion) reasons.push('The record was edited after the proposal was made.');
    if (pr.alreadyAttached) reasons.push('This document is already attached to that record.');
    if (pr.clientRevoked) reasons.push('The credential that made this proposal was revoked.');
  }
  return <main className="wide">
    <h1>Proposal: {pr.documentTitle}</h1>
    <p>{label(pr.status)} · from {pr.clientName} · {dateOf(pr.createdAt)} · confidence {pr.confidence}</p>
    <Banner code={q.error} />
    <p className="muted" role="note">Everything below that the assistant or a file supplied (title, notes, reason) is shown as plain text and was not checked. Compare it with the document and the record yourself.</p>
    {reasons.length > 0 && <div className="card" role="alert"><h2>Out of date</h2><ul>{reasons.map((r) => <li key={r}>{r}</li>)}</ul>
      <p>You cannot approve this proposal as it stands. Reject it, then attach the document yourself if it still belongs to the record.</p></div>}

    <div className="card"><h2>Reason given</h2><p style={{ whiteSpace: 'pre-wrap' }}>{pr.rationale}</p></div>

    <div className="card"><h2>Document (version {pr.pinnedVersionNo})</h2>
      <p><Link href={`/documents/${pr.documentId}`}>{pr.documentTitle}</Link> · {label(pr.documentKind)} · {mediaLabel(pr.mediaType)} · {formatBytes(pr.sizeBytes)} · file name {pr.fileName}</p>
      {pr.documentNote && <p>Note: {pr.documentNote}</p>}
      <p>SHA-256 <code>{pr.sha256.slice(0, 16)}…</code>{ctx.store && !pr.documentRemoved && <> · <a href={`/api/documents/download/${pr.documentId}?version=${pr.pinnedVersionNo}`}>Download this version to check it</a></>}</p></div>

    <div className="card"><h2>Record</h2>
      <p><Link href={recordHref}>{label(pr.targetType)}</Link> · {pr.targetProvider} · {pr.targetMember} · {pr.targetDate}{pr.targetReference ? ` · reference ${pr.targetReference}` : ''}{pr.targetDescription ? ` · ${pr.targetDescription}` : ''}</p></div>

    {pr.status === 'pending' && writer && <>
      <form className="card" method="post" action="/api/assistant/proposals/approve">
        <h2>Approve</h2><Csrf token={csrf} /><input type="hidden" name="idempotencyKey" value={newKey()} /><input type="hidden" name="proposalId" value={pr.id} />
        <input type="hidden" name="documentVersion" value={pr.pinnedVersionNo} /><input type="hidden" name="targetVersion" value={pr.targetVersion} /><input type="hidden" name="documentRevision" value={pr.documentRevision} />
        <p className="muted">Attaches version {pr.pinnedVersionNo} of the document to this record, exactly as shown. TallyMed checks again that neither has changed.</p>
        <button type="submit" disabled={pr.stale}>Approve and attach</button>
      </form>
      <form className="card" method="post" action="/api/assistant/proposals/reject">
        <h2>Reject</h2><Csrf token={csrf} /><input type="hidden" name="proposalId" value={pr.id} />
        <label htmlFor="reason">Reason</label><input id="reason" name="reason" required maxLength={300} defaultValue={q.reason} />
        <button type="submit" className="secondary">Reject</button>
      </form>
    </>}
    {pr.status !== 'pending' && <div className="card"><h2>Decision</h2>
      <p>{label(pr.status)} by {pr.decidedByName ?? 'unknown'} · {pr.decidedAt ? dateOf(pr.decidedAt) : ''}{pr.decisionNote ? ` · ${pr.decisionNote}` : ''}</p>
      {pr.attachmentId && <p>The document is attached to the record: <Link href={recordHref}>open the record</Link>.</p>}</div>}
    <p><Link href="/proposals">All proposals</Link></p>
  </main>;
}
