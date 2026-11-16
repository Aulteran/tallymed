// The pure parts of the POST preview of the plan forms. Fabricated ids only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { billIdsOfPreview, hasPreviewValues, PREVIEW_KEEP, previewKind, previewPage, withBillSlots, withBillTicks } from '../../apps/web/server/plan-preview-form.ts';
import { flashSetCookie, readFlash } from '../../apps/web/server/flash.ts';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const bad = { code: 'invalid_input' };

test('the preview kind and the page it returns to come from fixed values only', () => {
  assert.equal(previewKind({ preview: 'revise' }), 'revise');
  assert.throws(() => previewKind({ preview: '../x' }), bad);
  assert.throws(() => previewKind({}), bad);
  assert.equal(previewPage('create', { planId: 'ignored' }), '/plans');
  assert.equal(previewPage('revise', { planId: A }), `/plans/${A}`);
  assert.throws(() => previewPage('restructure', { planId: '../../x' }), bad);
  assert.throws(() => previewPage('revise', {}), bad);
});

test('bill ticks travel through the flash cookie as bill.<n> and come back as bill_<id>', () => {
  const body = { name: 'Clinic plan', [`bill_${B}`]: 'on', [`bill_${A}`]: 'on', 'bill_not-an-id': 'on', totalAmount: '90.00', firstDueDate: '2026-09-01', reason: 'Because' };
  const config = { secureCookies: false };
  const cookie = flashSetCookie(config, '/plans', withBillSlots(body), PREVIEW_KEEP);
  const raw = cookie.split(';')[0].split('=')[1];
  const values = readFlash(raw, '/plans');
  assert.deepEqual(billIdsOfPreview(values), [A, B], 'sorted, only real ids');
  assert.equal(values.name, 'Clinic plan');
  assert.equal(values.reason, 'Because');
  assert.equal(withBillTicks(values)[`bill_${A}`], 'on');
  assert.deepEqual(readFlash(raw, '/plans/other'), {}, 'bound to the page it was written for');
  assert.ok(!cookie.includes('csrf') && !('csrf' in values) && !('idempotencyKey' in values));
});

test('a preview marker with no kept schedule fields shows no preview', () => {
  assert.equal(hasPreviewValues({ preview: 'create' }), false);
  assert.equal(hasPreviewValues({ preview: 'create', firstDueDate: '2026-09-01' }), true);
});
