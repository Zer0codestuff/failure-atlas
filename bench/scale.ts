import { duplicateCharge } from '../src/scenarios/catalog/side-effects';
import type { FaultPlan, FixtureEntry, ScenarioDef, TriggerDef } from '../src/engine/types';
import { SCHEMAS } from '../src/engine/types';

/**
 * A scaled copy of the duplicate-charge scenario: `orders` independent checkouts handled by
 * the same workflow, each with its own fixtures. Used only for measurement; it is generated,
 * synthetic, and never shipped in the scenario rail.
 */
export function scaledScenario(orders: number): ScenarioDef {
  const base = duplicateCharge.scenario;
  const fixtures: FixtureEntry[] = [];
  const triggers: TriggerDef[] = [];
  for (let i = 1; i <= orders; i++) {
    const id = `B-${String(i).padStart(5, '0')}`;
    const amount = 1000 + ((i * 37) % 9000);
    fixtures.push(
      { id: `order-${id}`, tool: 'orders.get', match: { args: { orderId: id } }, response: { ok: true, value: { orderId: id, amountCents: amount } }, latencyMs: 20 + (i % 7) * 5 },
      {
        id: `charge-${id}`, tool: 'payments.charge', match: { argsFields: { orderId: id, amountCents: amount } }, response: { ok: true, value: { chargeId: `ch_${id}`, status: 'succeeded' } }, latencyMs: 200 + (i % 5) * 20,
        writes: [{ op: 'insert', collection: 'charges', record: { orderId: '{{args.orderId}}', amountCents: '{{args.amountCents}}', request: '{{request.id}}' } }],
      },
      {
        id: `receipt-${id}`, tool: 'receipts.send', match: { args: { orderId: id, chargeId: `ch_${id}` } }, response: { ok: true, value: { receiptId: `rc_${id}` } }, latencyMs: 40,
        writes: [{ op: 'insert', collection: 'receipts', record: { orderId: '{{args.orderId}}', chargeId: '{{args.chargeId}}' } }],
      },
    );
    triggers.push({ id: `checkout-${id}`, atMs: i * 25, payload: { orderId: id } });
  }
  return {
    ...base,
    id: `bench-scaled-checkout-${orders}`,
    title: `Scaled checkout (${orders} orders)`,
    summary: 'Generated benchmark input: many independent checkouts through the duplicate-charge workflow.',
    fixtures,
    triggers,
    checkpoints: [],
    limits: { maxSteps: orders * 40, maxVirtualMs: orders * 25 + 120_000 },
    notes: ['Generated for benchmarks only.'],
  };
}

/** Drop the first charge response for every `every`-th charge request. */
export function scaledFaults(orders: number, every: number): FaultPlan {
  const occurrences: number[] = [];
  for (let i = 1; i <= orders; i += every) occurrences.push(i);
  return {
    schema: SCHEMAS.faultPlan,
    id: `lost-every-${every}`,
    title: `Response lost for every ${every}th charge`,
    description: 'Benchmark fault plan.',
    faults: [{ id: 'drop-charge-responses', description: `Drop ${occurrences.length} charge responses after commit`, point: 'after-tool-commit', target: { tool: 'payments.charge', occurrences }, effect: { type: 'drop-response' } }],
  };
}
