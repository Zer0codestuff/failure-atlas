import { Sha256, canonicalize, cloneJson, createRng, deepFreeze, deletePath, getPath, hashJson, setPath, shortHash, type Json } from './hash';
import { expandTemplate, resolveFixture } from './fixtures';
import { validate } from './jsonschema';
import {
  ENGINE_VERSION,
  SCHEMAS,
  type CheckpointRecord,
  type EventKind,
  type ExecutionError,
  type Fault,
  type FaultPlan,
  type Policy,
  type RunState,
  type RunStatus,
  type ScenarioDef,
  type ToolContract,
  type ToolErrorShape,
  type Trace,
  type TraceEvent,
} from './types';
import { WorkflowContext, type Gen, type Op, type ToolResult, type WorkflowDefinition, type WorkflowOutcome } from './workflow';

export interface RunOptions {
  policy: Policy;
  faultPlan: FaultPlan | null;
  seed?: number;
  /** Tie-breaking policy for events scheduled at the same virtual time. */
  schedule?: 'fifo' | 'seeded-shuffle';
  /** Called synchronously for every recorded event (used to stream events to the UI). */
  onEvent?: (e: TraceEvent) => void;
  /** Include wall-clock timestamps in events. They never affect hashes. */
  wallClock?: boolean;
  fork?: ForkRequest;
  /** Default transport timeout when a call declares none (virtual ms). */
  defaultTimeoutMs?: number;
}

export interface ForkRequest {
  parent: Trace;
  checkpointId: string;
  /** Policy applied after the checkpoint. */
  policy?: Policy;
  /** Fault plan applied after the checkpoint. */
  faultPlan?: FaultPlan | null;
}

export class RunConfigError extends Error {}
export class ForkError extends Error {}

interface Task {
  id: string;
  gen: Gen<Json>;
  parent: Task | null;
  root: boolean;
  done: boolean;
  result?: Json;
  join?: { remaining: number; results: Json[]; childIds: string[]; step: string; spawnSeq: number };
  joinIndex?: number;
}

interface Wakeup {
  at: number;
  order: number;
  tie: number;
  fn: () => void;
  cancelled?: boolean;
}

interface ActiveFault {
  fault: Fault;
  fromSeq: number;
  untilSeq: number;
  matches: number;
}

class AbortRun extends Error {
  constructor(readonly status: RunStatus, message: string) {
    super(message);
  }
}

/** Normalized event: drops wall-clock time so equal runs hash equally. */
export function normalizeEvent(e: TraceEvent): Omit<TraceEvent, 'wt'> {
  const { wt: _wt, ...rest } = e;
  return rest;
}

export function hashEvents(events: TraceEvent[]): string {
  return hashJson(events.map(normalizeEvent));
}

/**
 * hashEvents of several prefixes in one linear pass: the digest for seq k equals
 * hashEvents(events.filter((e) => e.seq <= k)).
 */
export function prefixHashes(events: TraceEvent[], seqs: Iterable<number>): Map<number, string> {
  const want = new Set(seqs);
  const out = new Map<number, string>();
  if (!want.size) return out;
  const h = new Sha256().update('[');
  for (let i = 0; i < events.length && out.size < want.size; i++) {
    if (i) h.update(',');
    h.update(canonicalize(normalizeEvent(events[i])));
    if (want.has(events[i].seq)) out.set(events[i].seq, h.clone().update(']').digest());
  }
  return out;
}

const STATUS_RANK: Record<RunStatus, number> = {
  'execution-error': 6,
  stalled: 5,
  'limit-exhausted': 4,
  failed: 3,
  unresolved: 2.5,
  cancelled: 2,
  completed: 1,
  imported: 0,
};

export function runScenario(scenario: ScenarioDef, workflow: WorkflowDefinition, opts: RunOptions): Trace {
  return new Runner(scenario, workflow, opts).run();
}

/**
 * Fork a finalized simulated run at a declared checkpoint. The parent's
 * configuration is replayed up to the checkpoint and verified against the
 * recorded prefix hash; the changes apply only after the checkpoint. The
 * parent trace is never modified.
 */
export function forkRun(
  scenario: ScenarioDef,
  workflow: WorkflowDefinition,
  parent: Trace,
  checkpointId: string,
  changes: { policy?: Policy; faultPlan?: FaultPlan | null },
  extra: Pick<RunOptions, 'onEvent' | 'wallClock'> = {},
): Trace {
  if (parent.mode !== 'simulation' || !parent.capabilities.executable) {
    throw new ForkError(`Run ${parent.id} is ${parent.mode}; only deterministic simulation runs with executable state can be forked`);
  }
  if (!parent.policy) throw new ForkError('Parent run has no policy');
  if (!scenario.checkpoints.includes(checkpointId)) throw new ForkError(`Checkpoint ${checkpointId} is not declared as forkable by scenario ${scenario.id}`);
  if (!parent.checkpoints.some((c) => c.id === checkpointId)) throw new ForkError(`Parent run never reached checkpoint ${checkpointId}`);
  if (parent.scenario?.hash !== hashJson(scenario)) throw new ForkError('Scenario definition changed since the parent run; fork refused');
  const parentPolicy = parent.fork ? null : parent.policy;
  if (!parentPolicy) throw new ForkError('Forking a fork is not supported yet; fork the original run instead');
  return runScenario(scenario, workflow, {
    policy: parentPolicy,
    faultPlan: parent.faultPlan,
    seed: parent.seed ?? scenario.seed,
    fork: { parent, checkpointId, policy: changes.policy, faultPlan: changes.faultPlan },
    ...extra,
  });
}

class Runner {
  private readonly events: TraceEvent[] = [];
  private readonly queue: Wakeup[] = [];
  private order = 0;
  private clock = 0;
  private steps = 0;
  private taskCounter = 0;
  private readonly rng: () => number;
  private readonly tieRng: () => number;
  private readonly state: RunState;
  private readonly tools: Map<string, ToolContract>;
  private readonly faults: ActiveFault[] = [];
  private readonly fixtureOccurrences = new Map<string, number>();
  private readonly requestCounters = new Map<string, number>();
  private readonly roots: Task[] = [];
  private readonly checkpoints: CheckpointRecord[] = [];
  private readonly errors: ExecutionError[] = [];
  private cancelRequestedSeq: number | null = null;
  private forkSwitchSeq: number | null = null;
  private policyValues: Record<string, Json>;
  private readonly seed: number;

  constructor(private readonly scenario: ScenarioDef, private readonly workflow: WorkflowDefinition, private readonly opts: RunOptions) {
    if (scenario.workflow.id !== workflow.id) throw new RunConfigError(`Scenario expects workflow ${scenario.workflow.id}, got ${workflow.id}`);
    if (scenario.workflow.version !== workflow.version) {
      throw new RunConfigError(`Scenario pins workflow ${workflow.id}@${scenario.workflow.version}, runner provides ${workflow.version}`);
    }
    const policyIssues = validate(workflow.policySchema, opts.policy.values);
    if (policyIssues.length) throw new RunConfigError(`Policy ${opts.policy.id} is invalid: ${policyIssues.map((i) => `${i.path} ${i.message}`).join('; ')}`);
    if (opts.fork?.policy) {
      const forkIssues = validate(workflow.policySchema, opts.fork.policy.values);
      if (forkIssues.length) throw new RunConfigError(`Fork policy is invalid: ${forkIssues.map((i) => `${i.path} ${i.message}`).join('; ')}`);
    }
    this.seed = opts.seed ?? scenario.seed;
    this.rng = createRng(this.seed);
    this.tieRng = createRng(this.seed ^ 0x9e3779b9);
    this.state = {
      external: { kv: cloneJson(scenario.initialState?.external ?? {}), collections: {} },
      workflow: cloneJson(scenario.initialState?.workflow ?? {}),
    };
    this.tools = new Map(scenario.tools.map((t) => [t.name, t]));
    this.policyValues = opts.policy.values;
    this.installFaults();
  }

  private installFaults() {
    const fork = this.opts.fork;
    const base = this.opts.faultPlan?.faults ?? [];
    if (!fork) {
      for (const f of base) this.faults.push({ fault: f, fromSeq: f.notBeforeSeq ?? 0, untilSeq: Infinity, matches: 0 });
      return;
    }
    const cp = fork.parent.checkpoints.find((c) => c.id === fork.checkpointId);
    if (!cp) throw new ForkError(`Parent run has no checkpoint ${fork.checkpointId}`);
    const after = fork.faultPlan === undefined ? base : fork.faultPlan?.faults ?? [];
    const afterKeys = new Set(after.map((f) => canonicalize(f)));
    const baseKeys = new Set(base.map((f) => canonicalize(f)));
    for (const f of base) this.faults.push({ fault: f, fromSeq: 0, untilSeq: afterKeys.has(canonicalize(f)) ? Infinity : cp.seq, matches: 0 });
    for (const f of after) if (!baseKeys.has(canonicalize(f))) this.faults.push({ fault: f, fromSeq: cp.seq + 1, untilSeq: Infinity, matches: 0 });
  }

  // ---------------------------------------------------------------- events

  private emit(e: Omit<TraceEvent, 'schema' | 'seq' | 'vt' | 'wt'>): TraceEvent {
    const event: TraceEvent = {
      schema: SCHEMAS.event,
      seq: this.events.length + 1,
      vt: this.clock,
      ...(this.opts.wallClock ? { wt: new Date().toISOString() } : {}),
      ...e,
      data: e.data === undefined ? null : cloneJson(e.data),
      ...(e.causes ? { causes: [...new Set(e.causes)].filter((c) => c < this.events.length + 1).sort((x, y) => x - y) } : {}),
    };
    this.events.push(event);
    this.opts.onEvent?.(event);
    return event;
  }

  private executionError(code: string, message: string, seq?: number) {
    this.errors.push({ code, message, seq });
  }

  // ------------------------------------------------------------- scheduling

  private schedule(at: number, fn: () => void): Wakeup {
    const w: Wakeup = { at, order: this.order++, tie: this.opts.schedule === 'seeded-shuffle' ? this.tieRng() : 0, fn };
    // Binary insertion keeps the queue ordered by (at, tie, order).
    let lo = 0;
    let hi = this.queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const q = this.queue[mid];
      const before = q.at < w.at || (q.at === w.at && (q.tie < w.tie || (q.tie === w.tie && q.order < w.order)));
      if (before) lo = mid + 1;
      else hi = mid;
    }
    this.queue.splice(lo, 0, w);
    return w;
  }

  // ------------------------------------------------------------------- run

  run(): Trace {
    const startedAt = new Date().toISOString();
    let status: RunStatus = 'completed';
    let abortMessage = '';
    this.emit({
      kind: 'run.started',
      task: 'engine',
      origin: 'engine',
      summary: `Deterministic simulation of ${this.scenario.title} with policy "${this.opts.policy.label}" and ${this.opts.faultPlan ? `fault plan "${this.opts.faultPlan.title}"` : 'no faults'}`,
      data: {
        scenario: this.scenario.id,
        policy: this.opts.policy.id,
        faultPlan: this.opts.faultPlan?.id ?? null,
        seed: this.seed,
        schedule: this.opts.schedule ?? 'fifo',
      },
    });
    try {
      this.scheduleTriggers();
      this.scheduleClockFaults();
      while (this.queue.length) {
        const next = this.queue.shift()!;
        if (next.cancelled) continue;
        if (next.at > this.scenario.limits.maxVirtualMs) {
          throw new AbortRun('limit-exhausted', `Virtual time limit of ${this.scenario.limits.maxVirtualMs} ms reached`);
        }
        this.clock = Math.max(this.clock, next.at);
        next.fn();
      }
      const pending = this.roots.filter((r) => !r.done);
      if (pending.length) throw new AbortRun('stalled', `No runnable work remains but ${pending.length} workflow task(s) are waiting`);
    } catch (err) {
      if (err instanceof AbortRun) {
        status = err.status;
        abortMessage = err.message;
        if (err.status === 'limit-exhausted') {
          this.emit({ kind: 'limit.exhausted', task: 'engine', origin: 'engine', summary: `Engine limit reached: ${err.message}. Work in progress was not completed.`, data: { limit: err.message, steps: this.steps } });
        } else if (err.status === 'stalled') {
          this.emit({ kind: 'note', task: 'engine', origin: 'engine', summary: `Run stalled: ${err.message}`, data: { reason: err.message } });
          this.executionError('STALLED', err.message);
        } else {
          this.executionError('ABORTED', err.message);
        }
      } else {
        status = 'execution-error';
        abortMessage = err instanceof Error ? err.message : String(err);
        this.executionError('WORKFLOW_EXCEPTION', abortMessage);
        this.emit({ kind: 'note', task: 'engine', origin: 'engine', summary: `Workflow threw an exception: ${abortMessage}`, data: { error: abortMessage } });
      }
    }

    const outcomes = this.roots.map((r) => (r.done ? r.result ?? null : null));
    if (status === 'completed') {
      for (const r of this.roots) {
        const s = (r.result as WorkflowOutcome | undefined)?.status;
        const mapped: RunStatus = s === 'failed' ? 'failed' : s === 'cancelled' ? 'cancelled' : s === 'unresolved' ? 'unresolved' : 'completed';
        if (STATUS_RANK[mapped] > STATUS_RANK[status]) status = mapped;
      }
      if (this.errors.length && STATUS_RANK['execution-error'] > STATUS_RANK[status]) status = 'execution-error';
    }
    const outcome: Json = outcomes.length === 1 ? outcomes[0] : outcomes;
    this.emit({
      kind: 'run.finished',
      task: 'engine',
      origin: 'engine',
      summary: `Run finished with status ${status}${abortMessage ? ` (${abortMessage})` : ''}`,
      data: { status, outcome, executionErrors: this.errors.length },
    });

    const prefixes = prefixHashes(this.events, this.checkpoints.map((c) => c.seq));
    for (const c of this.checkpoints) c.prefixHash = prefixes.get(c.seq)!;

    // Fork integrity: the replayed prefix must equal the parent's recorded prefix.
    let forkInfo: Trace['fork'];
    if (this.opts.fork) {
      const cp = this.opts.fork.parent.checkpoints.find((c) => c.id === this.opts.fork!.checkpointId)!;
      const childPrefix = prefixHashes(this.events, [cp.seq]).get(cp.seq);
      if (childPrefix !== cp.prefixHash) {
        throw new ForkError(
          `Fork refused: replaying ${this.scenario.id} up to checkpoint ${cp.id} did not reproduce the parent's recorded prefix. The requested change affects behavior before the checkpoint, or the implementation changed.`,
        );
      }
      forkInfo = {
        checkpointId: cp.id,
        seq: cp.seq,
        parentPrefixHash: cp.prefixHash,
        prefixVerified: true,
        changes: { policy: this.opts.fork.policy?.id ?? null, faultPlan: this.opts.fork.faultPlan === undefined ? 'unchanged' : this.opts.fork.faultPlan?.id ?? null },
      };
    }

    const effectivePolicy = this.opts.fork?.policy ?? this.opts.policy;
    const effectivePlan = this.opts.fork && this.opts.fork.faultPlan !== undefined ? this.opts.fork.faultPlan : this.opts.faultPlan;
    const scenarioHash = hashJson(this.scenario);
    const idBasis = {
      scenarioHash,
      policy: this.opts.policy,
      faultPlan: this.opts.faultPlan,
      seed: this.seed,
      schedule: this.opts.schedule ?? 'fifo',
      engine: ENGINE_VERSION,
      fork: this.opts.fork ? { parent: this.opts.fork.parent.id, cp: this.opts.fork.checkpointId, policy: this.opts.fork.policy ?? null, plan: this.opts.fork.faultPlan ?? null } : null,
    };
    const finalState = cloneJson(this.state);
    const trace: Trace = {
      schema: SCHEMAS.trace,
      id: `sim-${shortHash(idBasis, 16)}`,
      mode: 'simulation',
      ...(this.opts.fork ? { parentRunId: this.opts.fork.parent.id, fork: forkInfo } : {}),
      scenario: { id: this.scenario.id, version: this.scenario.version, hash: scenarioHash },
      workflow: { id: this.workflow.id, version: this.workflow.version },
      policy: effectivePolicy,
      faultPlan: effectivePlan ?? null,
      seed: this.seed,
      engineVersion: ENGINE_VERSION,
      createdAt: startedAt,
      status,
      outcome,
      executionErrors: this.errors,
      events: this.events,
      finalState,
      checkpoints: this.checkpoints,
      hashes: { events: hashEvents(this.events), state: hashJson(finalState) },
      capabilities: {
        executable: true,
        stateAvailable: true,
        forkable: this.checkpoints.some((c) => this.scenario.checkpoints.includes(c.id)),
        reasons: this.checkpoints.length ? [] : ['No checkpoint was reached in this run'],
      },
      finalized: true,
    };
    return deepFreeze(trace);
  }

  private scheduleTriggers() {
    for (const trig of [...this.scenario.triggers].sort((a, b) => a.atMs - b.atMs)) {
      this.schedule(trig.atMs, () => this.deliverTrigger(trig.id, trig.payload, 1));
      for (const af of this.faults) {
        const f = af.fault;
        if (f.point !== 'trigger-delivery' || f.target.triggerId !== trig.id || f.effect.type !== 'duplicate') continue;
        const delay = f.effect.delayMs;
        this.schedule(trig.atMs + delay, () => {
          if (!this.faultActive(af)) return;
          const ev = this.emit({ kind: 'fault.injected', task: 'engine', origin: 'fault', summary: `Fault ${f.id}: trigger ${trig.id} delivered again ${delay} ms later`, data: { faultId: f.id, point: f.point, effect: f.effect, triggerId: trig.id } });
          this.deliverTrigger(trig.id, trig.payload, 2, [ev.seq]);
        });
      }
    }
  }

  private scheduleClockFaults() {
    for (const af of this.faults) {
      const f = af.fault;
      if (f.point !== 'clock') continue;
      const at = f.target.atMs ?? 0;
      this.schedule(at, () => {
        if (!this.faultActive(af)) return;
        if (f.effect.type === 'cancel') {
          const ev = this.emit({ kind: 'cancel.requested', task: 'engine', origin: 'fault', summary: `Cancellation requested at ${at} ms by fault ${f.id}. In-flight calls may still complete; no new work should start.`, data: { faultId: f.id, atMs: at } });
          if (this.cancelRequestedSeq === null) this.cancelRequestedSeq = ev.seq;
        }
      });
    }
  }

  private faultActive(af: ActiveFault): boolean {
    const nextSeq = this.events.length + 1;
    return nextSeq >= af.fromSeq && nextSeq <= af.untilSeq;
  }

  private deliverTrigger(triggerId: string, payload: Json, delivery: number, causes?: number[]) {
    const ev = this.emit({
      kind: 'trigger.received',
      task: 'engine',
      origin: 'engine',
      summary: delivery === 1 ? `Trigger ${triggerId} received` : `Trigger ${triggerId} received again (delivery ${delivery})`,
      data: { triggerId, delivery, payload },
      causes,
    });
    const task = this.spawnTask(null, true);
    const ctx = new WorkflowContext(payload, () => this.policyValues, this.scenario, task.id);
    task.gen = this.workflow.run(ctx) as unknown as Gen<Json>;
    this.emit({ kind: 'task.spawned', task: task.id, origin: 'engine', summary: `Workflow task ${task.id} started for trigger ${triggerId}`, data: { triggerId, root: true }, causes: [ev.seq] });
    this.schedule(this.clock, () => this.step(task, undefined));
  }

  private spawnTask(parent: Task | null, root: boolean): Task {
    const id = root ? `t${++this.taskCounter}` : `${parent!.id}.${++this.taskCounter}`;
    const task: Task = { id, gen: undefined as unknown as Gen<Json>, parent, root, done: false };
    if (root) this.roots.push(task);
    return task;
  }

  /** Advance a task until it blocks on a timed operation or finishes. */
  private step(task: Task, input: unknown) {
    let value = input;
    for (;;) {
      if (++this.steps > this.scenario.limits.maxSteps) {
        throw new AbortRun('limit-exhausted', `Step limit of ${this.scenario.limits.maxSteps} operations reached`);
      }
      const res = task.gen.next(value);
      if (res.done) {
        task.done = true;
        task.result = (res.value ?? null) as Json;
        this.finishTask(task);
        return;
      }
      const op = res.value as Op;
      const immediate = this.handle(task, op);
      if (immediate.blocked) return;
      value = immediate.value;
    }
  }

  private finishTask(task: Task) {
    if (task.root) {
      const outcome = task.result as WorkflowOutcome | null;
      this.emit({ kind: 'note', task: task.id, origin: 'engine', summary: `Workflow task ${task.id} returned ${outcome?.status ?? 'no outcome'}${outcome?.detail ? `: ${outcome.detail}` : ''}`, data: { outcome: task.result ?? null } });
      return;
    }
    const parent = task.parent!;
    const join = parent.join!;
    join.results[task.joinIndex!] = task.result ?? null;
    join.remaining--;
    if (join.remaining === 0) {
      this.emit({ kind: 'task.joined', task: parent.id, step: join.step, origin: 'engine', summary: `All ${join.childIds.length} parallel branches of ${join.step} finished`, data: { children: join.childIds }, causes: [join.spawnSeq] });
      const results = join.results;
      parent.join = undefined;
      this.schedule(this.clock, () => this.step(parent, results));
    }
  }

  private handle(task: Task, op: Op): { blocked: boolean; value?: unknown } {
    switch (op.op) {
      case 'now':
        return { blocked: false, value: this.clock };
      case 'random':
        return { blocked: false, value: this.rng() };
      case 'get':
        return { blocked: false, value: cloneJson(getPath(this.state.workflow, op.path) as Json | undefined) };
      case 'cancelled': {
        if (this.cancelRequestedSeq === null) return { blocked: false, value: false };
        this.emit({ kind: 'cancel.observed', task: task.id, step: op.step, origin: 'workflow', summary: `Workflow observed the cancellation request during ${op.step} and stops starting new work`, data: { requestSeq: this.cancelRequestedSeq }, causes: [this.cancelRequestedSeq] });
        return { blocked: false, value: true };
      }
      case 'emit': {
        const ev = this.emit({ kind: op.kind as EventKind, task: task.id, step: op.step, origin: 'workflow', summary: op.summary, data: op.data, causes: op.causes });
        return { blocked: false, value: ev.seq };
      }
      case 'set':
      case 'append': {
        const before = getPath(this.state.workflow, op.path);
        if (op.op === 'set') setPath(this.state.workflow, op.path, cloneJson(op.value));
        else {
          const arr = Array.isArray(before) ? [...(before as Json[]), cloneJson(op.value)] : [cloneJson(op.value)];
          setPath(this.state.workflow, op.path, arr);
        }
        const ev = this.emit({ kind: 'state.changed', task: task.id, step: op.step, origin: 'workflow', summary: op.summary, data: { scope: 'workflow', op: op.op, path: op.path, value: op.value }, causes: op.causes });
        return { blocked: false, value: ev.seq };
      }
      case 'checkpoint': {
        // Only checkpoints the scenario declares as forkable capture state; others are recorded as reached.
        const declared = this.scenario.checkpoints.includes(op.id);
        let ev: TraceEvent;
        if (declared) {
          const stateHash = hashJson(this.state);
          ev = this.emit({ kind: 'checkpoint', task: task.id, step: op.step, origin: 'workflow', summary: `Checkpoint ${op.id}: workflow and simulated state captured for a supported fork`, data: { id: op.id, stateHash, declared } });
          // prefixHash is filled in at finalization in one linear pass (see prefixHashes).
          this.checkpoints.push({ schema: SCHEMAS.checkpoint, id: op.id, seq: ev.seq, vt: this.clock, stateHash, prefixHash: '' });
        } else {
          ev = this.emit({ kind: 'checkpoint', task: task.id, step: op.step, origin: 'workflow', summary: `Checkpoint ${op.id} reached; this scenario does not declare it forkable, so no state was captured`, data: { id: op.id, declared } });
        }
        const fork = this.opts.fork;
        if (fork && fork.checkpointId === op.id && this.forkSwitchSeq === null) {
          this.forkSwitchSeq = ev.seq;
          if (fork.policy) this.policyValues = fork.policy.values;
          this.emit({ kind: 'note', task: task.id, step: op.step, origin: 'engine', summary: `Fork of ${fork.parent.id} resumes here with ${fork.policy ? `policy "${fork.policy.label}"` : 'the parent policy'} and ${fork.faultPlan === undefined ? 'the parent fault plan' : fork.faultPlan ? `fault plan "${fork.faultPlan.title}"` : 'no faults'}`, data: { parentRunId: fork.parent.id, checkpoint: op.id } });
        }
        return { blocked: false, value: undefined };
      }
      case 'sleep': {
        this.emit({ kind: 'sleep', task: task.id, step: op.step, origin: 'workflow', summary: `${op.reason} (${op.ms} ms virtual)`, data: { ms: op.ms, until: this.clock + op.ms }, causes: op.causes });
        this.schedule(this.clock + Math.max(0, op.ms), () => this.step(task, undefined));
        return { blocked: true };
      }
      case 'parallel': {
        const spawn = this.emit({ kind: 'task.spawned', task: task.id, step: op.step, origin: 'engine', summary: `${op.step}: starting ${op.branches.length} parallel branches (${op.branches.map((b) => b.label).join(', ')})`, data: { branches: op.branches.map((b) => b.label) } });
        if (op.branches.length === 0) return { blocked: false, value: [] };
        task.join = { remaining: op.branches.length, results: new Array(op.branches.length).fill(null), childIds: [], step: op.step, spawnSeq: spawn.seq };
        op.branches.forEach((b, i) => {
          const child = this.spawnTask(task, false);
          child.joinIndex = i;
          child.gen = b.run();
          task.join!.childIds.push(child.id);
          this.schedule(this.clock, () => this.step(child, undefined));
        });
        return { blocked: true };
      }
      case 'call':
        this.handleCall(task, op);
        return { blocked: true };
    }
  }

  // ------------------------------------------------------------ tool calls

  private matchFaults(point: Fault['point'], tool: string, args: Json, requestId: string): ActiveFault[] {
    const out: ActiveFault[] = [];
    for (const af of this.faults) {
      const f = af.fault;
      if (f.point !== point || f.target.tool !== tool) continue;
      if (f.target.beforeMs !== undefined && this.clock >= f.target.beforeMs) continue;
      if (f.target.requestId !== undefined && f.target.requestId !== requestId) continue;
      if (f.target.argsMatch) {
        let ok = true;
        for (const [p, v] of Object.entries(f.target.argsMatch)) {
          const actual = getPath(args, p);
          if (actual === undefined || canonicalize(actual) !== canonicalize(v)) ok = false;
        }
        if (!ok) continue;
      }
      af.matches++;
      if (!this.faultActive(af)) continue;
      if (f.target.occurrences && !f.target.occurrences.includes(af.matches)) continue;
      out.push(af);
    }
    return out;
  }

  private handleCall(task: Task, op: Extract<Op, { op: 'call' }>) {
    const { tool, args, opts } = op;
    const reqCountKey = `${tool}`;
    const n = (this.requestCounters.get(reqCountKey) ?? 0) + 1;
    this.requestCounters.set(reqCountKey, n);
    const requestId = `${tool}#${n}`;
    const logicalId = opts.logicalId ?? requestId;
    const attempt = opts.attempt ?? 1;
    const base = { task: task.id, step: opts.step, requestId, logicalId, attempt, tool };
    const req = this.emit({
      ...base,
      kind: 'tool.request',
      origin: 'workflow',
      summary: `${opts.step}: request ${tool}${attempt > 1 ? ` (attempt ${attempt})` : ''}`,
      data: { args, timeoutMs: opts.timeoutMs ?? null, idempotencyKey: this.idempotencyKeyOf(tool, args) },
      causes: opts.causes,
    });
    // Requests after a cancellation request are recorded, not prevented: assertions judge them.
    let settled = false;
    let timeoutWakeup: Wakeup | null = null;
    const resume = (result: ToolResult) => {
      if (settled) return false;
      settled = true;
      if (timeoutWakeup) timeoutWakeup.cancelled = true;
      this.schedule(this.clock, () => this.step(task, result));
      return true;
    };
    const failNow = (error: ToolErrorShape, kind: EventKind, summary: string, origin: TraceEvent['origin'], extra: Json = null) => {
      const ev = this.emit({ ...base, kind, origin, summary, data: { error: error as unknown as Json, extra }, causes: [req.seq] });
      resume({ ok: false, error, requestId, seq: ev.seq });
    };

    // 1. Local policy boundary: only declared tools may execute.
    if (!this.scenario.allowedTools.includes(tool)) {
      failNow({ code: 'BLOCKED_BY_POLICY', message: `Tool ${tool} is outside the scenario allowlist; the call was recorded and not executed` }, 'boundary.blocked', `Boundary blocked ${tool}: not in the allowlist. Nothing was executed.`, 'engine', { allowed: this.scenario.allowedTools });
      return;
    }
    const contract = this.tools.get(tool);
    if (!contract) {
      this.executionError('UNKNOWN_TOOL', `Tool ${tool} has no contract`, req.seq);
      failNow({ code: 'UNKNOWN_TOOL', message: `No contract for ${tool}` }, 'tool.error', `${tool} has no fixture contract`, 'engine');
      return;
    }
    const inputIssues = validate(contract.input, args);
    if (inputIssues.length) {
      failNow({ code: 'INVALID_INPUT', message: inputIssues.map((i) => `${i.path} ${i.message}`).join('; ') }, 'tool.error', `${tool} rejected the request: input does not match its contract`, 'fixture', { issues: inputIssues as unknown as Json });
      return;
    }

    const timeoutMs = opts.timeoutMs ?? this.opts.defaultTimeoutMs ?? 30_000;
    const start = this.clock;
    const timeoutAt = start + timeoutMs;
    let timedOut = false;
    const armTimeout = () => {
      timeoutWakeup = this.schedule(timeoutAt, () => {
        if (settled) return;
        timedOut = true;
        failNow({ code: 'TIMEOUT', message: `No response within ${timeoutMs} ms` }, 'tool.error', `${tool} timed out after ${timeoutMs} ms`, 'engine');
      });
    };

    // 2. Faults before the request reaches the simulated tool.
    let preDelay = 0;
    for (const af of this.matchFaults('before-request', tool, args, requestId)) {
      const f = af.fault;
      const fe = this.emit({ ...base, kind: 'fault.injected', origin: 'fault', summary: `Fault ${f.id} before request: ${f.description}`, data: { faultId: f.id, point: f.point, effect: f.effect as unknown as Json }, causes: [req.seq] });
      if (f.effect.type === 'error') {
        const err: ToolErrorShape = { code: f.effect.code, message: f.effect.message, ...(f.effect.retryAfterMs !== undefined ? { retryAfterMs: f.effect.retryAfterMs } : {}) };
        this.schedule(start + 5, () => {
          const ev = this.emit({ ...base, kind: 'tool.error', origin: 'fault', summary: `${tool} returned ${err.code}${err.retryAfterMs !== undefined ? ` with retry delay ${err.retryAfterMs} ms` : ''}. The tool did not execute.`, data: { error: err as unknown as Json, executed: false }, causes: [fe.seq] });
          resume({ ok: false, error: err, requestId, seq: ev.seq });
        });
        return;
      }
      if (f.effect.type === 'timeout') {
        armTimeout();
        return;
      }
      if (f.effect.type === 'delay') preDelay += f.effect.ms;
    }

    // 3. Fixture resolution.
    const occKey = `${tool}|${canonicalize(args)}`;
    const occurrence = (this.fixtureOccurrences.get(occKey) ?? 0) + 1;
    this.fixtureOccurrences.set(occKey, occurrence);
    const resolution = resolveFixture(this.scenario.fixtures, { tool, args, logicalId, occurrence }, this.state.external);
    if (resolution.kind === 'miss') {
      this.executionError('FIXTURE_MISS', resolution.reason, req.seq);
      failNow({ code: 'FIXTURE_MISS', message: resolution.reason }, 'fixture.miss', `Fixture miss for ${tool}: no recorded response matches these arguments. Recorded as an execution error.`, 'fixture', { nearest: resolution.nearest });
      return;
    }
    if (resolution.kind === 'ambiguous') {
      const msg = `Ambiguous fixtures for ${tool}: ${resolution.candidates.join(', ')}`;
      this.executionError('FIXTURE_AMBIGUOUS', msg, req.seq);
      failNow({ code: 'FIXTURE_AMBIGUOUS', message: msg }, 'fixture.ambiguous', `${msg}. Refusing to guess.`, 'fixture', { candidates: resolution.candidates });
      return;
    }
    const entry = resolution.entry;
    armTimeout();

    // 4. The simulated tool processes the request and commits side effects.
    const commitAt = start + preDelay + entry.latencyMs;
    this.schedule(commitAt, () => {
      const idemKey = this.idempotencyKeyOf(tool, args);
      const idemPath = contract.idempotency && idemKey !== null ? `__idempotency.${tool}.${idemKey}` : null;
      let response = entry.response;
      let dedup = false;
      if (idemPath && this.state.external.kv[idemPath] !== undefined) {
        dedup = true;
        response = this.state.external.kv[idemPath] as unknown as typeof entry.response;
        this.emit({ ...base, kind: 'tool.dedup', origin: 'fixture', summary: `${tool} recognized idempotency key ${idemKey} and returned the stored result without a new write`, data: { idempotencyKey: idemKey }, causes: [req.seq] });
      }
      const writeSeqs: number[] = [];
      if (!dedup && response.ok) {
        const scope = { args, request: { id: requestId, logicalId, attempt }, vt: this.clock };
        for (const w of entry.writes ?? []) {
          if (w.op === 'insert') {
            const rec = expandTemplate(w.record, scope);
            (this.state.external.collections[w.collection] ??= []).push(rec);
            writeSeqs.push(this.emit({ ...base, kind: 'state.changed', origin: 'fixture', summary: `${tool} committed a record to ${w.collection}`, data: { scope: 'external', op: 'insert', collection: w.collection, record: rec, size: this.state.external.collections[w.collection].length }, causes: [req.seq] }).seq);
          } else {
            const value = expandTemplate(w.value, scope);
            const key = String(expandTemplate(w.key, scope));
            this.state.external.kv[key] = value;
            writeSeqs.push(this.emit({ ...base, kind: 'state.changed', origin: 'fixture', summary: `${tool} set ${key}`, data: { scope: 'external', op: 'set', key, value }, causes: [req.seq] }).seq);
          }
        }
        if (idemPath) this.state.external.kv[idemPath] = response as unknown as Json;
      }
      let value: Json = response.ok ? cloneJson(response.value) : null;
      let error: ToolErrorShape | null = response.ok ? null : response.error;
      let delay = 0;
      let dropped = false;
      const causes = [req.seq, ...writeSeqs];
      // after-tool-commit faults: the write happened, the caller may never learn it.
      for (const af of this.matchFaults('after-tool-commit', tool, args, requestId)) {
        const f = af.fault;
        const fe = this.emit({ ...base, kind: 'fault.injected', origin: 'fault', summary: `Fault ${f.id} after commit: ${f.description}`, data: { faultId: f.id, point: f.point, effect: f.effect as unknown as Json, committedWrites: writeSeqs.length }, causes });
        causes.push(fe.seq);
        if (f.effect.type === 'drop-response') dropped = true;
        else if (f.effect.type === 'error') error = { code: f.effect.code, message: f.effect.message };
        else if (f.effect.type === 'delay') delay += f.effect.ms;
      }
      // before-response faults: the response is altered on its way back.
      for (const af of this.matchFaults('before-response', tool, args, requestId)) {
        const f = af.fault;
        const e = f.effect;
        const fe = this.emit({ ...base, kind: 'fault.injected', origin: 'fault', summary: `Fault ${f.id} before response: ${f.description}`, data: { faultId: f.id, point: f.point, effect: e as unknown as Json }, causes });
        causes.push(fe.seq);
        if (e.type === 'delay') delay += e.ms;
        else if (e.type === 'drop-response') dropped = true;
        else if (e.type === 'error') error = { code: e.code, message: e.message, ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}) };
        else if (value && typeof value === 'object' && !Array.isArray(value)) {
          const obj = value as Record<string, unknown>;
          if (e.type === 'remove-fields') for (const p of e.paths) deletePath(obj, p);
          if (e.type === 'set-fields') for (const [p, v] of Object.entries(e.values)) setPath(obj, p, cloneJson(v));
          if (e.type === 'truncate-array') {
            const arr = getPath(obj, e.path);
            if (Array.isArray(arr)) setPath(obj, e.path, arr.slice(0, e.keep));
          }
        }
      }
      if (dropped) return; // The timeout (if any) resolves the caller.
      this.schedule(this.clock + delay, () => {
        if (timedOut || settled) {
          this.emit({ ...base, kind: 'tool.response.late', origin: 'fixture', summary: `${tool} responded after the caller had already timed out; the response was discarded`, data: { ok: error === null, value, error: error as unknown as Json }, causes });
          return;
        }
        if (error) {
          const ev = this.emit({ ...base, kind: 'tool.error', origin: 'fixture', summary: `${tool} returned error ${error.code}: ${error.message}`, data: { error: error as unknown as Json, executed: true }, causes });
          resume({ ok: false, error, requestId, seq: ev.seq });
          return;
        }
        const outIssues = validate(contract.output, value);
        const ev = this.emit({ ...base, kind: 'tool.response', origin: 'fixture', summary: `${tool} responded${dedup ? ' (deduplicated)' : ''}${outIssues.length ? ' with a response that does not match its contract' : ''}`, data: { value, contractIssues: outIssues as unknown as Json, latencyMs: this.clock - start }, causes });
        resume({ ok: true, value, requestId, seq: ev.seq });
      });
    });
  }

  private idempotencyKeyOf(tool: string, args: Json): string | null {
    const c = this.tools.get(tool);
    if (!c?.idempotency || !args || typeof args !== 'object') return null;
    const v = getPath(args, c.idempotency.keyField);
    return typeof v === 'string' && v.length ? v : null;
  }
}
