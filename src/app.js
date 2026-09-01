// src/app.js — Writing Assistant frontend (CodeMirror 6)

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

// ─── Elements ──────────────────────────────────────────────────────────────────

const contextEl     = document.getElementById('context');
const paneCtx       = document.getElementById('pane-context');
const editorWrap    = document.getElementById('editor-wrapper');
const dividerEl     = document.getElementById('divider');
const contextToggle = document.getElementById('context-toggle');
const popover       = document.getElementById('popover');
const popInput      = document.getElementById('popover-input');
const popVars       = document.getElementById('popover-variants');
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

// ─── Context pane collapse ─────────────────────────────────────────────────────

function setCollapsed(collapsed) {
  paneCtx.classList.toggle('collapsed', collapsed);
  localStorage.setItem('wa-ctx-collapsed', collapsed ? '1' : '');
}

if (localStorage.getItem('wa-ctx-collapsed')) setCollapsed(true);

contextToggle.addEventListener('click', e => {
  e.stopPropagation();
  setCollapsed(true);
});
paneCtx.addEventListener('click', () => {
  if (paneCtx.classList.contains('collapsed')) setCollapsed(false);
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
    const span = document.createElement('span');
    span.className   = 'cm-ghost';
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
    if (tr.docChanged) return null;  // typing → clear
    if (tr.selection)  return null;  // cursor moved → clear
    for (const e of tr.effects) {
      if (e.is(setGhostFx))   return e.value;   // { text, pos }
      if (e.is(clearGhostFx)) return null;
    }
    return val;
  },

  // Render ghost widget right after the cursor
  provide: f => EditorView.decorations.from(f, ghost => {
    if (!ghost) return Decoration.none;
    const w = Decoration.widget({ widget: new GhostWidget(ghost.text), side: 1 });
    return Decoration.set([w.range(ghost.pos)]);
  }),
});

function ghostShow(view, text) {
  const pos = view.state.selection.main.head;
  view.dispatch({ effects: setGhostFx.of({ text, pos }) });
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

// ─── Suggestion system ─────────────────────────────────────────────────────────

let suggestTimer = null;
let suggestAbort = null;

const SUGGEST_DELAY = 900;  // ms after last keystroke
const SUGGEST_MIN   = 15;   // minimum doc length before suggesting

function suggestSchedule() {
  clearTimeout(suggestTimer);
  if (suggestAbort) { suggestAbort.abort(); suggestAbort = null; }

  const doc = workView.state.doc.toString();
  if (doc.trim().length < SUGGEST_MIN) return;

  suggestTimer = setTimeout(suggestFetch, SUGGEST_DELAY);
}

async function suggestFetch() {
  const view  = workView;
  const state = view.state;
  if (state.readOnly) return;

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
        context:  contextEl.value,
        document: doc,
        cursor:   pos,
        agent:    currentAgent(),
      }),
      signal: suggestAbort.signal,
    });
    if (!res.ok) { console.error('[suggest] server error', res.status); return; }

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
        context:  contextEl.value,
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

// ─── Rewrite popover ───────────────────────────────────────────────────────────

let savedSel = null; // { from, to, text }
let instructionHistory = JSON.parse(localStorage.getItem('wa-instructions') || '[]');

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function saveInstruction(text) {
  if (!text.trim()) return;
  instructionHistory = instructionHistory.filter(h => h !== text);
  instructionHistory.unshift(text);
  instructionHistory = instructionHistory.slice(0, 50);
  localStorage.setItem('wa-instructions', JSON.stringify(instructionHistory));
}

function updateHistoryDisplay(filter = '') {
  popVars.innerHTML = '';
  if (!filter) return;
  const filtered = instructionHistory.filter(h =>
    h.toLowerCase().includes(filter.toLowerCase())
  );
  if (filtered.length === 0) {
    popVars.innerHTML = '<div class="history-empty">new idea…</div>';
  } else {
    filtered.forEach(h => {
      const item = document.createElement('div');
      item.className = 'history-item';
      item.textContent = h;
      item.addEventListener('click', () => { popInput.value = h; generate(); });
      popVars.appendChild(item);
    });
  }
}

function openPopover(x, y) {
  popover.classList.remove('hidden');
  popInput.value    = '';
  popVars.innerHTML = '';

  const pw = 380, gap = 10;
  const vw = window.innerWidth, vh = window.innerHeight;
  const ph = popover.offsetHeight || 52;

  let left = x - pw / 2;
  let top  = y - ph - gap;
  if (left + pw > vw - 8) left = vw - pw - 8;
  if (left < 8)  left = 8;
  if (top  < 8)  top  = y + gap;

  popover.style.left = `${left}px`;
  popover.style.top  = `${top}px`;
}

function closePopover() {
  popover.classList.add('hidden');
  savedSel = null;
}

function replaceSelection(text) {
  if (!savedSel) return;
  const { from, to } = savedSel;
  workView.dispatch({
    changes:   { from, to, insert: text },
    selection: { anchor: from + text.length },
  });
  workView.focus();
  save();
}

async function generate() {
  if (!savedSel) return;
  const instruction = popInput.value.trim();
  saveInstruction(instruction);

  popVars.innerHTML = `
    <div class="spinner">
      <div class="spinner-icon"></div>
      Generating variants…
    </div>`;

  try {
    const res = await fetch('/rewrite', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        context:     contextEl.value,
        document:    workView.state.doc.toString(),
        selected:    savedSel.text,
        instruction,
        agent:        currentAgent(),
      }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `Server error ${res.status}`);

    popVars.innerHTML = '';
    data.variants.forEach((v, i) => {
      const card = document.createElement('div');
      card.className = 'variant-card';
      card.innerHTML = `<div class="variant-label">Option ${i + 1}</div><div>${escHtml(v)}</div>`;
      card.addEventListener('click', () => { replaceSelection(v); closePopover(); });
      popVars.appendChild(card);
    });

    const rect = popover.getBoundingClientRect();
    if (rect.bottom > window.innerHeight - 8) {
      const newTop = Math.max(8, parseInt(popover.style.top) - (rect.bottom - window.innerHeight + 8));
      popover.style.top = `${newTop}px`;
    }
  } catch (err) {
    console.error('[/rewrite]', err);
    popVars.innerHTML = `<div class="error-msg">Error: ${escHtml(err.message)}</div>`;
  }
}

// Popover event wiring
popover.addEventListener('mousedown', e => {
  if (e.target !== popInput) e.preventDefault();
});

document.addEventListener('keydown', e => {
  if (popover.classList.contains('hidden')) return;
  if (document.activeElement === popInput) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  if (e.key === 'Backspace') {
    popInput.value = popInput.value.slice(0, -1);
    updateHistoryDisplay(popInput.value);
    e.preventDefault();
  } else if (e.key.length === 1) {
    popInput.value += e.key;
    updateHistoryDisplay(popInput.value);
    e.preventDefault();
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closePopover(); return; }
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    if (!popover.classList.contains('hidden')) { e.preventDefault(); generate(); }
  }
});

document.addEventListener('mousedown', e => {
  if (!popover.classList.contains('hidden') && !popover.contains(e.target)) closePopover();
});

popInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); generate(); }
});
popInput.addEventListener('input', () => updateHistoryDisplay(popInput.value));

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

  // ── Ghost text ─────────────────────────────────────────────────────────────
  //
  //  Rendered as a non-editable <span> injected after the cursor by the
  //  GhostWidget.  Muted colour + slightly lower opacity signals "not yours
  //  yet".  Press Tab to make it real, Escape to dismiss.
  //
  '.cm-ghost': {
    color:         'var(--muted)',
    opacity:       '0.6',
    pointerEvents: 'none',
    userSelect:    'none',
    fontStyle:     'normal',
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

      // Read-only compartment — toggled during /idea streaming
      readonlyComp.of(EditorState.readOnly.of(false)),

      // Word wrap (essential for prose)
      EditorView.lineWrapping,

      // Placeholder shown when document is empty
      placeholder('Start writing...'),

      // Visual theme
      editorTheme,

      // Right-click with selection → rewrite popover
      EditorView.domEventHandlers({
        contextmenu(event, view) {
          const sel = view.state.selection.main;
          if (sel.empty) return false; // no selection — show native menu
          event.preventDefault();
          savedSel = {
            from: sel.from,
            to:   sel.to,
            text: view.state.sliceDoc(sel.from, sel.to),
          };
          openPopover(event.clientX, event.clientY);
          return true;
        },
      }),

      // Save on every edit + schedule a suggestion
      EditorView.updateListener.of(update => {
        if (update.docChanged) {
          save();
          suggestSchedule();
        }
      }),
    ],
  }),

  parent: editorWrap,
});

// ─── Persist ───────────────────────────────────────────────────────────────────

function save() {
  localStorage.setItem('wa-working', workView.state.doc.toString());
  localStorage.setItem('wa-context', contextEl.value);
}

contextEl.addEventListener('input', save);

// ─── Resizable divider ─────────────────────────────────────────────────────────

let dragging = false, dragStartX = 0, dragStartW = 0;

dividerEl.addEventListener('mousedown', e => {
  dragging   = true;
  dragStartX = e.clientX;
  dragStartW = paneCtx.offsetWidth;
  dividerEl.classList.add('dragging');
  document.body.style.cursor     = 'col-resize';
  document.body.style.userSelect = 'none';
});

document.addEventListener('mousemove', e => {
  if (!dragging) return;
  const dx    = e.clientX - dragStartX;
  const total = document.querySelector('.app').offsetWidth - dividerEl.offsetWidth;
  const newW  = Math.max(180, Math.min(total - 180, dragStartW + dx));
  paneCtx.style.flex  = 'none';
  paneCtx.style.width = `${newW}px`;
});

document.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  dividerEl.classList.remove('dragging');
  document.body.style.cursor = document.body.style.userSelect = '';
});

// ─── Initial focus ─────────────────────────────────────────────────────────────

workView.focus();
