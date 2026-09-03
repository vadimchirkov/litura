# Litura

Litura is a local, AI-assisted text editor for making prose sharper and less generic without taking control away from its author. The name comes from Latin: a correction, erasure, or visible revision in a manuscript.

![Litura editor highlighting generic writing patterns](docs/screenshot.png)

## What it does

- Keeps one focused working document in a distraction-free CodeMirror editor.
- Shows a local AI-tell score for predominantly Latin-script drafts. The score is a writing heuristic, not an authorship detector.
- Reviews likely problem sentences as you finish them and can review the full document on demand.
- Highlights named, checkable prose and structure problems, including vague attribution, filler, buried points, broken paragraph promises, and abrupt topic shifts.
- Generates three replace-in-place alternatives for a highlighted finding or selected passage. Nothing changes until you choose an option.
- Provides a compact chat for discussing the whole draft.
- Suggests short continuations below the current line; press `Tab` to accept or `Escape` to dismiss.
- Expands a line beginning with `/idea ...` directly inside the document.
- Uses [Pi](https://github.com/badlogic/pi-mono) for provider discovery, credentials, model selection, and reasoning levels.

Right-click a selection to attach it to the composer, or press `Cmd/Ctrl+K` to attach the current selection or focus the chat.

## Data and model access

The draft and selected model are stored in browser local storage. Chat history is kept only in memory and is cleared on reload. Litura does not store documents on the server.

Model-backed actions send the current draft and the relevant instruction or selection to the provider you choose. API keys are managed by Pi rather than stored in browser local storage. `style.md` is added to every generation and review request.

## Run locally

Litura requires Node.js 20 or newer.

```bash
git clone https://github.com/vadimchirkov/litura.git
cd litura
npm install
npm start
```

Open [http://127.0.0.1:3456](http://127.0.0.1:3456). Use the gear button to choose a provider, model, and reasoning level or to add an API key. Litura also discovers credentials already stored by Pi and supported provider environment variables.

Optional environment defaults:

```bash
PI_PROVIDER=anthropic
PI_MODEL=claude-sonnet-4-6
PI_THINKING_LEVEL=medium
PORT=3456
STYLE_FILE=./style.md
```

Edit `style.md` to describe the voice, facts, and constraints Litura should preserve. The file is read again for each model request, so changes apply without restarting the server.

## Development

```bash
npm run build
npm run check
```

The server uses Node's native HTTP module. The browser UI is vanilla JavaScript with CodeMirror 6 and is bundled with esbuild. Source changes belong in `src/app.js`; `public/app.js` is generated.

See [SPEC.md](SPEC.md) for product behavior, API contracts, and implementation boundaries.

## License

[MIT](LICENSE)
