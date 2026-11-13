# Stable contracts for downstream work

These contracts let payments, plans, HSA, documents and the MCP listener build on expense records without reopening them. They are implemented in `apps/web/server/contracts.ts` and `apps/web/server/repositories/expenses.ts` and tested in `tests/web/expenses.test.mjs`.

## Identifiers

Every record ID is a server-generated lower-case UUID that never changes and is never reused. IDs are household-scoped by composite keys: each table has `unique (household_id, id)`, and references use `(household_id, id)` so the database rejects cross-household links. Services must still check the actor's household and answer `not_found` for foreign IDs.

## Bill figures

All amounts are `bigint` cents in storage and decimal strings of integer cents at external interfaces.

| Field | Meaning |
| --- | --- |
| `originalCents` | Amount on the statement. |
| `baseResponsibilityCents` | Household share at entry. Never above `originalCents`. |
| `adjustmentsCents` | Sum of signed, immutable adjustments (reversals included). |
| `responsibilityCents` | `base + adjustments`, recomputed from rows. At least zero. |
| `appliedCents` | Net applied household payments: allocations less allocation reversals and refunds (refund reversals add back). |
| `openBalanceCents` | `responsibilityCents - appliedCents`. Negative means the provider owes a credit. |
| `creditCents` | The part of `appliedCents` above responsibility, or zero. A credit is not a cash refund; a refund is a separate recorded event. |
| `amountStatus` | `estimate` or `confirmed`. Only confirmed amounts are base data for reconciliation. |
| `version` | Row version for stale-write detection. Adjustments also bump it. |

An insurer adjustment or insurer payment changes responsibility and is not household cash.

## Locking and idempotency for money services

A service that moves money against bills must, inside one transaction (lock order is always payments, then bills, then plans, each in ascending ID order): claim an idempotency record (`claimIdempotency`, unique per household, actor, operation and key); lock every affected bill with `lockBillsForMoney(db, householdId, ids)` (the exported name; it re-exports the repository's `lockBills`), which locks in ascending ID order; read balances only after locking; then post rows and the audit event. Adjustments, payment allocations and refunds all use that lock, so a balance check and its write cannot interleave. Exact replays return the stored result ID; the same key with different input is a `conflict`.

## Attachments

`resolveAttachmentTarget(db, actor, type, id)` resolves an attachment target inside the actor's household. Allowed types are `bill`, `visit` and `bill_adjustment` (`ATTACHMENT_TARGET_TYPES`). Unknown types are `invalid_input`; missing or foreign IDs are `not_found`. Attachment storage (M05) should reference these IDs with composite foreign keys including `household_id`. Adding a target type is a deliberate change to this file and the constant, with one writer per change.

## Errors

`invalid_input`, `forbidden`, `not_found`, `stale_version`, `conflict`, `duplicate_warning`, `csrf_failed` and `unauthenticated` are stable codes with stable HTTP statuses (see `errors.ts`).

## Audit

Every mutation writes an `audit_events` row in the same transaction. Bill history reads events for `entity_type = 'bill'` with the bill ID and `'bill_adjustment'` events whose `detail.billId` is the bill. Audit detail holds IDs, categories, dates and cents. The only free text it keeps is the previous and new source note of a bill (provenance, at most 500 characters each); notes, reasons and other free text record at most a changed flag.

## Payments, refunds and plans (M03)

Implemented in `apps/web/server/repositories/payments.ts`, `repositories/plans.ts`, `services/payments.ts`, `services/plans.ts` and migration `0005_payments_and_plans.sql`; tested in `tests/web/payments.test.mjs` and `tests/web/plans.test.mjs`.

### Cash model

- `payments` is the immutable header of one actual payment (`amount_cents > 0`). `payment_entries` is its immutable signed ledger. `allocation` applies cash to a confirmed bill, `allocation_reversal` returns applied cash to the payment's unapplied balance (a correction), `refund` and `unapplied_refund` record cash the provider returned, and `refund_reversal` corrects a refund. A payment recorded in error is voided (`payment_voids`) only when nothing is applied or refunded.
- Per payment: `unapplied = amount - refunded cash - applied`, always at least zero. Per allocation: net cash `= allocated - reversed - refunded` stays between zero and the allocation. Both rules are re-checked at commit by deferred constraint triggers (after taking the payment row lock), so direct SQL and future writers cannot break them. Services also check first under locks.
- A bill's `appliedCents` is the sum of its payment entries. Allocations never exceed a bill's open balance (the service refuses; a credit arises only from a later adjustment or an explicit refund event). Money is `bigint` cents; amounts at interfaces are decimal strings.
- Idempotency operations: `payment.create`, `payment.allocate`, `payment.unapply`, `payment.refund`, `payment.refund_reverse`, `payment.void`, `plan.create`, `plan.revise`, `plan.match`, `plan.unmatch`. Result IDs: the payment, the payment (allocate, void), the reversal entry, or the event (refund).

### Net-payment and refund interface for HSA (M04)

`listNetAllocations` in `contracts.ts` (and the SQL view `allocation_net`) returns one row per allocation: `allocatedCents`, `reversedCents`, `refundedCents` (already net of refund reversals), `netCents` and `matchedCents`. The net cash of an allocation is the ceiling that eligibility and reservations sit under. A refund or reversal after a claim lowers `netCents`; a claim line above its ceiling is the "needs review" case that M04 owns. HSA writers must lock with `lockPaymentsForMoney` (payments, ascending ID) before reading net allocations, then bills if needed, so a ceiling check and its write cannot interleave with a refund. Receipts and reservations should reference `allocation_id` with composite keys `(household_id, payment_id, id, bill_id)` on `payment_entries` and add their own commit-time guards.

### Plans

- A plan covers one or more confirmed bills of one provider. Schedules are immutable revisions (`plan_revisions`, `plan_installments`); each revision's installments add up to its total (checked at commit). The highest revision is current.
- `installment_matches` is a signed, immutable ledger referencing an existing allocation. A match never creates or moves cash. Matches per installment stay between zero and its amount; matches per allocation (current revisions, all plans) never exceed the allocation's net cash. A refund or allocation reversal that shrinks an allocation releases the excess matches in the same transaction (latest due date first).
- A revision carries matches forward onto the new installments in due-date order as new rows marked `carried`; earlier revisions keep their history. The new total cannot be below what is matched.
- Status is derived from posted rows and an `asOf` date: `paid`, `partial` or `unpaid`, plus overdue when the due date is before `asOf` and part is unpaid.
