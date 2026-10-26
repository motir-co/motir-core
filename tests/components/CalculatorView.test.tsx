// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render, enMessages } from '../helpers/renderWithIntl';
import {
  BILLING_CATALOG,
  INCLUDED_TRACKER_SEATS_PER_AI_PLAN,
  largerPoolPlans,
} from '@/lib/billing/catalog';
import type { BillingCadence } from '@/lib/billing/catalog';
import type {
  BillingStatusDTO,
  CalculatorCategoriesDTO,
  CalculatorEmptyCategoryDTO,
  CalculatorEstimateDTO,
} from '@/lib/dto/billing';
import type { CalculatorOutcome } from '@/lib/billing/calculatorClient';
import { CalculatorView } from '@/app/(authed)/settings/organization/billing/_components/CalculatorView';

// The Calculator view's state matrix (MOTIR-8639 · MOTIR-9224 · MOTIR-8997), against a
// STUBBED client helper: the categories read, the two ranges, the recommendation arms
// (the larger and the largest pool sold from the answer), both cadences, the seat line,
// the upgrade line, every refusal and every door outcome. The helper's own wire
// behaviour is `calculatorClient.test.ts`'s; the engine's figures are its repository's —
// the answers below are fixtures, which is the point: this view prints what it is given.

const client = vi.hoisted(() => ({
  fetchCalculatorCategories: vi.fn(),
  fetchCalculatorEstimate: vi.fn(),
}));
vi.mock('@/lib/billing/calculatorClient', () => client);

const m = enMessages.billing.calculator;

function categories(over: Partial<CalculatorCategoriesDTO> = {}): CalculatorCategoriesDTO {
  return {
    version: 2,
    categoryRuleVersion: 'rule-1',
    modelsReadAt: '2026-10-21T00:00:00.000Z',
    cadences: ['annual', 'monthly'],
    defaultCadence: 'annual',
    categories: [
      { key: 'economy', models: [{ id: 'model-a', provider: 'p' }] },
      {
        key: 'balanced',
        models: [
          { id: 'model-b', provider: 'p' },
          { id: 'model-c', provider: 'p' },
        ],
      },
      { key: 'flagship', models: [{ id: 'model-d', provider: 'p' }] },
    ],
    ...over,
  };
}

function estimate(over: Partial<CalculatorEstimateDTO> = {}): CalculatorEstimateDTO {
  return {
    version: 2,
    kind: 'estimate',
    profilesVersion: 'profiles-1',
    categoryRuleVersion: 'rule-1',
    cadence: 'annual',
    plannedPerMonth: { low: 40, high: 60 },
    runPerMonth: { low: 40, high: 60 },
    credits: { low: 11_000, high: 44_000 },
    perItemCredits: { planning: 100, running: 200 },
    split: {
      count: 2,
      categories: [
        { key: 'balanced', weight: 0.5, models: ['model-b'] },
        { key: 'flagship', weight: 0.5, models: ['model-d'] },
      ],
    },
    recommendation: { planKey: 'max_x2', planName: 'Max ×2', monthlyPriceUsd: 200 },
    topUp: {
      low: { units: 0, credits: 0, priceUsd: 0 },
      high: { units: 0, credits: 0, priceUsd: 0 },
    },
    ceiling: { credits: 60_000, exceeded: false, excessCredits: 0, outcome: 'within_ladder' },
    ...over,
  };
}

const POOLS = largerPoolPlans();
const SMALLEST = POOLS[0]!;
const LARGEST = POOLS[POOLS.length - 1]!;

/** Where the high end lands on the smallest larger pool the catalog sells. */
function larger(planKey = SMALLEST.key, planName = SMALLEST.name): CalculatorEstimateDTO {
  return estimate({
    credits: { low: 61_000, high: 75_000 },
    recommendation: { planKey, planName, monthlyPriceUsd: 555 },
    ceiling: { credits: 60_000, exceeded: true, excessCredits: 15_000, outcome: 'larger_pool' },
  });
}

/** The high end of the `largest()` answer: 12,000 credits past the largest pool sold. */
const LARGEST_HIGH = LARGEST.allotment!.credits + 12_000;

/** Above every pool: the largest one, and the rest in top-ups. */
function largest(): CalculatorEstimateDTO {
  return estimate({
    credits: { low: LARGEST.allotment!.credits - 62_000, high: LARGEST_HIGH },
    recommendation: {
      planKey: LARGEST.key,
      planName: LARGEST.name,
      monthlyPriceUsd: LARGEST.prices!.monthly.amountUsd,
    },
    topUp: {
      low: { units: 0, credits: 0, priceUsd: 0 },
      high: { units: 12, credits: 12_000, priceUsd: 60 },
    },
    ceiling: {
      credits: 60_000,
      exceeded: true,
      excessCredits: LARGEST_HIGH - 60_000,
      outcome: 'largest_pool',
    },
  });
}

/** Above the regular ladder with no larger pool: the top plan and the excess in top-ups. */
function above(): CalculatorEstimateDTO {
  return estimate({
    credits: { low: 61_000, high: 160_000 },
    topUp: {
      low: { units: 1, credits: 1_000, priceUsd: 5 },
      high: { units: 101, credits: 101_000, priceUsd: 505 },
    },
    ceiling: { credits: 60_000, exceeded: true, excessCredits: 100_000, outcome: 'top_ups_only' },
  });
}

const answer = <T,>(value: T): CalculatorOutcome<T> => ({ kind: 'answer', value });

function status(
  over: { tierKey?: string; active?: boolean; canManage?: boolean } = {},
): BillingStatusDTO {
  const tierKey = over.tierKey ?? 'free';
  return {
    catalog: BILLING_CATALOG,
    access: { canManageBilling: over.canManage ?? true },
    motirAi: {
      tier: { key: tierKey, name: tierKey, monthlyCreditAllotment: 0 },
      balance: 0,
      pendingDowngrade: null,
      subscription: {
        status: over.active ? 'active' : null,
        currentPeriodEnd: null,
        priceId: null,
        planTier: null,
      },
    },
  } as unknown as BillingStatusDTO;
}

type Checkout = (priceLookupKey: string, onRefused: (payload: unknown) => boolean) => void;

interface Handles {
  back: Mock<() => void>;
  goToPlan: Mock<(planKey: string | null) => void>;
  onCadence: Mock<(cadence: BillingCadence) => void>;
  checkout: Mock<Checkout>;
}

function renderView(
  opts: {
    data?: BillingStatusDTO;
    cadence?: BillingCadence;
    messages?: Record<string, unknown>;
  } = {},
): Handles {
  const handles: Handles = {
    back: vi.fn<() => void>(),
    goToPlan: vi.fn<(planKey: string | null) => void>(),
    onCadence: vi.fn<(cadence: BillingCadence) => void>(),
    checkout: vi.fn<Checkout>(),
  };
  render(
    <CalculatorView
      orgId="org1"
      orgName="Acme"
      data={opts.data ?? status()}
      cadence={opts.cadence ?? 'annual'}
      onCadence={handles.onCadence}
      back={handles.back}
      goToPlan={handles.goToPlan}
      checkout={handles.checkout}
      portal={() => {}}
      reload={async () => {}}
      redirecting={false}
    />,
  );
  return handles;
}

async function ready() {
  await screen.findByRole('button', { name: /Economy/ });
}

/** One end of one range: the planned range unless `lane` says the run. */
function field(label: string, lane: 'planned' | 'run' = 'planned') {
  return within(screen.getByTestId(`calculator-${lane}`)).getByLabelText(label) as HTMLInputElement;
}

function type(label: string, value: string, lane: 'planned' | 'run' = 'planned') {
  fireEvent.change(field(label, lane), { target: { value } });
}

function pick(name: RegExp) {
  fireEvent.click(screen.getByRole('button', { name }));
}

async function ask(low = '40', high = '60', picks: RegExp[] = [/Balanced/, /Flagship/]) {
  await ready();
  type(m.inputs.lowLabel, low);
  type(m.inputs.highLabel, high);
  for (const p of picks) pick(p);
  fireEvent.click(screen.getByRole('button', { name: m.inputs.submit }));
}

beforeEach(() => {
  client.fetchCalculatorCategories.mockReset().mockResolvedValue(answer(categories()));
  client.fetchCalculatorEstimate.mockReset().mockResolvedValue(answer(estimate()));
});
afterEach(cleanup);

describe('opening the view', () => {
  it('reads the categories once and sends no estimate', async () => {
    renderView();
    await ready();
    expect(client.fetchCalculatorCategories).toHaveBeenCalledTimes(1);
    expect(client.fetchCalculatorEstimate).not.toHaveBeenCalled();
    expect(screen.getByText(m.result.idle)).toBeTruthy();
  });

  it('offers every category in the answer order, models as text, no model control', async () => {
    renderView();
    await ready();
    const group = screen.getByRole('group', { name: m.inputs.runCategoriesLabel });
    const names = within(group)
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(names).toEqual([
      'EconomyFor example: model-a',
      'BalancedFor example: model-b, model-c',
      'FlagshipFor example: model-d',
    ]);
    // Nothing selects a model: the only controls in the group are the categories.
    expect(within(group).queryAllByRole('checkbox')).toHaveLength(0);
    expect(within(group).queryAllByRole('combobox')).toHaveLength(0);
  });

  it('names at most three models per category, however many the engine serves', async () => {
    client.fetchCalculatorCategories.mockResolvedValue(
      answer(
        categories({
          categories: [
            {
              key: 'economy',
              models: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'].map((id) => ({ id, provider: 'p' })),
            },
          ],
        }),
      ),
    );
    renderView();
    await ready();
    const group = screen.getByRole('group', { name: m.inputs.runCategoriesLabel });
    expect(within(group).getByRole('button').textContent).toBe('EconomyFor example: m1, m2, m3');
  });

  it('shows a category with no live model as unavailable and keeps the others usable', async () => {
    client.fetchCalculatorCategories.mockResolvedValue(
      answer(
        categories({
          categories: [
            { key: 'economy', models: [] },
            { key: 'balanced', models: [{ id: 'model-b', provider: 'p' }] },
          ],
        }),
      ),
    );
    renderView();
    const economy = await screen.findByRole('button', { name: /Economy/ });
    expect((economy as HTMLButtonElement).disabled).toBe(true);
    expect(within(economy).getByText(m.categories.empty)).toBeTruthy();
    expect((screen.getByRole('button', { name: /Balanced/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('renders a failed categories read distinctly, with a retry that re-reads', async () => {
    client.fetchCalculatorCategories.mockResolvedValueOnce({ kind: 'failed' });
    renderView();
    await screen.findByText(m.categories.failed);
    expect(
      (screen.getByRole('button', { name: m.inputs.submit }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: enMessages.billing.states.retry }));
    await ready();
    expect(client.fetchCalculatorCategories).toHaveBeenCalledTimes(2);
  });

  it('shows the loading line while the categories are in flight', () => {
    client.fetchCalculatorCategories.mockReturnValue(new Promise(() => {}));
    renderView();
    expect(screen.getByText(enMessages.billing.states.loading)).toBeTruthy();
  });
});

describe('picking categories', () => {
  it('lets one, two and three be sent and stops a fourth', async () => {
    client.fetchCalculatorCategories.mockResolvedValue(
      answer(
        categories({
          categories: [
            ...categories().categories,
            { key: 'extra', models: [{ id: 'model-e', provider: 'p' }] },
          ],
        }),
      ),
    );
    renderView();
    await ready();
    pick(/Economy/);
    pick(/Balanced/);
    pick(/Flagship/);
    expect((screen.getByRole('button', { name: /Extra/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    // A chosen one can still be removed, which re-opens the fourth.
    pick(/Flagship/);
    expect((screen.getByRole('button', { name: /Extra/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('sends exactly the door body: both ranges, the picked keys and the shared cadence', async () => {
    renderView({ cadence: 'monthly' });
    await ask('40', '60', [/Flagship/, /Balanced/]);
    await screen.findByTestId('calculator-credits');
    expect(client.fetchCalculatorEstimate).toHaveBeenCalledWith('org1', {
      plannedPerMonth: { low: 40, high: 60 },
      runPerMonth: { low: 40, high: 60 },
      categories: ['flagship', 'balanced'],
      cadence: 'monthly',
    });
  });

  it('shows each picked category’s share of the run before anything is asked', async () => {
    renderView();
    await ready();
    pick(/Balanced/);
    expect(screen.getAllByTestId('calculator-category-share').map((n) => n.textContent)).toEqual([
      '100% of the run',
    ]);
    pick(/Flagship/);
    expect(screen.getAllByTestId('calculator-category-share').map((n) => n.textContent)).toEqual([
      '50% of the run',
      '50% of the run',
    ]);
    pick(/Economy/);
    expect(screen.getAllByTestId('calculator-category-share')).toHaveLength(3);
    expect(screen.getAllByTestId('calculator-category-share')[0]!.textContent).toBe(
      '33% of the run',
    );
    expect(client.fetchCalculatorEstimate).not.toHaveBeenCalled();
  });
});

describe('the two ranges', () => {
  it('the run range follows the planned one until it is typed into', async () => {
    renderView();
    await ready();
    type(m.inputs.lowLabel, '10');
    type(m.inputs.highLabel, '30');
    expect(field(m.inputs.lowLabel, 'run').value).toBe('10');
    expect(field(m.inputs.highLabel, 'run').value).toBe('30');
    type(m.inputs.highLabel, '5', 'run');
    type(m.inputs.highLabel, '40');
    expect(field(m.inputs.highLabel, 'run').value).toBe('5');
  });

  it('sends a run range apart from the planned one — 0–0 for an org on its own agent', async () => {
    renderView();
    await ready();
    type(m.inputs.lowLabel, '20');
    type(m.inputs.highLabel, '50');
    type(m.inputs.lowLabel, '0', 'run');
    type(m.inputs.highLabel, '0', 'run');
    pick(/Balanced/);
    fireEvent.click(screen.getByRole('button', { name: m.inputs.submit }));
    await screen.findByTestId('calculator-credits');
    expect(client.fetchCalculatorEstimate).toHaveBeenCalledWith(
      'org1',
      expect.objectContaining({
        plannedPerMonth: { low: 20, high: 50 },
        runPerMonth: { low: 0, high: 0 },
      }),
    );
  });

  it('prints the two ranges the answer priced, from the answer', async () => {
    client.fetchCalculatorEstimate.mockResolvedValue(
      answer(
        estimate({ plannedPerMonth: { low: 20, high: 50 }, runPerMonth: { low: 3, high: 8 } }),
      ),
    );
    renderView();
    await ask();
    expect((await screen.findByTestId('calculator-priced')).textContent).toBe(
      "Priced for 20–50 planned in Motir and 3–8 run on Motir's runner a month.",
    );
  });

  it('refuses both ranges at 0–0 once, under them, and sends nothing', async () => {
    renderView();
    await ask('0', '0', [/Balanced/]);
    expect(await screen.findByText(m.errors.rangeBothZero)).toBeTruthy();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(field(m.inputs.lowLabel).getAttribute('aria-invalid')).toBe('true');
    expect(field(m.inputs.lowLabel, 'run').getAttribute('aria-invalid')).toBe('true');
    expect(client.fetchCalculatorEstimate).not.toHaveBeenCalled();
  });

  it('refuses a bad run range on the run range alone', async () => {
    renderView();
    await ready();
    type(m.inputs.lowLabel, '10');
    type(m.inputs.highLabel, '20');
    type(m.inputs.lowLabel, '9', 'run');
    type(m.inputs.highLabel, '3', 'run');
    pick(/Balanced/);
    fireEvent.click(screen.getByRole('button', { name: m.inputs.submit }));
    const run = screen.getByTestId('calculator-run');
    expect(await within(run).findByText(m.errors.rangeOrder)).toBeTruthy();
    expect(within(screen.getByTestId('calculator-planned')).queryByRole('alert')).toBeNull();
    expect(client.fetchCalculatorEstimate).not.toHaveBeenCalled();
  });
});

describe('refusals before any request', () => {
  it.each([
    ['', '', m.errors.rangeEmpty],
    ['10', '', m.errors.rangeEmpty],
    ['abc', '5', m.errors.rangeInvalid],
    ['1.5', '5', m.errors.rangeInvalid],
    ['-3', '5', m.errors.rangeInvalid],
    ['50', '20', m.errors.rangeOrder],
  ])('refuses low=%j high=%j with its own sentence', async (low, high, sentence) => {
    renderView();
    await ask(low, high, [/Balanced/]);
    // The run range followed the planned one, so each range carries its own sentence.
    expect(await screen.findAllByText(sentence)).toHaveLength(2);
    expect(client.fetchCalculatorEstimate).not.toHaveBeenCalled();
    expect(screen.queryByTestId('calculator-credits')).toBeNull();
  });

  it('refuses no category, inline, and sends nothing', async () => {
    renderView();
    await ask('10', '20', []);
    expect(await screen.findByText(m.errors.categoryMissing)).toBeTruthy();
    expect(client.fetchCalculatorEstimate).not.toHaveBeenCalled();
  });
});

describe('the regular arm', () => {
  it.each([
    ['annual', 'billed annually · $2,400 / yr'],
    ['monthly', '$300 / mo'],
  ] as const)('prices Max ×2 from the catalog on %s', async (cadence, price) => {
    renderView({ cadence });
    await ask();
    expect((await screen.findByTestId('calculator-plan')).textContent).toContain('Max ×2');
    expect(screen.getByTestId('calculator-price').textContent).toBe(price);
    expect(screen.queryByTestId('calculator-larger')).toBeNull();
    expect(screen.queryByText(/Max ×2 plus/)).toBeNull();
  });

  it('prints the split the answer carries, the range and the caveat — no single figure', async () => {
    renderView();
    await ask();
    await screen.findByTestId('calculator-credits');
    expect(
      screen.getByText('The run is split evenly across Balanced and Flagship — 50% each.'),
    ).toBeTruthy();
    expect(screen.getByTestId('calculator-credits').textContent).toBe('11,000 – 44,000');
    expect(screen.getByText(m.result.estimateCaveat)).toBeTruthy();
    expect(screen.getByText(m.result.perOrg)).toBeTruthy();
  });

  it('words one category as carrying the whole estimate', async () => {
    client.fetchCalculatorEstimate.mockResolvedValue(
      answer(
        estimate({ split: { count: 1, categories: [{ key: 'balanced', weight: 1, models: [] }] } }),
      ),
    );
    renderView();
    await ask('1', '2', [/Balanced/]);
    expect(
      await screen.findByText('One category, so the whole run sits on Balanced.'),
    ).toBeTruthy();
  });

  it('prints a third each for three categories', async () => {
    client.fetchCalculatorEstimate.mockResolvedValue(
      answer(
        estimate({
          split: {
            count: 3,
            categories: ['economy', 'balanced', 'flagship'].map((key) => ({
              key,
              weight: 1 / 3,
              models: [],
            })),
          },
        }),
      ),
    );
    renderView();
    await ask('1', '2', [/Economy/, /Balanced/, /Flagship/]);
    expect(
      await screen.findByText(
        'The run is split evenly across Economy, Balanced, and Flagship — 33% each.',
      ),
    ).toBeTruthy();
  });

  it('prints the seat line as its own row, from the catalog, with no total', async () => {
    renderView();
    await ask();
    const seat = await screen.findByTestId('calculator-seat');
    expect(seat.textContent).toContain('Every AI plan includes 1 Motir seat at no charge.');
    expect(seat.textContent).toContain(
      `Further seats: $${BILLING_CATALOG.seatPlan.prices.annual.amountUsd} per user, per year.`,
    );
  });

  it('renders an open plan key by the answer’s own name and price, never a neighbour’s', async () => {
    client.fetchCalculatorEstimate.mockResolvedValue(
      answer(
        estimate({
          recommendation: { planKey: 'brand_new', planName: 'Brand New', monthlyPriceUsd: 77 },
        }),
      ),
    );
    renderView();
    await ask();
    const plan = await screen.findByTestId('calculator-plan');
    expect(plan.textContent).toContain('Brand New');
    expect(screen.getByTestId('calculator-price').textContent).toBe('$77 / mo');
    expect(plan.textContent).not.toContain('Max');
  });

  it('shows a top-up as the answer’s two ends, only where one is carried', async () => {
    renderView();
    await ask();
    await screen.findByTestId('calculator-credits');
    expect(screen.queryByTestId('calculator-topup')).toBeNull();

    cleanup();
    client.fetchCalculatorEstimate.mockResolvedValue(
      answer(
        estimate({
          topUp: {
            low: { units: 0, credits: 0, priceUsd: 0 },
            high: { units: 2, credits: 2_000, priceUsd: 10 },
          },
        }),
      ),
    );
    renderView();
    await ask();
    expect((await screen.findByTestId('calculator-topup')).textContent).toContain(
      '0 credits – 2,000 credits',
    );
  });

  it('names no plan on a top-up-only answer and says the seat comes with an AI plan', async () => {
    client.fetchCalculatorEstimate.mockResolvedValue(
      answer(
        estimate({
          recommendation: { planKey: null, planName: null, monthlyPriceUsd: 0 },
          topUp: {
            low: { units: 1, credits: 1_000, priceUsd: 5 },
            high: { units: 2, credits: 2_000, priceUsd: 10 },
          },
        }),
      ),
    );
    const handles = renderView();
    await ask();
    expect(await screen.findByText(m.result.topupOnly)).toBeTruthy();
    expect(screen.getByTestId('calculator-seat').textContent).toBe(m.seat.noPlan);
    expect(screen.queryByTestId('calculator-plan')).toBeNull();
    expect(screen.queryByRole('button', { name: m.result.goToPlan })).toBeNull();
    expect(handles.goToPlan).not.toHaveBeenCalled();
  });

  it('leads to the plans view with that plan, and starts nothing', async () => {
    const handles = renderView();
    await ask();
    fireEvent.click(await screen.findByRole('button', { name: m.result.goToPlan }));
    expect(handles.goToPlan).toHaveBeenCalledWith('max_x2');
    expect(client.fetchCalculatorEstimate).toHaveBeenCalledTimes(1);
  });
});

describe('the larger-pool arm — sold from the answer', () => {
  it('offers the catalog’s pool by its own name, price and pool, and no top-up line', async () => {
    client.fetchCalculatorEstimate.mockResolvedValue(answer(larger()));
    renderView({ cadence: 'monthly' });
    await ask();
    const block = await screen.findByTestId('calculator-larger');
    expect(block.textContent).toContain(m.result.largerPoolLabel);
    expect(block.textContent).toContain(SMALLEST.name);
    expect(within(block).getByTestId('calculator-larger-price').textContent).toContain(
      `$${SMALLEST.prices!.monthly.amountUsd.toLocaleString('en-US')}`,
    );
    expect(block.textContent).toContain(
      `${SMALLEST.allotment!.credits.toLocaleString('en-US')} credits`,
    );
    expect(block.textContent).toContain(m.result.largerPlanEstimate);
    // Exclusivity: nothing of the top-of-ladder world, and no trip to the plans view.
    expect(screen.queryByTestId('calculator-plan')).toBeNull();
    expect(screen.queryByTestId('calculator-topup')).toBeNull();
    expect(screen.queryByTestId('calculator-largest-topup')).toBeNull();
    expect(screen.queryByRole('button', { name: m.result.goToPlan })).toBeNull();
  });

  it('prints the pool’s own credits from the answer, beside its price (MOTIR-9262)', async () => {
    const pooled = larger();
    pooled.recommendation = { ...pooled.recommendation, poolCredits: 120_000 };
    client.fetchCalculatorEstimate.mockResolvedValue(answer(pooled));
    renderView();
    await ask();
    const pool = await screen.findByTestId('calculator-larger-pool');
    expect(pool.textContent).toBe('120,000 credits / mo');
    expect(screen.getByTestId('calculator-larger').contains(pool)).toBe(true);
  });

  it('falls back to the catalog pool for an answer that sends no poolCredits', async () => {
    client.fetchCalculatorEstimate.mockResolvedValue(answer(larger()));
    renderView();
    await ask();
    expect((await screen.findByTestId('calculator-larger-pool')).textContent).toBe(
      `${SMALLEST.allotment!.credits.toLocaleString('en-US')} credits / mo`,
    );
  });

  it.each(['annual', 'monthly'] as const)(
    'Choose starts Checkout for the pool’s %s price, here',
    async (cadence) => {
      client.fetchCalculatorEstimate.mockResolvedValue(answer(larger()));
      const handles = renderView({ cadence });
      await ask();
      fireEvent.click(await screen.findByRole('button', { name: `Choose ${SMALLEST.name}` }));
      expect(handles.checkout).toHaveBeenCalledTimes(1);
      expect(handles.checkout.mock.calls[0]![0]).toBe(SMALLEST.prices![cadence].priceLookupKey);
      expect(handles.goToPlan).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{ code: 'BILLING_POOL_AT_OR_BELOW_CEILING' }, 'atOrBelowCeiling'],
    [{ code: 'BILLING_INVALID_QUANTITY' }, 'quantity'],
    [{ code: 'BILLING_UNKNOWN_PRICE' }, 'notForSale'],
    [
      {
        code: 'MOTIR_AI_BAD_REQUEST',
        error: 'motir-ai rejected the request: plan_offer_expired: x',
      },
      'offerExpired',
    ],
  ] as const)('a refused checkout shows its own sentence on the offer: %j', async (body, key) => {
    client.fetchCalculatorEstimate.mockResolvedValue(answer(larger()));
    const handles = renderView();
    await ask();
    fireEvent.click(await screen.findByRole('button', { name: `Choose ${SMALLEST.name}` }));
    const onRefused = handles.checkout.mock.calls[0]![1];
    let handled = false;
    act(() => {
      handled = onRefused(body);
    });
    expect(handled).toBe(true);
    expect((await screen.findByTestId('calculator-larger-refused')).textContent).toBe(
      enMessages.billing.plans.larger.refused[key],
    );
  });

  it('leaves a refusal it does not know to the page’s own failure', async () => {
    client.fetchCalculatorEstimate.mockResolvedValue(answer(larger()));
    const handles = renderView();
    await ask();
    fireEvent.click(await screen.findByRole('button', { name: `Choose ${SMALLEST.name}` }));
    expect(handles.checkout.mock.calls[0]![1]({ code: 'SOMETHING_ELSE' })).toBe(false);
    expect(screen.queryByTestId('calculator-larger-refused')).toBeNull();
  });

  it('offers an org on a smaller live plan an upgrade, with the upgrade line, and no checkout', async () => {
    client.fetchCalculatorEstimate.mockResolvedValue(answer(larger()));
    const handles = renderView({ data: status({ tierKey: 'pro', active: true }) });
    await ask();
    const button = await screen.findByRole('button', { name: `Upgrade to ${SMALLEST.name}` });
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    const note = screen.getByText(m.result.upgradeNote);
    expect(note.textContent).not.toMatch(/\$\d/);
    expect(handles.checkout).not.toHaveBeenCalled();
  });

  it('shows the pool an org already holds as its current plan, with nothing to buy', async () => {
    client.fetchCalculatorEstimate.mockResolvedValue(answer(larger()));
    renderView({ data: status({ tierKey: SMALLEST.key, active: true }) });
    await ask();
    const button = await screen.findByRole('button', {
      name: enMessages.billing.plans.ctaCurrent,
    });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(m.result.upgradeNote)).toBeNull();
  });

  it('sells nothing to an org whose live pool is already larger', async () => {
    client.fetchCalculatorEstimate.mockResolvedValue(answer(larger()));
    renderView({ data: status({ tierKey: LARGEST.key, active: true }) });
    await ask();
    const block = await screen.findByTestId('calculator-larger');
    expect(within(block).queryByRole('button')).toBeNull();
  });

  it('disables the buy for a member who cannot manage billing, and says why', async () => {
    client.fetchCalculatorEstimate.mockResolvedValue(answer(larger()));
    renderView({ data: status({ canManage: false }) });
    await ask();
    const button = await screen.findByRole('button', { name: `Choose ${SMALLEST.name}` });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(enMessages.billing.plans.upgrade.disabledReason)).toBeTruthy();
  });

  it('has no upgrade line for an org with no paid plan', async () => {
    client.fetchCalculatorEstimate.mockResolvedValue(answer(larger()));
    renderView();
    await ask();
    await screen.findByTestId('calculator-larger');
    expect(screen.queryByText(m.result.upgradeNote)).toBeNull();
  });

  it('names a pool key this catalog cannot sell as the answer does, with no buy', async () => {
    client.fetchCalculatorEstimate.mockResolvedValue(answer(larger('pool_999k', 'Pool X')));
    renderView();
    await ask();
    const plan = await screen.findByTestId('calculator-plan');
    expect(plan.textContent).toContain('Pool X');
    expect(screen.getByTestId('calculator-price').textContent).toBe('$555 / mo');
    expect(screen.queryByTestId('calculator-larger')).toBeNull();
    expect(screen.getByTestId('calculator-seat').textContent).toContain(
      `includes ${INCLUDED_TRACKER_SEATS_PER_AI_PLAN} Motir seat`,
    );
  });
});

describe('above every pool — the largest pool plus top-ups', () => {
  it('offers the largest pool and says the rest is top-ups, from the answer’s top-up', async () => {
    client.fetchCalculatorEstimate.mockResolvedValue(answer(largest()));
    renderView({ cadence: 'monthly' });
    await ask();
    const block = await screen.findByTestId('calculator-larger');
    expect(block.textContent).toContain(m.result.largestPoolLabel);
    expect(block.textContent).toContain(
      `Your estimate is above our largest pool, so the answer is that pool — ${LARGEST.name} — with top-ups for the rest.`,
    );
    const excess = (LARGEST_HIGH - LARGEST.allotment!.credits).toLocaleString('en-US');
    expect(within(block).getByTestId('calculator-largest-topup').textContent).toBe(
      `The other ${excess} credits or so a month are covered by top-ups: 12 × 1,000 credits, about $60 a month.`,
    );
    expect(screen.getByRole('button', { name: `Choose ${LARGEST.name}` })).toBeTruthy();
    expect(screen.queryByTestId('calculator-topup')).toBeNull();
    expect(screen.queryByTestId('calculator-plan')).toBeNull();
  });
});

describe('above the ladder with no larger pool', () => {
  it('says so with the answer’s ceiling and shows the top-up range, in words the larger arm lacks', async () => {
    client.fetchCalculatorEstimate.mockResolvedValue(answer(above()));
    renderView();
    await ask();
    expect(
      await screen.findByText(
        "That is more than the largest regular plan's 60,000 credits a month, and no larger pool is available right now, so the excess is met with credit top-ups.",
      ),
    ).toBeTruthy();
    expect((await screen.findByTestId('calculator-plan')).textContent).toContain('Max ×2');
    expect(screen.getByTestId('calculator-topup').textContent).toContain(
      '1,000 credits – 101,000 credits',
    );
    expect(screen.queryByTestId('calculator-larger')).toBeNull();
  });

  it('shows the upgrade line when the held plan is below the plan named', async () => {
    client.fetchCalculatorEstimate.mockResolvedValue(answer(above()));
    renderView({ data: status({ tierKey: 'pro', active: true }) });
    await ask();
    expect(await screen.findByText(m.result.upgradeNote)).toBeTruthy();
  });

  it('shows no upgrade line to an org already on the plan the answer names', async () => {
    client.fetchCalculatorEstimate.mockResolvedValue(answer(above()));
    renderView({ data: status({ tierKey: 'max_x2', active: true }) });
    await ask();
    await screen.findByTestId('calculator-plan');
    expect(screen.queryByText(m.result.upgradeNote)).toBeNull();
  });
});

describe('the door’s other outcomes', () => {
  it('words unavailable and failed differently, with a retry that re-asks and no number', async () => {
    client.fetchCalculatorEstimate.mockResolvedValueOnce({ kind: 'unavailable' });
    renderView();
    await ask();
    expect(await screen.findByText(m.errors.unavailable)).toBeTruthy();
    expect(screen.queryByText(m.errors.failed)).toBeNull();
    expect(screen.queryByTestId('calculator-credits')).toBeNull();

    client.fetchCalculatorEstimate.mockResolvedValueOnce({ kind: 'failed' });
    fireEvent.click(screen.getByRole('button', { name: enMessages.billing.states.retry }));
    expect(await screen.findByText(m.errors.failed)).toBeTruthy();
    expect(screen.queryByText(m.errors.unavailable)).toBeNull();
    expect(client.fetchCalculatorEstimate).toHaveBeenCalledTimes(2);
  });

  it('renders a refusal that names the range on the range, with no estimate', async () => {
    client.fetchCalculatorEstimate.mockResolvedValue({
      kind: 'refused',
      field: 'runPerMonth.low',
    });
    renderView();
    await ask();
    const run = screen.getByTestId('calculator-run');
    expect(await within(run).findByText(m.errors.rangeInvalid)).toBeTruthy();
    expect(screen.queryByTestId('calculator-credits')).toBeNull();
  });

  it('renders a refusal that names the categories as the category cap', async () => {
    client.fetchCalculatorEstimate.mockResolvedValue({ kind: 'refused', field: 'categories' });
    renderView();
    await ask();
    expect(await screen.findByText(m.errors.tooManyCategories)).toBeTruthy();
  });

  it('renders a refusal with no field as the failed state, never the server’s words', async () => {
    client.fetchCalculatorEstimate.mockResolvedValue({ kind: 'refused', field: null });
    renderView();
    await ask();
    expect(await screen.findByText(m.errors.failed)).toBeTruthy();
  });

  it('renders an empty-category answer per category, with no figure', async () => {
    const empty: CalculatorEmptyCategoryDTO = {
      version: 2,
      kind: 'empty_category',
      categoryRuleVersion: 'rule-1',
      categories: ['economy'],
    };
    client.fetchCalculatorEstimate.mockResolvedValue(answer(empty));
    renderView();
    await ask();
    const result = await screen.findByTestId('calculator-result');
    await waitFor(() => expect(result.textContent).toContain(m.categories.empty));
    expect(result.textContent).toContain('Economy');
    expect(screen.queryByTestId('calculator-credits')).toBeNull();
    expect(screen.queryByText(m.errors.unavailable)).toBeNull();
  });
});

describe('editing clears, it does not re-ask', () => {
  it('returns to not-yet-asked on a range edit, keeping the inputs', async () => {
    renderView();
    await ask();
    await screen.findByTestId('calculator-credits');
    type(m.inputs.highLabel, '70');
    expect(screen.getByText(m.result.idle)).toBeTruthy();
    expect(screen.queryByTestId('calculator-credits')).toBeNull();
    expect(field(m.inputs.lowLabel).value).toBe('40');
    expect(client.fetchCalculatorEstimate).toHaveBeenCalledTimes(1);
  });

  it('clears on a category change and on a cadence change, asking nothing', async () => {
    const handles = renderView();
    await ask();
    await screen.findByTestId('calculator-credits');
    pick(/Economy/);
    expect(screen.getByText(m.result.idle)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: m.inputs.submit }));
    await screen.findByTestId('calculator-credits');
    fireEvent.click(screen.getByRole('button', { name: 'Monthly' }));
    expect(handles.onCadence).toHaveBeenCalledWith('monthly');
    expect(screen.getByText(m.result.idle)).toBeTruthy();
    expect(client.fetchCalculatorEstimate).toHaveBeenCalledTimes(2);
  });

  it('shows loading while asking, and a late answer never lands under newer inputs', async () => {
    let release: (o: CalculatorOutcome<CalculatorEstimateDTO>) => void = () => {};
    client.fetchCalculatorEstimate.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    renderView();
    await ask();
    expect(await screen.findByText(m.result.loading)).toBeTruthy();
    type(m.inputs.highLabel, '99');
    expect(screen.getByText(m.result.idle)).toBeTruthy();
    await act(async () => release(answer(estimate())));
    expect(screen.queryByTestId('calculator-credits')).toBeNull();
    expect(screen.getByText(m.result.idle)).toBeTruthy();
  });
});

describe('in 中文', () => {
  it('renders the same figures with no raw message key', async () => {
    const zh = (await import('@/messages/zh.json')).default as Record<string, unknown>;
    client.fetchCalculatorEstimate.mockResolvedValue(answer(larger()));
    render(
      <CalculatorView
        orgId="org1"
        orgName="Acme"
        data={status()}
        cadence="annual"
        onCadence={() => {}}
        back={() => {}}
        goToPlan={() => {}}
        checkout={() => {}}
        portal={() => {}}
        reload={async () => {}}
        redirecting={false}
      />,
      { locale: 'zh', messages: zh },
    );
    const planned = await screen.findByTestId('calculator-planned');
    fireEvent.change(within(planned).getByLabelText('下限'), { target: { value: '40' } });
    fireEvent.change(within(planned).getByLabelText('上限'), { target: { value: '60' } });
    fireEvent.click(await screen.findByRole('button', { name: /Balanced/ }));
    fireEvent.click(screen.getByRole('button', { name: '估算积分' }));
    const block = await screen.findByTestId('calculator-larger');
    expect(block.textContent).toContain('更大的积分池');
    expect(block.textContent).toContain(SMALLEST.name);
    expect(document.body.textContent).not.toMatch(/billing\.(calculator|plans)/);
  });
});
