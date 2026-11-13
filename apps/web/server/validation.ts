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

// ---------- payments and payment plans ----------

const positiveUsd = z.string().transform((v, ctx) => {
  try {
    const cents = parseNonNegativeUsd(v);
    if (cents === 0n) throw new RangeError('zero');
    return cents;
  } catch {
    ctx.addIssue({ code: 'custom', message: 'invalid amount' });
    return z.NEVER;
  }
});
const paymentMethod = z.enum(['card', 'bank_transfer', 'check', 'cash', 'portal', 'other']);
const cadence = z.enum(['weekly', 'biweekly', 'monthly', 'custom']);
const allocationLine = z.strictObject({ billId: uuid, amount: positiveUsd });
const refundLine = z.strictObject({ allocationId: uuid, amount: positiveUsd });
const installmentLine = z.strictObject({ dueDate: isoDate, amount: positiveUsd });
const intField = (min: number, max: number) => z.preprocess(blank, z.coerce.number().int().min(min).max(max).nullable().default(null));

/**
 * Allocation requests arrive either as a JSON `allocations` array or, from a form, as one `billId` plus an amount. Both
 * normalize to an `allocations` list, so the service only ever sees one shape.
 */
function allocationsOf(d: { allocations?: Array<{ billId: string; amount: bigint }>; billId?: string | null; allocateAmount?: bigint | null }, fallback: bigint | null) {
  if (d.allocations && d.allocations.length > 0) return d.allocations;
  if (d.billId) return [{ billId: d.billId, amount: (d.allocateAmount ?? fallback) as bigint }];
  return [];
}
const allocationInput = {
  allocations: z.array(allocationLine).max(25).optional(), billId: optional(uuid), allocateAmount: optional(positiveUsd),
};
const mixedAllocation = (d: { allocations?: unknown[]; billId?: string | null; allocateAmount?: bigint | null }) =>
  !(d.allocations && d.allocations.length > 0 && (d.billId || d.allocateAmount)) && !(d.allocateAmount && !d.billId);

/** A schedule is generated (total, count, first due date, cadence) or listed explicitly (JSON `installments`, custom cadence). */
const scheduleInput = {
  cadence: z.preprocess(blank, cadence.default('monthly')),
  totalAmount: optional(positiveUsd), installmentCount: intField(1, 120), firstDueDate: optional(isoDate),
  installments: z.array(installmentLine).max(120).optional(),
};

export const paymentSchemas = {
  createPayment: z.strictObject({
    idempotencyKey, paidOn: isoDate, amount: positiveUsd, method: paymentMethod, reference: optional(text(80).min(1)), note: optionalText(500),
    ...allocationInput, ...csrf,
  }).refine(mixedAllocation).transform((d) => {
    const { billId: _b, allocateAmount: _a, allocations: _l, ...rest } = d;
    return { ...rest, allocations: allocationsOf(d, d.amount) };
  }),
  allocatePayment: z.strictObject({ idempotencyKey, paymentId: uuid, ...allocationInput, ...csrf })
    .refine(mixedAllocation).transform((d) => ({ idempotencyKey: d.idempotencyKey, paymentId: d.paymentId, csrf: d.csrf, allocations: allocationsOf(d, null) }))
    .refine((d) => d.allocations.length > 0 && d.allocations.every((a) => typeof a.amount === 'bigint')),
  reverseAllocation: z.strictObject({
    idempotencyKey, paymentId: uuid.optional(), allocationId: uuid, amount: optional(positiveUsd), effectiveDate: isoDate, reason: text(500).min(1), ...csrf,
  }),
  recordRefund: z.strictObject({
    idempotencyKey, paymentId: uuid, effectiveDate: isoDate, reason: text(500).min(1),
    lines: z.array(refundLine).max(25).optional(), unappliedAmount: optional(positiveUsd),
    // Form shorthand: one allocation to refund, or none for unapplied cash, with an amount.
    allocationId: optional(uuid), amount: optional(positiveUsd), ...csrf,
  }).transform((d, ctx) => {
    const lines = d.lines && d.lines.length > 0 ? d.lines : d.allocationId && d.amount ? [{ allocationId: d.allocationId, amount: d.amount }] : [];
    const unapplied = d.unappliedAmount ?? (!d.allocationId && !(d.lines && d.lines.length > 0) ? d.amount : null);
    if ((d.lines?.length && (d.allocationId || d.amount)) || (lines.length === 0 && unapplied === null)) {
      ctx.addIssue({ code: 'custom', message: 'refund needs lines or an amount' });
      return z.NEVER;
    }
    return { idempotencyKey: d.idempotencyKey, paymentId: d.paymentId, effectiveDate: d.effectiveDate, reason: d.reason, lines, unappliedCents: unapplied, csrf: d.csrf };
  }),
  reverseRefund: z.strictObject({ idempotencyKey, paymentId: uuid.optional(), eventId: uuid, effectiveDate: isoDate, reason: text(500).min(1), ...csrf }),
  voidPayment: z.strictObject({ idempotencyKey, paymentId: uuid, voidedOn: isoDate, reason: text(500).min(1), ...csrf }),
  createPlan: z.strictObject({
    idempotencyKey, name: text(120).min(1), providerId: uuid, billIds: z.array(uuid).max(20).optional(), billId: optional(uuid), ...scheduleInput, ...csrf,
  }).transform((d, ctx) => {
    const billIds = d.billIds && d.billIds.length > 0 ? d.billIds : d.billId ? [d.billId] : [];
    if ((d.billIds?.length && d.billId) || billIds.length === 0 || new Set(billIds).size !== billIds.length) {
      ctx.addIssue({ code: 'custom', message: 'choose the bills the plan covers' });
      return z.NEVER;
    }
    const { billId: _b, billIds: _l, ...rest } = d;
    return { ...rest, billIds };
  }),
  revisePlan: z.strictObject({ idempotencyKey, planId: uuid, version, reason: text(500).min(1), ...scheduleInput, ...csrf }),
  cancelPlan: z.strictObject({ planId: uuid, version, reason: text(500).min(1), ...csrf }),
  matchInstallment: z.strictObject({ idempotencyKey, planId: uuid.optional(), installmentId: uuid, allocationId: uuid, amount: positiveUsd, ...csrf }),
  unmatchInstallment: z.strictObject({ idempotencyKey, planId: uuid.optional(), installmentId: uuid, allocationId: uuid, amount: positiveUsd, reason: text(500).min(1), ...csrf }),
};

export const paymentFilterSchemas = {
  payment: z.object({
    q: optionalFilter(text(80)), memberId: optionalFilter(uuid), providerId: optionalFilter(uuid), billId: optionalFilter(uuid),
    from: optionalFilter(isoDate), to: optionalFilter(isoDate), unapplied: checkbox, cursor, limit: pageSize,
  }),
  plan: z.object({
    q: optionalFilter(text(80)), providerId: optionalFilter(uuid), status: optionalFilter(z.enum(['active', 'cancelled'])), cursor, limit: pageSize,
  }),
  installments: z.object({
    memberId: optionalFilter(uuid), providerId: optionalFilter(uuid), planId: optionalFilter(uuid),
    state: z.preprocess(blank, z.enum(['overdue', 'upcoming', 'open']).default('open')),
    asOf: optionalFilter(isoDate), cursor, limit: pageSize,
  }),
};
export type PaymentFilter = z.infer<typeof paymentFilterSchemas.payment>;
export type PlanFilter = z.infer<typeof paymentFilterSchemas.plan>;
export type InstallmentFilter = z.infer<typeof paymentFilterSchemas.installments>;

// ---------- HSA reimbursements ----------

const evidenceType = z.enum(['receipt', 'eob', 'statement', 'provider_letter', 'plan_document', 'other']);
const decisionStatus = z.enum(['eligible', 'ineligible', 'pending']);
const receiptSource = z.enum(['administrator_transfer', 'hsa_debit_card', 'portal_reimbursement', 'other']);
const releaseKind = z.enum(['reject', 'cancel']);
const decisionVersion = z.coerce.number().int().min(0).max(1_000_000);
const claimLine = z.strictObject({ allocationId: uuid, amount: positiveUsd });
const receiptLine = z.strictObject({ lineId: uuid, amount: positiveUsd });

export const hsaSchemas = {
  /** An eligibility decision. `version` is the number of decisions the person saw, so a stale form is refused. */
  decide: z.strictObject({
    idempotencyKey, allocationId: uuid, version: decisionVersion, status: decisionStatus, eligibleAmount: optional(positiveUsd),
    rationale: text(500).min(1), evidenceType: optional(evidenceType), evidenceNote: optional(text(300).min(1)), contextNote: optionalText(300),
    decidedOn: isoDate, ...csrf,
  }).refine((d) => (d.status === 'eligible') === (d.eligibleAmount !== null))
    .refine((d) => d.status === 'pending' || (d.evidenceType !== null && d.evidenceNote !== null)),
  /** A claim submission. JSON sends `lines`; a form sends one allocation and an amount. */
  submitClaim: z.strictObject({
    idempotencyKey, submittedOn: isoDate, administrator: text(80).min(1), reference: optional(text(80).min(1)), note: optionalText(500),
    lines: z.array(claimLine).max(25).optional(), allocationId: optional(uuid), amount: optional(positiveUsd), ...csrf,
  }).transform((d, ctx) => {
    const lines = d.lines && d.lines.length > 0 ? d.lines : d.allocationId && d.amount ? [{ allocationId: d.allocationId, amount: d.amount }] : [];
    if ((d.lines?.length && (d.allocationId || d.amount)) || lines.length === 0 || new Set(lines.map((l) => l.allocationId)).size !== lines.length) {
      ctx.addIssue({ code: 'custom', message: 'a claim needs one line per allocation' });
      return z.NEVER;
    }
    const { lines: _l, allocationId: _a, amount: _m, ...rest } = d;
    return { ...rest, lines };
  }),
  /** Rejects or cancels the open reservation of a claim line (all of it when no amount is given). */
  releaseLine: z.strictObject({
    idempotencyKey, claimId: uuid.optional(), allocationId: uuid.optional(), lineId: uuid, kind: releaseKind, amount: optional(positiveUsd),
    effectiveDate: isoDate, reason: text(500).min(1), ...csrf,
  }),
  /** A receipt that pays claim lines. JSON sends `lines`; a form sends one line and an amount. */
  recordReceipt: z.strictObject({
    idempotencyKey, claimId: uuid.optional(), receivedOn: isoDate, source: receiptSource, reference: optional(text(80).min(1)), note: optionalText(500),
    evidenceType: optional(evidenceType), evidenceNote: optional(text(300).min(1)),
    lines: z.array(receiptLine).max(25).optional(), lineId: optional(uuid), amount: optional(positiveUsd), ...csrf,
  }).transform((d, ctx) => {
    const lines = d.lines && d.lines.length > 0 ? d.lines : d.lineId && d.amount ? [{ lineId: d.lineId, amount: d.amount }] : [];
    if ((d.lines?.length && (d.lineId || d.amount)) || lines.length === 0 || new Set(lines.map((l) => l.lineId)).size !== lines.length) {
      ctx.addIssue({ code: 'custom', message: 'a receipt needs one amount per claim line' });
      return z.NEVER;
    }
    const { lines: _l, lineId: _i, amount: _m, ...rest } = d;
    return { ...rest, lines };
  }),
  /** A reimbursement that was not initiated from a claim here. Source and evidence are required. */
  recordExternalReceipt: z.strictObject({
    idempotencyKey, receivedOn: isoDate, source: receiptSource, reference: optional(text(80).min(1)), note: optionalText(500),
    evidenceType, evidenceNote: text(300).min(1), lines: z.array(claimLine).max(25).optional(), allocationId: optional(uuid), amount: optional(positiveUsd), ...csrf,
  }).transform((d, ctx) => {
    const lines = d.lines && d.lines.length > 0 ? d.lines : d.allocationId && d.amount ? [{ allocationId: d.allocationId, amount: d.amount }] : [];
    if ((d.lines?.length && (d.allocationId || d.amount)) || lines.length === 0 || new Set(lines.map((l) => l.allocationId)).size !== lines.length) {
      ctx.addIssue({ code: 'custom', message: 'a receipt needs one amount per allocation' });
      return z.NEVER;
    }
    const { lines: _l, allocationId: _a, amount: _m, ...rest } = d;
    return { ...rest, lines };
  }),
  reverseReceipt: z.strictObject({ idempotencyKey, receiptId: uuid, allocationId: uuid.optional(), effectiveDate: isoDate, reason: text(500).min(1), ...csrf }),
};

const hsaState = z.enum(['undecided', 'eligible', 'available', 'pending', 'received', 'needs_review', 'ineligible']);
export const hsaFilterSchemas = {
  scope: z.object({ memberId: optionalFilter(uuid), providerId: optionalFilter(uuid), from: optionalFilter(isoDate), to: optionalFilter(isoDate) }),
  allocations: z.object({
    memberId: optionalFilter(uuid), providerId: optionalFilter(uuid), from: optionalFilter(isoDate), to: optionalFilter(isoDate),
    state: optionalFilter(hsaState), cursor, limit: pageSize,
  }),
  claims: z.object({ status: optionalFilter(z.enum(['open', 'closed'])), cursor, limit: pageSize }),
  exportScope: z.object({
    kind: z.preprocess(blank, z.enum(['allocations', 'events', 'decisions']).default('allocations')),
    memberId: optionalFilter(uuid), providerId: optionalFilter(uuid), from: optionalFilter(isoDate), to: optionalFilter(isoDate),
  }),
};
export type HsaScope = z.infer<typeof hsaFilterSchemas.scope>;
export type HsaAllocationFilter = z.infer<typeof hsaFilterSchemas.allocations>;
export type HsaClaimFilter = z.infer<typeof hsaFilterSchemas.claims>;
export type HsaExportScope = z.infer<typeof hsaFilterSchemas.exportScope>;
