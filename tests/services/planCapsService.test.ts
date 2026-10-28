import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { RawSubscriptionResponse } from '@/lib/ai/types';
import { adminDb } from '../helpers/adminDb';

// THE PLAN-CAPS READ (Story MOTIR-9363 · MOTIR-9372) over a real Postgres org row.
// motir-ai's subscription read is the one stubbed seam, at `getOrgSubscription`,
// exactly as `tests/billingService.test.ts` stubs it.

const getOrgSubscriptionMock = vi.fn<(q: unknown) => Promise<RawSubscriptionResponse>>();

vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  getOrgSubscription: (q: unknown) => getOrgSubscriptionMock(q),
}));

const { planCapsService, _resetPlanCapsCache } = await import('@/lib/services/planCapsService');
const { aiPlanGateService } = await import('@/lib/services/aiPlanGateService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { createTestUser } = await import('../fixtures/userFixtures');
const { truncateAuthTables } = await import('../helpers/db');

const NOW = new Date('2026-10-23T12:00:00.000Z');

function subscription(
  planTier: RawSubscriptionResponse['planTier'],
  status: RawSubscriptionResponse['status'] = 'active',
): RawSubscriptionResponse {
  return { status, currentPeriodEnd: null, priceId: null, planTier };
}

const PRO = { key: 'pro', name: 'Pro', monthlyCreditAllotment: 15_000 };

async function seedOrg(flags: { isMeta?: boolean; internalBilling?: boolean } = {}) {
  const user = await createTestUser();
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Caps',
    ownerUserId: user.id,
  });
  if (flags.isMeta || flags.internalBilling) {
    await adminDb.organization.update({
      where: { id: workspace.organizationId },
      data: { isMeta: flags.isMeta ?? false, internalBilling: flags.internalBilling ?? false },
    });
  }
  return workspace.organizationId;
}

beforeEach(async () => {
  await truncateAuthTables();
  _resetPlanCapsCache();
  getOrgSubscriptionMock.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('planCapsService.capsFor — capped', () => {
  it('answers the plan figures, with planName as motir-ai sends it', async () => {
    const orgId = await seedOrg();
    getOrgSubscriptionMock.mockResolvedValue(subscription(PRO));
    expect(await planCapsService.capsFor(orgId)).toEqual({
      kind: 'capped',
      planKey: 'pro',
      planName: 'Pro',
      caps: { agentRunsInParallel: 3, agentsPerUser: 2, agentsRunningPerOrg: 10, ciBurstCap: 5 },
    });
    expect(getOrgSubscriptionMock).toHaveBeenCalledWith({ coreOrganizationId: orgId });
  });

  it('answers the figures whatever the status — whether it may spend is the gate’s question', async () => {
    const orgId = await seedOrg();
    getOrgSubscriptionMock.mockResolvedValue(subscription(PRO, 'canceled'));
    expect((await planCapsService.capsFor(orgId)).kind).toBe('capped');
  });
});

describe('planCapsService.capsFor — exempt', () => {
  it.each([{ isMeta: true }, { internalBilling: true }])(
    'Motir’s own org %j is exempt, without a remote read',
    async (flags) => {
      const orgId = await seedOrg(flags);
      getOrgSubscriptionMock.mockImplementation(() => {
        throw new Error('the subscription must not be read for an exempt org');
      });
      expect(await planCapsService.capsFor(orgId)).toEqual({ kind: 'exempt' });
      expect(getOrgSubscriptionMock).not.toHaveBeenCalled();
    },
  );

  it('a build with no billing is exempt for any org', async () => {
    vi.stubEnv('MOTIR_CLOUD', '');
    const orgId = await seedOrg();
    expect(await planCapsService.capsFor(orgId)).toEqual({ kind: 'exempt' });
    expect(getOrgSubscriptionMock).not.toHaveBeenCalled();
  });
});

describe('planCapsService.capsFor — fail closed', () => {
  it('a missing org row is plan_unknown', async () => {
    expect(await planCapsService.capsFor('00000000-0000-4000-8000-000000000000')).toEqual({
      kind: 'plan_unknown',
      planKey: null,
    });
  });

  it('an unreadable subscription is plan_unknown, and never throws', async () => {
    const orgId = await seedOrg();
    getOrgSubscriptionMock.mockRejectedValue(new Error('motir-ai down'));
    expect(await planCapsService.capsFor(orgId)).toEqual({ kind: 'plan_unknown', planKey: null });
  });

  it('a subscription with no plan tier is plan_unknown', async () => {
    const orgId = await seedOrg();
    getOrgSubscriptionMock.mockResolvedValue(subscription(null, null));
    expect(await planCapsService.capsFor(orgId)).toEqual({ kind: 'plan_unknown', planKey: null });
  });

  it('a key with no row is plan_unknown, carrying the key', async () => {
    const orgId = await seedOrg();
    getOrgSubscriptionMock.mockResolvedValue(
      subscription({ key: 'legacy_tier', name: 'Legacy', monthlyCreditAllotment: 1 }),
    );
    expect(await planCapsService.capsFor(orgId)).toEqual({
      kind: 'plan_unknown',
      planKey: 'legacy_tier',
    });
  });
});

describe('planCapsService.capsFor — the 30-second cache', () => {
  it('reuses a read within 30 s and reads again after it', async () => {
    const orgId = await seedOrg();
    getOrgSubscriptionMock.mockResolvedValue(subscription(PRO));
    await planCapsService.capsFor(orgId);
    vi.setSystemTime(new Date(NOW.getTime() + 29_000));
    await planCapsService.capsFor(orgId);
    expect(getOrgSubscriptionMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date(NOW.getTime() + 31_000));
    await planCapsService.capsFor(orgId);
    expect(getOrgSubscriptionMock).toHaveBeenCalledTimes(2);
  });

  it('never caches plan_unknown, so a recovered motir-ai is read at once', async () => {
    const orgId = await seedOrg();
    getOrgSubscriptionMock.mockRejectedValueOnce(new Error('down'));
    expect((await planCapsService.capsFor(orgId)).kind).toBe('plan_unknown');
    getOrgSubscriptionMock.mockResolvedValueOnce(subscription(PRO));
    expect((await planCapsService.capsFor(orgId)).kind).toBe('capped');
    expect(getOrgSubscriptionMock).toHaveBeenCalledTimes(2);
  });

  it('the paid-plan gate and the caps share ONE subscription read', async () => {
    const orgId = await seedOrg();
    getOrgSubscriptionMock.mockResolvedValue(subscription(PRO));
    expect(await aiPlanGateService.hasPaidAiPlan(orgId)).toBe(true);
    expect((await planCapsService.capsFor(orgId)).kind).toBe('capped');
    expect(getOrgSubscriptionMock).toHaveBeenCalledTimes(1);
  });
});
