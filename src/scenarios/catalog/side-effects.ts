import { callWithRetry, type WorkflowDefinition } from '../../engine/workflow';
import { check, contract, int, obj, ok, plan, policy, scenario, str, type ScenarioModule } from '../helpers';

// ---------------------------------------------------------------------------
// Lost response after a committed write (duplicate charge)
// ---------------------------------------------------------------------------

const checkoutWorkflow: WorkflowDefinition = {
  id: 'checkout-charge',
  version: '1.0.0',
  title: 'Checkout: charge an order and send a receipt',
  description: 'Loads an order, charges it through a payment tool with a bounded retry, and sends one receipt.',
  policySchema: obj(
    {
      maxAttempts: { type: 'integer', minimum: 1, maximum: 10 },
      timeoutMs: { type: 'integer', minimum: 1 },
      backoffMs: { type: 'integer', minimum: 0 },
      useIdempotencyKey: { type: 'boolean' },
    },
    ['maxAttempts', 'timeoutMs', 'backoffMs', 'useIdempotencyKey'],
    false,
  ),
  policyDocs: {
    maxAttempts: 'Maximum attempts for the charge request, including the first.',
    timeoutMs: 'Virtual milliseconds to wait for the payment response before treating it as lost.',
    backoffMs: 'Base delay before a retry; doubles per attempt.',
    useIdempotencyKey: 'Send a stable idempotency key derived from the order so the payment tool can deduplicate retries.',
  },
  *run(ctx) {
    const input = ctx.input as { orderId: string };
    const order = yield* ctx.call('orders.get', { orderId: input.orderId }, { step: 'load-order' });
    if (!order.ok) return { status: 'failed', detail: `Could not load order: ${order.error.code}` };
    const { amountCents } = order.value as { amountCents: number };
    yield* ctx.checkpoint('before-charge', 'load-order');
    const useKey = ctx.flag('useIdempotencyKey');
    const args = { orderId: input.orderId, amountCents, ...(useKey ? { idempotencyKey: `order-${input.orderId}` } : {}) };
    const charge = yield* callWithRetry(ctx, 'payments.charge', args, {
      step: 'charge',
      logicalId: `charge:${input.orderId}`,
      maxAttempts: ctx.num('maxAttempts', 1),
      backoffMs: ctx.num('backoffMs', 0),
      honorRetryAfter: true,
      timeoutMs: ctx.num('timeoutMs', 1000),
      causes: [order.seq],
    });
    if (!charge.result?.ok) {
      yield* ctx.set('checkout', { orderId: input.orderId, charged: false, attempts: charge.attempts }, 'charge', 'Recorded that the charge did not complete');
      return { status: 'failed', detail: `Charge failed after ${charge.attempts} attempt(s)` };
    }
    const chargeId = (charge.result.value as { chargeId: string }).chargeId;
    const receipt = yield* ctx.call('receipts.send', { orderId: input.orderId, chargeId }, { step: 'send-receipt', causes: [charge.result.seq] });
    yield* ctx.set('checkout', { orderId: input.orderId, charged: true, chargeId, attempts: charge.attempts, receiptSent: receipt.ok }, 'send-receipt', 'Recorded the checkout result');
    return { status: receipt.ok ? 'completed' : 'failed', detail: `Charged with ${chargeId} after ${charge.attempts} attempt(s)` };
  },
};

export const duplicateCharge: ScenarioModule = {
  workflow: checkoutWorkflow,
  scenario: scenario({
    id: 'lost-response-duplicate-charge',
    version: '1.0.0',
    title: 'Lost response after a committed charge',
    mechanism: 'Side effects and idempotency',
    summary: 'The payment tool commits a charge but its response is lost. A retry without an idempotency key charges the customer twice.',
    workflow: { id: 'checkout-charge', version: '1.0.0' },
    tools: [
      contract('orders.get', 'Read an order.', obj({ orderId: str }), obj({ orderId: str, amountCents: int })),
      contract(
        'payments.charge',
        'Charge an order. Supports an optional idempotency key.',
        obj({ orderId: str, amountCents: int, idempotencyKey: str }, ['orderId', 'amountCents'], false),
        obj({ chargeId: str, status: str }),
        { sideEffects: 'write', idempotency: { keyField: 'idempotencyKey', collection: 'charges' }, external: true },
      ),
      contract('receipts.send', 'Send a receipt for a charge.', obj({ orderId: str, chargeId: str }), obj({ receiptId: str }), { sideEffects: 'write', external: true }),
    ],
    allowedTools: ['orders.get', 'payments.charge', 'receipts.send'],
    fixtures: [
      ok('order-1001', 'orders.get', { args: { orderId: 'A-1001' } }, { orderId: 'A-1001', amountCents: 4200 }, 40),
      ok('charge-a1001', 'payments.charge', { argsFields: { orderId: 'A-1001', amountCents: 4200 } }, { chargeId: 'ch_A-1001', status: 'succeeded' }, 300, [
        { op: 'insert', collection: 'charges', record: { orderId: '{{args.orderId}}', amountCents: '{{args.amountCents}}', request: '{{request.id}}' } },
      ]),
      ok('receipt-a1001', 'receipts.send', { args: { orderId: 'A-1001', chargeId: 'ch_A-1001' } }, { receiptId: 'rc_A-1001' }, 60, [
        { op: 'insert', collection: 'receipts', record: { orderId: '{{args.orderId}}', chargeId: '{{args.chargeId}}' } },
      ]),
    ],
    triggers: [{ id: 'checkout-request', atMs: 0, payload: { orderId: 'A-1001' } }],
    policies: [
      policy('checkout-charge', 'faulty', 'Retry without idempotency key', { maxAttempts: 3, timeoutMs: 1000, backoffMs: 200, useIdempotencyKey: false }),
      policy('checkout-charge', 'corrected', 'Retry with stable idempotency key', { maxAttempts: 3, timeoutMs: 1000, backoffMs: 200, useIdempotencyKey: true }),
    ],
    faultPresets: [
      plan('lost-response', 'Response lost after commit', 'The first charge commits, then its response never reaches the workflow.', [
        { id: 'drop-first-charge-response', description: 'Drop the response of the first committed charge', point: 'after-tool-commit', target: { tool: 'payments.charge', occurrences: [1] }, effect: { type: 'drop-response' } },
      ]),
      plan('slow-response', 'Response slower than the timeout', 'The first charge response is delayed past the workflow timeout and arrives late.', [
        { id: 'delay-first-charge-response', description: 'Delay the first charge response by 1500 ms', point: 'before-response', target: { tool: 'payments.charge', occurrences: [1] }, effect: { type: 'delay', ms: 1500 } },
      ]),
    ],
    assertions: [
      check('one-charge-per-order', 'idempotency', 'At most one charge per order', { collection: 'charges', key: ['orderId'] }),
      check('one-receipt-per-order', 'idempotency', 'At most one receipt per order', { collection: 'receipts', key: ['orderId'] }),
      check('charge-retry-bound', 'retry-bound', 'Charge attempts stay within the declared bound', { tool: 'payments.charge', max: 3 }),
      check('checkout-completes', 'completion', 'Checkout completes', { runStatus: ['completed'], outcomeStatus: ['completed'] }),
      check('charge-contract', 'tool-schema', 'Charge requests and responses match the contract', { tool: 'payments.charge' }),
      check('no-exec-errors', 'no-execution-errors', 'No engine or fixture errors'),
    ],
    checkpoints: ['before-charge'],
    limits: { maxSteps: 500, maxVirtualMs: 60_000 },
    seed: 7,
    notes: ['The payment tool is a local fixture. Nothing is charged.', 'Idempotency is modeled server-side in the simulated state store, so duplicates are detected from records rather than from text.'],
  }),
};

// ---------------------------------------------------------------------------
// Duplicate trigger event
// ---------------------------------------------------------------------------

const jobWorkflow: WorkflowDefinition = {
  id: 'job-processor',
  version: '1.0.0',
  title: 'Event-driven report job',
  description: 'Handles a job event: generates a report, then notifies the owner.',
  policySchema: obj({ dedupeEvents: { type: 'boolean' } }, ['dedupeEvents'], false),
  policyDocs: { dedupeEvents: 'Keep a ledger of completed event IDs and skip a delivery whose event already completed.' },
  *run(ctx) {
    const evt = ctx.input as { eventId: string; jobId: string };
    if (ctx.flag('dedupeEvents')) {
      const done = yield* ctx.get(`completedEvents.${evt.eventId}`);
      yield* ctx.emit('check', 'dedupe', done ? `Event ${evt.eventId} already completed; skipping` : `Event ${evt.eventId} not seen before`, { eventId: evt.eventId, duplicate: Boolean(done) });
      if (done) return { status: 'skipped', detail: `Duplicate delivery of ${evt.eventId}` };
    }
    const report = yield* ctx.call('reports.generate', { jobId: evt.jobId }, { step: 'generate-report' });
    if (!report.ok) return { status: 'failed', detail: report.error.code };
    const reportId = (report.value as { reportId: string }).reportId;
    const note = yield* ctx.call('notify.send', { jobId: evt.jobId, reportId }, { step: 'notify', causes: [report.seq] });
    if (!note.ok) return { status: 'failed', detail: note.error.code };
    if (ctx.flag('dedupeEvents')) yield* ctx.set(`completedEvents.${evt.eventId}`, { jobId: evt.jobId, reportId }, 'record-completion', `Recorded ${evt.eventId} as completed`, [note.seq]);
    return { status: 'completed', detail: `Report ${reportId} delivered` };
  },
};

export const duplicateTrigger: ScenarioModule = {
  workflow: jobWorkflow,
  scenario: scenario({
    id: 'duplicate-trigger-event',
    version: '1.0.0',
    title: 'Duplicate trigger delivery',
    mechanism: 'Side effects and idempotency',
    summary: 'An at-least-once event source delivers the same job event twice. Without an event ledger the job runs twice.',
    workflow: { id: 'job-processor', version: '1.0.0' },
    tools: [
      contract('reports.generate', 'Generate a report for a job.', obj({ jobId: str }), obj({ reportId: str }), { sideEffects: 'write' }),
      contract('notify.send', 'Notify the job owner.', obj({ jobId: str, reportId: str }), obj({ delivered: { type: 'boolean' } }), { sideEffects: 'write', external: true }),
    ],
    allowedTools: ['reports.generate', 'notify.send'],
    fixtures: [
      ok('report-job7', 'reports.generate', { args: { jobId: 'job-7' } }, { reportId: 'rep-job-7' }, 800, [{ op: 'insert', collection: 'reports', record: { jobId: '{{args.jobId}}', request: '{{request.id}}' } }]),
      ok('notify-job7', 'notify.send', { args: { jobId: 'job-7', reportId: 'rep-job-7' } }, { delivered: true }, 100, [{ op: 'insert', collection: 'notifications', record: { jobId: '{{args.jobId}}' } }]),
    ],
    triggers: [{ id: 'job-event', atMs: 0, payload: { eventId: 'evt-42', jobId: 'job-7' } }],
    policies: [
      policy('job-processor', 'faulty', 'Process every delivery', { dedupeEvents: false }),
      policy('job-processor', 'corrected', 'Skip completed event IDs', { dedupeEvents: true }),
    ],
    faultPresets: [
      plan('redelivery', 'Event redelivered', 'The event source delivers evt-42 a second time 3 seconds later.', [
        { id: 'redeliver-evt-42', description: 'Deliver the job event again', point: 'trigger-delivery', target: { triggerId: 'job-event' }, effect: { type: 'duplicate', delayMs: 3000 } },
      ]),
    ],
    assertions: [
      check('one-report-per-job', 'idempotency', 'One report per job', { collection: 'reports', key: ['jobId'] }),
      check('one-notification-per-job', 'idempotency', 'One notification per job', { collection: 'notifications', key: ['jobId'] }),
      check('job-completes', 'completion', 'Every delivery ends completed or skipped', { runStatus: ['completed'], outcomeStatus: ['completed', 'skipped'] }),
      check('no-exec-errors', 'no-execution-errors', 'No engine or fixture errors'),
    ],
    checkpoints: [],
    limits: { maxSteps: 500, maxVirtualMs: 60_000 },
    seed: 11,
    notes: ['Event ordering is fixed by the virtual clock: the redelivery arrives after the first run completed.'],
  }),
};
