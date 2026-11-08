import { canonicalize, hashJson, type Json } from './hash';
import type { Trace, TraceEvent } from './types';

/**
 * Run comparison. Events are aligned by semantic identity (kind, step, logical
 * request, attempt, tool, state target), never by wall-clock position or raw
 * sequence number. The first non-matching aligned position is reported as the
 * first observed divergence. That is an observation about two recordings, not
 * a proven root cause.
 */

export type AlignOp = 'same' | 'changed' | 'only-a' | 'only-b';

export interface AlignedRow {
  op: AlignOp;
  a: TraceEvent | null;
  b: TraceEvent | null;
  key: string;
  /** Field-level differences for "changed" rows. */
  diffs?: Array<{ path: string; a: Json | undefined; b: Json | undefined }>;
}

export interface Divergence {
  rowIndex: number;
  key: string;
  op: AlignOp;
  a: TraceEvent | null;
  b: TraceEvent | null;
  description: string;
  /** Sequence numbers in B causally downstream of the divergence (via recorded causes and request lineage). */
  downstreamB: number[];
  /** Sequence numbers in A causally downstream of the divergence. */
  downstreamA: number[];
}

export interface Comparison {
  a: { id: string; events: number; eventsHash: string; stateHash: string | null };
  b: { id: string; events: number; eventsHash: string; stateHash: string | null };
  rows: AlignedRow[];
  counts: Record<AlignOp, number>;
  firstDivergence: Divergence | null;
  identicalNormalized: boolean;
  stateDiffs: Array<{ path: string; a: Json | undefined; b: Json | undefined }>;
  method: 'myers' | 'greedy-fallback';
  note: string;
}

/** Semantic alignment key. Excludes seq, vt, wall-clock time and task numbering. */
export function semanticKey(e: TraceEvent): string {
  const d = (e.data ?? {}) as Record<string, unknown>;
  let target = '';
  if (e.kind === 'state.changed') target = String(d.path ?? d.collection ?? d.key ?? '');
  else if (e.kind === 'trigger.received') target = `${String(d.triggerId ?? '')}#${String(d.delivery ?? 1)}`;
  else if (e.kind === 'fault.injected') target = String(d.faultId ?? '');
  else if (e.kind === 'checkpoint') target = String(d.id ?? '');
  return [e.kind, e.step ?? '', e.logicalId ?? '', e.attempt ?? '', e.tool ?? '', target].join('|');
}

function comparablePayload(e: TraceEvent): Json {
  return { summary: e.summary, data: e.data, origin: e.origin };
}

export function diffJson(a: unknown, b: unknown, path = '$', out: Array<{ path: string; a: Json | undefined; b: Json | undefined }> = [], limit = 50): typeof out {
  if (out.length >= limit) return out;
  if (a === b) return out;
  const aObj = a !== null && typeof a === 'object';
  const bObj = b !== null && typeof b === 'object';
  if (aObj && bObj && Array.isArray(a) === Array.isArray(b)) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const k of [...keys].sort()) diffJson((a as any)[k], (b as any)[k], Array.isArray(a) ? `${path}[${k}]` : `${path}.${k}`, out, limit);
    return out;
  }
  if (a === undefined || b === undefined || canonicalize(a ?? null) !== canonicalize(b ?? null)) out.push({ path, a: a as Json | undefined, b: b as Json | undefined });
  return out;
}

/** Myers O(ND) diff over key sequences. Returns null when D exceeds maxD. */
function myers(a: string[], b: string[], maxD: number): Array<[number, number]> | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= Math.min(max, maxD); d++) {
    trace.push(v.slice());
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      next[offset + k] = x;
      if (x >= n && y >= m) {
        trace.push(next);
        return backtrack(trace, a.length, b.length, offset);
      }
    }
    v = next;
  }
  return null;
}

function backtrack(trace: Int32Array[], n: number, m: number, offset: number): Array<[number, number]> {
  // Returns matched index pairs (i in a, j in b); -1 marks a gap.
  const pairs: Array<[number, number]> = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 2; d >= 0; d--) {
    const v = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = v[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { pairs.push([x - 1, y - 1]); x--; y--; }
    if (d > 0) {
      if (x === prevX) pairs.push([-1, y - 1]);
      else pairs.push([x - 1, -1]);
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) { pairs.push([x - 1, y - 1]); x--; y--; }
  return pairs.reverse();
}

/** Greedy fallback for very different traces: match each B key to the next unused equal A key. */
function greedy(a: string[], b: string[]): Array<[number, number]> {
  const positions = new Map<string, number[]>();
  a.forEach((k, i) => positions.set(k, [...(positions.get(k) ?? []), i]));
  const pairs: Array<[number, number]> = [];
  let lastA = -1;
  for (let j = 0; j < b.length; j++) {
    const cand = (positions.get(b[j]) ?? []).find((i) => i > lastA);
    if (cand === undefined) { pairs.push([-1, j]); continue; }
    for (let i = lastA + 1; i < cand; i++) pairs.push([i, -1]);
    pairs.push([cand, j]);
    lastA = cand;
  }
  for (let i = lastA + 1; i < a.length; i++) pairs.push([i, -1]);
  return pairs;
}

/** Transitive causal closure: events that list a cause inside the seed set, plus same-lineage events. */
export function downstreamOf(events: TraceEvent[], seed: TraceEvent): number[] {
  const out = new Set<number>([seed.seq]);
  const lineage = seed.logicalId;
  for (const e of events) {
    if (e.seq <= seed.seq) continue;
    if ((e.causes ?? []).some((c) => out.has(c)) || (lineage && e.logicalId === lineage)) out.add(e.seq);
  }
  out.delete(seed.seq);
  return [...out].sort((x, y) => x - y);
}

function describe(row: AlignedRow): string {
  const ev = row.a ?? row.b!;
  const what = `${ev.kind}${ev.tool ? ` ${ev.tool}` : ''}${ev.step ? ` in ${ev.step}` : ''}${ev.attempt && ev.attempt > 1 ? ` (attempt ${ev.attempt})` : ''}`;
  switch (row.op) {
    case 'only-a': return `Observed divergence: run A recorded ${what}; run B has no aligned event.`;
    case 'only-b': return `Observed divergence: run B recorded ${what}; run A has no aligned event.`;
    case 'changed': return `Observed divergence: both runs recorded ${what}, with different content at ${row.diffs?.slice(0, 3).map((d) => d.path).join(', ')}.`;
    default: return '';
  }
}

export function compareRuns(a: Trace, b: Trace, opts: { maxD?: number } = {}): Comparison {
  const ka = a.events.map(semanticKey);
  const kb = b.events.map(semanticKey);
  let method: Comparison['method'] = 'myers';
  let pairs = myers(ka, kb, opts.maxD ?? 4000);
  if (!pairs) { pairs = greedy(ka, kb); method = 'greedy-fallback'; }
  const rows: AlignedRow[] = pairs.map(([i, j]) => {
    const ea = i >= 0 ? a.events[i] : null;
    const eb = j >= 0 ? b.events[j] : null;
    if (ea && eb) {
      const same = hashJson(comparablePayload(ea)) === hashJson(comparablePayload(eb));
      return same ? { op: 'same', a: ea, b: eb, key: ka[i] } : { op: 'changed', a: ea, b: eb, key: ka[i], diffs: diffJson(comparablePayload(ea), comparablePayload(eb)) };
    }
    return ea ? { op: 'only-a', a: ea, b: null, key: ka[i] } : { op: 'only-b', a: null, b: eb, key: kb[j] };
  });
  const counts: Record<AlignOp, number> = { same: 0, changed: 0, 'only-a': 0, 'only-b': 0 };
  for (const r of rows) counts[r.op]++;
  // run.started differs whenever policy or plan differ; that is configuration, not behavior.
  // Engine annotations (the run header and fork resume notes) describe how a run was produced,
  // not workflow behavior, so they never count as the first behavioral divergence.
  const annotation = (r: AlignedRow) => {
    const e = r.b ?? r.a;
    return (r.op === 'changed' && r.a?.kind === 'run.started') || (e?.kind === 'note' && e.origin === 'engine' && r.op !== 'changed');
  };
  const firstIdx = rows.findIndex((r) => r.op !== 'same' && !annotation(r));
  let firstDivergence: Divergence | null = null;
  if (firstIdx >= 0) {
    const row = rows[firstIdx];
    firstDivergence = {
      rowIndex: firstIdx,
      key: row.key,
      op: row.op,
      a: row.a,
      b: row.b,
      description: describe(row),
      downstreamA: row.a ? downstreamOf(a.events, row.a) : [],
      downstreamB: row.b ? downstreamOf(b.events, row.b) : [],
    };
  }
  const stateDiffs = a.finalState && b.finalState ? diffJson(a.finalState, b.finalState) : [];
  return {
    a: { id: a.id, events: a.events.length, eventsHash: a.hashes.events, stateHash: a.hashes.state },
    b: { id: b.id, events: b.events.length, eventsHash: b.hashes.events, stateHash: b.hashes.state },
    rows,
    counts,
    firstDivergence,
    identicalNormalized: a.hashes.events === b.hashes.events,
    stateDiffs,
    method,
    note: method === 'myers'
      ? 'Aligned by semantic step and request lineage (Myers diff on semantic keys).'
      : 'Traces differ too much for an exact alignment within the budget; a greedy in-order alignment was used. Rows may be less precise.',
  };
}
