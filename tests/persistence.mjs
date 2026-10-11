import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { EditorState, Compartment, Transaction } from '@codemirror/state';
import { history, undo } from '@codemirror/commands';
import { openStorage } from '../src/storage.js';

const source = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const section = (start, end) => {
  const at = source.indexOf(start), to = source.indexOf(end, at);
  assert(at >= 0 && to > at, `Missing production section: ${start}`);
  return source.slice(at, to);
};

// Use the production document-opening function and real CodeMirror history.
{
  const historyComp = new Compartment();
  const workView = { state: EditorState.create({ doc: 'private A', extensions: [historyComp.of(history())] }) };
  workView.dispatch = spec => { workView.state = spec.state ?? workView.state.update(spec).state; };
  const context = vm.createContext({ workView, historyComp, history, Transaction });
  vm.runInContext(section('function openDocumentText(', 'function flushSave('), context);
  context.openDocumentText('document B');
  assert.equal(undo(workView), false, 'Opening B must not leave A in undo history');
  workView.dispatch({ changes: { from: 10, insert: ' edited' } });
  assert.equal(undo(workView), true);
  assert.equal(workView.state.doc.toString(), 'document B');
  assert.equal(undo(workView), false);
}

{
  const entries = new Map();
  const context = vm.createContext({
    positionBrief: null, briefSession: { step: 0, answers: {}, card: null },
    BRIEF_STEPS: [{ key: 'reader' }, { key: 'goal' }, { key: 'awareness' }, { key: 'scope' }],
    docStorage: { getItem: key => entries.get(key), setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) },
    renderBriefQuestion() {}, safeJson: (value, fallback) => value ? JSON.parse(value) : fallback,
    cancelSuggestion() {}, ghostClear() {}, workView: {},
  });
  vm.runInContext(section('function saveBrief()', 'function briefComplete()') + section('function answerBriefStep(', 'function finishBrief()'), context);
  vm.runInContext("answerBriefStep('Practitioner'); restoreBrief();", context);
  assert.equal(context.positionBrief.reader, 'Practitioner', 'Partial answers survive reload without Escape');
}

{
  let handler, exported, notified;
  const context = vm.createContext({
    document: { getElementById: () => ({ addEventListener: (_, callback) => { handler = callback; } }) },
    window: {}, workView: { state: { doc: { toString: () => 'draft content' } }, focus() {} }, documentName: 'draft.md',
    exportText: (...args) => { exported = args; }, notify: text => { notified = text; }, refreshFileList() {},
  });
  vm.runInContext(section("document.getElementById('file-export').addEventListener", "document.addEventListener('keydown', event => {\n  if (!(event.metaKey"), context);
  await handler();
  assert.deepEqual(exported, ['draft content', 'draft.md']);
  context.window.showSaveFilePicker = async () => ({ createWritable: async () => { throw Error('disk full'); } });
  await handler();
  assert.match(notified, /disk full/);
}

// A caller awaiting flushSave must wait for the existing request too.
{
  const requests = [];
  let text = 'first edit';
  const context = vm.createContext({
    saving: false, savePromise: null, savePaused: false, loadingDocument: false, diskHold: false,
    diskText: 'old', diskRevision: 'old-revision', autosaveHold: false, documentName: 'A.md',
    workView: { state: { doc: { toString: () => text } } },
    fetch: (url, options) => new Promise(resolve => requests.push({ url, options, resolve })),
    noteDiskBaseline: (value, revision) => { context.diskText = value; context.diskRevision = revision; },
    clearNotice() {}, saveToDisk() {}, cancelSuggestion() {}, ghostClear() {}, notifyProblem() {},
  });
  vm.runInContext(section('function draftUrl(', 'function openDocumentText(') + section('function flushSave()', 'function save()'), context);
  const first = context.flushSave();
  assert.equal(context.flushSave(), first);
  text = 'latest edit';
  requests[0].resolve({ ok: true, status: 200, json: async () => ({ revision: 'r1' }) });
  await first;
  const second = context.flushSave();
  assert.equal(JSON.parse(requests[1].options.body).text, 'latest edit');
  assert.equal(requests[1].url, '/draft?name=A.md');
  requests[1].resolve({ ok: true, status: 200, json: async () => ({ revision: 'r2' }) });
  await second;
  assert.equal(context.diskText, 'latest edit');
}


// The real desktop handler does not acknowledge before both saves complete.
{
  let events, saveDone, storageDone;
  const acknowledgements = [];
  const context = vm.createContext({
    desktop: true, desktopSaving: false, loadingDocument: false, switchingDocument: false,
    savePaused: false, diskHold: false, diskText: 'old', diskTimer: null,
    document: { body: { inert: false }, activeElement: { blur() {} } },
    EventSource: class { constructor() { events = this; } },
    workView: { state: { doc: { toString: () => 'latest' } } },
    editorSetReadonly() {}, stopJobs() {}, clearTimeout() {}, notify() {},
    flushSave: () => context.diskText === 'latest' ? Promise.resolve() : new Promise(resolve => { saveDone = () => { context.diskText = 'latest'; resolve(); }; }),
    localStorage: { flush: () => new Promise(resolve => { storageDone = resolve; }) },
    api: async (_, options) => { acknowledgements.push(JSON.parse(options.body)); },
  });
  const at = source.lastIndexOf('\nif (desktop) {');
  vm.runInContext(source.slice(at, source.indexOf('\n}\nmain().catch', at)), context);
  const saving = events.onmessage({ data: JSON.stringify({ type: 'flush', id: 'ticket' }) });
  assert.equal(context.document.body.inert, true);
  assert.equal(acknowledgements.length, 0);
  saveDone();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(acknowledgements.length, 0);
  storageDone(); await saving;
  assert.equal(acknowledgements[0].ok, true);
  await events.onmessage({ data: '{"type":"resume"}' });
  assert.equal(context.document.body.inert, false);
  context.diskHold = true;
  await events.onmessage({ data: '{"type":"flush","id":"conflict"}' });
  assert.equal(acknowledgements[1].ok, false);
  assert.equal(context.document.body.inert, false);
}

// Failed state writes remain pending and retry; an old origin cannot restore deleted keys.
{
  let fail = true;
  const errors = [], writes = [];
  const storage = await openStorage({
    desktop: true, browser: { length: 1, key: () => 'wa-deleted', getItem: () => 'stale', setItem() {}, removeItem() {} },
    request: async (_, options) => {
      if (!options) return { ok: true, json: async () => ({ entries: [['wa-theme', 'dark']] }) };
      writes.push(JSON.parse(options.body));
      return { ok: !fail };
    },
    onError: error => errors.push(error),
  });
  assert.equal(storage.getItem('wa-deleted'), null);
  storage.setItem('wa-theme', 'light');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(errors.length, 1);
  fail = false;
  await storage.flush();
  assert.equal(writes.length, 2);
  assert.equal(writes[1].value, 'light');
}

const root = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stilura-persistence-'));
const workspace = path.join(temp, 'workspace');
fs.mkdirSync(workspace);
fs.writeFileSync(path.join(workspace, 'draft.md'), 'same');
fs.writeFileSync(path.join(workspace, 'B.md'), 'same');
const outside = path.join(temp, 'outside.md');
fs.writeFileSync(outside, 'private');
let running;
async function launch() {
  const child = spawn(process.execPath, [path.join(root, 'index.js')], {
    cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DRAFT_FILE: path.join(workspace, 'draft.md'), STILURA_SIDECAR: '1', STILURA_OFFLINE_MODELS: '1', STILURA_STATE_DIR: path.join(temp, 'state') },
  });
  running = child;
  let output = '';
  child.stderr.on('data', chunk => { output += chunk; });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(output)), 15000);
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/STILURA_READY (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(Error(`Server exited ${code}: ${output}`)); });
  });
  return (route, method = 'GET', body) => fetch(url + route, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(25000),
  });
}
async function stop() {
  running.stdin.end();
  if (running.exitCode === null) await once(running, 'exit');
  running = null;
}
try {
  let request = await launch();
  const a = await (await request('/draft')).json();
  await request('/draft/open', 'POST', { name: 'B.md' });
  const save = await request('/draft?name=draft.md', 'PUT', { text: 'A edit', revision: a.revision });
  assert.equal(save.status, 200);
  assert.equal(fs.readFileSync(path.join(workspace, 'B.md'), 'utf8'), 'same');
  assert.equal((await (await request('/draft')).json()).text, 'A edit');
  assert.equal((await (await request('/draft?name=B.md')).json()).text, 'same');
  assert.equal((await request('/draft?name=../outside.md', 'PUT', { text: 'bad', revision: a.revision })).status, 400);
  assert.equal((await request('/file', 'PUT', { name: 'B.md', text: 'blind overwrite' })).status, 409);
  const b = await (await request('/file?name=B.md')).json();
  assert.equal((await request('/file', 'PUT', { name: 'B.md', text: 'B edit', revision: b.revision })).status, 200);
  const history = await (await request('/draft/history?name=B.md')).json();
  assert.equal(history.snapshots[0].text, 'same');
  assert.equal((await request('/file', 'PUT', { name: 'new.md', text: 'new' })).status, 200);
  if (process.platform !== 'win32') {
    fs.symlinkSync(outside, path.join(workspace, 'link.md'));
    for (const [route, method, body] of [
      ['/file?name=link.md', 'GET'], ['/file', 'PUT', { name: 'link.md', text: 'bad' }],
      ['/draft/open', 'POST', { name: 'link.md' }], ['/draft?name=link.md', 'GET'],
    ]) assert.equal((await request(route, method, body)).status, 400);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'private');
  }

  // The actual storage client writes through the server, then reads from a new port.
  const browser = { length: 0, setItem() {}, removeItem() {} };
  const adapterRequest = (route, options = {}) => request(route, options.method ?? 'GET', options.body && JSON.parse(options.body));
  let storage = await openStorage({ desktop: true, browser, request: adapterRequest, onError: error => { throw error; } });
  storage.setItem('wa-theme', 'dark');
  storage.setItem('litura:doc:wa-brief', '{"reader":"Practitioner"}');
  storage.setItem('litura:doc:wa-brief', '{"reader":"Newest answer"}');
  await storage.flush();
  await stop();
  request = await launch();
  storage = await openStorage({ desktop: true, browser, request: adapterRequest, onError: error => { throw error; } });
  assert.equal(storage.getItem('wa-theme'), 'dark');
  assert.equal(storage.getItem('litura:doc:wa-brief'), '{"reader":"Newest answer"}');
  assert.equal((await request('/api/desktop/storage', 'PUT', { key: '../escape', value: 'bad' })).status, 400);
  assert.equal((await request('/api/desktop/flush', 'POST', {})).status, 409, 'Never restart without a connected editor');

  // A desktop exit remains pending until that exact editor request is acknowledged.
  const stream = await request('/api/desktop/events');
  const reader = stream.body.getReader();
  await reader.read(); // connected comment
  let finished = false;
  const exit = request('/api/desktop/flush', 'POST', {}).then(response => { finished = true; return response; });
  const event = new TextDecoder().decode((await reader.read()).value);
  const message = JSON.parse(event.match(/data: (.+)/)[1]);
  assert.equal(message.type, 'flush');
  assert.equal(finished, false);
  assert.equal((await request('/api/desktop/flushed', 'POST', { id: 'wrong', ok: true })).status, 409);
  await request('/api/desktop/flushed', 'POST', { id: message.id, ok: false, error: 'disk full' });
  assert.equal((await exit).status, 409);
  await reader.read(); // resume on failed save
  const success = request('/api/desktop/flush', 'POST', {});
  const next = JSON.parse(new TextDecoder().decode((await reader.read()).value).match(/data: (.+)/)[1]);
  await request('/api/desktop/flushed', 'POST', { id: next.id, ok: true });
  assert.equal((await success).status, 200);
  await reader.cancel();
  await stop();
} finally {
  if (running) { running.kill(); if (running.exitCode === null) await once(running, 'exit'); }
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log('Persistence checks passed: isolated undo/files, guarded writes, brief recovery, export fallback, save ordering, desktop state across ports and exit acknowledgement.');
