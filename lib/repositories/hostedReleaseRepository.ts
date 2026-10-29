import type {
  HostedRelease,
  HostedReleaseCause,
  HostedReleaseState,
  Prisma,
} from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';

// Single-op data access for `hosted_release` — one row per release of a commit
// on a hosted application (Story MOTIR-9797 · MOTIR-10026). Writes take a
// required `tx`.

export interface HostedReleaseInsert {
  workspaceId: string;
  applicationId: string;
  commitSha: string;
  ref: string | null;
  cause: HostedReleaseCause;
}

/** The columns a state move may stamp alongside the state. */
export type HostedReleaseStamp = Partial<
  Pick<HostedRelease, 'liveAt' | 'endedAt' | 'failureReason' | 'artifactRef' | 'providerReleaseId'>
>;

/** The facts posting a release's GitHub deployment status reads (MOTIR-10033). */
export interface ReleaseStatusTarget {
  state: HostedReleaseState;
  commitSha: string;
  githubDeploymentId: string | null;
  statusPostedState: string | null;
  projectRepositoryId: string;
  productionAddress: string | null;
}

export const hostedReleaseRepository = {
  async create(input: HostedReleaseInsert, tx: Prisma.TransactionClient): Promise<HostedRelease> {
    return tx.hostedRelease.create({ data: input });
  },

  async findById(id: string, tx?: Prisma.TransactionClient): Promise<HostedRelease | null> {
    const client = tx ?? dbRead;
    return client.hostedRelease.findUnique({ where: { id } });
  },

  /**
   * Move a release `from` → `to`, ONE conditional statement: it matches only
   * while the row is still in `from`, so a release that moved under the caller
   * changes nothing and the count is 0. Never a read-then-write.
   */
  async transitionState(
    id: string,
    from: HostedReleaseState,
    to: HostedReleaseState,
    stamp: HostedReleaseStamp,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const { count } = await tx.hostedRelease.updateMany({
      where: { id, state: from },
      data: { ...stamp, state: to },
    });
    return count;
  },

  /** The application's release still in `building` or `releasing`, if any —
   *  the one a new release must wait for (MOTIR-10030). */
  async findInFlightByApplication(
    applicationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<HostedRelease | null> {
    return tx.hostedRelease.findFirst({
      where: { applicationId, state: { in: ['building', 'releasing'] } },
      orderBy: { createdAt: 'desc' },
    });
  },

  /** The application's releases, newest first. */
  async listByApplication(
    applicationId: string,
    take: number,
    tx?: Prisma.TransactionClient,
  ): Promise<HostedRelease[]> {
    const client = tx ?? dbRead;
    return client.hostedRelease.findMany({
      where: { applicationId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
    });
  },

  /**
   * Serialize the posting of ONE release's GitHub deployment status
   * (MOTIR-10033): a transaction-scoped advisory lock, released when `tx` ends.
   */
  async lockStatusPost(id: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`hosted-release-status:${id}`}, 0))`;
  },

  /** What posting the release's deployment status reads: its state, commit,
   *  stored handle and its application's repository and address. */
  async findStatusTarget(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<ReleaseStatusTarget | null> {
    const row = await tx.hostedRelease.findUnique({
      where: { id },
      select: {
        state: true,
        commitSha: true,
        githubDeploymentId: true,
        statusPostedState: true,
        application: { select: { projectRepositoryId: true, productionAddress: true } },
      },
    });
    if (!row) return null;
    return {
      state: row.state,
      commitSha: row.commitSha,
      githubDeploymentId: row.githubDeploymentId,
      statusPostedState: row.statusPostedState,
      projectRepositoryId: row.application.projectRepositoryId,
      productionAddress: row.application.productionAddress,
    };
  },

  /** Store the release's GitHub deployment id — only while none is stored, so
   *  the first handle wins. Returns the count written (0 or 1). */
  async setDeploymentHandle(
    id: string,
    handle: { githubDeploymentId: string },
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const { count } = await tx.hostedRelease.updateMany({
      where: { id, githubDeploymentId: null },
      data: { githubDeploymentId: handle.githubDeploymentId },
    });
    return count;
  },

  /** Record the last deployment status posted, conditional on the one the
   *  poster read (`from`, null for none). Returns the count written. */
  async markStatusPosted(
    id: string,
    move: { from: string | null; to: string },
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const { count } = await tx.hostedRelease.updateMany({
      where: { id, statusPostedState: move.from },
      data: { statusPostedState: move.to },
    });
    return count;
  },

  /** The release's workspace, or null when the release is gone. */
  async findWorkspaceId(id: string, tx: Prisma.TransactionClient): Promise<string | null> {
    const row = await tx.hostedRelease.findUnique({ where: { id }, select: { workspaceId: true } });
    return row?.workspaceId ?? null;
  },
};
