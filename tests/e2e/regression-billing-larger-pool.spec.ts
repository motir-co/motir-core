import type { Page, Request, Response } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
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
import {
  InvalidBillingQuantityError,
  LargerPoolAtOrBelowCeilingError,
  UnknownBillingPriceError,
} from '@/lib/billing/errors';
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
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// BUYING THE LARGER CREDIT POOL (Story MOTIR-8986 · MOTIR-9000) — the story's
// acceptance receipt. An owner with no plan reads the four regular plans and the
// "Need more credits?" entry, asks the Calculator, is offered the pool sized to the
// estimate on the answer itself, and buys it monthly, then annually; above every
// pool the answer offers the largest one and top-ups for the rest; an owner on
// Max ×2 moves up to a pool through the shipped change-of-plan dialog; the same
// offer reads in 中文. A second test meets every refusal the page can raise.
//
// ── WHAT THIS LANE CAN AND CANNOT PROVE ───────────────────────────────────────
// motir-ai is the lane's E2E_TEST_BILLING boundary mock and Stripe is never
// reached. The Calculator's two routes are answered at the BROWSER layer, playing
// the engine (the lane's motir-ai host does not exist), and the estimate names the
// pool the engine's rule would: the smallest rung at or above the high end. The
// owner's balance is the FIXTURE replaying a paid invoice, so every balance
// assertion is what the PAGE shows once the boundary reports the grant — never
// that motir-ai granted, that the price reconciled against its tier row, or that
// Stripe holds the prices. Those are motir-ai's integration suite's.
//
// ── FIGURES ───────────────────────────────────────────────────────────────────
// Every pool, price and key is read from `lib/billing/catalog.ts` (the rung table,
// the ceiling, the band); every sentence from `messages/*.json`. The one literal
// is the change-of-plan preview's charge (`amountDueCents`) and its proration
// stamp, which motir-ai would compute and the fixture hands over; its pools, price
// and extra credits are computed here from the two catalogue entries.
//
// ── WAITS ─────────────────────────────────────────────────────────────────────
// Every step waits on a request, a response or a rendered landmark armed before
// the action. `beat()` is pacing for the reviewer, never synchronisation.

test.describe.configure({ timeout: 300_000 });

const copy = en.billing;
const billingPath = '/settings/organization/billing';
const BAND = largerPoolPlans();
const SMALLEST = BAND[0]!;
const LARGEST = BAND[BAND.length - 1]!;
const CEILING = maxMonthlyPlanCredits();
const LADDER = BILLING_CATALOG.aiPlans.filter((p) => p.band === 'ladder' && p.prices);
const TOP = LADDER.reduce((a, b) => (b.allotment!.credits > a.allotment!.credits ? b : a));
const TOPUP = BILLING_CATALOG.creditTopup;
const CATEGORY = PINNED_CATEGORIES_ANSWER.categories[0]!.key;
const PERIOD_END = '2026-11-01T00:00:00.000Z';

const poolOf = (p: AiPlanCatalogEntry) => p.allotment!.credits;
const n = (v: number) => v.toLocaleString('en-US');
const format = (message: string, values: Record<string, string | number>): string =>
  message.replace(/\{(\w+)\}/g, (_m, name: string) => String(values[name]));
const label = (key: string) => key.charAt(0).toUpperCase() + key.slice(1);
const tierOf = (plan: AiPlanCatalogEntry): BillingFixtureTier => ({
  key: plan.key,
  name: plan.name,
  monthlyCreditAllotment: poolOf(plan),
});
const onPlan = (plan: AiPlanCatalogEntry, balance: number, cadence: 'monthly' | 'annual') =>
  paidOrgState({
    tier: tierOf(plan),
    balance,
    priceLookupKey: plan.prices![cadence].priceLookupKey,
    currentPeriodEnd: PERIOD_END,
  });
const codeOf = (error: { code: string }) => error.code;

// ── the engine, played at the browser ─────────────────────────────────────────

type Outcome = CalculatorEstimateDTO['ceiling']['outcome'];

/** The engine's answer for a high end: the rung its rule names, or the largest. */
function answerFor(body: Record<string, unknown>, high: number): CalculatorEstimateDTO {
  const base = structuredClone(PINNED_ESTIMATE_ANSWER) as unknown as CalculatorEstimateDTO;
  const rung = BAND.find((p) => poolOf(p) >= high) ?? LARGEST;
  const outcome: Outcome =
    high <= CEILING ? 'within_ladder' : poolOf(rung) >= high ? 'larger_pool' : 'largest_pool';
  const plan = outcome === 'within_ladder' ? TOP : rung;
  const excess = Math.max(0, high - poolOf(plan));
  const units = outcome === 'largest_pool' ? Math.ceil(excess / TOPUP.unitCredits) : 0;
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
  const engine = { high: poolOf(SMALLEST) };
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
function countPosts(page: Page, seed: BillingSeed): Record<string, number> {
  const counts: Record<string, number> = {};
  page.on('request', (req) => {
    const path = new URL(req.url()).pathname;
    if (req.method() === 'POST' && path.startsWith(orgPath(seed, '/'))) {
      const key = path.slice(orgPath(seed, '/').length);
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

/** Set the cadence, type a planned range (the run range follows), pick one category, ask. */
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
  await live(page).getByTestId('calculator-result').scrollIntoViewIfNeeded();
}

/** Press the offer's Choose and answer the checkout body; the browser lands on Stripe. */
async function choose(page: Page, seed: BillingSeed, plan: AiPlanCatalogEntry) {
  const sent = postTo(page, seed, '/checkout');
  await offer(page)
    .getByRole('button', { name: format(copy.plans.ctaChoose, { plan: plan.name }) })
    .click();
  const req = await sent;
  expect((await req.response())?.status()).toBe(200);
  await page.waitForURL(E2E_CHECKOUT_URL);
  return req.postDataJSON() as Record<string, unknown>;
}

/** The plans view of an org holding `plan`: that one card, the regular row folded. */
async function expectHeld(page: Page, plan: AiPlanCatalogEntry) {
  await expect(
    page.getByRole('heading', { name: copy.plans.yourPlanTitle, level: 2 }),
  ).toBeVisible();
  await expect(live(page).getByRole('button', { name: copy.plans.ctaCurrent })).toBeVisible();
  await expect(live(page).getByText(plan.name, { exact: true }).first()).toBeVisible();
  for (const other of BAND.filter((p) => p.key !== plan.key)) {
    await expect(live(page).getByText(other.name, { exact: true })).toHaveCount(0);
  }
  const toggle = live(page).getByRole('button', { name: copy.plans.larger.showRegular });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(live(page).getByText(TOP.name, { exact: true })).toHaveCount(0);
  await toggle.click();
  await expect(live(page).getByText(TOP.name, { exact: true }).first()).toBeVisible();
  await live(page).getByRole('button', { name: copy.plans.larger.hideRegular }).click();
  await expect(live(page).getByTestId('plans-need-more')).toContainText(
    format(copy.plans.needMore.bodyHeld, { credits: n(poolOf(plan)) }),
  );
}

/** The change-of-plan preview motir-ai would answer for TOP → `to`, 17 days left. */
function upgradePreview(to: AiPlanCatalogEntry): RawUpgradePreview {
  const daysLeft = 17;
  return {
    prorationDate: 1_792_238_400,
    fromPlan: TOP.key,
    toPlan: to.key,
    cadence: 'monthly',
    cadenceChange: null,
    amountDueCents: 5_100,
    currency: 'usd',
    periodStart: '2026-10-01T00:00:00.000Z',
    periodEnd: PERIOD_END,
    billingDaysLeft: daysLeft,
    daysLeft,
    creditWindowEnd: PERIOD_END,
    extraCredits: Math.round(((poolOf(to) - poolOf(TOP)) * daysLeft) / 30),
    extraIndexAllowance: 0,
    fromPool: poolOf(TOP),
    fullPool: poolOf(to),
    fullAllowance: 0,
    toPriceCents: Math.round(to.prices!.monthly.amountUsd * 100),
    pendingDowngrade: null,
  };
}

const withPlanChange = (
  entry: BillingFixtureEntry,
  planChange: NonNullable<BillingFixtureEntry['planChange']>,
): BillingFixtureEntry => ({ ...entry, planChange });

// ── the walk ────────────────────────────────────────────────────────────────

test.describe('The larger credit pool, sold from the Calculator', () => {
  test('an owner buys the pool monthly and annually, sees the largest pool past it, and upgrades from Max ×2', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-8986');
    const pageErrors: Error[] = [];
    page.on('pageerror', (e) => pageErrors.push(e));
    const seed = await seedBillingOwner(page, `acc-pool-${Date.now().toString(36)}@example.com`);
    setOrgBillingState(seed.organizationId, freeOrgState(185));
    const engine = await armEngine(page);
    const posts = countPosts(page, seed);
    const t0 = Date.now();
    const starts: number[] = [];
    const timed = async (title: string, body: () => Promise<void>) => {
      starts.push((Date.now() - t0) / 1000);
      await chapter(title, body);
      await beat();
    };
    let before = 0;

    await timed('The plans view: the four regular plans, and Need more credits?', async () => {
      before = await openBilling(page, seed);
      await openPlans(page, copy.ai.choosePlan);
      await expect(
        page.getByRole('heading', { name: copy.plans.chooseTitle, level: 2 }),
      ).toBeVisible();
      for (const plan of LADDER)
        await expect(live(page).getByText(plan.name, { exact: true }).first()).toBeVisible();
      for (const rung of BAND)
        await expect(page.getByText(rung.name, { exact: true })).toHaveCount(0);
      const entry = live(page).getByTestId('plans-need-more');
      await expect(entry).toContainText(copy.plans.needMore.title);
      await expect(entry).toContainText(
        format(copy.plans.needMore.body, { plan: TOP.name, credits: n(poolOf(TOP)) }),
      );
    });

    await timed('The Calculator offers the pool sized to the estimate, on the answer', async () => {
      await openCalculator(page);
      engine.high = poolOf(SMALLEST) - 1;
      await ask(page, 'monthly');
      await expect(offer(page)).toContainText(copy.calculator.result.largerPoolLabel);
      await expect(offer(page)).toContainText(
        format(copy.calculator.result.largerPlan, { plan: SMALLEST.name }),
      );
      await expect(offer(page).getByTestId('calculator-larger-price')).toContainText(
        format(copy.plans.perMoEquiv, { n: n(SMALLEST.prices!.monthly.amountUsd) }),
      );
      await expect(offer(page)).toContainText(
        format(copy.plans.creditsAllotment, { n: n(poolOf(SMALLEST)) }),
      );
      await expect(offer(page)).toContainText(copy.calculator.result.largerPlanEstimate);
      await expect(live(page).getByTestId('calculator-plan')).toHaveCount(0);
    });

    await timed('Choose: one checkout with the pool’s monthly key, and on to Stripe', async () => {
      const body = await choose(page, seed, SMALLEST);
      expect(body).toEqual({ priceLookupKey: SMALLEST.prices!.monthly.priceLookupKey });
      expect(posts['checkout']).toBe(1);
    });

    await timed('The paid invoice lands: the pool is the org’s one plan', async () => {
      setOrgBillingState(
        seed.organizationId,
        onPlan(SMALLEST, before + poolOf(SMALLEST), 'monthly'),
      );
      const after = await openBilling(page, seed);
      expect(after - before).toBe(poolOf(SMALLEST));
      await openPlans(page, copy.ai.changePlan);
      await expectHeld(page, SMALLEST);
    });

    await timed('Annual, from no plan: the same pool at its yearly price', async () => {
      setOrgBillingState(seed.organizationId, freeOrgState(185));
      before = await openBilling(page, seed);
      await openPlans(page, copy.ai.choosePlan);
      await openCalculator(page);
      await ask(page, 'annual');
      await expect(offer(page).getByTestId('calculator-larger-price')).toContainText(
        format(copy.plans.annualSub, { yr: n(SMALLEST.prices!.annual.amountUsd) }),
      );
      const body = await choose(page, seed, SMALLEST);
      expect(body).toEqual({ priceLookupKey: SMALLEST.prices!.annual.priceLookupKey });
      setOrgBillingState(
        seed.organizationId,
        onPlan(SMALLEST, before + poolOf(SMALLEST), 'annual'),
      );
      expect((await openBilling(page, seed)) - before).toBe(poolOf(SMALLEST));
    });

    await timed('Above every pool: the largest pool, and top-ups for the rest', async () => {
      setOrgBillingState(seed.organizationId, freeOrgState(185));
      await openBilling(page, seed);
      await openPlans(page, copy.ai.choosePlan);
      await openCalculator(page);
      engine.high = poolOf(LARGEST) + 12 * TOPUP.unitCredits;
      await ask(page, 'monthly');
      await expect(offer(page)).toContainText(copy.calculator.result.largestPoolLabel);
      await expect(offer(page)).toContainText(
        format(copy.calculator.result.largestPool, { plan: LARGEST.name }),
      );
      await expect(offer(page).getByTestId('calculator-largest-topup')).toHaveText(
        format(copy.calculator.result.largestPoolTopUp, {
          excess: n(12 * TOPUP.unitCredits),
          units: 12,
          unitCredits: n(TOPUP.unitCredits),
          price: n(12 * TOPUP.unitAmountUsd),
        }),
      );
      await expect(
        offer(page).getByRole('button', {
          name: format(copy.plans.ctaChoose, { plan: LARGEST.name }),
        }),
      ).toBeEnabled();
    });

    await timed(
      'An owner on Max ×2 moves up through the change-of-plan dialog, no checkout',
      async () => {
        const preview = upgradePreview(SMALLEST);
        setOrgBillingState(
          seed.organizationId,
          withPlanChange(onPlan(TOP, 12_000, 'monthly'), {
            upgradePreview: { [SMALLEST.key]: preview },
          }),
        );
        before = await openBilling(page, seed);
        const checkouts = posts['checkout'] ?? 0;
        await openPlans(page, copy.ai.changePlan);
        await openCalculator(page);
        engine.high = poolOf(SMALLEST) - 1;
        await ask(page, 'monthly');
        // The note sits under the offer card, not inside it.
        await expect(live(page).getByText(copy.calculator.result.upgradeNote)).toBeVisible();
        const previewed = postTo(page, seed, '/upgrade/preview');
        await offer(page)
          .getByRole('button', { name: format(copy.plans.ctaUpgrade, { plan: SMALLEST.name }) })
          .click();
        expect((await previewed).postDataJSON()).toEqual({ toPlanKey: SMALLEST.key });
        const dialog = page.getByRole('dialog');
        await expect(dialog).toContainText(
          format(copy.plans.upgrade.extraCredits, { n: n(preview.extraCredits) }),
        );
        const confirmed = postTo(page, seed, '/upgrade');
        // A confirmed change reloads the billing read; let it land before navigating,
        // or the next openBilling catches this response and loses its body.
        const reloaded = billingRead(page, seed);
        await dialog.getByRole('button', { name: copy.plans.upgrade.confirm }).click();
        const req = await confirmed;
        expect(req.postDataJSON()).toEqual({
          toPlanKey: SMALLEST.key,
          prorationDate: preview.prorationDate,
        });
        expect((await req.response())?.status()).toBe(200);
        await expect(dialog).toContainText(
          format(copy.plans.upgrade.success, { plan: SMALLEST.name }),
        );
        await reloaded;
        expect(posts['checkout'] ?? 0).toBe(checkouts);
        setOrgBillingState(
          seed.organizationId,
          onPlan(SMALLEST, before + preview.extraCredits, 'monthly'),
        );
        expect((await openBilling(page, seed)) - before).toBe(preview.extraCredits);
        await openPlans(page, copy.ai.changePlan);
        await expectHeld(page, SMALLEST);
      },
    );

    await timed('中文: the same offer, the words from the 中文 catalogue', async () => {
      setOrgBillingState(seed.organizationId, freeOrgState(185));
      await saveAccountLanguageInSettings(page, 'zh');
      await openBilling(page, seed);
      await openPlans(page, zh.billing.ai.choosePlan, zh.billing);
      await openCalculator(page, zh.billing);
      engine.high = poolOf(SMALLEST) - 1;
      await ask(page, 'monthly', zh.billing);
      await expect(offer(page)).toContainText(zh.billing.calculator.result.largerPoolLabel);
      await expect(offer(page)).toContainText(zh.billing.calculator.result.largerPlanEstimate);
      await expect(offer(page)).toContainText(SMALLEST.name);
      await expect(page.getByText(/billing\.(calculator|plans)\./)).toHaveCount(0);
    });

    // No watchability floor here (MOTIR-9411): this spec ran in the recording
    // lane, where it asserted its clip was long enough to watch. The regression
    // lane records nothing and holds nothing, so that floor measured an apparatus
    // this lane does not have. The receipt it guarded is recorded.
    expect(pageErrors).toEqual([]);
  });

  test('what the page refuses, and where it offers nothing', async ({ page }) => {
    const seed = await seedBillingOwner(
      page,
      `acc-pool-ref-${Date.now().toString(36)}@example.com`,
    );
    setOrgBillingState(seed.organizationId, freeOrgState(185));
    const engine = await armEngine(page);
    await openBilling(page, seed);

    // Purchases the page never makes, crafted from the signed-in browser.
    const checkout = (data: Record<string, unknown>) =>
      page.request.post(orgPath(seed, '/checkout'), { data });
    const monthlyKey = SMALLEST.prices!.monthly.priceLookupKey;
    const twice = await checkout({ priceLookupKey: monthlyKey, quantity: 2 });
    expect(twice.status()).toBe(400);
    expect(await twice.json()).toMatchObject({
      code: codeOf(new InvalidBillingQuantityError(monthlyKey, 2)),
    });
    const offBand = `pool_${(poolOf(SMALLEST) + 1_000) / 1000}k_pool_monthly`;
    const unknown = await checkout({ priceLookupKey: offBand });
    expect(unknown.status()).toBe(400);
    expect(await unknown.json()).toMatchObject({
      code: codeOf(new UnknownBillingPriceError(offBand)),
    });
    const atCeiling = `pool_${CEILING / 1000}k_pool_monthly`;
    const low = await checkout({ priceLookupKey: atCeiling });
    expect(low.status()).toBe(400);
    expect(await low.json()).toMatchObject({
      code: codeOf(new LargerPoolAtOrBelowCeilingError(atCeiling, CEILING, CEILING)),
    });
    const ladder = await checkout({ priceLookupKey: TOP.prices!.monthly.priceLookupKey });
    expect(ladder.status()).toBe(200);

    // A refused buy on the offer reads its own sentence, and Stripe is never reached.
    await openPlans(page, copy.ai.choosePlan);
    await openCalculator(page);
    engine.high = poolOf(SMALLEST) - 1;
    await ask(page, 'monthly');
    const refusals = [
      [
        { code: codeOf(new UnknownBillingPriceError(monthlyKey)), error: 'x' },
        copy.plans.larger.refused.notForSale,
      ],
      [
        {
          code: 'MOTIR_AI_BAD_REQUEST',
          error: 'motir-ai rejected the request: plan_offer_expired: moved',
        },
        copy.plans.larger.refused.offerExpired,
      ],
    ] as const;
    for (const [body, sentence] of refusals) {
      await page.route(
        '**/billing/checkout',
        (route) => route.fulfill({ status: 400, json: body }),
        { times: 1 },
      );
      await offer(page)
        .getByRole('button', { name: format(copy.plans.ctaChoose, { plan: SMALLEST.name }) })
        .click();
      await expect(live(page).getByTestId('calculator-larger-refused')).toHaveText(sentence);
      expect(page.url()).toContain(billingPath);
    }

    // At or below the ceiling the answer is a regular plan, with no pool.
    engine.high = CEILING;
    await ask(page, 'monthly');
    await expect(live(page).getByTestId('calculator-plan')).toContainText(TOP.name);
    await expect(page.getByTestId('calculator-larger')).toHaveCount(0);

    // An org whose pool already covers the offer is sold nothing again.
    setOrgBillingState(seed.organizationId, onPlan(LARGEST, 1_000, 'monthly'));
    await openBilling(page, seed);
    await openPlans(page, copy.ai.changePlan);
    await openCalculator(page);
    engine.high = poolOf(SMALLEST) - 1;
    await ask(page, 'monthly');
    await expect(offer(page).getByRole('button')).toHaveCount(0);

    // motir-ai refusing the change of plan keeps the dialog and charges nothing.
    const changeRefusals = [
      ['second_plan', 400, copy.plans.upgrade.error],
      ['payment_failed', 402, copy.plans.upgrade.refusedPayment],
    ] as const;
    for (const [reason, status, sentence] of changeRefusals) {
      setOrgBillingState(
        seed.organizationId,
        withPlanChange(onPlan(TOP, 12_000, 'monthly'), {
          upgradePreview: { [SMALLEST.key]: upgradePreview(SMALLEST) },
          refuse: { upgrade: reason },
        }),
      );
      const balance = await openBilling(page, seed);
      await openPlans(page, copy.ai.changePlan);
      await openCalculator(page);
      await ask(page, 'monthly');
      const previewed = postTo(page, seed, '/upgrade/preview');
      await offer(page)
        .getByRole('button', { name: format(copy.plans.ctaUpgrade, { plan: SMALLEST.name }) })
        .click();
      await (await previewed).response();
      const dialog = page.getByRole('dialog');
      const confirmed = postTo(page, seed, '/upgrade');
      await dialog.getByRole('button', { name: copy.plans.upgrade.confirm }).click();
      expect((await (await confirmed).response())?.status()).toBe(status);
      await expect(dialog).toContainText(sentence);
      await expect(dialog).toBeVisible();
      expect(await openBilling(page, seed)).toBe(balance);
    }
  });
});
