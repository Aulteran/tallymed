// The payload of a payment plan proposal: the data of the "Add a plan already in progress" form, as an assistant states it. Pure (zod, money and
// text cleaning only), so the MCP listener can validate with it without importing any service that writes, and the web app validates the stored
// JSON again with the very same schema before it shows or applies anything.
//
// The limits are the app's own: 120 installments, 20 bills, amounts in USD strings that parse to whole cents no larger than MAX_CENTS,
// ISO dates from 1900 to 2100. `planProposalFormInput` is the ONE mapping from a stored payload to the input of the in-progress form, used by the
// review preview, the approval and "open in the form", so the three cannot disagree about what a proposal means.
import { z } from 'zod';
import { centsToUsdInput, parseNonNegativeUsd } from './money.ts';
import { cleanText } from './untrusted-text.ts';

export const MAX_PROPOSED_INSTALLMENTS = 120;
export const MAX_PROPOSED_BILLS = 20;
export const PLAN_NOTE_MAX = 500;
/** The reason saved on revision 2 of an approved restructure. A fixed sentence, never the assistant's text. */
export const PROPOSED_RESTRUCTURE_REASON = 'Restructured, as proposed by an assistant and approved by a person';

const isoDate = z.iso.date().refine((v) => v >= '1900-01-01' && v <= '2100-01-01');
/** A positive USD amount, spelled as its canonical plain decimal ("1200.00"), so a stored payload reads back identically. */
const usd = z.string().max(24).transform((v, ctx) => {
  try {
    const cents = parseNonNegativeUsd(v);
    if (cents === 0n) throw new RangeError('zero');
    return centsToUsdInput(cents);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'invalid amount' });
    return z.NEVER;
  }
});
const cadence = z.enum(['weekly', 'biweekly', 'monthly']);
const cleaned = (max: number) => z.string().max(max * 4).transform(cleanText).pipe(z.string().min(1).max(max));

const total = z.strictObject({
  mode: z.literal('total'), totalAmount: usd, installmentCount: z.number().int().min(1).max(MAX_PROPOSED_INSTALLMENTS), firstDueDate: isoDate, cadence,
  remainder: z.enum(['earliest', 'last_extra', 'last_short']).default('earliest'),
});
const perInstallment = z.strictObject({
  mode: z.literal('per_installment'), installmentAmount: usd, installmentCount: z.number().int().min(1).max(MAX_PROPOSED_INSTALLMENTS).optional(), totalAmount: usd.optional(),
  firstDueDate: isoDate, cadence,
}).refine((d) => d.installmentCount !== undefined || d.totalAmount !== undefined, { message: 'give a number of installments or a total' });
const list = z.strictObject({
  mode: z.literal('list'),
  installments: z.array(z.strictObject({ dueDate: isoDate, amount: usd })).min(1).max(MAX_PROPOSED_INSTALLMENTS),
});
const restructure = z.strictObject({ restartOn: isoDate, amountPerInstallment: usd, cadence });

/** The plan as stored in `plan_proposals.payload`. */
export const planProposalPlan = z.strictObject({
  name: cleaned(120),
  billIds: z.array(z.uuid()).min(1).max(MAX_PROPOSED_BILLS).refine((ids) => new Set(ids).size === ids.length, { message: 'each bill once' }),
  startedOn: isoDate,
  matchExisting: z.boolean().default(true),
  schedule: z.union([total, perInstallment, list]),
  restructure: restructure.optional(),
});
export type PlanProposalPlan = z.infer<typeof planProposalPlan>;

/** What the MCP tool accepts: the plan and the assistant's short rationale (plain text, kept apart from the payload). */
export const planProposalInput = planProposalPlan.extend({ note: cleaned(PLAN_NOTE_MAX) });
export type PlanProposalInput = z.infer<typeof planProposalInput>;

/** The payload as the strict schema reads it, or null for anything that is not a valid payload (a tampered row). */
export function readPlanProposalPayload(raw: unknown): PlanProposalPlan | null {
  const r = planProposalPlan.safeParse(raw);
  return r.success ? r.data : null;
}

/** The fields of the in-progress form (JSON caller shape) that this proposal stands for. Only strings, numbers and booleans, ready for the app's own schema. */
export function planProposalFormInput(p: PlanProposalPlan): Record<string, unknown> {
  const s = p.schedule;
  const schedule = s.mode === 'total'
    ? { inputMode: 'total', totalAmount: s.totalAmount, installmentCount: s.installmentCount, firstDueDate: s.firstDueDate, cadence: s.cadence, remainder: s.remainder }
    : s.mode === 'per_installment'
      ? { inputMode: 'per_installment', installmentAmount: s.installmentAmount, ...(s.installmentCount !== undefined ? { installmentCount: s.installmentCount } : {}), ...(s.totalAmount !== undefined ? { totalAmount: s.totalAmount } : {}), firstDueDate: s.firstDueDate, cadence: s.cadence }
      : { installments: s.installments.map((i) => ({ dueDate: i.dueDate, amount: i.amount })) };
  return {
    name: p.name, billIds: [...p.billIds], startedOn: p.startedOn, matchExisting: p.matchExisting, ...schedule,
    ...(p.restructure
      ? { restructured: true, restartOn: p.restructure.restartOn, restartAmount: p.restructure.amountPerInstallment, restartCadence: p.restructure.cadence, reason: PROPOSED_RESTRUCTURE_REASON }
      : { restructured: false }),
  };
}
