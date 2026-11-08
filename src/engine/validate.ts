import { checkFixtures } from './fixtures';
import { hashJson } from './hash';
import { checkSchemaKeywords, validate } from './jsonschema';
import { hashEvents } from './runner';
import { SCHEMAS, type AssertionKind, type EventKind, type FaultEffect, type FaultPoint, type ScenarioDef, type Trace } from './types';
import type { WorkflowDefinition } from './workflow';

/** Import limits. Files above these limits are rejected before parsing. */
export const LIMITS = {
  maxTraceBytes: 50 * 1024 * 1024,
  maxBundleBytes: 60 * 1024 * 1024,
  maxEvents: 250_000,
  maxScenarioBytes: 5 * 1024 * 1024,
} as const;

export class ImportError extends Error {
  constructor(readonly code: 'TOO_LARGE' | 'NOT_JSON' | 'UNKNOWN_FORMAT' | 'INCOMPATIBLE_VERSION' | 'INVALID' | 'INTEGRITY', message: string, readonly issues: string[] = []) {
    super(message);
  }
}

export const EVENT_KINDS: ReadonlySet<EventKind> = new Set<EventKind>([
  'run.started', 'run.finished', 'trigger.received', 'task.spawned', 'task.joined', 'step.started', 'tool.request', 'tool.response',
  'tool.error', 'tool.response.late', 'tool.dedup', 'state.changed', 'fault.injected', 'retry.scheduled', 'sleep', 'checkpoint',
  'cancel.requested', 'cancel.observed', 'boundary.blocked', 'check', 'decision', 'limit.exhausted', 'fixture.miss',
  'fixture.ambiguous', 'output', 'model.request', 'model.response', 'model.chunk', 'note',
]);

const ASSERTION_KINDS: ReadonlySet<AssertionKind> = new Set<AssertionKind>([
  'tool-schema', 'required-evidence', 'allowed-tools', 'ordering', 'retry-bound', 'retry-after-honored', 'cancellation',
  'idempotency', 'completion', 'invariant', 'correlation', 'freshness', 'citations', 'gap-disclosed', 'no-execution-errors',
]);
const FAULT_POINTS: ReadonlySet<FaultPoint> = new Set<FaultPoint>(['before-request', 'after-tool-commit', 'before-response', 'trigger-delivery', 'clock']);
const FAULT_EFFECTS: ReadonlySet<FaultEffect['type']> = new Set<FaultEffect['type']>(['error', 'timeout', 'drop-response', 'delay', 'remove-fields', 'set-fields', 'truncate-array', 'duplicate', 'cancel']);

/** Fault effects that make sense at each point. Anything else is rejected rather than ignored. */
export const EFFECTS_BY_POINT: Record<FaultPoint, ReadonlyArray<FaultEffect['type']>> = {
  'before-request': ['error', 'timeout', 'delay'],
  'after-tool-commit': ['drop-response', 'error', 'delay'],
  'before-response': ['delay', 'drop-response', 'error', 'remove-fields', 'set-fields', 'truncate-array'],
  'trigger-delivery': ['duplicate'],
  clock: ['cancel'],
};

/**
 * Documented migrations from older schema identifiers. Empty in this release:
 * fa.<kind>/1 is the first published format. A future fa.trace/2 reader adds an
 * entry here instead of guessing.
 */
export const MIGRATIONS: Record<string, { to: string; describe: string; migrate: (input: any) => any }> = {};

function schemaFamily(id: unknown): { family: string; version: number } | null {
  if (typeof id !== 'string') return null;
  const m = id.match(/^fa\.([a-z-]+)\/(\d+)$/);
  return m ? { family: m[1], version: Number(m[2]) } : null;
}

/** Resolve a schema identifier: exact match, documented migration, or a useful incompatibility error. */
export function checkSchemaVersion(input: any, expected: string): any {
  if (input?.schema === expected) return input;
  const migration = MIGRATIONS[input?.schema];
  if (migration && migration.to === expected) return migration.migrate(input);
  const got = schemaFamily(input?.schema);
  const want = schemaFamily(expected)!;
  if (!got) throw new ImportError('UNKNOWN_FORMAT', `Not a Failure Atlas ${want.family}: missing or unrecognized "schema" field (${JSON.stringify(input?.schema ?? null)}). Parsing JSON is not proof of format compatibility.`);
  if (got.family !== want.family) throw new ImportError('UNKNOWN_FORMAT', `Expected a ${want.family} (${expected}) but the file declares ${input.schema}.`);
  if (got.version > want.version) throw new ImportError('INCOMPATIBLE_VERSION', `${input.schema} is newer than this build supports (${expected}). Update Failure Atlas; events were not read or dropped.`);
  throw new ImportError('INCOMPATIBLE_VERSION', `${input.schema} is older than ${expected} and no documented migration exists. The file was not modified.`);
}

export function parseJsonText(text: string, maxBytes: number, what: string): unknown {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > maxBytes) throw new ImportError('TOO_LARGE', `${what} is ${(bytes / 1048576).toFixed(1)} MB, above the ${(maxBytes / 1048576).toFixed(0)} MB import limit.`);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ImportError('NOT_JSON', `${what} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const isObj = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Structural validation of a native trace. Unknown kinds are errors, never silently dropped. */
export function validateTrace(raw: unknown): { trace: Trace; issues: string[]; integrity: 'verified' | 'mismatch' } {
  if (!isObj(raw)) throw new ImportError('UNKNOWN_FORMAT', 'Trace must be a JSON object.');
  const t = checkSchemaVersion(raw, SCHEMAS.trace) as Trace;
  const issues: string[] = [];
  const need = (cond: boolean, msg: string) => { if (!cond) issues.push(msg); };
  need(typeof t.id === 'string' && t.id.length > 0, 'id must be a non-empty string');
  need(['playback', 'simulation', 'live'].includes(t.mode), `mode must be playback, simulation or live (got ${JSON.stringify(t.mode)})`);
  need(Array.isArray(t.events), 'events must be an array');
  need(isObj(t.hashes) && typeof t.hashes.events === 'string', 'hashes.events must be present');
  need(isObj(t.capabilities), 'capabilities must be present');
  if (Array.isArray(t.events)) {
    if (t.events.length > LIMITS.maxEvents) throw new ImportError('TOO_LARGE', `Trace has ${t.events.length} events, above the ${LIMITS.maxEvents} limit.`);
    let lastVt = -Infinity;
    t.events.forEach((e: any, i: number) => {
      if (issues.length > 50) return;
      if (!isObj(e)) { issues.push(`events[${i}] is not an object`); return; }
      if (e.schema !== SCHEMAS.event) issues.push(`events[${i}].schema is ${JSON.stringify(e.schema)}, expected ${SCHEMAS.event}`);
      if (e.seq !== i + 1) issues.push(`events[${i}].seq is ${e.seq}, expected ${i + 1} (sequence numbers must be contiguous)`);
      if (typeof e.vt !== 'number' || e.vt < lastVt) issues.push(`events[${i}].vt must be a non-decreasing number`);
      lastVt = typeof e.vt === 'number' ? e.vt : lastVt;
      if (!EVENT_KINDS.has(e.kind)) issues.push(`events[${i}].kind ${JSON.stringify(e.kind)} is not a known event kind`);
      if (typeof e.summary !== 'string') issues.push(`events[${i}].summary must be a string`);
      if (e.causes !== undefined && (!Array.isArray(e.causes) || e.causes.some((c: unknown) => typeof c !== 'number' || (c as number) >= e.seq))) issues.push(`events[${i}].causes must reference earlier events`);
    });
  }
  if (issues.length) throw new ImportError('INVALID', `Trace ${String(t.id)} failed validation with ${issues.length} issue(s).`, issues.slice(0, 50));
  const integrity = hashEvents(t.events) === t.hashes.events && (!t.finalState || hashJson(t.finalState) === t.hashes.state) ? 'verified' : 'mismatch';
  return { trace: t, issues, integrity };
}

/** Validate a declarative scenario. Scenarios contain data only; workflows come from the local registry. */
export function validateScenario(raw: unknown, workflows: (id: string, version: string) => WorkflowDefinition | undefined): ScenarioDef {
  if (!isObj(raw)) throw new ImportError('UNKNOWN_FORMAT', 'Scenario must be a JSON object.');
  const s = checkSchemaVersion(raw, SCHEMAS.scenario) as ScenarioDef;
  const issues: string[] = [];
  const need = (cond: boolean, msg: string) => { if (!cond) issues.push(msg); };
  for (const k of ['id', 'version', 'title', 'mechanism', 'summary'] as const) need(typeof s[k] === 'string' && s[k].length > 0, `${k} must be a non-empty string`);
  need(isObj(s.workflow), 'workflow must name a registered workflow');
  const wf = isObj(s.workflow) ? workflows(s.workflow.id, s.workflow.version) : undefined;
  need(Boolean(wf), `workflow ${s.workflow?.id}@${s.workflow?.version} is not registered in this build. Imported scenarios cannot supply their own code.`);
  need(Array.isArray(s.tools) && Array.isArray(s.fixtures) && Array.isArray(s.triggers) && Array.isArray(s.policies) && Array.isArray(s.faultPresets) && Array.isArray(s.assertions), 'tools, fixtures, triggers, policies, faultPresets and assertions must be arrays');
  need(Array.isArray(s.allowedTools) && s.allowedTools.every((t) => typeof t === 'string'), 'allowedTools must be a list of tool names');
  need(isObj(s.limits) && Number.isInteger(s.limits.maxSteps) && s.limits.maxSteps > 0 && s.limits.maxSteps <= 1_000_000 && typeof s.limits.maxVirtualMs === 'number', 'limits.maxSteps (1..1000000) and limits.maxVirtualMs are required');
  need(Number.isInteger(s.seed), 'seed must be an integer');
  need(s.synthetic === true, 'synthetic must be true: shipped and imported scenarios describe controlled fixtures');
  if (issues.length) throw new ImportError('INVALID', `Scenario failed validation with ${issues.length} issue(s).`, issues);
  for (const t of s.tools) {
    if (t.schema !== SCHEMAS.toolContract) issues.push(`tool ${t.name}: schema must be ${SCHEMAS.toolContract}`);
    for (const i of [...checkSchemaKeywords(t.input), ...checkSchemaKeywords(t.output)]) issues.push(`tool ${t.name}: ${i.path} ${i.message}`);
  }
  issues.push(...checkFixtures(s));
  for (const p of s.policies) {
    if (p.workflowId !== s.workflow.id) issues.push(`policy ${p.id} targets workflow ${p.workflowId}`);
    for (const i of validate(wf!.policySchema, p.values)) issues.push(`policy ${p.id}: ${i.path} ${i.message}`);
  }
  for (const plan of s.faultPresets) {
    for (const f of plan.faults) {
      if (!FAULT_POINTS.has(f.point)) issues.push(`fault ${f.id}: unknown point ${f.point}`);
      else if (!FAULT_EFFECTS.has(f.effect?.type)) issues.push(`fault ${f.id}: unknown effect ${f.effect?.type}`);
      else if (!EFFECTS_BY_POINT[f.point].includes(f.effect.type)) issues.push(`fault ${f.id}: effect ${f.effect.type} is not supported at ${f.point} (supported: ${EFFECTS_BY_POINT[f.point].join(', ')})`);
      if (['before-request', 'after-tool-commit', 'before-response'].includes(f.point) && !s.tools.some((t) => t.name === f.target?.tool)) issues.push(`fault ${f.id}: target tool ${f.target?.tool} has no contract`);
      if (f.point === 'trigger-delivery' && !s.triggers.some((t) => t.id === f.target?.triggerId)) issues.push(`fault ${f.id}: unknown trigger ${f.target?.triggerId}`);
    }
  }
  for (const a of s.assertions) if (!ASSERTION_KINDS.has(a.kind)) issues.push(`assertion ${a.id}: unknown kind ${a.kind}`);
  if (issues.length) throw new ImportError('INVALID', `Scenario ${s.id} failed validation with ${issues.length} issue(s).`, issues);
  return s;
}
