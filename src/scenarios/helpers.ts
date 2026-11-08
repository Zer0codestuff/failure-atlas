import {
  SCHEMAS,
  type AssertionDef,
  type AssertionKind,
  type Fault,
  type FaultPlan,
  type FixtureEntry,
  type Json,
  type JsonSchema,
  type Policy,
  type ScenarioDef,
  type ToolContract,
} from '../engine/types';
import type { WorkflowDefinition } from '../engine/workflow';

export interface ScenarioModule {
  scenario: ScenarioDef;
  workflow: WorkflowDefinition;
}

export function contract(name: string, description: string, input: JsonSchema, output: JsonSchema, extra: Partial<ToolContract> = {}): ToolContract {
  return { schema: SCHEMAS.toolContract, name, description, input, output, sideEffects: 'none', ...extra };
}

export function obj(properties: Record<string, JsonSchema>, required: string[] = Object.keys(properties), additionalProperties = true): JsonSchema {
  return { type: 'object', properties, required, additionalProperties };
}

export const str: JsonSchema = { type: 'string' };
export const int: JsonSchema = { type: 'integer' };
export const num: JsonSchema = { type: 'number' };
export const bool: JsonSchema = { type: 'boolean' };
export const arr = (items: JsonSchema): JsonSchema => ({ type: 'array', items });

export function policy(workflowId: string, id: string, label: string, values: Record<string, Json>): Policy {
  return { schema: SCHEMAS.policy, id, label, workflowId, values };
}

export function plan(id: string, title: string, description: string, faults: Fault[]): FaultPlan {
  return { schema: SCHEMAS.faultPlan, id, title, description, faults };
}

export function check(id: string, kind: AssertionKind, title: string, params: Record<string, Json> = {}): AssertionDef {
  return { schema: SCHEMAS.assertion, id, kind, title, params };
}

export function ok(id: string, tool: string, match: FixtureEntry['match'], value: Json, latencyMs = 100, writes?: FixtureEntry['writes']): FixtureEntry {
  return { id, tool, match, response: { ok: true, value }, latencyMs, ...(writes ? { writes } : {}) };
}

export function fail(id: string, tool: string, match: FixtureEntry['match'], code: string, message: string, latencyMs = 50): FixtureEntry {
  return { id, tool, match, response: { ok: false, error: { code, message } }, latencyMs };
}

export function scenario(def: Omit<ScenarioDef, 'schema' | 'synthetic'>): ScenarioDef {
  return { schema: SCHEMAS.scenario, synthetic: true, ...def };
}
