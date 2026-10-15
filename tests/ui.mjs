import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { BRIEF_STEPS, BRIEF_PROMPT, validateBriefQuestions, briefUpdateAllowed, validateBriefUpdate } from '../brief.js';
import { EDITS_OPEN, parseChatResponse, chatVisibleText, locateChatEdits, mapChatEdit, chatEditMatches } from '../chat-edits.js';
import { resolveNoteRange, mapNoteAnchors } from '../notes.js';
import { replacementTarget } from '../editing.js';
import { ChangeSet, EditorState, StateEffect, StateField, RangeSet } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';

// Editing a note's original occurrence must never move it onto another copy.
{
  let document = 'Opening.\n\nTarget phrase here.\n\nTarget phrase elsewhere.';
  const note = { para: 1, quote: 'Target phrase', anchor: 'Target phrase here.', off: 0 };
  const edit = spec => {
    const changes = ChangeSet.of(spec, document.length);
    const after = changes.apply(EditorState.create({ doc: document }).doc).toString();
    mapNoteAnchors([note], document, after, changes);
    document = after;
    return resolveNoteRange(document, note);
  };
  const from = document.indexOf('Target');
  let range = edit({ from: from + 3, insert: 'X' });
  assert.equal(range.from, from, 'note must stay on its edited occurrence');
  assert.equal(document.slice(range.from, range.to), 'TarXget phrase');
  assert.equal(range.drifted, true, 'changed wording must not authorize an automatic rewrite');
  range = edit({ from: 0, insert: 'New paragraph.\n\n' });
  assert.equal(document.slice(range.from, range.to), 'TarXget phrase', 'drifted notes still follow later edits');
  const saved = JSON.parse(JSON.stringify(note));
  assert.deepEqual(resolveNoteRange(document, saved), range, 'live anchors survive reopening');
  range = edit({ from: range.from, to: range.to, insert: 'Reworded' });
  assert.equal(document.slice(range.from, range.to), 'Reworded');
  range = edit({ from: range.from, to: range.to });
  assert.equal(range.from, range.to, 'deleting the passage must not highlight another paragraph');
}

// Repeated paragraphs and repeated quotes within one paragraph use the clicked offset.
{
  let document = 'Same phrase and Same phrase.\n\nSame phrase and Same phrase.';
  const from = document.lastIndexOf('Same phrase');
  const note = { para: 1, quote: 'Same phrase', off: 16, length: 11, anchor: 'Same phrase and Same phrase.' };
  assert.equal(resolveNoteRange(document, note).from, from);
  const edit = spec => {
    const changes = spec instanceof ChangeSet ? spec : ChangeSet.of(spec, document.length);
    const inverse = changes.invert(EditorState.create({ doc: document }).doc);
    const after = changes.apply(EditorState.create({ doc: document }).doc).toString();
    mapNoteAnchors([note], document, after, changes);
    document = after;
    return inverse;
  };
  edit({ from: 0, insert: 'Inserted.\n\n' });
  let range = resolveNoteRange(document, note);
  assert.equal(range.from, document.lastIndexOf('Same phrase'));
  const inverse = edit({ from: range.from, to: range.to });
  range = resolveNoteRange(document, note);
  assert.equal(range.from, range.to);
  edit(inverse);
  range = resolveNoteRange(document, note);
  assert.equal(range.from, document.lastIndexOf('Same phrase'), 'Undo restores original occurrence');
  assert.equal(range.drifted, false);
  const before = document;
  edit([{ from: 0, insert: 'Prefix ' }, { from: range.from, insert: 'Before ' }, { from: range.to, insert: ' after' }]);
  range = resolveNoteRange(document, note);
  assert.equal(document.slice(range.from, range.to), 'Same phrase', 'boundary insertions are outside the note');
  assert.equal(range.from, before.lastIndexOf('Same phrase') + 'Prefix '.length + 'Before '.length);
}

// Passage and point notes follow their original paragraph after insertions above.
{
  const before = 'Opening.\n\nTarget paragraph.\n\nClosing.';
  const note = { para: 1, quote: 'Target', anchor: 'Target paragraph.', off: 0 };
  const point = { para: 1, quote: '', anchor: 'Target paragraph.', off: 3 };
  const after = 'New paragraph.\n\n' + before;
  assert.equal(resolveNoteRange(after, note).from, after.indexOf('Target'));
  assert.equal(resolveNoteRange(after, point).from, after.indexOf('Target') + 3);
  assert.equal(resolveNoteRange('Target\n\nTarget', { ...note, anchor: undefined }).drifted, true, 'repeated quotes must not silently attach to the first one');
  assert.equal(resolveNoteRange('Changed paragraph.', note).drifted, true);
  const changes = ChangeSet.of({ from: before.indexOf('Target'), insert: 'Updated ' }, before.length);
  const text = before.replace('Target', 'Updated Target');
  mapNoteAnchors([note, point], before, text, changes);
  assert.equal(note.anchor, 'Updated Target paragraph.');
  assert.equal(resolveNoteRange(text, point).from, text.indexOf('Target') + 3);
}

const source = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const section = (start, end) => {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert(from >= 0 && to > from);
  return source.slice(from, to);
};

// Overlapping anchors render once; loading and previews own their exact range.
{
  const effect = StateEffect.define();
  const names = ['markdownField', 'noteField', 'spellMarkerField',
    'flashField', 'passageField', 'requestField', 'generationField', 'variantPlainField'];
  const fields = Object.fromEntries(names.map(name => [name, StateField.define({
    create: () => name === 'spellMarkerField' ? []
      : ['flashField', 'passageField', 'generationField', 'variantPlainField'].includes(name) ? null : Decoration.none,
    update: (value, tr) => {
      const change = tr.effects.find(e => e.is(effect) && e.value.name === name);
      return change ? change.value.value : value;
    },
  })]));
  const context = vm.createContext({ ...fields, Decoration, RangeSet, EditorView,
    GenerationWidget: class { constructor(value) { this.value = value; } }, PlainVariantWidget: class {} });
  vm.runInContext(section('function textHighlights(', 'const editorTheme ='), context);
  assert.doesNotThrow(() => EditorState.create({ doc: 'Draft', extensions: [...Object.entries(fields).filter(([name]) => name !== 'noteField').map(([, field]) => field), vm.runInContext('textHighlightLayer', context)] }), 'paused note UI does not require its optional field');
  let state = EditorState.create({ doc: 'One phrase across\nseveral lines.', extensions: [...Object.values(fields), vm.runInContext('textHighlightLayer', context)] });
  const set = (name, value) => { state = state.update({ effects: effect.of({ name, value }) }).state; };
  const mark = (from, to, cls, attributes) => Decoration.set([Decoration.mark({ class: cls, attributes }).range(from, to)]);
  const visible = () => {
    const ranges = [];
    for (const set of state.facet(EditorView.decorations)) set.between(0, state.doc.length, (from, to, value) => ranges.push([from, to, value.spec.class || (value.spec.widget ? 'widget' : '')]));
    return ranges;
  };
  set('noteField', mark(0, 25, 'cm-note', { 'data-note-id': '1' }));
  set('spellMarkerField', [{ from: 7, to: 13 }]);
  assert.deepEqual(visible(), [[0, 7, 'cm-note'], [7, 13, 'cm-spell-marker'], [13, 25, 'cm-note']], 'spelling wins without stacked underlines');
  set('passageField', { from: 4, to: 20 });
  assert.deepEqual(visible(), [[0, 4, 'cm-note'], [4, 20, 'cm-attached'], [20, 25, 'cm-note']]);
  state = state.update({ selection: { anchor: 6, head: 18 } }).state;
  assert(!visible().some(([from, to]) => from < 18 && to > 6), 'native selection has no second wash beneath it');
  set('markdownField', mark(5, 19, 'cm-md-link'));
  set('passageField', { from: 4, to: 20, busy: true });
  assert.deepEqual(visible().filter(([from, to]) => from < 20 && to > 4), [[4, 20, 'cm-passage-busy']], 'multiline skeleton hides links, diagnostics and selection marks');
  set('generationField', { from: 4, to: 20, text: 'Replacement', source: 'passage', inline: true });
  assert(visible().some(([, , cls]) => cls === 'cm-passage-busy'), 'regeneration keeps only the skeleton');
  set('passageField', { from: 4, to: 20, busy: false });
  assert.deepEqual(visible().filter(([from, to]) => from < 20 && to > 4), [[4, 20, 'widget']], 'replacement widget has no enclosing highlight');
  assert.equal(state.field(fields.noteField).size, 1, 'occlusion preserves the original note anchor');
  set('generationField', null); set('passageField', null);
  set('markdownField', Decoration.none);
  state = state.update({ selection: { anchor: 0 } }).state;
  assert.deepEqual(visible(), [[0, 7, 'cm-note'], [7, 13, 'cm-spell-marker'], [13, 25, 'cm-note']], 'dismissal restores occluded diagnostics');
  set('requestField', Decoration.set([Decoration.replace({}).range(0, 1), Decoration.mark({ class: 'cm-generation-request' }).range(1, 20)], true));
  assert.deepEqual(visible(), [[0, 1, ''], [1, 20, 'cm-generation-request'], [20, 25, 'cm-note']], 'slash requests hide diagnostic layers without revealing the slash');
}

// Only a completed, current, single proposal applies; its chat Undo stays scoped.
{
  const proposal = { label: 'Tighten', quote: 'OLD', replacement: 'New wording' };
  const setup = (edits, beforeDone = () => {}) => {
    const node = (tag, className = '', textContent = '') => ({
      tag, className, textContent, children: [], listeners: {}, attributes: {}, isConnected: true,
      append(...children) { this.children.push(...children); },
      prepend(...children) { this.children.unshift(...children); },
      setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener(key, callback) { this.listeners[key] = callback; },
      remove() { this.isConnected = false; },
      classList: { add() {}, toggle() {} }, focus() { document.activeElement = this; },
    });
    const composer = node('textarea'), document = { activeElement: composer };
    const workView = { state: EditorState.create({ doc: 'Before OLD after.', selection: { anchor: 17 } }) };
    const controller = new AbortController(), snapshots = [];
    let saved;
    const context = vm.createContext({
      document, workView, chatEl: node, chatEditCards: new Map(), chatRequests: new Set(),
      chatHistory: [{ role: 'user', content: 'Tighten this.' }], chatAbort: null, changingChatEdit: null,
      loadingDocument: false, savePaused: false, plainPreview: null, positionBrief: null, EDITS_OPEN,
      locateChatEdits, mapChatEdit, chatEditMatches, chatVisibleText, renderMarkdown: text => text,
      startJob: () => ({ signal: controller.signal }), finishJob() {},
      currentAgent: () => ({}), attachedRange: () => null, combinedContext: () => '',
      fetch: async () => ({ ok: true }),
      async *sseChunks() { yield { answer: 'Suggested wording.', edits }; await beforeDone(context, controller); },
      clearPlainPreview() {}, chatAtBottom: () => true, chatScroll() {}, save() {},
      saveSnapshot: () => snapshots.push(workView.state.doc.toString()),
      saveChat: () => { saved = JSON.stringify({ document: workView.state.doc.toString(), messages: context.chatHistory }); },
      setChatOpen() {}, setIsland() {}, notify() {}, notifyProblem() {},
      modelError: () => ({ say: 'Failed' }), console: { error() {} },
      streamAppend: element => element,
      docStorage: { getItem: () => saved },
    });
    workView.dispatch = spec => {
      const tr = workView.state.update(spec);
      workView.state = tr.state;
      if (tr.docChanged) {
        for (const request of context.chatRequests) request.changes.push(tr.changes);
        for (const message of context.chatHistory) for (const edit of message.edits || []) {
          if (edit !== context.changingChatEdit) mapChatEdit(edit, tr.changes);
        }
      }
    };
    vm.runInContext(section('function renderChatAnswer(', '// ── Rail'), context);
    vm.runInContext(section('function restoreChat()', 'function renderChatAnswer('), context);
    vm.runInContext(section('async function streamReply(', 'async function* sseChunks('), context);
    return { context, reply: node('div'), composer, snapshots };
  };
  const { context, reply, composer, snapshots } = setup([proposal]);
  await context.streamReply(reply);
  assert.equal(context.workView.state.doc.toString(), 'Before New wording after.');
  assert.equal(context.workView.state.selection.main.head, 25, 'automatic edits must map the cursor instead of moving it to the passage');
  assert.equal(context.document.activeElement, composer, 'a completed answer must not steal focus');
  assert.deepEqual(snapshots, ['Before OLD after.']);
  const edit = context.chatHistory.at(-1).edits[0];
  const card = context.chatEditCards.get(edit);
  assert.equal(edit.state, 'applied');
  assert.equal(card.apply.hidden, true);
  assert.equal(card.undoFoot.hidden, false);
  assert.match(card.undo.attributes['aria-label'], /Undo edit: Tighten/);
  const beforeReload = context.workView.state.doc.toString();
  context.restoreChat();
  assert.equal(context.workView.state.doc.toString(), beforeReload, 'restoring history must never reapply an edit');
  const restored = context.chatHistory.at(-1).edits[0];
  const restoredCard = context.chatEditCards.get(restored);
  context.workView.dispatch({ changes: { from: 0, insert: 'My prefix. ' } });
  restoredCard.undo.listeners.click();
  assert.equal(context.workView.state.doc.toString(), 'My prefix. Before OLD after.', 'chat Undo must preserve unrelated typing');
  assert.equal(restored.state, 'pending');

  const changed = setup([proposal]);
  await changed.context.streamReply(changed.reply);
  const applied = changed.context.chatHistory.at(-1).edits[0];
  changed.context.workView.dispatch({ changes: { from: applied.from, to: applied.to, insert: 'My own wording' } });
  changed.context.chatEditCards.get(applied).undo.listeners.click();
  assert.equal(changed.context.workView.state.doc.toString(), 'Before My own wording after.', 'Undo must not overwrite typing inside the replacement');
  assert.equal(applied.state, 'stale');

  for (const edits of [[], [proposal, { ...proposal, replacement: 'Another option' }], [{ ...proposal, quote: 'missing' }]]) {
    const test = setup(edits);
    await test.context.streamReply(test.reply);
    assert.equal(test.context.workView.state.doc.toString(), 'Before OLD after.');
    assert.equal(test.snapshots.length, 0);
  }
  const oldPending = setup([]);
  oldPending.context.docStorage.getItem = () => JSON.stringify({ document: 'Before OLD after.', messages: [
    { role: 'assistant', content: 'Old suggestion.', edits: [{ ...proposal, from: 7, to: 10, state: 'pending' }] },
  ] });
  oldPending.context.restoreChat();
  assert.equal(oldPending.context.workView.state.doc.toString(), 'Before OLD after.', 'old pending cards must stay unapplied on reload');
  const readOnly = setup([proposal]);
  readOnly.context.workView.state = EditorState.create({ doc: 'Before OLD after.', extensions: [EditorState.readOnly.of(true)] });
  await readOnly.context.streamReply(readOnly.reply);
  assert.equal(readOnly.context.workView.state.doc.toString(), 'Before OLD after.');
  const stale = setup([proposal], ctx => ctx.workView.dispatch({ changes: { from: 7, to: 10, insert: 'My words' } }));
  await stale.context.streamReply(stale.reply);
  assert.equal(stale.context.workView.state.doc.toString(), 'Before My words after.');
  assert.equal(stale.context.chatHistory.at(-1).edits[0].state, 'stale');
  for (const beforeDone of [(_ctx, controller) => controller.abort(), () => { throw new Error('Disconnected before DONE'); }, ctx => { ctx.savePaused = true; }]) {
    const test = setup([proposal], beforeDone);
    await test.context.streamReply(test.reply);
    assert.equal(test.context.workView.state.doc.toString(), 'Before OLD after.');
    assert.equal(test.snapshots.length, 0);
  }
  const deletion = setup([{ ...proposal, replacement: '' }]);
  await deletion.context.streamReply(deletion.reply);
  const deleted = deletion.context.chatHistory.at(-1).edits[0];
  assert.equal(deletion.context.workView.state.doc.toString(), 'Before  after.');
  deletion.context.chatEditCards.get(deleted).undo.listeners.click();
  assert.equal(deletion.context.workView.state.doc.toString(), 'Before OLD after.');
}

// Chat replacements retain exact scope and snapshot guards without finding cards.
{
  const setup = (readonly = false) => {
    const view = { state: EditorState.create({ doc: 'Before OLD after.', extensions: [EditorState.readOnly.of(readonly)] }), focus() {} };
    const snapshots = [], notices = [];
    const context = vm.createContext({ workView: view, replacementTarget, plainPreview: null,
      flashTimer: null, clearTimeout() {}, setTimeout: () => 0,
      setPlainVariantFx: StateEffect.define(), setFlashFx: StateEffect.define(),
      saveSnapshot: label => snapshots.push(label), save() {}, notify: text => notices.push(text),
    });
    view.dispatch = spec => { view.state = view.state.update(spec).state; };
    vm.runInContext(section('function applyText(', '// ── Slash commands'), context);
    return { context, view, snapshots, notices };
  };
  for (const replacement of ['New wording', '']) {
    const test = setup();
    test.context.applyText(replacement, { from: 7, to: 10, text: 'OLD', document: 'Before OLD after.' });
    assert.equal(test.view.state.doc.toString(), `Before ${replacement} after.`);
    assert.equal(test.snapshots.length, 1);
  }
  for (const guard of ['readonly', 'stale']) {
    const test = setup(guard === 'readonly');
    if (guard === 'stale') test.view.dispatch({ changes: { from: 7, to: 10, insert: 'My wording' } });
    const before = test.view.state.doc.toString();
    test.context.applyText('New wording', { from: 7, to: 10, text: 'OLD', document: 'Before OLD after.' });
    assert.equal(test.view.state.doc.toString(), before, guard);
    assert.equal(test.snapshots.length, 0);
    assert.equal(test.notices.length, 1);
  }
}

// Menu clicks and keyboard choices run commands without leaving command text.
{
  const node = (tag, className = '') => ({
    tag, className, children: [], attributes: {}, listeners: {}, value: '', hidden: true,
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    setAttribute(key, value) { this.attributes[key] = value; },
    removeAttribute(key) { delete this.attributes[key]; },
    addEventListener(key, handler) { this.listeners[key] = handler; },
    querySelectorAll() { return this.children; },
    focus() { document.activeElement = this; }, scrollIntoView() {},
    classList: { toggle() {} },
  });
  const input = node('textarea'), menu = node('div');
  const document = { activeElement: input, getElementById: () => menu };
  const jobs = new Set();
  let briefs = 0, notice = '';
  const context = vm.createContext({
    document, chatInput: input, jobs, console, chatEl: node, icon: () => '',
    chatResize() {}, clearNotice() {},
    startBrief() { briefs++; },
    notify(message) { notice = message; },
  });
  vm.runInContext(section('const SLASH_COMMANDS = [', '// ── Conversation'), context);
  vm.runInContext(section("chatInput.addEventListener('keydown', event => {\n  const menuOpen", "chatClear.addEventListener('mousedown'"), context);
  vm.runInContext(section('async function chatSend()', 'function newReplyBubble()'), context);
  for (const name of ['brief']) {
    input.value = '/' + name;
    input.focus();
    context.renderSlashMenu();
    assert.equal(menu.children.length, 1);
    menu.children[0].listeners.click();
    assert.equal(input.value, '');
    assert.equal(menu.hidden, true);
    assert.equal(input.attributes['aria-expanded'], 'false');
    assert.equal(input.attributes['aria-activedescendant'], undefined);
  }
  assert.equal(briefs, 1);
  for (const key of ['Enter', 'Tab']) {
    input.value = '/br';
    input.focus();
    context.renderSlashMenu();
    let prevented = false;
    input.listeners.keydown({ key, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(input.value, '');
  }
  assert.equal(briefs, 3);
  jobs.add({ background: false });
  input.value = '/brief';
  context.renderSlashMenu();
  menu.children[0].listeners.click();
  assert.equal(briefs, 3, 'a menu choice must respect the foreground job guard');
  assert.equal(input.value, '/brief');
  jobs.clear();
  await context.chatSend();
  assert.equal(briefs, 4, 'typed /brief must run the same interview');
  input.value = '/idea Typed thought';
  await context.chatSend();
  assert.equal(notice, 'No such command — try /brief.');
  assert.equal(input.value, '/idea Typed thought');
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /id="style-(score|details|review-run)"/);
}

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
  vm.runInContext(section('function saveBrief()', "// Clicking a note's mark"), context);
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
  const envelope = value => `<stilura-edits>${JSON.stringify(value)}</stilura-edits>`;
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
