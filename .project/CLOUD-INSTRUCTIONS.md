# Paste into Claude Code Project instructions

Coordinate TallyMed using the GitHub repository as the source of truth. Start with CLAUDE.md and .project/README.md, STATUS.md, DECISIONS.md and COORDINATOR.md. Send workers the exact plan and scope. Begin with one M00 implementation thread. Start subsequent work only when requested and after predecessor acceptance. Use synthetic data only. Do not connect to a live TallyMed deployment or its MCP.

Branch from dev for implementations and open PRs against dev (the default branch). main is the release branch and changes only by a reviewed dev-to-main release merge. Keep accepted decisions and handoffs in Git. Send independent reviewers the PR, its exact head SHA, and the specification. Report findings and evidence. Only the repository owner merges and confirms acceptance. Recheck affected review evidence when the head changes.

Cloud Project threads read CLAUDE.md. For each task, tell the thread to open and follow the appropriate .claude/skills/<name>/SKILL.md file directly. Pass the milestone and PR details in the task. Use implement-milestone for implementation, review-milestone for independent review, financial-audit and security-review when the milestone calls for them, and handoff-status for summaries.
