# Litura

Litura is a local, AI-assisted text editor for making prose sharper and less generic without taking control away from its author. The name comes from Latin: a correction, erasure, or visible revision in a manuscript.

![Litura editor highlighting generic writing patterns](docs/screenshot.png)

## What it does

- Keeps focus on working document in a distraction-free editor.
- Shows an AI score for texts; click it to see which words and phrases raised it.
- Reviews sentences as you finish them — switchable off in settings — and reviews the full document on demand.
- Highlights named, checkable prose and structure problems, including vague attribution, filler, buried points, broken paragraph promises, and abrupt topic shifts.
- Offers three replace-in-place alternatives when you ask for them — `Offer rewrites` on a finding card, or a message with a passage attached. Nothing changes until you choose an option. `Try again` asks for three more.
- Lets you dismiss a finding you disagree with, and jump between findings by clicking the counter in the header.
- Provides a compact chat for discussing the whole draft.
- Suggests short continuations below the current line; press `Tab` to accept or `Escape` to dismiss.

Right-click a selection to attach it to the composer, or press `Cmd/Ctrl+K` to attach the current selection or focus the chat. `Cmd/Ctrl+S` downloads the draft; dropping a text file on the editor opens it.

## Data and model access

The draft, findings, conversation, and selected model are stored in browser local storage and survive a reload.

The draft is also mirrored to `draft.md` in the folder Litura was started from, so it survives cleared browser storage and opens in any editor. The browser copy stays authoritative while the app runs; if the file changes underneath it, Litura says so and offers to load it rather than merging or overwriting silently. Nothing leaves the machine except what a model request sends to the selected provider — and, if you switch it on in settings, a once-a-day question to the npm registry about new versions.


## Run

Litura requires Node.js 20 or newer.

```bash
npx litura-app
```

Run it in the folder that holds your writing: Litura edits `draft.md` there and reads a `style.md` next to it if one exists. The browser opens on [http://127.0.0.1:3456](http://127.0.0.1:3456), or the next free port if that one is taken.

The npm package is `litura-app` — `litura` belongs to an unrelated project. The command it installs is `litura`.

To work on Litura itself:

```bash
git clone https://github.com/vadimchirkov/litura.git
cd litura
npm install
npm start
```

## Updating

Running `npx litura-app` is the update: for a bare package name npm re-resolves the registry on every run, so each start picks up the latest release. The exceptions are a global install, which shadows that check and needs `npm i -g litura-app`, and a clone, which needs `git pull`.

```bash
npx litura-app --check-update
```

prints the published version next to the running one.

Settings has an `Ask npm about new versions` switch, off by default. Turn it on and Litura asks once a day and shows a badge in the header when a newer version is published; the badge links to the changelog rather than installing anything. Left off, Litura opens no connection of its own.

An update leaves your draft, your `style.md`, and your model settings alone. Stored findings and chat history are dropped only when a release changes their format.

## Configuring

Use the gear button to choose a provider, model, and reasoning level or to add an API key. Litura also discovers credentials already stored by Pi and supported provider environment variables.

Optional environment defaults:

```bash
PI_PROVIDER=anthropic
PI_MODEL=claude-sonnet-4-6
PI_THINKING_LEVEL=medium
PORT=3456
STYLE_FILE=./style.md
DRAFT_FILE=./draft.md
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
