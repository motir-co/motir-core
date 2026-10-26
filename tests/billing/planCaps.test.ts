import { describe, expect, it } from 'vitest';
import { BILLING_CATALOG, largerPoolPlans } from '@/lib/billing/catalog';
import {
  HOST_PLAN_KEY,
  OWN_ACCOUNT_FLOOR_CAPS,
  RETIRED_POOL_CAPS,
  capsForPlanKey,
  type PlanCaps,
} from '@/lib/billing/planCaps';

// THE PLAN-CAPS TABLE (Story MOTIR-9363 · MOTIR-9372): the owner's figures per
// plan key, and the totality that keeps the table in step with the catalog.

function figures(c: PlanCaps | null): [number, number, number, number] | null {
  return c ? [c.agentRunsInParallel, c.agentsPerUser, c.agentsRunningPerOrg, c.ciBurstCap] : null;
}

describe('capsForPlanKey — the table', () => {
  it.each([
    ['free', [0, 0, 0, 0]],
    ['standard', [1, 1, 5, 5]],
    ['pro', [3, 5, 30, 10]],
    ['max', [5, 10, 50, 25]],
    ['max_x2', [5, 10, 50, 25]],
    [HOST_PLAN_KEY, [5, 10, 50, 50]],
  ] as const)('%s → %j', (key, expected) => {
    expect(figures(capsForPlanKey(key))).toEqual(expected);
  });

  it('host and every larger pool on sale take the own-accounts floor (5/10/50/50) (MOTIR-9653)', () => {
    const onSale = largerPoolPlans();
    expect(onSale.length).toBeGreaterThan(0);
    expect(capsForPlanKey(HOST_PLAN_KEY)).toBe(OWN_ACCOUNT_FLOOR_CAPS);
    for (const plan of onSale) {
      expect(capsForPlanKey(plan.key), plan.key).toBe(OWN_ACCOUNT_FLOOR_CAPS);
    }
    expect(figures(OWN_ACCOUNT_FLOOR_CAPS)).toEqual([5, 10, 50, 50]);
  });

  it('the six retired rungs take the retired row (5/10/50/50), by their exact keys', () => {
    const onSale = new Set(largerPoolPlans().map((p) => p.key));
    const retired = BILLING_CATALOG.aiPlans.filter(
      (p) => p.band === 'larger_pool' && !onSale.has(p.key),
    );
    expect(retired.map((p) => p.key)).toEqual([
      'pool_80k',
      'pool_100k',
      'pool_120k',
      'pool_150k',
      'pool_200k',
      'pool_250k',
    ]);
    for (const plan of retired) expect(capsForPlanKey(plan.key), plan.key).toBe(RETIRED_POOL_CAPS);
    expect(figures(RETIRED_POOL_CAPS)).toEqual([5, 10, 50, 50]);
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
    expect(capsForPlanKey('max_x2')!.ciBurstCap).toBe(25);
    expect(capsForPlanKey('max_x2')).not.toBe(capsForPlanKey('max'));
  });

  it('inherited object keys are not plans', () => {
    expect(capsForPlanKey('toString')).toBeNull();
    expect(capsForPlanKey('__proto__')).toBeNull();
  });
});
