import type { Prisma, WorkItemDelivery } from '@/generated/prisma/client';
import { ApprovalGateDeliveryUnreadableError } from '@/lib/approvalGates/errors';
import type { LinkedChangeRequestCompletionFact } from '@/lib/repositories/githubPullRequestRepository';

// Single Prisma operations on the `work_item_delivery` table — the ONE association
// between a work item and a pull request, many-to-many in both directions (Story
// MOTIR-3655 · MOTIR-3657, ADR `docs/decisions/work-item-delivery-links.md`).
//
// N cards linking to the SAME pull-request row is N rows, and that is how one pull
// request delivers N cards; one card linking to two pull-request rows is two rows,
// and that is how a card spans repositories. Both directions are the same table
// read from opposite sides, which is why {@link listByWorkItem} and
// {@link listByPullRequest} are one query each and not two mechanisms.
//
// Writes require `tx`, the compile-time guarantee they run in a transaction. So do
// the READS here, which is a deliberate departure from the "reads may use the `db`
// singleton" half of the layer rule and is the same departure
// `workItemRepoRepository` makes, for the same reason: every row is gated by an RLS
// policy on `app.workspace_id`, a GUC bound by `withWorkspaceContext` on a
// TRANSACTION and by nothing else. A read through the bare singleton does not fail
// — it returns an EMPTY LIST, indistinguishable from "this card has no deliveries",
// which is by a wide margin the worse of the two failures. Requiring `tx` turns
// that into a type error at the call site.
//
// No business logic, no transactions, no DTO mapping — those belong in the services
// that compose this (`workItemsService`, `changeRequestStatusSync`, `ciPromotion`).

/** A delivery row joined to the pull request and repository it names — what a read
 *  needs to answer "has this member merged, and onto which default branch?" without
 *  a second round trip. */
export type WorkItemDeliveryWithPr = Prisma.WorkItemDeliveryGetPayload<{
  include: { pullRequest: true; repo: true };
}>;

const WITH_PR = { pullRequest: true, repo: true } as const;

/** A delivery row whose pull request also carries its CHECK ROWS — what a read has
 *  to have to derive the CI verdict (MOTIR-3697). Its own type, and its own read
 *  below, because the check rows are the expensive half: the completion gate and
 *  the CI promotion ask about MERGES and would pay for rows they never look at. */
export type WorkItemDeliveryWithChecks = Prisma.WorkItemDeliveryGetPayload<{
  include: { pullRequest: { include: { checkRuns: true } }; repo: true };
}>;

const WITH_CHECKS = {
  pullRequest: { include: { checkRuns: true } },
  repo: true,
} as const;

/** A merged delivery's host address — see
 *  {@link workItemDeliveryRepository.listMergedHostAddressesByWorkItem}. */
export interface MergedDeliveryHostAddress {
  /** The repository's provider discriminator (`github`, `gitlab`). */
  provider: string;
  /** The HOST's installation id (not the internal cuid) — what a token mint takes. */
  hostInstallationId: string;
  owner: string;
  name: string;
  number: number;
}

export const workItemDeliveryRepository = {
  /**
   * The work item a pull request delivers — its OLDEST link — with the two facts
   * the preview gate's pages show (MOTIR-5779): its identifier and title. Null
   * when no card is linked. Runs in a transaction bound to the pull request's
   * workspace, which `work_item`'s policy reads.
   */
  async findFirstWorkItemForPullRequest(
    githubPullRequestId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ identifier: string; title: string } | null> {
    const row = await tx.workItemDelivery.findFirst({
      where: { githubPullRequestId },
      orderBy: { createdAt: 'asc' },
      select: { workItem: { select: { identifier: true, title: true } } },
    });
    return row?.workItem ?? null;
  },

  /**
   * One card's DELIVERY SET — every pull request delivering it, oldest link first.
   *
   * This is the read the completion gate and the CI promotion both ask, and they
   * must ask it the same way: `deferred_incomplete_delivery_set` holds the card
   * until every member has MERGED, and `ciPromotion` withholds `in_review` until
   * every member is GREEN. One rule shape at two statuses, over one list.
   */
  async listByWorkItem(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<WorkItemDeliveryWithPr[]> {
    return tx.workItemDelivery.findMany({
      where: { workItemId },
      include: WITH_PR,
      orderBy: { createdAt: 'asc' },
    });
  },

  /**
   * Several cards' delivery sets in ONE query, in (card, link age) order.
   *
   * A batched read rather than N calls to {@link listByWorkItem}, because the
   * surfaces that need this need it for a LIST — a board column, a container's
   * children, the dispatch payload. Ordering by `workItemId` first keeps the
   * caller's grouping a single pass.
   */
  async listByWorkItems(
    workItemIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<WorkItemDeliveryWithPr[]> {
    if (workItemIds.length === 0) return [];
    return tx.workItemDelivery.findMany({
      where: { workItemId: { in: [...workItemIds] } },
      include: WITH_PR,
      orderBy: [{ workItemId: 'asc' }, { createdAt: 'asc' }],
    });
  },

  /**
   * One card's delivery set WITH the check rows behind each member's CI verdict
   * (MOTIR-3697) — what the DTO needs and what {@link listByWorkItem} deliberately
   * does not fetch.
   *
   * Same rows, same order, one heavier `include`. Kept apart from
   * {@link listByWorkItem} rather than folded into it because the two callers want
   * genuinely different things: the completion gate asks *has it merged*, which the
   * pull-request row answers on its own, while a READER also asks *is it green*,
   * which only the check rows can. Widening the gate's read would make every
   * completion evaluation drag every check row of every delivery for an answer it
   * never consults.
   */
  /**
   * The BATCHED form of {@link listByWorkItemWithChecks} — several cards' delivery
   * sets WITH their check rows, in ONE query (MOTIR-1793).
   *
   * The run view needs *did each leg ship, and is it green* for a whole set at
   * once, and a per-leg read would be an N+1 on that page's only query. It is
   * separate from {@link listByWorkItems} for the reason the single-card pair is
   * separate: the check rows are the expensive half, and the completion gate asks
   * only *has it merged*.
   */
  async listByWorkItemsWithChecks(
    workItemIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<WorkItemDeliveryWithChecks[]> {
    if (workItemIds.length === 0) return [];
    return tx.workItemDelivery.findMany({
      where: { workItemId: { in: [...workItemIds] } },
      include: WITH_CHECKS,
      orderBy: [{ workItemId: 'asc' }, { createdAt: 'asc' }],
    });
  },

  /**
   * ⚠️ AND IT ANSWERS THE WHOLE SET OR REFUSES (Bug MOTIR-8236). This is the read the
   * approval gates and approve-and-merge decide over. A delivery row is admitted on
   * the CARD's workspace, but its pull request and repository are admitted through
   * `github_repo`'s policies, so a repository that has left the card's organisation
   * comes back as a visible row with NULL joins — which the generated type says cannot
   * happen, and every caller dereferenced. A member silently dropped here would let a
   * decision be taken over part of the set, so a set with an unreadable member raises
   * {@link ApprovalGateDeliveryUnreadableError}, naming those deliveries, rather than
   * returning it. The display reads take the other answer and drop the member
   * (MOTIR-8215).
   */
  async listByWorkItemWithChecks(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<WorkItemDeliveryWithChecks[]> {
    const rows = await tx.workItemDelivery.findMany({
      where: { workItemId },
      include: WITH_CHECKS,
      orderBy: { createdAt: 'asc' },
    });
    // The type says these joins are never null; under RLS they can be.
    const unreadable = rows.filter(
      (row) =>
        (row.pullRequest as WorkItemDeliveryWithChecks['pullRequest'] | null) === null ||
        (row.repo as WorkItemDeliveryWithChecks['repo'] | null) === null,
    );
    if (unreadable.length > 0) {
      throw new ApprovalGateDeliveryUnreadableError(
        workItemId,
        unreadable.map((row) => row.id),
      );
    }
    return rows;
  },

  /**
   * {@link listByWorkItemWithChecks}, restricted to the members whose pull
   * request AND repository the bound reader can see (Bug MOTIR-8215) — the read a
   * DISPLAY surface asks.
   *
   * ⚠️ THE TWO JOINS ARE GATED BY DIFFERENT POLICIES THAN THE ROW. A delivery row
   * is admitted on its own `workspace_id`, the card's. The pull request and the
   * repository are admitted through `github_repo` — its workspace, or the
   * reader's ORGANISATION (`20260905214500_github_org_read_arms`). When the
   * repository stops belonging to that organisation (another organisation
   * connecting the same GitHub installation re-stamps it), the delivery row is
   * still visible and the relation it includes comes back NULL, which the
   * generated type says cannot happen. Every display mapper then threw reading
   * `pullRequest.checkRuns`, taking the peek, the item page and the approval
   * overlay down with it.
   *
   * The two relation filters below put the same policies in the WHERE, so a
   * member the reader cannot see is absent from the answer rather than present
   * with a hole in it — RLS's own semantics, and the shape the generated type
   * already promises. Still one query.
   *
   * Kept apart from {@link listByWorkItemWithChecks} on purpose: the gates and the
   * merge read the WHOLE set, and a member silently dropped there would let a
   * decision be taken over part of it.
   */
  async listReadableByWorkItemWithChecks(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<WorkItemDeliveryWithChecks[]> {
    return tx.workItemDelivery.findMany({
      where: { workItemId, pullRequest: { is: {} }, repo: { is: {} } },
      include: WITH_CHECKS,
      orderBy: { createdAt: 'asc' },
    });
  },

  /**
   * The WORKSPACE that owns a card's deliveries, or null when it has none
   * (MOTIR-3721, moving `githubPullRequestRepository.findWorkspaceIdByWorkItem`).
   *
   * This is the re-evaluation path's TRUSTED workspace resolution: the only way a
   * caller holding just a work-item id can learn the tenant it must bind before
   * touching `work_item`, a table with no `system_admin` arm (MOTIR-2880). The
   * delivery row carries `workspace_id` DIRECTLY, so unlike the connection-tier
   * read it replaces there is no join at all — and RLS does not traverse foreign
   * keys, so a join would not have helped anyway (ADR §1 measured exactly that).
   *
   * ⚠️ IT IS ADMITTED ONLY BECAUSE THIS TABLE CARRIES THE `app.system_admin` ARM
   * (migration `20260828120000_work_item_delivery_system_arm`). Without it the read
   * returns an EMPTY LIST inside `withSystemContext` and raises nothing, which is
   * this module's own stated worst failure. The arm and this method ship together.
   *
   * Oldest link first, matching the read it replaces — a card's deliveries all
   * belong to one workspace, so the order decides nothing; it is kept so a
   * multi-row card resolves deterministically.
   */
  async findWorkspaceIdByWorkItem(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<string | null> {
    const row = await tx.workItemDelivery.findFirst({
      where: { workItemId },
      select: { workspaceId: true },
      orderBy: { createdAt: 'asc' },
    });
    return row?.workspaceId ?? null;
  },

  /**
   * Count a card's OTHER delivering pull requests (excluding `excludePrId`) that
   * are still OPEN (MOTIR-3721, moving
   * `githubPullRequestRepository.countOtherOpenByWorkItem`).
   *
   * The status sync uses it so a merge only COMPLETES the card when it is the
   * card's LAST open delivering pull request: a cross-repo card must not flip Done
   * while a sibling is still open (MOTIR-1604). A read guarding the transition
   * write → takes `tx`.
   */
  async countOtherOpenByWorkItem(
    workItemId: string,
    excludePrId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.workItemDelivery.count({
      where: {
        workItemId,
        githubPullRequestId: { not: excludePrId },
        pullRequest: { is: { state: 'open' } },
      },
    });
  },

  /**
   * Count a card's delivering pull requests that are still OPEN (MOTIR-3721,
   * moving `githubPullRequestRepository.countOpenByWorkItem`).
   *
   * The re-evaluation path (MOTIR-3034) uses it where the sync uses
   * {@link countOtherOpenByWorkItem}: there a delivery is being decided and the
   * DELIVERING row must be excluded from its own gate, here there is no delivery
   * at all, so every open sibling counts. Deliberately a second method rather than
   * a nullable exclusion on the first — the two callers ask different questions,
   * and a nullable argument would make WHICH one a property of a call site.
   */
  async countOpenByWorkItem(workItemId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.workItemDelivery.count({
      where: { workItemId, pullRequest: { is: { state: 'open' } } },
    });
  },

  /**
   * A card's deliveries, as the COMPLETION facts the repository-SET gate decides
   * on (MOTIR-3721, moving
   * `githubPullRequestRepository.listCompletionFactsByWorkItem`): which repository
   * each landed in, whether it merged, which branch it targeted, and that
   * repository's own default branch.
   *
   * Reads the repository off the DELIVERY row rather than the pull request's,
   * which is the same repository by construction (`link_pull_request` stores the
   * pull request's own `repo_id`) and is the column this table carries precisely
   * so the gate can compare each member against its own default branch without a
   * join per member.
   *
   * Takes a REQUIRED `tx`: it guards a status WRITE and must run inside the sync's
   * resolve transaction, under the row lock already taken, so concurrent
   * redeliveries serialize on it exactly as the shipped gates do.
   */
  async listCompletionFactsByWorkItem(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<LinkedChangeRequestCompletionFact[]> {
    const rows = await tx.workItemDelivery.findMany({
      where: { workItemId },
      select: {
        repo: { select: { name: true, defaultBranch: true } },
        pullRequest: { select: { merged: true, baseRef: true, state: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      repoName: r.repo.name,
      repoDefaultBranch: r.repo.defaultBranch,
      merged: r.pullRequest.merged,
      baseRef: r.pullRequest.baseRef,
      open: !r.pullRequest.merged && r.pullRequest.state === 'open',
    }));
  },

  /**
   * Where each MERGED pull request delivering one card lives on its host — the
   * provider, the host's installation id, the repository and the number (Bug
   * MOTIR-8330). It is the address the monitor hands the host to ask whether a
   * deployed release carries the merge that completed the bug.
   *
   * Merged rows only: an open or closed-unmerged pull request landed nothing a
   * release could carry. Oldest link first, like every read on this table.
   */
  async listMergedHostAddressesByWorkItem(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<MergedDeliveryHostAddress[]> {
    const rows = await tx.workItemDelivery.findMany({
      where: { workItemId, pullRequest: { merged: true } },
      select: {
        repo: {
          select: {
            provider: true,
            owner: true,
            name: true,
            installation: { select: { installationId: true } },
          },
        },
        pullRequest: { select: { number: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      provider: r.repo.provider,
      hostInstallationId: r.repo.installation.installationId,
      owner: r.repo.owner,
      name: r.repo.name,
      number: r.pullRequest.number,
    }));
  },

  /**
   * Every card delivered by ANY of `githubPullRequestIds`, de-duplicated
   * (MOTIR-3721 — the consumer half of the base-ref backfill's candidate read).
   *
   * The backfill fills a `base_ref` on N pull requests and then re-evaluates every
   * card those merges could have completed. It used to take the card ids off the
   * candidate rows' own link column, which is exactly the projection this card
   * moves; over the delivery table the answer is a set per pull request, so the
   * read is batched rather than run per candidate.
   */
  async listWorkItemIdsByPullRequests(
    githubPullRequestIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<string[]> {
    if (githubPullRequestIds.length === 0) return [];
    const rows = await tx.workItemDelivery.findMany({
      where: { githubPullRequestId: { in: [...githubPullRequestIds] } },
      select: { workItemId: true },
      distinct: ['workItemId'],
      orderBy: { workItemId: 'asc' },
    });
    return rows.map((r) => r.workItemId);
  },

  /**
   * EVERY card that has a delivery link at all, with the workspace each one
   * belongs to — the CI-state backfill's first candidate arm (MOTIR-5472).
   *
   * The workspace comes off the DELIVERY ROW, never from caller input: the
   * backfill holds no tenant of its own, and `work_item` has no `system_admin`
   * arm, so every card it touches has to be reached by binding a workspace this
   * read resolved (`repoSetCompletionService.reevaluateItem`'s rule, one level
   * up). The row is the trusted source for exactly that reason — a workspace
   * passed in would fail as a cross-tenant read rather than an empty one.
   *
   * Armed for the system flag by
   * `20260828120000_work_item_delivery_system_arm`, so a cross-tenant sweep under
   * `withSystemContext` is ADMITTED rather than silently empty.
   *
   * Distinct on the card: a card delivered by three pull requests is ONE
   * candidate, because the recompute folds its whole set in one pass. Ordered by
   * id so a paged sweep is deterministic.
   */
  async listDeliveredWorkItemRefs(
    tx: Prisma.TransactionClient,
    opts: { workspaceId?: string } = {},
  ): Promise<Array<{ workItemId: string; workspaceId: string }>> {
    const rows = await tx.workItemDelivery.findMany({
      where: opts.workspaceId ? { workspaceId: opts.workspaceId } : {},
      select: { workItemId: true, workspaceId: true },
      distinct: ['workItemId'],
      orderBy: { workItemId: 'asc' },
    });
    return rows;
  },

  /**
   * Every card a BATCH of pull requests delivers, in (pull request, link age)
   * order — {@link listByPullRequest} for a list, in one query (MOTIR-3756).
   *
   * The callers are the two readers that ask the question per CANDIDATE rather
   * than per card: the explicit-link picker annotates each of its ten candidates
   * with the cards it already delivers, and the subsumption index annotates every
   * pull request touching a batch's paths with the cards it was opened by. Both
   * hold a list of pull-request ids and would otherwise issue one read each.
   *
   * Returns the delivery ROWS rather than resolved work items: the two callers
   * want different things from them (identifiers to render, ids to compare), and
   * a link whose target the tenant context cannot see must not become a
   * fabricated item — the caller resolves what it needs and stays tolerant of a
   * short answer, exactly as `resolveDeliveredWorkItems` does.
   */
  async listByPullRequests(
    githubPullRequestIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<Pick<WorkItemDelivery, 'githubPullRequestId' | 'workItemId' | 'workspaceId'>[]> {
    if (githubPullRequestIds.length === 0) return [];
    return tx.workItemDelivery.findMany({
      where: { githubPullRequestId: { in: [...githubPullRequestIds] } },
      select: { githubPullRequestId: true, workItemId: true, workspaceId: true },
      orderBy: [{ githubPullRequestId: 'asc' }, { createdAt: 'asc' }],
    });
  },

  /**
   * Every card ONE pull request delivers — the direction the singular FK could not
   * express at all.
   *
   * This is what a merge asks: the delivery closes every card recorded against it,
   * not the one a link column happens to name. A `motir auto` pull request answers
   * with all N of its run's cards.
   */
  async listByPullRequest(
    githubPullRequestId: string,
    tx: Prisma.TransactionClient,
  ): Promise<WorkItemDelivery[]> {
    return tx.workItemDelivery.findMany({
      where: { githubPullRequestId },
      orderBy: { createdAt: 'asc' },
    });
  },

  /**
   * Record ONE delivery — idempotent by construction.
   *
   * A repeat for the same `(card, pull request)` is a no-op rather than an error or
   * a second row, which is what lets `link_pull_request` be called again on a
   * redelivery or an agent retry without the caller having to check first. The
   * unique index is the arbiter of a lost race; this `upsert` is the ordinary path
   * to the same answer in one round trip.
   *
   * `repoId` is stored rather than derived so the completion gate can compare each
   * member against its own repository's default branch without a join per member.
   */
  async add(
    data: {
      workspaceId: string;
      workItemId: string;
      githubPullRequestId: string;
      repoId: string;
    },
    tx: Prisma.TransactionClient,
  ): Promise<WorkItemDelivery> {
    return tx.workItemDelivery.upsert({
      where: {
        workItemId_githubPullRequestId: {
          workItemId: data.workItemId,
          githubPullRequestId: data.githubPullRequestId,
        },
      },
      create: data,
      update: {},
    });
  },

  /**
   * Remove ONE delivery — the door a mistaken link needs.
   *
   * With a singular FK a correction was expressible as a MOVE (link it elsewhere
   * and the old association vanished). With rows it is not, so removal has to be
   * its own operation. Returns the number of rows removed so a caller can tell a
   * real removal from a no-op without a second read.
   */
  async remove(
    workItemId: string,
    githubPullRequestId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.workItemDelivery.deleteMany({
      where: { workItemId, githubPullRequestId },
    });
    return result.count;
  },
};
