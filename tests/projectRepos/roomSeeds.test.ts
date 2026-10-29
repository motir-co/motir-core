import { describe, expect, it } from 'vitest';
import { roomSeedsFor } from '@/lib/projectRepos/roomSeeds';
import { seedEntryFitsRow } from '@/lib/projectRepos/seedMatching';
import {
  SEED_SOURCE_INITIALISED,
  SEED_SOURCE_ORGANIZATION,
  SEED_SOURCE_PLATFORM_STARTER,
} from '@/lib/projectRepos/vocabulary';
import { SHIPPED_ENTRIES, seedEntry, seedRow } from '../fixtures/seedRegistryFixtures';

// THE ROOM'S SEEDS (Story MOTIR-704 · MOTIR-712; design MOTIR-705 §1), pure: the
// entry each Motir-created row names, by current or legacy key; the options a
// not-yet-created row may be re-pointed to — exactly what `patchRow` accepts
// (`seedEntryFitsRow`), its role's own by label, `initialised` last; and nothing
// at all for the organisation's own rows.

const ENTRIES = [
  ...SHIPPED_ENTRIES,
  seedEntry('zeta-fly', { label: 'Zeta · Fly', hostingTargets: ['fly'] }),
  seedEntry('alpha-fly', {
    label: 'Alpha · Fly',
    hostingTargets: ['fly'],
    legacyKeys: ['old-alpha'],
  }),
  seedEntry('retired-fly', { label: 'Retired · Fly', status: 'retired' }),
  seedEntry('api-fly', { role: 'api', stack: 'hono', label: 'API · Fly' }),
];

describe('roomSeedsFor', () => {
  it('offers a not-yet-created row exactly what fits it, its role’s own by label, initialised last', () => {
    const row = seedRow({ id: 'r1', hostingTarget: 'fly', seedSource: 'zeta-fly' });
    const seeds = roomSeedsFor([row], ENTRIES);
    expect(seeds.r1?.entry?.key).toBe('zeta-fly');
    expect(seeds.r1?.options?.map((e) => e.key)).toEqual([
      'alpha-fly',
      'zeta-fly',
      SEED_SOURCE_INITIALISED,
    ]);
    for (const option of seeds.r1?.options ?? []) {
      expect(seedEntryFitsRow(option, { role: row.role, hostingTarget: row.hostingTarget })).toBe(
        true,
      );
    }
  });

  it('resolves a row that still stores a legacy key, and keeps a retired entry it names', () => {
    const seeds = roomSeedsFor(
      [
        seedRow({ id: 'legacy', seedSource: 'old-alpha', state: 'created' }),
        seedRow({ id: 'retired', seedSource: 'retired-fly', state: 'created' }),
      ],
      ENTRIES,
    );
    expect(seeds.legacy?.entry?.key).toBe('alpha-fly');
    expect(seeds.retired?.entry?.status).toBe('retired');
    // A created row's starter can no longer change, so it is offered nothing.
    expect(seeds.legacy?.options).toBeNull();
  });

  it('offers a failed row too, and an unknown key resolves to no entry', () => {
    const seeds = roomSeedsFor(
      [seedRow({ id: 'f', state: 'failed', seedSource: 'gone', hostingTarget: 'serverless' })],
      ENTRIES,
    );
    expect(seeds.f?.entry).toBeNull();
    expect(seeds.f?.options?.map((e) => e.key)).toEqual([
      SEED_SOURCE_PLATFORM_STARTER,
      SEED_SOURCE_INITIALISED,
    ]);
  });

  it('leaves the organisation’s own rows out', () => {
    const seeds = roomSeedsFor(
      [seedRow({ id: 'own', seedSource: SEED_SOURCE_ORGANIZATION, state: 'connected' })],
      ENTRIES,
    );
    expect(seeds).toEqual({});
  });
});
