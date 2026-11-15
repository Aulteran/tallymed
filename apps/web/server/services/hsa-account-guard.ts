// The check every writer of an HSA link or direct payment runs. Kept apart from the account use cases so payment methods can use it without a cycle.
import type { Actor } from '../authz.ts';
import type { Queryable } from '../db.ts';
import { AppError } from '../errors.ts';
import * as repo from '../repositories/hsa-accounts.ts';

/** Takes a share lock on an active account, so an archive cannot slip in before commit. Last in the lock order. */
export async function requireActiveAccount(tx: Queryable, actor: Actor, accountId: string): Promise<void> {
  const a = await repo.getAccount(tx, actor.householdId, accountId, 'share');
  if (!a) throw new AppError('not_found');
  if (a.archivedAt) throw new AppError('conflict', 'That HSA account is archived. Restore it or choose another card.');
}
