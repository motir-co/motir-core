import { Prisma, type JobRun, type JobRunStatus } from '@/generated/prisma/client';

// Data access for the job_run ledger (Story 1.6 · Subtask 1.6.2). Single-op
// methods only; writes require `tx` (the 4-layer contract). jobRunsService
// owns the transactions and the DTO mapping.
export const jobRunRepository = {
  /** Read one run by id. Used inside the finish transaction to read startedAt. */
  async findById(id: string, tx: Prisma.TransactionClient): Promise<JobRun | null> {
    return tx.jobRun.findUnique({ where: { id } });
  },

  /**
   * Find the UNSETTLED row for a given (function, event), newest first. This is
   * how the TERMINAL-FAILURE path (1.6.6) correlates the failure back to the row
   * that `recordStart` wrote: the failure is reported by Inngest's `onFailure`
   * handler — a SEPARATE invocation from the run that created the row — which
   * carries the original event but not the row id. The `@@index([eventId])`
   * exists precisely for this lookup. Read inside the failure transaction, so it
   * takes `tx`.
   *
   * ⚠️ `abandoned` COUNTS AS UNSETTLED (Bug MOTIR-3683), and it is why this is no
   * longer called `findRunningByEventId`. The reap closes a row nothing appears
   * to be holding; a terminal failure arriving afterwards is the run turning out
   * to have been held after all, and it knows something the reap only guessed —
   * the error. Correlating onto that row REPLACES the guess. Excluding it would
   * write a SECOND row instead, which is the exact defect this bug is about.
   */
  async findUnsettledByEventId(
    eventId: string,
    functionId: string,
    tx: Prisma.TransactionClient,
  ): Promise<JobRun | null> {
    return tx.jobRun.findFirst({
      where: { eventId, functionId, status: { in: ['running', 'abandoned'] } },
      orderBy: { startedAt: 'desc' },
    });
  },

  /**
   * The id of the UNSETTLED row for a given (function, event) — the ledger row
   * a run in flight is writing under (Bug MOTIR-9454). The index job stamps it on
   * the repository it claims, because every reader of that claim joins it to
   * `job_run` ids. The engine's `ctx.runId` is the `job_queue` row id, a
   * different row, so it is never the value to stamp.
   *
   * Same predicate as {@link findUnsettledByEventId}, narrowed to the id.
   */
  async findUnsettledIdByEventId(
    eventId: string,
    functionId: string,
    tx: Prisma.TransactionClient,
  ): Promise<string | null> {
    const row = await tx.jobRun.findFirst({
      where: { eventId, functionId, status: { in: ['running', 'abandoned'] } },
      orderBy: { startedAt: 'desc' },
      select: { id: true },
    });
    return row?.id ?? null;
  },

  /**
   * Insert the initial `running` row. Uses the UNCHECKED create input (scalar
   * `workspaceId` FK) rather than a `workspace: { connect }` relation: the job
   * runtime writes under the system-admin context with NO workspace context, so
   * a `connect` — which issues a SELECT on `workspace` to validate the related
   * row — would be hidden by the workspace table's RLS and fail. The scalar FK
   * sets the column directly; referential integrity is still enforced by the
   * Postgres FK constraint (FK checks are not subject to RLS).
   */
  async create(
    data: Prisma.JobRunUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<JobRun> {
    return tx.jobRun.create({ data });
  },

  /**
   * THE ABANDONED-RUN DISCOVERY READ (Bug MOTIR-3683) — rows still `running`
   * that started before `startedBefore`, oldest first.
   *
   * ⚠️ IT DELIBERATELY DOES NOT ASK WHETHER THE RUN IS ALIVE, and the caller
   * does. A ledger row carries no link to the queue row that would answer that:
   * the correlation is `(function_id, event_id)` against `job_queue`, which is
   * the service's join to make. Keeping it out of here keeps this a single-op
   * repository method (the 4-layer contract) and keeps the liveness rule — the
   * part that decides whether a long run is working or dead — readable in one
   * place instead of buried in a `where`.
   *
   * Bounded by `limit` so a first pass over a long-neglected ledger drains in
   * several sweeps rather than holding one transaction across the whole backlog.
   */
  async findStaleRunning(
    startedBefore: Date,
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<JobRun[]> {
    return tx.jobRun.findMany({
      where: { status: 'running', startedAt: { lt: startedBefore } },
      orderBy: { startedAt: 'asc' },
      take: limit,
    });
  },

  /**
   * Flip one stranded row to `abandoned` — GUARDED ON IT STILL BEING `running`.
   *
   * The guard is the whole point: the sweep reads its candidates in one
   * transaction and writes them in another, and in between a worker that was
   * merely slow can settle the very run being reaped. `updateMany` with the
   * status in the `where` makes that a no-op returning `count: 0` instead of a
   * write that overwrites a real terminal state with `abandoned` — losing the
   * failure the operator actually needed to see.
   */
  async markAbandonedIfRunning(
    id: string,
    finishedAt: Date,
    failure: Prisma.InputJsonValue,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const res = await tx.jobRun.updateMany({
      where: { id, status: 'running' },
      data: { status: 'abandoned', finishedAt, failure },
    });
    return res.count;
  },

  /**
   * THE RETENTION KEEP-SET, part 1 (Bug MOTIR-6935) — the newest row of every
   * event name, across ALL workspaces.
   *
   * The schedule-health check (`findLatestStartedAtByEventNames`) and the
   * operator console's last-health-check card (`findLatestByEventName`) both
   * read "the latest run of X", however old it is. A job whose cadence is longer
   * than the retention window — or one that simply stopped firing, which is the
   * exact fact the health check exists to report — must keep that row, or the
   * purge would turn "last ran 40 days ago" into "never ran".
   *
   * One row per distinct event name, so the set is as small as the job
   * registry. Caller MUST supply a `withSystemContext` tx (untenanted rows).
   */
  async findLatestIdPerEventName(tx: Prisma.TransactionClient): Promise<string[]> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT DISTINCT ON ("event_name") "id" FROM "job_run"
      ORDER BY "event_name", "started_at" DESC, "id" DESC
    `;
    return rows.map((row) => row.id);
  },

  /**
   * THE RETENTION KEEP-SET, part 2 (Bug MOTIR-6935) — the newest SUCCEEDED
   * code-graph run per (function, workspace, repository).
   *
   * `listSucceededCodeGraphIndexRepoRefs` answers "has this repository EVER been
   * indexed?" from these rows, and `findSucceededCodeGraphIndex` is the
   * migrate wizard's readiness signal. A repository indexed once and never
   * pushed to again has exactly one such row; purging it on age would make the
   * gate re-index the repository and the wizard wait for an index that already
   * exists. Keyed on `output.repoRef`, the only attribution a succeeded run has
   * (a `{ indexed: false }` success carries none and is not an index).
   */
  async findLatestSucceededCodeGraphRunIds(tx: Prisma.TransactionClient): Promise<string[]> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT DISTINCT ON ("function_id", "workspace_id", "output"->>'repoRef') "id"
      FROM "job_run"
      WHERE "function_id" IN ('system.code-graph-index', 'system.code-graph-refresh')
        AND "status" = 'succeeded'
        AND "output"->>'repoRef' IS NOT NULL
      ORDER BY "function_id", "workspace_id", "output"->>'repoRef', "started_at" DESC, "id" DESC
    `;
    return rows.map((row) => row.id);
  },

  /**
   * THE RETENTION CANDIDATES (Bug MOTIR-6935) — terminal rows that started
   * before `startedBefore`, oldest first, bounded by `limit`.
   *
   * Excluded here, because each is a join to another table and is only true at
   * the moment of the delete:
   *   - a row whose QUEUE RUN is still live — the same `(job_id, event ref)`
   *     correlation the abandoned-run reap uses (`countLiveForEventRef`), so a
   *     retried run's earlier attempt is never removed from under it;
   *   - a row a repository's `indexing_run_id` POINTS AT — `deriveRefreshFailing`
   *     reads a terminal row there as "this repository's refresh is dead", and
   *     deleting it would silently clear that warning.
   * `keepIds` carries the two keep-sets above, computed once per pass.
   */
  async findExpiredTerminalIds(
    startedBefore: Date,
    keepIds: string[],
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<string[]> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT r."id" FROM "job_run" r
      WHERE r."status" IN ('succeeded', 'failed', 'abandoned')
        AND r."started_at" < ${startedBefore}
        AND r."id" <> ALL(${keepIds}::text[])
        AND NOT EXISTS (
          SELECT 1 FROM "job_queue" q
          WHERE q."job_id" = r."function_id"
            AND q."state" IN ('pending', 'running')
            AND (q."event_id" = r."event_id" OR q."id" = r."event_id")
        )
        AND NOT EXISTS (SELECT 1 FROM "github_repo" g WHERE g."indexing_run_id" = r."id")
      ORDER BY r."started_at" ASC
      LIMIT ${limit}
    `;
    return rows.map((row) => row.id);
  },

  /**
   * Delete the given rows — GUARDED ON THEM STILL BEING TERMINAL, so a row that
   * somehow left a terminal state between the read and this write survives.
   */
  async deleteTerminalByIds(ids: string[], tx: Prisma.TransactionClient): Promise<number> {
    if (ids.length === 0) return 0;
    const res = await tx.jobRun.deleteMany({
      where: { id: { in: ids }, status: { in: ['succeeded', 'failed', 'abandoned'] } },
    });
    return res.count;
  },

  /** Patch a run on completion (status / finishedAt / durationMs / failure). */
  async update(
    id: string,
    data: Prisma.JobRunUpdateInput,
    tx: Prisma.TransactionClient,
  ): Promise<JobRun> {
    return tx.jobRun.update({ where: { id }, data });
  },

  /**
   * The migrate-onboarding INDEX-readiness poll (Story 7.15 · MOTIR-931): the
   * newest SUCCEEDED `system.code-graph-index` run for this workspace whose
   * ledger `output.repoRef` is the connected repo. The code-graph index job is
   * fire-and-forget (enqueued by the GitHub grant flow, `enqueueCodeGraphIndex`)
   * and is NOT a motir-ai JobKind, so its terminal state is read HERE from the
   * job_run ledger — the durable completion signal the migrate wizard's `index`
   * step waits on (it "waits, does not index"). Matching `output.repoRef` keeps a
   * stale index of a DIFFERENT repo from counting. Takes `tx` so it runs under
   * the caller's `withWorkspaceContext` (the job_run RLS policy scopes it).
   */
  async findSucceededCodeGraphIndex(
    workspaceId: string,
    repoRef: string,
    tx: Prisma.TransactionClient,
  ): Promise<JobRun | null> {
    return tx.jobRun.findFirst({
      where: {
        workspaceId,
        functionId: 'system.code-graph-index',
        status: 'succeeded',
        output: { path: ['repoRef'], equals: repoRef },
      },
      orderBy: { finishedAt: 'desc' },
    });
  },

  /**
   * The FIRST-INDEX recovery read (MOTIR-1961): every repo of this workspace
   * that ALREADY has a code graph — the `output.repoRef` of each SUCCEEDED
   * `system.code-graph-index` run. The set form of
   * {@link findSucceededCodeGraphIndex}, for the enqueue gate that must decide
   * "has this repo ever been indexed?" for a WHOLE repo set in one round-trip
   * instead of N per-repo reads.
   *
   * Scope note: this answers "a first graph EXISTS", not "the graph is FRESH".
   * Staleness (graph commit vs the default-branch head) is MOTIR-1754/1766's
   * axis and deliberately not read here — a repo that never got a first graph
   * cannot be stale, so the two questions never overlap.
   *
   * Takes `tx`: run it under `withWorkspaceContext` (the RLS policy scopes it)
   * or `withSystemContext` (the grant/webhook paths, which have no active
   * workspace — the policy's system-admin branch admits them).
   */
  /**
   * ⚠️ THE RUNS THAT WILL NEVER FINISH (Story MOTIR-1754 · MOTIR-2105) — every
   * code-graph run in a TERMINAL failure state, by id.
   *
   * The caller resolves these against `GithubRepo.indexingRunId`, exactly as the
   * running-state read does, because the pointer is the only attribution that
   * exists: the index job writes `output.repoRef` only on success, so a `failed`
   * or `abandoned` row cannot say which repository it belonged to.
   *
   * ⚠️ BOTH FUNCTIONS, because a REFRESH and a first INDEX are the same fact to
   * a reader — the graph is behind and nothing is coming — and reading only one
   * of them would leave the other silently stale, which is the shape this whole
   * card exists to end.
   *
   * ⚠️ AND BOTH TERMINAL STATUSES. `failed` is "the handler threw" and
   * `abandoned` is "nothing ever came back"; the schema keeps them apart because
   * only one has a stack trace, and for THIS question they are one answer.
   *
   * Ids rather than refs, so the join is the caller's and this stays a single
   * Prisma operation.
   */
  async listTerminalCodeGraphRunIds(
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<string[]> {
    const rows = await tx.jobRun.findMany({
      where: {
        workspaceId,
        functionId: { in: ['system.code-graph-index', 'system.code-graph-refresh'] },
        status: { in: ['failed', 'abandoned'] },
      },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  },

  /**
   * The ids of the workspace's `system.code-graph-index` runs still `running` —
   * the half of the pointer rule that says `indexing` (MOTIR-8768). A running row
   * carries no `output.repoRef`, so a repository is indexing only when its
   * `GithubRepo.indexingRunId` is in this set; a crashed run's pointer names an
   * `abandoned` row and is simply absent. Ids, so the join stays the caller's.
   */
  async listRunningCodeGraphIndexRunIds(
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<string[]> {
    const rows = await tx.jobRun.findMany({
      where: { workspaceId, functionId: 'system.code-graph-index', status: 'running' },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  },

  async listSucceededCodeGraphIndexRepoRefs(
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<string[]> {
    const rows = await tx.jobRun.findMany({
      where: {
        workspaceId,
        functionId: 'system.code-graph-index',
        status: 'succeeded',
      },
      select: { output: true },
    });
    const refs = new Set<string>();
    for (const row of rows) {
      const output = row.output as { repoRef?: unknown } | null;
      // A succeeded run that indexed NOTHING (`{ indexed: false, reason }` —
      // the installation/workspace vanished, or the workspace had no projects)
      // carries no `repoRef` and must NOT count as an index.
      if (output && typeof output.repoRef === 'string') refs.add(output.repoRef);
    }
    return [...refs];
  },

  /**
   * The migrate-onboarding INDEX-progress read (Story 7.15 · MOTIR-934): is a
   * `system.code-graph-index` run CURRENTLY indexing ANY repo for this workspace?
   * The wizard's Index step shows an aggregate "indexing in progress" spinner when
   * this returns a row. Unlike {@link findSucceededCodeGraphIndex} this is NOT
   * keyed by `repoRef`: a `running` row has no `output.repoRef` (the index job
   * writes `output` only on success), so the ledger cannot say WHICH repo a running
   * row belongs to — only that one is in flight. Per-repo status is therefore
   * `indexed` (a succeeded row matches) vs `pending` (not yet); the running flag is
   * aggregate. Takes `tx` so it runs under the caller's `withWorkspaceContext`.
   */
  async findRunningCodeGraphIndexForWorkspace(
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<JobRun | null> {
    return tx.jobRun.findFirst({
      where: {
        workspaceId,
        functionId: 'system.code-graph-index',
        status: 'running',
      },
      orderBy: { startedAt: 'desc' },
    });
  },

  /**
   * Dashboard read (1.6.5): a workspace's runs, newest-first, optionally
   * filtered by status, with limit/offset paging. Takes `tx` because the read
   * runs inside withWorkspaceContext so the job_run RLS policy scopes it; the
   * explicit `where.workspaceId` is the in-query scope that also holds in
   * dev/CI where the superuser bypasses RLS (defense-in-depth, mirrors
   * workspaceMembershipRepository.findMembersByWorkspace). Serves the
   * `[workspaceId, startedAt desc]` / `[workspaceId, status, startedAt desc]`
   * indexes from the 1.6.2 schema.
   */
  async listByWorkspace(
    workspaceId: string,
    opts: { status?: JobRunStatus; limit: number; offset: number },
    tx: Prisma.TransactionClient,
  ): Promise<JobRun[]> {
    return tx.jobRun.findMany({
      where: { workspaceId, ...(opts.status ? { status: opts.status } : {}) },
      orderBy: { startedAt: 'desc' },
      take: opts.limit,
      skip: opts.offset,
    });
  },

  /**
   * System-tab read (1.6.5): every run across all workspaces INCLUDING the
   * untenanted system rows (workspace_id IS NULL). No workspace filter — the
   * caller MUST run this under withSystemContext (the only context whose RLS
   * branch admits null-workspace rows), and the dashboard only reaches it for
   * platform staff (`support` or above). Newest-first, paged.
   */
  async listAll(
    opts: { status?: JobRunStatus; limit: number; offset: number },
    tx: Prisma.TransactionClient,
  ): Promise<JobRun[]> {
    return tx.jobRun.findMany({
      where: { ...(opts.status ? { status: opts.status } : {}) },
      orderBy: { startedAt: 'desc' },
      take: opts.limit,
      skip: opts.offset,
    });
  },

  /**
   * Newest `started_at` per event name, across ALL workspaces (MOTIR-1970).
   *
   * The schedule-health check asks "when did each cron job last actually run?",
   * which is one aggregate over the whole ledger rather than N per-job reads —
   * hence a single `groupBy`. Like `listAll` it has no workspace filter, so the
   * caller MUST supply a `withSystemContext` tx (the only RLS branch that admits
   * the untenanted `workspace_id IS NULL` rows every `system.*` job writes).
   *
   * Keyed on `eventName`, not `functionId`, because that is what identifies a
   * SCHEDULED run: `defineJob` records a cron run's event name as the synthetic
   * `scheduled.{id}`, so keying on it counts only genuine cron ticks and never a
   * manual replay of the same function from the DLQ.
   */
  async findLatestStartedAtByEventNames(
    eventNames: string[],
    tx: Prisma.TransactionClient,
  ): Promise<Array<{ eventName: string; latestStartedAt: Date }>> {
    const rows = await tx.jobRun.groupBy({
      by: ['eventName'],
      where: { eventName: { in: eventNames } },
      _max: { startedAt: true },
    });
    // `_max.startedAt` types as nullable because Prisma cannot know the column
    // is not — but `started_at` is NOT NULL and `groupBy` never returns an empty
    // group, so a returned row always has a max. Asserting it here keeps the
    // impossible case out of the caller as a branch it could never exercise.
    return rows.map((row) => ({ eventName: row.eventName, latestStartedAt: row._max.startedAt! }));
  },

  /**
   * Every SUCCEEDED code-graph index run, newest first, across ALL workspaces
   * (MOTIR-5027) — the population the rebuild-streak probe reads.
   *
   * Like `listAll` and `findLatestStartedAtByEventNames` it carries no workspace
   * filter, so the caller MUST supply a `withSystemContext` tx: `system.*` jobs
   * write `workspace_id IS NULL` and that is the only RLS branch which admits
   * those rows. Without it this returns ZERO rows and no error, which is
   * indistinguishable from "the feature never ran" — the wrong conclusion in
   * the expensive direction.
   *
   * ⚠️ BOTH FUNCTION IDS, deliberately. `system.code-graph-refresh` is the
   * push-driven refresh and `system.code-graph-index` the onboarding index; both
   * write `indexModes` through the same `finishIndexRun`, and a streak computed
   * over only one of them would be broken by the other's runs without ever
   * saying so.
   *
   * ⚠️ `status: 'succeeded'` IS THE PREDICATE, and it is load-bearing. A failed
   * run records no mode at all, so admitting one would insert a hole in the
   * streak that reads exactly like a `sync`.
   */
  async listSucceededCodeGraphRuns(
    tx: Prisma.TransactionClient,
    limit = 2000,
  ): Promise<Array<{ startedAt: Date; output: Prisma.JsonValue | null }>> {
    return tx.jobRun.findMany({
      where: {
        functionId: { in: ['system.code-graph-refresh', 'system.code-graph-index'] },
        status: 'succeeded',
      },
      select: { startedAt: true, output: true },
      orderBy: { startedAt: 'desc' },
      take: limit,
    });
  },

  /**
   * The most recent run of one event name, across ALL workspaces (MOTIR-1167).
   *
   * The operator console's "Last health check" signal: the `job_run` row for
   * `scheduled.system.daily-health-check`, whose `output` carries that tick's
   * probe verdicts and whose `started_at` is the timestamp the card reads. Like
   * `listAll` and `findLatestStartedAtByEventNames` it carries no workspace
   * filter, so the caller MUST supply a `withSystemContext` tx.
   *
   * Returns the WHOLE row rather than a timestamp, because the card also draws
   * how many probes ran and whether the tick succeeded — and both live in
   * columns the aggregate above deliberately drops.
   */
  async findLatestByEventName(
    eventName: string,
    tx: Prisma.TransactionClient,
  ): Promise<JobRun | null> {
    return tx.jobRun.findFirst({ where: { eventName }, orderBy: { startedAt: 'desc' } });
  },
};
