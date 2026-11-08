import type { RunRecord } from '../App';

interface Props {
  current: RunRecord | null;
  busy: boolean;
  streamed: number;
  baseline: RunRecord | null;
  correctedAvailable: boolean;
  onEvidence: (seq: number) => void;
  onRunCorrected: () => void;
  onCompare: () => void;
}

/**
 * One-line answer to "did this run behave?", with the next useful action next to it.
 * Status is always spelled out in text and a symbol, never by color alone.
 */
export function Verdict({ current, busy, streamed, baseline, correctedAvailable, onEvidence, onRunCorrected, onCompare }: Props) {
  if (busy) {
    return (
      <div className="verdict verdict-running" role="status" aria-live="polite">
        <span className="v-sym" aria-hidden="true">..</span>
        <span className="v-state">RECORDING</span>
        <span className="v-text">{streamed} event(s) so far</span>
      </div>
    );
  }
  if (!current) {
    return (
      <div className="verdict" role="status">
        <span className="v-text muted">No run yet. Press run or the r key.</span>
      </div>
    );
  }
  const { trace, summary, assertions } = current;
  const fails = assertions.filter((a) => a.status === 'fail' || a.status === 'error');
  const firstFail = fails[0];
  const execErrors = trace.executionErrors.length;
  const simulation = trace.mode === 'simulation';
  const canFix = simulation && correctedAvailable && trace.policy?.id !== 'corrected' && !trace.fork && fails.length > 0;
  const hasBaseline = !!baseline && baseline.key !== current.key;
  const baselineFailing = !!baseline?.summary && baseline.summary.fail > 0;

  let tone: 'bad' | 'ok' | 'muted' = 'muted';
  let sym = '-';
  let state = 'NOT CHECKED';
  let detail: string | null = null;
  let text = 'This trace is not linked to a shipped scenario, so no checks were evaluated.';
  if (execErrors > 0) {
    tone = 'bad'; sym = '!'; state = 'EXECUTION ERROR';
    text = `${execErrors} engine or fixture problem(s); results describe the engine, not the workflow.`;
  } else if (summary && fails.length > 0) {
    tone = 'bad'; sym = 'x'; state = 'FAILING';
    text = `${fails.length} of ${summary.total - summary.unavailable - summary.notApplicable} evaluated check(s): ${firstFail.title}.`;
    detail = firstFail.violated ? `Violated: ${firstFail.violated}.` : null;
  } else if (summary) {
    tone = 'ok'; sym = 'o'; state = 'PASSING';
    const evaluated = summary.total - summary.unavailable - summary.notApplicable;
    const skipped = summary.unavailable + summary.notApplicable;
    text = `All ${evaluated} evaluated check(s) pass${skipped ? `; ${skipped} could not be evaluated and are not counted as passes` : ''}.`;
  }

  return (
    <div className={`verdict verdict-${tone}`} role="status" aria-live="polite">
      <div className="v-main">
        <span className="v-sym" aria-hidden="true">{sym}</span>
        <span className="v-state">{state}</span>
        <span className="v-text">{text}{detail && <span className="v-detail"> {detail}</span>}</span>
      </div>
      <div className="v-actions">
        {firstFail && firstFail.evidence.eventSeqs.length > 0 && (
          <button className="btn small" onClick={() => onEvidence(firstFail.evidence.eventSeqs[0])}>evidence #{firstFail.evidence.eventSeqs[0]}</button>
        )}
        {canFix && <button className="btn small fix" onClick={onRunCorrected} title="Rerun the same faults with the corrected policy and compare the two runs">run the corrected policy</button>}
        {hasBaseline && (tone === 'bad' || baselineFailing) && (
          <button className="btn small" onClick={onCompare} title={`Compare with ${baseline!.label}`}>compare with {baselineFailing && tone !== 'bad' ? 'the failing run' : 'the baseline'}</button>
        )}
      </div>
      <p className="run-line v-meta small">
        <span className="mono">{trace.id}</span> · status <strong>{trace.status}</strong> · {trace.events.length} events · {current.label}
        {trace.parentRunId && <> · forked from <span className="mono">{trace.parentRunId}</span></>}
      </p>
    </div>
  );
}
