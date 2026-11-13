# Handoff status

| Milestone | State | Next action |
| --- | --- | --- |
| M00 | Accepted | Owner accepted on 2026-11-13. Next milestone starts only when requested. |
| M01 | Accepted | Accepted 2026-11-13 under the owner's preauthorization after both reviews approved and the merge. Evidence below. Next: M02, and M03/M05 may run in parallel after it. |
| M02 | In review | Implemented on `feature/m02-expense-management-members-providers-visits-bills`. PR and tested head SHA are on the PR. Needs independent milestone and financial reviews, green CI, merge and owner acceptance. M03 and M05 start only after acceptance. |
| M03–M07 | Planned | Wait for accepted predecessors per the milestone index. |

Implemented here are the marketing foundation and descriptive public roadmap, shared SVG brand assets, web shell and liveness route, development PostgreSQL/Compose configuration, dependency lockfile, verification tests and GitHub workflows. No milestone has been accepted. The Pages workflow is gated by the repository variable documented in the publishing guide.

For each active or accepted milestone, record the GitHub issue and PR, tested and reviewed SHA, checks and blockers, decisions, remaining work, and the next owner/action. To record acceptance include the merged commit and deployment/release evidence when required. Keep real household records, logs and credentials out of this file.

## M00 handoff

- Branch: `feature/m00-marketing-website-sections-seo-a11y-checks`. PR and reviewed SHA are recorded on the PR.
- Changed: all nine home sections with an accessible fictional preview (Dashboard, Payment Plans, HSA), canonical and Open Graph metadata, `og.png`, sitemap and robots, browser accessibility/viewport checks (`npm run test:browser`), a performance check (`npm run test:performance`) and CI steps for both root and repository-path exports.
- Checks run locally for root and `/tallymed-example` exports: `npm run typecheck`, `npm test`, `npm run build`, `npm run test:export`, `npm run test:browser`, `npm run test:performance`. Local runs used Node 22 because Node 24 was unavailable in the sandbox; CI uses Node 24 from `.node-version`.
- Not verified: the deployed Pages URL (requires merge and the Pages variable), the Docker Compose smoke test, and a real-device or screen-reader pass.
- Public roadmap data is unchanged. Marketing Website stays "In development" until the maintainer accepts it and the deployment is verified.

### M00 acceptance evidence

- PR: Aulteran/tallymed#1, tested head `ecc4f8f068291c2e7eb2dbbff69bd072a53de3d6` (CI verify and compose-smoke green), merged as `fa232f27adc38963e625f60a1bc17ed6c0202c6d`. The independent milestone review step was not run before merge; the owner chose to merge and accept.
- Pages workflow condition removed in `b3f87540ef17480b237156fda457d845c69a0c81`. Marketing Pages run 43384743827 (build and deploy) succeeded.
- Deployed URL https://aulteran.github.io/tallymed/ verified 2026-11-13 in a browser: all nine home sections present, canonical and Open Graph image URLs under `/tallymed`, `/roadmap/`, `/sitemap.xml`, `/robots.txt`, `/og.png` and `/ledger.svg` return 200, GitHub links point at Aulteran/tallymed, and no internal milestone IDs appear in the page.
- Owner acceptance: Aadil, 2026-11-13, in the project thread.
- Not done: screen-reader and real-device pass.

## M01 handoff

- Branch: `feature/m01-app-foundation-auth-sessions-migrations`. The PR and tested/reviewed head SHA are recorded on the PR.
- Changed: PostgreSQL migrations (`apps/web/db/migrations`) and runner; server-only repositories, services, authorization and HTTP pipeline under `apps/web/server`; local bootstrap and migrate CLIs; login, logout, invitation and operator-management routes; authenticated navigation shell and login/invite pages; canonical origin and shared-secret trusted-proxy configuration; source/license notice; Compose, Dockerfile, CI and docs updates. Decisions are in DECISIONS.md.
- Checks run locally (Node 22.23, PostgreSQL 16 disposable instance, openssl): `npm ci`, `npm run typecheck`, `npm test` (30 tests including fresh and upgrade migrations, bootstrap and blocked re-bootstrap, logout/revocation/expiry, CSRF, authorization, malicious forwarded headers), `npm run build`, `npm run test:export`, `npm run test:proxy` (11 checks through a test TLS proxy). CI additionally runs Node 24, PostgreSQL 17, browser and performance checks and the Compose smoke test with migrate, bootstrap and login.
- Not verified locally: Node 24 (unavailable), Docker Compose stack (no Docker daemon), browser checks, a real reverse proxy product (nginx/Caddy/Traefik), a real-browser sign-in pass.
- Review fixes (PR #3): atomic login throttle with concurrent-burst test, bounded failed-login rows and audit, invitation revoke and re-issue, duplicate JSON key rejection, startup warning for https without proxy secret, `type: module`. Remaining limitations are listed in DECISIONS.md under Application Foundation decisions. Reviewers must recheck on the new head.
- Remaining for acceptance: independent milestone and security review, CI green on the final head, owner merge and acceptance. Next milestone: M02 only after acceptance.

### M01 acceptance evidence

- PR: Aulteran/tallymed#3, squash-merged as `69394f57e16c417e09e704a9f37bc1bffaf183cd`. Final reviewed and tested head `872783f12f31af8f468b6131db82eb6e82261cc9`; CI `verify` (Node 24, PostgreSQL 17, browser and performance checks, HTTPS proxy check) and `compose-smoke` (migrate, bootstrap, sign-in) both green on it.
- Independent reviews on `872783f` (comments on the PR): milestone review approved after re-check; security review approved with no blocking findings. First-round findings on `51673aa` (concurrent login-throttle bypass, unbounded failed-login rows, no invitation revoke, duplicate JSON keys) were fixed in a separate thread and re-verified.
- Acceptance was recorded under the owner's 2026-11-13 preauthorization for M01 to M05 (merge on green CI after required reviews). The owner can still revisit it. No public roadmap change: the private app is not publicly deployed, so public roadmap data is unchanged.
- Not verified: manual browser sign-in, a real reverse-proxy product's header stripping, Docker Compose locally (CI covers it).

## M02 handoff

- Branch: `feature/m02-expense-management-members-providers-visits-bills`. The PR and tested head SHA are recorded on the PR.
- Changed: migration `0003_expense_management.sql` (family members, providers, visits, bills, immutable bill adjustments, idempotency records); `server/money.ts`, `pagination.ts`, `contracts.ts`; `repositories/expenses.ts` and `services/expenses.ts`; `/api/expenses/<action>` mutations through the shared pipeline; Overview, Visits, Bills, Family and Providers screens; `scripts/check-app-browser.mjs` and a CI step for it; `docs/contracts.md` (stable ID, balance, locking and attachment contracts); decisions in DECISIONS.md under Medical Expense Management decisions.
- Checks run locally (Node 22.23, PostgreSQL 16 disposable instance): `npm ci`, `npm run typecheck`, `npm test` (49 tests, 15 new in `tests/web/expenses.test.mjs`: multi-provider visits, bills awaiting a visit, archived relationships, adjustments and reversals, duplicate warnings, estimate/confirmed rules, audit trail, cross-household and anonymous access, concurrent adjustments, reversals, idempotent creates and archive races, fixture reconciliation without payments, upgrade over 0002), `npm run build`, `npm run test:export`, `npm run test:proxy` (11 checks), `npm run test:app-browser` (Chromium workflow with axe checks and phone-width overflow).
- Not verified locally: Node 24, Docker Compose, the marketing browser and performance checks (unchanged by this milestone, CI runs them), a real reverse proxy and a real-device or screen-reader pass.
- Owner-visible starter choices (see DECISIONS.md): bill responsibility is base plus signed adjustments and cannot go below zero; estimates versus confirmed amounts; adjustment categories; duplicate hint rule; idempotent create, adjust and reverse; member and visit fixed on a bill; select lists limited to 100 records.
- Observed, not changed: the private app's database pool has no `error` listener, so an idle connection lost during a database restart would raise an unhandled event. Worth a small hardening change with the deployment follow-ups.
- Remaining for acceptance: independent milestone and financial reviews, CI green on the final head, merge and owner acceptance. Next: M03 and M05 only after acceptance.

### Required before the first real deployment

- **Password change and reset.** There is no password change or reset flow. Bootstrap is closed and re-inviting an existing address is blocked, so a forgotten administrator password has no recovery short of database edits. Schedule a local reset CLI (same trust model as bootstrap), an authenticated change-password action that revokes other sessions, and a common-password check before any real deployment.
- **Shared-address lockout.** Twenty failed sign-ins from one trusted client address, for example a household behind one NAT, block sign-in for everyone on that address for 15 minutes, and anyone who knows an account address can lock that account for 15 minutes. Document both in the operator guide and revisit a per-account-plus-address key or delay-based throttle.
- Also deferred: pruning of expired sessions and a global cap on unauthenticated password-hashing work.
