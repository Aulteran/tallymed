# Coordinator runbook

1. Read the milestone index, latest status and decisions from the repository default branch (`dev`). Use GitHub issues to track assignments. Give each worker the milestone path, approved scope, base branch, file ownership, expected checks and how to report.
2. Start only authorized work whose dependencies are accepted. Start M00 as one implementation thread. Split later work only along independent boundaries. Update status in the work PR or a small coordination PR to avoid multiple workers editing it concurrently.
3. Have the implementation thread push a branch from `dev` and open a PR against `dev`. Require acceptance evidence and exact commit SHA, tests with outcomes, and known gaps. A worker may fix its PR; the owner merges.
4. Start a new, independent thread with the specification, PR and commit SHA. Ask it to fetch the PR head and independently compare it to the base. The review thread returns findings and evidence. Add financial/security threads when required. Review each subsequent head that could affect prior findings and resolve blockers before owner merge.
5. After owner merge, verify required deployment and smoke tests. Record acceptance and update the public copy in a small follow-up PR if verification required the merge. Start the next authorized milestone using committed status. Memory in the Claude project can summarize but cannot replace repository evidence.

When work stops or changes owners, record changed paths, branch, PR, exact SHA, results, blocker, and next command or decision. Report any checks the environment could not run. Do not test against real household systems.

## Branches and releases

`dev` is the default branch and carries all day-to-day work: branch from it, open PRs against it, and CI runs on every PR and on pushes to `dev` and `main`. `main` is the release branch. It changes only when the owner merges `dev` into `main` (a pull request from `dev`, merged with a merge commit or fast-forward so history is not rewritten). A push to `main` runs the Publish images workflow (ghcr.io, `GITHUB_TOKEN` only) and the Marketing Pages deployment. Do not push directly to `main` except for an owner-requested release or an emergency fix that is then merged back into `dev`. Public roadmap status and release copy change on `dev` and reach the site only with the next release merge.
