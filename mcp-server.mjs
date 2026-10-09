#!/usr/bin/env node
/**
 * Litura — MCP server (stdio) for Codex CLI, Claude Code, and other hosts.
 *
 * The same operations the editor UI uses, as MCP tools. Document arguments
 * default to the live draft, so an agent working in the writing folder can
 * simply call `review` with no arguments. Only `draft_write` modifies
 * anything, and it is revision-checked like PUT /draft: a stale revision
 * returns the current copy instead of overwriting it.
 *
 * Usage (stdio — the only transport):
 *   node mcp-server.mjs                      # DRAFT_FILE defaults to ./draft.md
 *   DRAFT_FILE=/notes/draft.md node mcp-server.mjs
 *
 * Codex (~/.codex/config.toml):
 *   [mcp_servers.litura]
 *   command = "node"
 *   args = ["/path/to/litura/mcp-server.mjs"]
 *   cwd = "/path/to/writing"
 *   tool_timeout_sec = 180
 *
 * Claude Code:
 *   claude mcp add --scope user litura -- node /path/to/litura/mcp-server.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { completeText, streamText } from './pi.js';
import { buildSystemPrompt, completeVariants, readStyle, NO_SLOP } from './tasks.js';
import { markSelection, selectionSlot, SELECT_CLOSE, SELECT_OPEN, SELECT_SLOT } from './review.js';
import { requestReview } from './review-model.js';
import { buildReviewTask, buildReviewUser, reviewCodesForPass } from './review-prompt.js';
import { documentStore, MAX_DOCUMENT_BYTES } from './document-store.js';
import { suggestionPrompts } from './suggestions.js';
import { CHAT_EDITS_PROMPT, chatVisibleText, parseChatResponse } from './chat-edits.js';

// stdio framing breaks if anything but the protocol reaches stdout. Pi warns
// to stdout on catalog-refresh trouble, so everything human-readable goes to
// stderr from here on.
for (const method of ['log', 'warn']) {
  const original = console[method].bind(console);
  console[method] = (...args) => {
    try { process.stderr.write(args.map(String).join(' ') + '\n'); }
    catch { original(...args); }
  };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.LITURA_ROOT || __dirname;
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const DRAFT_FILE = process.env.DRAFT_FILE || path.join(process.cwd(), 'draft.md');
const draftStore = documentStore(DRAFT_FILE);

// Same ceiling as the HTTP routes: AI actions support up to 60,000 characters
// per draft. Editing and export remain available through draft_read/write.
const MAX_AI_DOCUMENT = 60_000;
const OVERSIZE_MESSAGE = 'AI actions support up to 60,000 characters per draft. Split the document into smaller drafts; reading and writing remain available.';

const agentSchema = z.object({
  provider: z.string().describe('Pi provider ID, e.g. openai, anthropic, google'),
  model: z.string().describe('Pi model ID for that provider'),
  thinkingLevel: z.string().optional().describe('Reasoning level, e.g. off, low, medium, high'),
}).optional().describe('Model override. Omit to use the server default (PI_PROVIDER/PI_MODEL, then fallbacks).');

const documentSchema = z.string().optional().describe('Full draft text. Omit to use the live draft.md.');

function liveDocument() {
  return draftStore.read().text;
}

function resolveDocument(arg) {
  const document = arg ?? liveDocument();
  if (typeof document !== 'string') throw new Error('document must be a string');
  if (document.length > MAX_AI_DOCUMENT) throw new Error(OVERSIZE_MESSAGE);
  return document;
}

function checkBytes(text, what = 'Document') {
  if (Buffer.byteLength(text) > MAX_DOCUMENT_BYTES) throw new Error(`${what} exceeds the 1 MB editing limit.`);
}

function ok(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function fail(error) {
  const payload = error?.current !== undefined
    ? { error: error.message, current: error.current }
    : { error: error?.message || String(error) };
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: true };
}

const server = new McpServer(
  { name: 'litura', version: MANIFEST.version },
  {
    instructions: 'Litura edits one local draft (draft.md). Suggest wording; only draft_write changes the file, and it is revision-checked. Never invent facts, sources, numbers, or quotes.',
  },
);

server.registerTool('draft_read', {
  description: 'Read the working draft. Returns { text, path, exists, revision }; pass revision back to draft_write.',
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}, async () => {
  try {
    return ok(draftStore.read());
  } catch (error) { return fail(error); }
});

server.registerTool('draft_write', {
  description: 'Save the draft. Requires the revision from draft_read; a stale revision fails with the current copy instead of overwriting it.',
  inputSchema: {
    text: z.string().describe('Complete new draft text'),
    revision: z.string().describe('Revision token from draft_read'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async ({ text, revision }) => {
  try {
    checkBytes(text);
    return ok({ saved: true, ...draftStore.write(text, revision) });
  } catch (error) { return fail(error); }
});

server.registerTool('review', {
  description: 'Audit the draft for named writing problems. Returns up to 8 findings { code, quote, pattern, reason, fix }; quote is always exact draft text. Detection only — never rewrites.',
  inputSchema: {
    document: documentSchema,
    target: z.string().optional().describe('Audit only this passage; the full draft stays in context. Omit for a full review.'),
    context: z.string().optional().describe("Author's reference material (never audited, only context)"),
    agent: agentSchema,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async ({ document: docArg, target, context, agent }) => {
  try {
    const signal = AbortSignal.timeout(120_000);
    const document = resolveDocument(docArg).trim();
    const narrowed = String(target ?? '').trim();
    if (!document) return ok({ findings: [] });
    const user = buildReviewUser({ document, target: narrowed, context });
    const phases = narrowed ? ['local'] : ['global', 'local'];
    const prompts = phases.map(phase => ({
      phase,
      systemPrompt: buildSystemPrompt(buildReviewTask({ targeted: Boolean(narrowed), phase })),
      userPrompt: user,
      allowedCodes: reviewCodesForPass(Boolean(narrowed), phase),
      source: narrowed || document,
    }));
    return ok(await requestReview({ prompts, selection: agent, signal, detailed: true }));
  } catch (error) { return fail(error); }
});

server.registerTool('rewrite', {
  description: 'Propose exactly 3 replacement variants for one passage. Returns { variants: [3 strings] }; nothing is applied — the author picks one.',
  inputSchema: {
    selected: z.string().describe('Exact passage to replace'),
    from: z.number().int().optional().describe('Character offset of the passage in document; defaults to its first occurrence'),
    instruction: z.string().optional().describe('What to fix, e.g. the finding pattern and reason'),
    document: documentSchema,
    context: z.string().optional(),
    agent: agentSchema,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async ({ selected, from, instruction, document: docArg, context, agent }) => {
  try {
    const signal = AbortSignal.timeout(120_000);
    const document = resolveDocument(docArg);
    if (!selected) throw new Error('selected must be a non-empty string');
    const at = from ?? document.indexOf(selected);
    if (!Number.isInteger(at) || at < 0 || document.slice(at, at + selected.length) !== selected) {
      throw new Error('Selected text does not match the document range');
    }
    const body = { selected, from: at, document, instruction, context, agent, signal };
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
      'No markdown fences, no commentary, no explanation — just the raw JSON array.',
    );
    const user = [
      `SELECTED TEXT — replace exactly this, nothing more:\n${selected}`,
      instruction ? `INSTRUCTION:\n${instruction}` : 'Rewrite the selected text in 3 distinct ways.',
      selectionSlot(document, selected, at)
        ? `EACH VARIANT FILLS ${SELECT_SLOT} AND MUST READ CORRECTLY IN PLACE:\n` + selectionSlot(document, selected, at)
        : '',
      context ? `CONTEXT:\n${context}` : '',
      `DOCUMENT (context only — do not rewrite it):\n${markSelection(document, selected, at)}`,
    ].filter(Boolean).join('\n\n---\n\n');
    return ok({ variants: await completeVariants({ system, user, body }) });
  } catch (error) { return fail(error); }
});

server.registerTool('suggest', {
  description: 'Propose a short continuation (at most 15 words) at the cursor. Returns { suggestion }; empty string means the thought is finished or continuation would invent facts.',
  inputSchema: {
    document: documentSchema,
    cursor: z.number().int().optional().describe('Character offset; defaults to the end of the document'),
    context: z.string().optional(),
    agent: agentSchema,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async ({ document: docArg, cursor, context, agent }) => {
  try {
    const signal = AbortSignal.any([AbortSignal.timeout(120_000), AbortSignal.timeout(30_000)]);
    const document = resolveDocument(docArg);
    const at = cursor ?? document.length;
    if (!Number.isInteger(at) || at < 0 || at > document.length) throw new Error('Invalid cursor');
    const { parseSuggestion } = await import('./suggestions.js');
    const suggestion = await completeText({
      ...suggestionPrompts({ document, cursor: at, context, style: readStyle(), manual: false }),
      selection: agent,
      continuation: true,
      signal,
    });
    const prefix = document.slice(0, at);
    return ok({ suggestion: suggestion ? parseSuggestion(prefix, suggestion) : '' });
  } catch (error) { return fail(error); }
});

server.registerTool('chat', {
  description: 'Discuss the draft. Returns { answer, edits, editWarning }; edits are proposed replacements for approval, never applied.',
  inputSchema: {
    message: z.string().describe('The latest user message'),
    document: documentSchema,
    history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })).optional()
      .describe('Earlier turns oldest-first; the last 20 valid ones are used'),
    selection: z.string().optional().describe('Passage under discussion'),
    agent: agentSchema,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async ({ message, document: docArg, history, selection, agent }) => {
  try {
    const signal = AbortSignal.timeout(120_000);
    const document = resolveDocument(docArg);
    if (typeof message !== 'string' || !message.trim()) throw new Error('message must be a non-empty string');
    const turns = [...(Array.isArray(history) ? history : []), { role: 'user', content: message }]
      .filter(m => (m?.role === 'user' || m?.role === 'assistant') && String(m.content ?? '').trim())
      .map(m => ({ role: m.role, content: String(m.content) }))
      .slice(-20);
    if (!turns.length) throw new Error('No messages');
    const system = buildSystemPrompt(
      'You are a writing assistant working alongside the author on the draft below. ' +
      'Answer questions about it and propose concrete wording when asked. ' +
      'You cannot edit the document yourself — the author applies what they choose, ' +
      'so propose replacements for their approval. ' + CHAT_EDITS_PROMPT +
      'Be brief. Skip preamble, restating the question, and offers of further help. ' +
      NO_SLOP +
      (selection ? 'The author has selected a passage; treat it as the subject unless they say otherwise.' : ''),
    );
    const user = [
      `DRAFT:\n${document || '(empty)'}`,
      selection ? `SELECTED PASSAGE:\n${selection}` : '',
    ].filter(Boolean).join('\n\n---\n\n');
    let raw = '';
    await streamText({
      systemPrompt: `${system}\n\n---\n\n${user}`,
      messages: turns,
      selection: agent,
      signal,
      maxTokens: 6000,
      onText: text => {
        raw += text;
        if (raw.length > 180_000) throw new Error('Chat response is too long');
      },
    });
    let result;
    try {
      const selectedRange = selection ? { from: document.indexOf(selection), to: document.indexOf(selection) + selection.length } : undefined;
      if (selection && (selectedRange.from < 0 || document.slice(selectedRange.from, selectedRange.to) !== selection)) {
        throw new Error('selection not found in document');
      }
      result = parseChatResponse(raw, document, selectedRange);
    } catch {
      result = { text: chatVisibleText(raw), edits: [], editWarning: 'The proposed edits could not be verified. Ask for the rewrite again.' };
    }
    return ok({ answer: result.text, edits: result.edits, ...(result.editWarning ? { editWarning: result.editWarning } : {}) });
  } catch (error) { return fail(error); }
});

server.registerTool('idea', {
  description: 'Expand a terse idea into a passage fitting the draft. Returns { passage }; the draft is unchanged.',
  inputSchema: {
    idea: z.string().describe('The idea to expand'),
    document: documentSchema,
    context: z.string().optional(),
    agent: agentSchema,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async ({ idea, document: docArg, context, agent }) => {
  try {
    const signal = AbortSignal.timeout(120_000);
    const document = resolveDocument(docArg);
    if (typeof idea !== 'string' || !idea.trim()) throw new Error('idea must be a non-empty string');
    const system = buildSystemPrompt(
      'You are a writing assistant. Given the context material and the current working document, ' +
      'expand the following idea into a well-written passage that fits the tone and topic. ' +
      NO_SLOP +
      'Return only the passage, no commentary, no preamble.',
    );
    const user = [
      context ? `CONTEXT:\n${context}` : '',
      document ? `WORKING DOCUMENT:\n${document}` : '',
      `IDEA TO EXPAND:\n${idea}`,
    ].filter(Boolean).join('\n\n---\n\n');
    let passage = '';
    await streamText({ systemPrompt: system, userPrompt: user, selection: agent, signal, onText: text => { passage += text; } });
    return ok({ passage });
  } catch (error) { return fail(error); }
});

await server.connect(new StdioServerTransport());
