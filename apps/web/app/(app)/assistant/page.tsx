import { notFound } from 'next/navigation';
import { can } from '../../../server/authz.ts';
import { listClients } from '../../../server/services/assistant.ts';
import { Banner, Csrf, dateOf, flatWithFlash, label, requireSession, type SearchParams } from '../../components/ui.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Assistant · TallyMed' };

const SCOPES: Array<{ name: string; field: string; scope: string; text: string; sensitive?: boolean }> = [
  { name: 'List unmatched documents', field: 'documentsRead', scope: 'documents:read', text: 'Titles, notes, file names, sizes and checksums of documents that are not attached to any record.' },
  { name: 'List bills and visits needing documents', field: 'recordsRead', scope: 'records:read', text: 'Provider, family member, dates, reference and (for bills) the amount of records without a document.' },
  { name: 'Read document files', field: 'documentsContent', scope: 'documents:content', sensitive: true, text: 'The file itself, up to the size limit. The assistant client may pass it to its own AI provider.' },
  { name: 'Propose matches', field: 'proposalsCreate', scope: 'proposals:create', text: 'Suggest that a document belongs to a bill or visit. A person approves or rejects every suggestion in TallyMed.' },
];

export default async function AssistantPage({ searchParams }: { searchParams: SearchParams }) {
  const { ctx, actor, csrf } = await requireSession();
  if (!can(actor, 'assistant:manage')) notFound();
  const q = await flatWithFlash(searchParams, '/assistant');
  const clients = await listClients(ctx.pool, actor);
  return <main id="main" className="wide">
    <h1>Assistant</h1>
    <Banner code={q.error} />
    <p className="muted">Optional. TallyMed works fully without any AI. An assistant is an outside program that connects to a separate, private MCP service on your own network, reads only what its permissions allow and can only <em>propose</em> that a document belongs to a bill or visit. It can never approve a proposal, change a bill, record a payment or reach accounts. You review each proposal under <a href="/proposals">Proposals</a>. The service is off unless the person running this installation starts it; see the setup guide in the repository (docs/mcp.md).</p>
    <p className="muted" role="note">Data boundary: anything an assistant client reads can be sent on to that client's AI provider. Grant "Read document files" only to a client whose provider you trust with your documents.</p>
    <div className="card">
      <h2>Credentials</h2>
      {clients.length === 0 ? <p>No assistant credentials yet.</p> : <table className="stack">
        <thead><tr><th>Name</th><th>Permissions</th><th>Expires</th><th>Last used</th><th>Status</th></tr></thead>
        <tbody>{clients.map((c) => <tr key={c.id}>
          <td data-label="Name">{c.name}<br /><span className="muted">Created {dateOf(c.createdAt)} by {c.createdByName ?? 'unknown'}</span></td>
          <td data-label="Permissions">{c.scopes.join(', ')}</td>
          <td data-label="Expires">{dateOf(c.expiresAt)}</td>
          <td data-label="Last used">{c.lastUsedAt ? dateOf(c.lastUsedAt) : 'Never'}</td>
          <td data-label="Status">{c.revokedAt ? <>Revoked {dateOf(c.revokedAt)} by {c.revokedByName ?? 'unknown'}</> : c.active ? <>
            <span className="pill">Active</span>{c.pendingProposals > 0 && <> {c.pendingProposals} proposal{c.pendingProposals === 1 ? '' : 's'} waiting</>}
            <form method="post" action="/api/assistant/clients/revoke"><Csrf token={csrf} /><input type="hidden" name="clientId" value={c.id} />
              <label htmlFor={`r-${c.id}`}>Reason for revoking</label><input id={`r-${c.id}`} name="reason" required maxLength={300} />
              <button type="submit" className="secondary">Revoke</button></form></> : <span className="pill warn">Expired</span>}</td>
        </tr>)}</tbody>
      </table>}
    </div>
    <form className="card" method="post" action="/api/assistant/clients/create">
      <h2>Create a credential</h2><Csrf token={csrf} />
      <label htmlFor="name">Name (for example the program and the computer it runs on)</label><input id="name" name="name" required maxLength={80} defaultValue={q.name} />
      <label htmlFor="expiryDays">Valid for (days, at most 365)</label><input id="expiryDays" name="expiryDays" type="number" min={1} max={365} defaultValue={q.expiryDays ?? '90'} />
      <fieldset><legend>Permissions</legend>
        {SCOPES.map((s) => <div key={s.field}><label><input type="checkbox" name={s.field} value="yes" defaultChecked={!s.sensitive} /> {s.name} <span className="muted">({s.scope})</span></label>
          <p className="muted">{s.text}</p></div>)}
      </fieldset>
      <button type="submit">Create credential</button>
      <p className="muted">The token is shown once on the next page. Only its checksum is stored, so a lost token cannot be recovered: revoke it and create another. At most ten credentials can be active at a time. {label('administrators')} only.</p>
    </form>
  </main>;
}
