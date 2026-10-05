'use strict';
// Ludo with Friends — Linux Electron shell (NATIVE-APPS-PLAN §3.1).
//
// Design: REMOTE-FIRST. The window loads the live production URL so Firebase
// Auth runs from a real https origin — file:// origins are rejected by
// Firebase (plan §3.2.1). If that load fails (offline / DNS dead), we fall
// back to the bundled copy in resources/www/, which still renders the UI with
// `db = null` and shows "Arcade offline — check your connection".
//
// Security posture: the renderer is a plain browser tab with delusions.
//   - contextIsolation: true, nodeIntegration: false, sandbox: true
//   - NO preload script → the page gets zero privileged API surface (there is
//     no IPC channel to validate because there is no IPC channel at all).
//   - window.open → denied; navigation → locked to our origin (plus the
//     bundled fallback files).
// The shell never injects script into the page.

const { app, BrowserWindow, Menu, dialog, session } = require('electron');
const path = require('path');

const REMOTE_URL = 'https://ludo-vercel-rho.vercel.app';
const REMOTE_ORIGIN = 'https://ludo-vercel-rho.vercel.app';
// Dev servers allowed during `npm start` against a local web build.
const DEV_ORIGINS = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]);
const FALLBACK_PAGE = path.join(__dirname, 'resources', 'www', 'index.html');
// Offline with a hanging resolver should not leave a forever-purple window:
// if the remote load is STILL in flight after this long, use the local copy.
const LOAD_WATCHDOG_MS = 20000;

let mainWindow = null;
let usedFallback = false;
let watchdog = null;

app.setName('Ludo with Friends');

function log(...args) {
  console.log('[shell]', ...args);
}

function stopWatchdog() {
  if (watchdog) {
    clearTimeout(watchdog);
    watchdog = null;
  }
}

// Navigation allowlist: our production origin, localhost (dev), and our own
// bundled fallback files. Everything else — data:, javascript:, other https
// sites — is blocked and never reaches the network.
function isAllowedNavigation(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol === 'https:' && u.origin === REMOTE_ORIGIN) return true;
  if (DEV_ORIGINS.has(u.origin)) return true;
  if (u.protocol === 'file:') {
    const root = path.resolve(__dirname);
    let p;
    try {
      p = decodeURIComponent(u.pathname);
    } catch {
      return false;
    }
    return p === root || p.startsWith(root + path.sep);
  }
  return false;
}

// Swap to the bundled copy exactly once (never on subframe failures, never on
// deliberate aborts like ERR_ABORTED).
function loadLocalFallback(reason) {
  if (usedFallback) return;
  usedFallback = true;
  stopWatchdog();
  log('remote load failed →', reason, '| falling back to bundled resources/www/');
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.loadFile(FALLBACK_PAGE).catch((err) => {
    // Nothing left to show — at least say so out loud instead of a dead window.
    log('bundled fallback failed:', err && err.message);
    dialog.showErrorBox(
      'Ludo with Friends',
      'Could not load the game.\n\n' +
        'The live version (https://ludo-vercel-rho.vercel.app) is unreachable and ' +
        'the bundled offline copy is missing.\n\n' +
        'Check your connection and try again.'
    );
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 430,
    height: 900,
    minWidth: 360,
    minHeight: 600,
    backgroundColor: '#2a1a6e',
    title: 'Ludo with Friends',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Deliberately no `preload`: the renderer needs no bridge, and with no
      // bridge there is no IPC surface to audit.
    },
  });

  const wc = mainWindow.webContents;

  // No stray tabs/windows: the app has no external links, so deny everything.
  wc.setWindowOpenHandler(() => {
    log('window.open denied');
    return { action: 'deny' };
  });
  // No <webview> either.
  wc.on('will-attach-webview', (event) => event.preventDefault());

  wc.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) {
      event.preventDefault();
      log('blocked navigation to', url);
    }
  });

  wc.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return; // subframe hiccups (ads, trackers) are not our problem
    if (errorCode === -3) return; // ERR_ABORTED — normal navigation churn
    log(`did-fail-load: ${errorCode} ${errorDescription} for ${validatedURL}`);
    if (usedFallback) return;
    loadLocalFallback(`${errorDescription} (${errorCode})`);
  });

  wc.on('did-finish-load', () => {
    stopWatchdog();
    log('did-finish-load →', wc.getURL());
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
    stopWatchdog();
  });

  log('loading remote →', REMOTE_URL);
  mainWindow.loadURL(REMOTE_URL);

  watchdog = setTimeout(() => {
    if (!usedFallback && mainWindow && !mainWindow.isDestroyed() && wc.isLoading()) {
      loadLocalFallback(`no response within ${LOAD_WATCHDOG_MS / 1000}s`);
    }
  }, LOAD_WATCHDOG_MS);
}

// Deny everything the page could ask the OS for, except clipboard: the lobby
// "Copy code" button uses navigator.clipboard.writeText (index.html line ~451).
// NOTE: session can only be touched after the app is ready.
function installPermissionPolicy() {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed =
      permission === 'clipboard-read' ||
      permission === 'clipboard-write' ||
      permission === 'clipboard-sanitized-write';
    if (!allowed) log('denied permission request:', permission);
    callback(allowed);
  });
}

// Menu: null in packaged builds (clean, app-like window — Linux users get the
// WM titlebar anyway; no redundant File/Edit bar over a phone-shaped game).
// In dev (`npm start`) keep a minimal menu so reload / DevTools stay reachable.
function installMenu() {
  if (app.isPackaged) {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([{ role: 'fileMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }])
  );
}

// §3.3: second launch focuses the first instance instead of opening a twin.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      log('second instance → focused existing window');
    }
  });

  app.whenReady().then(() => {
    installPermissionPolicy();
    installMenu();
    createWindow();
  });
}
