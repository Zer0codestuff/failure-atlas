import { cloneJson, hashJson, sha256, type Json } from '../engine/hash';
import { expandTemplate, resolveFixture } from '../engine/fixtures';
import { validate } from '../engine/jsonschema';
import { hashEvents } from '../engine/runner';
import { ENGINE_VERSION, SCHEMAS, type EventKind, type ExecutionError, type RunState, type RunStatus, type ScenarioDef, type Trace, type TraceEvent } from '../engine/types';
import { chatCompletion, type AdapterConfig, type ChatMessage, type ChatOutcome, type ToolSpec } from './openai-compatible';

/**
 * Live execution: a real model chooses tool calls; tools are served by the
 * scenario's local fixtures (no external tool operations exist in this
 * release). Time is wall-clock, so the trace is a new recording and is not
 * deterministic, whatever seed or temperature is supplied.
 */

export interface LiveOptions {
  maxTurns?: number;
  stream?: boolean;
  temperature?: number;
  signal?: AbortSignal;
  onEvent?: (e: TraceEvent) => void;
}

export async function runLive(scenario: ScenarioDef, cfg: AdapterConfig, opts: LiveOptions = {}): Promise<Trace> {
  if (!scenario.live) throw new Error(`Scenario ${scenario.id} declares no live task`);
  const live = scenario.live;
  const started = Date.now();
  const events: TraceEvent[] = [];
  const errors: ExecutionError[] = [];
  const state: RunState = { external: { kv: cloneJson(scenario.initialState?.external ?? {}), collections: {} }, workflow: {} };
  const occurrences = new Map<string, number>();
  const emit = (e: Omit<TraceEvent, 'schema' | 'seq' | 'vt' | 'wt' | 'task' | 'origin'> & { origin?: TraceEvent['origin'] }): TraceEvent => {
    const ev: TraceEvent = { schema: SCHEMAS.event, seq: events.length + 1, vt: Date.now() - started, wt: new Date().toISOString(), task: 'live', origin: e.origin ?? 'live', ...e } as TraceEvent;
    events.push(ev);
    opts.onEvent?.(ev);
    return ev;
  };
  const exposed = scenario.tools.filter((t) => live.tools.includes(t.name) && scenario.allowedTools.includes(t.name));
  const tools: ToolSpec[] = exposed.map((t) => ({ type: 'function', function: { name: t.name.replace(/\./g, '__'), description: t.description, parameters: t.input } }));
  const toolName = (fn: string) => fn.replace(/__/g, '.');
  const messages: ChatMessage[] = [
    { role: 'system', content: live.instructions },
    { role: 'user', content: JSON.stringify(scenario.triggers[0]?.payload ?? {}) },
  ];
  emit({ kind: 'run.started', summary: `Live execution of ${scenario.title} with ${cfg.model}. Not deterministic; tools are local fixtures.`, data: { model: cfg.model, endpointHost: new URL(cfg.baseUrl).host, tools: exposed.map((t) => t.name), stream: Boolean(opts.stream) } });
  let status: RunStatus = 'limit-exhausted';
  let outcome: Json = null;
  const maxTurns = opts.maxTurns ?? 8;
  turns: for (let turn = 1; turn <= maxTurns; turn++) {
    const req = emit({ kind: 'model.request', step: `turn-${turn}`, summary: `Turn ${turn}: request to ${cfg.model} with ${messages.length} message(s)`, data: { turn, messages: messages as unknown as Json, tools: tools.map((t) => t.function.name) } });
    let chunkCount = 0;
    const res: ChatOutcome = await chatCompletion(cfg, { model: cfg.model, messages, tools, temperature: opts.temperature, stream: opts.stream }, opts.signal, () => { chunkCount++; });
    if (res.kind !== 'ok') {
      emit({ kind: 'model.response', step: `turn-${turn}`, summary: `Turn ${turn}: ${res.kind}${'message' in res ? ` (${res.message})` : ''}`, data: res as unknown as Json, causes: [req.seq] });
      if (res.kind === 'cancelled') { status = 'cancelled'; outcome = { status: 'cancelled', detail: res.message }; }
      else { status = 'execution-error'; errors.push({ code: `MODEL_${res.kind.toUpperCase().replace('-', '_')}`, message: 'message' in res ? res.message : `HTTP ${(res as any).status}`, seq: events.length }); outcome = { status: 'failed', detail: res.kind }; }
      break;
    }
    const respEv = emit({ kind: 'model.response', step: `turn-${turn}`, summary: res.toolCalls.length ? `Turn ${turn}: model requested ${res.toolCalls.map((c) => toolName(c.function.name)).join(', ')}` : `Turn ${turn}: model answered`, data: { content: res.content, toolCalls: res.toolCalls as unknown as Json, finishReason: res.finishReason, usage: res.usage as Json, streamedChunks: res.chunks || chunkCount }, causes: [req.seq] });
    messages.push({ role: 'assistant', content: res.content, ...(res.toolCalls.length ? { tool_calls: res.toolCalls } : {}) });
    if (!res.toolCalls.length) {
      state.workflow.final = { content: res.content };
      try {
        const parsed = JSON.parse(String(res.content ?? '').replace(/^```(?:json)?\s*|\s*```$/g, ''));
        state.workflow[live.answerPath] = parsed;
        emit({ kind: 'state.changed', step: 'final-answer', summary: `Parsed the final answer into ${live.answerPath}`, data: { scope: 'workflow', op: 'set', path: live.answerPath, value: parsed }, causes: [respEv.seq] });
      } catch {
        emit({ kind: 'check', step: 'final-answer', summary: 'Final answer is not the requested JSON; it was kept as text only', data: { expected: live.answerPath }, causes: [respEv.seq] });
      }
      status = 'completed';
      outcome = { status: 'completed', detail: `Answered after ${turn} turn(s)` };
      break turns;
    }
    for (const call of res.toolCalls) {
      if (opts.signal?.aborted) { status = 'cancelled'; outcome = { status: 'cancelled', detail: 'Cancelled before a tool call' }; break turns; }
      const name = toolName(call.function.name);
      const base = { tool: name, requestId: call.id, logicalId: call.id, attempt: 1, step: `tool:${name}` };
      let args: Json;
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {
        const reqE = emit({ ...base, kind: 'tool.request', summary: `${name} requested with arguments that are not JSON`, data: { args: call.function.arguments, parseError: true }, causes: [respEv.seq] });
        const err = emit({ ...base, kind: 'tool.error', origin: 'engine', summary: `${name}: arguments are not valid JSON`, data: { error: { code: 'INVALID_ARGUMENTS', message: 'Arguments are not valid JSON' } }, causes: [reqE.seq] });
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: 'INVALID_ARGUMENTS' }) });
        void err;
        continue;
      }
      const reqE = emit({ ...base, kind: 'tool.request', summary: `${name} requested by the model`, data: { args }, causes: [respEv.seq] });
      const reply = (kind: EventKind, summary: string, data: Json, content: Json) => {
        emit({ ...base, kind, origin: 'fixture', summary, data, causes: [reqE.seq] });
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(content) });
      };
      const contract = scenario.tools.find((t) => t.name === name);
      if (!exposed.some((t) => t.name === name)) {
        emit({ ...base, kind: 'boundary.blocked', origin: 'engine', summary: `Boundary blocked ${name}: not exposed for this live task. Nothing was executed.`, data: { allowed: exposed.map((t) => t.name) }, causes: [reqE.seq] });
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: 'BLOCKED_BY_POLICY' }) });
        continue;
      }
      const issues = validate(contract!.input, args);
      if (issues.length) { reply('tool.error', `${name} rejected the arguments`, { error: { code: 'INVALID_INPUT', message: issues.map((i) => `${i.path} ${i.message}`).join('; ') } }, { error: 'INVALID_INPUT', issues: issues as unknown as Json }); continue; }
      const occKey = `${name}|${hashJson(args)}`;
      const occurrence = (occurrences.get(occKey) ?? 0) + 1;
      occurrences.set(occKey, occurrence);
      const r = resolveFixture(scenario.fixtures, { tool: name, args, logicalId: call.id, occurrence }, state.external);
      if (r.kind !== 'match') {
        errors.push({ code: r.kind === 'miss' ? 'FIXTURE_MISS' : 'FIXTURE_AMBIGUOUS', message: r.kind === 'miss' ? r.reason : r.candidates.join(', '), seq: reqE.seq });
        reply(r.kind === 'miss' ? 'fixture.miss' : 'fixture.ambiguous', `No unique fixture for ${name} with these arguments. Recorded as an execution error.`, { resolution: r as unknown as Json }, { error: 'NO_FIXTURE' });
        continue;
      }
      if (r.entry.response.ok) {
        for (const w of r.entry.writes ?? []) {
          const scope = { args, request: { id: call.id }, vt: Date.now() - started };
          if (w.op === 'insert') (state.external.collections[w.collection] ??= []).push(expandTemplate(w.record, scope));
          else state.external.kv[String(expandTemplate(w.key, scope))] = expandTemplate(w.value, scope);
        }
        reply('tool.response', `${name} responded (fixture ${r.entry.id})`, { value: r.entry.response.value, fixture: r.entry.id }, r.entry.response.value);
      } else reply('tool.error', `${name} returned ${r.entry.response.error.code}`, { error: r.entry.response.error as unknown as Json, fixture: r.entry.id }, { error: r.entry.response.error.code });
    }
  }
  if (status === 'limit-exhausted') outcome = { status: 'unresolved', detail: `No final answer within ${maxTurns} turns` };
  emit({ kind: 'run.finished', origin: 'engine', summary: `Live run finished with status ${status}`, data: { status, outcome } });
  const id = `live-${sha256(`${started}:${Math.random()}`).slice(0, 16)}`;
  return {
    schema: SCHEMAS.trace,
    id,
    mode: 'live',
    scenario: { id: scenario.id, version: scenario.version, hash: hashJson(scenario) },
    workflow: null,
    policy: null,
    faultPlan: null,
    seed: null,
    engineVersion: ENGINE_VERSION,
    createdAt: new Date(started).toISOString(),
    status,
    outcome,
    executionErrors: errors,
    events,
    finalState: state,
    checkpoints: [],
    hashes: { events: hashEvents(events), state: hashJson(state) },
    capabilities: { executable: false, stateAvailable: true, forkable: false, reasons: ['Live runs depend on a model outside this machine and are recordings, not reproducible executions.'] },
    live: { adapter: 'openai-compatible-chat (subset)', model: cfg.model, endpoint: new URL(cfg.baseUrl).host, note: 'Tools were served by local fixtures. No external tool operation was performed.' },
    finalized: true,
  };
}
