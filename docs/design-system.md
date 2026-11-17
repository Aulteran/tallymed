# Design system

TallyMed uses one visual language for the private app (`apps/web`) and the public site (`apps/marketing`). It keeps the "Ledger + Cross" logo drawing in the "Ink and Forest" palette (brand refresh of 2026-11-17, which retired the navy and turquoise palette). The decisions are in `.project/DECISIONS.md` under "Interface redesign decisions" and "Brand refresh and minimal dashboard decisions".

## Brand assets

Everything lives in `packages/brand` as vector files. No raster concept art is embedded.

| File | Use |
| --- | --- |
| `mark.svg`, `mark-on-dark.svg` | The receipt with a ledger spine and medical cross, for light and ink (dark) backgrounds |
| `wordmark.svg`, `wordmark-on-dark.svg` | "TallyMed" with "Tally" in ink (white on dark) and "Med" in forest (sprout on dark) |
| `lockup.svg`, `lockup-on-dark.svg` | Horizontal mark plus wordmark |
| `lockup-stacked.svg`, `lockup-stacked-on-dark.svg` | Mark above wordmark, for sign-in and narrow spaces |
| `app-icon.svg`, `app-icon-maskable.svg` | White-outline mark on a forest rounded square, and a full-bleed variant with a safe zone |
| `app-icon-180.png`, `app-icon-192.png`, `app-icon-512.png`, `favicon.ico` | Raster renders of the app icon for touch icons and old browsers |
| `paths.json` | The logo geometry. The SVG files and the inline logo components in both apps draw from it |
| `fonts/montserrat-latin-variable.woff2`, `fonts/OFL.txt` | The bundled display font and its licence |

The wordmark is Montserrat ExtraBold converted to outlines, so it renders the same everywhere and needs no font. Path data has a space after every moveto command so the public-output scan for internal plan IDs never mistakes it for one.

Copies in `apps/web/app` (`icon.svg`, `apple-icon.png`, `favicon.ico`, `fonts/`) and `apps/marketing` (`public/icon.svg`, `public/apple-touch-icon.png`, `public/favicon.ico`, `app/fonts/`) must stay byte-identical to the package. `npm test` checks this, the palette of each SVG and that nothing references another host.

Keep clear space of at least a quarter of the mark's height around a logo. Do not recolour, stretch or add effects. Use the on-dark files on dark backgrounds, never the light ones. Brand SVGs use only ink `#1A1A18`, forest `#1F6B4A`, sprout `#74C69B` and white; `npm test` checks it.

## Colour

"Ink and Forest": warm ink neutrals carry the interface, one forest green is the accent, amber and red appear only for status.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| Ink | `#1A1A18` | | Text, logo outline, strong fills (active view chip) |
| Forest / Sprout (`--accent`) | `#1F6B4A` | `#74C69B` | Primary buttons, links, active navigation icon, chart marks. Text-safe in both themes |
| `--on-accent` | `#FFFFFF` | `#0E1F16` | Text on an accent fill |
| `--bg` | `#F6F5F2` | `#111110` | Page background |
| `--surface` / `--surface-2` | `#FFFFFF` / `#EFEDE8` | `#1A1918` / `#242320` | Cards, inputs, tables / subtle fills |
| `--line` / `--line-strong` | `#E2DFD8` / `#8C877C` | `#33312D` / `#77726A` | Dividers / control borders (3:1 against the surface) |
| `--fg` / `--fg-muted` | `#1A1A18` / `#5C584F` | `#ECEAE5` / `#A8A398` | Text / secondary text |
| `--link`, `--focus` | `#1F6B4A` | `#74C69B` | Links and the focus ring |
| `--accent-soft` + `-fg` | `#E3EFE7` / `#17573B` | `#18301F` / `#93D8B1` | Positive status |
| `--warn-soft` + `-fg`, `--warn-line` | `#FBEFD5` / `#7A4A00`, `#C98512` | `#33270E` / `#F2C063`, `#A8710F` | Warnings, Normal importance |
| `--danger-soft` + `-fg`, `--danger-solid` | `#FBE8E6` / `#A3261B`, `#B42318` | `#3A1714` / `#FFB0A6`, `#B42318` | Errors, Critical importance, destructive buttons |
| `--shell-*` | paper `#FBFAF8`, line `#E2DFD8` | charcoal `#161514`, line `#2E2C29` | Sidebar. No coloured edge; the active item is a soft fill with an accent icon |

Every text pair meets WCAG AA (4.5:1) and every control border 3:1 in both themes; the pairs were computed before the CSS was written, and the browser checks run axe on every screen in both themes. No blue-dominant or turquoise colour is used.

Tokens are CSS custom properties in `apps/web/app/globals.css` and `apps/marketing/app/site.css`, written with `light-dark()` so each has one definition. The theme follows the system. In the app a person can pin light or dark with the theme button; the choice is a display-only cookie (`tallymed_theme`, value `light` or `dark`) that the layout reads to set `data-theme` on `<html>`. The public site has no toggle and sets no cookie.

## Type, space, shape

- Display font: Montserrat (variable, weights 500 to 800), bundled with `next/font/local`, for headings, figures and the wordmark. Body text uses the system font stack. No font is requested from another host.
- Scale: `--text-xs` .75rem, `--text-sm` .875rem, `--text-md` 1rem, `--text-lg` 1.125rem, `--text-xl` 1.375rem, `--text-2xl` 1.75rem. Money uses tabular figures.
- Space: `--space-1` to `--space-7` (.25, .5, .75, 1, 1.5, 2, 3 rem).
- Radius: `--radius-sm` .375rem (controls), `--radius-md` .625rem (cards), `--radius-lg` .875rem, `--radius-pill`.
- Elevation: `--shadow-1` for resting cards, `--shadow-2` for hover.
- Focus: a 3px `--focus` outline with a 2px offset on every interactive element.

## App components

All are plain classes or small server components; pages stay server-rendered forms.

| Component | How |
| --- | --- |
| Shell | `header.shell` is a paper (light) or charcoal (dark) sidebar from 64rem up and a top bar with a Menu button below. `ShellNav` marks the current section with `aria-current`: a soft fill, bold label and accent icon, with no coloured edge |
| Page header | Optional `p.crumb` back link, `h1`, then a `p` of meta text and status pills |
| Card | `.card`; a card with `role="note"` or `role="alert"` becomes an amber or red callout |
| Metric | `.metrics > .card` with a label `span`, a `strong` value and optional `.muted` help. Add `warn` (amber) to a card that needs attention |
| Overview | A compact filter row; three key figures (`.key-figure`: open balance with a share-paid bar, upcoming and overdue installments); Needs attention when anything needs action; then two smaller cards, HSA reimbursements (stacked bar with a text legend carrying every amount) and Other figures. See `app/(app)/page.tsx` |
| Needs attention | `NeedsAttention` renders only when something needs action: one row per item with the item (a link), the reason, and an importance pill whose text is Critical, Normal or Low. Critical: overdue installments, HSA payments needing review. Normal: unmatched documents, bills awaiting a visit, estimates to confirm. Low: possible duplicates (a hint) |
| Button | `button` or `a.button` is primary; add `secondary` for outline. Destructive or corrective actions use secondary |
| Form | `label` then control. `.row` lays filters out in a line. Checkbox labels wrap their input |
| Table | `table.stack` with `data-label` on each cell becomes a card list under 48rem. `.num` right-aligns money |
| Status | `.pill` (positive), `.pill.warn` (attention), `.pill.neutral` (inactive). Always text, never colour alone |
| Messages | `.error` with `role="alert"`, `role="status"` for success, `p[role="note"]` for information |
| Empty state | `<Empty>` from `components/ui.tsx` |
| View chips | `.tabs` for switching between filtered views of a list |
| Icon button | `.icon-button`: a 2rem square with one icon, always with `aria-label` and `title`. Used for the theme toggle, User settings and Sign out (red, `--shell-danger`, in the sidebar) |
| Dialog | Native `<dialog class="modal">` opened with `showModal()`: centred, focus stays inside, Escape closes, focus returns to the opener. `.modal-actions` holds the buttons; the confirming button of a destructive dialog is `button.danger` (`--danger-solid`) |
| Page action | `div.page-head` holds the `h1` and, at the top right, the page's main action: `AddDialog` (a primary button with the plus icon that opens the page's add form in a `dialog.modal.form-modal`) or an `a.button.page-action` link. The page passes `open` when the form came back with an error or the address has `add=1`, and renders the error inside the dialog |
| Required fields | In a `.form-modal`, a label directly before a control with `required` gets a red asterisk (`--danger-fg`) and the dialog starts with a "* required" note. Mark fields with the `required` attribute only, never with colour or text alone |
| Account menu | `AccountMenu` at the foot of the sidebar: avatar and name (no role), then User settings and Sign out icon buttons; below them the theme icon button and Change password. User settings lists Change password, Change theme (`.segmented`) and Sign out. Sign out always asks for confirmation |
| Signed-out pages | `AuthShell` centres a card under the stacked lockup |

## Checks

`npm run test:app-browser` drives the whole app in Chromium with axe on each screen and a phone-width overflow check. Set `TALLYMED_COLOR_SCHEME=dark` to run it in the dark theme (CI runs both) and `TALLYMED_SCREENSHOT_DIR=<folder>` to save a screenshot at each checkpoint. `npm run test:browser` and `npm run test:performance` cover the public site in both themes.
