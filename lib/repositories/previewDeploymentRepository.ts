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
