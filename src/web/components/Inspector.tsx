import { useMemo, useState } from 'react';
import type { EvaluatedAssertion } from '../../engine/assertions';
import { downstreamOf } from '../../engine/compare';
import { EFFECTS_BY_POINT } from '../../engine/validate';
import { type Fault, type FaultEffect, type FaultPoint, type Json, type Policy, type ScenarioDef, type Trace, type TraceEvent } from '../../engine/types';
import { explain, glyph } from '../explain';
import { JsonView } from './JsonView';
import { formatVt } from './Timeline';

interface Props {
  trace: Trace | null;
  event: TraceEvent | null;
  scenario: ScenarioDef | null;
  assertions: EvaluatedAssertion[];
  onSelect: (seq: number) => void;
  onInjectFault: (fault: Fault, mode: 'add' | 'only') => void;
  onFork: (checkpointId: string, policy: Policy | undefined, presetId: string | undefined) => void;
  busy: boolean;
  onBack?: () => void;
}

const STATUS_SYM: Record<string, string> = { pass: '[pass]', fail: '[FAIL]', error: '[error]', unavailable: '[unavailable]', 'not-applicable': '[n/a]' };

export function Inspector({ trace, event, scenario, assertions, onSelect, onInjectFault, onFork, busy, onBack }: Props) {
  const related = useMemo(() => (event ? assertions.filter((a) => a.evidence.eventSeqs.includes(event.seq)) : []), [event, assertions]);
  const downstream = useMemo(() => (trace && event ? downstreamOf(trace.events, event) : []), [trace, event]);
  if (!trace || !event) {
    return (
      <aside className="inspector" aria-label="Event inspector">
        <p className="eyebrow">inspector</p>
        <p className="empty">Select an event to see what it means, what caused it, and which checks rely on it.</p>
      </aside>
    );
  }
  const g = glyph(event);
  const simulation = trace.mode === 'simulation';
  const canInject = simulation && event.kind === 'tool.request' && !trace.fork && !!scenario;
  const canFork = simulation && event.kind === 'checkpoint' && !!scenario && scenario.checkpoints.includes(String((event.data as any)?.id)) && !trace.fork;
  return (
    <aside className="inspector" aria-label="Event inspector">
      {onBack && <button className="btn ghost back" onClick={onBack}><span aria-hidden="true">←</span> back</button>}
      <p className="eyebrow">inspector · event {event.seq} of {trace.events.length}</p>
      <header className="insp-head">
        <span className={`insp-sym tone-${g.tone}`} aria-hidden="true">{g.sym}</span>
        <div>
          <h2 className="insp-title">#{event.seq} {event.kind}</h2>
          <p className="muted small">{g.label} · virtual {formatVt(event.vt)} · origin {event.origin}{event.wt ? ` · wall ${event.wt.slice(11, 23)}` : ''}</p>
        </div>
      </header>
      <p className="insp-summary">{event.summary}</p>
      <p className="insp-explain">{explain(event)}</p>
      <dl className="kv">
        <dt>task</dt><dd>{event.task}</dd>
        {event.step && (<><dt>step</dt><dd>{event.step}</dd></>)}
        {event.tool && (<><dt>tool</dt><dd>{event.tool}</dd></>)}
        {event.requestId && (<><dt>request</dt><dd>{event.requestId}</dd></>)}
        {event.logicalId && (<><dt>logical request</dt><dd>{event.logicalId}</dd></>)}
        {event.attempt !== undefined && (<><dt>attempt</dt><dd>{event.attempt}</dd></>)}
        <dt>caused by</dt>
        <dd>{event.causes?.length ? event.causes.map((c) => <button key={c} className="link" onClick={() => onSelect(c)}>#{c}</button>) : <span className="muted">no recorded cause</span>}</dd>
        <dt>downstream</dt>
        <dd>{downstream.length ? <>{downstream.slice(0, 16).map((c) => <button key={c} className="link" onClick={() => onSelect(c)}>#{c}</button>)}{downstream.length > 16 && <span className="muted"> +{downstream.length - 16}</span>}</> : <span className="muted">none recorded</span>}</dd>
      </dl>
      {related.length > 0 && (
        <section className="insp-section">
          <h3>Checks that use this event</h3>
          <ul className="plain">
            {related.map((a) => (
              <li key={a.assertionId} className={`check-${a.status}`}><span className="sym">{STATUS_SYM[a.status]}</span> {a.title}<div className="muted small">{a.message}</div></li>
            ))}
          </ul>
        </section>
      )}
      {canInject && <FaultComposer event={event} scenario={scenario!} busy={busy} onInject={onInjectFault} />}
      {canFork && <ForkControl checkpointId={String((event.data as any).id)} scenario={scenario!} busy={busy} onFork={onFork} />}
      {!simulation && (
        <p className="notice small">This is a {trace.mode} trace. {trace.capabilities.reasons[0]} Fault injection and forks need a deterministic simulation.</p>
      )}
      <JsonView value={event} label={`Raw JSON for event ${event.seq}`} filename={`${trace.id}-event-${event.seq}.json`} />
    </aside>
  );
}

const POINT_LABEL: Record<string, string> = {
  'before-request': 'before the request reaches the tool',
  'after-tool-commit': 'after the tool commits its side effect',
  'before-response': 'before the response reaches the workflow',
};

function FaultComposer({ event, scenario, busy, onInject }: { event: TraceEvent; scenario: ScenarioDef; busy: boolean; onInject: (f: Fault, mode: 'add' | 'only') => void }) {
  const contract = scenario.tools.find((t) => t.name === event.tool);
  const points = (['before-request', 'after-tool-commit', 'before-response'] as FaultPoint[]).filter((p) => p !== 'after-tool-commit' || contract?.sideEffects === 'write');
  const [point, setPoint] = useState<FaultPoint>(points[points.length > 1 ? 1 : 0]);
  const effects = EFFECTS_BY_POINT[point];
  const [effect, setEffect] = useState<FaultEffect['type']>(effects[0]);
  const [code, setCode] = useState('UNAVAILABLE');
  const [ms, setMs] = useState(1500);
  const [retryAfter, setRetryAfter] = useState('');
  const [paths, setPaths] = useState('');
  const [setJson, setSetJson] = useState('{}');
  const [keep, setKeep] = useState(1);
  const [mode, setMode] = useState<'add' | 'only'>('add');
  const [err, setErr] = useState<string | null>(null);
  const eff = effects.includes(effect) ? effect : effects[0];

  const build = (): Fault | null => {
    let e: FaultEffect;
    switch (eff) {
      case 'error': e = { type: 'error', code, message: `Injected ${code}`, ...(retryAfter ? { retryAfterMs: Number(retryAfter) } : {}) }; break;
      case 'timeout': e = { type: 'timeout' } as FaultEffect; break;
      case 'drop-response': e = { type: 'drop-response' } as FaultEffect; break;
      case 'delay': e = { type: 'delay', ms } as FaultEffect; break;
      case 'remove-fields': e = { type: 'remove-fields', paths: paths.split(',').map((p) => p.trim()).filter(Boolean) } as FaultEffect; break;
      case 'set-fields': {
        try { e = { type: 'set-fields', values: JSON.parse(setJson) as Record<string, Json> } as FaultEffect; } catch { setErr('set-fields needs a JSON object such as {"status":"stale"}'); return null; }
        break;
      }
      case 'truncate-array': e = { type: 'truncate-array', path: paths.trim(), keep } as FaultEffect; break;
      default: return null;
    }
    setErr(null);
    return { id: `ui-${eff}-${event.requestId}`, description: `${eff} ${POINT_LABEL[point]} for ${event.requestId}`, point, target: { tool: event.tool, requestId: event.requestId }, effect: e };
  };

  return (
    <section className="insp-section composer" aria-label="Inject a fault at this request">
      <h3>Inject a fault at {event.requestId}</h3>
      <p className="muted small">The fault targets this exact request in a new run. The current run is never modified.</p>
      <div className="form">
        <label>point
          <select className="input" value={point} onChange={(e) => { const p = e.target.value as FaultPoint; setPoint(p); setEffect(EFFECTS_BY_POINT[p][0]); }}>
            {points.map((p) => <option key={p} value={p}>{p} ({POINT_LABEL[p]})</option>)}
          </select>
        </label>
        <label>effect
          <select className="input" value={eff} onChange={(e) => setEffect(e.target.value as FaultEffect['type'])}>
            {effects.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
        {eff === 'error' && (
          <>
            <label>error code<input className="input" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} /></label>
            <label>retry after (ms, optional)<input className="input" inputMode="numeric" value={retryAfter} onChange={(e) => setRetryAfter(e.target.value.replace(/\D/g, ''))} /></label>
          </>
        )}
        {eff === 'delay' && <label>delay (virtual ms)<input className="input" type="number" min={1} value={ms} onChange={(e) => setMs(Number(e.target.value))} /></label>}
        {eff === 'remove-fields' && <label>fields to remove (comma separated paths)<input className="input" placeholder="email, profile.plan" value={paths} onChange={(e) => setPaths(e.target.value)} /></label>}
        {eff === 'set-fields' && <label>values (JSON object)<input className="input" value={setJson} onChange={(e) => setSetJson(e.target.value)} /></label>}
        {eff === 'truncate-array' && (
          <>
            <label>array path<input className="input" placeholder="results" value={paths} onChange={(e) => setPaths(e.target.value)} /></label>
            <label>keep<input className="input" type="number" min={0} value={keep} onChange={(e) => setKeep(Number(e.target.value))} /></label>
          </>
        )}
        <fieldset className="radio">
          <legend className="sr-only">Fault plan</legend>
          <label><input type="radio" checked={mode === 'add'} onChange={() => setMode('add')} /> add to the current fault plan</label>
          <label><input type="radio" checked={mode === 'only'} onChange={() => setMode('only')} /> use only this fault</label>
        </fieldset>
        {err && <p className="error-text" role="alert">{err}</p>}
        <button className="btn primary" disabled={busy} onClick={() => { const f = build(); if (f) onInject(f, mode); }}>run with this fault</button>
      </div>
    </section>
  );
}

function ForkControl({ checkpointId, scenario, busy, onFork }: { checkpointId: string; scenario: ScenarioDef; busy: boolean; onFork: (c: string, p: Policy | undefined, preset: string | undefined) => void }) {
  const [policyId, setPolicyId] = useState(scenario.policies.find((p) => p.id !== 'faulty')?.id ?? scenario.policies[0].id);
  const [preset, setPreset] = useState('__parent');
  return (
    <section className="insp-section composer" aria-label="Fork from this checkpoint">
      <h3>Fork from checkpoint {checkpointId}</h3>
      <p className="muted small">The runner replays the parent to this checkpoint, verifies the prefix hash, then continues with the changes below. The parent run stays unchanged.</p>
      <div className="form">
        <label>policy after the checkpoint
          <select className="input" value={policyId} onChange={(e) => setPolicyId(e.target.value)}>
            {scenario.policies.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
        <label>fault plan after the checkpoint
          <select className="input" value={preset} onChange={(e) => setPreset(e.target.value)}>
            <option value="__parent">same as parent</option>
            <option value="none">no faults</option>
            {scenario.faultPresets.map((f) => <option key={f.id} value={f.id}>{f.title}</option>)}
          </select>
        </label>
        <button className="btn primary" disabled={busy} onClick={() => onFork(checkpointId, scenario.policies.find((p) => p.id === policyId), preset === '__parent' ? undefined : preset)}>fork run</button>
      </div>
    </section>
  );
}

