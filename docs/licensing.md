# Licence and source-notice review (M07)

Reviewed on 2026-11-14 at `dev` commit `cf32d45` plus the changes in the pull request that adds this file. Repeat before every stable release and whenever dependencies, base images or bundled assets change.

## Verdict

No blocking licence problem. The AGPL-3.0-only project may ship every dependency found. Two items need attribution or a notice (included) and two are recommendations.

## AGPL-3.0 obligations

| Obligation | Where it is met |
| --- | --- |
| Licence text with every copy | `LICENSE` in the repository; copied into both images at `/app/licenses/` |
| Copyright and no-warranty notice | Every page of the private app shows it (`apps/web/app/components/SourceNotice.tsx`); the public site footer links the licence |
| Network users can get the corresponding source (section 13) | The same footer links `TALLYMED_SOURCE_URL`. Operators must set it to the repository (or their fork) at the commit they run: `deploy/release.env.example` pre-fills it, and the operations guide says so. If it is empty the page says no link is configured, which an operator who changed the code must not leave |
| Source of modified versions | An operator who changes the code must point `TALLYMED_SOURCE_URL` at their own published source. Documented in the operations guide |
| Build instructions | Dockerfiles, Compose files, lockfile and `docs/development.md` are in the repository; images carry OCI labels with the source repository and exact revision |
| Machine-readable licence | `AGPL-3.0-only` in every `package.json` and the image label `org.opencontainers.image.licenses` |

## Dependency licences

`npx license-checker-rseidelsohn` over the full lockfile (179 packages including dev tooling) and over the production trees of the web app and the public site:

| Licence | Notes |
| --- | --- |
| MIT, ISC, BSD-2/3-Clause, 0BSD, Apache-2.0, BlueOak-1.0.0 | Permissive; attribution kept in `THIRD-PARTY-NOTICES.md` and the generated `THIRD-PARTY-LICENSES.txt` |
| MPL-2.0 (`axe-core`, `@axe-core/playwright`, `lightningcss`) | Test tooling and the CSS compiler used at build time. None is part of a runtime image. Unmodified, so no source obligation arises |
| LGPL-3.0-or-later (`@img/sharp-libvips-*`, `@img/sharp-wasm32`) | Shipped inside the Next.js standalone output as an optional image library that TallyMed never calls. Dynamic, replaceable shared libraries. Compatible with AGPL-3.0. Noted in `THIRD-PARTY-NOTICES.md` |
| CC-BY-4.0 (`caniuse-lite`) | Browser data used by build tooling; attribution given in `THIRD-PARTY-NOTICES.md` |
| SIL OFL 1.1 (Montserrat font) | Bundled with its licence file at `packages/brand/fonts/OFL.txt`; no remote font requests |
| UNLICENSED (4) | Only the four private workspace packages of this repository, which declare `AGPL-3.0-only` in their `package.json`; the checker reports private packages that way |

No GPL-only, AGPL-incompatible, source-available or non-commercial licence appears in any tree. Packages whose licence could not be read (platform binaries for other operating systems) are optional and absent from the Linux images.

## Findings fixed in this change

1. **MIT/BSD/Apache notices were missing from the images.** Next.js standalone output and `npm ci` copies strip each package's `LICENSE` file, so the images carried no licence texts. Both Dockerfiles now generate `THIRD-PARTY-LICENSES.txt` (`scripts/generate-third-party-licenses.mjs`, 139 packages for the web app) and copy it, `LICENSE` and `THIRD-PARTY-NOTICES.md` to `/app/licenses/`.
2. **No project-level third-party notice.** Added `THIRD-PARTY-NOTICES.md`.

## Recommendations (not blocking)

- **Drop `sharp` from the web image.** The app does not use `next/image`, so removing `node_modules/@img` from the runtime stage (or turning off image optimisation) would shrink the image and remove the LGPL binaries. It needs a Docker build and a smoke test, so it was not done blind.
- **Base-image sources.** `node:24-bookworm-slim` and `postgres:17-alpine` bring Debian, Alpine and PostgreSQL packages under their own licences (including GPL and LGPL). Sources are available from those distributions; nothing is modified. Digest-pinning the base images (already noted in DECISIONS.md) makes the exact set reproducible.

## Not checked

- Contents of the base images (no Docker daemon in the review environment).
- Licences of transitive dependencies are taken from each package's declared `license` field, not from a legal reading of every file.
- This is an engineering review, not legal advice.
