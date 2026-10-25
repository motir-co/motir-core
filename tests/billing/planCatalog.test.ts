import { describe, expect, it } from 'vitest';
import { buildOrgBill } from '@/lib/platform/orgBill';
import type { BillingStatusDTO } from '@/lib/dto/billing';
import {
  BILLING_CATALOG,
  CHECKOUT_PRICE_LOOKUP_KEYS,
  INCLUDED_TRACKER_SEATS_PER_AI_PLAN,
  isAllowedCheckoutQuantity,
  isKnownCheckoutPrice,
  isLargerPoolPlanKey,
  isPlanChangeKey,
  largerPoolCreditsForPrice,
  largerPoolPlans,
  maxMonthlyPlanCredits,
  PLAN_CHANGE_KEYS,
  planChangeKeysOf,
} from '@/lib/billing/catalog';

// MOTIR-8390 (story MOTIR-8379): the catalog carries pools 5,000 / 15,000 / 30,000,
// Max ×2 as a plan of its own, one included tracker seat per AI plan, the $5 top-up
// and no Enterprise entry. Figures are literals, never re-read from the catalog.

const ladder = () => BILLING_CATALOG.aiPlans.filter((p) => p.band === 'ladder');

const plan = (key: string) => {
  const entry = BILLING_CATALOG.aiPlans.find((p) => p.key === key);
  if (!entry) throw new Error(`no ${key} entry`);
  return entry;
};

describe('the AI plan ladder', () => {
  it('lists Free, Standard, Pro, Max and Max ×2, and no Enterprise', () => {
    expect(ladder().map((p) => p.key)).toEqual(['free', 'standard', 'pro', 'max', 'max_x2']);
  });

  it.each([
    ['standard', 5000, 25, 200, 'standard_pool_monthly', 'standard_pool_annual'],
    ['pro', 15000, 75, 600, 'pro_pool_monthly', 'pro_pool_annual'],
    ['max', 30000, 150, 1200, 'max_pool_monthly', 'max_pool_annual'],
    ['max_x2', 60000, 300, 2400, 'max_x2_pool_monthly', 'max_x2_pool_annual'],
  ])('%s grants %i a month at $%i / $%i a year', (key, credits, monthly, annual, mKey, aKey) => {
    const entry = plan(key);
    expect(entry.allotment).toEqual({ credits, cadence: 'monthly' });
    expect(entry.prices).toEqual({
      monthly: { amountUsd: monthly, priceLookupKey: mKey },
      annual: { amountUsd: annual, priceLookupKey: aKey },
    });
    expect(CHECKOUT_PRICE_LOOKUP_KEYS.has(mKey)).toBe(true);
    expect(CHECKOUT_PRICE_LOOKUP_KEYS.has(aKey)).toBe(true);
  });

  it('Max ×2 is named "Max ×2" and is exactly twice Max in credits and both prices', () => {
    const max = plan('max');
    const maxX2 = plan('max_x2');
    expect(maxX2.name).toBe('Max ×2');
    expect(maxX2.allotment?.credits).toBe(2 * (max.allotment?.credits ?? 0));
    expect(maxX2.prices?.annual.amountUsd).toBe(2 * (max.prices?.annual.amountUsd ?? 0));
    expect(maxX2.prices?.monthly.amountUsd).toBe(2 * (max.prices?.monthly.amountUsd ?? 0));
  });

  it('Free stays a one-time 300 with no price', () => {
    expect(plan('free').allotment).toEqual({ credits: 300, cadence: 'one_time' });
    expect(plan('free').prices).toBeNull();
  });

  it('every paid plan includes one tracker seat and Free none', () => {
    expect(Object.fromEntries(ladder().map((p) => [p.key, p.includedTrackerSeats]))).toEqual({
      free: 0,
      standard: 1,
      pro: 1,
      max: 1,
      max_x2: 1,
    });
    expect(INCLUDED_TRACKER_SEATS_PER_AI_PLAN).toBe(1);
  });

  it('the largest monthly pool is 60,000', () => {
    expect(maxMonthlyPlanCredits()).toBe(60000);
  });

  it('carries no multiplier or per-seat field on an AI plan', () => {
    for (const entry of BILLING_CATALOG.aiPlans) {
      expect(Object.keys(entry).sort()).toEqual([
        'allotment',
        'band',
        'includedTrackerSeats',
        'key',
        'name',
        'prices',
        'recommended',
      ]);
    }
  });
});

describe('the top-up and the seat fee', () => {
  it('sells 1,000 credits for $5 in 1× / 5× / 10× bundles under credit_topup', () => {
    expect(BILLING_CATALOG.creditTopup).toEqual({
      unitCredits: 1000,
      unitAmountUsd: 5,
      priceLookupKey: 'credit_topup',
      bundleUnits: [1, 5, 10],
    });
  });

  it('leaves the per-user seat fee exactly as it was', () => {
    expect(BILLING_CATALOG.seatPlan).toEqual({
      name: 'Motir',
      prices: {
        monthly: { amountUsd: 5, priceLookupKey: 'tracker_monthly' },
        annual: { amountUsd: 40, priceLookupKey: 'tracker_annual' },
      },
    });
    expect(CHECKOUT_PRICE_LOOKUP_KEYS.has('tracker_monthly')).toBe(true);
    expect(CHECKOUT_PRICE_LOOKUP_KEYS.has('tracker_annual')).toBe(true);
  });
});

describe('isAllowedCheckoutQuantity', () => {
  it('admits quantity 1 for every listed key, both Max ×2 keys included', () => {
    for (const key of CHECKOUT_PRICE_LOOKUP_KEYS) {
      expect(isAllowedCheckoutQuantity(key, 1)).toBe(true);
    }
  });

  it.each([
    'max_pool_annual',
    'max_x2_pool_annual',
    'max_x2_pool_monthly',
    'max_pool_monthly',
    'standard_pool_annual',
  ])('refuses %s at 2, 0 and a fraction', (key) => {
    expect(isAllowedCheckoutQuantity(key, 2)).toBe(false);
    expect(isAllowedCheckoutQuantity(key, 0)).toBe(false);
    expect(isAllowedCheckoutQuantity(key, 1.5)).toBe(false);
  });

  it('admits the top-up at its bundle sizes only', () => {
    expect([1, 2, 5, 10].map((q) => isAllowedCheckoutQuantity('credit_topup', q))).toEqual([
      true,
      false,
      true,
      true,
    ]);
  });

  it('treats the tracker seat keys as before: 1 only', () => {
    for (const key of ['tracker_monthly', 'tracker_annual']) {
      expect([1, 2, 5].map((q) => isAllowedCheckoutQuantity(key, q))).toEqual([true, false, false]);
    }
  });
});

// MOTIR-8392 — the story's catalog gate: the rest of the figures and the guard's
// full truth table, pinned as literals so any drift fails here.
describe('the catalog gate (MOTIR-8392)', () => {
  const PAID = ['standard', 'pro', 'max', 'max_x2'] as const;
  const AI_KEYS = PAID.flatMap((k) => [`${k}_pool_monthly`, `${k}_pool_annual`]);

  it('has exactly three top-level members and no plan-count field', () => {
    expect(Object.keys(BILLING_CATALOG).sort()).toEqual(['aiPlans', 'creditTopup', 'seatPlan']);
  });

  it('prices every paid plan on both cadences, under _pool_monthly / _pool_annual keys', () => {
    for (const key of PAID) {
      const prices = plan(key).prices!;
      expect(Object.keys(prices).sort()).toEqual(['annual', 'monthly']);
      expect(prices.monthly.priceLookupKey).toBe(`${key}_pool_monthly`);
      expect(prices.annual.priceLookupKey).toBe(`${key}_pool_annual`);
    }
  });

  it('carries no Enterprise trace on any entry: no key, label or contact-sales field', () => {
    const text = JSON.stringify(BILLING_CATALOG).toLowerCase();
    expect(text).not.toContain('enterprise');
    expect(text).not.toContain('contact');
  });

  it('exposes no cost or margin figure anywhere', () => {
    const keys: string[] = [];
    const walk = (v: unknown) => {
      if (v && typeof v === 'object') {
        for (const [k, child] of Object.entries(v)) {
          keys.push(k);
          walk(child);
        }
      }
    };
    walk(BILLING_CATALOG);
    for (const banned of ['cost', 'margin', 'unitCost', 'multiples', 'quantity', 'perSeat']) {
      expect(keys).not.toContain(banned);
    }
  });

  it('states the included seat once: a non-negative integer, equal on every paid plan', () => {
    for (const entry of BILLING_CATALOG.aiPlans) {
      expect(Number.isInteger(entry.includedTrackerSeats)).toBe(true);
      expect(entry.includedTrackerSeats).toBeGreaterThanOrEqual(0);
    }
    for (const key of PAID) {
      expect(plan(key).includedTrackerSeats).toBe(INCLUDED_TRACKER_SEATS_PER_AI_PLAN);
    }
  });

  it('keeps the seat plan apart from the AI plans', () => {
    const seat = BILLING_CATALOG.seatPlan as unknown as Record<string, unknown>;
    expect(seat['allotment']).toBeUndefined();
    expect(seat['includedTrackerSeats']).toBeUndefined();
    const aiKeys = BILLING_CATALOG.aiPlans.flatMap((p) =>
      p.prices ? [p.prices.monthly.priceLookupKey, p.prices.annual.priceLookupKey] : [],
    );
    expect(aiKeys.filter((k) => k.startsWith('tracker_'))).toEqual([]);
  });

  it('maxMonthlyPlanCredits is the largest monthly pool in the ladder band', () => {
    const pools = ladder()
      .filter((p) => p.allotment?.cadence === 'monthly')
      .map((p) => p.allotment!.credits);
    expect(maxMonthlyPlanCredits()).toBe(Math.max(...pools));
  });

  it('prices a top-up credit at $0.005, bundles at $5 / $25 / $50', () => {
    const t = BILLING_CATALOG.creditTopup;
    expect(t.unitAmountUsd / t.unitCredits).toBeCloseTo(0.005, 6);
    expect(t.bundleUnits.map((u) => u * t.unitAmountUsd)).toEqual([5, 25, 50]);
  });

  it('pins the credit price: Max and Max ×2 match per cadence, top-up is 1.5× annual', () => {
    const perAnnual = (key: string) =>
      plan(key).prices!.annual.amountUsd / (12 * plan(key).allotment!.credits);
    const perMonthly = (key: string) =>
      plan(key).prices!.monthly.amountUsd / plan(key).allotment!.credits;
    const topup =
      BILLING_CATALOG.creditTopup.unitAmountUsd / BILLING_CATALOG.creditTopup.unitCredits;
    expect(perAnnual('max')).toBeCloseTo(0.00333, 5);
    expect(perAnnual('max_x2')).toBeCloseTo(0.00333, 5);
    expect(perMonthly('max')).toBeCloseTo(0.005, 6);
    expect(perMonthly('max_x2')).toBeCloseTo(0.005, 6);
    expect(topup).toBeCloseTo(perMonthly('max'), 6);
    expect(topup / perAnnual('max')).toBeCloseTo(1.5, 5);
  });

  it.each(AI_KEYS)('never admits %s above or below 1', (key) => {
    expect(isAllowedCheckoutQuantity(key, 1)).toBe(true);
    for (const q of [2, 3, 0, -1, 1.5, Number.NaN]) {
      expect(isAllowedCheckoutQuantity(key, q)).toBe(false);
    }
  });

  it('refuses an unlisted key above 1, and the top-up off its bundles', () => {
    expect(isAllowedCheckoutQuantity('not_a_price', 2)).toBe(false);
    expect(isAllowedCheckoutQuantity('credit_topup', 2)).toBe(false);
    expect(isAllowedCheckoutQuantity('credit_topup', 20)).toBe(false);
  });

  it('reads the bundle rule from the data, while the plan rule stays 1', () => {
    const original = BILLING_CATALOG.creditTopup;
    BILLING_CATALOG.creditTopup = { ...original, bundleUnits: [1, 3] };
    try {
      expect(isAllowedCheckoutQuantity('credit_topup', 3)).toBe(true);
      expect(isAllowedCheckoutQuantity('credit_topup', 5)).toBe(false);
      expect(isAllowedCheckoutQuantity('max_x2_pool_annual', 3)).toBe(false);
    } finally {
      BILLING_CATALOG.creditTopup = original;
    }
  });

  it('knows every listed key and no other', () => {
    expect(isKnownCheckoutPrice('max_x2_pool_monthly')).toBe(true);
    expect(isKnownCheckoutPrice('enterprise_pool_annual')).toBe(false);
  });

  it('takes no organisation input: the guard is (key, quantity) only', () => {
    expect(isAllowedCheckoutQuantity.length).toBe(2);
  });
});

// MOTIR-8990 — the larger pools above Max ×2, as the approved record MOTIR-8987 fixes
// them: six rungs, monthly = Max ×2's price + $4.50 per 1,000 credits above its pool,
// annual = the ladder's own annual rate. The rule is restated here from the ladder's
// own entries, so a rung priced off the wrong basis fails in one place.
describe('the larger-pool band (MOTIR-8990)', () => {
  const RUNGS = ['pool_80k', 'pool_100k', 'pool_120k', 'pool_150k', 'pool_200k', 'pool_250k'];
  const top = () => plan('max_x2');
  const topUpRate = () =>
    BILLING_CATALOG.creditTopup.unitAmountUsd / BILLING_CATALOG.creditTopup.unitCredits;
  const annualRate = () => top().prices!.annual.amountUsd / (12 * top().allotment!.credits);

  it('lists the six rungs in ascending pool order, every one strictly above the ceiling', () => {
    const rungs = largerPoolPlans();
    expect(rungs.map((p) => p.key)).toEqual(RUNGS);
    const pools = rungs.map((p) => p.allotment!.credits);
    expect(pools).toEqual([...pools].sort((a, b) => a - b));
    for (const pool of pools) expect(pool).toBeGreaterThan(maxMonthlyPlanCredits());
  });

  it('keeps the ceiling at the ladder top: 60,000, not the top rung', () => {
    expect(maxMonthlyPlanCredits()).toBe(60000);
    // Widened over every entry, the "ceiling" would be Host's own pool (MOTIR-9364)
    // — the meaning the band filter exists to keep out.
    const widened = Math.max(
      ...BILLING_CATALOG.aiPlans.flatMap((p) =>
        p.allotment?.cadence === 'monthly' ? [p.allotment.credits] : [],
      ),
    );
    expect(widened).toBe(300000);
    const rung = plan('pool_250k');
    const original = rung.allotment;
    rung.allotment = { credits: 300000, cadence: 'monthly' };
    try {
      expect(maxMonthlyPlanCredits()).toBe(60000);
    } finally {
      rung.allotment = original;
    }
    const max = top();
    const maxPool = max.allotment;
    max.allotment = { credits: 50000, cadence: 'monthly' };
    try {
      expect(maxMonthlyPlanCredits()).toBe(50000);
    } finally {
      max.allotment = maxPool;
    }
  });

  it.each(RUNGS)('%s is a monthly larger pool, not recommended, with the ladder seat', (key) => {
    const rung = plan(key);
    expect(rung.band).toBe('larger_pool');
    expect(rung.allotment?.cadence).toBe('monthly');
    expect(rung.recommended).toBe(false);
    expect(rung.includedTrackerSeats).toBe(INCLUDED_TRACKER_SEATS_PER_AI_PLAN);
    expect(rung.name).toBe(`Pool ${rung.allotment!.credits.toLocaleString('en-US')}`);
  });

  it.each(RUNGS)('%s is priced by the recorded rule on both cadences', (key) => {
    const rung = plan(key);
    const pool = rung.allotment!.credits;
    const extra = pool - top().allotment!.credits;
    const monthly = top().prices!.monthly.amountUsd + extra * topUpRate() * 0.9;
    expect(rung.prices!.monthly.amountUsd).toBeCloseTo(monthly, 6);
    expect(Number.isInteger(rung.prices!.monthly.amountUsd)).toBe(true);
    expect(rung.prices!.annual.amountUsd).toBeCloseTo(12 * pool * annualRate(), 6);
    // Annual is the ladder's annual rate, so it is NOT 8 × monthly on a rung.
    expect(rung.prices!.annual.amountUsd).not.toBe(8 * rung.prices!.monthly.amountUsd);
    // A monthly rung always undercuts Max ×2 plus top-ups for the same pool.
    expect(rung.prices!.monthly.amountUsd).toBeLessThan(
      top().prices!.monthly.amountUsd + extra * topUpRate(),
    );
  });

  it('carries the recorded figures', () => {
    expect(
      largerPoolPlans().map((p) => [
        p.allotment!.credits,
        p.prices!.monthly.amountUsd,
        p.prices!.annual.amountUsd,
      ]),
    ).toEqual([
      [80000, 390, 3200],
      [100000, 480, 4000],
      [120000, 570, 4800],
      [150000, 705, 6000],
      [200000, 930, 8000],
      [250000, 1155, 10000],
    ]);
  });

  it('keys each rung <key>_pool_<cadence>, and no tier key carries _pool_ itself', () => {
    for (const rung of largerPoolPlans()) {
      expect(rung.prices!.monthly.priceLookupKey).toBe(`${rung.key}_pool_monthly`);
      expect(rung.prices!.annual.priceLookupKey).toBe(`${rung.key}_pool_annual`);
    }
    for (const entry of BILLING_CATALOG.aiPlans) {
      expect(entry.key).not.toContain('_pool_');
      for (const price of entry.prices ? Object.values(entry.prices) : []) {
        const first = price.priceLookupKey.slice(0, price.priceLookupKey.indexOf('_pool_'));
        const last = price.priceLookupKey.slice(0, price.priceLookupKey.lastIndexOf('_pool_'));
        expect(first).toBe(entry.key);
        expect(last).toBe(entry.key);
      }
    }
  });

  it('returns a fresh array and leaves the catalog untouched', () => {
    const before = BILLING_CATALOG.aiPlans.map((p) => p.key);
    const a = largerPoolPlans();
    const b = largerPoolPlans();
    expect(a).not.toBe(b);
    expect(BILLING_CATALOG.aiPlans.map((p) => p.key)).toEqual(before);
  });

  it('derives both allow-lists from the ladder, the rung table and Host', () => {
    const keysOf = (entries: typeof BILLING_CATALOG.aiPlans) =>
      entries.flatMap((p) =>
        p.prices ? [p.prices.monthly.priceLookupKey, p.prices.annual.priceLookupKey] : [],
      );
    const seat = BILLING_CATALOG.seatPlan.prices;
    expect(new Set(CHECKOUT_PRICE_LOOKUP_KEYS)).toEqual(
      new Set([
        ...keysOf(ladder()),
        ...keysOf(largerPoolPlans()),
        ...keysOf(BILLING_CATALOG.aiPlans.filter((p) => p.band === 'host')),
        seat.monthly.priceLookupKey,
        seat.annual.priceLookupKey,
        BILLING_CATALOG.creditTopup.priceLookupKey,
      ]),
    );
    expect(PLAN_CHANGE_KEYS).toEqual(['standard', 'pro', 'max', 'max_x2', ...RUNGS, 'host']);
    for (const absent of ['free', 'tracker_monthly', 'tracker_annual', 'credit_topup']) {
      expect(isPlanChangeKey(absent)).toBe(false);
    }
  });

  it('drops a rung configured at the ceiling from the table', () => {
    // The allow-list constants are built once at module load, so this mutation cannot
    // change them retroactively; the derivation is proved by the set equality above.
    const rung = plan('pool_80k');
    const original = rung.allotment;
    rung.allotment = { credits: maxMonthlyPlanCredits(), cadence: 'monthly' };
    try {
      expect(largerPoolPlans().map((p) => p.key)).not.toContain('pool_80k');
      expect(isLargerPoolPlanKey('pool_80k_pool_monthly')).toBe(false);
      expect(isLargerPoolPlanKey('pool_80k_pool_annual')).toBe(false);
      expect(largerPoolPlans()).toHaveLength(RUNGS.length - 1);
    } finally {
      rung.allotment = original;
    }
    expect(isLargerPoolPlanKey('pool_80k_pool_monthly')).toBe(true);
  });

  it.each(RUNGS.flatMap((k) => [`${k}_pool_monthly`, `${k}_pool_annual`]))(
    'sells %s at quantity 1 only',
    (key) => {
      expect(isKnownCheckoutPrice(key)).toBe(true);
      expect(isLargerPoolPlanKey(key)).toBe(true);
      expect(isAllowedCheckoutQuantity(key, 1)).toBe(true);
      for (const q of [2, 5, 10, 0]) expect(isAllowedCheckoutQuantity(key, q)).toBe(false);
    },
  );

  it('leaves the seat plan, the top-up and the default quantity alone', () => {
    expect(BILLING_CATALOG.creditTopup.bundleUnits).toEqual([1, 5, 10]);
    expect(BILLING_CATALOG.seatPlan.prices.monthly.amountUsd).toBe(5);
    expect(INCLUDED_TRACKER_SEATS_PER_AI_PLAN).toBe(1);
  });
});

describe('a rung-shaped request (MOTIR-8990)', () => {
  it('reads the pool a rung-shaped key names, on either cadence', () => {
    expect(largerPoolCreditsForPrice('pool_80k_pool_monthly')).toBe(80000);
    expect(largerPoolCreditsForPrice('pool_250k_pool_annual')).toBe(250000);
    expect(largerPoolCreditsForPrice('pool_30k_pool_monthly')).toBe(30000);
  });

  it.each([
    'max_x2_pool_monthly',
    'standard_pool_annual',
    'tracker_monthly',
    'credit_topup',
    'pool_80k',
    'big_80k_pool_monthly',
    'pool_80k_pool_monthly_x',
    'pool_k_pool_annual',
  ])('reads no pool from %s', (key) => {
    expect(largerPoolCreditsForPrice(key)).toBeNull();
  });

  it('never classifies a sellable key as at or below the ceiling', () => {
    for (const key of CHECKOUT_PRICE_LOOKUP_KEYS) {
      const pool = largerPoolCreditsForPrice(key);
      if (pool !== null) expect(pool).toBeGreaterThan(maxMonthlyPlanCredits());
    }
  });

  it.each(['pool_30k_pool_monthly', 'pool_60k_pool_annual'])(
    'treats %s as at or below the ceiling, not a price',
    (key) => {
      expect(isKnownCheckoutPrice(key)).toBe(false);
      expect(largerPoolCreditsForPrice(key)! <= maxMonthlyPlanCredits()).toBe(true);
    },
  );

  it('treats a rung-shaped key above the ceiling that no rung carries as unknown only', () => {
    expect(isKnownCheckoutPrice('pool_90k_pool_monthly')).toBe(false);
    expect(largerPoolCreditsForPrice('pool_90k_pool_monthly')! > maxMonthlyPlanCredits()).toBe(
      true,
    );
  });
});

describe('the operator bill for a larger pool (MOTIR-8990)', () => {
  it('bills a rung from its own entry, with orgBill.ts unchanged', () => {
    const rung = plan('pool_150k');
    const tier = { key: rung.key, name: rung.name, monthlyCreditAllotment: 150000 };
    const status = {
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
          currentPeriodEnd: '2026-11-15T00:00:00.000Z',
          priceId: rung.prices!.monthly.priceLookupKey,
          planTier: tier,
        },
      },
      ci: { chargedCredits: 0 },
      search: null,
      agents: { spend: null, hasPaidAiPlan: true },
      catalog: BILLING_CATALOG,
    } as unknown as Omit<BillingStatusDTO, 'access'>;
    const line = buildOrgBill(status, 1).money.find((l) => l.key === 'aiPlan');
    expect(line).toEqual({
      key: 'aiPlan',
      basis: { credits: rung.allotment!.credits, cadence: 'monthly' },
      amountCents: rung.prices!.monthly.amountUsd * 100,
    });
  });
});

describe('the Host band (MOTIR-9398)', () => {
  const HOST_KEYS = ['host_pool_monthly', 'host_pool_annual'];
  const RUNGS = ['pool_80k', 'pool_100k', 'pool_120k', 'pool_150k', 'pool_200k', 'pool_250k'];

  it('carries exactly one Host entry, with its figures', () => {
    const hosts = BILLING_CATALOG.aiPlans.filter((p) => p.key === 'host');
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toEqual({
      key: 'host',
      name: 'Host',
      allotment: { credits: 300000, cadence: 'monthly' },
      recommended: false,
      prices: {
        monthly: { amountUsd: 1500, priceLookupKey: 'host_pool_monthly' },
        annual: { amountUsd: 12000, priceLookupKey: 'host_pool_annual' },
      },
      includedTrackerSeats: 1,
      band: 'host',
    });
    expect(hosts[0]!.includedTrackerSeats).toBe(INCLUDED_TRACKER_SEATS_PER_AI_PLAN);
  });

  it("is priced at the ladder's per-credit basis on both cadences", () => {
    const host = plan('host');
    const top = plan('max_x2');
    expect(host.prices!.monthly.amountUsd / host.allotment!.credits).toBe(
      top.prices!.monthly.amountUsd / top.allotment!.credits,
    );
    expect(host.prices!.monthly.amountUsd / host.allotment!.credits).toBe(0.005);
    expect(host.prices!.annual.amountUsd / (12 * host.allotment!.credits)).toBe(
      top.prices!.annual.amountUsd / (12 * top.allotment!.credits),
    );
    expect(host.prices!.annual.amountUsd).toBe(8 * host.prices!.monthly.amountUsd);
  });

  it('moves neither the ladder ceiling nor the rung table', () => {
    expect(maxMonthlyPlanCredits()).toBe(60000);
    expect(largerPoolPlans().map((p) => p.key)).toEqual(RUNGS);
    expect(ladder().map((p) => p.key)).not.toContain('host');
  });

  it.each(HOST_KEYS)('sells %s at quantity 1 only, and never as a rung', (key) => {
    expect(CHECKOUT_PRICE_LOOKUP_KEYS.has(key)).toBe(true);
    expect(isKnownCheckoutPrice(key)).toBe(true);
    expect(isAllowedCheckoutQuantity(key, 1)).toBe(true);
    for (const q of [2, 0, 1.5]) expect(isAllowedCheckoutQuantity(key, q)).toBe(false);
    expect(isLargerPoolPlanKey(key)).toBe(false);
    expect(largerPoolCreditsForPrice(key)).toBeNull();
  });

  it('is a plan-change target, last in ascending pool order', () => {
    expect(isPlanChangeKey('host')).toBe(true);
    expect(PLAN_CHANGE_KEYS[PLAN_CHANGE_KEYS.length - 1]).toBe('host');
    const pools = PLAN_CHANGE_KEYS.map((k) => plan(k).allotment!.credits);
    expect(pools).toEqual([...pools].sort((a, b) => a - b));
  });

  it('orders plan-change keys by pool, so a rung moved above Host sorts after it', () => {
    const copy = BILLING_CATALOG.aiPlans.map((p) =>
      p.key === 'pool_250k'
        ? { ...p, allotment: { credits: 400000, cadence: 'monthly' as const } }
        : p,
    );
    const keys = planChangeKeysOf(copy);
    expect(keys.indexOf('pool_250k')).toBeGreaterThan(keys.indexOf('host'));
    expect(keys).not.toContain('free');
    // The builder reads its argument only; the catalog and the constant are untouched.
    expect(plan('pool_250k').allotment!.credits).toBe(250000);
    expect(PLAN_CHANGE_KEYS[PLAN_CHANGE_KEYS.length - 1]).toBe('host');
  });
});
