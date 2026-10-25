// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render, enMessages } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import { ToastProvider } from '@/components/ui/Toast';
import { BILLING_CATALOG, type BillingCatalog } from '@/lib/billing/catalog';
import type { BillingStatusDTO } from '@/lib/dto/billing';
import type { CiEntitlementStateDTO } from '@/lib/dto/ciAllowance';
import { BillingClient } from '@/app/(authed)/settings/organization/billing/_components/BillingClient';

// MOTIR-8394 (story MOTIR-8379): the Motir AI plan cards offer Max ×2 on both
// cadences as a plan of its own, every paid card states its included tracker seat
// from the catalog, and an org that already holds a live AI plan is offered no
// checkout on any card (the upgrade path owns that slot).

const hrefSetter = vi.fn();

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

function status(over: Partial<BillingStatusDTO> = {}): BillingStatusDTO {
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
    ...over,
  };
}

function onPlan(key: string, name: string, priceId: string): Partial<BillingStatusDTO> {
  const planTier = { key, name, monthlyCreditAllotment: 30000 };
  return {
    motirAi: {
      tier: planTier,
      balance: 1000,
      pendingDowngrade: null,
      subscription: {
        status: 'active',
        currentPeriodEnd: '2027-01-01T00:00:00.000Z',
        priceId,
        planTier,
      },
    },
  };
}

function stubFetch(body: BillingStatusDTO) {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith('/billing')) return new Response(JSON.stringify(body), { status: 200 });
    return new Response(JSON.stringify({ url: 'https://stripe.test/checkout/x' }), {
      status: 200,
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function openPlans(body: BillingStatusDTO) {
  const fetchMock = stubFetch(body);
  render(
    <ToastProvider>
      <BillingClient orgId="org1" orgName="Acme" memberCount={3} />
    </ToastProvider>,
  );
  fireEvent.click(
    await screen.findByRole('button', { name: /^(Choose a Motir AI plan|Change plan)$/ }),
  );
  return fetchMock;
}

/** The card element whose header carries `name`. */
function card(name: string): HTMLElement {
  return cardHeaders().find((el) => el.textContent === name)!.parentElement!.parentElement!;
}

/** Each plan card's name, in render order (the header span, not a price or pill). */
function cardHeaders(): HTMLElement[] {
  return screen
    .getAllByText(/^(Free|Standard|Pro|Max|Max ×2|Host)$/, { selector: 'span' })
    .filter((el) => el.className.includes('font-semibold'));
}

function checkoutBody(fetchMock: ReturnType<typeof stubFetch>): unknown {
  const call = fetchMock.mock.calls.find(([u]) => u.endsWith('/checkout'));
  return call ? JSON.parse(call[1]?.body as string) : undefined;
}

beforeEach(() => {
  hrefSetter.mockClear();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      get href() {
        return 'http://localhost/settings/organization/billing';
      },
      set href(v: string) {
        hrefSetter(v);
      },
      search: '',
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the Max ×2 plan card', () => {
  it('Annual: renders after Max with 60,000 credits and $2,400 a year, and checks out the annual key', async () => {
    const fetchMock = await openPlans(status());
    await screen.findByText('Motir AI — plans & subscription');

    const names = cardHeaders().map((el) => el.textContent);
    // Free is the trial grant, not a card (MOTIR-7598).
    // Host follows Max ×2 (MOTIR-9403).
    expect(names).toEqual(['Standard', 'Pro', 'Max', 'Max ×2', 'Host']);

    const maxX2 = within(card('Max ×2'));
    expect(maxX2.getByText('60,000 credits / mo')).toBeTruthy();
    expect(maxX2.getByText('billed annually · $2,400 / yr')).toBeTruthy();

    fireEvent.click(maxX2.getByRole('button', { name: 'Choose Max ×2' }));
    await waitFor(() => expect(hrefSetter).toHaveBeenCalled());
    expect(checkoutBody(fetchMock)).toEqual({ priceLookupKey: 'max_x2_pool_annual' });
  });

  it('Monthly: renders $300 a month and checks out the monthly key', async () => {
    const fetchMock = await openPlans(status());
    await screen.findByText('Motir AI — plans & subscription');
    fireEvent.click(screen.getByRole('button', { name: 'Monthly' }));

    const maxX2 = within(card('Max ×2'));
    expect(maxX2.getByText('$300 / mo')).toBeTruthy();
    expect(maxX2.getByText('60,000 credits / mo')).toBeTruthy();
    fireEvent.click(maxX2.getByRole('button', { name: 'Choose Max ×2' }));
    await waitFor(() => expect(hrefSetter).toHaveBeenCalled());
    expect(checkoutBody(fetchMock)).toEqual({ priceLookupKey: 'max_x2_pool_monthly' });
  });

  it('plain Max still checks out its own key', async () => {
    const fetchMock = await openPlans(status());
    await screen.findByText('Motir AI — plans & subscription');
    fireEvent.click(within(card('Max')).getByRole('button', { name: 'Choose Max' }));
    await waitFor(() => expect(hrefSetter).toHaveBeenCalled());
    expect(checkoutBody(fetchMock)).toEqual({ priceLookupKey: 'max_pool_annual' });
  });

  it('a viewer without manageBilling reaches no plan card and sends nothing', async () => {
    const fetchMock = stubFetch(status({ access: { role: 'admin', canManageBilling: false } }));
    render(
      <ToastProvider>
        <BillingClient orgId="org1" orgName="Acme" memberCount={3} />
      </ToastProvider>,
    );
    await screen.findByText('Billing & plans');
    expect(screen.queryByRole('button', { name: /Choose a Motir AI plan|Change plan/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Choose Max ×2' })).toBeNull();
    expect(checkoutBody(fetchMock)).toBeUndefined();
  });
});

describe('an org that already holds a live AI plan', () => {
  it('sees no checkout button on any plan card, only the plan-change controls', async () => {
    await openPlans(status(onPlan('standard', 'Standard', 'standard_pool_annual')));
    await screen.findByText('Motir AI — plans & subscription');
    expect(screen.queryByRole('button', { name: /^Choose / })).toBeNull();
    // MOTIR-8399: the upgrade path now owns the slot the checkout left.
    expect(within(card('Pro')).getByRole('button', { name: 'Upgrade to Pro' })).toBeTruthy();
  });

  it('on Max ×2, sees the Max ×2 card as its current plan', async () => {
    await openPlans(status(onPlan('max_x2', 'Max ×2', 'max_x2_pool_monthly')));
    await screen.findByText('Motir AI — plans & subscription');
    expect(within(card('Max ×2')).getByRole('button', { name: 'Current plan' })).toBeTruthy();
    // The one plan above Max ×2 is Host (MOTIR-9403): no checkout, one upgrade.
    expect(screen.queryByRole('button', { name: /^Choose / })).toBeNull();
    expect(
      screen.getAllByRole('button', { name: /^Upgrade to / }).map((b) => b.textContent),
    ).toEqual(['Upgrade to Host']);
    expect(within(card('Max')).getByRole('button', { name: 'Downgrade to Max' })).toBeTruthy();
  });
});

describe('the included-seat line', () => {
  it('shows on Standard, Pro, Max and Max ×2 from the catalog count, and there is no Free card', async () => {
    await openPlans(status());
    await screen.findByText('Motir AI — plans & subscription');
    for (const name of ['Standard', 'Pro', 'Max', 'Max ×2']) {
      expect(within(card(name)).getByTestId('plan-included-seat').textContent).toContain(
        '1 Motir seat',
      );
    }
    expect(cardHeaders().map((el) => el.textContent)).not.toContain('Free');
  });

  it('follows the catalog count, never a typed 1', async () => {
    const catalog: BillingCatalog = {
      ...BILLING_CATALOG,
      aiPlans: BILLING_CATALOG.aiPlans.map((p) =>
        p.key === 'max_x2' ? { ...p, includedTrackerSeats: 2 } : p,
      ),
    };
    await openPlans(status({ catalog }));
    await screen.findByText('Motir AI — plans & subscription');
    expect(within(card('Max ×2')).getByTestId('plan-included-seat').textContent).toContain(
      '2 Motir seats',
    );
  });

  it('no plan card text outside the seat line names a seat, a user or a per-head price', async () => {
    await openPlans(status());
    await screen.findByText('Motir AI — plans & subscription');
    for (const name of ['Standard', 'Pro', 'Max', 'Max ×2']) {
      const el = card(name).cloneNode(true) as HTMLElement;
      el.querySelector('[data-testid="plan-included-seat"]')?.remove();
      expect(el.textContent).not.toMatch(/seat|user|per head|per person/i);
    }
  });

  it('renders in zh with the other-only plural for 1 and 2, with no raw ICU left', async () => {
    for (const seats of [1, 2]) {
      const catalog: BillingCatalog = {
        ...BILLING_CATALOG,
        aiPlans: BILLING_CATALOG.aiPlans.map((p) =>
          p.key === 'max_x2' ? { ...p, includedTrackerSeats: seats } : p,
        ),
      };
      stubFetch(status({ catalog }));
      render(
        <ToastProvider>
          <BillingClient orgId="org1" orgName="Acme" memberCount={3} />
        </ToastProvider>,
        { locale: 'zh', messages: zhMessages as Record<string, unknown> },
      );
      const zhPlans = (zhMessages as { billing: { ai: { choosePlan: string } } }).billing.ai
        .choosePlan;
      fireEvent.click(await screen.findByRole('button', { name: zhPlans }));
      const line = within(card('Max ×2')).getByTestId('plan-included-seat').textContent ?? '';
      expect(line).toContain(`${seats} 个 Motir 席位`);
      expect(line).not.toMatch(/[{}]|plural/);
      cleanup();
    }
    expect(enMessages).toBeTruthy();
  });
});
