import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CostExplorerHistoryUnavailableError,
  type CostExplorerLine,
  type CostExplorerReader,
} from '@/lib/awsCost/costExplorerReader';
import {
  AWS_COST_BACKFILL_MAX_MONTHS,
  awsCostService,
  monthRange,
  recentRange,
} from '@/lib/services/awsCostService';
import { awsCostDayRepository } from '@/lib/repositories/awsCostDayRepository';
import { awsCostFetchRepository } from '@/lib/repositories/awsCostFetchRepository';
import { withSystemContext } from '@/lib/workspaces/context';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';

// MOTIR'S AWS BILL, FETCHED AND KEPT (MOTIR-11712) — the fetch job's and the
// backfill's service over the real database, with Cost Explorer stood in by a
// reader that answers plain lines.

const NOW = new Date('2026-11-18T06:12:00Z');

beforeEach(async () => {
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "aws_cost_day", "aws_cost_fetch"');
  vi.unstubAllEnvs();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await db.$disconnect();
  await adminDb.$disconnect();
});

function readerFrom(answer: (from: string, to: string) => CostExplorerLine[] | Error) {
  const calls: Array<[string, string]> = [];
  const reader: CostExplorerReader = {
    async readDailyCosts(from, to) {
      calls.push([from, to]);
      const lines = answer(from, to);
      if (lines instanceof Error) throw lines;
      return lines;
    },
  };
  return { reader, calls };
}

const usage = (day: string, service: string, amountMicroUsd: number): CostExplorerLine => ({
  day,
  recordType: 'Usage',
  service,
  amountMicroUsd,
});

describe('ranges', () => {
  it('names whole UTC months by offset, and the schedule reads last month through today', () => {
    expect(monthRange(NOW, 0)).toEqual({ fromDay: '2026-11-01', toDay: '2026-11-30' });
    expect(monthRange(NOW, -11)).toEqual({ fromDay: '2025-12-01', toDay: '2025-12-31' });
    expect(monthRange(new Date('2026-03-31T00:00:00Z'), -1)).toEqual({
      fromDay: '2026-02-01',
      toDay: '2026-02-28',
    });
    expect(recentRange(NOW)).toEqual({ fromDay: '2026-10-01', toDay: '2026-11-18' });
  });
});

describe('awsCostService.fetchRecent', () => {
  it('reads nothing on an install that names no Cost Explorer role', async () => {
    vi.stubEnv('AWS_COST_EXPLORER_ROLE_ARN', '');
    expect(await awsCostService.fetchRecent({ now: NOW })).toEqual({ status: 'not_configured' });
    expect(await adminDb.awsCostFetch.count()).toBe(0);
  });

  it('builds the real reader when a role is named', async () => {
    vi.stubEnv('AWS_COST_EXPLORER_ROLE_ARN', 'arn:aws:iam::111122223333:role/x');
    const { CostExplorerClient } = await import('@aws-sdk/client-cost-explorer');
    const send = vi
      .spyOn(CostExplorerClient.prototype, 'send')
      .mockImplementation((async () => ({ ResultsByTime: [] })) as never);
    expect(await awsCostService.fetchRecent({ now: NOW })).toMatchObject({
      status: 'fetched',
      lines: 0,
    });
    expect(send).toHaveBeenCalledTimes(1);
    send.mockRestore();
  });

  it('stores the two months, records the read, and replaces the days a later read covers', async () => {
    const first = readerFrom(() => [
      usage('2026-10-31', 'Amazon S3', 4),
      usage('2026-11-17', 'AWS Lambda', 7),
      usage('2026-11-17', 'Amazon S3', 2),
      { day: '2026-11-17', recordType: 'Tax', service: 'Amazon S3', amountMicroUsd: 1 },
    ]);
    expect(await awsCostService.fetchRecent({ reader: first.reader, now: NOW })).toEqual({
      status: 'fetched',
      fromDay: '2026-10-01',
      toDay: '2026-11-18',
      lines: 4,
      fetchedAt: NOW.toISOString(),
    });
    expect(first.calls).toEqual([['2026-10-01', '2026-11-18']]);

    // AWS stopped billing Lambda on the 17th: the later read drops it.
    const later = new Date('2026-11-18T12:20:00Z');
    const second = readerFrom(() => [usage('2026-11-17', 'Amazon S3', 3)]);
    await awsCostService.fetchRecent({ reader: second.reader, now: later });

    const stored = await withSystemContext((tx) =>
      awsCostDayRepository.findInRange({ fromDay: '2026-10-01', toDay: '2026-11-30' }, tx),
    );
    expect(stored).toEqual([
      { day: '2026-11-17', kind: 'service', service: 'Amazon S3', amountMicroUsd: 3 },
    ]);
    const coverage = await withSystemContext((tx) => awsCostFetchRepository.findCoverage(tx));
    expect(coverage).toEqual({ fromDay: '2026-10-01', toDay: '2026-11-18', fetchedAt: later });
    expect(await adminDb.awsCostFetch.count()).toBe(2);
  });

  it('a read that fails writes nothing: the last stored figures stay', async () => {
    await awsCostService.fetchRecent({
      reader: readerFrom(() => [usage('2026-11-01', 'Amazon S3', 9)]).reader,
      now: NOW,
    });
    const failing = readerFrom(() => new Error('ThrottlingException'));
    await expect(
      awsCostService.fetchRecent({ reader: failing.reader, now: new Date('2026-11-18T18:20:00Z') }),
    ).rejects.toThrow('ThrottlingException');
    expect(await adminDb.awsCostDay.count()).toBe(1);
    expect(await adminDb.awsCostFetch.count()).toBe(1);
  });

  it('a read of a month with no cost stores no line and still covers the days', async () => {
    await awsCostService.fetchRecent({ reader: readerFrom(() => []).reader, now: NOW });
    expect(await adminDb.awsCostDay.count()).toBe(0);
    expect(await withSystemContext((tx) => awsCostFetchRepository.findCoverage(tx))).toMatchObject({
      fromDay: '2026-10-01',
      toDay: '2026-11-18',
    });
  });
});

describe('awsCostService.backfill', () => {
  it('a dry run lists the months it would read, newest first, and reads nothing', async () => {
    const { reader, calls } = readerFrom(() => []);
    const report = await awsCostService.backfill({ reader, now: NOW, maxMonths: 5, dryRun: true });
    expect(report).toEqual({
      months: [],
      planned: ['2026-09', '2026-08', '2026-07'],
      stoppedBy: 'max_months',
    });
    expect(calls).toEqual([]);
    const all = await awsCostService.backfill({ now: NOW, dryRun: true });
    expect(all.planned).toHaveLength(AWS_COST_BACKFILL_MAX_MONTHS - 2);
    expect(all.planned.at(-1)).toBe('2023-10');
  });

  it('walks back a month at a time from the month before the previous one and stops where Cost Explorer stops', async () => {
    const { reader, calls } = readerFrom((from) =>
      from < '2026-07-01'
        ? new CostExplorerHistoryUnavailableError('historical data beyond 13 months')
        : [usage(from, 'Amazon S3', 5), usage(from, 'AWS Lambda', 1)],
    );
    const seen: string[] = [];
    const report = await awsCostService.backfill({
      reader,
      now: NOW,
      onMonth: (month, lines) => seen.push(`${month}:${lines}`),
    });
    expect(report).toEqual({
      months: ['2026-09', '2026-08', '2026-07'],
      planned: [],
      stoppedBy: 'history_unavailable',
    });
    expect(seen).toEqual(['2026-09:2', '2026-08:2', '2026-07:2']);
    expect(calls.slice(0, 2)).toEqual([
      ['2026-09-01', '2026-09-30'],
      ['2026-08-01', '2026-08-31'],
    ]);
    expect(await adminDb.awsCostDay.count()).toBe(6);
    expect(await withSystemContext((tx) => awsCostFetchRepository.findCoverage(tx))).toMatchObject({
      fromDay: '2026-07-01',
      toDay: '2026-09-30',
    });
  });

  it('stops at maxMonths, and on an abort between two months', async () => {
    const { reader, calls } = readerFrom(() => []);
    expect(await awsCostService.backfill({ reader, now: NOW, maxMonths: 4 })).toEqual({
      months: ['2026-09', '2026-08'],
      planned: [],
      stoppedBy: 'max_months',
    });
    expect(calls).toHaveLength(2);

    const controller = new AbortController();
    const report = await awsCostService.backfill({
      reader,
      now: NOW,
      signal: controller.signal,
      onMonth: () => controller.abort(),
    });
    expect(report).toEqual({ months: ['2026-09'], planned: [], stoppedBy: 'interrupted' });
  });

  it('answers not_configured with no role, and passes any other failure through', async () => {
    vi.stubEnv('AWS_COST_EXPLORER_ROLE_ARN', '');
    expect(await awsCostService.backfill({ now: NOW })).toMatchObject({
      stoppedBy: 'not_configured',
    });
    const { reader } = readerFrom(() => new Error('AccessDenied'));
    await expect(awsCostService.backfill({ reader, now: NOW })).rejects.toThrow('AccessDenied');
  });
});

describe('the repositories', () => {
  it('sum a range by line, and answer no coverage before the first read', async () => {
    expect(await withSystemContext((tx) => awsCostFetchRepository.findCoverage(tx))).toBeNull();
    const fetchedAt = new Date('2026-11-18T00:00:00Z');
    await withSystemContext(async (tx) => {
      expect(await awsCostDayRepository.insertMany({ rows: [], fetchedAt }, tx)).toBe(0);
      await awsCostDayRepository.insertMany(
        {
          rows: [
            { day: '2026-11-01', kind: 'service', service: 'Amazon S3', amountMicroUsd: 2 },
            { day: '2026-11-02', kind: 'service', service: 'Amazon S3', amountMicroUsd: 3 },
            { day: '2026-11-02', kind: 'credit', service: '', amountMicroUsd: -1 },
            { day: '2026-12-01', kind: 'service', service: 'Amazon S3', amountMicroUsd: 50 },
          ],
          fetchedAt,
        },
        tx,
      );
    });
    expect(
      await withSystemContext((tx) =>
        awsCostDayRepository.sumByLineInRange({ fromDay: '2026-11-01', toDay: '2026-11-30' }, tx),
      ),
    ).toEqual([
      { kind: 'credit', service: '', amountMicroUsd: -1 },
      { kind: 'service', service: 'Amazon S3', amountMicroUsd: 5 },
    ]);
    expect(
      await withSystemContext((tx) =>
        awsCostDayRepository.deleteInRange({ fromDay: '2026-11-01', toDay: '2026-11-30' }, tx),
      ),
    ).toBe(3);
  });
});
