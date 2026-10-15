import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { sessionClient } from '../session-client.js';
import { EditorState } from '@codemirror/state';
import { liveDocument } from '../src/live.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stilura-live-http-'));
const file = path.join(directory, 'draft.md');
fs.writeFileSync(file, 'Opening.\n\nEnding.');
const root = new URL('../', import.meta.url);
const env = { ...process.env, DRAFT_FILE: file, PORT: '0', STILURA_NO_OPEN: '1', STILURA_OFFLINE_MODELS: '1', PI_OFFLINE: '1' };
const server = spawn(process.execPath, ['index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
const client = sessionClient(file);
const timeout = setTimeout(() => { server.kill(); console.error('Live HTTP test timed out'); process.exit(1); }, 30000);
let sync, notes = [], serverOutput = '';
server.stdout.on('data', chunk => { serverOutput += chunk; });
server.stderr.on('data', chunk => { serverOutput += chunk; });
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
async function until(predicate) {
  const end = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > end) throw Error('Expected event did not arrive'); await tick(); }
}
try {
  await until(() => /Stilura → http/.test(serverOutput));
  const base = serverOutput.match(/Stilura → (http:\/\/[^\s]+)/)[1];
  const url = `${base}/draft/live?name=draft.md`;
  const initial = await (await fetch(url)).json();
  const view = { state: EditorState.create({ doc: initial.text }) };
  view.dispatch = spec => { const tr = view.state.update(spec); view.state = tr.state; if (tr.docChanged) sync.changed(tr.changes); };
  const failures = [];
  sync = liveDocument({ view, url: () => url, getNotes: () => notes,
    onNotes: value => { notes = value; }, onSaved() {}, onError: error => failures.push(error), onConflict: value => failures.push(value),
    subscribe(address) {
      const controller = new AbortController();
      const stream = { close: () => controller.abort() };
      (async () => {
        const response = await fetch(address, { signal: controller.signal });
        assert.equal(response.headers.get('content-type'), 'text/event-stream');
        stream.onopen?.();
        let buffer = '';
        for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
          buffer += chunk;
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            if (event.startsWith('data: ')) stream.onmessage?.({ data: event.slice(6) });
          }
        }
      })().catch(error => { if (!controller.signal.aborted) failures.push(error); });
      return stream;
    },
  });
  sync.connect(initial);
  const read = await client.read();
  assert.equal(read.revision, initial.revision);
  view.dispatch({ changes: { from: 0, insert: 'Human ' } });
  await client.patch([{ old: 'Ending.', new: 'Agent ending.' }], read.revision);
  await sync.flush();
  await until(() => view.state.doc.toString() === 'Human Opening.\n\nAgent ending.');
  assert.equal((await client.read()).text, view.state.doc.toString());
  assert.equal(fs.readFileSync(file, 'utf8'), view.state.doc.toString());
  assert.equal(notes[0].work.status, 'review', 'Direct HTTP patches also need review and undo history');

  const watched = await client.read();
  const waiting = client.changes(watched.revision, 3000);
  view.dispatch({ changes: { from: 0, insert: 'Live ' } });
  await sync.flush();
  assert.equal((await waiting).text, view.state.doc.toString());

  notes = [{ id: 'shared', text: 'Clarify ending.', quote: 'Agent ending.', para: 1, off: 0, length: 13, anchor: 'Agent ending.' }];
  sync.notesChanged(); await sync.flush();
  assert.equal((await client.read()).notes[0].text, 'Clarify ending.');
  const claimed = (await client.nextWork('http-agent')).job;
  assert.equal(claimed.id, 'shared');
  assert.equal((await client.nextWork('another-agent')).job, null);
  await client.finishWork({ id: claimed.id, token: claimed.token, revision: claimed.revision,
    edits: [{ old: 'Agent ending.', new: 'Reviewed ending.' }], comment: 'Clarified the ending.' });
  await until(() => notes[0].work.status === 'review');
  assert(view.state.doc.toString().endsWith('Reviewed ending.'));
  const applied = notes[0].work.attempts.at(-1);
  await sync.work({ type: 'revert', id: 'shared', generation: notes[0].work.generation, attempt: applied.id });
  assert(view.state.doc.toString().endsWith('Agent ending.'));
  await sync.work({ type: 'regenerate', id: 'shared', generation: notes[0].work.generation });
  const retry = (await client.nextWork('http-agent')).job;
  await client.finishWork({ id: retry.id, token: retry.token, revision: retry.revision, comment: 'The original wording works.' });
  await until(() => notes[0].work.status === 'review');
  await sync.work({ type: 'accept', id: 'shared', generation: notes[0].work.generation, attempt: notes[0].work.attempts.at(-1).id });
  await until(() => notes[0].resolved === true);
  const sidecar = JSON.parse(fs.readFileSync(`${file}.stilura-notes.json`, 'utf8'));
  assert.equal(sidecar.notes[0].resolved, true);
  const adviceRead = await client.read();
  await client.suggestNote({ agent_id: 'http-agent', text: 'Consider a more specific opening.', revision: adviceRead.revision, quote: 'Opening.' });
  await until(() => notes.length === 2);
  assert.equal(notes[1].work.status, 'review');
  assert.equal((await client.nextWork('http-agent')).job, null, 'Advice must not create work for its author');
  const beforeWrite = await client.read();
  await client.write(beforeWrite.text + '\n\nAgent tail.', beforeWrite.revision);
  await until(() => view.state.doc.toString().endsWith('Agent tail.'));
  const fullWrite = notes.at(-1);
  assert.equal(fullWrite.work.status, 'review');
  await sync.work({ type: 'revert', id: fullWrite.id, generation: fullWrite.work.generation, attempt: fullWrite.work.attempts.at(-1).id });
  assert.equal(view.state.doc.toString(), beforeWrite.text, 'A whole-draft HTTP write is reversible without replacing the whole editor');

  // Reconnecting with an old epoch receives a reset over SSE, not an endless 409 loop.
  const controller = new AbortController();
  const reset = await fetch(`${url}&events=1&epoch=old&since=0`, { signal: controller.signal });
  const first = await reset.body.getReader().read();
  assert(new TextDecoder().decode(first.value).includes('"type":"reset"'));
  controller.abort();
  assert.equal(failures.length, 0, JSON.stringify(failures));
  sync.close(); server.kill(); await once(server, 'exit');
  assert.equal((await client.read()).notes[0].resolved, true, 'Shared notes remain readable after closing the editor');
  const offline = await client.read();
  await client.patch([{ old: 'Opening.', new: 'Offline opening.' }], offline.revision);
  assert(fs.readFileSync(file, 'utf8').includes('Offline opening.'));
  console.log('Live HTTP checks passed: auto-discovery, SSE, concurrent edits, revision polling, shared notes and stale reconnect.');
} finally {
  sync?.close();
  server.kill(); if (server.exitCode === null && server.signalCode === null) await once(server, 'exit');
  clearTimeout(timeout); fs.rmSync(directory, { recursive: true, force: true });
}
