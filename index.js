#!/usr/bin/env node
/**
 * Litura — local AI-assisted writing editor
 * Split-pane editor with LLM assistance via Pi
 *
 * Usage:
 *   npx litura        (in the folder holding your draft)
 *   node index.js
 */

import http  from 'http';
import fs    from 'fs';
import path  from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { completeText, getAgentStatus, removeProviderApiKey, saveProviderApiKey, streamText } from './pi.js';
import {
  markSelection, parseVariants, selectionSlot, trimOverlap, variantLimit,
  SELECT_CLOSE, SELECT_OPEN, SELECT_SLOT,
} from './review.js';
import { requestReview } from './review-model.js';
import { buildReviewTask, buildReviewUser, reviewCodesForPass } from './review-prompt.js';
import { documentStore, MAX_DOCUMENT_BYTES } from './document-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
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

// Litura opens no connection of its own — every request it makes belongs to a
// model call the writer asked for. So the update check is a command you run,
// not something that happens quietly at startup.
if (process.argv.includes('--check-update')) {
  const name = MANIFEST.name;
  const latest = await latestPublished(name).catch(error => {
    console.error(`[update] npm registry unreachable — ${error.message}`);
    process.exit(1);
  });
  if (latest === null) {
    console.log(`Litura ${VERSION} — ${name} is not published; nothing to compare against.`);
    process.exit(0);
  }
  // Stated, not judged: a local build can legitimately run ahead of the
  // registry, and ranking two versions correctly is a semver dependency.
  console.log(latest === VERSION
    ? `Litura ${VERSION} — same as the published release.`
    : `Published: ${name}@${latest}. Running: ${VERSION}.\n` +
      `  npx ${name}       — always runs the published release\n` +
      `  npm i -g ${name}  — if you installed it globally`);
  process.exit(0);
}

// ─── Bundle frontend (CodeMirror 6 → public/app.js) ────────────────────────
// Only in a source checkout. The published package ships public/app.js already
// built and has no esbuild, so src/ missing is the signal to skip.
if (fs.existsSync(path.join(__dirname, 'src/app.js'))) {
  try {
    const { build } = await import('esbuild');
    await build({
      entryPoints: [path.join(__dirname, 'src/app.js')],
      bundle:      true,
      outfile:     path.join(__dirname, 'public/app.js'),
      format:      'iife',
      logLevel:    'warning',
    });
    console.log('[build] Frontend bundled ✓');
  } catch (e) {
    console.error('[build] Frontend build failed.\n', e.message);
    process.exit(1);
  }
}

const PORT = parseInt(process.env.PORT || '3456', 10);
const PUBLIC = path.join(__dirname, 'public');

// Draft and style live in the folder Litura was started from, not inside the
// install directory — `npx litura` in a notes folder edits that folder. The
// bundled style.md is the fallback when the folder has none of its own.
const CWD        = process.cwd();
const DRAFT_FILE = process.env.DRAFT_FILE || path.join(CWD, 'draft.md');
const draftStore = documentStore(DRAFT_FILE);
const STYLE_FILE = process.env.STYLE_FILE
  || [path.join(CWD, 'style.md'), path.join(__dirname, 'style.md')].find(p => fs.existsSync(p))
  || path.join(CWD, 'style.md');

// ─── Style guide ───────────────────────────────────────────────────────────
let styleWarnedOnce = false;

function readStyle() {
  try {
    return fs.readFileSync(STYLE_FILE, 'utf8').trim();
  } catch {
    if (!styleWarnedOnce) {
      console.warn(`[style] No style.md found at ${STYLE_FILE} — proceeding without style guide`);
      styleWarnedOnce = true;
    }
    return null;
  }
}

// The same patterns /review flags. Every route that generates prose gets these,
// so the app never writes what it is about to underline.
const NO_SLOP =
  'Never produce throat-clearing, vague attribution ("experts agree", "studies show"), empty puffery, ' +
  'faux insight, generic filler, "not just X, but Y" contrasts, robotic parallel rhythm, ' +
  'dramatic one-word fragments, stacked hedging, or decorative emphasis. Prefer concrete, specific wording over general claims. ' +
  'Do not give tools or abstractions human understanding or intent. Never invent evidence, sources, numbers or quotations. Preserve factual uncertainty. ';

// A variant several times the length of the selection is the whole-document
// rewrite failure, not a stylistic choice. Name it once and take the retry.
// A malformed answer is retried the same way review retries: an occasional bad
// response should cost a second call, not show the writer a parser error.
const REWRITE_ATTEMPTS = 3;

async function completeVariants({ system, user, body }) {
  const selected = String(body.selected ?? '');
  const limit = variantLimit(selected);
  let prompt = user;
  for (let attempt = 1; ; attempt++) {
    const raw = await completeText({
      systemPrompt: system,
      userPrompt: prompt,
      selection: body.agent,
      // Shared with reasoning tokens: at 1500 a thinking model spends the whole
      // budget deliberating and returns an empty string. Three short strings
      // cost nothing, so give it the same room /review has.
      maxTokens: 4000,
      signal: body.signal,
    });
    let variants;
    try {
      variants = parseVariants(raw);
    } catch (error) {
      if (attempt >= REWRITE_ATTEMPTS) throw error;
      console.warn(`[/rewrite] ${error.message} — retrying (${attempt}/${REWRITE_ATTEMPTS}); model said: ${JSON.stringify(raw.slice(0, 200))}`);
      continue;
    }
    if (!variants.some(variant => variant.length > limit)) return variants;
    if (attempt >= REWRITE_ATTEMPTS) throw new Error('Rewrites exceeded the selected scope. Try a more specific instruction.');
    console.warn('[/rewrite] out-of-scope variants — retrying with the selection restated');
    prompt = `${user}\n\n---\n\nYour previous answer rewrote text outside the selection. ` +
      `Replace only ${SELECT_OPEN}${selected}${SELECT_CLOSE}, keep every other word of the sentence untouched, ` +
      `and stay under ${limit} characters per variant.`;
  }
}

function buildSystemPrompt(task) {
  const style = readStyle();
  const stylePart = style ? `Follow this writing style guide:\n\n${style}\n\n---\n\n` : '';
  return stylePart + task;
}

// ─── Static file serving ───────────────────────────────────────────────────
const MIME = {
  '.html':  'text/html; charset=utf-8',
  '.css':   'text/css; charset=utf-8',
  '.js':    'application/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff':  'font/woff',
};

function serveStatic(res, filePath) {
  const ext  = path.extname(filePath);
  const mime = MIME[ext] || 'text/plain';
  // Fonts never change under a given name; the bundle changes with every
  // update, and a tab holding a stale app.js against a new server is the
  // classic post-upgrade bug. Revalidate it on each load.
  const cache = ext === '.woff2' ? 'public, max-age=31536000, immutable' : 'no-cache';
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
        for (const key of ['text', 'revision', 'document', 'selected', 'target', 'context', 'idea', 'instruction', 'selection', 'provider', 'apiKey']) {
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

// ─── Server ────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(error => {
    console.error('[request]', error.message);
    if (!res.headersSent) sendJson(res, error.status || 500, { error: error.message });
    else res.end();
  });
});

async function handleRequest(req, res) {
  const host = req.headers.host;
  const port = server.address()?.port;
  if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host)) return sendJson(res, 403, { error: 'Invalid local host' });
  if (req.headers.origin && req.headers.origin !== `http://${host}`) return sendJson(res, 403, { error: 'Cross-origin requests are not allowed' });
  if (req.headers['sec-fetch-site'] === 'cross-site') return sendJson(res, 403, { error: 'Cross-site requests are not allowed' });
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.method)) return sendJson(res, 405, { error: 'Method not allowed' });
  if (req.method !== 'GET' && req.headers['content-type']?.split(';')[0].trim() !== 'application/json') return sendJson(res, 415, { error: 'Use application/json' });
  const cancellation = new AbortController();
  res.on('close', () => { if (!res.writableEnded) cancellation.abort(); });
  const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(120_000)]);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  const url = new URL(req.url, `http://localhost`);

  // Which version is running, and — only when the browser asks with ?check=1,
  // which it does only if the writer turned the check on — which is published.
  // A registry that is down is reported, not retried: this is a nicety.
  if (req.method === 'GET' && url.pathname === '/api/version') {
    const payload = { name: MANIFEST.name, current: VERSION };
    if (url.searchParams.get('check') === '1') {
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

  // ── Draft file
  //
  //  One local Markdown file is the durable copy of the working document.
  //  The browser keeps writing to localStorage for instant reload; this is
  //  what survives clearing browser data and what other editors can open.
  //
  if (url.pathname === '/draft') {
    if (req.method === 'GET') {
      sendJson(res, 200, draftStore.read());
      return;
    }
    if (req.method === 'PUT') {
      try {
        const body = await readBody(req);
        sendJson(res, 200, { saved: true, ...draftStore.write(body.text, body.revision) });
      } catch (error) {
        console.error('[/draft]', error.message);
        sendJson(res, error.status || 500, { error: error.message, current: error.current });
      }
      return;
    }
  }
  if (req.method === 'GET' && url.pathname === '/draft/history') return sendJson(res, 200, { snapshots: draftStore.history() });

  // ── Static
  if (req.method === 'GET') {
    if      (url.pathname === '/')          serveStatic(res, path.join(PUBLIC, 'index.html'));
    else if (url.pathname === '/style.css') serveStatic(res, path.join(PUBLIC, 'style.css'));
    else if (url.pathname === '/app.js')    serveStatic(res, path.join(PUBLIC, 'app.js'));
    else if (url.pathname.startsWith('/fonts/')) {
      const fontFile = path.basename(url.pathname);
      serveStatic(res, path.join(PUBLIC, 'fonts', fontFile));
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
    if (url.pathname === '/rewrite' && (!body.selected || !Number.isInteger(body.from) || body.document?.slice(body.from, body.from + body.selected.length) !== body.selected)) return sendJson(res, 400, { error: 'Selected text does not match the document range' });

    // POST /idea — SSE stream
    if (url.pathname === '/idea') {
      const system = buildSystemPrompt(
        'You are a writing assistant. Given the context material and the current working document, ' +
        'expand the following idea into a well-written passage that fits the tone and topic. ' +
        NO_SLOP +
        'Return only the passage, no commentary, no preamble.'
      );
      const user = [
        body.context  ? `CONTEXT:\n${body.context}`           : '',
        body.document ? `WORKING DOCUMENT:\n${body.document}` : '',
        `IDEA TO EXPAND:\n${body.idea}`,
      ].filter(Boolean).join('\n\n---\n\n');

      try {
        res.writeHead(200, {
          'Content-Type':  'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection':    'keep-alive',
        });
        await streamText({
          systemPrompt: system,
          userPrompt: user,
          selection: body.agent,
          signal,
          onText: text => res.write(`data: ${JSON.stringify({ text })}\n\n`),
        });
        res.write('data: [DONE]\n\n');
        res.end();
      } catch (e) {
        console.error('[/idea]', e.message);
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
      const history = Array.isArray(body.messages) ? body.messages : [];
      const turns = history
        .filter(message => (message?.role === 'user' || message?.role === 'assistant') && String(message.content ?? '').trim())
        .map(message => ({ role: message.role, content: String(message.content) }))
        .slice(-20);
      if (!turns.length) { sendJson(res, 400, { error: 'No messages' }); return; }

      const system = buildSystemPrompt(
        'You are a writing assistant working alongside the author on the draft below. ' +
        'Answer questions about it and propose concrete wording when asked. ' +
        'You cannot edit the document yourself — the author applies what they choose, ' +
        'so give text they can paste rather than describing an edit you claim to have made. ' +
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
        await streamText({
          systemPrompt: `${system}\n\n---\n\n${user}`,
          messages: turns,
          selection: body.agent,
          signal,
          onText: text => res.write(`data: ${JSON.stringify({ text })}\n\n`),
        });
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
      const system = buildSystemPrompt(
        'You are a writing assistant. Generate exactly 3 different replacements for the SELECTED TEXT ' +
        'and nothing else. Each variant must be distinct in phrasing and approach. ' +
        'The document is context: it shows where the selection sits and must not be rewritten, ' +
        `summarised, or included in your output. The selection is marked ${SELECT_OPEN}like this${SELECT_CLOSE} inside it. ` +
        `Each variant is substituted for the marked span alone — it fills the ${SELECT_SLOT} gap in the sentence shown below it: ` +
        'never restate, absorb, or repeat any words outside the markers, and keep roughly the length of the selection. ' +
        'Follow the instruction — it names the specific problem this replacement has to fix. ' +
        NO_SLOP +
        'Never invent sources, numbers, dates, quotes, evidence, or stronger certainty. If evidence is missing, preserve uncertainty or ask for a source. ' +
        'Return ONLY a JSON array with exactly 3 strings: ["variant1","variant2","variant3"]. ' +
        'No markdown fences, no commentary, no explanation — just the raw JSON array.'
      );
      const user = [
        `SELECTED TEXT — replace exactly this, nothing more:\n${body.selected}`,
        body.instruction
          ? `INSTRUCTION:\n${body.instruction}`
          : 'Rewrite the selected text in 3 distinct ways.',
        body.document && selectionSlot(body.document, body.selected, body.from)
          ? `EACH VARIANT FILLS ${SELECT_SLOT} AND MUST READ CORRECTLY IN PLACE:\n` +
            selectionSlot(body.document, body.selected, body.from)
          : '',
        body.context  ? `CONTEXT:\n${body.context}` : '',
        body.document
          ? `DOCUMENT (context only — do not rewrite it):\n${markSelection(body.document, body.selected, body.from)}`
          : '',
      ].filter(Boolean).join('\n\n---\n\n');

      try {
        const variants = await completeVariants({ system, user, body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ variants }));
      } catch (e) {
        console.error('[/rewrite]', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // POST /review — named, checkable writing-pattern findings
    //
    //  body.target (optional) narrows the audit to specific passages while the
    //  full document stays in the prompt as context. The incremental
    //  per-sentence review uses it; the toolbar button omits it.
    //
    if (url.pathname === '/review') {
      const document = String(body.document ?? '').trim();
      const target = String(body.target ?? '').trim();
      if (!document) { sendJson(res, 200, { findings: [] }); return; }

      const user = buildReviewUser({ document, target, context: body.context });
      const phases = target ? ['local'] : ['global', 'local'];
      const prompts = phases.map(phase => ({
        phase,
        systemPrompt: buildSystemPrompt(buildReviewTask({ targeted: Boolean(target), phase })),
        userPrompt: user,
        allowedCodes: reviewCodesForPass(Boolean(target), phase),
        source: target || document,
      }));

      try {
        const result = await requestReview({
          prompts,
          selection: body.agent,
          signal,
          detailed: true,
        });
        sendJson(res, 200, result);
      } catch (e) {
        console.error('[/review]', e.message);
        sendJson(res, 500, { error: e.message });
      }
      return;
    }

    // POST /suggest — inline ghost-text suggestion (VS Code style)
    //
    //  Request: { context, document, cursor }
    //  cursor is the character offset where the ghost text will appear.
    //
    //  Returns: { suggestion: string }  — a short natural continuation
    //
    if (url.pathname === '/suggest') {
      const { context, document: doc, cursor } = body;

      const at     = cursor ?? (doc ?? '').length;
      const prefix = (doc ?? '').slice(0, at);
      const suffix = (doc ?? '').slice(at);

      // The same patterns /review flags — the assistant must not generate what
      // the assistant is about to underline.
      const system = buildSystemPrompt(
        'You are an inline writing assistant. ' +
        'Continue the text with 5 to 15 words — just enough to finish the thought, then stop. ' +
        'Match the draft\'s voice, vocabulary, and rhythm; stay on the specific subject of the last sentence. ' +
        NO_SLOP +
        'Carry the thought to its next concrete step — a fact, an action, a consequence — not a general claim. ' +
        'Resume from exactly where the text stops: never repeat or restate words already written, ' +
        'and never start the sentence over. ' +
        'Return ONLY the continuation. No commentary, no quotes, no explanation.'
      );

      const userMsg = [
        context ? `CONTEXT:\n${context}` : '',
        suffix.trim() ? `TEXT THAT ALREADY FOLLOWS (do not repeat or contradict it):\n${suffix}` : '',
        `Continue:\n\n${prefix}`,
      ].filter(Boolean).join('\n\n---\n\n');

      try {
        const suggestion = await completeText({
          systemPrompt: system,
          userPrompt: userMsg,
          selection: body.agent,
          continuation: true,
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ suggestion: trimOverlap(prefix, suggestion) }));
      } catch (e) {
        console.error('[/suggest]', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
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

// A stale Litura, or anything else, may hold 3456. Walk up rather than die.
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
    console.log(`Litura → ${url}`);
    console.log(`Draft  → ${DRAFT_FILE}`);
    console.log(`Style  → ${STYLE_FILE}`);
    if (!process.env.LITURA_NO_OPEN) openBrowser(url);
  });
  server.listen(port, '127.0.0.1');
}

listen(PORT);
