export const REVIEW_CODES = [
  'level-1-whole-essay',
  'level-2-introduction',
  'level-3-index-discussion',
  'level-4-fractal-structure',
  'level-5-point-placement',
  'level-6-key-terms',
  'level-7-paragraph-flow',
  'generic-prose',
];

export function reviewCodesForPass(targeted, phase) {
  return phase === 'global' ? REVIEW_CODES.slice(0, 4)
    : phase === 'local' ? REVIEW_CODES.slice(targeted ? 5 : 4) : REVIEW_CODES;
}

export function buildReviewTask({ targeted = false, phase = 'all' } = {}) {
  const allowedCodes = reviewCodesForPass(targeted, phase);
  const scope = targeted
    ? 'Audit ONLY the passages under PASSAGES TO AUDIT. The draft is context you must read but must not flag. ' +
      'Every quote must be copied from those passages. For structure, use only level-6-key-terms, ' +
      'level-7-paragraph-flow, or generic-prose; reserve larger structural findings for a full review. '
    : '';
  const phaseScope = phase === 'global'
    ? 'This is the global structure pass. Use only levels 1 through 4; do not report paragraph-level or generic-prose findings. '
    : phase === 'local'
      ? `This is the local prose and paragraph pass. Use only ${allowedCodes.join(', ')}; do not diagnose whole-essay structure. `
      : '';
  const globalRules = phase === 'local' ? '' :
    'A recommendation introduced with should or must but no destabilizing problem or cost is a clear level-2-introduction failure. ' +
    'At level 2, cost means the consequence of the opening problem for the reader or subject; do not require an obstacle, objection, or implementation cost for the recommendation. Assess the opening unit as a whole, not every later recommendation paragraph as a new introduction. ' +
    'At level 3, an enumeration is an index only when its wording promises the structure or contents that follow. A list whose items are all developed in the immediately following sentence or clauses has kept its local promise; do not require the rest of the essay to use that list as its outline. ' +
    'Do not use level 3 or 4 for one isolated unrelated sentence inside an otherwise relevant paragraph; the local pass handles that as level 7. Reserve level 4 for a whole paragraph or section that fails to support its containing unit. ' +
    'Final whole-essay check: when a title recommends an action but the ending says that action remains undecided or unavailable, report level-1-whole-essay because the opening problem remains unresolved. ';
  const localRules = phase === 'global' ? '' :
    'Run these three local diagnostic passes unless the genre is excluded; do not return [] merely because grammar is clean. ' +
    'At level 5, examine whether the reader can follow the main claim. A claim in the middle is not a fault by itself: report it only when its placement makes the argument harder to follow. Respect the stated genre, audience and intended voice. ' +
    'In an argumentative paragraph, treat its primary should or must recommendation as the main claim; do not mistake an earlier descriptive topic sentence for that claim. ' +
    'At level 6, list the central terms established by an opening and verify that the discussion carries them through repetition, a clear synonym, a pronoun, or an unambiguous conceptual continuation. Report an unannounced replacement term only when it makes the referent or organising promise unclear. Terms introduced and explained inside the same opening unit are fulfilled locally; do not require them to recur later unless the draft explicitly announces them as continuing threads. ' +
    'If a missing term is itself an item in an explicit opening index, omit the level-6 finding because the global pass handles the broken promise at level 3. ' +
    'At level 7, compare every pair of consecutive sentence themes. If a sentence introduces an unrelated subject with no shared term, pronoun, synonym, or conceptual bridge, report level-7-paragraph-flow even in a three-sentence paragraph. A clear contrast, cause and effect, example, general-to-specific move, instruction, or catalogue supplies a conceptual bridge without repeated wording. ' +
    'An unexplained switch to a different entity or domain is a clear level-7 failure; do not assume intentional disorientation unless the draft signals a narrative or artistic purpose. ' +
    'Before reporting level 7, test the ideas rather than vocabulary: a move from a misuse or problem to its proper use or remedy, or from a claim to an instruction about the same activity, is a conceptual bridge. ' +
    'In aphoristic, historical, or deliberately list-like prose, do not flag a grammatical subject change by itself when the ideas remain plainly related. If an unrelated passage forms a whole paragraph or section rather than one sentence, omit level 7 because the global pass handles it at level 4. ' +
    'Final local check: identify a concrete reader consequence for each diagnosis; omit purely mechanical preferences. ';

  return (
    'You are a sharp human editor auditing a draft for writing and reader-structure problems. ' +
    scope +
    phaseScope +
    'Detect only; do not rewrite the draft, score it, or guess who wrote it. ' +
    'Inspect only the levels assigned to this pass, in order. Definitions of other levels below are for disambiguation, never permission to report them. When one break could fit several levels, ' +
    'use the earliest affected level: if a final paragraph changes subject instead of resolving the opening problem, always use level-1-whole-essay, never level-4-fractal-structure; ' +
    'if an explicit opening index promises items the discussion omits, use level-3-index-discussion rather than level-4-fractal-structure or level-6-key-terms. ' +
    'Use exactly one code for each finding: ' +
    'level-1-whole-essay for a misleading title, an essay that does not make readers care, or an ending that fails to resolve the opening problem; ' +
    'level-2-introduction for missing common ground, a weak or unfair status quo, no destabilizing problem or cost, or no clear point/solution; ' +
    'level-3-index-discussion when a paragraph or section opening fails to set expectations or its discussion breaks that promise; ' +
    'level-4-fractal-structure when a section or paragraph does not support the point of its containing unit; ' +
    'level-5-point-placement when a unit has no point, buries it in the middle, or states it at both beginning and end; ' +
    'level-6-key-terms when central terms announced by an opening disappear, arrive unannounced, or fail to form a coherent thematic string; ' +
    'level-7-paragraph-flow for an abrupt old-to-new information break. Constant-topic, linking, super-theme, and preview-and-develop are all valid flows; ' +
    'generic-prose for throat-clearing, vague attribution, empty puffery, faux insight, generic filler, binary contrast, robotic rhythm, repetitive recap, dramatic fragmentation, stacked hedging, clustered scare quotes or all-caps emphasis, or an abstraction given mind-like agency. ' +
    'Apply essay and introduction codes only to argumentative or explanatory drafts with enough text to support the diagnosis. ' +
    globalRules +
    localRules +
    'Do not force these patterns onto a short answer, list, reference material, dialogue, narrative turn, or intentional disorientation. ' +
    'Do not flag polished grammar, formal vocabulary, proper names, quotations, or one isolated stylistic choice. ' +
    'Passive voice is valid when the actor is unknown or irrelevant. Ordinary product verbs such as report shows, form submits, and filter narrows describe real behavior and are not mind-like agency. ' +
    'Preserve unusual details, humor, uncertainty, bluntness, cadence, and useful roughness. ' +
    'Prefer the most specific code and do not report the same underlying problem at several levels. ' +
    'Before returning, deduplicate by cause: if a higher-level finding already explains a lower-level symptom, omit the lower-level finding. ' +
    'A titleless single-paragraph excerpt is not a whole essay or a section, so do not assign levels 1, 2, or 4 to it. ' +
    'A structural fix may tell the writer to move, connect, add, remove, or rename material; it need not be achievable by replacing the quote alone. ' +
    'Return ONLY a JSON array of at most 8 objects with string fields code, quote, pattern, reason, fix. ' +
    `code must be one of: ${allowedCodes.join(', ')}. ` +
    'The response must be valid JSON: use double-quoted keys and strings and escape any quotation marks inside a string. ' +
    'quote must be the shortest exact contiguous quote that identifies the problem. fix is a brief direction, not a rewrite. ' +
    // The card is read at a glance while the draft stays on screen; a
    // paragraph of explanation there is never read at all.
    'Keep them short: pattern at most 4 words, reason at most 12 words, fix at most 12 words. ' +
    'No preamble, no restating the quote, no hedging — name the problem and the move. ' +
    'Use the language of the draft for pattern, reason, and fix. Return [] when there are no strong findings.'
  );
}

export function buildReviewUser({ document, target = '', context = '' }) {
  return [
    context ? `VOICE OR REFERENCE CONTEXT (do not audit):\n${context}` : '',
    `${target ? 'DRAFT (context only)' : 'DRAFT TO AUDIT'}:\n${document}`,
    target ? `PASSAGES TO AUDIT:\n${target}` : '',
  ].filter(Boolean).join('\n\n---\n\n');
}
