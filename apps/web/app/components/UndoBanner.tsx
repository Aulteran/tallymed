import { type Actor, can } from '../../server/authz.ts';
import { appContext } from '../../server/context.ts';
import { currentUndo } from '../../server/services/undo.ts';
import { Csrf, newKey } from './ui.tsx';
import { UndoCountdown } from './UndoCountdown.tsx';

const WHAT: Record<string, string> = {
  payment_remove: 'Payment removed.',
  plan_remove: 'Payment plan removed.',
  method_change: 'Payment method changed.',
};

/**
 * What the administrator can undo right now, read from the server-side slot (not from a flash message), so it disappears as soon as
 * another action replaces the slot or the window ends. Shows nothing for operators. The server enforces the window; the countdown is cosmetic.
 */
export async function UndoBanner({ actor, csrf }: { actor: Actor; csrf: string }) {
  if (!can(actor, 'records:remove')) return null;
  const slot = await currentUndo(appContext().pool, actor);
  if (!slot || slot.secondsRemaining <= 0) return null;
  const secs = Math.floor(slot.secondsRemaining);
  const spoken = `${Math.floor(secs / 60)} minutes ${secs % 60} seconds`;
  return <aside aria-label="Undo" className="undo-bar">
    <div role="status" className="undo-status">
      <span>{WHAT[slot.kind] ?? 'Change saved.'} You can undo it for about {spoken}, or until your next action.</span>
      <span className="undo-time">Time left <UndoCountdown seconds={secs} /></span>
      <form method="post" action="/api/expenses/undo">
        <Csrf token={csrf} /><input type="hidden" name="idempotencyKey" value={newKey()} />
        <button type="submit" className="secondary">Undo</button>
      </form>
    </div>
  </aside>;
}
