// @vitest-environment happy-dom
import { useState } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render, enMessages } from '../helpers/renderWithIntl';
import { BILLING_CATALOG } from '@/lib/billing/catalog';
import type { BillingCadence } from '@/lib/billing/catalog';
import type { BillingStatusDTO } from '@/lib/dto/billing';
import { exampleModels } from '@/lib/billing/modelExamples';
import {
  CATEGORY_MODEL_EXAMPLES,
  CalculatorView,
} from '@/app/(authed)/settings/organization/billing/_components/CalculatorView';
import {
  PINNED_CALCULATOR_REQUEST,
  PINNED_CATEGORIES_ANSWER,
  PINNED_CATEGORIES_RAW_BODY,
  PINNED_ESTIMATE_ANSWER,
  PINNED_ESTIMATE_RAW_BODY,
} from '../fixtures/calculatorPinnedVector';

// The Calculator tab's answer against the PINNED VECTOR (Story MOTIR-8381 ·
// MOTIR-8643). What is asserted is a comparison between what the tab RENDERS and
// what the record CARRIES: the figures the engine returned for the pinned input
// are the figures a person reads, with nothing on the way re-deriving, rounding,
// relabelling, re-pricing or inventing them. Nothing here asks the engine anything.
//
// The only stubbed boundary is the global `fetch`, answered with the record's own
// bytes: the shipped browser helper and the render both execute. The record is in the
// engine's current request shape (MOTIR-9224 · MOTIR-9832 · MOTIR-10156): two ranges,
// two categories and their shares of the run. The tab is driven to exactly that input
// through its own controls, and the request it sends must BE the recorded request —
// the same record motir-marketing's /price parity test feeds its page, byte for byte.
// Every expected value is derived — from the record, or from BILLING_CATALOG by the
// record's plan key — never typed.

type Answer = typeof PINNED_ESTIMATE_ANSWER;
const m = enMessages.billing.calculator;

// ── derived expectations ────────────────────────────────────────────────────

/** A value a case reads, or a failure naming where it was missing. */
function need<T>(value: T | null | undefined, path: string): T {
  if (value === null || value === undefined) {
    throw new Error(`the record is missing ${path}, which this case asserts`);
  }
  return value;
}

function catalogPlan(key: string | null | undefined) {
  const planKey = need(key, 'recommendation.planKey');
  const entry = BILLING_CATALOG.aiPlans.find((p) => p.key === planKey);
  if (!entry) throw new Error(`BILLING_CATALOG.aiPlans has no entry for the plan key "${planKey}"`);
  return entry;
}

function catalogAmount(key: string | null | undefined, cadence: BillingCadence): number {
  const plan = catalogPlan(key);
  return need(plan.prices?.[cadence]?.amountUsd, `aiPlans[${plan.key}].prices.${cadence}`);
}

/** The picker's label: the key, capitalised and nothing else. */
const labelOf = (key: string) => key.charAt(0).toUpperCase() + key.slice(1);

/** Numerals out of rendered text, grouping removed — formatting is the render's business. */
function numerals(text: string): number[] {
  return (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => Number(n.replace(/,/g, '')));
}

const textOf = (el: HTMLElement) => el.textContent ?? '';

// ── the stub ────────────────────────────────────────────────────────────────

const requests: Array<{ url: string; body: unknown }> = [];

function stubEngine(estimateBody: string = PINNED_ESTIMATE_RAW_BODY) {
  requests.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({
        url,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      if (url.endsWith('/calculator/categories')) {
        return new Response(PINNED_CATEGORIES_RAW_BODY, { status: 200 });
      }
      if (url.endsWith('/calculator/estimate')) {
        const sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const answer = JSON.parse(estimateBody) as Record<string, unknown>;
        answer['plannedPerMonth'] ??= sent['plannedPerMonth'];
        answer['runPerMonth'] ??= sent['runPerMonth'];
        return new Response(JSON.stringify(answer), { status: 200 });
      }
      throw new Error(`unexpected request to ${url}`);
    }),
  );
}

const status = {
  catalog: BILLING_CATALOG,
  access: { canManageBilling: true },
  motirAi: {
    tier: { key: 'free', name: 'Free', monthlyCreditAllotment: 0 },
    balance: 0,
    pendingDowngrade: null,
    subscription: { status: null, currentPeriodEnd: null, priceId: null, planTier: null },
  },
} as unknown as BillingStatusDTO;

// The tab with its cadence owned by state, as the island that hosts it owns it.
function Tab({ initial }: { initial: BillingCadence }) {
  const [cadence, setCadence] = useState<BillingCadence>(initial);
  return (
    <CalculatorView
      orgId="org1"
      orgName="Acme"
      data={status}
      cadence={cadence}
      onCadence={setCadence}
      back={() => {}}
      goToPlan={() => {}}
      checkout={() => {}}
      portal={() => {}}
      reload={async () => {}}
      redirecting={false}
    />
  );
}

type Input = typeof PINNED_CALCULATOR_REQUEST;

function typeRange(testId: string, range: { low: number; high: number }) {
  const field = screen.getByTestId(testId);
  fireEvent.change(within(field).getByLabelText(m.inputs.lowLabel), {
    target: { value: String(range.low) },
  });
  fireEvent.change(within(field).getByLabelText(m.inputs.highLabel), {
    target: { value: String(range.high) },
  });
}

/** Drive the tab to an input through its own controls — ranges, categories, shares — and ask. */
async function ask(input: Input, startCadence: BillingCadence = input.cadence) {
  render(<Tab initial={startCadence} />);
  await screen.findByRole('button', { name: new RegExp(`^${labelOf(input.categories[0]!)}`) });
  if (startCadence !== input.cadence) {
    fireEvent.click(
      screen.getByRole('button', { name: input.cadence === 'annual' ? 'Annual' : 'Monthly' }),
    );
  }
  // Planned first: the run range follows it until it is edited, then is set itself.
  typeRange('calculator-planned', input.plannedPerMonth);
  typeRange('calculator-run', input.runPerMonth);
  for (const key of input.categories) {
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${labelOf(key)}`) }));
  }
  // Every share but the last is dragged to its value; the last takes the remainder.
  const sliders = screen.getByTestId('calculator-shares');
  for (const key of input.categories.slice(0, -1)) {
    fireEvent.change(within(sliders).getByLabelText(labelOf(key)), {
      target: { value: String(input.shares[key]) },
    });
  }
  fireEvent.click(screen.getByRole('button', { name: m.inputs.submit }));
  return screen.findByTestId('calculator-result');
}

/** A scratch copy of the record's answer — the record itself is never written. */
function scratch(mutate: (a: Answer) => void): string {
  const copy = structuredClone(PINNED_ESTIMATE_ANSWER);
  mutate(copy);
  return JSON.stringify(copy);
}

const recordBefore = JSON.stringify([
  PINNED_CALCULATOR_REQUEST,
  PINNED_ESTIMATE_ANSWER,
  PINNED_ESTIMATE_RAW_BODY,
  PINNED_CATEGORIES_ANSWER,
  PINNED_CATEGORIES_RAW_BODY,
]);

beforeAll(() => {
  // A guard on the guard: the cases below can only discharge anything if the
  // record offers them a plan the catalogue prices and a top-up to show.
  expect(PINNED_ESTIMATE_ANSWER.ceiling.outcome).toBe('within_ladder');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
afterAll(() => {
  vi.unstubAllGlobals();
});

// ── the cases ───────────────────────────────────────────────────────────────

describe('the Calculator tab against the pinned vector', () => {
  const pinned = PINNED_CALCULATOR_REQUEST;

  it('sends the pinned input — exactly the recorded request, shares included, and no lane or model', async () => {
    stubEngine();
    await ask(pinned);
    const post = requests.find((r) => r.url.endsWith('/calculator/estimate'));
    const body = need(post, 'a captured estimate request').body as Record<string, unknown>;
    // The tab's server forwards exactly these keys to the engine (`estimateCalculator`),
    // so the browser body IS the engine request the record was taken with.
    expect(body).toStrictEqual({ ...pinned });
    expect(body).not.toHaveProperty('itemsPerMonth');
    for (const retired of ['planning', 'running', 'modelIds']) {
      expect(body).not.toHaveProperty(retired);
    }
  });

  it('renders the two ranges the answer echoes', async () => {
    stubEngine();
    const result = await ask(pinned);
    const { plannedPerMonth: p, runPerMonth: r } = PINNED_ESTIMATE_ANSWER;
    const priced = within(result).getByTestId('calculator-priced');
    expect(numerals(textOf(priced))).toEqual(
      expect.arrayContaining([p.low, p.high, r.low, r.high]),
    );
  });

  it('renders the credit range’s low end and high end', async () => {
    stubEngine();
    await ask(pinned);
    const shown = numerals(textOf(screen.getByTestId('calculator-credits')));
    expect(shown).toEqual([
      PINNED_ESTIMATE_ANSWER.credits.low,
      PINNED_ESTIMATE_ANSWER.credits.high,
    ]);
  });

  it('renders the split the answer carries, one share per pinned category', async () => {
    stubEngine();
    const result = await ask(pinned);
    for (const c of need(PINNED_ESTIMATE_ANSWER.split?.categories, 'split.categories')) {
      need(c.weight, `split.categories[${c.key}].weight`);
    }
    const line = within(result)
      .getAllByText(() => true, { selector: 'p' })
      .find((p) =>
        PINNED_ESTIMATE_ANSWER.split.categories.every((c) => textOf(p).includes(labelOf(c.key))),
      );
    const sentence = textOf(need(line, 'a split sentence naming every pinned category'));
    const shown = numerals(sentence);
    for (const c of PINNED_ESTIMATE_ANSWER.split.categories) {
      expect(shown, `share of ${c.key}`).toContain(Math.round(c.weight * 100));
    }
  });

  it('names the recommended plan as the catalogue does', async () => {
    stubEngine();
    await ask(pinned);
    const plan = catalogPlan(PINNED_ESTIMATE_ANSWER.recommendation.planKey);
    expect(textOf(screen.getByTestId('calculator-plan'))).toContain(plan.name);
  });

  it('prints the catalogue’s amount at the pinned cadence — not the answer’s monthly equivalent', async () => {
    stubEngine();
    await ask(pinned);
    const expected = catalogAmount(PINNED_ESTIMATE_ANSWER.recommendation.planKey, pinned.cadence);
    expect(numerals(textOf(screen.getByTestId('calculator-price')))).toEqual([expected]);
    // The record's own figure is a different number here, so this is not a tie.
    expect(PINNED_ESTIMATE_ANSWER.recommendation.monthlyPriceUsd).not.toBe(expected);
  });

  it('renders the top-up’s two ends', async () => {
    stubEngine();
    await ask(pinned);
    const shown = numerals(textOf(screen.getByTestId('calculator-topup')));
    expect(shown).toEqual([
      PINNED_ESTIMATE_ANSWER.topUp.low.credits,
      PINNED_ESTIMATE_ANSWER.topUp.high.credits,
    ]);
  });

  it('offers the recorded categories, labelled and exemplified from the record, with no model control', async () => {
    stubEngine();
    render(<Tab initial={pinned.cadence} />);
    const group = await screen.findByRole('group', { name: m.inputs.runCategoriesLabel });
    const buttons = within(group).getAllByRole('button');
    const recorded = PINNED_CATEGORIES_ANSWER.categories;
    expect(buttons.map((b) => (b.textContent ?? '').replace(/For example.*$/, ''))).toEqual(
      recorded.map((c) => labelOf(c.key)),
    );
    // Each category names current recorded models as example text in its own control,
    // at most CATEGORY_MODEL_EXAMPLES of them (`lib/billing/modelExamples.ts`)…
    recorded.forEach((c, i) => {
      const examples = exampleModels(
        c.models.map((x) => x.id),
        CATEGORY_MODEL_EXAMPLES,
      );
      expect(textOf(buttons[i]!).endsWith(`For example: ${examples.join(', ')}`)).toBe(true);
    });
    // …and no activatable control IS a model: each is a category, named by its label.
    const modelIds = new Set(recorded.flatMap((c) => c.models.map((x) => x.id)));
    for (const control of buttons) {
      const label = textOf(control).replace(/For example.*$/, '');
      expect(modelIds.has(label)).toBe(false);
      expect(recorded.map((c) => labelOf(c.key))).toContain(label);
    }
    expect(within(group).queryAllByRole('checkbox')).toHaveLength(0);
    expect(within(group).queryAllByRole('radio')).toHaveLength(0);
    expect(within(group).queryAllByRole('option')).toHaveLength(0);
  });

  it('follows the answer rather than coincidence — shifted range, other plan, changed top-up, unequal shares', async () => {
    const other = need(
      BILLING_CATALOG.aiPlans.find(
        (p) => p.key !== PINNED_ESTIMATE_ANSWER.recommendation.planKey && p.prices !== null,
      ),
      'a second priced plan in BILLING_CATALOG.aiPlans',
    );
    const body = scratch((a) => {
      a.credits = { low: a.credits.low + 1111, high: a.credits.high + 2222 };
      a.recommendation = { ...a.recommendation, planKey: other.key, planName: other.name };
      a.topUp = {
        low: { units: 3, credits: 3000, priceUsd: 15 },
        high: { units: 7, credits: 7000, priceUsd: 35 },
      };
      a.split.categories[0]!.weight = 0.7;
      a.split.categories[1]!.weight = 0.3;
    });
    const changed = JSON.parse(body) as Answer;
    stubEngine(body);
    const result = await ask(pinned);

    expect(numerals(textOf(screen.getByTestId('calculator-credits')))).toEqual([
      changed.credits.low,
      changed.credits.high,
    ]);
    expect(textOf(screen.getByTestId('calculator-plan'))).toContain(other.name);
    expect(numerals(textOf(screen.getByTestId('calculator-price')))).toEqual([
      catalogAmount(other.key, pinned.cadence),
    ]);
    expect(numerals(textOf(screen.getByTestId('calculator-topup')))).toEqual([3000, 7000]);
    const line = within(result)
      .getAllByText(() => true, { selector: 'p' })
      .find((p) => changed.split.categories.every((c) => textOf(p).includes(labelOf(c.key))));
    const shares = numerals(textOf(need(line, 'a split sentence')));
    expect(shares).toContain(70);
    expect(shares).toContain(30);
  });

  it('follows the cadence the control is set to', async () => {
    const other: BillingCadence = pinned.cadence === 'annual' ? 'monthly' : 'annual';
    stubEngine(scratch((a) => (a.cadence = other)));
    await ask({ ...pinned, cadence: other }, pinned.cadence);
    const requested = requests.find((r) => r.url.endsWith('/calculator/estimate'));
    expect((need(requested, 'an estimate request').body as { cadence: string }).cadence).toBe(
      other,
    );
    expect(numerals(textOf(screen.getByTestId('calculator-price')))).toEqual([
      catalogAmount(PINNED_ESTIMATE_ANSWER.recommendation.planKey, other),
    ]);
    expect(catalogAmount(PINNED_ESTIMATE_ANSWER.recommendation.planKey, other)).not.toBe(
      catalogAmount(PINNED_ESTIMATE_ANSWER.recommendation.planKey, pinned.cadence),
    );
  });

  it('fails loudly, naming what is missing, rather than comparing undefined', () => {
    expect(() => need(undefined, 'recommendation.planKey')).toThrow(/recommendation\.planKey/);
    expect(() => catalogPlan(null)).toThrow(/recommendation\.planKey/);
    expect(() => catalogPlan('no_such_plan')).toThrow(/no_such_plan/);
    expect(() => catalogAmount('free', 'annual')).toThrow(/aiPlans\[free\]\.prices\.annual/);
  });

  it('leaves the record byte-unchanged after every counterfactual above', () => {
    expect(
      JSON.stringify([
        PINNED_CALCULATOR_REQUEST,
        PINNED_ESTIMATE_ANSWER,
        PINNED_ESTIMATE_RAW_BODY,
        PINNED_CATEGORIES_ANSWER,
        PINNED_CATEGORIES_RAW_BODY,
      ]),
    ).toBe(recordBefore);
  });
});
