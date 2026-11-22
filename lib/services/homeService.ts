import { planRevisionHoldService } from '@/lib/services/planRevisionHoldService';
import type { Prisma } from '@/generated/prisma/client';
import { withWorkspaceContext } from '@/lib/workspaces';
import { projectRepository } from '@/lib/repositories/projectRepository';
import {
  workItemRepository,
  HOME_SLICE_DONE,
  HOME_SLICE_IN_PROGRESS,
  HOME_SLICE_TODO,
  HOME_SLICE_UNFINISHED,
  type HomeCategorySlice,
  type HomeGroupingRow,
  type HomeMembershipOptions,
  type HomeProjectScope,
  type HomeWorkItemRow,
  type ReadyContainerShapeRow,
} from '@/lib/repositories/workItemRepository';
import { watcherRepository } from '@/lib/repositories/watcherRepository';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { planRepository } from '@/lib/repositories/planRepository';
import { projectAccessService, type AccessActorContext } from '@/lib/services/projectAccessService';
import { workflowsService } from '@/lib/services/workflowsService';
import { toGateResumeAttemptDto, toHomeWorkItemRowDto } from '@/lib/mappers/homeMappers';
import { toToResumePlanningSessionDto } from '@/lib/mappers/workbenchPlanningMappers';
import { toResumeFormOf } from '@/lib/planChange/toResumeForm';
import { planProgressService } from '@/lib/services/planProgressService';
import type {
  GateResumeAttemptDto,
  HomePageDto,
  HomeTabCountsDto,
  HomeWorkItemRowDto,
} from '@/lib/dto/home';
import { isReviewSentBack } from '@/lib/workItems/reviewSentBack';
import type { OpenRepairRunDto } from '@/lib/dto/workItemRepair';
import { toOpenRepairRuns } from '@/lib/mappers/repairRunMappers';
import { dispatchRunRepository } from '@/lib/repositories/dispatchRunRepository';
import { gateResumeRepository } from '@/lib/repositories/gateResumeRepository';
import { describeResumeRun } from '@/lib/services/resumeRunDetailService';
import {
  readResumeScopes,
  type GatedRunScope,
  type ResumeScopeDetail,
} from '@/lib/services/resumeScopeService';
import { resolveFixEntries, type FixEntry } from '@/lib/services/fixGroupService';
import { fixGroupKeyOf } from '@/lib/workItems/fixReason';
import { groupByContainer, isRunnableContainer } from '@/lib/workItems/readyFilter';

// The Home landing surface's read layer (Story MOTIR-2649 · Subtask
// MOTIR-2651) — the business logic behind `/home`'s two tabs. Orchestrates the
// repositories, owns the ACCESS decision, and maps to DTOs; the repositories
// stay leaves (CLAUDE.md § the 4-layer architecture).
//
// ⚠️ ACTIVE-PROJECT-SCOPED, like every other list surface (MOTIR-2761). This
// read was workspace-scoped until 2026-08-17 and argued for it from external
// precedent — Jira "Your work", Linear Inbox, Plane Home. In all three that
// surface sits ABOVE the project selector; Motir imported the scope without the
// placement and then put `/home` FIRST in the PROJECT tier of the rail, under a
// project switcher the shell renders on every authed page. A switcher that
// changes nothing on the first screen after sign-in teaches the reader that the
// context path is decoration, so the scope moved to match the placement.
//
// The cross-project question — "what is on me across this whole WORKSPACE" — is
// retained rather than dropped: it becomes a workspace-tier surface, MOTIR-2920
// (`docs/decisions/home-scope.md` §3). It is not this read.

/** The page size a Workbench tab reads when the caller names none. */
export const HOME_PAGE_SIZE = 25;

/**
 * How far back "recently finished" reaches, in DAYS (Story MOTIR-4777 ·
 * MOTIR-4781).
 *
 * A NAMED constant rather than an inline `7`, because it is the number the
 * surface has to put in words — the tab draws a window caption, and a caption
 * and a predicate that disagree is a list that reads as broken rather than as
 * bounded. Applied in SQL against `completedAt`, never against `updatedAt`, and
 * never by filtering AFTER the read: a post-read filter shortens pages instead
 * of failing, and "the list sometimes ends early" is a bug nobody traces back
 * to a date comparison.
 */
export const HOME_FINISHED_WINDOW_DAYS = 7;

/** The start of the finished window, as of now. */
export function finishedWindowStart(): Date {
  return new Date(Date.now() - HOME_FINISHED_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}
/** The ceiling a caller-supplied page size is clamped to. */
const HOME_MAX_PAGE_SIZE = 100;

/**
 * Who is reading, and WHICH PROJECT they are reading. The project id is the
 * caller's ACTIVE project — `getActiveProject()` on the page, the same resolver
 * `/items`, `/ready` and `/boards` use — and it is REQUIRED rather than
 * optional, so there is no call shape that quietly reverts to the workspace.
 */
export interface HomeActorContext extends AccessActorContext {
  projectId: string;
}

export interface HomeListOptions {
  /**
   * The 1-based page to serve; omit for page one. Clamped to the last page —
   * see {@link windowFor} for why an out-of-range page is not an empty window.
   */
  page?: number;
  /**
   * The window SIZE, defaulting to {@link HOME_PAGE_SIZE} and clamped to
   * {@link HOME_MAX_PAGE_SIZE}. Named `limit` rather than `pageSize` because it
   * is what every caller of these reads already passes; the DTO reports it back
   * as `pageSize`, which is `/items`' word for the same number.
   */
  limit?: number;
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return HOME_PAGE_SIZE;
  if (!Number.isFinite(limit) || limit < 1) return HOME_PAGE_SIZE;
  return Math.min(Math.floor(limit), HOME_MAX_PAGE_SIZE);
}

/**
 * The ACTIVE project — if the actor may browse it — paired with ITS OWN
 * done-category status keys. The two axes Home's reads scope on, now over a set
 * of at most one.
 *
 * ⚠️ THE ACCESS DECISION IS STILL THE SERVICE'S, and narrowing the project axis
 * did not retire it. RLS is WORKSPACE-rooted; the thing Home can leak is a
 * PRIVATE PROJECT INSIDE the actor's own workspace, which RLS admits and
 * `canBrowse` does not — and an actor's ACTIVE project can be one they may not
 * browse (the pointer is a stored member preference, and project membership can
 * be revoked under it). Such a reader gets an EMPTY scope set, so the read is
 * empty rather than an error — the no-existence-leak convention every other
 * project gate follows.
 *
 * ⚠️ AND THE SHAPE STAYS A `HomeProjectScope[]`, not a bare `projectId`. The
 * lifecycle axis MOTIR-2758 added travels inside it precisely so no call shape
 * can scope the projects without also deciding what counts as finished in each
 * of them; collapsing to an id here would be the narrowing quietly dropping it.
 *
 * The result is passed INTO the query, never applied to its output. Filtering
 * after the read would shorten pages instead of failing, and "the list sometimes
 * ends early" is a bug nobody traces back to an access rule.
 */
export async function resolveActiveProjectScope(
  ctx: HomeActorContext,
  tx: Prisma.TransactionClient,
): Promise<HomeProjectScope[]> {
  const project = await projectRepository.findById(ctx.projectId, tx);
  // The workspace check is belt AND braces: RLS already bounds the read to
  // `ctx.workspaceId`, but a stale active-project pointer is exactly the input
  // that would otherwise cross a tenant on the day RLS is relaxed.
  if (!project || project.workspaceId !== ctx.workspaceId) return [];
  const browsable = await projectAccessService.filterBrowsable([project], ctx, tx);
  if (browsable.length === 0) return [];

  // The LIFECYCLE axis, resolved beside the access one and passed into the query
  // with it (MOTIR-2758, WIDENED by MOTIR-4781). It used to resolve only the
  // TERMINAL slice, because there was one list and finished work was the thing
  // to hide. The Workbench splits that list into three ALONG this axis, so the
  // whole partition is resolved — one query, three groups — and the reads pick
  // the categories each of them is for. Same table, same RLS gate, same `tx`;
  // what changed is how much of the answer is kept.
  //
  // ⚠️ Threaded `tx`, not a second context. `workflow_status` is RLS-gated on
  // `app.workspace_id` (`…_add_workflow_status_and_transition_rls`), and that GUC
  // is bound by the `withWorkspaceContext` transaction the caller is already
  // inside. Read on any other connection under the non-bypass `motir_app` role
  // and the answer is NOTHING — an empty done-key set, an exclusion that
  // silently no-ops in production, and a test suite that stays green because it
  // connects as the owner.
  const byCategory = await workflowsService.getStatusKeysByCategoryByProjects(
    [ctx.projectId],
    ctx.workspaceId,
    tx,
  );
  return [
    {
      projectId: ctx.projectId,
      /* istanbul ignore next -- defensive: the resolver seeds an entry for every requested project id, so the `??` arm is unreachable */
      statusKeysByCategory: byCategory.get(ctx.projectId) ?? {
        todo: [],
        in_progress: [],
        done: [],
      },
    },
  ];
}

/**
 * Where a 1-based page starts, and which page is actually being served.
 *
 * ⚠️ AN OUT-OF-RANGE PAGE CLAMPS TO THE LAST ONE — it does not serve an empty
 * window. That is `/items`' shipped contract
 * (`workItemsService.getProjectIssuesList`, count-first for exactly this
 * reason), and this read is deliberately shaped to match it: one paging
 * vocabulary across the product, and `IssueListPager` fed a `page` it did not
 * ask for would draw a current-page chip outside its own run. `total === 0`
 * gives `page: 1` with an empty `items`, which is the honest answer for a tab
 * with nothing in it.
 *
 * MOTIR-4852's own criterion said "a page past the end returns an empty `items`
 * with the real `total`" — AMENDED on the card, with this evidence: the same
 * criterion also names `getProjectIssuesList` as the contract to match, and the
 * two cannot both hold. What the criterion was protecting — that an
 * out-of-range page is never an ERROR — holds either way, and is asserted.
 */
export function windowFor(total: number, page: number | undefined, pageSize: number) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const clamped = Math.min(Math.max(1, Math.trunc(page ?? 1) || 1), totalPages);
  return { page: clamped, skip: (clamped - 1) * pageSize };
}

/**
 * The To fix ENTRY keys in the tab's order (MOTIR-7589; § 34.2): each card's
 * `fixGroupKeyOf`, first appearance wins, so an entry sits where its first card did in
 * the card order the read returned.
 */
function orderedFixGroupKeys(rows: readonly { id: string; fixDetail: unknown }[]): string[] {
  return [...new Set(rows.map(fixGroupKeyOf))];
}

/**
 * One resolved To fix entry → its row DTO: the HEAD's row, carrying its members.
 *
 * A head that is not stuck itself (a scope card its dead run never claimed) still draws
 * line 2: it borrows the reason its members share, which is the one the entry's repair
 * answers.
 */
function toFixEntryDto(entry: FixEntry, viewerId: string): HomeWorkItemRowDto {
  const head = toHomeWorkItemRowDto(entry.head, viewerId);
  const members = entry.members.map((m) => toHomeWorkItemRowDto(m, viewerId));
  const borrowed = head.fixReason === null ? members.find((m) => m.fixReason !== null) : null;
  return {
    ...head,
    ...(borrowed ? { fixReason: borrowed.fixReason, fixDetail: borrowed.fixDetail } : {}),
    fixGroupKind: entry.kind,
    fixMembers: members,
  };
}

/** Each card's gated run, first appearance first — To resume's entries, in order. */
function orderedResumeRunIds(rows: readonly { resumeRunId: string | null }[]): string[] {
  return [...new Set(rows.flatMap((row) => (row.resumeRunId ? [row.resumeRunId] : [])))];
}

/**
 * To resume's entries, in order — only the runs that are there to resume (MOTIR-8011).
 *
 * ⚠️ TO FIX WINS OVER TO RESUME, AT THE RUN TARGET. A run with a scope is resumable only
 * while that scope card itself waits on it: one on To fix, or whose latest run is a newer
 * one (a repair claim's `fix` run), takes the whole entry with it — its legs still read
 * `resumeState`, but no leg is promoted to head it. A scope-less run (a `batch`) has no
 * single target, so its cards decide alone. The list and `tabCounts` both read this, so
 * the badge, the pager's `total` and the rows are one set.
 */
async function resumableRunOrder(
  workspaceId: string,
  projectIds: readonly string[],
  keyed: readonly { resumeRunId: string | null }[],
  tx: Prisma.TransactionClient,
): Promise<{
  order: string[];
  scopeOf: Map<string, string | null>;
  runOf: Map<string, GatedRunScope>;
}> {
  const all = orderedResumeRunIds(keyed);
  const scopes = await dispatchRunRepository.findScopesByIds(all, tx);
  const scopeOf = new Map(scopes.map((run) => [run.id, run.scopeWorkItemId]));
  const targetIds = [
    ...new Set(scopes.flatMap((r) => (r.scopeWorkItemId ? [r.scopeWorkItemId] : []))),
  ];
  const waiting = await workItemRepository.findWaitingResumeTargets(
    workspaceId,
    projectIds,
    targetIds,
    tx,
  );
  const waitsOn = new Map(waiting.map((card) => [card.id, card.resumeRunId]));
  const order = all.filter((runId) => {
    const scopeId = scopeOf.get(runId) ?? null;
    return scopeId === null || waitsOn.get(scopeId) === runId;
  });
  return { order, scopeOf, runOf: new Map(scopes.map((run) => [run.id, run])) };
}

/**
 * One To resume entry → its row DTO (MOTIR-7707): the run's SCOPE card heads it, and the
 * rest are its members. Only a scope-less run is headed by the first card in the tab's
 * order — a scoped run whose scope is not among the members is no entry (MOTIR-8011).
 */
function toResumeEntryDto(
  members: readonly HomeWorkItemRow[],
  scopeId: string | null,
  viewerId: string,
  scope: ResumeScopeDetail | null = null,
): HomeWorkItemRowDto | null {
  const head = scopeId === null ? members[0] : members.find((m) => m.id === scopeId);
  if (!head) return null;
  if (!scope) {
    return {
      ...toHomeWorkItemRowDto(head, viewerId),
      resumeMembers: members
        .filter((m) => m.id !== head.id)
        .map((m) => toHomeWorkItemRowDto(m, viewerId)),
    };
  }
  // A SCOPE RUN (MOTIR-8458; § 39): the members are what a continue would carry — the
  // scope's live, not-finished children, in the tab's member order — then any card the
  // run left waiting that is no longer one of them. Each says whether the run never
  // touched it, or touched it and a later plan changed it.
  const childIds = new Set(scope.children.map((c) => c.id));
  const composed = [
    ...scope.children,
    ...members.filter((m) => m.id !== head.id && !childIds.has(m.id)),
  ];
  return {
    ...toHomeWorkItemRowDto(head, viewerId),
    resumeMembers: composed.map((m) => ({
      ...toHomeWorkItemRowDto(m, viewerId),
      resumeChange: !scope.touched.has(m.id)
        ? 'added'
        : scope.rescoped.has(m.id)
          ? 'rescoped'
          : null,
    })),
    resumeReshapedBy: scope.reshapedBy,
  };
}

/**
 * One group of a grouped work tab (Story MOTIR-8012 · MOTIR-8015): its HEAD, whether that
 * head is itself on the tab, and the tab's other items under it in group order. A
 * standalone row is a group whose head is the row and whose `memberIds` is empty.
 */
interface HomeGroup {
  headId: string;
  headIsMember: boolean;
  memberIds: string[];
}

/** How a grouped tab orders: `/ready`'s order, or newest-finished first. */
type HomeGroupOrder = 'ready' | 'finished';

/**
 * GROUP a work tab's whole slice by RUNNABLE CONTAINER (`design/workbench/design-notes.md`
 * § 36). An item whose parent is a runnable container (`isRunnableContainer` — never an
 * epic, never a container holding a grandchild) groups under that parent; everything
 * else keys to itself. A runnable container on the tab therefore keys to itself too, and
 * its children on the tab join it: a MEMBER head, drawn once. Groups never nest, because
 * a runnable container's own parent holds a grandchild and so is never runnable.
 *
 * `'ready'` (To do, In progress) is `/ready`'s order, through the ONE shared step
 * `groupByContainer`; `'finished'` puts members newest first and groups by their newest
 * member, the head key breaking a tie.
 */
function groupHomeSlice(
  rows: readonly HomeGroupingRow[],
  shapes: readonly ReadyContainerShapeRow[],
  order: HomeGroupOrder,
): HomeGroup[] {
  const runnable = new Map(shapes.filter(isRunnableContainer).map((shape) => [shape.id, shape]));
  const onTab = new Set(rows.map((row) => row.id));
  const headOf = (row: HomeGroupingRow) => {
    const container = row.parentId ? runnable.get(row.parentId) : undefined;
    return container ? { id: container.id, key: container.key } : { id: row.id, key: row.key };
  };
  const ordered: { headId: string; members: HomeGroupingRow[] }[] =
    order === 'ready'
      ? groupByContainer(rows, headOf, (row) => row)
      : groupNewestFirst(rows, headOf);
  return ordered.map((group) => ({
    headId: group.headId,
    headIsMember: onTab.has(group.headId),
    memberIds: group.members.filter((m) => m.id !== group.headId).map((m) => m.id),
  }));
}

/** Recently finished's order: members `completedAt DESC, id DESC`; groups by newest member. */
function groupNewestFirst(
  rows: readonly HomeGroupingRow[],
  headOf: (row: HomeGroupingRow) => { id: string; key: number },
): { headId: string; members: HomeGroupingRow[] }[] {
  const finishedAt = (row: HomeGroupingRow) => row.completedAt?.getTime() ?? 0;
  const newestFirst = (a: HomeGroupingRow, b: HomeGroupingRow) =>
    finishedAt(b) - finishedAt(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  const byHead = new Map<string, { headId: string; headKey: number; members: HomeGroupingRow[] }>();
  for (const row of rows) {
    const head = headOf(row);
    const group = byHead.get(head.id) ?? { headId: head.id, headKey: head.key, members: [] };
    group.members.push(row);
    byHead.set(head.id, group);
  }
  const groups = [...byHead.values()];
  for (const group of groups) group.members.sort(newestFirst);
  groups.sort(
    (a, b) => finishedAt(b.members[0]!) - finishedAt(a.members[0]!) || a.headKey - b.headKey,
  );
  return groups;
}

/**
 * One page group → its row DTOs. A group with members is its HEAD carrying them
 * (`groupHead` + `groupMembers`); a standalone row is itself. A head that did not come
 * back (archived, or it left between the two reads) leaves its members as standalone
 * rows in the group's slot, so nothing on the tab is dropped; a member that did not
 * come back is skipped, as To fix skips one.
 */
function toGroupDtos(
  group: HomeGroup,
  rowsById: ReadonlyMap<string, HomeWorkItemRow>,
  viewerId: string,
): HomeWorkItemRowDto[] {
  const head = rowsById.get(group.headId);
  const members = group.memberIds.flatMap((id) => {
    const row = rowsById.get(id);
    return row ? [toHomeWorkItemRowDto(row, viewerId)] : [];
  });
  if (!head) return members;
  const headDto = toHomeWorkItemRowDto(head, viewerId);
  if (members.length === 0) return group.headIsMember ? [headDto] : [];
  return [
    { ...headDto, groupHead: group.headIsMember ? 'member' : 'context', groupMembers: members },
  ];
}

/** Shape one repository window into the wire DTO. */
function toPage(
  rows: HomeWorkItemRow[],
  viewerId: string,
  window: { total: number; page: number; pageSize: number },
): HomePageDto {
  return {
    items: rows.map((row) => toHomeWorkItemRowDto(row, viewerId)),
    total: window.total,
    page: window.page,
    pageSize: window.pageSize,
  };
}

/**
 * The To resume entries for one page of the reader's planning sessions (MOTIR-7914; forms
 * MOTIR-7939): the target titles in ONE read for the page, every session's undecided plans in
 * ONE `listUndecidedBySessions` call (which is also what names its form and its waiting
 * plan), and the progress in ONE `snapshotsForPlans` call over the `failed_walk` entries'
 * plans. A session whose plan has no snapshot keeps its entry with `progress: null` — the
 * plan is still the person's work.
 */
async function toResumeSessionEntries(
  failedRows: Awaited<ReturnType<typeof planChangeSessionRepository.listFailedOpenForOwner>>,
  endedRows: Awaited<
    ReturnType<typeof planChangeSessionRepository.listEndedWithWaitingPlanForOwner>
  >,
  ctx: HomeActorContext,
  tx: Prisma.TransactionClient,
) {
  const rows = [...failedRows, ...endedRows];
  if (rows.length === 0) return { entries: [], progressPlans: [] };
  const keys = Array.from(new Set(rows.flatMap((row) => row.targetKeys)));
  const titleRows = await workItemRepository.findByIdentifiers(ctx.projectId, keys, tx);
  const titles = new Map(titleRows.map((item) => [item.identifier, item.title]));
  const projects = new Map(
    (await projectRepository.findManyByIds([...new Set(rows.map((r) => r.projectId))], tx)).map(
      (project) => [project.id, project.name],
    ),
  );
  const undecided = await planRepository.listUndecidedBySessions(
    rows.map((row) => row.id),
    tx,
  );
  const bySession = new Map<string, typeof undecided>();
  for (const plan of undecided) {
    if (!plan.sessionId) continue;
    bySession.set(plan.sessionId, [...(bySession.get(plan.sessionId) ?? []), plan]);
  }
  const plansById = new Map(undecided.map((plan) => [plan.id, plan]));
  const progressPlans: typeof undecided = [];
  // PROGRESS IS FILLED IN AFTER THE TRANSACTION (see `listToResume`): `snapshotsForPlans` opens
  // its own context, and a second pooled connection taken while this one is held is the
  // deadlock shape `workItemsService` warns about.
  const entries = rows.map((row) => {
    const ended = 'endedAt' in row;
    const resolved = toResumeFormOf(
      { endedAt: ended ? row.endedAt : null, endReason: ended ? 'failed' : null },
      (bySession.get(row.id) ?? []).map((p) => ({
        id: p.id,
        status: p.status as 'generating' | 'stopped' | 'planned' | 'stale',
        createdAt: p.createdAt,
      })),
    );
    if (resolved?.form === 'failed_walk') {
      const walking = plansById.get(resolved.entryPlanId);
      if (walking) progressPlans.push(walking);
    }
    return toToResumePlanningSessionDto(
      row,
      resolved,
      plansById,
      projects.get(row.projectId) ?? '',
      titles,
      null,
    );
  });
  return { entries, progressPlans };
}

export const homeService = {
  /**
   * THE MEMBERSHIP PREDICATE, in one place — every item in the ACTIVE PROJECT
   * where the actor is the assignee **OR** the reporter, each item exactly
   * once, cursor-paged, narrowed to the lifecycle categories the caller asks
   * for.
   *
   * The two predicates are merged into one list rather than split into two tabs
   * because Motir is AI-native: an item created through the MCP carries the
   * creating user as REPORTER, and that same user runs it rather than assigning
   * it onward, so reporter and assignee are usually one person wearing two hats.
   * The dedupe requirement exists ONLY because of that merge — and it is the
   * database's job (a single `OR`), not the service's, so it holds across a page
   * boundary and not merely within one page.
   *
   * ⚠️ THE THREE WORK TABS ARE THIS ONE READ, PARTITIONED (MOTIR-4781). They
   * share the membership `OR`, the access decision, the project scope, the
   * dedupe and the keyset; what differs is which `workflow_status.category`
   * each is for, and — for Recently finished — the window and the axis. Writing
   * them as three reads would be three chances for the dedupe or the scope to
   * drift, on a surface whose whole promise is that the tabs PARTITION the same
   * set.
   */
  async listSlice(
    ctx: HomeActorContext,
    slice: HomeCategorySlice,
    options: HomeListOptions = {},
  ): Promise<HomePageDto> {
    const pageSize = clampLimit(options.limit);
    // COUNT FIRST, then read the window — the same order `/items` uses, and for
    // the same two reasons: the total is the pager's denominator, and knowing it
    // is what lets an out-of-range page clamp to the last one instead of
    // fetching an empty offset. The count and the list are ONE predicate: the
    // repository's `count` twin takes the same `slice` and the same scopes.
    const { rows, total, page } = await withWorkspaceContext(ctx, async (tx) => {
      const projectScopes = await resolveActiveProjectScope(ctx, tx);
      const found = await workItemRepository.countByAssigneeOrReporterInWorkspace(
        ctx.userId,
        ctx.workspaceId,
        projectScopes,
        { slice },
        tx,
      );
      const window = windowFor(found, options.page, pageSize);
      return {
        total: found,
        page: window.page,
        rows: await workItemRepository.findByAssigneeOrReporterInWorkspace(
          ctx.userId,
          ctx.workspaceId,
          { projectScopes, slice, take: pageSize, skip: window.skip },
          tx,
        ),
      };
    });
    return toPage(rows, ctx.userId, { total, page, pageSize });
  },

  /** TO DO — nothing has been started. */
  async listToDo(ctx: HomeActorContext, options: HomeListOptions = {}): Promise<HomePageDto> {
    return homeService.listGroupedSlice(ctx, { slice: HOME_SLICE_TODO }, 'ready', options);
  },

  /**
   * IN PROGRESS — what is moving.
   *
   * On this product that tab is where a human meets what their agents did: a
   * card at `implemented` or `in_review` is an agent's finished output waiting
   * for a person, not idle work, and it is invisible in a list sorted by time.
   * It holds every `in_progress`-CATEGORY status, which is why renaming a
   * column cannot empty it.
   */
  async listInProgress(ctx: HomeActorContext, options: HomeListOptions = {}): Promise<HomePageDto> {
    return homeService.listGroupedSlice(ctx, { slice: HOME_SLICE_IN_PROGRESS }, 'ready', options);
  },

  /**
   * A WORK TAB, GROUPED BY RUNNABLE CONTAINER (Story MOTIR-8012 · MOTIR-8015;
   * `design/workbench/design-notes.md` § 36) — To do, In progress and Recently finished.
   *
   * ⚠️ IT PAGES GROUPS, NOT ITEMS, and that forces the two-step shape To fix uses: a
   * group ranks by its BEST member, which can sit anywhere in the tab, so the WHOLE
   * slice is read as six narrow fields, grouped in memory, and only the page's rows are
   * read in full. `total` counts groups (a standalone row is a group of one) and a group
   * is never split across pages. Which items are on the tab is unchanged: the projection
   * is `homeMembershipWhere`'s, the predicate the strip counts (`tabCounts()`, still
   * item counts) read.
   */
  async listGroupedSlice(
    ctx: HomeActorContext,
    membership: HomeMembershipOptions,
    order: HomeGroupOrder,
    options: HomeListOptions = {},
  ): Promise<HomePageDto> {
    const pageSize = clampLimit(options.limit);
    const { groups, rows, total, page } = await withWorkspaceContext(ctx, async (tx) => {
      const projectScopes = await resolveActiveProjectScope(ctx, tx);
      const slice = await workItemRepository.listHomeGroupingRowsByAssigneeOrReporterInWorkspace(
        ctx.userId,
        ctx.workspaceId,
        projectScopes,
        membership,
        tx,
      );
      const parentIds = [...new Set(slice.flatMap((row) => (row.parentId ? [row.parentId] : [])))];
      const shapes = await workItemRepository.findContainerShapes(parentIds, ctx.workspaceId, tx);
      const all = groupHomeSlice(slice, shapes, order);
      const window = windowFor(all.length, options.page, pageSize);
      const onPage = all.slice(window.skip, window.skip + pageSize);
      return {
        groups: onPage,
        total: all.length,
        page: window.page,
        rows: await workItemRepository.findHomeRowsByIds(
          ctx.workspaceId,
          onPage.flatMap((group) => [group.headId, ...group.memberIds]),
          tx,
        ),
      };
    });
    const rowsById = new Map<string, HomeWorkItemRow>(rows.map((row) => [row.id, row]));
    return {
      items: groups.flatMap((group) => toGroupDtos(group, rowsById, ctx.userId)),
      total,
      page,
      pageSize,
    };
  },

  /**
   * TO FIX — the reader's in-progress cards that are stuck until something is
   * repaired (Story MOTIR-6588 · MOTIR-6604): a merge-queue failure, a conflict, red
   * CI, or a reviewer's standing Request changes, as `WorkItem.fixReason` records it.
   *
   * ⚠️ THE SAME PREDICATE, ONE MORE SLICE — never a second membership query. It is In
   * progress's category with `fixReason` set, and In progress is that category with it
   * unset, so the partition promise (no card on two tabs, none dropped) holds by the
   * predicate rather than by two queries agreeing.
   *
   * ⚠️ BUT IT PAGES ENTRIES, NOT CARDS (MOTIR-7589). Each row is an entry's HEAD carrying
   * the other cards stuck with it (`fixMembers`), which may include cards the reader does
   * not hold; `total` counts entries, the same number `tabCounts().toFix` returns.
   */
  async listToFix(ctx: HomeActorContext, options: HomeListOptions = {}): Promise<HomePageDto> {
    // ONE ENTRY PER STUCK RUN (MOTIR-7589; `design/workbench/design-notes.md` § 34.2):
    // the cards on the tab are still exactly the slice's, but the list pages, and the
    // pager counts, ENTRIES — the cards one repair clears, under the card it runs on.
    const pageSize = clampLimit(options.limit);
    const page = await withWorkspaceContext(ctx, async (tx): Promise<HomePageDto> => {
      const projectScopes = await resolveActiveProjectScope(ctx, tx);
      const keyed = await workItemRepository.listToFixGroupKeysByAssigneeOrReporterInWorkspace(
        ctx.userId,
        ctx.workspaceId,
        projectScopes,
        tx,
      );
      const order = orderedFixGroupKeys(keyed);
      const window = windowFor(order.length, options.page, pageSize);
      const pageKeys = order.slice(window.skip, window.skip + pageSize);
      const entries = await resolveFixEntries(
        ctx.workspaceId,
        projectScopes.map((scope) => scope.projectId),
        pageKeys,
        ctx.userId,
        tx,
      );
      return {
        items: pageKeys.flatMap((key) => {
          const entry = entries.get(key);
          return entry ? [toFixEntryDto(entry, ctx.userId)] : [];
        }),
        total: order.length,
        page: window.page,
        pageSize,
      };
    });
    // CONTINUE HOSTED ON A DEAD-RUN ROW (MOTIR-6882) and FIX ON THE HOSTED AGENT ON A
    // SENT-BACK ROW (MOTIR-6930) — each offered only where the reader may edit the card,
    // the item page's own Run hosted rule. Decided ONCE PER DISTINCT PROJECT among the
    // rows that could offer one, never once per row, and not at all on a page of
    // pull-request reasons.
    const continuable = page.items.filter(
      (row) => row.fixReason === 'run_died' && row.fixDetail?.repair === 'continue',
    );
    const sentBack = page.items.filter((row) => isReviewSentBack(row.fixReason, row.fixDetail));
    if (continuable.length === 0 && sentBack.length === 0) return page;
    const editable = new Set<string>();
    for (const projectId of new Set([...continuable, ...sentBack].map((row) => row.project.id))) {
      const held = await projectAccessService.getPermissions(projectId, {
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
      });
      if (held.has('work_item:edit')) editable.add(projectId);
    }
    // THE OPEN REPAIR on each sent-back row — ONE read for the page. While it runs it IS
    // the one-repair lock (`hosted-agent-run.md` §8.6), so the row offers neither repair.
    const openRepairs =
      sentBack.length === 0
        ? new Map<string, OpenRepairRunDto>()
        : toOpenRepairRuns(
            await withWorkspaceContext(ctx, (tx) =>
              dispatchRunRepository.findRunningByCommandForWorkItems(
                sentBack.map((row) => row.id),
                'fix',
                tx,
              ),
            ),
            ctx.userId,
          );
    return {
      ...page,
      items: page.items.map((row) => {
        const editableRow = editable.has(row.project.id);
        if (continuable.includes(row) && editableRow) return { ...row, canContinueHosted: true };
        if (sentBack.includes(row)) {
          return {
            ...row,
            canFixHosted: editableRow,
            repairRun: openRepairs.get(row.id) ?? null,
          };
        }
        return row;
      }),
    };
  },

  /**
   * TO RESUME — the reader's in-progress cards whose latest run stopped at an approval
   * gate (Story MOTIR-7701 · MOTIR-7707), as `WorkItem.resumeState` records it.
   *
   * ⚠️ THE SAME PREDICATE, ONE MORE SLICE, as To fix: In progress's category with
   * `resumeState` set and `fixReason` unset, so no card is on two tabs.
   *
   * ⚠️ AND IT PAGES ENTRIES, ONE PER GATED RUN, as To fix pages one per dead run
   * (MOTIR-7589). Each row is the entry's head carrying the other cards the run left
   * waiting (`resumeMembers`); `total` counts runs, the number `tabCounts().toResume`
   * returns.
   */
  async listToResume(ctx: HomeActorContext, options: HomeListOptions = {}): Promise<HomePageDto> {
    const pageSize = clampLimit(options.limit);
    const read = await withWorkspaceContext(ctx, async (tx) => {
      const projectScopes = await resolveActiveProjectScope(ctx, tx);
      const keyed = await workItemRepository.listToResumeRunKeysByAssigneeOrReporterInWorkspace(
        ctx.userId,
        ctx.workspaceId,
        projectScopes,
        tx,
      );
      const projectIds = projectScopes.map((scope) => scope.projectId);
      const { order, scopeOf, runOf } = await resumableRunOrder(
        ctx.workspaceId,
        projectIds,
        keyed,
        tx,
      );
      // THE READER'S PLANNING SESSIONS (Story MOTIR-7905 · MOTIR-7914 · MOTIR-7939) are the FIRST
      // segments of the one order, and the gated runs follow in their own order. THREE bands:
      //   1. the OPEN failed sessions (a failed walk, a failure beside a waiting plan), newest
      //      failure first — a failed plan is the newest thing a person was actively doing;
      //   2. the sessions that ENDED `failed` before MOTIR-7905 and still hold a waiting plan,
      //      newest end first;
      //   3. the gated runs.
      // `total` counts all three, so the shipped pager reads one number (the split
      // `listWatching` uses across its two bands, extended by one). Each band is counted and
      // listed through ONE predicate, so the badge equals `total` by construction.
      const sessionScope = { userId: ctx.userId, workspaceId: ctx.workspaceId, projectIds };
      const failedCount = await planChangeSessionRepository.countFailedOpenForOwner(
        sessionScope,
        tx,
      );
      const endedCount = await planChangeSessionRepository.countEndedWithWaitingPlanForOwner(
        sessionScope,
        tx,
      );
      const sessionCount = failedCount + endedCount;
      const window = windowFor(sessionCount + order.length, options.page, pageSize);
      const failedSkip = Math.min(window.skip, failedCount);
      const failedTake = Math.min(pageSize, failedCount - failedSkip);
      const endedSkip = Math.min(Math.max(0, window.skip - failedCount), endedCount);
      const endedTake = Math.min(pageSize - failedTake, endedCount - endedSkip);
      const runSkip = Math.max(0, window.skip - sessionCount);
      const pageRuns = order.slice(runSkip, runSkip + (pageSize - failedTake - endedTake));
      const failedRows =
        failedTake > 0
          ? await planChangeSessionRepository.listFailedOpenForOwner(
              { ...sessionScope, skip: failedSkip, take: failedTake },
              tx,
            )
          : [];
      const endedRows =
        endedTake > 0
          ? await planChangeSessionRepository.listEndedWithWaitingPlanForOwner(
              { ...sessionScope, skip: endedSkip, take: endedTake },
              tx,
            )
          : [];
      const { entries: planningSessions, progressPlans } = await toResumeSessionEntries(
        failedRows,
        endedRows,
        ctx,
        tx,
      );
      const [members, attempts] = await Promise.all([
        workItemRepository.findResumeMembers(ctx.workspaceId, projectIds, pageRuns, tx),
        gateResumeRepository.listByRunIds(pageRuns, tx),
      ]);
      // What each gated SCOPE run would carry now, and what re-shaped it (MOTIR-8458).
      const scopeDetail = await readResumeScopes(
        ctx.workspaceId,
        projectScopes,
        pageRuns.flatMap((runId) => {
          const run = runOf.get(runId);
          return run ? [run] : [];
        }),
        tx,
      );
      // Newest first, so the first attempt seen per run is the one the entry reads.
      const attemptOf = new Map<string, GateResumeAttemptDto>();
      for (const a of attempts) {
        if (!attemptOf.has(a.runId)) attemptOf.set(a.runId, toGateResumeAttemptDto(a));
      }
      const entries = pageRuns.flatMap((runId) => {
        const entry = toResumeEntryDto(
          members.filter((m) => m.resumeRunId === runId),
          scopeOf.get(runId) ?? null,
          ctx.userId,
          scopeDetail.get(runId) ?? null,
        );
        return entry ? [{ runId, entry }] : [];
      });
      // Each entry's run, as line 2's aside and the gate list draw it (MOTIR-7712).
      // Sequential: one transaction's client runs one query at a time anyway.
      const items: HomeWorkItemRowDto[] = [];
      for (const { runId, entry } of entries) {
        items.push({
          ...entry,
          resumeAttempt: attemptOf.get(runId) ?? null,
          resumeRun: await describeResumeRun(runId, entry.id, tx),
        });
      }
      const base: HomePageDto = {
        items,
        ...(sessionCount > 0 ? { planningSessions } : {}),
        total: sessionCount + order.length,
        page: window.page,
        pageSize,
      };
      return { base, progressPlans };
    });
    // THE SESSIONS' PROGRESS — ONE `snapshotsForPlans` call over the page's plans, OUTSIDE the
    // transaction (it opens its own context). A missing snapshot leaves `progress: null`; the
    // entry is never dropped.
    let page = read.base;
    if (page.planningSessions && read.progressPlans.length > 0) {
      const snapshots = await planProgressService.snapshotsForPlans(read.progressPlans, ctx);
      page = {
        ...page,
        planningSessions: page.planningSessions.map((entry) => ({
          ...entry,
          progress:
            entry.form === 'failed_walk' && entry.planId
              ? (snapshots.get(entry.planId) ?? null)
              : null,
        })),
      };
    }
    // THE CONTINUE DOOR (§ 35.5) — on an entry the approval released that did not resume
    // by itself (*Ready to resume*, *Could not resume*), offered only where the reader may
    // edit the card: To fix's rule, decided once per distinct project.
    const continuable = page.items.filter(
      (row) => row.resumeState === 'ready_to_resume' && row.resumeAttempt?.outcome !== 'started',
    );
    if (continuable.length === 0) return page;
    const editable = new Set<string>();
    for (const projectId of new Set(continuable.map((row) => row.project.id))) {
      const held = await projectAccessService.getPermissions(projectId, {
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
      });
      if (held.has('work_item:edit')) editable.add(projectId);
    }
    return {
      ...page,
      items: page.items.map((row) =>
        continuable.includes(row) && editable.has(row.project.id)
          ? { ...row, canContinueHosted: true }
          : row,
      ),
    };
  },

  /**
   * RECENTLY FINISHED — the week's work, which this surface has never shown.
   *
   * ⚠️ TWO THINGS DIFFER FROM ITS SIBLINGS AND THEY ARE ONE DECISION: it orders
   * by `completedAt` and it pages on `completedAt`. A read ordered by one
   * column and paged on another repeats and drops rows silently as items are
   * updated underneath the reader.
   *
   * ⚠️ AND THE WINDOW IS `completedAt`, NEVER `updatedAt`. `/home` excluded
   * done work outright (MOTIR-2758), so nothing here is a narrowing of an
   * existing list — this is a dataset the product could not express until
   * MOTIR-4780 stored the moment a card finished. Building the window on
   * `updatedAt` would list work finished in June that somebody re-titled today,
   * and would do it without ever erroring.
   */
  async listRecentlyFinished(
    ctx: HomeActorContext,
    options: HomeListOptions = {},
  ): Promise<HomePageDto> {
    // The window is part of the predicate here, so the grouping projection reads it
    // with the SAME `sortField` + `since` the strip count uses (`tabCounts()`).
    return homeService.listGroupedSlice(
      ctx,
      { slice: HOME_SLICE_DONE, sortField: 'completedAt', since: finishedWindowStart() },
      'finished',
      options,
    );
  },

  /**
   * MY WORK — everything of the reader's that is not finished.
   *
   * ⚠️ TRANSITIONAL, and owned by MOTIR-4782. The shipped `/home` page renders
   * two tabs and this card changes no surface, so the old read survives — as a
   * NAME over the same partition, `['todo', 'in_progress']`, which is exactly
   * the set MOTIR-2758's done-EXCLUSION described. Expressing it as the union
   * of the two work categories rather than as a second implementation is what
   * makes it impossible for it to disagree with the tabs that replace it.
   *
   * @deprecated Remove with `/home` when MOTIR-4782 lands `/workbench`.
   */
  async listMyWork(ctx: HomeActorContext, options: HomeListOptions = {}): Promise<HomePageDto> {
    return homeService.listSlice(ctx, HOME_SLICE_UNFINISHED, options);
  },

  /**
   * EVERY tab's count, in one workspace context.
   *
   * The tab strip shows the size of the tabs you are NOT looking at as well as
   * the one you are, so a reader can tell whether switching is worth it — which
   * means the numbers are the size of each SET, not of the current page.
   * Resolved together because the project scope — the access check plus that
   * project's status partition — is the expensive half and every count needs
   * the same one.
   *
   * ⚠️ ONE ROUND TRIP, not one per tab. The counts are issued together inside a
   * single `withWorkspaceContext` transaction; a per-tab call would re-run the
   * access check and the status resolution four times for one render.
   */
  async tabCounts(ctx: HomeActorContext): Promise<HomeTabCountsDto> {
    return withWorkspaceContext(ctx, async (tx) => {
      const projectScopes = await resolveActiveProjectScope(ctx, tx);
      const projectIds = projectScopes.map((scope) => scope.projectId);
      // The plans a revision holds right now (MOTIR-7988) — out of the approvals
      // count, exactly as the list reads them. The planning count needs no such
      // help: a revision re-opens its plan to `generating` (MOTIR-8208).
      const heldPlanIds = await planRevisionHoldService.heldPlanIds(
        { workspaceId: ctx.workspaceId, projectIds },
        tx,
      );
      const [
        toDo,
        toFixCards,
        toResumeCards,
        inProgress,
        recentlyFinished,
        watching,
        approvals,
        planning,
      ] = await Promise.all([
        workItemRepository.countByAssigneeOrReporterInWorkspace(
          ctx.userId,
          ctx.workspaceId,
          projectScopes,
          { slice: HOME_SLICE_TODO },
          tx,
        ),
        // TO FIX COUNTS ENTRIES (MOTIR-7589; § 34.2) — the same keys the list pages, so
        // the badge and the pager's total are one number.
        workItemRepository.listToFixGroupKeysByAssigneeOrReporterInWorkspace(
          ctx.userId,
          ctx.workspaceId,
          projectScopes,
          tx,
        ),
        // TO RESUME COUNTS ENTRIES too (MOTIR-7707) — one per gated run, as its list pages.
        workItemRepository.listToResumeRunKeysByAssigneeOrReporterInWorkspace(
          ctx.userId,
          ctx.workspaceId,
          projectScopes,
          tx,
        ),
        workItemRepository.countByAssigneeOrReporterInWorkspace(
          ctx.userId,
          ctx.workspaceId,
          projectScopes,
          { slice: HOME_SLICE_IN_PROGRESS },
          tx,
        ),
        workItemRepository.countByAssigneeOrReporterInWorkspace(
          ctx.userId,
          ctx.workspaceId,
          projectScopes,
          { slice: HOME_SLICE_DONE, sortField: 'completedAt', since: finishedWindowStart() },
          tx,
        ),
        watcherRepository.countByUser(ctx.userId, ctx.workspaceId, projectScopes, tx),
        // THE APPROVALS COUNT (MOTIR-4794), no longer hardwired to `0`.
        //
        // ⚠️ IT IS THE LIST'S OWN PREDICATE, reached through the same repository
        // builder `listAwaitingMe` uses — not a second count written beside it.
        // The strip's badge and the tab's rows are two reads of ONE question, so
        // a copy of the predicate here is a copy that can drift, and a badge
        // saying `3` above a list of two is exactly what that looks like from
        // the reader's side.
        //
        // ⚠️ AND IT IS DELIBERATELY **NOT** `homeService`'s membership `OR`.
        // The four tabs beside it answer *what is MINE* with assignee-OR-reporter;
        // a decision queue routes to exactly one recipient (`assigneeId ??
        // reporterId`, ADR §2), so this number is counted on the gate's own
        // predicate. Two tabs in one strip meaning two different things by "me"
        // is the divergence that ADR records itself refusing to "fix" back.
        (async () => {
          return approvalGateRepository.countAwaitingRoutedTo(
            {
              projectIds,
              userId: ctx.userId,
              // A planning-session row counts only while its session still waits
              // (MOTIR-7913) — the same live set `listAwaitingMe` reads.
              awaitingSessionIds: await planChangeSessionRepository.listAwaitingPersonIdsInProjects(
                projectIds,
                tx,
              ),
              heldPlanIds,
            },
            tx,
          );
        })(),
        // THE PLANNING COUNT (MOTIR-7828) — the plans this reader asked for that are
        // still being written. The SAME builder `workbenchPlanningService
        // .listMyPlansBeingWritten` pages (`generatingRequestedByWhere`), on the same
        // `tx` and the same scope, so the badge equals that list's `total`.
        // ⚠️ NOT A LANDING RUNG: `LandingCounts` is a `Pick` that leaves it out.
        planRepository.countGeneratingRequestedBy(
          {
            workspaceId: ctx.workspaceId,
            projectIds,
            userId: ctx.userId,
          },
          tx,
        ),
      ]);
      const toFix = orderedFixGroupKeys(toFixCards).length;
      // …PLUS the REVIEWS TO RUN the tab lists (Bug MOTIR-11984): a review waiting for the
      // reader to start it is waiting on them. Counted on the list's own builder, after the
      // batch above so no read outlives this transaction (MOTIR-8284).
      const reviewsToRun = await approvalGateRepository.countAwaitingReviewsToRunRoutedTo(
        { projectIds, userId: ctx.userId },
        tx,
      );
      // …PLUS the reader's failed planning sessions (MOTIR-7914), counted by the same
      // predicate `listToResume` pages, so the badge equals the list's `total`.
      const toResume =
        (
          await resumableRunOrder(
            ctx.workspaceId,
            projectScopes.map((scope) => scope.projectId),
            toResumeCards,
            tx,
          )
        ).order.length +
        (await planChangeSessionRepository.countFailedOpenForOwner(
          {
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            projectIds: projectScopes.map((scope) => scope.projectId),
          },
          tx,
        )) +
        // …and the sessions that ended `failed` before MOTIR-7905 and still hold a waiting plan
        // (MOTIR-7939), the third form `listToResume` pages.
        (await planChangeSessionRepository.countEndedWithWaitingPlanForOwner(
          {
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            projectIds: projectScopes.map((scope) => scope.projectId),
          },
          tx,
        ));
      return {
        toDo,
        inProgress,
        toFix,
        toResume,
        recentlyFinished,
        approvals: approvals + reviewsToRun,
        watching,
        planning,
        // Transitional — `/home`'s two-tab strip, until MOTIR-4782 replaces it.
        // Derived from the two above rather than counted again, so the old
        // badge and the new ones cannot disagree.
        // To fix is carved out of In progress (MOTIR-6604), so it is added back
        // here: the old badge still means everything not finished.
        // It counts CARDS, so it adds back the stuck cards, not To fix's entries.
        // To resume is carved out the same way (MOTIR-7707).
        myWork: toDo + inProgress + toFixCards.length + toResumeCards.length,
      };
    });
  },

  /**
   * WATCHING — the items the actor watches IN THE ACTIVE PROJECT, with what is
   * MOVING ordered ahead of what is WAITING.
   *
   * A genuinely different audience from the work tabs, not a partition of them:
   * an item the actor both owns and watches is returned by BOTH reads. That is
   * not a bug to fix at this layer — the two reads answer different questions,
   * and MOTIR-2655 asserts the overlap explicitly so nobody "corrects" it later.
   *
   * ⚠️ MOTIR-4781 GAVE IT AN ORDER, NOT A FILTER. Membership is untouched and
   * nothing is dropped.
   *
   * ⚠️ AND THE GROUP IS A PREDICATE, NOT A SORT KEY — which is why this method
   * issues two list reads rather than one (MOTIR-4852). `work_item.status` is a
   * plain `String` with no relation to `workflow_status`, so the CATEGORY the
   * band is defined by is not reachable from a Prisma `orderBy` at all. The
   * alternatives were a hand-written `ORDER BY CASE` in raw SQL — which would
   * have to RE-DECLARE the membership and scope predicate that
   * `homeProjectScopeWhere` owns, the exact drift this file's own criterion
   * forbids — or this: two reads over one predicate, ordered identically, with
   * the page's offset split between them by the moving group's own count. Both
   * reads and the count run in ONE transaction, so the split is computed against
   * the set it is applied to.
   */
  async listWatching(ctx: HomeActorContext, options: HomeListOptions = {}): Promise<HomePageDto> {
    const pageSize = clampLimit(options.limit);
    const { rows, total, page } = await withWorkspaceContext(ctx, async (tx) => {
      const projectScopes = await resolveActiveProjectScope(ctx, tx);
      // The MOVING group's own size is what splits the window. Counted with the
      // same predicate its list uses, in the same transaction as both reads —
      // so the split cannot be computed against a set that has since moved.
      const [found, movingTotal] = await Promise.all([
        watcherRepository.countByUser(ctx.userId, ctx.workspaceId, projectScopes, tx),
        watcherRepository.countByUserInGroup(
          ctx.userId,
          ctx.workspaceId,
          projectScopes,
          'in_progress',
          tx,
        ),
      ]);
      const window = windowFor(found, options.page, pageSize);
      // The window, split at the band boundary. A page entirely inside the
      // moving group takes nothing from the waiting one; a page entirely past it
      // skips the moving group's whole length; a page that STRADDLES the
      // boundary takes the tail of one and the head of the other, in that order
      // — which is the arrangement the offset made possible and the keyset never
      // produced (`design/workbench/` Panel 11).
      const takeMoving = Math.max(0, Math.min(pageSize, movingTotal - window.skip));
      const [moving, waiting] = await Promise.all([
        watcherRepository.listByUserInGroup(
          ctx.userId,
          ctx.workspaceId,
          {
            projectScopes,
            group: 'in_progress',
            take: takeMoving,
            skip: Math.min(window.skip, movingTotal),
          },
          tx,
        ),
        watcherRepository.listByUserInGroup(
          ctx.userId,
          ctx.workspaceId,
          {
            projectScopes,
            group: 'todo',
            take: pageSize - takeMoving,
            skip: Math.max(0, window.skip - movingTotal),
          },
          tx,
        ),
      ]);
      return { rows: [...moving, ...waiting], total: found, page: window.page };
    });
    return toPage(rows, ctx.userId, { total, page, pageSize });
  },
};
