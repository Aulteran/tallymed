---
name: review-milestone
description: Independently review a TallyMed milestone PR at an exact commit.
argument-hint: "[milestone ID] [PR URL] [head SHA]"
disable-model-invocation: true
---

Assigned input: $ARGUMENTS

1. Review in a fresh thread. Read the milestone plan in Notion, the specs in docs/ and the PR base. Fetch and verify the exact head. Inspect the diff, surrounding callers and data flow before reading implementation claims.
2. Run the relevant checks and trace each acceptance criterion to code and evidence. Check regressions, error paths, retries and scope. For marketing, inspect generated output and deployment paths for internal IDs and misleading status.
3. Report blocking findings first with severity, file and line, reproduction or evidence, and expected behavior. Include pass/fail/blocked verdict, reviewed SHA and unrun checks. Leave edits to the implementation thread. Recheck affected findings on a changed head.
4. Notion is the source of truth for status, decisions and milestone plans: the [TallyMed project](https://app.notion.com/p/41eab8277cf7812593a2cd3f3038a951) (use the Notion MCP with instructions_version 0.0.6 and confirm the workspace is AI Headquarters). After any repository change, update the Notion TallyMed project to record what changed (PR link, commit, outcome, next action).
