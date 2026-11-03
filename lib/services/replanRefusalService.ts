import type { JobRequestAuth } from '@/lib/ai/jobAuth';
import { motirSystemContext } from '@/lib/ai/serviceAuth';
import { NoPlanForJobError } from '@/lib/plans/errors';
import { commentRepository } from '@/lib/repositories/commentRepository';
import { planItemRepository } from '@/lib/repositories/planItemRepository';
import { planRepository } from '@/lib/repositories/planRepository';
import { sharpenSessionRepository } from '@/lib/repositories/sharpenSessionRepository';
import { commentsService } from '@/lib/services/commentsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { CommentNotFoundError } from '@/lib/comments/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
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
// ⚠️ THE COMMENT IS MOTIR'S, written by the system account, never by the job token's
// user: the words are the planner's, and the person who dispatched the run is the one
// who must be notified, which an actor never is. The work item is resolved inside the
// TOKEN's project, so a foreign key is not found rather than refused.
//
// A RETRY IS SAFE: a comment an earlier attempt landed is found and not written again,
// even once the plan has closed, and the result says the plan needs no second close.

/** The verdict the door takes. `bodyMd` is composed by motir-ai. */
export interface ReplanRefusalInput {
  jobId: string;
  /** The run's target; null when it anchored on no card, and its comment says where. */
  workItemKey: string | null;
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
  /** An earlier attempt already closed the plan, so motir-ai does not close it again. */
  planAlreadyClosed: boolean;
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

/** No card named, and the run's comment no longer resolves: nowhere to answer. → 404 */
export class ReplanRefusalNoAnchorError extends Error {
  readonly code = 'REPLAN_REFUSAL_NO_ANCHOR' as const;
  constructor(jobId: string) {
    super(`Job ${jobId} named no card, and its run's comment is gone: nowhere to say why.`);
    this.name = 'ReplanRefusalNoAnchorError';
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

/** A verdict comes before any proposal, and only while the plan is being written. */
async function assertRefusable(
  plan: { id: string; status: string },
  workspaceId: string,
): Promise<void> {
  if (plan.status !== 'generating') {
    throw new ReplanRefusalTooLateError(plan.id, `it is ${plan.status}`);
  }
  const proposals = await withWorkspaceServiceContext(workspaceId, (tx) =>
    planItemRepository.countByPlan(plan.id, tx),
  );
  if (proposals > 0) {
    throw new ReplanRefusalTooLateError(plan.id, `it already holds ${proposals} proposal(s)`);
  }
}

/**
 * Where the verdict goes. The run's own comment comes first: the reply goes under it, on
 * whichever card of this project it sits, because a run may anchor its re-plan on the
 * container, or on nothing, while its comment stays on the card it stopped on. A comment
 * gone since the submit is no reason to drop the answer: it lands on the named card
 * instead, and with no card either there is nowhere to put it.
 */
async function resolveAnchor(
  input: ReplanRefusalInput,
  projectId: string,
  motir: ServiceContext,
): Promise<{ workItemId: string; parentCommentId: string | null }> {
  if (input.replyToCommentId) {
    try {
      const root = await commentsService.resolveReplyRootInProject(
        input.replyToCommentId,
        projectId,
        motir,
      );
      return { workItemId: root.workItemId, parentCommentId: root.commentId };
    } catch (err) {
      if (!(err instanceof CommentNotFoundError)) throw err;
    }
  }
  const key = input.workItemKey?.trim();
  if (!key) throw new ReplanRefusalNoAnchorError(input.jobId);
  const item = await workItemsService.getWorkItemByIdentifier(projectId, key.toUpperCase(), motir);
  return { workItemId: item.id, parentCommentId: null };
}

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

    const motir = await motirSystemContext(ctx.workspaceId);
    const anchor = await resolveAnchor(input, projectId, motir);

    // ⚠️ THE COMMENT IS WRITTEN ONCE (the retry). It commits on its own, before the
    // grilling ends and before motir-ai closes the plan, so a failure after it brings
    // the job back here. motir-ai persists its verdict, so the retry's body is identical.
    const landed = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      commentRepository.findIdenticalSince(
        {
          workItemId: anchor.workItemId,
          authorId: motir.userId,
          bodyMd: input.bodyMd,
          since: plan.createdAt,
        },
        tx,
      ),
    );
    if (!landed) await assertRefusable(plan, ctx.workspaceId);
    const commentId =
      landed?.id ??
      (
        await commentsService.addComment(
          anchor.workItemId,
          {
            bodyMd: input.bodyMd,
            ...(anchor.parentCommentId ? { parentCommentId: anchor.parentCommentId } : {}),
          },
          motir,
        )
      ).id;
    const replied = landed ? landed.parentCommentId !== null : anchor.parentCommentId !== null;

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

    return {
      commentId,
      replied,
      endedSharpenSessions,
      planAlreadyClosed: plan.status !== 'generating',
    };
  },
};
