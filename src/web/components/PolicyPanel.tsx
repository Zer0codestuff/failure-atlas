import { useEffect, useState } from 'react';
import { validate } from '../../engine/jsonschema';
import type { Json, Policy } from '../../engine/types';
import type { WorkflowDefinition } from '../../engine/workflow';
import { PanelHead } from './PanelHead';

/** Edit policy values with per-field documentation. Invalid values are rejected before a run starts. */
export function PolicyPanel({ workflow, policy, onApply, busy }: { workflow: WorkflowDefinition; policy: Policy; onApply: (p: Policy) => void; busy: boolean }) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  useEffect(() => {
    setDraft(Object.fromEntries(Object.entries(policy.values).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])));
  }, [policy]);
  const props = (workflow.policySchema.properties ?? {}) as Record<string, any>;
  const parsed: Record<string, Json> = {};
  const parseErrors: string[] = [];
  for (const [k, raw] of Object.entries(draft)) {
    const t = props[k]?.type;
    if (t === 'string') parsed[k] = raw;
    else {
      try { parsed[k] = JSON.parse(raw); } catch { parseErrors.push(`${k}: not valid ${t ?? 'JSON'}`); }
    }
  }
  const issues = parseErrors.length ? parseErrors : validate(workflow.policySchema, parsed).map((i) => `${i.path} ${i.message}`);
  return (
    <div className="policy panel-section">
      <PanelHead title="Policy" note={<><strong>{workflow.title}.</strong> {workflow.description}</>} />
      <div className="policy-grid">
        {Object.keys(props).map((k) => (
          <label key={k} className="policy-field">
            <span className="field-label">{k}</span>
            {props[k].type === 'boolean' ? (
              <select className="input" value={draft[k] ?? ''} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}><option value="true">true</option><option value="false">false</option></select>
            ) : props[k].enum ? (
              <select className="input" value={draft[k] ?? ''} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}>{props[k].enum.map((v: string) => <option key={v} value={v}>{v}</option>)}</select>
            ) : (
              <input className="input" value={draft[k] ?? ''} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
            )}
            <span className="muted small">{workflow.policyDocs[k] ?? ''}</span>
          </label>
        ))}
      </div>
      {issues.length > 0 && <ul className="plain error-text small" role="alert">{issues.map((i) => <li key={i}>{i}</li>)}</ul>}
      <button className="btn primary" disabled={busy || issues.length > 0} onClick={() => onApply({ ...policy, id: 'custom', label: `Custom (from ${policy.label})`, values: parsed })}>run with these values</button>
    </div>
  );
}
