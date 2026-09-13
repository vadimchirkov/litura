#!/usr/bin/env node
/**
 * Smoke-test a built desktop app.
 *
 * Everything below the window has its own checks; this one asks the only
 * question a bundle can fail on its own: does the thing that was packaged
 * start, serve the draft it was pointed at, and stop when the window does.
 *
 *   node scripts/smoke-desktop.mjs [path/to/binary]
 *
 * Needs a display. On a headless Linux runner, put `xvfb-run -a` in front.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TARGET = path.join(ROOT, 'src-tauri', 'target');
const WINDOWS = process.platform === 'win32';
const READY_TIMEOUT = 90_000;
const EXIT_TIMEOUT = 15_000;

// Release output lands in target/release or target/<triple>/release depending
// on whether the build named a target.
function* releaseDirs() {
  for (const entry of fs.readdirSync(TARGET, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== 'debug') {
      yield entry.name === 'release' ? path.join(TARGET, 'release') : path.join(TARGET, entry.name, 'release');
    }
  }
}

// On macOS only the .app is complete: a bare binary has no Resources beside it
// and could not find the server it is supposed to start.
function findBinary() {
  for (const dir of releaseDirs()) {
    const candidates = process.platform === 'darwin'
      ? [path.join(dir, 'bundle/macos/Litura.app/Contents/MacOS/litura')]
      : [path.join(dir, WINDOWS ? 'litura.exe' : 'litura')];
    const found = candidates.find(candidate => fs.existsSync(candidate));
    if (found) return found;
  }
  throw new Error('No built desktop app found. Run `npm run desktop:build` first, or pass the binary path.');
}

const binary = process.argv[2] ? path.resolve(process.argv[2]) : findBinary();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'litura-smoke-'));
const workspace = path.join(temp, 'writing');
const draft = 'Smoke draft: a sentence the app must hand back.\n';
fs.mkdirSync(workspace);
fs.writeFileSync(path.join(workspace, 'draft.md'), draft);

// The app stores the chosen folder under the user's config directory. Moving
// HOME for this one process means the test never touches the folder the writer
// actually picked — and never meets a folder dialog either.
const configParent = process.platform === 'darwin' ? path.join(temp, 'Library', 'Application Support')
  : WINDOWS ? path.join(temp, 'AppData', 'Roaming')
  : path.join(temp, '.config');
const configDir = path.join(configParent, 'io.github.vadimchirkov.litura');
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(path.join(configDir, 'folder.txt'), workspace);

const app = spawn(binary, [], {
  env: { ...process.env, HOME: temp, XDG_CONFIG_HOME: path.join(temp, '.config'), APPDATA: path.join(temp, 'AppData', 'Roaming') },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
app.stdout.on('data', chunk => { output += chunk; });
app.stderr.on('data', chunk => { output += chunk; });

const fail = message => {
  app.kill('SIGKILL');
  fs.rmSync(temp, { recursive: true, force: true });
  console.error(`${message}\n\n--- app output ---\n${output}`);
  process.exit(1);
};

// `ready` outlives the promise: the app is killed on purpose further down, and
// without it that kill would be reported as a startup failure.
let ready = false;
const url = await new Promise(resolve => {
  const timer = setTimeout(() => fail(`No LITURA_READY line within ${READY_TIMEOUT / 1000}s.`), READY_TIMEOUT);
  const look = () => {
    const match = output.match(/^LITURA_READY (http:\/\/127\.0\.0\.1:\d+)$/m);
    if (!match) return;
    ready = true;
    clearTimeout(timer);
    resolve(match[1]);
  };
  app.stdout.on('data', look);
  app.once('exit', code => { if (!ready) { clearTimeout(timer); fail(`The app exited with ${code} before it was ready.`); } });
  look();
});

const port = Number(new URL(url).port);
const get = async route => (await fetch(url + route, { signal: AbortSignal.timeout(10_000) })).json();

try {
  const version = await get('/api/version');
  assert.equal(version.current, JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
  // The bundled build updates itself; if this ever says otherwise, the app is
  // about to offer an npm command to someone who installed a .dmg.
  assert.equal(version.managed, 'desktop');

  // Proves the whole chain: the shell passed the folder, the server resolved
  // the draft inside it, and its own resources came from the bundle.
  const document = await get('/draft');
  assert.equal(document.text, draft);
  assert.equal(document.path, fs.realpathSync(path.join(workspace, 'draft.md')));
} catch (error) {
  fail(`The running app answered wrongly: ${error.message}`);
}

// A crash, not a polite quit: the server has to go even when nothing asks it to.
app.kill('SIGKILL');

const reachable = () => new Promise(resolve => {
  const socket = net.connect({ port, host: '127.0.0.1' });
  socket.setTimeout(1000);
  socket.on('connect', () => { socket.destroy(); resolve(true); });
  socket.on('error', () => resolve(false));
  socket.on('timeout', () => { socket.destroy(); resolve(false); });
});

const deadline = Date.now() + EXIT_TIMEOUT;
while (await reachable()) {
  if (Date.now() > deadline) fail(`The server still holds port ${port} ${EXIT_TIMEOUT / 1000}s after the app was killed.`);
  await new Promise(resolve => setTimeout(resolve, 250));
}

fs.rmSync(temp, { recursive: true, force: true });
console.log(`Desktop smoke passed: ${path.relative(ROOT, binary)} served ${url} and released it with the window.`);
