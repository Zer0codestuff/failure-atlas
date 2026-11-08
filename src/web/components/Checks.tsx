import type { AssertionSummary, EvaluatedAssertion } from '../../engine/assertions';
import type { Trace } from '../../engine/types';
import { PanelHead } from './PanelHead';

const SYM: Record<string, string> = { pass: '[pass]', fail: '[FAIL]', error: '[error]', unavailable: '[unavailable]', 'not-applicable': '[n/a]' };
const ORDER: Record<string, number> = { fail: 0, error: 1, unavailable: 2, 'not-applicable': 3, pass: 4 };

export function Checks({ trace, assertions, summary, onSelect }: { trace: Trace | null; assertions: EvaluatedAssertion[]; summary: AssertionSummary | null; onSelect: (seq: number) => void }) {
  if (!trace) return <p className="empty">No run yet.</p>;
  if (!summary) return <p className="empty">This trace is not linked to a shipped scenario, so no assertions were evaluated.</p>;
  const sorted = [...assertions].sort((a, b) => ORDER[a.status] - ORDER[b.status]);
  return (
    <div className="checks panel-section">
      <PanelHead title="Checks" note={summary.statement} />
      {trace.executionErrors.length > 0 && (
        <div className="notice bad" role="alert">
          <strong>Execution errors</strong> (engine or fixture problems, not workflow behavior):
          <ul className="plain">{trace.executionErrors.map((e, i) => <li key={i}>{e.code}: {e.message}{e.seq ? <> <button className="link" onClick={() => onSelect(e.seq!)}>#{e.seq}</button></> : null}</li>)}</ul>
        </div>
      )}
      <ul className="plain check-list">
        {sorted.map((a) => (
          <li key={a.assertionId} className={`check check-${a.status}`}>
            <div className="check-head"><span className="sym">{SYM[a.status]}</span> <span className="check-title">{a.title}</span> <span className="check-kind">{a.kind}</span></div>
            <div className="check-msg">{a.message}</div>
            {a.violated && <div className="check-violated">violated: {a.violated}</div>}
            {(a.evidence.eventSeqs.length > 0 || a.evidence.statePaths.length > 0) && (
              <div className="check-evidence small">
                evidence:{' '}
                {a.evidence.eventSeqs.slice(0, 24).map((s) => <button key={s} className="link" onClick={() => onSelect(s)}>#{s}</button>)}
                {a.evidence.eventSeqs.length > 24 && <span className="muted"> +{a.evidence.eventSeqs.length - 24}</span>}
                {a.evidence.statePaths.map((p) => <code key={p} className="path">{p}</code>)}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
