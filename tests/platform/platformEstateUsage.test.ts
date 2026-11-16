import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import type { RawPlatformUsage, RawProviderReconciliation } from '@/lib/ai/motirAiClient';
import { PROVIDER_RECONCILIATION } from '../fixtures/motirAiContract/platformReads';

/**
 * Usage & cost's read (Story MOTIR-727 · MOTIR-732) — `platformReadService.getEstateUsage`
 * over the real database: one `estate.read` per view whether or not motir-ai
 * answered, motir-ai unreachable as a state, the gate before anything.
 *
 * Since MOTIR-11376 the same view also reads the month's provider-bill
 * reconciliation: still one row, each read failing on its own, and no
 * reconciliation call at all for All time.
 */

let currentPrincipal: PlatformPrincipal | null = null;
const usageMock = vi.fn<(q: unknown) => Promise<RawPlatformUsage>>();
const reconciliationMock = vi.fn<(q: unknown) => Promise<RawProviderReconciliation>>();

vi.mock('@/lib/platform/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platform/auth')>('@/lib/platform/auth');
  return {
    ...actual,
    requirePlatformStaff: vi.fn(
      async (minimum: 'support' | 'operator' | 'superadmin' = 'support') => {
        if (!currentPrincipal) throw new NotPlatformStaffError();
        if (!actual.platformRoleAtLeast(currentPrincipal.role, minimum))
          throw new NotPlatformStaffError();
        return currentPrincipal;
      },
    ),
  };
});

vi.mock('@/lib/ai/motirAiClient', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/ai/motirAiClient')>('@/lib/ai/motirAiClient');
  return {
    ...actual,
    getPlatformUsage: (q: unknown) => usageMock(q),
    getPlatformProviderReconciliation: (q: unknown) => reconciliationMock(q),
  };
});

const { db } = await import('@/lib/db');
const { platformReadService } = await import('@/lib/services/platformReadService');
const { createTestUser } = await import('../fixtures/userFixtures');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');

const USAGE: RawPlatformUsage = {
  period: '2026-09',
  level: 'platform',
  entityId: '',
  categories: [],
  models: { planning_tokens: [], agent_tokens: [] },
  spend: {
    chargedCredits: 0,
    chargedCostMicroUsd: 0,
    costMicroUsdInclIndexing: 0,
    machineSeconds: 0,
  },
  orgsWithSpend: 0,
};

beforeEach(async () => {
  await adminDb.platformAuditLog.deleteMany();
  await truncateAuthTables();
  const user = await createTestUser({ email: 'ops+usage@moooon.net' });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: 'support' } });
  currentPrincipal = { userId: user.id, email: user.email, role: 'support' };
  usageMock.mockReset();
  usageMock.mockResolvedValue(USAGE);
  reconciliationMock.mockReset();
  reconciliationMock.mockResolvedValue(PROVIDER_RECONCILIATION);
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('platformReadService.getEstateUsage', () => {
  it('reads the platform level for the period and writes exactly one estate.read row', async () => {
    const result = await platformReadService.getEstateUsage(currentPrincipal!, '2026-09');
    expect(usageMock).toHaveBeenCalledWith({ period: '2026-09', level: 'platform' });
    expect(reconciliationMock).toHaveBeenCalledWith({ period: '2026-09' });
    expect(result).toEqual({
      period: '2026-09',
      usage: USAGE,
      reconciliation: PROVIDER_RECONCILIATION,
    });
    const rows = await adminDb.platformAuditLog.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'estate.read',
      targetKind: 'platform',
      targetLabel: 'estate usage 2026-09',
    });
  });

  it('motir-ai unreachable is `usage: null` — no throw — and the view is still audited once', async () => {
    usageMock.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await platformReadService.getEstateUsage(currentPrincipal!, 'all')).toEqual({
      period: 'all',
      usage: null,
      reconciliation: 'month_required',
    });
    expect(await adminDb.platformAuditLog.count()).toBe(1);
  });

  it('All time asks the reconciliation route nothing: the section says to choose a month', async () => {
    const result = await platformReadService.getEstateUsage(currentPrincipal!, 'all');
    expect(reconciliationMock).not.toHaveBeenCalled();
    expect(result).toEqual({ period: 'all', usage: USAGE, reconciliation: 'month_required' });
  });

  it('only the reconciliation read failing leaves the usage and writes one row', async () => {
    reconciliationMock.mockRejectedValue(new Error('motir-ai 503'));
    expect(await platformReadService.getEstateUsage(currentPrincipal!, '2026-09')).toEqual({
      period: '2026-09',
      usage: USAGE,
      reconciliation: null,
    });
    expect(await adminDb.platformAuditLog.count()).toBe(1);
  });

  it('only the usage read failing still answers the reconciliation, under one row', async () => {
    usageMock.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await platformReadService.getEstateUsage(currentPrincipal!, '2026-09')).toEqual({
      period: '2026-09',
      usage: null,
      reconciliation: PROVIDER_RECONCILIATION,
    });
    expect(await adminDb.platformAuditLog.count()).toBe(1);
  });

  it('refuses a non-staff caller before reading or auditing', async () => {
    const principal = currentPrincipal!;
    currentPrincipal = null;
    await expect(platformReadService.getEstateUsage(principal, 'all')).rejects.toBeInstanceOf(
      NotPlatformStaffError,
    );
    expect(usageMock).not.toHaveBeenCalled();
    expect(reconciliationMock).not.toHaveBeenCalled();
    expect(await adminDb.platformAuditLog.count()).toBe(0);
  });
});
