import assert from 'node:assert/strict';
import { getAgentStatus } from './pi.js';
import { renderMarkdown } from './markdown.js';
import {
  completedSentences, isLatinScript, locateFindings,
  parseReviewResponse, styleMetrics, styleScore, trimOverlap,
} from './review.js';

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

// Empty input must not read as slop, and short input must skip the structural axes.
assert.equal(styleScore('').score, 0);
assert.equal(styleScore('Rent had doubled since 2019.').structural, false);
assert.equal(styleScore(clean).structural, true);

// Burstiness: even cadence scores worse than a mix of short and long sentences.
const even = 'The team met on Monday to talk. The team met on Tuesday to plan. The team met on Friday to ship.';
const varied = 'They met Monday. After a week of arguing about the queue depth and whose service was dropping the messages, the team finally shipped on Friday. It held.';
assert(styleMetrics(varied).burstiness > styleMetrics(even).burstiness);

// The word lists are English; a Cyrillic draft must not be mistaken for clean.
assert.equal(isLatinScript('The bakery closed'), true);
assert.equal(isLatinScript('Пекарня закрылась в марте'), false);

// A restated tail is cut; an ordinary continuation is left alone.
assert.equal(trimOverlap('Two hours later the queue', 'queue began draining'), ' began draining');
assert.equal(trimOverlap('Two hours later the queue', ' began draining'), ' began draining');
assert.equal(trimOverlap('It is a skill', ' that pays off'), ' that pays off');

const parsed = parseReviewResponse('```json\n[{"quote":"Experts agree","pattern":"Vague attribution","reason":"No source","fix":"Name the source"}]\n```');
assert.equal(parsed.length, 1);
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
