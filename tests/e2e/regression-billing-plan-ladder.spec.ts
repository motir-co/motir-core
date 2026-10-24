import type { Locator, Page, Response } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { signIn, SHELL_PASSWORD } from './_helpers/shell-session';
import {
  addOrgMember,
  freeOrgState,
  paidOrgState,
  pinContextCookies,
  seedBillingOwner,
  setOrgBillingState,
  type BillingSeed,
} from './_helpers/billing';
import { db } from './_helpers/db-reset';
import { BILLING_CATALOG, type AiPlanCatalogEntry } from '@/lib/billing/catalog';
import type { BillingFixtureEntry } from '@/lib/test-billing-mock';
import { escapeRegExp } from '@/lib/utils/regexp';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// THE AI PLAN CARDS, PLANNING-LED (Story MOTIR-7594 · MOTIR-7601) — the story's
// acceptance receipt: an owner on the one-time free trial opens Billing & plans →
// Motir AI and reads the four plan cards the way a customer does.
//
//   - the free-trial strip above the row, with what is left of the grant, and its
//     spent form — Free is not a plan, so there is no Free card;
//   - Standard / Pro / Max / Max ×2 with their pools, the ladder line under each
//     pool, and the included-seat line on every card, at both cadences;
//   - no Enterprise card and no Contact sales anywhere on the screen;
//   - the same row in 中文;
//   - an org on a paid plan sees no trial strip, and its own card as current;
//   - a member without billing rights has no door to the cards at all.
//
// ── WHAT THIS LANE CAN AND CANNOT PROVE ───────────────────────────────────────
// motir-ai is the lane's E2E_TEST_BILLING boundary mock, so the org's tier and
// balance are the fixture's, written here as motir-ai would report them. The walk
// proves motir-core's half: what the plans screen renders from that report.
//
// ── FIGURES ARE READ, NEVER RETYPED ───────────────────────────────────────────
// Plan names, pools and prices come from the catalog entry, every label from
// `messages/*.json`, and every ladder multiple from the two pools it relates.
//
// ── WAITS ─────────────────────────────────────────────────────────────────────
// Every step waits on the billing panel's own read before asserting — never on a
// timer. `beat()` is pacing for the reviewer.

test.describe.configure({ timeout: 240_000 });

const copy = en.billing;
const billingPath = '/settings/organization/billing';

const entry = (key: AiPlanCatalogEntry['key']): AiPlanCatalogEntry => {
  const found = BILLING_CATALOG.aiPlans.find((p) => p.key === key);
  if (!found) throw new Error(`the catalog has no ${key} entry`);
  return found;
};
const FREE = entry('free');
const MAX = entry('max');
const MAX_X2 = entry('max_x2');
const PAID = (['standard', 'pro', 'max', 'max_x2'] as const).map(entry);

/** The org on the one-time trial, as motir-ai reports it: the `free` tier and its balance. */
const trialState = (balance: number): BillingFixtureEntry => ({
  ...freeOrgState(balance),
  tier: { key: FREE.key, name: FREE.name, monthlyCreditAllotment: FREE.allotment!.credits },
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

/** The ladder line each paid card should carry, computed from the catalog pools. */
function ladderFor(messages: typeof en, i: number): string {
  if (i === 0) return messages.billing.plans.ladder.first;
  const multiple = PAID[i]!.allotment!.credits / PAID[i - 1]!.allotment!.credits;
  return format(messages.billing.plans.ladder.multiple, { multiple, plan: PAID[i - 1]!.name });
}

/** The panel's own read — the authoritative state the page renders. */
const billingRead = (page: Page, seed: BillingSeed): Promise<Response> =>
  page.waitForResponse(
    (res) =>
      res.request().method() === 'GET' &&
      new URL(res.url()).pathname === `/api/organizations/${seed.organizationId}/billing`,
    { timeout: 45_000 },
  );

/** Open Billing & plans and wait for its read. */
async function openBilling(page: Page, seed: BillingSeed, title = copy.title): Promise<void> {
  const read = billingRead(page, seed);
  await page.goto(billingPath);
  expect((await read).status()).toBe(200);
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

/** From the home view to the plan cards. */
async function openPlans(page: Page, door: string, title = copy.plans.title): Promise<void> {
  await page.getByRole('button', { name: door }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

/** The plan cards' row, and one card by its header. */
const cardRow = (page: Page): Locator => page.getByRole('main').locator('div.snap-x');
const cardNames = (page: Page): Locator =>
  cardRow(page).locator(':scope > div > div > span.font-semibold');
const card = (page: Page, name: string): Locator =>
  cardRow(page)
    .locator(':scope > div')
    .filter({
      has: page.locator('span.font-semibold', { hasText: new RegExp(`^${escapeRegExp(name)}$`) }),
    });
const strip = (page: Page): Locator => page.getByRole('main').getByTestId('plan-free-trial');

async function setCadence(page: Page, label: string): Promise<void> {
  await page.getByRole('button', { name: label, exact: true }).click();
  await expect(page.getByRole('button', { name: label, exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
}

/** Every paid card: its pool, its ladder line and its included seat. */
async function expectRow(page: Page, messages: typeof en, locale = 'en'): Promise<void> {
  await expect(cardNames(page)).toHaveText(PAID.map((p) => p.name));
  for (const [i, plan] of PAID.entries()) {
    const c = card(page, plan.name);
    await expect(c).toContainText(
      format(messages.billing.plans.creditsAllotment, { n: n(plan.allotment!.credits) }),
    );
    await expect(c.getByTestId('plan-ladder')).toHaveText(ladderFor(messages, i));
    await expect(c.getByTestId('plan-included-seat')).toHaveText(
      format(messages.billing.plans.seatIncluded, { count: plan.includedTrackerSeats }, locale),
    );
  }
}

test.describe('The AI plan cards, planning-led', () => {
  test('an owner on the free trial reads four plan cards, a ladder, the included seat and no Enterprise', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-7594');
    const seed = await seedBillingOwner(page, `acc-ladder-${Date.now().toString(36)}@example.com`);
    const left = 185;
    setOrgBillingState(seed.organizationId, trialState(left));

    await chapter('On the free trial: a strip says what is left — Free is not a card', async () => {
      await openBilling(page, seed);
      await openPlans(page, copy.ai.choosePlan);
      await expect(strip(page)).toContainText(copy.plans.trial.pill);
      await expect(strip(page)).toContainText(
        format(copy.plans.trial.left, { left: n(left), n: n(FREE.allotment!.credits) }),
      );
      await expect(cardNames(page)).toHaveText(PAID.map((p) => p.name));
      await expect(card(page, FREE.name)).toHaveCount(0);
    });
    await beat();

    await chapter('Annual: each pool, its ladder line and one Motir seat included', async () => {
      await setCadence(page, copy.plans.annual);
      await expectRow(page, en);
      await expect(card(page, MAX_X2.name)).toContainText(
        format(copy.plans.annualSub, { yr: n(MAX_X2.prices!.annual.amountUsd) }),
      );
      // The copy is planning-led: no agent-led line survives.
      await expect(page.getByRole('main')).not.toContainText(/heavy agent work/i);
    });
    await beat();

    await chapter('Monthly: the same ladder, Max ×2 at its monthly price', async () => {
      await setCadence(page, copy.plans.monthly);
      await expectRow(page, en);
      await expect(card(page, MAX_X2.name)).toContainText(
        format(copy.plans.perMoEquiv, { n: MAX_X2.prices!.monthly.amountUsd }),
      );
    });
    await beat();

    await chapter('No Enterprise card and no Contact sales anywhere', async () => {
      await expect(page.getByRole('main').getByText('Enterprise', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /Contact sales/i })).toHaveCount(0);
      await expect(page.getByRole('main')).not.toContainText(/Custom credit pool/);
    });
    await beat();

    await chapter('The trial spent: the strip says so and points at a monthly plan', async () => {
      setOrgBillingState(seed.organizationId, trialState(0));
      await openBilling(page, seed);
      await openPlans(page, copy.ai.choosePlan);
      await expect(strip(page)).toContainText(copy.plans.trial.pillUsed);
      await expect(strip(page)).toContainText(
        format(copy.plans.trial.spent, { n: n(FREE.allotment!.credits) }),
      );
      await expect(strip(page)).toContainText(copy.plans.trial.pickPlan);
    });
    await beat();

    await chapter('中文: the same four cards, ladder and included seat', async () => {
      // The signed-in account's saved language outranks the browser's cookie
      // (`lib/i18n/resolveLocale.ts`), so the owner's account says 中文 too.
      await db.user.update({ where: { id: seed.ownerId }, data: { locale: 'zh' } });
      await page
        .context()
        .addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: new URL('/', page.url()).href }]);
      await openBilling(page, seed, zh.billing.title);
      await openPlans(page, zh.billing.ai.choosePlan, zh.billing.plans.title);
      await expectRow(page, zh as unknown as typeof en, 'zh');
      await expect(strip(page)).toContainText(zh.billing.plans.trial.pillUsed);
    });
    await beat();

    await chapter('On Max: no trial strip, and Max is the current plan', async () => {
      await db.user.update({ where: { id: seed.ownerId }, data: { locale: 'en' } });
      await page
        .context()
        .addCookies([{ name: 'NEXT_LOCALE', value: 'en', url: new URL('/', page.url()).href }]);
      setOrgBillingState(
        seed.organizationId,
        paidOrgState({
          tier: { key: MAX.key, name: MAX.name, monthlyCreditAllotment: MAX.allotment!.credits },
          balance: 1000,
          priceLookupKey: MAX.prices!.annual.priceLookupKey,
        }),
      );
      await openBilling(page, seed);
      await openPlans(page, copy.ai.changePlan);
      await expect(strip(page)).toHaveCount(0);
      await expect(
        card(page, MAX.name).getByRole('button', { name: copy.plans.ctaCurrent }),
      ).toBeVisible();
      await expectRow(page, en);
    });
  });

  // The plan cards are reached only through manager-gated doors, and a plain
  // member's billing read is refused outright (shipped since MOTIR-8394) — so a
  // member sees the gate and no plan card: the cards never render for a member
  // to see disabled.
  test('a member without billing rights reaches no plan card', async ({ page }) => {
    const seed = await seedBillingOwner(
      page,
      `acc-ladder-own-${Date.now().toString(36)}@example.com`,
    );
    const memberEmail = `acc-ladder-mem-${Date.now().toString(36)}@example.com`;
    await addOrgMember(seed, memberEmail);
    setOrgBillingState(seed.organizationId, trialState(185));

    await page.context().clearCookies();
    await signIn(page, memberEmail, SHELL_PASSWORD);
    await pinContextCookies(page, {
      workspaceId: seed.workspaceId,
      organizationId: seed.organizationId,
    });
    const read = billingRead(page, seed);
    await page.goto(billingPath);
    expect((await read).status()).toBe(403);
    await expect(page.getByRole('heading', { name: copy.member.gateTitle })).toBeVisible();
    await expect(page.getByTestId('plan-ladder')).toHaveCount(0);
    await expect(strip(page)).toHaveCount(0);
  });
});
