# Decision record

## Confirmed direction

- TallyMed tracks one family's medical bills, payments, plans and HSA reimbursements in a self-hosted ledger.
- Next.js and TypeScript, PostgreSQL, Docker Compose, a reverse-proxy-compatible web UI and authenticated local-network MCP only. AI assistance proposes document matches for human approval.
- Marketing first on GitHub Pages, with separate public roadmap, conceptual previews and staged launch messaging. Public roadmap entries use descriptive names.
- Ledger and Medical Cross brand direction, navy and teal, SVG variants and matching app/favicon and GitHub branding.
- GNU AGPL version 3 only.
- Repository-first milestone plans, coordinator plus independent threads, specialist financial/security review, evidence-based completion and reusable Claude skills.

## Starter decisions to validate as work begins

The handoff recovered the marketing and handoff approvals and the brand direction. Earlier app discussions were referenced in the recovered chat but their detailed text and the selected logo image were unavailable. The written app spec makes the current brief concrete. Treat the following as starter decisions and check them with the maintainer when an implementation depends on them.

- The precise app milestone names and numbering after M00, dependency graph and placement of app packages.
- Exact SVG drawing, color values and typography. The assets recreate the ledger and cross direction from its description.
- USD bigint cents, explicit allocation and reservation semantics, transaction locking and the details of the proposed logical schema.
- Administrator bootstrap and provisioned operators, dedicated proxy origin, proposed local transport/auth requirements, private file-volume storage and backup strategy.
- Document formats, ORM/migration library and client-compatible MCP authentication are selected during their milestones. Record decisions and migrations before implementing dependent work.

## Application Foundation decisions (recorded during the milestone)

- **Database access.** `pg` (node-postgres) with parameterized SQL in repositories and plain, numbered SQL migrations run by `apps/web/server/migrate.ts`. No ORM. Migrations are checksummed, applied in transactions under an advisory lock, and tested fresh and as an upgrade from the previous version. Revisit only if a later milestone needs an ORM.
- **Password hashing.** Argon2id via `@node-rs/argon2` defaults.
- **Administrator bootstrap.** A local CLI that reads the password from stdin, closed permanently by `bootstrap_state`. There is no web setup page, so an exposed install cannot be claimed remotely.
- **Provisioning.** Administrators issue single-use invitation links; no email is sent. Roles are `admin` and `operator`.
- **Canonical origin and trusted proxy.** One `TALLYMED_CANONICAL_ORIGIN`, https except loopback. Forwarded headers are trusted only when the request carries `TALLYMED_PROXY_SECRET`, because Next.js route handlers cannot see the TCP peer address. The operator proxy must strip client copies and set the secret. Owner can later replace this with a peer-address allowlist if the server runtime exposes it.
- **Sessions.** Opaque random cookie tokens hashed in PostgreSQL, 12 hour absolute and 2 hour idle lifetimes, `SameSite=Lax`. CSRF uses canonical Origin validation plus a session-bound token. Defaults are configurable by environment variable.
- **Server code in TypeScript run by Node.** Service code uses explicit `.ts` import extensions so the CLI and tests execute it with Node type stripping (`erasableSyntaxOnly`).
