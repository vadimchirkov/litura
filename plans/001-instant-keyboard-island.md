# 001 — Open the composer instantly when summoned with Cmd/Ctrl+K

- **Status**: DONE
- **Commit**: e0874b2 (working tree had uncommitted edits to `src/app.js` and `public/style.css`; line numbers below are from that tree)
- **Severity**: HIGH
- **Category**: Purpose & frequency
- **Estimated scope**: 2 files, ~15 lines

## Problem

Cmd/Ctrl+K is the keyboard path into the assistant. A writer hits it constantly. It is also the case where animation hurts most. Today the shortcut runs the same open choreography as a pointer click on the pill:

1. A 450ms Web Animations clip-path morph from the pill's outline to the composer's, driven by a MutationObserver on the panel's class:

```js
/* src/app.js:2356 — current */
const ISLAND_MORPH = { duration: 450, easing: 'cubic-bezier(.32, .72, 0, 1)' };
```

```js
/* src/app.js:2364-2380 — current */
new MutationObserver(() => {
  const next = islandView();
  if (!next || next === islandShown) return;
  const prev = islandShown;
  islandShown = next;
  const to = next.getBoundingClientRect();
  let from = prev?.getBoundingClientRect();
  if (!from?.width) from = islandRect;
  islandRect = to.width ? to : islandRect;
  if (reduceMotion() || !from?.width || !to.width) return;
  const inset = (box, of) => `inset(${box.top - of.top}px ${of.right - box.right}px ${of.bottom - box.bottom}px ${box.left - of.left}px round ${box.height / 2}px)`;
  const open = el => `inset(-60px round ${getComputedStyle(el).borderTopLeftRadius})`;
  next.animate([{ clipPath: inset(from, to) }, { clipPath: open(next) }], ISLAND_MORPH);
  if (prev?.getBoundingClientRect().width) {
    prev.animate([{ clipPath: open(prev) }, { clipPath: inset(to, from) }], ISLAND_MORPH);
  }
}).observe(chatPanel, { attributes: true, attributeFilter: ['class'] });
```

2. A CSS keyframe fade with a 70ms delay and a 4px blur on the composer's contents. Until it plays, the composer stays at `opacity: 0` because of `backwards` fill:

```css
/* public/style.css:1923 — current */
.chat:not(.is-collapsed) .chat-composer { animation: island-in var(--island-expand) var(--island-trail) backwards; }
/* --island-expand: .45s var(--island-spring); --island-trail: .07s;  (public/style.css:1789-1791) */
```

3. The pill's leave transition. The pill sits after the composer in the DOM and fades over it for 220–300ms while blurring:

```css
/* public/style.css:1868-1877 — .chat-pill, current */
  transition:
    color .12s ease,
    border-color .12s ease,
    opacity .22s ease-out,
    transform var(--island-settle),
    filter var(--island-settle),
    display var(--island-settle) allow-discrete;
```

The shortcut handler focuses the field immediately:

```js
/* src/app.js:4429-4436 — current */
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    dismissPassingNotice();
    openIsland();
    const sel = workView.state.selection.main;
    if (!sel.empty) attach({ from: sel.from, to: sel.to, text: workView.state.sliceDoc(sel.from, sel.to) });
    else chatInput.focus();
  }
```

So the first characters a fast typist enters after Cmd+K land in a field that is still invisible or blurred. Keyboard-initiated actions repeated many times a day must not animate (Raycast's palette has no open animation; that is the target feel). The pointer path, a click on the pill, is occasional and keeps its morph unchanged.

## Target

When the island is opened by Cmd/Ctrl+K, the composer is fully visible on the next frame:

- No clip-path morph.
- No `island-in` fade.
- No pill cross-fade.

Every other path keeps its current motion exactly. That covers a pill click, notices appearing and leaving, and collapsing back to the pill.

Mechanism: one data attribute on the panel, `data-open-via="key"`.

- **Set** by the shortcut handler before it changes the view.
- **Read** by CSS, to switch off the composer keyframe and the pill transition, and by the morph observer, to skip the clip-path animation.
- **Cleared** by the morph observer as soon as the composer is no longer the shown view. At that point the composer is `display: none`, so removing `animation: none` cannot replay the keyframe on a visible element.

Clearing while the composer is still visible would restart `island-in` (animation-name changes from `none` to `island-in`) and replay the fade. That is why the clear lives in the observer and nowhere else.

```css
/* target — public/style.css, directly after line 1923 */
/* Opened from the keyboard: there instantly. A shortcut hit many times a day
   must not make the writer wait for a morph before the field is usable. */
.chat[data-open-via="key"]:not(.is-collapsed) .chat-composer { animation: none; }
.chat[data-open-via="key"]:not(.is-collapsed) .chat-pill { transition: none; }
```

```js
/* target — src/app.js, the observer body (2364-2380) */
new MutationObserver(() => {
  const next = islandView();
  if (!next || next === islandShown) return;
  const prev = islandShown;
  islandShown = next;
  const to = next.getBoundingClientRect();
  let from = prev?.getBoundingClientRect();
  if (!from?.width) from = islandRect;
  islandRect = to.width ? to : islandRect;
  const instant = next === chatComposer && chatPanel.dataset.openVia === 'key';
  if (next !== chatComposer) delete chatPanel.dataset.openVia;
  if (instant || reduceMotion() || !from?.width || !to.width) return;
  // …unchanged from here (inset, open, the two .animate calls)
}).observe(chatPanel, { attributes: true, attributeFilter: ['class'] });
```

```js
/* target — src/app.js:4429-4436 */
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    chatPanel.dataset.openVia = 'key';
    dismissPassingNotice();
    openIsland();
    const sel = workView.state.selection.main;
    if (!sel.empty) attach({ from: sel.from, to: sel.to, text: workView.state.sliceDoc(sel.from, sel.to) });
    else chatInput.focus();
  }
```

The attribute stays set if Cmd+K is pressed while the composer is already open. Nothing changes view in that case and nothing animates, so this is harmless. It is cleared the next time the composer stops being the shown view, which happens on collapse to the pill or when a notice takes over.

## Repo conventions to follow

- The island's motion is split between CSS (keyframes and transitions on `.chat` descendants, `public/style.css:1778-1930`) and one WAAPI observer (`src/app.js:2348-2380`). Keep that split, and add the CSS rules next to the existing `island-in` rules at `public/style.css:1922-1924`.
- State is carried on `#chat` (`chatPanel`) through classes and data attributes and selected in CSS. Exemplar: `.chat.has-notice …` at `public/style.css:1818-1826`, toggled from JS in `notify()`.
- Reduced motion already short-circuits the morph via `reduceMotion()` (`src/app.js:1992`). Keep that check in the same `if`.
- Comments in this repo explain *why* in one or two plain sentences, as in the CSS comment above. No ticket references.

## Steps

1. `public/style.css`: directly after line 1923 (`.chat:not(.is-collapsed) .chat-composer { animation: island-in … }`), insert the two rules and their comment exactly as shown in **Target**.
2. `src/app.js`: in the shortcut handler at line 4429, insert `chatPanel.dataset.openVia = 'key';` as the line after `event.preventDefault();` and before `dismissPassingNotice();`. It must come before both calls, because each can change the panel's class and trigger the observer.
3. `src/app.js`: in the observer at lines 2364-2380, replace the single line

   ```js
   if (reduceMotion() || !from?.width || !to.width) return;
   ```

   with the three lines

   ```js
   const instant = next === chatComposer && chatPanel.dataset.openVia === 'key';
   if (next !== chatComposer) delete chatPanel.dataset.openVia;
   if (instant || reduceMotion() || !from?.width || !to.width) return;
   ```

   Leave every other line of the observer unchanged.
4. Rebuild the bundle: `npm run build`. It writes `public/app.js` from `src/app.js`. Never edit `public/app.js` by hand.

## Boundaries

- Do NOT change `ISLAND_MORPH`, `--island-expand`, `--island-trail`, `--island-spring`, `--island-settle` or the `island-in` keyframes. The pointer path keeps them.
- Do NOT touch the pill click handler (`src/app.js:2329-2331`), `setIsland`, `openIsland`, `notify` or `dismissPassingNotice`.
- Do NOT change the pill's hover scale or any notice (`.edit-feedback`) motion.
- Do NOT add dependencies or new files.
- If any quoted "current" code does not match what you find (drift since the stamp), STOP and report instead of improvising.

## Verification

- **Mechanical**: `npm run check`. Expect exit code 0, with every suite printing its "… checks passed" line (Suggestion, MCP, OAuth, Safety, Workspace file, Sidecar, Persistence, UI).
- **Feel check**: start the app (`npm start`, open `http://127.0.0.1:3000`) and confirm:
  - With the island collapsed to the "Ask anything" pill, press Cmd/Ctrl+K and type immediately. The first character appears in a fully opaque, unblurred field. There is no expanding outline and no pill ghost fading over it.
  - Click the pill instead. The original morph still plays: the outline grows from the pill and the contents fade in after a short delay.
  - Open with Cmd+K, click empty space in the draft so the island folds back to the pill, then click the pill. The morph plays, so the keyboard flag did not leak into the pointer path.
  - Open with Cmd+K, then cause a notice (for example, turn the network off and send a message). The notice still morphs in.
  - In DevTools' Animations panel, set playback to 10% and press Cmd+K. No animation group is recorded for `.chat-composer` or `.chat-pill`. Repeat with a pill click and confirm the clip-path and `island-in` animations are recorded.
  - In the Rendering panel, emulate `prefers-reduced-motion: reduce`. Both paths open instantly, which is unchanged from today.
- **Done when**: Cmd/Ctrl+K shows a usable, fully opaque composer on the next frame, the pill-click path is visually identical to before, and `npm run check` passes.
