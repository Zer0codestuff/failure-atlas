import type { TraceEvent } from '../engine/types';

/** Status glyphs: every state is shown as text and a symbol, never color alone. */
export function glyph(e: TraceEvent): { sym: string; tone: 'ok' | 'bad' | 'warn' | 'muted' | 'plain'; label: string } {
  switch (e.kind) {
    case 'tool.response': return { sym: '<-', tone: 'ok', label: 'response' };
    case 'tool.request': return { sym: '->', tone: 'plain', label: 'request' };
    case 'tool.error': return { sym: 'x', tone: 'bad', label: 'error' };
    case 'tool.response.late': return { sym: '..', tone: 'warn', label: 'late' };
    case 'tool.dedup': return { sym: '=', tone: 'ok', label: 'deduplicated' };
    case 'state.changed': return { sym: '*', tone: 'plain', label: 'state' };
    case 'fault.injected': return { sym: '!', tone: 'bad', label: 'fault' };
    case 'retry.scheduled': return { sym: '~', tone: 'warn', label: 'retry' };
    case 'sleep': return { sym: 'z', tone: 'muted', label: 'wait' };
    case 'checkpoint': return { sym: '@', tone: 'ok', label: 'checkpoint' };
    case 'cancel.requested': return { sym: '/', tone: 'bad', label: 'cancel' };
    case 'cancel.observed': return { sym: '/', tone: 'ok', label: 'cancel seen' };
    case 'boundary.blocked': return { sym: '#', tone: 'bad', label: 'blocked' };
    case 'check': return { sym: '?', tone: 'plain', label: 'check' };
    case 'decision': return { sym: '>', tone: 'plain', label: 'decision' };
    case 'limit.exhausted': return { sym: 'X', tone: 'bad', label: 'limit' };
    case 'fixture.miss':
    case 'fixture.ambiguous': return { sym: 'X', tone: 'bad', label: 'fixture' };
    case 'trigger.received': return { sym: '>>', tone: 'plain', label: 'trigger' };
    case 'task.spawned': return { sym: '+', tone: 'muted', label: 'task' };
    case 'task.joined': return { sym: '|', tone: 'muted', label: 'join' };
    case 'model.request': return { sym: 'm>', tone: 'plain', label: 'model' };
    case 'model.response': return { sym: '<m', tone: 'plain', label: 'model' };
    case 'run.started':
    case 'run.finished': return { sym: '::', tone: 'muted', label: 'run' };
    default: return { sym: '.', tone: 'muted', label: e.kind };
  }
}

/** A plain-language explanation of what the event means for the workflow. */
export function explain(e: TraceEvent): string {
  const d = (e.data ?? {}) as any;
  const tool = e.tool ? `the ${e.tool} tool` : 'a tool';
  switch (e.kind) {
    case 'run.started': return 'The runner started a new run. In simulation mode every tool is a local fixture and time is virtual, so the run is reproducible.';
    case 'run.finished': return `The run ended with status "${d.status}". ${d.executionErrors ? `${d.executionErrors} execution error(s) were recorded.` : 'No execution errors were recorded.'}`;
    case 'trigger.received': return d.delivery > 1 ? `The same trigger arrived again (delivery ${d.delivery}). A workflow that does not remember completed events will repeat its work.` : 'An incoming event started the workflow.';
    case 'tool.request': return `The workflow asked ${tool} to act${e.attempt && e.attempt > 1 ? `, attempt ${e.attempt} of the same logical request ${e.logicalId}` : ''}.${d.idempotencyKey ? ` It sent idempotency key ${d.idempotencyKey}, so the tool can recognize a repeat.` : e.attempt && e.attempt > 1 ? ' No idempotency key was sent, so the tool cannot tell this is a repeat.' : ''}`;
    case 'tool.response': return `${tool[0].toUpperCase()}${tool.slice(1)} answered${d.latencyMs !== undefined ? ` after ${d.latencyMs} ms of virtual time` : ''}.${Array.isArray(d.contractIssues) && d.contractIssues.length ? ' The answer does not match the tool contract: ' + d.contractIssues.map((i: any) => `${i.path} ${i.message}`).join('; ') + '.' : ''}`;
    case 'tool.error': return d.error?.code === 'TIMEOUT' ? `The workflow stopped waiting for ${tool}. A timeout does not say whether the tool acted; the tool may still have committed its side effect.` : `${tool[0].toUpperCase()}${tool.slice(1)} returned error ${d.error?.code}${d.error?.retryAfterMs !== undefined ? ` and asked the caller to wait ${d.error.retryAfterMs} ms before retrying` : ''}.${d.executed === false ? ' The tool did not execute.' : ''}`;
    case 'tool.response.late': return `${tool[0].toUpperCase()}${tool.slice(1)} answered after the workflow had already given up. The work it describes did happen.`;
    case 'tool.dedup': return `${tool[0].toUpperCase()}${tool.slice(1)} recognized the idempotency key and returned the earlier result instead of acting twice.`;
    case 'state.changed': return d.scope === 'external' ? `A simulated side effect was committed: ${d.op === 'insert' ? `a record was added to ${d.collection} (now ${d.size})` : `${d.key} was set`}. Assertions read this state store, not text output.` : `The workflow updated its own state at ${d.path}.`;
    case 'fault.injected': return `An explicit fault fired at ${d.point}: ${e.summary.replace(/^Fault [^:]+: /, '')}. Faults are declared in the fault plan; nothing random happened.`;
    case 'retry.scheduled': return `The workflow decided to retry after ${d.reason} and will wait ${d.delayMs} ms${d.retryAfterMs !== null && d.retryAfterMs !== undefined ? ` (the tool asked for ${d.retryAfterMs} ms)` : ''}.`;
    case 'sleep': return `The workflow waits ${d.ms} ms of virtual time. No real time passes.`;
    case 'checkpoint': return 'The workflow reached a declared checkpoint. The runner can fork a new run from here by replaying to this point, verifying the prefix, and applying a different policy or fault plan.';
    case 'cancel.requested': return 'Someone requested cancellation. Calls already in flight may finish, but no new work should start.';
    case 'cancel.observed': return 'The workflow checked the cancellation flag and stopped starting new work.';
    case 'boundary.blocked': return `The local policy boundary blocked ${tool}: it is not on the allowlist for this task. The attempt is recorded and nothing was executed.`;
    case 'check': return `The workflow ran its own check: ${e.summary}.`;
    case 'decision': return `The workflow made a decision: ${e.summary}.`;
    case 'limit.exhausted': return e.origin === 'engine' ? 'The engine stopped the run at its safety limit. The workflow never recorded what was left unresolved.' : 'The workflow reached its declared limit and recorded the unresolved state.';
    case 'fixture.miss': return 'No recorded fixture matches this request (tool, canonical arguments, state and occurrence). The runner refuses to guess and records an execution error.';
    case 'fixture.ambiguous': return 'More than one fixture matches equally well. The runner refuses to pick one and records an execution error.';
    case 'task.spawned': return 'A workflow task started. Parallel branches are scheduled deterministically by virtual time, then by branch order.';
    case 'task.joined': return 'All parallel branches finished and the parent task continues.';
    case 'model.request': return 'A request was sent to a model. In a live run this left the machine; in an imported trace it was recorded elsewhere.';
    case 'model.response': return 'A model response was recorded. It is evidence of what happened once, not of what would happen again.';
    default: return e.summary;
  }
}
