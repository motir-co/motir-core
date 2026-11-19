import type { Prisma } from '@/generated/prisma/client';
import { dayDate, dayString, type AwsCostKind, type AwsCostRow } from '@/lib/awsCost/costLines';

/**
 * MOTIR'S AWS BILL, BY DAY AND LINE (MOTIR-11712) — `aws_cost_day`. The fetch
 * job and the backfill write it under `withSystemContext`; the Costs page reads
 * it inside `withPlatformRead` (`20261118235000_aws_cost_days`'s two arms).
 * Every method takes `tx`.
 */
export const awsCostDayRepository = {
  /** Delete every stored line of `[fromDay, toDay]` (inclusive). Answers how many. */
  async deleteInRange(
    range: { fromDay: string; toDay: string },
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const { count } = await tx.awsCostDay.deleteMany({
      where: { day: { gte: dayDate(range.fromDay), lte: dayDate(range.toDay) } },
    });
    return count;
  },

  /** Insert one fetch's lines, each stamped with the fetch's time. Answers how many. */
  async insertMany(
    input: { rows: readonly AwsCostRow[]; fetchedAt: Date },
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    if (input.rows.length === 0) return 0;
    const { count } = await tx.awsCostDay.createMany({
      data: input.rows.map((row) => ({
        day: dayDate(row.day),
        kind: row.kind,
        service: row.service,
        amountMicroUsd: BigInt(row.amountMicroUsd),
        fetchedAt: input.fetchedAt,
      })),
    });
    return count;
  },

  /** Every stored line of `[fromDay, toDay]` (inclusive), as plain rows. */
  async findInRange(
    range: { fromDay: string; toDay: string },
    tx: Prisma.TransactionClient,
  ): Promise<AwsCostRow[]> {
    const rows = await tx.awsCostDay.findMany({
      where: { day: { gte: dayDate(range.fromDay), lte: dayDate(range.toDay) } },
      select: { day: true, kind: true, service: true, amountMicroUsd: true },
      orderBy: [{ day: 'asc' }, { kind: 'asc' }, { service: 'asc' }],
    });
    return rows.map((row) => ({
      day: dayString(row.day),
      kind: row.kind as AwsCostKind,
      service: row.service,
      amountMicroUsd: Number(row.amountMicroUsd),
    }));
  },

  /**
   * Every line of `[fromDay, toDay]` (inclusive) summed across its days: one row
   * per (kind, service). The Month and Year views' read, so a year is a handful of
   * rows rather than every stored day.
   */
  async sumByLineInRange(
    range: { fromDay: string; toDay: string },
    tx: Prisma.TransactionClient,
  ): Promise<Array<{ kind: AwsCostKind; service: string; amountMicroUsd: number }>> {
    const groups = await tx.awsCostDay.groupBy({
      by: ['kind', 'service'],
      where: { day: { gte: dayDate(range.fromDay), lte: dayDate(range.toDay) } },
      _sum: { amountMicroUsd: true },
      orderBy: [{ kind: 'asc' }, { service: 'asc' }],
    });
    return groups.map((group) => ({
      kind: group.kind as AwsCostKind,
      service: group.service,
      amountMicroUsd: Number(group._sum.amountMicroUsd),
    }));
  },
};
