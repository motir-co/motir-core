import {
  Prisma,
  type GithubCheckRun,
  type GithubInstallation,
  type GithubPullRequest,
  type GithubRepo,
  type DecisionDocOutcome,
  type MergeAuthority,
} from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';
import { parsePullRequestReference } from '@/lib/github/prReferenceQuery';
import { PENDING_MERGEABLE_STATE } from '@/lib/github/mergeability';

// GitHub pull-request repository — single Prisma operations on the
// `github_pull_request` table (Story 7.10 · MOTIR-891). `repoId` is the INTERNAL
// GithubRepo.id (a cuid). The row is the MIRROR of a pull request and nothing
// more: it carries no association with a work item at all (MOTIR-3757 dropped
// `work_item_id`). `work_item_delivery` holds every such association, and the
// reads below that answer "which pull requests deliver this card" reach it
// through the `deliveries` relation.

export interface UpsertGithubPullRequestInput {
  /** The host discriminator — 'github' | 'gitlab' (Story 7.23 · MOTIR-1475). The
   *  shared status sync stamps it from the connection's provider so the
   *  Development surface renders the right host mark; GitHub rows carry the
   *  column default. */
  provider: string;
  repoId: string;
  number: number;
  state: string;
  merged: boolean;
  headRef: string;
  /** The branch the change request TARGETS (Story MOTIR-2725 · MOTIR-2729).
   *  Required on `NormalizedChangeRequest` for both providers and on the
   *  historical backfill, so every live path supplies it; the COLUMN is nullable
   *  only because rows written before it existed cannot know theirs. */
  baseRef: string;
  title: string | null;
  /**
   * Whether the change request is a DRAFT (MOTIR-5002) — the fact the LINK door
   * could not read, because a link carries no payload and synthesizes its change
   * request from this row.
   *
   * ⚠️ A REQUIRED KEY WHOSE VALUE MAY BE `undefined`, and that is the whole
   * contract rather than a loose type. REQUIRED so the compiler enumerates the
   * producers — the same argument `NormalizedChangeRequest.draft` makes for
   * itself one layer up (MOTIR-4968): an optional field lets one writer omit it
   * in silence, and the row then says `false` by omission about a pull request
   * nobody asked. `undefined` so a writer that genuinely does not know can SAY
   * so: Prisma reads it as "not provided", which leaves an existing value alone
   * on update and the nullable column NULL on insert.
   *
   * The three producers, each of which declares:
   *  · the status sync — a real boolean off the delivery. The authority.
   *  · `linkPullRequestByCoordinates`'s create arm — `undefined`. A run linking
   *    the moment `gh pr create` returns tells Motir the refs and the title and
   *    is never asked about draft-ness; the delivery still to come is what knows.
   *  · the historical backfill — `undefined`. It writes MERGED rows only, where
   *    the flag decides nothing (`merged` answers the lifecycle first).
   */
  draft: boolean | undefined;
  /**
   * The host's head commit (MOTIR-7005) — `draft`'s contract exactly: a REQUIRED key
   * whose value is `undefined` when the writer does not know, which leaves the stored
   * head alone. The status sync supplies the delivery's; the link door and the
   * historical backfill do not know it.
   */
  headSha: string | undefined;
  /**
   * The pull request's author on the host (MOTIR-10340) — `headSha`'s contract exactly: a
   * REQUIRED key whose value is `undefined` when the writer does not know, which leaves the
   * stored author alone. Only the status sync supplies it, from the delivery's
   * `pull_request.user`; the link door and the historical backfill do not assert it.
   */
  authorGithubUserId: string | undefined;
  /** The author's login, written with {@link authorGithubUserId} — a label only. */
  authorLogin: string | undefined;
  /* ⚠️ `linkedManually` WAS A FIELD HERE and is removed by MOTIR-4894. It said
   * the association was DECLARED rather than inferred by the MOTIR-892
   * auto-resolver; MOTIR-3674 deleted that resolver, so the distinction had no
   * other side and the flag was true of every live write. The COLUMN still
   * exists and still has its `false` default — MOTIR-4894 is phase 1 of
   * `docs/decisions/delivery-reader-migration.md` §6a, and phases 2 and 3 are
   * what remove it — so an upsert that no longer names it writes the default on
   * insert and leaves the stored value alone on update. That is deliberate: the
   * rows already written keep whatever they say, and nothing new asserts it. */
}

/** One linked change request, reduced to the four facts the repository-SET
 *  completion gate decides on (Story MOTIR-2725 · MOTIR-2729). `baseRef` is null
 *  for rows ingested before the column existed — UNKNOWN, never "the default
 *  branch". */
export interface LinkedChangeRequestCompletionFact {
  repoName: string;
  repoDefaultBranch: string;
  merged: boolean;
  baseRef: string | null;
  /** Still OPEN on the host — neither merged nor closed (MOTIR-8811: an open
   *  change request of the item's own keeps a repository from reading as
   *  delivered by a child, because the item's own work there has not landed). */
  open: boolean;
}

/** A PR row with the context the Development surface renders (MOTIR-1579):
 *  its repo (owner/name for the meta line + link-out) and its check rows
 *  (the per-PR CI state derivation). */
export type GithubPullRequestWithContext = GithubPullRequest & {
  repo: GithubRepo;
  checkRuns: GithubCheckRun[];
};

/** A PR row with just its check rows — enough to derive the CI verdict, which is
 *  all the MOTIR-3006 promotion reads. */
export type GithubPullRequestWithChecks = GithubPullRequest & {
  checkRuns: GithubCheckRun[];
};

/** A PR row with its repo AND the parent installation — the workspace-tenancy
 *  chain the explicit-link service validates (installation → repo → PR), plus
 *  the check rows the returned DTO needs (MOTIR-1596). */
/** The merge record Motir writes when it merges or enqueues a pull request
 *  (MOTIR-5520). `mergeOutcomeRef` is the merge commit SHA, or `queue:<entryId>`. Named after
 *  its COLUMNS on purpose: `outcomeRef` is `approval_gate`'s field, and it means the
 *  status key a decision applied — a second `outcomeRef` meaning a SHA is exactly
 *  the confusion this record exists to keep off the gate. */
export interface MotirMergeRecordInput {
  mergeAuthority: MergeAuthority;
  mergeOutcomeRef: string;
}

export type GithubPullRequestWithInstallation = GithubPullRequestWithContext & {
  repo: GithubRepo & { installation: GithubInstallation };
};

/** A PR candidate for the explicit-link picker (MOTIR-1596): its repo (for the
 *  `owner/name · #n` option meta) and — when already linked — the target item's
 *  identifier (the neutral "Linked to MOTIR-<n>" takeover chip). */
export type GithubPullRequestCandidate = GithubPullRequest & {
  repo: GithubRepo;
};

/** A PR row with just its repo — what a path-intersection reader needs to name
 *  the merge it found (`owner/name#number`) without dragging the check rows the
 *  Development surface's own type carries (MOTIR-2922). */
export type GithubPullRequestWithRepo = GithubPullRequest & { repo: GithubRepo };

/** The merge facts captured best-effort AFTER the status sync commits
 *  (MOTIR-2922): when the merge landed, and which repo-relative paths it touched.
 *  `changedPathsTruncated` says the path list is a PREFIX rather than the whole,
 *  and travels WITH the paths for exactly that reason — a consumer that reads one
 *  without the other can read a capped list as a complete one. */
export interface MergeCaptureInput {
  mergedAt: Date | null;
  changedPaths: string[];
  changedPathsTruncated: boolean;
}

/** What a head carries under `docs/decisions/` (MOTIR-5674) — the four columns
 *  `recordDecisionDocCapture` writes as one. */
export interface DecisionDocCaptureInput {
  outcome: DecisionDocOutcome;
  path: string | null;
  blobSha: string | null;
  headSha: string | null;
  /** Every document the head writes (MOTIR-5678). */
  paths: string[];
}

/** One open-delivery reconcile candidate (MOTIR-5390): the mirror row, the
 *  connection tier the host read needs, and the delivery rows that say which
 *  cards — in which workspaces — the pull request delivers. */
export type ReconcileCandidate = GithubPullRequest & {
  repo: GithubRepo & { installation: GithubInstallation };
  deliveries: { workItemId: string; workspaceId: string }[];
};

/**
 * The SET clauses that carry the stored mergeability reading into the `previous_*` pair
 * (Bug MOTIR-10791) — moved there when the reading about to be written is about a
 * DIFFERENT head and the stored one was DECIDED (neither null nor the host's `unknown`);
 * left as they are otherwise. Postgres evaluates every SET expression against the row as
 * it was before the statement, so the pair receives the reading being replaced.
 *
 * ⚠️ AN UNDECIDED READING IS NOT CARRIED. A push that is replaced before the host answers
 * about it says nothing about whether the base merged, so the reading before it — the one
 * the next push still answers — stays the previous one.
 */
function carryPreviousMergeability(nextHeadSha: string | null): Prisma.Sql {
  const carry = Prisma.sql`(mergeable_state_head_sha IS NOT NULL
    AND mergeable_state_head_sha IS DISTINCT FROM ${nextHeadSha}
    AND mergeable_state IS NOT NULL
    AND mergeable_state <> ${PENDING_MERGEABLE_STATE})`;
  return Prisma.sql`previous_mergeable_state = CASE WHEN ${carry}
      THEN mergeable_state ELSE previous_mergeable_state END,
    previous_mergeable_state_head_sha = CASE WHEN ${carry}
      THEN mergeable_state_head_sha ELSE previous_mergeable_state_head_sha END`;
}

export const githubPullRequestRepository = {
  /**
   * Every OPEN pull request Motir has neither merged nor queued — no `merge_outcome_ref`
   * at all (MOTIR-5809). Cross-tenant, under the system arm: it is the candidate scan for
   * a press whose refusal nobody recorded, and the card's own gate is then read under its
   * own workspace context.
   */
  async listOpenWithNoMergeOutcome(tx: Prisma.TransactionClient): Promise<string[]> {
    const rows = await tx.githubPullRequest.findMany({
      where: { state: 'open', merged: false, mergeOutcomeRef: null },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  },

  /**
   * Every OPEN, unmerged pull request on one repository that TARGETS `baseRef` and
   * delivers at least one work item (MOTIR-5914) — the set a push to that branch can
   * newly put in conflict. Under the system arm, like the other delivery-bound scans:
   * `github_pull_request` and `work_item_delivery` both carry `app.system_admin`.
   */
  async listOpenDeliveringByRepoAndBase(
    repoId: string,
    baseRef: string,
    tx: Prisma.TransactionClient,
  ): Promise<Array<{ id: string; number: number }>> {
    return tx.githubPullRequest.findMany({
      where: { repoId, baseRef, state: 'open', merged: false, deliveries: { some: {} } },
      select: { id: true, number: true },
      orderBy: { number: 'asc' },
    });
  },

  /** One PR by its `(repo, number)` identity, or null. */
  async findByRepoAndNumber(
    repoId: string,
    number: number,
    tx: Prisma.TransactionClient,
  ): Promise<GithubPullRequest | null> {
    return tx.githubPullRequest.findUnique({ where: { repoId_number: { repoId, number } } });
  },

  /** Take a row lock on the `(repo, number)` PR (if it exists) so a read-derived
   *  write serializes against a concurrent one (the lock-before-read-derived-
   *  update rule). A no-op when the row does not exist yet (a brand-new PR; the
   *  upsert's P2002 catch still converges concurrent inserts).
   *
   *  ⚠️ ITS ORIGINAL JUSTIFICATION IS GONE AND THE LOCK IS NOT (MOTIR-4894). It
   *  was taken so the webhook could read `linked_manually` and decide whether to
   *  preserve it (MOTIR-1596); that derivation is deleted. What still derives
   *  from this read are `syncChangeRequestStatus`'s `mergeAlreadyRecorded` — a
   *  decision made from the row's PRIOR `state` / `merged` — and
   *  `linkPullRequestByCoordinates`'s create-or-touch branch, which asks whether
   *  a row exists before writing the caller's stale `state: 'open'`. Both are
   *  read-then-write and both clobber under a concurrent delivery without it. */
  async lockByRepoAndNumber(
    repoId: string,
    number: number,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM github_pull_request WHERE repo_id = ${repoId} AND number = ${number} FOR UPDATE`;
  },

  /** Take a row lock on the PR by its internal id, so the ONE CI-feedback comment
   *  a change request carries at a head sha is claimed by exactly one of the N
   *  concurrent check deliveries (MOTIR-2946). The feedback body is DERIVED from
   *  every check row at that sha and then written as a comment, so without the
   *  lock two deliveries both read "no comment yet" and both create one — the
   *  lock-before-read-derived-update rule, with the comment as the derived write.
   *  A no-op when the row does not exist (the caller has already resolved it, so
   *  in practice it always does). */
  async lockById(id: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.$queryRaw`SELECT id FROM github_pull_request WHERE id = ${id} FOR UPDATE`;
  },

  /** The PR on a repo's head branch (`head_ref`), preferring the OPEN one — the
   *  CI-event fallback when the check payload carries no PR number list. Stable
   *  across a re-push (unlike a head SHA). Open-first, then newest, so a reused
   *  branch resolves to the live PR. */
  async findByRepoAndHeadRef(
    repoId: string,
    headRef: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubPullRequest | null> {
    // `state` is 'open' | 'closed'; DESC puts 'open' before 'closed' so a reused
    // branch resolves to the live PR, then newest first.
    return tx.githubPullRequest.findFirst({
      where: { repoId, headRef },
      orderBy: [{ state: 'desc' }, { updatedAt: 'desc' }],
    });
  },

  /** One repository's MERGED change requests whose `base_ref` is NULL — the rows
   *  the completion gate reads as UNKNOWN (MOTIR-3034). Exactly the population
   *  the base-ref backfill repairs, and the reason a second run of that backfill
   *  makes zero host calls: a filled row leaves this set.
   *
   *  MERGED ONLY, and that is the decision the card asked to be recorded rather
   *  than a narrowing. `classifyRepoDelivery` filters on `f.merged` before it ever
   *  looks at `baseRef`, so an unmerged row's null base is never a term in the
   *  gate; and an OPEN change request's base is still mutable, so a value read
   *  today can be wrong tomorrow and the next delivery writes the right one
   *  anyway. Spending a rate-limited request on either buys nothing.
   *
   *  ⚠️ NO CARD ID IN THE PROJECTION (MOTIR-3721), and its absence is the
   *  point rather than a tidy-up. The card ids this sweep must re-evaluate come
   *  from `workItemDeliveryRepository.listWorkItemIdsByPullRequests` over the rows
   *  it actually filled — a SET per pull request, which a scalar column could not
   *  express. The projection and its consumer are the two ends of ONE path (ADR
   *  §5): read the ids off this row and a pull request delivering three cards
   *  re-evaluates one of them, or none, and the sweep reports `filled: N` either
   *  way, having repaired nothing and raised nothing.
   *
   *  Read guarding a write → takes `tx`. Ordered so a long sweep's log is
   *  diffable and resumable by eye. */
  async listMergedMissingBaseRefByRepo(
    repoId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Array<{ id: string; number: number }>> {
    return tx.githubPullRequest.findMany({
      where: { repoId, merged: true, baseRef: null },
      select: { id: true, number: true },
      orderBy: { number: 'asc' },
    });
  },

  /** Write a `base_ref` onto a row that does NOT have one, and return how many
   *  rows that touched — 0 when a concurrent delivery filled it first
   *  (MOTIR-3034).
   *
   *  `updateMany` with `baseRef: null` in the WHERE is what makes the backfill
   *  idempotent AT THE DATABASE rather than by the caller remembering to check:
   *  a row that already carries a base is never rewritten, so its `updated_at`
   *  never churns and a live delivery's value is never clobbered by a slower
   *  historical read. It also means a re-run is a no-op by construction rather
   *  than by a comparison the caller might get wrong. Write path → `tx`. */
  async setBaseRefIfNull(
    id: string,
    baseRef: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.githubPullRequest.updateMany({
      where: { id, baseRef: null },
      data: { baseRef },
    });
    return result.count;
  },

  /** A work item's DELIVERING PRs, newest-updated first, with the repo + check
   *  rows the Development surface renders (MOTIR-1579, moved to the delivery set
   *  by MOTIR-3756).
   *
   *  The `where` is a relation filter on `work_item_delivery` rather than the
   *  singular column, so a pull request delivering this card AND others is listed
   *  here exactly once — which is the shape the column could not express and the
   *  reason the Development surface came back SHORT: a `motir auto` pull request
   *  carrying twelve cards named one of them in the FK and was invisible to the
   *  other eleven.
   *
   *  ⚠️ `tx` is REQUIRED, and that is the point rather than tidiness. This read
   *  now crosses a table whose ONLY tenant gate is an RLS policy on
   *  `app.workspace_id`; through the bare `db` singleton the delivery subquery
   *  matches nothing and the answer is an EMPTY LIST rather than an error —
   *  indistinguishable from "this card has no pull requests", which is by a wide
   *  margin the worse failure. Requiring the transaction turns that into a type
   *  error at the call site (`workItemDeliveryRepository`'s own header states the
   *  same rule for the same reason). */
  async listByWorkItemWithContext(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubPullRequestWithContext[]> {
    return tx.githubPullRequest.findMany({
      where: { deliveries: { some: { workItemId } } },
      include: { repo: true, checkRuns: true },
      orderBy: { updatedAt: 'desc' },
    });
  },

  /**
   * Every change request whose HEAD REF is this branch, with its check rows —
   * the SESSION-BRANCH arm of the CI-green latch (MOTIR-3006).
   *
   * A session pull request is opened on a branch that deliberately names no card,
   * so a card integrated onto that branch is not reachable from anything on the
   * pull request itself. The branch is the join, and it is the same join the
   * merge close-out uses.
   */
  async listByHeadRefWithChecks(
    headRef: string,
    tx?: Prisma.TransactionClient,
  ): Promise<GithubPullRequestWithChecks[]> {
    const client = tx ?? dbRead;
    return client.githubPullRequest.findMany({
      where: { headRef },
      include: { checkRuns: true },
      orderBy: { updatedAt: 'desc' },
    });
  },

  /**
   * Which of these repositories has EVER recorded a check run (MOTIR-3823) —
   * the first half of the CI-green promotion's *can this repository report?*
   * question.
   *
   * `distinct` on the repository rather than a count: the question is existence,
   * and a repository with ten thousand reporting pull requests must not pay to
   * say so. Read inside the promotion's transaction, so it takes `tx`.
   */
  async listRepoIdsWithAnyCheckRun(
    repoIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<string[]> {
    if (repoIds.length === 0) return [];
    const rows = await tx.githubPullRequest.findMany({
      where: { repoId: { in: [...repoIds] }, checkRuns: { some: {} } },
      select: { repoId: true },
      distinct: ['repoId'],
    });
    return rows.map((row) => row.repoId);
  },

  /**
   * Which of these repositories has a pull request that Motir WATCHED all the way
   * to MERGE without ever recording a check run (MOTIR-3823) — the second half of
   * the CI-less question, and the one that is EVIDENCE rather than the absence of
   * it.
   *
   * A merged pull request had its whole lifetime to produce a check and produced
   * none, which is what separates *this repository has no CI* from *this
   * repository has not run CI yet*. The interpretation is
   * `repoCannotReportChecks` in `lib/workItems/deliverySet.ts`; this read supplies
   * a fact and decides nothing.
   *
   * ⚠️ `created_at <= merged_at` IS THE LOAD-BEARING CLAUSE, AND IT IS WHY THIS IS
   * RAW SQL. Without it the BACKFILL supplies the evidence:
   * `historicalPullRequestBackfillService` mirrors a repository's pre-connection
   * pull requests through the same upsert, merged, and with no check rows —
   * because Motir was not there to receive them. A repository connected mid-life
   * therefore arrives carrying dozens of merged silent rows and would read as
   * CI-less on its first day, promoting every one of its cards to In Review before
   * any build had spoken. That is the exact regression this whole discriminator
   * exists to avoid, arriving through the back door.
   *
   * A row Motir WATCHED was created by the `opened` delivery, so it predates its
   * own merge; a row the backfill wrote was created long after. Comparing two
   * columns of the same row is not expressible in Prisma's typed `where`, so this
   * is `$queryRaw` — the sanctioned repository escape, still one operation.
   *
   * A null `merged_at` fails the comparison and is excluded, which is the
   * withholding direction: a row that does not know when it merged is not
   * evidence about anything.
   */
  async listRepoIdsWithAWatchedMergeWithoutChecks(
    repoIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<string[]> {
    if (repoIds.length === 0) return [];
    const rows = await tx.$queryRaw<Array<{ repoId: string }>>`
      SELECT DISTINCT pr."repo_id" AS "repoId"
      FROM "github_pull_request" pr
      WHERE pr."repo_id" IN (${Prisma.join([...repoIds])})
        AND pr."merged" = true
        AND pr."merged_at" IS NOT NULL
        AND pr."created_at" <= pr."merged_at"
        AND NOT EXISTS (
          SELECT 1 FROM "github_check_run" cr WHERE cr."pull_request_id" = pr."id"
        )
    `;
    return rows.map((row) => row.repoId);
  },

  /**
   * Every DISTINCT head ref a pull request sits on, with the workspace of the
   * repository it belongs to — the CI-state backfill's SECOND candidate arm
   * (MOTIR-5472).
   *
   * ── Why this arm exists at all ────────────────────────────────────────────
   * A `motir auto` run integrates its cards onto one session branch and opens ONE
   * pull request for it, which is linked to nothing. Such a card is reachable
   * only through `work_item.session_branch = pr.head_ref`, which is precisely why
   * the old writer never wrote it a verdict. The delivery arm cannot see it.
   *
   * ── Why it comes from the PULL REQUEST side ───────────────────────────────
   * The candidate is a WORK ITEM, and `work_item` carries no `system_admin` arm,
   * so a cross-tenant scan of it is silently empty. `github_pull_request` and
   * `github_repo` are both armed, so the sweep reads the head refs here — under
   * system context, admitted — and then binds each workspace to ask its own cards
   * which of them sit on one. The tenant travels with the ref for the same reason
   * it travels with a delivery row: it is resolved from data, never passed in.
   *
   * `$queryRaw` because the distinct pair spans the repo join, which Prisma's
   * `distinct` cannot express — the sanctioned repository escape, still one
   * operation.
   */
  async listHeadRefsWithWorkspace(
    tx: Prisma.TransactionClient,
    opts: { workspaceId?: string } = {},
  ): Promise<Array<{ workspaceId: string; headRef: string }>> {
    const rows = await tx.$queryRaw<Array<{ workspaceId: string; headRef: string }>>`
      SELECT DISTINCT r."workspace_id" AS "workspaceId", pr."head_ref" AS "headRef"
      FROM "github_pull_request" pr
      JOIN "github_repo" r ON r."id" = pr."repo_id"
      WHERE pr."head_ref" <> ''
        ${opts.workspaceId ? Prisma.sql`AND r."workspace_id" = ${opts.workspaceId}` : Prisma.empty}
      ORDER BY "workspaceId" ASC, "headRef" ASC
    `;
    return rows;
  },

  /** One PR by its internal id, with its repo + parent installation (the
   *  workspace-tenancy chain the explicit-link service validates) + check rows
   *  (the returned DTO). Read guarding a write → takes `tx`. Null when absent. */
  async findByIdWithInstallation(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<GithubPullRequestWithInstallation | null> {
    return tx.githubPullRequest.findUnique({
      where: { id },
      include: { repo: { include: { installation: true } }, checkRuns: true },
    });
  },

  /** Candidate PRs for the explicit-link picker (MOTIR-1596): the ORGANISATION's
   *  ingested PRs (installation → repo → PR), matched by title / repo owner+name
   *  / number **or by a PR REFERENCE the query names** (MOTIR-5150 — a pasted
   *  URL, `owner/name#n`, `name#n`, `#n`; see `lib/github/prReferenceQuery.ts`),
   *  newest-updated first, bounded to `take`. Includes each PR's repo
   *  Read-only path → `db`; `organizationId` is the explicit tenant gate
   *  (finding #26 — RLS is inert under the dev/CI superuser).
   *
   *  ⚠️ THE GATE IS THE ORGANISATION SINCE MOTIR-5152, and the widening is a
   *  READ only. It was `workspaceId`, which is the tier a repository is
   *  connected FROM rather than the tier that OWNS it (MOTIR-4649): in any
   *  workspace but that one the gate matched nothing, so the picker's caller
   *  raised `GithubNotConnectedError` and, past it, this read would have found
   *  no candidate anyway. Both halves had to move together, which is why they
   *  moved on one card. `github_pull_request_org_read` is the RLS arm that
   *  admits the same set under the `motir_app` role; this `where` is what
   *  enforces it under the dev/CI superuser, where RLS is inert. No write path
   *  is widened — the `FOR ALL` policies are untouched, per MOTIR-4677's
   *  DELETE-is-authorised-by-USING-alone reasoning.
   *
   *  ⚠️ NO WORK-ITEM INCLUDE (MOTIR-3756). It used to carry
   *  `workItem: { select: { identifier: true } }` — the single item the FK named,
   *  which the picker rendered as the "Linked to MOTIR-n" takeover chip. A
   *  candidate now delivers a SET, so the identifiers come from
   *  `workItemDeliveryRepository.listByPullRequests` in one batched read beside
   *  this one; an `include` cannot express it, because the relation the FK
   *  declares is the singular one being retired. */
  async searchCandidates(
    organizationId: string,
    query: string,
    take: number,
    tx?: Prisma.TransactionClient,
  ): Promise<GithubPullRequestCandidate[]> {
    const client = tx ?? dbRead;
    const trimmed = query.trim();
    const asNumber = /^\d+$/.test(trimmed) ? Number(trimmed) : null;
    const match: Prisma.GithubPullRequestWhereInput[] = [
      { title: { contains: trimmed, mode: 'insensitive' } },
      { repo: { is: { owner: { contains: trimmed, mode: 'insensitive' } } } },
      { repo: { is: { name: { contains: trimmed, mode: 'insensitive' } } } },
    ];
    if (asNumber !== null && Number.isSafeInteger(asNumber)) match.push({ number: asNumber });
    // MOTIR-5150 — the PR-REFERENCE arm, ADDED to the four above rather than
    // replacing them. Every clause so far asks whether a COLUMN contains the
    // query, so the one thing a person linking a pull request actually holds —
    // its URL — matched nothing: a URL is not all digits and no title, owner or
    // name contains it. A parsed reference matches EXACTLY instead, which is
    // also what makes `owner/name#n` unambiguous where a bare number is not.
    const reference = parsePullRequestReference(trimmed);
    if (reference) {
      match.push({
        number: reference.number,
        ...(reference.owner || reference.name
          ? {
              repo: {
                is: {
                  // `equals` + insensitive, not `contains`: a coordinate names one
                  // repository, and `acme` must not reach `acme-internal`.
                  ...(reference.owner
                    ? { owner: { equals: reference.owner, mode: 'insensitive' as const } }
                    : {}),
                  ...(reference.name
                    ? { name: { equals: reference.name, mode: 'insensitive' as const } }
                    : {}),
                },
              },
            }
          : {}),
      });
    }
    return client.githubPullRequest.findMany({
      // Gate on the REPO row's own `organization_id` (MOTIR-1931's reasoning at
      // the tier MOTIR-4649 moved tenancy to), not a join through the
      // installation: a PR on a repo Motir created sits behind the shared
      // provisioning installation, which is bound to neither a workspace nor an
      // organisation, so the old join would never have matched it. The column is
      // NOT NULL (MOTIR-4700), so no row escapes this gate by carrying a null.
      where: { repo: { is: { organizationId } }, OR: match },
      include: { repo: true },
      orderBy: { updatedAt: 'desc' },
      take,
    });
  },

  /* ⚠️ `markLinkedManually` WAS HERE and is deleted by MOTIR-4894 — the LAST
   * writer of `linked_manually`, and with it the last thing on either side of
   * that column in application code.
   *
   * It was what remained of `setWorkItemLink` after MOTIR-3757 dropped
   * `work_item_id`: a one-column update stamping a link as DECLARED rather than
   * inferred, kept so a row written after the drop would mean what one written
   * before it meant. That argument held only while something could tell the two
   * apart, and nothing can — MOTIR-3674 deleted the inferring resolver, so every
   * link is declared and the stamp asserted a universal.
   *
   * Its callers wanted the re-read as much as the write, and they still get it:
   * `githubPullRequestService` now reads through `findByIdWithInstallation`,
   * which returns the same `GithubPullRequestWithInstallation` the DTO is built
   * from. Nothing about the row changes on a link any more, so there is nothing
   * to re-read FOR — only the row itself. */

  /** Store the host's answer to *can this merge into its base?* and the head it is
   *  about (MOTIR-5913, for bug MOTIR-5907). Written by whoever ASKED the host — the
   *  base-branch push re-evaluation, the press-time read, the reconcile tick — never
   *  from a webhook payload, which does not carry a conflict that the BASE caused.
   *  A reading about another head than the stored one's carries the stored reading into
   *  `previousMergeableState` when it was decided (MOTIR-10791,
   *  {@link carryPreviousMergeability}) — one raw statement, because the carry reads the
   *  row it replaces. Write path → `tx`. */
  async setMergeability(
    pullRequestId: string,
    reading: { mergeableState: string | null; headSha: string | null },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE github_pull_request SET
        ${carryPreviousMergeability(reading.headSha)},
        mergeable_state = ${reading.mergeableState},
        mergeable_state_head_sha = ${reading.headSha},
        updated_at = now()
      WHERE id = ${pullRequestId}`;
  },

  /** Store the host's HEAD commit (MOTIR-7005) — the commit `pullRequestHead` reads
   *  as the pull request's, in place of the newest check row's. Written by a
   *  `synchronize` delivery (a push, which the status sync does not see) and by every
   *  host read that learns the head, so a push that produced no CI still moves it.
   *  One statement; a row already at that head matches nothing. Write path → `tx`. */
  async setHeadSha(
    pullRequestId: string,
    headSha: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.githubPullRequest.updateMany({
      // `OR` with the null arm spelled out: SQL's `<>` is not true of a NULL head.
      where: { id: pullRequestId, OR: [{ headSha: null }, { headSha: { not: headSha } }] },
      data: { headSha },
    });
    return result.count;
  },

  /** Record that the HOST confirmed CI had decided the WHOLE check set at `commitSha`
   *  (Bug MOTIR-10797) — the marker `hasHeadDecidedBeforeRunningChecks` reads. Written only
   *  while that commit IS the pull request's head (or the row has no stored head yet, when
   *  the check rows' head stands in for it): a late reconcile about an older commit must not
   *  replace the marker of the head it was pushed over. One statement; answers how many rows
   *  it wrote (0 when the head has moved or the marker is already there). Write path → `tx`. */
  async markCiDecided(
    pullRequestId: string,
    commitSha: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.githubPullRequest.updateMany({
      where: {
        id: pullRequestId,
        AND: [
          { OR: [{ headSha: null }, { headSha: commitSha }] },
          // `OR` with the null arm spelled out: SQL's `<>` is not true of a NULL marker.
          { OR: [{ ciDecidedSha: null }, { ciDecidedSha: { not: commitSha } }] },
        ],
      },
      data: { ciDecidedSha: commitSha },
    });
    return result.count;
  },

  /** Mark the reading OWED at a new head — a `synchronize` replaces the old head's
   *  reading, so its `dirty` cannot hold the new one (MOTIR-5913), with the host's
   *  "not computed yet" word AT that head rather than with nothing (MOTIR-7063): `null`
   *  read as "no conflict", and CI promoted a head nobody had asked about. The
   *  `pull-request/head-moved` re-read overwrites it with the host's answer. One
   *  statement, unconditional: a `NOT { … }` guard would skip exactly the never-read
   *  row, whose NULL columns make the comparison unknown. The decided reading it replaces
   *  at another head is carried into `previousMergeableState` (MOTIR-10791) in the same
   *  statement. Write path → `tx`. */
  async markMergeabilityPending(
    pullRequestId: string,
    headSha: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.$executeRaw`
      UPDATE github_pull_request SET
        ${carryPreviousMergeability(headSha)},
        mergeable_state = ${PENDING_MERGEABLE_STATE},
        mergeable_state_head_sha = ${headSha},
        updated_at = now()
      WHERE id = ${pullRequestId}`;
  },

  /** Record a merge MOTIR performed onto the pull request's row (MOTIR-5520;
   *  `approval-gates.md` §4 second amendment, decision 9) — WHO or WHAT authorised
   *  it and WHAT it produced. Written only by Motir's own merge paths (the gate's
   *  entry point, auto mode); the webhook owns `merged` / `mergedAt` and never
   *  touches these.
   *
   *  ⚠️ IDEMPOTENT BY ITS WHERE CLAUSE, NOT BY A READ: one statement that matches the
   *  row only when it does NOT already carry exactly this record, so re-recording the
   *  same values writes nothing and leaves `updatedAt` where it was. A DIFFERENT
   *  record overwrites — a queued pull request's `queue:<entryId>` can be followed by
   *  a later Motir merge of the same row — and the returned count is how the caller
   *  tells a write (1) from a no-op or a vanished row (0).
   *
   *  The null arms are load-bearing: `NOT (merge_authority = 'gate')` is NULL, not
   *  true, on an unrecorded row, so without them the FIRST write would match nothing.
   *  Write path → `tx`. */
  async recordMotirMerge(
    pullRequestId: string,
    record: MotirMergeRecordInput,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.githubPullRequest.updateMany({
      where: {
        id: pullRequestId,
        OR: [
          { mergeAuthority: null },
          { mergeOutcomeRef: null },
          { NOT: { mergeAuthority: record.mergeAuthority } },
          { NOT: { mergeOutcomeRef: record.mergeOutcomeRef } },
        ],
      },
      data: { mergeAuthority: record.mergeAuthority, mergeOutcomeRef: record.mergeOutcomeRef },
    });
    return result.count;
  },

  /** CLEAR a queued merge record when the queue removed the pull request (MOTIR-5632;
   *  `approval-gates.md` §4 THIRD AMENDMENT, decision 3) — only a `queue:` value,
   *  never a merge commit SHA, so a late removal delivery cannot erase a merge.
   *  `merge_authority` stays: it still says who asked for the enqueue. Returns the
   *  count (0 when the row carried no queued record). Write path → `tx`. */
  async clearQueuedOutcome(pullRequestId: string, tx: Prisma.TransactionClient): Promise<number> {
    const result = await tx.githubPullRequest.updateMany({
      where: { id: pullRequestId, mergeOutcomeRef: { startsWith: 'queue:' } },
      data: { mergeOutcomeRef: null },
    });
    return result.count;
  },

  /** The pull requests a page of merge gates asks about, keyed by id, with the
   *  repository and check rows a queue row renders (MOTIR-4793) — ONE query for the
   *  whole page, never one per gate. An id that no longer resolves is simply absent. */
  async findManyByIdsForSummary(
    ids: string[],
    tx: Prisma.TransactionClient,
  ): Promise<Map<string, GithubPullRequestWithContext>> {
    if (ids.length === 0) return new Map();
    const rows = await tx.githubPullRequest.findMany({
      where: { id: { in: ids } },
      include: { repo: true, checkRuns: true },
    });
    return new Map(rows.map((row) => [row.id, row]));
  },

  /** Stamp a merged PR's capture facts onto its row (MOTIR-2922). `updateMany`
   *  rather than `update` deliberately: this runs POST-COMMIT and best-effort, so
   *  the row it targets could have been deleted between the sync's commit and this
   *  write (a repo removal cascades), and a `P2025` thrown from a fire-and-forget
   *  side effect would be logged as a failure where the correct reading is "there
   *  is nothing left to stamp". Returns how many rows it touched so the caller can
   *  say which of the two happened. Write path → `tx`. */
  async recordMergeCapture(
    repoId: string,
    number: number,
    data: MergeCaptureInput,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.githubPullRequest.updateMany({
      where: { repoId, number },
      data: {
        mergedAt: data.mergedAt,
        changedPaths: data.changedPaths,
        changedPathsTruncated: data.changedPathsTruncated,
      },
    });
    return result.count;
  },

  /** Stamp what the pull request's HEAD carries under `docs/decisions/` onto its
   *  row (Story MOTIR-4907 · MOTIR-5674; `approval-gates.md` §8's FIFTH AMENDMENT,
   *  clause 7). All four columns are written together, every time, so a capture
   *  never leaves one outcome's path beside another outcome's word. `updateMany`
   *  for `recordMergeCapture`'s reason: this runs after the host read, outside the
   *  transaction that found the row, so the row may be gone. Write path → `tx`. */
  async recordDecisionDocCapture(
    id: string,
    data: DecisionDocCaptureInput,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.githubPullRequest.updateMany({
      where: { id },
      data: {
        decisionDocOutcome: data.outcome,
        decisionDocPath: data.path,
        decisionDocBlobSha: data.blobSha,
        decisionDocHeadSha: data.headSha,
        decisionDocPaths: data.paths,
      },
    });
    return result.count;
  },

  /** The DELIVERING GitHub pull requests whose last delivery may never have
   *  finished — the candidate set of the open-delivery reconcile (MOTIR-5390).
   *  Oldest first, capped at `take`, with the connection tier and the delivery
   *  rows the reconcile needs to decide liveness and read the host. Two arms:
   *
   *  - **OPEN**, quiet since `updatedBefore` — the merge delivery failed before
   *    the sync wrote anything, or never arrived.
   *  - **MERGED with no `mergedAt`**, quiet since `updatedBefore` but touched
   *    since `mergedSince` — the merge delivery wrote the row and then died
   *    before the post-commit capture that stamps `mergedAt`, i.e. somewhere in
   *    the transition. The lower bound keeps out rows mirrored before the
   *    `merged_at` column existed, which carry the same null for a different
   *    reason.
   *
   *  Every table this touches carries an `app.system_admin` arm
   *  (`github_pull_request`, `github_repo`, `github_installation`,
   *  `work_item_delivery`), which is what lets a cross-tenant discovery run under
   *  `withSystemContext`. It deliberately does NOT filter on the work item: that
   *  table has no such arm, so the liveness check is the service's, per tenant. */
  async listReconcileCandidates(
    opts: { updatedBefore: Date; mergedSince: Date; take: number },
    tx: Prisma.TransactionClient,
  ): Promise<ReconcileCandidate[]> {
    return tx.githubPullRequest.findMany({
      where: {
        provider: 'github',
        deliveries: { some: {} },
        OR: [
          { state: 'open', updatedAt: { lt: opts.updatedBefore } },
          {
            merged: true,
            mergedAt: null,
            updatedAt: { lt: opts.updatedBefore, gte: opts.mergedSince },
          },
        ],
      },
      include: {
        repo: { include: { installation: true } },
        deliveries: { select: { workItemId: true, workspaceId: true } },
      },
      orderBy: { updatedAt: 'asc' },
      take: opts.take,
    });
  },

  /** Record that the reconcile ASKED the host about this row and the answer
   *  changed nothing (MOTIR-5390). `updatedAt` is documented above as "when did we
   *  last hear about this PR", and a host read is exactly that — so moving it is
   *  what rotates a long-lived open pull request to the back of the candidate
   *  queue instead of letting it take a place in every run. `updateMany` for the
   *  reason `recordMergeCapture` gives: the row may be gone by now. Write → `tx`. */
  async markReconciled(id: string, tx: Prisma.TransactionClient): Promise<number> {
    const result = await tx.githubPullRequest.updateMany({
      where: { id },
      data: { updatedAt: new Date() },
    });
    return result.count;
  },

  /** The workspace's pull requests whose captured paths intersect `paths` — the
   *  single read a subsumption check consumes, so that consumer adds no data
   *  access of its own. TWO arms, and they answer different questions:
   *
   *  - **MERGED**, landing strictly after `since` (MOTIR-2922) — *the work may
   *    already be in the tree*. `since` exists because a merge that predates the
   *    asking card is the substrate it was written against, which is the opposite
   *    finding.
   *  - **OPEN** (MOTIR-3230) — *somebody is changing this path right now*. **No
   *    `since` clause, deliberately**: an open pull request is current by
   *    definition, so there is no interval in which it is too old to matter. The
   *    merged arm needs an ordering fact because a merge is permanent; the open arm
   *    does not, because being open is itself the recency.
   *
   *  ⚠️ WHY THE OPEN ARM IS THE ONE THAT MATTERS, said here because the change
   *  looks like a widening for completeness and is not. A pull request is merged
   *  for the rest of time and open for about an hour, so a merged-only read is
   *  available for the whole period in which the answer no longer changes anything
   *  and blind for the one window in which it would. Two sessions filing against a
   *  path one of them is already changing is the normal state of this project, and
   *  the second usually goes on to FIX it off the default branch, in ignorance —
   *  two green pull requests that cancel when both merge.
   *
   *  ⚠️ THERE IS NO EXCLUSION CLAUSE, and there never effectively was one
   *  (MOTIR-3756, ADR `docs/decisions/delivery-reader-migration.md` §4). This
   *  accessor carried an `excludeWorkItemId` parameter whose sole production
   *  caller passed `null`: `buildSubsumptionIndex` widens the query to the UNION
   *  of a whole batch's paths, so a per-SUBJECT clause cannot be expressed in the
   *  SQL at all and is re-applied in memory at
   *  `proseGraphAdvisoryService.subsumptionAdvisory`. Deleting the parameter
   *  leaves ONE spelling of the exclusion, in the layer that actually runs it.
   *
   *  The argument the parameter's own note made SURVIVES and becomes trivially
   *  true: rows linked to NO work item are KEPT — an unlinked merge touched the
   *  paths just the same, and the link is a fact about the tracker rather than
   *  about the repository. With no exclusion clause there is nothing that could
   *  drop them.
   *
   *  `workspaceId` is the explicit tenant gate on the REPO row (MOTIR-1931, and
   *  finding #26 — RLS is inert under the dev/CI superuser), never a join through
   *  the installation, which names no workspace under Motir's shared provisioning
   *  install. Read-only path → `db`, with `tx` accepted so a caller already inside
   *  a bound transaction keeps its context. */
  async findTouchingPaths(
    workspaceId: string,
    paths: string[],
    since: Date,
    tx?: Prisma.TransactionClient,
  ): Promise<GithubPullRequestWithRepo[]> {
    if (paths.length === 0) return [];
    const client = tx ?? dbRead;
    return client.githubPullRequest.findMany({
      where: {
        repo: { is: { workspaceId } },
        changedPaths: { hasSome: paths },
        // The two arms under an explicit `AND` member rather than beside the
        // `OR` above: an object literal carries one `OR`, so writing both at this
        // level would silently drop whichever was declared first. `AND` is the
        // only spelling under which each clause is independently true — and it is
        // kept with one member rather than flattened, because the recency arms and
        // the path/tenant clauses are two independent predicates and collapsing
        // them is how the second `OR` was lost in the first place.
        AND: [
          {
            OR: [
              {
                merged: true,
                // A merged PR is always closed, so this is redundant with `merged`
                // for every row the webhook writes — and it is what makes "omits an
                // inconsistent row" hold rather than merely usually hold.
                state: 'closed',
                mergedAt: { gt: since },
              },
              // `merged: false` beside the state for the same reason, plus one this
              // arm owns: it is what stops a row whose `state` some other path left
              // stale being read as in-flight work after it has already landed.
              { state: 'open', merged: false },
            ],
          },
        ],
      },
      include: { repo: true },
      // Merged rows descend by merge instant, as they always have. An OPEN row has
      // no `mergedAt` at all, so its position under this clause is a fact about the
      // database's null ordering rather than about the data — the consumer sorts the
      // two arms itself (`buildSubsumptionIndex`) rather than depending on it.
      orderBy: { mergedAt: 'desc' },
    });
  },

  /** Create-or-refresh a PR link, keyed on the unique `(repo_id, number)` pair. */
  async upsert(
    input: UpsertGithubPullRequestInput,
    tx: Prisma.TransactionClient,
  ): Promise<GithubPullRequest> {
    const { repoId, number, ...rest } = input;
    return tx.githubPullRequest.upsert({
      where: { repoId_number: { repoId, number } },
      create: { repoId, number, ...rest },
      update: rest,
    });
  },
};
