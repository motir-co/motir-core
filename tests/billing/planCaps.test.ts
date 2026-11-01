import { describe, expect, it } from 'vitest';
import { BILLING_CATALOG, largerPoolPlans } from '@/lib/billing/catalog';
import {
  HOST_PLAN_KEY,
  HOST_FLOOR_CAPS,
  LARGER_POOL_FLOOR_CAPS,
  capsForPlanKey,
  type PlanCaps,
} from '@/lib/billing/planCaps';

// THE PLAN-CAPS TABLE (Story MOTIR-9363 · MOTIR-9372): the owner's figures per
// plan key (MOTIR-9357 as corrected at its gate, CI raised 2026-10-26 — MOTIR-9668), and the totality that keeps the table in step with the catalog.

function figures(c: PlanCaps | null): [number, number, number, number] | null {
  return c ? [c.agentRunsInParallel, c.agentsPerUser, c.agentsPerOrg, c.ciBurstCap] : null;
}

describe('capsForPlanKey — the table', () => {
  it.each([
    ['free', [0, 0, 0, 0]],
    ['standard', [1, 1, 2, 2]],
    ['pro', [3, 2, 10, 5]],
    ['max', [5, 3, 20, 10]],
    ['max_x2', [5, 3, 20, 15]],
    [HOST_PLAN_KEY, [5, 5, 20, 20]],
  ] as const)('%s → %j', (key, expected) => {
    expect(figures(capsForPlanKey(key))).toEqual(expected);
  });

  it('host takes its own floor (5/5/20/20), apart from the larger pools (MOTIR-9668)', () => {
    expect(capsForPlanKey(HOST_PLAN_KEY)).toBe(HOST_FLOOR_CAPS);
    expect(figures(HOST_FLOOR_CAPS)).toEqual([5, 5, 20, 20]);
  });

  it('every larger pool on sale takes the larger-pool floor (5/10/50/20) (MOTIR-9653)', () => {
    const onSale = largerPoolPlans();
    expect(onSale.length).toBeGreaterThan(0);
    for (const plan of onSale) {
      expect(capsForPlanKey(plan.key), plan.key).toBe(LARGER_POOL_FLOOR_CAPS);
    }
    expect(figures(LARGER_POOL_FLOOR_CAPS)).toEqual([5, 10, 50, 20]);
  });

  it('the six removed first rungs have no row (owner, 2026-10-26)', () => {
    for (const key of [
      'pool_80k',
      'pool_100k',
      'pool_120k',
      'pool_150k',
      'pool_200k',
      'pool_250k',
    ]) {
      expect(capsForPlanKey(key), key).toBeNull();
    }
  });

  it('a pool-shaped key the catalog does not sell has no row', () => {
    for (const key of ['pool_999k', 'pool_250k_extra', 'pool_700k', 'pool_60k']) {
      expect(capsForPlanKey(key), key).toBeNull();
    }
  });
});

describe('capsForPlanKey — totality, and never a default', () => {
  it('every AI plan in the catalog, plus host, has a row', () => {
    const keys = [...BILLING_CATALOG.aiPlans.map((p) => p.key as string), HOST_PLAN_KEY];
    const missing = keys.filter((key) => capsForPlanKey(key) === null);
    expect(missing, `plan keys with no caps row: ${missing.join(', ')}`).toEqual([]);
  });

  it.each(['legacy_tier', '', 'max_x3', 'pool_k', 'enterprise', 'MAX', 'pool_80k_extra'])(
    '%j has no row',
    (key) => {
      expect(capsForPlanKey(key)).toBeNull();
    },
  );

  it("max_x2 never resolves to max's row by prefix, nor max to max_x2's", () => {
    expect(capsForPlanKey('max_x2')!.ciBurstCap).toBe(15);
    expect(capsForPlanKey('max_x2')).not.toBe(capsForPlanKey('max'));
  });

  it('inherited object keys are not plans', () => {
    expect(capsForPlanKey('toString')).toBeNull();
    expect(capsForPlanKey('__proto__')).toBeNull();
  });
});
