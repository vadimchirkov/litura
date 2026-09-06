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
const chatSendButton = document.getElementById('chat-send');
const chatClear     = document.getElementById('chat-clear');
const scoreEl       = document.getElementById('style-score');
const chatPanel     = document.getElementById('chat');
const autoReviewEl  = document.getElementById('auto-review');

// How much of the editor the floating panel covers. Measured, because the
// panel grows with its content: a fixed guess leaves the line being typed —
// and the suggestion under it — hidden behind the cards.
let chatHeight = 140;

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

async function openSettings() {
  settingsError.textContent = '';
  try { await refreshAgent(); } catch (error) { settingsError.textContent = error.message; }
  draftSelection = currentAgent();
  renderModelSettings();
  renderCredentials();
  if (!settingsDialog.open) settingsDialog.showModal();
}

settingsOpen.addEventListener('click', openSettings);

// Without a model every AI action fails in the console and the editor just
// looks broken. Send the writer to the one place that fixes it instead.
async function ensureAgent() {
  if (currentAgent()) return true;
  // The status call may still be in flight on a fresh load — ask once more
  // before telling the writer their setup is missing.
  try { await refreshAgent(); } catch {}
  if (currentAgent()) return true;
  chatAdd(chatEl('div', 'chat-error', 'No model selected — add an API key or pick a model in settings.'));
  openSettings();
  return false;
}

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
  const line = view.state.doc.lineAt(pos).to;
  view.dispatch({
    // The panel is a block below the line, so reserve its own height on top of
    // the strip the chat already covers — otherwise it opens out of sight.
    effects: [setGhostFx.of({ text, pos, line }), EditorView.scrollIntoView(line, { y: 'nearest', yMargin: 72 })],
  });
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
const dropReviewFx = StateEffect.define();  // one finding the writer disagreed with
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
      if (effect.is(dropReviewFx)) return decorations.update({
        filter: (_from, _to, deco) => deco.spec.attributes['data-slop-id'] !== String(effect.value),
      });
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

// ─── Attached passage highlight ───────────────────────────────────────────────
//
//  A native selection greys out the moment the composer takes focus, which is
//  exactly when the writer needs to see what they attached. This mark does not.
//
const setAttachFx = StateEffect.define();

const attachField = StateField.define({
  create: () => Decoration.none,
  update(decorations, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setAttachFx)) {
        return effect.value
          ? Decoration.set([Decoration.mark({ class: 'cm-attached' }).range(effect.value.from, effect.value.to)])
          : Decoration.none;
      }
    }
    if (!tr.docChanged) return decorations;
    // Rewriting the passage by hand ends the attachment: variants generated for
    // the old wording must not be offered against the new one.
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
  reviewButton.title = count
    ? 'Jump to the next finding — Shift-click to review again'
    : 'Review writing and structure';
}

// On anything longer than a screen the underlines are not navigation: the
// counter has to take the writer to the next one.
let jumpFrom = -1;

function jumpToNextFinding() {
  const ranges = currentRanges();
  if (!ranges.length) return;
  const next = ranges.find(range => range.from > jumpFrom) ?? ranges[0];
  jumpFrom = next.from;
  workView.dispatch({
    selection: { anchor: next.from, head: next.to },
    effects: EditorView.scrollIntoView(next.from, { y: 'center' }),
  });
  workView.focus();
}

// Disagreeing with a finding has to be as cheap as accepting one, or the
// counter keeps advertising work the writer already rejected.
function dismissFinding(id) {
  reviewFindings = reviewFindings.filter(finding => finding.id !== id);
  workView.dispatch({ effects: dropReviewFx.of(id) });
  if (activeFinding?.id === id) detach();
  saveFindings();
  syncReviewLabel();
}

// A full review costs two model calls. Losing it to a reload is the writer
// paying twice for the same answer, so the findings outlive the page.
function saveFindings() {
  const live = reviewFindings
    .filter(finding => findingRange(finding.id))
    .map(({ code, quote, pattern, reason, fix }) => ({ code, quote, pattern, reason, fix }));
  localStorage.setItem('wa-findings', JSON.stringify(live));
}

function restoreFindings() {
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem('wa-findings') || '[]'); } catch {}
  if (saved.length && mergeFindings(saved)) syncReviewLabel();
}

function clearReview() {
  reviewFindings = [];
  checkedSentences.clear();
  workView.dispatch({ effects: setReviewFx.of([]) });
  localStorage.removeItem('wa-findings');
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
  saveFindings();
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
  if (!await ensureAgent()) return;
  jumpFrom = -1;
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

reviewButton.addEventListener('click', event => {
  if (workView.state.field(reviewField).size && !event.shiftKey) jumpToNextFinding();
  else runReview();
});

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

// Every pause costs a model call, so this has to be switchable — and visible
// while it runs, or the writer cannot tell what they are paying for.
let autoReviewOn = localStorage.getItem('wa-autoreview') !== 'off';
autoReviewEl.checked = autoReviewOn;
autoReviewEl.addEventListener('change', () => {
  autoReviewOn = autoReviewEl.checked;
  localStorage.setItem('wa-autoreview', autoReviewOn ? 'on' : 'off');
});

// Live local readout. Pure string work, so it can run on every keystroke.
function syncStyleScore() {
  const text = workView.state.doc.toString();
  const { score, structural } = styleScore(text);
  if (!text.trim() || !isLatinScript(text)) { scoreEl.textContent = ''; return; }
  scoreEl.textContent = `${score}`;
  scoreEl.title = structural
    ? `Local AI-tell score ${score}/100 (0 = clean). Click to see what raised it.`
    : `Local AI-tell score ${score}/100, wording only — too short to judge rhythm or variety. Click for detail.`;
  scoreEl.classList.toggle('warn', score >= 40);
}

// A bare number in the header is something to argue with. Clicking it shows
// what produced it — the matched words are in the writer's own draft.
function showScoreCard() {
  const text = workView.state.doc.toString();
  if (!text.trim() || !isLatinScript(text)) return;
  const { score, hits, burstiness, diversity, repetition, structural } = styleScore(text);
  const notes = [];
  if (structural) {
    if (burstiness < 0.45) notes.push('Sentence lengths are evenly matched — vary them.');
    if (diversity < 0.5) notes.push('Vocabulary repeats within a short window.');
    if (repetition > 0.05) notes.push('Some three-word sequences repeat.');
  } else {
    notes.push('Too short to judge rhythm or variety — wording only.');
  }
  const card = chatEl('div', 'chat-card');
  card.append(
    chatEl('strong', '', `Local score ${score}/100`),
    chatEl('span', '', hits.length
      ? `Known tells: ${hits.join(', ')}`
      : 'No known tell words or phrases.'),
    chatEl('small', '', notes.join(' ') || 'Rhythm and variety read as human.'),
  );
  chatAdd(card);
}

scoreEl.addEventListener('click', showScoreCard);

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
  if (!autoReviewOn || autoReviewBusy || reviewButton.disabled || !currentAgent()) return;
  const pending = autoReviewPending(workView.state);
  if (!pending.length) return;

  autoReviewBusy = true;
  reviewButton.classList.add('is-busy');
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
    reviewButton.classList.remove('is-busy');
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
  if (state.readOnly || !currentAgent()) return;
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
// { role, content, display? } — `content` goes to the model, `display` is what
// the writer typed when the two differ (a finding adds context to the message).
let chatHistory = [];
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

// Only the conversation survives a reload — cards point at document ranges
// that the restored findings re-anchor for themselves.
function saveChat() {
  localStorage.setItem('wa-chat', JSON.stringify(chatHistory.slice(-20)));
}

function restoreChat() {
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem('wa-chat') || '[]'); } catch {}
  if (!Array.isArray(saved) || !saved.length) return;
  chatHistory = saved;
  for (const message of saved) {
    if (message.role === 'user') {
      chatAdd(chatEl('div', 'chat-message is-user', message.display ?? message.content));
    } else {
      const node = chatEl('div', 'chat-message is-agent is-markdown');
      node.innerHTML = renderMarkdown(message.content);
      chatAdd(node);
    }
  }
}

function chatAdd(node) {
  const stick = chatAtBottom();
  chatStream.append(node);
  chatScroll(stick);
  chatClear.hidden = false;
  return node;
}

// ── Attached passage ──

// The passage stays where the writer is looking — highlighted in the draft.
// Copying it into the composer duplicated the sentence they were reading and
// pushed the answer off screen.
// Cmd+K and the context menu are requests to instruct, so they hand over the
// keyboard. Clicking an underline is not: the writer may just as well be
// putting the caret there to fix the sentence themselves.
function attach(range, finding = null, focusComposer = true) {
  attached = range;
  activeFinding = finding;
  chatChip.classList.remove('hidden');
  chatChipText.textContent = finding?.pattern ?? 'Selected text';
  workView.dispatch({ effects: setAttachFx.of({ from: range.from, to: range.to }) });
  chatInput.placeholder = 'Describe the change';
  if (focusComposer) chatInput.focus();
}

function detach() {
  attached = null;
  activeFinding = null;
  chatChip.classList.add('hidden');
  chatInput.placeholder = CHAT_PLACEHOLDER;
  workView.dispatch({ effects: setAttachFx.of(null) });
}

// The chip holds a snapshot; the decoration holds the live position. Re-read it
// so an edit made while the chat was open does not misplace the replacement.
function attachedRange() {
  if (!attached) return null;
  // A structural fix is attached to the whole paragraph, not to the underlined
  // quote inside it — following the underline would replace the wrong span.
  if (!activeFinding || attached.fixed) return attached;
  return findingRange(activeFinding.id) ?? attached;
}

// The blank-line-delimited block around a position. Structural findings quote
// one sentence but name a problem with the paragraph it sits in.
function paragraphAround(state, from, to) {
  let first = state.doc.lineAt(from).number;
  let last  = state.doc.lineAt(to).number;
  while (first > 1 && state.doc.line(first - 1).text.trim()) first--;
  while (last < state.doc.lines && state.doc.line(last + 1).text.trim()) last++;
  const range = { from: state.doc.line(first).from, to: state.doc.line(last).to };
  return { ...range, text: state.sliceDoc(range.from, range.to), fixed: true };
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

function findingCard(finding, instruction) {
  const card = chatEl('div', 'chat-card');
  const dismiss = chatEl('button', 'chat-card-dismiss', '×');
  dismiss.type = 'button';
  dismiss.title = 'Dismiss this finding';
  dismiss.setAttribute('aria-label', 'Dismiss this finding');
  dismiss.addEventListener('click', () => {
    chatAbort?.abort();  // in-flight variants for a dismissed finding are waste
    dismissFinding(finding.id);
    if (card.nextElementSibling?.classList.contains('chat-variants')) card.nextElementSibling.remove();
    card.remove();
  });
  card.append(
    dismiss,
    chatEl('strong', '', finding.pattern),
    chatEl('span', '', finding.reason),
    chatEl('small', '', finding.fix),
  );

  // Alternatives are offered, not spent on a click. Reading the remark and
  // fixing the sentence yourself is a complete outcome.
  const offer = chatEl('button', 'chat-offer', 'Offer rewrites');
  offer.type = 'button';
  offer.addEventListener('click', () => {
    offer.remove();  // retries live on the variants group as Try again
    if (activeFinding?.id !== finding.id) openFinding(finding);
    requestVariants(instruction);
  });
  card.append(offer);
  return card;
}

function variantCards(variants, instruction) {
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

  // Three options none of which fit is otherwise a dead end — the passage is
  // still attached, so ask again with the same instruction.
  const again = chatEl('button', 'chat-again', 'Try again');
  again.type = 'button';
  again.addEventListener('click', () => {
    if (wrap.classList.contains('is-spent')) return;
    wrap.remove();
    requestVariants(instruction);
  });
  wrap.append(again);
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
  if (!range) {
    chatAdd(chatEl('div', 'chat-error', 'That passage is no longer attached — select it again.'));
    return;
  }
  if (!await ensureAgent()) return;
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
        from:        range.from,   // exact span, so the server marks the right occurrence
        instruction,
        agent:       currentAgent(),
      }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `Server error ${res.status}`);
    const stick = chatAtBottom();
    placeholder.replaceWith(variantCards(data.variants, instruction));
    chatScroll(stick);
  } catch (error) {
    if (error.name === 'AbortError') { placeholder.remove(); return; }
    console.error('[/rewrite]', error);
    placeholder.replaceWith(chatEl('div', 'chat-error', error.message));
  }
}

// A prose fix replaces the quote. A structural fix is about the paragraph the
// quote sits in, so that is what gets attached and rewritten — the chat stays
// available for the cases that need material moved between paragraphs.
const findingCards = new Map();  // finding id → its card, while it is on screen

function openFinding(finding) {
  const range = findingRange(finding.id);
  if (!range) return;
  const structural = finding.code?.startsWith('level-');
  const scope = structural
    ? paragraphAround(workView.state, range.from, range.to)
    : { ...range, text: workView.state.sliceDoc(range.from, range.to) };
  attach(scope, finding, false);
  // The attach mark already shows the span; a selection on top of it would
  // just be a second, duller highlight.
  workView.dispatch({ effects: EditorView.scrollIntoView(scope.from, { y: 'center' }) });
  if (structural) chatInput.placeholder = 'Ask how to revise this part';

  // Clicking the same underline again is navigation, not a new remark: return
  // to the card that is already in the stream instead of stacking a copy.
  if (findingCards.get(finding.id)?.isConnected) { chatScroll(true); return; }

  const instruction = structural
    ? `Rewrite this whole paragraph to fix ${finding.pattern}: ${finding.fix.replace(/\.?$/, '.')} ` +
      'You may reorder and rejoin its sentences. Keep every fact, the level of detail, ' +
      'and the author\'s voice; add no new claims.'
    : `Fix ${finding.pattern}: ${finding.fix.replace(/\.?$/, '.')} ` +
      'Preserve facts, voice, and specific details; add no new claims.';

  findingCards.set(finding.id, chatAdd(findingCard(finding, instruction)));
}

// ── Conversation ──

async function chatSend() {
  const text = chatInput.value.trim();
  if (!text) return;
  if (!await ensureAgent()) return;
  chatInput.value = '';
  chatResize();
  chatAdd(chatEl('div', 'chat-message is-user', text));

  // With a passage attached, "rewrite it" is the overwhelmingly common intent,
  // and variants are directly applicable where a paragraph of prose is not.
  if (attached && !activeFinding?.code?.startsWith('level-')) { requestVariants(text); return; }

  chatHistory.push(attached && activeFinding
    ? {
        role: 'user',
        content: `${text}\n\nFinding: ${activeFinding.pattern}\nQuoted passage: ${attached.text}\nEditing direction: ${activeFinding.fix}`,
        display: text,
      }
    : { role: 'user', content: text });
  saveChat();
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
        messages: chatHistory.map(({ role, content }) => ({ role, content })),
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
    saveChat();
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
  chatSendButton.disabled = !chatInput.value.trim();
}

chatSendButton.addEventListener('click', () => { chatSend(); chatInput.focus(); });

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
  localStorage.removeItem('wa-chat');
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
    // Sits between two lines of the writer's own prose — it has to read as a
    // panel on top of the draft, not as another paragraph of it.
    border:        '1px solid var(--border)',
    borderLeft:    '2px solid var(--accent)',
    borderRadius:  '0 var(--r-sm) var(--r-sm) 0',
    background:    'var(--overlay)',
    boxShadow:     'var(--shadow-md)',
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

  // The attached passage. Survives losing focus, unlike a native selection.
  '.cm-attached': {
    background: 'color-mix(in srgb, var(--accent) 18%, transparent)',
    borderRadius: '3px',
    boxShadow: '0 0 0 2px color-mix(in srgb, var(--accent) 18%, transparent)',
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
      attachField,

      // Read-only compartment — toggled during /idea streaming
      readonlyComp.of(EditorState.readOnly.of(false)),

      // Word wrap (essential for prose)
      EditorView.lineWrapping,

      // Reserve the covered strip so CodeMirror scrolls the caret above the
      // panel instead of under it.
      EditorView.scrollMargins.of(() => ({ bottom: chatHeight })),

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
          // Do not swallow the click: the caret still lands where the writer
          // clicked, so an underlined sentence stays as editable as any other.
          openFinding(finding);
          return false;
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
          // Typing inside the attached passage is the writer fixing it
          // themselves — drop the attachment rather than let a rewrite land on
          // top of the edit. Deferred: a dispatch inside an update is illegal.
          if (attached && update.state.field(attachField).size === 0) {
            queueMicrotask(() => { chatAbort?.abort(); detach(); });
          }
          if (reviewFindings.length) { syncReviewLabel(); saveFindings(); }
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

new ResizeObserver(() => {
  // Panel height + its 20px offset from the bottom + a line of breathing room.
  chatHeight = Math.round(chatPanel.getBoundingClientRect().height) + 48;
  document.documentElement.style.setProperty('--chat-height', `${chatHeight}px`);
  workView.dispatch({
    effects: EditorView.scrollIntoView(workView.state.selection.main.head, { y: 'nearest' }),
  });
}).observe(chatPanel);

//  Two copies, one direction. localStorage is the working state — instant,
//  synchronous, always authoritative for this browser. draft.md is the durable
//  mirror: it survives cleared browser data, backs up, and opens in any editor.
//  The file is read back only when localStorage is empty, so there is never a
//  conflict to resolve.
let diskTimer = null;
let diskText = null;   // what the file held when we last read or wrote it

function saveToDisk() {
  clearTimeout(diskTimer);
  diskTimer = setTimeout(() => {
    const text = workView.state.doc.toString();
    fetch('/draft', {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text }),
    }).then(() => { diskText = text; })
      .catch(error => console.error('[/draft]', error.message));
  }, 800);
}

function save() {
  localStorage.setItem('wa-working', workView.state.doc.toString());
  saveToDisk();
}

function loadFromDisk(text) {
  workView.dispatch({ changes: { from: 0, to: workView.state.doc.length, insert: text } });
  clearReview();
}

let driftAtStartup = null;

api('/draft').then(({ text }) => {
  diskText = text;
  if (!localStorage.getItem('wa-working')) { if (text) loadFromDisk(text); return; }
  // Both copies exist and differ: the file was edited elsewhere. Ask before
  // the first autosave of the session overwrites it.
  if (text && text !== workView.state.doc.toString()) driftAtStartup = text;
  else saveToDisk();
}).catch(error => console.error('[/draft]', error.message))
  .finally(() => {
    restoreFindings();
    restoreChat();
    // After the restored conversation, so the newest card is still last.
    if (driftAtStartup) promptDiskDrift(driftAtStartup);
  });

// Nothing is reconciled silently: the writer is told and decides, and only when
// the two copies actually differ.
let diskPrompt = null;

function promptDiskDrift(text) {
  const note = chatEl('div', 'chat-card');
  const load = chatEl('button', 'chat-again', 'Load from disk');
  load.type = 'button';
  load.addEventListener('click', () => { loadFromDisk(text); save(); note.remove(); });
  note.append(
    chatEl('strong', '', 'draft.md changed outside Litura'),
    chatEl('span', '', 'Loading it replaces the draft in this window; keeping this draft overwrites the file on your next edit.'),
    load,
  );
  diskPrompt = chatAdd(note);
}

async function checkDiskDrift() {
  if (diskPrompt?.isConnected) return;
  try {
    const { text } = await api('/draft');
    if (text === diskText || text === workView.state.doc.toString()) return;
    diskText = text;
    promptDiskDrift(text);
  } catch (error) { console.error('[/draft]', error.message); }
}

window.addEventListener('focus', checkDiskDrift);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkDiskDrift(); });

// ─── Export and import ─────────────────────────────────────────────────────────
//
//  The mirror file is fixed; these two are how a draft leaves or enters the app
//  under any other name.
//
document.addEventListener('keydown', event => {
  if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return;
  event.preventDefault();
  const url = URL.createObjectURL(new Blob([workView.state.doc.toString()], { type: 'text/markdown' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'draft.md';
  link.click();
  URL.revokeObjectURL(url);
});

editorWrap.addEventListener('dragover', event => event.preventDefault());

editorWrap.addEventListener('drop', async event => {
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  event.preventDefault();
  const text = await file.text();
  // Replacing a draft the writer cannot get back is worth one question.
  if (workView.state.doc.length && !confirm(`Replace the current draft with ${file.name}?`)) return;
  loadFromDisk(text);
  save();
});

// ─── Initial focus ─────────────────────────────────────────────────────────────

workView.focus();
syncStyleScore();
