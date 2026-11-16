// The "List each installment" mode of the plan forms: the pasted-text parser, the table rows, the form conversion and the flash spelling. Fabricated figures only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { flashSetCookie, readFlash } from '../../apps/web/server/flash.ts';
import {
  InstallmentListError, instRowsOf, listFormState, listProblems, parseInstallmentRows, parseInstallmentText, parseListAmount, parseListDate, withInstallmentList, withInstRowsFlash, withInstRowValues,
} from '../../apps/web/server/plan-installments.ts';
import { PREVIEW_KEEP } from '../../apps/web/server/plan-preview-form.ts';

const row = (dueDate, amount) => ({ dueDate, amount });

test('dates are YYYY-MM-DD or M/D/YYYY and must be real calendar dates in range', () => {
  assert.equal(parseListDate('2026-09-01'), '2026-09-01');
  assert.equal(parseListDate('9/1/2026'), '2026-09-01');
  assert.equal(parseListDate('12/31/2026'), '2026-12-31');
  assert.equal(parseListDate('02/29/2028'), '2028-02-29');
  for (const bad of ['2026-02-30', '2027-02-29', '13/1/2026', '9/31/2026', '2026-9-1', '9-1-2026', '1/1/26', 'soon', '', '1899-12-31', '2100-01-02', '0/1/2026']) assert.equal(parseListDate(bad), null, bad);
});

test('amounts are read as exact cents: optional $, thousands commas, at most two decimals, more than zero', () => {
  const ok = (raw) => parseListAmount(raw).amount;
  assert.equal(ok('40'), '40.00');
  assert.equal(ok('40.5'), '40.50');
  assert.equal(ok('$75.25'), '75.25');
  assert.equal(ok(' $ 1,250.00 '), '1250.00');
  assert.equal(ok('1,234,567.89'), '1234567.89');
  assert.equal(ok('0.01'), '0.01');
  assert.equal(ok('0.5'), '0.50');
  const problem = (raw) => parseListAmount(raw).problem;
  assert.equal(problem('abc'), 'amount is not a number');
  assert.equal(problem(''), 'amount is not a number');
  assert.equal(problem('1,23.00'), 'amount is not a number', 'commas must group three digits');
  assert.equal(problem('1e3'), 'amount is not a number');
  assert.equal(problem('5.'), 'amount is not a number');
  assert.equal(problem('40.123'), 'amount has more than two decimal places');
  assert.equal(problem('-5.00'), 'amount must be more than zero');
  assert.equal(problem('0'), 'amount must be more than zero');
  assert.equal(problem('0.00'), 'amount must be more than zero');
  assert.equal(problem('1234567890123'), 'amount is too large');
  assert.equal(problem('€5'), 'amount is not a number');
});

test('a pasted schedule: one installment per line, any of the separators, blank lines skipped', () => {
  const text = ['2026-09-01 75.25', '', '9/15/2026, $40.00', '2026-10-01\t40', '  2026-11-01;40.00  ', '11/15/2026,4.75'].join('\n');
  const r = parseInstallmentText(text);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.rows, [row('2026-09-01', '75.25'), row('2026-09-15', '40.00'), row('2026-10-01', '40.00'), row('2026-11-01', '40.00'), row('2026-11-15', '4.75')]);
  // Windows and old Mac line endings, as a browser textarea posts them.
  assert.equal(parseInstallmentText('2026-09-01 1\r\n2026-10-01 2\r2026-11-01 3').rows.length, 3);
  // A comma in the amount belongs to the amount, not to the separator.
  assert.deepEqual(parseInstallmentText('9/1/2026, 1,234.50').rows, [row('2026-09-01', '1234.50')]);
  assert.deepEqual(parseInstallmentText('2026-09-01 1,234.50').rows, [row('2026-09-01', '1234.50')]);
  assert.deepEqual(parseInstallmentText('').rows, []);
  assert.deepEqual(parseInstallmentText(' \n\n  \n'), { rows: [], errors: [] });
});

test('pasted lines that cannot be read come back as line-numbered sentences, counting blank lines', () => {
  const r = parseInstallmentText(['2026-09-01 40.00', '', '2026-13-01 40.00', '2026-10-01 forty', '2026-11-01', '2026-12-01 -5.00', '2027-01-01 0', '2027-02-01 40.00 extra', '2027-03-01 40.001'].join('\n'));
  assert.deepEqual(r.errors, [
    'Line 3: the date is not a real date (use YYYY-MM-DD or M/D/YYYY)',
    'Line 4: amount is not a number',
    'Line 5: the amount is missing',
    'Line 6: amount must be more than zero',
    'Line 7: amount must be more than zero',
    'Line 8: amount is not a number',
    'Line 9: amount has more than two decimal places',
  ]);
  assert.deepEqual(r.rows, [row('2026-09-01', '40.00')], 'the readable lines still come back');
});

test('at most 120 installments in a pasted schedule', () => {
  const lines = (n) => Array.from({ length: n }, (_, i) => `2026-01-01 ${i + 1}.00`).join('\n');
  assert.equal(parseInstallmentText(lines(120)).rows.length, 120);
  assert.deepEqual(parseInstallmentText(lines(121)).rows, []);
  assert.match(parseInstallmentText(lines(121)).errors[0], /121 installments; the most is 120/);
  assert.equal(parseInstallmentText(`${lines(120)}\n\n\n`).rows.length, 120, 'trailing blank lines are not installments');
  assert.match(parseInstallmentText('x\n'.repeat(500)).errors[0], /501 lines/);
  assert.match(parseInstallmentText('2026-01-01 1\n'.repeat(1500)).errors[0], /too long/);
});

test('table rows are read like pasted lines and named by their place', () => {
  const r = parseInstallmentRows([row('2026-09-01', '75.25'), row('2026-10-01', 'x'), row('', '5.00'), row('2026-12-01', ''), row('2027-02-30', '1')]);
  assert.deepEqual(r.errors, ['Row 2: amount is not a number', 'Row 3: the due date is missing', 'Row 4: the amount is missing', 'Row 5: the date is not a real date (use YYYY-MM-DD or M/D/YYYY)']);
  assert.deepEqual(parseInstallmentRows([row('9/1/2026', '$1,000.00')]).rows, [row('2026-09-01', '1000.00')]);
});

const generated = { totalAmount: '100.00', installmentCount: '4', installmentAmount: '25.00', firstDueDate: '2026-09-01', cadence: 'weekly', remainder: 'last_short' };

test('list mode turns the table rows into installments and drops the generated fields', () => {
  const body = { name: 'X', inputMode: 'list', ...generated, 'inst.0.dueDate': '2026-09-01', 'inst.0.amount': '75.25', 'inst.1.dueDate': '', 'inst.1.amount': '', 'inst.2.dueDate': '9/15/2026', 'inst.2.amount': '$40.00', installmentsText: '  ' };
  const out = withInstallmentList(body);
  assert.deepEqual(out, { name: 'X', installments: [row('2026-09-01', '75.25'), row('2026-09-15', '40.00')] });
  assert.ok(body['inst.0.amount'], 'the body is not changed');
});

test('list mode reads the pasted text; the same text gives the same installments as the table', () => {
  const text = '2026-09-01 75.25\n2026-10-01 40.00\n2026-11-01 40.00\n2026-12-01 40.00\n2027-01-01 4.75';
  const fromText = withInstallmentList({ inputMode: 'list', installmentsText: text, ...generated });
  const rows = text.split('\n').map((l) => l.split(' '));
  const table = { inputMode: 'list', ...generated };
  rows.forEach(([d, a], i) => { table[`inst.${i}.dueDate`] = d; table[`inst.${i}.amount`] = a; });
  assert.deepEqual(withInstallmentList(table), fromText);
  assert.equal(fromText.installments.length, 5);
  assert.equal('totalAmount' in fromText || 'cadence' in fromText || 'inputMode' in fromText, false);
});

test('any other input mode ignores the table and the text, so nothing typed there can break a generated plan', () => {
  for (const inputMode of ['total', 'per_installment', undefined]) {
    const body = { ...(inputMode ? { inputMode } : {}), ...generated, 'inst.0.dueDate': 'not a date', 'inst.0.amount': 'x', installmentsText: 'garbage' };
    assert.deepEqual(withInstallmentList(body), { ...(inputMode ? { inputMode } : {}), ...generated });
  }
  // A JSON caller's installments array is left as it is.
  const json = { installments: [{ dueDate: '2026-09-01', amount: '5.00' }] };
  assert.deepEqual(withInstallmentList(json), json);
});

test('list mode refuses both the table and the text, an empty list, bad rows, and a JSON list next to the form', () => {
  const both = { inputMode: 'list', 'inst.0.dueDate': '2026-09-01', 'inst.0.amount': '5.00', installmentsText: '2026-10-01 5.00' };
  assert.throws(() => withInstallmentList(both), (e) => e instanceof InstallmentListError && e.code === 'invalid_input' && /not both/.test(e.message) && e.lines.length === 1);
  assert.throws(() => withInstallmentList({ inputMode: 'list' }), (e) => e instanceof InstallmentListError && /at least one installment/.test(e.message));
  assert.throws(() => withInstallmentList({ inputMode: 'list', installmentsText: '\n \n' }), InstallmentListError);
  assert.throws(() => withInstallmentList({ inputMode: 'list', installmentsText: '2026-09-01 5\nbad' }), (e) => e instanceof InstallmentListError && e.lines.length === 1 && e.lines[0].startsWith('Line 2:'));
  assert.throws(() => withInstallmentList({ inputMode: 'list', 'inst.0.dueDate': '2026-09-01', 'inst.0.amount': 'x' }), (e) => e.lines[0] === 'Row 1: amount is not a number');
  assert.throws(() => withInstallmentList({ inputMode: 'list', installmentsText: '2026-09-01 5', installments: [] }), { code: 'invalid_input' });
  // The row encoding's own rules still hold: a gap in the indexes, an unknown field, a non-string value.
  assert.throws(() => withInstallmentList({ inputMode: 'list', 'inst.1.dueDate': '2026-09-01', 'inst.1.amount': '5' }), { code: 'invalid_input' });
  assert.throws(() => withInstallmentList({ inputMode: 'list', 'inst.0.dueDate': '2026-09-01', 'inst.0.note': 'x' }), { code: 'invalid_input' });
  assert.throws(() => withInstallmentList({ inputMode: 'list', installmentsText: ['a'] }), { code: 'invalid_input' });
  // The message of a long list of problems names the first few and counts the rest.
  const many = withInstallmentList.bind(null, { inputMode: 'list', installmentsText: Array.from({ length: 6 }, () => 'x y').join('\n') });
  assert.throws(many, (e) => e.lines.length === 6 && /\(and 3 more problems\)$/.test(e.message));
});

test('the problems the page shows are the same sentences, and only in list mode', () => {
  assert.deepEqual(listProblems({ inputMode: 'list', installmentsText: '2026-09-01 5\n2026-09-02 x' }), ['Line 2: amount is not a number']);
  assert.deepEqual(listProblems({ inputMode: 'total', installmentsText: 'x' }), []);
  assert.deepEqual(listProblems({ inputMode: 'list', installmentsText: '2026-09-01 5' }), []);
  assert.deepEqual(listProblems({ inputMode: 'list', 'inst.1.dueDate': '2026-09-01' }), [], 'a malformed key is not a line problem');
});

test('table rows travel through the flash cookie as one text and come back as inst.<n>.* values', () => {
  const body = { name: 'Plan', inputMode: 'list', 'inst.0.dueDate': '2026-09-01', 'inst.0.amount': '75.25', 'inst.1.dueDate': '', 'inst.1.amount': '', 'inst.2.dueDate': '2026-11-01', 'inst.2.amount': '40|\n.00', installmentsText: '' };
  const flat = withInstRowsFlash(body);
  assert.equal(flat.instRows, '2026-09-01|75.25\n2026-11-01|40  .00', 'a blank row is dropped, separators in a value are spaces');
  const cookie = flashSetCookie({ secureCookies: false }, '/plans', flat, PREVIEW_KEEP);
  const values = withInstRowValues(readFlash(cookie.split(';')[0].split('=')[1], '/plans'));
  assert.deepEqual(instRowsOf(values), [row('2026-09-01', '75.25'), row('2026-11-01', '40  .00')]);
  assert.equal('instRows' in values, false);
  assert.equal(listFormState(values).listTrimmed, false);
  assert.equal(withInstRowsFlash({ name: 'x' }).instRows, undefined);
});

test('a list too long for the flash cookie loses whole lines from its end and says so; nothing else changes', () => {
  const lines = Array.from({ length: 120 }, (_, i) => `2026-${String((i % 12) + 1).padStart(2, '0')}-15|${1000 + i}.25`);
  const body = { name: 'Plan', inputMode: 'list', instRows: lines.join('\n'), installmentsText: lines.map((l) => l.replace('|', ' ')).join('\n'), reason: 'Because' };
  const cookie = flashSetCookie({ secureCookies: false }, '/plans', body, PREVIEW_KEEP);
  assert.ok(cookie, 'a cookie is still written');
  const raw = cookie.split(';')[0].split('=')[1];
  assert.ok(raw.length <= 3500);
  const values = readFlash(raw, '/plans');
  assert.equal(values.name, 'Plan');
  assert.equal(values.reason, 'Because');
  assert.ok(values.flashTrimmed.split(',').every((n) => ['instRows', 'installmentsText'].includes(n)));
  const asText = lines.map((l) => l.replace('|', ' '));
  for (const [k, whole] of [['instRows', lines], ['installmentsText', asText]]) {
    if (!values[k]) continue;
    const kept = values[k].split('\n');
    assert.ok(kept.length < 120 && kept.every((l, i) => l === whole[i]), `only whole leading lines of ${k} survive`);
  }
  assert.equal(listFormState({ ...values, error: 'invalid_input' }).listTrimmed, true);
  assert.deepEqual(listFormState({ ...values, error: 'invalid_input', installmentsText: 'x y' }).listProblems, [], 'no problems are shown for a cut list');
  // A short list is untouched and carries no marker.
  const small = readFlash(flashSetCookie({ secureCookies: false }, '/plans', { instRows: lines.slice(0, 10).join('\n') }, PREVIEW_KEEP).split(';')[0].split('=')[1], '/plans');
  assert.equal(small.instRows.split('\n').length, 10);
  assert.equal(small.flashTrimmed, undefined);
  // Ordinary values keep their old cap and the old null when they alone are too big.
  assert.equal(readFlash(flashSetCookie({ secureCookies: false }, '/plans', { reason: 'x'.repeat(900) }, PREVIEW_KEEP).split(';')[0].split('=')[1], '/plans').reason.length, 300);
});
