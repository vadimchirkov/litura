import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const puppeteer = require(process.env.PUPPETEER_MODULE || 'puppeteer');
const browser = await puppeteer.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
try {
  const page = await browser.newPage();
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  await page.setContent(html);
  await page.addStyleTag({ content: fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8') });
  for (const width of [390, 1100]) {
    await page.setViewport({ width, height: 800 });
    for (const collapsed of [true, false]) for (const notice of [true, false]) {
      const state = await page.evaluate(({ collapsed, notice }) => {
        const chat = document.getElementById('chat');
        chat.classList.toggle('is-collapsed', collapsed);
        chat.classList.toggle('has-notice', notice);
        const stream = document.getElementById('chat-stream');
        stream.hidden = false;
        stream.textContent = 'Restored conversation or a late reply';
        const feedback = document.getElementById('edit-feedback');
        feedback.hidden = !notice;
        feedback.textContent = 'Undo';
        return { panel: getComputedStyle(chat).display,
          conversation: getComputedStyle(stream).display,
          background: getComputedStyle(chat, '::before').display,
          pill: getComputedStyle(document.getElementById('chat-pill')).display,
          composer: getComputedStyle(chat.querySelector('.chat-composer')).display,
          toggle: getComputedStyle(document.getElementById('chat-clear')).display,
          noticeInside: chat.contains(feedback),
          notice: getComputedStyle(feedback).display };
      }, { collapsed, notice });
      assert.equal(state.conversation, 'none', 'History and late replies must stay hidden');
      assert.equal(state.background, 'none', 'Conversation background must stay hidden');
      assert.equal(state.pill, 'none', 'Conversation launcher must stay hidden');
      assert.equal(state.composer, 'none');
      assert.equal(state.toggle, 'none');
      assert.equal(state.noticeInside, true, 'Notices must remain inside their positioning container');
      if (notice) {
        assert.notEqual(state.panel, 'none');
        assert.notEqual(state.notice, 'none', 'Undo and error notices must remain visible');
      } else assert.equal(state.panel, 'none');
    }
  }
  const source = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  await page.addScriptTag({ content: `
    const chatPanel = document.getElementById('chat');
    const chatInput = document.getElementById('chat-input');
    const editFeedback = document.getElementById('edit-feedback');
    const noticeLive = document.getElementById('notice-live');
    const chatEl = (tag, className, text) => Object.assign(document.createElement(tag), { className, textContent: text });
    const hydrateIcons = () => {};
    const syncPill = () => {};
    let suggestWorking = '', openedSettings = '';
    const openSettings = tab => { openedSettings = tab; };
    const workView = { focus() {} };
    ${source.slice(source.indexOf('const NOTICE_MS ='), source.indexOf('let tabId;'))}
    let generationJob = null, documentKey = 'test', loadingDocument = false, savePaused = false;
    const generationField = {}, jobs = new Set();
    const startJob = () => { const job = new AbortController(); jobs.add(job); return job; };
    const finishJob = job => jobs.delete(job);
    const ensureAgent = async () => true, cancelSuggestion = () => {};
    const currentAgent = () => ({}), combinedContext = () => '';
    const setGenerationFx = { of: value => ({ generation: value }) };
    const clearGhostFx = { of: () => ({}) };
    const EditorView = { announce: { of: () => ({}) } };
    const error402 = '402 {"type":"error","error":{"type":"api_error","message":"Upstream request failed: Insufficient account funds"}}';
    const fetch = async () => ({ ok: true });
    async function* sseChunks() { yield { error: error402 }; }
    ${source.slice(source.indexOf('async function generateFromLine('), source.indexOf('// ─── Read-only compartment'))}
    window.checkWriteError = async () => {
      notify('Earlier instruction', { sticky: true });
      let target = null;
      const view = { state: { readOnly: false, doc: { toString: () => '/Write.', lineAt: () => ({ from: 0 }) }, field: () => target },
        dispatch({ effects }) { for (const effect of effects) if ('generation' in effect) target = effect.generation; } };
      await generateFromLine(view, { from: 0, to: 7, text: '/Write.' }, 'Write.');
      return { text: editFeedback.textContent, tone: editFeedback.dataset.tone, sticky: noticeSticky, timer: noticeTimer };
    };
    window.checkSuggestError = () => {
      notify('Earlier instruction', { sticky: true });
      reportSuggestFailure(modelError(new Error(error402)), false);
      return { text: editFeedback.textContent, tone: editFeedback.dataset.tone, sticky: noticeSticky };
    };
  ` });
  const writeError = await page.evaluate(() => window.checkWriteError());
  assert.match(writeError.text, /out of credit/);
  assert.match(writeError.text, /Open settings/);
  assert.equal(writeError.tone, 'error');
  assert.equal(writeError.sticky, true);
  assert.equal(writeError.timer, null, 'Model errors must not expire automatically');
  const suggestError = await page.evaluate(() => window.checkSuggestError());
  assert.match(suggestError.text, /out of credit/);
  assert.equal(suggestError.sticky, true);
  await page.waitForFunction(() => {
    const notice = document.getElementById('edit-feedback');
    return !notice.hidden && getComputedStyle(notice).opacity === '1' && notice.getBoundingClientRect().height > 0;
  });
  await page.click('#edit-feedback .edit-feedback-undo');
  assert.equal(await page.evaluate(() => openedSettings), 'access');
  for (const [error, message] of [
    ['401 bad key', 'API key was rejected'], ['404 missing model', 'model is not available'],
    ['408 timeout', 'model took too long'], ['429 overloaded', 'model is rate-limited'],
    ['500 failed', 'provider hit an error'], ['Failed to fetch', 'Stilura stopped answering'],
  ]) {
    const state = await page.evaluate(error => {
      notifyProblem(modelError(new Error(error)), () => {});
      return { text: editFeedback.textContent, sticky: noticeSticky, visible: !editFeedback.hidden };
    }, error);
    assert(state.text.includes(message));
    assert(state.sticky && state.visible);
  }
  const alert = await page.evaluate(() => {
    notify('Old sticky message', { sticky: true });
    notify('New error', { tone: 'error' });
    notify('Background status');
    return editFeedback.textContent;
  });
  assert.match(alert, /New error/);
  await page.click('#edit-feedback .edit-feedback-close');
  await page.evaluate(() => {
    window.undone = false;
    notify('Text accepted', { action: () => { window.undone = true; } });
  });
  await page.click('#edit-feedback .edit-feedback-undo');
  assert.equal(await page.evaluate(() => window.undone), true);
  await page.evaluate(() => notify('Saved'));
  assert.equal(await page.$eval('#edit-feedback', node => node.textContent.includes('Saved') && !node.hidden), true);
  console.log('Paused chat checks passed: restored history, late replies, expanded/collapsed panels, notices and mobile/desktop widths.');
} finally { await browser.close(); }
