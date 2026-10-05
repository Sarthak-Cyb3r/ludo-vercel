'use strict';
/**
 * tests/e2e.js — two-player game flow (home → create → join → start → roll).
 *
 * Usage:  NODE_PATH=<playwright modules> node tests/e2e.js [baseurl]
 *         baseurl defaults to http://localhost:8131
 *
 * Prints a human-readable FAIL line for the first failing assertion, then a
 * pretty JSON object. Exits 0 only when every check passes (allPass === true).
 *
 * Determinism notes (no hard sleeps anywhere):
 *  - one fresh browser context per player (localStorage ludo-id differs → distinct players)
 *  - every wait is condition-based (waitForSelector / waitForFunction)
 *  - the "connecting" indicator is captured with a MutationObserver installed
 *    by addInitScript before any page script runs, so it cannot be missed
 *  - the dice has an infinite bob animation (.can) → clicked with {force:true}
 */
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = (process.argv[2] || 'http://localhost:8131').replace(/\/$/, '');
const EXECUTABLE = '/home/sarthak/.cache/ms-playwright/chromium-1148/chrome-linux/chrome';
const VIEWPORT = { width: 430, height: 900 }; // mobile
const BUDGET_MS = 240000; // ~3 min per-script budget (+ margin)

const ORDER = [
  'configured', 'connecting', 'roomCode', 'joinWorked', 'realtimeSync',
  'boardRendered', 'tokenChips', 'rollSynced', 'pageErrors',
];

const results = {};
const pageErrors = [];
let firstFail = null;

function check(name, ok, detail) {
  ok = !!ok;
  results[name] = ok;
  if (!ok && firstFail === null) firstFail = `${name}${detail ? ' — ' + detail : ''}`;
  return ok;
}
function watchErrors(page, tag) {
  page.on('pageerror', (e) => pageErrors.push(`[${tag}] ${e && e.message ? e.message : String(e)}`));
}
// Condition-based wait: resolves true when fn becomes truthy in the page, false on timeout.
async function tf(page, fn, arg, timeout = 20000) {
  try {
    await page.waitForFunction(fn, arg, { timeout });
    return true;
  } catch (e) {
    return false;
  }
}
async function gotoHome(page) {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-act="create"]:not([disabled])', { timeout: 25000 });
}

(async () => {
  const launch = { headless: true };
  if (fs.existsSync(EXECUTABLE)) launch.executablePath = EXECUTABLE;
  const browser = await chromium.launch(launch);
  const watchdog = setTimeout(() => {
    if (firstFail === null) firstFail = 'script budget exceeded';
    report(false);
  }, BUDGET_MS);

  function report(allPass) {
    clearTimeout(watchdog);
    const out = {};
    for (const k of ORDER) out[k] = k === 'pageErrors' ? pageErrors : results[k];
    out.allPass = !!allPass && firstFail === null && pageErrors.length === 0;
    if (firstFail) console.log(`FAIL: ${firstFail}`);
    console.log(JSON.stringify(out, null, 2));
    browser.close().catch(() => {});
    process.exit(out.allPass ? 0 : 1);
  }

  try {
    const ctx1 = await browser.newContext({ viewport: VIEWPORT });
    const ctx2 = await browser.newContext({ viewport: VIEWPORT });

    // Observe the transient "Connecting to the game server…" indicator (#cn).
    await ctx1.addInitScript(() => {
      window.__sawConnecting = false;
      const mark = () => {
        if (!window.__sawConnecting && document.getElementById('cn')) window.__sawConnecting = true;
      };
      try {
        new MutationObserver(mark).observe(document, {
          subtree: true, childList: true, attributes: true,
        });
      } catch (e) {}
    });

    const p1 = await ctx1.newPage();
    const p2 = await ctx2.newPage();
    p1.setDefaultTimeout(20000);
    p2.setDefaultTimeout(20000);
    watchErrors(p1, 'p1');
    watchErrors(p2, 'p2');

    // ---------- P1: home screen ----------
    await p1.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    const sawConnecting = await tf(p1, () => window.__sawConnecting === true, null, 15000);
    await p1.waitForSelector('[data-act="create"]:not([disabled])', { timeout: 25000 });
    const errText = ((await p1.locator('#err').textContent().catch(() => '')) || '').trim();
    check('configured', !/not configured/i.test(errText), `error text: "${errText}"`);
    check('connecting', sawConnecting, 'connecting indicator (#cn) was never observed');
    results.pageErrors = pageErrors;

    // ---------- P1: create a 2-player room ----------
    await p1.fill('#nm', 'Alpha');
    await p1.click('[data-act="pc"][data-n="2"]');
    await p1.click('[data-act="create"]');
    await p1.waitForSelector('.code', { timeout: 20000 });
    const code = ((await p1.locator('.code').textContent()) || '').trim().toUpperCase();
    check('roomCode', /^[A-Z0-9]{5}$/.test(code), `shown code: "${code}"`);
    console.log(`room code: ${code}`);

    // ---------- P2: join with the code ----------
    await gotoHome(p2);
    await p2.fill('#nm', 'Bravo');
    await p2.fill('#cd', code);
    await p2.click('[data-act="join"]');
    const joinWorked = await tf(
      p2,
      () => (document.body.innerText || '').includes('Waiting for the host to start'),
      null,
      20000
    );
    check('joinWorked', joinWorked, 'P2 never reached the non-host lobby view');

    // P2 sees state authored by P1 (room code + P1's slot) → realtime sync.
    const realtimeSync = await tf(
      p2,
      (expectedCode) => {
        const slots = [...document.querySelectorAll('.slot')].map((s) => s.textContent || '');
        const shown = ((document.querySelector('.code') || {}).textContent || '').trim().toUpperCase();
        return shown === expectedCode && slots.some((t) => t.includes('Alpha'));
      },
      code,
      20000
    );
    check('realtimeSync', realtimeSync, 'P2 does not see the room state P1 created');

    // ---------- P1: start the game ----------
    await p1.waitForSelector('[data-act="start"]:not([disabled])', { timeout: 20000 });
    await p1.click('[data-act="start"]');

    const boardRendered = await tf(
      p1,
      () => {
        const svg = document.querySelector('#bdw svg');
        return !!svg && svg.getBoundingClientRect().width > 0;
      },
      null,
      20000
    );
    check('boardRendered', boardRendered, 'SVG board did not render in #bdw');

    const tokenChips = await tf(p1, () => document.querySelectorAll('#top .chip').length === 2, null, 15000);
    check('tokenChips', tokenChips, `chip count !== 2`);

    // ---------- roll dice on P1, verify it syncs to P2 ----------
    const diceCanRoll = await tf(
      p1,
      () => {
        const d = document.getElementById('dice');
        return !!d && String(d.className).includes('can');
      },
      null,
      20000
    );
    let p1Settled = false;
    let p2Synced = false;
    if (diceCanRoll) {
      // .can dice bobs forever → not "stable"; force the click (documented gotcha).
      await p1.locator('#dice').click({ force: true });
      // P2 has no local shuffle animation: its dice + log must agree on the value.
      p2Synced = await tf(
        p2,
        () => {
          const d = document.getElementById('dice');
          if (!d) return false;
          const n = d.querySelectorAll('.pip').length;
          if (!(n >= 1 && n <= 6)) return false;
          const logs = [...document.querySelectorAll('.mut')].map((e) => e.textContent || '');
          return logs.some((t) => new RegExp(`rolled ${n}\\b`).test(t));
        },
        null,
        20000
      );
      const n = await p2.evaluate(() => {
        const d = document.getElementById('dice');
        return d ? d.querySelectorAll('.pip').length : 0;
      });
      // P1 finalises its local shuffle (~480ms, condition: final pips, dice no longer .can).
      p1Settled =
        n >= 1 &&
        (await tf(
          p1,
          (expected) => {
            const d = document.getElementById('dice');
            return (
              !!d &&
              !String(d.className).includes('can') &&
              d.querySelectorAll('.pip').length === expected
            );
          },
          n,
          15000
        ));
    }
    check(
      'rollSynced',
      diceCanRoll && p1Settled && p2Synced,
      `diceCanRoll=${diceCanRoll} p1Settled=${p1Settled} p2Synced=${p2Synced}`
    );

    results.pageErrors = pageErrors;
    if (pageErrors.length && firstFail === null) firstFail = `pageErrors — ${pageErrors.join(' | ')}`;

    const allPass =
      firstFail === null &&
      pageErrors.length === 0 &&
      ORDER.filter((k) => k !== 'pageErrors').every((k) => results[k] === true);
    report(allPass);
  } catch (e) {
    if (firstFail === null) firstFail = `aborted: ${e && e.message ? e.message : e}`;
    results.pageErrors = pageErrors;
    report(false);
  }
})();
