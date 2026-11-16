// The undo action: the exact inverse of the actor's last removal or payment-method change, available until their next mutation or
// UNDO_WINDOW_SECONDS, whichever comes first. The window is checked by the DATABASE clock inside the transaction, with the slot row locked.
import { randomUUID } from 'node:crypto';
import { authorize, type Actor } from '../authz.ts';
import { withTransaction, type Pool } from '../db.ts';
import { AppError } from '../errors.ts';
import { recordAudit } from '../repositories/audit.ts';
import { recordPage } from '../repositories/hsa.ts';
import { clearUndoSlot, getUndoSlot, lockUndoSlot, peekUndoEntity, type UndoSlot } from '../repositories/undo.ts';
import { paymentSchemas, parse } from '../validation.ts';
import { undoMethodChange } from './payment-methods.ts';
import { restoreHsaRecord } from './hsa.ts';
import { restorePayment } from './payments.ts';
import { restorePlan } from './plans.ts';
import { idempotent, withRetry } from './support.ts';

/** What the actor can undo right now (kind, entity and seconds left from the database clock), or null. For the banner on a page. */
export async function currentUndo(pool: Pool, actor: Actor): Promise<Pick<UndoSlot, 'kind' | 'entityId' | 'secondsRemaining'> | null> {
  authorize(actor, 'records:remove');
  const slot = await getUndoSlot(pool, actor);
  return slot ? { kind: slot.kind, entityId: slot.entityId, secondsRemaining: slot.secondsRemaining } : null;
}

/**
 * Runs the inverse of the actor's slot and clears it, in one transaction. Missing, expired or foreign-household slots are all "Nothing to
 * undo" (no existence leak). One idempotency key is one undo: a replay returns the first result even though the slot is gone by then.
 *
 * Lock order: the slot row first, then the entity's locks in the usual order (payment, bills, plans, method, HSA account). Writers lock
 * the payment first and the slot last, so the same user's own removal and undo racing could in principle wait on each other; PostgreSQL
 * breaks that as a deadlock and `withRetry` runs the loser again. Other users never touch this user's slot (the pipeline deletes only
 * the actor's own).
 */
export type UndoTarget = 'payment' | 'plan' | 'hsa_decision' | 'hsa_claim' | 'hsa_receipt';
/**
 * `id` is the entity the slot held (a decision, claim or receipt id for the HSA kinds). `path` is set for the HSA kinds only: the page the redirect
 * lands on (an allocation page for a decision, /hsa/claims/<id>, /hsa/receipts/<id>); payments and plans keep the `target` + `id` routing.
 */
export async function undo(pool: Pool, actor: Actor, input: unknown, requestId: string): Promise<{ id: string; replayed: boolean; target: UndoTarget; path: string | null }> {
  authorize(actor, 'records:remove');
  const { csrf: _csrf, idempotencyKey } = parse(paymentSchemas.undo, input);
  return withRetry(() => withTransaction(pool, async (tx) => {
    // The idempotency record is claimed before the slot is judged, so a replay (whose slot is already gone) still answers with the first
    // result. The result id is the entity the slot held, peeked without a lock; if nothing is there the claim rolls back with the error.
    const resultId = (await peekUndoEntity(tx, actor)) ?? randomUUID();
    const replayId = await idempotent(tx, actor, 'undo', idempotencyKey, {}, resultId);
    if (replayId) {
      const { rows } = await tx.query(`select 1 from payment_plans where household_id = $1 and id = $2`, [actor.householdId, replayId]);
      if (rows.length > 0) return { id: replayId, replayed: true, target: 'plan' as const, path: null };
      const hsaPage = await recordPage(tx, actor.householdId, replayId);
      if (hsaPage) return { id: replayId, replayed: true, target: `hsa_${hsaPage.kind}` as const, path: hsaPage.path };
      return { id: replayId, replayed: true, target: 'payment' as const, path: null };
    }
    const slot = await lockUndoSlot(tx, actor);
    if (!slot) throw new AppError('conflict', 'Nothing to undo');
    if (slot.entityId !== resultId) throw new AppError('conflict', 'Nothing to undo');
    switch (slot.kind) {
      case 'payment_remove':
        await restorePayment(tx, actor, slot.entityId, slot.payload, requestId);
        break;
      case 'method_change':
        await undoMethodChange(tx, actor, slot.entityId, slot.payload);
        await recordAudit(tx, {
          householdId: actor.householdId, actorUserId: actor.userId, action: 'payment.paid_with_change_undone', entityType: 'payment', entityId: slot.entityId, requestId,
          detail: {
            paymentId: slot.entityId, restoredPaymentMethodId: typeof slot.payload.previousMethodId === 'string' ? slot.payload.previousMethodId : null,
            hsaFundingReinstated: slot.payload.fundingReleased === true,
          },
        });
        break;
      case 'plan_remove':
        await restorePlan(tx, actor, slot.entityId, slot.payload, requestId);
        break;
      case 'hsa_decision_remove':
      case 'hsa_claim_remove':
      case 'hsa_receipt_remove': {
        const kind = slot.kind === 'hsa_decision_remove' ? 'decision' : slot.kind === 'hsa_claim_remove' ? 'claim' : 'receipt';
        const restored = await restoreHsaRecord(tx, actor, kind, slot.entityId, requestId, slot.payload);
        await clearUndoSlot(tx, actor);
        return { id: slot.entityId, replayed: false, target: restored.target, path: restored.path };
      }
    }
    await clearUndoSlot(tx, actor);
    return { id: slot.entityId, replayed: false, target: slot.kind === 'plan_remove' ? 'plan' as const : 'payment' as const, path: null };
  }));
}
