# 002 — Add press feedback to the shared action buttons

- **Status**: DONE
- **Commit**: e0874b2 (working tree had uncommitted edits to `public/style.css`; line numbers below are from that tree)
- **Severity**: MEDIUM
- **Category**: Physicality & origin (missing press feedback)
- **Estimated scope**: 1 file, ~15 lines

## Problem

No button in the app has a pressed state. `public/style.css` contains zero `:active` rules. Clicking Send, Yes or No, Undo, Retry or a drift-banner action gives no confirmation that the interface heard the press until the result arrives, which for model calls can take seconds.

Four classes cover every action button in the conversation panel, finding cards and banners:

```css
/* public/style.css:1959-1972 — .chat-send (send / stop), transition line current */
  transition: opacity .12s ease, background .12s ease;           /* line 1971 */

/* public/style.css:1166-1181 — .review-action (drift banner Load disk / Keep mine) */
  transition: background .12s ease, border-color .12s ease;      /* line 1180 */

/* public/style.css:1530-1543 — .chat-action (Yes, Retry, Undo, Open settings) */
  transition: background .12s ease, color .12s ease;             /* line 1542 */

/* public/style.css:1562-1575 — .chat-dismiss (No, Dismiss) */
  transition: background .12s ease, color .12s ease;             /* line 1574 */
```

These are clicked tens of times a day with a pointer (Enter covers most sends), so the feedback must be subtle and fast.

## Target

A pressed, enabled button scales to `0.97` over `160ms`, using the repo's ease-out token `--ease` (`cubic-bezier(.16, 1, .3, 1)`, defined in `public/style.css` under `:root`). Disabled buttons never scale.

The press is gated on `prefers-reduced-motion: no-preference`. Under reduced motion there is no scale at all, and the existing background and color changes stay as the feedback. That matters because the global reduced-motion rule (`public/style.css:478-480`) sets `transition: none !important`, so an ungated scale would snap instead of easing.

```css
/* target — append `transform 160ms var(--ease)` to each existing list */
.chat-send     { transition: opacity .12s ease, background .12s ease, transform 160ms var(--ease); }
.review-action { transition: background .12s ease, border-color .12s ease, transform 160ms var(--ease); }
.chat-action   { transition: background .12s ease, color .12s ease, transform 160ms var(--ease); }
.chat-dismiss  { transition: background .12s ease, color .12s ease, transform 160ms var(--ease); }

/* target — one new block, placed directly after the .chat-dismiss rule */
/* A press is acknowledged at once, before any model call answers. */
@media (prefers-reduced-motion: no-preference) {
  .chat-send:not(:disabled):active,
  .review-action:not(:disabled):active,
  .chat-action:not(:disabled):active,
  .chat-dismiss:not(:disabled):active { transform: scale(0.97); }
}
```

These are not full rule replacements. Edit only the `transition:` line inside each existing rule.

## Repo conventions to follow

- Motion tokens live in `:root` in `public/style.css` (`--ease`, `--island-*`, `--dropdown-*`, `--tt-*`). Use `var(--ease)` and do not add a new curve.
- Media-query-gated interaction styles are written as a wrapped block next to the component. Exemplar: `@media (pointer: coarse) { .review-action, .style-marker-jump { min-height: 44px; } }` near `.chat-edit-status`, and the `@media (hover: hover) { … }` wrappers throughout the file.
- Durations in this file are mostly written as `.12s`. Write this one as `160ms` exactly, as shown.

## Steps

1. `public/style.css:1971`: change `transition: opacity .12s ease, background .12s ease;` to `transition: opacity .12s ease, background .12s ease, transform 160ms var(--ease);`.
2. `public/style.css:1180`: change `transition: background .12s ease, border-color .12s ease;` to `transition: background .12s ease, border-color .12s ease, transform 160ms var(--ease);`.
3. `public/style.css:1542`, inside `.chat-action { … }`: change `transition: background .12s ease, color .12s ease;` to `transition: background .12s ease, color .12s ease, transform 160ms var(--ease);`.
4. `public/style.css:1574`, inside `.chat-dismiss { … }`: make the same change as step 3.
5. Directly after the closing `}` of the `.chat-dismiss { … }` rule (around line 1576), insert the comment and the `@media (prefers-reduced-motion: no-preference)` block from **Target**, verbatim.

## Boundaries

- Do NOT add press scale to `.chat-pill`, `.recipe`, file rows, sidebar actions, settings dialog buttons or combo items. Those are either high-frequency, already have their own motion, or are out of scope.
- Do NOT use `scale` below `0.97`. Do NOT use `transition: all`.
- Do NOT touch the `.chat-send .ph` / `.chat-stop` icon cross-fade rules (`public/style.css:1987-2013`). They animate children, not the button.
- Do NOT add dependencies or JS.
- If a quoted `transition:` line does not match what you find, STOP and report.

## Verification

- **Mechanical**: `grep -c ":not(:disabled):active" public/style.css` prints `4`. `npm run check` exits 0.
- **Feel check**: `npm start`, open `http://127.0.0.1:3000`:
  - Hold the mouse button down on Send (type something first so it is enabled). The button visibly settles slightly smaller. On release it returns within 160ms with no bounce.
  - Press Send with the field empty (disabled). It does not move.
  - On a finding's options, press and hold Yes, then No. Both dip the same way.
  - In DevTools' Animations panel at 10% playback, the transition is on `transform` only, 160ms, ease-out. Nothing shifts the layout around the button.
  - In the Rendering panel, emulate `prefers-reduced-motion: reduce`. Pressing produces no scale, and the hover background change still shows.
- **Done when**: all four button classes dip to 0.97 on press when enabled, stay still when disabled or under reduced motion, and `npm run check` passes.
