import type { HostedApplicationExportDownload, Prisma } from '@/generated/prisma/client';

// Every DOWNLOAD of a database export (Story MOTIR-9800 · MOTIR-12134): one row
// per signed link minted, so a download is traceable to who asked and when.
// Workspace-scoped: the table's RLS admits the active workspace only.

export interface HostedApplicationExportDownloadCreate {
  workspaceId: string;
  exportId: string;
  userId: string;
}

export const hostedApplicationExportDownloadRepository = {
  async create(
    data: HostedApplicationExportDownloadCreate,
    tx: Prisma.TransactionClient,
  ): Promise<HostedApplicationExportDownload> {
    return tx.hostedApplicationExportDownload.create({ data });
  },

  /** Delete an export's download rows. The export's own delete cascades to
   *  them; this is for a caller that removes them first. */
  async deleteByExport(exportId: string, tx: Prisma.TransactionClient): Promise<number> {
    const { count } = await tx.hostedApplicationExportDownload.deleteMany({ where: { exportId } });
    return count;
  },
};
