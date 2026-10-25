// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { BILLING_CATALOG, type AiPlanCatalogEntry } from '@/lib/billing/catalog';
import type { BillingStatusDTO } from '@/lib/dto/billing';
import type { CiEntitlementStateDTO } from '@/lib/dto/ciAllowance';
import {
  BillingClient,
  ladderLine,
} from '@/app/(authed)/settings/organization/billing/_components/BillingClient';
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

/**
 * STORY MOTIR-7594's INTEGRATION GATE (MOTIR-7600) — the plan cards, planning-led.
 *
 * Each code card tested its own half; this is where the real catalog meets the
 * real strings in every shipped locale and the assembled plans screen:
 *
 *   - the catalog figures are PINNED (5,000 / 15,000 / 30,000, Max ×2 60,000 on
 *     both cadences, one included tracker seat), so a re-pricing is a decision
 *     this file makes someone restate, never a drift;
 *   - the row is the four paid plans: no Free card (Free is the trial strip), no
 *     Enterprise card, no Contact sales anywhere in the DOM;
 *   - every card carries the included-seat line and the ladder line, at both
 *     cadences and in zh;
 *   - the free-trial strip, its spent form, and its absence for a paid org;
 *   - `ladderLine` on every arm, including the ones the shipped catalog cannot
 *     reach (a fractional multiple, a missing pool);
 *   - every `billing.plans` key en ships is present in all eleven locales, with
 *     the same placeholders, and none of the strings the story removed survives.
 *
 * The one boundary stubbed is `fetch` (the billing status read).
 */

const LOCALES = { en, zh, de, es, fr, it: it_, ja, ko, nl, pl, pt } as const;

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

function status(over: Partial<BillingStatusDTO['motirAi']> = {}): BillingStatusDTO {
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
      ...over,
    },
    ci: CI,
    catalog: BILLING_CATALOG,
  };
}

const onMax = (): Partial<BillingStatusDTO['motirAi']> => {
  const planTier = { key: 'max', name: 'Max', monthlyCreditAllotment: 30000 };
  return {
    tier: planTier,
    balance: 1000,
    subscription: {
      status: 'active',
      currentPeriodEnd: '2027-01-01T00:00:00.000Z',
      priceId: 'max_pool_annual',
      planTier,
    },
  };
};

async function openPlans(body: BillingStatusDTO, locale: 'en' | 'zh' = 'en') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  );
  render(
    <ToastProvider>
      <BillingClient orgId="org1" orgName="Acme" memberCount={3} />
    </ToastProvider>,
    locale === 'zh' ? { locale: 'zh', messages: zh as Record<string, unknown> } : undefined,
  );
  const door = new RegExp(
    `^(${[LOCALES[locale].billing.ai.choosePlan, LOCALES[locale].billing.ai.changePlan].join('|')})$`,
  );
  fireEvent.click(await screen.findByRole('button', { name: door }));
  await screen.findByRole('heading', { name: LOCALES[locale].billing.plans.title });
}

const row = () => document.querySelector<HTMLElement>('div.snap-x')!;
const cards = () => Array.from(row().children) as HTMLElement[];
const cardNamed = (name: string) =>
  cards().find((c) => c.querySelector('span.font-semibold')?.textContent === name)!;
const n = (v: number) => v.toLocaleString('en-US');
const entry = (key: string) => BILLING_CATALOG.aiPlans.find((p) => p.key === key)!;
// The row's five paid cards, Host last (MOTIR-9403, the Host design amendment).
const PAID = ['standard', 'pro', 'max', 'max_x2', 'host'].map(entry);

beforeEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { href: 'http://localhost/settings/organization/billing', search: '' },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the catalog figures, pinned', () => {
  it('Standard 5,000, Pro 15,000, Max 30,000, Max ×2 60,000, Host 300,000 a month, each with one tracker seat', () => {
    expect(PAID.map((p) => [p.key, p.allotment?.credits, p.allotment?.cadence])).toEqual([
      ['standard', 5000, 'monthly'],
      ['pro', 15000, 'monthly'],
      ['max', 30000, 'monthly'],
      ['max_x2', 60000, 'monthly'],
      ['host', 300000, 'monthly'],
    ]);
    expect(PAID.map((p) => p.includedTrackerSeats)).toEqual([1, 1, 1, 1, 1]);
    expect(entry('max_x2').prices).toMatchObject({
      monthly: { amountUsd: 300 },
      annual: { amountUsd: 2400 },
    });
    // The catalog keeps Free as the trial grant, and carries no price-less plan.
    expect(entry('free').allotment).toMatchObject({ credits: 300, cadence: 'one_time' });
    expect(BILLING_CATALOG.aiPlans.filter((p) => p.key !== 'free' && !p.prices)).toEqual([]);
  });
});

describe('the ladder line', () => {
  const t = ((key: string, values?: Record<string, unknown>) =>
    key === 'plans.ladder.first'
      ? 'FIRST'
      : `${String(values?.multiple)}× ${String(values?.plan)}`) as unknown as Parameters<
    typeof ladderLine
  >[2];
  const plan = (credits: number | null, name = 'P'): AiPlanCatalogEntry =>
    ({
      ...entry('pro'),
      name,
      allotment: credits === null ? null : { credits, cadence: 'monthly' },
    }) as AiPlanCatalogEntry;

  it('says the price per credit on the first rung, and the whole multiple of the rung below after', () => {
    expect(ladderLine(plan(5000), null, t)).toBe('FIRST');
    expect(ladderLine(plan(15000), plan(5000, 'Standard'), t)).toBe('3× Standard');
    expect(ladderLine(plan(60000), plan(30000, 'Max'), t)).toBe('2× Max');
  });

  it('says nothing for a fractional multiple or a missing pool — never a rounded figure', () => {
    expect(ladderLine(plan(25000), plan(10000), t)).toBeNull();
    expect(ladderLine(plan(null), plan(10000), t)).toBeNull();
    expect(ladderLine(plan(10000), plan(null), t)).toBeNull();
  });
});

describe('the assembled row', () => {
  for (const cadence of ['Annual', 'Monthly'] as const) {
    it(`${cadence}: five paid cards with pools, ladder and seat lines; no Free, no Enterprise`, async () => {
      await openPlans(status());
      fireEvent.click(screen.getByRole('button', { name: cadence, exact: true } as never));

      expect(cards().map((c) => c.querySelector('span.font-semibold')?.textContent)).toEqual(
        PAID.map((p) => p.name),
      );
      const ladders = cards().map((c) => within(c).getByTestId('plan-ladder').textContent ?? '');
      expect(ladders).toEqual([
        'Same price per credit on every plan',
        '3× Standard’s credits · same price per credit',
        '2× Pro’s credits · same price per credit',
        '2× Max’s credits · same price per credit',
        '5× Max ×2’s credits · same price per credit',
      ]);
      for (const plan of PAID) {
        const c = within(cardNamed(plan.name));
        expect(c.getByText(`${n(plan.allotment!.credits)} credits / mo`)).toBeTruthy();
        expect(c.getByTestId('plan-included-seat').textContent).toBe(
          '+ 1 Motir seat · work items uncapped',
        );
      }
      const maxX2 = within(cardNamed('Max ×2'));
      if (cadence === 'Annual') {
        expect(maxX2.getByText('$200 / mo')).toBeTruthy();
        expect(maxX2.getByText('billed annually · $2,400 / yr')).toBeTruthy();
      } else {
        expect(maxX2.getByText('$300 / mo')).toBeTruthy();
      }

      // The callout still names the ladder's top, Max ×2, never Host (MOTIR-9403).
      expect(
        screen.getByText(/If your organization uses more than Max ×2's 60,000 credits a month/),
      ).toBeTruthy();

      const page = document.body.textContent ?? '';
      expect(page).not.toMatch(/Enterprise|Contact sales|Custom credit pool/);
      expect(screen.queryByText('No Motir seat · 250-item cap')).toBeNull();
      expect(page).not.toMatch(/heavy agent work/i);
    });
  }

  it('renders the same row in zh, with the zh ladder and seat lines', async () => {
    await openPlans(status(), 'zh');
    expect(cards()).toHaveLength(5);
    expect(within(cardNamed('Pro')).getByTestId('plan-ladder').textContent).toBe(
      'Standard 的 3 倍额度 · 额度单价相同',
    );
    for (const c of cards()) {
      expect(within(c).getByTestId('plan-included-seat').textContent).not.toMatch(/[{}]/);
    }
  });
});

describe('the free-trial strip', () => {
  it('says how much of the one-time grant is left, with the trial note', async () => {
    await openPlans(status());
    const strip = screen.getByTestId('plan-free-trial');
    expect(within(strip).getByText('Free trial')).toBeTruthy();
    expect(strip.textContent).toContain('185 of 300 trial credits left · one-time.');
    expect(strip.textContent).toContain(en.billing.trial.note);
  });

  it('says the grant is spent once nothing is left', async () => {
    await openPlans(status({ balance: -3 }));
    const strip = screen.getByTestId('plan-free-trial');
    expect(within(strip).getByText('Free trial used')).toBeTruthy();
    expect(strip.textContent).toContain(
      'All 300 trial credits are spent. Pick a monthly Motir AI plan to keep planning.',
    );
  });

  it('is absent for an org on a paid plan, which sees its current-plan strip instead', async () => {
    await openPlans(status(onMax()));
    expect(screen.queryByTestId('plan-free-trial')).toBeNull();
    expect(screen.getByText(/30,000 credits \/ mo · 1,000 left/)).toBeTruthy();
    expect(within(cardNamed('Max')).getByRole('button', { name: 'Current plan' })).toBeTruthy();
  });
});

describe('the strings, in every shipped locale', () => {
  type Tree = { [k: string]: string | string[] | Tree };
  const flat = (t: Tree, prefix = ''): Record<string, string> =>
    Object.entries(t).reduce<Record<string, string>>((out, [k, v]) => {
      const key = prefix ? `${prefix}.${k}` : k;
      if (typeof v === 'string') out[key] = v;
      else if (Array.isArray(v)) v.forEach((s, i) => (out[`${key}.${i}`] = s));
      else Object.assign(out, flat(v, key));
      return out;
    }, {});
  const placeholders = (s: string) => [...s.matchAll(/\{(\w+)/g)].map((m) => m[1]).sort();
  const enPlans = flat(en.billing.plans as unknown as Tree, 'billing.plans');

  it('every billing.plans key en ships exists in all eleven locales, with the same placeholders', () => {
    const problems: string[] = [];
    for (const [locale, messages] of Object.entries(LOCALES)) {
      const theirs = flat(messages.billing.plans as unknown as Tree, 'billing.plans');
      for (const [key, value] of Object.entries(enPlans)) {
        if (!(key in theirs)) problems.push(`${locale}: missing ${key}`);
        else if (placeholders(theirs[key]!).join() !== placeholders(value).join())
          problems.push(`${locale}: ${key} placeholders differ`);
      }
      for (const key of Object.keys(theirs)) {
        if (!(key in enPlans)) problems.push(`${locale}: stray ${key}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('the new keys are there, and none of the removed ones survives in any locale', () => {
    for (const key of [
      'billing.plans.ladder.first',
      'billing.plans.ladder.multiple',
      'billing.plans.trial.pill',
      'billing.plans.trial.pillUsed',
      'billing.plans.trial.left',
      'billing.plans.trial.spent',
      'billing.plans.trial.pickPlan',
    ]) {
      expect(enPlans[key], key).toBeTruthy();
    }
    for (const messages of Object.values(LOCALES)) {
      const billing = messages.billing as Record<string, unknown>;
      const plans = billing.plans as Record<string, unknown>;
      expect(billing.contactSales).toBeUndefined();
      for (const gone of ['freePrice', 'customPrice', 'customPool', 'seatNone', 'seatCustom']) {
        expect(plans[gone], gone).toBeUndefined();
      }
      const tiers = plans.tiers as Record<string, unknown>;
      expect(Object.keys(tiers).sort()).toEqual(['host', 'max', 'max_x2', 'pro', 'standard']);
    }
  });
});
