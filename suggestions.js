import { trimOverlap } from './review.js';

// Shared by the HTTP route and the evaluation runner so they test the same task.
//
// `manual` is the writer pressing Continue rather than the debounce firing.
// Silence is the right answer for something nobody asked for; for an explicit
// press it reads as a broken button, so a finished sentence stops being a
// reason to abstain. The grounding rules do not move — an asked-for
// continuation may invent no more than an offered one.
export function suggestionPrompts({ document = '', cursor = document.length, context, style, manual = false }) {
  const thought = manual
    ? 'Stay on the current thought; when it is already finished, open the next sentence its own line of thought calls for.'
    : 'Stay on the last thought.';
  const silence = manual
    ? 'Return an empty text when the author\'s intent is unclear or continuing would require inventing a fact, source, number, experience or intention. A finished sentence is not itself a reason for silence — the writer asked for the next move.'
    : 'Return an empty text when the thought is complete, the author\'s intent is unclear, or continuing would require inventing a fact, source, number, experience or intention. Silence is better than filler.';
  return {
    systemPrompt: [
      style ? `Follow this writing style guide:\n\n${style}` : '',
      `You are an inline writing assistant. Fill the cursor position without changing existing text.
Match the draft's language, voice, vocabulary, rhythm and factual uncertainty. ${thought}
Let the continuation's length follow how well the material supports it, up to 15 words: a word or punctuation when that finishes the thought, a full clause or sentence when the draft or context clearly carries it further.
${silence}
Complete grammar, punctuation, an unfinished word, or a consequence directly supported by the supplied facts. Never choose a decision or next event for the author. If materially different completions are equally possible, abstain.
Specific wording must come from the supplied material. Reuse the objects actually named by the author; do not introduce a more specific type of an object or an unstated way it works. When the existing words in a quotation form a complete phrase, close the quotation instead of inventing more quoted words.
Do not invent evidence or claims, restate the draft, add generic conclusions, or repeat or contradict the text after the cursor.
Return one line using exactly one of these formats, without commentary or Markdown fences:
NONE — when there is no well-supported continuation (return only the word NONE).
TEXT: followed by new words or punctuation. The editor handles word spacing.
WORD: followed by ONLY the missing letters of the unfinished word immediately before the cursor, then any necessary punctuation. Do not repeat the letters already typed.
Examples: an unknown decision after "We finally agreed to" → NONE.
Prefix "The window was already op" → WORD: en.
Prefix ending in an already complete quoted phrase → TEXT: ”.
The format label is not part of the draft. Preserve the author's quotation marks; they need no escaping.`,
    ].filter(Boolean).join('\n\n---\n\n'),
    userPrompt: [
      context ? `AUTHOR'S MATERIAL:\n${context}` : '',
      `TEXT BEFORE CURSOR:\n${document.slice(0, cursor)}`,
      `TEXT AFTER CURSOR:\n${document.slice(cursor)}`,
    ].filter(Boolean).join('\n\n---\n\n'),
  };
}

export function parseSuggestion(prefix, raw) {
  // Labels avoid making a prose model JSON-escape a closing quotation mark.
  // Invalid output must never become prose in the author's document.
  if (raw.trim() === 'NONE') return '';
  const match = /^(TEXT|WORD):[ \t]*(.+)$/u.exec(raw.trim());
  if (!match) throw new Error('Expected TEXT:, WORD:, or NONE from the continuation model');
  let text = match[2].trim();
  if ((text.match(/\S+/gu) ?? []).length > 15) {
    throw new Error('Continuation must be one line of at most 15 words');
  }
  if (match[1] === 'WORD') {
    if (!/[\p{L}\p{N}\p{M}]$/u.test(prefix) || !/^[\p{L}\p{N}\p{M}]/u.test(text)) {
      throw new Error('Word continuation does not meet an unfinished word');
    }
    return text;
  }
  text = trimOverlap(prefix.trimEnd(), text).trimStart();
  if (!text) return '';
  // Preserve the draft's whitespace. Closing punctuation and contractions
  // attach directly; words after opening punctuation do too.
  const quoteOpen = (prefix.match(/"/gu) ?? []).length % 2 === 1;
  const direct = !prefix || /[\s([{«“‘]$/u.test(prefix) || /(?:^|\s)'$/u.test(prefix)
    || (prefix.endsWith('"') && quoteOpen) || (text.startsWith('"') && quoteOpen)
    || /^[,.;:!?…\)\]}»”’']/u.test(text);
  return (direct ? '' : ' ') + text;
}
