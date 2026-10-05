# E2E test suite

End-to-end tests for the single-file Ludo app (`index.html` + `firebase-config.js`,
Firebase Firestore realtime sync + anonymous auth).

**Why this lives in the repo:** the previous suite lived in `/tmp` and was wiped by
the OS — twice. These scripts are part of the project now; keep them in `tests/`.

## Prerequisites

Playwright is already installed globally (no `npm install` needed). Export
`NODE_PATH` first — every command below assumes it:

```bash
export NODE_PATH=/home/sarthak/.nvm/versions/node/v22.23.3/lib/node_modules/omniroute/node_modules
```

Chromium is auto-detected at
`/home/sarthak/.cache/ms-playwright/chromium-1148/chrome-linux/chrome`
(each script passes `executablePath` when that file exists).

## Local server

Serve a pristine copy of the app (never the working tree — another agent may be
editing repo files while tests run):

```bash
(python3 -m http.server 8131 --directory /tmp/ludo-baseline >/tmp/tests_http.log 2>&1 &)
```

Kill it when you are done:

```bash
pkill -f "http.server 8131"
```

## Run rules

- **Sequential only.** Run one script at a time, never in parallel: they all talk
  to the same production Firestore project (rate limits, shared docs) and each
  script already fans out to 1–5 browser contexts of its own.
- Every script takes an optional base URL as `process.argv[2]`
  (default `http://localhost:8131`).
- Every script prints a human-readable `FAIL: …` line for the **first** failing
  assertion, then a final pretty-printed JSON object, and **exits non-zero on
  failure** (`exit 1`), `0` only when `allPass: true`.
- Per-script time budget ≈ 3 minutes; waits are condition-based (15–30s
  timeouts), there are no hard sleeps.

## Commands and expected output

### 1. Two-player game flow — `tests/e2e.js`

```bash
node tests/e2e.js http://localhost:8131
```

Expected shape (all booleans, `pageErrors` an array):

```json
{
  "configured": true,
  "connecting": true,
  "roomCode": true,
  "joinWorked": true,
  "realtimeSync": true,
  "boardRendered": true,
  "tokenChips": true,
  "rollSynced": true,
  "pageErrors": [],
  "allPass": true
}
```

### 2. Room chat — `tests/chat-e2e.js`

```bash
node tests/chat-e2e.js http://localhost:8131
```

Expected shape (28 named checks + `errors` array + `allPass`):

```json
{
  "fabHiddenHome": true, "fabVisibleLobby": true, "fabVisibleLobbyP2": true,
  "openPanel": true, "sendDisabledEmpty": true, "sendEnabledAfterType": true,
  "inputClearedAfterSend": true, "ownBubble": true, "badgeCount": true,
  "senderName": true, "badgeClearedOnOpen": true, "p2OwnBubble": true,
  "p1RecvWithName": true, "enterSend": true, "maxlengthAttr": true,
  "jsCap200": true, "cap200Received": true, "escClose": true, "xClose": true,
  "backdropClose": true, "historyAfterStart": true, "inGameRecv": true,
  "badgeInGame": true, "badgeClearedInGame": true, "fabHiddenAfterLeave": true,
  "p2FabStillVisible": true, "sendAfterPeerLeft": true, "demoFabHidden": true,
  "errors": [],
  "allPass": true
}
```

### 3. 5-player finish + scoreboard — `tests/finish-e2e.js`

```bash
node tests/finish-e2e.js http://localhost:8131
```

Injects near-complete game state straight into Firestore (encoded `pieces` map,
`fin` arrays, `status`, `log`), drives the game's own no-move turn-skip logic,
and screenshots the final scoreboard to `tests/shots/scoreboard.png`.

Expected shape:

```json
{
  "roomCode5": true, "allFiveJoined": true, "gameStarted": true,
  "finishLog1": true, "finChip": true, "finishLog2": true, "finishLog3": true,
  "turnSkipLandsOnRankFour": true, "rows5": true, "row1st": true, "row2nd": true,
  "row3rd": true, "row4th": true, "rowLoser": true, "loserLast": true,
  "winnerTitle": true, "playAgain": true, "fabHiddenDone": true,
  "finPersisted": true,
  "errors": [],
  "allPass": true
}
```

### 4. Firestore security rules — `tests/rules-test.js`

```bash
node tests/rules-test.js http://localhost:8131
```

Page may be served locally; the Firestore SDK always talks to **production**,
where the rules are deployed. Each run mints a random, verified-non-existent
5-char room code (a constant code would collide with a previously created doc
and turn the create check into something else). Blocked operations must fail
with error code `permission-denied`.

Expected shape (9 booleans + `allPass`):

```json
{
  "rulesTestCreateAllowed": true,
  "rulesTestOversizeDenied": true,
  "rulesTestExtraFieldDenied": true,
  "rulesTestMissingTsDenied": true,
  "rulesTestSpoofedUDenied": true,
  "rulesTestNonexistentRoomDenied": true,
  "rulesTestUpdateDenied": true,
  "rulesTestDeleteDenied": true,
  "rulesTestUnauthReadDenied": true,
  "allPass": true
}
```

### 5. Load performance — `tests/perf.js`

```bash
node tests/perf.js http://localhost:8131
# or against production:
node tests/perf.js https://ludo-vercel-rho.vercel.app
```

Expected shape:

```json
{
  "url": "http://localhost:8131",
  "ttfb": 2,
  "dcl": 27,
  "load": 97,
  "fcp": 146,
  "readyMs": 219,
  "longTasks": 1,
  "longTotalMs": 76,
  "res": [ { "u": "/firebase-config.js", "ms": 4, "kb": 1 } ]
}
```

`readyMs` is the product's key UX metric: time from navigation start until
`[data-act="create"]` becomes enabled (the app is configured and connected).
`res[].u` is the request path only — query strings are dropped so no `?key=…`
secrets ever reach the log.

## Production spot-checks

The game-flow suites are also run against the deployed app (they create their
own rooms, so they are safe to run there):

```bash
node tests/e2e.js https://ludo-vercel-rho.vercel.app
node tests/chat-e2e.js https://ludo-vercel-rho.vercel.app
```

## App-specific gotchas baked into these scripts

- The app's JS is a module — `$`, `db`, etc. are **not** globals. Everything
  running inside `page.evaluate` uses `document.querySelector` and the gstatic
  Firebase modules imported in-page.
- Chat send has a 650ms client-side rate limit (`lastChatSend`); the chat test
  waits on that cooldown condition (700ms) before every send, otherwise the
  message is silently dropped.
- `#dice.can` has an infinite bob animation → Playwright reports "element is not
  stable"; dice clicks use `{ force: true }`.
- `#chatFab` is covered by the chat sheet while open → `ensureOpen` /
  `ensureClosed` helpers (Escape closes).
- The unread badge counts only messages received while the panel is closed;
  the first `watchMsgs` snapshot marks everything pre-existing as seen, so the
  chat test forces a proven snapshot round trip before counting.
- One fresh browser context per simulated player: `localStorage.ludo-id`
  differs per context, so each context is a distinct player.
- Viewport for all tests: 430×900 (mobile).
