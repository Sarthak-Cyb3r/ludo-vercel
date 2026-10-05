'use strict';
/**
 * tests/rules-test.js — 9 security checks against the PRODUCTION Firestore
 * rules (firestore.rules). The page can be served locally or from prod; the
 * Firestore SDK always talks to the live project, where the rules are deployed.
 *
 * Usage:  NODE_PATH=<playwright modules> node tests/rules-test.js [baseurl]
 *         baseurl defaults to http://localhost:8131
 *
 * Every run mints a RANDOM 5-char room code and verifies it does not exist
 * first — a constant code would collide with a previously-created doc and turn
 * the "create" check into an "update" (which the rules also allow for rooms,
 * but which would make the check a lie; and a stale doc can trip the
 * status/players precondition). Blocked operations must fail with
 * error.code === 'permission-denied'.
 *
 * Rules under test (firestore.rules):
 *   rooms/{code}   read: auth required
 *                  create/update: auth, code.size()==5, data.code==code,
 *                  data.v==2, players 1..6, (status precondition)
 *                  delete: if false
 *   rooms/{code}/msgs/{id}
 *                  read: auth required
 *                  create: room must exist, keys hasOnly [u,i,n,t,ts],
 *                  u == request.auth.uid, i 1..64, n 1..14, t 1..200,
 *                  ts int > 0
 *                  update/delete: if false
 *
 * Prints a human-readable FAIL line for the first failing assertion, then a
 * pretty JSON object (9 booleans + allPass). Exits 0 only when allPass.
 */
const { chromium } = require('playwright');
const fs = require('fs');

const BASE = (process.argv[2] || 'http://localhost:8131').replace(/\/$/, '');
const EXECUTABLE = '/home/sarthak/.cache/ms-playwright/chromium-1148/chrome-linux/chrome';
const VIEWPORT = { width: 430, height: 900 }; // mobile
const BUDGET_MS = 240000;

const ORDER = [
  'rulesTestCreateAllowed',
  'rulesTestOversizeDenied',
  'rulesTestExtraFieldDenied',
  'rulesTestMissingTsDenied',
  'rulesTestSpoofedUDenied',
  'rulesTestNonexistentRoomDenied',
  'rulesTestUpdateDenied',
  'rulesTestDeleteDenied',
  'rulesTestUnauthReadDenied',
];

const results = {};
let firstFail = null;

function check(name, ok, detail) {
  ok = !!ok;
  results[name] = ok;
  if (!ok && firstFail === null) firstFail = `${name}${detail ? ' — ' + detail : ''}`;
  return ok;
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
    for (const k of ORDER) out[k] = results[k];
    out.allPass = !!allPass && firstFail === null;
    if (firstFail) console.log(`FAIL: ${firstFail}`);
    console.log(JSON.stringify(out, null, 2));
    browser.close().catch(() => {});
    process.exit(out.allPass ? 0 : 1);
  }

  try {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const page = await ctx.newPage();
    page.setDefaultTimeout(25000);
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e && e.message ? e.message : String(e)));

    // Load the real app so we inherit its anonymous auth session.
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-act="create"]:not([disabled])', { timeout: 30000 });

    const res = await page.evaluate(async () => {
      const [
        { firebaseConfig },
        { getApps, getApp, initializeApp },
        { getAuth, onAuthStateChanged },
        { getFirestore, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc, collection },
      ] = await Promise.all([
        import(new URL('./firebase-config.js', location.href).href),
        import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
        import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js'),
        import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'),
      ]);

      const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
      const auth = getAuth(app);
      // The app signs in anonymously on load; wait for a uid (condition-based).
      const user = await Promise.race([
        new Promise((resolve, reject) => {
          const un = onAuthStateChanged(auth, (u) => {
            if (u) {
              un();
              resolve(u);
            }
          });
          setTimeout(() => {
            un();
            reject(new Error('anonymous auth never resolved'));
          }, 20000);
        }),
      ]).catch((e) => ({ uid: null, error: e.message }));
      if (!user || !user.uid) return { fatal: 'no auth uid: ' + (user && user.error) };

      const fsdb = getFirestore(app);
      const checks = {};
      const errs = {};
      const describe = (e) => (e && e.code ? e.code : (e && e.message) || String(e));
      // Every blocked write/read must come back as permission-denied.
      const denied = async (label, fn) => {
        try {
          await fn();
          checks[label] = false;
          errs[label] = 'NO ERROR — operation was allowed';
        } catch (e) {
          checks[label] = e.code === 'permission-denied';
          errs[label] = describe(e);
        }
      };

      // Fresh, verified-non-existent room codes (random per run).
      const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const gen = () => {
        const b = new Uint8Array(5);
        crypto.getRandomValues(b);
        return [...b].map((x) => ALPHA[x % ALPHA.length]).join('');
      };
      const freshCode = async () => {
        for (let i = 0; i < 6; i++) {
          const c = gen();
          if (!(await getDoc(doc(fsdb, 'rooms/' + c))).exists()) return c;
        }
        throw new Error('could not find a fresh room code');
      };
      const roomCode = await freshCode();
      const roomRef = doc(fsdb, 'rooms/' + roomCode);
      const msgs = collection(fsdb, 'rooms/' + roomCode + '/msgs');

      // 1. create on a fresh room with valid fields must be allowed
      try {
        await setDoc(roomRef, {
          v: 2,
          code: roomCode,
          players: [{ id: user.uid, name: 'RuleTester' }],
        });
        const back = await getDoc(roomRef);
        checks.rulesTestCreateAllowed = back.exists() && back.data().code === roomCode;
        if (!checks.rulesTestCreateAllowed) errs.rulesTestCreateAllowed = 'doc not readable after create';
      } catch (e) {
        checks.rulesTestCreateAllowed = false;
        errs.rulesTestCreateAllowed = describe(e);
      }

      const valid = () => ({
        u: user.uid,
        i: 'rule-test',
        n: 'Rules',
        t: 'valid message body',
        ts: Date.now(),
      });

      // 2. t of 201 chars exceeds size 200 → denied
      await denied('rulesTestOversizeDenied', () =>
        addDoc(msgs, { ...valid(), t: 'x'.repeat(201) })
      );

      // 3. extra key violates keys().hasOnly(['u','i','n','t','ts']) → denied
      await denied('rulesTestExtraFieldDenied', () => addDoc(msgs, { ...valid(), z: 'extra' }));

      // 4. missing ts → ts is int fails → denied
      await denied('rulesTestMissingTsDenied', () => {
        const { ts, ...rest } = valid();
        return addDoc(msgs, rest);
      });

      // 5. u spoofed to a different uid → u == request.auth.uid fails → denied
      await denied('rulesTestSpoofedUDenied', () =>
        addDoc(msgs, { ...valid(), u: 'not-my-uid-' + Math.random().toString(36).slice(2, 8) })
      );

      // 6. otherwise-valid msg in a room that does not exist → exists() fails → denied
      const ghostCode = await freshCode();
      await denied('rulesTestNonexistentRoomDenied', () =>
        addDoc(collection(fsdb, 'rooms/' + ghostCode + '/msgs'), valid())
      );

      // 7/8. create one legal msg, then update + delete it → both denied (create-only)
      let ownMsg = null;
      try {
        ownMsg = await addDoc(msgs, valid());
      } catch (e) {
        errs.rulesTestUpdateAllowedPre = describe(e);
      }
      if (ownMsg) {
        await denied('rulesTestUpdateDenied', () => updateDoc(ownMsg, { t: 'edited' }));
        await denied('rulesTestDeleteDenied', () => deleteDoc(ownMsg));
      } else {
        checks.rulesTestUpdateDenied = false;
        checks.rulesTestDeleteDenied = false;
        errs.rulesTestUpdateDenied = errs.rulesTestUpdateDenied || 'legal msg create failed';
        errs.rulesTestDeleteDenied = errs.rulesTestDeleteDenied || 'legal msg create failed';
      }

      // 9. read with NO auth → denied (separate app instance ⇒ no session)
      try {
        const anonApp = initializeApp(firebaseConfig, 'unauth-' + Math.random().toString(36).slice(2));
        const snap = await getDoc(doc(getFirestore(anonApp), 'rooms/' + roomCode));
        checks.rulesTestUnauthReadDenied = false;
        errs.rulesTestUnauthReadDenied = 'read succeeded, exists=' + snap.exists();
      } catch (e) {
        checks.rulesTestUnauthReadDenied = e.code === 'permission-denied';
        errs.rulesTestUnauthReadDenied = describe(e);
      }

      return { roomCode, uid: user.uid, checks, errs };
    });

    if (res.fatal) throw new Error(res.fatal);
    console.log(`room code: ${res.roomCode}  uid: ${res.uid}`);
    for (const k of ORDER) {
      check(k, res.checks[k], res.errs[k] || 'no result');
    }
    if (pageErrors.length && firstFail === null) firstFail = `page errors — ${pageErrors.join(' | ')}`;
    const allPass = firstFail === null && ORDER.every((k) => results[k] === true);
    report(allPass);
  } catch (e) {
    if (firstFail === null) firstFail = `aborted: ${e && e.message ? e.message : e}`;
    report(false);
  }
})();
