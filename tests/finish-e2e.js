'use strict';
/**
 * tests/finish-e2e.js — 5-player finish flow + scoreboard, with game state
 * injected straight into Firestore (bypassing hours of dice rolls).
 *
 * Usage:  NODE_PATH=<playwright modules> node tests/finish-e2e.js [baseurl]
 *         baseurl defaults to http://localhost:8131
 *
 * Schema notes (confirmed against index.html's enc()/dec() and create()/start()):
 *  - Firestore has no arrays-in-arrays, so `pieces` is stored ENCODED as a map
 *    {p0:[..],p1:[..],...}; index.html dec() sorts those keys back into an
 *    array-of-arrays. Patches below are plain arrays of arrays; the injector
 *    runs the app's own enc() before setDoc.
 *  - full doc shape: v, code, host, max, n, status, rnd, players, pieces,
 *    turn, dice, last, winner, fin, log (+ rc after rolls).
 *  - home/finished position is G.L+5 = 70 (5-arm board: G.L = 13*5 = 65).
 *  - turn auto-advance: render() arms a 750ms "no move" timer when
 *    status==='playing' && dice!=null && no piece can move; it then saves
 *    {dice:null, turn: next unfinished player}. A finished player (all pieces
 *    at 70) can never move, so rolling on one triggers the game's own skip.
 *
 * Prints a human-readable FAIL line for the first failing assertion, then a
 * pretty JSON object. Exits 0 only when allPass === true. Saves the final
 * scoreboard to tests/shots/scoreboard.png.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = (process.argv[2] || 'http://localhost:8131').replace(/\/$/, '');
const EXECUTABLE = '/home/sarthak/.cache/ms-playwright/chromium-1148/chrome-linux/chrome';
const VIEWPORT = { width: 430, height: 900 }; // mobile
const BUDGET_MS = 240000;
const SHOT = path.join(__dirname, 'shots', 'scoreboard.png');
const NAMES = ['RankOne', 'RankTwo', 'RankThree', 'RankFour', 'RankFive'];

const ORDER = [
  'roomCode5', 'allFiveJoined', 'gameStarted', 'finishLog1', 'finChip',
  'finishLog2', 'finishLog3', 'turnSkipLandsOnRankFour', 'rows5', 'row1st',
  'row2nd', 'row3rd', 'row4th', 'rowLoser', 'loserLast', 'winnerTitle',
  'playAgain', 'fabHiddenDone', 'finPersisted', 'errors', 'allPass',
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
async function tf(page, fn, arg, timeout = 20000) {
  try {
    await page.waitForFunction(fn, arg, { timeout });
    return true;
  } catch (e) {
    return false;
  }
}
const textIncludes = (page, text) =>
  tf(page, (t) => (document.body.innerText || '').includes(t), text, 20000);
const activeChipIncludes = (page, name) =>
  tf(
    page,
    (n) => {
      const c = document.querySelector('#top .chip[aria-current="true"]');
      return !!c && (c.textContent || '').includes(n);
    },
    name,
    20000
  );

/**
 * Read the live doc with the app's own dec(), merge a patch, write it back
 * with the app's enc(). Runs in the host page (already anonymous-authed, so
 * Firestore rules allow the update).
 */
function makeInject(page) {
  return async (patch) => {
    const { __code, ...fields } = patch;
    return page.evaluate(
      async (arg) => {
        const [
          { firebaseConfig },
          { getApps, getApp, initializeApp },
          { getFirestore, doc, getDoc, setDoc },
        ] = await Promise.all([
          import(new URL('./firebase-config.js', location.href).href),
          import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
          import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'),
        ]);
        const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
        const dbi = getFirestore(app);
        const enc = (d) => ({ ...d, pieces: Object.fromEntries((d.pieces || []).map((a, i) => ['p' + i, a])) });
        const dec = (d) => ({ ...d, pieces: Object.keys(d.pieces || {}).sort().map((k) => d.pieces[k]) });
        const ref = doc(dbi, 'rooms/' + arg.code);
        const snap = await getDoc(ref);
        if (!snap.exists()) return { ok: false, error: 'room doc not found' };
        const merged = { ...dec(snap.data()), ...arg.patch };
        await setDoc(ref, enc(merged), { merge: true });
        return { ok: true, fin: merged.fin, turn: merged.turn, status: merged.status };
      },
      { code: __code, patch: fields }
    );
  };
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
    for (const k of ORDER) out[k] = k === 'errors' ? errors : results[k];
    out.allPass = !!allPass && firstFail === null && errors.length === 0;
    if (firstFail) console.log(`FAIL: ${firstFail}`);
    console.log(JSON.stringify(out, null, 2));
    browser.close().catch(() => {});
    process.exit(out.allPass ? 0 : 1);
  }

  try {
    fs.mkdirSync(path.dirname(SHOT), { recursive: true });

    // ---------- five players, five fresh contexts ----------
    const pages = [];
    for (let i = 0; i < 5; i++) {
      const ctx = await browser.newContext({ viewport: VIEWPORT });
      const page = await ctx.newPage();
      page.setDefaultTimeout(20000);
      page.on('pageerror', (e) => errors.push(`[p${i + 1}] ${e && e.message ? e.message : String(e)}`));
      pages.push(page);
    }
    const host = pages[0];
    const inject = makeInject(host);

    // ---------- host creates a 5-player room ----------
    await host.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await host.waitForSelector('[data-act="create"]:not([disabled])', { timeout: 25000 });
    await host.fill('#nm', NAMES[0]);
    await host.click('[data-act="pc"][data-n="5"]');
    await host.click('[data-act="create"]');
    await host.waitForSelector('.code', { timeout: 20000 });
    const code = ((await host.locator('.code').textContent()) || '').trim().toUpperCase();
    check('roomCode5', /^[A-Z0-9]{5}$/.test(code), `shown code: "${code}"`);
    console.log(`room code: ${code}`);

    // ---------- four more players join ----------
    for (let i = 1; i < 5; i++) {
      const page = pages[i];
      await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-act="create"]:not([disabled])', { timeout: 25000 });
      await page.fill('#nm', NAMES[i]);
      await page.fill('#cd', code);
      await page.click('[data-act="join"]');
      const joined = await tf(
        page,
        () => (document.body.innerText || '').includes('Waiting for the host to start'),
        null,
        20000
      );
      if (!joined && firstFail === null) firstFail = `join failed for ${NAMES[i]}`;
    }

    // every page sees 5 filled lobby slots (no "Waiting for player…")
    let allJoined = true;
    for (const page of pages) {
      const ok = await tf(
        page,
        () => {
          const slots = [...document.querySelectorAll('.slot')];
          return slots.length === 5 && slots.every((s) => !s.classList.contains('sh'));
        },
        null,
        20000
      );
      allJoined = allJoined && ok;
    }
    check('allFiveJoined', allJoined, 'not every client sees 5 filled slots');

    // ---------- host starts the game ----------
    await host.waitForSelector('[data-act="start"]:not([disabled])', { timeout: 20000 });
    await host.click('[data-act="start"]');
    let started = true;
    for (const page of pages) {
      const ok = await tf(page, () => !!document.querySelector('#bdw svg'), null, 20000);
      started = started && ok;
    }
    check('gameStarted', started, 'board did not render for every player');

    const HOME = 70; // G.L+5 on the 5-arm board — finished pieces live here
    const yard = [0, 0, 0, 0];
    const home4 = [HOME, HOME, HOME, HOME];
    const base = {
      __code: code,
      dice: null,
      last: 1,
      status: 'playing',
      winner: null,
    };

    // ---------- 1st place finishes ----------
    let r = await inject({
      ...base,
      pieces: [home4, yard, yard, yard, yard],
      fin: [0],
      turn: 1,
      log: `${NAMES[0]} finished — 4 players to go 🏁`,
    });
    if (!r.ok && firstFail === null) firstFail = `inject1 failed: ${r.error}`;
    check('finishLog1', await textIncludes(host, `${NAMES[0]} finished`), 'log did not update for 1st finish');
    const chip0 = await tf(
      host,
      () => {
        const c = document.querySelectorAll('#top .chip')[0];
        return !!c && (c.textContent || '').includes('🏁');
      },
      null,
      20000
    );
    check('finChip', chip0, 'finished player chip missing the 🏁 marker');

    // ---------- 2nd place finishes ----------
    r = await inject({
      ...base,
      pieces: [home4, home4, yard, yard, yard],
      fin: [0, 1],
      turn: 2,
      log: `${NAMES[1]} finished — 3 players to go 🏁`,
    });
    if (!r.ok && firstFail === null) firstFail = `inject2 failed: ${r.error}`;
    check('finishLog2', await textIncludes(host, `${NAMES[1]} finished`), 'log did not update for 2nd finish');

    // ---------- 3rd place finishes; turn forced onto the finished player ----------
    r = await inject({
      ...base,
      pieces: [home4, home4, home4, yard, yard],
      fin: [0, 1, 2],
      turn: 2, // RankThree is finished → no move is possible for them
      log: `${NAMES[2]} finished — 2 players to go 🏁`,
    });
    if (!r.ok && firstFail === null) firstFail = `inject3 failed: ${r.error}`;
    check('finishLog3', await textIncludes(host, `${NAMES[2]} finished`), 'log did not update for 3rd finish');

    // ---------- no-move skip: RankThree (finished) rolls, game must advance to RankFour ----------
    const turnOnFinished = await activeChipIncludes(pages[2], NAMES[2]);
    const diceCanRoll =
      turnOnFinished &&
      (await tf(
        pages[2],
        () => {
          const d = document.getElementById('dice');
          return !!d && String(d.className).includes('can');
        },
        null,
        15000
      ));
    let skipOk = false;
    if (diceCanRoll) {
      // .can dice bobs forever → force the click (documented gotcha)
      await pages[2].locator('#dice').click({ force: true });
      // the game's own 750ms no-move timer must advance the turn past finished players
      const hostSees = await activeChipIncludes(host, NAMES[3]);
      const rankFourSees =
        (await activeChipIncludes(pages[3], NAMES[3])) &&
        (await tf(
          pages[3],
          () => {
            const d = document.getElementById('dice');
            return !!d && String(d.className).includes('can');
          },
          null,
          15000
        ));
      skipOk = hostSees && rankFourSees;
    }
    check(
      'turnSkipLandsOnRankFour',
      skipOk,
      `turnOnFinished=${turnOnFinished} diceCanRoll=${diceCanRoll}`
    );

    // ---------- 4th place finishes → game done (fin.length === players.length-1) ----------
    r = await inject({
      ...base,
      pieces: [home4, home4, home4, home4, yard],
      fin: [0, 1, 2, 3],
      turn: 3,
      status: 'done',
      winner: 0,
      log: `${NAMES[0]} wins! 🎉`,
    });
    if (!r.ok && firstFail === null) firstFail = `inject4 failed: ${r.error}`;

    const rowsReady = await tf(host, () => document.querySelectorAll('.score .srow').length === 5, null, 20000);
    const rows = rowsReady
      ? await host.evaluate(() =>
          [...document.querySelectorAll('.score .srow')].map((el) => ({
            text: (el.textContent || '').trim().replace(/\s+/g, ' '),
            gold: el.classList.contains('gold'),
            lz: el.classList.contains('lz'),
          }))
        )
      : [];
    check('rows5', rowsReady && rows.length === 5, `scoreboard rows = ${rows.length}`);
    const rowHas = (i, name, place) =>
      rowsReady && rows[i] && rows[i].text.includes(name) && rows[i].text.includes(place);
    check('row1st', rowHas(0, NAMES[0], '1st') && rows[0].gold, `row1 = ${rows[0] && rows[0].text}`);
    check('row2nd', rowHas(1, NAMES[1], '2nd'), `row2 = ${rows[1] && rows[1].text}`);
    check('row3rd', rowHas(2, NAMES[2], '3rd'), `row3 = ${rows[2] && rows[2].text}`);
    check('row4th', rowHas(3, NAMES[3], '4th'), `row4 = ${rows[3] && rows[3].text}`);
    check(
      'rowLoser',
      rowsReady && rows[4] && rows[4].text.includes(NAMES[4]) && rows[4].text.includes('Loser'),
      `row5 = ${rows[4] && rows[4].text}`
    );
    check(
      'loserLast',
      rowsReady && rows.length === 5 && rows[4].lz,
      'last row is not the loser (lz) row'
    );

    const winText = await host.evaluate(() => {
      const w = document.querySelector('.win');
      return w ? w.textContent : '';
    });
    check('winnerTitle', winText.includes(NAMES[0]) && winText.includes('wins'), `winner title = "${winText}"`);

    const againReady = await tf(host, () => !!document.querySelector('[data-act="again"]'), null, 15000);
    check('playAgain', againReady && (await host.isVisible('[data-act="again"]')), 'Play again button not visible');

    check(
      'fabHiddenDone',
      await host.evaluate(() => {
        const f = document.getElementById('chatFab');
        return !!f && f.hidden;
      }),
      'chat FAB still visible when the game is done'
    );

    // ---------- scoreboard artifact ----------
    await host.screenshot({ path: SHOT, fullPage: true });
    console.log(`screenshot: ${SHOT}`);

    // ---------- fin persisted? re-read from a fresh getDoc ----------
    const persisted = await host.evaluate(async (roomCode) => {
      const [{ firebaseConfig }, { getApps, getApp, initializeApp }, { getFirestore, doc, getDoc }] =
        await Promise.all([
          import(new URL('./firebase-config.js', location.href).href),
          import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
          import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'),
        ]);
      const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
      const snap = await getDoc(doc(getFirestore(app), 'rooms/' + roomCode));
      if (!snap.exists()) return { exists: false };
      const d = snap.data();
      return {
        exists: true,
        fin: d.fin,
        status: d.status,
        winner: d.winner,
        p0: d.pieces && d.pieces.p0,
      };
    }, code);
    check(
      'finPersisted',
      persisted.exists &&
        Array.isArray(persisted.fin) &&
        persisted.fin.join(',') === '0,1,2,3' &&
        persisted.status === 'done' &&
        persisted.winner === 0 &&
        Array.isArray(persisted.p0) &&
        persisted.p0.every((v) => v === HOME),
      `persisted=${JSON.stringify(persisted)}`
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
