import Link from 'next/link';
import { notFound } from 'next/navigation';
import { can } from '../../../server/authz.ts';
import { listInvitations, listOperators } from '../../../server/services/operators.ts';
import { AddDialog } from '../../components/AddDialog.tsx';
import { errorMessage } from '../../components/messages.ts';
import { dateOf, flat, roleLabel, requireSession } from '../../components/ui.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Users · TallyMed' };

export default async function UsersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { ctx, ...session } = await requireSession();
  if (!can(session.actor, 'operators:manage')) notFound();
  const users = await listOperators(ctx.pool, session.actor);
  const invitations = await listInvitations(ctx.pool, session.actor);
  const q = await flat(searchParams);
  const error = errorMessage(q.error);
  // A failed invitation comes back with `add=1`, so its message shows in the reopened dialog; other errors stay on the page.
  const adding = q.add === '1';
  return <main id="main" className="wide">
    <div className="page-head">
      <h1>Users</h1>
      <AddDialog label="Invite user" title="Invite a user" open={adding}>
        {adding && error && <p className="error" role="alert">{error}</p>}
        <form method="post" action="/api/operators/invite">
          <input type="hidden" name="csrf" value={session.csrf} />
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" required maxLength={254} />
          <label htmlFor="role">Role</label>
          <select id="role" name="role" defaultValue="operator"><option value="operator">{roleLabel('operator')}</option><option value="admin">{roleLabel('admin')}</option></select>
          <button type="submit">Create one-time link</button>
        </form>
      </AddDialog>
    </div>
    <p>Accounts that can sign in to this household. Invite someone with a one-time link.</p>
    {!adding && error && <p className="error" role="alert">{error}</p>}
    <div className="card">
      <h2>People with access</h2>
      <table className="stack users">
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Password</th><th><span className="sr-only">Save changes</span></th></tr></thead>
        <tbody>{users.map((u) => {
          const self = u.id === session.actor.userId;
          const formId = `user-${u.id}`;
          return <tr key={u.id}>
            <td data-label="Name">{u.displayName}{self && <> <span className="pill neutral">You</span></>}</td>
            <td data-label="Email">{u.email}</td>
            <td data-label="Role">
              <select form={formId} name="role" defaultValue={u.role} aria-label={`Role for ${u.displayName}`}>
                <option value="operator">{roleLabel('operator')}</option><option value="admin">{roleLabel('admin')}</option>
              </select>
            </td>
            <td data-label="Status">
              <select form={formId} name="status" defaultValue={u.status} aria-label={`Status for ${u.displayName}`}>
                <option value="active">Active</option><option value="disabled">Disabled</option>
              </select>
            </td>
            <td data-label="Password">
              {self ? <Link className="button secondary" href="/account/password">Change password</Link>
                : u.status === 'active' ? <Link className="button secondary" href={`/users/${u.id}/reset-password`}>Reset password</Link>
                  : <span className="muted">Set status to Active to reset</span>}
              {u.pendingReset && <span className="muted note">{u.pendingReset.state === 'open' ? `Temporary password pending, expires ${dateOf(u.pendingReset.expiresAt)}`
                : u.pendingReset.state === 'used' ? 'Temporary password used, new password not chosen yet' : 'Temporary password expired'}</span>}
            </td>
            <td data-label="Save changes"><form id={formId} method="post" action="/api/operators/update">
              <input type="hidden" name="csrf" value={session.csrf} />
              <input type="hidden" name="userId" value={u.id} />
              <input type="hidden" name="version" value={u.version} />
              <button type="submit" className="secondary" aria-label={`Save role and status for ${u.displayName}`}>Save</button>
            </form></td>
          </tr>;
        })}</tbody>
      </table>
      <p className="muted">Reset password creates a one-time temporary password for someone else. To change your own, use Change password here or in the user menu.</p>
    </div>
    {invitations.length > 0 && <div className="card">
      <h2>Open invitations</h2>
      <table className="stack">
        <thead><tr><th>Email</th><th>Role</th><th>Expires</th><th>Action</th></tr></thead>
        <tbody>{invitations.map((i) => <tr key={i.id}>
          <td data-label="Email">{i.email}</td><td data-label="Role">{roleLabel(i.role)}</td><td data-label="Expires">{dateOf(i.expiresAt)}</td>
          <td data-label="Action"><form method="post" action="/api/operators/invitations/revoke">
            <input type="hidden" name="csrf" value={session.csrf} />
            <input type="hidden" name="invitationId" value={i.id} />
            <button type="submit" className="secondary">Revoke</button>
          </form></td>
        </tr>)}</tbody>
      </table>
      <p className="muted">To re-issue a link, revoke the invitation and invite the address again.</p>
    </div>}
  </main>;
}
