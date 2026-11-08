import type { Trace, TraceEvent } from './types';

/**
 * Dependency graph derived only from recorded relationships. Every edge has a
 * concrete source in the trace:
 *  - "cause":    an event listed another event in `causes` (data or control dependency)
 *  - "response": a tool response/error answers a request with the same requestId
 *  - "retry":    attempt n+1 of a logical request follows attempt n
 *  - "spawn":    a task started another task (trigger or parallel branch)
 * No edge is inferred from proximity or timing.
 */

export type EdgeKind = 'cause' | 'response' | 'retry' | 'spawn';

export interface GraphNode {
  id: string;
  label: string;
  kind: 'trigger' | 'request' | 'state' | 'fault' | 'check' | 'output' | 'task' | 'other';
  seqs: number[];
  status: 'ok' | 'error' | 'blocked' | 'neutral';
  lane: string;
  firstVt: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  evidence: number[];
}

export interface DependencyGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

function nodeIdFor(e: TraceEvent): string {
  if (e.requestId && (e.kind.startsWith('tool.') || e.kind === 'boundary.blocked' || e.kind.startsWith('fixture.'))) return `req:${e.requestId}`;
  return `ev:${e.seq}`;
}

const INTERESTING = new Set([
  'trigger.received', 'tool.request', 'tool.response', 'tool.error', 'tool.response.late', 'tool.dedup', 'state.changed',
  'fault.injected', 'boundary.blocked', 'check', 'decision', 'output', 'cancel.requested', 'cancel.observed',
  'limit.exhausted', 'fixture.miss', 'fixture.ambiguous', 'checkpoint', 'model.request', 'model.response',
]);

export function buildGraph(trace: Trace): DependencyGraph {
  const nodes = new Map<string, GraphNode>();
  const seqToNode = new Map<number, string>();
  for (const e of trace.events) {
    if (!INTERESTING.has(e.kind)) continue;
    const id = nodeIdFor(e);
    seqToNode.set(e.seq, id);
    const existing = nodes.get(id);
    const status: GraphNode['status'] =
      e.kind === 'boundary.blocked' ? 'blocked'
        : e.kind === 'tool.error' || e.kind.startsWith('fixture.') || e.kind === 'limit.exhausted' ? 'error'
          : e.kind === 'tool.response' ? 'ok'
            : 'neutral';
    if (existing) {
      existing.seqs.push(e.seq);
      if (status !== 'neutral') existing.status = status;
      continue;
    }
    const kind: GraphNode['kind'] =
      e.kind === 'trigger.received' ? 'trigger'
        : e.requestId ? 'request'
          : e.kind === 'state.changed' ? 'state'
            : e.kind === 'fault.injected' ? 'fault'
              : e.kind === 'check' || e.kind === 'decision' ? 'check'
                : e.kind === 'output' ? 'output'
                  : 'other';
    const label = e.requestId ? `${e.tool}${e.attempt && e.attempt > 1 ? ` #${e.attempt}` : ''}` : e.kind === 'state.changed' ? `state ${String((e.data as any)?.path ?? (e.data as any)?.collection ?? '')}` : e.kind;
    nodes.set(id, { id, label, kind, seqs: [e.seq], status, lane: e.task, firstVt: e.vt });
  }
  const edges = new Map<string, GraphEdge>();
  const addEdge = (from: string | undefined, to: string | undefined, kind: EdgeKind, evidence: number[]) => {
    if (!from || !to || from === to) return;
    const k = `${from}>${to}>${kind}`;
    const ex = edges.get(k);
    if (ex) ex.evidence.push(...evidence.filter((s) => !ex.evidence.includes(s)));
    else edges.set(k, { from, to, kind, evidence: [...evidence] });
  };
  const lastAttempt = new Map<string, string>();
  for (const e of trace.events) {
    const to = seqToNode.get(e.seq);
    if (!to) continue;
    for (const c of e.causes ?? []) addEdge(seqToNode.get(c), to, 'cause', [c, e.seq]);
    if (e.kind === 'tool.request' && e.logicalId) {
      const prev = lastAttempt.get(e.logicalId);
      if (prev && prev !== to) addEdge(prev, to, 'retry', [e.seq]);
      lastAttempt.set(e.logicalId, to);
    }
  }
  // Spawn edges: a trigger starts a root task; the first request of that task depends on it.
  const taskFirstNode = new Map<string, string>();
  for (const e of trace.events) {
    const id = seqToNode.get(e.seq);
    if (id && !taskFirstNode.has(e.task) && e.task !== 'engine') taskFirstNode.set(e.task, id);
  }
  for (const e of trace.events) {
    if (e.kind !== 'task.spawned') continue;
    const first = taskFirstNode.get(e.task);
    for (const c of e.causes ?? []) {
      const src = seqToNode.get(c);
      if (src && first) addEdge(src, first, 'spawn', [c, e.seq]);
    }
  }
  return { nodes: [...nodes.values()].sort((a, b) => a.seqs[0] - b.seqs[0]), edges: [...edges.values()] };
}

/** Plain ASCII rendering for terminals and the reduced-motion text view. */
export function renderAsciiGraph(g: DependencyGraph, maxNodes = 60): string {
  const glyph = (n: GraphNode) => (n.status === 'error' ? 'x' : n.status === 'blocked' ? '#' : n.status === 'ok' ? 'o' : n.kind === 'fault' ? '!' : '.');
  const lines: string[] = [];
  const incoming = new Map<string, GraphEdge[]>();
  for (const e of g.edges) incoming.set(e.to, [...(incoming.get(e.to) ?? []), e]);
  for (const n of g.nodes.slice(0, maxNodes)) {
    const inc = (incoming.get(n.id) ?? []).map((e) => `${e.kind === 'retry' ? '~' : e.kind === 'spawn' ? '+' : '<'}${g.nodes.find((x) => x.id === e.from)?.label ?? e.from}`);
    lines.push(`[${glyph(n)}] ${n.label.padEnd(28)} #${n.seqs[0]}${inc.length ? `  ${inc.join(' ')}` : ''}`);
  }
  if (g.nodes.length > maxNodes) lines.push(`... ${g.nodes.length - maxNodes} more node(s)`);
  return lines.join('\n');
}
