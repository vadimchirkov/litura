// Each result owns its source document and span. Never retarget an old answer
// to whatever happens to be selected now. Conservative invalidation is explicit.
export function replacementTarget(document, target) {
  return target && document === target.document && Number.isInteger(target.from)
    && target.from >= 0 && target.to > target.from
    && document.slice(target.from, target.to) === target.text;
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
// NOTE: kept as a noted option for another place (e.g. history compare or a
// future coloured diff). Rewrite variants currently preview on a plain white
// sheet with no red/green — this helper is not on that path right now.
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
// An unknown baseline (legacy installs) can only answer 'diverged': without
// proof the writer stood still, silence would discard their work.
export function resolveDrift(local, disk, lastDisk) {
  if (local === disk) return 'in-sync';
  if (lastDisk !== undefined && local === lastDisk) return 'fast-forward';
  return 'diverged';
}

// Mark bubble box inside `area` (the writing pane below the header). Above
// the line, clear of its words; below with a gap when the header leaves no
// room above; pinned inside when the pane is narrower than the bubble.
export function clampBubble(x, y, size, area) {
  const width = Math.min(size.w, area.right - area.left);
  const left = Math.max(area.left, Math.min(x - width / 2, area.right - width));
  let top = y - size.h - 4;
  if (top < area.top) top = y + 20;
  if (top + size.h > area.bottom) top = Math.max(area.top, area.bottom - size.h);
  return { left, top };
}
