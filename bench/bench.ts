/**
 * Engine benchmark on a generated trace of at least 10,000 events.
 * Writes bench/out/node-results.json and the two traces used by scripts/browser-bench.mjs.
 *
 *   npm run bench            # default 760 orders (~10.3k events per run)
 *   npm run bench -- 1500    # custom order count
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { bundleToText, exportBundle, parseBundle, verifyBundle } from '../src/engine/bundle';
import { compareRuns } from '../src/engine/compare';
import { buildGraph } from '../src/engine/graph';
import { runScenario } from '../src/engine/runner';
import { LIMITS, parseJsonText, validateTrace } from '../src/engine/validate';
import { duplicateCharge } from '../src/scenarios/catalog/side-effects';
import { getWorkflow } from '../src/scenarios/index';
import { filterEvents } from '../src/web/components/Timeline';
import { scaledFaults, scaledScenario } from './scale';

const orders = Number(process.argv[2] ?? 760);
const REPS = 5;
const scenario = scaledScenario(orders);
const faults = scaledFaults(orders, 10);
const [faulty, corrected] = scenario.policies;

function measure<T>(fn: () => T): { ms: { median: number; min: number; max: number; runs: number[] }; value: T } {
  let value!: T;
  const runs: number[] = [];
  for (let i = 0; i < REPS; i++) {
    const t0 = performance.now();
    value = fn();
    runs.push(Number((performance.now() - t0).toFixed(2)));
  }
  const sorted = [...runs].sort((a, b) => a - b);
  return { ms: { median: sorted[Math.floor(REPS / 2)], min: sorted[0], max: sorted[REPS - 1], runs }, value };
}

const heap = () => Number((process.memoryUsage().heapUsed / 1048576).toFixed(1));
global.gc?.();
const heapStart = heap();

const runA = measure(() => runScenario(scenario, duplicateCharge.workflow, { policy: faulty, faultPlan: faults }));
const a = runA.value;
const b = runScenario(scenario, duplicateCharge.workflow, { policy: corrected, faultPlan: faults });
const heapAfterRuns = heap();
const textA = JSON.stringify(a);
const textB = JSON.stringify(b);
const serialize = measure(() => JSON.stringify(a));
const importTrace = measure(() => validateTrace(parseJsonText(textA, LIMITS.maxTraceBytes, 'trace')));
const searchRequest = measure(() => filterEvents(a.events, 'B-00377', ''));
const searchKind = measure(() => filterEvents(a.events, 'timed out', 'tool'));
const searchNone = measure(() => filterEvents(a.events, 'zzz-no-match', ''));
const compare = measure(() => compareRuns(b, a));
const graph = measure(() => buildGraph(a));
const exportB = measure(() => bundleToText(exportBundle(scenario, a, { includeTrace: true })));
const verify = measure(() => verifyBundle(parseBundle(exportB.value), getWorkflow));
global.gc?.();
const heapEnd = heap();

const cmp = compare.value;
const results = {
  generatedAt: new Date().toISOString(),
  input: {
    description: `Scaled duplicate-charge scenario: ${orders} independent checkouts, response dropped after commit for every 10th charge. A = retry without idempotency key, B = retry with key.`,
    orders,
    eventsA: a.events.length,
    eventsB: b.events.length,
    traceBytesA: Buffer.byteLength(textA),
    traceBytesB: Buffer.byteLength(textB),
    bundleBytes: Buffer.byteLength(exportB.value),
    kinds: Object.fromEntries([...a.events.reduce((m, e) => m.set(e.kind, (m.get(e.kind) ?? 0) + 1), new Map<string, number>())].sort()),
  },
  runtime: { node: process.version, platform: `${os.platform()} ${os.arch()}`, cpu: os.cpus()[0]?.model ?? 'unknown', cpus: os.cpus().length, memGb: Number((os.totalmem() / 1073741824).toFixed(1)) },
  repetitions: REPS,
  timingsMs: {
    simulateRun: runA.ms,
    serializeTrace: serialize.ms,
    importTrace: importTrace.ms,
    searchByRequest: searchRequest.ms,
    searchTextAndKind: searchKind.ms,
    searchNoMatch: searchNone.ms,
    compareRuns: compare.ms,
    buildGraph: graph.ms,
    exportBundleWithRedaction: exportB.ms,
    verifyBundle: verify.ms,
  },
  outputs: {
    importIntegrity: importTrace.value.integrity,
    searchByRequestHits: searchRequest.value.length,
    searchTextAndKindHits: searchKind.value.length,
    compareRows: cmp.rows.length,
    compareCounts: cmp.counts,
    firstDivergence: cmp.firstDivergence?.description ?? null,
    graphNodes: graph.value.nodes.length,
    graphEdges: graph.value.edges.length,
    verifyOk: verify.value.ok,
  },
  heapMb: { start: heapStart, afterTwoRuns: heapAfterRuns, end: heapEnd, note: 'process heapUsed; includes both traces, their JSON text and the bundle text' },
};

mkdirSync('bench/out', { recursive: true });
writeFileSync('bench/out/node-results.json', JSON.stringify(results, null, 2));
writeFileSync('bench/out/trace-a.json', textA);
writeFileSync('bench/out/trace-b.json', textB);
console.log(JSON.stringify({ input: results.input, timingsMs: Object.fromEntries(Object.entries(results.timingsMs).map(([k, v]) => [k, v.median])), outputs: results.outputs, heapMb: results.heapMb }, null, 2));
