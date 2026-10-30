import type { DispatchRunCard, Prisma } from '@/generated/prisma/client';

// Single Prisma operations on `dispatch_run_card` — one LEG per card a run owns
// (Story MOTIR-1789 · MOTIR-1791, ADR `docs/decisions/dispatch-run-record.md`).
//
// `tx` on every method, reads included: the table is RLS-gated on
// `app.workspace_id`, and a read outside a bound transaction returns an empty
// list rather than an error (see `dispatchRunRepository`'s header for the full
// argument).
//
// ⚠️ A LEG WHOSE `work_item_id` HAS GONE NULL IS A LEG, NOT A BROKEN ROW. The FK
// is `SET NULL` so a run's history outlives a deleted card, and `work_item_key`
// keeps the key the run actually saw. Nothing here filters those rows out, and
// nothing here throws on one — every renderer downstream has to handle the null
// arm, so the repository must not hide it by returning a shorter list than the
// run's own `position` sequence implies.

export const dispatchRunCardRepository = {
  /**
   * The run's SET, written in one op.
   *
   * `createMany` rather than N creates because the set is settled at once — a
   * scope claim returns every member in one transaction, and a batch snapshot is
   * frozen before anything is dispatched. Writing them one at a time would leave
   * a window in which a reader sees half a run's plan, which is precisely the
   * thing storing the set is for.
   */
  async createMany(
    data: Prisma.DispatchRunCardCreateManyInput[],
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.dispatchRunCard.createMany({ data });
    return result.count;
  },

  /**
   * ONE leg appended after the fact — `motir auto`, which holds no plan and
   * discovers its set one card per iteration.
   *
   * Its own method rather than a one-element {@link createMany} because it needs
   * the created row back: the appending caller has to know the leg's id to hang
   * the iteration's events off it.
   */
  async create(
    data: Prisma.DispatchRunCardCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<DispatchRunCard> {
    return tx.dispatchRunCard.create({ data });
  },

  /** The run's legs in its own stored order. Never re-derive that order. */
  async listByRun(dispatchRunId: string, tx: Prisma.TransactionClient): Promise<DispatchRunCard[]> {
    return tx.dispatchRunCard.findMany({
      where: { dispatchRunId },
      orderBy: { position: 'asc' },
    });
  },

  /**
   * Several runs' legs, as `(run, card, position)` only (MOTIR-7589) — the order a dead
   * run's To fix entry lists the cards it carried in (§ 34.2). A leg whose card is gone
   * comes back with a null `workItemId`, which the caller has nothing to order by.
   */
  async listPositionsByRuns(
    dispatchRunIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<{ dispatchRunId: string; workItemId: string | null; position: number }[]> {
    if (dispatchRunIds.length === 0) return [];
    return tx.dispatchRunCard.findMany({
      where: { dispatchRunId: { in: [...dispatchRunIds] } },
      select: { dispatchRunId: true, workItemId: true, position: true },
      orderBy: [{ dispatchRunId: 'asc' }, { position: 'asc' }],
    });
  },

  /**
   * Which cards these runs carried — one `(run, card)` pair per leg (MOTIR-8458): a
   * To resume member with no leg in its run is one the run never touched. A leg whose
   * card is gone comes back with a null `workItemId`.
   */
  async listWorkItemIdsByRuns(
    dispatchRunIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<{ dispatchRunId: string; workItemId: string | null }[]> {
    return tx.dispatchRunCard.findMany({
      where: { dispatchRunId: { in: [...dispatchRunIds] } },
      select: { dispatchRunId: true, workItemId: true },
    });
  },

  /**
   * One leg, addressed the way a reporter addresses it: by the run and the card.
   *
   * ⚠️ `workItemId` IS NULLABLE AND THE UNIQUE INDEX TREATS NULLS AS DISTINCT, so
   * this lookup is only meaningful for a leg whose card still exists. A caller
   * holding a null has no leg to find and must address it by `id` instead —
   * which is why this returns `null` for a null `workItemId` rather than
   * matching an arbitrary orphan.
   */
  async findByRunAndWorkItem(
    dispatchRunId: string,
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<DispatchRunCard | null> {
    return tx.dispatchRunCard.findUnique({
      where: { dispatchRunId_workItemId: { dispatchRunId, workItemId } },
    });
  },

  /** One leg by its own id — the address that keeps working after the card is gone. */
  async findById(id: string, tx: Prisma.TransactionClient): Promise<DispatchRunCard | null> {
    return tx.dispatchRunCard.findUnique({ where: { id } });
  },

  /**
   * The card's own leg history, newest first — every run that has worked it.
   *
   * Cursor-paginated for the same reason the run history is: a card worked
   * nightly accumulates one leg per night, for ever.
   */
  async listByWorkItem(
    workItemId: string,
    { take, cursor }: { take: number; cursor?: string | undefined },
    tx: Prisma.TransactionClient,
  ): Promise<DispatchRunCard[]> {
    return tx.dispatchRunCard.findMany({
      where: { workItemId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  },

  /**
   * The leg that is OPEN for this work item right now — the one a finding
   * written this instant belongs to (MOTIR-3981,
   * `run-findings-protocol.md` Q5).
   *
   * ⚠️ OPEN means `ended_at IS NULL` on a leg whose RUN is still running, and
   * both halves are load-bearing. A leg alone can sit unsettled forever on a
   * run that was reaped; a run alone says nothing about whether THIS work item
   * is still in flight on it. Newest first, so a work item that somehow has two
   * resolves to the one that started last.
   *
   * Returning null is an ORDINARY answer, not an error: a bug filed in the app,
   * a plan submitted from the project-wide panel and every write by somebody
   * who is not running anything all land here, and none of them belongs to a
   * run.
   */
  async findOpenLegForWorkItem(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<DispatchRunCard | null> {
    return tx.dispatchRunCard.findFirst({
      where: { workItemId, endedAt: null, dispatchRun: { status: 'running' } },
      orderBy: [{ startedAt: 'desc' }, { createdAt: 'desc' }],
    });
  },

  /**
   * Whether a run is WORKING this work item right now — an open leg, as
   * {@link findOpenLegForWorkItem} defines it, on any run but a `review` (bug
   * MOTIR-10102). An approve that re-scopes a built card asks it to choose
   * `in_progress` over `todo`. A hosted review reads the card and builds nothing,
   * so it holds no claim on the work; a `fix` or `continue` run does, because its
   * open run IS the repair or takeover lock.
   */
  async hasWorkingLegForWorkItem(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const leg = await tx.dispatchRunCard.findFirst({
      where: {
        workItemId,
        endedAt: null,
        dispatchRun: { status: 'running', command: { not: 'review' } },
      },
      select: { id: true },
    });
    return leg !== null;
  },

  /**
   * The leg that was OPEN for this work item AT A GIVEN INSTANT — the one a
   * finding whose act happened then belongs to, even when it is recorded later
   * (MOTIR-6279).
   *
   * ⚠️ A SUBMITTED PLAN IS RECORDED LONG AFTER IT WAS SUBMITTED. The agent's
   * `submit_plan_session` opens the plan `generating` and returns at once; the
   * agent exits, the CLI settles the leg `replanned` and may close the run, and
   * only then does the model finish and the plan reach `planned`. By that time
   * {@link findOpenLegForWorkItem} finds nothing, so the question has to be
   * asked about the instant the plan was CREATED, not the instant it closed.
   *
   * Spanning means `started_at <= at` and the leg had not ended by `at`: either
   * `ended_at >= at`, or it is still unsettled on a run that is still running —
   * the same two halves `findOpenLegForWorkItem` holds, for the one leg that
   * has not ended yet. A leg that never started (`queued`, `skipped`) spans
   * nothing. Newest first, as there.
   */
  async findLegSpanningInstantForWorkItem(
    workItemId: string,
    at: Date,
    tx: Prisma.TransactionClient,
  ): Promise<DispatchRunCard | null> {
    return tx.dispatchRunCard.findFirst({
      where: {
        workItemId,
        startedAt: { lte: at },
        OR: [{ endedAt: { gte: at } }, { endedAt: null, dispatchRun: { status: 'running' } }],
      },
      orderBy: [{ startedAt: 'desc' }, { createdAt: 'desc' }],
    });
  },

  /**
   * Advance one leg. `tx` required — a write.
   *
   * ⚠️ THE `skip_reason` CHECK CONSTRAINT IS THE ARBITER, NOT THIS METHOD. The
   * migration asserts `(disposition = 'skipped') = (skip_reason IS NOT NULL)` in
   * both directions, so an update that sets one without the other is refused by
   * the database rather than by a rule someone can forget to re-state here.
   */
  async update(
    id: string,
    data: Prisma.DispatchRunCardUpdateInput,
    tx: Prisma.TransactionClient,
  ): Promise<DispatchRunCard> {
    return tx.dispatchRunCard.update({ where: { id }, data });
  },
};
