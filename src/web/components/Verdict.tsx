import type { ReactNode } from 'react';
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
  onChecks: () => void;
  children?: ReactNode;
}

const CHECK_SYM: Record<string, string> = { pass: 'o', fail: 'x', error: '!', unavailable: '-', 'not-applicable': '-' };

/**
 * The answer to "did this run behave?" with the next useful action beside it.
 * Status is always spelled out in text and a symbol, never by color alone.
 */
export function Verdict({ current, busy, streamed, baseline, correctedAvailable, onEvidence, onRunCorrected, onCompare, onChecks, children }: Props) {
  if (busy || !current) {
    return (
      <section className="verdict verdict-running" role="status" aria-live="polite" aria-label="Run outcome">
        <div className="v-head">
          <span className="v-state">{busy ? 'Recording' : 'No run yet'}</span>
          <span className="v-text">{busy ? `${streamed} event(s) so far` : 'Press run or the r key.'}</span>
        </div>
        {children}
      </section>
    );
  }
  const { trace, summary, assertions } = current;
  const fails = assertions.filter((a) => a.status === 'fail' || a.status === 'error');
  const firstFail = fails[0];
  const execErrors = trace.executionErrors.length;
  const canFix = trace.mode === 'simulation' && correctedAvailable && trace.policy?.id !== 'corrected' && !trace.fork && fails.length > 0;
  const hasBaseline = !!baseline && baseline.key !== current.key;
  const baselineFailing = !!baseline?.summary && baseline.summary.fail > 0;
  const evaluated = summary ? summary.total - summary.unavailable - summary.notApplicable : 0;

  let tone: 'bad' | 'ok' | 'muted' = 'muted';
  let sym = '-';
  let state = 'Not checked';
  let headline = 'This trace is not linked to a shipped scenario, so no checks were evaluated.';
  let detail: string | null = null;
  if (execErrors > 0) {
    tone = 'bad'; sym = '!'; state = 'Execution error';
    headline = `${execErrors} engine or fixture problem(s). These describe the engine, not the workflow.`;
  } else if (summary && fails.length > 0) {
    tone = 'bad'; sym = 'x'; state = 'Failing';
    headline = `${firstFail.title}.`;
    detail = `${fails.length} of ${evaluated} evaluated check(s) failed.${firstFail.violated ? ` Violated: ${firstFail.violated}.` : ''}`;
  } else if (summary) {
    tone = 'ok'; sym = 'o'; state = 'Passing';
    const skipped = summary.unavailable + summary.notApplicable;
    headline = `All ${evaluated} evaluated check(s) pass.`;
    detail = skipped ? `${skipped} could not be evaluated and are not counted as passes.` : null;
  }

  return (
    <section className={`verdict verdict-${tone}`} role="status" aria-live="polite" aria-label="Run outcome">
      <div className="v-head">
        <span className="v-state"><span className="v-sym" aria-hidden="true">{sym}</span>{state}</span>
        <div className="v-copy">
          <p className="v-text">{headline}</p>
          {detail && <p className="v-detail">{detail}</p>}
        </div>
        <div className="v-actions">
          {firstFail && firstFail.evidence.eventSeqs.length > 0 && (
            <button className="btn" onClick={() => onEvidence(firstFail.evidence.eventSeqs[0])}>evidence #{firstFail.evidence.eventSeqs[0]}</button>
          )}
          {canFix && <button className="btn fix" onClick={onRunCorrected} title="Rerun the same faults with the corrected policy and compare the two runs">run the corrected policy <span aria-hidden="true">→</span></button>}
          {hasBaseline && (tone === 'bad' || baselineFailing) && (
            <button className="btn" onClick={onCompare} title={`Compare with ${baseline!.label}`}>compare with {baselineFailing && tone !== 'bad' ? 'the failing run' : 'the baseline'}</button>
          )}
        </div>
      </div>
      {assertions.length > 0 && (
        <ul className="plain check-chips" aria-label="Checks">
          {assertions.map((a) => (
            <li key={a.assertionId}>
              <button className={`chip chip-${a.status}`} onClick={onChecks} title={a.message}>
                <span className="chip-sym" aria-hidden="true">{CHECK_SYM[a.status]}</span>
                <span className="sr-only">{a.status}: </span>{a.title}
              </button>
            </li>
          ))}
        </ul>
      )}
      {children}
      <p className="run-line">
        <span className="mono">{trace.id}</span> · status <strong>{trace.status}</strong> · {trace.events.length} events · {current.label}
        {trace.parentRunId && <> · forked from <span className="mono">{trace.parentRunId}</span></>}
      </p>
    </section>
  );
}
