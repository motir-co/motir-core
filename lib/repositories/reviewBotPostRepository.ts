import { Prisma, type ReviewBotPost, type ReviewBotPostKind } from '@/generated/prisma/client';

// Single Prisma operations on `review_bot_post` (Story MOTIR-10327 · MOTIR-10335;
// `approval-gates.md` §12 rules 7 and 8) — what Motir's App bot posted for each agent
// verdict on each pull request. No business logic, no network: `reviewBotPostService`
// owns both, and calls GitHub OUTSIDE every transaction.
//
// ⚠️ EVERY CALL TAKES A REQUIRED `tx`: the table's own RLS policy gates every row on
// `app.workspace_id`, so an UNBOUND read matches nothing rather than failing — and an
// empty answer here reads exactly like "the bot never posted", which would post again.

/** One post to record, written AFTER the host answered. */
export interface ReviewBotPostCreateRow {
  workspaceId: string;
  projectId: string;
  workItemId: string;
  reviewVerdictRecordId: string;
  githubPullRequestId: string;
  kind: ReviewBotPostKind;
  githubReviewId: string;
  postedAt: Date;
}

/** A standing Request changes, with what the dismissal needs to address it on GitHub. */
export type LiveRequestChangesPost = Prisma.ReviewBotPostGetPayload<{
  include: {
    reviewVerdictRecord: { select: { id: true; subjectVersion: true; createdAt: true } };
    pullRequest: {
      select: {
        id: true;
        number: true;
        repo: {
          select: { owner: true; name: true; installation: { select: { installationId: true } } };
        };
      };
    };
  };
}>;

export const reviewBotPostRepository = {
  /**
   * Record one post. The unique (pull request, verdict record) pair is the idempotency
   * record; a second row for the same pair answers the row already there rather than
   * failing, so a retried job that raced its own first attempt still ends with one row.
   */
  async create(row: ReviewBotPostCreateRow, tx: Prisma.TransactionClient): Promise<ReviewBotPost> {
    const existing = await tx.reviewBotPost.findUnique({
      where: {
        githubPullRequestId_reviewVerdictRecordId: {
          githubPullRequestId: row.githubPullRequestId,
          reviewVerdictRecordId: row.reviewVerdictRecordId,
        },
      },
    });
    if (existing) return existing;
    return tx.reviewBotPost.create({ data: row });
  },

  /** The post for one (pull request, verdict record), or null when none was made. */
  async findByPullRequestAndRecord(
    githubPullRequestId: string,
    reviewVerdictRecordId: string,
    tx: Prisma.TransactionClient,
  ): Promise<ReviewBotPost | null> {
    return tx.reviewBotPost.findUnique({
      where: {
        githubPullRequestId_reviewVerdictRecordId: { githubPullRequestId, reviewVerdictRecordId },
      },
    });
  },

  /** Every Request changes the bot posted on a card that still stands, oldest first. */
  async listLiveRequestChangesByWorkItem(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<LiveRequestChangesPost[]> {
    return tx.reviewBotPost.findMany({
      where: { workItemId, kind: 'request_changes', state: 'posted' },
      include: {
        reviewVerdictRecord: { select: { id: true, subjectVersion: true, createdAt: true } },
        pullRequest: {
          select: {
            id: true,
            number: true,
            repo: {
              select: {
                owner: true,
                name: true,
                installation: { select: { installationId: true } },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
  },

  /** The cards of a project that carry a standing Request changes — the switch-off set. */
  async listWorkItemIdsWithLiveRequestChanges(
    projectId: string,
    tx: Prisma.TransactionClient,
  ): Promise<string[]> {
    const rows = await tx.reviewBotPost.findMany({
      where: { projectId, kind: 'request_changes', state: 'posted' },
      select: { workItemId: true },
      distinct: ['workItemId'],
    });
    return rows.map((r) => r.workItemId);
  },

  /** Whether a GitHub review id is one the bot posted — the sync filter's backstop. */
  async existsByGithubReviewId(
    githubReviewId: string,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const row = await tx.reviewBotPost.findFirst({
      where: { githubReviewId },
      select: { id: true },
    });
    return row !== null;
  },

  /** The post is no longer standing on GitHub. A row already dismissed is left as it is. */
  async markDismissed(id: string, at: Date, tx: Prisma.TransactionClient): Promise<void> {
    await tx.reviewBotPost.updateMany({
      where: { id, state: 'posted' },
      data: { state: 'dismissed', dismissedAt: at, lastError: null },
    });
  },

  /** A dismissal GitHub did not take: counted, and its reason kept for the next try. */
  async recordDismissFailure(
    id: string,
    error: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.reviewBotPost.update({
      where: { id },
      data: { attempts: { increment: 1 }, lastError: error.slice(0, 2000) },
    });
  },
};
