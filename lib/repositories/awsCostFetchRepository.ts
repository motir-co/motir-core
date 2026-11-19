import type { Prisma } from '@/generated/prisma/client';
import { dayDate, dayString } from '@/lib/awsCost/costLines';

/**
 * EVERY SUCCESSFUL COST EXPLORER READ (MOTIR-11712) — `aws_cost_fetch`: the
 * inclusive day range a read replaced in `aws_cost_day`, and when. Written beside
 * those rows in the fetch's one transaction (`withSystemContext`); read by the
 * Costs page inside `withPlatformRead`. Every method takes `tx`.
 */

/** What the stored days cover: the span Motir holds an AWS figure for, and the last read. */
export interface AwsCostCoverage {
  fromDay: string;
  toDay: string;
  fetchedAt: Date;
}

export const awsCostFetchRepository = {
  /** Record one successful read of `[fromDay, toDay]`. */
  async insert(
    input: { fromDay: string; toDay: string; fetchedAt: Date },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.awsCostFetch.create({
      data: {
        fromDay: dayDate(input.fromDay),
        toDay: dayDate(input.toDay),
        fetchedAt: input.fetchedAt,
      },
    });
  },

  /** The span every read so far covers and the latest read's time; null before the first. */
  async findCoverage(tx: Prisma.TransactionClient): Promise<AwsCostCoverage | null> {
    const { _min, _max } = await tx.awsCostFetch.aggregate({
      _min: { fromDay: true },
      _max: { toDay: true, fetchedAt: true },
    });
    if (!_min.fromDay || !_max.toDay || !_max.fetchedAt) return null;
    return {
      fromDay: dayString(_min.fromDay),
      toDay: dayString(_max.toDay),
      fetchedAt: _max.fetchedAt,
    };
  },
};
