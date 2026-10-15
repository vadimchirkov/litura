import { documentStore } from './document-store.js';
import { createSession, readSessionAddress } from './live-session.js';

// Never fall back to direct disk writes while a live owner is advertised.
export function sessionClient(filename) {
  const store = documentStore(filename), file = store.read().path;
  function offline(action = 'read', ...args) {
    const session = createSession(store);
    try {
      const result = session[action](...args);
      const { epoch, notes, ...draft } = result;
      return { ...draft, revision: result.diskRevision, ...(result.notesReady ? { notes } : {}) };
    } catch (error) {
      if (error.current) error.current.revision = error.current.diskRevision;
      throw error;
    } finally { session.close(); }
  }
  async function request(action, body = {}) {
    const address = readSessionAddress(file);
    if (!address) return null;
    const response = await fetch(address.url, {
      method: action ? 'POST' : 'GET', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json', 'X-Stilura-Session': address.token },
      ...(action ? { body: JSON.stringify({ action, ...body }) } : {}),
    });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || 'Live document unavailable'), { current: data.current });
    return data;
  }
  return {
    async nextWork(agent, waitMs = 0) {
      const end = Date.now() + Math.min(Math.max(waitMs, 0), 30000);
      do {
        const result = await request('work_next', { agent_id: agent });
        if (!result) throw new Error('Open Stilura to use its work queue.');
        if (result.job || Date.now() >= end) return result;
        await new Promise(resolve => setTimeout(resolve, 250));
      } while (true);
    },
    async finishWork(body) {
      const result = await request('work_finish', body);
      if (!result) throw new Error('The live work queue is unavailable. Keep your proposed edit and reconnect.');
      return result;
    },
    async suggestNote(body) {
      const result = await request('note_suggest', body);
      if (!result) throw new Error('Open Stilura to send live writing advice.');
      return result;
    },
    async read() { return await request() ?? offline(); },
    async write(text, revision) { return await request('write', { text, revision }) ?? offline('write', text, revision); },
    async patch(edits, revision) {
      const result = await request('patch', { edits, revision });
      if (result) return result;
      return offline('patch', edits, revision);
    },
    async resolveNote(id) {
      const draft = await request();
      if (draft) await request('notes', { epoch: draft.epoch, version: draft.version, operations: [{ type: 'resolve', id }] });
      else {
        const session = createSession(store);
        try {
          const current = session.read();
          if (!current.notesReady) return null;
          session.updateNotes({ epoch: current.epoch, version: current.version, operations: [{ type: 'resolve', id }] });
        } finally { session.close(); }
      }
      return { id, resolved: true };
    },
    async changes(revision, waitMs = 0) {
      const until = Date.now() + Math.min(Math.max(waitMs, 0), 30000);
      let draft;
      do {
        draft = await request() ?? offline();
        if (draft.revision !== revision || Date.now() >= until) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (true);
      return { changed: draft.revision !== revision, ...draft };
    },
  };
}
