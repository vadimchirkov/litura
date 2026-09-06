# Review evaluation

The review now assigns internal codes to seven reader-structure levels and generic prose. These codes support testing and request routing; the UI shows ordinary underlines and editing directions.

## Sources and integration

- *Anatomy of a Great Essay* (Writer Science), supplied as `anatomy-of-a-great-essay-1.pdf`: whole essay, introduction, index/discussion, nested units, point placement, thematic strings, and paragraph flow.
- [anti-slop](https://github.com/miqdadbadjuber/anti-slop), MIT licensed: copywriting rules, not a prose-analysis library. The integration adds unsupported human agency attributed to objects and manufactured emphasis to the shared style guide, review prompt, and English prefilter. It also adds prefilter coverage for stacked qualifiers already present in the guide. No dependency was added.
- Francis Bacon, [Of Studies](https://www.gutenberg.org/cache/epub/575/pg575-images.html): public-domain source for `fixtures/of-studies.txt`, with lightly modernized spelling and normalized paragraphing. This is a style/structure fixture, not a factual endorsement of its historical claims.

The actorless-passive rule was tried and withdrawn. The model returned no finding on the candidate positive example, including three consecutive repeats after clarification. It is not included among the successful integrations. A blanket ban on em dashes, unsourced claims, or ordinary product verbs was not adopted.

## What the checks establish

`npm run check` checks syntax, builds the browser bundle, and exercises deterministic assertions including parsing, quote anchoring, merging duplicate findings, pass-code validation, and the automatic-review threshold.

`npm run check:deep` makes real model requests with production prompts. The 28 cases comprise 20 synthetic structural/scope cases, five anti-slop cases, and three Bacon regressions. Positive cases require an expected code; clean controls require an empty result. Single-defect structural cases reject competing structural codes. Bacon mutations additionally require the quote to identify the injected passage and permit at most one finding.

The labels were authored during implementation, not by an independent editorial panel. The synthetic cases were revised during development. They check consistency with the chosen editorial rubric; they are not an accuracy benchmark on a representative writing corpus. A correct code alone does not prove that the explanation or suggested revision is good. Generic findings on structural positive cases still require human inspection.

The Bacon essay started as a holdout. Once its results informed prompt changes, it became a regression fixture. Do not describe subsequent Bacon runs as unseen evaluation. Its `health` mutation also has some semantic ambiguity because the original later uses a bodily-health analogy; the test targets the immediate four-item promise followed by only three explanations.

## Reproduce

```sh
npm run check
DEEP_REPORT=review-results.json npm run check:deep
DEEP_CASE=bacon- DEEP_RUNS=3 npm run check:deep
DEEP_CASE=generic-anti DEEP_RUNS=3 npm run check:deep
```

The optional report records the model/provider/reasoning selection, prompt hash, findings, and errors after every case. Failed expectations leave a nonzero exit status. Repeated requests can produce different results, even with the same prompt and model. Full review uses two parallel calls, each with up to three attempts and a 90-second timeout per attempt.

## Observations during development

- The five retained anti-slop cases passed 15/15 attempts in a focused three-repeat run before the final pass-scope correction. These included ordinary product verbs and a single hedge as clean controls.
- Bacon exposed overreach: a locally fulfilled opening list was treated as the outline of the entire essay, and related ideas were flagged for lacking literal word repetition.
- Splitting global and local checks exposed duplicate causes and findings outside a pass's assigned levels. The implementation now checks assigned codes and exact quotes, retries invalid responses, and merges contained duplicate quotes of the same code. A level-3 promise also suppresses a contained level-6 term complaint about that same opening.
- Structural directions can require moving or adding surrounding material. In the UI they now go through the draft conversation. Generic prose findings retain three inline replacement options.

A browser smoke check used the real frontend with fixed responses on an isolated local server. It verified that clicking a structural underline makes no rewrite request, that the subsequent chat includes the finding and full draft, and that a generic underline still offers three variants and applies only the selected quote. This verifies UI wiring, not model judgment or rewrite quality.

The final model-run results are recorded below. Remaining red cases must not be weakened merely to obtain a green run.
