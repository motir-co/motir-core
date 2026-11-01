import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckoutSessionOutcome } from '@/lib/ai/motirAiClient';
import type { BillingStatusDTO, CalculatorEstimateDTO } from '@/lib/dto/billing';
import {
  BILLING_CATALOG,
  CHECKOUT_PRICE_LOOKUP_KEYS,
  PLAN_CHANGE_KEYS,
  hostMonthlyPlanCredits,
  isLargerPoolPlanKey,
  largerPoolPlans,
  maxMonthlyPlanCredits,
  type AiPlanCatalogEntry,
} from '@/lib/billing/catalog';
import { LargerPoolAtOrBelowCeilingError } from '@/lib/billing/errors';
import { planCarriesOwnAccounts } from '@/lib/billing/ownAccountPlans';
import {
  HOST_FLOOR_CAPS,
  LARGER_POOL_FLOOR_CAPS,
  PLAN_CAPS,
  capsForPlanKey,
} from '@/lib/billing/planCaps';
import { buildOrgBill } from '@/lib/platform/orgBill';
import { db } from '@/lib/db';
import { isOnSaleRung } from '@/app/(authed)/settings/organization/billing/_components/RungEntitlements';
import { adminDb } from '../helpers/adminDb';

// STORY MOTIR-9366's INTEGRATION GATE, CATALOG HALF (MOTIR-9656) — the larger pools
// start above Host. Four cards each proved their own reader of the catalog: the
// rung table and the allow-lists (MOTIR-9646), the own-accounts predicate
// (MOTIR-9651), the caps table (MOTIR-9653) and the Billing & plans offer
// (MOTIR-9654). This file feeds the SHIPPED catalog through every one of them and
// asserts they name ONE on-sale set, derived here from the `host` entry and the
// `larger_pool` entries — never typed.
//
// Since e95750784 (2026-10-26) the six first rungs are not retired but REMOVED: no
// catalog entry, no caps row, no bill line, no allow-list entry. So the "retired"
// set the catalog yields is EMPTY, and the story's acceptance key `pool_250k` is
// asserted as a removed key: refused at Checkout with the at-or-below-Host error,
// and unknown to every other reader.
//
// No pool or price is typed except the one-time equalities with the story's price
// card (600k and 900k) and the three keys its acceptance names. The motir-ai client
// is the one external leaf, so it is mocked; orgs are seeded through the real
// services on the real Postgres. The seams for a rung org's own accounts are
// `tests/ciFleet/rungOwnAccountsIntegration.test.ts`.

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
const poolOf = (p: AiPlanCatalogEntry) => p.allotment!.credits;
const keysOf = (p: AiPlanCatalogEntry) => CADENCES.map((c) => p.prices![c].priceLookupKey);
const cents = (usd: number) => Math.round(usd * 100);

// ── the two sets, derived ────────────────────────────────────────────────────

const HOST = BILLING_CATALOG.aiPlans.find((p) => p.band === 'host')!;
const LARGER = BILLING_CATALOG.aiPlans.filter((p) => p.band === 'larger_pool');
/** On sale: the larger pools above Host's pool, with prices, ascending. */
const ON_SALE = LARGER.filter(
  (p) => p.prices !== null && p.allotment?.cadence === 'monthly' && poolOf(p) > poolOf(HOST),
).sort((a, b) => poolOf(a) - poolOf(b));
const ON_SALE_KEYS = ON_SALE.map((p) => p.key);
/** Retired: the larger pools the catalog still lists but does not sell. */
const RETIRED = LARGER.filter((p) => !ON_SALE_KEYS.includes(p.key));
/** The story's acceptance names these three; every other key is derived. */
const RUNG_600K = 'pool_600k';
const RUNG_2400K = 'pool_2400k';
const REMOVED = 'pool_250k';
/** A rung-shaped key naming exactly Host's pool, derived from Host's entry. */
const AT_HOST_KEY = `pool_${poolOf(HOST) / 1000}k_pool_monthly`;
const REMOVED_KEYS = CADENCES.map((c) => `${REMOVED}_pool_${c}`);
const RUNG_SHAPED = /^pool_\d+k_pool_(monthly|annual)$/;

const TOPUP = BILLING_CATALOG.creditTopup;
const perCredit = TOPUP.unitAmountUsd / TOPUP.unitCredits;

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

/** What motir-core receives from motir-ai's calculator for an answer naming `planKey`. */
function answerNaming(planKey: string, planName: string): CalculatorEstimateDTO {
  return {
    version: 2,
    kind: 'estimate',
    profilesVersion: 'profiles-1',
    categoryRuleVersion: 'rule-1',
    cadence: 'monthly',
    plannedPerMonth: { low: 100, high: 150 },
    runPerMonth: { low: 20, high: 35 },
    credits: { low: poolOf(HOST), high: poolOf(HOST) + 1 },
    perItemCredits: { planning: 100, running: 200 },
    split: { count: 1, categories: [{ key: 'balanced', weight: 1, models: ['m'] }] },
    recommendation: { planKey, planName, monthlyPriceUsd: 0 },
    topUp: {
      low: { units: 0, credits: 0, priceUsd: 0 },
      high: { units: 0, credits: 0, priceUsd: 0 },
    },
    ceiling: {
      credits: poolOf(HOST),
      exceeded: true,
      excessCredits: 1,
      outcome: 'larger_pool',
    },
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

describe('the catalog: five rungs above Host', () => {
  it('largerPoolPlans() is the larger pools above Host’s pool, ascending, and the anchors read their entries', () => {
    expect(largerPoolPlans().map((p) => p.key)).toEqual(ON_SALE_KEYS);
    expect(ON_SALE).toHaveLength(5);
    expect(poolOf(ON_SALE[0]!)).toBeGreaterThanOrEqual(2 * poolOf(HOST));
    expect(ON_SALE_KEYS).toContain(RUNG_600K);
    expect(ON_SALE_KEYS).toContain(RUNG_2400K);
    expect(hostMonthlyPlanCredits()).toBe(poolOf(HOST));
    const ladder = BILLING_CATALOG.aiPlans.filter(
      (p) => p.band === 'ladder' && p.prices && p.allotment?.cadence === 'monthly',
    );
    expect(maxMonthlyPlanCredits()).toBe(Math.max(...ladder.map(poolOf)));
  });

  it('every rung is priced by the Host-anchored rule, above Host on both cadences', () => {
    for (const rung of ON_SALE) {
      const above = poolOf(rung) - poolOf(HOST);
      const monthly = HOST.prices!.monthly.amountUsd + above * perCredit * 0.9;
      const annual = (HOST.prices!.annual.amountUsd / poolOf(HOST)) * poolOf(rung);
      expect(cents(rung.prices!.monthly.amountUsd), rung.key).toBe(cents(monthly));
      expect(cents(rung.prices!.annual.amountUsd), rung.key).toBe(cents(annual));
      for (const c of CADENCES)
        expect(rung.prices![c].amountUsd, `${rung.key} ${c}`).toBeGreaterThan(
          HOST.prices![c].amountUsd,
        );
    }
    // Once, so a reader sees the catalog is the story's price card.
    const at = (key: string) => ON_SALE.find((p) => p.key === key)!.prices!;
    expect([at(RUNG_600K).monthly.amountUsd, at(RUNG_600K).annual.amountUsd]).toEqual([
      2_850, 24_000,
    ]);
    expect([at('pool_900k').monthly.amountUsd, at('pool_900k').annual.amountUsd]).toEqual([
      4_200, 36_000,
    ]);
  });
});

describe('every reader names the same on-sale set', () => {
  const allKeys = BILLING_CATALOG.aiPlans.map((p) => p.key);
  const larger = (keys: readonly string[]) =>
    keys.filter((k) => LARGER.some((p) => p.key === k)).sort();
  const expected = [...ON_SALE_KEYS].sort();

  it.each([
    ['the rung table', () => largerPoolPlans().map((p) => p.key)],
    [
      'CHECKOUT_PRICE_LOOKUP_KEYS',
      () =>
        LARGER.filter((p) => keysOf(p).every((k) => CHECKOUT_PRICE_LOOKUP_KEYS.has(k))).map(
          (p) => p.key,
        ),
    ],
    ['PLAN_CHANGE_KEYS', () => larger([...PLAN_CHANGE_KEYS])],
    [
      'isLargerPoolPlanKey',
      () => LARGER.filter((p) => keysOf(p).every(isLargerPoolPlanKey)).map((p) => p.key),
    ],
    ['planCarriesOwnAccounts', () => larger(allKeys.filter(planCarriesOwnAccounts))],
    ['isOnSaleRung', () => BILLING_CATALOG.aiPlans.filter(isOnSaleRung).map((p) => p.key)],
    [
      'capsForPlanKey → LARGER_POOL_FLOOR_CAPS',
      () => allKeys.filter((k) => capsForPlanKey(k) === LARGER_POOL_FLOOR_CAPS),
    ],
  ] as const)('%s', (_name, read) => {
    expect([...read()].sort()).toEqual(expected);
  });

  it('Host is covered where the reader covers it, and only Host besides the rungs', () => {
    expect(allKeys.filter(planCarriesOwnAccounts).sort()).toEqual([...expected, HOST.key].sort());
    expect(capsForPlanKey(HOST.key)).toBe(HOST_FLOOR_CAPS);
    expect(isOnSaleRung(HOST)).toBe(false);
    for (const key of keysOf(HOST)) expect(isLargerPoolPlanKey(key), key).toBe(false);
  });
});

describe('no retired rung is sold, and the removed one is unknown', () => {
  it('the catalog lists no larger pool outside the on-sale set (the first rungs were removed)', () => {
    expect(RETIRED).toEqual([]);
    expect(BILLING_CATALOG.aiPlans.some((p) => p.key === REMOVED)).toBe(false);
  });

  it('pool_250k is in no allow-list, carries no accounts, has no caps row and is no rung on sale', () => {
    for (const key of REMOVED_KEYS) {
      expect(CHECKOUT_PRICE_LOOKUP_KEYS.has(key), key).toBe(false);
      expect(isLargerPoolPlanKey(key), key).toBe(false);
    }
    expect(PLAN_CHANGE_KEYS).not.toContain(REMOVED);
    expect(planCarriesOwnAccounts(REMOVED)).toBe(false);
    expect(capsForPlanKey(REMOVED)).toBeNull();
    expect(Object.keys(PLAN_CAPS)).not.toContain(REMOVED);
    expect(isOnSaleRung({ key: REMOVED, band: 'larger_pool' })).toBe(false);
  });

  it('an active subscription on a rung is billed at its own price on both cadences', () => {
    for (const rung of ON_SALE) {
      for (const cadence of CADENCES) {
        const bill = buildOrgBill(statusOn(rung, cadence), 1);
        expect(bill.money, `${rung.key} ${cadence}`).toEqual([
          {
            key: 'aiPlan',
            basis: { credits: poolOf(rung), cadence },
            amountCents: cents(rung.prices![cadence].amountUsd),
          },
        ]);
      }
    }
  });
});

describe('Checkout and the change of plan read the same set', () => {
  it('starts Checkout for every rung on both cadences, once each, at quantity 1', async () => {
    const actor = await makeOwnerOrg();
    for (const key of ON_SALE.flatMap(keysOf)) {
      ai.createCheckoutSession.mockClear();
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

  it('refuses the removed rung and a rung at Host’s pool with the floor named, before motir-ai', async () => {
    const actor = await makeOwnerOrg();
    for (const key of [...REMOVED_KEYS, AT_HOST_KEY]) {
      expect(key).toMatch(RUNG_SHAPED);
      const refusal = await billingService.startCheckout({ ...actor, priceLookupKey: key }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(refusal, key).toBeInstanceOf(LargerPoolAtOrBelowCeilingError);
      expect((refusal as LargerPoolAtOrBelowCeilingError).ceilingCredits).toBe(
        hostMonthlyPlanCredits(),
      );
    }
    expect(ai.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('an org on Host previews pool_600k through motir-ai, and pool_250k is refused before it', async () => {
    const actor = await makeOwnerOrg();
    ai.previewPlanUpgrade.mockResolvedValue({ prorationDate: 1 });
    await billingService.previewUpgrade({ ...actor, toPlanKey: RUNG_600K });
    expect(ai.previewPlanUpgrade).toHaveBeenCalledTimes(1);
    expect(ai.previewPlanUpgrade).toHaveBeenCalledWith({
      coreOrganizationId: actor.organizationId,
      toPlanKey: RUNG_600K,
    });

    ai.previewPlanUpgrade.mockClear();
    await expect(
      billingService.previewUpgrade({ ...actor, toPlanKey: REMOVED }),
    ).rejects.toMatchObject({ reason: 'unknown_plan' });
    expect(ai.previewPlanUpgrade).not.toHaveBeenCalled();
  });
});

describe('the calculator’s answer resolves to the same set', () => {
  it('an answer naming a rung resolves to an entry on sale; one naming pool_250k resolves to none', () => {
    const resolve = (a: CalculatorEstimateDTO) =>
      BILLING_CATALOG.aiPlans.find((p) => p.key === a.recommendation.planKey) ?? null;
    for (const rung of ON_SALE) {
      const entry = resolve(answerNaming(rung.key, rung.name));
      expect(entry, rung.key).not.toBeNull();
      expect(isOnSaleRung(entry!), rung.key).toBe(true);
    }
    const removed = resolve(answerNaming(REMOVED, 'Pool 250,000'));
    expect(removed === null || !isOnSaleRung(removed)).toBe(true);
  });
});

describe('no rung pool or key is typed outside the catalog', () => {
  // The story's changed files outside the catalog, each with why it is on the list.
  const FILES: Record<string, string> = {
    'lib/billing/ownAccountPlans.ts': 'the own-accounts predicate (MOTIR-9651)',
    'lib/billing/planCaps.ts': 'the caps table (MOTIR-9653)',
    'lib/billing/hostOwnAccountCaps.ts': 'own-account caps from the grant (MOTIR-9653)',
    'lib/ciFleet/hostAccounts.ts': 'the per-plan raise targets (MOTIR-9651)',
    'lib/services/planCapsService.ts': 'caps by plan (MOTIR-9653)',
    'lib/services/fleetShardAdmissionService.ts': 'own-account routing (MOTIR-9653)',
    'lib/services/hostAccountReconcileService.ts': 'the reconcile’s selection (MOTIR-9651)',
    'lib/services/fleetShardProvisioningService.ts':
      'the refusal of a plan with no accounts (MOTIR-9651)',
    'lib/services/billingService.ts': 'the checkout floor (MOTIR-9646)',
    'app/(authed)/settings/organization/billing/_components/RungEntitlements.tsx':
      'the rung lines (MOTIR-9654)',
    'app/(authed)/settings/organization/billing/_components/CalculatorView.tsx':
      'the offer card (MOTIR-9654)',
    'app/(authed)/settings/organization/billing/_components/BillingClient.tsx':
      'the held card and the callout (MOTIR-9654)',
  };
  const figures = ON_SALE.flatMap((p) => {
    const n = poolOf(p);
    const thousands = n / 1000;
    return [String(n), `${thousands}_000`, `${thousands}k`, n.toLocaleString('en-US')];
  });
  const literal = new RegExp(
    `(?<![\\w.])(${[...figures, ...ON_SALE_KEYS].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\w])`,
  );

  it.each(Object.entries(FILES))('%s (%s)', (path) => {
    const source = readFileSync(path, 'utf8');
    const hits = source
      .split('\n')
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => literal.test(line));
    expect(hits, `rung literals in ${path}`).toEqual([]);
  });
});
