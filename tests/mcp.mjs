import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Drive mcp-server.mjs over stdio with raw JSON-RPC (one message per line,
// the framing StdioServerTransport speaks). Model-backed tools are exercised
// only where they answer without a model call.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stilura-mcp-'));
const draftFile = path.join(dir, 'draft.md');
fs.writeFileSync(draftFile, 'Seeded draft for MCP tests.\n');

const child = spawn(process.execPath, ['mcp-server.mjs'], {
  cwd: new URL('../', import.meta.url),
  env: { ...process.env, DRAFT_FILE: draftFile },
  stdio: ['pipe', 'pipe', 'inherit'],
});
const pending = new Map();
let nextId = 1, buffer = '';
child.stdout.on('data', chunk => {
  buffer += chunk.toString('utf8');
  let line;
  while ((line = buffer.indexOf('\n')) >= 0) {
    const raw = buffer.slice(0, line).trim();
    buffer = buffer.slice(line + 1);
    if (!raw) continue;
    const message = JSON.parse(raw);
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  }
});
const send = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, resolve);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...params }) + '\n', error => {
    if (error) { pending.delete(id); reject(error); }
  });
});
const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, ...params }) + '\n');
const call = async (name, args) => {
  const res = await send('tools/call', { params: { name, arguments: args } });
  assert(!res.error, `${name}: ${JSON.stringify(res.error)}`);
  assert.equal(res.result.isError, undefined, `${name} unexpectedly failed: ${JSON.stringify(res.result)}`);
  return JSON.parse(res.result.content[0].text);
};
const callError = async (name, args) => {
  const res = await send('tools/call', { params: { name, arguments: args } });
  assert(!res.error, `${name}: ${JSON.stringify(res.error)}`);
  assert.equal(res.result.isError, true, `${name} should have failed`);
  return JSON.parse(res.result.content[0].text);
};
const timeout = setTimeout(() => { console.error('MCP test timed out'); process.exit(1); }, 60_000);

try {
  const init = await send('initialize', {
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'stilura-mcp-test', version: '0.0.0' },
    },
  });
  assert.equal(init.result.serverInfo.name, 'stilura');
  assert(init.result.capabilities.tools, 'server must advertise tools');
  notify('notifications/initialized', {});

  const list = await send('tools/list', {});
  const names = list.result.tools.map(tool => tool.name).sort();
  assert.deepEqual(names, ['chat', 'draft_read', 'draft_write', 'idea', 'review', 'rewrite', 'suggest']);

  const read = await call('draft_read', {});
  assert.equal(read.text, 'Seeded draft for MCP tests.\n');
  assert.equal(typeof read.revision, 'string');

  const written = await call('draft_write', { text: 'Edited through MCP.\n', revision: read.revision });
  assert.equal(written.saved, true);
  assert.equal(written.text, 'Edited through MCP.\n');

  const stale = await callError('draft_write', { text: 'Stale overwrite.\n', revision: read.revision });
  assert.match(stale.error, /changed|revision|keep/i);
  assert.equal(stale.current.text, 'Edited through MCP.\n');

  const empty = await call('review', { document: '   ' });
  assert.deepEqual(empty.findings, []);

  const mismatch = await callError('rewrite', { selected: 'absent passage', document: 'Edited through MCP.\n' });
  assert.match(mismatch.error, /match/i);

  const unknown = await send('tools/call', { params: { name: 'nope', arguments: {} } });
  assert(unknown.error || unknown.result?.isError, 'unknown tool must fail');

  console.log('MCP checks passed: handshake, tool list, draft read/write, revision guard, model-free review/rewrite paths.');
} finally {
  clearTimeout(timeout);
  child.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}
