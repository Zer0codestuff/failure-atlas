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
import { PanelHead } from './components/PanelHead';
import { TraceStrip } from './components/TraceStrip';
import { Verdict } from './components/Verdict';
import { EngineClient, EngineError } from './engine-client';
import type { ExportPreview, ImportResult, RunResult } from './protocol';

export interface RunRecord {
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

type View = 'timeline' | 'checks' | 'compare' | 'graph' | 'policy' | 'state' | 'export' | 'runs';

const VIEWS: Array<{ id: View; label: string }> = [
  { id: 'timeline', label: 'Timeline' },
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
const pad2 = (n: number) => String(n).padStart(2, '0');

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
  const initialView = params.get('panel') as View | null;
  const [view, setView] = useState<View>(initialView && VIEWS.some((v) => v.id === initialView) ? initialView : 'timeline');
  const [mobileInspector, setMobileInspector] = useState(false);
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

  // Rerun the same faults with the corrected policy, keep the failing run as baseline, open the comparison.
  const runCorrected = useCallback(async () => {
    const corrected = scenario.policies.find((p) => p.id === 'corrected');
    if (!corrected || !current) return;
    const faults = current.trace.faultPlan ?? null;
    const failingKey = current.key;
    setCustomPolicy(null);
    setPolicyId('corrected');
    const key = await execute({ scenarioId: scenario.id, policy: corrected, plan: faults });
    if (key) { setBaselineKey(failingKey); setView('compare'); setMobileInspector(false); setTimeout(() => document.querySelector('.workspace')?.scrollIntoView({ block: 'start' }), 0); }
  }, [scenario, current, execute]);

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
    setPresetId(m.scenario.faultPresets[0]?.id ?? 'none');
    setCustomPolicy(null);
    setCustomPlan(null);
    setRailOpen(false);
    setQuery('');
    setNotice(null);
    setView('timeline');
    setMobileInspector(false);
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') {
        if (e.key === 'Escape') t.blur();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '/') { e.preventDefault(); setView('timeline'); setTimeout(() => document.getElementById('tl-search')?.focus(), 0); }
      else if (e.key === 'r' && !busy) { e.preventDefault(); void runCurrent(); }
      else if (e.key === 't') { setView('timeline'); setTimeout(() => document.querySelector<HTMLElement>('.timeline-scroll')?.focus(), 0); }
      else if (/^[1-8]$/.test(e.key)) { setView(VIEWS[Number(e.key) - 1].id); setMobileInspector(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, runCurrent]);

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
  const groupIndex = grouped.findIndex(([, ms]) => ms.some((m) => m.scenario.id === scenario.id));

  const selectEvent = (seq: number) => { setSelectedSeq(seq); setMobileInspector(true); };
  const revealWorkspace = () => setTimeout(() => document.querySelector('.workspace')?.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' }), 0);
  const openView = (v: View) => { setView(v); setMobileInspector(false); };
  const failCount = current?.summary?.fail ?? 0;

  return (
    <div className="app">
      <header className="topbar">
        <button className="btn icon rail-toggle" aria-expanded={railOpen} aria-controls="scenario-rail" onClick={() => setRailOpen(!railOpen)} aria-label="Scenarios">
          <span aria-hidden="true">{railOpen ? 'x' : '='}</span>
        </button>
        <a className="brand" href="./" aria-label="Failure Atlas home">
          <span className="brand-mark" aria-hidden="true">FA</span>
          <span className="brand-name">Failure Atlas</span>
        </a>
        <span className={`mode-chip mode-${mode}`} title={current?.trace.capabilities.reasons.join(' ') ?? ''}>
          <span className="dot" aria-hidden="true" />
          {mode === 'simulation' ? 'Simulation' : mode === 'playback' ? 'Playback' : 'Live recording'}
          <span className="mode-detail">{mode === 'simulation' ? ' · fixtures · virtual time · reproducible' : mode === 'playback' ? ' · recorded · not re-executable' : ' · not reproducible'}</span>
        </span>
        <div className="top-actions">
          <label className="toggle" title="Deliver recorded events gradually so they can be watched. Off when reduced motion is requested.">
            <input type="checkbox" checked={paced} onChange={(e) => setPaced(e.target.checked)} />
            <span className="toggle-track" aria-hidden="true" />
            <span className="toggle-label">paced</span>
          </label>
          <button className="btn" onClick={() => fileInput.current?.click()} title="Import a trace, bundle or OTLP/JSON file, or drop it on the page">import <span aria-hidden="true">↑</span></button>
          <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void onImportFile(f); e.target.value = ''; }} />
        </div>
      </header>

      <div className="shell">
        <nav id="scenario-rail" className={`rail${railOpen ? ' open' : ''}`} aria-label="Scenarios">
          <p className="eyebrow rail-eyebrow">{pad2(SCENARIOS.length)} / scenarios</p>
          {grouped.map(([mech, ms], gi) => (
            <section key={mech} className="rail-section">
              <h2 className="rail-group"><span className="rail-num">{pad2(gi + 1)}</span> {mech}</h2>
              <ul className="plain">
                {ms.map((m) => {
                  const last = lastByScenario.get(m.scenario.id);
                  const fails = last?.summary?.fail ?? 0;
                  const active = m.scenario.id === scenario.id;
                  const state = !last ? 'idle' : fails ? 'bad' : 'ok';
                  return (
                    <li key={m.scenario.id}>
                      <button className={`rail-item${active ? ' active' : ''}`} aria-current={active ? 'true' : undefined} onClick={() => selectScenario(m.scenario.id)}>
                        <span className={`rail-dot ${state}`} aria-hidden="true" />
                        <span className="rail-title">{m.scenario.title}</span>
                        {last && <span className={`rail-status ${state}`}>{fails ? `${fails} failing` : 'all evaluated pass'}</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
          <div className="rail-foot">
            <p className="eyebrow">keys</p>
            <dl className="keys">
              <dt>r</dt><dd>run</dd><dt>/</dt><dd>search</dd><dt>t</dt><dd>timeline</dd><dt>j k</dt><dd>move</dd><dt>1-8</dt><dd>views</dd>
            </dl>
            <p className="muted small">All scenarios are synthetic and run on local fixtures. Nothing leaves this browser.</p>
          </div>
        </nav>
        {railOpen && <button className="scrim" aria-label="Close scenarios" onClick={() => setRailOpen(false)} />}

        <main className="main">
          <section className="hero" aria-labelledby="scen-title">
            <div className="hero-text">
              <p className="eyebrow">{pad2(groupIndex + 1)} / {scenario.mechanism}</p>
              <h1 id="scen-title" className="scen-title">{scenario.title}</h1>
              <p className="scen-sum">{scenario.summary}</p>
            </div>
            <div className="run-card" role="group" aria-label="Run configuration">
              <label className="field" htmlFor="sel-policy">
                <span className="field-label">policy</span>
                <select id="sel-policy" className="input" value={customPolicy ? 'custom' : policyId} onChange={(e) => { setCustomPolicy(null); setPolicyId(e.target.value); }}>
                  {scenario.policies.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                  {customPolicy && <option value="custom">{customPolicy.label}</option>}
                </select>
              </label>
              <label className="field" htmlFor="sel-faults">
                <span className="field-label">faults</span>
                <select id="sel-faults" className="input" value={presetId} onChange={(e) => { setCustomPlan(null); setPresetId(e.target.value); }}>
                  <option value="none">none</option>
                  {scenario.faultPresets.map((f) => <option key={f.id} value={f.id}>{f.title}</option>)}
                  {customPlan && <option value="custom">{customPlan.title}</option>}
                </select>
              </label>
              <button className="btn primary run-btn" onClick={() => void runCurrent()} disabled={busy} title="Run (r)">{busy ? 'running…' : 'run'} <span aria-hidden="true">{busy ? '' : '→'}</span></button>
            </div>
          </section>

          <Verdict
            current={busy ? null : current}
            busy={busy}
            streamed={streaming?.length ?? 0}
            baseline={baseline}
            correctedAvailable={scenario.policies.some((p) => p.id === 'corrected')}
            onEvidence={(seq) => { setView('timeline'); selectEvent(seq); revealWorkspace(); }}
            onRunCorrected={runCorrected}
            onCompare={() => { openView('compare'); revealWorkspace(); }}
            onChecks={() => { openView('checks'); revealWorkspace(); }}
          >
            <TraceStrip events={shownEvents} marks={marks} selectedSeq={selectedSeq} onSelect={(s) => { setView('timeline'); setSelectedSeq(s); }} />
          </Verdict>

          {error && (
            <div className="notice bad" role="alert">
              <div><strong>{error.message}</strong>
                {error.issues.length > 0 && <ul className="plain small">{error.issues.map((i) => <li key={i}>{i}</li>)}</ul>}
              </div>
              <button className="btn ghost" onClick={() => setError(null)}>dismiss</button>
            </div>
          )}
          {notice && <div className="notice" role="status"><div>{notice}</div><button className="btn ghost" onClick={() => setNotice(null)}>dismiss</button></div>}

          <section className={`workspace${mobileInspector ? ' show-inspector' : ''}`} aria-label="Workspace">
            <div className="tabs" role="tablist" aria-label="Views">
              {VIEWS.map((v, i) => (
                <button key={v.id} role="tab" aria-selected={view === v.id && !mobileInspector} className={`tab${view === v.id ? ' active' : ''}`} onClick={() => openView(v.id)} title={`${v.label} (${i + 1})`}>
                  <span className="tab-label">{v.label}</span>
                  <span className="tab-key" aria-hidden="true">[{i + 1}]</span>
                  {v.id === 'checks' && failCount > 0 && <span className="badge bad">{failCount}</span>}
                  {v.id === 'compare' && comparison?.firstDivergence && <span className="badge">◆</span>}
                </button>
              ))}
              <button role="tab" aria-selected={mobileInspector} className={`tab mobile-only${mobileInspector ? ' active' : ''}`} onClick={() => setMobileInspector(true)}>
                <span className="tab-label">Inspector</span>
              </button>
            </div>
            <div className="work">
              <div className="pane-view" role="tabpanel">
                {view === 'timeline' && <Timeline events={shownEvents} selectedSeq={selectedSeq} onSelect={setSelectedSeq} marks={marks} query={query} onQuery={setQuery} kindFilter={kindFilter} onKindFilter={setKindFilter} running={busy} onOpen={selectEvent} />}
                {view !== 'timeline' && (
                  <div className="panel-body">
                    {view === 'checks' && <Checks trace={current?.trace ?? null} assertions={current?.assertions ?? []} summary={current?.summary ?? null} onSelect={selectEvent} />}
                    {view === 'compare' && (
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
                    {view === 'graph' && <Graph graph={graph} selectedSeq={selectedSeq} onSelect={selectEvent} />}
                    {view === 'policy' && <PolicyPanel workflow={mod.workflow} policy={policy} busy={busy} onApply={(p) => { setCustomPolicy(p); void execute({ scenarioId: scenario.id, policy: p, plan }); }} />}
                    {view === 'state' && (current?.trace.finalState ? (
                      <div className="panel-section">
                        <PanelHead title="Final state" note={<>Assertions read this store, not workflow text output. Hash <span className="mono">{current.trace.hashes.state?.slice(0, 16)}</span>.</>} />
                        <pre className="json">{JSON.stringify(current.trace.finalState, null, 2)}</pre>
                      </div>
                    ) : <p className="empty">{current ? 'This trace carries no state. Playback traces record events only.' : 'No run yet.'}</p>)}
                    {view === 'export' && (
                      <Export trace={current?.trace ?? null} preview={exportPreview} error={exportError} onPreview={async (inc, paths) => {
                        if (!current?.scenarioId) return;
                        setExportError(null);
                        try { setExportPreview(await engine.exportPreview(current.scenarioId, current.trace, inc, paths)); } catch (err) { setExportError(err instanceof Error ? err.message : String(err)); }
                      }} />
                    )}
                    {view === 'runs' && (
                      <div className="panel-section">
                        <PanelHead title="Runs in this session" note="Finalized runs are immutable; forks and fault experiments always create new runs." />
                        <ul className="plain runs">
                          {runs.map((r) => {
                            const state = !r.summary ? 'idle' : r.summary.fail ? 'bad' : 'ok';
                            return (
                              <li key={r.key} className={r.key === currentKey ? 'active' : ''}>
                                <span className={`rail-dot ${state}`} aria-hidden="true" />
                                <div className="run-main">
                                  <button className="link left" onClick={() => { setCurrentKey(r.key); setSelectedSeq(null); }}><span className="mono muted">{r.key}</span> {r.parentKey ? `<- ${r.parentKey} ` : ''}{r.label}</button>
                                  <span className="muted small">{r.trace.mode} · {r.trace.status} · {r.trace.events.length} events · {r.summary ? `${r.summary.fail} failing` : 'no checks'} · engine {r.elapsedMs.toFixed(1)} ms{r.key === baselineKey ? ' · baseline' : ''}</span>
                                </div>
                                {r.key !== baselineKey && r.key !== currentKey && <button className="btn small" onClick={() => setBaselineKey(r.key)}>set as baseline</button>}
                              </li>
                            );
                          })}
                        </ul>
                        {current && <JsonView value={current.trace} label="Raw trace JSON" filename={`${current.trace.id}.trace.json`} />}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div className="pane-inspector">
                <Inspector trace={current && !busy ? current.trace : null} event={busy ? null : selectedEvent} scenario={current?.scenarioId ? getScenario(current.scenarioId)?.scenario ?? null : null} assertions={current?.assertions ?? []} onSelect={setSelectedSeq} onInjectFault={onInjectFault} onFork={onFork} busy={busy} onBack={() => setMobileInspector(false)} />
              </div>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
