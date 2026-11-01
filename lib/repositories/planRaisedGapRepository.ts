import type { Prisma, PlanRaisedGap } from '@/generated/prisma/client';

/** One gap to record, NAMED BY THE OWNING REPOSITORY (MOTIR-4296). */
export interface PlanRaisedGapCreateRow {
  planId: string;
  gapId: string;
  sessionKey: string;
  seq: number;
  level: string | null;
  raisedBy: string | null;
  what: string;
  decision: string | null;
  after: string | null;
  before: string | null;
  note: string | null;
  amendedAt: Date | null;
  createdAt: Date;
}

// Plan-raised-gap repository — single Prisma operations on `plan_raised_gap`
// (MOTIR-10176). No business logic, no transactions, no DTO mapping —
// `plansService` owns those.
//
// ⚠️ EVERY CALL TAKES A REQUIRED `tx`, for `planCodeReadRepository`'s reason: the
// table has no `workspace_id` — the policies JOIN to the parent `plan` — so an
// UNBOUND read matches nothing rather than failing, and an empty list reads
// exactly like "no session raised a gap".
//
// ⚠️ NO DELETE. A gap is kept with the plan; the only thing that removes a row is
// the plan's own cascade. The one update is the amend's stamp.
export const planRaisedGapRepository = {
  /** The plan's highest `seq`, or 0 when it has none — read under the plan lock. */
  async maxSeq(planId: string, tx: Prisma.TransactionClient): Promise<number> {
    const r = await tx.planRaisedGap.aggregate({ where: { planId }, _max: { seq: true } });
    return r._max.seq ?? 0;
  },

  /** The rows of the plan carrying these planner ids. */
  async findByGapIds(
    planId: string,
    gapIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<PlanRaisedGap[]> {
    if (gapIds.length === 0) return [];
    return tx.planRaisedGap.findMany({ where: { planId, gapId: { in: [...gapIds] } } });
  },

  /** Record new gaps. */
  async createMany(
    rows: readonly PlanRaisedGapCreateRow[],
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    if (rows.length === 0) return;
    await tx.planRaisedGap.createMany({ data: [...rows] });
  },

  /** Stamp ONE gap as handed to its level's amend, with what the amend answered it with. */
  async markAmended(
    id: string,
    answer: { amendedAt: Date; answerRefs: string[]; answerOpen: string | null },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.planRaisedGap.update({ where: { id }, data: answer });
  },

  /** Every gap of the plan, in raise order. */
  async listByPlan(planId: string, tx: Prisma.TransactionClient): Promise<PlanRaisedGap[]> {
    return tx.planRaisedGap.findMany({ where: { planId }, orderBy: { seq: 'asc' } });
  },
};
