import { Prisma, type PlanChangeRunPause } from '@/generated/prisma/client';

// Single Prisma operations on `plan_change_run_pauses` (Story MOTIR-7990 ·
// MOTIR-8007) — the planner's mid-run PAUSE. Like the mailbox repository, EVERY
// method takes `tx`: each read guards a write under the session's row lock, or is
// the DTO read made under a workspace context. No business logic, no transactions.
export const planChangeRunPauseRepository = {
  async create(
    data: Prisma.PlanChangeRunPauseUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeRunPause> {
    return tx.planChangeRunPause.create({ data });
  },

  /** One pause BY ID, scoped to its session, job and tenant — an id from anywhere
   *  else is simply not found (no existence leak). */
  async findById(
    id: string,
    sessionId: string,
    jobId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeRunPause | null> {
    return tx.planChangeRunPause.findFirst({ where: { id, sessionId, jobId, workspaceId } });
  },

  /** The pause a given idempotency key already wrote for this job, if any. */
  async findByIdempotencyKey(
    sessionId: string,
    jobId: string,
    idempotencyKey: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeRunPause | null> {
    return tx.planChangeRunPause.findFirst({
      where: { sessionId, jobId, idempotencyKey, workspaceId },
    });
  },

  /** The job's OPEN (unanswered) pause — the walk is paused on it. */
  async findOpenForJob(
    sessionId: string,
    jobId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeRunPause | null> {
    return tx.planChangeRunPause.findFirst({
      where: { sessionId, jobId, workspaceId, answer: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  },

  /** The newest pause of the session's job. */
  async findLatestForSession(
    sessionId: string,
    jobId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeRunPause | null> {
    return tx.planChangeRunPause.findFirst({
      where: { sessionId, jobId, workspaceId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  },

  /** CLAIM the answer. Only ever moves `answer` from null, so a racing second claim
   *  matches nothing and returns 0 rather than overwriting the first. */
  async markAnswered(
    id: string,
    data: {
      answer: string;
      answeredAt: Date;
      answeredById: string | null;
      replyText: string | null;
      /** The option a reply picked (MOTIR-11700), or null on own words / no reply. */
      replyOption?: { id: string; label: string; means: string } | null;
    },
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const { replyOption, ...rest } = data;
    const { count } = await tx.planChangeRunPause.updateMany({
      where: { id, answer: null },
      data: { ...rest, ...(replyOption ? { replyOption } : {}) },
    });
    return count;
  },

  /** Record how the answer's delivery ended: the mailbox entry written, or the
   *  refusal code (the run had ended). */
  async setDelivery(
    id: string,
    data: { mailboxEntryId?: string; deliveryRefusedCode?: string },
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeRunPause> {
    return tx.planChangeRunPause.update({ where: { id }, data });
  },
};
