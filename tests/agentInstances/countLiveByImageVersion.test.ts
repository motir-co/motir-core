import { afterEach, describe, expect, it, vi } from 'vitest';
import { catalogRegistry, imageCatalogSeam } from '@/lib/agentInstances/imageCatalog';
import { agentInstanceRepository } from '@/lib/repositories/agentInstanceRepository';

// The two agent-instance reads the Fleet status page's agent-instance card
// (MOTIR-10886) adds: how many live instances run each image version, and the
// registry the published-image catalog reads tags through. They live here so
// the agent-instances coverage lane measures them with the rest of the
// repository; the card's own rules are pinned in
// `tests/fleetStatus/fleetStatusImagesService.test.ts`.

afterEach(() => {
  imageCatalogSeam.reset();
});

describe('countLiveByImageVersion', () => {
  it('groups the LIVE instances by image version, counting each group', async () => {
    const groupBy = vi.fn().mockResolvedValue([
      { imageVersion: '0.18.0', _count: { _all: 3 } },
      { imageVersion: null, _count: { _all: 1 } },
    ]);
    const rows = await agentInstanceRepository.countLiveByImageVersion({
      agentInstance: { groupBy },
    } as never);
    expect(rows).toEqual([
      { imageVersion: '0.18.0', count: 3 },
      { imageVersion: null, count: 1 },
    ]);
    expect(groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ by: ['imageVersion'], _count: { _all: true } }),
    );
  });
});

describe('catalogRegistry', () => {
  it('answers the registry the catalog reads, the seam’s stub included', async () => {
    const stub = { listTags: async () => ['base-0.18.0'], resolveDigest: async () => null };
    imageCatalogSeam.setRegistry(stub);
    expect(catalogRegistry()).toBe(stub);
    imageCatalogSeam.reset();
    expect(catalogRegistry()).not.toBe(stub);
  });
});
