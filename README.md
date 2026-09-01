# Writing Assistant

Local split-pane writing editor with inline completion, idea expansion, and rewrite variants powered by [Pi](https://pi.dev).

## Run

```bash
npm install
npm start
```

Open <http://127.0.0.1:3456>. Use the gear button to select a provider, model, and reasoning level or add an API key. Existing Pi credentials from `~/.pi/agent/auth.json` and provider environment variables are discovered automatically.

Environment defaults are compatible with Flumina:

- `PI_PROVIDER`
- `PI_MODEL`
- `PI_THINKING_LEVEL`
- `PORT` (default `3456`)
- `STYLE_FILE` (default `style.md` in this project)

The LifeOS `/write` plugin points to this project, so it remains launchable from LifeOS.
