'use strict';
/**
 * tests/perf.js — page-load performance metrics for the Ludo app.
 *
 * Usage:  NODE_PATH=<playwright modules> node tests/perf.js [url]
 *         url defaults to http://localhost:8131 (also works with
 *         https://ludo-vercel-rho.vercel.app)
 *
 * Metrics:
 *   ttfb        ms from navigation start to first byte (responseStart)
 *   dcl         ms to DOMContentLoadedEventEnd
 *   load        ms to loadEventEnd
 *   fcp         ms to first-contentful-paint (null if no paint entry)
 *   readyMs     ms from navigation start until the product's key UX moment:
 *               document.querySelector('[data-act="create"]:not([disabled])')
 *               appears (measured by a MutationObserver installed before any
 *               page script runs — no polling, no sleeps)
 *   longTasks   count of long tasks observed (PerformanceObserver, buffered)
 *   longTotalMs summed duration of those long tasks
 *   res         [{u, ms, kb}] resource timings; u is the path only and any
 *               query string is dropped (no query secrets)
 *
 * Prints a human-readable FAIL line if readiness never happens, then the JSON.
 * Exits 0 when readyMs was captured, 1 otherwise.
 */
const { chromium } = require('playwright');
const fs = require('fs');

const URL_ARG = process.argv[2] || 'http://localhost:8131';
const EXECUTABLE = '/home/sarthak/.cache/ms-playwright/chromium-1148/chrome-linux/chrome';
const VIEWPORT = { width: 430, height: 900 }; // mobile
const BUDGET_MS = 180000;

(async () => {
  const launch = { headless: true };
  if (fs.existsSync(EXECUTABLE)) launch.executablePath = EXECUTABLE;
  const browser = await chromium.launch(launch);
  let printed = false;
  const watchdog = setTimeout(() => {
    if (!printed) {
      console.log('FAIL: script budget exceeded');
      console.log(JSON.stringify({ url: URL_ARG, readyMs: null }, null, 2));
      process.exit(1);
    }
  }, BUDGET_MS);

  const fail = (msg, extra) => {
    if (!printed) {
      console.log(`FAIL: ${msg}`);
      console.log(JSON.stringify({ url: URL_ARG, readyMs: null, ...(extra || {}) }, null, 2));
      process.exit(1);
    }
  };

  try {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    await ctx.addInitScript(() => {
      // readyMs: observe until the Create button becomes enabled.
      window.__perfReadyAt = null;
      try {
        const mark = () => {
          if (window.__perfReadyAt !== null) return;
          if (document.querySelector('[data-act="create"]:not([disabled])')) {
            window.__perfReadyAt = performance.now();
          }
        };
        new MutationObserver(mark).observe(document, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ['disabled'],
        });
      } catch (e) {}
      // long tasks: buffered so early tasks are not missed.
      window.__lt = { count: 0, total: 0 };
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            window.__lt.count += 1;
            window.__lt.total += entry.duration;
          }
        }).observe({ type: 'longtask', buffered: true });
      } catch (e) {}
    });

    const page = await ctx.newPage();
    await page.goto(URL_ARG, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => {
      fail(`navigation failed: ${e && e.message ? e.message : e}`);
    });
    await page.waitForLoadState('load', { timeout: 60000 }).catch(() => {});

    // Condition-based wait for the product's readiness signal.
    const ready = await page
      .waitForFunction(() => window.__perfReadyAt !== null, null, { timeout: 45000 })
      .then(() => true)
      .catch(() => false);
    if (!ready) fail('Create button never became enabled ([data-act="create"]:not([disabled]))');

    const m = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0] || {};
      const fcpEntry = performance.getEntriesByType('paint').find((p) => p.name === 'first-contentful-paint');
      const res = [];
      for (const r of performance.getEntriesByType('resource')) {
        if (!/^https?:$/.test(r.name) && r.name.indexOf('http') !== 0) continue;
        let u;
        try {
          const parsed = new URL(r.name);
          // Path only — strips any query string (never leak ?key=... secrets).
          u = parsed.pathname || '/';
        } catch (e) {
          u = String(r.name).split('?')[0];
        }
        const bytes = r.transferSize || r.encodedBodySize || 0;
        res.push({ u, ms: Math.round(r.duration), kb: Math.round(bytes / 1024) });
      }
      return {
        ttfb: Math.round(nav.responseStart || 0),
        dcl: Math.round(nav.domContentLoadedEventEnd || 0),
        load: Math.round(nav.loadEventEnd || 0),
        fcp: fcpEntry ? Math.round(fcpEntry.startTime) : null,
        readyMs: window.__perfReadyAt === null ? null : Math.round(window.__perfReadyAt),
        longTasks: window.__lt.count,
        longTotalMs: Math.round(window.__lt.total),
        res,
      };
    });

    if (m.readyMs === null) fail('readyMs missing after readiness wait');
    printed = true;
    clearTimeout(watchdog);
    console.log(JSON.stringify({ url: URL_ARG, ...m }, null, 2));
    await browser.close().catch(() => {});
    process.exit(0);
  } catch (e) {
    fail(`aborted: ${e && e.message ? e.message : e}`);
  }
})();
