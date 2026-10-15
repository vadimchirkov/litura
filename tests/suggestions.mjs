import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EditorState, StateField, StateEffect } from '@codemirror/state';
import { EditorView, Decoration, WidgetType } from '@codemirror/view';
import { cursorWindow, parseSuggestion, suggestionPrompts, requestSuggestion } from '../suggestions.js';
import { insertionText, trimOverlap } from '../review.js';

const raw = (text, continuesWord = false) => text ? `${continuesWord ? 'WORD' : 'TEXT'}: ${text}` : 'NONE';
for (const [before, text, word, after] of [
  ['Я решил', 'продолжить работу завтра.', false, 'Я решил продолжить работу завтра.'],
  ['Я решил ', 'продолжить работу завтра.', false, 'Я решил продолжить работу завтра.'],
  ['This skill', 'illustrates the point.', false, 'This skill illustrates the point.'],
  ['The scar', 'carefully healed.', false, 'The scar carefully healed.'],
  ['Two hours later the queue', 'queue began draining.', false, 'Two hours later the queue began draining.'],
  ['Two hours later the queue ', 'queue began draining.', false, 'Two hours later the queue began draining.'],
  ['The door is closed', '.', false, 'The door is closed.'],
  ['The sign read "Keep closed', '".', false, 'The sign read "Keep closed".'],
  ['He said "no"', 'and left.', false, 'He said "no" and left.'],
  ['He said', '"no".', false, 'He said "no".'],
  ['He said "', 'no".', false, 'He said "no".'],
  ['Он сказал: «', 'Пора домой».', false, 'Он сказал: «Пора домой».'],
  ['This means (', 'less waiting).', false, 'This means (less waiting).'],
  ['I can', "'t go.", false, "I can't go."],
  ['Она выдох', 'нула.', true, 'Она выдохнула.'],
  ['We were walk', 'ing home.', true, 'We were walking home.'],
  ['Готово.\n\n', 'Следующий раздел.', false, 'Готово.\n\nСледующий раздел.'],
  ['That is all.', '', false, 'That is all.'],
]) assert.equal(before + parseSuggestion(before, raw(text, word)), after);
assert.equal(trimOverlap('skill', 'illustrates'), 'illustrates');
assert.equal(trimOverlap('A skill', 'skillful'), 'skillful');
for (const bad of ['plain commentary', 'TEXT:', 'NONE plus commentary', 'null', '[]', '{"text":"hello"}', raw('one\ntwo')]) {
  assert.throws(() => parseSuggestion('Draft', bad));
}
assert.equal(parseSuggestion('Draft', raw('word '.repeat(16))), ' ' + 'word '.repeat(15).trim());
assert.throws(() => parseSuggestion('word ', raw('ing', true)));
assert.throws(() => parseSuggestion('word', raw('.', true)));
for (const wrapped of ['```text\nTEXT: continued\n```', '```\nTEXT: continued\n```', 'TEXT:\ncontinued', 'text: continued']) {
  assert.equal(parseSuggestion('Draft', wrapped), ' continued');
}
for (const empty of ['', '   ', 'none', '```text\nNONE\n```']) assert.equal(parseSuggestion('Draft', empty), '');
for (const bad of ['Explanation\nTEXT: continued', '```text\nTEXT: continued\n```\nExtra explanation', 'TEXT: continued\nAnother line']) assert.throws(() => parseSuggestion('Draft', bad));

// Context echoes are removed before the 15-word cap, on both sides of the cursor.
{
  const before = 'The courtyard stayed quiet through the afternoon while the neighbours watered the young apple trees.';
  assert.equal(parseSuggestion(before, 'TEXT: ' + before + ' Then the gate opened.'), ' Then the gate opened.');
  assert.equal(parseSuggestion(before, 'TEXT: ' + before), '');
  assert.equal(parseSuggestion('The neighbours watered the trees.', 'TEXT: The neighbours   watered the trees. A bird sang.'), ' A bird sang.');
  assert.equal(parseSuggestion('The gate was locked for the whole afternoon. Later we waited.', 'TEXT: The gate was locked for the whole afternoon.'), '');
  assert.equal(parseSuggestion('We ', 'TEXT: finally met yesterday.', 'met yesterday.'), 'finally ');
  assert.equal(parseSuggestion('We ', 'TEXT: met yesterday.', 'met yesterday.'), '');
  assert.equal(parseSuggestion('The window was op', 'WORD: en', 'en'), '');
  assert.equal(parseSuggestion('The migration began. We waited.', 'TEXT: The migration'), ' The migration', 'short reused phrases can introduce the next sentence');
  assert.equal(parseSuggestion('He said "hello', 'TEXT: ”', '”'), '');
  assert.equal(insertionText(before + '\n\n', before + '\n\nA gate opened.\n\nThe evening was calm.', '\n\nThe evening was calm.'), 'A gate opened.');
  assert.equal(insertionText('That skill', 'illustrates the point.', ''), 'illustrates the point.');
  const document = 'We met yesterday.';
  const text = await requestSuggestion({ document, cursor: 3 }, async () => 'TEXT: finally met yesterday.');
  assert.equal(document.slice(0, 3) + text + document.slice(3), 'We finally met yesterday.');
}

// Recover only a format failure, at most once, under the original deadline.
{
  const requests = [], signal = new AbortController().signal;
  const complete = async request => { requests.push(request); return requests.length === 1 ? 'Unlabeled answer' : 'TEXT: recovered'; };
  assert.equal(await requestSuggestion({ document: 'Draft', signal }, complete), ' recovered');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].signal, signal);
  assert.equal(requests[1].continuation, true);
  assert.match(requests[1].userPrompt, /Expected TEXT:/);
}
{
  let calls = 0;
  assert.equal(await requestSuggestion({ document: 'Draft' }, async () => { calls++; return '```text\nTEXT: continued\n```'; }), ' continued');
  assert.equal(calls, 1, 'safe normalization must not spend a second model call');
  for (const answer of ['', 'NONE']) {
    calls = 0;
    assert.equal(await requestSuggestion({ document: 'Draft' }, async () => { calls++; return answer; }), '');
    assert.equal(calls, 1, 'abstention is not a model error');
  }
}
{
  let calls = 0;
  await assert.rejects(requestSuggestion({ document: 'Draft' }, async () => { calls++; return 'Invalid answer'; }), error => error.code === 'SUGGESTION_FORMAT' && error.attempts === 2);
  assert.equal(calls, 2, 'format recovery cannot loop');
  for (const message of ['401 invalid key', '429 quota exceeded', 'Provider failed']) {
    calls = 0;
    await assert.rejects(requestSuggestion({ document: 'Draft' }, async () => { calls++; throw new Error(message); }), error => error.message === message);
    assert.equal(calls, 1, 'provider errors must not trigger format recovery');
  }
}
{
  let calls = 0;
  const controller = new AbortController();
  await assert.rejects(requestSuggestion({ document: 'Draft', signal: controller.signal }, async () => {
    calls++; controller.abort(); return 'Invalid answer';
  }), error => error.name === 'AbortError');
  assert.equal(calls, 1, 'typing cancellation must prevent another call');
}
const prompts = suggestionPrompts({ document: 'Before\n\nAfter', cursor: 6, style: 'Keep my voice.', context: 'Known facts.' });
assert(prompts.systemPrompt.includes('Keep my voice.'));
assert(prompts.userPrompt.includes('TEXT AFTER CURSOR:\n\n\nAfter'));
assert(prompts.userPrompt.includes('Known facts.'));
const briefPrompts = suggestionPrompts({ document: 'Draft', brief: 'Reader: beginners' });
assert.match(briefPrompts.userPrompt, /WRITING BRIEF.*\nReader: beginners/);
assert.match(briefPrompts.systemPrompt, /not facts to insert/);

// Exercise production editor state, acceptance and scheduling with a deferred
// provider boundary. Responses deliberately ignore abort to test stale guards.
const source = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
function harness(text = 'A sufficiently long draft') {
  const timers = new Map(), requests = [], statuses = [], jobs = new Set();
  let timerId = 0, saves = 0;
  const agentStub = () => ({ provider: 'fixture', model: 'test' });
  const view = { hasFocus: true, composing: false };
  const suggestStatus = { dataset: {}, textContent: '' };
  const context = vm.createContext({
    EditorState, StateField, StateEffect, EditorView, Decoration, WidgetType,
    workView: view, document: { hidden: false }, suggestStatus,
    loadingDocument: false, savePaused: false, queueMicrotask,
    currentAgent: agentStub, ensureAgent: async () => true,
    activeSuggestAgent: agentStub,
    briefContext: () => '',
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: id => timers.delete(id),
    startJob: () => { const job = new AbortController(); jobs.add(job); return job; },
    finishJob: job => jobs.delete(job),
    fetch: (_url, options) => new Promise(resolve => requests.push({ options, resolve })),
    setSuggestStatus: (message, _detail, from = 'review') => {
      suggestStatus.textContent = message; suggestStatus.dataset.from = message ? from : ''; statuses.push(message);
    },
    modelError: error => ({ say: error.message }), saidInStream: () => false,
  });
  vm.runInContext(source.slice(source.indexOf('class GhostWidget'), source.indexOf('// ─── Spelling marks')), context);
  vm.runInContext(source.slice(source.indexOf('let suggestTimer ='), source.indexOf('// ─── Read-only compartment')), context);
  const ghostField = vm.runInContext('ghostField', context);
  view.state = EditorState.create({ doc: text, selection: { anchor: text.length }, extensions: [ghostField] });
  view.dispatch = spec => {
    const tr = view.state.update(spec), previous = view.state;
    view.state = tr.state;
    context.suggestionUpdate({
      view, state: tr.state, startState: previous, transactions: [tr],
      docChanged: tr.docChanged, selectionSet: Boolean(tr.selection), focusChanged: false,
    });
    if (tr.docChanged) saves++;
  };
  return { context, view, requests, timers, statuses, jobs, get saves() { return saves; },
    ghost: () => view.state.field(ghostField),
    answer: (index, suggestion = ' and continued') => requests[index].resolve({ ok: true, json: async () => ({ suggestion }) }),
    type: (insert = ' more') => view.dispatch({ changes: { from: view.state.selection.main.head, insert }, selection: { anchor: view.state.selection.main.head + insert.length }, userEvent: 'input.type' }),
    blur: () => { view.hasFocus = false; context.suggestionUpdate({ view, state: view.state, focusChanged: true }); },
  };
}

{
  const h = harness();
  h.type(); assert.equal(h.timers.size, 1);
  h.timers.clear(); // the scheduled timer has fired
  const pending = h.context.suggestFetch();
  h.answer(0); await pending;
  assert(h.ghost());
  h.context.ghostAccept(h.view);
  assert(h.view.state.doc.toString().endsWith(' and continued'));
  assert.equal(h.saves, 2); // type + accept, no second explicit save
  assert.equal(h.timers.size, 0); // accepting cannot start a chain
  for (const userEvent of ['input.paste', 'input.acceptGhost', 'undo', 'redo', 'delete.backward']) {
    h.view.dispatch({ changes: { from: 0, insert: 'x' }, userEvent });
    assert.equal(h.timers.size, 0, userEvent);
  }
}
for (const change of ['selection', 'away-and-back', 'blur', 'edit', 'hidden', 'cancel', 'readonly', 'model']) {
  const h = harness();
  const pending = h.context.suggestFetch();
  const end = h.view.state.doc.length;
  if (change === 'selection') h.view.dispatch({ selection: { anchor: 0, head: end } });
  if (change === 'away-and-back') { h.view.dispatch({ selection: { anchor: 0 } }); h.view.dispatch({ selection: { anchor: end } }); }
  if (change === 'blur') h.blur();
  if (change === 'edit') h.type();
  if (change === 'hidden') h.context.document.hidden = true;
  if (change === 'cancel') h.context.cancelSuggestion();
  if (change === 'readonly') h.view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)) });
  if (change === 'model') h.context.currentAgent = h.context.activeSuggestAgent = () => ({ provider: 'other', model: 'other' });
  h.answer(0); await pending;
  assert.equal(h.ghost(), null, change);
  assert.equal(h.jobs.size, 0);
}
{
  const h = harness();
  h.type(); h.view.dispatch({ selection: { anchor: 0 } });
  assert.equal(h.timers.size, 0, 'movement cancels a pending debounce');
  h.view.dispatch({ selection: { anchor: h.view.state.doc.length } });
  assert.equal(h.timers.size, 0, 'movement alone never requests a suggestion');
}
{
  const h = harness();
  const old = h.context.suggestFetch();
  h.context.cancelSuggestion();
  const fresh = h.context.suggestFetch();
  h.answer(1, ' newest'); await fresh;
  h.answer(0, ' stale'); await old;
  assert.equal(h.ghost().text, ' newest');
}
{
  const h = harness();
  let ready;
  h.context.ensureAgent = () => new Promise(resolve => { ready = resolve; });
  const pending = h.context.suggestFetch(true);
  h.view.dispatch({ selection: { anchor: 0 } });
  ready(true); await pending;
  assert.equal(h.requests.length, 0, 'model discovery must not retarget a manual request');
}
{
  const h = harness();
  const pending = h.context.suggestFetch();
  h.context.cancelSuggestion();
  h.requests[0].resolve({ ok: false, json: async () => ({ error: 'Provider failure' }) });
  await pending;
  assert.equal(h.statuses.length, 0, 'stale errors must stay silent');
}
{
  const h = harness('Short');
  await h.context.suggestFetch(); assert.equal(h.requests.length, 0);
  const pending = h.context.suggestFetch(true);
  await new Promise(setImmediate);
  h.answer(0); await pending;
  assert(h.ghost(), 'manual request works with text below the automatic suggestion minimum');
  h.context.ghostClear(h.view);
  const empty = h.context.suggestFetch(true);
  await new Promise(setImmediate);
  h.answer(1, ''); await empty;
  assert.equal(h.statuses.at(-1), 'No continuation to suggest.');
}
{
  const h = harness();
  h.context.setSuggestStatus('Suggestions failed.', undefined, 'suggest');
  const pending = h.context.suggestFetch(); h.answer(0, ''); await pending;
  assert.equal(h.statuses.at(-1), '', 'success clears the previous failure');
  h.context.ghostShow(h.view, ' saved'); h.blur(); await Promise.resolve();
  assert.equal(h.ghost(), null);
}
for (const [text, cursor, eligible] of [
  ['First paragraph\n\nNext paragraph', 15, true],
  ['First line\nSecond line', 10, false],
  ['A long draft', 4, false],
  ['A long draft', 12, true],
]) {
  const h = harness(text);
  h.view.dispatch({ selection: { anchor: cursor } });
  assert.equal(h.context.atParagraphEnd(h.view.state), eligible);
}
{
  const h = harness();
  let brief = 'Reader: beginners';
  h.context.briefContext = () => brief;
  const pending = h.context.suggestFetch();
  const body = JSON.parse(h.requests[0].options.body);
  assert.equal(body.brief, brief);
  assert.equal(body.messages, undefined, 'Suggestions must not receive chat history');
  brief = 'Reader: experts';
  h.answer(0); await pending;
  assert.equal(h.ghost(), null, 'Changing the brief invalidates an in-flight suggestion');
}
{
  const h = harness();
  h.context.positionBrief = { reader: 'beginners' };
  h.context.docStorage = { setItem() {} };
  const from = source.indexOf('function saveBrief()'), to = source.indexOf('function restoreBrief()', from);
  vm.runInContext(source.slice(from, to), h.context);
  h.context.ghostShow(h.view, 'old wording');
  h.context.saveBrief();
  assert.equal(h.ghost(), null, 'Saving a brief clears already visible ghost text');
}
{
  const h = harness();
  h.context.ghostShow(h.view, ' and continued');
  h.type(' an');
  assert.equal(h.ghost().text, 'd continued', 'typing the ghost keeps its rest');
  assert.equal(h.ghost().pos, h.view.state.doc.length);
  assert.equal(h.timers.size, 0, 'a surviving ghost needs no new request');
  h.type('x');
  assert.equal(h.ghost(), null, 'diverging from the ghost clears it');
  assert.equal(h.timers.size, 1);
  h.context.ghostShow(h.view, ' end');
  h.type(' end');
  assert.equal(h.ghost(), null, 'typing the whole ghost consumes it');
}
{
  const h = harness();
  h.context.reportSuggestFailure = () => {};
  const pending = h.context.suggestFetch();
  h.requests[0].resolve({ ok: false, status: 500, text: async () => JSON.stringify({ error: '429: Rate limit reached' }) });
  await pending;
  h.type();
  assert.equal(h.timers.size, 0, 'a rate limit pauses automatic requests');
}
{
  const draft = 'word '.repeat(4000);
  const now = cursorWindow(draft, draft.length), later = cursorWindow(draft + 'more ', draft.length + 5);
  assert(now.before.length < 10_100 && now.before.startsWith('…'));
  assert(later.before.startsWith(now.before), 'typing keeps the cacheable window start');
  assert.deepEqual(cursorWindow('short text', 5), { before: 'short', after: ' text' });
}
console.log('Suggestion checks passed: spacing, scheduling, cancellation, stale results, brief context, acceptance, typeahead, rate-limit pause and context window.');
