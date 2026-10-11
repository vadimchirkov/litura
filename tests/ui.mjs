import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { BRIEF_STEPS, BRIEF_PROMPT, validateBriefQuestions, briefUpdateAllowed, validateBriefUpdate } from '../brief.js';
import { parseChatResponse, chatVisibleText } from '../chat-edits.js';

const source = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const section = (start, end) => {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert(from >= 0 && to > from);
  return source.slice(from, to);
};

// Cards outside the viewport must stay visible and reserve their place in the stack.
{
  const cards = [0, 1].map(() => ({ style: {}, offsetHeight: 100 }));
  const scroller = { scrollHeight: 2000, scrollTop: 0, clientHeight: 700, getBoundingClientRect: () => ({ top: 0 }) };
  const context = vm.createContext({
    syncRail() {}, railOn: true, rail: { children: cards, style: {} },
    railAnchors: new Map(cards.map((card, index) => [card, () => 800 + index * 20])),
    workView: { scrollDOM: scroller, coordsAtPos: position => ({ top: position - scroller.scrollTop }) },
  });
  vm.runInContext(section('function layoutRail()', 'new MutationObserver(layoutRail)'), context);
  context.layoutRail();
  assert.deepEqual(cards.map(card => card.style.visibility), ['visible', 'visible']);
  assert.deepEqual(cards.map(card => card.style.top), ['797px', '905px']);
  scroller.scrollTop = 850;
  context.layoutRail();
  assert.deepEqual(cards.map(card => card.style.top), ['797px', '905px']);
}

const questions = BRIEF_STEPS.map(step => ({ ...step, question: `Рассказ о море: ${step.key}?`, options: ['Первый', 'Второй', 'Третий'] }));
assert.equal(validateBriefQuestions(questions)[0].question, questions[0].question);
for (const bad of [null, [], questions.slice(1), questions.map(item => ({ ...item, key: 'reader' })),
  questions.map(item => ({ ...item, question: ' ' })), questions.map(item => ({ ...item, options: ['Same', 'Same', 'Other'] })),
  questions.map(item => ({ ...item, options: ['a'.repeat(161), 'b', 'c'] }))]) {
  assert.throws(() => validateBriefQuestions(bad), /Invalid brief/);
}

// Exercise the actual route at the provider boundary, including the full draft and saved answers.
{
  const server = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const route = server.slice(server.indexOf("if (url.pathname === '/brief')"), server.indexOf('// POST /idea'));
  let sent, result, raw = JSON.stringify(questions);
  const context = vm.createContext({
    BRIEF_STEPS, BRIEF_PROMPT, validateBriefQuestions, url: { pathname: '/brief' }, signal: new AbortController().signal, res: {},
    completeText: async request => { sent = request; return raw; },
    sendJson: (_res, status, payload) => { result = { status, payload }; },
  });
  vm.runInContext(`async function requestBrief(body) { ${route} }`, context);
  await context.requestBrief({ document: 'Рассказ о море.', answers: { reader: 'Дети' }, agent: { provider: 'fixture', model: 'test' } });
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(sent.userPrompt), { draft: 'Рассказ о море.', answers: { reader: 'Дети' } });
  assert.equal(sent.systemPrompt, BRIEF_PROMPT);
  assert.equal(sent.selection.provider, 'fixture');
  for (raw of ['not JSON', '{}', JSON.stringify(questions.slice(1))]) {
    await context.requestBrief({ document: 'Рассказ о море.' });
    assert.equal(result.status, 502);
  }
  sent = null;
  await context.requestBrief({ document: '' });
  assert.equal(result.status, 200);
  assert.equal(sent, null);
  await context.requestBrief({ document: 'Text', answers: { unknown: 'x' } });
  assert.equal(result.status, 400);
}

// Production interview lifecycle: resume, edit, failure, cancellation and stale response.
{
  const entries = new Map();
  let request, notice, summaries = 0, draft = 'Рассказ о море.';
  const context = vm.createContext({
    BRIEF_STEPS, validateBriefQuestions, validateBriefUpdate, AbortController, positionBrief: null, briefSession: null,
    cancelSuggestion() {}, ghostClear() {},
    docStorage: { getItem: key => entries.get(key), setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) },
    safeJson: (value, fallback) => value ? JSON.parse(value) : fallback,
    workView: { state: { get doc() { return { length: draft.length, toString: () => draft }; } } },
    currentAgent: () => ({ provider: 'fixture', model: 'test' }),
    api: (_path, options) => new Promise((resolve, reject) => { request = { resolve, reject, options }; }),
    dismissPassingNotice() {}, openIsland() {}, chatInput: { focus() {} }, notify: text => { notice = text; },
  });
  vm.runInContext(section('function saveBrief()', '// One passing notice per document'), context);
  context.renderBriefQuestion = () => {};
  context.renderBriefSummary = () => { summaries++; };
  let pending = context.startBrief();
  assert.equal(context.briefSession.loading, true);
  context.answerBriefStep('Must not be consumed yet');
  assert.equal(context.positionBrief, null);
  request.resolve({ questions });
  await pending;
  context.answerBriefStep('Дети');
  context.restoreBrief();
  assert.equal(context.positionBrief.reader, 'Дети');
  assert.match(context.briefContext(), /Дети/, 'A partial brief must already influence writing');
  assert.doesNotMatch(context.briefContext(), /undefined|null/);
  assert.equal(context.positionBrief.questions[0].question, questions[0].question);
  await context.startBrief();
  assert.equal(context.briefSession.step, 1);
  for (const answer of ['Удивить', 'Знают море', 'Короткий рассказ']) context.answerBriefStep(answer);
  assert.equal(context.briefSession, null);
  assert.equal(context.positionBrief.questions.length, 4);
  assert.match(context.briefContext(), /Рассказ о море: reader\?: Дети/);
  context.briefSession = { step: 0, answers: { ...context.positionBrief }, card: null };
  context.answerBriefStep('Взрослые');
  assert.equal(context.briefSession, null, 'Editing one answer must not repeat answered questions');
  assert.equal(summaries, 2);

  delete context.positionBrief.questions;
  pending = context.startBrief();
  let removed = false;
  context.briefSession.card = { remove() { removed = true; } };
  request.resolve({ questions });
  await pending;
  assert.equal(removed, true, 'Loading card must disappear when an old completed brief gets tailored questions');
  assert.equal(context.briefSession, null);

  context.positionBrief = null;
  pending = context.startBrief();
  context.cancelBrief();
  assert.equal(request.options.signal.aborted, true);
  request.resolve({ questions });
  await pending;
  assert.equal(context.briefSession, null);
  assert.equal(context.positionBrief.questions, undefined);

  context.positionBrief = null;
  pending = context.startBrief();
  entries.clear();
  context.restoreBrief(); // A different document has no brief.
  request.resolve({ questions });
  await pending;
  assert.equal(context.positionBrief, null, 'Late response must not attach to a different document');

  pending = context.startBrief();
  request.reject(Error('Model unavailable'));
  await pending;
  assert.equal(context.briefSession.loading, false);
  assert.match(notice, /general questions/);
  context.answerBriefStep('A reader');
  assert.equal(context.positionBrief.reader, 'A reader');
  context.cancelBrief();
  draft = '';
  context.positionBrief = null;
  request = null;
  await context.startBrief();
  assert.equal(request, null, 'An empty draft needs no model call');
}

{
  const command = 'Для всего текста: аудитория — начинающие';
  const update = { source: command, changes: { reader: 'начинающие' } };
  const envelope = value => `<litura-edits>${JSON.stringify(value)}</litura-edits>`;
  const raw = 'Учту аудиторию.\n' + envelope({ edits: [], brief: update });
  assert.equal(briefUpdateAllowed(command), true);
  assert.equal(briefUpdateAllowed('For the whole draft: audience is beginners'), true);
  assert.equal(parseChatResponse(raw, 'Draft', null, command).brief.changes.reader, 'начинающие');
  assert.equal(chatVisibleText(raw, true), 'Учту аудиторию.');
  for (const message of ['Сократи этот абзац', 'Да, хорошо', 'Не обновляй бриф: аудитория — эксперты',
    'Для всего текста: что если аудитория — эксперты?', 'Для всего текста: может, эксперты',
    'For the whole draft: what if we target experts', '“Для всего текста: аудитория — эксперты”',
    'Для всего текста: «аудитория — эксперты» — это цитата']) {
    assert.equal(briefUpdateAllowed(message), false, message);
    const forged = envelope({ edits: [], brief: { ...update, source: message } });
    const result = parseChatResponse(forged, 'Draft', null, message);
    assert.equal(result.brief, undefined);
    assert(result.briefWarning);
  }
  assert.equal(parseChatResponse(raw, 'Draft').brief, undefined, 'Other clients do not authorize brief changes');
  assert.throws(() => validateBriefUpdate({ ...update, changes: { questions: [] } }, command));
  assert.throws(() => validateBriefUpdate({ ...update, changes: { reader: 'x'.repeat(201) } }, command));
  assert.throws(() => validateBriefUpdate({ ...update, source: 'Different message' }, command));
  const normal = parseChatResponse(envelope([{ label: 'Shorten', quote: 'Draft', replacement: 'Text' }]), 'Draft');
  assert.equal(normal.edits[0].state, 'pending', 'Existing edit envelopes remain compatible');

  let undo, saved = 0, notice;
  const context = vm.createContext({
    validateBriefUpdate, positionBrief: { goal: 'explain', reader: 'experts' }, briefSession: null,
    saveBrief: () => saved++, notify: text => { notice = text; }, notifyUndo: (_text, callback) => { undo = callback; },
  });
  vm.runInContext(section('function applyChatBrief(', 'function combinedContext()'), context);
  const before = context.positionBrief;
  context.applyChatBrief(update, command, JSON.stringify(before));
  assert.equal(context.positionBrief.reader, 'начинающие');
  assert.equal(context.positionBrief.goal, 'explain');
  assert.equal(saved, 1);
  undo();
  assert.equal(context.positionBrief, before);
  context.applyChatBrief(update, command, '{}');
  assert.equal(context.positionBrief, before, 'A stale response must not overwrite a newer brief');
  assert.match(notice, /changed/);
  context.applyChatBrief(update, 'Сократи абзац', JSON.stringify(before));
  assert.equal(context.positionBrief, before);
  context.applyChatBrief(update, command, JSON.stringify(before));
  context.positionBrief = { reader: 'children' };
  undo();
  assert.equal(context.positionBrief.reader, 'children', 'Undo must not overwrite subsequent work');
}

console.log('UI checks passed: rail, brief lifecycle, partial context, authorized chat updates, stale guards and undo.');
