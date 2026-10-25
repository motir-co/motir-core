import { Prisma, type GithubInstallation, type GithubRepo } from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';
import { INDEX_POOL_FULL_PAUSE_REASON } from '@/lib/ciFleet/indexAllowance';

// GitHub-repo repository — single Prisma operations on the `github_repo` table
// (Story 7.10 · MOTIR-891). `installationId` here is the INTERNAL
// GithubInstallation.id (a cuid), never GitHub's numeric installation id.

export interface UpsertGithubRepoInput {
  installationId: string;
  /** WHOSE this repo is (MOTIR-1931) — the row's own tenancy, not the parent
   *  installation's. Required on every write: Motir's shared provisioning
   *  installation holds several tenants' repos, so the installation cannot
   *  answer this. */
  workspaceId: string;
  /** WHOSE this repository is at the tier that OWNS it (Story MOTIR-4669 ·
   *  MOTIR-4649). A repository is connected once, to the organisation; the
   *  workspace above is the tier it was connected FROM.
   *
   *  REQUIRED on every write, deliberately, even though the column is nullable:
   *  the column is nullable for the DEPLOY WINDOW (an old build must still be
   *  able to insert while the migration is applied), and making the input
   *  required is what guarantees the NEW build never writes a null. A caller with
   *  no organisation in hand has to go and read one, which is the point. */
  organizationId: string;
  repoId: string;
  owner: string;
  name: string;
  defaultBranch: string;
  /** Whether the repository is ARCHIVED on the host (MOTIR-1959) — read-only, so
   *  no branch or PR can be opened against it. Omit to leave the column at its
   *  `false` default on create; every write path that has the host's own value
   *  passes it, so a re-selection RE-STAMPS liveness the same way it re-stamps
   *  the coordinates. */
  archived?: boolean;
  /** Provider discriminator for the row — omit for GitHub (the column default),
   *  pass `'gitlab'` when persisting a GitLab project selection (MOTIR-1478). */
  provider?: string;
}

/** One row the drift sweep may count — projected, not the whole model. */
export interface DriftRecomputeCandidate {
  id: string;
  owner: string;
  name: string;
  provider: string;
  indexedHeadSha: string;
  defaultBranchHeadSha: string;
  /** The id the HOST knows — what every provider method takes. */
  hostInstallationId: string;
}

/** One repository the index CATCH-UP sweep may re-ask about (MOTIR-5290) —
 *  projected, not the whole model. */
export interface IndexCatchUpCandidate {
  id: string;
  owner: string;
  name: string;
  provider: string;
  workspaceId: string;
  organizationId: string;
  defaultBranch: string;
  indexPausedReason: string;
  indexedHeadSha: string | null;
  defaultBranchHeadSha: string | null;
  /** The id the HOST knows — what the index/refresh event carries. */
  hostInstallationId: string;
}

/** One organisation whose indexing is paused, as the admin's Stopped orgs list pages
 *  it (MOTIR-4595) — the org-level roll-up of its paused repositories. */
export interface IndexPausedOrgRow {
  organizationId: string;
  organizationName: string;
  /** The reason on the org's most recently paused repository. */
  reason: string;
  /** When the org's longest-paused repository was paused. */
  stoppedSince: Date;
  pausedRepos: number;
}

/** Escape LIKE metacharacters so a typed `%` or `_` matches itself. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * The per-org roll-up of paused repositories, as one CTE both the page and the
 * counts read — so a page and its counts cannot be computed from two different
 * definitions of "a stopped org".
 */
function pausedOrgsCte(search: string | null): Prisma.Sql {
  const nameFilter = search
    ? Prisma.sql`AND o."name" ILIKE ${'%' + escapeLike(search) + '%'}`
    : Prisma.empty;
  return Prisma.sql`
    WITH per_org AS (
      SELECT
        gr."organization_id" AS "organizationId",
        MIN(gr."index_paused_at") AS "stoppedSince",
        COUNT(*)::int AS "pausedRepos",
        (ARRAY_AGG(gr."index_paused_reason" ORDER BY gr."index_paused_at" DESC NULLS LAST))[1] AS "reason"
      FROM "github_repo" gr
      WHERE gr."index_paused_reason" IS NOT NULL AND gr."archived" = false
        -- A full indexer pool is Motir's capacity, not the org's stop (MOTIR-9451).
        AND gr."index_paused_reason" <> ${INDEX_POOL_FULL_PAUSE_REASON}
      GROUP BY gr."organization_id"
    ),
    stopped AS (
      SELECT per_org.*, o."name" AS "organizationName"
      FROM per_org JOIN "organization" o ON o."id" = per_org."organizationId"
      WHERE true ${nameFilter}
    )`;
}

export const githubRepoRepository = {
  /** The repos selected on an installation, stable-ordered for display. Runs
   *  inside a context transaction, so it takes `tx`. */
  async listByInstallation(
    installationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubRepo[]> {
    return tx.githubRepo.findMany({
      where: { installationId },
      orderBy: [{ owner: 'asc' }, { name: 'asc' }],
    });
  },

  /** Every repo connected under ANY of a workspace's installations, stable-ordered
   *  (Story 7.9 · MOTIR-1804) — the workspace's connected repo SET as one read,
   *  the validation domain + default source for a work item's `targetRepo`.
   *  DELIBERATELY provider-agnostic (unlike `resolveCodeContext`, which reads the
   *  GitHub installation only): the CLI routes on a CHECKOUT, and a GitLab-connected
   *  repo is checked out exactly like a GitHub one, so narrowing by provider here
   *  would reject a legitimate pin. Read inside a context transaction (the
   *  `github_repo` RLS policy is workspace-keyed), so it takes `tx`. Empty when
   *  the workspace has no connected or created repo at all.
   *
   *  Filters on the repo's OWN `workspace_id` (MOTIR-1931), not on a join through
   *  the installation: a repo Motir CREATES for this workspace sits behind the
   *  shared provisioning installation, which is bound to no workspace at all — the
   *  old join dropped every such repo from the set, so a created repo was not a
   *  legal `targetRepo` and no agent could be told to build in it.
   *
   *  ⚠️ IT HAS NO PRODUCTION CALLER LEFT, AND THAT IS THE POINT — do not reach
   *  for it as "the repository read" (MOTIR-5152). Its two consumers were the
   *  PR-link picker's connectivity gate and the `targetRepo` domain, and both
   *  were BUGS: a repository is connected once to the ORGANISATION (Story
   *  MOTIR-4669), so this read answered a question about the tier a repository is
   *  connected FROM and returned nothing in every other workspace of that org.
   *  Both now call {@link listByOrganization}. What survives here is the narrow,
   *  still-true question — *which repositories were connected from THIS
   *  workspace* — which is the tenancy invariant MOTIR-1931 drew and what
   *  `tests/github/sharedInstallationTenancy.test.ts` asserts, so the method is
   *  kept rather than deleted. If you are about to add a caller, check first that
   *  you do not mean the organisation. */
  async listByWorkspace(workspaceId: string, tx: Prisma.TransactionClient): Promise<GithubRepo[]> {
    return tx.githubRepo.findMany({
      where: { workspaceId },
      orderBy: [{ owner: 'asc' }, { name: 'asc' }],
    });
  },

  /** Record the default branch's CURRENT head, as the push webhook saw it
   *  (Story MOTIR-4669 · MOTIR-4724). Half of "is the graph behind the code".
   *
   *  ⚠️ KEYED ON THE REPO ROW'S OWN id, not on `(installation_id, repo_id)`. The
   *  first cut took that pair and was handed the PROVIDER's installation id,
   *  because that is what the webhook has in scope — while `github_repo
   *  .installation_id` is the internal FK. It matched nothing and wrote nothing,
   *  silently, and only an end-to-end read of the derived state caught it. One
   *  id, already resolved by the caller, cannot be the wrong one.
   *
   *  Returns the update count; 0 means the row was gone by the time the delivery
   *  landed, which is an honest outcome rather than an error. */
  async setDefaultBranchHeadSha(
    id: string,
    headSha: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.githubRepo.updateMany({
      where: { id },
      data: { defaultBranchHeadSha: headSha },
    });
    return result.count;
  },

  /**
   * Repositories whose DRIFT COUNT needs computing (MOTIR-4644) — both shas
   * known and DIFFERENT, and no stored count for that exact pair.
   *
   * ⚠️ BOUNDED, AND THE BOUND IS THE POINT. Every row this returns costs one
   * provider round-trip, and GitLab.com rate-limits some endpoints at 5
   * requests/minute — so an unbounded fan-out over a large estate is not slow,
   * it is a sweep that fails most of its work and retries it for ever. The
   * caller passes a per-tick ceiling; the oldest-updated rows go first, so no
   * repository can be starved by a busier neighbour.
   *
   * ⚠️ THE PAIR-MATCH FILTER IS THE SAME RULE `needsDriftRecompute` STATES, in
   * SQL. It is expressed with `IS DISTINCT FROM` rather than `<>` because a NULL
   * stored sha must count as "does not match" — plain inequality is NULL there,
   * which drops exactly the never-computed rows this sweep exists to find.
   *
   * ⚠️ AND IT DOES NOT TEST `commits_behind IS NULL`. A recorded null means this
   * pair WAS tried and is not determinable — a force-push has no common ancestor
   * and never will until a sha moves. Selecting on the count's nullness would
   * re-select that repository on every tick for ever, spending a provider call
   * each time to learn the same thing. "Tried" is a property of the PAIR.
   *
   * ⚠️ IT TAKES A `tx` BECAUSE IT IS A CROSS-TENANT SYSTEM READ. `github_repo`'s
   * RLS policy is `system_admin OR workspace_id = app.workspace_id`, and this
   * sweep belongs to no workspace — so it runs inside `withSystemContext`, and
   * requiring the handle here is what stops a caller reaching for the unbound
   * singleton and getting ZERO ROWS WITH NO ERROR.
   */
  async listNeedingDriftRecompute(
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<DriftRecomputeCandidate[]> {
    // ⚠️ EVERY COLUMN IS ALIASED, and that is not cosmetic. `$queryRaw` returns
    // the DATABASE's column names — Prisma applies no `@map` translation to a raw
    // result — so an unaliased `indexed_head_sha` arrives as a property no
    // TypeScript reader would look for, and the typed generic makes the mismatch
    // invisible: every field reads `undefined`, no error is raised, and the sweep
    // compares nothing against nothing.
    //
    // ⚠️ AND IT JOINS THE INSTALLATION FOR ITS *HOST* ID. `github_repo
    // .installation_id` is the FK to our own row; every provider method takes the
    // id the HOST knows (`github_installation.installation_id`). Passing the FK
    // mints no token and the compare 404s — indistinguishable, at the call site,
    // from a repository with no common ancestor.
    return tx.$queryRaw<DriftRecomputeCandidate[]>`
      SELECT
        gr."id"                       AS "id",
        gr."owner"                    AS "owner",
        gr."name"                     AS "name",
        gr."provider"                 AS "provider",
        gr."indexed_head_sha"         AS "indexedHeadSha",
        gr."default_branch_head_sha"  AS "defaultBranchHeadSha",
        gi."installation_id"          AS "hostInstallationId"
      FROM "github_repo" gr
      JOIN "github_installation" gi ON gi."id" = gr."installation_id"
      WHERE gr."archived" = false
        AND gr."indexed_head_sha" IS NOT NULL
        AND gr."default_branch_head_sha" IS NOT NULL
        AND gr."indexed_head_sha" <> gr."default_branch_head_sha"
        AND (
          gr."commits_behind_base_sha" IS DISTINCT FROM gr."indexed_head_sha"
          OR gr."commits_behind_head_sha" IS DISTINCT FROM gr."default_branch_head_sha"
        )
      ORDER BY gr."updated_at" ASC
      LIMIT ${limit}
    `;
  },

  /**
   * Store a drift count AGAINST THE PAIR IT WAS COMPUTED FOR (MOTIR-4644).
   *
   * ⚠️ THE TWO SHAS ARE WRITTEN WITH THE NUMBER, ALWAYS, and that is what makes
   * the cache safe rather than merely fast: without them a later read cannot
   * tell a current count from one about a pair that has since moved, and the two
   * render identically.
   *
   * ⚠️ IT IS CONDITIONAL ON THE PAIR STILL BEING THE ROW'S. A push or an index
   * run can land while the provider call is in flight, and writing then would
   * stamp a number computed for the OLD pair with the NEW pair's shas — a
   * plausible, wrong count that no later read could detect. Losing that race
   * writes nothing and the next tick recomputes, which is the honest outcome.
   *
   * A null `count` is stored as null WITH its pair: it records that this pair was
   * tried and is not determinable (a force-push, a host that could not answer),
   * so the sweep does not retry it on every tick for ever.
   */
  async setDriftCount(
    id: string,
    count: number | null,
    baseSha: string,
    headSha: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.githubRepo.updateMany({
      where: { id, indexedHeadSha: baseSha, defaultBranchHeadSha: headSha },
      data: {
        commitsBehind: count,
        commitsBehindBaseSha: baseSha,
        commitsBehindHeadSha: headSha,
      },
    });
    return result.count;
  },

  /** Claim a repository as INDEXING, stamping the run that owns it and the head
   *  it is being indexed AT (MOTIR-4724).
   *
   *  ⚠️ The head is stamped at START, not at finish, and the direction of that
   *  imprecision is the point: a push landing mid-run leaves the stored value
   *  behind and the repository reads `stale`. Stamping at finish would read
   *  `indexed` for a graph that had already missed a commit.
   *
   *  ⚠️ SCOPED TO THE ORGANISATION that owns the run (MOTIR-9177). `owner/name`
   *  alone is not unique across tenants, and an unscoped `updateMany` stamped the
   *  claim on every organisation's row for that ref, so another tenant's failed
   *  repository read `queued`. */
  async markIndexStarted(
    repoRef: string,
    organizationId: string,
    runId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const [owner, name] = splitRepoRef(repoRef);
    if (!owner) return 0;
    const result = await tx.githubRepo.updateMany({
      where: { owner, name, organizationId },
      data: { indexingRunId: runId },
    });
    return result.count;
  },

  /** Settle a finished index: record what it indexed and release the claim.
   *  `headSha` is the head observed when the run STARTED (see above); a run that
   *  failed passes none, so the row keeps whatever it last successfully indexed
   *  and only the in-flight claim is cleared. */
  async markIndexSettled(
    repoRef: string,
    organizationId: string,
    args: { headSha?: string | null; indexedAt?: Date },
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const [owner, name] = splitRepoRef(repoRef);
    if (!owner) return 0;
    const result = await tx.githubRepo.updateMany({
      where: { owner, name, organizationId },
      data: {
        indexingRunId: null,
        ...(args.headSha
          ? { indexedHeadSha: args.headSha, indexedAt: args.indexedAt ?? new Date() }
          : {}),
      },
    });
    return result.count;
  },

  /** Release a claim that a DEAD run still holds (MOTIR-8769): clear
   *  `indexingRunId` only while it still names `runId`, so a run that claimed the
   *  repository since the caller read the pointer keeps its claim. A failed run
   *  never reaches `markIndexSettled`, so its pointer stays until the next run is
   *  claimed; a retry clears it so the repository reads `queued`, not `failed`,
   *  while the re-enqueued run waits. Returns how many rows it released, which is
   *  what lets two racing retries enqueue once. */
  async releaseIndexClaim(
    repoRef: string,
    runId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const [owner, name] = splitRepoRef(repoRef);
    if (!owner) return 0;
    const result = await tx.githubRepo.updateMany({
      where: { owner, name, indexingRunId: runId },
      data: { indexingRunId: null },
    });
    return result.count;
  },

  /** Record that indexing is PAUSED for a repository by a hard stop of its
   *  organisation's internal index allowance (MOTIR-4593), and release any claim —
   *  a refused dispatch booted nothing, so no run is in flight for it. The
   *  `indexedHeadSha` is untouched: the graph that exists is still the graph.
   *
   *  ⚠️ SCOPED TO THE ORGANISATION (MOTIR-9177), like {@link markIndexStarted}: this
   *  write nulls `indexingRunId`, and unscoped it released every other tenant's
   *  claim on the same `owner/name`, turning their failed repository back into
   *  `queued`. */
  async markIndexPaused(
    repoRef: string,
    organizationId: string,
    args: { reason: string; at?: Date },
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const [owner, name] = splitRepoRef(repoRef);
    if (!owner) return 0;
    const result = await tx.githubRepo.updateMany({
      where: { owner, name, organizationId },
      data: {
        indexPausedReason: args.reason,
        indexPausedAt: args.at ?? new Date(),
        indexingRunId: null,
      },
    });
    return result.count;
  },

  /**
   * The repositories whose indexing is PAUSED by a hard stop of the internal index
   * allowance (MOTIR-4593 records them) — the ONLY rows the catch-up sweep
   * (MOTIR-5290) selects. A repository without a recorded pause is never re-asked
   * about, so an organisation that was never stopped costs the sweep nothing.
   *
   * Oldest pause first, bounded per tick. Archived repositories are skipped: they
   * accept no writes and are never re-indexed.
   *
   * ⚠️ A CROSS-TENANT SYSTEM READ — it takes `tx` for the reason
   * {@link githubRepoRepository.listNeedingDriftRecompute} states: unbound, the
   * policy returns zero rows and raises nothing. And every column is aliased,
   * because `$queryRaw` applies no `@map`.
   */
  async listIndexPaused(
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<IndexCatchUpCandidate[]> {
    return tx.$queryRaw<IndexCatchUpCandidate[]>`
      SELECT
        gr."id"                       AS "id",
        gr."owner"                    AS "owner",
        gr."name"                     AS "name",
        gr."provider"                 AS "provider",
        gr."workspace_id"             AS "workspaceId",
        gr."organization_id"          AS "organizationId",
        gr."default_branch"           AS "defaultBranch",
        gr."index_paused_reason"      AS "indexPausedReason",
        gr."indexed_head_sha"         AS "indexedHeadSha",
        gr."default_branch_head_sha"  AS "defaultBranchHeadSha",
        gi."installation_id"          AS "hostInstallationId"
      FROM "github_repo" gr
      JOIN "github_installation" gi ON gi."id" = gr."installation_id"
      WHERE gr."index_paused_reason" IS NOT NULL
        AND gr."archived" = false
      ORDER BY gr."index_paused_at" ASC NULLS FIRST, gr."id" ASC
      LIMIT ${limit}
    `;
  },

  /**
   * ONE PAGE of organisations whose indexing is paused (MOTIR-4595), longest-stopped
   * first, optionally narrowed to one reason and an organisation-name search.
   * Paged in SQL: the admin list holds hundreds of organisations.
   *
   * ⚠️ A CROSS-TENANT SYSTEM READ — it takes `tx` for the reason
   * {@link githubRepoRepository.listNeedingDriftRecompute} states.
   */
  async listIndexPausedOrgs(
    args: { reason: string | null; search: string | null; limit: number; offset: number },
    tx: Prisma.TransactionClient,
  ): Promise<IndexPausedOrgRow[]> {
    const reasonFilter = args.reason ? Prisma.sql`WHERE "reason" = ${args.reason}` : Prisma.empty;
    return tx.$queryRaw<IndexPausedOrgRow[]>`
      ${pausedOrgsCte(args.search)}
      SELECT "organizationId", "organizationName", "reason", "stoppedSince", "pausedRepos"
      FROM stopped ${reasonFilter}
      ORDER BY "stoppedSince" ASC NULLS LAST, "organizationId" ASC
      LIMIT ${args.limit} OFFSET ${args.offset}
    `;
  },

  /** Stopped organisations per reason, over the same roll-up and search as
   *  {@link githubRepoRepository.listIndexPausedOrgs} — the filter's counts. */
  async countIndexPausedOrgsByReason(
    args: { search: string | null },
    tx: Prisma.TransactionClient,
  ): Promise<{ reason: string; orgs: number }[]> {
    return tx.$queryRaw<{ reason: string; orgs: number }[]>`
      ${pausedOrgsCte(args.search)}
      SELECT "reason", COUNT(*)::int AS "orgs" FROM stopped GROUP BY "reason"
    `;
  },

  /** The paused repositories of a page of organisations, with the columns the drift
   *  count is resolved from (MOTIR-4595). */
  async listIndexPausedReposForOrgs(
    organizationIds: string[],
    tx: Prisma.TransactionClient,
  ): Promise<
    Pick<
      GithubRepo,
      | 'organizationId'
      | 'commitsBehind'
      | 'commitsBehindBaseSha'
      | 'commitsBehindHeadSha'
      | 'indexedHeadSha'
      | 'defaultBranchHeadSha'
    >[]
  > {
    if (organizationIds.length === 0) return [];
    return tx.githubRepo.findMany({
      where: {
        organizationId: { in: organizationIds },
        // The same rows the Stopped orgs list counts: never a full indexer pool.
        indexPausedReason: { not: null, notIn: [INDEX_POOL_FULL_PAUSE_REASON] },
        archived: false,
      },
      select: {
        organizationId: true,
        commitsBehind: true,
        commitsBehindBaseSha: true,
        commitsBehindHeadSha: true,
        indexedHeadSha: true,
        defaultBranchHeadSha: true,
      },
    });
  },

  /** The most recently paused repository of one organisation — its pause reason and
   *  when — or `null` when nothing is paused (MOTIR-5341). Archived repositories
   *  are skipped, as in the Stopped orgs list. */
  async findLatestIndexPauseForOrganization(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ indexPausedReason: string | null; indexPausedAt: Date | null } | null> {
    return tx.githubRepo.findFirst({
      // A full indexer pool is not the organisation's stop (MOTIR-9451).
      where: {
        organizationId,
        indexPausedReason: { not: null, notIn: [INDEX_POOL_FULL_PAUSE_REASON] },
        archived: false,
      },
      orderBy: { indexPausedAt: 'desc' },
      select: { indexPausedReason: true, indexPausedAt: true },
    });
  },

  /** Lift a recorded pause — the allowance let a dispatch boot (MOTIR-4593). A
   *  repository that was not paused is not written. */
  async clearIndexPause(repoRef: string, tx: Prisma.TransactionClient): Promise<number> {
    const [owner, name] = splitRepoRef(repoRef);
    if (!owner) return 0;
    const result = await tx.githubRepo.updateMany({
      where: { owner, name, indexPausedReason: { not: null } },
      data: { indexPausedReason: null, indexPausedAt: null },
    });
    return result.count;
  },

  /** Record that the repository's last index was REFUSED FOR SIZE (MOTIR-7129):
   *  the graph's uncompressed size and the supported maximum, and when. Shown to
   *  the customer, unlike the pause above. The graph that exists is untouched —
   *  the refused run published nothing. */
  async markIndexRefusedForSize(
    repoRef: string,
    args: { sizeBytes: number; capBytes: number; at?: Date },
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const [owner, name] = splitRepoRef(repoRef);
    if (!owner) return 0;
    const result = await tx.githubRepo.updateMany({
      where: { owner, name },
      data: {
        indexRefusedSizeBytes: BigInt(args.sizeBytes),
        indexRefusedCapBytes: BigInt(args.capBytes),
        indexRefusedAt: args.at ?? new Date(),
      },
    });
    return result.count;
  },

  /** Clear a recorded size refusal — a later run indexed (MOTIR-7129). A
   *  repository with no refusal is not written, so the count is 0 for it. */
  async clearIndexRefusal(repoRef: string, tx: Prisma.TransactionClient): Promise<number> {
    const [owner, name] = splitRepoRef(repoRef);
    if (!owner) return 0;
    const result = await tx.githubRepo.updateMany({
      where: { owner, name, indexRefusedAt: { not: null } },
      data: { indexRefusedSizeBytes: null, indexRefusedCapBytes: null, indexRefusedAt: null },
    });
    return result.count;
  },

  /** One repo by its INTERNAL id — the lookup a link write does after a picker
   *  hands back an id it read from `listByOrganization` (MOTIR-4678). Returns
   *  null when the id names nothing the current RLS context admits, which is the
   *  same answer a foreign organisation's id gives: the caller must not be able
   *  to tell a real id in another org from a fictional one. */
  async findById(id: string, tx: Prisma.TransactionClient): Promise<GithubRepo | null> {
    return tx.githubRepo.findUnique({ where: { id } });
  },

  /** THE ORGANISATION'S whole repository inventory (Story MOTIR-4669 · MOTIR-4678)
   *  — every repo connected to `organizationId`, ACROSS every workspace of that
   *  org. This is the read the `Add repository` picker's first segment is built
   *  from, and the reason it is keyed on the organisation rather than the
   *  workspace is the story's whole claim: a repository is connected once, to the
   *  org, and which projects use it is visibility configuration.
   *
   *  ⚠️ IT MUST RUN UNDER A TRANSACTION THAT HAS BOUND `app.organization_id`.
   *  `github_repo`'s shipped `FOR ALL` policy is workspace-keyed, so a plain
   *  `withWorkspaceContext` sees only the caller's own workspace and this read
   *  silently returns a SUBSET — which would look like a short picker rather
   *  than a bug. MOTIR-4677 added `github_repo_org_read` (`FOR SELECT`) for
   *  exactly this, and `bindOrganizationContext` is what turns it on. */
  async listByOrganization(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubRepo[]> {
    return tx.githubRepo.findMany({
      where: { organizationId },
      orderBy: [{ owner: 'asc' }, { name: 'asc' }],
    });
  },

  /** The connected repository COORDINATES of several organisations at once — the
   *  set motir-ai's code-graph reconciler subtracts its stored graphs from
   *  (MOTIR-9137). Every provider's rows, GitLab included, because a code graph
   *  is keyed by the same `owner/name` whichever host it came from. Projected to
   *  the three columns the ref is built from; nothing else leaves the row.
   *
   *  ⚠️ `tx` IS REQUIRED and must be a `withSystemContext` transaction: the read
   *  spans tenants, and on any narrower context RLS returns a SUBSET with no
   *  error — which the caller would read as "these repositories are gone". */
  async listRefsByOrganizations(
    organizationIds: string[],
    tx: Prisma.TransactionClient,
  ): Promise<Array<{ organizationId: string; owner: string; name: string }>> {
    if (organizationIds.length === 0) return [];
    return tx.githubRepo.findMany({
      where: { organizationId: { in: organizationIds } },
      select: { organizationId: true, owner: true, name: true },
      orderBy: [{ organizationId: 'asc' }, { owner: 'asc' }, { name: 'asc' }],
    });
  },

  /**
   * Every repository row of `organizationId` WITH its parent installation — the
   * organization Git offboarding's work set (MOTIR-6306 · MOTIR-6397). The
   * installation rides along because a Motir-hosted repository's delete is minted
   * from ITS installation id, and a GitLab row's fate depends on whose connection
   * it hangs off. System context in practice (the org is being erased and no
   * member acts); ordered so a resumed run walks the same sequence.
   */
  async listByOrganizationWithInstallation(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<(GithubRepo & { installation: GithubInstallation })[]> {
    return tx.githubRepo.findMany({
      where: { organizationId },
      include: { installation: true },
      orderBy: [{ owner: 'asc' }, { name: 'asc' }, { id: 'asc' }],
    });
  },

  /** Another organization with repository rows under installation
   *  `installationFk` (the internal `GithubInstallation.id`), or null when every row
   *  under it is `organizationId`'s — the offboarding's "is this installation
   *  shared?" test, answered with WHO it is shared with. */
  async findOtherOrganizationId(
    installationFk: string,
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<string | null> {
    const row = await tx.githubRepo.findFirst({
      where: { installationId: installationFk, organizationId: { not: organizationId } },
      select: { organizationId: true },
      orderBy: { id: 'asc' },
    });
    return row?.organizationId ?? null;
  },

  /** Remove ONE repository row by id. `deleteMany`, so a re-run after the row is
   *  gone is a no-op (count 0). Its pull-request rows cascade with it. */
  async deleteById(id: string, tx: Prisma.TransactionClient): Promise<number> {
    const result = await tx.githubRepo.deleteMany({ where: { id } });
    return result.count;
  },

  /** Every connected repo WITH its parent installation, optionally narrowed to one
   *  workspace (MOTIR-1961) — the operator first-index sweep's one read. The
   *  installation is included because the enqueue payload needs the PROVIDER's
   *  installation id (`GithubInstallation.installationId`, the token-minting key),
   *  which the repo row holds only as the internal FK. Cross-workspace by design:
   *  the never-indexed-repo defect is not one tenant's, so the sweep's default
   *  domain is every affected tenant — the caller narrows with `workspaceId` and
   *  MUST run under `withSystemContext` when it does not (the `github_repo` RLS
   *  policy is workspace-keyed). Stable-ordered so the sweep's report is diffable. */
  async listWithInstallation(
    tx: Prisma.TransactionClient,
    opts: { workspaceId?: string } = {},
  ): Promise<(GithubRepo & { installation: GithubInstallation })[]> {
    return tx.githubRepo.findMany({
      where: opts.workspaceId ? { workspaceId: opts.workspaceId } : {},
      include: { installation: true },
      orderBy: [{ workspaceId: 'asc' }, { owner: 'asc' }, { name: 'asc' }],
    });
  },

  /** One selected repo by its `(installation_id, repo_id)` pair — the webhook's
   *  lookup from a normalized change request's `providerRepoId` (GitHub's numeric
   *  repo id) to the internal `GithubRepo.id` the PR row FKs against. Null when
   *  the repo isn't selected on this installation. */
  async findByInstallationAndRepoId(
    installationId: string,
    repoId: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubRepo | null> {
    return tx.githubRepo.findUnique({
      where: { installationId_repoId: { installationId, repoId } },
    });
  },

  /** Every mirror row for one GitHub repository id, across installations,
   *  oldest first. The fleet intake's connected-org fallback (MOTIR-8720) reads it
   *  to find the ONE row a repository is mirrored under when the delivery came in
   *  on an installation that has no mirror row of its own; the caller refuses
   *  zero or several. `tx` because `github_repo`'s RLS admits it only under
   *  `withSystemContext`. */
  async listByRepoId(repoId: string, tx: Prisma.TransactionClient): Promise<GithubRepo[]> {
    return tx.githubRepo.findMany({ where: { repoId }, orderBy: { id: 'asc' } });
  },

  /** Create-or-refresh one selected repo, keyed on the unique
   *  `(installation_id, repo_id)` pair. `provider` defaults to the column default
   *  (`'github'`) when omitted; a GitLab project selection passes `'gitlab'`
   *  (MOTIR-1478). A `provider: undefined` is a Prisma no-op on both create (the
   *  `@default` applies) and update (the field is left untouched). */
  async upsert(input: UpsertGithubRepoInput, tx: Prisma.TransactionClient): Promise<GithubRepo> {
    const { installationId, repoId, ...rest } = input;
    // `rest` carries `workspaceId`, so a re-selection re-stamps the owning tenant
    // as well as the coordinates — the row's tenancy is refreshed, never inherited
    // from whatever wrote it first.
    return tx.githubRepo.upsert({
      where: { installationId_repoId: { installationId, repoId } },
      create: { installationId, repoId, ...rest },
      update: rest,
    });
  },

  /**
   * Re-stamp a mirror row's COORDINATES after the repository moved on the host —
   * the takeover's mirror update (MOTIR-711), driven by the `repository`
   * `transferred` delivery.
   *
   * ⚠️ THIS WRITE IS WHAT MAKES TWO OTHER GUARANTEES FALL OUT FOR FREE, and
   * neither has any code of its own:
   *
   *   * the CI-Actions pause fan-out re-checks `githubRepo.owner` against the
   *     provisioning org at call time (`ciActionsGateService`'s `assertPending`),
   *     so a transferred row silently leaves the sweep — nobody has to remember to
   *     exclude it;
   *   * the CI meter gates on the RUN's own repository owner rather than on this
   *     mirror (`ci-minutes-allowance.md` §5.5), so metering already stops at the
   *     transfer whether or not this row has caught up yet. Updating it keeps the
   *     mirror honest; it is not what stops the billing.
   *
   * `updateMany` (not `update`) so a webhook REDELIVERY after the row is gone is
   * an idempotent no-op (count 0) rather than a `P2025` throw. Returns the count.
   */
  async updateOwnerByRepoId(
    repoId: string,
    data: { owner: string; name: string; defaultBranch?: string },
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.githubRepo.updateMany({ where: { repoId }, data });
    return result.count;
  },

  /**
   * Re-stamp a mirror row's ARCHIVED state after the repository was archived (or
   * un-archived) on the host — the `repository` `archived` / `unarchived`
   * delivery's write (MOTIR-1959).
   *
   * This is what keeps the recorded liveness TRUE rather than merely INITIAL. The
   * establish/connect paths stamp `archived` at the moment they mirror the repo,
   * and the incident MOTIR-1956 recorded is precisely a repository archived a
   * month AFTER that: without this write, a set established while the repo was
   * live would keep dispatching against it forever.
   *
   * `updateMany` (not `update`) for the same reason {@link updateOwnerByRepoId}
   * uses it: a webhook REDELIVERY after the row is gone must be an idempotent
   * no-op (count 0), never a `P2025` throw that makes GitHub retry a delivery no
   * retry can fix. Returns the count.
   */
  async setArchivedByRepoId(
    repoId: string,
    archived: boolean,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.githubRepo.updateMany({ where: { repoId }, data: { archived } });
    return result.count;
  },

  /** Remove ONE selected repo by its `(installation_id, repo_id)` pair — the
   *  in-app "disconnect this project" write (MOTIR-1478, the GitLab settings
   *  surface). `deleteMany` (not `delete`) so a double-submit / redelivery after
   *  the row is gone is an idempotent no-op (count 0) rather than a `P2025`
   *  throw. Its `github_pull_request` rows cascade with it. Returns the count. */
  async deleteByInstallationAndRepoId(
    installationId: string,
    repoId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.githubRepo.deleteMany({ where: { installationId, repoId } });
    return result.count;
  },

  /** One connected repo by `(owner, name)` within a WORKSPACE — the code-scanning
   *  proxy's resolution (MOTIR-1605) from an audit `repoRef` to the tenant's
   *  installation. Owner/name match case-insensitively (GitHub coordinates are
   *  case-insensitive). The filter is the repo's OWN `workspace_id` (MOTIR-1931),
   *  which scopes the lookup to the caller's own workspace (defense-in-depth
   *  alongside the `withWorkspaceContext` RLS gate on `github_repo`) — another
   *  tenant's repo can never resolve, and a repo Motir CREATED for this workspace
   *  now DOES (the old join through the installation missed it, because the shared
   *  provisioning installation belongs to no workspace). Includes the parent
   *  installation (its provider + numeric `installationId` drive the token mint).
   *  Null when the repo isn't connected in this workspace. Read inside a context
   *  transaction, so it takes `tx`.
   *
   *  ⚠️ NO PRODUCTION CALLER IS LEFT, FOR THE SAME REASON AS `listByWorkspace`
   *  (MOTIR-5188). Its four callers — `link_pull_request` and
   *  `unlink_pull_request` by coordinates, the repo file read, the code-scanning
   *  proxy — asked the tier a repository is connected FROM, so in every other
   *  workspace of the organisation the first two raised and the last two
   *  answered "not connected" about a connected repository. They now call
   *  {@link findConnectedByOrganizationAndName}. This method keeps answering the
   *  narrow, still-true question (MOTIR-1931); if you are about to add a caller,
   *  check first that you do not mean the organisation. */
  async findConnectedByWorkspaceAndName(
    workspaceId: string,
    owner: string,
    name: string,
    tx: Prisma.TransactionClient,
  ): Promise<(GithubRepo & { installation: GithubInstallation }) | null> {
    return tx.githubRepo.findFirst({
      where: {
        owner: { equals: owner, mode: 'insensitive' },
        name: { equals: name, mode: 'insensitive' },
        workspaceId,
      },
      include: { installation: true },
    });
  },

  /** One connected repo by `(owner, name)` within an ORGANISATION (Story
   *  MOTIR-4669 · MOTIR-5188) — the coordinate resolution every workspace of the
   *  organisation shares: `link_pull_request` / `unlink_pull_request` by
   *  coordinates, the repo file read, the code-scanning proxy. A repository is
   *  connected once, to the organisation, so the workspace asking is not the
   *  workspace that connected it. Owner/name match case-insensitively. Includes
   *  the parent installation (its provider + numeric `installationId` drive the
   *  token mint).
   *
   *  ⚠️ `organizationId` MUST BE RESOLVED OFF THE WORKSPACE ROW
   *  (`resolveOrganizationId`), never taken from request input. What admits the
   *  row is `github_repo_org_read`, which resolves the caller's organisation from
   *  the bound WORKSPACE, so a plain `withWorkspaceContext` suffices and no
   *  `app.organization_id` needs binding (MOTIR-5152's measurement). The `where`
   *  on `organizationId` is the defense-in-depth half.
   *
   *  One organisation can hold the same coordinate twice — the uniqueness is
   *  `(installationId, repoId)` — so the OLDEST connection wins, deterministically,
   *  the same tie-break `findByRepoIdAndProvider` uses. Null when the organisation
   *  has no such repository. */
  async findConnectedByOrganizationAndName(
    organizationId: string,
    owner: string,
    name: string,
    tx: Prisma.TransactionClient,
  ): Promise<(GithubRepo & { installation: GithubInstallation }) | null> {
    return tx.githubRepo.findFirst({
      where: {
        owner: { equals: owner, mode: 'insensitive' },
        name: { equals: name, mode: 'insensitive' },
        organizationId,
      },
      include: { installation: true },
      orderBy: { createdAt: 'asc' },
    });
  },

  /** Resolve a connected repo GLOBALLY by `(owner, name)` — the keyless-OIDC
   *  trust seam (MOTIR-1650). A GitHub Actions OIDC token's `repository` claim
   *  (`owner/name`) DETERMINES the tenant, so this read runs OUTSIDE any
   *  workspace context (like the webhook keying on GitHub's global installation
   *  id), on the `db` singleton. Case-insensitive (GitHub coordinates are).
   *  Returns EVERY match so the caller can reject an AMBIGUOUS coordinate (the
   *  same repo connected under two workspaces) rather than silently pick one —
   *  it never scopes to a workspace because the caller has none yet. Read-only →
   *  no `tx`. Includes the parent installation (its provider drives the token
   *  mint); the TENANT is the row's own `workspaceId` (MOTIR-1931), never the
   *  installation's — under one shared provisioning org a coordinate is globally
   *  unique, so the ambiguity guard below could never fire for a hosted repo and
   *  reading the tenant off the installation would have authenticated an Actions
   *  run into whichever workspace held the shared row. */
  async findConnectedByName(
    owner: string,
    name: string,
    tx?: Prisma.TransactionClient,
  ): Promise<(GithubRepo & { installation: GithubInstallation })[]> {
    const client = tx ?? dbRead;
    return client.githubRepo.findMany({
      where: {
        owner: { equals: owner, mode: 'insensitive' },
        name: { equals: name, mode: 'insensitive' },
      },
      include: { installation: true },
    });
  },

  /** Resolve a connected repo by its host repo id under a given PROVIDER (Story
   *  7.23 · MOTIR-1475) — the GitLab webhook's key. A GitLab MR/pipeline delivery
   *  carries the project id but NO Motir connection id (unlike GitHub's App
   *  delivery, which carries its global installation id), so the webhook resolves
   *  the connection through the repo: match `(repo_id, installation.provider)` and
   *  include the parent installation (its workspace + provider drive the sync).
   *  Runs OUTSIDE any workspace context (the webhook has no active workspace, like
   *  the GitHub path keying on the global installation id), inside the sync's
   *  system-context transaction, so it takes `tx`. A host project id is unique per
   *  GitLab instance; the oldest-connected row wins if the same project is somehow
   *  connected twice. Null when the project isn't connected. */
  async findByRepoIdAndProvider(
    repoId: string,
    provider: string,
    tx: Prisma.TransactionClient,
  ): Promise<(GithubRepo & { installation: GithubInstallation }) | null> {
    return tx.githubRepo.findFirst({
      where: { repoId, installation: { is: { provider } } },
      include: { installation: true },
      orderBy: { createdAt: 'asc' },
    });
  },

  /** Reconcile the selected set: delete every repo on this installation whose
   *  `repo_id` is NOT in `keepRepoIds` (a de-selected repo). An empty keep set
   *  deletes them all (`NOT IN ()` is always true). Returns the delete count.
   *
   *  ONLY correct for a workspace's OWN installation, where one reconcile sees
   *  that workspace's whole selection. It is NEVER reachable for Motir's shared
   *  provisioning installation (MOTIR-1931): its only caller is
   *  `githubInstallationService.persistInstallation`, which requires a
   *  `workspaceId: string`, and a shared installation's `workspaceId` is NULL —
   *  so the call cannot be formed. That is a reachability property, not a
   *  caution: there is no flag to forget to check. */
  async deleteExcept(
    installationId: string,
    keepRepoIds: string[],
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.githubRepo.deleteMany({
      where: { installationId, NOT: { repoId: { in: keepRepoIds } } },
    });
    return result.count;
  },

  /** The per-organisation reconcile's prune (MOTIR-8219): delete this
   *  organisation's repositories on the installation whose host id is NOT in
   *  `keepRepoIds`, and return the deleted rows' `owner/name` refs (the key the
   *  code-graph offboarding queue needs, unreadable once the row is gone). Unlike
   *  {@link deleteExcept} it can never select another organisation's row on a
   *  shared installation. One statement (`DELETE … RETURNING`); an empty keep set
   *  deletes all of this organisation's rows on the installation. */
  async deleteExceptForOrg(
    installationId: string,
    organizationId: string,
    keepRepoIds: string[],
    tx: Prisma.TransactionClient,
  ): Promise<string[]> {
    const rows = await tx.$queryRaw<{ owner: string; name: string }[]>`
      DELETE FROM "github_repo"
       WHERE "installation_id" = ${installationId}
         AND "organization_id" = ${organizationId}
         AND NOT ("repo_id" = ANY(${keepRepoIds}::text[]))
      RETURNING "owner", "name"`;
    return rows.map((row) => `${row.owner}/${row.name}`);
  },

  /** Every row for one host repository under `provider`, oldest first — the
   *  "who already owns this repository?" read a per-organisation claim checks
   *  before writing (Story MOTIR-8216 · MOTIR-8218). More than one row is
   *  legitimate (a takeover leaves the shared row beside the customer's), but
   *  they always share ONE organisation: the `trg_github_repo_one_organization`
   *  trigger refuses a second. Run under `withSystemContext`, since the owner
   *  may be another tenant. */
  async findByHostRepoId(
    provider: string,
    repoId: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubRepo[]> {
    return tx.githubRepo.findMany({
      where: { provider, repoId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  },

  /** The repositories ONE organisation has claimed through a (possibly shared)
   *  installation (MOTIR-8218). On a shared installation this is that
   *  organisation's subset, never the whole account. */
  async listByInstallationAndOrg(
    installationId: string,
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubRepo[]> {
    return tx.githubRepo.findMany({
      where: { installationId, organizationId },
      orderBy: [{ owner: 'asc' }, { name: 'asc' }],
    });
  },

  /** Remove ONE organisation's repositories from an installation — the
   *  per-organisation disconnect (MOTIR-8218). Other organisations' rows on the
   *  same installation are untouched; their pull-request rows cascade only with
   *  their own repository. `deleteMany`, so a re-run is a no-op. Returns the
   *  count. */
  async deleteByInstallationAndOrg(
    installationId: string,
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.githubRepo.deleteMany({ where: { installationId, organizationId } });
    return result.count;
  },

  /**
   * The DISTINCT workspaces holding at least one repository owned by `owner` —
   * the entry point for any org-wide fan-out over Motir-hosted repos
   * (MOTIR-1907).
   *
   * ⚠️ THIS EXISTS BECAUSE "the org's workspaces" IS NOT READABLE FROM A
   * BACKGROUND PATH. `workspaceRepository.listByOrganization` looks like the
   * natural read and is NOT reachable here: `workspace`'s RLS admits a row only
   * via `id = app.workspace_id` or the caller's OWN memberships, with **no
   * `app.system_admin` escape** — so both of its shipped callers run under
   * `withOrgContext({ userId, … })`, a cookie-session surface. The CI-Actions gate
   * fires from metering and from a sweep, where there is no user at all.
   *
   * `github_repo` is the way in: it carries `workspace_id` directly (MOTIR-1931)
   * and its policy DOES have the system escape the webhook path already relies
   * on. So the traversal runs mirror → workspace → org, one workspace at a time,
   * binding each workspace's own GUC — the same direction `ciMinutesMeterService`
   * §5.2 takes, and entirely within shipped policy. Widening `workspace`'s RLS
   * instead would be a cross-tenant access change, which is not this card's to
   * make.
   *
   * Compared case-INSENSITIVELY: GitHub logins are case-insensitive and the
   * mirror echoes the payload's casing, which an operator's `GITHUB_FALLBACK_ORG`
   * need not match — the same comparison `isMotirOwnedRepo` makes.
   */
  async listWorkspaceIdsByOwner(
    owner: string,
    tx: Prisma.TransactionClient,
  ): Promise<Array<{ workspaceId: string }>> {
    return tx.$queryRaw<Array<{ workspaceId: string }>>`
      SELECT DISTINCT "workspace_id" AS "workspaceId"
      FROM "github_repo"
      WHERE lower("owner") = lower(${owner})
    `;
  },
};

/** `owner/name` → its two halves. A ref without a slash names no repository, and
 *  the callers above turn that into a zero-row no-op rather than a wildcard
 *  update — a `where` built from a half-parsed ref is how one repo's write
 *  reaches another's row. */
function splitRepoRef(repoRef: string): [string, string] | [null, null] {
  const cut = repoRef.lastIndexOf('/');
  if (cut <= 0 || cut === repoRef.length - 1) return [null, null];
  return [repoRef.slice(0, cut), repoRef.slice(cut + 1)];
}
