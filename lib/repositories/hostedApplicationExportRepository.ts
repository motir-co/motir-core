import type { HostedApplicationExport, Prisma } from '@/generated/prisma/client';
import type { HostedApplicationExportKind } from '@/lib/hosting/vocabulary';

// A hosted application's DATABASE EXPORTS (Story MOTIR-9800 · MOTIR-12126): one
// row per dump written to storage — `on_demand` when a member asked for one,
// `final` when the app was stopped at the end of a grace period. The row holds
// where the dump lives and when its download stops, never a signed link: the
// link is minted per download. Workspace-scoped: the table's RLS admits the
// active workspace, so a reader runs in `withWorkspaceContext` and a system
// writer binds the application's workspace first.

export interface HostedApplicationExportCreate {
  /** The export's id, chosen by the caller: the stored object is named by it
   *  before the row exists (MOTIR-12134). Generated when absent. */
  id?: string;
  workspaceId: string;
  applicationId: string;
  kind: HostedApplicationExportKind;
  /** Who asked, for an on-demand export; null for the final one. */
  requestedByUserId: string | null;
  storageKey: string;
  sizeBytes: bigint;
  expiresAt: Date;
}

export const hostedApplicationExportRepository = {
  async create(
    data: HostedApplicationExportCreate,
    tx: Prisma.TransactionClient,
  ): Promise<HostedApplicationExport> {
    return tx.hostedApplicationExport.create({ data });
  },

  async findById(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<HostedApplicationExport | null> {
    return tx.hostedApplicationExport.findUnique({ where: { id } });
  },

  /** The application's exports, newest first. */
  async listByApplication(
    applicationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<HostedApplicationExport[]> {
    return tx.hostedApplicationExport.findMany({
      where: { applicationId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  },

  /** The export written when the application was stopped, if it was. */
  async findFinalByApplication(
    applicationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<HostedApplicationExport | null> {
    return tx.hostedApplicationExport.findFirst({
      where: { applicationId, kind: 'final' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  },

  /** The application's exports not yet past `expiresAt` at `now`, newest
   *  first (MOTIR-12134). */
  async listUnexpiredByApplication(
    applicationId: string,
    now: Date,
    tx: Prisma.TransactionClient,
  ): Promise<HostedApplicationExport[]> {
    return tx.hostedApplicationExport.findMany({
      where: { applicationId, expiresAt: { gt: now } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  },

  /** The workspace's exports past `expiresAt` at `now` — what the expiry sweep
   *  deletes, oldest first (MOTIR-12134). */
  async listExpired(
    now: Date,
    tx: Prisma.TransactionClient,
  ): Promise<{ id: string; storageKey: string }[]> {
    return tx.hostedApplicationExport.findMany({
      where: { expiresAt: { lte: now } },
      select: { id: true, storageKey: true },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
    });
  },

  /** Delete one export; its download rows go with it (CASCADE). A row already
   *  gone deletes nothing, so a re-run is harmless. */
  async deleteById(id: string, tx: Prisma.TransactionClient): Promise<number> {
    const { count } = await tx.hostedApplicationExport.deleteMany({ where: { id } });
    return count;
  },
};
