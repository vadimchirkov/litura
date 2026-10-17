import * as writingRules from '../extension/writing-rules.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EditorState, StateField, StateEffect } from '@codemirror/state';
import { EditorView, Decoration, WidgetType, showTooltip } from '@codemirror/view';
import { history, undo, isolateHistory } from '@codemirror/commands';
import { mapChatEdit } from '../chat-edits.js';

const source = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const generation = source.slice(source.indexOf('let generationJob = null;'), source.indexOf('// ─── Read-only compartment'));
const passage = source.slice(source.indexOf('let passageJob = null;'), source.indexOf('// ─── Chat ─'));
const draft = 'Opening. The quiet garden waited. Ending. The quiet garden waited.';
function setup({ beforeReply = () => {}, result } = {}) {
  const jobs = new Set(), requests = [], notices = [], snapshots = [];
  const view = { composing: false, focus() {} };
  const context = vm.createContext({
    ...writingRules,
    EditorState, StateField, StateEffect, EditorView, Decoration, WidgetType, showTooltip, isolateHistory,
    mapChatEdit, AbortController, documentKey: 'draft', document: { activeElement: null },
    loadingDocument: false, savePaused: false, jobs, clearGhostFx: StateEffect.define(), cancelSuggestion() {}, ghostClear() {},
    startJob() { const job = new AbortController(); jobs.add(job); return job; }, finishJob: job => jobs.delete(job),
    ensureAgent: async () => true, currentAgent: () => ({ provider: 'fixture', model: 'test' }),
    combinedContext: () => '', saveSnapshot: label => snapshots.push(label), notify: text => notices.push(text),
    modelError: error => ({ say: error.message }),
    notifyProblem: problem => notices.push(problem.say),
    fetch: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body), signal: options.signal });
      await beforeReply({ view, context, jobs });
      return { ok: true, json: async () => result ?? (JSON.parse(options.body).instruction.includes('mean') ? { answer: 'It describes a peaceful garden.', variants: [] } : { answer: '', variants: ['peaceful', 'tranquil', 'still'] }) };
    },
  });
  vm.runInContext(generation + passage, context);
  const field = vm.runInContext('passageField', context), gen = vm.runInContext('generationField', context);
  const effect = vm.runInContext('setPassageFx', context);
  const from = draft.indexOf('quiet'), to = from + 5;
  view.state = EditorState.create({ doc: draft, selection: { anchor: from, head: to }, extensions: [gen, field, history()] });
  view.dispatch = spec => {
    view.state = view.state.update(spec).state;
    for (const job of jobs) if (!view.state.field(field) || view.state.readOnly) job.abort();
  };
  assert(context.openPassage(view, view.state.selection.main));
  const configure = instruction => view.dispatch({ effects: effect.of({ ...view.state.field(field), instruction }) });
  const ask = previous => context.requestPassage(view, previous);
  return { view, context, field, gen, requests, jobs, snapshots, notices, configure, ask };
}

const question = setup();
question.configure('What does this word mean here?');
await question.ask();
assert.equal(question.requests[0].url, '/ask');
assert.equal(question.requests[0].body.selected, 'quiet');
assert.equal(question.requests[0].body.from, draft.indexOf('quiet'));
assert.match(question.view.state.field(question.field).answer, /peaceful/);
assert.equal(question.view.state.doc.toString(), draft);
assert.equal(question.view.state.field(question.gen), null);
assert.equal(question.snapshots.length, 0);

// A mapped replacement stays on the selected occurrence, preserving other edits and Undo.
const rewrite = setup({ beforeReply: ({ view }) => view.dispatch({ changes: { from: 0, insert: 'New opening. ' } }) });
rewrite.configure('Use simpler wording.');
await rewrite.ask();
let candidate = rewrite.view.state.field(rewrite.gen);
assert.equal(candidate.source, 'passage');
assert.equal(candidate.from, draft.indexOf('quiet') + 'New opening. '.length);
assert.equal(rewrite.view.state.doc.toString(), 'New opening. ' + draft);
rewrite.view.dispatch({ selection: { anchor: candidate.to } });
assert(rewrite.context.generationKey(rewrite.view, 'Next'));
assert.equal(rewrite.view.state.field(rewrite.gen).text, 'tranquil');
assert(rewrite.context.generationKey(rewrite.view, 'Accept'));
assert.equal(rewrite.view.state.doc.toString(), 'New opening. ' + draft.replace('quiet', 'tranquil'));
assert.equal(rewrite.view.state.field(rewrite.field), null);
assert(undo(rewrite.view));
assert.equal(rewrite.view.state.doc.toString(), 'New opening. ' + draft);

const synonyms = setup({ result: { variants: ['quiet', 'peaceful', 'peaceful', 'tranquil'] } });
synonyms.configure('Find synonyms.');
await synonyms.ask();
assert.equal(synonyms.requests[0].url, '/ask');
assert.equal(synonyms.requests[0].body.instruction, 'Find synonyms.');
assert.deepEqual(Array.from(synonyms.view.state.field(synonyms.gen).variants), ['peaceful', 'tranquil']);
synonyms.view.dispatch({ selection: { anchor: synonyms.view.state.field(synonyms.gen).to } });
assert(synonyms.context.generationKey(synonyms.view, 'Previous'));
assert.equal(synonyms.view.state.field(synonyms.gen).text, 'tranquil');
await synonyms.context.reviewGeneration(synonyms.view, 'Regenerate', synonyms.view.state.field(synonyms.gen).job);
assert(synonyms.requests[1].body.instruction.includes('tranquil'));
assert.equal(synonyms.view.state.field(synonyms.gen).text, 'peaceful');
assert(synonyms.context.generationKey(synonyms.view, 'Reject'));
assert.equal(synonyms.view.state.field(synonyms.gen), null);
assert.equal(synonyms.view.state.field(synonyms.field), null);
assert.equal(synonyms.view.state.doc.toString(), draft);

for (const stop of ['edit', 'close', 'switch', 'readonly']) {
  const test = setup({ beforeReply: ({ view, context }) => {
    if (stop === 'edit') view.dispatch({ changes: { from: draft.indexOf('quiet'), to: draft.indexOf('quiet') + 5, insert: 'my' } });
    if (stop === 'close') context.closePassage(view);
    if (stop === 'switch') context.documentKey = 'other';
    if (stop === 'readonly') view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)) });
  } });
  test.configure('Make it simpler.');
  await test.ask();
  assert.equal(test.view.state.field(test.gen), null, stop);
  assert.equal(test.view.state.doc.toString(), stop === 'edit' ? draft.replace('quiet', 'my') : draft, stop);
  assert.equal(test.jobs.size, 0, stop);
}

const failed = setup();
failed.configure('Make it simpler.');
await failed.ask();
const previous = failed.view.state.field(failed.gen);
failed.context.fetch = async () => { throw new Error('Provider unavailable'); };
await failed.context.reviewGeneration(failed.view, 'Regenerate', previous.job);
assert.equal(failed.view.state.field(failed.gen).text, previous.text);
assert.equal(failed.view.state.doc.toString(), draft);
assert.equal(failed.view.state.field(failed.field).busy, false);
assert.match(failed.view.state.field(failed.field).answer, /previous suggestion is kept/);

const noModel = setup();
noModel.context.ensureAgent = async () => false;
noModel.configure('Why?');
await noModel.ask();
assert.equal(noModel.requests.length, 0);
assert.equal(noModel.view.state.field(noModel.field).busy, false);
assert.equal(noModel.jobs.size, 0);
console.log('Passage checks passed: local questions, synonyms, mapped replacements, regeneration, stale guards and Undo.');

const modelScope = vm.createContext({ currentAgent: () => ({ provider: 'shared', model: 'one' }) });
vm.runInContext(source.slice(source.indexOf('function activeSuggestAgent()'), source.indexOf('// ── Combobox')), modelScope);
assert.equal(modelScope.activeSuggestAgent().model, 'one');
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
assert(!html.includes('id="suggest-model"'));
assert(!source.includes("['ask', 'Ask']"));

assert(!source.includes("bubbleButton('Note'"));
assert(!source.includes("      noteField,"));
