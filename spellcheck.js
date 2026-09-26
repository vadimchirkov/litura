import nspell from 'nspell';
import { WORD_RE, isLatinScript } from './review.js';

// Vendored en_US Hunspell dictionary at public/dictionary/, served as static
// files so the desktop build's single-file server bundle needs nothing extra
// on disk. See public/dictionary/LICENSE.
let cached = null;
export function loadSpellDictionary() {
  return cached ??= Promise.all([
    fetch('/dictionary/en.aff').then(res => {
      if (!res.ok) throw new Error(`Dictionary request failed: ${res.status}`);
      return res.text();
    }),
    fetch('/dictionary/en.dic').then(res => {
      if (!res.ok) throw new Error(`Dictionary request failed: ${res.status}`);
      return res.text();
    }),
  ]).then(([aff, dic]) => nspell(aff, dic)).catch(error => {
    // A failed load must not stick forever: the next call retries.
    cached = null;
    throw error;
  });
}

// Known-good words are stable for the dictionary lifetime, so a long draft
// does not re-check every "the" on each keystroke. Misses are not cached:
// they are rare, and Ignore flips them via noteSpellingAdded.
const knownGood = new Set();
export function noteSpellingAdded(word) {
  knownGood.delete(String(word));
}
// English only, same scope as the style-tell word lists in review.js. All-caps
// tokens are skipped: acronyms outnumber real typos among them.
export function spellingMarkers(text, spell) {
  if (!spell || !isLatinScript(text)) return [];
  const out = [];
  for (const match of text.matchAll(WORD_RE)) {
    const word = match[0];
    if (word.length < 2 || /^[A-Z]+$/.test(word)) continue;
    if (!knownGood.has(word) && spell.correct(word)) {
      if (knownGood.size > 5000) knownGood.clear();
      knownGood.add(word);
    }
    if (!knownGood.has(word)) out.push({ from: match.index, to: match.index + word.length, quote: word });
  }
  return out;
}
