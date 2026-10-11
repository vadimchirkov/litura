<img src="public/logo-tile.png" alt="Stilura mark" width="72">

# Stilura

Your draft reads like a chatbot wrote it, and you can't say why. Stilura is a local editor that points at the exact phrases — "game-changing", "it's not just an app, it's a movement", the tidy list of three — names the pattern, and offers rewrites. Nothing in your text changes until you pick one.

```bash
npx stilura
```

![Stilura highlighting sales language, a "not X but Y" construction and a forced triple, with a finding card open](docs/screenshot.png)

> **Renamed from Litura.** Same project, new name. The npm package moved from `litura-app` to `stilura` and the repository from `vadimchirkov/litura` to `vadimchirkov/stilura`. Your `draft.md` and other files stay where they are.

## What it finds

Each highlight carries a name and a reason, not a score. The patterns come from `style.md`, which you can edit: 20 of them, among them sales language, vague attribution ("studies show"), "not X but Y", forced triples, filler openers, stacked qualifiers, and generic positive endings. A second pass looks at structure: a buried point, a paragraph that breaks its opening promise, an abrupt topic shift.

Click the count in the header for every remark in document order. `F8` and `Shift+F8` step between them. Disagree with one? `Keep as is` dismisses it for good.

## You decide every change

- `Options` on a finding gives three replace-in-place rewrites. Hover to preview, click to apply, `Try again` for three more.
- `Discuss` opens a compact chat about the passage or the whole draft.
- Short continuations appear below the line when you pause; `Tab` takes one, `Escape` drops it.

The model suggests. It never edits the document on its own.

## Rewrites that know the reader

Before polishing, `/brief` asks four questions, one at a time: who reads this, what it should make them do, what they already know, and how much ground it covers. The answers travel with every rewrite, chat reply, and `/idea` expansion. Review never sees them, so it judges the prose unbiased.

## Your text stays a file on your machine

Run Stilura in the folder that holds your writing. It edits `draft.md` there and reads `style.md` next to it if one exists. The sidebar opens any other Markdown or text file in the folder. Nothing leaves the machine except what a model request sends to the provider you chose.

## What it does not do

- It does not tell you whether a text was written by AI. It names writing patterns.
- It does not write the piece for you. Every passage it offers replaces one you already wrote.
- Review and rewrites need a model provider: an API key, ChatGPT Plus/Pro sign-in, or credentials Pi already stores. The local wording count works without one.

## Run

### Command line

```bash
npx stilura
```

Needs Node.js 20 or newer. The browser opens on [http://127.0.0.1:3000](http://127.0.0.1:3000), or the next free port if that one is taken. Choose a provider and model under the gear button.

### Desktop

Download the build for your machine from [Releases](https://github.com/vadimchirkov/stilura/releases): `.dmg` on macOS, `.exe` on Windows, `.AppImage` or `.deb` on Linux. On first launch Stilura asks which folder holds your writing; `File → Open Folder…` picks a different one. It carries its own Node runtime and installs updates only when you say so.

The macOS builds are not yet signed with an Apple Developer ID, so the first launch is refused: open `System Settings → Privacy & Security`, find Stilura near the bottom, and press `Open Anyway`. Once is enough.

### Shortcuts

`Cmd/Ctrl+K` attaches the selection or focuses the chat. `Cmd/Ctrl+Enter` asks for a continuation. `Cmd/Ctrl+S` downloads the draft; dropping a text file on the editor opens it. In the composer, `/` lists commands.

## Data and storage

The draft, findings, conversation, brief, and selected model live in browser local storage and survive a reload. Each file keeps its own copy, chat, findings, and brief. The draft is mirrored to its file on disk, so it survives cleared browser storage and opens in any editor. If the file changes underneath a running Stilura, it says so and offers to load it rather than merging or overwriting silently.

The desktop app also saves these entries under its application data directory (`editor-state`), so changing the local server port does not reset them. Closing, changing folders, and installing an update wait for the editor to confirm the save; a save error keeps the app open.

Stilura opens one connection of its own, and only to ask about new versions: to the npm registry if you switch that on in settings, or to GitHub when the desktop app starts.

To work on Stilura itself:

```bash
git clone https://github.com/vadimchirkov/stilura.git
cd stilura
npm install
npm start
```

## Updating

The desktop app checks GitHub on launch and offers what it finds. Accepting downloads a bundle, verifies it against a signing key baked into the app, and restarts; declining changes nothing and the offer returns next launch. `Stilura → Check for Updates…` asks on demand. Because the app owns this, its settings have no npm update switch.

On the command line, running `npx stilura` is the update: for a bare package name npm re-resolves the registry on every run, so each start picks up the latest release. The exceptions are a global install, which shadows that check and needs `npm i -g stilura`, and a clone, which needs `git pull`.

```bash
npx stilura --check-update
```

prints the published version next to the running one.

Settings has an `Ask npm about new versions` switch, off by default. Turn it on and Stilura asks once a day and shows a badge in the header when a newer version is published; the badge links to the changelog rather than installing anything. Left off, Stilura opens no connection of its own.

Releases are cut by tag: `npm version <patch|minor|major>`, then `git push` and `git push --tags`. GitHub Actions runs the checks, verifies the tag matches `package.json`, and publishes.

An update leaves your draft, your `style.md`, and your model settings alone. Stored findings, chat history, and briefs are dropped only when a release changes their format.

## Configuring

Use the gear button to choose a provider, model, and reasoning level or to add an API key. Stilura also discovers credentials already stored by Pi and supported provider environment variables.

Continuations use a separate suggestion model (same dialog, no reasoning
control — the server always spends the least reasoning allowed). It defaults
to the cheapest authenticated model that writes well and switches reasoning
off; review, rewrites, chat, and `/idea` always use the default model above.

The same dialog offers ChatGPT Plus/Pro sign-in as an alternative to an API
key.

Optional environment defaults:

```bash
PI_PROVIDER=anthropic
PI_MODEL=claude-sonnet-4-6
PI_THINKING_LEVEL=medium
PORT=3000
STYLE_FILE=./style.md
DRAFT_FILE=./draft.md
```

Edit `style.md` to describe the voice, facts, and constraints Stilura should preserve. The file is read again for each model request, so changes apply without restarting the server.

## Working alongside Codex / Claude Code

Stilura pairs well with terminal agents on the same machine: the draft is a
plain `draft.md`, and the server exposes the same operations the UI uses as
local HTTP endpoints. If an external edit lands while Stilura runs, it never
merges silently — it offers `Load disk` / `Keep mine` instead.

A ready-made skill ships in `skills/stilura/SKILL.md` (also in the npm
package): voice rules distilled from `style.md`, the finding-code taxonomy,
and `curl` recipes for `GET/PUT /draft` and `POST /review /rewrite /suggest
/chat` on `http://127.0.0.1:3000` (or the next free port up to 3010).
Install it with:

```bash
cp -r skills/stilura ~/.codex/skills/   # Codex CLI
cp -r skills/stilura ~/.claude/skills/  # Claude Code
```

then run the agent in the folder holding your draft while Stilura is running.
Writes go through revision-checked `PUT /draft` (a stale revision returns
`409` — re-read and retry once, never overwrite blindly).
`/draft` always addresses the launch file. To work on another workspace file,
use `?name=filename.md` on `/draft` and `/draft/history`; opening a file in one
tab does not change another tab's save target. `GET /file?name=filename.md`
also returns its revision. `PUT /file` requires that revision to replace a
file; without one it only creates a missing file.

### MCP server

For agents that speak MCP (Codex CLI, Claude Code, ChatGPT desktop app),
Stilura exposes the same operations as seven stdio tools — `draft_read`,
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
[mcp_servers.stilura]
command = "node"
args = ["/path/to/stilura/mcp-server.mjs"]
cwd = "/path/to/writing"
tool_timeout_sec = 180
```

```bash
# Claude Code (user scope; --scope project or .mcp.json for project scope)
claude mcp add --scope user stilura -- node /path/to/stilura/mcp-server.mjs
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

The app icon in `src-tauri/icons/` is generated from `public/logo-tile.png` (black mark on the cream tile) with `npx tauri icon public/logo-tile.png`. The mark also ships as `public/logo-mark.png` (transparency, light surfaces) and `public/logo-mark-white.png` (dark surfaces).

See [SPEC.md](SPEC.md) for product behavior, API contracts, and implementation boundaries.

## License

[MIT](LICENSE)
