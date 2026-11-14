// Self-service "forgot password": the person enters their email address and a temporary password is emailed to the address on file.
//
// Design rules (see docs/security.md):
//  * Same observable response for every address: a known one, an unknown one, a disabled account, a limited request. The work done
//    before responding is the same too (a temporary password is generated and hashed either way), and the email is sent after the
//    response, so neither content nor timing reveals whether an account exists.
//  * A request can never lock anybody out. The emailed credential is held in password_resets.secret_hash and does not replace the
//    account's password until it is used to sign in; until then the current password, the sessions and the sign-in lockout are untouched.
//    Using it requires the mailbox, signs every other session out and puts the account in the forced-change state of PR #14.
//  * Strict limits that do not depend on whether the account exists: per client address, per submitted address, per account (a
//    minimum gap and a daily cap, counted from the credentials actually issued, including ones whose delivery failed) and a
//    process-wide sub-budget for reset mail so anonymous requests cannot use up the whole email allowance.
//  * The message goes only to the address stored on the account, never to anything taken from the request, and contains no link.
import type { AppConfig } from '../config.ts';
import { AppError } from '../errors.ts';
import { withTransaction, type Pool, type Queryable } from '../db.ts';
import { isEmailConfigured, sendEmail, type EmailResult } from '../email.ts';
import { log } from '../log.ts';
import { hashPassword } from '../passwords.ts';
import { SlidingWindowLimiter } from '../rate-limit.ts';
import { recordAudit } from '../repositories/audit.ts';
import {
  countRequests, emailResetHistory, findPending, insertReset, lockRequestKeys, recordRequest, supersedeOpenEmailResets, supersedePending,
} from '../repositories/password-resets.ts';
import { findUserByEmail, findUserInHousehold } from '../repositories/users.ts';
import { refreshRuntimeConfig } from '../settings.ts';
import { digest } from '../tokens.ts';
import { generateTemporaryPassword } from './credentials.ts';

export const REQUEST_WINDOW_SECONDS = 3600;
/** Requests per submitted address per hour, whether or not it has an account. */
export const ADDRESS_REQUESTS_PER_HOUR = 5;
/** Requests per client address per hour (a trusted proxy supplies it; without one all callers share the untrusted budget). */
export const IP_REQUESTS_PER_HOUR = 10;
export const UNTRUSTED_REQUESTS_PER_HOUR = 30;
/** Per account: at most this many emailed credentials per 24 hours, and never two closer together than the gap. */
export const ACCOUNT_SENDS_PER_DAY = 3;
export const ACCOUNT_MIN_GAP_SECONDS = 600;
/** Reset emails the whole process may send per hour; below the helper's own 60 so other email features keep headroom. */
export const RESET_EMAILS_PER_HOUR = 20;
/** An emailed temporary password is valid for at most this long. */
export const EMAIL_PASSWORD_MAX_SECONDS = 3600;

const resetMailLimiter = new SlidingWindowLimiter(RESET_EMAILS_PER_HOUR, 3600_000);
export const resetForgotPasswordLimiterForTests = () => resetMailLimiter.reset();

const requestKey = (email: string) => digest(`forgot-password:${email.trim().toLowerCase()}`);

export interface ForgotPasswordOutcome {
  /** Resolves when background delivery (if any) has finished. Callers answering a request must not wait for it. */
  delivery: Promise<void>;
}

function emailText(displayName: string, temporaryPassword: string, minutes: number): string {
  return [
    `Hello ${displayName.replace(/[\r\n]+/g, ' ').slice(0, 80)},`,
    '',
    'Someone asked to reset the password for your TallyMed account. Your temporary password is:',
    '',
    `    ${temporaryPassword}`,
    '',
    `It works once and expires in ${minutes} minutes. Sign in with it at the usual TallyMed sign-in page and you will be asked to choose a new password.`,
    '',
    'If you asked more than once, use the newest message: a newer request cancels an older temporary password.',
    '',
    'If you did not ask for this, ignore this message. Nothing has changed: your current password still works, and the temporary password',
    'above is cancelled the next time you sign in with your current password. Tell an administrator if these emails keep arriving.',
    '',
    'TallyMed',
  ].join('\n');
}

/**
 * Handles one request. Throws only for conditions that do not depend on the address: email not configured, malformed input, or the
 * client address being over its own limit. Everything else returns normally.
 */
export async function requestPasswordReset(
  pool: Pool, config: AppConfig, input: { email: string; ip: string | null; requestId: string },
): Promise<ForgotPasswordOutcome> {
  await refreshRuntimeConfig(config, pool);
  if (!(await isEmailConfigured(pool, config))) throw new AppError('email_not_configured');
  const emailHash = requestKey(input.email);
  // Stored and locked as a digest, like the address, so the request table holds no client address in the clear.
  const ipKey = digest(`forgot-ip:${input.ip ?? 'untrusted'}`).toString('hex');
  const ipLimit = input.ip ? IP_REQUESTS_PER_HOUR : UNTRUSTED_REQUESTS_PER_HOUR;

  // Count and record under per-address and per-client locks. Limited requests are not recorded, so the window cannot be extended
  // indefinitely by hammering (which would let a stranger keep someone else's address blocked).
  const admitted = await withTransaction(pool, async (tx) => {
    await lockRequestKeys(tx, emailHash, ipKey);
    const counts = await countRequests(tx, emailHash, ipKey, REQUEST_WINDOW_SECONDS);
    if (counts.ip >= ipLimit) throw new AppError('rate_limited', 'Too many requests', REQUEST_WINDOW_SECONDS);
    if (counts.address >= ADDRESS_REQUESTS_PER_HOUR) return { limited: true as const };
    await recordRequest(tx, emailHash, ipKey);
    return { limited: false as const };
  });

  // The same work whatever the account: one random credential, one Argon2id hash.
  const temporaryPassword = generateTemporaryPassword();
  const secretHash = await hashPassword(temporaryPassword);
  const user = await findUserByEmail(pool, input.email);

  if (admitted.limited) {
    if (user) await recordAuditOnce(pool, user, input.requestId, 'address');
    log('info', 'auth.password_reset.limited', { requestId: input.requestId });
    return { delivery: Promise.resolve() };
  }
  if (!user) {
    log('info', 'auth.password_reset.unknown_account', { requestId: input.requestId });
    return { delivery: Promise.resolve() };
  }

  const lifetimeSeconds = Math.min(config.temporaryPasswordSeconds, EMAIL_PASSWORD_MAX_SECONDS);
  const issued = await withTransaction(pool, async (tx) => {
    // Re-read under the row lock: concurrent requests for one account serialize here, so the gap and daily cap cannot be raced.
    const locked = await findUserInHousehold(tx, user.householdId, user.id, true);
    if (!locked || locked.status !== 'active') return { skip: 'inactive' as const };
    // A live administrator-issued credential, or one already used and still awaiting a new password, is never replaced by a stranger's
    // request. Once it has expired, though, the person is locked out of both passwords, so a new emailed credential is the way back.
    if (locked.mustChangePassword) {
      const pending = await findPending(tx, locked.id, true);
      if (!pending || !pending.expired) return { skip: 'change_pending' as const };
    }
    const history = await emailResetHistory(tx, locked.id);
    if (history.lastDay >= ACCOUNT_SENDS_PER_DAY || (history.sinceNewestSeconds !== null && history.sinceNewestSeconds < ACCOUNT_MIN_GAP_SECONDS)) {
      if (history.lastDay >= ACCOUNT_SENDS_PER_DAY) await recordAuditOnce(tx, locked, input.requestId, 'account');
      return { skip: 'limited' as const };
    }
    if (resetMailLimiter.take('send') !== null) {
      return { skip: 'budget' as const };
    }
    await supersedePending(tx, locked.id);
    const expiresAt = new Date(Date.now() + lifetimeSeconds * 1000);
    const resetId = await insertReset(tx, {
      householdId: locked.householdId, userId: locked.id, kind: 'email_temporary', issuedBy: null, expiresAt, secretHash,
    });
    await recordAudit(tx, {
      householdId: locked.householdId, actorUserId: null, action: 'auth.password_reset_requested', entityType: 'password_reset', entityId: resetId,
      requestId: input.requestId, detail: { kind: 'email_temporary', userId: locked.id, expiresAt: expiresAt.toISOString() },
    });
    return { resetId, user: locked };
  });
  if (!('resetId' in issued) || !issued.user) {
    log('info', 'auth.password_reset.skipped', { requestId: input.requestId, why: 'skip' in issued ? issued.skip : 'unknown' });
    return { delivery: Promise.resolve() };
  }

  const resetId = issued.resetId;
  const target = issued.user;
  const delivery = (async () => {
    let result: EmailResult;
    try {
      // The address is the one stored on the account, never text from the request.
      result = await sendEmail({ db: pool, config }, {
        to: target.email, subject: 'Your TallyMed temporary password', text: emailText(target.displayName, temporaryPassword, Math.floor(lifetimeSeconds / 60)),
      }, { purpose: 'password_reset', requestId: input.requestId });
    } catch {
      result = { sent: false, reason: 'connect_failed' };
    }
    try {
      if (result.sent) {
        await recordAudit(pool, {
          householdId: target.householdId, actorUserId: null, action: 'auth.password_reset_email_sent', entityType: 'password_reset', entityId: resetId,
          requestId: input.requestId,
        });
      } else {
        // Nobody has the secret, so retire the credential; the attempt still counts toward the account's limits.
        await supersedeOpenEmailResets(pool, target.id, resetId);
        await recordAudit(pool, {
          householdId: target.householdId, actorUserId: null, action: 'auth.password_reset_email_failed', entityType: 'password_reset', entityId: resetId,
          requestId: input.requestId, detail: { reason: result.reason },
        });
      }
    } catch (error) {
      log('error', 'auth.password_reset.delivery_bookkeeping_failed', { requestId: input.requestId, errorName: (error as Error)?.name });
    }
  })();
  return { delivery };
}

/** Audit rows are append-only, so a daily cap is recorded once per day per account, not for every refused request. */
async function recordAuditOnce(
  tx: Queryable, user: { id: string; householdId: string }, requestId: string, limit: string,
): Promise<void> {
  const seen = await tx.query(
    `select 1 from audit_events where entity_id = $1 and action = 'auth.password_reset_limited' and detail ->> 'limit' = $2
        and occurred_at > now() - interval '24 hours' limit 1`,
    [user.id, limit],
  );
  if (seen.rowCount) return;
  await recordAudit(tx, {
    householdId: user.householdId, actorUserId: null, action: 'auth.password_reset_limited', entityType: 'user', entityId: user.id, requestId, detail: { limit },
  });
}
