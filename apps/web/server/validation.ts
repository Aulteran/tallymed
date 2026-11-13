import { z } from 'zod';
import { AppError } from './errors.ts';
import { MAX_PASSWORD_LENGTH } from './passwords.ts';
import { parseNonNegativeUsd, parseUsd } from './money.ts';

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const displayName = z.string().trim().min(1).max(80);
const password = z.string().max(MAX_PASSWORD_LENGTH + 1); // policy is applied by the service
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const uuid = z.uuid();
const role = z.enum(['admin', 'operator']);

// Form fields arrive as strings; an empty optional field is null.
const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blank, schema.nullable().default(null));
const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) => z.preprocess((v) => (v === undefined ? '' : v), text(max));
const isoDate = z.iso.date().refine((v) => v >= '1900-01-01' && v <= '2100-01-01');
const usd = z.string().transform((v, ctx) => {
  try {
    return parseNonNegativeUsd(v);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'invalid amount' });
    return z.NEVER;
  }
});
const signedUsd = z.string().transform((v, ctx) => {
  try {
    const cents = parseUsd(v);
    if (cents === 0n) throw new RangeError('zero');
    return cents;
  } catch {
    ctx.addIssue({ code: 'custom', message: 'invalid amount' });
    return z.NEVER;
  }
});
const version = z.coerce.number().int().min(1).max(2_000_000_000);
const idempotencyKey = z.string().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/);
const csrf = { csrf: z.string().optional() };
const checkbox = z.preprocess((v) => v === 'yes' || v === 'on' || v === true, z.boolean());
const amountSource = z.enum(['statement', 'portal', 'eob', 'phone', 'manual']);
const adjustmentCategory = z.enum(['insurer_adjustment', 'insurer_payment', 'provider_discount', 'financial_assistance', 'correction']);
const providerKind = z.enum(['facility', 'clinician', 'lab', 'pharmacy', 'other']);

export const schemas = {
  id: uuid,
  createMember: z.strictObject({ name: text(80).min(1), dateOfBirth: optional(isoDate), notes: optionalText(2000), ...csrf }),
  updateMember: z.strictObject({ id: uuid, version, name: text(80).min(1), dateOfBirth: optional(isoDate), notes: optionalText(2000), ...csrf }),
  createProvider: z.strictObject({ name: text(120).min(1), kind: providerKind, notes: optionalText(2000), ...csrf }),
  updateProvider: z.strictObject({ id: uuid, version, name: text(120).min(1), kind: providerKind, notes: optionalText(2000), ...csrf }),
  archive: z.strictObject({ id: uuid, version, archived: checkbox, ...csrf }),
  createVisit: z.strictObject({
    memberId: uuid, providerId: uuid, serviceDate: isoDate, description: optionalText(200), notes: optionalText(2000), ...csrf,
  }),
  updateVisit: z.strictObject({
    id: uuid, version, providerId: uuid, serviceDate: isoDate, description: optionalText(200), notes: optionalText(2000), ...csrf,
  }),
  createBill: z.strictObject({
    idempotencyKey, memberId: uuid, providerId: uuid, visitId: optional(uuid), providerReference: optional(text(80).min(1)),
    statementDate: isoDate, dueDate: optional(isoDate), originalAmount: usd, responsibilityAmount: optional(usd),
    amountStatus: z.enum(['estimate', 'confirmed']), amountSource, sourceNote: optionalText(500), notes: optionalText(2000),
    confirmDuplicate: checkbox.optional(), ...csrf,
  }),
  updateBill: z.strictObject({
    id: uuid, version, providerId: uuid, providerReference: optional(text(80).min(1)), statementDate: isoDate, dueDate: optional(isoDate),
    originalAmount: optional(usd), responsibilityAmount: optional(usd), amountSource: optional(amountSource),
    sourceNote: optionalText(500), notes: optionalText(2000), ...csrf,
  }),
  confirmBill: z.strictObject({ id: uuid, version, ...csrf }),
  assignVisit: z.strictObject({ id: uuid, version, visitId: optional(uuid), ...csrf }),
  createAdjustment: z.strictObject({
    idempotencyKey, billId: uuid, amount: signedUsd, category: adjustmentCategory, effectiveDate: isoDate, reason: text(500).min(1),
    source: amountSource, sourceNote: optionalText(500), ...csrf,
  }),
  reverseAdjustment: z.strictObject({ idempotencyKey, billId: uuid, adjustmentId: uuid, reason: text(500).min(1), ...csrf }),
  login: z.strictObject({ email, password: z.string().min(1).max(MAX_PASSWORD_LENGTH) }),
  logout: z.strictObject({ csrf: z.string().optional() }),
  invite: z.strictObject({ email, role, csrf: z.string().optional() }),
  revokeInvitation: z.strictObject({ invitationId: uuid, csrf: z.string().optional() }),
  accept: z.strictObject({ token, displayName, password }),
  updateOperator: z.strictObject({
    userId: uuid,
    version: z.coerce.number().int().min(1),
    role,
    status: z.enum(['active', 'disabled']),
    csrf: z.string().optional(),
  }),
  bootstrap: z.strictObject({ householdName: z.string().trim().min(1).max(120), email, displayName, password }),
};

export function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw new AppError('invalid_input');
  return result.data;
}

const optionalFilter = <T extends z.ZodType>(schema: T) => z.preprocess(blank, schema.optional());
const cursor = optionalFilter(z.string().max(300));
const pageSize = z.preprocess(blank, z.coerce.number().int().min(1).max(100).default(25));

/** Query-string filters for the list and overview pages. Unknown keys are ignored by the pages, not by this schema. */
export const filterSchemas = {
  party: z.object({ q: optionalFilter(text(80)), archived: checkbox, cursor, limit: pageSize }),
  visit: z.object({
    q: optionalFilter(text(80)), memberId: optionalFilter(uuid), providerId: optionalFilter(uuid),
    from: optionalFilter(isoDate), to: optionalFilter(isoDate), cursor, limit: pageSize,
  }),
  bill: z.object({
    q: optionalFilter(text(80)), memberId: optionalFilter(uuid), providerId: optionalFilter(uuid), visitId: optionalFilter(uuid),
    status: optionalFilter(z.enum(['estimate', 'confirmed'])), awaitingVisit: checkbox, duplicates: checkbox,
    from: optionalFilter(isoDate), to: optionalFilter(isoDate), cursor, limit: pageSize,
  }),
};
export type PartyFilter = z.infer<typeof filterSchemas.party>;
export type VisitFilter = z.infer<typeof filterSchemas.visit>;
export type BillFilter = z.infer<typeof filterSchemas.bill>;
