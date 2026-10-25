import type {
  AgentInstanceBootAttempt,
  AgentInstanceBootKind,
  AgentInstanceBootOutcome,
  AgentInstanceBootStep,
  AgentInstanceBootStepKind,
  AgentInstanceBootStepState,
  Prisma,
} from '@/generated/prisma/client';

// Single Prisma operations on an agent's BOOT RECORD — `agent_instance_boot_attempt`
// and its `agent_instance_boot_step` rows (Story MOTIR-7393 · MOTIR-7397,
// `docs/decisions/agent-instances.md` AMENDMENT 6).
//
// Every method takes `tx`, reads included, for `agentInstanceRepository`'s
// reason (RLS on `app.workspace_id`; a bare read returns an empty list).
//
// ⚠️ THE LEASE IS THE STORY'S SINGLE-FLIGHT GUARANTEE (AMENDMENT 6 §4), and it
// is a compare-and-set in ONE update with its predicate in the `where` — the
// attempt is open AND its lease is free, expired or already the caller's. It is
// never a read followed by a write: the driver, a resent driver and the sweep
// may race for it, and the row lock the update takes is what serialises them.
// The caller writes steps only after a `renewLease` that answered 1 in the SAME
// transaction, so a writer that lost the lease meanwhile writes nothing.
//
// `seq` is monotonic per AGENT across its attempts (AMENDMENT 6 §2), so a stream
// cursor taken during one attempt resumes into the next without a gap. The
// caller stamps it from `maxSeq` + 1 while holding the lease.

/** An attempt as it is opened, named here so callers never spell a Prisma input type. */
export interface AgentInstanceBootAttemptCreateInput {
  workspaceId: string;
  organizationId: string;
  agentInstanceId: string;
  attempt: number;
  kind: AgentInstanceBootKind;
  startedAt: Date;
}

/** One planned step row, written when its attempt opens. */
export interface AgentInstanceBootStepCreateInput {
  workspaceId: string;
  bootAttemptId: string;
  seq: number;
  step: AgentInstanceBootStepKind;
  repository: string | null;
  ordinal: number;
  state: AgentInstanceBootStepState;
  startedAt?: Date | null;
  endedAt?: Date | null;
  detail?: string | null;
}

/** What a step write changes. `seq` is always restamped. */
export interface AgentInstanceBootStepUpdateInput {
  seq: number;
  state: AgentInstanceBootStepState;
  startedAt?: Date | null;
  endedAt?: Date | null;
  detail?: string | null;
}

export const agentInstanceBootRepository = {
  /** Open an attempt. `tx` required — a write. The unique (agent, attempt) refuses a duplicate number. */
  async createAttempt(
    data: AgentInstanceBootAttemptCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<AgentInstanceBootAttempt> {
    return tx.agentInstanceBootAttempt.create({ data });
  },

  /** The agent's CURRENT attempt — its highest number — or null before its first boot. */
  async findCurrentAttempt(
    agentInstanceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<AgentInstanceBootAttempt | null> {
    return tx.agentInstanceBootAttempt.findFirst({
      where: { agentInstanceId },
      orderBy: { attempt: 'desc' },
    });
  },

  /** One attempt by its number. */
  async findAttempt(
    agentInstanceId: string,
    attempt: number,
    tx: Prisma.TransactionClient,
  ): Promise<AgentInstanceBootAttempt | null> {
    return tx.agentInstanceBootAttempt.findUnique({
      where: { agentInstanceId_attempt: { agentInstanceId, attempt } },
    });
  },

  /**
   * TAKE the lease: granted when the attempt is open and its lease is free,
   * expired at `now`, or already `holder`'s. Returns the row count — 1 granted,
   * 0 refused (a live lease another holder has, or a closed attempt).
   */
  async takeLease(
    attemptId: string,
    holder: string,
    until: Date,
    now: Date,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.agentInstanceBootAttempt.updateMany({
      where: {
        id: attemptId,
        endedAt: null,
        OR: [{ leaseHolder: null }, { leaseExpiresAt: { lt: now } }, { leaseHolder: holder }],
      },
      data: { leaseHolder: holder, leaseExpiresAt: until },
    });
    return result.count;
  },

  /** RENEW a lease `holder` still holds on an open attempt. 0 = it is no longer theirs. */
  async renewLease(
    attemptId: string,
    holder: string,
    until: Date,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.agentInstanceBootAttempt.updateMany({
      where: { id: attemptId, endedAt: null, leaseHolder: holder },
      data: { leaseExpiresAt: until },
    });
    return result.count;
  },

  /** CLOSE an open attempt with its outcome, clearing the lease. Once: a second close reports 0. */
  async closeAttempt(
    attemptId: string,
    data: { endedAt: Date; outcome: AgentInstanceBootOutcome },
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.agentInstanceBootAttempt.updateMany({
      where: { id: attemptId, endedAt: null },
      data: { ...data, leaseHolder: null, leaseExpiresAt: null },
    });
    return result.count;
  },

  /** Write an attempt's planned rows. `tx` required — a write. */
  async createSteps(
    rows: AgentInstanceBootStepCreateInput[],
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.agentInstanceBootStep.createMany({ data: rows });
    return result.count;
  },

  /** Write one step's state, times and detail, restamping its `seq`. */
  async updateStep(
    stepId: string,
    data: AgentInstanceBootStepUpdateInput,
    tx: Prisma.TransactionClient,
  ): Promise<AgentInstanceBootStep> {
    return tx.agentInstanceBootStep.update({ where: { id: stepId }, data });
  },

  /** An attempt's steps, in read-out order. */
  async listSteps(
    attemptId: string,
    tx: Prisma.TransactionClient,
  ): Promise<AgentInstanceBootStep[]> {
    return tx.agentInstanceBootStep.findMany({
      where: { bootAttemptId: attemptId },
      orderBy: { ordinal: 'asc' },
    });
  },

  /** An attempt's steps written after `seq`, in `seq` order — the stream's page. */
  async listStepsSince(
    attemptId: string,
    seq: number,
    tx: Prisma.TransactionClient,
  ): Promise<AgentInstanceBootStep[]> {
    return tx.agentInstanceBootStep.findMany({
      where: { bootAttemptId: attemptId, seq: { gt: seq } },
      orderBy: { seq: 'asc' },
    });
  },

  /**
   * The steps IN PROGRESS on the open attempts of these agents — the list row's
   * current step (MOTIR-7400). Each carries its agent's id; an agent with none
   * (between two steps, or no open attempt) is simply absent.
   */
  async listInProgressForInstances(
    agentInstanceIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<
    Array<
      Pick<AgentInstanceBootStep, 'step' | 'repository' | 'ordinal' | 'detail'> & {
        agentInstanceId: string;
      }
    >
  > {
    if (agentInstanceIds.length === 0) return [];
    const rows = await tx.agentInstanceBootStep.findMany({
      where: {
        state: 'in_progress',
        bootAttempt: { agentInstanceId: { in: [...agentInstanceIds] }, endedAt: null },
      },
      select: {
        step: true,
        repository: true,
        ordinal: true,
        detail: true,
        bootAttempt: { select: { agentInstanceId: true } },
      },
      orderBy: { ordinal: 'asc' },
    });
    return rows.map(({ bootAttempt, ...step }) => ({
      ...step,
      agentInstanceId: bootAttempt.agentInstanceId,
    }));
  },

  /** The agent's highest step `seq` across all its attempts; 0 before any. */
  async maxSeq(agentInstanceId: string, tx: Prisma.TransactionClient): Promise<number> {
    const result = await tx.agentInstanceBootStep.aggregate({
      where: { bootAttempt: { agentInstanceId } },
      _max: { seq: true },
    });
    return result._max.seq ?? 0;
  },
};
