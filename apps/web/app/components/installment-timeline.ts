// The pure date and cents logic behind the schedule timeline of "List each installment" (InstallmentRows.tsx). Plain TypeScript with no React, so
// `node --test` can import it. Money is whole cents in BigInt, never a float. Every function returns new rows and leaves its input alone; a row
// is `{ dueDate: 'YYYY-MM-DD' | '', amount: '40.00' | '' }` (what the table posts), plus anything else the caller keeps on it (a key).
// A row is a chip on the timeline when it has a real calendar date; the table rows are the source of truth and the timeline only rewrites them.

export interface TimelineRow { dueDate: string; amount: string }
/** The result of an action: the new rows and which row (an index into them) stays selected. `null` when the action does not apply. */
export interface TimelineEdit<T extends TimelineRow> { rows: T[]; selected: number }
export type Cadence = 'monthly' | 'weekly' | 'biweekly' | (string & {});

export const MAX_TIMELINE_ROWS = 120;
export const MAX_TIMELINE_MONTHS = 48;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_MS = 86_400_000;

// ---------- cents ----------
/** Whole cents from a typed amount ("40", "40.5", "$1,250.00"); null when blank or not a plain amount. */
export const centsOf = (v: string): bigint | null => {
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(v.trim().replace(/^\$/, '').replaceAll(',', ''));
  return m ? BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0') : null;
};
/** "$1,250.00" for display. */
export const formatCents = (v: bigint): string => {
  const abs = v < 0n ? -v : v;
  return `${v < 0n ? '-' : ''}$${(abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${(abs % 100n).toString().padStart(2, '0')}`;
};
/** "1250.00": the plain text a table cell holds (no $, no commas). */
export const amountText = (v: bigint): string => `${v / 100n}.${(v % 100n).toString().padStart(2, '0')}`;
/** The sum of every row that has a readable amount, in cents. */
export const totalCents = (rows: readonly TimelineRow[]): bigint => rows.reduce((s, r) => s + (centsOf(r.amount) ?? 0n), 0n);

// ---------- dates ----------
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
export interface Ymd { y: number; m: number; d: number }
/** A real calendar date as parts (m is 1 to 12), or null. */
export function parseIso(s: string): Ymd | null {
  const m = ISO.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  return { y, m: mo, d };
}
export const daysInMonth = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
export const toIso = ({ y, m, d }: Ymd): string => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
/** "YYYY-MM" of a date, or null. */
export const monthOf = (iso: string): string | null => { const p = parseIso(iso); return p ? `${pad(p.y, 4)}-${pad(p.m)}` : null; };
/** The index of a month on a single line of months (year * 12 + month - 1), from "YYYY-MM"; null when it is not one. */
export function monthIndex(ym: string): number | null {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return null;
  return Number(m[1]) * 12 + Number(m[2]) - 1;
}
export const monthFromIndex = (i: number): string => `${pad(Math.floor(i / 12), 4)}-${pad((i % 12) + 1)}`;
/** "May 2026". */
export function monthLabel(ym: string): string {
  const i = monthIndex(ym);
  return i === null ? ym : `${MONTHS[i % 12]} ${Math.floor(i / 12)}`;
}

/** The date `n` months from `iso` (n may be negative): the day of month is kept, or `day` when given, and clamped to the target month's last day (Jan 31 + 1 is Feb 28, or 29 in a leap year). */
export function addMonths(iso: string, n: number, day?: number): string | null {
  const p = parseIso(iso);
  if (!p) return null;
  const idx = p.y * 12 + (p.m - 1) + n;
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  return toIso({ y, m, d: Math.min(day ?? p.d, daysInMonth(y, m)) });
}
/** The date `n` days from `iso` (n may be negative). */
export function addDays(iso: string, n: number): string | null {
  const p = parseIso(iso);
  if (!p) return null;
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d) + n * DAY_MS);
  return toIso({ y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() });
}
/** One cadence step after `iso`: weekly 7 days, biweekly 14 days, anything else (monthly, the default) the next month keeping `anchorDay` (default: the date's own day), clamped. */
export function addCadence(iso: string, cadence: Cadence, anchorDay?: number): string | null {
  if (cadence === 'weekly') return addDays(iso, 7);
  if (cadence === 'biweekly') return addDays(iso, 14);
  return addMonths(iso, 1, anchorDay);
}

// ---------- the chips ----------
/** Indexes of the rows that are chips (a real date), in date order; equal dates keep their table order. */
export function chipOrder(rows: readonly TimelineRow[]): number[] {
  return rows.map((r, i) => ({ i, d: parseIso(r.dueDate) ? r.dueDate : null })).filter((x): x is { i: number; d: string } => x.d !== null)
    .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : a.i - b.i)).map((x) => x.i);
}
/**
 * The months to show as columns, "YYYY-MM" in order: from the earliest chip's month to two months after the latest (at least six columns, at most
 * MAX_TIMELINE_MONTHS). Chips after the last column are not shown (`hidden` counts them). No chips: six months from `fallback` (a month) or none.
 */
export function timelineMonths(rows: readonly TimelineRow[], fallback?: string): { months: string[]; hidden: number } {
  const idx = chipOrder(rows).map((i) => monthIndex(monthOf(rows[i]!.dueDate)!)!);
  const first = idx.length > 0 ? idx[0]! : monthIndex(fallback ?? '');
  if (first === null) return { months: [], hidden: 0 };
  const last = idx.length > 0 ? idx[idx.length - 1]! : first;
  const count = Math.min(MAX_TIMELINE_MONTHS, Math.max(6, last - first + 3));
  return { months: Array.from({ length: count }, (_, k) => monthFromIndex(first + k)), hidden: idx.filter((m) => m >= first + count).length };
}

const withDate = <T extends TimelineRow>(r: T, dueDate: string): T => ({ ...r, dueDate });
const replaceAt = <T>(rows: readonly T[], i: number, row: T): T[] => rows.map((r, k) => (k === i ? row : r));

/** Moves a chip to another month, keeping its day of month (clamped to the target month's last day). Null when the row has no real date or the month is not "YYYY-MM". */
export function moveToMonth<T extends TimelineRow>(rows: readonly T[], index: number, ym: string): TimelineEdit<T> | null {
  const row = rows[index];
  const from = row ? monthOf(row.dueDate) : null;
  const a = from === null ? null : monthIndex(from);
  const b = monthIndex(ym);
  if (!row || a === null || b === null) return null;
  return { rows: replaceAt(rows, index, withDate(row, addMonths(row.dueDate, b - a)!)), selected: index };
}
/** Moves a chip by whole months (keyboard Left and Right). */
export function moveByMonths<T extends TimelineRow>(rows: readonly T[], index: number, n: number): TimelineEdit<T> | null {
  const row = rows[index];
  const date = row ? addMonths(row.dueDate, n) : null;
  return row && date ? { rows: replaceAt(rows, index, withDate(row, date)), selected: index } : null;
}
/** Moves a chip by days (keyboard Up and Down). */
export function moveByDays<T extends TimelineRow>(rows: readonly T[], index: number, n: number): TimelineEdit<T> | null {
  const row = rows[index];
  const date = row ? addDays(row.dueDate, n) : null;
  return row && date ? { rows: replaceAt(rows, index, withDate(row, date)), selected: index } : null;
}
/** Sets a chip's day of month (the small day field), clamped to the month's last day. Null for a day below 1 or a non-integer. */
export function setDay<T extends TimelineRow>(rows: readonly T[], index: number, day: number): TimelineEdit<T> | null {
  const row = rows[index];
  const p = row ? parseIso(row.dueDate) : null;
  if (!row || !p || !Number.isInteger(day) || day < 1) return null;
  return { rows: replaceAt(rows, index, withDate(row, toIso({ ...p, d: Math.min(day, daysInMonth(p.y, p.m)) }))), selected: index };
}

/**
 * Splits a chip into two that add up to the same cents: the first gets the extra cent of an odd amount, the second is dated one cadence step later
 * and is inserted right after it in the table. At `max` rows a wholly blank row (last first) is dropped to make room; with none, or an amount of
 * less than two cents, or no real date, the split does not apply (null).
 */
export function splitRow<T extends TimelineRow>(rows: readonly T[], index: number, cadence: Cadence = 'monthly', fresh: (r: TimelineRow) => T = (r) => ({ ...r }) as T, max = MAX_TIMELINE_ROWS): TimelineEdit<T> | null {
  const row = rows[index];
  const cents = row ? centsOf(row.amount) : null;
  const date = row ? addCadence(row.dueDate, cadence) : null;
  if (!row || cents === null || cents < 2n || date === null) return null;
  let base: T[] = [...rows];
  let at = index;
  if (base.length >= max) {
    const blank = base.map((r, i) => ({ r, i })).reverse().find((x) => x.i !== index && x.r.dueDate.trim() === '' && x.r.amount.trim() === '');
    if (!blank) return null;
    base = base.filter((_, i) => i !== blank.i);
    if (blank.i < index) at -= 1;
  }
  const first = (cents + 1n) / 2n;
  const second = cents - first;
  const out = [...base.slice(0, at), { ...base[at]!, amount: amountText(first) }, fresh({ dueDate: date, amount: amountText(second) }), ...base.slice(at + 1)];
  return { rows: out, selected: at };
}

/** The chip after this one on the timeline (by date), as a row index, or null. */
export function nextChip(rows: readonly TimelineRow[], index: number): number | null {
  const order = chipOrder(rows);
  const at = order.indexOf(index);
  return at < 0 || at + 1 >= order.length ? null : order[at + 1]!;
}
/** Merges a chip with the next one on the timeline: the amounts add up exactly, the earlier date stays and the later row goes. Null when there is no next chip or an amount is unreadable. */
export function mergeWithNext<T extends TimelineRow>(rows: readonly T[], index: number): TimelineEdit<T> | null {
  const j = nextChip(rows, index);
  const a = rows[index] ? centsOf(rows[index]!.amount) : null;
  const b = j === null ? null : centsOf(rows[j!]!.amount);
  if (j === null || a === null || b === null) return null;
  const out = replaceAt(rows, index, { ...rows[index]!, amount: amountText(a + b) }).filter((_, k) => k !== j);
  return { rows: out, selected: j < index ? index - 1 : index };
}

/** "Restart here": this chip and every later one (by date) shift by the same number of months so this chip lands in `ym`; each keeps its day of month (clamped), so the spacing in months is kept and no amount changes. */
export function restartFrom<T extends TimelineRow>(rows: readonly T[], index: number, ym: string): TimelineEdit<T> | null {
  const from = rows[index] ? monthOf(rows[index]!.dueDate) : null;
  const a = from === null ? null : monthIndex(from);
  const b = monthIndex(ym);
  if (a === null || b === null) return null;
  const order = chipOrder(rows);
  const later = new Set(order.slice(order.indexOf(index)));
  return { rows: rows.map((r, i) => (later.has(i) ? withDate(r, addMonths(r.dueDate, b - a)!) : r)), selected: index };
}
