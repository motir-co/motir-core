import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildReportHref,
  clampDaysBack,
  coerceChartForm,
  coerceCvrSeries,
  coerceDaysBack,
  coerceMeasure,
  coercePeriod,
  coerceVelocityCount,
  daysBackLadder,
  type ReportPageParams,
} from '@/lib/reports/reportPageView';

// Story MOTIR-8919 · the story gate, cases 8–10. The URL vocabulary of the three
// reworked report pages as ONE set: whatever a control writes, the page's own
// coerce helpers read back unchanged, and whatever a hand-edited link carries
// still decodes to something the page can render. Pure — no DB, no React.

const WORKLOAD = '/reports/workload';
const CVR = '/reports/created-vs-resolved';
const VELOCITY = '/reports/velocity';

/** Read a built href the way each page does: parse the query, then coerce. */
function parse(href: string) {
  const sp = new URL(href, 'http://localhost').searchParams;
  return sp;
}

/** Workload reads no `period` (MOTIR-10346): its bars have no time buckets. */
function readWorkload(href: string): ReportPageParams {
  const sp = parse(href);
  return {
    savedFilterId: sp.get('savedFilterId'),
    measure: coerceMeasure(sp.get('measure')),
    daysBack: coerceDaysBack(null, sp.get('daysBack')),
  };
}

function readCvr(href: string): ReportPageParams {
  const sp = parse(href);
  const period = coercePeriod(sp.get('period'));
  return {
    savedFilterId: sp.get('savedFilterId'),
    period,
    daysBack: coerceDaysBack(period, sp.get('daysBack')),
    cumulative: sp.get('cumulative') === 'true',
    form: coerceChartForm(sp.get('form')),
    series: coerceCvrSeries(sp.get('series')),
  };
}

function readVelocity(href: string): ReportPageParams {
  const sp = parse(href);
  return {
    endingAt: sp.get('endingAt'),
    count: coerceVelocityCount(sp.get('count')),
  };
}

describe('story gate B8 — every page parameter round-trips through buildReportHref', () => {
  const workload: ReportPageParams[] = [
    { savedFilterId: null, measure: 'story_points', daysBack: 30 },
    { savedFilterId: 'flt_1', measure: 'issue_count', daysBack: 90 },
    { savedFilterId: null, measure: 'story_points', daysBack: 365 },
    { savedFilterId: 'flt_2', measure: 'issue_count', daysBack: 180 },
  ];
  it.each(workload)('Workload %j', (p) => {
    const href = buildReportHref(WORKLOAD, p);
    expect(readWorkload(href)).toEqual(p);
  });

  const cvr: ReportPageParams[] = [
    {
      savedFilterId: null,
      period: 'day',
      daysBack: 30,
      cumulative: false,
      form: 'line',
      series: 'both',
    },
    {
      savedFilterId: 'flt_1',
      period: 'week',
      daysBack: 180,
      cumulative: true,
      form: 'bars',
      series: 'resolved',
    },
    {
      savedFilterId: null,
      period: 'day',
      daysBack: 90,
      cumulative: false,
      form: 'bars',
      series: 'created',
    },
    {
      savedFilterId: null,
      period: 'month',
      daysBack: 365,
      cumulative: true,
      form: 'line',
      series: 'created',
    },
  ];
  it.each(cvr)('Created vs Resolved %j', (p) => {
    const href = buildReportHref(CVR, p);
    expect(readCvr(href)).toEqual(p);
  });

  const velocity: ReportPageParams[] = [
    { endingAt: null, count: 7 },
    { endingAt: 'spr_9', count: 7 },
    { endingAt: null, count: 52 },
    { endingAt: 'spr_3', count: 3 },
    { endingAt: 'spr_3', count: 26 },
  ];
  it.each(velocity)('Velocity %j', (p) => {
    const href = buildReportHref(VELOCITY, p);
    expect(readVelocity(href)).toEqual(p);
  });

  it('writes the bare path at every default', () => {
    expect(buildReportHref(WORKLOAD, { measure: 'story_points', daysBack: 30 })).toBe(WORKLOAD);
    expect(
      buildReportHref(CVR, {
        period: 'day',
        daysBack: 30,
        cumulative: false,
        form: 'line',
        series: 'both',
      }),
    ).toBe(CVR);
    expect(buildReportHref(VELOCITY, { endingAt: null, count: 7 })).toBe(VELOCITY);
  });
});

describe('story gate B9 — junk decodes to something the page can render', () => {
  const junk = ['', 'none', 'bogus', '-3', '999', '0', '2.5', 'NaN'];

  it.each(junk)('Created vs Resolved never decodes to zero series (%j)', (raw) => {
    expect(['both', 'created', 'resolved']).toContain(coerceCvrSeries(raw));
    expect(['line', 'bars']).toContain(coerceChartForm(raw));
    expect(coerceCvrSeries(raw)).toBe('both');
  });

  it.each(junk)('Velocity count lands in 1..52 (%j)', (raw) => {
    const n = coerceVelocityCount(raw);
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(52);
  });

  it.each(junk)('Workload days back lands on its bucket-free ladder (%j)', (raw) => {
    expect(daysBackLadder(null)).toContain(coerceDaysBack(null, raw));
    expect(clampDaysBack(null, coerceDaysBack(null, raw))).toBe(coerceDaysBack(null, raw));
    expect(['story_points', 'issue_count']).toContain(coerceMeasure(raw));
  });

  it.each(junk)('a bucketed report’s days back lands on its period ladder (%j)', (raw) => {
    for (const period of ['day', 'week', 'month'] as const) {
      expect(daysBackLadder(period)).toContain(coerceDaysBack(period, raw));
      expect(clampDaysBack(period, coerceDaysBack(period, raw))).toBe(coerceDaysBack(period, raw));
    }
    expect(['day', 'week', 'month']).toContain(coercePeriod(raw));
  });

  it('an old Workload link that carries ?period= reads exactly as the link without it', () => {
    const withPeriod = `${WORKLOAD}?period=week&daysBack=365&measure=issue_count`;
    expect(readWorkload(withPeriod)).toEqual(
      readWorkload(`${WORKLOAD}?daysBack=365&measure=issue_count`),
    );
    expect(readWorkload(`${WORKLOAD}?period=day&daysBack=365`).daysBack).toBe(365);
  });

  it('a repeated key reads as the first value, never as zero series', () => {
    const sp = new URLSearchParams(
      'series=resolved&series=none&count=5&count=999&form=bars&form=x',
    );
    expect(coerceCvrSeries(sp.get('series'))).toBe('resolved');
    expect(coerceVelocityCount(sp.get('count'))).toBe(5);
    expect(coerceChartForm(sp.get('form'))).toBe('bars');
  });
});

describe('story gate B10 — the parameter names equal the design notes’', () => {
  const notes = readFileSync(join(__dirname, '../../design/reports/design-notes.md'), 'utf8');

  it('names period/daysBack, form/series and endingAt/count, and the code writes exactly those', () => {
    // The MOTIR-10346 amendment: Workload's URL carries `daysBack` only.
    expect(notes).toContain('`daysBack` (Workload) beside `?savedFilterId=&measure=`');
    expect(notes).toContain('`form`, `series` (Created vs Resolved)');
    expect(notes).toContain('`endingAt`, `count` (Velocity)');

    const w = buildReportHref(WORKLOAD, { daysBack: 90, measure: 'issue_count' });
    expect([...parse(w).keys()].sort()).toEqual(['daysBack', 'measure']);
    const c = buildReportHref(CVR, { form: 'bars', series: 'resolved' });
    expect([...parse(c).keys()].sort()).toEqual(['form', 'series']);
    expect(parse(c).get('form')).toBe('bars');
    expect(parse(c).get('series')).toBe('resolved');
    const v = buildReportHref(VELOCITY, { endingAt: 'spr_1', count: 10 });
    expect([...parse(v).keys()].sort()).toEqual(['count', 'endingAt']);
  });

  it('the notes spell the non-default values the code writes', () => {
    expect(notes).toContain('`?form=bars`');
    expect(notes).toContain('`?series=created|resolved`');
  });
});
