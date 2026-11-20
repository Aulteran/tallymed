---
name: implement-milestone
description: Implement an authorized TallyMed milestone and prepare its PR.
argument-hint: "[milestone ID]"
disable-model-invocation: true
---

Assigned input: $ARGUMENTS

1. Read CLAUDE.md and the Notion TallyMed project (milestone plan, status and decisions). Resolve the assigned milestone and verify accepted predecessors. Use the milestone and linked specs as acceptance criteria.
2. Start from current dev (the default branch) in a dedicated, descriptively named branch, and target dev with the PR. Check overlapping assignments. Record scope and baseline checks. Implement the smallest complete milestone slice and relevant tests using synthetic data.
3. Run repository and milestone checks. For marketing, verify root and repository-path export and public roadmap content. For money and private services, apply the stated invariants and boundaries.
4. Push the branch and open a focused PR when requested. Report exact head, changes, acceptance evidence, unrun checks and remaining work. Record the handoff in Notion. Leave review and merge to their assigned owners.
5. Notion is the source of truth for status, decisions and milestone plans: the [TallyMed project](https://app.notion.com/p/41eab8277cf7812593a2cd3f3038a951) (use the Notion MCP with instructions_version 0.0.6 and confirm the workspace is AI Headquarters). After any repository change, update the Notion TallyMed project to record what changed (PR link, commit, outcome, next action).
