import { describe, expect, it } from 'vitest';
import {
  MAX_REPORT_BUCKETS,
  MAX_REPORT_WINDOW_DAYS,
  REPORT_PERIODS,
  bucketAxis,
  bucketKey,
  bucketStart,
  isReportPeriod,
  reportWindow,
  validateReportWindow,
  validateWindowDays,
} from '@/lib/reports/buckets';
import {
  BUILTIN_STATISTIC_TYPES,
  customFieldStatisticId,
  isDistributionCfFieldType,
  parseStatisticType,
} from '@/lib/reports/statisticTypes';
import {
  parseCumulative,
  parseDaysBack,
  parseMeasure,
  parsePeriod,
  parsePositiveInt,
  parseReportScope,
} from '@/lib/reports/params';
import {
  InvalidReportScopeError,
  InvalidReportWindowError,
  UnknownStatisticTypeError,
} from '@/lib/reports/errors';

// Story 6.3 · Subtask 6.3.2 — the pure halves of the widget/report reads:
// the window/bucket math (must reproduce Postgres `date_trunc` UTC semantics
// exactly — the JS axis and the SQL group keys may never disagree), the
// TOTAL statistic-type registry (mistake #29: every id resolves or throws
// typed — the enumeration below fails on any registry gap), and the route
// param parsers. No DB.

describe('bucketStart / bucketKey — date_trunc parity', () => {
  it('day truncates to UTC midnight', () => {
    const d = new Date('2026-06-11T17:45:12.345Z');
    expect(bucketStart('day', d).toISOString()).toBe('2026-06-11T00:00:00.000Z');
    expect(bucketKey('day', d)).toBe('2026-06-11');
  });

  it('week truncates to the ISO Monday (the Postgres rule)', () => {
    // 2026-06-11 is a Thursday → its ISO week starts Monday 2026-06-08.
    expect(bucketKey('week', new Date('2026-06-11T09:00:00Z'))).toBe('2026-06-08');
    // A Monday truncates to itself; a Sunday belongs to the PRECEDING Monday.
    expect(bucketKey('week', new Date('2026-06-08T00:00:00Z'))).toBe('2026-06-08');
    expect(bucketKey('week', new Date('2026-06-07T23:59:59Z'))).toBe('2026-06-01');
  });

  it('month truncates to the 1st', () => {
    expect(bucketKey('month', new Date('2026-06-30T23:00:00Z'))).toBe('2026-06-01');
    expect(bucketKey('month', new Date('2026-06-01T00:00:00Z'))).toBe('2026-06-01');
  });
});

describe('reportWindow / bucketAxis', () => {
  const now = new Date('2026-06-11T15:30:00Z');

  it('spans exactly daysBack calendar days ending today (edges inclusive)', () => {
    const { start, end } = reportWindow(now, 7);
    expect(start.toISOString()).toBe('2026-06-05T00:00:00.000Z');
    expect(end).toEqual(now);
    // daysBack = 1 → today only.
    expect(reportWindow(now, 1).start.toISOString()).toBe('2026-06-11T00:00:00.000Z');
  });

  it('generates the full day axis with no holes', () => {
    const { start, end } = reportWindow(now, 3);
    expect(bucketAxis('day', start, end)).toEqual(['2026-06-09', '2026-06-10', '2026-06-11']);
  });

  it('week/month axes start at the truncation of the window start', () => {
    const { start, end } = reportWindow(now, 14); // 2026-05-29 … 06-11
    // 05-29 is a Friday → its week bucket is Monday 05-25; then 06-01, 06-08.
    expect(bucketAxis('week', start, end)).toEqual(['2026-05-25', '2026-06-01', '2026-06-08']);
    expect(bucketAxis('month', start, end)).toEqual(['2026-05-01', '2026-06-01']);
    // A month axis steps calendar months, not 30-day blocks (the Feb case).
    expect(bucketAxis('month', new Date('2026-01-15T00:00:00Z'), now)).toEqual([
      '2026-01-01',
      '2026-02-01',
      '2026-03-01',
      '2026-04-01',
      '2026-05-01',
      '2026-06-01',
    ]);
  });

  it('the axis never exceeds the bucket cap for any valid config', () => {
    for (const period of REPORT_PERIODS) {
      for (const daysBack of [1, 30, MAX_REPORT_BUCKETS, MAX_REPORT_WINDOW_DAYS]) {
        try {
          validateReportWindow(period, daysBack);
        } catch {
          continue; // invalid combos are the 422 path, tested below
        }
        const { start, end } = reportWindow(now, daysBack);
        expect(bucketAxis(period, start, end).length).toBeLessThanOrEqual(MAX_REPORT_BUCKETS);
      }
    }
  });
});

describe('validateReportWindow — the typed 422 gate', () => {
  it('accepts the verified configs (day ≤ 120; week/month to a year)', () => {
    expect(() => validateReportWindow('day', 1)).not.toThrow();
    expect(() => validateReportWindow('day', MAX_REPORT_BUCKETS)).not.toThrow();
    expect(() => validateReportWindow('week', MAX_REPORT_WINDOW_DAYS)).not.toThrow();
    expect(() => validateReportWindow('month', MAX_REPORT_WINDOW_DAYS)).not.toThrow();
  });

  it('rejects out-of-range / non-integer windows', () => {
    for (const bad of [0, -1, 1.5, NaN, MAX_REPORT_WINDOW_DAYS + 1]) {
      expect(() => validateReportWindow('week', bad)).toThrow(InvalidReportWindowError);
    }
    // A daily axis over the bucket cap is the period-specific rejection.
    expect(() => validateReportWindow('day', MAX_REPORT_BUCKETS + 1)).toThrow(
      InvalidReportWindowError,
    );
  });
});

describe('validateWindowDays — a window with no bucket axis (Workload, MOTIR-10346)', () => {
  it('accepts every whole day count up to a year — no daily bucket cap', () => {
    for (const ok of [
      1,
      MAX_REPORT_BUCKETS,
      MAX_REPORT_BUCKETS + 1,
      180,
      365,
      MAX_REPORT_WINDOW_DAYS,
    ]) {
      expect(() => validateWindowDays(ok)).not.toThrow();
    }
  });

  it('rejects out-of-range / non-integer windows with the typed 422', () => {
    for (const bad of [0, -1, 1.5, NaN, MAX_REPORT_WINDOW_DAYS + 1]) {
      expect(() => validateWindowDays(bad)).toThrow(InvalidReportWindowError);
    }
  });
});

describe('statistic-type registry — TOTAL (mistake #29)', () => {
  it('every builtin id round-trips to a complete groupBy descriptor', () => {
    // The enumeration guard: a registry entry without a total descriptor (or
    // a descriptor kind the repository switch does not handle) fails here.
    expect(BUILTIN_STATISTIC_TYPES.length).toBeGreaterThanOrEqual(8);
    for (const def of BUILTIN_STATISTIC_TYPES) {
      const parsed = parseStatisticType(def.id);
      expect(parsed).toEqual({ kind: 'builtin', def });
      expect(['column', 'join', 'customField']).toContain(def.groupBy.kind);
    }
  });

  it('the cf:<fieldId> family parses by FORM (existence is the service’s stale check)', () => {
    expect(parseStatisticType(customFieldStatisticId('abc123'))).toEqual({
      kind: 'customField',
      fieldId: 'abc123',
    });
  });

  it('unknown ids and malformed cf ids are the typed 422', () => {
    for (const bad of ['bogus', '', 'cf:', 'CF:abc', 'labels']) {
      expect(() => parseStatisticType(bad)).toThrow(UnknownStatisticTypeError);
    }
  });

  it('the distribution cf field types are exactly the enum-ish ones', () => {
    expect(isDistributionCfFieldType('select')).toBe(true);
    expect(isDistributionCfFieldType('user')).toBe(true);
    for (const not of ['text', 'number', 'date']) {
      expect(isDistributionCfFieldType(not)).toBe(false);
    }
  });
});

describe('route param parsers', () => {
  it('parseReportScope enforces the XOR', () => {
    expect(parseReportScope(new URLSearchParams('projectId=p1'))).toEqual({ projectId: 'p1' });
    expect(parseReportScope(new URLSearchParams('savedFilterId=f1'))).toEqual({
      savedFilterId: 'f1',
    });
    expect(() => parseReportScope(new URLSearchParams(''))).toThrow(InvalidReportScopeError);
    expect(() => parseReportScope(new URLSearchParams('projectId=p1&savedFilterId=f1'))).toThrow(
      InvalidReportScopeError,
    );
  });

  it('parsePeriod defaults to day and rejects unknowns (typed)', () => {
    expect(parsePeriod(null)).toBe('day');
    expect(parsePeriod('week')).toBe('week');
    expect(parsePeriod('month')).toBe('month');
    expect(isReportPeriod('quarter')).toBe(false);
    expect(() => parsePeriod('quarter')).toThrow(InvalidReportWindowError);
  });

  it('parseDaysBack defaults to 30, rejects non-numerics, passes range to the service', () => {
    expect(parseDaysBack(null)).toBe(30);
    expect(parseDaysBack('90')).toBe(90);
    expect(() => parseDaysBack('soon')).toThrow(InvalidReportWindowError);
  });

  it('parseMeasure defaults to story_points and rejects unknowns (typed, 8.8.13)', () => {
    expect(parseMeasure(null)).toBe('story_points');
    expect(parseMeasure('story_points')).toBe('story_points');
    expect(parseMeasure('issue_count')).toBe('issue_count');
    expect(() => parseMeasure('hours')).toThrow(InvalidReportWindowError);
  });

  it('parseCumulative / parsePositiveInt are the forgiving toggles', () => {
    expect(parseCumulative('true')).toBe(true);
    expect(parseCumulative(null)).toBe(false);
    expect(parseCumulative('1')).toBe(false);
    expect(parsePositiveInt(null)).toBeUndefined();
    expect(parsePositiveInt('3')).toBe(3);
    expect(parsePositiveInt('0')).toBeUndefined();
    expect(parsePositiveInt('2.5')).toBeUndefined();
    expect(parsePositiveInt('x')).toBeUndefined();
  });
});
