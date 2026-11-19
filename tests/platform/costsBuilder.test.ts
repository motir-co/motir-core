import { describe, expect, it } from 'vitest';
import {
  buildCosts,
  candidatePeriods,
  firstDayHeld,
  intersectRange,
  modelRangeFor,
  modelYearRanges,
  parseCostsView,
  periodRange,
  pickerOptions,
  utcDayOf,
  type AwsPeriodLine,
  type AwsSource,
  type ModelsSource,
} from '@/lib/platform/costs';

// THE COSTS PAGE'S ARITHMETIC (MOTIR-11712, design MOTIR-11711 § Rules the
// drawing holds). Read on 18 Nov 2026 throughout.

const TODAY = '2026-11-18';

function aws(
  lines: Record<string, AwsPeriodLine[]>,
  coverage = { fromDay: '2025-02-01', toDay: TODAY },
): AwsSource {
  return {
    status: 'ok',
    coverage,
    fetchedAt: '2026-11-18T06:12:00.000Z',
    lines: new Map(Object.entries(lines)),
  };
}

function models(
  days: Array<[string, number | null, Record<string, number>?]>,
  firstRecordedDay: string | null = '2025-03-02',
): ModelsSource {
  return {
    status: 'ok',
    firstRecordedDay,
    days: days.map(([day, recordedMicroUsd, providers = {}]) => ({
      day,
      recordedMicroUsd,
      providers: Object.entries(providers).map(([provider, v]) => ({
        provider,
        recordedMicroUsd: v,
      })),
    })),
  };
}

const svc = (service: string, amountMicroUsd: number): AwsPeriodLine => ({
  kind: 'service',
  service,
  amountMicroUsd,
});

describe('parseCostsView', () => {
  it('is Day on the current month with no parameters, or with any unknown or future value', () => {
    expect(parseCostsView({}, TODAY)).toEqual({ kind: 'day', month: '2026-11' });
    expect(parseCostsView({ view: 'week' }, TODAY)).toEqual({ kind: 'day', month: '2026-11' });
    expect(parseCostsView({ view: 'day', month: '2026-12' }, TODAY)).toEqual({
      kind: 'day',
      month: '2026-11',
    });
    expect(parseCostsView({ view: 'day', month: '2026-13' }, TODAY).kind).toBe('day');
    expect(parseCostsView({ view: 'day', month: '1999-01' }, TODAY)).toEqual({
      kind: 'day',
      month: '2026-11',
    });
    expect(parseCostsView({ view: 'day', month: '2025-02' }, TODAY)).toEqual({
      kind: 'day',
      month: '2025-02',
    });
  });

  it('reads a Month view year and the Year view', () => {
    expect(parseCostsView({ view: 'month', year: '2025' }, TODAY)).toEqual({
      kind: 'month',
      year: '2025',
    });
    expect(parseCostsView({ view: 'month', year: '2027' }, TODAY)).toEqual({
      kind: 'month',
      year: '2026',
    });
    expect(parseCostsView({ view: 'month', year: '1990' }, TODAY)).toEqual({
      kind: 'month',
      year: '2026',
    });
    expect(parseCostsView({ view: 'month' }, TODAY)).toEqual({ kind: 'month', year: '2026' });
    expect(parseCostsView({ view: 'year', month: '2025-01' }, TODAY)).toEqual({ kind: 'year' });
  });
});

describe('ranges', () => {
  it('clamps a period to today and answers null for a future one', () => {
    expect(utcDayOf(new Date('2026-11-18T23:59:59Z'))).toBe('2026-11-18');
    expect(periodRange('2026-11-17', TODAY)).toEqual({
      fromDay: '2026-11-17',
      toDay: '2026-11-17',
    });
    expect(periodRange('2026-11', TODAY)).toEqual({ fromDay: '2026-11-01', toDay: TODAY });
    expect(periodRange('2024-02', TODAY)).toEqual({ fromDay: '2024-02-01', toDay: '2024-02-29' });
    expect(periodRange('2025', TODAY)).toEqual({ fromDay: '2025-01-01', toDay: '2025-12-31' });
    expect(periodRange('2026-12', TODAY)).toBeNull();
    expect(
      intersectRange(
        { fromDay: '2026-01-01', toDay: '2026-12-31' },
        { fromDay: '2026-03-04', toDay: '2027-01-01' },
      ),
    ).toEqual({ fromDay: '2026-03-04', toDay: '2026-12-31' });
    expect(
      intersectRange(
        { fromDay: '2024-01-01', toDay: '2024-12-31' },
        { fromDay: '2025-01-01', toDay: TODAY },
      ),
    ).toBeNull();
  });

  it('lists days through today, months through this one, and years from the first held', () => {
    expect(candidatePeriods({ kind: 'day', month: '2026-11' }, TODAY, null)).toHaveLength(18);
    expect(candidatePeriods({ kind: 'day', month: '2026-10' }, TODAY, null)).toHaveLength(31);
    expect(candidatePeriods({ kind: 'month', year: '2026' }, TODAY, null)).toEqual(
      Array.from({ length: 11 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`),
    );
    expect(candidatePeriods({ kind: 'month', year: '2025' }, TODAY, null)).toHaveLength(12);
    expect(candidatePeriods({ kind: 'year' }, TODAY, '2024-06-01')).toEqual([
      '2024',
      '2025',
      '2026',
    ]);
    expect(candidatePeriods({ kind: 'year' }, TODAY, null)).toEqual(['2026']);
    expect(candidatePeriods({ kind: 'year' }, TODAY, '2030-01-01')).toEqual(['2026']);
  });

  it('asks the model read for one year at most per call', () => {
    expect(modelRangeFor({ kind: 'day', month: '2026-11' }, TODAY)).toEqual({
      fromDay: '2026-11-01',
      toDay: TODAY,
    });
    expect(modelRangeFor({ kind: 'month', year: '2025' }, TODAY)).toEqual({
      fromDay: '2025-01-01',
      toDay: '2025-12-31',
    });
    expect(modelRangeFor({ kind: 'year' }, TODAY)).toEqual({ fromDay: '2026-01-01', toDay: TODAY });
    expect(modelYearRanges('2024-07-09', TODAY)).toEqual([
      { fromDay: '2024-01-01', toDay: '2024-12-31' },
      { fromDay: '2025-01-01', toDay: '2025-12-31' },
    ]);
    expect(modelYearRanges(null, TODAY)).toEqual([]);
    expect(modelYearRanges('2026-02-01', TODAY)).toEqual([]);
  });

  it('starts the pickers at the earliest day either source holds', () => {
    expect(firstDayHeld({ fromDay: '2025-02-01', toDay: TODAY }, '2025-03-02')).toBe('2025-02-01');
    expect(firstDayHeld({ fromDay: '2025-04-01', toDay: TODAY }, '2025-03-02')).toBe('2025-03-02');
    expect(firstDayHeld(null, '2025-03-02')).toBe('2025-03-02');
    expect(firstDayHeld({ fromDay: '2025-04-01', toDay: TODAY }, null)).toBe('2025-04-01');
    expect(firstDayHeld(null, null)).toBeNull();

    const months = pickerOptions({ kind: 'day', month: '2026-11' }, TODAY, '2025-02-01');
    expect(months[0]).toBe('2026-11');
    expect(months.at(-1)).toBe('2025-02');
    expect(months).toHaveLength(22);
    // A chosen month older than anything held is still offered.
    expect(pickerOptions({ kind: 'day', month: '2024-12' }, TODAY, '2025-02-01').at(-1)).toBe(
      '2024-12',
    );
    expect(pickerOptions({ kind: 'day', month: '2026-11' }, TODAY, null)).toEqual(['2026-11']);
    expect(pickerOptions({ kind: 'month', year: '2026' }, TODAY, '2024-05-01')).toEqual([
      '2026',
      '2025',
      '2024',
    ]);
    expect(pickerOptions({ kind: 'month', year: '2023' }, TODAY, null)).toEqual([
      '2026',
      '2025',
      '2024',
      '2023',
    ]);
    expect(pickerOptions({ kind: 'year' }, TODAY, '2024-05-01')).toEqual([]);
  });
});

describe('buildCosts — the Day view', () => {
  const built = buildCosts({
    view: { kind: 'day', month: '2026-11' },
    today: TODAY,
    aws: aws(
      {
        '2026-11-17': [
          { kind: 'credit', service: '', amountMicroUsd: -10_000_000 },
          svc('EC2 - Other', 20_000_000),
          { kind: 'tax', service: '', amountMicroUsd: 5_000_000 },
          svc('Amazon Elastic Container Service', 85_000_000),
          { kind: 'refund', service: '', amountMicroUsd: 0 },
        ],
        '2026-11-18': [svc('AWS Lambda', 1_000_000)],
        '2026-11-16': [],
      },
      { fromDay: '2026-11-16', toDay: TODAY },
    ),
    models: models([
      ['2026-11-16', null],
      ['2026-11-17', 50_000_000, { unknown: 10_000_000, anthropic: 40_000_000 }],
      ['2026-11-18', 0, {}],
    ]),
  });

  it('draws every day of the month through today, oldest first, and no day after', () => {
    expect(built.rows.map((r) => r.period)).toEqual(
      Array.from({ length: 18 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`),
    );
  });

  it('marks today Partial with an AWS Estimate, and no other day', () => {
    const marked = built.rows.filter((r) => r.partial || r.estimate);
    expect(marked.map((r) => [r.period, r.partial, r.estimate])).toEqual([[TODAY, true, true]]);
  });

  it('never draws a missing figure as zero, and draws a Total only from two figures', () => {
    const day = (d: string) => built.rows.find((r) => r.period === d)!;
    // Outside what AWS covers, and nothing recorded: no figure at all.
    expect(day('2026-11-02')).toMatchObject({
      awsMicroUsd: null,
      modelsMicroUsd: null,
      totalMicroUsd: null,
    });
    // Covered by AWS with no line: it cost nothing. No model record: no figure, so no Total.
    expect(day('2026-11-16')).toMatchObject({
      awsMicroUsd: 0,
      modelsMicroUsd: null,
      totalMicroUsd: null,
    });
    expect(day('2026-11-17')).toMatchObject({
      awsMicroUsd: 100_000_000,
      modelsMicroUsd: 50_000_000,
      totalMicroUsd: 150_000_000,
    });
    // A recorded zero is a zero.
    expect(day(TODAY)).toMatchObject({
      awsMicroUsd: 1_000_000,
      modelsMicroUsd: 0,
      totalMicroUsd: 1_000_000,
    });
  });

  it('orders the AWS drill-down services largest first, then Tax, Credits, Refund, with shares of the row', () => {
    const row = built.rows.find((r) => r.period === '2026-11-17')!;
    expect(row.awsLines).toEqual([
      {
        kind: 'service',
        service: 'Amazon Elastic Container Service',
        amountMicroUsd: 85_000_000,
        share: 0.85,
      },
      { kind: 'service', service: 'EC2 - Other', amountMicroUsd: 20_000_000, share: 0.2 },
      { kind: 'tax', service: '', amountMicroUsd: 5_000_000, share: 0.05 },
      { kind: 'credit', service: '', amountMicroUsd: -10_000_000, share: -0.1 },
    ]);
    // Credits included, the shares add up to the row.
    expect(row.awsLines.reduce((s, l) => s + (l.share ?? 0), 0)).toBeCloseTo(1);
    expect(row.modelLines).toEqual([
      { provider: 'anthropic', amountMicroUsd: 40_000_000, share: 0.8 },
      { provider: 'unknown', amountMicroUsd: 10_000_000, share: 0.2 },
    ]);
    // A zero figure gives no share.
    expect(built.rows.find((r) => r.period === TODAY)!.modelLines).toEqual([]);
  });

  it('sums the range, says it is not over, and offers the months back to the first held', () => {
    expect(built.totals).toEqual({
      awsMicroUsd: 101_000_000,
      modelsMicroUsd: 50_000_000,
      totalMicroUsd: 151_000_000,
      partial: true,
    });
    expect(built.awsAvailable && built.modelsAvailable).toBe(true);
    expect(built.awsFetchedAt).toBe('2026-11-18T06:12:00.000Z');
    expect(built.empty).toBe(false);
    expect(built.options.at(-1)).toBe('2025-03');
  });
});

describe('buildCosts — one source unavailable', () => {
  it('AWS unavailable: every AWS and Total figure is missing, Models still render', () => {
    const built = buildCosts({
      view: { kind: 'month', year: '2026' },
      today: TODAY,
      aws: { status: 'unavailable' },
      models: models([['2026-10-02', 7_000_000, { anthropic: 7_000_000 }]]),
    });
    expect(built.awsAvailable).toBe(false);
    expect(built.awsFetchedAt).toBeNull();
    expect(
      built.rows.every((r) => r.awsMicroUsd === null && r.totalMicroUsd === null && !r.estimate),
    ).toBe(true);
    expect(built.rows.find((r) => r.period === '2026-10')!.modelsMicroUsd).toBe(7_000_000);
    expect(built.totals).toMatchObject({
      awsMicroUsd: null,
      modelsMicroUsd: 7_000_000,
      totalMicroUsd: null,
    });
    expect(built.rows.find((r) => r.period === '2026-11')!.partial).toBe(true);
    expect(built.empty).toBe(false);
    expect(built.options).toEqual(['2026', '2025']);
  });

  it('Models unavailable: the mirror', () => {
    const built = buildCosts({
      view: { kind: 'month', year: '2026' },
      today: TODAY,
      aws: aws({ '2026-11': [svc('Amazon S3', 2_000_000)] }),
      models: { status: 'unavailable' },
    });
    const nov = built.rows.find((r) => r.period === '2026-11')!;
    expect(nov).toMatchObject({
      awsMicroUsd: 2_000_000,
      modelsMicroUsd: null,
      totalMicroUsd: null,
      partial: true,
      estimate: true,
    });
    expect(nov.modelLines).toEqual([]);
    expect(built.totals.totalMicroUsd).toBeNull();
    expect(built.empty).toBe(false);
  });

  it('both unavailable is not Empty — it is the error', () => {
    const built = buildCosts({
      view: { kind: 'day', month: '2026-11' },
      today: TODAY,
      aws: { status: 'unavailable' },
      models: { status: 'unavailable' },
    });
    expect(built.empty).toBe(false);
    expect(built.options).toEqual(['2026-11']);
  });
});

describe('buildCosts — Empty and the Year view', () => {
  it('is Empty when both answered and no row holds a cost', () => {
    const built = buildCosts({
      view: { kind: 'day', month: '2025-02' },
      today: TODAY,
      aws: aws({}, { fromDay: '2025-03-01', toDay: TODAY }),
      models: models([['2025-02-01', null]]),
    });
    expect(built.empty).toBe(true);
    expect(built.totals).toEqual({
      awsMicroUsd: null,
      modelsMicroUsd: null,
      totalMicroUsd: null,
      partial: false,
    });
  });

  it('lists only the years with a cost, oldest first, the current one Partial and Estimate', () => {
    const built = buildCosts({
      view: { kind: 'year' },
      today: TODAY,
      aws: aws(
        {
          '2024': [],
          '2025': [svc('Amazon S3', 3_000_000)],
          '2026': [svc('Amazon S3', 4_000_000)],
        },
        { fromDay: '2024-09-01', toDay: TODAY },
      ),
      models: models([['2025-05-05', 1_000_000, { anthropic: 1_000_000 }]], '2025-05-05'),
    });
    expect(built.rows.map((r) => [r.period, r.partial, r.estimate])).toEqual([
      ['2025', false, false],
      ['2026', true, true],
    ]);
    expect(built.rows[1]).toMatchObject({ modelsMicroUsd: null, totalMicroUsd: null });
    expect(built.totals).toEqual({
      awsMicroUsd: 7_000_000,
      modelsMicroUsd: 1_000_000,
      totalMicroUsd: 8_000_000,
      partial: true,
    });
    expect(built.options).toEqual([]);
  });
});
