(async () => {
  if (document.documentElement.dataset.stiluraExtension) return;
  document.documentElement.dataset.stiluraExtension = '1';
  const { SUGGEST_DELAY, SUGGEST_MIN, paragraphEnd, slashCommand, ghostRemainder, distinctVariants } = await import(chrome.runtime.getURL('writing-rules.js'));
  let review = null, fallback = null, armed = null, dismissed = null, pausedUntil = 0;
  let config = {}, field = null, timer, scheduled = null, port = null, target = null, actionType = '', suggestion = '', composing = false;
  const host = document.createElement('stilura-assistant');
  host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host{font:14px/1.45 system-ui,sans-serif;color:#253026;color-scheme:light}
    *{box-sizing:border-box} [hidden]{display:none!important}
    .panel{font:14px/1.45 system-ui,sans-serif;color:#253026;position:fixed;pointer-events:auto;max-width:calc(100vw - 16px);width:max-content;max-height:50vh;overflow:auto;background:#fbfcf9;border:1px solid #c6cebf;border-radius:10px;box-shadow:0 6px 28px #14200f24;padding:8px;}
    .row{display:flex;gap:6px;align-items:center}.brand{font-size:12px;font-weight:650;padding:0 5px;color:#4a6045}
    button{font:inherit;font-size:13px;line-height:1.4;background:#eef2e9;color:#253026;border:1px solid transparent;border-radius:6px;padding:6px 9px;cursor:pointer;min-height:32px;}
    button:hover{background:#e1ead9}button:focus-visible,input:focus-visible{outline:2px solid #376bcc;outline-offset:2px}
    button:disabled{opacity:.55;cursor:wait}.primary{background:#294c36;color:#fff}.primary:hover{background:#365f44}
    input{font:inherit;min-width:160px;width:100%;border:1px solid #bac5b4;border-radius:6px;padding:7px;background:white;color:#253026;margin:6px 0;}
    .body{width:320px;max-width:calc(100vw - 34px)}.preview{white-space:pre-wrap;overflow-wrap:anywhere;max-height:220px;overflow:auto;margin:6px 0;padding:8px;background:#f0f3ec;border-radius:6px;}
    .variant{display:block;text-align:left;width:100%;white-space:pre-wrap;margin:5px 0}
    .status{font-size:12px;max-width:320px;white-space:pre-wrap;overflow-wrap:anywhere;padding:4px 5px;color:#4a6045}
    .ghost{position:fixed;pointer-events:none;color:#64735e;white-space:pre-wrap;overflow-wrap:break-word;overflow:hidden;}
    .sr{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip-path:inset(50%)}
  `;
  const panel = document.createElement('section'); panel.className = 'panel'; panel.hidden = true; panel.setAttribute('aria-label', 'Stilura writing assistant');
  const ghost = document.createElement('div'); ghost.className = 'ghost'; ghost.hidden = true; ghost.setAttribute('aria-hidden', 'true');
  const live = document.createElement('div'); live.className = 'sr'; live.setAttribute('role', 'status');
  shadow.append(style, panel, ghost, live);
  document.documentElement.append(host);

  async function refresh() {
    try { config = (await chrome.runtime.sendMessage({ type: 'settings' })).data ?? {}; }
    catch { config = {}; }
    if (!config.enabled || !config.connected) cancel();
  }
  chrome.runtime.onMessage.addListener(message => { if (message.type === 'settings-changed') { cancel(); void refresh(); } });
  void refresh();

  function editable(node) {
    if (!(node instanceof Element) || host.contains(node)) return null;
    let el = node.closest('textarea,input,[contenteditable]');
    if (!el || el.closest('.cm-editor,.monaco-editor,.ProseMirror,[data-slate-editor],[data-lexical-editor]')) return null;
    if (el instanceof HTMLInputElement && !['text', 'search', 'url', 'tel'].includes(el.type)) return null;
    if (el.disabled || el.readOnly || el.getAttribute('aria-readonly') === 'true' || el.getAttribute('aria-disabled') === 'true') return null;
    if (/(password|one-time-code|cc-)/i.test(el.getAttribute('autocomplete') ?? '')) return null;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
      if (!el.isContentEditable) return null;
      while (el.parentElement?.isContentEditable) el = el.parentElement;
      if (el.querySelector('[contenteditable="false"],img,video,table')) return null;
    }
    return el;
  }

  // Text and DOM boundaries share one projection, including paragraph breaks.
  function model(el) {
    if ('value' in el) return { text: el.value };
    let text = ''; const spans = [];
    const add = (value, start, end) => { spans.push({ from: text.length, to: text.length + value.length, start, end }); text += value; };
    const block = node => node.nodeType === 1 && /^(DIV|P|LI|UL|OL|BLOCKQUOTE|H[1-6]|PRE)$/.test(node.tagName);
    function walk(parent) {
      [...parent.childNodes].forEach((node, index) => {
        const before = [parent, index], after = [parent, index + 1];
        if (node.nodeType === 3) { if (node.length) add(node.data, [node, 0], [node, node.length]); return; }
        if (node.nodeType !== 1) return;
        if (node.tagName === 'BR') { add('\n', before, after); return; }
        if (block(node) && text && !text.endsWith('\n')) add('\n', before, before);
        walk(node);
        if (block(node) && node.nextSibling && !text.endsWith('\n')) add('\n', after, after);
      });
    }
    walk(el);
    const point = offset => {
      for (const span of spans) {
        if (offset <= span.to) return span.start[0].nodeType === 3
          ? [span.start[0], Math.max(0, offset - span.from)] : (offset <= span.from ? span.start : span.end);
      }
      return [el, el.childNodes.length];
    };
    const offset = (node, at) => {
      const position = document.createRange(); position.setStart(node, at); position.collapse(true);
      const boundary = document.createRange();
      for (const span of spans) {
        if (span.start[0] === node && node.nodeType === 3) return span.from + at;
        boundary.setStart(...span.start); boundary.collapse(true);
        if (boundary.compareBoundaryPoints(Range.START_TO_START, position) >= 0) return span.from;
        boundary.setStart(...span.end); boundary.collapse(true);
        if (boundary.compareBoundaryPoints(Range.START_TO_START, position) > 0) return span.to;
      }
      return text.length;
    };
    return { text, point, offset };
  }

  function snapshot(el = field) {
    if (!el?.isConnected || editable(el) !== el) return null;
    const doc = model(el);
    if (doc.text.length > 60000) return null;
    let from, to;
    if ('value' in el) { from = el.selectionStart; to = el.selectionEnd; }
    else {
      const selection = document.getSelection();
      if (!selection?.rangeCount) return null;
      const range = selection.getRangeAt(0);
      if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) return null;
      from = doc.offset(range.startContainer, range.startOffset); to = doc.offset(range.endContainer, range.endOffset);
    }
    if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
    return { el, document: doc.text, from, to };
  }
  function unchanged(saved) { return saved?.el.isConnected && editable(saved.el) === saved.el && model(saved.el).text === saved.document; }
  function announce(text) { live.textContent = text; }
  function cancel() {
    clearTimeout(timer); timer = null; scheduled = null;
    const previous = port; port = null; previous?.disconnect(); target = null; actionType = ''; suggestion = ''; review = null; fallback = null; armed = null;
    panel.hidden = true; ghost.hidden = true; ghost.replaceChildren();
  }
  function button(label, action, primary = false) {
    const el = document.createElement('button'); el.type = 'button'; el.textContent = label;
    if (primary) el.className = 'primary';
    el.addEventListener('click', event => { if (event.isTrusted) action(event); }); return el;
  }
  function caretBox(saved) {
    const el = saved.el, box = el.getBoundingClientRect();
    if (!('value' in el)) {
      const range = document.createRange(); range.setStart(...model(el).point(saved.from)); range.collapse(true);
      const caret = range.getBoundingClientRect();
      return caret.height ? caret : box;
    }
    // shortcut: native controls use an anchored preview; true inline replacement needs an editor-specific adapter.
    const mirror = document.createElement('div'), css = getComputedStyle(el);
    for (const property of ['font', 'lineHeight', 'letterSpacing', 'wordSpacing', 'textIndent', 'textAlign', 'direction', 'tabSize', 'padding', 'border', 'boxSizing', 'overflowWrap']) mirror.style[property] = css[property];
    Object.assign(mirror.style, { position: 'fixed', visibility: 'hidden', left: box.left - el.scrollLeft + 'px', top: box.top - el.scrollTop + 'px', width: el.offsetWidth + 'px', whiteSpace: el instanceof HTMLInputElement ? 'pre' : 'pre-wrap' });
    mirror.textContent = saved.document.slice(0, saved.from);
    const marker = document.createElement('span'); marker.textContent = '\u200b'; mirror.append(marker); shadow.append(mirror);
    const caret = marker.getBoundingClientRect(); mirror.remove();
    return { left: Math.max(box.left, Math.min(caret.left, box.right)), top: Math.max(box.top, caret.top), bottom: Math.min(box.bottom, caret.bottom) };
  }
  function position() {
    if (!field?.isConnected) return cancel();
    const box = field.getBoundingClientRect();
    if (box.bottom < 0 || box.top > innerHeight || box.right < 0 || box.left > innerWidth) { panel.hidden = true; ghost.hidden = true; return; }
    const saved = target || slash(snapshot()) || snapshot();
    const anchor = saved ? caretBox(saved) : box;
    const width = panel.offsetWidth || 320, height = panel.offsetHeight || 42;
    panel.style.left = Math.max(8, Math.min(anchor.left, innerWidth - width - 8)) + 'px';
    panel.style.top = Math.max(8, anchor.bottom + height + 8 <= innerHeight ? anchor.bottom + 5 : anchor.top - height - 5) + 'px';
    if (suggestion && target) drawGhost(target, suggestion);
  }
  function frame(message = '') {
    panel.replaceChildren(); panel.hidden = false;
    const row = document.createElement('div'); row.className = 'row';
    const brand = document.createElement('span'); brand.className = 'brand'; brand.textContent = 'Stilura';
    row.append(brand); panel.append(row);
    if (message) { const status = document.createElement('div'); status.className = 'status'; status.textContent = message; panel.append(status); announce(message); }
    row.append(button('Close', () => { const el = field; cancel(); el?.focus({ preventScroll: true }); }));
    position(); return row;
  }
  function error(message) { frame(message); position(); }
  function slash(saved) {
    if (!saved || saved.from !== saved.to) return null;
    const start = saved.document.lastIndexOf('\n', saved.from - 1) + 1;
    const end = saved.document.indexOf('\n', saved.from);
    if ((end !== -1 && end !== saved.from) || (end === -1 && saved.from !== saved.document.length)) return null;
    const command = slashCommand(saved.document.slice(start, saved.from), start);
    return command ? { ...saved, ...command } : null;
  }
  function toolbar() {
    if (!config.enabled || !config.connected || composing || port || target) return;
    const saved = snapshot();
    if (!saved || (dismissed?.el === saved.el && dismissed.document === saved.document && dismissed.from === saved.from && dismissed.to === saved.to)) return;
    const command = slash(saved);
    if (saved.from !== saved.to) {
      const row = frame(); row.prepend(button('Rewrite', () => rewrite(saved), true));
    } else if (command) {
      const active = armed?.el === saved.el && armed.from === command.from;
      const row = frame(active ? 'Enter to generate · Escape to dismiss' : '⌘/Ctrl + Enter to generate');
      const generateButton = button('Generate', () => generate(command), true); generateButton.disabled = !command.instruction;
      row.prepend(generateButton);
    } else panel.hidden = true;
    position();
  }

  function apply(saved, value) {
    if (!unchanged(saved)) { cancel(); error('The field changed. Select the text and try again.'); return; }
    if (saved.el instanceof HTMLInputElement) value = value.replace(/[\r\n]+/g, ' ');
    if (saved.el.maxLength >= 0 && saved.document.length - (saved.to - saved.from) + value.length > saved.el.maxLength) {
      cancel(); error(`This replacement exceeds the field's ${saved.el.maxLength}-character limit.`); return;
    }
    const el = saved.el; cancel(); field = el; el.focus({ preventScroll: true });
    if ('value' in el) el.setSelectionRange(saved.from, saved.to);
    else {
      const doc = model(el), range = document.createRange();
      range.setStart(...doc.point(saved.from)); range.setEnd(...doc.point(saved.to));
      const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    }
    // execCommand preserves Chrome's native undo and dispatches trusted input events.
    const inserted = document.execCommand('insertText', false, value);
    clearTimeout(timer);
    if (!inserted) { error('This editor did not accept the replacement. Use a plain text field.'); return; }
    announce('Text inserted. Undo restores the original text.');
    panel.hidden = true;
  }
  function focusEnd(saved) {
    saved.el.focus({ preventScroll: true });
    if ('value' in saved.el) saved.el.setSelectionRange(saved.to, saved.to);
    else {
      const range = document.createRange(); range.setStart(...model(saved.el).point(saved.to)); range.collapse(true);
      const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    }
  }
  function run(action, saved, body, receive, previous = null) {
    cancel(); target = saved; actionType = action; fallback = previous;
    if (action !== 'suggest') {
      frame('Writing… Escape cancels.');
      if (previous) previewText(previous.variants[previous.index]);
    }
    const failed = message => {
      const kept = fallback; cancel();
      if (kept && unchanged(saved)) present(kept, message + ' Previous suggestion kept.');
      else if (action === 'suggest' && !body.manual) { pausedUntil = Date.now() + 60000; announce(message); }
      else error(message);
    };
    const connection = chrome.runtime.connect({ name: 'stilura-action' }); port = connection;
    connection.onMessage.addListener(message => {
      if (port !== connection) return;
      if (!unchanged(saved)) { cancel(); return; }
      if (message.error) { failed(message.error); return; }
      try { receive(message); } catch (problem) { failed(problem.message); return; }
      if (message.done && port === connection) { port = null; fallback = null; connection.disconnect(); }
    });
    connection.onDisconnect.addListener(() => {
      if (port !== connection) return;
      failed(chrome.runtime.lastError?.message || 'Connection interrupted. Open Stilura settings and reconnect.');
    });
    connection.postMessage({ action, body: { document: saved.document, ...body } });
  }
  function previewText(text) {
    let preview = panel.querySelector('.preview');
    if (!preview) { preview = document.createElement('div'); preview.className = 'preview body'; panel.append(preview); }
    preview.textContent = text; position();
  }
  function present(candidate, message = '') {
    review = candidate; target = candidate.saved; actionType = candidate.action;
    const row = frame(message || 'Tab accepts · R regenerates · Esc dismisses');
    row.prepend(button('Accept', () => apply(candidate.saved, candidate.variants[candidate.index]), true), button('Regenerate', regenerate));
    previewText(candidate.variants[candidate.index]);
    if (candidate.variants.length > 1) {
      const controls = document.createElement('div'); controls.className = 'row';
      const count = document.createElement('span'); count.textContent = `${candidate.index + 1} / ${candidate.variants.length}`; count.className = 'status';
      controls.append(button('Previous variant', () => cycle(-1)), count, button('Next variant', () => cycle(1))); panel.append(controls);
    }
    if (candidate.answer) { const answer = document.createElement('div'); answer.className = 'status'; answer.textContent = candidate.answer; panel.append(answer); }
    position(); focusEnd(candidate.saved);
  }
  function cycle(step) {
    if (!review) return;
    review.index = (review.index + step + review.variants.length) % review.variants.length; present(review);
  }
  function regenerate() {
    if (!review || port) return;
    const previous = review;
    if (previous.action === 'write') generate(previous.saved, previous);
    else ask(previous.saved, previous.instruction, previous);
  }
  function ask(saved, instruction, previous = null) {
    const previousText = previous?.variants[previous.index];
    let request = instruction;
    if (previousText) request += `\nReplace the previous candidate with different wording, preserving the request and facts. Previous candidate:\n${previousText}`;
    focusEnd(saved);
    run('ask', saved, { selected: saved.document.slice(saved.from, saved.to), from: saved.from, instruction: request }, message => {
      if (!message.done) return;
      const data = message.data;
      if (!data.variants?.length) {
        if (!data.answer?.trim()) throw Error('The model returned no answer.');
        if (previous) { present(previous, data.answer); return; }
        frame(data.answer); focusEnd(saved); return;
      }
      const variants = distinctVariants(data.variants, saved.document.slice(saved.from, saved.to), previousText);
      present({ saved, action: 'ask', instruction, variants, index: 0, answer: data.answer });
    }, previous);
  }
  function rewrite(saved) {
    cancel(); target = saved; frame();
    const body = document.createElement('form'); body.className = 'body';
    const label = document.createElement('label'); label.textContent = 'How should it change?';
    const input = document.createElement('input'); input.placeholder = 'Rewrite, shorten, explain, give synonyms…'; input.maxLength = 4000; input.required = true; label.append(input);
    const submit = button('Send request', () => {}, true); submit.type = 'submit';
    body.append(label, submit); panel.append(body); position(); input.focus();
    body.addEventListener('submit', event => {
      event.preventDefault(); if (input.value.trim()) ask(saved, input.value.trim());
    });
  }
  function generate(saved, previous = null) {
    if (!saved.instruction) return;
    focusEnd(saved);
    run('write', saved, { from: saved.from, cursor: saved.to, instruction: saved.instruction, previous: previous?.variants[previous.index] }, message => {
      previewText(message.text ?? message.data?.text ?? '');
      if (message.done) present({ saved, action: 'write', variants: [message.data.text], index: 0 });
    }, previous);
  }
  function drawGhost(saved, text) {
    ghost.replaceChildren(); ghost.hidden = false;
    const el = saved.el, box = el.getBoundingClientRect(), css = getComputedStyle(el);
    ghost.style.cssText = '';
    for (const property of ['font', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'wordSpacing', 'textIndent', 'textTransform', 'textAlign', 'direction', 'tabSize']) ghost.style[property] = css[property];
    if ('value' in el) {
      Object.assign(ghost.style, { left: box.left + 'px', top: box.top + 'px', width: box.width + 'px', height: box.height + 'px', padding: css.padding, border: `${css.borderTopWidth} solid transparent`, boxSizing: 'border-box', whiteSpace: el instanceof HTMLInputElement ? 'pre' : 'pre-wrap', overflowWrap: 'break-word' });
      const mirror = document.createElement('div');
      mirror.style.transform = `translate(${-el.scrollLeft}px, ${-el.scrollTop}px)`;
      const prefix = document.createElement('span'); prefix.style.color = 'transparent'; prefix.textContent = saved.document.slice(0, saved.to);
      const continuation = document.createElement('span'); continuation.textContent = text;
      mirror.append(prefix, continuation); ghost.append(mirror);
    } else {
      const range = document.createRange(), doc = model(el); range.setStart(...doc.point(saved.to)); range.collapse(true);
      const caret = range.getBoundingClientRect();
      Object.assign(ghost.style, { left: (caret.width || caret.height ? caret.left : box.left) + 'px', top: (caret.height ? caret.top : box.top) + 'px', maxWidth: Math.max(80, box.right - caret.left) + 'px', maxHeight: Math.max(30, innerHeight - caret.top) + 'px' });
      ghost.textContent = text;
    }
  }
  function suggest(saved, manual = false) {
    if (!saved || saved.from !== saved.to || slash(saved) || !saved.document.trim() || !paragraphEnd(saved.document, saved.to)) return;
    run('suggest', saved, { cursor: saved.to, manual }, message => {
      if (!message.done) return;
      const now = snapshot(saved.el);
      if (!now || now.from !== saved.from || now.to !== saved.to) { cancel(); return; }
      suggestion = message.data.suggestion || '';
      if (!suggestion) { cancel(); return; }
      drawGhost(saved, suggestion); position(); announce(`Suggestion: ${suggestion}. Tab accepts; Escape dismisses.`);
    });
  }
  function scheduleSuggestion() {
    clearTimeout(timer); scheduled = null;
    if (!config.enabled || !config.connected || !config.suggestions || composing || port || target || Date.now() < pausedUntil) return;
    const saved = snapshot();
    if (!saved || saved.from !== saved.to || saved.document.trim().length < SUGGEST_MIN || !paragraphEnd(saved.document, saved.to) || slash(saved)) return;
    scheduled = saved;
    timer = setTimeout(() => { scheduled = null; if (unchanged(saved) && document.hasFocus()) suggest(saved); }, SUGGEST_DELAY);
  }
  document.addEventListener('focusin', event => {
    if (event.composedPath().includes(host)) return;
    const next = editable(event.composedPath()[0]);
    if (next !== field) cancel();
    field = next; if (field) toolbar();
  }, true);
  document.addEventListener('input', event => {
    if (event.composedPath().includes(host)) return;
    const next = editable(event.composedPath()[0]);
    if (!next) return;
    const now = snapshot(next), oldArmed = armed;
    if (event.isTrusted && event.inputType === 'insertText' && !event.isComposing && suggestion && target?.el === next && now?.from === now?.to) {
      const typed = now.document.slice(target.to, now.to), rest = ghostRemainder(suggestion, typed);
      if (rest !== null && now.document === target.document.slice(0, target.to) + typed + target.document.slice(target.to)) {
        if (rest) { target = now; suggestion = rest; drawGhost(now, rest); } else cancel();
        return;
      }
    }
    cancel(); dismissed = null; field = next;
    const command = slash(now);
    if (event.isTrusted && command && ((event.inputType === 'insertText' && event.data === '/') || (oldArmed?.el === next && oldArmed.from === command.from))) armed = { el: next, from: command.from };
    toolbar();
    if (event.isTrusted && !event.isComposing) scheduleSuggestion();
  }, true);
  document.addEventListener('selectionchange', () => {
    if (shadow.activeElement) return;
    const saved = snapshot();
    if (target && (!saved || saved.el !== target.el || saved.document !== target.document || saved.from !== (['write', 'ask'].includes(actionType) ? target.to : target.from) || saved.to !== target.to)) cancel();
    if (scheduled && (!saved || saved.el !== scheduled.el || saved.from !== scheduled.from || saved.to !== scheduled.to)) { clearTimeout(timer); scheduled = null; }
    toolbar();
  });
  document.addEventListener('keydown', event => {
    if (!event.isTrusted || !config.enabled || event.isComposing || composing) return;
    const consume = () => { event.preventDefault(); event.stopImmediatePropagation(); };
    if (event.key === 'Escape' && (!panel.hidden || port || suggestion)) {
      consume(); const el = field, kept = fallback; dismissed = snapshot(); cancel();
      if (kept && unchanged(kept.saved)) present(kept); else el?.focus({ preventScroll: true });
      return;
    }
    if (event.composedPath().includes(host)) return;
    field = editable(event.composedPath()[0]); if (!field) return;
    if (!event.shiftKey && !event.ctrlKey && !event.metaKey) {
      if (event.key === 'Tab' && !event.altKey && target && (suggestion || review)) { consume(); apply(target, suggestion || review.variants[review.index]); return; }
      if (review && !port) {
        if ((event.key.toLowerCase() === 'r' && !event.altKey) || (event.key === 'Enter' && event.altKey)) { consume(); regenerate(); return; }
        if (['ArrowUp', 'ArrowDown'].includes(event.key) && !event.altKey && review.variants.length > 1) { consume(); cycle(event.key === 'ArrowUp' ? -1 : 1); return; }
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
      const saved = snapshot(), command = slash(saved);
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier || (command?.instruction && armed?.el === field && armed.from === command.from)) {
        if (!saved) return;
        if (!command && saved.from === saved.to && !paragraphEnd(saved.document, saved.to)) return;
        consume();
        if (!config.connected) { error('Connect to Stilura from the Chrome toolbar first.'); return; }
        if (command) generate(command); else if (saved.from !== saved.to) rewrite(saved); else suggest(saved, true);
      }
    }
  }, true);
  document.addEventListener('compositionstart', event => { if (editable(event.composedPath()[0])) { composing = true; cancel(); } }, true);
  document.addEventListener('compositionend', event => { composing = false; if (event.isTrusted) scheduleSuggestion(); });
  document.addEventListener('pointerdown', event => {
    if (event.composedPath().includes(host)) return;
    if (!editable(event.composedPath()[0])) { cancel(); field = null; }
  }, true);
  window.addEventListener('blur', cancel);
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); });
  document.addEventListener('scroll', () => { if (!panel.hidden || suggestion) position(); }, true);
  window.addEventListener('resize', position);
})().catch(error => console.warn('Stilura could not initialize:', error.message));
