// SQL only for the undo slot: one ephemeral row per user holding the inverse of their last removal or payment-method change. It is not a
// ledger (rows are updated and deleted freely, and it is not backed up). Every time comparison uses the DATABASE clock, never the server's.
import type { Actor } from '../authz.ts';
import { UNDO_WINDOW_SECONDS } from '../contracts.ts';
import type { Queryable } from '../db.ts';

export type UndoKind = 'payment_remove' | 'plan_remove' | 'method_change' | 'hsa_decision_remove' | 'hsa_claim_remove' | 'hsa_receipt_remove';

export interface UndoSlot { kind: UndoKind; entityId: string; payload: Record<string, unknown>; secondsRemaining: number }

/** Sets the actor's slot, replacing any earlier one, in the caller's transaction. The expiry is the database's now() plus the window. */
export async function setUndoSlot(db: Queryable, actor: Actor, v: { kind: UndoKind; entityId: string; payload: Record<string, unknown> }): Promise<void> {
  await db.query(
    `insert into undo_actions (user_id, household_id, kind, entity_id, payload, expires_at)
     values ($1, $2, $3, $4, $5::jsonb, now() + make_interval(secs => $6::int))
     on conflict (user_id) do update set household_id = excluded.household_id, kind = excluded.kind, entity_id = excluded.entity_id,
       payload = excluded.payload, expires_at = excluded.expires_at, created_at = now()`,
    [actor.userId, actor.householdId, v.kind, v.entityId, JSON.stringify(v.payload), UNDO_WINDOW_SECONDS]);
}

/** What the actor can undo right now, with the seconds left computed by the database. Null when absent or expired. */
export async function getUndoSlot(db: Queryable, actor: Actor): Promise<UndoSlot | null> {
  const { rows } = await db.query<{ kind: UndoKind; entityId: string; payload: Record<string, unknown>; secondsRemaining: number }>(
    `select kind, entity_id as "entityId", payload, greatest(0, ceil(extract(epoch from (expires_at - now()))))::int as "secondsRemaining"
     from undo_actions where user_id = $1 and household_id = $2 and expires_at > now()`, [actor.userId, actor.householdId]);
  return rows[0] ?? null;
}

/** The entity of the actor's slot whether or not it expired, without a lock: only to choose an idempotency result id before the real read. */
export async function peekUndoEntity(db: Queryable, actor: Actor): Promise<string | null> {
  const { rows } = await db.query<{ entityId: string }>(`select entity_id as "entityId" from undo_actions where user_id = $1 and household_id = $2`, [actor.userId, actor.householdId]);
  return rows[0]?.entityId ?? null;
}

/** Locks the actor's slot row for the transaction and returns it only while it has not expired (database clock) and is in the actor's household. */
export async function lockUndoSlot(db: Queryable, actor: Actor): Promise<UndoSlot | null> {
  const { rows } = await db.query<{ kind: UndoKind; entityId: string; payload: Record<string, unknown>; householdId: string; live: boolean }>(
    `select kind, entity_id as "entityId", payload, household_id as "householdId", expires_at > now() as live
     from undo_actions where user_id = $1 for update`, [actor.userId]);
  const r = rows[0];
  if (!r || !r.live || r.householdId !== actor.householdId) return null;
  return { kind: r.kind, entityId: r.entityId, payload: r.payload, secondsRemaining: 0 };
}

export async function clearUndoSlot(db: Queryable, actor: Pick<Actor, 'userId'>): Promise<void> {
  await db.query(`delete from undo_actions where user_id = $1`, [actor.userId]);
}
