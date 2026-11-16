# Self-hosted operations guide

This guide is for the person who runs TallyMed for one household. It covers published images, a first installation, the reverse proxy, upgrades and rollback, encrypted backups, restore drills and integrity checks. The behavior it relies on is specified in [security and operations](security.md) and [MCP](mcp.md).

**Verification status.** The commands below follow the code in this repository and are checked by the repository's CI where noted. A stable release has not been published yet. The fresh-install, upgrade and isolated-restore drills, and a run behind a real reverse proxy and firewall, are recorded in the release notes for each release only after someone has run them against that release's images. Until a release says so, treat every procedure here as unverified on your hardware and rehearse it with fabricated data first.

## Before you deploy for real

These gaps are known and are not fixed in this release line. Decide whether you accept them.

- **Password recovery is administrator-assisted.** A signed-in person can change their own password (Change password in the user menu, current password required). An administrator can reset another account on the Users page: it creates a temporary password shown once, valid for 4 hours (`TALLYMED_TEMP_PASSWORD_SECONDS`), usable once, that forces a new password at sign-in and signs the account out everywhere. An administrator cannot reset their own password here. **Forgot password by email:** once Settings > Email is saved, the sign-in page's Reset password button asks for an address and, if it belongs to an active account, emails a temporary password (valid for at most one hour, usable once). Until it is used, the person's current password, sessions and sign-in lockout are unchanged, so a stranger typing someone's address cannot lock them out; signing in with the emailed password forces a new one and signs other sessions out, and signing in normally cancels it. Without SMTP the button explains that an administrator must reset the password. Each address can ask five times an hour, each client ten, each account gets one emailed password per ten minutes and three a day, and each server process sends at most 20 reset emails an hour (the request and account counts are stored in the database; only that last budget is per process). An administrator-issued credential is never replaced by an emailed one, and the emailed temporary password is not sent when the SMTP relay is unreachable (the failure is audited, never shown to the requester). If the only administrator forgets their password there is still no in-app recovery: another administrator must reset it, so keep at least two active administrators for real use, keep the administrator password in a password manager and keep encrypted backups.
- **Screen lock, PIN and Keep me signed in.** The sign-in form has a Keep me signed in checkbox (off by default; a session lasts 30 days and ends after 14 idle days, `TALLYMED_REMEMBER_SESSION_ABSOLUTE_SECONDS` and `TALLYMED_REMEMBER_SESSION_IDLE_SECONDS`; leave it unticked on shared computers). People set a six-digit PIN on the first-administrator and invitation forms, or later from User settings (accounts that existed before this version are prompted). With a PIN the screen locks after `TALLYMED_LOCK_IDLE_SECONDS` (default 300; the server's own backstop for a closed browser waits one more minute; simple PINs such as 123456 or 000000 are refused) without activity or when the person chooses Lock now, without signing them out; the lock is enforced by the server, so it also holds when a browser is reopened. Five wrong PINs on one session sign that session out (the password is then needed). A forgotten PIN is changed from User settings after signing in again (the password proves it). An account that exists only through the identity provider has no password: reset it from the Users page so the person can then change the PIN. An administrator's temporary password for someone also clears their PIN (they set a new one). To turn Keep me signed in off, set `TALLYMED_REMEMBER_SESSION_ABSOLUTE_SECONDS=0`; sessions that were already kept keep working until they expire, so revoke them by resetting the person's password if you need them ended now. The PIN blocklist only removes the obvious choices (about 0.2% of PINs): the real limit is five wrong PINs per session. Restores keep PINs (they are hashes in the `users` table) and drop sessions, so everyone signs in again.
- **Shared-address lockout.** Twenty failed sign-ins from one trusted client address block sign-in for everyone behind that address for 15 minutes. A household behind one NAT shares an address, so one person's repeated typos can lock out the others. Anyone who knows an account's email address can lock that account for 15 minutes with failed attempts. Plan for this: the lockout expires on its own and nothing is lost.
- **MCP role setup is a separate step.** The optional assistant listener needs a restricted database role created with `setup-role` before it starts, and again after any upgrade that adds tables, and again after a restore (roles are not part of a database dump). See [MCP](mcp.md).
- **PDF scanning is best-effort.** Uploads are checked by content, but the PDF scan is not a malware scanner. Downloads are attachment-only with `nosniff`, which are the real controls.
- **Upload rate limit.** 30 upload attempts per person per minute, counted per process.
- **Not yet done:** pruning of expired sessions, a global cap on unauthenticated password-hashing work, and scheduled (automatic) backups. Back up with the Backup page or the backup command below, on your own schedule.

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

   Choose how the first administrator is set up. Either put a token of your own in `deploy/.env` as `TALLYMED_SETUP_TOKEN` (32 to 128 printable characters; `openssl rand -base64 32`; weak values such as words, sequences or repeated blocks are rejected and keep setup closed), or leave it empty and read the token the server generated from its console: `dc logs web` shows a banner with the token and the `/setup` address. The banner for a token you defined names the variable and never prints the value. A generated token is held in memory only, is printed once, and changes if the container restarts before setup is finished.
3. Configure the reverse proxy (next section), then open `https://<your origin>/setup`, enter the setup token and create the first administrator (household name, your name, email, a passphrase of 12 to 128 characters). Until then the sign-in page links to `/setup`. Do not open the proxy to the internet before you have completed this step, or complete it over an SSH tunnel to the private port: whoever holds the token first owns the installation. After setup `/setup` returns 404, the token no longer does anything, and you should remove `TALLYMED_SETUP_TOKEN` from `deploy/.env`. Wrong tokens are limited (ten in 15 minutes, five per trusted client address), including for the right token while the limit is spent; the limit is held in memory, so run one web container. Anyone who can reach the page could keep spending the budget and so keep setup locked: restart the web container (`dc restart web`) to reset the count and finish setup straight away, preferably over the private port or a tunnel. A restart also replaces a generated token with a new printed one. A script can complete setup by posting JSON to `/api/setup` with an `Origin` header equal to your canonical origin (without it the request is refused with `csrf_failed`). Then invite other people from the Users page.

## Reverse proxy and supported topology

Supported topology: one dedicated HTTPS origin, one TLS-terminating reverse proxy on the same host (or the same private network) as the web container, and the web container published only on `127.0.0.1` (or a private interface). PostgreSQL has no published port. The MCP listener, if used, is never behind this proxy.

Preferred: list the proxy's address under Server settings > Reverse proxy (see below), or set `TALLYMED_TRUSTED_PROXIES`. Alternatively, or additionally, configure the proxy to delete every client-supplied `X-Forwarded-*`, `Forwarded`, `X-Real-IP` and `X-Tallymed-Proxy-Secret` header, then set `X-Tallymed-Proxy-Secret` to your secret, `X-Forwarded-For` to the address the proxy observed and `X-Forwarded-Proto` to `https`. The app trusts forwarded values only when the secret matches and refuses a request that reports `http` for an `https` origin. Set the body limit above the document limit (default 10 MB per file, configurable up to 25 MB with `TALLYMED_DOCUMENT_MAX_MB`) and timeouts long enough for a slow upload.

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

### Telling the app which proxy to trust (Settings > Reverse proxy)

By default the app trusts no forwarded header at all. An administrator tells it which proxies to believe in the app, under **Server settings > Reverse proxy**: enter the proxy's IP address or CIDR range, one per line (IPv4 or IPv6; ranges shorter than /8 for IPv4 or /32 for IPv6 are refused, and anything wider than /16 or /48, or a public range wider than /24 or /64, needs an explicit confirmation and leaves a warning on the page while it is in force). The app compares the list with the address of the TCP connection itself, which it records for every request and which a client cannot forge (the record is signed with a per-process key; an unsigned or altered value is ignored). A request from a listed address is trusted: its `X-Forwarded-For` and `X-Forwarded-Proto` are used. With a chain of proxies, the client is the right-most `X-Forwarded-For` entry that is not itself a listed proxy.

The page shows, for the request you are making: the connection address, whether it is trusted and how (address list or shared secret), the client address that lockouts will use, the scheme the proxy reported, the Host header and the raw `X-Forwarded-For`. To verify a setup: open the page through the proxy, read the connection address, add it to the list (behind Docker this is often the bridge gateway such as `172.18.0.1`, or the proxy container's address), save, reload through the proxy, and expect "Yes, by address list" and your own address as the client. Open the page directly (not through the proxy) and expect "No".

**Precedence.** A saved list replaces `TALLYMED_TRUSTED_PROXIES` (comma separated, same rules) from the environment, even when the saved list is empty (trust nothing). Tick "Use the value from TALLYMED_TRUSTED_PROXIES" to go back to the environment. The shared-secret method above (`TALLYMED_PROXY_SECRET` and the `X-Tallymed-Proxy-Secret` header) still works and is accepted in addition: a request is trusted if either matches. The proxy must still replace, not append to, client-supplied forwarded headers, and the app's port must never be reachable except through the proxy. Changes are audited (`settings.proxy_updated`, with the old and new lists) and need your password.

**Chains and ports.** Only the nearest hop is matched against the list, then `X-Forwarded-For` is read from the right skipping listed proxies, so list every proxy in a chain; an unlisted CDN edge is reported as the client. A port after an address (`203.0.113.9:443`) is ignored. IPv6 clients are counted per full address.

**What this protects.** Sign-in lockouts count failures per account and, for trusted requests, per real client address. A request that does not come from a trusted proxy contributes no client address: its forwarded headers are ignored, so changing `X-Forwarded-For` cannot reset an address counter or move the blame to another address, and the per-account limit applies regardless. Behind a proxy that is not listed, every visitor appears to come from the proxy, so list it.

## Server settings and email

Administrators open **Server settings** in the sidebar. **General** and **Documents** change the corresponding-source link, session length and inactivity limit, invitation lifetime, and document size, storage and retention limits without a restart; a blank field uses the environment value or built-in default, and each save needs your password and is audited with the old and new values. Values that decide how the server starts or what it trusts stay in the environment and are shown read-only: the public origin, database, proxy secret, secrets key, document volume, listener and TLS, and the MCP listener.

**Email (SMTP)** is optional. Enter the host, port (25, 465, 587, 1025, 2465 or 2525), connection security (STARTTLS, TLS or none), an optional username and password, and the from address. The password is encrypted in the database with a key derived from `TALLYMED_SECRETS_KEY` (`openssl rand -base64 32`; keep it in `deploy/.env` and a copy in your password manager. Do not store it next to the database backups, or the encryption protects nothing. If it is lost or changed you only have to enter the SMTP password again). It is never shown again, never written to the audit log or to logs. Without the key a relay with no login still works; a password cannot be saved. Credentials are never sent unencrypted: "none" is refused when a username is set. **Send test email** sends one message to your own sign-in address and reports the category of any failure (unresolved host, blocked address, connection, timeout, certificate, login, refused); at most three per administrator per five minutes.

The relay host is resolved by the app and the connection goes to the checked address. Loopback, link-local, multicast and unspecified addresses and cloud metadata addresses are refused, and a host with any such address is refused entirely; private LAN addresses are allowed. Tick "Allow loopback and link-local addresses" only if the relay really runs on the same machine; metadata addresses stay blocked regardless. The test and the helper are rate limited (60 emails per hour in total, counted per process).

Other features send mail through one helper, `apps/web/server/email.ts`: `isEmailConfigured(db, config)` and `sendEmail({ db, config }, { to, subject, text }, { purpose, requestId })`, which returns `{ sent: true }` or `{ sent: false, reason, smtpCode? }`, never throws for delivery problems, and never puts the address, body or any secret in its result or logs. Callers record their own audit row.

## Sign-in with an identity provider (OpenID Connect)

Optional. Under **Server settings > Sign-in** an administrator can let people sign in through a provider that supports OpenID Connect: a self-hosted one (Authentik, Keycloak, Authelia), Google, or Microsoft Entra ID. Password sign-in keeps working beside it. GitHub is not offered: it does not provide OpenID Connect sign-in for applications, and a second, separate protocol was left out on purpose.

Setting it up:

1. `TALLYMED_SECRETS_KEY` must be set (the same key that protects the SMTP password). It encrypts the client secret and the short-lived sign-in cookie.
2. At the provider, create an application (a "confidential" or "web" client with the authorization code flow). Register the **redirect address** shown on the Sign-in page exactly as shown. It is `<TALLYMED_CANONICAL_ORIGIN>/api/auth/oidc/callback`, the public https address people use behind your reverse proxy; it is never built from request headers.
3. On the Sign-in page choose the provider type and enter:
   - **OpenID Connect:** the issuer URL, exactly as the provider shows it (the address under which `/.well-known/openid-configuration` is published), for example `https://auth.example.com/application/o/tallymed/` (Authentik) or `https://auth.example.com/realms/home` (Keycloak).
   - **Google:** nothing; the issuer is `https://accounts.google.com`.
   - **Microsoft Entra ID:** the directory (tenant) ID. One directory only. In the app registration add the optional ID-token claims `email` and `xms_edov`; without `xms_edov` Entra ID does not state that an address is verified and nobody can be matched to an account.
   - The client ID and client secret, and the scopes (`openid email profile` by default).
4. Save, then use **Test connection**. It reads the provider's discovery document and signing keys and reports what is wrong if it cannot.
5. Sign out and use the provider button on the sign-in page.

Who can sign in. The first time someone signs in through the provider, TallyMed matches them to the account with the same email address, but only when the provider states that the address is verified. From then on that provider identity is linked to the account (shown under Linked accounts, where a link can be removed). Someone without an account is refused. Optionally, **Create a Standard account** creates one for a verified address in the email domains you list; it is off by default, needs at least one domain, and never creates an administrator. Invite people on the Users page as before; a person invited with a password can use either way.

Turning passwords off. The checkbox is accepted only from an administrator who has already signed in through the saved provider configuration, and not in the same save as a change of issuer, client ID or secret. Passwords come back by themselves when provider sign-in is switched off, when the saved secret can no longer be read, or when no active administrator is linked to the provider any more. If the provider itself is down and nobody can get in, start the web service once with `TALLYMED_PASSWORD_LOGIN=on`, sign in with a password, fix the settings, and remove the variable. Keep at least one administrator password in a password manager for that day. Accounts created at first provider sign-in have a random password nobody knows; an administrator can issue a temporary one from the Users page while passwords are on.

The TallyMed server must be able to reach the provider over https (discovery, keys and the token endpoint). Addresses on your own network are allowed; loopback, link-local and cloud metadata addresses are refused, and redirects are not followed. `TALLYMED_OIDC_ALLOW_INSECURE_ISSUER=true` accepts http and loopback providers and exists only for development against a local test provider. Never set it on a real installation.

## Upgrade

1. Run a backup (the Backup page or one of the procedures below) and confirm it verifies: `backup.ts verify <file>` for an app backup, or decrypt and check the manifest for a dump.
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

## Backup from the app

An administrator can download one file that holds the whole installation and restore it into a new one. This is the simplest way to back up and to move TallyMed to another server. The procedure in [Encrypted backup](#encrypted-backup) further down (database dump plus volume copy) still works and additionally carries your environment file; the two are independent.

**Make a backup.** Open **Server settings > Backup**, optionally type a passphrase twice, confirm your own password and press **Download backup**. The browser saves `tallymed-backup-<UTC time>.tar.gz`, or `.tar.gz.enc` with a passphrase. The app keeps running: the file is made from one consistent database snapshot. The page lists recent backups with the size and SHA-256 of each file as it was downloaded; compare that with `sha256sum` of your copy.

- *What is in it:* every record (household, people, providers, visits, bills and adjustments, payments, refunds, payment plans, HSA decisions, claims and receipts, documents with versions and attachments, assistant proposals, the full audit log), the file of every stored document version, user accounts with their password hashes, the General and Documents settings, and a manifest with the database version, per-table row counts and SHA-256, per-file SHA-256 and the ledger totals.
- *What is never in it:* sign-in sessions, invitation links, temporary passwords and reset counters, sign-in throttle data, the email (SMTP) settings and password, the sign-in provider settings and client secret (the links between accounts and provider identities are kept, and work again once the same provider is entered on the restored server), the reverse proxy list, assistant credentials (the client entries are kept for history, with their token digest replaced by an unusable value), and anything from the environment (`deploy/.env`: database password, secrets key, proxy secret, setup token). Keep a copy of `deploy/.env` and your proxy configuration separately.
- *Passphrase:* with one, the file is encrypted with AES-256-GCM under a key derived from the passphrase by scrypt. It is not stored anywhere; a lost passphrase means a lost backup. Without one the file is a plain compressed archive (`tar -tzf` lists it) that anyone holding it can read, so store it like the records themselves. The file always contains medical and financial information.
- *If the download stops:* an incomplete file has no manifest and is refused by verify and restore. The page records it as "did not finish". A backup also refuses to start a file it cannot vouch for: if a stored document is missing or does not match its checksum, the backup fails and tells you to run `documents verify`.

**Restore into a new installation.** A backup is only restored into an installation that has never been set up; nothing can be restored over existing data.

1. Install the same TallyMed version on the new server as in [First installation](#first-installation), up to and including the migration command. Do not create the first administrator.
2. Open `https://<your origin>/setup`, choose **Restore from a backup**, and enter the setup token, the file and the passphrase if there is one. The upload limit is 4096 MB (`TALLYMED_RESTORE_MAX_MB`); your reverse proxy may have a lower limit of its own (for nginx, `client_max_body_size`). For larger files use the command below.
3. The server verifies every checksum before it writes anything, loads all records in one database transaction, then exports each table again and compares it with the backup, re-checks the ledger rules and totals, and compares every document with its recorded checksum. If anything differs, nothing is restored and the installation stays empty.
4. Sign in with an account from the backup (same email and password as on the old server). Then enter the email and reverse proxy settings again, create new assistant credentials if you use the assistant (and run `setup-role`), and run `documents verify`.

Accounts that were waiting to choose a new password after a reset need a new reset from an administrator. The restore is recorded in the audit log (`backup.restored`), after all the restored history.

**Command line.** The same archive, for scripts, large files and version upgrades:

```sh
dc run --rm -v "$PWD/backups:/backups" web node apps/web/cli/backup.ts create /backups/tallymed-$(date -u +%Y%m%dT%H%M%SZ).tar.gz
dc run --rm -v "$PWD/backups:/backups" web node apps/web/cli/backup.ts verify /backups/<file>
dc run --rm -v "$PWD/backups:/backups" web node apps/web/cli/backup.ts restore /backups/<file>
```

The `backups` directory must be writable by uid 1000 (the image's `node` user). `create` refuses to overwrite a file, reads the finished file back and verifies it before reporting success. `verify` needs no database and exits 1 if the file is not complete and unchanged; it prints counts, checksums and ledger totals, never record content. For an encrypted file put the passphrase in the `TALLYMED_BACKUP_PASSPHRASE` environment variable of that one command (`-e TALLYMED_BACKUP_PASSPHRASE`, with the variable exported in your shell), never on the command line. `restore` needs an empty database: either one with no tables at all or one that was migrated but never set up. If the backup was made by an older TallyMed, `restore` brings an empty database to the backup's own version, loads the backup, and then applies the newer migrations; the web page only accepts a backup of exactly its own database version and tells you to use the command otherwise. A backup from a newer TallyMed than the one installed is refused: upgrade first.

Rehearse a restore with fabricated data, or into an isolated project as in [Restore and drill](#restore-and-drill), before you rely on it. `npm run test` covers the round trip on synthetic data (`tests/web/backup.test.mjs`).

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

The owner's step-by-step checklist for these drills is [release-drills.md](release-drills.md); notes and known limitations per version are in the [changelog](../CHANGELOG.md).

Before a stable tag, the maintainer records in `.project/STATUS.md` and the release notes: the exact commit and image tag, supported upgrade paths, the CI run, the fresh-install, upgrade and isolated-restore drill results, the proxy and MCP negative tests (CI: `npm run test:proxy`, and the MCP suite), the dependency licence and secret-scan review, and the owner's release decision. Public site copy changes only after that evidence exists.

To report a security issue, see [SECURITY.md](../SECURITY.md).
