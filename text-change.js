// A minimal replacement for snapshots; live edits retain their exact ChangeSets.
export function textChange(before, after) {
  let from = 0, to = before.length, end = after.length;
  while (from < to && from < end && before[from] === after[from]) from++;
  while (to > from && end > from && before[to - 1] === after[end - 1]) { to--; end--; }
  return { from, to, insert: after.slice(from, end) };
}

export function changesOverlap(left, right) {
  let overlap = false;
  left.iterChangedRanges((a, b) => right.iterChangedRanges((c, d) => {
    if (a === b && c === d ? a === c : a === b ? a > c && a < d : c === d ? c > a && c < b : a < d && b > c) overlap = true;
  }));
  return overlap;
}
