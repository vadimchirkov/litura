import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAgentStatus } from './pi.js';
import { requestReview } from './review-model.js';
import { buildReviewTask, buildReviewUser, REVIEW_CODES, reviewCodesForPass } from './review-prompt.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const styleFile = process.env.STYLE_FILE || path.join(dirname, 'style.md');
const style = fs.readFileSync(styleFile, 'utf8').trim();
const runs = Math.max(1, Number.parseInt(process.env.DEEP_RUNS || '1', 10));
const filter = process.env.DEEP_CASE?.trim();
const delayMs = Math.max(0, Number.parseInt(process.env.DEEP_DELAY_MS || '350', 10));
const ofStudies = fs.readFileSync(path.join(dirname, 'fixtures/of-studies.txt'), 'utf8').trim();

const cases = [
  // This published essay became a regression fixture after prompt tuning.
  // It must no longer be described as an independent holdout.
  { id: 'bacon-original-control', document: ofStudies, empty: true },
  {
    id: 'bacon-broken-index',
    document: ofStudies.replace('Studies serve for delight, for ornament, and for ability.',
      'Studies serve for delight, for ornament, for ability, and for health.'),
    expect: ['level-3-index-discussion'],
    maxFindings: 1,
    anchor: 'Studies serve for delight, for ornament, for ability, and for health.',
  },
  {
    id: 'bacon-broken-flow',
    document: ofStudies.replace('They perfect nature, and are perfected by experience:',
      'They perfect nature, and are perfected by experience. A restaurant owner across town replaced her freezer on Tuesday:'),
    expect: ['level-7-paragraph-flow'],
    maxFindings: 1,
    anchor: 'A restaurant owner across town replaced her freezer on Tuesday',
  },
  {
    id: 'l1-title-mismatch',
    expect: ['level-1-whole-essay'],
    document: `# Growing Tomatoes on a Balcony

Public charging stations send heartbeat data to their networks, but drivers cannot see that signal in a listing. They therefore cannot know from the listing whether its plug still works, and a failed stop can leave them short of battery for the next station.

Operators already collect heartbeat data from chargers. Publishing the last successful heartbeat would let drivers avoid dead stations before leaving home.

The visible heartbeat timestamp would let drivers judge a listed station before committing battery to the route.`,
  },
  {
    id: 'l1-unresolved-ending',
    expect: ['level-1-whole-essay'],
    document: `# Let Drivers See Whether a Charger Is Alive

Charging networks mark public chargers available in their listings. Drivers cannot tell whether a marked charger works until they arrive. A failed stop can strand a driver far from the next station, so the missing information has a real cost.

Networks already receive a heartbeat from each charger. They could show the time of the last successful heartbeat beside the station listing.

Because networks have not decided whether to expose this data, drivers still discover a dead charger only after arriving.`,
  },
  {
    id: 'l1-coherent-control',
    empty: true,
    document: `# Let Drivers See Whether a Charger Is Alive

Drivers cannot tell whether a public charger works until they arrive. A failed stop can strand a driver far from the next station, so the missing information has a real cost.

That missing information already exists inside each charging network: the network receives a heartbeat from every charger. It can show that heartbeat's timestamp beside the station listing.

With the heartbeat timestamp visible, drivers could judge the listed station before committing battery to the route.`,
  },
  {
    id: 'l2-missing-problem-and-point',
    expect: ['level-2-introduction'],
    document: `# Station Maps Should Show More

Drivers use station maps to plan long trips. On those maps, operators show each station's address, plug type, and advertised speed. Operators also collect a periodic charger heartbeat. That heartbeat records a timestamp for when the station last contacted its network. Operators currently keep the timestamp for internal monitoring. Operators should now add the heartbeat timestamp to every station map entry.`,
  },
  {
    id: 'l2-complete-introduction-control',
    empty: true,
    document: `# Show the Last Successful Charger Heartbeat

Drivers reasonably expect a station page marked available to describe working hardware. Operators derive that label from a charger heartbeat, but the displayed status can become stale between checks. Drivers now discover that staleness only after spending time and battery on the trip. To prevent that wasted trip, operators should show the last successful heartbeat on each station page so a driver can judge the risk before leaving.`,
  },
  {
    id: 'l3-broken-index-promise',
    expect: ['level-3-index-discussion'],
    document: `# Three Signals for a Charging Stop

A useful station page should tell a driver three things: whether the plug has power, whether payment works, and when a repair is due.

The power signal comes from the station heartbeat. Payment status comes from the last completed transaction.`,
  },
  {
    id: 'l3-kept-index-promise-control',
    empty: true,
    document: `# Three Signals for a Charging Stop

A useful station page should tell a driver three things: whether the plug has power, whether payment works, and when a repair is due.

The power signal comes from the station heartbeat. Payment status comes from the last completed transaction. The repair date comes from the operator's maintenance queue.`,
  },
  {
    id: 'l4-section-breaks-essay-point',
    expect: ['level-4-fractal-structure'],
    document: `# Reduce Uncertain Charging Trips

Station pages usually show an address and advertised speed but no recent evidence that the hardware is responding. Drivers can therefore spend time and battery reaching a silent charger. Station pages should expose recent operational evidence so drivers can avoid those wasted trips.

## Office layout and afternoon focus

The design team moved desks to the south wall, where the office gets more light after lunch. The brighter desks make paper notes easier to read. The team now holds its afternoon planning session there.

## Operational evidence

The last heartbeat shows whether the charger has contacted its network. A recent payment shows whether another driver completed a session. Together, those signals let drivers distinguish an idle station from a silent one.

Publishing both signals would give drivers the recent evidence the current station page withholds.`,
  },
  {
    id: 'l4-section-supports-essay-control',
    empty: true,
    document: `# Reduce Uncertain Charging Trips

Station pages usually show an address and advertised speed but no recent evidence that the hardware is responding. Drivers can therefore spend time and battery reaching a silent charger. Station pages should expose recent operational evidence so drivers can avoid those wasted trips.

## Evidence a driver can use

The last heartbeat is one piece of operational evidence: it shows whether the charger has contacted its network. A recent payment adds another piece of evidence by showing whether a driver completed a session. Together, that operational evidence helps a driver judge whether the listed station is responding.`,
  },
  {
    id: 'l5-point-buried',
    expect: ['level-5-point-placement'],
    document: `The station page shows an address. It also shows plug type and advertised speed. The page marks availability with a green badge. The operator derives that badge from a heartbeat status received every five minutes. A stale badge can send a driver on a wasted trip. The station page should show the heartbeat time to drivers. That timestamp needs only one line. That line can use the timestamp already exposed by the page's API. Using the API value needs no new database field.`,
  },
  {
    id: 'l5-point-first-control',
    empty: true,
    document: `The dashboard should show the heartbeat time to drivers. It already receives that signal every five minutes. Operators use the timestamp for outage diagnosis. One extra line fits below the existing availability badge. The current API already exposes the value.`,
  },
  {
    id: 'l5-point-last-control',
    empty: true,
    document: `The dashboard receives a heartbeat every five minutes. Operators already use its timestamp for outage diagnosis. Drivers, unlike operators, currently see only a green badge, so they may waste a trip on a station whose status is stale. The data those drivers need is already exposed by the current API. The dashboard should therefore show the heartbeat time to drivers.`,
  },
  {
    id: 'l6-key-term-disappears',
    expect: ['level-6-key-terms'],
    document: `Heartbeat freshness is the product's central reliability measure. The backend stores heartbeat freshness for every station. The interface labels the same measure availability confidence without explaining the change.`,
  },
  {
    id: 'l6-key-terms-thread-control',
    empty: true,
    document: `A driver needs two signals: charger heartbeat and payment status. The heartbeat shows when the station last contacted its network. The payment status shows whether another driver recently completed a session.`,
  },
  {
    id: 'l7-abrupt-old-new-break',
    expect: ['level-7-paragraph-flow'],
    document: `The charger sends a heartbeat every five minutes. The network records that signal with a timestamp. A restaurant owner across town replaced her freezer on Tuesday. That repair reduced the kitchen's electricity use.`,
  },
  {
    id: 'l7-constant-theme-control',
    empty: true,
    document: `The charger sends a heartbeat every five minutes. The charger stops sending it when the controller loses power. The charger resumes after the controller restarts.`,
  },
  {
    id: 'l7-linking-control',
    empty: true,
    document: `The charger sends a heartbeat to the network. The network records that signal with a timestamp. That timestamp appears on the station page.`,
  },
  {
    id: 'l7-super-theme-control',
    empty: true,
    document: `Two signals describe a station's condition. The heartbeat shows whether its controller is online. The payment record shows whether a recent session finished.`,
  },
  {
    id: 'l7-preview-develop-control',
    empty: true,
    document: `The release has two risks: stale heartbeats and failed payments. A heartbeat becomes stale when a station loses its network link. A payment fails when the terminal cannot reach its processor.`,
  },
  {
    id: 'target-scope-and-generic-regression',
    targeted: true,
    expect: ['generic-prose'],
    forbid: ['level-1-whole-essay', 'level-2-introduction', 'level-3-index-discussion', 'level-4-fractal-structure', 'level-5-point-placement'],
    document: `# Growing Tomatoes on a Balcony

This draft is actually about charger reliability and therefore has a misleading title.

Experts agree that this groundbreaking solution plays a pivotal role in the evolving landscape.`,
    target: 'Experts agree that this groundbreaking solution plays a pivotal role in the evolving landscape.',
  },
  {
    id: 'generic-anti-mind-like-agency',
    targeted: true,
    expect: ['generic-prose'],
    document: 'The dashboard understands what each manager needs and decides which metrics matter.',
    target: 'The dashboard understands what each manager needs and decides which metrics matter.',
  },
  {
    id: 'generic-anti-product-verb-control',
    targeted: true,
    empty: true,
    document: 'The dashboard shows three metrics and filters them by date.',
    target: 'The dashboard shows three metrics and filters them by date.',
  },
  {
    id: 'generic-anti-manufactured-emphasis',
    targeted: true,
    expect: ['generic-prose'],
    document: 'The "solution" "streamlines" the "workflow" because WE MUST MOVE NOW.',
    target: 'The "solution" "streamlines" the "workflow" because WE MUST MOVE NOW.',
  },
  {
    id: 'generic-anti-stacked-hedging',
    targeted: true,
    expect: ['generic-prose'],
    document: 'The change could potentially possibly reduce support volume.',
    target: 'The change could potentially possibly reduce support volume.',
  },
  {
    id: 'generic-anti-single-hedge-control',
    targeted: true,
    empty: true,
    document: 'The change could reduce support volume.',
    target: 'The change could reduce support volume.',
  },
];

function systemPrompt(targeted, phase) {
  const task = buildReviewTask({ targeted, phase });
  return style ? `Follow this writing style guide:\n\n${style}\n\n---\n\n${task}` : task;
}

function validate(test, findings) {
  const codes = findings.map(finding => finding.code);
  const errors = [];
  for (const expected of test.expect ?? []) {
    if (!codes.includes(expected)) errors.push(`missing ${expected}`);
  }
  for (const forbidden of test.forbid ?? []) {
    if (codes.includes(forbidden)) errors.push(`unexpected ${forbidden}`);
  }
  const expectedStructural = (test.expect ?? []).filter(code => code.startsWith('level-'));
  if (expectedStructural.length === 1) {
    const extra = codes.filter(code => code.startsWith('level-') && code !== expectedStructural[0]);
    if (extra.length) errors.push(`competing structural code(s): ${extra.join(', ')}`);
  }
  if (test.empty && findings.length) errors.push(`expected [], received ${codes.join(', ')}`);
  if (findings.length > (test.maxFindings ?? 8)) errors.push('too many findings');
  if (test.anchor && !findings.some(finding => finding.quote.includes(test.anchor))) {
    errors.push('finding does not identify the injected defect');
  }
  for (const finding of findings) {
    if (!REVIEW_CODES.includes(finding.code)) errors.push(`invalid code ${finding.code}`);
    const source = test.target || test.document;
    if (!source.includes(finding.quote)) errors.push(`quote is not exact: ${JSON.stringify(finding.quote)}`);
  }
  return errors;
}

async function run(test) {
  const targeted = Boolean(test.targeted);
  const phases = targeted ? ['local'] : ['global', 'local'];
  const findings = await requestReview({
    prompts: phases.map(phase => ({
      systemPrompt: systemPrompt(targeted, phase),
      userPrompt: buildReviewUser(test),
      allowedCodes: reviewCodesForPass(targeted, phase),
      source: test.target || test.document,
    })),
  });
  return { findings, errors: validate(test, findings) };
}

const selected = filter ? cases.filter(test => test.id.includes(filter)) : cases;
if (!selected.length) throw new Error(`No deep-check case matches ${JSON.stringify(filter)}`);

const status = await getAgentStatus();
if (!status.defaultSelection) throw new Error('No authenticated Pi model is available');
console.log(`Deep review check: ${status.defaultSelection.provider}/${status.defaultSelection.model}`);
console.log(`${selected.length} case(s), ${runs} run(s) each\n`);

let failures = 0;
const report = {
  startedAt: new Date().toISOString(),
  model: status.defaultSelection,
  promptHash: createHash('sha256').update(style + buildReviewTask({ phase: 'global' }) + buildReviewTask({ phase: 'local' }) + buildReviewTask({ targeted: true, phase: 'local' })).digest('hex'),
  results: [],
};
for (const test of selected) {
  for (let attempt = 1; attempt <= runs; attempt++) {
    try {
      const { findings, errors } = await run(test);
      report.results.push({ id: test.id, run: attempt, findings, errors });
      const label = runs > 1 ? `${test.id} #${attempt}` : test.id;
      const summary = findings.length
        ? findings.map(finding => `${finding.code}: ${finding.pattern}`).join(' | ')
        : '[]';
      if (errors.length) {
        failures++;
        console.log(`[FAIL] ${label}\n       ${errors.join('; ')}\n       ${summary}\n       ${JSON.stringify(findings)}`);
      } else {
        console.log(`[PASS] ${label}\n       ${summary}`);
      }
    } catch (error) {
      failures++;
      report.results.push({ id: test.id, run: attempt, findings: [], errors: [error.message] });
      console.log(`[FAIL] ${test.id}\n       ${error.message}`);
    }
    if (process.env.DEEP_REPORT) fs.writeFileSync(process.env.DEEP_REPORT, JSON.stringify(report, null, 2) + '\n');
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
  }
}

console.log(`\n${selected.length * runs - failures}/${selected.length * runs} passed`);
if (failures) process.exitCode = 1;
