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
|          | attached selection                     |           |
|          | Ask anything...                        |           |
|          +-----------------------------------------+           |
+---------------------------------------------------------------+
```

The current product has one working-document pane. There is no separate context pane, file browser, or document list.

### Header

- `Litura` wordmark.
- Local style score when the document is predominantly Latin script.
- `Review` action. After a review it shows the number of active findings.
- Selected model name.
- Settings button.

### Editor

- Plain-text CodeMirror 6 editor with line wrapping and history.
- iA Writer Duo for document text; system UI font for controls.
- System light/dark theme.
- Draft saved to browser local storage after every edit.
- Bottom padding keeps the floating composer from covering the last lines.

### Composer

- Fixed near the bottom center of the window.
- Grows upward as messages, findings, and alternatives appear.
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

### 3.2 Automatic review

After 1.5 seconds of inactivity, the client considers completed sentences that:

- are at least 25 characters long;
- are not currently being edited;
- have not already been checked in the current session.

For Latin-script text, a sentence is sent only when its local score is at least 20. Non-Latin sentences bypass the English-only prefilter and are reviewed by the model.

The full document is included as context, but the server instructs the model to return findings only for the submitted target sentences. Automatic review runs one request at a time.

### 3.3 Full-document review

The `Review` button clears current findings and audits the entire non-empty document. The model checks both generic prose and reader structure, then returns at most eight findings with:

- `quote`: exact contiguous text from the draft;
- `pattern`: name of the writing problem;
- `reason`: why the quote is a strong example;
- `fix`: a short editing direction, not a rewrite.

Each returned quote is anchored to a non-overlapping occurrence in the current document. Findings appear as wavy underlines and move with edits outside their ranges. Editing inside a range removes its underline.

Structural findings use the same interaction as prose findings. They cover locally
fixable problems such as a broken opening promise, a buried point, an abrupt
old-to-new transition, or a dropped key term. The review treats constant-topic,
linking, and preview-and-develop progressions as alternatives rather than a
single mandatory paragraph template.

### 3.4 Finding and selection rewrites

A passage can be attached to the composer in three ways:

- click a review underline;
- select text and open the context menu;
- press `Cmd/Ctrl+K` with a selection.

Clicking a finding immediately requests alternatives using its editing direction. For an ordinary selection, the next composer message becomes the rewrite instruction.

The server returns exactly three strings. The client optionally ranks them by the resulting whole-document local score and displays that score delta for Latin-script drafts. Clicking a card replaces only the attached range. The remaining cards are then disabled.

### 3.5 Draft chat

When no passage is attached, composer messages open a conversation about the whole draft. The server includes the current document in the system context and retains the last 20 valid user/assistant messages supplied by the client.

Replies stream through Server-Sent Events and are rendered with a small, HTML-escaped Markdown subset: paragraphs, headings, emphasis, links, lists, inline code, and fenced code blocks.

Chat replies cannot directly modify the document.

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
- does not offer removal for credentials supplied by environment variables.

## 4. State and privacy

| State | Location | Lifetime |
|---|---|---|
| Working document | `localStorage["wa-working"]` | Until browser storage is cleared |
| Agent selection | `localStorage["wa-agent"]` | Until browser storage is cleared |
| Chat history | Browser memory | Until reload or `Clear` |
| Checked sentences and findings | Browser memory | Until reload or a full review reset |
| API credentials | Pi credential storage or environment | Managed by Pi |

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
|- review.js            local metrics and review-response helpers
|- markdown.js          safe minimal Markdown renderer for chat
|- selfcheck.js         assertion-based checks
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

If omitted, the server tries the `PI_PROVIDER` and `PI_MODEL` environment values, then preferred fallbacks, then the first available authenticated model. Unsupported thinking levels are clamped to a level supported by the model.

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

`style.md` is read for every request and prepended to the task prompt. It includes shared reader-orientation rules for opening promises, point placement, old-to-new flow, key-term continuity, and problem resolution. A shared `NO_SLOP` instruction is also added to prose-generating routes so the assistant does not intentionally produce patterns that review would immediately flag.

If `style.md` is missing, the server logs one warning and continues without it.

Review detects problems but does not rewrite. Rewrite, suggestion, idea, and chat prompts have separate output contracts and token limits.

## 8. Environment

| Variable | Purpose | Default |
|---|---|---|
| `PI_PROVIDER` | Preferred Pi provider ID | Selected from authenticated models |
| `PI_MODEL` | Preferred Pi model ID | Selected from authenticated models |
| `PI_THINKING_LEVEL` | Preferred reasoning level | `medium` |
| `PORT` | Local HTTP port | `3456` |
| `STYLE_FILE` | Writing style guide path | `<project>/style.md` |

## 9. Checks

```bash
npm run build
npm run check
```

`npm run check` validates server syntax, rebuilds the browser bundle, exercises Markdown escaping and rendering, checks style metrics and review anchoring, and verifies that Pi status has a consistent shape.

The current checks do not provide browser end-to-end coverage or mocked model-route tests.

## 10. Current boundaries

Litura currently supports one browser-local plain-text document. It does not include:

- a separate reference/context editor;
- file import, export, or filesystem persistence;
- document history or versioning beyond CodeMirror's current-session undo stack;
- accounts, collaboration, or cloud sync;
- a language-specific local score outside English/Latin-script heuristics.
