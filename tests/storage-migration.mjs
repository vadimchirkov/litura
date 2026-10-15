import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { documentStore } from '../document-store.js';
import { desktopStorage } from '../desktop.js';
import { openStorage } from '../src/storage.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stilura-migrate-'));
try {
  const file = path.join(directory, 'draft.md');
  fs.writeFileSync(file, 'Current draft.');
  const history = `${file}.litura-history`;
  fs.mkdirSync(history);
  const snapshot = { text: 'Previous draft.', at: new Date().toISOString(), revision: 'old' };
  fs.writeFileSync(path.join(history, '1-abc.json'), JSON.stringify(snapshot));
  fs.writeFileSync(`${file}.litura-notes.json`, JSON.stringify({ notes: [{ id: 'one', text: 'Keep this note.' }] }));
  fs.writeFileSync(`${file}.litura-session`, JSON.stringify({ pid: process.pid }));
  assert.throws(() => documentStore(file), /Close the previous editor/);
  assert(fs.existsSync(history), 'An active old editor must keep its history');
  assert(!fs.existsSync(`${file}.litura-lock`), 'A rejected migration must release its lock');
  fs.unlinkSync(`${file}.litura-session`);
  fs.mkdirSync(`${file}.stilura-history`);
  assert.throws(() => documentStore(file), /Both old and current/);
  assert(fs.existsSync(history), 'Conflicting histories must not overwrite each other');
  fs.rmdirSync(`${file}.stilura-history`);
  fs.writeFileSync(`${file}.litura-lock`, '');
  assert.throws(() => documentStore(file), { code: 'EEXIST' });
  fs.unlinkSync(`${file}.litura-lock`);
  const store = documentStore(file);
  assert.deepEqual(store.history(), [snapshot]);
  assert.equal(store.read().text, 'Current draft.');
  assert.equal(JSON.parse(fs.readFileSync(`${file}.stilura-notes.json`, 'utf8')).notes[0].text, 'Keep this note.');
  assert(!fs.existsSync(history));
  assert.deepEqual(documentStore(file).history(), [snapshot], 'Reopening must not repeat the migration');
  store.write('Updated draft.', store.read().revision);
  assert.equal(store.history().length, 2);

  const oldChat = '<litura-edits>[{"quote":"a","replacement":"b"}]</litura-edits>';
  const values = new Map([
    ['litura:doc:wa-working', 'Unsaved draft.'],
    ['litura:doc:wa-chat', oldChat],
    ['litura:doc:wa-brief', 'Old brief'],
    ['stilura:doc:wa-brief', 'Current brief'],
  ]);
  const browser = {
    get length() { return values.size; }, key: index => [...values.keys()][index],
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key),
  };
  await openStorage({ desktop: false, browser });
  assert.equal(values.get('stilura:doc:wa-working'), 'Unsaved draft.');
  assert.equal(values.get('stilura:doc:wa-chat'), oldChat.replaceAll('litura-edits', 'stilura-edits'));
  assert.equal(values.get('stilura:doc:wa-brief'), 'Current brief', 'Current state takes precedence');
  assert.equal(values.get('litura:doc:wa-working'), 'Unsaved draft.', 'Retain original browser state for recovery');
  values.set('stilura:doc:wa-working', 'New local edit.');
  await openStorage({ desktop: false, browser });
  assert.equal(values.get('stilura:doc:wa-working'), 'New local edit.');
  values.delete('stilura:doc:wa-working');
  await openStorage({ desktop: false, browser });
  assert(!values.has('stilura:doc:wa-working'), 'A deleted current draft must not resurrect from its old backup');

  const stateDir = path.join(directory, 'editor-state');
  fs.mkdirSync(stateDir);
  fs.writeFileSync(path.join(stateDir, 'a'.repeat(64) + '.json'), JSON.stringify({ key: 'litura:doc:wa-chat', value: oldChat }));
  const storage = desktopStorage(stateDir);
  assert.equal(new Map(storage.read()).get('stilura:doc:wa-chat'), oldChat.replaceAll('litura-edits', 'stilura-edits'));
  storage.write('stilura:doc:wa-chat', 'New chat');
  assert.equal(new Map(desktopStorage(stateDir).read()).get('stilura:doc:wa-chat'), 'New chat');
  storage.write('stilura:doc:wa-chat', null);
  assert(!new Map(storage.read()).has('stilura:doc:wa-chat'), 'A deleted desktop entry must not resurrect');
  assert(fs.existsSync(path.join(stateDir, 'a'.repeat(64) + '.json')), 'Retain original desktop state for recovery');
  console.log('Storage migration checks passed: active owners, conflicts, history, notes, browser drafts and desktop chats.');
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
