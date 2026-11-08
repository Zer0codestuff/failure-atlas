import { useState } from 'react';
import type { Trace } from '../../engine/types';
import type { ExportPreview } from '../protocol';
import { PanelHead } from './PanelHead';
import { download } from './JsonView';

interface Props {
  trace: Trace | null;
  preview: ExportPreview | null;
  error: string | null;
  onPreview: (includeTrace: boolean, userPaths: string[]) => void;
}

export function Export({ trace, preview, error, onPreview }: Props) {
  const [includeTrace, setIncludeTrace] = useState(true);
  const [paths, setPaths] = useState('');
  if (!trace) return <p className="empty">No run yet.</p>;
  if (trace.mode !== 'simulation') {
    return (
      <div className="export panel-section">
        <PanelHead title="Export" />
        <p className="notice">Regression bundles need a deterministic simulation run. This {trace.mode} trace can be downloaded as recorded, but it cannot be re-executed.</p>
        <button className="btn" onClick={() => download(`${trace.id}.trace.json`, JSON.stringify(trace, null, 2))}>download trace JSON</button>
      </div>
    );
  }
  const userPaths = paths.split(',').map((p) => p.trim()).filter(Boolean);
  return (
    <div className="export panel-section">
      <PanelHead title="Regression bundle" />
      <p className="panel-note">A regression bundle carries the scenario, contracts, fixtures, policy, fault plan, seed, engine and schema versions, expected hashes and assertion outcomes. <code>failure-atlas verify bundle.json</code> re-executes it and exits non-zero on any difference.</p>
      {trace.fork && <p className="notice">Forked runs cannot be bundled yet; bundles describe one full run configuration. Rerun the fork's policy and fault plan from the start, then export.</p>}
      <div className="form">
        <label className="inline"><input type="checkbox" checked={includeTrace} onChange={(e) => setIncludeTrace(e.target.checked)} /> include a copy of the source trace</label>
        <label>extra paths to redact (comma separated, * matches any key or index)
          <input className="input" placeholder="events.*.data.args.email" value={paths} onChange={(e) => setPaths(e.target.value)} />
        </label>
        <button className="btn" disabled={!!trace.fork} onClick={() => onPreview(includeTrace, userPaths)}>preview redaction</button>
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}
      {preview && (
        <section className="preview" aria-label="Redaction preview">
          <h3>What will leave this machine</h3>
          <p className="small">{preview.bytes.toLocaleString()} bytes · integrity sha256 {preview.bundle.integrity.hash.slice(0, 16)} · {preview.bundle.expected.assertions.length} expected assertion outcomes</p>
          {preview.findings.length ? (
            <ul className="plain small mono">{preview.findings.map((f, i) => <li key={i}>[redact] {f.path} <span className="muted">({f.rule})</span> {f.preview}</li>)}</ul>
          ) : <p className="small">No value in the trace copy matched a redaction rule.</p>}
          {preview.scenarioWarnings.length > 0 && (
            <div className="notice bad small">The scenario itself contains values that look sensitive. They are not redacted because re-execution needs them; remove them from the scenario before sharing:
              <ul className="plain">{preview.scenarioWarnings.map((f, i) => <li key={i}>{f.path} ({f.rule})</li>)}</ul>
            </div>
          )}
          <p className="small muted">{preview.disclaimer}</p>
          <button className="btn primary" onClick={() => download(`${preview.bundle.scenario.id}.${preview.bundle.run.policy.id}.bundle.json`, preview.text)}>download bundle</button>
        </section>
      )}
    </div>
  );
}
