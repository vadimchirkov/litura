# Animation plans

| # | Title | Severity | Status |
| --- | --- | --- | --- |
| 001 | [Open the composer instantly when summoned with Cmd/Ctrl+K](001-instant-keyboard-island.md) | HIGH | DONE |
| 002 | [Add press feedback to the shared action buttons](002-press-feedback.md) | MEDIUM | DONE |

## Recommended order

1. **001** first. It removes motion from the most frequent keyboard path, which is the bigger feel win.
2. **002** second.

## Dependencies

None. Both edit `public/style.css`, in separate regions: 001 around the island rules near line 1923, 002 in the button rules at lines 1166-1576 and 1959-1972. They can run in either order. If they run in parallel, rebase the second before merging.

Both plans were written against commit `e0874b2` with uncommitted edits in the working tree. Re-check line numbers before executing (`improve-animations reconcile`).
