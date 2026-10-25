import type { Locator, Page, Request, Response } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { signIn, SHELL_PASSWORD } from './_helpers/shell-session';
import {
  addOrgMember,
  freeOrgState,
  paidOrgState,
  pinContextCookies,
  resetBillingFixture,
  seedBillingOwner,
  setOrgBillingState,
  type BillingSeed,
} from './_helpers/billing';
import { db, resetDatabase } from './_helpers/db-reset';
import { BILLING_CATALOG, type AiPlanCatalogEntry } from '@/lib/billing/catalog';
import { E2E_CHECKOUT_URL } from '@/lib/test-billing-mock';
import type { BillingFixtureTier } from '@/lib/test-billing-mock';
import { escapeRegExp } from '@/lib/utils/regexp';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// THE PLAN CATALOG: POOLS, MAX ×2 AND THE INCLUDED SEAT (Story MOTIR-8379 ·
// MOTIR-8393) — the owner's walk through Billing & plans → Motir AI.
//
// ── PROMOTED OUT OF THE ACCEPTANCE LANE (MOTIR-7598) ──────────────────────────
// This was MOTIR-8379's receipt (`acceptance-billing-max-x2.spec.ts`). Story
// MOTIR-7594 took the Free card off the row (Free is the one-time trial grant,
// said in a strip above the cards, not a plan to choose), so the receipt's
// "every catalog plan is a card" no longer describes the product. Its receipt
// stays as recorded; the walk now runs on every PR in the cloud lane as a
// regression test, every assertion kept, the card-row ones restated as the
// PAID set. See docs/acceptance-lane-triage.md.
//
// ── WHAT THIS LANE CAN AND CANNOT PROVE ───────────────────────────────────────
// motir-ai is the lane's E2E_TEST_BILLING boundary mock, and Stripe is a stubbed
// host. So this walk proves motir-core's half end to end: the cards, the
// checkout request motir-core sends (price key, quantity 1), and what the page
// shows once the fixture reports the grant, rewritten here as motir-ai's webhook
// would. It does NOT prove Stripe accepts the Max ×2 prices or that motir-ai
// really credits 60,000; those are the motir-ai gate's tests.
//
// ── FIGURES ARE READ, NEVER RETYPED ───────────────────────────────────────────
// The plan names, prices, keys and the included-seat count come from the
// catalog entry, and every label from `messages/<locale>.json`.
//
// ── WAITS ─────────────────────────────────────────────────────────────────────
// Every step waits on the checkout request motir-core sends, or on the billing
// panel's own read, before asserting — never on a timer. `beat()` is pacing.

// The walk is seven chapters with a page load each, paced for the reviewer:
// 2.6 minutes on the lane's runner, so it gets the room its siblings' 150 s
// leaves too tight.
test.describe.configure({ timeout: 240_000 });

// The cloud lane retries once against the same database; start each attempt
// clean so a retry's seed cannot collide with the first attempt's rows.
test.beforeEach(async () => {
  await resetDatabase();
  resetBillingFixture();
});

const copy = en.billing;
const billingPath = '/settings/organization/billing';

const entry = (key: AiPlanCatalogEntry['key']): AiPlanCatalogEntry => {
  const found = BILLING_CATALOG.aiPlans.find((p) => p.key === key);
  if (!found) throw new Error(`the catalog has no ${key} entry`);
  return found;
};
const MAX_X2 = entry('max_x2');
const MAX = entry('max');
const HOST = entry('host');
const PAID = (['standard', 'pro', 'max', 'max_x2', 'host'] as const).map(entry);
const TOPUP = BILLING_CATALOG.creditTopup;

const tierOf = (plan: AiPlanCatalogEntry): BillingFixtureTier => ({
  key: plan.key,
  name: plan.name,
  monthlyCreditAllotment: plan.allotment!.credits,
});

/** Fill a message's ICU fields: plain `{n}`-style values and one `{count, plural, …}`. */
function format(message: string, values: Record<string, string | number>, locale = 'en'): string {
  return message
    .replace(/\{(\w+), plural, ((?:\w+ \{[^}]*\}\s*)+)\}/g, (_m, name: string, body: string) => {
      const count = Number(values[name]);
      const branches = Object.fromEntries(
        [...body.matchAll(/(\w+) \{([^}]*)\}/g)].map((b) => [b[1], b[2]]),
      );
      const branch = branches[new Intl.PluralRules(locale).select(count)] ?? branches['other']!;
      return branch.replace('#', String(count));
    })
    .replace(/\{(\w+)\}/g, (_m, name: string) => String(values[name]));
}

const n = (value: number) => value.toLocaleString('en-US');

async function stubStripe(page: Page): Promise<void> {
  await page.route('https://checkout.stripe.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<html><body>stripe checkout</body></html>',
    }),
  );
}

/** The panel's own read — the authoritative state the page renders. */
const billingRead = (page: Page, seed: BillingSeed): Promise<Response> =>
  page.waitForResponse(
    (res) =>
      res.request().method() === 'GET' &&
      new URL(res.url()).pathname === `/api/organizations/${seed.organizationId}/billing`,
    { timeout: 45_000 },
  );

/** The checkout request motir-core's page sends. */
const checkoutRequest = (page: Page, seed: BillingSeed): Promise<Request> =>
  page.waitForRequest(
    (req) =>
      req.method() === 'POST' &&
      new URL(req.url()).pathname === `/api/organizations/${seed.organizationId}/billing/checkout`,
    { timeout: 45_000 },
  );

/** Open Billing & plans and wait for its read; answers the motir-ai balance. */
async function openBilling(page: Page, seed: BillingSeed): Promise<number> {
  const read = billingRead(page, seed);
  await page.goto(billingPath);
  const res = await read;
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { motirAi: { balance: number } };
  await expect(page.getByRole('heading', { name: copy.title })).toBeVisible();
  return body.motirAi.balance;
}

/** From the home view to the plan cards. */
async function openPlans(page: Page, door: string, title = copy.plans.title): Promise<void> {
  await page.getByRole('button', { name: door }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

/** The plan cards' row, and one card by its header. */
const cardRow = (page: Page): Locator => page.getByRole('main').locator('div.snap-x');
const cardNames = (page: Page): Locator => cardRow(page).locator('span.font-semibold');
const card = (page: Page, name: string): Locator =>
  cardRow(page)
    .locator(':scope > div')
    .filter({
      has: page.locator('span.font-semibold', { hasText: new RegExp(`^${escapeRegExp(name)}$`) }),
    });

async function setCadence(page: Page, label: string): Promise<void> {
  await page.getByRole('button', { name: label, exact: true }).click();
  await expect(page.getByRole('button', { name: label, exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
}

/** A card's text without its included-seat line. */
const textWithoutSeatLine = (target: Locator): Promise<string> =>
  target.evaluate((el) => {
    const clone = el.cloneNode(true) as HTMLElement;
    clone.querySelector('[data-testid="plan-included-seat"]')?.remove();
    return clone.textContent ?? '';
  });

const PER_HEAD = /seat|user|member|per head|per person/i;

/** The included-seat line on every paid card — and no Free card at all. */
async function expectIncludedSeats(page: Page, seatMessage: string, locale = 'en'): Promise<void> {
  for (const plan of PAID) {
    await expect(card(page, plan.name).getByTestId('plan-included-seat')).toHaveText(
      format(seatMessage, { count: plan.includedTrackerSeats }, locale),
    );
  }
  await expect(card(page, entry('free').name)).toHaveCount(0);
}

/** Press a card's checkout and answer the body motir-core sent. */
async function chooseOn(page: Page, seed: BillingSeed, plan: AiPlanCatalogEntry) {
  const label = plan.recommended
    ? format(copy.plans.ctaUpgrade, { plan: plan.name })
    : format(copy.plans.ctaChoose, { plan: plan.name });
  const sent = checkoutRequest(page, seed);
  await card(page, plan.name).getByRole('button', { name: label }).click();
  const req = await sent;
  const res = await req.response();
  expect(res?.status()).toBe(200);
  await page.waitForURL(E2E_CHECKOUT_URL);
  return req.postDataJSON() as { priceLookupKey: string; quantity?: number };
}

/** Rewrite the fixture as motir-ai's paid-invoice webhook would, and re-read. */
async function landPlan(
  page: Page,
  seed: BillingSeed,
  plan: AiPlanCatalogEntry,
  priceLookupKey: string,
  balance: number,
): Promise<number> {
  setOrgBillingState(
    seed.organizationId,
    paidOrgState({ tier: tierOf(plan), balance, priceLookupKey }),
  );
  return openBilling(page, seed);
}

test.describe('The plan catalog: pools, Max ×2 and the included seat', () => {
  test('an owner with no plan buys Max ×2 on either cadence, gets 60,000 credits, and tops up 1,000 for $5', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-8379');
    const seed = await seedBillingOwner(page, `acc-max-x2-${Date.now().toString(36)}@example.com`);
    setOrgBillingState(seed.organizationId, freeOrgState(0));
    await stubStripe(page);

    await chapter(
      'The plan cards: 5,000 / 15,000 / 30,000, Max ×2 after Max, one Motir seat included',
      async () => {
        await openBilling(page, seed);
        // The tracker seat fee is a different product, still per user.
        await expect(page.getByRole('main')).toContainText(
          format(copy.motir.freeExplainer, {
            seat: BILLING_CATALOG.seatPlan.prices.monthly.amountUsd,
          }),
        );
        await openPlans(page, copy.ai.choosePlan);
        await setCadence(page, copy.plans.annual);
        await expect(cardNames(page)).toHaveText(PAID.map((p) => p.name));
        for (const plan of PAID) {
          await expect(card(page, plan.name)).toContainText(
            format(copy.plans.creditsAllotment, { n: n(plan.allotment!.credits) }),
          );
        }
        await expect(page.getByRole('main').getByText('Enterprise', { exact: true })).toHaveCount(
          0,
        );
        await expect(page.getByRole('button', { name: 'Contact sales' })).toHaveCount(0);
        await expectIncludedSeats(page, copy.plans.seatIncluded);
        await expect(card(page, MAX_X2.name)).toContainText(
          format(copy.plans.annualSub, { yr: n(MAX_X2.prices!.annual.amountUsd) }),
        );
        await beat();
        await setCadence(page, copy.plans.monthly);
        await expect(card(page, MAX_X2.name)).toContainText(
          format(copy.plans.perMoEquiv, { n: MAX_X2.prices!.monthly.amountUsd }),
        );
        await expect(card(page, MAX_X2.name)).toContainText(
          format(copy.plans.creditsAllotment, { n: n(MAX_X2.allotment!.credits) }),
        );
        await expectIncludedSeats(page, copy.plans.seatIncluded);
        // The AI plans are priced for the whole organisation: no per-head wording
        // outside the included-seat line, and no cost or margin figure anywhere.
        for (const plan of PAID) {
          expect(await textWithoutSeatLine(card(page, plan.name))).not.toMatch(PER_HEAD);
        }
        await expect(page.getByRole('main')).not.toContainText(/margin|unit cost/i);
      },
    );
    await beat();

    await chapter(
      'Max ×2 chosen on Annual — one checkout at its annual key, quantity 1',
      async () => {
        await openBilling(page, seed);
        await openPlans(page, copy.ai.choosePlan);
        await setCadence(page, copy.plans.annual);
        const body = await chooseOn(page, seed, MAX_X2);
        expect(body.priceLookupKey).toBe(MAX_X2.prices!.annual.priceLookupKey);
        expect(body.quantity ?? 1).toBe(1);
      },
    );
    await beat();

    await chapter('Max ×2 chosen on Monthly — its monthly key, quantity 1', async () => {
      await openBilling(page, seed);
      await openPlans(page, copy.ai.choosePlan);
      await setCadence(page, copy.plans.monthly);
      const body = await chooseOn(page, seed, MAX_X2);
      expect(body.priceLookupKey).toBe(MAX_X2.prices!.monthly.priceLookupKey);
      expect(body.quantity ?? 1).toBe(1);
    });
    await beat();

    await chapter('The invoice is paid — the balance rises by exactly 60,000', async () => {
      // Annual first, then the same org back on no plan and paid monthly.
      const before = await openBilling(page, seed);
      const annual = await landPlan(
        page,
        seed,
        MAX_X2,
        MAX_X2.prices!.annual.priceLookupKey,
        before + MAX_X2.allotment!.credits,
      );
      expect(annual - before).toBe(60_000);
      await expect(page.getByRole('main')).toContainText(
        format(copy.ai.creditsPerMo, { n: n(MAX_X2.allotment!.credits) }),
      );

      setOrgBillingState(seed.organizationId, freeOrgState(before));
      const monthly = await landPlan(
        page,
        seed,
        MAX_X2,
        MAX_X2.prices!.monthly.priceLookupKey,
        before + MAX_X2.allotment!.credits,
      );
      expect(monthly - before).toBe(60_000);
      await expect(page.getByRole('main')).toContainText(
        format(copy.ai.creditsPerMo, { n: n(MAX_X2.allotment!.credits) }),
      );
      await beat();

      // Holding a plan: Max ×2 is the current plan and no card offers a checkout;
      // the one card above it, Host, offers its upgrade (MOTIR-9403).
      await openPlans(page, copy.ai.changePlan);
      await expect(
        card(page, MAX_X2.name).getByRole('button', { name: copy.plans.ctaCurrent }),
      ).toBeVisible();
      await expect(cardRow(page).getByRole('button', { name: /^Choose / })).toHaveCount(0);
      await expect(cardRow(page).getByRole('button', { name: /^Upgrade to / })).toHaveText([
        format(copy.plans.upgrade.cta, { plan: HOST.name }),
      ]);
    });
    await beat();

    await chapter('A top-up: 1,000 credits for $5, and the balance rises by 1,000', async () => {
      const topup = page.getByRole('group', { name: copy.topup.title });
      for (const units of TOPUP.bundleUnits) {
        await expect(topup).toContainText(
          format(copy.topup.bundleCredits, { n: n(units * TOPUP.unitCredits) }),
        );
        await expect(topup).toContainText(
          format(copy.topup.bundlePrice, { n: units * TOPUP.unitAmountUsd }),
        );
      }
      expect(await topup.textContent()).not.toMatch(PER_HEAD);
      const before = await openBilling(page, seed);
      await openPlans(page, copy.ai.changePlan);
      const sent = checkoutRequest(page, seed);
      await page
        .getByRole('button', {
          name: format(copy.topup.buy, {
            n: n(TOPUP.unitCredits),
            total: n(TOPUP.unitAmountUsd),
          }),
        })
        .click();
      const req = await sent;
      expect((await req.response())?.status()).toBe(200);
      expect(req.postDataJSON()).toEqual({
        priceLookupKey: TOPUP.priceLookupKey,
        quantity: TOPUP.bundleUnits[0],
      });
      await page.waitForURL(E2E_CHECKOUT_URL);
      const after = await landPlan(
        page,
        seed,
        MAX_X2,
        MAX_X2.prices!.monthly.priceLookupKey,
        before + TOPUP.unitCredits,
      );
      expect(after - before).toBe(1_000);
    });
    await beat();

    await chapter('中文: the same figures, the included seat and Max ×2', async () => {
      // The signed-in account's saved language outranks the browser's cookie
      // (`lib/i18n/resolveLocale.ts`), so the owner's account says 中文 too.
      await db.user.update({ where: { id: seed.ownerId }, data: { locale: 'zh' } });
      await page
        .context()
        .addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: new URL('/', page.url()).href }]);
      const read = billingRead(page, seed);
      await page.goto(billingPath);
      expect((await read).status()).toBe(200);
      await openPlans(page, zh.billing.ai.changePlan, zh.billing.plans.title);
      await expect(cardNames(page)).toHaveText(PAID.map((p) => p.name));
      await expect(card(page, MAX_X2.name)).toContainText(
        format(zh.billing.plans.creditsAllotment, { n: n(MAX_X2.allotment!.credits) }),
      );
      await expectIncludedSeats(page, zh.billing.plans.seatIncluded, 'zh');
    });
  });

  test('every other plan card checks out its own key at quantity 1, and plain Max still grants 30,000', async ({
    page,
  }) => {
    const seed = await seedBillingOwner(
      page,
      `acc-plan-keys-${Date.now().toString(36)}@example.com`,
    );
    setOrgBillingState(seed.organizationId, freeOrgState(0));
    await stubStripe(page);

    for (const cadence of ['annual', 'monthly'] as const) {
      for (const plan of PAID.filter((p) => p.key !== 'max_x2')) {
        await openBilling(page, seed);
        await openPlans(page, copy.ai.choosePlan);
        await setCadence(page, copy.plans[cadence]);
        const body = await chooseOn(page, seed, plan);
        expect(body.priceLookupKey).toBe(plan.prices![cadence].priceLookupKey);
        expect(body.quantity ?? 1).toBe(1);
      }
    }

    await landPlan(page, seed, MAX, MAX.prices!.annual.priceLookupKey, MAX.allotment!.credits);
    await expect(page.getByRole('main')).toContainText(
      format(copy.ai.creditsPerMo, { n: n(MAX.allotment!.credits) }),
    );
  });

  // The plan cards are reached only through manager-gated doors, and a plain
  // member's billing read is refused outright — so a member sees the gate, no
  // plan card and no checkout (the shipped behaviour; the cards never render for
  // a member to see disabled).
  test('a member without billing rights reaches no plan card and sends no checkout', async ({
    page,
  }) => {
    const seed = await seedBillingOwner(
      page,
      `acc-max-x2-own-${Date.now().toString(36)}@example.com`,
    );
    const memberEmail = `acc-max-x2-mem-${Date.now().toString(36)}@example.com`;
    await addOrgMember(seed, memberEmail);
    setOrgBillingState(seed.organizationId, paidOrgState({ tier: tierOf(MAX_X2) }));

    await page.context().clearCookies();
    await signIn(page, memberEmail, SHELL_PASSWORD);
    await pinContextCookies(page, {
      workspaceId: seed.workspaceId,
      organizationId: seed.organizationId,
    });
    const read = billingRead(page, seed);
    let checkouts = 0;
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().endsWith('/billing/checkout')) checkouts += 1;
    });
    await page.goto(billingPath);
    expect((await read).status()).toBe(403);
    await expect(page.getByRole('heading', { name: copy.member.gateTitle })).toBeVisible();
    await expect(page.getByTestId('plan-included-seat')).toHaveCount(0);
    await expect(page.getByRole('button', { name: copy.ai.changePlan })).toHaveCount(0);
    expect(checkouts).toBe(0);
  });
});
