// Helpers shared by the money services: idempotent claims, retry on lock conflicts and mapping of database guard errors.
import { createHash } from 'node:crypto';
import type { Actor } from '../authz.ts';
import type { Queryable } from '../db.ts';
import { AppError } from '../errors.ts';
import * as expenseRepo from '../repositories/expenses.ts';

export type Detail = Record<string, string | number | boolean | null>;

/** Stable hash of a request's logical input. Bigint values hash as decimal strings. */
export function fingerprint(input: Record<string, unknown>): string {
  const canonical = Object.keys(input).sort().map((k) => [k, input[k]]);
  return createHash('sha256').update(JSON.stringify(canonical, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).digest('hex');
}

/** Returns the stored result id for an exact replay, throws on the same key with different input, or null to proceed. */
export async function idempotent(tx: Queryable, actor: Actor, operation: string, key: string, input: Record<string, unknown>, resultId: string): Promise<string | null> {
  const claim = await expenseRepo.claimIdempotency(tx, {
    householdId: actor.householdId, actorUserId: actor.userId, operation, key, fingerprint: fingerprint(input), resultId,
  });
  if (!claim.replay) return null;
  if (!claim.sameInput) throw new AppError('conflict', 'That request key was already used with different details');
  return claim.resultId;
}

/**
 * Runs a whole transaction again when PostgreSQL aborts it for a lock cycle (40P01) or a serialization failure (40001).
 * Services take locks in a fixed order, so this is a backstop, not the normal path. Each attempt is a fresh transaction,
 * and an idempotency claim rolls back with it.
 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if ((code === '40P01' || code === '40001') && i < attempts) continue;
      throw mapDatabaseError(error);
    }
  }
}

/**
 * Commit-time guards raise check violations when a write would break a money invariant. They are the last line of defense
 * (the services check first under locks), so a hit means a concurrent writer or a direct SQL change. Report it as a conflict.
 */
export function mapDatabaseError(error: unknown): unknown {
  const e = error as { code?: string; constraint?: string };
  if (e?.code === '23514' && !(error instanceof AppError)) return new AppError('conflict', 'That change would break a payment or balance limit. Reload and check the current figures.');
  if (e?.code === '23505' && e.constraint === 'payment_entries_one_refund_reversal') return new AppError('conflict', 'That refund was already reversed');
  return error;
}

export const todayUtc = () => new Date().toISOString().slice(0, 10);
