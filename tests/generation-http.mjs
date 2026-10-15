import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { build } from 'esbuild';

const root = new URL('../', import.meta.url).pathname;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stilura-generate-'));
const pi = fs.readFileSync(path.join(root, 'pi.js'), 'utf8');
const stub = pi.slice(0, pi.indexOf('export async function completeText(')) + String.raw`
export async function completeText({ systemPrompt, userPrompt }) {
  const selected = userPrompt.split('SELECTED TEXT:\n')[1]?.split('\n\nREQUEST:')[0];
  if (userPrompt.includes('REPLACE_PASSAGE')) return 'A calmer word.<stilura-edits>' + JSON.stringify([{ label: 'Replace', quote: selected, replacement: 'peaceful' }]) + '</stilura-edits>';
  if (userPrompt.includes('WRONG_SCOPE')) return '<stilura-edits>' + JSON.stringify([{ label: 'Replace', quote: 'Another quiet room.', replacement: 'Elsewhere.' }]) + '</stilura-edits>';
  if (userPrompt.includes('BROKEN_ENVELOPE')) return '<stilura-edits>[broken';
  return Buffer.from(JSON.stringify({ systemPrompt, userPrompt })).toString('base64');
}
export async function streamText({ systemPrompt, userPrompt, onText }) {
  const corrected = userPrompt.includes('\n\nCORRECTION:');
  if (userPrompt.includes('ECHO_WITH_NEW')) { onText('Opening context.\n\nA new passage.\n\nEnding context.'); return; }
  if (userPrompt.includes('ECHO_THEN_NEW')) { onText(corrected ? 'A fresh garden passage.' : 'Opening context.'); return; }
  if (userPrompt.includes('ALWAYS_ECHO')) { onText('Opening context.'); return; }
  if (userPrompt.includes('REGENERATE_NEW')) { onText(corrected ? 'A different garden grows.' : 'The old garden stays quiet.'); return; }
  if (userPrompt.includes('ALWAYS_PREVIOUS')) { onText('THE OLD GARDEN STAYS QUIET!'); return; }
  onText(JSON.stringify({ systemPrompt, userPrompt }));
  if (userPrompt.includes('TEST_FAILURE')) throw new Error('Simulated stream failure');
}`;
const bundle = path.join(directory, 'server.mjs');
await build({ entryPoints: [path.join(root, 'index.js')], outfile: bundle,
  bundle: true, packages: 'external', platform: 'node', format: 'esm',
  plugins: [{ name: 'generation-provider', setup(builder) {
    builder.onLoad({ filter: /\/pi\.js$/ }, () => ({ contents: stub, loader: 'js' }));
  } }],
});
// Keep external dependencies resolvable without copying credentials or a workspace.
fs.symlinkSync(path.join(root, 'node_modules'), path.join(directory, 'node_modules'));
const child = spawn(process.execPath, [bundle], { cwd: directory, env: { ...process.env,
  PORT: '0', STILURA_NO_OPEN: '1', STILURA_ROOT: root, STILURA_OFFLINE_MODELS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { output += chunk; });
try {
  const until = Date.now() + 10000;
  while (!/Stilura → http/.test(output)) {
    assert.equal(child.exitCode, null, output);
    if (Date.now() > until) throw new Error('Generation fixture failed to start');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const base = output.match(/Stilura → (http:\/\/[^\s]+)/)[1];
  const post = body => fetch(base + '/write', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const document = 'Opening context.\n\n/Write a garden scene.\n\nEnding context.';
  const input = { document, from: document.indexOf('/Write'), cursor: document.indexOf('\n\nEnding'), instruction: 'Write a garden scene.' };
  const response = await post(input);
  assert.equal(response.status, 200);
  const events = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6));
  assert.equal(events.at(-1), '[DONE]');
  const prompt = JSON.parse(JSON.parse(events[0]).text);
  assert.match(prompt.systemPrompt, /never repeat or rewrite the surrounding draft/);
  assert.match(prompt.userPrompt, /TEXT BEFORE INSERTION:\nOpening context/);
  assert.match(prompt.userPrompt, /TEXT AFTER INSERTION:\n\n\nEnding context/);
  assert.match(prompt.userPrompt, /AUTHOR'S REQUEST:\nWrite a garden scene/);
  assert.doesNotMatch(prompt.userPrompt, /\/write/);
  for (const bad of [{ ...input, instruction: '' }, { ...input, instruction: 'x'.repeat(10001) },
    { ...input, from: input.cursor + 1 }, { ...input, cursor: -1 }, { ...input, instruction: [] }, { ...input, cursor: undefined }, { ...input, previous: [] }, { ...input, previous: 'x'.repeat(20001) }]) {
    assert.equal((await post(bad)).status, 400);
  }
  const stream = async input => {
    const response = await post(input);
    return (await response.text()).split('\n').filter(line => line.startsWith('data: '))
      .map(line => line.slice(6) === '[DONE]' ? 'DONE' : JSON.parse(line.slice(6)));
  };
  const echoed = await stream({ ...input, instruction: 'ECHO_WITH_NEW' });
  assert.deepEqual(echoed.at(-2), { replace: 'A new passage.' });
  assert.equal(echoed.at(-1), 'DONE');
  const recovered = await stream({ ...input, instruction: 'ECHO_THEN_NEW' });
  assert.equal(recovered.filter(event => event.replace === '').length, 1);
  assert.equal(recovered.at(-2).text, 'A fresh garden passage.');
  assert.equal(recovered.at(-1), 'DONE');
  const repeated = await stream({ ...input, instruction: 'ALWAYS_ECHO' });
  assert.equal(repeated.filter(event => event.text === 'Opening context.').length, 2);
  assert.match(repeated.at(-1).error, /already in the draft/);
  assert(!repeated.includes('DONE'));
  const previous = 'The old garden stays quiet.';
  const regenerated = await stream({ ...input, instruction: 'REGENERATE_NEW', previous });
  assert.equal(regenerated.filter(event => event.replace === '').length, 1);
  assert.equal(regenerated.at(-2).text, 'A different garden grows.');
  assert.equal(regenerated.at(-1), 'DONE');
  const unchanged = await stream({ ...input, instruction: 'ALWAYS_PREVIOUS', previous });
  assert.equal(unchanged.filter(event => event.text === 'THE OLD GARDEN STAYS QUIET!').length, 2);
  assert.match(unchanged.at(-1).error, /previous suggestion/);
  assert(!unchanged.includes('DONE'));
  const promptEvents = await stream({ ...input, previous });
  const regenPrompt = JSON.parse(promptEvents[0].text);
  assert.match(regenPrompt.userPrompt, /PREVIOUS SUGGESTION TO REPLACE/);
  assert(regenPrompt.userPrompt.includes(previous));
  const failed = await post({ ...input, instruction: 'TEST_FAILURE' });
  const failure = await failed.text();
  assert.match(failure, /"error":"Simulated stream failure"/);
  assert.doesNotMatch(failure, /\[DONE\]/);
  const ask = body => fetch(base + '/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const passage = { document: 'A quiet room. Another quiet room.', selected: 'quiet', from: 2, instruction: 'What does this word imply?' };
  const asked = await ask(passage);
  assert.equal(asked.status, 200);
  const answer = await asked.json();
  assert.deepEqual(Object.keys(answer), ['answer', 'variants']);
  assert.deepEqual(answer.variants, []);
  const askedPrompt = JSON.parse(Buffer.from(answer.answer, 'base64').toString());
  assert.match(askedPrompt.systemPrompt, /Answer questions briefly/);
  assert.match(askedPrompt.userPrompt, /REQUEST:\nWhat does this word imply/);
  assert(askedPrompt.userPrompt.includes('A ⟦quiet⟧ room. Another quiet room.'));
  for (const bad of [{ ...passage, from: -1 }, { ...passage, from: 3 }, { ...passage, selected: [] },
    { ...passage, document: [] }, { ...passage, instruction: [] }, { ...passage, instruction: '' },
    { ...passage, instruction: 'x'.repeat(4001) }, { document: 'x'.repeat(10001), selected: 'x'.repeat(10001), from: 0, instruction: 'Why?' }]) {
    assert.equal((await ask(bad)).status, 400);
  }
  const replaced = await ask({ ...passage, instruction: 'REPLACE_PASSAGE' });
  assert.equal(replaced.status, 200);
  assert.deepEqual(await replaced.json(), { answer: 'A calmer word.', variants: ['peaceful'] });
  assert.equal((await ask({ ...passage, instruction: 'WRONG_SCOPE' })).status, 502);
  assert.equal((await ask({ ...passage, instruction: 'BROKEN_ENVELOPE' })).status, 502);
  assert(!fs.existsSync(path.join(directory, 'draft.md')), 'Questions never create or edit the draft');
  console.log('Generation HTTP checks passed: context echoes, bounded correction, regeneration, streaming replacement and partial failures.');
} finally {
  const closed = once(child, 'exit');
  child.kill();
  await closed;
  fs.rmSync(directory, { recursive: true, force: true });
}
