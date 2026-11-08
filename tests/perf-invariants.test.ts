import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { resolveFixture } from '../src/engine/fixtures';
import { Sha256, canonicalize, CanonicalizationError, sha256 } from '../src/engine/hash';
import { compareRuns } from '../src/engine/compare';
import { forkRun, hashEvents, prefixHashes, runScenario } from '../src/engine/runner';
import { duplicateCharge } from '../src/scenarios/catalog/side-effects';
import { getScenario } from '../src/scenarios/index';
import { scaledFaults, scaledScenario } from '../bench/scale';

describe('optimizations keep exact results', () => {
  it('incremental SHA-256 matches node:crypto for every split point and length', () => {
    for (const len of [0, 1, 55, 56, 63, 64, 65, 127, 128, 1000]) {
      const text = 'é'.repeat(len % 7) + 'x'.repeat(len);
      const want = createHash('sha256').update(text).digest('hex');
      expect(sha256(text)).toBe(want);
      const bytes = new TextEncoder().encode(text);
      for (const cut of [0, 1, 33, 64, bytes.length]) {
        if (cut > bytes.length) continue;
        const h = new Sha256().update(bytes.subarray(0, cut));
        const c = h.clone();
        expect(h.update(bytes.subarray(cut)).digest()).toBe(want);
        expect(c.update(bytes.subarray(cut)).digest()).toBe(want);
      }
    }
  });

  it('canonicalize still names the offending path for unsupported values', () => {
    expect(() => canonicalize({ a: [1, { b: Number.NaN }] })).toThrow(CanonicalizationError);
    expect(() => canonicalize({ a: [1, { b: Number.NaN }] })).toThrow('$.a[1].b');
    expect(canonicalize({ b: 1, a: [undefined, -0], c: undefined })).toBe('{"a":[null,0],"b":1}');
  });

  it('prefixHashes equals hashEvents of each prefix', () => {
    const m = getScenario('lost-response-duplicate-charge')!;
    const t = runScenario(m.scenario, m.workflow, { policy: m.scenario.policies[0], faultPlan: m.scenario.faultPresets[0] });
    const seqs = [1, 5, 6, t.events.length];
    const got = prefixHashes(t.events, seqs);
    for (const s of seqs) expect(got.get(s)).toBe(hashEvents(t.events.filter((e) => e.seq <= s)));
    expect(t.checkpoints[0].prefixHash).toBe(hashEvents(t.events.filter((e) => e.seq <= t.checkpoints[0].seq)));
    const fork = forkRun(m.scenario, m.workflow, t, 'before-charge', { policy: m.scenario.policies[1] });
    expect(fork.fork?.prefixVerified).toBe(true);
    // The fork resume note is an engine annotation; the first behavioral divergence is the keyed charge request.
    const d = compareRuns(t, fork).firstDivergence!;
    expect(d.b?.kind).toBe('tool.request');
    expect(d.description).toMatch(/idempotencyKey/);
  });

  it('indexed fixture lookup reports the same misses and ambiguities as a scan', () => {
    const s = duplicateCharge.scenario;
    const state = { kv: {}, collections: {} } as any;
    const miss = resolveFixture(s.fixtures, { tool: 'orders.get', args: { orderId: 'nope' }, occurrence: 1 }, state);
    expect(miss).toMatchObject({ kind: 'miss', nearest: ['order-1001'] });
    const dup = [...s.fixtures, { ...s.fixtures[0], id: 'order-1001-copy' }];
    expect(resolveFixture(dup, { tool: 'orders.get', args: { orderId: 'A-1001' }, occurrence: 1 }, state)).toEqual({ kind: 'ambiguous', candidates: ['order-1001', 'order-1001-copy'], score: 4 });
    expect(resolveFixture(s.fixtures, { tool: 'payments.charge', args: { orderId: 'A-1001', amountCents: 4200, idempotencyKey: 'k' }, occurrence: 2 }, state)).toMatchObject({ kind: 'match', score: 2 });
  });

  it('a 10k-event simulation stays reproducible and finishes in bounded time', () => {
    const sc = scaledScenario(760);
    const t0 = performance.now();
    const a = runScenario(sc, duplicateCharge.workflow, { policy: sc.policies[0], faultPlan: scaledFaults(760, 10) });
    const ms = performance.now() - t0;
    const b = runScenario(sc, duplicateCharge.workflow, { policy: sc.policies[0], faultPlan: scaledFaults(760, 10) });
    expect(a.events.length).toBeGreaterThanOrEqual(10_000);
    expect(a.hashes).toEqual(b.hashes);
    expect(ms).toBeLessThan(5000); // generous bound for slow CI; measured ~0.5 s locally
  });
});
