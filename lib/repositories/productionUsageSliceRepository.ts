import {
  Prisma,
  type ProductionUsageChargeState,
  type ProductionUsageUnit,
} from '@/generated/prisma/client';

// Single-op data access for `production_usage_slice` (Story MOTIR-9799 ·
// MOTIR-12108). Every call takes the caller's `tx`, opened under the slice's own
// workspace (`withWorkspaceServiceContext`): the table's policy has no system
// arm. The meter serialises one application's writes on that application's row
// lock (`hostedApplicationRepository.lockForUpdate`), held by the caller.

/** One slice to write — already priced and keyed. */
export interface ProductionUsageSliceInput {
  workspaceId: string;
  organizationId: string;
  applicationId: string;
  releaseId: string | null;
  unit: ProductionUsageUnit;
  quantity: number;
  credits: number;
  motirCostUsd: number;
  periodStart: Date;
  chargeDay: Date;
  sliceStart: Date;
  sliceEnd: Date;
  idempotencyKey: string;
}

/** A unit's sums over a window. */
export interface ProductionUsageUnitSum {
  unit: ProductionUsageUnit;
  quantity: number;
  credits: number;
}

/** The states a day's slices are in until the day is settled. */
const OPEN_STATES: ProductionUsageChargeState[] = ['pending', 'charging'];

/** A summed or stored decimal as a number; an empty sum (null) reads 0. */
const num = (d: Prisma.Decimal | null): number => Number(d);

export const productionUsageSliceRepository = {
  /** The end of the application's last slice in any of `units`, or null. */
  async lastSliceEnd(
    applicationId: string,
    units: readonly ProductionUsageUnit[],
    tx: Prisma.TransactionClient,
  ): Promise<Date | null> {
    const row = await tx.productionUsageSlice.aggregate({
      where: { applicationId, unit: { in: [...units] } },
      _max: { sliceEnd: true },
    });
    return row._max.sliceEnd;
  },

  /** True when the application's `day` is already being charged or settled, so
   *  no new slice may join it (Decision MOTIR-12100 §6). */
  async isDayClosed(
    applicationId: string,
    day: Date,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const found = await tx.productionUsageSlice.findFirst({
      where: { applicationId, chargeDay: day, chargeState: { not: 'pending' } },
      select: { id: true },
    });
    return found !== null;
  },

  /** Insert the slices, skipping any whose key is taken. Returns how many were new. */
  async insertSlices(
    slices: readonly ProductionUsageSliceInput[],
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    if (slices.length === 0) return 0;
    const created = await tx.productionUsageSlice.createMany({
      data: slices.map((s) => ({
        ...s,
        quantity: new Prisma.Decimal(s.quantity.toFixed(9)),
        credits: new Prisma.Decimal(s.credits.toFixed(9)),
        motirCostUsd: new Prisma.Decimal(s.motirCostUsd.toFixed(12)),
      })),
      skipDuplicates: true,
    });
    return created.count;
  },

  /** The application's days before `before` that still hold slices to charge,
   *  oldest first. */
  async listOpenDays(
    applicationId: string,
    before: Date,
    tx: Prisma.TransactionClient,
  ): Promise<Date[]> {
    const rows = await tx.productionUsageSlice.findMany({
      where: { applicationId, chargeState: { in: OPEN_STATES }, chargeDay: { lt: before } },
      distinct: ['chargeDay'],
      orderBy: { chargeDay: 'asc' },
      select: { chargeDay: true },
    });
    return rows.map((r) => r.chargeDay);
  },

  /**
   * Close the application's `day` for its charge: every pending slice of it
   * becomes `charging` with the attempt counted. Returns the credits of every
   * slice now charging that day — the set the debit is computed from, which no
   * later accrual can grow.
   */
  async startCharging(
    applicationId: string,
    day: Date,
    tx: Prisma.TransactionClient,
  ): Promise<number[]> {
    await tx.productionUsageSlice.updateMany({
      where: { applicationId, chargeDay: day, chargeState: { in: OPEN_STATES } },
      data: { chargeState: 'charging', chargeAttempts: { increment: 1 } },
    });
    const rows = await tx.productionUsageSlice.findMany({
      where: { applicationId, chargeDay: day, chargeState: 'charging' },
      select: { credits: true },
    });
    return rows.map((r) => num(r.credits));
  },

  /** Record how the day's charge ended. `charging` keeps the day closed and owed
   *  — the next pass asks again with the same key. */
  async finishCharging(
    applicationId: string,
    day: Date,
    result: {
      state: Exclude<ProductionUsageChargeState, 'pending'>;
      chargedAt?: Date;
      detail: string | null;
    },
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const updated = await tx.productionUsageSlice.updateMany({
      where: { applicationId, chargeDay: day, chargeState: 'charging' },
      data: {
        chargeState: result.state,
        chargedAt: result.chargedAt ?? null,
        chargeDetail: result.detail,
      },
    });
    return updated.count;
  },

  /** The application's usage per unit for slices ending in `[from, to)`. */
  async sumByUnit(
    applicationId: string,
    window: { from: Date; to: Date },
    tx: Prisma.TransactionClient,
  ): Promise<ProductionUsageUnitSum[]> {
    const rows = await tx.productionUsageSlice.groupBy({
      by: ['unit'],
      where: { applicationId, sliceEnd: { gt: window.from, lte: window.to } },
      _sum: { quantity: true, credits: true },
      orderBy: { unit: 'asc' },
    });
    return rows.map((r) => ({
      unit: r.unit,
      quantity: num(r._sum.quantity),
      credits: num(r._sum.credits),
    }));
  },

  /** The application's credits per UTC day for slices ending in `[from, to)`. */
  async sumCreditsByDay(
    applicationId: string,
    window: { from: Date; to: Date },
    tx: Prisma.TransactionClient,
  ): Promise<number[]> {
    const rows = await tx.productionUsageSlice.groupBy({
      by: ['chargeDay'],
      where: { applicationId, sliceEnd: { gt: window.from, lte: window.to } },
      _sum: { credits: true },
      orderBy: { chargeDay: 'asc' },
    });
    return rows.map((r) => num(r._sum.credits));
  },

  /** Whether any slice in the window carries Motir's own cost. */
  async hasMotirCost(
    applicationId: string,
    window: { from: Date; to: Date },
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const found = await tx.productionUsageSlice.findFirst({
      where: {
        applicationId,
        sliceEnd: { gt: window.from, lte: window.to },
        motirCostUsd: { gt: 0 },
      },
      select: { id: true },
    });
    return found !== null;
  },
};
