// Runs the actual HTTP routes against an entirely fake provider and a
// disposable file. No real credentials, models, or author drafts are touched.
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'litura-browser-'));
const fakePi = `
export async function getAgentStatus() { return { available: true, providers: [{id:'fixture', name:'Test'}], models:[{provider:'fixture',model:'test',name:'Test model',thinkingLevels:['off']}], authProviders:[], defaultSelection:{provider:'fixture',model:'test',thinkingLevel:'off'} }; }
export async function saveProviderApiKey() { throw Error('Fixture does not store keys'); }
export async function removeProviderApiKey() { throw Error('Fixture does not store keys'); }
export async function completeText({systemPrompt, userPrompt, signal}) {
  await new Promise((resolve,reject) => { const timer=setTimeout(resolve, 300); signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason)}, {once:true}); });
  if (systemPrompt.includes('exactly 3 different replacements')) {
    const selected = userPrompt.split('SELECTED TEXT — replace exactly this, nothing more:\\n')[1].split('\\n\\n---')[0];
    return JSON.stringify([selected + ' revised A', selected + ' revised B', selected + ' revised C']);
  }
  if (systemPrompt.includes('inline writing assistant')) return ' and continued';
  if (systemPrompt.includes('global structure pass')) return '[]';
  return JSON.stringify(['Alpha passage.', 'Beta passage.'].filter(quote=>userPrompt.includes(quote)).map(quote=>({code:'generic-prose',quote,pattern:'Test wording',reason:'Fixture finding for safe editing',fix:'Make the passage clearer'})));
}
export async function streamText({systemPrompt, onText, signal}) {
  onText('Partial fixture answer');
  await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,300);signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason)}, {once:true})});
  if (systemPrompt.includes('expand the following idea')) throw Error('Simulated stream failure');
  onText(' — completed discussion.');
}
`;
const result = await build({
  entryPoints: [path.join(root, 'index.js')], bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false,
  define: { 'import.meta.url': JSON.stringify(pathToFileURL(path.join(root, 'index.js')).href) },
  plugins: [{ name: 'fake-provider', setup(build) {
    build.onLoad({ filter: /\/pi\.js$/ }, () => ({ contents: fakePi, loader: 'js' }));
    build.onResolve({ filter: /^esbuild$/ }, () => ({ path: require.resolve('esbuild'), external: true }));
  } }],
});
const child = spawn(process.execPath, ['--input-type=module', '--eval', result.outputFiles[0].text], {
  cwd: root, stdio: 'inherit', env: { ...process.env, PORT: '0', LITURA_NO_OPEN: '1', DRAFT_FILE: path.join(temp, 'draft.md') },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => { fs.rmSync(temp, { recursive: true, force: true }); process.exit(code ?? 0); });
