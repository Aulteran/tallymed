---
name: handoff-status
description: Summarize TallyMed status, evidence, blockers and eligible work.
argument-hint: "[optional milestone ID]"
disable-model-invocation: true
---

Assigned input: $ARGUMENTS

1. Read the Notion TallyMed project (project page, Milestones, Tasks, Decisions and the handoff document in Documents). If available, verify linked issues, PR head, checks and deployment evidence.
2. Report what is accepted, in progress, blocked or eligible. Include the next concrete action and owner, pending reviews, any missing evidence and dependencies. Distinguish a branch or open PR from accepted work.
3. Flag stale or conflicting status and propose the exact handoff update in Notion. Keep this run read-only unless the user requests an update.
4. Notion is the source of truth for status, decisions and milestone plans: the [TallyMed project](https://app.notion.com/p/41eab8277cf7812593a2cd3f3038a951) (use the Notion MCP with instructions_version 0.0.6 and confirm the workspace is AI Headquarters). After any repository change, update the Notion TallyMed project to record what changed (PR link, commit, outcome, next action).
