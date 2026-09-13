// Opt-in model evaluation. Uses the production prompts, model options and parser;
// structural assertions are separate from a human's assessment of the prose.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { completeText, getAgentStatus } from '../pi.js';
import { suggestionPrompts, parseSuggestion } from '../suggestions.js';

const root = path.resolve(import.meta.dirname, '..');
const filters = process.env.SUGGEST_CASE?.split(',');
const cases = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/suggestions.json'), 'utf8'))
  .filter(test => !filters || filters.some(filter => test.id.includes(filter)));
if (!cases.length) throw new Error('No matching suggestion cases');
const runs = Number(process.env.SUGGEST_RUNS || 1);
if (!Number.isInteger(runs) || runs < 1) throw new Error('SUGGEST_RUNS must be a positive integer');
const delayMs = Number(process.env.SUGGEST_DELAY_MS || 0);
if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error('SUGGEST_DELAY_MS must be a non-negative number');
const modes = (process.env.SUGGEST_MODES || 'production').split(',');
if (modes.some(mode => !['production', 'short-style', 'local-context'].includes(mode))) throw new Error('Unknown SUGGEST_MODES value');
const styleFile = process.env.STYLE_FILE || path.join(root, 'style.md');
const style = fs.readFileSync(styleFile, 'utf8').trim();
const { defaultSelection: selection } = await getAgentStatus();
if (!selection) throw new Error('No authenticated Pi model is available');
const reportFile = path.resolve(process.env.SUGGEST_REPORT || path.join(root, 'tmp/suggestion-evaluation.json'));
const report = { startedAt: new Date().toISOString(), model: selection, plannedCalls: cases.length * runs * modes.length, fixtures: 'Authored bilingual regression examples; not an independent benchmark.', results: [] };
fs.mkdirSync(path.dirname(reportFile), { recursive: true });
console.log(`Suggestion evaluation: ${selection.provider}/${selection.model}, ${cases.length * runs * modes.length} calls`);
let failures = 0;
evaluation: for (const test of cases) for (let run = 1; run <= runs; run++) for (const mode of modes) {
  if (report.results.length && delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
  // These experiments stay out of production until their output is reviewed.
  const prefix = mode === 'local-context' ? test.prefix.slice(-1500) : test.prefix;
  const suffix = mode === 'local-context' ? (test.suffix || '').slice(0, 750) : (test.suffix || '');
  const prompts = suggestionPrompts({ document: prefix + suffix, cursor: prefix.length, style: mode === 'short-style' ? '' : style });
  const result = {
    id: test.id, run, mode, prefix: test.prefix, suffix: test.suffix || '', rubric: test.rubric,
    promptHash: createHash('sha256').update(prompts.systemPrompt + prompts.userPrompt).digest('hex'),
    promptCharacters: prompts.systemPrompt.length + prompts.userPrompt.length,
    errors: [], humanReview: { coherence: null, voicePreserved: null, inventedFacts: null, useful: null },
  };
  const started = performance.now();
  try {
    result.raw = await completeText({ ...prompts, selection, continuation: true, signal: AbortSignal.timeout(30_000) });
    result.suggestion = result.raw ? parseSuggestion(test.prefix, result.raw) : '';
    result.combined = test.prefix + result.suggestion + (test.suffix || '');
    if (test.empty && result.suggestion) result.errors.push('Expected abstention');
    if (test.expected && !result.suggestion.toLowerCase().includes(test.expected.toLowerCase())) result.errors.push(`Expected continuation containing ${JSON.stringify(test.expected)}`);
    for (const word of test.forbid || []) if (result.suggestion.toLowerCase().includes(word.toLowerCase())) result.errors.push(`Unexpected detail: ${word}`);
  } catch (error) {
    result.errors.push(error.message);
    if (/\b(400|401|402|403|404|429)\b/u.test(error.message)) report.stoppedBecause = error.message;
  }
  result.elapsedMs = Math.round(performance.now() - started);
  if (result.errors.length) failures++;
  report.results.push(result);
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
  console.log(`[${result.errors.length ? 'FAIL' : 'PASS'}] ${test.id} / ${mode} #${run} ${result.elapsedMs}ms ${JSON.stringify(result.suggestion ?? '')}${result.errors.length ? ' — ' + result.errors.join('; ').slice(0, 250) : ''}`);
  if (report.stoppedBecause) break evaluation;
}
report.summary = modes.map(mode => {
  const results = report.results.filter(result => result.mode === mode);
  const times = results.filter(result => !result.errors.length).map(result => result.elapsedMs).sort((a, b) => a - b);
  return { mode, cases: results.length, failures: results.filter(result => result.errors.length).length, abstentions: results.filter(result => result.suggestion === '').length,
    medianMs: !times.length ? null : times.length % 2 ? times[(times.length - 1) / 2] : (times[times.length / 2 - 1] + times[times.length / 2]) / 2 };
});
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report.summary, null, 2));
console.log(`Report: ${reportFile}\nPassing assertions do not certify prose quality; review the combined text and rubric.`);
if (failures) process.exitCode = 1;
