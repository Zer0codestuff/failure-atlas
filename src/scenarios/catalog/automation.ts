import type { WorkflowDefinition } from '../../engine/workflow';
import { arr, bool, check, contract, obj, ok, plan, policy, scenario, str, type ScenarioModule } from '../helpers';

/**
 * Inspired by the owner's "new repository -> build project" automation.
 * Everything here is a local fixture: no GitHub API is reachable from the
 * engine, and the allowlist contains only fixture tools.
 */

const STEPS = ['scaffold', 'implement', 'test'] as const;

const repoWorkflow: WorkflowDefinition = {
  id: 'repo-builder',
  version: '1.0.0',
  title: 'Repository event to built project',
  description: 'Receives a repository-created event, fetches the linked brief, runs implementation steps, and publishes a result to a review branch.',
  policySchema: obj(
    { dedupeEvents: { type: 'boolean' }, stopOnMissingBrief: { type: 'boolean' }, verifyArtifact: { type: 'boolean' }, targetBranch: { type: 'string' } },
    ['dedupeEvents', 'stopOnMissingBrief', 'verifyArtifact', 'targetBranch'],
    false,
  ),
  policyDocs: {
    dedupeEvents: 'Skip a repository event whose delivery ID already produced a result.',
    stopOnMissingBrief: 'If the brief cannot be read, record a blocked state instead of building from the repository name alone.',
    verifyArtifact: 'Compare produced files and test results with the brief before reporting the project as done.',
    targetBranch: 'Branch that receives the result. The owner requires a feature branch, not the default branch.',
  },
  *run(ctx) {
    const evt = ctx.input as { deliveryId: string; repo: string; briefUrl: string };
    if (ctx.flag('dedupeEvents')) {
      const seen = yield* ctx.get(`handled.${evt.deliveryId}`);
      yield* ctx.emit('check', 'dedupe', seen ? `Delivery ${evt.deliveryId} already handled; skipping` : `Delivery ${evt.deliveryId} is new`, { duplicate: Boolean(seen) });
      if (seen) return { status: 'skipped', detail: 'Duplicate repository event' };
    }
    const brief = yield* ctx.call('brief.fetch', { url: evt.briefUrl }, { step: 'fetch-brief' });
    let requiredFiles: string[] = [];
    if (!brief.ok) {
      if (ctx.flag('stopOnMissingBrief')) {
        yield* ctx.set('result', { repo: evt.repo, status: 'blocked', reason: `brief unavailable: ${brief.error.code}`, files: [] }, 'fetch-brief', 'Recorded that the build is blocked on the brief', [brief.seq]);
        return { status: 'unresolved', detail: 'Brief inaccessible; waiting for the owner' };
      }
      yield* ctx.emit('decision', 'fetch-brief', 'Brief unavailable; building from the repository name', null, [brief.seq]);
    } else requiredFiles = (brief.value as { requiredFiles: string[] }).requiredFiles;

    const files: string[] = [];
    let testsPassed = true;
    let lastSeq = brief.seq;
    for (const step of STEPS) {
      const r = yield* ctx.call('build.step', { repo: evt.repo, step }, { step: `build:${step}`, causes: [lastSeq] });
      if (!r.ok) {
        yield* ctx.set('result', { repo: evt.repo, status: 'failed', reason: r.error.code, files }, `build:${step}`, `Build step ${step} failed`);
        return { status: 'failed', detail: `${step} failed` };
      }
      const v = r.value as { files?: string[]; testsPassed?: boolean };
      files.push(...(v.files ?? []));
      if (v.testsPassed === false) testsPassed = false;
      lastSeq = r.seq;
    }
    let status: 'done' | 'incomplete' = 'done';
    const missing = requiredFiles.filter((f) => !files.includes(f));
    if (ctx.flag('verifyArtifact')) {
      if (missing.length || !testsPassed || !requiredFiles.length) status = 'incomplete';
      yield* ctx.emit('check', 'verify-artifact', status === 'done' ? 'Artifact matches the brief and tests pass' : `Artifact incomplete: ${[...missing.map((m) => `missing ${m}`), ...(testsPassed ? [] : ['tests failing']), ...(requiredFiles.length ? [] : ['no brief to verify against'])].join(', ')}`, { missing, testsPassed }, [lastSeq]);
    }
    const pub = yield* ctx.call('artifact.publish', { repo: evt.repo, branch: String(ctx.policy.targetBranch), files, status }, { step: 'publish', causes: [lastSeq] });
    yield* ctx.set('result', { repo: evt.repo, status, files, missing, testsPassed, published: pub.ok }, 'publish', `Reported the project as ${status}`, [pub.seq]);
    if (ctx.flag('dedupeEvents')) yield* ctx.set(`handled.${evt.deliveryId}`, true, 'publish', `Marked delivery ${evt.deliveryId} handled`);
    return { status: status === 'done' ? 'completed' : 'unresolved', detail: `Result ${status}` };
  },
};

export const repoBuilder: ScenarioModule = {
  workflow: repoWorkflow,
  scenario: scenario({
    id: 'repo-creation-automation',
    version: '1.0.0',
    title: 'Repository event to built project',
    mechanism: 'Automation pipelines',
    summary: 'A simulated repository event links a brief. Duplicate events, an inaccessible brief, and an incomplete artifact must not be reported as a finished project.',
    workflow: { id: 'repo-builder', version: '1.0.0' },
    tools: [
      contract('brief.fetch', 'Read the brief linked from the repository description (fixture).', obj({ url: str }), obj({ title: str, requiredFiles: arr(str) })),
      contract('build.step', 'Run one implementation step in a fixture workspace.', obj({ repo: str, step: str }), obj({ files: arr(str), testsPassed: bool }, ['files'])),
      contract('artifact.publish', 'Record the result on a branch in the fixture store. Never touches GitHub.', obj({ repo: str, branch: str, files: arr(str), status: str }), obj({ ref: str }), { sideEffects: 'write' }),
    ],
    allowedTools: ['brief.fetch', 'build.step', 'artifact.publish'],
    fixtures: [
      ok('brief', 'brief.fetch', { args: { url: 'fixture://briefs/kite-notes.md' } }, { title: 'Kite Notes', requiredFiles: ['README.md', 'AGENTS.md', 'src/app.ts', 'test/app.test.ts'] }, 120),
      ok('scaffold', 'build.step', { args: { repo: 'example/kite-notes', step: 'scaffold' } }, { files: ['README.md', 'AGENTS.md', 'package.json'] }, 2000),
      ok('implement', 'build.step', { args: { repo: 'example/kite-notes', step: 'implement' } }, { files: ['src/app.ts'] }, 6000),
      ok('test', 'build.step', { args: { repo: 'example/kite-notes', step: 'test' } }, { files: ['test/app.test.ts'], testsPassed: true }, 3000),
      ok('publish', 'artifact.publish', { argsFields: { repo: 'example/kite-notes' } }, { ref: 'refs/heads/feature/initial-build' }, 300, [
        { op: 'insert', collection: 'artifacts', record: { repo: '{{args.repo}}', branch: '{{args.branch}}', status: '{{args.status}}' } },
      ]),
    ],
    triggers: [{ id: 'repo-created', atMs: 0, payload: { deliveryId: 'dlv-9001', repo: 'example/kite-notes', briefUrl: 'fixture://briefs/kite-notes.md' } }],
    policies: [
      policy('repo-builder', 'faulty', 'Build on every event, report done', { dedupeEvents: false, stopOnMissingBrief: false, verifyArtifact: false, targetBranch: 'main' }),
      policy('repo-builder', 'corrected', 'Dedupe, stop on missing brief, verify, feature branch', { dedupeEvents: true, stopOnMissingBrief: true, verifyArtifact: true, targetBranch: 'feature/initial-build' }),
    ],
    faultPresets: [
      plan('duplicate-event', 'Duplicate repository event', 'The same delivery arrives twice, 20 s apart.', [
        { id: 'dup', description: 'Redeliver dlv-9001', point: 'trigger-delivery', target: { triggerId: 'repo-created' }, effect: { type: 'duplicate', delayMs: 20_000 } },
      ]),
      plan('brief-inaccessible', 'Brief inaccessible', 'brief.fetch returns FORBIDDEN (for example a private gist).', [
        { id: 'forbidden', description: 'Brief fetch is forbidden', point: 'before-request', target: { tool: 'brief.fetch' }, effect: { type: 'error', code: 'FORBIDDEN', message: 'Brief is not readable with the configured access' } },
      ]),
      plan('incomplete-result', 'Incomplete result', 'The implement step produces no source file and tests fail.', [
        { id: 'no-src', description: 'Implement step returns no files', point: 'before-response', target: { tool: 'build.step', argsMatch: { step: 'implement' } }, effect: { type: 'set-fields', values: { files: [] } } },
        { id: 'tests-fail', description: 'Tests fail', point: 'before-response', target: { tool: 'build.step', argsMatch: { step: 'test' } }, effect: { type: 'set-fields', values: { testsPassed: false } } },
      ]),
    ],
    assertions: [
      check('one-artifact', 'idempotency', 'One published result per repository', { collection: 'artifacts', key: ['repo'] }),
      check('feature-branch', 'invariant', 'Results never target the default branch', { scope: 'external', path: 'collections.artifacts', op: 'none-match', where: { field: 'branch', op: 'eq', value: 'main' } }),
      check('no-build-without-brief', 'invariant', 'Nothing is published when the brief is inaccessible', { scope: 'external', path: 'collections.artifacts', op: 'absent', onlyIf: { event: { kind: 'tool.error', tool: 'brief.fetch' } } }),
      check('done-means-complete', 'required-evidence', 'A result reported done contains every file the brief requires', {
        expectedFrom: { tool: 'brief.fetch', field: 'requiredFiles' },
        present: { scope: 'workflow', path: 'result.files' },
        onlyIfClaim: { scope: 'workflow', path: 'result.status', equals: 'done' },
      }),
      check('done-means-tests-pass', 'invariant', 'A result reported done has passing tests', { scope: 'workflow', path: 'result.testsPassed', op: 'eq', value: true, onlyIf: { claim: { scope: 'workflow', path: 'result.status', equals: 'done' } } }),
      check('allowlist', 'allowed-tools', 'Only fixture tools are requested', { allowed: ['brief.fetch', 'build.step', 'artifact.publish'] }),
      check('no-exec-errors', 'no-execution-errors', 'No engine or fixture errors'),
    ],
    checkpoints: [],
    limits: { maxSteps: 500, maxVirtualMs: 120_000 },
    seed: 13,
    notes: ['No real repository is created, read, or written. brief.fetch reads a fixture URL scheme the engine cannot resolve to the network.'],
  }),
};
