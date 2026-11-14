# Site screenshots

Real screenshots of the TallyMed web app on fabricated household data (invented names, providers and amounts), 1440 x 900, light and dark.

Regenerate with a disposable PostgreSQL server and a built web app:

```
npm run build -w @tallymed/web
TALLYMED_TEST_DATABASE_URL=postgres://… TALLYMED_SCREENSHOT_DIR=/tmp/shots node scripts/capture-site-screenshots.mjs
```

The script creates and drops its own database and never touches a real deployment. Convert the PNGs to WebP (quality 82, each file should stay under 100 KB) and copy `overview`, `bills`, `plan` and `hsa` in both themes here. `lib/screens.ts` lists them with their alt text.
