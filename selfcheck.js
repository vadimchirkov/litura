import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import nspell from 'nspell';
import { clampThinkingLevel } from '@earendil-works/pi-ai';
import { getAgentStatus } from './pi.js';
import { renderMarkdown } from './markdown.js';
import { spellingMarkers, noteSpellingAdded } from './spellcheck.js';
import { clampBubble, resolveDrift, unwrapProse, wordDiff } from './editing.js';
import { chatVisibleText, parseChatResponse } from './chat-edits.js';
import {
  completedSentences, isLatinScript, markSelection, parseVariants, selectionSlot,
  trimOverlap, variantLimit, SELECT_CLOSE, SELECT_OPEN, SELECT_SLOT,
} from './review.js';

// ── Bare edit list ──
// A model that drops the envelope tags still yields cards, not raw JSON.
{
  const bare = parseChatResponse('Done.\n[{"label":"L","quote":"a b","replacement":"a c"}]', 'x a b y');
  assert.equal(bare.text, 'Done.');
  assert.equal(bare.edits[0].from, 2);
  assert.equal(chatVisibleText('Ok\nProposed edits:\n[{"label":"a'), 'Ok');
}

// ── Drift verdict ──
// Same text everywhere is quiet; an untouched local copy fast-forwards; two
// moved copies ask. An unknown baseline can only ask — silence would discard
// work we cannot prove stood still.
{
  assert.equal(resolveDrift('a', 'a', 'a'), 'in-sync');
  assert.equal(resolveDrift('a', 'b', 'a'), 'fast-forward');
  assert.equal(resolveDrift('a', 'b', 'c'), 'diverged');
  assert.equal(resolveDrift('a', 'b', undefined), 'diverged');
  assert.deepEqual(wordDiff('a b', 'a c').map(op => op.type), ['keep', 'del', 'ins']);
}

// Exercise the production completion path without credentials or model calls.
// Keep the mock at the provider boundary, not at the truncation guard.
{
  const source = fs.readFileSync(new URL('./pi.js', import.meta.url), 'utf8');
  const server = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  assert.match(server.slice(server.indexOf("if (url.pathname === '/suggest')")), /requestSuggestion\(/);
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
  // Edge whitespace from the model never reaches the draft as stray breaks.
  assert.deepEqual(parseVariants('[" a\\n","\\n\\nb ","c\\n\\n"]'), ['a', 'b', 'c']);
}

// ── Prose unwrap ──
// Hard-wrapped paragraphs open as flowing text; structure keeps its breaks.
{
  const wrapped = 'Write so the text reads like a person wrote it, not a chatbot. Never change what\nthe text claims. Never add a fact, name, number, date, quote, or citation that\nis not already in the draft.\n\nNext paragraph here.';
  const opened = unwrapProse(wrapped);
  assert.equal(opened.joined, 2);
  assert.equal(opened.text,
    'Write so the text reads like a person wrote it, not a chatbot. Never change what the text claims. Never add a fact, name, number, date, quote, or citation that is not already in the draft.\n\nNext paragraph here.');
  const structured = '# Title\n\n- one\n- two\n\n```\ncode\nline\n```\n\n> quote\ncontinued\n\n1. first\nsecond';
  assert.equal(unwrapProse(structured).joined, 0);
  assert.equal(unwrapProse(structured).text, structured);
  // An explicit hard break (two trailing spaces) is the writer's, not a wrap.
  assert.equal(unwrapProse('line one  \nline two').joined, 0);
  // Already-flowed text comes back byte-identical, so opening never dirties it.
  assert.equal(unwrapProse('One line.\n\nAnother.').joined, 0);
  assert.equal(unwrapProse('One line.\n\nAnother.').text, 'One line.\n\nAnother.');
  assert.deepEqual(unwrapProse(''), { text: '', joined: 0 });
}

// ── Markdown ──
// Anything the model writes is escaped before parsing, so it cannot make a tag.
assert.equal(
  renderMarkdown('<img src=x onerror=alert(1)>'),
  '<p>&lt;img src=x onerror=alert(1)&gt;</p>',
);
assert.equal(renderMarkdown('[x](javascript:alert(1))'), '<p>[x](javascript:alert(1))</p>');
assert(!renderMarkdown('[x](data:text/html,hi)').includes('<a '));
assert(!renderMarkdown('<svg onload=alert(1)>').includes('<svg'));
assert(!renderMarkdown('[x](vbscript:msgbox(1))').includes('<a '));
// A NUL in model output must not collide with the code-block placeholder.
assert(renderMarkdown('a `code\u0000x` b').includes('<code>code\u0000x</code>'));
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

// The English spellchecker skips non-Latin drafts.
assert.equal(isLatinScript('The bakery closed'), true);
assert.equal(isLatinScript('Пекарня закрылась в марте'), false);

// Spelling marks: real typos are flagged with exact offsets, clean prose and
// all-caps acronyms are left alone, and a non-Latin draft is skipped entirely.
{
  const spell = nspell(
    fs.readFileSync(new URL('./public/dictionary/en.aff', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('./public/dictionary/en.dic', import.meta.url), 'utf8'),
  );
  const marks = spellingMarkers('This sentnce has a typo, but NASA does not.', spell);
  assert.deepEqual(marks.map(m => m.quote), ['sentnce']);
  assert.equal(marks[0].from, 5);
  assert.deepEqual(spellingMarkers('Clean prose with no errors here.', spell), []);
  assert.deepEqual(spellingMarkers('Пекарня закрылась в марте', spell), []);
  assert.deepEqual(spellingMarkers('any text', null), []);
  // Ignore teaches the dictionary; the cached verdict must follow, not linger.
  spell.add('sentnce');
  noteSpellingAdded('sentnce');
  assert.deepEqual(spellingMarkers('This sentnce has a typo.', spell), []);
}

// A restated tail is cut; an ordinary continuation is left alone.
assert.equal(trimOverlap('Two hours later the queue', 'queue began draining'), ' began draining');
assert.equal(trimOverlap('Two hours later the queue', ' began draining'), ' began draining');
assert.equal(trimOverlap('It is a skill', ' that pays off'), ' that pays off');

// Only finished sentences are eligible; the trailing fragment is still being typed.
assert.deepEqual(
  completedSentences('One done. Two done! Three unfinished').map(s => s.text),
  ['One done.', 'Two done!'],
);
assert.equal(completedSentences('One done. Two done!')[1].from, 10);
// Abbreviations stay whole: the naive split broke "т.д." into a sentence.
assert.deepEqual(
  completedSentences('Купил хлеб т.д. и молоко. Пошел домой.').map(s => s.text),
  ['Купил хлеб т.д. и молоко.', 'Пошел домой.'],
);

// ── Mark bubble placement ──
//
// The bubble is a fixed toolbar over the draft, and the two things that can
// swallow it are the chrome it does not know about: the fixed header over the
// first line, and the file sidebar beside the pane. The arithmetic is pure, so
// it is checked here rather than by clicking — a bubble hidden under the header
// still reports as "shown" in the DOM, which is exactly how the bug survived a
// passing smoke test.
{
  const clamp = clampBubble;
  const size = { w: 116, h: 34 };
  // The first line of a draft sits under the fixed header: a bubble centred on
  // it must land below the header band, never inside it.
  const pane = { left: 0, right: 1200, top: 0 };
  const header = 48;
  const area = {
    left: pane.left + 8, right: pane.right - 8,
    top: Math.max(pane.top, header) + 8, bottom: 812,
  };
  const firstLine = clamp(600, 62, size, area);
  assert(firstLine.top >= area.top, `bubble top ${firstLine.top} sits inside the header band`);
  // The bubble never covers the text it acts on: above it with room, below
  // its last line without.
  const line = { top: 300, bottom: 330 };
  const above = clamp(600, line.top, size, area, line.bottom);
  assert(above.side === 'above' && above.top + size.h <= line.top, `bubble ${JSON.stringify(above)} overlaps the line above it`);
  const flipped = clamp(600, 70, size, area, 100);
  assert(flipped.side === 'below' && flipped.top >= 100, `bubble ${JSON.stringify(flipped)} overlaps the text it flipped under`);
  // And a bubble never leaves the pane, which is what keeps the sidebar from
  // covering it when the panel is open.
  for (const x of [area.left - 40, area.right + 40, 600]) {
    const box = clamp(x, 300, size, area);
    assert(box.left >= area.left - 0.01 && box.left + size.w <= area.right + 0.01,
      `bubble at x=${x} escaped the pane: ${JSON.stringify(box)}`);
  }
  // Narrow pane: the bubble is centred on the click and may not fit, so it is
  // pinned inside rather than hanging off the edge.
  const narrow = { left: 8, right: 60, top: 56, bottom: 812 };
  assert.equal(clamp(30, 300, size, narrow).left, narrow.left);
}

const status = await getAgentStatus();
assert(Array.isArray(status.providers));
assert(Array.isArray(status.models));
assert(Array.isArray(status.authProviders));
if (status.defaultSelection) {
  assert(status.models.some(model =>
    model.provider === status.defaultSelection.provider && model.model === status.defaultSelection.model));
}

console.log(`Pi self-check: ${status.models.length} available model(s)`);
