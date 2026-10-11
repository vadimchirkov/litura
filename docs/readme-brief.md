# Brief: README

Date: 2026-10-11. Update this brief first when the product changes, then the README.

## 0. Goal
The reader runs `npx stilura` in a folder with their writing. Fallback: downloads the desktop build from Releases. Worked if npm installs of `stilura` grow after the rename.

## 1. Reader
Someone who writes for other people (posts, essays, docs, newsletters) and drafts with or next to AI tools. Has Node or can install the desktop app. Knows their text sometimes reads like ChatGPT: "game-changing", "not just X — it's Y", lists of three. Does not know a local editor exists that names those patterns and leaves the decision to them.
Awareness: knows the problem, not the product. The page starts from the problem.
Not for: people who want AI to write the text for them; people looking for an "AI detector" score.

## 2. Moment
- A draft is done and reads flat or generic; they cannot say exactly why.
- They pasted AI-assisted text and want it to sound like them before publishing.
- A chatbot "improved" their text and erased their facts and voice. [?] no sourced examples collected yet; step 3 research not run.

## 3. What they use today
- Chat with a general model ("make this better"): rewrites the whole passage, adds claims, loses voice. Changes land without a per-sentence choice.
- Grammar checkers: catch spelling and grammar, not stock phrasing or structure.
- AI detectors: give a probability, not a named problem with a fix.
[?] competitor docs not re-read for this brief; dated claims to verify before using them on the page.

## 4. What we have
Category: a text editor with a strict editor at the next desk, running on your machine.
Main idea: Stilura points at named weak spots in your prose and offers options; it never changes the text unless you pick one.
- Generic phrasing → highlights with a named pattern (20 patterns in `style.md`: sales language, not X but Y, forced triples, vague attribution…) and a reason.
- "I don't know how to fix it" → `Options` gives three replace-in-place rewrites; nothing changes until you click one.
- Rewrites miss the audience → `/brief`: four questions (reader, goal, awareness, scope) carried into rewrites and chat, never into review.
- Losing work / lock-in → the draft is a plain `draft.md` in your folder.
Does not: decide whether text was written by AI; write the piece for you; work without a model provider (review and rewrites need one; the local signal count does not).

## 5. Priority for the reader
1. It finds what makes the text generic, by name.
2. The author keeps control: nothing changes without a click.
3. Start in one command, text stays a local Markdown file.
4. Works with the model/provider they already have.
---
Below the line (reference sections): updating, configuration, agent/MCP integration, development.

## 6. Evidence
No measured quality results yet. Do not claim accuracy, time saved, or "less AI-like" scores.
Biggest gap: a measured comparison of findings against human editor marks on a fixed set of drafts. `npm run eval:suggestions` measures continuations only.

## 7. Objections
- Does my text leave my machine? Only what a model request sends to the provider you chose.
- Do I need an API key? Yes, any supported provider, or ChatGPT Plus/Pro sign-in; existing Pi credentials and env vars are found automatically.
- Will it rewrite my voice? Only if you pick an option; `style.md` tells it what to keep.
- Is it an AI detector? No.

## 8. In 30 seconds the reader understands
1. Stilura highlights generic, AI-sounding prose in your draft and names the pattern.
2. It offers rewrites; you choose, nothing changes on its own.
3. It runs locally on a Markdown file: `npx stilura`.

## 9. One action
Primary: `npx stilura`. Second: download the desktop app.

## 10. Dictionary
| Internal | Reader's word | Why they care |
|---|---|---|
| finding / review | highlight, what's wrong | see the exact phrase and why it reads generic |
| slop count | signals in the draft | one number for how much is left to fix |
| rewrite / variants | Options | three versions to pick from, nothing forced |
| positioning brief | who it's for | rewrites aim at the real reader |
| suggestion | continuation | a next line when stuck, `Tab` to take it |
| `style.md` | your style rules | what the model must keep and avoid |

## 11. Out of scope
HTTP endpoints, MCP tools, skill install, release process, update signing, environment variables. They stay in the README's reference part and in `SPEC.md`.
