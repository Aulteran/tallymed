# Security and operations specification

This is the target for the private app. The foundation release implements the web and household access, session, CSRF/origin, trusted-proxy and request-validation controls below, with the checks listed in [development](development.md). Document handling, MCP, backups and release items remain planned.

## Implemented foundation controls

- **Bootstrap.** `npm run bootstrap -w @tallymed/web` (password on stdin) creates the household and first administrator once. It is a local command with no web page; a second run fails with `bootstrap_closed`, enforced by an advisory lock and a primary key on `bootstrap_state`.
- **Accounts.** Administrators create one-time invitation links (SHA-256 digest stored, 72 hours, single use) for operators or administrators. Roles map to capabilities in `server/authz.ts`; every service call authorizes and scopes by household. The last active administrator cannot be demoted or disabled.
- **Passwords.** Argon2id (`@node-rs/argon2` defaults), 12 to 128 characters. Unknown accounts take comparable time and return the same generic error.
- **Sessions.** 256-bit random tokens in a `__Host-` `Secure` `HttpOnly` `SameSite=Lax` cookie (plain name without `Secure` only for a loopback `http` origin). Only a SHA-256 digest is stored. Sessions expire after 12 hours absolute or 2 hours idle, are revoked at logout, at role or status changes and when login rotates a presented session. A client can never choose a session identifier.
- **Throttling.** Five failures in 15 minutes lock an account; 20 failures lock a trusted client address. Addresses count only when the trusted proxy supplied them.
- **CSRF.** Every POST requires the canonical `Origin` (or `Referer`) and no cross-site `Sec-Fetch-Site`; authenticated POSTs also need a per-session HMAC token (`x-csrf-token` header or `csrf` form field).
- **Validation.** Bodies are at most 8 KiB, JSON or urlencoded only, parsed with strict schemas that reject unknown or duplicate fields. Errors use stable codes (`invalid_input`, `unauthenticated`, `forbidden`, `csrf_failed`, `not_found`, `stale_version`, `conflict`, `rate_limited`, ...). Logs pass through a redactor and never include bodies, cookies or driver messages.
- **Audit.** Bootstrap, sign-in and sign-out, failed sign-in, invitations and account changes are written in the same transaction as the change. `audit_events` rejects update, delete and truncate.

## Reverse proxy contract

Set `TALLYMED_CANONICAL_ORIGIN` to the public `https://` origin. The app never derives its origin, redirects or cookie attributes from `Host` or `X-Forwarded-Host`. Set `TALLYMED_PROXY_SECRET` (32 or more random characters) and configure the proxy to (1) delete any client-supplied `X-Forwarded-*`, `Forwarded`, `X-Real-IP` and `X-Tallymed-Proxy-Secret` headers, then (2) send `X-Tallymed-Proxy-Secret: <secret>`, `X-Forwarded-For: <client address>` (append only the address the proxy observed) and `X-Forwarded-Proto: https`. The app uses forwarded values only when the secret matches, uses the right-most address and refuses a trusted request that reports `http` for an `https` origin. Publish the upstream only on a private interface or Compose network. Never route an MCP path through this proxy.

Example nginx location (adapt and test; `$remote_addr` is the only address the proxy vouches for):

```nginx
location / {
  proxy_pass http://tallymed-web:3000;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $remote_addr;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Real-IP "";
  proxy_set_header Forwarded "";
  proxy_set_header X-Tallymed-Proxy-Secret "<secret from your secret store>";
}
```

## Web and household access

Bootstrap the first administrator through a one-time local procedure. Close bootstrap after account creation. Use invite/provisioning for additional authorized operators. Define administrative and operator capabilities and validate access at every action, route, lookup, export and download. Hash passwords with a maintained password-hashing library. Use revocable sessions, rotation at login and privilege changes, expiry, logout and login throttling. Use secure, HTTP-only, same-site cookies on HTTPS, and CSRF/origin validation for state changes. Enforce household and actor scope independently of UI controls. Validate inputs and bound body sizes, query sizes and rate limits. Redact financial and medical content, auth headers, cookies and secrets from logs and errors.

## Reverse proxy and service exposure

Deploy the web UI at a dedicated origin such as `https://tallymed.example` behind an operator-managed TLS reverse proxy. Use a configured canonical origin for redirects, secure cookies and origin validation. The proxy sets trusted forwarded headers and strips client-supplied values. App code trusts them only from the configured proxy path. Bind the upstream privately or use a shared private container network. Set upload limits and timeouts for document requests. Keep PostgreSQL and storage private. The public GitHub Pages deployment serves marketing only. The web reverse proxy never forwards to MCP. Validate HTTPS sign-in, redirects, origin checks, large permitted uploads and downloads through the real proxy before release.

## Documents and proposals

Allowlist supported formats and verify content signatures and size. Use opaque storage keys, private permissions, quarantine/validation, authorized streaming and safe download headers. Treat filenames, OCR, documents, provider notes and AI output as untrusted. Never execute embedded content. Recover safely from upload/storage failures using explicit document states, and clean up abandoned objects. Audit sensitive actions with minimal payloads.

## Optional LAN-only MCP

Run MCP as a separate opt-in process on a private interface with a host firewall allowlist. Require both a network restriction and per-client authentication. Use HTTPS within the LAN, validate Origin when applicable, and use scoped, expiring and revocable client credentials. Store no plaintext credentials in the database or logs. Bind localhost for same-host use. Use a maintained MCP SDK and choose client-compatible auth and transport against the current MCP spec during implementation. The service exposes narrowly scoped reads and proposal creation. It has no direct tool to approve proposals, modify posted money, mutate accounts, or bypass browser authorization. Limit returned data and metadata, tool scopes and response size. Record tool calls and outcomes with redaction.

Human approval in the authenticated UI must recheck current document and target versions and authorization. Apply each proposal atomically and once, and record its provenance and rejection/approval. Treat AI instructions in uploaded content as data. Network-local MCP access can still lead a client to send selected data to a cloud provider. Use explicit opt-in and document the client/provider data boundary. Claude development threads use synthetic fixtures and have no connection to a live TallyMed install.

## Backups and release

Back up PostgreSQL, private document objects and the configuration required for recovery to a protected destination. Create a consistent snapshot or quiesce writes. Encrypt the backup, retain an integrity manifest and protect recovery credentials separately. Restore to an isolated instance, verify database schema, document hashes, ledger totals and access controls, then record the exercise. Document upgrade, rollback limits and recovery steps by release. Keep source links current. Verify secret scanning, dependency checks, redaction, proxy boundary and LAN/auth negatives before a stable tag. Report security issues through the maintainer's private GitHub reporting channel once enabled, using synthetic evidence.
