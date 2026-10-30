import { Prisma, type PreviewUsageKind } from '@/generated/prisma/client';
import { LIVE_PREVIEW_STATES } from '@/lib/preview/states';

// Single-op data access for `preview_usage` — the slices of a preview's usage
// counted in its organisation's CI-minutes pool (Story MOTIR-5766 · MOTIR-5777).
// Every write runs under withSystemContext (the accrual job, the destroy wrap);
// a tenant may only read (the migration's policies).

/** One slice to write. Quantities are in the kind's own unit. */
export interface PreviewUsageSliceInput {
  previewDeploymentId: string;
  organizationId: string;
  workspaceId: string;
  kind: PreviewUsageKind;
  sourceRef: string;
  quantity: number;
  linuxEquivalentMinutes: number;
  motirCostUsd: number;
  periodStart: Date;
  sliceStart: Date;
  sliceEnd: Date;
}

const METERED_PREVIEW_SELECT = {
  id: true,
  workspaceId: true,
  repoId: true,
  pullRequestNumber: true,
  state: true,
  flyAppName: true,
  neonProjectId: true,
  neonBranchId: true,
  createdAt: true,
  repo: { select: { organizationId: true } },
} satisfies Prisma.PreviewDeploymentSelect;

export type MeteredPreview = Prisma.PreviewDeploymentGetPayload<{
  select: typeof METERED_PREVIEW_SELECT;
}>;

/** How many live previews one accrual pass reads at most. */
export const ACCRUAL_SCAN_LIMIT = 500;

export const previewUsageRepository = {
  /** The preview that owns an app, a branch, or an id — whatever its state. */
  async findMetered(
    where: { id: string } | { flyAppName: string } | { neonBranchId: string },
    tx: Prisma.TransactionClient,
  ): Promise<MeteredPreview | null> {
    return tx.previewDeployment.findFirst({
      where,
      select: METERED_PREVIEW_SELECT,
      orderBy: { createdAt: 'asc' },
    });
  },

  /** Live previews holding something that accrues usage, oldest first. */
  async listMetered(
    tx: Prisma.TransactionClient,
    limit = ACCRUAL_SCAN_LIMIT,
  ): Promise<MeteredPreview[]> {
    return tx.previewDeployment.findMany({
      where: {
        state: { in: [...LIVE_PREVIEW_STATES] },
        OR: [{ flyAppName: { not: null } }, { neonBranchId: { not: null } }],
      },
      select: METERED_PREVIEW_SELECT,
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  },

  /** Serialise the writers of one preview's slices for the rest of `tx`. */
  async lockPreview(previewDeploymentId: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.$queryRaw`
      SELECT "id" FROM "preview_deployment" WHERE "id" = ${previewDeploymentId} FOR UPDATE
    `;
  },

  /** Where the preview's recorded windows of these kinds end, or null. */
  async lastSliceEnd(
    previewDeploymentId: string,
    kinds: readonly PreviewUsageKind[],
    tx: Prisma.TransactionClient,
  ): Promise<Date | null> {
    const found = await tx.previewUsage.aggregate({
      where: { previewDeploymentId, kind: { in: [...kinds] } },
      _max: { sliceEnd: true },
    });
    return found._max.sliceEnd;
  },

  /** The quantity already recorded for one source, optionally only from slices
   *  ending after `after` — one generation of a re-created app. */
  async sumQuantity(
    input: {
      previewDeploymentId: string;
      kind: PreviewUsageKind;
      sourceRef: string;
      endingAfter?: Date;
    },
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const found = await tx.previewUsage.aggregate({
      where: {
        previewDeploymentId: input.previewDeploymentId,
        kind: input.kind,
        sourceRef: input.sourceRef,
        ...(input.endingAfter ? { sliceEnd: { gt: input.endingAfter } } : {}),
      },
      _sum: { quantity: true },
    });
    return Number(found._sum.quantity ?? 0);
  },

  /** Write slices; one already written under its key is skipped. Returns how
   *  many were new. */
  async insertSlices(
    slices: readonly PreviewUsageSliceInput[],
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    if (slices.length === 0) return 0;
    const created = await tx.previewUsage.createMany({
      data: slices.map((slice) => ({
        ...slice,
        quantity: new Prisma.Decimal(slice.quantity.toFixed(6)),
        linuxEquivalentMinutes: new Prisma.Decimal(slice.linuxEquivalentMinutes.toFixed(4)),
        motirCostUsd: new Prisma.Decimal(slice.motirCostUsd.toFixed(12)),
      })),
      skipDuplicates: true,
    });
    return created.count;
  },

  /** The organisation's preview minutes in a period — the pool read's second
   *  term. */
  async sumLinuxMinutesForOrgPeriod(
    organizationId: string,
    periodStart: Date,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const found = await tx.previewUsage.aggregate({
      where: { organizationId, periodStart },
      _sum: { linuxEquivalentMinutes: true },
    });
    return Number(found._sum.linuxEquivalentMinutes ?? 0);
  },
};
