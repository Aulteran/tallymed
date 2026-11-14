# Changelog

All notable changes to TallyMed are recorded here. The project follows [Semantic Versioning](https://semver.org); before 1.0 any release may change behaviour, and the release notes name every migration and operator step. Dates are UTC.

## 0.1.0 — first self-hosted release (draft, not yet tagged)

> **Status: prepared, not published.** Nothing below is a stable release until the owner has run the drills in [docs/release-drills.md](docs/release-drills.md), recorded the results in `.project/STATUS.md`, and decided to tag. Fill in the commit, image digests and drill results at the bottom first.

TallyMed is a self-hosted medical expense ledger for one household. Use fabricated data when you first try it.

### What is in it

- **Household and sign-in.** One household, an administrator created through a one-time setup token on first run, invited members, server-side sessions, CSRF protection, a sign-in throttle, an append-only audit log, and a reverse-proxy trust model that refuses spoofed proxy headers.
- **Medical expenses.** Family members and providers, bills with confirmed amounts or estimates, insurer adjustments, idempotent writes, exact integer-cent money arithmetic.
- **Payments and plans.** Payments applied across many bills (and bills paid by many payments), partial and unapplied cash, refunds and voids with reversal links, installment payment plans matched to payments.
- **HSA reimbursements.** Eligibility decisions, claims with reserved amounts, receipts reconciled to allocations, and the eligible ceiling enforced.
- **Documents.** Private document storage on a volume with content checks, versioning, checksums, `documents verify` and `documents cleanup` commands, attachment-only downloads.
- **Optional assistant (off by default).** A separate, LAN-only MCP listener in its own image with scoped, expiring, revocable credentials. It can only create document-match proposals that a person approves in the app; it has no right to change any financial record.
- **Operating it.** Published images on GitHub Container Registry, a release Compose file, an encrypted-backup and isolated-restore procedure, integrity checks and a reverse-proxy guide ([operations guide](docs/operations.md)). Both images carry the AGPL licence and third-party notices.
- **Interface.** The Ledger and Medical Cross brand, light and dark themes, phone-width layout, accessibility checks in CI. Accounts are managed on the Users page (`/users`; the old `/operators` address redirects), and the sidebar's user menu has a User settings dialog (Change password, Change theme, Sign out) with a confirmation before signing out.

### Verified

- CI on every change: typecheck, unit and PostgreSQL-backed tests, production builds, the public-site export, the reverse-proxy checks (`npm run test:proxy`), the browser checks (`npm run test:app-browser`, `npm run test:browser`), and a Compose smoke test with the built images.
- `npm run test:restore`: a synthetic ledger is dumped with `pg_dump`, restored with `pg_restore` into a new database, and every figure the application reports is identical afterwards.
- Licence and source-notice review ([docs/licensing.md](docs/licensing.md)) and a secret scan of the full Git history (no secrets found; test fixtures only).

### Known limitations — read before a real deployment

1. **Password recovery needs an administrator, or SMTP.** An administrator can reset another account, and, once SMTP is configured, people can request an emailed temporary password from the sign-in page (Reset password). If the only administrator forgets their password and email is not configured, another administrator must reset it; keep at least two. Keep it in a password manager and keep encrypted backups.
2. **Shared-address sign-in lockout.** After 20 failed sign-ins from one client address, sign-in is blocked for everyone behind that address for 15 minutes (a household behind one NAT shares an address). Anyone who knows an account email can lock that account for 15 minutes. It clears by itself and nothing is lost.
3. **Assistant database role.** The assistant needs a restricted database role created with `setup-role`, again after upgrades that add tables, and again after a restore. See [docs/mcp.md](docs/mcp.md).
4. **PDF scanning is best effort.** Uploads are checked by content, but this is not a malware scanner. Downloads are attachment-only with `nosniff`, which are the real controls.
5. **Upload rate limit is per process.** 30 attempts per person per minute, counted in each web process; run one web container.
6. **Not done yet:** pruning of expired sessions, a cap on unauthenticated password-hashing work, automated backups, image signatures, provenance or SBOMs, digest-pinned base images, a read-only root filesystem for the web container.
7. **Unverified on real hardware until you run the drills:** TLS with a real certificate, a firewall, a real MCP client, and a screen-reader pass. Migrations only go forward; roll back by restoring a backup.

### Upgrading

First installation: see the [operations guide](docs/operations.md#first-installation). There is nothing to upgrade from.

### Release record (fill in before tagging)

| Item | Value |
| --- | --- |
| Commit on `main` | |
| Image digests (web, assistant) | |
| CI run | |
| Fresh install drill | |
| Upgrade drill | |
| Isolated restore drill | |
| Proxy and MCP negative tests | |
| Owner release decision | |
