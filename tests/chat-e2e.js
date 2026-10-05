'use strict';
/**
 * tests/chat-e2e.js — room chat E2E (FAB, panel, send/receive, unread badge,
 * rate limit, 200-char cap, close modes, history across game start, leave, demo).
 *
 * Usage:  NODE_PATH=<playwright modules> node tests/chat-e2e.js [baseurl]
 *         baseurl defaults to http://localhost:8131
 *
 * Prints a human-readable FAIL line for the first failing assertion, then a
 * pretty JSON object. Exits 0 only when allPass === true.
 *
 * Determinism notes (learned the hard way):
 *  - chat send has a 650ms client-side rate limit (lastChatSend) → typeChat()
 *    waits on the cooldown condition (>=700ms since the previous send) before
 *    every send; the message is silently dropped otherwise.
 *  - #chatFab is covered by the chat sheet while open → ensureOpen/ensureClosed
 *    helpers; Escape closes the sheet.
 *  - badge counts ONLY messages received while the panel is closed, and the
 *    first watchMsgs snapshot marks everything pre-existing as seen. So P2
 *    joins, opens once (proving the first snapshot arrived with P1's earlier
 *    message), closes, and only then is a message counted → badge === '1'.
 *  - one fresh browser context per player (distinct localStorage ludo-id).
 */
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = (process.argv[2] || 'http://localhost:8131').replace(/\/$/, '');
const EXECUTABLE = '/home/sarthak/.cache/ms-playwright/chromium-1148/chrome-linux/chrome';
const VIEWPORT = { width: 430, height: 900 }; // mobile
const BUDGET_MS = 240000;
const SEND_COOLDOWN_MS = 700; // > the app's 650ms lastChatSend limit

const ORDER = [
  'fabHiddenHome', 'fabVisibleLobby', 'fabVisibleLobbyP2', 'openPanel',
  'sendDisabledEmpty', 'sendEnabledAfterType', 'inputClearedAfterSend',
  'ownBubble', 'badgeCount', 'senderName', 'badgeClearedOnOpen',
  'p2OwnBubble', 'p1RecvWithName', 'enterSend', 'maxlengthAttr', 'jsCap200',
  'cap200Received', 'escClose', 'xClose', 'backdropClose', 'historyAfterStart',
  'inGameRecv', 'badgeInGame', 'badgeClearedInGame', 'fabHiddenAfterLeave',
  'p2FabStillVisible', 'sendAfterPeerLeft', 'demoFabHidden', 'errors', 'allPass',
];

const results = {};
const errors = [];
let firstFail = null;

function check(name, ok, detail) {
  ok = !!ok;
  results[name] = ok;
  if (!ok && firstFail === null) firstFail = `${name}${detail ? ' — ' + detail : ''}`;
  return ok;
}
function watchErrors(page, tag) {
  page.on('pageerror', (e) => errors.push(`[${tag}] ${e && e.message ? e.message : String(e)}`));
}
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
const chatIsOpen = (page) => page.evaluate(() => document.body.classList.contains('chat-open'));
const fabHidden = (page) => page.evaluate(() => {
  const f = document.getElementById('chatFab');
  return !f || f.hidden;
});
async function ensureOpen(page) {
  if (!(await chatIsOpen(page))) await page.click('#chatFab');
  return tf(page, () => document.body.classList.contains('chat-open'), null, 10000);
}
async function ensureClosed(page) {
  if (await chatIsOpen(page)) await page.keyboard.press('Escape');
  return tf(page, () => !document.body.classList.contains('chat-open'), null, 10000);
}
// Rate-limit aware send: wait out the app's cooldown condition, then type.
const lastSend = new Map();
async function typeChat(page, text) {
  const prev = lastSend.get(page);
  if (prev !== undefined) {
    // The predicate is serialized into the page, so pass the cooldown in as an arg.
    await page.waitForFunction(
      ({ since, ms }) => Date.now() - since >= ms,
      { since: prev, ms: SEND_COOLDOWN_MS },
      { timeout: 15000 }
    );
  }
  await page.fill('#chatIn', text);
}
const markSent = (page) => lastSend.set(page, Date.now());
async function sendChat(page, text) {
  await typeChat(page, text);
  await page.click('#chatSend');
  markSent(page);
}
const bubbles = (page, own) =>
  page.evaluate((isOwn) => {
    return [...document.querySelectorAll(`#msgs .m${isOwn ? '.me' : ':not(.me)'}`)].map((el) => ({
      name: ((el.querySelector('b') || {}).textContent || '').trim(),
      text: ((el.querySelector('span') || {}).textContent || '').trim(),
    }));
  }, own);

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
    for (const k of ORDER) out[k] = k === 'errors' ? errors : results[k];
    out.allPass = !!allPass && firstFail === null && errors.length === 0;
    if (firstFail) console.log(`FAIL: ${firstFail}`);
    console.log(JSON.stringify(out, null, 2));
    browser.close().catch(() => {});
    process.exit(out.allPass ? 0 : 1);
  }

  try {
    const ctx1 = await browser.newContext({ viewport: VIEWPORT });
    const ctx2 = await browser.newContext({ viewport: VIEWPORT });
    const p1 = await ctx1.newPage();
    const p2 = await ctx2.newPage();
    p1.setDefaultTimeout(20000);
    p2.setDefaultTimeout(20000);
    watchErrors(p1, 'p1');
    watchErrors(p2, 'p2');

    // ---------- P1 home: FAB hidden, then create a room ----------
    await gotoHome(p1);
    check('fabHiddenHome', await fabHidden(p1), 'chat FAB visible on home screen');

    await p1.fill('#nm', 'Alpha');
    await p1.click('[data-act="pc"][data-n="2"]');
    await p1.click('[data-act="create"]');
    await p1.waitForSelector('.code', { timeout: 20000 });
    const code = ((await p1.locator('.code').textContent()) || '').trim().toUpperCase();
    console.log(`room code: ${code}`);

    const p1Fab = await tf(p1, () => {
      const f = document.getElementById('chatFab');
      return !!f && !f.hidden;
    }, null, 15000);
    check('fabVisibleLobby', p1Fab, 'chat FAB not visible in P1 lobby');

    // ---------- P1 opens the panel: disabled → type → send ----------
    check('openPanel', (await ensureOpen(p1)) && (await chatIsOpen(p1)), 'panel did not open');
    check(
      'sendDisabledEmpty',
      await p1.evaluate(() => {
        const b = document.getElementById('chatSend');
        const i = document.getElementById('chatIn');
        return !!b && b.disabled && !!i && i.value === '';
      }),
      'Send button not disabled with empty input'
    );

    await typeChat(p1, 'hello from alpha');
    check(
      'sendEnabledAfterType',
      await p1.evaluate(() => !document.getElementById('chatSend').disabled),
      'Send button still disabled after typing'
    );
    await p1.click('#chatSend');
    markSent(p1);
    check(
      'inputClearedAfterSend',
      await tf(p1, () => (document.getElementById('chatIn') || { value: 'x' }).value === '', null, 10000),
      'input not cleared after send'
    );
    const own1 = await tf(
      p1,
      () =>
        [...document.querySelectorAll('#msgs .m.me span')].some((s) =>
          (s.textContent || '').includes('hello from alpha')
        ),
      null,
      20000
    );
    check('ownBubble', own1, 'own message bubble did not appear for P1');

    // ---------- P2 joins ----------
    await gotoHome(p2);
    await p2.fill('#nm', 'Bravo');
    await p2.fill('#cd', code);
    await p2.click('[data-act="join"]');
    const p2Lobby = await tf(
      p2,
      () => (document.body.innerText || '').includes('Waiting for the host to start'),
      null,
      20000
    );
    check('fabVisibleLobbyP2', p2Lobby && !(await fabHidden(p2)), 'chat FAB not visible in P2 lobby');

    // P2 opens once so the FIRST watchMsgs snapshot is provably delivered
    // (P1's pre-join message is visible) and everything is marked seen → clean
    // unread baseline. Then close again.
    await ensureOpen(p2);
    const sawHistory = await tf(
      p2,
      () =>
        [...document.querySelectorAll('#msgs .m span')].some((s) =>
          (s.textContent || '').includes('hello from alpha')
        ),
      null,
      20000
    );
    if (!(await chatIsOpen(p2)) || !sawHistory) {
      if (firstFail === null) {
        firstFail =
          'p2Warmup — P2 did not render pre-join chat history (first watchMsgs snapshot not observed)';
      }
    }
    await ensureClosed(p2);

    // ---------- exactly one message arrives while P2's panel is closed ----------
    await sendChat(p1, 'second from alpha');
    const badge1 = await tf(
      p2,
      () => {
        const b = document.getElementById('cbadge');
        return !!b && !b.hidden && b.textContent === '1';
      },
      null,
      20000
    );
    check('badgeCount', badge1, "unread badge !== '1' after one message while closed");

    // ---------- P2 opens: badge clears, sender name shows ----------
    await ensureOpen(p2);
    const p2View = await tf(
      p2,
      () =>
        [...document.querySelectorAll('#msgs .m:not(.me)')].some(
          (el) =>
            ((el.querySelector('b') || {}).textContent || '').trim() === 'Alpha' &&
            ((el.querySelector('span') || {}).textContent || '').includes('second from alpha')
        ),
      null,
      15000
    );
    check('senderName', p2View, "P2 does not see sender name 'Alpha' on the message");
    check(
      'badgeClearedOnOpen',
      await p2.evaluate(() => {
        const b = document.getElementById('cbadge');
        return !!b && b.hidden;
      }),
      'unread badge not cleared when panel opened'
    );

    // ---------- P2 sends (own bubble), P1 receives with name ----------
    await sendChat(p2, 'bravo says hi');
    const p2Own = await tf(
      p2,
      () =>
        [...document.querySelectorAll('#msgs .m.me span')].some((s) =>
          (s.textContent || '').includes('bravo says hi')
        ),
      null,
      20000
    );
    check('p2OwnBubble', p2Own, 'P2 own bubble did not appear');
    const p1Recv = await tf(
      p1,
      () =>
        [...document.querySelectorAll('#msgs .m:not(.me)')].some(
          (el) =>
            ((el.querySelector('b') || {}).textContent || '').trim() === 'Bravo' &&
            ((el.querySelector('span') || {}).textContent || '').includes('bravo says hi')
        ),
      null,
      20000
    );
    check('p1RecvWithName', p1Recv, "P1 did not receive P2's message with sender name");

    // ---------- Enter key sends ----------
    await typeChat(p2, 'via enter key');
    await p2.press('#chatIn', 'Enter');
    markSent(p2);
    const enterSent = await tf(
      p2,
      () =>
        [...document.querySelectorAll('#msgs .m.me span')].some((s) =>
          (s.textContent || '').includes('via enter key')
        ),
      null,
      20000
    );
    check('enterSend', enterSent, 'Enter key did not send the message');

    // ---------- 200-char cap: attribute + JS cap + receiver sees 200 ----------
    check(
      'maxlengthAttr',
      (await p2.getAttribute('#chatIn', 'maxlength')) === '200',
      'maxlength attribute is not 200'
    );
    await typeChat(p2, 'A'.repeat(250)); // JS input handler caps to 200
    const capLen = await p2.evaluate(() => (document.getElementById('chatIn') || { value: '' }).value.length);
    check('jsCap200', capLen === 200, `input length after typing 250 chars = ${capLen}`);
    await p2.click('#chatSend');
    markSent(p2);
    const recv200 = await tf(
      p1,
      () =>
        [...document.querySelectorAll('#msgs .m:not(.me) span')].some(
          (s) => (s.textContent || '').length === 200
        ),
      null,
      20000
    );
    check('cap200Received', recv200, 'P1 did not receive a 200-char message');

    // ---------- close modes on P1: Escape, ✕, backdrop ----------
    await p1.keyboard.press('Escape');
    check('escClose', !(await chatIsOpen(p1)), 'Escape did not close the panel');

    await ensureOpen(p1);
    await p1.click('.ccl'); // ✕ button, aria-label="Close chat"
    check('xClose', !(await chatIsOpen(p1)), '✕ button did not close the panel');

    await ensureOpen(p1);
    // sheet occupies the bottom 52vh; backdrop top area is the clickable zone
    await p1.click('.chat-bd', { position: { x: 40, y: 60 } });
    check('backdropClose', !(await chatIsOpen(p1)), 'backdrop click did not close the panel');

    // ---------- history survives game start ----------
    await p1.waitForSelector('[data-act="start"]:not([disabled])', { timeout: 20000 });
    await p1.click('[data-act="start"]');
    await tf(p1, () => !!document.querySelector('#bdw svg'), null, 20000);
    await ensureOpen(p1);
    const hist = await tf(
      p1,
      () => {
        const all = [...document.querySelectorAll('#msgs .m span')].map((s) => s.textContent || '');
        return all.some((t) => t.includes('hello from alpha')) && all.some((t) => t.includes('bravo says hi'));
      },
      null,
      15000
    );
    check('historyAfterStart', hist, 'chat history missing after the game started');
    await ensureClosed(p1); // P1 closed → next incoming message bumps the badge

    // ---------- message during the game: badge, then read on open ----------
    await sendChat(p2, 'midgame from bravo');
    const badgeGame = await tf(
      p1,
      () => {
        const b = document.getElementById('cbadge');
        return !!b && !b.hidden && b.textContent === '1';
      },
      null,
      20000
    );
    check('badgeInGame', badgeGame, "in-game unread badge !== '1'");

    await ensureOpen(p1);
    const inGame = await tf(
      p1,
      () =>
        [...document.querySelectorAll('#msgs .m:not(.me) span')].some((s) =>
          (s.textContent || '').includes('midgame from bravo')
        ),
      null,
      15000
    );
    check('inGameRecv', inGame, 'in-game message not received by P1');
    check(
      'badgeClearedInGame',
      await p1.evaluate(() => {
        const b = document.getElementById('cbadge');
        return !!b && b.hidden;
      }),
      'in-game badge not cleared on open'
    );

    // ---------- P1 leaves: FAB gone; P2 unaffected ----------
    await ensureClosed(p1);
    await p1.click('[data-act="leave"]');
    await p1.waitForSelector('[data-act="create"]:not([disabled])', { timeout: 20000 });
    check('fabHiddenAfterLeave', await fabHidden(p1), 'chat FAB still visible after leaving the room');

    check('p2FabStillVisible', !(await fabHidden(p2)), 'P2 chat FAB disappeared after P1 left');

    await ensureOpen(p2);
    await sendChat(p2, 'still here alone');
    const afterLeft = await tf(
      p2,
      () =>
        [...document.querySelectorAll('#msgs .m.me span')].some((s) =>
          (s.textContent || '').includes('still here alone')
        ),
      null,
      20000
    );
    check('sendAfterPeerLeft', afterLeft, 'P2 could not send after the peer left');

    // ---------- demo mode: FAB hidden ----------
    await p1.click('[data-act="demo"]');
    check(
      'demoFabHidden',
      await tf(p1, () => {
        const f = document.getElementById('chatFab');
        return !!f && f.hidden;
      }, null, 10000),
      'chat FAB visible in demo mode'
    );

    results.errors = errors;
    if (errors.length && firstFail === null) firstFail = `errors — ${errors.join(' | ')}`;
    const allPass =
      firstFail === null &&
      errors.length === 0 &&
      ORDER.filter((k) => k !== 'errors' && k !== 'allPass').every((k) => results[k] === true);
    report(allPass);
  } catch (e) {
    if (firstFail === null) firstFail = `aborted: ${e && e.message ? e.message : e}`;
    results.errors = errors;
    report(false);
  }
})();
