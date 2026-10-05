# Native App Plan — Ludo with Friends

Target: **Android `.apk`** + **Linux desktop app**, from the existing single-file web build
(`index.html` + `firebase-config.js`, no bundler, Firebase JS SDK v10.12.2 from gstatic).

Status: PLAN ONLY — not started. Web is production-green at
https://ludo-vercel-rho.vercel.app (commit `ccc211b`).

---

## 1. Ground rules

- **Keep the web build canonical.** Apps are thin shells around the same files — no fork of game logic.
- Keep the no-bundler constraint where possible; only add tooling the shell genuinely needs.
- Every shell change must pass the existing E2E matrix (game / chat / finish / rules) against a staging URL first.
- Firebase anonymous auth + Firestore are the only backend — no server code to port.

---

## 2. Android app (.apk)

### 2.1 Recommended: Capacitor (WebView shell)

Why: minimal code, hot-reload from the web build, direct APK output, room for native plugins later.

```
npm init -y
npm i @capacitor/core @capacitor/cli @capacitor/android
npx cap init "Ludo with Friends" com.ludovercel.app --web-dir www
# www/ = copy of index.html + firebase-config.js
npx cap add android
npx cap sync && npx cap open android   # Android Studio → Build > APK
```

Release pipeline (local or CI):

```
keytool -genkey -v -keystore ludo-release.jks -keyalg RSA -keysize 2048 \
        -validity 10000 -alias ludo
# android/app/build.gradle → signingConfigs.release
cd android && ./gradlew assembleRelease   # → app-release.apk
```

Alternatives (evaluate in this order):

| Option | Effort | Notes |
|---|---|---|
| **Capacitor** (chosen) | ~½ day | Owns the shell; upgrade path to Play Store |
| TWA / Bubblewrap | ~2 h | Loads the live URL in a Trusted Web Activity — zero code, but requires the site to be a proper PWA first (see §4) |
| Kotlin WebView | ~1 day | Smallest APK, but we maintain the shell by hand |

### 2.2 Android-specific work items

1. **Firebase authorized domains** — Capacitor Android WebView origin is `https://localhost`.
   Add it (and `http://localhost` for dev server) in Firebase Console → Auth → Settings →
   *Authorized domains*, or anonymous sign-in will fail silently in the shell.
2. **API key restriction** — restrict the web key to the app: package `com.ludovercel.app` +
   SHA-1 of the release keystore (`keytool -list -v -keystore ludo-release.jks`).
3. **Config bundling** — `firebase-config.js` ships inside `www/` (already unauthenticated keys;
   same posture as web). Verify `vercel.json`-equivalent caching isn't needed locally.
4. **Firestore offline persistence** — call `enablePersistence()` (web already relies on
   `onSnapshot` reconnection; offline queue is a bonus, not a requirement).
5. **Shell UX**
   - `navigator`/history: Android back button → close chat sheet → leave room → exit (override via
     `@capacitor/app` `backButton` listener).
   - `Fullscreen` / `StatusBar` styling (`@capacitor/status-bar`, dark style).
   - Prevent long-press text selection on the board (CSS `-webkit-user-select:none` already
     mostly covers; verify).
   - 100dvh / safe-area: CSS already uses `env(safe-area-inset-*)` — test on a notch device.
6. **Deep links (optional, v2)** — `ludo://join/CODE` scheme → shell injects code into `#cd`.
7. **Store listing (optional)** — Play Store requires a privacy policy URL for apps that collect
   identifiers; anonymous-auth Firestore IDs likely count. Draft one before submission.

### 2.3 Android test checklist

- [ ] Fresh install, anonymous auth succeeds (authorized-domain fix verified)
- [ ] Create/join room from APK against **production** Firestore
- [ ] Two-device game + chat E2E (reuse Playwright scripts on staging, manual on APK)
- [ ] Back button behavior at each state (home / lobby / game / chat open / done)
- [ ] Rotate device: portrait lock or responsive check
- [ ] Kill + relaunch app: `ludo-id` (localStorage) preserved, identity stable
- [ ] Offline toast path: airplane mode → `Arcade offline — check your connection`
- [ ] `assembleRelease` APK installs on API 26+ (min SDK 26 recommended)

---

## 3. Linux app

### 3.1 Recommended: Electron + electron-builder

Why: single-file web app loads as-is; `electron-builder` emits AppImage + `.deb` + `.tar.gz`.

```
npm i -D electron electron-builder
# main.js: BrowserWindow loading https://ludo-vercel-rho.vercel.app (or local www/)
# package.json → "build": { "linux": { "target": ["AppImage","deb"] }, "appId": "com.ludovercel.app" }
npx electron-builder --linux     # dist/*.AppImage, dist/*.deb
```

Shell requirements (`main.js`, ~40 lines):

- `BrowserWindow({ width: 430, height: 900, minWidth: 360, backgroundColor:'#2a1a6e' })` —
  phone-shaped; desktop Ludo boards are phone-first today.
- `setWindowOpenHandler` → deny (no stray tabs); `will-navigate` → allow only our origin.
- Optional: load **remote production URL** (always current) vs **bundled local copy**
  (works offline). Decide: *remote-first with local fallback*.

Alternative: **Tauri** (~2 MB vs ~100 MB) — but it wants a Rust toolchain and its WebView is
WebKitGTK (Linux) / WebView2 (Windows), so cross-platform QA doubles. Only worth it if
download size matters for distribution.

### 3.2 Linux-specific work items

1. **Origin for Firebase** — if loading `file://`, Firebase Auth rejects it. Must either
   (a) serve the remote HTTPS URL (simplest), or (b) register a custom scheme/localhost in
   Firebase authorized domains for the bundled copy. **Decision needed before build.**
2. **Desktop integration** — `.desktop` file + 512×512 PNG icon (extract from favicon SVG);
   `electron-builder` handles this for AppImage/deb.
3. **Window sizing** — current UI is mobile-first; either fix portrait window (recommended)
   or add a media query for `min-width: 700px` later (v2).
4. **Autostart / tray** — not needed v1.

### 3.3 Linux test checklist

- [ ] AppImage runs on a clean Ubuntu/Debian (glibc check) without FUSE errors
- [ ] `.deb` installs, icon + menu entry present
- [ ] Firebase auth works from the chosen origin (§3.2.1 decision)
- [ ] Two-instance behavior: second launch focuses first (or independent rooms — pick one)
- [ ] Game + chat E2E inside the Electron window
- [ ] Relaunch preserves `ludo-id`

---

## 4. Shared prerequisites (do these first, they pay for all shells)

1. **PWA manifest + service worker** (also unlocks TWA later):
   - `manifest.webmanifest` (name, theme `#2a1a6e`, portrait, standalone), icon 512/192 PNG.
   - Tiny SW: cache-first for `index.html` + `firebase-config.js`, network-first for gstatic.
   - Lighthouse PWA audit on prod URL.
2. **One Firebase origin decision table** — web origin already authorized; add
   `https://localhost` (Capacitor) and Electron origin(s) in one pass.
3. **Move E2E scripts out of `/tmp`** → `tests/` in the repo (they're the release gate for
   every shell build; `/tmp` already wiped them once).
4. **Staging channel** — `vercel deploy` a preview URL for shell testing so APK/dev builds
   never poke production Firestore directly.

---

## 5. Suggested order & effort

| # | Task | Est. |
|---|---|---|
| 1 | PWA manifest + SW (shared foundation) | 2–3 h |
| 2 | Move E2E scripts into `tests/` | 1 h |
| 3 | Capacitor Android, debug APK against staging | ½ day |
| 4 | Firebase authorized-domain + API-key fixes | ½ h (console) |
| 5 | Back button / status bar / release keystore + signed APK | ½ day |
| 6 | Linux Electron shell (remote-URL variant) + AppImage/deb | ½ day |
| 7 | Full test matrix on both shells, tag `v1.0.0-native` | ½ day |

**Total ≈ 3 days.** Quick win available: after step 1, Bubblewrap TWA produces a shippable
`.apk` in ~2 hours while Capacitor work proceeds.

---

## 6. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Firebase rejects auth from WebView origins | Blocker for Android | Add `https://localhost` to authorized domains early (step 4.4) |
| Anonymous accounts break if `ludo-id`/auth state diverge across shells | Identity confusion | Auth state is in WebView localStorage per-shell — document "different device = different player" (already true on web) |
| Firestore costs from more clients | $$ | Existing rules already restrict writes; keep `limit(50)` msg query |
| Play Store privacy policy requirement | Delay to store | Draft policy before step 7 if store submission is a goal |
| Electron bundle size (~100 MB) | Distribution friction | AppImage is single-file; switch to Tauri only if asked |
| `file://` origin breaks Firebase | Linux offline mode fails | Remote-URL variant first (§3.1), local-copy as v2 |
