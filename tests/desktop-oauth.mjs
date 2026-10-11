import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const root = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stilura-oauth-bundle-'));
const auth = path.join(temp, 'auth');
fs.mkdirSync(auth);
// Fresh synthetic credentials trigger OAuth derivation without login, refresh or network.
fs.writeFileSync(path.join(auth, 'auth.json'), JSON.stringify({
  'openai-codex': { type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh', expires: Date.now() + 3600_000 },
  openai: { type: 'api_key', key: 'fixture-api-key' },
}));
fs.copyFileSync(process.argv[2] || path.join(root, 'dist/server.mjs'), path.join(temp, 'server.mjs'));
fs.copyFileSync(path.join(root, 'package.json'), path.join(temp, 'package.json'));
const child = spawn(process.execPath, [path.join(temp, 'server.mjs')], {
  cwd: temp, stdio: ['pipe', 'pipe', 'pipe'],
  env: { PATH: process.env.PATH, HOME: temp, PI_CODING_AGENT_DIR: auth, PORT: '0',
    STILURA_SIDECAR: '1', STILURA_OFFLINE_MODELS: '1', STILURA_ROOT: temp, DRAFT_FILE: path.join(temp, 'draft.md') },
});
let output = '';
child.stderr.on('data', chunk => { output += chunk; });
try {
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Bundled server startup timed out: ' + output)), 15000);
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/STILURA_READY (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(Error(`Bundled server exited ${code}: ${output}`)); });
  });
  const response = await fetch(url + '/api/agent/status', { signal: AbortSignal.timeout(15000) });
  const status = await response.json();
  assert.equal(response.status, 200, status.error);
  for (const provider of ['openai-codex', 'openai']) {
    assert(status.models.some(model => model.provider === provider), `${provider} unavailable in standalone bundle: ${JSON.stringify(status)}`);
  }
  const oauth = await (await fetch(url + '/api/agent/oauth/status')).json();
  assert(oauth.supported.some(provider => provider.id === 'openai-codex' && provider.configured));
  assert.doesNotMatch(output, /Cannot find module|OAuth auth derivation failed/);
  console.log('Desktop OAuth checks passed: standalone bundle, Codex OAuth derivation and OpenAI API-key availability.');
} finally {
  child.stdin.end();
  if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
  fs.rmSync(temp, { recursive: true, force: true });
}
