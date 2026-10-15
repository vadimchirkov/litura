import { paragraphRanges, resolveNoteRange } from './notes.js';

export function queueNote(note, kind = note.work?.kind || 'rewrite') {
  note.resolved = false;
  note.work = { ...note.work, kind, status: 'queued', generation: (note.work?.generation || 0) + 1, claim: null, error: null };
}

export function noteTarget(document, note) {
  if (note.para === null) return null;
  const range = resolveNoteRange(document, note);
  if (!range || range.drifted) throw new Error('This note moved or its passage changed. Check its target and regenerate.');
  const para = paragraphRanges(document)[note.para];
  const from = note.quote ? range.from : para.from, to = note.quote ? range.to : para.to;
  return { from, to, text: document.slice(from, to) };
}

export function anchorPassage(note, document, from, to) {
  const paras = paragraphRanges(document);
  let para = paras.findIndex(item => from <= item.to);
  if (para < 0) para = Math.max(0, paras.length - 1);
  note.para = para; note.off = Math.max(0, from - (paras[para]?.from || 0));
  note.length = to - from; note.quote = document.slice(from, to);
  note.anchor = paras[para] ? document.slice(paras[para].from, paras[para].to) : '';
}

export function mapWork(notes, changes) {
  for (const note of notes) for (const attempt of note.work?.attempts || []) {
    if (!['applied', 'accepted'].includes(attempt.status)) continue;
    for (const edit of attempt.edits) {
      if (!edit.valid) continue;
      changes.iterChangedRanges((from, to) => {
        if (edit.from === edit.to ? from <= edit.from && to >= edit.to : from === to ? from > edit.from && from < edit.to : from < edit.to && to > edit.from) edit.valid = false;
      });
      const empty = edit.from === edit.to;
      edit.from = changes.mapPos(edit.from, 1);
      edit.to = changes.mapPos(edit.to, empty ? 1 : -1);
    }
  }
}

export function reversible(attempt, document) {
  return attempt && ['applied', 'accepted'].includes(attempt.status) && attempt.edits.length > 0
    && attempt.edits.every(edit => edit.valid && document.slice(edit.from, edit.to) === edit.after);
}

export function resultEdits(ranges) {
  let delta = 0;
  return ranges.map(range => {
    const from = range.from + delta; delta += range.text.length - (range.to - range.from);
    return { from, to: from + range.text.length, before: range.old, after: range.text, valid: true };
  });
}
