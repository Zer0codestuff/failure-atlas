import { readFileSync, writeFileSync } from 'node:fs';
import { evaluateAll, firstFailure, summarize, type EvaluatedAssertion } from '../engine/assertions';
import { bundleFingerprint, bundleToText, exportBundle, parseBundle, verifyBundle } from '../engine/bundle';
import { compareRuns } from '../engine/compare';
import { buildGraph, renderAsciiGraph } from '../engine/graph';
import { forkRun, runScenario } from '../engine/runner';
import type { FaultPlan, Policy, ScenarioDef, Trace } from '../engine/types';
import { ImportError, LIMITS, parseJsonText, validateScenario, validateTrace } from '../engine/validate';
import { importOtlp, isOtlpJson } from '../integrations/otel';
import { getScenario, getWorkflow, SCENARIOS, type ScenarioModule } from '../scenarios/index';

const HELP = `Failure Atlas CLI (deterministic agent-failure lab)

Usage: failure-atlas <command> [options]

Commands
  list                                   List shipped scenarios, policies and fault presets
  run <scenario>                         Run a deterministic simulation and evaluate assertions
      --policy <id>  --faults <preset|none>  --seed <n>  --schedule fifo|seeded-shuffle
      --out <trace.json>  --events  --json
  compare <scenario> --a <policy[:preset]> --b <policy[:preset]>
  compare --trace-a <a.json> --trace-b <b.json>
                                         Align two runs by semantic step and show the first observed divergence
  fork <scenario> --policy <id> --faults <preset> --at <checkpoint> [--to-policy <id>] [--to-faults <preset|none>]
                                         Replay to a declared checkpoint, verify the prefix, continue with changes
  graph <scenario> --policy <id> --faults <preset>
                                         Print the dependency graph (every edge comes from recorded evidence)
  export <scenario> --policy <id> --faults <preset> --out <bundle.json> [--no-trace] [--redact-path <pattern>]...
                                         Write a regression bundle (redaction preview is printed)
  verify <bundle.json>                   Re-execute a bundle; exit code 0 only when every expectation reproduces
  inspect <file.json>                    Validate a native trace or import OTLP/JSON GenAI spans (playback only)
  validate-scenario <file.json>          Validate a declarative scenario against this build
  matrix [--json]                        Run every scenario x policy x preset and report assertion outcomes
  live <scenario> [--stream] [--max-turns n]
                                         Live execution with an OpenAI-compatible endpoint (FA_LIVE_BASE_URL,
                                         FA_LIVE_MODEL, optional FA_LIVE_API_KEY). Tools are local fixtures.
`;

const SYMBOL: Record<string, string> = { pass: '[pass]', fail: '[FAIL]', error: '[error]', unavailable: '[unavailable]', 'not-applicable': '[n/a]' };

function parseArgs(argv: string[]): { pos: string[]; flags: Record<string, string[]> } {
  const pos: string[] = [];
  const flags: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) (flags[key] ??= []).push('true');
      else { (flags[key] ??= []).push(next); i++; }
    } else pos.push(a);
  }
  return { pos, flags };
}

class CliError extends Error {}

function need(m: ScenarioModule | undefined, id: string | undefined): ScenarioModule {
  if (!id) throw new CliError('Missing scenario id. Run "failure-atlas list".');
  if (!m) throw new CliError(`Unknown scenario "${id}". Run "failure-atlas list".`);
  return m;
}

function pickPolicy(s: ScenarioDef, id: string | undefined): Policy {
  const p = s.policies.find((x) => x.id === (id ?? 'faulty'));
  if (!p) throw new CliError(`Unknown policy "${id}" for ${s.id}. Available: ${s.policies.map((x) => x.id).join(', ')}`);
  return p;
}

function pickPlan(s: ScenarioDef, id: string | undefined): FaultPlan | null {
  if (id === 'none') return null;
  if (id === undefined) return s.faultPresets[0] ?? null;
  const p = s.faultPresets.find((x) => x.id === id);
  if (!p) throw new CliError(`Unknown fault preset "${id}" for ${s.id}. Available: none${s.faultPresets.map((x) => `, ${x.id}`).join('')}`);
  return p;
}

function printAssertions(results: EvaluatedAssertion[]) {
  for (const r of results) {
    console.log(`  ${SYMBOL[r.status].padEnd(14)} ${r.title}`);
    console.log(`  ${''.padEnd(14)} ${r.message}${r.evidence.eventSeqs.length ? `  (events ${r.evidence.eventSeqs.slice(0, 8).map((s) => `#${s}`).join(' ')}${r.evidence.eventSeqs.length > 8 ? ' ...' : ''})` : ''}`);
    if (r.violated) console.log(`  ${''.padEnd(14)} violated: ${r.violated}`);
  }
  const s = summarize(results);
  console.log(`\n  ${s.statement}`);
  const first = firstFailure(results);
  if (first) console.log(`  First failed invariant: ${first.title} (earliest evidence #${first.evidence.eventSeqs[0] ?? '?'})`);
}

function printTraceHeader(t: Trace) {
  console.log(`run ${t.id}  mode=${t.mode}  status=${t.status}  events=${t.events.length}`);
  if (t.parentRunId) console.log(`  forked from ${t.parentRunId} at ${t.fork?.checkpointId} (seq ${t.fork?.seq}), prefix verified: ${t.fork?.prefixVerified}`);
  console.log(`  events hash ${t.hashes.events.slice(0, 16)}  state hash ${t.hashes.state?.slice(0, 16) ?? 'n/a'}`);
  if (t.executionErrors.length) for (const e of t.executionErrors) console.log(`  execution error ${e.code}: ${e.message}`);
}

function printEvents(t: Trace) {
  for (const e of t.events) console.log(`  #${String(e.seq).padStart(3)} ${String(e.vt).padStart(7)}ms  ${e.kind.padEnd(18)} ${e.summary}`);
}

function runFrom(flags: Record<string, string[]>, m: ScenarioModule, prefix = ''): Trace {
  const s = m.scenario;
  return runScenario(s, m.workflow, {
    policy: pickPolicy(s, flags[`${prefix}policy`]?.[0]),
    faultPlan: pickPlan(s, flags[`${prefix}faults`]?.[0]),
    seed: flags.seed ? Number(flags.seed[0]) : undefined,
    schedule: (flags.schedule?.[0] as 'fifo' | 'seeded-shuffle') ?? 'fifo',
  });
}

function loadTraceFile(path: string): Trace {
  const raw = parseJsonText(readFileSync(path, 'utf8'), LIMITS.maxTraceBytes, path);
  if (isOtlpJson(raw)) return importOtlp(raw).trace;
  return validateTrace(raw).trace;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const { pos, flags } = parseArgs(rest);
  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
      console.log(HELP);
      return 0;
    case 'list': {
      const groups = new Map<string, ScenarioModule[]>();
      for (const m of SCENARIOS) groups.set(m.scenario.mechanism, [...(groups.get(m.scenario.mechanism) ?? []), m]);
      for (const [g, ms] of groups) {
        console.log(`\n${g}`);
        for (const m of ms) {
          const s = m.scenario;
          console.log(`  ${s.id}  (${s.title})`);
          console.log(`    policies: ${s.policies.map((p) => p.id).join(', ')}   faults: none${s.faultPresets.map((f) => `, ${f.id}`).join('')}${s.checkpoints.length ? `   checkpoints: ${s.checkpoints.join(', ')}` : ''}${s.live ? '   live: yes' : ''}`);
        }
      }
      return 0;
    }
    case 'run': {
      const m = need(getScenario(pos[0]), pos[0]);
      const t = runFrom(flags, m);
      const results = evaluateAll(m.scenario.assertions, t, m.scenario);
      if (flags.out) writeFileSync(flags.out[0], JSON.stringify(t, null, 2));
      if (flags.json) { console.log(JSON.stringify({ trace: { id: t.id, status: t.status, hashes: t.hashes, events: t.events.length }, assertions: results, summary: summarize(results) }, null, 2)); return 0; }
      printTraceHeader(t);
      if (flags.events) printEvents(t);
      console.log('');
      printAssertions(results);
      if (flags.out) console.log(`\n  trace written to ${flags.out[0]}`);
      return 0;
    }
    case 'compare': {
      let a: Trace, b: Trace;
      if (flags['trace-a'] && flags['trace-b']) { a = loadTraceFile(flags['trace-a'][0]); b = loadTraceFile(flags['trace-b'][0]); }
      else {
        const m = need(getScenario(pos[0]), pos[0]);
        const side = (spec: string | undefined) => {
          const [pol, preset] = (spec ?? 'faulty').split(':');
          return runScenario(m.scenario, m.workflow, { policy: pickPolicy(m.scenario, pol), faultPlan: pickPlan(m.scenario, preset) });
        };
        a = side(flags.a?.[0]); b = side(flags.b?.[0] ?? 'corrected');
      }
      const c = compareRuns(a, b);
      console.log(`A ${c.a.id} (${c.a.events} events)  vs  B ${c.b.id} (${c.b.events} events)`);
      console.log(`  ${c.note}`);
      console.log(`  aligned rows: ${c.rows.length}  same ${c.counts.same}  changed ${c.counts.changed}  only A ${c.counts['only-a']}  only B ${c.counts['only-b']}`);
      console.log(`  normalized streams identical: ${c.identicalNormalized}`);
      if (c.firstDivergence) {
        const d = c.firstDivergence;
        console.log(`\n  ${d.description}`);
        console.log(`  A: ${d.a ? `#${d.a.seq} ${d.a.summary}` : '(none)'}`);
        console.log(`  B: ${d.b ? `#${d.b.seq} ${d.b.summary}` : '(none)'}`);
        console.log(`  downstream in B: ${d.downstreamB.length ? d.downstreamB.map((s) => `#${s}`).join(' ') : 'none recorded'}`);
        console.log('  This is the first observed divergence between two recordings, not a proven root cause.');
      } else console.log('\n  No behavioral divergence observed.');
      if (c.stateDiffs.length) {
        console.log('\n  Final state differences:');
        for (const d of c.stateDiffs.slice(0, 12)) console.log(`    ${d.path}: ${JSON.stringify(d.a)} -> ${JSON.stringify(d.b)}`);
      }
      return 0;
    }
    case 'fork': {
      const m = need(getScenario(pos[0]), pos[0]);
      const parent = runFrom(flags, m);
      const at = flags.at?.[0] ?? m.scenario.checkpoints[0];
      if (!at) throw new CliError(`${m.scenario.id} declares no forkable checkpoint`);
      const child = forkRun(m.scenario, m.workflow, parent, at, {
        policy: flags['to-policy'] ? pickPolicy(m.scenario, flags['to-policy'][0]) : undefined,
        faultPlan: flags['to-faults'] ? pickPlan(m.scenario, flags['to-faults'][0]) : undefined,
      });
      printTraceHeader(parent);
      printTraceHeader(child);
      console.log('\nParent assertions:');
      printAssertions(evaluateAll(m.scenario.assertions, parent, m.scenario));
      console.log('\nFork assertions:');
      printAssertions(evaluateAll(m.scenario.assertions, child, m.scenario));
      return 0;
    }
    case 'graph': {
      const m = need(getScenario(pos[0]), pos[0]);
      console.log(renderAsciiGraph(buildGraph(runFrom(flags, m)), 200));
      console.log('\nlegend: [o] ok  [x] error  [#] blocked  [!] fault  [.] other   <cause  ~retry  +spawn');
      return 0;
    }
    case 'export': {
      const m = need(getScenario(pos[0]), pos[0]);
      if (!flags.out) throw new CliError('--out <bundle.json> is required');
      const t = runFrom(flags, m);
      const b = exportBundle(m.scenario, t, { includeTrace: !flags['no-trace'], userPaths: flags['redact-path'] ?? [] });
      console.log('Redaction preview (what will leave this machine):');
      console.log(`  rules: ${b.redaction?.rules.join(', ')}`);
      if (b.redaction?.findings.length) for (const f of b.redaction.findings) console.log(`  redacted ${f.path}  [${f.rule}]  ${f.preview}`);
      else console.log('  no values matched in the trace copy');
      if (b.redaction?.scenarioWarnings.length) for (const f of b.redaction.scenarioWarnings) console.log(`  WARNING scenario contains ${f.rule} at ${f.path}; it is not redacted because re-execution needs it`);
      console.log(`  ${b.redaction?.disclaimer}`);
      writeFileSync(flags.out[0], bundleToText(b));
      console.log(`\nBundle written to ${flags.out[0]}`);
      console.log(`  ${JSON.stringify(bundleFingerprint(b))}`);
      console.log(`  verify with: failure-atlas verify ${flags.out[0]}`);
      return 0;
    }
    case 'verify': {
      if (!pos[0]) throw new CliError('Usage: failure-atlas verify <bundle.json>');
      const b = parseBundle(readFileSync(pos[0], 'utf8'));
      const r = verifyBundle(b, getWorkflow);
      console.log(`Verifying ${b.title}`);
      for (const c of r.checks) console.log(`  ${c.ok ? '[ok]  ' : '[FAIL]'} ${c.name}: ${c.detail}`);
      console.log(`\n${r.ok ? 'REPRODUCED: every recorded expectation matched.' : 'NOT REPRODUCED: at least one expectation differs.'}`);
      return r.ok ? 0 : 1;
    }
    case 'inspect': {
      if (!pos[0]) throw new CliError('Usage: failure-atlas inspect <file.json>');
      const raw = parseJsonText(readFileSync(pos[0], 'utf8'), LIMITS.maxTraceBytes, pos[0]);
      let t: Trace;
      if (isOtlpJson(raw)) {
        const { trace, report } = importOtlp(raw);
        t = trace;
        console.log(`OTLP/JSON import (gen-ai semconv pinned at ${report.pin.commit.slice(0, 8)}, stability ${report.pin.stability})`);
        console.log(`  spans ${report.spans}, converted ${report.converted}, skipped non-GenAI ${report.skippedNonGenAi}`);
        for (const [op, n] of Object.entries(report.unsupportedOperations)) console.log(`  unsupported operation ${op}: ${n} span(s) kept as notes`);
        for (const w of report.warnings) console.log(`  warning: ${w}`);
      } else {
        const v = validateTrace(raw);
        t = v.trace;
        console.log(`Native trace ${t.schema}: integrity ${v.integrity}`);
      }
      printTraceHeader(t);
      console.log(`  executable: ${t.capabilities.executable}  forkable: ${t.capabilities.forkable}  state: ${t.capabilities.stateAvailable}`);
      for (const r of t.capabilities.reasons) console.log(`  - ${r}`);
      if (flags.events) printEvents(t);
      const scen = t.scenario ? getScenario(t.scenario.id)?.scenario ?? null : null;
      if (scen) { console.log(''); printAssertions(evaluateAll(scen.assertions, t, scen)); }
      return 0;
    }
    case 'validate-scenario': {
      if (!pos[0]) throw new CliError('Usage: failure-atlas validate-scenario <file.json>');
      const raw = parseJsonText(readFileSync(pos[0], 'utf8'), LIMITS.maxScenarioBytes, pos[0]);
      const s = validateScenario(raw, getWorkflow);
      console.log(`valid: ${s.id}@${s.version} (${s.fixtures.length} fixtures, ${s.assertions.length} assertions, workflow ${s.workflow.id}@${s.workflow.version})`);
      return 0;
    }
    case 'matrix': {
      const rows: any[] = [];
      for (const m of SCENARIOS) for (const p of m.scenario.policies) for (const f of [null, ...m.scenario.faultPresets]) {
        const t = runScenario(m.scenario, m.workflow, { policy: p, faultPlan: f });
        const t2 = runScenario(m.scenario, m.workflow, { policy: p, faultPlan: f });
        const res = evaluateAll(m.scenario.assertions, t, m.scenario);
        const s = summarize(res);
        rows.push({ scenario: m.scenario.id, policy: p.id, faults: f?.id ?? 'none', status: t.status, events: t.events.length, reproducible: t.hashes.events === t2.hashes.events && t.hashes.state === t2.hashes.state, pass: s.pass, fail: s.fail, error: s.error, unavailable: s.unavailable, notApplicable: s.notApplicable, failed: res.filter((r) => r.status === 'fail').map((r) => r.assertionId) });
      }
      if (flags.json) { console.log(JSON.stringify(rows, null, 2)); return 0; }
      console.log('| scenario | policy | faults | status | events | reproducible | pass | fail | n/a | failed checks |');
      console.log('|---|---|---|---|---|---|---|---|---|---|');
      for (const r of rows) console.log(`| ${r.scenario} | ${r.policy} | ${r.faults} | ${r.status} | ${r.events} | ${r.reproducible ? 'yes' : 'NO'} | ${r.pass} | ${r.fail} | ${r.notApplicable} | ${r.failed.join(', ') || '-'} |`);
      return 0;
    }
    case 'live': {
      const m = need(getScenario(pos[0]), pos[0]);
      const { configFromEnv } = await import('../live/openai-compatible');
      const { runLive } = await import('../live/live-runner');
      const cfg = configFromEnv();
      if (!cfg) throw new CliError('Live execution is disabled: set FA_LIVE_BASE_URL and FA_LIVE_MODEL (and FA_LIVE_API_KEY if the endpoint needs one). Fixture modes work without them.');
      if (!m.scenario.live) throw new CliError(`${m.scenario.id} declares no live task. Live-capable: ${SCENARIOS.filter((s) => s.scenario.live).map((s) => s.scenario.id).join(', ')}`);
      const ac = new AbortController();
      process.on('SIGINT', () => ac.abort());
      const t = await runLive(m.scenario, cfg, { stream: Boolean(flags.stream), maxTurns: flags['max-turns'] ? Number(flags['max-turns'][0]) : undefined, signal: ac.signal, onEvent: (e) => console.log(`  #${e.seq} ${e.kind.padEnd(16)} ${e.summary}`) });
      if (flags.out) writeFileSync(flags.out[0], JSON.stringify(t, null, 2));
      console.log('');
      printTraceHeader(t);
      printAssertions(evaluateAll(m.scenario.assertions, t, m.scenario));
      return 0;
    }
    default:
      throw new CliError(`Unknown command "${cmd}".\n\n${HELP}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err) => {
    if (err instanceof CliError) console.error(err.message);
    else if (err instanceof ImportError) { console.error(`${err.code}: ${err.message}`); for (const i of err.issues) console.error(`  - ${i}`); }
    else console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 2;
  },
);
