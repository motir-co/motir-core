import type { ProjectRepoDto } from '@/lib/dto/projectRepos';
import type { SeedRegistryEntryDto } from '@/lib/dto/seedRegistry';
import {
  SEED_SOURCE_INITIALISED,
  SEED_SOURCE_PLATFORM_STARTER,
} from '@/lib/projectRepos/vocabulary';

// Seed-registry DTO fixtures for the room's seed and the starter library
// (MOTIR-712): an entry and a not-yet-created web row, each overridable.

const AT = '2026-10-20T09:00:00.000Z';

export function seedEntry(
  key: string,
  over: Partial<SeedRegistryEntryDto> = {},
): SeedRegistryEntryDto {
  return {
    key,
    legacyKeys: [],
    role: 'web',
    stack: 'nextjs',
    label: `Label ${key}`,
    source: { owner: 'motir-co', repo: key },
    useCases: ['mvp'],
    sizes: ['small'],
    hostingTargets: ['fly'],
    status: 'active',
    promotedFrom: null,
    promotedRef: null,
    promotedBy: null,
    promotedAt: null,
    createdAt: AT,
    ...over,
  };
}

/** The two entries Motir ships (decision MOTIR-706 v2). */
export const SHIPPED_ENTRIES: SeedRegistryEntryDto[] = [
  seedEntry(SEED_SOURCE_PLATFORM_STARTER, {
    label: 'Next.js · serverless',
    useCases: ['internal_tool', 'mvp'],
    sizes: ['small', 'medium'],
    hostingTargets: ['serverless'],
  }),
  seedEntry(SEED_SOURCE_INITIALISED, {
    role: 'any',
    stack: 'any',
    label: 'Initialised repository',
    source: 'initialised',
    useCases: ['internal_tool', 'mvp', 'planned_product'],
    sizes: ['small', 'medium', 'large'],
    hostingTargets: [],
  }),
];

export function seedRow(over: Partial<ProjectRepoDto> = {}): ProjectRepoDto {
  return {
    id: 'row-web',
    projectId: 'proj-1',
    role: 'web',
    label: null,
    name: 'acme-web',
    seedSource: SEED_SOURCE_PLATFORM_STARTER,
    state: 'proposed',
    failureReason: null,
    proposalSignal: 'default-web',
    seedMatch: 'matched',
    realizedRepo: null,
    established: false,
    takeover: null,
    access: { state: 'not_invited', login: null, invitationUrl: null },
    hostingTarget: 'serverless',
    hostingUseCase: 'mvp',
    hostingSize: 'small',
    position: 'a0',
    createdAt: AT,
    updatedAt: AT,
    ...over,
  };
}
