/**
 * tasks.js — prompt builders and prose generation for the HTTP server.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { completeText } from './pi.js';
import {
  markSelection, selectionSlot, parseVariants, variantLimit,
  SELECT_CLOSE, SELECT_OPEN, SELECT_SLOT,
} from './review.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// In the npm package the server sits next to its own assets. In the desktop
// build it is a single bundled file and the assets are Tauri resources, so the
// shell says where they are.
const ROOT = (process.env.STILURA_ROOT) || __dirname;

// Draft and style live in the folder Stilura was started from, not inside the
// install directory — `npx stilura` in a notes folder edits that folder. The
// bundled style.md is the fallback when the folder has none of its own.
const CWD = process.cwd();
export const STYLE_FILE = process.env.STYLE_FILE
  || [path.join(CWD, 'style.md'), path.join(ROOT, 'style.md')].find(p => fs.existsSync(p))
  || path.join(CWD, 'style.md');

let styleWarnedOnce = false;

export function readStyle() {
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

// Shared constraints for every prose-generating route.
export const NO_SLOP =
  'Never produce throat-clearing, vague attribution ("experts agree", "studies show"), empty puffery, ' +
  'faux insight, generic filler, "not just X, but Y" contrasts, robotic parallel rhythm, ' +
  'dramatic one-word fragments, stacked hedging, or decorative emphasis. Prefer concrete, specific wording over general claims. ' +
  'Do not give tools or abstractions human understanding or intent. Never invent evidence, sources, numbers or quotations. Preserve factual uncertainty. ';

// A variant several times the length of the selection is the whole-document
// rewrite failure, not a stylistic choice. Name it once and take the retry.
// Retry a malformed answer before showing the writer a parser error.
const REWRITE_ATTEMPTS = 3;

export function requestRewrite(body) {
  const { selected, document, from, instruction, context } = body;
  const system = buildSystemPrompt(
    'You are a writing assistant. Generate exactly 3 different replacements for the SELECTED TEXT ' +
    'and nothing else. Each variant must be distinct in phrasing and approach. ' +
    'Match the tone and flow of the paragraphs before and after the selection. ' +
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
  const slot = document && selectionSlot(document, selected, from);
  const user = [
    `SELECTED TEXT — replace exactly this, nothing more:\n${selected}`,
    instruction ? `INSTRUCTION:\n${instruction}` : 'Rewrite the selected text in 3 distinct ways.',
    slot ? `EACH VARIANT FILLS ${SELECT_SLOT} AND MUST READ CORRECTLY IN PLACE:\n${slot}` : '',
    context ? `CONTEXT:\n${context}` : '',
    document ? `DOCUMENT (context only — do not rewrite it):\n${markSelection(document, selected, from)}` : '',
  ].filter(Boolean).join('\n\n---\n\n');
  return completeVariants({ system, user, body });
}

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
      // need little output, but reasoning shares this budget.
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

export function buildSystemPrompt(task) {
  const style = readStyle();
  const stylePart = style ? `Follow this writing style guide:\n\n${style}\n\n---\n\n` : '';
  return stylePart + task;
}
