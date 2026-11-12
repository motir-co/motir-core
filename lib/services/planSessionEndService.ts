import type { Prisma, PlanChangeSession, PlanSessionEndReason } from '@/generated/prisma/client';

import type { ServiceContext } from '@/lib/workItems/serviceContext';
import {
  type AutoResumeCause,
  autoResumeCauseOf,
  CLEARED_AWAITING_COLUMNS,
  CLEARED_FAILURE_COLUMNS,
  sessionWaitingState,
} from '@/lib/planChange/sessionWaitingState';
import {
  withSystemContext,
  withWorkspaceContext,
  withWorkspaceServiceContext,
} from '@/lib/workspaces/context';
import { PLAN_TARGET_LOCK_LEASE_MS } from '@/lib/planChange/targetLock';
import {
  REVISION_ENDED_KIND,
  REVISION_STARTED_KIND,
  isReopenedByRevision,
  PLAN_REVISION_LEASE_MS,
  revisionLeaseOf,
} from '@/lib/planChange/revisionLease';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { planRepository } from '@/lib/repositories/planRepository';
import { planRevisionRepository } from '@/lib/repositories/planRevisionRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { planTargetLockService } from '@/lib/services/planTargetLockService';
import { planRevisionsService } from '@/lib/services/planRevisionsService';
import { PlanChangeSessionNotFoundError } from '@/lib/planChange/errors';
import {
  failureRecordFrom,
  type JobWalkPosition,
  type FailedJobFacts,
} from '@/lib/planChange/failureRecord';
import type { PlanSessionFailureRecord } from '@/lib/planChange/sessionWaitingState';
import { getJob } from '@/lib/ai/motirAiClient';
import type { AutoResumeOutcome } from '@/lib/services/planSessionResumeService';
import { clearWithin as clearPlanningSessionGate } from '@/lib/services/planningSessionGateService';

// THE ONE END OPERATION (story MOTIR-7630 · MOTIR-7637;
// `docs/decisions/agent-authored-plans.md` AMENDMENT 23 §2).
//
// A planning session is OPEN exactly while `ended_at IS NULL`, and this module is
// the only writer of its end. Six events end a session — a failed attempt, an
// idle close, a restart, a decline, an approve and the abandoned-plan sweep — and
// every one of them comes through here, so each gives the cards back the same
// way and none can end a session twice.
//
// Its own module rather than a method on `planChangeSessionsService` because
// `plansService` calls it from inside the decision transactions, and the
// conversation service already reaches `plansService` through the plan-edit
// service: one import the other way would close the cycle.

/** Who ended a session, and in whose name its cards are given back. */
export interface PlanSessionEndActor {
  /** The PERSON who ended it — the decider, or the person who restarted. `null`
   *  when Motir ended it (a failed attempt, an idle close). */
  endedById: string | null;
  /** The user each status restore is signed with. For a person it is that
   *  person; for Motir it is resolved by {@link endSession} when omitted. */
  actor: ServiceContext;
  now?: Date;
  /** The IDLE CLOSE's guard, checked under the session's lock: end only if the
   *  session's last activity is still older than this AND it holds no undecided
   *  plan. A turn that landed after the sweep's discovery read wins. A session
   *  awaiting its person is not idle — unless it holds NO plan and no failure
   *  (MOTIR-9299): a legacy mark on a conversation that never reached planning does
   *  not protect it, while a mark on a session holding a plan still does. */
  onlyIfIdleBefore?: Date;
}

/** What an end did: `ended` is false when the session had already ended, in
 *  which case `session` is the FIRST end, untouched — or, for the idle close,
 *  when the session turned out not to be idle, in which case it is still open. */
export interface PlanSessionEndResult {
  ended: boolean;
  session: PlanChangeSession;
}

/** The reasons whose end leaves the session's cards and its `generating` plan to
 *  this operation. `approved` / `declined` are a plan decision, whose own
 *  transaction already decides the plan and releases its locks after commit. */
const OPERATION_OWNS_RELEASE: ReadonlySet<PlanSessionEndReason> = new Set([
  'failed',
  'idle',
  'restarted',
]);

/**
 * END A SESSION INSIDE THE CALLER'S TRANSACTION.
 *
 * Under the session's row lock: an ended session returns its first end and
 * writes nothing (the idempotence every caller leans on — a relay frame and the
 * sweep may both see one failure). Otherwise it stamps `endedAt` / `endReason` /
 * `endedById` and, for a `failed` / `idle` / `restarted` end:
 *
 *   * discards the session's LATEST plan if it is still `generating` — as
 *     `abandoned` with no decider when Motir ended it, as `discarded` by the
 *     person who restarted. A `planned` or `stale` plan waits for a person and
 *     is left exactly as it is;
 *   * gives back everything the session (and that discarded plan) held, restoring
 *     each card's prior status as a system write.
 *
 * ⚠️ LOCK ORDER IS PLAN, THEN SESSION — the order the decision bodies take them
 * (`declineWithin` locks the plan and then ends its session here). Taking the
 * session first would let a person's discard of a generating plan and a relay's
 * failure end deadlock on the two rows.
 */
export async function endSessionWithin(
  tx: Prisma.TransactionClient,
  sessionId: string,
  workspaceId: string,
  reason: PlanSessionEndReason,
  by: PlanSessionEndActor,
): Promise<PlanSessionEndResult> {
  const now = by.now ?? new Date();
  const ownsRelease = OPERATION_OWNS_RELEASE.has(reason);
  const latestPlanId = ownsRelease
    ? await planRepository.findLatestIdBySession(sessionId, tx)
    : null;
  if (latestPlanId) await planRepository.lockById(latestPlanId, tx);

  const locked = await planChangeSessionRepository.lockById(sessionId, tx);
  if (!locked) throw new PlanChangeSessionNotFoundError(sessionId);
  const fresh = await planChangeSessionRepository.findById(sessionId, workspaceId, tx);
  if (!fresh) throw new PlanChangeSessionNotFoundError(sessionId);
  if (fresh.endedAt) return { ended: false, session: fresh };
  if (by.onlyIfIdleBefore) {
    // A session that is WAITING (failed, or awaiting its person) is never idle: a
    // mark that landed between the discovery read and this lock wins (MOTIR-7912).
    // EXCEPT a mark on a session holding NO plan and no failure (MOTIR-9299): a
    // conversation that never reached planning is not waiting on anyone, so a mark left
    // under the old rule is released by this end. Phrased off the same `latestPlanId`
    // read as the release below, so discovery (`listIdleOpen`) and this re-check agree.
    const planlessUnfailed = ownsRelease && latestPlanId === null && fresh.failedAt === null;
    const stillIdle =
      (sessionWaitingState(fresh) === 'open' || planlessUnfailed) &&
      fresh.lastActivityAt < by.onlyIfIdleBefore &&
      (await planRepository.countUndecidedBySession(sessionId, tx)) === 0;
    if (!stillIdle) return { ended: false, session: fresh };
  }

  // NO END ARM ENDS A SESSION THAT HOLDS A PLAN WAITING FOR A DECISION (MOTIR-7936). A
  // failure beside a `planned` / `stale` plan is a failed REVISION or a failed second
  // attempt, and the plan a person is yet to decide must not be taken from them with the
  // session. Only the failed attempt's own `generating` plan is declined (`abandoned`) and
  // its plan-held locks given back; the session stays open with no failure record.
  if (
    reason === 'failed' &&
    (await planRepository.countAwaitingDecisionBySession(sessionId, null, tx)) > 0
  ) {
    if (latestPlanId) {
      const plan = await planRepository.findById(latestPlanId, workspaceId, tx);
      if (plan?.status === 'generating') {
        await planRepository.update(
          plan.id,
          { status: 'declined', decidedAt: now, decidedById: null, decisionReason: 'abandoned' },
          tx,
        );
      }
      if (plan && (plan.status === 'generating' || plan.status === 'declined')) {
        await planTargetLockService.releaseForPlanWithin(plan.id, by.actor, tx, { system: true });
      }
    }
    return { ended: false, session: fresh };
  }

  const session = await planChangeSessionRepository.update(
    sessionId,
    {
      endedAt: now,
      endReason: reason,
      endedById: by.endedById,
      // AN ENDED SESSION WAITS ON NOTHING (MOTIR-7908). The `plan_change_session_one_wait`
      // CHECK requires it, so the one end write clears BOTH waits — a failed attempt
      // waiting to resume, and a conversation awaiting its person — in the same
      // statement. Anything that ends a session through this operation gets that for
      // free; nothing else may write `endedAt`.
      ...CLEARED_FAILURE_COLUMNS,
      ...CLEARED_AWAITING_COLUMNS,
    },
    tx,
  );
  // THE PLANNING-SESSION GATE ENDS WITH THE SESSION (MOTIR-7913): withdrawn `session_ended`
  // in the same transaction as the end write, whatever the reason. The end write above
  // already nulled the marker; this supersedes the gate row.
  await clearPlanningSessionGate(tx, { sessionId, cause: 'session_ended' });
  if (!ownsRelease) return { ended: true, session };

  if (latestPlanId) {
    const plan = await planRepository.findById(latestPlanId, workspaceId, tx);
    if (plan?.status === 'generating') {
      const byPerson = reason === 'restarted' && by.endedById !== null;
      await planRepository.update(
        plan.id,
        {
          status: 'declined',
          decidedAt: now,
          decidedById: byPerson ? by.endedById : null,
          decisionReason: byPerson ? 'discarded' : 'abandoned',
        },
        tx,
      );
      // A person's discard is a decision and goes on the trail, as
      // `declineWithin` records one. Motir's is not — the abandoned sweep has
      // never recorded its `abandoned` either; the reason on the row says it.
      if (byPerson) {
        await planRevisionsService.recordRevision(
          {
            planId: plan.id,
            changeKind: 'declined',
            changedById: by.endedById!,
            diff: { decisionReason: 'discarded', sessionEnd: reason },
          },
          tx,
        );
      }
      await planTargetLockService.releaseForPlanWithin(plan.id, by.actor, tx, { system: true });
    }
  }
  await planTargetLockService.releaseForSessionWithin(sessionId, by.actor, tx, { system: true });
  return { ended: true, session };
}

/**
 * END A SESSION IN ITS OWN TRANSACTION — the door for a caller that holds no
 * transaction: the stream relays, the two sweeps and the restart control.
 *
 * Binds the session's OWN workspace and project, so a background caller with no
 * acting user ends it under the right tenant. When `actor` is omitted (Motir
 * ended it), the restores are signed by the session's starter, falling back to
 * the workspace's stand-in manager — the same answer the lock sweep gives.
 */
export async function endSession(
  sessionId: string,
  reason: PlanSessionEndReason,
  opts: {
    workspaceId: string;
    endedById?: string | null;
    actorId?: string | null;
    now?: Date;
    onlyIfIdleBefore?: Date;
  },
): Promise<PlanSessionEndResult> {
  const { workspaceId } = opts;
  const located = await withWorkspaceServiceContext(workspaceId, async (tx) => {
    const session = await planChangeSessionRepository.findById(sessionId, workspaceId, tx);
    if (!session) return null;
    const signer =
      opts.actorId ??
      session.createdById ??
      (await workspaceMembershipRepository.findStandInManagerByWorkspace(workspaceId, tx))
        ?.userId ??
      null;
    return { session, signer };
  });
  if (!located) throw new PlanChangeSessionNotFoundError(sessionId);
  if (located.session.endedAt) return { ended: false, session: located.session };
  const { session, signer } = located;
  // A workspace always has a manager, so this is a corrupt tenant, not a race.
  if (!signer) throw new Error(`[planSessionEnd] nobody can sign the end of session ${sessionId}`);

  return withWorkspaceContext({ userId: signer, workspaceId, projectId: session.projectId }, (tx) =>
    endSessionWithin(tx, sessionId, workspaceId, reason, {
      endedById: opts.endedById ?? null,
      actor: { userId: signer, workspaceId },
      now: opts.now,
      onlyIfIdleBefore: opts.onlyIfIdleBefore,
    }),
  );
}

/**
 * RELEASE THE LEASE OF A REVISION WHOSE JOB FAILED (MOTIR-7945). A job that died
 * used to release nothing (`plansService.releaseRevisionLease`'s note), so a
 * conversation whose revision failed held its plan for the whole lease window and
 * its next turn was refused `PLAN_REVISION_IN_FLIGHT`.
 *
 * Only the revision THIS job started is ended — the open `revision_started` row
 * must name `jobId` — so an older job's failure never ends a newer revision.
 * Idempotent: with nothing held, or held by another job, it writes nothing.
 * Signed by Motir (no acting user), like the drift service's moves; `plan` and
 * `plan_revision` are pure workspace gates.
 */
export async function releaseRevisionForFailedJob(
  jobId: string,
  workspaceId: string,
): Promise<{ planId: string; released: boolean } | null> {
  return withWorkspaceServiceContext(workspaceId, async (tx) => {
    const plan = await planRepository.findBySourceJobId(jobId, workspaceId, tx);
    if (!plan) return null;
    const locked = await planRepository.lockById(plan.id, tx);
    if (!locked) return null;
    const fresh = await planRepository.findById(plan.id, workspaceId, tx);
    if (!fresh) return null;
    const rows = await planRevisionRepository.listByPlan(plan.id, tx);
    // A revision that RE-OPENED its plan is given back however its lease stands
    // (Bug MOTIR-8208): a lapsed lease over a `generating` plan still owes the plan
    // its `planned`.
    const reopened = isReopenedByRevision(fresh, rows);
    if (!reopened && !revisionLeaseOf(rows, new Date())) {
      return { planId: plan.id, released: false };
    }
    const start = [...rows].reverse().find((r) => r.changeKind === REVISION_STARTED_KIND);
    const startedBy = (start?.diff as { jobId?: unknown } | null)?.jobId;
    if (startedBy !== jobId) return { planId: plan.id, released: false };
    await planRevisionsService.recordRevision(
      {
        planId: plan.id,
        changeKind: REVISION_ENDED_KIND,
        changedById: null,
        actor: { source: 'native', harness: 'Motir', model: null },
        diff: {
          revision: true,
          jobId,
          failed: true,
          ...(reopened ? { restoredTo: 'planned' } : {}),
        },
      },
      tx,
    );
    if (reopened) {
      // Loaded lazily, for the cycle this file's header warns about.
      const { plansService } = await import('@/lib/services/plansService');
      await plansService.restoreReopenedPlanWithin(tx, plan.id);
    }
    return { planId: plan.id, released: true };
  });
}

/**
 * GIVE BACK A PLAN WHOSE RE-OPENING REVISION LAPSED (Bug MOTIR-8208): the
 * revision's lease ran out with no `revision_ended`, so nobody is writing the plan,
 * and it goes back to `planned` as it stands (`plansService.settleLapsedRevisionWithin`).
 * The person can ask for the revision again.
 *
 * Re-checked under the plan's lock: a revision that renewed, ended or was taken
 * again since discovery is left alone (`false`).
 */
export async function releaseLapsedRevision(
  planId: string,
  workspaceId: string,
  now: Date = new Date(),
): Promise<boolean> {
  return withWorkspaceServiceContext(workspaceId, async (tx) => {
    const locked = await planRepository.lockById(planId, tx);
    if (!locked) return false;
    // Loaded lazily, for the cycle this file's header warns about.
    const { plansService } = await import('@/lib/services/plansService');
    return plansService.settleLapsedRevisionWithin(tx, planId, workspaceId, now);
  });
}

/** Plans given back per lapsed-revision pass; a backlog drains over several passes. */
export const LAPSED_REVISION_BATCH_SIZE = 200;

/**
 * THE LAPSED-REVISION PASS (Bug MOTIR-8208) — run by the planning-lock sweep every
 * 5 minutes. A revision RE-OPENS its plan (`planned` → `generating`), so a revision
 * that stops writing without ending — a job that died unseen, an agent that went
 * away mid-`hold_plan_revision` — would otherwise leave the plan `generating` with
 * nobody writing it. Every such plan whose lease has lapsed is given back to
 * `planned`, within one sweep interval of the lapse.
 *
 * CROSS-TENANT discovery, PER-TENANT restore, exactly like the idle close: the read
 * runs under the system context and each restore binds the plan's own workspace and
 * re-checks under the plan's row lock.
 */
export async function releaseLapsedRevisions(
  now: Date = new Date(),
  batchSize: number = LAPSED_REVISION_BATCH_SIZE,
): Promise<{ restored: number; planIds: string[] }> {
  const lapsedBefore = new Date(now.getTime() - PLAN_REVISION_LEASE_MS);
  const candidates = await withSystemContext((tx) =>
    planRepository.listLapsedRevisionCandidates(lapsedBefore, batchSize, tx),
  );
  const planIds: string[] = [];
  for (const plan of candidates) {
    try {
      if (await releaseLapsedRevision(plan.id, plan.workspaceId, now)) planIds.push(plan.id);
    } catch (err) {
      console.warn(
        `[planSessionEnd] giving back the lapsed revision of plan ${plan.id} failed`,
        err,
      );
    }
  }
  return { restored: planIds.length, planIds };
}

/**
 * END THE SESSION WHOSE ATTEMPT JUST FAILED (MOTIR-7638; AMENDMENT 23 §2) — the
 * stream relays call it on a terminal `failed` / `canceled` frame.
 *
 * The session is the one whose `lastJobId` is this job: only the session's
 * CURRENT attempt ends it. An older job of a session that has since submitted
 * again names no session, so its failure ends nothing. A job no session owns
 * (a work item's contextual plan) is a no-op. Idempotent with the abandoned-plan
 * sweep, which ends the same session as a backstop.
 */
export async function endSessionForFailedJob(
  jobId: string,
  ctx: { userId: string; workspaceId: string; projectId: string },
): Promise<PlanSessionEndResult | null> {
  // A failed REVISION job also gives its plan back (MOTIR-7945): it is the
  // plan's `sourceJobId` as well as the session's `lastJobId`, and without this
  // the plan stayed leased to a dead job for the whole lease window.
  await releaseRevisionForFailedJob(jobId, ctx.workspaceId);
  const session = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    planChangeSessionRepository.findByProjectAndLastJobId(
      ctx.projectId,
      jobId,
      ctx.workspaceId,
      tx,
    ),
  );
  if (!session || session.endedAt) return null;
  // No `actorId`: Motir ended it, so the restores are signed by the session's
  // starter, whoever happens to be watching the stream.
  return endSession(session.id, 'failed', { workspaceId: ctx.workspaceId });
}

/** What {@link recordFailureWithin} did. */
export type RecordFailureOutcome =
  | 'recorded'
  | 'ended'
  | 'plan_not_generating'
  | 'not_latest'
  | 'activity_moved'
  /** The session has bound a newer attempt since its caller read it (MOTIR-8307). */
  | 'job_moved';

/**
 * RECORD A FAILED ATTEMPT ON ITS OPEN SESSION, INSIDE THE CALLER'S TRANSACTION
 * (MOTIR-7912; `agent-authored-plans.md` AMENDMENT 23's 2026-10-09 sub-amendment).
 *
 * The replacement for ending: nothing is declined, nothing is released — the plan
 * stays `generating` with its proposals and the cards stay held. Same lock order as
 * {@link endSessionWithin}: the latest plan, then the session, and the waiting state
 * is re-read UNDER the session's lock, so a person's end (or the other writer of the
 * same failure) that landed first wins deterministically.
 *
 * Only a `generating` LATEST plan is a failed walk; anything else is
 * `'plan_not_generating'` and the caller falls back to the existing end. When
 * `onlyPlanId` is given (the sweep), that plan must still be the session's latest.
 *
 * When `lastActivityAt` is given (the sweep, MOTIR-8132), the write is a
 * COMPARE-AND-SET on it: the plan's stamp is re-read under the plan lock and the
 * failure is recorded only if it still equals the one the sweep judged silent. A
 * content write or step signal that landed in between moved it — that producer is
 * alive — and the answer is `'activity_moved'`, with nothing written.
 */
export async function recordFailureWithin(
  tx: Prisma.TransactionClient,
  sessionId: string,
  workspaceId: string,
  record: PlanSessionFailureRecord,
  opts: { onlyPlanId?: string; lastActivityAt?: Date; onlyLastJobId?: string } = {},
): Promise<RecordFailureOutcome> {
  const latestPlanId = await planRepository.findLatestIdBySession(sessionId, tx);
  if (latestPlanId) await planRepository.lockById(latestPlanId, tx);
  const locked = await planChangeSessionRepository.lockById(sessionId, tx);
  if (!locked) throw new PlanChangeSessionNotFoundError(sessionId);
  const fresh = await planChangeSessionRepository.findWaitingState(sessionId, workspaceId, tx);
  if (!fresh || fresh.endedAt) return 'ended';
  // A relay settling the attempt it read is answered only while that attempt is still the
  // session's: an automatic resume the sweep bound in between (MOTIR-8307) is a NEWER attempt,
  // and recording the old job's failure over it would fail a session that is running.
  if (opts.onlyLastJobId !== undefined && fresh.lastJobId !== opts.onlyLastJobId) {
    return 'job_moved';
  }
  if (opts.onlyPlanId !== undefined && latestPlanId !== opts.onlyPlanId) return 'not_latest';
  const plan = latestPlanId ? await planRepository.findById(latestPlanId, workspaceId, tx) : null;
  // A failed REVISION leaves a `planned` / `stale` plan beside the failure (MOTIR-7936):
  // the session still waits, and the plan stays decidable.
  if (plan?.status !== 'generating' && plan?.status !== 'planned' && plan?.status !== 'stale') {
    return 'plan_not_generating';
  }
  if (
    opts.lastActivityAt !== undefined &&
    plan.lastActivityAt.getTime() !== opts.lastActivityAt.getTime()
  ) {
    return 'activity_moved';
  }
  if (!(await planChangeSessionRepository.markFailed(sessionId, record, tx))) return 'ended';
  // The failure write nulls the awaiting-person marker (a session never waits for both), so the
  // planning-session gate that marker raised would be left `awaiting` with nothing behind it:
  // withdraw it, so the wait that turned into a failure leaves Waiting on you for good and the
  // session lives in To resume alone (Story MOTIR-7905 · MOTIR-7919). `session_ended` is the
  // nearest withdraw cause — the WAIT the gate named is over; the session itself stays open.
  await clearPlanningSessionGate(tx, { sessionId, cause: 'session_ended' });
  return 'recorded';
}

/**
 * AN ATTEMPT THAT CANNOT BE RESUMED HOLDS NOTHING (MOTIR-9121). motir-ai said the failed job
 * has no settled conversation to continue from, so it refuses every Resume of it — and a
 * failed-waiting session keeps its `generating` plan and its held cards precisely so that a
 * Resume can continue them. With no Resume possible that hold is a trap: the card sits at
 * Planning, spared by every sweep as "a person is coming back", and the person can do nothing.
 *
 * So the attempt is given up the way the end operation gives up a `generating` plan: the plan
 * is declined `abandoned` and every target the plan and the session hold goes back to the
 * status it was parked from. The session itself STAYS OPEN with its failure record
 * (`failureResumable: false`): the overlay says the attempt could not be continued, To resume
 * does not list it, and the next turn plans again (`classifyFailedWaitingTurn` → `continue`),
 * clearing the record as it binds.
 *
 * Called AFTER the record commits, by the three places that learn an attempt is not resumable
 * (the relay's settle, the abandoned-plan sweep, a refused Resume), in its OWN transaction bound
 * like {@link endSession}'s — the session's project, signed by its starter, else the
 * workspace's stand-in manager — and re-checked under the plan lock then the session lock: a
 * session that ended, was resumed or failed again meanwhile is left as it is. Idempotent: a
 * second call finds nothing held.
 */
export async function releaseUnresumableAttempt(
  sessionId: string,
  workspaceId: string,
): Promise<{ released: boolean }> {
  const located = await withWorkspaceServiceContext(workspaceId, async (tx) => {
    const session = await planChangeSessionRepository.findById(sessionId, workspaceId, tx);
    if (!session) return null;
    const signer =
      session.createdById ??
      (await workspaceMembershipRepository.findStandInManagerByWorkspace(workspaceId, tx))
        ?.userId ??
      null;
    return { session, signer };
  });
  if (!located?.signer) return { released: false };
  const { session, signer } = located;
  const actor = { userId: signer, workspaceId };
  return withWorkspaceContext(
    { userId: signer, workspaceId, projectId: session.projectId },
    async (tx) => {
      const latestPlanId = await planRepository.findLatestIdBySession(sessionId, tx);
      if (latestPlanId) await planRepository.lockById(latestPlanId, tx);
      // A row that vanished takes no lock and reads back as nothing: the re-check refuses it.
      await planChangeSessionRepository.lockById(sessionId, tx);
      const fresh = await planChangeSessionRepository.findById(sessionId, workspaceId, tx);
      if (!fresh || fresh.endedAt || !fresh.failedAt || fresh.failureResumable !== false) {
        return { released: false };
      }
      const plan = latestPlanId
        ? await planRepository.findById(latestPlanId, workspaceId, tx)
        : null;
      if (plan && plan.status === 'generating' && plan.sourceJobId === fresh.failedJobId) {
        await planRepository.update(
          plan.id,
          {
            status: 'declined',
            decidedAt: fresh.failedAt,
            decidedById: null,
            decisionReason: 'abandoned',
          },
          tx,
        );
        await planTargetLockService.releaseForPlanWithin(plan.id, actor, tx, { system: true });
      }
      await planTargetLockService.releaseForSessionWithin(sessionId, actor, tx, { system: true });
      return { released: true };
    },
  );
}

/** What a settled failure came to. */
export interface SettleFailedJobResult {
  /** `released`: a failed or canceled REVISION gave its lease back and no failure was
   *  recorded (a canceled job, or a plan with no open conversation session). */
  settled: 'recorded' | 'ended' | 'released';
  sessionId: string | null;
  /** Which settle arm answered: a walk's session, or a revision (MOTIR-8304). */
  arm: 'session' | 'revision';
  /**
   * `true` only when the job was READ and motir-ai reports it lost its machine
   * (`JobView.lostMachine`). A canceled job, a non-conversation session and a read
   * that failed all report `false`: unknown resolves to not lost, so that failure
   * waits in To resume (MOTIR-8304).
   */
  lostMachine: boolean;
  /**
   * The automatic resume this settle started or skipped (MOTIR-8307) — attempted only for a
   * walk's session whose failure was RECORDED because its machine was lost, or because the
   * AI provider was unavailable (`model_unavailable`, MOTIR-10968); `null` whenever no
   * attempt was made.
   */
  autoResume: AutoResumeOutcome | null;
}

/** The seam a test replaces: what motir-ai says about the failed job. */
export interface SettleFailedJobDeps {
  readJob?: (
    jobId: string,
    coreProjectId: string,
  ) => Promise<
    Omit<FailedJobFacts, 'lostMachine' | 'resumable'> & {
      lostMachine?: boolean;
      resumable?: boolean | null;
    }
  >;
}

/**
 * SETTLE THE SESSION WHOSE ATTEMPT JUST ENDED BADLY (MOTIR-7912) — the stream
 * relays call it on a terminal `failed` / `canceled` frame, replacing the old
 * unconditional end.
 *
 * The session is the one whose `lastJobId` is this job: only the CURRENT attempt
 * counts, an older job of a session that has submitted again names none, and a job
 * no session owns is a no-op. Then:
 *
 *   * a `failed` job on an open `conversation` session whose latest plan is
 *     `generating` → the failure is RECORDED, the session stays open;
 *   * a `canceled` job (someone chose to stop), a `guide` session, or a latest plan
 *     that is not `generating` → the existing end, unchanged.
 */
export async function settleFailedJob(
  jobId: string,
  ctx: { userId: string; workspaceId: string; projectId: string },
  input: { status: 'failed' | 'canceled'; lastPosition?: JobWalkPosition | null },
  deps: SettleFailedJobDeps = {},
): Promise<SettleFailedJobResult | null> {
  // A REVISION'S JOB first (MOTIR-7936): a job that is the `sourceJobId` of a `planned` /
  // `stale` plan is a revision (or a late failure of the walk that wrote it), and settling
  // it gives the plan's lease back at once instead of leaving it to expire.
  const revision = await settleFailedRevision(jobId, ctx, input, deps);
  if (revision) return revision;

  const session = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    planChangeSessionRepository.findByProjectAndLastJobId(
      ctx.projectId,
      jobId,
      ctx.workspaceId,
      tx,
    ),
  );
  if (!session || session.endedAt) return null;

  const end = async (lostMachine = false): Promise<SettleFailedJobResult> => {
    // No `actorId`: Motir ended it, so the restores are signed by the session's starter.
    await endSession(session.id, 'failed', { workspaceId: ctx.workspaceId });
    return {
      settled: 'ended',
      sessionId: session.id,
      arm: 'session',
      lostMachine,
      autoResume: null,
    };
  };
  if (input.status === 'canceled' || session.origin !== 'conversation') return end();

  const job = await (deps.readJob ?? readFailedJob)(jobId, ctx.projectId).catch(() => null);
  const lostMachine = job?.lostMachine ?? false;
  const record = failureRecordFrom({
    failedJobId: jobId,
    now: new Date(),
    walkStop: job?.walkStop ?? null,
    lastPosition: input.lastPosition ?? null,
    error: job?.error ?? null,
    resumable: job?.resumable ?? null,
  });
  const outcome = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    recordFailureWithin(tx, session.id, ctx.workspaceId, record, { onlyLastJobId: jobId }),
  );
  if (outcome === 'recorded') {
    // NOTHING TO RESUME (MOTIR-9121): give the attempt's cards back before the relay's
    // terminal frame, so the overlay's re-read already sees a session that plans again. No
    // automatic resume either — it would be refused for the same reason.
    if (record.failureResumable === false) {
      await releaseUnresumableAttempt(session.id, ctx.workspaceId);
      return {
        settled: 'recorded',
        sessionId: session.id,
        arm: 'session',
        lostMachine,
        autoResume: null,
      };
    }
    // AWAITED before returning, so by the time the relay sends its terminal frame the session
    // is already re-bound and no longer failed. A lost machine, or an unavailable provider
    // once (MOTIR-10968); every other recorded reason waits in To resume.
    const cause = autoResumeCauseOf({ lostMachine, ...record });
    const autoResume = cause
      ? await resumeAutomaticallySafely({
          sessionId: session.id,
          workspaceId: ctx.workspaceId,
          projectId: ctx.projectId,
          cause,
        })
      : null;
    return { settled: 'recorded', sessionId: session.id, arm: 'session', lostMachine, autoResume };
  }
  if (outcome === 'ended' || outcome === 'job_moved') return null;
  return end(lostMachine);
}

/**
 * SETTLE A FAILED OR CANCELED REVISION (MOTIR-7936). Resolves the plan the job writes
 * (`sourceJobId`, status `planned` / `stale`); then, in ONE transaction taking the plan's
 * lock and then its session's (the order every decision body takes):
 *
 *   * releases the revision lease — idempotent, so a relay and the sweep settling one
 *     failure leave ONE `revision_ended` row;
 *   * for a `failed` job whose plan names an OPEN `conversation` session, records the
 *     failure on it (the session keeps its plan and waits in To resume).
 *
 * A job whose plan has moved on (re-pointed at a newer job, decided) is left alone:
 * the holder check below runs under the lock. Returns `null` when the job is no
 * revision's, so the caller falls through to the session arm.
 */
async function settleFailedRevision(
  jobId: string,
  ctx: { userId: string; workspaceId: string; projectId: string },
  input: { status: 'failed' | 'canceled'; lastPosition?: JobWalkPosition | null },
  deps: SettleFailedJobDeps,
): Promise<SettleFailedJobResult | null> {
  const located = await withWorkspaceServiceContext(ctx.workspaceId, async (tx) => {
    const plan = await planRepository.findBySourceJobId(jobId, ctx.workspaceId, tx);
    if (!plan) return null;
    // A `generating` plan is a revision's only when the revision RE-OPENED it (Bug
    // MOTIR-8208); any other `generating` plan is a walk, and the session arm settles it.
    if (
      plan.status !== 'planned' &&
      plan.status !== 'stale' &&
      !isReopenedByRevision(plan, await planRevisionRepository.listByPlan(plan.id, tx))
    ) {
      return null;
    }
    const session = plan.sessionId
      ? await planChangeSessionRepository.findById(plan.sessionId, ctx.workspaceId, tx)
      : null;
    const signer =
      plan.createdById ??
      session?.createdById ??
      (await workspaceMembershipRepository.findStandInManagerByWorkspace(ctx.workspaceId, tx))
        ?.userId ??
      null;
    return { plan, session, signer };
  });
  if (!located || !located.signer) return null;
  const { plan, session, signer } = located;
  const recordable = input.status === 'failed' && session && session.origin === 'conversation';

  const job = recordable
    ? await (deps.readJob ?? readFailedJob)(jobId, ctx.projectId).catch(() => null)
    : null;
  const lostMachine = job?.lostMachine ?? false;
  const record = recordable
    ? failureRecordFrom({
        failedJobId: jobId,
        now: new Date(),
        walkStop: job?.walkStop ?? null,
        lastPosition: input.lastPosition ?? null,
        error: job?.error ?? null,
        resumable: job?.resumable ?? null,
      })
    : null;

  return withWorkspaceContext(
    { userId: signer, workspaceId: ctx.workspaceId, projectId: plan.projectId },
    async (tx) => {
      await planRepository.lockById(plan.id, tx);
      const fresh = await planRepository.findById(plan.id, ctx.workspaceId, tx);
      // Moved on under us: a newer job writes it, or it was decided. Not this job's to settle.
      if (!fresh || fresh.sourceJobId !== jobId) return null;
      const revisable =
        fresh.status === 'planned' ||
        fresh.status === 'stale' ||
        isReopenedByRevision(fresh, await planRevisionRepository.listByPlan(plan.id, tx));
      if (!revisable) return null;
      // Loaded lazily: `plansService` imports this module for its decision transactions, so a
      // static import back would close the cycle this file's header warns about.
      const { plansService } = await import('@/lib/services/plansService');
      await plansService.releaseRevisionLeaseWithin(
        tx,
        plan.id,
        { userId: signer, workspaceId: ctx.workspaceId },
        { source: null, harness: null, model: null },
        { failed: true, jobId, status: input.status },
        { closeExpired: true },
      );
      if (record && session) {
        const outcome = await recordFailureWithin(tx, session.id, ctx.workspaceId, record, {
          onlyPlanId: plan.id,
        });
        if (outcome === 'recorded') {
          return {
            settled: 'recorded',
            sessionId: session.id,
            arm: 'revision',
            lostMachine,
            autoResume: null,
          };
        }
      }
      return {
        settled: 'released',
        sessionId: session?.id ?? null,
        arm: 'revision',
        lostMachine,
        autoResume: null,
      };
    },
  );
}

/**
 * THE AUTOMATIC RESUME, AS A FAILURE-RECORDING PATH CALLS IT (MOTIR-8307): any throw becomes a
 * `submit_refused` skip, so the relay and the sweep never see an exception from it — the
 * failure stands recorded and waits in To resume. Loaded lazily: the resume service reaches
 * `planChangeSessionsService`, which imports this module.
 */
export async function resumeAutomaticallySafely(input: {
  sessionId: string;
  workspaceId: string;
  projectId: string;
  cause: AutoResumeCause;
}): Promise<AutoResumeOutcome> {
  try {
    const { planSessionResumeService } = await import('@/lib/services/planSessionResumeService');
    return await planSessionResumeService.resumeAutomatically(input);
  } catch (err) {
    console.warn(`[auto-resume] session ${input.sessionId} failed`, err);
    return { started: false, reason: 'submit_refused' };
  }
}

async function readFailedJob(jobId: string, coreProjectId: string): Promise<FailedJobFacts> {
  const view = await getJob(jobId, coreProjectId);
  return {
    error: view.error,
    walkStop: view.walkStop ?? null,
    lostMachine: view.lostMachine ?? false,
    resumable: view.resumable ?? null,
  };
}

/**
 * END THE SESSION OF A PLAN THE ABANDONED SWEEP JUST DECLINED (MOTIR-7638) — the
 * backstop for an attempt nobody was watching. Only when that plan is still the
 * session's LATEST: a session that has moved on to a newer plan is not this
 * attempt's to end. Idempotent with the relay: a session it already ended
 * returns its first end.
 */
export async function endSessionForAbandonedPlan(plan: {
  id: string;
  workspaceId: string;
  sessionId: string | null;
}): Promise<PlanSessionEndResult | null> {
  const sessionId = plan.sessionId;
  if (!sessionId) return null;
  const latest = await withWorkspaceServiceContext(plan.workspaceId, (tx) =>
    planRepository.findLatestIdBySession(sessionId, tx),
  );
  if (latest !== plan.id) return null;
  return endSession(sessionId, 'failed', { workspaceId: plan.workspaceId });
}

/** Sessions ended per idle-close pass; a backlog drains over several passes. */
export const PLAN_SESSION_IDLE_CLOSE_BATCH_SIZE = 200;

/**
 * THE IDLE CLOSE (MOTIR-7638; AMENDMENT 23 §2) — run by the lock sweep every 5
 * minutes. Ends as `idle` every open, non-`guide` session with no undecided plan
 * whose last activity is older than the session lease, whether or not it holds a
 * lock. A session's lease is refreshed on every turn, so its lease expiry and its
 * idle deadline are the same instant: a person mid-conversation is never closed,
 * and a session whose plan waits for a decision stays open until that decision.
 *
 * CROSS-TENANT discovery, PER-TENANT end, exactly like the lease sweep: the read
 * runs under the system context and each end binds the session's own workspace
 * and re-checks idleness under the row lock.
 */
export async function closeIdleSessions(
  now: Date = new Date(),
  batchSize: number = PLAN_SESSION_IDLE_CLOSE_BATCH_SIZE,
): Promise<{ closed: number; sessionIds: string[] }> {
  const olderThan = new Date(now.getTime() - PLAN_TARGET_LOCK_LEASE_MS);
  const idle = await withSystemContext((tx) =>
    planChangeSessionRepository.listIdleOpen(olderThan, batchSize, tx),
  );
  const sessionIds: string[] = [];
  for (const session of idle) {
    const out = await endSession(session.id, 'idle', {
      workspaceId: session.workspaceId,
      now,
      onlyIfIdleBefore: olderThan,
    });
    if (out.ended) sessionIds.push(session.id);
  }
  return { closed: sessionIds.length, sessionIds };
}

export const planSessionEndService = {
  closeIdleSessions,
  endSession,
  endSessionWithin,
  endSessionForFailedJob,
  endSessionForAbandonedPlan,
  settleFailedJob,
  releaseUnresumableAttempt,
  releaseRevisionForFailedJob,
  releaseLapsedRevision,
  releaseLapsedRevisions,
};
