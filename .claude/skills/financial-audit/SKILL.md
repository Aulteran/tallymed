---
name: financial-audit
description: Audit exact money, posting and HSA invariants in a TallyMed change.
argument-hint: "[PR or commit SHA]"
disable-model-invocation: true
---

Assigned input: $ARGUMENTS

1. Verify the revision and read docs/ledger.md and the related milestone plan in Notion. Trace inputs, transactions, balances, audit rows and exports.
2. Check exact arithmetic, signs, cents, over-allocation, refunds/reversals, idempotency, rollback and concurrent writers. Trace scheduled obligations separately from cash. Verify submitted reserves, partial receipts, and post-reimbursement reductions against the eligible ceiling.
3. Use synthetic reproductions and test real PostgreSQL where relevant. Report each invariant checked, blocking findings with references, exact SHA and unverified cases. Leave code and data unchanged during review.
4. Notion is the source of truth for status, decisions and milestone plans: the [TallyMed project](https://app.notion.com/p/41eab8277cf7812593a2cd3f3038a951) (use the Notion MCP with instructions_version 0.0.6 and confirm the workspace is AI Headquarters). After any repository change, update the Notion TallyMed project to record what changed (PR link, commit, outcome, next action).
