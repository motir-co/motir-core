import { Prisma } from '@/generated/prisma/client';

/**
 * Cross-tenant PLAN reads for the platform tier (Story MOTIR-11455 · MOTIR-11458)
 * — the sibling of `platformEstateRepository`, under its rules:
 *
 * ⚠️ EVERY METHOD TAKES `tx` AS A REQUIRED PARAMETER. Only `withPlatformRead`
 * opens a platform transaction, and opening one writes the audit row, so an
 * untrailed cross-tenant read is a compile error.
 *
 * ⚠️ `plan` RUNS FORCE ROW LEVEL SECURITY, and
 * `20261116120000_plan_platform_staff_read` is what makes this answer; the
 * `workspace` and `project` it joins are armed by
 * `20261001200000_platform_staff_estate_read_arms`. On the `db` singleton it
 * returns null and raises nothing.
 *
 * ⚠️ READS ONLY. No tenant table has a `platform_staff` write arm.
 */

const RECORD_CONTEXT_SELECT = {
  id: true,
  title: true,
  workspaceId: true,
  projectId: true,
  sessionId: true,
  sourceJobId: true,
  authorModel: true,
  workspace: { select: { organizationId: true } },
  project: { select: { identifier: true } },
} as const satisfies Prisma.PlanSelect;

/** What a planner finding record needs to know about the plan it checked. */
export type PlatformPlanRecordContext = Prisma.PlanGetPayload<{
  select: typeof RECORD_CONTEXT_SELECT;
}>;

export const platformPlanRepository = {
  /** One plan's tenant ids, session, source job, title and author model; null when absent. */
  async findRecordContext(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlatformPlanRecordContext | null> {
    return tx.plan.findUnique({ where: { id }, select: RECORD_CONTEXT_SELECT });
  },
};
