# Continuation evaluation

`npm run check:suggestions` runs without model calls. It exercises the production parser and CodeMirror state functions: word spacing, punctuation, partial words, repeated tails, invalid output, cancellation, stale responses, acceptance, and manual versus automatic scheduling. It is included in `npm run check`.

`npm run eval:suggestions` makes real model calls using the exact production prompt builder, continuation model settings and parser. The default model comes from Pi, including `PI_PROVIDER` and `PI_MODEL` when configured. The full `style.md` is read from the repository or `STYLE_FILE`.

The bilingual examples in `fixtures/suggestions.json` are authored regression fixtures, not sampled user documents or an independent quality benchmark. They include unfinished words, known facts, finished thoughts, missing evidence, unknown intentions, punctuation, a blank paragraph, existing text after the cursor and a relevant fact far earlier in the document. Cases used to tune the prompt remain regressions; subsequent passing runs are not unseen evaluation.

## Run and inspect

```sh
npm run eval:suggestions
SUGGEST_RUNS=3 npm run eval:suggestions
SUGGEST_CASE=unfinished-word npm run eval:suggestions
SUGGEST_CASE=ru-punctuation,en-punctuation npm run eval:suggestions
SUGGEST_REPORT=tmp/my-suggestion-report.json npm run eval:suggestions
PI_PROVIDER=google PI_MODEL=gemini-2.5-flash SUGGEST_DELAY_MS=13000 npm run eval:suggestions
```

The JSON report preserves the raw answer, normalized insertion, combined document, model, prompt hash, prompt character count, request latency and failed expectations after every request. Its default location is `tmp/suggestion-evaluation.json`. A failed expectation or provider error gives a nonzero exit status. Reports may contain draft text when fixtures are replaced with personal material; `tmp/` is ignored by git.

Request-configuration, authentication, credit and rate-limit errors stop the run immediately instead of repeating a rejected request for each remaining case. `plannedCalls`, the recorded results and `stoppedBecause` identify incomplete runs. The provider's prose protocol is `NONE`, `TEXT: …`, or `WORD: …`; the report itself is ordinary JSON.

Assertions check format, length, expected fragments and abstention. They cannot establish whether a suggestion preserves the writer's voice or quietly invents a plausible detail. Inspect each `combined` text with its `rubric` and fill the optional `humanReview` fields:

- `coherence`: does the insertion fit both sides of the cursor, including grammar and punctuation?
- `voicePreserved`: does it keep the draft's vocabulary and rhythm?
- `inventedFacts`: did it add an unsupported decision, event, attribute, number or quotation?
- `useful`: would accepting it save the author work?

Latency is measured around the provider call and parsing, excluding the editor's 900 ms debounce, initial model discovery and optional `SUGGEST_DELAY_MS` between calls. The median includes only passing cases, so a fast quota error cannot look like a fast suggestion. Compare medians across repeated runs; a single request is not a reliable speed measurement. Reports separately count abstentions so an always-empty model cannot look useful merely by avoiding errors.

## Prompt and context experiments

```sh
SUGGEST_MODES=production,short-style,local-context SUGGEST_REPORT=tmp/suggestion-comparison.json npm run eval:suggestions
```

`production` keeps the full style guide and document. `short-style` uses only the continuation-specific instructions, without `style.md`. `local-context` keeps the style guide but sends only the last 1,500 characters before the cursor and first 750 after it. The long-context fixture intentionally keeps a relevant fact beyond that window. Short fixtures may have identical prompts in the production and local-context modes; the hashes make that visible.

These are evaluation-only switches. Production retains the full style and document until a reviewed, repeated comparison justifies reducing them. Do not remove user style instructions simply because a shorter prompt is faster on these examples.

## Development observations, 12 September 2026

The initial live pass used OpenRouter's `anthropic/claude-sonnet-4.6`. It exposed an unsupported decision in Russian, malformed JSON around an English quotation mark, and an invented type of lock. The unknown-decision case returned an empty result in three subsequent runs after tightening the grounding instructions. These are development observations, not proof that unsupported decisions are eliminated.

A 13-case comparison with the intermediate JSON output contract produced these request medians: full prompt 1,315 ms, short style 1,117 ms, local context 1,176 ms. There was only one run per case and mode, so the difference is inconclusive. The long-context case succeeded with the full document; the local window lost the supplied code and produced an unsupported generic description instead. Production therefore retains the full document and style guide.

The final parser uses `TEXT:`, `WORD:` and `NONE` instead of JSON to remove quotation escaping from the model's task. Boundary and lifecycle checks pass locally. Live verification of this final prompt was blocked by OpenRouter HTTP 402 (insufficient remaining credits for the prompt). Earlier live results do **not** validate the final prompt. Run `npm run eval:suggestions` again when access is available, and inspect grounding, especially the existing-suffix case, before claiming model quality is verified.

At the user's request, the final prompt was then evaluated directly through Google using `gemini-2.5-flash`. Across 13 completed cases it passed 12 assertions, with a 756 ms median among passing cases (excluding the editor's debounce). The remaining case proposed an unsupported decision after the Russian phrase «наконец решил». That failure remains in the fixture and is not hidden by a passing exit status. On inspection, the other outputs completed words, closed quotations, reused stated facts or abstained; the suffix case used the supplied pot and key instead of inventing a lock type. This is one observation per case, not a guarantee of factuality or repeatability.

Google's free-tier key allowed five requests per minute. After a 429 response, the remaining cases were run with `SUGGEST_DELAY_MS=13000`. The combined local report is `tmp/suggestion-google-final.json`; raw answers were replayed through the final parser. `gemini-3.8-flash` had rejected the adapter's `MINIMAL` thinking level, so it was not used for this quality result. No default model setting was changed.
