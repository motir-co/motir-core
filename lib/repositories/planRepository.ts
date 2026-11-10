import { escapeLikePattern } from './escapeLikePattern';
import { Prisma, type Plan, type PlanStatus } from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';
import {
  FAILED_WAITING_WHERE,
  UNDECIDED_PLAN_STATUSES,
} from '@/lib/planChange/sessionWaitingState';

/** A plan the abandoned-plan sweep may act on — every `generating` plan past the
 *  grace, carrying the proposal COUNT read in the same statement.
 *
 *  The count is what the sweep's write re-reads against (MOTIR-3189). It used to
 *  be able to assert `0` from the predicate alone; now that a PARTIAL plan is a
 *  candidate, "did the row move under us?" is a comparison rather than a
 *  presence test, and the number has to travel with the candidate to make it.
 *
 *  ⚠️ `sourceJobId` IS NULLABLE HERE, and that is the point (MOTIR-3236). This
 *  type used to narrow it to `string`, restating the predicate's
 *  `sourceJobId: { not: null }` in the type system. The predicate is gone, so
 *  the narrowing is REMOVED rather than weakened: the compiler is what forces
 *  the caller to decide what a plan with no producer means, instead of letting a
 *  `null` reach `resolveJobState` as a job id. */
export type AbandonedPlanCandidate = Plan & {
  _count: { items: number };
};

/**
 * The `Plan` update shape, NAMED BY THE OWNING REPOSITORY (MOTIR-4296).
 * Callers above this layer build their write payload against this alias;
 * `Prisma.PlanUncheckedUpdateInput` itself is named only here. Mirrors
 * `planItemRepository`'s `PlanItemUpdateInput` exactly.
 */
export type PlanUpdateInput = Prisma.PlanUncheckedUpdateInput;

/**
 * WHO a plans-being-written read is for (Story MOTIR-7820 · MOTIR-7828): the
 * reader, their workspace, and the project scope `resolveActiveProjectScope`
 * resolved (empty when they may not browse the active project).
 */
export interface GeneratingRequestedByScope {
  workspaceId: string;
  projectIds: readonly string[];
  userId: string;
}

/**
 * The PROJECT scope a revision-hold read covers (Bug MOTIR-7988) — the workspace,
 * the project ids, and, when the read is one requester's, that requester.
 */
export interface RevisionHoldScope {
  workspaceId: string;
  projectIds: readonly string[];
  createdById?: string;
}

/**
 * THE ONE MEMBERSHIP PREDICATE of the Workbench's Planning tab — the plans this
 * reader ASKED FOR that are still being written. Both
 * {@link planRepository.listGeneratingRequestedBy} (the rows) and
 * {@link planRepository.countGeneratingRequestedBy} (the strip's badge) read it,
 * so the badge and the list are one question and cannot disagree — the rule
 * `approvalGateRepository.awaitingRoutedToWhere` states for the approvals tab.
 *
 *   - `workspaceId` is explicit because RLS is inert under the dev/CI superuser;
 *   - `createdById = userId` excludes a cadence plan by construction (its
 *     requester is null) and a teammate's plan alike — no `origin` test needed;
 *   - `status = 'generating'`. A plan a revision is rewriting is in the set by
 *     that test alone: the revision RE-OPENS it (`planned` → `generating`, Bug
 *     MOTIR-8208) and closes it again when it ends, so the status says what the
 *     listing used to have to be told (MOTIR-7988's `revisingPlanIds`, retired).
 *     A plan proposed, declined or failed has left the set on the next read.
 *
 * Served by `@@index([projectId, status, createdAt])` — `generating` is a small
 * tail and `createdById` filters inside it, so no new index is added.
 */
function generatingRequestedByWhere(scope: GeneratingRequestedByScope): Prisma.PlanWhereInput {
  return {
    workspaceId: scope.workspaceId,
    projectId: { in: [...scope.projectIds] },
    createdById: scope.userId,
    status: 'generating',
    // A plan whose SESSION is failed and waiting to resume is NOT being written (MOTIR-7914):
    // the failure path leaves it `generating` on purpose, and without this carve-out it would
    // sit here and turn *stalled* — a claim that is false, because it waits for the person to
    // press Resume. It lives on To resume instead. The definition is imported, never re-spelled
    // (`lib/planChange/sessionWaitingState.ts`); a plan with NO session (an MCP plan) and a plan
    // whose session is open and not failed both stay in the set.
    NOT: { session: { is: { ...FAILED_WAITING_WHERE } } },
  };
}

/** What the Planning tab's row reads about one plan — one `findMany`, no N+1. */
const GENERATING_PLAN_SELECT = {
  id: true,
  projectId: true,
  status: true,
  title: true,
  origin: true,
  authorSource: true,
  authorHarness: true,
  authorModel: true,
  sessionId: true,
  createdAt: true,
  lastActivityAt: true,
  session: { select: { targetKeys: true } },
  project: { select: { name: true } },
} satisfies Prisma.PlanSelect;

/** One row of {@link planRepository.listGeneratingRequestedBy}, NAMED BY THIS
 *  REPOSITORY so no `Prisma.*GetPayload` crosses the layer (MOTIR-4296). */
export type GeneratingPlanRow = Prisma.PlanGetPayload<{ select: typeof GENERATING_PLAN_SELECT }>;

// Plan repository — single Prisma operations on the `plan` table (Story 7.21 ·
// MOTIR-1336). Writes require `tx` (a compile-time guarantee they run in a
// transaction); pure read paths use the `db` singleton. No business logic, no
// transactions, no DTO mapping — those belong in `plansService`.
export const planRepository = {
  /** A plan by id, scoped to its workspace. Read-only; optional `tx` joins a
   *  surrounding transaction (e.g. the locked re-read inside approve/decline). */
  async findById(
    id: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Plan | null> {
    const client = tx ?? dbRead;
    return client.plan.findFirst({ where: { id, workspaceId } });
  },

  /**
   * The plan a generation job is producing into, resolved by its `sourceJobId`
   * (the generate seam sets `sourceJobId = jobId` at `createPlan`). Scoped to
   * the workspace so a job token for one tenant can never reach another's plan
   * — a cross-tenant lookup returns `null` (→ 404, never 403). Newest-first so a
   * re-submitted job resolves to its latest plan. Read-only.
   */
  /** A session's LATEST plan row — the pending-plan read (AMENDMENT 17 §5). */
  async findLatestBySession(sessionId: string, tx: Prisma.TransactionClient): Promise<Plan | null> {
    return tx.plan.findFirst({
      where: { sessionId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  },

  /** How many of a session's plans are UNDECIDED (`generating` / `planned` /
   *  `stale`) — the idle close's guard, re-read under the session's lock
   *  (AMENDMENT 23 §2). */
  async countUndecidedBySession(sessionId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.plan.count({
      where: { sessionId, status: { in: [...UNDECIDED_PLAN_STATUSES] } },
    });
  },

  /** How many of a session's plans WAIT FOR A DECISION (`planned` / `stale`), leaving one
   *  out — the end arms' guard (MOTIR-7936): a session holding a plan a person is yet to
   *  decide is never ended by a failure beside it. `excludePlanId` is the plan being
   *  declined, so it never counts itself. */
  async countAwaitingDecisionBySession(
    sessionId: string,
    excludePlanId: string | null,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.plan.count({
      where: {
        sessionId,
        status: { in: ['planned', 'stale'] },
        ...(excludePlanId ? { id: { not: excludePlanId } } : {}),
      },
    });
  },

  /** How many of a session's `generating` plans have WRITTEN at or after `activeSince` —
   *  the lock sweep's live-walk guard (MOTIR-9260). The caller passes
   *  `now - PLAN_STALLED_AFTER_MS`, so a plan counts exactly while the abandoned-plan
   *  sweep's silence rule would keep it (equal is not stalled). */
  async countWritingBySession(
    sessionId: string,
    activeSince: Date,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.plan.count({
      where: { sessionId, status: 'generating', lastActivityAt: { gte: activeSince } },
    });
  },

  /**
   * `planned` / `stale` plans — and `generating` ones, which a revision may have
   * RE-OPENED (Bug MOTIR-8208; the service tells the two apart from the trail) — whose
   * revision lease is HELD BY A JOB THAT STARTED BEFORE
   * `olderThan` and never ended: the latest `revision_started` row has no later
   * `revision_ended`. The sweep's backstop for a revision whose failure no relay saw
   * (MOTIR-7936). Cross-workspace — runs under the system context against the plan and
   * plan_revision system-read policies.
   */
  async listStaleRevisionCandidates(
    olderThan: Date,
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<
    Array<{
      id: string;
      workspaceId: string;
      projectId: string;
      sessionId: string | null;
      sourceJobId: string | null;
      status: string;
      leaseStartedAt: Date;
    }>
  > {
    return tx.$queryRaw`
      SELECT p."id", p."workspace_id" AS "workspaceId", p."project_id" AS "projectId",
             p."session_id" AS "sessionId", p."source_job_id" AS "sourceJobId",
             p."status"::text AS "status",
             (SELECT max(r."changed_at") FROM "plan_revision" r
               WHERE r."plan_id" = p."id" AND r."change_kind" = 'revision_started') AS "leaseStartedAt"
      FROM "plan" p
      WHERE p."status" IN ('planned', 'stale', 'generating')
        AND EXISTS (
          SELECT 1 FROM "plan_revision" s
          WHERE s."plan_id" = p."id" AND s."change_kind" = 'revision_started'
            AND s."changed_at" <= ${olderThan}
            AND NOT EXISTS (
              SELECT 1 FROM "plan_revision" e
              WHERE e."plan_id" = p."id" AND e."change_kind" = 'revision_ended'
                AND (e."changed_at", e."id") > (s."changed_at", s."id")
            )
        )
      ORDER BY p."created_at" ASC, p."id" ASC
      LIMIT ${limit}
    `;
  },

  /**
   * `generating` plans with an OPEN revision (a `revision_started` with no later
   * `revision_ended`) whose trail has written nothing since `lapsedBefore` — the
   * candidates for a re-opening revision whose lease LAPSED (Bug MOTIR-8208). A
   * superset: a revision of a plan that was already `generating` is here too, and the
   * service's re-check under the plan lock (`revisionReopenedFrom`) leaves it alone.
   * Cross-workspace — runs under the system context against the plan and
   * plan_revision system-read policies.
   */
  async listLapsedRevisionCandidates(
    lapsedBefore: Date,
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<Array<{ id: string; workspaceId: string }>> {
    return tx.$queryRaw`
      SELECT p."id", p."workspace_id" AS "workspaceId"
      FROM "plan" p
      WHERE p."status" = 'generating'
        AND EXISTS (
          SELECT 1 FROM "plan_revision" s
          WHERE s."plan_id" = p."id" AND s."change_kind" = 'revision_started'
            AND NOT EXISTS (
              SELECT 1 FROM "plan_revision" e
              WHERE e."plan_id" = p."id" AND e."change_kind" = 'revision_ended'
                AND (e."changed_at", e."id") > (s."changed_at", s."id")
            )
        )
        AND NOT EXISTS (
          SELECT 1 FROM "plan_revision" r
          WHERE r."plan_id" = p."id" AND r."changed_at" > ${lapsedBefore}
        )
      ORDER BY p."created_at" ASC, p."id" ASC
      LIMIT ${limit}
    `;
  },

  /**
   * A session's LATEST plan with what a RESUME checks (MOTIR-7916): its id, status and the
   * job that wrote it. Read cheaply before a job is spent and again under the locks before
   * the bind.
   */
  async findLatestForResume(sessionId: string, tx: Prisma.TransactionClient) {
    return tx.plan.findFirst({
      where: { sessionId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, status: true, sourceJobId: true, projectId: true, createdById: true },
    });
  },

  /**
   * RE-POINT a `generating` plan at the job that now writes it (MOTIR-7916): the bind a resume
   * makes. ONE conditional `updateMany` on `status = 'generating'`, so a plan that was decided
   * or declined meanwhile is left alone and the caller learns it from the return. Also stamps
   * `lastActivityAt`, so the resumed plan does not read as stalled before its first signal.
   */
  async repointSourceJob(
    planId: string,
    jobId: string,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const result = await tx.plan.updateMany({
      where: { id: planId, status: 'generating' },
      data: { sourceJobId: jobId, lastActivityAt: new Date() },
    });
    return result.count > 0;
  },

  /**
   * The UNDECIDED plans of a PAGE of sessions in ONE read (MOTIR-7939) — what To resume names
   * a session's form and its waiting plan by, and the plan fields the progress read needs, so
   * naming a page costs no per-row query. Newest first within a session.
   */
  async listUndecidedBySessions(sessionIds: readonly string[], tx: Prisma.TransactionClient) {
    if (sessionIds.length === 0) return [];
    return tx.plan.findMany({
      where: { sessionId: { in: [...sessionIds] }, status: { in: [...UNDECIDED_PLAN_STATUSES] } },
      select: {
        id: true,
        sessionId: true,
        projectId: true,
        status: true,
        title: true,
        createdAt: true,
        lastActivityAt: true,
        authorSource: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  },

  /** Every UNDECIDED plan of a session with what a turn on a failed session classifies by
   *  (MOTIR-7938): its id, status, producing job and age. */
  async listUndecidedBySession(sessionId: string, tx: Prisma.TransactionClient) {
    return tx.plan.findMany({
      where: { sessionId, status: { in: [...UNDECIDED_PLAN_STATUSES] } },
      select: { id: true, status: true, title: true, sourceJobId: true, createdAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  },

  /** A session's most recent UNDECIDED plan (`generating` / `planned` / `stale`),
   *  or `null` — the plan a carry moves (Story MOTIR-7928 · MOTIR-7930). Not the
   *  LATEST plan: a session that ended `failed` can hold a declined attempt on
   *  top of an earlier plan that still waits. `tx` required: it guards the move. */
  async findLatestUndecidedBySession(
    sessionId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Plan | null> {
    return tx.plan.findFirst({
      where: { sessionId, status: { in: [...UNDECIDED_PLAN_STATUSES] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  },

  /** MOVE a plan to another session (MOTIR-7930) — one `update` of
   *  `Plan.sessionId`, nothing else. */
  async moveToSession(id: string, sessionId: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.plan.update({ where: { id }, data: { sessionId }, select: { id: true } });
  },

  /** The id of a session's LATEST plan — "is this plan the conversation's current
   *  one?" (AMENDMENT 17 §5), the question `lastJobId` used to answer only for
   *  the latest submit. `tx` required: it guards a following release. */
  async findLatestIdBySession(
    sessionId: string,
    tx: Prisma.TransactionClient,
  ): Promise<string | null> {
    const row = await tx.plan.findFirst({
      where: { sessionId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    return row?.id ?? null;
  },

  /** The CARD-ANCHORED read (AMENDMENT 17 §5): the latest plan of the most
   *  recently active session anchored at exactly this scope — the plan the
   *  v1 plan-approval route and the item page's pending-plan notice mean when
   *  they say "this card's plan". */
  async findLatestInScope(
    projectId: string,
    scopeKey: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Plan | null> {
    return tx.plan.findFirst({
      where: { projectId, workspaceId, session: { is: { scopeKey } } },
      orderBy: [{ session: { lastActivityAt: 'desc' } }, { createdAt: 'desc' }, { id: 'desc' }],
    });
  },

  async findBySourceJobId(
    sourceJobId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Plan | null> {
    const client = tx ?? dbRead;
    return client.plan.findFirst({
      where: { sourceJobId, workspaceId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  },

  /**
   * The project's UNDECIDED plan, if it has one — the read behind the
   * pending-proposal GATE (MOTIR-916). "Undecided" is `generating` (the engine
   * is still producing it), `planned` (it is sitting in the human review queue)
   * or `stale` (a reviewer is holding it and cannot approve it yet);
   * `approved` / `declined` are decided and do not gate anything.
   *
   * ⚠️ `stale` IS IN THE LIST, AND IT IS THE SECOND HALF OF AMENDMENT 9's OWN
   * WIDENING (MOTIR-4129). `PlanStatus`'s schema comment states the rule this
   * predicate has to follow: `stale` "is NOT terminal and NOT decided: the plan
   * is live and awaiting action", and it is reachable only from `planned` — so
   * a plan wearing it has BY CONSTRUCTION already reached a reviewer. Leaving it
   * out read that plan as decided, which fired a second expand beside a proposal
   * somebody was already holding: the exact saturation this gate exists to
   * prevent, and the MIRROR of MOTIR-3051 / MOTIR-3064 / MOTIR-3189, each of
   * which took a plan that gated when it should NOT have.
   *
   * AMENDMENT 9 argued the principle for the other consumer and stopped at the
   * one instance in front of it: "the guard's predicate was a proxy for *is this
   * plan still awaiting a decision?*, and adding a fifth status is what makes
   * the proxy and the intent come apart." `computePlanStaleness` widened;
   * this one was not named, and the enum-growth checklist (MOTIR-3574 AC 7)
   * enumerated DISPLAY surfaces only — a predicate keeps compiling and keeps
   * returning a plausible answer, so nothing went red.
   *
   * WHO started it is deliberately NOT part of the predicate: a user-clicked
   * expand saturates the reviewer exactly as much as a cadence-fired one, and a
   * second proposal against the same committed tree makes the first STALE
   * (`planStalenessService` warns but never blocks). So any undecided plan
   * pauses cadence for the project, whatever its `origin`.
   *
   * ⚠️ ONE SHAPE IS EXCLUDED, AND IT IS NOT A NARROWING OF THE ABOVE
   * (MOTIR-3051): a `generating` plan with **no producer and no proposals** is
   * not a decision anybody can make. Nothing is in it to review, and nothing is
   * on its way in either — so counting it as pending pauses the project's
   * cadence permanently, with no surface saying why (`autoPlanCadenceService`'s
   * gate 1 is the only consumer, and MOTIR-1740's indicator reads the same
   * verdict).
   *
   * TWO shipped paths produce exactly that row. `create_plan` asserts
   * `work_item:edit` while its partner `add_plan_items` asserts `ai:view_plan`
   * (`docs/decisions/agent-authored-plans.md` Q2), so a grant holding the first
   * and not the second — `CLI_TOKEN_GRANT` — opens a plan and is refused on its
   * first append. And a motir-ai generation that DIES before its first append
   * leaves the same orphan: "a failed job leaves its plan at `generating`
   * forever (nothing writes a terminal plan state on failure)"
   * (`aiPlanEditsService.resolveJobState`). The second path holds whatever the
   * permission map says, which is why the exclusion lives here rather than at
   * the door.
   *
   * ⚠️ THE DISCRIMINATOR IS THE PRODUCER, NOT THE COUNT. Every generator submit
   * sets `sourceJobId` (`aiGenerationService.startGeneration`,
   * `aiPlanEditsService.submitPlanEditJob`) and every agent-authored plan leaves
   * it null (`lib/mcp/tools/authorPlan.ts`). Between a submit's `createPlan` and
   * motir-ai's first append the plan legitimately holds ZERO items — and
   * `autoPlanCadenceTick` is `retryPolicy: 'idempotent'` on precisely the ground
   * that "a project that already fired now HAS an undecided plan, so the gate
   * skips it on the re-run". A rule keyed on the count alone would let an
   * Inngest retry fire a second job at the same stub. So an empty plan with a
   * job still gates; only an empty plan with NO job does not.
   *
   * ⚠️ THAT IS THE RULE FOR `generating`. A `planned` plan holding NO items is
   * excluded too (MOTIR-4124), on the count alone and regardless of producer —
   * a closed plan can never gain one, so there is no window the count could
   * misread, and a plan proposing nothing is a decision nobody owes. The close
   * no longer writes that shape; the rows that predate it still exist.
   *
   * ⚠️ NEITHER EXCLUSION INTERACTS WITH `stale`, AND THAT IS STATED HERE RATHER
   * THAN RE-DERIVED AT EACH READING (MOTIR-4129). The MOTIR-3051 arm is about a
   * `generating` plan with no producer; `stale` is reachable only from
   * `planned`, so the two sets are disjoint by the transition table (AMENDMENT 9
   * D4) and the arm is untouched. The MOTIR-4124 arm needs no `stale` twin
   * either: both writers of the status — `planDriftService`'s listener and
   * `approvePlan`'s `PlanTargetImmutableError` backstop — are keyed on a
   * `modify` / `remove` PROPOSAL whose target went terminal, so a plan holding
   * zero proposals can never reach `stale` at all. An arm for it would guard a
   * row no shipped path can write.
   *
   * ⚠️ AND IT IS A WHERE CLAUSE, NOT A CALLER-SIDE FILTER. This returns ONE row,
   * newest first: dropping the orphan after the read would answer "not paused"
   * for a project whose real `planned` proposal sits one row down — trading a
   * permanent pause for the stacked proposal the gate exists to prevent.
   *
   * ⚠️ THE OTHER HALF — a plan whose PRODUCER died — is not reachable from here
   * and never was: that row carries a `sourceJobId`, so it is identical to a
   * healthy in-flight generation until somebody asks the job. It is reconciled
   * OUT of `generating` by `abandonedPlanService.reconcileAbandoned`
   * (MOTIR-3064, which took the empty ones; MOTIR-3189, which took the partial
   * ones too), so by the time this read sees it, it is `declined` and decided.
   * The predicate below is unchanged by BOTH fixes, deliberately: a gate that
   * guessed at liveness is the thing AMENDMENT 2 rejected, and widening the
   * sweep does not make guessing here any better an idea.
   *
   * Newest first, so the ONE row returned is the plan a caller would show. Takes
   * an optional `tx` because both consumers read it inside a workspace context
   * (correct under the non-bypass `motir_app` role, where the plan policy keys
   * on the per-transaction workspace GUC).
   */
  async findUndecidedByProject(
    projectId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Plan | null> {
    const client = tx ?? dbRead;
    return client.plan.findFirst({
      where: {
        projectId,
        workspaceId,
        status: { in: [...UNDECIDED_PLAN_STATUSES] },
        AND: [
          { NOT: { status: 'generating', sourceJobId: null, items: { none: {} } } },
          // ⚠️ A CLOSED plan holding NOTHING is nobody's decision either
          // (MOTIR-4124). `markPlanned` no longer produces this shape — an
          // empty close is DISCARDED — but rows written before that fix are
          // still `planned` with zero items, and each of them silences its
          // project's cadence for ever: nothing expires a `planned` plan, and
          // the abandoned sweep only reaches `generating` ones.
          //
          // ⚠️ AND THE COUNT IS SAFE HERE, WHERE THE PARAGRAPH ABOVE SAYS IT IS
          // NOT. That warning is about `generating`, where zero items is the
          // ordinary window between a submit's `createPlan` and the producer's
          // first append — which is why the discriminator there is the PRODUCER.
          // A `planned` plan is closed: it can never gain an item, so an empty
          // one is empty for good and there is no window to misread.
          { NOT: { status: 'planned', items: { none: {} } } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  },

  /**
   * Every `generating` plan, STALEST FIRST (`lastActivityAt` ascending, `id` breaking
   * a tie) — the abandoned-plan sweep's candidates (MOTIR-8132). Cross-workspace, so
   * it runs under `withSystemContext` against the plan policy's system-read arm.
   *
   * There is no age predicate any more: the sweep judges every candidate by its
   * silence (`now - lastActivityAt`) and a job's fast-path answer, and a plan inside
   * the threshold is still selected because a job that already ENDED is dead at once.
   * Stalest first means a backlog bigger than `limit` drains the plans most likely to
   * be dead before the ones still writing. The `(status, createdAt)` index serves the
   * `status = 'generating'` filter, and the generating set is small.
   *
   * The candidate carries `_count.items` (MOTIR-3189) so the sweep's write can refuse
   * on a MISMATCH — a proposal that arrived during the ask. It is also what makes an
   * RLS blind spot in this cross-workspace scan fail SAFE: a hidden proposal reads the
   * count low here, the write re-counts under the plan's own workspace, the two
   * disagree, and nothing is terminated.
   */
  async listAbandonedCandidates(
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<AbandonedPlanCandidate[]> {
    // ⚠️ NO `sourceJobId` PREDICATE (MOTIR-3236). This clause used to read
    // `sourceJobId: { not: null }`: the predicate had become a WHITELIST of the plan
    // shapes the sweep knew how to judge. SELECTION is the cheap, total question —
    // is it `generating`? — and the JUDGEMENT is `classifyAbandonedCandidate`, a pure
    // decision table with a unit test per arm.
    return tx.plan.findMany({
      where: { status: 'generating' },
      include: { _count: { select: { items: true } } },
      orderBy: [{ lastActivityAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
  },

  /**
   * Every `planned` plan, oldest id first — the plan-gate BACKFILL's candidate scan
   * (MOTIR-6039; ADR `approval-gates.md` §11.9). Narrowed to one workspace when
   * `workspaceId` is given.
   *
   * Cross-workspace, so it runs under `withSystemContext` against the plan policy's
   * `FOR SELECT` system arm (`plan_system_read`). It selects on STATUS only: whether a
   * plan holds proposals and already has an awaiting gate is decided per plan by
   * `planGateService`, under that plan's own workspace binding, so the scan never
   * re-states the raise's predicate.
   */
  async listPlannedForGateBackfill(
    scope: { workspaceId?: string },
    tx: Prisma.TransactionClient,
  ): Promise<Array<Pick<Plan, 'id' | 'workspaceId' | 'projectId' | 'createdById'>>> {
    return tx.plan.findMany({
      where: {
        status: 'planned',
        ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
      },
      select: { id: true, workspaceId: true, projectId: true, createdById: true },
      orderBy: { id: 'asc' },
    });
  },

  /**
   * Every UNDECIDED plan — `generating`, `planned` or `stale` — oldest id first:
   * the authorFinished CARRY-OVER's candidate scan (MOTIR-10491). Narrowed to one
   * workspace when `workspaceId` is given.
   *
   * `stale` is in the set because a stale plan is live, not decided: it returns
   * to `planned` on its own when its drift reverses, which can happen after the
   * sweep has passed. Cross-workspace, so it runs under `withSystemContext`
   * against the plan policy's `FOR SELECT` system arm (`plan_system_read`), as
   * {@link listPlannedForGateBackfill} does. It selects on STATUS only; which
   * cards to stamp is decided per plan under that plan's workspace binding.
   */
  async listOpenForAuthorFinishedBackfill(
    scope: { workspaceId?: string },
    tx: Prisma.TransactionClient,
  ): Promise<Array<Pick<Plan, 'id' | 'workspaceId' | 'projectId' | 'status'>>> {
    return tx.plan.findMany({
      where: {
        status: { in: [...UNDECIDED_PLAN_STATUSES] },
        ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
      },
      select: { id: true, workspaceId: true, projectId: true, status: true },
      orderBy: { id: 'asc' },
    });
  },

  async create(data: Prisma.PlanUncheckedCreateInput, tx: Prisma.TransactionClient): Promise<Plan> {
    return tx.plan.create({ data });
  },

  /**
   * Take a row lock on the plan (`SELECT … FOR UPDATE`) so a status-deciding
   * write (markPlanned / approve / decline) serializes against a concurrent
   * decider on the SAME plan — the lost-update guard for the one-shot
   * generating→planned→decided lifecycle (the `notes.html` lock-before-
   * read-derived-update rule). Returns the id, or `null` when the plan does not
   * exist; the caller re-reads the current row under the lock to re-validate
   * the status.
   */
  /**
   * What the plan gate's To-approve ROW draws, for a page of plans in ONE round trip
   * (Story MOTIR-6012 · MOTIR-6035; design Part XXII §22.3's field table): the title, the
   * author triple, the conversation and its targets, the project's name and the
   * proposal count. A plan that no longer exists is simply absent.
   */
  async findManyForGateSummary(ids: readonly string[], tx: Prisma.TransactionClient) {
    if (ids.length === 0) return [];
    return tx.plan.findMany({
      where: { id: { in: [...ids] } },
      select: {
        id: true,
        projectId: true,
        title: true,
        status: true,
        origin: true,
        authorSource: true,
        authorHarness: true,
        sessionId: true,
        session: { select: { turnCount: true, targetKeys: true } },
        project: { select: { name: true } },
        _count: { select: { items: true } },
      },
    });
  },

  /**
   * What THE PLAN HOLD reads about the plan a `plan_target_lock` names (Story
   * MOTIR-6017 · MOTIR-6265; `agent-authored-plans.md` AMENDMENT 21 §§1–2): its
   * status, which decides whether it holds, and its session + that session's
   * anchor keys, which are where its Review plan door goes. One read, on the
   * caller's `tx` — the status funnel makes it while holding the item `FOR UPDATE`.
   */
  async findHoldSubject(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<{
    status: Plan['status'];
    sessionId: string | null;
    session: { targetKeys: string[] } | null;
  } | null> {
    return tx.plan.findUnique({
      where: { id },
      select: { status: true, sessionId: true, session: { select: { targetKeys: true } } },
    });
  },

  async lockById(id: string, tx: Prisma.TransactionClient): Promise<{ id: string } | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "plan" WHERE "id" = ${id} FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  async update(id: string, data: PlanUpdateInput, tx: Prisma.TransactionClient): Promise<Plan> {
    return tx.plan.update({ where: { id }, data });
  },

  /**
   * GIVE BACK an approval's claim (Bug MOTIR-9006): `approving` → `planned`, ONLY
   * while the row still carries THIS claim — `approvingAt` is its token. A plan the
   * approval did commit (`approved`), or a claim already released and taken again
   * by a later approver, matches nothing and is left alone. Returns the count (0 or
   * 1). Guarded in the WHERE rather than by a read-then-write, so a release racing
   * the commit re-evaluates against the committed row and cannot undo it.
   */
  async releaseApprovingClaim(
    id: string,
    claimedAt: Date,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const { count } = await tx.plan.updateMany({
      where: { id, status: 'approving', approvingAt: claimedAt },
      data: { status: 'planned', approvingAt: null },
    });
    return count;
  },

  /**
   * `approving` plans whose claim is older than `claimedBefore` — the candidates
   * for the stalled-approval sweep (Bug MOTIR-9006): an approver that died between
   * its claim and its commit, or whose release never ran. Cross-workspace — runs
   * under the system context against the plan's system-read policy. Oldest first.
   */
  async listStalledApprovals(
    claimedBefore: Date,
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<Array<{ id: string; workspaceId: string; approvingAt: Date | null }>> {
    return tx.plan.findMany({
      where: { status: 'approving', approvingAt: { lt: claimedBefore } },
      select: { id: true, workspaceId: true, approvingAt: true },
      orderBy: [{ approvingAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
  },

  /**
   * The requirement a Sharpen session settled on this plan, and nothing else
   * (Task MOTIR-1101 · MOTIR-8450) — what a plan-writing submit forwards as the
   * run's own `requirement`. `undefined` when the plan is not in the workspace;
   * `null` when it carries none. The service narrows the shape.
   */
  async findSharpenedRequirementById(
    id: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Prisma.JsonValue | undefined> {
    const row = await tx.plan.findFirst({
      where: { id, workspaceId },
      select: { sharpenedRequirement: true },
    });
    return row ? row.sharpenedRequirement : undefined;
  },

  /**
   * Store the requirement a Sharpen session settled on this plan (Task MOTIR-1101 ·
   * MOTIR-8183) — a FULL replace, never a merge: the write-back always sends the
   * cumulative state. `null` clears it. The value is stored as given — the
   * service owns its shape (`SharpenedRequirementDto`).
   */
  async setSharpenedRequirement(
    id: string,
    value: object | null,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.plan.update({
      where: { id },
      data: {
        sharpenedRequirement: value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue),
      },
      select: { id: true },
    });
  },

  /** Stamp the plan's `lastActivityAt` (Story MOTIR-7820 · MOTIR-7822) — called
   *  inside the transaction of every step signal and every content write. */
  async touchActivity(id: string, at: Date, tx: Prisma.TransactionClient): Promise<void> {
    await tx.plan.update({ where: { id }, data: { lastActivityAt: at }, select: { id: true } });
  },

  /**
   * Everything the plan REVIEW shows that can change while a plan is being written, as ONE
   * text line, read in ONE statement (MOTIR-8127). `getPlanReviewIfChanged` hashes it into the
   * token a poll sends back, so an unchanged plan is answered without the heavy review read.
   *
   * ⚠️ THE PARTS ARE READ FROM THE TABLES THE REVIEW READS, not from `lastActivityAt` alone: that
   * stamp has six writers and a plan's status, closing, gate and revision trail move WITHOUT it
   * (`markPlanned`, a decline, a lease release). A part here cannot be forgotten by a new write
   * door, because the door writes the table. What no part can see is a LIVE work item a
   * `modify`/`remove` proposal points at changing underneath it — that is why the client still
   * forces a full read every few ticks.
   *
   * Bound `tx` is REQUIRED for the reason `planStepRepository` gives: `plan_revision`,
   * `plan_step` and `plan_narration` carry no `workspace_id`, their policies join to `plan`, and
   * an unbound read matches nothing — which would read as "nothing changed".
   */
  async readReviewFingerprint(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ status: PlanStatus; parts: string } | null> {
    const rows = await tx.$queryRaw<Array<{ status: PlanStatus; parts: string }>>`
      SELECT p."status"::text AS "status",
        concat_ws('|',
          p."status"::text,
          coalesce(md5(p."title"), '-'),
          coalesce(md5(p."summary"), '-'),
          coalesce(md5(p."product_name"), '-'),
          p."last_activity_at"::text,
          coalesce(p."planned_at"::text, '-'),
          coalesce(p."decided_at"::text, '-'),
          coalesce(p."decision_reason"::text, '-'),
          coalesce(p."session_id", '-'),
          (SELECT count(*) FROM "plan_item" i WHERE i."plan_id" = p."id")::text,
          (SELECT count(*) FROM "plan_revision" r WHERE r."plan_id" = p."id")::text,
          coalesce((SELECT max(r."changed_at") FROM "plan_revision" r WHERE r."plan_id" = p."id")::text, '-'),
          (SELECT count(*) FROM "plan_step" s WHERE s."plan_id" = p."id")::text,
          coalesce((SELECT max(s."started_at") FROM "plan_step" s WHERE s."plan_id" = p."id")::text, '-'),
          (SELECT count(*) FROM "plan_narration" n WHERE n."plan_id" = p."id")::text,
          coalesce((SELECT max(n."seq") FROM "plan_narration" n WHERE n."plan_id" = p."id")::text, '-'),
          (SELECT count(*) FROM "plan_narration_session" ns WHERE ns."plan_id" = p."id")::text,
          coalesce((SELECT max(ns."updated_at") FROM "plan_narration_session" ns WHERE ns."plan_id" = p."id")::text, '-'),
          (SELECT count(*) FROM "approval_gate" g
             WHERE g."work_item_id" IS NULL AND g."kind" = 'plan_approval' AND g."subject_id" = p."id")::text,
          coalesce((SELECT max(g."updated_at") FROM "approval_gate" g
             WHERE g."work_item_id" IS NULL AND g."kind" = 'plan_approval' AND g."subject_id" = p."id")::text, '-'),
          coalesce((SELECT cs."turn_count" FROM "plan_change_session" cs WHERE cs."id" = p."session_id")::text, '-')
        ) AS "parts"
      FROM "plan" p
      WHERE p."id" = ${id}
    `;
    return rows[0] ?? null;
  },

  /**
   * ONE OFFSET WINDOW of the reader's plans being written (Story MOTIR-7820 ·
   * MOTIR-7828), newest first with `id` as the tiebreak so pages are stable.
   * {@link generatingRequestedByWhere} is the predicate; an empty project scope
   * short-circuits rather than reaching `{ in: [] }`.
   */
  async listGeneratingRequestedBy(
    scope: GeneratingRequestedByScope,
    window: { skip: number; take: number },
    tx?: Prisma.TransactionClient,
  ): Promise<GeneratingPlanRow[]> {
    if (scope.projectIds.length === 0) return [];
    const client = tx ?? dbRead;
    return client.plan.findMany({
      where: generatingRequestedByWhere(scope),
      select: GENERATING_PLAN_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: window.skip,
      take: window.take,
    });
  },

  /**
   * The `planned` and `generating` plans in a scope that wrote a trail row at or
   * after `since` (Bug MOTIR-7988) — the CANDIDATES for a held revision lease. A
   * revision RE-OPENS a `planned` plan to `generating` while it runs (Bug
   * MOTIR-8208), so a held plan is usually `generating`; `planned` stays in the set
   * for the moment between a revision's close and its lease's end. A lease is held
   * only while the plan's latest trail row is inside the window, so a plan with no
   * row since `now − window` cannot be held, and this narrows the lease read to the
   * handful of plans anyone touched in the last few minutes. The exact verdict is
   * the service's (`revisionLeaseOf` over each candidate's trail).
   *
   * Every trail row counts here, internal ones included: a superset is harmless,
   * the exact read excludes them.
   */
  async findRevisablePlanIdsWithTrailSince(
    scope: RevisionHoldScope,
    since: Date,
    tx: Prisma.TransactionClient,
  ): Promise<string[]> {
    if (scope.projectIds.length === 0) return [];
    const rows = await tx.plan.findMany({
      where: {
        workspaceId: scope.workspaceId,
        projectId: { in: [...scope.projectIds] },
        status: { in: ['planned', 'generating'] },
        ...(scope.createdById ? { createdById: scope.createdById } : {}),
        revisions: { some: { changedAt: { gte: since } } },
      },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  },

  /**
   * HOW MANY plans {@link listGeneratingRequestedBy} pages over — the Workbench
   * strip's `planning` badge and the pager's denominator. The SAME builder, so
   * the badge and the rows cannot drift.
   */
  async countGeneratingRequestedBy(
    scope: GeneratingRequestedByScope,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    if (scope.projectIds.length === 0) return 0;
    const client = tx ?? dbRead;
    return client.plan.count({ where: generatingRequestedByWhere(scope) });
  },

  /**
   * A project's plans, newest first, keyset-paginated. `cursorId` is the id of
   * the last plan on the previous page (omitted for the first page); `limit`
   * rows are returned. Ordered (createdAt desc, id desc) so the cursor is
   * stable even when two plans share a `createdAt`.
   *
   * `status` NARROWS the page to one lifecycle status (MOTIR-3235, for the
   * tabbed list) and is applied HERE, in the `where` — not by the caller after
   * the read. A caller-side filter would take the `limit + 1` cursor page and
   * then shrink it, so a `planned` page would come back short while
   * `nextCursor` still claimed there was more. `null` / omitted ⇒ the whole
   * project, exactly as before this argument existed.
   *
   * ⚠️ IT ALSO TAKES A SET (MOTIR-4106), and for the SAME reason it is a `where`
   * clause rather than a caller-side filter. The AI boundary asks a question the
   * tabbed list never did — *which plans are PENDING?* — and "pending" is more
   * than one status, so a single-value argument left that caller either reading
   * one status per round trip and merging (three pages, three cursors, one
   * ordering nobody owns) or reading the whole project and shrinking it, which
   * is the exact defect the paragraph above rejects. An ARRAY compiles to
   * `status: { in: [...] }` and keeps the page, the ordering and the cursor a
   * property of ONE query. An EMPTY array is a caller asking for nothing and is
   * honoured as such — `{ in: [] }` matches no row — never silently widened to
   * the whole project, which is what treating it as falsy would do.
   *
   * Served by `@@index([projectId, status, createdAt])`: the narrowed set is
   * already in `createdAt` order under the index, so the keyset walk never
   * sorts a status in the heap.
   */
  async listByProject(
    projectId: string,
    workspaceId: string,
    limit: number,
    cursorId: string | null,
    tx?: Prisma.TransactionClient,
    status?: PlanStatus | readonly PlanStatus[] | null,
  ): Promise<Plan[]> {
    const client = tx ?? dbRead;
    const statusWhere =
      status == null ? {} : { status: typeof status === 'string' ? status : { in: [...status] } };
    return client.plan.findMany({
      where: { projectId, workspaceId, ...statusWhere },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });
  },

  /**
   * ONE PAGE of a project's plans for a SEARCH (MOTIR-10241) — the past-plans
   * read a planning session asks "how was similar work shaped before, and why
   * was it declined" through. `listByProject`'s keyset walk plus an optional
   * case-insensitive substring match on `title` OR `summary`, so the page, the
   * order and the cursor stay a property of ONE query and a narrowed page is a
   * full page rather than a filtered remnant of one.
   *
   * Every status is eligible; `statuses` narrows to a set, and an EMPTY set is
   * honoured as "nothing" (`{ in: [] }`), never widened. `workspaceId` is an
   * explicit predicate because RLS is inert under the dev/CI superuser (finding
   * #26), and `projectId` keeps one project out of another's plans. Read only.
   */
  async searchByProject(
    projectId: string,
    workspaceId: string,
    opts: {
      statuses: readonly PlanStatus[] | null;
      q: string | null;
      limit: number;
      cursorId: string | null;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<Plan[]> {
    const client = tx ?? dbRead;
    const statusWhere = opts.statuses === null ? {} : { status: { in: [...opts.statuses] } };
    const textWhere =
      opts.q === null
        ? {}
        : {
            OR: [
              { title: { contains: escapeLikePattern(opts.q), mode: 'insensitive' as const } },
              { summary: { contains: escapeLikePattern(opts.q), mode: 'insensitive' as const } },
            ],
          };
    return client.plan.findMany({
      where: { projectId, workspaceId, ...statusWhere, ...textWhere },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: opts.limit,
      ...(opts.cursorId ? { cursor: { id: opts.cursorId }, skip: 1 } : {}),
    });
  },

  /**
   * ONE PAGE of the plans related to a work item — the paging half of the item
   * page's PLAN HISTORY read (Story MOTIR-5542 · MOTIR-5546). Returns only each
   * plan's `id` and `createdAt`: the page's order and its cursor, nothing else.
   * The rows the page is folded from (and the plan fields it renders) are
   * `planItemRepository.findHistoryByWorkItemId`, called with these ids.
   *
   * ⚠️ PAGINATION IS BY PLAN, NOT BY PROPOSAL, and that is why this is its own
   * query. A plan expanding a story into eight subtasks holds eight `add` rows
   * naming the story, so a row-level `take` would cut one plan across two pages
   * and the fold would render it twice. Paging the DISTINCT plans first bounds
   * the page in the unit the page shows.
   *
   * "Related" is the three arms the history read folds — see
   * {@link planItemRepository.findHistoryByWorkItemId} for why each exists.
   * Prisma renders `items: { some }` as `plan.id IN (SELECT plan_id FROM
   * plan_item WHERE …)`, which the planner drives from the two plan_item
   * indexes (`[workItemId, workspaceId]`, `[parentRef, workspaceId]`) rather
   * than from the project's plan list; the page is then a sort of the related
   * plans only. No further index is needed for the keyset below.
   *
   * ALL FIVE statuses — history is not only what landed. Keyset cursor on
   * `(createdAt, id)` ascending; `workspaceId` is an explicit predicate because
   * RLS is inert under the dev/CI superuser (finding #26), and `projectId`
   * keeps a caller browsing one project out of another project's plans.
   */
  async findPageRelatedToWorkItem(
    workItemId: string,
    workspaceId: string,
    projectId: string,
    limit: number,
    after: { createdAt: Date; id: string } | null,
    tx?: Prisma.TransactionClient,
  ): Promise<Array<Pick<Plan, 'id' | 'createdAt'>>> {
    const client = tx ?? dbRead;
    return client.plan.findMany({
      where: {
        workspaceId,
        projectId,
        items: {
          some: {
            workspaceId,
            OR: [
              { workItemId, op: 'add' },
              { workItemId, op: { in: ['modify', 'remove'] } },
              { parentRef: workItemId, op: 'add' },
            ],
          },
        },
        ...(after
          ? {
              OR: [
                { createdAt: { gt: after.createdAt } },
                { createdAt: after.createdAt, id: { gt: after.id } },
              ],
            }
          : {}),
      },
      select: { id: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
  },

  /**
   * How many plans this project holds per lifecycle status, in ONE `groupBy`
   * (MOTIR-3235) — the numbers the tab strip renders beside its labels.
   *
   * Returns only the statuses that HAVE rows; zero-filling over the enum is the
   * service's job, because the enum the surface must be total over is the DTO
   * vocabulary and this layer does not map DTOs.
   *
   * One query for the whole strip rather than four counts: four round-trips to
   * render four numbers on one page is the shape `countByWorkItemIds` already
   * rejected one surface over.
   */
  async countByStatus(
    projectId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Array<{ status: PlanStatus; count: number }>> {
    const client = tx ?? dbRead;
    const rows = await client.plan.groupBy({
      by: ['status'],
      where: { projectId, workspaceId },
      _count: { _all: true },
    });
    return rows.map((row) => ({ status: row.status, count: row._count._all }));
  },
};
