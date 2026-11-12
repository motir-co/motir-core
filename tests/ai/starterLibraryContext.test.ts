import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { resolveStarterLibraryContext } from '@/lib/ai/starterLibraryContext';
import { seedRegistryService } from '@/lib/services/seedRegistryService';
import { SEED_SOURCE_FLY_STARTER } from '@/lib/projectRepos/vocabulary';
import { adminDb } from '../helpers/adminDb';
import { resetSeedRegistry, SHIPPED_SEED_KEYS } from '../helpers/seedRegistryShipped';

// Story MOTIR-10162 · Subtask MOTIR-11041 — the STARTER LIBRARY both planning
// hand-offs carry: every ACTIVE seed registry entry, whole, read at call time.
// Real Postgres over the migration-seeded registry; a file that retires an entry
// puts it back (`resetSeedRegistry`), because the registry is shared platform data.

afterEach(async () => {
  await resetSeedRegistry();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('resolveStarterLibraryContext', () => {
  it('returns every shipped active entry WHOLE — the registry DTO, not a narrowed copy', async () => {
    const library = await resolveStarterLibraryContext();
    expect(library.map((e) => e.key).sort()).toEqual([...SHIPPED_SEED_KEYS].sort());
    // Each entry is exactly what the registry service answers for its key.
    for (const entry of library) {
      expect(entry).toEqual(await seedRegistryService.getByKey(entry.key));
      expect(entry.status).toBe('active');
    }
    // The coverage fields a planner judges by are all present on the wire shape.
    const fly = library.find((e) => e.key === SEED_SOURCE_FLY_STARTER)!;
    for (const field of ['label', 'role', 'stack', 'useCases', 'sizes', 'hostingTargets']) {
      expect(fly).toHaveProperty(field);
    }
  });

  it('leaves a RETIRED entry out, and the next read follows a retirement made between calls', async () => {
    expect((await resolveStarterLibraryContext()).map((e) => e.key)).toContain(
      SEED_SOURCE_FLY_STARTER,
    );
    await adminDb.seedRegistryEntry.update({
      where: { key: SEED_SOURCE_FLY_STARTER },
      data: { status: 'retired' },
    });
    const after = (await resolveStarterLibraryContext()).map((e) => e.key);
    expect(after).not.toContain(SEED_SOURCE_FLY_STARTER);
    expect(after).toHaveLength(SHIPPED_SEED_KEYS.length - 1);
  });

  it('answers `[]` when the registry holds no active entry — an answer, not an error', async () => {
    await adminDb.seedRegistryEntry.updateMany({ data: { status: 'retired' } });
    await expect(resolveStarterLibraryContext()).resolves.toEqual([]);
  });

  it('is the same list as `listActiveEntries` — one rule, no second filter', async () => {
    expect(await resolveStarterLibraryContext()).toEqual(
      await seedRegistryService.listActiveEntries(),
    );
  });
});
