import {
  Prisma,
  type PlanChangeTurn,
  type PlanChangeTurnIntent,
  type PlanChangeTurnRole,
} from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';

// Single Prisma operations on the `plan_change_turn` table (Story 7.30 ·
// MOTIR-1728). Its own repository, not a corner of the session's: the entity
// name wins over the call site (the 4-layer repository-naming rule). Writes
// require `tx`; the thread read takes an optional `tx` so an append can return
// the freshly-extended thread from inside its own transaction.
export const planChangeTurnRepository = {
  async create(
    data: Prisma.PlanChangeTurnUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeTurn> {
    return tx.planChangeTurn.create({ data });
  },

  /** The `assistant` turn a given job already produced on this session, if any —
   *  the IDEMPOTENCY read behind "one planning job, at most one planner turn"
   *  (MOTIR-2226). The client records the turn when its stream settles, and a
   *  reload, a second tab or a retried read all replay that call; keying on the
   *  job makes every replay a no-op instead of a duplicate bubble. Takes `tx`
   *  because it guards a write and must be read UNDER the session's row lock. */
  async findByJobIdAndRole(
    sessionId: string,
    jobId: string,
    role: PlanChangeTurnRole,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeTurn | null> {
    return tx.planChangeTurn.findFirst({ where: { sessionId, workspaceId, jobId, role } });
  },

  /** The conversation a job was submitted for, found by the job, within one project
   *  of the bound workspace (MOTIR-10235): the `user` turn ONE person sent, which the
   *  ASK door bound the job to. Null when no such turn carries the job yet. */
  async findSessionIdByJobForUser(
    jobId: string,
    scope: { projectId: string; workspaceId: string; userId: string },
    tx: Prisma.TransactionClient,
  ): Promise<{ sessionId: string } | null> {
    return tx.planChangeTurn.findFirst({
      where: {
        jobId,
        workspaceId: scope.workspaceId,
        role: 'user',
        authorId: scope.userId,
        session: { projectId: scope.projectId },
      },
      select: { sessionId: true },
    });
  },

  /** ONE turn of a session, by id — the read a CORRECTION makes before it re-runs
   *  a turn under the other intent (MOTIR-1818; ADR §3). Scoped by `sessionId`
   *  AND `workspaceId`, so a turn id from another thread — or another tenant —
   *  resolves to null rather than to somebody else's sentence. `tx` is required:
   *  every caller reads it to guard a following write. */
  /** One turn by id in this workspace (MOTIR-8691): the guide-seeded start reads the
   *  offer's turn BEFORE it knows the session, then re-reads it under that session's
   *  lock. Workspace-scoped, like every read here. */
  async findById(
    id: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeTurn | null> {
    return tx.planChangeTurn.findFirst({ where: { id, workspaceId } });
  },

  async findByIdInSession(
    id: string,
    sessionId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeTurn | null> {
    return tx.planChangeTurn.findFirst({ where: { id, sessionId, workspaceId } });
  },

  /** Patch ONE turn in place. Exactly five fields are ever updated — its INTENT,
   *  the flag recording a correction, the JOB that ran for it, the mailbox
   *  entry it was forwarded as (MOTIR-7996), and the revision job it became (MOTIR-7997) — and a turn's
   *  `body`, `seq` and `role` are immutable by design, because the thread is a
   *  record of who said what. Typed to those five rather than to the full update
   *  input so that immutability is a compile-time fact, not a convention.
   *  Requires `tx` (the write rule) — and it is called under the session's row
   *  lock, so a concurrent correction cannot interleave with an append.
   *
   *  ⚠️ `jobId` on a USER turn is MOTIR-1819's addition, and it widens what the
   *  column's own comment said ("Null on `user` turns"). Before the ask path a
   *  user turn produced no job of its own: submitting was a separate gesture that
   *  wrote a `system` marker. An ask submit IS the turn, so the turn is the
   *  natural key for its job — which is what makes the settle a single keyed,
   *  replayable lookup instead of "the most recent user turn", a guess that is
   *  wrong under exactly the concurrency the row lock exists for. */
  async updateIntent(
    id: string,
    data: {
      intent?: PlanChangeTurnIntent;
      intentCorrected?: boolean;
      jobId?: string;
      /** The mailbox entry a mid-run turn was forwarded as (MOTIR-7996). */
      forwardedEntryId?: string;
      /** The REVISE_PLAN job a mid-run turn became (MOTIR-7997). */
      revisedLateJobId?: string;
    },
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeTurn> {
    return tx.planChangeTurn.update({ where: { id }, data });
  },

  /** Rewrite ONE turn's `guide_turn` JSON (MOTIR-8689): the guide reply's record
   *  gains a decision about its re-plan offer after it was appended. Repository
   *  only — the rule (who may, in which state) lives in the service, which holds the
   *  session's row lock. `workspaceId` scopes the write. Requires `tx`. */
  async setGuideTurn(
    id: string,
    workspaceId: string,
    guideTurn: Prisma.InputJsonValue,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.planChangeTurn.updateMany({ where: { id, workspaceId }, data: { guideTurn } });
  },

  /** Rewrite ONE turn's `answer_offer` JSON (MOTIR-9288) — the one door an offer's
   *  disposition is written through, shape for shape {@link setGuideTurn}. Only that
   *  column changes. Repository only: the caller holds the session's row lock and
   *  owns the rule. `workspaceId` scopes the write. Requires `tx`. */
  async setAnswerOffer(
    id: string,
    workspaceId: string,
    answerOffer: Prisma.InputJsonValue,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.planChangeTurn.updateMany({ where: { id, workspaceId }, data: { answerOffer } });
  },

  /** CLAIM a landing's one write (MOTIR-7049; the `log_bug` offer's turn since
   *  MOTIR-9323): stamp `debugLandingClaimedAt` ONLY while it is still null — a
   *  compare-and-set in one statement. Returns whether THIS call claimed it. Called
   *  under the session's row lock, so two concurrent confirms of one offer are
   *  serialised and exactly one sees `true`. The fourth mutable field of a turn, and like the other three a
   *  record of what Motir DID, never of what the person said. */
  async claimDebugLanding(
    id: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const { count } = await tx.planChangeTurn.updateMany({
      where: { id, workspaceId, debugLandingClaimedAt: null },
      data: { debugLandingClaimedAt: new Date() },
    });
    return count === 1;
  },

  /** STAMP a landed `log_bug` offer (MOTIR-9323): the offer moved to confirmed and
   *  the landing recorded on the SAME turn, in one statement — so a reload never sees
   *  one without the other. The caller holds the session's row lock and the turn's
   *  landing claim. Requires `tx`. */
  async confirmDebugLanding(
    id: string,
    workspaceId: string,
    answerOffer: Prisma.InputJsonValue,
    debugLanding: Prisma.InputJsonValue,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.planChangeTurn.updateMany({
      where: { id, workspaceId },
      data: { answerOffer, debugLanding },
    });
  },

  /** CLAIM a `guide` turn's landing (MOTIR-7470): stamp `guideLandingClaimedAt`
   *  only when it is still null. `true` when THIS call took it. The caller holds
   *  the session's row lock, so two settles of one job serialise here. */
  async claimGuideLanding(
    id: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const { count } = await tx.planChangeTurn.updateMany({
      where: { id, workspaceId, guideLandingClaimedAt: null },
      data: { guideLandingClaimedAt: new Date() },
    });
    return count === 1;
  },

  /** RELEASE a claim whose write was refused inside its own transaction, so
   *  nothing committed and a later settle may try again (MOTIR-7049). */
  async releaseDebugLanding(
    id: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.planChangeTurn.updateMany({
      where: { id, workspaceId },
      data: { debugLandingClaimedAt: null },
    });
  },

  /** CLAIM a targeted turn's one plan start (MOTIR-9291): stamp `planStartClaimedAt`
   *  only while it is still null. `true` when THIS call took it. The caller holds the
   *  session's row lock, so two settles of one ask job serialise here. */
  async claimPlanStart(
    id: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const { count } = await tx.planChangeTurn.updateMany({
      where: { id, workspaceId, planStartClaimedAt: null },
      data: { planStartClaimedAt: new Date() },
    });
    return count === 1;
  },

  /** RELEASE a targeted turn's plan-start claim whose submit threw, so nothing was
   *  spent and a later settle may start it (MOTIR-9291). */
  async releasePlanStart(
    id: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.planChangeTurn.updateMany({
      where: { id, workspaceId },
      data: { planStartClaimedAt: null },
    });
  },

  /** CLAIM a plan offer's one start (MOTIR-9291): move the stored offer off pending by
   *  writing `confirmedAt` / `confirmedById`, ONLY while it is neither confirmed nor
   *  declined — a compare-and-set over the JSON in one statement, whose affected-row
   *  count is the claim. Every other key of the offer rides through. The caller holds
   *  the session's row lock and owns the rule of who may claim. */
  async claimAnswerOfferStart(
    id: string,
    workspaceId: string,
    confirmedById: string,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const at = new Date().toISOString();
    const count = await tx.$executeRaw`
      UPDATE "plan_change_turn"
         SET "answer_offer" = "answer_offer"
               || jsonb_build_object('confirmedAt', ${at}::text, 'confirmedById', ${confirmedById}::text)
       WHERE "id" = ${id}
         AND "workspace_id" = ${workspaceId}
         AND "answer_offer" IS NOT NULL
         AND ("answer_offer" ->> 'confirmedAt') IS NULL
         AND ("answer_offer" ->> 'declinedAt') IS NULL`;
    return count === 1;
  },

  /** RELEASE a plan offer's start claim back to pending, ONLY while no session was
   *  stamped on it — a start that succeeded is never given back (MOTIR-9291). */
  async releaseAnswerOfferStart(
    id: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE "plan_change_turn"
         SET "answer_offer" = "answer_offer"
               || jsonb_build_object('confirmedAt', NULL, 'confirmedById', NULL)
       WHERE "id" = ${id}
         AND "workspace_id" = ${workspaceId}
         AND "answer_offer" IS NOT NULL
         AND ("answer_offer" ->> 'confirmedSessionId') IS NULL`;
  },

  /** The thread's LATEST turn (highest `seq`), or null on an empty thread — the
   *  read that decides whether the Plan something new confirm is still PENDING
   *  (MOTIR-7649; ADR AMENDMENT 3, A3.2: pending while it is the latest turn).
   *  `tx` is required: every caller reads it under the session's row lock to
   *  guard the append that follows. */
  async findLatestInSession(
    sessionId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeTurn | null> {
    return tx.planChangeTurn.findFirst({
      where: { sessionId, workspaceId },
      orderBy: { seq: 'desc' },
    });
  },

  /** The session's FULL thread in `seq` order — the ordering contract every
   *  consumer (the resume payload, the accumulated intent) depends on, applied
   *  here ONCE rather than at each call site. Workspace-scoped: a session id from
   *  another tenant yields an empty thread. */
  async listBySessionId(
    sessionId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<PlanChangeTurn[]> {
    const client = tx ?? dbRead;
    return client.planChangeTurn.findMany({
      where: { sessionId, workspaceId },
      orderBy: { seq: 'asc' },
    });
  },
};
