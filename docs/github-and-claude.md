# Publish and initialize Claude Code Projects

## 1. Publish the starter

Extract the ZIP and open a terminal in the inner `tallymed` directory containing `package.json`. Create a public repository on GitHub, for example `tallymed`. Leave README, license and gitignore initialization unchecked. Use your GitHub owner and repository name in the remote below.

```sh
git init -b main
git add .
git status --short
git commit -m "Initialize TallyMed starter"
git remote add origin https://github.com/YOUR-OWNER/tallymed.git
git push -u origin main
```

Then create the `dev` branch (`git branch dev && git push -u origin dev`) and set it as the default branch under **Settings → Branches**. Day-to-day work branches from and targets `dev`; `main` is the release branch, updated only by merging `dev`.

Authenticate to GitHub if prompted. On GitHub, confirm the root contains `CLAUDE.md`, `.claude/skills/`, `.project/` and `.github/workflows/`. Open Actions and verify CI. For branch rules on `dev` and `main`, require PRs and the `verify` and `compose-smoke` checks after their first run. If you work alone, record the independent Claude review in the PR conversation or PR body. A thread using your GitHub identity may be unable to count as an approving reviewer under GitHub's branch rules.

## 2. Create the cloud project

Anthropic's [Claude Code Projects guide](https://code.claude.com/docs/en/claude-projects) lists Pro, Max and Ultra with Projects available in the Code sidebar. Sign in to [Claude Code](https://claude.ai/code), choose **Projects → New project**, and name it **TallyMed**. You can also use the desktop Code tab. Connect GitHub and install the Claude GitHub App for this specific repository. Your GitHub account needs push access. Add the repository under **Context**, or later in **Project settings → Environment**. The default cloud environment is sufficient if it has Node 24 and access to npm. If necessary, choose an environment that provides Node 24. Use no deployment or household secrets.

Open **Project settings → Memory → Project instructions** and paste the body of [CLOUD-INSTRUCTIONS.md](../.project/CLOUD-INSTRUCTIONS.md). The project conversation is the coordinator and each worker gets a separate thread. Repository `CLAUDE.md` loads in cloud threads. Repository skills are native slash commands for local Claude Code. In cloud Project threads use the checked-in `SKILL.md` by path as task instructions. Anthropic also supports enabling account skills for cloud threads, subject to the environment. The file-based approach needs no extra installation. A separate `/init` is unnecessary because the repository already contains `CLAUDE.md`. See [Claude skills](https://code.claude.com/docs/en/skills) and [project instructions](https://code.claude.com/docs/en/memory).

## 3. Start only the marketing milestone

Send this to the project conversation:

> Start one cloud implementation thread for M00 only. Branch from dev (the default branch). Have it read .project/milestones/M00.md, docs/marketing.md and .claude/skills/implement-milestone/SKILL.md and implement the full marketing milestone. Use synthetic preview data and only descriptive public roadmap names. Run the root and repository-path checks and open a PR with results and the head SHA. Leave the PR for me to merge and report any deployment checks that require main.

Use the worker card or **Overview** to open the thread. If Claude lists it under **Suggested threads**, start that thread from the card. The worker may open the PR or push a branch with a **Create PR** button. Leave later milestones queued until M00 is accepted.

## 4. Independently review, merge and publish

When the PR is ready, send this to the coordinator, replacing the placeholders:

> Start a fresh independent review thread for M00. Review PR <URL> at <HEAD_SHA> against .project/milestones/M00.md and docs/marketing.md. Read and follow .claude/skills/review-milestone/SKILL.md. Check the actual diff and export, including internal-ID leakage, and report blockers with file locations and evidence. Leave fixes to the implementation thread and leave merge to me.

Open **Review PR** from the thread card or use GitHub. Check the diff, exact reviewed SHA, CI and the reviewer’s findings. Send blockers back to the implementation thread and re-review the updated head. Once satisfied, use **Squash and merge** on GitHub into `dev`. Release by merging `dev` into `main` with a merge commit (not a squash), so `dev` and `main` keep a shared history. See [GitHub Pages setup](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).

For the first deployment, set **Settings → Pages → Build and deployment → Source** to **GitHub Actions**. Pushes to `main`, the release branch, build and deploy the site automatically, and **Actions → Marketing Pages → Run workflow** on `main` redeploys manually. For a custom domain, configure it in Pages and verify DNS before rebuilding. Pages configuration supplies the actual origin and base path to the build.

Open the deployed URL from the deployment job. Check the homepage, direct navigation to `/roadmap/` under the published base path, assets, links and preview interactions. If anything fails, fix it through a PR and re-deploy. Once it passes, record the verified deployment and acceptance in `.project/STATUS.md` and update the public Marketing Website status through a follow-up PR. Then direct the coordinator to the next eligible milestone.
