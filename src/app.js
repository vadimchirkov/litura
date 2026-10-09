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
import { findingContext, isLatinScript, locateFindings, styleMarkers, styleScore } from '../review.js';
import { renderMarkdown } from '../markdown.js';
import { clampBubble, replacementTarget, newerVersion, resolveDrift, unwrapProse } from '../editing.js';
import { EDITS_OPEN, chatVisibleText, locateChatEdits, mapChatEdit, chatEditMatches } from '../chat-edits.js';
import { loadSpellDictionary, noteSpellingAdded, spellingMarkers } from '../spellcheck.js';
import { searchKeymap } from '@codemirror/search';
import { hydrateIcons } from './icons.js';

// Static markup names Tabler icons with <span class="ph" data-icon="…">;
// this fills them from the single map in icons.js.
hydrateIcons();

// Naming a shortcut with the wrong modifier is worse than not naming it.

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
const suggestProviderEl = document.getElementById('suggest-provider');
const suggestModelEl = document.getElementById('suggest-model');
const suggestHint   = document.getElementById('suggest-hint');
const reviewButton  = document.getElementById('review-button');
const chatStream    = document.getElementById('chat-stream');
const chatInput     = document.getElementById('chat-input');
const chatChip      = document.getElementById('chat-chip');
const chatChipText  = document.getElementById('chat-chip-text');
const chatChipClear = document.getElementById('chat-chip-clear');
const chatSendButton = document.getElementById('chat-send');
const chatClear     = document.getElementById('chat-clear');
const chatPill      = document.getElementById('chat-pill');
const chatPillLabel = document.getElementById('chat-pill-label');
const scoreEl       = document.getElementById('style-score');
const scoreValueEl  = document.getElementById('style-score-value');
const scoreCountEl  = document.getElementById('style-score-count');
const scoreDetails = document.getElementById('style-details');
const detailsCountEl = document.getElementById('style-details-count');
const scoreReviewRun = document.getElementById('style-review-run');
const scoreReviewStatus = document.getElementById('style-review-status');
const scoreRemarkList = document.getElementById('style-remark-list');
const editFeedback = document.getElementById('edit-feedback');
const chatPanel     = document.getElementById('chat');
const autoReviewEl  = document.getElementById('auto-review');
const updateCheckEl = document.getElementById('update-check');
const themeToggleEl = document.getElementById('theme-toggle');
const updateBadge   = document.getElementById('update-badge');
const updateStatus  = document.getElementById('update-status');
const updateSection = document.getElementById('settings-updates');

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
// The header no longer shows the file name; `Save as new…` still needs it to
// prefill its field.
let documentName = '';
let diskRevision = null;
let diskText = null;
let diskTimer = null;
let saving = false;
let savePaused = true;
// A disk conflict pauses disk writes only: the draft, the suggestions and
// the assistant keep working on the local copy. savePaused above is the
// heavier brake — save errors and loading — which still gates everything.
let diskHold = false;
let loadingDocument = true;
let editVersion = 0;
// ─── Notices ───
// One surface for everything the app tells the writer outside the
// conversation: a failed save, a refused model call, a dismissal that can be
// undone. One notice at a time, so nothing is said twice — a new one replaces
// the last. Passing notices fade on their own; a sticky one (a problem) stays
// until its button or × puts it away, and no passing notice may cover it.
// `key` names who raised it, so only they clear it (clearNotice).
// The notice is a view of the conversation island (#edit-feedback lives
// inside #chat): while one is shown the pill steps aside for it, like an
// iPhone alert expanding the island. Tapping the notice opens the chat.
const NOTICE_MS = 8000;
let noticeTimer = null;
let noticeKey = '';
let noticeSticky = false;
// A notice never covers a focused field — keystrokes must not fall into the
// void. While the writer types, the notice parks here (one slot: the next
// notice replaces a parked one, like shown ones do) and flushes on blur.
let pendingNotice = null;
function notify(text, { action = null, label = 'Undo', sticky = false, detail = '', key = '', icon = 'info', tone = '' } = {}) {
  if (!text) {
    clearTimeout(noticeTimer);
    editFeedback.hidden = true;
    chatPanel.classList.remove('has-notice');
    if (key === '' || (pendingNotice && pendingNotice.key === key)) pendingNotice = null;
    noticeKey = ''; noticeSticky = false;
    return;
  }
  if (noticeSticky && !sticky && !editFeedback.hidden) return;
  // A passing notice waits for the field's blur rather than covering typing.
  // A problem does not: it is usually the answer to what was just sent from
  // that field, and parked it stayed invisible while the writer waited.
  if (document.activeElement === chatInput && !sticky) { pendingNotice = { text, key, opts: { action, label, sticky, detail, key, icon, tone } }; return; }
  pendingNotice = null;
  showNotice(text, { action, label, sticky, detail, key, icon, tone });
}
function showNotice(text, { action = null, label = 'Undo', sticky = false, detail = '', key = '', icon = 'info', tone = '' } = {}) {
  clearTimeout(noticeTimer);
  editFeedback.replaceChildren();
  if (icon) {
    const badge = chatEl('span', 'ph notice-icon', '');
    badge.dataset.icon = icon;
    badge.setAttribute('aria-hidden', 'true');
    editFeedback.append(badge);
  }
  const message = chatEl('span', '', text);
  message.title = detail || text;
  editFeedback.append(message);
  if (action) {
    const run = chatEl('button', 'edit-feedback-undo', label);
    run.type = 'button';
    run.addEventListener('click', () => { notify(''); action(); });
    editFeedback.append(run);
  }
  const close = chatEl('button', 'edit-feedback-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Hide notice');
  close.addEventListener('click', () => { notify(''); workView.focus(); });
  editFeedback.append(close);
  hydrateIcons(editFeedback);
  if (tone) editFeedback.dataset.tone = tone; else delete editFeedback.dataset.tone;
  editFeedback.hidden = false;
  chatPanel.classList.add('has-notice');
  noticeKey = key;
  noticeSticky = sticky;
  if (!sticky) noticeTimer = setTimeout(() => notify(''), NOTICE_MS);
}
// A notice under the pointer is being read or about to be pressed: it must
// not fade out from under the hand. Leaving restarts the full count.
editFeedback.addEventListener('mouseenter', () => clearTimeout(noticeTimer));
editFeedback.addEventListener('mouseleave', () => {
  if (noticeSticky || editFeedback.hidden) return;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => notify(''), NOTICE_MS);
});
// Summoning the composer dismisses a passing notice: the island shows either
// the input or the notice, never both. A sticky problem stays until its own
// action or × — it keeps the input covered until then.
function dismissPassingNotice() {
  if (!noticeSticky && !editFeedback.hidden) notify('');
}
chatInput.addEventListener('blur', event => {
  if (!pendingNotice) return;
  // Focus moving within the island (Send, chip clear) is still the composer
  // at work — the parked notice waits for a real leave.
  if (event.relatedTarget && chatPanel.contains(event.relatedTarget)) return;
  const parked = pendingNotice;
  pendingNotice = null;
  notify(parked.text, parked.opts);
});
function clearNotice(key) { if (noticeKey === key) notify(''); }
const reviewStatus = document.getElementById('review-status');
let reviewState = 'idle';
let reviewNotice = '';
// One header line, truncated when the window is narrow — the title keeps the
// whole message reachable instead of pushing the draft down a row.
// "Suggesting…" never touches this line: it lives only in the island's pill
// (syncPill), so a finished review cannot wipe it and it cannot wipe a review.
function setReviewStatus(text, detail, from = 'review') {
  if (from === 'suggest') {
    suggestWorking = text.endsWith('…') ? text : '';
    syncPill();
    if (text && !suggestWorking) notify(text, { detail });
    return;
  }
  if (from === 'review') { reviewNotice = text; syncReviewPanel(); }
  // Progress ("Suggesting…") stays on this line; anything to read is a notice.
  const progress = text.endsWith('…');
  reviewStatus.textContent = progress ? text : '';
  reviewStatus.title = progress ? text : '';
  reviewStatus.dataset.from = progress ? from : '';
  syncPill();
  if (text && !progress) notify(text, { detail });
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
    // Retrying a rejected key, a missing model or an oversized draft only
    // fails again; all but the draft are fixed in settings.
    act: [401, 402, 403, 404].includes(status) ? 'settings' : status === 413 ? null : 'retry',
    detail,
  };
}

// The message is the cause; the button is the answer to it. Every failure the
// writer can act on takes this shape — a bare retry pill with no sentence
// beside it is a button for a problem that was never named.
// A retry that rejects puts the way out back.
function notifyProblem(problem, retry = null, label = 'Try again', key = '') {
  const act = problem.act === 'settings' ? { action: openSettings, label: 'Open settings' }
    : problem.act === 'retry' && retry
      ? { action: () => Promise.resolve().then(retry).catch(() => notifyProblem(problem, retry, label, key)), label }
      : {};
  notify(problem.say, { ...act, sticky: true, detail: problem.detail, key, icon: 'alert', tone: 'error' });
}
let tabId;
try {
  tabId = sessionStorage.getItem('litura-tab') || crypto.randomUUID();
  sessionStorage.setItem('litura-tab', tabId);
} catch { tabId = crypto.randomUUID(); }
const docStorage = {
  getItem(key) { try { return documentKey ? (key === 'wa-working' ? localStorage.getItem(documentKey + key + ':' + tabId) : null) ?? localStorage.getItem(documentKey + key) : null; } catch { return null; } },
  setItem(key, value) { try { if (documentKey) { localStorage.setItem(documentKey + key, value); if (key === 'wa-working') localStorage.setItem(documentKey + key + ':' + tabId, value); } } catch { notify('Browser backup unavailable — keep this tab open until saved', { sticky: true, key: 'backup' }); } },
  removeItem(key) { try { if (documentKey) localStorage.removeItem(documentKey + key); } catch {} },
};
const jobs = new Set();
// JSON in storage can be stale, truncated, or hand-edited. A corrupt value
// must read as its fallback, never throw at the call site.
function safeJson(value, fallback) {
  try {
    const parsed = JSON.parse(value ?? '');
    return parsed ?? fallback;
  } catch { return fallback; }
}
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
  cancelSuggestion();
  clearTimeout(autoReviewTimer);
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
  docStorage.removeItem('wa-kept-wording');
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
  cancelSuggestion();
  ghostClear(workView);
  localStorage.setItem('wa-agent', JSON.stringify(agentSelection));
}

// ─── Suggestion model ──────────────────────────────────────────────────────
// Continuations fire on nearly every pause, so they get their own cheap model
// while review, rewrite, chat, and /idea keep the default above. The server
// always spends the least reasoning the model allows (see `continuation` in
// pi.js), so there is no reasoning control here — only provider and model.
//
// Preference order, checked against Text Arena creative-writing scores
// (Oct 2026) crossed with price and `off`-level support: GPT-6 Luna (1411,
// $0.10/$0.50 per 1M) ties GPT-5.6 Luna and DeepSeek Flash on quality at a
// third of the input price, and all three switch reasoning off. Higher-ranked
// cheap models (Gemini 3.8 Flash at 1492, GLM-5.3 Flash at 1435) mandate
// reasoning, which would burn deliberation tokens on every keystroke pause —
// the writer may still pick them by hand; they just aren't the default.
const SUGGEST_FALLBACKS = [
  ['openai', 'gpt-6-luna'],
  ['openai', 'gpt-5.6-luna'],
  ['xiaomi', 'mimo-v2.6-flash'],
  ['deepseek', 'deepseek-flash'],
  ['anthropic', 'claude-haiku-4-5'],
];
let suggestSelection = null;
try { suggestSelection = JSON.parse(localStorage.getItem('wa-suggest') || 'null'); } catch {}
let draftSuggest = suggestSelection;

function normalizeSuggest(selection) {
  const model = agentInfo.models.find(item => item.provider === selection?.provider && item.model === selection?.model);
  if (!model) return null;
  return { provider: model.provider, model: model.model };
}

function defaultSuggest() {
  for (const [provider, model] of SUGGEST_FALLBACKS) {
    if (agentInfo.models.some(item => item.provider === provider && item.model === model)) return { provider, model };
  }
  return normalizeSelection(agentSelection);
}

function activeSuggestAgent() {
  return normalizeSuggest(suggestSelection) ?? defaultSuggest();
}

function saveSuggestSelection() {
  const normalized = normalizeSuggest(draftSuggest);
  if (!normalized) return;
  draftSuggest = normalized;
  suggestSelection = normalized;
  cancelSuggestion();
  ghostClear(workView);
  localStorage.setItem('wa-suggest', JSON.stringify(suggestSelection));
}

// ── Combobox ──
//
//  Six hundred models do not fit a <select>, and a native datalist cannot
//  stand in: its popup never reaches the top layer above a modal dialog, and a
//  field that already holds an answer filters the writer's typing against it.
//  So: a trigger that names the choice, and a popover with a search box and a
//  list. The popover API still does the top layer, light dismiss and Escape.
const combos = new WeakMap();
// Hundreds of rows are never all needed: the writer types to narrow, and the
// first screenful plus a count is enough to show the filter is working.
const COMBO_LIMIT = 50;

function combobox(trigger) {
  const popover = document.getElementById(trigger.getAttribute('popovertarget'));
  const search = popover.querySelector('.combo-search');
  const list = popover.querySelector('.combo-list');
  const empty = popover.querySelector('.combo-empty');
  const count = popover.querySelector('.combo-count');
  const state = { options: [], value: '', render, trigger };
  combos.set(trigger, state);
  // Wire the listbox pattern: the search owns the popup and names the active
  // row, so a screen reader follows ArrowUp/Down/Home/End as well as typing.
  const listId = `${popover.id}-list`;
  list.id = listId;
  search.setAttribute('role', 'combobox');
  search.setAttribute('aria-controls', listId);
  search.setAttribute('aria-expanded', 'false');

  function setActive(item) {
    for (const child of list.children) child.classList.remove('is-active');
    if (item) {
      item.classList.add('is-active');
      item.scrollIntoView({ block: 'nearest' });
      search.setAttribute('aria-activedescendant', item.id);
    } else {
      search.removeAttribute('aria-activedescendant');
    }
  }

  function render() {
    const query = search.value.trim().toLowerCase();
    const matched = state.options.filter(option => !query
      || option.label.toLowerCase().includes(query)
      || option.value.toLowerCase().includes(query));
    const shown = matched.slice(0, COMBO_LIMIT);
    list.replaceChildren(...shown.map((option, index) => {
      const item = chatEl('button', 'combo-item', '');
      item.type = 'button';
      item.id = `${listId}-${index}`;
      item.dataset.value = option.value;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(option.value === state.value));
      item.append(chatEl('span', '', option.label));
      return item;
    }));
    empty.hidden = matched.length > 0;
    search.removeAttribute('aria-activedescendant');  // rows were just rebuilt
    if (count) count.textContent = !state.options.length ? ''
      : matched.length > shown.length ? `Showing ${shown.length} of ${matched.length}` : '';
  }

  // The popover is positioned, not anchored: a scroll, resize or dialog move
  // after opening leaves it floating where the trigger was. Re-measure while
  // it is open so it follows the field instead.
  function reposition(force) {
    if (!force && !popover.matches(':popover-open')) return;
    const box = trigger.getBoundingClientRect();
    const width = Math.max(box.width, 260);
    popover.style.left = `${Math.min(box.left, window.innerWidth - width - 8)}px`;
    popover.style.top = `${box.bottom + 4}px`;
    popover.style.width = `${width}px`;
  }
  state.reposition = reposition;

  // beforetoggle is synchronous, before the first paint; toggle fires a task
  // later, which is long enough to flash the popover at its default position.
  popover.addEventListener('beforetoggle', event => {
    if (event.newState === 'open') reposition(true);
  });
  popover.addEventListener('toggle', event => {
    search.setAttribute('aria-expanded', String(event.newState === 'open'));
    if (event.newState !== 'open') { search.removeAttribute('aria-activedescendant'); return; }
    search.value = '';   // the search starts empty, never at the current answer
    render();
    // Open where the writer already is: the current choice, not the top of a
    // list of six hundred. Enter with nothing typed then changes nothing.
    const current = list.querySelector('[aria-selected="true"]');
    setActive(current);
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
    const at = items.findIndex(item => item.classList.contains('is-active'));
    let next;
    if (event.key === 'ArrowDown') next = items[Math.min(at + 1, items.length - 1)] ?? items[0];
    else if (event.key === 'ArrowUp') next = items[Math.max(at - 1, 0)] ?? items[0];
    else if (event.key === 'Home') next = items[0];
    else if (event.key === 'End') next = items[items.length - 1];
    else return;
    event.preventDefault();
    setActive(next ?? null);
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
combobox(suggestProviderEl);
combobox(suggestModelEl);

// One open popover at most follows its field; closed ones cost nothing.
for (const event of ['resize', 'scroll']) {
  window.addEventListener(event, () => {
    for (const popover of document.querySelectorAll('.combo:popover-open')) {
      const trigger = document.querySelector(`[popovertarget="${popover.id}"]`);
      combos.get(trigger)?.reposition?.();
    }
  }, { passive: true, capture: true });
}

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

function renderSuggestSettings() {
  draftSuggest = normalizeSuggest(draftSuggest) ?? defaultSuggest();
  const providerIds = [...new Set(agentInfo.models.map(model => model.provider))];
  setOptions(suggestProviderEl, providerIds.map(id => ({
    value: id,
    label: agentInfo.providers.find(provider => provider.id === id)?.name ?? id,
  })), draftSuggest?.provider);
  const models = agentInfo.models.filter(model => model.provider === fieldValue(suggestProviderEl));
  setOptions(suggestModelEl, models.map(model => ({ value: model.model, label: model.name || model.model })), draftSuggest?.model);
  const model = models.find(item => item.model === fieldValue(suggestModelEl));
  draftSuggest = model ? { provider: model.provider, model: model.model } : null;
  suggestHint.textContent = !agentInfo.models.length
    ? 'Add an API key or configure Pi authentication to see models.'
    : draftSuggest
      ? `Continuations use ${model.name || model.model}; review, rewrites, chat, and /idea use the default model above.`
      : '';
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
  // Read text first: a non-JSON error page (proxy, gateway) must still leave
  // something to report instead of dying in res.json() with a SyntaxError.
  const raw = await response.text().catch(() => '');
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; }
  catch { data = { error: raw.slice(0, 200) || `HTTP ${response.status}` }; }
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function refreshAgent() {
  agentInfo = await api('/api/agent/status');
  const savedNormalized = normalizeSelection(agentSelection);
  if (savedNormalized) {
    // Saved model still exists in current catalog — keep it.
    agentSelection = savedNormalized;
    localStorage.setItem('wa-agent', JSON.stringify(agentSelection));
  }
  // If saved model not in current catalog, do NOT overwrite with default.
  // Leave the stale selection in localStorage so the user sees it in
  // settings and can re-pick. The defaultSelection is only used when
  // there is no saved selection at all.
  else if (!agentSelection && agentInfo.defaultSelection) {
    agentSelection = normalizeSelection(agentInfo.defaultSelection);
    if (agentSelection) localStorage.setItem('wa-agent', JSON.stringify(agentSelection));
  }
  // Unlike the default model, a stale suggestion pick is migrated, not kept:
  // it names no voice the writer chose, only a cost optimization, and a dead
  // default would silently bill keystrokes to the expensive model.
  suggestSelection = normalizeSuggest(suggestSelection) ?? defaultSuggest();
  if (suggestSelection) localStorage.setItem('wa-suggest', JSON.stringify(suggestSelection));
  else localStorage.removeItem('wa-suggest');
  return agentInfo;
}

async function openSettings() {
  settingsError.textContent = '';
  try { await refreshAgent(); } catch (error) { settingsError.textContent = error.message; }
  await refreshOAuth();
  draftSelection = currentAgent();
  draftSuggest = suggestSelection;
  renderModelSettings();
  renderSuggestSettings();
  renderCredentials();
  renderSubscriptions();
  syncKeyAdd();
  if (!settingsDialog.open) settingsDialog.showModal();
  else pollOAuth();
}

settingsOpen.addEventListener('click', openSettings);
settingsDialog.querySelector('.dialog-close').addEventListener('click', () => settingsDialog.close());

// Without a model every AI action fails in the console and the editor just
// looks broken. Send the writer to the one place that fixes it instead.
async function ensureAgent() {
  if (loadingDocument) { notify('Wait until the draft is loaded'); return false; }
  if (currentAgent()) return true;
  // The status call may still be in flight on a fresh load — ask once more
  // before telling the writer their setup is missing.
  try { await refreshAgent(); } catch {}
  if (currentAgent()) return true;
  notify('No model selected — add an API key or pick a model in settings.');
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
suggestProviderEl.addEventListener('change', () => {
  const first = agentInfo.models.find(model => model.provider === fieldValue(suggestProviderEl));
  if (first) draftSuggest = { provider: first.provider, model: first.model };
  renderSuggestSettings();
  saveSuggestSelection();
});
suggestModelEl.addEventListener('change', () => {
  draftSuggest = { provider: fieldValue(suggestProviderEl), model: fieldValue(suggestModelEl) };
  renderSuggestSettings();
  saveSuggestSelection();
});

// A popover left open behind a closed dialog comes back with it.
settingsDialog.addEventListener('close', () => {
  stopOAuthPoll();
  for (const popover of document.querySelectorAll('.combo')) {
    if (popover.matches(':popover-open')) popover.hidePopover();
  }
});
thinkingEl.addEventListener('change', () => {
  if (draftSelection) draftSelection = { ...draftSelection, thinkingLevel: fieldValue(thinkingEl) };
  saveAgentSelection();
});
keyProviderEl.addEventListener('change', renderCredentials);

// The settings form has no method="dialog" on purpose: Enter in the key field
// adds the key (below) instead of closing the whole dialog. Stop any implicit
// submit from navigating or dismissing as well.
document.getElementById('settings-form').addEventListener('submit', event => event.preventDefault());

const keyToggleEl = document.getElementById('key-toggle');
function syncKeyAdd() {
  keyAddEl.disabled = !apiKeyEl.value.trim();
}
apiKeyEl.addEventListener('input', syncKeyAdd);
apiKeyEl.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !keyAddEl.disabled) { event.preventDefault(); keyAddEl.click(); }
});
keyToggleEl.addEventListener('click', () => {
  const show = apiKeyEl.type === 'password';
  apiKeyEl.type = show ? 'text' : 'password';
  keyToggleEl.textContent = show ? 'Hide' : 'Show';
  keyToggleEl.setAttribute('aria-label', show ? 'Hide API key' : 'Show API key');
  apiKeyEl.focus();
});

async function addProviderKey() {
  if (!apiKeyEl.value.trim()) return;
  settingsError.textContent = '';
  keyAddEl.disabled = true;
  try {
    agentInfo = await api('/api/agent/credentials', {
      method: 'POST',
      body: JSON.stringify({ provider: keyProviderEl.value, apiKey: apiKeyEl.value }),
    });
    apiKeyEl.value = '';
    syncKeyAdd();
    renderModelSettings();
    renderSuggestSettings();
    renderCredentials();
  } catch (error) { settingsError.textContent = error.message; }
  finally { syncKeyAdd(); }
}
keyAddEl.addEventListener('click', addProviderKey);

async function removeProviderKey(provider) {
  settingsError.textContent = '';
  try {
    agentInfo = await api('/api/agent/credentials', { method: 'DELETE', body: JSON.stringify({ provider }) });
    renderModelSettings();
    renderSuggestSettings();
    renderCredentials();
    await refreshOAuth();
  } catch (error) { settingsError.textContent = error.message; }
}

// ─── Subscription sign-in (OAuth) ──────────────────────────────────────────
// Only allowlisted providers (see pi.js) — currently ChatGPT Plus/Pro via the
// Codex OAuth flow. The server runs Pi's login in the background; here we
// show the auth URL (or device code), offer the manual-paste fallback, and
// poll until the flow settles.
const oauthProvidersEl = document.getElementById('oauth-providers');
const oauthFlowEl   = document.getElementById('oauth-flow');
const oauthStatusEl = document.getElementById('oauth-status');
const oauthUrlWrap  = document.getElementById('oauth-url-wrap');
const oauthUrlEl    = document.getElementById('oauth-url');
const oauthDeviceWrap = document.getElementById('oauth-device-wrap');
const oauthDeviceLink = document.getElementById('oauth-device-link');
const oauthDeviceCode = document.getElementById('oauth-device-code');
const oauthPasteWrap = document.getElementById('oauth-paste-wrap');
const oauthCodeEl   = document.getElementById('oauth-code');
const oauthSendEl   = document.getElementById('oauth-send');
const oauthCancelEl = document.getElementById('oauth-cancel');
let oauthInfo = { supported: [], active: null };
let oauthTimer = null;

function stopOAuthPoll() {
  if (oauthTimer) { clearTimeout(oauthTimer); oauthTimer = null; }
}

function oauthActivePending() {
  const step = oauthInfo.active?.step;
  return step === 'starting' || step === 'url' || step === 'device';
}

function renderSubscriptions() {
  oauthProvidersEl.replaceChildren(...oauthInfo.supported.map(provider => {
    const chip = document.createElement('div');
    chip.className = 'key-chip';
    const dot = document.createElement('i');
    const name = document.createElement('span');
    name.textContent = `${provider.label ?? provider.name} · ${provider.configured ? 'connected' : 'not connected'}`;
    chip.append(dot, name);
    if (provider.configured) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Sign out';
      remove.title = `Sign out of ${provider.label ?? provider.name}`;
      remove.addEventListener('click', () => removeProviderKey(provider.id));
      chip.append(remove);
    } else {
      const signin = document.createElement('button');
      signin.type = 'button';
      signin.textContent = 'Sign in';
      signin.title = `Sign in with ${provider.label ?? provider.name}`;
      signin.addEventListener('click', () => startOAuthFlow(provider.id, 'browser'));
      chip.append(signin);
      const device = document.createElement('button');
      device.type = 'button';
      device.textContent = 'Device code';
      device.title = 'Sign in with a code on another device (no local browser callback)';
      device.addEventListener('click', () => startOAuthFlow(provider.id, 'device_code'));
      chip.append(device);
    }
    return chip;
  }));
  renderOAuthFlow();
}

function renderOAuthFlow() {
  const active = oauthInfo.active;
  const pending = oauthActivePending();
  oauthFlowEl.hidden = !active || (!pending && active.step !== 'error');
  if (oauthFlowEl.hidden) { stopOAuthPoll(); return; }
  if (active.step === 'error') {
    oauthStatusEl.textContent = `Sign-in failed: ${active.error ?? 'unknown error'}`;
    oauthUrlWrap.hidden = true;
    oauthDeviceWrap.hidden = true;
    oauthPasteWrap.hidden = true;
    stopOAuthPoll();
    return;
  }
  oauthStatusEl.textContent = active.step === 'device'
    ? 'Waiting for approval on the verification page…'
    : 'Waiting for the browser sign-in to finish…';
  if (active.url) {
    oauthUrlWrap.hidden = false;
    oauthUrlEl.href = active.url;
    oauthUrlEl.textContent = 'sign-in link';
  } else oauthUrlWrap.hidden = true;
  if (active.step === 'device' && active.userCode) {
    oauthDeviceWrap.hidden = false;
    oauthDeviceLink.href = active.verificationUri || '#';
    oauthDeviceCode.textContent = active.userCode;
  } else oauthDeviceWrap.hidden = true;
  // The localhost callback usually completes on its own; the paste box stays
  // for the case it never fires (busy port, hardened browser).
  oauthPasteWrap.hidden = false;
}

async function pollOAuth() {
  stopOAuthPoll();
  if (!settingsDialog.open || !oauthActivePending()) return;
  try {
    const status = await api('/api/agent/oauth/status');
    oauthInfo = status;
    renderSubscriptions();
    if (oauthActivePending()) {
      oauthTimer = setTimeout(pollOAuth, 2000);
    } else if (oauthInfo.active?.step === 'done') {
      await refreshAgent();
      draftSelection = currentAgent();
      renderModelSettings();
      renderSuggestSettings();
      renderCredentials();
    }
  } catch { oauthTimer = setTimeout(pollOAuth, 5000); }
}

async function startOAuthFlow(provider, method) {
  settingsError.textContent = '';
  try {
    oauthInfo = await api('/api/agent/oauth/start', {
      method: 'POST',
      body: JSON.stringify({ provider, method }),
    });
    oauthCodeEl.value = '';
    renderSubscriptions();
    pollOAuth();
  } catch (error) { settingsError.textContent = error.message; }
}

async function refreshOAuth() {
  try {
    oauthInfo = await api('/api/agent/oauth/status');
    renderSubscriptions();
  } catch { /* settings already show the last known state */ }
}

oauthSendEl.addEventListener('click', async () => {
  if (!oauthCodeEl.value.trim()) return;
  settingsError.textContent = '';
  try {
    oauthInfo = await api('/api/agent/oauth/code', {
      method: 'POST',
      body: JSON.stringify({ code: oauthCodeEl.value }),
    });
    oauthCodeEl.value = '';
    renderSubscriptions();
    pollOAuth();
  } catch (error) { settingsError.textContent = error.message; }
});
oauthCancelEl.addEventListener('click', async () => {
  try {
    oauthInfo = await api('/api/agent/oauth/cancel', { method: 'POST' });
    renderSubscriptions();
    pollOAuth();
  } catch (error) { settingsError.textContent = error.message; }
});

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
    effects: [setGhostFx.of({ text, pos, line }), EditorView.announce.of(`Suggestion: ${text.trim()}. Tab to accept; Escape to dismiss.`), EditorView.scrollIntoView(line, { y: 'nearest', yMargin: 72 })],
  });
}

function ghostClear(view) {
  view.dispatch({ effects: clearGhostFx.of(null) });
}

// Accept ghost: insert suggestion text at ghost.pos, move cursor after it
function ghostAccept(view) {
  const ghost = view.state.field(ghostField);
  if (!ghost || view.state.readOnly || !view.hasFocus || !view.state.selection.main.empty) return false;
  view.dispatch({
    changes:   { from: ghost.pos, insert: ghost.text },
    selection: { anchor: ghost.pos + ghost.text.length },
    effects:   clearGhostFx.of(null),
    userEvent: 'input.acceptGhost',
  });
  return true;
}

// ─── Slop review highlights ───────────────────────────────────────────────────

let keptStyle = [];
let localFinding = null;
function saveKeptStyle() {
  docStorage.setItem('wa-kept-wording', JSON.stringify({ document: workView.state.doc.toString(), marks: keptStyle }));
}
function visibleStyleMarkers(text) {
  return styleMarkers(text).filter(marker =>
    !keptStyle.some(kept => kept.state === 'kept' && kept.from === marker.from && kept.to === marker.to && kept.quote === marker.quote));
}

const refreshStyleFx = StateEffect.define();

const styleMarkerField = StateField.define({
  create: state => visibleStyleMarkers(state.doc.toString()),
  update: (markers, tr) => {
    if (tr.docChanged) { for (const kept of keptStyle) mapChatEdit(kept, tr.changes); keptStyle = keptStyle.filter(kept => kept.state !== 'stale'); }
    for (const effect of tr.effects) {
      if (effect.is(refreshStyleFx)) return visibleStyleMarkers(tr.newDoc.toString());
    }
    return tr.docChanged ? visibleStyleMarkers(tr.newDoc.toString()) : markers;
  },
  provide: field => EditorView.decorations.from(field, markers => Decoration.set(markers.map(marker =>
    Decoration.mark({
      class: 'cm-style-marker',
      attributes: { 'data-style-from': String(marker.from), title: 'Possible stock wording — click to explore' },
    }).range(marker.from, marker.to)), true)),
});

// ─── Spelling marks ─────────────────────────────────────────────────────────
//
//  A deterministic, offline check for actual misspellings — distinct from the
//  style tells above, which flag wording choices rather than errors. Fixes
//  are instant word swaps, so they skip the finding-card/model path entirely.
//
// ponytail: dictionary loads once at startup; a word added via the bubble's
// "Ignore" only survives the tab session. Persist to localStorage if writers
// hit the same false positive across reloads.
let spellChecker = null;
const refreshSpellFx = StateEffect.define();
function visibleSpellMarkers(text) {
  return spellingMarkers(text, spellChecker);
}
const spellMarkerField = StateField.define({
  create: state => visibleSpellMarkers(state.doc.toString()),
  update: (markers, tr) => {
    for (const effect of tr.effects) {
      if (effect.is(refreshSpellFx)) return visibleSpellMarkers(tr.newDoc.toString());
    }
    return tr.docChanged ? visibleSpellMarkers(tr.newDoc.toString()) : markers;
  },
  provide: field => EditorView.decorations.from(field, markers => Decoration.set(markers.map(marker =>
    Decoration.mark({
      class: 'cm-spell-marker',
      attributes: { 'data-spell-from': String(marker.from), title: 'Possible misspelling — click for suggestions' },
    }).range(marker.from, marker.to)), true)),
});

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
        // A finding already reads as a background band; the attachment washes
        // over it in its own hue instead of drawing a second shape. The
        // decoration still has to exist — it is what tracks the live
        // position and ends the attachment on an edit — only its look is shared.
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

// ─── Open-variants target ───────────────────────────────────────────────────
//
//  The passage whose options are currently on screen. Options no longer
//  attach to the composer, so without this the draft would give no sign of
//  which phrase is being decided. One live group at a time means one mark.
const setVariantTargetFx = StateEffect.define();

const variantTargetField = StateField.define({
  create: () => Decoration.none,
  update(decorations, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setVariantTargetFx)) {
        return effect.value
          ? Decoration.set([Decoration.mark({ class: 'cm-variant-target' }).range(effect.value.from, effect.value.to)])
          : Decoration.none;
      }
    }
    if (!tr.docChanged) return decorations;
    // An edit inside the passage invalidates the open options with it.
    const edited = [];
    tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => edited.push([fromB, toB]));
    return decorations.map(tr.changes).update({
      filter: (from, to) => !edited.some(([a, b]) => a < to && b > from),
    });
  },
  provide: field => EditorView.decorations.from(field),
});

function markVariantTarget(target) {
  try { workView.dispatch({ effects: setVariantTargetFx.of(target ? { from: target.from, to: target.to } : null) }); } catch {}
}

// The mark follows the last live group: clear it only when no undecided
// group remains on screen, so dismissing one card never steals the mark of
// another card's open options.
function syncVariantTarget() {
  if (!document.querySelector('.chat-variants:not(.is-spent):not(.is-loading)')) markVariantTarget(null);
}

// Live position of a finding — decorations move with the document, the
// from/to captured at review time do not.
function findingRange(id) {
  if (id === -1) return localFinding && chatEditMatches(localFinding, workView.state.doc.toString()) ? { from: localFinding.from, to: localFinding.to } : null;
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
  reviewButton.textContent = reviewButton.disabled ? 'Checking…' : 'Slop';
  syncStyleScore();
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
  if (event.key === 'Escape' && !markBubble.hidden) { hideMarkBubble(); workView.focus(); return; }
  if (event.key === 'Escape' && plainPreview) { clearPlainPreview(); workView.focus(); return; }
  // Last, so the lighter dismissals above still win. On a narrow window the
  // sidebar is a layer over the text, and Escape is how a layer goes away.
  // The composer claims Escape for itself only while it holds a request or an
  // attached passage, and claims it by stopping the event on the way out — so
  // there is nothing left to check here. Tested any looser, the panel became
  // undismissable by key, because the focus is almost always in the draft and
  // the draft has no Escape of its own to spend. The scrim is the way out for
  // a hand that is not on the keyboard.
  if (event.key === 'Escape' && sidebarIsOverlay()) { setSidebar(false); return; }
});
// A press outside the bubble puts it away; a mark click re-opens its own on
// the following click event, so hiding here never swallows an opening.
document.addEventListener('mousedown', event => {
  if (!markBubble.hidden && !markBubble.contains(event.target)) hideMarkBubble();
}, true);
// Selecting with the mouse offers the one explicit context action; keyboard
// selections keep Cmd+K. Copying is acting on the text, not asking — no bubble.
document.addEventListener('mouseup', event => {
  if (!workView.dom.contains(event.target)) return;
  if (event.button === 2) return;
  if (workView.state.selection.main.empty) return;
  const { clientX, clientY } = event;
  deferBubble(() => showSelectionBubble(clientX, clientY), 250);
});
document.addEventListener('copy', () => { if (bubbleMode === 'selection') hideMarkBubble(); });
// Disagreeing with a finding has to be as cheap as accepting one, or the
// counter keeps advertising work the writer already rejected.
function dismissFinding(id) {
  if (id === -1) { if (localFinding) keepStyleMarker(localFinding); return; }
  const finding = reviewFindings.find(item => item.id === id);
  const document = workView.state.doc.toString();
  const range = findingRange(id);
  const dismissed = safeJson(docStorage.getItem('dismissed'), []);
  const decision = finding && { code: finding.code, quote: finding.quote, context: findingContext(document, { ...finding, ...range }) };
  if (decision) dismissed.push(decision);
  docStorage.setItem('dismissed', JSON.stringify(dismissed.slice(-100)));
  reviewFindings = reviewFindings.filter(finding => finding.id !== id);
  const card = findingCards.get(id);
  if (card) { railAnchors.delete(card); railHomes.delete(card); fadeRemove(card); }
  findingCards.delete(id);
  workView.dispatch({ effects: dropReviewFx.of(id) });
  hideMarkBubble();
  if (activeFinding?.id === id) detach();
  else clearPlainPreview();
  refocusAfterRemoval(id);
  saveFindings();
  syncVariantTarget();
  syncReviewLabel();
  workView.focus();
  if (decision) notifyUndo('Kept as is', () => {
    const saved = safeJson(docStorage.getItem('dismissed'), []);
    docStorage.setItem('dismissed', JSON.stringify(saved.filter(item => JSON.stringify(item) !== JSON.stringify(decision))));
    if (workView.state.doc.toString() === document) { mergeFindings([finding]); syncReviewLabel(); }
    else setReviewStatus('Dismissal undone. Check again to cover the changed text.');
  });
}

// A full review costs two model calls. Losing it to a reload is the writer
// paying twice for the same answer, so the findings outlive the page.
function saveFindings() {
  const live = reviewFindings
    .filter(finding => findingRange(finding.id))
    .map(({ code, quote, pattern, reason, fix }) => ({ code, quote, pattern, reason, fix }));
  docStorage.setItem('wa-findings', JSON.stringify({ document: workView.state.doc.toString(), findings: live, state: reviewState }));
}

function restoreFindings() {
  let saved = [];
  try { saved = JSON.parse(docStorage.getItem('wa-findings') || '[]'); } catch {}
  reviewState = saved.document === workView.state.doc.toString() ? (saved.state || 'partial') : saved.document ? 'stale' : 'idle';
  if (saved.document === workView.state.doc.toString() && saved.findings?.length && mergeFindings(saved.findings)) syncReviewLabel();
}

function clearReview() {
  clearNotice('undo');
  discardFindingCards();
  for (const stale of document.querySelectorAll('.chat-variants')) stale.remove();
  clearPlainPreview();
  reviewFindings = [];
  checkedSentences.clear();
  workView.dispatch({ effects: setReviewFx.of([]) });
  markVariantTarget(null);
  docStorage.removeItem('wa-findings');
  syncReviewLabel();
}

// Anchor findings against the document as it is *now* and merge them in —
// the request may have been in flight while the writer kept typing.
function mergeFindings(rawFindings) {
  const document = workView.state.doc.toString();
  const dismissed = safeJson(docStorage.getItem('dismissed'), []);
  const filtered = (rawFindings || []).filter(finding =>
    !reviewFindings.some(item => findingRange(item.id) && item.code === finding.code && item.quote === finding.quote));
  const located = locateFindings(document, filtered)
    .filter(finding => !dismissed.some(item => item.code === finding.code && item.quote === finding.quote &&
      (item.context ? item.context === findingContext(document, finding) : item.document === document)))
    .map(finding => ({ ...finding, id: findingSeq++ }));
  if (!located.length) return 0;
  reviewFindings.push(...located);
  workView.dispatch({ effects: addReviewFx.of(located) });
  saveFindings();
  return located.length;
}

async function reviewRequest(body, replaceAll = false) {
  if (body.document !== workView.state.doc.toString()) throw new Error('Draft changed before the check started. Check again.');
  const version = editVersion;
  // A targeted pass is the automatic one: it runs while the writer types.
  const job = startJob({ background: Boolean(body.target) });
  try {
    const data = await api('/review', {
      method: 'POST', signal: job.signal,
      body: JSON.stringify({ agent: currentAgent(), ...body }),
    });
    if (version !== editVersion) throw new Error('Draft changed during the check. Check again.');
    if (replaceAll) clearReview();
    const added = mergeFindings(data.findings);
    reviewState = data.failedPasses?.length || body.target ? 'partial' : 'complete';
    saveFindings();
    // The marks in the draft are the result. A line announcing that the review
    // finished says nothing the marks do not already say.
    if (data.failedPasses?.length) setReviewStatus(`Partial slop check (${data.failedPasses.join(', ')}) — run again to retry`);
    else if (reviewStatus.dataset.from === 'review') setReviewStatus('');   // the marks are the result
    return { added, complete: !data.failedPasses?.length };
  } finally { finishJob(job); syncStyleScore(); }
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
    setReviewStatus(error.name === 'AbortError' ? 'Slop check stopped — findings kept' : `Slop check failed. ${modelError(error).say}`, error.message);
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
// Experiment: dock Note/Context in the margin and Continue at the caret.
const pillsMarginEl = document.getElementById('pills-margin');
pillsMarginEl.checked = localStorage.getItem('wa-pills') === 'margin';
pillsMarginEl.addEventListener('change', () => {
  pillsMargin = pillsMarginEl.checked;
  localStorage.setItem('wa-pills', pillsMargin ? 'margin' : 'float');
});
let autoSuggestOn = localStorage.getItem('wa-autosuggest') !== 'off';
const autoSuggestEl = document.getElementById('auto-suggest');
autoSuggestEl.checked = autoSuggestOn;
autoSuggestEl.addEventListener('change', () => {
  autoSuggestOn = autoSuggestEl.checked;
  localStorage.setItem('wa-autosuggest', autoSuggestOn ? 'on' : 'off');
  cancelSuggestion(); ghostClear(workView);
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

function renderUpdate({ current, latest, error, managed }) {
  // The desktop shell checks, verifies a signature, and installs. Offering an
  // npm command next to that would name a second, wrong way to update.
  if (managed) {
    updateSection.hidden = true;
    updateBadge.hidden = true;
    return;
  }
  const stale = newerVersion(latest, current);
  updateBadge.hidden = !stale;
  if (stale) {
    updateBadge.textContent = `${latest} available`;
    updateBadge.title = 'Copy npx litura-app to update';
  }
  updateStatus.textContent =
    error  ? `Running ${current} — npm could not be reached.` :
    stale  ? `Running ${current}; npm publishes ${latest}.` :
    latest ? `Running ${current} — the published version.` :
             `Running ${current}.`;
}

updateBadge.addEventListener('click', async () => {
  if (updateBadge.hidden) return;
  const command = 'npx litura-app';
  try {
    await navigator.clipboard.writeText(command);
    updateBadge.textContent = `Copied: ${command}`;
  } catch {
    updateBadge.textContent = `Run: ${command}`;
  }
  updateBadge.title = command;
});

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

let activeStyleFrom = null;
function isScoreOpen() { return scoreDetails.matches(':popover-open'); }
function closeScorePopover() { if (isScoreOpen()) scoreDetails.hidePopover(); }
function liveReviewFindings() {
  return reviewFindings.map(finding => ({ finding, range: findingRange(finding.id) }))
    .filter(item => item.range).sort((a, b) => a.range.from - b.range.from);
}
function reviewStateText() {
  // No running or finished line — the button dims while it works and the
  // marks speak when it lands. Only what needs attention takes the line.
  if (reviewButton.disabled || autoReviewBusy) return '';
  if (reviewNotice) return reviewNotice;
  if (reviewState === 'idle') return 'Not checked yet';
  if (reviewState === 'partial') return 'Partly checked';
  return '';
}
function syncStyleScore() {
  if (typeof workView === 'undefined' || !workView?.state) return;
  const text = workView.state.doc.toString();
  scoreEl.hidden = !text.trim();
  if (scoreEl.hidden) { closeScorePopover(); return; }
  const count = workView.state.field(styleMarkerField).length + liveReviewFindings().length;
  // The trigger names the feature; the pill counts what is waiting. With
  // nothing marked there is no zero — just the invitation to check.
  scoreValueEl.textContent = 'Slop';
  scoreCountEl.hidden = detailsCountEl.hidden = !count;
  scoreCountEl.textContent = detailsCountEl.textContent = count ? String(count) : '';
  scoreEl.title = reviewStateText();
  syncReviewPanel();
  if (isScoreOpen()) renderScoreDetails();
}
function syncReviewPanel() {
  // The button keeps one name in every state; running shows as dimmed, and
  // the status line underneath carries only what needs attention.
  const busy = reviewButton.disabled || autoReviewBusy;
  scoreReviewRun.disabled = busy || loadingDocument;
  scoreReviewRun.textContent = 'Check for slop';
  scoreReviewStatus.textContent = reviewStateText();
  scoreReviewStatus.hidden = !scoreReviewStatus.textContent;
}
function remarkRow(quote, label, reason, open, kind = '') {
  const row = chatEl('button', `style-marker-jump${kind ? ` ${kind}` : ''}`);
  row.type = 'button';
  row.title = reason;  // the card carries the reason in full; the row identifies
  const go = chatEl('i', 'style-marker-go', '›');
  go.setAttribute('aria-hidden', 'true');
  row.append(chatEl('span', '', `“${quote}”`), chatEl('small', '', label), go);
  row.addEventListener('click', () => { closeScorePopover(); open(); });
  return row;
}
function renderScoreDetails() {
  syncReviewPanel();
  const text = workView.state.doc.toString();
  const rows = [
    ...workView.state.field(styleMarkerField).map(marker => ({
      from: marker.from, quote: marker.quote, label: 'Stock wording', reason: marker.reason, kind: '',
      open: () => selectStyleMarker(marker),
    })),
    ...liveReviewFindings().map(({ finding, range }) => ({
      from: range.from, quote: finding.quote, label: finding.pattern, reason: finding.reason, kind: 'is-model',
      open: () => openFinding(finding, true),
    })),
  ].sort((a, b) => a.from - b.from);
  scoreRemarkList.replaceChildren(...rows.map(row => remarkRow(row.quote, row.label, row.reason, row.open, row.kind)));
  if (!rows.length) scoreRemarkList.append(chatEl('p', 'style-details-note',
    reviewState === 'complete' ? 'No slop found.' : 'No slop marked yet. Check the draft to catch stock wording and weak spots.'));
  if (!isLatinScript(text)) scoreRemarkList.append(chatEl('p', 'style-details-note', 'Local wording checks support English; the model check supports this draft.'));
}
function keepStyleMarker(marker) {
  const kept = { ...marker, state: 'kept' };
  keptStyle.push(kept);
  workView.dispatch({ effects: refreshStyleFx.of(null) });
  saveKeptStyle(); removeLocalFinding(); syncStyleScore();
  notifyUndo('Kept this wording here', () => {
    keptStyle = keptStyle.filter(item => item !== kept); saveKeptStyle();
    workView.dispatch({ effects: refreshStyleFx.of(null) }); syncStyleScore();
  });
}
function removeLocalFinding() {
  const card = findingCards.get(-1);
  if (card) { railAnchors.delete(card); railHomes.delete(card); fadeRemove(card); findingCards.delete(-1); }
  localFinding = null;
  if (activeFinding?.id === -1) detach();
}
// `at` is the click point in the draft, and only a click carries one: a row in
// the Slop popover is somewhere else entirely, so it asks for the card centred
// instead. A click is already at the passage and needs no bubble of its own —
// openFinding raises it from the same point.
function selectStyleMarker(marker, at = null) {
  closeScorePopover();
  if (localFinding?.from !== marker.from || localFinding?.quote !== marker.quote) removeLocalFinding();
  localFinding = { ...marker, id: -1, pattern: 'Stock wording', state: 'pending' };
  openFinding(localFinding, !at, at);
}
scoreDetails.addEventListener('beforetoggle', event => { if (event.newState === 'open') renderScoreDetails(); });
scoreDetails.addEventListener('toggle', () => scoreEl.setAttribute('aria-expanded', String(isScoreOpen())));
scoreReviewRun.addEventListener('click', () => runReview());

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
    setReviewStatus(error.name === 'AbortError' ? 'Automatic slop check stopped' : `Automatic slop check failed. ${modelError(error).say}`, error.message);
  } finally {
    autoReviewBusy = false;
    reviewButton.classList.remove('is-busy');
    if (complete || version !== editVersion) autoReviewSchedule();
  }
}

// ─── Suggestion system ─────────────────────────────────────────────────────────

let suggestTimer = null;
let suggestWorking = '';   // "Suggesting…" while a request is out (see setReviewStatus)
let suggestAbort = null;
let suggestVersion = 0;

const SUGGEST_DELAY = 200;   // ms after last keystroke — feels instant, still debounces bursts
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

function cancelSuggestion() {
  suggestVersion++;
  clearTimeout(suggestTimer);
  suggestTimer = null;
  suggestAbort?.abort();
  suggestAbort = null;
  if (suggestWorking) setReviewStatus('', undefined, 'suggest');
}

function suggestSchedule() {
  cancelSuggestion();
  if (!autoSuggestOn || loadingDocument || savePaused || !workView.hasFocus || document.hidden) return;
  const doc = workView.state.doc.toString();
  if (doc.trim().length < SUGGEST_MIN) return;
  if (!atParagraphEnd(workView.state)) return;

  suggestTimer = setTimeout(suggestFetch, SUGGEST_DELAY);
}

// Selection changes cancel both the debounce and the in-flight request, even
// when the selection's head stays at the same offset. Only typing starts work.
function suggestionUpdate(update) {
  if (update.docChanged || update.selectionSet || (update.focusChanged && !update.view.hasFocus) || update.state.readOnly) {
    cancelSuggestion();
  }
  if (update.focusChanged && !update.view.hasFocus) {
    queueMicrotask(() => { if (!update.view.hasFocus) ghostClear(update.view); });
  }
  if (update.docChanged && update.transactions.some(tr => tr.isUserEvent('input.type'))) suggestSchedule();
}

async function suggestFetch(manual = false) {
  suggestTimer = null;
  const view  = workView;
  const state = view.state;
  // The focus guard keeps background suggestions from firing while the writer
  // is elsewhere. An explicit ask is not background: the press itself may be
  // what took focus out of the editor (a bubble button, the settings dialog).
  if (state.readOnly || loadingDocument || savePaused || (!manual && !view.hasFocus) || document.hidden || view.composing) return;
  if (!manual && !autoSuggestOn) return;
  if (!atParagraphEnd(state)) {
    if (manual) setReviewStatus('Place the caret at the end of a paragraph to request a continuation.', undefined, 'suggest');
    return;
  }

  const doc = state.doc.toString();
  const pos = state.selection.main.head;
  if (!doc.trim() || (!manual && doc.trim().length < SUGGEST_MIN)) {
    if (manual) setReviewStatus('Write a few words before requesting a continuation.', undefined, 'suggest');
    return;
  }

  // Don't suggest while on a /idea line
  const line = state.doc.lineAt(pos);
  if (/^\s*\/idea(?:\s|$)/i.test(line.text)) return;

  const version = suggestVersion;
  if (manual && !await ensureAgent()) return;
  const suggestAgent = activeSuggestAgent() ?? currentAgent();
  if (version !== suggestVersion || (!manual && !view.hasFocus) || !suggestAgent) return;
  const agent = suggestAgent;

  const job = startJob({ background: !manual });
  suggestAbort = job;
  const isCurrent = () => suggestAbort === job && !job.signal.aborted && version === suggestVersion
    && !loadingDocument && !savePaused && !document.hidden && (manual || view.hasFocus) && !view.composing
    && !view.state.readOnly && (manual || autoSuggestOn)
    && view.state.doc === state.doc && view.state.selection.eq(state.selection)
    && JSON.stringify(activeSuggestAgent() ?? currentAgent()) === JSON.stringify(agent);
  if (manual) setReviewStatus('Suggesting…', undefined, 'suggest');

  try {
    const res = await fetch('/suggest', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        document: doc,
        cursor:   pos,
        agent,
        manual,
      }),
      signal: job.signal,
    });
    // A background feature that fails in silence looks like a broken one. Say
    // it once in the status line; the next keystroke schedules another try.
    if (!res.ok) {
      // The provider's own status is in the body; the 500 is only our wrapper.
      let errorBody = '{}';
      try { errorBody = await res.text(); } catch {}
      let errorMsg = `HTTP ${res.status}`;
      try {
        const parsed = JSON.parse(errorBody);
        // Unwrap Google-style error objects: {"error":{"message":"...","code":429}}
        if (parsed.error?.message) errorMsg = parsed.error.message;
        else if (parsed.error?.error?.message) errorMsg = parsed.error.error.message;
        else if (parsed.message) errorMsg = parsed.message;
        else if (parsed.error) errorMsg = typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error);
      } catch {}
      const problem = modelError(new Error(errorMsg));
      if (isCurrent()) setReviewStatus(`Suggestions failed. ${problem.say}`, problem.detail, 'suggest');
      return;
    }

    const data = await res.json();

    // Only show if nothing changed while we were waiting
    if (!isCurrent()) return;
    setReviewStatus('', undefined, 'suggest');
    if (data.suggestion) ghostShow(view, data.suggestion);
    else if (manual) setReviewStatus('No continuation to suggest.', undefined, 'suggest');
  } catch (error) {
    if (error.name === 'AbortError') return;
    let errorMsg = error.message;
    // Unwrap nested JSON error strings from server responses
    try {
      const parsed = JSON.parse(errorMsg);
      if (parsed.error?.message) errorMsg = parsed.error.message;
      else if (parsed.error?.error?.message) errorMsg = parsed.error.error.message;
      else if (parsed.message) errorMsg = parsed.message;
    } catch {}
    const problem = modelError(new Error(errorMsg));
    if (isCurrent()) setReviewStatus(`Suggestions failed. ${problem.say}`, problem.detail, 'suggest');
  } finally {
    finishJob(job);
    if (suggestAbort === job) suggestAbort = null;
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
  cancelSuggestion();
  ghostClear(view);

  runIdeaExpansion(view, line).catch(console.error);
  return true;
}

async function runIdeaExpansion(view, line) {
  const target = { from: line.from, to: line.to, text: line.text, document: view.state.doc.toString() };
  if (!await ensureAgent()) return;
  const job = startJob();
  const bubble = chatAdd(chatEl('div', 'chat-entry is-agent', 'Expanding idea… Your draft is unchanged.'));
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
    // Single option, same cards path — no Try again when there is nothing to repeat.
    showVariants([answer.trim()], null, target, null);
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
//  right-click a selection, or click a marked passage, and the passage rides
//  along with whatever you type next.
//

const CHAT_PLACEHOLDER = 'Ask about your draft, or request a rewrite';

let attached = null;   // { from, to, text } — the passage the chip refers to
let activeFinding = null;
// Which remark card stands in the rail — independent of `attached`. Reading a
// mark opens its card; only an explicit action (the bubble, the card's own
// Options, Cmd+K) arms the composer. The marks stay the navigation either way.
let focusedFindingId = null;
// { role, content, display? } — `content` goes to the model, `display` is what
// the writer typed when the two differ (a finding adds context to the message).
let chatHistory = [];
let chatAbort = null;
const chatRequests = new Set();
const chatEditCards = new Map();
let changingChatEdit = null;

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

const reduceMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Discrete jumps glide; token-by-token follow stays instant — smooth scrolling
// lags behind a live stream and stutters.
// Scrollbar only while moving: the class is set on every scroll event (wheel,
// drag, key, or our own chatScroll) and dropped after a quiet moment.
let chatScrollTimer = 0;
chatStream.addEventListener('scroll', () => {
  chatStream.classList.add('is-scrolling');
  clearTimeout(chatScrollTimer);
  chatScrollTimer = setTimeout(() => chatStream.classList.remove('is-scrolling'), 900);
}, { passive: true });

function chatScroll(stick, smooth = false) {
  if (!stick) return;
  const top = chatStream.scrollHeight;
  if (smooth && !reduceMotion()) {
    try { chatStream.scrollTo({ top, behavior: 'smooth' }); return; } catch {}
  }
  chatStream.scrollTop = top;
}

// Bring a node into view without yanking when it is already fully visible.
function scrollToNode(node, block = 'nearest') {
  if (!node?.isConnected) return;
  try { node.scrollIntoView({ block, behavior: reduceMotion() ? 'auto' : 'smooth' }); }
  catch { try { node.scrollIntoView(); } catch {} }
}

// Soft way out: fade first, detach after. Bulk operations (document switch,
// conversation reset) still remove instantly — one farewell at a time.
function fadeRemove(node, ms = 160) {
  if (!node?.isConnected) return;
  if (reduceMotion()) { node.remove(); return; }
  node.classList.add('is-leaving');
  setTimeout(() => node.remove(), ms);
}

function saveChat() {
  docStorage.setItem('wa-chat', JSON.stringify({ document: workView.state.doc.toString(), messages: chatHistory.slice(-20) }));
}
function restoreChat() {
  let saved;
  try { saved = JSON.parse(docStorage.getItem('wa-chat') || 'null'); } catch { return; }
  const messages = Array.isArray(saved) ? saved : saved?.messages;
  if (!Array.isArray(messages)) return;
  chatHistory = messages.filter(message => message && ['user', 'assistant'].includes(message.role) && typeof message.content === 'string').slice(-20);
  for (const message of chatHistory) {
    if (message.role === 'user') streamAppend(chatEl('div', 'chat-entry is-user', message.display ?? message.content));
    else {
      message.edits = Array.isArray(message.edits) ? message.edits.filter(edit => edit && typeof edit.quote === 'string' && typeof edit.replacement === 'string' && typeof edit.label === 'string').slice(0, 8) : [];
      for (const edit of message.edits) {
        if (saved.document !== workView.state.doc.toString() || !chatEditMatches(edit, workView.state.doc.toString())) {
          if (edit.state !== 'unlocated') edit.state = 'stale';
        }
      }
      renderChatAnswer(streamAppend(chatEl('div', 'chat-entry is-agent is-markdown')), message);
    }
  }
  // Folded into the pill by default: history is kept and reopens with it,
  // genuinely new arrivals still open it via chatAdd.
  setChatOpen(false);
  setIsland(false);
}
function renderChatAnswer(reply, message) {
  // Older saved answers may still carry a raw edit list in their text.
  reply.innerHTML = renderMarkdown(chatVisibleText(message.content, true));
  for (const edit of message.edits || []) reply.append(chatEditCard(edit));
}
function chatEditCard(edit) {
  const card = chatEl('section', 'chat-edit-card');
  card.setAttribute('aria-label', edit.label);
  card.append(chatEl('strong', 'chat-edit-title', edit.label));
  card.append(chatEl('p', 'chat-edit-replacement', edit.replacement || '(Remove this passage)'));
  const actions = chatEl('div', 'chat-edit-actions');
  const button = (name, handler) => {
    const node = chatEl('button', 'review-action', name); node.type = 'button';
    node.addEventListener('click', handler); actions.append(node); return node;
  };
  const preview = button('Preview', () => {
    if (!chatEditMatches(edit, workView.state.doc.toString())) return;
    if (plainPreview?.edit === edit) clearPlainPreview();
    else {
      clearPlainPreview();
      workView.dispatch({ effects: EditorView.scrollIntoView(edit.from, { y: 'center' }) });
      showPlainPreview(edit.replacement, edit); plainPreview.edit = edit;
    }
    syncChatEditCards();
  });
  const apply = button('Apply', () => changeChatEdit(edit));
  apply.classList.add('is-primary');
  const keep = button('Keep original', () => { clearPlainPreview(); edit.state = 'kept'; saveChat(); syncChatEditCards(); undo.focus(); });
  // Undo speaks the same receipt language as applied variants: one quiet pill
  // in its own footer row, not another button in the action row.
  const undoFoot = chatEl('div', 'variant-undo-row');
  undoFoot.hidden = true;
  const undo = chatEl('button', 'chat-action', 'Undo');
  undo.type = 'button';
  undo.title = 'Put the passage back as it was';
  undo.addEventListener('click', () => {
    if (edit.state === 'kept') { edit.state = 'pending'; saveChat(); syncChatEditCards(); apply.focus(); }
    else changeChatEdit(edit, true);
  });
  undoFoot.append(undo);
  const refresh = button('Request new edit', () => {
    if (edit.state === 'unlocated') {
      chatInput.value = `Prepare an edit for the passage I select. Previous suggestion: ${edit.label}`;
      chatInput.focus(); return;
    }
    chatInput.value = `Prepare a new edit for the current draft. Previous suggestion: ${edit.label}. Original passage: ${edit.quote}`;
    chatSend();
  });
  const status = chatEl('p', 'chat-edit-status'); status.setAttribute('role', 'status');
  actions.prepend(status);
  card.append(actions, undoFoot);
  chatEditCards.set(edit, { card, actions, preview, apply, keep, undo, undoFoot, refresh, status });
  syncChatEditCard(edit, chatEditCards.get(edit));
  return card;
}
function syncChatEditCard(edit, ui) {
  const valid = chatEditMatches(edit, workView.state.doc.toString());
  const pending = edit.state === 'pending' && valid;
  const showUndo = valid && ['applied', 'kept'].includes(edit.state);
  const appliedNow = valid && edit.state === 'applied';
  ui.preview.hidden = ui.apply.hidden = ui.keep.hidden = !pending;
  ui.undo.hidden = !showUndo;
  ui.undoFoot.hidden = !showUndo;
  // Applied is a receipt: tag in the title, Undo in its footer, nothing else.
  ui.card.classList.toggle('is-applied', appliedNow);
  ui.actions.hidden = appliedNow;
  ui.refresh.hidden = valid;
  ui.refresh.textContent = edit.state === 'unlocated' ? 'Choose passage' : 'Request new edit';
  // Unlocated proposals need an explicit selection, then a fresh response.
  ui.preview.textContent = plainPreview?.edit === edit ? 'End preview' : 'Preview';
  ui.preview.setAttribute('aria-pressed', String(plainPreview?.edit === edit));
  ui.apply.disabled = ui.undo.disabled = workView.state.readOnly || loadingDocument || savePaused;
  // A stale card names no problem — the Request button beside it is the way
  // forward, so the status line stays out of the way. Applied needs no status
  // either: the tag in the title says it.
  ui.status.textContent = !valid ? (edit.state === 'unlocated' ? 'Select the intended passage and request this edit again.' : '')
    : edit.state === 'kept' ? 'Original kept' : '';
  ui.status.hidden = !ui.status.textContent;
}
function syncChatEditCards() {
  for (const [edit, ui] of chatEditCards) {
    if (!ui.card.isConnected) { chatEditCards.delete(edit); continue; }
    syncChatEditCard(edit, ui);
  }
}
function changeChatEdit(edit, undo = false) {
  if (workView.state.readOnly || loadingDocument || savePaused || !chatEditMatches(edit, workView.state.doc.toString())
    || edit.state !== (undo ? 'applied' : 'pending')) return;
  clearPlainPreview();
  const text = undo ? edit.quote : edit.replacement;
  changingChatEdit = edit;
  try {
    if (undo) {
      saveSnapshot('Before undoing chat edit');
      workView.dispatch({ changes: { from: edit.from, to: edit.to, insert: text }, selection: { anchor: edit.from + text.length } });
      save();
    } else applyText(text, { from: edit.from, to: edit.to, text: edit.quote, document: workView.state.doc.toString() });
    edit.to = edit.from + text.length;
    edit.state = undo ? 'pending' : 'applied';
  } finally { changingChatEdit = null; }
  saveChat(); syncChatEditCards(); setChatOpen(true);
  const ui = chatEditCards.get(edit); (undo ? ui?.apply : ui?.undo)?.focus();
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
const RAIL_WIDTH = 220, RAIL_GUTTER = 24;   // .rail width in style.css
let railOn = false;

// The rail lives in the margin the centred text column leaves empty, so it is
// available exactly when that margin can hold a note card and a gutter.
// Measured, not guessed at a breakpoint: the text column's padding is the
// margin. Only margin-note cards stand here — finding cards keep their
// stream behavior at every width (see railAdd).
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
  if (fits === railOn) {
    rail.hidden = !fits || rail.children.length === 0;
    return;
  }
  railOn = fits;
  // Crossing the width moves note cards; finding cards stay where they are.
  // Moving must never open the chat: streamAppend keeps the panel as it was.
  for (const note of marginNotes) placeNoteCard(note);
  rail.hidden = !fits || rail.children.length === 0;
  if (!fits) chatScroll(true);   // cards moved into the stream land below the fold
}

// Without a rail a card belongs in the stream, stacked in DOM order. Moving
// must never open the chat: crossing the breakpoint on resize is not something
// new arriving. Cards created fresh in the stream open it explicitly instead.
function placeHome(node) {
  const home = railHomes.get(node) ?? chatStream;
  if (home === chatStream) streamAppend(node);
  else home.insertBefore(node, document.getElementById('review-status'));
}

function railAdd(node, anchor, home = chatStream) {
  railAnchors.set(node, anchor);
  railHomes.set(node, home);
  syncRail();
  // Only margin-note cards stand in the rail; everything else stacks in the
  // stream at every width, as before.
  if (railOn && node.dataset.noteId !== undefined) rail.append(node);
  else placeHome(node);
  if (node.dataset.noteId !== undefined) railSizes.observe(node);
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
      // −3 to stand exactly where the paragraph "+" stands (see moveNotePlus).
      return { node, at: coords && coords.top - top - 3 };
    })
    .filter(item => item.at !== null && item.at !== undefined)
    .sort((a, b) => a.at - b.at);
  for (const node of rail.children) node.style.visibility = 'hidden';
  // Cards whose passage scrolled out of view go with it: above the edge they
  // keep a negative top and slide away like the text (overflow clips them),
  // fully-out ones stay hidden. Clamping to zero instead pinned them to the
  // rail's top edge, where they sat while the draft scrolled underneath.
  const railHeight = rail.clientHeight;
  let floor = -Infinity;
  for (const item of placed) {
    const height = item.node.offsetHeight;
    const at = Math.max(item.at, floor);
    if (at + height <= 0 || at >= railHeight) continue;
    item.node.style.top = `${at}px`;
    item.node.style.visibility = 'visible';
    floor = at + height + 8;
  }
}

new MutationObserver(layoutRail).observe(rail, { childList: true });
// Cards are stacked by their measured heights, so a card that grows or shrinks
// afterwards (typing a longer note, committing it, a font arriving) has to
// restack the ones below it — otherwise they keep their old tops and overlap.
const railSizes = new ResizeObserver(() => layoutRail());
window.addEventListener('resize', layoutRail);
// CM reports no geometry change when the text column only shifts sideways
// (sidebar, window width), so the pane itself is watched too — its width is
// what the rail measurement reads.
new ResizeObserver(() => layoutRail()).observe(document.getElementById('pane-work'));

// ── Conversation island ──
//
//  Idle the whole chat is one pill, after Symbioen's DynamicIsland (a compact
//  idle pill morphing into the full panel with a spring — idle content swaps
//  for open content, entering with scale .9 → 1 and blur 5px → 0). Here the
//  pill and the composer share surface/border/shadow so the swap reads as one
//  surface changing shape, and island-in (.35s on --ease) stands in for the
//  spring.
//
//  The pill opens both the field and the stream: a restored history reopens
//  with it. A notice takes the island over (see notify): while one is up the
//  composer, the pill and the recipes row step aside for it — either input or
//  notice, never both. Summoning the composer dismisses a passing notice; a
//  sticky problem keeps the input covered until its own action or ×.
//  Closing never discards — turns, cards and Undo stay, like
//  setChatOpen. Collapse is allowed only with nothing to lose (empty field,
//  no chip, no request running), so typing is never interrupted.
function syncPill() {
  if (!chatPillLabel) return;
  const n = chatStream.children.length;
  // Background work speaks through the pill until it ends.
  const working = suggestWorking || reviewStatus.textContent;
  chatPanel.classList.toggle('is-working', Boolean(working));
  chatPillLabel.textContent = working || (n > 0 ? `Conversation${n > 1 ? ` • ${n}` : ''}` : 'Ask anything');
}

function canCollapseIsland() {
  return !chatInput.value.trim() && !attached && ![...jobs].some(job => !job.background);
}

function setIsland(open, opts = {}) {
  chatPanel.classList.toggle('is-collapsed', !open);
  chatPill?.setAttribute('aria-expanded', open ? 'true' : 'false');
  chatPill?.setAttribute('aria-label', open ? 'Conversation open' : 'Open conversation');
  syncPill();
  if (open) {
    if (opts.stream && chatStream.children.length > 0) setChatOpen(true);
    if (opts.focus) setTimeout(() => chatInput.focus({ preventScroll: true }), reduceMotion() ? 0 : 160);
  } else if (document.activeElement === chatInput) {
    try { workView.focus(); } catch {}
  }
  layoutRail();
}

function openIsland(opts = {}) {
  if (chatPanel.classList.contains('is-collapsed')) setIsland(true, opts);
  else if (opts.focus) chatInput.focus();
}

function maybeCollapseIsland() {
  if (canCollapseIsland()) setIsland(false);
}

chatPill?.addEventListener('mousedown', event => event.preventDefault());
chatPill?.addEventListener('click', () => {
  setIsland(true, { focus: true, stream: true });
});

// Clicking away from an empty, unstarted chat puts the pill back — only when
// there is nothing to lose (see canCollapseIsland) and no history to keep
// open. A scroll never collapses: the draft scrolls constantly.
document.addEventListener('pointerdown', event => {
  if (chatPanel.classList.contains('is-collapsed')) return;
  if (chatStream.children.length > 0) return;
  if (!canCollapseIsland()) return;
  if (event.target.closest('#chat')) return;
  setIsland(false);
});

// The pill names the count, so it must follow every stream change —
// including card removals that bypass setChatOpen.
new MutationObserver(() => syncPill()).observe(chatStream, { childList: true });

// The island morph. Pill, composer and notice are three elements, so a plain
// swap reads as one thing fading out and another fading in. Instead the
// incoming view is revealed from the outgoing one's outline and the outgoing
// view is clipped down to the incoming one's, on the same spring — the shape
// travels, the contents crossfade. Watching the class covers every path that
// swaps views (setIsland, notify) without threading a hook through each.
// The clip ends 60px outside the box so the shadow is revealed with it
// instead of popping in when the animation lets go.
const ISLAND_MORPH = { duration: 450, easing: 'cubic-bezier(.32, .72, 0, 1)' };
const chatComposer = chatPanel.querySelector('.chat-composer');
function islandView() {
  if (chatPanel.classList.contains('has-notice')) return editFeedback;
  return chatPanel.classList.contains('is-collapsed') ? chatPill : chatComposer;
}
let islandShown = islandView();
let islandRect = null;   // last known outline, for a view already display:none
new MutationObserver(() => {
  const next = islandView();
  if (!next || next === islandShown) return;
  const prev = islandShown;
  islandShown = next;
  const to = next.getBoundingClientRect();
  let from = prev?.getBoundingClientRect();
  if (!from?.width) from = islandRect;
  islandRect = to.width ? to : islandRect;
  if (reduceMotion() || !from?.width || !to.width) return;
  const inset = (box, of) => `inset(${box.top - of.top}px ${of.right - box.right}px ${of.bottom - box.bottom}px ${box.left - of.left}px round ${box.height / 2}px)`;
  const open = el => `inset(-60px round ${getComputedStyle(el).borderTopLeftRadius})`;
  next.animate([{ clipPath: inset(from, to) }, { clipPath: open(next) }], ISLAND_MORPH);
  if (prev?.getBoundingClientRect().width) {
    prev.animate([{ clipPath: open(prev) }, { clipPath: inset(to, from) }], ISLAND_MORPH);
  }
}).observe(chatPanel, { attributes: true, attributeFilter: ['class'] });

// Closing the conversation is a view, not an edit: the turns stay in memory
// and in storage, and the same control opens them again. Something new
// arriving is worth showing, so it opens by itself.
function setChatOpen(open) {
  // One surface: closing hides the stream and nothing else. Turns, remark
  // cards, undecided options and Undo all stay exactly where they were, so
  // reopening shows the same panel — closing never discards or retires
  // anything behind your back. The composer stays: it is how the writer
  // talks to the draft at all.
  // The toggle is its own right-aligned row above the stream (see .chat-clear)
  // — in normal flow, never overlapping cards or the composer, so it takes
  // a layout row and never scrolls away with a long stream.
  // A stream inside the folded pill is display:none — opening it there shows
  // nothing and leaves its fields unfocusable, so the island unfolds too.
  if (open) openIsland();
  if (open) chatStream.hidden = false;      // measure against a laid-out stream
  chatClear.textContent = open ? '×' : 'Conversation';
  chatClear.setAttribute('aria-label', open ? 'Close the conversation' : 'Show the conversation');
  chatClear.title = open ? 'Close — nothing is discarded' : 'Show the conversation';
  if (open) { chatClear.hidden = false; chatScroll(true, true); return; }
  chatStream.hidden = true;
  clearPlainPreview();   // a hover preview must not outlive the panel
  // The toggle only makes sense while the stream holds something to show —
  // otherwise ×/Conversation sits above an empty panel and reads as broken.
  chatClear.hidden = chatStream.children.length === 0;
  layoutRail();
}

// One way to drop the remark cards, used everywhere the conversation closes
// or resets — the rail anchor map must not keep pointing at removed nodes.
function discardFindingCards() {
  for (const card of findingCards.values()) {
    railAnchors.delete(card); railHomes.delete(card); card.remove();
  }
  findingCards.clear();
  focusedFindingId = null;
}

function chatAdd(node) {
  setIsland(true);
  setChatOpen(true);
  chatStream.append(node);
  // A new turn is worth showing: force-scroll, unlike streaming updates
  // which follow only when the reader is already at the bottom.
  chatScroll(true);
  chatClear.hidden = false;
  return node;
}

// Append without opening: rail→stream migration of cards that are already on
// screen. Opening is reserved for genuinely new arrivals (see chatAdd).
function streamAppend(node) {
  const stick = chatAtBottom();
  chatStream.append(node);
  chatScroll(stick);
  chatClear.hidden = false;
  return node;
}

// ── Margin notes ─────────────────────────────────────────────────────────────
//  The writer's own remarks on the draft (slice 1: create, show, delete — no
//  threads, no model calls yet). Each note anchors to a paragraph with a
//  quote snapshot:
//
//  - the quote is found verbatim → the mark stands on it, drifted is false;
//  - the quote is gone (reworded) → the mark falls back to the paragraph and
//    the card carries a "text changed" badge, so one retyped word never kills
//    a note the way it kills a finding mark;
//  - the paragraph is gone too (empty draft) → no mark; the card waits in the
//    stream until the text returns.
//
//  Storage is a new per-document key, so STORAGE_SCHEMA stays '1': no stored
//  shape changed, only a new one appeared.
let noteSeq = 0;
let marginNotes = [];       // { id, para, quote, text, at, drifted }
const noteCards = new Map();  // note id → its card, while it is on screen

const setNoteFx = StateEffect.define();
const noteMark = note => Decoration.mark({
  class: 'cm-note' + (note.drifted ? ' is-drifted' : ''),
  attributes: {
    'data-note-id': note.id,
    title: note.text || 'Margin note',
  },
}).range(note.from, note.to);

const noteField = StateField.define({
  create: () => Decoration.none,
  update(decorations, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setNoteFx)) return Decoration.set(effect.value.map(noteMark), true);
    }
    if (!tr.docChanged) return decorations;
    // Edits elsewhere only shift a note; edits inside one drop its mark until
    // the microtask below re-resolves it (verbatim or paragraph fallback).
    const edited = [];
    tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => edited.push([fromB, toB]));
    return decorations.map(tr.changes).update({
      filter: (from, to) => !edited.some(([a, b]) => a < to && b > from),
    });
  },
  provide: field => EditorView.decorations.from(field),
});

// Paragraph index at creation time; the same blank-line splitting the
// automatic review uses, so "paragraph N" means the same thing everywhere.
// Scope rule, one line: a non-empty quote is a passage note (verbatim, else
// drifted fallback); an empty quote is a paragraph note (always live, never
// drifted); a null paragraph is a document note (no mark, pinned at top).
function resolveNoteRange(document, note) {
  if (note.para === null) return { from: 0, to: 0, drifted: false, bare: true };
  const paras = reviewParagraphs(document);
  const para = paras[Math.min(note.para, paras.length - 1)];
  if (!para) return null;
  // A "+" note is a point, not a span: the line the writer pressed beside,
  // kept as an offset into its paragraph (clamped if the paragraph shrank).
  // No mark — a long paragraph would light up whole.
  if (!note.quote) {
    const at = Math.min(para.from + (note.off || 0), para.to);
    return { from: at, to: at, drifted: false, bare: true };
  }
  if (document.includes(note.quote)) {
    const from = document.indexOf(note.quote);
    return { from, to: from + note.quote.length, drifted: false };
  }
  return { from: para.from, to: para.to, drifted: true };
}

// Live position of a note — decorations move with the document, the offsets
// captured at creation time do not. Document notes have no mark; their
// position is the top by definition.
function noteRange(id) {
  const note = marginNotes.find(item => item.id === id);
  if (!note) return null;
  if (note.para === null) return { from: 0, to: 0 };
  if (!note.quote) {
    const at = resolveNoteRange(workView.state.doc.toString(), note);
    return at && { from: at.from, to: at.to };
  }
  let found = null;
  workView.state.field(noteField).between(0, workView.state.doc.length, (from, to, deco) => {
    if (deco.spec.attributes?.['data-note-id'] === id) { found = { from, to }; return false; }
  });
  return found;
}

function markForNote(id) { return workView.dom.querySelector(`.cm-note[data-note-id="${CSS.escape(id)}"]`); }

// Rail position of a note: its own line — where its "+" stood or its passage
// begins — so a note stands exactly where it was made. Passage notes
// anchor by their live range's paragraph (falling back to the stored one),
// document notes pin at the very top.
function noteAnchor(id) {
  const note = marginNotes.find(item => item.id === id);
  if (!note) return null;
  if (note.para === null) return 0;
  const paras = reviewParagraphs(workView.state.doc.toString());
  if (!paras.length) return null;
  // Stands where it was made: at its passage, or at the line its "+" was
  // pressed beside. Anchored to the paragraph's top it landed screens above a
  // click in a long paragraph. A reworded passage falls back to the paragraph.
  return noteRange(id)?.from ?? paras[Math.min(note.para, paras.length - 1)].from;
}

// Re-anchor every note against the document as it is now. Illegal inside an
// update listener — callers queue it as a microtask (see the docChanged
// listener below), or call it directly from event handlers.
function syncNoteMarks() {
  const document = workView.state.doc.toString();
  const marks = [];
  for (const note of marginNotes) {
    const resolved = resolveNoteRange(document, note);
    note.drifted = !resolved || resolved.drifted;
    // Document notes and empty drafts resolve bare: no mark to draw, the
    // card's place (rail top, or stream) is decided by placeNoteCard.
    if (resolved && !resolved.bare && resolved.to > resolved.from) {
      marks.push({ id: note.id, from: resolved.from, to: resolved.to, drifted: note.drifted, text: note.text });
    }
  }
  workView.dispatch({ effects: setNoteFx.of(marks) });
  for (const note of marginNotes) placeNoteCard(note);
  layoutRail();
}

// A note with a live range stands in the rail when there is one; a drifted
// orphan with no range waits in the stream. Never opens the chat — arriving
// by edit or resize is not something new arriving.
function placeNoteCard(note) {
  const card = noteCards.get(note.id);
  if (!card || !card.isConnected) return;
  card.style.top = '';
  card.style.visibility = '';
  if (railOn && noteRange(note.id)) {
    if (card.parentElement !== rail) rail.append(card);
  } else placeHome(card);
  rail.hidden = !railOn || rail.children.length === 0;
  // Never clobber an open editor: typing elsewhere re-anchors notes on every
  // keystroke, and that must not eat the text being typed in the card.
  if (!card.querySelector('textarea')) renderNoteCard(note);
}

function saveNotes() {
  docStorage.setItem('wa-notes', JSON.stringify({ notes: marginNotes }));
}

function restoreNotes() {
  // Restoring runs again on a retried load and on every file switch: cards
  // from the last pass must go first, or each one is stacked a second time.
  discardNoteCards();
  let saved = null;
  try { saved = JSON.parse(docStorage.getItem('wa-notes') || 'null'); } catch {}
  const notes = Array.isArray(saved?.notes) ? saved.notes : [];
  marginNotes = notes.filter(note =>
    note && typeof note.id === 'string' && typeof note.quote === 'string'
    && typeof note.text === 'string' && note.text.trim() !== ''
    && (Number.isInteger(note.para) || note.para === null));
  for (const note of marginNotes) if (!Number.isInteger(note.off) || note.off < 0) note.off = 0;
  for (const note of marginNotes) {
    note.drifted = false;
    noteCards.set(note.id, railAdd(noteCard(note), () => noteAnchor(note.id)));
  }
  syncNoteMarks();   // also clears the marks a previous document left
}

function discardNoteCards() {
  for (const card of noteCards.values()) {
    railAnchors.delete(card); railHomes.delete(card); card.remove();
  }
  noteCards.clear();
  marginNotes = [];
}

function noteExcerpt(note) {
  const range = noteRange(note.id);
  const live = range ? workView.state.sliceDoc(range.from, note.quote ? range.to : range.from + 160) : '';
  const text = (live || note.quote).trim().replace(/\s+/g, ' ');
  return text.length > 120 ? text.slice(0, 120).replace(/\s+\S*$/, '') + '…' : text;
}

function noteCard(note) {
  const card = chatEl('div', 'note-card');
  card.dataset.noteId = note.id;
  card.tabIndex = 0;
  card.setAttribute('aria-label', 'Margin note. Press Enter to edit.');
  card.addEventListener('mouseenter', () => markForNote(note.id)?.classList.add('is-hot'));
  card.addEventListener('mouseleave', () => markForNote(note.id)?.classList.remove('is-hot'));
  card.addEventListener('click', event => {
    if (event.target.closest('textarea, button')) return;
    focusNote(note.id);
  });
  card.addEventListener('keydown', event => {
    if (event.target !== card) return;
    if (event.key === 'Enter') { event.preventDefault(); editNoteCard(note.id); }
    // Keyboard way to delete: the × is hover-only on desktop, unreachable
    // without a mouse. Undo stays the way back, like the button.
    else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); deleteNote(note.id); }
  });
  renderNoteCard(note, card);
  return card;
}

function renderNoteCard(note, card = noteCards.get(note.id)) {
  if (!card || card.querySelector('textarea')) return;
  // Re-rendered on every keystroke via placeNoteCard — skip when nothing the
  // note shows changed, so hover and focus survive typing elsewhere.
  const inStream = card.parentElement === chatStream;
  const key = `${inStream}|${note.drifted}|${note.text}|${noteExcerpt(note)}`;
  if (card.dataset.renderKey === key) return;
  card.dataset.renderKey = key;
  card.replaceChildren();
  // In the rail the note stands beside its passage, so the passage itself is
  // the context — just the text. In the stream there is no beside, so the
  // quote travels with it; a document note names the whole draft instead.
  const scope = note.para === null ? 'Whole draft' : noteExcerpt(note);
  if (inStream || note.para === null) card.append(chatEl('div', 'note-quote', note.para === null ? scope : `“${scope}”`));
  const body = chatEl('div', 'note-text', note.text);
  body.addEventListener('click', event => { event.stopPropagation(); editNoteCard(note.id); });
  card.append(body);
  if (note.drifted) card.append(chatEl('div', 'note-meta', 'text changed — pinned to the paragraph'));
  const del = chatEl('button', 'note-del', '×');
  del.type = 'button';
  del.setAttribute('aria-label', 'Delete note');
  del.title = 'Delete note';
  del.addEventListener('click', event => { event.stopPropagation(); deleteNote(note.id); });
  card.append(del);
}

function editNoteCard(id) {
  const note = marginNotes.find(item => item.id === id);
  const card = noteCards.get(id);
  if (!note || !card || card.querySelector('textarea')) return;
  delete card.dataset.renderKey;
  card.replaceChildren();
  const field = document.createElement('textarea');
  field.value = note.text;
  field.rows = 1;
  field.setAttribute('aria-label', 'Note text');
  field.placeholder = 'Write a note…';
  card.append(field);
  // No Save/Cancel: blur commits, Escape drops. A commit flag keeps the blur
  // from re-saving after Escape already cancelled.
  // Empty notes don't linger: a fresh note left empty is removed silently
  // (cancelling is not deleting — there is nothing to put back), while
  // clearing a note that held text goes through deleteNote with its Undo.
  let finished = false;
  const finish = save => {
    if (finished) return;
    finished = true;
    const fresh = note.text === '';
    const next = field.value.trim();
    if ((!save || next === '') && fresh) { removeNoteSilent(id); workView.focus(); return; }
    if (save && next === '') { deleteNote(id); return; }   // focuses + Undo itself
    if (save && next !== note.text) {
      note.text = next;
      saveNotes();
      syncNoteMarks();
    }
    delete card.dataset.renderKey;
    field.remove();   // renderNoteCard skips a card that still holds a field
    renderNoteCard(note);
  };
  field.addEventListener('blur', () => finish(true));
  field.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); finish(false); workView.focus(); }
    else if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); finish(true); workView.focus(); }
    event.stopPropagation();
  });
  // Fit the field to its text. Rows counted against a fixed 22px came out a
  // line too tall for an empty note; the content height is never wrong.
  const fit = () => { field.style.height = 'auto'; field.style.height = `${field.scrollHeight}px`; };
  field.addEventListener('input', fit);
  field.focus();
  field.setSelectionRange(field.value.length, field.value.length);
  fit();
}

function createNote(from, to) {
  const document = workView.state.doc.toString();
  // A drag that starts on the blank line above a paragraph would pin the note
  // there and quote a leading newline; anchor at the first real character.
  // The whole-draft check below needs the untrimmed range, so it goes first.
  if (!(from === 0 && to === document.length)) {
    const slice = document.slice(from, to);
    const lead = slice.length - slice.trimStart().length;
    const trimmed = slice.trim();
    if (trimmed) { from += lead; to = from + trimmed.length; }
  }
  // A selection spanning the whole draft is a note on the draft, not on a
  // passage: no anchor paragraph, no quote, no mark — pinned at the rail top.
  if (from === 0 && to === document.length && document.length > 0) {
    return addNote({ para: null, quote: '' });
  }
  // A drag rarely lands on a word edge; a quote cut mid-word ("carry exac")
  // reads as a typo in the card, so the passage snaps out to whole words.
  const inWord = i => /[\p{L}\p{N}_]/u.test(document[i] ?? '');
  while (from > 0 && inWord(from - 1) && inWord(from)) from--;
  while (to < document.length && inWord(to - 1) && inWord(to)) to++;
  const paras = reviewParagraphs(document);
  let para = paras.findIndex(paragraph => from >= paragraph.from && from <= paragraph.to);
  if (para < 0) para = 0;
  return addNote({ para, quote: document.slice(from, to).slice(0, 500) });
}

// A note on a line: empty quote, so it never drifts — the paragraph and the
// offset into it are the anchor, not a snapshot of the wording.
function createParagraphNote(para, off = 0) {
  const paras = reviewParagraphs(workView.state.doc.toString());
  if (!paras.length || para < 0 || para >= paras.length) return null;
  return addNote({ para, quote: '', off });
}

function addNote({ para, quote, off = 0 }) {
  const note = {
    id: `n${Date.now().toString(36)}${(noteSeq++).toString(36)}`,
    para,
    quote,
    off,
    text: '',
    at: new Date().toISOString(),
    drifted: false,
  };
  marginNotes.push(note);
  saveNotes();
  const card = noteCard(note);
  noteCards.set(note.id, railAdd(card, () => noteAnchor(note.id)));
  // A fresh note is a new arrival: open for it when it lands in the stream.
  // In the rail it is already visible beside the line.
  if (card.parentElement === chatStream) setChatOpen(true);
  syncNoteMarks();
  // The bubble's button returns focus to the editor after this runs — take
  // the field back on the next tick.
  queueMicrotask(() => editNoteCard(note.id));
  return note;
}

// ── Paragraph "+" ────────────────────────────────────────────────────────────
//  Hovering the empty margin beside a paragraph shows one faint "+", Notion-
//  style: the paragraph is the commonest note target, and selecting it first
//  just to press Note is a tax on every remark. Clicking the "+" opens a
//  paragraph note (empty quote: the paragraph is the anchor, never drifted).
//  No shortcut to remember, no button to find — the margin itself invites.
const notePlus = document.createElement('button');
notePlus.type = 'button';
notePlus.className = 'note-plus';
notePlus.textContent = '+';
notePlus.title = 'Note on this paragraph';
notePlus.setAttribute('aria-label', 'Add a note on this paragraph');
notePlus.hidden = true;
document.getElementById('pane-work').append(notePlus);
let plusPara = -1;
let plusOff = 0;
let plusRaf = 0;

// Paragraph splitting on every mousemove would tax long drafts; the split
// only changes on edit, so cache it keyed by editVersion.
let paraCacheVersion = -1;
let paraCache = [];
function cachedParagraphs() {
  if (paraCacheVersion !== editVersion) {
    paraCache = reviewParagraphs(workView.state.doc.toString());
    paraCacheVersion = editVersion;
  }
  return paraCache;
}

function hideNotePlus() {
  plusPara = -1;
  if (plusRaf) { cancelAnimationFrame(plusRaf); plusRaf = 0; }
  if (plusHideTimer) { clearTimeout(plusHideTimer); plusHideTimer = null; }
  if (!notePlus.hidden) notePlus.hidden = true;
}

// Boundary crossings (text ⇄ "+") hide and re-show within one mousemove,
// which reads as blinking. Hiding waits a beat instead; anything continuous
// (scroll, drag, selection, bubble, rail off) still hides at once.
let plusHideTimer = null;
function schedulePlusHide() {
  if (plusHideTimer || notePlus.hidden) return;
  plusHideTimer = setTimeout(() => { plusHideTimer = null; hideNotePlus(); }, 150);
}

function moveNotePlus(event) {
  if (plusRaf) return;
  const clientY = event.clientY;
  plusRaf = requestAnimationFrame(() => {
    plusRaf = 0;
    // The "+" belongs to the rail: no rail, no plus. Hidden while dragging or
    // holding a selection (its bubble already offers Note) and before the
    // draft loads. An open bubble does not hide it: the Continue bubble after
    // any click at a paragraph's end used to take the "+" away with it, and a
    // press on the "+" closes the bubble anyway.
    if (!railOn || loadingDocument || event.buttons !== 0
        || !workView.state.selection.main.empty) {
      hideNotePlus();
      return;
    }
    const contentBox = workView.contentDOM.getBoundingClientRect();
    const pos = workView.posAtCoords({ x: contentBox.left + 40, y: clientY });
    if (pos == null) { hideNotePlus(); return; }
    const paras = cachedParagraphs();
    if (!paras.length) { hideNotePlus(); return; }
    let index = paras.findIndex(paragraph => pos >= paragraph.from && pos <= paragraph.to);
    // The "+" stands on the line under the pointer, not the paragraph's first
    // line: a hard-wrapped draft reads as one long paragraph, and pinned to
    // its top the "+" sat screens away from the hand, often scrolled out.
    let at = pos;
    if (index < 0) {
      // Blank gaps between paragraphs belong to no paragraph — snapping to
      // the nearest one instead of blinking out on every crossing.
      let best = 0, bestDist = Infinity;
      paras.forEach((paragraph, i) => {
        const dist = pos < paragraph.from ? paragraph.from - pos : pos - paragraph.to;
        if (dist < bestDist) { bestDist = dist; best = i; }
      });
      index = best;
      at = pos < paras[index].from ? paras[index].from : paras[index].to;
    }
    const coords = workView.coordsAtPos(at);
    // A line a note already stands beside needs no invitation: pressing it
    // would stack a second card on the first. Notes elsewhere in the same
    // paragraph do not count — each line is its own place.
    if (coords && marginNotes.some(note => {
      const card = noteCards.get(note.id);
      if (!card?.isConnected || card.parentElement !== rail) return false;
      const box = card.getBoundingClientRect();
      return coords.top >= box.top - 4 && coords.top <= box.bottom;
    })) { hideNotePlus(); return; }
    const railLeft = parseFloat(rail.style.left) || 0;
    if (!coords || !railLeft) { hideNotePlus(); return; }
    if (plusHideTimer) { clearTimeout(plusHideTimer); plusHideTimer = null; }
    const pane = document.getElementById('pane-work').getBoundingClientRect();
    plusPara = index;
    plusOff = at - paras[index].from;
    notePlus.style.left = `${railLeft - 28}px`;
    notePlus.style.top = `${(coords.top + coords.bottom) / 2 - 11 - pane.top}px`;   // 22px "+" centred on the line
    notePlus.hidden = false;
  });
}
editorWrap.addEventListener('mousemove', moveNotePlus);
editorWrap.addEventListener('mouseleave', event => {
  // Moving onto the "+" itself must not dismiss it — it is the target.
  if (event.relatedTarget === notePlus) return;
  hideNotePlus();
});
notePlus.addEventListener('mouseenter', () => {
  if (plusHideTimer) { clearTimeout(plusHideTimer); plusHideTimer = null; }
});
notePlus.addEventListener('mouseleave', schedulePlusHide);
notePlus.addEventListener('click', event => {
  event.preventDefault();
  event.stopPropagation();
  const para = plusPara, off = plusOff;
  hideNotePlus();
  // Focus stays where it was; the new note's editor takes it on the tick.
  if (para >= 0) createParagraphNote(para, off);
});

// A note that never held text leaves no trace: no toast, no Undo — there is
// nothing to put back. Backing out of a fresh note is cancelling, not deleting.
function removeNoteSilent(id) {
  const index = marginNotes.findIndex(note => note.id === id);
  if (index < 0) return;
  marginNotes.splice(index, 1);
  const card = noteCards.get(id);
  if (card) { railAnchors.delete(card); railHomes.delete(card); card.remove(); }
  noteCards.delete(id);
  syncNoteMarks();
  saveNotes();
}

function deleteNote(id) {  const index = marginNotes.findIndex(note => note.id === id);
  if (index < 0) return;
  const [note] = marginNotes.splice(index, 1);
  const document = workView.state.doc.toString();
  const card = noteCards.get(id);
  if (card) { railAnchors.delete(card); railHomes.delete(card); card.remove(); }
  noteCards.delete(id);
  syncNoteMarks();
  saveNotes();
  workView.focus();
  notifyUndo('Note deleted', () => {
    marginNotes.splice(Math.min(index, marginNotes.length), 0, note);
    saveNotes();
    const restored = noteCard(note);
    noteCards.set(note.id, railAdd(restored, () => noteAnchor(note.id)));
    if (restored.parentElement === chatStream) setChatOpen(true);
    syncNoteMarks();
    if (workView.state.doc.toString() !== document) notify('Note restored — its passage moved while it was gone.');
  });
}

// The writer's margin notes as model context: short lines labeled by scope,
// so a "tighten this" reads as the author's voice, not an instruction from
// nowhere. Empty notes never persist (see editNoteCard), so everything here
// is content. Sent with chat and rewrites only — suggestions fire on every
// pause and review must judge the prose unbiased.
function notesBrief() {
  if (!marginNotes.length) return '';
  const lines = marginNotes.map(note => {
    if (note.para === null) return `- On the whole draft: ${note.text}`;
    const range = noteRange(note.id);
    const live = range ? workView.state.sliceDoc(range.from, note.quote ? range.to : range.from + 200).trim().replace(/\s+/g, ' ') : '';
    return `- On "${(live || note.quote).slice(0, 200)}": ${note.text}`;
  });
  return `WRITER'S MARGIN NOTES (the author's own remarks — weigh them, do not quote them back):\n${lines.join('\n')}`;
}

// Clicking a note's mark reads the note: the editor scrolls the passage into
// view and the card takes focus. Arms nothing, like a finding mark.
function focusNote(id) {
  const range = noteRange(id);
  if (range) workView.dispatch({ effects: EditorView.scrollIntoView(range.from, { y: 'center' }) });
  const card = noteCards.get(id);
  if (card?.isConnected) {
    if (card.parentElement === chatStream) setChatOpen(true);
    layoutRail();
    card.focus({ preventScroll: true });
  }
}

// Keep the way back visible even when the conversation is put away.
const notifyUndo = (message, onUndo) => notify(message, { action: onUndo, key: 'undo', icon: 'check', tone: 'ok' });

// ── Attached passage ──

// The passage stays where the writer is looking — highlighted in the draft.
// Copying it into the composer duplicated the sentence they were reading and
// pushed the answer off screen.
// The composer's invitation names what it will carry: a bare field, or one
// with a passage attached.
function basePlaceholder() {
  if (attached) return activeFinding ? 'Ask about this finding' : 'Ask about this passage, or request a change';
  return CHAT_PLACEHOLDER;
}

// Attaching is always an explicit act — the bubble's Add to context, a card's
// Discuss, Cmd+K on a selection — never a side effect of reading.
// Clicking a mark opens its remark and arms nothing: the writer may just as
// well be putting the caret there to fix the sentence themselves.
function attach(range, finding = null, focusComposer = true) {
  dismissPassingNotice();
  openIsland();
  attached = range;
  activeFinding = finding;
  // Context remains visible after the placeholder disappears while typing.
  chatChip.classList.remove('hidden');
  chatChipText.textContent = finding ? `Finding: ${finding.pattern}` : 'Selected text';
  chatChipText.title = chatChipText.textContent;
  workView.dispatch({ effects: setAttachFx.of({ from: range.from, to: range.to, finding: !!finding }) });
  chatInput.placeholder = basePlaceholder();
  if (focusComposer) chatInput.focus();
}

function detach() {
  clearPlainPreview();
  attached = null;
  activeFinding = null;
  chatChip.classList.add('hidden');
  syncActiveCard();
  chatInput.placeholder = basePlaceholder();
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

// ── Mark bubble ──
//
//  Clicking a mark or selecting text arms nothing. The bubble beside the click
//  holds the explicit acts instead: Add to context (names the chip, stays in
//  the editor) and a rewrite (attaches, then asks the model). One bubble at a
//  time; an edit, copy, or Escape puts it away — a scroll carries it along.
const markBubble = document.getElementById('mark-bubble');
let bubbleMode = null;   // 'finding' | 'style' | 'selection' | 'continue' | 'spell' while open

function hideMarkBubble() {
  cancelDeferredBubble();
  bubbleAnchor = null;
  if (markBubble.hidden) return;
  // Children stay: the bubble fades out (style.css), and emptied first it
  // would shrink to a sliver mid-fade. The next show replaces them.
  markBubble.hidden = true;
  bubbleMode = null;
}

// Bubbles nobody asked for by name — after a selection, after a click at a
// paragraph's end — wait a beat. Most such clicks are about to type, drag or
// click again, and a toolbar flashing up for each reads as noise. Any key or
// press in the meantime cancels; so does the text or caret moving on.
// Clicking a mark is asking, so those bubbles still open at once.
let bubbleTimer = 0;
function deferBubble(show, ms) {
  clearTimeout(bubbleTimer);
  const { doc, selection } = workView.state;
  bubbleTimer = setTimeout(() => {
    bubbleTimer = 0;
    const now = workView.state;
    if (now.doc === doc && now.selection.main.eq(selection.main)) show();
  }, ms);
}
function cancelDeferredBubble() {
  clearTimeout(bubbleTimer);
  bubbleTimer = 0;
}
document.addEventListener('keydown', cancelDeferredBubble, true);
document.addEventListener('mousedown', cancelDeferredBubble, true);

// The box the bubble may live in: the writing pane, not the window. The header
// is fixed over the draft's first line and the file sidebar is a column beside
// it, and a toolbar under either is a toolbar nobody can press — the click that
// should dismiss it lands on the chrome instead, so the bubble looks present
// and does nothing. Both edges come from the pane the text is in, and the top
// from under the header, which is why clamping to the window was not enough.
function bubbleArea() {
  const pane = document.getElementById('pane-work').getBoundingClientRect();
  const header = document.getElementById('pane-header').getBoundingClientRect();
  const left = pane.left + 8;
  return {
    left,
    right: Math.max(left, pane.right - 8),
    top: Math.max(pane.top, header.bottom) + 8,
    bottom: window.innerHeight - 8,
  };
}

// The document position the bubble was asked for, so a reflow can put it back
// over the same words — the draft re-centres when the sidebar opens, so the
// old screen point would be off. Cleared whenever it is put away.
let bubbleAnchor = null;

// Where bubbles stand: 'float' above the words (the default), or, with the
// "Actions in the margin" setting, 'margin' beside the selected line in the
// notes rail and 'inline' right after the caret for Continue. The docked kinds
// are placed exactly (left edge at x, centred on the line at y) instead of
// centred above a point, and fall back to float where there is no rail.
let pillsMargin = localStorage.getItem('wa-pills') === 'margin';
function bubbleDock(kind) {
  return pillsMargin && (kind === 'inline' || railOn) ? kind : 'float';
}

function placeBubble(x, y, anchor = null, dock = 'float') {
  markBubble.hidden = false;
  if (!anchor) {
    const pos = workView.posAtCoords({ x, y });
    const at = pos == null ? null : workView.coordsAtPos(pos);
    anchor = at && { pos, dx: x - at.left, dy: y - at.top, dock };
  }
  bubbleAnchor = anchor;
  dock = anchor?.dock ?? 'float';
  markBubble.dataset.dock = dock;
  const area = bubbleArea();
  // Scrolled under the header or off the pane: hidden with its words, back
  // when they return — never pinned to an edge pointing at nothing.
  const box = markBubble.getBoundingClientRect();
  const cy = dock === 'float' ? y : y + box.height / 2;   // docked: judged by its line
  markBubble.style.visibility = cy < area.top - 8 || cy > area.bottom ? 'hidden' : '';
  let left, top;
  if (dock === 'float') ({ left, top } = clampBubble(x, y, { w: box.width, h: box.height }, area));
  else {
    left = Math.min(x, window.innerWidth - box.width - 8);
    top = y;
  }
  markBubble.style.left = `${left}px`;
  markBubble.style.top = `${top}px`;
}

// A docked bubble is centred on the text line it belongs to.
function placeDockedBubble(pos, dock) {
  const coords = workView.coordsAtPos(pos);
  if (!coords) return false;
  markBubble.hidden = false;
  const h = markBubble.getBoundingClientRect().height;
  const pane = document.getElementById('pane-work').getBoundingClientRect();
  const x = dock === 'margin' ? pane.left + (parseFloat(rail.style.left) || 0) : coords.left + 12;
  const y = (coords.top + coords.bottom) / 2 - h / 2;
  placeBubble(x, y, { pos, dx: x - coords.left, dy: y - coords.top, dock }, dock);
  return true;
}

// Back over its words after a scroll or reflow, at the same offset from them.
// Layout is read in CM's measure phase: reading it mid-update throws.
function reanchorBubble() {
  const anchor = bubbleAnchor;
  if (!anchor) return;
  workView.requestMeasure({
    read: view => view.coordsAtPos(anchor.pos),
    write: coords => {
      if (markBubble.hidden) return;
      if (!coords) { markBubble.style.visibility = 'hidden'; return; }
      placeBubble(coords.left + anchor.dx, coords.top + anchor.dy, anchor);
    },
  });
}
// CM reports no geometry change when the text column only shifts sideways
// (sidebar, window width), so the pane itself is watched too.
new ResizeObserver(reanchorBubble).observe(document.getElementById('pane-work'));

function bubbleButton(label, run) {
  const button = chatEl('button', 'mark-bubble-seg', label);
  button.type = 'button';
  button.addEventListener('click', () => { hideMarkBubble(); run(); workView.focus(); });
  return button;
}

function attachLive(finding, range) {
  attach({ ...range, text: workView.state.sliceDoc(range.from, range.to) }, finding, false);
}

function showFindingBubble(finding, x, y) {
  // A local style mark is the same remark with a different origin; only the
  // copy handler cares which, and it must not read a finding as a selection.
  bubbleMode = finding.id === -1 ? 'style' : 'finding';
  const actions = chatEl('div', 'mark-bubble-actions');
  actions.append(
    bubbleButton('Add to context', () => {
      const range = findingRange(finding.id);
      if (range) attachLive(finding, range);
    }),
    bubbleButton('Suggest rewrites', () => {
      const range = findingRange(finding.id);
      if (!range) return;
      attachLive(finding, range);
      const card = findingCards.get(finding.id);
      const offer = card?.querySelector('.chat-action');
      if (offer && !offer.disabled) offer.click();
      else if (card) requestVariants(`Fix ${finding.pattern}: ${finding.fix}. Preserve facts and voice. Replace only the quoted passage.`, null, card);
    }),
  );
  markBubble.replaceChildren(actions);
  placeBubble(x, y);
}

function showSelectionBubble(x, y) {
  const sel = workView.state.selection.main;
  if (sel.empty) return;
  // A mark click owns the bubble when the click lands on one; a bare
  // selection gets the context action alone — the composer below then asks
  // what to do with it.
  bubbleMode = 'selection';
  const actions = chatEl('div', 'mark-bubble-actions');
  actions.append(bubbleButton('Add to context', () => {
    const live = workView.state.selection.main;
    if (live.empty) return;
    attach({ from: live.from, to: live.to, text: workView.state.sliceDoc(live.from, live.to) }, null, true);
  }));
  // A note is the writer talking to themselves about the passage — no model
  // call, just a card on the rail. The card opens its editor on the next
  // tick, after the bubble returns focus to the draft.
  actions.append(bubbleButton('Note', () => {
    const live = workView.state.selection.main;
    if (live.empty) return;
    createNote(live.from, live.to);
  }));
  markBubble.replaceChildren(actions);
  if (bubbleDock('margin') === 'margin' && placeDockedBubble(sel.from, 'margin')) return;
  placeBubble(x, y);
}

function showContinueBubble(x, y) {
  bubbleMode = 'continue';
  const actions = chatEl('div', 'mark-bubble-actions');
  actions.append(bubbleButton('Continue', () => {
    // The request reads the caret and refuses to run unless the editor holds
    // focus; the click left it on the button, so take it back first.
    workView.focus();
    cancelSuggestion();
    ghostClear(workView);
    void suggestFetch(true);
  }));
  markBubble.replaceChildren(actions);
  // Anchor to the text caret, not the mouse: the click may land anywhere on
  // the empty tail of the line, while writing continues at the caret. The
  // bubble stands right above the caret line. Falls back to the click point
  // when caret coordinates are unavailable.
  const head = workView.state.selection.main.head;
  if (bubbleDock('inline') === 'inline') {
    const hint = chatEl('kbd', '', '⌘↵');
    actions.firstChild.append(' ', hint);
    if (placeDockedBubble(head, 'inline')) return;
  }
  let cx = x, cy = y;
  try {
    const coords = workView.coordsAtPos(head);
    if (coords) { cx = coords.left; cy = coords.top; }
  } catch {}
  placeBubble(cx, cy);
}

// A dictionary miss offers direct replacements — no model call, no card, the
// fix is already known. Suggestions are computed on click, not while typing:
// nspell's suggest() does an edit-distance search, correct() alone does not.
//
// Four words, not five: the bubble is a single unwrapped row capped at 340px,
// and its segments never shrink below their text. A fifth replacement pushes
// the last segment past the rounded end of the pill, where it reads as part of
// the page instead of part of the toolbar. Four is already more than anyone
// weighs before choosing.
const SPELL_SUGGESTIONS = 4;
function showSpellBubble(marker, x, y) {
  bubbleMode = 'spell';
  const actions = chatEl('div', 'mark-bubble-actions');
  const replace = suggestion => {
    if (workView.state.sliceDoc(marker.from, marker.to) !== marker.quote) return;
    workView.dispatch({ changes: { from: marker.from, to: marker.to, insert: suggestion }, userEvent: 'input.spellfix' });
  };
  for (const suggestion of (spellChecker?.suggest(marker.quote) ?? []).slice(0, SPELL_SUGGESTIONS)) {
    actions.append(bubbleButton(suggestion, () => replace(suggestion)));
  }
  actions.append(bubbleButton('Ignore', () => {
    spellChecker?.add(marker.quote);
    noteSpellingAdded(marker.quote);
    workView.dispatch({ effects: refreshSpellFx.of(null) });
  }));
  markBubble.replaceChildren(actions);
  placeBubble(x, y);
}

// ── Rewrite variants (cards, 0.2 style) ───────────────────────────────────────
//
//  Three options in the chat, not a try-on in the draft. Clicking a card
//  replaces only the attached range; the rest is reading.
//
//  NOTE (coloured diff): the inline word-level diff with animated added/removed
//  colours (wordDiff in editing.js + VariantWidget + cm-variant-old/new) is
//  deliberately out of this path for now — it is kept in the tree as a noted
//  option for another place (e.g. history compare). Variants here preview on a
//  plain white sheet with no red/green: hover/focus shows the option where it
//  will live, the document itself stays untouched until the writer clicks.

class PlainVariantWidget extends WidgetType {
  constructor(text, block) { super(); this.text = text; this.block = block; }
  eq(other) { return other.text === this.text && other.block === this.block; }
  toDOM() {
    const node = document.createElement(this.block ? 'div' : 'span');
    node.className = 'cm-variant-plain';
    node.textContent = this.text;
    return node;
  }
  ignoreEvent() { return true; }
}

const setPlainVariantFx = StateEffect.define();
const variantPlainField = StateField.define({
  create: () => null,
  update(value, tr) {
    if (tr.docChanged) return null;  // the writer took the sentence over
    for (const effect of tr.effects) if (effect.is(setPlainVariantFx)) return effect.value;
    return value;
  },
  provide: field => EditorView.decorations.from(field, value => {
    if (!value) return Decoration.none;
    return Decoration.set([Decoration.replace({
      widget: new PlainVariantWidget(value.text, value.block),
      block: value.block,
    }).range(value.from, value.to)], true);
  }),
});

// A brief wash over just-applied text, so the eye lands on what changed
// instead of catching a snap. Any further edit takes over and clears it.
const setFlashFx = StateEffect.define();
const flashField = StateField.define({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setFlashFx)) return effect.value;
    if (tr.docChanged) return null;
    return value;
  },
  provide: field => EditorView.decorations.from(field, value => {
    if (!value || value.from === value.to) return Decoration.none;
    return Decoration.set([Decoration.mark({ class: 'cm-applied-flash' }).range(value.from, value.to)]);
  }),
});
let flashTimer = null;

// Hover previews get a grace delay: moving between cards crosses an 8px gap,
// and clearing on mouseleave would snap the text back for one frame before
// the next card re-applies it. Leaving arms a short timer; any new preview
// — hover or keyboard focus — cancels it. Explicit exits (click in the
// draft, Escape handled by callers, new requests, applies) clear at once.
let unpreviewTimer = null;
const UNPREVIEW_DELAY = 120;

let plainPreview = null;  // { target } while a hover preview is up
function showPlainPreview(text, target) {
  plainPreview = { target };
  workView.dispatch({
    effects: [setPlainVariantFx.of({
      from: target.from,
      to: target.to,
      text,
      block: workView.state.doc.lineAt(target.from).number !== workView.state.doc.lineAt(target.to).number,
    })],
  });
}
function clearPlainPreview() {
  clearTimeout(unpreviewTimer);
  if (!plainPreview) return;
  plainPreview = null;
  try { workView.dispatch({ effects: setPlainVariantFx.of(null) }); } catch {}
  syncChatEditCards();
}

function applyText(text, target, wrap = null, card = null) {
  if (!replacementTarget(workView.state.doc.toString(), target) || workView.state.readOnly) {
    markVariantTarget(null);
    notify('The draft changed since this answer. Select the passage and request new options.');
    return;
  }
  const range = target;
  // One transaction: the preview decoration comes off in the same redraw that
  // lands the new text, so there is no intermediate frame flashing the old
  // passage back. The flash marks what changed for the eye that follows,
  // and the decided-target mark goes with the same redraw.
  plainPreview = null;
  saveSnapshot('Before AI replacement');
  workView.dispatch({
    changes:   { from: range.from, to: range.to, insert: text },
    selection: { anchor: range.from + text.length },
    effects: [
      setPlainVariantFx.of(null),
      setVariantTargetFx.of(null),
      setFlashFx.of({ from: range.from, to: range.from + text.length }),
    ],
  });
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { try { workView.dispatch({ effects: setFlashFx.of(null) }); } catch {} }, 1300);
  workView.focus();
  save();
  detach();
  // First kept option: the writer now knows hover-to-preview and click-to-
  // apply, so later groups skip the usage hint.
  try { localStorage.setItem('wa-variant-hint', 'seen'); } catch {}
  // Decided options step aside at once; undecided ones point at a range that
  // no longer exists. Inside a finding card the buttons go immediately while
  // the remark itself stays standing with its Undo. In the stream the kept
  // card is the confirmation, so the chat stays open on it instead of
  // closing behind it.
  if (card) card.classList.add('is-applied');
  if (wrap) {
    wrap.classList.add('is-spent');
    attachUndo(card, text, target);
    const hostCard = wrap.closest('.chat-entry.is-finding');
    if (hostCard && findingCards.has(Number(hostCard.dataset.findingId))) {
      const findingId = Number(hostCard.dataset.findingId);
      // Decided at once: the other buttons go immediately, while the applied
      // option stays visible on the remark with its Undo. The remark chrome
      // stays too — only further actions go, decided ones take none.
      for (const sibling of wrap.querySelectorAll('.variant-card')) {
        if (sibling !== card) sibling.hidden = true;
      }
      const foot = wrap.querySelector('.variant-foot');
      if (foot) foot.hidden = true;
      const soloHint = wrap.querySelector(':scope > .variant-hint');
      if (soloHint) soloHint.hidden = true;
      hostCard.querySelector('.finding-actions')?.remove();
      railAnchors.delete(hostCard); railHomes.delete(hostCard);
      // The finding is answered: drop it from the lists (its mark already
      // went with the edit) and refresh the counts. The card itself stays.
      if (findingId === -1) localFinding = null;
      else {
        reviewFindings = reviewFindings.filter(finding => finding.id !== findingId);
        try { workView.dispatch({ effects: dropReviewFx.of(findingId) }); } catch {}
        if (focusedFindingId === findingId) { focusedFindingId = null; syncActiveCard(); }
      }
      saveFindings();
      syncReviewLabel();
      syncStyleScore();
      layoutRail();
    } else {
      // No host card: the kept option in the stream is the whole
      // confirmation — keep it on screen with its Undo.
      setChatOpen(true);
    }
  }
}
// The way back lives on the kept card itself, with no timer: it puts back
// exactly what was replaced and only while it is still there to put back —
// it is not the editor's undo stack, which by then may belong to something
// the writer typed afterwards. The History snapshot taken before every
// replacement is the longer way back.
function attachUndo(card, text, target) {
  if (!card) return;
  let row = card.querySelector('.variant-undo-row');
  if (!row) {
    row = chatEl('div', 'variant-undo-row');
    const undo = chatEl('button', 'chat-action', 'Undo');
    undo.type = 'button';
    undo.title = 'Put the passage back as it was';
    undo.addEventListener('click', () => {
      const at = Number(undo.dataset.from);
      const { applied, previous } = undo.dataset;
      if (!undo.isConnected || undo.dataset.stale || workView.state.sliceDoc(at, at + applied.length) !== applied) {
        notify('That passage has changed since. Use the editor’s undo instead.');
        return;
      }
      workView.dispatch({ changes: { from: at, to: at + applied.length, insert: previous }, selection: { anchor: at + previous.length } });
      workView.focus();
      save();
      const spentWrap = undo.closest('.chat-variants');
      const hostCard = undo.closest('.chat-entry.is-finding');
      fadeRemove(spentWrap);
      syncVariantTarget();
      // An undone rail card remarked on text that is back to its original
      // wording but no longer marked — put it away rather than leave an
      // empty remark standing beside the line. The fading wrap still counts
      // as present until it detaches.
      if (hostCard && hostCard.dataset.findingId && !hostCard.querySelector('.chat-variants:not(.is-leaving)')) {
        const hostId = Number(hostCard.dataset.findingId);
        railAnchors.delete(hostCard); railHomes.delete(hostCard);
        findingCards.delete(hostId);
        fadeRemove(hostCard);
        refocusAfterRemoval(hostId);
      }
      layoutRail();
      // The wrap may have been the last thing in the stream — don't leave the
      // toggle over an empty panel.
      if (chatStream.children.length === 0) { setChatOpen(false); maybeCollapseIsland(); }
    });
    row.append(undo);
    card.append(row);
  }
  const undo = row.querySelector('button');
  undo.dataset.from = String(target.from);
  undo.dataset.applied = text;
  undo.dataset.previous = target.text;
  delete undo.dataset.stale;
  return undo;
}

// ── Cards ──

// Hovering a card lights the passage it belongs to. The mark's element is
// re-rendered by CodeMirror as the viewport changes, which is fine: a hover
// class only has to outlive the hover.
function markFor(id) { return workView.dom.querySelector(`.cm-slop[data-slop-id="${id}"]`); }

function syncActiveCard() {
  const focused = focusedFindingId;
  for (const [id, card] of findingCards) {
    const isFocused = id === focused;
    card.classList.toggle('is-active', isFocused);
    // No rail, no single-card rule: remarks stack in the stream, all visible.
    // The marks in the draft stay the navigation; the focused one only gets
    // the firmer edge.
    const finding = reviewFindings.find(item => item.id === id);
    if (finding) {
      railAnchors.set(card, () => {
        if (card.hidden) return null;
        if (focused !== null && id !== focused) return null;
        return findingRange(id)?.from ?? null;
      });
    }
    card.style.display = '';
  }
  layoutRail();
}

// After a focused card goes away (dismissed, undone), stand the nearest
// remaining open card against the draft instead of leaving a rail of
// hidden cards behind.
function refocusAfterRemoval(removedId) {
  if (focusedFindingId !== removedId) return;
  const live = reviewFindings.map(finding => ({ finding, range: findingRange(finding.id) })).filter(item => item.range)
    .sort((a, b) => a.range.from - b.range.from || a.finding.id - b.finding.id);
  const next = live.find(item => findingCards.has(item.finding.id));
  focusedFindingId = next ? next.finding.id : null;
  syncActiveCard();
}

function findingCard(finding, instruction) {
  const card = chatEl('div', 'chat-entry is-finding');
  card.dataset.findingId = String(finding.id);
  card.addEventListener('mouseenter', () => markFor(finding.id)?.classList.add('is-hot'));
  card.addEventListener('mouseleave', () => markFor(finding.id)?.classList.remove('is-hot'));
  // The card opens on the remark itself: pattern, why it matters, what to do.
  const dismiss = chatEl('button', 'chat-dismiss', 'Keep as is');
  dismiss.type = 'button';
  dismiss.title = 'Keep this wording and dismiss the finding';
  dismiss.addEventListener('click', () => {
    chatAbort?.abort();  // in-flight variants for a dismissed finding are waste
    clearPlainPreview();   // options generated for a dismissed finding are waste
    dismissFinding(finding.id);
  });
  card.append(
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
  const offer = chatEl('button', 'chat-action', 'Options');
  offer.type = 'button';
  offer.addEventListener('click', () => {
    const live = findingRange(finding.id);
    if (!live) {
      notify('This passage has changed. Check again.');
      return;
    }
    // Options already on screen are the answer — asking again would wipe
    // them for skeletons and land the same three cards. Retries live on the
    // group's own refresh icon; a second press while they show does nothing.
    if (offer.disabled) return;
    if (card.querySelector('.finding-variants .variant-card:not(.is-loading)')) return;
    // Retries live on the variants group as the refresh icon; the offer itself
    // just waits, dimmed, and comes back if the request fails.
    offer.disabled = true;
    offer.textContent = 'Looking…';
    // Options ask about this remark without touching the composer: no chip,
    // no placeholder swap. The target travels with the request itself, so
    // reading stays reading until the writer types something of their own.
    const target = { ...live, text: workView.state.sliceDoc(live.from, live.to), document: workView.state.doc.toString() };
    requestVariants(instruction, target, card);
  });
  const actions = chatEl('div', 'finding-actions');
  actions.append(offer, dismiss);
  const discuss = chatEl('button', 'chat-action', 'Discuss');
  discuss.type = 'button';
  discuss.addEventListener('click', () => { const range = findingRange(finding.id); if (range) attachLive(finding, range); chatInput.focus(); });
  actions.append(discuss);
  if (finding.id === -1) dismiss.textContent = 'Keep here';
  // Variants open inside this card — beside the passage they replace — not
  // in the bottom stream. The stream stays for conversation about the draft.
  const variantsBox = chatEl('div', 'finding-variants');
  card.append(actions, variantsBox);
  return card;
}

// ── Variant cards ──
//
//  A vertical stack of options. Each card names its option and applies on
//  click. Hover or keyboard focus previews the option in place on a plain
//  white sheet — no coloured diff — so the writer reads it with the
//  sentences around it.
function variantCards(variants, instruction, target, card = null) {
  const doc = workView.state.doc.toString();

  // Rank what the model already produced by the resulting whole-document
  // local score — shown nowhere and never fed to the model, or it would
  // optimise the word list instead of the writing.
  const ordered = isLatinScript(doc)
    ? variants
        .map(text => ({ text, score: styleScore(doc.slice(0, target.from) + text + doc.slice(target.to)).score }))
        .sort((a, b) => a.score - b.score)
        .map(item => item.text)
    : variants.slice();

  const wrap = chatEl('div', 'chat-variants');
  wrap.setAttribute('role', 'list');
  wrap.dataset.targetFrom = String(target.from);
  ordered.forEach((text, index) => {
    const item = chatEl('div', 'variant-card');
    item.setAttribute('role', 'listitem');
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.setAttribute('aria-label', `Apply option ${index + 1}`);
    const body = chatEl('div', 'variant-text', text);
    item.append(body);
    const previewIt = () => {
      if (wrap.classList.contains('is-spent')) return;
      if (!replacementTarget(workView.state.doc.toString(), target)) return;
      clearTimeout(unpreviewTimer);
      showPlainPreview(text, target);
    };
    const unpreview = () => {
      clearTimeout(unpreviewTimer);
      unpreviewTimer = setTimeout(clearPlainPreview, UNPREVIEW_DELAY);
    };
    item.addEventListener('mouseenter', previewIt);
    item.addEventListener('mouseleave', unpreview);
    item.addEventListener('focus', previewIt);
    item.addEventListener('blur', unpreview);
    const apply = () => { if (!wrap.classList.contains('is-spent')) applyText(text, target, wrap, item); };
    item.addEventListener('click', apply);
    item.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); apply(); }
      else if (event.key === 'Escape') { event.preventDefault(); unpreview(); item.blur(); workView.focus(); }
    });
    wrap.append(item);
  });

  // Three options none of which fit is otherwise a dead end — the passage is
  // still attached, so ask again with the same instruction.
  // /idea has no instruction to repeat, so it gets no button.
  // The usage hint is shown once: after the first applied option the writer
  // knows the drill, and the row shrinks to the retry icon alone.
  const hintSeen = (() => { try { return localStorage.getItem('wa-variant-hint') === 'seen'; } catch { return false; } })();
  if (instruction !== null) {
    const foot = chatEl('div', 'variant-foot');
    const again = chatEl('button', 'chat-action is-icon');
    again.type = 'button';
    again.setAttribute('aria-label', 'Try again — ask for three more');
    again.title = 'Try again — ask for three more';
    again.innerHTML = '<svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="19.17 3.33 19.17 8.33 14.17 8.33"/><path d="M17.07 12.5a7.5 7.5 0 1 1-1.77-7.8l3.87 3.63"/></svg>';
    again.addEventListener('click', () => {
      if (wrap.classList.contains('is-spent')) return;
      clearPlainPreview();
      wrap.remove();
      requestVariants(instruction, target, card);
    });
    if (!hintSeen) foot.append(chatEl('span', 'variant-hint', 'Hover to preview · Click to apply · Esc to dismiss'));
    foot.append(again);
    wrap.append(foot);
  } else if (!hintSeen) {
    wrap.append(chatEl('div', 'variant-hint', 'Hover to preview · Click to apply · Esc to dismiss'));
  }
  return wrap;
}

function skeletonCards(count = 3) {
  const wrap = chatEl('div', 'chat-variants is-loading');
  wrap.setAttribute('aria-busy', 'true');
  for (let i = 0; i < count; i++) {
    const item = chatEl('div', 'variant-card is-loading');
    item.append(
      chatEl('div', 'skeleton skeleton-label'),
      chatEl('div', 'skeleton skeleton-line'),
      chatEl('div', 'skeleton skeleton-line is-short'),
    );
    wrap.append(item);
  }
  return wrap;
}

// Options open inside the finding card they belong to — beside the passage
// they would replace — not in the bottom stream. The stream stays for
// conversation. hide/restore now only serve the stream fallback path.
function hideFindingCard(card) {
  if (!card || card.hidden) return;
  card.hidden = true;
  layoutRail();
}
function restoreFindingCard(card) {
  if (!card) return;
  // The offer waits dimmed while its request is in flight; a failed request
  // hands it back.
  const offer = card.querySelector('.chat-action:disabled');
  if (offer) { offer.disabled = false; offer.textContent = 'Options'; }
  if (!card.hidden) return;
  card.hidden = false;
  layoutRail();
}

// One live group at a time: when fresh options land, earlier undecided groups
// step aside — hovering between two stacks for two passages previews nothing
// coherent, and a click on a stale card only errors. Applied groups stay:
// their Undo is the way back. On a failed request nothing is touched, so old
// options plus the error beat an error alone. Groups now live both in the
// stream (selections, /idea) and inside finding cards, so retire across both.
function retireStaleVariants(except) {
  for (const stale of document.querySelectorAll('.chat-variants:not(.is-spent):not(.is-loading):not(.is-leaving)')) {
    if (stale !== except) fadeRemove(stale);
  }
  layoutRail();
}

function showVariants(variants, instruction, target) {
  const wrap = variantCards(variants, instruction, target);
  retireStaleVariants(wrap);
  chatAdd(wrap);
  markVariantTarget(target);
  // Keep the passage in view while the writer decides; the dashed target
  // mark plus hover previews do the rest.
  try { workView.dispatch({ effects: EditorView.scrollIntoView(target.from, { y: 'center' }) }); } catch {}
}

// ── Rewrite ──

async function requestVariants(instruction, existingTarget = null, card = null) {
  const range = existingTarget ?? attachedRange();
  const target = existingTarget ?? (range && { ...range, document: workView.state.doc.toString() });
  if (!range) {
    notify('That passage is no longer attached — select it again.');
    return;
  }
  if (!await ensureAgent()) return;
  if (!replacementTarget(workView.state.doc.toString(), target)) return;
  clearPlainPreview();
  markVariantTarget(null);   // a new decision supersedes the marked one
  // Finding options open inside their own card. Selections and style markers
  // have no card and keep the stream path.
  const inCard = !!(card && card.isConnected && card.querySelector('.finding-variants'));
  const box = inCard ? card.querySelector('.finding-variants') : null;
  if (inCard) {
    box.replaceChildren();
    retireStaleVariants(null);
  } else if (card) hideFindingCard(card);
  const placeholder = inCard ? box.appendChild(skeletonCards()) : chatAdd(skeletonCards());
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
        context:     notesBrief() || undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `Server error ${res.status}`);
    if (!replacementTarget(workView.state.doc.toString(), target)) throw new Error('The draft changed while the rewrites were coming back. Select the passage again.');
    const stick = chatAtBottom();
    const wrap = variantCards(data.variants, instruction, target, card);
    retireStaleVariants(wrap);
    if (inCard) {
      // The answer belongs to the remark beside the passage. The card grows;
      // the rail re-anchors so it keeps standing against its line. The offer
      // comes back — it asked and was answered, it must not read as working.
      if (placeholder.isConnected) placeholder.replaceWith(wrap);
      else box.append(wrap);
      const done = card.querySelector('.chat-action:disabled');
      if (done) { done.disabled = false; done.textContent = 'Options'; }
      layoutRail();
      markVariantTarget(target);
      // The options may land above the fold — glide them into view (nearest:
      // no scrolling when they are already fully visible).
      scrollToNode(wrap);
      try { workView.dispatch({ effects: EditorView.scrollIntoView(target.from, { y: 'center' }) }); } catch {}
    } else {
      // The chat may have been closed while the answer was in flight. A detached
      // placeholder means its spot is gone — put the options at the end instead
      // of losing them silently.
      if (placeholder.isConnected) { placeholder.replaceWith(wrap); chatScroll(stick); }
      else { placeholder.remove(); chatAdd(wrap); }
      markVariantTarget(target);
    }
  } catch (error) {
    if (error.name === 'AbortError') { placeholder.remove(); if (card) restoreFindingCard(card); else layoutRail(); syncVariantTarget(); return; }
    console.error('[/rewrite]', error);
    // Nothing came back; the remark is what the card has to say.
    placeholder.remove();
    syncVariantTarget();
    restoreFindingCard(card);
    notifyProblem(modelError(error), () => requestVariants(instruction, target, card));
  } finally { finishJob(job); if (chatAbort === job) chatAbort = null; }
}

// A finding marks a passage and is answered on that passage. Clicking the mark
// opens its card and arms nothing — reading a remark is not a request. The
// tint in the draft and the range a rewrite would replace are the same span,
// and a problem that needs material moved between paragraphs is a
// conversation, for which the bubble offers Add to context.
const findingCards = new Map();  // finding id → its card, while it is on screen

// `at` carries the click point for the action bubble; keyboard navigation
// (F8, jump buttons) passes none and gets the card alone.
function openFinding(finding, center = false, at = null) {
  closeScorePopover();
  if (finding.id !== -1) removeLocalFinding();
  clearPlainPreview();
  const range = findingRange(finding.id);
  if (!range) return;
  focusedFindingId = finding.id;
  // A direct click is already at the passage, so moving it would break spatial
  // continuity. Keyboard navigation still centres an off-screen finding.
  if (center) workView.dispatch({ effects: EditorView.scrollIntoView(range.from, { y: 'center' }) });

  // Clicking the same mark again is navigation, not a new remark: return to the
  // card that is already on screen and refocus it.
  if (findingCards.get(finding.id)?.isConnected) {
    syncActiveCard();
    collapseStreamBehind(findingCards.get(finding.id));
    findingCards.get(finding.id)?.querySelector('.chat-action')?.focus({ preventScroll: true });
    chatScroll(true);
    return;
  }

  const instruction = `Fix ${finding.pattern}: ${finding.fix}. Preserve facts and voice. Replace only the quoted passage.`;
  const card = findingCard(finding, instruction);
  // A hidden card takes no rail space; an unfocused one takes none either —
  // only the focused remark stands beside the draft (see syncActiveCard).
  findingCards.set(finding.id, railAdd(card, () => {
    if (card.hidden) return null;
    if (focusedFindingId !== null && focusedFindingId !== finding.id) return null;
    return findingRange(finding.id)?.from ?? null;
  }));
  // A fresh remark in the stream is a new arrival: open for it. In the rail it
  // is already visible beside the line, so nothing opens — instead the open
  // conversation gets out of its way (see collapseStreamBehind).
  if (card.parentElement === chatStream) setChatOpen(true);
  else collapseStreamBehind(card);
  syncActiveCard();
  card.querySelector('.chat-action')?.focus({ preventScroll: true });
  // The card is for reading the remark; the bubble is for the two acts that
  // follow it, and only a click knows where to put it. F8 and the remark list
  // pass no point and get the card alone.
  if (at) showFindingBubble(finding, at.x, at.y);
}

// A remark open beside the draft owns the writer's attention: the bottom
// conversation folds away while it stands. This hides only the stream
// element — no teardown, so cards, attachment and history all stay exactly
// as they were, and the toggle brings them back untouched.
function collapseStreamBehind(card) {
  if (!card || card.parentElement === chatStream) return;
  if (chatStream.hidden || chatStream.children.length === 0) return;
  chatStream.hidden = true;
  chatClear.hidden = false;
  chatClear.textContent = 'Conversation';
  chatClear.setAttribute('aria-label', 'Show the conversation');
  chatClear.title = 'Show the conversation';
}

// ── Conversation ──

async function chatSend() {
  // Sealed while the writer's own work runs — Stop first, then ask.
  if ([...jobs].some(job => !job.background)) return;
  const text = chatInput.value.trim();
  if (!text) return;
  if (!await ensureAgent()) return;
  chatInput.value = '';
  chatResize();
  chatAdd(chatEl('div', 'chat-entry is-user', text));

  chatHistory.push(attached && activeFinding
    ? {
        role: 'user',
        content: `${text}\n\nFinding: ${activeFinding.pattern}\nQuoted passage: ${attached.text}\nEditing direction: ${activeFinding.fix}`,
        display: text,
      }
    : { role: 'user', content: text });
  saveChat();
  streamReply(newReplyBubble());
}

function newReplyBubble() {
  const reply = chatAdd(chatEl('div', 'chat-entry is-agent is-markdown'));
  reply.append(chatEl('span', 'chat-caret'));
  return reply;
}

// Split out from chatSend so a failed answer can be asked for again without
// the writer retyping the question — the turn is already in chatHistory.
async function streamReply(reply) {
  chatAbort?.abort();
  const job = startJob(); chatAbort = job;
  const request = { document: workView.state.doc.toString(), selection: attachedRange(), changes: [] };
  chatRequests.add(request);
  let answer = '', result = null;
  try {
    const res = await fetch('/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: job.signal,
      body: JSON.stringify({
        messages: chatHistory.map(({ role, content, edits }) => ({ role, content: content + (edits?.length ? `\n${EDITS_OPEN}${JSON.stringify(edits.map(({ label, quote, replacement, state }) => ({ label, quote, replacement, state })))}</litura-edits>` : '') })),
        document: request.document, selection: request.selection?.text,
        selectionRange: request.selection && { from: request.selection.from, to: request.selection.to }, agent: currentAgent(),
        context: notesBrief() || undefined,
      }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Server error ${res.status}`);
    for await (const chunk of sseChunks(res)) {
      if (chunk.error) throw new Error(chunk.error);
      const stick = chatAtBottom();
      if (typeof chunk.answer === 'string') { answer = chunk.answer; result = chunk; }
      else answer += chunk.text ?? '';
      reply.innerHTML = renderMarkdown(answer); chatScroll(stick);
    }
    if (job.signal.aborted || !reply.isConnected) return;
    // No card is live until [DONE]; revalidate the envelope at the client too.
    const edits = locateChatEdits(result?.edits || [], request.document, request.selection);
    for (const edit of edits) for (const changes of request.changes) mapChatEdit(edit, changes);
    const message = { role: 'assistant', content: answer, edits, editWarning: result?.editWarning };
    chatHistory.push(message); renderChatAnswer(reply, message); saveChat(); chatScroll(true);
    if (message.editWarning) notify(message.editWarning);
  } catch (error) {
    if (!reply.isConnected) return;
    if (error.name === 'AbortError') { reply.innerHTML = renderMarkdown(answer ? answer + '\n\n[Stopped — incomplete]' : 'Stopped'); return; }
    console.error('[/chat]', error);
    if (!answer) { reply.remove(); notifyProblem(modelError(error), () => streamReply(newReplyBubble())); }
    else reply.innerHTML = renderMarkdown(answer + '\n\n' + modelError(error).say);
  } finally { chatRequests.delete(request); finishJob(job); if (chatAbort === job) chatAbort = null; }
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
  // While the writer's own work runs, the field is sealed: typing then would
  // read as steering a request that already left. The invitation says what
  // the field is doing instead, and the button is the work now.
  chatInput.readOnly = busy;
  chatInput.closest('.chat-composer')?.classList.toggle('is-busy', busy);
  chatInput.placeholder = busy ? 'Working…' : basePlaceholder();
}

chatSendButton.addEventListener('click', () => {
  // The button stops only what it was showing: work the writer started.
  if ([...jobs].some(job => !job.background)) { stopJobs(); return; }
  chatSend();
  chatInput.focus();
});

syncSend();
chatInput.addEventListener('input', chatResize);

chatInput.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); chatSend(); }
  else if (event.key === 'Escape') {
    // Escape belongs to the composer only while it has something to give up.
    // A key with two owners is claimed by the inner one: stopPropagation, so
    // nothing further up reads a state this handler has already undone — and
    // nothing above can act on the same press. With nothing attached and no
    // request running, the key is left alone to reach the sidebar overlay.
    if (chatAbort && !chatAbort.signal.aborted) { chatAbort.abort(); event.stopPropagation(); return; }
    if (attached) {
      detach();
      workView.focus();
      event.stopPropagation();
      return;
    }
    // An empty, unstarted composer folds back into the pill.
    if (!chatInput.value.trim() && canCollapseIsland()) {
      setIsland(false);
      workView.focus();
      event.stopPropagation();
    }
  }
});

chatChipClear.addEventListener('click', () => { detach(); chatInput.focus(); });

// Keep focus where it is while the button is pressed: the mousedown would
// otherwise blur the composer first, and the click would read as leaving the
// field rather than as opening or closing the conversation.
chatClear.addEventListener('mousedown', event => event.preventDefault());
chatClear.addEventListener('click', () => {
  const open = chatStream.hidden;
  // Closing an empty, unstarted chat folds the whole island back into the
  // pill; the draft gets the focus back either way.
  if (!open && canCollapseIsland()) {
    setChatOpen(false);
    setIsland(false);
    workView.focus();
    return;
  }
  setChatOpen(open);
  // Dismissing returns to the draft; opening returns to the composer. Focusing
  // the composer on close pops the keyboard after the user asked to leave.
  (open ? chatInput : workView).focus();
});

// Manual selection attach is explicit: Cmd/Ctrl+K takes the current
// selection into the composer, or just focuses it when there is none.
// Clicks never attach — reading arms nothing; the bubble offers it.
const MANUAL_ATTACH = false;
// Cmd/Ctrl+K from anywhere: take the current selection into the composer.
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    dismissPassingNotice();
    openIsland();
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
    fontSize:   '17px',
    lineHeight: '1.75',
    overflowY:  'auto',
  },

  // Editable content area — generous padding, centred like the old textarea
  '.cm-content': {
    // The measure is set in characters, so it holds if the size changes.
    padding:    '28px max(32px, calc((100% - 68ch) / 2))',
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
    margin:        '4px 0 2px',
    padding:       '6px 10px',
    // Sits between two lines of the writer's own prose. It is an inset strip
    // of the draft — not a floating chat card, which is what --overlay plus a
    // shadow reads as — so it takes the sunken surface and no shadow. The
    // accent edge is what names it as model-suggested.
    border:        '1px solid var(--border-subtle)',
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
    // --text-2, not --muted: this chip sits on --surface-3, where --muted is
    // 3.83:1 and misses AA at 11px. One step down from --text is still the
    // quietest ink that passes.
    color:         'var(--text-2)',
    fontFamily:    'var(--ui-font)',
    fontSize:      '11px',
    letterSpacing: '.02em',
  },

  // The attached passage. Survives losing focus, unlike a native selection —
  // that is the only job this mark has for a plain selection, which carries
  // no marking of its own. A background wash: underlines belong to errors
  // (dictionary, typos) and are never used for working states.
  '.cm-attached': {
    background: 'var(--attached-tint)',
    borderRadius: '3px',
    boxShadow: '0 0 0 2px var(--attached-tint)',
  },

  // Over a finding two washes would merge into one unreadable stain, so the
  // attachment keeps a thin accent edge here on top of its wash — the single
  // outlined exception, and only over findings. Tracking the live position
  // is unchanged: that is what lets an edit end the attachment.
  '.cm-attached.cm-attached-finding': {
    background: 'var(--attached-tint)',
    borderRadius: '3px',
    boxShadow: '0 0 0 2px var(--attached-tint), 0 0 0 3.5px var(--accent)',
  },

  // Model findings read as a background band. The wavy underline is reserved
  // for errors (local dictionary, typos) — findings never underline.
  '.cm-slop': {
    background: 'var(--remark-tint)',
    borderRadius: '2px',
    boxShadow: 'inset 0 -1px 0 var(--remark-line)',
    cursor: 'pointer',
    transition: 'background .12s ease',
  },

  '.cm-slop:hover': { background: 'var(--remark-tint-hover)' },

  // Margin notes read blue against the findings' amber: the writer's own
  // remarks, not the model's. A background wash like every other working
  // state — underlines belong to errors. Drifted notes (quote gone, holding
  // the paragraph) get the dashed outline instead of the wash edge.
  '.cm-note': {
    background: 'color-mix(in srgb, var(--accent) 12%, transparent)',
    borderRadius: '2px',
    boxShadow: 'inset 0 -1px 0 color-mix(in srgb, var(--accent) 45%, transparent)',
    cursor: 'pointer',
    transition: 'background .12s ease',
  },

  '.cm-note.is-drifted': {
    background: 'color-mix(in srgb, var(--accent) 6%, transparent)',
    outline: '1.5px dashed color-mix(in srgb, var(--accent) 55%, transparent)',
    outlineOffset: '2px',
  },

  // The passage whose variants are currently open: a dashed accent outline
  // with a faint wash — the only dashed mark in the draft, reading as
  // "deciding here". Paints over the attachment wash when they coincide;
  // hover previews paint over everything while they last.
  '.cm-variant-target': {
    background: 'color-mix(in srgb, var(--accent) 8%, transparent)',
    borderRadius: '3px',
    outline: '1.5px dashed var(--accent)',
    outlineOffset: '3px',
  },

  // Hover preview of a variant: the same white sheet, but dashed — a sketch
  // of the text, not the text. Only shows while a card is hovered or focused.
  '.cm-variant-plain': {
    background: 'var(--overlay)',
    borderRadius: '2px',
    boxShadow: '0 0 0 2px var(--overlay)',
    border: '1px dashed var(--accent)',
  },

  // Slightly dim the content while /idea is streaming
  '&.streaming .cm-content': { opacity: '0.8' },

  // Placeholder text (shown when doc is empty)
  // It carries the only instruction in the product now, so it has to be
  // readable, not a watermark.
  '.cm-placeholder': {
    color:      'var(--muted)',
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
          // Tab accepts a suggestion; otherwise it moves focus normally.
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
            const pending = suggestTimer !== null || suggestAbort !== null;
            if (!ghost && !pending) return false;
            cancelSuggestion();
            ghostClear(view);
            return true;
          },
        },
        {
          key: 'Mod-Enter',
          run(view) {
            cancelSuggestion();
            ghostClear(view);
            void suggestFetch(true);
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
      // Native spellcheck: free red squiggly + right-click suggestions from
      // the OS/browser dictionary. Autocorrect/autocapitalize stay off — a
      // silent rewrite is not what "quick fix" means here.
      EditorView.contentAttributes.of({
        'aria-label': 'Draft editor', 'aria-describedby': 'suggest-shortcut',
        spellcheck: 'true', autocorrect: 'off', autocapitalize: 'off',
      }),

      // Ghost text state + decoration provider
      ghostField,
      reviewField,
      noteField,
      styleMarkerField,
      spellMarkerField,
      attachField,
      variantTargetField,
      variantPlainField,
      flashField,

      // Read-only compartment — toggled during /idea streaming
      readonlyComp.of(EditorState.readOnly.of(true)),

      // Word wrap (essential for prose)
      EditorView.lineWrapping,

      // Reserve the covered strips so CodeMirror scrolls the caret clear of
      // both: the floating panel below, and the 48px header above — a jumped-to
      // line never parks flush under it.
      EditorView.scrollMargins.of(() => ({ top: 64, bottom: chatHeight })),

      // The only instruction the product gives here: where files come from.
      // Gone by the first keystroke. SPEC.md §Editor.
      placeholder('Start writing, or open a file from the sidebar.'),

      // Visual theme
      editorTheme,

      // Both gestures attach the passage to the composer instead of opening a
      // window — one place for context, one place for answers.
      EditorView.domEventHandlers({
        compositionstart(_event, view) { cancelSuggestion(); ghostClear(view); return false; },
        compositionend() { suggestSchedule(); return false; },
        click(event, view) {
          // A real selection wins over the mark underneath it: selecting is
          // acting, clicking is reading. The selection bubble already stands
          // from mouseup; the mark keeps its caret placement only.
          if (!view.state.selection.main.empty) return false;
          const at = { x: event.clientX, y: event.clientY };
          // The writer's own notes win over model marks underneath: a click
          // reads the note and arms nothing.
          const noteMarkEl = event.target.closest?.('.cm-note');
          if (noteMarkEl) {
            if (noteMarkEl.dataset.noteId && noteCards.has(noteMarkEl.dataset.noteId)) focusNote(noteMarkEl.dataset.noteId);
            return false;
          }
          const mark = event.target.closest?.('.cm-slop');
          if (!mark) {
            const spellLocal = event.target.closest?.('.cm-spell-marker');
            const spellMarker = spellLocal && view.state.field(spellMarkerField).find(item => item.from === Number(spellLocal.dataset.spellFrom));
            if (spellMarker) { showSpellBubble(spellMarker, at.x, at.y); return false; }
            const local = event.target.closest?.('.cm-style-marker');
            const marker = local && view.state.field(styleMarkerField).find(item => item.from === Number(local.dataset.styleFrom));
            // Reading the reason arms nothing — the bubble holds Add to
            // context and Rewrite for when the writer decides.
            if (marker) selectStyleMarker(marker, at);
            // Only where a continuation is even possible — the same spot
            // Cmd/Ctrl+Enter already requires — so an ordinary click to fix a
            // word mid-paragraph never raises the bubble.
            // Deferred longer than a selection's: a click at the end is
            // most often the writer about to keep typing themselves.
            else if (atParagraphEnd(view.state)) deferBubble(() => showContinueBubble(at.x, at.y), 450);
            return false;
          }
          const finding = reviewFindings.find(item => item.id === Number(mark.dataset.slopId));
          if (!finding) return false;
          // Do not swallow the click: the caret still lands where the writer
          // clicked, so an underlined sentence stays as editable as any other.
          // The card opens for reading; the bubble offers context and rewrites.
          openFinding(finding, false, at);
          return false;
        },
        // Reaching for the text dismisses a hover preview; the cards stay —
        // choosing is a click on a card, not a click in the draft.
        mousedown() { clearPlainPreview(); return false; },
        contextmenu(event, view) {
          // Always the native menu: selections attach through the bubble or
          // Cmd/Ctrl+K instead, so right-click keeps copy and paste.
          if (!MANUAL_ATTACH) return false;
          const sel = view.state.selection.main;
          if (sel.empty) return false; // no selection — show native menu
          event.preventDefault();
          attach({ from: sel.from, to: sel.to, text: view.state.sliceDoc(sel.from, sel.to) });
          return true;
        },
      }),

      EditorView.updateListener.of(suggestionUpdate),

      // Save on every edit.
      // Anything that moves the text moves the cards beside it.
      EditorView.updateListener.of(update => {
        if (update.docChanged || update.geometryChanged || update.viewportChanged) {
          layoutRail();
          hideNotePlus();   // its paragraph may have moved; it follows the mouse back
          // Only an edit invalidates the bubble — the words it points at may
          // be gone. A scroll or a reflow moves them; the bubble follows.
          if (update.docChanged) hideMarkBubble();
          else reanchorBubble();
        } else if (bubbleMode === 'selection' && update.selectionSet && update.state.selection.main.empty) {
          hideMarkBubble();
        }
      }),

      EditorView.updateListener.of(update => {
        if (update.docChanged) {
          editVersion++;
          activeStyleFrom = null;
          if (reviewState !== 'idle') { reviewState = 'stale'; reviewNotice = ''; }
          for (const request of chatRequests) request.changes.push(update.changes);
          for (const message of chatHistory) for (const edit of message.edits || []) {
            if (edit !== changingChatEdit) mapChatEdit(edit, update.changes);
          }
          if (localFinding) mapChatEdit(localFinding, update.changes);
          syncChatEditCards();
          if (!loadingDocument) { saveChat(); saveKeptStyle(); saveFindings(); }
          // Undo follows edits before the replacement, but never overwrites
          // subsequent work inside it, even if identical wording occurs nearby.
          for (const undo of chatStream.querySelectorAll('.variant-undo-row button')) {
            const from = Number(undo.dataset.from), to = from + undo.dataset.applied.length;
            update.changes.iterChangedRanges((a, b) => {
              if (a < to && b > from) undo.dataset.stale = 'true';
            });
            undo.dataset.from = String(update.changes.mapPos(from, 1));
          }
          if (update.transactions.some(tr => tr.isUserEvent('undo') || tr.isUserEvent('redo'))) clearNotice('undo');
          // No "out of date" notice here: findings are live-anchored — edits
          // outside their ranges only shift the marks, edits inside drop
          // them — so there is nothing stale to announce on every keystroke.
          // Typing inside the attached passage is the writer fixing it
          // themselves — drop the attachment rather than let a rewrite land on
          // top of the edit. Deferred: a dispatch inside an update is illegal.
          if (attached && update.state.field(attachField).size === 0) {
            queueMicrotask(() => { detach(); });
          }
          // A hover preview is a decoration over the old range; any edit drops it.
          if (plainPreview) queueMicrotask(clearPlainPreview);
          if (reviewFindings.length) { syncReviewLabel(); saveFindings(); }
          // Notes re-anchor against the new text (verbatim, else paragraph
          // fallback) on the next tick — a dispatch inside an update is
          // illegal, same as the detach below.
          if (marginNotes.length && !loadingDocument) {
            saveNotes();
            queueMicrotask(() => { if (!loadingDocument && marginNotes.length) syncNoteMarks(); });
          }
          if (!loadingDocument) save();
          autoReviewSchedule();
          syncStyleScore();
        }
      }),
    ],
  }),

  parent: editorWrap,
});

// The dictionary is a couple hundred KB; fetch it once in the background and
// mark whatever is already on the page as soon as it lands.
loadSpellDictionary().then(spell => {
  spellChecker = spell;
  workView.dispatch({ effects: refreshSpellFx.of(null) });
}).catch(error => console.warn('[spell] dictionary unavailable —', error.message));

// ─── Persist ───────────────────────────────────────────────────────────────────

new ResizeObserver(() => {
  // Panel height + its 36px offset from the bottom + a line of breathing room.
  chatHeight = Math.round(chatPanel.getBoundingClientRect().height) + 64;
  document.documentElement.style.setProperty('--chat-height', `${chatHeight}px`);
  workView.dispatch({
    effects: EditorView.scrollIntoView(workView.state.selection.main.head, { y: 'nearest' }),
  });
}).observe(chatPanel);

// Workspace identity comes from the server path, never from the port or a
// global browser draft. Conflicts pause writes until explicitly resolved.
function saveSnapshot(label) {
  const snapshots = safeJson(docStorage.getItem('snapshots'), []);
  if (!Array.isArray(snapshots)) return;
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
  reviewState = 'idle'; reviewNotice = ''; keptStyle = []; removeLocalFinding();
  chatEditCards.clear();
  scoreDetails.hidePopover();
  clearNotice('undo');
  for (const job of jobs) job.abort();
  cancelSuggestion();
  saveSnapshot('Before replacing document');
  detach();
  workView.dispatch({ changes: { from: 0, to: workView.state.doc.length, insert: text } });
  clearReview();
  discardNoteCards();
  docStorage.removeItem('wa-notes');
  chatHistory = []; chatStream.replaceChildren(); findingCards.clear();
  docStorage.removeItem('wa-chat');
  docStorage.removeItem('wa-kept-wording');
  docStorage.removeItem('dismissed');
  setChatOpen(false);   // the stream was just emptied — don't leave × over nothing
  maybeCollapseIsland();
  loadingDocument = false;
}
// Replacing the draft asks nothing: the old text goes to History, and the
// notice carries an Undo for the next few seconds.
function replaceDraft(text, message) {
  const previous = workView.state.doc.toString();
  loadFromDisk(text); save();
  notifyUndo(message, () => { loadFromDisk(previous); save(); });
}
function saveToDisk() {
  clearTimeout(diskTimer);
  if (savePaused || loadingDocument || diskHold) return;
  // Routine saves are silent: autosave is expected to work, and a Saved /
  // Unsaved flicker on every pause reports nothing the writer can act on.
  // The header speaks only when attention is needed (error, conflict).
  diskTimer = setTimeout(flushSave, 800);
}
async function flushSave() {
  if (saving || savePaused || loadingDocument || diskHold) return;
  const text = workView.state.doc.toString();
  if (text === diskText && diskRevision !== 'missing') return;
  saving = true;
  try {
    const response = await fetch('/draft', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, revision: diskRevision }),
    });
    const data = await response.json();
    if (response.status === 409) { handleFreshDisk(data.current); return; }
    if (!response.ok) throw new Error(data.error || 'Save failed');
    noteDiskBaseline(text, data.revision);
    // A recovered save clears a previous error line, then goes quiet again.
    clearNotice('disk');
  } catch (error) {
    savePaused = true;
    cancelSuggestion();
    ghostClear(workView);
    // The payload belongs in the tooltip; the notice carries the sentence
    // and the way out.
    notifyProblem({ say: 'Not saved — autosave paused.', act: 'retry', detail: error.message },
      () => { savePaused = false; saveToDisk(); }, 'Retry saving', 'disk');
  } finally {
    saving = false;
    if (!savePaused && workView.state.doc.toString() !== diskText) saveToDisk();
  }
}
function save() {
  docStorage.setItem('wa-working', workView.state.doc.toString());
  saveToDisk();
}
// ─── Disk drift ──────────────────────────────────────────────────────────────
//
//  No modal, ever: a file changing under the editor is routine (another
//  editor, a second tab, a git pull), and a modal makes it an emergency.
//  The verdict comes from resolveDrift — silent in the two cases that need
//  no decision, and a slim banner above the draft in the one that does.
//  While the banner stands only disk writes wait; typing, suggestions and
//  the assistant keep working on the local copy.
const driftBanner = document.getElementById('drift-banner');
const driftDiffBody = document.getElementById('drift-diff-body');
let driftCurrent = null;   // fresh { text, revision } awaiting a choice

// The last disk text we confirmed, durable across restarts. Without it a
// reopen with unsaved work looks identical to an external edit — that
// confusion is what the old launch modal punished.
function noteDiskBaseline(text, revision) {
  diskText = text; diskRevision = revision;
  docStorage.setItem('wa-disk', JSON.stringify({ text, revision }));
}
function lastDiskBaseline() {
  const base = safeJson(docStorage.getItem('wa-disk'), null);
  return base && typeof base.text === 'string' ? base : null;
}
function handleFreshDisk(current) {
  if (!current || typeof current.text !== 'string') return;
  const verdict = resolveDrift(workView.state.doc.toString(), current.text, lastDiskBaseline()?.text);
  if (verdict === 'in-sync') { noteDiskBaseline(current.text, current.revision); hideDriftBanner(); return; }
  if (verdict === 'fast-forward') { adoptDiskText(current, true); return; }
  showDriftBanner(current);
}
// Take the disk copy without touching chat, findings or focus: the writer
// changed nothing, so there is nothing of theirs to disturb. Announced with
// a toast when it happens behind their back, silently at startup.
function adoptDiskText(current, announce = false) {
  workView.dispatch({ changes: { from: 0, to: workView.state.doc.length, insert: current.text } });
  noteDiskBaseline(current.text, current.revision);
  diskHold = false; hideDriftBanner(); save();
  if (announce) notify('Reloaded from disk — it changed outside Litura.');
}
function showDriftBanner(current) {
  driftCurrent = current;
  diskHold = true;
  // The banner is the whole report for this case: it sits over the draft,
  // names the conflict and carries both ways out. A second copy in the stream
  // said the same sentence in error red and pulled the panel open over the
  // text the writer was trying to resolve it against.
  renderDriftDiff();
  driftBanner.hidden = false;
}
function hideDriftBanner() {
  driftCurrent = null;
  driftBanner.hidden = true;
  document.getElementById('drift-diff')?.removeAttribute('open');
}
function renderDriftDiff() {
  driftDiffBody.replaceChildren();
  if (!driftCurrent) return;
  const local = workView.state.doc.toString();
  const ops = wordDiff(driftCurrent.text, local);
  let shown = 0;
  for (const op of ops) {
    let text = op.text;
    // Long unchanged runs collapse: the decision needs the changes, not the
    // whole document reprinted around them.
    if (op.type === 'keep' && text.length > 400) text = text.slice(0, 200) + ' ⋯ ' + text.slice(-200);
    if (shown + text.length > 30000) {
      driftDiffBody.append(chatEl('p', 'drift-diff-more', '… further differences truncated'));
      break;
    }
    shown += text.length;
    if (op.type === 'keep') driftDiffBody.append(document.createTextNode(text));
    else {
      const mark = document.createElement(op.type === 'del' ? 'del' : 'ins');
      mark.className = op.type === 'del' ? 'drift-del' : 'drift-ins';
      mark.textContent = text;
      driftDiffBody.append(mark);
    }
  }
  const legend = chatEl('p', 'drift-legend', 'Struck text lives only on disk · highlighted text only in your copy');
  driftDiffBody.prepend(legend);
}
document.getElementById('drift-load').addEventListener('click', () => {
  if (driftCurrent) adoptDiskText(driftCurrent);
  workView.focus();
});
document.getElementById('drift-keep').addEventListener('click', () => {
  if (!driftCurrent) return;
  // Adopt the fresh revision and keep typing: the next save overwrites the
  // disk copy. Overwriting loses nothing — the server snapshots the previous
  // disk text into .litura-history before every write, and the browser keeps
  // its own checkpoint in History.
  noteDiskBaseline(driftCurrent.text, driftCurrent.revision);
  diskHold = false; hideDriftBanner(); save(); workView.focus();
});
async function initializeDocument() {
  try {
    const current = await api('/draft');
    documentKey = 'litura:' + current.id + ':';
    documentName = current.path.split(/[\\/]/).pop();
    // Captured before the baseline below is rewritten: it tells a reopen
    // with unsaved work apart from a file that moved while we were away.
    const driftBase = lastDiskBaseline();
    noteDiskBaseline(current.text, current.revision);
    const cached = docStorage.getItem('wa-working');
    workView.dispatch({ changes: { from: 0, to: workView.state.doc.length, insert: cached ?? current.text } });
    loadingDocument = false;
    editorSetReadonly(workView, false);
    // The text that was already here is not something the writer just
    // finished. Automatic review is on by default, and opening a draft must
    // not spend a model call on it — auditing the whole document is what
    // `Check for slop` is for. A paragraph the writer touches gets a new key
    // and is checked then.
    for (const paragraph of reviewParagraphs(workView.state.doc.toString())) checkedSentences.add(paragraph.key);
    syncReviewLabel();
    savePaused = false;
    try {
      const kept = JSON.parse(docStorage.getItem('wa-kept-wording') || 'null');
      if (kept?.document === workView.state.doc.toString() && Array.isArray(kept.marks)) keptStyle = kept.marks.filter(mark => chatEditMatches(mark, kept.document));
    } catch {}
    workView.dispatch({ effects: refreshStyleFx.of(null) });
    restoreFindings(); restoreChat(); restoreNotes(); syncStyleScore(); renderFileList();
    // A reopen with unsaved work is not a conflict when the disk stood
    // still — only a disk that moved while we were away earns the banner.
    if (cached !== null) {
      const verdict = resolveDrift(workView.state.doc.toString(), current.text, driftBase?.text);
      if (verdict === 'fast-forward') adoptDiskText(current);
      else if (verdict === 'diverged') showDriftBanner(current);
    }
    else clearNotice('disk');
    const legacy = localStorage.getItem('wa-working');
    if (legacy !== null && legacy !== current.text && !docStorage.getItem('legacy-offered')) {
      notify('A draft from the previous Litura version was found.', {
        action: () => { exportText(legacy, 'legacy-draft.md'); docStorage.setItem('legacy-offered', 'yes'); },
        label: 'Export', sticky: true,
      });
    }
  } catch (error) {
    notifyProblem({ say: 'Litura could not open the draft.', act: 'retry', detail: error.message }, initializeDocument, 'Retry', 'disk');
  }
}
initializeDocument();
async function checkDiskDrift() {
  if (loadingDocument || saving) return;
  try {
    const current = await api('/draft');
    if (current.revision !== diskRevision) handleFreshDisk(current);
  } catch (error) { notify('Cannot check disk: ' + error.message, { sticky: true, key: 'disk' }); }
}
window.addEventListener('focus', () => { checkDiskDrift(); if (!sidebar.classList.contains('is-closed')) refreshFileList(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { cancelSuggestion(); ghostClear(workView); }
  else { checkDiskDrift(); refreshUpdate(); }
});
window.addEventListener('beforeunload', event => {
  if (!loadingDocument && (saving || workView.state.doc.toString() !== diskText)) { event.preventDefault(); event.returnValue = ''; }
});
document.getElementById('file-new').addEventListener('click', () => {
  if (workView.state.doc.length) replaceDraft('', 'New document — the old text is in History');
  workView.focus();
});
document.getElementById('file-export').addEventListener('click', async () => {
  const handle = await showSaveFilePicker({
    suggestedName: documentName,
    types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown'], 'text/plain': ['.txt'] } }],
  }).catch(() => null);
  if (!handle) return;
  const writable = await handle.createWritable();
  await writable.write(workView.state.doc.toString());
  await writable.close();
  refreshFileList();
  workView.focus();
});
document.addEventListener('keydown', event => {
  if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return;
  event.preventDefault(); clearTimeout(diskTimer); flushSave();
});
async function importFile(file) {
  if (!file || loadingDocument) return;
  if (file.size > 1024 * 1024 || !/\.(md|markdown|txt)$/i.test(file.name)) {
    notify('Open a Markdown or text file under 1 MB.');
    return;
  }
  try {
    const text = await file.text();
    // Hard-wrapped imports open flowing, same as sidebar files — the Undo in
    // the notice puts the exact bytes back.
    const opened = unwrapProse(text);
    replaceDraft(opened.text, opened.joined > 0 ? `Imported ${file.name} — ${opened.joined} wrapped lines joined` : `Imported ${file.name}`);
    refreshFileList();
  } catch (error) { notify('Import failed: ' + error.message, { sticky: true }); }
}
// ─── File sidebar ────────────────────────────────────────────────────────────
//
//  The header toggle owns the sidebar; every file action lives inside it.
//  Rows name the workspace Markdown and text files — opening one switches the
//  single active document (and its saves) onto that file, so what is on screen
//  is always what is being saved. Each file keeps its own browser copy, chat
//  and findings, which come back when it is opened again.
const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebarToggleSide = document.getElementById('sidebar-toggle-side');
const fileList = document.getElementById('file-list');
const fileFilter = document.getElementById('file-filter');
let sidebarFiles = [];
let sidebarToggleTimer = null;
function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
// Card timestamp: short relative age, falling back to a date past a month.
function timeAgo(iso) {
  const at = new Date(iso).getTime();
  if (!at) return '';
  const seconds = Math.max(0, (Date.now() - at) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 30 * 86400) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
// True only where the sidebar is a layer over the draft rather than a column
// beside it — the same 640px the stylesheet switches the panel to `fixed` at.
// Above it the panel is part of the layout, and dismissing it on Escape or a
// stray click would be closing a pane the writer is reading beside.
const sidebarOverlayQuery = window.matchMedia('(max-width: 640px)');
const sidebarIsOverlay = () => sidebarOverlayQuery.matches && !sidebar.classList.contains('is-closed');
function setSidebar(open, persist = true) {
  // Width-animated, not display-toggled: the pane and composer glide with
  // it. inert keeps the collapsed panel out of tab order and screen readers.
  sidebar.classList.toggle('is-closed', !open);
  sidebar.inert = !open;
  // Two static buttons, one per head: each stays where it is, so nothing
  // travels while the panel glides. Both hide for the glide itself — neither
  // the leaving nor the arriving button should be caught mid-travel — then
  // only the one in the visible head comes back. Matches the .25s width
  // transition in CSS; instant when motion is reduced.
  sidebarToggle.hidden = true;
  sidebarToggleSide.hidden = true;
  sidebarToggle.setAttribute('aria-expanded', String(open));
  sidebarToggleSide.setAttribute('aria-expanded', String(open));
  clearTimeout(sidebarToggleTimer);
  const revealToggle = () => { sidebarToggle.hidden = open; sidebarToggleSide.hidden = !open; };
  // Nothing glides on the first call — the panel is already where it is going
  // to be — so waiting out the transition would only leave the window with no
  // toggle at all for a quarter of a second on every launch.
  if (!persist || reduceMotion()) revealToggle();
  else sidebarToggleTimer = setTimeout(revealToggle, 260);
  // The composer is viewport-centred (position: fixed), while the draft
  // re-centres inside the narrowed pane — without this it sits 124px off
  // the text it belongs to whenever the panel is open.
  document.documentElement.dataset.sidebar = open ? 'open' : 'closed';
  if (persist) { try { localStorage.setItem('wa-sidebar', open ? 'open' : 'closed'); } catch {} }
  if (open) refreshFileList();
}
function renderFileList() {
  const query = fileFilter.value.trim().toLowerCase();
  const shown = sidebarFiles.filter(file => !query || file.name.toLowerCase().includes(query));
  fileList.replaceChildren();
  if (!sidebarFiles.length) {
    fileList.append(chatEl('li', 'file-list-empty', 'No Markdown or text files here yet.'));
    return;
  }
  if (!shown.length) {
    fileList.append(chatEl('li', 'file-list-empty', 'Nothing matches this filter.'));
    return;
  }
  for (const file of shown) {
    const item = document.createElement('li');
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'file-card';
    // The card shows name, age and excerpt; the size stays in the tooltip.
    row.title = `${file.name} · ${formatFileSize(file.size)}`;
    if (file.name === documentName) row.setAttribute('aria-current', 'true');
    const top = chatEl('span', 'file-card-top');
    const name = chatEl('span', 'file-name', '');
    name.textContent = file.name;
    const meta = chatEl('span', 'file-meta', '');
    meta.textContent = timeAgo(file.mtime);
    top.append(name, meta);
    row.append(top);
    if (file.excerpt) {
      const excerpt = chatEl('span', 'file-excerpt', '');
      excerpt.textContent = file.excerpt;
      row.append(excerpt);
    }
    // Opening a file is the end of the visit to the panel, so on a narrow
    // window the overlay gets out of the way of the draft it just replaced.
    row.addEventListener('click', () => {
      if (sidebarIsOverlay()) setSidebar(false);
      switchDocument(file.name);
    });
    item.append(row);
    fileList.append(item);
  }
}
async function refreshFileList() {
  try {
    const { files } = await api('/files');
    sidebarFiles = Array.isArray(files) ? files : [];
  } catch { sidebarFiles = []; }
  renderFileList();
}
// Opening a file switches the single active document — and its saves — onto
// it. The previous file is untouched: its disk copy keeps whatever was last
// saved, and its browser copy, chat and findings wait under their own storage
// key until it is opened again.
async function switchDocument(name) {
  if (loadingDocument || name === documentName) { workView.focus(); return; }
  // Flush pending edits to the current file before the server retargets:
  // after POST /draft/open every save lands on the new file.
  try {
    clearTimeout(diskTimer);
    if (!savePaused && !diskHold) await flushSave();
    saveChat(); saveFindings(); saveKeptStyle(); saveNotes();
    saveSnapshot('Before switching document');
  } catch {}
  let current;
  try {
    current = await api('/draft/open', { method: 'POST', body: JSON.stringify({ name }) });
  } catch (error) { notify(`Could not open ${name}: ${error.message}`, { sticky: true }); return; }
  loadingDocument = true;
  for (const job of jobs) job.abort();
  cancelSuggestion();
  // Per-document UI bound to the old text goes; the old file's own state was
  // stored under its key above and is restored when it is opened again.
  detach();
  reviewState = 'idle'; reviewNotice = ''; keptStyle = []; removeLocalFinding();
  chatEditCards.clear();
  scoreDetails.hidePopover();
  clearNotice('undo');
  clearNotice('disk');
  discardFindingCards();
  discardNoteCards();
  for (const stale of document.querySelectorAll('.chat-variants')) stale.remove();
  clearPlainPreview();
  reviewFindings = [];
  focusedFindingId = null; jumpFrom = -1;
  checkedSentences.clear();
  chatHistory = []; chatStream.replaceChildren();
  setChatOpen(false);   // the stream was just emptied — don't leave × over nothing
  maybeCollapseIsland();
  hideDriftBanner(); diskHold = false;
  // Retarget storage and the disk baseline onto the new file first: every
  // restore below reads under the new key.
  documentKey = 'litura:' + current.id + ':';
  documentName = current.path.split(/[\\/]/).pop();
  // Captured before the baseline below is rewritten: it tells a reopen
  // with unsaved work apart from a file that moved while we were away.
  const driftBase = lastDiskBaseline();
  noteDiskBaseline(current.text, current.revision);
  const cached = docStorage.getItem('wa-working');
  // Hard-wrapped prose opens flowing: a lone newline inside a paragraph is a
  // Markdown soft break, so join wrapped lines back and keep real paragraph
  // breaks and structure. A cached copy was already unwrapped when saved.
  const opened = cached === null ? unwrapProse(current.text) : { text: cached, joined: 0 };
  workView.dispatch({ changes: { from: 0, to: workView.state.doc.length, insert: opened.text } });
  workView.dispatch({ effects: setReviewFx.of([]) });
  markVariantTarget(null);
  loadingDocument = false;
  // The text that was already here is not something the writer just
  // finished. Opening spends no model call, same as at startup: auditing the
  // whole document is what `Check for slop` is for.
  for (const paragraph of reviewParagraphs(workView.state.doc.toString())) checkedSentences.add(paragraph.key);
  syncReviewLabel();
  try {
    const kept = JSON.parse(docStorage.getItem('wa-kept-wording') || 'null');
    if (kept?.document === workView.state.doc.toString() && Array.isArray(kept.marks)) keptStyle = kept.marks.filter(mark => chatEditMatches(mark, kept.document));
  } catch {}
  workView.dispatch({ effects: refreshStyleFx.of(null) });
  restoreFindings(); restoreChat(); restoreNotes(); syncStyleScore(); renderFileList();
  // A reopen with unsaved work is not a conflict when the disk stood
  // still — only a disk that moved while we were away earns the banner.
  if (cached !== null) {
    const verdict = resolveDrift(workView.state.doc.toString(), current.text, driftBase?.text);
    if (verdict === 'fast-forward') adoptDiskText(current);
    else if (verdict === 'diverged') showDriftBanner(current);
  }
  else clearNotice('disk');
  refreshFileList();
  if (opened.joined > 0) {
    notifyUndo(`Opened ${documentName} — ${opened.joined} wrapped ${opened.joined === 1 ? 'line' : 'lines'} joined into paragraphs. Saves go to this file.`, () => {
      workView.dispatch({ changes: { from: 0, to: workView.state.doc.length, insert: current.text } });
      save();
    });
  } else {
    notify(`Opened ${documentName}. Saves go to this file.`);
  }
  workView.focus();
}
const toggleSidebar = () => { setSidebar(sidebar.classList.contains('is-closed')); workView.focus(); };
sidebarToggle.addEventListener('click', toggleSidebar);
sidebarToggleSide.addEventListener('click', toggleSidebar);
// The light-dismiss for the narrow-window overlay. The scrim is the only part
// of the sidebar a click can miss, so it is the only place that needs wiring.
document.getElementById('sidebar-scrim').addEventListener('click', () => setSidebar(false));
fileFilter.addEventListener('input', renderFileList);
setSidebar((() => { try { return localStorage.getItem('wa-sidebar') === 'open'; } catch { return false; } })(), false);

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
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'history-search';
  search.placeholder = 'Search versions';
  search.setAttribute('aria-label', 'Search versions');
  search.autocomplete = 'off';
  search.spellcheck = false;
  const list = chatEl('div', 'history-list');
  modal.append(search, list);
  let versions = [];
  function renderHistory() {
    const query = search.value.trim().toLowerCase();
    const shown = versions.filter(item => !query
      || (item.label || 'Saved to disk').toLowerCase().includes(query)
      || item.text.toLowerCase().includes(query));
    list.replaceChildren();
    for (const item of shown) {
      const row = chatEl('div', 'history-item');
      const words = item.text.match(/\S+/g)?.length ?? 0;
      row.append(chatEl('div', 'history-when',
        `${new Date(item.at).toLocaleString()} · ${item.label || 'Saved to disk'} · ${words} ${words === 1 ? 'word' : 'words'}`));
      row.append(chatEl('div', 'history-excerpt',
        item.text.trim().replace(/\s+/g, ' ').slice(0, 120) || 'Empty document'));
      if (item.text === current) {
        row.append(chatEl('div', 'history-current', 'Same as the text you have now'));
      } else {
        // Full text fills in on first open: thirty versions must not build
        // thirty <pre> nodes before the writer reads even one excerpt.
        const full = document.createElement('details');
        const preview = chatEl('pre', 'passage-preview', '');
        full.append(chatEl('summary', '', 'Full text'), preview);
        full.addEventListener('toggle', () => {
          if (full.open && !preview.textContent) preview.textContent = item.text;
        }, { once: true });
        const restore = chatEl('button', '', 'Restore');
        restore.addEventListener('click', () => { modal.close(); replaceDraft(item.text, 'Version restored'); });
        row.append(full, restore);
      }
      list.append(row);
    }
    if (!versions.length) list.append(chatEl('p', '', 'No previous versions yet. One is kept before every save, import, and AI replacement.'));
    else if (!shown.length) list.append(chatEl('p', '', 'Nothing matches this search.'));
  }
  search.addEventListener('input', renderHistory);
  try {
    const { snapshots } = await api('/draft/history');
    const local = safeJson(docStorage.getItem('snapshots'), []);
    if (!Array.isArray(local)) throw new Error('Local history is corrupt');
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(documentKey + 'wa-working:') || key.endsWith(':' + tabId)) continue;
      let text = null;
      try { text = localStorage.getItem(key); } catch {}
      if (typeof text === 'string' && text !== current) local.push({ text, at: new Date().toISOString(), label: 'Copy from another tab' });
    }
    versions = [...local, ...snapshots].sort((a, b) => b.at.localeCompare(a.at));
    renderHistory();
    modal.append(chatEl('small', 'history-note',
      'Last 20 disk versions and 10 browser checkpoints. Disk copies sit beside the draft in .litura-history and are never deleted automatically.'));
  } catch (error) { list.append(chatEl('p', 'history-note', error.message)); }
});

// ─── Initial focus ─────────────────────────────────────────────────────────────

workView.scrollDOM.addEventListener('scroll', () => { layoutRail(); hideNotePlus(); reanchorBubble(); }, { passive: true });
workView.focus();
syncStyleScore();
