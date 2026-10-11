// Stilura Lens — the single-file demo for a Claude artifact.
//
// An artifact cannot import, so the scoring and the review prompt have to sit
// inside the file. Copying them by hand guarantees drift: the word lists and
// the audit prompt ARE the product, and they change. Inline them instead.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => readFile(path.join(root, name), 'utf8');

const strip = source => source
  .replace(/^import[\s\S]*?;$/gm, '')   // review.js pulls REVIEW_CODES in — both files are inlined
  .replace(/^export /gm, '');

const [prompt, review, template] = await Promise.all([
  read('review-prompt.js'),
  read('review.js'),
  read('artifact/lens.template.html'),
]);

const core = [strip(prompt), strip(review)].join('\n');
const html = template.replace('/*__CORE__*/', () => core);
if (html === template) throw new Error('Template has no /*__CORE__*/ slot');

const out = path.join(root, 'artifact/stilura-lens.html');
await writeFile(out, html);
console.log(`${path.relative(root, out)} — ${(html.length / 1024).toFixed(0)} KB`);
