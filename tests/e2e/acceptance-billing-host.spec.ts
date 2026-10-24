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
import type { RawDowngradePreview, RawUpgradePreview } from '@/lib/ai/types';
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

// HOST, A REGULAR PLAN OF 300,000 CREDITS (Story MOTIR-9364 · MOTIR-9407) — the
// story's acceptance receipt. An owner with no plan reads the five plan cards with
// Host last, on both cadences, and chooses Host monthly; once the paid invoice
// lands the org is on Host with +300,000. An owner on Max ×2 upgrades to Host for
// the days left, then schedules a downgrade back to Max ×2. The Calculator still
// offers the largest larger pool, never Host, and that pool is still bought. The
// Host card and the upgrade read in 中文.
//
// ── WHAT THIS LANE CAN AND CANNOT PROVE ───────────────────────────────────────
// motir-ai is the lane's E2E_TEST_BILLING boundary mock and Stripe is never
// reached: Checkout lands on E2E_CHECKOUT_URL, so "buys it monthly through
// Checkout" means through motir-core's Checkout door to the Checkout URL, not a
// payment. The Calculator's two routes are answered at the BROWSER, playing the
// engine. The owner's balance is the FIXTURE replaying a paid invoice, so every
// balance assertion is what the PAGE shows once the boundary reports the grant.
// So this proves the requests motir-core sends (the lookup key, quantity 1,
// `toPlanKey`, the preview's `prorationDate`), motir-core's own refusals (a
// `pool_250k` checkout is not refused at the ceiling, as it would be had the
// ceiling moved to Host), and what the page shows. It does NOT prove that Stripe
// holds the Host prices, that motir-ai granted 300,000 or reconciled the price,
// or that the real engine never recommends Host: those are the test-mode Stripe
// card's (MOTIR-9399, its recorded test-mode Checkout and proration preview) and
// the motir-ai story gate's (MOTIR-9405).
//
// ── FIGURES ───────────────────────────────────────────────────────────────────
// Every plan name, pool, price and key is read from `lib/billing/catalog.ts`
// (Host, Max ×2 and the rungs from `largerPoolPlans()`), every sentence from
// `messages/en.json` / `zh.json`. The only literals are the change-of-plan
// previews' `amountDueCents` and `prorationDate`, which motir-ai would compute and
// the fixture hands over; their pools, prices and extra credits are computed from
// the catalog entries.
//
// ── WAITS ─────────────────────────────────────────────────────────────────────
// Every step waits on a request, a response, the billing panel's own read or a
// rendered landmark armed before the action. `beat()` is pacing, never
// synchronisation.

test.describe.configure({ timeout: 300_000 });

const copy = en.billing;
const up = copy.plans.upgrade;
const down = copy.plans.downgrade;
const billingPath = '/settings/organization/billing';

const entry = (key: AiPlanCatalogEntry['key']): AiPlanCatalogEntry => {
  const found = BILLING_CATALOG.aiPlans.find((p) => p.key === key);
  if (!found) throw new Error(`the catalog has no ${key} entry`);
  return found;
};
const HOST = entry('host');
const MAX_X2 = entry('max_x2');
const PRO = entry('pro');
const PAID = BILLING_CATALOG.aiPlans.filter(
  (p) => p.key !== 'free' && p.prices && (p.band === 'ladder' || p.band === 'host'),
);
const LOWER = PAID.filter((p) => p.key !== HOST.key);
const BAND = largerPoolPlans();
const LARGEST = BAND[BAND.length - 1]!;
const CEILING = maxMonthlyPlanCredits();
const TOPUP = BILLING_CATALOG.creditTopup;
const CATEGORY = PINNED_CATEGORIES_ANSWER.categories[0]!.key;
const PERIOD_END = '2026-11-01T00:00:00.000Z';
const PERIOD_END_TEXT = 'Nov 1, 2026';
const DAYS_LEFT = 17;

const poolOf = (p: AiPlanCatalogEntry) => p.allotment!.credits;
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
type HostCopy = { useCase: string; prev: string; features: string[] };
const hostCopy = (messages: typeof en) =>
  (messages.billing.plans.tiers as unknown as Record<string, HostCopy>).host!;

// Max ×2 → Host, 17 days before the period end. The charge and the stamp are literals.
const UPGRADE: RawUpgradePreview = {
  prorationDate: 1_792_238_400,
  fromPlan: MAX_X2.key,
  toPlan: HOST.key,
  cadence: 'monthly',
  cadenceChange: null,
  amountDueCents: 58_065,
  currency: 'usd',
  periodStart: '2026-10-01T00:00:00.000Z',
  periodEnd: PERIOD_END,
  billingDaysLeft: DAYS_LEFT,
  daysLeft: DAYS_LEFT,
  creditWindowEnd: PERIOD_END,
  extraCredits: Math.round(((poolOf(HOST) - poolOf(MAX_X2)) * DAYS_LEFT) / 30),
  extraIndexAllowance: 0,
  fromPool: poolOf(MAX_X2),
  fullPool: poolOf(HOST),
  fullAllowance: 0,
  toPriceCents: Math.round(HOST.prices!.monthly.amountUsd * 100),
  pendingDowngrade: null,
};

// Host → Max ×2 at the period end: nothing due, nothing refunded.
const DOWNGRADE: RawDowngradePreview = {
  fromPlan: HOST.key,
  toPlan: MAX_X2.key,
  cadence: 'monthly',
  cadenceChange: null,
  effectiveDate: PERIOD_END,
  amountDueCents: 0,
  refundCents: 0,
  creditsChange: 0,
  allowanceChange: 0,
  fromPool: poolOf(HOST),
  fullPool: poolOf(MAX_X2),
  fullAllowance: 0,
  toPriceCents: Math.round(MAX_X2.prices!.monthly.amountUsd * 100),
  currency: 'usd',
  pendingDowngrade: null,
};

const withPlanChange = (
  state: BillingFixtureEntry,
  planChange: NonNullable<BillingFixtureEntry['planChange']>,
): BillingFixtureEntry => ({ ...state, planChange });

// ── the engine, played at the browser ─────────────────────────────────────────

/** Above every rung: the largest pool and top-ups for the rest, as the engine's rule names. */
function largestAnswer(body: Record<string, unknown>, units: number): CalculatorEstimateDTO {
  const base = structuredClone(PINNED_ESTIMATE_ANSWER) as unknown as CalculatorEstimateDTO;
  const high = poolOf(LARGEST) + units * TOPUP.unitCredits;
  return {
    ...base,
    cadence: 'monthly',
    plannedPerMonth: body['plannedPerMonth'] as { low: number; high: number },
    runPerMonth: body['runPerMonth'] as { low: number; high: number },
    credits: { low: Math.round(high / 2), high },
    split: { count: 1, categories: [{ key: CATEGORY, weight: 1, models: [] }] },
    recommendation: {
      planKey: LARGEST.key,
      planName: LARGEST.name,
      monthlyPriceUsd: LARGEST.prices!.monthly.amountUsd,
    },
    topUp: {
      low: { units: 0, credits: 0, priceUsd: 0 },
      high: { units, credits: units * TOPUP.unitCredits, priceUsd: units * TOPUP.unitAmountUsd },
    },
    ceiling: {
      credits: CEILING,
      exceeded: true,
      excessCredits: high - CEILING,
      outcome: 'largest_pool',
    },
  };
}

const UNITS = 12;

async function armEngine(page: Page) {
  await page.route('**/billing/calculator/categories', (route) =>
    route.fulfill({ status: 200, json: PINNED_CATEGORIES_ANSWER }),
  );
  await page.route('**/billing/calculator/estimate', (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({ status: 200, json: largestAnswer(body, UNITS) });
  });
  await page.route('https://checkout.stripe.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<html><body>stripe</body></html>',
    }),
  );
}

// ── page helpers ────────────────────────────────────────────────────────────

const live = (page: Page) => page.getByRole('main');
const orgPath = (seed: BillingSeed, path: string) =>
  `/api/organizations/${seed.organizationId}/billing${path}`;
const cardRow = (page: Page): Locator => live(page).locator('div.snap-x');
const cardNames = (page: Page): Locator =>
  cardRow(page).locator(':scope > div > div > span.font-semibold');
const card = (page: Page, name: string): Locator =>
  cardRow(page)
    .locator(':scope > div')
    .filter({
      has: page.locator('span.font-semibold', { hasText: new RegExp(`^${escapeRegExp(name)}$`) }),
    });

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

async function setCadence(page: Page, word: string) {
  await page.getByRole('button', { name: word, exact: true }).click();
  await expect(page.getByRole('button', { name: word, exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
}

/** Press a card's change-of-plan control and wait for the preview it fetches. */
async function openDialog(
  page: Page,
  seed: BillingSeed,
  kind: 'upgrade' | 'downgrade',
  plan: AiPlanCatalogEntry,
  messages = en.billing,
): Promise<Locator> {
  const previewed = postTo(page, seed, `/${kind}/preview`);
  await card(page, plan.name)
    .getByRole('button', { name: format(messages.plans[kind].cta, { plan: plan.name }) })
    .click();
  const req = await previewed;
  expect(req.postDataJSON()).toEqual({ toPlanKey: plan.key });
  expect((await req.response())?.status()).toBe(200);
  return page.getByRole('dialog');
}

/** Press the dialog's confirm; answers the body sent and the response status. */
async function confirm(page: Page, seed: BillingSeed, dialog: Locator, path: string, name: string) {
  const sent = postTo(page, seed, path);
  await dialog.getByRole('button', { name }).click();
  const req = await sent;
  const res = await req.response();
  return { body: req.postDataJSON() as Record<string, unknown>, status: res?.status() };
}

/**
 * Land a paid upgrade invoice on the fixture, as motir-ai's webhook would: the tier
 * moves and the balance rises by the previewed credits. Idempotent on the invoice
 * id, as the webhook's credit is — a replay changes nothing.
 */
const landed = new Set<string>();
function landUpgradeInvoice(seed: BillingSeed, invoiceId: string, balanceBefore: number) {
  if (landed.has(invoiceId)) return;
  landed.add(invoiceId);
  setOrgBillingState(
    seed.organizationId,
    withPlanChange(onPlan(HOST, balanceBefore + UPGRADE.extraCredits), {
      downgradePreview: { [MAX_X2.key]: DOWNGRADE },
    }),
  );
}

// ── the walk ────────────────────────────────────────────────────────────────

test.describe('Host, a regular plan of 300,000 credits', () => {
  test('an owner buys Host monthly, a Max ×2 org upgrades to it and schedules a downgrade, and the largest pool is still sold', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-9364');
    const pageErrors: Error[] = [];
    page.on('pageerror', (e) => pageErrors.push(e));
    const seed = await seedBillingOwner(page, `acc-host-${Date.now().toString(36)}@example.com`);
    setOrgBillingState(seed.organizationId, freeOrgState(185));
    await armEngine(page);
    const posts = countPosts(page, seed);
    const t0 = Date.now();
    const starts: number[] = [];
    const timed = async (title: string, body: () => Promise<void>) => {
      starts.push((Date.now() - t0) / 1000);
      await chapter(title, body);
      await beat();
    };
    const host = () => card(page, HOST.name);
    let before = 0;

    await timed(
      `Five plan cards, ${HOST.name} last after ${MAX_X2.name}, at $${n(HOST.prices!.monthly.amountUsd)} a month`,
      async () => {
        before = await openBilling(page, seed);
        await openPlans(page, copy.ai.choosePlan);
        await setCadence(page, copy.plans.monthly);
        await expect(cardNames(page)).toHaveText(PAID.map((p) => p.name));
        await expect(host()).toContainText(
          format(copy.plans.creditsAllotment, { n: n(poolOf(HOST)) }),
        );
        await expect(host()).toContainText(
          format(copy.plans.perMoEquiv, { n: n(HOST.prices!.monthly.amountUsd) }),
        );
        await expect(host().getByTestId('plan-included-seat')).toBeVisible();
        await expect(host()).toContainText(format(copy.plans.everythingIn, { prev: MAX_X2.name }));
        for (const feature of hostCopy(en).features) await expect(host()).toContainText(feature);
        await expect(card(page, PRO.name)).toContainText(copy.plans.recommended);
        await expect(host()).not.toContainText(copy.plans.recommended);
        await expect(host()).not.toHaveAttribute('data-marked', /.*/);
        await expect(live(page).getByTestId('plans-need-more')).toContainText(
          format(copy.plans.needMore.body, { plan: MAX_X2.name, credits: n(poolOf(MAX_X2)) }),
        );
      },
    );

    await timed(
      `Annual: $${n(HOST.prices!.annual.amountUsd)} a year, its monthly equivalent and the saving`,
      async () => {
        const annual = HOST.prices!.annual.amountUsd;
        const monthly = HOST.prices!.monthly.amountUsd;
        await setCadence(page, copy.plans.annual);
        await expect(host()).toContainText(format(copy.plans.perMoEquiv, { n: n(annual / 12) }));
        await expect(host()).toContainText(format(copy.plans.annualSub, { yr: n(annual) }));
        await expect(host()).toContainText(
          format(copy.plans.annualSave, { n: n(monthly * 12 - annual) }),
        );
        await setCadence(page, copy.plans.monthly);
        await expect(host()).toContainText(format(copy.plans.perMoEquiv, { n: n(monthly) }));
      },
    );

    await timed('Choose Host: one checkout with its monthly key, and on to Checkout', async () => {
      const sent = postTo(page, seed, '/checkout');
      await host()
        .getByRole('button', { name: format(copy.plans.ctaChoose, { plan: HOST.name }) })
        .click();
      const req = await sent;
      expect(req.postDataJSON()).toEqual({ priceLookupKey: HOST.prices!.monthly.priceLookupKey });
      expect((await req.response())?.status()).toBe(200);
      await page.waitForURL(E2E_CHECKOUT_URL);
      expect(posts['checkout']).toBe(1);
      expect(posts['upgrade/preview'] ?? 0).toBe(0);
    });

    await timed(
      `The paid invoice lands: the org is on ${HOST.name} with +${n(poolOf(HOST))}`,
      async () => {
        setOrgBillingState(seed.organizationId, onPlan(HOST, before + poolOf(HOST)));
        const after = await openBilling(page, seed);
        expect(after - before).toBe(poolOf(HOST));
        expect(await openBilling(page, seed)).toBe(after);
        await openPlans(page, copy.ai.changePlan);
        await expect(cardNames(page)).toHaveText(PAID.map((p) => p.name));
        await expect(host().getByRole('button', { name: copy.plans.ctaCurrent })).toBeVisible();
        for (const plan of LOWER) {
          await expect(
            card(page, plan.name).getByRole('button', {
              name: format(down.cta, { plan: plan.name }),
            }),
          ).toBeVisible();
        }
      },
    );

    await timed('On Max ×2: upgrade to Host for the days left, no checkout', async () => {
      setOrgBillingState(
        seed.organizationId,
        withPlanChange(onPlan(MAX_X2, 12_000), { upgradePreview: { [HOST.key]: UPGRADE } }),
      );
      before = await openBilling(page, seed);
      const checkouts = posts['checkout'] ?? 0;
      await openPlans(page, copy.ai.changePlan);
      const dialog = await openDialog(page, seed, 'upgrade', HOST);
      await expect(dialog).toContainText(usd(UPGRADE.amountDueCents));
      await expect(dialog).toContainText(
        format(up.daysLeft, { n: DAYS_LEFT, date: PERIOD_END_TEXT }),
      );
      await expect(dialog).toContainText(format(up.extraCredits, { n: n(UPGRADE.extraCredits) }));
      await expect(dialog).toContainText(`${PERIOD_END_TEXT}: ${HOST.name} at`);

      const reloaded = billingRead(page, seed);
      const { body, status } = await confirm(page, seed, dialog, '/upgrade', up.confirm);
      expect(status).toBe(200);
      expect(body).toEqual({ toPlanKey: HOST.key, prorationDate: UPGRADE.prorationDate });
      await expect(dialog).toContainText(format(up.success, { plan: HOST.name }));
      await reloaded;
      expect(posts['checkout'] ?? 0).toBe(checkouts);

      landUpgradeInvoice(seed, 'in_e2e_upgrade', before);
      const after = await openBilling(page, seed);
      expect(after - before).toBe(UPGRADE.extraCredits);
      landUpgradeInvoice(seed, 'in_e2e_upgrade', before);
      expect(await openBilling(page, seed)).toBe(after);
      before = after;
    });

    await timed('On Host: downgrade to Max ×2 at the period end, nothing due', async () => {
      await openPlans(page, copy.ai.changePlan);
      const dialog = await openDialog(page, seed, 'downgrade', MAX_X2);
      await expect(dialog).toContainText(format(down.takesEffect, { date: PERIOD_END_TEXT }));
      await expect(dialog).toContainText(down.dueToday);
      await expect(dialog).toContainText(format(down.creditsStay, { plan: HOST.name }));

      const { body, status } = await confirm(page, seed, dialog, '/downgrade', down.confirm);
      expect(status).toBe(200);
      expect(body).toEqual({ toPlanKey: MAX_X2.key });
      await expect(dialog.getByTestId('plan-change-success')).toHaveText(
        format(down.successBody, {
          current: HOST.name,
          date: PERIOD_END_TEXT,
          plan: MAX_X2.name,
        }),
      );
      await dialog.getByRole('button', { name: down.done }).click();

      setOrgBillingState(
        seed.organizationId,
        withPlanChange(onPlan(HOST, before), {
          downgradePreview: { [MAX_X2.key]: DOWNGRADE },
          pendingDowngrade: { planKey: MAX_X2.key, effectiveDate: PERIOD_END },
        }),
      );
      expect(await openBilling(page, seed)).toBe(before);
      await openPlans(page, copy.ai.changePlan);
      await expect(host().getByTestId('plan-pending-downgrade')).toHaveText(
        format(down.pendingPill, { plan: MAX_X2.name, date: PERIOD_END_TEXT }),
      );
      await expect(
        card(page, MAX_X2.name).getByRole('button', {
          name: format(down.scheduledButton, { date: PERIOD_END_TEXT }),
        }),
      ).toBeDisabled();
    });

    await timed(
      'The Calculator still offers the largest pool and top-ups, never Host',
      async () => {
        setOrgBillingState(seed.organizationId, freeOrgState(185));
        await openBilling(page, seed);
        await openPlans(page, copy.ai.choosePlan);
        await live(page)
          .getByTestId('plans-need-more')
          .getByRole('button', { name: copy.plans.needMore.action })
          .click();
        await expect(
          page.getByRole('heading', { name: copy.calculator.title, level: 1 }),
        ).toBeVisible();
        const planned = live(page).getByTestId('calculator-planned');
        await planned.getByLabel(copy.calculator.inputs.lowLabel).fill('40');
        await planned.getByLabel(copy.calculator.inputs.highLabel).fill('90');
        const pick = live(page).getByRole('button', { name: new RegExp(`^${label(CATEGORY)}`) });
        if ((await pick.getAttribute('aria-pressed')) !== 'true') await pick.click();
        const answered = page.waitForResponse((r) =>
          r.url().endsWith('/billing/calculator/estimate'),
        );
        await page.getByRole('button', { name: copy.calculator.inputs.submit }).click();
        await answered;
        const offer = live(page).getByTestId('calculator-larger');
        await expect(offer).toContainText(
          format(copy.calculator.result.largestPool, { plan: LARGEST.name }),
        );
        await live(page).getByTestId('calculator-result').scrollIntoViewIfNeeded();
        await expect(offer.getByTestId('calculator-largest-topup')).toBeVisible();
        await expect(live(page).getByTestId('calculator-result')).not.toContainText(
          new RegExp(`\\b${escapeRegExp(HOST.name)}\\b`),
        );
        await expect(
          live(page).getByRole('button', {
            name: format(copy.plans.ctaChoose, { plan: HOST.name }),
          }),
        ).toHaveCount(0);
      },
    );

    await timed(`Choose ${LARGEST.name}: still bought, at quantity 1`, async () => {
      const sent = postTo(page, seed, '/checkout');
      await live(page)
        .getByTestId('calculator-larger')
        .getByRole('button', { name: format(copy.plans.ctaChoose, { plan: LARGEST.name }) })
        .click();
      const req = await sent;
      // The Calculator buys on the plans view's cadence, which opens on annual
      // after the reload above.
      expect(req.postDataJSON()).toEqual({
        priceLookupKey: LARGEST.prices!.annual.priceLookupKey,
      });
      expect((await req.response())?.status()).toBe(200);
      await page.waitForURL(E2E_CHECKOUT_URL);
    });

    await timed('中文: the Host card and the upgrade to Host', async () => {
      await saveAccountLanguageInSettings(page, 'zh');
      const zhCopy = hostCopy(zh as unknown as typeof en);
      setOrgBillingState(seed.organizationId, freeOrgState(185));
      await openBilling(page, seed);
      await openPlans(page, zh.billing.ai.choosePlan, zh.billing as unknown as typeof en.billing);
      await expect(host()).toContainText(zhCopy.useCase);
      await expect(host()).toContainText(
        format(zh.billing.plans.everythingIn, { prev: zhCopy.prev }),
      );
      for (const feature of zhCopy.features) await expect(host()).toContainText(feature);
      for (const english of [hostCopy(en).useCase, ...hostCopy(en).features]) {
        await expect(host()).not.toContainText(english);
      }

      setOrgBillingState(
        seed.organizationId,
        withPlanChange(onPlan(MAX_X2, 12_000), { upgradePreview: { [HOST.key]: UPGRADE } }),
      );
      await openBilling(page, seed);
      await openPlans(page, zh.billing.ai.changePlan, zh.billing as unknown as typeof en.billing);
      const dialog = await openDialog(
        page,
        seed,
        'upgrade',
        HOST,
        zh.billing as unknown as typeof en.billing,
      );
      await expect(dialog).toContainText(
        format(zh.billing.plans.upgrade.title, { plan: HOST.name }),
      );
      await expect(
        dialog.getByRole('button', { name: zh.billing.plans.upgrade.confirm }),
      ).toBeVisible();
      await expect(page.getByText(/billing\.plans\./)).toHaveCount(0);
    });

    const verdict = assessWatchability({
      chapters: starts.map((tSeconds, i) => ({ label: String(i), tSeconds })),
      meta: { totalSeconds: (Date.now() - t0) / 1000 },
    });
    expect(verdict.watchable, verdict.reason ?? '').toBe(true);
    expect(pageErrors).toEqual([]);
  });
});
