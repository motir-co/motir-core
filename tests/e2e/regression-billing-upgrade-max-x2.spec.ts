import type { Locator, Page, Request, Response } from '@playwright/test';
import { test, expect } from './_helpers/promoted-regression';
import { signIn, SHELL_PASSWORD } from './_helpers/shell-session';
import {
  addOrgMember,
  paidOrgState,
  patchOrgBillingState,
  pinContextCookies,
  seedBillingOwner,
  setOrgBillingState,
  type BillingSeed,
} from './_helpers/billing';
import { db } from './_helpers/db-reset';
import { BILLING_CATALOG, type AiPlanCatalogEntry } from '@/lib/billing/catalog';
import type { RawDowngradePreview, RawUpgradePreview } from '@/lib/ai/types';
import type { BillingFixtureEntry, BillingFixtureTier } from '@/lib/test-billing-mock';
import { escapeRegExp } from '@/lib/utils/regexp';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// A PLAN CHANGE MID-PERIOD (Story MOTIR-8387 · MOTIR-8401) — an owner on Max
// upgrades to Max ×2, schedules a downgrade for the period end, replaces it, and
// is refused where motir-ai refuses. The story's acceptance receipt.
//
// ── WHAT THIS LANE CAN AND CANNOT PROVE ───────────────────────────────────────
// motir-ai is the lane's E2E_TEST_BILLING boundary mock and Stripe is never
// reached. So this walk proves motir-core's half end to end: the cards, the
// preview and confirm requests motir-core sends (`toPlanKey`, the preview's
// `prorationDate`, nothing else), the refusals the page shows, and what the page
// shows once the fixture reports a paid invoice or a created schedule — both
// rewritten here as motir-ai would. It does NOT prove Stripe's proration amount,
// that Stripe schedules a downgrade with no invoice or refund, that motir-ai
// credits the previewed credits once (the "once" below is the fixture replaying
// the webhook's idempotency key), or the index-allowance arithmetic: those rest
// on the motir-ai gate (MOTIR-8400). No money moves. The billing page has no
// index-allowance read, so the allowance is asserted where the page shows it:
// the dialog's figures and its success line.
//
// ── FIGURES ───────────────────────────────────────────────────────────────────
// Every preview figure is a LITERAL this spec hands the fixture and then reads
// back off the dialog — so a figure composed in the browser, or re-read from the
// app, fails. Plan names and keys come from the catalog, labels from messages.
//
// ── WAITS ─────────────────────────────────────────────────────────────────────
// Every step waits on the request motir-core sends, its response, or the billing
// panel's own read. `beat()` is pacing for the reviewer, never synchronisation.

test.describe.configure({ timeout: 240_000 });

const copy = en.billing;
const up = copy.plans.upgrade;
const down = copy.plans.downgrade;
const billingPath = '/settings/organization/billing';

const entry = (key: AiPlanCatalogEntry['key']): AiPlanCatalogEntry => {
  const found = BILLING_CATALOG.aiPlans.find((p) => p.key === key);
  if (!found) throw new Error(`the catalog has no ${key} entry`);
  return found;
};
const STANDARD = entry('standard');
const PRO = entry('pro');
const MAX = entry('max');
const MAX_X2 = entry('max_x2');

const tierOf = (plan: AiPlanCatalogEntry): BillingFixtureTier => ({
  key: plan.key,
  name: plan.name,
  monthlyCreditAllotment: plan.allotment!.credits,
});

const onPlan = (plan: AiPlanCatalogEntry, balance: number): BillingFixtureEntry =>
  paidOrgState({
    tier: tierOf(plan),
    balance,
    priceLookupKey: plan.prices!.monthly.priceLookupKey,
    currentPeriodEnd: PERIOD_END,
  });

const PERIOD_END = '2026-11-01T00:00:00.000Z';
const PERIOD_END_TEXT = 'Nov 1, 2026';

// The upgrade Max → Max ×2, 17 days before the period end. Literals.
const UPGRADE: RawUpgradePreview = {
  prorationDate: 1_792_238_400,
  fromPlan: 'max',
  toPlan: 'max_x2',
  cadence: 'monthly',
  cadenceChange: null,
  amountDueCents: 8_250,
  currency: 'usd',
  periodStart: '2026-10-01T00:00:00.000Z',
  periodEnd: PERIOD_END,
  billingDaysLeft: 17,
  daysLeft: 17,
  creditWindowEnd: PERIOD_END,
  extraCredits: 17_000,
  extraIndexAllowance: 400,
  fromPool: 30_000,
  fullPool: 60_000,
  fullAllowance: 2_000,
  toPriceCents: 30_000,
  pendingDowngrade: null,
};

const downgradeTo = (plan: AiPlanCatalogEntry, fullAllowance: number): RawDowngradePreview => ({
  fromPlan: 'max_x2',
  toPlan: plan.key,
  cadence: 'monthly',
  cadenceChange: null,
  effectiveDate: PERIOD_END,
  amountDueCents: 0,
  refundCents: 0,
  creditsChange: 0,
  allowanceChange: 0,
  fromPool: 60_000,
  fullPool: plan.allotment!.credits,
  fullAllowance,
  toPriceCents: plan.prices!.monthly.amountUsd * 100,
  currency: 'usd',
  pendingDowngrade: null,
});

/** Fill a message's `{name}` fields. */
const format = (message: string, values: Record<string, string | number>): string =>
  message.replace(/\{(\w+)\}/g, (_m, name: string) => String(values[name]));
const n = (value: number) => value.toLocaleString('en-US');
const usd = (cents: number) =>
  new Intl.NumberFormat('en', { style: 'currency', currency: 'USD' }).format(cents / 100);

const PER_HEAD = /seat|user|member|per head|per person|席位|用户|成员/i;
const COST = /margin|unit cost/i;

/** The panel's own read — the authoritative state the page renders. */
const billingRead = (page: Page, seed: BillingSeed): Promise<Response> =>
  page.waitForResponse(
    (res) =>
      res.request().method() === 'GET' &&
      new URL(res.url()).pathname === `/api/organizations/${seed.organizationId}/billing`,
    { timeout: 45_000 },
  );

const planChangePath = (seed: BillingSeed, path: string) =>
  `/api/organizations/${seed.organizationId}/billing/${path}`;

/** A plan-change request motir-core's page sends. */
const planChangeRequest = (page: Page, seed: BillingSeed, path: string): Promise<Request> =>
  page.waitForRequest(
    (req) => req.method() === 'POST' && new URL(req.url()).pathname === planChangePath(seed, path),
    { timeout: 45_000 },
  );

/** Count the plan-change POSTs a page sends, by path. */
function countPlanChangePosts(page: Page, seed: BillingSeed): Record<string, number> {
  const counts: Record<string, number> = {};
  page.on('request', (req) => {
    const path = new URL(req.url()).pathname;
    const prefix = planChangePath(seed, '');
    if (req.method() === 'POST' && path.startsWith(prefix)) {
      const key = path.slice(prefix.length);
      counts[key] = (counts[key] ?? 0) + 1;
    }
  });
  return counts;
}

/** Open Billing & plans and wait for its read; answers the motir-ai balance. */
async function openBilling(page: Page, seed: BillingSeed): Promise<number> {
  const read = billingRead(page, seed);
  await page.goto(billingPath);
  const res = await read;
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { motirAi: { balance: number } };
  return body.motirAi.balance;
}

async function openPlans(page: Page, door = copy.ai.changePlan, title = copy.plans.title) {
  await page.getByRole('button', { name: door }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

const cardRow = (page: Page): Locator => page.getByRole('main').locator('div.snap-x');
const card = (page: Page, name: string): Locator =>
  cardRow(page)
    .locator(':scope > div')
    .filter({
      has: page.locator('span.font-semibold', { hasText: new RegExp(`^${escapeRegExp(name)}$`) }),
    });

/** Press a card's control and wait for the preview it fetches. */
async function openDialog(
  page: Page,
  seed: BillingSeed,
  kind: 'upgrade' | 'downgrade',
  plan: AiPlanCatalogEntry,
  label = format((kind === 'upgrade' ? up : down).cta, { plan: plan.name }),
): Promise<Locator> {
  const previewed = planChangeRequest(page, seed, `${kind}/preview`);
  await card(page, plan.name).getByRole('button', { name: label }).click();
  const req = await previewed;
  expect(req.postDataJSON()).toEqual({ toPlanKey: plan.key });
  await req.response();
  return page.getByRole('dialog');
}

/** Press the dialog's confirm; answers the body sent and the response. */
async function confirm(
  page: Page,
  seed: BillingSeed,
  dialog: Locator,
  path: string,
  label: string,
) {
  const sent = planChangeRequest(page, seed, path);
  await dialog.getByRole('button', { name: label }).click();
  const req = await sent;
  const res = await req.response();
  return { body: req.postDataJSON() as Record<string, unknown>, res: res! };
}

/** No seat / per-head wording and no cost figure inside an open dialog. */
async function expectNoPerHead(dialog: Locator): Promise<void> {
  const text = (await dialog.textContent()) ?? '';
  expect(text).not.toMatch(PER_HEAD);
  expect(text).not.toMatch(COST);
  expect(text).not.toMatch(/[{}]|billing\.plans/);
}

/**
 * Land a paid upgrade invoice on the fixture, as motir-ai's webhook would: the
 * tier moves and the balance rises by the previewed credits. Idempotent on the
 * invoice id, as the webhook's credit is — a replay changes nothing.
 */
const landedInvoices = new Set<string>();
function landUpgradeInvoice(seed: BillingSeed, invoiceId: string, balanceBefore: number) {
  if (landedInvoices.has(invoiceId)) return;
  landedInvoices.add(invoiceId);
  setOrgBillingState(seed.organizationId, onPlan(MAX_X2, balanceBefore + UPGRADE.extraCredits));
}

const planChange = (over: NonNullable<BillingFixtureEntry['planChange']>) => ({
  planChange: {
    upgradePreview: { max_x2: UPGRADE },
    downgradePreview: {
      max: downgradeTo(MAX, 1_000),
      pro: downgradeTo(PRO, 500),
      standard: downgradeTo(STANDARD, 200),
    },
    ...over,
  },
});

test.describe('A plan change mid-period: upgrade now, downgrade at the period end', () => {
  test('an owner on Max upgrades to Max ×2, then schedules and replaces a downgrade', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-8387');
    const seed = await seedBillingOwner(
      page,
      `acc-plan-chg-${Date.now().toString(36)}@example.com`,
    );
    setOrgBillingState(seed.organizationId, { ...onPlan(MAX, 12_000), ...planChange({}) });
    const posts = countPlanChangePosts(page, seed);
    let before = 0;

    await chapter('The plan cards for an owner on Max', async () => {
      before = await openBilling(page, seed);
      await openPlans(page);
      await expect(
        card(page, MAX.name).getByRole('button', { name: copy.plans.ctaCurrent }),
      ).toBeVisible();
      await expect(
        card(page, MAX_X2.name).getByRole('button', {
          name: format(up.cta, { plan: MAX_X2.name }),
        }),
      ).toBeVisible();
      for (const plan of [STANDARD, PRO]) {
        await expect(
          card(page, plan.name).getByRole('button', {
            name: format(down.cta, { plan: plan.name }),
          }),
        ).toBeVisible();
      }
      await expect(
        card(page, entry('free').name).getByRole('button', { name: /^Downgrade/ }),
      ).toHaveCount(0);
      await expect(page.getByRole('main').getByText('Enterprise', { exact: true })).toHaveCount(0);
      for (const plan of [STANDARD, PRO, MAX, MAX_X2]) {
        const price = card(page, plan.name)
          .locator('p')
          .filter({ hasText: /credits|\$/ });
        for (const text of await price.allTextContents()) expect(text).not.toMatch(PER_HEAD);
      }
    });
    await beat();

    // A second tab opens the same upgrade now, and confirms after the first one
    // has upgraded — the stale tab.
    const stale = await page.context().newPage();

    await chapter('Upgrade to Max ×2: the price for the days left, before paying', async () => {
      const dialog = await openDialog(page, seed, 'upgrade', MAX_X2);
      await expect(dialog.getByTestId('plan-change-switch')).toHaveAttribute(
        'aria-label',
        format(up.switch, { from: MAX.name, to: MAX_X2.name }),
      );
      await expect(dialog.getByTestId('plan-change-switch')).toContainText(
        format(up.poolLine, { n: n(30_000) }),
      );
      await expect(dialog.getByTestId('plan-change-switch')).toContainText(
        format(up.poolLine, { n: n(60_000) }),
      );
      await expect(dialog).toContainText('$82.50');
      await expect(dialog).toContainText(format(up.daysLeft, { n: 17, date: PERIOD_END_TEXT }));
      await expect(dialog).toContainText(format(up.extraCredits, { n: n(17_000) }));
      await expect(dialog).toContainText(format(up.extraAllowance, { n: n(400) }));
      await expect(dialog).toContainText(
        format(up.renewal, {
          date: PERIOD_END_TEXT,
          plan: MAX_X2.name,
          price: usd(30_000),
          cadence: up.per.monthly,
          credits: n(60_000),
          allowance: n(2_000),
        }),
      );
      // A plan change keeps the cadence: no monthly-to-annual row.
      await expect(dialog).not.toContainText(up.cadenceChange.split('{')[0]!.trim());
      await expectNoPerHead(dialog);
      expect(posts['upgrade/preview']).toBe(1);
    });
    await beat();

    await chapter('Upgrade now: one charge, and the balance rises by exactly 17,000', async () => {
      // The stale tab prices the same upgrade before this one confirms.
      const staleRead = billingRead(stale, seed);
      await stale.goto(billingPath);
      await staleRead;
      await openPlans(stale);
      const staleDialog = await openDialog(stale, seed, 'upgrade', MAX_X2);
      await expect(staleDialog).toContainText('$82.50');

      const dialog = page.getByRole('dialog');
      const reloaded = billingRead(page, seed);
      const { body, res } = await confirm(page, seed, dialog, 'upgrade', up.confirm);
      expect(res.status()).toBe(200);
      expect(body).toEqual({ toPlanKey: 'max_x2', prorationDate: UPGRADE.prorationDate });
      await expect(dialog).toContainText(format(up.success, { plan: MAX_X2.name }));
      await expect(dialog.getByTestId('plan-change-success')).toHaveText(
        format(up.successGrant, { credits: n(17_000), allowance: n(400) }),
      );
      await expectNoPerHead(dialog);
      await reloaded;

      landUpgradeInvoice(seed, 'in_e2e_upgrade', before);
      const after = await openBilling(page, seed);
      expect(after - before).toBe(17_000);
      landUpgradeInvoice(seed, 'in_e2e_upgrade', before);
      expect(await openBilling(page, seed)).toBe(after);

      await openPlans(page);
      await expect(
        card(page, MAX_X2.name).getByRole('button', { name: copy.plans.ctaCurrent }),
      ).toBeVisible();
      await expect(cardRow(page).getByRole('button', { name: /^Upgrade to / })).toHaveCount(0);
      before = after;
      patchOrgBillingState(seed.organizationId, planChange({}));

      // The stale tab's confirm: motir-ai answers the plan is already held.
      const staleConfirm = await confirm(stale, seed, staleDialog, 'upgrade', up.confirm);
      expect(staleConfirm.res.status()).toBe(400);
      await expect(staleDialog).toContainText(format(up.refusedSame, { plan: MAX_X2.name }));
      await stale.close();
      expect(await openBilling(page, seed)).toBe(before);
    });
    await beat();

    await chapter('Downgrade to Max: at the period end, no charge and no refund', async () => {
      await openPlans(page);
      const dialog = await openDialog(page, seed, 'downgrade', MAX);
      await expect(dialog.getByTestId('plan-change-switch')).toHaveAttribute(
        'aria-label',
        format(up.switch, { from: MAX_X2.name, to: MAX.name }),
      );
      await expect(dialog).toContainText(format(down.takesEffect, { date: PERIOD_END_TEXT }));
      await expect(dialog).toContainText(down.dueToday);
      await expect(dialog).toContainText(format(down.creditsStay, { plan: MAX_X2.name }));
      await expect(dialog).toContainText(
        format(down.from, {
          date: PERIOD_END_TEXT,
          plan: MAX.name,
          price: usd(MAX.prices!.monthly.amountUsd * 100),
          cadence: up.per.monthly,
          credits: n(MAX.allotment!.credits),
          allowance: n(1_000),
        }),
      );
      await expect(dialog).not.toContainText(down.replaces.split('{')[0]!);
      await expectNoPerHead(dialog);
      expect(posts['downgrade/preview']).toBe(1);

      const { body, res } = await confirm(page, seed, dialog, 'downgrade', down.confirm);
      expect(res.status()).toBe(200);
      expect(body).toEqual({ toPlanKey: 'max' });
      await expect(dialog).toContainText(down.success);
      await expect(dialog.getByTestId('plan-change-success')).toHaveText(
        format(down.successBody, { current: MAX_X2.name, date: PERIOD_END_TEXT, plan: MAX.name }),
      );
      await dialog.getByRole('button', { name: down.done }).click();

      // The schedule is created: tier, balance and allowance untouched.
      patchOrgBillingState(
        seed.organizationId,
        planChange({ pendingDowngrade: { planKey: 'max', effectiveDate: PERIOD_END } }),
      );
      expect(await openBilling(page, seed)).toBe(before);
      await openPlans(page);
      await expect(card(page, MAX_X2.name).getByTestId('plan-pending-downgrade')).toHaveText(
        format(down.pendingPill, { plan: MAX.name, date: PERIOD_END_TEXT }),
      );
      await expect(
        card(page, MAX_X2.name).getByRole('button', { name: copy.plans.ctaCurrent }),
      ).toBeVisible();
      await expect(
        card(page, MAX.name).getByRole('button', {
          name: format(down.scheduledButton, { date: PERIOD_END_TEXT }),
        }),
      ).toBeDisabled();
      await expect(page.getByRole('main')).not.toContainText(/refund/i);
    });
    await beat();

    await chapter('Downgrade to Pro instead: it replaces the scheduled change', async () => {
      const dialog = await openDialog(page, seed, 'downgrade', PRO);
      await expect(dialog).toContainText(
        format(down.replaces, { plan: MAX.name, date: PERIOD_END_TEXT }),
      );
      const { body } = await confirm(page, seed, dialog, 'downgrade', down.confirm);
      expect(body).toEqual({ toPlanKey: 'pro' });
      await expect(dialog.getByTestId('plan-change-success')).toBeVisible();
      await dialog.getByRole('button', { name: down.done }).click();

      patchOrgBillingState(
        seed.organizationId,
        planChange({ pendingDowngrade: { planKey: 'pro', effectiveDate: PERIOD_END } }),
      );
      expect(await openBilling(page, seed)).toBe(before);
      await openPlans(page);
      // The scheduled target cannot be chosen again: its control is the
      // disabled "Scheduled for" button, so no repeat confirm can be sent.
      await expect(
        card(page, PRO.name).getByRole('button', {
          name: format(down.scheduledButton, { date: PERIOD_END_TEXT }),
        }),
      ).toBeDisabled();
      await expect(
        card(page, MAX.name).getByRole('button', { name: format(down.cta, { plan: MAX.name }) }),
      ).toBeEnabled();
      expect(posts['downgrade']).toBe(2);
    });
    await beat();

    await chapter('中文: the same pending change and figures, and Max ×2', async () => {
      await db.user.update({ where: { id: seed.ownerId }, data: { locale: 'zh' } });
      await page
        .context()
        .addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: new URL('/', page.url()).href }]);
      await openBilling(page, seed);
      await openPlans(page, zh.billing.ai.changePlan, zh.billing.plans.title);
      await expect(card(page, MAX_X2.name).getByTestId('plan-pending-downgrade')).toContainText(
        PRO.name,
      );
      const dialog = await openDialog(
        page,
        seed,
        'downgrade',
        STANDARD,
        format(zh.billing.plans.downgrade.cta, { plan: STANDARD.name }),
      );
      await expect(dialog).toContainText(MAX_X2.name);
      await expect(dialog).toContainText(n(60_000));
      await expect(dialog).toContainText(zh.billing.plans.downgrade.dueToday);
      await expectNoPerHead(dialog);
    });
  });

  test('a refused change keeps the dialog, charges nothing and schedules nothing', async ({
    page,
  }) => {
    const seed = await seedBillingOwner(
      page,
      `acc-plan-ref-${Date.now().toString(36)}@example.com`,
    );
    const onMax = (over: NonNullable<BillingFixtureEntry['planChange']>) =>
      setOrgBillingState(seed.organizationId, { ...onPlan(MAX, 12_000), ...planChange(over) });
    onMax({});
    const before = await openBilling(page, seed);

    // Wrong direction, sent straight to the routes from the signed-in context.
    const wrongUp = await page.request.post(planChangePath(seed, 'upgrade'), {
      data: { toPlanKey: 'pro', prorationDate: UPGRADE.prorationDate },
    });
    expect(wrongUp.status()).toBe(400);
    expect(await wrongUp.json()).toMatchObject({ reason: 'not_an_upgrade' });
    const wrongDown = await page.request.post(planChangePath(seed, 'downgrade'), {
      data: { toPlanKey: 'max_x2' },
    });
    expect(wrongDown.status()).toBe(400);
    expect(await wrongDown.json()).toMatchObject({ reason: 'not_a_downgrade' });
    onMax({ refuse: { upgrade: 'second_plan' } });
    const second = await page.request.post(planChangePath(seed, 'upgrade'), {
      data: { toPlanKey: 'max_x2', prorationDate: UPGRADE.prorationDate },
    });
    expect(second.status()).toBe(400);
    expect(await second.json()).toMatchObject({ reason: 'second_plan' });

    // Each refusal through the dialog: its own line, the dialog kept.
    const cases = [
      ['second_plan', up.error],
      ['payment_failed', up.refusedPayment],
      ['not_an_upgrade', up.refusedNotHigher],
    ] as const;
    for (const [code, line] of cases) {
      onMax({ refuse: { upgrade: code } });
      await openBilling(page, seed);
      await openPlans(page);
      const dialog = await openDialog(page, seed, 'upgrade', MAX_X2);
      const { res } = await confirm(page, seed, dialog, 'upgrade', up.confirm);
      expect(res.status()).toBe(code === 'payment_failed' ? 402 : 400);
      await expect(dialog).toContainText(line);
      await expect(dialog).toBeVisible();
      await expectNoPerHead(dialog);
      if (code === 'payment_failed') {
        await expect(dialog.getByRole('button', { name: copy.plans.managePlan })).toBeVisible();
        await expect(dialog.getByRole('button', { name: up.confirm })).toBeEnabled();
      }
    }

    // The price moved: re-priced and marked, the confirm still enabled, no charge.
    onMax({ refuse: { upgrade: 'preview_expired' } });
    await openBilling(page, seed);
    await openPlans(page);
    const dialog = await openDialog(page, seed, 'upgrade', MAX_X2);
    onMax({
      refuse: { upgrade: 'preview_expired' },
      upgradePreview: { max_x2: { ...UPGRADE, amountDueCents: 7_800, billingDaysLeft: 16 } },
    });
    const repriced = planChangeRequest(page, seed, 'upgrade/preview');
    await confirm(page, seed, dialog, 'upgrade', up.confirm);
    await (await repriced).response();
    await expect(dialog).toContainText(up.previewChanged);
    await expect(dialog.locator('[data-changed]').first()).toHaveText('$78.00');
    await expect(dialog.getByRole('button', { name: up.confirm })).toBeEnabled();
    await expectNoPerHead(dialog);

    // The downgrade refusals.
    for (const [code, line] of [
      ['not_a_downgrade', down.refusedNotLower],
      ['second_plan', down.error],
    ] as const) {
      onMax({ refuse: { downgrade: code } });
      await openBilling(page, seed);
      await openPlans(page);
      const dialog = await openDialog(page, seed, 'downgrade', PRO);
      await confirm(page, seed, dialog, 'downgrade', down.confirm);
      await expect(dialog).toContainText(line);
      await expect(dialog).toBeVisible();
    }

    // Nothing was charged and nothing was scheduled.
    expect(await openBilling(page, seed)).toBe(before);
    await openPlans(page);
    await expect(page.getByTestId('plan-pending-downgrade')).toHaveCount(0);

    // An upgrade clears a pending downgrade: once the invoice lands with no
    // pending change, neither the pill nor a "Scheduled for" button remains.
    onMax({ pendingDowngrade: { planKey: 'standard', effectiveDate: PERIOD_END } });
    await openBilling(page, seed);
    await openPlans(page);
    await expect(card(page, MAX.name).getByTestId('plan-pending-downgrade')).toBeVisible();
    setOrgBillingState(seed.organizationId, onPlan(MAX_X2, before + UPGRADE.extraCredits));
    await openBilling(page, seed);
    await openPlans(page);
    await expect(page.getByTestId('plan-pending-downgrade')).toHaveCount(0);
    await expect(cardRow(page).getByRole('button', { name: /^Scheduled for / })).toHaveCount(0);

    // 中文 upgrade dialog: the same figures, Max ×2, no per-head wording.
    onMax({});
    await db.user.update({ where: { id: seed.ownerId }, data: { locale: 'zh' } });
    await page
      .context()
      .addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: new URL('/', page.url()).href }]);
    await openBilling(page, seed);
    await openPlans(page, zh.billing.ai.changePlan, zh.billing.plans.title);
    const zhDialog = await openDialog(
      page,
      seed,
      'upgrade',
      MAX_X2,
      format(zh.billing.plans.upgrade.cta, { plan: MAX_X2.name }),
    );
    await expect(zhDialog).toContainText(MAX_X2.name);
    await expect(zhDialog).toContainText('$82.50');
    await expect(zhDialog).toContainText(n(17_000));
    await expectNoPerHead(zhDialog);
  });

  // The plan cards are reached only through manager-gated doors, and a member's
  // billing read is refused outright — so a member sees the gate, no plan card,
  // no plan-change control, and no preview of either kind is ever sent.
  test('a member without billing rights reaches no plan-change control and sends no preview', async ({
    page,
  }) => {
    const seed = await seedBillingOwner(
      page,
      `acc-plan-own-${Date.now().toString(36)}@example.com`,
    );
    const memberEmail = `acc-plan-mem-${Date.now().toString(36)}@example.com`;
    await addOrgMember(seed, memberEmail);
    setOrgBillingState(seed.organizationId, { ...onPlan(MAX, 12_000), ...planChange({}) });

    await page.context().clearCookies();
    await signIn(page, memberEmail, SHELL_PASSWORD);
    await pinContextCookies(page, {
      workspaceId: seed.workspaceId,
      organizationId: seed.organizationId,
    });
    const posts = countPlanChangePosts(page, seed);
    const read = billingRead(page, seed);
    await page.goto(billingPath);
    expect((await read).status()).toBe(403);
    await expect(page.getByRole('heading', { name: copy.member.gateTitle })).toBeVisible();
    await expect(page.getByRole('button', { name: /^(Upgrade|Downgrade) to / })).toHaveCount(0);
    expect(Object.keys(posts)).toHaveLength(0);

    // The routes refuse a member too.
    const res = await page.request.post(planChangePath(seed, 'upgrade/preview'), {
      data: { toPlanKey: 'max_x2' },
    });
    expect(res.status()).toBe(403);
  });
});
