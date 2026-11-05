import { getJob } from '@/lib/ai/motirAiClient';
import { MotirAiError } from '@/lib/ai/errors';
import type { ProjectContext } from '@/lib/projects';
import {
  PlanNotEditableError,
  PlanNotFoundError,
  PlanRevisionInFlightError,
} from '@/lib/plans/errors';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { aiPlanEditsService } from '@/lib/services/aiPlanEditsService';
import { plansService } from '@/lib/services/plansService';
import { planChangeMailboxService } from '@/lib/services/planChangeMailboxService';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { planChangeMailboxRepository } from '@/lib/repositories/planChangeMailboxRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { PlanChangeSessionNotFoundError } from '@/lib/planChange/errors';

// A CHANGE FORWARDED AFTER THE WALK FINISHED (Story MOTIR-7990 · MOTIR-7997; the
// decision `conversation-turn-intent.md` AMENDMENT 4).
//
// A change the answering session read as a CHANGE is forwarded into the running
// planning job's mailbox. When the walk is already over the forward has nowhere to
// land, and there are TWO ways it used to be lost:
//
//  1. REFUSED — the job reached a terminal status, so `attachTurn` throws
//     `PlanChangeJobNotRunningError`.
//  2. STRANDED — the job is still `running` (validating and closing the plan), so
//     `attachTurn` ACCEPTED the turn, but no walk session is left to read it at a
//     tool-call gap and no phase boundary is left to consume it. It would sit
//     unread, and the thread would show it as queued, for ever.
//
// Both end here: the change becomes ONE `REVISE_PLAN` revision of the run's OWN
// plan through the shipped revise door ({@link aiPlanEditsService.submitRevise}),
// which owns the permission, the no-existence-leak resolution, the decided-plan
// refusal, the lease and the timeline rows — so the revision shows on the plan's
// timeline with no new surface. A change that cannot become a revision is REFUSED
// WITH A REASON AND ITS TEXT: nothing is dropped silently.
//
// SIDE EFFECTS OUTSIDE ANY TRANSACTION: both entry points call motir-ai; the only
// transaction in this file is the short claim in {@link claimStranded}.

/** Why a late change was not revised in. Stable wire codes the rail words. */
export const LATE_CHANGE_CODES = {
  /** The run produced no plan this conversation can see. */
  noPlan: 'PLAN_CHANGE_NO_PLAN',
  /** The run FAILED: its plan is resumed through its own path, not revised under it. */
  runFailed: 'PLAN_CHANGE_RUN_FAILED',
  /** The person STOPPED the run: a revision would restart the planning they stopped. */
  runStopped: 'PLAN_CHANGE_RUN_STOPPED',
  /** The run is still going — a gap read or a phase boundary will still carry it. */
  runStillRunning: 'PLAN_CHANGE_RUN_STILL_RUNNING',
  /** The plan was approved or declined: nothing left to revise. */
  planDecided: 'PLAN_CHANGE_PLAN_DECIDED',
  /** Another revision holds the plan (`PlanRevisionInFlightError`'s own code). */
  revisionInFlight: 'PLAN_REVISION_IN_FLIGHT',
} as const;

export type LateChangeOutcome =
  | { outcome: 'revised'; planId: string; revisionJobId: string; texts: string[] }
  | {
      outcome: 'refused';
      /** A {@link LATE_CHANGE_CODES} value, or a motir-ai error's own code. */
      code: string;
      /** Every forwarded text, verbatim and in order — handed back to the person. */
      texts: string[];
      /** The plan's status, on a `PLAN_CHANGE_PLAN_DECIDED` refusal. */
      planStatus?: string;
    };

const RUNNING_JOB_STATUSES: ReadonlySet<string> = new Set(['queued', 'running']);

/** The fixed header naming the texts as late changes; everything after it is the
 *  person's words, verbatim, one paragraph per text, in the order forwarded. */
const LATE_CHANGE_HEADER =
  'The person forwarded these changes after the planning walk finished. Revise this plan to apply them:';

function revisionPrompt(texts: readonly string[]): string {
  return [LATE_CHANGE_HEADER, ...texts].join('\n\n');
}

function refuse(
  code: string,
  texts: string[],
  extra: { planStatus?: string } = {},
): LateChangeOutcome {
  return { outcome: 'refused', code, texts, ...extra };
}

export const planChangeLateChangeService = {
  /**
   * THE SINGLE DECISION: turn these forwarded texts into ONE revision of the run's
   * plan, or refuse them with a reason. Returns the outcome; it throws only for
   * what is not a late-change outcome (permission, an unknown session).
   *
   * `sessionId` / `runJobId` are checked against each other first (the mailbox's
   * own no-existence-leak mismatch error), so a job that is not the addressed
   * session's run is refused before anything is read or submitted.
   */
  async reviseLate(
    input: { sessionId: string; runJobId: string; texts: readonly string[] },
    ctx: ProjectContext,
  ): Promise<LateChangeOutcome> {
    const texts = [...input.texts];
    await projectAccessService.assertPermission(
      ctx.projectId,
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      'ai:plan',
    );
    // Throws the mailbox's mismatch / not-found errors for a run that is not this
    // session's; `stopped` is whether the person ended it.
    const mailbox = await planChangeMailboxService.peekForJob(input.runJobId, ctx, input.sessionId);

    // The run's plan: by `sourceJobId`, else the conversation's latest plan. A
    // revision re-points `sourceJobId` at its own job; when it RE-OPENED the plan it
    // took the session too (MOTIR-10455) and the peek above already refused the
    // finished run, so the fallback is how a revision of a plan still `generating`
    // (which leaves the session on the run) reaches `PLAN_REVISION_IN_FLIGHT`.
    const planId =
      (await plansService.findPlanIdForJob(input.runJobId, ctx)) ??
      (await plansService.findLatestPlanIdForSession(ctx.projectId, input.sessionId, ctx));
    if (!planId) return refuse(LATE_CHANGE_CODES.noPlan, texts);

    try {
      const job = await getJob(input.runJobId, ctx.projectId);
      if (job.status === 'failed') return refuse(LATE_CHANGE_CODES.runFailed, texts);
      // `canceled` without a stop entry is a run ended some other way (the
      // abandoned-plan sweep, a Stop pressed elsewhere): the same fact.
      if (mailbox.stopped || job.status === 'canceled') {
        return refuse(LATE_CHANGE_CODES.runStopped, texts);
      }
      if (RUNNING_JOB_STATUSES.has(job.status)) {
        return refuse(LATE_CHANGE_CODES.runStillRunning, texts);
      }

      const submitted = await aiPlanEditsService.submitRevise(planId, revisionPrompt(texts), ctx);
      return {
        outcome: 'revised',
        planId: submitted.planId,
        revisionJobId: submitted.jobId,
        texts,
      };
    } catch (err) {
      if (err instanceof PlanNotEditableError) {
        return refuse(LATE_CHANGE_CODES.planDecided, texts, { planStatus: err.status });
      }
      if (err instanceof PlanRevisionInFlightError) {
        return refuse(LATE_CHANGE_CODES.revisionInFlight, texts);
      }
      if (err instanceof PlanNotFoundError) return refuse(LATE_CHANGE_CODES.noPlan, texts);
      // Out of credits, motir-ai unreachable or unconfigured: refused with that
      // error's own code, the text kept.
      if (err instanceof MotirAiError) return refuse(err.code, texts);
      throw err;
    }
  },

  /**
   * CLAIM THE STRANDED TURNS of a run: every pending `fold` turn nobody consumed,
   * stamped `consumed_at` and returned in `seq` order.
   *
   * Under the SESSION row lock — the one lock the mailbox and the transcript share
   * — and in the same transaction as the stamp (the `readForBoundary` pattern), so
   * a turn claimed here can never also be read by a walk, and two callers racing
   * claim each turn exactly once (the loser lists nothing). A `restart` turn is not
   * a change to revise in (START OVER owns it) and a stop is not a turn: neither is
   * touched.
   */
  async claimStranded(runJobId: string, sessionId: string, ctx: ProjectContext): Promise<string[]> {
    await projectAccessService.assertPermission(
      ctx.projectId,
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      'ai:plan',
    );
    // The run must be this session's (404, no existence leak) BEFORE any claim.
    await planChangeMailboxService.peekForJob(runJobId, ctx, sessionId);

    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: ctx.projectId },
      async (tx) => {
        const locked = await planChangeSessionRepository.lockById(sessionId, tx);
        if (!locked) throw new PlanChangeSessionNotFoundError(ctx.projectId);
        const pending = await planChangeMailboxRepository.listPending(
          sessionId,
          runJobId,
          ctx.workspaceId,
          tx,
        );
        const claimable = pending.filter(
          (e) => e.kind === 'turn' && (e.disposition ?? 'fold') === 'fold',
        );
        await planChangeMailboxRepository.markConsumed(
          claimable.map((e) => e.id),
          ctx.workspaceId,
          new Date(),
          tx,
        );
        return claimable.map((e) => e.body ?? '').filter((b) => b.length > 0);
      },
    );
  },
};
