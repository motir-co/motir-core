import type { ProjectRepoRoleDto } from '@/lib/dto/projectRepos';
import type { SeedRegistryEntryDto } from '@/lib/dto/seedRegistry';
import {
  SEED_SOURCE_INITIALISED,
  SEED_SOURCE_PLATFORM_STARTER,
} from '@/lib/projectRepos/vocabulary';

// THE DEFAULT MAP (decision MOTIR-706 v2, 3.8 — page cmvsezd8800eihnoikhllqqev),
// as a pure rule over the registry's ACTIVE entries, so the read
// (`seedRegistryService.defaultSeedSourceForRole`) and a test can apply it alike.
//
//   · `web` → `nextjs-prisma-serverless-starter`. Fixed by the page: changing the
//     web default is an amendment to it, not an operator action, which is why it
//     is a named key here rather than the newest web entry.
//   · every other role → the matching for that role with NO target (3.5): the
//     active entries of that role whose `hostingTargets` is empty, the most
//     recently promoted first (`promotedAt`, else `createdAt`), then `key`. That
//     yields `expo-mobile-foundation` for `mobile` and `spring-api-foundation` for
//     `api` once MOTIR-9813 registers them.
//   · no candidate → `initialised`. Never a retired entry and never a guess.

type DefaultCandidate = Pick<
  SeedRegistryEntryDto,
  'key' | 'role' | 'hostingTargets' | 'status' | 'promotedAt' | 'createdAt'
>;

/** The registry's default `seedSource` for a role, over `entries`. */
export function roleDefaultSeedKey(
  role: ProjectRepoRoleDto,
  entries: readonly DefaultCandidate[],
): string {
  const active = entries.filter((entry) => entry.status === 'active');
  if (role === 'web') {
    return active.some((entry) => entry.key === SEED_SOURCE_PLATFORM_STARTER)
      ? SEED_SOURCE_PLATFORM_STARTER
      : SEED_SOURCE_INITIALISED;
  }
  const [best] = active
    .filter((entry) => entry.role === role && entry.hostingTargets.length === 0)
    .sort(byMostRecentlyPromoted);
  return best?.key ?? SEED_SOURCE_INITIALISED;
}

type Promotable = Pick<SeedRegistryEntryDto, 'key' | 'promotedAt' | 'createdAt'>;

/** 706 3.5 rule 5, the matching's tie-break: `promotedAt`, else `createdAt`,
 *  newest first; then `key` ascending, so the answer is deterministic. */
export function byMostRecentlyPromoted(a: Promotable, b: Promotable): number {
  const at = (entry: Promotable) => entry.promotedAt ?? entry.createdAt;
  return at(b).localeCompare(at(a)) || a.key.localeCompare(b.key);
}
