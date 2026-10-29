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

// ── The operator console's starter library (MOTIR-712; design MOTIR-705 §2–§3) ──

/** The library's status filter: one status, or both (`all`). */
export type SeedRegistryConsoleStatus = SeedRegistryEntryStatusDto | 'all';

/** The library's hosting filter: entries that deploy to a target, or entries
 *  that deploy nowhere (`none` — "Not deployed by Motir hosting"). */
export type SeedRegistryConsoleTarget = HostingTarget | 'none';

export interface SeedRegistryConsoleFilter {
  role?: ProjectRepoRoleDto;
  status: SeedRegistryConsoleStatus;
  target?: SeedRegistryConsoleTarget;
}

/** Who retired an entry, when and why — read from the platform audit log, which
 *  is the only place a retirement's reason is kept. */
export interface SeedRegistryRetirementDto {
  /** Null when the operator's account no longer exists. */
  byEmail: string | null;
  at: string;
  reason: string | null;
}

/** One row of the library: the entry plus the provenance the table spells out. */
export interface SeedRegistryConsoleRowDto {
  entry: SeedRegistryEntryDto;
  /** A role's default (decision MOTIR-706 v2 §3.8): never retired from the console. */
  isDefault: boolean;
  /** The promoting operator's email; null for a shipped entry or a removed account. */
  promotedByEmail: string | null;
  /** `owner/repo` of the repository it was promoted from, when that row still names one. */
  promotedFromRepo: string | null;
  /** Set on a retired entry whose retirement the audit log records. */
  retirement: SeedRegistryRetirementDto | null;
}

/** One numbered page of the library, newest first, with the filter's total. */
export interface SeedRegistryConsolePageDto {
  rows: SeedRegistryConsoleRowDto[];
  total: number;
  /** 1-based. */
  page: number;
  pageSize: number;
}

/** A repository the promote form's picker offers (design MOTIR-705 §3.1): every
 *  repository Motir created, the ones that cannot be promoted yet included and
 *  marked, so an operator who came looking for one learns why it is held. */
export interface SeedPromotionSourceDto {
  /** The `project_repository` row id the promote route takes. */
  id: string;
  name: string;
  /** `owner/repo` on GitHub, or null before the repository exists. */
  repoRef: string | null;
  role: ProjectRepoRoleDto;
  state: string;
  projectName: string;
  /** Why it cannot be picked, or null when it can. */
  unavailable: 'not_created' | 'leaving' | null;
}
