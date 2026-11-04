import { InvalidReportWindowError } from '@/lib/reports/errors';

// Pure window/bucket math for the created-vs-resolved read (Story 6.3 ·
// Subtask 6.3.2). The service generates the FULL bucket axis here (so the
// chart's X axis has no holes on event-less buckets) and the repositories
// group server-side with Postgres `date_trunc` — these helpers reproduce
// `date_trunc`'s UTC semantics exactly (day = UTC midnight; week = the ISO
// Monday; month = the 1st), so the JS axis and the SQL group keys always
// agree. Everything is UTC, matching the 4.6.3 burndown's day-bucket
// convention.

/** The period buckets the verified Jira config offers (daily/weekly/monthly). */
export const REPORT_PERIODS = ['day', 'week', 'month'] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

export function isReportPeriod(raw: string): raw is ReportPeriod {
  return (REPORT_PERIODS as readonly string[]).includes(raw);
}

/** The days-back window cap (~a year — the card's bound; finding #57). */
export const MAX_REPORT_WINDOW_DAYS = 366;
/** The bucket-count cap — keeps the axis drawable and the read bounded, so a
 * `day` period caps the window at 120 days (the card's bound). */
export const MAX_REPORT_BUCKETS = 120;

const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC midnight of the given instant's calendar day. */
function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** `date_trunc(period, d)` in JS — UTC day / ISO-Monday week / month-first. */
export function bucketStart(period: ReportPeriod, d: Date): Date {
  const day = utcMidnight(d);
  switch (period) {
    case 'day':
      return day;
    case 'week': {
      // Postgres date_trunc('week') truncates to the ISO Monday.
      const sinceMonday = (day.getUTCDay() + 6) % 7;
      return new Date(day.getTime() - sinceMonday * DAY_MS);
    }
    case 'month':
      return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1));
  }
}

/** The bucket after `start` (which must itself be a bucket start). */
function nextBucket(period: ReportPeriod, start: Date): Date {
  switch (period) {
    case 'day':
      return new Date(start.getTime() + DAY_MS);
    case 'week':
      return new Date(start.getTime() + 7 * DAY_MS);
    case 'month':
      return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  }
}

/** A bucket's wire key — `YYYY-MM-DD` of its (UTC) start, matching the SQL
 * `to_char(date_trunc(...), 'YYYY-MM-DD')` group key. */
export function bucketKey(period: ReportPeriod, d: Date): string {
  return bucketStart(period, d).toISOString().slice(0, 10);
}

/**
 * The inclusive read window for a `daysBack` config ending "now": `start` is
 * UTC midnight `daysBack - 1` days ago (so the window spans exactly
 * `daysBack` calendar days including today) and `end` is the `now` instant.
 * Events are filtered to `[start, end]` inclusive (the AC's window-edge
 * rule); the FIRST bucket may begin before `start` (a week/month truncation
 * lands mid-bucket) but only in-window events count toward it.
 */
export function reportWindow(now: Date, daysBack: number): { start: Date; end: Date } {
  const start = new Date(utcMidnight(now).getTime() - (daysBack - 1) * DAY_MS);
  return { start, end: now };
}

/**
 * The full bucket-key axis covering `[start, end]` — `date_trunc(period,
 * start)` through `date_trunc(period, end)`, stepping one period. Bounded by
 * {@link validateReportWindow} (≤ {@link MAX_REPORT_BUCKETS} keys).
 */
export function bucketAxis(period: ReportPeriod, start: Date, end: Date): string[] {
  const keys: string[] = [];
  const last = bucketStart(period, end).getTime();
  for (let b = bucketStart(period, start); b.getTime() <= last; b = nextBucket(period, b)) {
    keys.push(b.toISOString().slice(0, 10));
  }
  return keys;
}

/**
 * For each bucket key on `axis`, the instant that bucket "closes" for a
 * point-in-time read (Subtask 8.8.13 average age): the START of the NEXT period
 * (its exclusive upper edge), CAPPED at the window `end` so the current/last
 * bucket measures age as-of the read instant ("now"), never a future instant.
 * Returned aligned 1:1 with `bucketAxis(period, start, end)`. UTC, matching
 * `date_trunc`.
 */
export function bucketEnds(period: ReportPeriod, axis: string[], end: Date): Date[] {
  return axis.map((key) => {
    const next = nextBucket(period, new Date(`${key}T00:00:00.000Z`));
    return next.getTime() <= end.getTime() ? next : end;
  });
}

/**
 * Validate a (period, daysBack) config — the typed 422 gate (finding #57:
 * the read is a capped grouped aggregate, never open-ended). `daysBack` must
 * be an integer in `[1, MAX_REPORT_WINDOW_DAYS]` AND the resulting axis must
 * fit `MAX_REPORT_BUCKETS` (so `day` caps at 120 days while `week`/`month`
 * reach the full year).
 */
export function validateReportWindow(period: ReportPeriod, daysBack: number): void {
  validateWindowDays(daysBack);
  // The day-period axis has exactly daysBack buckets; week/month strictly
  // fewer — checking the worst case (day) keeps the rule simple and total.
  if (period === 'day' && daysBack > MAX_REPORT_BUCKETS) {
    throw new InvalidReportWindowError(
      `a daily window is capped at ${MAX_REPORT_BUCKETS} days (got ${daysBack}); use a weekly or monthly period for longer windows.`,
    );
  }
}

/**
 * Validate the days back of a window that has NO bucket axis (Workload's ranked
 * bars, MOTIR-10346) — the typed 422 gate when `daysBack` is not an integer in
 * `[1, MAX_REPORT_WINDOW_DAYS]`. No bucket cap applies: there are no buckets.
 * {@link validateReportWindow} runs this same check before its bucket cap.
 */
export function validateWindowDays(daysBack: number): void {
  if (!Number.isInteger(daysBack) || daysBack < 1 || daysBack > MAX_REPORT_WINDOW_DAYS) {
    throw new InvalidReportWindowError(
      `daysBack must be an integer between 1 and ${MAX_REPORT_WINDOW_DAYS}.`,
    );
  }
}
