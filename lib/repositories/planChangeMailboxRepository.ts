import { Prisma, type PlanChangeMailboxEntry } from '@/generated/prisma/client';

// Single Prisma operations on the `plan_change_mailbox_entry` table (Story
// MOTIR-4054 · MOTIR-4067) — the BOUNDARY MAILBOX a running planning job checks.
// Its own repository, not a corner of the turn's: the entity name wins over the
// call site (the 4-layer repository-naming rule).
//
// EVERY method takes `tx`, including the reads. That is stricter than the turn
// repository, which lets the thread read take an optional one, and it is
// deliberate: there is no unguarded read here. `nextSeq` and `findByIdempotencyKey`
// guard writes and must run under the session's row lock, and `listPending` is
// followed in the same transaction by the `markConsumed` that claims what it
// returned — a read that ran outside would hand the same entries to two
// boundaries. It also removes the MOTIR-2846 shape entirely: a `tx?` forwarded
// as `undefined` falls back to the `db` singleton, which under the non-owner app
// role is unbound and silently returns nothing.
export const planChangeMailboxRepository = {
  async create(
    data: Prisma.PlanChangeMailboxEntryUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeMailboxEntry> {
    return tx.planChangeMailboxEntry.create({ data });
  },

  /**
   * The next `seq` for ONE job's mailbox — the READ-DERIVED value the caller
   * allocates from, and the reason every caller holds the session's row lock
   * first. Counting rather than reading a stored counter is right here because
   * the mailbox is per-RUN and short: a thread's `turn_count` cannot serve, and
   * a second counter column would be a second thing to keep in step.
   */
  async nextSeq(
    sessionId: string,
    jobId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const top = await tx.planChangeMailboxEntry.findFirst({
      where: { sessionId, jobId, workspaceId },
      orderBy: { seq: 'desc' },
      select: { seq: true },
    });
    return top ? top.seq + 1 : 0;
  },

  /**
   * The entry a given `idempotencyKey` already wrote for this job, if any — the
   * IDEMPOTENCY read behind "a retried submit does not double-deliver". Read
   * UNDER the session's row lock: checked outside it, two concurrent replays
   * would both see "not there yet" and both insert, and only the unique index
   * would stop them — which is a 409 for a caller whose request was correct.
   */
  async findByIdempotencyKey(
    sessionId: string,
    jobId: string,
    idempotencyKey: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeMailboxEntry | null> {
    return tx.planChangeMailboxEntry.findFirst({
      where: { sessionId, jobId, idempotencyKey, workspaceId },
    });
  },

  /**
   * Every entry for this job that no boundary has consumed yet, in `seq` order —
   * the ordering contract the read door's answer depends on, applied here ONCE
   * rather than at the call site.
   *
   * ⚠️ `seq`, never `createdAt`. Two entries written inside the same millisecond
   * is reachable, and `motir-ai`'s `readDelivery` breaks a `receivedAt` tie on
   * ARRAY ORDER — so the array this builds is what carries the producer's claim
   * about order, and a timestamp sort would quietly hand it the wrong one.
   */
  async listPending(
    sessionId: string,
    jobId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeMailboxEntry[]> {
    return tx.planChangeMailboxEntry.findMany({
      where: { sessionId, jobId, workspaceId, consumedAt: null },
      orderBy: { seq: 'asc' },
    });
  },

  /**
   * The `turn` entries of ONE job's mailbox with these ids, in `seq` order —
   * consumed or not (MOTIR-8007: a pause names change turns the walk may already
   * have read). Scoped to the session, job and tenant, so an id from anywhere else
   * simply is not returned.
   */
  async findTurnsByIds(
    ids: readonly string[],
    sessionId: string,
    jobId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<PlanChangeMailboxEntry[]> {
    if (ids.length === 0) return [];
    return tx.planChangeMailboxEntry.findMany({
      where: { id: { in: [...ids] }, sessionId, jobId, workspaceId, kind: 'turn' },
      orderBy: { seq: 'asc' },
    });
  },

  /**
   * Whether this job has EVER been stopped — existence, not pending-ness.
   *
   * ⚠️ The stop is deliberately NOT read through {@link listPending}: consuming
   * it would un-stop the next answer, and a run that has been ended stays ended.
   * Every boundary after the first therefore still reads `stopped: true`, which
   * is what makes a job retry or a second reader safe.
   */
  async hasStop(
    sessionId: string,
    jobId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const found = await tx.planChangeMailboxEntry.findFirst({
      where: { sessionId, jobId, workspaceId, kind: 'stop' },
      select: { id: true },
    });
    return found !== null;
  },

  /**
   * Whether a person has ever asked to SKIP this job's final check
   * (MOTIR-11266) — existence, not pending-ness, for {@link hasStop}'s reason:
   * a consumed skip would read as "keep checking" at the next boundary.
   */
  async hasSkipFinalCheck(
    sessionId: string,
    jobId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const found = await tx.planChangeMailboxEntry.findFirst({
      where: { sessionId, jobId, workspaceId, kind: 'skip_final_check' },
      select: { id: true },
    });
    return found !== null;
  },

  /**
   * Claim the entries a boundary just read. Scoped by `workspaceId` as well as
   * by id so the write cannot reach outside the caller's tenant even if an id
   * leaked, and it only ever moves `consumedAt` from null — a re-read that
   * raced returns 0 rather than re-stamping somebody else's claim.
   */
  async markConsumed(
    ids: readonly string[],
    workspaceId: string,
    at: Date,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const { count } = await tx.planChangeMailboxEntry.updateMany({
      where: { id: { in: [...ids] }, workspaceId, consumedAt: null },
      data: { consumedAt: at },
    });
    return count;
  },
};
