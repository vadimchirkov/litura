export function parseReviewResponse(raw) {
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('No findings array in response');
  const value = JSON.parse(match[0]);
  if (!Array.isArray(value)) throw new Error('Expected findings array');
  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const finding = Object.fromEntries(['quote', 'pattern', 'reason', 'fix'].map(key => [key, String(item[key] ?? '').trim()]));
    return Object.values(finding).every(Boolean) ? [finding] : [];
  }).slice(0, 8);
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
  /\bin today'?s [a-z-]+ world\b/i,
  /\bat the end of the day\b/i,
  /\bexperts? (?:agree|say|believe)\b/i,
  /\bstudies show\b/i,
  /\bit is important to note\b/i,
  /\bnot (?:just|only)\b[^.!?]{0,60}\bbut\b/i,
  /\b(?:serves|stands) as a\b/i,
  /\bplays? a (?:vital|crucial|pivotal|key|significant) role\b/i,
  /\bat its core\b/i,
  /\bthe real question is\b/i,
  /\blet'?s (?:dive|explore|break this down)\b/i,
  /\bhere'?s what you need to know\b/i,
  /\ba testament to\b/i,
  /\bevolving landscape\b/i,
  /\bin order to\b/i,
  /\bdue to the fact that\b/i,
];

const WORD_RE = /\p{L}[\p{L}\p{N}'’-]*/gu;

// The word lists are English. On a Cyrillic or other non-Latin draft they would
// report zero tells, so callers must not gate on a score that cannot see them.
export function isLatinScript(text) {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (!letters.length) return true;
  return letters.filter(ch => /[\p{Script=Latin}]/u.test(ch)).length / letters.length > 0.5;
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

  const strong = words.filter(word => TELL_WORDS_STRONG.includes(word)).length;
  const weak = words.filter(word => TELL_WORDS_WEAK.includes(word)).length;
  const phrases = TELL_PHRASES.filter(pattern => pattern.test(text)).length;
  const tells = strong + weak + phrases;
  // Phrases weigh most: "in today's fast-paced world" is a whole tell, `robust`
  // on its own is barely one.
  const tellDensity = words.length ? (strong * 2 + weak + phrases * 4) / words.length : 0;

  return { words: words.length, sentences: lengths.length, burstiness, diversity, repetition, tells, tellDensity };
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

// Models restate the last words before continuing ("…the queue" → "queue began
// draining"). Asking them not to is unreliable; cutting the overlap is not.
export function trimOverlap(prefix, suggestion) {
  const max = Math.min(prefix.length, suggestion.length, 60);
  for (let n = max; n >= 3; n--) {
    if (prefix.slice(-n).toLowerCase() === suggestion.slice(0, n).toLowerCase()) {
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
    while (from >= 0 && taken.some(range => from < range.to && from + finding.quote.length > range.from)) {
      from = document.indexOf(finding.quote, from + 1);
    }
    if (from < 0) continue;
    const range = { ...finding, from, to: from + finding.quote.length };
    taken.push(range);
    located.push(range);
  }
  return located.sort((a, b) => a.from - b.from);
}
