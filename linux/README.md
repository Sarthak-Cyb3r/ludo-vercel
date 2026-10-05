# Ludo with Friends — Linux desktop app (Electron)

Thin Electron shell around the production web app, per **NATIVE-APPS-PLAN.md §3**
(Electron + electron-builder → AppImage + .deb). No fork of the game: the shell
loads the live site; the web build in the repo root stays canonical.

## Quick start

```bash
cd linux
npm install          # devDeps: electron ^44, electron-builder ^26 (~150 MB, downloads Chromium)
npm start            # run from source (dev menu enabled)
npm run dist         # build:www + electron-builder --linux → dist/*.AppImage, dist/*.deb
```

Artifacts (this build):

| File | Size | Notes |
|---|---|---|
| `dist/ludo-with-friends-1.0.0-x86_64.AppImage` | 120 MB | single-file, chmod +x, run directly |
| `dist/ludo-with-friends-1.0.0-amd64.deb` | 95 MB | `sudo apt install ./dist/…-amd64.deb` |
| `dist/linux-unpacked/` | 283 MB | unpacked app (useful for quick local runs) |

`dist/builder-effective-config.yaml` and the `.blockmap` files are build
side-products; only the two installers above are the deliverables.

## Design: remote-first with local fallback (§3.1, §3.2.1)

The window loads **`https://ludo-vercel-rho.vercel.app`** first — always the
current production build, and critically it gives Firebase Auth a real `https:`
origin. A `file://` origin is rejected by Firebase, which is exactly why the
bundled copy is **not** the primary mode:

- **Remote load succeeds** (normal case): the app is the live web app.
- **Remote load fails** (offline, DNS dead, prod down) *or* hangs >20 s:
  the shell falls back **once** to the bundled copy in `resources/www/`
  (`index.html` + `firebase-config.js`, copied verbatim by `npm run build:www`).
  The fallback renders the full UI; Firebase initializes to `db = null` and the
  app shows *"Arcade offline — check your connection"* — the degraded state the
  web app already implements. A blank error page is never shown while a local
  copy exists. If even the local copy can't load, a native error dialog appears.

Logs are prefixed `[shell]` so you can see which path was taken:

```
[shell] loading remote → https://ludo-vercel-rho.vercel.app
[shell] did-finish-load → https://ludo-vercel-rho.vercel.app/
# or, when offline:
[shell] did-fail-load: -105 ERR_NAME_NOT_RESOLVED for https://ludo-vercel-rho.vercel.app/
[shell] remote load failed → ERR_NAME_NOT_RESOLVED (-105) | falling back to bundled resources/www/
[shell] did-finish-load → file:///…/resources/www/index.html
```

`npm run build:www` **copies** (never symlinks, never edits) the repo-root
`index.html` + `firebase-config.js` into `resources/www/` and asserts the copy
carries the PWA manifest link (i.e. it is the current file). It runs as part of
`npm run dist`. If you change the web app, re-run it before packaging.

## Window & UX decisions

- **430×900**, min 360×600, `backgroundColor #2a1a6e`, title *"Ludo with
  Friends"* — portrait, because the UI is mobile-first (§3.2.3, intentional).
- **Menu**: `null` in packaged builds (clean app-like window; the WM titlebar
  already exists). A minimal File/View/Window menu exists only under `npm start`
  so reload / DevTools stay reachable during development.
- **Single instance** (`app.requestSingleInstanceLock`, §3.3): a second launch
  exits immediately and the first window is focused/restored. Verified: second
  instance logs nothing and quits; first logs `second instance → focused existing window`.
- **No page injection**: the shell never calls `executeJavaScript` on the page.

## Security model

| Control | Value |
|---|---|
| `contextIsolation` | `true` |
| `nodeIntegration` | `false` |
| `sandbox` | `true` |
| Preload script | **none** — the renderer has zero privileged API surface, so there is no IPC contract to validate |
| `window.open` | denied (`setWindowOpenHandler`) |
| Navigation | allowlist: production origin, `localhost`/`127.0.0.1` (dev), and the app's own `file://` bundle; everything else (`data:`, other sites…) blocked in `will-navigate` |
| `<webview>` | attachment prevented |
| OS permission requests | denied except clipboard (lobby "Copy code" uses `navigator.clipboard.writeText`) |

The page itself ships its own CSP via the Vercel deployment; the shell does not
modify it (web build is canonical).

## Platform notes (read before distributing)

- **Arch**: x86_64 only (built on this machine). Cross-build other arches with
  `electron-builder --linux --arm64` on/arm hardware or their docker image.
- **glibc**: built on Ubuntu 24.04 (glibc 2.39). The bundled binaries' ELF
  version requirements top out at **glibc 2.17**, but Electron/Chromium policy is
  **glibc 2.31+** — practically: **Ubuntu 20.04+, Debian 11+, Fedora 32+,
  Mint 20.1+**. Also needs `libstdc++6` (present on every Debian/Ubuntu).
- **AppImage + FUSE**: running an AppImage needs FUSE. Ubuntu 22.04+/24.04 no
  longer ship it by default → `sudo apt install libfuse2t64` (or `libfuse2`),
  or run it FUSE-less: `./ludo-with-friends-1.0.0-x86_64.AppImage --appimage-extract-and-run`.
- **Sandbox**: uses Chromium's user-namespace sandbox (works on stock
  Ubuntu/Debian). On systems with unprivileged user namespaces disabled the app
  won't start — enable `kernel.unprivileged_userns_clone=1`; `--no-sandbox` is a
  last resort only.
- **Desktop integration**: the `.deb` installs
  `/usr/share/applications/ludo-with-friends.desktop` and a 512×512 hicolor
  icon. `StartupWMClass=ludo-with-friends` matches Electron's WM_CLASS
  (verified: `xprop WM_CLASS` → `"ludo-with-friends"`), so the taskbar pairs the
  window with the launcher icon on GNOME/KDE/XFCE.
- **Wayland/X11**: runs on both (Electron picks the platform default; XWayland
  under Wayland).

## Icon

`build/icon.png` (512×512 PNG, `#2a1a6e` + `#ffd166` ring + dice + LUDO
wordmark) is generated from `build/icon.html`:

```bash
NODE_PATH=<playwright-node_modules> node build/make-icon.cjs   # writes build/icon.png
```

electron-builder consumes it directly for both targets (the `.deb` gets
`hicolor/512x512`). Don't hand-edit the PNG; edit the HTML and re-render.

## Smoke test (headless-safe)

```bash
ELECTRON_ENABLE_LOGGING=1 npm start &        # dev run; watch for "[shell] did-finish-load →"
# force the offline fallback path:
electron . --host-resolver-rules="MAP ludo-vercel-rho.vercel.app ~NOTFOUND"
```

Expected: process stays alive, one `[shell] loading remote` line followed by
`did-finish-load` (remote) or the fallback sequence (forced offline). Always
kill the exact PID/PGID you spawned — the app holds a single-instance lock, so
orphaned runs will silently swallow the next launch.

## Layout

```
linux/
├── package.json        # scripts + electron-builder config ("build" field)
├── main.js             # the whole shell (~200 lines): window, nav allowlist,
│                       #   remote→local fallback, single-instance, permissions
├── build-www.mjs       # copies ../index.html + ../firebase-config.js → resources/www/
├── build/
│   ├── icon.html       # icon source (SVG)
│   ├── icon.png        # 512×512, rendered from icon.html
│   └── make-icon.cjs   # renderer (Playwright chromium)
├── resources/www/      # generated by build:www — offline fallback copy
└── dist/               # generated by npm run dist (git-ignore or discard)
```

No `preload.js` by design — see Security model.
