import type { AppConfig } from '../config.ts';
import { AppError } from '../errors.ts';
import { withTransaction, type Pool } from '../db.ts';
import type { Actor } from '../authz.ts';
import { verifyPassword } from '../passwords.ts';
import { log } from '../log.ts';
import { recordAudit } from '../repositories/audit.ts';
import { findActiveSession, insertSession, revokeSession, touchSession } from '../repositories/sessions.ts';
import { clearAccountFailures, countRecentFailures, lockThrottleKeys, pruneAttempts, pruneKeys, recordAttempt } from '../repositories/throttle.ts';
import { findPending, markUsed } from '../repositories/password-resets.ts';
import { findUserByEmail, findUserInHousehold } from '../repositories/users.ts';
import { digest, emailKey, newToken } from '../tokens.ts';

export const THROTTLE_WINDOW_SECONDS = 15 * 60;
export const MAX_ACCOUNT_FAILURES = 5;
export const MAX_IP_FAILURES = 20;
const TOUCH_INTERVAL_MS = 60_000;

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
  input: { email: string; password: string; ip: string | null; requestId: string; previousToken?: string | null },
): Promise<LoginResult> {
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
  if (!user || !ok || user.status !== 'active') {
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
  const lifetimeSeconds = user.mustChangePassword
    ? Math.min(config.sessionAbsoluteSeconds, config.passwordChangeSessionSeconds) : config.sessionAbsoluteSeconds;
  const expiresAt = new Date(Date.now() + lifetimeSeconds * 1000);
  const outcome = await withTransaction(pool, async (tx) => {
    // Re-read under a row lock: the password was verified outside this transaction, so a concurrent reset, password change,
    // disable or temporary-password sign-in must not let this attempt through on stale credentials.
    const current = await findUserInHousehold(tx, user.householdId, user.id, true);
    if (!current || current.status !== 'active' || current.passwordHash !== user.passwordHash) return 'stale' as const;
    let resetId: string | null = null;
    if (current.mustChangePassword) {
      // The first successful sign-in with a temporary password consumes it. Expired or replaced credentials are refused even though
      // the password matched; a used one is refused while a session of the account is live (see below).
      const pending = await findPending(tx, current.id, true);
      if (!pending || pending.expired) return 'expired' as const;
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
      const prev = await findActiveSession(tx, digest(input.previousToken), config.sessionIdleSeconds);
      if (prev) await revokeSession(tx, prev.sessionId, 'rotated_at_login');
    }
    const sessionId = await insertSession(tx, {
      userId: user.id, householdId: user.householdId, tokenHash: digest(token), expiresAt,
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
      requestId: input.requestId, detail: resetId ? { restricted: true } : {},
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
    token, expiresAt, actor: { userId: user.id, householdId: user.householdId, role: user.role }, passwordChangeRequired: user.mustChangePassword,
  };
}

/** Resolves a cookie token to an actor, or null when absent, unknown, revoked, expired or idle. */
export async function authenticate(pool: Pool, config: AppConfig, token: string | null | undefined): Promise<Actor | null> {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const session = await findActiveSession(pool, digest(token), config.sessionIdleSeconds);
  if (!session) return null;
  if (Date.now() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) await touchSession(pool, session.sessionId);
  const { lastSeenAt: _ignored, ...actor } = session;
  return actor;
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
