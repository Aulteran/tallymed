import Link from 'next/link';
import { notFound } from 'next/navigation';
import { appContext } from '../../../server/context.ts';
import { isBootstrapped } from '../../../server/services/bootstrap.ts';
import { ensureSetupToken } from '../../../server/setup-token.ts';
import { AuthShell } from '../../components/AuthShell.tsx';
import { RestoreForm } from '../../components/RestoreForm.tsx';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Restore from a backup · TallyMed' };

/** Exists only while the installation is empty, like the setup page. Once an administrator exists this route is a plain 404. */
export default async function SetupRestorePage() {
  const ctx = appContext();
  if (await isBootstrapped(ctx.pool)) notFound();
  ensureSetupToken(ctx.config);
  return <AuthShell>
    <div className="card">
      <h1>Restore from a backup</h1>
      <p>Load a TallyMed backup file into this new installation instead of starting empty. Everything in the backup is restored: records, documents, user accounts and the audit log. Afterwards everyone signs in with the account and password they had on the old server.</p>
      <RestoreForm maxMb={Math.floor(ctx.config.restoreMaxBytes / 1048576)} documentsConfigured={ctx.config.documentsDir !== null} />
      <p><Link href="/setup">Start with an empty installation instead</Link></p>
    </div>
  </AuthShell>;
}
