import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'stilura-extension-chrome-'));
const artifacts = process.env.EXTENSION_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(), 'stilura-extension-results-'));
fs.mkdirSync(artifacts, { recursive: true });
const liveQwen = process.env.EXTENSION_QWEN === '1';
const fixture = spawn(process.execPath, [liveQwen ? 'index.js' : 'tests/browser-fixture.mjs'], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, ...(liveQwen ? { PORT: '0', STILURA_NO_OPEN: '1', STILURA_OFFLINE_MODELS: '1',
    PI_PROVIDER: 'local-qwen', PI_MODEL: 'qwen3.5-4b-4bit', PI_THINKING: 'off', DRAFT_FILE: path.join(profile, 'draft.md') } : {}) },
});
const errors = [];
const site = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...(req.url === '/strict' ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" } : {}) });
  res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Stilura extension checks</title>
    <style>body{font:17px/1.6 system-ui;max-width:760px;margin:40px auto;background:#f6f7f3;color:#263126}label{display:block;margin-top:22px}textarea,input,[contenteditable]{font:17px/1.6 system-ui;width:100%;box-sizing:border-box;padding:16px;border:1px solid #aab5a4;border-radius:9px;background:white}textarea{height:150px}h1{font-size:30px;margin-bottom:0}p{margin-top:4px;color:#5e6b58}</style>
    <h1>Write anywhere with Stilura</h1><p>Chrome extension integration checks · local fixture</p>
    <label for="plain">Plain text</label><textarea id="plain" spellcheck="false"></textarea>
    <label for="line">Single line</label><input id="line" aria-label="Single line">
    <label id="rich-label">Editable passage</label><div id="rich" contenteditable="true" role="textbox" aria-labelledby="rich-label"><p>A <b>quiet</b> room.</p><p>Second paragraph.</p></div>
    <script>window.inputEvents=0;document.addEventListener('input',()=>window.inputEvents++);</script></html>`);
});
let context, page;
const timeout = setTimeout(() => { console.error('Extension checks timed out'); fixture.kill(); void context?.close(); }, liveQwen ? 240000 : 120000);
try {
  const endpoint = await new Promise((resolve, reject) => {
    let output = '';
    fixture.stdout.on('data', chunk => { output += chunk; const match = /Stilura → (http:\/\/[^\s]+)/.exec(output); if (match) resolve(match[1]); });
    fixture.stderr.on('data', chunk => { output += chunk; });
    fixture.on('error', reject);
    fixture.on('exit', code => reject(Error(`Fixture exited ${code}: ${output}`)));
  });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: false, ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'],
    viewport: { width: 1200, height: 1000 },
  });
  context.setDefaultTimeout(liveQwen ? 90000 : 10000);
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: path.join(root, 'extension') });
  page = await context.newPage();
  await page.goto(`http://127.0.0.1:${site.address().port}`);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.getByLabel('Local app address').fill(endpoint);
  await popup.getByRole('button', { name: 'Connect', exact: true }).click();
  await popup.getByText('Connected. Ready to write.', { exact: true }).waitFor();
  await popup.getByLabel('Model', { exact: true }).selectOption({ label: liveQwen ? 'Qwen 3.5 4B (Rapid-MLX local) · local-qwen' : 'Test model · fixture' });
  await popup.getByText('Settings saved.', { exact: true }).waitFor();
  await popup.getByRole('button', { name: 'Connect', exact: true }).click();
  await popup.getByText('Connected. Ready to write.', { exact: true }).waitFor();
  assert.equal(JSON.parse(await popup.getByLabel('Model', { exact: true }).inputValue()).provider, liveQwen ? 'local-qwen' : 'fixture');
  await popup.screenshot({ path: path.join(artifacts, 'settings.png') });
  console.log('PASS: real Chrome extension installed, paired and retained its model after reconnecting');
  await page.bringToFront();
  const plain = page.locator('#plain');
  const assistant = page.locator('stilura-assistant');
  const close = async () => { await page.keyboard.press('Escape'); };
  const select = async (locator, from, to) => {
    await locator.focus();
    await locator.evaluate((el, range) => el.setSelectionRange(...range), [from, to]);
  };
  const submitRequest = async (scope = assistant, instruction = 'Rewrite this selection.') => {
    await scope.getByLabel('How should it change?').fill(instruction);
    await scope.getByRole('button', { name: 'Send request', exact: true }).click();
  };
  if (liveQwen) {
    await plain.fill('В саду было тихо.'); await select(plain, 12, 16);
    await assistant.getByRole('button', { name: 'Rewrite', exact: true }).click();
    await submitRequest(assistant, 'Замени выделенное слово одним синонимом.');
    await assistant.getByRole('button', { name: 'Accept', exact: true }).waitFor();
    const replacement = await assistant.locator('.preview').innerText();
    assert(replacement.trim() && replacement !== 'тихо');
    await page.screenshot({ path: path.join(artifacts, 'qwen-rewrite.png') });
    await plain.press('Tab');
    assert.equal(await plain.inputValue(), `В саду было ${replacement}.`);
    await plain.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    assert.equal(await plain.inputValue(), 'В саду было тихо.');
    console.log('PASS: local Qwen selection request, Tab and native undo');

    const command = '/Напиши одно короткое предложение о прогулке по саду.';
    await plain.fill(''); await plain.pressSequentially(command);
    await plain.press('Enter');
    await assistant.getByRole('button', { name: 'Accept', exact: true }).waitFor();
    const generated = await assistant.locator('.preview').innerText();
    assert(generated.trim() && /[а-яё]/i.test(generated));
    assert.equal(await plain.inputValue(), command);
    await page.screenshot({ path: path.join(artifacts, 'qwen-generation.png') });
    await plain.press('Tab'); assert.equal(await plain.inputValue(), generated);
    console.log('PASS: local Qwen slash generation, streamed preview and Tab acceptance');

    const prefix = 'Мы вошли в сад и увидели';
    await plain.fill(prefix);
    await assistant.locator('.ghost').waitFor({ state: 'visible' });
    assert.equal(await assistant.locator('.panel').isVisible(), false);
    await page.screenshot({ path: path.join(artifacts, 'qwen-suggestion.png') });
    await plain.press('Tab');
    const continued = await plain.inputValue();
    assert(continued.startsWith(prefix) && continued.length > prefix.length);
    assert.equal(fs.existsSync(path.join(profile, 'draft.md')), false, 'browser writing must not save a workspace draft');
    console.log('PASS: local Qwen automatic ghost, Tab acceptance, no workspace draft writes');
    console.log(JSON.stringify({ replacement, generated, continued }));
  } else {
  const strict = await context.newPage();
  await strict.goto(`http://127.0.0.1:${site.address().port}/strict`);
  await strict.locator('#plain').fill('/write a short story');
  await strict.locator('#plain').press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
  await strict.locator('stilura-assistant').getByRole('button', { name: 'Accept', exact: true }).click();
  assert.equal(await strict.locator('#plain').inputValue(), 'Partial fixture answer — completed discussion.');
  await strict.close(); await page.bringToFront();
  console.log('PASS: extension works on a page with strict script/connect CSP');
  await plain.fill('A quiet room.');
  await select(plain, 2, 7);
  await assistant.getByRole('button', { name: 'Rewrite', exact: true }).click();
  await submitRequest();
  await assistant.getByRole('button', { name: 'Accept', exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifacts, 'rewrite.png') });
  await assistant.getByRole('button', { name: 'Accept', exact: true }).click();
  assert.equal(await plain.inputValue(), 'A peaceful room.');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  assert.equal(await plain.inputValue(), 'A quiet room.');
  assert(await page.evaluate(() => window.inputEvents > 1));
  console.log('PASS: selection rewrite, native input events and undo');

  await plain.fill('Dear Alex,\n/write a polite reply');
  await plain.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
  await assistant.getByRole('button', { name: 'Accept', exact: true }).waitFor();
  assert.equal(await plain.inputValue(), 'Dear Alex,\n/write a polite reply');
  await page.screenshot({ path: path.join(artifacts, 'generation.png') });
  await assistant.getByRole('button', { name: 'Accept', exact: true }).click();
  assert.equal(await plain.inputValue(), 'Dear Alex,\nPartial fixture answer — completed discussion.');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  assert.equal(await plain.inputValue(), 'Dear Alex,\n/write a polite reply');
  console.log('PASS: slash generation previews before insertion and supports undo');

  await plain.fill('/write a quiet story');
  await plain.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
  await assistant.getByRole('button', { name: 'Accept', exact: true }).waitFor();
  await close();
  assert.equal(await plain.inputValue(), '/write a quiet story');
  await plain.fill('/write another story');
  await plain.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
  await plain.press('End');
  await plain.pressSequentially(' changed');
  await page.waitForTimeout(500);
  assert.equal(await assistant.getByRole('button', { name: 'Accept', exact: true }).count(), 0);
  assert.equal(await plain.inputValue(), '/write another story changed');
  console.log('PASS: Escape and edits during generation preserve the author text');

  await plain.fill('The path wound through the garden');
  await assistant.locator('.ghost').waitFor({ state: 'visible' });
  await page.screenshot({ path: path.join(artifacts, 'suggestion.png') });
  assert.equal(await assistant.locator('.panel').isVisible(), false);
  await plain.pressSequentially(' and');
  assert.equal(await assistant.locator('.ghost').innerText(), 'The path wound through the garden and continued');
  await plain.press('Tab');
  assert.equal(await plain.inputValue(), 'The path wound through the garden and continued');
  await plain.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  assert((await plain.inputValue()).startsWith('The path wound through the garden'));
  await page.bringToFront();
  await plain.fill('Another path wound through the garde');
  await plain.pressSequentially('n');
  await assistant.locator('.ghost').waitFor({ state: 'visible' });
  await plain.press('ArrowLeft');
  await page.waitForTimeout(100);
  assert.equal(await assistant.locator('.ghost').isVisible(), false);
  console.log('PASS: automatic continuation, Tab acceptance and cursor cancellation');

  const line = page.locator('#line');
  await line.fill('A quiet room.'); await select(line, 2, 7);
  await line.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
  await submitRequest();
  await assistant.getByRole('button', { name: 'Accept', exact: true }).waitFor();
  await line.press('ArrowDown'); await line.press('Tab');
  assert.equal(await line.inputValue(), 'A tranquil room.');
  console.log('PASS: single-line input and keyboard rewrite');

  const rich = page.locator('#rich');
  await rich.focus();
  await rich.evaluate(el => {
    const node = el.querySelector('b').firstChild, range = document.createRange();
    range.selectNodeContents(node); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  await assistant.getByRole('button', { name: 'Rewrite', exact: true }).click();
  await submitRequest();
  await assistant.getByRole('button', { name: 'Accept', exact: true }).waitFor();
  await rich.press('ArrowDown'); await rich.press('ArrowDown'); await rich.press('Tab');
  assert.equal((await rich.innerText()).replace(/\u00a0/g, ' '), 'A silent room.\n\nSecond paragraph.');
  assert.equal(await rich.locator('b').innerText(), 'silent');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  assert.equal(await rich.locator('b').innerText(), 'quiet');
  console.log('PASS: contenteditable selection, surrounding formatting and native undo');

  await rich.fill('Opening.\n/write a short ending');
  await rich.press('ArrowRight');
  await rich.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
  await assistant.getByRole('button', { name: 'Accept', exact: true }).click();
  assert((await rich.innerText()).includes('Partial fixture answer — completed discussion.'));
  console.log('PASS: contenteditable slash command');

  await plain.fill('A quiet room.'); await select(plain, 2, 7);
  await assistant.getByRole('button', { name: 'Rewrite', exact: true }).click();
  await submitRequest();
  await assistant.getByRole('button', { name: 'Accept', exact: true }).waitFor();
  await plain.evaluate(el => { el.value = 'A new draft from the website.'; });
  await plain.press('Tab');
  assert.equal(await plain.inputValue(), 'A new draft from the website.');
  assert.equal(await assistant.getByRole('button', { name: 'Accept', exact: true }).count(), 0);
  await close();
  console.log('PASS: silent website edits invalidate a pending replacement');

  await line.evaluate(el => { el.maxLength = 7; });
  await line.fill('quiet'); await select(line, 0, 5);
  await assistant.getByRole('button', { name: 'Rewrite', exact: true }).click();
  await submitRequest();
  await assistant.getByRole('button', { name: 'Accept', exact: true }).click();
  assert.equal(await line.inputValue(), 'quiet');
  assert.match(await assistant.locator('.status').textContent(), /7-character limit/);
  await close(); await line.evaluate(el => el.removeAttribute('maxlength'));
  console.log('PASS: field length limits never silently truncate replacements');

  await page.evaluate(() => {
    const frame = document.createElement('iframe'); frame.title = 'Frame editor'; frame.src = '/frame'; frame.style.cssText = 'width:100%;height:400px'; document.body.append(frame);
  });
  const frame = page.frameLocator('iframe'), framed = frame.locator('#plain'), frameAssistant = frame.locator('stilura-assistant');
  await framed.fill('A quiet room.'); await select(framed, 2, 7);
  await frameAssistant.getByRole('button', { name: 'Rewrite', exact: true }).click();
  await submitRequest(frameAssistant);
  await frameAssistant.getByRole('button', { name: 'Accept', exact: true }).click();
  assert.equal(await framed.inputValue(), 'A peaceful room.');
  await page.evaluate(() => document.querySelector('iframe').remove());
  console.log('PASS: extension actions inside an iframe');

  for (const attributes of [{ type: 'password' }, { autocomplete: 'cc-number' }, { autocomplete: 'one-time-code' }, { readonly: '' }]) {
    await line.evaluate((el, attributes) => {
      el.removeAttribute('readonly'); el.removeAttribute('autocomplete'); el.type = 'text';
      for (const [key, value] of Object.entries(attributes)) el.setAttribute(key, value);
      el.value = 'Synthetic test text'; el.focus(); el.setSelectionRange(0, 9); el.dispatchEvent(new Event('input', { bubbles: true }));
    }, attributes);
    await page.waitForTimeout(100);
    assert.equal(await assistant.locator('.panel').isVisible(), false);
  }
  console.log('PASS: password, payment autocomplete, one-time code and readonly exclusions');

  await page.bringToFront();
  await plain.fill('A quiet room.'); await select(plain, 2, 7);
  await plain.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
  await submitRequest(assistant, 'What does this word mean?');
  await assistant.locator('.status').filter({ hasText: 'Quiet suggests' }).waitFor();
  assert.equal(await plain.inputValue(), 'A quiet room.');
  assert.equal(await assistant.getByRole('button', { name: 'Accept', exact: true }).count(), 0);
  await close();
  console.log('PASS: selection questions return an answer without changing text');

  await plain.fill('A quiet room.'); await select(plain, 2, 7);
  await plain.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
  await submitRequest();
  await assistant.getByRole('button', { name: 'Accept', exact: true }).waitFor();
  assert.equal(await plain.evaluate(el => document.activeElement === el), true);
  assert.equal(await assistant.locator('.preview').innerText(), 'peaceful');
  await plain.press('r');
  await assistant.getByRole('button', { name: 'Accept', exact: true }).waitFor();
  assert.equal(await assistant.locator('.preview').innerText(), 'tranquil');
  await plain.press('Tab');
  assert.equal(await plain.inputValue(), 'A tranquil room.');
  console.log('PASS: rewrite returns focus, R regenerates and Tab accepts');

  await plain.fill('');
  await plain.pressSequentially('/write a short story');
  await assistant.locator('.status').filter({ hasText: 'Enter to generate' }).waitFor();
  await plain.press('Enter');
  await assistant.getByRole('button', { name: 'Accept', exact: true }).waitFor();
  assert.equal(await plain.inputValue(), '/write a short story');
  const fieldBox = await plain.boundingBox(), previewBox = await assistant.locator('.panel').boundingBox();
  assert(previewBox.y < fieldBox.y + fieldBox.height, 'preview must anchor near the command, not below the entire field');
  await plain.press('r');
  await assistant.locator('.status').filter({ hasText: 'Previous suggestion kept.' }).waitFor();
  assert.equal(await assistant.locator('.preview').innerText(), 'Partial fixture answer — completed discussion.');
  await plain.press('Alt+Enter');
  await plain.press('Escape');
  await assistant.getByRole('button', { name: 'Accept', exact: true }).waitFor();
  assert.equal(await assistant.locator('.preview').innerText(), 'Partial fixture answer — completed discussion.');
  await plain.press('Tab');
  assert.equal(await plain.inputValue(), 'Partial fixture answer — completed discussion.');
  await plain.fill('/a pasted command stays ordinary text');
  await plain.press('Enter');
  assert.equal(await plain.inputValue(), '/a pasted command stays ordinary text\n');
  await close();
  console.log('PASS: typed slash uses Enter; pasted slash preserves Enter; cancellation restores previous preview');

  await popup.bringToFront();
  await popup.getByLabel('Suggest continuations after typing').uncheck();
  await popup.getByText('Settings saved.', { exact: true }).waitFor();
  await page.bringToFront();
  await plain.fill('A long enough passage that should stay unchanged');
  await page.waitForTimeout(1500);
  assert.equal(await assistant.locator('.ghost').isVisible(), false);
  await plain.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
  await assistant.locator('.ghost').waitFor({ state: 'visible' });
  await plain.press('Escape');
  assert.equal(await assistant.locator('.ghost').isVisible(), false);
  console.log('PASS: manual continuation works with automatic suggestions disabled');
  await popup.bringToFront();
  await popup.getByLabel('Enable Stilura', { exact: true }).uncheck();
  await popup.getByText('Settings saved.', { exact: true }).waitFor();
  await page.bringToFront();
  await select(plain, 0, 4);
  await page.waitForTimeout(100);
  assert.equal(await assistant.locator('.panel').isVisible(), false);
  console.log('PASS: settings disable suggestions and all actions');
  }
  assert.deepEqual(errors, []);
  console.log(`PASS: no page errors. Chrome ${context.browser().version()}. Screenshots: ${artifacts}`);
} catch (error) {
  if (page) {
    console.error('Browser state:', await page.evaluate(() => ({ focused: document.hasFocus(), active: document.activeElement?.id,
      selection: [document.querySelector('#plain')?.selectionStart, document.querySelector('#plain')?.selectionEnd],
      panel: document.querySelector('stilura-assistant')?.shadowRoot.querySelector('.panel')?.textContent,
      rich: document.querySelector('#rich')?.innerHTML,
      selectionText: getSelection()?.toString(), anchor: [getSelection()?.anchorNode?.nodeName, getSelection()?.anchorOffset], focus: [getSelection()?.focusNode?.nodeName, getSelection()?.focusOffset],
    })).catch(() => null));
    await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
  }
  throw error;
} finally {
  clearTimeout(timeout);
  await context?.close(); fixture.kill();
  await new Promise(resolve => site.close(resolve));
  fs.rmSync(profile, { recursive: true, force: true });
}
