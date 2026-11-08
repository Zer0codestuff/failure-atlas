import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluateAll, summarize } from '../src/engine/assertions';
import { exportBundle, parseBundle, verifyBundle, bundleToText } from '../src/engine/bundle';
import { compareRuns, semanticKey } from '../src/engine/compare';
import { buildGraph } from '../src/engine/graph';
import { redact } from '../src/engine/redact';
import { runScenario } from '../src/engine/runner';
import { ImportError, validateScenario, validateTrace } from '../src/engine/validate';
import { importOtlp } from '../src/integrations/otel';
import { runLive } from '../src/live/live-runner';
import { startStub, type StubServer } from '../src/live/stub-server';
import { getScenario, getWorkflow } from '../src/scenarios/index';

const m = getScenario('lost-response-duplicate-charge')!;
const faulty = runScenario(m.scenario, m.workflow, { policy: m.scenario.policies[0], faultPlan: m.scenario.faultPresets[0] });
const fixed = runScenario(m.scenario, m.workflow, { policy: m.scenario.policies[1], faultPlan: m.scenario.faultPresets[0] });

describe('assertions', () => {
  it('link failures to exact events and state', () => {
    const r = evaluateAll(m.scenario.assertions, faulty, m.scenario).find((x) => x.assertionId === 'one-charge-per-order')!;
    expect(r.status).toBe('fail');
    expect(r.violated).toMatch(/at most one charges record/);
    const writes = faulty.events.filter((e) => e.kind === 'state.changed' && (e.data as any).collection === 'charges').map((e) => e.seq);
    expect(r.evidence.eventSeqs).toEqual(writes);
    expect(r.evidence.statePaths).toEqual(['external.collections.charges']);
  });
  it('never count unavailable or not-applicable checks as passes', () => {
    const { trace } = importOtlp(JSON.parse(readFileSync('tests/fixtures/otel-genai-sample.json', 'utf8')));
    const res = evaluateAll(m.scenario.assertions, trace, m.scenario);
    const s = summarize(res);
    expect(s.pass).toBe(0);
    expect(res.find((r) => r.assertionId === 'one-charge-per-order')!.status).toBe('unavailable');
    expect(s.statement).toMatch(/^0 of \d+ evaluated/);
  });
});

describe('comparison', () => {
  it('finds no divergence between identical runs', () => {
    const again = runScenario(m.scenario, m.workflow, { policy: m.scenario.policies[0], faultPlan: m.scenario.faultPresets[0] });
    const c = compareRuns(faulty, again);
    expect(c.firstDivergence).toBeNull();
    expect(c.identicalNormalized).toBe(true);
  });
  it('aligns by semantic step and reports the first observed divergence with downstream events', () => {
    const c = compareRuns(faulty, fixed);
    expect(c.method).toBe('myers');
    const d = c.firstDivergence!;
    expect(d.a!.tool).toBe('payments.charge');
    expect(d.description).toMatch(/^Observed divergence/);
    expect(d.downstreamB.length).toBeGreaterThan(3);
    expect(c.stateDiffs.some((x) => x.path.startsWith('$.external.collections.charges'))).toBe(true);
  });
  it('produces gaps for events present on one side only', () => {
    const c = compareRuns(faulty, fixed);
    expect(c.counts['only-a'] + c.counts['only-b']).toBeGreaterThan(0);
    for (const r of c.rows) if (r.op === 'same') expect(semanticKey(r.a!)).toBe(semanticKey(r.b!));
  });
});

describe('dependency graph', () => {
  it('only contains edges backed by recorded evidence', () => {
    const g = buildGraph(faulty);
    expect(g.edges.length).toBeGreaterThan(0);
    for (const e of g.edges) expect(e.evidence.length).toBeGreaterThan(0);
    expect(g.edges.some((e) => e.kind === 'retry')).toBe(true);
  });
});

describe('regression bundles', () => {
  it('export, serialize, reimport and reproduce', () => {
    const b = parseBundle(bundleToText(exportBundle(m.scenario, fixed)));
    const r = verifyBundle(b, getWorkflow);
    expect(r.ok).toBe(true);
    expect(r.checks.find((c) => c.name === 'normalized event stream')!.ok).toBe(true);
  });
  it('a failing run exports as a regression that expects the failure', () => {
    const b = exportBundle(m.scenario, faulty);
    expect(b.expected.assertions.find((a) => a.id === 'one-charge-per-order')!.status).toBe('fail');
    expect(verifyBundle(b, getWorkflow).ok).toBe(true);
  });
  it('detects tampering with the bundle', () => {
    const b = JSON.parse(bundleToText(exportBundle(m.scenario, fixed)));
    b.run.policy.values.useIdempotencyKey = false;
    const r = verifyBundle(b, getWorkflow);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === 'bundle integrity')!.ok).toBe(false);
  });
  it('detects a behavior change even when the integrity hash is recomputed', () => {
    const b = exportBundle(m.scenario, fixed);
    const changed = exportBundle(m.scenario, faulty);
    const mixed = { ...changed, expected: b.expected };
    const r = verifyBundle(mixed as any, getWorkflow);
    expect(r.ok).toBe(false);
  });
  it('refuses playback traces', () => {
    const { trace } = importOtlp(JSON.parse(readFileSync('tests/fixtures/otel-genai-sample.json', 'utf8')));
    expect(() => exportBundle(m.scenario, trace)).toThrow(/Only deterministic simulation runs/);
  });
});

describe('redaction', () => {
  it('redacts credential shapes, sensitive keys and user-selected paths, and lists every finding', () => {
    const doc = { headers: { Authorization: 'Bearer abc.def.ghi', 'x-api-key': 'k-123' }, note: 'key sk-abcdefghijklmnopqrstuv and ghp_abcdefghijklmnopqrstuvwxyz', user: { email: 'ada@example.test' }, password: 'hunter22' };
    const r = redact(doc, { userPaths: ['user.email'] });
    const s = JSON.stringify(r.output);
    expect(s).not.toMatch(/abc\.def|k-123|sk-abc|ghp_abc|ada@example|hunter22/);
    expect(r.findings.map((f) => f.rule).sort()).toEqual(['auth-header', 'auth-header', 'github-token', 'openai-style-key', 'secret-field', 'user-selected'].sort());
    expect(r.disclaimer).toMatch(/cannot find every secret/);
  });
});

describe('import validation', () => {
  it('round-trips a native trace with verified integrity', () => {
    const v = validateTrace(JSON.parse(JSON.stringify(faulty)));
    expect(v.integrity).toBe('verified');
  });
  it('reports integrity mismatch when events were edited', () => {
    const t = JSON.parse(JSON.stringify(faulty));
    t.events[3].summary = 'edited';
    expect(validateTrace(t).integrity).toBe('mismatch');
  });
  it('gives a useful error for newer or unknown versions instead of dropping data', () => {
    expect(() => validateTrace({ ...JSON.parse(JSON.stringify(faulty)), schema: 'fa.trace/2' })).toThrow(/newer than this build supports/);
    expect(() => validateTrace({ hello: 'world' })).toThrow(/Parsing JSON is not proof/);
  });
  it('rejects unknown event kinds and non-contiguous sequences', () => {
    const t = JSON.parse(JSON.stringify(faulty));
    t.events[2].kind = 'mystery';
    t.events[4].seq = 99;
    try {
      validateTrace(t);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ImportError);
      expect((err as ImportError).issues.join(' ')).toMatch(/mystery.*|seq is 99/);
    }
  });
  it('validates declarative scenarios and rejects unregistered workflows or unsupported fault effects', () => {
    expect(validateScenario(JSON.parse(JSON.stringify(m.scenario)), getWorkflow).id).toBe(m.scenario.id);
    const bad = JSON.parse(JSON.stringify(m.scenario));
    bad.workflow.id = 'my-own-code';
    expect(() => validateScenario(bad, getWorkflow)).toThrow(/cannot supply their own code/);
    const bad2 = JSON.parse(JSON.stringify(m.scenario));
    bad2.faultPresets[0].faults[0].effect = { type: 'truncate-array', path: 'x', keep: 1 };
    try { validateScenario(bad2, getWorkflow); expect.unreachable(); } catch (err) { expect((err as ImportError).issues.join(' ')).toMatch(/not supported at after-tool-commit/); }
  });
});

describe('OpenTelemetry GenAI import (pinned subset)', () => {
  const { trace, report } = importOtlp(JSON.parse(readFileSync('tests/fixtures/otel-genai-sample.json', 'utf8')));
  it('converts supported operations and keeps the rest explicit', () => {
    expect(report.converted).toBe(6);
    expect(report.skippedNonGenAi).toBe(1);
    expect(report.unsupportedOperations).toEqual({ embeddings: 1 });
    expect(trace.events.map((e) => e.kind)).toEqual(['step.started', 'model.request', 'model.response', 'tool.request', 'tool.response', 'tool.request', 'tool.error', 'note', 'model.request', 'model.response', 'note']);
  });
  it('is playback only with stated reasons', () => {
    expect(trace.mode).toBe('playback');
    expect(trace.capabilities.executable).toBe(false);
    expect(trace.capabilities.forkable).toBe(false);
    expect(trace.capabilities.reasons.length).toBeGreaterThan(0);
  });
  it('preserves tool call identity, parsed arguments and parent links', () => {
    const req = trace.events.find((e) => e.kind === 'tool.request' && e.tool === 'sources.retrieve')!;
    expect(req.requestId).toBe('call_001');
    expect((req.data as any).args).toEqual({ question: 'How did the pilot storage site perform?' });
    expect(req.causes).toEqual([1]);
    const err = trace.events.find((e) => e.kind === 'tool.error')!;
    expect((err.data as any).error.type).toBe('timeout');
  });
  it('passes native trace validation after import', () => {
    expect(validateTrace(JSON.parse(JSON.stringify(trace))).integrity).toBe('verified');
  });
});

describe('live adapter against the credential-free local stub (fixture test, not a provider test)', () => {
  let stub: StubServer;
  const rr = getScenario('research-report-missing-citation')!;
  beforeAll(async () => { stub = await startStub(); });
  afterAll(async () => { await stub.close(); });
  const live = (model: string, extra: Record<string, unknown> = {}) => runLive(rr.scenario, { baseUrl: stub.url, model, apiKey: 'sk-test-0000000000000000' }, extra);

  it('runs a tool call then a final answer and evaluates assertions on the live trace', async () => {
    const t = await live('tool-then-answer');
    expect(t.mode).toBe('live');
    expect(t.status).toBe('completed');
    expect(evaluateAll(rr.scenario.assertions, t, rr.scenario).find((a) => a.assertionId === 'citations')!.status).toBe('pass');
    expect(JSON.stringify(t)).not.toContain('sk-test');
  });
  it('merges streamed tool-call fragments and content', async () => {
    const t = await live('stream-tool-then-answer', { stream: true });
    expect(t.status).toBe('completed');
    expect((t.events.find((e) => e.kind === 'tool.request')!.data as any).args.question).toMatch(/pilot storage site/);
  });
  it('reports malformed responses, HTTP errors and partial streams as execution errors', async () => {
    expect((await live('malformed-json')).executionErrors[0].code).toBe('MODEL_MALFORMED');
    expect((await live('http-500')).executionErrors[0].code).toBe('MODEL_HTTP_ERROR');
    expect((await live('truncated-stream', { stream: true })).executionErrors[0].code).toBe('MODEL_PARTIAL');
  });
  it('rejects invalid tool arguments and blocks tools outside the live allowlist', async () => {
    const a = await live('bad-tool-args');
    expect(a.events.some((e) => e.kind === 'tool.error' && (e.data as any).error.code === 'INVALID_ARGUMENTS')).toBe(true);
    const b = await live('blocked-tool');
    expect(b.events.some((e) => e.kind === 'boundary.blocked' && e.tool === 'email.send')).toBe(true);
  });
  it('cancels an in-flight request', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const started = Date.now();
    const t = await live('slow', { signal: ac.signal });
    expect(t.status).toBe('cancelled');
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
