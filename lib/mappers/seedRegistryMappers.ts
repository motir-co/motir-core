import type { SeedRegistryEntry } from '@/generated/prisma/client';
import {
  SEED_REGISTRY_ANY,
  SEED_REGISTRY_INITIALISED_SOURCE,
  type SeedRegistryEntryDto,
} from '@/lib/dto/seedRegistry';

/** One stored entry as the DTO (MOTIR-708). The two template columns become one
 *  `source`; a NULL role or stack is the `any` of the `initialised` entry. */
export function toSeedRegistryEntryDto(row: SeedRegistryEntry): SeedRegistryEntryDto {
  return {
    key: row.key,
    legacyKeys: row.legacyKeys,
    role: row.role ?? SEED_REGISTRY_ANY,
    stack: row.stack ?? SEED_REGISTRY_ANY,
    label: row.label,
    source:
      row.templateOwner !== null && row.templateRepo !== null
        ? { owner: row.templateOwner, repo: row.templateRepo }
        : SEED_REGISTRY_INITIALISED_SOURCE,
    useCases: row.useCases,
    sizes: row.sizes,
    hostingTargets: row.hostingTargets,
    status: row.status,
    promotedFrom: row.promotedFrom,
    promotedRef: row.promotedRef,
    promotedBy: row.promotedBy,
    promotedAt: row.promotedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
