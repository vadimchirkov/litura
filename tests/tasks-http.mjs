import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { patchRanges } from '../editing.js';

assert.deepEqual(patchRanges('A B A', [{ old: 'A', new: 'B', all: true }, { old: 'B', new: 'C' }]), [
  { from: 0, to: 1, text: 'B' }, { from: 2, to: 3, text: 'C' }, { from: 4, to: 5, text: 'B' },
]);
assert.deepEqual(patchRanges('😀 word', [{ old: 'word', new: '$&', from: 3 }]), [{ from: 3, to: 7, text: '$&' }]);
assert.deepEqual(patchRanges('aa aa', [{ old: 'aa', new: '', all: true }]), [{ from: 0, to: 2, text: '' }, { from: 3, to: 5, text: '' }]);
assert.throws(() => patchRanges('aaa', [{ old: 'aa', new: 'b' }]), /ambiguous/);
assert.throws(() => patchRanges('abc', [{ old: 'abc', new: 'x' }, { old: 'bc', new: 'y' }]), /overlap/);
assert.throws(() => patchRanges('abc', [{ old: 'a', new: 'x', from: 0, all: true }]), /not both/);
assert.throws(() => patchRanges('abc', []), /At least/);
assert.throws(() => patchRanges('a'.repeat(10_001), [{ old: 'a', new: 'b', all: true }]), /10,000/);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stilura-tasks-http-'));
const draftFile = path.join(dir, 'draft.md');
fs.writeFileSync(draftFile, 'Seeded draft for HTTP tests.\n');
const requests = [];
const modelServer = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const payload = JSON.parse(body);
  requests.push(payload);
  if (body.includes('FAIL_TEST')) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Test authentication failure' } }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const content = body.includes('inline writing assistant')
    ? body.includes('FORMAT_STAYS_BAD') ? 'Unlabeled answer' : body.includes('FORMAT CORRECTION') ? 'TEXT: and continued' : 'Unlabeled answer'
    : body.includes('Help with the SELECTED TEXT') ? '<stilura-edits>' + JSON.stringify([{ quote: 'quiet', replacement: 'peaceful', label: 'Synonym' }]) + '</stilura-edits>'
    : JSON.stringify(['A clearer passage.', 'A sharper passage.', 'A shorter passage.']);
  const chunk = { id: 'test', object: 'chat.completion.chunk', created: 0, model: 'model', choices: [{ index: 0, delta: { content }, finish_reason: null }] };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  chunk.choices = [{ index: 0, delta: {}, finish_reason: 'stop' }];
  res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
});
await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({ providers: {
  test: { baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1`, api: 'openai-completions', apiKey: 'test-key',
    models: [{ id: 'model', name: 'Test', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 8000 }] },
} }));

let httpChild;
const timeout = setTimeout(() => { httpChild?.kill(); console.error('HTTP task test timed out'); process.exit(1); }, 60_000);
try {
  httpChild = spawn(process.execPath, ['index.js'], {
    cwd: new URL('../', import.meta.url), stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, DRAFT_FILE: draftFile, PORT: '0', STILURA_NO_OPEN: '1',
      PI_CODING_AGENT_DIR: dir, PI_PROVIDER: 'test', PI_MODEL: 'model', STILURA_OFFLINE_MODELS: '1', PI_OFFLINE: '1' },
  });
  const endpoint = await new Promise((resolve, reject) => {
    let output = '';
    httpChild.once('error', reject);
    httpChild.stdout.on('data', chunk => {
      output += chunk;
      const match = /Stilura → (http:\/\/[^\s]+)/.exec(output);
      if (match) resolve(match[1]);
    });
  });
  const rewriteInput = { document: 'A quiet room. Another quiet room.', selected: 'quiet', from: 2,
    instruction: 'Use a simpler word.', context: 'For a young reader.' };
  const extensionOrigin = 'chrome-extension://' + 'a'.repeat(32);
  const connection = await fetch(endpoint + '/api/extension/connection');
  assert.equal(connection.headers.get('cache-control'), 'no-store');
  const { token } = await connection.json();
  assert.match(token, /^[a-f0-9]{64}$/);
  const extensionHeaders = { Origin: extensionOrigin, 'X-Stilura-Extension': token, 'Content-Type': 'application/json' };
  for (const route of ['/api/extension/connection', '/draft', '/files', '/api/agent/credentials', '/api/desktop/storage']) {
    assert.equal((await fetch(endpoint + route, { headers: extensionHeaders })).status, 403, route);
  }
  assert.equal((await fetch(endpoint + '/api/extension/connection', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(endpoint + '/api/extension/connection', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(endpoint + '/api/agent/status', { headers: { Origin: extensionOrigin } })).status, 403);
  assert.equal((await fetch(endpoint + '/api/agent/status', { headers: { ...extensionHeaders, 'X-Stilura-Extension': 'bad' } })).status, 403);
  assert.equal((await fetch(endpoint + '/api/agent/status', { headers: { ...extensionHeaders, Origin: 'https://evil.example' } })).status, 403);
  const preflight = await fetch(endpoint + '/rewrite', { method: 'OPTIONS', headers: {
    Origin: extensionOrigin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-stilura-extension',
  } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), extensionOrigin);
  assert.equal((await fetch(endpoint + '/rewrite', { method: 'OPTIONS', headers: {
    Origin: extensionOrigin, 'Access-Control-Request-Method': 'DELETE',
  } })).status, 403);
  assert.equal((await fetch(endpoint + '/api/agent/status?unexpected=1', { headers: extensionHeaders })).status, 403);
  assert.equal((await fetch(endpoint + '/rewrite', { headers: extensionHeaders })).status, 405);
  assert.equal((await fetch(endpoint + '/api/agent/status', { headers: extensionHeaders })).status, 200);
  const extensionRewrite = await fetch(endpoint + '/rewrite', { method: 'POST', headers: extensionHeaders, body: JSON.stringify(rewriteInput) });
  assert.equal(extensionRewrite.status, 200);
  assert.equal((await extensionRewrite.json()).variants.length, 3);
  const extensionAsk = await fetch(endpoint + '/ask', { method: 'POST', headers: extensionHeaders, body: JSON.stringify(rewriteInput) });
  assert.equal(extensionAsk.status, 200);
  assert.deepEqual((await extensionAsk.json()).variants, ['peaceful']);
  assert.equal((await fetch(endpoint + '/ask', { method: 'POST', headers: extensionHeaders,
    body: JSON.stringify({ ...rewriteInput, from: 0 }) })).status, 400);
  const httpRewrite = await fetch(endpoint + '/rewrite', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rewriteInput),
  });
  assert.equal(httpRewrite.status, 200);
  assert.equal((await httpRewrite.json()).variants.length, 3);
  const prompt = JSON.stringify(requests.at(-1).messages);
  assert(prompt.includes('A ⟦quiet⟧ room. Another quiet room.'));
  assert(prompt.includes('Match the tone and flow'));
  const suggestHTTP = document => fetch(endpoint + '/suggest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ document }) });
  let beforeSuggestions = requests.length;
  const repaired = await suggestHTTP('Draft ending here');
  assert.equal(repaired.status, 200);
  assert.equal((await repaired.json()).suggestion, ' and continued');
  assert.equal(requests.length - beforeSuggestions, 2);
  beforeSuggestions = requests.length;
  const invalid = await suggestHTTP('FORMAT_STAYS_BAD');
  assert.equal(invalid.status, 500);
  const invalidBody = await invalid.json();
  assert.equal(invalidBody.code, 'SUGGESTION_FORMAT');
  assert.equal(invalidBody.attempts, 2);
  assert.equal(requests.length - beforeSuggestions, 2);

  console.log('HTTP task checks passed: patch validation, rewrite prompts, extension authentication/route isolation and bounded suggestion recovery with a local model stub.');
} finally {
  clearTimeout(timeout);
  httpChild?.kill();
  await new Promise(resolve => modelServer.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
}
