import { Prisma, type PlanChangeSession, type PlanStatus } from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';
import {
  CLEARED_AWAITING_COLUMNS,
  CLEARED_FAILURE_COLUMNS,
  AWAITING_PERSON_WHERE,
  FAILED_WAITING_WHERE,
  NOT_WAITING_WHERE,
  parsePlanSessionAwaiting,
  parsePlanSessionFailureRecord,
  type PlanSessionAwaiting,
  type PlanSessionFailureRecord,
  UNDECIDED_PLAN_STATUSES,
  ENDED_WITH_WAITING_PLAN_WHERE,
} from '@/lib/planChange/sessionWaitingState';

/**
 * The `PlanChangeSession` update shape, NAMED BY THE OWNING REPOSITORY
 * (MOTIR-4296). Callers above this layer build their write payload against this
 * alias; `Prisma.PlanChangeSessionUncheckedUpdateInput` itself is named only here.
 */
export type PlanChangeSessionUpdateInput = Prisma.PlanChangeSessionUncheckedUpdateInput;

/**
 * The SQL predicate of {@link planChangeSessionRepository.listAwaitingReplyCandidates}
 * (MOTIR-7913), over an aliased `plan_change_session s`. The last turn is read with
 * `ORDER BY seq DESC LIMIT 1`; a `system` marker turn (a submission) is a last turn
 * that is NOT the planner's, so a session mid-submission never qualifies.
 *
 * Only a session that REACHED PLANNING qualifies (MOTIR-9299): it holds at least one
 * `plan` row, of any status. A conversation that only asked a question is not waiting on
 * its person, so it is never marked and the idle close ends it on the lease. The two plan
 * clauses answer different questions and both stay — "did it ever plan" (EXISTS) and "is
 * its plan still someone's to decide" (the undecided exclusion). The reply threshold
 * itself is the service's (`AWAITING_REPLY_AFTER_MS`); it arrives here already turned
 * into the `before` cutoff.
 */
function awaitingReplyCandidateSql(before: Date): Prisma.Sql {
  return Prisma.sql`
    s."ended_at" IS NULL
    AND s."origin" = 'conversation'
    AND s."created_by_id" IS NOT NULL
    AND s."failed_at" IS NULL
    AND s."awaiting_person_since" IS NULL
    AND s."last_activity_at" < ${before}
    AND (
      SELECT t."role" = 'assistant' AND t."question" IS NULL
      FROM "plan_change_turn" t
      WHERE t."session_id" = s."id"
      ORDER BY t."seq" DESC
      LIMIT 1
    )
    AND EXISTS (SELECT 1 FROM "plan" p WHERE p."session_id" = s."id")
    AND NOT EXISTS (
      SELECT 1 FROM "plan" p
      WHERE p."session_id" = s."id"
        AND p."status"::text IN (${Prisma.join([...UNDECIDED_PLAN_STATUSES])})
    )`;
}

/**
 * ONE definition of "the owner's failed-waiting sessions" for the list and the count
 * (MOTIR-7908), so the number a header shows and the rows beneath it cannot be read
 * off two predicates.
 */
function failedOpenForOwnerWhere(args: {
  userId: string;
  workspaceId: string;
  projectIds: readonly string[];
}): Prisma.PlanChangeSessionWhereInput {
  return {
    workspaceId: args.workspaceId,
    createdById: args.userId,
    projectId: { in: [...args.projectIds] },
    // A conversation, or an MCP author's own session (MOTIR-8132): the two origins the
    // sweep records a silent plan's failure on, so both must be where it is seen.
    origin: { in: ['conversation', 'mcp'] },
    ...FAILED_WAITING_WHERE,
    // A failure that cannot be resumed and has no plan waiting beside it asks nothing of its
    // person (MOTIR-9121): its attempt was released when it was recorded, and the session's
    // next turn simply plans again. Listing it would offer an entry with nothing to press.
    // ⚠️ Spelled as an OR, never `NOT { failureResumable: false, … }`: on a NULL (unknown)
    // verdict that NOT evaluates to NULL and drops every failure recorded before the column.
    OR: [
      { failureResumable: null },
      { failureResumable: true },
      { plans: { some: { status: { in: ['generating', 'planned', 'stale'] } } } },
    ],
  };
}

/** The ENDED-`failed` sessions of the owner that still hold a waiting plan (MOTIR-7939) —
 *  To resume's third form. One predicate for its list, its count and its watermark. */
function endedWithWaitingPlanForOwnerWhere(args: {
  userId: string;
  workspaceId: string;
  projectIds: readonly string[];
}): Prisma.PlanChangeSessionWhereInput {
  return {
    workspaceId: args.workspaceId,
    createdById: args.userId,
    projectId: { in: [...args.projectIds] },
    ...ENDED_WITH_WAITING_PLAN_WHERE,
    plans: { some: { status: { in: [...ENDED_WITH_WAITING_PLAN_WHERE.plans.some.status.in] } } },
  };
}

// Single Prisma operations on the `plan_change_session` table (Story 7.30 ·
// MOTIR-1728). Writes require `tx` (a compile-time guarantee they run in a
// transaction); reads take an optional `tx` so an append's locked re-read joins
// the surrounding transaction. No business logic, no transactions, no DTO
// mapping — those belong in `planChangeSessionsService`. Every tenant path runs
// under an active workspace context, so the RLS policy's `app.workspace_id` GUC
// gates the rows; the `workspaceId` argument is the belt-and-suspenders
// app-level scope (a cross-tenant project id returns null → 404, never 403).
/**
 * "This session REACHED PLANNING" on the Prisma side (MOTIR-9304): it holds at least one
 * `plan` row through `Plan.sessionId`, of any status. The fresh-start notice's read spreads
 * it. The Plans room states the same fact on the SQL side as {@link planHoldingSql}
 * (MOTIR-9300) — one fact, two spellings, because one read is a Prisma `where` and the
 * other a raw statement over the `lp` lateral.
 */
const HOLDS_A_PLAN_WHERE = { plans: { some: {} } } as const;

export const planChangeSessionRepository = {
  /** Create a session. `seedGateId` is set ONLY by a seeded first turn
   *  (`planChangeSessionsService.startSeededWithFirstTurn`, AMENDMENT 17 §9), and
   *  `seedGuideTurnId` ONLY by a guide-seeded one (`startGuideSeededWithFirstTurn`,
   *  MOTIR-8691). At most one of the two is set (the `one_seed` CHECK). */
  async create(
    data: Prisma.PlanChangeSessionUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeSession> {
    return tx.planChangeSession.create({ data });
  },

  /** The project's MOST RECENTLY ACTIVE conversation for one scope, of any
   *  member. ⚠️ NO PRODUCTION READER since MOTIR-6028 — every door addresses a
   *  session by id, and the resume read is {@link findResumableForUser}. It is
   *  kept because the E2E harness, the RLS fallback-arm guard and several suites
   *  read a scope's latest session through it; do not route a door back onto it. `scopeKey` is the canonical
   *  anchor-set discriminator (`''` = the project-wide thread; 7.12.3 ·
   *  MOTIR-909). A scope now holds MANY sessions (AMENDMENT 17 §2 — the
   *  `(project_id, scope_key)` unique is gone), so the read ORDERS by
   *  `lastActivityAt` and is deterministic when two exist. Workspace-scoped so a
   *  project id from another tenant resolves to null. Optional `tx` for use
   *  inside a transaction. */
  async findByProjectAndScope(
    projectId: string,
    scopeKey: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<PlanChangeSession | null> {
    const client = tx ?? dbRead;
    return client.planChangeSession.findFirst({
      where: { projectId, scopeKey, workspaceId },
      orderBy: [{ lastActivityAt: 'desc' }, { createdAt: 'desc' }],
    });
  },

  /**
   * ⚠️ `tx` is REQUIRED (MOTIR-2797) — unlike its sibling `findByProjectAndScope`,
   * which keeps its fallback because `planChangeSessionsService` still calls that
   * one unbound (MOTIR-2796's to fix). This one had no unbound caller left once
   * the tests bound, so the arm was dead code returning an EMPTY result under
   * `motir_app` while raising nothing.
   */
  async findById(
    id: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeSession | null> {
    return tx.planChangeSession.findFirst({ where: { id, workspaceId } });
  },

  /** One session BY ID, scoped to a project — the by-id address every door uses
   *  (AMENDMENT 17 §2). A session id from another project (or tenant) resolves to
   *  null, so the caller refuses it rather than writing to it. */
  async findByIdInProject(
    id: string,
    projectId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeSession | null> {
    return tx.planChangeSession.findFirst({ where: { id, projectId, workspaceId } });
  },

  /** The RESUME read (AMENDMENT 17 §3, AMENDMENT 23 §3): this member's OWN most
   *  recent OPEN CONVERSATION for the scope. Another member's
   *  session never qualifies — auto-resume is own-only — and neither does a
   *  session a door opened for a plan with no conversation (`mcp`, `expand`, …):
   *  it has no turns to resume into. Served by the
   *  `(project_id, scope_key, created_by_id, last_activity_at)` index. */
  async findResumableForUser(
    projectId: string,
    scopeKey: string,
    userId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeSession | null> {
    return tx.planChangeSession.findFirst({
      where: {
        projectId,
        scopeKey,
        workspaceId,
        createdById: userId,
        origin: 'conversation',
        // OPEN, at any age (AMENDMENT 23 §3) — the 2-hour window is retired. An
        // ended session is never resumed, however recent.
        endedAt: null,
      },
      orderBy: [{ lastActivityAt: 'desc' }, { createdAt: 'desc' }],
    });
  },

  /** What the SESSION HOLD reads of the session a lock names (AMENDMENT 23 §5;
   *  MOTIR-7640): whether it is open, its anchor, and who started it. */
  async findHoldSubject(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<{
    endedAt: Date | null;
    targetKeys: string[];
    createdBy: { id: string; name: string } | null;
  } | null> {
    return tx.planChangeSession.findUnique({
      where: { id },
      select: {
        endedAt: true,
        targetKeys: true,
        createdBy: { select: { id: true, name: true } },
      },
    });
  },

  /** This member's own most recent CONVERSATION for the scope, open or ended —
   *  the COPYABLE read (AMENDMENT 23 §6; MOTIR-7641): with no open session, the
   *  one that ended is what a new session may carry over. */
  async findLatestConversationForUser(
    projectId: string,
    scopeKey: string,
    userId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeSession | null> {
    return tx.planChangeSession.findFirst({
      where: { projectId, scopeKey, workspaceId, createdById: userId, origin: 'conversation' },
      orderBy: [{ lastActivityAt: 'desc' }, { createdAt: 'desc' }],
    });
  },

  /**
   * The TAKE-BACK read (AMENDMENT 23 §3; MOTIR-7639): this member's own OPEN
   * conversation that HOLDS one of `targetKeys` — a lock naming the session, or
   * naming its plan. A first turn or an open on a card the member is already
   * planning lands back in that conversation instead of starting a second one.
   * Newest activity wins when more than one does.
   */
  async findOpenHoldingForUser(
    projectId: string,
    targetKeys: readonly string[],
    userId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeSession | null> {
    if (targetKeys.length === 0) return null;
    const names = { workItem: { identifier: { in: [...targetKeys] } } };
    return tx.planChangeSession.findFirst({
      where: {
        projectId,
        workspaceId,
        createdById: userId,
        origin: 'conversation',
        endedAt: null,
        OR: [
          { targetLocks: { some: names } },
          { plans: { some: { targetLocks: { some: names } } } },
        ],
      },
      orderBy: [{ lastActivityAt: 'desc' }, { createdAt: 'desc' }],
    });
  },

  /** The GUIDE read (Story MOTIR-7459 · MOTIR-7464; ADR AMENDMENT 2, A2.2): this
   *  member's OWN most recent `guide` conversation on one card's scope. No resume
   *  window: a saved walk is resumable for as long as its list is on the card.
   *  Never another member's, and never a planning conversation of the same
   *  scope — {@link findResumableForUser} reads only `conversation`, and this
   *  reads only `guide`, so the two doors never pick up each other's thread. */
  async findLatestGuideForUser(
    projectId: string,
    scopeKey: string,
    userId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeSession | null> {
    return tx.planChangeSession.findFirst({
      where: { projectId, scopeKey, workspaceId, createdById: userId, origin: 'guide' },
      orderBy: [{ lastActivityAt: 'desc' }, { createdAt: 'desc' }],
    });
  },

  /** The SEEDED-session read (AMENDMENT 17 §9; MOTIR-6207): this member's OWN
   *  most recent OPEN session seeded by `seedGateId` in this project (AMENDMENT
   *  23 §3 — no window). Never another member's (sessions are per member), never an
   *  unseeded session and never one seeded by a different gate. Served by the
   *  `(seed_gate_id, created_by_id, last_activity_at)` index. */
  async findSeededForUser(
    projectId: string,
    seedGateId: string,
    userId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeSession | null> {
    return tx.planChangeSession.findFirst({
      where: {
        projectId,
        workspaceId,
        seedGateId,
        createdById: userId,
        endedAt: null,
      },
      orderBy: [{ lastActivityAt: 'desc' }, { createdAt: 'desc' }],
    });
  },

  /** The guide-seeded twin of {@link findSeededForUser} (MOTIR-8691): this member's
   *  OWN most recent session seeded by the guide reply turn `seedGuideTurnId`,
   *  open OR ended, newest first. Served by the
   *  `(seed_guide_turn_id, created_by_id, last_activity_at)` index. */
  async findSeededByGuideTurnForUser(
    projectId: string,
    seedGuideTurnId: string,
    userId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeSession | null> {
    return tx.planChangeSession.findFirst({
      where: { projectId, workspaceId, seedGuideTurnId, createdById: userId },
      orderBy: [{ lastActivityAt: 'desc' }, { createdAt: 'desc' }],
    });
  },

  /** The scope's most recent OTHER conversation, any member's, that has REACHED
   *  PLANNING — what a fresh start's notice points to (MOTIR-6024, MOTIR-9304).
   *  Conversation origin only: a session a door opened for a plan has no
   *  conversation to return to. Plan-holding only ({@link HOLDS_A_PLAN_WHERE}), so
   *  the id the notice links is one the Plans room lists; a NEWER plan-less
   *  conversation is skipped rather than blocking an older one that planned, and a
   *  scope where none planned answers null — no link at all. */
  async findLatestConversationInScope(
    projectId: string,
    scopeKey: string,
    workspaceId: string,
    excludeId: string | null,
    tx: Prisma.TransactionClient,
  ) {
    return tx.planChangeSession.findFirst({
      where: {
        projectId,
        scopeKey,
        workspaceId,
        origin: 'conversation',
        ...HOLDS_A_PLAN_WHERE,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      orderBy: [{ lastActivityAt: 'desc' }, { createdAt: 'desc' }],
      include: { createdBy: { select: { id: true, name: true } } },
    });
  },

  /** Who STARTED a session — the reopened line's name (MOTIR-6024). */
  async findStarter(
    id: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ id: string; name: string } | null> {
    const row = await tx.planChangeSession.findFirst({
      where: { id, workspaceId },
      select: { createdBy: { select: { id: true, name: true } } },
    });
    return row?.createdBy ?? null;
  },

  /** Who ENDED a session (AMENDMENT 23 §1), or null — Motir, or a departed member. */
  async findEnder(
    id: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ id: string; name: string } | null> {
    const row = await tx.planChangeSession.findFirst({
      where: { id, workspaceId },
      select: { endedBy: { select: { id: true, name: true } } },
    });
    return row?.endedBy ?? null;
  },

  /** The ids of this member's OTHER OPEN sessions of the scope — the sessions a
   *  new SEEDED session may take a live target lease over from (AMENDMENT 17 §6,
   *  kept for §9 only by AMENDMENT 23 §3). */
  async listIdsForUserInScope(
    projectId: string,
    scopeKey: string,
    userId: string,
    workspaceId: string,
    excludeId: string,
    tx: Prisma.TransactionClient,
  ): Promise<string[]> {
    const rows = await tx.planChangeSession.findMany({
      // OPEN sessions only: an ended one released its leases when it ended
      // (AMENDMENT 23 §2), so it has nothing left to hand over.
      where: {
        projectId,
        scopeKey,
        workspaceId,
        createdById: userId,
        id: { not: excludeId },
        endedAt: null,
      },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  },

  /**
   * Serialize resume-or-start for ONE member in ONE scope, for the rest of the
   * transaction (`pg_advisory_xact_lock`). This is the write guard that replaced
   * the dropped `(project_id, scope_key)` unique (AMENDMENT 17 §2): the choice
   * between appending to a recent session and creating a new one is READ-DERIVED
   * (it reads `lastActivityAt`), so two tabs sending a first turn at once must
   * queue here and the second must re-read after the first commits. Keyed on the
   * member as well as the scope because auto-resume is own-only (§3) — two
   * members starting sessions in one scope do not contend. `folderRepository`'s
   * structure lock is the precedent.
   */
  async lockScopeForUser(
    projectId: string,
    scopeKey: string,
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`plan-session:${projectId}:${scopeKey}:${userId}`}, 0))`;
  },

  /** The thread that SUBMITTED a given job (Story MOTIR-2786 · MOTIR-2787) — the
   *  reverse of `submit`'s `lastJobId` write, and how a plan decision finds the
   *  conversation whose target lock it should release. Workspace-scoped, so a job
   *  token from another tenant resolves to null. `tx` is required: every caller
   *  reads it to guard a following write. */
  async findByProjectAndLastJobId(
    projectId: string,
    lastJobId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeSession | null> {
    return tx.planChangeSession.findFirst({ where: { projectId, lastJobId, workspaceId } });
  },

  /**
   * Take a row lock on the conversation (`SELECT … FOR UPDATE`) so appending a
   * turn serializes against a concurrent append on the SAME thread — the
   * lost-update guard for the read-derived `turnCount → seq` allocation (the
   * lock-before-read-derived-update rule). Returns the id, or `null` when the
   * session does not exist; the caller re-reads the current row UNDER the lock
   * to allocate from a `turnCount` no sibling transaction can still move.
   */
  /**
   * The IDLE CLOSE's discovery read (AMENDMENT 23 §2; MOTIR-7638): open,
   * non-`guide` sessions whose last activity is older than `olderThan` and that
   * hold no undecided plan. Cross-tenant, so it runs under the system context
   * (`plan_change_session_system_read`); the end re-checks each one under its
   * own row lock before writing. Oldest first, bounded per pass.
   */
  async listIdleOpen(
    olderThan: Date,
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<Array<{ id: string; workspaceId: string }>> {
    return tx.planChangeSession.findMany({
      where: {
        endedAt: null,
        origin: { not: 'guide' },
        lastActivityAt: { lt: olderThan },
        // A session waiting on its person — a failed attempt to resume, or a
        // conversation they have not answered — is NOT idle (MOTIR-7908). Without
        // this a failure that came before the first proposal, and a reply nobody has
        // read yet, are indistinguishable from a thread nobody is coming back to.
        // ⚠️ AMENDED BY MOTIR-9299: a mark on a session that holds NO PLAN does not
        // protect it. Such a conversation is no longer marked, but one marked under the
        // old rule would otherwise nag in Waiting on you for ever; the end operation
        // clears the mark and withdraws its gate. A failed attempt keeps its To resume
        // entry whether or not it wrote a plan (`failedAt: null`).
        OR: [NOT_WAITING_WHERE, { ...AWAITING_PERSON_WHERE, failedAt: null, plans: { none: {} } }],
        plans: { none: { status: { in: [...UNDECIDED_PLAN_STATUSES] } } },
      },
      select: { id: true, workspaceId: true },
      orderBy: [{ lastActivityAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
  },

  /**
   * What a Waiting on you ROW says about the sessions it names (MOTIR-7913): each
   * session's wait, targets, newest plan and the planner's latest turn. One query for
   * the page; a session that no longer exists is absent.
   */
  async findManyForGateSummary(ids: readonly string[], tx: Prisma.TransactionClient) {
    if (ids.length === 0) return [];
    return tx.planChangeSession.findMany({
      where: { id: { in: [...ids] } },
      select: {
        id: true,
        projectId: true,
        targetKeys: true,
        awaitingPersonSince: true,
        awaitingPersonCause: true,
        plans: {
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 1,
          select: { id: true, title: true },
        },
        turns: {
          where: { role: 'assistant' },
          orderBy: { seq: 'desc' },
          take: 1,
          select: { body: true, question: true },
        },
      },
    });
  },

  /**
   * The ids of the sessions in these projects that are AWAITING THEIR PERSON right now
   * (`AWAITING_PERSON_WHERE`; MOTIR-7913) — the liveness set the Waiting on you read
   * admits a `planning_session` gate through, so a stale gate row for a session that
   * has since failed or ended is never listed.
   */
  async listAwaitingPersonIdsInProjects(
    projectIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<string[]> {
    if (projectIds.length === 0) return [];
    const rows = await tx.planChangeSession.findMany({
      where: { projectId: { in: [...projectIds] }, ...AWAITING_PERSON_WHERE },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  },

  /**
   * THE REPLY-WAIT DISCOVERY (MOTIR-7913): open `conversation` sessions with an owner,
   * in NEITHER wait, whose LAST turn is the planner's with no question, with no
   * `generating` plan (no job in flight), quiet since before `before`. Cross-tenant, so
   * it runs under the system context; the raise re-checks each one under its own lock
   * with {@link isAwaitingReplyCandidate}. Oldest first, bounded per pass.
   *
   * A raw read because "the last turn is X" is not a Prisma `where`; both queries below
   * spell it through ONE fragment so discovery and re-check cannot drift.
   */
  async listAwaitingReplyCandidates(
    before: Date,
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<Array<{ id: string; workspaceId: string }>> {
    const rows = await tx.$queryRaw<Array<{ id: string; workspace_id: string }>>`
      SELECT s."id", s."workspace_id"
      FROM "plan_change_session" s
      WHERE ${awaitingReplyCandidateSql(before)}
      ORDER BY s."last_activity_at" ASC, s."id" ASC
      LIMIT ${limit}
    `;
    return rows.map((row) => ({ id: row.id, workspaceId: row.workspace_id }));
  },

  /** The same predicate for ONE session — the raise's re-check under the session's lock. */
  async isAwaitingReplyCandidate(
    id: string,
    before: Date,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT s."id" FROM "plan_change_session" s
      WHERE s."id" = ${id} AND ${awaitingReplyCandidateSql(before)}
    `;
    return rows.length > 0;
  },

  // ── THE WAITING STATE (Story MOTIR-7905 · MOTIR-7908) ────────────────────────
  // Definitions: `lib/planChange/sessionWaitingState.ts`. Each write below is ONE
  // conditional `UPDATE … WHERE` — it reads and writes the row in a single
  // statement, so it serialises on the row lock Postgres takes for it. Against a
  // concurrent `endSessionWithin` the loser either sees `ended_at` set and matches
  // nothing, or runs first and has its columns nulled by the end write; the CHECK
  // constraints are the backstop if a caller ever skips the condition. Callers that
  // combine a write with OTHER rows (the failure path, the gate, the resume) still
  // take {@link lockById} first and re-read with {@link findWaitingState}.

  /**
   * Record a FAILED attempt on an OPEN session: the whole failure record, with the
   * two awaiting columns cleared in the same statement (the two waits exclude each
   * other). Returns whether a row moved — `false` on an ended session, which is
   * never marked.
   */
  async markFailed(
    id: string,
    record: PlanSessionFailureRecord,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const parsed = parsePlanSessionFailureRecord(record);
    const result = await tx.planChangeSession.updateMany({
      where: { id, endedAt: null },
      data: { ...parsed, ...CLEARED_AWAITING_COLUMNS },
    });
    return result.count > 0;
  },

  /**
   * The session's NEW ATTEMPT bound (MOTIR-7916): `lastJobId` / `lastSubmittedAt`, on an OPEN
   * session only. Beside {@link clearFailure}, in the same transaction. Returns whether a row
   * moved — `false` on an ended session.
   */
  async recordResumedAttempt(
    id: string,
    attempt: { jobId: string; at: Date },
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const result = await tx.planChangeSession.updateMany({
      where: { id, endedAt: null },
      data: { lastJobId: attempt.jobId, lastSubmittedAt: attempt.at },
    });
    return result.count > 0;
  },

  /**
   * Mark a recorded failure as one that cannot be resumed (MOTIR-9121) — motir-ai refused a
   * resume of it for want of a settled conversation. Guarded on the failure still being the
   * one the caller judged (`failedJobId`) on an open session, so a newer attempt or an end
   * is never overwritten. Returns whether a row moved.
   */
  async markFailureUnresumable(
    id: string,
    failedJobId: string,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const result = await tx.planChangeSession.updateMany({
      where: { id, endedAt: null, failedAt: { not: null }, failedJobId },
      data: { failureResumable: false },
    });
    return result.count > 0;
  },

  /** Null the seven failure columns — a resume's new attempt has bound. */
  async clearFailure(id: string, tx: Prisma.TransactionClient): Promise<boolean> {
    const result = await tx.planChangeSession.updateMany({
      where: { id },
      data: CLEARED_FAILURE_COLUMNS,
    });
    return result.count > 0;
  },

  /**
   * Mark an OPEN session as waiting on its person. Also conditioned on
   * `failedAt: null`: a failed-waiting session is already waiting, for a stronger
   * reason, and this is then a no-op returning `false` — never an overwrite.
   */
  async markAwaitingPerson(
    id: string,
    awaiting: PlanSessionAwaiting,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const { cause, since } = parsePlanSessionAwaiting(awaiting);
    const result = await tx.planChangeSession.updateMany({
      where: { id, endedAt: null, failedAt: null },
      data: { awaitingPersonCause: cause, awaitingPersonSince: since },
    });
    return result.count > 0;
  },

  /** Null the two awaiting columns — the person's next turn, or the end. */
  async clearAwaitingPerson(id: string, tx: Prisma.TransactionClient): Promise<boolean> {
    const result = await tx.planChangeSession.updateMany({
      where: { id },
      data: CLEARED_AWAITING_COLUMNS,
    });
    return result.count > 0;
  },

  /**
   * The waiting state of one session: its end, its failure record and its
   * awaiting record. A sweep, the gate or the resume runs this re-check UNDER the
   * session's {@link lockById}, so what it reads cannot move before it acts.
   */
  async findWaitingState(id: string, workspaceId: string, tx: Prisma.TransactionClient) {
    return tx.planChangeSession.findFirst({
      where: { id, workspaceId },
      select: {
        id: true,
        endedAt: true,
        endReason: true,
        lastJobId: true,
        failedAt: true,
        failedJobId: true,
        failureReason: true,
        failureDetail: true,
        failureStopPhase: true,
        failureStopRef: true,
        failureStopTitle: true,
        awaitingPersonSince: true,
        awaitingPersonCause: true,
        autoResumeCount: true,
        lastAutoResumedAt: true,
      },
    });
  },

  /**
   * The owner's OWN failed-waiting `conversation` and `mcp` sessions in the given projects,
   * newest failure first (`id` breaks a tie), each with its failure record, its
   * anchor set and its LATEST plan id. Runs under the OWNER's workspace context —
   * the `createdById` predicate is the app-level belt for the policy's braces.
   * A `guide` conversation submits no plan and is never listed.
   */
  async listFailedOpenForOwner(
    args: {
      userId: string;
      workspaceId: string;
      projectIds: readonly string[];
      skip: number;
      take: number;
    },
    tx: Prisma.TransactionClient,
  ) {
    const rows = await tx.planChangeSession.findMany({
      where: failedOpenForOwnerWhere(args),
      select: {
        id: true,
        projectId: true,
        targetKeys: true,
        failedAt: true,
        failedJobId: true,
        failureReason: true,
        failureDetail: true,
        failureStopPhase: true,
        failureStopRef: true,
        failureStopTitle: true,
        // The newest plan, with what the To resume entry names and the progress read
        // needs (MOTIR-7914) — one join, no per-row read.
        plans: {
          select: {
            id: true,
            projectId: true,
            status: true,
            title: true,
            createdAt: true,
            lastActivityAt: true,
            authorSource: true,
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 1,
        },
      },
      orderBy: [{ failedAt: 'desc' }, { id: 'desc' }],
      skip: args.skip,
      take: args.take,
    });
    return rows.map(({ plans, ...row }) => ({
      ...row,
      latestPlanId: plans[0]?.id ?? null,
      latestPlan: plans[0] ?? null,
    }));
  },

  /**
   * The To resume tab's WATERMARK share for the owner's failed sessions (MOTIR-7914): how
   * many, and the newest `failedAt`, in ONE aggregate over the same predicate as
   * {@link listFailedOpenForOwner}. Without it a new failure would move the badge and not the
   * tab's change detector.
   */
  async watermarkFailedOpenForOwner(
    args: { userId: string; workspaceId: string; projectIds: readonly string[] },
    tx: Prisma.TransactionClient,
  ): Promise<{ count: number; latest: Date | null }> {
    const row = await tx.planChangeSession.aggregate({
      where: failedOpenForOwnerWhere(args),
      _count: { _all: true },
      _max: { failedAt: true },
    });
    return { count: row._count._all, latest: row._max.failedAt ?? null };
  },

  /**
   * The owner's ENDED-`failed` sessions that still hold a plan waiting for a decision,
   * newest end first (`id` breaks a tie) — To resume's third form (MOTIR-7939). Same
   * ownership and project scoping as {@link listFailedOpenForOwner}.
   */
  async listEndedWithWaitingPlanForOwner(
    args: {
      userId: string;
      workspaceId: string;
      projectIds: readonly string[];
      skip: number;
      take: number;
    },
    tx: Prisma.TransactionClient,
  ) {
    return tx.planChangeSession.findMany({
      where: endedWithWaitingPlanForOwnerWhere(args),
      select: { id: true, projectId: true, targetKeys: true, endedAt: true },
      orderBy: [{ endedAt: 'desc' }, { id: 'desc' }],
      skip: args.skip,
      take: args.take,
    });
  },

  /** A count over the same predicate as {@link listEndedWithWaitingPlanForOwner}. */
  async countEndedWithWaitingPlanForOwner(
    args: { userId: string; workspaceId: string; projectIds: readonly string[] },
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.planChangeSession.count({ where: endedWithWaitingPlanForOwnerWhere(args) });
  },

  /** The tab's watermark share for these sessions: how many, and the newest `endedAt`. */
  async watermarkEndedWithWaitingPlanForOwner(
    args: { userId: string; workspaceId: string; projectIds: readonly string[] },
    tx: Prisma.TransactionClient,
  ): Promise<{ count: number; latest: Date | null }> {
    const row = await tx.planChangeSession.aggregate({
      where: endedWithWaitingPlanForOwnerWhere(args),
      _count: { _all: true },
      _max: { endedAt: true },
    });
    return { count: row._count._all, latest: row._max.endedAt ?? null };
  },

  /** A count over the same predicate as {@link listFailedOpenForOwner}. */
  async countFailedOpenForOwner(
    args: { userId: string; workspaceId: string; projectIds: readonly string[] },
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.planChangeSession.count({ where: failedOpenForOwnerWhere(args) });
  },

  async lockById(id: string, tx: Prisma.TransactionClient): Promise<{ id: string } | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "plan_change_session" WHERE "id" = ${id} FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  /** Bump a guide conversation's filed-bug counter by one (MOTIR-7800). The
   *  caller holds {@link lockById} on the row in the same transaction, so the
   *  count it checked and this increment are one decision. */
  async incrementGuideBugsFiled(id: string, tx: Prisma.TransactionClient): Promise<number> {
    const row = await tx.planChangeSession.update({
      where: { id },
      data: { guideBugsFiled: { increment: 1 } },
      select: { guideBugsFiled: true },
    });
    return row.guideBugsFiled;
  },

  /**
   * The automatic-resume record of a PAGE of sessions in ONE read (MOTIR-8309) — what
   * the progress read derives `resuming` from. Only sessions that were resumed
   * automatically at least once come back; a session missing from the answer has none.
   */
  async findAutoResumesByIds(sessionIds: readonly string[], tx: Prisma.TransactionClient) {
    if (sessionIds.length === 0) return [];
    return tx.planChangeSession.findMany({
      where: { id: { in: [...sessionIds] }, lastAutoResumedAt: { not: null } },
      select: { id: true, autoResumeCount: true, lastAutoResumedAt: true },
    });
  },

  /**
   * Record one automatic resume of an OPEN session (MOTIR-8305), bound included:
   * the count moves only while it is under `max`, in the same statement that
   * moves it, so two callers racing from `max - 1` cannot both pass. Answers the
   * new count, or `null` when the session is ended, unknown or at its bound —
   * nothing was written then.
   */
  async recordAutoResume(
    id: string,
    args: { at: Date; max: number },
    tx: Prisma.TransactionClient,
  ): Promise<number | null> {
    const rows = await tx.$queryRaw<Array<{ auto_resume_count: number }>>`
      UPDATE "plan_change_session"
         SET "auto_resume_count" = "auto_resume_count" + 1,
             "last_auto_resumed_at" = ${args.at},
             "updated_at" = ${args.at}
       WHERE "id" = ${id}
         AND "ended_at" IS NULL
         AND "auto_resume_count" < ${args.max}
      RETURNING "auto_resume_count"
    `;
    return rows[0]?.auto_resume_count ?? null;
  },

  async update(
    id: string,
    data: PlanChangeSessionUpdateInput,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeSession> {
    return tx.planChangeSession.update({ where: { id }, data });
  },

  /** Move an OPEN session's `lastActivityAt` — a Grill me turn on the conversation
   *  (MOTIR-9314). An ended session is left as it ended. Answers whether it moved. */
  async touchOpen(id: string, at: Date, tx: Prisma.TransactionClient): Promise<boolean> {
    const { count } = await tx.planChangeSession.updateMany({
      where: { id, endedAt: null },
      data: { lastActivityAt: at },
    });
    return count > 0;
  },

  /**
   * ONE PAGE of the Plans page's session list (MOTIR-6025, AMENDMENT 17 §8),
   * newest activity first, in ONE statement: each session with its starter, its
   * first `user` turn, its LATEST plan and its plan count, joined laterally so no
   * per-row read follows. Walks `(project_id, last_activity_at)`; the cursor is
   * the last row's `(lastActivityAt, id)`, compared as a ROW so two sessions
   * sharing a timestamp are neither skipped nor repeated across a page boundary.
   *
   * `state` filters on the session's state ({@link sessionStateSql}). `sessionId`
   * narrows to one row (the `?session=` landing, and the overlay's by-id scope check).
   *
   * `planOnly` (MOTIR-9300) admits only a session that REACHED PLANNING —
   * {@link planHoldingSql}. It is OFF unless asked for, because this one read serves two
   * doors with opposite needs: the Plans room lists only conversations that reached
   * planning, while the overlay's by-id read must still open a question-only one for its
   * owner. A new caller says which it means.
   *
   * The SEED (MOTIR-6209) rides the same statement: `seed_gate_id → gate → work
   * item`, two plain joins, so a seeded row costs no query of its own.
   * `seedCardInProject` is the browse fact the mapper keys off — see
   * `toPlanSessionRowDto`.
   *
   * A GUIDE seed (MOTIR-8697) rides it too: `seed_guide_turn_id → turn → its
   * guide session → the guided work item`, three more plain joins on keys, so a
   * guide-seeded row still costs no query of its own. The guided card is the
   * guide session's `target_keys[1]` (SQL arrays are 1-based): the guide door,
   * `planChangeSessionsService.openGuideWithFirstTurn`, refuses any scope that is
   * not exactly ONE card and writes `targetKeys: scope.targetKeys` with
   * `origin: 'guide'`, and `findLatestGuideForUser` reads a guide back by that one
   * card's `scopeKey` — the same `targetKeys[0]` read `planningSeedService`'s
   * guide seed read makes. The `gs.origin = 'guide'` guard keeps a turn of any
   * other session from ever resolving as a guide seed.
   *
   * A `guide` conversation (MOTIR-7464; ADR `conversation-turn-intent.md`
   * AMENDMENT 2, A2.2) is NOT a planning session — it submits no plan — so it is
   * left out of the Plans room, here and in {@link countByLatestPlanState} alike.
   */
  async listPageByProject(
    args: {
      projectId: string;
      workspaceId: string;
      limit: number;
      after: { lastActivityAt: Date; id: string } | null;
      state: PlanSessionListState | null;
      sessionId?: string;
      /** Only sessions holding a plan — the Plans room's rule. Absent = every session. */
      planOnly?: boolean;
      /** The reader's OWN sessions only (`mine`), or null for every session. */
      mine?: PlanSessionMineScope | null;
      /** Only the sessions this user STARTED (`created_by_id`) — the overlay's History
       *  (MOTIR-9306). Narrower than `mine`, which also takes in routed plans; never
       *  pass both. */
      ownerId?: string;
      /** A Visitor's private-epic hidden set (MOTIR-6645) — see {@link sessionWithheldSql}. */
      hiddenIds?: readonly string[];
    },
    tx: Prisma.TransactionClient,
  ): Promise<PlanSessionListRow[]> {
    const after = args.after
      ? Prisma.sql`AND (s."last_activity_at", s."id") < (${args.after.lastActivityAt}, ${args.after.id})`
      : Prisma.empty;
    const only = args.sessionId ? Prisma.sql`AND s."id" = ${args.sessionId}` : Prisma.empty;
    const owner = args.ownerId ? Prisma.sql`AND s."created_by_id" = ${args.ownerId}` : Prisma.empty;
    return tx.$queryRaw<PlanSessionListRow[]>`
      SELECT s."id", s."origin"::text AS "origin", s."target_keys" AS "targetKeys",
             s."last_activity_at" AS "lastActivityAt",
             u."id" AS "starterId", u."name" AS "starterName",
             ft."body" AS "firstTurn",
             ${rowPlanSql('id')} AS "planId", ${rowPlanSql('status')}::text AS "planStatus",
             ${rowPlanSql('title')} AS "planTitle", ${rowPlanSql('summary')} AS "planSummary",
             pc."n" AS "planCount",
             ${sessionStateSql}::text AS "state",
             s."failed_at" AS "failedAt", s."failure_reason"::text AS "failureReason",
             s."failure_stop_phase"::text AS "failureStopPhase",
             s."failure_stop_title" AS "failureStopTitle",
             s."ended_at" AS "endedAt", s."end_reason"::text AS "endReason",
             eb."id" AS "endedById", eb."name" AS "endedByName",
             cf."id" AS "copiedFromId", cf."ended_at" AS "copiedFromEndedAt",
             s."seed_gate_id" AS "seedGateId", sg."kind"::text AS "seedGateKind",
             sg."state"::text AS "seedGateState",
             sg."chosen_option"->>'label' AS "seedChosenLabel",
             sw."identifier" AS "seedCardKey",
             (sw."id" IS NOT NULL AND sw."projectId" = s."project_id") AS "seedCardInProject",
             s."seed_guide_turn_id" AS "seedGuideTurnId",
             gw."identifier" AS "seedGuideCardKey",
             (gw."id" IS NOT NULL AND gw."projectId" = s."project_id") AS "seedGuideCardInProject"
      FROM "plan_change_session" s
      LEFT JOIN "user" u ON u."id" = s."created_by_id"
      LEFT JOIN "user" eb ON eb."id" = s."ended_by_id"
      LEFT JOIN "plan_change_session" cf
        ON cf."id" = s."copied_from_session_id" AND cf."workspace_id" = s."workspace_id"
       AND cf."project_id" = s."project_id"
      LEFT JOIN "approval_gate" sg
        ON sg."id" = s."seed_gate_id" AND sg."workspace_id" = s."workspace_id"
      LEFT JOIN "work_item" sw
        ON sw."id" = sg."work_item_id" AND sw."workspaceId" = s."workspace_id"
      LEFT JOIN "plan_change_turn" gt
        ON gt."id" = s."seed_guide_turn_id" AND gt."workspace_id" = s."workspace_id"
      LEFT JOIN "plan_change_session" gs
        ON gs."id" = gt."session_id" AND gs."workspace_id" = s."workspace_id"
       AND gs."origin" = 'guide'
      LEFT JOIN "work_item" gw
        ON gw."identifier" = gs."target_keys"[1] AND gw."workspaceId" = s."workspace_id"
      LEFT JOIN LATERAL (
        SELECT t."body" FROM "plan_change_turn" t
        WHERE t."session_id" = s."id" AND t."role" = 'user'
        ORDER BY t."seq" ASC LIMIT 1
      ) ft ON true
      ${latestPlanJoin}
      ${waitingPlanJoin}
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS "n" FROM "plan" p WHERE p."session_id" = s."id"
      ) pc ON true
      WHERE s."project_id" = ${args.projectId} AND s."workspace_id" = ${args.workspaceId}
        AND s."origin" <> 'guide'
        ${stateFilter(args.state)} ${mineFilter(args.mine ?? null)} ${owner} ${after} ${only}
        ${args.planOnly ? planHoldingSql : Prisma.empty}
        ${sessionWithheldSql(args.hiddenIds)}
      ORDER BY s."last_activity_at" DESC, s."id" DESC
      LIMIT ${args.limit}
    `;
  },

  /**
   * Whether a Visitor must be refused ONE plan (Story MOTIR-6170 · MOTIR-6645) —
   * its proposals name a hidden id, or its session is withheld by
   * {@link sessionWithheldSql}. The same predicates the room's list applies, so a
   * plan the list does not show is exactly one its page refuses. An empty hidden
   * set withholds nothing.
   */
  async isPlanWithheld(
    planId: string,
    hiddenIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    if (hiddenIds.length === 0) return false;
    const hidden = hiddenIds as string[];
    const rows = await tx.$queryRaw<Array<{ withheld: boolean }>>`
      SELECT (
        EXISTS (
          SELECT 1 FROM "plan_item" pi
           WHERE pi."plan_id" = ${planId} AND ${planItemTouchesHiddenSql('pi', hidden)}
        )
        OR EXISTS (
          SELECT 1 FROM "plan" p
           WHERE p."id" = ${planId}
             AND p."session_id" IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM "plan_change_session" s
                WHERE s."id" = p."session_id"
                  ${sessionWithheldSql(hiddenIds)}
             )
        )
      ) AS "withheld"`;
    return rows[0]?.withheld ?? false;
  },

  /**
   * EVERY plan of a project a Visitor must be refused (MOTIR-6645) — the
   * {@link isPlanWithheld} predicate over the whole project, for the rooms that
   * reach a plan only through its id (a `plan_approval` record's subject). An
   * empty hidden set withholds nothing and reads nothing.
   */
  async findWithheldPlanIds(
    projectId: string,
    hiddenIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<string[]> {
    if (hiddenIds.length === 0) return [];
    const hidden = hiddenIds as string[];
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT p."id"
        FROM "plan" p
       WHERE p."project_id" = ${projectId}
         AND (
           EXISTS (
             SELECT 1 FROM "plan_item" pi
              WHERE pi."plan_id" = p."id" AND ${planItemTouchesHiddenSql('pi', hidden)}
           )
           OR (
             p."session_id" IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM "plan_change_session" s
                WHERE s."id" = p."session_id"
                  ${sessionWithheldSql(hiddenIds)}
             )
           )
         )`;
    return rows.map((r) => r.id);
  },

  /**
   * How many of the project's sessions hold each plan state — the filter's
   * counts — in ONE grouped statement over the same latest-plan join the list
   * uses, so a count and its filtered list can never disagree. Returns only the
   * states that have rows; the service zero-fills.
   *
   * Over sessions that REACHED PLANNING only ({@link planHoldingSql}, MOTIR-9300), always:
   * its one caller is the Plans room's strip, whose list reads with `planOnly`, so the
   * number above the strip and the rows beneath it count the same population.
   */
  async countByLatestPlanState(
    projectId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
    mine: PlanSessionMineScope | null = null,
    /** A Visitor's hidden set (MOTIR-6645): the counts are over the list's rows. */
    hiddenIds?: readonly string[],
  ): Promise<Array<{ state: string; count: number }>> {
    return tx.$queryRaw<Array<{ state: string; count: number }>>`
      SELECT ${sessionStateSql}::text AS "state", count(*)::int AS "count"
      FROM "plan_change_session" s
      ${latestPlanJoin}
      ${waitingPlanJoin}
      WHERE s."project_id" = ${projectId} AND s."workspace_id" = ${workspaceId}
        AND s."origin" <> 'guide'
        ${planHoldingSql}
        ${mineFilter(mine)}
        ${sessionWithheldSql(hiddenIds)}
      GROUP BY 1
    `;
  },
};

/** A session state the list filters on — `closed`, `waiting` or a `PlanStatus`
 *  value (AMENDMENT 23 §1). `none` is not one (MOTIR-9300): the room lists only
 *  sessions holding a plan, so no query it makes can answer for a session with none.
 *  `none` stays a ROW state ({@link sessionStateSql}) for the unfiltered by-id door. */
export type PlanSessionListState = 'closed' | 'waiting' | PlanStatus;

/** One raw row of {@link planChangeSessionRepository.listPageByProject}. */
export interface PlanSessionListRow {
  id: string;
  origin: string;
  targetKeys: string[];
  lastActivityAt: Date;
  starterId: string | null;
  starterName: string | null;
  firstTurn: string | null;
  planId: string | null;
  planStatus: string | null;
  planTitle: string | null;
  planSummary: string | null;
  planCount: number;
  /** The session's state, END first — {@link sessionStateSql}. */
  state: string;
  /** The failed attempt's record while the session is OPEN and failed-waiting (MOTIR-7921);
   *  all null otherwise. Untranslated: the row's words are keyed on `failureReason`. */
  failedAt: Date | null;
  failureReason: string | null;
  failureStopPhase: string | null;
  failureStopTitle: string | null;
  endedAt: Date | null;
  endReason: string | null;
  endedById: string | null;
  endedByName: string | null;
  /** The session this one was COPIED from (AMENDMENT 23 §6), when it is still
   *  in the project; null otherwise — a gone source reads like no source. */
  copiedFromId: string | null;
  copiedFromEndedAt: Date | null;
  /** MOTIR-6207's `seed_gate_id` — still set when the gate's work item moved away. */
  seedGateId: string | null;
  /** The seeding gate's kind; null when the session is unseeded or the gate is gone. */
  seedGateKind: string | null;
  /** The seeding gate's state — `approved` on a chosen `decision_choice` is a PICK
   *  (MOTIR-6434), every other seeding state a refusal. */
  seedGateState: string | null;
  /** The chosen option's stamped label on a pick, else null. */
  seedChosenLabel: string | null;
  /** The seeding gate's work item's identifier, when it still exists. */
  seedCardKey: string | null;
  /** Whether that work item is in the SESSION's project — the one the list is
   *  browse-gated on. False when there is no such work item. */
  seedCardInProject: boolean;
  /** MOTIR-8691's `seed_guide_turn_id` — the guide reply turn whose re-plan offer
   *  seeded this session; still set when the guided work item moved away. Null on
   *  every other session (exclusive with `seedGateId`). */
  seedGuideTurnId: string | null;
  /** The GUIDED work item's identifier — the card the seeding guide conversation
   *  walked (its `target_keys[1]`) — when it still exists; else null. */
  seedGuideCardKey: string | null;
  /** Whether that guided work item is in the SESSION's project, the one the list
   *  is browse-gated on. False when there is no such work item. */
  seedGuideCardInProject: boolean;
}

/**
 * The Plans room's WITHHOLDING for a Visitor (Story MOTIR-6170 · MOTIR-6645;
 * `epic-privacy.md` §3). A session is withheld when ANY of these joins reaches a
 * private epic's descendant — the whole session, because its turns, its plans'
 * titles and summaries may describe the hidden work and cannot be redacted:
 *
 * - its `target_keys` name a hidden work item;
 * - its seeding gate sits on a hidden work item;
 * - its GUIDE seed's guide conversation (`seed_guide_turn_id → turn → session`,
 *   MOTIR-8697) names a hidden work item in its `target_keys` — the guided card,
 *   which the session's first turn quotes, exactly as a gate seed's;
 * - ANY of its plans holds a proposal whose `work_item_id`, `parent_ref`,
 *   `blocked_by_refs`, or a `modify` patch's `parentRef` / `blockedByAdd`, names
 *   a hidden id.
 *
 * Absent / empty ⇒ no clause (a member's read, and a project with no private
 * epic, are byte-for-byte unchanged).
 */
export function sessionWithheldSql(hiddenIds: readonly string[] | undefined): Prisma.Sql {
  if (!hiddenIds || hiddenIds.length === 0) return Prisma.empty;
  const hidden = hiddenIds as string[];
  return Prisma.sql`AND NOT EXISTS (
          SELECT 1 FROM "work_item" hw
           WHERE hw."id" = ANY(${hidden}) AND hw."identifier" = ANY(s."target_keys")
        )
        AND NOT EXISTS (
          SELECT 1 FROM "approval_gate" hg
           WHERE hg."id" = s."seed_gate_id" AND hg."work_item_id" = ANY(${hidden})
        )
        AND NOT EXISTS (
          SELECT 1 FROM "plan_change_turn" hgt
            JOIN "plan_change_session" hgs ON hgs."id" = hgt."session_id"
            JOIN "work_item" hgw ON hgw."identifier" = ANY(hgs."target_keys")
           WHERE hgt."id" = s."seed_guide_turn_id"
             AND hgs."origin" = 'guide'
             AND hgw."id" = ANY(${hidden})
        )
        AND NOT EXISTS (
          SELECT 1 FROM "plan" hp
            JOIN "plan_item" hpi ON hpi."plan_id" = hp."id"
           WHERE hp."session_id" = s."id"
             AND ${planItemTouchesHiddenSql('hpi', hidden)}
        )`;
}

/**
 * Whether one proposal row (alias `alias`) names a hidden id through any of its
 * references — the predicate {@link sessionWithheldSql} and the plan-by-id read
 * share, so a plan the list withholds is exactly one its page refuses.
 */
export function planItemTouchesHiddenSql(alias: 'hpi' | 'pi', hidden: string[]): Prisma.Sql {
  const a = Prisma.raw(alias);
  return Prisma.sql`(
               ${a}."work_item_id" = ANY(${hidden})
            OR ${a}."parent_ref" = ANY(${hidden})
            OR ${a}."blocked_by_refs" && ${hidden}
            OR (${a}."patch" ->> 'parentRef') = ANY(${hidden})
            OR (jsonb_typeof(${a}."patch" -> 'blockedByAdd') = 'array'
                AND EXISTS (
                  SELECT 1 FROM jsonb_array_elements_text(${a}."patch" -> 'blockedByAdd') ref
                   WHERE ref = ANY(${hidden})
                ))
          )`;
}

/** A session's LATEST plan — newest `created_at`, `id` breaking a tie. */
const latestPlanJoin = Prisma.sql`
  LEFT JOIN LATERAL (
    SELECT p."id", p."status", p."title", p."summary" FROM "plan" p
    WHERE p."session_id" = s."id"
    ORDER BY p."created_at" DESC, p."id" DESC LIMIT 1
  ) lp ON true`;

/**
 * The ONE definition of "this session REACHED PLANNING" for the Plans room (MOTIR-9300;
 * amendment 5 clause 6): it holds at least one `plan` row, of any status. Read off
 * {@link latestPlanJoin}'s `lp` — the lateral the row's plan columns and
 * {@link sessionStateSql} already read — so "holds a plan", a non-zero plan count and a
 * state chip that is not `none` are one fact. Applied to the ROW, not folded into the
 * state expression: that reads `waiting` for a failed attempt that wrote no plan.
 */
const planHoldingSql = Prisma.sql`AND lp."id" IS NOT NULL`;

/**
 * The plan that WAITS for the person on a session — its most recent `planned` / `stale` plan
 * (Story MOTIR-7905 · MOTIR-7944). Read beside {@link latestPlanJoin}'s `lp`, because on a
 * session a failure ended before MOTIR-7905, or a restart ended, the LATEST plan is usually the
 * declined attempt while an earlier plan still waits.
 */
const waitingPlanJoin = Prisma.sql`
  LEFT JOIN LATERAL (
    SELECT wp0."id", wp0."status", wp0."title", wp0."summary" FROM "plan" wp0
    WHERE wp0."session_id" = s."id" AND wp0."status" IN ('planned', 'stale')
    ORDER BY wp0."created_at" DESC, wp0."id" DESC LIMIT 1
  ) wp ON true`;

/** Does the row read the WAITING plan rather than the latest one: an ended session Motir ended
 *  for a failure or a restart that still holds a plan awaiting a decision (MOTIR-7944). */
const readsWaitingPlan = Prisma.sql`(
    s."ended_at" IS NOT NULL AND s."end_reason" IN ('failed', 'restarted') AND wp."id" IS NOT NULL
  )`;

/** One column of the plan the row is KNOWN BY: the waiting plan when {@link readsWaitingPlan},
 *  else the latest one. */
function rowPlanSql(column: 'id' | 'status' | 'title' | 'summary'): Prisma.Sql {
  const c = Prisma.raw(`"${column}"`);
  return Prisma.sql`(CASE WHEN ${readsWaitingPlan} THEN wp.${c} ELSE lp.${c} END)`;
}

/**
 * A session's STATE (AMENDMENT 23 §1), END FIRST: an ended session reads
 * `declined` / `approved` when a person's decision ended it and `closed` when
 * Motir did (`failed` · `idle` · `restarted`); an OPEN one reads its latest
 * plan's status, or `none`. Over `s` and {@link latestPlanJoin}'s `lp`, and the
 * ONE expression the list, its filter and the counts all read — so a count, its
 * tab and a row's chip cannot disagree.
 *
 * Story MOTIR-7905 adds two reads, so a session whose attempt FAILED never reads `closed` or
 * `generating` while it is waiting on its person:
 *   · an OPEN failed-waiting session whose latest plan is still `generating` (or that has none
 *     yet) reads `waiting` — Waiting to resume (MOTIR-7921). One whose plan WAITS reads that
 *     plan's own status, which the open branch already does (MOTIR-7944);
 *   · a session ENDED `failed` / `restarted` that still holds a plan awaiting a decision reads
 *     that plan's status, not `closed` (MOTIR-7944). `idle` stays closed.
 */
export const sessionStateSql = Prisma.sql`(CASE
    WHEN s."ended_at" IS NULL THEN
      CASE
        WHEN s."failed_at" IS NOT NULL AND (lp."status" IS NULL OR lp."status" = 'generating')
          THEN 'waiting'
        ELSE COALESCE(lp."status"::text, 'none')
      END
    WHEN s."end_reason" IN ('declined', 'approved') THEN s."end_reason"::text
    WHEN ${readsWaitingPlan} THEN wp."status"::text
    ELSE 'closed'
  END)`;

/**
 * The Plans room's `mine` scope (Story MOTIR-6179 · MOTIR-6330): WHO is reading,
 * and the ids of the plans whose approval gate is routed to them — resolved ONCE
 * per read by the service through `approvalGateRepository.findAwaitingRoutedPlanIds`,
 * so this filter adds no per-row query.
 */
export interface PlanSessionMineScope {
  userId: string;
  routedPlanIds: string[];
}

/**
 * A session is the reader's when they STARTED it, or when one of its plans was
 * asked for by them, DECIDED by them, or is awaiting their decision. Written
 * ONCE, and read by the list and the counts alike, so a count and its list
 * cannot disagree about which sessions are mine.
 */
function mineFilter(mine: PlanSessionMineScope | null): Prisma.Sql {
  if (mine === null) return Prisma.empty;
  const routed =
    mine.routedPlanIds.length > 0
      ? Prisma.sql`OR p."id" IN (${Prisma.join(mine.routedPlanIds)})`
      : Prisma.empty;
  return Prisma.sql`AND (
    s."created_by_id" = ${mine.userId}
    OR EXISTS (
      SELECT 1 FROM "plan" p
      WHERE p."session_id" = s."id"
        AND (p."created_by_id" = ${mine.userId} OR p."decided_by_id" = ${mine.userId} ${routed})
    )
  )`;
}

function stateFilter(state: PlanSessionListState | null): Prisma.Sql {
  if (state === null) return Prisma.empty;
  return Prisma.sql`AND ${sessionStateSql} = ${state}`;
}
