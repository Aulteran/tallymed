# Release drills (owner checklist)

These are the checks M07 needs before a stable release that no cloud thread can run: they need a Docker daemon, published images, a real reverse proxy and your hardware. Run them against the images the release will name, using **fabricated data only**. Record each result in the table at the end and in `.project/STATUS.md`. The commands come from the [operations guide](operations.md); `dc` is the shorthand defined there:

```sh
dc() { docker compose --env-file deploy/.env -f deploy/compose.release.yaml "$@"; }
```

## 0. One-time GitHub settings (repository admin)

- [ ] `dev` is the default branch. `main` is protected: require the CI checks and restrict direct pushes. **A push to `main` publishes the images and deploys the site.**
- [ ] Settings → Environments → `github-pages` still allows deployment from `main`.
- [ ] After the first publish: make the `tallymed-web` and `tallymed-mcp` packages public (Packages → Package settings), otherwise nobody else can pull them.
- [ ] Settings → Security: enable private vulnerability reporting (`SECURITY.md` points to it) and secret scanning with push protection.
- [ ] Optional: pin `actions/checkout` and the base images to digests before the first stable release.

## 1. Pre-flight on the commit you intend to release

```sh
git switch dev && git pull
npm ci && npm run typecheck && npm test && npm run build && npm run test:export
```

Confirm the latest CI run on that exact commit is green, then merge `dev` into `main` by a reviewed pull request. Wait for the **Publish images** run, copy the two `…@sha256:` digests from its summary, and use them below. Never use `latest`.

## 2. Fresh install

On a clean host (or a clean Compose project name) with Docker Compose v2:

```sh
mkdir tallymed-drill && cd tallymed-drill && mkdir deploy
# copy deploy/compose.release.yaml and deploy/release.env.example from the release commit, then:
cp deploy/release.env.example deploy/.env && chmod 600 deploy/.env
# edit deploy/.env: POSTGRES_PASSWORD=$(openssl rand -hex 32), TALLYMED_WEB_IMAGE=<web digest>, TALLYMED_CANONICAL_ORIGIN,
# TALLYMED_PROXY_SECRET=$(openssl rand -base64 36), TALLYMED_SOURCE_URL=https://github.com/<owner>/tallymed
dc up -d --wait db
dc run --rm web node apps/web/cli/migrate.ts
dc up -d --wait
curl --fail http://127.0.0.1:3001/healthz
dc logs web | head -20            # setup banner: the token never appears twice; write down the /setup address
```

- [ ] `healthz` answers; migrations apply with no error.
- [ ] Complete `/setup` (over an SSH tunnel to port 3001 if the proxy is not up yet), then confirm `/setup` returns 404 and remove `TALLYMED_SETUP_TOKEN` from `deploy/.env`.
- [ ] The page footer shows the AGPL notice and the corresponding-source link; the link opens the right repository.
- [ ] `dc exec web ls /app/licenses` lists `LICENSE`, `THIRD-PARTY-NOTICES.md` and `THIRD-PARTY-LICENSES.txt`.
- [ ] `dc ps` shows only the web and database containers, and port 3001 is bound to loopback or a private address only (`ss -ltnp | grep 3001`).

Enter synthetic data in the browser: two family members, a provider, three bills (one with an adjustment), two payments (one split across two bills, one partial), a refund, a payment plan, an HSA claim with a receipt, and one uploaded sample PDF or PNG. Write down the Overview totals and three bills' open balances.

## 3. Reverse proxy and negative tests

Put your real TLS proxy in front (the nginx example in the guide sets the secret header, replaces `X-Forwarded-For`, and clears `Forwarded` and `X-Real-IP`). Then:

- [ ] `https://<origin>/` loads over TLS; the session cookie is `__Host-tallymed_session` with `Secure`, `HttpOnly`, `SameSite=Lax` (browser developer tools).
- [ ] Port 3001 is **not** reachable from another machine on the network, and ports 80 and 443 are the only ones the firewall forwards.
- [ ] Spoofed headers must not be trusted. From a machine that can reach the private port (for example the host itself), a request with a forged forwarded address and no secret must not change who the app thinks you are:

  ```sh
  curl -sS -o /dev/null -w '%{http_code}\n' -H 'X-Forwarded-For: 203.0.113.9' -H 'X-Forwarded-Proto: https' http://127.0.0.1:3001/login
  for i in $(seq 1 25); do curl -sS -o /dev/null -X POST -H 'X-Forwarded-For: 203.0.113.9' --data 'email=nobody@example.test&password=wrong-password-1' http://127.0.0.1:3001/api/auth/login; done
  ```

  Then check `dc logs web` shows these requests as untrusted (no address attributed to `203.0.113.9`). Record what you observed.
- [ ] A state-changing request without the CSRF token or with a foreign `Origin` is refused (`curl -X POST -H 'Origin: https://evil.example' …/api/auth/login` redirects back to `/login?error=csrf_failed`).
- [ ] Failed sign-ins: after 20 wrong passwords from one address, sign-in is blocked for 15 minutes (the documented shared-address behaviour). Confirm and note it.

## 4. Assistant (MCP) negative tests (only if you enable it)

Follow [mcp.md](mcp.md) to create the restricted role, start the `mcp` profile with a self-signed certificate, and create a credential in the app.

- [ ] With the listener disabled (`TALLYMED_MCP_ENABLED=false`, the default) the container exits and nothing listens on 8765.
- [ ] From a machine outside `TALLYMED_MCP_ALLOWED_CIDRS` the connection is refused; with a wrong `Host` or any `X-Forwarded-*` header the request is refused.
- [ ] A missing, wrong, revoked and expired credential gets 401; a credential without `documents:content` cannot call the content tool.
- [ ] A real MCP client (Claude Desktop or another) lists only the scoped tools and can submit a proposal; nothing changes until you approve it in the app; after approval a bill or payment is **not** altered by the assistant.
- [ ] Revoke the credential in the app; the client is refused on its next call.

## 5. Backup, isolated restore, reconciliation

Use the encrypted backup and restore commands in the guide exactly as written, with a throwaway `age` key.

- [ ] `sha256sum --check manifest.sha256` passes on the decrypted set.
- [ ] `drill run --rm web node apps/web/cli/migrate.ts` reports nothing to apply.
- [ ] `drill run --rm web node apps/web/cli/documents.ts verify` exits 0.
- [ ] In the restored instance, the Overview totals and the three bills' open balances equal the figures you wrote down in step 2, the sample document downloads with its recorded checksum, and signing in works.
- [ ] `drill down --volumes`, then delete the decrypted directory and `drill.env`.

The database part of the reconciliation is also automated and runs in CI (`npm run test:restore`). To run it yourself against a **disposable** PostgreSQL (never your real database):

```sh
docker run --rm -d --name tallymed-restore-check -e POSTGRES_PASSWORD=disposable -p 127.0.0.1:55432:5432 postgres:17-alpine
export TALLYMED_TEST_DATABASE_URL=postgres://postgres:disposable@127.0.0.1:55432/postgres
PATH=/usr/lib/postgresql/17/bin:$PATH npm run test:restore     # needs pg_dump and pg_restore 17 on PATH
docker rm -f tallymed-restore-check
```

## 6. Upgrade

Needs two builds. After the release commit exists, make a second commit on `dev` that changes nothing financial (for example a docs edit), merge to `main`, wait for the publish, and note its digest.

- [ ] Backup first (step 5) and keep the figures from step 2.
- [ ] Set `TALLYMED_WEB_IMAGE` to the new digest and follow the Upgrade section of the guide (`dc pull`, `dc stop web`, `migrate`, `dc up -d --wait`, `healthz`, `documents verify`).
- [ ] Sign in; totals unchanged; the rollback instruction (restore the backup) is understood.

## 7. Secret scan before the tag

Already done on the history at the review commit (see `.project/STATUS.md`). Repeat on the release commit:

```sh
git log --all -p | grep -aEi 'AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|github_pat_|sk-ant-|-----BEGIN [A-Z ]*PRIVATE KEY'   # expect nothing
git ls-files | grep -iE '\.env$|\.pem$|\.key$|\.dump$'                                                              # expect nothing
```

For a stronger scan run `gitleaks detect` or `trufflehog git file://.` if you have them.

## 8. Tag and publish the release

Only after every box above is ticked and the table is filled in:

1. Fill in the release record in `CHANGELOG.md`, rename the heading to `0.1.0 — <date>`, merge.
2. `git tag -a v0.1.0 <commit-on-main> -m "TallyMed 0.1.0"` and create a GitHub Release from `CHANGELOG.md`.
3. Update the public site with the version and install call to action, and verified capabilities only (M07 item 3). The site changes when `dev` is next merged into `main`.

## Results record

| Drill | Date | Release digest | Result | Notes |
| --- | --- | --- | --- | --- |
| Fresh install | | | | |
| Reverse proxy and negative tests | | | | |
| Assistant negative tests | | | | |
| Backup, restore, reconciliation | | | | |
| Upgrade | | | | |
| Secret scan | | | | |
