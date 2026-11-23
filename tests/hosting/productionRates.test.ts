// MOTIR-12108 — the production usage meter's pure half: Decision MOTIR-12100's
// units, their derived credit factors, a port answer turned into units, and the
// UTC day a slice is charged on. No I/O.
import { describe, expect, it } from 'vitest';
import type { ProductionUsageUnit } from '@/generated/prisma/client';
import { LINUX_MINUTE_USD } from '@/lib/ciMetering/previewRates';
import {
  dailyChargeCredits,
  linuxMinutesPerUnit,
  MONTH_SECONDS,
  PRODUCTION_USAGE_RATES,
  priceProductionSlice,
} from '@/lib/hosting/productionRates';
import {
  chargeDayOf,
  DATABASE_UNITS,
  databaseUnitQuantities,
  dayKey,
  RELEASE_UNITS,
  releaseUnitQuantities,
  SERVERLESS_MEMORY_GB,
  sliceIdempotencyKey,
  utcDayOf,
} from '@/lib/hosting/productionUsage';

const usage = (over: Record<string, unknown> = {}) =>
  ({
    target: 'fly',
    appRef: 'mh-shop',
    releaseId: 'r1',
    since: new Date('2026-11-23T10:00:00Z'),
    until: new Date('2026-11-23T11:00:00Z'),
    runningSeconds: 3600,
    ...over,
  }) as Parameters<typeof releaseUnitQuantities>[2];

describe('the decision’s rates', () => {
  it('prices every unit, and the release and database units together cover them all', () => {
    const units = Object.keys(PRODUCTION_USAGE_RATES).sort();
    expect([...RELEASE_UNITS, ...DATABASE_UNITS].sort()).toEqual(units);
    for (const unit of units as ProductionUsageUnit[]) {
      expect(PRODUCTION_USAGE_RATES[unit].usdPerUnit).toBeGreaterThan(0);
    }
  });

  it('derives each factor from the list price ÷ the Linux minute, never types it', () => {
    for (const unit of Object.keys(PRODUCTION_USAGE_RATES) as ProductionUsageUnit[]) {
      expect(linuxMinutesPerUnit(unit)).toBeCloseTo(
        PRODUCTION_USAGE_RATES[unit].usdPerUnit / LINUX_MINUTE_USD,
        15,
      );
    }
    expect(LINUX_MINUTE_USD).toBe(0.006);
  });

  it('reads the decision’s figures: a month of a small Fly machine is $6.70, 1,116.67 credits', () => {
    expect(priceProductionSlice('fly_small_seconds', MONTH_SECONDS).motirCostUsd).toBeCloseTo(
      6.7,
      9,
    );
    expect(priceProductionSlice('fly_small_seconds', MONTH_SECONDS).credits).toBeCloseTo(
      6.7 / 0.006,
      6,
    );
    // A large machine is twice a medium one (§2 note).
    expect(PRODUCTION_USAGE_RATES.fly_large_seconds.usdPerUnit).toBeCloseTo(
      2 * PRODUCTION_USAGE_RATES.fly_medium_seconds.usdPerUnit,
      15,
    );
    // A Neon CU-hour: $0.106 ÷ $0.006 ≈ 17.67 credits.
    expect(linuxMinutesPerUnit('neon_compute_hours')).toBeCloseTo(17.6667, 3);
  });

  it('keeps Motir’s cost beside the credits, at the same list price', () => {
    expect(priceProductionSlice('lambda_requests', 1_000_000)).toEqual({
      credits: expect.closeTo(0.2 / 0.006, 9),
      motirCostUsd: expect.closeTo(0.2, 12),
    });
  });
});

describe('a day’s charge', () => {
  it('sums the day’s fractional slices and rounds up once', () => {
    expect(dailyChargeCredits([0.4, 0.4, 0.4])).toBe(2);
    expect(dailyChargeCredits([1.0001])).toBe(2);
  });

  it('charges nothing for nothing, and never rounds a float residue up into a credit', () => {
    expect(dailyChargeCredits([])).toBe(0);
    expect(dailyChargeCredits([1e-12])).toBe(0);
    expect(dailyChargeCredits([0.1, 0.2, 0.7])).toBe(1);
    expect(dailyChargeCredits([3])).toBe(3);
  });
});

describe('a release window in the decision’s units', () => {
  it('bills Fly by its running seconds at the release’s size, small when none is stored', () => {
    expect(releaseUnitQuantities('fly', 'medium', usage())).toEqual([
      { unit: 'fly_medium_seconds', quantity: 3600 },
    ]);
    expect(releaseUnitQuantities('fly', null, usage())).toEqual([
      { unit: 'fly_small_seconds', quantity: 3600 },
    ]);
  });

  it('bills Motir’s serverless account as GB-seconds at the function’s memory, plus requests', () => {
    expect(releaseUnitQuantities('serverless', null, usage({ invocations: 42 }))).toEqual([
      { unit: 'lambda_gb_seconds', quantity: 3600 * SERVERLESS_MEMORY_GB },
      { unit: 'lambda_requests', quantity: 42 },
    ]);
  });

  it('bills an AWS function’s GB-seconds and an AWS container’s vCPU- and GB-seconds', () => {
    expect(
      releaseUnitQuantities(
        'aws',
        null,
        usage({ compute: { unit: 'lambda', gbSeconds: 120 }, invocations: 0 }),
      ),
    ).toEqual([{ unit: 'lambda_gb_seconds', quantity: 120 }]);
    expect(
      releaseUnitQuantities(
        'aws',
        null,
        usage({ compute: { unit: 'fargate', vcpuSeconds: 900, gbSeconds: 1800 } }),
      ),
    ).toEqual([
      { unit: 'fargate_vcpu_seconds', quantity: 900 },
      { unit: 'fargate_gb_seconds', quantity: 1800 },
    ]);
  });

  it('drops a residue, a zero and an AWS window with no compute figure', () => {
    expect(releaseUnitQuantities('fly', 'small', usage({ runningSeconds: 1e-12 }))).toEqual([]);
    expect(releaseUnitQuantities('aws', null, usage())).toEqual([]);
  });
});

describe('a database window in the decision’s units', () => {
  const window = {
    start: new Date('2026-11-23T10:00:00Z'),
    end: new Date('2026-11-23T12:00:00Z'),
  };

  it('bills Neon compute as CU-hours and storage as GB-hours over the window', () => {
    expect(
      databaseUnitQuantities(
        {
          provider: 'neon',
          applicationRef: 'r',
          since: window.start,
          until: window.end,
          computeSeconds: 1800,
          storageBytes: 2 ** 30,
        },
        window,
      ),
    ).toEqual([
      { unit: 'neon_compute_hours', quantity: 0.5 },
      { unit: 'neon_storage_gb_hours', quantity: 2 },
    ]);
  });

  it('bills an AWS database in the Aurora units', () => {
    const units = databaseUnitQuantities(
      {
        provider: 'aws' as never,
        applicationRef: 'r',
        since: window.start,
        until: window.end,
        computeSeconds: 3600,
        storageBytes: 0,
      },
      window,
    );
    expect(units).toEqual([{ unit: 'aurora_compute_hours', quantity: 1 }]);
  });
});

describe('the UTC day and the slice key', () => {
  it('puts a slice on the day its last instant falls in, so midnight closes the day before', () => {
    expect(dayKey(chargeDayOf(new Date('2026-11-24T00:00:00Z')))).toBe('2026-11-23');
    expect(dayKey(chargeDayOf(new Date('2026-11-24T00:00:00.001Z')))).toBe('2026-11-24');
    expect(utcDayOf(new Date('2026-11-23T23:59:59Z')).toISOString()).toBe(
      '2026-11-23T00:00:00.000Z',
    );
  });

  it('keys a slice by application, unit and end', () => {
    expect(sliceIdempotencyKey('app1', 'fly_small_seconds', new Date('2026-11-23T11:00:00Z'))).toBe(
      'app1:fly_small_seconds:2026-11-23T11:00:00.000Z',
    );
  });
});
