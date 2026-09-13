#!/usr/bin/env node
/**
 * Fetch the Node runtime the desktop build ships as its sidecar.
 *
 * The desktop app must not depend on a Node the writer installed themselves —
 * that is the reason it exists. So one official Node binary is downloaded,
 * checksummed against the release's own SHASUMS256.txt, and renamed to the
 * name Tauri expects for a sidecar: <name>-<target triple>.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = process.env.LITURA_NODE_VERSION || 'v24.21.0';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = path.join(ROOT, 'src-tauri', 'binaries');

// Node publishes one archive per platform-arch pair; Rust names the same thing
// as a target triple. Only the pairs a release is cut for are listed — an
// unmapped triple is a build that would silently ship no runtime.
const NODE_PLATFORM = {
  'aarch64-apple-darwin':       'darwin-arm64',
  'x86_64-apple-darwin':        'darwin-x64',
  'x86_64-unknown-linux-gnu':   'linux-x64',
  'aarch64-unknown-linux-gnu':  'linux-arm64',
  'x86_64-pc-windows-msvc':     'win-x64',
  'aarch64-pc-windows-msvc':    'win-arm64',
};

// Tauri sets the triple for its before-build hooks. Outside that, ask rustc,
// which is what Tauri itself would have asked.
function targetTriple() {
  if (process.env.TAURI_ENV_TARGET_TRIPLE) return process.env.TAURI_ENV_TARGET_TRIPLE;
  const host = execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host:\s*(\S+)$/m);
  if (!host) throw new Error('rustc did not report a host triple');
  return host[1];
}

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} → ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

const triple = targetTriple();
const platform = NODE_PLATFORM[triple];
if (!platform) throw new Error(`No Node build mapped for ${triple}. Add it to scripts/fetch-node.mjs.`);

const windows = platform.startsWith('win');
const target = path.join(OUT_DIR, `litura-server-${triple}${windows ? '.exe' : ''}`);
if (fs.existsSync(target) && !process.env.LITURA_NODE_FORCE) {
  console.log(`[node] ${path.basename(target)} is already here — delete it or set LITURA_NODE_FORCE=1 to refetch.`);
  process.exit(0);
}

const archive = `node-${VERSION}-${platform}.${windows ? 'zip' : 'tar.gz'}`;
const base = `https://nodejs.org/dist/${VERSION}`;
console.log(`[node] downloading ${archive}`);
const [blob, sums] = await Promise.all([
  download(`${base}/${archive}`),
  download(`${base}/SHASUMS256.txt`).then(buffer => buffer.toString('utf8')),
]);

// An unsigned binary pulled over the network and handed to every user of the
// app is exactly the thing worth checking, and the release signs a list of its
// own hashes. A missing entry is a failure, not a skip.
const expected = sums.split('\n').map(line => line.trim().split(/\s+/)).find(([, name]) => name === archive)?.[0];
if (!expected) throw new Error(`${archive} is not listed in SHASUMS256.txt`);
const actual = createHash('sha256').update(blob).digest('hex');
if (actual !== expected) throw new Error(`Checksum mismatch for ${archive}: ${actual} != ${expected}`);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'litura-node-'));
try {
  const archivePath = path.join(work, archive);
  fs.writeFileSync(archivePath, blob);
  // bsdtar reads both formats and ships with macOS, Linux, and Windows 10+.
  const member = windows
    ? `node-${VERSION}-${platform}/node.exe`
    : `node-${VERSION}-${platform}/bin/node`;
  execFileSync('tar', ['-xf', archivePath, '-C', work, member], { stdio: 'inherit' });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.copyFileSync(path.join(work, member), target);
  if (!windows) fs.chmodSync(target, 0o755);
  console.log(`[node] ${path.basename(target)} ✓`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
