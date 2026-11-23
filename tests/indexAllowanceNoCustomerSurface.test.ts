import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { RawSubscriptionResponse, RawUsageResponse } from '@/lib/ai/types';
import { adminDb } from './helpers/adminDb';

// NOTHING CUSTOMER-FACING CHANGES (MOTIR-4593 AC 9 · Story MOTIR-4335).
//
// ⚠️ Motir does not charge for code indexing. The allowance is internal, so the
// organisation's billing and usage payloads must be IDENTICAL before and after the
// two things this card writes on motir-core's side: a recorded index pause on a
// repository, and an index container's metered cost row. Asserted over the
// payloads themselves, not by reading the components.
//
// motir-ai is the boundary leaf, mocked exactly as `billingService.test.ts` mocks
// it; the organisation, the repository and the cost row are real rows.

const getOrgUsageMock = vi.fn<(q: unknown) => Promise<RawUsageResponse>>();
const getOrgSubscriptionMock = vi.fn<(q: unknown) => Promise<RawSubscriptionResponse>>();
vi.mock('@/lib/ai/motirAiClient', () => ({
  getOrgUsage: (q: unknown) => getOrgUsageMock(q),
  getOrgSubscription: (q: unknown) => getOrgSubscriptionMock(q),
  getPendingPlanChange: async () => ({ pendingDowngrade: null }),
}));
vi.mock('@/lib/billing/seatSync', () => ({ enqueueScaledTrackerSeatSync: vi.fn() }));

const { billingService } = await import('@/lib/services/billingService');
const { aiUsageService } = await import('@/lib/services/aiUsageService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { githubInstallationService } = await import('@/lib/services/githubInstallationService');
const { createTestUser } = await import('./fixtures/userFixtures');
const { truncateAuthTables } = await import('./helpers/db');

const USAGE: RawUsageResponse = {
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
};

beforeEach(async () => {
  await truncateAuthTables();
  getOrgUsageMock.mockReset().mockResolvedValue(USAGE);
  getOrgSubscriptionMock.mockReset().mockResolvedValue({
    status: 'active',
    currentPeriodEnd: '2026-10-01T00:00:00.000Z',
    priceId: 'price_standard',
    planTier: { key: 'standard', name: 'Standard', monthlyCreditAllotment: 2000 },
  });
  process.env['MOTIR_CLOUD'] = 'true';
});

afterEach(() => {
  delete process.env['MOTIR_CLOUD'];
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the index allowance reaches no customer surface (AC 9)', () => {
  it('billing and usage payloads are identical before and after an index pause and an index container’s cost', async () => {
    const owner = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const organizationId = workspace.organizationId;
    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: {
        installationId: 'inst-surface',
        accountLogin: 'acme',
        accountType: 'Organization',
      },
      repos: [
        {
          providerRepoId: '9001',
          owner: 'acme',
          name: 'web',
          defaultBranch: 'main',
          archived: false,
        },
      ],
    });

    const read = async () => ({
      billing: await billingService.getBillingStatus({ organizationId, actorUserId: owner.id }),
      usage: await aiUsageService.getUsage({ organizationId, actorUserId: owner.id }),
    });
    const before = await read();

    // What this card writes on motir-core's side.
    await adminDb.githubRepo.updateMany({
      where: { owner: 'acme', name: 'web' },
      data: { indexPausedReason: 'paused_index_no_credit', indexPausedAt: new Date() },
    });
    const at = new Date();
    await adminDb.ciContainerUsage.create({
      data: {
        containerProvider: 'fly',
        handleId: 'machine-index-1',
        containerRegion: 'iad',
        workspaceId: workspace.id,
        organizationId,
        workload: 'index',
        repoFullName: 'acme/web',
        cpuKind: 'performance',
        cpus: 2,
        memoryMb: 4096,
        containerCreatedAt: at,
        containerStartedAt: at,
        containerStoppedAt: at,
        billableSeconds: 1840,
        periodStart: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)),
        usdPerSecond: new Prisma.Decimal('0.000031636049'),
        costUsd: new Prisma.Decimal('0.058210330160'),
        rateEffectiveFrom: new Date('2026-01-01T00:00:00Z'),
        terminalState: 'destroyed',
        teardownReason: 'job_completed',
      },
    });

    const after = await read();
    expect(after).toEqual(before);

    const serialized = JSON.stringify(after);
    expect(serialized).not.toMatch(/index|paused_index|allowance/i);
  });
});
