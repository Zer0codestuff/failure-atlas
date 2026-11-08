import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TraceEvent } from '../../engine/types';
import { glyph } from '../explain';

export type Mark = 'fail' | 'divergence' | 'downstream' | 'evidence';

interface Props {
  events: TraceEvent[];
  selectedSeq: number | null;
  onSelect: (seq: number) => void;
  marks: Map<number, Mark>;
  query: string;
  onQuery: (q: string) => void;
  kindFilter: string;
  onKindFilter: (k: string) => void;
  running: boolean;
  onOpen?: (seq: number) => void;
}

const ROW = 30;
const OVERSCAN = 12;
const MARK_LABEL: Record<Mark, string> = { fail: 'failed check evidence', divergence: 'first divergence', downstream: 'downstream of divergence', evidence: 'evidence' };
const MARK_SYM: Record<Mark, string> = { fail: 'F', divergence: '◆', downstream: '↓', evidence: '·' };

export function filterEvents(events: TraceEvent[], query: string, kind: string): TraceEvent[] {
  const q = query.trim().toLowerCase();
  return events.filter((e) => {
    if (kind && !e.kind.startsWith(kind)) return false;
    if (!q) return true;
    return (
      e.summary.toLowerCase().includes(q) ||
      e.kind.includes(q) ||
      (e.tool ?? '').toLowerCase().includes(q) ||
      (e.step ?? '').toLowerCase().includes(q) ||
      (e.requestId ?? '').toLowerCase().includes(q) ||
      `#${e.seq}` === q
    );
  });
}

export function Timeline({ events, selectedSeq, onSelect, marks, query, onQuery, kindFilter, onKindFilter, running, onOpen }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(480);
  const visible = useMemo(() => filterEvents(events, query, kindFilter), [events, query, kindFilter]);
  const selectedIndex = visible.findIndex((e) => e.seq === selectedSeq);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // Keep the selected row in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || selectedIndex < 0) return;
    const top = selectedIndex * ROW;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW - el.clientHeight;
  }, [selectedIndex]);

  // Follow new events while a run is streaming, unless the person scrolled up.
  const follow = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && running && follow.current) el.scrollTop = el.scrollHeight;
  }, [visible.length, running]);

  const onKey = useCallback(
    (ev: React.KeyboardEvent) => {
      if (!visible.length) return;
      let idx = selectedIndex;
      if (ev.key === 'ArrowDown' || ev.key === 'j') idx = Math.min(visible.length - 1, idx + 1);
      else if (ev.key === 'ArrowUp' || ev.key === 'k') idx = Math.max(0, idx - 1);
      else if (ev.key === 'Home') idx = 0;
      else if (ev.key === 'End') idx = visible.length - 1;
      else if (ev.key === 'PageDown') idx = Math.min(visible.length - 1, idx + Math.floor(height / ROW));
      else if (ev.key === 'PageUp') idx = Math.max(0, idx - Math.floor(height / ROW));
      else if (ev.key === 'Enter' && selectedSeq !== null) { onOpen?.(selectedSeq); return; }
      else return;
      ev.preventDefault();
      onSelect(visible[Math.max(0, idx)].seq);
    },
    [visible, selectedIndex, height, onSelect, onOpen, selectedSeq],
  );

  const start = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN);
  const end = Math.min(visible.length, Math.ceil((scrollTop + height) / ROW) + OVERSCAN);
  const slice = visible.slice(start, end);

  return (
    <section className="timeline" aria-label="Execution timeline">
      <div className="timeline-tools">
        <label className="sr-only" htmlFor="tl-search">Search events</label>
        <input id="tl-search" className="input" type="search" placeholder="search events  ( / )" value={query} onChange={(e) => onQuery(e.target.value)} />
        <label className="sr-only" htmlFor="tl-kind">Filter by kind</label>
        <select id="tl-kind" className="input" value={kindFilter} onChange={(e) => onKindFilter(e.target.value)}>
          <option value="">all kinds</option>
          <option value="tool.">tool calls</option>
          <option value="state.">state changes</option>
          <option value="fault.">faults</option>
          <option value="retry.">retries</option>
          <option value="check">checks</option>
          <option value="cancel.">cancellation</option>
          <option value="boundary.">boundary</option>
          <option value="model.">model</option>
        </select>
        <span className="muted small" aria-live="polite">{visible.length === events.length ? `${events.length} events` : `${visible.length} of ${events.length}`}{running ? ' · recording' : ''}</span>
      </div>
      <div className="timeline-head" aria-hidden="true">
        <span>#</span><span>virtual</span><span /><span>event</span><span>step</span><span>what happened</span>
      </div>
      <div
        ref={scrollRef}
        className="timeline-scroll"
        tabIndex={0}
        role="listbox"
        aria-label="Events. Use arrow keys or j and k to move, Enter to inspect."
        aria-activedescendant={selectedSeq !== null ? `ev-${selectedSeq}` : undefined}
        onKeyDown={onKey}
        onScroll={(e) => {
          const el = e.currentTarget;
          setScrollTop(el.scrollTop);
          follow.current = el.scrollTop + el.clientHeight >= el.scrollHeight - ROW * 2;
        }}
      >
        <div style={{ height: visible.length * ROW, position: 'relative' }}>
          {slice.map((e, i) => {
            const g = glyph(e);
            const mark = marks.get(e.seq);
            return (
              <div
                key={e.seq}
                id={`ev-${e.seq}`}
                role="option"
                aria-selected={e.seq === selectedSeq}
                className={`tl-row tone-${g.tone}${e.seq === selectedSeq ? ' selected' : ''}${mark ? ` mark-${mark}` : ''}`}
                style={{ top: (start + i) * ROW }}
                onClick={() => onSelect(e.seq)}
                onDoubleClick={() => onOpen?.(e.seq)}
              >
                <span className="tl-seq">{e.seq}</span>
                <span className="tl-vt">{formatVt(e.vt)}</span>
                <span className="tl-sym" title={g.label}>{mark ? <span className="tl-mark" title={MARK_LABEL[mark]}>{MARK_SYM[mark]}</span> : null}{g.sym}</span>
                <span className="tl-kind">{e.kind}</span>
                <span className="tl-step">{e.step ?? (e.task === 'engine' ? 'engine' : '')}</span>
                <span className="tl-sum">{e.summary}</span>
              </div>
            );
          })}
        </div>
        {!events.length && <p className="empty">{running ? 'Starting run…' : 'No events yet. Run a scenario or import a trace.'}</p>}
      </div>
    </section>
  );
}

export function formatVt(ms: number): string {
  if (ms < 1000) return `${Number.isInteger(ms) ? ms : ms.toFixed(1)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 2)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}
