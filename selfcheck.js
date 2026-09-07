import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { clampThinkingLevel } from '@earendil-works/pi-ai';
import { getAgentStatus } from './pi.js';
import { renderMarkdown } from './markdown.js';
import {
  completedSentences, isLatinScript, locateFindings, markSelection, mergeReviewFindings,
  parseReviewResponse, parseVariants, selectionSlot, styleMetrics, styleScore, trimOverlap,
  validateReviewFindings, variantLimit, SELECT_CLOSE, SELECT_OPEN, SELECT_SLOT,
} from './review.js';

// Exercise the production completion path without credentials or model calls.
// Keep the mock at the provider boundary, not at the truncation guard.
{
  const source = fs.readFileSync(new URL('./pi.js', import.meta.url), 'utf8');
  const server = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  assert.match(server.slice(server.indexOf("if (url.pathname === '/suggest')")), /continuation: true/);
  const code = source.slice(source.indexOf('const options ='), source.indexOf('export async function streamText')).replace('export ', '');
  let response, sent;
  const model = { reasoning: true };
  const selection = { thinkingLevel: 'high' };
  const context = vm.createContext({
    resolveModel: async () => ({ model, selection, rt: { completeSimple: async (_model, _request, options) => { sent = options; return response; } } }),
    selectionFor: (model, level) => ({ thinkingLevel: clampThinkingLevel(model, level) }),
    request: () => ({}),
  });
  vm.runInContext(code, context);
  response = { stopReason: 'length', content: [{ type: 'text', text: 'the next useful wor' }] };
  await assert.rejects(context.completeText({}), /truncated/);
  assert.equal(sent.reasoning, 'high');
  assert.equal(sent.maxTokens, 1500);
  assert.equal(await context.completeText({ continuation: true }), 'the next useful');
  assert.equal(sent.reasoning, undefined);
  assert.equal(sent.maxTokens, 256);
  assert.equal(selection.thinkingLevel, 'high');
  model.thinkingLevelMap = { off: null, minimal: 'minimal' };
  await context.completeText({ continuation: true });
  assert.equal(sent.reasoning, 'minimal');
  assert.equal(sent.maxTokens, 2048);
  response = { stopReason: 'length', content: [{ type: 'thinking', thinking: 'reasoning only' }] };
  assert.equal(await context.completeText({ continuation: true }), '');
  response = { stopReason: 'stop', content: [{ type: 'text', text: 'a finished thought.' }] };
  assert.equal(await context.completeText({ continuation: true }), 'a finished thought.');
  for (const stopReason of ['error', 'aborted']) {
    response = { stopReason, errorMessage: 'Provider failure', content: [] };
    await assert.rejects(context.completeText({ continuation: true }), /Provider failure/);
  }
}

// ── Rewrite scope ──
// The marked span is what the model must replace; an unmarked draft is what
// made it rewrite the whole thing.
{
  const doc = 'Studies show that teams ship faster. Studies show that morale rises.';
  assert.equal(
    markSelection(doc, 'Studies show that', 37),
    `Studies show that teams ship faster. ${SELECT_OPEN}Studies show that${SELECT_CLOSE} morale rises.`,
  );
  // No offset, or a stale one, still marks a real occurrence rather than nothing.
  assert.equal(markSelection(doc, 'Studies show that').indexOf(SELECT_OPEN), 0);
  assert.equal(markSelection(doc, 'Studies show that', 999).indexOf(SELECT_OPEN), 0);
  assert.equal(markSelection(doc, 'not in the draft'), doc);

  // A replacement for 13 characters may breathe; a rewritten paragraph may not.
  const selected = 'experts agree';
  assert(variantLimit(selected) >= selected.length + 60);
  assert('in three of the four teams we tracked,'.length <= variantLimit(selected));
  assert("In today's fast-paced digital landscape, collaboration is key and teams that leverage synergy innovate more.".length
    > variantLimit(selected));

  // The gap is what stops a variant from repeating its neighbours.
  assert.equal(
    selectionSlot('It is important to note that experts agree collaboration is key.', 'experts agree', 29),
    `It is important to note that ${SELECT_SLOT} collaboration is key.`,
  );
  // An unfinished last line has no sentence to sit in; the window still works.
  assert(selectionSlot('Teams which leverage synergy ship', 'leverage synergy', 12)
    .includes(`Teams which ${SELECT_SLOT} ship`));
  assert.equal(selectionSlot('anything', 'absent'), null);

  assert.deepEqual(parseVariants('noise ["a","b","c"] tail'), ['a', 'b', 'c']);
  assert.throws(() => parseVariants('["a","b"]'), /Expected exactly 3/);
  for (const raw of ['[null,"b","c"]', '[{},"b","c"]', '["","b","c"]', '["a","b","c","d"]']) assert.throws(() => parseVariants(raw));
  assert.throws(() => parseVariants('no array here'), /No JSON array/);
}

// ── Markdown ──
// Anything the model writes is escaped before parsing, so it cannot make a tag.
assert.equal(
  renderMarkdown('<img src=x onerror=alert(1)>'),
  '<p>&lt;img src=x onerror=alert(1)&gt;</p>',
);
assert.equal(renderMarkdown('[x](javascript:alert(1))'), '<p>[x](javascript:alert(1))</p>');
assert(renderMarkdown('[docs](https://a.dev)').includes('<a href="https://a.dev"'));

assert.equal(renderMarkdown('**bold** and *thin*'), '<p><strong>bold</strong> and <em>thin</em></p>');
assert.equal(renderMarkdown('- one\n- two'), '<ul><li>one</li><li>two</li></ul>');
assert.equal(renderMarkdown('1. one\n2. two'), '<ol><li>one</li><li>two</li></ol>');
assert.equal(renderMarkdown('a\n\nb'), '<p>a</p><p>b</p>');

// Emphasis rules must not fire inside code, and a stashed block must not
// collide with ordinary digits in prose.
assert.equal(renderMarkdown('use `a*b*c` here'), '<p>use <code>a*b*c</code> here</p>');
assert.equal(renderMarkdown('I have 3 apples'), '<p>I have 3 apples</p>');
assert.equal(renderMarkdown('```\nx = 1\n```'), '<pre><code>x = 1</code></pre>');

// Underscores inside identifiers are not emphasis.
assert.equal(renderMarkdown('call style_score now'), '<p>call style_score now</p>');

// Slop scores above clean prose of the same length.
const slop = 'In today\'s fast-paced world, experts agree that writing is crucial. '
  + 'At the end of the day, this solution is not just innovative, but truly transformative. '
  + 'It is important to note that this underscores a pivotal moment in an evolving landscape.';
const clean = 'The bakery on Vine Street closed in March. Rent had doubled since 2019. '
  + 'Ruth kept the ovens running for a week after the sign went up, then sold them to a caterer '
  + 'in Dayton. She still has the key on her ring.';
assert(styleScore(slop).score > styleScore(clean).score,
  `expected slop to outscore clean prose, got ${styleScore(slop).score} vs ${styleScore(clean).score}`);
assert(styleScore(slop).score > 40, `slop scored too low: ${styleScore(slop).score}`);
assert(styleScore(clean).score < 30, `clean prose scored too high: ${styleScore(clean).score}`);

// New high-signal categories must reach the automatic-review threshold, while
// ordinary product verbs and justified passive voice stay clean.
assert(styleScore('The dashboard understands what the manager wants and decides which metrics matter.').score >= 20);
assert(styleScore('The dashboard shows three metrics and filters them by date.').score < 20);
assert(styleScore('The server was restarted at 03:00 after its operator field disappeared from the log.').score < 20);
assert(styleScore('The change could potentially possibly reduce support volume.').score >= 20);
assert(styleScore('The change could reduce support volume.').score < 20);
assert(styleScore('WE MUST MOVE NOW.').score >= 20);

// Empty input must not read as slop, and short input must skip the structural axes.
assert.equal(styleScore('').score, 0);
assert.equal(styleScore('Rent had doubled since 2019.').structural, false);
assert.equal(styleScore(clean).structural, true);

// Burstiness: even cadence scores worse than a mix of short and long sentences.
const even = 'The team met on Monday to talk. The team met on Tuesday to plan. The team met on Friday to ship.';
const varied = 'They met Monday. After a week of arguing about the queue depth and whose service was dropping the messages, the team finally shipped on Friday. It held.';
assert(styleMetrics(varied).burstiness > styleMetrics(even).burstiness);

// The score has to be traceable to text the writer can find in their own draft.
const hits = styleMetrics("In today's fast-paced world we leverage robust tooling.").hits;
assert(hits.includes("In today's fast-paced world"));
assert(hits.includes('leverage') && hits.includes('robust'));
assert.deepEqual(styleMetrics('Rent had doubled since 2019.').hits, []);

// The word lists are English; a Cyrillic draft must not be mistaken for clean.
assert.equal(isLatinScript('The bakery closed'), true);
assert.equal(isLatinScript('Пекарня закрылась в марте'), false);

// A restated tail is cut; an ordinary continuation is left alone.
assert.equal(trimOverlap('Two hours later the queue', 'queue began draining'), ' began draining');
assert.equal(trimOverlap('Two hours later the queue', ' began draining'), ' began draining');
assert.equal(trimOverlap('It is a skill', ' that pays off'), ' that pays off');

const parsed = parseReviewResponse('```json\n[{"quote":"Experts agree","pattern":"Vague attribution","reason":"No source","fix":"Name the source"}]\n```');
assert.equal(parsed.length, 1);
assert.equal(parsed[0].code, 'unclassified');
assert.deepEqual(parseReviewResponse('No strong findings.'), []);
assert.throws(() => parseReviewResponse('No findings array could be generated.'), /No findings array/);
assert.throws(() => parseReviewResponse('[null]'), /object/);
assert.throws(() => parseReviewResponse('[{"quote":"x"}]'), /non-empty/);
assert.equal(parseReviewResponse('[{"code":"level-7-paragraph-flow","quote":"A. B.","pattern":"Break","reason":"No bridge","fix":"Connect them"}]')[0].code, 'level-7-paragraph-flow');
const promise = { code: 'level-3-index-discussion', quote: 'We cover price, speed, and safety. Only price and speed follow.' };
const repeatedTerm = { code: 'level-6-key-terms', quote: 'We cover price, speed, and safety.' };
const otherTerm = { code: 'level-6-key-terms', quote: 'The interface renames the same metric.' };
assert.deepEqual(mergeReviewFindings([[promise], [repeatedTerm, otherTerm, otherTerm]]), [promise, otherTerm]);
assert.deepEqual(mergeReviewFindings([[repeatedTerm], [promise, otherTerm]]), [promise, otherTerm]);
assert.deepEqual(mergeReviewFindings([[otherTerm], []]), [otherTerm]);
assert.deepEqual(mergeReviewFindings([[otherTerm, { ...otherTerm, quote: otherTerm.quote + ' More context.' }]]), [otherTerm]);
assert.throws(() => validateReviewFindings([otherTerm], ['generic-prose']), /outside this pass/);
assert.throws(() => validateReviewFindings([otherTerm], ['level-6-key-terms'], 'A different passage.'), /copied exactly/);
assert.doesNotThrow(() => validateReviewFindings([otherTerm], ['level-6-key-terms'], otherTerm.quote));
assert.deepEqual(locateFindings('Experts agree. Experts agree.', parsed)[0], {
  ...parsed[0], from: 0, to: 13,
});

// An occupied first match pushes the quote onto the next free occurrence.
assert.deepEqual(
  locateFindings('Experts agree. Experts agree.', parsed, [{ from: 0, to: 13 }])[0],
  { ...parsed[0], from: 15, to: 28 },
);

// Only finished sentences are eligible; the trailing fragment is still being typed.
assert.deepEqual(
  completedSentences('One done. Two done! Three unfinished').map(s => s.text),
  ['One done.', 'Two done!'],
);
assert.equal(completedSentences('One done. Two done!')[1].from, 9);

const status = await getAgentStatus();
assert(Array.isArray(status.providers));
assert(Array.isArray(status.models));
assert(Array.isArray(status.authProviders));
if (status.defaultSelection) {
  assert(status.models.some(model =>
    model.provider === status.defaultSelection.provider && model.model === status.defaultSelection.model));
}

console.log(`Pi self-check: ${status.models.length} available model(s)`);
