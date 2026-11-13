# Self-hosted operations guide

This guide is for the person who runs TallyMed for one household. It covers published images, a first installation, the reverse proxy, upgrades and rollback, encrypted backups, restore drills and integrity checks. The behavior it relies on is specified in [security and operations](security.md) and [MCP](mcp.md).

**Verification status.** The commands below follow the code in this repository and are checked by the repository's CI where noted. A stable release has not been published yet. The fresh-install, upgrade and isolated-restore drills, and a run behind a real reverse proxy and firewall, are recorded in the release notes for each release only after someone has run them against that release's images. Until a release says so, treat every procedure here as unverified on your hardware and rehearse it with fabricated data first.

## Before you deploy for real

These gaps are known and are not fixed in this release line. Decide whether you accept them.

- **No password change or reset.** There is no change-password action and no reset command. Setup closes after the first administrator exists, and re-inviting an existing address is refused. A forgotten administrator password has no supported recovery short of editing the database. Keep the administrator password in a password manager, keep encrypted backups, and do not deploy for real use if that is not acceptable.
- **Shared-address lockout.** Twenty failed sign-ins from one trusted client address block sign-in for everyone behind that address for 15 minutes. A household behind one NAT shares an address, so one person's repeated typos can lock out the others. Anyone who knows an account's email address can lock that account for 15 minutes with failed attempts. Plan for this: the lockout expires on its own and nothing is lost.
- **MCP role setup is a separate step.** The optional assistant listener needs a restricted database role created with `setup-role` before it starts, and again after any upgrade that adds tables, and again after a restore (roles are not part of a database dump). See [MCP](mcp.md).
- **PDF scanning is best-effort.** Uploads are checked by content, but the PDF scan is not a malware scanner. Downloads are attachment-only with `nosniff`, which are the real controls.
- **Upload rate limit.** 30 upload attempts per person per minute, counted per process.
- **Not yet done:** pruning of expired sessions, a global cap on unauthenticated password-hashing work, and automated backups. Back up by the procedure below.

## Images and versions

Pushing to `main` publishes two images to GitHub Container Registry, built from the repository's Dockerfiles:

| Image | Purpose |
| --- | --- |
| `ghcr.io/aulteran/tallymed-web` | Web application and operator commands (`migrate`, `documents`) |
| `ghcr.io/aulteran/tallymed-mcp` | Optional assistant listener (off unless enabled) and its `setup-role` command; the web image does not contain the listener code |

Each push gets the tag `sha-<first 12 characters of the commit>` and moves `latest`. A sha tag is a convenience, not an immutable pin: a manual re-run of the workflow on the same commit pushes the tag again with a different digest. The immutable reference is the digest, which the publish job prints in its run summary (`ghcr.io/<owner>/tallymed-web@sha256:…`); record it in your notes and use it for `TALLYMED_WEB_IMAGE`. Never run `latest`, so you know which build you run and can roll back. Each image carries OCI labels for the source repository and exact revision. `main` is the release branch: it only receives changes that were verified on `dev`. Release notes name the supported commit for each release. The published packages are created private by the registry; the repository owner must make them public in the package settings before anyone else can pull them.

## First installation

You need a Linux host with Docker Engine and Docker Compose v2, a dedicated DNS name, and a TLS-terminating reverse proxy.

1. Copy `deploy/compose.release.yaml` and `deploy/release.env.example` to the host. Rename the second to `deploy/.env` and set the values: a random `POSTGRES_PASSWORD` (`openssl rand -hex 32`; it goes into a database URL, so use hex, not base64), `TALLYMED_WEB_IMAGE` (a `…:sha-<commit>` tag or a `…@sha256:…` digest reference; also `TALLYMED_MCP_IMAGE` if you enable the assistant), the public `https://` `TALLYMED_CANONICAL_ORIGIN`, a random `TALLYMED_PROXY_SECRET` of 32 or more characters, and `TALLYMED_SOURCE_URL` for the commit you run (the AGPL requires offering corresponding source to users of the network service). Keep the file readable by you only (`chmod 600`).
2. Start the database, then migrate, then start everything. Define a shorthand for the commands used below:

   ```sh
   dc() { docker compose --env-file deploy/.env -f deploy/compose.release.yaml "$@"; }
   dc up -d --wait db
   dc run --rm web node apps/web/cli/migrate.ts
   dc up -d --wait
   curl --fail http://127.0.0.1:3001/healthz
   ```

   Choose how the first administrator is set up. Either put a token of your own in `deploy/.env` as `TALLYMED_SETUP_TOKEN` (24 to 128 printable characters; `openssl rand -base64 32`), or leave it empty and read the token the server generated from its console: `dc logs web` shows a banner with the token and the `/setup` address. The banner for a token you defined names the variable and never prints the value. A generated token is held in memory only, is printed once, and changes if the container restarts before setup is finished.
3. Configure the reverse proxy (next section), then open `https://<your origin>/setup`, enter the setup token and create the first administrator (household name, your name, email, a passphrase of 12 to 128 characters). Until then the sign-in page links to `/setup`. Do not open the proxy to the internet before you have completed this step, or complete it over an SSH tunnel to the private port: whoever holds the token first owns the installation. After setup `/setup` returns 404, the token no longer does anything, and you should remove `TALLYMED_SETUP_TOKEN` from `deploy/.env`. Wrong tokens are limited (ten in 15 minutes, five per trusted client address, and a restart resets the count); the limit is held in memory, so run one web container. Then invite other people from the Operators screen.

## Reverse proxy and supported topology

Supported topology: one dedicated HTTPS origin, one TLS-terminating reverse proxy on the same host (or the same private network) as the web container, and the web container published only on `127.0.0.1` (or a private interface). PostgreSQL has no published port. The MCP listener, if used, is never behind this proxy.

Configure the proxy to delete every client-supplied `X-Forwarded-*`, `Forwarded`, `X-Real-IP` and `X-Tallymed-Proxy-Secret` header, then set `X-Tallymed-Proxy-Secret` to your secret, `X-Forwarded-For` to the address the proxy observed and `X-Forwarded-Proto` to `https`. The app trusts forwarded values only when the secret matches and refuses a request that reports `http` for an `https` origin. Set the body limit above the document limit (default 10 MB per file, configurable up to 25 MB with `TALLYMED_DOCUMENT_MAX_MB`) and timeouts long enough for a slow upload.

```nginx
server {
  listen 443 ssl;
  http2 on;
  server_name tallymed.example;
  ssl_certificate     /etc/ssl/tallymed/fullchain.pem;
  ssl_certificate_key /etc/ssl/tallymed/privkey.pem;
  client_max_body_size 30m;
  proxy_read_timeout 120s;
  proxy_send_timeout 120s;
  location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Real-IP "";
    proxy_set_header Forwarded "";
    proxy_set_header X-Tallymed-Proxy-Secret "<your TALLYMED_PROXY_SECRET>";
  }
}
server { listen 80; server_name tallymed.example; return 301 https://$host$request_uri; }
```

Keep the secret out of any file that is world-readable (an `include` file with mode 0600 works). Other proxies work if they can do the same header handling; CI exercises the app behind a test TLS proxy (`npm run test:proxy`), not a specific production proxy product. After any proxy change, verify: sign-in works over HTTPS, an `http://` request redirects, a request with a forged `X-Forwarded-For` does not change the recorded address, a large permitted upload and download succeed, and `https://your-origin/mcp` does not exist.

## Upgrade

1. Run a backup (below) and confirm it decrypts and its manifest verifies.
2. Read the release notes for the target version, including migrations and any operator step.
3. Set `TALLYMED_WEB_IMAGE` (and `TALLYMED_MCP_IMAGE` if used) in `deploy/.env` to the new reference, then:

   ```sh
   dc pull
   dc stop web
   dc run --rm web node apps/web/cli/migrate.ts
   dc up -d --wait
   curl --fail http://127.0.0.1:3001/healthz
   dc run --rm web node apps/web/cli/documents.ts verify
   ```

   If you use the assistant, run `setup-role` after migrating. It lives in the assistant image, so run it there, with the owner database URL, and then restart the listener: `export DATABASE_URL="postgres://tallymed:<owner password from deploy/.env>@db:5432/tallymed"` in your shell (not in shell history or a script), then `printf '%s' "$MCP_DB_PASSWORD" | dc --profile mcp run --rm -T -e DATABASE_URL mcp node apps/web/cli/mcp.ts setup-role`, which passes the variable by name so the password never appears on a command line (the password is 24 to 200 characters; use `openssl rand -hex 32`). CI runs this command in the built image.
4. Sign in, open the Overview and compare its totals with the figures you recorded before the upgrade.

**Rollback limits.** Migrations only go forward; there are no down migrations. Pointing `TALLYMED_WEB_IMAGE` back at an older reference is safe only if the release notes say the schema is compatible, otherwise restore the pre-upgrade backup into a fresh database. Anything entered after the backup is lost by a restore, so upgrade when you can pause entry.

## Encrypted backup

A recovery set has three parts that must stay together: a PostgreSQL dump, the private document volume, and the configuration (`deploy/.env`, which holds secrets, and your proxy configuration). Encrypt the set before it leaves the host and keep the decryption key somewhere else.

Stopping the web service while you copy gives a consistent set, because nothing can write between the database dump and the volume copy. A short outage is the price. Use [age](https://age-encryption.org) (or GnuPG) and keep the private key off the host and apart from the backups. The commands below briefly write the plaintext set to a directory, so run them on an encrypted disk (or a tmpfs) and only as a user who can read `deploy/.env`.

```sh
stamp=$(date -u +%Y%m%dT%H%M%SZ); bundle="tallymed-$stamp"; mkdir -m 700 "$bundle"
dc stop web
dc exec -T db pg_dump -U tallymed -d tallymed --format=custom > "$bundle/db.dump"
docker run --rm -v tallymed_documents_data:/data:ro -v "$PWD/$bundle:/out" alpine tar -C /data -cf /out/documents.tar .
dc start web
cp deploy/.env "$bundle/env"
(cd "$bundle" && sha256sum db.dump documents.tar env > manifest.sha256)
tar -cf - "$bundle" | age --recipient "$AGE_RECIPIENT" > "$bundle.tar.age"
rm -r "$bundle"
```

The volume is named `<project>_documents_data`; with the provided file the project is `tallymed`. Copy `$bundle.tar.age` to a protected destination you do not run the app on. Keep at least one recent backup that you have restored successfully. The backup contains medical and financial information; treat the encrypted file with the same care as the database.

## Restore and drill

Restore into an isolated project with a different name and port so a drill can never touch the running installation. Do it on a separate host or at least a separate Compose project, and use the same procedure for a real recovery by choosing the real project name.

Prepare the drill's environment file first. The restored `env` carries the production origin and secrets; make a copy with a loopback origin and throwaway secrets, so a drill can sign in over `http://127.0.0.1:3101` and never shares a secret with production. The restored database keeps its data, so nothing else in the copy needs to match production, except that `POSTGRES_PASSWORD` is only used when the drill creates its own empty database.

```sh
age --decrypt --identity "$AGE_IDENTITY_FILE" tallymed-<stamp>.tar.age | tar -xf -
(cd tallymed-<stamp> && sha256sum --check manifest.sha256)
umask 077
sed -e 's|^TALLYMED_CANONICAL_ORIGIN=.*|TALLYMED_CANONICAL_ORIGIN=http://127.0.0.1:3101|' \
    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 24)|" \
    -e "s|^TALLYMED_PROXY_SECRET=.*|TALLYMED_PROXY_SECRET=$(openssl rand -base64 36)|" \
    tallymed-<stamp>/env > drill.env
drill() { TALLYMED_WEB_PORT=3101 docker compose -p tallymed-drill --env-file drill.env -f deploy/compose.release.yaml "$@"; }
drill up -d --wait db
drill exec -T db pg_restore -U tallymed -d tallymed --no-owner --exit-on-error < tallymed-<stamp>/db.dump
docker run --rm -v tallymed-drill_documents_data:/data -v "$PWD/tallymed-<stamp>:/in:ro" alpine \
  sh -c 'tar -C /data -xf /in/documents.tar && chown -R 1000:1000 /data && chmod 700 /data'
drill run --rm web node apps/web/cli/migrate.ts
drill run --rm web node apps/web/cli/documents.ts verify
drill up -d --wait web
```

The `node` user in the image is uid 1000; if the volume is not owned by it, `documents verify` reports permission errors, which the first drill should rule out. The first `drill up` creates the drill database with the throwaway password, and `pg_restore` then loads your data into it. Then check the restored instance on `http://127.0.0.1:3101`:

- `migrate` reports the database is up to date, or applies only the migrations that postdate the backup.
- `documents verify` exits 0: every stored version matches its recorded size and SHA-256, and there are no missing files.
- You can sign in, and the Overview totals, a sample of bills, payments and HSA claims match what you recorded from the live system (open balance equals responsibility minus applied payments; the HSA ceiling is the lesser of the decided amount and net cash). Open one document and confirm it downloads with the recorded checksum.
- A person without access to a record still cannot open it, and the session you restore did not carry an old browser's access (sessions expire; sign in again).
- If the restored instance should run the assistant, create the restricted role again with `setup-role` (from the assistant image, as in the upgrade step); it is not in the dump.

Record each drill: date, release tag, backup identifier, who ran it, the results above, and anything that failed. Afterwards remove the drill project with `drill down --volumes`, and delete the decrypted `tallymed-<stamp>` directory and `drill.env` (they hold plaintext data and the production env copy). Never run a drill with real household data on a machine you do not control, and never attach a backup, a log from one, or a screenshot of real records to an issue or pull request.

## Integrity checks to run regularly

- `dc run --rm web node apps/web/cli/documents.ts verify` after every restore and upgrade, and after any storage event. Exit code 1 means a missing or changed file; restore the volume from a backup taken with the database.
- `dc run --rm web node apps/web/cli/documents.ts cleanup` (a dry run) before `cleanup --apply`; it removes only unreferenced objects and purged tombstones.
- `curl --fail http://127.0.0.1:3001/healthz` for the web process and `dc exec -T db psql -U tallymed -d tallymed -c 'SELECT 1;'` for the database. The first does not check the second.
- The audit log is append-only in the database (`audit_events` rejects update, delete and truncate).

## What a release must record

Before a stable tag, the maintainer records in `.project/STATUS.md` and the release notes: the exact commit and image tag, supported upgrade paths, the CI run, the fresh-install, upgrade and isolated-restore drill results, the proxy and MCP negative tests (CI: `npm run test:proxy`, and the MCP suite), the dependency licence and secret-scan review, and the owner's release decision. Public site copy changes only after that evidence exists.

To report a security issue, see [SECURITY.md](../SECURITY.md).
