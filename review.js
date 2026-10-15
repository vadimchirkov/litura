export const WORD_RE = /\p{L}[\p{L}\p{N}'’-]*/gu;

export function isLatinScript(text) {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (!letters.length) return true;
  return letters.filter(ch => /[\p{Script=Latin}]/u.test(ch)).length / letters.length > 0.5;
}

// ── Rewrite scope ──
//
//  A short selection sent alongside a whole draft reads to the model as "clean
//  this up", and it returns a rewritten draft that cannot be substituted back.
//  Marking the span and bounding the answer keeps a replacement a replacement.
//
export const SELECT_OPEN  = '⟦';
export const SELECT_CLOSE = '⟧';

export const SELECT_SLOT = '___';

// The client sends the caret-accurate offset; a bare quote may occur more than
// once, so fall back to the first match only when the offset does not fit.
function selectionAt(document, selected, from) {
  if (!selected) return -1;
  return Number.isInteger(from) && document.slice(from, from + selected.length) === selected
    ? from
    : document.indexOf(selected);
}

export function markSelection(document, selected, from) {
  const at = selectionAt(document, selected, from);
  if (at < 0) return document;
  return document.slice(0, at) + SELECT_OPEN + selected + SELECT_CLOSE + document.slice(at + selected.length);
}

// The sentence with the selection cut out. Scope alone is not enough: told only
// to keep it short, the model returns wording that repeats what already follows
// ("experts agree" → "collaboration is key" in front of "collaboration is key").
// Shown the gap it has to fill, it stops writing the neighbours.
export function selectionSlot(document, selected, from) {
  const at = selectionAt(document, selected, from);
  if (at < 0) return null;
  const end = at + selected.length;
  const sentence = completedSentences(document).find(item => item.from <= at && item.to >= end)
    ?? { from: Math.max(0, at - 90), to: Math.min(document.length, end + 90) };
  return document.slice(sentence.from, at).trimStart() + SELECT_SLOT + document.slice(end, sentence.to).trimEnd();
}

// Room to rephrase, not to absorb the sentences around it.
export const variantLimit = selected => Math.max(selected.length * 3, selected.length + 60);

export function parseVariants(raw) {
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('No JSON array in response');
  const variants = JSON.parse(match[0]);
  if (!Array.isArray(variants) || variants.length !== 3 || variants.some(text => typeof text !== 'string' || !text.trim())) throw new Error('Expected exactly 3 non-empty strings');
  // A variant replaces the marked span in place: leading/trailing blank lines
  // from the model would land in the draft as stray paragraph breaks, and show
  // as empty space at the card's edges. Edge whitespace is never the wording.
  return variants.map(text => text.trim());
}

// Models restate the last words before continuing ("…the queue" → "queue began
// draining"). Asking them not to is unreliable; cutting the overlap is not.
function proseTokens(text) {
  return [...text.matchAll(/[\p{L}\p{N}\p{M}_]+|[^\s]/gu)].map(match => ({
    value: match[0].toLowerCase(), from: match.index, to: match.index + match[0].length,
  }));
}

function boundaryOverlap(left, right) {
  const a = proseTokens(left), b = proseTokens(right);
  for (let count = Math.min(a.length, b.length); count > 0; count--) {
    let matches = true, hasWord = false;
    for (let i = 0; i < count; i++) {
      if (a[a.length - count + i].value !== b[i].value) { matches = false; break; }
      if (/[\p{L}\p{N}]/u.test(b[i].value)) hasWord = true;
    }
    if (matches && hasWord) return { left: a[a.length - count].from, right: b[count - 1].to };
  }
  return { left: left.length, right: 0 };
}

export function trimOverlap(prefix, suggestion) {
  return suggestion.slice(boundaryOverlap(prefix, suggestion).right);
}

// Only remove verbatim context echoes. Short reused phrases remain valid prose.
export function insertionText(before, text, after = '') {
  text = trimOverlap(before, text.trim()).trimStart();
  text = text.slice(0, boundaryOverlap(text, after).left).trimEnd();
  const tokens = proseTokens(text);
  const words = tokens.filter(token => /[\p{L}\p{N}]/u.test(token.value));
  if (words.length >= 5 || (words.length >= 3 && /[.!?…]["”’')\]]*$/u.test(text))) {
    const phrase = ' ' + tokens.map(token => token.value).join(' ') + ' ';
    for (const context of [before, after]) {
      if ((' ' + proseTokens(context).map(token => token.value).join(' ') + ' ').includes(phrase)) return '';
    }
  }
  if (text && !words.length && after.trimStart().startsWith(text)) return '';
  return text;
}


// Sentences that are finished, with offsets. A trailing fragment with no
// terminal punctuation is still being typed and is deliberately left out.
//
// Intl.Segmenter knows abbreviations the naive split does not ("т.д." stays
// whole); what it still splits ("Dr.") it splits the same way the old regex
// did, so this is strictly closer to real sentences. Offsets point at the
// first non-space character of each sentence.
let segmenter;
function sentenceSegmenter() {
  if (segmenter !== undefined) return segmenter;
  try {
    segmenter = typeof Intl !== 'undefined' && Intl.Segmenter
      ? new Intl.Segmenter(undefined, { granularity: 'sentence' })
      : null;
  } catch { segmenter = null; }
  return segmenter;
}

export function completedSentences(document) {
  const seg = sentenceSegmenter();
  if (seg) {
    const out = [];
    for (const { segment, index } of seg.segment(document)) {
      if (!/[.!?…]["'»”’)\]]*\s*$/.test(segment)) continue;
      const text = segment.trim();
      if (!text) continue;
      const from = index + segment.indexOf(text);
      out.push({ text, from, to: from + text.length });
    }
    return out;
  }
  return [...document.matchAll(/[^.!?…\n]*[.!?…]+["'»”’)\]]*/g)]
    .map(match => ({ text: match[0].trim(), from: match.index, to: match.index + match[0].length }))
    .filter(sentence => sentence.text.length > 0);
}
