// Seed-registry E2E seed (Story MOTIR-704 · MOTIR-6415).
//
// Two jobs, both for `acceptance-seed-registry.spec.ts`:
//
//  1. THE HOSTING HAND-OFF. A row's hosting target is written by the plan's
//     hosting decision (`projectRepoSetService.setHosting`, MOTIR-9808), and the
//     starter that target implies is the matching's answer
//     (`seedRegistryService.matchSeedEntry`, MOTIR-709). No shipped surface makes
//     that hand-off yet — the decision card that will call both has not shipped —
//     so the spec reaches it HERE, through the same two services, and walks every
//     surface after it (the room, the picker, the PATCH, the establish) through
//     the product. The matching is never re-implemented: whatever it answers is
//     what the row records.
//  2. THE REGISTRY'S OWN STATE. The registry is migration-seeded platform data
//     that `resetDatabase()` never reaches, so a walk that promotes and retires
//     entries puts the shipped six back exactly as the migrations left them.
//
// Seeds ride the real services, the convention `repository-set-seed.ts` uses.

import { adminDb } from './db-reset';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { seedRegistryService } from '@/lib/services/seedRegistryService';
import {
  SEED_SOURCE_AWS_STARTER,
  SEED_SOURCE_EXPO_MOBILE_FOUNDATION,
  SEED_SOURCE_FLY_STARTER,
  SEED_SOURCE_INITIALISED,
  SEED_SOURCE_PLATFORM_STARTER,
  SEED_SOURCE_SPRING_API_FOUNDATION,
} from '@/lib/projectRepos/vocabulary';
import type { HostingSize, HostingTarget, HostingUseCase } from '@/lib/hosting/vocabulary';
import type { RepositorySetSeed } from './repository-set-seed';

/** Every entry the migrations ship — the registry a walk must leave behind. */
const SHIPPED_SEED_KEYS = [
  SEED_SOURCE_PLATFORM_STARTER,
  SEED_SOURCE_INITIALISED,
  SEED_SOURCE_FLY_STARTER,
  SEED_SOURCE_AWS_STARTER,
  SEED_SOURCE_EXPO_MOBILE_FOUNDATION,
  SEED_SOURCE_SPRING_API_FOUNDATION,
];

/** Drop every promoted entry and re-activate every shipped one. Idempotent. */
export async function resetSeedRegistry(): Promise<void> {
  await adminDb.seedRegistryEntry.deleteMany({ where: { key: { notIn: SHIPPED_SEED_KEYS } } });
  await adminDb.seedRegistryEntry.updateMany({ data: { status: 'active' } });
}

export interface HostingDecision {
  target: HostingTarget;
  useCase: HostingUseCase;
  size: HostingSize;
  /** The stack the decision names — what makes the matching a MATCH rather than
   *  a `no_stack_signal` default. */
  stack: string;
}

/** The project's row by name, as the derivation (or `addRow`) wrote it. */
export async function repoRowId(seed: RepositorySetSeed, name: string): Promise<string> {
  const row = await adminDb.projectRepo.findFirstOrThrow({
    where: { projectId: seed.projectId, name },
    select: { id: true },
  });
  return row.id;
}

/**
 * Apply a hosting decision to one not-yet-created row: record where it runs
 * (`setHosting`), then seed it from the entry the matching chooses for that
 * target, use, size and stack — the key AND how it was chosen, as the proposer
 * records them (`seedSource` + `seedMatch`). Answers the chosen key.
 */
export async function applyHostingDecision(
  seed: RepositorySetSeed,
  rowId: string,
  decision: HostingDecision,
): Promise<string> {
  const ctx = { userId: seed.userId, workspaceId: seed.workspaceId };
  const row = await projectRepoSetService.setHosting(
    rowId,
    { target: decision.target, useCase: decision.useCase, size: decision.size },
    ctx,
  );
  const match = await seedRegistryService.matchSeedEntry({
    role: row.role,
    stack: decision.stack,
    hostingTarget: decision.target,
    useCase: decision.useCase,
    size: decision.size,
  });
  await adminDb.projectRepo.update({
    where: { id: rowId },
    data: { seedSource: match.key, seedMatch: match.result },
  });
  return match.key;
}

/**
 * A NEW web row in the project, proposed with the registry's default and then
 * given a hosting decision — the "next plan" that meets the library as it
 * stands now. Answers the row's id.
 */
export async function proposeHostedWebRow(
  seed: RepositorySetSeed,
  name: string,
  decision: HostingDecision,
): Promise<{ rowId: string; seedSource: string }> {
  const ctx = { userId: seed.userId, workspaceId: seed.workspaceId };
  const row = await projectRepoSetService.addRow(seed.projectId, { role: 'web', name }, ctx);
  const seedSource = await applyHostingDecision(seed, row.id, decision);
  return { rowId: row.id, seedSource };
}
