import * as writingRules from '../extension/writing-rules.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EditorState, StateField, StateEffect, Transaction } from '@codemirror/state';
import { EditorView, Decoration, WidgetType } from '@codemirror/view';
import { history, undo, isolateHistory } from '@codemirror/commands';

const source = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const section = source.slice(source.indexOf('let generationJob = null;'), source.indexOf('// ─── Read-only compartment'));
const draft = 'Opening.\n\n/Describe a quiet garden.\n\nEnding.';
function setup(beforeDone = async () => {}) {
  const jobs = new Set(), notices = [], requests = [], snapshots = [];
  const view = { composing: false };
  const context = vm.createContext({
    ...writingRules,
    EditorState, StateField, StateEffect, EditorView, Decoration, WidgetType, isolateHistory,
    AbortController, documentKey: 'draft', loadingDocument: false, savePaused: false, jobs,
    clearGhostFx: StateEffect.define(), cancelSuggestion() {},
    startJob() { const job = new AbortController(); jobs.add(job); return job; },
    finishJob: job => jobs.delete(job), ensureAgent: async () => true,
    currentAgent: () => ({ provider: 'fixture', model: 'test' }), combinedContext: () => 'Author context',
    saveSnapshot: label => snapshots.push(label), notify: text => notices.push(text),
    notifyProblem: problem => notices.push(problem.say),
    modelError: error => ({ say: error.message }),
    fetch: async (url, options) => { requests.push({ url, body: JSON.parse(options.body), signal: options.signal }); return { ok: true }; },
    async *sseChunks() {
      yield { text: 'A quiet ' };
      await beforeDone({ view, context, jobs, requests });
      yield { text: 'garden.' };
    },
  });
  vm.runInContext(section, context);
  const field = vm.runInContext('generationField', context);
  view.state = EditorState.create({ doc: draft, selection: { anchor: draft.indexOf('\n\nEnding.') }, extensions: [field, history()] });
  view.dispatch = spec => {
    view.state = view.state.update(spec).state;
    for (const job of jobs) if (!view.state.field(field)) job.abort();
  };
  const run = () => context.generateFromLine(view, view.state.doc.lineAt(view.state.selection.main.head), 'Describe a quiet garden.');
  const review = action => context.reviewGeneration(view, action, view.state.field(field)?.job);
  return { context, view, field, jobs, notices, requests, snapshots, run, review };
}

// Keep the completed preview until acceptance; preserve concurrent edits and scoped Undo.
for (const remote of [false, true]) {
  const test = setup(async ({ view }) => {
    assert.equal(view.state.doc.toString(), draft, 'partial output must never be saved as prose');
    assert.equal(view.state.field(test.field).text, 'A quiet ');
    view.dispatch({ changes: { from: 0, insert: 'New opening.\n\n' }, userEvent: 'input.type',
      ...(remote ? { annotations: Transaction.addToHistory.of(false) } : {}) });
    view.dispatch({ selection: { anchor: view.state.doc.length } });
  });
  await test.run();
  assert.equal(test.view.state.field(test.field).phase, 'review');
  assert.equal(test.view.state.field(test.field).text, 'A quiet garden.');
  assert.equal(test.view.state.doc.toString(), 'New opening.\n\n' + draft);
  assert.equal(test.snapshots.length, 0, 'an unaccepted suggestion must not write the draft');
  test.review('Accept');
  const expected = 'New opening.\n\nOpening.\n\nA quiet garden.\n\nEnding.';
  assert.equal(test.view.state.doc.toString(), expected);
  assert.equal(test.view.state.selection.main.head, expected.length, 'generation must not steal the caret');
  assert.equal(test.view.state.field(test.field), null);
  assert.equal(test.jobs.size, 0);
  assert.equal(test.requests[0].url, '/write');
  assert.equal(test.requests[0].body.document, draft);
  assert.equal(test.snapshots.length, 1);
  assert(undo(test.view));
  assert.equal(test.view.state.doc.toString(), 'New opening.\n\n' + draft, 'one undo restores the request and preserves other edits');
}

for (const failure of ['inside', 'delete', 'boundary', 'same-text-replacement', 'abort', 'disconnect', 'empty', 'readonly', 'save-paused', 'switch']) {
  let expected = draft;
  const test = setup(async ({ view, context, jobs }) => {
    const range = view.state.field(test.field);
    if (failure === 'inside') view.dispatch({ changes: { from: range.from + 9, insert: 'my ' } });
    if (failure === 'delete') view.dispatch({ changes: { from: range.from, to: range.to } });
    if (failure === 'boundary') view.dispatch({ changes: { from: range.to, insert: ' More.' } });
    if (failure === 'same-text-replacement') view.dispatch({ changes: { from: range.from, to: range.to, insert: range.quote } });
    if (failure === 'abort') [...jobs][0].abort();
    if (failure === 'readonly') view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)) });
    if (failure === 'save-paused') context.savePaused = true;
    if (failure === 'switch') context.documentKey = 'other-draft';
    expected = view.state.doc.toString();
    if (failure === 'disconnect') throw new Error('Connection lost');
  });
  if (failure === 'empty') test.context.sseChunks = async function* () {};
  await test.run();
  assert.equal(test.view.state.doc.toString(), expected, failure);
  assert.equal(test.view.state.field(test.field), null, failure);
  assert.equal(test.snapshots.length, 0, failure);
  assert.equal(test.jobs.size, 0, failure);
}
// Reject leaves the original request; a stale button cannot accept a different proposal.
{
  const test = setup();
  await test.run();
  const oldJob = test.view.state.field(test.field).job;
  test.review('Reject');
  assert.equal(test.view.state.doc.toString(), draft);
  assert.equal(test.view.state.field(test.field), null);
  assert.equal(test.snapshots.length, 0);
  await test.run();
  test.context.reviewGeneration(test.view, 'Accept', oldJob);
  assert.equal(test.view.state.doc.toString(), draft);
  assert.equal(test.view.state.field(test.field).phase, 'review');
  test.view.dispatch({ changes: { from: 0, insert: 'New.\n\n' } });
  test.context.sseChunks = async function* () { yield { text: 'A second garden.' }; };
  await test.review('Regenerate');
  assert.equal(test.view.state.field(test.field).text, 'A second garden.');
  assert.equal(test.requests.at(-1).body.instruction, 'Describe a quiet garden.');
  assert.equal(test.requests.at(-1).body.document, 'New.\n\n' + draft);
  assert.equal(test.requests.at(-1).body.previous, 'A quiet garden.');
  test.review('Accept');
  assert.equal(test.view.state.doc.toString(), 'New.\n\nOpening.\n\nA second garden.\n\nEnding.');
}

// Server correction replaces the current preview rather than appending two attempts.
{
  const test = setup();
  await test.run();
  test.context.fetch = async (url, options) => {
    const preview = test.view.state.field(test.field);
    assert.equal(preview.text, 'A quiet garden.', 'keep the old suggestion visible until new tokens arrive');
    assert.equal(preview.phase, 'streaming');
    assert.equal(JSON.parse(options.body).previous, 'A quiet garden.');
    return { ok: true };
  };
  test.context.sseChunks = async function* () {
    yield { text: 'An echoed first attempt' };
    yield { replace: '' };
    yield { text: 'Existing context. A new garden.' };
    yield { replace: 'A new garden.' };
  };
  await test.review('Regenerate');
  assert.equal(test.view.state.field(test.field).text, 'A new garden.');
  assert.equal(test.view.state.doc.toString(), draft);
}

// A failed or stopped regeneration keeps the previous proposal reviewable.
for (const failure of ['abort', 'disconnect', 'empty']) {
  const test = setup();
  await test.run();
  test.context.sseChunks = async function* () {
    if (failure === 'empty') return;
    yield { text: 'Incomplete second answer' };
    if (failure === 'abort') [...test.jobs][0].abort();
    else throw new Error('Disconnected');
  };
  await test.review('Regenerate');
  assert.equal(test.view.state.doc.toString(), draft);
  assert.equal(test.view.state.field(test.field).phase, 'review');
  assert.equal(test.view.state.field(test.field).text, 'A quiet garden.');
  test.review('Accept');
  assert.equal(test.view.state.doc.toString(), 'Opening.\n\nA quiet garden.\n\nEnding.');
}

// Pending proposals map edits elsewhere but cannot overwrite a changed request.
for (const blocked of ['inside', 'paused', 'readonly', 'switch']) {
  const test = setup();
  await test.run();
  const target = test.view.state.field(test.field);
  if (blocked === 'inside') test.view.dispatch({ changes: { from: target.from + 1, insert: 'My ' } });
  if (blocked === 'paused') test.context.savePaused = true;
  if (blocked === 'readonly') test.view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)) });
  if (blocked === 'switch') test.context.documentKey = 'other';
  const before = test.view.state.doc.toString();
  test.context.reviewGeneration(test.view, 'Accept', target.job);
  assert.equal(test.view.state.doc.toString(), before, blocked);
  assert.equal(test.snapshots.length, 0, blocked);
}

// Waiting uses a Drive grid and elapsed clock; streamed/review text needs no timer.
{
  const test = setup(), timers = new Map();
  let now = 1000, timerId = 0;
  test.context.Date = { now: () => now };
  test.context.setInterval = (tick, delay) => { assert.equal(delay, 100); timers.set(++timerId, tick); return timerId; };
  test.context.clearInterval = id => timers.delete(id);
  test.context.document = { createElement: tag => ({ tag, children: [], attributes: {}, textContent: '',
    style: { setProperty(key, value) { this[key] = value; } },
    setAttribute(key, value) { this.attributes[key] = value; },
    append(...children) { this.children.push(...children); },
  }) };
  const Widget = vm.runInContext('GenerationWidget', test.context);
  const waiting = new Widget({ job: {}, phase: 'streaming', text: '', startedAt: 1000 });
  const dom = waiting.toDOM(), [grid, label, clock] = dom.children[0].children;
  assert.equal(dom.attributes['aria-busy'], 'true');
  assert.equal(grid.attributes['aria-hidden'], 'true');
  assert.deepEqual(grid.children.map(cell => cell.style['--cell-delay']), ['90', '180', '270', '0', '90', '180', '90', '180', '270']);
  assert.equal(label.textContent, 'Writing');
  assert.equal(clock.attributes['aria-hidden'], 'true', 'clock ticks must not become live announcements');
  assert.equal(clock.textContent, '0.0s');
  now = 62200; timers.get(waiting.timer)();
  assert.equal(clock.textContent, '1m 1.2s');
  waiting.destroy();
  assert.equal(timers.size, 0, 'removing a loading widget stops its clock');

  const regeneration = { job: {}, phase: 'streaming', text: 'Previous', previousText: 'Previous', startedAt: now };
  const regenerating = new Widget(regeneration), regen = regenerating.toDOM();
  assert.equal(regen.children[0].children[1].textContent, 'Rewriting');
  assert.equal(regen.children[1].textContent, 'Previous');
  assert(!regenerating.eq(new Widget({ ...regeneration, previousText: null })), 'first tokens remove the loader even when they repeat the old text');
  regenerating.destroy();

  for (const phase of ['streaming', 'review']) {
    const text = new Widget({ job: {}, phase, text: 'Ready' }).toDOM();
    assert.equal(text.children.length, 1);
    assert.equal(text.children[0].className, 'cm-suggest');
    assert.equal(timers.size, 0, 'visible output has no loading clock');
  }
  const inline = new Widget({ job: {}, phase: 'review', text: 'First line.\nSecond line.', inline: true });
  assert.equal(inline.toDOM().tag, 'span');
  assert.equal(inline.lineBreaks, 1);
}

// Keyboard review applies only at the proposal, not while writing another paragraph.
{
  const test = setup();
  await test.run();
  test.view.dispatch({ selection: { anchor: 0 } });
  assert.equal(test.context.generationKey(test.view, 'Accept'), false);
  assert.equal(test.view.state.doc.toString(), draft);
  test.view.dispatch({ selection: { anchor: test.view.state.field(test.field).to } });
  assert.equal(test.context.generationKey(test.view, 'Reject'), true);
  assert.equal(test.view.state.field(test.field), null);
  await test.run();
  assert.equal(test.context.generationKey(test.view, 'Accept'), true);
  assert.equal(test.view.state.doc.toString(), 'Opening.\n\nA quiet garden.\n\nEnding.');
}

const missing = setup();
missing.context.ensureAgent = async () => false;
await missing.run();
assert.equal(missing.view.state.doc.toString(), draft);
assert.equal(missing.requests.length, 0);
assert.equal(missing.view.state.field(missing.field), null);

// Only an explicit complete command starts a request; ordinary prose stays editable.
const commands = setup();
commands.context.generateFromLine = () => { throw new Error('Unexpected generation'); };
commands.view.dispatch({ selection: { anchor: 2 } });
assert.equal(commands.context.handleWrite(commands.view), false);
commands.view.state = EditorState.create({ doc: '/ ', selection: { anchor: 2 }, extensions: [commands.field] });
assert.equal(commands.context.handleWrite(commands.view), true);
assert.match(commands.notices.at(-1), /Write a request/);
commands.view.state = EditorState.create({ doc: '/Test request', selection: { anchor: 3 }, extensions: [commands.field] });
assert.equal(commands.context.handleWrite(commands.view), false, 'Enter in the middle of a command remains a newline');

// A slash starts the request directly; typing and moving the caret update its highlight.
{
  const test = setup();
  const field = vm.runInContext('requestField', test.context);
  let state = EditorState.create({ doc: '', extensions: [field] });
  assert.equal(state.field(field).size, 0);
  const parts = state => { const out = []; for (const it = state.field(field).iter(); it.value; it.next()) out.push(it.value.spec.class ?? `hidden ${it.from}-${it.to}`); return out.sort(); };
  state = state.update({ changes: { from: 0, insert: '/' }, selection: { anchor: 1 } }).state;
  assert.deepEqual(parts(state), ['cm-generation-request', 'hidden 0-1'], 'a bare slash is hidden; the line background marks the request');
  state = state.update({ changes: { from: 1, insert: 'Напиши вступление\n\nОбычный текст' }, selection: { anchor: 2 } }).state;
  assert.deepEqual(parts(state), ['cm-generation-request', 'hidden 0-1']);
  state = state.update({ selection: { anchor: state.doc.length } }).state;
  assert.equal(state.field(field).size, 0);
  state = state.update({ selection: { anchor: 1 } }).state;
  assert.deepEqual(parts(state), ['cm-generation-request', 'hidden 0-1']);
  state = state.update({ changes: { from: 0, to: 1 } }).state;
  assert.equal(state.field(field).size, 0);
  let captured;
  test.context.generateFromLine = (_view, line, request) => { captured = { line: line.text, request }; };
  for (const text of ['/Напиши вступление', '/ Напиши вступление', '  /  Напиши вступление  ']) {
    test.view.state = EditorState.create({ doc: text, selection: { anchor: text.length }, extensions: [test.field] });
    assert.equal(test.context.handleWrite(test.view), true);
    assert.equal(captured.request, 'Напиши вступление');
    assert.equal(captured.line, text.slice(text.indexOf('/')));
  }
  test.view.state = EditorState.create({ doc: 'Обычный текст', selection: { anchor: 12 }, extensions: [test.field] });
  assert.equal(test.context.handleWrite(test.view), false);
}
// Inline commands preserve the existing prefix through preview, acceptance and Undo.
{
  const test = setup();
  const prefix = 'The garden was quiet. ';
  const text = prefix + '/Continue the scene';
  const requestField = vm.runInContext('requestField', test.context);
  test.view.state = EditorState.create({ doc: text, selection: { anchor: text.length }, extensions: [test.field, requestField, history()] });
  const request = test.context.slashRequest(test.view.state);
  assert.equal(request.from, prefix.length);
  assert.equal(request.text, '/Continue the scene');
  assert.equal(request.instruction, 'Continue the scene');
  assert.equal(request.inline, true);
  const highlight = test.view.state.field(requestField).iter();
  assert.deepEqual([highlight.from, highlight.to], [prefix.length, prefix.length + 1], 'the slash itself is hidden');
  highlight.next();
  assert.equal(highlight.value.spec.class, 'cm-generation-request');
  assert.deepEqual([highlight.from, highlight.to], [prefix.length + 1, text.length], 'highlight only the request');
  await test.context.generateFromLine(test.view, request, request.instruction);
  assert.equal(test.view.state.doc.toString(), text);
  assert.equal(test.view.state.field(test.field).inline, true);
  assert.equal(test.requests[0].body.from, prefix.length);
  assert.equal(test.view.state.field(requestField).size, 0, 'the preview uses ghost styling without request background');
  test.review('Accept');
  assert.equal(test.view.state.doc.toString(), prefix + 'A quiet garden.');
  assert(undo(test.view));
  assert.equal(test.view.state.doc.toString(), text);
}

// R regenerates a ready proposal; repeated R presses during that request do not type into the draft.
{
  const test = setup();
  await test.run();
  test.view.dispatch({ selection: { anchor: 0 } });
  assert.equal(test.context.generationKey(test.view, 'Regenerate'), false);
  test.view.dispatch({ selection: { anchor: test.view.state.field(test.field).to } });
  test.view.composing = true;
  assert.equal(test.context.generationKey(test.view, 'Regenerate'), false);
  test.view.composing = false;
  const original = test.context.generateFromLine;
  let regenerated;
  test.context.generateFromLine = (...args) => regenerated = original(...args);
  test.context.sseChunks = async function* () { yield { text: 'A different garden.' }; };
  assert.equal(test.context.generationKey(test.view, 'Regenerate'), true);
  assert.equal(test.context.generationKey(test.view, 'Regenerate'), true);
  await regenerated;
  assert.equal(test.requests.length, 2, 'only one regeneration starts');
  assert.equal(test.requests[1].body.previous, 'A quiet garden.');
  assert.equal(test.view.state.doc.toString(), draft, 'R is not inserted into the request');
  assert.equal(test.view.state.field(test.field).text, 'A different garden.');
}

// URLs, word separators and comments are ordinary text, not slash requests.
{
  const test = setup();
  for (const text of ['Visit https://example.com/path', 'Use foo/bar', '// comment']) {
    test.view.state = EditorState.create({ doc: text, selection: { anchor: text.length }, extensions: [test.field] });
    assert.equal(test.context.handleWrite(test.view), false, text);
  }
  const text = 'Existing text. /Explain /usr/bin';
  test.view.state = EditorState.create({ doc: text, selection: { anchor: text.length }, extensions: [test.field] });
  assert.equal(test.context.slashRequest(test.view.state).instruction, 'Explain /usr/bin');
}
console.log('Generation checks passed: inline slash requests, R regeneration, concurrent edits, review and Undo.');
