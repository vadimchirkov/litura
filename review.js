import { REVIEW_CODES } from './review-prompt.js';

export function parseReviewResponse(raw) {
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match && /^\s*no (?:strong )?findings?\.?\s*$/i.test(raw)) return [];
  if (!match) throw new Error('No findings array in response');
  const value = JSON.parse(match[0]);
  if (!Array.isArray(value)) throw new Error('Expected findings array');
  return value.map(item => {
    if (!item || typeof item !== 'object') throw new Error('Each finding must be an object');
    const fields = ['quote', 'pattern', 'reason', 'fix'];
    if (!fields.every(key => typeof item[key] === 'string' && item[key].trim())) {
      throw new Error('Each finding needs non-empty quote, pattern, reason, and fix strings');
    }
    const finding = Object.fromEntries(fields.map(key => [key, item[key].trim()]));
    const code = String(item.code ?? '').trim();
    return { code: REVIEW_CODES.includes(code) ? code : 'unclassified', ...finding };
  }).slice(0, 8);
}

export function validateReviewFindings(findings, allowedCodes = REVIEW_CODES, source) {
  for (const finding of findings) {
    if (!allowedCodes.includes(finding.code)) throw new Error(`Code ${finding.code} is outside this pass; allowed: ${allowedCodes.join(', ')}`);
    if (source !== undefined && !source.includes(finding.quote)) throw new Error('Quote must be copied exactly from the passages being audited');
  }
}

export function mergeReviewFindings(groups) {
  const findings = groups.flat();
  const promises = findings.filter(finding => finding.code === 'level-3-index-discussion');
  const seen = [];
  return findings.filter(finding => {
    // Both passes can diagnose the same opening list. Its broken promise owns
    // the finding; retain key-term findings elsewhere in the document.
    if (finding.code === 'level-6-key-terms' && promises.some(promise =>
      promise.quote.includes(finding.quote) || finding.quote.includes(promise.quote))) return false;
    if (seen.some(other => other.code === finding.code &&
      (other.quote.includes(finding.quote) || finding.quote.includes(other.quote)))) return false;
    seen.push(finding);
    return true;
  });
}

// ─── Local style scoring ─────────────────────────────────────────────────────
//
//  A cheap, deterministic read on how much a passage smells of AI, computed
//  without a model call. Two uses: a live readout for the writer, and a filter
//  that keeps obviously-clean sentences from costing a review request.
//
//  Word lists and anchors below are heuristics, not trained thresholds.

const TELL_WORDS_STRONG = [
  'delve', 'delves', 'delving', 'tapestry', 'testament', 'underscore', 'underscores',
  'underscoring', 'leverage', 'leverages', 'leveraging', 'multifaceted', 'realm',
  'interplay', 'seamless', 'seamlessly', 'groundbreaking', 'nestled',
];

const TELL_WORDS_WEAK = [
  'crucial', 'pivotal', 'vibrant', 'robust', 'foster', 'fosters', 'fostering',
  'enhance', 'enhances', 'enhancing', 'showcase', 'showcases', 'showcasing',
  'garner', 'bolster', 'utilize', 'utilizes', 'moreover', 'furthermore', 'notably',
  'transformative', 'innovative', 'boasts', 'renowned', 'breathtaking', 'stunning',
];

const TELL_PHRASES = [
  [/\bin today'?s [a-z-]+ world\b/i, 'A broad opening can delay the point.', 'Start with the concrete subject instead of a broad setup.'],
  [/\bat the end of the day\b/i, 'This stock summary can add padding.', 'State the conclusion directly.'],
  [/\bexperts? (?:agree|say|believe)\b/i, 'The experts are not named in this phrase.', 'Use a source already identified in the draft, or qualify the claim. Never invent a source.'],
  [/\bstudies show\b/i, 'The studies are not identified in this phrase.', 'Use research already identified in the draft, or qualify the claim. Never invent evidence.'],
  [/\bit is important to note\b/i, 'This announces importance before giving the information.', 'Let the information carry its own importance.'],
  [/\bnot (?:just|only)\b[^.!?]{0,60}\bbut\b/i, 'Check whether both sides of this contrast add meaning.', 'Simplify the contrast only if it adds no useful distinction.'],
  [/\b(?:serves|stands) as a\b/i, 'An indirect phrase may hide a simpler verb.', 'Use a direct verb that fits the sentence.'],
  [/\bplays? a (?:vital|crucial|pivotal|key|significant) role\b/i, 'Importance is asserted without naming the contribution here.', 'Name the contribution using only details already in the draft.'],
  [/\bat its core\b/i, 'This framing phrase may delay the point.', 'State the point directly.'],
  [/\bthe real question is\b/i, 'This can frame a question instead of getting to it.', 'Ask the question directly, preserving any meaningful contrast.'],
  [/\blet'?s (?:dive|explore|break this down)\b/i, 'This narrates the explanation before it starts.', 'Begin the explanation directly.'],
  [/\bhere'?s what you need to know\b/i, 'This introduction may repeat what the reader expects.', 'Lead with the information itself.'],
  [/\ba testament to\b/i, 'This praise may be less useful than concrete evidence.', 'Describe what the example demonstrates without adding facts.'],
  [/\bevolving landscape\b/i, 'This metaphor does not say what is changing.', 'Name the change if the draft supplies it; otherwise use plainer wording.'],
  [/\bin order to\b/i, 'The purpose usually stays clear with fewer words.', 'Use a shorter expression such as “to” if the grammar allows it.'],
  [/\bdue to the fact that\b/i, 'A long phrase introduces a simple cause.', 'Use a direct causal link such as “because” if the grammar allows it.'],
  [/\b(?:dashboard|data|design|roadmap|platform|system|tool|app|algorithm) (?:understands?|knows?|decides?|wants?|believes?|cares?)\b/i, 'Check whether this describes real behavior or gives an object human intentions.', 'Describe the observable behavior supported by the draft.'],
  [/\b(?:could|may|might|arguably|potentially|possibly)(?:\s+\w+){0,2}\s+(?:potentially|possibly|arguably|perhaps|may|might)\b/i, 'Several qualifiers may express the same uncertainty.', 'Keep the necessary uncertainty with fewer qualifiers.'],
  [/(?:["“][^"”\n]{1,24}["”][\s,]*){3,}|\b[A-Z]{3,}(?:\s+[A-Z]{3,}){2,}\b/, 'Clustered emphasis can compete with the words themselves.', 'Reduce decorative emphasis while preserving names, actual quotations, and meaning.'],
];

const WORD_RE = /\p{L}[\p{L}\p{N}'’-]*/gu;

// The word lists are English. On a Cyrillic or other non-Latin draft they would
// report zero tells, so callers must not gate on a score that cannot see them.
export function isLatinScript(text) {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (!letters.length) return true;
  return letters.filter(ch => /[\p{Script=Latin}]/u.test(ch)).length / letters.length > 0.5;
}

// Keep exact offsets and every occurrence for editor navigation. Phrase marks
// own any tell words inside them, so one expression gets one underline.
export function styleMarkers(text) {
  if (!isLatinScript(text)) return [];
  const phrases = TELL_PHRASES.flatMap(([pattern, reason, fix]) =>
    [...text.matchAll(new RegExp(pattern.source, pattern.flags + 'g'))]
      .map(match => ({ from: match.index, to: match.index + match[0].length, quote: match[0], reason, fix })));
  const words = [...text.matchAll(WORD_RE)]
    .filter(match => TELL_WORDS_STRONG.includes(match[0].toLowerCase()) || TELL_WORDS_WEAK.includes(match[0].toLowerCase()))
    .map(match => ({ from: match.index, to: match.index + match[0].length, quote: match[0],
      reason: 'This word can sound generic. Keep it if its precise meaning matters here.',
      fix: 'Make this wording more direct and specific in its sentence without changing its meaning.' }))
    .filter(word => !phrases.some(phrase => word.from < phrase.to && word.to > phrase.from));
  const markers = [];
  for (const marker of [...phrases, ...words].sort((a, b) => a.from - b.from || b.to - a.to)) {
    if (!markers.length || marker.from >= markers.at(-1).to) markers.push(marker);
  }
  return markers;
}

// Dismissal belongs to the passage, so edits in another paragraph do not bring
// it back. A changed paragraph can be reviewed again in its new context.
export function findingContext(document, finding) {
  const from = Number.isInteger(finding.from) ? finding.from : document.indexOf(finding.quote);
  if (from < 0 || document.slice(from, from + finding.quote.length) !== finding.quote) return null;
  const before = document.slice(0, from);
  const after = document.slice(from + finding.quote.length);
  const start = [...before.matchAll(/\n\s*\n/g)].at(-1);
  const end = after.search(/\n\s*\n/);
  return document.slice(start ? start.index + start[0].length : 0,
    end < 0 ? document.length : from + finding.quote.length + end).trim();
}

function splitAllSentences(text) {
  return text.split(/(?<=[.!?…])\s+|\n+/).map(part => part.trim()).filter(Boolean);
}

export function styleMetrics(text) {
  const words = (text.match(WORD_RE) ?? []).map(word => word.toLowerCase());
  const sentences = splitAllSentences(text);
  const lengths = sentences.map(sentence => (sentence.match(WORD_RE) ?? []).length).filter(Boolean);

  const mean = lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0;
  const variance = lengths.length > 1
    ? lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length
    : 0;
  // Coefficient of variation of sentence length. Human prose swings; AI prose
  // settles into an even mid-length cadence.
  const burstiness = mean ? Math.sqrt(variance) / mean : 0;

  // Moving-average type-token ratio: lexical variety that does not sag purely
  // because the text got longer, unlike raw TTR.
  const window = 50;
  let diversity;
  if (words.length <= window) {
    diversity = words.length ? new Set(words).size / words.length : 0;
  } else {
    let sum = 0;
    for (let i = 0; i + window <= words.length; i++) {
      sum += new Set(words.slice(i, i + window)).size / window;
    }
    diversity = sum / (words.length - window + 1);
  }

  let repetition = 0;
  if (words.length >= 3) {
    const grams = [];
    for (let i = 0; i + 3 <= words.length; i++) grams.push(words.slice(i, i + 3).join(' '));
    repetition = 1 - new Set(grams).size / grams.length;
  }

  const strongHits = words.filter(word => TELL_WORDS_STRONG.includes(word));
  const weakHits = words.filter(word => TELL_WORDS_WEAK.includes(word));
  // The matched text itself, not the pattern — a score the writer cannot trace
  // back to words in their own draft is just a number to argue with.
  const phraseHits = TELL_PHRASES.map(([pattern]) => text.match(pattern)?.[0]).filter(Boolean);
  const strong = strongHits.length;
  const weak = weakHits.length;
  const phrases = phraseHits.length;
  const tells = strong + weak + phrases;
  const hits = [...new Set([...phraseHits, ...strongHits, ...weakHits].map(hit => hit.trim()))];
  // Phrases weigh most: "in today's fast-paced world" is a whole tell, `robust`
  // on its own is barely one.
  const tellDensity = words.length ? (strong * 2 + weak + phrases * 4) / words.length : 0;

  return { words: words.length, sentences: lengths.length, burstiness, diversity, repetition, tells, tellDensity, hits };
}

const ANCHORS = { burstinessHuman: 0.6, diversityLow: 0.3, diversityHigh: 0.72, repetitionMax: 0.18, tellMax: 0.05 };
const WEIGHTS = { tells: 0.45, burstiness: 0.25, diversity: 0.17, repetition: 0.13 };

// 0 = reads clean, 100 = every axis maxed. Structural axes need a paragraph to
// mean anything, so on short passages the score leans on the lexical axis alone.
export function styleScore(text) {
  const metrics = styleMetrics(text);
  if (!metrics.words) return { ...metrics, score: 0, structural: false };

  const clamp = value => Math.max(0, Math.min(1, value));
  const lexical = clamp(metrics.tellDensity / ANCHORS.tellMax);
  const structural = metrics.words >= 40 && metrics.sentences >= 3;

  if (!structural) {
    return { ...metrics, score: Math.round(100 * lexical), structural };
  }

  const raw =
    WEIGHTS.tells * lexical +
    WEIGHTS.burstiness * clamp((ANCHORS.burstinessHuman - metrics.burstiness) / ANCHORS.burstinessHuman) +
    WEIGHTS.diversity * clamp((ANCHORS.diversityHigh - metrics.diversity) / (ANCHORS.diversityHigh - ANCHORS.diversityLow)) +
    WEIGHTS.repetition * clamp(metrics.repetition / ANCHORS.repetitionMax);
  return { ...metrics, score: Math.round(100 * raw), structural };
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
  return variants;
}

// Models restate the last words before continuing ("…the queue" → "queue began
// draining"). Asking them not to is unreliable; cutting the overlap is not.
export function trimOverlap(prefix, suggestion) {
  const max = Math.min(prefix.length, suggestion.length, 60);
  for (let n = max; n >= 3; n--) {
    if (prefix.slice(-n).toLowerCase() === suggestion.slice(0, n).toLowerCase()
      && !/[\p{L}\p{N}\p{M}_]/u.test(prefix.at(-n - 1) ?? '')
      && !/[\p{L}\p{N}\p{M}_]/u.test(suggestion[n] ?? '')) {
      return suggestion.slice(n);
    }
  }
  return suggestion;
}

// Sentences that are finished, with offsets. A trailing fragment with no
// terminal punctuation is still being typed and is deliberately left out.
// ponytail: naive split, "т.д." and "Dr." break it — swap in Intl.Segmenter
// if false splits ever cost a real review.
export function completedSentences(document) {
  return [...document.matchAll(/[^.!?…\n]*[.!?…]+["'»”’)\]]*/g)]
    .map(match => ({ text: match[0].trim(), from: match.index, to: match.index + match[0].length }))
    .filter(sentence => sentence.text.length > 0);
}

// Anchor each quote to a free spot in the document. `occupied` holds ranges
// already carrying a finding — incremental reviews must not double-mark them.
export function locateFindings(document, findings, occupied = []) {
  const taken = occupied.map(({ from, to }) => ({ from, to }));
  const located = [];
  for (const finding of findings) {
    let from = document.indexOf(finding.quote);
    while (from >= 0 && taken.some(range => (!range.code || range.code === finding.code) && from < range.to && from + finding.quote.length > range.from)) {
      from = document.indexOf(finding.quote, from + 1);
    }
    if (from < 0) continue;
    const range = { ...finding, from, to: from + finding.quote.length };
    taken.push(range);
    located.push(range);
  }
  return located.sort((a, b) => a.from - b.from);
}
