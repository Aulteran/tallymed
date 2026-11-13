# Coordinator runbook

1. Read the milestone index, latest status and decisions from the repository default branch. Use GitHub issues to track assignments. Give each worker the milestone path, approved scope, base branch, file ownership, expected checks and how to report.
2. Start only authorized work whose dependencies are accepted. Start M00 as one implementation thread. Split later work only along independent boundaries. Update status in the work PR or a small coordination PR to avoid multiple workers editing it concurrently.
3. Have the implementation thread push a branch and open a PR against main. Require acceptance evidence and exact commit SHA, tests with outcomes, and known gaps. A worker may fix its PR; the owner merges.
4. Start a new, independent thread with the specification, PR and commit SHA. Ask it to fetch the PR head and independently compare it to the base. The review thread returns findings and evidence. Add financial/security threads when required. Review each subsequent head that could affect prior findings and resolve blockers before owner merge.
5. After owner merge, verify required deployment and smoke tests. Record acceptance and update the public copy in a small follow-up PR if verification required the merge. Start the next authorized milestone using committed status. Memory in the Claude project can summarize but cannot replace repository evidence.

When work stops or changes owners, record changed paths, branch, PR, exact SHA, results, blocker, and next command or decision. Report any checks the environment could not run. Do not test against real household systems.
