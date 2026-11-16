'use client';
import { useEffect, useRef, useState } from 'react';
import {
  centsOf, chipOrder, completeDay, formatCents, mergeWithNext, monthLabel, monthOf, moveByDays, moveByMonths, moveToMonth, nextChip, parseIso, restartFrom, setDay, splitRow, timelineMonths, typedDay,
  type TimelineEdit, type TimelineRow,
} from './installment-timeline.ts';

type Row = TimelineRow & { key: number };

const longDate = (iso: string) => { const p = parseIso(iso); const [name, year] = monthLabel(monthOf(iso) ?? '').split(' '); return p ? `${name} ${p.d}, ${year}` : iso; };
const money = (amount: string) => { const c = centsOf(amount); return c === null ? amount : formatCents(c); };

/**
 * A month-by-month picture of the installment table (progressive enhancement: the table below is the source of truth, the no-JavaScript path and
 * the keyboard path). Every action here only rewrites the table's rows through `onChange`, so what is posted never changes shape.
 * Mouse: drag a chip into another month. Touch and keyboard: pick a chip, then use the buttons or arrow keys. All actions are announced.
 */
export function InstallmentTimeline({ idPrefix, rows, onChange, cadenceId, makeRow, maxRows }: {
  idPrefix: string;
  rows: Row[];
  onChange: (rows: Row[]) => void;
  /** Id of the cadence select of the same form: the step a split uses. */
  cadenceId: string;
  makeRow: (dueDate: string, amount: string) => Row;
  maxRows: number;
}) {
  const [selectedKey, setSelectedKey] = useState<number | null>(null);
  const [month, setMonth] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [over, setOver] = useState<string | null>(null);
  const [dayDraft, setDayDraft] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const dragKey = useRef<number | null>(null);
  const refocus = useRef<number | null>(null);
  const id = (s: string) => `${idPrefix}-tl-${s}`;

  useEffect(() => {
    if (refocus.current === null) return;
    root.current?.querySelector<HTMLElement>(`[data-chip="${refocus.current}"]`)?.focus();
    refocus.current = null;
  });

  const cadence = () => (document.getElementById(cadenceId) as HTMLSelectElement | null)?.value ?? 'monthly';
  const index = selectedKey === null ? -1 : rows.findIndex((r) => r.key === selectedKey);
  const sel = index >= 0 ? rows[index]! : null;
  const { months, hidden } = timelineMonths(rows);
  const order = chipOrder(rows);
  const undated = rows.filter((r) => r.amount.trim() !== '' && !parseIso(r.dueDate)).length;
  const hasNext = index >= 0 && nextChip(rows, index) !== null;

  /** Applies an action's result: new rows, the same chip stays selected, and the change is announced. `edit` is null when the action did not apply. */
  const run = (edit: TimelineEdit<Row> | null, said: (rows: Row[], i: number) => string, refocusChip: boolean, refused = 'That change cannot be made.') => {
    if (!edit) { setMessage(refused); return; }
    // A chip must stay on the timeline: refuse a move past the last month shown.
    const moved = edit.rows[edit.selected]!;
    const m = monthOf(moved.dueDate);
    if (m && !timelineMonths(edit.rows).months.includes(m)) { setMessage('That change would move the installment past the end of the timeline.'); return; }
    onChange(edit.rows);
    setSelectedKey(moved.key);
    setDayDraft(null);
    if (refocusChip) refocus.current = moved.key;
    setMessage(said(edit.rows, edit.selected));
  };
  const n = (i: number) => `Installment ${i + 1}`;
  const movedTo = (r: Row[], i: number) => `${n(i)} moved to ${monthLabel(monthOf(r[i]!.dueDate)!)}, day ${parseIso(r[i]!.dueDate)!.d}`;
  const monthMoved = (r: Row[], i: number) => `${n(i)} moved to ${monthLabel(monthOf(r[i]!.dueDate)!)}`;
  const dayMoved = (r: Row[], i: number) => `${n(i)} moved to ${longDate(r[i]!.dueDate)}`;

  const onKey = (e: React.KeyboardEvent<HTMLButtonElement>, key: number) => {
    const i = rows.findIndex((r) => r.key === key);
    if (i < 0 || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); run(moveByMonths(rows, i, e.key === 'ArrowRight' ? 1 : -1), monthMoved, true); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); run(moveByDays(rows, i, e.key === 'ArrowDown' ? 1 : -1), dayMoved, true); }
    else if (e.key === 'Enter') { e.preventDefault(); setSelectedKey(key); setTimeout(() => document.getElementById(id('day'))?.focus(), 0); }
  };
  const drop = (target: string) => {
    setOver(null);
    const key = dragKey.current;
    dragKey.current = null;
    const i = key === null ? -1 : rows.findIndex((r) => r.key === key);
    if (i >= 0) run(moveToMonth(rows, i, target), monthMoved, true);
  };

  /** A day typed on the way (a "1" before the "5") only changes the date once it is whole: here, on Enter or when the field loses focus. Until then the date keeps its own day; an unusable value is dropped. */
  const applyTypedDay = () => {
    const draft = dayDraft;
    setDayDraft(null);
    if (draft === null || index < 0 || draft.trim() === '' || completeDay(draft) !== null) return;
    const d = typedDay(draft);
    if (d === null) setMessage('Enter a day from 1 to 31.'); else run(setDay(rows, index, d), dayMoved, false, 'Enter a day from 1 to 31.');
  };

  const dayOfSel = sel ? parseIso(sel.dueDate)?.d : undefined;
  return <div className="tl" ref={root} role="group" aria-labelledby={id('title')}>
    <p id={id('title')} className="tl-title">Schedule timeline</p>
    <p className="muted tl-hint" id={id('hint')}>
      Drag an installment to another month, or pick one and use the buttons. With an installment focused: Left and Right arrows move it a month, Up and Down arrows a day, Enter opens its editor.
      The table below stays in step.
    </p>
    {months.length === 0
      ? <p className="muted">Give a row a due date in the table and it appears here.</p>
      : <div className="tl-scroll">
        {months.map((m) => <div key={m} className="tl-col" data-month={m} data-over={over === m ? '' : undefined}
          onDragOver={(e) => { if (dragKey.current !== null) { e.preventDefault(); if (over !== m) setOver(m); } }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o === m ? null : o)); }}
          onDrop={(e) => { e.preventDefault(); drop(m); }}>
          <button type="button" className="tl-month secondary" aria-pressed={month === m} onClick={() => setMonth((x) => (x === m ? null : m))}>{monthLabel(m)}</button>
          <div className="tl-chips">
            {order.filter((i) => monthOf(rows[i]!.dueDate) === m).map((i) => {
              const r = rows[i]!;
              const cents = centsOf(r.amount);
              const amount = cents === null ? 'No amount' : formatCents(cents);
              return <button key={r.key} type="button" className="tl-chip" draggable data-chip={r.key} aria-pressed={r.key === selectedKey} aria-describedby={id('hint')}
                data-n={i + 1}
                onClick={() => setSelectedKey(r.key)} onFocus={() => setSelectedKey(r.key)} onKeyDown={(e) => onKey(e, r.key)}
                onDragStart={(e) => { dragKey.current = r.key; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(r.key)); setSelectedKey(r.key); }}
                onDragEnd={() => { dragKey.current = null; setOver(null); }}>
                <span className="tl-chip-n"><span className="sr-only">Installment </span><span aria-hidden="true">#</span>{i + 1}</span>
                <span className="tl-chip-amount">{amount}</span>
                <span className="tl-chip-day">day {parseIso(r.dueDate)!.d}<span className="sr-only">, due {r.dueDate}</span></span>
              </button>;
            })}
          </div>
        </div>)}
      </div>}
    {hidden > 0 && <p className="muted" role="note">{hidden} later installment{hidden === 1 ? ' is' : 's are'} beyond the months shown. Edit {hidden === 1 ? 'it' : 'them'} in the table.</p>}
    {undated > 0 && <p className="muted" role="note">{undated} row{undated === 1 ? ' has' : 's have'} an amount but no due date, so {undated === 1 ? 'it is' : 'they are'} not on the timeline.</p>}
    <div className="tl-panel" role="group" aria-label="Selected installment">
      {sel && dayOfSel !== undefined ? <>
        <p><strong>Installment {index + 1}</strong>: {centsOf(sel.amount) === null ? 'no amount' : formatCents(centsOf(sel.amount)!)} due {sel.dueDate}.
          {month ? <> Selected month: {monthLabel(month)}.</> : <> Pick a month above to move or restart to it.</>}</p>
        <div className="tl-actions">
          <label htmlFor={id('day')}>Day of month</label>
          <input id={id('day')} type="number" min={1} max={31} inputMode="numeric" value={dayDraft ?? String(dayOfSel)}
            onChange={(e) => { setDayDraft(e.target.value); const d = completeDay(e.target.value); if (d !== null) run(setDay(rows, index, d), dayMoved, false, 'Enter a day from 1 to 31.'); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyTypedDay(); } }}
            onBlur={applyTypedDay} />
          <button type="button" className="secondary" onClick={() => run(moveByMonths(rows, index, -1), monthMoved, false)}>Earlier month</button>
          <button type="button" className="secondary" onClick={() => run(moveByMonths(rows, index, 1), monthMoved, false)}>Later month</button>
          <button type="button" className="secondary" disabled={!month} onClick={() => run(moveToMonth(rows, index, month!), movedTo, false)}>Move to month</button>
          <button type="button" className="secondary" disabled={!month} onClick={() => run(restartFrom(rows, index, month!), (r, i) => `${n(i)} and every later installment restarted from ${monthLabel(month!)}`, false)}>Restart here</button>
          <button type="button" className="secondary" disabled={(centsOf(sel.amount) ?? 0n) < 2n}
            onClick={() => run(splitRow(rows, index, cadence(), (r) => makeRow(r.dueDate, r.amount), maxRows), (r, i) => `${n(i)} split in two: ${money(r[i]!.amount)} and ${money(r[i + 1]!.amount)}`, false, 'That installment cannot be split (the table is full, or the amount is under two cents).')}>Split in two</button>
          <button type="button" className="secondary" disabled={!hasNext} onClick={() => run(mergeWithNext(rows, index), (r, i) => `${n(i)} merged with the next installment: ${money(r[i]!.amount)}`, true, 'Both installments need an amount to merge.')}>Merge with next</button>
        </div>
      </> : <p className="muted">Pick an installment to edit it here: move it, change its day, split it in two or merge it with the next one.</p>}
    </div>
    <p className="sr-only" role="status" aria-live="polite" data-tl-status>{message}</p>
  </div>;
}
