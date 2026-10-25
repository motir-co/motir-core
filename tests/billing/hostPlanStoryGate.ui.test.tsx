// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import {
  BILLING_CATALOG,
  largerPoolPlans,
  maxMonthlyPlanCredits,
  type AiPlanCatalogEntry,
  type BillingCadence,
  type BillingCatalog,
} from '@/lib/billing/catalog';
import type { BillingStatusDTO, CalculatorEstimateDTO } from '@/lib/dto/billing';
import type { CiEntitlementStateDTO } from '@/lib/dto/ciAllowance';
import type { CalculatorOutcome } from '@/lib/billing/calculatorClient';
import { ENGINE_CAPTURE } from '../fixtures/calculatorEngineCapture';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import de from '@/messages/de.json';
import es from '@/messages/es.json';
import fr from '@/messages/fr.json';
import it_ from '@/messages/it.json';
import ja from '@/messages/ja.json';
import ko from '@/messages/ko.json';
import nl from '@/messages/nl.json';
import pl from '@/messages/pl.json';
import pt from '@/messages/pt.json';

// STORY MOTIR-9364's INTEGRATION GATE (MOTIR-9406), the rendered half. The catalog,
// services and operator bill are `hostPlanStoryGate.test.ts`; this file renders the
// two screens that read the catalog with Host in it:
//
//   - the Billing-view Calculator, which computes nothing and names only the plan
//     the engine's answer names. Whether Host is ever RECOMMENDED is motir-ai's to
//     decide; the claim here is narrower and exact — every recorded engine answer,
//     and an authored answer on each arm, renders the same text with Host in the
//     catalog as without it, and that text names no Host figure;
//   - the assembled plans view in every shipped locale: five paid cards, Host last,
//     its copy in that locale's own words, and the callout still on Max ×2.
//
// No band figure is typed except Host's own: the pre-Host render is the same answer
// over the catalog with the `host` entry removed. The boundaries stubbed are the
// calculator's client helper and `fetch` (the billing status read).

const client = vi.hoisted(() => ({
  fetchCalculatorCategories: vi.fn(),
  fetchCalculatorEstimate: vi.fn(),
}));
vi.mock('@/lib/billing/calculatorClient', () => client);

const { CalculatorView } =
  await import('@/app/(authed)/settings/organization/billing/_components/CalculatorView');
const { BillingClient } =
  await import('@/app/(authed)/settings/organization/billing/_components/BillingClient');

const LOCALES = { en, zh, de, es, fr, it: it_, ja, ko, nl, pl, pt } as const;
type Locale = keyof typeof LOCALES;

const entry = (key: string) => BILLING_CATALOG.aiPlans.find((p) => p.key === key)!;
const HOST = entry('host');
const WITHOUT_HOST: BillingCatalog = {
  ...BILLING_CATALOG,
  aiPlans: BILLING_CATALOG.aiPlans.filter((p) => p.key !== 'host'),
};
const LADDER = BILLING_CATALOG.aiPlans.filter((p) => p.band === 'ladder' && p.prices);
const TOP = LADDER.reduce((a, b) => (b.allotment!.credits > a.allotment!.credits ? b : a));
const POOLS = largerPoolPlans();
const CEILING = maxMonthlyPlanCredits();

const usd = (n: number) => `$${n.toLocaleString('en-US')}`;
/** Every way Host could show in a render: its name, its pool and its two prices. */
const HOST_MARKS = [
  /\bHost\b/,
  new RegExp(HOST.allotment!.credits.toLocaleString('en-US')),
  new RegExp(`\\${usd(HOST.prices!.monthly.amountUsd)}\\b`),
  new RegExp(`\\${usd(HOST.prices!.annual.amountUsd)}\\b`),
];

// ── The Calculator ─────────────────────────────────────────────────────────

const answer = <T,>(value: T): CalculatorOutcome<T> => ({ kind: 'answer', value });

const CATEGORIES = JSON.parse(ENGINE_CAPTURE.find((s) => s.name === 'categories')!.body);

type Range = { low: number; high: number };
/** A recorded estimate, read as the two-range answer the app now receives (MOTIR-9224). */
function recorded(name: string): CalculatorEstimateDTO {
  const sample = ENGINE_CAPTURE.find((s) => s.name === name)!;
  const { itemsPerMonth } = sample.request as { itemsPerMonth: Range };
  return {
    plannedPerMonth: itemsPerMonth,
    runPerMonth: itemsPerMonth,
    ...JSON.parse(sample.body),
  } as CalculatorEstimateDTO;
}
const RECORDED = ENGINE_CAPTURE.filter(
  (s) => s.status === 200 && JSON.parse(s.body).kind === 'estimate',
).map((s) => s.name);

/** An authored answer, its recommendation a shipped plan, on `outcome`'s arm. */
function authored(
  outcome: CalculatorEstimateDTO['ceiling']['outcome'],
  plan: AiPlanCatalogEntry,
  credits: Range,
  topUpUnits = 0,
): CalculatorEstimateDTO {
  const excess = Math.max(0, credits.high - CEILING);
  return {
    version: 2,
    kind: 'estimate',
    profilesVersion: 'profiles-1',
    categoryRuleVersion: 'rule-1',
    cadence: 'annual',
    plannedPerMonth: { low: 40, high: 60 },
    runPerMonth: { low: 40, high: 60 },
    credits,
    perItemCredits: { planning: 100, running: 200 },
    split: { count: 1, categories: [{ key: 'economy', weight: 1, models: ['glm-5.3-flash'] }] },
    recommendation: {
      planKey: plan.key,
      planName: plan.name,
      monthlyPriceUsd: plan.prices!.monthly.amountUsd,
    },
    topUp: {
      low: { units: 0, credits: 0, priceUsd: 0 },
      high: {
        units: topUpUnits,
        credits: topUpUnits * BILLING_CATALOG.creditTopup.unitCredits,
        priceUsd: topUpUnits * BILLING_CATALOG.creditTopup.unitAmountUsd,
      },
    },
    ceiling: { credits: CEILING, exceeded: excess > 0, excessCredits: excess, outcome },
  } as CalculatorEstimateDTO;
}

const SMALLEST = POOLS[0]!;
const LARGEST = POOLS[POOLS.length - 1]!;
const AUTHORED: [string, CalculatorEstimateDTO][] = [
  ['within_ladder', authored('within_ladder', TOP, { low: CEILING / 4, high: CEILING / 2 })],
  [
    'larger_pool',
    authored('larger_pool', SMALLEST, { low: CEILING + 1, high: SMALLEST.allotment!.credits }),
  ],
  [
    'largest_pool',
    authored(
      'largest_pool',
      LARGEST,
      { low: LARGEST.allotment!.credits, high: LARGEST.allotment!.credits + 5_000 },
      5,
    ),
  ],
  ['top_ups_only', authored('top_ups_only', TOP, { low: CEILING + 1, high: CEILING * 2 }, 61)],
];

function calcStatus(catalog: BillingCatalog): BillingStatusDTO {
  return {
    catalog,
    access: { canManageBilling: true },
    motirAi: {
      tier: { key: 'free', name: 'Free', monthlyCreditAllotment: 0 },
      balance: 0,
      pendingDowngrade: null,
      subscription: { status: null, currentPeriodEnd: null, priceId: null, planTier: null },
    },
  } as unknown as BillingStatusDTO;
}

/** Render the Calculator over `catalog`, ask it, and return the result card's text. */
async function resultText(
  value: CalculatorEstimateDTO,
  catalog: BillingCatalog,
  cadence: BillingCadence,
): Promise<string> {
  client.fetchCalculatorEstimate.mockResolvedValue(answer({ ...value, cadence }));
  render(
    <CalculatorView
      orgId="org1"
      orgName="Acme"
      data={calcStatus(catalog)}
      cadence={cadence}
      onCadence={() => {}}
      back={() => {}}
      goToPlan={() => {}}
      checkout={() => {}}
      portal={() => {}}
      reload={async () => {}}
      redirecting={false}
    />,
  );
  const m = en.billing.calculator;
  await screen.findByRole('button', { name: /Economy/ });
  const planned = within(screen.getByTestId('calculator-planned'));
  fireEvent.change(planned.getByLabelText(m.inputs.lowLabel), { target: { value: '2' } });
  fireEvent.change(planned.getByLabelText(m.inputs.highLabel), { target: { value: '6' } });
  fireEvent.click(screen.getByRole('button', { name: /Economy/ }));
  fireEvent.click(screen.getByRole('button', { name: m.inputs.submit }));
  await screen.findByTestId('calculator-credits');
  const text = screen.getByTestId('calculator-result').textContent ?? '';
  cleanup();
  return text;
}

describe('the Calculator never names Host for an answer that does not', () => {
  beforeEach(() => {
    client.fetchCalculatorCategories.mockReset().mockResolvedValue(answer(CATEGORIES));
    client.fetchCalculatorEstimate.mockReset();
  });
  afterEach(cleanup);

  const cases: [string, () => CalculatorEstimateDTO][] = [
    ...RECORDED.map((name): [string, () => CalculatorEstimateDTO] => [
      `recorded ${name}`,
      () => recorded(name),
    ]),
    ...AUTHORED.map(([arm, value]): [string, () => CalculatorEstimateDTO] => [
      `authored ${arm}`,
      () => value,
    ]),
  ];

  it('the capture holds the recorded estimates this gate reads', () => {
    expect(RECORDED.length).toBeGreaterThanOrEqual(5);
  });

  for (const [label, value] of cases) {
    for (const cadence of ['annual', 'monthly'] as const) {
      it(`${label}, ${cadence}: names its plan, no Host figure, and renders as without Host`, async () => {
        const v = value();
        const withHost = await resultText(v, BILLING_CATALOG, cadence);
        const withoutHost = await resultText(v, WITHOUT_HOST, cadence);
        expect(withHost).toContain(entry(v.recommendation!.planKey!).name);
        for (const mark of HOST_MARKS) expect(withHost, String(mark)).not.toMatch(mark);
        expect(withHost).toBe(withoutHost);
        if (v.ceiling.outcome === 'top_ups_only') {
          expect(withHost).toContain(CEILING.toLocaleString('en-US'));
        }
      });
    }
  }
});

// ── The plans view, in every shipped locale ────────────────────────────────

const CI: CiEntitlementStateDTO = {
  applicable: true,
  internal: false,
  organizationId: 'org1',
  periodStart: '2026-07-01T00:00:00.000Z',
  periodEnd: '2026-08-01T00:00:00.000Z',
  memberCount: 3,
  poolMinutes: 1800,
  floorApplied: false,
  consumedMinutes: 0,
  remainingMinutes: 1800,
  overageMinutes: 0,
  chargedCredits: 0,
  balance: 185,
  state: 'within_allowance',
};

function noPlan(): BillingStatusDTO {
  return {
    organizationId: 'org1',
    access: { role: 'owner', canManageBilling: true },
    isMeta: false,
    internalBilling: false,
    search: { totalSpend: 0, monthSpend: 0 },
    agents: { spend: { machineMonthSpend: 0, storageMonthSpend: 0 }, hasPaidAiPlan: false },
    motir: { scaledTrackerSubscription: null, aiIncludedSeat: false },
    motirAi: {
      tier: { key: 'free', name: 'Free', monthlyCreditAllotment: 300 },
      balance: 185,
      pendingDowngrade: null,
      subscription: { status: null, currentPeriodEnd: null, priceId: null, planTier: null },
    },
    ci: CI,
    catalog: BILLING_CATALOG,
  };
}

type HostCopy = { useCase: string; prev: string; features: string[] };
const hostCopy = (locale: Locale) =>
  (LOCALES[locale].billing.plans.tiers as unknown as Record<string, HostCopy>).host!;

async function openPlans(locale: Locale) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(noPlan()), { status: 200 })),
  );
  render(
    <ToastProvider>
      <BillingClient orgId="org1" orgName="Acme" memberCount={3} />
    </ToastProvider>,
    { locale, messages: LOCALES[locale] as unknown as Record<string, unknown> },
  );
  fireEvent.click(
    await screen.findByRole('button', { name: LOCALES[locale].billing.ai.choosePlan }),
  );
  await screen.findByRole('heading', { name: LOCALES[locale].billing.plans.title });
}

const cards = () =>
  Array.from(document.querySelector<HTMLElement>('div.snap-x')!.children) as HTMLElement[];
const nameOf = (card: HTMLElement) => card.querySelector('span.font-semibold')?.textContent;

describe('the plans view, in every shipped locale', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { href: 'http://localhost/settings/organization/billing', search: '' },
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const PAID = BILLING_CATALOG.aiPlans
    .filter((p) => p.key !== 'free' && p.prices && (p.band === 'ladder' || p.band === 'host'))
    .map((p) => p.name);

  for (const locale of Object.keys(LOCALES) as Locale[]) {
    it(`${locale}: five paid cards, Host last in its own words, the callout on Max ×2`, async () => {
      await openPlans(locale);
      expect(cards().map(nameOf)).toEqual(PAID);
      expect(PAID).toHaveLength(5);
      expect(PAID[PAID.length - 1]).toBe(HOST.name);
      expect(PAID[PAID.length - 2]).toBe(TOP.name);

      const host = cards()[cards().length - 1]!;
      const copy = hostCopy(locale);
      const text = host.textContent ?? '';
      expect(text).toContain(copy.useCase);
      expect(text).toContain(copy.prev);
      for (const feature of copy.features) expect(text).toContain(feature);

      if (locale !== 'en') {
        const base = hostCopy('en');
        for (const [mine, theirs] of [
          [copy.useCase, base.useCase],
          ...copy.features.map((f, i) => [f, base.features[i]!]),
        ] as [string, string][]) {
          if (mine !== theirs) expect(text, theirs).not.toContain(theirs);
        }
      }

      const page = document.body.textContent ?? '';
      const top = TOP.allotment!.credits;
      const fmt = (n: number) => new Intl.NumberFormat(locale).format(n);
      expect(page).toContain(fmt(top));
      // The callout names the ladder's top: the one sentence that quotes Max ×2's pool.
      const callout = LOCALES[locale].billing.plans.needMore.body;
      const lead = callout.slice(0, callout.indexOf('{')).trim();
      if (lead) {
        const node = screen.getByText(
          (_, el) => (el?.textContent ?? '').startsWith(lead) && el?.children.length === 0,
        );
        expect(node.textContent).toContain(fmt(top));
        expect(node.textContent).not.toContain(fmt(HOST.allotment!.credits));
      }
    });
  }

  it('every locale ships Host’s copy whole: a use case, a prev and two features, en’s placeholders', () => {
    const placeholders = (s: string) => [...s.matchAll(/\{(\w+)/g)].map((m) => m[1]).sort();
    const base = hostCopy('en');
    for (const locale of Object.keys(LOCALES) as Locale[]) {
      const copy = hostCopy(locale);
      expect(typeof copy.useCase === 'string' && copy.useCase.trim(), locale).toBeTruthy();
      expect(typeof copy.prev === 'string' && copy.prev.trim(), locale).toBeTruthy();
      expect(copy.features, locale).toHaveLength(2);
      for (const f of copy.features) expect(f.trim(), locale).not.toBe('');
      expect(placeholders(copy.useCase), locale).toEqual(placeholders(base.useCase));
      expect(placeholders(copy.prev), locale).toEqual(placeholders(base.prev));
      copy.features.forEach((f, i) =>
        expect(placeholders(f), locale).toEqual(placeholders(base.features[i]!)),
      );
    }
  });
});
