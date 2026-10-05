#!/usr/bin/env node
/**
 * scripts/build-www.mjs
 *
 * Copies the canonical web build into www/ (Capacitor's webDir).
 * The web build stays canonical at the repo root — this is a copy step,
 * never a fork. Idempotent: safe to run any number of times.
 *
 * Files copied (from repo root → www/):
 *   index.html, firebase-config.js, manifest.webmanifest, sw.js, icons/**
 *
 * Usage: node scripts/build-www.mjs   (or: npm run build:www)
 */

import { cpSync, existsSync, mkdirSync, rmSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // repo root
const WWW = join(ROOT, 'www');

const FILES = [
  'index.html',
  'firebase-config.js',
  'manifest.webmanifest',
  'sw.js',
];

const DIRS = ['icons'];

function fail(msg) {
  console.error(`✗ build:www — ${msg}`);
  process.exit(1);
}

// 1. Verify sources exist before wiping www/ (never leave a half state).
const missing = [...FILES, ...DIRS].filter((p) => !existsSync(join(ROOT, p)));
if (missing.length) fail(`missing source(s): ${missing.join(', ')}`);

// 2. Fresh www/.
rmSync(WWW, { recursive: true, force: true });
mkdirSync(WWW, { recursive: true });

// 3. Copy.
for (const f of FILES) cpSync(join(ROOT, f), join(WWW, f));
for (const d of DIRS) cpSync(join(ROOT, d), join(WWW, d), { recursive: true });

// 4. Report + sanity checks.
const walk = (dir, base = '') =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name), `${base}${e.name}/`) : [`${base}${e.name}`]
  );

const copied = walk(WWW);
const indexHtml = join(WWW, 'index.html');
const size = statSync(indexHtml).size;

if (size < 10000) fail(`www/index.html suspiciously small (${size} bytes)`);

console.log(`✓ build:www — ${copied.length} file(s) → www/`);
for (const f of copied.sort()) console.log(`    ${f}`);
console.log(`  index.html: ${(size / 1024).toFixed(1)} KB`);
