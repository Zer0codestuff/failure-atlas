import { hashJson, type Json } from '../engine/hash';
import { hashEvents } from '../engine/runner';
import { ENGINE_VERSION, SCHEMAS, type EventKind, type Trace, type TraceEvent } from '../engine/types';
import { ImportError, LIMITS, parseJsonText } from '../engine/validate';

/**
 * OpenTelemetry GenAI trace import (explicit subset, playback only).
 *
 * Pinned specification: open-telemetry/semantic-conventions-genai at commit
 * 51a0f580f8a6ad804ca4de5e033683c6fbbe5906 (2026-10-27). Every GenAI
 * attribute used here has stability "development" at that revision and may
 * change. Input format: OTLP/JSON ExportTraceServiceRequest
 * (resourceSpans -> scopeSpans -> spans).
 *
 * Supported gen_ai.operation.name values:
 *   invoke_agent, invoke_workflow  -> step.started / note
 *   chat, generate_content, text_completion -> model.request / model.response
 *   execute_tool                   -> tool.request / tool.response or tool.error
 * Other GenAI operations are kept as notes and listed as unsupported. Spans
 * without gen_ai.operation.name are counted and skipped, never invented.
 *
 * Imported traces carry no workflow state, fixture contracts or
 * implementation, so they cannot be re-executed or forked.
 */
export const OTEL_GENAI_PIN = {
  repository: 'https://github.com/open-telemetry/semantic-conventions-genai',
  commit: '51a0f580f8a6ad804ca4de5e033683c6fbbe5906',
  date: '2026-10-27',
  stability: 'development',
} as const;

export const SUPPORTED_OPERATIONS = ['invoke_agent', 'invoke_workflow', 'chat', 'generate_content', 'text_completion', 'execute_tool'] as const;

export interface OtelImportReport {
  spans: number;
  converted: number;
  skippedNonGenAi: number;
  unsupportedOperations: Record<string, number>;
  warnings: string[];
  pin: typeof OTEL_GENAI_PIN;
}

interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values?: OtlpAnyValue[] };
  kvlistValue?: { values?: Array<{ key: string; value: OtlpAnyValue }> };
  bytesValue?: string;
}

interface OtlpSpan {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name?: string;
  startTimeUnixNano?: string | number;
  endTimeUnixNano?: string | number;
  attributes?: Array<{ key: string; value: OtlpAnyValue }>;
  status?: { code?: number | string; message?: string };
}

function decode(v: OtlpAnyValue | undefined): Json {
  if (!v) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.arrayValue) return (v.arrayValue.values ?? []).map(decode);
  if (v.kvlistValue) return Object.fromEntries((v.kvlistValue.values ?? []).map((kv) => [kv.key, decode(kv.value)]));
  if (v.bytesValue !== undefined) return `[bytes:${v.bytesValue.length}]`;
  return null;
}

/** Content attributes are often JSON strings; parse them when they are, otherwise keep the text. */
function maybeJson(v: Json | undefined): Json {
  if (typeof v !== 'string') return v ?? null;
  try {
    return JSON.parse(v) as Json;
  } catch {
    return v;
  }
}

function nanos(v: string | number | undefined): bigint | null {
  if (v === undefined || v === null || v === '') return null;
  try {
    return BigInt(typeof v === 'number' ? Math.round(v) : v);
  } catch {
    return null;
  }
}

export function isOtlpJson(raw: unknown): boolean {
  return !!raw && typeof raw === 'object' && Array.isArray((raw as any).resourceSpans);
}

export function importOtlpText(text: string): { trace: Trace; report: OtelImportReport } {
  const raw = parseJsonText(text, LIMITS.maxTraceBytes, 'OTLP trace');
  return importOtlp(raw);
}

export function importOtlp(raw: unknown): { trace: Trace; report: OtelImportReport } {
  if (!isOtlpJson(raw)) throw new ImportError('UNKNOWN_FORMAT', 'Not OTLP/JSON: expected a top-level "resourceSpans" array.');
  const spans: Array<OtlpSpan & { attrs: Record<string, Json> }> = [];
  for (const rs of (raw as any).resourceSpans as any[]) {
    for (const ss of rs?.scopeSpans ?? []) {
      for (const sp of ss?.spans ?? []) {
        const attrs: Record<string, Json> = {};
        for (const a of sp.attributes ?? []) if (a && typeof a.key === 'string') attrs[a.key] = decode(a.value);
        spans.push({ ...sp, attrs });
      }
    }
  }
  if (spans.length > LIMITS.maxEvents / 2) throw new ImportError('TOO_LARGE', `OTLP file has ${spans.length} spans, above the import limit.`);
  const report: OtelImportReport = { spans: spans.length, converted: 0, skippedNonGenAi: 0, unsupportedOperations: {}, warnings: [], pin: OTEL_GENAI_PIN };
  const valid = spans.filter((s) => {
    if (nanos(s.startTimeUnixNano) === null) {
      report.warnings.push(`Span ${s.spanId ?? '?'} (${s.name ?? 'unnamed'}) has no start time and was skipped`);
      return false;
    }
    return true;
  });
  const t0 = valid.reduce<bigint | null>((m, s) => {
    const t = nanos(s.startTimeUnixNano)!;
    return m === null || t < m ? t : m;
  }, null) ?? 0n;
  const traceIds = new Set(valid.map((s) => s.traceId).filter(Boolean));
  if (traceIds.size > 1) report.warnings.push(`File contains ${traceIds.size} trace IDs; they are merged into one timeline ordered by time`);

  type Pending = { t: bigint; order: number; spanId: string; isStart: boolean; parentSpanId?: string; ev: Omit<TraceEvent, 'seq' | 'schema' | 'causes'> };
  const pending: Pending[] = [];
  let order = 0;
  const ms = (t: bigint) => Number(t - t0) / 1e6;
  for (const s of valid) {
    const op = typeof s.attrs['gen_ai.operation.name'] === 'string' ? (s.attrs['gen_ai.operation.name'] as string) : null;
    if (!op) {
      report.skippedNonGenAi++;
      continue;
    }
    const start = nanos(s.startTimeUnixNano)!;
    const end = nanos(s.endTimeUnixNano) ?? start;
    if (end < start) report.warnings.push(`Span ${s.spanId} ends before it starts; end time clamped to start`);
    const endT = end < start ? start : end;
    const spanId = String(s.spanId ?? `span-${order}`);
    const agent = (s.attrs['gen_ai.agent.name'] ?? s.attrs['gen_ai.agent.id'] ?? null) as string | null;
    const task = agent ? `agent:${agent}` : `trace:${String(s.traceId ?? 'unknown').slice(0, 8)}`;
    const isError = String(s.status?.code ?? '') === '2' || s.status?.code === 'STATUS_CODE_ERROR' || s.attrs['error.type'] !== undefined;
    const errorInfo: Json = isError ? { type: (s.attrs['error.type'] ?? 'error') as Json, message: s.status?.message ?? null } : null;
    const common = { task, origin: 'import' as const, wt: undefined as string | undefined };
    const wt = (t: bigint) => new Date(Number(t / 1_000_000n)).toISOString();
    const push = (t: bigint, isStart: boolean, kind: EventKind, summary: string, data: Json, extra: Partial<TraceEvent> = {}) => {
      pending.push({ t, order: order++, spanId, isStart, parentSpanId: s.parentSpanId || undefined, ev: { ...common, ...extra, vt: ms(t), wt: wt(t), kind, summary, data } });
    };
    report.converted++;
    if (op === 'execute_tool') {
      const tool = String(s.attrs['gen_ai.tool.name'] ?? 'unknown-tool');
      const callId = (s.attrs['gen_ai.tool.call.id'] ?? spanId) as string;
      const args = s.attrs['gen_ai.tool.call.arguments'];
      const result = s.attrs['gen_ai.tool.call.result'];
      const ids = { tool, requestId: String(callId), logicalId: String(callId), attempt: 1, step: `execute_tool ${tool}` };
      push(start, true, 'tool.request', `Imported: ${tool} called${args === undefined ? ' (arguments not captured)' : ''}`, { args: args === undefined ? null : maybeJson(args), captured: args !== undefined, otel: { spanId, name: s.name ?? null, type: s.attrs['gen_ai.tool.type'] ?? null } }, ids);
      if (isError) push(endT, false, 'tool.error', `Imported: ${tool} failed (${String(s.attrs['error.type'] ?? 'error')})`, { error: errorInfo, durationMs: ms(endT) - ms(start) }, ids);
      else push(endT, false, 'tool.response', `Imported: ${tool} returned${result === undefined ? ' (result not captured)' : ''}`, { value: result === undefined ? null : maybeJson(result), captured: result !== undefined, durationMs: ms(endT) - ms(start) }, ids);
    } else if (op === 'chat' || op === 'generate_content' || op === 'text_completion') {
      const model = (s.attrs['gen_ai.request.model'] ?? null) as Json;
      push(start, true, 'model.request', `Imported: ${op} request to ${String(model ?? 'unknown model')} (${String(s.attrs['gen_ai.provider.name'] ?? 'provider not recorded')})`, { operation: op, model, provider: s.attrs['gen_ai.provider.name'] ?? null, input: maybeJson(s.attrs['gen_ai.input.messages']) }, { step: `${op}` });
      push(endT, false, 'model.response', isError ? `Imported: ${op} failed` : `Imported: ${op} response`, {
        operation: op,
        error: errorInfo,
        responseModel: s.attrs['gen_ai.response.model'] ?? null,
        finishReasons: s.attrs['gen_ai.response.finish_reasons'] ?? null,
        usage: { inputTokens: s.attrs['gen_ai.usage.input_tokens'] ?? null, outputTokens: s.attrs['gen_ai.usage.output_tokens'] ?? null },
        output: maybeJson(s.attrs['gen_ai.output.messages']),
      }, { step: `${op}` });
    } else if (op === 'invoke_agent' || op === 'invoke_workflow') {
      const name = String(s.attrs['gen_ai.agent.name'] ?? s.attrs['gen_ai.workflow.name'] ?? s.name ?? op);
      push(start, true, 'step.started', `Imported: ${op} ${name}`, { operation: op, name, conversationId: s.attrs['gen_ai.conversation.id'] ?? null }, { step: `${op} ${name}` });
      push(endT, false, 'note', `Imported: ${op} ${name} ended${isError ? ' with an error' : ''}`, { operation: op, error: errorInfo }, { step: `${op} ${name}` });
    } else {
      report.unsupportedOperations[op] = (report.unsupportedOperations[op] ?? 0) + 1;
      push(start, true, 'note', `Imported: unsupported GenAI operation "${op}" kept as a note`, { operation: op, attributes: s.attrs }, { step: op });
    }
  }
  pending.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : a.order - b.order));
  const startSeq = new Map<string, number>();
  const events: TraceEvent[] = pending.map((p, i) => {
    const seq = i + 1;
    if (p.isStart && !startSeq.has(p.spanId)) startSeq.set(p.spanId, seq);
    return { schema: SCHEMAS.event, seq, ...p.ev } as TraceEvent;
  });
  // Causes: an end event depends on its own start; a start depends on its parent span's start.
  pending.forEach((p, i) => {
    const causes: number[] = [];
    if (!p.isStart) { const s = startSeq.get(p.spanId); if (s && s < i + 1) causes.push(s); }
    else if (p.parentSpanId) {
      const ps = startSeq.get(p.parentSpanId);
      if (ps && ps < i + 1) causes.push(ps);
      else if (ps === undefined && valid.some((v) => v.spanId === p.parentSpanId && v.attrs['gen_ai.operation.name'])) report.warnings.push(`Span ${p.spanId} starts before its parent ${p.parentSpanId}; parent link not recorded`);
    }
    if (causes.length) events[i].causes = causes;
  });
  const id = `imp-${hashJson({ spans: valid.map((s) => [s.traceId, s.spanId, String(s.startTimeUnixNano)]) }).slice(0, 16)}`;
  const trace: Trace = {
    schema: SCHEMAS.trace,
    id,
    mode: 'playback',
    scenario: null,
    workflow: null,
    policy: null,
    faultPlan: null,
    seed: null,
    engineVersion: ENGINE_VERSION,
    createdAt: new Date().toISOString(),
    status: 'imported',
    outcome: null,
    executionErrors: [],
    events,
    finalState: null,
    checkpoints: [],
    hashes: { events: hashEvents(events), state: null },
    capabilities: {
      executable: false,
      stateAvailable: false,
      forkable: false,
      reasons: [
        'OpenTelemetry spans record what happened, not the workflow state, fixture contracts or implementation needed to run it again.',
        'Playback shows recorded events only and does not prove an agent would make the same decisions again.',
      ],
    },
    source: { format: `otlp-json + gen-ai semconv @ ${OTEL_GENAI_PIN.commit.slice(0, 8)}`, detail: `${report.converted} GenAI span(s) converted, ${report.skippedNonGenAi} non-GenAI span(s) skipped` },
    finalized: true,
  };
  return { trace, report };
}
