import { AppError } from '../errors.ts';
import { withTransaction, type Pool } from '../db.ts';
import type { Actor } from '../authz.ts';
import { assertPinPolicy, hashPin, verifyPassword, verifyPin } from '../passwords.ts';
import { recordAudit } from '../repositories/audit.ts';
import {
  clearPinAttempts, markSessionLocked, reservePinAttempt, revokeSession, unlockSessionRow,
} from '../repositories/sessions.ts';
import { clearAccountFailures, countRecentFailures, lockThrottleKeys, pruneKeys, recordAttempt } from '../repositories/throttle.ts';
import { findPin, findUserInHousehold, setPinHash } from '../repositories/users.ts';
import { parse, schemas } from '../validation.ts';
import { MAX_ACCOUNT_FAILURES, THROTTLE_WINDOW_SECONDS } from './auth.ts';
import { changeKey } from './credentials.ts';

/**
 * Wrong PINs allowed on one session. Six digits are only a million values, so the limit, not the hash, is the protection: the counter
 * is incremented before the PIN is checked (as sign-in reserves its attempt), so concurrent guesses cannot exceed it. Reaching the
 * limit signs the session out, the one place the lock ever does. Whoever then signs in again needs the password.
 */
export const MAX_PIN_FAILURES = 5;

export type UnlockResult = { status: 'ok' } | { status: 'wrong'; remaining: number } | { status: 'revoked' };

/** Locks the caller's own session. Refused for an account with no PIN, which could never be unlocked. */
export async function lockSession(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<void> {
  parse(schemas.lock, input);
  if (actor.mustChangePassword) throw new AppError('password_change_required');
  if (!actor.hasPin) throw new AppError('pin_not_set');
  if (actor.locked) return;
  if (await markSessionLocked(pool, actor.sessionId)) {
    await recordAudit(pool, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'auth.session_locked', entityType: 'session', entityId: actor.sessionId,
      requestId, detail: { reason: 'manual' },
    });
  }
}

/** Revokes a session after too many wrong PINs; the audit row is the only trace, and holds no PIN. */
async function endSession(pool: Pool, actor: Actor, requestId: string, context: 'unlock' | 'change'): Promise<void> {
  await withTransaction(pool, async (tx) => {
    await revokeSession(tx, actor.sessionId, 'pin_attempts_exceeded');
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: 'auth.pin_lockout', entityType: 'session', entityId: actor.sessionId,
      requestId, detail: { context },
    });
  });
}

/**
 * Counts one wrong-PIN attempt and checks the PIN. Returns 'ok', 'wrong' with the attempts left, or 'revoked' when this attempt (or an
 * earlier concurrent one) used up the limit. A session that is already gone is unauthenticated.
 */
async function tryPin(pool: Pool, actor: Actor, pinHash: string | null, pin: string, requestId: string, context: 'unlock' | 'change'): Promise<UnlockResult> {
  const attempt = await reservePinAttempt(pool, actor.sessionId);
  if (attempt === null) throw new AppError('unauthenticated');
  if (attempt > MAX_PIN_FAILURES) {
    await endSession(pool, actor, requestId, context);
    return { status: 'revoked' };
  }
  if (!(await verifyPin(pinHash, pin))) {
    if (attempt >= MAX_PIN_FAILURES) {
      await endSession(pool, actor, requestId, context);
      return { status: 'revoked' };
    }
    return { status: 'wrong', remaining: MAX_PIN_FAILURES - attempt };
  }
  return { status: 'ok' };
}

/** Unlocks the caller's own session with the PIN. Nothing but the lock changes: the session, its cookie and its lifetime stay as they were. */
export async function unlockSession(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<UnlockResult> {
  const data = parse(schemas.unlock, input);
  if (actor.mustChangePassword) throw new AppError('password_change_required');
  if (!/^\d{6}$/.test(data.pin)) throw new AppError('invalid_input', 'The PIN is six digits');
  const pin = await findPin(pool, actor.userId);
  if (!pin) throw new AppError('unauthenticated');
  if (pin.pinHash === null) {
    // The account has no PIN, so nothing can lock it; clear a stale lock rather than strand the session.
    await unlockSessionRow(pool, actor.sessionId);
    return { status: 'ok' };
  }
  const result = await tryPin(pool, actor, pin.pinHash, data.pin, requestId, 'unlock');
  if (result.status !== 'ok') return result;
  if (!(await unlockSessionRow(pool, actor.sessionId))) throw new AppError('unauthenticated');
  await recordAudit(pool, {
    householdId: actor.householdId, actorUserId: actor.userId, action: 'auth.session_unlocked', entityType: 'session', entityId: actor.sessionId, requestId,
  });
  return { status: 'ok' };
}

/**
 * Sets the first PIN, or changes it. The first PIN needs no proof beyond the unlocked session (the account has nothing to protect yet).
 * Changing it needs the current PIN or the account password, so someone at an unlocked, unattended screen cannot replace it. A
 * forgotten PIN is replaced by signing in again and using the password here. Wrong current PINs count against the session like unlock
 * attempts; wrong passwords share the password-change throttle.
 */
export async function changePin(
  pool: Pool, actor: Actor, input: unknown, requestId: string,
): Promise<{ status: 'ok'; first: boolean } | { status: 'wrong'; remaining: number } | { status: 'revoked' }> {
  const data = parse(schemas.changePin, input);
  if (actor.mustChangePassword) throw new AppError('password_change_required');
  assertPinPolicy(data.newPin);
  if (data.newPin !== data.confirmPin) throw new AppError('invalid_input', 'The two PINs do not match');
  const user = await findUserInHousehold(pool, actor.householdId, actor.userId);
  if (!user || user.status !== 'active') throw new AppError('unauthenticated');
  const current = await findPin(pool, actor.userId);
  const first = current?.pinHash == null;
  let passwordKey: Buffer | null = null;
  if (!first) {
    if (data.currentPin !== undefined && data.currentPassword !== undefined) throw new AppError('invalid_input', 'Give the current PIN or the password, not both');
    if (data.currentPin !== undefined) {
      if (!/^\d{6}$/.test(data.currentPin)) throw new AppError('invalid_input', 'The current PIN is six digits');
      const result = await tryPin(pool, actor, current!.pinHash, data.currentPin, requestId, 'change');
      if (result.status !== 'ok') return result;
    } else if (data.currentPassword !== undefined) {
      const key = changeKey(user.id);
      const before = await withTransaction(pool, async (tx) => {
        await lockThrottleKeys(tx, key, null);
        await pruneKeys(tx, key, null, THROTTLE_WINDOW_SECONDS);
        const failures = await countRecentFailures(tx, key, null, THROTTLE_WINDOW_SECONDS);
        if (failures.account >= MAX_ACCOUNT_FAILURES) throw new AppError('rate_limited', 'Too many attempts', THROTTLE_WINDOW_SECONDS);
        await recordAttempt(tx, key, 'untrusted', false);
        return failures.account;
      });
      if (!(await verifyPassword(user.passwordHash, data.currentPassword))) {
        if (before === 0) {
          await recordAudit(pool, {
            householdId: user.householdId, actorUserId: user.id, action: 'auth.pin_change_failed', entityType: 'user', entityId: user.id, requestId,
          });
        }
        throw new AppError('reauth_failed');
      }
      passwordKey = key;
    } else {
      throw new AppError('invalid_input', 'Enter your current PIN or your password');
    }
  }
  const pinHash = await hashPin(data.newPin);
  await withTransaction(pool, async (tx) => {
    // Re-read under the row lock: the proof was checked outside this transaction, so a concurrent PIN change must not be overwritten blind.
    const locked = await findPin(tx, actor.userId, true);
    if (!locked || (locked.pinHash === null) !== first) throw new AppError('conflict');
    if (!first && locked.pinHash !== current!.pinHash) throw new AppError('conflict');
    await setPinHash(tx, actor.userId, pinHash);
    await clearPinAttempts(tx, actor.sessionId);
    if (passwordKey) await clearAccountFailures(tx, passwordKey);
    await recordAudit(tx, {
      householdId: actor.householdId, actorUserId: actor.userId, action: first ? 'auth.pin_set' : 'auth.pin_changed', entityType: 'user',
      entityId: actor.userId, requestId, detail: { proof: first ? 'none' : data.currentPin !== undefined ? 'pin' : 'password' },
    });
  });
  return { status: 'ok', first };
}
