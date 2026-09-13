import nspell from 'nspell';
import { WORD_RE, isLatinScript } from './review.js';

// Vendored en_US Hunspell dictionary at public/dictionary/, served as static
// files so the desktop build's single-file server bundle needs nothing extra
// on disk. See public/dictionary/LICENSE.
let cached = null;
export function loadSpellDictionary() {
  return cached ??= Promise.all([
    fetch('/dictionary/en.aff').then(res => res.text()),
    fetch('/dictionary/en.dic').then(res => res.text()),
  ]).then(([aff, dic]) => nspell(aff, dic));
}

// English only, same scope as the style-tell word lists in review.js. All-caps
// tokens are skipped: acronyms outnumber real typos among them.
export function spellingMarkers(text, spell) {
  if (!spell || !isLatinScript(text)) return [];
  return [...text.matchAll(WORD_RE)]
    .filter(match => match[0].length > 1 && !/^[A-Z]+$/.test(match[0]) && !spell.correct(match[0]))
    .map(match => ({ from: match.index, to: match.index + match[0].length, quote: match[0] }));
}
