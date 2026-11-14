# Marketing website specification

The first milestone delivers a public introduction and a dedicated roadmap. The starter contains the hero, roadmap, visual tokens, reusable Ledger and Medical Cross mark, and Pages build. Design the complete website in the milestone branch.

## Home, in order

1. Hero with the approved “Medical expenses, accounted for.” tagline, development status, short description, GitHub CTA, and feature link.
2. The problem of tracking providers, family expenses, installments and HSA claims.
3. Six feature cards covering visits and bills, payments and installment plans, reimbursement, documents, family overview and private self-hosting.
4. An interactive conceptual preview with Dashboard, Payment Plans and HSA views. Label all preview data fictional and all functionality planned. Make the controls usable by keyboard and screen readers.
5. A four-step flow from visit, to bills, to payments, to HSA reconciliation.
6. Self-hosting and open source, including planned Docker deployment, source and AGPL v3 links.
7. Optional AI and MCP, with a human approval example and a clear description of what an external provider may receive.
8. Development progress with a link to the standalone roadmap.
9. FAQ and footer with source, license, documentation and contributions.

Use the brand palette (navy `#0B2942`, teal `#14B8A6`, mist gray `#E9EEF2`, amber `#F59E0B`) with light and dark themes, and the ledger and cross logo from `packages/brand`, as described in the [design system](design-system.md). Use local assets and optimized static previews. Keep keyboard focus visible, handle reduced motion, check contrast, and verify layouts across phone, tablet and desktop.

## Roadmap and launch

The public content file is `apps/marketing/lib/roadmap.json`. Each item has only a descriptive name, a status and a short description. Keep internal milestone IDs out of display text, URLs, structured metadata, route payloads, client data and source maps. Never import `.project/` into the site. Update public status when a maintainer accepts the underlying work and the required evidence exists. An opened or merged PR by itself does not prove acceptance. For Marketing Website, verify the deployed site first and then publish the completion update.

Support GitHub Pages repository paths and a custom-domain root. Include page metadata, canonical URLs, an Open Graph preview image using the mark, and a sitemap. Build a static site with Next.js, TypeScript and Tailwind. Use no tracking by default. No registration, waitlist, blog or runtime server is needed. Test the root and repository-path exports, and exercise the deployed links and assets. Add automated accessibility and viewport checks plus a reproducible performance check to M00.

Keep copy and components reusable for a stable release. The initial site uses a source CTA, in-development status, planned feature language, conceptual previews and development docs. On release, switch to install guidance, a version, real screenshots and capabilities verified in the release. The stable presentation is planned.
