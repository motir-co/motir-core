// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render, enMessages } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import { ToastProvider } from '@/components/ui/Toast';
import { BILLING_CATALOG } from '@/lib/billing/catalog';
import type { BillingStatusDTO } from '@/lib/dto/billing';
import type { CiEntitlementStateDTO } from '@/lib/dto/ciAllowance';
import { BillingClient } from '@/app/(authed)/settings/organization/billing/_components/BillingClient';

// MOTIR-9403 (story MOTIR-9364): Host is the last card of the plan row, after
// Max ×2. It is sold on both cadences from the catalog, carries its own copy and
// ladder line, and is never the recommended or the estimate-marked plan.

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

function stubFetch(body: BillingStatusDTO) {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith('/billing')) return new Response(JSON.stringify(body), { status: 200 });
    if (url.endsWith('/billing/enterprise-request')) return new Response('null', { status: 200 });
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

describe('the Host plan card', () => {
  it('Annual: renders last with 300,000 credits, $1,000 a month billed $12,000 a year, and checks out the annual key', async () => {
    const fetchMock = await openPlans(status());
    await screen.findByText('Motir AI — plans & subscription');
    expect(cardHeaders().map((el) => el.textContent)).toEqual([
      'Standard',
      'Pro',
      'Max',
      'Max ×2',
      'Host',
    ]);

    const host = within(card('Host'));
    expect(host.getByText('$1,000 / mo')).toBeTruthy();
    expect(host.getByText('billed annually · $12,000 / yr')).toBeTruthy();
    expect(host.getByText('Save $6,000/yr')).toBeTruthy();
    expect(host.getByText('300,000 credits / mo')).toBeTruthy();

    fireEvent.click(host.getByRole('button', { name: 'Choose Host' }));
    await waitFor(() => expect(hrefSetter).toHaveBeenCalled());
    expect(checkoutBody(fetchMock)).toEqual({ priceLookupKey: 'host_pool_annual' });
  });

  it('Monthly: renders $1,500 a month and checks out the monthly key', async () => {
    const fetchMock = await openPlans(status());
    await screen.findByText('Motir AI — plans & subscription');
    fireEvent.click(screen.getByRole('button', { name: 'Monthly' }));

    const host = within(card('Host'));
    expect(host.getByText('$1,500 / mo')).toBeTruthy();
    expect(host.getByText('300,000 credits / mo')).toBeTruthy();
    fireEvent.click(host.getByRole('button', { name: 'Choose Host' }));
    await waitFor(() => expect(hrefSetter).toHaveBeenCalled());
    expect(checkoutBody(fetchMock)).toEqual({ priceLookupKey: 'host_pool_monthly' });
  });

  it('carries its use case, the cumulative lead, both features, the ladder line and the seat line', async () => {
    await openPlans(status());
    await screen.findByText('Motir AI — plans & subscription');
    const el = card('Host');
    const host = within(el);
    expect(host.getByText('Motir at fleet scale, on AWS accounts of your own.')).toBeTruthy();
    expect(host.getByText('Everything in Max ×2, plus')).toBeTruthy();
    expect(host.getByText('Motir runs your project autonomously')).toBeTruthy();
    expect(
      host.getByText('Dedicated pools for CI runners, agent runs, the indexer and hosted agents'),
    ).toBeTruthy();
    expect(host.getByTestId('plan-ladder').textContent).toBe(
      '5× Max ×2’s credits · same price per credit',
    );
    expect(host.getByTestId('plan-included-seat').textContent).toContain('1 Motir seat');
  });

  it('is never the recommended or the marked plan', async () => {
    await openPlans(status());
    await screen.findByText('Motir AI — plans & subscription');
    const el = card('Host');
    expect(within(el).queryByText('Recommended')).toBeNull();
    expect(within(el).queryByText('Matches your estimate')).toBeNull();
    expect(el.getAttribute('data-marked')).toBeNull();
    expect(within(el).queryByRole('button', { name: 'Upgrade to Host' })).toBeNull();
  });

  it('a viewer without manageBilling reaches no Host card and sends nothing', async () => {
    const fetchMock = stubFetch(status({ access: { role: 'admin', canManageBilling: false } }));
    render(
      <ToastProvider>
        <BillingClient orgId="org1" orgName="Acme" memberCount={3} />
      </ToastProvider>,
    );
    await screen.findByText('Billing & plans');
    expect(screen.queryByRole('button', { name: /Choose a Motir AI plan|Change plan/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Choose Host' })).toBeNull();
    expect(checkoutBody(fetchMock)).toBeUndefined();
  });

  it('renders its copy in zh with no raw key or ICU left', async () => {
    stubFetch(status());
    render(
      <ToastProvider>
        <BillingClient orgId="org1" orgName="Acme" memberCount={3} />
      </ToastProvider>,
      { locale: 'zh', messages: zhMessages as Record<string, unknown> },
    );
    const zhPlans = (zhMessages as { billing: { ai: { choosePlan: string } } }).billing.ai
      .choosePlan;
    fireEvent.click(await screen.findByRole('button', { name: zhPlans }));
    const host = within(card('Host'));
    expect(host.getByText('在你自己的 AWS 账户上，以集群规模运行 Motir。')).toBeTruthy();
    expect(host.getByText('包含 Max ×2 的全部，另加')).toBeTruthy();
    expect(host.getByText('Motir 自主推进你的项目')).toBeTruthy();
    expect(host.getByRole('button', { name: '选择 Host' })).toBeTruthy();
    expect(card('Host').textContent).not.toMatch(/[{}]|plans\.tiers/);
    expect(enMessages).toBeTruthy();
  });
});
