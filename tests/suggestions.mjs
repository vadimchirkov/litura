import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EditorState, StateField, StateEffect } from '@codemirror/state';
import { EditorView, Decoration, WidgetType } from '@codemirror/view';
import { parseSuggestion, suggestionPrompts } from '../suggestions.js';
import { trimOverlap } from '../review.js';

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
for (const bad of ['plain commentary', 'TEXT:', 'NONE plus commentary', 'null', '[]', '{"text":"hello"}', raw('word '.repeat(16)), raw('one\ntwo')]) {
  assert.throws(() => parseSuggestion('Draft', bad));
}
assert.throws(() => parseSuggestion('word ', raw('ing', true)));
assert.throws(() => parseSuggestion('word', raw('.', true)));
const prompts = suggestionPrompts({ document: 'Before\n\nAfter', cursor: 6, style: 'Keep my voice.', context: 'Known facts.' });
assert(prompts.systemPrompt.includes('Keep my voice.'));
assert(prompts.userPrompt.includes('TEXT AFTER CURSOR:\n\n\nAfter'));
assert(prompts.userPrompt.includes('Known facts.'));

// Exercise production editor state, acceptance and scheduling with a deferred
// provider boundary. Responses deliberately ignore abort to test stale guards.
const source = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
function harness(text = 'A sufficiently long draft') {
  const timers = new Map(), requests = [], statuses = [], jobs = new Set();
  let timerId = 0, saves = 0;
  const view = { hasFocus: true, composing: false };
  const reviewStatus = { dataset: {}, textContent: '' };
  const context = vm.createContext({
    EditorState, StateField, StateEffect, EditorView, Decoration, WidgetType,
    workView: view, document: { hidden: false }, reviewStatus,
    autoSuggestOn: true, loadingDocument: false, savePaused: false, queueMicrotask,
    currentAgent: () => ({ provider: 'fixture', model: 'test' }), ensureAgent: async () => true,
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: id => timers.delete(id),
    startJob: () => { const job = new AbortController(); jobs.add(job); return job; },
    finishJob: job => jobs.delete(job),
    fetch: (_url, options) => new Promise(resolve => requests.push({ options, resolve })),
    setReviewStatus: (message, _detail, from = 'review') => {
      reviewStatus.textContent = message; reviewStatus.dataset.from = message ? from : ''; statuses.push(message);
    },
    modelError: error => ({ say: error.message }), saidInStream: () => false,
  });
  vm.runInContext(source.slice(source.indexOf('class GhostWidget'), source.indexOf('// ─── Slop review highlights')), context);
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
for (const change of ['selection', 'away-and-back', 'blur', 'edit', 'off', 'hidden', 'cancel', 'readonly', 'model']) {
  const h = harness();
  const pending = h.context.suggestFetch();
  const end = h.view.state.doc.length;
  if (change === 'selection') h.view.dispatch({ selection: { anchor: 0, head: end } });
  if (change === 'away-and-back') { h.view.dispatch({ selection: { anchor: 0 } }); h.view.dispatch({ selection: { anchor: end } }); }
  if (change === 'blur') h.blur();
  if (change === 'edit') h.type();
  if (change === 'off') h.context.autoSuggestOn = false;
  if (change === 'hidden') h.context.document.hidden = true;
  if (change === 'cancel') h.context.cancelSuggestion();
  if (change === 'readonly') h.view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)) });
  if (change === 'model') h.context.currentAgent = () => ({ provider: 'other', model: 'other' });
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
  h.context.autoSuggestOn = false;
  await h.context.suggestFetch(); assert.equal(h.requests.length, 0);
  const pending = h.context.suggestFetch(true);
  await new Promise(setImmediate);
  h.answer(0); await pending;
  assert(h.ghost(), 'manual request works with automatic suggestions off and short text');
  h.context.ghostClear(h.view);
  const empty = h.context.suggestFetch(true);
  await new Promise(setImmediate);
  h.answer(1, ''); await empty;
  assert.equal(h.statuses.at(-1), 'No continuation to suggest.');
}
{
  const h = harness();
  h.context.setReviewStatus('Suggestions failed.', undefined, 'suggest');
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
console.log('Suggestion checks passed: spacing, word boundaries, partial words, scheduling, cancellation, stale results, acceptance and manual requests.');
