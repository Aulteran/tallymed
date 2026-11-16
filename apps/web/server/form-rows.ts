// One encoding for row lists in HTML form posts, shared by every form that sends several rows of the same fields
// (payment allocations today; plan installment lists and match lists later). A browser posts a flat list of names, so a row
// list is spelled with indexed keys: `<prefix>.<index>.<field>`, for example `alloc.0.billId` and `alloc.0.amount`.
import { AppError } from './errors.ts';

const KEY_TAIL = /^(0|[1-9][0-9]{0,2})\.([A-Za-z][A-Za-z0-9]*)$/;

/**
 * Collects the rows spelled `<prefix>.<index>.<field>` in a flat form body into an array in index order.
 *
 * - Indexes are plain decimal numbers that start at 0 and have no gaps. Rows are counted by index, blank ones included, and
 *   at most `max` may be present.
 * - Only the listed `fields` may appear, every value must be a string, and a row with all its fields blank (empty or spaces)
 *   is skipped, so a form can show spare rows. A row with only some fields filled is kept as it is, with blanks as empty
 *   strings, and the schema that parses the result refuses it.
 * - Anything under `<prefix>.` that does not fit is refused with `invalid_input`, never ignored.
 * Pure: it does not read or change the body.
 */
export function rowsFromForm(body: Record<string, unknown>, prefix: string, fields: readonly string[], max: number): Array<Record<string, string>> {
  const byIndex = new Map<number, Record<string, string>>();
  const lead = `${prefix}.`;
  for (const [key, value] of Object.entries(body)) {
    if (!key.startsWith(lead)) continue;
    const m = KEY_TAIL.exec(key.slice(lead.length));
    if (!m || !fields.includes(m[2]!) || typeof value !== 'string') throw new AppError('invalid_input');
    const index = Number(m[1]);
    const row = byIndex.get(index) ?? {};
    row[m[2]!] = value;
    byIndex.set(index, row);
  }
  if (byIndex.size > max) throw new AppError('invalid_input');
  const rows: Array<Record<string, string>> = [];
  for (let i = 0; i < byIndex.size; i++) {
    const row = byIndex.get(i);
    if (!row) throw new AppError('invalid_input'); // a gap in the indexes
    if (Object.values(row).every((v) => v.trim() === '')) continue;
    rows.push(Object.fromEntries(fields.map((f) => [f, row[f] ?? ''])));
  }
  return rows;
}

/**
 * Returns the body with the `<prefix>.*` keys replaced by one array under `into` (left out when every row is blank, so a form
 * with spare rows and a single-bill shorthand still works). A body that already carries `into` (JSON) cannot also carry rows.
 * A body with no `<prefix>.` keys is returned unchanged.
 */
export function withFormRows(
  body: Record<string, unknown>, spec: { prefix: string; into: string; fields: readonly string[]; max: number },
): Record<string, unknown> {
  const lead = `${spec.prefix}.`;
  if (!Object.keys(body).some((k) => k.startsWith(lead))) return body;
  if (spec.into in body) throw new AppError('invalid_input');
  const rows = rowsFromForm(body, spec.prefix, spec.fields, spec.max);
  const rest = Object.fromEntries(Object.entries(body).filter(([k]) => !k.startsWith(lead)));
  return rows.length > 0 ? { ...rest, [spec.into]: rows } : rest;
}

/**
 * Like `withFormRows` for a list of rows that each carry a checkbox (`<prefix>.<n>.<flag>`, "1" when ticked). An unticked checkbox is not
 * sent at all, so a row without the flag is simply left out; a flag with any value other than "1" is refused. The flag is not part of
 * the rows that come out, and every other field of a kept row is validated by the schema as usual. Indexes still count every row,
 * ticked or not, so a form can show a fixed list with no gaps.
 */
export function withCheckedRows(
  body: Record<string, unknown>, spec: { prefix: string; into: string; fields: readonly string[]; flag: string; max: number },
): Record<string, unknown> {
  const lead = `${spec.prefix}.`;
  if (!Object.keys(body).some((k) => k.startsWith(lead))) return body;
  if (spec.into in body) throw new AppError('invalid_input');
  const all = rowsFromForm(body, spec.prefix, [...spec.fields, spec.flag], spec.max);
  const picked: Array<Record<string, string>> = [];
  for (const row of all) {
    const { [spec.flag]: flag, ...rest } = row;
    if (flag === '') continue;
    if (flag !== '1') throw new AppError('invalid_input');
    picked.push(rest);
  }
  const rest = Object.fromEntries(Object.entries(body).filter(([k]) => !k.startsWith(lead)));
  return picked.length > 0 ? { ...rest, [spec.into]: picked } : rest;
}
