import type { EstimationStatisticDto } from '@/lib/dto/estimation';

// DTO types for the reports domain (Story 4.6). The shapes that cross the API
// boundary for the iteration-measurement charts — no Prisma row / enum / Decimal
// leaks (point totals are plain `number`s, the statistic enum is a string union).
// Story 6.3 (dashboards & reports) reuses these shapes.
//
// This file is the shared `reports` DTO home: Subtask 4.6.4 added the cross-sprint
// VELOCITY read (`VelocityDto` / `VelocitySprintDto`); Subtask 4.6.3's in-sprint
// burndown read was reframed by Story 8.14 into the LIVE-scope CYCLE GRAPH
// (`CycleGraphDto`). The two are distinct reads sharing one module.

/**
 * One completed sprint's velocity datum — a single category on the velocity
 * bar chart's X axis. `committed` is the IMMUTABLE scope-lock baseline stamped
 * by `startSprint` (4.4.2) — the Jira "Committed" line, NOT a live re-sum — and
 * `completed` is the `category = 'done'` roll-up (`rollupForSprint().completed`,
 * 4.3.3 — the same aggregate the scrum header + sprint report show, so the bars
 * match those surfaces). Both are in the project's configured estimation
 * statistic (see `VelocityDto.statistic`). An unestimated sprint contributes 0,
 * never `NaN`.
 */
export interface VelocitySprintDto {
  sprintId: string;
  name: string;
  committed: number;
  completed: number;
}

/**
 * The cross-sprint velocity read (`reportsService.getVelocity`). `sprints` is
 * the last N COMPLETED sprints ordered **oldest → newest** (the X-axis order the
 * chart draws); `averageCompleted` is the mean of `completed` over the returned
 * sprints (the planning forecast — "your average velocity is N"), `0` when there
 * is no history; `statistic` is the configured estimation statistic the bars are
 * measured in (so the UI can label the Y axis + pick the "points" vs "issues"
 * wording).
 *
 * **Low history is a first-class state, not an error:** 0 completed sprints →
 * `{ sprints: [], averageCompleted: 0, statistic }` (the UI renders "not enough
 * history yet"); 1 sprint → a single datum whose `completed` is also the
 * average. The DTO stays total; the UI owns the empty-state copy.
 */
export interface VelocityDto {
  sprints: VelocitySprintDto[];
  averageCompleted: number;
  statistic: EstimationStatisticDto;
}

/**
 * Which statistic the in-sprint chart (the cycle graph; aliased as
 * `CycleGraphStatisticDto`) is measured in. Supports `story_points` and
 * `issue_count`. A project configured for `time_estimate`, or a sprint with no
 * point work (wholly unestimated), degrades to the `issue_count` series (there
 * is no committed-time baseline — a future refinement when committed-minutes
 * lands). So the wire form narrows the three-value `EstimationStatisticDto` to
 * the two the chart can draw — the UI labels the Y axis ("points" vs "issues")
 * off this.
 */
export type BurndownStatisticDto = 'story_points' | 'issue_count';

// ---------------------------------------------------------------------------
// Story 8.14 · Subtask 8.14.2 — the Linear-style sprint CYCLE GRAPH read
// (`reportsService.getSprintCycleGraph`). REFRAMES the old in-sprint burndown into
// Linear's cycle-graph model (linear.app/docs/cycle-graph): a burn-UP of LIVE
// scope vs completed, derived LIVE from the 1.4.6 revision trail so it no longer
// depends on the fragile immutable `committedPoints` snapshot (MOTIR-1285/1288).
// ---------------------------------------------------------------------------

/**
 * Which statistic the cycle graph is measured in — same narrowing the burndown
 * uses (`story_points` when the project measures points and the sprint has point
 * work, else the `issue_count` fallback); the UI labels the Y axis off this.
 */
export type CycleGraphStatisticDto = BurndownStatisticDto;

/**
 * One calendar day on the cycle graph's X axis. The three ACTUAL series are
 * CUMULATIVE points by day, drawn only up to the actual cutoff (today for a live
 * sprint, `completedAt` for a complete one) — `null` for the future days of a
 * live sprint (the chart leaves them undrawn). `target` is the ideal-remaining
 * line and spans the WHOLE window (it is the planned descent, not an actual), so
 * it is never `null`.
 *
 * - `scope` — the LIVE total estimate in the sprint by this day (the gray
 *   ceiling); RISES when an item is added or re-estimated up, FALLS on removal.
 * - `completed` — points in a `done`-category status by this day (the blue
 *   burn-UP line); reconciles to `rollupForSprint().completed` at the cutoff.
 * - `started` — points that have LEFT the `todo` category by this day (in
 *   progress OR done); always ≥ `completed`, ≤ `scope` (the amber band between
 *   `completed` and `started` is the in-progress work).
 * - `target` — the ideal even descent from the start scope to 0 across the
 *   sprint's REMAINING WORKING days, holding FLAT across weekends (Linear's
 *   working-day target). Compare the actual remaining (`scope − completed`) to it.
 */
export interface CycleGraphDayDto {
  /** UTC calendar day, `YYYY-MM-DD`. */
  date: string;
  scope: number | null;
  completed: number | null;
  started: number | null;
  target: number;
}

/**
 * The in-sprint CYCLE GRAPH read (`reportsService.getSprintCycleGraph`, 8.14.4).
 * A pure LIVE-scope read over data Stories 4.1 / 4.3 / 4.4 / 1.4.6 already ship
 * — NO new write model, NO migration, and crucially NO dependence on the
 * immutable `committedPoints` snapshot (the MOTIR-1285/1288 fragility): scope is
 * the live `rollupForSprint` committed sum and `committedAtStart` is
 * RECONSTRUCTED (`currentScope − Σ scopeDelta`), so a sprint started unestimated
 * or empty still renders correctly.
 *
 * `committedAtStart` is the scope as of `startDate` (the target line's origin +
 * the scope-creep denominator); `scopeCreepPct` is `(currentScope −
 * committedAtStart) / committedAtStart` (the fraction of scope added after start,
 * `0` when there was no start scope). `days` is one row per calendar day from
 * `startDate` to the axis end. The end-of-actual `completed` reconciles with
 * `rollupForSprint().completed` and `scope` with its `committed`, so the chart
 * agrees with the scrum header.
 *
 * Degraded / edge states are first-class (never `NaN`): a wholly unestimated
 * sprint comes back as the `issue_count` series; an empty sprint as flat 0
 * lines. A planned (not-started) sprint is rejected upstream
 * (`SprintNotStartedError`) — it has no window to draw.
 */
export interface CycleGraphDto {
  sprintId: string;
  /** `active` (actuals drawn to "today") or `complete` (drawn to `completedAt`). */
  state: 'active' | 'complete';
  statistic: CycleGraphStatisticDto;
  /** Scope as of `startDate`, reconstructed live — the scope-creep denominator. */
  committedAtStart: number;
  /** `(currentScope − committedAtStart) / committedAtStart`; `0` when no start scope. */
  scopeCreepPct: number;
  /** Sprint window start (ISO 8601). */
  startDate: string;
  /** Axis end (ISO 8601) — the planned `endDate`, else `completedAt`/now. */
  endDate: string;
  days: CycleGraphDayDto[];
}

// ---------------------------------------------------------------------------
// Story 6.3 · Subtask 6.3.2 — the widget / report-page data reads
// ---------------------------------------------------------------------------

/**
 * A widget/report data source — EXACTLY ONE of a project or a 6.2 saved
 * filter (the verified Jira gadget config pattern). Saved filters are
 * project-contained (the 6.2 recorded deviation), so either form resolves to
 * a single project scope; a dashboard aggregates cross-project
 * widget-by-widget, never via a cross-project filter.
 */
export type ReportScopeDto = { projectId: string } | { savedFilterId: string };

/** The period bucket of the created-vs-resolved read (the verified config). */
export type ReportPeriodDto = 'day' | 'week' | 'month';

/**
 * Why a widget read degraded to the STALE state (the 6.1.2 unknown-value
 * precedent — a deleted/broken referent is data, not an error):
 *   `filter_missing`     — the saved filter behind the widget was deleted
 *                          (or is invisible to the viewer — finding #44, the
 *                          two are indistinguishable by design), the 6.2.2
 *                          "filter missing" card.
 *   `filter_invalid`     — the stored envelope no longer decodes/validates
 *                          (malformed / future-versioned), the degraded
 *                          astError state 6.2.1 records.
 *   `statistic_missing`  — a distribution's `cf:<id>` statistic references a
 *                          deleted (or out-of-project) custom field.
 */
export type ReportStaleReasonDto = 'filter_missing' | 'filter_invalid' | 'statistic_missing';

/**
 * The per-viewer result envelope EVERY widget/report read returns (Subtask
 * 6.3.2). `no_access` is the 6.4 per-VIEWER gate — the scoped project (or
 * the filter's project) is one the REQUESTING user may not browse, so the
 * widget renders the designed locked state with NO counts, rows, or chart
 * shapes (the mirror behaviour: a gadget shows only what the viewer can
 * see). A missing project collapses into `no_access` (no existence leak —
 * finding #44). `stale` is the degraded-referent family above. Both are
 * 200-level DATA states (one broken widget never errors the dashboard);
 * malformed CONFIG (bad scope/window/statistic) is the typed 422 instead.
 */
export type ReportWidgetResultDto<T> =
  | { state: 'ok'; data: T }
  | { state: 'no_access' }
  | { state: 'stale'; reason: ReportStaleReasonDto };

/** One X-axis bucket of the created-vs-resolved chart. `resolved` is the NET
 * count (a reopen inside the window subtracts), so it can be negative on a
 * reopen-heavy bucket of the non-cumulative series. */
export interface CreatedVsResolvedBucketDto {
  /** The bucket's UTC start day, `YYYY-MM-DD` (`date_trunc` semantics —
   * weeks start on the ISO Monday, months on the 1st). */
  date: string;
  created: number;
  resolved: number;
}

/**
 * The created-vs-resolved read (`reportsService.getCreatedVsResolved`) — the
 * two-series difference/area chart's data. `created` buckets `createdAt`;
 * `resolved` buckets NET transitions into a done-CATEGORY status derived
 * from the 1.4.6 revision trail (the recorded deviation: our "resolution" IS
 * the done category — the SAME predicate the burndown/velocity/rollups use).
 * `buckets` is the FULL axis (event-less buckets present at 0), oldest →
 * newest; with `cumulative` the two series are running-summed within the
 * window server-side.
 */
export interface CreatedVsResolvedDto {
  period: ReportPeriodDto;
  daysBack: number;
  cumulative: boolean;
  /** Window start (ISO 8601, UTC midnight `daysBack - 1` days before `end`). */
  windowStart: string;
  /** Window end (ISO 8601 — the read instant). */
  windowEnd: string;
  buckets: CreatedVsResolvedBucketDto[];
}

/** One donut segment. A NULL `id` is the "None" bucket (unassigned / no
 * sprint / no label / no value — the designed None segment); `label` is the
 * referent's display name where one exists (status label, member/sprint/
 * label/component/option name) and null for self-describing enum ids
 * (kind / priority), which the UI translates. */
export interface DistributionSegmentDto {
  id: string | null;
  label: string | null;
  count: number;
  /** Percentage of the segment-count total, rounded to one decimal — the
   * legend's figure (sums to 100 ± rounding). */
  percentage: number;
}

/**
 * The distribution read (`reportsService.getDistribution`) — the donut's
 * data. ONE bounded GROUP-BY over the scoped items (finding #57), through
 * the TOTAL statistic-type registry (`lib/reports/statisticTypes.ts`).
 * Segments come back count-descending. NOTE the join-backed statistics
 * (label / component) count an item once PER join row (the verified Jira
 * multi-count behaviour), so `total` is the segment-count total — the
 * percentage denominator — not necessarily the item count.
 */
export interface DistributionDto {
  /** The statistic id (`status`, `assignee`, …, or `cf:<fieldId>`). */
  statistic: string;
  total: number;
  segments: DistributionSegmentDto[];
}

// ---------------------------------------------------------------------------
// Story 8.8 · Subtask 8.8.13 — the three "More reports" (average age /
// resolution time / workload). Each is a registry report (the 6.3.1 widget-type
// registry) AND a standalone report page (8.8.7 design `design/reports/`), so
// these DTOs cross the same widget-result envelope (`ReportWidgetResultDto`).
// ---------------------------------------------------------------------------

/**
 * One X-axis bucket of the average-age / resolution-time reports — a vertical
 * bar. `avgDays` is the bucket's average in DAYS, `null` for an event-less
 * bucket (the chart draws "—", never `NaN` — the 4.5.2 rule); `count` is the
 * population the average was taken over (the data-table's secondary column —
 * unresolved-at-period-end for average age, resolved-in-period for resolution
 * time). The bucket-key semantics match `lib/reports/buckets.ts`
 * (`date_trunc` — UTC day / ISO-Monday week / month-first).
 */
export interface ReportAgeBucketDto {
  /** The bucket's UTC start day, `YYYY-MM-DD`. */
  date: string;
  avgDays: number | null;
  count: number;
}

/**
 * The AVERAGE-AGE read (`reportsService.getAverageAge`) — a vertical bar of how
 * old the still-UNRESOLVED issues are, per period. For each bucket's period end
 * (capped at the read instant for the current bucket), the average of
 * `(periodEnd − createdAt)` over issues created by then and NOT yet in a
 * `done`-category status at that instant (reconstructed from the 1.4.6 revision
 * trail — an item's first done-category transition is its resolution point; the
 * SAME done-category predicate the burndown / velocity / created-vs-resolved
 * reports use, so every report agrees on "done"). `buckets` is the FULL axis
 * (event-less buckets carry `avgDays: null`), oldest → newest; `windowAverage`
 * is the mean of the non-null bucket averages (the dashed window-average line),
 * `null` when every bucket is empty.
 */
export interface AverageAgeDto {
  period: ReportPeriodDto;
  daysBack: number;
  /** Window start (ISO 8601, UTC midnight `daysBack - 1` days before `end`). */
  windowStart: string;
  /** Window end (ISO 8601 — the read instant). */
  windowEnd: string;
  buckets: ReportAgeBucketDto[];
  windowAverage: number | null;
}

/**
 * The RESOLUTION-TIME read (`reportsService.getResolutionTime`) — a vertical bar
 * of how long issues took to resolve, per period keyed by RESOLUTION date. For
 * each bucket, the average of `(resolvedAt − createdAt)` over issues that
 * entered a `done`-category status in that period; `resolvedAt` is that
 * done-category transition from the 1.4.6 revision trail (an item resolved,
 * reopened, then resolved again counts once per resolution — "issues that
 * entered a done-category status in that period"). Same axis/`windowAverage`
 * conventions as {@link AverageAgeDto}.
 */
export interface ResolutionTimeDto {
  period: ReportPeriodDto;
  daysBack: number;
  windowStart: string;
  windowEnd: string;
  buckets: ReportAgeBucketDto[];
  windowAverage: number | null;
}

/** The workload measure — story points (Motir's workload unit; Jira's
 * time-field maps to this) or a raw issue count. The horizontal-bar lengths +
 * the data table's primary column key off it. */
export type WorkloadMeasureDto = 'story_points' | 'issue_count';

/**
 * One person row of the workload report — a horizontal bar. `assigneeId`/
 * `name` are the bar's PERSON: the assignee, or — for the windowed read, where an
 * unassigned item goes on its reporter — the reporter. They are `null` only for
 * the neutral "Unassigned" bar (no assignee and no reporter; the UI labels it).
 * Both the `points` (summed `storyPoints`, unestimated counting 0) and `count`
 * (number of open issues) are carried so the Measure toggle is a client-side
 * re-rank with no refetch; they are the bar's TOTALS. The four segment fields
 * split those totals: `assigned*` is work the person is assigned, `unassigned*`
 * is unassigned work they reported (snapshot rows: `assigned* = total`,
 * `unassigned* = 0`; the person-less bar carries only totals).
 */
export interface WorkloadAssigneeDto {
  assigneeId: string | null;
  name: string | null;
  points: number;
  count: number;
  assignedPoints: number;
  assignedCount: number;
  unassignedPoints: number;
  unassignedCount: number;
}

/**
 * The WORKLOAD read (`reportsService.getWorkload`) — open (non-`done`-category,
 * non-archived) work per assignee, ranked. `assignees` is sorted DESCENDING by
 * the active `measure`, with the unassigned ("None") bucket ALWAYS LAST (the
 * design's neutral bucket). One bounded grouped query over current `work_item`
 * rows — no revision trail. Empty scope → `{ assignees: [], totals 0 }` (never
 * `NaN`).
 */
export interface WorkloadDto {
  measure: WorkloadMeasureDto;
  assignees: WorkloadAssigneeDto[];
  totalPoints: number;
  totalCount: number;
  /** The window a windowed read covered (ISO strings); `null` for the open-now
   * snapshot. Days back only — the bars have no time buckets, so no period
   * (MOTIR-10346). */
  window: {
    daysBack: number;
    windowStart: string;
    windowEnd: string;
  } | null;
}
