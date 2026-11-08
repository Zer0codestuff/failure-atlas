import { useMemo } from 'react';
import type { DependencyGraph, GraphNode } from '../../engine/graph';

const NODE_SYM: Record<GraphNode['status'], string> = { ok: 'o', error: 'x', blocked: '#', neutral: '.' };
const MAX = 220;

/** Lanes per task, rows by first event. Every edge drawn is backed by recorded evidence. */
export function Graph({ graph, selectedSeq, onSelect }: { graph: DependencyGraph | null; selectedSeq: number | null; onSelect: (seq: number) => void }) {
  const layout = useMemo(() => {
    if (!graph) return null;
    const nodes = graph.nodes.slice(0, MAX);
    const lanes = [...new Set(nodes.map((n) => n.lane))];
    const pos = new Map<string, { x: number; y: number }>();
    nodes.forEach((n, i) => pos.set(n.id, { x: 16 + lanes.indexOf(n.lane) * 230, y: 34 + i * 30 }));
    const edges = graph.edges.filter((e) => pos.has(e.from) && pos.has(e.to));
    return { nodes, lanes, pos, edges, width: Math.max(480, lanes.length * 230 + 200), height: nodes.length * 30 + 50 };
  }, [graph]);
  if (!graph || !layout) return <p className="empty">No run yet.</p>;
  return (
    <div className="graph">
      <p className="small muted">Nodes are requests, state changes, faults and checks. Edges: solid = recorded cause, dashed = retry of the same logical request, dotted = task spawn. {graph.nodes.length > MAX ? `Showing the first ${MAX} of ${graph.nodes.length} nodes.` : `${graph.nodes.length} nodes, ${graph.edges.length} edges.`}</p>
      <div className="graph-scroll">
        <svg width={layout.width} height={layout.height} role="img" aria-label="Dependency graph">
          {layout.lanes.map((l, i) => <text key={l} x={16 + i * 230} y={16} className="lane-label">{l}</text>)}
          {layout.edges.map((e, i) => {
            const a = layout.pos.get(e.from)!;
            const b = layout.pos.get(e.to)!;
            const x1 = a.x + 8, y1 = a.y, x2 = b.x + 8, y2 = b.y;
            const bend = a.x === b.x ? -26 - (Math.abs(y2 - y1) > 60 ? 14 : 0) : 0;
            const d = `M${x1},${y1} C${x1 + bend},${y1 + 10} ${x2 + bend},${y2 - 10} ${x2},${y2}`;
            return <path key={i} d={d} className={`edge edge-${e.kind}`} />;
          })}
          {layout.nodes.map((n) => {
            const p = layout.pos.get(n.id)!;
            const sel = selectedSeq !== null && n.seqs.includes(selectedSeq);
            return (
              <g key={n.id} transform={`translate(${p.x},${p.y})`} className={`gnode st-${n.status} kind-${n.kind}${sel ? ' sel' : ''}`} onClick={() => onSelect(n.seqs[0])} role="button" tabIndex={0} onKeyDown={(ev) => { if (ev.key === 'Enter') onSelect(n.seqs[0]); }}>
                <rect x={-2} y={-11} width={16} height={20} rx={2} />
                <text x={3} y={4} className="gsym">{n.kind === 'fault' ? '!' : NODE_SYM[n.status]}</text>
                <text x={22} y={4} className="glabel">{n.label} <tspan className="gseq">#{n.seqs[0]}</tspan></text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
