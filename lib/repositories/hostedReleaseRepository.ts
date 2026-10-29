import type {
  HostedRelease,
  HostedReleaseCause,
  HostedReleaseState,
  HostingTarget,
  Prisma,
} from '@/generated/prisma/client';
import { dbRead } from '@/lib/db';
import type { HostedReleaseRow } from '@/lib/mappers/hostedApplicationMappers';

// Single-op data access for `hosted_release` — one row per release of a commit
// on a hosted application (Story MOTIR-9797 · MOTIR-10026). Writes take a
// required `tx`.

/** Who restored a release, for its DTO (MOTIR-10035). */
const RESTORED_BY = { restoredBy: { select: { id: true, name: true } } } as const;

export interface HostedReleaseInsert {
  workspaceId: string;
  applicationId: string;
  commitSha: string;
  ref: string | null;
  cause: HostedReleaseCause;
}

/** The columns a state move may stamp alongside the state. */
export type HostedReleaseStamp = Partial<
  Pick<
    HostedRelease,
    | 'liveAt'
    | 'endedAt'
    | 'failureReason'
    | 'artifactRef'
    | 'providerReleaseId'
    | 'providerRef'
    | 'usageSettledUntil'
    | 'restoredById'
    | 'restoredAt'
  >
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

/** The facts settling a release's usage reads (MOTIR-10034). */
export interface ReleaseUsageTarget {
  state: HostedReleaseState;
  liveAt: Date | null;
  usageSettledUntil: Date | null;
  providerReleaseId: string | null;
  providerRef: string | null;
  target: HostingTarget;
  projectRepositoryId: string;
}

export const hostedReleaseRepository = {
  async create(input: HostedReleaseInsert, tx: Prisma.TransactionClient): Promise<HostedRelease> {
    return tx.hostedRelease.create({ data: input });
  },

  async findById(id: string, tx?: Prisma.TransactionClient): Promise<HostedReleaseRow | null> {
    const client = tx ?? dbRead;
    return client.hostedRelease.findUnique({ where: { id }, include: RESTORED_BY });
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
  ): Promise<HostedReleaseRow[]> {
    const client = tx ?? dbRead;
    return client.hostedRelease.findMany({
      where: { applicationId },
      include: RESTORED_BY,
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

  /** What settling a release's usage reads (MOTIR-10034): the release's own
   *  window and handle columns, and its application's target and repository. */
  async findUsageTarget(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<ReleaseUsageTarget | null> {
    const row = await tx.hostedRelease.findUnique({
      where: { id },
      select: {
        state: true,
        liveAt: true,
        usageSettledUntil: true,
        providerReleaseId: true,
        providerRef: true,
        application: { select: { target: true, projectRepositoryId: true } },
      },
    });
    if (!row) return null;
    const { application, ...release } = row;
    return {
      ...release,
      target: application.target,
      projectRepositoryId: application.projectRepositoryId,
    };
  },

  /**
   * Add one settled window to the release's usage, ONE conditional statement:
   * it matches only while `usage_settled_until` is still what the settler read
   * (`expectedSettledUntil`, null the first time), so two settles of one window
   * add it once. Returns whether the row changed.
   */
  async addSettledUsage(
    id: string,
    window: { expectedSettledUntil: Date | null; seconds: number; settledUntil: Date },
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    // Raw, because a never-settled release's `usage_seconds` is NULL and an
    // ORM increment of NULL stays NULL.
    const changed = await tx.$executeRaw`
      UPDATE "hosted_release"
         SET "usage_seconds" = COALESCE("usage_seconds", 0) + ${window.seconds}::int,
             "usage_settled_until" = ${window.settledUntil}::timestamptz,
             "updated_at" = now()
       WHERE "id" = ${id}
         AND "usage_settled_until" IS NOT DISTINCT FROM ${window.expectedSettledUntil}::timestamptz`;
    return changed === 1;
  },

  /** One page of the application's releases, newest first, after the
   *  `(createdAt, id)` position `after` (MOTIR-10036). */
  async listPageByApplication(
    applicationId: string,
    page: { after: { createdAt: Date; id: string } | null; take: number },
    tx: Prisma.TransactionClient,
  ): Promise<HostedReleaseRow[]> {
    const { after, take } = page;
    return tx.hostedRelease.findMany({
      where: {
        applicationId,
        ...(after
          ? {
              OR: [
                { createdAt: { lt: after.createdAt } },
                { createdAt: after.createdAt, id: { lt: after.id } },
              ],
            }
          : {}),
      },
      include: RESTORED_BY,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
    });
  },
};
