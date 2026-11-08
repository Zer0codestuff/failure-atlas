import { useMemo } from 'react';
import type { TraceEvent } from '../../engine/types';
import { glyph } from '../explain';
import type { Mark } from './Timeline';

const MAX_CELLS = 120;
const RANK: Record<string, number> = { bad: 3, warn: 2, ok: 1, plain: 0, muted: -1 };

interface Cell { first: number; last: number; sym: string; tone: string; mark?: Mark; selected: boolean; label: string }

/**
 * A one-line ASCII overview of the run. Each cell is one recorded event, or a contiguous
 * bucket of events on long traces; a bucket shows its most severe event.
 */
export function TraceStrip({ events, marks, selectedSeq, onSelect }: { events: TraceEvent[]; marks: Map<number, Mark>; selectedSeq: number | null; onSelect: (seq: number) => void }) {
  const per = Math.max(1, Math.ceil(events.length / MAX_CELLS));
  const cells = useMemo(() => {
    const out: Cell[] = [];
    for (let i = 0; i < events.length; i += per) {
      const chunk = events.slice(i, i + per);
      let pick = chunk[0];
      let pickMark: Mark | undefined;
      for (const e of chunk) {
        const m = marks.get(e.seq);
        const better = (m && !pickMark) || (!pickMark && RANK[glyph(e).tone] > RANK[glyph(pick).tone]);
        if (better) { pick = e; pickMark = m; }
      }
      const g = glyph(pick);
      const first = chunk[0].seq, last = chunk[chunk.length - 1].seq;
      out.push({
        first: pick.seq, last, sym: pickMark === 'divergence' ? '◆' : per === 1 ? g.sym : pickMark || g.tone === 'bad' ? '|' : ':', tone: g.tone, mark: pickMark,
        selected: selectedSeq !== null && selectedSeq >= first && selectedSeq <= last,
        label: per === 1 ? `#${pick.seq} ${pick.kind}: ${pick.summary}` : `events #${first} to #${last}; most severe #${pick.seq} ${pick.kind}`,
      });
    }
    return out;
  }, [events, marks, selectedSeq, per]);
  if (!events.length) return null;
  return (
    <div className="strip" aria-label={per === 1 ? 'Run overview, one cell per event' : `Run overview, one cell per ${per} events`}>
      <div className="strip-cells">
        {cells.map((c) => (
          <button key={c.first} className={`strip-cell tone-${c.tone}${c.mark ? ` mark-${c.mark}` : ''}${c.selected ? ' sel' : ''}`} title={c.label} aria-label={c.label} onClick={() => onSelect(c.first)}>
            {c.sym}
          </button>
        ))}
      </div>
      <p className="strip-legend" aria-hidden="true">
        <span>#1</span>
        <span>{per === 1 ? 'one cell per event' : `one cell per ${per} events`} · <span className="lg-fail">red</span> evidence of a failed check · <span className="lg-div">◆</span> first divergence</span>
        <span>#{events[events.length - 1].seq}</span>
      </p>
    </div>
  );
}
