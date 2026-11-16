import { AppError } from '../../server/errors.ts';
import { formatCents } from '../../server/money.ts';
import type { PlanPreview, PlanWarning } from '../../server/services/plans.ts';
import { InstallmentListError } from '../../server/plan-installments.ts';
import { errorMessage } from './messages.ts';

export type PreviewResult = { preview: PlanPreview } | { error: string; lines?: string[] };

/** What a preview shows when the typed list was too long to carry through the flash cookie: the saved list would be longer than any preview could show. */
export const TRIMMED_LIST_PREVIEW: PreviewResult = { error: 'the list is too long to carry through a Preview, so only its first part could be kept. Shorten it to preview it, or save it and check the plan page.' };

/**
 * Runs a preview read. An invalid schedule (or a refusal the save would make) comes back as the sentence to show in place of the
 * table; anything unexpected is rethrown. Only previews that the address asked for are computed.
 */
export async function tryPreview(run: () => Promise<PlanPreview>): Promise<PreviewResult> {
  try {
    return { preview: await run() };
  } catch (error) {
    // A listed schedule that could not be read: every line's problem, numbered, in place of the table.
    if (error instanceof InstallmentListError) return { error: 'the list of installments has problems.', lines: error.lines };
    if (error instanceof AppError && error.code !== 'not_found' && error.code !== 'internal') return { error: error.message !== error.code ? error.message : (errorMessage(error.code) ?? '') };
    throw error;
  }
}

const abs = (v: string) => { const n = BigInt(v); return formatCents(n < 0n ? -n : n); };

function warningText(w: PlanWarning): string {
  if (w.code === 'total_mismatch') {
    const more = BigInt(w.differenceCents) > 0n;
    return `The total you entered (${formatCents(w.expectedCents)}) does not match the installments (${formatCents(w.computedCents)}), which are ${abs(w.differenceCents)} ${more ? 'more' : 'less'}. It would be saved as the installments add up.`;
  }
  if (w.code === 'bill_balance_mismatch') {
    return `The plan would still schedule ${formatCents(w.planBasisCents)} (its total minus what is matched) and the bills it covers owe ${formatCents(w.openBalanceCents)}: ${abs(w.differenceCents)} ${w.direction} the balance.`;
  }
  return `The total does not divide evenly, so the installments differ by a few cents (${formatCents(w.minCents)} to ${formatCents(w.maxCents)}).`;
}

/**
 * What the form would save, as a table, with the warnings the plan would get. Shown inside the form that asked for it, whose fields
 * stay filled so the normal save button can be pressed next. Nothing has been written when this is on screen.
 */
export function PlanPreviewPanel({ result }: { result: PreviewResult }) {
  if ('error' in result) return <section className="card preview" aria-label="Preview of the schedule"><h3>Preview</h3>
    <div className="error" role="alert"><p>This would not be saved: {result.error}</p>{result.lines && <ul>{result.lines.map((t) => <li key={t}>{t}</li>)}</ul>}</div></section>;
  const p = result.preview;
  return <section className="card preview" aria-label="Preview of the schedule">
    <h3>Preview: nothing is saved yet</h3>
    <p>{p.count} installment{p.count === 1 ? '' : 's'} totalling <strong>{formatCents(p.totalCents)}</strong>{p.keptCount > 0 ? <>: {p.keptCount} kept ({formatCents((BigInt(p.totalCents) - BigInt(p.newCents)).toString())}) and {p.newCount} new ({formatCents(p.newCents)}).</> : '.'}</p>
    <table className="stack"><thead><tr><th>#</th><th>Due</th><th className="num">Amount</th><th>Status</th></tr></thead>
      <tbody>{p.rows.map((r, i) => <tr key={i}><td data-label="#">{i + 1}</td><td data-label="Due">{r.dueDate}</td><td data-label="Amount" className="num">{formatCents(r.amountCents)}</td><td data-label="Status">{r.kept ? 'kept, paid' : 'new'}</td></tr>)}</tbody></table>
    {(p.warnings.length > 0 || p.notes.length > 0) && <ul>{[...p.warnings.map(warningText), ...p.notes].map((t) => <li key={t}>{t}</li>)}</ul>}
    <p className="muted">Check it, then use the save button. Changing a field and pressing Preview again shows the new result.</p>
  </section>;
}

/**
 * A POST to the no-write preview route. The form's own CSRF token travels in its hidden input like any other post; the route keeps the typed
 * fields in the flash cookie and redirects back with only `?preview=<kind>`, so nothing typed (the reason and the name included) is in the address.
 * Put it after the save button, so Enter in a field saves.
 */
export const PreviewButton = ({ kind }: { kind: 'create' | 'revise' | 'restructure' }) => (
  <button type="submit" className="secondary" formMethod="post" formAction="/api/expenses/plans/preview" formNoValidate name="preview" value={kind}>Preview</button>
);
