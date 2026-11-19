import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { NotPlatformStaffError } from '@/lib/platform/errors';
import type { RawModelCostDays } from '@/lib/ai/motirAiClient';

/**
 * The Costs page's read (MOTIR-11712) — `platformReadService.getCosts` over the
 * real database: the AWS bill as the fetch job stored it beside motir-ai's
 * recorded model cost, ONE `estate.read` per view whichever source answered, and
 * the gate before anything.
 */

let currentPrincipal: PlatformPrincipal | null = null;
const modelCostMock = vi.fn<(q: { from: string; to: string }) => Promise<RawModelCostDays>>();

vi.mock('@/lib/platform/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platform/auth')>('@/lib/platform/auth');
  return {
    ...actual,
    requirePlatformStaff: vi.fn(async () => {
      if (!currentPrincipal) throw new NotPlatformStaffError();
      return currentPrincipal;
    }),
  };
});

vi.mock('@/lib/ai/motirAiClient', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/ai/motirAiClient')>('@/lib/ai/motirAiClient');
  return {
    ...actual,
    getPlatformModelCostDays: (q: { from: string; to: string }) => modelCostMock(q),
  };
});

const { db } = await import('@/lib/db');
const { platformReadService } = await import('@/lib/services/platformReadService');
const { awsCostService } = await import('@/lib/services/awsCostService');
const { awsCostFetchRepository } = await import('@/lib/repositories/awsCostFetchRepository');
const { createTestUser } = await import('../fixtures/userFixtures');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');

const NOW = new Date('2026-11-18T09:00:00Z');

/** motir-ai's answer for a range: every day null except the ones given. */
function modelDays(
  from: string,
  to: string,
  recorded: Record<string, number> = {},
  firstRecordedDay: string | null = '2025-03-02',
): RawModelCostDays {
  const days: RawModelCostDays['days'] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; ) {
    const day = d.toISOString().slice(0, 10);
    const v = recorded[day];
    days.push({
      day,
      partial: day === '2026-11-18',
      recordedMicroUsd: v ?? null,
      providers: v === undefined ? [] : [{ provider: 'anthropic', recordedMicroUsd: v }],
    });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return { from, to, today: '2026-11-18', firstRecordedDay, days };
}

/** One fetch, as the 6-hourly job writes it: October 1 through today. */
async function storeAws(lines: Array<[string, string, number]>) {
  await awsCostService.fetchRecent({
    now: NOW,
    reader: {
      async readDailyCosts() {
        return lines.map(([day, service, amountMicroUsd]) => ({
          day,
          recordType: service === 'Tax' ? 'Tax' : 'Usage',
          service,
          amountMicroUsd,
        }));
      },
    },
  });
}

beforeEach(async () => {
  await adminDb.platformAuditLog.deleteMany();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "aws_cost_day", "aws_cost_fetch"');
  await truncateAuthTables();
  const user = await createTestUser({ email: 'ops+costs@moooon.net' });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: 'support' } });
  currentPrincipal = { userId: user.id, email: user.email, role: 'support' };
  modelCostMock.mockReset();
  modelCostMock.mockImplementation(async ({ from, to }) =>
    modelDays(from, to, { '2026-11-17': 50_000_000, '2026-11-18': 4_000_000 }),
  );
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('platformReadService.getCosts', () => {
  it('refuses a non-staff caller before reading anything', async () => {
    currentPrincipal = null;
    await expect(
      platformReadService.getCosts({ userId: 'x', email: 'x', role: 'support' }, { kind: 'year' }),
    ).rejects.toBeInstanceOf(NotPlatformStaffError);
    expect(modelCostMock).not.toHaveBeenCalled();
    expect(await adminDb.platformAuditLog.count()).toBe(0);
  });

  it('Day view: the stored AWS days beside the model days, under ONE estate.read row', async () => {
    await storeAws([
      ['2026-11-17', 'Amazon Elastic Container Service', 70_000_000],
      ['2026-11-17', 'Tax', 5_000_000],
      ['2026-11-18', 'Amazon S3', 1_000_000],
    ]);

    const costs = await platformReadService.getCosts(
      currentPrincipal!,
      { kind: 'day', month: '2026-11' },
      NOW,
    );

    expect(modelCostMock).toHaveBeenCalledTimes(1);
    expect(modelCostMock).toHaveBeenCalledWith({ from: '2026-11-01', to: '2026-11-18' });
    expect(costs.rows).toHaveLength(18);
    expect(costs.rows.find((r) => r.period === '2026-11-17')).toMatchObject({
      awsMicroUsd: 75_000_000,
      modelsMicroUsd: 50_000_000,
      totalMicroUsd: 125_000_000,
      partial: false,
      estimate: false,
      awsLines: [
        {
          kind: 'service',
          service: 'Amazon Elastic Container Service',
          amountMicroUsd: 70_000_000,
        },
        { kind: 'tax', service: '', amountMicroUsd: 5_000_000 },
      ],
    });
    // A covered day with no line cost nothing; the AWS figure is 0, not missing.
    expect(costs.rows.find((r) => r.period === '2026-11-03')).toMatchObject({
      awsMicroUsd: 0,
      modelsMicroUsd: null,
      totalMicroUsd: null,
    });
    expect(costs.rows.at(-1)).toMatchObject({
      period: '2026-11-18',
      partial: true,
      estimate: true,
    });
    expect(costs.awsFetchedAt).toBe(NOW.toISOString());
    expect(costs.options.at(-1)).toBe('2025-03');

    const rows = await adminDb.platformAuditLog.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'estate.read',
      targetKind: 'platform',
      targetLabel: 'costs 2026-11 by day',
    });
  });

  it('AWS before its first fetch is unavailable, and the view is still audited once', async () => {
    const costs = await platformReadService.getCosts(
      currentPrincipal!,
      { kind: 'month', year: '2026' },
      NOW,
    );
    expect(costs.awsAvailable).toBe(false);
    expect(costs.modelsAvailable).toBe(true);
    expect(costs.rows.find((r) => r.period === '2026-11')!.modelsMicroUsd).toBe(54_000_000);
    expect(await adminDb.platformAuditLog.count()).toBe(1);
    expect((await adminDb.platformAuditLog.findFirst())!.targetLabel).toBe('costs 2026 by month');
  });

  it('motir-ai not answering leaves the AWS column and still writes one row', async () => {
    await storeAws([['2026-11-02', 'Amazon S3', 2_000_000]]);
    modelCostMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const costs = await platformReadService.getCosts(
      currentPrincipal!,
      { kind: 'month', year: '2026' },
      NOW,
    );
    expect(costs.modelsAvailable).toBe(false);
    expect(costs.rows.find((r) => r.period === '2026-11')).toMatchObject({
      awsMicroUsd: 2_000_000,
      modelsMicroUsd: null,
    });
    // October is covered and cost nothing; September was never read.
    expect(costs.rows.find((r) => r.period === '2026-10')!.awsMicroUsd).toBe(0);
    expect(costs.rows.find((r) => r.period === '2026-09')!.awsMicroUsd).toBeNull();
    expect(await adminDb.platformAuditLog.count()).toBe(1);
  });

  it('a stored-read failure marks AWS unavailable, re-audits the view once, and keeps Models', async () => {
    await storeAws([['2026-11-02', 'Amazon S3', 2_000_000]]);
    const spy = vi
      .spyOn(awsCostFetchRepository, 'findCoverage')
      .mockRejectedValueOnce(new Error('connection reset'));
    const costs = await platformReadService.getCosts(
      currentPrincipal!,
      { kind: 'day', month: '2026-11' },
      NOW,
    );
    spy.mockRestore();
    expect(costs.awsAvailable).toBe(false);
    expect(costs.modelsAvailable).toBe(true);
    expect(await adminDb.platformAuditLog.count()).toBe(1);
  });

  it('Year view: one model call per year from the first recorded one, each within 366 days', async () => {
    modelCostMock.mockImplementation(async ({ from, to }) =>
      modelDays(from, to, { '2024-08-01': 1_000_000, '2026-11-17': 2_000_000 }, '2024-08-01'),
    );
    const costs = await platformReadService.getCosts(currentPrincipal!, { kind: 'year' }, NOW);
    expect(modelCostMock.mock.calls.map(([q]) => q)).toEqual([
      { from: '2026-01-01', to: '2026-11-18' },
      { from: '2024-01-01', to: '2024-12-31' },
      { from: '2025-01-01', to: '2025-12-31' },
    ]);
    // 2025 recorded nothing and AWS was never read: the year is not listed.
    expect(costs.rows.map((r) => [r.period, r.modelsMicroUsd])).toEqual([
      ['2024', 1_000_000],
      ['2026', 2_000_000],
    ]);
    expect(costs.options).toEqual([]);
    expect((await adminDb.platformAuditLog.findFirst())!.targetLabel).toBe('costs by year');
  });

  it('Year view with AWS stored: each year sums its covered days', async () => {
    await storeAws([
      ['2026-10-05', 'Amazon S3', 3_000_000],
      ['2026-11-05', 'Amazon S3', 4_000_000],
    ]);
    const costs = await platformReadService.getCosts(currentPrincipal!, { kind: 'year' }, NOW);
    expect(costs.rows.find((r) => r.period === '2026')).toMatchObject({
      awsMicroUsd: 7_000_000,
      modelsMicroUsd: 54_000_000,
      totalMicroUsd: 61_000_000,
      partial: true,
      estimate: true,
    });
  });

  it('reads the clock when no time is given', async () => {
    const costs = await platformReadService.getCosts(currentPrincipal!, { kind: 'year' });
    expect(costs.today).toBe(new Date().toISOString().slice(0, 10));
  });
});
