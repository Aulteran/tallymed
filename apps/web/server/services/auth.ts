import type { AppConfig } from '../config.ts';
import { AppError } from '../errors.ts';
import { withTransaction, type Pool } from '../db.ts';
import type { Actor } from '../authz.ts';
import { verifyPassword } from '../passwords.ts';
import { recordAudit } from '../repositories/audit.ts';
import { findActiveSession, insertSession, revokeSession, touchSession } from '../repositories/sessions.ts';
import { clearAccountFailures, countRecentFailures, recordAttempt } from '../repositories/throttle.ts';
import { findUserByEmail } from '../repositories/users.ts';
import { digest, emailKey, newToken } from '../tokens.ts';

export const THROTTLE_WINDOW_SECONDS = 15 * 60;
export const MAX_ACCOUNT_FAILURES = 5;
export const MAX_IP_FAILURES = 20;
const TOUCH_INTERVAL_MS = 60_000;

export interface LoginResult { token: string; expiresAt: Date; actor: Pick<Actor, 'userId' | 'householdId' | 'role'> }

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
  const failures = await countRecentFailures(pool, key, input.ip, THROTTLE_WINDOW_SECONDS);
  if (failures.account >= MAX_ACCOUNT_FAILURES || failures.ip >= MAX_IP_FAILURES) {
    throw new AppError('rate_limited', 'Too many sign-in attempts', THROTTLE_WINDOW_SECONDS);
  }
  const user = await findUserByEmail(pool, input.email);
  const ok = await verifyPassword(user?.passwordHash ?? null, input.password);
  if (!user || !ok || user.status !== 'active') {
    await recordAttempt(pool, key, ipKey, false);
    await recordAudit(pool, {
      householdId: user?.householdId ?? null, actorUserId: null, action: 'auth.login_failed', entityType: 'session',
      requestId: input.requestId,
    });
    throw new AppError('unauthenticated', 'Invalid email or password');
  }
  const token = newToken();
  const expiresAt = new Date(Date.now() + config.sessionAbsoluteSeconds * 1000);
  await withTransaction(pool, async (tx) => {
    if (input.previousToken) {
      const prev = await findActiveSession(tx, digest(input.previousToken), config.sessionIdleSeconds);
      if (prev) await revokeSession(tx, prev.sessionId, 'rotated_at_login');
    }
    const sessionId = await insertSession(tx, {
      userId: user.id, householdId: user.householdId, tokenHash: digest(token), expiresAt,
    });
    await clearAccountFailures(tx, key);
    await recordAudit(tx, {
      householdId: user.householdId, actorUserId: user.id, action: 'auth.login', entityType: 'session', entityId: sessionId,
      requestId: input.requestId,
    });
  });
  return { token, expiresAt, actor: { userId: user.id, householdId: user.householdId, role: user.role } };
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
