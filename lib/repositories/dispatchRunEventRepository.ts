import type { DispatchRunEvent, Prisma } from '@/generated/prisma/client';

// Single Prisma operations on `dispatch_run_event` — the ordered stream (Story
// MOTIR-1789 · MOTIR-1791, ADR `docs/decisions/dispatch-run-record.md`).
//
// `tx` on every method, reads included: the table is RLS-gated on
// `app.workspace_id` (see `dispatchRunRepository`'s header).
//
// ⚠️ EVERY READ ORDERS BY `seq`, NEVER BY `created_at`. Two events written in the
// same millisecond have no order at all under a timestamp, and the SSE stream's
// entire contract is *"give me everything after `seq`"* — an order that
// occasionally disagrees with itself would show a reader an agent exiting before
// it started, intermittently, on a fast machine.

export const dispatchRunEventRepository = {
  /**
   * Append a batch. `tx` required — a write.
   *
   * `skipDuplicates` makes a REDELIVERED batch converge on the rows it already
   * wrote instead of failing the whole append: the unique `(dispatch_run_id,
   * seq)` is the append's idempotency key, and a reporter that retries after a
   * timeout has no way to know whether its first attempt landed. Returning the
   * count lets the caller say how many were actually new.
   */
  async createMany(
    data: Prisma.DispatchRunEventCreateManyInput[],
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.dispatchRunEvent.createMany({ data, skipDuplicates: true });
    return result.count;
  },

  /**
   * THE TAILING READ — everything after `sinceSeq`, in `seq` order.
   *
   * `sinceSeq` is EXCLUSIVE and 0 means "from the beginning", so a client that
   * has seen nothing and a client resuming from event 400 use the same call.
   * `take` bounds one page: a run with an opt-in log body can hold thousands of
   * events, and the stream sends them in chunks rather than one response.
   */
  async listSince(
    dispatchRunId: string,
    sinceSeq: number,
    take: number,
    tx: Prisma.TransactionClient,
  ): Promise<DispatchRunEvent[]> {
    return tx.dispatchRunEvent.findMany({
      where: { dispatchRunId, seq: { gt: sinceSeq } },
      orderBy: { seq: 'asc' },
      take,
    });
  },

  /** One leg's slice of the stream — the card page's run section. */
  async listByCardSince(
    dispatchRunCardId: string,
    sinceSeq: number,
    take: number,
    tx: Prisma.TransactionClient,
  ): Promise<DispatchRunEvent[]> {
    return tx.dispatchRunEvent.findMany({
      where: { dispatchRunCardId, seq: { gt: sinceSeq } },
      orderBy: { seq: 'asc' },
      take,
    });
  },

  /**
   * The highest `seq` this run has stored, or `null` for a run with no events.
   *
   * ⚠️ THIS IS THE ALLOCATOR'S INPUT, AND IT IS ONLY SAFE UNDER THE RUN'S ROW
   * LOCK. `dispatchRunService.appendEvents` takes
   * `dispatchRunRepository.findTerminalStateForUpdate` first and numbers from
   * this value; read WITHOUT that lock it hands two concurrent appenders the
   * same number, and the unique index then rejects one of their batches —
   * turning a routine retry into a lost stream. It is also the answer a RESUMING
   * READER wants (how far along is this run), which needs no lock at all: the
   * two callers differ in what they do next, not in what they read.
   */
  async maxSeq(dispatchRunId: string, tx: Prisma.TransactionClient): Promise<number | null> {
    const row = await tx.dispatchRunEvent.aggregate({
      where: { dispatchRunId },
      _max: { seq: true },
    });
    return row._max.seq;
  },

  /**
   * How many events a run holds — the ingest cap's own read (ADR Q4: a run stops
   * accepting events at 5 000 and records that it did).
   */
  /**
   * Has this run already recorded THIS finding? (MOTIR-3981.)
   *
   * ⚠️ THE IDEMPOTENCY GUARD, and it is needed because one finding is reachable
   * from more than one seam: a bug filed with its `relates_to` in the create
   * call and a bug linked afterwards arrive by different paths, and a plan can
   * reach `planned` again after a revision. One finding must be one row.
   *
   * Matched on the id INSIDE `data` rather than on a column, because the
   * identity is the thing found and it differs per kind — `workItemId` for a
   * bug, `planId` for a plan, and `dispatchRunCardId` for a run-found report
   * (MOTIR-6282: ONE report per LEG, whatever it concluded). All three are
   * written by `recordFinding`, so the path is not a guess about somebody
   * else's payload.
   */
  async findFindingOnRun(
    dispatchRunId: string,
    kind: 'bug_filed' | 'plan_submitted' | 'unbuildable_reported' | 'discrepancy_recorded',
    findingId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ id: string } | null> {
    const path =
      kind === 'bug_filed'
        ? ['workItemId']
        : kind === 'plan_submitted'
          ? ['planId']
          : ['dispatchRunCardId'];
    return tx.dispatchRunEvent.findFirst({
      where: { dispatchRunId, kind, data: { path, equals: findingId } },
      select: { id: true },
    });
  },

  /**
   * Every `discrepancy_recorded` finding on a run, oldest first (MOTIR-10240) —
   * the leg it belongs to and its `data` POINTER (`{ commentId, pointCount,
   * decisionCount?, dispatchRunCardId }`). The text lives in the comment the
   * pointer names; `runRecordReadService` reads it from there.
   */
  async listDiscrepancyFindings(
    dispatchRunId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Pick<DispatchRunEvent, 'dispatchRunCardId' | 'data'>[]> {
    return tx.dispatchRunEvent.findMany({
      where: { dispatchRunId, kind: 'discrepancy_recorded' },
      orderBy: { seq: 'asc' },
      select: { dispatchRunCardId: true, data: true },
    });
  },

  /**
   * The LATEST event of one kind on a run, or null — how the Development block
   * reads a give-up's attempt count off the `ci_gave_up` event the CLI wrote
   * (MOTIR-5466). The count is DATA the run reported, never a literal.
   */
  async findLatestOfKind(
    dispatchRunId: string,
    kind: DispatchRunEvent['kind'],
    tx: Prisma.TransactionClient,
    /** Narrow the read to one leg's events (MOTIR-9046); null reads the run's newest. */
    cardId: string | null = null,
  ): Promise<Pick<DispatchRunEvent, 'data'> | null> {
    return tx.dispatchRunEvent.findFirst({
      where: { dispatchRunId, kind, ...(cardId === null ? {} : { dispatchRunCardId: cardId }) },
      orderBy: { seq: 'desc' },
      select: { data: true },
    });
  },

  /**
   * A HOSTED run's closing line (MOTIR-691), or null — the `log` event the end
   * path (`hostedRunService.endHostedRun`) writes with `data.end`, naming which
   * end it was. The run panel quotes it as the run's reason line. A run the CLI
   * closed itself has none. Its BODY may be null once the retention sweep has
   * cleared it; `data.end` survives the sweep.
   */
  async findHostedEndLine(
    dispatchRunId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Pick<DispatchRunEvent, 'body' | 'data'> | null> {
    return tx.dispatchRunEvent.findFirst({
      // Any string `end` — the outcome's name. `string_contains: ''` is the
      // path filter's "is a string" test, which is what the end path writes.
      where: { dispatchRunId, kind: 'log', data: { path: ['end'], string_contains: '' } },
      orderBy: { seq: 'desc' },
      select: { body: true, data: true },
    });
  },

  /**
   * The closing lines of SEVERAL runs, in ONE query (MOTIR-7029) — the `log`
   * events an end path writes with `data.end` (see {@link findHostedEndLine}),
   * newest first. The My agents panel quotes the latest one per run as its "Last
   * run" reason; the caller keeps the first row it sees for each run.
   */
  async listEndLinesForRuns(
    dispatchRunIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<Array<Pick<DispatchRunEvent, 'dispatchRunId' | 'data'>>> {
    if (dispatchRunIds.length === 0) return [];
    return tx.dispatchRunEvent.findMany({
      where: {
        dispatchRunId: { in: [...dispatchRunIds] },
        kind: 'log',
        data: { path: ['end'], string_contains: '' },
      },
      orderBy: { seq: 'desc' },
      select: { dispatchRunId: true, data: true },
    });
  },

  /**
   * When the run's LATEST event was written, or null — the hosted stall read
   * (MOTIR-690): a run whose newest event is older than the stall window has an
   * agent that is alive and silent. Ordered by `seq`, the server-assigned order.
   */
  async findLatestCreatedAt(
    dispatchRunId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Date | null> {
    const row = await tx.dispatchRunEvent.findFirst({
      where: { dispatchRunId },
      orderBy: { seq: 'desc' },
      select: { createdAt: true },
    });
    return row?.createdAt ?? null;
  },

  /**
   * The branches the run's newest `checkout_ready` recorded, ONE PER REPOSITORY
   * (MOTIR-6791) — for one leg, or for ANY leg of the run when `cardId` is null
   * (a scoped run's session branch is every leg's). Empty when none named one.
   *
   * Two writers shipped this event: MOTIR-6530's single `data.branch`, read as ONE
   * entry whose repository is unknown (`null`), and MOTIR-6539's per-repository
   * `data.branches: [{ repository, branch, workBranch }]`, primary first, read
   * whole. It used to keep only `branches[0]`, which lost every other
   * repository's work for a run that spanned several.
   */
  async findLatestCheckoutBranches(
    dispatchRunId: string,
    cardId: string | null,
    tx: Prisma.TransactionClient,
  ): Promise<Array<{ repository: string | null; branch: string }>> {
    const rows = await tx.dispatchRunEvent.findMany({
      where: {
        dispatchRunId,
        kind: 'checkout_ready',
        ...(cardId === null ? {} : { dispatchRunCardId: cardId }),
      },
      orderBy: { seq: 'desc' },
      select: { data: true },
      take: 20,
    });
    for (const row of rows) {
      const data = row.data as { branch?: unknown; branches?: unknown } | null;
      const scalar =
        typeof data?.branch === 'string' && data.branch.length > 0 ? data.branch : null;
      const out: Array<{ repository: string | null; branch: string }> = [];
      if (Array.isArray(data?.branches)) {
        for (const entry of data.branches as Array<{ repository?: unknown; branch?: unknown }>) {
          if (typeof entry?.branch !== 'string' || entry.branch.length === 0) continue;
          const repository =
            typeof entry.repository === 'string' && entry.repository.length > 0
              ? entry.repository
              : null;
          if (out.some((e) => e.repository === repository)) continue;
          out.push({ repository, branch: entry.branch });
        }
      }
      // The scalar names the PRIMARY's branch, and it is the authoritative one: a
      // continue's leg wrote the dead run's branch there while its `branches[]`
      // still named the card's fresh branch (fixed in the CLI by MOTIR-6793).
      if (out.length > 0) {
        if (scalar !== null) out[0] = { repository: out[0]!.repository, branch: scalar };
        return out;
      }
      if (scalar !== null) return [{ repository: null, branch: scalar }];
    }
    return [];
  },

  async countByRun(dispatchRunId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.dispatchRunEvent.count({ where: { dispatchRunId } });
  },

  /**
   * The RETENTION SWEEP's CROSS-TENANT discovery read (MOTIR-1792): which
   * workspaces still hold a log body past the cut-off.
   *
   * ⚠️ RUNS UNDER `withSystemContext`, for the same reason the run reap's
   * discovery does: an expiring body is in whichever tenant happened to opt in,
   * and the sweep cannot bind a workspace it has not learned yet. It returns
   * WORKSPACE IDS and nothing else — the bodies themselves are never read
   * cross-tenant, only counted — and the clearing write then re-binds per
   * workspace.
   */
  async listWorkspacesWithExpiredBodies(
    createdBefore: Date,
    take: number,
    tx: Prisma.TransactionClient,
  ): Promise<string[]> {
    const rows = await tx.dispatchRunEvent.findMany({
      where: { createdAt: { lt: createdBefore }, body: { not: null } },
      select: { workspaceId: true },
      distinct: ['workspaceId'],
      orderBy: { workspaceId: 'asc' },
      take,
    });
    return rows.map((r) => r.workspaceId);
  },

  /**
   * The RETENTION SWEEP's write (MOTIR-1792): null the opt-in log BODIES older
   * than the cut-off, leaving the events themselves.
   *
   * ⚠️ IT NULLS `body`, IT DOES NOT DELETE ROWS. The lifecycle is the run's
   * memory of what it did and is kept; the body is the only private, unbounded,
   * low-half-life part of it. Deleting the rows would silently renumber nothing
   * — `seq` is stored — but it would put HOLES in a stream whose readers resume
   * by cursor, and a reader that asks for everything after 400 and is handed 500
   * cannot tell a deleted event from one that has not happened yet.
   */
  async clearBodiesOlderThan(createdBefore: Date, tx: Prisma.TransactionClient): Promise<number> {
    const result = await tx.dispatchRunEvent.updateMany({
      where: { createdAt: { lt: createdBefore }, body: { not: null } },
      data: { body: null },
    });
    return result.count;
  },
};
