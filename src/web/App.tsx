import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AssertionSummary, EvaluatedAssertion } from '../engine/assertions';
import type { Comparison } from '../engine/compare';
import { buildGraph } from '../engine/graph';
import { SCHEMAS, type Fault, type FaultPlan, type Policy, type Trace, type TraceEvent } from '../engine/types';
import { DEFAULT_SCENARIO_ID, SCENARIOS, getScenario } from '../scenarios/index';
import { Checks } from './components/Checks';
import { Compare } from './components/Compare';
import { Export } from './components/Export';
import { Graph } from './components/Graph';
import { Inspector } from './components/Inspector';
import { JsonView } from './components/JsonView';
import { PolicyPanel } from './components/PolicyPanel';
import { Timeline, type Mark } from './components/Timeline';
import { EngineClient, EngineError } from './engine-client';
import type { ExportPreview, ImportResult, RunResult } from './protocol';

interface RunRecord {
  key: string;
  label: string;
  scenarioId: string | null;
  kind: 'simulation' | 'fork' | 'import';
  parentKey?: string;
  trace: Trace;
  assertions: EvaluatedAssertion[];
  summary: AssertionSummary | null;
  elapsedMs: number;
  importInfo?: ImportResult;
}

type Panel = 'checks' | 'compare' | 'graph' | 'policy' | 'state' | 'export' | 'runs';
type MobileView = 'timeline' | 'inspector' | 'panel';

const PANELS: Array<{ id: Panel; label: string }> = [
  { id: 'checks', label: 'Checks' },
  { id: 'compare', label: 'Compare' },
  { id: 'graph', label: 'Graph' },
  { id: 'policy', label: 'Policy' },
  { id: 'state', label: 'State' },
  { id: 'export', label: 'Export' },
  { id: 'runs', label: 'Runs' },
];

const prefersReducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const params = new URLSearchParams(location.search);

function runLabel(policy: Policy, plan: FaultPlan | null) {
  return `${policy.label} · ${plan ? plan.title : 'no faults'}`;
}

export function App() {
  const engine = useMemo(() => new EngineClient(), []);
  const [scenarioId, setScenarioId] = useState(params.get('scenario') ?? DEFAULT_SCENARIO_ID);
  const mod = getScenario(scenarioId) ?? getScenario(DEFAULT_SCENARIO_ID)!;
  const scenario = mod.scenario;
  const [policyId, setPolicyId] = useState(params.get('policy') ?? 'faulty');
  const [presetId, setPresetId] = useState(params.get('faults') ?? scenario.faultPresets[0]?.id ?? 'none');
  const [customPolicy, setCustomPolicy] = useState<Policy | null>(null);
  const [customPlan, setCustomPlan] = useState<FaultPlan | null>(null);
  const [paced, setPaced] = useState(!prefersReducedMotion() && params.get('paced') !== '0');
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  const [baselineKey, setBaselineKey] = useState<string | null>(null);
  const [streaming, setStreaming] = useState<TraceEvent[] | null>(null);
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [panel, setPanel] = useState<Panel>((params.get('panel') as Panel) ?? 'checks');
  const [mobileView, setMobileView] = useState<MobileView>('timeline');
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [comparing, setComparing] = useState(false);
  const [error, setError] = useState<{ message: string; issues: string[] } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [exportPreview, setExportPreview] = useState<ExportPreview | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState('');
  const [railOpen, setRailOpen] = useState(false);
  const activeRun = useRef<number | null>(null);
  const counter = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);

  const current = runs.find((r) => r.key === currentKey) ?? null;
  const baseline = runs.find((r) => r.key === baselineKey) ?? null;
  const policy: Policy = customPolicy ?? scenario.policies.find((p) => p.id === policyId) ?? scenario.policies[0];
  const plan: FaultPlan | null = customPlan ?? (presetId === 'none' ? null : scenario.faultPresets.find((f) => f.id === presetId) ?? null);
  const shownEvents = streaming ?? current?.trace.events ?? [];
  const selectedEvent = useMemo(() => shownEvents.find((e) => e.seq === selectedSeq) ?? null, [shownEvents, selectedSeq]);
  const busy = streaming !== null;

  const addRun = useCallback((rec: Omit<RunRecord, 'key'>) => {
    const key = `r${++counter.current}`;
    setRuns((rs) => [...rs, { ...rec, key }]);
    return key;
  }, []);

  const execute = useCallback(
    async (opts: { scenarioId: string; policy: Policy; plan: FaultPlan | null; label?: string; silent?: boolean; makeBaseline?: boolean }) => {
      setError(null);
      if (!opts.silent) {
        if (activeRun.current !== null) engine.cancel(activeRun.current);
        setStreaming([]);
        setSelectedSeq(null);
        setExportPreview(null);
      }
      const { id, promise } = engine.run({ scenarioId: opts.scenarioId, policy: opts.policy, faultPlan: opts.plan, paced: !opts.silent && paced }, (evs) => {
        if (!opts.silent) setStreaming((s) => (s ? s.concat(evs) : evs));
      });
      if (!opts.silent) activeRun.current = id;
      try {
        const res: RunResult = await promise;
        const key = addRun({ label: opts.label ?? runLabel(opts.policy, opts.plan), scenarioId: opts.scenarioId, kind: 'simulation', trace: res.trace, assertions: res.assertions, summary: res.summary, elapsedMs: res.elapsedMs });
        if (opts.makeBaseline) setBaselineKey(key);
        if (!opts.silent) {
          activeRun.current = null;
          setStreaming(null);
          setCurrentKey(key);
          const firstFail = res.assertions.find((a) => a.status === 'fail' || a.status === 'error');
          setSelectedSeq(firstFail?.evidence.eventSeqs[0] ?? res.trace.events.at(-1)?.seq ?? null);
        }
        return key;
      } catch (err) {
        if (!opts.silent) { setStreaming(null); activeRun.current = null; }
        if (err instanceof EngineError && err.message === 'Cancelled') return null;
        setError({ message: err instanceof Error ? err.message : String(err), issues: err instanceof EngineError ? err.issues : [] });
        return null;
      }
    },
    [engine, paced, addRun],
  );

  const runCurrent = useCallback(() => execute({ scenarioId: scenario.id, policy, plan }), [execute, scenario.id, policy, plan]);

  // Open directly into a working example: the faulty run under the first fault preset,
  // with the corrected policy under the same faults as comparison baseline.
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    const corrected = scenario.policies.find((p) => p.id === 'corrected') ?? scenario.policies[0];
    void execute({ scenarioId: scenario.id, policy: corrected, plan, silent: true, makeBaseline: true }).then(() => execute({ scenarioId: scenario.id, policy, plan }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Comparison against the baseline, computed in the worker.
  useEffect(() => {
    if (!current || !baseline || current.key === baseline.key) { setComparison(null); return; }
    let live = true;
    setComparing(true);
    engine.compare(baseline.trace, current.trace).then(
      (r) => { if (live) { setComparison(r.comparison); setComparing(false); } },
      () => { if (live) setComparing(false); },
    );
    return () => { live = false; };
  }, [engine, current, baseline]);

  const marks = useMemo(() => {
    const m = new Map<number, Mark>();
    if (!current || streaming) return m;
    for (const s of comparison?.firstDivergence?.downstreamB ?? []) m.set(s, 'downstream');
    for (const a of current.assertions) if (a.status === 'fail') for (const s of a.evidence.eventSeqs) m.set(s, 'fail');
    const d = comparison?.firstDivergence?.b?.seq;
    if (d) m.set(d, 'divergence');
    return m;
  }, [current, comparison, streaming]);

  const graph = useMemo(() => (current && !streaming ? buildGraph(current.trace) : null), [current, streaming]);

  const selectScenario = (id: string) => {
    const m = getScenario(id)!;
    setScenarioId(id);
    setPolicyId('faulty');
    const preset = m.scenario.faultPresets[0]?.id ?? 'none';
    setPresetId(preset);
    setCustomPolicy(null);
    setCustomPlan(null);
    setRailOpen(false);
    setQuery('');
    const p = m.scenario.policies.find((x) => x.id === 'faulty') ?? m.scenario.policies[0];
    const f = m.scenario.faultPresets[0] ?? null;
    const corrected = m.scenario.policies.find((x) => x.id === 'corrected') ?? p;
    void execute({ scenarioId: id, policy: corrected, plan: f, silent: true, makeBaseline: true }).then(() => execute({ scenarioId: id, policy: p, plan: f }));
  };

  const onInjectFault = (fault: Fault, mode: 'add' | 'only') => {
    const base = mode === 'add' && current?.trace.faultPlan ? current.trace.faultPlan.faults.filter((f) => f.id !== fault.id) : [];
    const newPlan: FaultPlan = { schema: SCHEMAS.faultPlan, id: 'custom', title: `Custom: ${fault.description}${base.length ? ` + ${base.length} preset fault(s)` : ''}`, description: 'Composed in the inspector', faults: [...base, fault] };
    setCustomPlan(newPlan);
    setPresetId('custom');
    const pol = current?.trace.policy ?? policy;
    if (pol.id === 'custom') setCustomPolicy(pol);
    else { setCustomPolicy(null); setPolicyId(pol.id); }
    if (current) setBaselineKey(current.key);
    void execute({ scenarioId: scenario.id, policy: pol, plan: newPlan });
  };

  const onFork = async (checkpointId: string, forkPolicy: Policy | undefined, forkPreset: string | undefined) => {
    if (!current) return;
    setError(null);
    setStreaming([]);
    setSelectedSeq(null);
    const faultPlan = forkPreset === undefined ? undefined : forkPreset === 'none' ? null : scenario.faultPresets.find((f) => f.id === forkPreset) ?? null;
    const { promise } = engine.fork(scenario.id, current.trace, checkpointId, { policy: forkPolicy, faultPlan }, paced, (evs) => setStreaming((s) => (s ? s.concat(evs) : evs)));
    try {
      const res = await promise;
      const key = addRun({ label: `fork of ${current.label} at ${checkpointId} -> ${forkPolicy?.label ?? 'same policy'}${faultPlan === undefined ? '' : ` · ${faultPlan ? faultPlan.title : 'no faults'}`}`, scenarioId: scenario.id, kind: 'fork', parentKey: current.key, trace: res.trace, assertions: res.assertions, summary: res.summary, elapsedMs: res.elapsedMs });
      setBaselineKey(current.key);
      setCurrentKey(key);
      setStreaming(null);
      setSelectedSeq(res.trace.fork?.seq ?? null);
      setNotice(`Forked at ${checkpointId}: the replayed prefix matched the parent (hash ${res.trace.fork?.parentPrefixHash.slice(0, 12)}). The parent run is unchanged.`);
    } catch (err) {
      setStreaming(null);
      setError({ message: err instanceof Error ? err.message : String(err), issues: err instanceof EngineError ? err.issues : [] });
    }
  };

  const onImportFile = async (file: File) => {
    setError(null);
    setNotice(null);
    try {
      const text = await file.text();
      const res = await engine.import(file.name, text);
      const scen = res.trace.scenario ? getScenario(res.trace.scenario.id) : undefined;
      const key = addRun({ label: `${res.kind === 'bundle' ? 'bundle' : 'imported'}: ${file.name}`, scenarioId: scen?.scenario.id ?? null, kind: res.kind === 'bundle' ? 'simulation' : 'import', trace: res.trace, assertions: res.assertions, summary: res.summary, elapsedMs: res.elapsedMs, importInfo: res });
      if (scen && scen.scenario.id !== scenarioId) setScenarioId(scen.scenario.id);
      setCurrentKey(key);
      setSelectedSeq(res.trace.events[0]?.seq ?? null);
      if (res.kind === 'otlp' && res.report) setNotice(`Imported ${res.report.converted} GenAI span(s) as playback (semantic conventions pinned at ${res.report.pin.commit.slice(0, 8)}, stability ${res.report.pin.stability}). ${res.report.skippedNonGenAi} non-GenAI span(s) skipped.${Object.keys(res.report.unsupportedOperations).length ? ` Unsupported operations kept as notes: ${Object.entries(res.report.unsupportedOperations).map(([k, v]) => `${k} x${v}`).join(', ')}.` : ''}${res.report.warnings.length ? ` Warnings: ${res.report.warnings.join('; ')}` : ''}`);
      else if (res.kind === 'bundle') setNotice(res.verify?.ok ? 'Bundle verified: re-execution reproduced every recorded expectation.' : `Bundle did NOT reproduce: ${res.verify?.checks.filter((c) => !c.ok).map((c) => `${c.name} (${c.detail})`).join('; ')}`);
      else setNotice(`Imported native trace. Integrity: ${res.integrity}.${res.integrity === 'mismatch' ? ' The events or state do not hash to the recorded values; the file was edited after the run.' : ''}`);
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : String(err), issues: err instanceof EngineError ? err.issues : [] });
    }
  };

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') {
        if (e.key === 'Escape') t.blur();
        return;
      }
      if (e.key === '/') { e.preventDefault(); document.getElementById('tl-search')?.focus(); }
      else if (e.key === 'r' && !busy) { e.preventDefault(); void runCurrent(); }
      else if (e.key === 't') document.querySelector<HTMLElement>('.timeline-scroll')?.focus();
      else if (/^[1-7]$/.test(e.key)) setPanel(PANELS[Number(e.key) - 1].id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, runCurrent]);

  // Drag and drop import.
  useEffect(() => {
    const over = (e: DragEvent) => e.preventDefault();
    const drop = (e: DragEvent) => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (f) void onImportFile(f); };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => { window.removeEventListener('dragover', over); window.removeEventListener('drop', drop); };
  });

  const mode = current?.trace.mode ?? 'simulation';
  const grouped = useMemo(() => {
    const g = new Map<string, typeof SCENARIOS>();
    for (const m of SCENARIOS) g.set(m.scenario.mechanism, [...(g.get(m.scenario.mechanism) ?? []), m]);
    return [...g];
  }, []);
  const lastByScenario = useMemo(() => {
    const m = new Map<string, RunRecord>();
    for (const r of runs) if (r.scenarioId && r.kind !== 'import') m.set(r.scenarioId, r);
    return m;
  }, [runs]);

  const selectEvent = (seq: number) => { setSelectedSeq(seq); setMobileView('inspector'); };

  return (
    <div className={`app mv-${mobileView}`}>
      <header className="topbar">
        <button className="btn ghost rail-toggle" aria-expanded={railOpen} onClick={() => setRailOpen(!railOpen)}>[=] scenarios</button>
        <h1 className="brand">FAILURE ATLAS</h1>
        <span className={`mode mode-${mode}`} title={current?.trace.capabilities.reasons.join(' ') ?? ''}>
          {mode === 'simulation' ? 'SIMULATION · fixtures · virtual time · reproducible' : mode === 'playback' ? 'PLAYBACK · recorded · not re-executable' : 'LIVE RECORDING · not reproducible'}
        </span>
        <div className="controls">
          <label className="sr-only" htmlFor="sel-policy">Policy</label>
          <select id="sel-policy" className="input" value={customPolicy ? 'custom' : policyId} onChange={(e) => { setCustomPolicy(null); setPolicyId(e.target.value); }}>
            {scenario.policies.map((p) => <option key={p.id} value={p.id}>policy: {p.label}</option>)}
            {customPolicy && <option value="custom">policy: {customPolicy.label}</option>}
          </select>
          <label className="sr-only" htmlFor="sel-faults">Fault plan</label>
          <select id="sel-faults" className="input" value={presetId} onChange={(e) => { setCustomPlan(null); setPresetId(e.target.value); }}>
            <option value="none">faults: none</option>
            {scenario.faultPresets.map((f) => <option key={f.id} value={f.id}>faults: {f.title}</option>)}
            {customPlan && <option value="custom">faults: {customPlan.title}</option>}
          </select>
          <button className="btn primary" onClick={() => void runCurrent()} disabled={busy} title="Run (r)">{busy ? 'running…' : '> run'}</button>
          <label className="inline small" title="Deliver recorded events gradually so they can be watched. Off when reduced motion is requested."><input type="checkbox" checked={paced} onChange={(e) => setPaced(e.target.checked)} /> paced</label>
          <button className="btn ghost" onClick={() => fileInput.current?.click()}>import</button>
          <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void onImportFile(f); e.target.value = ''; }} />
        </div>
      </header>

      <nav className={`rail${railOpen ? ' open' : ''}`} aria-label="Scenarios">
        {grouped.map(([mech, ms]) => (
          <section key={mech}>
            <h2 className="rail-group">{mech}</h2>
            <ul className="plain">
              {ms.map((m) => {
                const last = lastByScenario.get(m.scenario.id);
                const fails = last?.summary?.fail ?? 0;
                return (
                  <li key={m.scenario.id}>
                    <button className={`rail-item${m.scenario.id === scenario.id ? ' active' : ''}`} aria-current={m.scenario.id === scenario.id ? 'true' : undefined} onClick={() => selectScenario(m.scenario.id)}>
                      <span className="rail-title">{m.scenario.title}</span>
                      {last && <span className={`rail-status ${fails ? 'bad' : 'ok'}`}>{fails ? `x ${fails} failing` : 'o all evaluated pass'}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        <p className="rail-foot small muted">All scenarios are synthetic and run on local fixtures. Keys: r run · / search · t timeline · j/k move · 1-7 panels.</p>
      </nav>

      <main className="main">
        <div className="scenario-head">
          <div>
            <h2 className="scen-title">{scenario.title}</h2>
            <p className="scen-sum">{scenario.summary}</p>
          </div>
          {current && (
            <p className="run-line small">
              <span className="mono">{current.trace.id}</span> · status <strong>{current.trace.status}</strong> · {current.trace.events.length} events · {current.label}
              {current.trace.parentRunId && <> · forked from <span className="mono">{current.trace.parentRunId}</span></>}
            </p>
          )}
        </div>
        <div className="mobile-tabs" role="tablist" aria-label="Views">
          {(['timeline', 'inspector', 'panel'] as MobileView[]).map((v) => (
            <button key={v} role="tab" aria-selected={mobileView === v} className={`tab${mobileView === v ? ' active' : ''}`} onClick={() => setMobileView(v)}>{v === 'panel' ? PANELS.find((p) => p.id === panel)!.label : v}</button>
          ))}
        </div>
        {error && (
          <div className="notice bad" role="alert">
            <strong>{error.message}</strong>
            {error.issues.length > 0 && <ul className="plain small">{error.issues.map((i) => <li key={i}>{i}</li>)}</ul>}
            <button className="btn ghost" onClick={() => setError(null)}>dismiss</button>
          </div>
        )}
        {notice && <div className="notice" role="status">{notice} <button className="btn ghost" onClick={() => setNotice(null)}>dismiss</button></div>}
        <div className="work">
          <div className="pane-timeline">
            <Timeline events={shownEvents} selectedSeq={selectedSeq} onSelect={setSelectedSeq} marks={marks} query={query} onQuery={setQuery} kindFilter={kindFilter} onKindFilter={setKindFilter} running={busy} onOpen={selectEvent} />
          </div>
          <div className="pane-inspector">
            <Inspector trace={current && !busy ? current.trace : null} event={busy ? null : selectedEvent} scenario={current?.scenarioId ? getScenario(current.scenarioId)?.scenario ?? null : null} assertions={current?.assertions ?? []} onSelect={setSelectedSeq} onInjectFault={onInjectFault} onFork={onFork} busy={busy} onBack={() => setMobileView('timeline')} />
          </div>
        </div>
        <section className="panels pane-panel" aria-label="Analysis panels">
          <div className="tabs" role="tablist">
            {PANELS.map((p, i) => (
              <button key={p.id} role="tab" aria-selected={panel === p.id} className={`tab${panel === p.id ? ' active' : ''}`} onClick={() => { setPanel(p.id); setMobileView('panel'); }} title={`${p.label} (${i + 1})`}>
                {p.label}
                {p.id === 'checks' && current?.summary && current.summary.fail > 0 && <span className="badge bad">{current.summary.fail}</span>}
                {p.id === 'compare' && comparison?.firstDivergence && <span className="badge">◆</span>}
              </button>
            ))}
          </div>
          <div className="panel-body" role="tabpanel">
            {panel === 'checks' && <Checks trace={current?.trace ?? null} assertions={current?.assertions ?? []} summary={current?.summary ?? null} onSelect={selectEvent} />}
            {panel === 'compare' && (
              <Compare
                comparison={comparison}
                computing={comparing}
                baselineKey={baselineKey ?? ''}
                baselineLabel={baseline?.label ?? 'none'}
                currentLabel={current?.label ?? 'none'}
                baselineOptions={runs.filter((r) => r.key !== currentKey).map((r) => ({ key: r.key, label: `${r.key} ${r.label}` }))}
                onBaseline={setBaselineKey}
                onSelectB={selectEvent}
              />
            )}
            {panel === 'graph' && <Graph graph={graph} selectedSeq={selectedSeq} onSelect={selectEvent} />}
            {panel === 'policy' && <PolicyPanel workflow={mod.workflow} policy={policy} busy={busy} onApply={(p) => { setCustomPolicy(p); void execute({ scenarioId: scenario.id, policy: p, plan }); }} />}
            {panel === 'state' && (current?.trace.finalState ? (
              <div>
                <p className="small">Final simulated state. Assertions read this store, not workflow text output. Hash <span className="mono">{current.trace.hashes.state?.slice(0, 16)}</span>.</p>
                <pre className="json small">{JSON.stringify(current.trace.finalState, null, 2)}</pre>
              </div>
            ) : <p className="empty">{current ? 'This trace carries no state. Playback traces record events only.' : 'No run yet.'}</p>)}
            {panel === 'export' && (
              <Export trace={current?.trace ?? null} preview={exportPreview} error={exportError} onPreview={async (inc, paths) => {
                if (!current?.scenarioId) return;
                setExportError(null);
                try { setExportPreview(await engine.exportPreview(current.scenarioId, current.trace, inc, paths)); } catch (err) { setExportError(err instanceof Error ? err.message : String(err)); }
              }} />
            )}
            {panel === 'runs' && (
              <div>
                <p className="small">Runs in this session. Finalized runs are immutable; forks and fault experiments always create new runs.</p>
                <ul className="plain runs">
                  {runs.map((r) => (
                    <li key={r.key} className={r.key === currentKey ? 'active' : ''}>
                      <button className="link left" onClick={() => { setCurrentKey(r.key); setSelectedSeq(null); }}>{r.key} {r.parentKey ? `<- ${r.parentKey} ` : ''}{r.label}</button>
                      <span className="muted small"> {r.trace.mode} · {r.trace.status} · {r.trace.events.length} events · {r.summary ? `${r.summary.fail} failing` : 'no checks'} · engine {r.elapsedMs.toFixed(1)} ms{r.key === baselineKey ? ' · baseline' : ''}</span>
                      {r.key !== baselineKey && r.key !== currentKey && <button className="btn ghost small" onClick={() => setBaselineKey(r.key)}>set as baseline</button>}
                    </li>
                  ))}
                </ul>
                {current && <JsonView value={current.trace} label="Raw trace JSON" filename={`${current.trace.id}.trace.json`} />}
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
