import { afterAll, beforeAll } from 'vitest';
import type { SeedRegistryEntry } from '@/generated/prisma/client';
import {
  SEED_SOURCE_AWS_STARTER,
  SEED_SOURCE_EXPO_MOBILE_FOUNDATION,
  SEED_SOURCE_FLY_STARTER,
  SEED_SOURCE_INITIALISED,
  SEED_SOURCE_PLATFORM_STARTER,
  SEED_SOURCE_SPRING_API_FOUNDATION,
} from '@/lib/projectRepos/vocabulary';
import { adminDb } from './adminDb';

// The seed registry is migration-seeded platform data that no truncate reaches,
// and a worker's database is shared by every file that worker runs. So a file
// that registers entries removes ONLY what it registered — never a shipped row,
// which a later file in the same worker reads (MOTIR-9813).

/** The two seeds the registry shipped with (`20261028200000_seed_registry`). */
export const ORIGINAL_SEED_KEYS = [SEED_SOURCE_PLATFORM_STARTER, SEED_SOURCE_INITIALISED];

/** The four starter entries `20261029100000_seed_registry_starter_entries` adds. */
export const STARTER_ENTRY_KEYS = [
  SEED_SOURCE_FLY_STARTER,
  SEED_SOURCE_AWS_STARTER,
  SEED_SOURCE_EXPO_MOBILE_FOUNDATION,
  SEED_SOURCE_SPRING_API_FOUNDATION,
];

/** Every entry the migrations ship. */
export const SHIPPED_SEED_KEYS = [...ORIGINAL_SEED_KEYS, ...STARTER_ENTRY_KEYS];

/** Drop what a test registered and re-activate what it retired. */
export async function resetSeedRegistry(): Promise<void> {
  await adminDb.seedRegistryEntry.deleteMany({ where: { key: { notIn: SHIPPED_SEED_KEYS } } });
  await adminDb.seedRegistryEntry.updateMany({ data: { status: 'active' } });
}

/**
 * Set the four starter entries aside for one file, and put them back exactly as
 * found when it ends. For a file that proves the registry's own CRUD and reads
 * from the two original seeds — it registers entries under these same keys —
 * rather than a file about what the migrations ship.
 */
export function withOnlyOriginalSeeds(): void {
  let setAside: SeedRegistryEntry[] = [];
  beforeAll(async () => {
    setAside = await adminDb.seedRegistryEntry.findMany({
      where: { key: { in: STARTER_ENTRY_KEYS } },
    });
    await adminDb.seedRegistryEntry.deleteMany({ where: { key: { in: STARTER_ENTRY_KEYS } } });
  });
  afterAll(async () => {
    await adminDb.seedRegistryEntry.deleteMany({ where: { key: { in: STARTER_ENTRY_KEYS } } });
    await adminDb.seedRegistryEntry.createMany({ data: setAside });
  });
}
