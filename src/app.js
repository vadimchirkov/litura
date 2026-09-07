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
import { isLatinScript, locateFindings, styleScore } from '../review.js';
import { renderMarkdown } from '../markdown.js';
import { replacementTarget, newerVersion, wordDiff } from '../editing.js';
import { searchKeymap } from '@codemirror/search';

// ─── Elements ──────────────────────────────────────────────────────────────────

const editorWrap    = document.getElementById('editor-wrapper');
const settingsOpen  = document.getElementById('settings-open');
const settingsDialog = document.getElementById('settings-dialog');
const providerEl    = document.getElementById('agent-provider');
const modelEl       = document.getElementById('agent-model');
const thinkingEl    = document.getElementById('agent-thinking');
const keyProviderEl = document.getElementById('key-provider');
const apiKeyEl      = document.getElementById('api-key');
const keyAddEl      = document.getElementById('key-add');
const configuredKeys = document.getElementById('configured-keys');
const settingsError = document.getElementById('settings-error');
const modelHint     = document.getElementById('model-hint');
const reviewButton  = document.getElementById('review-button');
const chatStream    = document.getElementById('chat-stream');
const chatInput     = document.getElementById('chat-input');
const chatChip      = document.getElementById('chat-chip');
const chatChipText  = document.getElementById('chat-chip-text');
const chatChipClear = document.getElementById('chat-chip-clear');
const chatSendButton = document.getElementById('chat-send');
const chatClear     = document.getElementById('chat-clear');
const scoreEl       = document.getElementById('style-score');
const scoreValueEl  = document.getElementById('style-score-value');
const chatPanel     = document.getElementById('chat');
const autoReviewEl  = document.getElementById('auto-review');
const updateCheckEl = document.getElementById('update-check');
const themeToggleEl = document.getElementById('theme-toggle');
const updateBadge   = document.getElementById('update-badge');
const updateStatus  = document.getElementById('update-status');

const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
const savedTheme = localStorage.getItem('wa-theme');
let currentTheme = savedTheme === 'dark' || savedTheme === 'light'
  ? savedTheme
  : (systemTheme.matches ? 'dark' : 'light');
function setTheme(theme, persist = true) {
  currentTheme = theme;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  themeToggleEl.checked = theme === 'dark';
  if (persist) localStorage.setItem('wa-theme', theme);
}
setTheme(currentTheme, false);
themeToggleEl.addEventListener('change', () => setTheme(themeToggleEl.checked ? 'dark' : 'light'));

// How much of the editor the floating panel covers. Measured, because the
// panel grows with its content: a fixed guess leaves the line being typed —
// and the suggestion under it — hidden behind the cards.
let chatHeight = 140;
let documentKey = null;
let diskRevision = null;
let diskText = null;
let diskTimer = null;
let saving = false;
let savePaused = true;
let loadingDocument = true;
let editVersion = 0;
const saveStatus = document.getElementById('save-status');
const reviewStatus = document.getElementById('review-status');
// One header line, truncated when the window is narrow — the title keeps the
// whole message reachable instead of pushing the draft down a row.
// Two background features share this line, so each says who wrote it: a
// finished review must not wipe the line that told the writer why their
// continuations went quiet.
function setReviewStatus(text, detail, from = 'review') {
  reviewStatus.textContent = text;
  reviewStatus.title = detail ?? text;
  reviewStatus.dataset.from = text ? from : '';
}

// A provider's failure arrives as a status code and its own JSON, and pasting
// that into the interface tells the writer nothing they can act on. Keep the
// line about whose problem it is and what to do; the payload goes to the
// console and the tooltip, where it is there for a bug report and nowhere else.
// One short sentence for the cause. What to do about it is the button beside
// it, not a second clause: "rate-limited, try again shortly" says the same
// thing twice and reads like an apology.
const MODEL_ERRORS = {
  400: 'The model rejected the request.',
  401: 'The API key was rejected.',
  402: 'This provider is out of credit.',
  403: 'This key may not use this model.',
  404: 'This model is not available.',
  408: 'The model took too long.',
  413: 'The draft is too long for this model.',
  429: 'The model is rate-limited.',
  500: 'The provider hit an error.',
  502: 'The provider hit an error.',
  503: 'The provider is unavailable.',
  529: 'The provider is overloaded.',
};

function modelError(error) {
  const detail = error?.message ?? String(error);
  console.error('[model]', detail);
  if (/failed to fetch|networkerror|load failed/i.test(detail)) {
    return { say: 'Litura stopped answering.', act: 'retry', detail };
  }
  const status = Number(/^(?:HTTP |Server error )?([45]\d\d)\b/.exec(detail)?.[1]);
  return {
    say: MODEL_ERRORS[status] ?? 'The model could not answer.',
    // Retrying a rejected key or an oversized draft only fails again.
    act: [401, 402, 403].includes(status) ? 'settings' : status === 413 ? null : 'retry',
    detail,
  };
}

// The message is the cause; the button is the answer to it.
function errorCard(problem, retry) {
  const card = chatEl('div', 'chat-error', problem.say);
  card.title = problem.detail ?? '';
  if (problem.act === 'settings') {
    const open = chatEl('button', 'chat-again', 'Open settings');
    open.addEventListener('click', openSettings);
    card.append(open);
  } else if (problem.act === 'retry' && retry) {
    const again = chatEl('button', 'chat-again', 'Try again');
    again.addEventListener('click', () => { card.remove(); retry(); });
    card.append(again);
  }
  return card;
}
let tabId;
try {
  tabId = sessionStorage.getItem('litura-tab') || crypto.randomUUID();
  sessionStorage.setItem('litura-tab', tabId);
} catch { tabId = crypto.randomUUID(); }
const docStorage = {
  getItem(key) { try { return documentKey ? (key === 'wa-working' ? localStorage.getItem(documentKey + key + ':' + tabId) : null) ?? localStorage.getItem(documentKey + key) : null; } catch { return null; } },
  setItem(key, value) { try { if (documentKey) { localStorage.setItem(documentKey + key, value); if (key === 'wa-working') localStorage.setItem(documentKey + key + ':' + tabId, value); } } catch { saveStatus.textContent = 'Browser backup unavailable — keep this tab open until saved'; } },
  removeItem(key) { try { if (documentKey) localStorage.removeItem(documentKey + key); } catch {} },
};
const jobs = new Set();
// Background work is the writer's text being checked while they type; it is
// not something they pressed send for. Only what they started turns the send
// button into a stop button.
function startJob({ background = false } = {}) {
  const job = new AbortController();
  job.background = background;
  jobs.add(job);
  syncSend();
  return job;
}
function finishJob(job) {
  jobs.delete(job);
  syncSend();
}
// While the model is working, the send button is the work: it spins where the
// writer is already looking, and pressing it stops what it is showing.
function stopJobs() {
  for (const job of jobs) job.abort();
  suggestAbort?.abort();
  clearTimeout(autoReviewTimer);
  clearTimeout(suggestTimer);
}

// ─── Stored state across versions ──────────────────────────────────────────
// Bumped by hand, only when the shape of stored findings or chat turns changes
// — not on every release, or a patch would throw away a writer's review. The
// draft (`wa-working`, mirrored to draft.md) is never cleared here: it is the
// only state the writer cannot regenerate.
const STORAGE_SCHEMA = '1';
if (localStorage.getItem('wa-schema') !== STORAGE_SCHEMA) {
  docStorage.removeItem('wa-findings');
  docStorage.removeItem('wa-chat');
  localStorage.setItem('wa-schema', STORAGE_SCHEMA);
}

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

function saveAgentSelection() {
  const normalized = normalizeSelection(draftSelection);
  if (!normalized) return;
  draftSelection = normalized;
  agentSelection = normalized;
  localStorage.setItem('wa-agent', JSON.stringify(agentSelection));
}

// ── Combobox ──
//
//  Six hundred models do not fit a <select>, and a native datalist cannot
//  stand in: its popup never reaches the top layer above a modal dialog, and a
//  field that already holds an answer filters the writer's typing against it.
//  So: a trigger that names the choice, and a popover with a search box and a
//  list. The popover API still does the top layer, light dismiss and Escape.
const combos = new WeakMap();

function combobox(trigger) {
  const popover = document.getElementById(trigger.getAttribute('popovertarget'));
  const search = popover.querySelector('.combo-search');
  const list = popover.querySelector('.combo-list');
  const empty = popover.querySelector('.combo-empty');
  const state = { options: [], value: '', render };
  combos.set(trigger, state);

  function render() {
    const query = search.value.trim().toLowerCase();
    const shown = state.options.filter(option => !query
      || option.label.toLowerCase().includes(query)
      || option.value.toLowerCase().includes(query));
    list.replaceChildren(...shown.map(option => {
      const item = chatEl('button', 'combo-item', '');
      item.type = 'button';
      item.dataset.value = option.value;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(option.value === state.value));
      item.append(chatEl('span', '', option.label));
      return item;
    }));
    empty.hidden = shown.length > 0;
  }

  trigger.addEventListener('click', () => {
    const box = trigger.getBoundingClientRect();
    popover.style.left = `${box.left}px`;
    popover.style.top = `${box.bottom + 4}px`;
    popover.style.width = `${Math.max(box.width, 260)}px`;
  });
  popover.addEventListener('toggle', event => {
    if (event.newState !== 'open') return;
    search.value = '';   // the search starts empty, never at the current answer
    render();
    // Open where the writer already is: the current choice, not the top of a
    // list of six hundred. Enter with nothing typed then changes nothing.
    const current = list.querySelector('[aria-selected="true"]');
    current?.classList.add('is-active');
    current?.scrollIntoView({ block: 'center' });
    search.focus();
  });
  search.addEventListener('input', render);
  search.addEventListener('keydown', event => {
    const items = [...list.children];
    if (event.key === 'Enter') {
      event.preventDefault();
      (list.querySelector('.is-active') ?? items[0])?.click();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const at = items.findIndex(item => item.classList.contains('is-active'));
    const next = items[Math.min(Math.max(at + (event.key === 'ArrowDown' ? 1 : -1), 0), items.length - 1)];
    for (const item of items) item.classList.remove('is-active');
    next?.classList.add('is-active');
    next?.scrollIntoView({ block: 'nearest' });
  });
  list.addEventListener('click', event => {
    const item = event.target.closest('[data-value]');
    if (!item) return;
    state.value = item.dataset.value;
    popover.hidePopover();
    trigger.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

combobox(providerEl);
combobox(modelEl);

function setOptions(field, options, value) {
  const combo = combos.get(field);
  const chosen = options.find(option => option.value === value) ?? options[0];
  field.disabled = !options.length;
  if (!combo) {
    field.replaceChildren(...options.map(({ value: optionValue, label }) => {
      const option = document.createElement('option');
      option.value = optionValue;
      option.textContent = label;
      return option;
    }));
    field.value = chosen?.value ?? '';
    return;
  }
  combo.options = options;
  combo.value = chosen?.value ?? '';
  field.querySelector('.combo-value').textContent = chosen?.label ?? 'None available';
  combo.render();
}

function fieldValue(field) {
  const combo = combos.get(field);
  return combo ? combo.value : field.value;
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
  const models = agentInfo.models.filter(model => model.provider === fieldValue(providerEl));
  setOptions(modelEl, models.map(model => ({ value: model.model, label: model.name || model.model })), draftSelection?.model);
  const model = models.find(item => item.model === fieldValue(modelEl));
  const levels = levelsFor(model);
  setOptions(thinkingEl, levels.map(level => ({ value: level, label: thinkingNames[level] ?? level })), draftSelection?.thinkingLevel);
  draftSelection = model ? { provider: model.provider, model: model.model, thinkingLevel: fieldValue(thinkingEl) } : null;
  modelHint.textContent = agentInfo.models.length ? '' : 'Add an API key or configure Pi authentication to see models.';
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
settingsDialog.querySelector('.dialog-close').addEventListener('click', () => settingsDialog.close());

// Without a model every AI action fails in the console and the editor just
// looks broken. Send the writer to the one place that fixes it instead.
async function ensureAgent() {
  if (loadingDocument) { saveStatus.textContent = 'Wait until the draft is loaded'; return false; }
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
  const first = agentInfo.models.find(model => model.provider === fieldValue(providerEl));
  if (first) draftSelection = { provider: first.provider, model: first.model, thinkingLevel: 'medium' };
  renderModelSettings();
  saveAgentSelection();
});
modelEl.addEventListener('change', () => {
  draftSelection = { provider: fieldValue(providerEl), model: fieldValue(modelEl), thinkingLevel: draftSelection?.thinkingLevel ?? 'medium' };
  renderModelSettings();
  saveAgentSelection();
});

// A popover left open behind a closed dialog comes back with it.
settingsDialog.addEventListener('close', () => {
  for (const popover of document.querySelectorAll('.combo')) {
    if (popover.matches(':popover-open')) popover.hidePopover();
  }
});
thinkingEl.addEventListener('change', () => {
  if (draftSelection) draftSelection = { ...draftSelection, thinkingLevel: fieldValue(thinkingEl) };
  saveAgentSelection();
});
keyProviderEl.addEventListener('change', renderCredentials);

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

// A failure here is only reported when the writer asks for something:
// `ensureAgent()` retries the call and names the missing setup then.
refreshAgent().catch(error => console.error('[pi]', error.message));

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
        // A finding's span already carries its own mark; layering the plain-
        // selection tint on top of it read as the sentence being selected.
        // The decoration still has to exist — it is what tracks the live
        // position and ends the attachment on an edit — only its look differs.
        const cls = effect.value?.finding ? 'cm-attached cm-attached-finding' : 'cm-attached';
        return effect.value
          ? Decoration.set([Decoration.mark({ class: cls }).range(effect.value.from, effect.value.to)])
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
  reviewButton.textContent = reviewButton.disabled ? 'Reviewing…' : 'Review';
}
let jumpFrom = -1;
function jumpToNextFinding(direction = 1) {
  const live = reviewFindings.map(finding => ({ finding, range: findingRange(finding.id) })).filter(item => item.range)
    .sort((a, b) => a.range.from - b.range.from || a.finding.id - b.finding.id);
  if (!live.length) return;
  const index = live.findIndex(item => item.finding.id === jumpFrom);
  const next = live[(index + direction + live.length) % live.length];
  jumpFrom = next.finding.id;
  openFinding(next.finding, true);
}
// Stepping through findings is a keyboard job; the marks in the draft are the
// pointing device. F8 is the editor convention for "next problem".
document.addEventListener('keydown', event => {
  if (event.key === 'F8') { event.preventDefault(); jumpToNextFinding(event.shiftKey ? -1 : 1); }
  if (event.key === 'Escape' && preview) { preview.index = -1; endPreview(); workView.focus(); }
});
// Disagreeing with a finding has to be as cheap as accepting one, or the
// counter keeps advertising work the writer already rejected.
function dismissFinding(id) {
  const finding = reviewFindings.find(item => item.id === id);
  const dismissed = JSON.parse(docStorage.getItem('dismissed') || '[]');
  if (finding) dismissed.push({ code: finding.code, quote: finding.quote, document: workView.state.doc.toString() });
  docStorage.setItem('dismissed', JSON.stringify(dismissed.slice(-100)));
  reviewFindings = reviewFindings.filter(finding => finding.id !== id);
  findingCards.get(id)?.remove();
  findingCards.delete(id);
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
  docStorage.setItem('wa-findings', JSON.stringify({ document: workView.state.doc.toString(), findings: live }));
}

function restoreFindings() {
  let saved = [];
  try { saved = JSON.parse(docStorage.getItem('wa-findings') || '[]'); } catch {}
  if (saved.document === workView.state.doc.toString() && saved.findings?.length && mergeFindings(saved.findings)) syncReviewLabel();
}

function clearReview() {
  for (const card of findingCards.values()) card.remove();
  findingCards.clear();
  reviewFindings = [];
  checkedSentences.clear();
  workView.dispatch({ effects: setReviewFx.of([]) });
  docStorage.removeItem('wa-findings');
  syncReviewLabel();
}

// Anchor findings against the document as it is *now* and merge them in —
// the request may have been in flight while the writer kept typing.
function mergeFindings(rawFindings) {
  const document = workView.state.doc.toString();
  const dismissed = JSON.parse(docStorage.getItem('dismissed') || '[]');
  const filtered = (rawFindings || []).filter(finding =>
    !dismissed.some(item => item.document === document && item.code === finding.code && item.quote === finding.quote) &&
    !reviewFindings.some(item => findingRange(item.id) && item.code === finding.code && item.quote === finding.quote));
  const located = locateFindings(document, filtered)
    .map(finding => ({ ...finding, id: findingSeq++ }));
  if (!located.length) return 0;
  reviewFindings.push(...located);
  workView.dispatch({ effects: addReviewFx.of(located) });
  saveFindings();
  return located.length;
}

async function reviewRequest(body, replaceAll = false) {
  if (body.document !== workView.state.doc.toString()) throw new Error('Draft changed before review started. Run Review again.');
  const version = editVersion;
  // A targeted pass is the automatic one: it runs while the writer types.
  const job = startJob({ background: Boolean(body.target) });
  try {
    const data = await api('/review', {
      method: 'POST', signal: job.signal,
      body: JSON.stringify({ agent: currentAgent(), ...body }),
    });
    if (version !== editVersion) throw new Error('Draft changed during review. Run Review again.');
    if (replaceAll) clearReview();
    const added = mergeFindings(data.findings);
    // The marks in the draft are the result. A line announcing that the review
    // finished says nothing the marks do not already say.
    if (data.failedPasses?.length) setReviewStatus(`Partial review (${data.failedPasses.join(', ')}) — run Review to retry`);
    else if (reviewStatus.dataset.from === 'review') setReviewStatus('');   // the marks are the result
    return { added, complete: !data.failedPasses?.length };
  } finally { finishJob(job); }
}
async function runReview() {
  const document = workView.state.doc.toString();
  if (loadingDocument || !document.trim()) return;
  if (!await ensureAgent()) return;
  jumpFrom = -1;
  reviewButton.disabled = true;
  syncReviewLabel();
  setReviewStatus('');
  try {
    const result = await reviewRequest({ document }, true);
    if (result.complete) for (const paragraph of reviewParagraphs(document)) checkedSentences.add(paragraph.key);
  } catch (error) {
    setReviewStatus(error.name === 'AbortError' ? 'Review stopped — findings kept' : `Review failed. ${modelError(error).say}`, error.message);
  } finally { reviewButton.disabled = false; syncReviewLabel(); }
}
reviewButton.addEventListener('click', () => { workView.focus(); runReview(); });
reviewButton.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); workView.focus(); }
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

const checkedSentences = new Set();
let autoReviewTimer = null;
let autoReviewBusy  = false;

// Every pause costs a model call, so this has to be switchable — and visible
// while it runs, or the writer cannot tell what they are paying for.
let autoReviewOn = localStorage.getItem('wa-autoreview') !== 'off';
let autoSuggestOn = localStorage.getItem('wa-autosuggest') !== 'off';
const autoSuggestEl = document.getElementById('auto-suggest');
autoSuggestEl.checked = autoSuggestOn;
autoSuggestEl.addEventListener('change', () => {
  autoSuggestOn = autoSuggestEl.checked;
  localStorage.setItem('wa-autosuggest', autoSuggestOn ? 'on' : 'off');
  clearTimeout(suggestTimer); suggestAbort?.abort(); ghostClear(workView);
});
autoReviewEl.checked = autoReviewOn;
autoReviewEl.addEventListener('change', () => {
  autoReviewOn = autoReviewEl.checked;
  clearTimeout(autoReviewTimer);
  if (autoReviewOn) autoReviewSchedule();
  localStorage.setItem('wa-autoreview', autoReviewOn ? 'on' : 'off');
});

// ─── Update check ──────────────────────────────────────────────────────────
// Off unless the writer turns it on. Every other request Litura sends is one
// they started, and a background call to npm on every launch would quietly
// make that untrue. Once a day is generous for a package that `npx` already
// updates on its own — the badge is for the globally installed case.
const UPDATE_INTERVAL = 24 * 60 * 60 * 1000;
let updateCheckOn = localStorage.getItem('wa-updatecheck') !== 'off';
updateCheckEl.checked = updateCheckOn;

function renderUpdate({ current, latest, error }) {
  const stale = newerVersion(latest, current);
  updateBadge.hidden = !stale;
  if (stale) {
    updateBadge.textContent = `${latest} available`;
    updateBadge.title = `Running ${current}. Restart with npx to pick it up; a global install needs npm i -g.`;
  }
  updateStatus.textContent =
    error  ? `Running ${current} — npm could not be reached.` :
    stale  ? `Running ${current}; npm publishes ${latest}.` :
    latest ? `Running ${current} — the published version.` :
             `Running ${current}.`;
}

async function refreshUpdate({ force = false } = {}) {
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem('wa-update') || 'null'); } catch {}
  const check = updateCheckOn && (force || !(cached && Date.now() - cached.at < UPDATE_INTERVAL));
  try {
    const info = await api(`/api/version${check ? '?check=1' : ''}`);
    if (info.latest) localStorage.setItem('wa-update', JSON.stringify({ latest: info.latest, at: Date.now() }));
    // A cached answer still counts while it is fresh, but only while the check
    // is on: switching it off hides the badge instead of leaving a stale one.
    renderUpdate({ ...info, latest: info.latest ?? (updateCheckOn ? cached?.latest : undefined) });
  } catch {
    // The server that just served this page is not worth an error card.
  }
}

updateCheckEl.addEventListener('change', () => {
  updateCheckOn = updateCheckEl.checked;
  localStorage.setItem('wa-updatecheck', updateCheckOn ? 'on' : 'off');
  refreshUpdate({ force: updateCheckOn });
});

refreshUpdate();

// Live local readout. Pure string work, so it can run on every keystroke.
// English word lists and rhythm only — it says nothing about a draft in
// another language, which is why it hides itself rather than guessing.
function syncStyleScore() {
  const text = workView.state.doc.toString();
  scoreEl.hidden = !text.trim() || !isLatinScript(text);
  if (scoreEl.hidden) return;
  const { score, structural } = styleScore(text);
  scoreValueEl.textContent = `${score}`;
  scoreEl.title = structural
    ? `Local slop score ${score}/100 (0 = clean). Click to see what raised it.`
    : `Local slop score ${score}/100, wording only — too short to judge rhythm or variety. Click for detail.`;
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
    chatEl('strong', '', `Local slop score ${score}/100`),
    chatEl('span', '', hits.length ? `Known tells: ${hits.join(', ')}` : 'No known tell words or phrases.'),
    chatEl('small', '', `${notes.join(' ')} An English word list and sentence rhythm, nothing else: it does not read your meaning. Use Review for that.`),
  );
  chatAdd(card);
}
scoreEl.addEventListener('click', showScoreCard);

function autoReviewSchedule() {
  if (!autoReviewOn || loadingDocument || savePaused) return;
  clearTimeout(autoReviewTimer);
  autoReviewTimer = setTimeout(autoReviewRun, AUTO_REVIEW_DELAY);
}

function reviewParagraphs(document) {
  return [...document.matchAll(/[^\n]+(?:\n(?!\s*\n)[^\n]+)*/g)]
    .map(match => ({ text: match[0].trim(), from: match.index, to: match.index + match[0].length }))
    .map((paragraph, i, paragraphs) => ({ ...paragraph, key: JSON.stringify([
      paragraph.text, paragraphs[i - 1]?.text.slice(-400), paragraphs[i + 1]?.text.slice(0, 400), currentAgent(),
    ]) }));
}
function autoReviewPending(state) {
  const cursor = state.selection.main.head;
  return reviewParagraphs(state.doc.toString()).filter(paragraph =>
    paragraph.text.length >= AUTO_REVIEW_MIN && !checkedSentences.has(paragraph.key) &&
    (paragraph.to < state.doc.length || /[.!?…。！？]["'»”’)\]]*$/.test(paragraph.text)) &&
    !(cursor >= paragraph.from && cursor < paragraph.to));
}
async function autoReviewRun() {
  if (!autoReviewOn || loadingDocument || savePaused || autoReviewBusy || reviewButton.disabled || !currentAgent()) return;
  const pending = autoReviewPending(workView.state).slice(0, 3);
  if (!pending.length) return;
  const version = editVersion;
  autoReviewBusy = true;
  reviewButton.classList.add('is-busy');
  let complete = false;
  try {
    const result = await reviewRequest({
      document: workView.state.doc.toString(),
      target: pending.map(paragraph => paragraph.text).join('\n\n'),
    });
    complete = result.complete;
    if (complete) for (const paragraph of pending) checkedSentences.add(paragraph.key);
    syncReviewLabel();
  } catch (error) {
    setReviewStatus(error.name === 'AbortError' ? 'Automatic review stopped' : `Automatic review failed. ${modelError(error).say}`, error.message);
  } finally {
    autoReviewBusy = false;
    reviewButton.classList.remove('is-busy');
    if (complete || version !== editVersion) autoReviewSchedule();
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
  if (!autoSuggestOn || loadingDocument || savePaused) return;
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
  if (state.readOnly || !autoSuggestOn || !currentAgent()) return;
  if (!atParagraphEnd(state)) return;

  const doc = state.doc.toString();
  const pos = state.selection.main.head;

  // Don't suggest while on a /idea line
  const line = state.doc.lineAt(pos);
  if (/^\/idea/i.test(line.text)) return;

  const job = startJob({ background: true });
  suggestAbort = job;

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
    // A background feature that fails in silence looks like a broken one. Say
    // it once in the status line; the next keystroke schedules another try.
    if (!res.ok) {
      // The provider's own status is in the body; the 500 is only our wrapper.
      const problem = modelError(new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`));
      setReviewStatus(`Suggestions failed. ${problem.say}`, problem.detail, 'suggest');
      return;
    }

    const data = await res.json();

    // Only show if nothing changed while we were waiting
    if (
      data.suggestion &&
      view.state.doc.toString() === doc &&
      view.state.selection.main.head === pos &&
      !view.state.readOnly
    ) {
      ghostShow(view, data.suggestion);
    }
  } catch (error) {
    if (error.name === 'AbortError') return;
    const problem = modelError(error);
    setReviewStatus(`Suggestions failed. ${problem.say}`, problem.detail, 'suggest');
  } finally { finishJob(job); }
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
  const target = { from: line.from, to: line.to, text: line.text, document: view.state.doc.toString() };
  if (!await ensureAgent()) return;
  const job = startJob();
  const bubble = chatAdd(chatEl('div', 'chat-message is-agent', 'Expanding idea… Your draft is unchanged.'));
  let answer = '';
  try {
    const res = await fetch('/idea', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: job.signal,
      body: JSON.stringify({ document: target.document, idea: line.text.slice(5).trim(), agent: currentAgent() }),
    });
    if (!res.ok) throw new Error('Could not expand idea');
    for await (const chunk of sseChunks(res)) {
      if (chunk.error) throw new Error(chunk.error);
      answer += chunk.text ?? '';
      bubble.textContent = answer;
    }
    if (!answer.trim()) throw new Error('The model returned no passage');
    bubble.remove();
    showPreview([answer], null, target);
  } catch (error) {
    bubble.title = error.message;
    bubble.textContent = (answer ? answer + '\n\n' : '')
      + (job.signal.aborted ? 'Stopped. ' : `${modelError(error).say} `)
      + 'The original idea is unchanged.';
  } finally { finishJob(job); }
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
  docStorage.setItem('wa-chat', JSON.stringify(chatHistory.slice(-20)));
}

function restoreChat() {
  let saved = [];
  try { saved = JSON.parse(docStorage.getItem('wa-chat') || '[]'); } catch {}
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

// ── Rail ──
//
//  A remark about a place in the text stands next to that place. Cards are
//  positioned against the passage they anchor to and pushed down when they
//  would overlap; one that scrolls out of view is hidden with its mark.
//  Where the window is too narrow for a column, the same nodes go into the
//  panel and stack there.
const rail = document.getElementById('rail');
const railAnchors = new Map();   // node → () => document position | null
const railHomes = new Map();     // node → where it lives when there is no rail
const RAIL_WIDTH = 240, RAIL_GUTTER = 24;
let railOn = false;

// The rail lives in the margin the centred text column leaves empty, so it is
// available exactly when that margin can hold it. Measured, not guessed at a
// breakpoint: the text column's padding is the margin.
function syncRail() {
  const margin = parseFloat(getComputedStyle(workView.contentDOM).paddingRight) || 0;
  const fits = margin >= RAIL_WIDTH + RAIL_GUTTER;
  if (fits) {
    // Beside the text, not against the window: the note belongs to the line.
    // Measured against the pane, which is the rail's containing block — the
    // rail's own offsetParent is null while it is still hidden.
    const box = workView.contentDOM.getBoundingClientRect();
    const pane = document.getElementById('pane-work').getBoundingClientRect();
    rail.style.left = `${box.right - margin - pane.left + RAIL_GUTTER}px`;
  }
  if (fits === railOn) return;
  railOn = fits;
  rail.hidden = !fits;
  for (const node of railAnchors.keys()) {
    if (!node.isConnected) continue;
    node.style.top = '';
    node.style.visibility = '';
    if (fits) rail.append(node); else placeHome(node);
  }
  if (!fits) chatScroll(true);   // cards moved into the stream land below the fold
}

// Without a rail a card belongs in the stream, but the rewrite strip belongs
// in the action row it came from — dropped into the stream it stacks its
// buttons one per line.
function placeHome(node) {
  const home = railHomes.get(node) ?? chatStream;
  if (home === chatStream) chatAdd(node);
  else home.insertBefore(node, document.getElementById('review-status'));
}

function railAdd(node, anchor, home = chatStream) {
  railAnchors.set(node, anchor);
  railHomes.set(node, home);
  syncRail();
  if (railOn) rail.append(node);
  else placeHome(node);
  layoutRail();
  return node;
}

function layoutRail() {
  syncRail();
  if (!railOn || !rail.children.length) return;
  const top = rail.getBoundingClientRect().top;
  const placed = [...rail.children]
    .map(node => {
      const position = railAnchors.get(node)?.();
      const coords = position == null ? null : workView.coordsAtPos(position);
      return { node, at: coords && coords.top - top };
    })
    .filter(item => item.at !== null && item.at !== undefined)
    .sort((a, b) => a.at - b.at);
  for (const node of rail.children) node.style.visibility = 'hidden';
  let floor = 0;
  for (const item of placed) {
    const at = Math.max(item.at, floor);
    item.node.style.top = `${at}px`;
    item.node.style.visibility = 'visible';
    floor = at + item.node.offsetHeight + 8;
  }
}

new MutationObserver(layoutRail).observe(rail, { childList: true });
window.addEventListener('resize', layoutRail);

// Closing the conversation is a view, not an edit: the turns stay in memory
// and in storage, and the same control opens them again. Something new
// arriving is worth showing, so it opens by itself.
function setChatOpen(open) {
  // One press puts away everything the assistant is currently showing — the
  // turns and the cards in the rail — because two × in two places for one
  // idea is two presses to get a clean screen. Nothing is discarded: the
  // findings and their marks are still there, and clicking a mark builds its
  // card again. The composer stays: it is how the writer talks to the draft
  // at all.
  if (open) chatStream.hidden = false;      // measure against a laid-out stream
  chatClear.textContent = open ? '×' : 'Conversation';
  chatClear.setAttribute('aria-label', open ? 'Close the conversation' : 'Show the conversation');
  chatClear.title = open ? 'Close — nothing is discarded' : 'Show the conversation';
  if (open) { chatScroll(true); return; }
  chatStream.hidden = true;
  detach();                                 // ends an open preview with it
  for (const card of findingCards.values()) card.remove();
  findingCards.clear();
}

function chatAdd(node) {
  setChatOpen(true);
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
  // Only a passage the writer selected gets a chip. A finding is already named
  // on its own card beside the line, and the placeholder says what the next
  // message will do with it — a chip on top of that read as the sentence
  // having been selected into the composer, which is not what happened.
  chatChip.classList.toggle('hidden', !!finding);
  chatChipText.textContent = finding?.pattern ?? 'Selected text';
  workView.dispatch({ effects: setAttachFx.of({ from: range.from, to: range.to, finding: !!finding }) });
  // What the next message does is decided by what is attached, and the
  // placeholder is the only place that has to say so. A passage the writer
  // selected is a rewrite target; a finding is something to ask about, and its
  // card carries the explicit `Options` button.
  chatInput.placeholder = finding ? 'Ask about this finding' : 'Describe the change';
  syncActiveCard();
  if (focusComposer) chatInput.focus();
}

function detach() {
  cancelPreview();
  attached = null;
  activeFinding = null;
  chatChip.classList.add('hidden');
  syncActiveCard();
  chatInput.placeholder = CHAT_PLACEHOLDER;
  workView.dispatch({ effects: setAttachFx.of(null) });
}

// The chip holds a snapshot; the decoration holds the live position. Re-read it
// so an edit made while the chat was open does not misplace the replacement.
function attachedRange() {
  if (!attached) return null;
  let range = null;
  workView.state.field(attachField).between(0, workView.state.doc.length, (from, to) => {
    range = { from, to, text: workView.state.sliceDoc(from, to) };
  });
  return range;
}

// ── Rewrite preview ──
//
//  A variant is read where it will live: substituted into the paragraph, with
//  the sentences around it intact. The document itself is untouched — this is
//  a replace decoration — so nothing is autosaved, no finding is re-anchored
//  and undo stays clean until the writer keeps one.
// How long the revert diff — the option's words struck, the writer's own
// words back — stays up before the sheet closes and plain text shows again.
const REVERT_MS = 700;

class VariantWidget extends WidgetType {
  constructor(text, original, block, reverting) {
    super();
    this.text = text; this.original = original; this.block = block;
    this.reverting = reverting;
  }
  eq(other) {
    return other.text === this.text && other.block === this.block
      && other.reverting === this.reverting;
  }
  toDOM() {
    const node = document.createElement(this.block ? 'div' : 'span');
    node.className = this.reverting ? 'cm-variant is-reverting' : 'cm-variant';
    node.append(variantNodes(this.original, this.text));
    return node;
  }
}

// How long between one changed run lighting up and the next. The colour walks
// through the edit in reading order rather than flooding the sentence at once.
const WORD_STEP = 90;
const WORD_STEPS_MAX = 10;   // past this the wait costs more than the reading

// The edit script as DOM, shared with the height probe so what gets measured
// is exactly what gets rendered. Only colour is animated, never size — the
// reserved line height would be measuring something that moves otherwise.
function variantNodes(original, text) {
  const fragment = document.createDocumentFragment();
  let step = 0;
  for (const op of wordDiff(original, text)) {
    if (op.type === 'keep') { fragment.append(op.text); continue; }
    // A whole rewritten paragraph struck through is a wall, not a diff.
    if (op.type === 'del' && op.text.length > 120) continue;
    const part = document.createElement(op.type === 'del' ? 'del' : 'ins');
    part.className = op.type === 'del' ? 'cm-variant-old' : 'cm-variant-new';
    part.textContent = op.text;
    part.style.animationDelay = `${Math.min(step++, WORD_STEPS_MAX) * WORD_STEP}ms`;
    fragment.append(part);
  }
  return fragment;
}

// Every option is a different length, so the paragraph rewraps and everything
// under it steps up or down as the writer flips through — the passage itself
// holds still, but the page under it does not. Measure the tallest of the
// stops once, against a copy of the real line, and reserve that much: the
// shorter options then leave a little slack rather than dragging the draft up.
// Only for a passage inside one paragraph; a multi-paragraph rewrite already
// replaces whole blocks, where there is nothing to hold still.
function reservedHeight(target, variants) {
  const line = workView.state.doc.lineAt(target.from);
  if (line.number !== workView.state.doc.lineAt(target.to).number) return 0;
  const at = workView.domAtPos(line.from).node;
  const lineEl = (at.nodeType === 1 ? at : at.parentElement)?.closest('.cm-line');
  if (!lineEl) return 0;

  const probe = document.createElement('div');
  probe.className = lineEl.className;
  probe.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;width:${lineEl.clientWidth}px`;
  lineEl.parentElement.append(probe);
  const before = workView.state.sliceDoc(line.from, target.from);
  const after = workView.state.sliceDoc(target.to, line.to);
  let tallest = 0;
  try {
    for (const option of [target.text, ...variants]) {
      probe.replaceChildren(before, variantNodes(target.text, option), after);
      tallest = Math.max(tallest, probe.offsetHeight);
    }
  } finally { probe.remove(); }
  return tallest;
}

const setVariantFx = StateEffect.define();
const variantField = StateField.define({
  create: () => null,
  update(value, tr) {
    if (tr.docChanged) return null;  // the writer took the sentence over
    for (const effect of tr.effects) if (effect.is(setVariantFx)) return effect.value;
    return value;
  },
  provide: field => EditorView.decorations.from(field, value => {
    if (!value) return Decoration.none;
    const marks = [];
    // The reservation goes on the line, not the widget: the widget is inline,
    // and it is the line's height the text below is standing on.
    if (value.reserve) {
      marks.push(Decoration.line({ attributes: { style: `min-height:${value.reserve}px` } })
        .range(value.lineFrom));
    }
    marks.push(Decoration.replace({
      widget: new VariantWidget(value.text, value.original, value.block, value.reverting),
      block: value.block,
    }).range(value.from, value.to));
    return Decoration.set(marks, true);
  }),
});

function applyText(text, target) {
  if (!replacementTarget(workView.state.doc.toString(), target) || workView.state.readOnly) {
    chatAdd(chatEl('div', 'chat-error', 'The draft changed since this answer. Select the passage and request new options.'));
    return;
  }
  const range = target;
  saveSnapshot('Before AI replacement');
  workView.dispatch({
    changes:   { from: range.from, to: range.to, insert: text },
    selection: { anchor: range.from + text.length },
  });
  workView.focus();
  save();
  detach();
}

// ── Cards ──

// Hovering a card lights the passage it belongs to. The mark's element is
// re-rendered by CodeMirror as the viewport changes, which is fine: a hover
// class only has to outlive the hover.
function markFor(id) { return workView.dom.querySelector(`.cm-slop[data-slop-id="${id}"]`); }

function syncActiveCard() {
  for (const [id, card] of findingCards) card.classList.toggle('is-active', id === activeFinding?.id);
}

function findingCard(finding) {
  const card = chatEl('div', 'chat-card');
  card.addEventListener('mouseenter', () => markFor(finding.id)?.classList.add('is-hot'));
  card.addEventListener('mouseleave', () => markFor(finding.id)?.classList.remove('is-hot'));
  const dismiss = chatEl('button', 'chat-card-dismiss', '×');
  dismiss.type = 'button';
  dismiss.title = 'Dismiss this finding';
  dismiss.setAttribute('aria-label', 'Dismiss this finding');
  dismiss.addEventListener('click', () => {
    chatAbort?.abort();  // in-flight variants for a dismissed finding are waste
    dismissFinding(finding.id);
    cancelPreview();   // options generated for a dismissed finding are waste
    card.remove();
  });
  card.append(
    dismiss,
    chatEl('strong', '', finding.pattern),
    chatEl('span', '', finding.reason),
    chatEl('small', '', finding.fix),
  );

  // Alternatives are offered, not spent on a click. Reading the remark and
  // fixing the sentence yourself is a complete outcome. There is one scope —
  // the passage the finding quotes, which is the passage it marked in the
  // draft — so there is nothing to choose before asking.
  // Discussing a finding needs no button of its own: the card is attached, and
  // typing in the composer with a finding attached opens the conversation.
  const offer = chatEl('button', 'chat-offer', 'Options');
  offer.type = 'button';
  offer.addEventListener('click', () => {
    const live = findingRange(finding.id);
    if (!live) {
      if (!card.querySelector('.chat-error')) card.append(chatEl('div', 'chat-error', 'This passage has changed. Run Review again.'));
      return;
    }
    const target = { ...live, text: workView.state.sliceDoc(live.from, live.to) };
    attach(target, finding, false);
    requestVariants(`Fix ${finding.pattern}: ${finding.fix}. Preserve facts and voice. Replace only the quoted passage.`, null, card);
  });
  card.append(offer);
  return card;
}

// The strip is the only chrome the preview needs: which option, the way back
// to the current wording, and the two ways out.
const previewStrip = document.getElementById('chat-preview');
// A card says one thing at a time. While its options are being fetched and
// then chosen, its own text steps aside and comes back if nothing is kept.
const cardContent = new WeakMap();
function cardShow(card, ...nodes) {
  if (!cardContent.has(card)) cardContent.set(card, [...card.childNodes]);
  // Only the remark is worth a box. Waiting and choosing are passing states:
  // the card holds its place in the rail and drops its walls for them.
  card.classList.add('is-bare');
  card.replaceChildren(...nodes);
}
function cardRestore(card) {
  const saved = cardContent.get(card);
  if (!saved) return;
  card.classList.remove('is-bare');
  card.replaceChildren(...saved);
  cardContent.delete(card);
}
const previewCount = document.getElementById('preview-count');
const previewKept = document.getElementById('preview-kept');
// index -1 is the writer's own wording: one more stop on the same ring, so
// "leave it where you want it" covers keeping the draft as it is.
let preview = null;  // { variants, index, target, instruction, card }
let keptTimer = null;
let revertTimer = null;

function renderPreview() {
  reviewButton.hidden = !!preview;
  previewStrip.hidden = !preview;
  if (!preview) {
    clearTimeout(revertTimer);
    workView.dispatch({ effects: setVariantFx.of(null) });
    return;
  }
  const { target, index, variants } = preview;
  const original = index < 0;
  previewCount.textContent = original ? 'Original' : `${index + 1} of ${variants.length}`;
  document.getElementById('preview-again').hidden = preview.instruction === null;
  // Stepping back to the writer's wording shows the same diff in reverse —
  // the option's words struck, the writer's own words back — and only then
  // does the sheet go, so nothing about the passage ever cuts silently.
  const text = original ? target.text : variants[index];
  const against = original ? variants[preview.shown] : target.text;
  if (!original) preview.shown = index;
  workView.dispatch({
    effects: [
      setVariantFx.of({
        from: target.from,
        to: target.to,
        lineFrom: workView.state.doc.lineAt(target.from).from,
        reserve: preview.reserve,
        text,
        original: against,
        reverting: original,
        block: workView.state.doc.lineAt(target.from).number !== workView.state.doc.lineAt(target.to).number,
      }),
      EditorView.scrollIntoView(target.from, { y: 'center' }),
    ],
  });
  clearTimeout(revertTimer);
  if (original) {
    revertTimer = setTimeout(() => {
      if (preview?.index === -1) workView.dispatch({ effects: setVariantFx.of(null) });
    }, REVERT_MS);
  }
}

function showPreview(variants, instruction, target, card = null) {
  hideKept();
  preview = { variants, instruction, target, index: 0, shown: 0, card };
  preview.reserve = reservedHeight(target, variants);
  previewStrip.hidden = false;
  // With a card the options belong in it — same block, next state. Without one
  // the strip is anchored on its own, beside the passage or in the action row.
  if (card) cardShow(card, previewStrip);
  else railAdd(previewStrip, () => preview?.target.from ?? null, document.querySelector('.chat-recipes'));
  renderPreview();
  document.getElementById('preview-next').focus();
}

// Close the preview without touching the draft. Everything the writer can do
// to end it routes through here; only `endPreview` writes.
function cancelPreview() {
  if (!preview) return;
  const { card } = preview;
  preview = null;
  railAnchors.delete(previewStrip);
  previewStrip.style.top = '';
  previewStrip.style.visibility = '';
  document.querySelector('.chat-recipes').insertBefore(previewStrip, document.getElementById('review-status'));
  if (card) cardRestore(card);
  renderPreview();
}

// Leaving keeps what is on screen. There is no separate confirmation because
// there is nothing to confirm: the writer has been reading the result in place
// the whole time, and `Original` is one of the stops.
function endPreview() {
  if (!preview) return;
  const { variants, index, target, card } = preview;
  cancelPreview();   // drop the decoration before the text under it changes
  if (index < 0) return;
  applyText(variants[index], target);
  card?.remove();    // the passage it remarked on is gone
  showKept(variants[index], target);
}

function stepPreview(delta) {
  if (!preview) return;
  const stops = preview.variants.length + 1;   // the options, plus the original
  preview.index = ((preview.index + 1 + delta + stops) % stops) - 1;
  renderPreview();
}

// An edit nobody pressed a button for keeps its way back in view — in the same
// card the options sat in, beside the sentence it changed. One word, no
// verdict: the sentence itself already says what happened. The bar under it
// is the timer: it drains over exactly as long as `Undo` is good for, so
// leaving is a countdown the writer can see rather than a guess.
const KEPT_MS = 8000;
function showKept(text, target) {
  clearTimeout(keptTimer);
  railAdd(previewKept, () => target.from, document.querySelector('.chat-recipes'));
  previewKept.hidden = false;
  previewKept.dataset.from = target.from;
  previewKept.dataset.applied = text;
  previewKept.dataset.previous = target.text;
  previewKept.style.setProperty('--kept-ms', `${KEPT_MS}ms`);
  // Restart the drain from full even if a card was already mid-countdown: the
  // bar is a pseudo-element, so the reflow has to happen with the class off.
  previewKept.classList.remove('is-counting');
  void previewKept.offsetWidth;
  previewKept.classList.add('is-counting');
  keptTimer = setTimeout(hideKept, KEPT_MS);
}

function hideKept() {
  clearTimeout(keptTimer);
  previewKept.hidden = true;
  previewKept.classList.remove('is-counting');
  railAnchors.delete(previewKept);
  previewKept.style.top = '';
  previewKept.style.visibility = '';
  document.querySelector('.chat-recipes').insertBefore(previewKept, document.getElementById('review-status'));
}

document.getElementById('preview-undo').addEventListener('click', () => {
  const from = Number(previewKept.dataset.from);
  const { applied, previous } = previewKept.dataset;
  hideKept();
  // Not the editor's undo: by now that might belong to something the writer
  // typed afterwards. Put back exactly what was replaced, and only if it is
  // still there to put back.
  if (workView.state.sliceDoc(from, from + applied.length) !== applied) {
    chatAdd(chatEl('div', 'chat-error', 'That passage has changed since. Use the editor’s undo instead.'));
    return;
  }
  workView.dispatch({ changes: { from, to: from + applied.length, insert: previous }, selection: { anchor: from + previous.length } });
  workView.focus();
  save();
});

document.getElementById('preview-prev').addEventListener('click', () => stepPreview(-1));
document.getElementById('preview-next').addEventListener('click', () => stepPreview(1));
document.getElementById('preview-again').addEventListener('click', () => {
  if (!preview) return;
  const { instruction, target, card } = preview;
  cancelPreview();
  if (!replacementTarget(workView.state.doc.toString(), target)) {
    chatAdd(chatEl('div', 'chat-error', 'This answer is out of date. Select the passage again.'));
    return;
  }
  requestVariants(instruction, target, card);
});
previewStrip.addEventListener('keydown', event => {
  if (event.key === 'ArrowLeft')  { event.preventDefault(); stepPreview(-1); }
  if (event.key === 'ArrowRight') { event.preventDefault(); stepPreview(1); }
  if (event.key === 'Enter')      { event.preventDefault(); endPreview(); workView.focus(); }
});

// ── Rewrite ──

async function requestVariants(instruction, existingTarget = null, card = null) {
  const range = existingTarget ?? attachedRange();
  const target = existingTarget ?? (range && { ...range, document: workView.state.doc.toString() });
  if (!range) {
    chatAdd(chatEl('div', 'chat-error', 'That passage is no longer attached — select it again.'));
    return;
  }
  if (!await ensureAgent()) return;
  if (!replacementTarget(workView.state.doc.toString(), target)) return;
  cancelPreview();
  // The card stops being a remark and becomes the place the work is happening.
  if (card) cardShow(card, chatEl('div', 'card-working', 'Looking for options…'));
  chatAbort?.abort();
  const job = startJob();
  chatAbort = job;
  try {
    const res = await fetch('/rewrite', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      signal:  chatAbort.signal,
      body:    JSON.stringify({
        document:    target.document,
        selected:    target.text,
        from:        range.from,   // exact span, so the server marks the right occurrence
        instruction,
        agent:       currentAgent(),
      }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `Server error ${res.status}`);
    if (!replacementTarget(workView.state.doc.toString(), target)) throw new Error('The draft changed while the rewrites were coming back. Select the passage again.');
    showPreview(data.variants, instruction, target, card);
  } catch (error) {
    if (card) cardRestore(card);   // nothing came back; the remark is what it has to say
    if (error.name === 'AbortError') return;
    console.error('[/rewrite]', error);
    chatAdd(errorCard(modelError(error), () => requestVariants(instruction, target, card)));
  } finally { finishJob(job); if (chatAbort === job) chatAbort = null; }
}

// A finding marks a passage and is answered on that passage. Clicking the mark
// attaches exactly what the mark covers, so the tint in the draft and the range
// a rewrite would replace are the same thing. A problem that needs material
// moved between paragraphs is a conversation, and the composer is already it.
const findingCards = new Map();  // finding id → its card, while it is on screen

function openFinding(finding, center = false) {
  endPreview();   // turning to another remark is leaving the one on screen
  const range = findingRange(finding.id);
  if (!range) return;
  attach({ ...range, text: workView.state.sliceDoc(range.from, range.to) }, finding, false);
  // A direct click is already at the passage, so moving it would break spatial
  // continuity. Keyboard navigation still centres an off-screen finding.
  if (center) workView.dispatch({ effects: EditorView.scrollIntoView(range.from, { y: 'center' }) });

  // Clicking the same mark again is navigation, not a new remark: return to the
  // card that is already in the stream instead of stacking a copy.
  if (findingCards.get(finding.id)?.isConnected) { chatScroll(true); return; }
  findingCards.set(finding.id, railAdd(findingCard(finding), () => findingRange(finding.id)?.from ?? null));
  syncActiveCard();
}

// ── Conversation ──

async function chatSend() {
  const text = chatInput.value.trim();
  if (!text) return;
  if (!await ensureAgent()) return;
  chatInput.value = '';
  chatResize();
  chatAdd(chatEl('div', 'chat-message is-user', text));

  // A passage the writer selected themselves: the message is the rewrite
  // instruction, and variants are directly applicable where prose is not.
  // A finding is attached by clicking a mark — that is a question, not an
  // order, so it opens a discussion and the card's button asks for rewrites.
  if (attached && !activeFinding) { requestVariants(text); return; }

  chatHistory.push(attached && activeFinding
    ? {
        role: 'user',
        content: `${text}\n\nFinding: ${activeFinding.pattern}\nQuoted passage: ${attached.text}\nEditing direction: ${activeFinding.fix}`,
        display: text,
      }
    : { role: 'user', content: text });
  saveChat();
  const reply = chatAdd(chatEl('div', 'chat-message is-agent is-markdown'));
  reply.append(chatEl('span', 'chat-caret'));

  chatAbort?.abort();
  const job = startJob();
  chatAbort = job;
  let answer = '';
  try {
    const res = await fetch('/chat', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      signal:  chatAbort.signal,
      body:    JSON.stringify({
        messages: chatHistory.map(({ role, content }) => ({ role, content })),
        document: workView.state.doc.toString(),
        selection: attachedRange()?.text,
        agent:    currentAgent(),
      }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Server error ${res.status}`);

    for await (const chunk of sseChunks(res)) {
      if (chunk.error) throw new Error(chunk.error);
      const stick = chatAtBottom();
      answer += chunk.text ?? '';
      reply.innerHTML = renderMarkdown(answer);
      chatScroll(stick);
    }
    chatHistory.push({ role: 'assistant', content: answer });
    saveChat();
  } catch (error) {
    if (error.name === 'AbortError') { reply.innerHTML = renderMarkdown(answer ? answer + '\n\n[Stopped — incomplete]' : 'Stopped'); return; }
    console.error('[/chat]', error);
    reply.title = error.message;
    reply.innerHTML = renderMarkdown((answer ? answer + '\n\n' : '') + modelError(error).say);
  } finally { finishJob(job); if (chatAbort === job) chatAbort = null; }
}

async function* sseChunks(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) throw new Error('Connection ended before the answer completed. Retry.');
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6);
      if (payload === '[DONE]') return;
      yield JSON.parse(payload);
    }
  }
}

// ── Composer ──

function chatResize() {
  chatInput.style.height = 'auto';
  chatInput.style.height = `${Math.min(chatInput.scrollHeight, 160)}px`;
  syncSend();
}

function syncSend() {
  const busy = [...jobs].some(job => !job.background);
  chatSendButton.classList.toggle('is-busy', busy);
  chatSendButton.disabled = !busy && !chatInput.value.trim();
  chatSendButton.setAttribute('aria-label', busy ? 'Stop' : 'Send');
}

chatSendButton.addEventListener('click', () => {
  // The button stops only what it was showing: work the writer started.
  if ([...jobs].some(job => !job.background)) { stopJobs(); return; }
  chatSend();
  chatInput.focus();
});

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
  setChatOpen(chatStream.hidden);
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

const isDark = currentTheme === 'dark';

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
    background: 'color-mix(in srgb, var(--accent) 22%, transparent) !important',
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

  // The attached passage. Survives losing focus, unlike a native selection —
  // that is the only job this mark has for a plain selection, which carries
  // no marking of its own.
  '.cm-attached': {
    background: 'var(--attached-tint)',
    borderRadius: '3px',
    boxShadow: '0 0 0 2px var(--attached-tint)',
  },

  // A finding already marks its own span. Layering the selection tint over it
  // read as the sentence being highlighted rather than a remark being opened —
  // so here the decoration keeps tracking the live position (that is what lets
  // an edit end the attachment) and gives up the look entirely.
  '.cm-attached.cm-attached-finding': {
    background: 'transparent',
    boxShadow: 'none',
  },

  // A quiet band, not a spell-checker's wavy red. Findings run over whole
  // clauses here, and a wave under three lines of prose reads as an error the
  // writer must clear rather than a remark they may weigh.
  '.cm-slop': {
    background: 'var(--slop-tint)',
    borderRadius: '2px',
    boxShadow: 'inset 0 -1px 0 var(--slop-line)',
    cursor: 'pointer',
    transition: 'background .12s ease',
  },

  '.cm-slop:hover': { background: 'var(--slop-tint-hover)' },

  // Slightly dim the content while /idea is streaming
  '&.streaming .cm-content': { opacity: '0.8' },

  // Placeholder text (shown when doc is empty)
  // It carries the only instructions in the product now, so it has to be
  // readable, not a watermark.
  '.cm-placeholder': {
    color:      'var(--muted)',
    opacity:    '0.75',
    lineHeight: '1.7',
  },

  // Hide gutters and fold markers — this is a prose editor
  '.cm-gutters': { display: 'none' },
}, { dark: isDark });

// ─── Editor setup ──────────────────────────────────────────────────────────────

const workView = new EditorView({
  state: EditorState.create({
    doc: '',

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
            return false; // Native Tab navigation when no suggestion is present.
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
      keymap.of([...searchKeymap, ...historyKeymap, ...defaultKeymap]),
      EditorView.contentAttributes.of({ 'aria-label': 'Draft editor' }),

      // Ghost text state + decoration provider
      ghostField,
      reviewField,
      attachField,
      variantField,

      // Read-only compartment — toggled during /idea streaming
      readonlyComp.of(EditorState.readOnly.of(true)),

      // Word wrap (essential for prose)
      EditorView.lineWrapping,

      // Reserve the covered strip so CodeMirror scrolls the caret above the
      // panel instead of under it.
      EditorView.scrollMargins.of(() => ({ bottom: chatHeight })),

      // The empty draft is the only place an explanation is read: it is where
      // the writer is already looking and the only moment nothing is at stake.
      placeholder(
        'Start writing, or open a file.'
      ),

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
        // Reaching for the text means the writer is done choosing.
        mousedown() { endPreview(); return false; },
        contextmenu(event, view) {
          const sel = view.state.selection.main;
          if (sel.empty) return false; // no selection — show native menu
          event.preventDefault();
          attach({ from: sel.from, to: sel.to, text: view.state.sliceDoc(sel.from, sel.to) });
          return true;
        },
      }),

      // Save on every edit + schedule a suggestion
      // Anything that moves the text moves the cards beside it.
      EditorView.updateListener.of(update => {
        if (update.docChanged || update.geometryChanged || update.viewportChanged) layoutRail();
      }),

      EditorView.updateListener.of(update => {
        if (update.docChanged) {
          editVersion++;
          setReviewStatus(reviewFindings.length ? 'Review is out of date' : '');
          // Typing inside the attached passage is the writer fixing it
          // themselves — drop the attachment rather than let a rewrite land on
          // top of the edit. Deferred: a dispatch inside an update is illegal.
          if (attached && update.state.field(attachField).size === 0) {
            queueMicrotask(() => { chatAbort?.abort(); detach(); });
          }
          // The field drops the decoration on any edit; the strip follows it.
          if (preview) queueMicrotask(cancelPreview);
          if (reviewFindings.length) { syncReviewLabel(); saveFindings(); }
          if (!loadingDocument) save();
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

// Workspace identity comes from the server path, never from the port or a
// global browser draft. Conflicts pause writes until explicitly resolved.
function saveSnapshot(label) {
  const snapshots = JSON.parse(docStorage.getItem('snapshots') || '[]');
  snapshots.unshift({ text: workView.state.doc.toString(), at: new Date().toISOString(), label });
  docStorage.setItem('snapshots', JSON.stringify(snapshots.slice(0, 10)));
}
function exportText(text, name = 'draft.md') {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function dialog(title) {
  const trigger = document.activeElement;
  const modal = chatEl('dialog', 'settings-dialog document-dialog');
  const heading = chatEl('h2', '', title);
  heading.id = 'document-dialog-' + crypto.randomUUID();
  modal.setAttribute('aria-labelledby', heading.id);
  // Title left, one × right — the same header the settings dialog has. A
  // full-width `Close` button under the title read as the dialog's action.
  const close = chatEl('button', 'dialog-close', '×');
  close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', () => modal.close());
  const head = chatEl('header', '');
  head.append(heading, close);
  modal.append(head);
  document.body.append(modal);
  modal.addEventListener('close', () => { modal.remove(); if (trigger?.isConnected) trigger.focus(); });
  modal.showModal();
  return modal;
}
function loadFromDisk(text) {
  loadingDocument = true;
  for (const job of jobs) job.abort();
  suggestAbort?.abort();
  saveSnapshot('Before replacing document');
  detach();
  workView.dispatch({ changes: { from: 0, to: workView.state.doc.length, insert: text } });
  clearReview();
  chatHistory = []; chatStream.replaceChildren(); findingCards.clear();
  docStorage.removeItem('wa-chat');
  docStorage.removeItem('dismissed');
  loadingDocument = false;
}
function saveToDisk() {
  clearTimeout(diskTimer);
  if (savePaused || loadingDocument) return;
  saveStatus.textContent = 'Unsaved changes';
  diskTimer = setTimeout(flushSave, 800);
}
async function flushSave() {
  if (saving || savePaused || loadingDocument) return;
  const text = workView.state.doc.toString();
  if (text === diskText && diskRevision !== 'missing') { saveStatus.textContent = 'Saved'; return; }
  saving = true;
  saveStatus.textContent = 'Saving…';
  try {
    const response = await fetch('/draft', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, revision: diskRevision }),
    });
    const data = await response.json();
    if (response.status === 409) { promptDiskDrift(data.current); return; }
    if (!response.ok) throw new Error(data.error || 'Save failed');
    diskText = text; diskRevision = data.revision;
    saveStatus.textContent = 'Saved';
  } catch (error) {
    savePaused = true;
    saveStatus.textContent = 'Not saved: ' + error.message + ' — use Export or retry';
    const retry = chatEl('button', 'chat-again', 'Retry saving');
    retry.addEventListener('click', () => { retry.remove(); savePaused = false; saveToDisk(); });
    chatAdd(retry);
  } finally {
    saving = false;
    if (!savePaused && workView.state.doc.toString() !== diskText) saveToDisk();
  }
}
function save() {
  docStorage.setItem('wa-working', workView.state.doc.toString());
  saveToDisk();
}
let diskPrompt = null;
function promptDiskDrift(current) {
  savePaused = true;
  clearTimeout(diskTimer);
  saveStatus.textContent = 'Conflict — autosave paused';
  diskPrompt?.close();
  const modal = dialog('Two versions of this document');
  diskPrompt = modal;
  modal.append(chatEl('p', '', 'Autosave is paused. Both copies remain available until you choose. A disk backup is kept before overwriting.'));
  const compare = document.createElement('details');
  compare.append(chatEl('summary', '', 'Compare browser and disk'),
    chatEl('h3', '', 'Browser'), chatEl('pre', 'passage-preview', workView.state.doc.toString()),
    chatEl('h3', '', 'Disk'), chatEl('pre', 'passage-preview', current.text));
  modal.append(compare);
  const load = chatEl('button', '', 'Use disk copy');
  load.addEventListener('click', () => {
    loadFromDisk(current.text);
    diskText = current.text; diskRevision = current.revision;
    savePaused = false; save(); modal.close();
  });
  const keep = chatEl('button', '', 'Keep browser copy');
  keep.addEventListener('click', () => {
    saveSnapshot('Browser copy at conflict');
    diskText = current.text; diskRevision = current.revision;
    savePaused = false; save(); modal.close();
  });
  const both = chatEl('button', '', 'Export browser copy');
  both.addEventListener('click', () => exportText(workView.state.doc.toString(), 'recovered-browser-draft.md'));
  modal.append(load, keep, both);
  const reopen = chatEl('button', 'chat-again', 'Resolve file conflict');
  reopen.addEventListener('click', async () => {
    try { promptDiskDrift(await api('/draft')); reopen.remove(); } catch (error) { saveStatus.textContent = error.message; }
  });
  chatAdd(reopen);
}
async function initializeDocument() {
  try {
    const current = await api('/draft');
    documentKey = 'litura:' + current.id + ':';
    document.getElementById('document-name').textContent = current.path.split(/[\\/]/).pop();
    document.getElementById('document-name').title = current.path;
    diskText = current.text; diskRevision = current.revision;
    const cached = docStorage.getItem('wa-working');
    workView.dispatch({ changes: { from: 0, to: workView.state.doc.length, insert: cached ?? current.text } });
    loadingDocument = false;
    editorSetReadonly(workView, false);
    // The text that was already here is not something the writer just
    // finished. Automatic review is on by default, and opening a draft must
    // not spend a model call on it — auditing the whole document is what
    // `Review draft` is for. A paragraph the writer touches gets a new key
    // and is checked then.
    for (const paragraph of reviewParagraphs(workView.state.doc.toString())) checkedSentences.add(paragraph.key);
    syncReviewLabel();
    savePaused = false;
    restoreFindings(); restoreChat();
    if (cached !== null && cached !== current.text) promptDiskDrift(current);
    else saveStatus.textContent = 'Saved';
    const legacy = localStorage.getItem('wa-working');
    if (legacy !== null && legacy !== current.text && !docStorage.getItem('legacy-offered')) {
      const recover = chatEl('button', 'chat-again', 'Export draft from the previous Litura version');
      recover.addEventListener('click', () => { exportText(legacy, 'legacy-draft.md'); docStorage.setItem('legacy-offered', 'yes'); recover.remove(); });
      chatAdd(recover);
    }
  } catch (error) {
    saveStatus.textContent = 'Cannot open draft: ' + error.message;
    const retry = chatEl('button', 'chat-again', 'Retry opening document');
    retry.addEventListener('click', () => { retry.remove(); initializeDocument(); });
    chatAdd(retry);
  }
}
initializeDocument();
async function checkDiskDrift() {
  if (loadingDocument || saving || diskPrompt?.open) return;
  try {
    const current = await api('/draft');
    if (current.revision !== diskRevision) promptDiskDrift(current);
  } catch (error) { saveStatus.textContent = 'Cannot check disk: ' + error.message; }
}
window.addEventListener('focus', checkDiskDrift);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { checkDiskDrift(); refreshUpdate(); } });
window.addEventListener('beforeunload', event => {
  if (!loadingDocument && (saving || workView.state.doc.toString() !== diskText)) { event.preventDefault(); event.returnValue = ''; }
});
document.getElementById('file-new').addEventListener('click', () => {
  if (workView.state.doc.length) { loadFromDisk(''); save(); }
  workView.focus();
});
document.getElementById('file-export').addEventListener('click', () => {
  const modal = dialog('Save as new file');
  const form = chatEl('form', 'save-as-form');
  const label = chatEl('label', '', 'File name');
  const input = document.createElement('input');
  input.required = true;
  input.value = document.getElementById('document-name').textContent;
  label.append(input);
  const actions = chatEl('div', 'save-as-actions');
  const cancel = chatEl('button', '', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', () => modal.close());
  const submit = chatEl('button', '', 'Save');
  submit.type = 'submit';
  actions.append(cancel, submit);
  form.append(label, actions);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const name = input.value.trim();
    exportText(workView.state.doc.toString(), /\.[a-z0-9]+$/i.test(name) ? name : `${name}.md`);
    modal.close();
  });
  modal.append(form);
  input.focus(); input.select();
});
document.addEventListener('keydown', event => {
  if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return;
  event.preventDefault(); clearTimeout(diskTimer); flushSave();
});
async function importFile(file) {
  if (!file || loadingDocument) return;
  if (file.size > 1024 * 1024 || !/\.(md|markdown|txt)$/i.test(file.name)) { alert('Open a Markdown or text file under 1 MB.'); return; }
  try {
    const text = await file.text();
    if (!confirm(`Import ${file.name} into this workspace draft? The current text will be kept in History.`)) return;
    loadFromDisk(text); save();
  } catch (error) { saveStatus.textContent = 'Import failed: ' + error.message; }
}
// Document menu. The popover gives light dismiss, Escape and the top layer;
// only the anchoring and "close after choosing" are left to do.
const documentMenu = document.getElementById('document-menu');
const documentMenuButton = document.getElementById('document-menu-button');
documentMenuButton.addEventListener('click', () => {
  const box = documentMenuButton.getBoundingClientRect();
  documentMenu.style.left = `${box.left}px`;
  documentMenu.style.top = `${box.bottom + 6}px`;
});
documentMenu.addEventListener('click', event => { if (event.target.closest('button')) documentMenu.hidePopover(); });

const fileInput = document.getElementById('file-input');
document.getElementById('file-open').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { importFile(fileInput.files[0]); fileInput.value = ''; });
editorWrap.addEventListener('dragover', event => event.preventDefault());
editorWrap.addEventListener('drop', event => { event.preventDefault(); importFile(event.dataTransfer?.files?.[0]); });
// Every version is one row: when it was kept, why, and the first line of it,
// so the writer picks by reading rather than by expanding each one in turn.
document.getElementById('file-history').addEventListener('click', async () => {
  const modal = dialog('Document history');
  const current = workView.state.doc.toString();
  const list = chatEl('div', 'history-list');
  modal.append(list);
  try {
    const { snapshots } = await api('/draft/history');
    const local = JSON.parse(docStorage.getItem('snapshots') || '[]');
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key.startsWith(documentKey + 'wa-working:') && !key.endsWith(':' + tabId)) {
        const text = localStorage.getItem(key);
        if (text !== current) local.push({ text, at: new Date().toISOString(), label: 'Copy from another tab' });
      }
    }
    const versions = [...local, ...snapshots].sort((a, b) => b.at.localeCompare(a.at));
    for (const item of versions) {
      const row = chatEl('div', 'history-item');
      const words = item.text.match(/\S+/g)?.length ?? 0;
      row.append(chatEl('div', 'history-when',
        `${new Date(item.at).toLocaleString()} · ${item.label || 'Saved to disk'} · ${words} ${words === 1 ? 'word' : 'words'}`));
      row.append(chatEl('div', 'history-excerpt',
        item.text.trim().replace(/\s+/g, ' ').slice(0, 120) || 'Empty document'));
      if (item.text === current) {
        row.append(chatEl('div', 'history-current', 'Same as the text you have now'));
      } else {
        const full = document.createElement('details');
        full.append(chatEl('summary', '', 'Full text'), chatEl('pre', 'passage-preview', item.text));
        const restore = chatEl('button', '', 'Restore');
        restore.addEventListener('click', () => {
          if (confirm('Restore this version? The current text is kept in History.')) { loadFromDisk(item.text); save(); modal.close(); }
        });
        row.append(full, restore);
      }
      list.append(row);
    }
    if (!versions.length) list.append(chatEl('p', '', 'No previous versions yet. One is kept before every save, import, and AI replacement.'));
    modal.append(chatEl('small', 'history-note',
      'Last 20 disk versions and 10 browser checkpoints. Disk copies sit beside the draft in .litura-history and are never deleted automatically.'));
  } catch (error) { list.append(chatEl('p', 'chat-error', error.message)); }
});

// ─── Initial focus ─────────────────────────────────────────────────────────────

workView.scrollDOM.addEventListener('scroll', layoutRail, { passive: true });
workView.focus();
syncStyleScore();
