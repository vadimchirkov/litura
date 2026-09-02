# Litura

Litura is a local writing editor that finds weak or generic prose and suggests clearer alternatives. It never changes the draft until you choose a replacement.

![Litura editor highlighting writing problems](docs/screenshot.png)

## What you can do

- Write in a focused plain-text editor.
- Review the draft for vague wording, filler, buried points, broken paragraph promises, and abrupt topic shifts.
- Click an underlined passage to see three replacements.
- Right-click selected text to request a specific change. Press `Cmd/Ctrl+K` to attach the selection to the chat.
- Discuss the whole draft in the chat.
- Accept a short continuation with `Tab`, or dismiss it with `Escape`.
- Type `/idea <instruction>` and press `Enter` to expand an idea in place.

The number in the toolbar is a local writing score for English and other predominantly Latin-script drafts. It is a heuristic, not an AI detector.

## Run locally

Litura requires Node.js 20 or newer.

```bash
git clone https://github.com/vadimchirkov/litura.git
cd litura
npm install
npm start
```

Open [http://127.0.0.1:3456](http://127.0.0.1:3456). Use the gear button to choose a provider, model, and reasoning level or to add an API key. Litura can also use credentials already available to Pi.

## Privacy

The draft and model selection stay in browser local storage. Chat history is cleared when the page reloads. When you use an AI feature, Litura sends the current draft and your instruction to the selected provider. Pi manages API keys.

## Writing style

All AI features follow [style.md](style.md). Edit it to change the voice and writing rules. Litura reads the file again for every request.

Optional defaults:

```bash
PI_PROVIDER=anthropic
PI_MODEL=claude-sonnet-4-6
PI_THINKING_LEVEL=medium
PORT=3456
STYLE_FILE=./style.md
```

## Development

```bash
npm run build
npm run check
```

The app uses Node's native HTTP server, vanilla JavaScript, CodeMirror 6, Pi, and esbuild. Edit `src/app.js`, not the generated `public/app.js`.

See [SPEC.md](SPEC.md) for product behavior and API details.

## License

[MIT](LICENSE)
