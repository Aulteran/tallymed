# Ledger and reimbursement rules

TallyMed records household expenses and reconciliation. Use integer USD cents stored as PostgreSQL bigint and manipulated with bigint or an exact representation. Transmit cents as decimal strings. Format at the display boundary. Reject fractional cents, negative inputs to positive-only operations, overflow and invalid dates. Record actor, event time, effective date, reason and related evidence for every consequential transition.

## Bill and cash accounting

- Base household responsibility comes from confirmed bill data. Record changes as signed adjustments with categories and provenance. An insurer adjustment changes responsibility and creates no household cash payment.
- Bill balance equals responsibility minus net applied household payments. Net payments equal payment allocations less linked refunds and reversals. Preserve a negative balance as a provider credit. Surface unapplied cash separately.
- Plan amounts and scheduled installments are obligations. A plan match references an actual payment allocation and creates no new cash event or additional bill payment. Late status is based on due date and unpaid amount. Schedule revisions preserve prior matched history. A plan may cover bills from several providers; matching, refunds releasing matches and the one-allocation-one-plan rule work over the plan's bills whatever their provider, and nothing about cash or balances depends on the plan's provider mix.
- Keep original events immutable after posting. Corrections use linked reversals and replacements with a reason. Distinguish a billing credit from a cash refund. Never infer either from a lower statement total.

## HSA reconciliation

Every payment allocation is eligible for its full net paid cash by default, and that is the ceiling. The only way to exclude it is the "This payment is ineligible for HSA." checkbox when the payment is recorded: a marked payment has a ceiling of zero. Ceiling = 0 for a marked payment, a payment paid directly from an HSA, or one whose latest eligibility decision is ineligible; least(decision eligible amount, net cash) for an eligible decision; net cash for a pending decision or no decision. Decisions recorded earlier keep their effect and evidence but none is required, and a decision cannot lift the marker. Decisions are read live: a decision an administrator deleted (with undo, migration 0020) does not count, so the allocation falls back to the next live decision or to the default, and undoing the delete restores the decision's ceiling; one function, `hsa_allocation_ceiling`, gives that figure to the entry guard and both removal guards, and the view states the same rule. A delete never lowers the ceiling, so it is never refused for that reason; its undo is refused when pending plus received cash is above the restored ceiling. The marker is not a decision and has no delete. Track external evidence and any household-configured HSA eligibility context. A date, category, or AI suggestion alone cannot certify eligibility.

A submitted claim reserves amounts. A claim line can move through submitted, partially fulfilled, fulfilled, rejected, or canceled, with history. Actual HSA receipts reconcile to specific allocations and reduce their remaining reservation; received cash does not reduce the provider balance. Support receipt splits and partial payments. Keep total received and live reservations within the eligible ceiling for new claims. For externally initiated reimbursements, require explicit source and evidence and apply the same reconciliation rules. Compute:

- **Pending** = open reserved cents remaining after linked receipts and releases.
- **Received** = allocated reimbursement receipts less linked receipt reversals.
- **Available** = maximum of zero and eligible cents minus pending and received.
- **Needs review** = excess pending or received amounts after a refund, reversal or eligibility reduction (an ineligible decision). Freeze new claims for the affected allocation and expose the mismatch until the operator resolves it. Preserve real historical cash and its audit trail.

A payment made with an HSA card linked to an HSA account is paid directly from that HSA at the point of service. It is settled: it has nothing available to claim, takes no reimbursement (a ceiling of zero), and is shown beside the claim figures as paid directly from the HSA. A refund still lowers its net cash. A card without an account link is only a label and its payments stay claimable.

HSA accounts live on the HSA page, not a page of their own. Adding an account offers "This account also has a spending card": ticking it saves the card as an HSA/FSA payment method (so it appears on Payment methods at once) and links it to the new account in the same step. A second card, or a card added earlier, is linked from its payment method page.

Example: a $120 bill has a $75 applied payment with $60 eligible by an earlier eligible decision (with no decision the whole $75 would be eligible). A $50 claim followed by a $20 receipt leaves a $45 provider balance, $30 pending, $20 reimbursed, and $10 available. A later refund changes the bill balance and may reduce eligibility. Record the refund, recompute eligibility from the remaining covered cash, and surface any resulting excess for review.

## Transactions and verification

Use a stable idempotency key per actor, operation and logical request. Exact replays return the original result. The same key with different input produces a conflict. For writes involving multiple allocations, lock all affected rows in a deterministic order or retry serializable conflicts. Apply validation, balance changes, and audit writes atomically. Recompute totals from posted events, with any cache rebuilt or invalidated transactionally. Use a transactionally consistent read for multi-table exports.

Cover cent arithmetic, combined allocations, duplicate submissions, simultaneous writers, stale approvals, negative balances, refunds before and after claims, partial receipts, rejected/canceled releases, reversal links, rollback after an injected error, data from earlier migrations and export reconciliation. Prove one logical request produces one financial effect under retries. Financial review traces representative entries from input to persistence, UI and export.
