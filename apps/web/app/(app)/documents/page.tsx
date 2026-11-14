import Link from 'next/link';
import { listDocuments } from '../../../server/services/documents.ts';
import { AddDialog } from '../../components/AddDialog.tsx';
import { formatBytes, KindOptions, mediaLabel, UploadForm } from '../../components/documents.tsx';
import { Banner, dateOf, Empty, flat, label, load, Pager, requireSession, type SearchParams } from '../../components/ui.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Documents · TallyMed' };

export default async function DocumentsPage({ searchParams }: { searchParams: SearchParams }) {
  const { ctx, actor, csrf } = await requireSession();
  const q = await flat(searchParams);
  const filter = { q: q.q, kind: q.kind, unmatched: q.unmatched, cursor: q.cursor, limit: q.limit };
  const { data, invalid } = await load(() => listDocuments(ctx.pool, actor, filter), { items: [], nextCursor: null });
  const base: Record<string, string> = {};
  for (const k of ['q', 'kind', 'unmatched'] as const) if (q[k]) base[k] = q[k]!;
  return <main id="main" className="wide">
    <div className="page-head">
      <h1>Documents</h1>
      {ctx.store && <AddDialog label="Upload document" title="Upload a new document" open={!!q.error || q.add === '1'} keep={base}>
        {q.error && <Banner code={q.error} />}
        <UploadForm heading={false} csrf={csrf} max={Math.floor(ctx.config.documentMaxBytes / 1024 / 1024)} />
      </AddDialog>}
    </div>
    <Banner code={ctx.store ? undefined : q.error} invalid={invalid} />
    <p className="muted">Bills, EOBs, receipts and reimbursement evidence. Files are private, checked by content and open only to signed-in members of this household. An unmatched document is not attached to any record yet.</p>
    <form method="get" className="card row" aria-label="Filters">
      <div><label htmlFor="q">Title or file name</label><input id="q" name="q" maxLength={80} defaultValue={q.q} /></div>
      <div><label htmlFor="kind">Kind</label><select id="kind" name="kind" defaultValue={q.kind ?? ''}><option value="">Any kind</option><KindOptions /></select></div>
      <div><label><input type="checkbox" name="unmatched" value="yes" defaultChecked={q.unmatched === 'yes' || q.unmatched === 'on'} /> Unmatched only</label></div>
      <div><button type="submit">Apply</button> <Link href="/documents">Clear</Link></div>
    </form>
    <div className="card">
      {data.items.length === 0 ? <Empty>{q.unmatched ? 'No unmatched documents.' : 'No documents yet.'}</Empty> : <table className="stack">
        <thead><tr><th>Title</th><th>Kind</th><th>Type and size</th><th>Version</th><th>Records</th><th>Added</th></tr></thead>
        <tbody>{data.items.map((d) => <tr key={d.id}>
          <td data-label="Title"><Link href={`/documents/${d.id}`}>{d.title}</Link></td><td data-label="Kind">{label(d.kind)}</td>
          <td data-label="Type and size">{mediaLabel(d.mediaType)} · {formatBytes(d.sizeBytes)}</td><td data-label="Version">{d.currentVersionNo}</td>
          <td data-label="Records">{d.activeAttachments === 0 ? <span className="pill warn">Unmatched</span> : d.activeAttachments}</td><td data-label="Added">{dateOf(d.createdAt)} by {d.createdByName ?? 'unknown'}</td>
        </tr>)}</tbody>
      </table>}
      <Pager base="/documents" params={base} next={data.nextCursor} />
    </div>
    {!ctx.store && <p className="muted" role="note">Document storage is not configured. Set TALLYMED_DOCUMENTS_DIR to a private volume to enable uploads.</p>}
  </main>;
}
