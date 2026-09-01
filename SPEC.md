# Writing Assistant — Spec

## Overview

Standalone local web app. The left pane holds **context** (reference material, notes, sources) and the right pane holds the **working document**. Pi provides model discovery, authentication, provider/model selection, reasoning levels, and text generation.

---

## Layout

```
┌─────────────────────┬─────────────────────┐
│   CONTEXT           │   WORKING TEXT      │
│                     │                     │
│  (read-only or      │  (editable,         │
│   editable)         │   main focus)       │
│                     │                     │
└─────────────────────┴─────────────────────┘
```

- Both panes are plain text editors (monospace font, like the screenshot)
- Resizable split via drag handle
- Context pane: paste or type reference material, notes, sources
- Working pane: the document being written

---

## Features

### 1. `/idea` Command

**Trigger:** User types `/idea <text>` anywhere in the working pane and presses Enter.

**Behavior:**
- Detect the `/idea ...` pattern on the current line
- Send to LLM: context text + full working document + the idea prompt
- Stream-generate a paragraph/passage in place of the `/idea` line
- Replace the `/idea <text>` line with the generated text inline

**System prompt for idea generation:**
> You are a writing assistant. Given the context material (left pane) and the current working document, expand the following idea into a well-written passage that fits the tone and topic. Return only the passage, no commentary.

---

### 2. Text Selection Popover

**Trigger:** User selects text in the working pane **and then right-clicks** (contextmenu event). Native browser context menu is suppressed. If user right-clicks without a selection, native context menu is not suppressed.

**Popover UI:**
- Appears near the selection (above or below, whichever fits)
- Contains:
  - A short text input: "What should change?" (placeholder)
  - A "Generate" button
  - Keyboard shortcut: `Cmd+Enter` to generate

**Behavior on Generate:**
1. Send to LLM: context + full working text + selected text + user's instruction
2. Generate **3 variants** of the selected passage
3. Display the 3 variants inside the popover as clickable cards
4. On card click: replace the selected text in the working pane with that variant
5. Close the popover

**System prompt for variants:**
> You are a writing assistant. Generate exactly 3 different rewrites of the selected text based on the instruction. Each variant should be distinct in phrasing. Return them as a JSON array: ["variant1", "variant2", "variant3"]. No commentary.

**UX details:**
- Popover closes on Escape or click outside
- While generating, show a loading spinner inside the popover
- Variants are numbered 1–3, displayed as full text blocks
- Hover state on each variant card to indicate it's clickable

---

### 3. Inline Suggestions

- Pi requests a short continuation after 900 ms of idle typing
- The continuation appears as ghost text at the cursor
- Tab accepts it; Escape dismisses it

### 4. Model and access settings

- Discovers existing Pi credentials and provider environment variables
- Lists authenticated providers and their available models
- Selects provider, model, and supported reasoning level
- Adds or removes Pi API-key credentials
- Persists the editor's selection in local storage

---

## Tech Stack

- **Runtime:** Node.js
- **Server:** native `http`
- **Frontend:** Vanilla JS + CodeMirror 6, bundled with esbuild
- **LLM runtime:** Pi (`@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent`)
- **Streaming:** Server-Sent Events (SSE) for `/idea` generation
- **Non-streaming:** Single JSON response for the 3-variant popover

---

## File Structure

```
writing-assistant/
├── SPEC.md          ← this file
├── README.md
├── package.json
├── index.js         ← HTTP server + API routes
├── pi.js            ← Pi auth, model discovery, and generation
├── src/
│   └── app.js       ← frontend source
└── public/
    ├── index.html   ← full app UI
    ├── style.css
    └── app.js       ← generated frontend bundle
```

---

## API Routes

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/` | Serve the app HTML |
| `GET` | `/api/agent/status` | Available Pi providers, models, auth, and default selection |
| `POST` | `/api/agent/credentials` | Save a provider API key through Pi |
| `DELETE` | `/api/agent/credentials` | Remove a stored provider API key |
| `POST` | `/idea` | Stream-generate an idea expansion |
| `POST` | `/rewrite` | Generate 3 rewrite variants (JSON) |
| `POST` | `/suggest` | Generate an inline continuation |

### POST `/idea`
```json
Request:
{
  "context": "...",
  "document": "...",
  "idea": "the idea text after /idea",
  "agent": { "provider": "...", "model": "...", "thinkingLevel": "medium" }
}

// Server adds style.md to system prompt automatically
Response: SSE stream of text chunks
```

### POST `/rewrite`
```json
Request:
{
  "context": "...",
  "document": "...",
  "selected": "the selected text",
  "instruction": "what the user typed in the popover",
  "agent": { "provider": "...", "model": "...", "thinkingLevel": "medium" }
}

// Server adds style.md to system prompt automatically
Response:
{
  "variants": ["variant 1", "variant 2", "variant 3"]
}
```

---

## Style Guide (`style.md`)

A `style.md` file defines the author's writing style, tone, vocabulary preferences, and rules. It is loaded at server startup and included in every LLM request as a system-level instruction.

**Location:** configurable via env, default `./style.md` (relative to the script dir).

**How it's used:**
- Read once on startup (or on each request if you want live editing — configurable)
- Injected into every system prompt before the task instructions:
  > "Follow this writing style guide:\n{style.md contents}"
- Applies to both `/idea` generation and `/rewrite` variants

**If the file doesn't exist:** server starts normally, generation proceeds without style constraints, a warning is printed to console.

---

## Environment

| Variable | Purpose | Default |
|---|---|---|
| `PI_PROVIDER` | Pi provider ID | first authenticated preferred provider |
| `PI_MODEL` | model ID | first available preferred model |
| `PI_THINKING_LEVEL` | reasoning level | `medium` |
| `PORT` | local HTTP port | `3456` |
| `STYLE_FILE` | path to writing style guide | `./style.md` |

---

## Launch

```bash
npm install
npm start
# Open http://localhost:3456
```

---

## Visual Style (reference: screenshot)

- Dark or light theme (system preference)
- Monospace font throughout (e.g. `JetBrains Mono`, `Menlo`, fallback `monospace`)
- Generous line-height (1.7–1.8) for readability
- Neutral background, high-contrast text
- Popover: floating card with subtle shadow, rounded corners
- Variant cards: full-width inside popover, border on hover, cursor pointer
