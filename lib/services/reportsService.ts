import type { EstimationStatistic, Prisma, Sprint } from '@/generated/prisma/client';
import { customFieldDefinitionRepository } from '@/lib/repositories/customFieldDefinitionRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { savedFilterRepository } from '@/lib/repositories/savedFilterRepository';
import { sprintRepository } from '@/lib/repositories/sprintRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { estimationService } from '@/lib/services/estimationService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import { loadFilterReferents, workItemsService } from '@/lib/services/workItemsService';
import {
  toAverageAgeDto,
  toCreatedVsResolvedDto,
  toCycleGraphDto,
  toDistributionDto,
  toResolutionTimeDto,
  toVelocityDto,
  toWorkloadDto,
} from '@/lib/mappers/reportsMappers';
import {
  PermissionDeniedError,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';
import { SavedFilterNotFoundError } from '@/lib/savedFilters/errors';
import { SprintNotFoundError, SprintNotStartedError } from '@/lib/sprints/errors';
import { UnknownStatisticTypeError } from '@/lib/reports/errors';
import {
  isDistributionCfFieldType,
  parseStatisticType,
  type DistributionGroupBy,
} from '@/lib/reports/statisticTypes';
import {
  bucketAxis,
  bucketEnds,
  reportWindow,
  validateReportWindow,
  validateWindowDays,
  type ReportPeriod,
} from '@/lib/reports/buckets';
import { DEFAULT_SORT } from '@/lib/issues/issueListView';
import type { FilterAst } from '@/lib/filters/ast';
import type { ProjectFilterReferents } from '@/lib/filters/registry';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { EstimationStatisticDto } from '@/lib/dto/estimation';
import type { PagedIssueListDto } from '@/lib/dto/workItems';
import type {
  AverageAgeDto,
  BurndownStatisticDto,
  CreatedVsResolvedDto,
  CycleGraphDto,
  DistributionDto,
  ReportScopeDto,
  ReportWidgetResultDto,
  ResolutionTimeDto,
  VelocityDto,
  VelocitySprintDto,
  WorkloadDto,
  WorkloadMeasureDto,
} from '@/lib/dto/reports';
import { readProject } from '@/lib/workspaces/tenantRead';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// Reports service (Story 4.6) — the read-only analytics layer over the data
// Stories 4.1 / 4.3 / 4.4 / 1.4.6 already ship: NO new write model, NO
// migration. It is the home Epic 6.3 (dashboards & reports) extends. Subtask
// 4.6.4 added the cross-sprint VELOCITY aggregate (`getVelocity`); Subtask 4.6.3
// added the in-sprint burndown, reframed by Story 8.14 into the LIVE-scope CYCLE
// GRAPH (`getSprintCycleGraph`) — the burndown read is retired.
//
// 4-layer (CLAUDE.md): reads only, so no transaction — the service composes
// bounded repository reads + the shipped `estimationService.rollupForSprint`
// aggregate, and maps to a DTO via `reportsMappers`. Repositories stay single-op
// leaves; the route is a thin HTTP transport.
//
// BOUND READS (MOTIR-2800): this file used to contain ZERO context wrappers, so
// under the non-bypass `motir_app` role every aggregate below returned an empty
// result and every chart drew a flat zero line — the WHERE clause was correctly
// scoped by `workspaceId`, but nothing bound the per-TRANSACTION GUC the RLS
// policy reads. Each report method now opens ONE
// `withWorkspaceServiceContext(ctx.workspaceId, …)` at its own boundary and
// threads that `tx` into its reads, per
// `docs/decisions/bound-read-transaction-shape.md`. The WORKSPACE tier is
// sufficient and no more than sufficient: every table these aggregates touch
// (`work_item`, `work_item_revision`, `workflow_status`, `sprint`,
// `custom_field_*`, `label`, `component`) keys purely on `app.workspace_id`,
// read from `pg_policies` rather than from the migrations. The restrictive
// `work_item_project_narrow` passes on its `coalesce(…) = ''` branch when
// `app.project_id` is unbound, which is what these project-scoped reads want.
//
// TENANCY (finding #26): every path carries an explicit `workspaceId` — the
// project / sprint is gated by id + workspaceId (a cross-workspace entity is an
// indistinguishable 404), and the underlying `rollupForSprint` / sprint /
// revision reads each carry the same gate. BOUNDED (finding #57): velocity is a
// `LIMIT N` sprint read + N (≤ MAX_LAST_N) bounded roll-ups; the burndown is a
// grouped per-day aggregate over the revision rows scoped to the sprint window —
// neither loads an all-sprints / all-issues / all-revisions row set.

/** Jira's default velocity window — the last 7 completed sprints. */
const DEFAULT_LAST_N = 7;
/**
 * Upper bound on the velocity window. Keeps the bounded fan-out bounded even if
 * a caller passes a large `lastN` (one rollup query per returned sprint). 52 ≈ a
 * year of weekly sprints — generous for the forecast while still O(1)-ish.
 */
const MAX_LAST_N = 52;

export const reportsService = {
  /**
   * The cross-sprint VELOCITY aggregate (Story 4.6.4) — the planning forecast.
   * Returns the last `lastN` COMPLETED sprints (oldest→newest for the X axis),
   * each with its IMMUTABLE committed baseline (`startSprint`, 4.4.2 — the Jira
   * "Committed" line, NOT a live re-sum) and its `category = 'done'` completed
   * roll-up (`rollupForSprint().completed`, 4.3.3 — the SAME aggregate the scrum
   * header + sprint report show, so the bars match those surfaces), plus the
   * average completed across the window.
   *
   * With `endSprintId` the window is the `lastN` completed sprints AT OR BEFORE
   * that sprint (Story MOTIR-8919), in the same `completedAt desc, sequence desc`
   * order, still drawn oldest→newest with the end sprint right-most. An id that is
   * not a completed sprint of THIS project (unknown, another project's, active,
   * planned) falls back to the default window — never an error and never another
   * project's data.
   *
   * Bounded (finding #57): a `LIMIT N` sprint query + N (≤ {@link MAX_LAST_N})
   * bounded roll-ups — never every sprint, never every issue. Low-history is a
   * first-class state: 0 completed sprints → `{ sprints: [], averageCompleted:
   * 0 }`; 1 sprint → a single datum whose `completed` is the average.
   * Unestimated sprints contribute 0, never `NaN`.
   *
   * Throws: `ProjectNotFoundError` (404 — unknown / cross-workspace project).
   */
  async getVelocity(
    input: { projectId: string; lastN?: number; endSprintId?: string },
    ctx: ServiceContext,
  ): Promise<VelocityDto> {
    // `report:view` (MOTIR-2351), which SUBSUMES the hand-rolled tenancy gate that
    // stood here: `assertPermission` resolves the project against the actor's
    // workspace first and raises the same indistinguishable 404 for a missing or
    // cross-workspace id, then tests the key. This route was ungated end-to-end
    // before — the one row in this card that had no gate at all.
    await projectAccessService.assertPermission(input.projectId, ctx, 'report:view');

    const limit = clampLastN(input.lastN);
    // ONE bound transaction for this method's own two reads: the configured
    // statistic (which picks the committed-baseline column and labels the Y
    // axis) and the bounded `LIMIT N` page of completed sprints. The per-sprint
    // roll-ups below are SERVICE calls and open their own — see the
    // call-into-another-service clause in the transaction-shape ADR.
    const { statistic, sprints } = await withWorkspaceServiceContext(
      ctx.workspaceId,
      async (tx) => {
        const end = input.endSprintId
          ? await sprintRepository.findById(input.endSprintId, ctx.workspaceId, tx)
          : null;
        const endsAt =
          end && end.projectId === input.projectId && end.state === 'complete' && end.completedAt
            ? { completedAt: end.completedAt, sequence: end.sequence }
            : null;
        return {
          statistic: await resolveStatistic(input.projectId, tx),
          sprints: endsAt
            ? await sprintRepository.listCompletedByProjectEndingAt(
                input.projectId,
                ctx.workspaceId,
                endsAt,
                limit,
                tx,
              )
            : await sprintRepository.listCompletedByProject(
                input.projectId,
                ctx.workspaceId,
                limit,
                tx,
              ),
        };
      },
    );

    // Per sprint: committed = the O(1) stored baseline; completed = the bounded
    // 4.3.3 done-category roll-up. A bounded fan-out of N (≤ MAX_LAST_N) reads,
    // never an all-issues scan. Reads are independent → run them concurrently.
    const data: VelocitySprintDto[] = await Promise.all(
      sprints.map(async (sprint) => {
        const rollup = await estimationService.rollupForSprint(sprint.id, ctx);
        return {
          sprintId: sprint.id,
          name: sprint.name,
          committed: committedBaseline(sprint, statistic),
          completed: rollup.completed,
        };
      }),
    );

    // The read was newest-first (for the LIMIT); the chart's X axis runs
    // oldest→newest, so reverse before mapping.
    data.reverse();
    return toVelocityDto(data, statistic as EstimationStatisticDto);
  },

  /**
   * The in-sprint CYCLE GRAPH series (Story 8.14.4) — Linear's reframe of the
   * burndown into a burn-UP of LIVE scope vs completed (linear.app/docs/cycle-graph).
   * Returns, for a started sprint, three cumulative actual series (scope /
   * completed / started) reconstructed from the 1.4.6 `work_item_revision` trail
   * + an ideal `target` descent over the sprint's WORKING days.
   *
   * The SERIES are snapshot-free (resolves the MOTIR-1288 class): each actual
   * series is cumulated off its RECONSTRUCTED start baseline (`current − Σ
   * delta`), so the last drawn `scope` / `completed` land EXACTLY on
   * `rollupForSprint().committed` / `.completed` — the chart reconciles with the
   * scrum header even when the sprint was started unestimated/empty. The TARGET's
   * origin (`committedAtStart`) is resolved SEPARATELY from the immutable
   * `startSprint` snapshot (falling back to the live scope), NOT the trail — the
   * trail reconstruction wrongly yields ~0 when items are assigned to the sprint
   * after `startDate`, which would collapse the target onto the x-axis.
   *
   * Statistic: the project's configured statistic, narrowed to `story_points`
   * when the sprint has point work, else the `issue_count` fallback (the SAME
   * `useCount` rule as the burndown) — current sums are read in that series unit,
   * so an unestimated/time-estimate project degrades to counts, never `NaN`.
   *
   * Bounded (finding #57): one grouped per-day `$queryRaw` over the revision rows
   * + a bounded roll-up + two O(1) current-sum reads — never an all-revisions or
   * all-issues load. The day count is bounded by the sprint length.
   *
   * Throws: `SprintNotFoundError` (404 — unknown / cross-workspace sprint);
   * `SprintNotStartedError` (409 — a planned sprint has no window to draw).
   */
  async getSprintCycleGraph(sprintId: string, ctx: ServiceContext): Promise<CycleGraphDto> {
    // Tenancy gate (finding #26): a missing / cross-workspace sprint is an
    // indistinguishable 404 (finding #26).
    const sprint = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      sprintRepository.findById(sprintId, ctx.workspaceId, tx),
    );
    if (!sprint) throw new SprintNotFoundError(sprintId);
    // `report:view` (MOTIR-2351) — a burndown is a report; it was mapped to
    // `sprint:manage` only because it lives under a sprint URL, and a URL is not
    // a policy.
    await projectAccessService.assertPermission(sprint.projectId, ctx, 'report:view');

    // A cycle graph needs a window: reject a not-yet-started (planned) sprint.
    if (sprint.state === 'planned' || sprint.startDate === null) {
      throw new SprintNotStartedError(sprintId);
    }
    const start = sprint.startDate;

    // The configured statistic + the authoritative present roll-up (4.3.3) — the
    // latter decides whether the sprint has POINTS work to draw (`committed > 0`).
    const projectStatistic = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      resolveStatistic(sprint.projectId, tx),
    );
    const rollup = await estimationService.rollupForSprint(sprintId, ctx);

    // Draw the POINTS cycle graph when the project measures points AND the sprint
    // has point work; else degrade to the issue-count series (a non-points
    // project, or a wholly unestimated sprint). NO `committedPoints` dependence —
    // the live roll-up alone decides (the MOTIR-1285/1288 fix).
    const useCount = projectStatistic !== 'story_points' || rollup.committed === 0;
    const statistic: BurndownStatisticDto = useCount ? 'issue_count' : 'story_points';
    const seriesStat: EstimationStatistic = statistic;

    // The authoritative CURRENT values in the SERIES unit (so a degraded
    // issue-count series anchors to counts, not points). Reuse the roll-up when
    // it is already in the series unit; otherwise re-read the sums in that unit.
    let currentScope: number;
    let currentCompleted: number;
    let currentStarted: number;
    // ONE bound transaction for this method's own reads. `rollupForSprint` above
    // is a SERVICE call with its own gate and its own context — it is not pulled
    // inside, because nesting a service inside a transaction it knows nothing
    // about is how a second `BEGIN` gets attempted.
    if (seriesStat === projectStatistic) {
      currentScope = rollup.committed;
      currentCompleted = rollup.completed;
      currentStarted = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        workItemRepository.sumStartedForSprint(sprintId, ctx.workspaceId, seriesStat, tx),
      );
    } else {
      const both = await withWorkspaceServiceContext(ctx.workspaceId, async (tx) => ({
        sums: await workItemRepository.sumPointsForSprint(
          sprintId,
          ctx.workspaceId,
          seriesStat,
          tx,
        ),
        started: await workItemRepository.sumStartedForSprint(
          sprintId,
          ctx.workspaceId,
          seriesStat,
          tx,
        ),
      }));
      currentScope = both.sums.committed;
      currentCompleted = both.sums.completed;
      currentStarted = both.started;
    }

    // Window. The axis ends at the planned end (else completedAt, else now); the
    // ACTUAL series are drawn to completedAt (complete) or now (active).
    const now = new Date();
    const rawAxisEnd = sprint.endDate ?? sprint.completedAt ?? now;
    const actualCutoff = sprint.state === 'complete' ? (sprint.completedAt ?? rawAxisEnd) : now;
    const axisEnd = new Date(
      Math.max(rawAxisEnd.getTime(), actualCutoff.getTime(), start.getTime()),
    );

    // The bounded per-day deltas (finding #57) — events up to the actual cutoff.
    const dailyDeltas = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRevisionRepository.aggregateSprintCycleByDay(
        sprintId,
        ctx.workspaceId,
        { start, end: actualCutoff },
        useCount,
        tx,
      ),
    );

    // Reconstruct each SERIES baseline: `current − Σ delta`. Cumulating a series
    // from its baseline lands EXACTLY on the live `current` value at the cutoff
    // (the header-reconciliation identity), with NO dependence on the frozen
    // snapshot — this is what keeps `scope`/`completed` matching the scrum header.
    const sumDelta = (k: 'scopeDelta' | 'completedDelta' | 'startedDelta') =>
      dailyDeltas.reduce((acc, r) => acc + r[k], 0);
    const scopeAtStart = currentScope - sumDelta('scopeDelta');
    const completedAtStart = currentCompleted - sumDelta('completedDelta');
    const startedAtStart = currentStarted - sumDelta('startedDelta');

    // The TARGET's origin (`committedAtStart`) is the committed scope as of start.
    // It is DISTINCT from the series' `scopeAtStart`: reconstructing it from the
    // trail wrongly yields ~0 when items were assigned to the sprint AFTER its
    // `startDate` (the common start-then-populate flow), which collapses the
    // target onto the x-axis. So prefer the immutable `startSprint` snapshot (the
    // reliable scope-at-start), and when that is absent (started unestimated /
    // empty — the MOTIR-1288 case) OR the reconstruction is non-positive, fall
    // back to the live `currentScope` so the target is always a useful descending
    // line. Floored at 0; an empty sprint (no scope at all) legitimately yields 0.
    const snapshot = useCount
      ? sprint.committedIssueCount
      : sprint.committedPoints === null
        ? null
        : Number(sprint.committedPoints);
    const committedAtStart =
      scopeAtStart > 0 ? scopeAtStart : snapshot !== null && snapshot > 0 ? snapshot : currentScope;

    return toCycleGraphDto({
      sprintId,
      state: sprint.state as 'active' | 'complete',
      statistic,
      start,
      axisEnd,
      actualCutoff,
      scopeAtStart,
      committedAtStart,
      completedAtStart,
      startedAtStart,
      dailyDeltas,
    });
  },

  /**
   * The CREATED-VS-RESOLVED read (Story 6.3 · Subtask 6.3.2) — the two-series
   * difference/area chart behind the report page (6.3.6) and the dashboard
   * widget (6.3.5). Scope = a project or a 6.2 saved filter (the verified
   * gadget pattern; resolved per-VIEWER — see {@link resolveReportScope}).
   * The CREATED series buckets `createdAt`; the RESOLVED series is the NET
   * count of transitions into a `done`-CATEGORY status derived from the
   * 1.4.6 revision trail in ONE bounded grouped query (the 4.6.3 pattern —
   * a reopen inside the window subtracts; the recorded deviation: our
   * "resolution" IS the done category, the SAME predicate the burndown /
   * velocity / rollups use). The bucket axis is generated in full (event-less
   * buckets at 0); `cumulative` running-sums both series within the window
   * server-side.
   *
   * Bounded (finding #57): two grouped aggregates over a validated window
   * (≤ 366 days, ≤ 120 buckets — `InvalidReportWindowError` → 422 beyond).
   * Degraded scopes return the typed widget states, never partial data.
   */
  async getCreatedVsResolved(
    scope: ReportScopeDto,
    config: { period: ReportPeriod; daysBack: number; cumulative: boolean },
    ctx: ServiceContext,
  ): Promise<ReportWidgetResultDto<CreatedVsResolvedDto>> {
    // Config validation FIRST (a malformed window is a 422 regardless of
    // scope state — it leaks nothing and the widget editor needs the error).
    validateReportWindow(config.period, config.daysBack);

    const resolved = await resolveReportScope(scope, ctx);
    if (resolved.state !== 'ok') return resolved;

    const { start, end } = reportWindow(new Date(), config.daysBack);
    const axis = bucketAxis(config.period, start, end);
    const filter = await scopeAstFilter(resolved, ctx);
    // The file's only real fan-out, and the one place the chosen shape costs
    // something measurable: +4 ms (MOTIR-2799's bench). It buys the two series a
    // SHARED SNAPSHOT, which is what stops a concurrent write leaving the chart
    // showing more resolved than were ever created.
    const { created, resolvedRows } = await withWorkspaceServiceContext(
      ctx.workspaceId,
      async (tx) => ({
        created: await workItemRepository.aggregateCreatedByBucket(
          resolved.projectId,
          ctx.workspaceId,
          config.period,
          { start, end },
          filter,
          tx,
        ),
        resolvedRows: await workItemRevisionRepository.aggregateNetResolvedByBucket(
          resolved.projectId,
          ctx.workspaceId,
          config.period,
          { start, end },
          filter,
          tx,
        ),
      }),
    );

    return {
      state: 'ok',
      data: toCreatedVsResolvedDto({
        period: config.period,
        daysBack: config.daysBack,
        cumulative: config.cumulative,
        windowStart: start,
        windowEnd: end,
        axis,
        created,
        resolved: resolvedRows,
      }),
    };
  },

  /**
   * The AVERAGE-AGE read (Story 8.8 · Subtask 8.8.13) — the point-in-time
   * vertical-bar report behind `/reports/average-age` (and the `average_age`
   * dashboard gadget). For each period bucket's END instant (capped at "now"),
   * the average age in days of issues created by then and not yet resolved at
   * that instant, reconstructed from the 1.4.6 revision trail (the SAME
   * done-category predicate every report uses). Same scope / window / typed-state
   * contract as {@link getCreatedVsResolved}: a malformed window is the typed 422
   * (regardless of scope), a degraded scope returns `no_access` / `stale`.
   * Bounded (finding #57): one grouped point-in-time query over a validated
   * window (≤ 120 buckets).
   */
  async getAverageAge(
    scope: ReportScopeDto,
    config: { period: ReportPeriod; daysBack: number },
    ctx: ServiceContext,
  ): Promise<ReportWidgetResultDto<AverageAgeDto>> {
    validateReportWindow(config.period, config.daysBack);

    const resolved = await resolveReportScope(scope, ctx);
    if (resolved.state !== 'ok') return resolved;

    const { start, end } = reportWindow(new Date(), config.daysBack);
    const axis = bucketAxis(config.period, start, end);
    const ends = bucketEnds(config.period, axis, end);
    const filter = await scopeAstFilter(resolved, ctx);
    const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRevisionRepository.aggregateAverageAgeByBucket(
        resolved.projectId,
        ctx.workspaceId,
        axis.map((key, i) => ({ key, end: ends[i]! })),
        filter,
        tx,
      ),
    );

    return {
      state: 'ok',
      data: toAverageAgeDto({
        period: config.period,
        daysBack: config.daysBack,
        windowStart: start,
        windowEnd: end,
        axis,
        rows,
      }),
    };
  },

  /**
   * The RESOLUTION-TIME read (Story 8.8 · Subtask 8.8.13) — the vertical-bar
   * report behind `/reports/resolution-time` (and the `resolution_time` gadget).
   * Per period bucket keyed by RESOLUTION date, the average days-to-resolve over
   * issues that entered a done-category status in that period (the 1.4.6 trail;
   * same done predicate as every report). Same scope / window / typed-state
   * contract as {@link getCreatedVsResolved}.
   */
  async getResolutionTime(
    scope: ReportScopeDto,
    config: { period: ReportPeriod; daysBack: number },
    ctx: ServiceContext,
  ): Promise<ReportWidgetResultDto<ResolutionTimeDto>> {
    validateReportWindow(config.period, config.daysBack);

    const resolved = await resolveReportScope(scope, ctx);
    if (resolved.state !== 'ok') return resolved;

    const { start, end } = reportWindow(new Date(), config.daysBack);
    const axis = bucketAxis(config.period, start, end);
    const filter = await scopeAstFilter(resolved, ctx);
    const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRevisionRepository.aggregateResolutionTimeByBucket(
        resolved.projectId,
        ctx.workspaceId,
        config.period,
        { start, end },
        filter,
        tx,
      ),
    );

    return {
      state: 'ok',
      data: toResolutionTimeDto({
        period: config.period,
        daysBack: config.daysBack,
        windowStart: start,
        windowEnd: end,
        axis,
        rows,
      }),
    };
  },

  /**
   * The WORKLOAD read (Story 8.8 · Subtask 8.8.13; windowed by Story MOTIR-8919)
   * — the horizontal ranked-bar report behind `/reports/workload` (and the
   * `workload` gadget), ranked by the `measure` (story points or issue count).
   *
   * Without `config.window` it is the open-now SNAPSHOT of current `work_item`
   * rows, per assignee — exactly the gadget's contract. With a `window` it is the
   * work that was open at any point in the last `daysBack` days (read from the
   * revision trail), one bar per person: the assignee, else the reporter, as a
   * separate "unassigned" segment, else the neutral Unassigned bar. The window
   * is days back ONLY — a ranked bar chart has no time buckets, so it takes no
   * period and no daily bucket cap (MOTIR-10346). A `daysBack` outside
   * `[1, MAX_REPORT_WINDOW_DAYS]` is the typed 422, raised before scope
   * resolution as in `getAverageAge`. Same scope / typed-state contract as the other reads
   * (`no_access` / `stale` on a degraded scope).
   */
  async getWorkload(
    scope: ReportScopeDto,
    config: {
      measure: WorkloadMeasureDto;
      window?: { daysBack: number };
    },
    ctx: ServiceContext,
  ): Promise<ReportWidgetResultDto<WorkloadDto>> {
    if (config.window) validateWindowDays(config.window.daysBack);

    const resolved = await resolveReportScope(scope, ctx);
    if (resolved.state !== 'ok') return resolved;

    const filter = await scopeAstFilter(resolved, ctx);
    if (config.window) {
      const { daysBack } = config.window;
      const { start, end } = reportWindow(new Date(), daysBack);
      const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        workItemRepository.aggregateWorkloadByPersonInWindow(
          resolved.projectId,
          ctx.workspaceId,
          { start, end },
          filter,
          tx,
        ),
      );
      return {
        state: 'ok',
        data: toWorkloadDto(config.measure, rows, {
          daysBack,
          windowStart: start,
          windowEnd: end,
        }),
      };
    }

    const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRepository.aggregateWorkloadByAssignee(
        resolved.projectId,
        ctx.workspaceId,
        filter,
        tx,
      ),
    );

    return { state: 'ok', data: toWorkloadDto(config.measure, rows) };
  },

  /**
   * The DISTRIBUTION read (Story 6.3 · Subtask 6.3.2) — the donut behind the
   * status-distribution report page (6.3.6) and widget (6.3.5). ONE bounded
   * GROUP-BY count over the scoped items (finding #57), through the TOTAL
   * statistic-type registry (`lib/reports/statisticTypes.ts` — the verified
   * Jira "Statistic Type" vocabulary: the finite-value fields). An id outside
   * the vocabulary, or a custom field whose type is not enum-ish
   * (select/user), is the typed 422 (`UnknownStatisticTypeError` — mistake
   * #29); a DELETED / out-of-project custom field is the typed STALE state
   * (`statistic_missing` — the 6.1.2 unknown-value precedent, data not
   * error). Segments come back count-descending with counts + percentages
   * (the legend's figures); the NULL group is the designed "None" segment.
   */
  async getDistribution(
    scope: ReportScopeDto,
    statistic: string,
    ctx: ServiceContext,
  ): Promise<ReportWidgetResultDto<DistributionDto>> {
    // Statistic-id FORM validation first (typed 422; existence of a cf
    // referent is a data question, resolved after the scope below).
    const parsed = parseStatisticType(statistic);

    const resolved = await resolveReportScope(scope, ctx);
    if (resolved.state !== 'ok') return resolved;

    let groupBy: DistributionGroupBy;
    if (parsed.kind === 'builtin') {
      groupBy = parsed.def.groupBy;
    } else {
      const def = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        customFieldDefinitionRepository.findById(parsed.fieldId, ctx.workspaceId, tx),
      );
      // A deleted — or cross-project, indistinguishable to this scope — field
      // is a stale referent: the widget degrades, the dashboard survives.
      if (!def || def.projectId !== resolved.projectId) {
        return { state: 'stale', reason: 'statistic_missing' };
      }
      if (!isDistributionCfFieldType(def.fieldType)) {
        throw new UnknownStatisticTypeError(
          statistic,
          `a ${def.fieldType} field has no finite value set to group by`,
        );
      }
      groupBy = { kind: 'customField', fieldId: def.id, fieldType: def.fieldType };
    }

    const filter = await scopeAstFilter(resolved, ctx);
    const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      workItemRepository.aggregateDistribution(
        resolved.projectId,
        ctx.workspaceId,
        groupBy,
        filter,
        tx,
      ),
    );
    return { state: 'ok', data: toDistributionDto(statistic, rows) };
  },

  /**
   * The FILTER-RESULTS page read (Story 6.3 · Subtask 6.3.2) — the paginated
   * issue table widget. Rides the EXISTING 2.5.8/2.5.12 list read + count
   * (`workItemsService.getProjectIssuesList` with the resolved filter's
   * compiled AST — no second query path, so a widget page exactly matches
   * the /items List for the same filter), at the default sort and the
   * verified ≤ 50/page gadget cap (clamped server-side by the list read).
   * Scope and access resolve per-VIEWER like every widget read.
   */
  async getFilterResultsPage(
    scope: ReportScopeDto,
    params: { page?: number; pageSize?: number },
    ctx: ServiceContext,
  ): Promise<ReportWidgetResultDto<PagedIssueListDto>> {
    const resolved = await resolveReportScope(scope, ctx);
    if (resolved.state !== 'ok') return resolved;
    try {
      const page = await workItemsService.getProjectIssuesList(
        resolved.projectId,
        {
          sort: DEFAULT_SORT,
          filter: resolved.ast ? { ast: resolved.ast } : undefined,
          page: params.page,
          pageSize: params.pageSize,
        },
        ctx,
      );
      return { state: 'ok', data: page };
    } catch (err) {
      // The list read re-runs the browse gate (defence in depth); a race
      // between the scope resolve and the read (project deleted / access
      // revoked mid-request) degrades to the widget state, never errors.
      /* istanbul ignore next -- defensive: only a mid-request access race reaches this */
      if (err instanceof ProjectNotFoundError || err instanceof ProjectAccessDeniedError) {
        return { state: 'no_access' };
      }
      /* istanbul ignore next -- defensive: non-access errors propagate to the route */
      throw err;
    }
  },
};

// ---------------------------------------------------------------------------
// Story 6.3 · Subtask 6.3.2 — scope resolution (the per-VIEWER 6.4 seam)
// ---------------------------------------------------------------------------

/** A resolved widget scope: the single project the read runs over (saved
 * filters are project-contained — the 6.2 recorded deviation) plus the
 * filter's AST when filter-sourced; or the typed degraded state. */
type ResolvedReportScope =
  | { state: 'ok'; projectId: string; ast: FilterAst | null }
  | { state: 'no_access' }
  | { state: 'stale'; reason: 'filter_missing' | 'filter_invalid' };

/**
 * Resolve a widget data source for the REQUESTING user (never the dashboard
 * owner — the 6.4 per-VIEWER rule):
 *
 *   • `{ projectId }` — the 6.4 browse gate decides. A missing /
 *     cross-workspace project collapses into `no_access` exactly like a
 *     non-browsable one (finding #44 — no existence leak).
 *   • `{ savedFilterId }` — rides THE 6.2.1 resolve-by-id contract
 *     (`savedFiltersService.resolve`: decode + registry-validate on every
 *     resolve, never trust-and-compile; already behind the browse gate +
 *     filter visibility for the CALLER). A deleted / cross-workspace /
 *     invisible filter (finding #44: the latter two are indistinguishable
 *     from deleted) → `stale: filter_missing` (the 6.2.2 "filter missing"
 *     card); a filter over a project the viewer can't browse →
 *     `no_access` (the locked card — the story's private-project rule); a
 *     stored envelope that no longer decodes/validates →
 *     `stale: filter_invalid` (the 6.2.1 astError state). A returned AST is
 *     guaranteed registry-valid; stale OPEN referents inside it match
 *     nothing downstream (the 6.1.2 unknown-value rule).
 */
/**
 * Whether the actor may read this project's ANALYTICS — `report:view`
 * (Story MOTIR-2291 · Subtask MOTIR-2351).
 *
 * ⚠️ IT RETURNS A BOOLEAN RATHER THAN THROWING, and that is the shipped widget
 * contract, not a softened gate. A dashboard widget whose scope has gone away —
 * the project deleted, the actor's access revoked, the saved filter dropped —
 * degrades to a typed `no_access` / `stale` CARD so the rest of the dashboard
 * survives; making the gate throw here would turn one revoked project into a
 * broken page. The assert still runs BEFORE any data read, which is what the gate
 * is for. The reads that are NOT widgets (`getVelocity`, `getSprintCycleGraph`,
 * `sprintsService.getSprintReport`, `estimationService.rollupForSprint`,
 * `workItemsService.getProjectRoadmap`) call `assertPermission` directly and
 * throw, because their callers are pages, not cards.
 *
 * `report:view` is browse-wide by decision (`docs/decisions/member-facing-permissions.md`
 * §1 — Jira has no report permission separate from *Browse Projects*), so this
 * takes nothing from anyone who can already see the project. What it DOES change
 * is that a non-browser can no longer summarise a whole project through an
 * aggregate: `assertPermission` refuses them with `ProjectNotFoundError` before
 * the key is ever tested, which is the same 404 the previous `canBrowse` check
 * produced.
 */
async function mayViewReports(projectId: string, ctx: ServiceContext): Promise<boolean> {
  try {
    await projectAccessService.assertPermission(projectId, ctx, 'report:view');
    return true;
  } catch (err) {
    if (err instanceof ProjectNotFoundError || err instanceof PermissionDeniedError) return false;
    /* istanbul ignore next -- defensive: assertPermission throws nothing else */
    throw err;
  }
}

async function resolveReportScope(
  scope: ReportScopeDto,
  ctx: ServiceContext,
): Promise<ResolvedReportScope> {
  if ('projectId' in scope) {
    if (!(await mayViewReports(scope.projectId, ctx))) return { state: 'no_access' };
    return { state: 'ok', projectId: scope.projectId, ast: null };
  }

  // The filter row locates its project (filters are addressed per-project in
  // 6.2's routes; a widget holds only the id). A missing or cross-workspace
  // row reads as deleted — the stale card, no cross-tenant leak.
  const row = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    savedFilterRepository.findByIdWithStars(scope.savedFilterId, ctx.userId, tx),
  );
  if (!row) return { state: 'stale', reason: 'filter_missing' };
  const project = await readProject(row.projectId, ctx);
  if (!project || project.workspaceId !== ctx.workspaceId) {
    return { state: 'stale', reason: 'filter_missing' };
  }

  let resolvedFilter;
  try {
    resolvedFilter = await savedFiltersService.resolve(
      project.identifier,
      scope.savedFilterId,
      ctx,
    );
  } catch (err) {
    if (err instanceof ProjectNotFoundError) return { state: 'no_access' };
    /* istanbul ignore else -- defensive: the 6.2.1 resolve throws nothing else */
    if (err instanceof SavedFilterNotFoundError)
      return { state: 'stale', reason: 'filter_missing' };
    /* istanbul ignore next -- defensive: see above */
    throw err;
  }
  if (!resolvedFilter.ast) return { state: 'stale', reason: 'filter_invalid' };
  return { state: 'ok', projectId: project.id, ast: resolvedFilter.ast };
}

/** Load the Epic-5 referents a filter-scoped read's AST needs (bounded reads
 * over only the ids the filter references — `loadFilterReferents`), shaped
 * for the repository aggregates. A project scope (no AST) spends no reads. */
async function scopeAstFilter(
  resolved: { projectId: string; ast: FilterAst | null },
  ctx: ServiceContext,
): Promise<{ ast: FilterAst; referents?: ProjectFilterReferents } | undefined> {
  if (!resolved.ast) return undefined;
  const referents = await loadFilterReferents(resolved.projectId, ctx.workspaceId, resolved.ast);
  return { ast: resolved.ast, referents };
}

/**
 * Resolve a sprint's committed baseline in the configured statistic. The
 * scope-lock snapshot (`startSprint`, 4.4.2) stores TWO immutable figures —
 * `committedIssueCount` and `committedPoints` (a story-point sum):
 *   • `issue_count`  → `committedIssueCount`
 *   • `story_points` → `committedPoints`
 *   • `time_estimate`→ `committedPoints` (best available — there is no committed
 *     time snapshot; a `committedMinutes` baseline would need a migration, which
 *     Story 4.6 deliberately does NOT add. Documented as a future refinement.)
 * A not-yet-stamped baseline (defensive — a completed sprint always has one)
 * reads as 0, never `NaN`.
 */
function committedBaseline(sprint: Sprint, statistic: EstimationStatistic): number {
  if (statistic === 'issue_count') return sprint.committedIssueCount ?? 0;
  return sprint.committedPoints === null ? 0 : Number(sprint.committedPoints);
}

/**
 * Clamp the requested window to `[1, MAX_LAST_N]`, defaulting a missing /
 * non-finite / non-positive value to {@link DEFAULT_LAST_N}. Keeps the bounded
 * fan-out bounded regardless of caller input (a bad `?lastN=` never errors — it
 * falls back to the sensible default).
 */
function clampLastN(lastN: number | undefined): number {
  if (lastN === undefined || !Number.isFinite(lastN) || lastN < 1) return DEFAULT_LAST_N;
  return Math.min(Math.floor(lastN), MAX_LAST_N);
}

/**
 * Resolve a project's configured estimation statistic, defaulting to
 * `story_points` when (somehow) no config row exists — the same resolution
 * `estimationService`'s roll-ups use, kept here as a read-only reference lookup
 * (the project's / sprint's own tenancy gate already ran in the caller).
 */
async function resolveStatistic(
  projectId: string,
  tx?: Prisma.TransactionClient,
): Promise<EstimationStatistic> {
  const config = await projectRepository.findEstimationConfig(projectId, tx);
  return config?.estimationStatistic ?? 'story_points';
}
