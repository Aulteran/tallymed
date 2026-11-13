---
name: financial-audit
description: Audit exact money, posting and HSA invariants in a TallyMed change.
argument-hint: "[PR or commit SHA]"
disable-model-invocation: true
---

Assigned input: $ARGUMENTS

1. Verify the revision and read docs/ledger.md and the related milestone. Trace inputs, transactions, balances, audit rows and exports.
2. Check exact arithmetic, signs, cents, over-allocation, refunds/reversals, idempotency, rollback and concurrent writers. Trace scheduled obligations separately from cash. Verify submitted reserves, partial receipts, and post-reimbursement reductions against the eligible ceiling.
3. Use synthetic reproductions and test real PostgreSQL where relevant. Report each invariant checked, blocking findings with references, exact SHA and unverified cases. Leave code and data unchanged during review.
