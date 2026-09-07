# Litura - Product and Technical Specification

## 1. Product

Litura is a standalone local writing editor. It helps an author find generic prose, discuss a draft, and try alternative wording while keeping every document change under explicit user control.

The product does not claim to determine whether text was written by AI. Its review identifies named writing patterns only.

### Product principles

- The document stays central; assistant UI floats above it instead of replacing it.
- Detection must name a concrete, checkable problem.
- The model may suggest text but never edits the document autonomously.
- Specific facts, unusual details, uncertainty, humor, and the author's voice should survive a rewrite.
- Empty output is better than a low-quality suggestion.
- Local analysis should avoid model calls when it can confidently do so.

## 2. Interface

```text
+---------------------------------------------------------------+
| Litura  draft.md v  saved        Slop Score 65  settings |
+---------------------------------------------------------------+
|                                                               |
|          WORKING DOCUMENT             | finding card        |
|                                       |                     |
|          CodeMirror editor            | finding card        |
|          (never moves for a card)     |                     |
|      highlighted review findings      | [< 2 of 3 >] card   |
|                                                               |
|          chat messages and replies                            |
|          [Review draft] reviewing...                          |
|          +-----------------------------------------+           |
|          | attached-passage chip                  |           |
|          | Ask anything...                        |           |
|          +-----------------------------------------+           |
+---------------------------------------------------------------+
```

The current product has one working-document pane. There is no separate context pane, file browser, or document list.

### Header

One row, and nothing in it spends a model call. Everything about the file is behind its name, the save status rides beside it, and the local score sits at the far end. The header is the frame the draft is read in.

- `Litura` wordmark.
- Document menu, labelled with the draft's file name: `Open a file…`, `Export a copy`, `History`.
- Save status: `Saved`, `Saving…`, `Unsaved changes`, a save error, or a paused autosave after a conflict.
- Local slop score, labelled `Slop Score`, when the draft is predominantly Latin script.
- Settings button.

The selected model is named in settings, not in the header: it is chosen rarely and read never.

Actions that spend a model call are not here: they live with the assistant, above the composer. There is no word count and no assistant-visibility toggle.

### Rail

The rail floats in the margin the centred text column already leaves empty, so the draft sits exactly where it sat before any card existed. It appears when that margin can hold a 240-pixel card and a gutter — measured from the text column's own padding, not assumed at a breakpoint — which is a window of about 1160 pixels or wider.

- A remark about a place in the draft lives there: finding cards, and the rewrite strip while options are being tried on. Without a rail the cards stack in the panel and the strip returns to the action row.
- A card names the problem, why it is one, and the editing direction after an arrow. Hovering it lights the passage it belongs to; the open card gets a firmer border, no color, to stand out among its neighbours — what is attached is already named in the composer chip. The dismiss control appears on hover and on keyboard focus.
- Each card is positioned against the passage it anchors to. Cards that would overlap are pushed down in document order; a card whose passage has scrolled out of view is hidden with its mark.
- In a narrower window there is no rail and the same nodes stack in the panel instead. Crossing that width moves them; nothing is rebuilt or lost.
- Only the cards take clicks. The empty margin around them still belongs to the editor.

The panel keeps what is about the draft as a whole: typed messages, replies, `Review draft`, review status, and the composer.

### Editor

- Plain-text CodeMirror 6 editor with line wrapping and history.
- iA Writer Duo for document text; system UI font for controls.
- Warm paper canvas and header; chat blocks are white cards on it, without shadows.
- System light/dark theme.
- Draft saved to browser local storage after every edit.
- The placeholder of an empty draft carries the only instructions in the product: how to open a file, how to rewrite a passage, and what `Review draft` sends where.
- The editor reserves the measured height of the floating panel, so the caret,
  the line being typed, and any continuation panel scroll above it instead of
  disappearing behind the cards.

### Composer

- Fixed near the bottom center of the window.
- Grows upward as messages, findings, and alternatives appear.
- A backdrop fades the draft out behind the panel so cards read as floating above the document rather than as part of it.
- A send button sits at the right of the field and is disabled while the field is empty. While the model is working on something the writer asked for, it is that work: the arrow gives way to a ring turning around a stop square, and pressing it stops the request. There is no separate stop control — the status and the way out are the button they just pressed. Background work — a continuation, a paragraph checked while typing — never appears there: the writer did not press send for it, and finding the arrow replaced by a spinner on every pause would make the composer feel taken away.
- A row of actions sits between the stream and the field: `Review draft` and one line of review status truncated to the leftover width. The rewrite strip joins that row only when the rail is not in the layout.
- There is no findings list. The marks in the draft are the navigation: clicking one opens its card, and `F8` and `Shift+F8` step through them in document order.
- An attached passage is named by a small chip, not quoted: the passage itself stays highlighted in the draft.
- One field, no mode control. What the message does is decided by what is attached: a passage the writer selected is a rewrite target, a finding is something to ask about, and nothing attached is a conversation about the draft. The placeholder says which of the three is active.
- `Enter` sends; `Shift+Enter` inserts a newline.
- `Escape` cancels an active request or detaches the current selection.
- A single control above the stream closes what the assistant is showing and opens it again: `×` over an open conversation, `Conversation` over a closed one. One press puts away both the turns and the finding cards standing in the rail — two `×` in two places for one idea is two presses to get a clean screen. The composer is not part of it: it is how the writer talks to the draft at all, so it is always there.
- Closing is a view, not an edit. Nothing is discarded: the turns stay in memory and in storage, the findings and their marks stay in the draft, and clicking a mark builds its card again without reopening the conversation. Anything new arriving opens the stream by itself, so a reply never lands somewhere the writer cannot see. There is no control that discards the conversation; replacing the document does that, and the server only ever reads the last 20 turns.
- A failed model call is one short sentence naming the cause — a rejected key, a rate limit, an overloaded provider — and one button doing something about it. The sentence never carries the remedy as a second clause: `Try again` is the remedy. Where retrying cannot help there is no retry, and a key problem offers `Open settings` instead. The provider's payload goes to the tooltip and the console, where it is there for a bug report and nowhere else.

## 3. Writing workflows

### 3.1 Local slop score

The browser computes a score from 0 to 100 using:

- known English AI-tell words and phrases;
- sentence-length variation;
- moving lexical diversity;
- repeated three-word sequences.

For passages shorter than 40 words or three sentences, only the lexical component is used. The score is hidden for predominantly non-Latin text because the word lists are English-specific. It is a heuristic, never sent to the model, and not an authorship probability.

Clicking it adds a card naming the matched tells as they appear in the draft, a line for each structural axis that reads badly, and what the number does not measure. A number the writer cannot trace back to their own text is only something to argue with.

### 3.2 Automatic review

On by default. 1.5 seconds after the last edit the client takes up to three blank-line-delimited paragraphs that:

- are at least 25 characters long;
- end in sentence punctuation, unless more text follows them;
- do not contain the caret;
- have not already been checked with the same neighbours and model.

There is no local prefilter: a paragraph is judged by the model or not at all, in whatever language it is written.

The full document is included as context, but the server instructs the model to return findings only for the submitted target paragraphs. Automatic review runs one request at a time, and the `Review draft` control shows that a background check is in flight.

The text already in the file when it is opened counts as checked. Opening a draft spends nothing; auditing what is already written is what `Review draft` is for, and a paragraph the writer touches is checked as soon as they finish it.

Automatic review and continuation suggestions are separate settings, both on by default. With both off, only actions the writer starts spend a model call. The settings are remembered.

### 3.3 Full-document review

The `Review draft` action clears current findings and audits the entire non-empty document. It runs a global pass for levels 1–4 and a local pass for levels 5–7 plus generic prose in parallel. It merges contained duplicate quotes of the same code and suppresses a level-6 finding whose quote contains or is contained by a level-3 finding's quote, then returns at most eight findings with:

- `code`: internal diagnostic level (`level-1` through `level-7`, or `generic-prose`); not shown in the interface;
- `quote`: exact contiguous text from the draft;
- `pattern`: name of the writing problem;
- `reason`: why the quote is a strong example;
- `fix`: a short editing direction, not a rewrite.

The prompt caps these at four words for `pattern` and twelve each for `reason` and `fix`: the card is read at a glance beside the draft, and a paragraph of explanation there is not read at all.

Each returned quote is anchored to a non-overlapping occurrence in the current document. Findings appear as a quiet tinted band with a hairline under it — a remark to weigh, not a spell-checker's error to clear — and move with edits outside their ranges. Editing inside a range removes its mark. The attached passage uses the same tint one step stronger, so the two states never read alike.

A finding card carries a dismiss control. Dismissing removes the mark, the card, any alternatives requested for it, and cancels an in-flight request, so the counter only reports findings the author has not rejected.

Structural findings use the same marks and finding cards as prose findings. They cover
problems such as a broken opening promise, a buried point, an abrupt
old-to-new transition, or a dropped key term. The review treats constant-topic,
linking, super-theme, and preview-and-develop progressions as alternatives rather than a
single mandatory paragraph template.

### 3.4 Finding and selection rewrites

A passage can be attached to the composer in three ways:

- click a review mark;
- select text and open the context menu;
- press `Cmd/Ctrl+K` with a selection.

An attached passage is marked in the draft with a tinted highlight that survives the editor losing focus, and moves with edits like a review mark. A finding already carries its own mark, so clicking one keeps that mark's look rather than laying the selection tint over it — the tracking is the same either way, only a plain selection needs the tint to show anything at all. For the same reason the composer chip is for selections only, reading `Selected text`: a finding is named on its own card beside the line, and the placeholder says what the next message will do with it. A chip on top of that read as the sentence having been pulled into the composer, which is not what happened.

Clicking a mark places the caret where it was clicked and leaves the keyboard in the editor, so a marked sentence stays as editable as any other text. `Cmd/Ctrl+K` and the context menu move focus to the composer instead, because both are explicit requests to instruct.

Editing inside the attached passage ends the attachment and cancels an in-flight rewrite: the author has taken the sentence over, and alternatives generated for the old wording no longer apply.

Clicking any finding attaches exactly the passage its mark covers and shows its card. It makes no model request: the card carries a single `Options` control, and reading the remark and fixing the sentence by hand is a complete outcome. Clicking the same mark again returns to the card already in the stream rather than repeating the remark.

There is one replacement scope, and it is the quoted passage. The tint in the draft and the range a rewrite would replace are the same span, so a finding never silently rewrites more than it marked, and the card asks for nothing before it can be used. A structural finding names a problem with the paragraph around its quote; its rewrite still replaces the quote, and the whole document goes to the model as context. A change that has to move material between paragraphs is a conversation: typing in the composer with a finding attached opens one.

For an ordinary selection, the next composer message becomes the rewrite instruction.

The server returns exactly three strings, and they are tried on rather than listed. One at a time, the option is substituted into the draft where the passage sits, so it is read with the sentences around it — which is what decides whether it works. It arrives on a plain white sheet rather than the accent tint a mark or an attached passage carries: inside a preview, colour belongs to the edit, and a wash underneath drowns it. Nothing is ranked or reordered by a local metric.

A finding card holds one thing at a time: the remark, then the request in flight, then the strip. Clicking `Options` replaces the remark with `Looking for options…`; when the answer lands the same slot holds the strip instead. Cancelling — `Escape`, editing, `Try again` finding nothing — puts the remark back exactly as it was.

Only the remark is worth a box. For the two states after it the card keeps its place in the rail and drops its walls: a bordered panel around a status line, or around a row of stepper controls, is more furniture than a passing moment deserves. The strip carries no border, background or padding of its own — the controls are the interface, and nothing needs to hold them. Without a card — an ordinary selection, or `/idea` — the strip has no block to sit in and stands on its own: in the rail beside the passage, or above the composer in place of `Review draft` when there is no rail.

The substitution itself is a decoration, not an edit: the document is untouched while the writer is choosing, so nothing is autosaved, no finding is re-anchored, and undo stays clean.

- `‹ N of 3 ›` steps through the options and the writer's own wording as one ring — `Original`, then 1, 2, 3, and round again — also with `←` and `→`;
- an option is shown as a word-level edit script against the writer's own wording. What the edit *is* stays on the line for as long as the option is up: cut words stay struck through, added words stay where they landed. What is temporary is the colour. It walks through the changed runs in reading order, ninety milliseconds apart, holds for about a second and a half, and leaves the same way — so the passage announces what changed and then settles into something readable as a sentence rather than as a coloured diff. Nothing about the highlight animates size; the line's reserved height is measured against this, and a highlight that moved the text would make that measurement a lie. A cut longer than 120 characters is not struck through: a rewritten paragraph in strikethrough is a wall, not a diff;
- every option is a different length, so the paragraph would rewrap and step the rest of the draft up and down as the writer flips through. The tallest of the stops — the writer's own wording included — is measured once against a copy of the real line when the options arrive, and reserved as a minimum height on that line. Shorter options leave a little slack rather than dragging the page up. A rewrite spanning whole paragraphs is not reserved: it already replaces blocks, where there is nothing to hold still;
- stepping back to `Original` runs the same close-up in reverse — the option's words are the ones that go, the writer's own come back untinted — and only then does the sheet leave, so nothing about the passage ever cuts;
- `Try again` discards the three and re-requests them with the same instruction and the same passage.

There is no confirm button. Whatever stop the writer leaves the ring on is what the draft keeps, because they have been reading that stop in place the whole time and `Original` is one of the stops. Leaving happens by pressing `Enter`, clicking into the draft, or turning to another finding; the replacement covers the range the answer was generated for, and only while that range still holds its original text. `Escape` returns the ring to `Original` and closes, so cancelling is still cancelling. Focus moves to the strip when the options arrive: at that moment the writer is choosing, not typing.

An edit nobody pressed a button for has to leave a way back in sight. After a replacement a single `Undo` stands for eight seconds in the same card the options sat in, beside the sentence that changed; there is no word for what happened, because the sentence says it. It stands on its own, with no panel around one button, and the countdown is in the button itself: a bar across its foot drains over those eight seconds, so the control is also the clock, and the writer sees the offer expiring rather than guessing at it. `Undo` puts back exactly what was replaced and only while it is still there to put back — it is not the editor's undo stack, which by then may belong to something the writer typed afterwards. The History snapshot taken before every replacement is the longer way back.

Nothing commits on a timer. A document that changes while its author is looking out of the window is the one thing the product principles rule out.

A finding card is hidden while its own options are on screen — it has said its piece, and the strip owns the decision. Leaving on `Original` or pressing `Escape` brings it back; keeping an option removes it, because the passage it remarked on is gone.

### 3.5 Draft chat

When no passage is attached, composer messages open a conversation about the whole draft. The server includes the current document in the system context and retains the last 20 valid user/assistant messages supplied by the client.

Replies stream through Server-Sent Events and are rendered with a small, HTML-escaped Markdown subset: paragraphs, headings, emphasis, links, lists, inline code, and fenced code blocks.

Chat replies cannot directly modify the document.

The conversation survives a reload. A message sent with a finding attached carries that finding's context to the model but is shown to the writer as what they typed.

### 3.6 Continuation suggestions

After 900 milliseconds without typing, a suggestion may be requested when:

- the document contains at least 15 non-whitespace characters;
- the selection is collapsed;
- the caret is at the end of a paragraph or before a blank line;
- the current line is not an `/idea` command.

A failed continuation says so in the status line rather than going quiet: a feature that fails in silence is indistinguishable from a broken one. The model returns a 5-15 word continuation. Known local tell words veto the result. A valid continuation appears in a block below the current line without entering the document.

- `Tab`: insert the suggestion at its original cursor position.
- `Escape`: dismiss it.
- Typing or moving the cursor: dismiss it and cancel pending work.

### 3.7 `/idea` expansion

Typing `/idea <instruction>` on a line and pressing `Enter` streams the expansion into the assistant panel, then offers it as a preview over the command line — the same try-on strip as a rewrite, with one option and no `Try again`. The command line is replaced only if the writer keeps it.

If the request fails or is stopped, whatever arrived stays in the panel as text and the command line is untouched.

### 3.8 Model and access settings

The settings dialog:

- discovers Pi credentials and supported provider environment variables;
- lists the models each authenticated provider offers now, not the snapshot bundled with the Pi dependency. That snapshot ages, and a model added after it was published cannot be selected at all: Pi refuses a model its catalog does not know. Asking a provider what it offers is a call to the provider the writer already pointed the app at, so it needs no permission the app does not already have; `LITURA_OFFLINE_MODELS` stops it, and a failed refresh falls back to the list Pi already has;
- offers provider and model as searchable comboboxes: a trigger naming the current choice, and a popover holding a search box and the matching rows, each naming one model. Typing still matches a model's id as well as its name — the writer who knows the id finds the row, and the row still reads as a name. Six hundred models do not fit a `select`, and a native `datalist` cannot stand in — its popup never reaches the top layer above a modal dialog, and a field already holding an answer filters the writer's typing against it. The popover API still supplies the top layer, light dismiss and `Escape`; `↑` `↓` walk the list and `Enter` takes the highlighted row;
- lists authenticated providers and their available models;
- exposes only thinking levels supported by the selected model;
- saves the active provider/model/thinking selection to local storage;
- adds and removes Pi API-key credentials;
- does not offer removal for credentials supplied by environment variables;
- switches automatic review and continuation suggestions on or off, both on by default;
- switches the npm update check on or off, on by default.

The switches take effect immediately; the provider, model, and reasoning selection is applied by `Save`.

When no model is selected, the review, rewrite, and chat actions re-check Pi status once, then report the missing setup in the composer and open this dialog instead of failing silently. Automatic review and continuation suggestions stay silent and make no request.

## 4. State and privacy

Document-specific browser keys use the prefix `litura:<id>:`, where `id` is the SHA-256 hash of the canonical draft path returned by the server. In the table below, document keys are relative to that prefix. Model and background-action settings remain shared within the browser origin.

| State | Location | Lifetime |
|---|---|---|
| Working document | `wa-working` and `wa-working:<tabId>` in local storage; tab ID in session storage | Until browser storage is cleared |
| Working document mirror | `DRAFT_FILE` (default `<cwd>/draft.md`) | Until the file is deleted |
| Agent selection | `localStorage["wa-agent"]` | Until browser storage is cleared |
| Chat history | `wa-chat`, last 20 turns | Until document replacement or browser storage is cleared |
| Findings | `wa-findings`, with the reviewed document text | Replaced by a successful full review; cleared on document replacement |
| Dismissed findings | `dismissed`, last 100, tied to exact document text | Until document replacement or browser storage is cleared |
| Disk history | `<draft>.litura-history`; latest 20 returned to the UI | No automatic deletion |
| Browser checkpoints | `snapshots`, last 10; other tabs' working copies also appear in History | Checkpoints rotate; working copies remain until browser storage is cleared |
| Automatic review setting | `localStorage["wa-autoreview"]`, on unless set to `off` | Until browser storage is cleared |
| Continuation-suggestion setting | `localStorage["wa-autosuggest"]`, on unless set to `off` | Until browser storage is cleared |
| Update-check setting | `localStorage["wa-updatecheck"]`, on unless set to `off` | Until browser storage is cleared |
| Last seen published version | `localStorage["wa-update"]` as `{ latest, at }`, reused for 24 hours | Until browser storage is cleared |
| Checked paragraphs | Browser memory, keyed by text, neighbours and model | Until reload or a full review reset |
| API credentials | Pi credential storage or environment | Managed by Pi |

Each edit updates the browser working copy and schedules a disk save after 800 milliseconds. Saves run one at a time. Each request includes the last known file revision; a stale revision returns `409` without overwriting the file. The server keeps the previous disk text, writes a temporary file, flushes it, rechecks the revision, and renames the temporary file over the draft. A lock coordinates saves between Litura processes; external editors do not participate in that lock.

At startup, the editor waits for the server to identify and read the draft. It restores this tab's working copy when available, otherwise the document's shared browser copy, otherwise the disk text. An empty browser copy is distinct from a missing one. Legacy unscoped browser text is offered for export, not silently imported into another workspace.

If browser and disk differ at startup, or the disk revision changes when the window regains focus or visibility, Litura pauses autosave. The conflict dialog shows both copies and offers `Use disk copy`, `Keep browser copy`, or `Export browser copy`. Closing the dialog does not resume saving. Choosing a copy resumes revision-checked saving; another external change can cause a new conflict. Nothing is merged automatically.

Save errors remain visible and pause autosave until the writer retries. A failed request does not advance the recorded disk revision. The browser warns before leaving while a save is in flight or the working text differs from the last confirmed disk copy.

Findings are restored only when their stored document text exactly matches the loaded draft, then their quotes are re-anchored. Chat restores messages, not finding cards or rewrite previews. Replacing the document clears findings, dismissed findings and chat, and keeps a browser checkpoint of the previous text. Keeping an AI replacement also creates a checkpoint. Rewrite previews alone change neither stored copy.

`Cmd/Ctrl+S` requests an immediate disk save, respecting any paused conflict or error. `Export a copy` downloads the current text using the workspace draft's filename. `Open a file…` and drag-and-drop accept `.md`, `.markdown` and `.txt` files up to 1 MiB and ask before importing. Import replaces the current workspace draft's contents; it does not switch the server to the imported file's path. History can restore a previous version after confirmation while keeping a checkpoint of the current text.

Every model-backed action sends the current full document to the selected provider. Rewrite and review requests additionally send the relevant selection or target passages.

## 5. Technical architecture

- **Runtime:** Node.js 20 or newer.
- **Server:** native `node:http`, bound to `127.0.0.1`.
- **Frontend:** vanilla JavaScript and CodeMirror 6.
- **Bundling:** esbuild produces an IIFE bundle.
- **Model runtime:** `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent`.
- **Streaming:** Server-Sent Events for `/idea` and `/chat`.
- **Non-streaming:** JSON for status, credentials, review, rewrite, and suggestions.

`npm start` bundles the frontend before starting the server in a source checkout. If the build fails, startup stops with an error. The published package has no `src/` directory and serves its bundled frontend without rebuilding. `public/app.js` is generated and should not be edited directly.

### File structure

```text
litura/
|- README.md            product overview and setup
|- SPEC.md              product and technical behavior
|- index.js             build step, HTTP server, routes, and prompts
|- pi.js                Pi discovery, credentials, model resolution, requests
|- review-prompt.js     shared review taxonomy and production prompt
|- review-model.js      model request, response parsing, and bounded retries
|- review.js            local metrics and review-response helpers
|- markdown.js          safe minimal Markdown renderer for chat
|- selfcheck.js         assertion-based checks
|- deepcheck.js         model-backed essay and paragraph checks
|- style.md             writing constraints injected into model prompts
|- plugin.json          webview plugin manifest (/write, port 3456)
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
| `GET` | `/draft` | `{ text, path, id, exists, revision }`; a missing file has empty text and revision `missing` |
| `PUT` | `/draft` | Save `{ text, revision }`; returns `{ saved: true, text, path, id, exists, revision }`, or `409` with `{ error, current }` when the revision differs |
| `GET` | `/draft/history` | `{ snapshots }`, latest 20 disk backups with `text`, `at` and `revision` |
| `GET` | `/api/version` | `{ name, current }`; with `?check=1` also `latest` from the npm registry, or `error` if it is unreachable |
| `GET` | `/api/agent/status` | Providers, models, auth status, and default selection |
| `POST` | `/api/agent/credentials` | Save a provider API key through Pi |
| `DELETE` | `/api/agent/credentials` | Remove a stored provider credential |
| `POST` | `/review` | Return up to eight writing-pattern findings |
| `POST` | `/rewrite` | Return three replacement variants |
| `POST` | `/suggest` | Return a short continuation |
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
| `/review` | `document`, optional `target`, optional `context`, `agent` |
| `/rewrite` | `document`, `selected`, optional `instruction`, optional `context`, `agent` |
| `/suggest` | `document`, optional `cursor`, optional `context`, `agent` |
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

`style.md` is read for every request and prepended to the task prompt. It includes shared reader-orientation rules for opening promises, point placement, old-to-new flow, key-term continuity, and problem resolution. Its prose diagnostics also cover vague attribution, mind-like agency assigned to abstractions, stacked hedging, and manufactured emphasis. A shared `NO_SLOP` instruction is added to prose-generating routes so the assistant does not intentionally produce patterns that review would immediately flag.

If `style.md` is missing, the server logs one warning and continues without it.

Review detects problems but does not rewrite. Rewrite, suggestion, idea, and chat prompts have separate output contracts and token limits.

The rewrite prompt leads with the selection, then the instruction, then the containing sentence with the selection replaced by a `___` slot, and only then the full document with the selection marked. A variant longer than three times the selection is treated as a whole-document rewrite: the request is repeated once with the scope restated. Unparseable answers are retried up to three attempts in total.

Each review pass validates diagnostic codes against its assigned levels and checks exact quotes against the audited source. Invalid responses are retried, up to three attempts with a 90-second timeout per attempt. Invalid finding objects are errors, not empty reviews.

## 8. Environment

| Variable | Purpose | Default |
|---|---|---|
| `PI_PROVIDER` | Preferred Pi provider ID | Selected from authenticated models |
| `PI_MODEL` | Preferred Pi model ID | Selected from authenticated models |
| `PI_THINKING_LEVEL` | Preferred reasoning level | `medium` |
| `PORT` | Local HTTP port; the next free port up to +10 is used if taken | `3456` |
| `STYLE_FILE` | Writing style guide path | `<cwd>/style.md`, else the bundled `style.md` |
| `DRAFT_FILE` | Draft mirror path | `<cwd>/draft.md` |
| `LITURA_NO_OPEN` | Set to skip opening the browser at startup | unset |
| `LITURA_OFFLINE_MODELS` | Set to stop Litura refreshing provider model lists | unset |

## 9. Distribution and updates

Litura is published to npm as `litura-app`; the command it installs is `litura`. It runs as `npx litura-app` from the folder holding the draft. For a bare package name npm re-resolves the registry manifest on every run, so starting Litura is the update; a global install (`npm i -g`) shadows that check and has to be updated by hand.

`litura --version` prints the running version. `litura --check-update` prints the published version next to it, and reports an unpublished package rather than comparing against nothing. Neither flag ranks the two versions: a local build legitimately runs ahead of the registry, and ordering semver correctly would be a dependency.

In the browser, `Ask npm about new versions` in settings is on by default and stored in `wa-updatecheck`. Off, the browser calls `/api/version` without `?check=1` and the server contacts nothing. On, it asks at most once every 24 hours, caches the answer in `wa-update`, and shows a header badge linking to the changelog when the published version differs from the running one. Switching it off hides the badge rather than leaving a stale one.

### Releasing

A release is a tag. `npm version <patch|minor|major>` refuses a dirty tree, bumps `package.json`, commits, and tags. Push the branch and the tag as two pushes — `git push && git push --tags` — rather than `--follow-tags`: pushing v0.1.0 together with its branch produced a run for the branch only. The tag push triggers `.github/workflows/release.yml`, which runs `npm run check`, verifies the tag matches `package.json`, and publishes with npm trusted publishing (OIDC, no stored token). Every other push runs the checks without publishing. `npm run check` passes without provider credentials: the Pi section asserts the shape of the model list, not its contents.

### What survives

| Survives an update | Mechanism |
|---|---|
| Draft | `wa-working` and `DRAFT_FILE` are never cleared by the app |
| Style guide | `STYLE_FILE` is only ever read; the bundled `style.md` is a fallback, not a template that gets written |
| Model selection and API keys | `wa-agent`; credentials stay in Pi's own store |
| Findings and chat | Dropped when `STORAGE_SCHEMA` in `src/app.js` is bumped, which happens only when their stored shape changes |

`index.html`, `style.css`, and `app.js` are served `no-cache` so an open tab picks up the new bundle on reload instead of running a stale one against a new API. Fonts are immutable.

## 10. Checks

```bash
npm run build
npm run check
npm run check:deep
```

`npm run check` validates server syntax, rebuilds the browser bundle, exercises Markdown escaping and rendering, checks style metrics and review anchoring, and verifies that Pi status has a consistent shape.

`npm run check:deep` sends synthetic failures and clean controls through the configured Pi model and the exact production review prompts. It covers the seven reader-structure levels, exact quote anchoring, targeted-review scope, all four valid paragraph progressions, and paired positive/control cases for selected generic prose diagnostics. Use `DEEP_CASE=name` to run matching cases and `DEEP_RUNS=3` to measure repeatability. The command makes model requests and is therefore kept out of the fast check.

The model checks are regression tests, not an independent accuracy benchmark. Set `DEEP_REPORT=results.json` to save individual findings and failures. See [review-evaluation.md](docs/review-evaluation.md) for source provenance, development results, limitations, and the manual browser smoke check. There is no automated browser end-to-end suite.

## 11. Current boundaries

Litura currently supports one browser-local plain-text document. It does not include:

- a separate reference/context editor;
- a document picker or multiple documents — the mirror file is one fixed path, and import and export are a drop and a download;
- document history or versioning beyond CodeMirror's current-session undo stack;
- accounts, collaboration, or cloud sync;
- a language-specific local score outside English/Latin-script heuristics.
