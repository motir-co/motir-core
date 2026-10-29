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
};
