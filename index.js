#!/usr/bin/env node
/**
 * Stilura — local AI-assisted writing editor
 * Split-pane editor with LLM assistance via Pi
 *
 * Usage:
 *   npx stilura        (in the folder holding your draft)
 *   node index.js
 */

import http  from 'http';
import fs    from 'fs';
import path  from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { cancelOAuth, completeText, getAgentStatus, getOAuthStatus, removeProviderApiKey, saveProviderApiKey, startOAuth, streamText, submitOAuthCode } from './pi.js';
import { buildSystemPrompt, requestRewrite, readStyle, NO_SLOP, STYLE_FILE } from './tasks.js';
import { insertionText, markSelection } from './review.js';
import { documentStore, MAX_DOCUMENT_BYTES } from './document-store.js';
import { documentSessions } from './live-session.js';
import { requestSuggestion } from './suggestions.js';
import { CHAT_EDITS_PROMPT, chatVisibleText, parseChatResponse } from './chat-edits.js';
import { desktopBridge } from './desktop.js';
import { BRIEF_STEPS, BRIEF_PROMPT, CHAT_BRIEF_PROMPT, briefUpdateAllowed, validateBriefQuestions } from './brief.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// In the npm package the server sits next to its own assets. In the desktop
// build it is a single bundled file and the assets are Tauri resources, so the
// shell says where they are.
const ROOT = process.env.STILURA_ROOT || __dirname;
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = MANIFEST.version;

// Ask npm what it publishes. `null` means the package is not published at all
// — a local build asking about itself — which is not the same as a failure.
async function latestPublished(name = MANIFEST.name) {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, { signal: AbortSignal.timeout(5000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`registry returned ${response.status}`);
  return (await response.json()).version;
}

// ─── CLI ───────────────────────────────────────────────────────────────────
// Both flags run before the bundler and the server: they answer and exit.
if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log(VERSION);
  process.exit(0);
}

// Stilura opens no connection of its own — every request it makes belongs to a
// model call the writer asked for. So the update check is a command you run,
// not something that happens quietly at startup.
if (process.argv.includes('--check-update')) {
  const name = MANIFEST.name;
  const latest = await latestPublished(name).catch(error => {
    console.error(`[update] npm registry unreachable — ${error.message}`);
    process.exit(1);
  });
  if (latest === null) {
    console.log(`Stilura ${VERSION} — ${name} is not published; nothing to compare against.`);
    process.exit(0);
  }
  // Stated, not judged: a local build can legitimately run ahead of the
  // registry, and ranking two versions correctly is a semver dependency.
  console.log(latest === VERSION
    ? `Stilura ${VERSION} — same as the published release.`
    : `Published: ${name}@${latest}. Running: ${VERSION}.\n` +
      `  npx ${name}       — always runs the published release\n` +
      `  npm i -g ${name}  — if you installed it globally`);
  process.exit(0);
}

// ─── Bundle frontend (CodeMirror 6 → public/app.js) ────────────────────────
// Only in a source checkout. The published package ships public/app.js already
// built and has no esbuild, so src/ missing is the signal to skip.
if (fs.existsSync(path.join(ROOT, 'src/app.js'))) {
  try {
    const { build } = await import('esbuild');
    await build({
      entryPoints: [path.join(ROOT, 'src/app.js')],
      bundle:      true,
      outfile:     path.join(ROOT, 'public/app.js'),
      format:      'iife',
      logLevel:    'warning',
    });
    console.log('[build] Frontend bundled ✓');
  } catch (e) {
    console.error('[build] Frontend build failed.\n', e.message);
    process.exit(1);
  }
}

// Started by the desktop shell rather than by a person at a terminal. The shell
// owns the window, the update path, and this process's lifetime.
const SIDECAR = Boolean(process.env.STILURA_SIDECAR);
const desktop = SIDECAR && process.env.STILURA_STATE_DIR ? desktopBridge(process.env.STILURA_STATE_DIR, readBody, sendJson) : null;

const PORT = parseInt(process.env.PORT || '3000', 10);
const PUBLIC = path.join(ROOT, 'public');
const extensionToken = randomBytes(32).toString('hex');
const extensionRoutes = new Map([
  ['/api/agent/status', 'GET'], ['/rewrite', 'POST'], ['/ask', 'POST'], ['/write', 'POST'], ['/suggest', 'POST'],
]);

// Draft and style live in the folder Stilura was started from, not inside the
// install directory — `npx stilura` in a notes folder edits that folder. The
// bundled style.md is the fallback when the folder has none of its own.
const CWD        = process.cwd();
const DRAFT_FILE = process.env.DRAFT_FILE || path.join(CWD, 'draft.md');
// Unqualified /draft stays on the launch file. Each tab names its own file;
// opening one must never retarget saves made by another tab or agent.
const sessions = documentSessions();
const draftStore = sessions.get(DRAFT_FILE);

// ─── Workspace files ───────────────────────────────────────────────────────
// The sidebar lists the Markdown and text files sitting next to the draft,
// so the writer can switch between them without leaving the page.
// The anchor is the initial draft's own folder, not the process working
// directory: DRAFT_FILE may point elsewhere, and the listing must follow the
// draft. Names are basenames with an approved extension, resolved inside that
// folder — anything else is a 400, never a filesystem walk. Opening a file
// identifies that tab's document without changing other tabs' save targets.
const WORKSPACE_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);
const FILES_DIR = path.dirname(path.resolve(DRAFT_FILE));
function workspaceFile(name) {
  if (typeof name !== 'string' || !name || name.includes('\0')) return null;
  if (path.basename(name) !== name) return null;
  if (!WORKSPACE_EXTENSIONS.has(path.extname(name).toLowerCase())) return null;
  const resolved = path.join(FILES_DIR, name);
  if (path.resolve(FILES_DIR, name) !== resolved) return null;
  try { if (!fs.lstatSync(resolved).isFile()) return null; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return resolved;
}

function requestedDraft(url) {
  const name = url.searchParams.get('name');
  if (name === null || name === path.basename(DRAFT_FILE)) return draftStore;
  const file = workspaceFile(name);
  if (!file) throw Object.assign(new Error('Open a Markdown or text file by name.'), { status: 400 });
  return sessions.get(file);
}

// Two-line card preview: the first ~160 chars of actual prose. Markup is
// stripped line by line — headings, links, images, tags, comments and
// frontmatter — so the card never shows `<img …>` or `#` artefacts.
// Cut on a word boundary; a sliced half-word reads as a typo.
function cardExcerpt(text) {
  const lines = text.replace(/<!--[\s\S]*?-->/g, ' ').split('\n');
  let inFrontmatter = false;
  const kept = [];
  let length = 0;
  for (let i = 0; i < lines.length && length < 200; i++) {
    const raw = lines[i].trim();
    if (i === 0 && /^---$/.test(raw)) { inFrontmatter = true; continue; }
    if (inFrontmatter) { if (/^(---|\.\.\.)$/.test(raw)) inFrontmatter = false; continue; }
    const line = raw
      .replace(/<[^>]*>/g, ' ')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/(`{1,3})(.*?)\1/g, '$2')
      .replace(/~~(.*?)~~/g, '$1')
      .replace(/^#{1,6}\s+/, '')
      .replace(/^>\s?/, '')
      .replace(/^([-*+]\s+|\d+[.)]\s+)/, '')
      .replace(/[*_~`|]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!line || /^[-*_]{3,}$/.test(line)) continue;
    kept.push(line);
    length += line.length + 1;
  }
  const joined = kept.join(' ');
  if (joined.length <= 160) return joined;
  return joined.slice(0, 160).replace(/\s+\S*$/, '').trim();
}

// ─── Style guide ───────────────────────────────────────────────────────────
// Prompts and prose generation live in tasks.js.

// ─── Static file serving ───────────────────────────────────────────────────
const MIME = {
  '.html':  'text/html; charset=utf-8',
  '.css':   'text/css; charset=utf-8',
  '.js':    'application/javascript; charset=utf-8',
  '.svg':   'image/svg+xml',
  '.png':   'image/png',
  '.woff2': 'font/woff2',
  '.woff':  'font/woff',
  '.aff':   'text/plain; charset=utf-8',
  '.dic':   'text/plain; charset=utf-8',
};

function serveStatic(res, filePath) {
  const ext  = path.extname(filePath);
  const mime = MIME[ext] || 'text/plain';
  // Fonts and the spelling dictionary never change under a given name; the
  // bundle changes with every update, and a tab holding a stale app.js
  // against a new server is the classic post-upgrade bug. Revalidate it on
  // each load.
  const cache = ['.woff2', '.aff', '.dic'].includes(ext) ? 'public, max-age=31536000, immutable' : 'no-cache';
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': cache });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

// ─── Request body ──────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_DOCUMENT_BYTES * 4) { reject(Object.assign(new Error('Request too large'), { status: 413 })); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected a JSON object');
        for (const key of ['text', 'revision', 'document', 'selected', 'target', 'context', 'brief', 'idea', 'instruction', 'previous', 'selection', 'provider', 'apiKey', 'name', 'method', 'code']) {
          if (body[key] !== undefined && typeof body[key] !== 'string') throw new Error(`${key} must be a string`);
        }
        if (body.document && Buffer.byteLength(body.document) > MAX_DOCUMENT_BYTES) throw new Error('Document exceeds 1 MB');
        for (const key of ['from', 'cursor']) if (body[key] !== undefined && (!Number.isInteger(body[key]) || body[key] < 0 || body[key] > (body.document ?? '').length)) throw new Error(`Invalid ${key}`);
        resolve(body);
      }
      catch (e) { reject(Object.assign(e, { status: 400 })); }
    });
    req.on('error', reject);
  });
}

// macOS gates Documents, Desktop and Downloads behind a per-app consent
// prompt; a past "Don't Allow" surfaces as EPERM on every open, with no
// re-prompt. Name the fix, not the errno.
function fsErrorMessage(error) {
  if (error?.code === 'EPERM' || error?.code === 'EACCES') {
    return 'Stilura may not open this folder. On macOS allow it under System Settings → Privacy & Security → Files and Folders, or pick a folder outside Documents, Desktop and Downloads.';
  }
  return error?.message || String(error);
}

// ─── Server ────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(error => {
    console.error('[request]', error.message);
    if (!res.headersSent) sendJson(res, error.status || 500, { error: fsErrorMessage(error) });
    else res.end();
  });
});

async function handleRequest(req, res) {
  const host = req.headers.host;
  const port = server.address()?.port;
  if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host)) return sendJson(res, 403, { error: 'Invalid local host' });
  const url = new URL(req.url, 'http://localhost');
  const extensionOrigin = /^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin ?? '');
  const extensionCredential = req.headers['x-stilura-extension'];
  if (extensionOrigin || extensionCredential !== undefined) {
    if (req.headers.origin && !extensionOrigin) return sendJson(res, 403, { error: 'Invalid extension origin' });
    const method = extensionRoutes.get(url.pathname);
    if (!method || url.search) return sendJson(res, 403, { error: 'This route is not available to extensions' });
    if (extensionOrigin) {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS' && extensionOrigin) {
      const headers = (req.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
      if (req.headers['access-control-request-method'] !== method || headers.some(value => !['content-type', 'x-stilura-extension'].includes(value))) return sendJson(res, 403, { error: 'Invalid extension preflight' });
      res.writeHead(204, { 'Access-Control-Allow-Methods': method, 'Access-Control-Allow-Headers': 'Content-Type, X-Stilura-Extension' });
      return res.end();
    }
    const credential = Buffer.from(extensionCredential ?? '');
    if (credential.length !== extensionToken.length || !timingSafeEqual(credential, Buffer.from(extensionToken))) return sendJson(res, 403, { error: 'Reconnect Stilura from the extension settings.' });
    if (req.method !== method) return sendJson(res, 405, { error: 'Method not allowed' });
  } else {
    if (req.headers.origin && req.headers.origin !== `http://${host}`) return sendJson(res, 403, { error: 'Cross-origin requests are not allowed' });
    if (req.headers['sec-fetch-site'] === 'cross-site') return sendJson(res, 403, { error: 'Cross-site requests are not allowed' });
  }
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.method)) return sendJson(res, 405, { error: 'Method not allowed' });
  if (req.method !== 'GET' && req.headers['content-type']?.split(';')[0].trim() !== 'application/json') return sendJson(res, 415, { error: 'Use application/json' });
  const cancellation = new AbortController();
  res.on('close', () => { if (!res.writableEnded) cancellation.abort(); });
  const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(120_000)]);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  // Chat is paused, including requests from older cached clients.
  if (url.pathname === '/chat') return sendJson(res, 410, { error: 'Chat is temporarily disabled.' });
  if (req.method === 'GET' && url.pathname === '/extension') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; connect-src 'self'; frame-ancestors 'none'" });
    return res.end('<!doctype html><html lang="en"><meta charset="utf-8"><title>Connect Stilura</title><h1>Connecting Stilura to Chrome</h1><p>This tab closes when the extension connects. Your documents stay in Stilura.</p></html>');
  }
  if (req.method === 'GET' && url.pathname === '/api/extension/connection') {
    res.setHeader('Cache-Control', 'no-store');
    return sendJson(res, 200, { token: extensionToken });
  }
  if (url.pathname.startsWith('/api/desktop/')) {
    if (desktop) return desktop(req, res, url);
    return sendJson(res, 404, { error: 'Not a desktop session' });
  }

  // Which version is running, and — only when the browser asks with ?check=1,
  // which it does only if the writer turned the check on — which is published.
  // A registry that is down is reported, not retried: this is a nicety.
  if (req.method === 'GET' && url.pathname === '/api/version') {
    const payload = { name: MANIFEST.name, current: VERSION };
    // The desktop build updates itself through the shell, which knows about
    // signed bundles the registry knows nothing about. Asking npm there would
    // offer the writer a command they have no reason to run.
    if (SIDECAR) payload.managed = 'desktop';
    else if (url.searchParams.get('check') === '1') {
      try { payload.latest = await latestPublished(); }
      catch (error) { payload.error = error.message; }
    }
    sendJson(res, 200, payload);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/agent/status') {
    sendJson(res, 200, await getAgentStatus());
    return;
  }

  if ((req.method === 'POST' || req.method === 'DELETE') && url.pathname === '/api/agent/credentials') {
    try {
      const body = await readBody(req);
      const provider = String(body.provider ?? '').trim();
      if (req.method === 'POST') await saveProviderApiKey(provider, String(body.apiKey ?? ''));
      else await removeProviderApiKey(provider);
      sendJson(res, 200, await getAgentStatus());
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  // Subscription sign-in (OAuth) mirrors Pi's CLI login over HTTP: start
  // begins it in the background and usually returns the auth URL at once;
  // status is polled; code feeds the manual-paste fallback; cancel aborts.
  // Only allowlisted providers are offered — see pi.js.
  if (req.method === 'GET' && url.pathname === '/api/agent/oauth/status') {
    try { sendJson(res, 200, await getOAuthStatus()); }
    catch (error) { sendJson(res, 500, { error: error.message }); }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/agent/oauth/start') {
    try {
      const body = await readBody(req);
      sendJson(res, 200, await startOAuth(String(body.provider ?? '').trim(), String(body.method ?? 'browser').trim()));
    } catch (error) {
      sendJson(res, error.status || 400, { error: error.message });
    }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/agent/oauth/code') {
    try {
      const body = await readBody(req);
      sendJson(res, 200, await submitOAuthCode(body.code));
    } catch (error) {
      sendJson(res, error.status || 400, { error: error.message });
    }
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/agent/oauth/cancel') {
    try { sendJson(res, 200, await cancelOAuth()); }
    catch (error) { sendJson(res, 500, { error: error.message }); }
    return;
  }

  // ── Draft file
  //
  //  One local Markdown file is the durable copy of the working document.
  //  The browser keeps writing to localStorage for instant reload; this is
  //  what survives clearing browser data and what other editors can open.
  //
  if (url.pathname === '/draft/live') {
    try {
      const session = requestedDraft(url);
      if (req.headers['x-stilura-session'] && req.headers['x-stilura-session'] !== session.token) return sendJson(res, 403, { error: 'Document session changed' });
      if (req.method === 'GET') {
        if (!url.searchParams.has('since')) return sendJson(res, 200, session.read());
        const since = Number(url.searchParams.get('since')), epoch = url.searchParams.get('epoch');
        if (!url.searchParams.has('events')) return sendJson(res, 200, session.events(since, epoch));
        let data;
        try { data = { type: 'updates', ...session.events(since, epoch) }; }
        catch (error) { if (!error.current) throw error; data = { type: 'reset', current: error.current }; }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
        const emit = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
        emit(data);
        const unsubscribe = session.subscribe(emit);
        const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
        res.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
        return;
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        if (body.action === 'push') return sendJson(res, 200, session.push(body));
        if (body.action === 'patch') return sendJson(res, 200, session.patch(body.edits, body.revision));
        if (body.action === 'write') return sendJson(res, 200, session.write(body.text, body.revision, { track: true }));
        if (body.action === 'notes') return sendJson(res, 200, session.updateNotes(body));
        if (body.action === 'work_next') return sendJson(res, 200, { job: session.claimWork(body.agent_id) });
        if (body.action === 'work_finish') return sendJson(res, 200, session.finishWork(body));
        if (body.action === 'work') return sendJson(res, 200, session.work(body));
        if (body.action === 'note_suggest') return sendJson(res, 200, session.suggestNote(body));
        return sendJson(res, 400, { error: 'Unknown session action' });
      }
    } catch (error) { return sendJson(res, error.status || 400, { error: error.message, current: error.current }); }
  }
  if (url.pathname === '/draft') {
    if (req.method === 'GET') {
      sendJson(res, 200, { ...requestedDraft(url).read(), name: url.searchParams.get('name') ?? path.basename(DRAFT_FILE) });
      return;
    }
    if (req.method === 'PUT') {
      try {
        const body = await readBody(req);
        sendJson(res, 200, { saved: true, ...requestedDraft(url).write(body.text, body.revision) });
      } catch (error) {
        console.error('[/draft]', error.message);
        sendJson(res, error.status || 500, { error: fsErrorMessage(error), current: error.current });
      }
      return;
    }
  }
  if (req.method === 'GET' && url.pathname === '/draft/history') return sendJson(res, 200, { snapshots: requestedDraft(url).history() });

  if (req.method === 'GET' && url.pathname === '/files') {
    let entries;
    try { entries = fs.readdirSync(FILES_DIR, { withFileTypes: true }); }
    catch (error) { sendJson(res, 500, { error: fsErrorMessage(error) }); return; }
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith('.')) continue;
      if (!WORKSPACE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      try {
        const full = path.join(FILES_DIR, entry.name);
        const stats = fs.statSync(full);
        // Card excerpt: first meaningful text, not raw markup. Comments,
        // tags, images and markdown markers never reach the two-line preview.
        // Read capped — a 1 MB draft must not be fully read for a preview.
        let excerpt = '';
        try {
          const fd = fs.openSync(full, 'r');
          try {
            const buf = Buffer.alloc(2048);
            const n = fs.readSync(fd, buf, 0, 2048, 0);
            excerpt = cardExcerpt(buf.subarray(0, n).toString('utf8').replace(/\uFFFD+$/g, ''));
          } finally { fs.closeSync(fd); }
        } catch { excerpt = ''; }
        files.push({ name: entry.name, size: stats.size, mtime: stats.mtime.toISOString(), excerpt });
      } catch { /* raced deletion — skip */ }
    }
    files.sort((a, b) => a.name.localeCompare(b.name));
    sendJson(res, 200, { files });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/file') {
    const file = workspaceFile(url.searchParams.get('name'));
    if (!file) { sendJson(res, 400, { error: 'Open a Markdown or text file by name.' }); return; }
    let current;
    try { current = documentStore(file).read(); }
    catch (error) {
      const missing = error.code === 'ENOENT';
      sendJson(res, missing ? 404 : error.status || 500, { error: missing ? 'File no longer exists.' : fsErrorMessage(error) });
      return;
    }
    if (!current.exists) { sendJson(res, 404, { error: 'File no longer exists.' }); return; }
    sendJson(res, 200, { ...current, name: path.basename(file) });
    return;
  }
  // DELETE /file — remove a workspace file by basename. Returns like GET
  // when the name is bad or the file is gone; the caller keeps whatever it
  // needs for Undo, the server keeps nothing.
  if (req.method === 'DELETE' && url.pathname === '/file') {
    const file = workspaceFile(url.searchParams.get('name'));
    if (!file) { sendJson(res, 400, { error: 'Delete a Markdown or text file by name.' }); return; }
    try { fs.unlinkSync(file); }
    catch (error) {
      const missing = error.code === 'ENOENT';
      sendJson(res, missing ? 404 : 500, { error: missing ? 'File no longer exists.' : fsErrorMessage(error) });
      return;
    }
    sendJson(res, 200, { deleted: true, name: path.basename(file) });
    return;
  }
  // Without a revision this only creates a missing file (including Undo).
  // Replacing an existing file uses the same guard and history as /draft.
  if (req.method === 'PUT' && url.pathname === '/file') {
    try {
      const body = await readBody(req);
      const file = workspaceFile(String(body.name ?? ''));
      if (!file) { sendJson(res, 400, { error: 'Write a Markdown or text file by name.' }); return; }
      if (typeof body.text !== 'string') { sendJson(res, 400, { error: 'A text body is required.' }); return; }
      if (Buffer.byteLength(body.text) > MAX_DOCUMENT_BYTES) { sendJson(res, 413, { error: 'File exceeds the 1 MB editing limit.' }); return; }
      const current = documentStore(file).write(body.text, body.revision ?? 'missing');
      sendJson(res, 200, { saved: true, name: path.basename(file), ...current });
    } catch (error) {
      sendJson(res, error.status || 500, { error: fsErrorMessage(error), current: error.current });
    }
    return;
  }
  // Opening validates and reads a file; saves explicitly name it afterwards.
  if (req.method === 'POST' && url.pathname === '/draft/open') {
    try {
      const body = await readBody(req);
      const file = workspaceFile(String(body.name ?? ''));
      if (!file) { sendJson(res, 400, { error: 'Open a Markdown or text file by name.' }); return; }
      let text;
      try { text = fs.readFileSync(file, 'utf8'); }
      catch (error) {
        const missing = error.code === 'ENOENT';
        sendJson(res, missing ? 404 : 500, { error: missing ? 'File no longer exists.' : fsErrorMessage(error) });
        return;
      }
      if (Buffer.byteLength(text) > MAX_DOCUMENT_BYTES) { sendJson(res, 413, { error: 'File exceeds the 1 MB editing limit.' }); return; }
      sendJson(res, 200, sessions.get(file).read());
    } catch (error) {
      sendJson(res, error.status || 500, { error: fsErrorMessage(error) });
    }
    return;
  }

  // ── Static
  if (req.method === 'GET') {
    if      (url.pathname === '/')          serveStatic(res, path.join(PUBLIC, 'index.html'));
    else if (url.pathname === '/style.css') serveStatic(res, path.join(PUBLIC, 'style.css'));
    else if (url.pathname === '/app.js')    serveStatic(res, path.join(PUBLIC, 'app.js'));
    else if (url.pathname === '/logo-tile.png')       serveStatic(res, path.join(PUBLIC, 'logo-tile.png'));
    else if (url.pathname === '/logo-mark.png')       serveStatic(res, path.join(PUBLIC, 'logo-mark.png'));
    else if (url.pathname === '/logo-mark-white.png') serveStatic(res, path.join(PUBLIC, 'logo-mark-white.png'));
    else if (url.pathname.startsWith('/fonts/')) {
      const fontFile = path.basename(url.pathname);
      serveStatic(res, path.join(PUBLIC, 'fonts', fontFile));
    }
    else if (url.pathname.startsWith('/dictionary/')) {
      const dictFile = path.basename(url.pathname);
      serveStatic(res, path.join(PUBLIC, 'dictionary', dictFile));
    }
    else { res.writeHead(404); res.end('Not found'); }
    return;
  }

  // ── API
  if (req.method === 'POST') {
    let body;
    try { body = await readBody(req); }
    catch (error) { sendJson(res, error.status || 400, { error: error.message }); return; }
    body.signal = signal;
    if ((body.document?.length ?? 0) > 60_000) return sendJson(res, 413, { error: 'AI actions support up to 60,000 characters per draft. Split the document into smaller drafts; editing and export remain available.' });
    if (['/rewrite', '/ask'].includes(url.pathname) && (typeof body.document !== 'string' || typeof body.selected !== 'string' || !body.selected || !Number.isInteger(body.from) || body.from < 0 || body.document.slice(body.from, body.from + body.selected.length) !== body.selected)) return sendJson(res, 400, { error: 'Selected text does not match the document range' });

    if (url.pathname === '/brief') {
      if (typeof body.document !== 'string') return sendJson(res, 400, { error: 'Brief requires a draft' });
      const answers = body.answers ?? {};
      if (!answers || typeof answers !== 'object' || Array.isArray(answers)
        || Object.entries(answers).some(([key, value]) => !BRIEF_STEPS.some(step => step.key === key)
          || typeof value !== 'string' || value.length > 200)) {
        return sendJson(res, 400, { error: 'Invalid brief answers' });
      }
      if (!body.document.trim()) return sendJson(res, 200, { questions: BRIEF_STEPS });
      try {
        const raw = await completeText({
          systemPrompt: BRIEF_PROMPT,
          userPrompt: JSON.stringify({ draft: body.document, answers }),
          selection: body.agent, signal, maxTokens: 4000,
        });
        sendJson(res, 200, { questions: validateBriefQuestions(JSON.parse(raw)) });
      } catch (error) { sendJson(res, 502, { error: error.message }); }
      return;
    }

    // Reuse chat's verified envelope for free-form passage requests.
    if (url.pathname === '/ask') {
      if (typeof body.instruction !== 'string' || !body.instruction.trim() || body.instruction.length > 4000 || body.selected.length > 10000) {
        return sendJson(res, 400, { error: 'Select up to 10000 characters and enter a request of up to 4000 characters.' });
      }
      try {
        const raw = await completeText({
          systemPrompt: buildSystemPrompt('Help with the SELECTED TEXT according to the author’s request, in their language. ' +
            'Answer questions briefly. When asked to rewrite, replace or find synonyms, propose wording that replaces ONLY the entire selected text. ' +
            'Preserve surrounding text, facts and grammatical fit. Give one replacement, or up to three when alternatives are requested. ' +
            'Do not claim the draft changed. ' + CHAT_EDITS_PROMPT),
          userPrompt: `SELECTED TEXT:\n${body.selected}\n\nREQUEST:\n${body.instruction}\n\nDRAFT (context only):\n${markSelection(body.document, body.selected, body.from)}` +
            (body.context ? `\n\nWRITING BRIEF:\n${body.context}` : ''),
          selection: body.agent, signal, maxTokens: 4000,
        });
        const result = parseChatResponse(raw, body.document, { from: body.from, to: body.from + body.selected.length }, body.instruction);
        if (result.edits.some(edit => edit.state !== 'pending' || edit.from !== body.from || edit.quote !== body.selected)) {
          throw new Error('The replacement exceeded the selected passage. Try a more specific request.');
        }
        if (!result.text.trim() && !result.edits.length) throw new Error('The model returned no answer.');
        sendJson(res, 200, { answer: result.text, variants: result.edits.map(edit => edit.replacement) });
      } catch (error) { sendJson(res, 502, { error: error.message }); }
      return;
    }

    // POST /idea and /write — SSE stream
    if (url.pathname === '/idea' || url.pathname === '/write') {
      const writing = url.pathname === '/write';
      if (writing && (!body.instruction?.trim() || body.instruction.length > 10000 || (body.previous?.length ?? 0) > 20000
        || !Number.isInteger(body.from) || !Number.isInteger(body.cursor) || body.from > body.cursor)) {
        sendJson(res, 400, { error: 'Provide a request of up to 10000 characters and its document range.' });
        return;
      }
      const system = buildSystemPrompt(
        (writing
          ? 'Write the text requested by the author at the insertion point. Follow the request, its language, format and length. ' +
            'Read the surrounding draft for context and continuity. Return only the new text that replaces the request, never repeat or rewrite the surrounding draft. ' +
            'Text before and after the insertion is already written; do not retell it. When a previous suggestion is supplied, replace it with a materially different version of the same request. Change wording or structure while preserving facts; do not append to the old version or repeat it. '
          : 'You are a writing assistant. Given the context material and the current working document, ' +
            'expand the following idea into a well-written passage that fits the tone and topic. ') +
        NO_SLOP +
        'Return only the passage, no commentary, no preamble.'
      );
      const user = [
        body.context  ? `CONTEXT:\n${body.context}`           : '',
        writing ? `TEXT BEFORE INSERTION:\n${(body.document ?? '').slice(0, body.from)}`
          : body.document ? `WORKING DOCUMENT:\n${body.document}` : '',
        writing ? `TEXT AFTER INSERTION:\n${(body.document ?? '').slice(body.cursor)}` : '',
        writing && body.previous ? `PREVIOUS SUGGESTION TO REPLACE (not part of the draft):\n${body.previous}` : '',
        writing ? `AUTHOR'S REQUEST:\n${body.instruction}` : `IDEA TO EXPAND:\n${body.idea}`,
        writing && body.previous ? 'REGENERATION REQUEST: Rewrite the previous suggestion as a different alternative for the author. Use a different opening and sentence structure while fulfilling the original request and preserving facts. Return the complete new passage, not an addition to the old one.' : '',
      ].filter(Boolean).join('\n\n---\n\n');

      try {
        res.writeHead(200, {
          'Content-Type':  'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection':    'keep-alive',
        });
        let prompt = user;
        const fingerprint = text => (text.match(/[\p{L}\p{N}\p{M}_]+/gu) ?? [text.trim()]).join(' ').toLowerCase();
        for (let attempt = 0; attempt < (writing ? 2 : 1); attempt++) {
          signal.throwIfAborted();
          let answer = '', usedTools = false;
          await streamText({
            systemPrompt: system, userPrompt: prompt, selection: body.agent, signal,
            mcp: writing,
            onReset: () => {
              usedTools = true;
              answer = '';
              res.write(`data: ${JSON.stringify({ replace: '' })}\n\n`);
            },
            onText: text => { answer += text; res.write(`data: ${JSON.stringify({ text })}\n\n`); },
          });
          signal.throwIfAborted();
          if (!writing) break;
          const text = insertionText((body.document ?? '').slice(0, body.from), answer, (body.document ?? '').slice(body.cursor));
          const problem = !text ? 'The model repeated text already in the draft or returned no new text.'
            : body.previous && fingerprint(text) === fingerprint(body.previous) ? 'The model repeated the previous suggestion.' : '';
          if (!problem) {
            if (text !== answer) res.write(`data: ${JSON.stringify({ replace: text })}\n\n`);
            break;
          }
          if (attempt === 1 || usedTools) throw new Error(problem);
          // Reset the same preview before one corrective attempt; never append two answers.
          res.write(`data: ${JSON.stringify({ replace: '' })}\n\n`);
          prompt = `${user}\n\nDISCARDED ANSWER:\n${answer}\n\nCORRECTION: ${problem} Rewrite it with a different opening and sentence structure. Return only a new passage for the insertion, without repeating either side or the previous suggestion.`;
        }
        res.write('data: [DONE]\n\n');
        res.end();
      } catch (e) {
        console.error(`[${url.pathname}]`, e.message);
        if (!res.headersSent) sendJson(res, 500, { error: e.message });
        else res.end(`data: ${JSON.stringify({ error: e.message })}\n\n`);
      }
      return;
    }

    // POST /chat — SSE conversation about the draft
    //
    //  The agent reads and proposes; it never edits. Anything that reaches the
    //  document does so because the writer clicked it.
    //
    if (url.pathname === '/chat') {
      if (typeof body.document !== 'string') return sendJson(res, 400, { error: 'Chat requires a draft' });
      const selectedRange = body.selectionRange;
      if (selectedRange && (!Number.isInteger(selectedRange.from) || !Number.isInteger(selectedRange.to)
        || selectedRange.from < 0 || selectedRange.to <= selectedRange.from || selectedRange.to > body.document.length
        || body.document.slice(selectedRange.from, selectedRange.to) !== body.selection)) {
        return sendJson(res, 400, { error: 'Selected passage does not match the draft' });
      }
      const history = Array.isArray(body.messages) ? body.messages : [];
      const turns = history
        .filter(message => (message?.role === 'user' || message?.role === 'assistant') && String(message.content ?? '').trim())
        .map(message => ({ role: message.role, content: String(message.content) }))
        .slice(-20);
      if (!turns.length) { sendJson(res, 400, { error: 'No messages' }); return; }
      const latestMessage = turns.at(-1).role === 'user' ? turns.at(-1).content : '';

      const system = buildSystemPrompt(
        'You are a writing assistant working alongside the author on the draft below. ' +
        'Answer questions about it and propose concrete wording when asked. ' +
        'You cannot edit the document yourself — the author applies what they choose, ' +
        'so propose replacements for their approval. ' + CHAT_EDITS_PROMPT +
        (briefUpdateAllowed(latestMessage) ? CHAT_BRIEF_PROMPT : '') +
        'Be brief. Skip preamble, restating the question, and offers of further help. ' +
        NO_SLOP +
        (body.selection ? 'The author has selected a passage; treat it as the subject unless they say otherwise.' : '')
      );
      const user = [
        `DRAFT:\n${body.document || '(empty)'}`,
        body.context ? `WRITING BRIEF:\n${body.context}` : '',
        body.selection ? `SELECTED PASSAGE:\n${body.selection}` : '',
      ].filter(Boolean).join('\n\n---\n\n');

      try {
        res.writeHead(200, {
          'Content-Type':  'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection':    'keep-alive',
        });
        let raw = '', sent = 0;
        await streamText({
          systemPrompt: `${system}\n\n---\n\n${user}`,
          messages: turns,
          selection: body.agent,
          signal,
          maxTokens: 6000,
          onText: text => {
            raw += text;
            if (raw.length > 180_000) throw new Error('Chat response is too long');
            const visible = chatVisibleText(raw);
            if (visible.length > sent) res.write(`data: ${JSON.stringify({ text: visible.slice(sent) })}\n\n`);
            sent = visible.length;
          },
        });
        let result;
        try { result = parseChatResponse(raw, body.document, selectedRange, latestMessage); }
        catch {
          result = { text: chatVisibleText(raw), edits: [], editWarning: 'The proposed edits could not be verified. Ask for the rewrite again.' };
        }
        res.write(`data: ${JSON.stringify({ answer: result.text, edits: result.edits, editWarning: result.editWarning, brief: result.brief, briefWarning: result.briefWarning })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } catch (e) {
        console.error('[/chat]', e.message);
        if (!res.headersSent) sendJson(res, 500, { error: e.message });
        else res.end(`data: ${JSON.stringify({ error: e.message })}\n\n`);
      }
      return;
    }

    // POST /rewrite — 3 variants
    //
    //  The document is context, the selection is the target. Sending the draft
    //  as a plain block ahead of a short selection made the model rewrite the
    //  draft, so the selection now leads and the document carries markers
    //  showing exactly which span is being replaced.
    //
    if (url.pathname === '/rewrite') {
      try {
        const variants = await requestRewrite({ ...body, signal });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ variants }));
      } catch (e) {
        console.error('[/rewrite]', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // POST /suggest — inline ghost-text suggestion (VS Code style)
    //
    //  Request: { context, document, cursor, manual }
    //  cursor is the character offset where the ghost text will appear.
    //  manual marks a continuation the writer asked for, not one offered.
    //
    //  Returns: { suggestion: string }  — a short natural continuation
    //
    if (url.pathname === '/suggest') {
      const { context, brief, document: doc, cursor, manual } = body;
      if (brief?.length > 4000) return sendJson(res, 400, { error: 'Brief is too long' });

      const at     = cursor ?? (doc ?? '').length;
      try {
        const text = await requestSuggestion({
          document: doc, cursor: at, context, brief, style: readStyle(), manual: !!manual,
          selection: body.agent,
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        }, completeText);
        sendJson(res, 200, { suggestion: text });
      } catch (e) {
        console.error('[/suggest]', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message, code: e.code, attempts: e.attempts }));
      }
      return;
    }

    res.writeHead(404); res.end('Not found');
    return;
  }
  sendJson(res, 405, { error: 'Method not allowed' });
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32'                  ? ['cmd', ['/c', 'start', '', url]]
    :                                                 ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true })
    .on('error', () => {})   // no browser to open — the URL is already printed
    .unref();
}

// A stale Stilura, or anything else, may hold 3000. Walk up rather than die.
function listen(port, attempt = 0) {
  // A failed attempt leaves its handlers queued; without this the next success
  // fires every one of them and announces a port nothing is bound to.
  server.removeAllListeners('error');
  server.removeAllListeners('listening');

  server.once('error', (error) => {
    if (error.code === 'EADDRINUSE' && attempt < 10) return listen(port + 1, attempt + 1);
    console.error(`[server] ${error.message}`);
    process.exit(1);
  });
  server.once('listening', () => {
    const url = `http://127.0.0.1:${server.address().port}`;
    sessions.listen(url);
    console.log(`Stilura → ${url}`);
    console.log(`Draft  → ${DRAFT_FILE}`);
    console.log(`Style  → ${STYLE_FILE}`);
    // One machine-readable line for the desktop shell. It waits for this before
    // it opens a window, so it must not be a log line someone may reword.
    if (SIDECAR) console.log(`STILURA_READY ${url}`);
    // The shell already has a window for this; a browser tab beside it would be
    // a second, stale copy of the same draft.
    if (!process.env.STILURA_NO_OPEN && !SIDECAR) openBrowser(url);
  });
  server.listen(port, '127.0.0.1');
}

// A shell that dies takes its server with it. Without this the writer's next
// launch meets an orphan holding the draft's lock file.
if (SIDECAR) {
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('error', () => process.exit(0));
}

listen(PORT);
process.on('exit', () => sessions.close());
