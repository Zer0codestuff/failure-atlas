import { evaluateAll, type EvaluatedAssertion } from './assertions';
import { canonicalize, hashJson, sha256 } from './hash';
import { redact, type RedactionFinding } from './redact';
import { hashEvents, runScenario } from './runner';
import { ENGINE_VERSION, SCHEMAS, type FaultPlan, type Json, type Policy, type ScenarioDef, type Trace } from './types';
import { checkSchemaVersion, ImportError, LIMITS, parseJsonText, validateScenario } from './validate';
import type { WorkflowDefinition } from './workflow';

/**
 * Regression bundle: a self-contained, declarative description of one run
 * configuration plus the outcomes it must reproduce. It carries the scenario
 * (contracts, fixtures, assertions), the policy, the fault plan, the seed, the
 * engine and schema versions, expected hashes and assertion outcomes, and
 * optionally a copy of the source trace for inspection.
 */
export interface RegressionBundle {
  schema: typeof SCHEMAS.bundle;
  createdAt: string;
  title: string;
  versions: { engine: string; schemas: typeof SCHEMAS; workflow: { id: string; version: string } };
  scenario: ScenarioDef;
  run: { policy: Policy; faultPlan: FaultPlan | null; seed: number };
  expected: {
    status: string;
    eventsHash: string;
    stateHash: string | null;
    eventCount: number;
    assertions: Array<{ id: string; status: string }>;
  };
  sourceTrace: Trace | null;
  redaction: { applied: boolean; rules: string[]; userPaths: string[]; findings: RedactionFinding[]; scenarioWarnings: RedactionFinding[]; disclaimer: string } | null;
  integrity: { algorithm: 'sha256'; hash: string; covers: string };
}

export interface ExportOptions {
  includeTrace?: boolean;
  redactTrace?: boolean;
  userPaths?: string[];
  title?: string;
  now?: string;
}

function integrityHash(b: Omit<RegressionBundle, 'integrity'>): string {
  return sha256(canonicalize(b));
}

export function exportBundle(scenario: ScenarioDef, trace: Trace, opts: ExportOptions = {}): RegressionBundle {
  if (trace.mode !== 'simulation' || !trace.policy) throw new Error('Only deterministic simulation runs can become regression bundles; playback and live traces are not reproducible by re-execution.');
  if (trace.fork) throw new Error('Export the fork as a bundle is not supported: bundles describe a full run configuration. Export the parent or rerun the forked configuration from the start.');
  const results = evaluateAll(scenario.assertions, trace, scenario);
  let sourceTrace: Trace | null = opts.includeTrace === false ? null : trace;
  let redaction: RegressionBundle['redaction'] = null;
  if (opts.redactTrace !== false) {
    const scen = redact(scenario);
    if (sourceTrace) {
      const r = redact(sourceTrace, { userPaths: opts.userPaths });
      sourceTrace = r.output;
      redaction = { applied: r.findings.length > 0, rules: r.rules, userPaths: r.userPaths, findings: r.findings, scenarioWarnings: scen.findings, disclaimer: r.disclaimer };
    } else redaction = { applied: false, rules: scen.rules, userPaths: [], findings: [], scenarioWarnings: scen.findings, disclaimer: scen.disclaimer };
  }
  const body: Omit<RegressionBundle, 'integrity'> = {
    schema: SCHEMAS.bundle,
    createdAt: opts.now ?? new Date().toISOString(),
    title: opts.title ?? `${scenario.title}: ${trace.policy.label}${trace.faultPlan ? ` under ${trace.faultPlan.title}` : ''}`,
    versions: { engine: ENGINE_VERSION, schemas: SCHEMAS, workflow: scenario.workflow },
    scenario,
    run: { policy: trace.policy, faultPlan: trace.faultPlan, seed: trace.seed ?? scenario.seed },
    expected: {
      status: trace.status,
      eventsHash: trace.hashes.events,
      stateHash: trace.hashes.state,
      eventCount: trace.events.length,
      assertions: results.map((r) => ({ id: r.assertionId, status: r.status })),
    },
    sourceTrace,
    redaction,
  };
  return { ...body, integrity: { algorithm: 'sha256', hash: integrityHash(body), covers: 'canonical JSON of every field except integrity' } };
}

export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface VerifyReport {
  ok: boolean;
  checks: VerifyCheck[];
  rerun: Trace | null;
  assertions: EvaluatedAssertion[];
}

export function parseBundle(text: string): RegressionBundle {
  const raw = parseJsonText(text, LIMITS.maxBundleBytes, 'Bundle');
  if (raw === null || typeof raw !== 'object') throw new ImportError('UNKNOWN_FORMAT', 'Bundle must be a JSON object.');
  return checkSchemaVersion(raw, SCHEMAS.bundle) as RegressionBundle;
}

/** Re-execute a bundle and compare every recorded expectation. Never calls a network service. */
export function verifyBundle(bundle: RegressionBundle, workflows: (id: string, version: string) => WorkflowDefinition | undefined): VerifyReport {
  const checks: VerifyCheck[] = [];
  const { integrity, ...body } = bundle;
  const recomputed = integrityHash(body);
  checks.push({ name: 'bundle integrity', ok: recomputed === integrity?.hash, detail: recomputed === integrity?.hash ? `sha256 ${recomputed.slice(0, 16)} matches` : `sha256 mismatch: recorded ${String(integrity?.hash).slice(0, 16)}, recomputed ${recomputed.slice(0, 16)}. The bundle was modified after export.` });
  checks.push({ name: 'engine version', ok: bundle.versions.engine === ENGINE_VERSION, detail: `bundle ${bundle.versions.engine}, runner ${ENGINE_VERSION}` });
  let scenario: ScenarioDef;
  try {
    scenario = validateScenario(bundle.scenario, workflows);
    checks.push({ name: 'scenario schema', ok: true, detail: `${scenario.id}@${scenario.version} is valid` });
  } catch (err) {
    const issues = err instanceof ImportError ? err.issues.join('; ') : '';
    checks.push({ name: 'scenario schema', ok: false, detail: `${err instanceof Error ? err.message : String(err)} ${issues}` });
    return { ok: false, checks, rerun: null, assertions: [] };
  }
  const workflow = workflows(scenario.workflow.id, scenario.workflow.version)!;
  if (bundle.sourceTrace) {
    if (bundle.redaction?.applied) checks.push({ name: 'source trace integrity', ok: true, detail: 'Source trace was redacted before export; its recorded hashes describe the unredacted original and are checked against the re-execution instead.' });
    else {
      const ok = hashEvents(bundle.sourceTrace.events) === bundle.expected.eventsHash;
      checks.push({ name: 'source trace integrity', ok, detail: ok ? 'source trace events hash to the expected value' : 'source trace events do not match the expected hash' });
    }
  }
  let rerun: Trace;
  try {
    rerun = runScenario(scenario, workflow, { policy: bundle.run.policy, faultPlan: bundle.run.faultPlan, seed: bundle.run.seed });
  } catch (err) {
    checks.push({ name: 're-execution', ok: false, detail: err instanceof Error ? err.message : String(err) });
    return { ok: false, checks, rerun: null, assertions: [] };
  }
  checks.push({ name: 'run status', ok: rerun.status === bundle.expected.status, detail: `expected ${bundle.expected.status}, got ${rerun.status}` });
  checks.push({ name: 'normalized event stream', ok: rerun.hashes.events === bundle.expected.eventsHash, detail: `${rerun.events.length} events, hash ${rerun.hashes.events.slice(0, 16)} (expected ${bundle.expected.eventsHash.slice(0, 16)})` });
  checks.push({ name: 'final state', ok: rerun.hashes.state === bundle.expected.stateHash, detail: `state hash ${String(rerun.hashes.state).slice(0, 16)} (expected ${String(bundle.expected.stateHash).slice(0, 16)})` });
  const assertions = evaluateAll(scenario.assertions, rerun, scenario);
  for (const exp of bundle.expected.assertions) {
    const got = assertions.find((a) => a.assertionId === exp.id);
    checks.push({ name: `assertion ${exp.id}`, ok: got?.status === exp.status, detail: `expected ${exp.status}, got ${got?.status ?? 'missing'}${got ? `: ${got.message}` : ''}` });
  }
  return { ok: checks.every((c) => c.ok), checks, rerun, assertions };
}

export function bundleToText(b: RegressionBundle): string {
  return JSON.stringify(b, null, 2) + '\n';
}

export function bundleFingerprint(b: RegressionBundle): Json {
  return { scenario: `${b.scenario.id}@${b.scenario.version}`, policy: b.run.policy.id, faultPlan: b.run.faultPlan?.id ?? null, eventsHash: b.expected.eventsHash.slice(0, 16), integrity: b.integrity.hash.slice(0, 16), scenarioHash: hashJson(b.scenario).slice(0, 16) };
}
