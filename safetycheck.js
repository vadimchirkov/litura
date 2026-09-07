import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { documentStore } from './document-store.js';
import { replacementTarget, newerVersion, wordDiff } from './editing.js';
import { mergeReviewFindings, locateFindings } from './review.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'litura-safety-'));
const filename = path.join(temp, 'draft.md');
const store = documentStore(filename);
assert.equal(store.read().revision, 'missing');
const empty = store.write('', 'missing');
assert.notEqual(empty.revision, 'missing');
assert.equal(empty.exists, true);
const first = store.write('Первый текст 🌱', empty.revision);
assert.equal(store.read().text, 'Первый текст 🌱');
assert.throws(() => store.write('stale tab', empty.revision), error => error.status === 409);
assert.equal(store.read().text, first.text);
fs.writeFileSync(filename, 'external edit');
assert.throws(() => store.write('overwrite', first.revision), error => error.status === 409);
const second = store.write('confirmed replacement', store.read().revision);
assert(store.history().some(item => item.text === 'external edit'));
assert(store.history().some(item => item.text === ''));
assert.notEqual(documentStore(path.join(temp, 'other.md')).read().id, second.id);
const alias = path.join(temp, 'alias.md');
fs.symlinkSync(filename, alias);
assert.equal(documentStore(alias).read().id, second.id);
assert.throws(() => store.write(null, second.revision), error => error.status === 400);
assert.throws(() => store.write('x'.repeat(1024 * 1024 + 1), second.revision), error => error.status === 413);
assert.equal(store.read().text, 'confirmed replacement');

const document = 'Alpha passage. Beta passage.';
const target = { document, from: 0, to: 5, text: 'Alpha' };
assert(replacementTarget(document, target));
assert(!replacementTarget('New ' + document, target));
assert(!replacementTarget(document, { ...target, from: 15 }));
assert(!replacementTarget(document, { ...target, text: undefined }));
assert(newerVersion('0.10.0', '0.2.0'));
assert(!newerVersion('0.1.9', '0.2.0'));
assert(!newerVersion('0.2.0', '0.2.0'));
assert(!newerVersion('0.3.0-beta', '0.2.0'));
// The widget renders the ops in order, so they have to reconstruct both sides.
for (const [before, after] of [
  ['Hello old world', 'Hello new world'],
  ['🌱', '🌿'],
  ['a b c', 'a x c'],
  ['one two', 'one two three'],
  ['same', 'same'],
  ['', 'new text'],
  ['drop this tail', 'drop this'],
  ['the team shipped it in March', 'the team shipped the thing in April'],
]) {
  const ops = wordDiff(before, after);
  assert.equal(ops.filter(op => op.type !== 'ins').map(op => op.text).join(''), before, `before ${JSON.stringify(before)}`);
  assert.equal(ops.filter(op => op.type !== 'del').map(op => op.text).join(''), after, `after ${JSON.stringify(after)}`);
}
// Changes in two places stay separate steps — a single run would animate as
// one block. The untouched space between "the" and "thing" splits that pair,
// which is why three runs and not two.
assert.equal(wordDiff('the team shipped it in March', 'the team shipped the thing in April').filter(op => op.type === 'ins').length, 3);
assert.deepEqual(wordDiff('same', 'same'), [{ type: 'keep', text: 'same' }]);

assert.equal(locateFindings('Shared quote.', [{ code: 'generic-prose', quote: 'Shared quote.' }, { code: 'level-7-paragraph-flow', quote: 'Shared quote.' }]).length, 2);
const globals = Array.from({ length: 8 }, (_, i) => ({ code: 'level-1-whole-essay', quote: `quote-${i}` }));
assert.equal(mergeReviewFindings([globals, [{ code: 'generic-prose', quote: 'local' }]]).length, 9);

// Real HTTP server, disposable draft, no provider calls or credential changes.
const child = spawn(process.execPath, ['index.js'], {
  cwd: import.meta.dirname,
  env: { ...process.env, PORT: '0', DRAFT_FILE: filename, LITURA_NO_OPEN: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stderr.on('data', chunk => { output += chunk; });
try {
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server did not start: ' + output)), 20_000);
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/Litura → (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${output}`)); });
  });
  const request = (route, method = 'POST', body = {}, headers = {}) => fetch(url + route, {
    method, headers: { 'Content-Type': 'application/json', ...headers },
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal((await request('/', 'GET')).status, 200);
  assert.equal((await request('/', 'HEAD')).status, 405);
  assert.equal((await request('/review', 'POST', null)).status, 400);
  assert.equal((await request('/review', 'POST', [])).status, 400);
  assert.equal((await request('/review', 'POST', { document: {} })).status, 400);
  assert.equal((await request('/review', 'POST', { document: '' }, { Origin: 'https://evil.example' })).status, 403);
  const invalidHostStatus = await new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  assert.equal(invalidHostStatus, 403);
  assert.equal((await request('/review', 'POST', {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await request('/review', 'POST', { document: '' })).status, 200);
  assert.equal((await request('/review', 'POST', { document: 'x'.repeat(60_001) })).status, 413);
  assert.equal((await request('/rewrite', 'POST', { document, selected: 'Beta', from: 0 })).status, 400);
  assert.equal((await request('/draft', 'PUT', null)).status, 400);
  assert.equal((await request('/draft', 'PUT', { text: 'must not save' })).status, 400);
  assert.equal((await request('/draft', 'PUT', { text: 'must not save', revision: 'stale' })).status, 409);
  assert.equal(store.read().text, second.text);
  const saved = await request('/draft', 'PUT', { text: 'Saved through HTTP', revision: second.revision });
  assert.equal(saved.status, 200);
  assert.equal(store.read().text, 'Saved through HTTP');
  assert((await (await request('/draft/history', 'GET')).json()).snapshots.length > 0);
  assert.equal((await request('/draft', 'GET')).status, 200);
  console.log('Safety checks passed: workspace identity, CAS, recovery, rewrite scope, versions, HTTP validation and origin protection.');
} finally {
  child.kill('SIGTERM');
  if (child.exitCode === null) await once(child, 'exit');
  fs.rmSync(temp, { recursive: true, force: true }); // Only this test's mkdtemp directory.
}
