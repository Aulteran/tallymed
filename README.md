# TallyMed

Medical expenses, accounted for. TallyMed is a planned self-hosted medical expense ledger for one family, covering bills, provider payments, installment plans, supporting documents and HSA reimbursement.

**Starter status.** This repository runs a static marketing foundation with a descriptive roadmap, a Next.js web shell with a liveness endpoint, and a development PostgreSQL container. The shell stores no records and has no sign-in. The complete marketing milestone, the private ledger, documents, authenticated MCP, and supported deployment and recovery are planned.

## Run locally

Use Node.js 24 and npm. From the extracted repository root:

```sh
npm ci
npm run dev:marketing
```

Open http://localhost:3000. In another terminal, run `npm run dev:web` for the shell on http://localhost:3001. For Compose, see [Development](docs/development.md). For verification, run `npm run typecheck`, `npm test`, `npm run build` and `npm run test:export` in that order.

| Directory | Purpose |
| --- | --- |
| `apps/marketing` | Public static Next.js export |
| `apps/web` | Private application shell |
| `packages/brand` | Ledger and Medical Cross assets |
| `infra` | Container build |
| `docs` | Human guides and specifications |
| `.project` | Milestone plans, decisions, and handoff status |
| `.claude/skills` | Reusable Claude Code workflows |

Start with [Publish and initialize Claude Code Projects](docs/github-and-claude.md). See the [product specification](docs/product.md), [architecture](docs/architecture.md), [ledger rules](docs/ledger.md), [security and operations](docs/security.md), and [milestone index](.project/README.md).

The TallyMed source is distributed under [GNU AGPL version 3 only](LICENSE), SPDX `AGPL-3.0-only`. Third-party packages retain their own licenses.
