import { Prisma, type JobRunDlq } from '@/generated/prisma/client';

// Data access for the dead-letter queue (Story 1.6 · Subtask 1.6.4). Single-op
// methods only; writes require `tx` (the 4-layer contract). jobRunsService owns
// the dead-letter transaction (write the DLQ row + flip the job_run together);
// replayDLQ (lib/jobs/dlq.ts) owns the replay transaction. The DTO mapping lives
// in lib/mappers/jobMappers.ts.
export const jobRunDlqRepository = {
  /** Read one DLQ entry by id. Used inside the replay transaction. */
  async findById(id: string, tx: Prisma.TransactionClient): Promise<JobRunDlq | null> {
    return tx.jobRunDlq.findUnique({ where: { id } });
  },

  /**
   * Insert a dead-letter row when a run exhausts its retry budget. Uses the
   * UNCHECKED create input (scalar `workspaceId` FK) for the same reason as
   * jobRunRepository.create: the writer runs under the system-admin context
   * with no workspace context, so a `connect` SELECT on `workspace` would be
   * RLS-hidden. The Postgres FK still enforces existence.
   */
  async create(
    data: Prisma.JobRunDlqUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<JobRunDlq> {
    return tx.jobRunDlq.create({ data });
  },

  /** Stamp `replayedAt` when an operator replays the entry. */
  async update(
    id: string,
    data: Prisma.JobRunDlqUpdateInput,
    tx: Prisma.TransactionClient,
  ): Promise<JobRunDlq> {
    return tx.jobRunDlq.update({ where: { id }, data });
  },

  /**
   * Dashboard DLQ-tab read (1.6.5): a workspace's dead-letter entries,
   * newest-failure-first, paged. Takes `tx` (runs under withWorkspaceContext;
   * explicit workspaceId scope is defense-in-depth like jobRunRepository).
   * Serves the `[workspaceId, lastFailedAt desc]` index from the 1.6.4 schema.
   */
  async listByWorkspace(
    workspaceId: string,
    opts: { limit: number; offset: number },
    tx: Prisma.TransactionClient,
  ): Promise<JobRunDlq[]> {
    return tx.jobRunDlq.findMany({
      where: { workspaceId },
      orderBy: { lastFailedAt: 'desc' },
      take: opts.limit,
      skip: opts.offset,
    });
  },

  /**
   * Count of ACTIVE (not-yet-replayed) dead-letter entries for the DLQ-tab
   * badge. Excludes replayed rows (`replayedAt IS NOT NULL`) so the badge
   * reflects entries still needing operator attention, per the 1.6.5 AC.
   */
  async countActiveByWorkspace(workspaceId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.jobRunDlq.count({ where: { workspaceId, replayedAt: null } });
  },

  /**
   * The System tab's dead letters with NO workspace, not yet replayed
   * (MOTIR-8083), newest failure first. `workspace_id IS NULL` is the
   * definition of the list — a row that has a workspace belongs to that
   * workspace's own Dead letter tab and is never returned here.
   *
   * The caller MUST supply a `withSystemContext` tx: only that RLS branch
   * admits an untenanted row, for the reason `countActiveSince` gives.
   * `take` is a safety cap, not a page — the tab has no pager (design
   * `design/jobs/design-notes.md` § System dead letters).
   */
  async listSystemUnreplayed(take: number, tx: Prisma.TransactionClient): Promise<JobRunDlq[]> {
    return tx.jobRunDlq.findMany({
      where: { workspaceId: null, replayedAt: null },
      orderBy: { lastFailedAt: 'desc' },
      take,
    });
  },

  /**
   * The System tab's workspace-less dead letters replayed since `since`, newest
   * failure first — the tail kept long enough to confirm a replay landed.
   * Same system-context requirement as {@link listSystemUnreplayed}.
   */
  async listSystemReplayedSince(
    since: Date,
    take: number,
    tx: Prisma.TransactionClient,
  ): Promise<JobRunDlq[]> {
    return tx.jobRunDlq.findMany({
      where: { workspaceId: null, replayedAt: { gte: since } },
      orderBy: { lastFailedAt: 'desc' },
      take,
    });
  },

  /** How many workspace-less dead letters are still waiting to be replayed. */
  async countSystemUnreplayed(tx: Prisma.TransactionClient): Promise<number> {
    return tx.jobRunDlq.count({ where: { workspaceId: null, replayedAt: null } });
  },

  /** How many workspace-less dead letters were replayed since `since`. */
  async countSystemReplayedSince(since: Date, tx: Prisma.TransactionClient): Promise<number> {
    return tx.jobRunDlq.count({ where: { workspaceId: null, replayedAt: { gte: since } } });
  },

  /**
   * The platform ledger's unreplayed dead letters (MOTIR-9984): workspace rows
   * and workspace-less rows together, newest failure first, optionally only one
   * function's. NO workspace predicate — the caller MUST supply a
   * `withSystemContext` tx, for the reason `countActiveSince` gives. `take` is
   * the per-selection cap, so a chosen function's rows are reached however old
   * they are next to every other function's.
   */
  async listUnreplayed(
    opts: { functionId?: string; take: number },
    tx: Prisma.TransactionClient,
  ): Promise<JobRunDlq[]> {
    return tx.jobRunDlq.findMany({
      where: { replayedAt: null, ...(opts.functionId ? { functionId: opts.functionId } : {}) },
      orderBy: { lastFailedAt: 'desc' },
      take: opts.take,
    });
  },

  /**
   * The platform ledger's dead letters replayed since `since`, newest failure
   * first, optionally only one function's. Same system-context requirement as
   * {@link listUnreplayed}.
   */
  async listReplayedSince(
    opts: { since: Date; functionId?: string; take: number },
    tx: Prisma.TransactionClient,
  ): Promise<JobRunDlq[]> {
    return tx.jobRunDlq.findMany({
      where: {
        replayedAt: { gte: opts.since },
        ...(opts.functionId ? { functionId: opts.functionId } : {}),
      },
      orderBy: { lastFailedAt: 'desc' },
      take: opts.take,
    });
  },

  /** How many dead letters, of every workspace and none, were replayed since `since`. */
  async countReplayedSince(
    opts: { since: Date; functionId?: string },
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.jobRunDlq.count({
      where: {
        replayedAt: { gte: opts.since },
        ...(opts.functionId ? { functionId: opts.functionId } : {}),
      },
    });
  },

  /**
   * Count of ACTIVE dead-letter entries across EVERY workspace, optionally only
   * those that failed since a moment — the operator console's "Failed jobs"
   * signal (MOTIR-1167, design Panel 8's 24-hour figure).
   *
   * No workspace filter, so the caller MUST supply a `withSystemContext` tx —
   * the same requirement, for the same reason, as `jobRunRepository.listAll`:
   * that is the only RLS branch admitting the untenanted `workspace_id IS NULL`
   * rows every `system.*` job writes, and a system job dead-lettering is exactly
   * the case this signal exists to show.
   *
   * `replayedAt: null` is the same predicate the per-workspace badge uses:
   * entries an operator has already retried are not still asking for attention.
   */
  async countActiveSince(since: Date | null, tx: Prisma.TransactionClient): Promise<number> {
    return tx.jobRunDlq.count({
      where: { replayedAt: null, ...(since ? { lastFailedAt: { gte: since } } : {}) },
    });
  },

  /**
   * The STANDING depth of every job function that has any — its unreplayed
   * dead letters and the OLDEST `lastFailedAt` among them — for the depth filer
   * (MOTIR-5869). A function with no unreplayed row is absent, which is what
   * "its depth returned to zero" means to the caller.
   *
   * Deployment-wide, so the caller MUST supply a `withSystemContext` tx, for the
   * reason `countActiveSince` gives.
   */
  async standingDepthByFunction(tx: Prisma.TransactionClient): Promise<StandingDlqDepth[]> {
    const groups = await tx.jobRunDlq.groupBy({
      by: ['functionId'],
      where: { replayedAt: null },
      _count: { _all: true },
      _min: { lastFailedAt: true },
    });
    return groups.map((g) => ({
      functionId: g.functionId,
      standing: g._count._all,
      // A group exists only because it has a row, and `lastFailedAt` is NOT NULL.
      oldestLastFailedAt: g._min.lastFailedAt!,
    }));
  },

  /** ONE function's standing depth, or null when it has none — the filer's
   *  re-read under its row lock, so a queue drained since the sweep's first
   *  read is not filed about. Same system-context requirement as above. */
  async standingDepthOfFunction(
    functionId: string,
    tx: Prisma.TransactionClient,
  ): Promise<StandingDlqDepth | null> {
    const agg = await tx.jobRunDlq.aggregate({
      where: { functionId, replayedAt: null },
      _count: { _all: true },
      _min: { lastFailedAt: true },
    });
    const oldest = agg._min.lastFailedAt;
    return oldest ? { functionId, standing: agg._count._all, oldestLastFailedAt: oldest } : null;
  },
};

/** One job function's standing (unreplayed) dead letters. */
export interface StandingDlqDepth {
  functionId: string;
  standing: number;
  oldestLastFailedAt: Date;
}
