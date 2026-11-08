import type { EvaluatedAssertion, AssertionSummary } from '../engine/assertions';
import type { Comparison } from '../engine/compare';
import type { RegressionBundle, VerifyReport } from '../engine/bundle';
import type { RedactionFinding } from '../engine/redact';
import type { FaultPlan, Json, Policy, Trace, TraceEvent } from '../engine/types';
import type { OtelImportReport } from '../integrations/otel';

export interface RunRequest {
  scenarioId: string;
  policy: Policy;
  faultPlan: FaultPlan | null;
  seed?: number;
  /** Deliver events in paced batches so a person can watch them appear. */
  paced: boolean;
}

export type ToWorker =
  | { id: number; type: 'run'; req: RunRequest }
  | { id: number; type: 'fork'; scenarioId: string; parent: Trace; checkpointId: string; policy?: Policy; faultPlan?: FaultPlan | null; paced: boolean }
  | { id: number; type: 'compare'; a: Trace; b: Trace }
  | { id: number; type: 'import'; name: string; text: string }
  | { id: number; type: 'export-preview'; scenarioId: string; trace: Trace; includeTrace: boolean; userPaths: string[] }
  | { id: number; type: 'cancel'; target: number };

export interface RunResult {
  trace: Trace;
  assertions: EvaluatedAssertion[];
  summary: AssertionSummary;
  elapsedMs: number;
}

export interface ImportResult {
  kind: 'trace' | 'otlp' | 'bundle';
  trace: Trace;
  report?: OtelImportReport;
  integrity?: 'verified' | 'mismatch';
  verify?: Pick<VerifyReport, 'ok' | 'checks'>;
  assertions: EvaluatedAssertion[];
  summary: AssertionSummary | null;
  elapsedMs: number;
}

export interface ExportPreview {
  bundle: RegressionBundle;
  text: string;
  findings: RedactionFinding[];
  scenarioWarnings: RedactionFinding[];
  disclaimer: string;
  bytes: number;
  elapsedMs: number;
}

export type FromWorker =
  | { id: number; type: 'events'; events: TraceEvent[] }
  | { id: number; type: 'run-done'; result: RunResult }
  | { id: number; type: 'compare-done'; comparison: Comparison; elapsedMs: number }
  | { id: number; type: 'import-done'; result: ImportResult }
  | { id: number; type: 'export-done'; preview: ExportPreview }
  | { id: number; type: 'error'; message: string; issues?: string[]; code?: string }
  | { id: number; type: 'cancelled' };

export type { Json };
