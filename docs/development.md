# Development and verification

Use Node.js 24, npm, and Docker Compose v2 for the optional container stack. Install the repository's locked dependencies with `npm ci`. Marketing runs on 3000 and the app shell on 3001 when launched through npm. Build outputs live under each application.

## Private app database, bootstrap and checks

The private app needs PostgreSQL and these variables: `DATABASE_URL`, `TALLYMED_CANONICAL_ORIGIN` and optionally `TALLYMED_PROXY_SECRET` (see `.env.example`). With the Compose stack running:

```sh
docker compose run --rm web node apps/web/cli/migrate.ts
printf '%s' 'a-long-synthetic-passphrase' | docker compose run --rm -T \
  -e TALLYMED_BOOTSTRAP_EMAIL=admin@example.test -e TALLYMED_BOOTSTRAP_NAME='Alex Example' \
  -e TALLYMED_HOUSEHOLD_NAME='Example Family' web node apps/web/cli/bootstrap.ts
```

Without Compose use `npm run migrate -w @tallymed/web` and `npm run bootstrap -w @tallymed/web` with `DATABASE_URL` set. Bootstrap closes permanently after one success. Real passwords never go in argv, issues or logs.

`npm test` also runs the private-app tests. They need a **disposable** PostgreSQL server: set `TALLYMED_TEST_DATABASE_URL` to a URL whose role can create databases (for example `postgres://postgres:...@127.0.0.1:5432/postgres`). Each test file creates and drops its own database. Without the variable those tests are skipped locally and fail in CI. They cover fresh and upgrade migrations, bootstrap, sessions, CSRF, authorization, request limits and malicious forwarded headers using fabricated data. After `npm run build`, `npm run test:proxy` starts the built app behind a test TLS proxy and checks HTTPS sign-in, canonical redirects, cookie flags, forged headers, body limits, the absence of an MCP route and the network boundary. It needs `openssl` and the same database variable. `npm run test:app-browser` also needs the build: it starts the built app on loopback with a disposable database, signs in and drives the expense screens in Chromium (members, providers, visits, bills, duplicate warning, adjustments, overview queues) with axe checks and a phone-width overflow check. Set `CHROMIUM_PATH` or run `npx playwright install chromium` first.

Document upload needs a private volume: set `TALLYMED_DOCUMENTS_DIR` to an absolute directory outside the web root (Compose mounts the `documents_data` volume at `/var/lib/tallymed/documents`). Without it the app runs and the Documents screens say storage is not configured. `npm run documents -w @tallymed/web -- verify` and `cleanup [--apply]` check and tidy the volume (see [security](security.md#documents-and-proposals)); restore both the database and the volume, then run `verify`. The document tests (`tests/web/documents*.test.mjs`) use a temporary directory per test and fabricated files built in code.

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
