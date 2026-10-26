import type { Locator, Page, Request, Response } from '@playwright/test';
import { test, expect } from './_helpers/acceptance-video';
import {
  freeOrgState,
  paidOrgState,
  seedBillingOwner,
  setOrgBillingState,
  type BillingSeed,
} from './_helpers/billing';
import { saveAccountLanguageInSettings } from './_helpers/i18n-walk';
import {
  BILLING_CATALOG,
  largerPoolPlans,
  maxMonthlyPlanCredits,
  type AiPlanCatalogEntry,
} from '@/lib/billing/catalog';
import type { RawUpgradePreview } from '@/lib/ai/types';
import type { CalculatorEstimateDTO } from '@/lib/dto/billing';
import {
  E2E_CHECKOUT_URL,
  type BillingFixtureEntry,
  type BillingFixtureTier,
} from '@/lib/test-billing-mock';
import {
  PINNED_CATEGORIES_ANSWER,
  PINNED_ESTIMATE_ANSWER,
} from '../fixtures/calculatorPinnedVector';
import { escapeRegExp } from '@/lib/utils/regexp';
import { assessWatchability } from '../../scripts/upload-acceptance-video.mjs';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// THE LARGER POOLS START ABOVE HOST (Story MOTIR-9366 · MOTIR-9657) — the story's
// acceptance receipt, the billing half of its verification recipe (steps 1–4, 9
// and 10, each a chapter named for its step). An owner with no plan asks the
// Calculator at 100,000 (Max ×2 and top-ups, no Host, no rung) and at 700,000 (the
// smallest rung above Host, with the own-accounts lines), finds no removed rung
// anywhere and the callout naming Host, and buys Pool 600,000 monthly. An owner on
// Host upgrades to it through the change-of-plan dialog. The offer and the held
// rung read in 中文. The fleet half (steps 5–8) is the real-database walk
// `tests/ciFleet/rungOwnAccountsRecipe.test.ts`; it has no screen.
//
// ── WHAT THIS LANE CAN AND CANNOT PROVE ───────────────────────────────────────
// motir-ai is the lane's E2E_TEST_BILLING boundary mock and Stripe is never
// reached: Checkout lands on E2E_CHECKOUT_URL. The Calculator's two routes are
// answered at the BROWSER, playing the engine's rule (the smallest on-sale rung
// at or above the high end; Max ×2 and top-ups between Max ×2 and Host). The
// owner's balance is the FIXTURE replaying a paid invoice. So this proves the
// requests motir-core sends (the lookup key, `toPlanKey`, the preview's
// `prorationDate`) and what the page shows. It does NOT prove that Stripe holds
// the rung prices, that motir-ai reconciled the price or granted the pool exactly
// once, or that the real engine answers these estimates: those are the story's
// Stripe test-mode card's (its recorded Checkout and proration preview) and the
// motir-ai story gate's (MOTIR-9655).
//
// ── FIGURES ───────────────────────────────────────────────────────────────────
// Every plan name, pool, price and key is read from `lib/billing/catalog.ts`
// (`largerPoolPlans()`, the `host` and `max_x2` entries), every sentence from
// `messages/en.json` / `zh.json`. The only literals are the recipe's estimates
// (100,000 and 700,000), the three keys the story names, and the change-of-plan
// preview's `amountDueCents` and `prorationDate`, which motir-ai would compute and
// the fixture hands over.
//
// ── WAITS ─────────────────────────────────────────────────────────────────────
// Every step waits on a request, a response, the billing panel's own read or a
// rendered landmark armed before the action. `beat()` is pacing, never
// synchronisation.

test.describe.configure({ timeout: 300_000 });

const copy = en.billing;
const up = copy.plans.upgrade;
const billingPath = '/settings/organization/billing';

const entry = (key: string): AiPlanCatalogEntry => {
  const found = BILLING_CATALOG.aiPlans.find((p) => p.key === key);
  if (!found) throw new Error(`the catalog has no ${key} entry`);
  return found;
};
const HOST = BILLING_CATALOG.aiPlans.find((p) => p.band === 'host')!;
const MAX_X2 = entry('max_x2');
const BAND = largerPoolPlans();
const LARGEST = BAND[BAND.length - 1]!;
const RUNG = entry('pool_600k');
const CEILING = maxMonthlyPlanCredits();
const TOPUP = BILLING_CATALOG.creditTopup;
const CATEGORY = PINNED_CATEGORIES_ANSWER.categories[0]!.key;
const PERIOD_END = '2026-11-01T00:00:00.000Z';
/** The recipe's two estimates. */
const BELOW_HOST = 100_000;
const ABOVE_HOST = 700_000;

const poolOf = (p: AiPlanCatalogEntry) => p.allotment!.credits;
/** The rung the engine's rule names for a high end: the smallest on sale that covers it. */
const rungFor = (high: number) => BAND.find((p) => poolOf(p) >= high) ?? LARGEST;
const OFFERED = rungFor(ABOVE_HOST);
/** A removed rung's name, as the catalog named its rungs: `pool_250k` is Pool 250,000. */
const REMOVED_NAME = `Pool ${(Number(/^pool_(\d+)k$/.exec('pool_250k')![1]) * 1000).toLocaleString('en-US')}`;
/** Every larger pool the catalog lists but does not sell, plus the removed one. */
const NOT_ON_SALE = [
  ...BILLING_CATALOG.aiPlans
    .filter((p) => p.band === 'larger_pool' && !BAND.some((b) => b.key === p.key))
    .map((p) => p.name),
  REMOVED_NAME,
];

const n = (v: number) => v.toLocaleString('en-US');
const format = (message: string, values: Record<string, string | number>): string =>
  message.replace(/\{(\w+)\}/g, (_m, name: string) => String(values[name]));
const usd = (cents: number) =>
  new Intl.NumberFormat('en', { style: 'currency', currency: 'USD' }).format(cents / 100);
const label = (key: string) => key.charAt(0).toUpperCase() + key.slice(1);
const tierOf = (plan: AiPlanCatalogEntry): BillingFixtureTier => ({
  key: plan.key,
  name: plan.name,
  monthlyCreditAllotment: poolOf(plan),
});
const onPlan = (plan: AiPlanCatalogEntry, balance: number): BillingFixtureEntry =>
  paidOrgState({
    tier: tierOf(plan),
    balance,
    priceLookupKey: plan.prices!.monthly.priceLookupKey,
    currentPeriodEnd: PERIOD_END,
  });
const withPlanChange = (
  state: BillingFixtureEntry,
  planChange: NonNullable<BillingFixtureEntry['planChange']>,
): BillingFixtureEntry => ({ ...state, planChange });

// Host → Pool 600,000 over a whole 30-day window, so the extra credits are the
// full difference of the two pools. The charge and the stamp are literals.
const WINDOW_DAYS = 30;
const UPGRADE: RawUpgradePreview = {
  prorationDate: 1_790_899_200,
  fromPlan: HOST.key,
  toPlan: RUNG.key,
  cadence: 'monthly',
  cadenceChange: null,
  amountDueCents: 135_000,
  currency: 'usd',
  periodStart: '2026-10-02T00:00:00.000Z',
  periodEnd: PERIOD_END,
  billingDaysLeft: WINDOW_DAYS,
  daysLeft: WINDOW_DAYS,
  creditWindowEnd: PERIOD_END,
  extraCredits: Math.round(((poolOf(RUNG) - poolOf(HOST)) * WINDOW_DAYS) / 30),
  extraIndexAllowance: 0,
  fromPool: poolOf(HOST),
  fullPool: poolOf(RUNG),
  fullAllowance: 0,
  toPriceCents: Math.round(RUNG.prices!.monthly.amountUsd * 100),
  pendingDowngrade: null,
};

// ── the engine, played at the browser ─────────────────────────────────────────

type Outcome = CalculatorEstimateDTO['ceiling']['outcome'];

/** The engine's answer for a high end, by its rule (MOTIR-9366): never Host, never a removed rung. */
function answerFor(body: Record<string, unknown>, high: number): CalculatorEstimateDTO {
  const base = structuredClone(PINNED_ESTIMATE_ANSWER) as unknown as CalculatorEstimateDTO;
  const outcome: Outcome =
    high <= CEILING
      ? 'within_ladder'
      : high <= poolOf(HOST)
        ? 'top_ups_only'
        : poolOf(rungFor(high)) >= high
          ? 'larger_pool'
          : 'largest_pool';
  const plan = outcome === 'within_ladder' || outcome === 'top_ups_only' ? MAX_X2 : rungFor(high);
  const excess = Math.max(0, high - poolOf(plan));
  const units =
    outcome === 'top_ups_only' || outcome === 'largest_pool'
      ? Math.ceil(excess / TOPUP.unitCredits)
      : 0;
  const cadence = body['cadence'] as 'monthly' | 'annual';
  return {
    ...base,
    cadence,
    plannedPerMonth: body['plannedPerMonth'] as { low: number; high: number },
    runPerMonth: body['runPerMonth'] as { low: number; high: number },
    credits: { low: Math.round(high / 2), high },
    split: { count: 1, categories: [{ key: CATEGORY, weight: 1, models: [] }] },
    recommendation: {
      planKey: plan.key,
      planName: plan.name,
      monthlyPriceUsd: plan.prices![cadence].amountUsd / (cadence === 'annual' ? 12 : 1),
    },
    topUp: {
      low: { units: 0, credits: 0, priceUsd: 0 },
      high: { units, credits: units * TOPUP.unitCredits, priceUsd: units * TOPUP.unitAmountUsd },
    },
    ceiling: {
      credits: CEILING,
      exceeded: high > CEILING,
      excessCredits: Math.max(0, high - CEILING),
      outcome,
    },
  };
}

/** Arm the Calculator's two routes; `engine.high` is the high end the next ask lands on. */
async function armEngine(page: Page) {
  const engine = { high: BELOW_HOST };
  await page.route('**/billing/calculator/categories', (route) =>
    route.fulfill({ status: 200, json: PINNED_CATEGORIES_ANSWER }),
  );
  await page.route('**/billing/calculator/estimate', (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({ status: 200, json: answerFor(body, engine.high) });
  });
  await page.route('https://checkout.stripe.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<html><body>stripe</body></html>',
    }),
  );
  return engine;
}

// ── page helpers ────────────────────────────────────────────────────────────

const live = (page: Page) => page.getByRole('main');
const offer = (page: Page) => live(page).getByTestId('calculator-larger');
const result = (page: Page) => live(page).getByTestId('calculator-result');
const orgPath = (seed: BillingSeed, path: string) =>
  `/api/organizations/${seed.organizationId}/billing${path}`;

const billingRead = (page: Page, seed: BillingSeed): Promise<Response> =>
  page.waitForResponse(
    (res) => res.request().method() === 'GET' && new URL(res.url()).pathname === orgPath(seed, ''),
    { timeout: 45_000 },
  );

const postTo = (page: Page, seed: BillingSeed, path: string): Promise<Request> =>
  page.waitForRequest(
    (req) => req.method() === 'POST' && new URL(req.url()).pathname === orgPath(seed, path),
    { timeout: 45_000 },
  );

/** Every POST the page sends under the org's billing routes, by path. */
function countPosts(page: Page, seed: () => BillingSeed): Record<string, number> {
  const counts: Record<string, number> = {};
  page.on('request', (req) => {
    const prefix = orgPath(seed(), '/');
    const path = new URL(req.url()).pathname;
    if (req.method() === 'POST' && path.startsWith(prefix)) {
      const key = path.slice(prefix.length);
      counts[key] = (counts[key] ?? 0) + 1;
    }
  });
  return counts;
}

/** Open Billing & plans; answers the balance the page read. */
async function openBilling(page: Page, seed: BillingSeed): Promise<number> {
  const read = billingRead(page, seed);
  await page.goto(billingPath);
  const res = await read;
  expect(res.status()).toBe(200);
  return ((await res.json()) as { motirAi: { balance: number } }).motirAi.balance;
}

async function openPlans(page: Page, door: string, messages = en.billing) {
  await page.getByRole('button', { name: door }).click();
  await expect(page.getByRole('heading', { name: messages.plans.title })).toBeVisible();
}

async function openCalculator(page: Page, messages = en.billing) {
  await live(page)
    .getByTestId('plans-need-more')
    .getByRole('button', { name: messages.plans.needMore.action })
    .click();
  await expect(
    page.getByRole('heading', { name: messages.calculator.title, level: 1 }),
  ).toBeVisible();
}

/** Set the cadence, type a planned range, pick one category, ask. */
async function ask(page: Page, cadence: 'monthly' | 'annual', messages = en.billing) {
  const word = cadence === 'monthly' ? messages.plans.monthly : messages.plans.annual;
  const toggle = page.getByRole('button', { name: word, exact: true });
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  const planned = live(page).getByTestId('calculator-planned');
  await planned.getByLabel(messages.calculator.inputs.lowLabel).fill('40');
  await planned.getByLabel(messages.calculator.inputs.highLabel).fill('90');
  const pick = live(page).getByRole('button', { name: new RegExp(`^${label(CATEGORY)}`) });
  if ((await pick.getAttribute('aria-pressed')) !== 'true') await pick.click();
  const answered = page.waitForResponse((r) => r.url().endsWith('/billing/calculator/estimate'));
  await page.getByRole('button', { name: messages.calculator.inputs.submit }).click();
  await answered;
  await expect(live(page).getByTestId('calculator-credits')).toBeVisible();
  // The answer runs below a 720p fold; bring it on screen so the clip shows it.
  await result(page).scrollIntoViewIfNeeded();
}

/** The two rung entitlement lines, in `messages`' words. */
async function expectRungLines(lines: Locator, messages = en.billing) {
  await expect(lines.getByRole('listitem')).toHaveText([
    messages.plans.larger.ownAccounts,
    messages.plans.larger.sharedUntilGranted,
  ]);
}

/** No larger pool that is not on sale is named anywhere in `where`. */
async function expectNoneOffered(where: Locator) {
  for (const name of NOT_ON_SALE) {
    await expect(where).not.toContainText(new RegExp(`\\b${escapeRegExp(name)}\\b`));
  }
}

// ── the walk ────────────────────────────────────────────────────────────────

test.describe('The larger pools start above Host', () => {
  test('an owner is offered Max ×2 at 100,000 and a rung above Host at 700,000, buys Pool 600,000, a Host org upgrades to it, and it reads in 中文', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-9366');
    const pageErrors: Error[] = [];
    page.on('pageerror', (e) => pageErrors.push(e));
    let seed = await seedBillingOwner(page, `acc-rung-${Date.now().toString(36)}@example.com`);
    setOrgBillingState(seed.organizationId, freeOrgState(185));
    const engine = await armEngine(page);
    const posts = countPosts(page, () => seed);
    const t0 = Date.now();
    const starts: number[] = [];
    const timed = async (title: string, body: () => Promise<void>) => {
      starts.push((Date.now() - t0) / 1000);
      await chapter(title, body);
      await beat();
    };
    let before = 0;

    await timed(
      `Recipe 1 — at ${n(BELOW_HOST)}: ${MAX_X2.name} and top-ups, no Host and no larger pool`,
      async () => {
        before = await openBilling(page, seed);
        await openPlans(page, copy.ai.choosePlan);
        await openCalculator(page);
        engine.high = BELOW_HOST;
        await ask(page, 'monthly');
        await expect(live(page).getByTestId('calculator-plan')).toContainText(MAX_X2.name);
        await expect(live(page).getByTestId('calculator-price')).toContainText(
          n(MAX_X2.prices!.monthly.amountUsd),
        );
        await expect(live(page).getByTestId('calculator-regular-topups')).toHaveText(
          format(copy.calculator.result.regularWithTopUps, {
            plan: MAX_X2.name,
            credits: n(poolOf(MAX_X2)),
          }),
        );
        const excess = BELOW_HOST - poolOf(MAX_X2);
        const units = Math.ceil(excess / TOPUP.unitCredits);
        await expect(live(page).getByTestId('calculator-above-topup')).toHaveText(
          format(copy.calculator.result.largestPoolTopUp, {
            excess: n(excess),
            units,
            unitCredits: n(TOPUP.unitCredits),
            price: n(units * TOPUP.unitAmountUsd),
          }),
        );
        await expect(
          live(page).getByRole('button', { name: copy.calculator.result.goToPlan }),
        ).toBeVisible();
        await expect(offer(page)).toHaveCount(0);
        await expect(result(page)).not.toContainText(
          new RegExp(`\\b${escapeRegExp(HOST.name)}\\b`),
        );
        for (const rung of BAND) await expect(result(page)).not.toContainText(rung.name);
        await expectNoneOffered(result(page));
      },
    );

    await timed(
      `Recipe 2 — at ${n(ABOVE_HOST)}: ${OFFERED.name} at its price on both cadences, with its own accounts`,
      async () => {
        engine.high = ABOVE_HOST;
        await ask(page, 'monthly');
        await expect(offer(page)).toContainText(
          format(copy.calculator.result.largerPlan, { plan: OFFERED.name }),
        );
        await expect(offer(page).getByTestId('calculator-larger-price')).toContainText(
          format(copy.plans.perMoEquiv, { n: n(OFFERED.prices!.monthly.amountUsd) }),
        );
        await expect(offer(page)).toContainText(
          format(copy.plans.creditsAllotment, { n: n(poolOf(OFFERED)) }),
        );
        await expect(
          offer(page).getByRole('button', {
            name: format(copy.plans.ctaChoose, { plan: OFFERED.name }),
          }),
        ).toBeEnabled();
        await expectRungLines(offer(page).getByTestId('calculator-rung-entitlements'));

        await ask(page, 'annual');
        const annual = OFFERED.prices!.annual.amountUsd;
        await expect(offer(page).getByTestId('calculator-larger-price')).toContainText(
          format(copy.plans.perMoEquiv, { n: n(annual / 12) }),
        );
        await expect(offer(page).getByTestId('calculator-larger-price')).toContainText(
          format(copy.plans.annualSub, { yr: n(annual) }),
        );
        await expectRungLines(offer(page).getByTestId('calculator-rung-entitlements'));
        await expectNoneOffered(result(page));
      },
    );

    await timed(
      `Recipe 3 — no ${REMOVED_NAME} anywhere, and the callout names ${HOST.name}'s ${n(poolOf(HOST))}`,
      async () => {
        await openBilling(page, seed);
        await openPlans(page, copy.ai.choosePlan);
        await expectNoneOffered(live(page));
        for (const name of NOT_ON_SALE) {
          await expect(
            live(page).getByRole('button', { name: format(copy.plans.ctaChoose, { plan: name }) }),
          ).toHaveCount(0);
        }
        await expect(live(page).getByTestId('plans-need-more')).toContainText(
          format(copy.plans.needMore.body, { plan: HOST.name, credits: n(poolOf(HOST)) }),
        );
      },
    );

    await timed(
      `Recipe 4 — choose ${RUNG.name} monthly at $${n(RUNG.prices!.monthly.amountUsd)}; the invoice lands +${n(poolOf(RUNG))}`,
      async () => {
        await openCalculator(page);
        engine.high = poolOf(RUNG);
        await ask(page, 'monthly');
        await expect(offer(page).getByTestId('calculator-larger-price')).toContainText(
          format(copy.plans.perMoEquiv, { n: n(RUNG.prices!.monthly.amountUsd) }),
        );
        const sent = postTo(page, seed, '/checkout');
        await offer(page)
          .getByRole('button', { name: format(copy.plans.ctaChoose, { plan: RUNG.name }) })
          .click();
        const req = await sent;
        // The page names the price; motir-core sends motir-ai quantity 1 for it.
        expect(req.postDataJSON()).toEqual({ priceLookupKey: RUNG.prices!.monthly.priceLookupKey });
        expect((await req.response())?.status()).toBe(200);
        await page.waitForURL(E2E_CHECKOUT_URL);
        expect(posts['checkout']).toBe(1);

        setOrgBillingState(seed.organizationId, onPlan(RUNG, before + poolOf(RUNG)));
        const after = await openBilling(page, seed);
        expect(after - before).toBe(poolOf(RUNG));
        await openPlans(page, copy.ai.changePlan);
        await expect(live(page).getByRole('button', { name: copy.plans.ctaCurrent })).toBeVisible();
        await expect(live(page).getByText(RUNG.name, { exact: true }).first()).toBeVisible();
        await expectRungLines(live(page).getByTestId('plan-rung-entitlements'));
      },
    );

    await timed(
      `Recipe 9 — an org on ${HOST.name} upgrades to ${RUNG.name}: the change of plan, no checkout`,
      async () => {
        seed = await seedBillingOwner(page, `acc-rung-host-${Date.now().toString(36)}@example.com`);
        setOrgBillingState(
          seed.organizationId,
          withPlanChange(onPlan(HOST, 12_000), { upgradePreview: { [RUNG.key]: UPGRADE } }),
        );
        before = await openBilling(page, seed);
        // The counter is the whole walk's; Recipe 4's purchase is already in it.
        const checkouts = posts['checkout'] ?? 0;
        await openPlans(page, copy.ai.changePlan);
        await openCalculator(page);
        engine.high = poolOf(RUNG);
        await ask(page, 'monthly');
        await expect(live(page).getByText(copy.calculator.result.upgradeNote)).toBeVisible();
        const previewed = postTo(page, seed, '/upgrade/preview');
        await offer(page)
          .getByRole('button', { name: format(copy.plans.ctaUpgrade, { plan: RUNG.name }) })
          .click();
        expect((await previewed).postDataJSON()).toEqual({ toPlanKey: RUNG.key });
        const dialog = page.getByRole('dialog');
        await expect(dialog).toContainText(usd(UPGRADE.amountDueCents));
        await expect(dialog).toContainText(format(up.extraCredits, { n: n(UPGRADE.extraCredits) }));
        expect(UPGRADE.extraCredits).toBe(poolOf(RUNG) - poolOf(HOST));

        const confirmed = postTo(page, seed, '/upgrade');
        const reloaded = billingRead(page, seed);
        await dialog.getByRole('button', { name: up.confirm }).click();
        const req = await confirmed;
        expect(req.postDataJSON()).toEqual({
          toPlanKey: RUNG.key,
          prorationDate: UPGRADE.prorationDate,
        });
        expect((await req.response())?.status()).toBe(200);
        await expect(dialog).toContainText(format(up.success, { plan: RUNG.name }));
        await reloaded;
        expect(posts['checkout'] ?? 0).toBe(checkouts);

        // The upgrade invoice lands once; a replay adds nothing.
        const landed = onPlan(RUNG, before + UPGRADE.extraCredits);
        setOrgBillingState(seed.organizationId, landed);
        const after = await openBilling(page, seed);
        expect(after - before).toBe(UPGRADE.extraCredits);
        setOrgBillingState(seed.organizationId, landed);
        expect(await openBilling(page, seed)).toBe(after);
        await openPlans(page, copy.ai.changePlan);
        await expect(live(page).getByRole('button', { name: copy.plans.ctaCurrent })).toBeVisible();
        await expectRungLines(live(page).getByTestId('plan-rung-entitlements'));
      },
    );

    await timed('Recipe 10 — 中文: the held rung, the callout and the offer card', async () => {
      const zc = zh.billing as unknown as typeof en.billing;
      await saveAccountLanguageInSettings(page, 'zh');
      await openBilling(page, seed);
      await openPlans(page, zc.ai.changePlan, zc);
      await expectRungLines(live(page).getByTestId('plan-rung-entitlements'), zc);
      await expect(live(page).getByTestId('plans-need-more')).toContainText(
        format(zc.plans.needMore.bodyHeld, { credits: n(poolOf(RUNG)) }),
      );

      setOrgBillingState(seed.organizationId, freeOrgState(185));
      await openBilling(page, seed);
      await openPlans(page, zc.ai.choosePlan, zc);
      await expect(live(page).getByTestId('plans-need-more')).toContainText(
        format(zc.plans.needMore.body, { plan: HOST.name, credits: n(poolOf(HOST)) }),
      );
      await openCalculator(page, zc);
      engine.high = ABOVE_HOST;
      await ask(page, 'monthly', zc);
      await expect(offer(page)).toContainText(
        format(zc.calculator.result.largerPlan, { plan: OFFERED.name }),
      );
      await expect(offer(page)).toContainText(zc.calculator.result.largerPlanEstimate);
      await expectRungLines(offer(page).getByTestId('calculator-rung-entitlements'), zc);
      for (const english of [
        copy.plans.larger.ownAccounts,
        copy.plans.larger.sharedUntilGranted,
        copy.calculator.result.largerPlanEstimate,
      ]) {
        await expect(live(page)).not.toContainText(english);
      }
      await expect(page.getByText(/billing\.(calculator|plans)\./)).toHaveCount(0);
    });

    const verdict = assessWatchability({
      chapters: starts.map((tSeconds, i) => ({ label: String(i), tSeconds })),
      meta: { totalSeconds: (Date.now() - t0) / 1000 },
    });
    expect(verdict.watchable, verdict.reason ?? '').toBe(true);
    expect(pageErrors).toEqual([]);
  });
});
