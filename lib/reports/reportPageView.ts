import {
  type ReportPeriod,
  MAX_REPORT_WINDOW_DAYS,
  MAX_REPORT_BUCKETS,
} from '@/lib/reports/buckets';
import type { WorkloadMeasureDto } from '@/lib/dto/reports';

// Client-safe view helpers for the Story-6.3 report PAGES (Subtask 6.3.6) — the
// `?period`/`?daysBack`/`?cumulative`/`?savedFilterId`/`?statistic` URL state and
// the days-back ladder the stepper steps through. Pure (no I/O, no React), so the
// report pages' controls and their tests share one source of truth, the
// `lib/issues/issueListView.ts` precedent. The server param parsers in
// `lib/reports/params.ts` throw on malformed input (the strict widget-route
// contract); these page helpers instead coerce-with-fallback (a hand-edited /
// shared report URL degrades to a sensible default, never a 422 the user can't
// recover from) and build canonical hrefs that OMIT defaults (clean URLs).

/** The report-page defaults — kept 1:1 with the `lib/reports/params.ts`
 * parser defaults (period `day`, daysBack `30`, cumulative `false`) so a
 * default-config URL is the bare path, and the distribution default statistic
 * (`status` — the verified Jira Pie-Chart default + the design's example). */
export const REPORT_DEFAULTS = {
  period: 'day' as ReportPeriod,
  daysBack: 30,
  cumulative: false,
  statistic: 'status',
  /** The workload report's default measure (Subtask 8.8.13) — story points,
   * Motir's workload unit. */
  measure: 'story_points' as WorkloadMeasureDto,
  /** Velocity's default window — the last 7 completed sprints (mirrors the
   * service's `DEFAULT_LAST_N`). */
  velocityCount: 7,
  /** Created vs Resolved: the difference-area LINE form. */
  form: 'line' as CvrChartForm,
} as const;

/** Created vs Resolved's chart form: the difference-area line, or grouped bars. */
export type CvrChartForm = 'line' | 'bars';
/** Which Created vs Resolved series are drawn — never "none". */
export type CvrSeries = 'both' | 'created' | 'resolved';

/** Coerce a raw `?form` to a chart form; anything but `bars` is the line. */
export function coerceChartForm(raw: string | null | undefined): CvrChartForm {
  return raw === 'bars' ? 'bars' : REPORT_DEFAULTS.form;
}

/** Coerce a raw `?series` to a series choice. Missing, unknown, empty and `none`
 * all mean both — a URL can never express zero series. */
export function coerceCvrSeries(raw: string | null | undefined): CvrSeries {
  return raw === 'created' || raw === 'resolved' ? raw : 'both';
}

/**
 * The sprint counts Velocity's "Sprints" stepper moves through (design notes,
 * "Sprint pickers"): 3 · 5 · 7 · 10 · 15 · 26 · 52. The top rung is the
 * service's `MAX_LAST_N`, so the control can never ask for more than the read
 * will return.
 */
export const VELOCITY_COUNT_LADDER = [3, 5, 7, 10, 15, 26, 52] as const;

/** Coerce a raw `?count` to a valid Velocity window: the default for anything
 * that is not a whole number ≥ 1, clamped to the ladder's top (52). Never
 * throws — a hand-edited link degrades instead of erroring. */
export function coerceVelocityCount(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || !/^-?\d+$/.test(raw.trim())) {
    return REPORT_DEFAULTS.velocityCount;
  }
  const n = Number(raw);
  if (n < 1) return REPORT_DEFAULTS.velocityCount;
  return Math.min(n, VELOCITY_COUNT_LADDER[VELOCITY_COUNT_LADDER.length - 1]!);
}

/** Step the Velocity count one rung along {@link VELOCITY_COUNT_LADDER}; an
 * off-ladder value snaps to the nearest rung first (ties → the larger). */
export function stepVelocityCount(current: number, dir: -1 | 1): number {
  const ladder = VELOCITY_COUNT_LADDER;
  const snapped = ladder.reduce((best, rung) =>
    Math.abs(rung - current) < Math.abs(best - current) ||
    (Math.abs(rung - current) === Math.abs(best - current) && rung > best)
      ? rung
      : best,
  );
  const i = ladder.indexOf(snapped);
  return ladder[Math.min(Math.max(i + dir, 0), ladder.length - 1)] ?? snapped;
}

/** Coerce a raw `?measure` to a valid workload measure, defaulting (never
 * throwing — the page-level forgiving parse; the widget route keeps the strict
 * `parseMeasure` thrower). */
export function coerceMeasure(raw: string | null): WorkloadMeasureDto {
  return raw === 'story_points' || raw === 'issue_count' ? raw : REPORT_DEFAULTS.measure;
}

/**
 * The discrete days-back windows the stepper moves through (the design's
 * "− 90 +" control). A ladder rather than a free ±N keeps every value a clean,
 * shareable window AND valid-by-construction (the daily period caps at
 * {@link MAX_REPORT_BUCKETS} buckets, so 365 days is never offered for `day`) —
 * the control can never produce the window the service would 422.
 */
export const DAYS_BACK_LADDER = [7, 14, 30, 60, 90, 180, 365] as const;

/**
 * The period a days-back window is bucketed by — or `null` for a window with NO
 * bucket axis (Workload's ranked bars, MOTIR-10346), which only the overall
 * {@link MAX_REPORT_WINDOW_DAYS} bounds. Every ladder helper below takes it.
 */
export type ReportWindowPeriod = ReportPeriod | null;

/** The max days-back a period can request without exceeding the bucket cap: a
 * DAILY window is bounded by {@link MAX_REPORT_BUCKETS} (one bucket per day),
 * week/month — and a window with no buckets (`null`) — by the overall
 * {@link MAX_REPORT_WINDOW_DAYS}. */
export function maxDaysBackForPeriod(period: ReportWindowPeriod): number {
  return period === 'day'
    ? Math.min(MAX_REPORT_BUCKETS, MAX_REPORT_WINDOW_DAYS)
    : MAX_REPORT_WINDOW_DAYS;
}

/** The ladder values valid for a period (≤ its max). Never empty — the
 * smallest rung (7) is always ≤ every period's cap. */
export function daysBackLadder(period: ReportWindowPeriod): number[] {
  return DAYS_BACK_LADDER.filter((d) => d <= maxDaysBackForPeriod(period));
}

/**
 * Snap an arbitrary days-back into the period's ladder: clamp to
 * `[min rung, period max]`, then round to the NEAREST rung (so a shared
 * `?daysBack=120` daily URL lands on 90, the nearest valid rung, not an
 * off-ladder value the stepper couldn't then move from).
 */
export function clampDaysBack(period: ReportWindowPeriod, daysBack: number): number {
  const ladder = daysBackLadder(period);
  const min = ladder[0]!;
  const max = ladder[ladder.length - 1]!;
  if (!Number.isFinite(daysBack) || daysBack <= min) return min;
  if (daysBack >= max) return max;
  // Nearest rung (ties → the larger, a slightly wider window).
  return ladder.reduce((best, rung) =>
    Math.abs(rung - daysBack) < Math.abs(best - daysBack) ? rung : best,
  );
}

/** Step the days-back one rung along its period's ladder (the stepper's −/+). A
 * value mid-ladder snaps in first, so the move is always to a real rung. */
export function stepDaysBack(period: ReportWindowPeriod, current: number, dir: -1 | 1): number {
  const ladder = daysBackLadder(period);
  const snapped = clampDaysBack(period, current);
  const i = ladder.indexOf(snapped);
  const next = ladder[Math.min(Math.max(i + dir, 0), ladder.length - 1)];
  return next ?? snapped;
}

/** Coerce a raw `?period` to a valid period, defaulting (never throwing — the
 * page-level forgiving parse; the widget route keeps the strict thrower). */
export function coercePeriod(raw: string | null): ReportPeriod {
  return raw === 'day' || raw === 'week' || raw === 'month' ? raw : REPORT_DEFAULTS.period;
}

/** Coerce a raw `?daysBack` to a valid, in-ladder window for the period
 * (`null`: a window with no bucket axis, whose ladder reaches 365). */
export function coerceDaysBack(period: ReportWindowPeriod, raw: string | null): number {
  const n = raw === null ? REPORT_DEFAULTS.daysBack : Number(raw);
  return clampDaysBack(period, Number.isFinite(n) ? n : REPORT_DEFAULTS.daysBack);
}

/** The report-page URL state (a subset per page — the created-vs-resolved page
 * uses period/daysBack/cumulative, the distribution page uses statistic; both
 * may carry a saved-filter scope). */
export interface ReportPageParams {
  /** A saved-filter scope, or null/undefined for the default project scope. */
  savedFilterId?: string | null;
  period?: ReportPeriod;
  daysBack?: number;
  cumulative?: boolean;
  statistic?: string;
  /** The workload report's measure (Subtask 8.8.13). */
  measure?: WorkloadMeasureDto;
  /** Velocity: the completed sprint the window ends at (omitted = the latest). */
  endingAt?: string | null;
  /** Velocity: how many completed sprints the window covers (omitted at 7). */
  count?: number;
  /** Created vs Resolved: the chart form (omitted for the line). */
  form?: CvrChartForm;
  /** Created vs Resolved: the visible series (omitted when both). */
  series?: CvrSeries;
}

/**
 * Build a canonical report-page href, OMITTING any param equal to its default
 * (clean, shareable URLs — the `buildIssueListHref` convention). The default
 * project scope drops `savedFilterId`; a default period/window/cumulative/
 * statistic drops its param, so the bare path always means "default config".
 */
export function buildReportHref(pathname: string, params: ReportPageParams): string {
  const sp = new URLSearchParams();
  if (params.savedFilterId) sp.set('savedFilterId', params.savedFilterId);
  if (params.period && params.period !== REPORT_DEFAULTS.period) sp.set('period', params.period);
  if (params.daysBack !== undefined && params.daysBack !== REPORT_DEFAULTS.daysBack) {
    sp.set('daysBack', String(params.daysBack));
  }
  if (params.cumulative) sp.set('cumulative', 'true');
  if (params.statistic && params.statistic !== REPORT_DEFAULTS.statistic) {
    sp.set('statistic', params.statistic);
  }
  if (params.measure && params.measure !== REPORT_DEFAULTS.measure) {
    sp.set('measure', params.measure);
  }
  if (params.endingAt) sp.set('endingAt', params.endingAt);
  if (params.count !== undefined && params.count !== REPORT_DEFAULTS.velocityCount) {
    sp.set('count', String(params.count));
  }
  if (params.form === 'bars') sp.set('form', 'bars');
  if (params.series === 'created' || params.series === 'resolved') {
    sp.set('series', params.series);
  }
  const qs = sp.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

/** The i18n key (under the `reports` namespace) for a period's control label. */
export const PERIOD_LABEL_KEY: Record<ReportPeriod, string> = {
  day: 'period.day',
  week: 'period.week',
  month: 'period.month',
};

/** The i18n key (under `reports`) for a period's axis/bucket noun (e.g. "Week"). */
export const PERIOD_AXIS_KEY: Record<ReportPeriod, string> = {
  day: 'periodAxis.day',
  week: 'periodAxis.week',
  month: 'periodAxis.month',
};
