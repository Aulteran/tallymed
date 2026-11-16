'use client';
import { useEffect, useRef, useState } from 'react';

/** Most rows one form offers; the server accepts more (see ALLOC_FORM_ROWS in the HTTP routes, which keeps the typed values of this many). */
export const MAX_ALLOCATION_ROWS = 10;

export interface BillChoice { id: string; name: string }

/** Whole cents from a typed amount ("45", "45.5", "45.00"); null when blank or not a plain non-negative amount. Integer arithmetic only. */
const centsOf = (v: string): bigint | null => {
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(v.trim());
  return m ? BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0') : null;
};
const formatCents = (v: bigint) => `$${(v / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${(v % 100n).toString().padStart(2, '0')}`;

/**
 * Rows of "bill and amount to apply" that post as `alloc.<n>.billId` and `alloc.<n>.amount` (docs/contracts.md, "Form row lists").
 * The rows are plain server-rendered fields and a blank row is ignored, so the form works without JavaScript. With JavaScript it
 * also offers an "Add another bill" button and a live sum in whole cents (never floats). The server decides; the sum is a hint.
 */
export function AllocationRows({ idPrefix, bills, values, rows = 4, totalFrom, fixedTotalCents, wholeIfSole = false, summaryNoun }: {
  idPrefix: string;
  bills: BillChoice[];
  /** Typed values to put back after an error, keyed like the form fields (`alloc.0.billId`). */
  values: Record<string, string | undefined>;
  rows?: number;
  /** Id of the payment amount input whose value is the total to split (record payment). */
  totalFrom?: string;
  /** A known total instead (cash still unapplied on a payment, as integer cents text). */
  fixedTotalCents?: string;
  /** One bill with no amount applies the whole payment (record payment only). */
  wholeIfSole?: boolean;
  summaryNoun: string;
}) {
  let typed = 0;
  for (let i = 0; i < MAX_ALLOCATION_ROWS; i++) if (values[`alloc.${i}.billId`] || values[`alloc.${i}.amount`]) typed = i + 1;
  const [count, setCount] = useState(Math.min(MAX_ALLOCATION_ROWS, Math.max(rows, typed)));
  const [enhanced, setEnhanced] = useState(false);
  const [summary, setSummary] = useState('');
  const box = useRef<HTMLDivElement>(null);

  const recompute = () => {
    const root = box.current;
    if (!root) return;
    const total = fixedTotalCents !== undefined ? BigInt(fixedTotalCents) : centsOf((totalFrom && (document.getElementById(totalFrom) as HTMLInputElement | null)?.value) || '');
    let applied = 0n;
    let chosen = 0;
    let blankWithBill = 0;
    const seen = new Set<string>();
    let repeated = false;
    for (const row of root.querySelectorAll<HTMLElement>('[data-alloc-row]')) {
      const bill = row.querySelector<HTMLSelectElement>('select')!.value;
      const amount = centsOf(row.querySelector<HTMLInputElement>('input')!.value);
      if (bill) { chosen += 1; repeated ||= seen.has(bill); seen.add(bill); }
      if (amount !== null) applied += amount;
      else if (bill) blankWithBill += 1;
    }
    if (wholeIfSole && chosen === 1 && blankWithBill === 1 && total !== null) applied = total;
    const warn = repeated ? ' The same bill is chosen in two rows; list each bill once.' : '';
    if (applied === 0n && chosen === 0) { setSummary(''); return; }
    if (total === null) { setSummary(`Applying ${formatCents(applied)}.${warn}`); return; }
    setSummary((applied > total
      ? `Applying ${formatCents(applied)}, which is ${formatCents(applied - total)} more than the ${summaryNoun} of ${formatCents(total)}.`
      : `Applying ${formatCents(applied)} of ${formatCents(total)}; ${formatCents(total - applied)} left unapplied.`) + warn);
  };

  useEffect(() => {
    setEnhanced(true);
    const input = totalFrom ? document.getElementById(totalFrom) : null;
    input?.addEventListener('input', recompute);
    recompute();
    return () => input?.removeEventListener('input', recompute);
  }, []);
  useEffect(recompute, [count]);

  return <div ref={box} onInput={recompute} onChange={recompute}>
    {Array.from({ length: count }, (_, i) => {
      const bill = `${idPrefix}-bill-${i}`;
      const amount = `${idPrefix}-amount-${i}`;
      return <div key={i} data-alloc-row>
        <label htmlFor={bill}>{`Bill ${i + 1}${i === 0 ? ' (optional)' : ''}`}</label>
        <select id={bill} name={`alloc.${i}.billId`} defaultValue={values[`alloc.${i}.billId`] ?? ''}>
          <option value="">{i === 0 ? 'Leave unapplied for now' : 'No bill'}</option>
          {bills.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <label htmlFor={amount}>{`Amount to apply to bill ${i + 1} (USD)`}</label>
        <input id={amount} name={`alloc.${i}.amount`} inputMode="decimal" pattern="\d{1,12}(\.\d{1,2})?" defaultValue={values[`alloc.${i}.amount`]} />
      </div>;
    })}
    <p className="muted" aria-live="polite" data-alloc-summary>{summary}</p>
    {enhanced && count < MAX_ALLOCATION_ROWS && <p><button type="button" className="secondary" onClick={() => setCount((c) => Math.min(MAX_ALLOCATION_ROWS, c + 1))}>Add another bill</button></p>}
  </div>;
}
