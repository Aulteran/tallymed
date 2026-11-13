// Regenerates apps/marketing/public/og.png (1200x630) from the shared mark. Run: npm run generate:og
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const mark = await readFile(new URL('../packages/brand/ledger.svg', import.meta.url), 'utf8');
const html = `<body style="margin:0;width:1200px;height:630px;background:#102432;color:#f3f9fa;font-family:Inter,system-ui,sans-serif;display:flex;align-items:center;gap:64px;padding:0 96px;box-sizing:border-box">
<div style="width:280px;height:280px;flex:none">${mark.replace('<svg ', '<svg width="280" height="280" ')}</div>
<div><div style="font-size:56px;font-weight:750;letter-spacing:-.02em">TallyMed</div>
<div style="font-size:72px;font-weight:720;line-height:1.05;letter-spacing:-.04em;margin-top:16px">Medical expenses,<br>accounted for.</div>
<div style="font-size:30px;color:#88e0cb;margin-top:28px">Open source · In development</div></div></body>`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(html);
await writeFile(new URL('../apps/marketing/public/og.png', import.meta.url), await page.screenshot({ type: 'png' }));
await browser.close();
