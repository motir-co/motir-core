// DTO types for the SEED REGISTRY (Story MOTIR-704 · MOTIR-708; decision MOTIR-706,
// page cmvsezd8800eihnoikhllqqev v2) — the shape that crosses the service boundary.
// No Prisma row leaks: enums become string unions, `Date`s become ISO strings, and
// the two template columns become one `source`. MOTIR-709 matches through the
// list, MOTIR-710 writes through the same repository, MOTIR-705 / 712 render it.

import type { HostingSize, HostingTarget, HostingUseCase } from '@/lib/hosting/vocabulary';
import type { ProjectRepoRoleDto } from '@/lib/dto/projectRepos';

/** `role` / `stack` on the one entry that serves every role and stack. */
export const SEED_REGISTRY_ANY = 'any' as const;

/** The `source` of an entry that seeds through `auto_init` rather than a template. */
export const SEED_REGISTRY_INITIALISED_SOURCE = 'initialised' as const;

export type SeedRegistryEntryStatusDto = 'active' | 'retired';

/** A GitHub template repository `/generate` copies — named, never derived from a key. */
export interface SeedTemplateSourceDto {
  owner: string;
  repo: string;
}

export interface SeedRegistryEntryDto {
  /** What a row's `seedSource` stores. Opaque: show `label`, never the key. */
  key: string;
  /** Earlier keys of the same entry; a row storing one resolves here. */
  legacyKeys: string[];
  role: ProjectRepoRoleDto | typeof SEED_REGISTRY_ANY;
  stack: string;
  label: string;
  source: SeedTemplateSourceDto | typeof SEED_REGISTRY_INITIALISED_SOURCE;
  useCases: HostingUseCase[];
  sizes: HostingSize[];
  /** Empty means the hosting port does not deploy what it seeds. */
  hostingTargets: HostingTarget[];
  status: SeedRegistryEntryStatusDto;
  /** The `project_repository` row it was promoted from (MOTIR-710). */
  promotedFrom: string | null;
  /** The commit SHA it was promoted at. */
  promotedRef: string | null;
  promotedBy: string | null;
  promotedAt: string | null;
  createdAt: string;
}

export interface SeedRegistryEntryListDto {
  items: SeedRegistryEntryDto[];
  /** Pass back as `cursor` for the next page; null on the last one. */
  nextCursor: string | null;
}

/** The list read's filters. Each one narrows; an absent one does not filter. */
export interface SeedRegistryListFilter {
  /** Entries seeding exactly this role (the `any` entry is not a role's entry). */
  role?: ProjectRepoRoleDto;
  stack?: string;
  status?: SeedRegistryEntryStatusDto;
  /** Entries whose `hostingTargets` CONTAINS this target. */
  hostingTarget?: string;
  /** Entries whose `useCases` CONTAINS this use case. */
  useCase?: string;
}

export interface SeedRegistryPage {
  /** Entries per page, 1–100; default 50. */
  limit?: number;
  /** The previous page's `nextCursor`. */
  cursor?: string | null;
}

/** An entry as a writer supplies it: the vocabulary-checked fields as plain strings. */
export interface SeedRegistryEntryInput {
  key: string;
  legacyKeys?: string[];
  role: ProjectRepoRoleDto | typeof SEED_REGISTRY_ANY;
  stack: string;
  label: string;
  source: SeedTemplateSourceDto | typeof SEED_REGISTRY_INITIALISED_SOURCE;
  useCases: string[];
  sizes: string[];
  hostingTargets: string[];
  status?: SeedRegistryEntryStatusDto;
  promotedFrom?: string | null;
  promotedRef?: string | null;
  promotedBy?: string | null;
  promotedAt?: Date | null;
}

/** An update: every field but the key is optional. */
export type SeedRegistryEntryPatch = Partial<Omit<SeedRegistryEntryInput, 'key'>>;

/** What establish needs from a resolved `seedSource`: the entry's current key and
 *  where its repository comes from. */
export interface ResolvedSeedDto {
  key: string;
  source: SeedTemplateSourceDto | typeof SEED_REGISTRY_INITIALISED_SOURCE;
}
