import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { can } from '../../../server/authz.ts';
import { appContext } from '../../../server/context.ts';
import { pageActor } from '../../../server/http.ts';
import { listInvitations, listOperators } from '../../../server/services/operators.ts';
import { errorMessage } from '../../components/messages.ts';
import { dateOf, label } from '../../components/ui.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Operators · TallyMed' };

export default async function OperatorsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = appContext();
  const session = await pageActor(ctx, await headers());
  if (!session) redirect('/login');
  if (!can(session.actor, 'operators:manage')) notFound();
  const users = await listOperators(ctx.pool, session.actor);
  const invitations = await listInvitations(ctx.pool, session.actor);
  const error = errorMessage((await searchParams).error);
  return <main id="main" className="wide">
    <h1>Operators</h1>
    <p>Accounts that can sign in to this household. Invite someone with a one-time link.</p>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="card">
      <h2>People with access</h2>
      <table className="stack">
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Change</th></tr></thead>
        <tbody>{users.map((u) => <tr key={u.id}>
          <td data-label="Name">{u.displayName}</td><td data-label="Email">{u.email}</td><td data-label="Role">{label(u.role)}</td>
          <td data-label="Status"><span className={u.status === 'active' ? 'pill' : 'pill neutral'}>{label(u.status)}</span></td>
          <td data-label="Change"><form method="post" action="/api/operators/update">
            <input type="hidden" name="csrf" value={session.csrf} />
            <input type="hidden" name="userId" value={u.id} />
            <input type="hidden" name="version" value={u.version} />
            <select name="role" defaultValue={u.role} aria-label={`Role for ${u.displayName}`}><option>operator</option><option>admin</option></select>
            <select name="status" defaultValue={u.status} aria-label={`Status for ${u.displayName}`}><option>active</option><option>disabled</option></select>
            <button type="submit" className="secondary">Save</button>
          </form></td>
        </tr>)}</tbody>
      </table>
    </div>
    {invitations.length > 0 && <div className="card">
      <h2>Open invitations</h2>
      <table className="stack">
        <thead><tr><th>Email</th><th>Role</th><th>Expires</th><th>Action</th></tr></thead>
        <tbody>{invitations.map((i) => <tr key={i.id}>
          <td data-label="Email">{i.email}</td><td data-label="Role">{label(i.role)}</td><td data-label="Expires">{dateOf(i.expiresAt)}</td>
          <td data-label="Action"><form method="post" action="/api/operators/invitations/revoke">
            <input type="hidden" name="csrf" value={session.csrf} />
            <input type="hidden" name="invitationId" value={i.id} />
            <button type="submit" className="secondary">Revoke</button>
          </form></td>
        </tr>)}</tbody>
      </table>
      <p className="muted">To re-issue a link, revoke the invitation and invite the address again.</p>
    </div>}
    <form className="card" method="post" action="/api/operators/invite">
      <h2>Invite an operator</h2>
      <input type="hidden" name="csrf" value={session.csrf} />
      <label htmlFor="email">Email</label>
      <input id="email" name="email" type="email" required maxLength={254} />
      <label htmlFor="role">Role</label>
      <select id="role" name="role" defaultValue="operator"><option>operator</option><option>admin</option></select>
      <button type="submit">Create one-time link</button>
    </form>
  </main>;
}
