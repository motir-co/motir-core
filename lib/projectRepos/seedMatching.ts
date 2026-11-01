import type { ProjectRepoRoleDto, ProjectRepoSeedMatchDto } from '@/lib/dto/projectRepos';
import type { SeedRegistryEntryDto } from '@/lib/dto/seedRegistry';
import type { HostingSize, HostingTarget, HostingUseCase } from '@/lib/hosting/vocabulary';
import { byMostRecentlyPromoted, roleDefaultSeedKey } from '@/lib/seedRegistry/defaults';
import { SEED_SOURCE_INITIALISED } from '@/lib/projectRepos/vocabulary';

// THE SEED MATCHING (Story MOTIR-704 · MOTIR-709) — which registry entry a row
// seeds from, by decision MOTIR-706 v2 §3.5 (page cmvsezd8800eihnoikhllqqev).
// PURE: it ranks the entries it is given, so the proposer, the planner's
// per-target answer and a person's re-point all apply the same rule
// (`seedRegistryService` reads the registry and calls it).
//
// The rule, in order:
//   1. Candidates: ACTIVE entries of the row's role. the initialised entry is not ranked
//      against them: it is the fallback rule 6 answers.
//   2. Target is HARD. A row with a target keeps entries whose `hostingTargets`
//      contains it — a starter that cannot deploy there is wrong, not weaker. A
//      row of a role the hosting port does not deploy (every role but `web`)
//      keeps entries with an EMPTY `hostingTargets`. A `web` row whose target is
//      still null is not matched: it takes the role default (3.8), `no_target`.
//   3. Stack is HARD only when a signal names one; with none it is not checked
//      and the result says `no_stack_signal` — a stack is never guessed.
//   4. Use case, then size, are SOFT: they order the candidates, never exclude.
//   5. Ties: the most recently promoted (`promotedAt`, else `createdAt`), then key.
//   6. No candidate: the initialised entry, result no_match. Never a retired entry.
// The answer is always an entry's CURRENT key, never a legacy one.

/** What the matching reads about a row. Target, use case and size come from the
 *  row as stored (MOTIR-9808); the matching never derives them. */
export interface SeedMatchInput {
  role: ProjectRepoRoleDto;
  /** A stack a signal NAMED — null when none did, which is every row today. */
  stack?: string | null;
  hostingTarget?: HostingTarget | null;
  useCase?: HostingUseCase | null;
  size?: HostingSize | null;
}

export interface SeedMatch {
  key: string;
  result: ProjectRepoSeedMatchDto;
}

type Candidate = Pick<
  SeedRegistryEntryDto,
  | 'key'
  | 'role'
  | 'stack'
  | 'status'
  | 'useCases'
  | 'sizes'
  | 'hostingTargets'
  | 'promotedAt'
  | 'createdAt'
>;

/** The role the hosting port deploys; every other role runs nowhere it reaches. */
const DEPLOYED_ROLE: ProjectRepoRoleDto = 'web';

/**
 * Whether an entry may seed a row of this role and target — rule 1 and rule 2,
 * the HARD filter a person's re-point is held to as well. An any-role entry with
 * no targets (the initialised entry) fits EVERY row: it is what rule 6 answers when
 * nothing else does, so a person may always choose it too.
 */
export function seedEntryFitsRow(
  entry: Pick<Candidate, 'role' | 'status' | 'hostingTargets'>,
  row: { role: ProjectRepoRoleDto; hostingTarget?: HostingTarget | null },
): boolean {
  if (entry.status !== 'active') return false;
  if (entry.role === 'any' && entry.hostingTargets.length === 0) return true;
  if (entry.role !== row.role && entry.role !== 'any') return false;
  const target = row.hostingTarget ?? null;
  if (target !== null) return entry.hostingTargets.includes(target);
  if (row.role !== DEPLOYED_ROLE) return entry.hostingTargets.length === 0;
  return true;
}

/** Choose the entry a row seeds from, over `entries` (the registry's). */
export function matchSeedEntry(input: SeedMatchInput, entries: readonly Candidate[]): SeedMatch {
  const target = input.hostingTarget ?? null;
  if (input.role === DEPLOYED_ROLE && target === null) {
    return { key: roleDefaultSeedKey(input.role, entries), result: 'no_target' };
  }

  const stack = input.stack ?? null;
  const candidates = entries.filter(
    (entry) =>
      entry.role === input.role &&
      seedEntryFitsRow(entry, { role: input.role, hostingTarget: target }) &&
      (stack === null || entry.stack === stack),
  );
  if (candidates.length === 0) return { key: SEED_SOURCE_INITIALISED, result: 'no_match' };

  const [best] = [...candidates].sort(
    (a, b) => softRank(b, input) - softRank(a, input) || byMostRecentlyPromoted(a, b),
  );
  return { key: best!.key, result: stack === null ? 'no_stack_signal' : 'matched' };
}

/** Rule 4: 2 for use case AND size, 1 for use case, 0 otherwise. A null input
 *  skips its step. */
function softRank(entry: Candidate, input: SeedMatchInput): number {
  const useCase = input.useCase ?? null;
  const size = input.size ?? null;
  const fitsUseCase = useCase === null || entry.useCases.includes(useCase);
  const fitsSize = size === null || entry.sizes.includes(size);
  if (fitsUseCase && fitsSize) return 2;
  return fitsUseCase ? 1 : 0;
}
