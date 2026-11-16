import type { AppConfig } from '../config.ts';
import { AppError } from '../errors.ts';
import { withTransaction, type Pool } from '../db.ts';
import type { Actor } from '../authz.ts';
import { verifyPassword } from '../passwords.ts';
import { log } from '../log.ts';
import { recordAudit } from '../repositories/audit.ts';
import { findActiveSession, insertSession, markSessionLocked, revokeSession, revokeUserSessions, touchSession } from '../repositories/sessions.ts';
import { clearAccountFailures, countRecentFailures, lockThrottleKeys, pruneAttempts, pruneKeys, recordAttempt } from '../repositories/throttle.ts';
import { findOpenEmailReset, findPending, markUsed, supersedeOpenEmailResets } from '../repositories/password-resets.ts';
import { findUserByEmail, findUserInHousehold, setTemporaryPassword } from '../repositories/users.ts';
import { refreshRuntimeConfig } from '../settings.ts';
import { digest, emailKey, newToken } from '../tokens.ts';
import { signinState } from './signin.ts';

export const THROTTLE_WINDOW_SECONDS = 15 * 60;
export const MAX_ACCOUNT_FAILURES = 5;
export const MAX_IP_FAILURES = 20;
const TOUCH_INTERVAL_MS = 60_000;
/** Extra quiet time the server allows beyond the browser's idle timer before it locks a session on its own. */
export const LOCK_SERVER_SLACK_SECONDS = 60;

export interface LoginResult {
  token: string; expiresAt: Date; actor: Pick<Actor, 'userId' | 'householdId' | 'role'>;
  /** True when the sign-in used a temporary password: the session can only choose a new password or sign out. */
  passwordChangeRequired: boolean;
}

/**
 * Verifies credentials with throttling. Failures return one generic error whether or not the account
 * exists. A fresh token is always issued; the client never chooses the session identifier.
 * `ip` is null unless it came through the trusted proxy path, so spoofed headers never reach the keys.
 */
export async function login(
  pool: Pool, config: AppConfig,
  input: { email: string; password: string; ip: string | null; requestId: string; previousToken?: string | null; remember?: boolean },
): Promise<LoginResult> {
  await refreshRuntimeConfig(config, pool);
  // An administrator who signs in through the provider may have switched passwords off. Checked before any password work or counting.
  if (!(await signinState(pool, config)).passwordLogin) throw new AppError('password_login_disabled');
  const key = emailKey(input.email);
  const ipKey = input.ip ?? 'untrusted';
  // Check and reserve atomically: the attempt is recorded as a failure before the password is verified, under
  // per-account and per-address locks, so a concurrent burst cannot all read a count below the limit.
  // A successful login deletes the account's failure rows, including this reservation.
  const accountFailuresBefore = await withTransaction(pool, async (tx) => {
    await lockThrottleKeys(tx, key, input.ip);
    await pruneKeys(tx, key, input.ip, THROTTLE_WINDOW_SECONDS);
    const failures = await countRecentFailures(tx, key, input.ip, THROTTLE_WINDOW_SECONDS);
    if (failures.account >= MAX_ACCOUNT_FAILURES || failures.ip >= MAX_IP_FAILURES) {
      throw new AppError('rate_limited', 'Too many sign-in attempts', THROTTLE_WINDOW_SECONDS);
    }
    await recordAttempt(tx, key, ipKey, false);
    return failures.account;
  });
  if (Math.random() < 0.01) await pruneAttempts(pool, THROTTLE_WINDOW_SECONDS * 4).catch(() => undefined);
  const user = await findUserByEmail(pool, input.email);
  const ok = await verifyPassword(user?.passwordHash ?? null, input.password);
  // An emailed temporary password (forgot-password) is held beside the account's real password, which keeps working until it is used.
  // The second verification runs for every attempt, so timing does not reveal whether a reset is pending.
  // The second check runs for every failed attempt (known or not), so timing does not reveal a pending reset; a correct password skips it.
  const emailReset = !ok && user ? await findOpenEmailReset(pool, user.id) : null;
  const emailOk = ok ? false : await verifyPassword(emailReset?.secretHash ?? null, input.password);
  const viaEmail = !ok && emailOk && emailReset && !emailReset.expired ? emailReset : null;
  if (!user || (!ok && !viaEmail) || user.status !== 'active') {
    // Audit is append-only, so failed-login rows are bounded: only for existing accounts, and only the first
    // failure and the lockout in a window. Unknown addresses are logged without the address instead.
    if (user && accountFailuresBefore === 0) {
      await recordAudit(pool, {
        householdId: user.householdId, actorUserId: null, action: 'auth.login_failed', entityType: 'session', requestId: input.requestId,
      });
    } else if (user && accountFailuresBefore + 1 === MAX_ACCOUNT_FAILURES) {
      await recordAudit(pool, {
        householdId: user.householdId, actorUserId: null, action: 'auth.login_locked', entityType: 'session', requestId: input.requestId,
      });
    } else if (!user) {
      log('info', 'auth.login_failed.unknown_account', { requestId: input.requestId });
    }
    throw new AppError('unauthenticated', 'Invalid email or password');
  }
  const token = newToken();
  // A temporary-password session lives only long enough to choose a new password.
  // "Keep me signed in" never applies to the restricted session of a temporary password.
  const restricted = user.mustChangePassword || !!viaEmail;
  const remember = !!input.remember && !restricted;
  const lifetimeSeconds = restricted
    ? Math.min(config.sessionAbsoluteSeconds, config.passwordChangeSessionSeconds)
    : remember ? config.rememberSessionAbsoluteSeconds : config.sessionAbsoluteSeconds;
  const expiresAt = new Date(Date.now() + lifetimeSeconds * 1000);
  const outcome = await withTransaction(pool, async (tx) => {
    // Re-read under a row lock: the password was verified outside this transaction, so a concurrent reset, password change,
    // disable or temporary-password sign-in must not let this attempt through on stale credentials.
    const current = await findUserInHousehold(tx, user.householdId, user.id, true);
    if (!current || current.status !== 'active' || current.passwordHash !== user.passwordHash) return 'stale' as const;
    let resetId: string | null = null;
    if (viaEmail) {
      // First use of an emailed credential: it must still be the open one. A newer administrator reset supersedes it, so an open row proves nothing newer exists. The account may still be flagged
      // from an abandoned earlier reset: that is exactly the case this credential recovers from.
      const open = await findOpenEmailReset(tx, current.id, true);
      if (!open || open.id !== viaEmail.id || open.secretHash !== viaEmail.secretHash || open.expired) return 'expired' as const;
      if (!(await markUsed(tx, open.id))) return 'expired' as const;
      // Only now does the credential replace the password, with the same restricted state as an administrator reset. Every other
      // session is signed out: whoever holds the mailbox owns the account's recovery, and a lingering session must not outlive it.
      await setTemporaryPassword(tx, current.id, open.secretHash);
      await revokeUserSessions(tx, current.id, 'password_reset');
      resetId = open.id;
    } else if (current.mustChangePassword) {
      // The first successful sign-in with a temporary password consumes it. Expired or replaced credentials are refused even though
      // the password matched; a used one is refused while a session of the account is live (see below).
      const pending = await findPending(tx, current.id, true);
      // An open emailed credential is a separate secret: it never validates the stored hash (which belongs to an earlier, expired one).
      if (!pending || pending.expired || (pending.kind === 'email_temporary' && pending.status === 'open')) return 'expired' as const;
      if (pending.status === 'open') {
        if (!(await markUsed(tx, pending.id))) return 'expired' as const;
      } else {
        // Already used to sign in but no new password chosen yet (the restricted session lapsed or was lost). It may be used again
        // within its own expiry, but only while no session of the account is live, so a leaked copy cannot join a session in progress.
        // The user row lock held here serializes concurrent attempts.
        const live = await tx.query(
          'select 1 from sessions where user_id = $1 and revoked_at is null and expires_at > now() limit 1', [current.id]);
        if (live.rowCount) return 'expired' as const;
      }
      resetId = pending.id;
    }
    if (input.previousToken) {
      const prev = await findActiveSession(tx, digest(input.previousToken), config.sessionIdleSeconds, config.rememberSessionIdleSeconds);
      if (prev) await revokeSession(tx, prev.sessionId, 'rotated_at_login');
    }
    if (!resetId && !current.mustChangePassword && (await supersedeOpenEmailResets(tx, current.id)) > 0) {
      // Signing in with the real password cancels a pending emailed credential: it was not needed, and a leaked copy stops working.
      await recordAudit(tx, {
        householdId: user.householdId, actorUserId: user.id, action: 'auth.password_reset_cancelled', entityType: 'user', entityId: user.id,
        requestId: input.requestId, detail: { reason: 'signed_in_with_password' },
      });
    }
    const sessionId = await insertSession(tx, {
      userId: user.id, householdId: user.householdId, tokenHash: digest(token), expiresAt, remember,
    });
    await clearAccountFailures(tx, key);
    if (resetId) {
      await recordAudit(tx, {
        householdId: user.householdId, actorUserId: user.id, action: 'auth.temporary_password_used', entityType: 'password_reset',
        entityId: resetId, requestId: input.requestId,
      });
    }
    await recordAudit(tx, {
      householdId: user.householdId, actorUserId: user.id, action: 'auth.login', entityType: 'session', entityId: sessionId,
      requestId: input.requestId, detail: { ...(resetId ? { restricted: true } : {}), ...(remember ? { remember: true } : {}) },
    });
    return 'ok' as const;
  });
  if (outcome === 'stale') throw new AppError('unauthenticated', 'Invalid email or password');
  if (outcome === 'expired') {
    // The password matched, so the caller holds the credential and may be told why it no longer works. Audit stays bounded like
    // other failures: the attempt was already counted toward the lockout above.
    if (accountFailuresBefore === 0) {
      await recordAudit(pool, {
        householdId: user.householdId, actorUserId: null, action: 'auth.login_failed', entityType: 'session', requestId: input.requestId,
        detail: { reason: 'temporary_password_unusable' },
      });
    }
    throw new AppError('temporary_password_expired');
  }
  return {
    token, expiresAt, actor: { userId: user.id, householdId: user.householdId, role: user.role }, passwordChangeRequired: user.mustChangePassword || !!viaEmail,
  };
}

/**
 * Resolves a cookie token to an actor, or null when absent, unknown, revoked, expired or idle.
 *
 * Locking is decided here, once, for every route and page. A session is locked when the account has a PIN and either the lock was
 * set (by the person, or by the browser's idle timer) or the session has been quiet for `lockIdleSeconds`, which covers a browser that
 * was closed without locking. The idle rule is evaluated before the activity touch below, because the touch would erase it, and it is
 * stored at once so it cannot be undone by a later request. A locked session is not touched: a page left open cannot keep it fresh.
 * An account without a PIN, or one that must still replace a temporary password, is never locked.
 */
export async function authenticate(pool: Pool, config: AppConfig, token: string | null | undefined): Promise<Actor | null> {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  await refreshRuntimeConfig(config, pool);
  const session = await findActiveSession(pool, digest(token), config.sessionIdleSeconds, config.rememberSessionIdleSeconds);
  if (!session) return null;
  const quietMs = Date.now() - session.lastSeenAt.getTime();
  const lockable = session.hasPin && !session.mustChangePassword;
  // The browser's timer fires at `lockIdleSeconds` after the last activity; activity reaches the server at most every 30 s (heartbeat), so the
  // server rule waits a minute longer and can never lock someone the browser still counts as active. It is the backstop for a closed browser.
  const idleLocked = lockable && !session.lockedAt && quietMs > (config.lockIdleSeconds + LOCK_SERVER_SLACK_SECONDS) * 1000;
  if (idleLocked && (await markSessionLocked(pool, session.sessionId))) {
    await recordAudit(pool, {
      householdId: session.householdId, actorUserId: session.userId, action: 'auth.session_locked', entityType: 'session',
      entityId: session.sessionId, detail: { reason: 'idle' },
    });
  }
  const locked = lockable && (!!session.lockedAt || idleLocked);
  if (!locked && quietMs > TOUCH_INTERVAL_MS) await touchSession(pool, session.sessionId);
  const { lastSeenAt: _seen, lockedAt: _locked, ...actor } = session;
  return { ...actor, locked };
}

export async function logout(pool: Pool, actor: Actor, requestId: string): Promise<void> {
  await withTransaction(pool, async (tx) => {
    await revokeSession(tx, actor.sessionId, 'logout');
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'auth.logout', entityType: 'session',
      entityId: actor.sessionId, requestId,
    });
  });
}
