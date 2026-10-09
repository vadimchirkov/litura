<img src="public/logo.svg" alt="" width="72">

# Litura

Litura is a local, AI-assisted text editor for making prose sharper and less generic without taking control away from its author. The name comes from Latin: a correction, erasure, or visible revision in a manuscript.

![Litura editor with review highlights and rewrite options](docs/screenshot.png)

## What it does

- Keeps focus on working document in a distraction-free editor.
- Counts local wording signals; click the count in the header for every remark waiting on the draft, in document order, and jump to one.
- Reviews sentences as you finish them — switchable off in settings — and reviews the full document on demand.
- Highlights named, checkable prose and structure problems, including vague attribution, filler, buried points, broken paragraph promises, and abrupt topic shifts.
- Offers three replace-in-place alternatives when you ask for them — `Options` on a finding card, or a message with a passage attached. Nothing changes until you choose an option. `Try again` asks for three more.
- Lets you dismiss a finding you disagree with, and step between findings with `F8` and `Shift+F8`.
- Provides a compact chat for discussing the whole draft.
- Suggests short continuations below the current line; press `Tab` to accept or `Escape` to dismiss or cancel. `Cmd/Ctrl+Enter` requests a continuation even when automatic suggestions are off.

Clicking a mark only reads it — the card or reason appears and nothing is attached. A bubble beside the click offers `Add to context` and rewrites; selecting text offers `Add to context`, or press `Cmd/Ctrl+K` to attach the current selection or focus the chat. `Cmd/Ctrl+S` downloads the draft; dropping a text file on the editor opens it.

## Data and model access

The draft, findings, conversation, and selected model are stored in browser local storage and survive a reload.

The draft is also mirrored to `draft.md` in the folder Litura was started from, so it survives cleared browser storage and opens in any editor. The sidebar lists the Markdown and text files next to it: opening one switches the editor — and its saves — onto that file, and each file keeps its own browser copy, chat and findings. The browser copy stays authoritative while the app runs; if the file changes underneath it, Litura says so and offers to load it rather than merging or overwriting silently. Nothing leaves the machine except what a model request sends to the selected provider — and one question about new versions: to the npm registry if you switch that on in settings, or to GitHub when the desktop app starts.


## Run

Two ways, one program. The desktop app is the same server inside a window and needs nothing installed; the command line is the same window in your browser and needs Node.js 20 or newer.

### Desktop

Download the build for your machine from [Releases](https://github.com/vadimchirkov/litura/releases): `.dmg` on macOS, `.exe` on Windows, `.AppImage` or `.deb` on Linux. On first launch Litura asks which folder holds your writing and edits `draft.md` there; `File → Open Folder…` picks a different one. It carries its own Node runtime, checks for updates on launch, and installs one only when you say so.

The macOS builds are not yet signed with an Apple Developer ID, so the first launch is refused: open `System Settings → Privacy & Security`, find Litura near the bottom, and press `Open Anyway`. Once is enough — later updates install without asking again.

### Command line

```bash
npx litura-app
```

Run it in the folder that holds your writing: Litura edits `draft.md` there and reads a `style.md` next to it if one exists. The browser opens on [http://127.0.0.1:3000](http://127.0.0.1:3000), or the next free port if that one is taken.

The npm package is `litura-app` — `litura` belongs to an unrelated project. The command it installs is `litura`.

To work on Litura itself:

```bash
git clone https://github.com/vadimchirkov/litura.git
cd litura
npm install
npm start
```

## Updating

The desktop app checks GitHub on launch and offers what it finds. Accepting downloads a bundle, verifies it against a signing key baked into the app, and restarts; declining changes nothing and the offer returns next launch. `Litura → Check for Updates…` asks on demand. Because the app owns this, its settings have no npm update switch.

On the command line, running `npx litura-app` is the update: for a bare package name npm re-resolves the registry on every run, so each start picks up the latest release. The exceptions are a global install, which shadows that check and needs `npm i -g litura-app`, and a clone, which needs `git pull`.

```bash
npx litura-app --check-update
```

prints the published version next to the running one.

Settings has an `Ask npm about new versions` switch, off by default. Turn it on and Litura asks once a day and shows a badge in the header when a newer version is published; the badge links to the changelog rather than installing anything. Left off, Litura opens no connection of its own.

Releases are cut by tag: `npm version <patch|minor|major>`, then `git push` and `git push --tags`. GitHub Actions runs the checks, verifies the tag matches `package.json`, and publishes.

An update leaves your draft, your `style.md`, and your model settings alone. Stored findings and chat history are dropped only when a release changes their format.

## Configuring

Use the gear button to choose a provider, model, and reasoning level or to add an API key. Litura also discovers credentials already stored by Pi and supported provider environment variables.

Continuations use a separate suggestion model (same dialog, no reasoning
control — the server always spends the least reasoning allowed). It defaults
to the cheapest authenticated model that writes well and switches reasoning
off; review, rewrites, chat, and `/idea` always use the default model above.

The same dialog offers ChatGPT Plus/Pro sign-in as an alternative to an API
key. Note the trade-off stated there: subscriptions count messages, and
Litura's automatic checks send hundreds of small requests a day, so heavy
writing stays cheaper and quota-free on API keys.

Optional environment defaults:

```bash
PI_PROVIDER=anthropic
PI_MODEL=claude-sonnet-4-6
PI_THINKING_LEVEL=medium
PORT=3000
STYLE_FILE=./style.md
DRAFT_FILE=./draft.md
```

Edit `style.md` to describe the voice, facts, and constraints Litura should preserve. The file is read again for each model request, so changes apply without restarting the server.

## Working alongside Codex / Claude Code

Litura pairs well with terminal agents on the same machine: the draft is a
plain `draft.md`, and the server exposes the same operations the UI uses as
local HTTP endpoints. If an external edit lands while Litura runs, it never
merges silently — it offers `Load disk` / `Keep mine` instead.

A ready-made skill ships in `skills/litura/SKILL.md` (also in the npm
package): voice rules distilled from `style.md`, the finding-code taxonomy,
and `curl` recipes for `GET/PUT /draft` and `POST /review /rewrite /suggest
/chat` on `http://127.0.0.1:3000` (or the next free port up to 3010).
Install it with:

```bash
cp -r skills/litura ~/.codex/skills/   # Codex CLI
cp -r skills/litura ~/.claude/skills/  # Claude Code
```

then run the agent in the folder holding your draft while Litura is running.
Writes go through revision-checked `PUT /draft` (a stale revision returns
`409` — re-read and retry once, never overwrite blindly).

### MCP server

For agents that speak MCP (Codex CLI, Claude Code, ChatGPT desktop app),
Litura exposes the same operations as seven stdio tools — `draft_read`,
`draft_write`, `review`, `rewrite`, `suggest`, `chat`, `idea` — in
`mcp-server.mjs`, reusing the exact prompts the editor uses. Document
arguments default to the live `draft.md`, so `review` with no arguments audits
the current draft. Only `draft_write` changes anything, and it carries the
same revision guard as `PUT /draft`. Start the server in the folder holding
your draft (or set `DRAFT_FILE`), since the draft resolves against the
server's working directory:

```toml
# Codex: ~/.codex/config.toml (or .codex/config.toml per project).
# review/rewrite can run past the 60 s default tool timeout — raise it.
[mcp_servers.litura]
command = "node"
args = ["/path/to/litura/mcp-server.mjs"]
cwd = "/path/to/writing"
tool_timeout_sec = 180
```

```bash
# Claude Code (user scope; --scope project or .mcp.json for project scope)
claude mcp add --scope user litura -- node /path/to/litura/mcp-server.mjs
```

Model credentials come from the same places as the editor: Pi's stored
credentials (`~/.pi/agent/auth.json`) and provider environment variables.
Per-call `agent` overrides accept `{ provider, model, thinkingLevel }`.

## Development

```bash
npm run build
npm run check
```

The server uses Node's native HTTP module. The browser UI is vanilla JavaScript with CodeMirror 6 and is bundled with esbuild. Source changes belong in `src/app.js`; `public/app.js` is generated.

`npm run check:suggestions` tests insertion, cancellation and scheduling without model calls. `npm run eval:suggestions` makes real calls to the configured model using bilingual examples and records output and latency in `tmp/suggestion-evaluation.json`. See [the evaluation guide](docs/suggestion-evaluation.md) for review criteria and prompt/context experiments.

The desktop shell needs a Rust toolchain and [Tauri's system dependencies](https://tauri.app/start/prerequisites/):

```bash
npm run desktop
```

That bundles the frontend, bundles the server into `dist/server.mjs`, downloads the Node runtime into `src-tauri/binaries/` (checksummed against the release, gitignored, ~120 MB), and opens the window. `npm run desktop:build` produces installers in `src-tauri/target/<triple>/release/bundle/`.

Name the target when your Rust toolchain and the Tauri CLI disagree about the machine — an Intel `rustc` on Apple silicon, for instance, ends in a bundler looking for a sidecar nobody fetched:

```bash
npm run desktop:build -- --target aarch64-apple-darwin
```

After a build, `npm run smoke:desktop` starts the bundle against a throwaway folder and checks that it serves that folder's draft and gives the port back when the window dies. The UI needs no desktop build to test: it is the same page a browser gets from `npm run test:browser`, with `?shell=desktop` added to the URL for the desktop layout.

Updates are signed with a minisign key that is not in this repository. CI reads it from the `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets; the matching public key sits in `src-tauri/tauri.conf.json`, and an installed app refuses any bundle that key did not sign. Generate a new pair with `npx tauri signer generate` — and remember that replacing the public key strands every copy already installed.

The app icon in `src-tauri/icons/` is `public/logo.svg` on a cream rounded square; regenerate the set with `npx tauri icon src-tauri/icons/app-icon.svg`.

See [SPEC.md](SPEC.md) for product behavior, API contracts, and implementation boundaries.

## License

[MIT](LICENSE)
