# Product specification

TallyMed serves one household per self-hosted installation. A family member is the subject of care. A signed-in account is an operator with household access. The household owns its records and can use the ledger without any AI service. The first release targets USD and manual entry. Automatic bank/insurer sync, public registration, multi-tenant hosting, clinical records, automated tax decisions, and claims submission are outside the starter plan.

## Workflows

| Area | Required behavior |
| --- | --- |
| Family and providers | Create/edit family members and providers. Archive records in use, keeping historical links and snapshots. Search and filter by member and provider. |
| Visits | Record member, service date, provider, optional description and notes. Allow multiple bills across providers for the same visit, such as facility, clinician and lab. Preserve visit-to-bill links. Support a bill awaiting a visit assignment. |
| Bills | Track provider reference, statement and due dates, original amount, insurer adjustments and household responsibility with provenance. Keep estimates distinguishable from confirmed amounts. Link bills, documents and payments. Warn on potential duplicate references without merging automatically. |
| Payments | Record actual household payments with date, amount, method/reference, and bill allocations. Record refunds, corrections and credits as explicit history. Distinguish a bill's open balance from cash paid and reimbursable cash. |
| Payment plans | Track total scope, cadence, due dates, installment schedule and historical changes. An installment represents a scheduled amount. Match actual payments to installments and show upcoming, overdue, partial and paid state. |
| HSA | Review potentially eligible out-of-pocket payments, record claim submissions and actual receipts, allocate across payments and reconcile partial, rejected, reversed or duplicate activity. Surface amounts available, pending, reimbursed and requiring review. |
| Documents | Upload and privately access bills, EOBs, receipts and reimbursement evidence. Review unmatched items, link a document to relevant records and retain version/hash and attachment history. |
| Optional AI | A permitted local client can request scoped data and propose document matches. Show evidence and target records for a signed-in human to approve or reject. |
| Reporting | Show bill balances, payments, upcoming installments and HSA status with per-member and date filters and drill-down. Export scoped ledger data for reconciliation with consistent totals and definitions. |

## Interface

Use a desktop sidebar and compact mobile navigation for Overview, Visits, Bills, Payment Plans, HSA, Documents and Settings. Overview shows actionable queues (unmatched documents, overdue installments, available reimbursements), with metrics linked to filtered records. Record screens show amounts, provenance, linked entities, a chronological history and actions. Bills expose separate responsibility, payment, refund and balance figures. HSA screens expose payment-level eligibility, pending claims and receipts separately. Documents provide an unmatched queue and an evidence-focused approval view. Use accessible labels, keyboard focus, semantic tables with mobile alternatives, empty/loading/error states, light/dark themes, and confirmation for irreversible actions. Preserve date and money input on validation errors and explain conflicts from stale records.

A typical flow records a visit, enters two provider bills, attaches statements, schedules one bill, records actual cash payments, uploads receipts, marks confirmed eligibility, submits an HSA claim and reconciles receipts. Each stage can be resumed independently. Financial history and approved changes remain traceable. See [ledger rules](ledger.md) for exact accounting semantics and [.project decisions](../.project/DECISIONS.md) for defaults to validate before implementing.
