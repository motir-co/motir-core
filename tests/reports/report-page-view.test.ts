import { describe, expect, it } from 'vitest';
import {
  REPORT_DEFAULTS,
  DAYS_BACK_LADDER,
  maxDaysBackForPeriod,
  daysBackLadder,
  clampDaysBack,
  stepDaysBack,
  coercePeriod,
  coerceDaysBack,
  buildReportHref,
  coerceVelocityCount,
  coerceChartForm,
  coerceCvrSeries,
  stepVelocityCount,
  VELOCITY_COUNT_LADDER,
  PERIOD_LABEL_KEY,
  PERIOD_AXIS_KEY,
} from '@/lib/reports/reportPageView';
import { cvrBarGroups, differenceSeries, pickTickIndices } from '@/lib/reports/reportChartData';
import { MAX_REPORT_BUCKETS, MAX_REPORT_WINDOW_DAYS } from '@/lib/reports/buckets';
import type { CreatedVsResolvedDto } from '@/lib/dto/reports';

// Story 6.3 · Subtask 6.3.6 — the PURE halves of the report PAGES: the URL/
// ladder helpers (the control↔URL wiring's source of truth) and the DTO →
// chart-geometry transform. No DB, no React.

describe('days-back ladder', () => {
  it('caps the daily window at the bucket cap (never offers 365 for `day`)', () => {
    expect(maxDaysBackForPeriod('day')).toBe(MAX_REPORT_BUCKETS);
    expect(daysBackLadder('day')).not.toContain(365);
    expect(daysBackLadder('day').every((d) => d <= MAX_REPORT_BUCKETS)).toBe(true);
    // week/month get the full ladder.
    expect(daysBackLadder('week')).toEqual([...DAYS_BACK_LADDER]);
    expect(daysBackLadder('month')).toEqual([...DAYS_BACK_LADDER]);
  });

  it('clamps + snaps an arbitrary value to the nearest valid rung', () => {
    expect(clampDaysBack('week', 30)).toBe(30); // already on the ladder
    expect(clampDaysBack('week', 1)).toBe(7); // below min → min
    expect(clampDaysBack('week', 9999)).toBe(365); // above max → max
    expect(clampDaysBack('week', 100)).toBe(90); // nearest rung
    expect(clampDaysBack('day', 365)).toBe(90); // daily max rung ≤ 120
    expect(clampDaysBack('week', Number.NaN)).toBe(7); // non-finite → min
  });

  it('a window with no bucket axis (`null`, Workload — MOTIR-10346) gets the full ladder', () => {
    expect(maxDaysBackForPeriod(null)).toBe(MAX_REPORT_WINDOW_DAYS);
    expect(daysBackLadder(null)).toEqual([...DAYS_BACK_LADDER]);
    expect(clampDaysBack(null, 365)).toBe(365); // no daily cap to snap it under
    expect(clampDaysBack(null, 150)).toBe(180); // nearest rung (ties → the larger)
    expect(stepDaysBack(null, 90, 1)).toBe(180);
    expect(stepDaysBack(null, 180, 1)).toBe(365);
    expect(stepDaysBack(null, 365, 1)).toBe(365);
    expect(coerceDaysBack(null, '365')).toBe(365);
    expect(coerceDaysBack(null, null)).toBe(REPORT_DEFAULTS.daysBack);
    expect(coerceDaysBack(null, 'garbage')).toBe(REPORT_DEFAULTS.daysBack);
  });

  it('steps one rung at a time and stops at the ends', () => {
    expect(stepDaysBack('week', 30, 1)).toBe(60);
    expect(stepDaysBack('week', 30, -1)).toBe(14);
    expect(stepDaysBack('week', 7, -1)).toBe(7); // already at min
    expect(stepDaysBack('week', 365, 1)).toBe(365); // already at max
    // a mid-ladder value snaps in before stepping.
    expect(stepDaysBack('week', 100, 1)).toBe(180); // snaps to 90, then +1
  });
});

describe('forgiving coercion (page-level, never throws)', () => {
  it('coerces period, falling back to the default', () => {
    expect(coercePeriod('week')).toBe('week');
    expect(coercePeriod('month')).toBe('month');
    expect(coercePeriod('decade')).toBe(REPORT_DEFAULTS.period);
    expect(coercePeriod(null)).toBe('day');
  });

  it('coerces days-back against the period ladder', () => {
    expect(coerceDaysBack('week', null)).toBe(30);
    expect(coerceDaysBack('week', '90')).toBe(90);
    expect(coerceDaysBack('day', '365')).toBe(90); // re-snapped under the daily cap
    expect(coerceDaysBack('week', 'garbage')).toBe(30);
  });
});

describe('buildReportHref — omits defaults (clean, shareable URLs)', () => {
  const path = '/reports/created-vs-resolved';

  it('returns the bare path for an all-default config', () => {
    expect(buildReportHref(path, { period: 'day', daysBack: 30, cumulative: false })).toBe(path);
    expect(buildReportHref(path, {})).toBe(path);
  });

  it('serializes only the non-default params', () => {
    expect(buildReportHref(path, { period: 'week', daysBack: 90, cumulative: true })).toBe(
      `${path}?period=week&daysBack=90&cumulative=true`,
    );
  });

  it('carries a saved-filter scope but drops a null/project scope', () => {
    expect(buildReportHref(path, { savedFilterId: 'f1' })).toBe(`${path}?savedFilterId=f1`);
    expect(buildReportHref(path, { savedFilterId: null })).toBe(path);
  });

  it('serializes a non-default statistic only', () => {
    expect(buildReportHref('/reports/distribution', { statistic: 'status' })).toBe(
      '/reports/distribution',
    );
    expect(buildReportHref('/reports/distribution', { statistic: 'assignee' })).toBe(
      '/reports/distribution?statistic=assignee',
    );
  });
});

describe('period label-key maps are total', () => {
  it('maps every period to a control + axis key', () => {
    for (const p of ['day', 'week', 'month'] as const) {
      expect(PERIOD_LABEL_KEY[p]).toBe(`period.${p}`);
      expect(PERIOD_AXIS_KEY[p]).toBe(`periodAxis.${p}`);
    }
  });
});

function cvrDto(
  over: Partial<CreatedVsResolvedDto>,
  buckets: CreatedVsResolvedDto['buckets'],
): CreatedVsResolvedDto {
  return {
    period: 'week',
    daysBack: 90,
    cumulative: false,
    windowStart: '2026-01-01T00:00:00.000Z',
    windowEnd: '2026-03-01T00:00:00.000Z',
    buckets,
    ...over,
  };
}

describe('differenceSeries — DTO → chart geometry', () => {
  it('maps buckets to indexed series + nets + per-period totals', () => {
    const dto = cvrDto({ cumulative: false }, [
      { date: '2026-01-05', created: 8, resolved: 5 },
      { date: '2026-01-12', created: 4, resolved: 9 },
    ]);
    const s = differenceSeries(dto);
    expect(s.created).toEqual([
      { x: 0, y: 8 },
      { x: 1, y: 4 },
    ]);
    expect(s.resolved).toEqual([
      { x: 0, y: 5 },
      { x: 1, y: 9 },
    ]);
    expect(s.nets).toEqual([3, -5]);
    expect(s.bucketDates).toEqual(['2026-01-05', '2026-01-12']);
    expect(s.createdTotal).toBe(12); // sum of per-period
    expect(s.resolvedTotal).toBe(14);
    expect(s.yMax).toBeGreaterThanOrEqual(9);
    expect(s.yTicks[0]).toBe(0);
  });

  it('reads cumulative totals from the last running-sum bucket', () => {
    const dto = cvrDto({ cumulative: true }, [
      { date: '2026-01-05', created: 8, resolved: 5 },
      { date: '2026-01-12', created: 12, resolved: 14 },
    ]);
    const s = differenceSeries(dto);
    expect(s.createdTotal).toBe(12); // the last cumulative value, not the sum (20)
    expect(s.resolvedTotal).toBe(14);
  });

  it('never produces a zero/NaN axis for an all-empty window', () => {
    const s = differenceSeries(cvrDto({}, [{ date: '2026-01-05', created: 0, resolved: 0 }]));
    expect(s.createdTotal).toBe(0);
    expect(s.yMax).toBeGreaterThanOrEqual(1);
    expect(s.yTicks).not.toContain(Number.NaN);
  });
});

describe('pickTickIndices — bounded X-axis labels', () => {
  it('shows every index when the window is short', () => {
    expect(pickTickIndices(4)).toEqual([0, 1, 2, 3]);
    expect(pickTickIndices(0)).toEqual([]);
  });

  it('thins a long window to ~6 ticks including the endpoints', () => {
    const ticks = pickTickIndices(90);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBe(89);
    expect(ticks.length).toBeLessThanOrEqual(7);
    expect([...ticks].sort((a, b) => a - b)).toEqual(ticks); // ascending, deduped
  });
});

describe('Velocity range (Story MOTIR-8919)', () => {
  it('coerces ?count to a whole number in 1..52, defaulting on anything else', () => {
    expect(coerceVelocityCount(undefined)).toBe(7);
    expect(coerceVelocityCount(null)).toBe(7);
    expect(coerceVelocityCount('abc')).toBe(7);
    expect(coerceVelocityCount('0')).toBe(7);
    expect(coerceVelocityCount('-3')).toBe(7);
    expect(coerceVelocityCount('2.5')).toBe(7);
    expect(coerceVelocityCount('10')).toBe(10);
    expect(coerceVelocityCount('999')).toBe(52);
  });

  it('steps along 3·5·7·10·15·26·52 and snaps an off-ladder value first', () => {
    expect([...VELOCITY_COUNT_LADDER]).toEqual([3, 5, 7, 10, 15, 26, 52]);
    expect(stepVelocityCount(7, -1)).toBe(5);
    expect(stepVelocityCount(7, 1)).toBe(10);
    expect(stepVelocityCount(3, -1)).toBe(3);
    expect(stepVelocityCount(52, 1)).toBe(52);
    expect(stepVelocityCount(12, 1)).toBe(15); // snaps to 10, then up one rung
  });

  it('builds canonical hrefs and omits the defaults', () => {
    const base = '/reports/velocity';
    expect(buildReportHref(base, {})).toBe(base);
    expect(buildReportHref(base, { endingAt: null, count: 7 })).toBe(base);
    expect(buildReportHref(base, { endingAt: 'spr_1', count: 3 })).toBe(
      `${base}?endingAt=spr_1&count=3`,
    );
    expect(buildReportHref(base, { count: 10 })).toBe(`${base}?count=10`);
  });
});

describe('Created vs Resolved form and series (Story MOTIR-8919)', () => {
  it('buildReportHref omits the defaults and writes anything else', () => {
    expect(buildReportHref('/reports/created-vs-resolved', { form: 'line', series: 'both' })).toBe(
      '/reports/created-vs-resolved',
    );
    expect(buildReportHref('/reports/created-vs-resolved', { form: 'bars' })).toBe(
      '/reports/created-vs-resolved?form=bars',
    );
    expect(
      buildReportHref('/reports/created-vs-resolved', {
        period: 'week',
        daysBack: 90,
        cumulative: true,
        form: 'bars',
        series: 'resolved',
      }),
    ).toBe(
      '/reports/created-vs-resolved?period=week&daysBack=90&cumulative=true&form=bars&series=resolved',
    );
  });

  it('the coerce helpers turn junk, empty and none into the defaults — never zero series', () => {
    for (const raw of [null, undefined, '', 'none', 'neither', 'BARS', 'Created']) {
      expect(coerceCvrSeries(raw)).toBe('both');
    }
    expect(coerceCvrSeries('created')).toBe('created');
    expect(coerceCvrSeries('resolved')).toBe('resolved');
    for (const raw of [null, undefined, '', 'pie', 'line']) {
      expect(coerceChartForm(raw)).toBe('line');
    }
    expect(coerceChartForm('bars')).toBe('bars');
  });

  it('cvrBarGroups keeps one bar per visible series, in Created-then-Resolved order', () => {
    const s = differenceSeries(
      cvrDto({ cumulative: true }, [
        { date: '2026-01-05', created: 8, resolved: 5 },
        { date: '2026-01-12', created: 12, resolved: 14 },
      ]),
    );
    const labels = { created: 'Created', resolved: 'Resolved' };
    const colors = { created: 'c', resolved: 'r' };
    const label = (iso: string) => iso.slice(5);
    const both = cvrBarGroups(s, { created: true, resolved: true }, label, labels, colors);
    expect(both.series).toEqual([
      { label: 'Created', color: 'c' },
      { label: 'Resolved', color: 'r' },
    ]);
    expect(both.groups).toEqual([
      { label: '01-05', values: [8, 5] },
      { label: '01-12', values: [12, 14] },
    ]);
    const resolvedOnly = cvrBarGroups(s, { created: false, resolved: true }, label, labels, colors);
    expect(resolvedOnly.series).toEqual([{ label: 'Resolved', color: 'r' }]);
    expect(resolvedOnly.groups.map((g) => g.values)).toEqual([[5], [14]]);
    const createdOnly = cvrBarGroups(s, { created: true, resolved: false }, label, labels, colors);
    expect(createdOnly.groups.map((g) => g.values)).toEqual([[8], [12]]);
  });
});
