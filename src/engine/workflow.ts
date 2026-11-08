import type { Json, JsonSchema, ScenarioDef, ToolErrorShape } from './types';

export interface ToolOk {
  ok: true;
  value: Json;
  requestId: string;
  /** Sequence number of the response event. */
  seq: number;
}

export interface ToolFail {
  ok: false;
  error: ToolErrorShape;
  requestId: string;
  seq: number;
}

export type ToolResult = ToolOk | ToolFail;

export interface CallOptions {
  /** Semantic step label used for alignment and the timeline. */
  step: string;
  /** Logical request identity shared by all attempts of the same request. */
  logicalId?: string;
  attempt?: number;
  timeoutMs?: number;
  /** Event sequence numbers this request depends on (actual data dependencies). */
  causes?: number[];
}

export type Op =
  | { op: 'call'; tool: string; args: Json; opts: CallOptions }
  | { op: 'sleep'; ms: number; step: string; reason: string; causes?: number[] }
  | { op: 'parallel'; step: string; branches: Array<{ label: string; run: () => Gen<Json> }> }
  | { op: 'cancelled'; step: string }
  | { op: 'emit'; kind: 'decision' | 'check' | 'note' | 'output' | 'limit.exhausted' | 'step.started' | 'retry.scheduled'; step: string; summary: string; data: Json; causes?: number[] }
  | { op: 'set'; path: string; value: Json; step: string; summary: string; causes?: number[] }
  | { op: 'append'; path: string; value: Json; step: string; summary: string; causes?: number[] }
  | { op: 'get'; path: string }
  | { op: 'checkpoint'; id: string; step: string }
  | { op: 'now' }
  | { op: 'random' };

export type Gen<T> = Generator<Op, T, any>;

export interface WorkflowOutcome {
  status: 'completed' | 'skipped' | 'failed' | 'cancelled' | 'unresolved';
  detail: string;
  [key: string]: Json;
}

/**
 * The workflow-facing API. Workflows only observe the world through tool
 * results, their own state, virtual time, and the cancellation flag.
 */
export class WorkflowContext {
  constructor(
    readonly input: Json,
    private readonly policyRef: () => Record<string, Json>,
    readonly scenario: Pick<ScenarioDef, 'id' | 'version'>,
    readonly taskId: string,
  ) {}

  /** Read the active policy. Read it at each decision: a fork may change it after a checkpoint. */
  get policy(): Record<string, Json> {
    return this.policyRef();
  }

  num(key: string, fallback: number): number {
    const v = this.policy[key];
    return typeof v === 'number' ? v : fallback;
  }

  flag(key: string): boolean {
    return this.policy[key] === true;
  }

  *call(tool: string, args: Json, opts: CallOptions): Gen<ToolResult> {
    return (yield { op: 'call', tool, args, opts }) as ToolResult;
  }

  *sleep(ms: number, step: string, reason: string, causes?: number[]): Gen<void> {
    yield { op: 'sleep', ms, step, reason, causes };
  }

  *parallel(step: string, branches: Array<{ label: string; run: () => Gen<Json> }>): Gen<Json[]> {
    return (yield { op: 'parallel', step, branches }) as Json[];
  }

  /** Returns true when cancellation was requested; records the observation. */
  *cancelled(step: string): Gen<boolean> {
    return (yield { op: 'cancelled', step }) as boolean;
  }

  *emit(kind: Extract<Op, { op: 'emit' }>['kind'], step: string, summary: string, data: Json = null, causes?: number[]): Gen<number> {
    return (yield { op: 'emit', kind, step, summary, data, causes }) as number;
  }

  *set(path: string, value: Json, step: string, summary: string, causes?: number[]): Gen<number> {
    return (yield { op: 'set', path, value, step, summary, causes }) as number;
  }

  *append(path: string, value: Json, step: string, summary: string, causes?: number[]): Gen<number> {
    return (yield { op: 'append', path, value, step, summary, causes }) as number;
  }

  *get(path: string): Gen<Json | undefined> {
    return (yield { op: 'get', path }) as Json | undefined;
  }

  *checkpoint(id: string, step: string): Gen<void> {
    yield { op: 'checkpoint', id, step };
  }

  *now(): Gen<number> {
    return (yield { op: 'now' }) as number;
  }

  *random(): Gen<number> {
    return (yield { op: 'random' }) as number;
  }
}

export interface WorkflowDefinition {
  id: string;
  version: string;
  title: string;
  description: string;
  policySchema: JsonSchema;
  /** Plain-language description of every policy field. */
  policyDocs: Record<string, string>;
  run: (ctx: WorkflowContext) => Gen<WorkflowOutcome>;
}

/** Shared helper: call a tool with a policy-driven retry loop. */
export interface RetryConfig {
  step: string;
  logicalId: string;
  maxAttempts: number;
  backoffMs: number;
  honorRetryAfter: boolean;
  timeoutMs?: number;
  checkCancellation?: boolean;
  jitter?: boolean;
  causes?: number[];
  retryOn?: (r: ToolFail) => boolean;
  argsForAttempt?: (attempt: number) => Json;
}

export interface RetryOutcome {
  result: ToolResult | null;
  attempts: number;
  cancelled: boolean;
  exhausted: boolean;
}

export function* callWithRetry(ctx: WorkflowContext, tool: string, args: Json, cfg: RetryConfig): Gen<RetryOutcome> {
  let attempt = 0;
  let last: ToolResult | null = null;
  while (attempt < cfg.maxAttempts) {
    if (cfg.checkCancellation && (yield* ctx.cancelled(cfg.step))) {
      return { result: last, attempts: attempt, cancelled: true, exhausted: false };
    }
    attempt++;
    const callArgs = cfg.argsForAttempt ? cfg.argsForAttempt(attempt) : args;
    last = yield* ctx.call(tool, callArgs, {
      step: cfg.step,
      logicalId: cfg.logicalId,
      attempt,
      timeoutMs: cfg.timeoutMs,
      causes: cfg.causes,
    });
    if (last.ok) return { result: last, attempts: attempt, cancelled: false, exhausted: false };
    const retryable = cfg.retryOn ? cfg.retryOn(last) : ['TIMEOUT', 'RATE_LIMITED', 'UNAVAILABLE'].includes(last.error.code);
    if (!retryable) return { result: last, attempts: attempt, cancelled: false, exhausted: false };
    if (attempt >= cfg.maxAttempts) break;
    let delay = cfg.backoffMs * Math.pow(2, attempt - 1);
    if (cfg.jitter) delay = Math.round(delay * (0.5 + (yield* ctx.random()) / 2));
    if (cfg.honorRetryAfter && last.error.retryAfterMs !== undefined) delay = Math.max(delay, last.error.retryAfterMs);
    yield* ctx.emit('retry.scheduled', cfg.step, `Retry ${attempt + 1} of ${cfg.logicalId} scheduled in ${delay} ms after ${last.error.code}`, {
      logicalId: cfg.logicalId,
      nextAttempt: attempt + 1,
      delayMs: delay,
      reason: last.error.code,
      retryAfterMs: last.error.retryAfterMs ?? null,
    }, [last.seq]);
    if (delay > 0) yield* ctx.sleep(delay, cfg.step, `Backoff before attempt ${attempt + 1}`, [last.seq]);
  }
  return { result: last, attempts: attempt, cancelled: false, exhausted: true };
}
