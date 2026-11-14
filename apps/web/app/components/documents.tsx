import Link from 'next/link';
import type { Actor } from '../../server/authz.ts';
import type { AppContext } from '../../server/http.ts';
import { DOCUMENT_KINDS } from '../../server/validation.ts';
import { listAttachments, pickDocuments } from '../../server/services/documents.ts';
import type { AttachmentRow, TargetType } from '../../server/repositories/documents.ts';
import { Csrf, dateOf, label, newKey } from './ui.tsx';

export const formatBytes = (n: string | number) => {
  const v = Number(n);
  return v >= 1024 * 1024 ? `${(v / 1024 / 1024).toFixed(1)} MB` : v >= 1024 ? `${Math.round(v / 1024)} KB` : `${v} B`;
};
export const KindOptions = () => <>{DOCUMENT_KINDS.map((k) => <option key={k} value={k}>{label(k)}</option>)}</>;
const MEDIA = { 'application/pdf': 'PDF', 'image/png': 'PNG', 'image/jpeg': 'JPEG' } as Record<string, string>;
export const mediaLabel = (t: string) => MEDIA[t] ?? t;

/** The page a link points at, so a document's history links back to the record it supports. */
export function targetHref(a: Pick<AttachmentRow, 'targetType' | 'targetId' | 'billId' | 'allocationId'>): string | null {
  switch (a.targetType) {
    case 'bill': return `/bills/${a.targetId}`;
    case 'bill_adjustment': return a.billId ? `/bills/${a.billId}` : null;
    case 'visit': return `/visits/${a.targetId}`;
    case 'hsa_receipt': return `/hsa/receipts/${a.targetId}`;
    default: return a.allocationId ? `/hsa/allocations/${a.allocationId}` : null;
  }
}
export const targetLabel = (t: string) => ({ bill: 'Bill', visit: 'Visit', bill_adjustment: 'Bill adjustment', hsa_receipt: 'HSA reimbursement', hsa_eligibility_decision: 'HSA eligibility decision' } as Record<string, string>)[t] ?? t;

/** Documents attached to one record, with detach, attach-existing and upload-and-attach forms. */
export async function AttachmentsPanel({ ctx, actor, csrf, type, id, returnTo, q, title = 'Documents' }: {
  ctx: AppContext; actor: Actor; csrf: string; type: TargetType; id: string; returnTo: string; q?: string; title?: string;
}) {
  const [links, choices] = await Promise.all([
    listAttachments(ctx.pool, actor, type, id), pickDocuments(ctx.pool, actor, { q }, { type, id }),
  ]);
  const active = links.filter((l) => !l.detachedAt);
  const past = links.filter((l) => l.detachedAt);
  const enabled = !!ctx.store;
  const field = `${type.slice(0, 4)}-${id}`;
  return <div className="card" aria-label={title}>
    <h2>{title}</h2>
    {active.length === 0 ? <p>No documents are attached to this record.</p> : <ul>{active.map((l) => <li key={l.id}>
      <Link href={`/documents/${l.documentId}`}>{l.documentTitle}</Link> · version {l.versionNo}{l.currentVersionNo > l.versionNo ? ` (version ${l.currentVersionNo} exists)` : ''} · {mediaLabel(l.mediaType)}
      {enabled && <> · <a href={`/api/documents/download/${l.documentId}?version=${l.versionNo}`}>Download</a></>}
      <form method="post" action="/api/documents/detach" className="row">
        <Csrf token={csrf} /><input type="hidden" name="attachmentId" value={l.id} /><input type="hidden" name="returnTo" value={returnTo} />
        <label htmlFor={`d-${l.id}`}>Reason for detaching</label><input id={`d-${l.id}`} name="reason" required maxLength={300} />
        <button type="submit" className="secondary">Detach</button>
      </form>
    </li>)}</ul>}
    {past.length > 0 && <details><summary>{past.length} detached</summary><ul>{past.map((l) => <li key={l.id}>
      {l.documentTitle}{l.documentRemoved ? ' (document removed)' : ''} · version {l.versionNo} · attached {dateOf(l.createdAt)} by {l.createdByName ?? 'unknown'}, detached {dateOf(l.detachedAt!)} by {l.detachedByName ?? 'unknown'}: {l.detachReason}
    </li>)}</ul></details>}
    {enabled ? <>
      <form method="get" className="row" role="search" aria-label="Find a document">
        <div><label htmlFor={`q-${field}`}>Find a document by title or file name</label><input id={`q-${field}`} name="docq" maxLength={80} defaultValue={q} /></div>
        <div><button type="submit" className="secondary">Search</button></div>
      </form>
      <form method="post" action="/api/documents/attach">
        <Csrf token={csrf} /><input type="hidden" name="idempotencyKey" value={newKey()} /><input type="hidden" name="targetType" value={type} /><input type="hidden" name="targetId" value={id} />
        <input type="hidden" name="returnTo" value={returnTo} />
        <label htmlFor={`a-${field}`}>Attach an existing document (newest 50{q ? ' matching the search' : ''})</label>
        <select id={`a-${field}`} name="documentId" required defaultValue="">
          <option value="" disabled>{choices.length === 0 ? 'No documents to attach' : 'Choose a document'}</option>
          {choices.map((d) => <option key={d.id} value={`${d.id}@${d.currentVersionNo}`}>{d.title} · {label(d.kind)} · {d.createdAt.toISOString().slice(0, 10)}</option>)}
        </select>
        <label htmlFor={`n-${field}`}>Note (optional)</label><input id={`n-${field}`} name="note" maxLength={300} />
        <button type="submit">Attach document</button>
      </form>
      <UploadForm csrf={csrf} returnTo={returnTo} target={{ type, id }} idPrefix={field} />
    </> : <p className="muted" role="note">Document storage is not configured, so documents cannot be uploaded or opened. See the operations guide.</p>}
  </div>;
}

export function UploadForm({ csrf, returnTo, target, idPrefix = 'u', max = 10, level = 3 }: { csrf: string; returnTo?: string; target?: { type: string; id: string }; idPrefix?: string; max?: number; level?: 2 | 3 }) {
  const Heading = level === 2 ? 'h2' : 'h3';
  return <form method="post" action="/api/documents/upload" encType="multipart/form-data">
    <Heading>Upload a new document{target ? ' and attach it here' : ''}</Heading>
    <Csrf token={csrf} /><input type="hidden" name="idempotencyKey" value={newKey()} />
    {target && <><input type="hidden" name="targetType" value={target.type} /><input type="hidden" name="targetId" value={target.id} /></>}
    {returnTo && <input type="hidden" name="returnTo" value={returnTo} />}
    <label htmlFor={`${idPrefix}-file`}>File (PDF, PNG or JPEG, up to {max} MB)</label>
    <input id={`${idPrefix}-file`} name="file" type="file" required accept="application/pdf,image/png,image/jpeg,.pdf,.png,.jpg,.jpeg" />
    <label htmlFor={`${idPrefix}-title`}>Title (optional)</label><input id={`${idPrefix}-title`} name="title" maxLength={120} />
    <label htmlFor={`${idPrefix}-kind`}>Kind</label><select id={`${idPrefix}-kind`} name="kind" defaultValue="other"><KindOptions /></select>
    <label htmlFor={`${idPrefix}-note`}>Note (optional)</label><input id={`${idPrefix}-note`} name="note" maxLength={500} />
    <label><input type="checkbox" name="confirmDuplicate" value="yes" /> Upload even if identical contents already exist</label>
    <button type="submit">Upload</button>
  </form>;
}
