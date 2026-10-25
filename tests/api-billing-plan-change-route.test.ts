import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from './helpers/adminDb';
import { MotirAiPlanChangeRefusedError, MotirAiUnavailableError } from '@/lib/ai/errors';
import type { RawDowngradePreview, RawUpgradePreview, RawUpgradeResult } from '@/lib/ai/types';

// Transport + service tests for the four plan-change routes (Story MOTIR-8387 ·
// MOTIR-8399): POST /api/organizations/[orgId]/billing/{upgrade,downgrade}[/preview].
// They prove what motir-core owns on this path:
//   - the session gate (401 before any service call) and the body shape (400),
//   - the billing gate: owner and admin may, a plain member is 403, a non-member
//     404, off-cloud 404 — before motir-ai is asked anything,
//   - the catalog check: only a paid, recurring plan is a target (Free is not),
//   - the pass-through: motir-ai's figures cross by name, and nothing else does,
//   - the refusal mapping by reason: 400, payment_failed 402, org_closing 409,
//     and a boundary outage 502.
// Real Postgres for the org and its memberships (the no-mocks rule); the two
// sanctioned boundary mocks are `getSession` and the motir-ai HTTP leaf.

const session = { current: null as { user: { id: string; email: string } } | null };
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));

const ai = vi.hoisted(() => ({
  previewPlanUpgrade: vi.fn(),
  upgradePlan: vi.fn(),
  previewPlanDowngrade: vi.fn(),
  schedulePlanDowngrade: vi.fn(),
}));
vi.mock('@/lib/ai/motirAiClient', () => ({
  previewPlanUpgrade: (i: unknown) => ai.previewPlanUpgrade(i),
  upgradePlan: (i: unknown) => ai.upgradePlan(i),
  previewPlanDowngrade: (i: unknown) => ai.previewPlanDowngrade(i),
  schedulePlanDowngrade: (i: unknown) => ai.schedulePlanDowngrade(i),
  getPendingPlanChange: vi.fn(),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  getOrgUsage: vi.fn(),
  getOrgSubscription: vi.fn(),
  setSeatQuantity: vi.fn(),
}));
vi.mock('@/lib/billing/seatSync', () => ({ enqueueScaledTrackerSeatSync: vi.fn() }));

const { POST: previewUpgradePOST } =
  await import('@/app/api/organizations/[orgId]/billing/upgrade/preview/route');
const { POST: upgradePOST } = await import('@/app/api/organizations/[orgId]/billing/upgrade/route');
const { POST: previewDowngradePOST } =
  await import('@/app/api/organizations/[orgId]/billing/downgrade/preview/route');
const { POST: downgradePOST } =
  await import('@/app/api/organizations/[orgId]/billing/downgrade/route');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { organizationsService } = await import('@/lib/services/organizationsService');
const { createTestUser } = await import('./fixtures/userFixtures');
const { truncateAuthTables } = await import('./helpers/db');

type Handler = typeof upgradePOST;

function call(handler: Handler, orgId: string, body: unknown) {
  return handler(
    new Request(`http://localhost:3000/api/organizations/${orgId}/billing/x`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ orgId }) },
  );
}

function signInAs(user: { id: string; email: string }) {
  session.current = { user: { id: user.id, email: user.email } };
}

async function makeOrg() {
  const owner = await createTestUser();
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: owner.id,
  });
  const organizationId = (
    await adminDb.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
  ).organizationId;
  const admin = await createTestUser();
  await organizationsService.addMember({
    organizationId,
    userId: admin.id,
    role: 'admin',
    actorUserId: owner.id,
  });
  const member = await createTestUser();
  await organizationsService.addMember({
    organizationId,
    userId: member.id,
    role: 'member',
    actorUserId: owner.id,
  });
  return { organizationId, owner, admin, member };
}

const PENDING = { planKey: 'standard', effectiveDate: '2026-11-01T00:00:00.000Z' };

const UPGRADE_PREVIEW: RawUpgradePreview & { periodStart: string; somethingNew: string } = {
  prorationDate: 1792238400,
  fromPlan: 'pro',
  toPlan: 'max',
  cadence: 'monthly',
  cadenceChange: null,
  amountDueCents: 3629,
  currency: 'usd',
  periodStart: '2026-10-01T00:00:00.000Z',
  periodEnd: '2026-11-01T00:00:00.000Z',
  billingDaysLeft: 15,
  daysLeft: 15,
  creditWindowEnd: '2026-11-01T00:00:00.000Z',
  extraCredits: 7258,
  extraIndexAllowance: 3629,
  fromPool: 15000,
  fullPool: 30000,
  fullAllowance: 15000,
  toPriceCents: 15000,
  pendingDowngrade: PENDING,
  somethingNew: 'must not cross',
};

beforeEach(async () => {
  await truncateAuthTables();
  session.current = null;
  for (const fn of Object.values(ai)) fn.mockReset();
  process.env['MOTIR_CLOUD'] = 'true';
});

afterEach(() => {
  delete process.env['MOTIR_CLOUD'];
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the gates, on all four routes', () => {
  const routes: Array<[string, Handler, Record<string, unknown>]> = [
    ['upgrade/preview', previewUpgradePOST, { toPlanKey: 'max' }],
    ['upgrade', upgradePOST, { toPlanKey: 'max', prorationDate: 1792238400 }],
    ['downgrade/preview', previewDowngradePOST, { toPlanKey: 'standard' }],
    ['downgrade', downgradePOST, { toPlanKey: 'standard' }],
  ];

  it.each(routes)('%s: 401 signed out, before any call', async (_p, handler, body) => {
    const res = await call(handler, 'any-org', body);
    expect(res.status).toBe(401);
    expect(Object.values(ai).every((fn) => fn.mock.calls.length === 0)).toBe(true);
  });

  it.each(routes)('%s: 400 without a toPlanKey', async (_p, handler) => {
    const { organizationId, owner } = await makeOrg();
    signInAs(owner);
    const res = await call(handler, organizationId, '{not json');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'INVALID_REQUEST', error: 'toPlanKey is required' });
  });

  it.each(routes)('%s: 403 for a plain member, 404 for a non-member', async (_p, handler, body) => {
    const { organizationId, member } = await makeOrg();
    signInAs(member);
    const forbidden = await call(handler, organizationId, body);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ code: 'BILLING_FORBIDDEN' });

    const stranger = await createTestUser();
    signInAs(stranger);
    expect((await call(handler, organizationId, body)).status).toBe(404);
    expect(Object.values(ai).every((fn) => fn.mock.calls.length === 0)).toBe(true);
  });

  it.each(routes)('%s: 404 off-cloud', async (_p, handler, body) => {
    const { organizationId, owner } = await makeOrg();
    signInAs(owner);
    delete process.env['MOTIR_CLOUD'];
    const res = await call(handler, organizationId, body);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'BILLING_NOT_AVAILABLE' });
  });

  it.each(['free', 'enterprise', 'gold', 'pro_pool_monthly'])(
    'refuses %s as unknown_plan before motir-ai is asked',
    async (toPlanKey) => {
      const { organizationId, owner } = await makeOrg();
      signInAs(owner);
      for (const [, handler, body] of routes) {
        const res = await call(handler, organizationId, { ...body, toPlanKey });
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({
          code: 'BILLING_PLAN_CHANGE_REFUSED',
          reason: 'unknown_plan',
        });
      }
      expect(Object.values(ai).every((fn) => fn.mock.calls.length === 0)).toBe(true);
    },
  );
});

describe('POST …/billing/upgrade/preview', () => {
  it("passes motir-ai's figures through by name, for an owner and an admin", async () => {
    const { organizationId, owner, admin } = await makeOrg();
    ai.previewPlanUpgrade.mockResolvedValue(UPGRADE_PREVIEW);
    for (const actor of [owner, admin]) {
      signInAs(actor);
      const res = await call(previewUpgradePOST, organizationId, { toPlanKey: 'max' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        prorationDate: 1792238400,
        fromPlan: 'pro',
        toPlan: 'max',
        cadence: 'monthly',
        cadenceChange: null,
        amountDueCents: 3629,
        currency: 'usd',
        periodEnd: '2026-11-01T00:00:00.000Z',
        billingDaysLeft: 15,
        daysLeft: 15,
        creditWindowEnd: '2026-11-01T00:00:00.000Z',
        extraCredits: 7258,
        extraIndexAllowance: 3629,
        fromPool: 15000,
        fullPool: 30000,
        fullAllowance: 15000,
        toPriceCents: 15000,
        pendingDowngrade: PENDING,
      });
    }
    expect(ai.previewPlanUpgrade).toHaveBeenCalledWith({
      coreOrganizationId: organizationId,
      toPlanKey: 'max',
    });
  });

  it('asks motir-ai for an upgrade to Host rather than refusing it as unknown_plan (MOTIR-9403)', async () => {
    const { organizationId, owner } = await makeOrg();
    signInAs(owner);
    ai.previewPlanUpgrade.mockResolvedValue({ ...UPGRADE_PREVIEW, toPlan: 'host' });
    const res = await call(previewUpgradePOST, organizationId, { toPlanKey: 'host' });
    expect(res.status).toBe(200);
    expect(ai.previewPlanUpgrade).toHaveBeenCalledWith({
      coreOrganizationId: organizationId,
      toPlanKey: 'host',
    });
  });

  it.each([
    ['not_an_upgrade', 400],
    ['same_plan', 400],
    ['no_live_plan', 400],
    ['second_plan', 400],
    ['org_closing', 409],
  ] as const)('maps the %s refusal to %i with its reason', async (reason, status) => {
    const { organizationId, owner } = await makeOrg();
    signInAs(owner);
    ai.previewPlanUpgrade.mockRejectedValue(
      new MotirAiPlanChangeRefusedError(reason, `${reason}: detail`),
    );
    const res = await call(previewUpgradePOST, organizationId, { toPlanKey: 'max' });
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ code: 'BILLING_PLAN_CHANGE_REFUSED', reason });
  });

  it('answers 502 when motir-ai is unavailable', async () => {
    const { organizationId, owner } = await makeOrg();
    signInAs(owner);
    ai.previewPlanUpgrade.mockRejectedValue(new MotirAiUnavailableError('down'));
    const res = await call(previewUpgradePOST, organizationId, { toPlanKey: 'max' });
    expect(res.status).toBe(502);
  });
});

describe('POST …/billing/upgrade', () => {
  const RESULT: RawUpgradeResult = {
    status: 'upgraded',
    fromPlan: 'pro',
    toPlan: 'max',
    invoiceId: 'in_1',
    amountDueCents: 3629,
    currency: 'usd',
    extraCredits: 7258,
    extraIndexAllowance: 3629,
    clearedPending: PENDING,
  };

  it('sends the preview’s prorationDate and returns the grant', async () => {
    const { organizationId, owner } = await makeOrg();
    signInAs(owner);
    ai.upgradePlan.mockResolvedValue(RESULT);
    const res = await call(upgradePOST, organizationId, {
      toPlanKey: 'max',
      prorationDate: 1792238400,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'upgraded',
      fromPlan: 'pro',
      toPlan: 'max',
      extraCredits: 7258,
      extraIndexAllowance: 3629,
      clearedPending: PENDING,
    });
    expect(ai.upgradePlan).toHaveBeenCalledWith({
      coreOrganizationId: organizationId,
      toPlanKey: 'max',
      prorationDate: 1792238400,
    });
  });

  it.each([undefined, '1792238400', 1792238400.5, 0, -3])(
    'refuses a prorationDate of %o as 400 before motir-ai is asked',
    async (prorationDate) => {
      const { organizationId, owner } = await makeOrg();
      signInAs(owner);
      const res = await call(upgradePOST, organizationId, { toPlanKey: 'max', prorationDate });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'INVALID_REQUEST' });
      expect(ai.upgradePlan).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['payment_failed', 402],
    ['preview_expired', 400],
  ] as const)('maps %s to %i', async (reason, status) => {
    const { organizationId, owner } = await makeOrg();
    signInAs(owner);
    ai.upgradePlan.mockRejectedValue(new MotirAiPlanChangeRefusedError(reason, reason));
    const res = await call(upgradePOST, organizationId, { toPlanKey: 'max', prorationDate: 5 });
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ reason });
  });
});

describe('POST …/billing/downgrade/preview and …/billing/downgrade', () => {
  it('passes the downgrade preview through by name', async () => {
    const { organizationId, owner } = await makeOrg();
    signInAs(owner);
    const preview: RawDowngradePreview & { refundCents: number } = {
      fromPlan: 'max',
      toPlan: 'standard',
      cadence: 'annual',
      cadenceChange: null,
      effectiveDate: '2027-01-15T00:00:00.000Z',
      amountDueCents: 0,
      refundCents: 0,
      creditsChange: 0,
      allowanceChange: 0,
      fromPool: 30000,
      fullPool: 5000,
      fullAllowance: null,
      toPriceCents: 20000,
      currency: 'usd',
      pendingDowngrade: null,
    };
    ai.previewPlanDowngrade.mockResolvedValue(preview);
    const res = await call(previewDowngradePOST, organizationId, { toPlanKey: 'standard' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      fromPlan: 'max',
      toPlan: 'standard',
      cadence: 'annual',
      cadenceChange: null,
      effectiveDate: '2027-01-15T00:00:00.000Z',
      fromPool: 30000,
      fullPool: 5000,
      fullAllowance: null,
      toPriceCents: 20000,
      currency: 'usd',
      pendingDowngrade: null,
    });
  });

  it('schedules the downgrade and returns what it replaced', async () => {
    const { organizationId, admin } = await makeOrg();
    signInAs(admin);
    ai.schedulePlanDowngrade.mockResolvedValue({
      status: 'scheduled',
      fromPlan: 'max',
      toPlan: 'pro',
      cadence: 'monthly',
      effectiveDate: '2026-11-01T00:00:00.000Z',
      replacedPending: PENDING,
    });
    const res = await call(downgradePOST, organizationId, { toPlanKey: 'pro' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'scheduled',
      fromPlan: 'max',
      toPlan: 'pro',
      effectiveDate: '2026-11-01T00:00:00.000Z',
      replacedPending: PENDING,
    });
    expect(ai.schedulePlanDowngrade).toHaveBeenCalledWith({
      coreOrganizationId: organizationId,
      toPlanKey: 'pro',
    });
  });

  it('maps not_a_downgrade to 400', async () => {
    const { organizationId, owner } = await makeOrg();
    signInAs(owner);
    ai.schedulePlanDowngrade.mockRejectedValue(
      new MotirAiPlanChangeRefusedError('not_a_downgrade', 'not_a_downgrade: x'),
    );
    const res = await call(downgradePOST, organizationId, { toPlanKey: 'max_x2' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ reason: 'not_a_downgrade' });
  });
});
