/// <reference lib="webworker" />
import { evaluateAll, summarize } from '../engine/assertions';
import { exportBundle, bundleToText, parseBundle, verifyBundle } from '../engine/bundle';
import { compareRuns } from '../engine/compare';
import { forkRun, runScenario } from '../engine/runner';
import type { Trace, TraceEvent } from '../engine/types';
import { ImportError, LIMITS, parseJsonText, validateTrace } from '../engine/validate';
import { importOtlp, isOtlpJson } from '../integrations/otel';
import { getScenario, getWorkflow } from '../scenarios/index';
import type { FromWorker, ToWorker } from './protocol';

/**
 * The shared deterministic engine runs here, off the main thread. The run
 * itself completes in virtual time; when pacing is requested, the recorded
 * events are delivered in small batches so they can be watched as they
 * appear. Pacing never changes the events or their order.
 */

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const cancelled = new Set<number>();
const post = (m: FromWorker) => ctx.postMessage(m);

async function deliver(id: number, events: TraceEvent[], paced: boolean): Promise<boolean> {
  if (!paced) {
    post({ id, type: 'events', events });
    return true;
  }
  const batch = events.length > 400 ? Math.ceil(events.length / 40) : 1;
  for (let i = 0; i < events.length; i += batch) {
    if (cancelled.has(id)) return false;
    post({ id, type: 'events', events: events.slice(i, i + batch) });
    await new Promise((r) => setTimeout(r, events.length > 400 ? 16 : 45));
  }
  return true;
}

function fail(id: number, err: unknown) {
  if (err instanceof ImportError) post({ id, type: 'error', message: err.message, issues: err.issues, code: err.code });
  else post({ id, type: 'error', message: err instanceof Error ? err.message : String(err) });
}

ctx.onmessage = async (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case 'cancel':
        cancelled.add(msg.target);
        return;
      case 'run':
      case 'fork': {
        const m = getScenario(msg.type === 'run' ? msg.req.scenarioId : msg.scenarioId);
        if (!m) throw new Error('Unknown scenario');
        const t0 = performance.now();
        const trace: Trace = msg.type === 'run'
          ? runScenario(m.scenario, m.workflow, { policy: msg.req.policy, faultPlan: msg.req.faultPlan, seed: msg.req.seed, wallClock: true })
          : forkRun(m.scenario, m.workflow, msg.parent, msg.checkpointId, { policy: msg.policy, faultPlan: msg.faultPlan }, { wallClock: true });
        const assertions = evaluateAll(m.scenario.assertions, trace, m.scenario);
        const elapsedMs = performance.now() - t0;
        const ok = await deliver(msg.id, trace.events, msg.type === 'run' ? msg.req.paced : msg.paced);
        if (!ok) { post({ id: msg.id, type: 'cancelled' }); return; }
        post({ id: msg.id, type: 'run-done', result: { trace, assertions, summary: summarize(assertions), elapsedMs } });
        return;
      }
      case 'compare': {
        const t0 = performance.now();
        const comparison = compareRuns(msg.a, msg.b);
        post({ id: msg.id, type: 'compare-done', comparison, elapsedMs: performance.now() - t0 });
        return;
      }
      case 'import': {
        const t0 = performance.now();
        const raw = parseJsonText(msg.text, LIMITS.maxBundleBytes, msg.name) as any;
        if (isOtlpJson(raw)) {
          const { trace, report } = importOtlp(raw);
          post({ id: msg.id, type: 'import-done', result: { kind: 'otlp', trace, report, assertions: [], summary: null, elapsedMs: performance.now() - t0 } });
          return;
        }
        if (raw && typeof raw === 'object' && typeof raw.schema === 'string' && raw.schema.startsWith('fa.bundle/')) {
          const bundle = parseBundle(msg.text);
          const report = verifyBundle(bundle, getWorkflow);
          if (!report.rerun) throw new ImportError('INVALID', 'Bundle could not be re-executed', report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`));
          post({ id: msg.id, type: 'import-done', result: { kind: 'bundle', trace: report.rerun, verify: { ok: report.ok, checks: report.checks }, assertions: report.assertions, summary: summarize(report.assertions), elapsedMs: performance.now() - t0 } });
          return;
        }
        const { trace, integrity } = validateTrace(raw);
        const scen = trace.scenario ? getScenario(trace.scenario.id)?.scenario ?? null : null;
        const assertions = scen ? evaluateAll(scen.assertions, trace, scen) : [];
        post({ id: msg.id, type: 'import-done', result: { kind: 'trace', trace, integrity, assertions, summary: scen ? summarize(assertions) : null, elapsedMs: performance.now() - t0 } });
        return;
      }
      case 'export-preview': {
        const m = getScenario(msg.scenarioId);
        if (!m) throw new Error('Unknown scenario');
        const t0 = performance.now();
        const bundle = exportBundle(m.scenario, msg.trace, { includeTrace: msg.includeTrace, userPaths: msg.userPaths });
        const text = bundleToText(bundle);
        post({ id: msg.id, type: 'export-done', preview: { bundle, text, findings: bundle.redaction?.findings ?? [], scenarioWarnings: bundle.redaction?.scenarioWarnings ?? [], disclaimer: bundle.redaction?.disclaimer ?? '', bytes: new TextEncoder().encode(text).length, elapsedMs: performance.now() - t0 } });
        return;
      }
    }
  } catch (err) {
    fail(msg.id, err);
  }
};
