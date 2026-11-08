import type { ApprovalGate, Prisma } from '@/generated/prisma/client';
import { gateIdOfReviewRunKey, reviewRunKeyPrefix } from '@/lib/agentReview/reviewRunKey';
import type { WorkItemDeliveryWithChecks } from '@/lib/repositories/workItemDeliveryRepository';

// The BATCH READS of the review state read model (Story MOTIR-10327 · MOTIR-10340). Each is
// ONE query over a whole set of cards, so a board page or a To approve page costs a fixed
// number of queries however many cards it shows. No business logic: `reviewStateService`
// derives the answers.
//
// ⚠️ EVERY CALL TAKES A REQUIRED `tx`, bound to the reader's workspace: every table here is
// RLS-gated on it, so a card of another workspace is never read — and an UNBOUND read would
// answer "no review", which reads exactly like a card nobody reviewed.

/** One card of a subtree walk, rooted at one of the asked cards. */
export interface ReviewStateTreeRow {
  rootId: string;
  id: string;
  parentId: string | null;
  depth: number;
}

/** A card, with what the review state reads of it. */
export interface ReviewStateCardRow {
  id: string;
  identifier: string;
  projectId: string;
  status: string;
  archivedAt: Date | null;
  assigneeId: string | null;
  reporterId: string;
}

/** A person, with the GitHub identity the author fact compares against. */
export interface ReviewStatePersonRow {
  id: string;
  name: string;
  email: string;
  githubUserId: string | null;
}

export type ReviewStateRecordRow = Prisma.ReviewVerdictRecordGetPayload<{
  include: { submittedBy: { select: { id: true; name: true } } };
}>;

export type ReviewStateDismissalRow = Prisma.ReviewDismissalGetPayload<{
  include: { dismissedBy: { select: { id: true; name: true } } };
}>;

export const reviewStateRepository = {
  /**
   * Every card under each root, the root included, in ONE recursive query. A card whose
   * project is not `projectId` is not walked into.
   */
  async listSubtrees(
    rootIds: readonly string[],
    projectId: string,
    tx: Prisma.TransactionClient,
  ): Promise<ReviewStateTreeRow[]> {
    if (rootIds.length === 0) return [];
    return tx.$queryRaw<ReviewStateTreeRow[]>`
      WITH RECURSIVE subtree AS (
        SELECT w."id" AS "rootId", w."id", w."parentId", 0 AS depth
          FROM "work_item" w
          WHERE w."id" = ANY(${[...rootIds]}::text[]) AND w."projectId" = ${projectId}
        UNION ALL
        SELECT s."rootId", w."id", w."parentId", s.depth + 1
          FROM "work_item" w
          JOIN subtree s ON w."parentId" = s."id"
          WHERE w."projectId" = ${projectId}
      )
      SELECT "rootId", "id", "parentId", depth::int AS "depth" FROM subtree
      ORDER BY "rootId", depth`;
  },

  /** The cards themselves, in ONE query. */
  async listCards(
    ids: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<ReviewStateCardRow[]> {
    if (ids.length === 0) return [];
    return tx.workItem.findMany({
      where: { id: { in: [...ids] } },
      select: {
        id: true,
        identifier: true,
        projectId: true,
        status: true,
        archivedAt: true,
        assigneeId: true,
        reporterId: true,
      },
    });
  },

  /** Every delivery of the cards, with its pull request, check rows and repository. */
  async listDeliveries(
    workItemIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<WorkItemDeliveryWithChecks[]> {
    if (workItemIds.length === 0) return [];
    return tx.workItemDelivery.findMany({
      where: { workItemId: { in: [...workItemIds] } },
      include: { pullRequest: { include: { checkRuns: true } }, repo: true },
      orderBy: [{ workItemId: 'asc' }, { createdAt: 'asc' }],
    });
  },

  /** Every `agent_review` gate of the cards, any state, newest first. */
  async listAgentReviewGates(
    workItemIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<ApprovalGate[]> {
    if (workItemIds.length === 0) return [];
    return tx.approvalGate.findMany({
      where: { workItemId: { in: [...workItemIds] }, kind: 'agent_review' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  },

  /**
   * Each card's latest DECIDED gate of any kind — `findLatestDecidedByWorkItem`'s question
   * (its `where` and its order), for a set of cards in one query.
   */
  async listLatestDecidedGates(
    workItemIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<ApprovalGate[]> {
    if (workItemIds.length === 0) return [];
    return tx.approvalGate.findMany({
      where: {
        workItemId: { in: [...workItemIds] },
        decidedAt: { not: null },
        state: { notIn: ['awaiting', 'superseded'] },
      },
      orderBy: [{ decidedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      distinct: ['workItemId'],
    });
  },

  /** Every review verdict record of the cards, newest first, with its submitter's name. */
  async listRecords(
    workItemIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<ReviewStateRecordRow[]> {
    if (workItemIds.length === 0) return [];
    return tx.reviewVerdictRecord.findMany({
      where: { workItemId: { in: [...workItemIds] } },
      include: { submittedBy: { select: { id: true, name: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  },

  /** Every dismissal on the cards, with who made it. */
  async listDismissals(
    workItemIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<ReviewStateDismissalRow[]> {
    if (workItemIds.length === 0) return [];
    return tx.reviewDismissal.findMany({
      where: { workItemId: { in: [...workItemIds] } },
      include: { dismissedBy: { select: { id: true, name: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  },

  /**
   * Which of these `agent_review` gates have a hosted review run IN FLIGHT — every review
   * run of a gate is opened under `agent-review:<gateId>:…` (`reviewRunKey.ts`).
   */
  async listGateIdsWithRunningReview(
    workspaceId: string,
    gateIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<Set<string>> {
    if (gateIds.length === 0) return new Set();
    const runs = await tx.dispatchRun.findMany({
      where: {
        workspaceId,
        status: 'running',
        OR: gateIds.map((id) => ({ idempotencyKey: { startsWith: reviewRunKeyPrefix(id) } })),
      },
      select: { idempotencyKey: true },
    });
    return new Set(
      runs.map((run) => gateIdOfReviewRunKey(run.idempotencyKey)).filter((id) => id !== null),
    );
  },

  /**
   * THE REVIEW READING OF A SET OF CARDS (Bug MOTIR-10504) — how many review rows the
   * cards' review state is derived from, and the most recent moment one was written, in
   * ONE query. The Workbench folds it into the To approve tab's watermark, so a review
   * that writes no `approval_gate` row — a gate-off pass, a GitHub approval at the head —
   * still moves the tab and the open row re-reads its review line and badge.
   *
   * ⚠️ THE SAME ROWS THE READ MODEL DERIVES FROM, over the same subtree. `readReviewStates`
   * answers a card from its whole subtree in its own project (`listSubtrees`: a container's
   * badge counts its children's reviews), from these tables: the verdict records, the
   * dismissals, the deliveries, the `agent_review` gates and the GitHub reviews of the
   * delivered pull requests. A
   * reading over fewer tables, or over the root alone, is a row that goes stale on exactly
   * the write it left out — with nothing red, because a reload still draws it right.
   *
   * ⚠️ AND IT IS A SIGNAL, NEVER CONTENT: a count and an instant, no ids. The count is what
   * catches an insert whatever two clocks stamped it (a verdict's `created_at` is the
   * database's, a gate's `updated_at` the app's); the instant catches a GitHub review
   * edited in place. Every table here carries a `trg_live_signal_*` trigger
   * (`lib/live/liveSignalTables.ts`), which is what wakes the stream to take this reading.
   *
   * ⚠️ THE `agent_review` GATES ARE READ HERE, NOT ON THE APPROVALS READING (Bug
   * MOTIR-10734). That reading excludes the kind — it asks the agent, not a person — so a
   * person skipping the review moved nothing there. On an approve-and-merge row the merge
   * gate the skip raises moves the count anyway; on a story run's acceptance row it is
   * carried behind the acceptance primary and excluded too, and the decided review gate is
   * the only write left to see.
   *
   * Required `tx`, bound to the reader's workspace: every table is RLS-gated, and an
   * unbound read answers zero rows — which reads as *nothing reviewed*.
   */
  async watermarkReviewsOfSubtrees(
    rootIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<{ count: number; latest: Date | null }> {
    if (rootIds.length === 0) return { count: 0, latest: null };
    const [row] = await tx.$queryRaw<{ count: number; latest: Date | null }[]>`
      WITH RECURSIVE subtree AS (
        SELECT w."id", w."projectId"
          FROM "work_item" w
          WHERE w."id" = ANY(${[...rootIds]}::text[])
        UNION
        SELECT c."id", c."projectId"
          FROM "work_item" c
          JOIN subtree s ON c."parentId" = s."id" AND c."projectId" = s."projectId"
      ),
      reviewed AS (
        SELECT r."created_at" AS "at"
          FROM "review_verdict_record" r
          WHERE r."work_item_id" IN (SELECT "id" FROM subtree)
        UNION ALL
        SELECT d."created_at"
          FROM "review_dismissal" d
          WHERE d."work_item_id" IN (SELECT "id" FROM subtree)
        UNION ALL
        SELECT del."created_at"
          FROM "work_item_delivery" del
          WHERE del."work_item_id" IN (SELECT "id" FROM subtree)
        UNION ALL
        SELECT a."updated_at"
          FROM "approval_gate" a
          WHERE a."work_item_id" IN (SELECT "id" FROM subtree)
            AND a."kind" = 'agent_review'
        UNION ALL
        SELECT g."updated_at"
          FROM "github_pull_request_review" g
          JOIN "work_item_delivery" gd ON gd."github_pull_request_id" = g."github_pull_request_id"
          WHERE gd."work_item_id" IN (SELECT "id" FROM subtree)
      )
      SELECT count(*)::int AS "count", max("at") AS "latest" FROM reviewed`;
    /* v8 ignore next -- an aggregate with no GROUP BY always answers exactly one row. */
    return { count: row?.count ?? 0, latest: row?.latest ?? null };
  },

  /** The people, with their linked GitHub user id (never their token). */
  async listPeople(
    userIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<ReviewStatePersonRow[]> {
    if (userIds.length === 0) return [];
    const rows = await tx.user.findMany({
      where: { id: { in: [...userIds] } },
      select: {
        id: true,
        name: true,
        email: true,
        githubIdentity: { select: { githubUserId: true } },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      githubUserId: row.githubIdentity?.githubUserId ?? null,
    }));
  },
};
