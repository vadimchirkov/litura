# Changelog

Litura follows [semantic versioning](https://semver.org). Until 1.0 the minor
number carries breaking changes.

## Unreleased

## 0.1.0 — 2026-09-06

First npm release, published as `litura-app`; the command it installs is `litura`.

- Run from any folder with `npx litura-app`. The draft and the style guide are read from the folder Litura starts in, not from its install directory.
- The browser opens on start, and a taken port falls through to the next free one.
- `litura --version` and `litura --check-update` report the running and published versions. Litura opens no connection of its own.
