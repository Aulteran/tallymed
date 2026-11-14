# Design system

TallyMed uses one visual language for the private app (`apps/web`) and the public site (`apps/marketing`). It follows the owner's "Ledger + Cross" brand concept. The decisions behind it are recorded in `.project/DECISIONS.md` under "Interface redesign decisions".

## Brand assets

Everything lives in `packages/brand` as vector files. No raster concept art is embedded.

| File | Use |
| --- | --- |
| `mark.svg`, `mark-on-dark.svg` | The receipt with a ledger spine and medical cross, for light and navy backgrounds |
| `wordmark.svg`, `wordmark-on-dark.svg` | "TallyMed" with "Tally" in navy (white on dark) and "Med" in teal |
| `lockup.svg`, `lockup-on-dark.svg` | Horizontal mark plus wordmark |
| `lockup-stacked.svg`, `lockup-stacked-on-dark.svg` | Mark above wordmark, for sign-in and narrow spaces |
| `app-icon.svg`, `app-icon-maskable.svg` | White-outline mark on a navy rounded square, and a full-bleed variant with a safe zone |
| `app-icon-180.png`, `app-icon-192.png`, `app-icon-512.png`, `favicon.ico` | Raster renders of the app icon for touch icons and old browsers |
| `paths.json` | The logo geometry. The SVG files and the inline logo components in both apps draw from it |
| `fonts/montserrat-latin-variable.woff2`, `fonts/OFL.txt` | The bundled display font and its licence |

The wordmark is Montserrat ExtraBold converted to outlines, so it renders the same everywhere and needs no font. Path data has a space after every moveto command so the public-output scan for internal plan IDs never mistakes it for one.

Copies in `apps/web/app` (`icon.svg`, `apple-icon.png`, `favicon.ico`, `fonts/`) and `apps/marketing` (`public/icon.svg`, `public/apple-touch-icon.png`, `public/favicon.ico`, `app/fonts/`) must stay byte-identical to the package. `npm test` checks this, the palette of each SVG and that nothing references another host.

Keep clear space of at least a quarter of the mark's height around a logo. Do not recolour, stretch or add effects. Use the on-dark files on navy, never the light ones.

## Colour

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| Navy | `#0B2942` | `#0B2942` | Text, sidebar, hero, dark surfaces |
| Teal | `#14B8A6` | `#14B8A6` | Primary buttons (navy text), active navigation, accents |
| Mist gray | `#E9EEF2` | `#113550` | Subtle fills such as table headers |
| Amber | `#F59E0B` | `#F59E0B` | Warnings and things that need attention |
| `--bg` | `#F4F7F9` | `#061725` | Page background |
| `--surface` | `#FFFFFF` | `#0B2942` | Cards, inputs, tables |
| `--line` / `--line-strong` | `#D5DEE5` / `#7B8FA1` | `#1F4663` / `#6585A0` | Dividers / control borders (3:1 against the surface) |
| `--fg` / `--fg-muted` | `#0B2942` / `#496073` | `#E9EEF2` / `#A8BDCC` | Text / secondary text |
| `--link`, `--focus` | `#0A6B62` | `#5FE0CF` | Links and the focus ring |
| `--accent-soft` + `-fg` | `#D7F4EF` / `#07564F` | `#0D3F45` / `#7CEBDC` | Positive status |
| `--warn-soft` + `-fg` | `#FEF0CD` / `#7A4300` | `#3D2C07` / `#FBC656` | Warning status |
| `--danger-soft` + `-fg` | `#FDE8E6` / `#A61B12` | `#401816` / `#FFB1A8` | Errors |

Brand teal on white is only about 2.5:1, so it is never used for text or thin borders on light surfaces. Text-sized teal uses `--link`. Teal fills carry navy text (about 5.9:1). Text pairs meet WCAG AA, and the browser checks run axe on every screen in both themes.

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
| Shell | `header.shell` is a navy sidebar from 64rem up and a top bar with a Menu button below. `ShellNav` marks the current section with `aria-current` |
| Page header | Optional `p.crumb` back link, `h1`, then a `p` of meta text and status pills |
| Card | `.card`; a card with `role="note"` or `role="alert"` becomes an amber or red callout |
| Metric | `.metrics > .card` with a label `span`, a `strong` value and optional `.muted` help. Add `accent` (teal) or `warn` (amber) to the card |
| Button | `button` or `a.button` is primary; add `secondary` for outline. Destructive or corrective actions use secondary |
| Form | `label` then control. `.row` lays filters out in a line. Checkbox labels wrap their input |
| Table | `table.stack` with `data-label` on each cell becomes a card list under 48rem. `.num` right-aligns money |
| Status | `.pill` (positive), `.pill.warn` (attention), `.pill.neutral` (inactive). Always text, never colour alone |
| Messages | `.error` with `role="alert"`, `role="status"` for success, `p[role="note"]` for information |
| Empty state | `<Empty>` from `components/ui.tsx` |
| View chips | `.tabs` for switching between filtered views of a list |
| Icon button | `.icon-button`: a 2rem square with one icon, always with `aria-label` and `title`. Used for the theme toggle, User settings and Sign out (red, `--shell-danger`, in the sidebar) |
| Dialog | Native `<dialog class="modal">` opened with `showModal()`: centred, focus stays inside, Escape closes, focus returns to the opener. `.modal-actions` holds the buttons; the confirming button of a destructive dialog is `button.danger` (`--danger-solid`) |
| Account menu | `AccountMenu` at the foot of the sidebar: avatar and name (no role), then User settings and Sign out icon buttons; below them the theme icon button and Change password. User settings lists Change password, Change theme (`.segmented`) and Sign out. Sign out always asks for confirmation |
| Signed-out pages | `AuthShell` centres a card under the stacked lockup |

## Checks

`npm run test:app-browser` drives the whole app in Chromium with axe on each screen and a phone-width overflow check. Set `TALLYMED_COLOR_SCHEME=dark` to run it in the dark theme (CI runs both) and `TALLYMED_SCREENSHOT_DIR=<folder>` to save a screenshot at each checkpoint. `npm run test:browser` and `npm run test:performance` cover the public site in both themes.
