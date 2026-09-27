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
// Quoted material is not prose: a word inside a code span or a URL is
// something the writer copied rather than wrote, and a general English
// dictionary has no entry for `npx`, `js` or a repository name. On a document
// with installation instructions this is the difference between a handful of
// marks and a hundred. Ranges are collected once and walked with a cursor, so
// a long draft stays linear.
const QUOTED_RE = /```[\s\S]*?```|`[^`\n]*`|https?:\/\/\S+/g;
function quotedRanges(text) {
  const out = [];
  for (const match of text.matchAll(QUOTED_RE)) out.push([match.index, match.index + match[0].length]);
  return out;
}
// English only, same scope as the style-tell word lists in review.js. All-caps
// tokens are skipped: acronyms outnumber real typos among them. Tokens with a
// digit in them are skipped for the same reason — `F8`, `mp3`, `utf8` are not
// misspellings of anything. A hyphenated compound is checked as its parts,
// because that is what a dictionary holds: `distraction-free` is two known
// words, and only one of them could be the typo.
export function spellingMarkers(text, spell) {
  if (!spell || !isLatinScript(text)) return [];
  const out = [];
  const quoted = quotedRanges(text);
  let cursor = 0;
  const isQuoted = at => {
    while (cursor < quoted.length && quoted[cursor][1] <= at) cursor++;
    const range = quoted[cursor];
    return range !== undefined && at >= range[0] && at < range[1];
  };
  const check = (word, at) => {
    if (word.length < 2 || /^[A-Z]+$/.test(word)) return;
    if (!knownGood.has(word) && spell.correct(word)) {
      if (knownGood.size > 5000) knownGood.clear();
      knownGood.add(word);
    }
    if (!knownGood.has(word)) out.push({ from: at, to: at + word.length, quote: word });
  };
  for (const match of text.matchAll(WORD_RE)) {
    const token = match[0];
    if (/\p{N}/u.test(token) || isQuoted(match.index)) continue;
    let at = match.index;
    for (const part of token.split('-')) {
      check(part, at);
      at += part.length + 1;
    }
  }
  return out;
}
