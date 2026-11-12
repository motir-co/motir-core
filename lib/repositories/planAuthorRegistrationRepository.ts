import type { Prisma, PlanAuthorRegistration } from '@/generated/prisma/client';

/** One registration to record, NAMED BY THE OWNING REPOSITORY (MOTIR-4296). */
export interface PlanAuthorRegistrationCreateRow {
  planId: string;
  registrationId: string;
  sessionKey: string;
  seq: number;
  kind: string;
  registeredBy: string;
  level: string | null;
  receiver: string | null;
  what: string | null;
  handOffReason: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  codeFact: string | null;
  relayedAt: Date | null;
  createdAt: Date;
}

// Plan-author-registration repository — single Prisma operations on
// `plan_author_registration` (MOTIR-11085). No business logic, no transactions, no
// DTO mapping — `plansService` owns those.
//
// ⚠️ EVERY CALL TAKES A REQUIRED `tx`, for `planRaisedGapRepository`'s reason: the
// table has no `workspace_id` — the policies JOIN to the parent `plan` — so an
// UNBOUND read matches nothing rather than failing, and an empty list reads exactly
// like "no author registered anything".
//
// ⚠️ NO DELETE. A registration is kept with the plan; the only thing that removes a
// row is the plan's own cascade. The one update is the relay's stamp.
export const planAuthorRegistrationRepository = {
  /** The plan's highest `seq`, or 0 when it has none — read under the plan lock. */
  async maxSeq(planId: string, tx: Prisma.TransactionClient): Promise<number> {
    const r = await tx.planAuthorRegistration.aggregate({
      where: { planId },
      _max: { seq: true },
    });
    return r._max.seq ?? 0;
  },

  /** The rows of the plan carrying these planner ids. */
  async findByRegistrationIds(
    planId: string,
    registrationIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<PlanAuthorRegistration[]> {
    if (registrationIds.length === 0) return [];
    return tx.planAuthorRegistration.findMany({
      where: { planId, registrationId: { in: [...registrationIds] } },
    });
  },

  /** Record new registrations. */
  async createMany(
    rows: readonly PlanAuthorRegistrationCreateRow[],
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    if (rows.length === 0) return;
    await tx.planAuthorRegistration.createMany({ data: [...rows] });
  },

  /** Stamp ONE registration as handed to its level's amend, with how the amend settled it. */
  async markRelayed(
    id: string,
    relay: { relayedAt: Date; outcome: string; outcomeReason: string | null },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.planAuthorRegistration.update({ where: { id }, data: relay });
  },

  /** Every registration of the plan, in registration order. */
  async listByPlan(
    planId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlanAuthorRegistration[]> {
    return tx.planAuthorRegistration.findMany({ where: { planId }, orderBy: { seq: 'asc' } });
  },
};
