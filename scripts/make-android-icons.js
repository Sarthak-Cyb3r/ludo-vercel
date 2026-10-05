// Generates Android launcher icons (adaptive foreground + legacy square/round)
// for Ludo with Friends by rendering HTML at exact sizes with Playwright.
// Brand: royal indigo #2a1a6e, gold #ffd166 ring, die motif — matches icons/.
// Usage: node scripts/make-android-icons.js   (writes into android/app/src/main/res/)
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const RES = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res');
const CHROME = '/home/sarthak/.cache/ms-playwright/chromium-1148/chrome-linux/chrome';

// Adaptive-icon safe zone: visible circle is 66/108 dp ≈ 61% of canvas.
// Keep ring/die inside that: ring 54%, die 30% of canvas.
const html = (size, { kind }) => {
  const isFg = kind === 'fg'; // adaptive foreground (transparent bg)
  const isRound = kind === 'round'; // legacy circular
  const isSquare = kind === 'square'; // legacy squircle
  const ring = Math.round(size * (isFg ? 0.54 : 0.76));
  const die = Math.round(size * (isFg ? 0.30 : 0.44));
  const border = Math.max(2, Math.round(size * (isFg ? 0.022 : 0.02)));
  const radius = isRound ? '50%' : isSquare ? Math.round(size * 0.18) + 'px' : '0';
  const bg = isFg
    ? 'transparent'
    : `radial-gradient(115% 85% at 50% 8%, rgba(91,63,196,.55) 0%, rgba(42,26,110,0) 60%), #2a1a6e`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden}
    body{width:${size}px;height:${size}px;background:transparent;
      font-family:"Noto Color Emoji","Apple Color Emoji",sans-serif;-webkit-font-smoothing:antialiased}
    .wrap{position:relative;width:${size}px;height:${size}px;border-radius:${radius};overflow:hidden;
      display:flex;align-items:center;justify-content:center;background:${bg}}
    .ring{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:${ring}px;height:${ring}px;
      border-radius:50%;border:${border}px solid #ffd166;
      box-shadow:0 0 ${Math.round(size * 0.05)}px rgba(255,209,102,.5), inset 0 0 ${Math.round(size * 0.04)}px rgba(255,209,102,.22)}
    .die{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);line-height:1;font-size:${die}px;
      text-shadow:0 ${Math.round(size * 0.012)}px ${Math.round(size * 0.03)}px rgba(0,0,0,.45)}
  </style></head><body><div class="wrap"><div class="ring"></div><div class="die">&#127922;</div></div></body></html>`;
};

// density -> {legacy, adaptiveFg} px
const DENSITIES = {
  mdpi: { legacy: 48, fg: 108 },
  hdpi: { legacy: 72, fg: 162 },
  xhdpi: { legacy: 96, fg: 216 },
  xxhdpi: { legacy: 144, fg: 324 },
  xxxhdpi: { legacy: 192, fg: 432 },
};

(async () => {
  let browser;
  try {
    browser = await chromium.launch({ executablePath: CHROME });
  } catch {
    browser = await chromium.launch();
  }
  const shoot = async (size, kind, out) => {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(html(size, { kind }), { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(150);
    await page.screenshot({ path: out, type: 'png', omitBackground: kind === 'fg' });
    await page.close();
    console.log('wrote', path.relative(RES, out), `${size}x${size}`);
  };

  for (const [dens, { legacy, fg }] of Object.entries(DENSITIES)) {
    const dir = path.join(RES, `mipmap-${dens}`);
    fs.mkdirSync(dir, { recursive: true });
    await shoot(fg, 'fg', path.join(dir, 'ic_launcher_foreground.png'));
    await shoot(legacy, 'square', path.join(dir, 'ic_launcher.png'));
    await shoot(legacy, 'round', path.join(dir, 'ic_launcher_round.png'));
  }

  // Adaptive icon background = brand indigo (referenced by mipmap-anydpi-v26 XML)
  const bgXml = path.join(RES, 'values', 'ic_launcher_background.xml');
  fs.writeFileSync(bgXml, '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#2A1A6E</color>\n</resources>\n');
  console.log('wrote', path.relative(RES, bgXml), '(#2A1A6E)');

  await browser.close();
  console.log('DONE');
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
