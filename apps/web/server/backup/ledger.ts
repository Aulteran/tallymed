// Ledger checks for a restored database.
//
// A restore loads rows with the tables' own triggers switched off (exactly as pg_restore does: it creates triggers after the data), because
// several insert-time checks look at the present state of related rows and would refuse history that was valid when it was written. Checks,
// foreign keys and unique indexes stay on. The money rules that the deferred guards enforce one transaction at a time are therefore
// re-checked here over the whole database before the restore commits. Each query mirrors one guard from migrations 0004 to 0006 and
// returns the rows that break it; a correct backup returns none.
//
// Only rules that hold in every committed state are listed. Rules that apply to new entries alone are not: a bill balance may be negative
// (a provider credit after a later adjustment) and pending plus received HSA cash may exceed the ceiling (the "needs review" state).
import type { Queryable } from '../db.ts';

const MAX_CENTS = '10000000000000';

const CHECKS: ReadonlyArray<{ rule: string; sql: string }> = [
  {
    rule: 'bill responsibility is between zero and the supported maximum',
    sql: `select b.id from bills b
           where b.base_responsibility_cents + coalesce((select sum(a.amount_cents) from bill_adjustments a where a.bill_id = b.id), 0)
                 not between 0 and ${MAX_CENTS}`,
  },
  {
    rule: 'applied cash plus refunds never exceed a payment',
    sql: `select p.id from payments p
           left join lateral (
             select coalesce(sum(e.amount_cents) filter (where e.bill_id is not null), 0) as applied,
                    -coalesce(sum(e.amount_cents) filter (where e.kind in ('refund', 'unapplied_refund', 'refund_reversal')), 0) as refunded
               from payment_entries e where e.payment_id = p.id) s on true
           where s.applied < 0 or s.refunded < 0 or p.amount_cents - s.refunded - s.applied < 0`,
  },
  {
    rule: 'a voided payment keeps no applied or refunded cash',
    sql: `select v.payment_id from payment_voids v
           where exists (select 1 from payment_entries e where e.payment_id = v.payment_id
                          group by e.payment_id
                         having coalesce(sum(e.amount_cents) filter (where e.bill_id is not null), 0) <> 0
                             or coalesce(sum(e.amount_cents) filter (where e.kind in ('refund', 'unapplied_refund', 'refund_reversal')), 0) <> 0)`,
  },
  {
    rule: 'an allocation stays between zero and its original amount',
    sql: `select e.allocation_id from payment_entries e where e.allocation_id is not null
           group by e.allocation_id
          having sum(e.amount_cents) < 0 or sum(e.amount_cents) > (select a.amount_cents from payment_entries a where a.id = e.allocation_id)`,
  },
  {
    rule: 'cash is applied only to bills with confirmed amounts',
    sql: `select e.id from payment_entries e join bills b on b.id = e.bill_id where e.kind = 'allocation' and b.amount_status <> 'confirmed'`,
  },
  {
    rule: 'a reversal or refund targets an allocation of the same payment and bill',
    sql: `select e.id from payment_entries e left join payment_entries a on a.id = e.allocation_id
           where e.kind in ('allocation_reversal', 'refund')
             and (a.id is null or a.kind <> 'allocation' or a.payment_id <> e.payment_id or a.bill_id <> e.bill_id)`,
  },
  {
    rule: 'a refund reversal exactly offsets one refund of the same payment',
    sql: `select e.id from payment_entries e left join payment_entries t on t.id = e.reverses_entry_id
           where e.kind = 'refund_reversal'
             and (t.id is null or t.kind not in ('refund', 'unapplied_refund') or t.payment_id <> e.payment_id
                  or t.bill_id is distinct from e.bill_id or t.allocation_id is distinct from e.allocation_id or t.amount_cents <> -e.amount_cents)`,
  },
  {
    rule: 'a schedule revision has installments that add up to its total',
    sql: `select r.id from plan_revisions r
           left join lateral (select coalesce(sum(i.amount_cents), 0) as scheduled, count(*) as n from plan_installments i where i.revision_id = r.id) s on true
           where s.n < 1 or s.scheduled <> r.total_cents`,
  },
  {
    rule: 'a plan covers only confirmed bills of its provider',
    sql: `select pb.plan_id from payment_plan_bills pb
           where not exists (select 1 from payment_plans p join bills b on b.household_id = p.household_id and b.provider_id = p.provider_id
                              where p.id = pb.plan_id and b.id = pb.bill_id and b.amount_status = 'confirmed')`,
  },
  {
    rule: 'matches stay between zero and the installment amount',
    sql: `select i.id from plan_installments i join installment_matches m on m.installment_id = i.id
           group by i.id, i.amount_cents having sum(m.amount_cents) < 0 or sum(m.amount_cents) > i.amount_cents`,
  },
  {
    rule: 'an unmatch never exceeds what that allocation matched to the installment',
    sql: `select m.installment_id from installment_matches m group by m.installment_id, m.allocation_id having sum(m.amount_cents) < 0`,
  },
  {
    rule: 'plan matches on current schedules never exceed what an allocation still holds',
    sql: `select m.allocation_id from installment_matches m
            join plan_revisions r on r.id = m.revision_id
           where r.revision_no = (select max(x.revision_no) from plan_revisions x where x.plan_id = m.plan_id)
           group by m.allocation_id
          having sum(m.amount_cents) > (select coalesce(sum(e.amount_cents), 0) from payment_entries e where e.allocation_id = m.allocation_id)`,
  },
  {
    rule: 'an eligibility decision or HSA entry targets a payment allocation',
    sql: `select d.id from hsa_eligibility_decisions d where not exists (select 1 from payment_entries a where a.id = d.allocation_id and a.kind = 'allocation')
          union all
          select e.id from hsa_entries e where not exists (select 1 from payment_entries a where a.id = e.allocation_id and a.kind = 'allocation')`,
  },
  {
    rule: 'pending and received reimbursement per allocation are never negative',
    sql: `select e.allocation_id from hsa_entries e group by e.allocation_id
          having coalesce(sum(e.amount_cents) filter (where e.kind = 'reserve'), 0) - coalesce(sum(e.amount_cents) filter (where e.kind in ('receipt', 'reject', 'cancel')), 0) < 0
              or coalesce(sum(e.amount_cents) filter (where e.kind in ('receipt', 'external_receipt')), 0) - coalesce(sum(e.amount_cents) filter (where e.kind = 'receipt_reversal'), 0) < 0`,
  },
  {
    rule: 'a claim line is never paid or released beyond its reservation',
    sql: `select e.line_id from hsa_entries e where e.line_id is not null group by e.line_id
          having sum(case e.kind when 'reserve' then e.amount_cents when 'receipt' then -e.amount_cents when 'reject' then -e.amount_cents
                                 when 'cancel' then -e.amount_cents else 0 end) < 0`,
  },
  {
    rule: 'a claim line entry belongs to a reservation of the same claim and allocation',
    sql: `select e.id from hsa_entries e left join hsa_entries l on l.id = e.line_id
           where e.kind in ('receipt', 'reject', 'cancel')
             and (l.id is null or l.kind <> 'reserve' or l.claim_id <> e.claim_id or l.allocation_id <> e.allocation_id)`,
  },
  {
    rule: 'a receipt is allocated in full and a reversal covers every entry of the receipt',
    sql: `select r.id from hsa_receipts r
           left join lateral (
             select coalesce(sum(e.amount_cents) filter (where e.kind in ('receipt', 'external_receipt')), 0) as allocated,
                    count(*) filter (where e.kind in ('receipt', 'external_receipt')) as entries,
                    count(*) filter (where e.kind = 'receipt_reversal') as reversals
               from hsa_entries e where e.receipt_id = r.id) s on true
           where s.allocated <> r.amount_cents or s.reversals not in (0, s.entries)`,
  },
  {
    rule: 'a receipt entry matches the origin of its receipt and a receipt reversal exactly offsets one receipt entry',
    sql: `select e.id from hsa_entries e join hsa_receipts r on r.id = e.receipt_id
           where e.kind in ('receipt', 'external_receipt') and r.origin <> (case e.kind when 'receipt' then 'claim' else 'external' end)
          union all
          select e.id from hsa_entries e left join hsa_entries t on t.id = e.reverses_entry_id
           where e.kind = 'receipt_reversal'
             and (t.id is null or t.kind not in ('receipt', 'external_receipt') or t.allocation_id <> e.allocation_id or t.amount_cents <> e.amount_cents
                  or t.receipt_id <> e.receipt_id or t.claim_id is distinct from e.claim_id or t.line_id is distinct from e.line_id)`,
  },
  {
    rule: 'a removed document has no active attachment and an attachment points at a version of its own document',
    sql: `select a.id from document_attachments a join documents d on d.id = a.document_id
           where a.detached_at is null and d.removed_at is not null
          union all
          select a.id from document_attachments a join document_versions v on v.id = a.document_version_id where v.document_id <> a.document_id`,
  },
];

/** Names of the rules a database breaks. Empty for a consistent ledger. Never returns record content, only the rule and a count. */
export async function ledgerViolations(db: Queryable): Promise<string[]> {
  const broken: string[] = [];
  for (const check of CHECKS) {
    const r = await db.query<{ n: string }>(`select count(*) as n from (${check.sql}) v`);
    const n = Number(r.rows[0]!.n);
    if (n > 0) broken.push(`${check.rule} (${n} record${n === 1 ? '' : 's'})`);
  }
  return broken;
}

/**
 * Totals the application would report, in cents as decimal strings. Written into the manifest when a backup is made and recomputed from the
 * restored rows; the two must be identical before a restore commits.
 */
export async function ledgerSummary(db: Queryable): Promise<Record<string, string>> {
  const r = await db.query<Record<string, string>>(
    `select
       (select count(*) from bills)::text as "bills",
       (select count(*) from bills where amount_status = 'confirmed')::text as "confirmedBills",
       (select coalesce(sum(base_responsibility_cents), 0) from bills)::text as "baseResponsibilityCents",
       (select coalesce(sum(amount_cents), 0) from bill_adjustments)::text as "adjustmentCents",
       (select count(*) from payments)::text as "payments",
       (select coalesce(sum(amount_cents), 0) from payments)::text as "paymentCents",
       (select count(*) from payment_voids)::text as "voidedPayments",
       (select coalesce(sum(amount_cents), 0) from payment_entries where bill_id is not null)::text as "netAppliedCents",
       (select -coalesce(sum(amount_cents), 0) from payment_entries where kind in ('refund', 'unapplied_refund', 'refund_reversal'))::text as "netRefundedCents",
       (select count(*) from payment_plans)::text as "plans",
       (select coalesce(sum(i.amount_cents), 0) from plan_installments i join plan_revisions r on r.id = i.revision_id
          where r.revision_no = (select max(x.revision_no) from plan_revisions x where x.plan_id = r.plan_id))::text as "scheduledCents",
       (select coalesce(sum(m.amount_cents), 0) from installment_matches m join plan_revisions r on r.id = m.revision_id
          where r.revision_no = (select max(x.revision_no) from plan_revisions x where x.plan_id = m.plan_id))::text as "matchedCents",
       (select coalesce(sum(ceiling_cents), 0) from hsa_allocation_status)::text as "hsaEligibleCents",
       (select coalesce(sum(pending_cents), 0) from hsa_allocation_status)::text as "hsaPendingCents",
       (select coalesce(sum(received_cents), 0) from hsa_allocation_status)::text as "hsaReceivedCents",
       (select coalesce(sum(available_cents), 0) from hsa_allocation_status)::text as "hsaAvailableCents",
       (select coalesce(sum(needs_review_cents), 0) from hsa_allocation_status)::text as "hsaNeedsReviewCents",
       (select count(*) from documents)::text as "documents",
       (select count(*) from audit_events)::text as "auditEvents"`,
  );
  const s = r.rows[0]!;
  // Open balance is derived, not stored: responsibility (base plus signed adjustments) minus net applied payments.
  s.openBalanceCents = (BigInt(s.baseResponsibilityCents!) + BigInt(s.adjustmentCents!) - BigInt(s.netAppliedCents!)).toString();
  return s;
}
