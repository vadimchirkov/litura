import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { connectMcp, closeMcpConnections } from '../mcp.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stilura-mcp-'));
const configFile = path.join(dir, 'mcp.json');
const calls = [], requests = [], streams = new Set();
let initializations = 0, listings = 0, mode = 'success', abortedCall, child;
const toolServer = createServer(async (req, res) => {
  assert.equal(req.headers.authorization, 'Bearer test-token');
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': connected\n\n');
    streams.add(res); res.on('close', () => streams.delete(res)); return;
  }
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  if (body.id === undefined) { res.writeHead(202); res.end(); return; }
  let result;
  if (body.method === 'initialize') {
    initializations++;
    result = { protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'test-notes', version: '1' } };
  } else if (body.method === 'tools/list') {
    listings++;
    result = { tools: [{ name: body.params?.cursor ? 'get' : 'search', description: 'Read notes',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }],
      ...(body.params?.cursor ? {} : { nextCursor: 'page2' }) };
  } else if (body.method === 'tools/call') {
    calls.push(body.params);
    if (mode === 'abort') { abortedCall?.(); return; }
    result = { content: [{ type: 'text', text: mode === 'error' ? 'Note query failed' : 'The author prefers short sentences.' }], isError: mode === 'error' };
  } else { res.writeHead(400); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
});
const modelServer = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); requests.push(body);
  const hasResult = mode !== 'loop' && body.messages.some(message => message.role === 'tool');
  const wantsTool = body.tools?.length && !hasResult;
  const delta = wantsTool
    ? { content: 'Checking notes.<stilura-edits>unverified', tool_calls: [{ index: 0, id: 'call-search', type: 'function',
        function: { name: mode === 'unknown' ? 'mcp_notes_get' : 'mcp_notes_search', arguments: '{"query":"writing preferences"}' } }] }
    : { content: hasResult ? 'Use short sentences.' : 'Plain answer.' };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = choices => ({ id: 'test', object: 'chat.completion.chunk', created: 0, model: 'model', choices });
  res.write(`data: ${JSON.stringify(chunk([{ index: 0, delta, finish_reason: null }]))}\n\n`);
  res.end(`data: ${JSON.stringify(chunk([{ index: 0, delta: {}, finish_reason: wantsTool ? 'tool_calls' : 'stop' }]))}\n\ndata: [DONE]\n\n`);
});
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
await listen(toolServer); await listen(modelServer);
const entry = { url: `http://127.0.0.1:${toolServer.address().port}/mcp`, headers: { Authorization: 'Bearer test-token' },
  tools: ['search'], instructions: 'Search notes before using facts from them.' };
fs.writeFileSync(configFile, JSON.stringify({ mcpServers: { notes: entry } }));
fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({ providers: { test: {
  baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1`, api: 'openai-completions', apiKey: 'test-key',
  models: [{ id: 'model', name: 'Test', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 8000 }],
} } }));
Object.assign(process.env, { PI_CODING_AGENT_DIR: dir, PI_PROVIDER: 'test', PI_MODEL: 'model',
  STILURA_OFFLINE_MODELS: '1', PI_OFFLINE: '1', STILURA_MCP_CONFIG: configFile });
const { streamText } = await import('../pi.js');
const invoke = async (options = {}) => {
  let text = '', resets = 0;
  await streamText({ systemPrompt: 'Help write.', messages: [{ role: 'user', content: 'Use my writing preferences.' }],
    mcp: true, signal: AbortSignal.timeout(10_000), onText: part => { text += part; },
    onReset: () => { text = ''; resets++; }, ...options });
  return { text, resets };
};
try {
  assert.equal(await connectMcp(undefined, path.join(dir, 'missing.json')), null);
  assert.equal(initializations, 0);
  const connection = await connectMcp(undefined, configFile);
  assert.deepEqual(connection.tools.map(tool => tool.name), ['mcp_notes_search']);
  assert.match(connection.instructions, /Search notes before using facts/);
  assert.equal(initializations, 1); assert.equal(listings, 2);
  await assert.rejects(connection.call('mcp_notes_get', {}), /Unknown MCP tool/);
  assert.deepEqual(await invoke(), { text: 'Use short sentences.', resets: 1 });
  assert.equal(initializations, 1); assert.equal(listings, 2);
  assert.deepEqual(requests[0].tools.map(tool => tool.function.name), ['mcp_notes_search']);
  assert.deepEqual(calls.at(-1), { name: 'search', arguments: { query: 'writing preferences' } });
  assert.match(requests.at(-1).messages.find(message => message.role === 'tool').content, /prefers short sentences/);
  assert(requests.at(-1).messages.some(message => message.role === 'assistant' && message.tool_calls?.[0].id === 'call-search'));
  assert.deepEqual(await invoke({ mcp: false }), { text: 'Plain answer.', resets: 0 });
  assert.equal(requests.at(-1).tools, undefined);
  mode = 'error';
  assert.equal((await invoke()).text, 'Use short sentences.');
  assert.match(requests.at(-1).messages.find(message => message.role === 'tool').content, /Note query failed/);
  for (const stream of streams) stream.write('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n');
  await new Promise(resolve => setTimeout(resolve, 30));
  await connectMcp(undefined, configFile); assert.equal(listings, 4);
  mode = 'unknown'; await assert.rejects(invoke(), /Unknown MCP tool/);
  mode = 'abort';
  const controller = new AbortController(), started = new Promise(resolve => { abortedCall = resolve; });
  const pending = assert.rejects(invoke({ signal: controller.signal }), /abort/i);
  await started; controller.abort(); await pending;
  mode = 'success';
  assert.equal((await invoke()).text, 'Use short sentences.');
  assert.equal(initializations, 1, 'Cancellation must not close shared connections');
  await closeMcpConnections();
  assert.equal((await invoke()).text, 'Use short sentences.'); assert.equal(initializations, 2);
  const extra = path.join(dir, 'extra.json');
  fs.writeFileSync(extra, JSON.stringify({ mcpServers: { notes: entry, archive: { ...entry, tools: ['get'] } } }));
  const multi = await connectMcp(undefined, extra);
  assert.deepEqual(multi.tools.map(tool => tool.name), ['mcp_notes_search', 'mcp_archive_get']);
  await multi.call('mcp_archive_get', { query: 'one note' }); assert.equal(calls.at(-1).name, 'get');
  assert.equal(initializations, 2, 'Two names for the same connection must share its client');
  mode = 'loop'; await assert.rejects(invoke(), /tool limit/); mode = 'success';
  child = spawn(process.execPath, ['index.js'], { cwd: new URL('../', import.meta.url),
    env: { ...process.env, DRAFT_FILE: path.join(dir, 'draft.md'), PORT: '0', STILURA_NO_OPEN: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const deadline = Date.now() + 10_000;
  while (!/Stilura → http/.test(output)) {
    assert.equal(child.exitCode, null, output);
    if (Date.now() > deadline) throw new Error('MCP HTTP fixture failed to start.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const endpoint = output.match(/Stilura → (http:\/\/[^\s]+)/)[1];
  const instruction = 'Use my writing preferences.', document = '/' + instruction;
  const response = await fetch(endpoint + '/write', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ document, instruction, from: 0, cursor: document.length }) });
  assert.equal(response.status, 200);
  const events = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6));
  assert.equal(events.at(-1), '[DONE]'); let passage = '', resets = 0;
  for (const raw of events.slice(0, -1)) {
    const event = JSON.parse(raw); assert.equal(event.error, undefined);
    if (typeof event.replace === 'string') { passage = event.replace; resets++; } else passage += event.text ?? '';
  }
  assert.equal(passage, 'Use short sentences.'); assert.equal(resets, 1);
  const beforeRepeat = calls.length;
  const repeated = await fetch(endpoint + '/write', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ document, instruction, from: 0, cursor: document.length, previous: 'Use short sentences.' }) });
  assert.match(await repeated.text(), /repeated the previous suggestion/);
  assert.equal(calls.length - beforeRepeat, 1, 'Correction must not repeat external tool calls');
  const callCount = calls.length, requestCount = requests.length;
  const chat = await fetch(endpoint + '/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ document: 'An author draft.', messages: [{ role: 'user', content: 'Use notes.' }] }) });
  assert.equal(chat.status, 410); assert.equal(requests.length, requestCount); assert.equal(calls.length, callCount);
  for (const [config, error] of [
    [{ mcpServers: { notes: { url: 'http://example.com/mcp' } } }, /HTTPS/],
    [{ mcpServers: { notes: { ...entry, tools: 'search' } } }, /list of names/],
    [{ mcpServers: { notes: { ...entry, tools: ['missing'] } } }, /not found/],
    [{ mcpServers: [] }, /object/],
  ]) { fs.writeFileSync(extra, JSON.stringify(config)); await assert.rejects(connectMcp(undefined, extra), error); }
  fs.writeFileSync(extra, '{'); await assert.rejects(connectMcp(undefined, extra), /configuration/);
  fs.writeFileSync(extra, '{"mcpServers":{"notes":{"enabled":false}}}'); assert.equal(await connectMcp(undefined, extra), null);
  console.log('MCP checks passed: external configuration, tool allowlists, namespaces, multiple connections, reuse, catalog invalidation, auth, streaming, chat isolation, cancellation and validation.');
} finally {
  if (child && child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
  await closeMcpConnections(); toolServer.closeAllConnections(); modelServer.closeAllConnections();
  await Promise.all([new Promise(resolve => toolServer.close(resolve)), new Promise(resolve => modelServer.close(resolve))]);
  fs.rmSync(dir, { recursive: true, force: true });
}
