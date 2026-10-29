import type { Prisma, PreviewDeployment, PreviewDeploymentState } from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';
import { LIVE_PREVIEW_STATES, legalSourcesFor } from '@/lib/preview/states';

// Single-op data access for `preview_deployment` — Motir's own record of the
// preview it runs for one pull request (Story MOTIR-5766 · Subtask MOTIR-5772).
// The display store of what a HOST reports is `repo_deployment`
// (`repoDeploymentRepository`); nothing here reads or writes it.
//
// Writes run under withSystemContext from the webhook lifecycle and the reaper
// (a delivery has no tenant session), taking `tx`, which is what binds the GUC
// the table's policies read.

/** What a pull request's preview row is created or refreshed with. */
export interface PreviewDeploymentUpsert {
  workspaceId: string;
  repoId: string;
  pullRequestNumber: number;
  headSha: string;
  /** Chosen by `choosePreviewHostName` before the write. */
  host: string;
}

/** The columns a transition may write beside the state. */
export type PreviewDeploymentPatch = Partial<
  Pick<
    PreviewDeployment,
    | 'headSha'
    | 'failureReason'
    | 'flyAppName'
    | 'flyMachineId'
    | 'neonProjectId'
    | 'neonBranchId'
    | 'githubDeploymentId'
  >
>;

/** How many rows one stale scan returns at most. */
export const STALE_SCAN_LIMIT = 100;

export const previewDeploymentRepository = {
  /**
   * The pull request's ONE row: created `building` with its host, or — for a
   * row that exists — its head moved to `headSha` and nothing else. The state
   * moves only through `transition`; the host, once given, is never re-chosen.
   * A native `INSERT … ON CONFLICT` on `(repo_id, pull_request_number)`, so a
   * redelivered webhook cannot make two.
   */
  async upsertForPullRequest(
    input: PreviewDeploymentUpsert,
    tx: Prisma.TransactionClient,
  ): Promise<PreviewDeployment> {
    return tx.previewDeployment.upsert({
      where: {
        repoId_pullRequestNumber: {
          repoId: input.repoId,
          pullRequestNumber: input.pullRequestNumber,
        },
      },
      create: input,
      update: { headSha: input.headSha },
    });
  },

  /**
   * Move a row to `to` IF it is in one of `from` AND `from → to` is legal
   * (`lib/preview/states.ts`), writing `patch` with it — ONE conditional
   * `UPDATE … WHERE state = ANY(…) RETURNING`, never a read-then-write. Returns
   * the moved row, or `null` when the row is elsewhere, the move is illegal or
   * the row does not exist; `null` wrote nothing. Two racing transitions from
   * the same state have exactly one winner: the loser's WHERE re-reads the
   * committed state under the row lock and matches nothing.
   *
   * `closed_at` follows the state: set on `closed`, cleared on any other.
   */
  async transition(
    id: string,
    from: readonly PreviewDeploymentState[],
    to: PreviewDeploymentState,
    patch: PreviewDeploymentPatch,
    tx: Prisma.TransactionClient,
  ): Promise<PreviewDeployment | null> {
    const sources = legalSourcesFor(from, to);
    if (sources.length === 0) return null;
    const rows = await tx.previewDeployment.updateManyAndReturn({
      where: { id, state: { in: sources } },
      data: { ...patch, state: to, closedAt: to === 'closed' ? new Date() : null },
    });
    return rows[0] ?? null;
  },

  /** One row by id — what a lifecycle job re-reads before each effect. */
  async findById(id: string, tx: Prisma.TransactionClient): Promise<PreviewDeployment | null> {
    return tx.previewDeployment.findUnique({ where: { id } });
  },

  /** The pull request's row, if it has one. */
  async findForPullRequest(
    repoId: string,
    pullRequestNumber: number,
    tx: Prisma.TransactionClient,
  ): Promise<PreviewDeployment | null> {
    return tx.previewDeployment.findUnique({
      where: { repoId_pullRequestNumber: { repoId, pullRequestNumber } },
    });
  },

  /**
   * Write `patch` to a row WITHOUT moving its state, and only while it is in one
   * of `states` — how an effect records what it made (the GitHub deployment, the
   * app, the branch) after the transition that ordered it committed. Returns the
   * row, or null when it has moved on and nothing was written.
   */
  async recordWhileIn(
    id: string,
    states: readonly PreviewDeploymentState[],
    patch: PreviewDeploymentPatch,
    tx: Prisma.TransactionClient,
  ): Promise<PreviewDeployment | null> {
    const rows = await tx.previewDeployment.updateManyAndReturn({
      where: { id, state: { in: [...states] } },
      data: patch,
    });
    return rows[0] ?? null;
  },

  /**
   * Closed rows that still name a resource — an app or a branch whose teardown
   * did not finish (MOTIR-5776's reaper). Teardown clears the names as it
   * destroys, so a row here is exactly a teardown a crash interrupted.
   */
  async listUnfinishedTeardowns(
    tx: Prisma.TransactionClient,
    opts: { repoId?: string; limit?: number } = {},
  ): Promise<PreviewDeployment[]> {
    return tx.previewDeployment.findMany({
      where: {
        ...(opts.repoId ? { repoId: opts.repoId } : {}),
        state: 'closed',
        OR: [{ flyAppName: { not: null } }, { neonBranchId: { not: null } }],
      },
      orderBy: { updatedAt: 'asc' },
      take: opts.limit ?? STALE_SCAN_LIMIT,
    });
  },

  /** Bump a row's `updated_at` while it is still in `state` — the reaper's mark
   *  that it checked the row, so the oldest-first scan moves on past it. */
  async touch(
    id: string,
    state: PreviewDeploymentState,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.previewDeployment.updateMany({
      where: { id, state },
      data: { updatedAt: new Date() },
    });
  },

  /** The row that holds a host — what serving resolves a request with. */
  async findByHost(host: string, tx?: Prisma.TransactionClient): Promise<PreviewDeployment | null> {
    const client = tx ?? dbRead;
    return client.previewDeployment.findUnique({ where: { host } });
  },

  /** Live rows untouched since `olderThan`, oldest first — the reaper's scan
   *  (the `(state, updated_at)` index). */
  async listStale(
    olderThan: Date,
    tx?: Prisma.TransactionClient,
    limit: number = STALE_SCAN_LIMIT,
  ): Promise<PreviewDeployment[]> {
    const client = tx ?? dbRead;
    return client.previewDeployment.findMany({
      where: { state: { in: [...LIVE_PREVIEW_STATES] }, updatedAt: { lt: olderThan } },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    });
  },

  /** A repository's live previews, by pull request — what takeover and a
   *  disconnect tear down. */
  async listOpenForRepo(
    repoId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<PreviewDeployment[]> {
    const client = tx ?? dbRead;
    return client.previewDeployment.findMany({
      where: { repoId, state: { in: [...LIVE_PREVIEW_STATES] } },
      orderBy: { pullRequestNumber: 'asc' },
    });
  },
};
