import { ChangeSet, EditorState, Transaction } from '@codemirror/state';
import { collab, getSyncedVersion, receiveUpdates, sendableUpdates } from '@codemirror/collab';
import { mapNoteAnchors } from '../notes.js';
import { textChange, changesOverlap } from '../text-change.js';

const signature = note => JSON.stringify([note.text, note.resolved === true, note.kind]);

// A shadow collab state keeps transport separate from the editor's UI fields and undo.
export function liveDocument({ view, url, request = fetch, subscribe = address => new EventSource(address), onSaved, onNotes, onError, onConflict, getNotes, readPendingNotes = () => [], writePendingNotes = () => {} }) {
  let connection = null, applying = false, timer;
  function schedule() {
    if (!timer) timer = setTimeout(() => { timer = null; flush().catch(onError); }, 75);
  }
  function publishNotes(c) {
    const notes = structuredClone(c.notes);
    let before = c.confirmed;
    for (const update of sendableUpdates(c.state)) {
      const after = update.changes.apply(before);
      mapNoteAnchors(notes, before.toString(), after.toString(), update.changes); before = after;
    }
    // Local note edits remain visible until the server acknowledges them.
    const local = getNotes();
    for (const [id, entry] of c.dirtyNotes) {
      const at = notes.findIndex(note => note.id === id), own = local.find(note => note.id === id);
      if (at >= 0) notes.splice(at, 1);
      if (entry.type === 'put' && own) notes.push(own);
    }
    const previous = applying;
    applying = true;
    try { onNotes(notes, c.notesReady); } finally { applying = previous; }
  }
  function receive(c, data) {
    if (connection !== c) return;
    if (data.type === 'reset') { reset(c, data.current); return; }
    if (data.epoch !== c.epoch) throw new Error('Document session changed');
    const synced = getSyncedVersion(c.state);
    if (data.from > synced) { schedule(); return; }
    const updates = data.updates.slice(Math.max(0, synced - data.from)).map(update => ({ ...update, changes: ChangeSet.fromJSON(update.changes) }));
    if (updates.length) {
      let state = c.state, confirmed = c.confirmed, changes = ChangeSet.empty(view.state.doc.length);
      for (const update of updates) {
        const pending = sendableUpdates(state).reduce((all, item) => all.compose(item.changes), ChangeSet.empty(confirmed.length));
        if (!update.clientID.startsWith('editor:') && changesOverlap(pending, update.changes)) {
          const current = { ...data, text: updates.reduce((doc, item) => item.changes.apply(doc), c.confirmed).toString() };
          close(); onConflict(current); return;
        }
        const transaction = receiveUpdates(state, [update]);
        state = transaction.state; changes = changes.compose(transaction.changes);
        confirmed = update.changes.apply(confirmed);
      }
      c.state = state; c.confirmed = confirmed;
      applying = true;
      try {
        if (!changes.empty) view.dispatch({ changes, annotations: [Transaction.addToHistory.of(false), Transaction.remote.of(true)] });
      } finally { applying = false; }
    }
    if (data.notesVersion >= c.notesVersion && data.version >= getSyncedVersion(c.state)) {
      c.notes = data.notes; c.notesVersion = data.notesVersion; c.notesReady = data.notesReady;
      publishNotes(c);
    }
    if (data.version === getSyncedVersion(c.state)) onSaved({ text: c.confirmed.toString(), revision: data.revision });
  }
  function reset(c, current) {
    if (connection !== c) return;
    const local = view.state.doc.toString();
    if (c.dirtyNotes.size || sendableUpdates(c.state).length && local !== current.text) {
      close(); onConflict(current); return;
    }
    applying = true;
    try { view.dispatch({ changes: textChange(local, current.text), annotations: [Transaction.addToHistory.of(false), Transaction.remote.of(true)] }); }
    finally { applying = false; }
    connect(current);
    onSaved(current);
  }
  async function call(c, method, body) {
    const response = await request(c.url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) {
      if (data.current && body?.action !== 'notes') { close(); onConflict(data.current); }
      throw Object.assign(new Error(data.error || 'Live synchronization failed'), { current: data.current });
    }
    return data;
  }
  function flush() {
    const c = connection;
    if (!c) return Promise.resolve();
    if (c.sending) return c.sending;
    clearTimeout(timer); timer = null;
    c.sending = (async () => {
      try {
        // Pull first also repairs missed SSE events after reconnect.
        const response = await request(`${c.url}&epoch=${encodeURIComponent(c.epoch)}&since=${getSyncedVersion(c.state)}`);
        const data = await response.json();
        if (connection !== c) return;
        if (!response.ok) { if (data.current) reset(c, data.current); else throw new Error(data.error); return; }
        receive(c, data);
        while (connection === c) {
          const updates = sendableUpdates(c.state);
          if (updates.length) {
            receive(c, await call(c, 'POST', { action: 'push', epoch: c.epoch, version: getSyncedVersion(c.state), updates: updates.slice(0, 500).map(({ changes, clientID }) => ({ changes: changes.toJSON(), clientID })) }));
            continue;
          }
          if (!c.dirtyNotes.size && c.notesReady) break;
          const pending = new Map(c.dirtyNotes);
          const local = getNotes();
          const operations = [...pending].map(([id, entry]) => ({ id, type: entry.type, operationID: entry.operationID, expectedVersion: entry.version,
            ...(entry.type === 'put' ? { note: local.find(note => note.id === id) } : {}) }));
          const result = await call(c, 'POST', { action: 'notes', epoch: c.epoch, version: getSyncedVersion(c.state), operations });
          if (connection !== c) return;
          for (const [id, entry] of pending) {
            if (c.dirtyNotes.get(id) === entry) c.dirtyNotes.delete(id);
            else if (c.dirtyNotes.has(id)) c.dirtyNotes.get(id).version = result.notes.find(note => note.id === id)?.version ?? 0;
          }
          writePendingNotes([...c.dirtyNotes]);
          receive(c, result);
        }
      } finally { c.sending = null; }
    })();
    return c.sending;
  }
  function connect(current) {
    close();
    if (!current.epoch) return;
    const c = connection = { epoch: current.epoch, url: url(), confirmed: EditorState.create({ doc: current.text }).doc,
      notes: current.notes || [], notesVersion: current.notesVersion ?? 0, notesReady: current.notesReady,
      dirtyNotes: new Map(readPendingNotes()), state: EditorState.create({ doc: current.text, extensions: [collab({ startVersion: current.version, clientID: `editor:${crypto.randomUUID()}` })] }) };
    for (const [id, entry] of c.dirtyNotes) {
      const saved = c.notes.find(note => note.id === id), own = getNotes().find(note => note.id === id);
      if (entry.type === 'delete' && !saved || entry.type === 'put' && saved && own && saved.text === own.text && (!own.resolved || saved.resolved)) c.dirtyNotes.delete(id);
    }
    writePendingNotes([...c.dirtyNotes]);
    const local = view.state.doc.toString();
    if (local !== current.text) c.state = c.state.update({ changes: textChange(current.text, local) }).state;
    c.stream = subscribe(`${c.url}&events=1&epoch=${encodeURIComponent(c.epoch)}&since=${getSyncedVersion(c.state)}`);
    c.stream.onmessage = event => { try { receive(c, JSON.parse(event.data)); } catch (error) { onError(error); } };
    c.stream.onopen = () => schedule();
    c.stream.onerror = () => { if (connection === c) onError(new Error('Connection interrupted. Your changes are kept locally; reconnecting.')); };
    if (c.notesReady) publishNotes(c);
    else notesChanged();
    schedule();
  }
  function notesChanged() {
    const c = connection;
    if (!c || applying) return;
    const local = getNotes().filter(note => note.text.trim());
    for (const note of local) {
      const saved = c.notes.find(item => item.id === note.id);
      if (!saved || signature(note) !== signature(saved) || c.dirtyNotes.has(note.id)) {
        const pending = c.dirtyNotes.get(note.id);
        if (!pending || pending.signature !== signature(note)) c.dirtyNotes.set(note.id, { type: 'put', operationID: crypto.randomUUID(), version: saved?.version ?? 0, signature: signature(note) });
      }
    }
    for (const [id, pending] of c.dirtyNotes) if (pending.type === 'put' && !local.some(note => note.id === id)) {
      c.dirtyNotes.set(id, { type: 'delete', operationID: crypto.randomUUID(), version: pending.version });
    }
    for (const note of c.notes) if (!local.some(item => item.id === note.id) && c.dirtyNotes.get(note.id)?.type !== 'delete') c.dirtyNotes.set(note.id, { type: 'delete', operationID: crypto.randomUUID(), version: note.version ?? 0 });
    writePendingNotes([...c.dirtyNotes]);
    if (c.dirtyNotes.size) schedule();
  }
  function close() {
    clearTimeout(timer); timer = null;
    connection?.stream?.close(); connection = null;
  }
  return {
    connect, close, flush, notesChanged,
    async work(body) {
      await flush();
      const c = connection;
      if (!c) throw new Error('Reconnect the document before updating work.');
      const current = await call(c, 'POST', { action: 'work', ...body });
      // Work may edit text too; pull the corresponding operations before its notes.
      await flush();
      return current;
    },
    get active() { return connection !== null; },
    get applying() { return applying; },
    changed(changes) {
      if (!connection || applying) return;
      connection.state = connection.state.update({ changes }).state; schedule();
    },
  };
}
