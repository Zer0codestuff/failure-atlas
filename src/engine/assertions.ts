import { canonicalize, getPath, type Json } from './hash';
import { validate } from './jsonschema';
import type { AssertionDef, AssertionResult, AssertionStatus, Evidence, ScenarioDef, Trace, TraceEvent } from './types';

/**
 * Deterministic assertions. Each result links to the exact events and state
 * paths it used. "unavailable" means the trace lacks the data needed to
 * evaluate the check; "not-applicable" means its precondition did not occur.
 * Neither counts as a pass.
 */
export type ExtendedStatus = AssertionStatus | 'not-applicable';

export interface EvaluatedAssertion extends Omit<AssertionResult, 'status'> {
  status: ExtendedStatus;
}

export interface AssertionSummary {
  total: number;
  pass: number;
  fail: number;
  error: number;
  unavailable: number;
  notApplicable: number;
  /** Plain statement with denominator; never a single unqualified score. */
  statement: string;
}

type Params = Record<string, any>;

function ev(seqs: number[], statePaths: string[] = [], values?: Json): Evidence {
  return { eventSeqs: [...new Set(seqs)].sort((a, b) => a - b), statePaths, ...(values !== undefined ? { values } : {}) };
}

function matches(e: TraceEvent, sel: { kind?: string; tool?: string; step?: string }): boolean {
  return (!sel.kind || e.kind === sel.kind) && (!sel.tool || e.tool === sel.tool) && (!sel.step || e.step === sel.step);
}

function stateRoot(trace: Trace, scope: string): unknown {
  if (!trace.finalState) return undefined;
  return scope === 'external' ? trace.finalState.external : trace.finalState.workflow;
}

/** Sequence numbers of state writes that touched a workflow path (or one of its parents/children). */
export function writesTo(trace: Trace, scope: string, path: string): number[] {
  return trace.events
    .filter((e) => {
      if (e.kind !== 'state.changed') return false;
      const d = e.data as Record<string, unknown> | null;
      if (!d || d.scope !== scope) return false;
      if (scope === 'workflow') {
        const p = String(d.path ?? '');
        return p === path || p.startsWith(path + '.') || path.startsWith(p + '.');
      }
      const collection = String(d.collection ?? d.key ?? '');
      return path.includes(collection);
    })
    .map((e) => e.seq);
}

function listAt(trace: Trace, spec: { scope: string; path: string; field?: string }): { items: string[] | null; seqs: number[] } {
  const root = stateRoot(trace, spec.scope);
  if (root === undefined) return { items: null, seqs: [] };
  const raw = getPath(root, spec.path);
  const seqs = writesTo(trace, spec.scope, spec.path);
  if (raw === undefined || raw === null) return { items: [], seqs };
  if (!Array.isArray(raw)) return { items: [String(raw)], seqs };
  return { items: raw.map((r) => (spec.field ? String(getPath(r, spec.field)) : typeof r === 'string' ? r : canonicalize(r as Json))), seqs };
}

function successfulResponses(trace: Trace, tool: string): TraceEvent[] {
  return trace.events.filter((e) => e.kind === 'tool.response' && e.tool === tool);
}

function expectedItems(trace: Trace, p: Params): { items: string[] | null; seqs: number[]; source: string } {
  if (Array.isArray(p.expected)) return { items: p.expected.map(String), seqs: [], source: 'declared list' };
  if (p.expectedFrom) {
    const resp = successfulResponses(trace, p.expectedFrom.tool);
    if (!resp.length) return { items: null, seqs: [], source: `${p.expectedFrom.tool} response` };
    const last = resp[resp.length - 1];
    const v = getPath(last.data, `value.${p.expectedFrom.field}`);
    return { items: Array.isArray(v) ? v.map(String) : null, seqs: [last.seq], source: `${p.expectedFrom.tool}.${p.expectedFrom.field}` };
  }
  return { items: null, seqs: [], source: 'none' };
}

function conditionHolds(trace: Trace, onlyIf: Params | undefined): { holds: boolean; seqs: number[]; text: string } {
  if (!onlyIf) return { holds: true, seqs: [], text: '' };
  if (onlyIf.event) {
    const hits = trace.events.filter((e) => matches(e, onlyIf.event));
    return { holds: hits.length > 0, seqs: hits.map((h) => h.seq), text: `an event ${onlyIf.event.kind}${onlyIf.event.tool ? ` for ${onlyIf.event.tool}` : ''}` };
  }
  if (onlyIf.contractViolation) {
    const hits = trace.events.filter((e) => e.kind === 'tool.response' && e.tool === onlyIf.contractViolation && Array.isArray((e.data as any)?.contractIssues) && (e.data as any).contractIssues.length > 0);
    return { holds: hits.length > 0, seqs: hits.map((h) => h.seq), text: `a contract violation by ${onlyIf.contractViolation}` };
  }
  if (onlyIf.claim) {
    const root = stateRoot(trace, onlyIf.claim.scope);
    const v = root === undefined ? undefined : getPath(root, onlyIf.claim.path);
    return { holds: canonicalize(v ?? null) === canonicalize(onlyIf.claim.equals), seqs: writesTo(trace, onlyIf.claim.scope, onlyIf.claim.path), text: `the claim ${onlyIf.claim.path} = ${canonicalize(onlyIf.claim.equals)}` };
  }
  return { holds: true, seqs: [], text: '' };
}

function compare(op: string, actual: unknown, value: unknown): boolean {
  switch (op) {
    case 'eq': return canonicalize((actual ?? null) as Json) === canonicalize((value ?? null) as Json);
    case 'neq': return canonicalize((actual ?? null) as Json) !== canonicalize((value ?? null) as Json);
    case 'exists': return actual !== undefined && actual !== null;
    case 'absent': return actual === undefined || actual === null;
    case 'gte': return typeof actual === 'number' && actual >= (value as number);
    case 'lte': return typeof actual === 'number' && actual <= (value as number);
    case 'in': return Array.isArray(value) && value.some((v) => canonicalize(v as Json) === canonicalize((actual ?? null) as Json));
    case 'len-eq': return (Array.isArray(actual) ? actual.length : 0) === value;
    case 'len-lte': return (Array.isArray(actual) ? actual.length : 0) <= (value as number);
    default: throw new Error(`Unknown comparison ${op}`);
  }
}

type Evaluator = (trace: Trace, p: Params, scenario: ScenarioDef | null) => Omit<EvaluatedAssertion, 'assertionId' | 'kind' | 'title'>;

const evaluators: Record<AssertionDef['kind'], Evaluator> = {
  'tool-schema': (trace, p, scenario) => {
    const contract = scenario?.tools.find((t) => t.name === p.tool);
    if (!contract) return { status: 'unavailable', message: `No contract for ${p.tool} is available for this trace`, evidence: ev([]) };
    const reqs = trace.events.filter((e) => e.kind === 'tool.request' && e.tool === p.tool);
    const resps = successfulResponses(trace, p.tool);
    if (!reqs.length && !resps.length) return { status: 'unavailable', message: `No ${p.tool} calls were recorded`, evidence: ev([]) };
    const bad: number[] = [];
    const notes: string[] = [];
    for (const r of reqs) {
      const issues = validate(contract.input, (r.data as any)?.args);
      if (issues.length) { bad.push(r.seq); notes.push(`#${r.seq} input: ${issues[0].path} ${issues[0].message}`); }
    }
    for (const r of resps) {
      const issues = validate(contract.output, (r.data as any)?.value);
      if (issues.length) { bad.push(r.seq); notes.push(`#${r.seq} output: ${issues[0].path} ${issues[0].message}`); }
    }
    if (bad.length) return { status: 'fail', message: notes.join('; '), violated: `${p.tool} messages must match the ${contract.name} contract`, evidence: ev(bad) };
    return { status: 'pass', message: `${reqs.length} request(s) and ${resps.length} response(s) match the contract`, evidence: ev([...reqs, ...resps].map((e) => e.seq)) };
  },

  'required-evidence': (trace, p) => {
    const cond = conditionHolds(trace, p.onlyIfClaim ? { claim: p.onlyIfClaim } : undefined);
    if (!cond.holds) return { status: 'not-applicable', message: `Precondition not met: ${cond.text}`, evidence: ev(cond.seqs) };
    const exp = expectedItems(trace, p);
    if (!exp.items) return { status: 'unavailable', message: `Expected items could not be determined from ${exp.source}`, evidence: ev(exp.seqs) };
    const present = listAt(trace, p.present);
    if (!present.items) return { status: 'unavailable', message: 'Final state is not available in this trace', evidence: ev(exp.seqs) };
    const missing = exp.items.filter((i) => !present.items!.includes(i));
    const seqs = [...exp.seqs, ...present.seqs, ...cond.seqs];
    if (missing.length) return { status: 'fail', message: `Missing required evidence: ${missing.join(', ')}`, violated: `Every item from ${exp.source} must be present in ${p.present.path}`, evidence: ev(seqs, [`${p.present.scope}.${p.present.path}`], { missing }) };
    return { status: 'pass', message: `All ${exp.items.length} required item(s) are present`, evidence: ev(seqs, [`${p.present.scope}.${p.present.path}`]) };
  },

  'gap-disclosed': (trace, p) => {
    const exp = expectedItems(trace, p);
    if (!exp.items) return { status: 'unavailable', message: `Expected items could not be determined from ${exp.source}`, evidence: ev(exp.seqs) };
    const present = listAt(trace, p.present);
    const gaps = listAt(trace, p.gaps);
    if (!present.items || !gaps.items) return { status: 'unavailable', message: 'Final state is not available in this trace', evidence: ev(exp.seqs) };
    const missing = exp.items.filter((i) => !present.items!.includes(i));
    const seqs = [...exp.seqs, ...present.seqs, ...gaps.seqs];
    if (!missing.length) return { status: 'not-applicable', message: 'No gap occurred: every expected item is present', evidence: ev(seqs) };
    const undisclosed = missing.filter((m) => !gaps.items!.includes(m));
    if (undisclosed.length) return { status: 'fail', message: `Gap not disclosed: ${undisclosed.join(', ')}`, violated: `Every missing item must be listed in ${p.gaps.path}`, evidence: ev(seqs, [`${p.gaps.scope}.${p.gaps.path}`], { missing, undisclosed }) };
    return { status: 'pass', message: `All ${missing.length} gap(s) are disclosed`, evidence: ev(seqs, [`${p.gaps.scope}.${p.gaps.path}`], { missing }) };
  },

  'allowed-tools': (trace, p) => {
    const allowed: string[] = p.allowed;
    const reqs = trace.events.filter((e) => e.kind === 'tool.request');
    if (!reqs.length) return { status: 'unavailable', message: 'No tool requests were recorded', evidence: ev([]) };
    const bad = reqs.filter((r) => !allowed.includes(String(r.tool)));
    if (bad.length) {
      const blocked = trace.events.filter((e) => e.kind === 'boundary.blocked');
      return { status: 'fail', message: `Attempted tool(s) outside the allowlist: ${[...new Set(bad.map((b) => b.tool))].join(', ')} (${blocked.length} blocked by the boundary)`, violated: `Only ${allowed.join(', ')} may be requested`, evidence: ev([...bad, ...blocked].map((e) => e.seq)) };
    }
    return { status: 'pass', message: `All ${reqs.length} request(s) used allowed tools`, evidence: ev(reqs.map((r) => r.seq)) };
  },

  ordering: (trace, p) => {
    const thens = trace.events.filter((e) => matches(e, p.then));
    if (!thens.length) return { status: 'not-applicable', message: `No ${p.then.kind}${p.then.tool ? ` ${p.then.tool}` : ''} events occurred`, evidence: ev([]) };
    const firsts = trace.events.filter((e) => matches(e, p.first));
    const firstSeq = firsts.length ? firsts[0].seq : Infinity;
    const bad = thens.filter((t) => t.seq < firstSeq);
    if (bad.length) return { status: 'fail', message: `${bad.length} event(s) happened before the required ${p.first.kind}${p.first.tool ? ` ${p.first.tool}` : ''}`, violated: p.description ?? 'Required ordering', evidence: ev([...bad.map((b) => b.seq), ...firsts.slice(0, 1).map((f) => f.seq)]) };
    return { status: 'pass', message: 'Ordering holds for every event', evidence: ev([firstSeq, ...thens.map((t) => t.seq)].filter(Number.isFinite)) };
  },

  'retry-bound': (trace, p) => {
    const reqs = trace.events.filter((e) => e.kind === 'tool.request' && (!p.tool || e.tool === p.tool));
    if (!reqs.length) return { status: 'unavailable', message: `No ${p.tool ?? ''} requests were recorded`, evidence: ev([]) };
    const byLogical = new Map<string, TraceEvent[]>();
    for (const r of reqs) {
      const k = r.logicalId ?? r.requestId ?? String(r.seq);
      byLogical.set(k, [...(byLogical.get(k) ?? []), r]);
    }
    const over = [...byLogical.entries()].filter(([, v]) => v.length > p.max);
    if (over.length) return { status: 'fail', message: over.map(([k, v]) => `${k}: ${v.length} attempts`).join('; '), violated: `At most ${p.max} attempts per logical request`, evidence: ev(over.flatMap(([, v]) => v.map((e) => e.seq))) };
    const maxSeen = Math.max(...[...byLogical.values()].map((v) => v.length));
    return { status: 'pass', message: `Max ${maxSeen} attempt(s) per logical request (bound ${p.max})`, evidence: ev(reqs.map((r) => r.seq)) };
  },

  'retry-after-honored': (trace, p) => {
    const errs = trace.events.filter((e) => e.kind === 'tool.error' && e.tool === p.tool && typeof (e.data as any)?.error?.retryAfterMs === 'number');
    if (!errs.length) return { status: 'not-applicable', message: 'No retry delays were returned', evidence: ev([]) };
    const bad: number[] = [];
    const checked: number[] = [];
    for (const err of errs) {
      const wait = (err.data as any).error.retryAfterMs as number;
      const next = trace.events.find((e) => e.seq > err.seq && e.kind === 'tool.request' && e.tool === p.tool && e.logicalId === err.logicalId);
      if (!next) continue;
      checked.push(err.seq, next.seq);
      if (next.vt < err.vt + wait) bad.push(err.seq, next.seq);
    }
    if (bad.length) return { status: 'fail', message: `Retried before the server-provided delay elapsed (${bad.length / 2} time(s))`, violated: 'A retry must not start before retryAfterMs has elapsed', evidence: ev(bad) };
    if (!checked.length) return { status: 'not-applicable', message: 'No retry followed a retry delay', evidence: ev(errs.map((e) => e.seq)) };
    return { status: 'pass', message: `${checked.length / 2} retry delay(s) honored`, evidence: ev(checked) };
  },

  cancellation: (trace, p) => {
    const cancel = trace.events.find((e) => e.kind === 'cancel.requested');
    if (!cancel) return { status: 'not-applicable', message: 'No cancellation was requested', evidence: ev([]) };
    const grace = Number(p.graceMs ?? 0);
    const late = trace.events.filter((e) => e.kind === 'tool.request' && e.seq > cancel.seq && e.vt > cancel.vt + grace);
    const observed = trace.events.find((e) => e.kind === 'cancel.observed');
    if (late.length) return { status: 'fail', message: `${late.length} new request(s) started after cancellation`, violated: 'No new work may start after a cancellation request', evidence: ev([cancel.seq, ...late.map((l) => l.seq)]) };
    if (p.requireObserved && !observed) return { status: 'fail', message: 'Cancellation was never observed by the workflow', violated: 'The workflow must record that it observed cancellation', evidence: ev([cancel.seq]) };
    return { status: 'pass', message: `No new requests after cancellation at ${cancel.vt} ms${observed ? `; observed at #${observed.seq}` : ''}`, evidence: ev([cancel.seq, ...(observed ? [observed.seq] : [])]) };
  },

  idempotency: (trace, p) => {
    const root = stateRoot(trace, 'external') as any;
    if (!root) return { status: 'unavailable', message: 'Simulated side-effect state is not available for this trace', evidence: ev([]) };
    const records: any[] = root.collections?.[p.collection] ?? [];
    const writes = trace.events.filter((e) => e.kind === 'state.changed' && (e.data as any)?.collection === p.collection);
    const seen = new Map<string, number[]>();
    records.forEach((r, i) => {
      const k = canonicalize((p.key as string[]).map((f) => (getPath(r, f) ?? null) as Json));
      seen.set(k, [...(seen.get(k) ?? []), i]);
    });
    const dups = [...seen.entries()].filter(([, v]) => v.length > 1);
    if (dups.length) {
      const dupSeqs = dups.flatMap(([, idx]) => idx.map((i) => writes[i]?.seq).filter((s): s is number => s !== undefined));
      return { status: 'fail', message: `Duplicate side effects in ${p.collection}: ${dups.map(([k, v]) => `${k} x${v.length}`).join('; ')}`, violated: `Each ${(p.key as string[]).join('+')} may produce at most one ${p.collection} record`, evidence: ev(dupSeqs, [`external.collections.${p.collection}`], { duplicates: dups.length }) };
    }
    return { status: 'pass', message: `${records.length} ${p.collection} record(s), no duplicates by ${(p.key as string[]).join('+')}`, evidence: ev(writes.map((w) => w.seq), [`external.collections.${p.collection}`]) };
  },

  completion: (trace, p) => {
    const finished = trace.events.find((e) => e.kind === 'run.finished');
    const seqs = finished ? [finished.seq] : [];
    if (trace.mode === 'playback' && trace.status === 'imported') return { status: 'unavailable', message: 'Imported traces do not carry an engine completion state', evidence: ev([]) };
    const okStatus = !p.runStatus || (p.runStatus as string[]).includes(trace.status);
    const outcomes = (Array.isArray(trace.outcome) ? trace.outcome : [trace.outcome]) as any[];
    const outcomeStatuses = outcomes.map((o) => o?.status ?? 'none');
    const okOutcome = !p.outcomeStatus || outcomeStatuses.every((s) => (p.outcomeStatus as string[]).includes(s));
    if (okStatus && okOutcome) return { status: 'pass', message: `Run status ${trace.status}; workflow outcome ${outcomeStatuses.join(', ')}`, evidence: ev(seqs) };
    return { status: 'fail', message: `Run status ${trace.status}; workflow outcome ${outcomeStatuses.join(', ')}`, violated: `Expected run status in [${(p.runStatus ?? ['any']).join(', ')}] and outcome in [${(p.outcomeStatus ?? ['any']).join(', ')}]`, evidence: ev(seqs) };
  },

  invariant: (trace, p) => {
    const cond = conditionHolds(trace, p.onlyIf);
    if (!cond.holds) return { status: 'not-applicable', message: `Precondition not met: ${cond.text}`, evidence: ev([]) };
    const root = stateRoot(trace, p.scope);
    if (root === undefined) return { status: 'unavailable', message: 'Final state is not available for this trace', evidence: ev(cond.seqs) };
    const actual = getPath(root, p.path);
    const seqs = [...cond.seqs, ...writesTo(trace, p.scope, p.path)];
    let ok: boolean;
    if (p.op === 'none-match' || p.op === 'all-match') {
      const arr = Array.isArray(actual) ? actual : [];
      const hit = arr.filter((r) => compare(p.where.op, getPath(r, p.where.field), p.where.value));
      ok = p.op === 'none-match' ? hit.length === 0 : hit.length === arr.length;
    } else ok = compare(p.op, actual, p.value);
    const shown = actual === undefined ? 'undefined' : canonicalize(actual as Json).slice(0, 200);
    if (ok) return { status: 'pass', message: `${p.scope}.${p.path} ${p.op}${p.value !== undefined ? ` ${canonicalize(p.value)}` : ''} holds (actual ${shown})`, evidence: ev(seqs, [`${p.scope}.${p.path}`]) };
    return { status: 'fail', message: `${p.scope}.${p.path} is ${shown}`, violated: p.description ?? `${p.scope}.${p.path} ${p.op} ${canonicalize(p.value ?? null)}`, evidence: ev(seqs, [`${p.scope}.${p.path}`], (actual ?? null) as Json) };
  },

  correlation: (trace, p) => {
    const root = stateRoot(trace, 'workflow');
    if (root === undefined) return { status: 'unavailable', message: 'Workflow state is not available for this trace', evidence: ev([]) };
    const items = getPath(root, p.outputPath);
    if (!Array.isArray(items)) return { status: 'unavailable', message: `No output at ${p.outputPath}`, evidence: ev([]) };
    const resps = successfulResponses(trace, p.tool);
    const bad: number[] = [];
    const notes: string[] = [];
    for (const item of items as any[]) {
      const resp = resps.find((r) => getPath(r.data, `value.${p.correlationField}`) === item[p.correlationField]);
      if (!resp) { notes.push(`${item[p.idField]}: no response with correlation ${item[p.correlationField]}`); continue; }
      const fields: string[] = p.compareFields ?? [p.idField];
      const wrong = fields.filter((f) => canonicalize((getPath(resp.data, `value.${f}`) ?? null) as Json) !== canonicalize((item[f] ?? null) as Json));
      if (wrong.length) { bad.push(resp.seq); notes.push(`${item[p.idField]} (${item[p.correlationField]}) carries ${wrong.map((f) => `${f}=${canonicalize(item[f] ?? null)}`).join(', ')} but its response has ${wrong.map((f) => `${f}=${canonicalize((getPath(resp.data, `value.${f}`) ?? null) as Json)}`).join(', ')}`); }
    }
    const seqs = [...resps.map((r) => r.seq), ...writesTo(trace, 'workflow', p.outputPath)];
    if (notes.length) return { status: 'fail', message: notes.join('; '), violated: 'Each output item must carry the data of the response with its own correlation ID', evidence: ev([...bad, ...writesTo(trace, 'workflow', p.outputPath)], [`workflow.${p.outputPath}`]) };
    return { status: 'pass', message: `${items.length} item(s) carry their own correlated responses`, evidence: ev(seqs, [`workflow.${p.outputPath}`]) };
  },

  freshness: (trace, p) => {
    const root = stateRoot(trace, 'workflow');
    if (root === undefined) return { status: 'unavailable', message: 'Workflow state is not available for this trace', evidence: ev([]) };
    const out = getPath(root, p.outputPath) as any;
    if (!out) return { status: 'unavailable', message: `No output at ${p.outputPath}`, evidence: ev([]) };
    const writes = writesTo(trace, 'workflow', p.outputPath);
    const writeEv = trace.events.find((e) => e.seq === writes[writes.length - 1]);
    const at = writeEv?.vt ?? 0;
    const age = at - Number(out[p.asOfField]);
    if (out[p.currentFlag] === true && age > p.maxAgeMs) return { status: 'fail', message: `Presented as current but ${age} ms old (limit ${p.maxAgeMs} ms)`, violated: `Data older than ${p.maxAgeMs} ms must not be presented as current`, evidence: ev(writes, [`workflow.${p.outputPath}`], { ageMs: age }) };
    return { status: 'pass', message: out[p.currentFlag] ? `Presented as current at age ${age} ms` : `Presented as stale with age ${age} ms`, evidence: ev(writes, [`workflow.${p.outputPath}`], { ageMs: age }) };
  },

  citations: (trace, p) => {
    const root = stateRoot(trace, 'workflow');
    if (root === undefined) return { status: 'unavailable', message: 'Workflow state is not available for this trace', evidence: ev([]) };
    const report = getPath(root, p.reportPath) as any;
    if (!report) return { status: 'unavailable', message: `No report at ${p.reportPath}`, evidence: ev([]) };
    const retrieved = new Set<string>();
    const sourceSeqs: number[] = [];
    for (const r of successfulResponses(trace, p.sourcesFrom.tool)) {
      const v = (r.data as any)?.value;
      const list = p.sourcesFrom.listField ? getPath(v, p.sourcesFrom.listField) : v;
      for (const s of Array.isArray(list) ? list : [list]) {
        const id = getPath(s, p.sourcesFrom.idField);
        if (id !== undefined) { retrieved.add(String(id)); sourceSeqs.push(r.seq); }
      }
    }
    const claims: any[] = report[p.claimsField] ?? [];
    const bad = claims.flatMap((c) => ((c[p.citeField] ?? []) as string[]).filter((id) => !retrieved.has(id)).map((id) => `"${String(c.text ?? '').slice(0, 40)}" cites ${id}`));
    const uncited = claims.filter((c) => !(c[p.citeField] ?? []).length).length;
    const seqs = [...sourceSeqs, ...writesTo(trace, 'workflow', p.reportPath)];
    if (bad.length || (p.requireCitation && uncited)) return { status: 'fail', message: [...bad, ...(uncited && p.requireCitation ? [`${uncited} claim(s) without citation`] : [])].join('; '), violated: 'Every published claim must cite a source snapshot that was actually retrieved', evidence: ev(seqs, [`workflow.${p.reportPath}`], { retrieved: [...retrieved] }) };
    return { status: 'pass', message: `${claims.length} claim(s) cite only retrieved sources (${retrieved.size} available)`, evidence: ev(seqs, [`workflow.${p.reportPath}`]) };
  },

  'no-execution-errors': (trace) => {
    const seqs = trace.executionErrors.map((e) => e.seq).filter((s): s is number => s !== undefined);
    if (trace.executionErrors.length) return { status: 'fail', message: trace.executionErrors.map((e) => `${e.code}: ${e.message}`).join('; '), violated: 'The run must complete without engine or fixture errors', evidence: ev(seqs) };
    if (trace.mode === 'playback') return { status: 'unavailable', message: 'Imported traces do not report engine errors', evidence: ev([]) };
    return { status: 'pass', message: 'No execution errors were recorded', evidence: ev([]) };
  },
};

export function evaluateAssertion(def: AssertionDef, trace: Trace, scenario: ScenarioDef | null): EvaluatedAssertion {
  const base = { assertionId: def.id, kind: def.kind, title: def.title };
  const fn = evaluators[def.kind];
  if (!fn) return { ...base, status: 'error', message: `No evaluator for assertion kind ${def.kind}`, evidence: ev([]) };
  try {
    return { ...base, ...fn(trace, def.params as Params, scenario) };
  } catch (err) {
    return { ...base, status: 'error', message: `Assertion could not be evaluated: ${err instanceof Error ? err.message : String(err)}`, evidence: ev([]) };
  }
}

export function evaluateAll(defs: AssertionDef[], trace: Trace, scenario: ScenarioDef | null): EvaluatedAssertion[] {
  return defs.map((d) => evaluateAssertion(d, trace, scenario));
}

export function summarize(results: EvaluatedAssertion[]): AssertionSummary {
  const count = (s: ExtendedStatus) => results.filter((r) => r.status === s).length;
  const s = { total: results.length, pass: count('pass'), fail: count('fail'), error: count('error'), unavailable: count('unavailable'), notApplicable: count('not-applicable') };
  const evaluated = s.pass + s.fail;
  return {
    ...s,
    statement: `${s.pass} of ${evaluated} evaluated check(s) passed; ${s.fail} failed, ${s.error} could not run, ${s.unavailable} unavailable, ${s.notApplicable} not applicable (${s.total} declared)`,
  };
}

/** The first failing assertion by earliest supporting event: the first observed invariant failure. */
export function firstFailure(results: EvaluatedAssertion[]): EvaluatedAssertion | null {
  const fails = results.filter((r) => r.status === 'fail');
  if (!fails.length) return null;
  return [...fails].sort((a, b) => (a.evidence.eventSeqs[0] ?? Infinity) - (b.evidence.eventSeqs[0] ?? Infinity))[0];
}
