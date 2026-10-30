import type { Prisma, PlanCodeRead } from '@/generated/prisma/client';

/** One read to append, NAMED BY THE OWNING REPOSITORY (MOTIR-4296). */
export interface PlanCodeReadCreateRow {
  planId: string;
  sessionKey: string;
  seq: number;
  tool: string;
  repo: string | null;
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  askedRef: string | null;
  query: string | null;
  commits: Prisma.InputJsonValue;
  outcome: string;
  lines: number | null;
  hits: number | null;
  detail: string | null;
  createdAt: Date;
}

// Plan-code-read repository — single Prisma operations on `plan_code_read`
// (MOTIR-10122). No business logic, no transactions, no DTO mapping —
// `plansService` owns those.
//
// ⚠️ EVERY CALL TAKES A REQUIRED `tx`, for `planNarrationRepository`'s reason:
// the table has no `workspace_id` — the policies JOIN to the parent `plan` — so
// an UNBOUND read matches nothing rather than failing, and an empty log reads
// exactly like "the session read nothing".
//
// ⚠️ NO DELETE AND NO UPDATE. The log is kept history: the only thing that
// removes a row is the plan's own cascade.
export const planCodeReadRepository = {
  /** The plan's highest `seq`, or 0 when it has none — read under the plan lock. */
  async maxSeq(planId: string, tx: Prisma.TransactionClient): Promise<number> {
    const r = await tx.planCodeRead.aggregate({ where: { planId }, _max: { seq: true } });
    return r._max.seq ?? 0;
  },

  /** Append reads. Returns the rows as stored, in `seq` order. */
  async createMany(
    rows: readonly PlanCodeReadCreateRow[],
    tx: Prisma.TransactionClient,
  ): Promise<PlanCodeRead[]> {
    const created = await tx.planCodeRead.createManyAndReturn({ data: [...rows] });
    return created.sort((a, b) => a.seq - b.seq);
  },

  /**
   * Up to `limit` reads AFTER `afterSeq`, in ascending `seq` — optionally only
   * one session's. The read-back's one query.
   */
  async listAfterSeq(
    planId: string,
    filter: { afterSeq: number; sessionKey: string | null; limit: number },
    tx: Prisma.TransactionClient,
  ): Promise<PlanCodeRead[]> {
    return tx.planCodeRead.findMany({
      where: {
        planId,
        seq: { gt: filter.afterSeq },
        ...(filter.sessionKey !== null ? { sessionKey: filter.sessionKey } : {}),
      },
      orderBy: { seq: 'asc' },
      take: filter.limit,
    });
  },
};
