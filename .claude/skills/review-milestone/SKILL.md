---
name: review-milestone
description: Independently review a TallyMed milestone PR at an exact commit.
argument-hint: "[milestone ID] [PR URL] [head SHA]"
disable-model-invocation: true
---

Assigned input: $ARGUMENTS

1. Review in a fresh thread. Read the milestone, specs and PR base. Fetch and verify the exact head. Inspect the diff, surrounding callers and data flow before reading implementation claims.
2. Run the relevant checks and trace each acceptance criterion to code and evidence. Check regressions, error paths, retries and scope. For marketing, inspect generated output and deployment paths for internal IDs and misleading status.
3. Report blocking findings first with severity, file and line, reproduction or evidence, and expected behavior. Include pass/fail/blocked verdict, reviewed SHA and unrun checks. Leave edits to the implementation thread. Recheck affected findings on a changed head.
