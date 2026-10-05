// Copy the canonical web build into resources/www/ so the app has an offline
// fallback page (NATIVE-APPS-PLAN §3.1). COPY, never symlink, never edit —
// the repo-root index.html stays the single source of truth.
import { copyFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const outDir = path.join(here, 'resources', 'www');

const FILES = ['index.html', 'firebase-config.js'];

mkdirSync(outDir, { recursive: true });

for (const file of FILES) {
  const src = path.join(repoRoot, file);
  const dest = path.join(outDir, file);
  copyFileSync(src, dest);
  console.log(
    `[build:www] ${path.relative(repoRoot, src)} → ${path.relative(here, dest)} ` +
      `(${statSync(dest).size} bytes)`
  );
}

// Sanity: the copy must be the CURRENT index.html (PWA manifest link proves it)
// and firebase-config.js must sit beside it.
const copied = readFileSync(path.join(outDir, 'index.html'), 'utf8');
if (!copied.includes('<link rel="manifest"')) {
  console.error('[build:www] ERROR: copied index.html has no manifest link — stale copy?');
  process.exit(1);
}
console.log('[build:www] ok — manifest link present, firebase-config.js alongside');
