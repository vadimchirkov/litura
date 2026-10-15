import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ChangeSet, Text } from '@codemirror/state';
import { rebaseUpdates } from '@codemirror/collab';
import { documentStore, MAX_DOCUMENT_BYTES } from './document-store.js';
import { patchRanges } from './editing.js';
import { mapNoteAnchors, resolveNoteRange, paragraphRanges } from './notes.js';
import { textChange, changesOverlap } from './text-change.js';
import { queueNote, noteTarget, anchorPassage, mapWork, reversible, resultEdits } from './work.js';

export const sessionFile = file => `${file}.stilura-session`;
const text = value => Text.of(value.split('\n'));
const bad = message => Object.assign(new Error(message), { status: 400 });
const alive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
};

export function readSessionAddress(file) {
  let address;
  try { address = JSON.parse(fs.readFileSync(sessionFile(file), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!Number.isInteger(address.pid) || address.pid <= 0 || typeof address.token !== 'string') throw bad('Invalid document session');
  const url = new URL(address.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) throw bad('Invalid document session address');
  return alive(address.pid) ? address : null;
}

function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

export function documentSessions() {
  const sessions = new Map();
  let url;
  function get(filename) {
    const store = documentStore(filename), file = store.read().path;
    if (sessions.has(file)) return sessions.get(file);
    const other = readSessionAddress(file);
    if (other && other.pid !== process.pid) throw Object.assign(new Error('This document is already open in another Stilura server.'), { status: 409 });
    const session = createSession(store, { trackChanges: true });
    sessions.set(file, session);
    if (url) session.advertise(url);
    return session;
  }
  return {
    get,
    listen(address) { url = address; for (const session of sessions.values()) session.advertise(url); },
    close() { for (const session of sessions.values()) session.close(); },
  };
}

export function createSession(store, { trackChanges = false } = {}) {
  let disk = store.read(), doc = text(disk.text), base = doc;
  let epoch = randomUUID(), baseVersion = 0, updates = [], logBytes = 0;
  let notes = [], notesVersion = 0, notesReady = false;
  const noteOperations = new Set();
  const listeners = new Set(), token = randomUUID();
  const notesFile = `${disk.path}.stilura-notes.json`;
  try {
    const saved = JSON.parse(fs.readFileSync(notesFile, 'utf8'));
    if (!Array.isArray(saved.notes)) throw bad('Invalid saved notes');
    notes = saved.notes; notesReady = true;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const note of notes) if (!note.resolved && (!note.work || note.work.status === 'working')) queueNote(note);
  const version = () => baseVersion + updates.length;
  const revision = () => `${epoch}:${version()}:${notesVersion}`;
  let lastSnapshot = 0;
  const saveNotes = (items = notes) => atomicJson(notesFile, { notes: items });
  const snapshot = () => ({ ...disk, text: doc.toString(), diskRevision: disk.revision, revision: revision(), epoch, version: version(), notes: structuredClone(notes), notesVersion, notesReady });
  const conflict = message => Object.assign(new Error(message), { status: 409, current: snapshot() });
  const broadcast = event => { for (const listener of listeners) listener(event); };
  function refresh() {
    const current = store.read();
    if (current.revision === disk.revision) return;
    disk = current; doc = base = text(disk.text); epoch = randomUUID();
    baseVersion = 0; updates = []; logBytes = 0;
    broadcast({ type: 'reset', current: snapshot() });
  }
  function since(from, expectedEpoch) {
    if (expectedEpoch !== epoch || !Number.isInteger(from) || from < baseVersion || from > version()) throw conflict('Document history changed. Read the current draft before retrying.');
    return updates.slice(from - baseVersion);
  }
  function documentAt(from) {
    return updates.slice(0, from - baseVersion).reduce((value, update) => update.changes.apply(value), base);
  }
  function events(from, expectedEpoch) {
    refresh();
    return { epoch, from, version: version(), revision: revision(), notes: structuredClone(notes), notesVersion, notesReady,
      updates: since(from, expectedEpoch).map(({ changes, clientID }) => ({ changes: changes.toJSON(), clientID })) };
  }
  function commit(incoming, decorate) {
    if (!incoming.length) return;
    let next = doc;
    const mapped = structuredClone(notes);
    for (const update of incoming) {
      if (update.changes.length !== next.length) throw bad('Changes do not match the document length');
      const after = update.changes.apply(next);
      mapNoteAnchors(mapped, next.toString(), after.toString(), update.changes);
      mapWork(mapped, update.changes);
      next = after;
    }
    if (Buffer.byteLength(next.toString()) > MAX_DOCUMENT_BYTES) throw Object.assign(new Error('Draft exceeds 1 MB'), { status: 413 });
    if (decorate) decorate(mapped, next.toString());
    // Persist before acknowledgement. A failed save never advances the operation log.
    if (notesReady || decorate) saveNotes(mapped);
    const checkpoint = incoming.some(update => !update.clientID.startsWith('editor:')) || Date.now() - lastSnapshot > 10000;
    try { disk = store.write(next.toString(), disk.revision, { snapshot: checkpoint }); }
    catch (error) { if (notesReady) saveNotes(notes); else if (decorate) fs.unlinkSync(notesFile); throw error; }
    if (checkpoint) lastSnapshot = Date.now();
    const from = version();
    doc = next; notes = mapped;
    if (decorate) { notesVersion++; notesReady = true; }
    for (const update of incoming) {
      const bytes = JSON.stringify(update.changes.toJSON()).length;
      updates.push({ ...update, bytes }); logBytes += bytes;
    }
    broadcast({ type: 'updates', ...events(from, epoch) });
    while (updates.length > 1 && (updates.length > 2000 || logBytes > 8 * 1024 * 1024)) {
      const old = updates.shift(); base = old.changes.apply(base); baseVersion++; logBytes -= old.bytes;
    }
  }
  function push(body) {
    refresh();
    const over = since(body.version, body.epoch);
    if (!Array.isArray(body.updates) || !body.updates.length || body.updates.length > 1000) throw bad('Expected 1–1000 updates');
    let length = documentAt(body.version).length;
    const incoming = body.updates.map(update => {
      if (typeof update.clientID !== 'string' || !update.clientID || update.clientID.length > 128) throw bad('Invalid client ID');
      const changes = ChangeSet.fromJSON(update.changes);
      if (changes.length !== length) throw bad('Invalid update length');
      length = changes.newLength;
      return { changes, clientID: update.clientID };
    });
    let pending = incoming;
    for (const update of over) {
      if (!update.clientID.startsWith('editor:')) {
        const changes = pending.reduce((all, item) => all.compose(item.changes), ChangeSet.empty(update.changes.length));
        if (changesOverlap(changes, update.changes)) throw conflict('The passage was edited while your changes were in flight. Your local copy has been kept.');
      }
      pending = rebaseUpdates(pending, [update]);
    }
    commit(pending);
    return events(body.version, body.epoch);
  }
  function trackResult(items, after, ranges) {
    const edits = resultEdits(ranges), id = randomUUID(), at = new Date().toISOString();
    const note = { id, text: 'Review this agent edit.', quote: '', para: null, off: 0, version: 1, resolved: false, at,
      work: { kind: 'rewrite', generation: 1, status: 'review', claim: null,
        attempts: [{ id: randomUUID(), agent: 'External agent', at, status: 'applied', edits, comment: 'Changed through the live session.' }] } };
    if (edits.length === 1) anchorPassage(note, after, edits[0].from, edits[0].to);
    items.push(note);
  }
  function patch(edits, expected, decorate) {
    refresh();
    const from = expected === disk.revision ? version() : Number(expected?.split(':')[1]);
    if (expected !== disk.revision && !expected?.startsWith(`${epoch}:`)) throw conflict('Document session changed. Read it before retrying.');
    const over = since(from, epoch);
    const original = documentAt(from).toString();
    const ranges = patchRanges(original, edits).map(range => ({ ...range, old: original.slice(range.from, range.to) }));
    for (const update of over) for (const range of ranges) {
      let touched = false;
      update.changes.iterChangedRanges((a, b) => {
        if (a === b ? a > range.from && a < range.to : a < range.to && b > range.from) touched = true;
      });
      if (touched) throw conflict('The passage was edited. Read it before proposing another patch.');
      range.from = update.changes.mapPos(range.from, 1);
      range.to = update.changes.mapPos(range.to, -1);
    }
    for (const range of ranges) if (doc.sliceString(range.from, range.to) !== range.old) throw conflict('The passage no longer matches.');
    if (!decorate && trackChanges) decorate = trackResult;
    commit([{ clientID: `agent:${randomUUID()}`, changes: ChangeSet.of(ranges.map(({ from, to, text }) => ({ from, to, insert: text })), doc.length) }], decorate && ((items, after) => decorate(items, after, ranges)));
    return snapshot();
  }
  function write(value, expected, { track = false } = {}) {
    refresh();
    if (typeof value !== 'string') throw bad('text is required');
    if (typeof expected !== 'string' || !expected) throw bad('revision is required');
    if (expected !== revision() && expected !== disk.revision) throw conflict('The file changed. Choose which copy to keep.');
    const change = textChange(doc.toString(), value);
    const changes = ChangeSet.of(change, doc.length);
    const range = { from: change.from, to: change.to, text: change.insert, old: doc.sliceString(change.from, change.to) };
    if (!changes.empty || !disk.exists) commit([{ changes, clientID: `snapshot:${randomUUID()}` }], track && !changes.empty ? (items, after) => trackResult(items, after, [range]) : undefined);
    return snapshot();
  }
  function updateNotes(body) {
    refresh();
    const over = since(body.version, body.epoch);
    if (!Array.isArray(body.operations) || body.operations.length > 1000) throw bad('Invalid note operations');
    const next = structuredClone(notes);
    for (const operation of body.operations) {
      if (operation.operationID && noteOperations.has(operation.operationID)) continue;
      if (operation.operationID !== undefined && (typeof operation.operationID !== 'string' || operation.operationID.length > 128)) throw bad('Invalid operation ID');
      const { id, note } = operation;
      if (typeof id !== 'string' || !id || id.length > 128) throw bad('Invalid note ID');
      const at = next.findIndex(item => item.id === id), existing = next[at];
      if (operation.type === 'resolve') {
        if (!existing) throw bad('Unknown note ID');
        existing.resolved = true;
        if (existing.work) { existing.work.status = 'done'; existing.work.claim = null; }
        // Resolution is monotonic and must not conflict with a pending text edit.
        continue;
      }
      if ((existing?.version ?? 0) !== (operation.expectedVersion ?? 0)) throw conflict('This note changed elsewhere. Its local copy has been kept.');
      if (operation.type === 'delete') { if (at >= 0) next.splice(at, 1); continue; }
      if (operation.type !== 'put' || !note || typeof note.text !== 'string' || !note.text.trim() || note.text.length > 20000
          || typeof note.quote !== 'string' || note.quote.length > 10000 || !(note.para === null || Number.isInteger(note.para) && note.para >= 0)
          || !Number.isInteger(note.off) || note.off < 0 || (note.length !== undefined && (!Number.isInteger(note.length) || note.length < 0 || note.length > MAX_DOCUMENT_BYTES))) throw bad('Invalid note');
      if (note.kind !== undefined && !['rewrite', 'idea'].includes(note.kind)) throw bad('Invalid note kind');
      const saved = { id, text: note.text, quote: note.quote, para: note.para, off: note.off, length: note.length,
        anchor: typeof note.anchor === 'string' ? note.anchor : undefined, kind: note.kind ?? existing?.kind, at: note.at, resolved: existing?.resolved === true || note.resolved === true, version: (existing?.version || 0) + 1 };
      saved.work = existing?.work ? structuredClone(existing.work) : undefined;
      if (!saved.resolved && (!existing || note.text !== existing.text)) queueNote(saved, note.kind || saved.work?.kind);
      let before = documentAt(body.version);
      for (const update of over) {
        const after = update.changes.apply(before);
        mapNoteAnchors([saved], before.toString(), after.toString(), update.changes); before = after;
      }
      if (at < 0) next.push(saved); else next[at] = saved;
    }
    saveNotes(next); notes = next; notesReady = true; notesVersion++;
    for (const operation of body.operations) if (operation.operationID) noteOperations.add(operation.operationID);
    while (noteOperations.size > 2000) noteOperations.delete(noteOperations.values().next().value);
    broadcast({ type: 'updates', ...events(version(), epoch) });
    return events(body.version, body.epoch);
  }
  function publishWork(next) {
    saveNotes(next); notes = next; notesReady = true; notesVersion++;
    broadcast({ type: 'updates', ...events(version(), epoch) });
    return snapshot();
  }
  function claimWork(agent) {
    refresh();
    if (typeof agent !== 'string' || !agent || agent.length > 128) throw bad('agent_id is required');
    const next = structuredClone(notes);
    for (const note of next) if (note.work?.status === 'working'
      && (note.work.claim.expires <= Date.now() || !note.work.claim.revision.startsWith(`${epoch}:`) || Number(note.work.claim.revision.split(':')[1]) < baseVersion)) queueNote(note);
    let note = next.find(note => note.work?.status === 'working' && note.work.claim.agent === agent);
    if (!note) {
      note = next.find(note => !note.resolved && note.text.trim() && (!note.work || note.work.status === 'queued'));
      if (!note) return null;
      if (!note.work) queueNote(note);
      let target;
      try { target = noteTarget(doc.toString(), note); }
      catch (error) { note.work.status = 'blocked'; note.work.error = error.message; publishWork(next); return null; }
      note.work.status = 'working';
      note.work.claim = { agent, token: randomUUID(), expires: Date.now() + 300000, revision: revision(), target };
      publishWork(next);
    }
    return { id: note.id, instruction: note.text, kind: note.work.kind, generation: note.work.generation,
      ...note.work.claim, messages: note.work.messages || [], text: documentAt(Number(note.work.claim.revision.split(':')[1])).toString() };
  }
  function finishWork(body) {
    refresh();
    if (typeof body.token !== 'string' || !body.token || body.token.length > 128) throw bad('A claim token is required');
    const note = notes.find(note => note.id === body.id);
    if (!note) throw bad('Unknown note ID');
    if (note.work?.attempts?.some(attempt => attempt.token === body.token)) return snapshot();
    const claim = note.work?.claim;
    if (!claim || claim.token !== body.token || claim.expires <= Date.now()) throw conflict('This work claim expired or was replaced.');
    if (body.comment !== undefined && (typeof body.comment !== 'string' || body.comment.length > 20000)) throw bad('Invalid work comment');
    if (body.error !== undefined) {
      if (typeof body.error !== 'string' || !body.error.trim() || body.error.length > 20000) throw bad('Invalid work error');
      const next = structuredClone(notes), own = next.find(item => item.id === body.id);
      own.work.status = 'blocked'; own.work.error = body.error; own.work.claim = null;
      return publishWork(next);
    }
    body = { ...body, edits: body.edits ?? [] };
    if (body.revision !== claim.revision) throw conflict('Submit work against its claimed revision.');
    if (!Array.isArray(body.edits) || body.edits.length > 100) throw bad('Expected up to 100 edits');
    since(Number(claim.revision.split(':')[1]), claim.revision.split(':')[0]);
    const original = documentAt(Number(claim.revision.split(':')[1])).toString();
    if (body.edits.length) {
      const ranges = patchRanges(original, body.edits);
      if (claim.target && ranges.some(range => range.from < claim.target.from || range.to > claim.target.to)) throw bad('Edits must stay inside the note target');
    } else if (!body.comment?.trim()) throw bad('Work needs edits or a comment');
    function completed(items, after, ranges = []) {
      const own = items.find(item => item.id === body.id);
      const edits = resultEdits(ranges);
      const attempt = { id: randomUUID(), token: body.token, agent: claim.agent, at: new Date().toISOString(), status: 'applied', edits, comment: body.comment || '' };
      // shortcut: retain ten attempts per note; use disk history for older text, add an event log if longer threads are needed.
      own.work.attempts = [...(own.work.attempts || []), attempt].slice(-10);
      own.work.status = 'review'; own.work.claim = null; own.work.error = null;
      if (own.quote && edits.length === 1) anchorPassage(own, after, edits[0].from, edits[0].to);
      else if (own.quote && edits.length) {
        const range = resolveNoteRange(after, own);
        if (range) anchorPassage(own, after, range.from, range.to);
      }
    }
    if (body.edits.length) return patch(body.edits, body.revision, completed);
    const next = structuredClone(notes); completed(next, doc.toString()); return publishWork(next);
  }
  function work(body) {
    refresh();
    const note = notes.find(note => note.id === body.id);
    if (!note) throw bad('Unknown note ID');
    if (body.generation !== note.work?.generation) throw conflict('This note changed. Review its current state.');
    const next = structuredClone(notes), own = next.find(note => note.id === body.id);
    const attempt = own.work?.attempts?.find(item => item.id === body.attempt);
    if (body.type === 'revert') {
      if (!reversible(attempt, doc.toString())) throw conflict('This passage changed. Its current text has been kept.');
      const changes = ChangeSet.of(attempt.edits.map(edit => ({ from: edit.from, to: edit.to, insert: edit.before })), doc.length);
      commit([{ clientID: `agent:${randomUUID()}`, changes }], (items, after) => {
        const own = items.find(note => note.id === body.id);
        own.work.attempts.find(item => item.id === body.attempt).status = 'undone';
        own.work.status = 'reverted'; own.work.claim = null; own.work.generation++;
        own.resolved = false;
        if (own.para !== null && attempt.edits.length === 1) {
          const from = changes.mapPos(attempt.edits[0].from, -1);
          anchorPassage(own, after, from, from + attempt.edits[0].before.length);
        }
      });
      return snapshot();
    }
    if (body.type === 'accept') {
      if (!attempt || attempt !== own.work.attempts.at(-1) || attempt.status !== 'applied' || own.work.status !== 'review') throw conflict('This result is no longer awaiting review.');
      attempt.status = 'accepted'; own.work.status = 'done'; own.work.claim = null; own.resolved = true;
    } else if (body.type === 'regenerate' || body.type === 'idea' || body.type === 'comment') {
      if (body.type === 'comment') {
        if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 20000) throw bad('A nonempty comment is required');
        own.work.messages = [...(own.work.messages || []), { role: 'user', text: body.text.trim(), at: new Date().toISOString() }].slice(-50);
      }
      if (own.quote) {
        const range = resolveNoteRange(doc.toString(), own);
        if (range && !range.bare) { own.quote = doc.sliceString(range.from, range.to); own.length = range.to - range.from; }
      }
      queueNote(own, body.type === 'idea' ? 'idea' : own.work?.kind);
    } else throw bad('Unknown work action');
    return publishWork(next);
  }
  function suggestNote(body) {
    refresh();
    if (body.revision !== revision()) throw conflict('Read the current draft before adding advice.');
    if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 20000
      || typeof body.agent_id !== 'string' || !body.agent_id || body.agent_id.length > 128) throw bad('Advice text and agent_id are required');
    const id = randomUUID(), note = { id, text: body.text, quote: body.quote || '', para: null, off: 0, at: new Date().toISOString(), version: 1, resolved: false };
    if (body.quote !== undefined) {
      const range = patchRanges(doc.toString(), [{ old: body.quote, new: body.quote, from: body.from }])[0];
      const paras = paragraphRanges(doc.toString());
      note.para = paras.findIndex(para => range.from >= para.from && range.from <= para.to);
      note.off = range.from - paras[note.para].from; note.length = range.to - range.from; note.anchor = doc.sliceString(paras[note.para].from, paras[note.para].to);
    }
    note.work = { kind: 'rewrite', status: 'review', generation: 1, claim: null,
      attempts: [{ id: randomUUID(), status: 'applied', edits: [], comment: body.text, agent: body.agent_id, at: note.at }] };
    publishWork([...notes, note]);
    return { id, revision: revision() };
  }
  const poll = setInterval(() => { try { refresh(); } catch {} }, 500);
  poll.unref();
  return {
    read() { refresh(); return snapshot(); }, push, patch, write, events, updateNotes, claimWork, finishWork, work, suggestNote,
    history: store.history,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    token,
    advertise(url) {
      const file = sessionFile(disk.path), existing = readSessionAddress(disk.path);
      if (existing?.token === token) return;
      if (existing) throw conflict('This document is already open in another Stilura server.');
      if (fs.existsSync(file)) fs.unlinkSync(file);
      const fd = fs.openSync(file, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, url: `${url}/draft/live?name=${encodeURIComponent(disk.path.split(/[\\/]/).pop())}`, token })); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
    },
    close() {
      clearInterval(poll);
      try { if (JSON.parse(fs.readFileSync(sessionFile(disk.path), 'utf8')).token === token) fs.unlinkSync(sessionFile(disk.path)); } catch {}
      listeners.clear();
    },
  };
}
