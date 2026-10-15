export function paragraphRanges(document) {
  return [...document.matchAll(/[^\n]+(?:\n(?!\s*\n)[^\n]+)*/g)]
    .map(match => ({ text: match[0].trim(), from: match.index, to: match.index + match[0].length }));
}

function uniquePosition(document, text) {
  const at = document.indexOf(text);
  return at >= 0 && document.indexOf(text, at + 1) < 0 ? at : -1;
}

// Resolve within the original paragraph first; another copy of a quote is
// never a replacement for an edited anchor. length tracks the live passage.
export function resolveNoteRange(document, note) {
  if (note.para === null) return { from: 0, to: 0, drifted: false, bare: true };
  const paras = paragraphRanges(document);
  const hasAnchor = typeof note.anchor === 'string' && note.anchor.length > 0;
  const para = paras[note.para];
  const anchor = hasAnchor && para && document.slice(para.from, para.to) === note.anchor
    ? para.from : hasAnchor ? uniquePosition(document, note.anchor) : -1;
  const off = Number.isInteger(note.off) && note.off >= 0 ? note.off : 0;
  if (anchor >= 0) {
    const from = anchor + Math.min(off, note.anchor.length);
    if (!note.quote) return { from, to: from, drifted: false, bare: true };
    const matches = document.startsWith(note.quote, from);
    if (Number.isInteger(note.length) && note.length >= 0) {
      const length = note.length === 0 && matches ? note.quote.length : note.length;
      const to = Math.min(from + length, document.length);
      return { from, to, drifted: document.slice(from, to) !== note.quote, bare: from === to };
    }
    // Older notes did not record their selection offset.
    const within = matches ? off : uniquePosition(note.anchor, note.quote);
    if (within >= 0) return { from: anchor + within, to: anchor + within + note.quote.length, drifted: false };
    return { from, to: from, drifted: true, bare: true };
  }
  if (note.quote && !hasAnchor && note.length === undefined) {
    const from = uniquePosition(document, note.quote);
    if (from >= 0) return { from, to: from + note.quote.length, drifted: false };
  }
  const fallback = paras[Math.min(note.para, paras.length - 1)];
  if (!fallback) return null;
  const from = Math.min(fallback.from + off, fallback.to);
  return { from, to: from, drifted: true, bare: true };
}

export function mapNoteAnchors(notes, before, after, changes) {
  const paras = paragraphRanges(after);
  for (const note of notes) {
    if (note.resolved || note.para === null) continue;
    const range = resolveNoteRange(before, note) ?? { from: 0, to: 0 };
    let startAssoc = range.from === range.to && note.quote ? -1 : 1;
    let endAssoc = -1;
    changes.iterChangedRanges((from, to) => {
      if (from <= range.from && to > range.from) startAssoc = -1;
      if (from < range.to && to >= range.to) endAssoc = 1;
    });
    const at = changes.mapPos(range.from, startAssoc);
    const end = range.from === range.to ? at : changes.mapPos(range.to, endAssoc);
    if (!paras.length) {
      note.para = 0; note.off = 0; note.length = 0; note.anchor = '';
      continue;
    }
    let index = paras.findIndex(para => at <= para.to);
    if (index < 0) index = paras.length - 1;
    const para = paras[index];
    note.para = index;
    note.off = Math.max(0, at - para.from);
    note.length = Math.max(0, end - Math.max(at, para.from));
    note.anchor = after.slice(para.from, para.to);
  }
}
