import type {
  Prisma,
  RunDiscrepancyEntry,
  RunDiscrepancyEntryKind,
  RunDiscrepancyRecord,
  RunDiscrepancySource,
} from '@/generated/prisma/client';

// Single Prisma operations on `run_discrepancy_record` and its `run_discrepancy_entry`
// rows (Task MOTIR-11361) — a run's discrepancy record as data. The SERVICES own every
// decision (`runDiscrepancyService` writes, `runRecordReadService` reads,
// `runDiscrepancyBackfillService` fills the past); this leaf holds none of it.
//
// `tx` on every method, reads included: both tables are RLS-gated on `app.workspace_id`
// (the migration's header), so a read with no bound workspace returns nothing.

/** A record with its entries, points then decisions, each in the order the run sent them. */
export type RunDiscrepancyRecordWithEntries = RunDiscrepancyRecord & {
  entries: RunDiscrepancyEntry[];
};

/** One entry as the writer hands it over; `workspaceId` and `recordId` are filled in. */
export interface RunDiscrepancyEntryInput {
  kind: RunDiscrepancyEntryKind;
  position: number;
  planText: string;
  outcomeText: string;
  why: string;
  alternatives: string | null;
}

export interface RunDiscrepancyRecordInput {
  workspaceId: string;
  projectId: string;
  workItemId: string;
  dispatchRunId: string | null;
  dispatchRunCardId: string | null;
  commentId: string | null;
  recordedById: string | null;
  source: RunDiscrepancySource;
  pointCount: number;
  decisionCount: number;
  /** Omitted: now. The backfill passes the comment's (or the finding's) own time. */
  recordedAt?: Date;
  entries: readonly RunDiscrepancyEntryInput[];
}

/** What one run's records add up to — the run search's row counts. */
export interface RunDiscrepancyRunCounts {
  dispatchRunId: string;
  records: number;
  points: number;
  decisions: number;
}

const ENTRY_ORDER: Prisma.RunDiscrepancyEntryOrderByWithRelationInput[] = [
  { kind: 'asc' },
  { position: 'asc' },
];

export const runDiscrepancyRecordRepository = {
  /** Write a record and all its entries — ONE nested create. `tx` required — a write. */
  async create(
    input: RunDiscrepancyRecordInput,
    tx: Prisma.TransactionClient,
  ): Promise<RunDiscrepancyRecordWithEntries> {
    const { entries, recordedAt, ...record } = input;
    return tx.runDiscrepancyRecord.create({
      data: {
        ...record,
        ...(recordedAt ? { recordedAt } : {}),
        entries: {
          create: entries.map((entry) => ({ ...entry, workspaceId: input.workspaceId })),
        },
      },
      include: { entries: { orderBy: ENTRY_ORDER } },
    });
  },

  /** The record a leg holds, if any — the writer's dedupe and the backfill's. */
  async findByLeg(
    dispatchRunCardId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ id: string } | null> {
    return tx.runDiscrepancyRecord.findUnique({
      where: { dispatchRunCardId },
      select: { id: true },
    });
  },

  /** The record a comment is the view of, if any — the backfill's other dedupe. */
  async findByCommentId(
    commentId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ id: string } | null> {
    return tx.runDiscrepancyRecord.findUnique({ where: { commentId }, select: { id: true } });
  },

  /** Every record one run's legs hold, with entries, oldest first. */
  async listByRun(
    dispatchRunId: string,
    tx: Prisma.TransactionClient,
  ): Promise<RunDiscrepancyRecordWithEntries[]> {
    return tx.runDiscrepancyRecord.findMany({
      where: { dispatchRunId },
      include: { entries: { orderBy: ENTRY_ORDER } },
      orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
    });
  },

  /** Per run, how many records its legs hold and how many points and decisions in them. */
  async countsByRuns(
    dispatchRunIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<RunDiscrepancyRunCounts[]> {
    if (dispatchRunIds.length === 0) return [];
    const groups = await tx.runDiscrepancyRecord.groupBy({
      by: ['dispatchRunId'],
      where: { dispatchRunId: { in: [...dispatchRunIds] } },
      _count: { _all: true },
      _sum: { pointCount: true, decisionCount: true },
    });
    return groups.map((g) => ({
      dispatchRunId: g.dispatchRunId!,
      records: g._count._all,
      points: g._sum.pointCount ?? 0,
      decisions: g._sum.decisionCount ?? 0,
    }));
  },
};
