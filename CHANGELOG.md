# Changelog

Litura follows [semantic versioning](https://semver.org). Until 1.0 the minor number carries breaking changes.

## Unreleased

- The bubble's `Add to context` is now `Discuss`, matching the button on finding cards. After `Discuss` the paragraph `+` is available again: the passage stays selected, and that no longer hides it.
- Markdown in the draft stays plain text: markers remain, dimmed, and what they mark is styled in place. Headings set bold, `**bold**`, `*italic*`, `_italic_` and `***both***` follow suit, `` `code` `` gets a quiet background, `[links](url)` an accent underline, `>` lines are muted, list markers dimmed and `---` carries a thin rule. Fenced blocks and inline code are left unparsed.
- The draft sets larger (17px) on a 68-character measure. Margin notes are written in the draft's own italic, sit on the passage's baseline and open as a single line with no background. The conversation island now morphs its outline between the pill, the composer and a notice, notices are pill-sized and wait eight seconds (longer under the pointer), and `Suggesting…` shows in the folded pill instead of vanishing with the composer.
- The paragraph `+` stands on the line under the pointer instead of a long paragraph's first line, stays up while a bubble is open, and on a paragraph that already has a note opens that note. The selection and Continue bubbles wait a beat (250 and 450 ms) and never appear if you type or click again first; every bubble fades in and out.
- A margin note now stands on the line it was made at — its passage, or the line its `+` was pressed beside — instead of at the top of a long paragraph, and the `+` is no longer offered beside a line a note already covers. Retrying a failed draft load no longer duplicates the restored notes.
- Notes in the margin no longer overlap: the rail cards were positioned relative to their normal place instead of the rail, and now also restack when a note grows. The conversation island sits 16px higher.
- Experiment, Settings → While you write → Actions in the margin: `Note` and `Discuss` stand in the notes rail beside the selected line, and `Continue` sits right after the caret with its `⌘↵` hint, instead of floating over the text. Falls back to the floating bubble where there is no rail.
- With a conversation open, the turns and the field now stand inside one opaque panel (near-black in dark mode) instead of floating over the draft, and the fade behind the island is gone. Notes in the margin no longer get cut at the header: the rail reaches the window top like the draft's lines do.
- Margin notes, slice 1: select a passage and press `Note` in the bubble to pin your own remark beside the line — plain text on the margin, no card chrome, blur commits and `Escape` drops, no Save/Cancel. Hover the empty margin beside a paragraph for its `+` (a paragraph note, never drifts); select all and press `Note` for the whole draft (pinned at the rail top, no mark). Notes stand in the margin rail on wide windows and stack in the chat stream on narrow ones. Create, edit, delete with Undo; notes persist per file. Notes go to the model with chat and rewrite requests as labeled scope context. No threads yet.

## 0.4.2 — 2026-09-13

- Clicking at the end of a paragraph now offers a Continue bubble, asking for the same continuation Cmd/Ctrl+Enter would. An explicit ask is allowed to open the next sentence and run longer than a background suggestion, instead of stopping at a finished thought.
- Fixed the field popovers flashing at their previous position before snapping to the trigger.
- Removed the unused standalone Rewrite button from the chat chip.

## 0.4.0 — 2026-09-13

- Added spell checking. Misspelled words are marked in the editor using a vendored en_US Hunspell dictionary, checked client-side alongside the existing style-tell markers.

## 0.3.7 — 2026-09-13

- Litura is now also a desktop app. A Tauri shell picks the writing folder, starts the same server on a free port, and shows it in its own window; it carries its own Node runtime, so nothing has to be installed first.
- The review panel is one list again. Wording marks and review findings sat in separate sections repeating the same reason on every row; now they share a single list in document order, each row naming the passage and where the remark came from, with the reason on the card a click away. The header button says how many remarks are waiting instead of a bare number.
- The desktop app updates itself: it asks GitHub on launch and from `Check for Updates…`, installs only what you accept and what its signing key verifies, and restarts. In that build the npm update switch is gone, since it would name a second, wrong way to update.

## 0.3.6 — 2026-09-07

- Published the latest editor interface and behavior updates together with the product audit and local draft history.

## 0.3.5 — 2026-09-07

- Refreshed the README preview with natural generic-writing highlights and meaningful rewrite options in a full-screen review flow.

## 0.3.4 — 2026-09-07

- Refreshed the README preview with a full-screen Litura review flow and three rewrite options.

## 0.3.3 — 2026-09-07

- Refreshed the README preview with a full-screen editor screenshot showing review marks and inline continuation.

## 0.3.2 — 2026-09-07

- Moved the Slop Score next to the settings control in the editor header.

## 0.3.1 — 2026-09-07

- The update badge now copies `npx litura-app` instead of opening a changelog, so the next update command is ready to paste.

## 0.3.0 — 2026-09-07

- Review remarks stay beside the passage they describe without shifting the draft when opened or clicked.
- Added document actions and local history, replace-in-place previews, light/dark appearance settings, and automatic settings saves.
- Refined the editor header, chat composer, settings controls, and release safety checks.

## 0.2.0 — 2026-09-06

- Settings can ask npm about new versions once a day, off by default. When a newer version is published the header shows a badge linking to this file; the badge links rather than installs, so updating stays a command you run. Left off, Litura opens no connection of its own.
- Releases are cut by tag, with GitHub Actions running the checks and publishing over OIDC.

## 0.1.0 — 2026-09-06

First npm release, published as `litura-app`; the command it installs is `litura`.

- Run from any folder with `npx litura-app`. The draft and the style guide are read from the folder Litura starts in, not from its install directory.
- The browser opens on start, and a taken port falls through to the next free one.
- `litura --version` and `litura --check-update` report the running and published versions. Litura opens no connection of its own.
