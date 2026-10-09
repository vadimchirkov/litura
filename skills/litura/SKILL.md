---
name: litura
description: Edit prose alongside the Litura writing editor. Use when the user is working in a folder with draft.md and Litura running, or asks to review, rewrite, or continue a draft in Litura's voice. Covers Litura's style rules, finding codes, and its localhost HTTP API.
---

# Litura

Litura is a local writing editor for sharper, more human prose. The author owns
every change: the model suggests, the author applies. When you work on a draft
that lives in Litura, follow this skill instead of improvising.

## When to use

- The working folder has `draft.md` and Litura is running (`node index.js` /
  `npx litura-app` / desktop app, port 3000–3010 on `127.0.0.1`).
- The user asks to review, rewrite, continue, or discuss that draft.
- Otherwise: plain file editing, no Litura protocol needed.

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

## Finding codes (Litura review taxonomy)

One code per finding, most specific wins: `level-1-whole-essay` (title
misleads / ending doesn't resolve the opening), `level-2-introduction`
(opening lacks common ground, problem, cost, or point),
`level-3-index-discussion` (opening promises structure the discussion breaks),
`level-4-fractal-structure` (section doesn't support its containing unit),
`level-5-point-placement` (no point, buried point, point at both ends),
`level-6-key-terms` (announced terms disappear or arrive unannounced),
`level-7-paragraph-flow` (abrupt old-to-new break between sentences),
`generic-prose` (any tell from the voice rules above).

## Litura localhost API

Base: `http://127.0.0.1:<port>`, port 3000 unless taken (server walks up to
+10). Same machine only; every non-GET needs `Content-Type: application/json`.
The `agent` field (provider/model) is optional everywhere — omit it and the
server uses its configured default.

```bash
PORT=3000  # adjust to the running Litura instance

# Read the draft (also gives the revision token for writes)
curl -s http://127.0.0.1:$PORT/draft
# -> {"text":"...","revision":"<sha>","path":"...","id":"...","exists":true}

# Save (revision-checked; stale revision returns 409 with {"current":...})
curl -s -X PUT http://127.0.0.1:$PORT/draft \
  -H 'Content-Type: application/json' \
  -d '{"text":"...","revision":"<sha from GET>"}'

# Review: up to 8 findings {code, quote, pattern, reason, fix};
# quote is always an exact contiguous passage of the draft
curl -s -X POST http://127.0.0.1:$PORT/review \
  -H 'Content-Type: application/json' \
  -d '{"document":"...full draft...","target":"...optional: audit only this passage..."}'

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
Keep `pattern` ≤ 4 words, `reason`/`fix` ≤ 12 words each when reporting
findings — the author reads them at a glance beside the draft.

## Editing protocol

1. Read first: `GET /draft` (or the file) before proposing changes.
2. Prefer `PUT /draft` with the fresh `revision`. On `409`, re-read and retry
   once against the new text — never overwrite blindly.
3. Alternatively edit `draft.md` directly with file tools. Litura notices
   external changes and offers the author `Load disk` / `Keep mine` — so say
   what you changed and let them choose.
4. Small, named edits beat rewrites. Quote the exact passage, name the code
   (`generic-prose`, `level-7-paragraph-flow`, …), give the direction — don't
   silently rewrite the whole document.

## MCP server (preferred when available)

If the host connected a `litura` MCP server (`mcp-server.mjs`), use its tools
instead of curl: `draft_read`, `draft_write`, `review`, `rewrite`, `suggest`,
`chat`, `idea`. Same prompts, same revision guard on `draft_write`, and
document arguments default to the live draft. The curl recipes above are the
fallback when no MCP server is connected.
