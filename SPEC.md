# Stilura - Product and Technical Specification

## 1. Product

Stilura is a standalone local writing editor. It helps an author continue a draft, ask about selected text, and try alternative wording while keeping every document change under explicit user control. The name joins Latin *stilus* (the pen, the author's hand) and *litura* (the correction in a manuscript): writing as creating by cutting.

The editor does not run style checks, score prose or expose a review API.

### Product principles

- The document stays central; assistant UI floats above it instead of replacing it.
- Detection must name a concrete, checkable problem.
- The model may suggest text but never edits the document autonomously.
- Subtractive editing: the job is sharper prose, not more prose — buried points, broken promises, filler, and vague attribution go; the author's facts and voice stay.
- Specific facts, unusual details, uncertainty, humor, and the author's voice should survive a rewrite.
- Empty output is better than a low-quality suggestion.
- Local analysis should avoid model calls when it can confidently do so.

## 2. Interface

A persistent footer below the editor shows `/ generate text`, `Tab accept` and `R regenerate`. It overlays a paper-to-transparent gradient at the bottom, lets pointer input through and describes the editor to assistive technology.

The working document stays central. Selecting text offers a floating `Change` action above the passage; Cmd/Ctrl+K opens the same request field. Actions do not dock in the margin. Spelling uses red underlines; an active passage uses a blue wash. Loading replaces overlapping marks with a neutral skeleton, and replacement previews hide other highlights only within their own range.

Settings contain model and access configuration, appearance and update checks. General explains writing shortcuts; continuations are always enabled and have no toggle. Stored `wa-autosuggest`, `wa-autoreview` and `wa-pills` preferences are ignored.

Conversation island, file sidebar controls and notes UI are temporarily hidden. Their stored document state remains available. The editor does not display style scores, findings, a review button or `/slop`, and F8 has no review action.

## 3. Writing workflows

### 3.4 Selection requests

`Change` or Cmd/Ctrl+K opens one field beside the selected passage. The author writes a request in their own words: ask a question, request a replacement, or ask for synonyms. Enter sends; Shift+Enter adds a line. The model answers locally or proposes replacements according to that request. Only the field is visible: no buttons, captions or status instructions. Answers and errors appear in that field; typing starts a new request. There are no action modes. Replacements appear as faint inline previews: Up/Down choose, Tab accepts, Escape dismisses, R regenerates. Acceptance is one isolated undo event. The exact range follows local and remote edits elsewhere; editing it cancels the request and preview. Unaccepted results are transient.

Loading uses the shared text skeleton. Existing highlights and Markdown marks do not show through it. Suggestion previews and regeneration retain the same tracked range; the original draft stays unsaved until acceptance.

### 3.5 Draft chat

When no passage is attached, composer messages open a conversation about the whole draft. The server includes the current document in the system context and retains the last 20 valid user/assistant messages supplied by the client.

Replies stream through Server-Sent Events and are rendered with a small, HTML-escaped Markdown subset: paragraphs, headings, emphasis, links, lists, inline code, and fenced code blocks.

After a new reply finishes streaming, one verified replacement updates the draft immediately and shows Undo in its chat card. Multiple suggestions remain explicit choices. Interrupted, ambiguous, stale or read-only responses do not change the draft. Automatic application preserves keyboard focus and maps the editor selection through the edit. Undo restores only that passage and is invalidated by subsequent edits inside it; changes elsewhere remain intact. Restoring conversation history never applies suggestions again.

The conversation survives a reload.

### 3.6 Continuation suggestions

After 200 milliseconds without typing, a suggestion may be requested when:

- the document contains at least 15 non-whitespace characters;
- the selection is collapsed;
- the caret is at the end of a paragraph or before a blank line;
- the editor has focus, the page is visible, and composition is finished.

Only typing (including composition) starts this timer. Paste, deletion, Undo, Redo, loading a document and accepting an AI edit cancel pending suggestions without requesting another one.

A failed continuation says so in the notice; the next successful request clears its error. The model may return an empty continuation when the thought is finished or continuing would invent facts or the author's intent. Non-empty output is a single line of at most 15 words; one word or punctuation alone is allowed. The provider returns `NONE`, `TEXT: …` for new words or punctuation, or `WORD: …` for missing letters, so prose quotation marks do not need JSON escaping. Case differences, a text code fence and whitespace after the label are normalized without another model call. Other format failures get one corrective request naming the validation error, using the same model, grounding rules, cancellation signal and shared 30-second deadline. Empty output and `NONE` are successful abstentions. Provider/key/quota errors do not trigger format recovery. After two invalid answers, the route reports `SUGGESTION_FORMAT`; invalid text never becomes a suggestion. Logs record the requested model (or default), attempt and output length, without draft or answer content. HTTP and the evaluation runner share this recovery path. The HTTP response still uses `{ suggestion: string }`. Spacing is applied at the insertion boundary; repeated tails are removed only at Unicode token boundaries before the length cap, including overlaps longer than 60 characters and repeated text after the cursor. Complete copied passages elsewhere in the draft are suppressed; short reused phrases remain allowed. A valid continuation appears in a block below the current line, is announced to assistive technology, and does not enter the document until accepted.

- `Tab`: insert the suggestion at its original cursor position.
- `Escape`: dismiss it and cancel pending work, even before an answer arrives.
- `Cmd/Ctrl+Enter`: request a continuation explicitly, without waiting for the timer. This permits short non-empty drafts and reports when there is nothing useful to suggest.
- Typing, changing the selection, leaving the editor, hiding the page, changing the model or pausing saves: dismiss or invalidate the suggestion and cancel pending work. An answer is displayed only for the same document, full selection, model and active request with the editor still focused.

### 3.7 Generate in the editor

Before the first generated words arrive, a 3×3 Drive pixel loader appears with a shimmering Writing label and elapsed time. Regeneration shows Rewriting beside the previous candidate until the first new text arrives. The clock uses wall time, stays out of live announcements and stops when the widget disappears. Reduced motion freezes the grid and label while the clock continues.

At the end of a new or existing line, `/<request>` + Enter sends the request and surrounding prose to the selected default model via `POST /write`. A slash at the start of a line or after whitespace starts the request. Existing prose before it is preserved; only the request is highlighted. Inline previews stay in the same text flow. URLs and word separators are not commands. The caret must be at the line's end with no selection. Partial output appears as a faint ghost suggestion over the command, without buttons; it is not saved as draft text. A completed, nonempty answer keeps the ghost suggestion appearance. With a collapsed caret in the request range, Tab accepts, Escape dismisses and R regenerates; these keys leave proposals elsewhere alone. Repeated R presses while regeneration is running are consumed without modifying the request; composition input is never intercepted. Acceptance replaces only the tracked command range in one isolated undo event, preserving focus, selection and concurrent changes elsewhere. Reject discards the preview and shows the original request. Regeneration uses the original request, previous candidate and current document context; failed or stopped regeneration restores the previous candidate. A new slash request waits until the current candidate is accepted or rejected. Unaccepted previews are transient: reloading preserves the original request. Local and remote transactions map that range; edits touching it invalidate generation even if identical text is restored. Escape, document switches, read-only state, paused saves and interrupted/failed/empty streams preserve the request; initial failures discard the preview. Exact context echoes are removed before review. A copied-context or unchanged-regeneration response gets one corrective attempt within the original deadline. A replacement SSE event resets the preview, so attempts never concatenate. The old candidate remains visible while a regeneration waits for its first token. Only one foreground model request runs at a time. Ordinary prose does not trigger generation. The empty editor has no placeholder.

### 3.8 Model and access settings

The settings dialog:

- discovers Pi credentials and supported provider environment variables;
- lists the models each authenticated provider offers now, not the snapshot bundled with the Pi dependency. That snapshot ages, and a model added after it was published cannot be selected at all: Pi refuses a model its catalog does not know. Asking a provider what it offers is a call to the provider the writer already pointed the app at, so it needs no permission the app does not already have; `STILURA_OFFLINE_MODELS` stops it, and a failed refresh falls back to the list Pi already has;
- offers provider and model as searchable comboboxes: a trigger naming the current choice, and a popover holding a search box and the matching rows, each naming one model. Typing still matches a model's id as well as its name — the writer who knows the id finds the row, and the row still reads as a name. Six hundred models do not fit a `select`, and a native `datalist` cannot stand in — its popup never reaches the top layer above a modal dialog, and a field already holding an answer filters the writer's typing against it. The popover API still supplies the top layer, light dismiss and `Escape`; `↑` `↓` walk the list and `Enter` takes the highlighted row;
- lists authenticated providers and their available models;
- exposes only thinking levels supported by the selected model;
- uses the same selected provider and model for every writing action; continuations use the least reasoning that model allows;
- offers ChatGPT Plus/Pro sign-in (Codex OAuth) next to API keys.
  Claude subscriptions are deliberately not offered — Anthropic restricts
  them to Claude Code and claude.ai;
- saves the active provider/model/thinking selection to local storage;
- adds and removes Pi API-key credentials;
- does not offer removal for credentials supplied by environment variables;
- switches the npm update check on or off, on by default.

All settings take effect immediately; there is no Save button.

When no model is selected, explicit writing actions re-check Pi status once, then report the missing setup and open this dialog. Automatic continuations stay silent and make no request.

### 3.9 Margin notes

Saved user notes are also work items for external agents using the live HTTP session. States: queued, working, review, done, reverted, blocked. `work_next` exclusively claims an item for five minutes; replay by the same agent returns its claim, and server restart requeues interrupted jobs. `work_finish` checks that claim and its original revision, restricts edits to the claimed target, and persists an attempt alongside the text before acknowledgement. It never marks an applied result done. Invalidated or expired work cannot overwrite a newer task.

The writer accepts an applied result, safely reverts its ranges, or regenerates from the current passage. Text edits inside a result disable its revert; edits elsewhere map its positions. Completed notes remain collapsed. Notes retain ten attempts and fifty feedback messages; document backups cover older text. Rough prose alone is not a trigger.

The writer's own remarks on the draft. Three scopes: a passage anchors by quote and saved paragraph text, a paragraph note anchors by its paragraph text and offset, and a document note anchors nowhere. Local edits map anchors through CodeMirror changes; insertions above a note do not change its target. Missing or ambiguous anchors remain visible as drifted, and automatic work refuses edits against them. Select a passage and press `Note` in the bubble; hover the empty margin beside a paragraph for its `+`; select all and press `Note` for the draft. A card opens beside the line (in the rail on wide windows, in the chat stream on narrow ones — the same rail the findings once used, now only for notes). Creating, editing, and deleting a note spends no model call. Note resolution preserves the note and hides its card immediately in connected editors.

- A passage note anchors to its paragraph with a quote snapshot: found verbatim, the mark stands on the quote; reworded, the mark falls back to the paragraph and the card carries a "text changed" badge; the paragraph gone, the card waits in the stream. A line note (the `+`, empty quote) never drifts — it keeps its paragraph and the offset of the line pressed, draws no mark, and the card stands on that line; the passage note's card stands on its quote's first line, not its paragraph's top. A document note carries no mark and pins at the rail top. Blue marks for notes — amber stays the model's.
- Clicking a note's mark focuses its card and arms nothing. Deleting offers `Undo`: a faint `×` always stands beside the note, `Delete`/`Backspace` on a focused card works too, and clearing the text deletes. Empty notes don't linger: leaving a fresh note empty removes it silently, clearing a note deletes it with `Undo`. The `+` is not offered beside a line a note's card already covers, so a second card is never stacked on the first.
- Notes travel with chat and rewrite requests as `WRITER'S MARGIN NOTES` context, labeled by scope (passage, paragraph, whole draft). Suggestions stay note-free because they fire on every pause.

### 3.10 Positioning brief (lite)

Four questions about audience and goal — reader, goal, awareness, scope — from the positioning-brief skill. Typing `/brief` in the composer (or picking it from the command menu) starts the interview: one question at a time in the chat stream, each with three options to pick or a free-typed answer. `Escape` pauses it; partial answers are kept and `/brief` resumes. A finished brief shows a summary card with per-row `Edit`; typing `/brief` with a finished brief reopens the summary.

A nudge, at most once per document as a passing notice: a full review that returns a `level-1-whole-essay` or `level-2-introduction` finding (a weak opening is the symptom of a missing brief). It offers `Answer 4 questions` and never blocks the requested action. Creating, editing, and pausing the interview spends no model call.

Answers travel with chat, rewrite, and idea requests as `POSITIONING BRIEF` context. Continuations receive the writing brief separately from optional context.

## 4. State and privacy

Document-specific browser keys use the prefix `stilura:<id>:` where `id` is the SHA-256 hash of the canonical draft path returned by the server. In the table below, document keys are relative to that prefix. Model and background-action settings remain shared within the browser origin.

In the desktop app these keys also persist as atomic files in the application data directory's `editor-state` folder, independent of the HTTP port. Native close, folder changes, and update installation wait for the editor's draft and state writes to finish. Browser-only runs keep using local storage. Partial brief answers are saved after each answer. Opening a different document starts a fresh Undo history.

| State | Location | Lifetime |
|---|---|---|
| Working document | `wa-working` and `wa-working:<tabId>` in local storage; tab ID in session storage | Until browser storage is cleared |
| Working document mirror | the active file (starts as `DRAFT_FILE`, follows the sidebar) | Until the file is deleted |
| Agent selection | `localStorage["wa-agent"]` | Until browser storage is cleared |
| Chat history | `wa-chat`, last 20 turns | Until document replacement or browser storage is cleared |
| Margin notes | `wa-notes`, each with paragraph anchor and quote snapshot | Until note deletion or document replacement |
| Positioning brief | `wa-brief`, four answers plus a nudged flag | Until document replacement or browser storage is cleared |
| Disk history | `<draft>.stilura-history`; latest 20 returned to the UI | No automatic deletion |
| Browser checkpoints | `snapshots`, last 10; other tabs' working copies also appear in History | Checkpoints rotate; working copies remain until browser storage is cleared |
| Update-check setting | `localStorage["wa-updatecheck"]`, on unless set to `off` | Until browser storage is cleared |
| Last seen published version | `localStorage["wa-update"]` as `{ latest, at }`, reused for 24 hours | Until browser storage is cleared |
| API credentials | Pi credential storage or environment | Managed by Pi |

Each edit updates the browser working copy immediately. CodeMirror collaboration batches outgoing changes every 75 milliseconds. A server session orders and persists changes, then broadcasts them over SSE. Incoming changes preserve selections, map note anchors and stay outside personal undo. The HTTP session client discovers the same authority through `<file>.stilura-session`; a live but unreachable owner blocks disk fallback. Without a live owner, the client uses revision-checked disk writes.

Agent patches map through intervening edits in other ranges. A changed target fails with a conflict; incoming agent edits overlapping unsent user input leave the local copy intact and show the recovery banner. External file changes reset the session. Reconnect replays missed updates; server restart or expired history with pending local work requires explicit recovery. The server retains up to 2,000 operations or 8 MB in memory; the draft itself is durable before acknowledgement. Writer history snapshots are spaced at least ten seconds apart; agent edits each make a backup.

Shared notes persist in `<file>.stilura-notes.json`, with per-note versions and deduplicated operations. Existing browser notes migrate when a document opens. Resolution broadcasts immediately and remains monotonic. The Markdown file and notes sidecar together form the durable document.
At startup, the editor waits for the server to identify and read the draft. It restores this tab's working copy when available, otherwise the document's shared browser copy, otherwise the disk text. An empty browser copy is distinct from a missing one. Unscoped browser text is not imported into another workspace.

If browser and disk differ at startup, or the disk revision changes when the window regains focus or visibility, Stilura never opens a modal. When the browser copy is untouched since the last confirmed save it takes the disk copy silently; when only one side moved there is nothing to decide. Only two genuinely diverged copies raise a slim banner above the draft — `Load disk`, `Keep mine`, and a `What changed` word diff — while the draft stays editable and only disk writes wait. Choosing a copy resumes revision-checked saving; another external change can raise the banner again. During a live session, edits in separate ranges merge automatically; the banner handles divergent snapshots.

Save errors remain visible and pause autosave until the writer retries. A failed request does not advance the recorded disk revision. The browser warns before leaving while a save is in flight or the working text differs from the last confirmed disk copy.

Findings are restored only when their stored document text exactly matches the loaded draft, then their quotes are re-anchored. Chat restores messages, not finding cards or rewrite previews. Replacing the document clears findings, dismissed findings, chat, notes, and the brief, and keeps a browser checkpoint of the previous text. Keeping an AI replacement also creates a checkpoint. Rewrite previews alone change neither stored copy.

`Cmd/Ctrl+S` requests an immediate disk save, respecting any paused conflict or error. `Export a copy` downloads the current text using the workspace draft's filename. `Open a file…` and drag-and-drop accept `.md`, `.markdown` and `.txt` files up to 1 MiB and replace the active document's contents without switching files. Opening a sidebar file switches the active document instead and opens hard-wrapped prose flowing: lone newlines inside a paragraph are Markdown soft breaks, so wrapped lines are joined back into paragraphs while blank-line breaks, lists, headings, quotes, fences and tables keep theirs. `New`, import and restore never ask first: the replaced text goes to History, and the notice offers `Undo` for a few seconds.

Everything the app reports outside the conversation — save and load trouble, model errors, confirmations with `Undo` — takes over the conversation island, one at a time, the way an iPhone alert takes over the island: while one is up the composer, the pill and the recipes row step aside for it, buttons and all. Either input or notice, never both — summoning the composer dismisses a passing notice, a sticky problem keeps the input covered until its action or `×`, and a notice never covers a focused field (it parks until blur). Passing notices fade after eight seconds; the pointer resting on one holds it. Background progress (`Suggesting…`) shows in the pill itself while the island is folded. A chat answer never shows the raw edit list: a response that drops the `<stilura-edits>` tags (wire format, name kept) still yields edit cards.

Every model-backed action sends the current full document to the selected provider. Rewrite requests additionally send the relevant selection.

## 5. Technical architecture

- **Runtime:** Node.js 20 or newer.
- **Server:** native `node:http`, bound to `127.0.0.1`.
- **Frontend:** vanilla JavaScript and CodeMirror 6.
- **Bundling:** esbuild produces an IIFE bundle.
- **Model runtime:** `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent`.
- **Streaming:** Server-Sent Events for `/write`, `/idea` and `/chat`. For `/write`, `text` appends to the preview, `replace` replaces its entire buffer, and only `[DONE]` completes the candidate.
- **Non-streaming:** JSON for status, credentials, rewrite, and suggestions.
- **Desktop shell:** Tauri 2, a window and a menu around the same server.

### Desktop shell

The desktop app is a packaging of this server, not a second implementation. The Rust shell picks the writing folder, starts the server, points a window at it, and owns updates; documents, generation, and model access stay where they already are. No Tauri JavaScript API reaches the page — the webview loads `http://127.0.0.1:<port>` like any browser would, which is why `src/app.js` is identical in both builds.

The server is a Tauri sidecar: an official Node binary, fetched and checksummed at build time by `scripts/fetch-node.mjs`, running `dist/server.mjs` — `index.js` and its dependencies bundled into one file by `scripts/build-server.mjs`. The writer installs no runtime of their own.

Three pieces of the contract between them are invisible from the browser, so `safetycheck.js` asserts them:

- `PORT=0` lets the operating system pick, so a second copy of Stilura is not a startup failure.
- With `STILURA_SIDECAR` set the server prints `STILURA_READY <url>` on stdout. The shell waits for that line before it navigates the window, and opens no browser of its own.
- The same flag makes the server exit when its stdin closes. A shell that dies takes its server with it instead of leaving one holding the draft's lock file.

`STILURA_ROOT` tells the bundled server where `public/`, `package.json`, and `style.md` are, since the single-file bundle no longer sits beside them. Nothing else about the server changes.

On macOS the window has no title bar of its own: the draft's header is the title bar, and the system's window buttons are drawn over it. The shell asks for the page with `?shell=desktop`, and an inline script in `index.html` turns that into a class the header uses to leave the buttons room — a query string rather than a header, so a reload keeps it. Windows and Linux keep their frame: dropping it there means reimplementing minimise, maximise, close, and window dragging, which would need Tauri's JavaScript API inside a page that is deliberately kept free of it.

The folder choice is one line of text in the app's config directory (`folder.txt`), written when the writer picks a folder and read at every launch. `File → Open Folder…` writes it and restarts the app rather than teaching the server to switch files mid-session: a different draft is a different server.

`npm start` bundles the frontend before starting the server in a source checkout. If the build fails, startup stops with an error. The published package has no `src/` directory and serves its bundled frontend without rebuilding. `public/app.js` is generated and should not be edited directly.

### File structure

```text
stilura/
|- README.md            product overview and setup
|- SPEC.md              product and technical behavior
|- index.js             build step, HTTP server, routes, and prompts
|- pi.js                Pi discovery, credentials, model resolution, requests
|- review.js            selection, sentence and continuation helpers
|- markdown.js          safe minimal Markdown renderer for chat
|- selfcheck.js         assertion-based checks
|- style.md             writing constraints injected into model prompts
|- plugin.json          webview plugin manifest (/write, port 3000)
|- scripts/
|  |- build-server.mjs  bundles index.js into dist/server.mjs for the desktop build
|  |- fetch-node.mjs    downloads and checksums the Node runtime the desktop build ships
|  `- smoke-desktop.mjs starts a built bundle and checks it serves and stops
|- src-tauri/
|  |- src/main.rs       desktop shell: folder, sidecar, window, menu, updater
|  |- tauri.conf.json   bundle targets, resources, updater endpoint and public key
|  |- shell/index.html  holding page shown until the server is listening
|  |- icons/            generated app icon set
|  `- binaries/         fetched Node runtime, gitignored
|- src/
|  `- app.js            frontend source
`- public/
   |- index.html        application shell
   |- style.css         application styles
   |- app.js            generated bundle
   `- fonts/            local iA Writer Duo files
```

## 6. HTTP API

All bodies and non-streaming responses are JSON unless noted.

| Method | Route | Behavior |
|---|---|---|
| `GET` | `/` | Application HTML |
| `GET` | `/style.css`, `/app.js`, `/fonts/*` | Static assets |
| `GET` | `/draft` | Current snapshot: text, identity, opaque revision, epoch, version and shared notes; missing files have empty text |
| `GET` | `/draft/live` | Snapshot; `since` + `epoch` returns changes, with `events=1` streams updates/resets over SSE |
| `POST` | `/draft/live` | `action`: `push`, `patch`, `write`, `notes`, `work_next`, `work_finish`, `work`, `note_suggest`; operations against the shared document |
| `PUT` | `/draft` | Save `{ text, revision }`; returns `{ saved: true, text, path, id, exists, revision }`, or `409` with `{ error, current }` when the revision differs |
| `POST` | `/draft/open` | Switch the active document to workspace file `{ name }` (basename, Markdown or text); further `/draft` reads and writes target it. Returns the same shape as `GET /draft` |
| `GET` | `/draft/history` | `{ snapshots }`, latest 20 disk backups with `text`, `at` and `revision` |
| `GET` | `/files` | `{ files }`: Markdown and text files next to the draft, each with `name`, `size`, `mtime` and a markup-stripped `excerpt` (first meaningful prose, ~160 chars) for the card preview, sorted by name |
| `GET` | `/file?name=` | `{ name, text }` for one workspace file by basename; `400` for anything that is not a plain Markdown or text name, `404` when it is gone, `413` past 1 MB |
| `GET` | `/api/version` | `{ name, current }`; with `?check=1` also `latest` from the npm registry, or `error` if it is unreachable |
| `GET` | `/api/agent/status` | Providers, models, auth status, and default selection |
| `POST` | `/api/agent/credentials` | Save a provider API key through Pi |
| `DELETE` | `/api/agent/credentials` | Remove a stored provider credential |
| `POST` | `/rewrite` | Return three replacement variants |
| `POST` | `/ask` | Answer a passage request or propose verified replacements |
| `POST` | `/suggest` | Return a short continuation |
| `POST` | `/write` | Stream text to replace an editor request over SSE |
| `POST` | `/idea` | Stream an idea expansion over SSE |
| `POST` | `/chat` | Stream a draft conversation over SSE |

### Agent selection

Model-backed routes accept:

```json
{
  "agent": {
    "provider": "provider-id",
    "model": "model-id",
    "thinkingLevel": "medium"
  }
}
```

If omitted, the server tries the `PI_PROVIDER` and `PI_MODEL` environment values, then preferred fallbacks, then the first available authenticated model. The fallback list prefers named models; a routing pseudo-model such as `openrouter/auto` is last, because a different model per request breaks the output contracts these routes depend on. Unsupported thinking levels are clamped to a level supported by the model.

### Route-specific request fields

| Route | Fields |
|---|---|
| `/rewrite` | `document`, `selected`, `from`, optional `instruction`, optional `context`, `agent` |
| `/ask` | `document`, `selected`, `from`, `instruction`, `agent` |
| `/suggest` | `document`, optional `cursor`, optional `context`, `agent` |
| `/write` | `document`, `from`, `cursor` (end of request), `instruction`, optional `previous`, `context`, `agent` |
| `/idea` | `document`, `idea`, optional `context`, `agent` |
| `/chat` | `document`, `messages`, optional `selection`, `agent` |

The server still accepts optional `context` fields for API callers, although the current browser interface has no separate context editor.

SSE routes emit JSON text deltas followed by a final marker:

```text
data: {"text":"..."}

data: [DONE]
```

An SSE error is emitted as `{"error":"..."}` when headers have already been sent.

## 7. Prompt and style handling

`style.md` is read for every request and prepended to the task prompt. It includes shared reader-orientation rules for opening promises, point placement, old-to-new flow, key-term continuity, and problem resolution. Its prose diagnostics also cover vague attribution, mind-like agency assigned to abstractions, stacked hedging, and manufactured emphasis. A shared `NO_SLOP` instruction keeps generated text specific and grounded.

If `style.md` is missing, the server logs one warning and continues without it.

Rewrite, suggestion, idea, and chat prompts have separate output contracts and token limits. Continuations use the shared builder in `suggestions.js`, with explicit abstention and word-joining rules. The production path keeps the full style guide and document; reduced prompts and local context are evaluation-only experiments.

The rewrite prompt leads with the selection, then the instruction, then the containing sentence with the selection replaced by a `___` slot, and only then the full document with the selection marked. A variant longer than three times the selection is treated as a whole-document rewrite: the request is repeated once with the scope restated. Unparseable answers are retried up to three attempts in total.

Saved document formats use `stilura:` browser keys, `.stilura-history`, `.stilura-notes.json`, `.stilura-session`, `.stilura-lock` and `<stilura-edits>` chat envelopes. Existing document files and storage entries migrate when opened. Original storage entries remain available for recovery; existing current entries take precedence. Migration refuses an active old editor or conflicting old/current document files. Old `LITURA_*` environment variables, the previous desktop bundle directories and unscoped draft recovery are no longer supported.

## 8. Environment

| Variable | Purpose | Default |
|---|---|---|
| `PI_PROVIDER` | Preferred Pi provider ID | Selected from authenticated models |
| `PI_MODEL` | Preferred Pi model ID | Selected from authenticated models |
| `PI_THINKING_LEVEL` | Preferred reasoning level | `medium` |
| `PORT` | Local HTTP port; the next free port up to +10 is used if taken | `3000` |
| `STYLE_FILE` | Writing style guide path | `<cwd>/style.md`, else the bundled `style.md` |
| `DRAFT_FILE` | Draft mirror path | `<cwd>/draft.md` |
| `STILURA_NO_OPEN` | Set to skip opening the browser at startup | unset |
| `STILURA_OFFLINE_MODELS` | Set to stop Stilura refreshing provider model lists | unset |
| `STILURA_SIDECAR` | Set by the desktop shell: ready line, no browser, exit with stdin, updates handled by the shell | unset |
| `STILURA_ROOT` | Directory holding `public/`, `package.json`, and `style.md` | the server's own directory |
| `STILURA_NODE_VERSION` | Node runtime the desktop build ships | `v24.21.0` |

## 9. Distribution and updates

Stilura is published to npm as `stilura`; the command it installs is `stilura` too. It runs as `npx stilura` from the folder holding the draft. For a bare package name npm re-resolves the registry manifest on every run, so starting Stilura is the update; a global install (`npm i -g`) shadows that check and has to be updated by hand.

`stilura --version` prints the running version. `stilura --check-update` prints the published version next to it, and reports an unpublished package rather than comparing against nothing. Neither flag ranks the two versions: a local build legitimately runs ahead of the registry, and ordering semver correctly would be a dependency.

The desktop app is distributed as signed bundles attached to the GitHub release for the tag: `.dmg` and `.app.tar.gz` per macOS architecture, an NSIS installer on Windows, `.deb` and `.AppImage` on Linux. `.github/workflows/desktop.yml` builds one matrix entry per target and uploads them, along with the `latest.json` the updater reads.

Updates there are the shell's, not npm's. On launch and from `Stilura → Check for Updates…` it asks the release endpoint; an answer is installed only after the writer accepts, is verified against a minisign public key compiled into the app, and is followed by a restart. A launch-time check that cannot reach GitHub says nothing; a check the writer asked for reports why it failed. Because a second update path would be a second wrong answer, `/api/version` returns `managed: "desktop"` under `STILURA_SIDECAR`, contacts npm for nothing, and the frontend hides the update section of settings.

The signing key is not in the repository. CI reads it from `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`; the public half lives in `tauri.conf.json`. Replacing it strands every installed copy, which will accept nothing the old key did not sign.

In the browser, `Ask npm about new versions` in settings is on by default and stored in `wa-updatecheck`. Off, the browser calls `/api/version` without `?check=1` and the server contacts nothing. On, it asks at most once every 24 hours, caches the answer in `wa-update`, and shows a header badge linking to the changelog when the published version differs from the running one. Switching it off hides the badge rather than leaving a stale one.

### Releasing

A release is a tag. `npm version <patch|minor|major>` refuses a dirty tree, bumps `package.json`, commits, and tags. Push the branch and the tag as two pushes — `git push && git push --tags` — rather than `--follow-tags`: pushing v0.1.0 together with its branch produced a run for the branch only. The tag push triggers `.github/workflows/release.yml`, which runs `npm run check`, verifies the tag matches `package.json`, and publishes with npm trusted publishing (OIDC, no stored token). Every other push runs the checks without publishing. `npm run check` passes without provider credentials: the Pi section asserts the shape of the model list, not its contents.

### What survives

| Survives an update | Mechanism |
|---|---|
| Draft | `wa-working` and `DRAFT_FILE` are never cleared by the app |
| Style guide | `STYLE_FILE` is only ever read; the bundled `style.md` is a fallback, not a template that gets written |
| Model selection and API keys | `wa-agent`; credentials stay in Pi's own store |
| Chat | Dropped when `STORAGE_SCHEMA` in `src/app.js` is bumped, which happens only when their stored shape changes |

`index.html`, `style.css`, and `app.js` are served `no-cache` so an open tab picks up the new bundle on reload instead of running a stale one against a new API. Fonts are immutable.

## 10. Checks

```bash
npm run build
npm run check
```

`npm run check` validates server syntax, rebuilds the browser bundle, exercises Markdown escaping and rendering, checks selection scope, spelling and continuations, and verifies that Pi status has a consistent shape.

`npm run smoke:desktop` runs a built bundle — the `.app` on macOS, the binary beside its resources elsewhere — against a disposable folder and a moved `HOME`, so it never meets the writer's own config or draft. It asserts the three things only a packaged build can get wrong: the app starts and prints its port, the server inside it serves the seeded draft from the folder it was given, and killing the shell releases the port. It needs a display; a headless Linux runner puts `xvfb-run -a` in front. `.github/workflows/desktop.yml` runs it after every platform's build.

The UI itself needs neither: the page in the desktop window is the same page the server gives a browser, so `npm run test:browser` — the real routes against a fake provider — covers it, and adding `?shell=desktop` to that URL shows the desktop layout. What has no automated coverage is the window: the native dialogs, the menu, and the updater's own code.

## 11. Current boundaries

Stilura currently supports one browser-local plain-text document. It does not include:

- a separate reference/context editor;
- multiple documents side by side — the sidebar switches one active document within the folder, and import and export are a drop and a download;
- document history or versioning beyond CodeMirror's current-session undo stack;
- accounts, collaboration, or cloud sync;
- a language-specific local score outside English/Latin-script heuristics.

## 12. Follow-up work

- [ ] Clarify where documents and margin notes live and how they are stored.
  Map the writing folder, desktop `editor-state`, browser storage and agent
  configuration. Explain how notes attach to a document and what happens when
  files are moved or renamed. Define how the app and agents find the same
  document and notes, and how users locate, back up and restore both.
  Trigger: Claude read the wrong draft without `DRAFT_FILE`; margin notes
  required a separate `STILURA_STATE_DIR` connection.
