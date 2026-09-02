#!/usr/bin/env node
/**
 * Litura — local AI-assisted writing editor
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
import { parseReviewResponse, trimOverlap } from './review.js';

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

// The same patterns /review flags. Every route that generates prose gets these,
// so the app never writes what it is about to underline.
const NO_SLOP =
  'Never produce throat-clearing, vague attribution ("experts agree", "studies show"), empty puffery, ' +
  'faux insight, generic filler, "not just X, but Y" contrasts, robotic parallel rhythm, ' +
  'or dramatic one-word fragments. Prefer concrete, specific wording over general claims. ';

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
          signal: AbortSignal.timeout(120_000),
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
    if (url.pathname === '/rewrite') {
      const system = buildSystemPrompt(
        'You are a writing assistant. Generate exactly 3 different rewrites of the selected text ' +
        'based on the instruction. Each variant must be distinct in phrasing and approach. ' +
        'Each variant is substituted in place of the selected text alone, so it must fit the surrounding ' +
        'sentence exactly: never restate, absorb, or repeat any words outside the selection. ' +
        NO_SLOP +
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

      const scope = target
        ? 'Audit ONLY the passages under PASSAGES TO AUDIT. The draft is context you must read but must not flag. ' +
          'Every quote you return must be copied from the passages, not from the rest of the draft. ' +
          'For structure, flag only a local connection problem visible in those passages; reserve paragraph- or document-level findings for a full review. '
        : '';

      const system = buildSystemPrompt(
        'You are a sharp human editor auditing a draft for writing and structure problems. ' +
        scope +
        'Detect only; do not rewrite the draft, score it, or guess who wrote it. ' +
        'Flag only strong, checkable examples such as throat-clearing, vague attribution, empty puffery, ' +
        'faux insight, generic filler, binary contrast, robotic rhythm, repetitive recap, or dramatic fragmentation. ' +
        'Also flag strong reader-structure problems when the genre and available text support the diagnosis: ' +
        'an opening that sets expectations the passage does not fulfill, a missing or buried point, ' +
        'an abrupt old-to-new information break, central terms that disappear or arrive unannounced, ' +
        'an explanatory introduction with no concrete problem or stakes, or an ending that does not resolve its opening problem. ' +
        'Treat constant-topic, linking, and preview-and-develop progressions as valid alternatives, not rules to impose together. ' +
        'Do not flag an isolated em dash, polished grammar, formal vocabulary, proper names, quotations, or intentional voice. ' +
        'Preserve unusual details, humor, uncertainty, bluntness, cadence, and useful roughness. ' +
        'Return a structural finding only when replacing its quoted passage can materially improve it without moving or inventing surrounding content. ' +
        'Return ONLY a JSON array of at most 8 objects with string fields quote, pattern, reason, fix. ' +
        'quote must be a short exact contiguous quote copied from the draft. fix is a brief direction, not a rewrite. ' +
        'Use the language of the draft for pattern, reason, and fix. Return [] when there are no strong findings.'
      );
      const user = [
        body.context ? `VOICE OR REFERENCE CONTEXT (do not audit):\n${body.context}` : '',
        `${target ? 'DRAFT (context only)' : 'DRAFT TO AUDIT'}:\n${document}`,
        target ? `PASSAGES TO AUDIT:\n${target}` : '',
      ].filter(Boolean).join('\n\n---\n\n');

      try {
        const raw = await completeText({
          systemPrompt: system,
          userPrompt: user,
          selection: body.agent,
          maxTokens: 1600,
          signal: AbortSignal.timeout(90_000),
        });
        sendJson(res, 200, { findings: parseReviewResponse(raw) });
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
          maxTokens: 80,
          signal: AbortSignal.timeout(30_000),
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
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Litura → http://127.0.0.1:${PORT}`);
});
