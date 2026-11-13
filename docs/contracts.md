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
| `openBalanceCents` | Responsibility minus net applied payments. Equal to responsibility until M03 supplies payments. |
| `amountStatus` | `estimate` or `confirmed`. Only confirmed amounts are base data for reconciliation. |
| `version` | Row version for stale-write detection. Adjustments also bump it. |

An insurer adjustment or insurer payment changes responsibility and is not household cash.

## Locking and idempotency for money services

A service that moves money against bills must, inside one transaction: claim an idempotency record (`claimIdempotency`, unique per household, actor, operation and key); lock every affected bill with `lockBillsForMoney(db, householdId, ids)` (the exported name; it re-exports the repository's `lockBills`), which locks in ascending ID order; read balances only after locking; then post rows and the audit event. Adjustments, payment allocations and refunds all use that lock, so a balance check and its write cannot interleave. Exact replays return the stored result ID; the same key with different input is a `conflict`.

## Attachments

`resolveAttachmentTarget(db, actor, type, id)` resolves an attachment target inside the actor's household. Allowed types are `bill`, `visit` and `bill_adjustment` (`ATTACHMENT_TARGET_TYPES`). Unknown types are `invalid_input`; missing or foreign IDs are `not_found`. Attachment storage (M05) should reference these IDs with composite foreign keys including `household_id`. Adding a target type is a deliberate change to this file and the constant, with one writer per change.

## Errors

`invalid_input`, `forbidden`, `not_found`, `stale_version`, `conflict`, `duplicate_warning`, `csrf_failed` and `unauthenticated` are stable codes with stable HTTP statuses (see `errors.ts`).

## Audit

Every mutation writes an `audit_events` row in the same transaction. Bill history reads events for `entity_type = 'bill'` with the bill ID and `'bill_adjustment'` events whose `detail.billId` is the bill. Audit detail holds IDs, categories, dates and cents. The only free text it keeps is the previous and new source note of a bill (provenance, at most 500 characters each); notes, reasons and other free text record at most a changed flag.
