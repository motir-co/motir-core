import type { EstimationStatistic, PointScale, Prisma } from '@/generated/prisma/client';
import {
  workItemRepository,
  type StoredFilterPredicate,
} from '@/lib/repositories/workItemRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { sprintRepository } from '@/lib/repositories/sprintRepository';
import { workItemRevisionsService } from '@/lib/services/workItemRevisionsService';
import { withWorkspaceContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { toWorkItemDto } from '@/lib/mappers/workItemMappers';
import { toEstimationConfigDto, toSprintPointsDto } from '@/lib/mappers/estimationMappers';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { sprintReportEntryRepository } from '@/lib/repositories/sprintReportEntryRepository';
import { SprintNotFoundError } from '@/lib/sprints/errors';
import { InvalidScaleConfigError } from '@/lib/estimation/errors';
import { validateStoryPoints } from '@/lib/estimation/validate';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { VisitorReadContext } from '@/lib/visitor/context';
import { isVisitorContext, openVisitorRead } from '@/lib/visitor/readScope';
import type { WorkItemDto } from '@/lib/dto/workItems';
import type {
  EstimationConfigDto,
  ParentRollupDto,
  SprintPointsDto,
  UpdateEstimationConfigInput,
} from '@/lib/dto/estimation';
import { readProject, readWorkItem } from '@/lib/workspaces/tenantRead';

// Estimation service (Story 4.3 · Subtask 4.3.3) — the business logic + data
// access for story-point estimation. It owns:
//   * the per-issue story-point WRITE (`setEstimate`) — separate from the 2.3.6
//     TIME-estimate (`estimateMinutes`) editing path;
//   * the project estimation-config read / admin-update (`getEstimationConfig`
//     / `updateEstimationConfig`);
//   * the BOUNDED roll-up reads (`rollupForSprint` / `rollupForParent`, finding
//     #57) the 4.3.5 UI binds to — and that Story **4.5.2** consumes
//     (`rollupForSprint` IS the reusable bounded aggregate behind its scrum
//     `SprintSummaryDto.points`; the SUM lives in ONE place).
//
// 4-layer (CLAUDE.md): one service method = one transaction (writes run under
// `withWorkspaceContext` so the FORCE-RLS WITH CHECK passes under the non-bypass
// `motir_app` role); repositories are single-op leaves; methods return DTOs,
// never raw Prisma rows.
//
// TENANCY (finding #26): every repo read/write carries an explicit
// `workspaceId`; a row outside the active workspace is an indistinguishable 404
// (no existence leak). AUTHORIZATION: changing the estimation config is
// owner-gated today (finding #36; TODO(6.4) widens the role-set), mirroring
// `workflowsService` / `boardsService` — Jira gates board Estimation settings to
// admins (decision-ladder rung 1). Reading the config + the roll-ups is open to
// any workspace member (the badge/picker needs it).

export const estimationService = {
  /**
   * Set or clear (`points = null`) an issue's story-point estimate. Validates
   * the value (a non-negative number within `Decimal(6, 2)` range, ≤ 2 decimal
   * places), writes the single `storyPoints` column, and records a 1.4.6
   * revision in the SAME transaction. The TIME estimate (`estimateMinutes`)
   * stays on its existing 2.3.6 path — this method owns story points only.
   *
   * Throws: `WorkItemNotFoundError` (404 — unknown / cross-workspace issue),
   * `InvalidEstimateError` (422).
   */
  async setEstimate(
    itemId: string,
    points: number | null,
    ctx: ServiceContext,
  ): Promise<WorkItemDto> {
    const value = validateStoryPoints(points);
    // `work_item:edit` (MOTIR-2365). Setting a story-point estimate is a work-item
    // MUTATION and it reached no project gate at all — the inventory called the
    // row `existing` while its own `Gate today` column said "workspace only", so
    // any workspace member could re-estimate any item in any project. The project
    // is resolved from the ITEM, below.
    const target = await readWorkItem(itemId, ctx);
    if (!target || target.workspaceId !== ctx.workspaceId) throw new WorkItemNotFoundError(itemId);
    await projectAccessService.assertPermission(target.projectId, ctx, 'work_item:edit');

    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      async (tx) => {
        // Lock the row, then RE-READ it under the lock — ONE read, inside the tx
        // (mirroring `workItemsService.updateWorkItem`; no redundant pre-flight
        // read). Two purposes: (1) two concurrent estimate writes serialize on
        // the `FOR UPDATE` lock, so the revision `from` is the authoritative
        // committed value, not a stale snapshot a racing writer could already
        // have invalidated; (2) the explicit `workspaceId` check on the re-read
        // is the finding-#26 tenant gate — a missing / cross-workspace item is
        // an indistinguishable 404. The explicit check (not just RLS) keeps the
        // gate primary under the dev/CI BYPASSRLS role too.
        const locked = await workItemRepository.lockById(itemId, tx);
        if (!locked) throw new WorkItemNotFoundError(itemId);
        const current = await workItemRepository.findById(itemId, tx);
        if (!current || current.workspaceId !== ctx.workspaceId) {
          throw new WorkItemNotFoundError(itemId);
        }
        const from = current.storyPoints === null ? null : Number(current.storyPoints);

        const row = await workItemRepository.setStoryPoints(itemId, value, tx);
        await workItemRevisionsService.recordRevision(
          {
            workItemId: itemId,
            changedById: ctx.userId,
            changeKind: 'updated',
            diff: { storyPoints: { from, to: value } },
          },
          tx,
        );
        return toWorkItemDto(row);
      },
    );
  },

  /**
   * Read a project's estimation config (any workspace member). The project is
   * tenant-gated by id + workspaceId — a missing / cross-workspace project is a
   * 404. Returns `{ estimationStatistic, pointScale, customScaleValues }`.
   *
   * Throws: `ProjectNotFoundError` (404).
   */
  async getEstimationConfig(projectId: string, ctx: ServiceContext): Promise<EstimationConfigDto> {
    const project = await readProject(projectId, ctx);
    if (!project || project.workspaceId !== ctx.workspaceId) {
      throw new ProjectNotFoundError(projectId);
    }
    return toEstimationConfigDto(project);
  },

  /**
   * Admin-update a project's estimation config. Owner-gated (the same gate the
   * workflow / board settings use). Validates the EFFECTIVE (patch-merged)
   * config: enum membership of any supplied statistic / scale, and a non-empty
   * all-non-negative-numeric `customScaleValues` when the effective scale is
   * `custom`. Returns the updated config.
   *
   * Throws: `ProjectNotFoundError` (404), `EstimationConfigForbiddenError`
   * (403), `InvalidScaleConfigError` (422).
   */
  async updateEstimationConfig(
    projectId: string,
    patch: UpdateEstimationConfigInput,
    ctx: ServiceContext,
  ): Promise<EstimationConfigDto> {
    const project = await readProject(projectId, ctx);
    if (!project || project.workspaceId !== ctx.workspaceId) {
      throw new ProjectNotFoundError(projectId);
    }
    await assertEstimationAdmin(projectId, ctx);

    const data = validateConfigPatch(patch, project);

    const updated = await withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId },
      (tx) => projectRepository.updateEstimationConfig(projectId, data, tx),
    );
    return toEstimationConfigDto(updated);
  },

  /**
   * The BOUNDED sprint points roll-up (finding #57) — `{ committed, completed,
   * remaining }` over the configured statistic. `completed` counts only issues
   * whose status maps to a `category = 'done'` workflow status; `remaining`
   * floored at 0; a wholly unestimated sprint returns `{ 0, 0, 0 }`. ONE grouped
   * aggregate, NEVER a load-all + client sum.
   *
   * **Exported as the reusable aggregate Story 4.5.2 consumes** for its scrum
   * `SprintSummaryDto.points` (4.5.2 adds only the per-column `columnPoints`
   * breakdown) — the sprint-points SUM stays in this one place.
   *
   * Throws: `SprintNotFoundError` (404 — unknown / cross-workspace sprint).
   */
  async rollupForSprint(sprintId: string, ctx: ServiceContext): Promise<SprintPointsDto> {
    // ONE bound transaction for the two reads that precede the gate
    // (docs/decisions/bound-read-transaction-shape.md). Unbound, `findById`
    // returned null and every velocity bar, sprint report and scrum header threw
    // SprintNotFoundError for a sprint that plainly exists.
    const sprint = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      sprintRepository.findById(sprintId, ctx.workspaceId, tx),
    );
    if (!sprint) throw new SprintNotFoundError(sprintId);
    // `report:view` (MOTIR-2351), NOT `estimation:manage`. This method had no
    // project gate; its sibling `setEstimationConfig` is the one MOTIR-2298 put
    // behind `estimation:manage`, and CHANGING the scheme is a different act from
    // reading a sprint's points. `report:view` is browse-wide, so the scrum
    // header, the burndown and the velocity chart keep working for every actor
    // who can see the project.
    await projectAccessService.assertPermission(sprint.projectId, ctx, 'report:view');

    const { committed, completed } = await withWorkspaceServiceContext(
      ctx.workspaceId,
      async (tx) => {
        const statistic = await resolveStatistic(sprint.projectId, tx);
        return workItemRepository.sumPointsForSprint(sprintId, ctx.workspaceId, statistic, tx);
      },
    );
    return toSprintPointsDto(committed, completed);
  },

  /**
   * The FROZEN completed / not-completed point sums for a COMPLETED sprint's
   * report (bug-sprint-report-incomplete-list-zero-after-carry-over) — the
   * project's configured estimation statistic summed over the at-completion
   * snapshot (`sprint_report_entry`), split by the FROZEN `completed` bucket
   * rather than live membership. Resolves the statistic the same way
   * `rollupForSprint` does (so a points / time / count project all read
   * correctly), then defers the SUM to `sprintReportEntryRepository`. Used by
   * `sprintsService.getSprintReport` only for a `complete` sprint; an active /
   * planned sprint has no snapshot and uses the live `rollupForSprint`. A sprint
   * with no snapshot rows yields `{ 0, 0 }` (the totals stay total). The
   * committed baseline is read separately from `sprint.committedPoints`.
   *
   * Throws: `SprintNotFoundError` (404 — unknown / cross-workspace sprint).
   */
  async rollupForSprintSnapshot(
    sprintId: string,
    ctx: ServiceContext,
  ): Promise<{ completed: number; notCompleted: number }> {
    return withWorkspaceServiceContext(ctx.workspaceId, async (tx) => {
      const sprint = await sprintRepository.findById(sprintId, ctx.workspaceId, tx);
      if (!sprint) throw new SprintNotFoundError(sprintId);

      const statistic = await resolveStatistic(sprint.projectId, tx);
      return sprintReportEntryRepository.sumPointsByCompletion(
        sprintId,
        ctx.workspaceId,
        statistic,
        tx,
      );
    });
  },

  /**
   * The scrum board's sprint point summary (Story 4.5.2) — the
   * `{ committed, completed, remaining }` roll-up (the SAME bounded aggregate
   * `rollupForSprint` returns) PLUS the per-column point breakdown, resolved
   * against the project's configured estimation statistic ONCE. This keeps the
   * sprint-points SUM in this one place (the 4.3.3 contract) while letting the
   * board service stay free of estimation logic: it passes only its column→
   * status layout (`columns`) and gets back board-ready numbers.
   *
   * `columns` is the board's `{ id, statusKeys }[]`; `columnPoints[col.id]` is
   * the configured statistic summed over the sprint's issues whose status is in
   * that column (a column with none → 0). Both figures come from bounded
   * aggregates (`sumPointsForSprint` + `sumPointsBySprintAndStatus`), NEVER a
   * sum over the bounded loaded card page (finding #57). A wholly-unestimated
   * sprint yields all-0 figures (the data layer stays total; the 4.5.3 UI owns
   * the "—" presentation).
   *
   * Throws: `SprintNotFoundError` (404 — unknown / cross-workspace sprint).
   */
  async sprintBoardPoints(
    sprintId: string,
    columns: Array<{ id: string; statusKeys: string[] }>,
    // Only the workspace is read — a Visitor's board passes its project's.
    ctx: Pick<ServiceContext, 'workspaceId'>,
    // A Visitor's private-epic exclusion (MOTIR-6644): the sums count visible items.
    excludeIds?: readonly string[],
    // The board's STORED filter (MOTIR-10560): the header and column points sum
    // only the cards the board shows. Absent ⇒ the whole sprint, as before.
    storedFilter?: StoredFilterPredicate,
  ): Promise<{ points: SprintPointsDto; columnPoints: Record<string, number> }> {
    const { committed, completed, perStatus } = await withWorkspaceServiceContext(
      ctx.workspaceId,
      async (tx) => {
        const sprint = await sprintRepository.findById(sprintId, ctx.workspaceId, tx);
        if (!sprint) throw new SprintNotFoundError(sprintId);
        const statistic = await resolveStatistic(sprint.projectId, tx);
        const sums = await workItemRepository.sumPointsForSprint(
          sprintId,
          ctx.workspaceId,
          statistic,
          tx,
          excludeIds,
          storedFilter,
        );
        return {
          ...sums,
          perStatus: await workItemRepository.sumPointsBySprintAndStatus(
            sprintId,
            ctx.workspaceId,
            statistic,
            tx,
            excludeIds,
            storedFilter,
          ),
        };
      },
    );

    const pointsByStatus = new Map(perStatus.map((r) => [r.status, r.points]));
    const columnPoints: Record<string, number> = {};
    for (const col of columns) {
      columnPoints[col.id] = col.statusKeys.reduce(
        (sum, key) => sum + (pointsByStatus.get(key) ?? 0),
        0,
      );
    }
    return { points: toSprintPointsDto(committed, completed), columnPoints };
  },

  /**
   * The BOUNDED epic/parent subtree roll-up (finding #57) — the configured
   * statistic summed over the parent's DESCENDANTS at any depth, via one
   * recursive-CTE aggregate. Distinct from the parent's OWN estimate. An
   * unestimated subtree returns `{ total: 0 }`. NEVER a load-the-subtree + sum.
   *
   * Throws: `WorkItemNotFoundError` (404 — unknown / cross-workspace parent).
   */
  async rollupForParent(
    parentId: string,
    ctx: ServiceContext | VisitorReadContext,
  ): Promise<ParentRollupDto> {
    if (isVisitorContext(ctx)) {
      // A Visitor's rollup (MOTIR-6652): the parent must be a visible row of their
      // one public project — a hidden or foreign id is the same not-found — and
      // the sum walks visible descendants only.
      const { workspaceId, excludeIds } = openVisitorRead(ctx.project.id, ctx);
      const parent = await withWorkspaceServiceContext(workspaceId, (tx) =>
        workItemRepository.findById(parentId, tx),
      );
      if (!parent || parent.projectId !== ctx.project.id || ctx.hiddenIds.has(parent.id)) {
        throw new WorkItemNotFoundError(parentId);
      }
      return withWorkspaceServiceContext(workspaceId, async (tx) => {
        const statistic = await resolveStatistic(parent.projectId, tx);
        return workItemRepository.sumPointsForParent(
          parentId,
          workspaceId,
          statistic,
          tx,
          excludeIds,
        );
      });
    }
    const item = await readWorkItem(parentId, ctx);
    if (!item || item.workspaceId !== ctx.workspaceId) {
      throw new WorkItemNotFoundError(parentId);
    }
    // `project:browse` (MOTIR-2365) — the row said `existing` and the code had
    // only the workspace check above.
    await projectAccessService.assertPermission(item.projectId, ctx, 'project:browse');
    return withWorkspaceServiceContext(ctx.workspaceId, async (tx) => {
      const statistic = await resolveStatistic(item.projectId, tx);
      return workItemRepository.sumPointsForParent(parentId, ctx.workspaceId, statistic, tx);
    });
  },
};

const ESTIMATION_STATISTICS: readonly EstimationStatistic[] = [
  'story_points',
  'time_estimate',
  'issue_count',
];
const POINT_SCALES: readonly PointScale[] = ['fibonacci', 'linear', 'custom'];

/**
 * Validate the EFFECTIVE (patch-merged-over-current) estimation config and
 * return the Prisma update payload (only the supplied fields). Rejects an
 * unknown statistic / scale enum value, and an empty / non-numeric / negative
 * `customScaleValues` when the effective scale is `custom`.
 */
function validateConfigPatch(
  patch: UpdateEstimationConfigInput,
  current: { pointScale: PointScale; customScaleValues: number[] },
): {
  estimationStatistic?: EstimationStatistic;
  pointScale?: PointScale;
  customScaleValues?: number[];
} {
  const data: {
    estimationStatistic?: EstimationStatistic;
    pointScale?: PointScale;
    customScaleValues?: number[];
  } = {};

  if (patch.estimationStatistic !== undefined) {
    if (!ESTIMATION_STATISTICS.includes(patch.estimationStatistic as EstimationStatistic)) {
      throw new InvalidScaleConfigError(
        `Unknown estimation statistic: "${patch.estimationStatistic}".`,
      );
    }
    data.estimationStatistic = patch.estimationStatistic as EstimationStatistic;
  }
  if (patch.pointScale !== undefined) {
    if (!POINT_SCALES.includes(patch.pointScale as PointScale)) {
      throw new InvalidScaleConfigError(`Unknown point scale: "${patch.pointScale}".`);
    }
    data.pointScale = patch.pointScale as PointScale;
  }
  if (patch.customScaleValues !== undefined) {
    data.customScaleValues = validateScaleValues(patch.customScaleValues);
  }

  // When the effective scale is `custom`, the deck must be present + non-empty.
  const effectiveScale = data.pointScale ?? current.pointScale;
  const effectiveValues = data.customScaleValues ?? current.customScaleValues;
  if (effectiveScale === 'custom' && effectiveValues.length === 0) {
    throw new InvalidScaleConfigError('A custom point scale needs at least one value.');
  }
  return data;
}

/**
 * Validate a `customScaleValues` deck: every entry a finite, non-negative
 * number. (Emptiness is checked against the effective scale by the caller, so a
 * deck can be cleared while the scale is non-custom.)
 */
function validateScaleValues(values: number[]): number[] {
  if (!Array.isArray(values)) {
    throw new InvalidScaleConfigError('`customScaleValues` must be an array of numbers.');
  }
  for (const v of values) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new InvalidScaleConfigError('Every custom scale value must be a non-negative number.');
    }
  }
  return values;
}

/**
 * Resolve a project's configured estimation statistic for a roll-up, defaulting
 * to `story_points` when the project (somehow) has no config row. A read-only
 * reference lookup — the roll-up's own `workspaceId` gate keeps the aggregate
 * tenant-scoped, so no extra tenancy check is needed here.
 */
async function resolveStatistic(
  projectId: string,
  tx?: Prisma.TransactionClient,
): Promise<EstimationStatistic> {
  const config = await projectRepository.findEstimationConfig(projectId, tx);
  return config?.estimationStatistic ?? 'story_points';
}

/**
 * Assert the actor may change this project's ESTIMATION SCHEME (Story MOTIR-2256 ·
 * Subtask MOTIR-2298).
 *
 * ⚠️ A DELIBERATE WIDENING, and the odd one out among the four vocabularies.
 * Custom fields, components and labels were already gated at project-admin level;
 * this one asked `isLegacyOwnerRole(membership?.role)` — the workspace OWNER alone — for
 * no reason anyone recorded, the same accident that reached for the nearest
 * available check in the board and workflow editors. So a project admin could
 * define a custom field but not change what the story-point scale is, which is not
 * a policy anybody would write down on purpose. `estimation:manage` is held by the
 * workspace owner, a workspace admin and a project admin.
 *
 * Required rather than optional: MOTIR-2293 put `estimation:manage` into
 * `BUILTIN_ROLE_PERMISSIONS.admin`, so the old gate would have the catalog
 * advertise a permission the code refuses.
 *
 * The caller's project↔workspace tenancy check still runs first, so a foreign
 * project 404s before this; the shared gate then re-applies the same posture for a
 * non-browser.
 */
async function assertEstimationAdmin(projectId: string, ctx: ServiceContext): Promise<void> {
  await projectAccessService.assertPermission(projectId, ctx, 'estimation:manage');
}
