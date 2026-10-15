// Each result owns its source document and span. Never retarget an old answer
// to whatever happens to be selected now. Conservative invalidation is explicit.
// An empty span is an insertion point (used by composer /idea): it stays
// valid only while the document is untouched, like any other span.
export function replacementTarget(document, target) {
  if (!target || document !== target.document || !Number.isInteger(target.from)
    || target.from < 0 || target.to < target.from) return false;
  if (target.to === target.from) return target.text === '';
  return document.slice(target.from, target.to) === target.text;
}

// Every range belongs to the original document: replacements never cascade.
export function patchRanges(document, edits) {
  if (!Array.isArray(edits) || !edits.length) throw new Error('At least one patch is required');
  const ranges = [];
  for (const edit of edits) {
    if (!edit || typeof edit.old !== 'string' || !edit.old || typeof edit.new !== 'string') throw new Error('Each patch requires nonempty old and string new');
    if (edit.from !== undefined && (!Number.isInteger(edit.from) || edit.from < 0 || edit.all)) throw new Error('Use a valid from offset or all, not both');
    const matches = [];
    if (edit.from !== undefined) {
      if (document.slice(edit.from, edit.from + edit.old.length) === edit.old) matches.push(edit.from);
    } else {
      for (let at = document.indexOf(edit.old); at >= 0; at = document.indexOf(edit.old, at + (edit.all ? edit.old.length : 1))) {
        matches.push(at);
        if (matches.length + ranges.length > 10_000) throw new Error('A batch supports at most 10,000 replacements; split the edits');
        if (!edit.all && matches.length > 1) break;
      }
    }
    if (!matches.length) throw new Error('Patch old text not found');
    if (!edit.all && matches.length !== 1) throw new Error('Patch old text is ambiguous; supply from or all: true');
    for (const from of matches) ranges.push({ from, to: from + edit.old.length, text: edit.new });
  }
  ranges.sort((a, b) => a.from - b.from);
  let end = 0;
  for (const range of ranges) {
    if (range.from < end) throw new Error('Patch ranges overlap');
    end = range.to;
  }
  return ranges;
}

export function newerVersion(latest, current) {
  const parse = value => /^(\d+)\.(\d+)\.(\d+)$/.exec(value ?? '')?.slice(1).map(Number);
  const a = parse(latest), b = parse(current);
  if (!a || !b) return false; // Stable-release notifications only.
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

// Word-level edit script: which words a rewrite keeps, drops and adds, in
// reading order, so the change can be shown one word at a time instead of as
// one opaque block. Spaces the rewrite did not touch stay untouched.
//
// ponytail: plain LCS table, O(words²) — a sentence or a paragraph, not a
// book. Past the guard it falls back to a single changed run, which is what
// the coarse version always did.
export function wordDiff(before, after) {
  const a = before.match(/\s+|\S+/g) ?? [], b = after.match(/\s+|\S+/g) ?? [];
  if (a.length * b.length > 40_000) return coarseDiff(a, b);
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops = [];
  const push = (type, text) => {
    const last = ops[ops.length - 1];
    if (last && last.type === type) last.text += text;   // one run, one step
    else ops.push({ type, text });
  };
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) push('keep', a[i++]), j++;
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) push('del', a[i++]);
    else push('ins', b[j++]);
  }
  while (i < a.length) push('del', a[i++]);
  while (j < b.length) push('ins', b[j++]);
  return ops;
}

function coarseDiff(a, b) {
  let start = 0, end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (end < a.length - start && end < b.length - start && a[a.length - end - 1] === b[b.length - end - 1]) end++;
  return [
    { type: 'keep', text: a.slice(0, start).join('') },
    { type: 'del', text: a.slice(start, a.length - end).join('') },
    { type: 'ins', text: b.slice(start, b.length - end).join('') },
    { type: 'keep', text: end ? a.slice(-end).join('') : '' },
  ].filter(op => op.text);
}

// Whose turn it is when the disk copy moved under the editor. lastDisk is
// the text we last confirmed on disk (durable across restarts); local is
// the editor now, disk is freshly read. No merge exists, only a verdict:
// - 'in-sync': nothing to do, adopt the fresh revision quietly.
// - 'fast-forward': the writer changed nothing since the last save — take
//   the disk copy silently, no question asked.
// - 'diverged': both sides moved since the baseline — ask, but never modal.
// An unknown baseline can only answer 'diverged': without
// proof the writer stood still, silence would discard their work.
export function resolveDrift(local, disk, lastDisk) {
  if (local === disk) return 'in-sync';
  if (lastDisk !== undefined && local === lastDisk) return 'fast-forward';
  return 'diverged';
}

// Mark bubble box inside `area` (the writing pane below the header). `top` and
// `bottom` are the edges of the text the bubble acts on: it stands above that
// text with a gap, so the words stay readable under it; below the text when the
// header leaves no room above; pinned inside when the pane is narrower than the
// bubble. `side` says which, so the entrance can come from the text.
export const BUBBLE_GAP = 8;
export function clampBubble(x, top, size, area, bottom = top) {
  const width = Math.min(size.w, area.right - area.left);
  const left = Math.max(area.left, Math.min(x - width / 2, area.right - width));
  let y = top - BUBBLE_GAP - size.h, side = 'above';
  if (y < area.top) { y = bottom + BUBBLE_GAP; side = 'below'; }
  if (y + size.h > area.bottom) y = Math.max(area.top, area.bottom - size.h);
  return { left, top: y, side };
}

// A source line that is plain prose, not Markdown structure. Anything
// structural — headings, lists, quotes, fences, tables, rules, HTML, indented
// code, or an explicit hard break (two trailing spaces, backslash) — keeps its
// line breaks; only wrapped prose paragraphs are joined.
function isProseLine(line) {
  if (/ {2}$/.test(line) || /\\$/.test(line)) return false;
  if (/^ {4}|\t/.test(line)) return false;
  if (/^\s*(#{1,6}\s|>\s?|[-*+]\s+|\d+[.)]\s+|\||---|\*\*\*|___|<[A-Za-z/!])/.test(line)) return false;
  return true;
}

// Hard-wrapped prose (one visual line per source line, e.g. 80-column wraps)
// reads in the editor exactly as it sits in the file: every wrap is a visible
// break mid-sentence. Markdown treats a lone newline as a space, so join the
// lines of plain multi-line paragraphs back into flowing text. Blank-line
// paragraph breaks and every structural block stay untouched.
// Returns { text, joined } — joined counts the line breaks that were removed.
// When nothing joins, text is the input unchanged (line endings included), so
// already-flowed files are never marked dirty by opening them.
export function unwrapProse(source) {
  const input = String(source ?? '');
  const lines = input.split('\n');
  const out = [];
  let joined = 0;
  let para = [];
  let inFence = false;
  const flush = () => {
    if (!para.length) return;
    if (para.length > 1 && para.every(isProseLine)) {
      out.push(para.map(line => line.replace(/\r$/, '').trimEnd()).join(' '));
      joined += para.length - 1;
    } else {
      out.push(...para);
    }
    para = [];
  };
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) { flush(); inFence = !inFence; out.push(line); continue; }
    if (inFence) { out.push(line); continue; }
    if (!line.trim()) { flush(); out.push(line); continue; }
    para.push(line);
  }
  flush();
  return { text: joined ? out.join('\n') : input, joined };
}
