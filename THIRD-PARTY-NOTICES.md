# Third-party notices

TallyMed's own source is licensed under the GNU Affero General Public License, version 3 only (`AGPL-3.0-only`, see [LICENSE](LICENSE)). It includes and is built with the third-party software below, each under its own licence. This file lists the packages that are installed into the production builds of the private web app, the optional assistant image and the public site. Test and build tooling that never ships (Playwright, axe-core, TypeScript, Tailwind CSS and similar) is not listed; the full dependency tree with licences is reviewed in [docs/licensing.md](docs/licensing.md).

Each npm package keeps its own licence text and copyright notice in its package directory (`node_modules/<name>/`), and the Docker images carry them with the packages. The list was generated from `package-lock.json` at the release commit with `npx license-checker-rseidelsohn`; regenerate it whenever dependencies change.

## Components that need a closer look

- **Sharp and libvips (LGPL-3.0-or-later).** The Next.js standalone output includes the optional image library `sharp` and its prebuilt `libvips` binaries. TallyMed does not use the Next.js image optimiser, so the library is never called. The libvips binaries are dynamically loaded shared libraries and are replaceable. Source: <https://github.com/lovell/sharp-libvips>. LGPL-3.0 is compatible with the AGPL-3.0.
- **caniuse-lite (CC-BY-4.0).** Browser-support data by Alexis Deveria and contributors, <https://github.com/browserslist/caniuse-lite>, used by the build tooling and carried in the dependency tree. Attribution is given here as the licence requires.
- **Montserrat typeface (SIL Open Font License 1.1).** Bundled in `packages/brand/fonts/` and copied into `apps/web/app/fonts/` and `apps/marketing/app/fonts/` so that no page loads a font from another host. Copyright 2011 The Montserrat Project Authors (<https://github.com/JulietaUla/Montserrat>). The licence text is in [packages/brand/fonts/OFL.txt](packages/brand/fonts/OFL.txt). The font is not sold on its own and keeps its original name.
- **Container base images.** The images are built `FROM node:24-bookworm-slim` (Debian GNU/Linux 12 with the Node.js runtime, MIT licence, plus Debian's own packages under their own licences, including GPL and LGPL components). The database image in the Compose files is `postgres:17-alpine` (PostgreSQL licence on Alpine Linux). TallyMed does not modify any of them; their licences and sources are those of Debian, Node.js, PostgreSQL and Alpine.
- **Brand artwork.** The TallyMed mark, wordmark and icons in `packages/brand` are original work of the project's contributors, covered by the repository licence. No stock photography or third-party icon sets are used.

## npm packages in the production builds

| Package | Licence | Used by |
| --- | --- | --- |
| @emnapi/runtime@1.11.3 | MIT | web app and public site |
| @hono/node-server@2.1.8 | MIT | web app (also in the assistant image) |
| @img/colour@1.1.0 | MIT | web app and public site |
| @img/sharp-libvips-linux-x64@1.3.4 | LGPL-3.0-or-later | web app and public site |
| @img/sharp-libvips-linuxmusl-x64@1.3.4 | LGPL-3.0-or-later | web app and public site |
| @img/sharp-linux-x64@0.35.5 | Apache-2.0 | web app and public site |
| @img/sharp-linuxmusl-x64@0.35.5 | Apache-2.0 | web app and public site |
| @img/sharp-wasm32@0.35.5 | Apache-2.0 AND LGPL-3.0-or-later AND MIT | web app and public site |
| @modelcontextprotocol/sdk@1.32.2 | MIT | web app (also in the assistant image) |
| @next/env@16.4.6 | MIT | web app and public site |
| @next/swc-linux-x64-gnu@16.4.6 | MIT | web app and public site |
| @next/swc-linux-x64-musl@16.4.6 | MIT | web app and public site |
| @node-rs/argon2-linux-x64-gnu@2.2.2 | MIT | web app (also in the assistant image) |
| @node-rs/argon2-linux-x64-musl@2.2.2 | MIT | web app (also in the assistant image) |
| @node-rs/argon2@2.2.2 | MIT | web app (also in the assistant image) |
| @swc/helpers@0.5.23 | Apache-2.0 | web app and public site |
| accepts@2.0.0 | MIT | web app (also in the assistant image) |
| ajv-formats@3.0.1 | MIT | web app (also in the assistant image) |
| ajv@8.20.0 | MIT | web app (also in the assistant image) |
| baseline-browser-mapping@2.11.37 | Apache-2.0 | web app and public site |
| body-parser@2.4.0 | MIT | web app (also in the assistant image) |
| bytes@3.1.2 | MIT | web app (also in the assistant image) |
| call-bind-apply-helpers@1.0.2 | MIT | web app (also in the assistant image) |
| call-bound@1.0.4 | MIT | web app (also in the assistant image) |
| caniuse-lite@1.0.30001826 | CC-BY-4.0 | web app and public site |
| client-only@0.0.1 | MIT | web app and public site |
| content-disposition@2.0.1 | MIT | web app (also in the assistant image) |
| content-type@1.0.5 | MIT | web app (also in the assistant image) |
| content-type@2.1.0 | MIT | web app (also in the assistant image) |
| cookie-signature@1.2.2 | MIT | web app (also in the assistant image) |
| cookie@0.7.2 | MIT | web app (also in the assistant image) |
| cors@2.8.6 | MIT | web app (also in the assistant image) |
| cross-spawn@7.0.6 | MIT | web app (also in the assistant image) |
| debug@4.4.3 | MIT | web app (also in the assistant image) |
| depd@2.0.0 | MIT | web app (also in the assistant image) |
| detect-libc@2.1.2 | Apache-2.0 | web app and public site |
| dunder-proto@1.0.1 | MIT | web app (also in the assistant image) |
| ee-first@1.1.1 | MIT | web app (also in the assistant image) |
| encodeurl@2.0.3 | MIT | web app (also in the assistant image) |
| es-define-property@1.0.1 | MIT | web app (also in the assistant image) |
| es-errors@1.3.0 | MIT | web app (also in the assistant image) |
| es-object-atoms@1.1.2 | MIT | web app (also in the assistant image) |
| escape-html@1.0.3 | MIT | web app (also in the assistant image) |
| etag@1.8.1 | MIT | web app (also in the assistant image) |
| eventsource-parser@3.1.1 | MIT | web app (also in the assistant image) |
| eventsource@3.0.7 | MIT | web app (also in the assistant image) |
| express-rate-limit@8.7.4 | MIT | web app (also in the assistant image) |
| express@5.3.0 | MIT | web app (also in the assistant image) |
| fast-deep-equal@3.1.3 | MIT | web app (also in the assistant image) |
| fast-uri@3.1.9 | BSD-3-Clause | web app (also in the assistant image) |
| finalhandler@2.1.1 | MIT | web app (also in the assistant image) |
| forwarded@0.2.0 | MIT | web app (also in the assistant image) |
| fresh@2.0.0 | MIT | web app (also in the assistant image) |
| function-bind@1.1.2 | MIT | web app (also in the assistant image) |
| get-intrinsic@1.3.0 | MIT | web app (also in the assistant image) |
| get-proto@1.0.1 | MIT | web app (also in the assistant image) |
| gopd@1.2.0 | MIT | web app (also in the assistant image) |
| has-symbols@1.1.0 | MIT | web app (also in the assistant image) |
| hasown@2.0.4 | MIT | web app (also in the assistant image) |
| hono@4.13.18 | MIT | web app (also in the assistant image) |
| http-errors@2.0.1 | MIT | web app (also in the assistant image) |
| iconv-lite@0.7.3 | MIT | web app (also in the assistant image) |
| inherits@2.0.4 | ISC | web app (also in the assistant image) |
| ip-address@10.7.6 | MIT | web app (also in the assistant image) |
| ipaddr.js@1.9.1 | MIT | web app (also in the assistant image) |
| is-promise@4.0.0 | MIT | web app (also in the assistant image) |
| isexe@2.0.0 | ISC | web app (also in the assistant image) |
| jose@6.2.17 | MIT | web app (also in the assistant image) |
| json-schema-traverse@1.0.0 | MIT | web app (also in the assistant image) |
| json-schema-typed@8.0.2 | BSD-2-Clause | web app (also in the assistant image) |
| math-intrinsics@1.1.0 | MIT | web app (also in the assistant image) |
| media-typer@1.1.1 | MIT | web app (also in the assistant image) |
| merge-descriptors@2.0.0 | MIT | web app (also in the assistant image) |
| mime-db@1.54.0 | MIT | web app (also in the assistant image) |
| mime-types@3.0.2 | MIT | web app (also in the assistant image) |
| ms@2.1.3 | MIT | web app (also in the assistant image) |
| nanoid@3.3.20 | MIT | web app and public site |
| negotiator@1.1.0 | MIT | web app (also in the assistant image) |
| next@16.4.6 | MIT | web app and public site |
| object-assign@4.1.1 | MIT | web app (also in the assistant image) |
| object-inspect@1.13.4 | MIT | web app (also in the assistant image) |
| on-finished@2.4.2 | MIT | web app (also in the assistant image) |
| once@1.4.0 | ISC | web app (also in the assistant image) |
| parseurl@1.3.3 | MIT | web app (also in the assistant image) |
| path-key@3.1.1 | MIT | web app (also in the assistant image) |
| path-to-regexp@8.4.2 | MIT | web app (also in the assistant image) |
| pg-cloudflare@1.4.1 | MIT | web app (also in the assistant image) |
| pg-connection-string@2.14.1 | MIT | web app (also in the assistant image) |
| pg-int8@1.0.1 | ISC | web app (also in the assistant image) |
| pg-pool@3.14.0 | MIT | web app (also in the assistant image) |
| pg-protocol@1.16.1 | MIT | web app (also in the assistant image) |
| pg-types@2.2.0 | MIT | web app (also in the assistant image) |
| pg@8.23.1 | MIT | web app (also in the assistant image) |
| pgpass@1.0.5 | MIT | web app (also in the assistant image) |
| picocolors@1.1.1 | ISC | web app and public site |
| pkce-challenge@5.0.1 | MIT | web app (also in the assistant image) |
| postcss@8.5.23 | MIT | web app and public site |
| postgres-array@2.0.0 | MIT | web app (also in the assistant image) |
| postgres-bytea@1.0.1 | MIT | web app (also in the assistant image) |
| postgres-date@1.0.7 | MIT | web app (also in the assistant image) |
| postgres-interval@1.2.0 | MIT | web app (also in the assistant image) |
| proxy-addr@2.0.8 | MIT | web app (also in the assistant image) |
| qs@6.17.1 | BSD-3-Clause | web app (also in the assistant image) |
| range-parser@1.3.0 | MIT | web app (also in the assistant image) |
| raw-body@3.0.2 | MIT | web app (also in the assistant image) |
| react-dom@19.3.1 | MIT | web app and public site |
| react@19.3.1 | MIT | web app and public site |
| require-from-string@2.0.2 | MIT | web app (also in the assistant image) |
| router@2.2.0 | MIT | web app (also in the assistant image) |
| safer-buffer@2.1.2 | MIT | web app (also in the assistant image) |
| scheduler@0.28.0 | MIT | web app and public site |
| semver@7.8.6 | ISC | web app and public site |
| send@1.2.1 | MIT | web app (also in the assistant image) |
| serve-static@2.2.1 | MIT | web app (also in the assistant image) |
| setprototypeof@1.2.0 | ISC | web app (also in the assistant image) |
| sharp@0.35.5 | Apache-2.0 | web app and public site |
| shebang-command@2.0.0 | MIT | web app (also in the assistant image) |
| shebang-regex@3.0.0 | MIT | web app (also in the assistant image) |
| side-channel-list@1.0.1 | MIT | web app (also in the assistant image) |
| side-channel-map@1.0.1 | MIT | web app (also in the assistant image) |
| side-channel-weakmap@1.0.2 | MIT | web app (also in the assistant image) |
| side-channel@1.1.1 | MIT | web app (also in the assistant image) |
| source-map-js@1.2.2 | BSD-3-Clause | web app and public site |
| split2@4.2.0 | ISC | web app (also in the assistant image) |
| statuses@2.0.2 | MIT | web app (also in the assistant image) |
| styled-jsx@5.1.6 | MIT | web app and public site |
| toidentifier@1.0.1 | MIT | web app (also in the assistant image) |
| tslib@2.9.1 | 0BSD | web app and public site |
| type-is@2.1.0 | MIT | web app (also in the assistant image) |
| unpipe@1.0.0 | MIT | web app (also in the assistant image) |
| vary@1.1.2 | MIT | web app (also in the assistant image) |
| which@2.0.2 | ISC | web app (also in the assistant image) |
| wrappy@1.0.2 | ISC | web app (also in the assistant image) |
| xtend@4.0.2 | MIT | web app (also in the assistant image) |
| zod-to-json-schema@3.25.2 | ISC | web app (also in the assistant image) |
| zod@4.6.7 | MIT | web app (also in the assistant image) |
