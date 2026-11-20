# Changelog

All notable changes to TallyMed are recorded here. The project follows [Semantic Versioning](https://semver.org); before 1.0 any release may change behaviour, and the release notes name every migration and operator step. Dates are UTC.

## Unreleased

- **Brand refresh and a calmer overview.** A new "Ink and Forest" look replaces the navy and turquoise palette in the app, the logo, the icons and the public site (light and dark themes, WCAG AA contrast). The sidebar is a quiet panel without a coloured edge. The overview leads with open balance, upcoming and overdue installments, shows other figures smaller at the side, adds a small HSA breakdown chart, and replaces the always-visible queue cards with a Needs attention list that appears only when something needs action, giving each item a reason and an importance of Critical, Normal or Low. No data, route or calculation changed.
- **HSA: eligible by default.** Every payment allocation is now eligible for HSA reimbursement for its full net cash, so no eligibility decision is needed before a claim or an external reimbursement. Recording a payment has one optional checkbox, "This payment is ineligible for HSA.", which sets the ceiling to zero for that payment (migration 0022, new table `payment_hsa_ineligible`; it cannot be combined with paying directly from an HSA). The decision form is removed from the HSA allocation page; existing decisions, history and evidence stay. Behaviour changes: a pending decision is a note and never changes the ceiling (the newest live non-pending decision decides, else full net cash); the undecided state, filter and queue are gone (`state=undecided` is refused); the allocations CSV `decision` column is blank instead of `unknown` when there is no decision and gains a final `payment_marked_ineligible` column. Releasing a direct HSA funding (administrators) makes the payment claimable for its full net cash, so cash the HSA already paid could be reimbursed twice. Eligibility cannot be changed after a payment is recorded, except by recording a decision through the API.

## 0.1.0 — first self-hosted release (draft, not yet tagged)

> **Status: prepared, not published.** Nothing below is a stable release until the owner has run the drills in [docs/release-drills.md](docs/release-drills.md), recorded the results in the TallyMed project in Notion, and decided to tag. Fill in the commit, image digests and drill results at the bottom first.

TallyMed is a self-hosted medical expense ledger for one household. Use fabricated data when you first try it.

### What is in it

- **Household and sign-in.** One household, an administrator created through a one-time setup token on first run, invited members, server-side sessions, CSRF protection, a sign-in throttle, an append-only audit log, and a reverse-proxy trust model that refuses spoofed proxy headers.
- **Medical expenses.** Family members and providers, bills with confirmed amounts or estimates, insurer adjustments, idempotent writes, exact integer-cent money arithmetic.
- **Payments and plans.** Payments applied across many bills (and bills paid by many payments), partial and unapplied cash, refunds and voids with reversal links, installment payment plans matched to payments. One plan can cover confirmed bills from several providers (migration 0013 removes the plan's single provider; existing plans keep working and still list under their provider).
- **HSA reimbursements.** Eligibility decisions, claims with reserved amounts, receipts reconciled to allocations, and the eligible ceiling enforced.
- **Documents.** Private document storage on a volume with content checks, versioning, checksums, `documents verify` and `documents cleanup` commands, attachment-only downloads.
- **Optional assistant (off by default).** A separate, LAN-only MCP listener in its own image with scoped, expiring, revocable credentials. It can only create document-match proposals and, with a separately granted scope (`plans:propose`, migration 0019), payment plan proposals that a person reviews with a full preview and approves in the app; it has no right to change any financial record.
- **Operating it.** Published images on GitHub Container Registry, a release Compose file, an encrypted-backup and isolated-restore procedure, integrity checks and a reverse-proxy guide ([operations guide](docs/operations.md)). Both images carry the AGPL licence and third-party notices.
- **Sign-in with an identity provider.** Optional OpenID Connect sign-in (a self-hosted provider, Google or Microsoft Entra ID) configured under Server settings > Sign-in, beside password sign-in. People are matched to existing accounts by a provider-verified email address; new accounts are created only if an administrator allows it for listed email domains, always as Standard users. Passwords can be turned off only by an administrator who has signed in through the provider ([operations guide](docs/operations.md)).
- **Backup and restore from the app.** Server settings > Backup downloads one archive with every record, every stored document, the user accounts and a checksum manifest, optionally encrypted with a passphrase. A new installation can be restored from it on the setup page (with the setup token) or with `apps/web/cli/backup.ts`, which also verifies a file. Restore only goes into an empty installation and commits only after the restored tables and ledger totals are identical to the backup. Secrets, sessions, email and proxy settings are never included.
- **Keep me signed in, screen lock and PIN.** An optional Keep me signed in checkbox on the password form (30-day session, 14 idle days) and a six-digit security PIN that locks the screen when you step away, or on request, without signing you out. The lock is held by the server, so it also covers a reopened browser; five wrong PINs sign that session out. The PIN is set on the setup and invitation forms and changed from User settings (migration 0021; new settings `TALLYMED_LOCK_IDLE_SECONDS`, `TALLYMED_REMEMBER_SESSION_ABSOLUTE_SECONDS`, `TALLYMED_REMEMBER_SESSION_IDLE_SECONDS`).
- **Interface.** The Ledger and Medical Cross brand, light and dark themes, phone-width layout, accessibility checks in CI. Accounts are managed on the Users page (`/users`; the old `/operators` address redirects), and the sidebar's user menu has a User settings dialog (Change password, Lock now, Change PIN, Change theme, Sign out) with a confirmation before signing out. List pages open their add form from a button at the top right (for example Add provider) in a centred dialog, with required fields marked by a red asterisk.

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
6. **Not done yet:** pruning of expired sessions, a cap on unauthenticated password-hashing work, scheduled (unattended) backups, image signatures, provenance or SBOMs, digest-pinned base images, a read-only root filesystem for the web container.
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
