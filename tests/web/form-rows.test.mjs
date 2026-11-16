// The indexed row encoding for HTML form posts (alloc.0.billId, alloc.0.amount, ...). Pure; fabricated values only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { rowsFromForm, withCheckedRows, withFormRows } from '../../apps/web/server/form-rows.ts';

const F = ['billId', 'amount'];
const bad = { code: 'invalid_input' };

test('rows come back in index order, whatever the order of the keys', () => {
  const body = { 'alloc.1.amount': '25.00', 'alloc.0.billId': 'a', 'alloc.1.billId': 'b', 'alloc.0.amount': '45.00', other: 'x' };
  assert.deepEqual(rowsFromForm(body, 'alloc', F, 25), [{ billId: 'a', amount: '45.00' }, { billId: 'b', amount: '25.00' }]);
  const ten = {};
  for (let i = 0; i < 11; i++) { ten[`alloc.${i}.billId`] = `b${i}`; ten[`alloc.${i}.amount`] = '1'; }
  assert.deepEqual(rowsFromForm(ten, 'alloc', F, 25).map((r) => r.billId), Array.from({ length: 11 }, (_, i) => `b${i}`), 'index 10 sorts after 9');
});

test('blank rows are skipped and a partly filled row is kept for the schema to refuse', () => {
  const body = { 'alloc.0.billId': '', 'alloc.0.amount': ' ', 'alloc.1.billId': 'b', 'alloc.1.amount': '', 'alloc.2.billId': '', 'alloc.2.amount': '3.00' };
  assert.deepEqual(rowsFromForm(body, 'alloc', F, 25), [{ billId: 'b', amount: '' }, { billId: '', amount: '3.00' }]);
  assert.deepEqual(rowsFromForm({ 'alloc.0.billId': '', 'alloc.0.amount': '' }, 'alloc', F, 25), []);
  assert.deepEqual(rowsFromForm({ paidOn: '2026-04-01' }, 'alloc', F, 25), []);
});

test('gaps, unknown fields, bad indexes, non-strings and too many rows are refused', () => {
  assert.throws(() => rowsFromForm({ 'alloc.0.billId': 'a', 'alloc.2.billId': 'c' }, 'alloc', F, 25), bad);
  assert.throws(() => rowsFromForm({ 'alloc.1.billId': 'a' }, 'alloc', F, 25), bad, 'rows start at 0');
  assert.throws(() => rowsFromForm({ 'alloc.0.billId': 'a', 'alloc.0.note': 'x' }, 'alloc', F, 25), bad);
  for (const key of ['alloc.x.billId', 'alloc.-1.billId', 'alloc.01.billId', 'alloc.1.5.billId', 'alloc.0.', 'alloc.0', 'alloc.billId', 'alloc.0.billId.x', 'alloc.0.__proto__']) {
    assert.throws(() => rowsFromForm({ [key]: 'a' }, 'alloc', F, 25), bad, key);
  }
  assert.throws(() => rowsFromForm({ 'alloc.0.billId': 5 }, 'alloc', F, 25), bad);
  const many = {};
  for (let i = 0; i < 4; i++) many[`alloc.${i}.billId`] = `b${i}`;
  assert.equal(rowsFromForm(many, 'alloc', F, 4).length, 4);
  assert.throws(() => rowsFromForm(many, 'alloc', F, 3), bad);
  // Blank rows count toward the limit as well, so a body cannot be padded.
  assert.throws(() => rowsFromForm({ 'alloc.0.billId': '', 'alloc.1.billId': '', 'alloc.2.billId': '' }, 'alloc', F, 2), bad);
  // Another prefix is not touched.
  assert.deepEqual(rowsFromForm({ 'other.0.x': 'y', 'allocation': 'z' }, 'alloc', F, 25), []);
});

test('withFormRows replaces the rows with one array, keeps other fields, and refuses mixing with a JSON array', () => {
  const spec = { prefix: 'alloc', into: 'allocations', fields: F, max: 25 };
  const body = { amount: '70.00', 'alloc.0.billId': 'a', 'alloc.0.amount': '45.00', 'alloc.1.billId': 'b', 'alloc.1.amount': '25.00', 'alloc.2.billId': '', 'alloc.2.amount': '' };
  assert.deepEqual(withFormRows(body, spec), { amount: '70.00', allocations: [{ billId: 'a', amount: '45.00' }, { billId: 'b', amount: '25.00' }] });
  // All rows blank: the field is left out, so the single-bill shorthand still works.
  assert.deepEqual(withFormRows({ amount: '5', billId: 'a', 'alloc.0.billId': '', 'alloc.0.amount': '' }, spec), { amount: '5', billId: 'a' });
  // No rows at all: the very same object comes back.
  const plain = { amount: '5', billId: 'a' };
  assert.equal(withFormRows(plain, spec), plain);
  assert.throws(() => withFormRows({ allocations: [], 'alloc.0.billId': 'a' }, spec), bad);
});

test('checkbox rows keep only the ticked rows and drop the flag', () => {
  const spec = { prefix: 'sug', into: 'rows', fields: ['installmentId', 'amount'], flag: 'apply', max: 120 };
  const body = {
    version: '1', 'sug.0.installmentId': 'a', 'sug.0.amount': '12.00', 'sug.0.apply': '1',
    'sug.1.installmentId': 'b', 'sug.1.amount': '7.00', // unticked: the browser sends no `apply`
    'sug.2.installmentId': 'c', 'sug.2.amount': '3.00', 'sug.2.apply': '1',
  };
  assert.deepEqual(withCheckedRows(body, spec), { version: '1', rows: [{ installmentId: 'a', amount: '12.00' }, { installmentId: 'c', amount: '3.00' }] });
  // Nothing ticked: no rows at all, so the schema refuses the post.
  assert.deepEqual(withCheckedRows({ version: '1', 'sug.0.installmentId': 'a', 'sug.0.amount': '1.00' }, spec), { version: '1' });
  assert.deepEqual(withCheckedRows({ version: '1' }, spec), { version: '1' });
  // A tick with the rest blank stays for the schema to refuse; a strange flag value, a gap, an unknown field or the JSON array too are refused here.
  assert.deepEqual(withCheckedRows({ 'sug.0.apply': '1' }, spec), { rows: [{ installmentId: '', amount: '' }] });
  assert.throws(() => withCheckedRows({ 'sug.0.installmentId': 'a', 'sug.0.amount': '1', 'sug.0.apply': 'on' }, spec), bad);
  assert.throws(() => withCheckedRows({ 'sug.0.installmentId': 'a', 'sug.2.installmentId': 'c' }, spec), bad);
  assert.throws(() => withCheckedRows({ 'sug.0.other': 'a' }, spec), bad);
  assert.throws(() => withCheckedRows({ rows: [], 'sug.0.apply': '1' }, spec), bad);
});
