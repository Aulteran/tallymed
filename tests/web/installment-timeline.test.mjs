// The pure logic of the schedule timeline (apps/web/app/components/installment-timeline.ts). Fabricated figures only; money is whole cents.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addCadence, addDays, addMonths, amountText, centsOf, chipOrder, formatCents, mergeWithNext, monthLabel, moveByDays, moveByMonths, moveToMonth, restartFrom, setDay, splitRow, timelineMonths, totalCents,
} from '../../apps/web/app/components/installment-timeline.ts';

const r = (dueDate, amount) => ({ dueDate, amount });
const sample = () => [r('2026-03-15', '41.07'), r('2026-04-15', '33.33'), r('2026-06-30', '12.01'), r('', '')];

test('cents are exact: parsing, formatting and sums use integers', () => {
  assert.equal(centsOf('41.07'), 4107n);
  assert.equal(centsOf('$1,234.5'), 123450n);
  assert.equal(centsOf('abc'), null);
  assert.equal(centsOf(''), null);
  assert.equal(amountText(5n), '0.05');
  assert.equal(amountText(123456789n), '1234567.89');
  assert.equal(formatCents(123456n), '$1,234.56');
  assert.equal(totalCents(sample()), 8641n);
});

test('cadence steps: monthly keeps the day and clamps, weekly and biweekly add days', () => {
  assert.equal(addCadence('2026-01-31', 'monthly'), '2026-02-28');
  assert.equal(addCadence('2028-01-31', 'monthly'), '2028-02-29');
  assert.equal(addCadence('2026-02-28', 'monthly', 31), '2026-03-31', 'the anchor day comes back after a short month');
  assert.equal(addCadence('2026-12-15', 'monthly'), '2027-01-15');
  assert.equal(addCadence('2026-12-28', 'weekly'), '2027-01-04');
  assert.equal(addCadence('2026-02-20', 'biweekly'), '2026-03-06');
  assert.equal(addCadence('2026-05-10', 'custom'), '2026-06-10', 'unknown cadences step monthly');
  assert.equal(addCadence('nope', 'monthly'), null);
  assert.equal(addCadence('2026-02-30', 'weekly'), null, 'not a real date');
  assert.equal(addMonths('2026-03-31', -1), '2026-02-28');
  assert.equal(addMonths('2026-01-15', -2), '2025-11-15');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('moving to a month keeps the day and clamps to the target month end', () => {
  const rows = [r('2026-01-31', '10.01'), r('2028-01-31', '1.00'), r('2026-05-15', '2.00')];
  assert.equal(moveToMonth(rows, 0, '2026-02').rows[0].dueDate, '2026-02-28');
  assert.equal(moveToMonth(rows, 1, '2028-02').rows[1].dueDate, '2028-02-29');
  assert.equal(moveToMonth(rows, 2, '2026-12').rows[2].dueDate, '2026-12-15');
  assert.equal(moveToMonth(rows, 2, '2025-11').rows[2].dueDate, '2025-11-15', 'earlier months work');
  assert.equal(rows[0].dueDate, '2026-01-31', 'the input is not changed');
  assert.equal(moveToMonth(rows, 0, '2026-13'), null);
  assert.equal(moveToMonth([r('', '5.00')], 0, '2026-02'), null, 'a row without a date is not a chip');
  assert.equal(moveByMonths(rows, 0, 1).rows[0].dueDate, '2026-02-28');
  assert.equal(moveByDays(rows, 0, 1).rows[0].dueDate, '2026-02-01');
  assert.equal(setDay(rows, 2, 31).rows[2].dueDate, '2026-05-31');
  assert.equal(setDay(rows, 0, 31).rows[0].dueDate, '2026-01-31');
  assert.equal(setDay([r('2026-02-10', '1.00')], 0, 31).rows[0].dueDate, '2026-02-28');
  assert.equal(setDay(rows, 0, 0), null);
  assert.equal(setDay(rows, 0, 1.5), null);
});

test('the total in cents never changes for a move, a day change or a restart', () => {
  const rows = sample();
  const before = totalCents(rows);
  for (const edit of [moveToMonth(rows, 0, '2027-02'), moveByMonths(rows, 1, 3), moveByDays(rows, 2, 5), setDay(rows, 1, 31), restartFrom(rows, 1, '2027-01'), restartFrom(rows, 0, '2026-01')]) {
    assert.equal(totalCents(edit.rows), before);
    assert.equal(edit.rows.length, rows.length);
  }
});

test('splitting divides the cents exactly, the first part takes the extra cent, the second is one cadence step later', () => {
  const rows = [r('2026-01-31', '0.05'), r('2026-03-01', '41.07'), r('', '')];
  const odd = splitRow(rows, 0, 'monthly');
  assert.deepEqual(odd.rows.slice(0, 3), [r('2026-01-31', '0.03'), r('2026-02-28', '0.02'), r('2026-03-01', '41.07')]);
  assert.equal(odd.selected, 0);
  assert.equal(totalCents(odd.rows), totalCents(rows));
  const even = splitRow(rows, 1, 'weekly');
  assert.deepEqual(even.rows.slice(1, 3), [r('2026-03-01', '20.54'), r('2026-03-08', '20.53')], 'an odd 4107 cents is 2054 and 2053');
  assert.equal(totalCents(even.rows), totalCents(rows));
  assert.equal(splitRow([r('2026-03-01', '10.00')], 0, 'biweekly').rows[1].dueDate, '2026-03-15');
  assert.equal(splitRow([r('2026-03-01', '10')], 0).rows[0].amount, '5.00', 'cadence defaults to monthly and amounts become cents text');
  assert.equal(splitRow([r('2026-03-01', '0.01')], 0), null, 'one cent cannot be split');
  assert.equal(splitRow([r('2026-03-01', '')], 0), null);
  assert.equal(splitRow([r('', '5.00')], 0), null);
  // The caller can make the new row (it gives it a key).
  assert.equal(splitRow([r('2026-03-01', '2.00')], 0, 'monthly', (x) => ({ ...x, key: 7 })).rows[1].key, 7);
});

test('splitting at the row limit takes a blank row, or does nothing', () => {
  const full = Array.from({ length: 4 }, (_, i) => r(`2026-0${i + 1}-10`, '1.00'));
  assert.equal(splitRow(full, 0, 'monthly', undefined, 4), null);
  const withBlank = [full[0], r('', ''), full[1], full[2]];
  const out = splitRow(withBlank, 0, 'monthly', undefined, 4);
  assert.equal(out.rows.length, 4);
  assert.equal(out.rows.filter((x) => x.dueDate === '').length, 0);
  assert.equal(totalCents(out.rows), totalCents(withBlank));
});

test('merging adds the cents of a chip and the next one by date, keeps the earlier date and removes the later row', () => {
  const rows = [r('2026-06-30', '12.01'), r('2026-03-15', '41.07'), r('2026-04-15', '33.33'), r('', '')];
  const m = mergeWithNext(rows, 1); // March merges with April, which is the next by date (not the next table row)
  assert.deepEqual(m.rows, [r('2026-06-30', '12.01'), r('2026-03-15', '74.40'), r('', '')]);
  assert.equal(m.selected, 1);
  assert.equal(totalCents(m.rows), totalCents(rows));
  const back = mergeWithNext(rows, 2); // April merges with June, which sits before it in the table
  assert.equal(back.rows.find((x) => x.dueDate === '2026-04-15').amount, '45.34');
  assert.equal(back.rows.length, 3);
  assert.equal(back.rows[back.selected].dueDate, '2026-04-15');
  assert.equal(totalCents(back.rows), totalCents(rows));
  assert.equal(mergeWithNext(rows, 0), null, 'the last chip has no next one');
  assert.equal(mergeWithNext([r('2026-01-01', '1.00'), r('2026-02-01', 'x')], 0), null, 'an unreadable amount is not merged');
  // Split then merge gives the original back, to the cent.
  const orig = [r('2026-03-01', '0.07')];
  const s = splitRow(orig, 0, 'monthly');
  assert.deepEqual(mergeWithNext(s.rows, s.selected).rows, orig);
});

test('restart from here shifts that chip and every later one by the same months, keeping spacing', () => {
  const rows = [r('2026-01-15', '10.00'), r('2026-02-28', '10.00'), r('2026-03-31', '10.00'), r('2026-05-31', '10.00')];
  const out = restartFrom(rows, 1, '2026-09');
  assert.deepEqual(out.rows.map((x) => x.dueDate), ['2026-01-15', '2026-09-28', '2026-10-31', '2026-12-31']);
  assert.equal(out.selected, 1);
  assert.equal(totalCents(out.rows), totalCents(rows));
  assert.deepEqual(restartFrom(rows, 0, '2025-12').rows.map((x) => x.dueDate), ['2025-12-15', '2026-01-28', '2026-02-28', '2026-04-30'], 'earlier is allowed; the day is clamped to each month');
  assert.deepEqual(restartFrom(rows, 3, '2026-05').rows, rows, 'the same month is no change');
  assert.equal(restartFrom(rows, 0, 'May'), null);
  assert.equal(restartFrom([r('', '1.00')], 0, '2026-05'), null);
  // Later is by date, not by table position.
  const shuffled = [rows[3], rows[0], rows[2], rows[1]];
  assert.deepEqual(restartFrom(shuffled, 3, '2026-03').rows.map((x) => x.dueDate), ['2026-06-30', '2026-01-15', '2026-04-30', '2026-03-28']);
});

test('the months shown run from the first chip to two months past the last, in order, capped', () => {
  assert.deepEqual(timelineMonths([r('2026-03-15', '1.00')]).months, ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'], 'at least six');
  const wide = timelineMonths([r('2026-11-15', '1.00'), r('2027-04-02', '1.00')]);
  assert.deepEqual([wide.months[0], wide.months.at(-1), wide.months.length], ['2026-11', '2027-06', 8]);
  const huge = timelineMonths([r('1950-01-01', '1.00'), r('2026-01-01', '1.00'), r('2026-02-01', '1.00')]);
  assert.equal(huge.months.length, 48);
  assert.equal(huge.hidden, 2);
  assert.deepEqual(timelineMonths([r('', '')]), { months: [], hidden: 0 });
  assert.equal(timelineMonths([], '2026-05').months[0], '2026-05');
  assert.deepEqual(chipOrder([r('2026-05-02', '1.00'), r('', ''), r('2026-05-02', '2.00'), r('2026-01-01', '3.00')]), [3, 0, 2]);
  assert.equal(monthLabel('2026-05'), 'May 2026');
});
