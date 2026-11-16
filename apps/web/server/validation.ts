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
// A PIN field is shape-checked by the service (six digits, entered twice); an empty field is absent.
const pinInput = z.preprocess((v) => (v === '' ? undefined : v), z.string().max(12).optional());
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
  login: z.strictObject({ email, password: z.string().min(1).max(MAX_PASSWORD_LENGTH), remember: checkbox }),
  forgotPassword: z.strictObject({ email }),
  lock: z.strictObject({ next: optionalText(300), ...csrf }),
  unlock: z.strictObject({ pin: z.string().max(12), next: optionalText(300), ...csrf }),
  changePin: z.strictObject({
    currentPin: pinInput, currentPassword: z.preprocess((v) => (v === '' ? undefined : v), password.optional()),
    newPin: z.string().max(12), confirmPin: z.string().max(12), ...csrf,
  }),
  heartbeat: z.strictObject({ ...csrf }),
  logout: z.strictObject({ csrf: z.string().optional() }),
  invite: z.strictObject({ email, role, csrf: z.string().optional() }),
  revokeInvitation: z.strictObject({ invitationId: uuid, csrf: z.string().optional() }),
  accept: z.strictObject({ token, displayName, password, pin: pinInput, confirmPin: pinInput }),
  updateOperator: z.strictObject({
    userId: uuid,
    version: z.coerce.number().int().min(1),
    role,
    status: z.enum(['active', 'disabled']),
    csrf: z.string().optional(),
  }),
  resetPassword: z.strictObject({ userId: uuid, version, ...csrf }),
  changePassword: z.strictObject({
    currentPassword: z.preprocess((v) => (v === '' ? undefined : v), password.optional()), newPassword: password, confirmPassword: password,
    page: z.enum(['required', 'account']).optional(), ...csrf,
  }),
  setup: z.strictObject({ setupToken: z.string().trim().min(1).max(200), householdName: z.string().trim().min(1).max(120), email, displayName, password, pin: pinInput, confirmPin: pinInput }),
  bootstrap: z.strictObject({ householdName: z.string().trim().min(1).max(120), email, displayName, password, pin: pinInput, confirmPin: pinInput }),
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
// A saved payment method (a named card or account). Only the last four digits are ever accepted, never a full number.
const paymentMethodKind = z.enum(['credit_card', 'debit_card', 'hsa_fsa_card', 'bank_account', 'other']);
const lastFour = z.string().trim().regex(/^[0-9]{4}$/);
// A nickname is a label, so nine or more digits in a row (spaces, hyphens, dots, slashes and underscores ignored) are refused: a pasted card or account number cannot be stored here either.
const noAccountNumber = (v: string) => !/[0-9]{9,}/.test(v.replace(/[ ./_-]/g, ''));
const methodNickname = text(60).min(1).refine(noAccountNumber);
// HSA account labels follow the same rule.
const hsaAccountName = text(60).min(1).refine(noAccountNumber);
const hsaAdministrator = z.preprocess((v) => (v === undefined ? '' : v), text(80).refine(noAccountNumber));
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
  // "total": this many installments at this much price. "per_installment": this many installments at this much paid per installment.
  // (The form's "list each installment" choice never reaches here: `withInstallmentList` turns it into `installments` first.)
  inputMode: z.preprocess(blank, z.enum(['total', 'per_installment']).default('total')),
  installmentAmount: optional(positiveUsd),
  // Where the leftover cents of a generated "total" split go. The default keeps the original behavior.
  remainder: z.preprocess(blank, z.enum(['earliest', 'last_extra', 'last_short']).default('earliest')),
};

/** The schedule fields alone (a form preview reads them from its flash cookie). Same field rules as creating and revising a plan, a listed schedule included. */
export const schedulePreviewSchema = z.object({
  ...scheduleInput, reviseMode: z.preprocess(blank, z.enum(['replace', 'keep_paid']).default('replace')),
});

/** Creating a plan adds a start date and whether existing payments are matched; the bills come from `bill_<id>` ticks. */
export const createPlanPreviewSchema = schedulePreviewSchema.extend({ startedOn: optional(isoDate), matchExisting: checkbox.optional() });

/**
 * What "Add a plan that's already in progress" adds to a plan's fields: whether the plan was restructured (a Yes/No radio, or JSON `true`) and
 * the restructure itself. With "No" the restart fields are accepted and ignored, since a form without JavaScript always sends them.
 */
const inProgressFields = {
  restructured: checkbox.optional(),
  restartOn: optional(isoDate), restartAmount: optional(positiveUsd), restartCadence: z.preprocess(blank, z.enum(['weekly', 'biweekly', 'monthly']).default('monthly')),
  reason: optionalText(500),
};

/** The in-progress form's fields alone (a preview reads them from its flash cookie). The start date is required, though a preview names it itself. */
export const createPlanInProgressPreviewSchema = z.object({ ...scheduleInput, startedOn: optional(isoDate), matchExisting: checkbox.optional(), ...inProgressFields });

export const paymentSchemas = {
  createPayment: z.strictObject({
    idempotencyKey, paidOn: isoDate, amount: positiveUsd, method: paymentMethod, paidWithId: optional(uuid), hsaIneligible: checkbox, reference: optional(text(80).min(1)), note: optionalText(500),
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
  // Removing a payment hides it and returns its cash; the reason is kept on the removal event, never in the audit row.
  removePayment: z.strictObject({ idempotencyKey, paymentId: uuid, reason: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), text(500).min(1).default('Removed by administrator')), ...csrf }),
  // The undo slot is the actor's own and holds what to reverse, so the request carries nothing but a key.
  undo: z.strictObject({ idempotencyKey, ...csrf }),
  // An empty paidWithId clears the choice.
  setPaidWith: z.strictObject({ idempotencyKey, paymentId: uuid, paidWithId: optional(uuid), ...csrf }),
// An HSA account can be linked only to an HSA/FSA card.
  createPaymentMethod: z.strictObject({ nickname: methodNickname, kind: paymentMethodKind, lastFour: optional(lastFour), hsaAccountId: optional(uuid), ...csrf })
    .refine((d) => d.hsaAccountId === null || d.kind === 'hsa_fsa_card'),
  updatePaymentMethod: z.strictObject({ id: uuid, version, nickname: methodNickname, kind: paymentMethodKind, lastFour: optional(lastFour), hsaAccountId: optional(uuid), ...csrf })
    .refine((d) => d.hsaAccountId === null || d.kind === 'hsa_fsa_card'),
  // "Also has a spending card": the card is saved as an HSA/FSA card payment method linked to the new account, in the same step. The card
  // fields are read only when the box is ticked, so an unticked form with stale card text behaves as a plain account.
  createHsaAccount: z.strictObject({
    name: hsaAccountName, administrator: hsaAdministrator, lastFour: optional(lastFour),
    hasCard: checkbox, cardNickname: z.string().optional(), cardLastFour: z.string().optional(), ...csrf,
  }).transform((d, ctx) => {
    const { hasCard, cardNickname, cardLastFour, ...rest } = d;
    if (!hasCard) return { ...rest, card: null };
    const nickname = methodNickname.safeParse(cardNickname ?? '');
    if (!nickname.success) {
      ctx.addIssue({ code: 'custom', message: 'a spending card needs a nickname' });
      return z.NEVER;
    }
    const four = cardLastFour === undefined || blank(cardLastFour) === null ? { success: true as const, data: null } : lastFour.safeParse(cardLastFour);
    if (!four.success) {
      ctx.addIssue({ code: 'custom', message: 'card last four must be four digits' });
      return z.NEVER;
    }
    return { ...rest, card: { nickname: nickname.data, kind: 'hsa_fsa_card' as const, lastFour: four.data } };
  }),
  updateHsaAccount: z.strictObject({ id: uuid, version, name: hsaAccountName, administrator: hsaAdministrator, lastFour: optional(lastFour), ...csrf }),
  archiveHsaAccount: z.strictObject({ id: uuid, version, archived: checkbox, ...csrf }),
  archivePaymentMethod: z.strictObject({ id: uuid, version, archived: checkbox, ...csrf }),
  createPlan: z.strictObject({
    idempotencyKey, name: text(120).min(1), billIds: z.array(uuid).max(20).optional(), billId: optional(uuid), matchExisting: checkbox.optional(), startedOn: optional(isoDate), ...scheduleInput, ...csrf,
  }).transform((d, ctx) => {
    const billIds = d.billIds && d.billIds.length > 0 ? d.billIds : d.billId ? [d.billId] : [];
    if ((d.billIds?.length && d.billId) || billIds.length === 0 || new Set(billIds).size !== billIds.length) {
      ctx.addIssue({ code: 'custom', message: 'choose the bills the plan covers' });
      return z.NEVER;
    }
    const { billId: _b, billIds: _l, ...rest } = d;
    return { ...rest, billIds };
  }),
  createPlanInProgress: z.strictObject({
    idempotencyKey, name: text(120).min(1), billIds: z.array(uuid).max(20).optional(), billId: optional(uuid), startedOn: isoDate, matchExisting: checkbox.optional(), ...scheduleInput, ...inProgressFields, ...csrf,
  }).transform((d, ctx) => {
    const billIds = d.billIds && d.billIds.length > 0 ? d.billIds : d.billId ? [d.billId] : [];
    if ((d.billIds?.length && d.billId) || billIds.length === 0 || new Set(billIds).size !== billIds.length) {
      ctx.addIssue({ code: 'custom', message: 'choose the bills the plan covers' });
      return z.NEVER;
    }
    const { billId: _b, billIds: _l, ...rest } = d;
    return { ...rest, billIds };
  }),
  matchExistingPayments: z.strictObject({ idempotencyKey, planId: uuid, version, ...csrf }),
  // The ticked rows of the "Suggested matches" card. Each must equal a suggestion the server computes again under its locks.
  applySuggestedMatches: z.strictObject({
    idempotencyKey, planId: uuid, version, ...csrf,
    rows: z.array(z.strictObject({ installmentId: uuid, allocationId: uuid, amount: positiveUsd })).min(1).max(120),
  }).refine((d) => new Set(d.rows.map((r) => `${r.installmentId}:${r.allocationId}`)).size === d.rows.length, { message: 'each installment and payment pair can appear once' }),
  revisePlan: z.strictObject({
    idempotencyKey, planId: uuid, version, reason: text(500).min(1), ...scheduleInput,
    // "replace" swaps the whole schedule. "keep_paid" keeps fully paid installments and restarts the rest from firstDueDate.
    reviseMode: z.preprocess(blank, z.enum(['replace', 'keep_paid']).default('replace')),
    ...csrf,
  }),
  cancelPlan: z.strictObject({ planId: uuid, version, reason: text(500).min(1), ...csrf }),
  // An administrator hides a plan (matches of an active plan are released first); undo brings it back for a few minutes.
  removePlan: z.strictObject({ idempotencyKey, planId: uuid, version, reason: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), text(500).min(1).default('Removed by administrator')), ...csrf }),
  // A plan's name is a label, so it can change at any time, including after the plan is cancelled.
  renamePlan: z.strictObject({ planId: uuid, name: text(120).min(1), ...csrf }),
  matchInstallment: z.strictObject({ idempotencyKey, planId: uuid.optional(), installmentId: uuid, allocationId: uuid, amount: positiveUsd, ...csrf }),
  unmatchInstallment: z.strictObject({ idempotencyKey, planId: uuid.optional(), installmentId: uuid, allocationId: uuid, amount: positiveUsd, reason: text(500).min(1), ...csrf }),
};

export const paymentFilterSchemas = {
  payment: z.object({
    q: optionalFilter(text(80)), memberId: optionalFilter(uuid), providerId: optionalFilter(uuid), billId: optionalFilter(uuid),
    from: optionalFilter(isoDate), to: optionalFilter(isoDate), unapplied: checkbox, cursor, limit: pageSize,
    // A saved payment method, or "none" for payments with no method recorded.
    paidWith: optionalFilter(z.union([uuid, z.literal('none')])),
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

// Removing an HSA record hides it (undo brings it back); the reason is kept on the removal event, never in the audit row. The optional claim and
// allocation fields only steer the redirect after the action; the service refuses a value that does not belong to the record.
const removalReason = z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), text(500).min(1).default('Removed by administrator'));

export const hsaSchemas = {
  removeDecision: z.strictObject({ idempotencyKey, decisionId: uuid, allocationId: uuid.optional(), reason: removalReason, ...csrf }),
  removeClaim: z.strictObject({ idempotencyKey, claimId: uuid, reason: removalReason, ...csrf }),
  removeReceipt: z.strictObject({ idempotencyKey, receiptId: uuid, claimId: uuid.optional(), reason: removalReason, ...csrf }),
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

const hsaState = z.enum(['eligible', 'available', 'pending', 'received', 'needs_review', 'ineligible']);
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

// ---------- documents ----------

export const DOCUMENT_KINDS = ['bill', 'eob', 'receipt', 'statement', 'provider_letter', 'plan_document', 'other'] as const;
const documentKind = z.enum(DOCUMENT_KINDS);
const attachmentTargetType = z.enum(['bill', 'visit', 'bill_adjustment', 'hsa_receipt', 'hsa_eligibility_decision']);
/** The uploaded part of a multipart request: bytes plus the client's declared name and type (both untrusted). */
const uploadedFile = z.custom<{ name: string; type: string; bytes: Uint8Array }>(
  (v) => typeof v === 'object' && v !== null && (v as { bytes?: unknown }).bytes instanceof Uint8Array && typeof (v as { name?: unknown }).name === 'string' && typeof (v as { type?: unknown }).type === 'string');

export const documentSchemas = {
  /** New document: one file, optional title, kind and note, optionally attached to one record at once. */
  upload: z.strictObject({
    idempotencyKey, file: uploadedFile, title: optional(text(120).min(1)), kind: documentKind.default('other'), note: optionalText(500),
    targetType: optional(attachmentTargetType), targetId: optional(uuid), confirmDuplicate: checkbox.optional(), ...csrf,
  }).refine((d) => (d.targetType === null) === (d.targetId === null)),
  /** A new version of an existing document. `version` is the number of versions the person saw. */
  addVersion: z.strictObject({ idempotencyKey, documentId: uuid, version: version, file: uploadedFile, confirmDuplicate: checkbox.optional(), ...csrf }),
  update: z.strictObject({ id: uuid, version, title: text(120).min(1), kind: documentKind, note: optionalText(500), ...csrf }),
  remove: z.strictObject({ id: uuid, version, reason: text(300).min(1), ...csrf }),
  /** `documentId` may carry the version the person saw as `<uuid>@<n>` (the attach pickers do); a newer version is refused as stale. */
  attach: z.strictObject({
    idempotencyKey, documentId: z.string().regex(/^[0-9a-f-]{36}(@[1-9]\d{0,5})?$/), targetType: attachmentTargetType, targetId: uuid, note: optionalText(300), ...csrf,
  }).transform((d, ctx) => {
    const [id, seen] = d.documentId.split('@');
    if (!uuid.safeParse(id).success) {
      ctx.addIssue({ code: 'custom', message: 'invalid document' });
      return z.NEVER;
    }
    return { ...d, documentId: id!, seenVersion: seen ? Number(seen) : null };
  }),
  detach: z.strictObject({ attachmentId: uuid, reason: text(300).min(1), ...csrf }),
};

export const documentFilterSchemas = {
  list: z.object({
    q: optionalFilter(text(80)), kind: optionalFilter(documentKind), unmatched: checkbox, cursor, limit: pageSize,
  }),
  /** Documents offered for attaching to a record: a bounded search, newest first. */
  picker: z.object({ q: optionalFilter(text(80)) }),
};
export type DocumentFilter = z.infer<typeof documentFilterSchemas.list>;

// ---------- optional assistant (MCP clients and proposal review) ----------

export const assistantSchemas = {
  /** Scopes arrive as separate checkboxes because a form field cannot repeat. */
  createClient: z.strictObject({
    name: text(80).min(1),
    expiryDays: z.preprocess(blank, z.coerce.number().int().min(1).max(365).default(90)),
    documentsRead: checkbox.optional(), recordsRead: checkbox.optional(), documentsContent: checkbox.optional(), proposalsCreate: checkbox.optional(), plansPropose: checkbox.optional(),
    ...csrf,
  }),
  revokeClient: z.strictObject({ clientId: uuid, reason: text(300).min(1), ...csrf }),
  /** `documentVersion` and `targetVersion` are the versions the person was shown; either having moved on refuses the approval. */
  approve: z.strictObject({ idempotencyKey, proposalId: uuid, documentVersion: version, targetVersion: version, documentRevision: version, ...csrf }),
  reject: z.strictObject({ proposalId: uuid, reason: text(300).min(1), ...csrf }),
  /** `previewDigest` is the fingerprint of the preview the person was shown; a different preview under the locks refuses the approval. */
  approvePlan: z.strictObject({ idempotencyKey, proposalId: uuid, previewDigest: z.string().regex(/^[0-9a-f]{64}$/), ...csrf }),
  rejectPlan: z.strictObject({ proposalId: uuid, reason: optionalText(300), ...csrf }),
};

export const assistantFilterSchemas = {
  proposals: z.object({ status: optionalFilter(z.enum(['pending', 'approved', 'rejected'])), cursor, limit: pageSize }),
  planProposals: z.object({ status: optionalFilter(z.enum(['pending', 'approved', 'rejected', 'expired', 'superseded'])), cursor, limit: pageSize }),
};
export type ProposalFilter = z.infer<typeof assistantFilterSchemas.proposals>;
export type PlanProposalFilter = z.infer<typeof assistantFilterSchemas.planProposals>;

/** A same-site path to return to after unlocking. Anything else (another origin, a protocol-relative URL, a sign-in or API address) becomes the overview. */
export function safeReturnPath(next: unknown): string {
  if (typeof next !== 'string' || next.length === 0 || next.length > 300) return '/';
  if (!/^\/(?![/\\])[\x21-\x7e]*$/.test(next)) return '/';
  if (/^\/(locked|login|api|invite|setup)(\/|\?|#|$)/.test(next)) return '/';
  return next;
}
