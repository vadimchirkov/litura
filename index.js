#!/usr/bin/env node
/**
 * Writing Assistant — local web app
 * Split-pane editor with LLM assistance via Pi
 *
 * Usage:
 *   node index.js
 */

import http  from 'http';
import fs    from 'fs';
import path  from 'path';
import { fileURLToPath } from 'url';
import { build } from 'esbuild';
import { completeText, getAgentStatus, removeProviderApiKey, saveProviderApiKey, streamText } from './pi.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Bundle frontend (CodeMirror 6 → public/app.js) ────────────────────────
try {
  await build({
    entryPoints: [path.join(__dirname, 'src/app.js')],
    bundle:      true,
    outfile:     path.join(__dirname, 'public/app.js'),
    format:      'iife',
    logLevel:    'warning',
  });
  console.log('[build] Frontend bundled ✓');
} catch (e) {
  console.error('[build] Frontend build failed — server will serve stale bundle.\n', e.message);
}

const PORT       = parseInt(process.env.PORT || '3456', 10);
const STYLE_FILE = process.env.STYLE_FILE || path.join(__dirname, 'style.md');
const PUBLIC     = path.join(__dirname, 'public');

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
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime });
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
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ─── Server ────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);

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
    catch { res.writeHead(400); res.end('Bad request'); return; }

    // POST /idea — SSE stream
    if (url.pathname === '/idea') {
      const system = buildSystemPrompt(
        'You are a writing assistant. Given the context material and the current working document, ' +
        'expand the following idea into a well-written passage that fits the tone and topic. ' +
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
          signal: AbortSignal.timeout(90_000),
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

    // POST /rewrite — 3 variants
    if (url.pathname === '/rewrite') {
      const system = buildSystemPrompt(
        'You are a writing assistant. Generate exactly 3 different rewrites of the selected text ' +
        'based on the instruction. Each variant must be distinct in phrasing and approach. ' +
        'Return ONLY a JSON array with exactly 3 strings: ["variant1","variant2","variant3"]. ' +
        'No markdown fences, no commentary, no explanation — just the raw JSON array.'
      );
      const user = [
        body.context  ? `CONTEXT:\n${body.context}`           : '',
        body.document ? `WORKING DOCUMENT:\n${body.document}` : '',
        `SELECTED TEXT:\n${body.selected}`,
        body.instruction
          ? `INSTRUCTION:\n${body.instruction}`
          : 'Rewrite this passage in 3 distinct ways.',
      ].filter(Boolean).join('\n\n---\n\n');

      try {
        const raw = await completeText({
          systemPrompt: system,
          userPrompt: user,
          selection: body.agent,
          maxTokens: 1500,
          signal: AbortSignal.timeout(90_000),
        });
        const match = raw.match(/\[[\s\S]*\]/);
        if (!match) throw new Error('No JSON array in response');
        const variants = JSON.parse(match[0]);
        if (!Array.isArray(variants) || variants.length < 3) throw new Error('Expected 3 variants');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ variants: variants.slice(0, 3) }));
      } catch (e) {
        console.error('[/rewrite]', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
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

      const prefix = (doc ?? '').slice(0, cursor ?? (doc ?? '').length);

      // Use the fast non-reasoning model — no chain-of-thought overhead
      const system = buildSystemPrompt(
        'You are an inline writing assistant. ' +
        'Continue the text with 5 to 15 words — just enough to complete the thought. ' +
        'Return ONLY the continuation. No commentary, no quotes, no explanation.'
      );

      const userMsg = [
        context ? `CONTEXT:\n${context}` : '',
        `Continue:\n\n${prefix}`,
      ].filter(Boolean).join('\n\n---\n\n');

      try {
        const suggestion = await completeText({
          systemPrompt: system,
          userPrompt: userMsg,
          selection: body.agent,
          maxTokens: 80,
          signal: AbortSignal.timeout(30_000),
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ suggestion }));
      } catch (e) {
        console.error('[/suggest]', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    res.writeHead(404); res.end('Not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Writing Assistant → http://127.0.0.1:${PORT}`);
});
