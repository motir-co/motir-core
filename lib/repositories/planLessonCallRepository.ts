import type { Prisma, PlanLessonCall, PlanLessonSession } from '@/generated/prisma/client';

/** One lesson call to append, NAMED BY THE OWNING REPOSITORY (MOTIR-4296). */
export interface PlanLessonCallCreateRow {
  planId: string;
  sessionKey: string;
  seq: number;
  kind: string;
  query: string | null;
  filters: Prisma.InputJsonValue;
  lessonIds: Prisma.InputJsonValue;
  lessonId: string | null;
  occurrenceRef: string | null;
  outcome: string;
  counted: boolean | null;
  detail: string | null;
  createdAt: Date;
}

/** How many calls one session has on the log. */
export interface PlanLessonCallCount {
  sessionKey: string;
  calls: number;
}

// Plan-lesson-call repository — single Prisma operations on `plan_lesson_call`
// and its session marker `plan_lesson_session` (MOTIR-10191). No business logic,
// no transactions, no DTO mapping — `plansService` owns those.
//
// ⚠️ EVERY CALL TAKES A REQUIRED `tx`, for `planCodeReadRepository`'s reason: the
// tables have no `workspace_id` — the policies JOIN to the parent `plan` — so an
// UNBOUND read matches nothing rather than failing, and an empty log would read
// exactly like "the session made no lesson call".
//
// ⚠️ NO DELETE. The log is kept history: the only thing that removes a row is the
// plan's own cascade. The marker's `lastReportAt` is the one field that moves.
export const planLessonCallRepository = {
  /** The plan's highest `seq`, or 0 when it has none — read under the plan lock. */
  async maxSeq(planId: string, tx: Prisma.TransactionClient): Promise<number> {
    const r = await tx.planLessonCall.aggregate({ where: { planId }, _max: { seq: true } });
    return r._max.seq ?? 0;
  },

  /** Append calls. Returns the rows as stored, in `seq` order. */
  async createMany(
    rows: readonly PlanLessonCallCreateRow[],
    tx: Prisma.TransactionClient,
  ): Promise<PlanLessonCall[]> {
    const created = await tx.planLessonCall.createManyAndReturn({ data: [...rows] });
    return created.sort((a, b) => a.seq - b.seq);
  },

  /** Mark `sessionKey`'s lesson log recorded — created on its first report, touched after. */
  async upsertSession(
    planId: string,
    sessionKey: string,
    at: Date,
    tx: Prisma.TransactionClient,
  ): Promise<PlanLessonSession> {
    return tx.planLessonSession.upsert({
      where: { planId_sessionKey: { planId, sessionKey } },
      create: { planId, sessionKey, firstReportAt: at, lastReportAt: at },
      update: { lastReportAt: at },
    });
  },

  /**
   * Up to `limit` calls AFTER `afterSeq`, in ascending `seq` — optionally only
   * one session's. The read-back's page query.
   */
  async listAfterSeq(
    planId: string,
    filter: { afterSeq: number; sessionKey: string | null; limit: number },
    tx: Prisma.TransactionClient,
  ): Promise<PlanLessonCall[]> {
    return tx.planLessonCall.findMany({
      where: {
        planId,
        seq: { gt: filter.afterSeq },
        ...(filter.sessionKey !== null ? { sessionKey: filter.sessionKey } : {}),
      },
      orderBy: { seq: 'asc' },
      take: filter.limit,
    });
  },

  /** Every recorded session of the plan (or just one), in the order they first reported. */
  async listSessions(
    planId: string,
    sessionKey: string | null,
    tx: Prisma.TransactionClient,
  ): Promise<PlanLessonSession[]> {
    return tx.planLessonSession.findMany({
      where: { planId, ...(sessionKey !== null ? { sessionKey } : {}) },
      orderBy: [{ firstReportAt: 'asc' }, { id: 'asc' }],
    });
  },

  /** The number of calls each session has on the log; a session with none is absent. */
  async countBySession(
    planId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlanLessonCallCount[]> {
    const groups = await tx.planLessonCall.groupBy({
      by: ['sessionKey'],
      where: { planId },
      _count: { _all: true },
    });
    return groups.map((g) => ({ sessionKey: g.sessionKey, calls: g._count._all }));
  },
};
