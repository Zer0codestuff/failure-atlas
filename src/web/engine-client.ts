import type { Comparison } from '../engine/compare';
import type { FaultPlan, Policy, Trace, TraceEvent } from '../engine/types';
import type { ExportPreview, FromWorker, ImportResult, RunRequest, RunResult, ToWorker } from './protocol';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Pending = { resolve: (v: any) => void; reject: (e: any) => void; onEvents?: (e: TraceEvent[]) => void };

export class EngineError extends Error {
  constructor(message: string, readonly issues: string[] = [], readonly code?: string) {
    super(message);
  }
}

/** Promise wrapper around the engine worker. */
export class EngineClient {
  private worker: Worker;
  private seq = 0;
  private pending = new Map<number, Pending>();

  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<FromWorker>) => {
      const m = ev.data;
      const p = this.pending.get(m.id);
      if (!p) return;
      switch (m.type) {
        case 'events': p.onEvents?.(m.events); return;
        case 'run-done': this.pending.delete(m.id); p.resolve(m.result); return;
        case 'compare-done': this.pending.delete(m.id); p.resolve(m); return;
        case 'import-done': this.pending.delete(m.id); p.resolve(m.result); return;
        case 'export-done': this.pending.delete(m.id); p.resolve(m.preview); return;
        case 'cancelled': this.pending.delete(m.id); p.reject(new EngineError('Cancelled')); return;
        case 'error': this.pending.delete(m.id); p.reject(new EngineError(m.message, m.issues, m.code)); return;
      }
    };
    this.worker.onerror = (e) => {
      for (const [, p] of this.pending) p.reject(new EngineError(`Engine worker failed: ${e.message}`));
      this.pending.clear();
    };
  }

  private send<T>(msg: DistributiveOmit<ToWorker, 'id'>, onEvents?: (e: TraceEvent[]) => void): { id: number; promise: Promise<T> } {
    const id = ++this.seq;
    const promise = new Promise<T>((resolve, reject) => this.pending.set(id, { resolve, reject, onEvents }));
    this.worker.postMessage({ ...msg, id } as ToWorker);
    return { id, promise };
  }

  run(req: RunRequest, onEvents: (e: TraceEvent[]) => void) {
    return this.send<RunResult>({ type: 'run', req }, onEvents);
  }

  fork(scenarioId: string, parent: Trace, checkpointId: string, changes: { policy?: Policy; faultPlan?: FaultPlan | null }, paced: boolean, onEvents: (e: TraceEvent[]) => void) {
    return this.send<RunResult>({ type: 'fork', scenarioId, parent, checkpointId, ...changes, paced }, onEvents);
  }

  compare(a: Trace, b: Trace) {
    return this.send<{ comparison: Comparison; elapsedMs: number }>({ type: 'compare', a, b }).promise;
  }

  import(name: string, text: string) {
    return this.send<ImportResult>({ type: 'import', name, text }).promise;
  }

  exportPreview(scenarioId: string, trace: Trace, includeTrace: boolean, userPaths: string[]) {
    return this.send<ExportPreview>({ type: 'export-preview', scenarioId, trace, includeTrace, userPaths }).promise;
  }

  cancel(id: number) {
    this.worker.postMessage({ id: ++this.seq, type: 'cancel', target: id } as ToWorker);
  }
}
