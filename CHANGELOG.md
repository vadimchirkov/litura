# Changelog

Litura follows [semantic versioning](https://semver.org). Until 1.0 the minor
number carries breaking changes.

## Unreleased

## 0.3.3 — 2026-09-07

- Refreshed the README preview with a full-screen editor screenshot showing review marks and inline continuation.

## 0.3.2 — 2026-09-07

- Moved the Slop Score next to the settings control in the editor header.

## 0.3.1 — 2026-09-07

- The update badge now copies `npx litura-app` instead of opening a changelog, so the next update command is ready to paste.

## 0.3.0 — 2026-09-07

- Review remarks stay beside the passage they describe without shifting the draft when opened or clicked.
- Added document actions and local history, replace-in-place previews, light/dark appearance settings, and automatic settings saves.
- Refined the editor header, chat composer, settings controls, and release safety checks.

## 0.2.0 — 2026-09-06

- Settings can ask npm about new versions once a day, off by default. When a newer version is published the header shows a badge linking to this file; the badge links rather than installs, so updating stays a command you run. Left off, Litura opens no connection of its own.
- Releases are cut by tag, with GitHub Actions running the checks and publishing over OIDC.

## 0.1.0 — 2026-09-06

First npm release, published as `litura-app`; the command it installs is `litura`.

- Run from any folder with `npx litura-app`. The draft and the style guide are read from the folder Litura starts in, not from its install directory.
- The browser opens on start, and a taken port falls through to the next free one.
- `litura --version` and `litura --check-update` report the running and published versions. Litura opens no connection of its own.
