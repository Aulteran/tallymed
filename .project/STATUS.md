# Handoff status

| Milestone | State | Next action |
| --- | --- | --- |
| M00 | Accepted | Owner accepted on 2026-11-13. Next milestone starts only when requested. |
| M01 | In review | Independent milestone and security reviews on the PR head, then owner merge and acceptance. |
| M02–M07 | Planned | Wait for accepted predecessors per the milestone index. |

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
