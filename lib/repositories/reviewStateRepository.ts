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
