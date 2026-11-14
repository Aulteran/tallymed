// Server-wide backup and restore for administrators.
//
// Backup: admin-only, confirmed with the administrator's own password, one at a time per server process, audited when it starts and when it
// ends. The archive is streamed to the browser as it is produced; nothing is written to the server's disk.
// Restore: only into an installation that has never been set up, and only for someone who holds the setup token (the same proof that
// creates the first administrator). The upload is spooled to a private temporary file, verified in full, then loaded in one transaction.
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import type { AppConfig } from '../config.ts';
import { authorize, type Actor } from '../authz.ts';
import { BackupError, MAX_PASSPHRASE_LENGTH, MIN_PASSPHRASE_LENGTH, limitStream } from '../backup/archive.ts';
import { createBackup, restoreArchive, type CreatedBackup, type RestoreResult } from '../backup/engine.ts';
import type { Pool } from '../db.ts';
import { AppError } from '../errors.ts';
import { log, logError } from '../log.ts';
import { recordAudit } from '../repositories/audit.ts';
import { checkSetupToken, closeSetup } from '../setup-token.ts';
import type { ObjectStore } from '../storage.ts';
import { parse } from '../validation.ts';
import { isBootstrapped } from './bootstrap.ts';
import { confirmPassword } from './settings.ts';

/** Turns an engine refusal into the client-safe error the pages know how to explain. The message is already safe to show. */
export function toAppError(error: unknown): unknown {
  if (!(error instanceof BackupError)) return error;
  switch (error.code) {
    case 'passphrase_required': case 'passphrase_wrong': return new AppError('backup_passphrase', error.message);
    case 'incompatible': return new AppError('backup_incompatible', error.message);
    case 'not_empty': return new AppError('restore_not_empty', error.message);
    case 'storage_unavailable': return new AppError('storage_unavailable', error.message);
    case 'source_inconsistent': return new AppError('backup_failed', error.message);
    case 'too_large': return new AppError('payload_too_large', error.message);
    default: return new AppError('backup_invalid', error.message);
  }
}

const noCtl = (s: string) => !/[\u0000-\u001f\u007f]/.test(s);
const optionalPassphrase = z.preprocess((v) => (v === undefined ? '' : v), z.string().max(MAX_PASSPHRASE_LENGTH).refine(noCtl, 'invalid'));
const backupSchema = z.strictObject({
  csrf: z.string().optional(), currentPassword: z.string().min(1).max(256), passphrase: optionalPassphrase, passphraseConfirm: optionalPassphrase,
});

let backupRunning = false;
export const resetBackupStateForTests = () => { backupRunning = false; restoreRunning = false; };

/**
 * Starts a backup for an administrator. Returns the archive stream; the caller sends it as the response body. The start is audited before
 * the first byte, and the outcome (size and SHA-256 of the file as downloaded, or the failure) when the stream ends.
 */
export async function startBackup(
  ctx: { pool: Pool; config: AppConfig; store?: ObjectStore | null }, actor: Actor, input: unknown, requestId: string,
): Promise<CreatedBackup> {
  authorize(actor, 'settings:manage');
  const d = parse(backupSchema, input);
  if (d.passphrase !== d.passphraseConfirm) throw new AppError('invalid_input', 'The two passphrases do not match');
  if (d.passphrase !== '' && d.passphrase.length < MIN_PASSPHRASE_LENGTH) throw new AppError('invalid_input', `Use a passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters, or leave it empty`);
  await confirmPassword(ctx.pool, actor, d.currentPassword, requestId);
  if (backupRunning) throw new AppError('busy', 'A backup is already being made', 30);
  backupRunning = true;
  try {
    const backup = createBackup(ctx.pool, ctx.store ?? null, { passphrase: d.passphrase || null });
    const entry = { householdId: actor.householdId, actorUserId: actor.userId, entityType: 'backup', entityId: backup.backupId, requestId };
    await recordAudit(ctx.pool, { ...entry, action: 'backup.started', detail: { encrypted: backup.encrypted } });
    backup.done.then(
      (o) => recordAudit(ctx.pool, { ...entry, action: 'backup.completed', detail: { encrypted: o.encrypted, bytes: o.bytes, sha256: o.sha256, rows: o.rows, documents: o.documents } }),
      (error: unknown) => {
        const e = error as { code?: string; name?: string } | null;
        const cancelled = e?.code === 'ERR_STREAM_PREMATURE_CLOSE' || e?.code === 'ABORT_ERR' || e?.name === 'AbortError';
        const reason = error instanceof BackupError ? error.code : cancelled ? 'download_cancelled' : 'internal';
        if (reason === 'internal') logError('backup.failed', error, { requestId });
        return recordAudit(ctx.pool, { ...entry, action: 'backup.failed', detail: { reason } });
      },
    ).catch((error: unknown) => logError('backup.audit_failed', error, { requestId })).finally(() => { backupRunning = false; });
    return backup;
  } catch (error) {
    backupRunning = false;
    throw error;
  }
}

export interface BackupEvent { action: string; occurredAt: Date; actorName: string | null; detail: Record<string, string | number | boolean | null> }

/** The last few backup and restore events, for the settings page. */
export async function recentBackupEvents(pool: Pool, actor: Actor, limit = 8): Promise<BackupEvent[]> {
  authorize(actor, 'settings:manage');
  const r = await pool.query<BackupEvent>(
    `select a.action, a.occurred_at as "occurredAt", u.display_name as "actorName", a.detail
       from audit_events a left join users u on u.id = a.actor_user_id
      where a.household_id = $1 and a.action in ('backup.completed', 'backup.failed', 'backup.restored')
      order by a.id desc limit $2`,
    [actor.householdId, limit]);
  return r.rows;
}

let restoreRunning = false;

/**
 * Restores an uploaded backup into an installation that has never been set up. The order mirrors first-run setup: a completed installation
 * answers not_found, the setup token (with its attempt limit) is checked before any byte of the upload is read, and the upload is bounded.
 */
export async function restoreFromSetup(
  ctx: { pool: Pool; config: AppConfig; store?: ObjectStore | null },
  input: { setupToken: string; passphrase: string | null; body: ReadableStream<Uint8Array> | null; declaredLength: number | null; ip: string | null; requestId: string },
): Promise<RestoreResult> {
  if (await isBootstrapped(ctx.pool)) throw new AppError('not_found');
  if (input.setupToken.length < 1 || input.setupToken.length > 200) throw new AppError('invalid_setup_token', 'Setup token not accepted');
  checkSetupToken(ctx.config, input.setupToken, input.ip);
  if (input.passphrase !== null && (input.passphrase.length > MAX_PASSPHRASE_LENGTH || !noCtl(input.passphrase))) throw new AppError('invalid_input');
  if (!input.body) throw new AppError('invalid_input', 'Choose a backup file');
  if (input.declaredLength !== null && input.declaredLength > ctx.config.restoreMaxBytes) throw new AppError('payload_too_large');
  if (restoreRunning) throw new AppError('busy', 'A restore is already running', 30);
  restoreRunning = true;
  // Beside the documents when there is a document volume (it is private and sized for them), otherwise the system temporary directory.
  const base = ctx.config.documentsDir ? path.join(ctx.config.documentsDir, 'restore-tmp') : tmpdir();
  let dir: string | null = null;
  try {
    await mkdir(base, { recursive: true, mode: 0o700 });
    dir = await mkdtemp(path.join(base, 'tallymed-restore-'));
    const file = path.join(dir, 'upload');
    await pipeline(Readable.fromWeb(input.body as Parameters<typeof Readable.fromWeb>[0]), limitStream(ctx.config.restoreMaxBytes), createWriteStream(file, { mode: 0o600, flags: 'wx' }));
    const result = await restoreArchive(ctx.pool, ctx.store ?? null, file, { passphrase: input.passphrase, via: 'setup', requestId: input.requestId });
    closeSetup();
    log('info', 'backup.restored', { requestId: input.requestId, rows: result.rows, documents: result.documents });
    return result;
  } catch (error) {
    throw toAppError(error);
  } finally {
    restoreRunning = false;
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
