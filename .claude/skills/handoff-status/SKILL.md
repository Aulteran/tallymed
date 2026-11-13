---
name: handoff-status
description: Summarize TallyMed status, evidence, blockers and eligible work.
argument-hint: "[optional milestone ID]"
disable-model-invocation: true
---

Assigned input: $ARGUMENTS

1. Read .project/STATUS.md, .project/README.md and .project/DECISIONS.md at the default branch. If available, verify linked issues, PR head, checks and deployment evidence.
2. Report what is accepted, in progress, blocked or eligible. Include the next concrete action and owner, pending reviews, any missing evidence and dependencies. Distinguish a branch or open PR from accepted work.
3. Flag stale or conflicting status and propose the exact handoff update. Keep this run read-only unless the user requests a repository update.
