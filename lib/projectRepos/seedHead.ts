// IS A MOTIR-CREATED REPOSITORY STILL ONLY ITS SEED? (MOTIR-4589)
//
// A repository Motir creates for a project's repository set holds exactly its
// seed at the moment it is created: the template `/generate` copied, or the
// initialised README plus the CI stub. Its code graph would be the template's
// graph — the planner learns nothing it could not be told for free, and the
// fleet pays for a whole-tree build that is attributed against the organisation's
// allotment (MOTIR-4541). So a created repository's FIRST index waits for a
// commit of the project's own.
//
// ⚠️ THIS IS A SECOND, NARROWER CONDITION — NOT A REPLACEMENT FOR THE
// HAS-NO-GRAPH GATE (MOTIR-1961). That gate is about indexedness, and it is the
// self-heal: a repository with no graph is offered again on every reconcile.
// This one only answers "is there anything in it worth indexing yet?", and it
// answers YES for every repository it knows nothing about — a connected row, a
// row created before `seedHeadSha` existed, a row whose head could not be read
// at creation. Unknown is never a reason to withhold an index.

/** The seed facts of the `project_repository` rows that realize one repository. */
export interface RepoSeedRow {
  state: string;
  seedHeadSha: string | null;
}

/** Why a repository was not indexed: it holds nothing beyond its seed. Recorded
 *  as an index verdict (`IndexSkipReason`) and logged — a different fact from a
 *  failed index, and a later reader must be able to tell the two apart. */
export const NO_COMMIT_BEYOND_TEMPLATE = 'no_commit_beyond_template' as const;

/**
 * True when the repository holds only its seed, so its first index waits.
 *
 * `defaultBranchHeadSha` is the head the push webhook last recorded
 * (`github_repo.default_branch_head_sha`). NULL means no default-branch push has
 * been observed since the repository was created, so its head is still the one
 * Motir left — the template's commit arrives without a push.
 */
export function isOnlyItsSeed(
  rows: readonly RepoSeedRow[],
  defaultBranchHeadSha: string | null,
): boolean {
  // A repository someone CONNECTED is theirs, with history of its own: never held.
  if (rows.some((row) => row.state === 'connected')) return false;
  const seeded = rows.find((row) => row.state === 'created' && row.seedHeadSha !== null);
  if (!seeded) return false;
  return defaultBranchHeadSha === null || defaultBranchHeadSha === seeded.seedHeadSha;
}
