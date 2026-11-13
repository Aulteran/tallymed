# Ledger and reimbursement rules

TallyMed records household expenses and reconciliation. Use integer USD cents stored as PostgreSQL bigint and manipulated with bigint or an exact representation. Transmit cents as decimal strings. Format at the display boundary. Reject fractional cents, negative inputs to positive-only operations, overflow and invalid dates. Record actor, event time, effective date, reason and related evidence for every consequential transition.

## Bill and cash accounting

- Base household responsibility comes from confirmed bill data. Record changes as signed adjustments with categories and provenance. An insurer adjustment changes responsibility and creates no household cash payment.
- Bill balance equals responsibility minus net applied household payments. Net payments equal payment allocations less linked refunds and reversals. Preserve a negative balance as a provider credit. Surface unapplied cash separately.
- Plan amounts and scheduled installments are obligations. A plan match references an actual payment allocation and creates no new cash event or additional bill payment. Late status is based on due date and unpaid amount. Schedule revisions preserve prior matched history.
- Keep original events immutable after posting. Corrections use linked reversals and replacements with a reason. Distinguish a billing credit from a cash refund. Never infer either from a lower statement total.

## HSA reconciliation

Use the confirmed eligible portion of net paid cash per allocation as the ceiling. Eligibility is a user decision with rationale and evidence. Pending and unknown decisions contribute zero to available totals. Track external evidence and any household-configured HSA eligibility context. A date, category, or AI suggestion alone cannot certify eligibility.

A submitted claim reserves amounts. A claim line can move through submitted, partially fulfilled, fulfilled, rejected, or canceled, with history. Actual HSA receipts reconcile to specific allocations and reduce their remaining reservation; received cash does not reduce the provider balance. Support receipt splits and partial payments. Keep total received and live reservations within the eligible ceiling for new claims. For externally initiated reimbursements, require explicit source and evidence and apply the same reconciliation rules. Compute:

- **Pending** = open reserved cents remaining after linked receipts and releases.
- **Received** = allocated reimbursement receipts less linked receipt reversals.
- **Available** = maximum of zero and eligible cents minus pending and received.
- **Needs review** = excess pending or received amounts after a refund, reversal or eligibility reduction. Freeze new claims for the affected allocation and expose the mismatch until the operator resolves it. Preserve real historical cash and its audit trail.

Example: a $120 bill has a $75 applied payment with $60 confirmed eligible. A $50 claim followed by a $20 receipt leaves a $45 provider balance, $30 pending, $20 reimbursed, and $10 available. A later refund changes the bill balance and may reduce eligibility. Record the refund, recompute eligibility from the remaining covered cash, and surface any resulting excess for review.

## Transactions and verification

Use a stable idempotency key per actor, operation and logical request. Exact replays return the original result. The same key with different input produces a conflict. For writes involving multiple allocations, lock all affected rows in a deterministic order or retry serializable conflicts. Apply validation, balance changes, and audit writes atomically. Recompute totals from posted events, with any cache rebuilt or invalidated transactionally. Use a transactionally consistent read for multi-table exports.

Cover cent arithmetic, combined allocations, duplicate submissions, simultaneous writers, stale approvals, negative balances, refunds before and after claims, partial receipts, rejected/canceled releases, reversal links, rollback after an injected error, data from earlier migrations and export reconciliation. Prove one logical request produces one financial effect under retries. Financial review traces representative entries from input to persistence, UI and export.
