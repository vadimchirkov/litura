---
name: stilura
description: Edit prose alongside the Stilura writing editor. Use when the user is working in a folder with draft.md and Stilura running, or asks to review, rewrite, or continue a draft in Stilura's voice. Covers Stilura's style rules and its localhost HTTP API.
---

# Stilura

Stilura is a local writing editor for sharper, more human prose. The author owns
every change: the model suggests, the author applies. When you work on a draft
that lives in Stilura, follow this skill instead of improvising.

## When to use

- The working folder has `draft.md` and Stilura is running (`node index.js` /
  `npx stilura` / desktop app, port 3000–3010 on `127.0.0.1`).
- The user asks to review, rewrite, continue, or discuss that draft.
- Otherwise: plain file editing, no Stilura protocol needed.

## Voice rules (from `style.md`)

Never change what the text claims. Never add a fact, name, number, date,
quote, or citation that is not already in the draft or the user's material.
If evidence is missing, preserve uncertainty or ask for a source.

Avoid, and flag when clustered: inflated importance (`plays a vital role`,
`testament to`, `evolving landscape`), shallow `-ing` tails (`leveraging`,
`underscoring`), sales language (`vibrant`, `nestled`, `groundbreaking`),
vague attribution (`experts agree`, `studies show` — name a real source or drop
the claim), `not X but Y` contrasts, forced triples, false ranges, filler
openers (`let's dive in`, `it is important to note`), fake candour
(`Honestly?`, `Here's the thing`), pretend depth (`at its core`, `the real
question`), straw objections, dramatic fragments, stacked qualifiers
(`could potentially possibly`), mind-like agency for tools (`the dashboard
believes` — name the person choosing), manufactured emphasis (ALL-CAPS, scare
quotes, decorative emoji), generic positive endings (`the future looks
bright`), chatbot residue (`I hope this helps!`, `Great question`), and the
overused-word pile (`delve`, `tapestry`, `leverage`, `seamless`, `robust`,
`moreover`, `furthermore`).

Do not flag on their own: clean grammar, formal vocabulary, one em dash, one
`however`, deliberate repetition, passive voice with unknown actor, quoted or
cited phrases, missing citations.

Preserve: concrete odd details, mixed feelings, real uncertainty, humour and
bluntness, slang and in-jokes, self-interruptions, uneven rhythm.
Keep the reader oriented: open a unit by setting expectations, keep the
promise, carry central terms through, put the point near the beginning or end —
but never force essay structure onto lists, dialogue, or deliberate
disorientation. If the user supplies their own writing sample, it outranks
every rule here.

## Stilura localhost API

Base: `http://127.0.0.1:<port>`, port 3000 unless taken (server walks up to
+10). Same machine only; every non-GET needs `Content-Type: application/json`.
The `agent` field (provider/model) is optional everywhere — omit it and the
server uses its configured default.

```bash
PORT=3000  # adjust to the running Stilura instance

# Read the draft (also gives the revision token for writes)
curl -s http://127.0.0.1:$PORT/draft
# -> {"text":"...","revision":"<sha>","path":"...","id":"...","exists":true}

# Save (revision-checked; stale revision returns 409 with {"current":...})
curl -s -X PUT http://127.0.0.1:$PORT/draft \
  -H 'Content-Type: application/json' \
  -d '{"text":"...","revision":"<sha from GET>"}'

# Rewrite: exactly 3 variants replacing ONLY the selection.
# from = character offset of selected in document; the slice must match.
curl -s -X POST http://127.0.0.1:$PORT/rewrite \
  -H 'Content-Type: application/json' \
  -d '{"document":"...","selected":"...","from":123,"instruction":"...what to fix..."}'

# Suggest: short continuation at cursor (character offset). May be "".
curl -s -X POST http://127.0.0.1:$PORT/suggest \
  -H 'Content-Type: application/json' \
  -d '{"document":"...","cursor":456}'

# Chat about the draft (streams SSE: {"text":"..."} deltas, then [DONE])
curl -sN -X POST http://127.0.0.1:$PORT/chat \
  -H 'Content-Type: application/json' \
  -d '{"document":"...","messages":[{"role":"user","content":"..."}]}'
```

Limits: AI routes accept drafts up to 60,000 characters; files cap at 1 MB.

## Editing protocol

1. Read first: `GET /draft` (or the file) before proposing changes.
2. Prefer `PUT /draft` with the fresh `revision`. On `409`, re-read and retry
   once against the new text — never overwrite blindly.
3. Alternatively edit `draft.md` directly with file tools. Stilura notices
   external changes and offers the author `Load disk` / `Keep mine` — so say
   what you changed and let them choose.
4. Make small, named edits. Quote the exact passage and explain the change;
   do not silently rewrite the whole document.

## Live HTTP collaboration

Use `sessionClient(filename)` from `session-client.js` to share the editor's
live document. It discovers `<file>.stilura-session` and authenticates requests
to the local HTTP session. Never write directly to disk while the editor is
running. An unreachable live owner blocks fallback; reconnect and retry.

- `read()` returns text, revision and shared notes, including resolved notes.
- `patch([{ old, new, from?, all? }], revision)` applies exact replacements.
  Repeated text needs `from` or `all: true`; overlapping edits fail atomically.
  Edits elsewhere rebase; a changed target fails. Re-read before retrying.
- `write(text, revision)` replaces the draft under a revision guard.
- `resolveNote(id)` preserves the note and closes it in connected editors.
- `changes(revision, waitMs)` waits up to 30 seconds for text or note updates.

Notes persist in `<file>.stilura-notes.json`. Read their text, quote and anchor
before editing. Refuse automatic edits against drifted anchors; verify the
intended passage and supply its exact text and offset.

### External agent work loop

While the host authorizes an active writing session:

1. Read the draft and notes. Use a stable, unique agent ID.
2. Call `nextWork(agentId, 30000)`; process existing saved notes too.
3. Follow the returned instruction, feedback, target and `kind`.
   For `idea`, expand the thought into a passage fitting its exact location.
4. Call `finishWork({ id, token, revision, edits, comment })` with the claimed
   revision and exact replacements. Changes elsewhere rebase; a changed target
   fails. Submit `error` instead when clarification is needed. Claims expire
   after five minutes.
5. Applied work awaits human review. Accept, Undo and Regenerate belong to the
   writer; never resolve a work result automatically.
6. Continue watching through `nextWork` or `changes`. The host must keep this
   loop active; updates do not automatically awaken an idle agent.

Use `suggestNote({ text, agent_id, revision, quote?, from? })` sparingly for
advice after a writing pause. Advice does not change text or queue work for
its author. Do not invoke generation on every keystroke or repeatedly comment
on an unchanged passage. Saved user notes are work signals; rough prose alone
is not a command. Saved feedback stays in note history.
