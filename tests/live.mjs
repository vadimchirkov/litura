import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChangeSet, EditorState } from '@codemirror/state';
import { history, undo } from '@codemirror/commands';
import { documentStore } from '../document-store.js';
import { createSession } from '../live-session.js';
import { liveDocument } from '../src/live.js';
import { resolveNoteRange } from '../notes.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stilura-live-'));
const sessions = [], editors = [];
function session(seed = 'Opening.\n\nEnding.') {
  const file = path.join(directory, `${sessions.length}.md`);
  fs.writeFileSync(file, seed);
  const authority = createSession(documentStore(file));
  sessions.push(authority);
  return authority;
}
function editor(authority, recovered = {}) {
  const original = authority.read();
  const view = { state: EditorState.create({ doc: original.text, extensions: [history()] }) };
  let notes = structuredClone(recovered.notes || []), pendingNotes = structuredClone(recovered.pendingNotes || []), saved, sync, dropEvents = false, loseAck = false, failBeforeWrite = false;
  const errors = [], conflicts = [];
  view.dispatch = spec => {
    const tr = view.state.update(spec); view.state = tr.state;
    if (tr.docChanged) sync.changed(tr.changes);
  };
  sync = liveDocument({
    view, url: () => 'http://local/draft/live?name=test.md', getNotes: () => notes,
    readPendingNotes: () => pendingNotes, writePendingNotes: value => { pendingNotes = structuredClone(value); },
    onSaved: value => { saved = value; }, onNotes: value => { notes = value; },
    onError: error => errors.push(error), onConflict: value => conflicts.push(value),
    subscribe: () => {
      const stream = { onmessage: null };
      const stop = authority.subscribe(value => queueMicrotask(() => { if (!dropEvents) stream.onmessage?.({ data: JSON.stringify(value) }); }));
      stream.close = () => { stop(); stream.onmessage = null; };
      return stream;
    },
    request: async (address, options = {}) => {
      if (failBeforeWrite) throw new Error('offline');
      const url = new URL(address);
      try {
        let value;
        if (options.method === 'POST') {
          const body = JSON.parse(options.body);
          value = body.action === 'push' ? authority.push(body) : authority.updateNotes(body);
          if (loseAck) { loseAck = false; throw new Error('lost acknowledgement'); }
        } else value = authority.events(Number(url.searchParams.get('since')), url.searchParams.get('epoch'));
        return { ok: true, json: async () => value };
      } catch (error) {
        if (!error.current) throw error;
        return { ok: false, json: async () => ({ error: error.message, current: error.current }) };
      }
    },
  });
  sync.connect(original); editors.push(sync);
  return { view, sync, errors, conflicts, get notes() { return notes; }, get saved() { return saved; }, get pendingNotes() { return pendingNotes; },
    set notes(value) { notes = value; sync.notesChanged(); },
    dropEvents(value) { dropEvents = value; }, loseAck() { loseAck = true; }, offline(value) { failBeforeWrite = value; } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
try {
  // Agent's edit arrives while the writer has unsent input in another paragraph.
  const authority = session();
  const a = editor(authority), b = editor(authority);
  const agentRead = authority.read();
  a.view.dispatch({ changes: { from: 0, insert: 'Human ' } });
  authority.patch([{ old: 'Ending.', new: 'Agent ending.' }], agentRead.revision);
  await settle();
  assert.equal(a.view.state.doc.toString(), 'Human Opening.\n\nAgent ending.');
  await a.sync.flush(); await b.sync.flush();
  assert.equal(a.view.state.doc.toString(), authority.read().text);
  assert.equal(b.view.state.doc.toString(), authority.read().text);
  assert.equal(fs.readFileSync(authority.read().path, 'utf8'), authority.read().text);
  assert.equal(undo(a.view), true);
  await a.sync.flush(); await b.sync.flush();
  assert.equal(authority.read().text, 'Opening.\n\nAgent ending.', 'Undo must preserve the agent edit');
  assert.equal(undo(a.view), false, 'Remote edits must not enter personal undo');

  // Stale agent positions move through non-overlapping user edits.
  const base = authority.read();
  a.view.dispatch({ changes: { from: 0, insert: 'New introduction.\n\n' } });
  await a.sync.flush();
  authority.patch([{ old: 'Agent ending.', new: 'Second ending.', from: base.text.indexOf('Agent') }], base.revision);
  await settle();
  assert.equal(a.view.state.doc.toString(), 'New introduction.\n\nOpening.\n\nSecond ending.');
  const stale = authority.read();
  a.view.dispatch({ changes: { from: a.view.state.doc.length - 1, insert: ' Changed' } });
  await a.sync.flush();
  assert.throws(() => authority.patch([{ old: 'Second ending.', new: 'Must not overwrite' }], stale.revision), /passage was edited/);
  assert(authority.read().text.endsWith('Second ending Changed.'));

  // Retry after a lost response and disconnected event stream cannot insert twice.
  a.dropEvents(true); a.loseAck();
  a.view.dispatch({ changes: { from: 0, insert: 'Once. ' } });
  await assert.rejects(a.sync.flush(), /lost acknowledgement/);
  await a.sync.flush();
  assert.equal(authority.read().text.match(/Once\./g).length, 1);
  assert.equal(a.view.state.doc.toString(), authority.read().text);
  a.dropEvents(false);

  // Offline input is replayed over a remote edit in another paragraph.
  a.offline(true);
  const disconnected = authority.read();
  a.view.dispatch({ changes: { from: 0, insert: 'Offline ' } });
  await assert.rejects(a.sync.flush(), /offline/);
  authority.patch([{ old: 'Opening.', new: 'Updated opening.' }], disconnected.revision);
  await settle(); a.offline(false); await a.sync.flush();
  assert.equal(a.view.state.doc.toString(), authority.read().text);
  assert(authority.read().text.startsWith('Offline Once.'));
  assert(authority.read().text.includes('Updated opening.'));

  // Shared notes retain their text and anchor, and resolution is pushed immediately.
  const noteDoc = session('Opening.\n\nTarget phrase.\n\nClosing.');
  const n = editor(noteDoc), observer = editor(noteDoc);
  n.notes = [{ id: 'note', para: 1, off: 0, length: 13, quote: 'Target phrase', anchor: 'Target phrase.', text: 'Clarify this.' }];
  await n.sync.flush(); await observer.sync.flush();
  assert.equal(observer.notes[0].text, 'Clarify this.');
  const old = noteDoc.read();
  noteDoc.patch([{ old: 'Opening.', new: 'New.\n\nOpening.' }], old.revision);
  await settle();
  assert.equal(resolveNoteRange(n.view.state.doc.toString(), n.notes[0]).from, n.view.state.doc.toString().indexOf('Target'));
  const current = noteDoc.read();
  noteDoc.updateNotes({ epoch: current.epoch, version: current.version, operations: [{ type: 'resolve', id: 'note' }] });
  await settle();
  assert.equal(n.notes[0].resolved, true);
  assert.equal(observer.notes[0].resolved, true);

  const concurrentNote = noteDoc.read();
  n.notes = [{ ...n.notes[0], text: 'Edited while agent resolves.' }];
  noteDoc.updateNotes({ epoch: concurrentNote.epoch, version: concurrentNote.version, operations: [{ type: 'resolve', id: 'note' }] });
  await n.sync.flush();
  assert.equal(noteDoc.read().notes[0].text, 'Edited while agent resolves.');
  assert.equal(noteDoc.read().notes[0].resolved, true);

  // Closing with an offline note edit retains it through the browser's local journal.
  n.offline(true);
  n.notes = [{ ...n.notes[0], text: 'Offline note edit.' }];
  await assert.rejects(n.sync.flush(), /offline/);
  n.sync.close();
  const recovered = editor(noteDoc, { notes: n.notes, pendingNotes: n.pendingNotes });
  await recovered.sync.flush();
  assert.equal(noteDoc.read().notes[0].text, 'Offline note edit.');
  assert.equal(recovered.pendingNotes.length, 0);

  const transient = editor(session());
  transient.notes = [{ id: 'transient', para: null, off: 0, quote: '', text: 'Temporary' }];
  transient.notes = [];
  await transient.sync.flush();
  assert.deepEqual(sessions.at(-1).read().notes, []);

  // External disk replacement starts a new epoch; unconfirmed input stays intact.
  const x = editor(session('Before.'));
  x.view.dispatch({ changes: { from: 0, insert: 'Unsaved ' } });
  const last = sessions.at(-1);
  fs.writeFileSync(last.read().path, 'External text.');
  last.read(); await settle();
  assert.equal(x.conflicts.length, 1);
  assert.equal(x.view.state.doc.toString(), 'Unsaved Before.');
  assert.equal(x.sync.active, false);

  // A remote rewrite must not blend into typing that has not reached the server yet.
  const simultaneous = session('Original phrase.\n\nOther paragraph.');
  const writer = editor(simultaneous), readBeforeTyping = simultaneous.read();
  writer.view.dispatch({ changes: { from: 3, insert: 'X' } });
  simultaneous.patch([{ old: 'Original phrase.', new: 'Agent replacement.' }], readBeforeTyping.revision);
  await settle();
  assert.equal(writer.conflicts.length, 1);
  assert.equal(writer.view.state.doc.toString(), 'OriXginal phrase.\n\nOther paragraph.');
  assert.equal(writer.conflicts[0].text, 'Agent replacement.\n\nOther paragraph.');
  assert.throws(() => simultaneous.push({ epoch: readBeforeTyping.epoch, version: readBeforeTyping.version,
    updates: [{ clientID: 'editor:late-request', changes: ChangeSet.of({ from: 3, insert: 'X' }, readBeforeTyping.text.length).toJSON() }] }), /passage was edited/);
  assert.equal(simultaneous.read().text, writer.conflicts[0].text, 'An already in-flight overlapping request must not corrupt the server copy');

  // Malformed updates never advance a session or write its document.
  const bad = session(), initial = bad.read();
  assert.throws(() => bad.push({ epoch: initial.epoch, version: 0, updates: [{ clientID: 'x', changes: [999] }] }), /length/);
  assert.equal(bad.read().revision, initial.revision);
  assert.equal(bad.read().text, initial.text);
  assert(a.errors.length === 0 && b.errors.length === 0 && n.errors.length === 0);
  console.log('Live checks passed: concurrent paragraphs, stale patches, personal undo, deduplication, reconnect, shared notes and recovery.');
} finally {
  for (const sync of editors) sync.close();
  for (const authority of sessions) authority.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
