import { callWithRetry, type WorkflowDefinition } from '../../engine/workflow';
import { check, contract, int, num, obj, ok, plan, policy, scenario, str, type ScenarioModule } from '../helpers';

const retryPolicySchema = obj(
  {
    maxAttempts: { type: 'integer', minimum: 1, maximum: 1000 },
    backoffMs: { type: 'integer', minimum: 0 },
    honorRetryAfter: { type: 'boolean' },
    timeoutMs: { type: 'integer', minimum: 1 },
  },
  ['maxAttempts', 'backoffMs', 'honorRetryAfter', 'timeoutMs'],
  false,
);
const retryPolicyDocs = {
  maxAttempts: 'Maximum attempts including the first one.',
  backoffMs: 'Base delay before a retry; doubles per attempt.',
  honorRetryAfter: 'Wait at least the server-provided retry delay before retrying.',
  timeoutMs: 'Virtual milliseconds before a call is treated as timed out.',
};

// ---------------------------------------------------------------------------
// 1. Rate limit with a retry delay
// ---------------------------------------------------------------------------

const fetchWorkflow: WorkflowDefinition = {
  id: 'fetch-with-retry',
  version: '1.0.0',
  title: 'Fetch an observation with retries',
  description: 'Fetches a weather observation and stores it. Retries on rate limits.',
  policySchema: retryPolicySchema,
  policyDocs: retryPolicyDocs,
  *run(ctx) {
    const { city } = ctx.input as { city: string };
    const r = yield* callWithRetry(ctx, 'weather.fetch', { city }, {
      step: 'fetch-observation',
      logicalId: `observation:${city}`,
      maxAttempts: ctx.num('maxAttempts', 1),
      backoffMs: ctx.num('backoffMs', 0),
      honorRetryAfter: ctx.flag('honorRetryAfter'),
      timeoutMs: ctx.num('timeoutMs', 1000),
    });
    if (!r.result?.ok) {
      yield* ctx.set('observation', { city, available: false, attempts: r.attempts }, 'store', 'Recorded that the observation is unavailable');
      return { status: 'failed', detail: `Gave up after ${r.attempts} attempt(s)` };
    }
    yield* ctx.set('observation', { ...(r.result.value as object), attempts: r.attempts }, 'store', 'Stored the observation', [r.result.seq]);
    return { status: 'completed', detail: `Fetched after ${r.attempts} attempt(s)` };
  },
};

export const rateLimit: ScenarioModule = {
  workflow: fetchWorkflow,
  scenario: scenario({
    id: 'rate-limit-retry-after',
    version: '1.0.0',
    title: 'Rate limit with a retry delay',
    mechanism: 'Retries and time',
    summary: 'A rate-limited tool returns a retry delay of 2 seconds. Retrying sooner keeps hitting the limit until attempts run out.',
    workflow: { id: 'fetch-with-retry', version: '1.0.0' },
    tools: [contract('weather.fetch', 'Fetch the latest observation for a city.', obj({ city: str }), obj({ city: str, tempC: num, observedAtMs: int }))],
    allowedTools: ['weather.fetch'],
    fixtures: [ok('obs-turin', 'weather.fetch', { args: { city: 'Turin' } }, { city: 'Turin', tempC: 14.5, observedAtMs: 0 }, 80)],
    triggers: [{ id: 'refresh', atMs: 0, payload: { city: 'Turin' } }],
    policies: [
      policy('fetch-with-retry', 'faulty', 'Fixed backoff, ignores retry delay', { maxAttempts: 5, backoffMs: 100, honorRetryAfter: false, timeoutMs: 1000 }),
      policy('fetch-with-retry', 'corrected', 'Honors the retry delay', { maxAttempts: 5, backoffMs: 100, honorRetryAfter: true, timeoutMs: 1000 }),
    ],
    faultPresets: [
      plan('rate-limited-window', 'Rate limit for 2 seconds', 'Every request before 2005 ms is rejected with RATE_LIMITED and retryAfterMs 2000.', [
        { id: 'rate-limit', description: 'Reject requests during the rate-limit window', point: 'before-request', target: { tool: 'weather.fetch', beforeMs: 2005 }, effect: { type: 'error', code: 'RATE_LIMITED', message: 'Too many requests', retryAfterMs: 2000 } },
      ]),
    ],
    assertions: [
      check('retry-after', 'retry-after-honored', 'Retries wait for the server-provided delay', { tool: 'weather.fetch' }),
      check('retry-bound', 'retry-bound', 'Attempts stay within 5', { tool: 'weather.fetch', max: 5 }),
      check('fetch-completes', 'completion', 'The observation is fetched', { runStatus: ['completed'], outcomeStatus: ['completed'] }),
      check('observation-stored', 'invariant', 'An observation is stored', { scope: 'workflow', path: 'observation.tempC', op: 'exists' }),
      check('no-exec-errors', 'no-execution-errors', 'No engine or fixture errors'),
    ],
    checkpoints: [],
    limits: { maxSteps: 500, maxVirtualMs: 120_000 },
    seed: 1,
    notes: ['The rate limit window is a declared fault, not a timer in real time. The run completes in milliseconds of wall-clock time.'],
  }),
};

// ---------------------------------------------------------------------------
// 2. Timeout before a side effect
// ---------------------------------------------------------------------------

const reserveWorkflow: WorkflowDefinition = {
  id: 'reserve-inventory',
  version: '1.0.0',
  title: 'Reserve inventory for an order',
  description: 'Reserves stock with a client-generated reservation ID, which makes retries safe.',
  policySchema: retryPolicySchema,
  policyDocs: retryPolicyDocs,
  *run(ctx) {
    const { orderId, sku, qty } = ctx.input as { orderId: string; sku: string; qty: number };
    const reservationId = `res-${orderId}`;
    const r = yield* callWithRetry(ctx, 'inventory.reserve', { sku, qty, reservationId }, {
      step: 'reserve',
      logicalId: `reserve:${orderId}`,
      maxAttempts: ctx.num('maxAttempts', 1),
      backoffMs: ctx.num('backoffMs', 0),
      honorRetryAfter: ctx.flag('honorRetryAfter'),
      timeoutMs: ctx.num('timeoutMs', 1000),
    });
    if (!r.result?.ok) {
      yield* ctx.set('reservation', { orderId, reserved: false, attempts: r.attempts, unresolved: r.exhausted, lastError: r.result && !r.result.ok ? r.result.error.code : null }, 'record', 'Recorded the unresolved reservation');
      return { status: r.exhausted && r.attempts > 1 ? 'unresolved' : 'failed', detail: `No reservation after ${r.attempts} attempt(s)` };
    }
    yield* ctx.set('reservation', { orderId, reserved: true, reservationId, attempts: r.attempts }, 'record', 'Recorded the reservation', [r.result.seq]);
    return { status: 'completed', detail: `Reserved after ${r.attempts} attempt(s)` };
  },
};

export const timeoutBeforeSideEffect: ScenarioModule = {
  workflow: reserveWorkflow,
  scenario: scenario({
    id: 'timeout-before-side-effect',
    version: '1.0.0',
    title: 'Timeout before the side effect',
    mechanism: 'Retries and time',
    summary: 'The first reservation request times out before the inventory service executes it. A bounded retry is safe and needed; giving up loses the order.',
    workflow: { id: 'reserve-inventory', version: '1.0.0' },
    tools: [
      contract('inventory.reserve', 'Reserve stock. Idempotent per reservationId.', obj({ sku: str, qty: int, reservationId: str }), obj({ reservationId: str, remaining: int }), {
        sideEffects: 'write',
        idempotency: { keyField: 'reservationId', collection: 'reservations' },
      }),
    ],
    allowedTools: ['inventory.reserve'],
    fixtures: [
      ok('reserve-sku', 'inventory.reserve', { args: { sku: 'SKU-9', qty: 2, reservationId: 'res-B-77' } }, { reservationId: 'res-B-77', remaining: 8 }, 150, [
        { op: 'insert', collection: 'reservations', record: { reservationId: '{{args.reservationId}}', sku: '{{args.sku}}', qty: '{{args.qty}}' } },
      ]),
    ],
    triggers: [{ id: 'order-placed', atMs: 0, payload: { orderId: 'B-77', sku: 'SKU-9', qty: 2 } }],
    policies: [
      policy('reserve-inventory', 'faulty', 'Single attempt', { maxAttempts: 1, backoffMs: 200, honorRetryAfter: true, timeoutMs: 1000 }),
      policy('reserve-inventory', 'corrected', 'Bounded retry (3 attempts)', { maxAttempts: 3, backoffMs: 200, honorRetryAfter: true, timeoutMs: 1000 }),
    ],
    faultPresets: [
      plan('first-request-timeout', 'First request times out', 'The first request never reaches the inventory service.', [
        { id: 'timeout-1', description: 'The first reservation request is lost before execution', point: 'before-request', target: { tool: 'inventory.reserve', occurrences: [1] }, effect: { type: 'timeout' } },
      ]),
      plan('persistent-outage', 'Service unreachable', 'Every reservation request times out. A bounded retry must stop and record the unresolved state.', [
        { id: 'timeout-all', description: 'Every reservation request is lost', point: 'before-request', target: { tool: 'inventory.reserve' }, effect: { type: 'timeout' } },
      ]),
    ],
    assertions: [
      check('reserve-retry-bound', 'retry-bound', 'At most 3 reservation attempts', { tool: 'inventory.reserve', max: 3 }),
      check('one-reservation', 'idempotency', 'One reservation per reservation ID', { collection: 'reservations', key: ['reservationId'] }),
      check('reservation-completes', 'completion', 'The reservation completes', { runStatus: ['completed'], outcomeStatus: ['completed'] }),
      check('state-recorded', 'invariant', 'The reservation result is recorded', { scope: 'workflow', path: 'reservation.orderId', op: 'eq', value: 'B-77' }),
      check('no-exec-errors', 'no-execution-errors', 'No engine or fixture errors'),
    ],
    checkpoints: [],
    limits: { maxSteps: 500, maxVirtualMs: 120_000 },
    seed: 2,
    notes: ['Under the persistent-outage preset the corrected policy is expected to fail "The reservation completes" and pass the retry bound: recovery is not possible, only a bounded, recorded failure.'],
  }),
};

// ---------------------------------------------------------------------------
// 10. Exhausted retry limit with unresolved state
// ---------------------------------------------------------------------------

const syncWorkflow: WorkflowDefinition = {
  id: 'sync-with-limit',
  version: '1.0.0',
  title: 'Sync an account with a declared retry limit',
  description: 'Synchronizes an account ledger. When retries are exhausted the workflow must record the unresolved state.',
  policySchema: obj(
    { ...retryPolicySchema.properties!, recordUnresolved: { type: 'boolean' } },
    ['maxAttempts', 'backoffMs', 'honorRetryAfter', 'timeoutMs', 'recordUnresolved'],
    false,
  ),
  policyDocs: { ...retryPolicyDocs, recordUnresolved: 'On exhaustion, write an unresolved record with attempts and the last error.' },
  *run(ctx) {
    const { accountId } = ctx.input as { accountId: string };
    const r = yield* callWithRetry(ctx, 'ledger.sync', { accountId }, {
      step: 'sync',
      logicalId: `sync:${accountId}`,
      maxAttempts: ctx.num('maxAttempts', 1),
      backoffMs: ctx.num('backoffMs', 0),
      honorRetryAfter: ctx.flag('honorRetryAfter'),
      timeoutMs: ctx.num('timeoutMs', 1000),
    });
    if (r.result?.ok) {
      yield* ctx.set('sync', { accountId, synced: true, attempts: r.attempts }, 'record', 'Recorded a successful sync', [r.result.seq]);
      return { status: 'completed', detail: `Synced after ${r.attempts} attempt(s)` };
    }
    if (ctx.flag('recordUnresolved')) {
      yield* ctx.emit('limit.exhausted', 'sync', `Declared retry limit of ${r.attempts} attempts exhausted for ${accountId}`, { accountId, attempts: r.attempts }, r.result ? [r.result.seq] : undefined);
      yield* ctx.set('unresolved', { accountId, attempts: r.attempts, lastError: r.result && !r.result.ok ? r.result.error.code : 'none', needsOperator: true }, 'record', 'Recorded the unresolved sync for an operator');
      return { status: 'unresolved', detail: `Unresolved after ${r.attempts} attempt(s)` };
    }
    return { status: 'failed', detail: 'Sync failed' };
  },
};

export const retryLimitExhausted: ScenarioModule = {
  workflow: syncWorkflow,
  scenario: scenario({
    id: 'retry-limit-exhausted',
    version: '1.0.0',
    title: 'Retry limit exhausted',
    mechanism: 'Retries and time',
    summary: 'A dependency stays unavailable. An effectively unbounded retry loop runs into the engine limit without recording anything; a declared limit ends with an explicit unresolved record.',
    workflow: { id: 'sync-with-limit', version: '1.0.0' },
    tools: [contract('ledger.sync', 'Synchronize an account ledger.', obj({ accountId: str }), obj({ accountId: str, entries: int }), { sideEffects: 'write' })],
    allowedTools: ['ledger.sync'],
    fixtures: [ok('sync-acc', 'ledger.sync', { args: { accountId: 'acc-3' } }, { accountId: 'acc-3', entries: 12 }, 120)],
    triggers: [{ id: 'nightly', atMs: 0, payload: { accountId: 'acc-3' } }],
    policies: [
      policy('sync-with-limit', 'faulty', 'Retry until it works', { maxAttempts: 1000, backoffMs: 50, honorRetryAfter: false, timeoutMs: 1000, recordUnresolved: false }),
      policy('sync-with-limit', 'corrected', 'Declared limit of 4 and unresolved record', { maxAttempts: 4, backoffMs: 50, honorRetryAfter: false, timeoutMs: 1000, recordUnresolved: true }),
    ],
    faultPresets: [
      plan('dependency-down', 'Dependency unavailable', 'Every sync returns UNAVAILABLE.', [
        { id: 'unavailable', description: 'Ledger service is unavailable', point: 'before-request', target: { tool: 'ledger.sync' }, effect: { type: 'error', code: 'UNAVAILABLE', message: 'Service unavailable' } },
      ]),
    ],
    assertions: [
      check('declared-limit', 'retry-bound', 'Attempts stay within the declared limit of 4', { tool: 'ledger.sync', max: 4 }),
      check('unresolved-recorded', 'invariant', 'Exhaustion is recorded as unresolved', { scope: 'workflow', path: 'unresolved.accountId', op: 'eq', value: 'acc-3', onlyIf: { event: { kind: 'tool.error', tool: 'ledger.sync' } } }),
      check('ends-explicitly', 'completion', 'The workflow ends with an explicit outcome', { runStatus: ['completed', 'unresolved'], outcomeStatus: ['completed', 'unresolved'] }),
      check('no-exec-errors', 'no-execution-errors', 'No engine or fixture errors'),
    ],
    checkpoints: [],
    limits: { maxSteps: 2000, maxVirtualMs: 60_000 },
    seed: 3,
    notes: ['The engine stops runs at 60 000 virtual ms. That engine limit is not a workflow policy and produces no workflow record.'],
  }),
};
