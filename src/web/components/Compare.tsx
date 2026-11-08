import { useMemo, useState } from 'react';
import type { Comparison } from '../../engine/compare';
import { formatVt } from './Timeline';

const OP_SYM: Record<string, string> = { same: '=', changed: '~', 'only-a': '-', 'only-b': '+' };

interface Props {
  comparison: Comparison | null;
  baselineLabel: string;
  currentLabel: string;
  baselineOptions: Array<{ key: string; label: string }>;
  baselineKey: string;
  onBaseline: (key: string) => void;
  onSelectB: (seq: number) => void;
  computing: boolean;
}

export function Compare({ comparison, baselineLabel, currentLabel, baselineOptions, baselineKey, onBaseline, onSelectB, computing }: Props) {
  const [onlyDiff, setOnlyDiff] = useState(true);
  const rows = useMemo(() => {
    if (!comparison) return [];
    const all = comparison.rows.map((r, i) => ({ r, i }));
    if (!onlyDiff) return all;
    const d = comparison.firstDivergence?.rowIndex ?? -1;
    return all.filter(({ r, i }) => r.op !== 'same' || i === d);
  }, [comparison, onlyDiff]);
  const downB = new Set(comparison?.firstDivergence?.downstreamB ?? []);
  return (
    <div className="compare">
      <div className="row gap wrap">
        <label className="inline">A (baseline)
          <select className="input" value={baselineKey} onChange={(e) => onBaseline(e.target.value)}>
            {baselineOptions.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        </label>
        <span className="muted">vs B (selected run): {currentLabel}</span>
        <label className="inline"><input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} /> differences only</label>
      </div>
      {computing && <p className="muted">Aligning runs…</p>}
      {comparison && (
        <>
          <p className="small muted">{comparison.note} {comparison.rows.length} aligned rows: {comparison.counts.same} same, {comparison.counts.changed} changed, {comparison.counts['only-a']} only in A, {comparison.counts['only-b']} only in B.</p>
          {comparison.firstDivergence ? (
            <div className="divergence" role="status">
              <div><span className="sym">◆</span> <strong>{comparison.firstDivergence.description}</strong></div>
              <div className="small">A: {comparison.firstDivergence.a ? `#${comparison.firstDivergence.a.seq} ${comparison.firstDivergence.a.summary}` : 'no aligned event'}</div>
              <div className="small">B: {comparison.firstDivergence.b ? <button className="link" onClick={() => onSelectB(comparison.firstDivergence!.b!.seq)}>#{comparison.firstDivergence.b.seq} {comparison.firstDivergence.b.summary}</button> : 'no aligned event'}</div>
              <div className="small muted">{comparison.firstDivergence.downstreamB.length} downstream event(s) in B are marked ↓. This is the first observed divergence between two recordings, not a proven root cause.</div>
            </div>
          ) : (
            <p className="ok-text">= No behavioral divergence observed between {baselineLabel} and {currentLabel}.</p>
          )}
          <div className="cmp-table" role="table" aria-label="Aligned events">
            <div className="cmp-row cmp-head" role="row"><span role="columnheader">op</span><span role="columnheader">A</span><span role="columnheader">B</span></div>
            {rows.slice(0, 600).map(({ r, i }) => (
              <div key={i} role="row" className={`cmp-row op-${r.op}${comparison.firstDivergence?.rowIndex === i ? ' first' : ''}${r.b && downB.has(r.b.seq) ? ' down' : ''}`}>
                <span role="cell" className="sym" title={r.op}>{comparison.firstDivergence?.rowIndex === i ? '◆' : r.b && downB.has(r.b.seq) ? '↓' : OP_SYM[r.op]}</span>
                <span role="cell">{r.a ? `#${r.a.seq} ${formatVt(r.a.vt)} ${r.a.summary}` : ''}</span>
                <span role="cell">{r.b ? <button className="link left" onClick={() => onSelectB(r.b!.seq)}>#{r.b.seq} {formatVt(r.b.vt)} {r.b.summary}</button> : ''}
                  {r.diffs && <span className="muted small"> changed: {r.diffs.slice(0, 3).map((d) => d.path).join(', ')}</span>}</span>
              </div>
            ))}
            {rows.length > 600 && <p className="muted small">Showing the first 600 of {rows.length} rows. Use the CLI compare command for the full table.</p>}
          </div>
          {comparison.stateDiffs.length > 0 && (
            <section>
              <h3>Final state differences</h3>
              <ul className="plain small mono">
                {comparison.stateDiffs.slice(0, 30).map((d) => <li key={d.path}><code>{d.path}</code>: {JSON.stringify(d.a) ?? 'absent'} -&gt; {JSON.stringify(d.b) ?? 'absent'}</li>)}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
