# Security and operations specification

This is the target for the private app. The current shell is a local development surface with no account or data access.

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
