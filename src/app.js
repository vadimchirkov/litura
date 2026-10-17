import { SUGGEST_DELAY, SUGGEST_MIN, paragraphEnd, slashCommand, ghostRemainder, distinctVariants } from '../extension/writing-rules.js';
// src/app.js — Stilura frontend (CodeMirror 6)

import {
  EditorView,
  keymap,
  drawSelection,
  Decoration,
  WidgetType,
  showTooltip,
} from '@codemirror/view';
import {
  EditorState,
  Transaction,
  StateField,
  RangeSet,
  StateEffect,
  Compartment,
  Prec,
} from '@codemirror/state';
import {
  defaultKeymap,
  history,
  historyKeymap,
  isolateHistory,
} from '@codemirror/commands';
import { renderMarkdown } from '../markdown.js';
import { clampBubble, replacementTarget, newerVersion, resolveDrift, unwrapProse, wordDiff } from '../editing.js';
import { paragraphRanges, resolveNoteRange, mapNoteAnchors } from '../notes.js';
import { reversible } from '../work.js';
import { EDITS_OPEN, chatVisibleText, locateChatEdits, mapChatEdit, chatEditMatches } from '../chat-edits.js';
import { loadSpellDictionary, noteSpellingAdded, spellingMarkers } from '../spellcheck.js';
import { searchKeymap } from '@codemirror/search';
import { hydrateIcons, icon } from './icons.js';
import { openStorage } from './storage.js';
import { liveDocument } from './live.js';
import { BRIEF_STEPS, validateBriefQuestions, validateBriefUpdate } from '../brief.js';

async function main() {
let liveSync = null;
const desktop = new URLSearchParams(location.search).get('shell') === 'desktop';
const localStorage = await openStorage({
  desktop,
  onError: error => window.dispatchEvent(new CustomEvent('stilura-storage-error', { detail: error.message })),
});

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
const chatStream    = document.getElementById('chat-stream');
const chatInput     = document.getElementById('chat-input');
const chatSendButton = document.getElementById('chat-send');
const chatClear     = document.getElementById('chat-clear');
const chatPill      = document.getElementById('chat-pill');
const chatPillLabel = document.getElementById('chat-pill-label');
if (!/Mac|iPhone|iPad/.test(navigator.platform)) chatPill.querySelector('kbd').textContent = 'Ctrl K';
const editFeedback = document.getElementById('edit-feedback');
const noticeLive = document.getElementById('notice-live');
const chatPanel     = document.getElementById('chat');
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
  const root = document.documentElement;
  // Every color transition would otherwise fire at once on its own clock and
  // smear the swap: freeze them, flush the new values, then let them back.
  root.classList.add('no-transition');
  currentTheme = theme;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  themeToggleEl.checked = theme === 'dark';
  if (persist) localStorage.setItem('wa-theme', theme);
  void root.offsetHeight;
  requestAnimationFrame(() => root.classList.remove('no-transition'));
}
setTheme(currentTheme, false);
themeToggleEl.addEventListener('change', () => {
  themeToggleEl.classList.add('is-init'); // transitions-dev toggle: arm the bounce after mount
  setTheme(themeToggleEl.checked ? 'dark' : 'light');
});

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
let savePromise = null;
let switchingDocument = false;
let desktopSaving = false;
let savePaused = true;
// A disk conflict pauses disk writes only: the draft, the suggestions and
// the assistant keep working on the local copy. savePaused above is the
// heavier brake — save errors and loading — which still gates everything.
let diskHold = false;
// Deleting the open file holds autosave only: recreating it 800 ms later
// would undo the delete behind the writer's back. An explicit save still
// goes through and brings the file back; Undo restores it at once.
let autosaveHold = false;
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
  if (tone === 'error') sticky = true;
  if (!text) {
    clearTimeout(noticeTimer);
    editFeedback.hidden = true;
    noticeLive.textContent = '';
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
  noticeLive.textContent = text;
  chatPanel.classList.add('has-notice');
  noticeKey = key;
  noticeSticky = sticky;
  // Only plain news times out. An Undo or an error stays until dismissed: a
  // timer would take the recovery away before a keyboard user reaches it.
  if (!sticky && !action && tone !== 'error') noticeTimer = setTimeout(() => notify(''), NOTICE_MS);
}
// A notice under the pointer is being read or about to be pressed: it must
// not fade out from under the hand. Leaving restarts the full count.
editFeedback.addEventListener('mouseenter', () => clearTimeout(noticeTimer));
editFeedback.addEventListener('mouseleave', () => {
  if (noticeSticky || editFeedback.hidden || editFeedback.querySelector('.edit-feedback-undo') || editFeedback.dataset.tone === 'error') return;
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
function setSuggestStatus(text, detail) {
  suggestWorking = text.endsWith('…') ? text : '';
  syncPill();
  if (text && !suggestWorking) notify(text, { detail });
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
  413: 'The draft is too long for this model. Pick a model with a longer context, or select a shorter passage.',
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
    return { say: 'Stilura stopped answering.', act: 'retry', detail };
  }
  const status = Number(/^(?:HTTP |Server error )?([45]\d\d)\b/.exec(detail)?.[1]);
  // Providers say how long to wait ("try again in 14.16s"); that number is the
  // one useful thing in a rate-limit payload.
  const waitMatch = status === 429 ? /try again in (\d+(?:\.\d+)?)\s*(ms|s|m)\b/i.exec(detail) : null;
  const wait = waitMatch ? Math.max(1, Math.ceil(Number(waitMatch[1]) * { ms: .001, s: 1, m: 60 }[waitMatch[2].toLowerCase()])) : 0;
  const unusable = /^Expected TEXT:|^Continuation must be|^Word continuation/.test(detail);
  return {
    say: wait ? `The model is rate-limited. Try again in ${wait} s.`
      : unusable ? 'The model\'s answer was unusable.'
      : MODEL_ERRORS[status] ?? 'The model could not answer.',
    // Retrying a rejected key, a missing model or an oversized draft only
    // fails again; each is fixed in settings (the draft by a larger model).
    act: [401, 402, 403, 404, 413].includes(status) ? 'settings' : 'retry',
    // Where the fix is: a rejected or unfunded key is under access, a model
    // the key cannot use or that does not exist is picked under models.
    tab: status === 401 || status === 402 ? 'access' : 'models',
    detail,
  };
}

// The message is the cause; the button is the answer to it. Every failure the
// writer can act on takes this shape — a bare retry pill with no sentence
// beside it is a button for a problem that was never named.
// A retry that rejects puts the way out back.
function notifyProblem(problem, retry = null, label = 'Try again', key = '') {
  const act = problem.act === 'settings' ? { action: () => openSettings(problem.tab), label: 'Open settings' }
    : problem.act === 'retry' && retry
      ? { action: () => Promise.resolve().then(retry).catch(() => notifyProblem(problem, retry, label, key)), label }
      : {};
  notify(problem.say, { ...act, sticky: true, detail: problem.detail, key, icon: 'alert', tone: 'error' });
}
// A failed suggestion is about the model, not the text: report it even when
// the writer has typed on since. Background retries fire at every pause, so a
// passing failure is shown once per half minute; one only settings can fix
// stays until it is dealt with.
let lastSuggestFailure = 0;
function reportSuggestFailure(problem, manual) {
  if (!manual && problem.act !== 'settings' && Date.now() - lastSuggestFailure < 30_000) return;
  lastSuggestFailure = Date.now();
  const say = `Suggestions: ${problem.say}`;
  if (problem.act === 'settings') notifyProblem({ ...problem, say }, null, 'Try again', 'suggest-error');
  else notify(say, { detail: problem.detail, key: 'suggest-error', icon: 'alert', tone: 'error' });
}
let tabId;
try {
  if (!sessionStorage.getItem('stilura-tab') && sessionStorage.getItem('litura-tab')) sessionStorage.setItem('stilura-tab', sessionStorage.getItem('litura-tab'));
  tabId = sessionStorage.getItem('stilura-tab') || crypto.randomUUID();
  sessionStorage.setItem('stilura-tab', tabId);
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
}

// ─── Stored state across versions ──────────────────────────────────────────
// Bumped only when stored chat turns change shape. The
// draft (`wa-working`, mirrored to draft.md) is never cleared here: it is the
// only state the writer cannot regenerate.
const STORAGE_SCHEMA = '1';
if (localStorage.getItem('wa-schema') !== STORAGE_SCHEMA) {
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
  cancelSuggestion();
  ghostClear(workView);
  localStorage.setItem('wa-agent', JSON.stringify(agentSelection));
}

// Continuations share the editor's model; the server minimizes reasoning.
function activeSuggestAgent() { return currentAgent(); }

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

function renderCredentials() {
  setOptions(keyProviderEl, agentInfo.authProviders.map(provider => ({ value: provider.id, label: provider.name })), keyProviderEl.value || 'openai');
  apiKeyEl.placeholder = agentInfo.authProviders.find(provider => provider.id === keyProviderEl.value)?.label ?? 'API key';
  configuredKeys.replaceChildren(...agentInfo.authProviders.filter(provider => provider.configured).map(provider => {
    const chip = document.createElement('div');
    chip.className = 'key-chip';
    const dot = document.createElement('i');
    const name = document.createElement('span');
    name.textContent = provider.source === 'environment' ? `${provider.name} · environment` : provider.name;
    chip.append(dot, name);
    if (provider.source !== 'environment') {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.title = remove.ariaLabel = `Remove ${provider.name} key`;
      // A removed key cannot be brought back from here: the first press only
      // arms the button, the second removes. Blur or Escape disarms it.
      const disarm = () => {
        remove.classList.remove('is-armed');
        remove.textContent = '×';
        remove.ariaLabel = `Remove ${provider.name} key`;
      };
      remove.addEventListener('click', () => {
        if (remove.classList.contains('is-armed')) return removeProviderKey(provider.id);
        remove.classList.add('is-armed');
        remove.textContent = 'Remove key';
        remove.ariaLabel = `Confirm: remove ${provider.name} key`;
      });
      remove.addEventListener('blur', disarm);
      remove.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !remove.classList.contains('is-armed')) return;
        event.preventDefault();
        event.stopPropagation();
        disarm();
      });
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
  return agentInfo;
}

const settingsTabs = [...settingsDialog.querySelectorAll('.settings-tabs [role="tab"]')];
function showSettingsTab(name, focus = false) {
  settingsDialog.dataset.tab = name;
  for (const tab of settingsTabs) {
    const on = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    if (on && focus) tab.focus();
  }
  document.getElementById('settings-panel').setAttribute('aria-labelledby', `tab-${name}`);
  document.getElementById('settings-panel').scrollTop = 0;
}
for (const tab of settingsTabs) {
  tab.addEventListener('click', () => showSettingsTab(tab.dataset.tab));
  tab.addEventListener('keydown', event => {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? settingsTabs.length - 1
      : step ? (settingsTabs.indexOf(tab) + step + settingsTabs.length) % settingsTabs.length : -1;
    if (index < 0) return;
    event.preventDefault();
    showSettingsTab(settingsTabs[index].dataset.tab, true);
  });
}
showSettingsTab(settingsDialog.dataset.tab);

// `tab` picks the tab to land on; a click passes its event, which is ignored
// and leaves the tab the writer was last on.
async function openSettings(tab) {
  if (typeof tab === 'string') showSettingsTab(tab);
  settingsError.textContent = '';
  try { await refreshAgent(); } catch (error) { settingsError.textContent = error.message; }
  await refreshOAuth();
  draftSelection = currentAgent();
  renderModelSettings();
  renderCredentials();
  renderSubscriptions();
  if (!settingsDialog.open) settingsDialog.showModal();
  else pollOAuth();
}

settingsOpen.addEventListener('click', openSettings);
// transitions-dev modal close (06-modal.md): play .is-closing (150ms) before
// .close() so exit mirrors enter; Escape stays instant (native), class is
// cleaned on 'close'. Timing reads --modal-close-dur to stay in sync with CSS.
function closeSettingsAnimated() {
  if (!settingsDialog.open || settingsDialog.classList.contains('is-closing')) return;
  const closeMs = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--modal-close-dur')
  ) || 150;
  settingsDialog.classList.add('is-closing');
  setTimeout(() => settingsDialog.close(), closeMs);
}
settingsDialog.addEventListener('close', () => {
  settingsDialog.classList.remove('is-closing');
  // A picker left open would outlive the dialog: invisible, still holding
  // keystrokes, and flashing back in on the next open.
  for (const popover of settingsDialog.querySelectorAll(':popover-open')) popover.hidePopover();
});
settingsDialog.querySelector('.dialog-close').addEventListener('click', closeSettingsAnimated);

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
apiKeyEl.addEventListener('input', () => {
  apiKeyEl.removeAttribute('aria-invalid');
  // transitions-dev error shake: typing clears the error at once.
  if (apiKeyEl._revertTimer) { clearTimeout(apiKeyEl._revertTimer); apiKeyEl._revertTimer = null; }
  apiKeyEl.classList.remove('is-error');
});
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

// Add stays enabled and validates on press: a disabled button cannot be
// focused and never says why it does nothing. It is disabled only while the
// request runs, so a double press cannot add the key twice.
async function addProviderKey() {
  if (!apiKeyEl.value.trim()) {
    settingsError.textContent = 'Enter an API key first.';
    apiKeyEl.setAttribute('aria-invalid', 'true');
    showKeyError();
    apiKeyEl.focus();
    return;
  }
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
  } catch (error) {
    settingsError.textContent = error.message;
    apiKeyEl.setAttribute('aria-invalid', 'true');
    showKeyError();
  }
  finally { keyAddEl.disabled = false; }
}
keyAddEl.addEventListener('click', addProviderKey);

// transitions-dev error state shake (12-error-state-shake.md): replay the
// shake from a clean baseline, hold the border long enough to read the
// message, then fade back to neutral. Timer tracks the latest call.
function showKeyError() {
  const cs = getComputedStyle(document.documentElement);
  const ms = (name, fb) => {
    const v = parseFloat(cs.getPropertyValue(name));
    return Number.isFinite(v) ? v : fb;
  };
  apiKeyEl.classList.add('is-error');
  apiKeyEl.classList.remove('is-shaking');
  void apiKeyEl.offsetWidth; // flush the rest state so the shake replays
  apiKeyEl.classList.add('is-shaking');
  const shakeMs = ms('--shake-dur-a', 80) * 2 + ms('--shake-dur-b', 60) * 2;
  setTimeout(() => apiKeyEl.classList.remove('is-shaking'), shakeMs + 20);
  if (apiKeyEl._revertTimer) clearTimeout(apiKeyEl._revertTimer);
  apiKeyEl._revertTimer = setTimeout(() => {
    apiKeyEl._revertTimer = null;
    apiKeyEl.classList.remove('is-error');
  }, shakeMs + ms('--revert-hold', 3000));
}

async function removeProviderKey(provider) {
  settingsError.textContent = '';
  try {
    agentInfo = await api('/api/agent/credentials', { method: 'DELETE', body: JSON.stringify({ provider }) });
    renderModelSettings();
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
    if (!provider.configured) dot.className = 'is-off';
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
          renderCredentials();
      // The chip reads oauthInfo.supported: re-read it, or the just-signed-in
      // subscription keeps showing "not connected / Sign in" until reopen.
      await refreshOAuth();
    }
  } catch { oauthTimer = setTimeout(pollOAuth, 5000); }
}

async function startOAuthFlow(provider, method) {
  settingsError.textContent = '';
  // Popup blockers only honour windows opened inside the click itself, and
  // the auth URL arrives after a round-trip — so park a blank tab now and
  // navigate it once the URL lands. If it never lands, the link in the flow
  // box below takes over as the manual fallback.
  const authTab = method === 'browser' ? window.open('about:blank', '_blank') : null;
  try {
    oauthInfo = await api('/api/agent/oauth/start', {
      method: 'POST',
      body: JSON.stringify({ provider, method }),
    });
    oauthCodeEl.value = '';
    renderSubscriptions();
    pollOAuth();
    const url = oauthInfo.active?.url;
    if (authTab) {
      if (url) authTab.location.href = url;
      else authTab.close();
    }
  } catch (error) {
    try { authTab?.close(); } catch {}
    settingsError.textContent = error.message;
  }
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

refreshAgent().catch(error => notifyProblem({ say: 'Could not load models.', act: 'retry', detail: error.message }, refreshAgent));

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
    const span = document.createElement('span');
    span.className   = 'cm-suggest';
    span.textContent = this.text;
    return span;
  }

  ignoreEvent() { return true; }
}

const setGhostFx   = StateEffect.define();
const clearGhostFx = StateEffect.define();

// Ghost state field — also provides decorations
const ghostField = StateField.define({
  create: () => null,

  update(val, tr) {
    // Typing the ghost's own next characters keeps the rest on screen, so
    // no new request is needed until the writer leaves the suggestion.
    if (val && tr.docChanged && tr.isUserEvent('input.type')) {
      let typed = null;
      tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        typed = typed === null && fromA === val.pos && toA === val.pos ? inserted.toString() : false;
      });
      const pos = val.pos + (typed ? typed.length : 0);
      const head = tr.newSelection.main;
      if (typed && val.text.startsWith(typed) && head.empty && head.head === pos) {
        const remaining = ghostRemainder(val.text, typed);
        return remaining ? { text: remaining, pos } : null;
      }
      return null;
    }
    if (tr.docChanged) return null;  // typing → clear
    if (tr.selection)  return null;  // cursor moved → clear
    for (const e of tr.effects) {
      if (e.is(setGhostFx))   return e.value;   // { text, pos }
      if (e.is(clearGhostFx)) return null;
    }
    return val;
  },

  // Inline after the caret, as faded text. Suggestions only fire at a
  // paragraph end, so nothing of the writer's is pushed aside.
  provide: f => EditorView.decorations.from(f, ghost => {
    if (!ghost) return Decoration.none;
    const w = Decoration.widget({ widget: new GhostWidget(ghost.text), side: 1 });
    return Decoration.set([w.range(ghost.pos)]);
  }),
});

function ghostShow(view, text) {
  const pos = view.state.selection.main.head;
  view.dispatch({
    // The margin keeps the continuation clear of the chat strip.
    effects: [setGhostFx.of({ text, pos }), EditorView.announce.of(`Suggestion: ${text.trim()}. Tab to accept; Escape to dismiss.`), EditorView.scrollIntoView(pos, { y: 'nearest', yMargin: 72 })],
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

// ─── Spelling marks ─────────────────────────────────────────────────────────
//
//  A deterministic, offline check for actual misspellings — distinct from the
//  style tells above, which flag wording choices rather than errors. Fixes
//  are instant word swaps and need no model call.
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
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !markBubble.hidden) { hideMarkBubble(); workView.focus(); return; }
  if (event.key === 'Escape' && plainPreview) { clearPlainPreview(); workView.focus(); return; }
  // Last, so the lighter dismissals above still win. On a narrow window the
  // sidebar is a layer over the text, and Escape is how a layer goes away.
  // The composer claims Escape for itself only while it holds a request, and claims it by stopping the event on the way out — so
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
// ─── Update check ──────────────────────────────────────────────────────────
// Off unless the writer turns it on. Every other request Stilura sends is one
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
    updateBadge.title = 'Copy npx stilura to update';
  }
  updateStatus.textContent =
    error  ? `Running ${current} — npm could not be reached.` :
    stale  ? `Running ${current}; npm publishes ${latest}.` :
    latest ? `Running ${current} — the published version.` :
             `Running ${current}.`;
}

updateBadge.addEventListener('click', async () => {
  if (updateBadge.hidden) return;
  const command = 'npx stilura';
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

// ─── Suggestion system ─────────────────────────────────────────────────────────

let suggestTimer = null;
let suggestWorking = '';   // "Suggesting…" while a request is out
let suggestAbort = null;
let suggestVersion = 0;
// A rate-limited provider answers every further keystroke with the same 429
// and burns the quota it is waiting on. Automatic requests rest for a minute.
let suggestPausedUntil = 0;

// Suggest only where the writer is actually writing forward: caret collapsed
// at the end of a line with nothing but blank space after it. Editing mid-text
// is what produced the off-topic continuations — the model never saw the tail.
function atParagraphEnd(state) {
  const sel = state.selection.main;
  if (!sel.empty) return false;
  return paragraphEnd(state.doc.toString(), sel.head);
}

function cancelSuggestion() {
  suggestVersion++;
  clearTimeout(suggestTimer);
  suggestTimer = null;
  suggestAbort?.abort();
  suggestAbort = null;
  if (suggestWorking) setSuggestStatus('');
}

function suggestSchedule() {
  cancelSuggestion();
  if (loadingDocument || savePaused || !workView.hasFocus || document.hidden) return;
  if (Date.now() < suggestPausedUntil) return;
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
  if (update.docChanged && update.transactions.some(tr => tr.isUserEvent('input.type')) && !update.state.field(ghostField)) suggestSchedule();
}

async function suggestFetch(manual = false) {
  suggestTimer = null;
  const view  = workView;
  const state = view.state;
  // The focus guard keeps background suggestions from firing while the writer
  // is elsewhere. An explicit ask is not background: the press itself may be
  // what took focus out of the editor (a bubble button, the settings dialog).
  if (generationJob || state.readOnly || loadingDocument || savePaused || (!manual && !view.hasFocus) || document.hidden || view.composing) return;
  if (!atParagraphEnd(state)) {
    if (manual) setSuggestStatus('Place the caret at the end of a paragraph to request a continuation.');
    return;
  }

  const doc = state.doc.toString();
  const pos = state.selection.main.head;
  if (slashRequest(state)) return;
  if (!doc.trim() || (!manual && doc.trim().length < SUGGEST_MIN)) {
    if (manual) setSuggestStatus('Write a few words before requesting a continuation.');
    return;
  }

  const version = suggestVersion;
  if (manual && !await ensureAgent()) return;
  const suggestAgent = activeSuggestAgent() ?? currentAgent();
  if (version !== suggestVersion || (!manual && !view.hasFocus) || !suggestAgent) return;
  const agent = suggestAgent;
  const brief = briefContext();

  const job = startJob({ background: !manual });
  suggestAbort = job;
  const isCurrent = () => suggestAbort === job && !job.signal.aborted && version === suggestVersion
    && !loadingDocument && !savePaused && !document.hidden && (manual || view.hasFocus) && !view.composing
    && !view.state.readOnly
    && view.state.doc === state.doc && view.state.selection.eq(state.selection)
    && JSON.stringify(activeSuggestAgent() ?? currentAgent()) === JSON.stringify(agent)
    && briefContext() === brief;
  if (manual) setSuggestStatus('Suggesting…');

  try {
    const res = await fetch('/suggest', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        document: doc,
        cursor:   pos,
        agent,
        manual,
        brief: brief || undefined,
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
      if (/\b429\b|rate.?limit|quota/i.test(errorMsg)) suggestPausedUntil = Date.now() + 60_000;
      const problem = modelError(new Error(errorMsg));
      if (suggestAbort === job && !job.signal.aborted) { setSuggestStatus(''); reportSuggestFailure(problem, manual); }
      return;
    }

    const data = await res.json();

    // Only show if nothing changed while we were waiting
    if (!isCurrent()) return;
    setSuggestStatus('');
    if (data.suggestion) ghostShow(view, data.suggestion);
    else if (manual) setSuggestStatus('No continuation to suggest.');
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
    if (suggestAbort === job && !job.signal.aborted) { setSuggestStatus(''); reportSuggestFailure(problem, manual); }
  } finally {
    finishJob(job);
    if (suggestAbort === job) suggestAbort = null;
  }
}

// ─── Generate in the draft ────────────────────────────────────────────────────

let generationJob = null;
const setGenerationFx = StateEffect.define();
class GenerationWidget extends WidgetType {
  constructor(value) { super(); this.value = value; }
  eq(other) { return this.value.job === other.value.job && this.value.text === other.value.text && this.value.phase === other.value.phase && this.value.inline === other.value.inline && this.value.previousText === other.value.previousText; }
  toDOM() {
    const wrap = document.createElement(this.value.inline ? 'span' : 'div');
    wrap.className = 'cm-generation';
    wrap.setAttribute('aria-busy', String(this.value.phase === 'streaming'));
    if (this.value.phase === 'streaming' && (!this.value.text || this.value.previousText != null)) {
      const loader = document.createElement('span');
      loader.className = 'generation-loading';
      loader.setAttribute('role', 'status');
      const grid = document.createElement('span');
      grid.className = 'generation-pixels';
      grid.setAttribute('aria-hidden', 'true');
      for (let i = 0; i < 9; i++) {
        const cell = document.createElement('span');
        cell.style.setProperty('--cell-delay', String((i % 3 + Math.abs(Math.floor(i / 3) - 1)) * 90));
        grid.append(cell);
      }
      const label = document.createElement('span');
      label.className = 'generation-loading-label';
      label.textContent = this.value.previousText != null ? 'Rewriting' : 'Writing';
      const elapsed = document.createElement('span');
      elapsed.className = 'generation-elapsed';
      elapsed.setAttribute('aria-hidden', 'true');
      const startedAt = this.value.startedAt ?? Date.now();
      const tick = () => {
        const seconds = Math.max(0, Date.now() - startedAt) / 1000;
        elapsed.textContent = seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(1)}s`;
      };
      tick();
      this.timer = setInterval(tick, 100);
      loader.append(grid, label, elapsed);
      wrap.append(loader);
    }
    if (this.value.text) {
      const text = document.createElement(this.value.inline ? 'span' : 'div');
      text.className = 'cm-suggest';
      // Keep the final empty line measurable while a stream ends with a newline.
      text.textContent = this.value.text + (this.value.text.endsWith('\n') ? '\u200b' : '');
      wrap.append(text);
    }
    return wrap;
  }
  destroy() { clearInterval(this.timer); }
  coordsAt(dom) {
    const text = dom.querySelector('.cm-suggest')?.firstChild;
    if (!text || this.value.previousText != null) {
      const rect = dom.getBoundingClientRect();
      return { left: rect.left, right: rect.left, top: rect.top, bottom: rect.top };
    }
    // A replacement's box spans the whole preview; the caret belongs to its final text line.
    const range = document.createRange();
    range.setStart(text, text.length);
    range.collapse(true);
    return range.getBoundingClientRect();
  }
  get lineBreaks() { return this.value.inline ? (this.value.text.match(/\n/g) ?? []).length : 0; }
  ignoreEvent() { return false; }
}
const generationField = StateField.define({
  create: () => null,
  update(value, tr) {
    if (value && tr.docChanged) {
      let touched = false;
      tr.changes.iterChangedRanges((from, to) => {
        if (from === to ? from >= value.from && from <= value.to : from < value.to && to > value.from) touched = true;
      });
      value = touched ? null : { ...value, from: tr.changes.mapPos(value.from, 1), to: tr.changes.mapPos(value.to, -1) };
      if (value && tr.newDoc.sliceString(value.from, value.to) !== value.quote) value = null;
      if (value) value.inline = value.source === 'passage' || value.from > tr.newDoc.lineAt(value.from).from;
    }
    for (const effect of tr.effects) if (effect.is(setGenerationFx)) value = effect.value;
    return value;
  },
});

function slashRequest(state) {
  const line = state.doc.lineAt(state.selection.main.head);
  return slashCommand(line.text, line.from);
}

const hiddenSlash = Decoration.replace({});

// The slash only opens the request; it stays in the text (Backspace removes
// it and ends the request) but is not drawn. The background is the cue.
function requestDecorations(state) {
  if (state.field(generationField, false)) return Decoration.none;
  const request = slashRequest(state);
  if (!request) return Decoration.none;
  const decorations = [hiddenSlash.range(request.from, request.from + 1)];
  if (request.to > request.from + 1) decorations.push(Decoration.mark({ class: 'cm-generation-request' }).range(request.from + 1, request.to));
  else if (!request.inline) decorations.push(Decoration.line({ class: 'cm-generation-request' }).range(state.doc.lineAt(request.from).from));
  return Decoration.set(decorations, true);
}
const requestField = StateField.define({
  create: requestDecorations,
  update: (value, tr) => tr.docChanged || tr.selection || tr.effects.some(effect => effect.is(setGenerationFx)) ? requestDecorations(tr.state) : value,
});

function generationKey(view, action) {
  const target = view.state.field(generationField);
  const selection = view.state.selection.main;
  if (!target || !selection.empty || view.composing || selection.head < target.from || selection.head > target.to) return false;
  if (action === 'Regenerate' && target.phase === 'streaming' && target.previousText != null) return true;
  if (target.phase !== 'review') return false;
  if (action === 'Next' || action === 'Previous') {
    if (!target.variants || target.variants.length < 2) return false;
    const index = (target.index + (action === 'Next' ? 1 : target.variants.length - 1)) % target.variants.length;
    view.dispatch({ effects: [setGenerationFx.of({ ...target, index, text: target.variants[index] }),
      EditorView.announce.of(`Option ${index + 1} of ${target.variants.length}: ${target.variants[index]}`)] });
    return true;
  }
  void reviewGeneration(view, action, target.job);
  return true;
}

function handleWrite(view) {
  const selection = view.state.selection.main;
  if (!selection.empty || view.state.readOnly || view.composing) return false;
  const request = slashRequest(view.state);
  if (!request || selection.head !== request.to) return false;
  if (!request.instruction) { notify('Write a request after /, then press Enter.'); return true; }
  if (loadingDocument || savePaused) { notify('Wait until the draft can be saved.'); return true; }
  if (view.state.field(generationField)?.phase === 'review') { notify('Review the generated suggestion first: Tab accepts, Escape dismisses, R regenerates.'); return true; }
  if ([...jobs].some(job => !job.background)) { notify('Wait for the current request or stop it first.'); return true; }
  void generateFromLine(view, request, request.instruction);
  return true;
}

function reviewGeneration(view, action, job) {
  const target = view.state.field(generationField);
  if (!target || target.job !== job || target.phase !== 'review' || target.key !== documentKey) return;
  if (action === 'Reject') {
    if (target.source === 'passage') { closePassage(view); return; }
    view.dispatch({ effects: [setGenerationFx.of(null), EditorView.announce.of('Suggestion rejected. Your request is unchanged.')] });
    return;
  }
  if (loadingDocument || savePaused || view.state.readOnly) { notify('Wait until the draft can be saved.'); return; }
  if (view.state.doc.sliceString(target.from, target.to) !== target.quote) return;
  if (action === 'Regenerate') {
    if ([...jobs].some(job => !job.background)) { notify('Wait for the current request or stop it first.'); return; }
    if (target.source === 'passage') return requestPassage(view, target.text);
    return generateFromLine(view, { from: target.from, to: target.to, text: target.quote }, target.instruction);
  }
  if (action !== 'Accept') return;
  saveSnapshot('Before generated text');
  view.dispatch({ changes: { from: target.from, to: target.to, insert: target.text },
    effects: [setGenerationFx.of(null), ...(target.source === 'passage' ? [setPassageFx.of(null)] : []), EditorView.announce.of('Text accepted. Undo restores the original passage.')],
    annotations: isolateHistory.of('full'), userEvent: 'input.generate' });
}

async function generateFromLine(view, line, instruction) {
  const document = view.state.doc.toString(), key = documentKey;
  const inline = line.from > view.state.doc.lineAt(line.from).from;
  const previous = view.state.field(generationField);
  const previousText = previous?.phase === 'review' ? previous.text : null;
  const job = startJob();
  generationJob = job;
  cancelSuggestion();
  view.dispatch({ effects: [clearGhostFx.of(null), setGenerationFx.of({ from: line.from, to: line.to, quote: line.text, text: previousText ?? '', previousText, instruction, key, inline, phase: 'streaming', job, startedAt: Date.now() }),
    EditorView.announce.of('Generating text. Escape stops generation.')] });
  // The preview stays outside the saved draft until the author accepts it.
  const current = () => !job.signal.aborted && documentKey === key && !loadingDocument && !savePaused
    && !view.state.readOnly && view.state.field(generationField)?.job === job;
  const clear = () => {
    const target = view.state.field(generationField);
    if (target?.job !== job || target.phase !== 'streaming') return;
    const restored = previousText !== null && documentKey === key && !loadingDocument
      ? { ...target, text: previousText, previousText: null, phase: 'review' } : null;
    view.dispatch({ effects: [setGenerationFx.of(restored), EditorView.announce.of(restored
      ? 'Previous suggestion restored. Tab accepts, Escape dismisses, R regenerates.'
      : 'Generation stopped. Your request is unchanged.')] });
  };
  job.signal.addEventListener('abort', clear, { once: true });
  try {
    if (!await ensureAgent() || !current()) return;
    const res = await fetch('/write', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: job.signal,
      body: JSON.stringify({ document, from: line.from, cursor: line.to, instruction, previous: previousText ?? undefined, agent: currentAgent(), context: combinedContext() || undefined }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    let answer = '';
    for await (const chunk of sseChunks(res)) {
      if (!current()) { job.abort(); return; }
      if (chunk.error) throw new Error(chunk.error);
      answer = typeof chunk.replace === 'string' ? chunk.replace : answer + (chunk.text ?? '');
      view.dispatch({ effects: setGenerationFx.of({ ...view.state.field(generationField), text: answer, previousText: null }) });
    }
    if (!current()) return;
    if (!answer.trim()) throw new Error('The model returned no text.');
    view.dispatch({ effects: [setGenerationFx.of({ ...view.state.field(generationField), text: answer.trim(), previousText: null, phase: 'review' }),
      EditorView.announce.of('Suggestion ready. Tab accepts, Escape dismisses, R regenerates.')] });
  } catch (error) {
    if (!job.signal.aborted) {
      const problem = modelError(error);
      notifyProblem({ ...problem, say: `${/^The model repeated/.test(error.message) ? error.message : problem.say} ${previousText === null ? 'Your request is unchanged; press Enter to retry.' : 'The previous suggestion is kept.'}` }, null, 'Try again', 'write-error');
    }
  } finally {
    job.signal.removeEventListener('abort', clear);
    clear();
    if (generationJob === job) generationJob = null;
    finishJob(job);
  }
}

// ─── Read-only compartment (blocks input while loading) ────────────────

const readonlyComp = new Compartment();

function editorSetReadonly(view, on) {
  view.dispatch({ effects: readonlyComp.reconfigure(EditorState.readOnly.of(on)) });
  view.dom.classList.toggle('streaming', on);
}

// ─── Local passage actions ────────────────────────────────────────────────────

let passageJob = null;
const setPassageFx = StateEffect.define();
const passageField = StateField.define({
  create: () => null,
  update(value, tr) {
    if (tr.state.readOnly) return null;
    if (value && tr.docChanged) {
      value = { ...value, state: 'pending' };
      mapChatEdit(value, tr.changes);
      if (value.state === 'stale' || tr.newDoc.sliceString(value.from, value.to) !== value.quote) value = null;
    }
    for (const effect of tr.effects) if (effect.is(setPassageFx)) value = effect.value;
    return value;
  },
  provide: field => [
    showTooltip.computeN([field, generationField], state => {
      const value = state.field(field);
      return value && !value.busy && state.field(generationField)?.source !== 'passage' ? [{ pos: value.from, end: value.to, above: false, create: passageTooltip }] : [];
    }),
  ],
});

function openPassage(view, range) {
  if (!range || range.to <= range.from || loadingDocument || view.state.readOnly) return false;
  if (view.state.field(generationField)?.source !== 'passage' && view.state.field(generationField)) {
    notify('Accept or dismiss the current suggestion first.'); return false;
  }
  closePassage(view);
  cancelSuggestion(); ghostClear(view);
  view.dispatch({ effects: setPassageFx.of({ from: range.from, to: range.to,
    quote: view.state.doc.sliceString(range.from, range.to), key: documentKey,
    instruction: '', answer: '', busy: false }), selection: { anchor: range.to } });
  return true;
}

function closePassage(view) {
  passageJob?.abort();
  const effects = [setPassageFx.of(null)];
  if (view.state.field(generationField)?.source === 'passage') effects.push(setGenerationFx.of(null));
  view.dispatch({ effects });
}

function passageTooltip(view) {
  const dom = chatEl('form', 'passage-panel');
  dom.setAttribute('aria-label', 'Selected passage');
  const input = chatEl('textarea', 'passage-input');
  input.rows = 1; input.maxLength = 4000;
  const fit = () => { input.style.height = 'auto'; input.style.height = `${input.scrollHeight}px`; };
  input.setAttribute('aria-label', 'Passage request');
  input.setAttribute('aria-description', 'Enter sends, Shift+Enter adds a line, Escape closes.');
  dom.append(input);
  const render = () => {
    const value = view.state.field(passageField);
    if (!value) return;
    const text = !value.busy && value.answer || value.instruction;
    if (input.value !== text) { input.value = text; fit(); }
    input.readOnly = value.busy;
    input.setAttribute('aria-busy', String(value.busy));
  };
  input.addEventListener('input', () => {
    fit();
    const value = view.state.field(passageField);
    if (value && !value.busy) view.dispatch({ effects: setPassageFx.of({ ...value, instruction: input.value, answer: '' }) });
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void requestPassage(view); }
  });
  dom.addEventListener('submit', event => { event.preventDefault(); void requestPassage(view); });
  dom.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      if (passageJob) passageJob.abort(); else closePassage(view);
      view.focus();
    }
  });
  // A press anywhere else puts the field away. Not blur: a replacement
  // preview hands focus to the editor on purpose, and its own buttons
  // (inside .cm-generation) must still work.
  const outside = event => {
    if (!dom.contains(event.target) && !event.target.closest?.('.cm-generation')) closePassage(view);
  };
  render();
  return {
    dom, update: render,
    mount: () => { document.addEventListener('pointerdown', outside, true); queueMicrotask(() => { fit(); input.focus(); }); },
    destroy: () => document.removeEventListener('pointerdown', outside, true),
  };
}

async function requestPassage(view, previous = null) {
  let target = view.state.field(passageField);
  if (!target || loadingDocument || savePaused || view.state.readOnly || target.key !== documentKey) return;
  if (!target.instruction.trim()) return;
  if ([...jobs].some(job => !job.background)) { notify('Wait for the current request or stop it first.'); return; }
  const job = startJob(); passageJob = job;
  view.dispatch({ effects: setPassageFx.of({ ...target, busy: true, job, answer: '' }) });
  view.focus();
  const current = () => !job.signal.aborted && !loadingDocument && !savePaused && !view.state.readOnly
    && view.state.field(passageField)?.job === job && documentKey === target.key;
  try {
    if (!await ensureAgent() || !current()) return;
    target = view.state.field(passageField);
    let instruction = target.instruction;
    if (previous) instruction += `\nReplace the previous candidate with different wording, preserving the request and facts. Previous candidate:\n${previous}`;
    const response = await fetch('/ask', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: job.signal,
      body: JSON.stringify({ document: view.state.doc.toString(), selected: target.quote, from: target.from,
        instruction, agent: currentAgent(), context: combinedContext() || undefined }),
    });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
    if (!current()) return;
    const live = view.state.field(passageField);
    if (!data.variants?.length) {
      if (typeof data.answer !== 'string' || !data.answer.trim()) throw new Error('The model returned no answer.');
      view.dispatch({ effects: setPassageFx.of({ ...live, answer: data.answer }) });
      return;
    }
    const variants = distinctVariants(data.variants, target.quote, previous);
    if (view.state.doc.sliceString(live.from, live.to) !== live.quote) { notify('The passage changed while the model was working.'); return; }
    // A suggestion in place of the passage: Tab accepts, R regenerates, Escape dismisses.
    view.dispatch({ effects: [setGenerationFx.of({ from: live.from, to: live.to, quote: live.quote,
      text: variants[0], variants, index: 0, source: 'passage', instruction: target.instruction,
      key: target.key, inline: true, phase: 'review', job }),
      setPassageFx.of({ ...live, answer: data.answer || '' }),
      EditorView.announce.of('Suggestion ready. Tab accepts, Escape dismisses, R regenerates.')],
      selection: { anchor: live.to } });
    view.focus();
    notify('Tab accepts · R regenerates · Esc dismisses', { sticky: true, key: 'passage-hint' });
  } catch (error) {
    if (current()) {
      if (previous && view.state.field(generationField)) {
        view.dispatch({ effects: setPassageFx.of({ ...view.state.field(passageField), answer: 'Could not regenerate — the previous suggestion is kept.' }) });
      }
      notifyProblem(modelError(error), () => requestPassage(view, previous), 'Try again', 'passage-error');
    }
  } finally {
    const live = view.state.field(passageField);
    if (live?.job === job) view.dispatch({ effects: setPassageFx.of({ ...live, busy: false }) });
    if (passageJob === job) passageJob = null;
    finishJob(job);
  }
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

// { role, content, display? } — `content` goes to the model, `display` is what
// the writer typed when the two differ.
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
  // The replacement is already written; only its place in the draft is lost
  // (never found, or edited since). The writer points at the passage and it
  // applies there, with the usual Undo — no second request, no typed prompt.
  const retarget = button('Replace selection', () => {
    const sel = workView.state.selection.main;
    if (sel.empty) return;
    Object.assign(edit, { from: sel.from, to: sel.to, quote: workView.state.sliceDoc(sel.from, sel.to), state: 'pending' });
    changeChatEdit(edit);
  });
  retarget.classList.add('is-primary');
  const status = chatEl('p', 'chat-edit-status'); status.setAttribute('role', 'status');
  actions.prepend(status);
  card.append(actions, undoFoot);
  chatEditCards.set(edit, { card, actions, preview, apply, keep, undo, undoFoot, retarget, status });
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
  ui.undo.setAttribute('aria-label', `${edit.state === 'applied' ? 'Undo edit' : 'Undo keeping original'}: ${edit.label}`);
  ui.undoFoot.hidden = !showUndo;
  // Applied is a receipt: tag in the title, Undo in its footer, nothing else.
  ui.card.classList.toggle('is-applied', appliedNow);
  // Lost its place and still undecided: the one way forward is to point at
  // the passage. An applied or kept edit that the writer has since rewritten
  // is history — nothing to offer.
  const lost = !valid && ['pending', 'stale', 'unlocated'].includes(edit.state);
  ui.actions.hidden = appliedNow || (!valid && !lost);
  ui.retarget.hidden = !lost;
  ui.preview.textContent = plainPreview?.edit === edit ? 'End preview' : 'Preview';
  ui.preview.setAttribute('aria-pressed', String(plainPreview?.edit === edit));
  ui.apply.disabled = ui.undo.disabled = workView.state.readOnly || loadingDocument || savePaused;
  syncRetarget(ui);
  // Applied needs no status: the tag in the title says it.
  ui.status.textContent = lost
    ? (edit.state === 'unlocated' ? 'Couldn’t find this passage. Select it in the draft.' : 'The passage changed. Select it in the draft.')
    : edit.state === 'kept' ? 'Original kept' : '';
  ui.status.hidden = !ui.status.textContent;
}
// Replace selection is live only while there is a selection to replace; the
// status line beside it says what to do until then. Cheap enough to run on
// every selection change.
function syncRetarget(ui) {
  ui.retarget.disabled = workView.state.selection.main.empty || workView.state.readOnly || loadingDocument || savePaused;
}
function syncChatEditCards() {
  for (const [edit, ui] of chatEditCards) {
    if (!ui.card.isConnected) { chatEditCards.delete(edit); continue; }
    syncChatEditCard(edit, ui);
  }
}
function changeChatEdit(edit, undo = false, automatic = false) {
  if (workView.state.readOnly || loadingDocument || savePaused || !chatEditMatches(edit, workView.state.doc.toString())
    || edit.state !== (undo ? 'applied' : 'pending')) return;
  clearPlainPreview();
  const text = undo ? edit.quote : edit.replacement;
  changingChatEdit = edit;
  try {
    if (undo || automatic) {
      saveSnapshot(undo ? 'Before undoing chat edit' : 'Before AI replacement');
      workView.dispatch({ changes: { from: edit.from, to: edit.to, insert: text },
        ...(automatic ? {} : { selection: { anchor: edit.from + text.length } }) });
      save();
    } else applyText(text, { from: edit.from, to: edit.to, text: edit.quote, document: workView.state.doc.toString() });
    edit.to = edit.from + text.length;
    edit.state = undo ? 'pending' : 'applied';
  } finally { changingChatEdit = null; }
  saveChat(); syncChatEditCards(); setChatOpen(true);
  if (!automatic) {
    const ui = chatEditCards.get(edit); (undo ? ui?.apply : ui?.undo)?.focus();
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
const RAIL_WIDTH = 220, RAIL_GUTTER = 24;   // .rail width in style.css; the editor padding in the theme below assumes 2 × (RAIL_WIDTH + RAIL_GUTTER)
let railOn = false;
let railPaneLeft = 0;   // rail's left edge in pane coordinates for notePlus

// The rail lives in the margin the centred text column leaves empty, so it is
// available exactly when that margin can hold a note card and a gutter.
// Measured, not guessed at a breakpoint: the text column's padding is the
// margin. Only margin-note cards stand here (see railAdd).
function syncRail() {
  const margin = parseFloat(getComputedStyle(workView.contentDOM).paddingRight) || 0;
  const fits = margin >= RAIL_WIDTH + RAIL_GUTTER;
  if (fits) {
    // Beside the text, not against the window: the note belongs to the line.
    // The rail rides inside the editor's scroller (see the append below), so
    // its own left is in scroller coordinates; railPaneLeft keeps the pane
    // coordinates for the overlays that stayed outside.
    const box = workView.contentDOM.getBoundingClientRect();
    const scroller = workView.scrollDOM.getBoundingClientRect();
    const pane = document.getElementById('pane-work').getBoundingClientRect();
    rail.style.left = `${box.right - margin - scroller.left + RAIL_GUTTER}px`;
    railPaneLeft = box.right - margin - pane.left + RAIL_GUTTER;
  }
  if (fits === railOn) {
    rail.hidden = !fits || rail.children.length === 0;
    return;
  }
  railOn = fits;
  // Crossing the width moves note cards.
  // Moving must never open the chat: streamAppend keeps the panel as it was.
  for (const note of marginNotes) placeNoteCard(note);
  rail.hidden = !fits || rail.children.length === 0;
}

// Without a rail a card belongs in the stream, stacked in DOM order. Moving
// must never open the chat: crossing the breakpoint on resize is not something
// new arriving. Cards created fresh in the stream open it explicitly instead.
function placeHome(node) {
  const home = railHomes.get(node) ?? chatStream;
  if (home === chatStream) streamAppend(node);
  else home.append(node);
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
  const scroller = workView.scrollDOM;
  // The rail spans the whole document and scrolls with it, so card tops are
  // document coordinates: constant across scrolls, recomputed only on edits,
  // resizes and card changes — never per scroll event, where JS repositioning
  // lagged a frame behind composited text on momentum scrolling.
  rail.style.height = `${scroller.scrollHeight}px`;
  const scrollerTop = scroller.getBoundingClientRect().top;
  const scrollTop = scroller.scrollTop;
  const placed = [...rail.children]
    .map(node => {
      const position = railAnchors.get(node)?.();
      const coords = position == null ? null : workView.coordsAtPos(position);
      // −3 to stand exactly where the paragraph "+" stands (see moveNotePlus).
      return { node, at: coords && coords.top - scrollerTop + scrollTop - 3 };
    })
    .filter(item => item.at !== null && item.at !== undefined)
    .sort((a, b) => a.at - b.at);
  for (const node of rail.children) node.style.visibility = 'hidden';
  // The scroller clips offscreen cards; hiding them here would survive a scroll.
  let floor = -Infinity;
  for (const item of placed) {
    const height = item.node.offsetHeight;
    const at = Math.max(item.at, floor);
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
//  composer and the pill step aside for it — either input or
//  notice, never both. Summoning the composer dismisses a passing notice; a
//  sticky problem keeps the input covered until its own action or ×.
//  Closing never discards — turns, cards and Undo stay, like
//  setChatOpen. Collapse is allowed only with nothing to lose (empty field,
//  no chip, no request running), so typing is never interrupted.
function syncPill() {
  if (!chatPillLabel) return;
  const n = chatStream.children.length;
  // Background work speaks through the pill until it ends.
  const working = suggestWorking;
  chatPanel.classList.toggle('is-working', Boolean(working));
  chatPillLabel.textContent = working || (n > 0 ? `Conversation${n > 1 ? ` • ${n}` : ''}` : 'Ask anything');
}

function canCollapseIsland() {
  return !chatInput.value.trim() && ![...jobs].some(job => !job.background);
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
  const instant = next === chatComposer && chatPanel.dataset.openVia === 'key';
  if (next !== chatComposer) delete chatPanel.dataset.openVia;
  if (instant || reduceMotion() || !from?.width || !to.width) return;
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
  const wasShown = !chatStream.hidden && !chatPanel.classList.contains('is-collapsed');
  if (open) openIsland();
  if (open) chatStream.hidden = false;      // measure against a laid-out stream
  if (open && !wasShown) enterStream();
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

// The composer morphs between pill and field (see the island morph), but the
// stream above it is display:none while closed, so on its own the whole
// conversation would appear and vanish in one frame. It rises in with the
// morph and sinks toward the field before it is hidden.
const STREAM_MOTION = 'pseudoElement' in KeyframeEffect.prototype;
function enterStream() {
  if (!chatStream.childElementCount || reduceMotion()) return;
  // Showing a display:none stream replays every turn's own entrance; the
  // stream arrives as one piece instead.
  for (const animation of chatStream.getAnimations({ subtree: true })) animation.finish();
  chatStream.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }],
    { duration: 250, easing: 'cubic-bezier(.32, .72, 0, 1)' });
}
// fold: the whole island goes back to the pill, so the field fades with the
// turns. Otherwise the field stays, and losing the panel's 8px inset would
// drop it in one frame: it slides there instead.
function afterStreamLeaves(close, fold = false) {
  const shown = !chatStream.hidden && chatStream.childElementCount > 0 && !chatPanel.classList.contains('is-collapsed');
  if (!shown || reduceMotion()) return close();
  const timing = { duration: 150, easing: 'ease-out', fill: 'forwards' };
  const leaving = [chatStream.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(8px)' }], timing)];
  if (STREAM_MOTION) leaving.push(chatPanel.animate([{ opacity: 1 }, { opacity: 0 }], { ...timing, pseudoElement: '::before' }));
  if (fold) leaving.push(chatComposer.animate([{ opacity: 1 }, { opacity: 0 }], timing));
  const top = chatComposer.getBoundingClientRect().top;
  leaving[0].finished.then(() => {
    close();
    for (const animation of leaving) animation.cancel();
    const shift = top - chatComposer.getBoundingClientRect().top;
    if (!fold && shift) {
      chatComposer.animate([{ transform: `translateY(${shift}px)` }, { transform: 'none' }],
        { duration: 200, easing: 'cubic-bezier(.32, .72, 0, 1)' });
    }
  }, () => {});
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
//  - live edits map the passage boundaries, including reworded text;
//  - lost anchors stay as points with a "text changed" badge, never
//    highlighting a different copy of the quote or a whole paragraph;
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
    return decorations.map(tr.changes);
  },
});

// Paragraph, offset and length follow editor transactions. A null paragraph
// is a document note; a deleted passage remains a point without a mark.
function noteRange(id) {
  const note = marginNotes.find(item => item.id === id);
  if (!note) return null;
  const range = resolveNoteRange(workView.state.doc.toString(), note);
  return range && { from: range.from, to: range.to };
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
  const paras = paragraphRanges(workView.state.doc.toString());
  if (!paras.length) return null;
  // Stands where it was made: at its passage, or at the line its "+" was
  // pressed beside. Anchored to the paragraph's top it landed screens above a
  // click in a long paragraph.
  return noteRange(id)?.from ?? paras[Math.min(note.para, paras.length - 1)].from;
}

// Re-anchor every note against the document as it is now. Illegal inside an
// update listener — callers queue it as a microtask (see the docChanged
// listener below), or call it directly from event handlers.
function syncNoteMarks() {
  const document = workView.state.doc.toString();
  const marks = [];
  for (const note of marginNotes) {
    if (note.resolved) continue;
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
  liveSync?.notesChanged();
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
    && (Number.isInteger(note.para) && note.para >= 0 || note.para === null));
  for (const note of marginNotes) if (!Number.isInteger(note.off) || note.off < 0) note.off = 0;
  const baseline = typeof saved?.document === 'string' ? saved.document : null;
  const paras = baseline === null ? [] : paragraphRanges(baseline);
  for (const note of marginNotes) {
    const para = paras[note.para];
    note.anchor ??= para && baseline.slice(para.from, para.to);
    if (note.resolved && !note.work) continue;
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
  const work = note.work, latest = work?.attempts?.at(-1);
  const key = `${inStream}|${note.drifted}|${note.text}|${noteExcerpt(note)}|${work?.status}|${work?.generation}|${work?.error}|${work?.messages?.length}|${latest?.id}|${latest?.status}|${latest?.edits.map(edit => edit.valid).join()}`;
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
  // The × stands inline, right after the last word: it is where the eye
  // finishes reading, instead of a corner of a box that has no visible edge.
  const del = chatEl('button', 'note-del', '×');
  del.type = 'button';
  del.setAttribute('aria-label', 'Delete note');
  del.title = 'Delete note';
  del.addEventListener('click', event => { event.stopPropagation(); deleteNote(note.id); });
  body.append(del);
  if (note.resolved && work) {
    const completed = chatEl('details', 'note-completed');
    completed.append(chatEl('summary', '', 'Completed note'), body); card.append(completed);
  } else card.append(body);
  if (note.drifted) card.append(chatEl('div', 'note-meta', 'text changed — check this note'));
  if (work) {
    const labels = { queued: 'Queued', working: 'Agent writing', review: 'Review changes', done: 'Done', reverted: 'Reverted', blocked: 'Needs input' };
    const status = chatEl('div', 'note-meta', labels[work.status] || 'Queued');
    status.setAttribute('role', 'status'); card.append(status);
    if (work.error) card.append(chatEl('div', 'note-meta', work.error));
    for (const attempt of work.attempts || []) {
      const details = chatEl('details', 'note-work-result');
      details.append(chatEl('summary', '', attempt === latest ? 'Agent result' : 'Previous result'));
      if (attempt.comment) details.append(chatEl('p', '', attempt.comment));
      for (const edit of attempt.edits) {
        details.append(chatEl('del', 'note-before', edit.before), chatEl('ins', 'note-after', edit.after));
      }
      card.append(details);
    }
    for (const message of work.messages || []) card.append(chatEl('p', 'note-feedback', message.text));
    const actions = chatEl('div', 'note-work-actions');
    const button = (label, type, extra = {}) => {
      const el = chatEl('button', 'chat-action', label); el.type = 'button';
      el.addEventListener('click', () => updateNoteWork(note.id, type, extra)); actions.append(el);
      return el;
    };
    if (work.status === 'review' && latest?.status === 'applied') button('Accept', 'accept', { attempt: latest.id });
    if (latest && ['applied', 'accepted'].includes(latest.status) && latest.edits.length) {
      const undo = button('Undo', 'revert', { attempt: latest.id });
      undo.disabled = !reversible(latest, workView.state.doc.toString());
      if (undo.disabled) undo.title = 'This passage changed after the agent edit';
    }
    if (!['queued', 'working'].includes(work.status)) button('Regenerate', 'regenerate');
    if (actions.children.length) card.append(actions);
  }
}

async function updateNoteWork(id, type, extra = {}) {
  try {
    await liveSync.flush();
    const note = marginNotes.find(note => note.id === id);
    if (!note?.work) throw new Error('Save this note before updating its work.');
    await liveSync.work({ id, type, generation: note.work.generation, ...extra });
    noteCards.get(id)?.focus({ preventScroll: true });
  } catch (error) { notify(`Unable to update this note: ${error.message} The note itself is kept.`, { sticky: true, action: () => updateNoteWork(id, type, extra), label: 'Try again' }); }
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
    if (note.resolved && !note.work) { railAnchors.delete(card); railHomes.delete(card); card.remove(); noteCards.delete(id); }
    else renderNoteCard(note);
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

// A point within its paragraph: saved paragraph text survives insertions above.
function createParagraphNote(para, off = 0) {
  const paras = paragraphRanges(workView.state.doc.toString());
  if (!paras.length || para < 0 || para >= paras.length) return null;
  return addNote({ para, quote: '', off });
}

function addNote({ para, quote, off = 0, text = '', kind, edit = true }) {
  const document = workView.state.doc.toString();
  const paragraph = paragraphRanges(document)[para];
  const note = {
    id: `n${Date.now().toString(36)}${(noteSeq++).toString(36)}`,
    para,
    quote,
    off,
    length: quote.length,
    anchor: paragraph && document.slice(paragraph.from, paragraph.to),
    text, kind,
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
  if (edit) queueMicrotask(() => editNoteCard(note.id));
  return note;
}

// ── Paragraph "+" ────────────────────────────────────────────────────────────
//  Hovering the empty margin beside a paragraph shows one faint "+", Notion-
//  style: the paragraph is the commonest note target, and selecting it first
//  just to press Note is a tax on every remark. Clicking the "+" opens a
//  paragraph note (empty quote: the saved paragraph text is the anchor).
//  No shortcut to remember, no button to find — the margin itself invites.
const notePlus = document.createElement('button');
notePlus.type = 'button';
notePlus.className = 'note-plus';
notePlus.innerHTML = icon('plus');
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
    paraCache = paragraphRanges(workView.state.doc.toString());
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
    // Measured now, not remembered: the rail's fit was last judged whenever a
    // card or a resize last asked, and on a fresh load with no notes that was
    // before the column had its final padding — the "+" never showed until
    // the window was resized.
    syncRail();
    // The "+" belongs to the rail: no rail, no plus. Hidden while dragging or
    // holding a selection (its bubble already offers Note) and before the
    // draft loads. An open bubble does not hide it; pressing the "+" closes
    // the bubble anyway. A selection hides it only while
    // its bubble stands: Change puts the bubble away but leaves the passage
    // selected, and that must not take the "+" from every paragraph.
    if (!railOn || loadingDocument || event.buttons !== 0
        || (!workView.state.selection.main.empty && !markBubble.hidden)) {
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
    const railLeft = railPaneLeft;
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
// pause.
function notesBrief() {
  if (!marginNotes.length) return '';
  const lines = marginNotes.filter(note => !note.resolved).map(note => {
    if (note.para === null) return `- On the whole draft: ${note.text}`;
    const range = noteRange(note.id);
    const live = range ? workView.state.sliceDoc(range.from, note.quote ? range.to : range.from + 200).trim().replace(/\s+/g, ' ') : '';
    return `- On "${(live || note.quote).slice(0, 200)}": ${note.text}`;
  });
  return `WRITER'S MARGIN NOTES (the author's own remarks — weigh them, do not quote them back):\n${lines.join('\n')}`;
}

// Four draft-specific questions, saved with answers so an interrupted brief resumes.
let positionBrief = null;   // { reader, goal, awareness, scope, updatedAt, nudged }
let briefSession = null;    // { step, answers, card } while the interview runs

function saveBrief() {
  cancelSuggestion();
  ghostClear(workView);
  if (positionBrief) docStorage.setItem('wa-brief', JSON.stringify(positionBrief));
  else docStorage.removeItem('wa-brief');
}
function restoreBrief() {
  const saved = safeJson(docStorage.getItem('wa-brief'), null);
  positionBrief = saved && typeof saved === 'object' ? saved : null;
  if (positionBrief?.questions) {
    try { positionBrief.questions = validateBriefQuestions(positionBrief.questions); }
    catch { delete positionBrief.questions; }
  }
  briefSession?.controller?.abort();
  briefSession = null;
}
function briefComplete() {
  return BRIEF_STEPS.every(step => typeof positionBrief?.[step.key] === 'string' && positionBrief[step.key].trim());
}
function briefContext() {
  const lines = BRIEF_STEPS.flatMap((step, index) => typeof positionBrief?.[step.key] === 'string' && positionBrief[step.key].trim()
    ? [`- ${positionBrief.questions?.[index]?.question || step.label}: ${positionBrief[step.key]}`] : []);
  if (typeof positionBrief?.direction === 'string' && positionBrief.direction.trim()) lines.push(`- Writing constraints: ${positionBrief.direction}`);
  return lines.length ? `WRITING BRIEF (author's preferences, not factual evidence):\n${lines.join('\n')}` : '';
}

function applyChatBrief(update, message, expected) {
  let changes;
  try { ({ changes } = validateBriefUpdate(update, message)); }
  catch { notify('The brief update could not be verified. Nothing was saved. Ask again to update it.'); return; }
  if (JSON.stringify(positionBrief) !== expected || briefSession) {
    notify('The brief changed while the reply was loading. Ask again to update it.');
    return;
  }
  const previous = positionBrief;
  positionBrief = { ...positionBrief, ...changes, updatedAt: Date.now(), nudged: true };
  // Generated questions can become irrelevant after the author changes the brief.
  delete positionBrief.questions;
  const applied = positionBrief;
  saveBrief();
  notifyUndo('Brief updated — suggestions, rewrites and chat now use it.', () => {
    if (positionBrief !== applied) { notify('The brief has changed since this update. Edit it with /brief.'); return; }
    positionBrief = previous;
    saveBrief();
  });
}
function combinedContext() {
  return [notesBrief(), briefContext()].filter(Boolean).join('\n\n');
}

async function startBrief() {
  dismissPassingNotice();
  openIsland();
  if (briefSession) { renderBriefQuestion(); chatInput.focus(); return; }
  if (briefComplete() && positionBrief?.questions) { renderBriefSummary(); return; }
  const answers = {};
  for (const step of BRIEF_STEPS) {
    if (typeof positionBrief?.[step.key] === 'string' && positionBrief[step.key].trim()) answers[step.key] = positionBrief[step.key];
  }
  const step = BRIEF_STEPS.findIndex(item => !answers[item.key]);
  const session = briefSession = { step: step === -1 ? 0 : step, answers, card: null };
  if (!positionBrief?.questions && workView.state.doc.length) {
    session.loading = true;
    session.controller = new AbortController();
    renderBriefQuestion();
    try {
      const result = await api('/brief', { method: 'POST', signal: session.controller.signal,
        body: JSON.stringify({ document: workView.state.doc.toString(), answers, agent: currentAgent() }) });
      if (briefSession !== session) return;
      positionBrief = { ...(positionBrief || {}), questions: validateBriefQuestions(result.questions) };
      saveBrief();
    } catch (error) {
      if (briefSession !== session) return;
      notify('Could not tailor the brief — using general questions. ' + error.message);
    }
    session.loading = false;
  }
  if (briefSession !== session) return;
  if (briefComplete()) { session.card?.remove(); briefSession = null; renderBriefSummary(); return; }
  renderBriefQuestion();
  chatInput.focus();
}

function renderBriefQuestion() {
  if (!briefSession) return;
  briefSession.card?.remove();
  const step = (positionBrief?.questions || BRIEF_STEPS)[briefSession.step];
  const card = chatEl('div', 'chat-entry is-agent brief-card');
  const head = chatEl('div', 'brief-head');
  head.append(chatEl('span', 'brief-kicker', 'Positioning brief'));
  head.append(chatEl('span', 'brief-step', `${briefSession.step + 1} of ${BRIEF_STEPS.length}`));
  card.append(head);
  card.append(chatEl('p', 'brief-question', briefSession.loading ? 'Preparing questions for your draft…' : step.question));
  const options = chatEl('div', 'brief-options');
  options.setAttribute('role', 'group');
  options.setAttribute('aria-label', step.question);
  for (const option of briefSession.loading ? [] : step.options) {
    const pick = chatEl('button', 'brief-option', option);
    pick.type = 'button';
    pick.addEventListener('click', () => answerBriefStep(option));
    options.append(pick);
  }
  card.append(options);
  const foot = chatEl('div', 'brief-foot');
  foot.append(chatEl('span', 'variant-hint', briefSession.loading ? '' : 'Or type your own answer below.'));
  const skip = chatEl('button', 'brief-skip', 'Skip for now');
  skip.type = 'button';
  skip.addEventListener('click', () => cancelBrief());
  foot.append(skip);
  card.append(foot);
  briefSession.card = chatAdd(card);
}

function answerBriefStep(text) {
  if (!briefSession || briefSession.loading) return;
  const clean = String(text ?? '').trim();
  if (!clean) return;
  const step = BRIEF_STEPS[briefSession.step];
  briefSession.answers[step.key] = clean.slice(0, 200);
  positionBrief = { ...(positionBrief || {}), ...briefSession.answers, nudged: true };
  saveBrief();
  briefSession.card?.remove();
  briefSession.card = null;
  const next = BRIEF_STEPS.findIndex(item => !briefSession.answers[item.key]?.trim());
  if (next !== -1) {
    briefSession.step = next;
    renderBriefQuestion();
    return;
  }
  finishBrief();
}

function finishBrief() {
  positionBrief = { ...positionBrief, ...briefSession.answers, updatedAt: Date.now(), nudged: true };
  briefSession = null;
  saveBrief();
  renderBriefSummary();
  notify('Brief saved — suggestions, rewrites, chat and ideas now use it.');
}

function renderBriefSummary() {
  const card = chatEl('div', 'chat-entry is-agent brief-card');
  const head = chatEl('div', 'brief-head');
  head.append(chatEl('span', 'brief-kicker', 'Positioning brief'));
  if (positionBrief.updatedAt) head.append(chatEl('span', 'brief-step', new Date(positionBrief.updatedAt).toLocaleDateString()));
  card.append(head);
  const rows = chatEl('div', 'brief-rows');
  for (let index = 0; index < BRIEF_STEPS.length; index++) {
    const step = BRIEF_STEPS[index];
    const row = chatEl('div', 'brief-row');
    row.append(chatEl('span', 'brief-label', step.label));
    row.append(chatEl('span', 'brief-value', positionBrief[step.key]));
    const edit = chatEl('button', 'brief-edit', 'Edit');
    edit.type = 'button';
    edit.setAttribute('aria-label', `Edit ${step.label.toLowerCase()}`);
    edit.addEventListener('click', () => {
      briefSession = { step: index, answers: { ...positionBrief }, card: null };
      card.remove();
      renderBriefQuestion();
      chatInput.focus();
    });
    row.append(edit);
    rows.append(row);
  }
  card.append(rows);
  if (positionBrief.direction) card.append(chatEl('p', 'brief-value', positionBrief.direction));
  const meta = 'Used for suggestions, rewrites, chat and ideas. To update from chat: “For the whole draft: …”.';
  card.append(chatEl('p', 'variant-hint', meta));
  chatAdd(card);
}

function cancelBrief() {
  if (!briefSession) return;
  briefSession.controller?.abort();
  briefSession.card?.remove();
  // Keep partial answers so /brief resumes where it stopped.
  positionBrief = { ...(positionBrief || {}), ...briefSession.answers, nudged: true };
  briefSession = null;
  saveBrief();
}

// Clicking a note's mark reads the note: the editor scrolls the passage into
// view and the card takes focus. Arms nothing.
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

// ── Mark bubble ──
//
//  Clicking a mark or selecting text arms nothing. The bubble beside the click
//  holds explicit actions: Change opens a local passage field; rewrite
//  actions ask for scoped replacements. One bubble at a
//  time; an edit, copy, or Escape puts it away — a scroll carries it along.
const markBubble = document.getElementById('mark-bubble');
let bubbleMode = null;   // 'selection' | 'spell' while open

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

// The box the bubble may live in: the writing pane, not the window — the file
// sidebar is a column beside it, and a toolbar under it is a toolbar nobody can
// press. The transparent header band is fair game: the bubble draws above the
// header (z-index in style.css), and using the band is what lets a bubble for
// the draft's second line stand above it instead of flipping onto the next.
function bubbleArea() {
  const pane = document.getElementById('pane-work').getBoundingClientRect();
  const left = pane.left + 8;
  return {
    left,
    right: Math.max(left, pane.right - 8),
    top: pane.top + 8,
    bottom: window.innerHeight - 8,
  };
}

// The document position the bubble was asked for, so a reflow can put it back
// over the same words — the draft re-centres when the sidebar opens, so the
// old screen point would be off. Cleared whenever it is put away.
let bubbleAnchor = null;

// A floating bubble stands over the text it acts on, never on it: anchored to
// the top of the passage's first line (centred on the passage when it fits on
// one line, at the pointer otherwise), with the passage's height kept so it can
// flip below the last line instead. Pointer-relative placement put the bubble
// over the upper half of the very line that was clicked.
function textAnchor(from, to, fallbackX) {
  const start = workView.coordsAtPos(from, 1);
  const end = workView.coordsAtPos(to, -1);
  if (!start || !end) return null;
  const x = Math.abs(end.top - start.top) < 2 ? (start.left + end.right) / 2 : fallbackX;
  return { pos: from, dx: x - start.left, dy: 0, dh: Math.max(end.bottom, start.bottom) - start.top };
}

function placeBubble(x, y, anchor = null) {
  markBubble.hidden = false;
  if (!anchor) {
    // A bare point: the line under it is the text to clear.
    const pos = workView.posAtCoords({ x, y });
    anchor = pos == null ? null : textAnchor(pos, pos, x);
    if (anchor) anchor.dx = x - workView.coordsAtPos(pos, 1).left;
  }
  if (anchor) {
    const at = workView.coordsAtPos(anchor.pos, 1);
    if (at) ({ x, y } = { x: at.left + anchor.dx, y: at.top + anchor.dy });
  }
  bubbleAnchor = anchor;
  const area = bubbleArea();
  // Scrolled under the header or off the pane: hidden with its words, back
  // when they return — never pinned to an edge pointing at nothing.
  const box = markBubble.getBoundingClientRect();
  markBubble.style.visibility = y < area.top - 8 || y > area.bottom ? 'hidden' : '';
  const { left, top, side } = clampBubble(x, y, { w: box.width, h: box.height }, area, y + (anchor?.dh ?? 0));
  markBubble.dataset.side = side;
  markBubble.style.left = `${left}px`;
  markBubble.style.top = `${top}px`;
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

function showSelectionBubble(x, y) {
  const sel = workView.state.selection.main;
  if (sel.empty) return;
  // A mark click owns the bubble when the click lands on one; a bare
  // selection opens its own local instruction field.
  bubbleMode = 'selection';
  const actions = chatEl('div', 'mark-bubble-actions');
  actions.append(bubbleButton('Change', () => {
    const live = workView.state.selection.main;
    if (live.empty) return;
    openPassage(workView, live);
  }));
  markBubble.replaceChildren(actions);
  placeBubble(x, y, textAnchor(sel.from, sel.to, x));
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
  placeBubble(x, y, textAnchor(marker.from, marker.to, x));
}

// ── Rewrite variants ────────────────────────────────────────────────────────
// Chat replacements preview in place before the writer applies them.

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
});
let flashTimer = null;

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
  if (!plainPreview) return;
  plainPreview = null;
  try { workView.dispatch({ effects: setPlainVariantFx.of(null) }); } catch {}
  syncChatEditCards();
}

function applyText(text, target) {
  if (!replacementTarget(workView.state.doc.toString(), target) || workView.state.readOnly) {
    notify('The draft changed since this answer. Select the passage and request a new change.');
    return;
  }
  plainPreview = null;
  saveSnapshot('Before AI replacement');
  workView.dispatch({
    changes: { from: target.from, to: target.to, insert: text },
    selection: { anchor: target.from + text.length },
    effects: [setPlainVariantFx.of(null), setFlashFx.of({ from: target.from, to: target.from + text.length })],
  });
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { try { workView.dispatch({ effects: setFlashFx.of(null) }); } catch {} }, 1300);
  workView.focus();
  save();
}

// ── Slash commands ──────────────────────────────────────────────────────────
//
//  Granola-style menu over the composer: icon, name and one line of
//  description per row, filtered as the writer types after /. ↑↓ move,
//  Enter/Tab runs, Esc closes. Every choice runs immediately.
//  The menu only lives while the field holds a bare /name — once arguments
//  follow, Enter runs instead of picking.
const SLASH_COMMANDS = [
  {
    name: 'brief', icon: 'target', title: 'Positioning brief',
    desc: 'Answer 4 questions about reader and goal',
    run() {
      clearNotice('brief');
      startBrief();
    },
  },
];

const slashMenu = document.getElementById('slash-menu');
let slashActive = -1;     // index into the current filtered rows
let slashDismissed = '';  // field value Esc dismissed the menu for

// A bare /name with nothing after it; null once arguments follow or the
// field is anything else.
function slashQuery() {
  const match = chatInput.value.match(/^\/([A-Za-z]*)$/);
  return match ? match[1].toLowerCase() : null;
}
function slashMatches() {
  const query = slashQuery();
  if (query === null) return [];
  return SLASH_COMMANDS.filter(item => item.name.startsWith(query));
}
function setSlashActive(index) {
  slashActive = index;
  const rows = [...slashMenu.querySelectorAll('.slash-item')];
  rows.forEach((row, at) => {
    const on = at === index;
    row.classList.toggle('is-active', on);
    row.setAttribute('aria-selected', String(on));
  });
  if (rows[index]) {
    rows[index].scrollIntoView({ block: 'nearest' });
    chatInput.setAttribute('aria-activedescendant', rows[index].id);
  } else chatInput.removeAttribute('aria-activedescendant');
}
function pickSlash(item) {
  if ([...jobs].some(job => !job.background)) return;
  slashMenu.hidden = true;
  chatInput.setAttribute('aria-expanded', 'false');
  chatInput.removeAttribute('aria-activedescendant');
  chatInput.value = '';
  chatResize();
  chatInput.focus();
  item.run('');
}
function renderSlashMenu() {
  const query = slashQuery();
  if (query === null || chatInput.value === slashDismissed || document.activeElement !== chatInput) {
    slashMenu.hidden = true;
    chatInput.setAttribute('aria-expanded', 'false');
    chatInput.removeAttribute('aria-activedescendant');
    return;
  }
  const matched = slashMatches();
  slashMenu.replaceChildren();
  if (!matched.length) {
    slashMenu.append(chatEl('p', 'slash-empty', 'No matching command — try /brief.'));
  } else {
    if (slashActive < 0 || slashActive >= matched.length) slashActive = 0;
    matched.forEach((item, index) => {
      const row = chatEl('button', 'slash-item' + (index === slashActive ? ' is-active' : ''));
      row.type = 'button';
      row.id = `slash-item-${index}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(index === slashActive));
      const badge = chatEl('span', 'slash-icon', '');
      badge.innerHTML = icon(item.icon);
      badge.setAttribute('aria-hidden', 'true');
      const text = chatEl('span', 'slash-text', '');
      const name = chatEl('span', 'slash-name', item.title + ' ');
      name.append(chatEl('span', 'slash-cmd', `/${item.name}`));
      text.append(name, chatEl('span', 'slash-desc', item.desc));
      row.append(badge, text);
      // Mousedown would blur the composer and hide the menu before the click
      // lands; the click then reads as leaving the field. Hold focus instead.
      row.addEventListener('mousedown', event => event.preventDefault());
      row.addEventListener('click', () => pickSlash(item));
      row.addEventListener('mousemove', () => { if (slashActive !== index) setSlashActive(index); });
      slashMenu.append(row);
    });
    chatInput.setAttribute('aria-activedescendant', `slash-item-${slashActive}`);
  }
  slashMenu.hidden = false;
  chatInput.setAttribute('aria-expanded', 'true');
}
chatInput.addEventListener('input', () => { slashDismissed = ''; slashActive = -1; renderSlashMenu(); });
chatInput.addEventListener('focus', renderSlashMenu);
chatInput.addEventListener('blur', () => { slashMenu.hidden = true; });

// ── Conversation ──

async function chatSend() {
  // Sealed while the writer's own work runs — Stop first, then ask.
  if ([...jobs].some(job => !job.background)) return;
  slashMenu.hidden = true;
  const text = chatInput.value.trim();
  const slash = text.match(/^\/([A-Za-z]+)\s*([\s\S]*)$/);
  if (slash) {
    const command = SLASH_COMMANDS.find(item => item.name === slash[1].toLowerCase());
    if (!command) { notify('No such command — try /brief.'); return; }
    chatInput.value = '';
    chatResize();
    command.run(slash[2] || '');
    return;
  }
  // While the brief interview runs the composer is its answer field.
  if (briefSession) {
    if (briefSession.loading) return;
    if (!text) return;
    chatInput.value = '';
    chatResize();
    streamAppend(chatEl('div', 'chat-entry is-user', text));
    answerBriefStep(text);
    return;
  }
  if (!text) return;
  if (!await ensureAgent()) return;
  chatInput.value = '';
  chatResize();
  chatAdd(chatEl('div', 'chat-entry is-user', text));

  chatHistory.push({ role: 'user', content: text });
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
  const request = { document: workView.state.doc.toString(), selection: null, changes: [],
    brief: JSON.stringify(positionBrief), message: chatHistory.at(-1)?.content };
  chatRequests.add(request);
  let answer = '', result = null;
  try {
    const res = await fetch('/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: job.signal,
      body: JSON.stringify({
        messages: chatHistory.map(({ role, content, edits }) => ({ role, content: content + (edits?.length ? `\n${EDITS_OPEN}${JSON.stringify(edits.map(({ label, quote, replacement, state }) => ({ label, quote, replacement, state })))}</stilura-edits>` : '') })),
        document: request.document, selection: request.selection?.text,
        selectionRange: request.selection && { from: request.selection.from, to: request.selection.to }, agent: currentAgent(),
        context: combinedContext() || undefined,
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
    // The finished answer follows the same rule as its tokens: a reader who
    // scrolled back up mid-stream keeps their place.
    const stick = chatAtBottom();
    chatHistory.push(message); renderChatAnswer(reply, message); saveChat(); chatScroll(stick);
    if (edits.length === 1) changeChatEdit(edits[0], false, true);
    if (message.editWarning) notify(message.editWarning);
    if (result?.briefWarning) notify(result.briefWarning);
    else if (result?.brief) applyChatBrief(result.brief, request.message, request.brief);
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
  chatInput.placeholder = busy ? 'Working…' : CHAT_PLACEHOLDER;
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
  const menuOpen = !slashMenu.hidden;
  if (menuOpen && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    const matched = slashMatches();
    if (matched.length) {
      event.preventDefault();
      const at = slashActive < 0 ? 0 : slashActive;
      setSlashActive((at + (event.key === 'ArrowDown' ? 1 : -1) + matched.length) % matched.length);
    }
    return;
  }
  if (menuOpen && event.key === 'Tab') {
    const matched = slashMatches();
    if (matched.length) {
      event.preventDefault();
      pickSlash(matched[slashActive] ?? matched[0]);
    }
    return;
  }
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    if (menuOpen) {
      const matched = slashMatches();
      if (matched.length) { pickSlash(matched[slashActive] ?? matched[0]); return; }
      slashMenu.hidden = true;
    }
    chatSend();
  }
  else if (event.key === 'Escape') {
    // Escape belongs to the composer only while it has something to give up.
    // A key with two owners is claimed by the inner one: stopPropagation, so
    // nothing further up reads a state this handler has already undone — and
    // nothing above can act on the same press. With nothing attached and no
    // request running, the key is left alone to reach the sidebar overlay.
    if (chatAbort && !chatAbort.signal.aborted) { chatAbort.abort(); event.stopPropagation(); return; }
    if (menuOpen) {
      slashDismissed = chatInput.value;
      slashMenu.hidden = true;
      chatInput.removeAttribute('aria-activedescendant');
      event.stopPropagation();
      return;
    }
    if (briefSession) {
      cancelBrief();
      event.stopPropagation();
      return;
    }
    // An empty, unstarted composer folds back into the pill.
    if (!chatInput.value.trim() && canCollapseIsland()) {
      workView.focus();
      afterStreamLeaves(() => setIsland(false), true);
      event.stopPropagation();
    }
  }
});

// Keep focus where it is while the button is pressed: the mousedown would
// otherwise blur the composer first, and the click would read as leaving the
// field rather than as opening or closing the conversation.
chatClear.addEventListener('mousedown', event => event.preventDefault());
chatClear.addEventListener('click', () => {
  const open = chatStream.hidden;
  // Dismissing returns to the draft; opening returns to the composer. Focusing
  // the composer on close pops the keyboard after the user asked to leave.
  if (open) { setChatOpen(true); chatInput.focus(); return; }
  workView.focus();
  // Closing an empty, unstarted chat folds the whole island back into the
  // pill; otherwise only the stream goes.
  const fold = canCollapseIsland();
  afterStreamLeaves(() => { setChatOpen(false); if (fold) setIsland(false); }, fold);
});

// Cmd/Ctrl+K opens the same local field as Change.
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !settingsDialog.open) {
    event.preventDefault();
    openPassage(workView, workView.state.selection.main);
  }
});

// ─── Editor theme (injected into <head> by CM6) ─────────────────────────────────

const isDark = currentTheme === 'dark';

// ── Markdown, minimal ────────────────────────────────────────────────────────
//  The text stays plain: every marker remains in the draft, dimmed, and what
//  it marks is styled in place — headings, bold, italic, `code`, links, quotes,
//  list markers, rules. Nothing is replaced or hidden; a widget would put the
//  caret and the notes' character offsets out of step with what is typed.
//  Fences and `inline code` are left unparsed. Rebuilt per edit over the whole
//  draft — a regex pass, cheap at prose length.
// ponytail: whole-draft rescan per keystroke, visible-range only if a draft ever outgrows it.
const MD_INLINE = new RegExp([
  '(?<code>`[^`\\n]+`)',
  '\\*\\*\\*(?=\\S)(?<both>.+?)(?<=\\S)\\*\\*\\*',
  '\\*\\*(?=\\S)(?<bold>.+?)(?<=\\S)\\*\\*',
  '(?<![*\\w])\\*(?=[^\\s*])(?<em>.+?)(?<=[^\\s*])\\*(?![*\\w])',
  '(?<![\\w_])_(?=[^\\s_])(?<un>.+?)(?<=[^\\s_])_(?![\\w_])',
  '\\[(?<link>[^\\]\\n]+)\\](?<url>\\([^)\\s]+(?:\\s+"[^"\\n]*")?\\))',
].join('|'), 'g');
const mdMark = Decoration.mark({ class: 'cm-md-mark' });
const mdBold = Decoration.mark({ class: 'cm-md-b' });
const mdItalic = Decoration.mark({ class: 'cm-md-i' });
const mdBoldItalic = Decoration.mark({ class: 'cm-md-b cm-md-i' });
const mdCode = Decoration.mark({ class: 'cm-md-code' });
const mdLink = Decoration.mark({ class: 'cm-md-link' });
const mdHeading = Decoration.line({ class: 'cm-md-h' });
const mdQuote = Decoration.line({ class: 'cm-md-quote' });
const mdRule = Decoration.line({ class: 'cm-md-rule' });
const MD_RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const MD_LIST = /^\s*([-*+]|\d+[.)])(?=\s)/;

function markdownDecorations(doc) {
  const ranges = [];
  let fence = false;
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    const text = line.text;
    if (/^\s*(```|~~~)/.test(text)) { fence = !fence; continue; }
    if (fence) continue;
    if (MD_RULE.test(text)) { ranges.push(mdRule.range(line.from)); continue; }
    const heading = /^(#{1,6})(?=\s)/.exec(text);
    if (heading) {
      ranges.push(mdHeading.range(line.from), mdMark.range(line.from, line.from + heading[1].length));
    } else if (text.startsWith('>')) {
      ranges.push(mdQuote.range(line.from), mdMark.range(line.from, line.from + 1));
    } else {
      const list = MD_LIST.exec(text);
      if (list) ranges.push(mdMark.range(line.from + list[0].length - list[1].length, line.from + list[0].length));
    }
    for (const m of text.matchAll(MD_INLINE)) {
      const g = m.groups;
      const from = line.from + m.index, to = from + m[0].length;
      if (g.link !== undefined) {
        const open = from + 1, close = open + g.link.length;
        ranges.push(mdMark.range(from, open), mdLink.range(open, close), mdMark.range(close, to));
        continue;
      }
      const [width, deco] = g.code !== undefined ? [1, mdCode]
        : g.both !== undefined ? [3, mdBoldItalic]
        : g.bold !== undefined ? [2, mdBold]
        : [1, mdItalic];
      ranges.push(deco.range(from + width, to - width), mdMark.range(from, from + width), mdMark.range(to - width, to));
    }
  }
  return Decoration.set(ranges, true);
}

const markdownField = StateField.define({
  create: state => markdownDecorations(state.doc),
  update: (decorations, tr) => tr.docChanged ? markdownDecorations(tr.state.doc) : decorations,
});

// One visible highlight per character. Tracking fields keep all anchors intact.
function textHighlights(state) {
  const generation = state.field(generationField);
  const passage = state.field(passageField);
  const preview = state.field(variantPlainField);
  const flash = state.field(flashField);
  const mark = (value, className) => value && value.to > value.from
    ? Decoration.set([Decoration.mark({ class: className, ...(className === 'cm-passage-busy' ? { attributes: { 'aria-busy': 'true' } } : {}) }).range(value.from, value.to)]) : Decoration.none;
  const markers = (field, className, attribute, title) => Decoration.set(state.field(field).map(value =>
    Decoration.mark({ class: className, attributes: { [attribute]: String(value.from), title } }).range(value.from, value.to)), true);
  const selectionMask = Decoration.mark({});
  // Later sets win: diagnostics < working range < native selection < loading.
  const sets = [
    state.field(markdownField), state.field(noteField, false) ?? Decoration.none,
    markers(spellMarkerField, 'cm-spell-marker', 'data-spell-from', 'Possible misspelling — click for suggestions'),
    mark(flash, 'cm-applied-flash'),
    mark(passage, 'cm-attached'), state.field(requestField),
    Decoration.set(state.selection.ranges.filter(range => !range.empty).map(range => selectionMask.range(range.from, range.to)), true),
    mark(passage?.busy ? passage : null, 'cm-passage-busy'),
  ];
  const priorities = new Map();
  sets.forEach((set, priority) => set.between(0, state.doc.length, (_from, _to, value) => priorities.set(value, priority)));
  // Replacement widgets occupy their range exclusively, including during regeneration.
  if (generation && !(generation.source === 'passage' && passage?.busy)) sets.unshift(Decoration.set([
    Decoration.replace({ widget: new GenerationWidget(generation), block: !generation.inline }).range(generation.from, generation.to),
  ]));
  if (preview) sets.unshift(Decoration.set([
    Decoration.replace({ widget: new PlainVariantWidget(preview.text, preview.block), block: preview.block }).range(preview.from, preview.to),
  ]));
  const ranges = [], last = new Map();
  const emit = (from, to, value) => {
    const previous = last.get(value);
    if (previous?.to === from) previous.to = to;
    else { const range = value.range(from, to); ranges.push(range); last.set(value, range); }
  };
  RangeSet.spans(sets, 0, state.doc.length, {
    span(from, to, active) {
      let winner;
      for (const value of active) if (priorities.get(value) > 0 && (!winner || priorities.get(value) > priorities.get(winner))) winner = value;
      if (winner !== selectionMask && winner) emit(from, to, winner);
      // Keep Markdown formatting except inside the word-shaped loading placeholder.
      if (winner?.spec.class !== 'cm-passage-busy') {
        for (const value of active) if (priorities.get(value) === 0) emit(from, to, value);
      }
    },
    point: emit,
  });
  return Decoration.set(ranges, true);
}
const textHighlightLayer = EditorView.decorations.compute([
  markdownField, noteField, spellMarkerField,
  flashField, passageField, requestField, generationField, variantPlainField, 'selection',
], textHighlights);

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
    // Reserve scrollbar space without a left gutter, which offsets CM's cursor layer.
    scrollbarGutter: 'stable',
  },

  // Editable content area — generous padding, centred like the old textarea
  '.cm-content': {
    // The measure is set in characters, so it holds if the size changes. It
    // gives way before the notes do: between 52ch and 68ch the column shrinks
    // so the margin keeps room for the rail (RAIL_WIDTH + RAIL_GUTTER a side).
    // Only below 52ch do notes fall back to the chat stream.
    padding:    '28px max(32px, calc((100% - clamp(52ch, 100% - 2 * 244px, 68ch)) / 2))',
    caretColor: 'var(--accent)',
    color:      'var(--text)',
    minHeight:  '100%',
  },

  // Each line — no extra horizontal padding (already on .cm-content)
  '.cm-line': { padding: '0' },

  // Cursor
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--accent)',
    borderLeftWidth: '1.5px',
  },

  // Selection highlight
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    background: 'var(--attached-tint) !important',
  },

  // ── Suggestion ─────────────────────────────────────────────────────────────
  //
  //  Continuation text after the caret, same face as the draft but fainter.
  //  Nothing is added to the document until Tab; accepted text is plain
  //  document text, so it simply loses this class. Escape dismisses.
  //
  '.cm-suggest': {
    opacity:       '0.45',
    pointerEvents: 'none',
    userSelect:    'none',
  },

  // Working ranges share one blue wash; no outsets that touch adjacent lines.
  '.cm-attached': {
    background: 'var(--attached-tint)',
    borderRadius: '2px',
    boxDecorationBreak: 'clone',
  },
  '.cm-note': {
    textDecoration: 'underline dotted var(--muted)',
    textUnderlineOffset: '4px',
    cursor: 'pointer',
  },
  '.cm-note.is-drifted': { textDecorationStyle: 'dashed' },

  // Slightly dim the content while the document is loading.
  '&.streaming .cm-content': { opacity: '0.8' },

  '.cm-generation': { whiteSpace: 'pre-wrap' },

  '.cm-generation-request': { background: 'var(--attached-tint)', borderRadius: '2px' },

  // Hide gutters and fold markers — this is a prose editor
  '.cm-gutters': { display: 'none' },
}, { dark: isDark });

// ─── Editor setup ──────────────────────────────────────────────────────────────

const historyComp = new Compartment();
const workView = new EditorView({
  state: EditorState.create({
    doc: '',

    extensions: [
      // Undo/redo
      historyComp.of(history()),
      drawSelection(),

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
            if (generationKey(view, 'Accept')) return true;
            if (ghostAccept(view)) return true;
            return false; // Native Tab navigation when no suggestion is present.
          },
        },
        {
          // Escape: cancel generation or dismiss the continuation.
          key: 'Escape',
          run(view) {
            if (generationJob) { generationJob.abort(); return true; }
            if (passageJob) { passageJob.abort(); return true; }
            if (generationKey(view, 'Reject')) return true;
            if (view.state.field(passageField)) { closePassage(view); return true; }
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
      ])),

      Prec.high(keymap.of([
        { key: 'Enter', run: handleWrite },
        { key: 'ArrowDown', run: view => generationKey(view, 'Next') },
        { key: 'ArrowUp', run: view => generationKey(view, 'Previous') },
        { key: 'r', run: view => generationKey(view, 'Regenerate') },
        { key: 'Alt-Enter', run: view => generationKey(view, 'Regenerate') },
      ])),

      // Standard text-editing and history keymaps
      keymap.of([...searchKeymap, ...historyKeymap, ...defaultKeymap]),
      // Native spellcheck: free red squiggly + right-click suggestions from
      // the OS/browser dictionary. Autocorrect/autocapitalize stay off — a
      // silent rewrite is not what "quick fix" means here.
      EditorView.contentAttributes.of({
        'aria-label': 'Draft editor', 'aria-describedby': 'editor-shortcuts',
        spellcheck: 'true', autocorrect: 'off', autocapitalize: 'off',
      }),

      // Ghost text state + decoration provider
      ghostField,
      generationField,
      requestField,
      passageField,
      markdownField,
      spellMarkerField,
      variantPlainField,
      flashField,
      textHighlightLayer,

      // Read-only compartment — toggled while loading the document
      readonlyComp.of(EditorState.readOnly.of(true)),

      // Word wrap (essential for prose)
      EditorView.lineWrapping,

      // Reserve the covered strips so CodeMirror scrolls the caret clear of
      // both: the floating panel below, and the 48px header above — a jumped-to
      // line never parks flush under it.
      EditorView.scrollMargins.of(() => ({ top: 64, bottom: chatHeight })),

      // Visual theme
      editorTheme,

      // Passage gestures stay in the editor.
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
          const spellLocal = event.target.closest?.('.cm-spell-marker');
          const marker = spellLocal && view.state.field(spellMarkerField).find(item => item.from === Number(spellLocal.dataset.spellFrom));
          if (marker) showSpellBubble(marker, at.x, at.y);
          return false;
        },
        // Reaching for the text dismisses a hover preview; the cards stay —
        // choosing is a click on a card, not a click in the draft.
        mousedown() { clearPlainPreview(); return false; },

      }),

      EditorView.updateListener.of(suggestionUpdate),
      // The island's key hint lives exactly as long as the suggestion it names.
      EditorView.updateListener.of(update => {
        if (noticeKey === 'passage-hint' && update.state.field(generationField)?.phase !== 'review') notify('', { key: 'passage-hint' });
      }),

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
        if (passageJob && (!update.state.field(passageField) || update.state.readOnly || loadingDocument || savePaused)) passageJob.abort();
        if (generationJob && (!update.state.field(generationField) || update.state.readOnly || loadingDocument || savePaused)) generationJob.abort();
        if (update.selectionSet && !update.docChanged) for (const ui of chatEditCards.values()) if (!ui.retarget.hidden) syncRetarget(ui);
        if (update.docChanged) {
          liveSync?.changed(update.changes);
          editVersion++;
          for (const request of chatRequests) request.changes.push(update.changes);
          for (const message of chatHistory) for (const edit of message.edits || []) {
            if (edit !== changingChatEdit) mapChatEdit(edit, update.changes);
          }
          syncChatEditCards();
          if (!loadingDocument) saveChat();
          if (update.transactions.some(tr => tr.isUserEvent('undo') || tr.isUserEvent('redo'))) clearNotice('undo');
          // A hover preview is a decoration over the old range; any edit drops it.
          if (plainPreview) queueMicrotask(clearPlainPreview);
          // Map anchors now; redraw and persist on the next tick because a
          // dispatch inside an update listener is illegal.
          if (marginNotes.length && !loadingDocument) {
            // A disk reload replaces everything without identifying which passage changed.
            let replacedAll = false;
            update.changes.iterChangedRanges((from, to) => { if (from === 0 && to === update.startState.doc.length) replacedAll = true; });
            if (!replacedAll) mapNoteAnchors(marginNotes, update.startState.doc.toString(), update.state.doc.toString(), update.changes);
            queueMicrotask(() => { if (!loadingDocument && marginNotes.length) { syncNoteMarks(); saveNotes(); } });
          }
          if (!loadingDocument) save();

        }
      }),
    ],
  }),

  parent: editorWrap,
});

// The rail rides inside the editor's scroller so note cards composite with
// the text instead of chasing it per scroll event (see layoutRail).
workView.scrollDOM.appendChild(rail);
// Content reflow (font arrival, zoom, wrap change) moves anchors without an
// edit: the rail's tops are document coordinates, so follow the content.
new ResizeObserver(() => layoutRail()).observe(workView.contentDOM);

// The dictionary is a couple hundred KB; fetch it once in the background and
// mark whatever is already on the page as soon as it lands.
loadSpellDictionary().then(spell => {
  spellChecker = spell;
  workView.dispatch({ effects: refreshSpellFx.of(null) });
}).catch(error => notifyProblem({ say: 'Spellcheck is unavailable.', detail: error.message }, null, 'Try again', 'spell-error'));

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
  autosaveHold = false;   // the document is replaced — no delete to guard
  chatEditCards.clear();
  clearNotice('undo');
  for (const job of jobs) job.abort();
  cancelSuggestion();
  saveSnapshot('Before replacing document');
  workView.dispatch({ changes: { from: 0, to: workView.state.doc.length, insert: text } });
  discardNoteCards();
  docStorage.removeItem('wa-notes');
  docStorage.removeItem('wa-brief');
  positionBrief = null;
  if (briefSession) { briefSession.controller?.abort(); briefSession.card?.remove(); briefSession = null; }
  chatHistory = []; chatStream.replaceChildren();
  docStorage.removeItem('wa-chat');
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
  if (liveSync?.active) return;
  clearTimeout(diskTimer);
  if (savePaused || loadingDocument || diskHold || autosaveHold) return;
  // Routine saves are silent: autosave is expected to work, and a Saved /
  // Unsaved flicker on every pause reports nothing the writer can act on.
  // The header speaks only when attention is needed (error, conflict).
  diskTimer = setTimeout(flushSave, 800);
}
function draftUrl(suffix = '') {
  return `/draft${suffix}` + (documentName ? `?name=${encodeURIComponent(documentName)}` : '');
}
function openDocumentText(text) {
  // Drop the previous file's undo stack before installing the new text.
  workView.dispatch({ effects: historyComp.reconfigure([]) });
  workView.dispatch({
    changes: { from: 0, to: workView.state.doc.length, insert: text },
    effects: historyComp.reconfigure(history()),
    annotations: Transaction.addToHistory.of(false),
  });
}
function flushSave() {
  if (liveSync?.active) return liveSync.flush();
  if (saving) return savePromise;
  if (savePaused || loadingDocument || diskHold) return;
  const text = workView.state.doc.toString();
  if (text === diskText && diskRevision !== 'missing') return;
  saving = true;
  savePromise = (async () => {
  try {
    const response = await fetch(draftUrl(), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, revision: diskRevision }),
    });
    const data = await response.json();
    if (response.status === 409) { handleFreshDisk(data.current); return; }
    if (!response.ok) throw new Error(data.error || 'Save failed');
    noteDiskBaseline(text, data.revision);
    autosaveHold = false;   // any successful save resumes the schedule
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
    savePromise = null;
    if (!savePaused && workView.state.doc.toString() !== diskText) saveToDisk();
  }
  })();
  return savePromise;
}
function save() {
  docStorage.setItem('wa-working', workView.state.doc.toString());
  liveSync?.notesChanged();
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
// Take the disk copy without touching chat or focus: the writer
// changed nothing, so there is nothing of theirs to disturb. Announced with
// a toast when it happens behind their back, silently at startup.
function adoptDiskText(current, announce = false) {
  liveSync?.close();
  workView.dispatch({ changes: { from: 0, to: workView.state.doc.length, insert: current.text } });
  noteDiskBaseline(current.text, current.revision);
  liveSync?.connect(current);
  diskHold = false; hideDriftBanner(); save();
  if (announce) notify('Reloaded from disk — it changed outside Stilura.');
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
  // disk text into .stilura-history before every write, and the browser keeps
  // its own checkpoint in History.
  noteDiskBaseline(driftCurrent.text, driftCurrent.revision);
  liveSync?.connect(driftCurrent);
  diskHold = false; hideDriftBanner(); save(); workView.focus();
});
function restoreDocument(current) {
  documentKey = 'stilura:' + current.id + ':';
  documentName = current.name ?? current.path.split(/[\\/]/).pop();
  // Capture the old baseline before installing the current disk revision.
  const driftBase = lastDiskBaseline();
  noteDiskBaseline(current.text, current.revision);
  const cached = docStorage.getItem('wa-working');
  // Normalize disk text once; cached work already has the writer's formatting.
  const opened = cached === null ? unwrapProse(current.text) : { text: cached, joined: 0 };
  openDocumentText(opened.text);
  loadingDocument = false;
  savePaused = false;
  restoreChat(); restoreNotes(); restoreBrief(); renderFileList();
  if (cached !== null) {
    const verdict = resolveDrift(workView.state.doc.toString(), current.text, driftBase?.text);
    if (verdict === 'fast-forward') adoptDiskText(current);
    else if (verdict === 'diverged') showDriftBanner(current);
  }
  else clearNotice('disk');
  if (!diskHold) liveSync.connect(current);
  if (opened.joined > 0) {
    notifyUndo(`Opened ${documentName} — ${opened.joined} wrapped ${opened.joined === 1 ? 'line' : 'lines'} joined into paragraphs. Saves go to this file.`, () => {
      workView.dispatch({ changes: { from: 0, to: workView.state.doc.length, insert: current.text } });
      save();
    });
  }
  return opened;
}
async function initializeDocument() {
  try {
    const current = await api('/draft');
    restoreDocument(current);
    editorSetReadonly(workView, false);
    saveToDisk();
  } catch (error) {
    // The try also covers restoring saved state, so a failure here is not always the network.
    console.error('[open draft]', error);
    notifyProblem({ say: 'Stilura could not open the draft.', act: 'retry', detail: error.message }, initializeDocument, 'Retry', 'disk');
  }
}
liveSync = liveDocument({
  view: workView,
  url: () => draftUrl('/live'),
  getNotes: () => marginNotes,
  readPendingNotes() {
    try { return JSON.parse(docStorage.getItem('wa-note-pending') || '[]'); } catch { return []; }
  },
  writePendingNotes: entries => docStorage.setItem('wa-note-pending', JSON.stringify(entries)),
  onSaved(current) { noteDiskBaseline(current.text, current.revision); savePaused = false; clearNotice('disk'); },
  onError(error) { notify('Synchronization paused — your local changes are kept.', { sticky: true, key: 'disk', detail: error.message, action: () => liveSync.flush().catch(error => notify(error.message)), label: 'Retry' }); },
  onConflict: showDriftBanner,
  onNotes(notes, ready) {
    if (!ready) return;
    for (const note of [...marginNotes]) {
      if (notes.some(item => item.id === note.id) || !note.text || noteCards.get(note.id)?.querySelector('textarea')) continue;
      removeNoteSilent(note.id);
    }
    for (const incoming of notes) {
      let note = marginNotes.find(item => item.id === incoming.id);
      const editing = noteCards.get(incoming.id)?.querySelector('textarea');
      if (note) Object.assign(note, incoming);
      else { note = { ...incoming }; marginNotes.push(note); }
      if (note.resolved && !note.work && !editing) {
        const card = noteCards.get(note.id);
        if (card) { railAnchors.delete(card); railHomes.delete(card); card.remove(); noteCards.delete(note.id); }
      } else if ((!note.resolved || note.work) && !noteCards.has(note.id)) noteCards.set(note.id, railAdd(noteCard(note), () => noteAnchor(note.id)));
    }
    syncNoteMarks();
    docStorage.setItem('wa-notes', JSON.stringify({ notes: marginNotes }));
  },
});
initializeDocument();
async function checkDiskDrift() {
  if (liveSync?.active) { await liveSync.flush().catch(() => {}); return; }
  if (loadingDocument || switchingDocument || saving || autosaveHold) return;
  const key = documentKey;
  try {
    const current = await api(draftUrl());
    if (key !== documentKey || switchingDocument) return;
    if (current.revision !== diskRevision) handleFreshDisk(current);
  } catch (error) { notify(`Unable to check the file on disk: ${error.message}. Your draft is kept.`, { sticky: true, key: 'disk', action: checkDiskDrift, label: 'Try again' }); }
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
  try {
  if (typeof window.showSaveFilePicker !== 'function') {
    exportText(workView.state.doc.toString(), documentName);
    return;
  }
  const handle = await window.showSaveFilePicker({
    suggestedName: documentName,
    types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown'], 'text/plain': ['.txt'] } }],
  });
  const writable = await handle.createWritable();
  await writable.write(workView.state.doc.toString());
  await writable.close();
  refreshFileList();
  workView.focus();
  } catch (error) {
    if (error.name !== 'AbortError') notify(`Unable to save a copy: ${error.message}. Your draft is unchanged.`, { sticky: true, action: () => document.getElementById('file-export').click(), label: 'Try again' });
  }
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
  } catch (error) { notify(`Unable to open ${file.name}: ${error.message}. Your draft is unchanged.`, { sticky: true, action: () => importFile(file), label: 'Try again' }); }
}
// ─── File sidebar ────────────────────────────────────────────────────────────
//
//  The header toggle owns the sidebar; every file action lives inside it.
//  Rows name the workspace Markdown and text files — opening one switches the
//  single active document (and its saves) onto that file, so what is on screen
//  is always what is being saved. Each file keeps its own browser copy, chat
//  which come back when it is opened again.
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
// saved, and its browser copy, chat waits under their own storage
// key until it is opened again.
async function switchDocument(name) {
  if (loadingDocument || switchingDocument || desktopSaving || name === documentName) { workView.focus(); return; }
  switchingDocument = true;
  editorSetReadonly(workView, true);
  for (const job of jobs) job.abort();
  cancelSuggestion();
  try {
  // Finish both the in-flight save and any newer keystrokes before switching.
  try {
    if (savePaused || diskHold) throw new Error('Resolve the draft save error or disk conflict before switching files.');
    clearTimeout(diskTimer);
    if (!autosaveHold) await flushSave();
    if (!savePaused && !diskHold && !autosaveHold) await flushSave();
    clearTimeout(diskTimer);
    saveChat(); saveNotes(); saveBrief();
    if (liveSync?.active) await liveSync.flush();
    if (savePaused || diskHold || (!autosaveHold && workView.state.doc.toString() !== diskText)) throw new Error('The draft has not been saved.');
    saveSnapshot('Before switching document');
    if (desktop) await localStorage.flush();
  } catch (error) {
    notify(`Unable to save ${documentName}: ${error.message}. The current draft stays open.`, {
      sticky: true, key: 'disk', label: 'Retry saving',
      action: diskHold ? null : () => { savePaused = false; return switchDocument(name); },
    });
    return;
  }
  autosaveHold = false;   // moving on ends the deleted-file episode
  let current;
  try {
    current = await api('/draft/open', { method: 'POST', body: JSON.stringify({ name }) });
  } catch (error) { notify(`Unable to open ${name}: ${error.message}. The current draft stays open.`, { sticky: true, action: () => switchDocument(name), label: 'Try again' }); return; }
  liveSync?.close();
  loadingDocument = true;
  for (const job of jobs) job.abort();
  cancelSuggestion();
  // Per-document UI bound to the old text goes; the old file's own state was
  // stored under its key above and is restored when it is opened again.
  chatEditCards.clear();
  clearNotice('undo');
  clearNotice('disk');
  discardNoteCards();
  positionBrief = null;
  briefSession?.controller?.abort();
  briefSession = null;
  clearPlainPreview();
  chatHistory = []; chatStream.replaceChildren();
  setChatOpen(false);   // the stream was just emptied — don't leave × over nothing
  maybeCollapseIsland();
  hideDriftBanner(); diskHold = false;
  // Retarget storage and the disk baseline onto the new file first: every
  // restore below reads under the new key.
  const opened = restoreDocument(current);
  refreshFileList();
  if (!opened.joined) notify(`Opened ${documentName}. Saves go to this file.`);
  workView.focus();
  } finally {
    switchingDocument = false;
    editorSetReadonly(workView, false);
    saveToDisk();
  }
}
const toggleSidebar = () => { setSidebar(sidebar.classList.contains('is-closed')); workView.focus(); };
sidebarToggle.addEventListener('click', toggleSidebar);
sidebarToggleSide.addEventListener('click', toggleSidebar);
// The light-dismiss for the narrow-window overlay. The scrim is the only part
// of the sidebar a click can miss, so it is the only place that needs wiring.
document.getElementById('sidebar-scrim').addEventListener('click', () => setSidebar(false));
fileFilter.addEventListener('input', renderFileList);
setSidebar(false, false);

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
  const { snapshots } = await api(draftUrl('/history'));
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
      'Last 20 disk versions and 10 browser checkpoints. Disk copies sit beside the draft in .stilura-history and are never deleted automatically.'));
  } catch (error) { list.append(chatEl('p', 'history-note', error.message)); }
});

// ─── Initial focus ─────────────────────────────────────────────────────────────

workView.scrollDOM.addEventListener('scroll', () => { hideNotePlus(); reanchorBubble(); }, { passive: true });
workView.focus();

window.addEventListener('stilura-storage-error', event => {
  notify(event.detail, { sticky: true, key: 'backup', action: () => localStorage.flush().catch(error => notify(error.message)), label: 'Retry saving' });
});
if (desktop) {
  const events = new EventSource('/api/desktop/events');
  function resumeDesktop() {
    if (!desktopSaving) return;
    desktopSaving = false;
    document.body.inert = false;
    editorSetReadonly(workView, loadingDocument || switchingDocument);
  }
  events.onerror = resumeDesktop;
  events.onmessage = async event => {
    const message = JSON.parse(event.data);
    if (message.type === 'resume') { resumeDesktop(); return; }
    if (message.type !== 'flush') return;
    let error = '';
    try {
      if (loadingDocument || switchingDocument) throw new Error('Wait for the document to finish opening.');
      document.activeElement?.blur();
      desktopSaving = true;
      document.body.inert = true;
      editorSetReadonly(workView, true);
      stopJobs();
      clearTimeout(diskTimer);
      if (savePaused || diskHold) throw new Error('Resolve the draft save error or disk conflict before closing.');
      await flushSave();
      // A save already in flight may have contained the previous keystroke.
      if (!savePaused && !diskHold) await flushSave();
      if (savePaused || diskHold || workView.state.doc.toString() !== diskText) throw new Error('The draft has not been saved.');
      await localStorage.flush();
    } catch (cause) { error = cause.message; resumeDesktop(); }
    try {
      await api('/api/desktop/flushed', { method: 'POST', body: JSON.stringify({ id: message.id, ok: !error, error }) });
    } catch (cause) { resumeDesktop(); notify(cause.message, { sticky: true }); }
  };
}
}
main().catch(error => {
  console.error(error);
  const notice = document.createElement('p');
  notice.textContent = `Stilura could not open: ${error.message} Reload to retry.`;
  notice.setAttribute('role', 'alert');
  document.body.prepend(notice);
});
