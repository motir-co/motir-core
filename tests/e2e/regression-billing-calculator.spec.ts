import type { Locator, Page, Request, Response } from '@playwright/test';
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
import { adminDb } from './_helpers/db-reset';
import { ORGANIZATION_ROLE } from '@/lib/organizations/roles';
import { msg, saveAccountLanguageInSettings } from './_helpers/i18n-walk';
import {
  BILLING_CATALOG,
  maxMonthlyPlanCredits,
  type AiPlanCatalogEntry,
} from '@/lib/billing/catalog';
import {
  calculatorEstimateRequestSchema,
  type CalculatorCategoriesDTO,
  type CalculatorEstimateDTO,
} from '@/lib/dto/billing';
import {
  PINNED_CATEGORIES_ANSWER,
  PINNED_ESTIMATE_ANSWER,
} from '../fixtures/calculatorPinnedVector';

// The picker names at most this many models per category (CalculatorView's
// CATEGORY_MODEL_EXAMPLES).
const CATEGORY_MODEL_EXAMPLES = 3;

// THE CALCULATOR, AS A PERSON MEETS IT (Story MOTIR-8381 · MOTIR-8641) — the
// story's acceptance receipt. An owner opens Billing & plans → Motir AI plans,
// follows the link into the Calculator, enters a range, picks MODEL CATEGORIES
// (never a model), reads a credit range with the equal split and the plan that fits,
// sees what happens above the largest regular plan, every refusal, and the same
// figures in 中文; an admin gets the same, and a plain member has no door at all.
//
// ── WHAT THIS LANE CAN AND CANNOT PROVE ───────────────────────────────────────
// `MOTIR_AI_URL` points at a host that does not exist, so the server's read of
// the engine cannot succeed here. The category list and the estimate are therefore
// answered at the BROWSER layer, by a `page.route` on the tab's own server route,
// armed before the first ask, with the response types the door merged. The spec
// asserts the REQUEST the tab sent beside the response it rendered, so the tab's half
// of the contract is evidenced; the route → engine leg is not (that is
// `tests/calculatorContract.test.ts`). Not asserted at all: that this tab and
// motir.co/price give the same answer for the same input — neither repository can
// produce the other's expected figures.
//
// ── TWO RANGES, AND THE POOL SOLD FROM THE ANSWER (MOTIR-9224 · MOTIR-8997) ────
// The tab asks items PLANNED and items RUN, the run range following the planned one
// until it is typed into; the picked categories price the run. The plans view opens
// the tab from its "Need more credits?" entry, and a larger pool is offered — and
// bought — on the answer itself, from the catalog's own entry. The purchase walk
// is `regression-billing-larger-pool.spec.ts` (MOTIR-9000).
//
// ── KNOWN GAPS, RECORDED RATHER THAN HIDDEN ───────────────────────────────────
//  - The tab carries its own Annual / Monthly control, bound to the plans view's
//    value (one cadence, two places to change it), as the approved design draws it.
//
// ── FIGURES ARE READ, NEVER RETYPED ───────────────────────────────────────────
// Plan names, pools, prices and seat fees come from `lib/billing/catalog.ts`, every
// sentence from `messages/*.json` through `msg`, every category and example model from
// the recorded categories answer, and figures are compared as numerals parsed out of
// the page's own formatting.
//
// ── WAITS ─────────────────────────────────────────────────────────────────────
// Every step waits on a request or a rendered landmark armed before the action. `beat()`
// is pacing for the reviewer, taken AFTER the assertion that proved the state.

test.describe.configure({ timeout: 300_000 });

const billingPath = '/settings/organization/billing';
const L = 'en';
const t = (key: string, args: Record<string, string> = {}, locale = L) =>
  msg(locale, `billing.${key}`, args);

// ── derived data ────────────────────────────────────────────────────────────

// The regular ladder: the larger pools (MOTIR-8990) sit above it and are never in the row.
const PAID: AiPlanCatalogEntry[] = BILLING_CATALOG.aiPlans
  .filter((p) => p.band === 'ladder' && p.prices && p.allotment?.cadence === 'monthly')
  .sort((a, b) => a.allotment!.credits - b.allotment!.credits);
const SMALLEST = PAID[0]!;
const TOP = PAID[PAID.length - 1]!;
const POOL = BILLING_CATALOG.aiPlans.find((p) => p.band === 'larger_pool')!;
const catalogAmount = (p: AiPlanCatalogEntry, cadence: 'annual' | 'monthly') =>
  p.prices![cadence].amountUsd;

const CATEGORIES: CalculatorCategoriesDTO = PINNED_CATEGORIES_ANSWER as CalculatorCategoriesDTO;
const KEYS = CATEGORIES.categories.map((c) => c.key);
const label = (key: string) => key.charAt(0).toUpperCase() + key.slice(1);
const pickerButton = (page: Page, key: string): Locator =>
  page.getByRole('button', { name: new RegExp(`^${label(key)}`) });

/** Numerals out of rendered text, grouping removed. */
const numerals = (text: string | null): number[] =>
  (text?.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((x) => Number(x.replace(/,/g, '')));

/** Fill `{n}`-style values and one `{count, plural, …}` in a message. */
function format(message: string, values: Record<string, string | number>): string {
  return message
    .replace(/\{(\w+), plural, ((?:\w+ \{[^}]*\}\s*)+)\}/g, (_m, name: string, body: string) => {
      const count = Number(values[name]);
      const branches = Object.fromEntries(
        [...body.matchAll(/(\w+) \{([^}]*)\}/g)].map((b) => [b[1], b[2]]),
      );
      return (branches[new Intl.PluralRules(L).select(count)] ?? branches['other']!).replace(
        '#',
        String(count),
      );
    })
    .replace(/\{(\w+)\}/g, (_m, name: string) => String(values[name]));
}

// ── the stub ────────────────────────────────────────────────────────────────

type Wire = { status: number; body: unknown };
const ok = (body: unknown): Wire => ({ status: 200, body });

type Range = { low: number; high: number };
const ECHO: Range = { low: 10, high: 30 };

/** An estimate over the picked categories, split evenly, recommending `plan`. */
function estimateFor(
  picked: string[],
  cadence: 'annual' | 'monthly',
  over: Partial<CalculatorEstimateDTO> = {},
  plan: AiPlanCatalogEntry = TOP,
  ranges: { planned: Range; run: Range } = { planned: ECHO, run: ECHO },
): CalculatorEstimateDTO {
  const base = structuredClone(PINNED_ESTIMATE_ANSWER) as unknown as CalculatorEstimateDTO;
  return {
    ...base,
    cadence,
    plannedPerMonth: ranges.planned,
    runPerMonth: ranges.run,
    credits: { low: 4_000 * picked.length, high: 9_000 * picked.length },
    split: {
      count: picked.length,
      categories: picked.map((key) => ({
        key,
        weight: 1 / picked.length,
        models: CATEGORIES.categories.find((c) => c.key === key)!.models.map((m) => m.id),
      })),
    },
    recommendation: {
      planKey: plan.key,
      planName: plan.name,
      monthlyPriceUsd:
        cadence === 'annual' ? catalogAmount(plan, 'annual') / 12 : catalogAmount(plan, 'monthly'),
    },
    topUp: {
      low: { units: 0, credits: 0, priceUsd: 0 },
      high: { units: 3, credits: 3_000, priceUsd: 15 },
    },
    ceiling: {
      credits: maxMonthlyPlanCredits(),
      exceeded: false,
      excessCredits: 0,
      outcome: 'within_ladder',
    },
    ...over,
  };
}

interface Stub {
  estimates: Array<{ url: string; body: Record<string, unknown> }>;
  categoryReads: number;
  categories: () => Wire;
  estimate: (body: Record<string, unknown>) => Wire | 'abort';
}

/** Arm the two calculator routes — before the first ask. */
async function armStub(page: Page): Promise<Stub> {
  const stub: Stub = {
    estimates: [],
    categoryReads: 0,
    categories: () => ok(CATEGORIES),
    estimate: (body) =>
      ok(estimateFor(body['categories'] as string[], body['cadence'] as 'annual' | 'monthly')),
  };
  await page.route('**/billing/calculator/categories', async (route) => {
    stub.categoryReads += 1;
    const w = stub.categories();
    await route.fulfill({ status: w.status, json: w.body });
  });
  await page.route('**/billing/calculator/estimate', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    stub.estimates.push({ url: route.request().url(), body });
    const w = stub.estimate(body);
    if (w === 'abort') return route.abort('failed');
    // An estimate echoes the two ranges it was asked, as the server's answer does.
    const echo =
      w.status === 200 && (w.body as { kind?: string }).kind === 'estimate'
        ? { plannedPerMonth: body['plannedPerMonth'], runPerMonth: body['runPerMonth'] }
        : {};
    await route.fulfill({ status: w.status, json: { ...(w.body as object), ...echo } });
  });
  return stub;
}

// ── page helpers ────────────────────────────────────────────────────────────

const billingRead = (page: Page, seed: BillingSeed): Promise<Response> =>
  page.waitForResponse(
    (res) =>
      res.request().method() === 'GET' &&
      new URL(res.url()).pathname === `/api/organizations/${seed.organizationId}/billing`,
    { timeout: 45_000 },
  );

async function openPlans(page: Page, seed: BillingSeed, door: string, locale = L) {
  const read = billingRead(page, seed);
  await page.goto(billingPath);
  expect((await read).status()).toBe(200);
  await page.getByRole('button', { name: door }).click();
  await expect(page.getByRole('heading', { name: t('plans.title', {}, locale) })).toBeVisible();
}

const estimateResponse = (page: Page) =>
  page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/billing/calculator/estimate'),
  );

async function openTab(page: Page, locale = L) {
  await page.getByRole('button', { name: t('plans.needMore.action', {}, locale) }).click();
  await expect(
    page.getByRole('heading', { name: t('calculator.title', {}, locale), level: 1 }),
  ).toBeVisible();
  await expect(pickerButton(page, KEYS[0]!)).toBeVisible();
}

/** Type one range; the planned one unless `lane` says the run. */
async function fillRange(
  page: Page,
  low: string,
  high: string,
  locale = L,
  lane: 'planned' | 'run' = 'planned',
) {
  const field = live(page).getByTestId(`calculator-${lane}`);
  await field.getByLabel(t('calculator.inputs.lowLabel', {}, locale)).fill(low);
  await field.getByLabel(t('calculator.inputs.highLabel', {}, locale)).fill(high);
}

/** Set exactly these categories (deselecting any other already on). */
async function pickOnly(page: Page, keys: string[]) {
  for (const key of KEYS) {
    const b = pickerButton(page, key);
    const on = (await b.getAttribute('aria-pressed')) === 'true';
    if (on !== keys.includes(key)) await b.click();
  }
}

async function ask(page: Page, locale = L): Promise<Response> {
  const sent = estimateResponse(page);
  await page.getByRole('button', { name: t('calculator.inputs.submit', {}, locale) }).click();
  return sent;
}

// The LIVE subtree: a text, label or test-id locator rooted at `page` can match the
// outgoing copy React keeps mounted while the next view streams, so it is scoped to
// the page's main landmark. Absence assertions stay page-wide on purpose.
const live = (page: Page) => page.getByRole('main');

const result = (page: Page) => live(page).getByTestId('calculator-result');

// ── the walk ────────────────────────────────────────────────────────────────

test.describe('The Calculator on Billing & plans', () => {
  test('an owner asks by category, reads the split, the plan and the larger pool, and every refusal', async ({
    page,
    chapter,
    beat,
    acceptanceStory,
  }) => {
    acceptanceStory('MOTIR-8381');
    const pageErrors: Error[] = [];
    page.on('pageerror', (e) => pageErrors.push(e));
    const seed = await seedBillingOwner(page, `acc-calc-${Date.now().toString(36)}@example.com`);
    setOrgBillingState(seed.organizationId, freeOrgState(185));
    const stub = await armStub(page);
    const [first, second, third] = KEYS;

    await chapter(
      'Need more credits? opens the Calculator, which estimates nothing until asked',
      async () => {
        await openPlans(page, seed, t('ai.choosePlan'));
        await expect(live(page).getByTestId('plans-need-more')).toContainText(
          t('plans.needMore.title'),
        );
        await expect(page.getByRole('button', { name: t('plans.needMore.action') })).toHaveCount(1);
        await openTab(page);
        expect(page.url()).toContain(billingPath);
        await expect(page.getByTestId('calculator-credits')).toHaveCount(0);
        await expect(live(page).getByText(t('calculator.result.idle'))).toBeVisible();
        expect(stub.estimates).toHaveLength(0);
        expect(stub.categoryReads).toBe(1);
      },
    );
    await beat();

    await chapter(
      'Categories only: each lists its models as examples, none can be picked',
      async () => {
        const group = page.getByRole('group', {
          name: t('calculator.inputs.runCategoriesLabel'),
        });
        await expect(group.getByRole('button')).toHaveCount(KEYS.length);
        for (const c of CATEGORIES.categories) {
          const b = pickerButton(page, c.key);
          await expect(b).toContainText(
            t('calculator.inputs.categoryExamples', {
              models: c.models
                .slice(0, CATEGORY_MODEL_EXAMPLES)
                .map((m) => m.id)
                .join(', '),
            }),
          );
        }
        await expect(group.getByRole('checkbox')).toHaveCount(0);
        await expect(group.getByRole('combobox')).toHaveCount(0);
      },
    );
    await beat();

    await chapter('One category carries the whole estimate', async () => {
      await fillRange(page, '10', '30');
      await pickOnly(page, [first!]);
      const res = await ask(page);
      expect(res.status()).toBe(200);
      const sent = stub.estimates.at(-1)!.body;
      expect(calculatorEstimateRequestSchema.safeParse(sent).success).toBe(true);
      // The run range followed the planned one, so both ranges went.
      expect(sent).toStrictEqual({
        plannedPerMonth: { low: 10, high: 30 },
        runPerMonth: { low: 10, high: 30 },
        categories: [first],
        cadence: 'annual',
      });
      await expect(live(page).getByTestId('calculator-priced')).toHaveText(
        t('calculator.result.priced', {
          plannedLow: '10',
          plannedHigh: '30',
          runLow: '10',
          runHigh: '30',
        }),
      );
      await expect(
        result(page).getByText(t('calculator.split.one', { category: label(first!) })),
      ).toBeVisible();
      const answer = estimateFor([first!], 'annual');
      expect(numerals(await live(page).getByTestId('calculator-credits').textContent())).toEqual([
        answer.credits.low,
        answer.credits.high,
      ]);
      await expect(live(page).getByText(t('calculator.result.estimateCaveat'))).toBeVisible();
    });
    await beat();

    await chapter('Two categories split evenly; three split in thirds', async () => {
      await pickOnly(page, [first!, second!]);
      await ask(page);
      let sent = stub.estimates.at(-1)!.body;
      expect([...(sent['categories'] as string[])].sort()).toEqual([first, second].sort());
      expect(JSON.stringify(sent)).not.toMatch(/"(planning|running|modelIds)"/);
      let split = result(page)
        .locator('p', { hasText: label(first!) })
        .first();
      await expect(split).toContainText(label(second!));
      expect(numerals(await split.textContent())).toContain(50);

      await pickOnly(page, [first!, second!, third!]);
      await ask(page);
      sent = stub.estimates.at(-1)!.body;
      expect(sent['categories']).toHaveLength(3);
      split = result(page)
        .locator('p', { hasText: label(third!) })
        .first();
      expect(numerals(await split.textContent())).toContain(33);
      // No model id travelled on any request this walk made.
      const wire = JSON.stringify(stub.estimates.map((e) => e.body));
      for (const c of CATEGORIES.categories) {
        for (const m of c.models) expect(wire).not.toContain(m.id);
      }
    });
    await beat();

    await chapter(
      'The plan fits as the catalog names it, with the seat rule beside it',
      async () => {
        await expect(live(page).getByTestId('calculator-plan')).toContainText(TOP.name);
        await expect(live(page).getByTestId('calculator-price')).toHaveText(
          t('plans.annualSub', { yr: catalogAmount(TOP, 'annual').toLocaleString('en-US') }),
        );
        const seatLine = live(page).getByTestId('calculator-seat');
        await expect(seatLine).toContainText(
          format(t('calculator.seat.included'), { count: TOP.includedTrackerSeats }),
        );
        await expect(seatLine).toContainText(
          t('calculator.seat.feePerUserAnnual', {
            price: String(BILLING_CATALOG.seatPlan.prices.annual.amountUsd),
          }),
        );
        await expect(result(page)).not.toContainText(/two max|× ?2 ?×/i);
        await expect(live(page).getByTestId('calculator-topup')).toBeVisible();
      },
    );
    await beat();

    await chapter(
      'Monthly is the page’s one cadence: the price and seat fee follow it',
      async () => {
        await page.getByRole('button', { name: t('plans.monthly'), exact: true }).click();
        await ask(page);
        expect(stub.estimates.at(-1)!.body['cadence']).toBe('monthly');
        await expect(live(page).getByTestId('calculator-price')).toHaveText(
          t('plans.perMoEquiv', { n: String(catalogAmount(TOP, 'monthly')) }),
        );
        await expect(live(page).getByTestId('calculator-seat')).toContainText(
          t('calculator.seat.feePerUserMonthly', {
            price: String(BILLING_CATALOG.seatPlan.prices.monthly.amountUsd),
          }),
        );
        await page.getByRole('button', { name: t('plans.annual'), exact: true }).click();
      },
    );
    await beat();

    await chapter(
      'Above the largest regular plan: a larger pool when one is on offer',
      async () => {
        stub.estimate = (body) =>
          ok(
            estimateFor(body['categories'] as string[], body['cadence'] as 'annual' | 'monthly', {
              credits: { low: maxMonthlyPlanCredits() + 1_000, high: maxMonthlyPlanCredits() * 2 },
              ceiling: {
                credits: maxMonthlyPlanCredits(),
                exceeded: true,
                excessCredits: maxMonthlyPlanCredits(),
                outcome: 'larger_pool',
              },
              recommendation: {
                planKey: POOL.key,
                planName: POOL.name,
                monthlyPriceUsd: catalogAmount(POOL, 'annual') / 12,
              },
            }),
          );
        await ask(page);
        const larger = live(page).getByTestId('calculator-larger');
        await expect(larger).toContainText(t('calculator.result.largerPoolLabel'));
        await expect(larger).toContainText(t('calculator.result.largerPlanEstimate'));
        await expect(larger).toContainText(t('calculator.result.largerPlan', { plan: POOL.name }));
        await expect(larger.getByTestId('calculator-larger-price')).toContainText(
          catalogAmount(POOL, 'annual').toLocaleString('en-US'),
        );
        await expect(
          larger.getByRole('button', { name: t('plans.ctaChoose', { plan: POOL.name }) }),
        ).toBeEnabled();
        await expect(result(page)).not.toContainText(/top-ups?\b.*plus|plus.*top-ups?/i);
        await expect(page.getByTestId('calculator-plan')).toHaveCount(0);
      },
    );
    await beat();

    await chapter(
      'Above it with nothing larger to offer: the top plan and top-ups, worded differently',
      async () => {
        stub.estimate = (body) =>
          ok(
            estimateFor(body['categories'] as string[], body['cadence'] as 'annual' | 'monthly', {
              credits: { low: maxMonthlyPlanCredits() + 1_000, high: maxMonthlyPlanCredits() * 2 },
              topUp: {
                low: { units: 1, credits: 1_000, priceUsd: 5 },
                high: { units: 61, credits: 61_000, priceUsd: 305 },
              },
              ceiling: {
                credits: maxMonthlyPlanCredits(),
                exceeded: true,
                excessCredits: maxMonthlyPlanCredits(),
                outcome: 'top_ups_only',
              },
            }),
          );
        await ask(page);
        await expect(
          live(page).getByText(
            t('calculator.result.aboveTopRung', {
              ceiling: maxMonthlyPlanCredits().toLocaleString('en-US'),
            }),
          ),
        ).toBeVisible();
        await expect(page.getByTestId('calculator-larger')).toHaveCount(0);
        await expect(live(page).getByTestId('calculator-plan')).toContainText(TOP.name);
        await expect(live(page).getByTestId('calculator-topup')).toBeVisible();
      },
    );
    await beat();

    await chapter('What a person can type wrong sends nothing', async () => {
      const before = stub.estimates.length;
      const submit = page.getByRole('button', { name: t('calculator.inputs.submit') });
      // blank
      await fillRange(page, '', '');
      await submit.click();
      await expect(live(page).getByText(t('calculator.errors.rangeEmpty'))).toHaveCount(2);
      // decimal, then negative
      await fillRange(page, '1.5', '4');
      await submit.click();
      await expect(live(page).getByText(t('calculator.errors.rangeInvalid'))).toHaveCount(2);
      await fillRange(page, '-2', '4');
      await submit.click();
      await expect(live(page).getByText(t('calculator.errors.rangeInvalid'))).toHaveCount(2);
      // low above high
      await fillRange(page, '9', '4');
      await submit.click();
      await expect(live(page).getByText(t('calculator.errors.rangeOrder'))).toHaveCount(2);
      // both ranges 0–0: one sentence under them
      await fillRange(page, '0', '0');
      await submit.click();
      await expect(live(page).getByText(t('calculator.errors.rangeBothZero'))).toBeVisible();
      // no category
      await fillRange(page, '1', '4');
      await pickOnly(page, []);
      await submit.click();
      await expect(live(page).getByText(t('calculator.errors.categoryMissing'))).toBeVisible();
      await expect(page.getByTestId('calculator-credits')).toHaveCount(0);
      expect(stub.estimates).toHaveLength(before);
    });
    await beat();

    await chapter('The engine declining and the request failing read differently', async () => {
      await pickOnly(page, [first!]);
      stub.estimate = () => ({ status: 503, body: { code: 'CALCULATOR_UNAVAILABLE' } });
      await ask(page);
      await expect(live(page).getByText(t('calculator.errors.unavailable'))).toBeVisible();
      await expect(page.getByText(t('calculator.errors.failed'))).toHaveCount(0);
      await expect(page.getByTestId('calculator-credits')).toHaveCount(0);

      stub.estimate = () => ({ status: 500, body: { code: 'INTERNAL' } });
      await page.getByRole('button', { name: t('states.retry') }).click();
      await expect(live(page).getByText(t('calculator.errors.failed'))).toBeVisible();
      await expect(page.getByText(t('calculator.errors.unavailable'))).toHaveCount(0);

      stub.estimate = () => 'abort';
      await page.getByRole('button', { name: t('states.retry') }).click();
      await expect(live(page).getByText(t('calculator.errors.failed'))).toBeVisible();

      stub.estimate = (body) =>
        ok(estimateFor(body['categories'] as string[], body['cadence'] as 'annual' | 'monthly'));
      await page.getByRole('button', { name: t('states.retry') }).click();
      await expect(live(page).getByTestId('calculator-credits')).toBeVisible();
      await expect(page.getByText(t('calculator.errors.failed'))).toHaveCount(0);
    });
    await beat();

    await chapter(
      'A category with no live model cannot be picked; a withdrawn model drops off',
      async () => {
        const emptied = KEYS[KEYS.length - 1]!;
        const withdrawn = CATEGORIES.categories[0]!.models[0]!.id;
        stub.categories = () =>
          ok({
            ...CATEGORIES,
            categories: CATEGORIES.categories.map((c) =>
              c.key === emptied
                ? { ...c, models: [] }
                : c.key === first
                  ? { ...c, models: c.models.filter((m) => m.id !== withdrawn) }
                  : c,
            ),
          });
        await page.getByRole('button', { name: t('calculator.back') }).click();
        await openTab(page);
        await expect(pickerButton(page, emptied)).toBeDisabled();
        await expect(pickerButton(page, emptied)).toContainText(t('calculator.categories.empty'));
        // A whole entry of the example list, not a substring: `glm-5.3-flash` is a prefix of
        // `glm-5.3-flashx`, which stays listed.
        const asListedModel = new RegExp(
          `(^|[\\s,])${withdrawn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(,|$)`,
        );
        await expect(pickerButton(page, first!)).not.toContainText(asListedModel);
        await fillRange(page, '2', '5');
        await pickOnly(page, [first!, second!]);
        const res = await ask(page);
        expect(res.status()).toBe(200);
        await expect(live(page).getByTestId('calculator-credits')).toBeVisible();
      },
    );
    await beat();

    await chapter('中文: the same figures, the words from the 中文 catalogue', async () => {
      stub.categories = () => ok(CATEGORIES);
      await saveAccountLanguageInSettings(page, 'zh');
      await openPlans(page, seed, t('ai.choosePlan', {}, 'zh'), 'zh');
      await openTab(page, 'zh');
      await fillRange(page, '10', '30', 'zh');
      await pickOnly(page, [first!, second!]);
      await ask(page, 'zh');
      const answer = estimateFor([first!, second!], 'annual');
      expect(numerals(await live(page).getByTestId('calculator-credits').textContent())).toEqual([
        answer.credits.low,
        answer.credits.high,
      ]);
      await expect(live(page).getByTestId('calculator-price')).toContainText(
        String(catalogAmount(TOP, 'annual')).replace(/\B(?=(\d{3})+$)/g, ','),
      );
      await expect(
        live(page).getByText(t('calculator.result.estimateCaveat', {}, 'zh')),
      ).toBeVisible();
      await expect(page.getByText(/billing\.calculator\./)).toHaveCount(0);
    });
    await beat();

    expect(pageErrors).toEqual([]);
  });

  test('an upgrade line only when the plan is above the current one, and the hand-off buys nothing', async ({
    page,
  }) => {
    const seed = await seedBillingOwner(page, `acc-calc-up-${Date.now().toString(36)}@example.com`);
    setOrgBillingState(seed.organizationId, paidOrgState());
    const stub = await armStub(page);
    await openPlans(page, seed, t('ai.changePlan'));
    await openTab(page);
    await fillRange(page, '5', '9');
    await pickOnly(page, [KEYS[0]!]);

    stub.estimate = (body) =>
      ok(
        estimateFor(
          body['categories'] as string[],
          body['cadence'] as 'annual' | 'monthly',
          {},
          PAID[1]!,
        ),
      );
    await ask(page);
    await expect(live(page).getByText(t('calculator.result.upgradeNote'))).toBeVisible();
    await expect(result(page)).not.toContainText(/proration|prorated/i);

    stub.estimate = (body) =>
      ok(
        estimateFor(
          body['categories'] as string[],
          body['cadence'] as 'annual' | 'monthly',
          {},
          SMALLEST,
        ),
      );
    await ask(page);
    await expect(page.getByText(t('calculator.result.upgradeNote'))).toHaveCount(0);
    await expect(page.getByRole('button', { name: /downgrade/i })).toHaveCount(0);

    // The hand-off lands on the plans view with the recommended plan distinguished,
    // and starts no checkout.
    const posts: Request[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && /checkout|change-plan/.test(r.url())) posts.push(r);
    });
    await page.getByRole('button', { name: t('calculator.result.goToPlan') }).click();
    await expect(page.getByRole('heading', { name: t('plans.title') })).toBeVisible();
    await expect(page.locator('[data-marked="true"]')).toHaveCount(1);
    await expect(page.locator('[data-marked="true"]')).toContainText(SMALLEST.name);
    await expect(page.locator('[data-marked="true"]')).toContainText(t('calculator.marked'));
    expect(posts).toHaveLength(0);
  });

  test('an admin gets the same tab and figures', async ({ page }) => {
    const seed = await seedBillingOwner(
      page,
      `acc-calc-own-${Date.now().toString(36)}@example.com`,
    );
    const adminEmail = `acc-calc-adm-${Date.now().toString(36)}@example.com`;
    const admin = await addOrgMember(seed, adminEmail);
    await adminDb.organizationMembership.updateMany({
      where: { organizationId: seed.organizationId, userId: admin.id },
      data: { role: ORGANIZATION_ROLE.admin },
    });
    setOrgBillingState(seed.organizationId, freeOrgState(185));
    await page.context().clearCookies();
    await signIn(page, adminEmail, SHELL_PASSWORD);
    await pinContextCookies(page, {
      workspaceId: seed.workspaceId,
      organizationId: seed.organizationId,
    });
    const stub = await armStub(page);
    await openPlans(page, seed, t('ai.choosePlan'));
    await openTab(page);
    await fillRange(page, '10', '30');
    await pickOnly(page, [KEYS[0]!]);
    await ask(page);
    const answer = estimateFor([KEYS[0]!], 'annual');
    expect(numerals(await live(page).getByTestId('calculator-credits').textContent())).toEqual([
      answer.credits.low,
      answer.credits.high,
    ]);
    await expect(page.getByRole('button', { name: t('calculator.result.goToPlan') })).toBeEnabled();
    expect(stub.estimates).toHaveLength(1);
  });

  test('a member without billing rights has no door to the Calculator and sends no request', async ({
    page,
  }) => {
    const seed = await seedBillingOwner(page, `acc-calc-o2-${Date.now().toString(36)}@example.com`);
    const memberEmail = `acc-calc-mem-${Date.now().toString(36)}@example.com`;
    await addOrgMember(seed, memberEmail);
    setOrgBillingState(seed.organizationId, freeOrgState(185));
    await page.context().clearCookies();
    await signIn(page, memberEmail, SHELL_PASSWORD);
    await pinContextCookies(page, {
      workspaceId: seed.workspaceId,
      organizationId: seed.organizationId,
    });
    const stub = await armStub(page);
    const read = billingRead(page, seed);
    await page.goto(billingPath);
    expect((await read).status()).toBe(403);
    await expect(page.getByRole('heading', { name: t('member.gateTitle') })).toBeVisible();
    await expect(page.getByRole('button', { name: t('plans.needMore.action') })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: t('calculator.title') })).toHaveCount(0);
    expect(stub.categoryReads).toBe(0);
    expect(stub.estimates).toHaveLength(0);
  });
});
