# TallyMed repository instructions

- Start with [.project/README.md](.project/README.md), [.project/STATUS.md](.project/STATUS.md) and the assigned milestone. Read linked specifications and decisions before editing. Keep work inside the assigned scope.
- Use Node 24 and the npm lockfile. Run `npm ci`, `npm run typecheck`, `npm test`, `npm run build` and `npm run test:export`. Run the relevant integration and deployment checks listed in the milestone. Report unverified checks explicitly.
- Use fabricated household data only. Never connect development threads to real records, backups or live MCP. Preserve auditability, exact money arithmetic and access boundaries.
- Keep public marketing content independent of internal plans. Roadmap entries use descriptive names. Mark previews fictional and describe unreleased capabilities as planned.
- Branching: `dev` is the default branch and the target for all work and PRs. `main` is the release branch: it changes only by a reviewed merge of `dev`, and a push to `main` publishes the container images and deploys the public site. Never open implementation PRs against `main`. See [.project/COORDINATOR.md](.project/COORDINATOR.md).
- Follow [.project/COORDINATOR.md](.project/COORDINATOR.md). Keep PRs focused. The owner merges and confirms acceptance. Preserve review findings and tests by SHA.
- Local Claude Code can invoke repository skills. In Projects cloud threads, open and follow the relevant `.claude/skills/<name>/SKILL.md` directly. Use the assigned task details in place of skill arguments. Read [.project/CLOUD-INSTRUCTIONS.md](.project/CLOUD-INSTRUCTIONS.md) for coordinator instructions.
