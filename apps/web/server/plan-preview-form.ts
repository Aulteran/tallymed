// The Preview buttons of the plan forms. A preview is a POST (with the CSRF token) so typed values, free text included, never reach the
// address bar: the route puts the fields into the one-shot flash cookie and redirects with only `?preview=<kind>`. These are the pure
// parts: which fields travel, how the bill ticks are spelled in the cookie, and which page the redirect goes to.
import { AppError } from './errors.ts';

export const PREVIEW_KINDS = ['create', 'progress', 'revise', 'restructure'] as const;
export type PreviewKind = typeof PREVIEW_KINDS[number];

export const SCHEDULE_FIELDS = ['totalAmount', 'installmentCount', 'firstDueDate', 'cadence', 'inputMode', 'installmentAmount', 'remainder', 'reviseMode'];
/** The "List each installment" fields that travel with the schedule: the pasted text, and the table rows as one `instRows` text (`withInstRowsFlash`). */
export const LIST_FIELDS = ['installmentsText', 'instRows'];
/** `readFlash` only accepts names of letters, digits and dots, so the `bill_<id>` ticks of the create form travel as `bill.<n>` with the id as the value. */
export const PREVIEW_BILL_SLOTS = 20;
export const BILL_KEYS = Array.from({ length: PREVIEW_BILL_SLOTS }, (_, i) => `bill.${i}`);
/** The fields only "Add a plan that's already in progress" adds: was it restructured, and the restart (its own names, since the form also carries the original schedule's `firstDueDate`, `installmentAmount` and `cadence`). */
export const PROGRESS_FIELDS = ['restructured', 'restartOn', 'restartAmount', 'restartCadence'];
/** Every field a preview keeps for re-filling the form it came from (never the idempotency key, the version or the CSRF token). */
export const PREVIEW_KEEP = ['name', 'startedOn', 'matchExisting', 'billId', 'reason', 'dialog', ...PROGRESS_FIELDS, ...BILL_KEYS, ...SCHEDULE_FIELDS, ...LIST_FIELDS];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BILL_TICK = /^bill_([0-9a-f-]{36})$/;

export function previewKind(body: Record<string, unknown>): PreviewKind {
  const k = body.preview;
  if (typeof k !== 'string' || !(PREVIEW_KINDS as readonly string[]).includes(k)) throw new AppError('invalid_input');
  return k as PreviewKind;
}

/** The page a preview of this kind returns to: the plan list for a new plan, the plan itself otherwise. Built from fixed paths and a validated id only. */
export function previewPage(kind: PreviewKind, body: Record<string, unknown>): string {
  if (kind === 'create' || kind === 'progress') return '/plans';
  const id = body.planId;
  if (typeof id !== 'string' || !UUID.test(id)) throw new AppError('invalid_input');
  return `/plans/${id}`;
}

/** The body with each ticked `bill_<id>` re-spelled as `bill.<n>` (ids in order, at most PREVIEW_BILL_SLOTS), ready for the flash cookie. */
export function withBillSlots(body: Record<string, unknown>): Record<string, unknown> {
  const ticked = Object.entries(body).filter(([k, v]) => BILL_TICK.test(k) && (v === 'on' || v === 'yes')).map(([k]) => BILL_TICK.exec(k)![1]!).filter((id) => UUID.test(id)).sort();
  return { ...body, ...Object.fromEntries(ticked.slice(0, PREVIEW_BILL_SLOTS).map((id, i) => [`bill.${i}`, id])) };
}

/** The ticked bill ids a preview kept (from the flash values), in the order they were stored. */
export function billIdsOfPreview(values: Record<string, string>): string[] {
  return BILL_KEYS.map((k) => values[k]).filter((v): v is string => typeof v === 'string' && UUID.test(v));
}

/** The flash values as the `bill_<id>` ticks the create preview and the create form read. */
export function withBillTicks(values: Record<string, string>): Record<string, string> {
  return { ...values, ...Object.fromEntries(billIdsOfPreview(values).map((id) => [`bill_${id}`, 'on'])) };
}

/** True when the flash still holds a preview's schedule fields. The cookie lives two minutes: a marker with no values (an old link, a refresh later) shows no preview. */
export const hasPreviewValues = (values: Record<string, string>): boolean => SCHEDULE_FIELDS.some((f) => values[f] !== undefined);
