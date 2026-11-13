# Development and verification

Use Node.js 24, npm, and Docker Compose v2 for the optional container stack. Install the repository's locked dependencies with `npm ci`. Marketing runs on 3000 and the app shell on 3001 when launched through npm. Build outputs live under each application.

Copy `.env.example` to `.env` (`Copy-Item .env.example .env` in PowerShell, `cp .env.example .env` in POSIX shells), then run:

```sh
docker compose config --quiet
docker compose up --build -d --wait
curl http://127.0.0.1:3001/healthz
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U tallymed -d tallymed -c "SELECT 1;"
docker compose down
```

Stop the npm web dev server before starting Compose. The web port binds to loopback. PostgreSQL is reachable only on the Compose network, with a named volume. The starter uses the sample password only for a disposable development environment. The health endpoint checks the web process. The separate database command checks PostgreSQL. `docker compose down` keeps the named volume.

`npm test` covers marketing configuration, public roadmap content and brand asset consistency. `npm run build` builds both applications. Follow with `npm run test:export` to check the generated home and roadmap. Browser and performance checks run against the static export, so build marketing first. `npm run test:browser` uses Playwright and axe-core to check the home and roadmap pages at phone, tablet and desktop widths in light and dark schemes, with no horizontal overflow, no accessibility violations, keyboard tab order and visible focus, the preview tab controls, reduced motion, canonical and Open Graph metadata, the sitemap and GitHub links. Install the browser once with `npx playwright install chromium`, or set `CHROMIUM_PATH` to an existing Chromium. `npm run test:performance` enforces gzip byte budgets and checks layout shift, first contentful paint and the absence of third-party requests. `npm run generate:og` regenerates `apps/marketing/public/og.png` from the shared mark. To emulate a repository path, set `NEXT_PUBLIC_BASE_PATH=/tallymed`, `SITE_ORIGIN=https://example.github.io`, and `TALLYMED_REPOSITORY=example/tallymed` before building and testing. These variables must match for both commands. Use the same shells and environment for root and subpath checks. Restart Next after changing build-time settings.

Future app tests use disposable PostgreSQL and fabricated data. Test authorization with real sessions and a second actor, data constraints with real transactions, and core UI workflows in a browser. Use current official specifications when introducing new protocol, framework or tax references. For bugs and contributions, open a GitHub issue with a synthetic reproduction and link the relevant plan. Keep credentials, medical details, financial exports and live backups out of issues, pull requests and CI.

For the eventual web deployment, set `TALLYMED_SOURCE_URL` to the corresponding source for the running build. See [security and operations](security.md) for the planned reverse-proxy topology and release criteria.
