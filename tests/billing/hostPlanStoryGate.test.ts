import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckoutSessionOutcome } from '@/lib/ai/motirAiClient';
import type { BillingStatusDTO } from '@/lib/dto/billing';
import {
  BILLING_CATALOG,
  CHECKOUT_PRICE_LOOKUP_KEYS,
  PLAN_CHANGE_KEYS,
  isAllowedCheckoutQuantity,
  isKnownCheckoutPrice,
  isLargerPoolPlanKey,
  isPlanChangeKey,
  largerPoolCreditsForPrice,
  largerPoolPlans,
  maxMonthlyPlanCredits,
  planChangeKeysOf,
  type AiPlanCatalogEntry,
} from '@/lib/billing/catalog';
import { buildOrgBill } from '@/lib/platform/orgBill';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';

// STORY MOTIR-9364's INTEGRATION GATE (MOTIR-9406) — Host, a regular plan of 300,000
// credits, agreed on by every reader of the one catalog array. The catalog card
// (MOTIR-9398), the copy card (MOTIR-9404) and the plan-row card (MOTIR-9403) each
// tested their own half; this file feeds the SHIPPED catalog, Host in it, through
// the catalog's derivations, the checkout and change-of-plan services and the
// operator bill, and asserts that Host is what its entry says and that it moved
// nothing that is not Host.
//
// No band figure is typed except Host's own: every pre-Host answer is the same
// derivation over the catalog with the `host` entry removed, re-implemented here as
// `largerPoolAgreement.test.ts` builds its ladder and band. The motir-ai client is
// the one external leaf, so it is mocked (with the seat-sync enqueue); the orgs are
// seeded through the real services on the real Postgres. The Calculator and the
// plans view in every locale are `hostPlanStoryGate.ui.test.tsx`.

const ai = vi.hoisted(() => ({
  createCheckoutSession: vi.fn<(i: unknown) => Promise<CheckoutSessionOutcome>>(),
  previewPlanUpgrade: vi.fn(),
  upgradePlan: vi.fn(),
  previewPlanDowngrade: vi.fn(),
  schedulePlanDowngrade: vi.fn(),
}));
vi.mock('@/lib/ai/motirAiClient', () => ({
  createCheckoutSession: (i: unknown) => ai.createCheckoutSession(i),
  previewPlanUpgrade: (i: unknown) => ai.previewPlanUpgrade(i),
  upgradePlan: (i: unknown) => ai.upgradePlan(i),
  previewPlanDowngrade: (i: unknown) => ai.previewPlanDowngrade(i),
  schedulePlanDowngrade: (i: unknown) => ai.schedulePlanDowngrade(i),
}));
vi.mock('@/lib/billing/seatSync', () => ({ enqueueScaledTrackerSeatSync: vi.fn() }));

const { billingService } = await import('@/lib/services/billingService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { createTestUser } = await import('../fixtures/userFixtures');
const { truncateAuthTables } = await import('../helpers/db');

type Cadence = 'monthly' | 'annual';
const CADENCES: Cadence[] = ['monthly', 'annual'];
const cents = (usd: number) => Math.round(usd * 100);
const poolOf = (p: AiPlanCatalogEntry) => p.allotment!.credits;
const priceCents = (p: AiPlanCatalogEntry, cadence: Cadence) => cents(p.prices![cadence].amountUsd);
const keysOf = (p: AiPlanCatalogEntry) => CADENCES.map((c) => p.prices![c].priceLookupKey);

const HOST = BILLING_CATALOG.aiPlans.find((p) => p.key === 'host')!;
/** The catalog as it stood before the story: the same array, Host removed. */
const PRE_HOST = BILLING_CATALOG.aiPlans.filter((p) => p.key !== 'host');

// The catalog's one-line derivations, over `entries` — the pre-Host answer when fed PRE_HOST.
const sellable = (p: AiPlanCatalogEntry) => p.prices !== null && p.allotment?.cadence === 'monthly';
const ladderOf = (entries: readonly AiPlanCatalogEntry[]) =>
  entries.filter((p) => p.band === 'ladder');
const ceilingOf = (entries: readonly AiPlanCatalogEntry[]) =>
  Math.max(...ladderOf(entries).flatMap((p) => (sellable(p) ? [poolOf(p)] : [])));
const bandOf = (entries: readonly AiPlanCatalogEntry[]) =>
  entries
    .filter((p) => p.band === 'larger_pool' && sellable(p) && poolOf(p) > ceilingOf(entries))
    .sort((a, b) => poolOf(a) - poolOf(b));
const checkoutKeysOf = (entries: readonly AiPlanCatalogEntry[]) => [
  ...[...ladderOf(entries), ...bandOf(entries)].flatMap((p) => (p.prices ? keysOf(p) : [])),
  ...CADENCES.map((c) => BILLING_CATALOG.seatPlan.prices[c].priceLookupKey),
  BILLING_CATALOG.creditTopup.priceLookupKey,
];

const LADDER = ladderOf(PRE_HOST).filter(sellable);
const BAND = bandOf(PRE_HOST);
const TOP_RUNG = BAND[BAND.length - 1]!;
/** The ladder's top, the plan Host sits above in the change of plan. */
const TOP = LADDER.reduce((a, b) => (poolOf(b) > poolOf(a) ? b : a));

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
  for (const fn of Object.values(ai)) fn.mockReset();
  ai.createCheckoutSession.mockResolvedValue({
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

describe('Host is what the requirement says, in a band of its own', () => {
  it('300,000 credits a month, $1,500 monthly and $12,000 annual, one included seat', () => {
    expect(HOST).toMatchObject({ band: 'host', includedTrackerSeats: 1 });
    expect(HOST.allotment).toEqual({ credits: 300_000, cadence: 'monthly' });
    expect(HOST.prices).toEqual({
      monthly: { amountUsd: 1_500, priceLookupKey: 'host_pool_monthly' },
      annual: { amountUsd: 12_000, priceLookupKey: 'host_pool_annual' },
    });
  });
});

describe('the ceiling and the rungs did not move', () => {
  it('the ceiling is still the ladder’s top, and the rungs are still the larger pools above it', () => {
    expect(maxMonthlyPlanCredits()).toBe(ceilingOf(PRE_HOST));
    expect(maxMonthlyPlanCredits()).toBe(Math.max(...LADDER.map(poolOf)));
    expect(largerPoolPlans().map((p) => p.key)).toEqual(BAND.map((p) => p.key));
    expect(BAND.length).toBeGreaterThan(0);
    expect(maxMonthlyPlanCredits()).not.toBe(poolOf(HOST));
    expect(largerPoolPlans().map((p) => p.key)).not.toContain(HOST.key);
  });
});

describe('the allow-lists gained exactly Host', () => {
  it('Checkout admits the pre-Host keys plus Host’s two, and removes none', () => {
    const before = new Set(checkoutKeysOf(PRE_HOST));
    expect(new Set(CHECKOUT_PRICE_LOOKUP_KEYS)).toEqual(new Set([...before, ...keysOf(HOST)]));
    for (const key of before) expect(isKnownCheckoutPrice(key), key).toBe(true);
    for (const plan of [...LADDER, ...BAND]) {
      for (const key of keysOf(plan)) expect(CHECKOUT_PRICE_LOOKUP_KEYS.has(key), key).toBe(true);
    }
  });

  it('the change of plan accepts the pre-Host keys plus host, ascending, host last', () => {
    const before = planChangeKeysOf([...ladderOf(PRE_HOST), ...BAND]);
    expect([...PLAN_CHANGE_KEYS]).toEqual([...before, HOST.key]);
    const pools = PLAN_CHANGE_KEYS.map((k) =>
      poolOf(BILLING_CATALOG.aiPlans.find((p) => p.key === k)!),
    );
    expect(pools).toEqual([...pools].sort((a, b) => a - b));
    for (const plan of [...LADDER, ...BAND]) expect(isPlanChangeKey(plan.key), plan.key).toBe(true);
  });

  it('every Host and rung key is known and sold at quantity 1 only', () => {
    for (const key of [...keysOf(HOST), ...BAND.flatMap(keysOf)]) {
      expect(isKnownCheckoutPrice(key), key).toBe(true);
      expect(isAllowedCheckoutQuantity(key, 1), key).toBe(true);
      for (const q of [0, 2, 1.5])
        expect(isAllowedCheckoutQuantity(key, q), `${key} ×${q}`).toBe(false);
    }
  });

  it('Host is not a rung: its keys are no larger pool, and every rung still is one', () => {
    for (const key of keysOf(HOST)) {
      expect(isLargerPoolPlanKey(key), key).toBe(false);
      expect(largerPoolCreditsForPrice(key), key).toBeNull();
    }
    for (const rung of BAND) {
      for (const key of keysOf(rung)) {
        expect(isLargerPoolPlanKey(key), key).toBe(true);
        expect(largerPoolCreditsForPrice(key), key).toBe(poolOf(rung));
      }
    }
  });
});

describe('the services read the catalog, not a second list', () => {
  it('starts Checkout for Host and the top rung on each cadence, once, at quantity 1', async () => {
    const actor = await makeOwnerOrg();
    for (const key of [...keysOf(HOST), ...keysOf(TOP_RUNG)]) {
      ai.createCheckoutSession.mockClear();
      // Resolving at all is the claim: the ceiling refusal and the unknown-price
      // refusal both throw before the client is called.
      await expect(
        billingService.startCheckout({ ...actor, priceLookupKey: key }),
        key,
      ).resolves.toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_1' });
      expect(ai.createCheckoutSession, key).toHaveBeenCalledTimes(1);
      expect(ai.createCheckoutSession.mock.calls[0]![0]).toMatchObject({
        priceId: key,
        quantity: 1,
      });
    }
  });

  it('upgrades to host and downgrades to max_x2, forwarding each target key', async () => {
    const actor = await makeOwnerOrg();
    ai.previewPlanUpgrade.mockResolvedValue({
      prorationDate: 1792238400,
      fromPlan: TOP.key,
      toPlan: HOST.key,
      cadence: 'monthly',
      cadenceChange: null,
      amountDueCents: 58065,
      currency: 'usd',
      periodEnd: '2026-11-01T00:00:00.000Z',
      billingDaysLeft: 15,
      daysLeft: 15,
      creditWindowEnd: '2026-11-01T00:00:00.000Z',
      extraCredits: 116_129,
      extraIndexAllowance: 0,
      fromPool: poolOf(TOP),
      fullPool: poolOf(HOST),
      fullAllowance: null,
      toPriceCents: priceCents(HOST, 'monthly'),
      pendingDowngrade: null,
    });
    ai.upgradePlan.mockResolvedValue({
      status: 'upgraded',
      fromPlan: TOP.key,
      toPlan: HOST.key,
      invoiceId: 'in_1',
      amountDueCents: 58065,
      currency: 'usd',
      extraCredits: 116_129,
      extraIndexAllowance: 0,
      clearedPending: null,
    });
    ai.previewPlanDowngrade.mockResolvedValue({
      fromPlan: HOST.key,
      toPlan: TOP.key,
      cadence: 'monthly',
      cadenceChange: null,
      effectiveDate: '2026-11-01T00:00:00.000Z',
      amountDueCents: 0,
      creditsChange: 0,
      allowanceChange: 0,
      fromPool: poolOf(HOST),
      fullPool: poolOf(TOP),
      fullAllowance: null,
      toPriceCents: priceCents(TOP, 'monthly'),
      currency: 'usd',
      pendingDowngrade: null,
    });
    ai.schedulePlanDowngrade.mockResolvedValue({
      status: 'scheduled',
      fromPlan: HOST.key,
      toPlan: TOP.key,
      cadence: 'monthly',
      effectiveDate: '2026-11-01T00:00:00.000Z',
      replacedPending: null,
    });

    await billingService.previewUpgrade({ ...actor, toPlanKey: HOST.key });
    await billingService.upgradePlan({ ...actor, toPlanKey: HOST.key, prorationDate: 1792238400 });
    await billingService.previewDowngrade({ ...actor, toPlanKey: TOP.key });
    await billingService.scheduleDowngrade({ ...actor, toPlanKey: TOP.key });

    const org = { coreOrganizationId: actor.organizationId };
    expect(ai.previewPlanUpgrade).toHaveBeenCalledWith({ ...org, toPlanKey: HOST.key });
    expect(ai.upgradePlan).toHaveBeenCalledWith({
      ...org,
      toPlanKey: HOST.key,
      prorationDate: 1792238400,
    });
    expect(ai.previewPlanDowngrade).toHaveBeenCalledWith({ ...org, toPlanKey: TOP.key });
    expect(ai.schedulePlanDowngrade).toHaveBeenCalledWith({ ...org, toPlanKey: TOP.key });
  });

  it('still refuses a key outside the change-of-plan list, before motir-ai is asked', async () => {
    const actor = await makeOwnerOrg();
    for (const toPlanKey of ['free', 'host_pool_monthly', 'enterprise']) {
      await expect(
        billingService.previewUpgrade({ ...actor, toPlanKey }),
        toPlanKey,
      ).rejects.toMatchObject({
        reason: 'unknown_plan',
      });
    }
    expect(ai.previewPlanUpgrade).not.toHaveBeenCalled();
  });
});

describe('the operator bill quotes Host’s own entry', () => {
  it.each(CADENCES)('an org on Host is billed Host’s %s price', (cadence) => {
    const bill = buildOrgBill(statusOn(HOST, cadence), 1);
    expect(bill.money).toEqual([
      {
        key: 'aiPlan',
        basis: { credits: poolOf(HOST), cadence },
        amountCents: priceCents(HOST, cadence),
      },
    ]);
    expect(bill.totalCents).toBe(priceCents(HOST, cadence));
  });
});
