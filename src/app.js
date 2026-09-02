// src/app.js — Litura frontend (CodeMirror 6)

import {
  EditorView,
  keymap,
  Decoration,
  WidgetType,
  placeholder,
} from '@codemirror/view';
import {
  EditorState,
  StateField,
  StateEffect,
  Compartment,
  Prec,
} from '@codemirror/state';
import {
  defaultKeymap,
  history,
  historyKeymap,
} from '@codemirror/commands';
import { completedSentences, isLatinScript, locateFindings, styleMetrics, styleScore } from '../review.js';
import { renderMarkdown } from '../markdown.js';

// ─── Elements ──────────────────────────────────────────────────────────────────

const editorWrap    = document.getElementById('editor-wrapper');
const settingsOpen  = document.getElementById('settings-open');
const settingsDialog = document.getElementById('settings-dialog');
const settingsForm  = document.getElementById('settings-form');
const providerEl    = document.getElementById('agent-provider');
const modelEl       = document.getElementById('agent-model');
const thinkingEl    = document.getElementById('agent-thinking');
const keyProviderEl = document.getElementById('key-provider');
const apiKeyEl      = document.getElementById('api-key');
const keyAddEl      = document.getElementById('key-add');
const configuredKeys = document.getElementById('configured-keys');
const settingsError = document.getElementById('settings-error');
const modelHint     = document.getElementById('model-hint');
const agentStatusEl = document.getElementById('agent-status');
const reviewButton  = document.getElementById('review-button');
const chatStream    = document.getElementById('chat-stream');
const chatInput     = document.getElementById('chat-input');
const chatChip      = document.getElementById('chat-chip');
const chatChipText  = document.getElementById('chat-chip-text');
const chatChipClear = document.getElementById('chat-chip-clear');
const chatClear     = document.getElementById('chat-clear');
const scoreEl       = document.getElementById('style-score');

const thinkingNames = { off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Maximum' };
let agentInfo = { available: false, providers: [], models: [], authProviders: [] };
let agentSelection = null;
try { agentSelection = JSON.parse(localStorage.getItem('wa-agent') || 'null'); } catch {}
let draftSelection = agentSelection;

const levelsFor = model => model?.thinkingLevels?.length
  ? model.thinkingLevels
  : model?.reasoning ? ['off', 'low', 'medium', 'high'] : ['off'];

function normalizeSelection(selection) {
  const model = agentInfo.models.find(item => item.provider === selection?.provider && item.model === selection?.model);
  if (!model) return null;
  const levels = levelsFor(model);
  const thinkingLevel = levels.includes(selection.thinkingLevel)
    ? selection.thinkingLevel
    : levels.includes('medium') ? 'medium' : levels[0];
  return { provider: model.provider, model: model.model, thinkingLevel };
}

function currentAgent() {
  return normalizeSelection(agentSelection);
}

function setOptions(select, options, value) {
  select.replaceChildren(...options.map(({ value: optionValue, label }) => {
    const option = document.createElement('option');
    option.value = optionValue;
    option.textContent = label;
    return option;
  }));
  select.value = options.some(option => option.value === value) ? value : options[0]?.value ?? '';
  select.disabled = !options.length;
}

function updateAgentLabel() {
  const selection = currentAgent();
  const model = agentInfo.models.find(item => item.provider === selection?.provider && item.model === selection?.model);
  agentStatusEl.textContent = model?.name ?? (agentInfo.available ? 'Choose model' : 'Pi not configured');
}

function renderModelSettings() {
  draftSelection = normalizeSelection(draftSelection)
    ?? normalizeSelection(agentInfo.defaultSelection)
    ?? (agentInfo.models[0] ? normalizeSelection({ ...agentInfo.models[0], thinkingLevel: 'medium' }) : null);
  const providerIds = [...new Set(agentInfo.models.map(model => model.provider))];
  setOptions(providerEl, providerIds.map(id => ({
    value: id,
    label: agentInfo.providers.find(provider => provider.id === id)?.name ?? id,
  })), draftSelection?.provider);
  const models = agentInfo.models.filter(model => model.provider === providerEl.value);
  setOptions(modelEl, models.map(model => ({ value: model.model, label: model.name || model.model })), draftSelection?.model);
  const model = models.find(item => item.model === modelEl.value);
  const levels = levelsFor(model);
  setOptions(thinkingEl, levels.map(level => ({ value: level, label: thinkingNames[level] ?? level })), draftSelection?.thinkingLevel);
  draftSelection = model ? { provider: model.provider, model: model.model, thinkingLevel: thinkingEl.value } : null;
  modelHint.textContent = agentInfo.models.length ? '' : 'Add an API key or configure Pi authentication to see models.';
  document.getElementById('settings-save').disabled = !draftSelection;
}

function renderCredentials() {
  setOptions(keyProviderEl, agentInfo.authProviders.map(provider => ({ value: provider.id, label: provider.name })), keyProviderEl.value || 'openai');
  apiKeyEl.placeholder = agentInfo.authProviders.find(provider => provider.id === keyProviderEl.value)?.label ?? 'API key';
  configuredKeys.replaceChildren(...agentInfo.authProviders.filter(provider => provider.configured).map(provider => {
    const chip = document.createElement('div');
    chip.className = 'key-chip';
    const dot = document.createElement('i');
    const name = document.createElement('span');
    name.textContent = `${provider.name} · ${provider.source === 'environment' ? 'environment' : 'configured'}`;
    chip.append(dot, name);
    if (provider.source !== 'environment') {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.title = `Remove ${provider.name} key`;
      remove.addEventListener('click', () => removeProviderKey(provider.id));
      chip.append(remove);
    }
    return chip;
  }));
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function refreshAgent() {
  agentInfo = await api('/api/agent/status');
  const normalized = normalizeSelection(agentSelection) ?? normalizeSelection(agentInfo.defaultSelection);
  if (normalized) {
    agentSelection = normalized;
    localStorage.setItem('wa-agent', JSON.stringify(agentSelection));
  }
  updateAgentLabel();
  return agentInfo;
}

settingsOpen.addEventListener('click', async () => {
  settingsError.textContent = '';
  try { await refreshAgent(); } catch (error) { settingsError.textContent = error.message; }
  draftSelection = currentAgent();
  renderModelSettings();
  renderCredentials();
  settingsDialog.showModal();
});

providerEl.addEventListener('change', () => {
  const first = agentInfo.models.find(model => model.provider === providerEl.value);
  draftSelection = first ? { provider: first.provider, model: first.model, thinkingLevel: 'medium' } : null;
  renderModelSettings();
});
modelEl.addEventListener('change', () => {
  draftSelection = { provider: providerEl.value, model: modelEl.value, thinkingLevel: draftSelection?.thinkingLevel ?? 'medium' };
  renderModelSettings();
});
thinkingEl.addEventListener('change', () => {
  if (draftSelection) draftSelection = { ...draftSelection, thinkingLevel: thinkingEl.value };
});
keyProviderEl.addEventListener('change', renderCredentials);

settingsForm.addEventListener('submit', event => {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') { settingsDialog.close(); return; }
  const normalized = normalizeSelection(draftSelection);
  if (!normalized) return;
  agentSelection = normalized;
  localStorage.setItem('wa-agent', JSON.stringify(agentSelection));
  updateAgentLabel();
  settingsDialog.close();
});

keyAddEl.addEventListener('click', async () => {
  settingsError.textContent = '';
  keyAddEl.disabled = true;
  try {
    agentInfo = await api('/api/agent/credentials', {
      method: 'POST',
      body: JSON.stringify({ provider: keyProviderEl.value, apiKey: apiKeyEl.value }),
    });
    apiKeyEl.value = '';
    renderModelSettings();
    renderCredentials();
  } catch (error) { settingsError.textContent = error.message; }
  finally { keyAddEl.disabled = false; }
});

async function removeProviderKey(provider) {
  settingsError.textContent = '';
  try {
    agentInfo = await api('/api/agent/credentials', { method: 'DELETE', body: JSON.stringify({ provider }) });
    renderModelSettings();
    renderCredentials();
  } catch (error) { settingsError.textContent = error.message; }
}

refreshAgent().catch(error => {
  agentStatusEl.textContent = 'Pi error';
  console.error('[pi]', error.message);
});

// ─── Ghost text ─────────────────────────────────────────────────────────────────
//
//  State: { text: string, pos: number } | null
//
//  Life-cycle:
//    suggestFetch() → ghostShow()  — set ghost at current cursor
//    tr.docChanged  → null         — user typed, clear immediately
//    tr.selection   → null         — cursor moved, clear immediately
//    Tab            → ghostAccept() — insert text, clear
//    Escape         → ghostClear() — dismiss
//

class GhostWidget extends WidgetType {
  constructor(text) { super(); this.text = text; }

  eq(other) { return other.text === this.text; }

  toDOM() {
    const panel = document.createElement('div');
    panel.className = 'cm-suggest';

    const body = document.createElement('span');
    body.className   = 'cm-suggest-text';
    body.textContent = this.text;

    const hint = document.createElement('span');
    hint.className   = 'cm-suggest-hint';
    hint.textContent = 'Tab';

    panel.append(body, hint);
    return panel;
  }

  ignoreEvent() { return true; }
}

const setGhostFx   = StateEffect.define();
const clearGhostFx = StateEffect.define();

// Ghost state field — also provides decorations
const ghostField = StateField.define({
  create: () => null,

  update(val, tr) {
    if (tr.docChanged) return null;  // typing → clear
    if (tr.selection)  return null;  // cursor moved → clear
    for (const e of tr.effects) {
      if (e.is(setGhostFx))   return e.value;   // { text, pos }
      if (e.is(clearGhostFx)) return null;
    }
    return val;
  },

  // Render as a block panel below the line — never inside the writer's sentence
  provide: f => EditorView.decorations.from(f, ghost => {
    if (!ghost) return Decoration.none;
    const w = Decoration.widget({ widget: new GhostWidget(ghost.text), side: 1, block: true });
    return Decoration.set([w.range(ghost.line)]);
  }),
});

function ghostShow(view, text) {
  const pos = view.state.selection.main.head;
  view.dispatch({ effects: setGhostFx.of({ text, pos, line: view.state.doc.lineAt(pos).to }) });
}

function ghostClear(view) {
  view.dispatch({ effects: clearGhostFx.of(null) });
}

// Accept ghost: insert suggestion text at ghost.pos, move cursor after it
function ghostAccept(view) {
  const ghost = view.state.field(ghostField);
  if (!ghost) return false;
  view.dispatch({
    changes:   { from: ghost.pos, insert: ghost.text },
    selection: { anchor: ghost.pos + ghost.text.length },
    effects:   clearGhostFx.of(null),
    userEvent: 'input.acceptGhost',
  });
  save();
  return true;
}

// ─── Slop review highlights ───────────────────────────────────────────────────

const setReviewFx = StateEffect.define();
const addReviewFx = StateEffect.define();
let reviewFindings = [];
let findingSeq = 0;

const slopMark = finding => Decoration.mark({
  class: 'cm-slop',
  attributes: {
    'data-slop-id': String(finding.id),
    title: `${finding.pattern}: ${finding.reason}`,
  },
}).range(finding.from, finding.to);

const reviewField = StateField.define({
  create: () => Decoration.none,
  update(decorations, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setReviewFx)) return Decoration.set(effect.value.map(slopMark), true);
      if (effect.is(addReviewFx)) return decorations.update({ add: effect.value.map(slopMark), sort: true });
    }
    if (!tr.docChanged) return decorations;
    // Edits elsewhere only shift a finding; edits inside one make its quote stale.
    const edited = [];
    tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => edited.push([fromB, toB]));
    return decorations.map(tr.changes).update({
      filter: (from, to) => !edited.some(([a, b]) => a < to && b > from),
    });
  },
  provide: field => EditorView.decorations.from(field),
});

// Live position of a finding — decorations move with the document, the
// from/to captured at review time do not.
function findingRange(id) {
  let found = null;
  workView.state.field(reviewField).between(0, workView.state.doc.length, (from, to, deco) => {
    if (deco.spec.attributes['data-slop-id'] === String(id)) { found = { from, to }; return false; }
  });
  return found;
}

function currentRanges() {
  const ranges = [];
  workView.state.field(reviewField).between(0, workView.state.doc.length, (from, to) => { ranges.push({ from, to }); });
  return ranges;
}

function syncReviewLabel() {
  const count = workView.state.field(reviewField).size;
  reviewButton.classList.toggle('has-findings', count > 0);
  reviewButton.textContent = count ? `${count} suggestion${count === 1 ? '' : 's'}` : 'Review';
}

function clearReview() {
  reviewFindings = [];
  checkedSentences.clear();
  workView.dispatch({ effects: setReviewFx.of([]) });
  syncReviewLabel();
}

// Anchor findings against the document as it is *now* and merge them in —
// the request may have been in flight while the writer kept typing.
function mergeFindings(rawFindings) {
  const located = locateFindings(workView.state.doc.toString(), rawFindings || [], currentRanges())
    .map(finding => ({ ...finding, id: findingSeq++ }));
  if (!located.length) return 0;
  reviewFindings.push(...located);
  workView.dispatch({ effects: addReviewFx.of(located) });
  return located.length;
}

async function reviewRequest(body) {
  const data = await api('/review', {
    method: 'POST',
    body: JSON.stringify({ agent: currentAgent(), ...body }),
  });
  return mergeFindings(data.findings);
}

async function runReview() {
  const document = workView.state.doc.toString();
  if (!document.trim()) { clearReview(); return; }
  reviewButton.disabled = true;
  reviewButton.textContent = 'Reviewing…';
  clearReview();
  try {
    const added = await reviewRequest({ document });
    // A full pass has now judged every finished sentence — don't re-spend on them.
    for (const sentence of completedSentences(workView.state.doc.toString())) {
      checkedSentences.add(sentence.text);
    }
    if (added) syncReviewLabel();
    else reviewButton.textContent = 'No slop found';
  } catch (error) {
    console.error('[/review]', error.message);
    reviewButton.textContent = 'Review failed';
  } finally {
    reviewButton.disabled = false;
  }
}

reviewButton.addEventListener('click', runReview);

// ─── Incremental review ────────────────────────────────────────────────────────
//
//  Every finished sentence is audited once, ~1.5 s after the writer stops
//  touching it. Sentences already judged are cached by text, so nothing is
//  paid for twice and the toolbar button stays as the "re-check everything"
//  escape hatch.
//
const AUTO_REVIEW_DELAY = 1500;
const AUTO_REVIEW_MIN   = 25;   // shorter sentences carry too little to judge
const AUTO_REVIEW_THRESHOLD = 20; // local style score below which a model call is not worth it

const checkedSentences = new Set();
let autoReviewTimer = null;
let autoReviewBusy  = false;

// Live local readout. Pure string work, so it can run on every keystroke.
function syncStyleScore() {
  const text = workView.state.doc.toString();
  const { score, structural } = styleScore(text);
  if (!text.trim() || !isLatinScript(text)) { scoreEl.textContent = ''; return; }
  scoreEl.textContent = `${score}`;
  scoreEl.title = structural
    ? `Local AI-tell score ${score}/100 (0 = clean). Computed in the browser, no model call.`
    : `Local AI-tell score ${score}/100, wording only — too short to judge rhythm or variety.`;
  scoreEl.classList.toggle('warn', score >= 40);
}

function autoReviewSchedule() {
  clearTimeout(autoReviewTimer);
  autoReviewTimer = setTimeout(autoReviewRun, AUTO_REVIEW_DELAY);
}

function autoReviewPending(state) {
  const cursor = state.selection.main.head;
  return completedSentences(state.doc.toString()).filter(sentence =>
    sentence.text.length >= AUTO_REVIEW_MIN &&
    !checkedSentences.has(sentence.text) &&
    // Strictly inside → the writer is still working on it. Resting at the
    // closing punctuation means the sentence is finished, so check it.
    !(cursor > sentence.from && cursor < sentence.to) &&
    worthReviewing(sentence.text));
}

// Cheap prefilter: a sentence with no known tell is not worth a model call.
// The word lists only cover Latin script, so a Cyrillic draft skips the filter
// and always goes to the model rather than silently reading as clean.
// The toolbar button stays the unfiltered pass over the whole document.
function worthReviewing(text) {
  if (!isLatinScript(text)) return true;
  return styleScore(text).score >= AUTO_REVIEW_THRESHOLD;
}

async function autoReviewRun() {
  if (autoReviewBusy || reviewButton.disabled) return;
  const pending = autoReviewPending(workView.state);
  if (!pending.length) return;

  autoReviewBusy = true;
  for (const sentence of pending) checkedSentences.add(sentence.text);
  try {
    if (await reviewRequest({
      document: workView.state.doc.toString(),
      target: pending.map(sentence => sentence.text).join('\n\n'),
    })) syncReviewLabel();
  } catch (error) {
    // Nothing to show the writer — let the next sentence try again.
    for (const sentence of pending) checkedSentences.delete(sentence.text);
    console.error('[/review auto]', error.message);
  } finally {
    autoReviewBusy = false;
  }
}

// ─── Suggestion system ─────────────────────────────────────────────────────────

let suggestTimer = null;
let suggestAbort = null;

const SUGGEST_DELAY = 900;  // ms after last keystroke
const SUGGEST_MIN   = 15;   // minimum doc length before suggesting

// Suggest only where the writer is actually writing forward: caret collapsed
// at the end of a line with nothing but blank space after it. Editing mid-text
// is what produced the off-topic continuations — the model never saw the tail.
function atParagraphEnd(state) {
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const line = state.doc.lineAt(sel.head);
  if (sel.head !== line.to) return false;
  if (line.number === state.doc.lines) return true;
  return state.doc.line(line.number + 1).text.trim() === '';
}

function suggestSchedule() {
  clearTimeout(suggestTimer);
  if (suggestAbort) { suggestAbort.abort(); suggestAbort = null; }

  const doc = workView.state.doc.toString();
  if (doc.trim().length < SUGGEST_MIN) return;
  if (!atParagraphEnd(workView.state)) return;

  suggestTimer = setTimeout(suggestFetch, SUGGEST_DELAY);
}

async function suggestFetch() {
  const view  = workView;
  const state = view.state;
  if (state.readOnly) return;
  if (!atParagraphEnd(state)) return;

  const doc = state.doc.toString();
  const pos = state.selection.main.head;

  // Don't suggest while on a /idea line
  const line = state.doc.lineAt(pos);
  if (/^\/idea/i.test(line.text)) return;

  suggestAbort = new AbortController();

  try {
    const res = await fetch('/suggest', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        document: doc,
        cursor:   pos,
        agent:    currentAgent(),
      }),
      signal: suggestAbort.signal,
    });
    if (!res.ok) { console.error('[suggest] server error', res.status); return; }

    const data = await res.json();

    // Veto rather than optimise: the model is never told about the word list,
    // so it cannot route around it. A continuation carrying a known tell is
    // simply dropped — showing nothing beats offering slop.
    if (data.suggestion && styleMetrics(data.suggestion).tells > 0) return;

    // Only show if nothing changed while we were waiting
    if (
      data.suggestion &&
      view.state.doc.toString() === doc &&
      view.state.selection.main.head === pos &&
      !view.state.readOnly
    ) {
      ghostShow(view, data.suggestion);
    }
  } catch (e) {
    if (e.name !== 'AbortError') console.error('[suggest]', e.message);
  }
}

// ─── Read-only compartment (blocks input during /idea streaming) ────────────────

const readonlyComp = new Compartment();

function editorSetReadonly(view, on) {
  view.dispatch({ effects: readonlyComp.reconfigure(EditorState.readOnly.of(on)) });
  view.dom.classList.toggle('streaming', on);
}

// ─── /idea command ─────────────────────────────────────────────────────────────

// Synchronous keymap handler — starts async work and returns true
function handleEnter(view) {
  const pos  = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  if (!/^\/idea(\s|$)/i.test(line.text)) return false; // not our line

  // Cancel any pending suggestion
  clearTimeout(suggestTimer);
  if (suggestAbort) { suggestAbort.abort(); suggestAbort = null; }
  ghostClear(view);

  runIdeaExpansion(view, line).catch(console.error);
  return true;
}

async function runIdeaExpansion(view, line) {
  const idea = line.text.slice('/idea'.length).trim();

  // Delete the /idea line content
  view.dispatch({
    changes:   { from: line.from, to: line.to, insert: '' },
    selection: { anchor: line.from },
  });

  editorSetReadonly(view, true);
  let insertPos = line.from;

  try {
    const res = await fetch('/idea', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        document: view.state.doc.toString(),
        idea,
        agent:    currentAgent(),
      }),
    });
    if (!res.ok) throw new Error(`Server error ${res.status}`);

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let   buf     = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();

      for (const rawLine of lines) {
        if (!rawLine.startsWith('data: ')) continue;
        const raw = rawLine.slice(6).trim();
        if (raw === '[DONE]') continue;
        let event;
        try { event = JSON.parse(raw); } catch { continue; }
        if (event.error) throw new Error(event.error);
        if (!event.text) continue;
        view.dispatch({
          changes:   { from: insertPos, insert: event.text },
          selection: { anchor: insertPos + event.text.length },
        });
        insertPos += event.text.length;
      }
    }
  } catch (err) {
    console.error('[/idea]', err);
    // Restore the /idea line on failure
    view.dispatch({
      changes:   { from: line.from, insert: `/idea ${idea}` },
      selection: { anchor: line.from + `/idea ${idea}`.length },
    });
  } finally {
    editorSetReadonly(view, false);
    view.focus();
    save();
  }
}

// ─── Chat ──────────────────────────────────────────────────────────────────────
//
//  One surface for everything the assistant says. The composer is pinned to the
//  bottom of the canvas and the stream grows upward above it; nothing is modal,
//  so the draft stays readable and editable while you decide.
//
//  Context attaches to the composer as a chip rather than opening a window:
//  right-click a selection, or click a slop underline, and the passage rides
//  along with whatever you type next.
//

const CHAT_PLACEHOLDER = 'Ask anything, or select text to rewrite';
const DELTA_MATERIAL = 5;  // score move below which the delta is not worth colouring

let attached = null;   // { from, to, text } — the passage the chip refers to
let activeFinding = null;
let chatHistory = [];  // { role, content } sent to /chat
let chatAbort = null;

function chatEl(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Follow the stream only when the reader is already at the bottom. Yanking
// them down mid-sentence while they scroll back is the classic chat sin.
const chatAtBottom = () =>
  chatStream.scrollHeight - chatStream.scrollTop - chatStream.clientHeight < 48;

function chatScroll(stick) {
  if (stick) chatStream.scrollTop = chatStream.scrollHeight;
}

function chatAdd(node) {
  const stick = chatAtBottom();
  chatStream.append(node);
  chatScroll(stick);
  chatClear.hidden = false;
  return node;
}

// ── Attached passage ──

function attach(range, finding = null) {
  attached = range;
  activeFinding = finding;
  chatChip.classList.remove('hidden');
  chatChipText.textContent = range.text;
  chatChipText.title = range.text;
  chatInput.placeholder = 'Describe the change';
  chatInput.focus();
}

function detach() {
  attached = null;
  activeFinding = null;
  chatChip.classList.add('hidden');
  chatInput.placeholder = CHAT_PLACEHOLDER;
}

// The chip holds a snapshot; the decoration holds the live position. Re-read it
// so an edit made while the chat was open does not misplace the replacement.
function attachedRange() {
  if (!attached) return null;
  if (!activeFinding) return attached;
  return findingRange(activeFinding.id) ?? attached;
}

function applyText(text, card) {
  const range = attachedRange();
  if (!range) return;
  workView.dispatch({
    changes:   { from: range.from, to: range.to, insert: text },
    selection: { anchor: range.from + text.length },
  });
  workView.focus();
  save();
  detach();
  // The siblings now point at a range that no longer exists. Retire the whole
  // group so it stops advertising a click that would silently do nothing.
  card?.classList.add('is-applied');
  card?.parentElement?.classList.add('is-spent');
}

// ── Cards ──

function findingCard(finding) {
  const card = chatEl('div', 'chat-card');
  card.append(
    chatEl('strong', '', finding.pattern),
    chatEl('span', '', finding.reason),
    chatEl('small', '', finding.fix),
  );
  return card;
}

function variantCards(variants) {
  const doc = workView.state.doc.toString();
  const range = attachedRange();
  const measurable = isLatinScript(doc) && range;
  const base = measurable ? styleScore(doc).score : null;

  // Rank what the model already produced — the score is never fed to the model,
  // or it would optimise the word list instead of the writing.
  const scored = variants.map(text => ({
    text,
    score: measurable
      ? styleScore(doc.slice(0, range.from) + text + doc.slice(range.to)).score
      : null,
  }));
  if (measurable) scored.sort((a, b) => a.score - b.score);

  const wrap = chatEl('div', 'chat-variants');
  scored.forEach(({ text, score }, index) => {
    const card = chatEl('div', 'variant-card');
    const label = chatEl('div', 'variant-label', `Option ${index + 1}`);
    if (score !== null) {
      // Colour only a material move. On an already-clean draft every variant
      // nudges the score a point or two, and painting that red reads as
      // "all options are bad" when nothing is wrong.
      const move = score - base;
      const tone = move <= -DELTA_MATERIAL ? ' is-better' : move >= DELTA_MATERIAL ? ' is-worse' : '';
      const delta = chatEl('span', `variant-delta${tone}`, `${base} → ${score}`);
      delta.title = 'Local AI-tell score for the whole draft if you pick this variant';
      label.append(delta);
    }
    card.append(label, chatEl('div', '', text));
    card.addEventListener('click', () => { if (!wrap.classList.contains('is-spent')) applyText(text, card); });
    wrap.append(card);
  });
  return wrap;
}

function skeletonCards(count = 3) {
  const wrap = chatEl('div', 'chat-variants');
  for (let i = 0; i < count; i++) {
    const card = chatEl('div', 'variant-card is-loading');
    card.setAttribute('aria-busy', 'true');
    card.append(
      chatEl('div', 'skeleton skeleton-label'),
      chatEl('div', 'skeleton skeleton-line'),
      chatEl('div', 'skeleton skeleton-line is-short'),
    );
    wrap.append(card);
  }
  return wrap;
}

// ── Rewrite ──

async function requestVariants(instruction) {
  const range = attachedRange();
  if (!range) return;
  const placeholder = chatAdd(skeletonCards());

  chatAbort?.abort();
  chatAbort = new AbortController();
  try {
    const res = await fetch('/rewrite', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      signal:  chatAbort.signal,
      body:    JSON.stringify({
        document:    workView.state.doc.toString(),
        selected:    range.text,
        instruction,
        agent:       currentAgent(),
      }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `Server error ${res.status}`);
    const stick = chatAtBottom();
    placeholder.replaceWith(variantCards(data.variants));
    chatScroll(stick);
  } catch (error) {
    if (error.name === 'AbortError') { placeholder.remove(); return; }
    console.error('[/rewrite]', error);
    placeholder.replaceWith(chatEl('div', 'chat-error', error.message));
  }
}

// A finding already states what to fix, so the variants can be on their way
// before the writer types anything.
function openFinding(finding) {
  const range = findingRange(finding.id);
  if (!range) return;
  attach({ ...range, text: workView.state.sliceDoc(range.from, range.to) }, finding);
  workView.dispatch({ selection: { anchor: range.from, head: range.to } });
  chatAdd(findingCard(finding));
  requestVariants(
    `Fix ${finding.pattern}: ${finding.fix.replace(/\.?$/, '.')} ` +
    'Preserve facts, voice, and specific details; add no new claims.',
  );
}

// ── Conversation ──

async function chatSend() {
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';
  chatResize();
  chatAdd(chatEl('div', 'chat-message is-user', text));

  // With a passage attached, "rewrite it" is the overwhelmingly common intent,
  // and variants are directly applicable where a paragraph of prose is not.
  if (attached) { requestVariants(text); return; }

  chatHistory.push({ role: 'user', content: text });
  const reply = chatAdd(chatEl('div', 'chat-message is-agent'));
  reply.append(chatEl('span', 'chat-caret'));

  chatAbort?.abort();
  chatAbort = new AbortController();
  let answer = '';
  try {
    const res = await fetch('/chat', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      signal:  chatAbort.signal,
      body:    JSON.stringify({
        messages: chatHistory,
        document: workView.state.doc.toString(),
        agent:    currentAgent(),
      }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Server error ${res.status}`);

    for await (const chunk of sseChunks(res)) {
      if (chunk.error) throw new Error(chunk.error);
      const stick = chatAtBottom();
      answer += chunk.text ?? '';
      reply.textContent = answer;
      chatScroll(stick);
    }
    // Rendered once at the end: half-typed syntax mid-stream would flicker
    // between literal asterisks and formatting on every token.
    reply.classList.add('is-markdown');
    reply.innerHTML = renderMarkdown(answer);
    chatHistory.push({ role: 'assistant', content: answer });
  } catch (error) {
    if (error.name === 'AbortError') { reply.remove(); return; }
    console.error('[/chat]', error);
    reply.replaceWith(chatEl('div', 'chat-error', error.message));
  }
}

async function* sseChunks(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6);
      if (payload === '[DONE]') return;
      try { yield JSON.parse(payload); } catch {}
    }
  }
}

// ── Composer ──

function chatResize() {
  chatInput.style.height = 'auto';
  chatInput.style.height = `${Math.min(chatInput.scrollHeight, 160)}px`;
}

chatInput.placeholder = CHAT_PLACEHOLDER;
chatInput.addEventListener('input', chatResize);

chatInput.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); chatSend(); }
  else if (event.key === 'Escape') {
    if (chatAbort && !chatAbort.signal.aborted) { chatAbort.abort(); return; }
    detach();
    workView.focus();
  }
});

chatChipClear.addEventListener('click', () => { detach(); chatInput.focus(); });

chatClear.addEventListener('click', () => {
  chatAbort?.abort();
  chatStream.replaceChildren();
  chatHistory = [];
  chatClear.hidden = true;
  detach();
  chatInput.focus();
});

// Cmd/Ctrl+K from anywhere: take the current selection into the composer.
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    const sel = workView.state.selection.main;
    if (!sel.empty) attach({ from: sel.from, to: sel.to, text: workView.state.sliceDoc(sel.from, sel.to) });
    else chatInput.focus();
  }
});

// ─── Editor theme (injected into <head> by CM6) ─────────────────────────────────

const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

const editorTheme = EditorView.theme({
  // Root element — fills the #editor-wrapper flex container
  '&': {
    height:     '100%',
    background: 'var(--surface)',
  },

  // Remove the focus ring CM6 adds by default
  '&.cm-focused': {
    outline: 'none',
  },

  // Scrollable area — inherits the writing font
  '.cm-scroller': {
    fontFamily: 'var(--font)',
    fontSize:   '15px',
    lineHeight: '1.8',
    overflowY:  'auto',
  },

  // Editable content area — generous padding, centred like the old textarea
  '.cm-content': {
    padding:    '28px max(32px, calc((100% - 620px) / 2))',
    caretColor: 'var(--accent)',
    color:      'var(--text)',
    minHeight:  '100%',
  },

  // Each line — no extra horizontal padding (already on .cm-content)
  '.cm-line': { padding: '0' },

  // Cursor
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--accent)',
    borderLeftWidth: '2px',
  },

  // Selection highlight
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    background: isDark
      ? 'rgba(122, 160, 197, 0.25) !important'
      : 'rgba(91, 127, 165, 0.2) !important',
  },

  // ── Suggestion panel ───────────────────────────────────────────────────────
  //
  //  A block widget below the current line, never inside the writer's own
  //  sentence — nothing is added to the document until Tab is pressed.
  //  Tab accepts, Escape dismisses.
  //
  '.cm-suggest': {
    display:       'flex',
    alignItems:    'baseline',
    gap:           '10px',
    margin:        '6px 0 2px',
    padding:       '8px 12px',
    borderLeft:    '2px solid var(--accent)',
    borderRadius:  '0 var(--r-sm) var(--r-sm) 0',
    background:    'var(--surface-2)',
    color:         'var(--text-2)',
    pointerEvents: 'none',
    userSelect:    'none',
  },

  '.cm-suggest-text': { flex: '1' },

  '.cm-suggest-hint': {
    flexShrink:    '0',
    padding:       '1px 6px',
    borderRadius:  'var(--r-xs)',
    background:    'var(--surface-3)',
    color:         'var(--muted)',
    fontFamily:    'var(--ui-font)',
    fontSize:      '11px',
    letterSpacing: '.02em',
  },

  '.cm-slop': {
    textDecorationLine: 'underline',
    textDecorationStyle: 'wavy',
    textDecorationColor: 'var(--accent)',
    textUnderlineOffset: '3px',
    cursor: 'pointer',
  },

  // Slightly dim the content while /idea is streaming
  '&.streaming .cm-content': { opacity: '0.8' },

  // Placeholder text (shown when doc is empty)
  '.cm-placeholder': {
    color:    'var(--muted)',
    opacity:  '0.5',
  },

  // Hide gutters and fold markers — this is a prose editor
  '.cm-gutters': { display: 'none' },
}, { dark: isDark });

// ─── Editor setup ──────────────────────────────────────────────────────────────

const workView = new EditorView({
  state: EditorState.create({
    doc: localStorage.getItem('wa-working') || '',

    extensions: [
      // Undo/redo
      history(),

      // ── Keymaps (highest priority first) ──────────────────────────────────
      //
      //  Prec.high ensures our handlers are tried before defaultKeymap.
      //  Each run() must return true (handled) or false (pass through).
      //
      Prec.high(keymap.of([
        {
          // Tab: accept ghost suggestion if one is showing;
          //      otherwise swallow (no tab characters in prose).
          key: 'Tab',
          run(view) {
            if (ghostAccept(view)) return true;
            return true; // swallow Tab in prose
          },
        },
        {
          // Escape: dismiss ghost suggestion.
          key: 'Escape',
          run(view) {
            const ghost = view.state.field(ghostField);
            if (!ghost) return false; // pass through to simplifySelection etc.
            ghostClear(view);
            clearTimeout(suggestTimer);
            return true;
          },
        },
        {
          // Enter: handle /idea command; otherwise pass through.
          key: 'Enter',
          run: handleEnter,
        },
      ])),

      // Standard text-editing and history keymaps
      keymap.of([...historyKeymap, ...defaultKeymap]),

      // Ghost text state + decoration provider
      ghostField,
      reviewField,

      // Read-only compartment — toggled during /idea streaming
      readonlyComp.of(EditorState.readOnly.of(false)),

      // Word wrap (essential for prose)
      EditorView.lineWrapping,

      // Placeholder shown when document is empty
      placeholder('Start writing...'),

      // Visual theme
      editorTheme,

      // Both gestures attach the passage to the composer instead of opening a
      // window — one place for context, one place for answers.
      EditorView.domEventHandlers({
        click(event, view) {
          const mark = event.target.closest?.('.cm-slop');
          if (!mark) return false;
          const finding = reviewFindings.find(item => item.id === Number(mark.dataset.slopId));
          if (!finding) return false;
          openFinding(finding);
          return true;
        },
        contextmenu(event, view) {
          const sel = view.state.selection.main;
          if (sel.empty) return false; // no selection — show native menu
          event.preventDefault();
          attach({ from: sel.from, to: sel.to, text: view.state.sliceDoc(sel.from, sel.to) });
          return true;
        },
      }),

      // Save on every edit + schedule a suggestion
      EditorView.updateListener.of(update => {
        if (update.docChanged) {
          if (reviewFindings.length) syncReviewLabel();
          save();
          suggestSchedule();
          autoReviewSchedule();
          syncStyleScore();
        }
      }),
    ],
  }),

  parent: editorWrap,
});

// ─── Persist ───────────────────────────────────────────────────────────────────

function save() {
  localStorage.setItem('wa-working', workView.state.doc.toString());
}

// ─── Initial focus ─────────────────────────────────────────────────────────────

workView.focus();
syncStyleScore();
