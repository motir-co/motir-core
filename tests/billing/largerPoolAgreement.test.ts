import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckoutSessionOutcome } from '@/lib/ai/motirAiClient';
import type { BillingStatusDTO } from '@/lib/dto/billing';
import {
  BILLING_CATALOG,
  CHECKOUT_PRICE_LOOKUP_KEYS,
  hostMonthlyPlanCredits,
  isAllowedCheckoutQuantity,
  isKnownCheckoutPrice,
  isLargerPoolPlanKey,
  isPlanChangeKey,
  PLAN_CHANGE_KEYS,
  largerPoolCreditsForPrice,
  largerPoolPlans,
  maxMonthlyPlanCredits,
  type AiPlanCatalogEntry,
} from '@/lib/billing/catalog';
import { capsForPlanKey } from '@/lib/billing/planCaps';
import { buildOrgBill } from '@/lib/platform/orgBill';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';

// THE LARGER POOL, AGREED ON BY EVERY READER OF THE CATALOG (Story MOTIR-8986 ·
// MOTIR-8999). The catalogue derives the checkout allow-list, the quantity guard, the
// plan-change list and the ceiling from one array; the two service gates and the
// operator bill read it again. Each has its own suite with its own fixture. This one
// feeds the SHIPPED catalogue through all of them and asserts they agree on the band.
//
// Every expected pool and price is derived here from the Host entry and the top-up,
// by the rule the approved record MOTIR-8987 fixes with its anchor moved to Host
// (MOTIR-9366): monthly is Host's monthly price plus every credit above its pool at
// the top-up rate less the discount; annual is Host's own annual per-credit rate. No
// band figure is typed. The six rungs at or below Host are RETIRED: still in the
// catalogue for an org that holds one, off every sale-time list. The motir-ai client is the one external leaf, so it is mocked; the org is
// seeded through the real services against the real Postgres.

const createCheckoutSessionMock = vi.fn<(i: unknown) => Promise<CheckoutSessionOutcome>>();
vi.mock('@/lib/ai/motirAiClient', () => ({
  createCheckoutSession: (i: unknown) => createCheckoutSessionMock(i),
}));
vi.mock('@/lib/billing/seatSync', () => ({ enqueueScaledTrackerSeatSync: vi.fn() }));

const { billingService } = await import('@/lib/services/billingService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { createTestUser } = await import('../fixtures/userFixtures');
const { truncateAuthTables } = await import('../helpers/db');
const { LargerPoolAtOrBelowCeilingError } = await import('@/lib/billing/errors');

/** The record's discount on the top-up rate for every credit above the anchor (MOTIR-8987). */
const LARGER_POOL_DISCOUNT = 0.9;

type Cadence = 'monthly' | 'annual';
const CADENCES: Cadence[] = ['monthly', 'annual'];
const cents = (usd: number) => Math.round(usd * 100);
const poolOf = (p: AiPlanCatalogEntry) => p.allotment!.credits;
const priceCents = (p: AiPlanCatalogEntry, cadence: Cadence) => cents(p.prices![cadence].amountUsd);

const LADDER = BILLING_CATALOG.aiPlans
  .filter((p) => p.band === 'ladder' && p.prices && p.allotment?.cadence === 'monthly')
  .sort((a, b) => poolOf(a) - poolOf(b));
const TOP = LADDER[LADDER.length - 1]!;
const HOST = BILLING_CATALOG.aiPlans.find((p) => p.band === 'host')!;
const BAND = largerPoolPlans();
const RETIRED = BILLING_CATALOG.aiPlans.filter(
  (p) => p.band === 'larger_pool' && poolOf(p) <= poolOf(HOST),
);
const TOPUP = BILLING_CATALOG.creditTopup;

/** What the rule says a rung of `pool` credits costs, in cents, anchored on `anchor`. */
function ruleCents(pool: number, cadence: Cadence, anchor: AiPlanCatalogEntry = HOST): number {
  if (cadence === 'annual') {
    return Math.round((pool * priceCents(anchor, 'annual')) / poolOf(anchor));
  }
  const topupRate = cents(TOPUP.unitAmountUsd) / TOPUP.unitCredits;
  return Math.round(
    priceCents(anchor, 'monthly') + (pool - poolOf(anchor)) * topupRate * LARGER_POOL_DISCOUNT,
  );
}

const rungKeys = (plans: AiPlanCatalogEntry[]) =>
  plans.flatMap((p) => CADENCES.map((c) => p.prices![c].priceLookupKey));

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

async function makeOwnerOrg() {
  const owner = await createTestUser();
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: owner.id,
  });
  const { organizationId } = await adminDb.workspace.findUniqueOrThrow({
    where: { id: workspace.id },
  });
  return { organizationId, actorUserId: owner.id };
}

function statusOn(plan: AiPlanCatalogEntry, cadence: Cadence): Omit<BillingStatusDTO, 'access'> {
  const tier = { key: plan.key, name: plan.name, monthlyCreditAllotment: poolOf(plan) };
  return {
    organizationId: 'org_1',
    isMeta: false,
    internalBilling: false,
    motir: { scaledTrackerSubscription: null, aiIncludedSeat: true },
    motirAi: {
      tier,
      balance: 0,
      pendingDowngrade: null,
      subscription: {
        status: 'active',
        currentPeriodEnd: '2026-11-22T00:00:00.000Z',
        priceId: plan.prices![cadence].priceLookupKey,
        planTier: tier,
      },
    },
    ci: { chargedCredits: 0 } as never,
    search: { monthSpend: 0, totalSpend: 0 } as never,
    agents: { spend: { machineMonthSpend: 0, storageMonthSpend: 0 }, hasPaidAiPlan: true },
    catalog: BILLING_CATALOG,
  };
}

beforeEach(async () => {
  await truncateAuthTables();
  createCheckoutSessionMock.mockReset();
  createCheckoutSessionMock.mockResolvedValue({
    outcome: 'session',
    url: 'https://checkout.stripe.com/c/pay/cs_1',
  });
  process.env['MOTIR_CLOUD'] = 'true';
  process.env['MOTIR_BASE_URL'] = 'https://app.test';
});
afterEach(() => {
  delete process.env['MOTIR_CLOUD'];
  delete process.env['MOTIR_BASE_URL'];
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the band, the Host floor and the ceiling', () => {
  it('the band is real, ascending, and strictly above a Host floor read from its entry', () => {
    expect(BAND.length).toBeGreaterThan(0);
    expect(hostMonthlyPlanCredits()).toBe(poolOf(HOST));
    for (const rung of BAND) expect(poolOf(rung)).toBeGreaterThan(hostMonthlyPlanCredits());
    expect(poolOf(BAND[0]!)).toBeGreaterThanOrEqual(2 * hostMonthlyPlanCredits());
    const pools = BAND.map(poolOf);
    expect(pools).toEqual([...new Set(pools)].sort((a, b) => a - b));
  });

  it('the ladder ceiling did not follow the floor: it is still the ladder top', () => {
    expect(maxMonthlyPlanCredits()).toBe(poolOf(TOP));
    expect(maxMonthlyPlanCredits()).toBeLessThan(hostMonthlyPlanCredits());
  });

  it('the band is exactly the five Host-anchored rungs, and the plan-change list is in pool order', () => {
    expect(BAND.map((p) => p.key)).toEqual([
      'pool_600k',
      'pool_900k',
      'pool_1200k',
      'pool_1800k',
      'pool_2400k',
    ]);
    expect(PLAN_CHANGE_KEYS).toEqual([
      ...LADDER.map((p) => p.key),
      HOST.key,
      ...BAND.map((p) => p.key),
    ]);
  });

  it('every rung is a whole step of the ladder’s own grain, and its keys name its pool', () => {
    const grain = LADDER.map(poolOf).reduce(gcd);
    for (const rung of BAND) {
      expect(poolOf(rung) % grain, rung.key).toBe(0);
      for (const cadence of CADENCES) {
        const key = rung.prices![cadence].priceLookupKey;
        expect(key, rung.key).toBe(`${rung.key}_pool_${cadence}`);
        expect(largerPoolCreditsForPrice(key), key).toBe(poolOf(rung));
        expect(isLargerPoolPlanKey(key), key).toBe(true);
      }
    }
    for (const plan of LADDER) {
      expect(isLargerPoolPlanKey(plan.prices!.monthly.priceLookupKey), plan.key).toBe(false);
    }
  });
});

describe('the prices — derived, never typed', () => {
  it('the ladder is linear: one monthly rate, one annual multiple, the top-up’s rate', () => {
    const rates = new Set(LADDER.map((p) => priceCents(p, 'monthly') / poolOf(p)));
    const multiples = new Set(
      LADDER.map((p) => priceCents(p, 'annual') / priceCents(p, 'monthly')),
    );
    expect(rates.size).toBe(1);
    expect(multiples.size).toBe(1);
    expect([...rates][0]).toBe(cents(TOPUP.unitAmountUsd) / TOPUP.unitCredits);
  });

  it.each(CADENCES)('every rung is priced on the recorded rule, %s', (cadence) => {
    for (const rung of BAND) {
      expect(priceCents(rung, cadence), rung.key).toBe(ruleCents(poolOf(rung), cadence));
    }
  });

  it('a rung costs more than Host, and no more per credit, on both cadences', () => {
    for (const rung of BAND) {
      for (const cadence of CADENCES) {
        expect(priceCents(rung, cadence), `${rung.key} ${cadence}`).toBeGreaterThan(
          priceCents(HOST, cadence),
        );
        expect(
          priceCents(rung, cadence) / poolOf(rung),
          `${rung.key} ${cadence}`,
        ).toBeLessThanOrEqual(priceCents(HOST, cadence) / poolOf(HOST));
      }
    }
  });
});

describe('the allow-lists carry exactly the band', () => {
  it('both directions: every rung key is sellable, and every sellable pool key is a rung', () => {
    const fromBand = new Set(BAND.flatMap((p) => CADENCES.map((c) => p.prices![c].priceLookupKey)));
    const poolKeys = new Set(
      [...CHECKOUT_PRICE_LOOKUP_KEYS].filter((k) => largerPoolCreditsForPrice(k) !== null),
    );
    expect(poolKeys).toEqual(fromBand);
    for (const key of fromBand) {
      expect(isKnownCheckoutPrice(key), key).toBe(true);
      expect(isAllowedCheckoutQuantity(key, 1), key).toBe(true);
      expect(isAllowedCheckoutQuantity(key, 2), key).toBe(false);
    }
    for (const rung of BAND) expect(isPlanChangeKey(rung.key), rung.key).toBe(true);
  });
});

describe('the service gates read the catalogue, not a second list', () => {
  it('starts Checkout for every rung key, once, at quantity 1', async () => {
    const actor = await makeOwnerOrg();
    for (const rung of BAND) {
      for (const cadence of CADENCES) {
        const key = rung.prices![cadence].priceLookupKey;
        createCheckoutSessionMock.mockClear();
        await billingService.startCheckout({ ...actor, priceLookupKey: key });
        expect(createCheckoutSessionMock, key).toHaveBeenCalledTimes(1);
        expect(createCheckoutSessionMock.mock.calls[0]![0]).toMatchObject({
          priceId: key,
          quantity: 1,
        });
      }
    }
  });

  it('refuses a pool key naming exactly Host’s pool as at-or-below the floor, and calls nothing', async () => {
    const actor = await makeOwnerOrg();
    const atFloor = `pool_${hostMonthlyPlanCredits() / 1000}k_pool_monthly`;
    const refusal = billingService.startCheckout({ ...actor, priceLookupKey: atFloor });
    await expect(refusal).rejects.toBeInstanceOf(LargerPoolAtOrBelowCeilingError);
    await expect(refusal).rejects.toMatchObject({
      requestedCredits: hostMonthlyPlanCredits(),
      ceilingCredits: hostMonthlyPlanCredits(),
    });
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it('accepts every rung as a change of plan and refuses the top-up', async () => {
    const actor = await makeOwnerOrg();
    for (const rung of BAND) {
      await expect(
        billingService.assertPlanChangeAllowed({ ...actor, toPlanKey: rung.key }),
      ).resolves.toBeUndefined();
    }
    await expect(
      billingService.assertPlanChangeAllowed({ ...actor, toPlanKey: TOPUP.priceLookupKey }),
    ).rejects.toMatchObject({ reason: 'unknown_plan' });
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });
});

describe('the operator bill quotes the catalogue', () => {
  it.each(CADENCES)('every rung bills its own entry on %s', (cadence) => {
    for (const rung of BAND) {
      const bill = buildOrgBill(statusOn(rung, cadence), 1);
      expect(bill.money, rung.key).toEqual([
        {
          key: 'aiPlan',
          basis: { credits: poolOf(rung), cadence },
          amountCents: priceCents(rung, cadence),
        },
      ]);
      expect(bill.totalCents, rung.key).toBe(priceCents(rung, cadence));
    }
  });
});

describe('the band moved nothing below it', () => {
  it('the ladder and Host still sell, change and bill as their own entries say', () => {
    for (const plan of [...LADDER, HOST]) {
      expect(isPlanChangeKey(plan.key), plan.key).toBe(true);
      for (const cadence of CADENCES) {
        expect(isKnownCheckoutPrice(plan.prices![cadence].priceLookupKey), plan.key).toBe(true);
        expect(buildOrgBill(statusOn(plan, cadence), 1).totalCents, plan.key).toBe(
          priceCents(plan, cadence),
        );
      }
    }
  });

  it('the top-up still takes its bundles only, and is never a plan', () => {
    for (const units of TOPUP.bundleUnits) {
      expect(isAllowedCheckoutQuantity(TOPUP.priceLookupKey, units)).toBe(true);
    }
    expect(isAllowedCheckoutQuantity(TOPUP.priceLookupKey, 2)).toBe(false);
    expect(isPlanChangeKey(TOPUP.priceLookupKey)).toBe(false);
  });
});

describe('the retired rungs: off sale, still resolvable for a holder', () => {
  it('the six rungs at or below Host are still in the catalogue, priced on the old Max ×2 rule', () => {
    expect(RETIRED.map((p) => p.key)).toEqual([
      'pool_80k',
      'pool_100k',
      'pool_120k',
      'pool_150k',
      'pool_200k',
      'pool_250k',
    ]);
    for (const rung of RETIRED) {
      expect(poolOf(rung), rung.key).toBeGreaterThan(maxMonthlyPlanCredits());
      expect(largerPoolCreditsForPrice(rung.prices!.monthly.priceLookupKey)).toBe(poolOf(rung));
      for (const cadence of CADENCES) {
        expect(rung.prices![cadence].priceLookupKey).toBe(`${rung.key}_pool_${cadence}`);
        expect(priceCents(rung, cadence), `${rung.key} ${cadence}`).toBe(
          ruleCents(poolOf(rung), cadence, TOP),
        );
      }
    }
  });

  it('none of their twelve keys is on either allow-list', () => {
    const keys = rungKeys(RETIRED);
    expect(keys).toHaveLength(12);
    for (const key of keys) {
      expect(CHECKOUT_PRICE_LOOKUP_KEYS.has(key), key).toBe(false);
      expect(isKnownCheckoutPrice(key), key).toBe(false);
      expect(isLargerPoolPlanKey(key), key).toBe(false);
    }
    for (const rung of RETIRED) expect(isPlanChangeKey(rung.key), rung.key).toBe(false);
  });

  it('Checkout refuses every retired key with the at-or-below error, floored at Host', async () => {
    const actor = await makeOwnerOrg();
    for (const key of rungKeys(RETIRED)) {
      const refusal = billingService.startCheckout({ ...actor, priceLookupKey: key });
      await expect(refusal, key).rejects.toBeInstanceOf(LargerPoolAtOrBelowCeilingError);
      await expect(refusal, key).rejects.toMatchObject({
        ceilingCredits: hostMonthlyPlanCredits(),
      });
    }
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it.each(CADENCES)(
    'an org that holds one is still billed at its own entry, and capped, on %s',
    (cadence) => {
      for (const rung of RETIRED) {
        const bill = buildOrgBill(statusOn(rung, cadence), 1);
        expect(bill.money, rung.key).toEqual([
          {
            key: 'aiPlan',
            basis: { credits: poolOf(rung), cadence },
            amountCents: priceCents(rung, cadence),
          },
        ]);
        expect(capsForPlanKey(rung.key), rung.key).not.toBeNull();
      }
    },
  );
});
