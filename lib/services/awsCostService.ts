import {
  CostExplorerHistoryUnavailableError,
  costExplorerRoleArn,
  createCostExplorerReader,
  type CostExplorerReader,
} from '@/lib/awsCost/costExplorerReader';
import { toCostRows } from '@/lib/awsCost/costLines';
import { awsCostDayRepository } from '@/lib/repositories/awsCostDayRepository';
import { awsCostFetchRepository } from '@/lib/repositories/awsCostFetchRepository';
import { withSystemContext } from '@/lib/workspaces/context';

/**
 * MOTIR'S AWS BILL, FETCHED AND KEPT (MOTIR-11712) — what the console's Costs
 * page shows in its AWS column, read from Cost Explorer on a schedule so the page
 * never calls it (each request is billed, about $0.01).
 *
 * WHAT A FETCH DOES. It reads every UTC day of a range — the current and the
 * previous month on the schedule, because AWS revises recent days (and the
 * previous month's last days for a day or two into the new one) — and, in ONE
 * transaction, deletes the stored lines of those days, inserts what it read and
 * records the read in `aws_cost_fetch`. A service AWS stopped billing on a day
 * therefore disappears from it, and a read that fails writes nothing: the page
 * keeps the last stored figures and the time they were fetched.
 *
 * THE BACKFILL walks back a month at a time from the month before the previous
 * one, and stops at the first month Cost Explorer no longer holds (13 months by
 * default, 38 with multi-year data on) or at `maxMonths`.
 */

/** How far back the backfill goes at most: Cost Explorer's multi-year maximum. */
export const AWS_COST_BACKFILL_MAX_MONTHS = 38;

export type AwsCostFetchOutcome =
  | { status: 'not_configured' }
  | { status: 'fetched'; fromDay: string; toDay: string; lines: number; fetchedAt: string };

export interface AwsCostBackfillReport {
  /** The months read and stored, newest first (`YYYY-MM`). */
  months: string[];
  /** The months a dry run would read, newest first; nothing is read or written. */
  planned: string[];
  /** Why the walk stopped. */
  stoppedBy: 'history_unavailable' | 'max_months' | 'interrupted' | 'not_configured';
}

/** `YYYY-MM-DD` of a UTC instant. */
function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** The first and last UTC day of the month `offset` months from `at`'s month. */
export function monthRange(at: Date, offset: number): { fromDay: string; toDay: string } {
  const first = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + offset, 1));
  const last = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + offset + 1, 0));
  return { fromDay: utcDay(first), toDay: utcDay(last) };
}

/** The scheduled fetch's range: the first of the previous month through today, UTC. */
export function recentRange(now: Date): { fromDay: string; toDay: string } {
  return { fromDay: monthRange(now, -1).fromDay, toDay: utcDay(now) };
}

function readerOrNull(reader: CostExplorerReader | undefined): CostExplorerReader | null {
  if (reader) return reader;
  return costExplorerRoleArn() ? createCostExplorerReader() : null;
}

/** Read `range` and replace its stored days, in one transaction. */
async function fetchRange(
  reader: CostExplorerReader,
  range: { fromDay: string; toDay: string },
  fetchedAt: Date,
): Promise<number> {
  const rows = toCostRows(await reader.readDailyCosts(range.fromDay, range.toDay));
  await withSystemContext(async (tx) => {
    await awsCostDayRepository.deleteInRange(range, tx);
    await awsCostDayRepository.insertMany({ rows, fetchedAt }, tx);
    await awsCostFetchRepository.insert({ ...range, fetchedAt }, tx);
  });
  return rows.length;
}

export const awsCostService = {
  /**
   * The scheduled fetch: the current and previous month, stored. An install that
   * names no Cost Explorer role answers `not_configured` and reads nothing.
   * Throws when AWS does not answer — the job's failure, and nothing is stored.
   */
  async fetchRecent(
    opts: { reader?: CostExplorerReader; now?: Date } = {},
  ): Promise<AwsCostFetchOutcome> {
    const reader = readerOrNull(opts.reader);
    if (!reader) return { status: 'not_configured' };
    const now = opts.now ?? new Date();
    const range = recentRange(now);
    const lines = await fetchRange(reader, range, now);
    return { status: 'fetched', ...range, lines, fetchedAt: now.toISOString() };
  },

  /**
   * The one-off history load, a month at a time, newest first, from the month
   * before the previous one. A dry run reads nothing: it lists the months a run
   * would ask for (each one billed request or more).
   */
  async backfill(
    opts: {
      reader?: CostExplorerReader;
      now?: Date;
      maxMonths?: number;
      dryRun?: boolean;
      signal?: AbortSignal;
      onMonth?: (month: string, lines: number) => void;
    } = {},
  ): Promise<AwsCostBackfillReport> {
    const now = opts.now ?? new Date();
    const maxMonths = opts.maxMonths ?? AWS_COST_BACKFILL_MAX_MONTHS;
    const offsets = Array.from({ length: Math.max(0, maxMonths - 2) }, (_, i) => -2 - i);
    const report: AwsCostBackfillReport = { months: [], planned: [], stoppedBy: 'max_months' };
    if (opts.dryRun) {
      report.planned = offsets.map((offset) => monthRange(now, offset).fromDay.slice(0, 7));
      return report;
    }
    const reader = readerOrNull(opts.reader);
    if (!reader) return { ...report, stoppedBy: 'not_configured' };
    for (const offset of offsets) {
      if (opts.signal?.aborted) return { ...report, stoppedBy: 'interrupted' };
      const range = monthRange(now, offset);
      const month = range.fromDay.slice(0, 7);
      try {
        const lines = await fetchRange(reader, range, new Date());
        report.months.push(month);
        opts.onMonth?.(month, lines);
      } catch (err) {
        if (err instanceof CostExplorerHistoryUnavailableError) {
          return { ...report, stoppedBy: 'history_unavailable' };
        }
        throw err;
      }
    }
    return report;
  },
};
