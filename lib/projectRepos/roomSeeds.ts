import type { ProjectRepoDto, ProjectRepoRoomSeedDto } from '@/lib/dto/projectRepos';
import type { SeedRegistryEntryDto } from '@/lib/dto/seedRegistry';
import { seedEntryFitsRow } from '@/lib/projectRepos/seedMatching';
import {
  isOrganizationSeedSource,
  isPlanEditableState,
  SEED_SOURCE_INITIALISED,
} from '@/lib/projectRepos/vocabulary';

// THE ROOM'S SEEDS (Story MOTIR-704 · MOTIR-712; design MOTIR-705 §1) — what the
// Repositories room draws about each Motir-created row's starter, composed from
// the rows and ONE read of the registry. PURE, so the rule the picker offers by
// is the rule `patchRow` accepts by (`seedEntryFitsRow`, MOTIR-709), applied to
// the same entries, and a test can hold the two together.

/**
 * Each Motir-created row's seed, keyed by row id:
 *   · `entry` — the entry its `seedSource` names, by current or legacy key,
 *     retired ones included (a created row keeps the starter it came from);
 *   · `options` — on a row whose plan may still change, the ACTIVE entries that
 *     fit it: its role's own, ordered by label, then `initialised` last (design
 *     §1.3's "Any repository" group). Null on every other row.
 * An organisation's own row is left out: Motir never seeds what it did not create.
 */
export function roomSeedsFor(
  rows: readonly ProjectRepoDto[],
  entries: readonly SeedRegistryEntryDto[],
): Record<string, ProjectRepoRoomSeedDto> {
  const seeds: Record<string, ProjectRepoRoomSeedDto> = {};
  for (const row of rows) {
    if (isOrganizationSeedSource(row.seedSource)) continue;
    seeds[row.id] = {
      entry: entryForKey(row.seedSource, entries),
      options: isPlanEditableState(row.state) ? optionsFor(row, entries) : null,
    };
  }
  return seeds;
}

/** The entry a stored `seedSource` names — its current key first, then a legacy key. */
function entryForKey(
  key: string,
  entries: readonly SeedRegistryEntryDto[],
): SeedRegistryEntryDto | null {
  return (
    entries.find((entry) => entry.key === key) ??
    entries.find((entry) => entry.legacyKeys.includes(key)) ??
    null
  );
}

function optionsFor(
  row: ProjectRepoDto,
  entries: readonly SeedRegistryEntryDto[],
): SeedRegistryEntryDto[] {
  const fitting = entries.filter((entry) =>
    seedEntryFitsRow(entry, { role: row.role, hostingTarget: row.hostingTarget }),
  );
  const own = fitting
    .filter((entry) => entry.key !== SEED_SOURCE_INITIALISED)
    .sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
  const initialised = fitting.filter((entry) => entry.key === SEED_SOURCE_INITIALISED);
  return [...own, ...initialised];
}
