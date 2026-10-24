import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { RawSubscriptionResponse, RawUsageResponse } from '@/lib/ai/types';
import type { CheckoutSessionOutcome } from '@/lib/ai/motirAiClient';
import type { ScaledTrackerSubscription } from '@/lib/billing/scaledTrackerState';
import { adminDb } from './helpers/adminDb';

// Service test for billingService (Subtask 8.1.6) — the open-core billing
// boundary. The motir-ai client is the external HTTP leaf, so it's mocked (the
// one legitimate boundary mock, like a network call); the org + memberships are
// seeded through the REAL services against the real Postgres (the no-mocks rule
// otherwise). This proves the GATES: the cloud-only flag, the 6.10.4 org gate
// (404 non-member), and the ADR §7 gate (view AND mutate = owner/admin, the
// `manageBilling` capability — amended 2026-09-25 by MOTIR-6305; a plain member
// has neither) — plus the DTO shape and the Checkout/Portal forwarding.
const getOrgUsageMock = vi.fn<(q: unknown) => Promise<RawUsageResponse>>();
const getOrgSubscriptionMock = vi.fn<(q: unknown) => Promise<RawSubscriptionResponse>>();
const createCheckoutSessionMock = vi.fn<(i: unknown) => Promise<CheckoutSessionOutcome>>();
const createPortalSessionMock = vi.fn<(i: unknown) => Promise<{ url: string }>>();
const getPendingPlanChangeMock =
  vi.fn<
    (q: unknown) => Promise<{ pendingDowngrade: { planKey: string; effectiveDate: string } | null }>
  >();
const setSeatQuantityMock =
  vi.fn<(i: { coreOrganizationId: string; quantity: number }) => Promise<unknown>>();
vi.mock('@/lib/ai/motirAiClient', () => ({
  getOrgUsage: (q: unknown) => getOrgUsageMock(q),
  getOrgSubscription: (q: unknown) => getOrgSubscriptionMock(q),
  getPendingPlanChange: (q: unknown) => getPendingPlanChangeMock(q),
  createCheckoutSession: (i: unknown) => createCheckoutSessionMock(i),
  createPortalSession: (i: unknown) => createPortalSessionMock(i),
  setSeatQuantity: (i: { coreOrganizationId: string; quantity: number }) => setSeatQuantityMock(i),
}));
// Silence the post-commit seat-sync ENQUEUE that org-membership writes now fire
// (8.1.12) — this suite drives membership through the real services (which would
// otherwise hit Inngest with MOTIR_CLOUD on); the enqueue→job wiring is covered
// in billing-seat-sync.test.ts, and the sync BEHAVIOUR is tested directly below.
vi.mock('@/lib/billing/seatSync', () => ({
  enqueueScaledTrackerSeatSync: vi.fn(),
}));

const { billingService } = await import('@/lib/services/billingService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { organizationsService } = await import('@/lib/services/organizationsService');
const { billingPropagationService } = await import('@/lib/services/billingPropagationService');
const { ciPeriodUsageRepository } = await import('@/lib/repositories/ciPeriodUsageRepository');
const { withSystemContext } = await import('@/lib/workspaces/context');
const { periodStartFor, periodEndFor } = await import('@/lib/ciMetering/period');
const { createTestUser } = await import('./fixtures/userFixtures');
const { truncateAuthTables } = await import('./helpers/db');
const {
  BillingNotAvailableError,
  BillingForbiddenError,
  InvalidBillingQuantityError,
  LargerPoolAtOrBelowCeilingError,
  UnknownBillingPriceError,
} = await import('@/lib/billing/errors');
const { OrganizationNotFoundError } = await import('@/lib/organizations/errors');
const { MotirAiUnavailableError } = await import('@/lib/ai/errors');

const APP_ORIGIN = 'https://app.test';

function rawUsage(over: Partial<RawUsageResponse> = {}): RawUsageResponse {
  return {
    scope: 'org',
    coreOrganizationId: 'o',
    coreWorkspaceId: null,
    coreProjectId: null,
    balance: 1420,
    tier: { key: 'standard', name: 'Standard', monthlyCreditAllotment: 2000 },
    totalSpend: 580,
    monthSpend: 580,
    monthlyHistory: [],
    perModel: [],
    recentRuns: { runs: [], page: 1, pageSize: 10, total: 0 },
    ...over,
  };
}

function rawSubscription(over: Partial<RawSubscriptionResponse> = {}): RawSubscriptionResponse {
  return {
    status: 'active',
    currentPeriodEnd: '2026-07-22T00:00:00.000Z',
    priceId: 'price_standard',
    planTier: { key: 'standard', name: 'Standard', monthlyCreditAllotment: 2000 },
    ...over,
  };
}

const EMPTY_SUBSCRIPTION: RawSubscriptionResponse = {
  status: null,
  currentPeriodEnd: null,
  priceId: null,
  planTier: null,
};

const SCALED: ScaledTrackerSubscription = {
  status: 'active',
  priceId: 'tracker_annual',
  currentPeriodEnd: 1893456000,
};

// Found a workspace (auto-provisions the org + owner membership), then add an
// admin + a plain member. Returns the actors + the org id.
async function makeOrgWithRoles() {
  const owner = await createTestUser();
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: owner.id,
  });
  const organizationId = (
    await adminDb.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
  ).organizationId;

  const admin = await createTestUser();
  const member = await createTestUser();
  const outsider = await createTestUser();
  await organizationsService.addMember({
    organizationId,
    userId: admin.id,
    role: 'admin',
    actorUserId: owner.id,
  });
  await organizationsService.addMember({
    organizationId,
    userId: member.id,
    role: 'member',
    actorUserId: owner.id,
  });
  return { organizationId, workspaceId: workspace.id, owner, admin, member, outsider };
}

beforeEach(async () => {
  await truncateAuthTables();
  getOrgUsageMock.mockReset();
  getOrgSubscriptionMock.mockReset();
  createCheckoutSessionMock.mockReset();
  createPortalSessionMock.mockReset();
  setSeatQuantityMock.mockReset();
  getPendingPlanChangeMock.mockReset();
  getPendingPlanChangeMock.mockResolvedValue({ pendingDowngrade: null });
  getOrgUsageMock.mockResolvedValue(rawUsage());
  getOrgSubscriptionMock.mockResolvedValue(rawSubscription());
  createCheckoutSessionMock.mockResolvedValue({
    outcome: 'session',
    url: 'https://checkout.stripe.com/c/pay/cs_1',
  });
  createPortalSessionMock.mockResolvedValue({ url: 'https://billing.stripe.com/p/session/1' });
  setSeatQuantityMock.mockResolvedValue({ applied: true, outcome: 'updated' });
  process.env['MOTIR_CLOUD'] = 'true';
  process.env['MOTIR_BASE_URL'] = APP_ORIGIN;
});

afterEach(() => {
  delete process.env['MOTIR_CLOUD'];
  delete process.env['MOTIR_BASE_URL'];
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('billingService.getBillingStatus', () => {
  it('is cloud-only — throws BillingNotAvailableError when MOTIR_CLOUD is off', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    delete process.env['MOTIR_CLOUD'];
    await expect(
      billingService.getBillingStatus({ organizationId, actorUserId: owner.id }),
    ).rejects.toBeInstanceOf(BillingNotAvailableError);
    expect(getOrgUsageMock).not.toHaveBeenCalled();
  });

  it('hides the org from a non-member (404, the no-leak rule)', async () => {
    const { organizationId, outsider } = await makeOrgWithRoles();
    await expect(
      billingService.getBillingStatus({ organizationId, actorUserId: outsider.id }),
    ).rejects.toBeInstanceOf(OrganizationNotFoundError);
  });

  it('forbids a plain member from viewing billing (ADR §7)', async () => {
    const { organizationId, member } = await makeOrgWithRoles();
    await expect(
      billingService.getBillingStatus({ organizationId, actorUserId: member.id }),
    ).rejects.toBeInstanceOf(BillingForbiddenError);
  });

  it('lets an admin VIEW and MANAGE (canManageBilling true, MOTIR-6305) with the AI tier folded from usage', async () => {
    const { organizationId, admin } = await makeOrgWithRoles();
    const dto = await billingService.getBillingStatus({ organizationId, actorUserId: admin.id });

    expect(dto.access).toEqual({ role: 'admin', canManageBilling: true });
    expect(dto.motirAi).toEqual({
      tier: { key: 'standard', name: 'Standard', monthlyCreditAllotment: 2000 },
      balance: 1420,
      pendingDowngrade: null,
      subscription: {
        status: 'active',
        currentPeriodEnd: '2026-07-22T00:00:00.000Z',
        priceId: 'price_standard',
        planTier: { key: 'standard', name: 'Standard', monthlyCreditAllotment: 2000 },
      },
    });
    expect(dto.motir.scaledTrackerSubscription).toBeNull();
    expect(dto.catalog.seatPlan.name).toBe('Motir');
    expect(dto.catalog.aiPlans.map((p) => p.key)).toContain('pro');
    expect(dto.isMeta).toBe(false);
    expect(dto.internalBilling).toBe(false);
  });

  it('flags the META org (moooon B.V.) so the page renders the Internal plan state', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    await adminDb.organization.update({ where: { id: organizationId }, data: { isMeta: true } });
    const dto = await billingService.getBillingStatus({ organizationId, actorUserId: owner.id });
    expect(dto.isMeta).toBe(true);
    // A DIFFERENT flag, and it did not move (MOTIR-4567).
    expect(dto.internalBilling).toBe(false);
  });

  it('carries `internalBilling` for a classified org — and changes no figure with it (MOTIR-4567)', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    const before = await billingService.getBillingStatus({ organizationId, actorUserId: owner.id });

    await adminDb.organization.update({
      where: { id: organizationId },
      data: { internalBilling: true },
    });
    const after = await billingService.getBillingStatus({ organizationId, actorUserId: owner.id });

    expect(before.internalBilling).toBe(false);
    expect(after.internalBilling).toBe(true);
    // `isMeta` is untouched by the classification — two flags, two meanings.
    expect(after.isMeta).toBe(false);
    // ⚠️ THE POINT OF THE CARD, ASSERTED RATHER THAN DESCRIBED: classifying an
    // org changes WHICH KIND of org the DTO says it is, and NOTHING ELSE. Every
    // line, every state and every figure is byte-identical to the unclassified
    // read — an internal org is billed exactly like a customer.
    expect({ ...after, internalBilling: false }).toEqual(before);
  });

  it('folds the Stripe subscription lifecycle (status + renewal) from the subscription read', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    getOrgSubscriptionMock.mockResolvedValueOnce(
      rawSubscription({ status: 'past_due', currentPeriodEnd: '2026-08-01T00:00:00.000Z' }),
    );

    const dto = await billingService.getBillingStatus({ organizationId, actorUserId: owner.id });

    expect(getOrgSubscriptionMock).toHaveBeenCalledWith({ coreOrganizationId: organizationId });
    expect(dto.motirAi.subscription).toEqual({
      status: 'past_due',
      currentPeriodEnd: '2026-08-01T00:00:00.000Z',
      priceId: 'price_standard',
      planTier: { key: 'standard', name: 'Standard', monthlyCreditAllotment: 2000 },
    });
  });

  it('carries the EMPTY subscription shape (status: null) for a free / never-transacted org', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    getOrgSubscriptionMock.mockResolvedValueOnce(EMPTY_SUBSCRIPTION);

    const dto = await billingService.getBillingStatus({ organizationId, actorUserId: owner.id });

    expect(dto.motirAi.subscription).toEqual(EMPTY_SUBSCRIPTION);
  });

  it('carries the downgrade a live plan has scheduled (MOTIR-8399)', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    const pending = { planKey: 'pro', effectiveDate: '2026-11-01T00:00:00.000Z' };
    getPendingPlanChangeMock.mockResolvedValueOnce({ pendingDowngrade: pending });
    getOrgSubscriptionMock.mockResolvedValueOnce(rawSubscription({ status: 'active' }));

    const dto = await billingService.getBillingStatus({ organizationId, actorUserId: owner.id });

    expect(getPendingPlanChangeMock).toHaveBeenCalledWith({ coreOrganizationId: organizationId });
    expect(dto.motirAi.pendingDowngrade).toEqual(pending);
  });

  it('asks nothing about a pending downgrade for an org with no live paid plan', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    for (const sub of [EMPTY_SUBSCRIPTION, rawSubscription({ status: 'canceled' })]) {
      getOrgSubscriptionMock.mockResolvedValueOnce(sub);
      const dto = await billingService.getBillingStatus({ organizationId, actorUserId: owner.id });
      expect(dto.motirAi.pendingDowngrade).toBeNull();
    }
    expect(getPendingPlanChangeMock).not.toHaveBeenCalled();
  });

  it('degrades a failed pending-downgrade read to none, never failing the page', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getOrgSubscriptionMock.mockResolvedValueOnce(rawSubscription({ status: 'active' }));
    getPendingPlanChangeMock.mockRejectedValueOnce(new MotirAiUnavailableError('stripe'));

    const dto = await billingService.getBillingStatus({ organizationId, actorUserId: owner.id });

    expect(dto.motirAi.pendingDowngrade).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('propagates a motir-ai outage from the subscription read too', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    getOrgSubscriptionMock.mockRejectedValueOnce(new MotirAiUnavailableError('down'));
    await expect(
      billingService.getBillingStatus({ organizationId, actorUserId: owner.id }),
    ).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });

  it('lets an OWNER manage (canManageBilling true) and reflects the scaled-tracker state', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    await billingPropagationService.setScaledTrackerState({
      organizationId,
      scaledTrackerSubscription: SCALED,
    });

    const dto = await billingService.getBillingStatus({ organizationId, actorUserId: owner.id });
    expect(dto.access).toEqual({ role: 'owner', canManageBilling: true });
    expect(dto.motir.scaledTrackerSubscription).toEqual(SCALED);
  });

  it('propagates a motir-ai outage (the route maps it to 502)', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    // Reject EVERY usage read for this test: the CI entitlement makes its own
    // (it treats a failure as `balance: null` rather than exhaustion), so a
    // one-shot rejection could be absorbed there instead of surfacing here.
    getOrgUsageMock.mockRejectedValue(new MotirAiUnavailableError('down'));
    await expect(
      billingService.getBillingStatus({ organizationId, actorUserId: owner.id }),
    ).rejects.toBeInstanceOf(MotirAiUnavailableError);
  });
});

// ③ The Motir CI line's data (MOTIR-1903, ADR §7) — the END-TO-END proof the
// card asks for: the figures the panel renders come from REAL reads (membership
// → pool, the meter → consumption, the charge row → credits), never a
// placeholder and never a hardcoded null. The motir-ai boundary is the suite's
// existing mock; everything else runs against real Postgres.
describe('billingService.getBillingStatus — the CI entitlement (③ Motir CI)', () => {
  beforeEach(() => {
    process.env['GITHUB_FALLBACK_ORG'] = 'motir-projects';
  });
  afterEach(() => {
    delete process.env['GITHUB_FALLBACK_ORG'];
  });

  it('carries a REAL, non-null entitlement: the pool derived from live membership and the metered consumption', async () => {
    const { organizationId, workspaceId, owner } = await makeOrgWithRoles();
    // 3 members (owner + admin + member) → 3 × 300 = 900, under the 1,000 floor.
    const periodStart = periodStartFor(new Date());
    await withSystemContext((tx) =>
      ciPeriodUsageRepository.incrementForPeriod(
        {
          workspaceId,
          organizationId,
          periodStart,
          billableMinutes: 240,
          rawWallClockSeconds: 240 * 60,
          linearEquivalentMinutes: 240,
        },
        tx,
      ),
    );

    const dto = await billingService.getBillingStatus({ organizationId, actorUserId: owner.id });

    expect(dto.ci.applicable).toBe(true);
    expect(dto.ci.memberCount).toBe(3);
    expect(dto.ci.poolMinutes).toBe(1000);
    expect(dto.ci.floorApplied).toBe(true);
    // The consumption is the meter's own row, not a zero the panel would render
    // as "nothing to bill".
    expect(dto.ci.consumedMinutes).toBe(240);
    expect(dto.ci.remainingMinutes).toBe(760);
    expect(dto.ci.overageMinutes).toBe(0);
    expect(dto.ci.chargedCredits).toBe(0);
    expect(dto.ci.balance).toBe(1420);
    expect(dto.ci.state).toBe('within_allowance');
    expect(dto.ci.periodEnd).toBe(periodEndFor(periodStart).toISOString());
  });

  it('reports drawing-on-credits once the metered minutes pass the pool', async () => {
    const { organizationId, workspaceId, owner } = await makeOrgWithRoles();
    const periodStart = periodStartFor(new Date());
    await withSystemContext((tx) =>
      ciPeriodUsageRepository.incrementForPeriod(
        {
          workspaceId,
          organizationId,
          periodStart,
          billableMinutes: 1420,
          rawWallClockSeconds: 1420 * 60,
          linearEquivalentMinutes: 1420,
        },
        tx,
      ),
    );

    const dto = await billingService.getBillingStatus({ organizationId, actorUserId: owner.id });

    expect(dto.ci.state).toBe('drawing_on_credits');
    expect(dto.ci.overageMinutes).toBe(420);
    expect(dto.ci.remainingMinutes).toBe(0);
  });

  it('reports exhaustion when the org is past the pool at a zero balance', async () => {
    const { organizationId, workspaceId, owner } = await makeOrgWithRoles();
    getOrgUsageMock.mockResolvedValue(rawUsage({ balance: 0 }));
    const periodStart = periodStartFor(new Date());
    await withSystemContext((tx) =>
      ciPeriodUsageRepository.incrementForPeriod(
        {
          workspaceId,
          organizationId,
          periodStart,
          billableMinutes: 1200,
          rawWallClockSeconds: 1200 * 60,
          linearEquivalentMinutes: 1200,
        },
        tx,
      ),
    );

    const dto = await billingService.getBillingStatus({ organizationId, actorUserId: owner.id });
    expect(dto.ci.state).toBe('ci_credits_exhausted');
  });

  it('bypasses the META org — no allowance or charge, and the panel draws a minutes-only internal line', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    await adminDb.organization.update({ where: { id: organizationId }, data: { isMeta: true } });

    const dto = await billingService.getBillingStatus({ organizationId, actorUserId: owner.id });
    expect(dto.ci.applicable).toBe(false);
    expect(dto.ci.state).toBe('bypassed');
    // MOTIR-8886: bypassed, but flagged internal so the panel draws a minutes-only line.
    expect(dto.ci.internal).toBe(true);
  });

  it('bypasses an install with no provisioning org — nothing can be Motir-owned', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    delete process.env['GITHUB_FALLBACK_ORG'];

    const dto = await billingService.getBillingStatus({ organizationId, actorUserId: owner.id });
    expect(dto.ci.applicable).toBe(false);
    expect(dto.ci.state).toBe('bypassed');
  });
});

describe('billingService.startCheckout', () => {
  it('is cloud-only', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    delete process.env['MOTIR_CLOUD'];
    await expect(
      billingService.startCheckout({
        organizationId,
        actorUserId: owner.id,
        priceLookupKey: 'pro_pool_annual',
      }),
    ).rejects.toBeInstanceOf(BillingNotAvailableError);
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it('lets an ADMIN start checkout (ADR §7 as amended by MOTIR-6305)', async () => {
    const { organizationId, admin } = await makeOrgWithRoles();
    const { url } = (await billingService.startCheckout({
      organizationId,
      actorUserId: admin.id,
      priceLookupKey: 'pro_pool_annual',
    })) as { url: string };
    expect(url).toBe('https://checkout.stripe.com/c/pay/cs_1');
    expect(createCheckoutSessionMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a plain MEMBER checkout (ADR §7)', async () => {
    const { organizationId, member } = await makeOrgWithRoles();
    await expect(
      billingService.startCheckout({
        organizationId,
        actorUserId: member.id,
        priceLookupKey: 'pro_pool_annual',
      }),
    ).rejects.toBeInstanceOf(BillingForbiddenError);
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it('hides the org from a NON-MEMBER at the mutation gate (404, the no-leak rule)', async () => {
    const { organizationId, outsider } = await makeOrgWithRoles();
    await expect(
      billingService.startCheckout({
        organizationId,
        actorUserId: outsider.id,
        priceLookupKey: 'pro_pool_annual',
      }),
    ).rejects.toBeInstanceOf(OrganizationNotFoundError);
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it('rejects a price not in the catalog before touching the boundary', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    await expect(
      billingService.startCheckout({
        organizationId,
        actorUserId: owner.id,
        priceLookupKey: 'price_tampered',
      }),
    ).rejects.toBeInstanceOf(UnknownBillingPriceError);
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it('forwards a valid price to the boundary with success/cancel URLs and returns the url', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    const { url } = (await billingService.startCheckout({
      organizationId,
      actorUserId: owner.id,
      priceLookupKey: 'pro_pool_annual',
    })) as { url: string };
    expect(url).toBe('https://checkout.stripe.com/c/pay/cs_1');
    expect(createCheckoutSessionMock).toHaveBeenCalledWith({
      coreOrganizationId: organizationId,
      priceId: 'pro_pool_annual',
      // No `quantity` on the call → the explicit default reaches the boundary,
      // so what Stripe charges is never decided by a default two services away.
      quantity: 1,
      successUrl: `${APP_ORIGIN}/settings/organization/billing?checkout=success`,
      cancelUrl: `${APP_ORIGIN}/settings/organization/billing?checkout=cancel`,
    });
  });

  it('points an org that already holds a live AI plan at its plan, with no url (MOTIR-8394)', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    createCheckoutSessionMock.mockResolvedValueOnce({
      outcome: 'existing_plan',
      livePriceLookupKey: 'pro_pool_monthly',
    });
    const res = await billingService.startCheckout({
      organizationId,
      actorUserId: owner.id,
      priceLookupKey: 'max_x2_pool_annual',
    });
    expect(res).toEqual({ existingPlan: { livePriceLookupKey: 'pro_pool_monthly' } });
  });

  it.each(['max_x2_pool_annual', 'max_x2_pool_monthly'])(
    'forwards the Max ×2 price %s at quantity 1 (MOTIR-8394)',
    async (priceLookupKey) => {
      const { organizationId, owner } = await makeOrgWithRoles();
      await billingService.startCheckout({ organizationId, actorUserId: owner.id, priceLookupKey });
      expect(createCheckoutSessionMock).toHaveBeenCalledWith(
        expect.objectContaining({ priceId: priceLookupKey, quantity: 1 }),
      );
    },
  );

  it.each(['host_pool_annual', 'host_pool_monthly'])(
    'forwards the Host price %s at quantity 1 (MOTIR-9403)',
    async (priceLookupKey) => {
      const { organizationId, owner } = await makeOrgWithRoles();
      await billingService.startCheckout({ organizationId, actorUserId: owner.id, priceLookupKey });
      expect(createCheckoutSessionMock).toHaveBeenCalledWith(
        expect.objectContaining({ priceId: priceLookupKey, quantity: 1 }),
      );
    },
  );

  // ── The top-up bundle QUANTITY (MOTIR-2949) ──────────────────────────────
  // The credit top-up is the only multi-unit line, and only at the catalog's
  // bundle sizes. A subscription's quantity belongs to the seat sync; a one-time
  // payment has no reconciler at all, so a client multiplier is refused here
  // rather than corrected after the charge.

  it('forwards the top-up bundle QUANTITY for credit_topup', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    await billingService.startCheckout({
      organizationId,
      actorUserId: owner.id,
      priceLookupKey: 'credit_topup',
      quantity: 10,
    });
    expect(createCheckoutSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ priceId: 'credit_topup', quantity: 10 }),
    );
  });

  it('refuses a quantity > 1 on the AI pool subscription (pro_pool_monthly)', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    await expect(
      billingService.startCheckout({
        organizationId,
        actorUserId: owner.id,
        priceLookupKey: 'pro_pool_monthly',
        quantity: 10,
      }),
    ).rejects.toBeInstanceOf(InvalidBillingQuantityError);
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it('refuses a quantity > 1 on the scaled-tracker seat plan (tracker_monthly)', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    await expect(
      billingService.startCheckout({
        organizationId,
        actorUserId: owner.id,
        priceLookupKey: 'tracker_monthly',
        quantity: 6,
      }),
    ).rejects.toBeInstanceOf(InvalidBillingQuantityError);
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it('refuses a top-up quantity the catalog does not sell as a bundle', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    await expect(
      billingService.startCheckout({
        organizationId,
        actorUserId: owner.id,
        priceLookupKey: 'credit_topup',
        quantity: 3,
      }),
    ).rejects.toBeInstanceOf(InvalidBillingQuantityError);
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it('refuses a fractional / zero / negative quantity before the boundary', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    for (const quantity of [0, -1, 1.5]) {
      await expect(
        billingService.startCheckout({
          organizationId,
          actorUserId: owner.id,
          priceLookupKey: 'credit_topup',
          quantity,
        }),
      ).rejects.toBeInstanceOf(InvalidBillingQuantityError);
    }
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it('defaults to quantity 1 for a top-up with the field absent', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    await billingService.startCheckout({
      organizationId,
      actorUserId: owner.id,
      priceLookupKey: 'credit_topup',
    });
    expect(createCheckoutSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ priceId: 'credit_topup', quantity: 1 }),
    );
  });

  it('accepts an explicit quantity of 1 on a subscription price', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    await billingService.startCheckout({
      organizationId,
      actorUserId: owner.id,
      priceLookupKey: 'tracker_annual',
      quantity: 1,
    });
    expect(createCheckoutSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ priceId: 'tracker_annual', quantity: 1 }),
    );
  });

  it('checks the PRICE before the quantity — an unknown price with a bad quantity is UNKNOWN_PRICE', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    await expect(
      billingService.startCheckout({
        organizationId,
        actorUserId: owner.id,
        priceLookupKey: 'price_tampered',
        quantity: 99,
      }),
    ).rejects.toBeInstanceOf(UnknownBillingPriceError);
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it('refuses a larger pool at or below the ladder top with its own code (MOTIR-8990)', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    const refusal = billingService.startCheckout({
      organizationId,
      actorUserId: owner.id,
      priceLookupKey: 'pool_60k_pool_monthly',
    });
    await expect(refusal).rejects.toBeInstanceOf(LargerPoolAtOrBelowCeilingError);
    await expect(refusal).rejects.toMatchObject({
      code: 'BILLING_POOL_AT_OR_BELOW_CEILING',
      requestedCredits: 60000,
      ceilingCredits: 60000,
    });
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it('forwards a carried larger-pool rung at quantity 1 (MOTIR-8990)', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    await billingService.startCheckout({
      organizationId,
      actorUserId: owner.id,
      priceLookupKey: 'pool_120k_pool_annual',
    });
    expect(createCheckoutSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ priceId: 'pool_120k_pool_annual', quantity: 1 }),
    );
  });

  it('keeps a rung-shaped key above the ceiling that no rung carries as UNKNOWN_PRICE', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    await expect(
      billingService.startCheckout({
        organizationId,
        actorUserId: owner.id,
        priceLookupKey: 'pool_90k_pool_monthly',
      }),
    ).rejects.toBeInstanceOf(UnknownBillingPriceError);
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it('runs the billing gate before the quantity guard — a member is FORBIDDEN, not INVALID_QUANTITY', async () => {
    const { organizationId, member } = await makeOrgWithRoles();
    await expect(
      billingService.startCheckout({
        organizationId,
        actorUserId: member.id,
        priceLookupKey: 'tracker_monthly',
        quantity: 10,
      }),
    ).rejects.toBeInstanceOf(BillingForbiddenError);
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });
});

describe('billingService.openPortal', () => {
  it('refuses a plain MEMBER the portal', async () => {
    const { organizationId, member } = await makeOrgWithRoles();
    await expect(
      billingService.openPortal({ organizationId, actorUserId: member.id }),
    ).rejects.toBeInstanceOf(BillingForbiddenError);
    expect(createPortalSessionMock).not.toHaveBeenCalled();
  });

  it('opens the portal for an ADMIN (MOTIR-6305)', async () => {
    const { organizationId, admin } = await makeOrgWithRoles();
    const { url } = await billingService.openPortal({ organizationId, actorUserId: admin.id });
    expect(url).toBe('https://billing.stripe.com/p/session/1');
  });

  it('opens the portal for an owner with the return URL', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    const { url } = await billingService.openPortal({ organizationId, actorUserId: owner.id });
    expect(url).toBe('https://billing.stripe.com/p/session/1');
    expect(createPortalSessionMock).toHaveBeenCalledWith({
      coreOrganizationId: organizationId,
      returnUrl: `${APP_ORIGIN}/settings/organization/billing`,
    });
  });
});

describe('billingService.syncScaledTrackerSeatQuantity (Subtask 8.1.12)', () => {
  it('sets the seat quantity to the live active-member count for an active scaled org', async () => {
    // makeOrgWithRoles seeds owner + admin + member = 3 org members.
    const { organizationId } = await makeOrgWithRoles();
    await billingPropagationService.setScaledTrackerState({
      organizationId,
      scaledTrackerSubscription: SCALED,
    });

    const result = await billingService.syncScaledTrackerSeatQuantity(organizationId);

    // Absolute set: the recomputed count is sent over the boundary (no delta).
    expect(setSeatQuantityMock).toHaveBeenCalledTimes(1);
    expect(setSeatQuantityMock).toHaveBeenCalledWith({
      coreOrganizationId: organizationId,
      quantity: 3,
    });
    expect(result).toEqual({ applied: true, outcome: 'updated' });
  });

  it('nets the bundled AI seat — bills members − 1 when the org holds a paid AI plan (8.1.25)', async () => {
    const { organizationId } = await makeOrgWithRoles(); // 3 members
    await billingPropagationService.setScaledTrackerState({
      organizationId,
      scaledTrackerSubscription: SCALED,
    });
    // A paid AI plan bundles the first seat.
    await billingPropagationService.setAiIncludedSeat({ organizationId, included: true });

    await billingService.syncScaledTrackerSeatQuantity(organizationId);

    // 3 members − 1 included = 2 billed seats.
    expect(setSeatQuantityMock).toHaveBeenLastCalledWith({
      coreOrganizationId: organizationId,
      quantity: 2,
    });
  });

  // MOTIR-8403: the included seat is the catalog's count, and the target never
  // goes below zero however few members the org has.
  it.each([
    { label: 'one member with the AI seat bills 0', members: 1, included: true, quantity: 0 },
    {
      label: 'no members with the AI seat bills 0, never −1',
      members: 0,
      included: true,
      quantity: 0,
    },
    { label: 'three members without the AI seat bill 3', members: 3, included: false, quantity: 3 },
  ])('$label', async ({ members, included, quantity }) => {
    const owner = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Solo',
      ownerUserId: owner.id,
    });
    const organizationId = (
      await adminDb.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
    ).organizationId;
    for (let i = 1; i < members; i++) {
      const u = await createTestUser();
      await organizationsService.addMember({
        organizationId,
        userId: u.id,
        role: 'member',
        actorUserId: owner.id,
      });
    }
    if (members === 0) {
      await adminDb.organizationMembership.deleteMany({ where: { organizationId } });
    }
    await billingPropagationService.setScaledTrackerState({
      organizationId,
      scaledTrackerSubscription: SCALED,
    });
    await billingPropagationService.setAiIncludedSeat({ organizationId, included });

    await billingService.syncScaledTrackerSeatQuantity(organizationId);

    expect(setSeatQuantityMock).toHaveBeenLastCalledWith({
      coreOrganizationId: organizationId,
      quantity,
    });
  });

  it('re-derives the count from truth — rapid adds do not double-count (absolute set)', async () => {
    const { organizationId, owner } = await makeOrgWithRoles(); // 3 members
    await billingPropagationService.setScaledTrackerState({
      organizationId,
      scaledTrackerSubscription: SCALED,
    });

    // Two more members join concurrently; the absolute count is now 5.
    const u1 = await createTestUser();
    const u2 = await createTestUser();
    await Promise.all([
      organizationsService.addMember({
        organizationId,
        userId: u1.id,
        role: 'member',
        actorUserId: owner.id,
      }),
      organizationsService.addMember({
        organizationId,
        userId: u2.id,
        role: 'member',
        actorUserId: owner.id,
      }),
    ]);

    await billingService.syncScaledTrackerSeatQuantity(organizationId);

    // Recompute-from-truth → exactly the final count, never an accumulated delta.
    expect(setSeatQuantityMock).toHaveBeenLastCalledWith({
      coreOrganizationId: organizationId,
      quantity: 5,
    });
  });

  it('no-ops (no boundary call) for a free org with no active scaled subscription', async () => {
    const { organizationId } = await makeOrgWithRoles(); // never made scaled

    const result = await billingService.syncScaledTrackerSeatQuantity(organizationId);

    expect(setSeatQuantityMock).not.toHaveBeenCalled();
    expect(result).toEqual({ applied: false, outcome: 'no_active_tracker_subscription' });
  });

  it('no-ops for a past_due (non-active) scaled subscription', async () => {
    const { organizationId } = await makeOrgWithRoles();
    await billingPropagationService.setScaledTrackerState({
      organizationId,
      scaledTrackerSubscription: { ...SCALED, status: 'past_due' },
    });

    const result = await billingService.syncScaledTrackerSeatQuantity(organizationId);

    expect(setSeatQuantityMock).not.toHaveBeenCalled();
    expect(result.applied).toBe(false);
  });

  it('no-ops off-cloud — there is no billing self-hosted', async () => {
    const { organizationId } = await makeOrgWithRoles();
    await billingPropagationService.setScaledTrackerState({
      organizationId,
      scaledTrackerSubscription: SCALED,
    });
    delete process.env['MOTIR_CLOUD'];

    const result = await billingService.syncScaledTrackerSeatQuantity(organizationId);

    expect(setSeatQuantityMock).not.toHaveBeenCalled();
    expect(result.applied).toBe(false);
  });
});

describe('billingService.getAiAccess (the member-safe 8.1.8 paywall read)', () => {
  it('is not applicable off-cloud (self-host) — no boundary calls', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    delete process.env['MOTIR_CLOUD'];
    const access = await billingService.getAiAccess({ organizationId, actorUserId: owner.id });
    expect(access.applicable).toBe(false);
    expect(getOrgUsageMock).not.toHaveBeenCalled();
    expect(getOrgSubscriptionMock).not.toHaveBeenCalled();
  });

  it('hides the org from a non-member (the no-leak rule)', async () => {
    const { organizationId, outsider } = await makeOrgWithRoles();
    await expect(
      billingService.getAiAccess({ organizationId, actorUserId: outsider.id }),
    ).rejects.toBeInstanceOf(OrganizationNotFoundError);
  });

  it('ADMITS a plain member (unlike getBillingStatus) with canManageBilling false', async () => {
    const { organizationId, member } = await makeOrgWithRoles();
    const access = await billingService.getAiAccess({ organizationId, actorUserId: member.id });
    expect(access.applicable).toBe(true);
    expect(access.canManageBilling).toBe(false);
    expect(access.balance).toBe(1420);
    expect(access.tierName).toBe('Standard');
    expect(access.tierAllotment).toBe(2000);
    expect(typeof access.organizationName).toBe('string');
  });

  it('is not applicable for the META org (moooon B.V.) — the AI paywall never renders', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    await adminDb.organization.update({ where: { id: organizationId }, data: { isMeta: true } });
    const access = await billingService.getAiAccess({ organizationId, actorUserId: owner.id });
    expect(access.applicable).toBe(false);
  });

  it('an OWNER on a paid (active) plan → hasPaidAiPlan true, canManageBilling true, renewsAt set', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    const access = await billingService.getAiAccess({ organizationId, actorUserId: owner.id });
    expect(access.canManageBilling).toBe(true);
    expect(access.hasPaidAiPlan).toBe(true);
    expect(access.renewsAt).toBe('2026-07-22T00:00:00.000Z');
  });

  it('past_due still counts as a paid plan (grace period — out-of-credits, not tier-gate)', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    getOrgSubscriptionMock.mockResolvedValueOnce(rawSubscription({ status: 'past_due' }));
    const access = await billingService.getAiAccess({ organizationId, actorUserId: owner.id });
    expect(access.hasPaidAiPlan).toBe(true);
  });

  it('a trialing org is NOT a paid plan → the tier-gate path (hasPaidAiPlan false)', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    getOrgSubscriptionMock.mockResolvedValueOnce(
      rawSubscription({ status: 'trialing', planTier: null }),
    );
    const access = await billingService.getAiAccess({ organizationId, actorUserId: owner.id });
    expect(access.hasPaidAiPlan).toBe(false);
  });

  it('a never-transacted org (no subscription, zero balance) → tier-gate, balance 0', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    getOrgUsageMock.mockResolvedValueOnce(rawUsage({ balance: 0, tier: null }));
    getOrgSubscriptionMock.mockResolvedValueOnce(EMPTY_SUBSCRIPTION);
    const access = await billingService.getAiAccess({ organizationId, actorUserId: owner.id });
    expect(access.hasPaidAiPlan).toBe(false);
    expect(access.balance).toBe(0);
    expect(access.tierName).toBeNull();
    expect(access.renewsAt).toBeNull();
  });

  it('an admin can read (applicable) AND buy (canManageBilling true, MOTIR-6305)', async () => {
    const { organizationId, admin } = await makeOrgWithRoles();
    const access = await billingService.getAiAccess({ organizationId, actorUserId: admin.id });
    expect(access.applicable).toBe(true);
    expect(access.canManageBilling).toBe(true);
  });
});

// The members-page seat summary (Subtask 8.1.14) — the gating + the derived
// pricing the in-context seat band reads. The seat COUNT is the membership count
// (resolved client-side), so this only proves the pricing/lifecycle + the three
// "no seat UI" (→ null) gates: self-host, free/canceled, and the member-vs-manager
// canManageBilling split (owner and admin both manage since MOTIR-6305).
describe('billingService.getSeatSummary', () => {
  async function setScaled(organizationId: string, sub: ScaledTrackerSubscription | null) {
    await billingPropagationService.setScaledTrackerState({
      organizationId,
      scaledTrackerSubscription: sub,
    });
  }

  it('returns null off-cloud (self-host shows no seat UI)', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    await setScaled(organizationId, SCALED);
    delete process.env['MOTIR_CLOUD'];
    expect(
      await billingService.getSeatSummary({ organizationId, actorUserId: owner.id }),
    ).toBeNull();
  });

  it('returns null for a free org (no scaled-tracker subscription)', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    expect(
      await billingService.getSeatSummary({ organizationId, actorUserId: owner.id }),
    ).toBeNull();
  });

  it('returns null for a canceled subscription (page is unchanged)', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    await setScaled(organizationId, { ...SCALED, status: 'canceled' });
    expect(
      await billingService.getSeatSummary({ organizationId, actorUserId: owner.id }),
    ).toBeNull();
  });

  it('returns null for a plain member (defensive — page already forbids them)', async () => {
    const { organizationId, member } = await makeOrgWithRoles();
    await setScaled(organizationId, SCALED);
    expect(
      await billingService.getSeatSummary({ organizationId, actorUserId: member.id }),
    ).toBeNull();
  });

  it('gives an OWNER the scaled summary with canManageBilling true + catalog pricing', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    await setScaled(organizationId, SCALED); // tracker_annual
    const summary = await billingService.getSeatSummary({ organizationId, actorUserId: owner.id });
    expect(summary).toEqual({
      status: 'active',
      cadence: 'annual',
      perSeatUsd: 40,
      monthlyPerSeatUsd: 5,
      annualPerSeatUsd: 40,
      currentPeriodEnd: SCALED.currentPeriodEnd,
      canManageBilling: true,
    });
  });

  it('gives an ADMIN the summary with the seat controls (canManageBilling true — ADR §7 as amended)', async () => {
    const { organizationId, admin } = await makeOrgWithRoles();
    await setScaled(organizationId, SCALED);
    const summary = await billingService.getSeatSummary({ organizationId, actorUserId: admin.id });
    expect(summary?.canManageBilling).toBe(true);
    expect(summary?.status).toBe('active');
  });

  it('surfaces past_due (seats stay editable — dunning)', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    await setScaled(organizationId, { ...SCALED, status: 'past_due' });
    const summary = await billingService.getSeatSummary({ organizationId, actorUserId: owner.id });
    expect(summary?.status).toBe('past_due');
  });

  it('maps a monthly price id to the monthly cadence + fee', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    await setScaled(organizationId, { ...SCALED, priceId: 'tracker_monthly' });
    const summary = await billingService.getSeatSummary({ organizationId, actorUserId: owner.id });
    expect(summary?.cadence).toBe('monthly');
    expect(summary?.perSeatUsd).toBe(5);
  });
});
