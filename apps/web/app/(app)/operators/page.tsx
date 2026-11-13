import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { can } from '../../../server/authz.ts';
import { appContext } from '../../../server/context.ts';
import { pageActor } from '../../../server/http.ts';
import { listOperators } from '../../../server/services/operators.ts';
import { errorMessage } from '../../components/messages.ts';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Operators · TallyMed' };

export default async function OperatorsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = appContext();
  const session = await pageActor(ctx, await headers());
  if (!session) redirect('/login');
  if (!can(session.actor, 'operators:manage')) notFound();
  const users = await listOperators(ctx.pool, session.actor);
  const error = errorMessage((await searchParams).error);
  return <main>
    <h1>Operators</h1>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="card">
      <table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Change</th></tr></thead>
        <tbody>{users.map((u) => <tr key={u.id}>
          <td>{u.displayName}</td><td>{u.email}</td><td>{u.role}</td><td>{u.status}</td>
          <td><form method="post" action="/api/operators/update">
            <input type="hidden" name="csrf" value={session.csrf} />
            <input type="hidden" name="userId" value={u.id} />
            <input type="hidden" name="version" value={u.version} />
            <select name="role" defaultValue={u.role} aria-label={`Role for ${u.displayName}`}><option>operator</option><option>admin</option></select>
            <select name="status" defaultValue={u.status} aria-label={`Status for ${u.displayName}`}><option>active</option><option>disabled</option></select>
            <button type="submit">Save</button>
          </form></td>
        </tr>)}</tbody>
      </table>
    </div>
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
