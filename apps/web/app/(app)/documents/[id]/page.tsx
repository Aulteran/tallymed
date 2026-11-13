import Link from 'next/link';
import { getDocumentDetail } from '../../../../server/services/documents.ts';
import { formatBytes, KindOptions, mediaLabel, targetHref, targetLabel } from '../../../components/documents.tsx';
import { Banner, Csrf, dateOf, flatWithFlash, label, load, newKey, requireSession, type SearchParams } from '../../../components/ui.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Document · TallyMed' };

export default async function DocumentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  const { ctx, actor, csrf } = await requireSession();
  const { id } = await params;
  const q = await flatWithFlash(searchParams, `/documents/${id}`);
  const { data } = await load(() => getDocumentDetail(ctx.pool, actor, id), null);
  const { document: d, versions, attachments, history } = data!;
  const removed = d.removedAt !== null;
  const active = attachments.filter((a) => !a.detachedAt);
  const enabled = !!ctx.store && !removed;
  const here = `/documents/${d.id}`;
  return <main className="wide">
    <h1>{d.title}</h1>
    <p>{label(d.kind)} · {mediaLabel(d.mediaType)} · {formatBytes(d.sizeBytes)} · version {d.currentVersionNo} · added {dateOf(d.createdAt)} by {d.createdByName ?? 'unknown'}
      {removed && <> <span className="pill warn">Removed</span></>}{!removed && active.length === 0 && <> <span className="pill warn">Unmatched</span></>}</p>
    {d.note && <p>{d.note}</p>}
    <Banner code={q.error} />
    {enabled && <p><a href={`/api/documents/download/${d.id}`}>Download current version</a>{d.mediaType.startsWith('image/') && <> · <a href={`/api/documents/download/${d.id}?disposition=inline`}>Open in the browser</a></>}</p>}
    {removed && <p>This document was removed{d.removalReason ? `: ${d.removalReason}` : ''}. Its history is kept; the file is deleted after the retention period.</p>}

    <div className="card"><h2>Linked records</h2>
      {attachments.length === 0 ? <p>This document is not attached to any record. Attach it from a bill, visit or HSA record, or below.</p> : <table className="stack">
        <thead><tr><th>Record</th><th>Version</th><th>Linked</th><th>Status</th></tr></thead>
        <tbody>{attachments.map((a) => { const href = targetHref(a); return <tr key={a.id}>
          <td data-label="Record">{href ? <Link href={href}>{targetLabel(a.targetType)}</Link> : targetLabel(a.targetType)}{a.note ? ` · ${a.note}` : ''}</td>
          <td data-label="Version">{a.versionNo}</td><td data-label="Linked">{dateOf(a.createdAt)} by {a.createdByName ?? 'unknown'}</td>
          <td data-label="Status">{a.detachedAt ? `Detached ${dateOf(a.detachedAt)} by ${a.detachedByName ?? 'unknown'}: ${a.detachReason}` : (
            <form method="post" action="/api/documents/detach"><Csrf token={csrf} /><input type="hidden" name="attachmentId" value={a.id} /><input type="hidden" name="returnTo" value={here} />
              <label htmlFor={`d-${a.id}`}>Reason for detaching</label><input id={`d-${a.id}`} name="reason" required maxLength={300} /><button type="submit" className="secondary">Detach</button></form>)}</td>
        </tr>; })}</tbody>
      </table>}
      {enabled && <form method="post" action="/api/documents/attach">
        <h3>Attach to a record</h3><Csrf token={csrf} /><input type="hidden" name="idempotencyKey" value={newKey()} /><input type="hidden" name="documentId" value={`${d.id}@${d.currentVersionNo}`} /><input type="hidden" name="returnTo" value={here} />
        <label htmlFor="targetType">Record type</label>
        <select id="targetType" name="targetType" defaultValue="bill"><option value="bill">Bill</option><option value="visit">Visit</option><option value="hsa_receipt">HSA reimbursement</option><option value="hsa_eligibility_decision">HSA eligibility decision</option><option value="bill_adjustment">Bill adjustment</option></select>
        <label htmlFor="targetId">Record ID (the last part of the record page address)</label><input id="targetId" name="targetId" required pattern="[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}" />
        <label htmlFor="note">Note (optional)</label><input id="note" name="note" maxLength={300} />
        <button type="submit">Attach</button>
      </form>}
    </div>

    <div className="card"><h2>Versions</h2>
      <table className="stack"><thead><tr><th>Version</th><th>Type and size</th><th>SHA-256</th><th>Added</th><th>File</th></tr></thead>
        <tbody>{versions.map((v) => <tr key={v.id}><td data-label="Version">{v.versionNo}</td><td data-label="Type and size">{mediaLabel(v.mediaType)} · {formatBytes(v.sizeBytes)}</td>
          <td data-label="SHA-256"><code>{v.sha256.slice(0, 16)}…</code></td><td data-label="Added">{dateOf(v.createdAt)} by {v.createdByName ?? 'unknown'}</td>
          <td data-label="File">{v.state === 'purged' ? 'Purged' : enabled ? <a href={`/api/documents/download/${d.id}?version=${v.versionNo}`}>Download</a> : '—'}</td></tr>)}</tbody></table>
      {enabled && <form method="post" action="/api/documents/version" encType="multipart/form-data">
        <h3>Upload a new version</h3><Csrf token={csrf} /><input type="hidden" name="idempotencyKey" value={newKey()} /><input type="hidden" name="documentId" value={d.id} /><input type="hidden" name="version" value={d.versionCount} />
        <p className="muted">Records already linked keep the version they were linked with. Detach and attach again to point a record at the new version.</p>
        <label htmlFor="vfile">File (PDF, PNG or JPEG)</label><input id="vfile" name="file" type="file" required accept="application/pdf,image/png,image/jpeg,.pdf,.png,.jpg,.jpeg" />
        <label><input type="checkbox" name="confirmDuplicate" value="yes" /> Add even if identical to the current version</label>
        <button type="submit">Upload version</button>
      </form>}
    </div>

    {enabled && <>
      <form className="card" method="post" action="/api/documents/update">
        <h2>Details</h2><Csrf token={csrf} /><input type="hidden" name="id" value={d.id} /><input type="hidden" name="version" value={d.version} />
        <label htmlFor="title">Title</label><input id="title" name="title" required maxLength={120} defaultValue={q.title ?? d.title} />
        <label htmlFor="kind">Kind</label><select id="kind" name="kind" defaultValue={q.kind ?? d.kind}><KindOptions /></select>
        <label htmlFor="dnote">Note</label><input id="dnote" name="note" maxLength={500} defaultValue={q.note ?? d.note} />
        <button type="submit">Save details</button>
      </form>
      <form className="card" method="post" action="/api/documents/remove">
        <h2>Remove this document</h2><Csrf token={csrf} /><input type="hidden" name="id" value={d.id} /><input type="hidden" name="version" value={d.version} />
        <p className="muted">{active.length > 0 ? 'Detach it from every record first.' : 'It disappears from lists and downloads. Its history and checksum stay, and the file is deleted after the retention period.'}</p>
        <label htmlFor="reason">Reason</label><input id="reason" name="reason" required maxLength={300} defaultValue={q.reason} />
        <button type="submit" className="secondary" disabled={active.length > 0}>Remove document</button>
      </form>
    </>}

    <div className="card"><h2>History</h2>
      <ol>{history.map((e) => <li key={e.id}><strong>{label(e.action.replace(/^document\./, '').replace(/[._]/g, ' '))}</strong> by {e.actorName ?? 'the system'} · {dateOf(e.occurredAt)}</li>)}</ol>
    </div>
  </main>;
}
