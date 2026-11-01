import { Prisma, type Plan, type PlanTargetLock } from '@/generated/prisma/client';

// Single Prisma operations on the `plan_target_lock` table (Story MOTIR-2786 ·
// MOTIR-2787) — the lease behind the `planning` status lock. No business logic,
// no transactions, no DTO mapping; those belong in `planTargetLockService`.
//
// ⚠️ EVERY method takes a REQUIRED `tx`, reads included — unusually for this
// layer, and on purpose. There is no such thing as an unbound read here: an
// acquire's read guards a write in the same transaction, the release's read
// guards a status restore, and the sweep's read runs inside the system-context
// transaction that then re-binds per row. A `tx ?? db` arm would have no caller
// at all, which is how a repository file loses branch coverage against its 90%
// gate the moment the last test call site binds.
/** A plan-held lease with the plan columns the board's plan-hold read needs. */
export interface PlanHeldLockRow {
  workItemId: string;
  planId: string | null;
  expiresAt: Date;
  plan: {
    status: Plan['status'];
    title: string | null;
    sessionId: string | null;
    session: { targetKeys: string[] } | null;
  } | null;
}

/** A session-held lease with the session columns the session hold reads. */
export interface SessionHeldLockRow {
  workItemId: string;
  sessionId: string | null;
  session: {
    endedAt: Date | null;
    targetKeys: string[];
    createdBy: { id: string; name: string } | null;
  } | null;
}

export const planTargetLockRepository = {
  async create(
    data: Prisma.PlanTargetLockUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<PlanTargetLock> {
    return tx.planTargetLock.create({ data });
  },

  /** The lease on ONE work item, or null. The acquire path's decision read — run
   *  AFTER the work item's own row lock, so what it returns cannot move under
   *  the caller. */
  async findByWorkItemId(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlanTargetLock | null> {
    return tx.planTargetLock.findUnique({ where: { workItemId } });
  },

  /** Every lease ONE session holds. The release read. Ordered by work item id so
   *  a release takes its row locks in the same order an acquire does — two
   *  operations touching the same pair of items in opposite orders is a
   *  deadlock, not a queue. */
  async listBySessionId(
    sessionId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlanTargetLock[]> {
    return tx.planTargetLock.findMany({
      where: { sessionId },
      orderBy: { workItemId: 'asc' },
    });
  },

  /** Every lease ONE PLAN holds (MOTIR-5645) — the twin of the read above, and
   *  the read approve, decline and the abandoned-plan sweep all make. Ordered by
   *  work item id for the same reason: one fixed lock order across every path. */
  async listByPlanId(planId: string, tx: Prisma.TransactionClient): Promise<PlanTargetLock[]> {
    return tx.planTargetLock.findMany({
      where: { planId },
      orderBy: { workItemId: 'asc' },
    });
  },

  /**
   * The PLAN-held leases on a SET of work items, each joined to the columns of its
   * plan that `planHoldFor` and a plan's label read (Story MOTIR-6017 · MOTIR-6268)
   * — the board projection's ONE batched plan-hold read. A SESSION-held lease
   * (`planId` null) is not returned: it never holds (AMENDMENT 21 §1).
   */
  /** Every lease on a SET of work items, by holder and expiry only — the plan
   *  offer's `target_held` read (MOTIR-9290), which asks WHO holds a target and
   *  whether the lease is still good, and nothing about the holder beyond that. */
  async listHoldersByWorkItemIds(
    workItemIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<
    { workItemId: string; sessionId: string | null; planId: string | null; expiresAt: Date }[]
  > {
    if (workItemIds.length === 0) return [];
    return tx.planTargetLock.findMany({
      where: { workItemId: { in: [...workItemIds] } },
      select: { workItemId: true, sessionId: true, planId: true, expiresAt: true },
    });
  },

  /** Every lease on a SET of work items, with the status each was parked FROM —
   *  the plan review's read of a parked target's real status (bug MOTIR-10102),
   *  which the card's own `planning` hides. */
  async listParkPriorsByWorkItemIds(
    workItemIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<
    { workItemId: string; priorStatus: string; statusHeld: boolean; planId: string | null }[]
  > {
    if (workItemIds.length === 0) return [];
    return tx.planTargetLock.findMany({
      where: { workItemId: { in: [...workItemIds] } },
      select: { workItemId: true, priorStatus: true, statusHeld: true, planId: true },
    });
  },

  async listPlanHeldByWorkItemIds(
    workItemIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<PlanHeldLockRow[]> {
    return tx.planTargetLock.findMany({
      where: { workItemId: { in: [...workItemIds] }, planId: { not: null } },
      select: {
        workItemId: true,
        planId: true,
        expiresAt: true,
        plan: {
          select: {
            status: true,
            title: true,
            sessionId: true,
            session: { select: { targetKeys: true } },
          },
        },
      },
    });
  },

  /**
   * The SESSION-held leases on a SET of work items, each joined to the columns of
   * its session `sessionHoldFor` and the session line read (AMENDMENT 23 §5;
   * MOTIR-7640) — the twin of {@link listPlanHeldByWorkItemIds}.
   */
  async listSessionHeldByWorkItemIds(
    workItemIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<SessionHeldLockRow[]> {
    return tx.planTargetLock.findMany({
      where: { workItemId: { in: [...workItemIds] }, sessionId: { not: null } },
      select: {
        workItemId: true,
        sessionId: true,
        session: {
          select: {
            endedAt: true,
            targetKeys: true,
            createdBy: { select: { id: true, name: true } },
          },
        },
      },
    });
  },

  /** How many LIVE items of a project each OPEN session's leases name — the
   *  session form of {@link countByPlanIds}, for a board's sibling count. */
  async countBySessionIds(
    args: {
      workspaceId: string;
      projectId: string;
      workItemStatus: string;
      sessionIds: readonly string[];
    },
    tx: Prisma.TransactionClient,
  ): Promise<Map<string, number>> {
    if (args.sessionIds.length === 0) return new Map();
    const rows = await tx.planTargetLock.groupBy({
      by: ['sessionId'],
      where: {
        workspaceId: args.workspaceId,
        projectId: args.projectId,
        workItem: { status: args.workItemStatus, archivedAt: null },
        sessionId: { in: [...args.sessionIds] },
      },
      _count: { _all: true },
    });
    return new Map(rows.map((row) => [row.sessionId as string, row._count._all]));
  },

  /**
   * How many LIVE items of a project each plan's leases name (MOTIR-6268) — one
   * grouped count. An item counts when it is not archived and is at
   * `workItemStatus`; a lease of a plan in `leasedPlanIds` counts only while it
   * runs past `leaseAfter`, every other plan's lease counts regardless (the
   * caller decides which plans hold by lease — this layer only filters).
   */
  async countByPlanIds(
    args: {
      workspaceId: string;
      projectId: string;
      workItemStatus: string;
      planIds: readonly string[];
      leasedPlanIds: readonly string[];
      leaseAfter: Date;
    },
    tx: Prisma.TransactionClient,
  ): Promise<Map<string, number>> {
    if (args.planIds.length === 0) return new Map();
    const leased = new Set(args.leasedPlanIds);
    const always = args.planIds.filter((id) => !leased.has(id));
    const rows = await tx.planTargetLock.groupBy({
      by: ['planId'],
      where: {
        workspaceId: args.workspaceId,
        projectId: args.projectId,
        workItem: { status: args.workItemStatus, archivedAt: null },
        OR: [
          { planId: { in: always } },
          { planId: { in: [...leased] }, expiresAt: { gt: args.leaseAfter } },
        ],
      },
      _count: { _all: true },
    });
    // `planId IN (…)` above: a grouped row's `planId` is never null here.
    return new Map(rows.map((row) => [row.planId as string, row._count._all]));
  },

  async update(
    id: string,
    data: Prisma.PlanTargetLockUncheckedUpdateInput,
    tx: Prisma.TransactionClient,
  ): Promise<PlanTargetLock> {
    return tx.planTargetLock.update({ where: { id }, data });
  },

  async deleteById(id: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.planTargetLock.delete({ where: { id } });
  },

  /** Push every lease a session holds out to a new expiry — the heartbeat. One
   *  statement, because a refresh has no per-row decision to make. Returns how
   *  many rows moved, so a caller can tell "refreshed nothing" from "refreshed
   *  the set". */
  async extendBySessionId(
    sessionId: string,
    expiresAt: Date,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.planTargetLock.updateMany({
      where: { sessionId },
      data: { expiresAt },
    });
    return result.count;
  },

  /**
   * The sweep's discovery read: leases whose window has run out, oldest first,
   * bounded.
   *
   * CROSS-TENANT BY DESIGN — it runs under `withSystemContext`, which is why the
   * table carries a `FOR SELECT` `app.system_admin` policy arm. Without the arm
   * this returns zero rows and raises nothing, and for a sweep an empty result is
   * indistinguishable from "nothing has expired": the vacuous pass.
   */
  async listExpired(
    now: Date,
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<PlanTargetLock[]> {
    return tx.planTargetLock.findMany({
      where: { expiresAt: { lte: now } },
      orderBy: { expiresAt: 'asc' },
      take: limit,
    });
  },
};
