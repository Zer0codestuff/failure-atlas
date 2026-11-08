import type { ScenarioModule } from './helpers';
import { duplicateCharge, duplicateTrigger } from './catalog/side-effects';
import { rateLimit, timeoutBeforeSideEffect, retryLimitExhausted } from './catalog/retries';
import { schemaDrift, partialSearch, staleCache, researchReport } from './catalog/evidence';
import { outOfOrder, cancellation, untrustedDocument } from './catalog/concurrency';
import { repoBuilder } from './catalog/automation';

/** Shipped scenarios, in catalog order. Grouped by mechanism in the UI. */
export const SCENARIOS: ScenarioModule[] = [
  duplicateCharge,
  duplicateTrigger,
  rateLimit,
  timeoutBeforeSideEffect,
  retryLimitExhausted,
  schemaDrift,
  partialSearch,
  staleCache,
  outOfOrder,
  cancellation,
  untrustedDocument,
  researchReport,
  repoBuilder,
];

export const DEFAULT_SCENARIO_ID = 'lost-response-duplicate-charge';

export function getScenario(id: string): ScenarioModule | undefined {
  return SCENARIOS.find((s) => s.scenario.id === id);
}

export function getWorkflow(id: string, version: string) {
  return SCENARIOS.map((s) => s.workflow).find((w) => w.id === id && w.version === version);
}

export type { ScenarioModule };
