'use client';
import { useEffect, useRef, useState } from 'react';

/** Most rows the table offers (the plan limit). */
export const MAX_INSTALLMENT_ROWS = 120;
/** Rows shown before anything is typed, with or without JavaScript. */
export const DEFAULT_INSTALLMENT_ROWS = 12;

interface Row { key: number; dueDate: string; amount: string }

/** Whole cents from a typed amount ("40", "40.5", "$1,250.00"); null when blank or not a plain amount. Integer arithmetic only, no floats. */
const centsOf = (v: string): bigint | null => {
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(v.trim().replace(/^\$/, '').replaceAll(',', ''));
  return m ? BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0') : null;
};
const formatCents = (v: bigint) => {
  const abs = v < 0n ? -v : v;
  return `${v < 0n ? '-' : ''}$${(abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${(abs % 100n).toString().padStart(2, '0')}`;
};

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const isoOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** The date after `prev` for a cadence. Monthly moves to the next month and keeps `anchorDay` (the first row's day of month), clamped to the month's last day. */
function nextDate(prev: string, cadence: string, anchorDay: number): string | null {
  const m = ISO.exec(prev);
  if (!m || Number.isNaN(Date.parse(prev))) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (cadence === 'weekly' || cadence === 'biweekly') return isoOf(Date.UTC(y, mo - 1, d) + (cadence === 'weekly' ? 7 : 14) * 86_400_000);
  // The zero-based index of the next month is `mo`.
  const year = y + Math.floor(mo / 12);
  const month = mo % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return isoOf(Date.UTC(year, month, Math.min(anchorDay, last)));
}

/**
 * The table of "List each installment" rows, posted as `inst.<n>.dueDate` and `inst.<n>.amount` (docs/contracts.md, "Form row lists").
 * Server-rendered it is plain fields (a blank row is ignored by the server), so it works without JavaScript. With JavaScript it adds
 * "Add row", "Remove row" (the rows are renumbered, so the indexes stay without gaps), "Fill down" and a live count and total in whole
 * cents (never floats). The server reads the rows again and decides; the footer is a hint.
 */
export function InstallmentRows({ idPrefix, values, cadenceId, totalId, modeId }: {
  idPrefix: string;
  /** Typed rows to put back after a Preview or an error. */
  values: Array<{ dueDate: string; amount: string }>;
  /** Ids of the cadence select and the total price input of the same form, read by "Fill down" and the footer. */
  cadenceId: string;
  totalId: string;
  /** Id of the "List each installment" radio: choosing it opens the list (without JavaScript the list opens when the form comes back in that mode). */
  modeId: string;
}) {
  const next = useRef(0);
  const make = (dueDate = '', amount = ''): Row => ({ key: next.current++, dueDate, amount });
  const [rows, setRows] = useState<Row[]>(() => Array.from({ length: Math.min(MAX_INSTALLMENT_ROWS, Math.max(DEFAULT_INSTALLMENT_ROWS, values.length)) }, (_, i) => make(values[i]?.dueDate ?? '', values[i]?.amount ?? '')));
  const [enhanced, setEnhanced] = useState(false);
  const [total, setTotal] = useState('');
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setEnhanced(true);
    const input = document.getElementById(totalId) as HTMLInputElement | null;
    const read = () => setTotal(input?.value ?? '');
    read();
    input?.addEventListener('input', read);
    return () => input?.removeEventListener('input', read);
  }, [totalId]);
  useEffect(() => {
    const radio = document.getElementById(modeId);
    const open = () => { const d = box.current?.closest('details'); if (d && (radio as HTMLInputElement | null)?.checked) d.open = true; };
    radio?.closest('fieldset')?.addEventListener('change', open);
    return () => radio?.closest('fieldset')?.removeEventListener('change', open);
  }, [modeId]);

  const set = (key: number, field: 'dueDate' | 'amount', value: string) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, [field]: value } : r)));
  /** Fills every wholly blank row that follows a row with a date and an amount: the same amount, the next date by the chosen cadence. */
  const fillDown = () => setRows((rs) => {
    const cadence = (document.getElementById(cadenceId) as HTMLSelectElement | null)?.value ?? 'monthly';
    const anchor = ISO.exec(rs[0]?.dueDate ?? '');
    const anchorDay = anchor ? Number(anchor[3]) : 1;
    const out = rs.map((r) => ({ ...r }));
    for (let i = 1; i < out.length; i++) {
      const prev = out[i - 1]!;
      const cur = out[i]!;
      if (cur.dueDate.trim() !== '' || cur.amount.trim() !== '' || centsOf(prev.amount) === null) continue;
      const date = nextDate(prev.dueDate, cadence, anchorDay);
      if (date) { cur.dueDate = date; cur.amount = prev.amount; }
    }
    return out;
  });

  let cents = 0n;
  let count = 0;
  for (const r of rows) {
    if (r.dueDate.trim() === '' && r.amount.trim() === '') continue;
    count += 1;
    cents += centsOf(r.amount) ?? 0n;
  }
  const totalCents = centsOf(total);
  const diff = totalCents === null ? null : cents - totalCents;

  return <div className="inst-rows" ref={box}>
    <div className="inst-head" aria-hidden="true"><span>#</span><span>Due date</span><span>Amount (USD)</span></div>
    {rows.map((r, i) => <div className="inst-row" key={r.key}>
      <span className="inst-n" aria-hidden="true">{i + 1}</span>
      <label className="sr-only" htmlFor={`${idPrefix}-inst-date-${r.key}`}>{`Due date of installment ${i + 1}`}</label>
      <input id={`${idPrefix}-inst-date-${r.key}`} name={`inst.${i}.dueDate`} type="date" value={r.dueDate} onChange={(e) => set(r.key, 'dueDate', e.target.value)} />
      <label className="sr-only" htmlFor={`${idPrefix}-inst-amount-${r.key}`}>{`Amount of installment ${i + 1} (USD)`}</label>
      <input id={`${idPrefix}-inst-amount-${r.key}`} name={`inst.${i}.amount`} inputMode="decimal" autoComplete="off" value={r.amount} onChange={(e) => set(r.key, 'amount', e.target.value)} />
      {enhanced && <button type="button" className="secondary" aria-label={`Remove row ${i + 1}`} onClick={() => setRows((rs) => (rs.length > 1 ? rs.filter((x) => x.key !== r.key) : rs))}>Remove</button>}
    </div>)}
    {enhanced && <p className="actions">
      <button type="button" className="secondary" disabled={rows.length >= MAX_INSTALLMENT_ROWS} onClick={() => setRows((rs) => (rs.length < MAX_INSTALLMENT_ROWS ? [...rs, make()] : rs))}>Add row</button>
      <button type="button" className="secondary" onClick={fillDown}>Fill down</button>
    </p>}
    <p className="muted" aria-live="polite" data-inst-summary>
      {enhanced ? <>{count} installment{count === 1 ? '' : 's'}, total {formatCents(cents)}
        {diff !== null && <>. Difference from total price: {formatCents(diff)}{diff === 0n ? '' : diff > 0n ? ' (the installments add up to more)' : ' (the installments add up to less)'}</>}</> : ''}
    </p>
  </div>;
}
