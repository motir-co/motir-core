import type {
  Prisma,
  PlanNarration,
  PlanNarrationSession,
  PlanStepKind,
} from '@/generated/prisma/client';

/** One sentence to append, NAMED BY THE OWNING REPOSITORY (MOTIR-4296). */
export interface PlanNarrationCreateRow {
  planId: string;
  sessionKey: string;
  seq: number;
  body: string;
  createdAt: Date;
}

/** A session's step words as a step report writes them (MOTIR-8062). */
export interface PlanNarrationSessionWords {
  stepKind: PlanStepKind;
  targetRef: string | null;
  targetTitle: string | null;
}

// Plan-narration repository — single Prisma operations on `plan_narration` and
// `plan_narration_session` (Story MOTIR-8060 · Subtask MOTIR-8062). No business
// logic, no transactions, no DTO mapping — `plansService` owns those.
//
// ⚠️ EVERY CALL TAKES A REQUIRED `tx`, for the reason `planStepRepository`
// gives: neither table has a `workspace_id` — the policies JOIN to the parent
// `plan` — so an UNBOUND read matches nothing rather than failing, and an empty
// history reads exactly like "the planner said nothing".
//
// ⚠️ NO DELETE, AND NO UPDATE OF A SENTENCE. Both tables are kept history: the
// only thing that removes a row is the plan's own cascade.
export const planNarrationRepository = {
  /** The plan's highest `seq`, or 0 when it has none — read under the plan lock. */
  async maxSeq(planId: string, tx: Prisma.TransactionClient): Promise<number> {
    const r = await tx.planNarration.aggregate({ where: { planId }, _max: { seq: true } });
    return r._max.seq ?? 0;
  },

  /** Append sentences. Returns the rows as stored, in `seq` order. */
  async createMany(
    rows: readonly PlanNarrationCreateRow[],
    tx: Prisma.TransactionClient,
  ): Promise<PlanNarration[]> {
    const created = await tx.planNarration.createManyAndReturn({ data: [...rows] });
    return created.sort((a, b) => a.seq - b.seq);
  },

  /** The newest `limit` sentences of a plan, returned in ASCENDING `seq` (MOTIR-8063). */
  async listLatestByPlan(
    planId: string,
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<PlanNarration[]> {
    const rows = await tx.planNarration.findMany({
      where: { planId },
      orderBy: { seq: 'desc' },
      take: limit,
    });
    return rows.reverse();
  },

  /**
   * The `limit` sentences immediately BEFORE `beforeSeq`, returned in ASCENDING
   * `seq` — the paged read's one query (MOTIR-8063).
   */
  async listBeforeSeq(
    planId: string,
    beforeSeq: number,
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<PlanNarration[]> {
    const rows = await tx.planNarration.findMany({
      where: { planId, seq: { lt: beforeSeq } },
      orderBy: { seq: 'desc' },
      take: limit,
    });
    return rows.reverse();
  },

  /**
   * Record a session's step words: create sets `firstReportedAt`; an update
   * REPLACES kind, ref and title and leaves `firstReportedAt` as it was.
   */
  async upsertSession(
    planId: string,
    sessionKey: string,
    words: PlanNarrationSessionWords,
    tx: Prisma.TransactionClient,
  ): Promise<PlanNarrationSession> {
    return tx.planNarrationSession.upsert({
      where: { planId_sessionKey: { planId, sessionKey } },
      create: { planId, sessionKey, ...words },
      update: words,
    });
  },

  /**
   * Each session's NEWEST sentence across many plans (MOTIR-11184) — the quiet
   * drop's author signal. ONE grouped query on the `(plan_id, session_key)`
   * index; no sentence body crosses the wire.
   */
  async findLatestBySessionForPlans(
    planIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<{ planId: string; sessionKey: string; narratedAt: Date }[]> {
    if (planIds.length === 0) return [];
    const groups = await tx.planNarration.groupBy({
      by: ['planId', 'sessionKey'],
      where: { planId: { in: [...planIds] } },
      _max: { createdAt: true },
    });
    return groups.flatMap((g) =>
      g._max.createdAt
        ? [{ planId: g.planId, sessionKey: g.sessionKey, narratedAt: g._max.createdAt }]
        : [],
    );
  },

  /** One plan's sessions, in the order they first reported a step. */
  async listSessionsByPlan(
    planId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlanNarrationSession[]> {
    return tx.planNarrationSession.findMany({
      where: { planId },
      orderBy: [{ firstReportedAt: 'asc' }, { id: 'asc' }],
    });
  },
};
