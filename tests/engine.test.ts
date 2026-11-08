import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { evaluateAll } from '../src/engine/assertions';
import { checkFixtures, resolveFixture } from '../src/engine/fixtures';
import { canonicalize, sha256 } from '../src/engine/hash';
import { forkRun, ForkError, hashEvents, RunConfigError, runScenario } from '../src/engine/runner';
import type { ScenarioDef } from '../src/engine/types';
import { SCENARIOS, getScenario } from '../src/scenarios/index';
import { EXPECTED } from './expected-outcomes';

const mod = (id: string) => getScenario(id)!;
const run = (id: string, policy: string, preset: string | null, extra: Record<string, unknown> = {}) => {
  const m = mod(id);
  return runScenario(m.scenario, m.workflow, {
    policy: m.scenario.policies.find((p) => p.id === policy)!,
    faultPlan: preset ? m.scenario.faultPresets.find((f) => f.id === preset)! : null,
    ...extra,
  });
};

describe('hashing and canonical JSON', () => {
  it('matches Node crypto SHA-256 on known inputs', () => {
    for (const s of ['', 'abc', 'Failure Atlas', 'x'.repeat(1000), 'unicode: àèìòù']) {
      expect(sha256(s)).toBe(createHash('sha256').update(s, 'utf8').digest('hex'));
    }
  });
  it('sorts keys and rejects non-finite numbers', () => {
    expect(canonicalize({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}');
    expect(() => canonicalize({ x: Number.NaN })).toThrow();
  });
});

describe('fixture matching', () => {
  const s = mod('lost-response-duplicate-charge').scenario;
  const state = { kv: {}, collections: {} };
  it('matches exact canonical arguments regardless of key order', () => {
    const r = resolveFixture(s.fixtures, { tool: 'orders.get', args: { orderId: 'A-1001' }, occurrence: 1 }, state);
    expect(r.kind).toBe('match');
  });
  it('records a miss when arguments changed instead of replaying by tool name', () => {
    const r = resolveFixture(s.fixtures, { tool: 'orders.get', args: { orderId: 'A-9999' }, occurrence: 1 }, state);
    expect(r.kind).toBe('miss');
  });
  it('rejects ambiguous matches', () => {
    const fixtures = [...s.fixtures, { ...s.fixtures[0], id: 'dup' }];
    const r = resolveFixture(fixtures, { tool: 'orders.get', args: { orderId: 'A-1001' }, occurrence: 1 }, state);
    expect(r.kind).toBe('ambiguous');
  });
  it('prefers the more specific occurrence-bound fixture and uses state predicates', () => {
    const base = s.fixtures[0];
    const fixtures = [base, { ...base, id: 'second', match: { ...base.match, occurrence: 2 } }, { ...base, id: 'stateful', match: { ...base.match, occurrence: 3, state: { 'kv.flag': true } } }];
    expect(resolveFixture(fixtures, { tool: 'orders.get', args: { orderId: 'A-1001' }, occurrence: 2 }, state)).toMatchObject({ kind: 'match', entry: { id: 'second' } });
    expect(resolveFixture(fixtures, { tool: 'orders.get', args: { orderId: 'A-1001' }, occurrence: 3 }, state)).toMatchObject({ kind: 'match', entry: { id: base.id } });
    expect(resolveFixture(fixtures, { tool: 'orders.get', args: { orderId: 'A-1001' }, occurrence: 3 }, { kv: { flag: true }, collections: {} })).toMatchObject({ kind: 'match', entry: { id: 'stateful' } });
  });
  it('refuses fixtures that would match by tool name alone', () => {
    const bad = { ...s, fixtures: [{ ...s.fixtures[0], match: {} }] };
    expect(checkFixtures(bad).join(' ')).toMatch(/tool name alone/);
  });
  it('every shipped scenario has valid fixtures', () => {
    for (const m of SCENARIOS) expect(checkFixtures(m.scenario), m.scenario.id).toEqual([]);
  });
});

describe('determinism', () => {
  it('reproduces normalized event streams and state hashes for every scenario, policy and preset', () => {
    for (const m of SCENARIOS) for (const p of m.scenario.policies) for (const f of [null, ...m.scenario.faultPresets]) {
      const a = runScenario(m.scenario, m.workflow, { policy: p, faultPlan: f, wallClock: true });
      const b = runScenario(m.scenario, m.workflow, { policy: p, faultPlan: f });
      expect(a.hashes.events, `${m.scenario.id}/${p.id}/${f?.id}`).toBe(b.hashes.events);
      expect(a.hashes.state).toBe(b.hashes.state);
      expect(a.id).toBe(b.id);
    }
  });
  it('wall-clock timestamps never affect hashes', () => {
    const a = run('lost-response-duplicate-charge', 'faulty', 'lost-response', { wallClock: true });
    expect(a.events[0].wt).toBeTypeOf('string');
    expect(hashEvents(a.events)).toBe(run('lost-response-duplicate-charge', 'faulty', 'lost-response').hashes.events);
  });
  it('seeded-shuffle tie-breaking is reproducible for a given seed', () => {
    const a = run('parallel-out-of-order', 'corrected', null, { schedule: 'seeded-shuffle', seed: 42 });
    const b = run('parallel-out-of-order', 'corrected', null, { schedule: 'seeded-shuffle', seed: 42 });
    expect(a.hashes.events).toBe(b.hashes.events);
  });
  it('a changed fault or policy yields a different stream', () => {
    const base = run('lost-response-duplicate-charge', 'faulty', 'lost-response');
    expect(run('lost-response-duplicate-charge', 'corrected', 'lost-response').hashes.events).not.toBe(base.hashes.events);
    expect(run('lost-response-duplicate-charge', 'faulty', 'slow-response').hashes.events).not.toBe(base.hashes.events);
  });
  it('finalized runs are immutable', () => {
    const t = run('lost-response-duplicate-charge', 'faulty', null);
    expect(Object.isFrozen(t)).toBe(true);
    expect(() => { (t.events as any).push({}); }).toThrow();
  });
});

describe('independently specified expected behavior', () => {
  for (const [key, exp] of Object.entries(EXPECTED)) {
    it(key, () => {
      const [id, policy, preset] = key.split('|');
      const m = mod(id);
      const t = run(id, policy, preset === 'none' ? null : preset);
      const failing = evaluateAll(m.scenario.assertions, t, m.scenario).filter((r) => r.status === 'fail' || r.status === 'error').map((r) => r.assertionId).sort();
      expect(t.status).toBe(exp.status);
      expect(failing).toEqual([...exp.failing].sort());
    });
  }
  it('covers every shipped scenario', () => {
    const covered = new Set(Object.keys(EXPECTED).map((k) => k.split('|')[0]));
    for (const m of SCENARIOS) expect(covered.has(m.scenario.id), m.scenario.id).toBe(true);
  });
});

describe('virtual time and fault semantics', () => {
  it('a retry that honors retryAfterMs starts exactly when the window ends', () => {
    const t = run('rate-limit-retry-after', 'corrected', 'rate-limited-window');
    const reqs = t.events.filter((e) => e.kind === 'tool.request');
    expect(reqs.map((r) => r.vt)).toEqual([0, 2005]);
    expect(t.events.at(-1)!.vt).toBeLessThan(3000);
  });
  it('timeouts fire at request time plus the declared timeout and late responses are kept', () => {
    const t = run('lost-response-duplicate-charge', 'faulty', 'slow-response');
    const timeout = t.events.find((e) => e.kind === 'tool.error' && (e.data as any).error.code === 'TIMEOUT')!;
    const req = t.events.find((e) => e.kind === 'tool.request' && e.tool === 'payments.charge')!;
    expect(timeout.vt - req.vt).toBe(1000);
    expect(t.events.some((e) => e.kind === 'tool.response.late')).toBe(true);
  });
  it('after-tool-commit faults leave the committed side effect in the state store', () => {
    const t = run('lost-response-duplicate-charge', 'faulty', 'lost-response');
    expect((t.finalState!.external.collections.charges ?? []).length).toBe(2);
    const fixed = run('lost-response-duplicate-charge', 'corrected', 'lost-response');
    expect((fixed.finalState!.external.collections.charges ?? []).length).toBe(1);
    expect(fixed.events.some((e) => e.kind === 'tool.dedup')).toBe(true);
  });
  it('parallel responses arrive in the order implied by latency and delay faults', () => {
    const t = run('parallel-out-of-order', 'faulty', 'slow-first');
    const order = t.events.filter((e) => e.kind === 'tool.response').map((e) => (e.data as any).value.accountId);
    expect(order).toEqual(['acc-2', 'acc-3', 'acc-1']);
  });
  it('no request starts after cancellation under the corrected policy', () => {
    const t = run('cancel-during-retry', 'corrected', 'cancel-in-backoff');
    const cancel = t.events.find((e) => e.kind === 'cancel.requested')!;
    expect(t.events.filter((e) => e.kind === 'tool.request' && e.seq > cancel.seq)).toEqual([]);
    expect(t.events.some((e) => e.kind === 'cancel.observed')).toBe(true);
  });
  it('blocked tools are recorded and never executed', () => {
    const t = run('untrusted-document-instructions', 'faulty', null);
    const blocked = t.events.filter((e) => e.kind === 'boundary.blocked').map((e) => e.tool);
    expect(blocked).toEqual(['crm.listCustomers', 'email.send']);
    expect(t.finalState!.external.collections.emails).toBeUndefined();
  });
  it('a fixture miss is an execution error, not a silent replay', () => {
    const m = mod('lost-response-duplicate-charge');
    const s: ScenarioDef = { ...m.scenario, triggers: [{ id: 'x', atMs: 0, payload: { orderId: 'Z-1' } }] };
    const t = runScenario(s, m.workflow, { policy: s.policies[0], faultPlan: null });
    expect(t.status).toBe('execution-error');
    expect(t.executionErrors[0].code).toBe('FIXTURE_MISS');
    expect(t.events.some((e) => e.kind === 'fixture.miss')).toBe(true);
  });
  it('engine limits stop runaway loops without workflow records', () => {
    const t = run('retry-limit-exhausted', 'faulty', 'dependency-down');
    expect(t.status).toBe('limit-exhausted');
    expect(t.events.some((e) => e.kind === 'limit.exhausted' && e.origin === 'engine')).toBe(true);
  });
  it('rejects a policy that does not match the workflow schema', () => {
    const m = mod('lost-response-duplicate-charge');
    expect(() => runScenario(m.scenario, m.workflow, { policy: { ...m.scenario.policies[0], values: { maxAttempts: 'many' } }, faultPlan: null })).toThrow(RunConfigError);
  });
});

describe('checkpoint forks', () => {
  const m = mod('lost-response-duplicate-charge');
  const parent = run('lost-response-duplicate-charge', 'faulty', 'lost-response');
  it('verifies the replayed prefix, links lineage, and changes behavior after the checkpoint', () => {
    const child = forkRun(m.scenario, m.workflow, parent, 'before-charge', { policy: m.scenario.policies[1] });
    expect(child.parentRunId).toBe(parent.id);
    expect(child.fork!.prefixVerified).toBe(true);
    expect(child.id).not.toBe(parent.id);
    expect(hashEvents(child.events.filter((e) => e.seq <= child.fork!.seq))).toBe(child.fork!.parentPrefixHash);
    expect((child.finalState!.external.collections.charges ?? []).length).toBe(1);
    expect((parent.finalState!.external.collections.charges ?? []).length).toBe(2);
  });
  it('can remove a fault after the checkpoint', () => {
    const child = forkRun(m.scenario, m.workflow, parent, 'before-charge', { faultPlan: null });
    expect((child.finalState!.external.collections.charges ?? []).length).toBe(1);
  });
  it('refuses undeclared checkpoints, changed scenarios and non-simulation parents', () => {
    expect(() => forkRun(m.scenario, m.workflow, parent, 'nope', {})).toThrow(ForkError);
    const changed = { ...m.scenario, seed: 999 };
    expect(() => forkRun(changed, m.workflow, parent, 'before-charge', {})).toThrow(/Scenario definition changed/);
    expect(() => forkRun(m.scenario, m.workflow, { ...parent, mode: 'playback' } as any, 'before-charge', {})).toThrow(ForkError);
  });
});
