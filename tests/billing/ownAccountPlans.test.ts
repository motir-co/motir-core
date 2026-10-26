import { describe, expect, it } from 'vitest';
import { BILLING_CATALOG, hostMonthlyPlanCredits, largerPoolPlans } from '@/lib/billing/catalog';
import { ownAccountPoolCredits, planCarriesOwnAccounts } from '@/lib/billing/ownAccountPlans';
import { HOST_PLAN_KEY } from '@/lib/billing/planCaps';
import {
  HOST_ACCOUNT_RAISE_TARGET_VCPU,
  HOST_ACCOUNT_SLOTS,
  hostAccountPlan,
  ownAccountRaiseTargetVcpu,
} from '@/lib/ciFleet/hostAccounts';

// WHICH PLANS CARRY THEIR OWN AWS ACCOUNTS, AND HOW BIG A QUOTA EACH ASKS FOR
// (MOTIR-9651). The on-sale set is read from the catalog, never typed: Host and
// every rung `largerPoolPlans()` returns carry the accounts; the ladder, Free, the
// keys of the six removed rungs and an unknown key do not. Every expected target is derived from
// the catalog and the three Host bases.

const ON_SALE = new Set([HOST_PLAN_KEY, ...largerPoolPlans().map((p) => p.key)]);
const poolOf = (key: string) =>
  BILLING_CATALOG.aiPlans.find((p) => p.key === key)!.allotment!.credits;

describe('planCarriesOwnAccounts', () => {
  it.each(BILLING_CATALOG.aiPlans.map((p) => p.key))('%s', (key) => {
    expect(planCarriesOwnAccounts(key)).toBe(ON_SALE.has(key));
  });

  it('is true for Host and the five on-sale rungs, and false for the ladder and the removed six', () => {
    expect(ON_SALE.size).toBe(1 + largerPoolPlans().length);
    for (const key of ['free', 'standard', 'pro', 'max', 'max_x2']) {
      expect(planCarriesOwnAccounts(key), key).toBe(false);
    }
    for (const key of [
      'pool_80k',
      'pool_100k',
      'pool_120k',
      'pool_150k',
      'pool_200k',
      'pool_250k',
    ]) {
      expect(planCarriesOwnAccounts(key), key).toBe(false);
    }
  });

  it('is false for an unknown key, a rung-shaped key no rung carries, and a lookup key', () => {
    for (const key of [
      'enterprise',
      'pool_700k',
      'host_pool_monthly',
      'pool_600k_pool_monthly',
      '',
    ]) {
      expect(planCarriesOwnAccounts(key), key).toBe(false);
      expect(ownAccountPoolCredits(key), key).toBeNull();
    }
  });
});

describe('ownAccountPoolCredits', () => {
  it('reads each own-accounts plan’s pool from its catalog entry', () => {
    for (const key of ON_SALE) expect(ownAccountPoolCredits(key), key).toBe(poolOf(key));
    expect(ownAccountPoolCredits(HOST_PLAN_KEY)).toBe(hostMonthlyPlanCredits());
  });
});

describe('ownAccountRaiseTargetVcpu', () => {
  it('asks the Host bases at Host’s pool', () => {
    for (const slot of HOST_ACCOUNT_SLOTS) {
      expect(ownAccountRaiseTargetVcpu(slot, hostMonthlyPlanCredits()), slot).toBe(
        HOST_ACCOUNT_RAISE_TARGET_VCPU[slot],
      );
    }
    expect(HOST_ACCOUNT_RAISE_TARGET_VCPU).toEqual({
      ci_runner: 200,
      agent_runner: 32,
      merged: 120,
    });
  });

  it('scales CI and the agent runner with the pool, and keeps the merged account at its base', () => {
    for (const rung of largerPoolPlans()) {
      const pool = rung.allotment!.credits;
      const scale = pool / hostMonthlyPlanCredits();
      expect(ownAccountRaiseTargetVcpu('ci_runner', pool), rung.key).toBe(
        Math.ceil(HOST_ACCOUNT_RAISE_TARGET_VCPU.ci_runner * scale),
      );
      expect(ownAccountRaiseTargetVcpu('agent_runner', pool), rung.key).toBe(
        Math.ceil(HOST_ACCOUNT_RAISE_TARGET_VCPU.agent_runner * scale),
      );
      expect(ownAccountRaiseTargetVcpu('merged', pool), rung.key).toBe(
        HOST_ACCOUNT_RAISE_TARGET_VCPU.merged,
      );
    }
  });

  it('gives 400 / 64 / 120 at 600,000 and 1,600 / 256 / 120 at 2,400,000', () => {
    const targets = (pool: number) =>
      HOST_ACCOUNT_SLOTS.map((s) => ownAccountRaiseTargetVcpu(s, pool));
    expect(targets(poolOf('pool_600k'))).toEqual([400, 64, 120]);
    expect(targets(poolOf('pool_2400k'))).toEqual([1_600, 256, 120]);
  });

  it('rounds up a pool that is not a whole multiple of Host’s', () => {
    const pool = hostMonthlyPlanCredits() + 1;
    expect(ownAccountRaiseTargetVcpu('ci_runner', pool)).toBe(
      HOST_ACCOUNT_RAISE_TARGET_VCPU.ci_runner + 1,
    );
  });
});

describe('hostAccountPlan', () => {
  it('names the slot by the organisation only, whatever the plan, and sizes its raise by the pool', () => {
    for (const slot of HOST_ACCOUNT_SLOTS) {
      const atHost = hostAccountPlan('org_A', slot, hostMonthlyPlanCredits());
      const atTop = hostAccountPlan('org_A', slot, poolOf('pool_2400k'));
      expect(atTop.account).toEqual(atHost.account);
      expect(atTop.sharedRow).toEqual(atHost.sharedRow);
      expect(atTop.raiseTargetVcpu).toBe(ownAccountRaiseTargetVcpu(slot, poolOf('pool_2400k')));
    }
  });
});
