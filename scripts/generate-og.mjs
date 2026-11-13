// Regenerates apps/marketing/public/og.png (1200x630) from the shared mark. Run: npm run generate:og
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const mark = await readFile(new URL('../packages/brand/app-icon.svg', import.meta.url), 'utf8');
const font = (await readFile(new URL('../packages/brand/fonts/montserrat-latin-variable.woff2', import.meta.url))).toString('base64');
const html = `<style>@font-face{font-family:Montserrat;font-weight:500 800;src:url(data:font/woff2;base64,${font})}</style>
<body style="margin:0;width:1200px;height:630px;background:#0B2942;color:#f3f9fa;font-family:Montserrat,system-ui,sans-serif;display:flex;align-items:center;gap:64px;padding:0 96px;box-sizing:border-box">
<div style="width:280px;height:280px;flex:none">${mark.replace('<svg ', '<svg width="280" height="280" ')}</div>
<div><div style="font-size:56px;font-weight:800;letter-spacing:-.02em">Tally<span style="color:#14B8A6">Med</span></div>
<div style="font-size:68px;font-weight:800;line-height:1.05;letter-spacing:-.04em;margin-top:16px">Medical expenses,<br>accounted for.</div>
<div style="font-size:30px;font-weight:600;color:#5FE0CF;margin-top:28px">Open source · In development</div></div></body>`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(html);
await page.evaluate(() => document.fonts.ready);
await writeFile(new URL('../apps/marketing/public/og.png', import.meta.url), await page.screenshot({ type: 'png' }));
await browser.close();
