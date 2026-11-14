import { Prisma, type PlanChangeMailboxEntry } from '@/generated/prisma/client';

import type { ProjectContext } from '@/lib/projects';
import { projectAccessService } from '@/lib/services/projectAccessService';

/**
 * The tenancy this service needs, and no more.
 *
 * ⚠️ IT IS NARROWER THAN `ProjectContext`, DELIBERATELY. That type carries a
 * `project: ProjectDTO` because it is the ACTIVE-project context a browser
 * request resolves. The READ DOOR has no browser and no active project: it is
 * authenticated by a job token, whose claims are exactly a user, a workspace and
 * a project ID. Requiring the DTO there would mean loading a project row to
 * satisfy a type, on the hottest path in this file — a read every phase boundary
 * of every planning run makes.
 *
 * A `ProjectContext` is assignable to it, so the session-authenticated door
 * passes its own context through unchanged.
 */
export type MailboxContext = Pick<ProjectContext, 'userId' | 'workspaceId' | 'projectId'>;
import { withWorkspaceContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { planChangeMailboxRepository } from '@/lib/repositories/planChangeMailboxRepository';
import { planRepository } from '@/lib/repositories/planRepository';
import { planStepRepository } from '@/lib/repositories/planStepRepository';
import { getJob } from '@/lib/ai/motirAiClient';
import type { MailboxDeliveryDto, SkipFinalCheckResultDto } from '@/lib/dto/planChangeMailbox';
import {
  EmptyPlanChangeTurnError,
  PlanChangeJobNotRunningError,
  PlanChangeMailboxJobMismatchError,
  PlanChangeSessionNotFoundError,
  PlanChangeTurnConflictError,
  PlanSessionNotFoundError,
} from '@/lib/planChange/errors';

// THE BOUNDARY MAILBOX (Story MOTIR-4054 · MOTIR-4067) — the pipe between a user
// who is still typing and a planning job that has already read its envelope.
//
// WHAT THIS IS NOT: a way to interrupt a run mid-generation. A planning job reads
// `requestJson` once, at dispatch, and the obvious repair — deliver input as a
// signal — is the wrong one. This is STORAGE THE JOB CHECKS, never a mechanism
// that preempts it.
//
// ⚠️ WHAT IS DELIVERED AND WHEN CHANGED (MOTIR-7991, AMENDMENT 4 of
// `docs/decisions/conversation-turn-intent.md`). Not every mid-run turn lands
// here any more: an answering session reads each one first, a QUESTION is answered
// in the thread, and only a CHANGE (or a confirmed ambiguous turn) is forwarded
// through `attachTurn`. A forwarded change is read at a TOOL-CALL GAP, after a
// tool result and before the next model turn, by every running walk session, and
// handed to every session opened later; it is no longer held until a phase
// boundary. The planner rules it (a correction, a re-plan, or unclear about WHAT)
// and, on a re-plan, OFFERS the person START OVER; the `restart` disposition
// itself is unchanged. The phase-boundary read stays the carrier for STOP and for
// START OVER. The answer to a planner's question comes back as an ordinary turn and
// is ruled again.
//
// ⚠️ THE READ SHAPE IS A TWO-REPO CONTRACT AND THE CONSUMER LANDED FIRST.
// `motir-ai` `src/llm/mailbox.ts` (MOTIR-4060, merged) already accepts
// `{ turns: [{ id, text, receivedAt, disposition, target }], stopped }`, and its
// parse is TOTAL: an unreadable body, a 404, a core that predates the contract —
// all read as an empty mailbox rather than failing a run. This side matches that
// shape rather than designing a second one and reconciling later, and
// {@link toDelivery} is the single place it is built.
//
// 4-layer + concurrency (CLAUDE.md): this service owns the transactions and the
// DTO mapping; the repository is single-op leaves. Appending is READ-DERIVED —
// the next `seq` comes from the job's own top row — so every append locks the
// SESSION row (`SELECT … FOR UPDATE`) and re-reads inside the transaction (the
// lock-before-read-derived-update rule); `(session_id, job_id, seq)` is the DB
// backstop, translated from P2002 to a typed conflict so no raw Prisma error
// escapes.
//
// ⚠️ THE SESSION ROW IS THE LOCK, not a mailbox row, and it is the SAME lock
// `planChangeSessionsService`'s turn appends take. That is deliberate: the two
// writers serialize against each other, which costs nothing (both are short
// writes on one thread) and removes the question of whether a mailbox append can
// interleave with a transcript append. It does not; there is one lock per
// conversation.
//
// THE PLANNER'S MID-RUN PAUSE (MOTIR-8007) answers through this same pipe: a START
// OVER is the `restart` turn, a decline or a reply is a `fold` turn marked
// `declines_pause_id` / `answers_pause_id` — see `planChangeRunPauseService`.
//
// SIDE-EFFECTS-OUTSIDE-TX (CLAUDE.md): the RUNNING check calls motir-ai over the
// network. It happens BEFORE the short transaction that writes the row — a
// conversation row is never locked across a motir-ai round-trip.

/**
 * The `JobStatus` values that still have a phase boundary ahead of them.
 * `queued` counts: the job has not started, so every boundary is ahead of it.
 * Everything else — `succeeded`, `failed`, `canceled` — is terminal, and a turn
 * addressed there would sit unread for ever.
 */
const RUNNING_STATUSES: ReadonlySet<string> = new Set(['queued', 'running']);

export interface AttachTurnInput {
  /** The run this turn is addressed at. Must be the thread's current run. */
  jobId: string;
  /** The SESSION the caller believes is running this job (MOTIR-6023;
   *  AMENDMENT 17 §2). When given it must exist in this project and must BE the
   *  job's thread — a message never lands on a sibling session of the scope. */
  sessionId?: string;
  /** What the user typed. */
  body: string;
  /**
   * The caller's own stable key for this delivery — what makes a retry a no-op.
   * The client supplies it (a request id, the composer's draft id); the server
   * does not invent one, because a server-invented key cannot recognise the
   * SAME submit arriving twice.
   */
  idempotencyKey: string;
  /** `fold` (default) or `restart`. */
  disposition?: 'fold' | 'restart';
  /** Where a `restart` re-anchors the walk. Ignored on a `fold`. */
  restartTarget?: string | null;
  /** The run pause this `fold` turn DECLINES (MOTIR-8007). At most one of the two. */
  declinesPauseId?: string;
  /** The run pause this `fold` turn ANSWERS (MOTIR-8007). */
  answersPauseId?: string;
}

/** Build the two-repo contract's shape from rows. The ONE place it is built. */
function toDelivery(
  entries: readonly PlanChangeMailboxEntry[],
  flags: { stopped: boolean; skipFinalCheck: boolean },
): MailboxDeliveryDto {
  return {
    // Already `seq`-ordered by the repository. The array IS the order claim:
    // `readDelivery` sorts on `receivedAt` and breaks ties on array index, so
    // two entries written in the same millisecond still arrive in the order they
    // were typed.
    turns: entries
      .filter((e) => e.kind === 'turn')
      .map((e) => ({
        id: e.id,
        text: e.body ?? '',
        receivedAt: e.createdAt.toISOString(),
        disposition: e.disposition ?? 'fold',
        target: e.restartTarget,
        // Present ONLY when set (MOTIR-8007), so every other turn's shape is byte-identical.
        ...(e.declinesPauseId ? { declinesPause: e.declinesPauseId } : {}),
        ...(e.answersPauseId ? { answersQuestion: e.answersPauseId } : {}),
      })),
    stopped: flags.stopped,
    skipFinalCheck: flags.skipFinalCheck,
  };
}

/** The two flags a delivery derives from an entry EXISTING, read in one place. */
async function readFlags(
  sessionId: string,
  jobId: string,
  workspaceId: string,
  tx: Prisma.TransactionClient,
): Promise<{ stopped: boolean; skipFinalCheck: boolean }> {
  const stopped = await planChangeMailboxRepository.hasStop(sessionId, jobId, workspaceId, tx);
  const skipFinalCheck = await planChangeMailboxRepository.hasSkipFinalCheck(
    sessionId,
    jobId,
    workspaceId,
    tx,
  );
  return { stopped, skipFinalCheck };
}

/** An empty mailbox: nothing waiting, nothing stopped, nothing skipped. */
function emptyDelivery(): MailboxDeliveryDto {
  return { turns: [], stopped: false, skipFinalCheck: false };
}

/**
 * Is the final check of the plan this job is writing RUNNING now (MOTIR-11266)?
 *
 * The plan the job writes into is the one whose `sourceJobId` is the job; it is
 * running a check while it is `generating` and holds a live `check` step. A live
 * `repair` step means the check has ended and its fix has begun, which a skip no
 * longer reaches (design § "Skip the final check", When). Bound, because
 * `plan_step`'s policy joins to `plan` and an unbound read is an empty set.
 */
async function finalCheckRunning(jobId: string, pctx: MailboxContext): Promise<boolean> {
  return withWorkspaceServiceContext(pctx.workspaceId, async (tx) => {
    const plan = await planRepository.findBySourceJobId(jobId, pctx.workspaceId, tx);
    if (!plan || plan.projectId !== pctx.projectId || plan.status !== 'generating') return false;
    const steps = await planStepRepository.listByPlan(plan.id, tx);
    return steps.some((s) => s.kind === 'check') && !steps.some((s) => s.kind === 'repair');
  });
}

/**
 * Allocate `seq` and write ONE entry, under the session's row lock.
 *
 * Shared by the turn append and the stop so BOTH allocate the same safe way — a
 * second allocation route for the stop would quietly reintroduce exactly the
 * ordering the one-pipe rule exists to guarantee.
 *
 * `idempotencyKey` is checked INSIDE the lock and returns the existing row on a
 * hit. Checked outside, two concurrent replays would both see "not there yet"
 * and both insert, and only the unique index would stop them — which turns a
 * correct retry into a 409.
 */
async function appendLocked(
  sessionId: string,
  pctx: MailboxContext,
  entry: {
    jobId: string;
    kind: 'turn' | 'stop' | 'skip_final_check';
    body?: string | null;
    disposition?: 'fold' | 'restart' | null;
    restartTarget?: string | null;
    idempotencyKey: string;
    authorId?: string | null;
    declinesPauseId?: string | null;
    answersPauseId?: string | null;
  },
): Promise<PlanChangeMailboxEntry> {
  return withWorkspaceContext(
    { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
    async (tx) => {
      const locked = await planChangeSessionRepository.lockById(sessionId, tx);
      if (!locked) throw new PlanChangeSessionNotFoundError(pctx.projectId);

      const existing = await planChangeMailboxRepository.findByIdempotencyKey(
        sessionId,
        entry.jobId,
        entry.idempotencyKey,
        pctx.workspaceId,
        tx,
      );
      if (existing) return existing;

      const seq = await planChangeMailboxRepository.nextSeq(
        sessionId,
        entry.jobId,
        pctx.workspaceId,
        tx,
      );
      try {
        return await planChangeMailboxRepository.create(
          {
            workspaceId: pctx.workspaceId,
            sessionId,
            jobId: entry.jobId,
            seq,
            kind: entry.kind,
            body: entry.body ?? null,
            disposition: entry.disposition ?? null,
            restartTarget: entry.restartTarget ?? null,
            idempotencyKey: entry.idempotencyKey,
            authorId: entry.authorId ?? null,
            declinesPauseId: entry.declinesPauseId ?? null,
            answersPauseId: entry.answersPauseId ?? null,
          },
          tx,
        );
      } catch (err) {
        // The `(session_id, job_id, seq)` unique fired: some writer claimed this
        // position without holding the lock. Surface the typed conflict — a raw
        // P2002 never escapes the service.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new PlanChangeTurnConflictError(sessionId, seq);
        }
        throw err;
      }
    },
  );
}

/**
 * The thread that is RUNNING this job, by the job — or null.
 *
 * ⚠️ THE JOB IS NOT A FREE PARAMETER. The mailbox is keyed by `(session, job)`,
 * and `job_id` is an opaque motir-ai token; without this the caller could write
 * an entry under their own session addressed at a run that is not theirs — read
 * by nobody, but existing. Resolving the session BY `last_job_id` makes the
 * address DERIVABLE from the tree rather than asserted by the request, so there
 * is no unbound `jobId` anywhere in this service.
 *
 * It also answers for the right thread when a project has several: a contextual
 * conversation and the project-wide one are different rows, and the mailbox
 * belongs to whichever of them SUBMITTED this job. A session Motir opened for
 * its own job (the auto-plan cadence, an expand, a generation) records that job
 * as its `last_job_id` when it is created (`plansService`'s
 * `attachPlanSessionWithin`, Bug MOTIR-10431), so its run is addressed here
 * exactly as a conversation's is.
 *
 * ⚠️ IT STAYS KEYED BY `last_job_id`, and NOT by `Plan.sessionId`, on purpose
 * (MOTIR-6021; AMENDMENT 17 §5, §7). The mailbox addresses a RUNNING job, and a
 * job belongs to exactly the session that submitted it — which is what
 * `last_job_id` records while the run is live. Several sessions of one scope
 * (§2) do not change that: each has its own `last_job_id`, so two sessions can
 * never both answer for one job. Going through `Plan.sessionId` would ask a
 * different question — which conversation a PLAN belongs to — and a mid-run
 * message is addressed to a run, not to a plan.
 */
export async function findThreadForJob(jobId: string, pctx: MailboxContext) {
  return withWorkspaceServiceContext(pctx.workspaceId, (tx) =>
    planChangeSessionRepository.findByProjectAndLastJobId(
      pctx.projectId,
      jobId,
      pctx.workspaceId,
      tx,
    ),
  );
}

/**
 * …and the same read as a REQUIREMENT, for the two write doors.
 *
 * One error for both "no such thread" and "that is not the run this thread is
 * on", deliberately: from the caller's side they are the same fact, and telling
 * them apart would answer a question about somebody else's job. It is the
 * no-existence-leak posture the rest of `lib/planChange/errors.ts` takes.
 */
export async function requireThreadForJob(
  jobId: string,
  pctx: MailboxContext,
  expectedSessionId?: string,
): Promise<{ sessionId: string }> {
  // The ADDRESSED session first (MOTIR-6023): an id from another project is
  // `PLAN_SESSION_NOT_FOUND`, the same answer every session door gives it.
  if (expectedSessionId !== undefined) {
    const addressed = await withWorkspaceServiceContext(pctx.workspaceId, (tx) =>
      planChangeSessionRepository.findByIdInProject(
        expectedSessionId,
        pctx.projectId,
        pctx.workspaceId,
        tx,
      ),
    );
    if (!addressed) throw new PlanSessionNotFoundError(expectedSessionId);
  }
  const session = await findThreadForJob(jobId, pctx);
  if (!session) throw new PlanChangeMailboxJobMismatchError(jobId);
  // The job is running on a DIFFERENT session of this project — from the
  // caller's side that job is not on their conversation.
  if (expectedSessionId !== undefined && session.id !== expectedSessionId) {
    throw new PlanChangeMailboxJobMismatchError(jobId);
  }
  return { sessionId: session.id };
}

export const planChangeMailboxService = {
  /**
   * Attach ONE turn to the RUNNING job of this project's conversation.
   *
   * The order of the three gates is a contract rather than a detail:
   *
   *  1. the thread must exist and must be ON this job (a 404 — no existence leak);
   *  2. the body must be non-blank (a 400 — nothing to deliver);
   *  3. the job must still be RUNNING (a 409, and the network call, so it is the
   *     LAST thing tried and never paid for by a request that was going to fail
   *     anyway).
   *
   * Only then does the short locked write happen.
   */
  async attachTurn(input: AttachTurnInput, pctx: MailboxContext): Promise<MailboxDeliveryDto> {
    const body = input.body.trim();
    // The same gate every plan-change door carries (`planChangeSessionsService`):
    // steering or ending a run is a plan-change WRITE, and `ai:plan` is the
    // decided policy for it (docs/decisions/permission-inventory.md R5).
    await projectAccessService.assertPermission(pctx.projectId, pctx, 'ai:plan');
    const { sessionId } = await requireThreadForJob(input.jobId, pctx, input.sessionId);
    if (!body) throw new EmptyPlanChangeTurnError();

    // ⚠️ OUTSIDE the transaction, deliberately (side-effects-outside-tx): this
    // is a motir-ai round-trip, and a conversation row is never locked across
    // one.
    const job = await getJob(input.jobId, pctx.projectId);
    if (!RUNNING_STATUSES.has(job.status)) {
      throw new PlanChangeJobNotRunningError(input.jobId, job.status);
    }

    const entry = await appendLocked(sessionId, pctx, {
      jobId: input.jobId,
      kind: 'turn',
      body,
      disposition: input.disposition ?? 'fold',
      restartTarget: input.disposition === 'restart' ? (input.restartTarget ?? null) : null,
      idempotencyKey: input.idempotencyKey,
      authorId: pctx.userId,
      declinesPauseId: input.declinesPauseId ?? null,
      answersPauseId: input.answersPauseId ?? null,
    });

    // The caller gets the mailbox AS IT NOW STANDS, not just the row it wrote —
    // which is what lets the composer show "two queued" without a second read,
    // and what makes a retry's answer identical to the original's.
    return planChangeMailboxService.peek(input.jobId, entry.sessionId, pctx);
  },

  /**
   * The id of the entry a delivery was written as, by the caller's own idempotency
   * key (MOTIR-7996) — or null. {@link attachTurn} answers with the mailbox as it
   * stands, which does not say WHICH entry was this call's, so a caller that must
   * record "this turn went down the pipe as entry X" (the ask settle's forwarded
   * marker) reads it back by the key it supplied. A read; it writes nothing.
   */
  async entryIdForKey(
    jobId: string,
    sessionId: string,
    idempotencyKey: string,
    pctx: MailboxContext,
  ): Promise<string | null> {
    return withWorkspaceServiceContext(pctx.workspaceId, async (tx) => {
      const entry = await planChangeMailboxRepository.findByIdempotencyKey(
        sessionId,
        jobId,
        idempotencyKey,
        pctx.workspaceId,
        tx,
      );
      return entry?.id ?? null;
    });
  },

  /**
   * RAISE THE STOP — the same pipe, taking the other kind.
   *
   * ⚠️ SCOPE. This is the pipe's write, and it is all of it: what a stop does to
   * the JOB's terminal state, to the plan, and to the surface is MOTIR-4068's,
   * and there is deliberately no route here for it. What this owns is that a
   * stop and a turn typed before it share one ordered sequence, so neither can
   * overtake the other — which is only true because they are one table with one
   * `seq`, and would stop being true the moment a stop got a channel of its own.
   *
   * ⚠️ AND MARKING THE JOB STOPPED IS NOT A STOP UNTIL THE WALK ASKS. The run
   * ends when `runWalk` reads this at its next phase boundary, which can be a
   * whole authoring session away. Nothing here shortens that interval, and the
   * surface must not claim it did.
   */
  async raiseStop(
    jobId: string,
    idempotencyKey: string,
    pctx: MailboxContext,
    expectedSessionId?: string,
  ): Promise<MailboxDeliveryDto> {
    // The same gate every plan-change door carries (`planChangeSessionsService`):
    // steering or ending a run is a plan-change WRITE, and `ai:plan` is the
    // decided policy for it (docs/decisions/permission-inventory.md R5).
    await projectAccessService.assertPermission(pctx.projectId, pctx, 'ai:plan');
    const { sessionId } = await requireThreadForJob(jobId, pctx, expectedSessionId);
    // No RUNNING check: stopping an already-finished run is a NO-OP that answers
    // cleanly, not an error. The control is reachable in states where the click
    // is redundant — the run may settle between render and click — so it has to
    // be safe there, and an entry nobody reads is harmless where a refusal the
    // user cannot act on is not.
    const entry = await appendLocked(sessionId, pctx, {
      jobId,
      kind: 'stop',
      idempotencyKey,
      authorId: pctx.userId,
    });
    return planChangeMailboxService.peek(jobId, entry.sessionId, pctx);
  },

  /**
   * SKIP THE FINAL CHECK (MOTIR-11266) — the same pipe as the stop, taking its
   * own kind, so it ends only the final check and never the plan.
   *
   * ⚠️ NOT AN ERROR PATH, as the stop is not. The control is reachable after the
   * check has ended (the job reached its fix, or proposed, between render and
   * press), and that answers `not_running` with nothing written — the surface
   * says the check had already finished. A key already written answers
   * `skipped` again with nothing new, whatever the check is doing now, so a
   * retried press reads as the press it repeats.
   *
   * The order: the permission, the thread (a 404 for a job not on it), the key,
   * then the running check — the last two outside any lock, because the running
   * read is a plan read the append does not depend on, and the append re-checks
   * the key inside its lock.
   */
  async raiseSkipFinalCheck(
    jobId: string,
    idempotencyKey: string,
    pctx: MailboxContext,
    expectedSessionId?: string,
  ): Promise<SkipFinalCheckResultDto> {
    await projectAccessService.assertPermission(pctx.projectId, pctx, 'ai:plan');
    const { sessionId } = await requireThreadForJob(jobId, pctx, expectedSessionId);
    const already = await planChangeMailboxService.entryIdForKey(
      jobId,
      sessionId,
      idempotencyKey,
      pctx,
    );
    if (!already && !(await finalCheckRunning(jobId, pctx))) {
      const mailbox = await planChangeMailboxService.peek(jobId, sessionId, pctx);
      return { outcome: 'not_running', mailbox };
    }
    const entry = await appendLocked(sessionId, pctx, {
      jobId,
      kind: 'skip_final_check',
      idempotencyKey,
      authorId: pctx.userId,
    });
    const mailbox = await planChangeMailboxService.peek(jobId, entry.sessionId, pctx);
    return { outcome: 'skipped', mailbox };
  },

  /**
   * What is waiting for a JOB, without consuming it — {@link peek} addressed by
   * the job rather than by the session (Story MOTIR-4054 · MOTIR-4274).
   *
   * ⚠️ WHY A CLIENT NEEDS THIS AT ALL, stated here because it is a fact about the
   * OTHER repo and is invisible from this one. `motir-ai` emits NO stream frame
   * when a boundary consumes a turn: the ids land in `MailboxReport.consumed`,
   * and that report is not in the job result the handler returns
   * (`{ planDelta, summary }`). So a surface that has queued a turn has no way to
   * learn it was read except by asking what is still waiting — a turn that has
   * left the pending set is a turn the run took.
   *
   * A frame would be better and is a `motir-ai` card, not this one. If one ever
   * lands, this door stops being the composer's only answer and it can go.
   */
  async peekForJob(
    jobId: string,
    pctx: MailboxContext,
    expectedSessionId?: string,
  ): Promise<MailboxDeliveryDto> {
    // The same gate every plan-change door carries (`planChangeSessionsService`):
    // steering or ending a run is a plan-change WRITE, and `ai:plan` is the
    // decided policy for it (docs/decisions/permission-inventory.md R5).
    await projectAccessService.assertPermission(pctx.projectId, pctx, 'ai:plan');
    if (expectedSessionId !== undefined) {
      const { sessionId } = await requireThreadForJob(jobId, pctx, expectedSessionId);
      return planChangeMailboxService.peek(jobId, sessionId, pctx);
    }
    const session = await findThreadForJob(jobId, pctx);
    // Same reading as the boundary read: no thread for this job means nothing is
    // waiting, which is true, and is not an error.
    if (!session) return emptyDelivery();
    return planChangeMailboxService.peek(jobId, session.id, pctx);
  },

  /**
   * What is waiting, WITHOUT consuming it — the read the composer makes to show
   * its own queued state.
   *
   * Separate from {@link readForBoundary} on purpose: a surface asking "what did
   * I queue?" must not claim the delivery the run has not read yet. The two
   * differ in exactly one thing, and it is the one that matters.
   */
  async peek(jobId: string, sessionId: string, pctx: MailboxContext): Promise<MailboxDeliveryDto> {
    return withWorkspaceServiceContext(pctx.workspaceId, async (tx) => {
      const pending = await planChangeMailboxRepository.listPending(
        sessionId,
        jobId,
        pctx.workspaceId,
        tx,
      );
      return toDelivery(pending, await readFlags(sessionId, jobId, pctx.workspaceId, tx));
    });
  },

  /**
   * ONE BOUNDARY CHECK — what `motir-ai` reads, and the read that CONSUMES.
   *
   * Everything it returns is stamped `consumed_at` in the SAME transaction, so a
   * turn read at one boundary is not read again at the next. That is at-MOST-once
   * delivery and it is the deliberate half of a trade: the alternative leaves a
   * turn unclaimed until the run acknowledges it, and a run that dies mid-fold
   * would then re-fold the same sentence into the next run's session. The
   * consumer is idempotent on `id` as well (`consumedTurnIds` in
   * `treeGeneration.ts`), so the two guards compose — this one survives a job
   * retry, which the in-process set does not.
   *
   * ⚠️ THE STOP IS NOT CONSUMED. It is derived from EXISTENCE, so every boundary
   * after the first still reads `stopped: true` — a run that has been ended stays
   * ended, and a consumed stop would silently un-stop the next check.
   *
   * ⚠️ AND AN EMPTY MAILBOX IS AN ANSWER, NOT A FAILURE. This returns
   * `{ turns: [], stopped: false, skipFinalCheck: false }` and a 200; the caller's *"could not tell"* is
   * a transport error or a non-2xx, which `readDelivery` reads as empty anyway.
   * The two are distinguishable at the wire, which is what the card asks for:
   * only "nothing waiting" lets the run proceed on the strength of the answer.
   */
  async readForBoundary(jobId: string, pctx: MailboxContext): Promise<MailboxDeliveryDto> {
    const session = await findThreadForJob(jobId, pctx);
    // A job with no thread — deleted mid-flight, or a run this project never
    // submitted — has an EMPTY mailbox, which is true and is the reading
    // `readDelivery` would arrive at anyway. Not an error: a run whose thread
    // vanished must finish, not fail. ⚠️ And it is a 200 either way, because the
    // card's own criterion is that the run can tell "nothing waiting" from
    // "could not tell" — only the first lets it proceed on the answer, and a
    // failure shaped like an empty mailbox erases that distinction.
    if (!session) return emptyDelivery();

    return withWorkspaceContext(
      { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
      async (tx) => {
        // The lock serializes two boundary checks that race (a retried job, a
        // duplicated worker): the loser re-reads and finds the entries already
        // consumed rather than delivering them twice.
        const locked = await planChangeSessionRepository.lockById(session.id, tx);
        if (!locked) return emptyDelivery();

        const pending = await planChangeMailboxRepository.listPending(
          session.id,
          jobId,
          pctx.workspaceId,
          tx,
        );
        const flags = await readFlags(session.id, jobId, pctx.workspaceId, tx);
        await planChangeMailboxRepository.markConsumed(
          pending.map((e) => e.id),
          pctx.workspaceId,
          new Date(),
          tx,
        );
        return toDelivery(pending, flags);
      },
    );
  },
};
