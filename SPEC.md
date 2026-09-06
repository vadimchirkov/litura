# Litura - Product and Technical Specification

## 1. Product

Litura is a standalone local writing editor. It helps an author find generic prose, discuss a draft, and try alternative wording while keeping every document change under explicit user control.

The product does not claim to determine whether text was written by AI. Its local score and model review identify named writing patterns only.

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
| Litura        local score   review   model              settings |
+---------------------------------------------------------------+
|                                                               |
|                  WORKING DOCUMENT                             |
|                                                               |
|                  CodeMirror editor                            |
|                                                               |
|              highlighted review findings                     |
|                                                               |
|          chat messages / finding / rewrite cards              |
|          +-----------------------------------------+           |
|          | attached-passage chip                  |           |
|          | Ask anything...                        |           |
|          +-----------------------------------------+           |
+---------------------------------------------------------------+
```

The current product has one working-document pane. There is no separate context pane, file browser, or document list.

### Header

- `Litura` wordmark.
- Local style score when the document is predominantly Latin script.
- `Review` action. After a review it shows the number of active findings; clicking it then moves the selection to the next finding and scrolls it into view, cycling from the end back to the first. Shift-click runs a new full review.
- Selected model name.
- Settings button.

### Editor

- Plain-text CodeMirror 6 editor with line wrapping and history.
- iA Writer Duo for document text; system UI font for controls.
- Warm paper canvas and header; chat blocks are white cards on it, without shadows.
- System light/dark theme.
- Draft saved to browser local storage after every edit.
- The editor reserves the measured height of the floating panel, so the caret,
  the line being typed, and any continuation panel scroll above it instead of
  disappearing behind the cards.

### Composer

- Fixed near the bottom center of the window.
- Grows upward as messages, findings, and alternatives appear.
- A backdrop fades the draft out behind the panel so cards read as floating above the document rather than as part of it.
- A send button sits at the right of the field and is disabled while the field is empty.
- An attached passage is named by a small chip, not quoted: the passage itself stays highlighted in the draft.
- `Enter` sends; `Shift+Enter` inserts a newline.
- `Escape` cancels an active request or detaches the current selection.
- `Clear` removes the in-memory conversation and visible cards.

## 3. Writing workflows

### 3.1 Local style score

The browser computes a score from 0 to 100 using:

- known English AI-tell words and phrases;
- sentence-length variation;
- moving lexical diversity;
- repeated three-word sequences.

For passages shorter than 40 words or three sentences, only the lexical component is used. The score is hidden for predominantly non-Latin text because the current word lists are English-specific.

The score is a heuristic used for feedback and request filtering. It is never sent to the model and is not an authorship probability.

Clicking the score adds a card naming the matched tell words and phrases as they appear in the draft, plus a line for each structural axis that reads badly. A number the writer cannot trace back to their own text is only something to argue with.

### 3.2 Automatic review

After 1.5 seconds of inactivity, the client considers completed sentences that:

- are at least 25 characters long;
- are not currently being edited;
- have not already been checked in the current session.

For Latin-script text, a sentence is sent only when its local score is at least 20. Non-Latin sentences bypass the English-only prefilter and are reviewed by the model.

The full document is included as context, but the server instructs the model to return findings only for the submitted target sentences. Automatic review runs one request at a time, and the `Review` control shows that a background check is in flight.

Automatic review can be switched off in settings, leaving the `Review` button as the only action that spends a model call. The setting is remembered.

### 3.3 Full-document review

The `Review` button clears current findings and audits the entire non-empty document. It runs a global pass for levels 1–4 and a local pass for levels 5–7 plus generic prose in parallel. It merges contained duplicate quotes of the same code and suppresses a level-6 finding whose quote contains or is contained by a level-3 finding's quote, then returns at most eight findings with:

- `code`: internal diagnostic level (`level-1` through `level-7`, or `generic-prose`); not shown in the interface;
- `quote`: exact contiguous text from the draft;
- `pattern`: name of the writing problem;
- `reason`: why the quote is a strong example;
- `fix`: a short editing direction, not a rewrite.

The prompt caps these at four words for `pattern` and twelve each for `reason` and `fix`: the card is read at a glance beside the draft, and a paragraph of explanation there is not read at all.

Each returned quote is anchored to a non-overlapping occurrence in the current document. Findings appear as wavy underlines and move with edits outside their ranges. Editing inside a range removes its underline.

A finding card carries a dismiss control. Dismissing removes the underline, the card, any alternatives requested for it, and cancels an in-flight request, so the counter only reports findings the author has not rejected.

Structural findings use the same underlines and finding cards as prose findings. They cover
problems such as a broken opening promise, a buried point, an abrupt
old-to-new transition, or a dropped key term. The review treats constant-topic,
linking, super-theme, and preview-and-develop progressions as alternatives rather than a
single mandatory paragraph template.

### 3.4 Finding and selection rewrites

A passage can be attached to the composer in three ways:

- click a review underline;
- select text and open the context menu;
- press `Cmd/Ctrl+K` with a selection.

An attached passage is marked in the draft with a tinted highlight that survives the editor losing focus, and moves with edits like a review underline. The composer shows only the finding's pattern name, or `Selected text` for an ordinary selection.

Clicking an underline places the caret where it was clicked and leaves the keyboard in the editor, so an underlined sentence stays as editable as any other text. `Cmd/Ctrl+K` and the context menu move focus to the composer instead, because both are explicit requests to instruct.

Editing inside the attached passage ends the attachment and cancels an in-flight rewrite: the author has taken the sentence over, and alternatives generated for the old wording no longer apply.

Clicking a generic prose finding attaches its quote and shows its card. It makes no model request: the card carries an `Offer rewrites` control, and reading the remark and fixing the sentence by hand is a complete outcome. Clicking the same underline again returns to the card already in the stream rather than repeating the remark.

A structural finding names a problem with a paragraph, not with the sentence it quotes, so clicking one attaches the whole blank-line-delimited paragraph around the quote and its `Offer rewrites` control asks for alternatives that rewrite that paragraph — sentences may be reordered and rejoined, facts and voice may not change. Typing in the composer with a structural finding attached still opens a discussion instead, which is the path for a change that has to move material between paragraphs.

For an ordinary selection, the next composer message becomes the rewrite instruction.

A group of alternatives carries a `Try again` control that discards the three and re-requests them with the same instruction and the same attached passage. It disappears once one alternative has been applied.

The server returns exactly three strings. The client optionally ranks them by the resulting whole-document local score and displays that score delta for Latin-script drafts. Clicking a card replaces only the attached range. The remaining cards are then disabled.

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

The model returns a 5-15 word continuation. Known local tell words veto the result. A valid continuation appears in a block below the current line without entering the document.

- `Tab`: insert the suggestion at its original cursor position.
- `Escape`: dismiss it.
- Typing or moving the cursor: dismiss it and cancel pending work.

### 3.7 `/idea` expansion

Typing `/idea <instruction>` on a line and pressing `Enter`:

1. removes the command text;
2. temporarily makes the editor read-only;
3. streams generated text into the command's position;
4. restores editing and saves the document.

If the request fails, the original command is restored.

### 3.8 Model and access settings

The settings dialog:

- discovers Pi credentials and supported provider environment variables;
- lists authenticated providers and their available models;
- exposes only thinking levels supported by the selected model;
- saves the active provider/model/thinking selection to local storage;
- adds and removes Pi API-key credentials;
- does not offer removal for credentials supplied by environment variables;
- switches automatic review on or off.

When no model is selected, the review, rewrite, and chat actions re-check Pi status once, then report the missing setup in the composer and open this dialog instead of failing silently. Automatic review and continuation suggestions stay silent and make no request.

## 4. State and privacy

| State | Location | Lifetime |
|---|---|---|
| Working document | `localStorage["wa-working"]` | Until browser storage is cleared |
| Working document mirror | `DRAFT_FILE` (default `<cwd>/draft.md`) | Until the file is deleted |
| Agent selection | `localStorage["wa-agent"]` | Until browser storage is cleared |
| Chat history | `localStorage["wa-chat"]`, last 20 turns | Until `Clear` or browser storage is cleared |
| Findings | `localStorage["wa-findings"]` | Until a new review, `Clear`, or browser storage is cleared |
| Automatic review setting | `localStorage["wa-autoreview"]` | Until browser storage is cleared |
| Update-check setting | `localStorage["wa-updatecheck"]`, off unless set to `on` | Until browser storage is cleared |
| Last seen published version | `localStorage["wa-update"]` as `{ latest, at }`, reused for 24 hours | Until browser storage is cleared |
| Checked sentences | Browser memory | Until reload or a full review reset |
| API credentials | Pi credential storage or environment | Managed by Pi |

The document is written to a local Markdown file 800 milliseconds after the last edit. The browser copy is authoritative: the file is read back into the editor only when `localStorage["wa-working"]` is empty, or when the writer accepts the prompt described below.

Findings are stored as their quotes and are re-anchored against the document at load, so a finding whose text has since changed is dropped rather than misplaced. The conversation is restored as messages only; finding and alternative cards are not.

If the file and the browser copy differ — at startup, or when the window regains focus — Litura says so and offers to load the file. Until the writer accepts, the browser copy stands and the next save overwrites the file. Nothing is merged.

`Cmd/Ctrl+S` downloads the draft as `draft.md`. Dropping a text file on the editor replaces the draft, after a confirmation when the current draft is not empty.

Every model-backed action sends the current full document to the selected provider. Rewrite and review requests additionally send the relevant selection or target passages. The local score does not make a network request.

## 5. Technical architecture

- **Runtime:** Node.js 20 or newer.
- **Server:** native `node:http`, bound to `127.0.0.1`.
- **Frontend:** vanilla JavaScript and CodeMirror 6.
- **Bundling:** esbuild produces an IIFE bundle.
- **Model runtime:** `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent`.
- **Streaming:** Server-Sent Events for `/idea` and `/chat`.
- **Non-streaming:** JSON for status, credentials, review, rewrite, and suggestions.

`npm start` bundles the frontend before starting the server. If that build fails, the server logs the error and serves the existing bundle. `public/app.js` is generated and should not be edited directly.

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
| `GET` | `/draft` | Current contents of the draft file as `{ text, path }` |
| `PUT` | `/draft` | Overwrite the draft file with `{ text }` |
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

## 9. Distribution and updates

Litura is published to npm as `litura-app`; the command it installs is `litura`. It runs as `npx litura-app` from the folder holding the draft. For a bare package name npm re-resolves the registry manifest on every run, so starting Litura is the update; a global install (`npm i -g`) shadows that check and has to be updated by hand.

`litura --version` prints the running version. `litura --check-update` prints the published version next to it, and reports an unpublished package rather than comparing against nothing. Neither flag ranks the two versions: a local build legitimately runs ahead of the registry, and ordering semver correctly would be a dependency.

In the browser, `Ask npm about new versions` in settings is off by default and stored in `wa-updatecheck`. Off, the browser calls `/api/version` without `?check=1` and the server contacts nothing. On, it asks at most once every 24 hours, caches the answer in `wa-update`, and shows a header badge linking to the changelog when the published version differs from the running one. Switching it off hides the badge rather than leaving a stale one.

### Releasing

A release is a tag. `npm version <patch|minor|major>` refuses a dirty tree, bumps `package.json`, commits, and tags; `git push --follow-tags` then triggers `.github/workflows/release.yml`, which runs `npm run check`, verifies the tag matches `package.json`, and publishes with npm trusted publishing (OIDC, no stored token). Every other push runs the checks without publishing. `npm run check` passes without provider credentials: the Pi section asserts the shape of the model list, not its contents.

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
