// Renders build/icon.png (exactly 512×512) from build/icon.html.
// Dev-only helper — the PNG is committed, so this only runs when the art changes.
//
//   NODE_PATH=<...>/node_modules node build/make-icon.cjs
//
// Uses the Playwright chromium already present on the machine (its CJS entry
// point, so NODE_PATH resolution applies — Playwright ships no ESM resolver
// hook for NODE_PATH).
const path = require('node:path');
const { chromium } = require('playwright');

const CHROME =
  process.env.CHROME_PATH || '/home/sarthak/.cache/ms-playwright/chromium-1148/chrome-linux/chrome';

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({
    viewport: { width: 512, height: 512 },
    deviceScaleFactor: 1,
  });
  const out = path.join(__dirname, 'icon.png');
  await page.goto('file://' + path.join(__dirname, 'icon.html'));
  await page.screenshot({ path: out });
  await browser.close();
  console.log('wrote', out);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
