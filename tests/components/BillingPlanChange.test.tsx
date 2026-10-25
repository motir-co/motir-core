// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import { ToastProvider } from '@/components/ui/Toast';
import { BILLING_CATALOG } from '@/lib/billing/catalog';
import type {
  BillingStatusDTO,
  DowngradePreviewDTO,
  PendingPlanChangeDTO,
  UpgradePreviewDTO,
} from '@/lib/dto/billing';
import type { CiEntitlementStateDTO } from '@/lib/dto/ciAllowance';
import { BillingClient } from '@/app/(authed)/settings/organization/billing/_components/BillingClient';

// MOTIR-8399 (story MOTIR-8387): an org on a paid AI plan changes it from the plan
// cards — a higher card upgrades now through a priced dialog, a lower one schedules
// a downgrade for the period end, and a scheduled downgrade shows on both cards.
// `fetch` is the external boundary stubbed here; every figure is the server's.

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

function onPro(pendingDowngrade: PendingPlanChangeDTO | null = null): BillingStatusDTO {
  const planTier = { key: 'pro', name: 'Pro', monthlyCreditAllotment: 15000 };
  return {
    organizationId: 'org1',
    access: { role: 'owner', canManageBilling: true },
    isMeta: false,
    internalBilling: false,
    search: { totalSpend: 0, monthSpend: 0 },
    agents: { spend: { machineMonthSpend: 0, storageMonthSpend: 0 }, hasPaidAiPlan: true },
    motir: { scaledTrackerSubscription: null, aiIncludedSeat: true },
    motirAi: {
      tier: planTier,
      balance: 1000,
      pendingDowngrade,
      subscription: {
        status: 'active',
        currentPeriodEnd: '2026-11-01T00:00:00.000Z',
        priceId: 'pro_pool_monthly',
        planTier,
      },
    },
    ci: CI,
    catalog: BILLING_CATALOG,
  };
}

const UPGRADE: UpgradePreviewDTO = {
  prorationDate: 1792238400,
  fromPlan: 'pro',
  toPlan: 'max',
  cadence: 'monthly',
  cadenceChange: null,
  amountDueCents: 4250,
  currency: 'usd',
  periodEnd: '2026-11-01T00:00:00.000Z',
  billingDaysLeft: 17,
  daysLeft: 17,
  creditWindowEnd: '2026-11-01T00:00:00.000Z',
  extraCredits: 8500,
  extraIndexAllowance: null,
  fromPool: 15000,
  fullPool: 30000,
  fullAllowance: null,
  toPriceCents: 15000,
  pendingDowngrade: null,
};

const DOWNGRADE: DowngradePreviewDTO = {
  fromPlan: 'pro',
  toPlan: 'standard',
  cadence: 'monthly',
  cadenceChange: null,
  effectiveDate: '2026-11-01T00:00:00.000Z',
  fromPool: 15000,
  fullPool: 2000,
  fullAllowance: null,
  toPriceCents: 2000,
  currency: 'usd',
  pendingDowngrade: null,
};

type Route = (body: Record<string, unknown>) => { status: number; body: unknown };

/** Answers GET …/billing with `statuses` in turn, and each plan-change path from `routes`. */
function stubFetch(statuses: BillingStatusDTO[], routes: Record<string, Route | Route[]> = {}) {
  let reads = 0;
  const calls: Record<string, number> = {};
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/billing')) {
      const body = statuses[Math.min(reads++, statuses.length - 1)];
      return new Response(JSON.stringify(body), { status: 200 });
    }
    const path = url.split('/billing/')[1]!;
    const route = routes[path];
    if (!route) return new Response('{}', { status: 500 });
    const n = (calls[path] = (calls[path] ?? 0) + 1);
    const handler = Array.isArray(route) ? route[Math.min(n - 1, route.length - 1)]! : route;
    const answer = handler(JSON.parse((init?.body as string) ?? '{}'));
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const ok =
  (body: unknown): Route =>
  () => ({ status: 200, body });
const refused =
  (reason: string, status = 400): Route =>
  () => ({ status, body: { code: 'BILLING_PLAN_CHANGE_REFUSED', reason, error: reason } });

async function openPlans(opts: { locale?: 'zh' } = {}) {
  render(
    <ToastProvider>
      <BillingClient orgId="org1" orgName="Acme" memberCount={3} />
    </ToastProvider>,
    opts.locale ? { locale: 'zh', messages: zhMessages as Record<string, unknown> } : undefined,
  );
  const label =
    opts.locale === 'zh'
      ? (zhMessages as { billing: { ai: { changePlan: string } } }).billing.ai.changePlan
      : /^(Choose a Motir AI plan|Change plan)$/;
  fireEvent.click(await screen.findByRole('button', { name: label }));
}

function card(name: string): HTMLElement {
  return screen
    .getAllByText(name, { selector: 'span' })
    .find((el) => el.className.includes('font-semibold'))!.parentElement!.parentElement!;
}

function posts(fetchMock: ReturnType<typeof stubFetch>, path: string): unknown[] {
  return fetchMock.mock.calls
    .filter(([u]) => u.endsWith(`/billing/${path}`))
    .map(([, init]) => JSON.parse(init?.body as string));
}

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

describe('the plan cards of an org on Pro', () => {
  it('offers an upgrade on the higher cards, a downgrade on the lower one, and nothing on its own', async () => {
    stubFetch([onPro()]);
    await openPlans();
    await screen.findByText('Motir AI — plans & subscription');

    for (const name of ['Max', 'Max ×2']) {
      const button = within(card(name)).getByRole('button', { name: `Upgrade to ${name}` });
      expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    }
    expect(
      within(card('Standard')).getByRole('button', { name: 'Downgrade to Standard' }),
    ).toBeTruthy();
    expect(within(card('Pro')).getByRole('button', { name: 'Current plan' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Choose / })).toBeNull();
    expect(screen.queryByTestId('plan-pending-downgrade')).toBeNull();
  });

  it('shows a scheduled downgrade on the current card and on the card it goes to', async () => {
    stubFetch([onPro({ planKey: 'standard', effectiveDate: '2026-11-01T00:00:00.000Z' })]);
    await openPlans();
    await screen.findByText('Motir AI — plans & subscription');

    expect(within(card('Pro')).getByTestId('plan-pending-downgrade').textContent).toBe(
      'Changes to Standard on Nov 1, 2026',
    );
    const scheduled = within(card('Standard')).getByRole('button', {
      name: 'Scheduled for Nov 1, 2026',
    }) as HTMLButtonElement;
    expect(scheduled.disabled).toBe(true);
  });
});

describe('the upgrade dialog', () => {
  it('draws the preview’s figures, confirms with its proration date, and reloads the page', async () => {
    const onMax: BillingStatusDTO = {
      ...onPro(),
      motirAi: {
        ...onPro().motirAi,
        tier: { key: 'max', name: 'Max', monthlyCreditAllotment: 30000 },
      },
    };
    const fetchMock = stubFetch([onPro(), onMax], {
      'upgrade/preview': ok(UPGRADE),
      upgrade: ok({
        status: 'upgraded',
        fromPlan: 'pro',
        toPlan: 'max',
        extraCredits: 8500,
        extraIndexAllowance: null,
        clearedPending: null,
      }),
    });
    await openPlans();
    fireEvent.click(await screen.findByRole('button', { name: 'Upgrade to Max' }));

    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('$42.50');
    expect(within(dialog).getByTestId('plan-change-switch').getAttribute('aria-label')).toBe(
      'Pro → Max',
    );
    expect(
      within(dialog).getByText('Covers 17 days left in this period, to Nov 1, 2026'),
    ).toBeTruthy();
    expect(within(dialog).getByText('+8,500 extra credits for the days left')).toBeTruthy();
    expect(within(dialog).queryByTestId('plan-change-credit-window')).toBeNull();
    expect(posts(fetchMock, 'upgrade/preview')).toEqual([{ toPlanKey: 'max' }]);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Upgrade now' }));
    expect((await screen.findByTestId('plan-change-success')).textContent).toBe(
      '+8,500 credits added',
    );
    expect(posts(fetchMock, 'upgrade')).toEqual([{ toPlanKey: 'max', prorationDate: 1792238400 }]);
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([u]) => u.endsWith('/billing'))).toHaveLength(2),
    );
  });

  it('on an annual plan, says the credits follow the monthly credit window', async () => {
    stubFetch([onPro()], {
      'upgrade/preview': ok({
        ...UPGRADE,
        cadence: 'annual',
        periodEnd: '2027-01-15T00:00:00.000Z',
        billingDaysLeft: 90,
        creditWindowEnd: '2026-11-15T00:00:00.000Z',
      }),
    });
    await openPlans();
    fireEvent.click(await screen.findByRole('button', { name: 'Upgrade to Max' }));
    expect((await screen.findByTestId('plan-change-credit-window')).textContent).toBe(
      'Credits follow your monthly credit window: 17 days left, to Nov 15, 2026. From Nov 15, 2026, 30,000 credits a month.',
    );
  });

  it('a declined payment keeps the confirm and offers the payment portal', async () => {
    stubFetch([onPro()], {
      'upgrade/preview': ok(UPGRADE),
      upgrade: refused('payment_failed', 402),
    });
    await openPlans();
    fireEvent.click(await screen.findByRole('button', { name: 'Upgrade to Max' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Upgrade now' }));

    expect(
      await within(dialog).findByText(
        "Your payment didn't go through. Update your card and try again.",
      ),
    ).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Manage plan & payment' })).toBeTruthy();
    expect(
      (within(dialog).getByRole('button', { name: 'Upgrade now' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('an expired preview re-prices and marks what changed, without charging', async () => {
    const fetchMock = stubFetch([onPro()], {
      'upgrade/preview': [
        ok(UPGRADE),
        ok({ ...UPGRADE, amountDueCents: 3900, billingDaysLeft: 16 }),
      ],
      upgrade: refused('preview_expired'),
    });
    await openPlans();
    fireEvent.click(await screen.findByRole('button', { name: 'Upgrade to Max' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Upgrade now' }));

    expect(
      await within(dialog).findByText(
        'The price changed since you opened this. Review and confirm again.',
      ),
    ).toBeTruthy();
    const marked = [...dialog.querySelectorAll('[data-changed]')].map((el) => el.textContent);
    expect(marked).toContain('$39.00');
    expect(posts(fetchMock, 'upgrade/preview')).toHaveLength(2);
    expect(screen.queryByTestId('plan-change-success')).toBeNull();
  });
});

describe('the downgrade dialog', () => {
  it('schedules the downgrade for the period end and says so', async () => {
    const fetchMock = stubFetch([onPro()], {
      'downgrade/preview': ok(DOWNGRADE),
      downgrade: ok({
        status: 'scheduled',
        fromPlan: 'pro',
        toPlan: 'standard',
        effectiveDate: '2026-11-01T00:00:00.000Z',
        replacedPending: null,
      }),
    });
    await openPlans();
    fireEvent.click(await screen.findByRole('button', { name: 'Downgrade to Standard' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      await within(dialog).findByText(
        'On Nov 1, 2026, when your current period ends. Nothing changes before then.',
      ),
    ).toBeTruthy();
    expect(within(dialog).getByText('Nothing. No refund for the current period.')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Schedule downgrade' }));
    expect((await screen.findByTestId('plan-change-success')).textContent).toBe(
      'You stay on Pro until Nov 1, 2026, then move to Standard.',
    );
    expect(posts(fetchMock, 'downgrade')).toEqual([{ toPlanKey: 'standard' }]);
  });

  it('says the change it replaces when another downgrade is already scheduled', async () => {
    stubFetch([onPro()], {
      'downgrade/preview': ok({
        ...DOWNGRADE,
        pendingDowngrade: { planKey: 'pro', effectiveDate: '2026-11-01T00:00:00.000Z' },
      }),
    });
    await openPlans();
    fireEvent.click(await screen.findByRole('button', { name: 'Downgrade to Standard' }));
    expect(
      await screen.findByText('This replaces your scheduled change to Pro on Nov 1, 2026.'),
    ).toBeTruthy();
  });
});

// MOTIR-9403: Host is the fifth regular card and changes plan through the same
// dialogs — upgraded to from Max ×2 or a held rung, downgraded from to Max ×2.
function onPlan(
  key: string,
  name: string,
  credits: number,
  pendingDowngrade: PendingPlanChangeDTO | null = null,
): BillingStatusDTO {
  const planTier = { key, name, monthlyCreditAllotment: credits };
  return {
    ...onPro(),
    motirAi: {
      tier: planTier,
      balance: 1000,
      pendingDowngrade,
      subscription: {
        status: 'active',
        currentPeriodEnd: '2026-11-01T00:00:00.000Z',
        priceId: `${key}_pool_monthly`,
        planTier,
      },
    },
  };
}

const TO_HOST: UpgradePreviewDTO = {
  ...UPGRADE,
  fromPlan: 'max_x2',
  toPlan: 'host',
  amountDueCents: 58065,
  billingDaysLeft: 15,
  daysLeft: 15,
  extraCredits: 116129,
  fromPool: 60000,
  fullPool: 300000,
  toPriceCents: 150000,
};

describe('Host in the plan-change flow', () => {
  it('an org on Max ×2 upgrades to Host through the dialog, posting toPlanKey host', async () => {
    const fetchMock = stubFetch([onPlan('max_x2', 'Max ×2', 60000)], {
      'upgrade/preview': ok(TO_HOST),
      upgrade: ok({
        status: 'upgraded',
        fromPlan: 'max_x2',
        toPlan: 'host',
        extraCredits: 116129,
        extraIndexAllowance: null,
        clearedPending: null,
      }),
    });
    await openPlans();
    fireEvent.click(await screen.findByRole('button', { name: 'Upgrade to Host' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('$580.65');
    expect(within(dialog).getByTestId('plan-change-switch').getAttribute('aria-label')).toBe(
      'Max ×2 → Host',
    );
    expect(posts(fetchMock, 'upgrade/preview')).toEqual([{ toPlanKey: 'host' }]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Upgrade now' }));
    await screen.findByTestId('plan-change-success');
    expect(posts(fetchMock, 'upgrade')).toEqual([{ toPlanKey: 'host', prorationDate: 1792238400 }]);
  });

  it('an org holding Pool 250,000 unfolds the regular plans and is offered Upgrade to Host', async () => {
    const fetchMock = stubFetch([onPlan('pool_250k', 'Pool 250,000', 250000)], {
      'upgrade/preview': ok({ ...TO_HOST, fromPlan: 'pool_250k', fromPool: 250000 }),
    });
    await openPlans();
    await screen.findByText('Motir AI — plans & subscription');
    fireEvent.click(screen.getByRole('button', { name: 'See all regular plans' }));
    const upgrade = within(card('Host')).getByRole('button', { name: 'Upgrade to Host' });
    fireEvent.click(upgrade);
    await screen.findByRole('dialog');
    expect(posts(fetchMock, 'upgrade/preview')).toEqual([{ toPlanKey: 'host' }]);
  });

  it('an org on Host sees the five-card row with Host current and downgrades to Max ×2', async () => {
    const fetchMock = stubFetch([onPlan('host', 'Host', 300000)], {
      'downgrade/preview': ok({
        ...DOWNGRADE,
        fromPlan: 'host',
        toPlan: 'max_x2',
        fromPool: 300000,
        fullPool: 60000,
        toPriceCents: 30000,
      }),
      downgrade: ok({
        status: 'scheduled',
        fromPlan: 'host',
        toPlan: 'max_x2',
        effectiveDate: '2026-11-01T00:00:00.000Z',
        replacedPending: null,
      }),
    });
    await openPlans();
    await screen.findByText('Motir AI — plans & subscription');
    expect(screen.queryByRole('button', { name: 'See all regular plans' })).toBeNull();
    expect(within(card('Host')).getByRole('button', { name: 'Current plan' })).toBeTruthy();
    for (const name of ['Standard', 'Pro', 'Max', 'Max ×2']) {
      expect(within(card(name)).getByRole('button', { name: `Downgrade to ${name}` })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole('button', { name: 'Downgrade to Max ×2' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Schedule downgrade' }));
    expect((await screen.findByTestId('plan-change-success')).textContent).toBe(
      'You stay on Host until Nov 1, 2026, then move to Max ×2.',
    );
    expect(posts(fetchMock, 'downgrade')).toEqual([{ toPlanKey: 'max_x2' }]);
  });

  it('a pending downgrade from Host shows on the Host card and on the Max ×2 card', async () => {
    stubFetch([
      onPlan('host', 'Host', 300000, {
        planKey: 'max_x2',
        effectiveDate: '2026-11-01T00:00:00.000Z',
      }),
    ]);
    await openPlans();
    await screen.findByText('Motir AI — plans & subscription');
    expect(within(card('Host')).getByTestId('plan-pending-downgrade').textContent).toBe(
      'Changes to Max ×2 on Nov 1, 2026',
    );
    const scheduled = within(card('Max ×2')).getByRole('button', {
      name: 'Scheduled for Nov 1, 2026',
    }) as HTMLButtonElement;
    expect(scheduled.disabled).toBe(true);
  });
});

describe('in zh', () => {
  it('renders the plan-change controls and the upgrade dialog with no raw keys or ICU', async () => {
    stubFetch([onPro()], { 'upgrade/preview': ok(UPGRADE) });
    await openPlans({ locale: 'zh' });
    const zh = zhMessages as unknown as {
      billing: { plans: { upgrade: { cta: string; confirm: string } } };
    };
    const cta = zh.billing.plans.upgrade.cta.replace('{plan}', 'Max');
    fireEvent.click(await screen.findByRole('button', { name: cta }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('button', { name: zh.billing.plans.upgrade.confirm });
    expect(dialog.textContent).not.toMatch(/[{}]|billing\.plans/);
  });
});
