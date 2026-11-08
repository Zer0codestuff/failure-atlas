import { canonicalize, getPath, type Json } from './hash';
import type { ExternalState, FixtureEntry, ScenarioDef } from './types';

export interface FixtureRequest {
  tool: string;
  args: Json;
  logicalId?: string;
  /** 1-based count of calls with the same tool and canonical arguments. */
  occurrence: number;
}

export type FixtureResolution =
  | { kind: 'match'; entry: FixtureEntry; score: number }
  | { kind: 'miss'; reason: string; nearest: string[] }
  | { kind: 'ambiguous'; candidates: string[]; score: number };

export class FixtureDefinitionError extends Error {}

/** Validate fixture declarations once at scenario load. */
export function checkFixtures(scenario: Pick<ScenarioDef, 'fixtures' | 'tools'>): string[] {
  const issues: string[] = [];
  const tools = new Set(scenario.tools.map((t) => t.name));
  const ids = new Set<string>();
  for (const f of scenario.fixtures) {
    if (ids.has(f.id)) issues.push(`Duplicate fixture id ${f.id}`);
    ids.add(f.id);
    if (!tools.has(f.tool)) issues.push(`Fixture ${f.id} references unknown tool ${f.tool}`);
    if (f.match.args === undefined && f.match.argsFields === undefined) {
      issues.push(`Fixture ${f.id} must declare args or argsFields; matching by tool name alone is not supported`);
    }
    if (f.match.args !== undefined && f.match.argsFields !== undefined) {
      issues.push(`Fixture ${f.id} declares both args and argsFields`);
    }
    if (!Number.isFinite(f.latencyMs) || f.latencyMs < 0) issues.push(`Fixture ${f.id} has invalid latency`);
  }
  return issues;
}

interface PreparedFixture {
  index: number;
  entry: FixtureEntry;
  argsKey?: string;
  fields?: Array<[string, string]>;
}

interface ToolIndex {
  all: PreparedFixture[];
  byArgs: Map<string, PreparedFixture[]>;
  fieldMatchers: PreparedFixture[];
}

/** Fixtures are immutable after load, so canonical keys are computed once per fixture list. */
const indexCache = new WeakMap<FixtureEntry[], Map<string, ToolIndex>>();

function indexFor(fixtures: FixtureEntry[]): Map<string, ToolIndex> {
  let idx = indexCache.get(fixtures);
  if (idx) return idx;
  idx = new Map();
  fixtures.forEach((entry, index) => {
    let t = idx!.get(entry.tool);
    if (!t) idx!.set(entry.tool, (t = { all: [], byArgs: new Map(), fieldMatchers: [] }));
    const p: PreparedFixture = { index, entry };
    if (entry.match.args !== undefined) {
      p.argsKey = canonicalize(entry.match.args);
      const list = t.byArgs.get(p.argsKey) ?? [];
      list.push(p);
      t.byArgs.set(p.argsKey, list);
    } else if (entry.match.argsFields !== undefined) {
      p.fields = Object.entries(entry.match.argsFields).map(([k, v]) => [k, canonicalize(v)]);
      t.fieldMatchers.push(p);
    } else {
      t.fieldMatchers.push(p); // rejected by checkFixtures; kept so behavior matches a linear scan
    }
    t.all.push(p);
  });
  indexCache.set(fixtures, idx);
  return idx;
}

function argsFieldMatch(fields: Array<[string, string]>, args: Json): boolean {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return fields.length === 0;
  for (const [path, expected] of fields) {
    const actual = getPath(args, path);
    if (actual === undefined || canonicalize(actual) !== expected) return false;
  }
  return true;
}

/**
 * Resolve a request against fixtures. Matching uses tool identity, canonical
 * arguments (exact or declared fields), relevant state, occurrence and logical
 * request identity. The highest-specificity unique candidate wins; ties are
 * rejected as ambiguous; no candidate is a recorded miss.
 */
export function resolveFixture(fixtures: FixtureEntry[], req: FixtureRequest, state: ExternalState): FixtureResolution {
  const argsKey = canonicalize(req.args);
  const tool = indexFor(fixtures).get(req.tool);
  const candidates = tool ? [...(tool.byArgs.get(argsKey) ?? []), ...tool.fieldMatchers].sort((x, y) => x.index - y.index) : [];
  const scored: Array<{ entry: FixtureEntry; score: number }> = [];
  for (const p of candidates) {
    const f = p.entry;
    let score = 0;
    if (p.argsKey !== undefined) score += 4;
    else if (p.fields !== undefined) {
      if (!argsFieldMatch(p.fields, req.args)) continue;
      score += 2;
    }
    if (f.match.state) {
      let ok = true;
      for (const [path, expected] of Object.entries(f.match.state)) {
        const actual = getPath(state, path);
        const actualKey = actual === undefined ? 'undefined' : canonicalize(actual);
        if (actualKey !== canonicalize(expected)) ok = false;
      }
      if (!ok) continue;
      score += 1;
    }
    if (f.match.occurrence !== undefined) {
      if (f.match.occurrence !== req.occurrence) continue;
      score += 1;
    }
    if (f.match.logicalId !== undefined) {
      if (f.match.logicalId !== req.logicalId) continue;
      score += 1;
    }
    scored.push({ entry: f, score });
  }
  if (scored.length === 0) {
    // Nearest: same-tool fixtures whose arguments did not match (only computed on a miss).
    const nearest = (tool?.all ?? []).filter((p) => (p.argsKey !== undefined ? p.argsKey !== argsKey : p.fields !== undefined && !argsFieldMatch(p.fields, req.args))).map((p) => p.entry.id);
    return { kind: 'miss', reason: `No fixture for ${req.tool} with arguments ${argsKey} (occurrence ${req.occurrence})`, nearest };
  }
  let best = -Infinity;
  for (const x of scored) if (x.score > best) best = x.score;
  const top = scored.filter((x) => x.score === best);
  if (top.length > 1) return { kind: 'ambiguous', candidates: top.map((t) => t.entry.id), score: best };
  return { kind: 'match', entry: top[0].entry, score: best };
}

/** Expand "{{args.x}}" style templates in fixture writes. A whole-string template keeps the raw type. */
export function expandTemplate(template: Json, scope: Record<string, unknown>): Json {
  if (typeof template === 'string') {
    const whole = template.match(/^\{\{\s*([\w.]+)\s*\}\}$/);
    if (whole) {
      const v = getPath(scope, whole[1]);
      return (v === undefined ? null : (v as Json));
    }
    return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, p: string) => {
      const v = getPath(scope, p);
      return v === undefined ? '' : typeof v === 'string' ? v : canonicalize(v);
    });
  }
  if (Array.isArray(template)) return template.map((t) => expandTemplate(t, scope));
  if (template && typeof template === 'object') {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(template)) out[k] = expandTemplate(v, scope);
    return out;
  }
  return template;
}
