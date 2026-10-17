import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const puppeteer = require(process.env.PUPPETEER_MODULE || 'puppeteer');

// Exercise the actual widgets and theme with CodeMirror's cursor measurement.
const source = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const widget = source.slice(source.indexOf('class GenerationWidget'), source.indexOf('const generationField'));
const theme = source.slice(source.indexOf('const editorTheme ='), source.indexOf('// ─── Editor setup'));
const bundle = await build({ stdin: { resolveDir: process.cwd(), contents: `
  import { EditorState } from '@codemirror/state';
  import { EditorView, WidgetType, Decoration, drawSelection } from '@codemirror/view';
  const isDark = false;
  ${widget}
  ${theme}
  window.show = (value) => {
    window.view?.destroy();
    const doc = value.inline ? 'Opening /request' : '/request';
    const from = value.inline ? 8 : 0;
    window.view = new EditorView({ parent: document.body, state: EditorState.create({
      doc, selection: { anchor: doc.length }, extensions: [editorTheme, drawSelection(), EditorView.lineWrapping,
        EditorView.decorations.of(value.plain ? Decoration.none : Decoration.set([Decoration.replace({
          widget: new GenerationWidget(value), block: !value.inline,
        }).range(from, doc.length)]))],
    }) });
    window.view.focus();
  };
` }, bundle: true, write: false, format: 'iife' });
const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 700 });
  await page.setContent('<style>:root{--font:Georgia;--accent:blue;--text:black;--surface:white}body{margin:0}</style>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  for (const width of [650, 1100]) {
    await page.setViewport({ width, height: 700 });
    await page.evaluate(() => window.show({ plain: true }));
    await new Promise(resolve => setTimeout(resolve, 80));
    const offset = await page.evaluate(() => {
      const range = document.createRange();
      const text = document.querySelector('.cm-line').firstChild;
      range.setStart(text, text.length); range.collapse(true);
      return document.querySelector('.cm-cursor').getBoundingClientRect().left - range.getBoundingClientRect().left;
    });
    assert(Math.abs(offset) <= 1, `ordinary editing caret is shifted ${offset}px`);
    for (const inline of [false, true]) for (const phase of ['streaming', 'review']) {
      for (const text of ['Short.', 'First line.\nSecond line.', 'Words that wrap across the available writing column. '.repeat(25), 'First line.\n']) {
        await page.evaluate(value => window.show(value), { inline, phase, text });
        await page.waitForFunction(() => document.querySelector('.cm-cursor'));
        await new Promise(resolve => setTimeout(resolve, 80));
        const metrics = await page.evaluate(() => {
          const text = document.querySelector('.cm-generation .cm-suggest').firstChild;
          const range = document.createRange();
          range.setStart(text, text.length); range.collapse(true);
          const end = range.getBoundingClientRect();
          const cursor = document.querySelector('.cm-cursor').getBoundingClientRect();
          return { x: cursor.left, y: cursor.top, height: cursor.height, endX: end.left, endY: end.top, endHeight: end.height };
        });
        assert(Math.abs(metrics.x - metrics.endX) <= 1, `cursor must follow last character: ${JSON.stringify({ inline, phase, text: text.slice(-30), ...metrics })}`);
        assert(Math.abs(metrics.y - metrics.endY) <= 1, `cursor must sit on final line: ${JSON.stringify(metrics)}`);
        assert(metrics.height > 0 && metrics.height <= 30, `cursor must be one text line high: ${JSON.stringify(metrics)}`);
      }
    }
  }
  await page.evaluate(() => window.show({ inline: false, phase: 'streaming', text: '' }));
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(await page.$eval('.cm-cursor', el => el.getBoundingClientRect().height), 0, 'waiting shows loader without an editing caret');
  console.log('Cursor browser checks passed');
} finally {
  await browser.close();
}
