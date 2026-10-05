# Android app — build & setup (Capacitor shell)

Native Android build for **Ludo with Friends**, per `NATIVE-APPS-PLAN.md` §2.
The web build stays canonical at the repo root — the Android project is a thin
Capacitor WebView shell around a *copy* of the same files.

- **App ID:** `com.ludovercel.app` · **Label:** `Ludo with Friends`
- **minSdk 26 / targetSdk 36 / compileSdk 36** (`android/variables.gradle`)
- **WebView origin:** `https://localhost` (via `server.androidScheme: "https"`)
  — this matters for Firebase Auth, see [MANUAL-SETUP](#manual-setup--human-actions-only)

---

## 1. Repository layout (who owns what)

| Path | Status in git | Purpose |
|---|---|---|
| `index.html`, `firebase-config.js`, `manifest.webmanifest`, `sw.js`, `icons/` | committed (web owner) | **Canonical web build** — never forked |
| `capacitor.config.json` | committed | Capacitor shell config (appId, webDir, androidScheme) |
| `scripts/build-www.mjs` | committed | Copies root web files → `www/` (idempotent) |
| `www/` | **gitignored** | Generated web copy (Capacitor `webDir`) |
| `android/` | committed **except** build outputs | Generated native project (Capacitor template + our edits) |
| `*.jks`, `*.apk`, `*.aab`, `.env*` | **gitignored** | Signing material & artifacts — never commit |

`android/.gitignore` (Capacitor template) already ignores `build/`, `.gradle/`,
`local.properties`, `*.apk`, and the synced assets under
`android/app/src/main/assets/`; the root `.gitignore` repeats these as
belt-and-braces and adds the keystore/password rules.

**Fresh clone → APK:**

```bash
npm ci                 # or npm install
npm run sync           # build:www  +  cap sync android  (also regenerates
                       # android/capacitor-cordova-android-plugins/, which is gitignored)
cd android && ./gradlew assembleDebug
```

> Always run `npm run sync` before Gradle after changing anything web-side or
> adding a plugin — Gradle builds from `android/app/src/main/assets/public/`,
> which is a synced copy (gitignored).

---

## 2. Toolchain (machine without system Java — no sudo needed)

Verified on this machine (no `java` on PATH, no `ANDROID_HOME`, no sudo):

```bash
# --- JDK 21 (Capacitor 8 compiles with --release 21; JDK 17 is NOT enough:
#     build fails with "invalid source release: 21") ---
mkdir -p ~/.local
curl -L -o /tmp/jdk21.tar.gz \
  "https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse?project=jdk"
tar -xzf /tmp/jdk21.tar.gz -C ~/.local && mv ~/.local/jdk-21* ~/.local/jdk21
~/.local/jdk21/bin/java -version
# openjdk version "21.0.12.1" 2026-08-18 LTS  (Temurin)

# --- Android SDK commandline-tools (~470 MB installed) ---
mkdir -p ~/.local/android-sdk/cmdline-tools
curl -L -o /tmp/cmdline-tools.zip \
  "https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip"
unzip -q /tmp/cmdline-tools.zip -d /tmp/clt && mv /tmp/clt/cmdline-tools ~/.local/android-sdk/cmdline-tools/latest

export JAVA_HOME="$HOME/.local/jdk21"
export ANDROID_HOME="$HOME/.local/android-sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"

yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$ANDROID_HOME" --licenses
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$ANDROID_HOME" \
  "platform-tools" "platforms;android-36" "build-tools;36.0.0"
```

To avoid repeating the exports, put them in `~/.bashrc` / `~/.profile`:

```bash
export JAVA_HOME="$HOME/.local/jdk21"
export ANDROID_HOME="$HOME/.local/android-sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
```

If you use Android Studio instead, set `android/local.properties`:
`sdk.dir=/path/to/Android/Sdk` (gitignored) and use its bundled JBR.

Memory: `android/gradle.properties` caps Gradle at `-Xmx512m` with
`org.gradle.daemon=false` so builds work on low-RAM boxes (build a normal dev
machine may raise `Xmx` to 2048m and re-enable the daemon for speed).

---

## 3. Everyday commands

```bash
npm run build:www      # root web files → www/ (scripts/build-www.mjs, idempotent)
npm run sync           # build:www + npx cap sync android
npm run android:build  # sync + ./gradlew assembleDebug
npm run android:apk    # ./gradlew assembleDebug only
npm run android:release# ./gradlew assembleRelease (see §4)
npm run android:open   # open the project in Android Studio
```

Equivalent raw commands (what was actually run to produce the verified APK):

```bash
export JAVA_HOME="$HOME/.local/jdk21" ANDROID_HOME="$HOME/.local/android-sdk" ANDROID_SDK_ROOT="$ANDROID_HOME"
npm run sync
cd android && ./gradlew assembleDebug --no-daemon
```

### Verified outputs (this environment, Oct 2026)

```
BUILD SUCCESSFUL in 2m 45s   (first run incl. Gradle 8.14.3 + AGP download)
153 actionable tasks: 96 executed, 57 up-to-date

android/app/build/outputs/apk/debug/app-debug.apk        4 710 178 bytes (~4.5 MB)
android/app/build/outputs/apk/release/app-release.apk    3 464 398 bytes (~3.3 MB, signed via env vars)
android/app/build/outputs/apk/release/app-release-unsigned.apk   (when env vars unset)

aapt badging (debug): package com.ludovercel.app · sdkVersion 26 · targetSdk 36
                      label "Ludo with Friends" · launchable com.ludovercel.app.MainActivity
APK contains: assets/public/{index.html, firebase-config.js, manifest.webmanifest,
                             sw.js, icons/icon-192|512|maskable|apple-touch-icon.png}
```

---

## 4. Release signing (SIGNING)

No keystore is committed (root `.gitignore` blocks `*.jks`, `*.keystore`,
`.env*`, `*.apk`, `*.aab`). `android/app/build.gradle` reads **environment
variables** and only wires `signingConfigs.release` when they are present:

| Env var | Meaning |
|---|---|
| `LUDO_KEYSTORE_FILE` | Absolute path to the keystore (outside the repo) |
| `LUDO_KEYSTORE_PASSWORD` | Keystore password (used for store + key) |
| `LUDO_KEYSTORE_ALIAS` | Key alias (default: `ludo`) |

### 4.1 One-time keystore creation — run as the project owner

```bash
keytool -genkeypair -v -keystore ~/keys/ludo-release.jks \
  -keyalg RSA -keysize 2048 -validity 10000 -alias ludo
# You will be prompted for a password and DN fields.
```

⚠️ **Keep `ludo-release.jks` and its password OUT of git and OUT of chat.**
Suggested: password manager entry + an encrypted backup of the `.jks`.
Losing the keystore means you can never update the app on Play Store under the
same identity (debug/other-device keys produce a different signature).

### 4.2 Build the signed release

```bash
export LUDO_KEYSTORE_FILE="$HOME/keys/ludo-release.jks"
export LUDO_KEYSTORE_PASSWORD="<CHOOSE_A_PASSWORD>"     # from your password manager
export LUDO_KEYSTORE_ALIAS=ludo

cd android && ./gradlew assembleRelease --no-daemon
# → android/app/build/outputs/apk/release/app-release.apk   (signed)
```

Without the env vars, `assembleRelease` succeeds but emits
`app-release-unsigned.apk` (and logs a warning if the path was set but missing).
For local install testing just use `app-debug.apk` — it is signed with the
Android debug key.

### 4.3 Verify + get the SHA-1 (needed for Firebase, §MANUAL-SETUP)

```bash
$ANDROID_HOME/build-tools/36.0.0/apksigner verify --print-certs app-release.apk
keytool -list -v -keystore ~/keys/ludo-release.jks -alias ludo   # → SHA1: AA:BB:…
```

(Both commands were exercised end-to-end with a throwaway keystore during
build verification; the throwaway was deleted and never entered the repo.)

---

## 5. MANUAL-SETUP — human actions only

These require the Firebase console (no credentials in this environment) and are
**blockers for auth inside the APK** even though the APK builds and installs.

### 5.1 Firebase Auth → Authorized domains ✅ *verified — no action needed*

Because `capacitor.config.json` sets `server.androidScheme: "https"`, the
WebView origin is **`https://localhost`** (not `file://` or `capacitor://`).

Firebase stores authorized domains **scheme-less**, and `localhost` was
already present in the project's list — verified via the Identity Toolkit
Admin API (`GET /admin/v2/projects/ludo-with-friends-7hme/config`):

```
authorizedDomains: ['localhost', 'ludo-with-friends-7hme.firebaseapp.com',
 'ludo-with-friends-7hme.web.app', 'ludo-vercel-rho.vercel.app',
 'ludo-vercel.vercel.app', 'ludo-sarthak.vercel.app']
```

Empirically confirmed against the live auth service (2026-10-05):

- Raw `accounts:signUp` with `Origin: https://localhost` → **anonymous sign-in OK**
- Raw `accounts:signUp` with `Origin: http://localhost` → **anonymous sign-in OK**
- Full app served over TLS at `https://localhost:8443` (WebView-equivalent
  origin) → real SDK `signInAnonymously` + room creation succeeded
  (`roomCreated: true`, `pageErrors: []`)

Console path, should it ever need re-checking:
Firebase Console → **Authentication → Settings → Authorized domains** →
`localhost` should be listed. (`https://localhost` is *not* how you enter it —
the field takes bare hostnames.)

### 5.2 API key restriction to this app *(recommended, after 5.3)*

Restrict the browser key so only your app can use it:

1. Google Cloud Console → **APIs & Credentials** → the key used in
   `firebase-config.js` (Web API key).
2. **Application restrictions:** Android apps → add:
   - Package name: `com.ludovercel.app`
   - SHA-1: *(the value printed by `keytool -list -v -keystore <release.jks>` —
     use the **release** keystore SHA-1, and add the debug SHA-1 as a second
     entry if you test debug builds against production)*
3. **API restrictions:** keep `Identity Toolkit` + `Firestore` APIs allowed.

> Order matters: generate the release keystore (§4.1) **before** doing 5.2, or
> you'll have to paste the SHA-1 twice.

### 5.3 Post-setup smoke test (plan §2.3)

- [ ] Fresh install of `app-debug.apk` → anonymous auth succeeds (§5.1 already verified server-side)
- [ ] Create/join room from the APK
- [ ] Back button behavior (see §6.1 — currently WebView default)
- [ ] Kill + relaunch → `ludo-id` in localStorage preserved
- [ ] Airplane mode → `Arcade offline — check your connection` toast

---

## 6. Known limitations / deferred work

### 6.1 Android back button — *deferred to web owner* ⚠️

`@capacitor/app@8.1.2` is installed and registered, but its
`backButton.addListener()` can only be registered from **page JavaScript**, and
`index.html` is owned by another agent (no edits allowed from the Android side).
Capacitor has no config/hook to inject a script tag into the HTML.

Current behavior: WebView default — back closes any `history.back()` navigation,
and from the root screen the app goes to the background (it does **not**
force-kill; Android may show the home screen).

**Follow-up (small, ~15 lines):** add to `index.html` (web-owner agent):

```html
<script type="module">
  import { App as CapApp } from '@capacitor/app';
  CapApp.addListener('backButton', () => {
    // 1) close chat sheet / modal if open → 2) history.back() if history.length > 1
    // 3) CapApp.minimizeApp()  (instead of exitApp) at root
  });
</script>
```

(`@capacitor/core` is a devDependency — for a page-side import either
`npm i @capacitor/core` as a runtime dep or load it via the generated
`capacitor.config.json` bridge once the snippet lands.)

### 6.2 StatusBar plugin JS API — *mitigated natively*

`@capacitor/status-bar@8.0.4` is installed, but its `setStyle()/setColor()`
calls are also JS-side. Instead, the status bar is now themed **natively**
with no JS needed:

- `android/app/src/main/res/values/styles.xml` → `android:statusBarColor`
  = `#2a1a6e` (`@color/ludoDeep`), `windowLightStatusBar=false` (light icons) —
  matches the web `theme-color`.
- Full `StatusBar.setStyle({style: DARK})` / `hide()` can be added later once a
  script tag exists (same blocker as §6.1).

### 6.3 Portrait lock

`android:screenOrientation="portrait"` was added to `MainActivity` in
`AndroidManifest.xml` (plan §2.3: "portrait lock or responsive check"; the board
is phone-first). Remove that attribute if a responsive tablet layout is wanted.

### 6.4 Service worker inside the WebView — OK, no action

`sw.js` registers normally under `https://localhost`. Navigations are
**network-first**, so an APK update always serves the newly bundled
`index.html` from the local asset server — no stale-shell risk. `skipWaiting()`
+ `clientsClaim()` handle SW version swaps.

### 6.5 Not yet done (plan §2.2 / §2.3 backlog)

- Firestore `enablePersistence()` (bonus, not required — web already survives
  reconnects via `onSnapshot`).
- Deep links `ludo://join/CODE` (plan §2.2.6, v2).
- Play Store privacy policy URL (plan §2.2.7) before any submission.
- On-device E2E of the checklist in plan §2.3 (requires a device/emulator —
  none available in this environment).

---

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| `invalid source release: 21` | You're on JDK 17 — Capacitor 8 needs **JDK 21** (§2) |
| `SDK location not found` | export `ANDROID_HOME` or write `android/local.properties` (`sdk.dir=…`) |
| `Failed to install the following Android SDK packages…licenses not accepted` | `yes \| sdkmanager --sdk_root=$ANDROID_HOME --licenses` |
| Gradle OOM / killed (`Java heap space`) | Keep `-Xmx512m`; close browsers; add swap; no other JVMs running |
| `404` for icons/manifest in APK | You skipped `npm run sync` — run it, rebuild |
| Auth fails only in the APK | §5.1 — `localhost` missing from Authorized domains (it is present; re-verify per §5.1) |
| `app-release-unsigned.apk` | Env vars from §4.2 not exported in that shell |
| `Could not resolve com.android.tools.build:gradle` | First-run network issue; rerun Gradle (downloads are cached in `~/.gradle`) |
