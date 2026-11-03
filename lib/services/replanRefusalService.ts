import type { JobRequestAuth } from '@/lib/ai/jobAuth';
import { NoPlanForJobError } from '@/lib/plans/errors';
import { planItemRepository } from '@/lib/repositories/planItemRepository';
import { planRepository } from '@/lib/repositories/planRepository';
import { sharpenSessionRepository } from '@/lib/repositories/sharpenSessionRepository';
import { commentsService } from '@/lib/services/commentsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { CommentNotFoundError } from '@/lib/comments/errors';
import { withWorkspaceContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';

// THE CAN'T-PLAN VERDICT'S DOOR (MOTIR-10233) — what motir-ai calls when the
// question-free first session of a RUN's re-plan finds the run's report cannot be
// planned: it makes no sense, or it contradicts itself.
//
// A run has exited by the time the planner reads its report, so the planner cannot
// ask it anything; the one place its answer can reach a person is the card. This
// door writes that answer — a comment, as a REPLY under the run's own comment when
// the run named one — and ends any grilling still open on the plan, so the person is
// not left answering questions about a plan that will never be written. It does NOT
// close the plan: motir-ai closes it through the ordinary final append right after,
// and a plan that holds nothing is DISCARDED there (`plansService.markPlanned`), so
// no plan is left open for review. It moves NO status: the card stays at Planning,
// where the run parked it.
//
// ⚠️ ONLY BEFORE PLANNING. The verdict is the first session's, and it comes before
// any proposal exists, so a plan that is no longer `generating`, or already holds a
// proposal, is refused (`ReplanRefusalTooLateError`) — a refusal must never be able
// to take a half-written plan away from a reviewer.
//
// The comment is written AS THE JOB TOKEN'S USER, like every other write the planner
// makes into a tenant (`log-bug`). The work item is resolved inside the TOKEN's
// project, so a foreign key is not found rather than refused.

/** The verdict the door takes. `bodyMd` is composed by motir-ai. */
export interface ReplanRefusalInput {
  jobId: string;
  /** The card the comment goes on — the run's target. */
  workItemKey: string;
  bodyMd: string;
  /** The run's comment, from `context.runReplan.commentId`; null when it named none. */
  replyToCommentId: string | null;
}

export interface ReplanRefusalResult {
  commentId: string;
  /** Whether it landed as a reply under the run's comment. */
  replied: boolean;
  /** The grilling sessions on the plan this ended. */
  endedSharpenSessions: number;
}

/** The plan already left `generating`, or already holds a proposal. → 409 */
export class ReplanRefusalTooLateError extends Error {
  readonly code = 'REPLAN_REFUSAL_TOO_LATE' as const;
  constructor(planId: string, reason: string) {
    super(
      `Plan ${planId} can no longer be refused: ${reason}. A can't-plan verdict comes before any proposal.`,
    );
    this.name = 'ReplanRefusalTooLateError';
  }
}

/**
 * What a grilling ended by this door records as its write-back: nothing was written,
 * because the plan was closed before it was planned. `planClosed` is what the summary
 * reads to say so instead of showing a failure (`SharpenSummary`).
 */
export const PLAN_CLOSED_WRITE_BACK = {
  ok: false,
  planClosed: true,
  error: 'The plan was closed before it was written, so there was nothing to write the answers to.',
} as const;

export const replanRefusalService = {
  async recordRefusal(
    input: ReplanRefusalInput,
    auth: JobRequestAuth,
  ): Promise<ReplanRefusalResult> {
    const { ctx, projectId } = auth;
    const plan = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planRepository.findBySourceJobId(input.jobId, ctx.workspaceId, tx),
    );
    if (!plan || plan.projectId !== projectId) throw new NoPlanForJobError(input.jobId);
    if (plan.status !== 'generating') {
      throw new ReplanRefusalTooLateError(plan.id, `it is ${plan.status}`);
    }
    const proposals = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planItemRepository.countByPlan(plan.id, tx),
    );
    if (proposals > 0) {
      throw new ReplanRefusalTooLateError(plan.id, `it already holds ${proposals} proposal(s)`);
    }

    const item = await workItemsService.getWorkItemByIdentifier(
      projectId,
      input.workItemKey.trim().toUpperCase(),
      ctx,
    );

    // THE REPLY, WHEN THE RUN'S COMMENT STILL STANDS. A comment deleted since the
    // submit is no reason to drop the answer: it lands on the card instead.
    let parentCommentId: string | null = null;
    if (input.replyToCommentId) {
      try {
        parentCommentId = (
          await commentsService.resolveReplyRootOn(input.replyToCommentId, [item.id], ctx)
        ).commentId;
      } catch (err) {
        if (!(err instanceof CommentNotFoundError)) throw err;
      }
    }
    const comment = await commentsService.addComment(
      item.id,
      { bodyMd: input.bodyMd, ...(parentCommentId ? { parentCommentId } : {}) },
      ctx,
    );

    // END THE GRILLING (the verdict's last obligation): every open session on this
    // plan, whoever opened it, ended as finished and saying the plan was closed — not
    // as a failure, because nothing failed: there is simply no plan to write to.
    const endedSharpenSessions = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId },
      async (tx) => {
        const open = await sharpenSessionRepository.listOpenByPlan(plan.id, ctx.workspaceId, tx);
        for (const session of open) {
          await sharpenSessionRepository.lockById(session.id, tx);
          await sharpenSessionRepository.updateState(
            session.id,
            {
              status: 'ended',
              endReason: 'finished',
              pendingQuestion: null,
              writeBack: PLAN_CLOSED_WRITE_BACK,
              lastActivityAt: new Date(),
            },
            tx,
          );
        }
        return open.length;
      },
    );

    return { commentId: comment.id, replied: parentCommentId !== null, endedSharpenSessions };
  },
};
