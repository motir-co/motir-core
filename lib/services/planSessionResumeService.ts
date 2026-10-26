import type { Prisma } from '@/generated/prisma/client';
import type { ProjectContext } from '@/lib/projects';
import { toProjectDTO } from '@/lib/mappers/projectMappers';
import type { PlanChangeSubmitResultDto } from '@/lib/dto/planChange';
import {
  NotSessionOwnerError,
  PlanNotResumableError,
  PlanSessionEndedError,
  PlanSessionNotFoundError,
  ResumeAlreadyStartedError,
  SessionNotFailedError,
  GuideSessionNotPlannableError,
} from '@/lib/planChange/errors';
import {
  AUTO_RESUMES_PER_SESSION,
  sessionWaitingState,
} from '@/lib/planChange/sessionWaitingState';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { planItemRepository } from '@/lib/repositories/planItemRepository';
import { planRepository } from '@/lib/repositories/planRepository';
import { planStepRepository } from '@/lib/repositories/planStepRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { aiPlanEditsService } from '@/lib/services/aiPlanEditsService';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';
import { planTargetLockService } from '@/lib/services/planTargetLockService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { withWorkspaceContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { MotirAiBadRequestError } from '@/lib/ai/errors';
import { releaseUnresumableAttempt } from '@/lib/services/planSessionEndService';

// RESUMING A FAILED PLANNING SESSION (Story MOTIR-7905 · MOTIR-7916; `agent-authored-plans.md`
// AMENDMENT 23's 2026-10-09 sub-amendment).
//
// A failed hosted attempt keeps its session, its `generating` plan and its held cards
// (`settleFailedJob`, MOTIR-7912). Resume starts a NEW motir-ai attempt on the SAME plan in the
// SAME session — it does not open a plan — and from the moment it binds the session is no
// longer failed: it is running again, so it leaves To resume and its cards stay held.
//
// ORDER IS `submitRevise`'s, AND FOR ITS REASON. The job id does not exist until motir-ai
// answers, so the SUBMIT comes first (outside any transaction — a metered side effect) and the
// BIND second. A bind that loses a race leaves an orphan job that resolves no plan by
// `sourceJobId` and fails its first callback writing nothing: one wasted call on a genuine
// simultaneous double-click, and the cheaper end of the trade — the alternative holds a bind
// over a job that may never exist.
//
// THE BIND is one transaction under the existing lock order (PLAN, then SESSION) and every
// write in it is conditional, so the events that can reach the session at once — a person's
// end, `settleFailedJob` for the OLD job, and a second Resume — each find a state they were
// written for. No turn is appended: a resume adds no words, and the planner's own turn for the
// resumed job is recorded by the ordinary planner-turn door keyed on its job id.

/** What the cheap pre-check proved, handed to the submit and re-proved under the locks. */
interface ResumeTarget {
  sessionId: string;
  planId: string;
  failedJobId: string;
  /** The plan's starter (MOTIR-8741) — whose language the resumed walk speaks. */
  starterUserId: string | null;
}

/**
 * Pre-check, in a read transaction under the caller's workspace context: refuse before a job
 * is spent. The bind re-checks everything under the locks; this exists so the refusals a
 * person actually hits cost nothing.
 */
async function precheck(pctx: ProjectContext, sessionId: string): Promise<ResumeTarget> {
  // WHO MAY RESUME (design change requested on MOTIR-7907): the session's starter, or a member
  // who holds `ai:configure` — a project manager (`ai:decide_plan` is held by every member, so
  // it would let everyone in). Read BEFORE the transaction: `getPermissions` opens its own
  // context, and a second pooled connection taken while one is held is the deadlock shape
  // `workItemsService` warns about.
  const held = await projectAccessService.getPermissions(pctx.projectId, {
    userId: pctx.userId,
    workspaceId: pctx.workspaceId,
  });
  const mayResumeAny = held.has('ai:configure');
  return withWorkspaceServiceContext(pctx.workspaceId, async (tx) => {
    const session = await planChangeSessionRepository.findByIdInProject(
      sessionId,
      pctx.projectId,
      pctx.workspaceId,
      tx,
    );
    if (!session) throw new PlanSessionNotFoundError(sessionId);
    if (session.origin === 'guide') throw new GuideSessionNotPlannableError(session.id);
    if (session.endedAt) throw new PlanSessionEndedError(session.id);
    if (session.createdById !== pctx.userId && !mayResumeAny) {
      throw new NotSessionOwnerError(session.id);
    }
    const state = sessionWaitingState(session);
    if (state === 'open' && session.lastJobId) {
      // Not failed, and an attempt is RUNNING: the session's plan is `generating` and written by
      // the session's last job. That is what a concurrent Resume's bind leaves when it commits
      // before this read is reached at all (MOTIR-8297) — the MOTIR-8261 re-read below covers
      // only a bind landing between this read and the plan read. Nothing on the row tells a
      // Resume's attempt from any other, and nothing needs to: either way there is a job to
      // attach to rather than a session to resume, so refuse the way the bind does and name it.
      const running = await planRepository.findLatestForResume(session.id, tx);
      if (running?.status === 'generating' && running.sourceJobId === session.lastJobId) {
        throw new ResumeAlreadyStartedError(session.id, session.lastJobId);
      }
    }
    if (state !== 'failed' || !session.failedJobId) {
      throw new SessionNotFailedError(session.id);
    }
    // motir-ai said this attempt has nothing to continue from (MOTIR-9121): its targets were
    // released when the failure was recorded, and the next turn plans again.
    if (session.failureResumable === false) throw new PlanNotResumableError(session.id);
    const plan = await planRepository.findLatestForResume(session.id, tx);
    if (!plan || plan.status !== 'generating' || plan.sourceJobId !== session.failedJobId) {
      // Neither read takes a lock and the isolation is read committed, so a concurrent
      // Resume's bind can commit BETWEEN the two: the session above was read still failed,
      // and the plan is already re-pointed at the winner's job (MOTIR-8261). Re-read the
      // session, which now sees that commit, and refuse the way the bind does for the same
      // race — ended, or already resumed naming the winning job — rather than as a plan that
      // cannot be resumed.
      const fresh = await planChangeSessionRepository.findByIdInProject(
        session.id,
        pctx.projectId,
        pctx.workspaceId,
        tx,
      );
      if (fresh?.endedAt) throw new PlanSessionEndedError(fresh.id);
      if (fresh && sessionWaitingState(fresh) !== 'failed') {
        throw new ResumeAlreadyStartedError(fresh.id, fresh.lastJobId);
      }
      throw new PlanNotResumableError(session.id);
    }
    return {
      sessionId: session.id,
      planId: plan.id,
      failedJobId: session.failedJobId,
      starterUserId: plan.createdById,
    };
  });
}

/**
 * BIND the new job: re-point the plan, record the attempt on the session, clear the failure,
 * clear the dead job's provider-retry waits and heartbeat the targets — inside the caller's
 * transaction, plan lock then session lock. Shared by the manual Resume and the automatic one
 * (MOTIR-8307), so the two binds cannot drift.
 *
 * The waits are cleared here because a job that died mid-wait never sent the reporter's clear,
 * and its `plan_step` row would otherwise draw the retrying banner beside the new job's progress
 * for up to `retryAt` + `PLAN_PROVIDER_WAIT_GRACE_MS` (MOTIR-9642). The new job cannot
 * have reported a wait of its own yet: until this bind re-points `sourceJobId`, its reports
 * resolve no plan.
 */
async function bindWithin(
  tx: Prisma.TransactionClient,
  target: ResumeTarget,
  jobId: string,
  now: Date,
  workspaceId: string,
): Promise<void> {
  if (!(await planRepository.lockById(target.planId, tx))) {
    throw new PlanNotResumableError(target.sessionId);
  }
  if (!(await planChangeSessionRepository.lockById(target.sessionId, tx))) {
    throw new PlanSessionNotFoundError(target.sessionId);
  }
  const fresh = await planChangeSessionRepository.findById(target.sessionId, workspaceId, tx);
  if (!fresh) throw new PlanSessionNotFoundError(target.sessionId);
  if (fresh.endedAt) throw new PlanSessionEndedError(fresh.id);
  if (sessionWaitingState(fresh) !== 'failed') {
    // The failure is already cleared: a concurrent Resume won. Name ITS job.
    throw new ResumeAlreadyStartedError(fresh.id, fresh.lastJobId);
  }
  if (fresh.failedJobId !== target.failedJobId) throw new PlanNotResumableError(fresh.id);
  if (fresh.failureResumable === false) throw new PlanNotResumableError(fresh.id);
  const plan = await planRepository.findById(target.planId, workspaceId, tx);
  if (!plan || plan.status !== 'generating' || plan.sourceJobId !== target.failedJobId) {
    throw new PlanNotResumableError(fresh.id);
  }
  if (!(await planRepository.repointSourceJob(target.planId, jobId, tx))) {
    throw new PlanNotResumableError(fresh.id);
  }
  if (!(await planChangeSessionRepository.recordResumedAttempt(fresh.id, { jobId, at: now }, tx))) {
    throw new PlanSessionEndedError(fresh.id);
  }
  await planChangeSessionRepository.clearFailure(fresh.id, tx);
  await planStepRepository.clearProviderWaitsForPlan(target.planId, tx);
  await planTargetLockService.refreshForSessionWithin(fresh.id, now, tx);
}

/**
 * motir-ai's refusal of a resume whose failed job carries no settled conversation
 * (`withResumedConversation`, a `validation_error` → {@link MotirAiBadRequestError}). The
 * refusal shares its problem code with every other bad request, so its detail is what names
 * it — the one place core reads motir-ai's words, and only to recognise a refusal that a
 * failure recorded before `failureResumable` existed can still meet.
 */
function isNothingToResumeRefusal(err: unknown): boolean {
  return err instanceof MotirAiBadRequestError && /no settled conversation/.test(err.message);
}

/**
 * Record the refused failure as not resumable and release its attempt (MOTIR-9121), under
 * the plan lock then the session lock — the bind's own order — and only while the failure is
 * still the one the Resume judged. A concurrent end, a newer attempt or a re-pointed plan
 * leaves everything as it is.
 */
async function markUnresumable(pctx: ProjectContext, target: ResumeTarget): Promise<void> {
  const marked = await withWorkspaceServiceContext(pctx.workspaceId, async (tx) => {
    if (!(await planRepository.lockById(target.planId, tx))) return false;
    if (!(await planChangeSessionRepository.lockById(target.sessionId, tx))) return false;
    const plan = await planRepository.findById(target.planId, pctx.workspaceId, tx);
    if (!plan || plan.status !== 'generating' || plan.sourceJobId !== target.failedJobId) {
      return false;
    }
    return planChangeSessionRepository.markFailureUnresumable(
      target.sessionId,
      target.failedJobId,
      tx,
    );
  });
  if (marked) await releaseUnresumableAttempt(target.sessionId, pctx.workspaceId);
}

async function bind(pctx: ProjectContext, target: ResumeTarget, jobId: string): Promise<void> {
  await withWorkspaceContext(
    { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
    (tx) => bindWithin(tx, target, jobId, new Date(), pctx.workspaceId),
  );
}

// THE AUTOMATIC RESUME (Story MOTIR-8301 · MOTIR-8307). A hosted walk whose machine was LOST —
// motir-ai reaped its job — and whose plan already holds a proposal is resumed by core itself:
// the same plan, the same session, signed as the session's STARTER (who is metered, and whose
// access is checked), at most `AUTO_RESUMES_PER_SESSION` times per session. Every other failure
// waits in To resume as before. The two callers are the places a failure is RECORDED — the
// relays' `settleFailedJob` and the sweep's session arm — and nothing else calls it.
//
// SAME ORDER AND SAME TRADE AS THE MANUAL RESUME: submit (a metered side effect, outside any
// transaction), then bind. Everything knowable beforehand — the bound, the proposal, the state,
// the starter's permission — is refused before the submit, so an orphan job is left only by a
// genuinely simultaneous race. The bind ALSO spends one of the session's resumes, and
// `recordAutoResume` enforces the bound in its own statement, so a bind that would exceed it
// rolls back whole; and it stamps the plan's activity at the bind instant, so the silence sweep
// measures from the resume rather than racing the waiting job back into To resume.

/** Why an automatic resume was not started — a value, never a throw. */
export type AutoResumeSkip =
  | 'not_failed'
  | 'no_proposal'
  | 'bound_spent'
  | 'not_resumable'
  | 'starter_cannot_plan'
  | 'submit_refused'
  | 'lost_race';

export type AutoResumeOutcome =
  | { started: true; jobId: string; count: number }
  | { started: false; reason: AutoResumeSkip };

/** Thrown INSIDE the bind when the bound is spent, so the whole bind rolls back. Never escapes. */
class AutoResumeBoundSpent extends Error {}

const LOST_RACE_ERRORS = [
  ResumeAlreadyStartedError,
  PlanSessionEndedError,
  PlanNotResumableError,
  PlanSessionNotFoundError,
  AutoResumeBoundSpent,
];

type AutoResumePrecheck =
  | { ok: true; target: ResumeTarget; starterCtx: ProjectContext }
  | { ok: false; reason: AutoResumeSkip };

async function precheckAutomatic(input: {
  sessionId: string;
  workspaceId: string;
  projectId: string;
}): Promise<AutoResumePrecheck> {
  return withWorkspaceServiceContext(input.workspaceId, async (tx) => {
    const session = await planChangeSessionRepository.findByIdInProject(
      input.sessionId,
      input.projectId,
      input.workspaceId,
      tx,
    );
    if (!session || session.endedAt || session.origin !== 'conversation') {
      return { ok: false, reason: 'not_resumable' };
    }
    if (sessionWaitingState(session) !== 'failed' || !session.failedJobId) {
      return { ok: false, reason: 'not_failed' };
    }
    if (session.failureResumable === false) return { ok: false, reason: 'not_resumable' };
    if (session.autoResumeCount >= AUTO_RESUMES_PER_SESSION) {
      return { ok: false, reason: 'bound_spent' };
    }
    const plan = await planRepository.findLatestForResume(session.id, tx);
    if (!plan || plan.status !== 'generating' || plan.sourceJobId !== session.failedJobId) {
      return { ok: false, reason: 'not_resumable' };
    }
    if ((await planItemRepository.countByPlan(plan.id, tx)) < 1) {
      return { ok: false, reason: 'no_proposal' };
    }
    // Nobody to sign as (the starter's account is gone): nobody is charged, a person decides.
    if (!session.createdById) return { ok: false, reason: 'starter_cannot_plan' };
    const project = await projectRepository.findById(input.projectId, tx);
    if (!project) return { ok: false, reason: 'not_resumable' };
    return {
      ok: true,
      target: {
        sessionId: session.id,
        planId: plan.id,
        failedJobId: session.failedJobId,
        starterUserId: plan.createdById,
      },
      starterCtx: {
        userId: session.createdById,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        project: toProjectDTO(project),
      },
    };
  });
}

async function attemptAutomatic(
  input: { sessionId: string; workspaceId: string; projectId: string },
  onPlan: (planId: string) => void,
): Promise<AutoResumeOutcome> {
  const pre = await precheckAutomatic(input);
  if (!pre.ok) return { started: false, reason: pre.reason };
  const { target, starterCtx } = pre;
  onPlan(target.planId);
  try {
    await projectAccessService.assertPermission(
      starterCtx.projectId,
      { userId: starterCtx.userId, workspaceId: starterCtx.workspaceId },
      'ai:plan',
    );
  } catch {
    return { started: false, reason: 'starter_cannot_plan' };
  }
  let jobId: string;
  try {
    ({ jobId } = await aiPlanEditsService.submitResume(
      target.planId,
      target.failedJobId,
      starterCtx,
      target.starterUserId,
    ));
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    // eslint-disable-next-line no-console -- the one-line auto-resume trace the card asks for
    console.info(
      `[auto-resume] session ${target.sessionId} submit refused: ${typeof code === 'string' ? code : 'unknown'}`,
    );
    return { started: false, reason: 'submit_refused' };
  }
  try {
    const count = await withWorkspaceContext(
      {
        userId: starterCtx.userId,
        workspaceId: starterCtx.workspaceId,
        projectId: starterCtx.projectId,
      },
      async (tx) => {
        const now = new Date();
        await bindWithin(tx, target, jobId, now, starterCtx.workspaceId);
        const n = await planChangeSessionRepository.recordAutoResume(
          target.sessionId,
          { at: now, max: AUTO_RESUMES_PER_SESSION },
          tx,
        );
        if (n === null) throw new AutoResumeBoundSpent();
        await planRepository.touchActivity(target.planId, now, tx);
        return n;
      },
    );
    return { started: true, jobId, count };
  } catch (err) {
    if (LOST_RACE_ERRORS.some((E) => err instanceof E))
      return { started: false, reason: 'lost_race' };
    throw err;
  }
}

export const planSessionResumeService = {
  /**
   * RESUME a failed-waiting session — the caller's own, or any in the project for a member who
   * is a project manager. Returns the new job to stream, the SAME
   * plan, and the session as it now stands (no longer failed).
   */
  async resume(pctx: ProjectContext, sessionId: string): Promise<PlanChangeSubmitResultDto> {
    await projectAccessService.assertPermission(
      pctx.projectId,
      { userId: pctx.userId, workspaceId: pctx.workspaceId },
      'ai:plan',
    );
    const target = await precheck(pctx, sessionId);
    // Side effect OUTSIDE any transaction. Its typed errors (out of credits, unreachable, a
    // motir-ai refusal of the resume) propagate with nothing written: the failure record and the
    // plan are exactly as they were — save ONE refusal, below.
    let jobId: string;
    try {
      ({ jobId } = await aiPlanEditsService.submitResume(
        target.planId,
        target.failedJobId,
        pctx,
        target.starterUserId,
      ));
    } catch (err) {
      // NOTHING TO CONTINUE FROM (MOTIR-9121): motir-ai refuses a resume of a job that failed
      // before its conversation settled, and it will refuse every later one too. A failure
      // recorded before motir-ai said so up front reaches it only here, so this refusal leaves
      // the session where the up-front verdict would have — not resumable, its attempt
      // released — rather than offering the same refused Resume again.
      if (isNothingToResumeRefusal(err)) {
        await markUnresumable(pctx, target);
        throw new PlanNotResumableError(target.sessionId);
      }
      throw err;
    }
    await bind(pctx, target, jobId);
    const session = await planChangeSessionsService.getById(pctx, target.sessionId);
    return { jobId, planId: target.planId, session };
  },

  /**
   * RESUME A LOST MACHINE'S PLAN AUTOMATICALLY (MOTIR-8307) — see the header above. Called only
   * by the two places a failure is recorded, after it is recorded. Every skip is a value, and
   * every outcome is logged on one line.
   */
  async resumeAutomatically(input: {
    sessionId: string;
    workspaceId: string;
    projectId: string;
  }): Promise<AutoResumeOutcome> {
    let planId = 'none';
    const outcome = await attemptAutomatic(input, (id) => {
      planId = id;
    });
    const result = outcome.started
      ? `started job ${outcome.jobId} (${outcome.count}/${AUTO_RESUMES_PER_SESSION})`
      : `skipped: ${outcome.reason}`;
    // eslint-disable-next-line no-console -- the one-line auto-resume trace the card asks for
    console.info(`[auto-resume] session ${input.sessionId} plan ${planId} → ${result}`);
    return outcome;
  },
};
