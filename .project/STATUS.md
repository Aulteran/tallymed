# Handoff status

| Milestone | State | Next action |
| --- | --- | --- |
| M00 | Implemented on branch `feature/m00-marketing-website-sections-seo-a11y-checks`, awaiting independent review | Open PR against main, run independent milestone review on the exact head SHA, then owner merge. After merge, verify the deployed Pages URL, record evidence and publish the completion update. |
| M01–M07 | Planned | Wait for accepted predecessors per the milestone index. |

Implemented here are the marketing foundation and descriptive public roadmap, shared SVG brand assets, web shell and liveness route, development PostgreSQL/Compose configuration, dependency lockfile, verification tests and GitHub workflows. No milestone has been accepted. The Pages workflow is gated by the repository variable documented in the publishing guide.

For each active or accepted milestone, record the GitHub issue and PR, tested and reviewed SHA, checks and blockers, decisions, remaining work, and the next owner/action. To record acceptance include the merged commit and deployment/release evidence when required. Keep real household records, logs and credentials out of this file.

## M00 handoff

- Branch: `feature/m00-marketing-website-sections-seo-a11y-checks`. PR and reviewed SHA are recorded on the PR.
- Changed: all nine home sections with an accessible fictional preview (Dashboard, Payment Plans, HSA), canonical and Open Graph metadata, `og.png`, sitemap and robots, browser accessibility/viewport checks (`npm run test:browser`), a performance check (`npm run test:performance`) and CI steps for both root and repository-path exports.
- Checks run locally for root and `/tallymed-example` exports: `npm run typecheck`, `npm test`, `npm run build`, `npm run test:export`, `npm run test:browser`, `npm run test:performance`. Local runs used Node 22 because Node 24 was unavailable in the sandbox; CI uses Node 24 from `.node-version`.
- Not verified: the deployed Pages URL (requires merge and the Pages variable), the Docker Compose smoke test, and a real-device or screen-reader pass.
- Public roadmap data is unchanged. Marketing Website stays "In development" until the maintainer accepts it and the deployment is verified.
