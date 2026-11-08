import type { WorkflowDefinition } from '../../engine/workflow';
import type { Json } from '../../engine/types';
import { arr, bool, check, contract, int, num, obj, ok, plan, policy, scenario, str, type ScenarioModule } from '../helpers';

// ---------------------------------------------------------------------------
// 5. Schema change / omitted required field
// ---------------------------------------------------------------------------

const profileWorkflow: WorkflowDefinition = {
  id: 'profile-sync',
  version: '1.0.0',
  title: 'Sync a customer profile to the CRM',
  description: 'Reads a profile and writes the contact email to a CRM record.',
  policySchema: obj({ validateResponses: { type: 'boolean' } }, ['validateResponses'], false),
  policyDocs: { validateResponses: 'Validate the profile response before using it; stop with a recorded error when a required field is missing.' },
  *run(ctx) {
    const { userId } = ctx.input as { userId: string };
    const p = yield* ctx.call('profile.get', { userId }, { step: 'read-profile' });
    if (!p.ok) return { status: 'failed', detail: p.error.code };
    const profile = p.value as Record<string, Json>;
    if (ctx.flag('validateResponses')) {
      const missing = ['userId', 'email', 'plan'].filter((k) => typeof profile[k] !== 'string');
      yield* ctx.emit('check', 'validate-profile', missing.length ? `Profile response is missing ${missing.join(', ')}; refusing to write` : 'Profile response has every required field', { missing }, [p.seq]);
      if (missing.length) {
        yield* ctx.set('sync', { userId, written: false, reason: `missing ${missing.join(', ')}` }, 'validate-profile', 'Recorded the rejected profile', [p.seq]);
        return { status: 'failed', detail: `Upstream response missing ${missing.join(', ')}` };
      }
    }
    const email = (profile.email ?? null) as Json;
    const w = yield* ctx.call('crm.upsert', { userId, email, plan: profile.plan ?? null }, { step: 'write-crm', causes: [p.seq] });
    yield* ctx.set('sync', { userId, written: w.ok, email }, 'write-crm', 'Recorded the CRM write');
    return { status: w.ok ? 'completed' : 'failed', detail: w.ok ? 'CRM updated' : 'CRM write failed' };
  },
};

export const schemaDrift: ScenarioModule = {
  workflow: profileWorkflow,
  scenario: scenario({
    id: 'schema-drift-missing-field',
    version: '1.0.0',
    title: 'Response omits a required field',
    mechanism: 'Contracts and evidence',
    summary: 'The profile service drops the email field and renames plan to tier. A workflow that trusts the response writes a null email to the CRM.',
    workflow: { id: 'profile-sync', version: '1.0.0' },
    tools: [
      contract('profile.get', 'Read a profile.', obj({ userId: str }), obj({ userId: str, email: str, plan: str })),
      contract('crm.upsert', 'Write a CRM contact. Accepts any JSON; validation is the caller’s job.', obj({ userId: str }, ['userId']), obj({ ok: bool }), { sideEffects: 'write', external: true }),
    ],
    allowedTools: ['profile.get', 'crm.upsert'],
    fixtures: [
      ok('profile-u5', 'profile.get', { args: { userId: 'u-5' } }, { userId: 'u-5', email: 'ada@example.test', plan: 'team' }, 60),
      ok('crm-u5', 'crm.upsert', { argsFields: { userId: 'u-5' } }, { ok: true }, 90, [{ op: 'insert', collection: 'contacts', record: { userId: '{{args.userId}}', email: '{{args.email}}' } }]),
    ],
    triggers: [{ id: 'profile-changed', atMs: 0, payload: { userId: 'u-5' } }],
    policies: [
      policy('profile-sync', 'faulty', 'Trust the response', { validateResponses: false }),
      policy('profile-sync', 'corrected', 'Validate before writing', { validateResponses: true }),
    ],
    faultPresets: [
      plan('field-dropped', 'Field removed and renamed', 'profile.get omits email and renames plan to tier.', [
        { id: 'drop-email', description: 'Remove email and plan, add tier', point: 'before-response', target: { tool: 'profile.get' }, effect: { type: 'remove-fields', paths: ['email', 'plan'] } },
        { id: 'add-tier', description: 'Add the renamed field tier', point: 'before-response', target: { tool: 'profile.get' }, effect: { type: 'set-fields', values: { tier: 'team' } } },
      ]),
    ],
    assertions: [
      check('profile-contract', 'tool-schema', 'Profile responses match the contract', { tool: 'profile.get' }),
      check('no-null-email', 'invariant', 'No CRM contact is written with a missing email', { scope: 'external', path: 'collections.contacts', op: 'none-match', where: { field: 'email', op: 'absent' } }),
      check('violation-stops', 'invariant', 'A contract violation stops the write', { scope: 'workflow', path: 'sync.written', op: 'eq', value: false, onlyIf: { contractViolation: 'profile.get' } }),
      check('no-exec-errors', 'no-execution-errors', 'No engine or fixture errors'),
    ],
    checkpoints: [],
    limits: { maxSteps: 500, maxVirtualMs: 60_000 },
    seed: 5,
    notes: ['"Profile responses match the contract" is expected to fail under the fault for both policies: it reports the upstream drift itself. The corrected policy contains its effect.'],
  }),
};

// ---------------------------------------------------------------------------
// 6. Partial search must disclose the gap
// ---------------------------------------------------------------------------

const briefingWorkflow: WorkflowDefinition = {
  id: 'source-briefing',
  version: '1.0.0',
  title: 'Briefing from a source index',
  description: 'Reads the list of sources a briefing must cover, searches for them, and writes a briefing.',
  policySchema: obj({ discloseGaps: { type: 'boolean' } }, ['discloseGaps'], false),
  policyDocs: { discloseGaps: 'Compare found sources with the required list and list every missing source in the briefing.' },
  *run(ctx) {
    const { topic } = ctx.input as { topic: string };
    const idx = yield* ctx.call('sources.index', { topic }, { step: 'read-index' });
    if (!idx.ok) return { status: 'failed', detail: idx.error.code };
    const required = (idx.value as { required: string[] }).required;
    const s = yield* ctx.call('search.query', { topic }, { step: 'search', causes: [idx.seq] });
    if (!s.ok) return { status: 'failed', detail: s.error.code };
    const results = ((s.value as { results?: Array<{ id: string }> }).results ?? []).map((r) => r.id);
    const gaps = ctx.flag('discloseGaps') ? required.filter((r) => !results.includes(r)) : [];
    yield* ctx.set('briefing', { topic, sourcesUsed: results, gaps, complete: gaps.length === 0 }, 'write-briefing', gaps.length ? `Wrote the briefing and disclosed ${gaps.length} missing source(s)` : 'Wrote the briefing', [idx.seq, s.seq]);
    return { status: 'completed', detail: `${results.length} of ${required.length} sources` };
  },
};

export const partialSearch: ScenarioModule = {
  workflow: briefingWorkflow,
  scenario: scenario({
    id: 'partial-search-gap',
    version: '1.0.0',
    title: 'Partial search result',
    mechanism: 'Contracts and evidence',
    summary: 'The search tool returns only two of three required sources. The briefing must say what is missing instead of looking complete.',
    workflow: { id: 'source-briefing', version: '1.0.0' },
    tools: [
      contract('sources.index', 'List the sources a briefing must cover.', obj({ topic: str }), obj({ required: arr(str) })),
      contract('search.query', 'Search the source corpus.', obj({ topic: str }), obj({ results: arr(obj({ id: str, title: str })), partial: bool }, ['results'])),
    ],
    allowedTools: ['sources.index', 'search.query'],
    fixtures: [
      ok('index-grid', 'sources.index', { args: { topic: 'grid-storage' } }, { required: ['src-a', 'src-b', 'src-c'] }, 30),
      ok('search-grid', 'search.query', { args: { topic: 'grid-storage' } }, { results: [{ id: 'src-a', title: 'Synthetic note A' }, { id: 'src-b', title: 'Synthetic note B' }, { id: 'src-c', title: 'Synthetic note C' }], partial: false }, 200),
    ],
    triggers: [{ id: 'briefing-request', atMs: 0, payload: { topic: 'grid-storage' } }],
    policies: [
      policy('source-briefing', 'faulty', 'Write with what was found', { discloseGaps: false }),
      policy('source-briefing', 'corrected', 'Disclose missing sources', { discloseGaps: true }),
    ],
    faultPresets: [
      plan('truncated', 'Search result truncated', 'search.query returns only the first two results.', [
        { id: 'truncate', description: 'Keep only 2 results', point: 'before-response', target: { tool: 'search.query' }, effect: { type: 'truncate-array', path: 'results', keep: 2 } },
      ]),
    ],
    assertions: [
      check('gap-disclosed', 'gap-disclosed', 'Missing required sources are disclosed', {
        expectedFrom: { tool: 'sources.index', field: 'required' },
        present: { scope: 'workflow', path: 'briefing.sourcesUsed' },
        gaps: { scope: 'workflow', path: 'briefing.gaps' },
      }),
      check('complete-claim-supported', 'required-evidence', 'A briefing marked complete uses every required source', {
        expectedFrom: { tool: 'sources.index', field: 'required' },
        present: { scope: 'workflow', path: 'briefing.sourcesUsed' },
        onlyIfClaim: { scope: 'workflow', path: 'briefing.complete', equals: true },
      }),
      check('search-contract', 'tool-schema', 'Search responses match the contract', { tool: 'search.query' }),
      check('no-exec-errors', 'no-execution-errors', 'No engine or fixture errors'),
    ],
    checkpoints: [],
    limits: { maxSteps: 500, maxVirtualMs: 60_000 },
    seed: 6,
    notes: ['All sources are synthetic placeholders written for this scenario.'],
  }),
};

// ---------------------------------------------------------------------------
// 7. Stale cache presented as current
// ---------------------------------------------------------------------------

const priceWorkflow: WorkflowDefinition = {
  id: 'cached-quote',
  version: '1.0.0',
  title: 'Quote a price with a cache',
  description: 'Serves a price from a cache and falls back to the live source when the cache is too old.',
  policySchema: obj({ maxAgeMs: { type: 'integer', minimum: 0 }, checkAge: { type: 'boolean' } }, ['maxAgeMs', 'checkAge'], false),
  policyDocs: { maxAgeMs: 'Oldest cached value that may still be presented as current.', checkAge: 'Compare the cache age with maxAgeMs before using it.' },
  *run(ctx) {
    const { sku } = ctx.input as { sku: string };
    const c = yield* ctx.call('cache.get', { key: `price:${sku}` }, { step: 'read-cache' });
    const now = yield* ctx.now();
    if (c.ok) {
      const entry = c.value as { value: number; asOfMs: number };
      const age = now - entry.asOfMs;
      const fresh = !ctx.flag('checkAge') || age <= ctx.num('maxAgeMs', 0);
      yield* ctx.emit('decision', 'check-freshness', fresh ? `Using cached price (age ${age} ms)` : `Cached price is ${age} ms old; refreshing`, { ageMs: age, fresh }, [c.seq]);
      if (fresh) {
        yield* ctx.set('quote', { sku, price: entry.value, asOfMs: entry.asOfMs, current: true, source: 'cache' }, 'publish-quote', 'Published the quote from cache', [c.seq]);
        return { status: 'completed', detail: 'Quoted from cache' };
      }
    }
    const live = yield* ctx.call('prices.live', { sku }, { step: 'read-live', timeoutMs: 1000 });
    if (live.ok) {
      const v = live.value as { price: number; asOfMs: number };
      yield* ctx.set('quote', { sku, price: v.price, asOfMs: v.asOfMs, current: true, source: 'live' }, 'publish-quote', 'Published the live quote', [live.seq]);
      return { status: 'completed', detail: 'Quoted from the live source' };
    }
    if (c.ok) {
      const entry = c.value as { value: number; asOfMs: number };
      yield* ctx.set('quote', { sku, price: entry.value, asOfMs: entry.asOfMs, current: false, source: 'cache' }, 'publish-quote', 'Published the cached quote marked as stale', [c.seq, live.seq]);
      return { status: 'completed', detail: 'Quoted stale cache, labeled stale' };
    }
    return { status: 'failed', detail: 'No price available' };
  },
};

export const staleCache: ScenarioModule = {
  workflow: priceWorkflow,
  scenario: scenario({
    id: 'stale-cache-current',
    version: '1.0.0',
    title: 'Stale cache presented as current',
    mechanism: 'Contracts and evidence',
    summary: 'The cached price is 10 minutes old. Without an age check, the workflow presents it as the current price.',
    workflow: { id: 'cached-quote', version: '1.0.0' },
    tools: [
      contract('cache.get', 'Read a cache entry.', obj({ key: str }), obj({ value: num, asOfMs: int })),
      contract('prices.live', 'Read the live price.', obj({ sku: str }), obj({ price: num, asOfMs: int })),
    ],
    allowedTools: ['cache.get', 'prices.live'],
    fixtures: [
      ok('cache-sku', 'cache.get', { args: { key: 'price:SKU-4' } }, { value: 19.0, asOfMs: 0 }, 5),
      ok('live-sku', 'prices.live', { args: { sku: 'SKU-4' } }, { price: 23.5, asOfMs: 600_100 }, 120),
    ],
    triggers: [{ id: 'quote-request', atMs: 600_000, payload: { sku: 'SKU-4' } }],
    policies: [
      policy('cached-quote', 'faulty', 'Always trust the cache', { maxAgeMs: 60_000, checkAge: false }),
      policy('cached-quote', 'corrected', 'Refresh entries older than 60 s', { maxAgeMs: 60_000, checkAge: true }),
    ],
    faultPresets: [
      plan('live-down', 'Live source unavailable', 'prices.live fails, so the only price is the stale cache entry.', [
        { id: 'live-unavailable', description: 'Live price source returns UNAVAILABLE', point: 'before-request', target: { tool: 'prices.live' }, effect: { type: 'error', code: 'UNAVAILABLE', message: 'Price service down' } },
      ]),
    ],
    assertions: [
      check('freshness', 'freshness', 'Data older than 60 s is not presented as current', { outputPath: 'quote', asOfField: 'asOfMs', currentFlag: 'current', maxAgeMs: 60_000 }),
      check('quote-published', 'invariant', 'A quote is published', { scope: 'workflow', path: 'quote.price', op: 'exists' }),
      check('no-exec-errors', 'no-execution-errors', 'No engine or fixture errors'),
    ],
    checkpoints: [],
    limits: { maxSteps: 500, maxVirtualMs: 700_000 },
    seed: 7,
    notes: ['The source becomes stale through virtual time: the trigger fires at 600 000 ms while the cache entry is from 0 ms. The faulty policy fails freshness even without an injected fault.'],
  }),
};

// ---------------------------------------------------------------------------
// 12. Citation references a source that was never retrieved
// ---------------------------------------------------------------------------

const SNAPSHOTS = [
  { id: 'snap-01', title: 'Synthetic field note: battery cycle counts', text: 'Synthetic note. Cells in the sample retained 80% capacity after 1,200 cycles.' },
  { id: 'snap-02', title: 'Synthetic field note: thermal events', text: 'Synthetic note. Two thermal alarms were logged during the summer test window.' },
  { id: 'snap-03', title: 'Synthetic field note: maintenance', text: 'Synthetic note. Inverter maintenance took 6 hours per quarter.' },
];

const reportWorkflow: WorkflowDefinition = {
  id: 'research-report',
  version: '1.0.0',
  title: 'Research and report',
  description: 'Retrieves source snapshots, drafts claims with citations, checks citations against retrieved snapshots, and publishes.',
  policySchema: obj({ verifyCitations: { type: 'boolean' } }, ['verifyCitations'], false),
  policyDocs: { verifyCitations: 'Before publishing, drop or mark every claim whose citations were not retrieved.' },
  *run(ctx) {
    const { question } = ctx.input as { question: string };
    const r = yield* ctx.call('sources.retrieve', { question }, { step: 'retrieve' });
    if (!r.ok) return { status: 'failed', detail: r.error.code };
    const snaps = (r.value as { snapshots: Array<{ id: string }> }).snapshots;
    const d = yield* ctx.call('draft.compose', { question, snapshotIds: snaps.map((s) => s.id) }, { step: 'draft', causes: [r.seq] });
    if (!d.ok) return { status: 'failed', detail: d.error.code };
    let claims = (d.value as { claims: Array<{ text: string; cites: string[] }> }).claims;
    if (ctx.flag('verifyCitations')) {
      const have = new Set(snaps.map((s) => s.id));
      const unsupported = claims.filter((c) => c.cites.some((x) => !have.has(x)) || !c.cites.length);
      yield* ctx.emit('check', 'verify-citations', unsupported.length ? `${unsupported.length} claim(s) cite unretrieved sources; withheld from the report` : 'All citations resolve to retrieved snapshots', { unsupported: unsupported.map((u) => u.text) }, [r.seq, d.seq]);
      claims = claims.filter((c) => !unsupported.includes(c));
      if (unsupported.length) yield* ctx.set('withheld', unsupported.map((u) => u.text), 'verify-citations', 'Recorded withheld claims');
    }
    yield* ctx.set('report', { question, claims }, 'publish', `Published a report with ${claims.length} claim(s)`, [r.seq, d.seq]);
    return { status: 'completed', detail: `${claims.length} claim(s) published` };
  },
};

export const researchReport: ScenarioModule = {
  workflow: reportWorkflow,
  scenario: scenario({
    id: 'research-report-missing-citation',
    version: '1.0.0',
    title: 'Research report with a missing citation',
    mechanism: 'Contracts and evidence',
    summary: 'The draft cites a fourth snapshot that retrieval never returned. A citation check must catch it before the report is published.',
    workflow: { id: 'research-report', version: '1.0.0' },
    tools: [
      contract('sources.retrieve', 'Retrieve source snapshots for a question.', obj({ question: str }), obj({ snapshots: arr(obj({ id: str, title: str, text: str })) })),
      contract('draft.compose', 'Draft cited claims from snapshots (scripted fixture, not a model).', obj({ question: str, snapshotIds: arr(str) }), obj({ claims: arr(obj({ text: str, cites: arr(str) })) })),
    ],
    allowedTools: ['sources.retrieve', 'draft.compose'],
    fixtures: [
      ok('retrieve', 'sources.retrieve', { args: { question: 'How did the pilot storage site perform?' } }, { snapshots: SNAPSHOTS }, 150),
      ok('draft', 'draft.compose', { argsFields: { question: 'How did the pilot storage site perform?' } }, {
        claims: [
          { text: 'Cells retained 80% capacity after 1,200 cycles.', cites: ['snap-01'] },
          { text: 'Two thermal alarms occurred in summer.', cites: ['snap-02'] },
          { text: 'Maintenance costs fell 40% year over year.', cites: ['snap-04'] },
        ],
      }, 400),
    ],
    triggers: [{ id: 'research-request', atMs: 0, payload: { question: 'How did the pilot storage site perform?' } }],
    policies: [
      policy('research-report', 'faulty', 'Publish the draft as written', { verifyCitations: false }),
      policy('research-report', 'corrected', 'Verify citations before publishing', { verifyCitations: true }),
    ],
    faultPresets: [],
    assertions: [
      check('citations', 'citations', 'Every published claim cites a retrieved snapshot', { reportPath: 'report', claimsField: 'claims', citeField: 'cites', requireCitation: true, sourcesFrom: { tool: 'sources.retrieve', listField: 'snapshots', idField: 'id' } }),
      check('ordering', 'ordering', 'Drafting happens after retrieval', { first: { kind: 'tool.response', tool: 'sources.retrieve' }, then: { kind: 'tool.request', tool: 'draft.compose' }, description: 'draft.compose must not be requested before sources are retrieved' }),
      check('report-published', 'invariant', 'A report is published', { scope: 'workflow', path: 'report.claims', op: 'exists' }),
      check('no-exec-errors', 'no-execution-errors', 'No engine or fixture errors'),
    ],
    checkpoints: [],
    limits: { maxSteps: 500, maxVirtualMs: 60_000 },
    seed: 12,
    live: {
      instructions: 'You write short research reports. Call sources__retrieve with the question, then answer ONLY with JSON of the form {"claims":[{"text":string,"cites":[snapshotId]}]}. Cite only snapshot ids returned by the tool. Do not invent sources.',
      tools: ['sources.retrieve'],
      answerPath: 'report',
    },
    notes: ['All snapshots and claims are synthetic text written for this scenario. They describe no real site.', 'Synthetic tests demonstrate behavior under controlled conditions; they do not establish general model reliability.'],
  }),
};
