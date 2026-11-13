---
name: implement-milestone
description: Implement an authorized TallyMed milestone and prepare its PR.
argument-hint: "[milestone ID]"
disable-model-invocation: true
---

Assigned input: $ARGUMENTS

1. Read CLAUDE.md, the milestone index, status and decisions. Resolve the assigned milestone and verify accepted predecessors. Use the milestone and linked specs as acceptance criteria.
2. Start from current main in a dedicated branch. Check overlapping assignments. Record scope and baseline checks. Implement the smallest complete milestone slice and relevant tests using synthetic data.
3. Run repository and milestone checks. For marketing, verify root and repository-path export and public roadmap content. For money and private services, apply the stated invariants and boundaries.
4. Push the branch and open a focused PR when requested. Report exact head, changes, acceptance evidence, unrun checks and remaining work. Record handoff. Leave review and merge to their assigned owners.
