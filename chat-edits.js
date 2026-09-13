// A deliberate response envelope, never commands inferred from prose/Markdown.
export const EDITS_OPEN = '<litura-edits>';
const EDITS_CLOSE = '</litura-edits>';
export const CHAT_EDITS_PROMPT = `
Answer the author's question normally. A selection is context, not an automatic rewrite request.
When proposing concrete replacements, put the actual wording in a final structured envelope,
not in a second copy in your prose. End with exactly:
<litura-edits>[{"label":"Short edit title","quote":"Exact existing passage","replacement":"Complete replacement"}]</litura-edits>
Use valid JSON with escaped quotes and newlines. At most 8 edits; quote at most 10000 characters,
replacement at most 20000 characters, label at most 120. Copy quotes exactly from DRAFT.
Each edit replaces an existing nonempty passage. Prefer the selected passage when relevant.
Outside the selection, quote enough context to uniquely identify the passage. Never guess positions.
Keep independent edits separate. Alternatives for the same quote are mutually exclusive.
Preserve the author's facts and intent; do not invent evidence, decisions or details.
For explanations or abstract advice with no concrete replacement, use an empty array.
Never claim an edit has already been applied. The author chooses Apply or Keep original.
The envelope is application data: never put it in a Markdown code fence or discuss its syntax.
`;

export function chatVisibleText(raw, complete = false) {
  const at = raw.indexOf(EDITS_OPEN);
  if (at >= 0) return raw.slice(0, at).trimEnd();
  if (!complete) {
    for (let n = EDITS_OPEN.length - 1; n > 0; n--) {
      if (raw.endsWith(EDITS_OPEN.slice(0, n))) return raw.slice(0, -n);
    }
  }
  return raw;
}

export function locateChatEdits(items, document, selection = null) {
  if (!Array.isArray(items) || items.length > 8) throw new Error('Invalid edit list');
  return items.map(item => {
    if (!item || typeof item.quote !== 'string' || !item.quote.trim() || item.quote.length > 10000
      || typeof item.replacement !== 'string' || item.replacement.length > 20000
      || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 120
      || item.quote === item.replacement) throw new Error('Invalid proposed edit');
    let from = -1;
    if (selection && Number.isInteger(selection.from) && Number.isInteger(selection.to)
      && selection.from >= 0 && selection.to <= document.length && selection.to > selection.from) {
      const selected = document.slice(selection.from, selection.to);
      const offset = selected.indexOf(item.quote);
      if (offset >= 0 && selected.indexOf(item.quote, offset + 1) < 0) from = selection.from + offset;
    }
    if (from < 0) {
      from = document.indexOf(item.quote);
      if (from < 0 || document.indexOf(item.quote, from + 1) >= 0) {
        return { label: item.label, quote: item.quote, replacement: item.replacement, state: 'unlocated' };
      }
    }
    return { label: item.label, quote: item.quote, replacement: item.replacement, from, to: from + item.quote.length, state: 'pending' };
  });
}

export function parseChatResponse(raw, document, selection) {
  const at = raw.indexOf(EDITS_OPEN);
  if (at < 0) return { text: raw, edits: [] };
  const end = raw.indexOf(EDITS_CLOSE, at + EDITS_OPEN.length);
  if (end < 0 || raw.slice(end + EDITS_CLOSE.length).trim()) throw new Error('Incomplete edit envelope');
  const items = JSON.parse(raw.slice(at + EDITS_OPEN.length, end));
  return { text: chatVisibleText(raw, true), edits: locateChatEdits(items, document, selection) };
}

// Map only through known editor transactions. Never search a changed document
// for another occurrence of an old quote. Insertion at a boundary is outside;
// insertion inside, replacement and deletion invalidate the affected proposal.
export function mapChatEdit(edit, changes) {
  if (!['pending', 'applied', 'kept'].includes(edit.state)) return;
  let touched = false;
  changes.iterChangedRanges((from, to) => {
    if (from === to ? from > edit.from && from < edit.to : from < edit.to && to > edit.from) touched = true;
    if (edit.from === edit.to && from <= edit.from && to >= edit.to) touched = true;
  });
  if (touched) { edit.state = 'stale'; return; }
  const empty = edit.from === edit.to;
  edit.from = changes.mapPos(edit.from, 1);
  edit.to = changes.mapPos(edit.to, empty ? 1 : -1);
}

export function chatEditMatches(edit, document) {
  const expected = edit.state === 'applied' ? edit.replacement : edit.quote;
  return ['pending', 'applied', 'kept'].includes(edit.state)
    && Number.isInteger(edit.from) && Number.isInteger(edit.to)
    && edit.from >= 0 && edit.to >= edit.from && edit.to <= document.length
    && document.slice(edit.from, edit.to) === expected;
}
