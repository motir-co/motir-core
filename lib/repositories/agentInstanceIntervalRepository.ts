import type {
  AgentInstanceChargeOutcome,
  AgentInstanceInterval,
  AgentInstanceIntervalEndReason,
  Prisma,
} from '@/generated/prisma/client';

// Single Prisma operations on `agent_instance_interval` — one RUNNING stretch
// of an agent instance, the unit it is charged in (Story MOTIR-6860 ·
// MOTIR-6870, `docs/decisions/agent-instances.md` §4–§5).
//
// Every method takes `tx`, reads included, for `agentInstanceRepository`'s
// reason (RLS on `app.workspace_id`; a bare read returns an empty list).
//
// ⚠️ TWO WRITES HERE ARE GUARDED, AND THE GUARDS ARE THE BILLING INVARIANTS:
//   * an interval OPENS only if the instance has no open one — the partial
//     unique index `agent_instance_interval_one_open_key` refuses the second;
//   * an interval CLOSES once — `close` updates only while `endedAt IS NULL`,
//     so a second close (a retried hibernate, the sweep racing a click)
//     changes nothing and reports `0`.

/** The open payload, named here so callers above never spell a Prisma input type. */
export interface AgentInstanceIntervalOpenInput {
  /** Supplied by the caller so the charge reference can be derived from it. */
  id: string;
  workspaceId: string;
  organizationId: string;
  agentInstanceId: string;
  /** The run this interval belongs to — its own id when it opens a run. */
  runId: string;
  /** When that run began — `startedAt` on a run's first interval. */
  runStartedAt: Date;
  startedAt: Date;
  chargeReference: string;
}

/** What a close writes. */
export interface AgentInstanceIntervalCloseInput {
  endedAt: Date;
  endReason: AgentInstanceIntervalEndReason;
  billableSeconds: number;
}

/** What a charge attempt writes back (§5). */
export interface AgentInstanceIntervalChargeInput {
  outcome: AgentInstanceChargeOutcome;
  credits?: number | null;
  detail?: string | null;
  chargedAt?: Date | null;
}

export const agentInstanceIntervalRepository = {
  /** Open a running interval. `tx` required — a write. */
  async open(
    data: AgentInstanceIntervalOpenInput,
    tx: Prisma.TransactionClient,
  ): Promise<AgentInstanceInterval> {
    return tx.agentInstanceInterval.create({ data });
  },

  /** The instance's open interval, if any. */
  async findOpen(
    agentInstanceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<AgentInstanceInterval | null> {
    return tx.agentInstanceInterval.findFirst({ where: { agentInstanceId, endedAt: null } });
  },

  /**
   * Move an OPEN run-opening interval's start to `startedAt` — the lifecycle opens
   * an interval at Motir's own instant when it takes the slot, and corrects it to
   * Fly's start event once the machine is seen running (§5: the provider's
   * instant first, Motir's the fallback). The run's start moves with it, so the
   * backstop counts from the same instant. A closed interval, or one a roll opened
   * mid-run, is never touched.
   */
  async correctStart(id: string, startedAt: Date, tx: Prisma.TransactionClient): Promise<number> {
    const result = await tx.agentInstanceInterval.updateMany({
      where: { id, runId: id, endedAt: null },
      data: { startedAt, runStartedAt: startedAt },
    });
    return result.count;
  },

  /** An interval by id. */
  async findById(id: string, tx: Prisma.TransactionClient): Promise<AgentInstanceInterval | null> {
    return tx.agentInstanceInterval.findUnique({ where: { id } });
  },

  /**
   * Close an OPEN interval, once. The close also marks the charge `pending`, so
   * the charge pass and its backstop find every closed interval by one column.
   * Returns `1` for the close that won and `0` for any later one.
   */
  async close(
    id: string,
    data: AgentInstanceIntervalCloseInput,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.agentInstanceInterval.updateMany({
      where: { id, endedAt: null },
      data: { ...data, chargeOutcome: 'pending' },
    });
    return result.count;
  },

  /**
   * Write a charge attempt's outcome — only onto a CLOSED interval still
   * `pending`, so a replayed charge cannot overwrite a recorded one. Counts the
   * attempt either way it lands.
   */
  async recordCharge(
    id: string,
    data: AgentInstanceIntervalChargeInput,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.agentInstanceInterval.updateMany({
      where: { id, endedAt: { not: null }, chargeOutcome: 'pending' },
      data: {
        chargeOutcome: data.outcome,
        chargeAttempts: { increment: 1 },
        ...(data.credits !== undefined ? { credits: data.credits } : {}),
        ...(data.detail !== undefined ? { chargeDetail: data.detail } : {}),
        ...(data.chargedAt !== undefined ? { chargedAt: data.chargedAt } : {}),
      },
    });
    return result.count;
  },

  /** Closed intervals whose charge is still `pending`, oldest first — the backstop's discovery. */
  async listPendingCharges(
    take: number,
    tx: Prisma.TransactionClient,
  ): Promise<AgentInstanceInterval[]> {
    return tx.agentInstanceInterval.findMany({
      where: { chargeOutcome: 'pending', endedAt: { not: null } },
      orderBy: [{ endedAt: 'asc' }, { id: 'asc' }],
      take,
    });
  },

  /**
   * Every interval of the given instances that overlaps `[since, ∞)` — the
   * page's "machine time this period", summed by the service.
   */
  async listForInstancesSince(
    agentInstanceIds: readonly string[],
    since: Date,
    tx: Prisma.TransactionClient,
  ): Promise<AgentInstanceInterval[]> {
    if (agentInstanceIds.length === 0) return [];
    return tx.agentInstanceInterval.findMany({
      where: {
        agentInstanceId: { in: [...agentInstanceIds] },
        OR: [{ endedAt: null }, { endedAt: { gte: since } }],
      },
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
    });
  },

  /**
   * Each instance's most recently CLOSED interval — the page's "why did Motir stop
   * it" line reads its end reason (AMENDMENT 2). One row per instance at most.
   */
  async listLatestClosedForInstances(
    agentInstanceIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<AgentInstanceInterval[]> {
    if (agentInstanceIds.length === 0) return [];
    return tx.agentInstanceInterval.findMany({
      where: { agentInstanceId: { in: [...agentInstanceIds] }, endedAt: { not: null } },
      orderBy: [{ agentInstanceId: 'asc' }, { endedAt: 'desc' }, { id: 'desc' }],
      distinct: ['agentInstanceId'],
    });
  },

  /**
   * When ONE organisation's newest interval closed for `endReason`, or null —
   * the platform Fleet card's "last stopped by an organisation admin" moment.
   */
  async latestEndedForOrganization(
    organizationId: string,
    endReason: AgentInstanceIntervalEndReason,
    tx: Prisma.TransactionClient,
  ): Promise<Date | null> {
    const agg = await tx.agentInstanceInterval.aggregate({
      where: { organizationId, endReason, endedAt: { not: null } },
      _max: { endedAt: true },
    });
    return agg._max.endedAt ?? null;
  },

  /** How many of ONE organisation's intervals closed for `endReason` in `[from, to]`. */
  async countEndedForOrganizationBetween(
    organizationId: string,
    endReason: AgentInstanceIntervalEndReason,
    from: Date,
    to: Date,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.agentInstanceInterval.count({
      where: { organizationId, endReason, endedAt: { gte: from, lte: to } },
    });
  },
};
