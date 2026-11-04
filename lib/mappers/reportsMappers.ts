import type { EstimationStatisticDto } from '@/lib/dto/estimation';
import type {
  AverageAgeDto,
  BurndownStatisticDto,
  CreatedVsResolvedBucketDto,
  CreatedVsResolvedDto,
  CycleGraphDayDto,
  CycleGraphDto,
  DistributionDto,
  DistributionSegmentDto,
  ReportAgeBucketDto,
  ReportPeriodDto,
  ResolutionTimeDto,
  VelocityDto,
  VelocitySprintDto,
  WorkloadAssigneeDto,
  WorkloadDto,
  WorkloadMeasureDto,
} from '@/lib/dto/reports';

// Pure assemblers for the reports domain (Story 4.6). The service composes the
// raw figures (committed baselines + done-category roll-ups; the committed
// baseline + the per-day revision-trail deltas + the authoritative current
// remaining) then calls these to derive the wire shapes — no Prisma enum /
// Decimal leaks across the API boundary, no I/O, so they are unit-testable in
// isolation. Mirrors `lib/mappers/estimationMappers.ts`.
//
// Subtask 4.6.4 added the VELOCITY assembler (`toVelocityDto`); Subtask 4.6.3's
// burndown assembler was reframed by Story 8.14 into the LIVE-scope CYCLE GRAPH
// assembler (`toCycleGraphDto`, below) — the burndown assembler is retired.

/**
 * Build a `VelocityDto` from the per-sprint `{ committed, completed }` data
 * (already ordered oldest→newest for the X axis) + the configured statistic.
 * `averageCompleted` is the mean of `completed` over the returned sprints — the
 * planning forecast — rounded to two decimals to avoid float-noise display, and
 * `0` when there is no history (the low-history state; the UI renders "not
 * enough history yet"). PURE: no I/O, unit-testable in isolation.
 */
export function toVelocityDto(
  sprints: VelocitySprintDto[],
  statistic: EstimationStatisticDto,
): VelocityDto {
  const averageCompleted =
    sprints.length === 0
      ? 0
      : Math.round((sprints.reduce((sum, s) => sum + s.completed, 0) / sprints.length) * 100) / 100;
  return { sprints, averageCompleted, statistic };
}

/** Round to 2 decimals — kills float-sum noise in the wire numbers. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** The UTC calendar-day key (`YYYY-MM-DD`) for a `Date`. */
function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** UTC midnight of a `Date` (so day iteration is timezone-stable). */
function utcMidnight(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Story 8.14 · Subtask 8.14.2 — the Linear-style CYCLE GRAPH assembler.
// Burn-UP of LIVE scope vs completed: three cumulative actual series (scope /
// completed / started) reconstructed from per-day revision-trail deltas off the
// reconstructed start baselines, + an ideal `target` descent over WORKING days.
// PURE — no I/O; the service resolves all I/O (the live roll-up, the window, the
// trail deltas) and hands them in.
// ---------------------------------------------------------------------------

/** Mon–Fri (UTC) is a working day; Sat/Sun hold the target flat (Linear). */
function isWorkingDay(dayMs: number): boolean {
  const dow = new Date(dayMs).getUTCDay();
  return dow !== 0 && dow !== 6;
}

/**
 * The raw inputs the service hands the cycle-graph assembler. All I/O — the
 * sprint window, the reconstructed start baselines (each `current − Σ delta`, so
 * the cumulated series land EXACTLY on the live roll-up at the cutoff), and the
 * per-day deltas from `workItemRevisionRepository.aggregateSprintCycleByDay` — is
 * resolved upstream; this function is pure math over them.
 */
export interface CycleGraphInput {
  sprintId: string;
  state: 'active' | 'complete';
  statistic: BurndownStatisticDto;
  /** Sprint window start (the series' origin + the target's first day). */
  start: Date;
  /** Axis end — the target reaches 0 here (planned `endDate`, else `completedAt`/now). */
  axisEnd: Date;
  /** Last day the actual series are drawn (now for active, `completedAt` for complete). */
  actualCutoff: Date;
  /**
   * The SCOPE series' day-0 baseline, reconstructed (`currentScope − Σ scopeDelta`)
   * so the cumulated scope line lands EXACTLY on the live roll-up at the cutoff
   * (header reconciliation). This is the live-derived origin of the gray line.
   */
  scopeAtStart: number;
  /**
   * The TARGET line's origin + the scope-creep denominator — the committed scope
   * AS OF `start`. Resolved by the service from the immutable `startSprint`
   * snapshot (falling back to the live scope), NOT the trail reconstruction:
   * reconstructing it wrongly yields ~0 when items were assigned to the sprint
   * after `startDate`, which collapses the target onto the x-axis. May differ
   * from `scopeAtStart` (which the series needs for reconciliation).
   */
  committedAtStart: number;
  /** Completed points as of `start` (`currentCompleted − Σ completedDelta`). */
  completedAtStart: number;
  /** Started (left-`todo`) points as of `start` (`currentStarted − Σ startedDelta`). */
  startedAtStart: number;
  /** Per-UTC-day signed deltas from `aggregateSprintCycleByDay`. */
  dailyDeltas: Array<{
    day: string;
    scopeDelta: number;
    completedDelta: number;
    startedDelta: number;
  }>;
}

/**
 * Assemble a `CycleGraphDto` (the Linear cycle graph). The three ACTUAL series
 * are stepped cumulative lines built from the reconstructed start baselines +
 * the per-day deltas, drawn day by day and floored at 0; days AFTER
 * `actualCutoff` are `null` (the future of a live sprint). Because each baseline
 * is `current − Σ delta`, the last drawn `scope` / `completed` land EXACTLY on
 * the live roll-up's committed / completed — the chart and the scrum header never
 * disagree. The `target` line is the ideal even descent from `committedAtStart`
 * to 0 across the window's WORKING days, holding flat across weekends; it spans
 * the whole window (never `null`). `scopeCreepPct` is the fraction of scope added
 * after start. PURE — no I/O.
 */
export function toCycleGraphDto(input: CycleGraphInput): CycleGraphDto {
  const deltaByDay = new Map<
    string,
    { scopeDelta: number; completedDelta: number; startedDelta: number }
  >();
  for (const row of input.dailyDeltas) {
    deltaByDay.set(row.day, {
      scopeDelta: row.scopeDelta,
      completedDelta: row.completedDelta,
      startedDelta: row.startedDelta,
    });
  }

  const startMs = utcMidnight(input.start);
  // The axis spans whole days from start to axisEnd inclusive (≥ 1 day). A
  // misconfigured end before start collapses to the single start day.
  const endMs = Math.max(startMs, utcMidnight(input.axisEnd));
  const cutoffMs = Math.max(startMs, utcMidnight(input.actualCutoff));
  const dayCount = Math.round((endMs - startMs) / DAY_MS) + 1;

  // Total working days in the window — the denominator of the ideal descent. The
  // target loses an equal slice of `committedAtStart` each working day, reaching
  // 0 on the LAST working day, and holds flat across weekends. A window with ≤ 1
  // working day has no descent to draw → the target sits flat at the baseline.
  let totalWorkingDays = 0;
  for (let i = 0; i < dayCount; i++) {
    if (isWorkingDay(startMs + i * DAY_MS)) totalWorkingDays++;
  }

  const days: CycleGraphDayDto[] = [];
  let scopeRunning = input.scopeAtStart;
  let completedRunning = input.completedAtStart;
  let startedRunning = input.startedAtStart;
  let workingDaysElapsed = 0; // working days seen so far (incl. today if working)

  for (let i = 0; i < dayCount; i++) {
    const dayMs = startMs + i * DAY_MS;
    const key = dayKey(new Date(dayMs));
    if (isWorkingDay(dayMs)) workingDaysElapsed++;

    // Target: linear committed → 0 across the working days; a weekend holds the
    // most-recent working day's value (so `workingDaysElapsed` doesn't advance);
    // clamp the rank to ≥ 1 so a weekend-at-start sits at the baseline, not above.
    const rank = Math.max(1, workingDaysElapsed);
    const target =
      totalWorkingDays <= 1
        ? input.committedAtStart
        : input.committedAtStart * (1 - (rank - 1) / (totalWorkingDays - 1));

    let scope: number | null = null;
    let completed: number | null = null;
    let started: number | null = null;
    if (dayMs <= cutoffMs) {
      const d = deltaByDay.get(key);
      scopeRunning += d?.scopeDelta ?? 0;
      completedRunning += d?.completedDelta ?? 0;
      startedRunning += d?.startedDelta ?? 0;
      scope = round2(Math.max(0, scopeRunning));
      completed = round2(Math.max(0, completedRunning));
      started = round2(Math.max(0, startedRunning));
    }

    days.push({ date: key, scope, completed, started, target: round2(Math.max(0, target)) });
  }

  // Scope creep: the fraction of scope added after the committed baseline.
  // `currentScope` is the scope baseline plus every day's net scope delta (= the
  // live roll-up committed); creep is `(currentScope − committedAtStart) /
  // committedAtStart` — no committed scope → 0 (never `NaN` / Infinity). Rounded
  // to 4 dp (a fraction the UI renders as a %).
  const totalScopeDelta = input.dailyDeltas.reduce((sum, r) => sum + r.scopeDelta, 0);
  const currentScope = input.scopeAtStart + totalScopeDelta;
  const scopeCreepPct =
    input.committedAtStart > 0
      ? Math.round(((currentScope - input.committedAtStart) / input.committedAtStart) * 10000) /
        10000
      : 0;

  return {
    sprintId: input.sprintId,
    state: input.state,
    statistic: input.statistic,
    committedAtStart: round2(input.committedAtStart),
    scopeCreepPct,
    startDate: input.start.toISOString(),
    endDate: input.axisEnd.toISOString(),
    days,
  };
}

// ---------------------------------------------------------------------------
// Story 6.3 · Subtask 6.3.2 — the widget / report-page read assemblers
// ---------------------------------------------------------------------------

/**
 * Assemble a `CreatedVsResolvedDto` from the two grouped repository series.
 * `axis` is the FULL bucket-key list (`lib/reports/buckets.ts` — generated by
 * the service so event-less buckets render at 0, oldest → newest); the two
 * sparse series fill into it by key. With `cumulative` the created and (net)
 * resolved series are running-summed across the axis — server-side, so the
 * wire data IS the drawable series either way. PURE — no I/O.
 */
export function toCreatedVsResolvedDto(input: {
  period: ReportPeriodDto;
  daysBack: number;
  cumulative: boolean;
  windowStart: Date;
  windowEnd: Date;
  axis: string[];
  created: Array<{ bucket: string; count: number }>;
  resolved: Array<{ bucket: string; resolved: number }>;
}): CreatedVsResolvedDto {
  const createdByBucket = new Map(input.created.map((r) => [r.bucket, r.count]));
  const resolvedByBucket = new Map(input.resolved.map((r) => [r.bucket, r.resolved]));

  let createdRunning = 0;
  let resolvedRunning = 0;
  const buckets: CreatedVsResolvedBucketDto[] = input.axis.map((date) => {
    const created = createdByBucket.get(date) ?? 0;
    const resolved = resolvedByBucket.get(date) ?? 0;
    if (!input.cumulative) return { date, created, resolved };
    createdRunning += created;
    resolvedRunning += resolved;
    return { date, created: createdRunning, resolved: resolvedRunning };
  });

  return {
    period: input.period,
    daysBack: input.daysBack,
    cumulative: input.cumulative,
    windowStart: input.windowStart.toISOString(),
    windowEnd: input.windowEnd.toISOString(),
    buckets,
  };
}

/**
 * Assemble a `DistributionDto` from the grouped segment counts (already
 * count-descending from the repository). `total` is the segment-count sum —
 * the percentage denominator (join-backed statistics count an item once per
 * join row, the verified Jira multi-count behaviour). Percentages round to
 * one decimal (sum 100 ± rounding); an empty scope yields `{ total: 0,
 * segments: [] }` — never `NaN`. PURE — no I/O.
 */
export function toDistributionDto(
  statistic: string,
  rows: Array<{ id: string | null; label: string | null; count: number }>,
): DistributionDto {
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  const segments: DistributionSegmentDto[] = rows.map((r) => ({
    id: r.id,
    label: r.label,
    count: r.count,
    percentage: total === 0 ? 0 : Math.round((r.count / total) * 1000) / 10,
  }));
  return { statistic, total, segments };
}

// ---------------------------------------------------------------------------
// Story 8.8 · Subtask 8.8.13 — the three "More reports" assemblers
// ---------------------------------------------------------------------------

/**
 * Fill the sparse `{ bucket, avgDays, count }` rows from a per-bucket-average
 * read into the FULL axis (`lib/reports/buckets.ts` — event-less buckets carry
 * `avgDays: null`, the chart's "—", never `NaN`), rounding each average to one
 * decimal (a day-figure), and derive the WINDOW AVERAGE (the dashed line) as the
 * mean of the NON-NULL bucket averages — `null` when every bucket is empty.
 * Shared by the average-age + resolution-time reports (same vertical-bar shape).
 * PURE — no I/O.
 */
function assembleAgeBuckets(
  axis: string[],
  rows: Array<{ bucket: string; avgDays: number; count: number }>,
): { buckets: ReportAgeBucketDto[]; windowAverage: number | null } {
  const byBucket = new Map(rows.map((r) => [r.bucket, r]));
  const round1 = (n: number) => Math.round(n * 10) / 10;
  const buckets: ReportAgeBucketDto[] = axis.map((date) => {
    const row = byBucket.get(date);
    return row && row.count > 0
      ? { date, avgDays: round1(row.avgDays), count: row.count }
      : { date, avgDays: null, count: 0 };
  });
  const present = buckets.filter((b) => b.avgDays !== null) as Array<{ avgDays: number }>;
  const windowAverage =
    present.length === 0
      ? null
      : round1(present.reduce((sum, b) => sum + b.avgDays, 0) / present.length);
  return { buckets, windowAverage };
}

/** Assemble an `AverageAgeDto` — the per-bucket point-in-time average of how
 * old the still-unresolved issues are. PURE. */
export function toAverageAgeDto(input: {
  period: ReportPeriodDto;
  daysBack: number;
  windowStart: Date;
  windowEnd: Date;
  axis: string[];
  rows: Array<{ bucket: string; avgDays: number; openCount: number }>;
}): AverageAgeDto {
  const { buckets, windowAverage } = assembleAgeBuckets(
    input.axis,
    input.rows.map((r) => ({ bucket: r.bucket, avgDays: r.avgDays, count: r.openCount })),
  );
  return {
    period: input.period,
    daysBack: input.daysBack,
    windowStart: input.windowStart.toISOString(),
    windowEnd: input.windowEnd.toISOString(),
    buckets,
    windowAverage,
  };
}

/** Assemble a `ResolutionTimeDto` — the per-bucket average days-to-resolve,
 * keyed by resolution date. PURE. */
export function toResolutionTimeDto(input: {
  period: ReportPeriodDto;
  daysBack: number;
  windowStart: Date;
  windowEnd: Date;
  axis: string[];
  rows: Array<{ bucket: string; avgDays: number; resolvedCount: number }>;
}): ResolutionTimeDto {
  const { buckets, windowAverage } = assembleAgeBuckets(
    input.axis,
    input.rows.map((r) => ({ bucket: r.bucket, avgDays: r.avgDays, count: r.resolvedCount })),
  );
  return {
    period: input.period,
    daysBack: input.daysBack,
    windowStart: input.windowStart.toISOString(),
    windowEnd: input.windowEnd.toISOString(),
    buckets,
    windowAverage,
  };
}

/** One grouped workload row: totals, plus the segment split on the windowed read. */
export interface WorkloadRow {
  assigneeId: string | null;
  name: string | null;
  points: number;
  count: number;
  assignedPoints?: number;
  assignedCount?: number;
  unassignedPoints?: number;
  unassignedCount?: number;
}

/**
 * Assemble a `WorkloadDto` from the grouped workload rows. Ranks DESCENDING by
 * the active `measure` (story points or issue count) over the bar's TOTAL, with
 * the neutral "Unassigned" bucket — `assigneeId: null` — ALWAYS LAST regardless
 * of its size. `points` round to one decimal (story points are `Decimal(6,2)`);
 * totals are the sums. A snapshot row (no segment fields) is all-assigned:
 * `assigned* = total`, `unassigned* = 0`; the person-less bar's segments are 0
 * when the read left them out. `window` is the ISO-stringified span of a windowed
 * read — days back only, no period: the bars have no time buckets (MOTIR-10346)
 * — else `null`. An empty scope yields `{ assignees: [], totals 0 }` — never
 * `NaN`. PURE — no I/O.
 */
export function toWorkloadDto(
  measure: WorkloadMeasureDto,
  rows: WorkloadRow[],
  window?: { daysBack: number; windowStart: Date; windowEnd: Date },
): WorkloadDto {
  const round1 = (n: number) => Math.round(n * 10) / 10;
  const assignees: WorkloadAssigneeDto[] = rows.map((r) => {
    const windowed = r.assignedPoints !== undefined;
    const person = r.assigneeId !== null;
    return {
      assigneeId: r.assigneeId,
      name: r.name,
      points: round1(r.points),
      count: r.count,
      assignedPoints: round1(windowed ? r.assignedPoints! : person ? r.points : 0),
      assignedCount: windowed ? (r.assignedCount ?? 0) : person ? r.count : 0,
      unassignedPoints: round1(r.unassignedPoints ?? 0),
      unassignedCount: r.unassignedCount ?? 0,
    };
  });
  const measureVal = (a: WorkloadAssigneeDto) => (measure === 'issue_count' ? a.count : a.points);
  assignees.sort((a, b) => {
    // Unassigned bucket sinks to the bottom, then rank by the active measure.
    const au = a.assigneeId === null ? 1 : 0;
    const bu = b.assigneeId === null ? 1 : 0;
    if (au !== bu) return au - bu;
    if (measureVal(b) !== measureVal(a)) return measureVal(b) - measureVal(a);
    return (a.name ?? '').localeCompare(b.name ?? '');
  });
  return {
    measure,
    assignees,
    totalPoints: round1(assignees.reduce((sum, a) => sum + a.points, 0)),
    totalCount: assignees.reduce((sum, a) => sum + a.count, 0),
    window: window
      ? {
          daysBack: window.daysBack,
          windowStart: window.windowStart.toISOString(),
          windowEnd: window.windowEnd.toISOString(),
        }
      : null,
  };
}
