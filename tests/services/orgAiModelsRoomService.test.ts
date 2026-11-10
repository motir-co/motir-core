import { afterEach, describe, expect, it, vi } from 'vitest';

// The org AI models room's copy facts (MOTIR-10846): whether the org is meta and
// its plan's name. Copy only, so neither read may throw: a fact that cannot be
// read answers its neutral value.

vi.mock('server-only', () => ({}));
const findByIdInTx = vi.hoisted(() => vi.fn());
const readOrgPlan = vi.hoisted(() => vi.fn());
const withOrgServiceWriteContext = vi.hoisted(() =>
  vi.fn(async (_id: string, fn: (tx: unknown) => unknown) => fn({})),
);
vi.mock('@/lib/organizations/context', () => ({ withOrgServiceWriteContext }));
vi.mock('@/lib/repositories/organizationRepository', () => ({
  organizationRepository: { findByIdInTx },
}));
vi.mock('@/lib/services/orgPlanReader', () => ({ readOrgPlan }));

const { orgAiModelsRoomService } = await import('@/lib/services/orgAiModelsRoomService');

afterEach(() => vi.clearAllMocks());

describe('orgAiModelsRoomService.context', () => {
  it('a subscribed org: its meta flag and its plan name', async () => {
    findByIdInTx.mockResolvedValue({ isMeta: false });
    readOrgPlan.mockResolvedValue({
      kind: 'subscription',
      subscription: { planTier: { key: 'standard', name: 'Standard' } },
    });
    await expect(orgAiModelsRoomService.context('org_1')).resolves.toEqual({
      isMeta: false,
      planName: 'Standard',
    });
    expect(findByIdInTx).toHaveBeenCalledWith('org_1', {});
  });

  it('the meta org is exempt and names no plan', async () => {
    findByIdInTx.mockResolvedValue({ isMeta: true });
    readOrgPlan.mockResolvedValue({ kind: 'exempt' });
    await expect(orgAiModelsRoomService.context('org_1')).resolves.toEqual({
      isMeta: true,
      planName: null,
    });
  });

  it('an unreadable row, a missing row or a missing tier answers the neutral values', async () => {
    withOrgServiceWriteContext.mockRejectedValueOnce(new Error('db down'));
    readOrgPlan.mockResolvedValue({ kind: 'subscription', subscription: { planTier: null } });
    await expect(orgAiModelsRoomService.context('org_1')).resolves.toEqual({
      isMeta: false,
      planName: null,
    });
    findByIdInTx.mockResolvedValue(null);
    readOrgPlan.mockResolvedValue({ kind: 'unknown' });
    await expect(orgAiModelsRoomService.context('org_1')).resolves.toEqual({
      isMeta: false,
      planName: null,
    });
  });
});
