// The "List each installment" mode of the plan forms: turning what a browser posts (a table of `inst.<n>.dueDate` / `inst.<n>.amount`
// rows, or a pasted schedule in `installmentsText`) into the `installments` array the plan schema takes, with errors a person can act on.
// Everything here is pure and exact: amounts are read as text into whole cents, never as numbers with a fraction.
import { AppError } from './errors.ts';
import { centsToUsdInput, MAX_CENTS } from './money.ts';
import { rowsFromForm } from './form-rows.ts';

export const MAX_LIST_INSTALLMENTS = 120;
/** Rows the form shows without JavaScript; the typed ones are kept through a Preview or an error (see INST_FORM_ROWS in the route). */
export const INST_FORM_ROWS = 12;
export const INST_ROWS = { prefix: 'inst', into: 'installments', fields: ['dueDate', 'amount'], max: MAX_LIST_INSTALLMENTS } as const;
/** Longest pasted text read at all (120 lines of a long date and amount fit many times over). */
const MAX_TEXT_CHARS = 12_000;
const MAX_TEXT_LINES = 400;

/** The line-numbered problems of a listed schedule. It is an `invalid_input` whose message is the first problems, so a JSON caller sees them. */
export class InstallmentListError extends AppError {
  readonly lines: string[];
  constructor(lines: string[]) {
    super('invalid_input', lines.length > 3 ? `${lines.slice(0, 3).join(' ')} (and ${lines.length - 3} more problems)` : lines.join(' '));
    this.lines = lines;
  }
}

export interface ListedInstallment { dueDate: string; amount: string }

const dateOk = (y: number, m: number, d: number): string | null => {
  const ms = Date.UTC(y, m - 1, d);
  if (!Number.isFinite(ms) || y < 1900 || y > 2100) return null;
  const iso = new Date(ms).toISOString().slice(0, 10);
  const out = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return iso === out && out >= '1900-01-01' && out <= '2100-01-01' ? out : null;
};

/** `YYYY-MM-DD` or `M/D/YYYY` to `YYYY-MM-DD`; null when it is not a real calendar date in range. */
export function parseListDate(raw: string): string | null {
  const t = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) return dateOk(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  return m ? dateOk(Number(m[3]), Number(m[1]), Number(m[2])) : null;
}

/**
 * An amount as people write it ("40", "40.5", "$1,250.00") to canonical decimal text ("40.00"), or the sentence that says what is wrong.
 * Thousands commas must be in groups of three. Integer arithmetic only; more than two decimals, zero and negatives are refused.
 */
export function parseListAmount(raw: string): { amount: string } | { problem: string } {
  const t = raw.trim();
  const m = /^(-?)\s*\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d*))?$/.exec(t);
  if (!m) return { problem: 'amount is not a number' };
  const frac = m[3] ?? '';
  if (frac.length > 2) return { problem: 'amount has more than two decimal places' };
  if (frac.length === 0 && t.endsWith('.')) return { problem: 'amount is not a number' };
  const whole = m[2]!.replaceAll(',', '');
  if (whole.length > 12) return { problem: 'amount is too large' };
  const cents = BigInt(whole) * 100n + BigInt(frac.padEnd(2, '0') || '0');
  if (m[1] === '-' && cents > 0n) return { problem: 'amount must be more than zero' };
  if (cents === 0n) return { problem: 'amount must be more than zero' };
  if (cents > MAX_CENTS) return { problem: 'amount is too large' };
  return { amount: centsToUsdInput(cents) };
}

/** One date and one amount (as typed) to a row, or the problem; `what` names the line or row in the message. */
function parseOne(dueRaw: string, amountRaw: string, what: string): { row: ListedInstallment } | { problem: string } {
  const dueDate = parseListDate(dueRaw);
  if (dueRaw.trim() === '') return { problem: `${what}: the due date is missing` };
  if (!dueDate) return { problem: `${what}: the date is not a real date (use YYYY-MM-DD or M/D/YYYY)` };
  if (amountRaw.trim() === '') return { problem: `${what}: the amount is missing` };
  const a = parseListAmount(amountRaw);
  if ('problem' in a) return { problem: `${what}: ${a.problem}` };
  return { row: { dueDate, amount: a.amount } };
}

/**
 * Reads a pasted schedule: one installment per line, a date then an amount, separated by spaces, a tab, a comma or a semicolon
 * ("2026-09-01 40.00", "9/1/2026, $1,250.00", "2026-09-01<TAB>40"). Blank lines are skipped. Lines are numbered as they were typed
 * (blank ones counted), so "Line 3" is the third line of the box. At most 120 installments. Never throws; problems come back as sentences.
 */
export function parseInstallmentText(text: string): { rows: ListedInstallment[]; errors: string[] } {
  if (text.length > MAX_TEXT_CHARS) return { rows: [], errors: ['The pasted schedule is too long to read. A schedule can list at most 120 installments, one per line.'] };
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > MAX_TEXT_LINES) return { rows: [], errors: [`The pasted schedule has ${lines.length} lines. A schedule can list at most ${MAX_LIST_INSTALLMENTS} installments, one per line.`] };
  const filled = lines.map((l, i) => ({ l: l.trim(), n: i + 1 })).filter((x) => x.l !== '');
  if (filled.length > MAX_LIST_INSTALLMENTS) return { rows: [], errors: [`The pasted schedule has ${filled.length} installments; the most is ${MAX_LIST_INSTALLMENTS}.`] };
  const rows: ListedInstallment[] = [];
  const errors: string[] = [];
  for (const { l, n } of filled) {
    // The date is the first word; whatever follows (after one optional comma or semicolon) is the amount, so "1,250.00" keeps its comma.
    const m = /^([^\s,;]+)[ \t]*[,;]?[ \t]*(.*)$/.exec(l)!;
    const r = parseOne(m[1]!, m[2]!, `Line ${n}`);
    if ('problem' in r) errors.push(r.problem); else rows.push(r.row);
  }
  return { rows, errors };
}

/** Reads the rows of the table (as `rowsFromForm` returns them), naming problems "Row N" by their place among the filled rows. */
export function parseInstallmentRows(rows: Array<{ dueDate: string; amount: string }>): { rows: ListedInstallment[]; errors: string[] } {
  const out: ListedInstallment[] = [];
  const errors: string[] = [];
  rows.forEach((r, i) => {
    const x = parseOne(r.dueDate, r.amount, `Row ${i + 1}`);
    if ('problem' in x) errors.push(x.problem); else out.push(x.row);
  });
  return { rows: out, errors };
}

/** Every field the generated modes read; a listed schedule has none of them (the plan schema refuses a list next to them). */
const GENERATED_FIELDS = ['totalAmount', 'installmentCount', 'installmentAmount', 'firstDueDate', 'remainder', 'cadence'] as const;

/**
 * The `prepare` step of plan creating, revising and previewing. The forms always carry the table rows and the paste box, whatever amount choice
 * is picked (without JavaScript nothing can hide them), so:
 * - with any other input mode the table rows and the pasted text are removed and ignored, never an error;
 * - with `inputMode=list` they become `installments` and the fields of the generated modes (total, count, amount, first date, cadence,
 *   leftover cents) are removed and ignored. Giving both the table and pasted text is refused, so nothing is silently dropped;
 *   an empty list or any bad line is an `InstallmentListError` with one sentence per problem.
 * A body that already carries a JSON `installments` array and no list mode is returned as it is (with the form fields removed).
 */
export function withInstallmentList(body: Record<string, unknown>): Record<string, unknown> {
  const rest = Object.fromEntries(Object.entries(body).filter(([k]) => !k.startsWith('inst.') && k !== 'installmentsText'));
  if (body.inputMode !== 'list') return rest;
  if ('installments' in body) throw new AppError('invalid_input', 'Give the installments either as a list in the form or as JSON, not both');
  const text = body.installmentsText;
  if (text !== undefined && typeof text !== 'string') throw new AppError('invalid_input');
  const tableRows = rowsFromForm(body, INST_ROWS.prefix, INST_ROWS.fields, INST_ROWS.max);
  const pasted = (text ?? '').trim() !== '';
  if (tableRows.length > 0 && pasted) throw new InstallmentListError(['Fill in the table or paste a schedule, not both. Clear one of them.']);
  const parsed = pasted ? parseInstallmentText(text!) : parseInstallmentRows(tableRows.map((r) => ({ dueDate: r.dueDate ?? '', amount: r.amount ?? '' })));
  if (parsed.errors.length > 0) throw new InstallmentListError(parsed.errors);
  if (parsed.rows.length === 0) throw new InstallmentListError(['List at least one installment: fill in the table or paste a schedule.']);
  const { inputMode: _mode, ...without } = rest;
  for (const f of GENERATED_FIELDS) delete without[f];
  return { ...without, installments: parsed.rows };
}

/** The sentences for the page to show next to a list a person typed (after an error or in a Preview); empty when it reads fine or is not in list mode. */
export function listProblems(values: Record<string, string | undefined>): string[] {
  if (values.inputMode !== 'list') return [];
  try {
    withInstallmentList(Object.fromEntries(Object.entries(values).filter((e): e is [string, string] => e[1] !== undefined)));
    return [];
  } catch (error) {
    return error instanceof InstallmentListError ? error.lines : [];
  }
}

// ---------- the flash cookie ----------
// The cookie only takes short values with dotted names, so the table rows travel as one text value, a `date|amount` line per row, and come back
// as `inst.<n>.*` values for the form. Blank rows are not kept, so the rows after a gap move up on the way back.

const MAX_CELL = 24;
/** A table cell for the flash cookie: separators become spaces and whitespace is trimmed first, so only real characters count toward the limit. */
const clean = (v: unknown) => (typeof v === 'string' ? v.replace(/[|\r\n]/g, ' ').trim() : '');

/**
 * The body with its `inst.<n>.*` values also spelled as one `instRows` text for the flash cookie. Lenient: a bad key is simply not kept.
 * A cell longer than 24 characters (after trimming) is cut for the cookie and the body says `flashTrimmed: 'instRows'`, so a Preview refuses
 * instead of showing a different amount than a save would read.
 */
export function withInstRowsFlash(body: Record<string, unknown>): Record<string, unknown> {
  const lines: string[] = [];
  let cut = false;
  for (let i = 0; i < MAX_LIST_INSTALLMENTS; i++) {
    const d = clean(body[`inst.${i}.dueDate`]);
    const a = clean(body[`inst.${i}.amount`]);
    if (d.length > MAX_CELL || a.length > MAX_CELL) cut = true;
    if (d !== '' || a !== '') lines.push(`${d.slice(0, MAX_CELL)}|${a.slice(0, MAX_CELL)}`);
  }
  return lines.length > 0 ? { ...body, instRows: lines.join('\n'), ...(cut ? { flashTrimmed: 'instRows' } : {}) } : body;
}

/** The flash values with `instRows` expanded back into the `inst.<n>.dueDate` / `inst.<n>.amount` values the form and the converter read. */
export function withInstRowValues(values: Record<string, string>): Record<string, string> {
  const { instRows, ...rest } = values;
  if (!instRows) return values;
  const out: Record<string, string> = { ...rest };
  instRows.split('\n').slice(0, MAX_LIST_INSTALLMENTS).forEach((line, i) => {
    const [d = '', a = ''] = line.split('|');
    out[`inst.${i}.dueDate`] = d;
    out[`inst.${i}.amount`] = a;
  });
  return out;
}

/** The typed rows of a form's values, in order, with trailing blanks left out (the form pads them again). */
export function instRowsOf(values: Record<string, string | undefined>): ListedInstallment[] {
  const rows: ListedInstallment[] = [];
  for (let i = 0; i < MAX_LIST_INSTALLMENTS; i++) rows.push({ dueDate: values[`inst.${i}.dueDate`] ?? '', amount: values[`inst.${i}.amount`] ?? '' });
  while (rows.length > 0 && rows[rows.length - 1]!.dueDate === '' && rows[rows.length - 1]!.amount === '') rows.pop();
  return rows;
}

/** What the form's list fields show from the page's values (the typed rows and text, and, after an error, the problems of the list; none when the flash had to cut it short). */
export function listFormState(values: Record<string, string | undefined>) {
  const listTrimmed = !!values.flashTrimmed;
  return {
    installmentsText: values.installmentsText, instRows: instRowsOf(values), listTrimmed,
    listProblems: values.error && !listTrimmed ? listProblems(values) : [],
  };
}
