import type { Json } from './hash';

export type { Json };

/** Versioned schema identifiers. Bump the suffix on any breaking change and add a migration. */
export const SCHEMAS = {
  scenario: 'fa.scenario/1',
  policy: 'fa.policy/1',
  checkpoint: 'fa.checkpoint/1',
  toolContract: 'fa.tool-contract/1',
  faultPlan: 'fa.fault-plan/1',
  assertion: 'fa.assertion/1',
  event: 'fa.event/1',
  trace: 'fa.trace/1',
  bundle: 'fa.bundle/1',
} as const;

export const ENGINE_VERSION = '0.1.0';

export type ExecutionMode = 'playback' | 'simulation' | 'live';

export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null' | Array<'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'>;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: Json[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  minItems?: number;
  pattern?: string;
  description?: string;
}

export interface ToolContract {
  schema: typeof SCHEMAS.toolContract;
  name: string;
  description: string;
  input: JsonSchema;
  output: JsonSchema;
  sideEffects: 'none' | 'write';
  /** Simulated server-side idempotency: a repeated key returns the stored response without new writes. */
  idempotency?: { keyField: string; collection: string };
  /** True when a live adapter could reach outside the machine. Fixture runs never do. */
  external?: boolean;
}

export type StateWrite =
  | { op: 'insert'; collection: string; record: Json }
  | { op: 'set'; key: string; value: Json };

export interface FixtureMatch {
  /** Exact canonical arguments. Mutually exclusive with argsFields. */
  args?: Json;
  /** Compare only these argument fields (declared explicitly, never implied). */
  argsFields?: Record<string, Json>;
  /** Relevant state predicates, path -> expected value, evaluated on the external state. */
  state?: Record<string, Json>;
  /** 1-based occurrence among calls with the same tool and canonical arguments. */
  occurrence?: number;
  /** Logical request identity supplied by the workflow. */
  logicalId?: string;
}

export interface FixtureEntry {
  id: string;
  tool: string;
  match: FixtureMatch;
  response: { ok: true; value: Json } | { ok: false; error: ToolErrorShape };
  latencyMs: number;
  writes?: StateWrite[];
}

export interface ToolErrorShape {
  code: string;
  message: string;
  retryAfterMs?: number;
}

export type FaultPoint = 'before-request' | 'after-tool-commit' | 'before-response' | 'trigger-delivery' | 'clock';

export type FaultEffect =
  | { type: 'error'; code: string; message: string; retryAfterMs?: number }
  | { type: 'timeout' }
  | { type: 'drop-response' }
  | { type: 'delay'; ms: number }
  | { type: 'remove-fields'; paths: string[] }
  | { type: 'set-fields'; values: Record<string, Json> }
  | { type: 'truncate-array'; path: string; keep: number }
  | { type: 'duplicate'; delayMs: number }
  | { type: 'cancel' };

export interface Fault {
  id: string;
  description: string;
  point: FaultPoint;
  target: {
    tool?: string;
    argsMatch?: Record<string, Json>;
    /** 1-based occurrences among matching calls. Absent means every matching call. */
    occurrences?: number[];
    triggerId?: string;
    /** For clock faults: virtual time in milliseconds. */
    atMs?: number;
    /** Only calls issued strictly before this virtual time match (models a time window such as a rate limit). */
    beforeMs?: number;
  };
  effect: FaultEffect;
  /** Set by forks: the fault cannot activate before this event sequence number. */
  notBeforeSeq?: number;
}

export interface FaultPlan {
  schema: typeof SCHEMAS.faultPlan;
  id: string;
  title: string;
  description: string;
  faults: Fault[];
}

export interface Policy {
  schema: typeof SCHEMAS.policy;
  id: string;
  label: string;
  workflowId: string;
  values: Record<string, Json>;
}

export type AssertionKind =
  | 'tool-schema'
  | 'required-evidence'
  | 'allowed-tools'
  | 'ordering'
  | 'retry-bound'
  | 'retry-after-honored'
  | 'cancellation'
  | 'idempotency'
  | 'completion'
  | 'invariant'
  | 'correlation'
  | 'freshness'
  | 'citations'
  | 'gap-disclosed'
  | 'no-execution-errors';

export interface AssertionDef {
  schema: typeof SCHEMAS.assertion;
  id: string;
  kind: AssertionKind;
  title: string;
  params: Record<string, Json>;
}

export type AssertionStatus = 'pass' | 'fail' | 'error' | 'unavailable';

export interface Evidence {
  eventSeqs: number[];
  statePaths: string[];
  values?: Json;
}

export interface AssertionResult {
  assertionId: string;
  kind: AssertionKind;
  title: string;
  status: AssertionStatus;
  message: string;
  /** What invariant was violated, stated plainly. Present on failures. */
  violated?: string;
  evidence: Evidence;
}

export interface TriggerDef {
  id: string;
  atMs: number;
  payload: Json;
}

export interface ScenarioDef {
  schema: typeof SCHEMAS.scenario;
  id: string;
  version: string;
  title: string;
  mechanism: string;
  summary: string;
  workflow: { id: string; version: string };
  tools: ToolContract[];
  allowedTools: string[];
  fixtures: FixtureEntry[];
  triggers: TriggerDef[];
  initialState?: { external?: Record<string, Json>; workflow?: Record<string, Json> };
  policies: Policy[];
  /** Fault presets. The first preset is the default demonstration. */
  faultPresets: FaultPlan[];
  assertions: AssertionDef[];
  checkpoints: string[];
  limits: { maxSteps: number; maxVirtualMs: number };
  seed: number;
  synthetic: true;
  notes: string[];
}

export type EventKind =
  | 'run.started'
  | 'run.finished'
  | 'trigger.received'
  | 'task.spawned'
  | 'task.joined'
  | 'step.started'
  | 'tool.request'
  | 'tool.response'
  | 'tool.error'
  | 'tool.response.late'
  | 'tool.dedup'
  | 'state.changed'
  | 'fault.injected'
  | 'retry.scheduled'
  | 'sleep'
  | 'checkpoint'
  | 'cancel.requested'
  | 'cancel.observed'
  | 'boundary.blocked'
  | 'check'
  | 'decision'
  | 'limit.exhausted'
  | 'fixture.miss'
  | 'fixture.ambiguous'
  | 'output'
  | 'model.request'
  | 'model.response'
  | 'model.chunk'
  | 'note';

export interface TraceEvent {
  schema: typeof SCHEMAS.event;
  seq: number;
  /** Virtual time in milliseconds since run start. */
  vt: number;
  /** Wall-clock ISO timestamp. Never part of normalized hashes. */
  wt?: string;
  kind: EventKind;
  task: string;
  step?: string;
  requestId?: string;
  logicalId?: string;
  attempt?: number;
  tool?: string;
  causes?: number[];
  origin: 'engine' | 'workflow' | 'fault' | 'fixture' | 'import' | 'live';
  summary: string;
  data: Json;
}

export interface CheckpointRecord {
  schema: typeof SCHEMAS.checkpoint;
  id: string;
  seq: number;
  vt: number;
  stateHash: string;
  prefixHash: string;
}

export interface ExternalState {
  kv: Record<string, Json>;
  collections: Record<string, Json[]>;
}

export interface RunState {
  external: ExternalState;
  workflow: Record<string, Json>;
}

export type RunStatus =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unresolved'
  | 'stalled'
  | 'limit-exhausted'
  | 'execution-error'
  | 'imported';

export interface ExecutionError {
  code: string;
  message: string;
  seq?: number;
}

export interface RunCapabilities {
  executable: boolean;
  stateAvailable: boolean;
  forkable: boolean;
  reasons: string[];
}

export interface Trace {
  schema: typeof SCHEMAS.trace;
  id: string;
  mode: ExecutionMode;
  parentRunId?: string;
  fork?: { checkpointId: string; seq: number; parentPrefixHash: string; prefixVerified: boolean; changes: Json };
  scenario: { id: string; version: string; hash: string } | null;
  workflow: { id: string; version: string } | null;
  policy: Policy | null;
  faultPlan: FaultPlan | null;
  seed: number | null;
  engineVersion: string;
  createdAt: string;
  status: RunStatus;
  outcome: Json;
  executionErrors: ExecutionError[];
  events: TraceEvent[];
  finalState: RunState | null;
  checkpoints: CheckpointRecord[];
  hashes: { events: string; state: string | null };
  capabilities: RunCapabilities;
  source?: { format: string; detail: string };
  live?: { adapter: string; model: string; endpoint: string; note: string };
  finalized: true;
}
