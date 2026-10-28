import type { ProjectRepoRole } from '@/generated/prisma/client';
import { HOSTING_TARGETS, type HostingTarget } from '@/lib/hosting/vocabulary';
import { defaultSeedSourceForRole } from '@/lib/projectRepos/vocabulary';

// The seed matching's answer PER HOSTING TARGET (Story MOTIR-9796 · MOTIR-10014):
// the starter a new Motir repo is seeded from when it runs on a given target.
//
// The planner names this answer in a hosting decision card, so it must come from
// the MATCHING and never from text: no starter key is written here or in either
// planning corpus. Today the only matching shipped keys on role alone
// (`defaultSeedSourceForRole`), so every target gets the same answer. MOTIR-704
// replaces it with matching on use case, size and target, and changes only the
// body of `seedSourceForHostingTarget` — plans then name the target-specific
// starters with no change to the rule text.

/** The role a new app takes when a hosting decision names its starter. */
const NEW_APP_ROLE: ProjectRepoRole = 'web';

/** The starter a new Motir repo on `_target` is seeded from, as the matching answers it. */
export function seedSourceForHostingTarget(_target: HostingTarget): string {
  return defaultSeedSourceForRole(NEW_APP_ROLE);
}

/** The matching's answer for EVERY hosting target, so a new target cannot be left out. */
export function starterByHostingTarget(): Record<HostingTarget, string> {
  return Object.fromEntries(
    HOSTING_TARGETS.map((target) => [target, seedSourceForHostingTarget(target)]),
  ) as Record<HostingTarget, string>;
}
