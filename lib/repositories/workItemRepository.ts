import {
  Prisma,
  // The RUNTIME enum object as well as the type: `Object.keys` on it is the
  // Postgres DECLARATION order, which is what `deriveKindSortOrder` compares
  // against `READY_KIND_RANK`. Aliased so the type import below keeps its name.
  WorkItemKind as WorkItemKindEnum,
  type EstimationStatistic,
  type Executor,
  type WorkItem,
  type WorkItemDifficulty,
  type WorkItemImplementationSource,
  type WorkItemFixReason,
  type WorkItemKind,
  type WorkItemObsolescence,
  type WorkItemPlanningSource,
  type WorkItemPriority,
  type WorkItemResumeState,
  type WorkItemType,
} from '@/generated/prisma/client';
import { db, dbRead } from '@/lib/db';
import { sqlStateOf } from '@/lib/prisma/sqlstate';
import { PUBLIC_NOT_SHIPPED_DONE_KEY } from '@/lib/publicProjects/shippedStatus';
import type { BuiltInFilterFieldId, FilterAst, FilterCondition } from '@/lib/filters/ast';
import {
  resolveFilterAst,
  type CustomFieldFilterType,
  type FilterFieldDef,
  type ProjectFilterReferents,
} from '@/lib/filters/registry';
import { UnknownFilterOperatorError } from '@/lib/filters/errors';
import type { DistributionGroupBy } from '@/lib/reports/statisticTypes';
import type { FixDetailDto, WorkItemFixReasonDto } from '@/lib/dto/fixReason';
import type { StatusCategoryDto } from '@/lib/dto/workflows';
import type { IssueSort, IssueSortColumn } from '@/lib/issues/issueListView';
// The ONE declaration of the ready order. The Workbench reads it rather than
// re-typing it — see `deriveKindSortOrder`.
import { READY_KIND_RANK } from '@/lib/workItems/readyFilter';
import { quickSearchNumber } from '@/lib/workItems/quickSearch';

/**
 * The `WorkItem` create shape, NAMED BY THE OWNING REPOSITORY
 * (MOTIR-4296). Callers above this layer build their write payload against this
 * alias; `Prisma.WorkItemUncheckedCreateInput` itself is named only here.
 */
/** The lean columns the plan-validity projection reads (MOTIR-1386 / MOTIR-8146). */
export interface WorkItemValidityRow {
  id: string;
  identifier: string;
  status: string;
  parentId: string | null;
  sprintId: string | null;
  projectId: string;
  kind: string;
}

const VALIDITY_SELECT = {
  id: true,
  identifier: true,
  status: true,
  parentId: true,
  sprintId: true,
  projectId: true,
  kind: true,
} as const;

export type WorkItemCreateInput = Prisma.WorkItemUncheckedCreateInput;

/**
 * The `WorkItem` update shape, NAMED BY THE OWNING REPOSITORY
 * (MOTIR-4296). Callers above this layer build their write payload against this
 * alias; `Prisma.WorkItemUncheckedUpdateInput` itself is named only here.
 */
export type WorkItemUpdateInput = Prisma.WorkItemUncheckedUpdateInput;

/**
 * How a lazy tree level treats FOLDERS (Story MOTIR-5308 · MOTIR-5314).
 *
 * OMITTED, a level reads exactly as it always has. The run canvas, the plan
 * canvases, onboarding and the item page's Children panel omit it, and a filed
 * item is still the root it was for them. The ROADMAP passes it when the
 * `/roadmap` surface opts into folders (Bug MOTIR-5710 · MOTIR-5738): the root
 * leaves filed items out and a folder is its own level — never under sprint
 * scope, where placement is ignored.
 *   * `excludeFiled` — the ROOT level leaves out items filed in a folder, because
 *     the /items tree shows them inside their folder instead. Its optional `band`
 *     narrows that root to its EPICS or to every OTHER kind: the /items root reads
 *     its epics, then its folders, then the rest (MOTIR-5550), and a band is how
 *     each part's rows and its count share ONE predicate.
 *   * `folder` — the level IS one folder's filed items.
 * An explicit id set ignores it: a caller naming its rows has named them.
 */
export type TreeKindBand = 'epics' | 'others';
export type TreeFolderLevel =
  | { kind: 'excludeFiled'; band?: TreeKindBand }
  | { kind: 'folder'; folderId: string };
import {
  CrossProjectParentError,
  DepthLimitExceededError,
  IllegalParentTypeError,
  ParentCycleError,
  WorkItemKeyConflictError,
  WorkItemNotFoundError,
} from '@/lib/workItems/errors';
import { CrossProjectFolderError } from '@/lib/folders/errors';

// Work-item repository — single Prisma operations on the `work_item` table.
// Writes require `tx` (compile-time guarantee they run in a transaction);
// pure read paths use the `db` singleton (with an optional `tx` for reads
// that run inside a transaction). No business logic, no transactions, no DTO
// mapping here — those belong in workItemsService (Subtask 1.4.4).
//
// The DB-layer triggers (prisma/sql/work_item_triggers.sql) enforce parent
// TENANCY (MOTIR-2895), the kind-parent matrix, the depth limit, and cycle
// prevention. On INSERT / UPDATE they reject with SQLSTATE 23514 + a message
// marker; create/update
// translate those markers into the typed errors from lib/workItems/errors.ts
// at this edge, so the service layer never inspects Prisma/Postgres error
// codes (the 4-layer rule). P2002 (unique key/identifier) and P2025 (record
// not found) are translated here too.

/**
 * A row of `findSubtree`'s recursive-CTE result: the work item plus its
 * `depth` (1 = the root passed in, 2 = its children, …). `kind` is cast to
 * text in the query (the enum would otherwise come back as a Prisma enum);
 * `position` is already a text column. This is intentionally NOT a `WorkItem`
 * — it's the raw tree-walk projection.
 */
export interface WorkItemSubtreeRow {
  id: string;
  parentId: string | null;
  kind: WorkItemKind;
  key: number;
  identifier: string;
  title: string;
  status: string;
  position: string;
  /** The OBSOLESCENCE mark (MOTIR-6582), cast to text like `kind`. */
  obsolescence: WorkItemObsolescence | null;
  depth: number;
}

/**
 * A row of `findProjectForest`'s recursive-CTE result (Subtask 2.5.1): the
 * per-row render fields the tree-table shows (no Markdown blobs), the `depth`
 * (1 = a root) for indentation, and `matched` — whether the row passed the
 * supplied filter (always `true` when no filter is active). The service nests
 * these into `WorkItemTreeNodeDto`s and, under an active filter, prunes to
 * matched-or-has-matched-descendant (the context-preserving ancestor retention
 * — a tree operation, kept out of the single-op repo). `kind` is cast to text
 * in the query so `$queryRaw` returns the plain enum label.
 */
export interface WorkItemForestRow {
  id: string;
  parentId: string | null;
  kind: WorkItemKind;
  /** The leaf's work type (Story 2.7) — the row Type chip (8.8.9); `null` on
   *  containers. Cast to text in the query so `$queryRaw` returns the enum label. */
  type: WorkItemType | null;
  key: number;
  identifier: string;
  title: string;
  status: string;
  /** The item's CI verdict over its whole delivery set (`WorkItem.ciState`,
   *  MOTIR-5470) — the `/items` row's CI badge (MOTIR-5474). A plain `String?`
   *  column; it is in the fixed projection because these reads select explicitly
   *  and a column left out of one is silently `undefined` at the mapper. */
  ciState: string | null;
  /** Why the card is stuck until something is repaired (`WorkItem.fixReason`,
   *  MOTIR-6600) — the `/items` row's To fix tag (MOTIR-6610). In the fixed
   *  projection for the reason `ciState` is; cast to text so `$queryRaw` returns
   *  the enum label. */
  fixReason: WorkItemFixReasonDto | null;
  priority: WorkItemPriority;
  assigneeId: string | null;
  reporterId: string;
  dueDate: Date | null;
  estimateMinutes: number | null;
  storyPoints: Prisma.Decimal | null;
  updatedAt: Date;
  /** Does the item carry a non-empty description? See {@link WorkItemListRow}. */
  hasDescription: boolean;
  /** The OBSOLESCENCE mark + note (MOTIR-6579) — see {@link WorkItemListRow}. */
  obsolescence: WorkItemObsolescence | null;
  obsolescenceNoteMd: string | null;
  depth: number;
  matched: boolean;
  /** The epic-privacy flag — see {@link WorkItemListRow.publicChildrenHidden}. */
  publicChildrenHidden?: boolean;
}

/**
 * A row of `findProjectIssuesFlat`'s flat List read (Subtask 2.5.8): the same
 * per-row render fields as `WorkItemForestRow` minus the tree metadata
 * (`parentId` / `depth` / `matched`) — the List is un-nested, so there is no
 * hierarchy to carry. The service maps these to `WorkItemListItemDto`s.
 */
/**
 * One row of a HOME personal read (Story MOTIR-2649 · Subtask MOTIR-2651) — the
 * columns `design/home/`'s row draws, plus the owning project it identifies.
 *
 * NOT `WorkItemListRow`: Home adds the project (a project-scoped list never has
 * to say which project it is in) and `executor` (the agent badge), and drops
 * `hasDescription` (a projected boolean that exists to drive the `/items` row ⋯
 * menu, which Home does not render) and `dueDate` (no Due cell in Home's column
 * set). `descriptionMd` is never selected — the same reason the forest CTE
 * excludes it: these reads fan out across a whole workspace and the Markdown
 * body is the large column.
 */
export interface HomeWorkItemRow {
  id: string;
  kind: WorkItemKind;
  type: WorkItemType | null;
  key: number;
  identifier: string;
  title: string;
  status: string;
  /** The item's CI verdict over its whole delivery set (`WorkItem.ciState`,
   *  MOTIR-5470) — the Workbench row's CI badge (MOTIR-5475). In the fixed
   *  projection because every read producing this row shape selects explicitly:
   *  a column omitted from one arrives `undefined` at the mapper while the type
   *  claims `string | null`. */
  ciState: string | null;
  /** Why the card is stuck until something is repaired, and what the row names for it
   *  (`WorkItem.fixReason` / `fixDetail`, MOTIR-6600) — the To fix tab's reason line.
   *  In the shared projection for the reason `ciState` is. */
  fixReason: WorkItemFixReason | null;
  fixDetail: Prisma.JsonValue | null;
  /** Whether the card waits To resume, and on which gated run (`WorkItem.resumeState`
   *  / `resumeRunId`, MOTIR-7707). In the shared projection for the reason `ciState` is. */
  resumeState: WorkItemResumeState | null;
  resumeRunId: string | null;
  priority: WorkItemPriority;
  assigneeId: string | null;
  reporterId: string;
  executor: Executor | null;
  storyPoints: Prisma.Decimal | null;
  estimateMinutes: number | null;
  updatedAt: Date;
  completedAt: Date | null;
  project: { id: string; identifier: string; name: string };
}

/**
 * One work item of a Workbench work tab, narrowed to what GROUPING needs (Story
 * MOTIR-8012 · MOTIR-8014): its parent, and the fields `groupRank` /
 * `compareReadyPosition` rank on (kind, priority, key) plus the Recently finished
 * axis (`completedAt`). The full row is read later, for one page only, through
 * {@link workItemRepository.findHomeRowsByIds}.
 */
export interface HomeGroupingRow {
  id: string;
  parentId: string | null;
  kind: HomeWorkItemRow['kind'];
  priority: HomeWorkItemRow['priority'];
  key: HomeWorkItemRow['key'];
  completedAt: HomeWorkItemRow['completedAt'];
}

/**
 * The Prisma `select` producing a {@link HomeWorkItemRow}. Exported because the
 * WATCHING read projects the same row through the `watcher.workItem` relation —
 * one shape, one place, so the two tabs can never drift into rendering different
 * columns. A shared projection CONSTANT, not a cross-repository call (repos stay
 * leaves; `watcherRepository` issues its own single query).
 */
export const HOME_WORK_ITEM_SELECT = {
  id: true,
  kind: true,
  type: true,
  key: true,
  identifier: true,
  title: true,
  status: true,
  // The card's CI verdict (MOTIR-5470) — the Workbench row's badge (MOTIR-5475).
  // Selected in the ONE shared projection for the same reason `completedAt` is:
  // every tab reads through this constant, so adding it here is what keeps the
  // tabs from drifting into different columns.
  ciState: true,
  // The card's to-fix answer (MOTIR-6600) — the To fix tab's reason line, carried on
  // every tab's rows through this ONE projection for the reason `ciState` is.
  fixReason: true,
  fixDetail: true,
  // The card's To resume answer (MOTIR-7707), carried the same way.
  resumeState: true,
  resumeRunId: true,
  priority: true,
  assigneeId: true,
  reporterId: true,
  executor: true,
  difficulty: true,
  // The OBSOLESCENCE mark + note (MOTIR-6579) — beside `difficulty`, so every
  // read that returns the item's fields returns these.
  obsolescence: true,
  obsolescenceNoteMd: true,
  storyPoints: true,
  estimateMinutes: true,
  updatedAt: true,
  // WHEN it finished (MOTIR-4780) — null on everything that has not. Selected
  // for every tab, not only Recently finished, because ONE projection is what
  // keeps the tabs from drifting into different columns, and the alternative is
  // a second read to render a date the row already has.
  completedAt: true,
  project: { select: { id: true, identifier: true, name: true } },
} as const satisfies Prisma.WorkItemSelect;

/**
 * Which timestamp a Workbench read ORDERS BY — and therefore which one its
 * cursor keys on (Story MOTIR-4777 · MOTIR-4781).
 *
 * ⚠️ THE TWO ARE ONE DECISION, not two. A keyset mints a POSITION in a sort, so
 * a cursor keyed on a different pair than the `ORDER BY` is a page boundary
 * that drifts — it repeats and drops rows silently, and the list "sometimes
 * ends early" is a bug nobody traces. Naming the axis once, here, is what makes
 * it impossible to order a read by one column and page it by another.
 */
export type HomeSortField = 'updatedAt' | 'completedAt';

/**
 * WHICH DIRECTION Prisma must sort `kind` in for the Workbench's three work
 * tabs to come back in the READY order — `subtask → bug → task → story → epic`.
 *
 * ⚠️ DERIVED FROM {@link READY_KIND_RANK}, NEVER RE-DECLARED (MOTIR-4852). The
 * Workbench and `/ready` both claim to be "in ready order", and two lists that
 * derive one order separately will disagree eventually — quietly, because
 * nothing errors: one page just puts an epic above a subtask. So the rank has
 * exactly one home (`lib/workItems/readyFilter.ts`) and this reads it.
 *
 * Postgres sorts an enum by its DECLARATION order, and `WorkItemKind` is
 * declared `epic, story, task, bug, subtask` — the ready rank, backwards. So
 * `desc` is the answer today. **That coincidence is not the contract**, which is
 * why it is COMPUTED here rather than typed: this function compares the
 * generated client's declaration order against the rank and answers `null` when
 * neither direction expresses it — which is what a sixth kind, or a re-declared
 * enum, would produce.
 *
 * `null` is a CI finding, not a runtime branch: `tests/workbench/kind-order-guard.test.ts`
 * asserts it is non-null AND that the resulting order agrees with
 * `compareReadyRows` for every pair of kinds, so a re-declaration goes red on the
 * pull request. Production degrades to today's answer rather than throwing on a
 * landing page — a 500 on the first screen after signing in is a worse failure
 * than a list a guard has already caught.
 */
export function deriveKindSortOrder(
  rank: Readonly<Record<string, number>> = READY_KIND_RANK,
  declaration: readonly string[] = Object.keys(WorkItemKindEnum),
): Prisma.SortOrder | null {
  const byRank = [...declaration].sort((a, b) => (rank[a] ?? 0) - (rank[b] ?? 0));
  if (declaration.every((k, i) => k === byRank[i])) return 'asc';
  if ([...declaration].reverse().every((k, i) => k === byRank[i])) return 'desc';
  return null;
}

/**
 * The sort direction the Workbench reads actually pass to Prisma. See
 * {@link deriveKindSortOrder} for why the fallback is a guarded CI finding
 * rather than a throw.
 */
export const HOME_KIND_SORT_ORDER: Prisma.SortOrder = deriveKindSortOrder() ?? 'desc';

/**
 * The `orderBy` a Workbench read uses, chosen by its axis.
 *
 * The three WORK tabs order by KIND — the question a reader opens the surface
 * with is *what do I pick up next*, and the most granular work is the work they
 * can start. Recently finished keeps `completedAt DESC`, because *what did I
 * just finish* IS a time question.
 *
 * ⚠️ The `id DESC` tiebreak is what makes an offset page boundary EXACT. Kind is
 * a five-valued key, so it leaves large ties; without a total tiebreak after it
 * two adjacent pages could repeat a row and drop another, and nothing would
 * error. (Under the keyset this was the cursor's job; the tiebreak is where that
 * obligation went.)
 */
export function homeOrderBy(sortField: HomeSortField): Prisma.WorkItemOrderByWithRelationInput[] {
  return sortField === 'completedAt'
    ? [{ completedAt: 'desc' }, { id: 'desc' }]
    : [{ kind: HOME_KIND_SORT_ORDER }, { id: 'desc' }];
}

/**
 * ONE project a Home read may return rows from, WITH that project's own
 * done-category status keys (MOTIR-2758).
 *
 * ⚠️ The two halves travel TOGETHER on purpose. Home's reads used to take a bare
 * `projectIds: string[]`, and the lifecycle axis simply wasn't in the query — so
 * the surface whose subtitle says *"waiting on you"* listed finished work, 87% of
 * it for the reader who uses the product most. Pairing the ids with their
 * exclusion set makes the axis un-droppable: there is no call shape that scopes
 * the projects without also deciding what counts as finished IN each of them.
 */
export interface HomeProjectScope {
  projectId: string;
  /**
   * THAT project's own status keys, grouped by `workflow_status.category` —
   * `todo` / `in_progress` / `done`. All three groups are always present; an
   * empty one means the project has no status in that category, which is a
   * legitimate answer a custom workflow can give.
   *
   * ⚠️ WIDENED FROM AN EXCLUSION TO A PARTITION (Story MOTIR-4777 ·
   * MOTIR-4781). This was `doneStatusKeys` — one group, used only to subtract
   * finished work. The Workbench needs the other two as well, because it splits
   * one list into three ALONG this axis, and carrying the whole partition
   * rather than one slice of it is what stops the next tab from arriving with
   * its own second resolver.
   */
  statusKeysByCategory: Readonly<Record<StatusCategoryDto, readonly string[]>>;
}

/**
 * WHICH lifecycle slice a Workbench read is for.
 *
 * `in` — the statuses of these categories. `notIn` — everything EXCEPT them.
 *
 * ⚠️ THE COMPLEMENT FORM IS NOT A CONVENIENCE, IT IS WHAT MAKES THE THREE WORK
 * TABS TOTAL. The story's own criterion is that the tabs *"hold every row the
 * old My work held plus the recently-finished ones — no row appears in two
 * tabs, and none is dropped"*, and a partition written as three `IN` predicates
 * cannot promise that: it is total only if every `work_item.status` in the
 * database names a live `workflow_status` row of its project, which is a
 * property of the data rather than of the query. A row whose status names no
 * category — a legacy key, a column deleted around the reassign path, the
 * schema's own vestigial `"open"` default — would then appear in NO tab at all,
 * invisible on the one surface that exists to say what is on you.
 *
 * So To do is written as the COMPLEMENT of *in progress* and *done* rather than
 * as the `todo` group: whatever is neither moving nor finished is waiting, by
 * construction, whether or not its status was ever registered. That is also
 * exactly where the shipped `/home` list put such a row (MOTIR-2758's
 * done-EXCLUSION), so nothing a reader can see today disappears.
 */
export type HomeCategorySlice = (
  | { in: readonly StatusCategoryDto[] }
  | { notIn: readonly StatusCategoryDto[] }
) & {
  /**
   * The TO FIX axis (Story MOTIR-6588 · MOTIR-6604) — `set` keeps only the cards
   * whose `fixReason` is not null, `unset` only those whose is; absent means the
   * slice does not care. It is how To fix is carved OUT of In progress rather than
   * read beside it: the two slices name the same category and opposite values of
   * this, so a card is on exactly one of them by construction.
   */
  fixReason?: 'set' | 'unset';
  /**
   * The TO RESUME axis (Story MOTIR-7701 · MOTIR-7707) — the same shape over
   * `resumeState`. In progress takes it `unset` and To resume `set`, so a card
   * waiting on a gated run is on exactly one of them; To resume also takes
   * `fixReason` `unset`, so To fix wins if both somehow hold.
   */
  resumeState?: 'set' | 'unset';
};

/**
 * The `WHERE` half of a Workbench read's project scope — "in one of these
 * projects, and in (or out of) THAT PROJECT'S OWN statuses for the categories
 * the slice names".
 *
 * ⚠️ PER PROJECT, never one flat `status` list. Statuses are project-defined
 * open vocabulary, so a flat list would let project A's `released` decide
 * project B's rows — where the same key may mean something else entirely. A
 * flat implementation passes every single-project test and is wrong the first
 * time two workspaces disagree about a name. (The surface reads ONE project
 * today; the shape is kept because the reason it was written that way has not
 * changed, and re-widening the scope must not silently re-open the defect.)
 *
 * A project with NO status in the named categories contributes, correctly,
 * either a clause that matches nothing (`in`) or an unfiltered clause
 * (`notIn`) — a workflow with no done-category status has no finished work to
 * show and none to hide.
 *
 * Emitted as a `Prisma.WorkItemWhereInput` carrying an `OR`, so every caller
 * must place it inside an explicit `AND` alongside the membership `OR` —
 * spreading two `OR`-bearing fragments into one object silently drops the first.
 */
export function homeProjectScopeWhere(
  scopes: readonly HomeProjectScope[],
  slice: HomeCategorySlice,
): Prisma.WorkItemWhereInput {
  return {
    OR: scopes.map(({ projectId, statusKeysByCategory }) => {
      const named = ('in' in slice ? slice.in : slice.notIn).flatMap((c) => [
        ...statusKeysByCategory[c],
      ]);
      const fix =
        slice.fixReason === 'set'
          ? { fixReason: { not: null } }
          : slice.fixReason === 'unset'
            ? { fixReason: null }
            : {};
      const resume =
        slice.resumeState === 'set'
          ? { resumeState: { not: null } }
          : slice.resumeState === 'unset'
            ? { resumeState: null }
            : {};
      return 'in' in slice
        ? { projectId, status: { in: named }, ...fix, ...resume }
        : // An empty exclusion is an unfiltered clause, NOT a never-matching
          // one: `notIn: []` and "no constraint" are the same predicate, and
          // Prisma renders the former as a tautology anyway.
          {
            projectId,
            ...(named.length > 0 ? { status: { notIn: named } } : {}),
            ...fix,
            ...resume,
          };
    }),
  };
}

/**
 * WHICH lifecycle slice a Workbench read is for, and — for the finished window
 * — the axis and floor it is bounded by. The options every membership read
 * shares, named once so the three that take them cannot drift apart.
 */
export interface HomeMembershipOptions {
  slice: HomeCategorySlice;
  /** The finished window, on the same axis the matching list read orders by. */
  since?: Date;
  sortField?: HomeSortField;
}

/**
 * THE WHOLE `WHERE` OF A WORKBENCH MEMBERSHIP READ, written ONCE — the
 * workspace gate, the read-exclusions, the assignee-OR-reporter membership
 * `OR`, the per-project status scope, and the finished window.
 *
 * ⚠️ IT EXISTS BECAUSE THERE ARE NOW **THREE** READS OVER IT, not two. The list
 * and its count already carried identical copies of this object and the file's
 * own comment said why that matters — *"a count that disagrees with its list is
 * a badge that lies"* (MOTIR-2758, where the badge read ~2 019 against ~263).
 * MOTIR-5240 adds a third reader, the WATERMARK, whose whole job is to answer
 * *has anything in this tab moved* — and a watermark taken over a NARROWER set
 * than the tab renders is a silent hole: the list goes stale and nothing ever
 * nudges. That failure is invisible in every test whose fixture happens to
 * change a row the watermark does see, which is why the predicate is shared
 * rather than re-asserted.
 *
 * ⚠️ ALL THREE inner predicates are `OR`-bearing, so they sit in an explicit
 * `AND` — a spread would have one `OR` overwrite the others and return the
 * whole workspace's items.
 */
export function homeMembershipWhere(
  userId: string,
  workspaceId: string,
  projectScopes: readonly HomeProjectScope[],
  options: HomeMembershipOptions,
): Prisma.WorkItemWhereInput {
  const { slice, since, sortField = 'updatedAt' } = options;
  return {
    workspaceId,
    archivedAt: null,
    triagedAt: null, // read-exclusion (6.11.3)
    AND: [
      { OR: [{ assigneeId: userId }, { reporterId: userId }] },
      homeProjectScopeWhere(projectScopes, slice),
      ...(since ? [{ [sortField]: { gte: since } } as Prisma.WorkItemWhereInput] : []),
    ],
  };
}

/**
 * TO DO — the complement of *in progress* and *done*. See
 * {@link HomeCategorySlice} for why this is a complement rather than the `todo`
 * group.
 */
export const HOME_SLICE_TODO: HomeCategorySlice = { notIn: ['in_progress', 'done'] };

/**
 * IN PROGRESS — what is moving, including an agent's output awaiting a person.
 *
 * ⚠️ MINUS TO FIX (MOTIR-6604): a card stuck until something is repaired is in the
 * same category and is listed on To fix instead, never on both.
 */
export const HOME_SLICE_IN_PROGRESS: HomeCategorySlice = {
  in: ['in_progress'],
  fixReason: 'unset',
  // ⚠️ MINUS TO RESUME (MOTIR-7707): a card waiting on a gated run is listed there.
  resumeState: 'unset',
};

/**
 * TO FIX — the in-progress cards stuck until something is repaired (Story MOTIR-6588
 * · MOTIR-6604): `fixReason IS NOT NULL`, the other half of {@link HOME_SLICE_IN_PROGRESS}.
 */
export const HOME_SLICE_TO_FIX: HomeCategorySlice = { in: ['in_progress'], fixReason: 'set' };

/**
 * TO RESUME — the in-progress cards whose latest run stopped at an approval gate
 * (Story MOTIR-7701 · MOTIR-7707): `resumeState IS NOT NULL`, minus To fix, which
 * wins if both hold, so the three slices partition the category.
 */
export const HOME_SLICE_TO_RESUME: HomeCategorySlice = {
  in: ['in_progress'],
  fixReason: 'unset',
  resumeState: 'set',
};

/** RECENTLY FINISHED — the terminal slice; the caller adds the window. */
export const HOME_SLICE_DONE: HomeCategorySlice = { in: ['done'] };

/**
 * EVERYTHING NOT FINISHED — the set the shipped `/home` "My work" list showed,
 * and the union of the two work tabs.
 *
 * It is MOTIR-2758's done-exclusion, unchanged and now written down once, which
 * is what lets the old read and the two tabs that replace it share one
 * implementation instead of drifting apart.
 */
export const HOME_SLICE_UNFINISHED: HomeCategorySlice = { notIn: ['done'] };

/** Every row, whatever its status — the widened set a positive control reads. */
export const HOME_SLICE_ALL: HomeCategorySlice = { notIn: [] };

/**
 * WHICH of Watching's two groups a row is in (Story MOTIR-4777 · MOTIR-4781,
 * re-purposed by MOTIR-4852).
 *
 * Watching orders `in_progress`-category rows ahead of `todo`-category ones, and
 * **Prisma cannot order by that group at all**: `work_item.status` is a plain
 * `String` with no relation to `workflow_status`, so the CATEGORY the group is
 * defined by is not reachable from a `WorkItemOrderByWithRelationInput`. The
 * group is therefore a PREDICATE — one read per group, ordered identically — and
 * `homeService.listWatching` splits the offset window across the two using the
 * moving group's own count. That keeps ONE declaration of the membership and
 * scope predicate, which a hand-written `ORDER BY CASE` in raw SQL would not.
 *
 * ⚠️ It used to name where a CURSOR stopped, and that is what changed: a keyset
 * position was ambiguous between the two groups, so the token carried the group.
 * An offset is not ambiguous, so the type is now only what it says — which of the
 * two a row belongs to.
 */
export type WatchingGroup = 'in_progress' | 'todo';

export interface WorkItemListRow {
  id: string;
  kind: WorkItemKind;
  /** The leaf's work type (Story 2.7) — the row Type chip (8.8.9); `null` on
   *  containers. `WorkItemTreeRow` / `ArchivedWorkItemRow` inherit it. */
  type: WorkItemType | null;
  key: number;
  identifier: string;
  title: string;
  status: string;
  /** The item's CI verdict over its whole delivery set (`WorkItem.ciState`,
   *  MOTIR-5470) — the `/items` row's CI badge (MOTIR-5474). A plain `String?`
   *  column; it is in the fixed projection because these reads select explicitly
   *  and a column left out of one is silently `undefined` at the mapper. */
  ciState: string | null;
  /** Why the card is stuck until something is repaired (`WorkItem.fixReason`,
   *  MOTIR-6600) — the `/items` row's To fix tag (MOTIR-6610). In the fixed
   *  projection for the reason `ciState` is; cast to text so `$queryRaw` returns
   *  the enum label. */
  fixReason: WorkItemFixReasonDto | null;
  priority: WorkItemPriority;
  assigneeId: string | null;
  reporterId: string;
  dueDate: Date | null;
  estimateMinutes: number | null;
  storyPoints: Prisma.Decimal | null;
  updatedAt: Date;
  /**
   * Does the item carry a non-empty description (MOTIR-2098)? A projected
   * BOOLEAN — `descriptionMd IS NOT NULL AND <> ''` — never the body itself:
   * the list/tree reads fan out over every row of a project and the Markdown
   * blob is large, which is exactly why the forest CTE's fixed projection
   * excludes `descriptionMd`. It is the LEAF face of the shared Plan / Re-plan
   * rule (`planEntranceFace` rule 2), which the `/items` row ⋯ menu could not
   * evaluate until this column existed. Every read producing this row shape
   * projects it — `$queryRaw` is an UNCHECKED cast, so an omission would
   * surface as `undefined` at runtime rather than a compile error.
   */
  hasDescription: boolean;
  /** The OBSOLESCENCE mark (Story MOTIR-6574 · MOTIR-6579), cast to text in the
   *  query; `null` when unmarked. Every read producing this row shape projects
   *  it and the note — an omission would be `undefined` at runtime. */
  obsolescence: WorkItemObsolescence | null;
  obsolescenceNoteMd: string | null;
  /**
   * The EPIC-PRIVACY flag (Story 6.14; read for a Visitor, MOTIR-6644) — projected
   * by the in-app collection reads a Visitor can reach (the flat List, the forest
   * and the lazy tree level) so the service can mark a private epic's row
   * `childrenHidden` and strip its tells. OPTIONAL because the other reads that
   * produce this row shape do not select it; no member DTO carries it.
   */
  publicChildrenHidden?: boolean;
}

/**
 * A row of `findProjectIssuesKeyset` (Story 11.2 · Subtask 11.2.3) — the flat
 * List row PLUS `createdAt`, which is half the keyset position the v1 cursor
 * encodes. It is carried because the ROUTE has to mint the next cursor from the
 * last row it returned; it is part of the page addressing, not a new field on an
 * existing read (`WorkItemListRow` is untouched, so the `/items` view's shape is
 * exactly as it was).
 */
export interface WorkItemKeysetRow extends WorkItemListRow {
  createdAt: Date;
}

/**
 * One row of a LAZY tree level (Subtask 2.5.13): a single parent's direct
 * children OR the project's roots — paged + sorted. Same render fields as
 * `WorkItemListRow`, plus `parentId` (so the client can place it) and
 * `hasChildren` — an `EXISTS` flag driving the expand chevron WITHOUT
 * pre-loading the subtree (the whole-forest scale fix, finding #57). No `depth`
 * (the client tracks it via expansion) and no `matched` (the lazy path is the
 * UNfiltered tree; a filtered tree still uses `findProjectForest`).
 */
export interface WorkItemTreeRow extends WorkItemListRow {
  parentId: string | null;
  hasChildren: boolean;
  /** WHO executes the leaf (Story 2.7) — `coding_agent` / `human` / `null`. Carried
   *  alongside `type` (on `WorkItemListRow`) so the roadmap node can flag a
   *  human-gated item (`executor === 'human' || type === 'manual'`, the shipped
   *  `isManualReadyItem` predicate; MOTIR-1642 / 8.8.36). `null` on a container. */
  executor: Executor | null;
  /** The item's active-sprint membership column (MOTIR-1379 follow-up). `null`
   *  for a never-committed item. The sprint-scoped roadmap service compares it to
   *  the resolved active sprint so a drilled-in node that is NOT a sprint member
   *  can be shown differently ("not in sprint"); the whole-project tree read
   *  ignores it. */
  sprintId: string | null;
}

/**
 * One row of the ARCHIVED list read (Subtask 2.9.2) — the same per-row render
 * fields as `WorkItemListRow` PLUS the two bits the archive-management surface
 * (Story 2.9) needs and that no active-view read carries: the `archivedAt`
 * stamp (the soft-delete instant the list orders by) and the actor who archived
 * it, resolved by the SAME single read from the latest `'archived'` revision
 * (`changedById` + the user's display name / avatar, left-joined). `archivedBy*`
 * is nullable because the revision's author is `onDelete: Restrict` but a future
 * data path could still leave it absent — the mapper degrades to `null` (a
 * "former member" fallback) rather than dropping the row.
 */
export interface ArchivedWorkItemRow extends WorkItemListRow {
  archivedAt: Date;
  archivedById: string | null;
  archivedByName: string | null;
  archivedByImage: string | null;
}

/**
 * One CANDIDATE row of the ready set (Subtask 7.0.2): the FULL `work_item` row
 * (so the `readyMappers` `toReadyItemDto(row: WorkItem, …)` can consume it
 * directly — the 7.0.3 mapper takes a `WorkItem` + resolved context) PLUS the
 * three bits resolved by the SAME single read so the service doesn't re-query:
 * the status `category` (joined from `workflow_status` — the row's `status` is
 * only the key) and the assignee's display name / email / avatar (left-joined
 * from `user`). The service hands `row` + `{ statusCategory, assignee }` to the
 * mapper.
 *
 * It is a CANDIDATE row, not a confirmed ready item: the per-blocker terminal
 * classification (readiness) is computed in the service over a batched
 * `getReadinessForItems` (finding #21 — "terminal" is a per-blocker-project
 * property the single-op repo can't express), then the candidates are filtered
 * to `ready === true`.
 */
export type ReadyCandidateRow = WorkItem & {
  statusCategory: string;
  assigneeName: string | null;
  assigneeEmail: string | null;
  assigneeImage: string | null;
};

/**
 * One row of a ready-set LAYER (Subtask 7.0.13) — a `ReadyCandidateRow` plus
 * `hasChildren`, the bit the top-down traversal needs to decide DESCEND (a
 * planned container) vs COLLECT (a childless, dispatchable leaf). Unlike
 * `findReadyCandidates` (which scanned the whole project's leaves), the layered
 * read fetches one parent level at a time and does NOT pre-filter to
 * `todo`/leaf — the service decides per row — so `statusCategory` is the live
 * category (possibly non-`todo` for a container we still descend into).
 */
export type ReadyLayerRow = ReadyCandidateRow & { hasChildren: boolean };

/**
 * The SHAPE of a ready leaf's PARENT (Story MOTIR-6829 · MOTIR-6830) — what the
 * ready lanes need to decide whether that parent is a RUNNABLE CONTAINER (a
 * `story` / `task` / `bug` none of whose children has children) and to render
 * it as a group header. `childCount` counts the parent's live children, ready or
 * not; `hasGrandchildren` is true when any live child has a live child.
 */
export interface ReadyContainerShapeRow {
  id: string;
  identifier: string;
  key: number;
  kind: WorkItemKind;
  title: string;
  priority: WorkItemPriority;
  sprintId: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  assigneeEmail: string | null;
  assigneeImage: string | null;
  childCount: number;
  hasGrandchildren: boolean;
}

/**
 * One row of the triage QUEUE read (Subtask 6.11.3) — the FULL `work_item` row
 * (so the mapper consumes its `triagedAt` / `snoozedUntil` columns directly)
 * PLUS the bits the SAME single read resolves so the service doesn't re-query:
 * the status `category` (joined from `workflow_status` — the row's `status` is
 * only the key) and the SUBMITTER's display name / email / avatar (left-joined
 * from `user` on `submittedByUserId`) plus whether that submitter is a member of
 * the item's workspace. Intake is signed-in only (the 2026-06-14 revision,
 * Subtask 6.11.10), so the submitter is always a real account; the inbox derives
 * "member vs public" from `submitterIsMember` (ADR §3).
 */
export type TriageQueueRow = WorkItem & {
  statusCategory: string;
  submitterName: string | null;
  submitterEmail: string | null;
  submitterImage: string | null;
  /**
   * TRUE when `submittedByUserId` is a member of the item's workspace (the
   * in-app report widget); FALSE for a signed-in non-member (Story 6.12's public
   * "Submit a request") or when the item has no recorded submitter. Drives the
   * mapper's member-vs-public `kind`.
   */
  submitterIsMember: boolean;
  /**
   * How many accounts upvoted this request (Story 6.12 · Subtask 6.12.6) — the
   * demand signal the queue sorts by, highest-first. 0 for an item with no
   * public votes (the common case), so a queue with no votes keeps its
   * newest-first order (votes tie at 0 → the `triagedAt`/`id` tiebreak decides).
   */
  voteCount: number;
};

/**
 * The seek-after position the triage-queue cursor decodes to — the last item of
 * the previous page under the queue's `(voteCount DESC, triagedAt DESC, id ASC)`
 * total order (Story 6.12 · Subtask 6.12.6 added the leading vote-count key — the
 * demand signal — ahead of the original newest-first `(triagedAt, id)` tiebreak,
 * so an upvoted request floats up while a zero-vote queue is unchanged).
 * `triagedAt` is the marker timestamp (always non-null for a queue row); `id`
 * breaks the (rare) same-instant tie so paging never skips/repeats a row.
 */
export interface TriageQueueCursor {
  voteCount: number;
  triagedAt: Date;
  id: string;
}

/**
 * One duplicate-detection candidate row (Story 6.12 · Subtask 6.12.5) — a
 * matching active PUBLIC REQUEST plus its upvote count (the demand signal the
 * "upvote this instead" affordance shows). A public request is a project work
 * item of request grammar (`bug` / `task`); the count rides the 6.12.3
 * `PublicRequestVote` join (zero when no votes / before 6.12.6 lands the write).
 */
export type PublicRequestMatchRow = WorkItem & {
  voteCount: number;
};

/**
 * One card of a PUBLIC ROADMAP column (Story 6.12 · Subtask 6.12.7) — the FULL
 * `work_item` row (the public mapper reads only its public-safe fields) PLUS the
 * two bits the SAME single read resolves: `voteCount` (the upvote tally — the
 * demand signal the column orders by, 6.12.6) and `voted` (whether the CURRENT
 * viewer has upvoted this card, so the card paints its voted state on first
 * load; always `false` for a logged-out reader). The vote aggregate + the
 * viewer-vote probe ride the app-layer `projectId` gate + the app connection's
 * RLS-secondary posture, the same way `findTriageQueue` / `countByProject` read
 * `public_request_vote` (finding #26).
 */
export type PublicRoadmapRow = WorkItem & {
  voteCount: number;
  voted: boolean;
};

/**
 * One row of a LAZY level of the PUBLIC work-item TREE (Story 6.14 · Subtask
 * 6.14.10) — a single parent's direct children OR the project's roots, projected
 * to the PUBLIC-safe fields ONLY (no assignee / estimate / story points / due
 * date / reporter — those are never SELECTed, so an internal field cannot leak;
 * the public projection is structural, not a runtime omission). Carries:
 *
 *   - `publicChildrenHidden` — the epic-privacy flag (6.14.4) the mapper reads to
 *     stamp the "this epic is not public" marker on a PRIVATE epic's row.
 *   - `hasChildren` — an `EXISTS` over the node's PUBLICLY-VISIBLE children (the
 *     same `excludeIds` exclusion as the level itself, so a private epic — whose
 *     descendants are all excluded — reports `false`; the placeholder chevron is
 *     driven by `publicChildrenHidden`, not this flag).
 *
 * Same `parentId` + lazy-`hasChildren` shape as the authed {@link WorkItemTreeRow},
 * minus the internal columns.
 */
export interface PublicWorkItemTreeRow {
  id: string;
  parentId: string | null;
  kind: WorkItemKind;
  key: number;
  identifier: string;
  title: string;
  status: string;
  priority: WorkItemPriority;
  publicChildrenHidden: boolean;
  hasChildren: boolean;
}

/**
 * One row of the PUBLIC CHANGELOG (Story 8.9 · Subtask 8.9.3 ·
 * `docs/decisions/public-follow-and-changelog.md` §3) — a work item that
 * entered a `done`-category status, dated by that transition.
 *
 * The column set is deliberately the public-safe one
 * {@link PublicWorkItemTreeRow} already projects (no assignee, no estimate, no
 * story points, no reporter, no sprint), plus the derived `shippedAt` and the
 * ancestor epic the entry's chip renders. The public boundary stays STRUCTURAL
 * — a column the read never SELECTs cannot be leaked by a mapper.
 */
export interface PublicChangelogRow {
  id: string;
  kind: WorkItemKind;
  key: number;
  identifier: string;
  title: string;
  status: string;
  priority: WorkItemPriority;
  /** The item's MOST RECENT transition into a `done`-category status. */
  shippedAt: Date;
  /** The ancestor epic, for the entry's chip — null when there is none. */
  epicIdentifier: string | null;
  epicTitle: string | null;
  /**
   * The item's body, and ONLY when the caller asked for it
   * (`options.withDescription`) — the FEED does, the page does not.
   *
   * The page's projection stays minimal on purpose: the public boundary here is
   * structural, and a column the read never SELECTs cannot be leaked by a
   * mapper. A feed reader, though, shows the body rather than a bare title, so
   * the one consumer that needs it asks for it. This exposes no new class of
   * data — `PublicWorkItemDetailDto` already publishes `descriptionMd` on the
   * public item page; it is the same public field through a second door.
   */
  descriptionMd?: string | null;
}

/**
 * The `(shippedAt, key)` seek-after position a changelog page reads after
 * (Subtask 8.9.3). `shippedAt` is the leading sort key and `key` the tiebreak —
 * `changedAt` alone is NOT a total order (two revisions in the same millisecond
 * tie, and an unbroken tie makes both the rendered order and cursor paging
 * non-deterministic, so a page boundary landing mid-tie skips or repeats a row —
 * PRODECT_FINDINGS #38, the same reasoning `listByWorkItem` records).
 */
export interface PublicChangelogCursor {
  shippedAt: Date;
  key: number;
}

/**
 * The `(voteCount, recency, id)` seek-after position a roadmap column read pages
 * after (Subtask 6.12.7). `voteCount` is the leading sort key; `recency` is the
 * bucket tiebreak — a `Date` (the Submitted column's `triagedAt`) or a `number`
 * (a promoted column's monotonic `key`); `id` breaks the exact tie. The service
 * decodes the opaque cursor token into this typed shape per column.
 */
export interface PublicRoadmapCursor {
  voteCount: number;
  recency: Date | number;
  id: string;
}

/**
 * The whitelisted ORDER-BY expression per sort column (Subtask 2.5.8). The
 * key is a validated `IssueSortColumn` (parsed/clamped in `issueListView`), so
 * the SQL fragment is never derived from raw user input. `assignee`/`reporter`
 * sort by the joined user name (`au`/`ru` in `findProjectIssuesFlat`); `status`
 * by the project workflow's status order (`ws.position`); the rest are
 * `work_item` columns. Total over `IssueSortColumn` (compile-time checked).
 */
const ISSUE_SORT_SQL: Record<IssueSortColumn, Prisma.Sql> = {
  key: Prisma.sql`w."key"`,
  title: Prisma.sql`w."title"`,
  // The Type column (Subtask 8.8.9) — orders by the work_item_type enum's
  // declaration order (NULL-type containers sort last via the NULLS LAST clause).
  type: Prisma.sql`w."type"`,
  priority: Prisma.sql`w."priority"`,
  assignee: Prisma.sql`au."name"`,
  reporter: Prisma.sql`ru."name"`,
  due: Prisma.sql`w."dueDate"`,
  estimate: Prisma.sql`w."estimateMinutes"`,
  points: Prisma.sql`w."storyPoints"`,
  status: Prisma.sql`ws."position"`,
};

/**
 * The roll-up aggregate expression for an estimation `statistic` (Subtask
 * 4.3.3), parameterising the bounded sprint/epic roll-ups so adding the
 * statistic switch is ONE parameter, not three query paths (the durable shape).
 * The `statistic` is a validated Prisma enum (never raw user input), so the
 * branch is a whitelist — the same pattern as `ISSUE_SORT_SQL`. `colOwner` is
 * the alias the points/time column hangs off (`w` for the flat sprint scan, `s`
 * for the recursive subtree CTE). `doneFilter`, when true, scopes the SUM to
 * issues in a `category = 'done'` workflow status via an aggregate `FILTER`
 * (the `ws` join must be present) — used for a sprint's `completed` points.
 * Sums `COALESCE`-to-0 so an all-NULL/empty group returns 0, never NULL.
 */
function pointsAggExpr(
  statistic: EstimationStatistic,
  colOwner: 'w' | 's',
  doneFilter: boolean,
): Prisma.Sql {
  const filter = doneFilter ? Prisma.sql` FILTER (WHERE ws."category" = 'done')` : Prisma.empty;
  if (statistic === 'issue_count') {
    return Prisma.sql`COUNT(*)${filter}`;
  }
  const owner = Prisma.raw(colOwner); // 'w' | 's' — an internal literal, never user input
  const col =
    statistic === 'story_points'
      ? Prisma.sql`${owner}."storyPoints"`
      : Prisma.sql`${owner}."estimateMinutes"`;
  return Prisma.sql`COALESCE(SUM(${col})${filter}, 0)`;
}

/** Escape a string for use as a literal inside a Postgres ARE (regex) alternation. */
function escapeRegexLiteral(value: string): string {
  return value.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&');
}

export const workItemRepository = {
  async findById(id: string, tx?: Prisma.TransactionClient): Promise<WorkItem | null> {
    const client = tx ?? dbRead;
    return client.workItem.findUnique({ where: { id } });
  },

  /**
   * Acquire a row-level lock on the work item inside the caller's transaction.
   * This is the guarding read for the update / move flow (workItemsService,
   * 1.4.4): lock the row, re-read current state to compute the revision diff +
   * validate the parent move, then write — all serialized against a concurrent
   * mutation of the same row. Without the lock, two transactions could each
   * read the pre-move tree, both pass the cycle/depth trigger on their own
   * stale snapshot, and together corrupt the tree (or clobber each other's
   * field writes — a lost update). Returns null when the id doesn't exist.
   * Read-inside-a-transaction that gates a write → requires `tx` per CLAUDE.md
   * (mirrors userRepository.lockById).
   */
  /**
   * Every work item filed directly in one folder, in display order — what
   * `foldersService.deleteFolder` moves up before it deletes the folder.
   *
   * UNFILTERED on purpose: an archived or triaged item filed there still holds
   * the folder's foreign key, so a delete that skipped it would be refused by
   * the database halfway through (Story MOTIR-5308 · MOTIR-5313).
   */
  async findFiledInFolder(
    folderId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Array<Pick<WorkItem, 'id' | 'kind' | 'parentId' | 'position'>>> {
    return tx.workItem.findMany({
      where: { folderId },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      select: { id: true, kind: true, parentId: true, position: true },
    });
  },

  /**
   * The folder each FILED work item among `workItemIds` sits in, keyed by item id
   * — the placement the planner's tree read carries (Story MOTIR-5310 ·
   * MOTIR-5410). ONE batched read for the whole projection, never a per-row
   * fetch; an unfiled item simply has no entry. It stays a read the tree read
   * OWNS, so `folderId` never has to widen the published `WorkItemDto`.
   */
  async findFolderIdsByWorkItemIds(
    workItemIds: string[],
    tx: Prisma.TransactionClient,
  ): Promise<Map<string, string>> {
    if (workItemIds.length === 0) return new Map();
    const rows = await tx.workItem.findMany({
      where: { id: { in: workItemIds }, folderId: { not: null } },
      select: { id: true, folderId: true },
    });
    const byId = new Map<string, string>();
    for (const row of rows) if (row.folderId !== null) byId.set(row.id, row.folderId);
    return byId;
  },

  /**
   * How many work items are filed DIRECTLY in a folder — exactly the set
   * `findFiledInFolder` returns (no archive or triage filter), so a delete
   * confirmation counts what `foldersService.deleteFolder` will move.
   */
  async countFiledInFolder(folderId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.workItem.count({ where: { folderId } });
  },

  /**
   * The last position among the work items at one FOLDER LEVEL — filed in
   * `folderId`, or at the project root (no parent and no folder) when it is
   * `null`. A filed or un-filed item is appended after it.
   */
  async findLastPositionAtFolderLevel(
    projectId: string,
    folderId: string | null,
    tx: Prisma.TransactionClient,
  ): Promise<string | null> {
    const row = await tx.workItem.findFirst({
      where:
        folderId === null ? { projectId, folderId: null, parentId: null } : { projectId, folderId },
      orderBy: [{ position: 'desc' }, { id: 'desc' }],
      select: { position: true },
    });
    return row?.position ?? null;
  },

  async lockById(id: string, tx: Prisma.TransactionClient): Promise<{ id: string } | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "work_item" WHERE "id" = ${id} FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  /**
   * Write one repo NAME onto many items — the pin half of MOTIR-1913's resolution,
   * applied to ids the caller has already locked and validated.
   *
   * `targetRepo: null` stays in the WHERE as a belt-and-suspenders guard: it costs
   * nothing, and it means that even a caller that skipped the lock can only ever
   * fill a hole, never overwrite an explicit pin. Returns the number of rows
   * actually written, which is what makes a re-run OBSERVABLY a no-op rather than
   * assumed to be one.
   */
  async pinTargetRepoByIds(
    ids: string[],
    targetRepo: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await tx.workItem.updateMany({
      where: { id: { in: ids }, targetRepo: null },
      data: { targetRepo },
    });
    return result.count;
  },

  /**
   * Every row in a project that still MISSES at least one provenance source —
   * the read half of the MOTIR-1758 backfill, projected to exactly the evidence
   * `lib/workItems/provenanceBackfill.ts` classifies on.
   *
   * `hasLinkedPr` is derived from the item's DELIVERY set by taking at most ONE
   * row (`take: 1`) rather than counting them: the classifier only asks whether
   * any pull request delivers this card, and a bounded take keeps the projection
   * flat regardless of how many it accumulated. It read the 7.10.3
   * `GithubPullRequest` mirror through the singular FK until MOTIR-3757 dropped
   * that column; the value is unchanged for every row, because the EXPAND
   * migration backfilled one delivery per stored link.
   *
   * ARCHIVED rows are deliberately INCLUDED. Archive is a reversible
   * soft-remove — the item still exists, is still readable on the archived
   * surface, and still renders a Provenance section — so excluding it would
   * leave a hole the backfill can never fill again once it is unarchived. The
   * service reports the archived split so the operator sees what is being
   * touched. `workspaceId`-gated (finding #26) and read-only → `db` singleton,
   * with an optional `tx` for the dry-run/real run sharing one context.
   */
  async findProvenanceBackfillCandidates(
    projectId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<
    Array<{
      id: string;
      identifier: string;
      createdAt: Date;
      status: string;
      type: WorkItemType | null;
      executor: Executor | null;
      planningSource: WorkItemPlanningSource | null;
      implementationSource: WorkItemImplementationSource | null;
      sessionBranch: string | null;
      archivedAt: Date | null;
      deliveries: Array<{ id: string }>;
    }>
  > {
    return (tx ?? dbRead).workItem.findMany({
      where: {
        projectId,
        workspaceId,
        OR: [{ planningSource: null }, { implementationSource: null }],
      },
      select: {
        id: true,
        identifier: true,
        createdAt: true,
        status: true,
        type: true,
        executor: true,
        planningSource: true,
        implementationSource: true,
        sessionBranch: true,
        archivedAt: true,
        deliveries: { select: { id: true }, take: 1 },
      },
      orderBy: { key: 'asc' },
    });
  },

  /**
   * Stamp ONE planning source onto many items — the write half of the
   * MOTIR-1758 backfill, mirroring `pinTargetRepoByIds`' shape exactly.
   *
   * `planningSource: null` stays in the WHERE as the idempotence guard, and it
   * is doing real work here rather than belt-and-braces: it is what makes the
   * whole backfill safe to re-run and race-safe WITHOUT a row lock. A row that
   * gained provenance between the sweep read and this write simply falls out of
   * the update, so a concurrent MCP create can never be overwritten and a second
   * consecutive run writes zero rows. Returning the affected count is what makes
   * that no-op OBSERVABLE rather than merely assumed.
   */
  async backfillPlanningSourceByIds(
    ids: string[],
    source: WorkItemPlanningSource,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await tx.workItem.updateMany({
      where: { id: { in: ids }, planningSource: null },
      data: { planningSource: source },
    });
    return result.count;
  },

  /**
   * Stamp ONE implementation source onto many items — the implementation twin
   * of {@link backfillPlanningSourceByIds}, with the same null-guarded
   * idempotence contract. Only ever called with `byok` / `manual`: `hosted` is
   * unreachable from self-reported evidence by design (the ADR), so the
   * backfill has no path that produces it.
   */
  async backfillImplementationSourceByIds(
    ids: string[],
    source: WorkItemImplementationSource,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await tx.workItem.updateMany({
      where: { id: { in: ids }, implementationSource: null },
      data: { implementationSource: source },
    });
    return result.count;
  },

  async findByIdentifier(
    projectId: string,
    identifier: string,
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItem | null> {
    const client = tx ?? dbRead;
    return client.workItem.findUnique({
      where: { projectId_identifier: { projectId, identifier } },
    });
  },

  /**
   * Batched form of {@link findByIdentifier} — resolve MANY bare project keys
   * (`PROD-1`, `PROD-7`, …) to their work items within ONE project in a single
   * round-trip (Subtask 5.8.3, the auto-relate-on-mention key resolution). Bare
   * references are single-project by construction (the key parser only matches
   * the source project's prefix), so this is project-scoped, not workspace-wide.
   * Unresolved keys simply don't come back. Takes an optional `tx` so it joins
   * the write transaction it feeds; empty input short-circuits to `[]`.
   */
  async findByIdentifiers(
    projectId: string,
    identifiers: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItem[]> {
    if (identifiers.length === 0) return [];
    const client = tx ?? dbRead;
    return client.workItem.findMany({
      where: { projectId, identifier: { in: identifiers } },
    });
  },

  /**
   * Re-derive every work item's denormalized `identifier` for a project after a
   * key change (Story 6.8 · `changeKey`). The identifier is derived data —
   * `<project key>-<key number>` — so a rename is a single in-place bulk UPDATE,
   * NOT a per-row loop and NOT a revision-generating mutation (the `key` number
   * is untouched; only the prefix changes). ONE statement keyed on `projectId`,
   * index-maintained by the `@@unique([projectId, identifier])` index, so it is
   * bounded even on a 10k-issue project — this IS the "re-index", synchronous
   * and atomic, where Jira would kick off a background Lucene job (ours reads the
   * denormalized column, so there is no external index to rebuild). `"key"` is
   * cast to text for the concatenation. Returns the row count. Write → `tx`
   * required (it runs inside the FOR-UPDATE-locked rename transaction).
   */
  async rewriteIdentifiersForProject(
    projectId: string,
    newKey: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.$executeRaw`
      UPDATE "work_item"
      SET "identifier" = ${newKey} || '-' || "key"::text
      WHERE "projectId" = ${projectId}
    `;
  },

  /**
   * Bulk-read work items by id in a single `IN (...)` round-trip (Subtask
   * 1.4.4). Rows come back in Postgres' arbitrary order — service callers
   * (`getBlockers` / `getBlocking`) re-sort if they need a specific order.
   * This is the N+1-avoidance leg of the blocker/blocking resolution: one
   * link-table query yields the ids, this resolves them all at once.
   * Read-only path → `db` singleton. Empty input short-circuits to `[]` so
   * we never issue a degenerate `IN ()`.
   */
  /**
   * The subset of `ids` that are work items of `projectId`, archived ones
   * INCLUDED — the same-project filter a page's derived links pass through
   * (MOTIR-7571, `docs/decisions/pages.md` §8.1). Runs inside the page save's
   * transaction. An empty input short-circuits to `[]`.
   */
  async findIdsInProject(
    projectId: string,
    ids: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await tx.workItem.findMany({
      where: { projectId, id: { in: [...ids] } },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  },

  async findByIds(ids: string[], tx?: Prisma.TransactionClient): Promise<WorkItem[]> {
    if (ids.length === 0) return [];
    const client = tx ?? dbRead;
    return client.workItem.findMany({ where: { id: { in: ids } } });
  },

  /**
   * Resolve many work items by id WITHIN one workspace, INCLUDING archived ones
   * (no `archivedAt` filter) — the batched read behind plan-staleness detection
   * (7.21.3 / MOTIR-1340), which must distinguish "still live" from "archived /
   * gone" for a plan's referenced parents, blockers, and modify/remove targets
   * in ONE round-trip (no N+1). Workspace-scoped (the explicit finding-#26
   * tenant gate, since RLS is inert under the dev/CI superuser) so a cross-tenant
   * id simply doesn't come back. Read-only path → `db` singleton. Empty input
   * short-circuits to `[]` so we never issue a degenerate `IN ()`.
   */
  async findByIdsInWorkspace(
    ids: string[],
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItem[]> {
    if (ids.length === 0) return [];
    const client = tx ?? dbRead;
    return client.workItem.findMany({ where: { id: { in: ids }, workspaceId } });
  },

  /**
   * Every non-archived work item in a WORKSPACE where the actor is the
   * ASSIGNEE **or** the REPORTER — the My work read (Story MOTIR-2649 ·
   * Subtask MOTIR-2651). The first list read in this repository that is scoped
   * by PERSON across projects rather than by project; every other one
   * (`findByProject*`) answers "what is in this project".
   *
   * ⚠️ ONE query with an `OR`, never two reads merged in the service. The merge
   * has to happen in the database for two reasons the AC turns into tests:
   * the **dedupe** (an item where the actor is BOTH assignee and reporter is one
   * row, and stays one row ACROSS a page boundary — a union in the service
   * would dedupe AFTER the limit, so a page of ten could silently return nine),
   * and the **cursor**, which cannot mean two positions at once.
   *
   * `projectScopes` is the actor's BROWSABLE set, resolved by `homeService`
   * through `projectAccessService` and passed IN, each project carrying its own
   * done-category keys ({@link HomeProjectScope}). It is a query input, not a
   * post-read filter, for the same paging reason: dropping rows afterwards
   * shortens pages instead of erroring, which is the failure mode nobody
   * notices — and that applies to the LIFECYCLE exclusion exactly as it does to
   * the access one (MOTIR-2758). An EMPTY set short-circuits to `[]` rather than
   * issuing a degenerate `IN ()`.
   *
   * Order is `(updatedAt DESC, id DESC)` — total and stable, so the keyset
   * cursor never repeats or drops a row. Workspace-gated explicitly
   * (finding #26; RLS is inert under the dev/CI superuser) and
   * `archivedAt`/`triagedAt`-excluded, matching every other list read.
   *
   * ⚠️ `tx` and `take` are REQUIRED — see `watcherRepository.listByUserInGroup`, whose
   * twin this is, for both reasons. The pair must stay identical: they back the
   * two tabs of one surface, and a difference between them is a difference the
   * reader would see.
   */
  async findByAssigneeOrReporterInWorkspace(
    userId: string,
    workspaceId: string,
    options: {
      projectScopes: readonly HomeProjectScope[];
      /**
       * WHICH lifecycle slice this read is for. One read per Workbench tab, all
       * sharing the membership `OR` above it.
       */
      slice: HomeCategorySlice;
      take: number;
      /** How many rows to skip — `(page - 1) * pageSize`, computed by the service. */
      skip?: number;
      /**
       * The axis to order by. `completedAt` for the finished window, `updatedAt`
       * for everything else — the discriminator {@link homeOrderBy} reads to
       * choose between the time order and the KIND order.
       */
      sortField?: HomeSortField;
      /**
       * The FINISHED WINDOW: only rows whose `sortField` is at or after this
       * moment. Applied IN SQL, never after the read — a post-read filter
       * shortens pages instead of failing, and "the list sometimes ends early"
       * is a bug nobody traces back to a date comparison.
       */
      since?: Date;
    },
    tx: Prisma.TransactionClient,
  ): Promise<HomeWorkItemRow[]> {
    const { projectScopes, slice, take, skip = 0, sortField = 'updatedAt', since } = options;
    if (projectScopes.length === 0) return [];
    return tx.workItem.findMany({
      // The predicate is {@link homeMembershipWhere}'s — the ONE place it is
      // written, shared with the count and the watermark beside it.
      where: homeMembershipWhere(userId, workspaceId, projectScopes, { slice, since, sortField }),
      select: HOME_WORK_ITEM_SELECT,
      // TO FIX orders by REASON first (design § 30, _Order_): the enum's declaration
      // order IS the priority (`FIX_REASON_PRIORITY`), and Postgres sorts an enum by
      // it — then the work tabs' kind order within a reason. In the read, never on
      // the client, so the page boundary stays exact.
      orderBy:
        slice.fixReason === 'set'
          ? [{ fixReason: 'asc' }, ...homeOrderBy(sortField)]
          : homeOrderBy(sortField),
      skip,
      take,
    });
  },

  /**
   * How many work items a workspace holds, ARCHIVED AND TRIAGED ONES INCLUDED —
   * the erasure impact preview's "the work inside them" number (MOTIR-3699),
   * read per sole-membership workspace.
   *
   * ⚠️ THE ABSENT FILTERS ARE THE DECISION. Every neighbouring read in this file
   * excludes `archivedAt` / `triagedAt` rows because it is answering "what is
   * live?". This one answers "what does deletion REACH?", and deleting the
   * workspace takes archived and untriaged rows with it. The ledger sits under
   * *"this cannot be undone"*, so a number that quietly omitted rows would be
   * understating a loss on the one screen that exists to state it.
   *
   * `tx` REQUIRED: `work_item_active_workspace` gates on `app.workspace_id`.
   */
  async countByWorkspace(workspaceId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.workItem.count({ where: { workspaceId } });
  },

  /**
   * How many of a workspace's work items carry this user's ATTRIBUTION — they
   * reported it, or they are assigned it (MOTIR-3699). The erasure preview's
   * `anonymised` number for a SHARED workspace: the item stays with its project,
   * the attribution goes.
   *
   * ⚠️ ONE ROW COUNTS ONCE. An item a user both reported AND is assigned is one
   * row losing one attribution pair, and the design's ledger renders ONE number
   * for it — so the predicate is an `OR` over one `count`, never the sum of two
   * counts.
   *
   * Unfiltered by `archivedAt` / `triagedAt` for the same reason
   * {@link countByWorkspace} is: erasure reaches the attribution on every row
   * that carries it, whether or not the row is live.
   *
   * `tx` REQUIRED — same policy as above.
   */
  async countByReporterOrAssigneeInWorkspace(
    userId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    return tx.workItem.count({
      where: { workspaceId, OR: [{ reporterId: userId }, { assigneeId: userId }] },
    });
  },

  /**
   * How many items the My work read would return — the tab's count badge
   * (Subtask MOTIR-2653). Same predicate as
   * {@link findByAssigneeOrReporterInWorkspace} MINUS the keyset, so the number
   * beside the tab is the number the tab will show rather than the number on
   * the current page. Empty browsable set short-circuits.
   *
   * ⚠️ "Same predicate" includes the done-category exclusion: a count that
   * disagrees with its list is a badge that lies, which is the shape MOTIR-2758
   * was filed about (the badge read ~2 019 where the answer was ~263).
   */
  async countByAssigneeOrReporterInWorkspace(
    userId: string,
    workspaceId: string,
    projectScopes: readonly HomeProjectScope[],
    options: HomeMembershipOptions,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    if (projectScopes.length === 0) return 0;
    return tx.workItem.count({
      where: homeMembershipWhere(userId, workspaceId, projectScopes, options),
    });
  },

  /**
   * THE WHOLE SLICE of a grouped Workbench work tab — To do, In progress or Recently
   * finished — as six narrow fields per item (Story MOTIR-8012 · MOTIR-8014).
   *
   * ⚠️ UNWINDOWED, BECAUSE GROUPING MUST SEE EVERY MEMBER BEFORE IT CAN CUT A PAGE: a
   * group ranks by its BEST member, and that member can sit anywhere in the tab. The
   * service groups these rows in memory, cuts a page of whole groups, and reads full
   * rows for that page only — the two-step shape To fix uses
   * ({@link listToFixGroupKeysByAssigneeOrReporterInWorkspace}). Bounded by what it
   * reads: the reader's own items in the active project, six narrow columns.
   *
   * The `where` is {@link homeMembershipWhere}'s — the FOURTH reader of it, after the
   * list, the count and the watermark — so the set is the tab's set, row for row. The
   * order is `homeOrderBy`'s, only so the read is stable; the service re-ranks.
   */
  async listHomeGroupingRowsByAssigneeOrReporterInWorkspace(
    userId: string,
    workspaceId: string,
    projectScopes: readonly HomeProjectScope[],
    options: HomeMembershipOptions,
    tx: Prisma.TransactionClient,
  ): Promise<HomeGroupingRow[]> {
    if (projectScopes.length === 0) return [];
    return tx.workItem.findMany({
      where: homeMembershipWhere(userId, workspaceId, projectScopes, options),
      select: {
        id: true,
        parentId: true,
        kind: true,
        priority: true,
        key: true,
        completedAt: true,
      },
      orderBy: homeOrderBy(options.sortField ?? 'updatedAt'),
    });
  },

  /**
   * TO FIX's ENTRY KEYS, in the tab's order (MOTIR-7589; `design/workbench/design-notes.md`
   * § 34.2) — every card on the reader's To fix slice, as `{ id, fixDetail }` only.
   *
   * The tab lists, pages and counts ENTRIES — cards stuck for one reason that one repair
   * clears — so the service groups these by `fixGroupKeyOf` before it pages. The read is
   * {@link homeMembershipWhere}'s over {@link HOME_SLICE_TO_FIX}, the SAME predicate the
   * card count used, so which cards are on the tab (and the In progress / To fix
   * partition) is unchanged card for card; only the unit the pager counts moves.
   *
   * ⚠️ UNWINDOWED, and that is bounded by what it reads: the reader's stuck cards in one
   * project, two narrow columns. The order is the card list's own — reason priority,
   * then the work tabs' kind order, then `id` — so an entry sits where its first card did.
   */
  async listToFixGroupKeysByAssigneeOrReporterInWorkspace(
    userId: string,
    workspaceId: string,
    projectScopes: readonly HomeProjectScope[],
    tx: Prisma.TransactionClient,
  ): Promise<{ id: string; fixDetail: Prisma.JsonValue | null }[]> {
    if (projectScopes.length === 0) return [];
    return tx.workItem.findMany({
      where: homeMembershipWhere(userId, workspaceId, projectScopes, { slice: HOME_SLICE_TO_FIX }),
      select: { id: true, fixDetail: true },
      orderBy: [{ fixReason: 'asc' }, ...homeOrderBy('updatedAt')],
    });
  },

  /**
   * TO RESUME's ENTRY KEYS, in the tab's order (Story MOTIR-7701 · MOTIR-7707) — every
   * card on the reader's To resume slice, as `{ id, resumeRunId }`. The tab lists one
   * entry per gated RUN, as To fix does per dead run, so the service groups these by
   * `resumeRunId` before it pages. Unwindowed for the reason To fix's is.
   */
  async listToResumeRunKeysByAssigneeOrReporterInWorkspace(
    userId: string,
    workspaceId: string,
    projectScopes: readonly HomeProjectScope[],
    tx: Prisma.TransactionClient,
  ): Promise<{ id: string; resumeRunId: string | null }[]> {
    if (projectScopes.length === 0) return [];
    return tx.workItem.findMany({
      where: homeMembershipWhere(userId, workspaceId, projectScopes, {
        slice: HOME_SLICE_TO_RESUME,
      }),
      select: { id: true, resumeRunId: true },
      orderBy: homeOrderBy('updatedAt'),
    });
  },

  /**
   * Every card waiting on one of these gated runs — whoever holds it, in the given
   * projects (Story MOTIR-7701 · MOTIR-7707). An entry's members are every card the
   * run carried, and the reader holds only some of them. Archived and triaged rows
   * are excluded, like every list read.
   */
  async findResumeMembers(
    workspaceId: string,
    projectIds: readonly string[],
    runIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<HomeWorkItemRow[]> {
    if (projectIds.length === 0 || runIds.length === 0) return [];
    return tx.workItem.findMany({
      where: {
        workspaceId,
        projectId: { in: [...projectIds] },
        archivedAt: null,
        triagedAt: null,
        fixReason: null,
        resumeState: { not: null },
        resumeRunId: { in: [...runIds] },
      },
      select: HOME_WORK_ITEM_SELECT,
      orderBy: homeOrderBy('updatedAt'),
    });
  },

  /**
   * The LIVE, not-finished children of these gated runs' scope containers (MOTIR-8458) —
   * what a continue over a scope run would carry (`recordHeldGates` walks the scope's
   * live children), whoever holds them. A card a plan added under the scope after the
   * run stopped never carries the run's `resumeRunId`, so {@link findResumeMembers}
   * alone cannot see it. `parentId` rides back so the caller can file each child under
   * its entry. Archived and triaged rows are excluded, like every list read.
   */
  async findResumeScopeChildren(
    workspaceId: string,
    projectScopes: readonly HomeProjectScope[],
    parentIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<(HomeWorkItemRow & { parentId: string | null })[]> {
    if (projectScopes.length === 0 || parentIds.length === 0) return [];
    return tx.workItem.findMany({
      where: {
        workspaceId,
        parentId: { in: [...parentIds] },
        archivedAt: null,
        triagedAt: null,
        AND: [homeProjectScopeWhere(projectScopes, HOME_SLICE_UNFINISHED)],
      },
      select: { ...HOME_WORK_ITEM_SELECT, parentId: true },
      orderBy: homeOrderBy('updatedAt'),
    });
  },

  /**
   * EVERY child id of these containers, archived ones included (MOTIR-8458) — the
   * cards a plan may have added, changed or removed under a gated run's scope. A
   * removed child is archived, so the live read above cannot name it.
   */
  async findChildIdsByParents(
    parentIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<{ id: string; parentId: string | null }[]> {
    if (parentIds.length === 0) return [];
    return tx.workItem.findMany({
      where: { parentId: { in: [...parentIds] } },
      select: { id: true, parentId: true },
    });
  },

  /**
   * Which of these run TARGETS still wait to resume, and on which run (MOTIR-8011) —
   * whoever holds them, in the given projects. The same predicate as
   * `findResumeMembers`, so a target this misses is one no To resume entry can be
   * headed by: on To fix (`fixReason` set), or with its stored run replaced by a newer
   * one.
   */
  async findWaitingResumeTargets(
    workspaceId: string,
    projectIds: readonly string[],
    ids: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<{ id: string; resumeRunId: string | null }[]> {
    if (projectIds.length === 0 || ids.length === 0) return [];
    return tx.workItem.findMany({
      where: {
        id: { in: [...ids] },
        workspaceId,
        projectId: { in: [...projectIds] },
        archivedAt: null,
        triagedAt: null,
        fixReason: null,
        resumeState: { not: null },
      },
      select: { id: true, resumeRunId: true },
    });
  },

  /**
   * The ids of every STUCK card in these To fix entries (MOTIR-7589; § 34.2) — whoever
   * holds them, in the given projects. An entry's members are the cards one dead run
   * carried, or every card one pull-request set delivers, and the reader holds only some
   * of them; the member list draws the rest.
   *
   * Raw, because the predicate is the JSON expression `work_item_fix_group_key_idx`
   * indexes (`"fixDetail" ->> 'groupKey'`), which Prisma's JSON filter does not render
   * as. Workspace-gated, and archived / triaged rows excluded, like every list read.
   */
  async findFixGroupMemberIds(
    workspaceId: string,
    projectIds: readonly string[],
    groupKeys: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<{ id: string }[]> {
    if (projectIds.length === 0 || groupKeys.length === 0) return [];
    return tx.$queryRaw<{ id: string }[]>`
      SELECT w."id"
        FROM "work_item" w
       WHERE w."workspaceId" = ${workspaceId}
         AND w."fixReason" IS NOT NULL
         AND (w."fixDetail" ->> 'groupKey') = ANY(${[...groupKeys]}::text[])
         AND w."projectId" = ANY(${[...projectIds]}::text[])
         AND w."archivedAt" IS NULL
         AND w."triagedAt" IS NULL`;
  },

  /**
   * The stored to-fix answer of these cards, by id (MOTIR-7589) — what the tag's
   * *· with {head}* name needs on a list or board whose rows carry `fixReason` only.
   * Callers pass only the ids already showing a reason.
   */
  async findFixStateByIds(
    workspaceId: string,
    ids: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<
    {
      id: string;
      projectId: string;
      fixReason: WorkItemFixReason | null;
      fixDetail: Prisma.JsonValue | null;
    }[]
  > {
    if (ids.length === 0) return [];
    return tx.workItem.findMany({
      where: { workspaceId, id: { in: [...ids] } },
      select: { id: true, projectId: true, fixReason: true, fixDetail: true },
    });
  },

  /**
   * Workbench rows BY ID (MOTIR-7589) — the members and heads of a page of To fix
   * entries, AND (MOTIR-8014) the page rows and context heads of the grouped work
   * tabs (To do, In progress, Recently finished), in the shared {@link HOME_WORK_ITEM_SELECT} projection plus `parentId`
   * (the head rule follows ancestry). Workspace-gated; archived and triaged rows
   * excluded, so a card that left since the keys were read is simply not returned.
   */
  async findHomeRowsByIds(
    workspaceId: string,
    ids: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<(HomeWorkItemRow & { parentId: string | null })[]> {
    if (ids.length === 0) return [];
    return tx.workItem.findMany({
      where: { workspaceId, id: { in: [...ids] }, archivedAt: null, triagedAt: null },
      select: { ...HOME_WORK_ITEM_SELECT, parentId: true },
    });
  },

  /**
   * THE WATERMARK over one Workbench work tab (Story MOTIR-5238 · MOTIR-5240) —
   * how many rows the tab holds, and the most recent `updatedAt` among them, in
   * ONE query.
   *
   * ⚠️ TWO NUMBERS, BECAUSE NEITHER ONE ALONE IS A CHANGE DETECTOR. A count
   * moves on an arrival and on a departure and stays put when a row is EDITED
   * in place — which is exactly the case the story is about, a decision's
   * subject moving under a reader who is holding it open. A maximum moves on an
   * edit and on an arrival and stays put when a row LEAVES. Together they move
   * whenever the tab's rendered content can differ, which is the property the
   * stream rests on.
   *
   * ⚠️ AND IT IS AN `aggregate`, NOT A COUNT PLUS A SEPARATE MAX. This read runs
   * once a second per open Workbench, so a second round trip per tab is a
   * standing cost rather than a tidiness question; `_count` and `_max` over one
   * `where` are one statement to Postgres.
   *
   * The predicate is {@link homeMembershipWhere}'s, shared with the list and the
   * count — see that function for why the sharing is load-bearing here rather
   * than merely tidy. An empty scope short-circuits to the same answer an empty
   * set would give, without issuing a degenerate query.
   */
  async watermarkByAssigneeOrReporterInWorkspace(
    userId: string,
    workspaceId: string,
    projectScopes: readonly HomeProjectScope[],
    options: HomeMembershipOptions,
    tx: Prisma.TransactionClient,
  ): Promise<{ count: number; latest: Date | null }> {
    if (projectScopes.length === 0) return { count: 0, latest: null };
    const row = await tx.workItem.aggregate({
      where: homeMembershipWhere(userId, workspaceId, projectScopes, options),
      _count: { _all: true },
      _max: { updatedAt: true },
    });
    return { count: row._count._all, latest: row._max.updatedAt ?? null };
  },

  /**
   * Minimal STUBS for the roadmap's off-level blockers (Subtask 7.20.2 /
   * MOTIR-1331) — an `is_blocked_by` blocker that lives on ANOTHER level has no
   * node on screen, so the canvas anchors a red edge to a chip that NAMES it: its
   * `identifier` + `title` + the title of the container it lives in (its parent
   * story/epic). ONE query with the parent relation; empty input → `[]`.
   *
   * ⚠️ `parentId` RIDES ALONG BECAUSE "OFF THIS LEVEL" IS NOT THE SAME QUESTION AS
   * "NOT AMONG THE ROWS WE FETCHED" (bug MOTIR-5043). The level read is CAPPED at
   * `TREE_LEVEL_MAX_TAKE`, key-ASCENDING, so a level past the cap loses its
   * highest keys — and a blocker that is a genuine SIBLING of the row it blocks then
   * arrives here and is named as a cross-story anchor. The parent TITLE cannot settle
   * it (two levels can share a parent title, and the root level's is `null`), so the
   * `parentId` SCALAR is selected beside it: the caller compares it against the level's
   * own parent and keeps the members apart from the strangers. It costs nothing —
   * `parent_id` is already a column on the row this query returns. `folderId`
   * rides along for the same reason once folders are levels (Bug MOTIR-5710): a
   * FILED root has a null parent too, and it is a member of its folder's level,
   * not of the root's. `kind` rides along for the off-level edge's DISPOSITION
   * (MOTIR-6359): the level rule pairs an epic only with an epic, so the canvas
   * cannot tell a cross-level edge from a covered one without it.
   */
  async findRoadmapBlockerStubs(
    ids: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<
    Array<{
      id: string;
      identifier: string;
      title: string;
      kind: string;
      parentId: string | null;
      folderId: string | null;
      parentTitle: string | null;
      status: string;
      sprintId: string | null;
    }>
  > {
    if (ids.length === 0) return [];
    const client = tx ?? dbRead;
    const rows = await client.workItem.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        identifier: true,
        title: true,
        kind: true,
        status: true,
        sprintId: true,
        parentId: true,
        folderId: true,
        parent: { select: { title: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      identifier: r.identifier,
      title: r.title,
      kind: r.kind,
      parentId: r.parentId,
      folderId: r.folderId,
      parentTitle: r.parent?.title ?? null,
      status: r.status,
      sprintId: r.sprintId,
    }));
  },

  /**
   * The EFFECTIVE folder of each work item in `ids` (Bug MOTIR-5710 ·
   * MOTIR-5739) — its own `folderId`, else its ROOT ancestor's — so the roadmap
   * can name the folder an OFF-level blocker is filed in. ONE query for the whole
   * set, whatever its size, through the same {@link EFFECTIVE_FOLDER_SQL} the
   * Folder filter compiles to, so the anchor and the filter can never disagree
   * about where an item lives. An unfiled chain reads `null`.
   */
  async findEffectiveFolderIds(
    ids: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<Array<{ id: string; folderId: string | null }>> {
    if (ids.length === 0) return [];
    return tx.$queryRaw<Array<{ id: string; folderId: string | null }>>`
      SELECT w."id", ${EFFECTIVE_FOLDER_SQL} AS "folderId"
        FROM "work_item" w
       WHERE w."id" IN (${Prisma.join([...ids])})`;
  },

  /**
   * Every work item currently recorded on a given session branch within a
   * workspace (Subtask 7.8.11) — the read backing `complete_session`'s bulk
   * close-out. Workspace-scoped (the explicit finding-#26 tenant gate, since RLS
   * is inert under the dev/CI superuser) and ordered by `key` so the bulk flip +
   * its per-item result list are deterministic. Rides the
   * `work_item_sessionBranch` index. Read-only path → `db` singleton.
   */
  async findBySessionBranch(
    sessionBranch: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItem[]> {
    const client = tx ?? dbRead;
    return client.workItem.findMany({
      where: { sessionBranch, workspaceId },
      orderBy: { key: 'asc' },
    });
  },

  /**
   * The ids of every NON-ARCHIVED card sitting on one of these session branches —
   * {@link findBySessionBranch} for a batch, in one query (MOTIR-5472).
   *
   * The CI-state backfill's session arm: it holds a whole workspace's head refs
   * and wants the cards on any of them, which as N separate reads would be one
   * query per pull request in the tenant. Ids only, because its caller hands each
   * one to the recompute and re-reads the row under that card's own lock.
   *
   * ⚠️ The caller must have BOUND the workspace — `work_item` has no
   * `system_admin` arm, so an unbound read returns zero rows and raises nothing.
   * `workspaceId` is still in the predicate rather than left to the GUC alone:
   * the binding admits the read, the column is what scopes it.
   */
  async listIdsBySessionBranches(
    sessionBranches: readonly string[],
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<string[]> {
    if (sessionBranches.length === 0) return [];
    const rows = await tx.workItem.findMany({
      where: {
        workspaceId,
        archivedAt: null,
        sessionBranch: { in: [...sessionBranches] },
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((r) => r.id);
  },

  /**
   * The `fixReason` BACKFILL's candidates in one workspace (Story MOTIR-6588 ·
   * MOTIR-6603), ordered by id: every card whose status is in the `in_progress`
   * CATEGORY (archived ones INCLUDED, so the sweep can count its abstention), plus
   * every card still carrying a non-null `fixReason` whatever its status, so a
   * stale reason on a card that has since left the category is cleared too.
   *
   * The category is joined from `workflow_status` on the card's own project and
   * status key — statuses are per-project vocabulary, so a hardcoded key list would
   * miss a customer's own in-progress statuses. Raw because Prisma has no relation
   * between `work_item.status` and `workflow_status`. `work_item` has no system arm:
   * the caller binds `workspaceId` first, or this returns nothing.
   */
  async listFixReasonBackfillCandidateIds(
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<string[]> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT w."id"
        FROM "work_item" w
        LEFT JOIN "workflow_status" s
          ON s."project_id" = w."projectId" AND s."key" = w."status"
       WHERE w."workspaceId" = ${workspaceId}
         AND (s."category" = 'in_progress' OR w."fixReason" IS NOT NULL)
       ORDER BY w."id" ASC`);
    return rows.map((r) => r.id);
  },

  /**
   * The To resume backfill's candidates (Story MOTIR-7701 · MOTIR-7707) — the fix-reason
   * backfill's set over the other column: every card in an `in_progress`-CATEGORY status,
   * plus any card still carrying a `resumeState`, so a stale one is cleared. The caller
   * binds `workspaceId` first.
   */
  async listResumeStateBackfillCandidateIds(
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<string[]> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT w."id"
        FROM "work_item" w
        LEFT JOIN "workflow_status" s
          ON s."project_id" = w."projectId" AND s."key" = w."status"
       WHERE w."workspaceId" = ${workspaceId}
         AND (s."category" = 'in_progress' OR w."resumeState" IS NOT NULL)
       ORDER BY w."id" ASC`);
    return rows.map((r) => r.id);
  },

  /**
   * WHICH REPOSITORIES HAS EACH OF THESE PROJECTS NAMED ON ITS WORK — the
   * evidence that a project has CHOSEN a repository rather than merely being
   * allowed to reach one (MOTIR-4821).
   *
   * ⚠️ THIS IS NOT THE SCOPE LADDER AND MUST NOT BECOME ONE.
   * `lib/projectRepos/effectiveDomain.ts` answers *which repositories MAY this
   * project reach*, and its first rung hands a set-less project the whole
   * connected registry as a PERMISSIVE DEFAULT. Read backwards it says every
   * empty project uses every repository, which is how the organisation's
   * `Used by N projects` column came to name a scratch project against all seven
   * (MOTIR-4802's fix, inverted one surface over). This read answers a different
   * question with its own evidence: a repository NAME the project actually put on
   * a work item. A project with a set expresses the same choice as a
   * `project_repository` row, so the caller unions the two — see
   * `organizationRepoService.listRepositoryUsage`.
   *
   * `targetRepos` is the array and `targetRepo` IS `targetRepos[0]`, but both are
   * read: rows written before the array existed carry only the scalar, and a
   * dropped name is a project silently missing from a DISCONNECT dialogue.
   *
   * Returns the names AS STORED, de-duplicated per project. Normalizing them to
   * the comparable identity is the caller's job (`repoNameKey`) — this method
   * does not know which spelling the `github_repo` row it will be matched against
   * uses, and a repository whose name reaches this list is a handful of distinct
   * strings per project however many work items name it.
   *
   * `workspaceId` is filtered explicitly alongside the project ids (finding #26 —
   * RLS is inert under the dev/CI superuser), so a caller cannot read one
   * workspace's work by binding another. Empty `projectIds` short-circuits.
   */
  async listRepoNamesByProject(
    workspaceId: string,
    projectIds: readonly string[],
    tx: Prisma.TransactionClient,
  ): Promise<Map<string, string[]>> {
    const byProject = new Map<string, string[]>();
    if (projectIds.length === 0) return byProject;
    const rows = await tx.$queryRaw<Array<{ projectId: string; repoName: string }>>`
      SELECT DISTINCT "projectId", "repoName"
      FROM (
        SELECT w."projectId", unnest(w."targetRepos") AS "repoName"
        FROM "work_item" w
        WHERE w."projectId" = ANY(${[...projectIds]}::text[])
          AND w."workspaceId" = ${workspaceId}
        UNION ALL
        SELECT w."projectId", w."targetRepo" AS "repoName"
        FROM "work_item" w
        WHERE w."projectId" = ANY(${[...projectIds]}::text[])
          AND w."workspaceId" = ${workspaceId}
          AND w."targetRepo" IS NOT NULL
      ) named
      WHERE "repoName" IS NOT NULL AND btrim("repoName") <> ''
    `;
    for (const row of rows) {
      const list = byProject.get(row.projectId) ?? [];
      list.push(row.repoName);
      byProject.set(row.projectId, list);
    }
    return byProject;
  },

  /**
   * One LAYER of the top-down ready traversal (Subtask 7.0.13): the project's
   * non-archived, non-triage work items at a single parent level — the ROOTS
   * (`parentIds === null` → `parentId IS NULL`) or the direct children of a set
   * of parents (`parentId = ANY(parentIds)`). Each row carries its live status
   * `category` and a `hasChildren` flag, so the service can decide per row:
   * DESCEND into a ready container (`hasChildren`), or COLLECT a ready childless
   * `todo` leaf into the dispatch set.
   *
   * This is the read that replaces the whole-table `findReadyCandidates` scan in
   * the ready LIST path: the traversal only ever fetches the children of nodes
   * already known to be ready, so a not-ready or fully-planned-out branch is
   * never read. No status/leaf pre-filter here (the service applies the
   * cascade + leaf rule); only the structural + tenant + archive/triage gates.
   * `workspaceId` is filtered explicitly (finding #26 — RLS inert under the
   * dev/CI superuser). Read-only → `db` singleton. Empty `parentIds` short-
   * circuits to `[]` (no degenerate `= ANY('{}')`).
   */
  async findReadyLayer(
    projectId: string,
    workspaceId: string,
    parentIds: string[] | null,
    tx?: Prisma.TransactionClient,
  ): Promise<ReadyLayerRow[]> {
    if (parentIds !== null && parentIds.length === 0) return [];
    const parentPred =
      parentIds === null
        ? Prisma.sql`w."parentId" IS NULL`
        : Prisma.sql`w."parentId" = ANY(${parentIds})`;
    const client = tx ?? dbRead;
    return client.$queryRaw<ReadyLayerRow[]>`
      SELECT w.*,
             ws."category"::text AS "statusCategory",
             au."name"           AS "assigneeName",
             au."email"          AS "assigneeEmail",
             au."image"          AS "assigneeImage",
             EXISTS (
               SELECT 1 FROM "work_item" c
                WHERE c."parentId" = w."id"
                  AND c."archivedAt" IS NULL
             )                   AS "hasChildren"
        FROM "work_item" w
        LEFT JOIN "workflow_status" ws
              ON ws."project_id" = w."projectId" AND ws."key" = w."status"
        LEFT JOIN "user" au ON au."id" = w."assigneeId"
        WHERE w."projectId" = ${projectId}
          AND w."workspaceId" = ${workspaceId}
          AND w."archivedAt" IS NULL
          AND ${notInTriageSql('w')}
          AND ${parentPred}`;
  },

  /**
   * The container SHAPES of a set of parents (Story MOTIR-6829 · MOTIR-6830) —
   * ONE query for any number of ids, so partitioning a ready page into lanes
   * costs one read bounded by its distinct parents, never one per row.
   *
   * The child tests read `archivedAt IS NULL` exactly as `findReadyLayer`'s
   * `hasChildren` does, so "is this a container" and "is its child a leaf" are
   * answered by the same predicate the walk used. `workspaceId` is filtered
   * explicitly (finding #26). Empty input short-circuits to `[]`.
   */
  async findContainerShapes(
    parentIds: string[],
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<ReadyContainerShapeRow[]> {
    if (parentIds.length === 0) return [];
    const client = tx ?? dbRead;
    return client.$queryRaw<ReadyContainerShapeRow[]>`
      SELECT p."id",
             p."identifier",
             p."key",
             p."kind",
             p."title",
             p."priority",
             p."sprintId",
             p."assigneeId",
             au."name"  AS "assigneeName",
             au."email" AS "assigneeEmail",
             au."image" AS "assigneeImage",
             (SELECT count(*)::int FROM "work_item" c
               WHERE c."parentId" = p."id" AND c."archivedAt" IS NULL) AS "childCount",
             EXISTS (
               SELECT 1 FROM "work_item" c
                 JOIN "work_item" g ON g."parentId" = c."id" AND g."archivedAt" IS NULL
                WHERE c."parentId" = p."id" AND c."archivedAt" IS NULL
             ) AS "hasGrandchildren"
        FROM "work_item" p
        LEFT JOIN "user" au ON au."id" = p."assigneeId"
       WHERE p."id" = ANY(${parentIds})
         AND p."workspaceId" = ${workspaceId}`;
  },

  /**
   * Childless expandable STUBS (Subtask 7.11.7 / MOTIR-904) — epics and stories
   * that have NO children and are NOT terminal, so expanding them would
   * replenish the ready set. Sorted by priority desc, key asc so the
   * highest-priority stub is nominated first. Excludes triage items and
   * archived rows. Read-only (db singleton, no tx).
   *
   * **Terminal is `category = 'done'` — the ONLY terminal bucket** (MOTIR-1744).
   * `status_category` is a THREE-label enum (`todo | in_progress | done`);
   * `cancelled` is a per-project status KEY whose category is `done`
   * (`lib/workflows/defaultWorkflow.ts`), so `<> 'done'` already excludes every
   * cancelled item. This predicate shipped as
   * `category NOT IN ('done', 'cancelled')`, which made Postgres fail to coerce
   * the second literal and raise `22P02 invalid input value for enum
   * status_category: "cancelled"` on EVERY call — so the /ready expansion-nudge
   * banner 500'd in exactly the drained state it exists to announce. Branch on
   * the CATEGORY, never on a per-project status key: the key set is
   * admin-customizable, the three-bucket taxonomy is not.
   */
  async findExpandableStubs(
    projectId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Array<{ identifier: string; title: string; kind: string; priority: string }>> {
    const client = tx ?? dbRead;
    return client.$queryRaw<
      Array<{ identifier: string; title: string; kind: string; priority: string }>
    >`
      SELECT w."identifier", w."title", w."kind"::text AS "kind", w."priority"::text AS "priority"
        FROM "work_item" w
        JOIN "workflow_status" ws
          ON ws."project_id" = w."projectId" AND ws."key" = w."status"
       WHERE w."projectId" = ${projectId}
         AND w."workspaceId" = ${workspaceId}
         AND w."archivedAt" IS NULL
         AND w."kind"::text IN ('epic', 'story')
         AND ws."category" <> 'done'
         AND ${notInTriageSql('w')}
         AND NOT EXISTS (
               SELECT 1 FROM "work_item" c
                WHERE c."parentId" = w."id"
                  AND c."archivedAt" IS NULL
             )
       ORDER BY w."priority" DESC, w."key" ASC
       LIMIT 5`;
  },

  /**
   * The ATOMIC claim read for `claim_next_ready` (MOTIR-1330) — the dispatch
   * race-fix. Given the service's pre-computed ready candidate ids in
   * dispatch-rank order, LOCK the highest-ranked one that is still claimable and
   * return its id, under the caller's transaction. `FOR UPDATE … SKIP LOCKED` is
   * what makes two concurrent claimers take DIFFERENT items: the loser SKIPS the
   * row another transaction already holds (rather than blocking on it), and
   * `array_position` keeps the service's rank so each caller still takes the best
   * row still available to it. A row is claimable iff it is NOT archived and its
   * status is still in the `todo` category — a sibling that already claimed it
   * flipped it to `in_progress` (category `in_progress`), dropping it out.
   * Returns `null` when every candidate is locked or no longer `todo`; the caller
   * treats that as "retry / nothing claimable". `tx` REQUIRED — this read GUARDS
   * the immediately-following status write.
   */
  async claimNextReadyCandidate(
    orderedIds: string[],
    tx: Prisma.TransactionClient,
  ): Promise<{ id: string } | null> {
    if (orderedIds.length === 0) return null;
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT w."id"
        FROM "work_item" w
        JOIN "workflow_status" ws
          ON ws."project_id" = w."projectId" AND ws."key" = w."status"
       WHERE w."id" = ANY(${orderedIds}::text[])
         AND w."archivedAt" IS NULL
         AND ws."category" = 'todo'
       ORDER BY array_position(${orderedIds}::text[], w."id")
       FOR UPDATE OF w SKIP LOCKED
       LIMIT 1`;
    return rows[0] ?? null;
  },

  /**
   * The post-lock CLAIM STATE read (MOTIR-2961) — everything a keyed claim
   * decides on, for a row the caller ALREADY holds a lock on.
   *
   * ⚠️ **THE LOCK AND THIS READ ARE TWO STATEMENTS ON PURPOSE, AND MERGING THEM
   * IS A REAL BUG.** The obvious shape is one `SELECT … JOIN workflow_status …
   * FOR UPDATE OF w`, and it silently returns ZERO ROWS under exactly the
   * concurrency it exists to handle. Under READ COMMITTED a `FOR UPDATE` that
   * WAITS on a concurrent writer re-evaluates its plan against the new row
   * version (EvalPlanQual) — and the join predicate here is
   * `ws."key" = w."status"`, i.e. it reads the very column the winner just
   * changed. The waiter therefore wakes up, re-checks, fails the join, and
   * concludes the item does not exist at the exact moment somebody is holding
   * it. So the LOCK filters on `id` alone (`lockById` — an immutable predicate
   * no writer can invalidate) and the mutable state is read AFTER it, where the
   * lock guarantees a stable answer.
   *
   * ⚠️ The workflow join is a **LEFT** join, so `statusCategory` is `null` for an
   * item sitting at a status its project's workflow does not define. An INNER
   * join would return NO ROW for such an item, which the caller can only read as
   * "it does not exist" — a 404 for a card that is plainly there. `null` is the
   * honest answer and it is also the safe one: an unknown category is not the
   * to-do category, so the claim refuses rather than guessing.
   *
   * `tx` REQUIRED — a claim state read outside the lock that guards it would be
   * a snapshot of the past.
   */
  async findClaimStateById(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<{
    status: string;
    statusCategory: string | null;
    assigneeId: string | null;
    archivedAt: Date | null;
  } | null> {
    const rows = await tx.$queryRaw<
      Array<{
        status: string;
        statusCategory: string | null;
        assigneeId: string | null;
        archivedAt: Date | null;
      }>
    >`
      SELECT w."status",
             ws."category" AS "statusCategory",
             w."assigneeId",
             w."archivedAt"
        FROM "work_item" w
        LEFT JOIN "workflow_status" ws
          ON ws."project_id" = w."projectId" AND ws."key" = w."status"
       WHERE w."id" = ${id}`;
    return rows[0] ?? null;
  },

  /**
   * The multi-row CLAIM LOCK (MOTIR-3049) — take a `FOR UPDATE` on EVERY row of
   * a scope, in ONE statement, in a DETERMINISTIC order.
   *
   * ⚠️ **THE ORDER MATTERS, AND `ORDER BY "id"` PINS IT RATHER THAN CREATING
   * IT.** A sprint claim and a story claim inside that sprint contend over an
   * overlapping row set the moment both scopes are claimable, and two
   * transactions taking the same rows in DIFFERENT orders deadlock instead of
   * queueing: Postgres detects the cycle and kills one of them with `40P01`.
   * `ORDER BY "id"` sorts BELOW the LockRows plan node, so rows are locked in
   * sorted order whatever access path the planner picks.
   *
   * Measured, so the comment does not overstate itself: on today's plan
   * (`= ANY(array)` over the primary key) Postgres ALREADY returns and locks in
   * ascending `id` order with no `ORDER BY` at all, and it does so even when the
   * caller's array is reversed. **So no test can tell this clause apart from its
   * absence, and none pretends to.** What it buys is that the order stops being
   * a property of the chosen plan — a wide member set that tips into a
   * sequential scan, or a future rewrite of this statement, cannot silently
   * reorder it. Callers may still sort their ids; that is belt to this braces.
   *
   * ⚠️ **AND IT FILTERS ON `id` ALONE**, for the reason
   * {@link findClaimStatesByIds} states in full: a `FOR UPDATE` that waits
   * re-evaluates its own predicate against the row version the winner just
   * wrote, so a WHERE or JOIN reading `status` returns ZERO rows at exactly the
   * moment somebody is holding the row. The mutable state is read AFTERWARDS.
   *
   * Returns the ids it actually locked — fewer than asked for means a row was
   * deleted between the caller's read and this statement, which the caller has
   * to notice rather than assume away. `tx` REQUIRED: a lock outside a
   * transaction is released before the next statement runs.
   */
  async lockByIds(ids: string[], tx: Prisma.TransactionClient): Promise<Array<{ id: string }>> {
    if (ids.length === 0) return [];
    return tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "work_item"
       WHERE "id" = ANY(${ids}::text[])
       ORDER BY "id"
       FOR UPDATE`;
  },

  /**
   * {@link lockByIds} for a caller that must NEVER WAIT on a card lock — the run
   * sweeps closing a lapsed or abandoned run (MOTIR-6881). Rows another transaction
   * holds are SKIPPED, not waited for, so the caller compares what came back with
   * what it asked for and backs off when they differ. Same ascending order.
   */
  async tryLockByIds(ids: string[], tx: Prisma.TransactionClient): Promise<Array<{ id: string }>> {
    if (ids.length === 0) return [];
    return tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "work_item"
       WHERE "id" = ANY(${ids}::text[])
       ORDER BY "id"
       FOR UPDATE SKIP LOCKED`;
  },

  /**
   * The post-lock CLAIM STATE read for MANY rows (MOTIR-3049) — the batched
   * twin of {@link findClaimStateById}, and it carries the same two warnings
   * because it is the same statement widened.
   *
   * ⚠️ **THE LOCK AND THIS READ ARE TWO STATEMENTS ON PURPOSE.** Folding the
   * `workflow_status` join into the `FOR UPDATE` reads the very column a racing
   * claimant writes, and EvalPlanQual then drops the row from the result at the
   * moment the lock is granted. {@link lockByIds} filters on the immutable `id`;
   * this reads the mutable state under that lock, where the answer is stable.
   *
   * ⚠️ The workflow join is a **LEFT** join, so `statusCategory` is `null` for a
   * row at a status its project's workflow does not define. An INNER join would
   * silently DROP such a row, and a dropped row in a scope claim is worse than
   * one in a keyed claim: the scope would be claimed as if that member were not
   * in it. `null` is never the to-do category, so the row refuses the claim —
   * which is the safe answer as well as the honest one.
   *
   * Carries `identifier` and `title` so a refusal can NAME the offending member
   * without a second read, and `archivedAt` so an archived row refuses.
   * Ordered by `id`, the same order the lock took. `tx` REQUIRED.
   */
  async findClaimStatesByIds(
    ids: string[],
    tx: Prisma.TransactionClient,
  ): Promise<
    Array<{
      id: string;
      identifier: string;
      title: string;
      status: string;
      statusCategory: string | null;
      assigneeId: string | null;
      archivedAt: Date | null;
    }>
  > {
    if (ids.length === 0) return [];
    return tx.$queryRaw<
      Array<{
        id: string;
        identifier: string;
        title: string;
        status: string;
        statusCategory: string | null;
        assigneeId: string | null;
        archivedAt: Date | null;
      }>
    >`
      SELECT w."id",
             w."identifier",
             w."title",
             w."status",
             ws."category" AS "statusCategory",
             w."assigneeId",
             w."archivedAt"
        FROM "work_item" w
        LEFT JOIN "workflow_status" ws
          ON ws."project_id" = w."projectId" AND ws."key" = w."status"
       WHERE w."id" = ANY(${ids}::text[])
       ORDER BY w."id"`;
  },

  /**
   * Assign MANY already-locked rows to one user (MOTIR-3049) — the batched write
   * half of a scope claim.
   *
   * The WHERE keeps a re-claim from writing a value that is already correct,
   * exactly as the keyed claim skips its single assignment for the same reason:
   * an update that changes nothing still bumps `updatedAt`, and `updatedAt` is
   * what the all-or-nothing rollback test reads. Returns the number of rows
   * actually written, so a caller can say what it did rather than assume it.
   *
   * ⚠️ **`{ not: userId }` ALONE SILENTLY SKIPS EVERY UNASSIGNED ROW**, which is
   * to say almost every row a claim is interested in. `assigneeId` is nullable,
   * and SQL's `"assigneeId" <> $1` is NULL — not TRUE — for a NULL column, so an
   * un-assigned card does not match the filter and is never written. The claim
   * then reports itself successful with the whole scope still unassigned, and the
   * NEXT claimant reads `assignee: null` and calls a card it in fact holds
   * `taken`. The explicit `OR` with `assigneeId: null` is the fix, and it is
   * written out rather than folded away because the collapsed form looks correct.
   *
   * The caller holds `FOR UPDATE` on every id (that is what "already-locked"
   * means); this method does not re-take it and must not be called without it.
   */
  async assignManyTo(ids: string[], userId: string, tx: Prisma.TransactionClient): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await tx.workItem.updateMany({
      where: {
        id: { in: ids },
        OR: [{ assigneeId: null }, { assigneeId: { not: userId } }],
      },
      data: { assigneeId: userId },
    });
    return result.count;
  },

  /**
   * The triage QUEUE read (Subtask 6.11.3, per docs/decisions/triage-model.md
   * §2) — the ONE read that INVERTS the `notInTriageSql` exclusion: it returns
   * ONLY triage-marked items for a project, never the planned tree. The ACTIVE
   * queue an admin works through:
   *
   *   • `triagedAt IS NOT NULL`        — only triage items
   *   • `ws."category" <> 'done'`      — hides DECLINED / MERGED items (decline
   *                                      and merge cancel the item to a terminal
   *                                      `category = 'done'` status while KEEPING
   *                                      the triage marker, ADR §5; they leave the
   *                                      active queue but never re-enter the tree)
   *   • snooze window                  — hides currently-snoozed items
   *                                      (`snoozedUntil > now()`); a NULL or past
   *                                      `snoozedUntil` is active
   *
   * Ordered newest-first (`triagedAt DESC`) with an `id ASC` tiebreak so the
   * `(triagedAt, id)` seek-after cursor is a total order (no skip/repeat across
   * pages). Cursor-paginated — `take + 1` lets the service derive the next
   * cursor without a COUNT (finding #57 — the public form can flood the inbox;
   * NEVER load-all). Resolves the status `category` (so the service needn't
   * re-query) + the SUBMITTER display fields and workspace-membership flag for
   * attribution in the SAME read. Read-only path → `db` singleton (optional
   * `tx`). The explicit `workspaceId` + `projectId` gate is the app-layer
   * tenancy check (finding #26).
   */
  async findTriageQueue(
    projectId: string,
    workspaceId: string,
    options: { limit: number; cursor?: TriageQueueCursor },
    tx?: Prisma.TransactionClient,
  ): Promise<TriageQueueRow[]> {
    const client = tx ?? dbRead;
    // The snooze cutoff is a BOUND `Date` param, not SQL `NOW()`: Prisma stores
    // `DateTime` as a naive-UTC `timestamp` (no tz), so a `timestamp <= now()
    // [timestamptz]` comparison reinterprets the column through the session
    // timezone and skews by the offset. Binding a `Date` compares like-for-like
    // (the same pattern `aggregateCreatedByBucket` uses for its window bounds).
    const now = new Date();
    // The public-vote tally per request (Story 6.12 · Subtask 6.12.6) — the
    // demand signal the queue sorts by, highest-first. `COALESCE(...,0)` so an
    // item with no votes counts as 0 (the common case) and a zero-vote queue
    // keeps its newest-first order. The `vt` aggregate is GROUPed once and
    // LEFT-JOINed, so it stays O(votes) — never a correlated per-row count.
    // (MOTIR-2864: that move has HAPPENED, and this is the read it happened for.
    // `public_request_vote` is FORCE-RLS, and under `motir_app` neither the
    // `app.user_id`/`app.system_admin` owner arm nor MOTIR-2811's
    // workspace-must-be-UNSET public arm admitted a single row here — so the
    // aggregate returned nothing and every `COALESCE(vt."votes", 0)` was 0, which
    // reads from the outside exactly like "nobody has voted yet". The service
    // already ran this inside `withWorkspaceServiceContext`; what was missing was
    // the matching policy, `public_request_vote_active_workspace_read`
    // (`prisma/migrations/20260815234500_public_request_vote_member_read`). The
    // tally is now RLS-scoped to the bound workspace rather than riding the
    // app-layer `projectId`/`workspaceId` gate alone — finding #26 stays the
    // secondary defence, not the only one.)
    const voteCountSql = Prisma.sql`COALESCE(vt."votes", 0)`;
    // Seek-after under `(voteCount DESC, triagedAt DESC, id ASC)`: strictly after
    // the previous page's last item. Bound params, never interpolated.
    const cursorPred = options.cursor
      ? Prisma.sql`AND (
            ${voteCountSql} < ${options.cursor.voteCount}
            OR (${voteCountSql} = ${options.cursor.voteCount} AND w."triagedAt" < ${options.cursor.triagedAt})
            OR (${voteCountSql} = ${options.cursor.voteCount} AND w."triagedAt" = ${options.cursor.triagedAt} AND w."id" > ${options.cursor.id})
          )`
      : Prisma.empty;
    return client.$queryRaw<TriageQueueRow[]>`
      SELECT w.*,
             ws."category"::text   AS "statusCategory",
             su."name"             AS "submitterName",
             su."email"            AS "submitterEmail",
             su."image"            AS "submitterImage",
             (sm."userId" IS NOT NULL) AS "submitterIsMember",
             ${voteCountSql}::int  AS "voteCount"
        FROM "work_item" w
        JOIN "workflow_status" ws
              ON ws."project_id" = w."projectId" AND ws."key" = w."status"
        LEFT JOIN "user" su ON su."id" = w."submittedByUserId"
        LEFT JOIN "workspace_membership" sm
              ON sm."userId" = w."submittedByUserId" AND sm."workspaceId" = w."workspaceId"
        LEFT JOIN (
               SELECT "work_item_id", COUNT(*) AS "votes"
                 FROM "public_request_vote"
                GROUP BY "work_item_id"
             ) vt ON vt."work_item_id" = w."id"
        WHERE w."projectId" = ${projectId}
          AND w."workspaceId" = ${workspaceId}
          AND w."archivedAt" IS NULL
          AND w."triagedAt" IS NOT NULL
          AND ws."category" <> 'done'
          AND (w."snoozedUntil" IS NULL OR w."snoozedUntil" <= ${now})
          ${cursorPred}
        ORDER BY ${voteCountSql} DESC, w."triagedAt" DESC, w."id" ASC
        LIMIT ${options.limit}`;
  },

  /**
   * The PUBLIC ROADMAP "Submitted" column read (Story 6.12 · Subtask 6.12.7) —
   * the still-in-triage public requests (the demand-gathering bucket). It
   * mirrors the active `findTriageQueue` predicate (a triage-marked, non-
   * declined, non-snoozed item) but ADDS `submittedByUserId IS NOT NULL` so only
   * real public submissions surface on the internet-facing roadmap (a never-
   * attributed legacy triage row is never exposed) and returns the PUBLIC
   * projection bits only (no reporter PII — the public mapper drops everything
   * but the public-safe fields). Ordered `(voteCount DESC, triagedAt DESC, id
   * ASC)` — highest-demand first — and cursor-paginated (`take + 1` in the
   * service; the at-scale rule, never load-all). `voterUserId` (nullable — a
   * logged-out reader) drives the per-card `voted` probe. Read-only → `db`
   * singleton; the vote aggregate rides the app-layer `projectId`/`workspaceId`
   * gate + RLS-secondary posture (finding #26), like `findTriageQueue`.
   */
  async findPublicRoadmapSubmitted(
    projectId: string,
    workspaceId: string,
    options: { limit: number; cursor?: PublicRoadmapCursor; voterUserId: string | null },
  ): Promise<PublicRoadmapRow[]> {
    // Bind `now` as a JS Date param (never SQL NOW()) — the timestamp-vs-
    // timestamptz skew guard `findTriageQueue` documents.
    const now = new Date();
    const votes = Prisma.sql`COALESCE(vt."votes", 0)`;
    const cursorPred = options.cursor
      ? Prisma.sql`AND (
            ${votes} < ${options.cursor.voteCount}
            OR (${votes} = ${options.cursor.voteCount} AND w."triagedAt" < ${options.cursor.recency})
            OR (${votes} = ${options.cursor.voteCount} AND w."triagedAt" = ${options.cursor.recency} AND w."id" > ${options.cursor.id})
          )`
      : Prisma.empty;
    return db.$queryRaw<PublicRoadmapRow[]>`
      SELECT w.*,
             ${votes}::int                  AS "voteCount",
             (mv."work_item_id" IS NOT NULL) AS "voted"
        FROM "work_item" w
        JOIN "workflow_status" ws
              ON ws."project_id" = w."projectId" AND ws."key" = w."status"
        LEFT JOIN (
               SELECT "work_item_id", COUNT(*) AS "votes"
                 FROM "public_request_vote"
                GROUP BY "work_item_id"
             ) vt ON vt."work_item_id" = w."id"
        LEFT JOIN "public_request_vote" mv
              ON mv."work_item_id" = w."id" AND mv."user_id" = ${options.voterUserId}
        WHERE w."projectId" = ${projectId}
          AND w."workspaceId" = ${workspaceId}
          AND w."archivedAt" IS NULL
          AND w."triagedAt" IS NOT NULL
          AND w."submittedByUserId" IS NOT NULL
          AND ws."category" <> 'done'
          AND (w."snoozedUntil" IS NULL OR w."snoozedUntil" <= ${now})
          ${cursorPred}
        ORDER BY ${votes} DESC, w."triagedAt" DESC, w."id" ASC
        LIMIT ${options.limit}`;
  },

  /**
   * The total of the roadmap "Submitted" column (Subtask 6.12.7) — the same
   * active-public-request predicate as {@link findPublicRoadmapSubmitted}, minus
   * the cursor/limit, so the column header shows a real count (never the loaded-
   * page length). One bounded aggregate. Read-only → `db` singleton.
   */
  async countPublicRoadmapSubmitted(projectId: string, workspaceId: string): Promise<number> {
    const now = new Date();
    const rows = await db.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS "count"
        FROM "work_item" w
        JOIN "workflow_status" ws
              ON ws."project_id" = w."projectId" AND ws."key" = w."status"
        WHERE w."projectId" = ${projectId}
          AND w."workspaceId" = ${workspaceId}
          AND w."archivedAt" IS NULL
          AND w."triagedAt" IS NOT NULL
          AND w."submittedByUserId" IS NOT NULL
          AND ws."category" <> 'done'
          AND (w."snoozedUntil" IS NULL OR w."snoozedUntil" <= ${now})`;
    return rows[0]?.count ?? 0;
  },

  /**
   * A PUBLIC ROADMAP "promoted" column read (Subtask 6.12.7) — the graduated
   * (non-triage) public-facing items whose workflow `status` is one of
   * `statusKeys` (the service maps the project's real statuses to the Planned /
   * In&nbsp;progress / Done buckets; Done's keys deliberately EXCLUDE `cancelled`
   * so a "won't do" item never appears on the public roadmap). Same public
   * projection + vote aggregate + `voted` probe as the Submitted read, but
   * tiebroken on the monotonic per-project `key` (recency) rather than
   * `triagedAt`. Ordered `(voteCount DESC, key DESC, id ASC)`; cursor-paginated.
   * Empty `statusKeys` short-circuits to `[]` (a bucket that maps no live status
   * has no cards). Read-only → `db` singleton.
   */
  async findPublicRoadmapByStatus(
    projectId: string,
    workspaceId: string,
    statusKeys: string[],
    options: {
      limit: number;
      cursor?: PublicRoadmapCursor;
      voterUserId: string | null;
      // Epic-privacy public exclusion (Subtask 6.14.4) — drop a private epic's
      // descendants for a non-member viewer (resolved by
      // `findPublicHiddenDescendantIds`). Absent/empty ⇒ no clause.
      excludeIds?: readonly string[];
    },
  ): Promise<PublicRoadmapRow[]> {
    if (statusKeys.length === 0) return [];
    const votes = Prisma.sql`COALESCE(vt."votes", 0)`;
    const cursorPred = options.cursor
      ? Prisma.sql`AND (
            ${votes} < ${options.cursor.voteCount}
            OR (${votes} = ${options.cursor.voteCount} AND w."key" < ${options.cursor.recency})
            OR (${votes} = ${options.cursor.voteCount} AND w."key" = ${options.cursor.recency} AND w."id" > ${options.cursor.id})
          )`
      : Prisma.empty;
    return db.$queryRaw<PublicRoadmapRow[]>`
      SELECT w.*,
             ${votes}::int                  AS "voteCount",
             (mv."work_item_id" IS NOT NULL) AS "voted"
        FROM "work_item" w
        LEFT JOIN (
               SELECT "work_item_id", COUNT(*) AS "votes"
                 FROM "public_request_vote"
                GROUP BY "work_item_id"
             ) vt ON vt."work_item_id" = w."id"
        LEFT JOIN "public_request_vote" mv
              ON mv."work_item_id" = w."id" AND mv."user_id" = ${options.voterUserId}
        WHERE w."projectId" = ${projectId}
          AND w."workspaceId" = ${workspaceId}
          AND w."archivedAt" IS NULL
          AND ${notInTriageSql('w')}
          AND ${notExcludedSql('w', options.excludeIds)}
          AND w."status" = ANY(${statusKeys})
          ${cursorPred}
        ORDER BY ${votes} DESC, w."key" DESC, w."id" ASC
        LIMIT ${options.limit}`;
  },

  /**
   * Reusable server-side quick-search read (Subtask 6.9.1) — the single read
   * both link pickers (6.9.2) and, later, the cmd-K palette consume. Returns
   * non-archived work items in the WORKSPACE, restricted to `projectIds` (the
   * actor's BROWSABLE project set, resolved by the service's Story 6.4 gate —
   * pass the full set; the service short-circuits an empty set, so this is only
   * ever reached with ≥1 id), whose `identifier` matches the query (exact /
   * prefix, case-insensitive) OR whose `title` ILIKE-CONTAINS it. The title
   * contains-scan rides the 6.1.1 `pg_trgm` GIN index — it must not table-scan
   * 10k titles. Relevance-ordered — exact-identifier → identifier-prefix →
   * title-only match — then `key` ASC + `identifier` ASC as a stable, fully
   * deterministic tiebreak. Bounded to `limit` (finding #57 — never an
   * unbounded fetch). `excludeIds` drops specific rows (6.9.2's link picker
   * passes self + already-linked-for-the-relationship); omitted ⇒ no exclusion.
   * Explicit `workspaceId` gate — the primary tenant filter (finding #26; RLS
   * is inert under the dev/CI superuser). Read-only → `db` singleton. The query
   * binds as a parameter (never interpolated) and is pattern-escaped for LIKE
   * metacharacters, so a search for "50%" matches the literal "50%".
   *
   * A query that NAMES A NUMBER (`6010`, `#6010` — {@link quickSearchNumber})
   * also matches `w."key"` exactly, within the same browsable set, so a
   * workspace with two projects returns each project's `…-6010` (MOTIR-6896).
   * It ranks with the exact identifier (0). Every other query — words, a
   * digits-and-words mix, a sub-minimum number — builds the SQL it always did:
   * the number arm is `Prisma.empty` there, not a `FALSE` clause.
   */
  async quickSearch(
    workspaceId: string,
    projectIds: string[],
    query: string,
    limit: number,
    excludeIds: string[] = [],
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItem[]> {
    if (projectIds.length === 0) return [];
    const exact = query.toLowerCase();
    const idPrefixPattern = `${escapeLikePattern(query)}%`;
    // Title match is Jira-style summary tokenisation: split the query on
    // whitespace and require the title to contain EVERY token (order-
    // independent), each a case-insensitive substring — so "board drag" finds
    // "Drag-and-drop on the board" even though the words aren't adjacent. A
    // single-token query collapses to one contains-match. Each token's ILIKE
    // rides the 6.1.1 `pg_trgm` GIN index. The identifier (key) match keeps the
    // WHOLE query (keys don't tokenise — "PROD-12" is one token).
    const tokens = query.split(/\s+/).filter((t) => t.length > 0);
    const titleMatch = tokens.length
      ? Prisma.join(
          tokens.map((t) => Prisma.sql`w."title" ILIKE ${`%${escapeLikePattern(t)}%`}`),
          ' AND ',
        )
      : Prisma.sql`FALSE`;
    // Empty array params break `ANY`/`ALL` type inference; projectIds is
    // guaranteed non-empty above, and the exclusion is omitted entirely when
    // there's nothing to exclude.
    const excludeSql = excludeIds.length
      ? Prisma.sql`AND w."id" <> ALL(${excludeIds})`
      : Prisma.empty;
    // The number arm, bound as a parameter and only ever an integer parsed after
    // a digits-only match — never interpolated.
    const number = quickSearchNumber(query);
    const numberMatch = number === null ? Prisma.empty : Prisma.sql`OR w."key" = ${number}`;
    const numberRank = number === null ? Prisma.empty : Prisma.sql`WHEN w."key" = ${number} THEN 0`;
    const client = tx ?? dbRead;
    return client.$queryRaw<WorkItem[]>`
      SELECT w.*
        FROM "work_item" w
        WHERE w."workspaceId" = ${workspaceId}
          AND w."projectId" = ANY(${projectIds})
          AND w."archivedAt" IS NULL
          AND ${notInTriageSql('w')}
          ${excludeSql}
          AND (
            w."identifier" ILIKE ${idPrefixPattern}
            OR (${titleMatch})
            ${numberMatch}
          )
        ORDER BY
          CASE
            WHEN LOWER(w."identifier") = ${exact} THEN 0
            ${numberRank}
            WHEN w."identifier" ILIKE ${idPrefixPattern} THEN 1
            ELSE 2
          END ASC,
          w."key" ASC,
          w."identifier" ASC
        LIMIT ${limit}`;
  },

  /**
   * Duplicate-detection match for a public submission (Story 6.12 · Subtask
   * 6.12.5) — the deterministic title search behind "upvote this instead"
   * (Canny's behaviour). Returns the project's ACTIVE public requests (kind
   * `bug` / `task`, not archived, NOT in a `done`-category status — so cancelled
   * / declined / shipped items are excluded) whose `title` contains EVERY query
   * token (the same Jira-style tokenisation `quickSearch` uses, riding the
   * 6.1.1 `pg_trgm` GIN index), newest-demand first (vote count DESC, then key).
   *
   * Two deliberate differences from `quickSearch`: it is scoped to ONE project
   * (the public project — a cross-org caller has no browsable-set) and it does
   * NOT apply the triage exclusion, so a still-in-triage request IS surfaceable
   * (a duplicate of an un-promoted submission must be join-able — the ADR §6
   * "DOES include still-in-triage requests"). The vote count rides the 6.12.3
   * `PublicRequestVote` join. A blank / token-less query returns []. Read-only →
   * the `db` singleton; `query` binds as a param (never interpolated) and is
   * pattern-escaped for LIKE metacharacters.
   */
  async findPublicRequestMatches(
    projectId: string,
    query: string,
    limit: number,
  ): Promise<PublicRequestMatchRow[]> {
    const tokens = query.split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) return [];
    const titleMatch = Prisma.join(
      tokens.map((t) => Prisma.sql`w."title" ILIKE ${`%${escapeLikePattern(t)}%`}`),
      ' AND ',
    );
    return db.$queryRaw<PublicRequestMatchRow[]>`
      SELECT w.*, COALESCE(v."cnt", 0) AS "voteCount"
        FROM "work_item" w
        JOIN "workflow_status" ws
              ON ws."project_id" = w."projectId" AND ws."key" = w."status"
        LEFT JOIN (
          SELECT "work_item_id", COUNT(*)::int AS "cnt"
            FROM "public_request_vote"
            GROUP BY "work_item_id"
        ) v ON v."work_item_id" = w."id"
        WHERE w."projectId" = ${projectId}
          AND w."kind"::text IN ('bug', 'task')
          AND w."archivedAt" IS NULL
          AND ws."category" <> 'done'
          AND (${titleMatch})
        ORDER BY "voteCount" DESC, w."key" ASC
        LIMIT ${limit}`;
  },

  /**
   * Non-archived siblings under a parent WITHIN a project, ordered by
   * fractional `position` (Subtask 1.4.4). Distinct from `findChildren`: a
   * top-level sibling set has `parentId IS NULL`, and scoping by `projectId`
   * keeps a null-parent query from spanning every project's roots. Used by
   * `createWorkItem` to find the last sibling whose position the new item
   * appends after. Read-inside-a-transaction (the create flow allocates +
   * inserts atomically) → takes the same optional `tx` as the other reads.
   */
  async findSiblings(
    projectId: string,
    parentId: string | null,
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItem[]> {
    const client = tx ?? dbRead;
    return client.workItem.findMany({
      where: { projectId, parentId, archivedAt: null },
      orderBy: { position: 'asc' },
    });
  },

  /**
   * HOW MANY non-archived siblings a level holds (MOTIR-4024) — the same set
   * `findSiblings` returns, counted rather than read.
   *
   * The plan-detail's derived default view needs the SIZE of the level the canvas
   * will arrive at, and only the size: a `count` keeps a busy container from
   * loading two hundred rows to answer a question about a number. `parentId:
   * null` is the project's ROOT level, scoped by `projectId` so a null-parent
   * query cannot span every project's roots — the same pairing `findSiblings`
   * documents one method up.
   */
  async countSiblingsInWorkspace(
    projectId: string,
    parentId: string | null,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = tx ?? dbRead;
    return client.workItem.count({
      where: { projectId, workspaceId, parentId, archivedAt: null },
    });
  },

  /**
   * Non-archived work items in a project, filtered by any combination of
   * kind / status / assignee (Subtask 1.4.4). Ordered by `key` asc to match
   * the PROD-N identifier order the list surfaces render. A read-only list
   * path → `db` singleton. Each filter is applied only when supplied, so the
   * no-filter call returns every non-archived row in the project.
   */
  async findByProjectFiltered(
    projectId: string,
    filter: { kind?: WorkItemKind; status?: string; assigneeId?: string | null } = {},
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItem[]> {
    const client = tx ?? dbRead;
    return client.workItem.findMany({
      where: {
        projectId,
        archivedAt: null,
        triagedAt: null, // read-exclusion (Subtask 6.11.3)
        ...(filter.kind ? { kind: filter.kind } : {}),
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.assigneeId !== undefined ? { assigneeId: filter.assigneeId } : {}),
      },
      orderBy: { key: 'asc' },
    });
  },

  /**
   * Non-archived work items in a project whose `kind` is one of `kinds`,
   * ordered by `key` asc (the stable PROD-N identifier order). Carries an
   * EXPLICIT `workspaceId` filter (finding #26) — the primary tenant gate,
   * since RLS is inert under the dev/CI superuser. Backs
   * `workItemsService.listCandidateParents` (Subtask 2.3.4): the parent
   * picker's candidate set. Short-circuits to `[]` on an empty `kinds` list
   * (an `epic` child has no legal parents) so no pointless query is issued.
   */
  async findByProjectAndKinds(
    projectId: string,
    kinds: readonly WorkItemKind[],
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItem[]> {
    if (kinds.length === 0) return [];
    const client = tx ?? dbRead;
    return client.workItem.findMany({
      // triagedAt: null — a triage item is never a candidate parent (read-exclusion, 6.11.3).
      where: {
        projectId,
        workspaceId,
        kind: { in: [...kinds] },
        archivedAt: null,
        triagedAt: null,
      },
      orderBy: { key: 'asc' },
    });
  },

  /**
   * The FIRST non-archived work item of a given kind carrying an EXACT title in
   * a project, lowest `key` first (MOTIR-1466 / MOTIR-2201 — the planner-bug home
   * resolution). Titles are not unique in general, so this is a marker lookup for
   * a KNOWN, migration-created infra item (the home epic) where exactly one match
   * is expected; the `key asc` order makes the result deterministic if a stray
   * duplicate ever exists. Read-only path → `db` singleton (optional `tx` for a
   * guarded read).
   */
  async findByProjectKindAndTitle(
    projectId: string,
    kind: WorkItemKind,
    title: string,
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItem | null> {
    const client = tx ?? dbRead;
    return client.workItem.findFirst({
      where: { projectId, kind, title, archivedAt: null },
      orderBy: { key: 'asc' },
    });
  },

  // (MOTIR-2201 removed `findFirstChildOfKind` — the planner-bug home was its
  // only caller and no longer resolves through a child row at all.)

  /**
   * Non-archived work items in a project, cursor-paginated. Ordered by `key`
   * asc (stable, monotonic, matches the PROD-N identifier order). `cursor` is
   * a work-item id; when present the row at the cursor is skipped so paging
   * doesn't repeat it.
   */
  async findByProject(
    projectId: string,
    options: { take?: number; cursor?: string; excludeIds?: readonly string[] } = {},
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItem[]> {
    const client = tx ?? dbRead;
    const { take = 50, cursor, excludeIds } = options;
    return client.workItem.findMany({
      where: {
        projectId,
        archivedAt: null,
        triagedAt: null, // read-exclusion (6.11.3)
        // Epic-privacy public exclusion (6.14.4): drop descendants of a private
        // epic for a non-member viewer. Absent/empty ⇒ no clause (members + the
        // no-private-epic case read the unchanged projection).
        ...(excludeIds && excludeIds.length > 0 ? { id: { notIn: excludeIds as string[] } } : {}),
      },
      orderBy: { key: 'asc' },
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  },

  /**
   * EVERY non-archived, non-triage work item of a project, with the lean columns
   * the pre-commit plan-validation projection needs (Subtask 7.28.1 / MOTIR-1386):
   * id + identifier + status + parentId + sprintId + projectId. ONE round-trip,
   * unpaginated — `planValidityService` builds an in-memory virtual graph of the
   * whole project (live tree ⊕ a Plan's PlanItem delta) and runs the shipped
   * finishability rules over it, so it needs the project's full node set, not a
   * page. `workspaceId`-gated (finding #26; RLS is inert under the dev/CI
   * superuser) and `archivedAt`/`triagedAt`-excluded (the same read-exclusion the
   * validity engines use, so a soft-removed/triage row never phantom-projects).
   * Read-only path → `db` singleton.
   */
  async findAllByProjectForValidity(
    projectId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<
    Array<{
      id: string;
      identifier: string;
      status: string;
      parentId: string | null;
      sprintId: string | null;
      projectId: string;
      kind: string;
    }>
  > {
    const client = tx ?? dbRead;
    return client.workItem.findMany({
      where: { projectId, workspaceId, archivedAt: null, triagedAt: null },
      select: {
        id: true,
        identifier: true,
        status: true,
        parentId: true,
        sprintId: true,
        projectId: true,
        kind: true,
      },
    });
  },

  /**
   * The lean validity columns of the NAMED work items — the FOCUSED twin of
   * {@link findAllByProjectForValidity} (MOTIR-8146). The plan review's
   * `edgeCoverage` asks about a handful of edges, so it loads the ids the plan
   * touches (plus their ancestors) instead of the project's whole live set.
   * Same exclusions as the whole-project read (`archivedAt` / `triagedAt`) and the
   * same `workspaceId` gate; NOT project-scoped, because a plan's ref may name a
   * cross-project blocker. `[]` for an empty list without a query.
   */
  async findForValidityByIds(
    ids: string[],
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItemValidityRow[]> {
    if (ids.length === 0) return [];
    const client = tx ?? dbRead;
    return client.workItem.findMany({
      where: { id: { in: ids }, workspaceId, archivedAt: null, triagedAt: null },
      select: VALIDITY_SELECT,
    });
  },

  /**
   * The lean validity columns of every live CHILD of the named parents, in one
   * project (MOTIR-8146) — what the plan review reads to find the child edges a
   * `modify` of a parent's `blocked_by` re-covers or uncovers. Same exclusions and
   * `workspaceId` gate as {@link findAllByProjectForValidity}.
   */
  async findForValidityByParentIds(
    parentIds: string[],
    projectId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItemValidityRow[]> {
    if (parentIds.length === 0) return [];
    const client = tx ?? dbRead;
    return client.workItem.findMany({
      where: {
        parentId: { in: parentIds },
        projectId,
        workspaceId,
        archivedAt: null,
        triagedAt: null,
      },
      select: VALIDITY_SELECT,
    });
  },

  /**
   * The ids of every work item that DESCENDS from a PRIVATE epic
   * (`kind = 'epic' AND publicChildrenHidden = true`) in this project — the set a
   * public / non-member read must EXCLUDE (Story 6.14 · Subtask 6.14.4, per
   * `docs/decisions/epic-privacy.md` §6). Seeded from the (tiny, index-backed —
   * `@@index([projectId, publicChildrenHidden])`) private-epic set and walked
   * DOWN the `parentId` edge in ONE recursive CTE, so it is depth-agnostic (the
   * tree caps at 4: epic → story → task → subtask) and resolved entirely in SQL —
   * never a load-all-then-filter-in-app (finding #57). The private epic ROWS
   * themselves are NOT included (they stay visible as the "this epic is not
   * public" placeholder); only their descendants are returned. Returns `[]` when
   * the project has no private epic (the common case — the caller then skips the
   * exclusion entirely). The `workspaceId` gate rides every step (the app-layer
   * tenancy check atop RLS, finding #26). Read-only → `db` singleton.
   *
   * NOTE on scale: the descendant set is bounded by the private subtrees' size
   * and is consumed as an indexable `id <> ALL(...)` array predicate. A
   * denormalized root-epic column would collapse this to a single equality but
   * costs write-time fan-out + a backfill; the ADR (§6) deliberately DEFERS it —
   * the bounded depth + tiny private-epic set make the CTE the simpler correct
   * shape, and adding the column later does not change this method's contract.
   */
  async findPublicHiddenDescendantIds(
    projectId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<string[]> {
    const client = tx ?? dbRead;
    const rows = await client.$queryRaw<Array<{ id: string }>>`
      WITH RECURSIVE hidden AS (
        SELECT c."id", c."parentId"
          FROM "work_item" c
          JOIN "work_item" e ON e."id" = c."parentId"
          WHERE c."workspaceId" = ${workspaceId}
            AND e."projectId" = ${projectId}
            AND e."workspaceId" = ${workspaceId}
            AND e."kind"::text = 'epic'
            AND e."publicChildrenHidden" = true
        UNION ALL
        SELECT c."id", c."parentId"
          FROM "work_item" c
          JOIN hidden h ON h."id" = c."parentId"
          WHERE c."workspaceId" = ${workspaceId}
      )
      SELECT "id" FROM hidden`;
    return rows.map((r) => r.id);
  },

  /**
   * The most recent work-item activity per project, for a SET of projects, in
   * ONE grouped aggregate — the "recent activity" stat for a page of PROJECT
   * SQUARE cards (Story 6.13 · Subtask 6.13.2), avoiding a per-card N+1. Returns
   * one `{ projectId, lastActivityAt }` per project that has at least one
   * non-archived, non-triage work item (a project with none is simply absent —
   * the service defaults its activity to null). Excludes archived + triage items
   * so the signal reflects the publicly-visible planned tree (the 6.11.3
   * read-exclusion + the 6.12.4 public projection), not internal triage churn.
   * Empty input short-circuits to `[]` (no pointless query). Read-only cross-org
   * path → `db` singleton + the app-layer `projectId` filter (the directory's
   * public-only set is enforced one layer up).
   */
  async maxActivityByProjects(
    projectIds: string[],
  ): Promise<Array<{ projectId: string; lastActivityAt: Date | null }>> {
    if (projectIds.length === 0) return [];
    const rows = await db.workItem.groupBy({
      by: ['projectId'],
      where: { projectId: { in: projectIds }, archivedAt: null, triagedAt: null },
      _max: { updatedAt: true },
    });
    return rows.map((r) => ({ projectId: r.projectId, lastActivityAt: r._max.updatedAt }));
  },

  /**
   * How many work items in a project reference a given status key (Subtask
   * 2.2.5's delete-protection: a status still in use can't be removed).
   * Counts ALL items including archived — an archived item's status string
   * still references the status, so deleting it would orphan that reference.
   */
  async countByProjectAndStatusKey(
    projectId: string,
    statusKey: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = tx ?? dbRead;
    return client.workItem.count({ where: { projectId, status: statusKey } });
  },

  /**
   * Every work item in a project that references a given status key — INCLUDING
   * archived ones (Subtask 2.3.1's delete-with-reassign). The scope mirrors
   * `countByProjectAndStatusKey` exactly: an archived item's status string
   * still points at the status, so the reassign must migrate it too or deleting
   * the status would leave a dangling reference. Used inside the delete tx, so
   * it takes `tx`.
   */
  async findByProjectAndStatusKey(
    projectId: string,
    statusKey: string,
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItem[]> {
    const client = tx ?? dbRead;
    return client.workItem.findMany({ where: { projectId, status: statusKey } });
  },

  /**
   * ONE PAGE of a project's cards of a given `type` at a given status key,
   * newest key first — the candidate read behind `designAccessService`'s
   * approved-design listing (Story MOTIR-5553 · Subtask MOTIR-5557).
   *
   * ⚠️ THE CURSOR IS THE `key` NUMBER, not a timestamp, and the caller's
   * comment says why: a republish moves a card's newest result forward in time,
   * so a time-ordered cursor walks that card across page boundaries and shows it
   * twice or not at all. A key never moves.
   *
   * `take` is passed through verbatim so the caller can over-read by one and
   * report `nextCursor` from what EXISTS rather than inferring it from a full
   * page.
   */
  async findByProjectTypeAndStatusPage(
    projectId: string,
    filter: { type: WorkItemType; statusKey: string; beforeKey?: number; titleContains?: string },
    take: number,
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItem[]> {
    const client = tx ?? dbRead;
    return client.workItem.findMany({
      where: {
        projectId,
        archivedAt: null,
        triagedAt: null, // read-exclusion (Subtask 6.11.3)
        type: filter.type,
        status: filter.statusKey,
        ...(filter.beforeKey !== undefined ? { key: { lt: filter.beforeKey } } : {}),
        ...(filter.titleContains
          ? { title: { contains: filter.titleContains, mode: 'insensitive' as const } }
          : {}),
      },
      orderBy: { key: 'desc' },
      take,
    });
  },

  /**
   * Direct (non-archived) children of a work item, ordered by fractional
   * `position`. One level only — for the full subtree use `findSubtree`.
   */
  async findChildren(parentId: string, tx?: Prisma.TransactionClient): Promise<WorkItem[]> {
    const client = tx ?? dbRead;
    return client.workItem.findMany({
      // triagedAt: null is a no-op in practice (a triage item is always
      // parentless, so never a child) but documents + enforces the read-exclusion
      // invariant uniformly so no future child read can leak triage (6.11.3).
      where: { parentId, archivedAt: null, triagedAt: null },
      orderBy: { position: 'asc' },
    });
  },

  /**
   * The full subtree rooted at `rootId`, in ONE round-trip via a recursive
   * CTE. Returns each row with its `depth` (root = 1), ordered depth-first by
   * position so the result reads as a pre-order tree walk. Identifiers are
   * double-quoted because the columns are camelCase; `kind` is cast to text so
   * `$queryRaw` returns the plain enum label.
   */
  async findSubtree(rootId: string, tx?: Prisma.TransactionClient): Promise<WorkItemSubtreeRow[]> {
    const client = tx ?? dbRead;
    return client.$queryRaw<WorkItemSubtreeRow[]>`
      WITH RECURSIVE subtree AS (
        SELECT w."id", w."parentId", w."kind", w."key", w."identifier",
               w."title", w."status", w."position", w."obsolescence", 1 AS depth
          FROM "work_item" w
          WHERE w."id" = ${rootId}
        UNION ALL
        SELECT w."id", w."parentId", w."kind", w."key", w."identifier",
               w."title", w."status", w."position", w."obsolescence", s.depth + 1
          FROM "work_item" w
          JOIN subtree s ON w."parentId" = s."id"
      )
      SELECT "id",
             "parentId",
             "kind"::text       AS "kind",
             "key",
             "identifier",
             "title",
             "status",
             "position",
             "obsolescence"::text AS "obsolescence",
             depth::int AS "depth"
        FROM subtree
        ORDER BY depth ASC, "position" ASC`;
  },

  /**
   * The DIFFICULTY of every live LEAF in a work item's subtree that is not
   * finished (Story MOTIR-6989 · MOTIR-6993) — what a hosted run on a PARENT
   * resolves its model from (the highest of them). A leaf is a live row with no
   * live child; "finished" is its status sitting in the project's `done`
   * category. The ROOT itself is always returned when it is a leaf, whatever its
   * status, so a leaf card answers its own difficulty. Archived / triage rows are
   * excluded on both the anchor and the recursive step, and the walk is
   * `workspaceId`-gated (finding #26). `difficulty` is null for a leaf that
   * carries none.
   */
  async findUnfinishedLeafDifficulties(
    rootId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<{ difficulty: WorkItemDifficulty | null }[]> {
    const client = tx ?? dbRead;
    return client.$queryRaw<{ difficulty: WorkItemDifficulty | null }[]>`
      WITH RECURSIVE subtree AS (
        SELECT w."id", w."projectId", w."status", w."difficulty"
          FROM "work_item" w
          WHERE w."id" = ${rootId}
            AND w."workspaceId" = ${workspaceId}
            AND w."archivedAt" IS NULL
            AND w."triagedAt" IS NULL
        UNION ALL
        SELECT w."id", w."projectId", w."status", w."difficulty"
          FROM "work_item" w
          JOIN subtree s ON w."parentId" = s."id"
          WHERE w."workspaceId" = ${workspaceId}
            AND w."archivedAt" IS NULL
            AND w."triagedAt" IS NULL
      )
      SELECT s."difficulty"::text AS "difficulty"
        FROM subtree s
        LEFT JOIN "workflow_status" ws
              ON ws."project_id" = s."projectId" AND ws."key" = s."status"
        WHERE NOT EXISTS (
                SELECT 1 FROM "work_item" c
                 WHERE c."parentId" = s."id"
                   AND c."archivedAt" IS NULL
                   AND c."triagedAt" IS NULL
              )
          AND (s."id" = ${rootId} OR ws."category" IS DISTINCT FROM 'done')`;
  },

  /**
   * A DEPTH-BOUNDED, LIVE slice of a work item's subtree — the read the AI
   * plan-tree `get_subtree` tool walks (Subtask 7.5.1). Like {@link findSubtree}
   * but three things differ, all to make it a safe bounded-neighborhood push
   * rather than a whole-tree dump: (1) the recursion STOPS at `maxDepth`
   * DESCENDANT levels below the root (`maxDepth = 0` → the root alone; the
   * recursive step only fires while the parent's `depth <= maxDepth`, so a node
   * at descendant-level d — CTE depth d+1 — is included iff d ≤ maxDepth); (2) it
   * EXCLUDES archived/triage rows on BOTH the anchor and the recursive step (a
   * soft-removed item is not live work — the readiness-read rule); (3) it is
   * `workspaceId`-gated throughout (finding #26), so a stray cross-workspace row
   * can't enter even with RLS inert under the dev/CI superuser. Same
   * {@link WorkItemSubtreeRow} projection as `findSubtree` (CTE depth: 1 = root).
   * Read-only → `db` singleton.
   */
  async findBoundedSubtree(
    rootId: string,
    workspaceId: string,
    maxDepth: number,
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItemSubtreeRow[]> {
    const client = tx ?? dbRead;
    return client.$queryRaw<WorkItemSubtreeRow[]>`
      WITH RECURSIVE subtree AS (
        SELECT w."id", w."parentId", w."kind", w."key", w."identifier",
               w."title", w."status", w."position", w."obsolescence", 1 AS depth
          FROM "work_item" w
          WHERE w."id" = ${rootId}
            AND w."workspaceId" = ${workspaceId}
            AND w."archivedAt" IS NULL
            AND w."triagedAt" IS NULL
        UNION ALL
        SELECT w."id", w."parentId", w."kind", w."key", w."identifier",
               w."title", w."status", w."position", w."obsolescence", s.depth + 1
          FROM "work_item" w
          JOIN subtree s ON w."parentId" = s."id"
          WHERE s.depth <= ${maxDepth}
            AND w."workspaceId" = ${workspaceId}
            AND w."archivedAt" IS NULL
            AND w."triagedAt" IS NULL
      )
      SELECT "id",
             "parentId",
             "kind"::text       AS "kind",
             "key",
             "identifier",
             "title",
             "status",
             "position",
             "obsolescence"::text AS "obsolescence",
             depth::int AS "depth"
        FROM subtree
        ORDER BY depth ASC, "position" ASC`;
  },

  /**
   * The NON-archived members of a work item's subtree (the root + every live
   * descendant) — the "containing set" the `validate_work_item` finishability
   * check (Subtask 7.8.23) keys its "is this blocker IN the subtree?" test on.
   * A recursive CTE walking DOWN `parentId` from `rootId`, mirroring
   * {@link findSubtree} but trimmed to the validity columns (`id` for the
   * membership test, `identifier` to NAME a gated item, `status` for the
   * not-done filter) and, crucially, EXCLUDING archived/triage rows on BOTH the
   * anchor and the recursive step (a soft-removed item is not real work and must
   * never gate, mirroring the readiness reads). `workspaceId`-gated throughout
   * (finding #26). Parent↔child is same-project, so the caller judges done-ness
   * against the root's project terminal set. Read-only → `db` singleton.
   *
   * `parentId` rides along for the prose-vs-graph advisory (MOTIR-1969), which
   * walks each member's ANCESTOR chain (a card naming its own parent Story /
   * Epic is not a missing dependency). It comes free — the CTE already carries
   * the column to recurse on.
   */
  async findSubtreeMembersForValidity(
    rootId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<
    Array<{ id: string; identifier: string; status: string; parentId: string | null; kind: string }>
  > {
    const client = tx ?? dbRead;
    return client.$queryRaw<
      Array<{
        id: string;
        identifier: string;
        status: string;
        parentId: string | null;
        kind: string;
      }>
    >`
      WITH RECURSIVE subtree AS (
        SELECT w."id", w."parentId", w."identifier", w."status", w."kind"::text AS "kind"
          FROM "work_item" w
          WHERE w."id" = ${rootId}
            AND w."workspaceId" = ${workspaceId}
            AND w."archivedAt" IS NULL
            AND w."triagedAt" IS NULL
        UNION ALL
        SELECT w."id", w."parentId", w."identifier", w."status", w."kind"::text AS "kind"
          FROM "work_item" w
          JOIN subtree s ON w."parentId" = s."id"
          WHERE w."workspaceId" = ${workspaceId}
            AND w."archivedAt" IS NULL
            AND w."triagedAt" IS NULL
      )
      SELECT "id", "identifier", "status", "parentId", "kind" FROM subtree`;
  },

  /**
   * The live work items of ONE project whose body CONTAINS any of `needles` —
   * the PATH-REFERENCE advisory's second-namer read (MOTIR-5424): *which other
   * work item also names this not-yet-existing file?*
   *
   * A substring match, deliberately over-inclusive — `contains` does not know
   * where a path starts or ends, so `lib/a.ts` also matches a body naming
   * `xlib/a.ts`. The caller re-reads each returned body with the same path
   * extraction it scanned the asking card with and keeps only an exact match, so
   * the over-match costs a row, never a finding. Status is NOT filtered here: the
   * project's terminal set is a workflow read the service already holds, and a
   * status list in this query would be a second copy of it.
   *
   * Archived and triage-inbox rows are excluded, matching every tree read. An
   * empty needle list short-circuits rather than issuing a degenerate `OR []`,
   * which Prisma reads as match-nothing on some versions and match-everything on
   * none — not a question worth asking. Read-only path → `dbRead`.
   *
   * `excludeStatuses` drops rows already known to be irrelevant IN the query (the
   * service passes the project's terminal set), so a mostly-finished project does
   * not pay to scan history it will discard. Matching is one regex alternation
   * over the escaped needles — see the note at the pattern.
   */
  async findLiveBodiesContainingAny(
    projectId: string,
    workspaceId: string,
    needles: string[],
    tx?: Prisma.TransactionClient,
    excludeStatuses: readonly string[] = [],
  ): Promise<
    Array<{
      id: string;
      identifier: string;
      status: string;
      descriptionMd: string | null;
      targetRepos: string[];
    }>
  > {
    if (needles.length === 0) return [];
    const client = tx ?? dbRead;
    // ONE regex alternation, not `OR` of N `contains` (MOTIR-8074). Each
    // `LIKE '%needle%'` term is its own full pass over every body in the project,
    // so N needles cost N scans — measured at 7.4 s for 26 absent needles and
    // 53 s for 200 over 8,000 × 14 KB bodies, past the 5 s transaction budget. The
    // alternation is compiled to one automaton and read in a single pass (0.8 s /
    // 2.1 s on the same data). The paths this is asked about are, by construction,
    // mostly ABSENT files, which is the worst case for the `OR` form.
    const pattern = needles.map(escapeRegexLiteral).join('|');
    return client.$queryRaw<
      Array<{
        id: string;
        identifier: string;
        status: string;
        descriptionMd: string | null;
        targetRepos: string[];
      }>
    >`
      SELECT w."id", w."identifier", w."status", w."descriptionMd", w."targetRepos"
        FROM "work_item" w
        WHERE w."projectId" = ${projectId}
          AND w."workspaceId" = ${workspaceId}
          AND w."archivedAt" IS NULL
          AND w."triagedAt" IS NULL
          AND NOT (w."status" = ANY(${[...excludeStatuses]}::text[]))
          AND w."descriptionMd" ~ ${pattern}`;
  },

  /**
   * The `descriptionMd` of MANY work items in ONE query — the body text the
   * prose-vs-graph advisory (MOTIR-1969) scans for `motir:` reference tokens.
   * Deliberately its OWN narrow read rather than a column bolted onto the
   * validity CTE / project-wide validity load: descriptions are long, and those
   * two reads are sized by the whole subtree / whole project, so widening them
   * would balloon a payload most callers never look at. This one is sized by the
   * NOT-DONE members actually scanned. Workspace-gated (finding #26); read-only
   * path → `db` singleton; an empty id set short-circuits.
   */
  async findDescriptionsByIds(
    ids: string[],
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<
    Array<{
      id: string;
      descriptionMd: string | null;
      /** The second stored body, scanned for mislabelled links (MOTIR-9938). */
      explanationMd: string | null;
      /** The row's kind — the section registry's first coordinate (MOTIR-9032). */
      kind: string;
      type: string | null;
      executor: string | null;
      targetRepo: string | null;
      targetRepos: string[];
      createdAt: Date;
      storyPoints: number | null;
      estimateMinutes: number | null;
      hasChildren: boolean;
    }>
  > {
    if (ids.length === 0) return [];
    // `type` / `executor` ride along for the prose advisory's ORDERING exemption
    // (MOTIR-2175), `targetRepo` + `targetRepos` for the REPO-STRADDLE check's
    // carried side (MOTIR-2177, widened to the SET in MOTIR-2728), `createdAt`
    // for the SUBSUMPTION check's `since` (MOTIR-2903 — "merged AFTER this card was
    // filed" is half that rule), and the two sizing columns plus a live child
    // count for the ESTIMATION-GATE check (MOTIR-3110) — the same rows, a few
    // columns wider, rather than more reads.
    //
    // The child count is FILTERED to non-archived children, so an item whose
    // only children were archived reads as the leaf it now is — the same live
    // slice `findSubtreeMembersForValidity` walks, rather than a second opinion
    // about what a child is.
    const client = tx ?? dbRead;
    const rows = await client.workItem.findMany({
      where: { id: { in: ids }, workspaceId },
      select: {
        id: true,
        descriptionMd: true,
        explanationMd: true,
        kind: true,
        type: true,
        executor: true,
        targetRepo: true,
        targetRepos: true,
        createdAt: true,
        estimateMinutes: true,
        // `Decimal(6, 2)` on the wire; every other reader of this column maps it
        // with `Number(...)` (`lib/mappers/workItemMappers.ts`), so it is mapped
        // HERE rather than leaking a Decimal into a pure numeric comparison.
        storyPoints: true,
        _count: { select: { children: { where: { archivedAt: null } } } },
      },
    });
    return rows.map(({ _count, storyPoints, ...row }) => ({
      ...row,
      storyPoints: storyPoints === null ? null : Number(storyPoints),
      hasChildren: _count.children > 0,
    }));
  },

  /**
   * The WORK TYPE of many work items by id, within one workspace — the leanest
   * possible read, for the SELF-BLOCKING-DESIGN advisory's edge half
   * (MOTIR-3625): *does this card carry a `blocked_by` edge to a `type: design`
   * item?*
   *
   * Deliberately NOT {@link findDescriptionsByIds}. That one is keyed to the
   * cards being SCANNED and drags every body, both sizing columns and a child
   * count with it; the blockers are a different, often larger set and this
   * question needs one nullable string per row. Workspace-scoped like its
   * neighbour so a cross-tenant id simply does not come back, read-only path →
   * `db` singleton, and an empty input short-circuits so we never issue a
   * degenerate `IN ()`.
   */
  async findTypesByIds(
    ids: string[],
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Array<{ id: string; type: string | null }>> {
    if (ids.length === 0) return [];
    const client = tx ?? dbRead;
    return client.workItem.findMany({
      where: { id: { in: ids }, workspaceId },
      select: { id: true, type: true },
    });
  },

  /**
   * The identifier, TITLE and filing instant of MANY work items in ONE query —
   * the CONTAINER-COVERAGE advisory's child side (MOTIR-5362), which judges
   * ownership off a child's title and adoption off its `createdAt`.
   *
   * Deliberately NOT {@link findDescriptionsByIds}: that one drags every body,
   * and the coverage check reads no child body at all (the measurement on
   * MOTIR-5362 is why). Workspace-scoped like its neighbours, read-only path, and
   * an empty input short-circuits.
   */
  async findTitlesByIds(
    ids: string[],
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Array<{ id: string; identifier: string; title: string; createdAt: Date }>> {
    if (ids.length === 0) return [];
    const client = tx ?? dbRead;
    return client.workItem.findMany({
      where: { id: { in: ids }, workspaceId },
      select: { id: true, identifier: true, title: true, createdAt: true },
    });
  },

  /**
   * Per-kind count of the LIVE (non-archived) DESCENDANTS of a subtree, in ONE
   * round-trip via a recursive CTE (Story 2.9 · Subtask 2.9.9). The root is
   * EXCLUDED (`depth > 1`) and only rows with `archivedAt IS NULL` are counted,
   * so this is the live slice of `findSubtree` the delete-preview reports
   * alongside the full cascade count: archiving is single-node, so an archived
   * parent can still own live descendants a cascade delete would destroy.
   * `kind` is cast to text (the plain enum label); `count` is cast to `int` so
   * `$queryRaw` returns a JS number rather than a Postgres `bigint`. Kinds with
   * zero live descendants simply do not appear (GROUP BY emits matched rows
   * only) — the service folds the rows into the DTO's `liveByKind` map.
   */
  async countLiveDescendantsByKind(
    rootId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Array<{ kind: WorkItemKind; count: number }>> {
    const client = tx ?? dbRead;
    return client.$queryRaw<Array<{ kind: WorkItemKind; count: number }>>`
      WITH RECURSIVE subtree AS (
        SELECT w."id", w."parentId", w."kind", w."archivedAt", 1 AS depth
          FROM "work_item" w
          WHERE w."id" = ${rootId}
        UNION ALL
        SELECT w."id", w."parentId", w."kind", w."archivedAt", s.depth + 1
          FROM "work_item" w
          JOIN subtree s ON w."parentId" = s."id"
      )
      SELECT "kind"::text AS "kind", COUNT(*)::int AS "count"
        FROM subtree
        WHERE depth > 1
          AND "archivedAt" IS NULL
        GROUP BY "kind"`;
  },

  /**
   * The roadmap PROGRESS roll-up (Subtask 7.20.6 / MOTIR-1013) for a set of
   * container roots, in ONE recursive-CTE round-trip. For each root in
   * `rootIds`, counts its LIVE (non-archived) DESCENDANTS (the root EXCLUDED,
   * `depth > 1`), attributing every descendant to its originating root carried
   * down the recursion:
   *  - `total` — descendants whose status is NOT the sealed `excludedStatusKey`
   *    (`cancelled`), so a container whose only remnants are cancelled isn't held
   *    permanently incomplete;
   *  - `done`  — descendants whose status is one of `doneStatusKeys` (the
   *    `done`-category keys except cancelled, which the service computes).
   * A root with no live descendants simply does not appear in the result (the
   * GROUP BY emits matched rows only) → the service treats it as `0 / 0`. Counts
   * are cast to `int` so `$queryRaw` returns JS numbers, not Postgres `bigint`.
   * Empty `rootIds` short-circuits to `[]` (never a degenerate `= ANY('{}')`).
   */
  async countRoadmapProgress(
    rootIds: string[],
    doneStatusKeys: string[],
    excludedStatusKey: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Array<{ rootId: string; total: number; done: number; verified: number }>> {
    if (rootIds.length === 0) return [];
    const client = tx ?? dbRead;
    // `verified` (Subtask 7.10.6 / MOTIR-894) rides the SAME recursive CTE as
    // done/total — the Story-level "N of M verified" roll-up is NOT a parallel
    // aggregation, it is one extra `COUNT(... FILTER)` over the subtree that
    // already computed the progress meter. A descendant counts as verified when
    // its CI signal is `'passing'` (a merged-AND-checks-passed leaf), the same
    // `depth > 1`, non-archived, non-cancelled frame as `total`.
    return client.$queryRaw<
      Array<{ rootId: string; total: number; done: number; verified: number }>
    >`
      WITH RECURSIVE subtree AS (
        SELECT w."id", w."parentId", w."status", w."ciState", w."archivedAt", w."id" AS root_id, 1 AS depth
          FROM "work_item" w
          WHERE w."id" = ANY(${rootIds})
        UNION ALL
        SELECT w."id", w."parentId", w."status", w."ciState", w."archivedAt", s.root_id, s.depth + 1
          FROM "work_item" w
          JOIN subtree s ON w."parentId" = s."id"
      )
      SELECT root_id AS "rootId",
             COUNT(*) FILTER (WHERE "status" <> ${excludedStatusKey})::int AS "total",
             COUNT(*) FILTER (WHERE "status" = ANY(${doneStatusKeys}))::int  AS "done",
             COUNT(*) FILTER (WHERE "status" <> ${excludedStatusKey}
                                AND "ciState" = 'passing')::int             AS "verified"
        FROM subtree
        WHERE depth > 1
          AND "archivedAt" IS NULL
        GROUP BY root_id`;
  },

  /**
   * The ANCESTOR chain of a work item — its parent, grandparent, … up to the
   * root — in ONE round-trip via a recursive CTE walking UP the `parentId`
   * edge (the inverse of `findSubtree`). Excludes the item itself; returns the
   * ancestors ordered ROOT→self (the immediate parent LAST), which is the order
   * the detail-page breadcrumb renders (Subtask 2.4.3). The walk is naturally
   * bounded — it stops at the root (`parentId IS NULL`) and the tree depth is
   * capped at 4 (Story 1.4) — so this is a short, fixed-length parent walk, not
   * an unbounded recursion.
   *
   * `workspaceId` is filtered on BOTH the anchor and the recursive step, so a
   * cross-workspace ancestor can never leak into the chain (the primary tenant
   * gate per finding #26 — RLS is inert under the dev/CI superuser). `w.*`
   * carries every WorkItem column so the service maps each ancestor with the
   * shared `toWorkItemSummaryDto`; the CTE-internal `depth` only orders the
   * result and is ignored by the caller.
   */
  async findAncestors(
    itemId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItem[]> {
    const client = tx ?? dbRead;
    return client.$queryRaw<WorkItem[]>`
      WITH RECURSIVE ancestors AS (
        SELECT w.*, 0 AS depth
          FROM "work_item" w
          WHERE w."id" = ${itemId} AND w."workspaceId" = ${workspaceId}
        UNION ALL
        SELECT p.*, a.depth + 1
          FROM "work_item" p
          JOIN ancestors a ON p."id" = a."parentId"
          WHERE p."workspaceId" = ${workspaceId}
      )
      SELECT * FROM ancestors WHERE depth > 0 ORDER BY depth DESC`;
  },

  /**
   * Batch ancestor walk (Subtask 7.0.13) — for EACH of `itemIds`, the ids of all
   * its ancestors (parent → grandparent → … → root). The readiness cascade gates
   * a node on its whole ancestor chain (a leaf is ready only if every ancestor is
   * ready too), and the batch readiness path must resolve those chains for many
   * items WITHOUT an N+1 — so this is the multi-seed analogue of `findAncestors`:
   * ONE recursive CTE seeded from the full id set, emitting a `(seedId,
   * ancestorId)` row per ancestor. An item with no parent contributes no row and
   * maps to `[]`. `workspaceId` is filtered on BOTH the anchor and the recursive
   * step so a cross-workspace ancestor can never enter a chain (the finding-#26
   * tenant gate, mirroring `findAncestors`). Depth is tree-capped at 4 (Story
   * 1.4), so the recursion is short and bounded. Read-only → `db` singleton.
   */
  async findAncestorIdsForItems(
    itemIds: string[],
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Map<string, string[]>> {
    const byItem = new Map<string, string[]>(itemIds.map((id) => [id, []]));
    if (itemIds.length === 0) return byItem;
    const client = tx ?? dbRead;
    const rows = await client.$queryRaw<Array<{ seedId: string; ancestorId: string }>>`
      WITH RECURSIVE chain AS (
        SELECT w."id" AS "seedId", w."parentId" AS "ancestorId"
          FROM "work_item" w
          WHERE w."id" IN (${Prisma.join(itemIds)})
            AND w."workspaceId" = ${workspaceId}
            AND w."parentId" IS NOT NULL
        UNION ALL
        SELECT c."seedId", p."parentId" AS "ancestorId"
          FROM "work_item" p
          JOIN chain c ON p."id" = c."ancestorId"
          WHERE p."workspaceId" = ${workspaceId}
            AND p."parentId" IS NOT NULL
      )
      SELECT "seedId", "ancestorId" FROM chain`;
    for (const r of rows) {
      const arr = byItem.get(r.seedId);
      if (arr) arr.push(r.ancestorId);
    }
    return byItem;
  },

  /**
   * The DIRECT children of a set of parents with each child's KIND, in ONE
   * round-trip — what a plan `modify` that RE-KINDS its target is judged against
   * (bug MOTIR-8192): the new kind must legally parent every child the target
   * keeps, the question `findChildren` answers for one item on the direct
   * `updateWorkItem` path. Same read-exclusion as {@link findChildren}: ARCHIVED
   * and TRIAGE children are not children. `workspaceId`-gated. Empty
   * `parentIds` short-circuits to `[]`.
   */
  async findChildKindsForItems(
    parentIds: string[],
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<
    Array<{ parentId: string; id: string; identifier: string; title: string; kind: WorkItemKind }>
  > {
    if (parentIds.length === 0) return [];
    const client = tx ?? dbRead;
    const rows = await client.workItem.findMany({
      where: { parentId: { in: parentIds }, workspaceId, archivedAt: null, triagedAt: null },
      select: { id: true, parentId: true, identifier: true, title: true, kind: true },
      orderBy: { position: 'asc' },
    });
    return rows.map((r) => ({
      parentId: r.parentId as string,
      id: r.id,
      identifier: r.identifier,
      title: r.title,
      kind: r.kind,
    }));
  },

  /**
   * The DIRECT children of a set of parents, in ONE round-trip — the
   * parent→child completion dependency the sprint-finishability check walks
   * (`validate_sprint`). A parent can only be finished once ALL its children
   * are done, so each not-done in-sprint parent is gated by any child that is
   * neither done nor also in the sprint — exactly as an unsatisfied
   * `blocked_by` edge gates an item (mirrors {@link findBlockerEdgesForItems}).
   * Each row carries the child's IDENTITY (`childId` for the in-sprint
   * membership test, `childKey` to NAME it), its `childStatus`/`childProjectId`
   * (done-ness against the child's OWN project terminal set) and `childSprintId`
   * (in-sprint?). ARCHIVED and TRIAGE children are EXCLUDED (the same
   * read-exclusion as {@link findChildren}), so a soft-removed or triage item
   * never phantom-gates a sprint. `workspaceId`-gated (finding #26). Empty
   * `parentIds` short-circuits to `[]`. Read-only → `db` singleton.
   */
  async findChildrenForItems(
    parentIds: string[],
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<
    Array<{
      parentId: string;
      childId: string;
      childKey: string;
      childStatus: string;
      childSprintId: string | null;
      childProjectId: string;
    }>
  > {
    if (parentIds.length === 0) return [];
    const client = tx ?? dbRead;
    const rows = await client.workItem.findMany({
      where: {
        parentId: { in: parentIds },
        workspaceId,
        archivedAt: null,
        triagedAt: null,
      },
      select: {
        id: true,
        parentId: true,
        identifier: true,
        status: true,
        sprintId: true,
        projectId: true,
      },
    });
    return rows.map((r) => ({
      parentId: r.parentId as string,
      childId: r.id,
      childKey: r.identifier,
      childStatus: r.status,
      childSprintId: r.sprintId,
      childProjectId: r.projectId,
    }));
  },

  /**
   * The WHOLE non-archived issue forest of a project, in ONE round-trip via a
   * recursive CTE walking DOWN the `parentId` edge from the roots
   * (`parentId IS NULL`). Each row carries its `depth` (root = 1, for the
   * tree-table's indentation) and the lighter render columns (no Markdown
   * blobs). Backs `workItemsService.getProjectTree` (Subtask 2.5.1) — the read
   * behind the `/items` list view.
   *
   * `workspaceId` is filtered on BOTH the anchor and the recursive step (plus
   * `projectId` on both), so a cross-workspace/-project row can never enter the
   * forest even with RLS inert under the dev/CI superuser — the primary tenant
   * gate per finding #26 (mirrors `findAncestors` / `findByProjectAndKinds`).
   *
   * The optional `filter` is applied NON-destructively: it does NOT remove rows
   * (a flat `WHERE` would orphan children); instead every returned row carries a
   * `matched` boolean — true when it satisfies every supplied filter axis (an
   * empty filter marks all rows matched). The service nests the forest and, when
   * a filter is active, prunes to matched-or-has-matched-descendant so a match
   * keeps its ancestor chain for context. Each axis is a bound-param
   * `Prisma.Sql` fragment (never string-interpolated); `assigneeId: null`
   * filters to UNASSIGNED via `IS NOT DISTINCT FROM`; `text` is an escaped
   * case-insensitive `ILIKE` over identifier + title.
   */
  async findProjectForest(
    projectId: string,
    workspaceId: string,
    filter: RepoIssueFilter = {},
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItemForestRow[]> {
    const client = tx ?? dbRead;
    // The facet axes, as a bound-param predicate over the forest alias `f`
    // (shared with the flat List read — see buildIssueFilterSql). The 6.1.1
    // AST axis is stripped here and compiled over a joined full `work_item`
    // row instead: the CTE's fixed projection lacks the columns the builder
    // can reference (`sprintId` / `createdAt` / `descriptionMd`), and
    // re-projecting Markdown blobs through the recursion would bloat it.
    const { ast, filterReferents, ...facetAxes } = filter;
    const facetMatched = buildIssueFilterSql(facetAxes, 'f');
    const hasAst = ast !== undefined && ast.conditions.length > 0;
    // COALESCE the combined expression: unlike a WHERE (where NULL means
    // unmatched for free), this is PROJECTED as the `matched` boolean column,
    // and AST arms over nullable columns (text contains, number comparisons)
    // can yield SQL NULL — which must surface as `false`, not a null DTO field.
    const matched = hasAst
      ? Prisma.sql`COALESCE((${facetMatched}) AND (${compileFilterConditionsSql(ast, filterReferents)}), FALSE)`
      : facetMatched;
    const astJoin = hasAst ? Prisma.sql`JOIN "work_item" w ON w."id" = f."id"` : Prisma.empty;

    return client.$queryRaw<WorkItemForestRow[]>`
      WITH RECURSIVE forest AS (
        SELECT w."id", w."parentId", w."kind", w."type", w."key", w."identifier",
               w."title", w."status", w."ciState", w."fixReason", w."priority", w."assigneeId", w."reporterId",
               w."dueDate", w."estimateMinutes", w."storyPoints", w."updatedAt",
               ${hasDescriptionSql('w')} AS "hasDescription",
               w."obsolescence", w."obsolescenceNoteMd", w."publicChildrenHidden", 1 AS depth
          FROM "work_item" w
          WHERE w."projectId" = ${projectId}
            AND w."workspaceId" = ${workspaceId}
            AND w."parentId" IS NULL
            AND w."archivedAt" IS NULL
            AND ${notInTriageSql('w')}
            AND ${notExcludedSql('w', filter.excludeIds)}
        UNION ALL
        SELECT c."id", c."parentId", c."kind", c."type", c."key", c."identifier",
               c."title", c."status", c."ciState", c."fixReason", c."priority", c."assigneeId", c."reporterId",
               c."dueDate", c."estimateMinutes", c."storyPoints", c."updatedAt",
               ${hasDescriptionSql('c')} AS "hasDescription",
               c."obsolescence", c."obsolescenceNoteMd", c."publicChildrenHidden", p.depth + 1
          FROM "work_item" c
          JOIN forest p ON c."parentId" = p."id"
          WHERE c."projectId" = ${projectId}
            AND c."workspaceId" = ${workspaceId}
            AND c."archivedAt" IS NULL
            AND ${notInTriageSql('c')}
            AND ${notExcludedSql('c', filter.excludeIds)}
      )
      SELECT f."id",
             f."parentId",
             f."kind"::text       AS "kind",
             f."type"::text       AS "type",
             f."key",
             f."identifier",
             f."title",
             f."status",
             f."ciState",
             f."fixReason"::text  AS "fixReason",
             f."priority"::text   AS "priority",
             f."assigneeId",
             f."reporterId",
             f."dueDate",
             f."estimateMinutes",
             f."storyPoints",
             f."updatedAt",
             f."hasDescription",
             f."obsolescence"::text AS "obsolescence",
             f."obsolescenceNoteMd",
             f."publicChildrenHidden",
             f.depth::int         AS "depth",
             (${matched})         AS "matched"
        FROM forest f
        ${astJoin}
        ORDER BY f.depth ASC, f."key" ASC`;
  },

  /**
   * The flat, sorted project read powering the List view (Subtask 2.5.8). Unlike
   * `findProjectForest` this is NON-recursive — every non-archived item in the
   * project, un-nested, ordered by the active sort column at the DB layer (a
   * flat `ORDER BY`, never JS re-nesting/flattening). Same `projectId` +
   * `workspaceId` tenant gate on the single `work_item` scan (finding #26). The
   * same `filter` axes as the forest read apply (so the List honours the 2.5.4
   * filter bar when that lands), built via the shared `buildIssueFilterSql`.
   *
   * `assignee`/`reporter` sort by the joined user's display name; `status` by
   * the project workflow's status order (the `workflow_status.position`
   * fractional index — a lexicographically-sortable string); the rest are
   * `work_item` scalar columns (`priority` orders by its enum declaration
   * lowest→highest). The sort column is whitelisted through `ISSUE_SORT_SQL` —
   * never string-interpolated — and a stable `"key" ASC` tiebreak keeps paging
   * deterministic. Read-only path → `db` singleton (optional `tx`).
   */
  async findProjectIssuesFlat(
    projectId: string,
    workspaceId: string,
    sort: IssueSort,
    filter: RepoIssueFilter = {},
    page?: { limit: number; offset: number },
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItemListRow[]> {
    const client = tx ?? dbRead;
    const orderCol = ISSUE_SORT_SQL[sort.column];
    const dir = sort.direction === 'desc' ? Prisma.sql`DESC` : Prisma.sql`ASC`;
    // Server-side window (Subtask 2.5.12): the List is LIMIT/OFFSET-paged so it
    // never ships the whole backlog. The total-order ORDER BY (sort col + the
    // `key` ASC tiebreak) makes OFFSET paging stable — no row skips/repeats.
    const limitSql = page ? Prisma.sql`LIMIT ${page.limit} OFFSET ${page.offset}` : Prisma.empty;

    return client.$queryRaw<WorkItemListRow[]>`
      SELECT w."id",
             w."kind"::text       AS "kind",
             w."type"::text       AS "type",
             w."key",
             w."identifier",
             w."title",
             w."status",
             w."ciState",
             w."fixReason"::text  AS "fixReason",
             w."priority"::text   AS "priority",
             w."assigneeId",
             w."reporterId",
             w."dueDate",
             w."estimateMinutes",
             w."storyPoints",
             w."updatedAt",
             ${hasDescriptionSql('w')} AS "hasDescription",
             w."obsolescence"::text AS "obsolescence",
             w."obsolescenceNoteMd",
             w."publicChildrenHidden"
        FROM "work_item" w
        LEFT JOIN "user" au ON au."id" = w."assigneeId"
        LEFT JOIN "user" ru ON ru."id" = w."reporterId"
        LEFT JOIN "workflow_status" ws
               ON ws."project_id" = w."projectId" AND ws."key" = w."status"
        WHERE ${projectIssuesScopeSql(projectId, workspaceId, filter)}
        ORDER BY ${orderCol} ${dir} NULLS LAST, w."key" ASC
        ${limitSql}`;
  },

  /**
   * The same project List set, KEYSET-paged (Story 11.2 · Subtask 11.2.3 —
   * MOTIR-2041) — the read `GET /api/v1/projects/{projectKey}/work-items` serves.
   *
   * Authorised by the ADR's Amendment 1 as a bounded carve-out: a new page
   * ADDRESSING over an unchanged predicate. It adds NO filter axis, NO access
   * gate, NO field and NO migration, and it leaves `findProjectIssuesFlat` and
   * every existing caller untouched, so the `/items` view and `search_work_items`
   * are unaffected.
   *
   * ⚠️ ORDER IS `(createdAt ASC, id ASC)`, and that is DELIBERATELY NOT the List
   * view's `IssueSort`. The v1 cursor encodes `{ createdAt, id }`
   * (`lib/api/v1/pagination.ts`), and it is the RESULT SET that must match the
   * web app, not the row order — a client walking a collection to exhaustion
   * cares that it sees every row exactly once, not what sequence they arrive in.
   * `(createdAt, id)` is a TOTAL order, so a position is unambiguous even when
   * timestamps collide, which is what makes the no-skip/no-duplicate guarantee
   * hold across a concurrent write. Do NOT "fix" this toward `DEFAULT_SORT`:
   * `updatedAt` and `priority` are MUTABLE, and a keyset cursor over a mutable
   * column skips and duplicates rows exactly as offset paging does.
   *
   * Fetches `limit + 1` rows to learn whether a next page exists. There is no
   * `COUNT`: a total is the offset pager's denominator and has no purpose here,
   * and it would double the cost of every page.
   */
  async findProjectIssuesKeyset(
    projectId: string,
    workspaceId: string,
    filter: RepoIssueFilter = {},
    page: { after?: { createdAt: Date; id: string }; limit: number },
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItemKeysetRow[]> {
    const client = tx ?? dbRead;
    // "Strictly after this position" in `(createdAt, id)` order — the standard
    // tuple comparison, spelled out rather than using the row-constructor form
    // so both halves bind as PARAMETERS.
    const afterSql = page.after
      ? Prisma.sql`AND (w."createdAt" > ${page.after.createdAt}
          OR (w."createdAt" = ${page.after.createdAt} AND w."id" > ${page.after.id}))`
      : Prisma.empty;

    return client.$queryRaw<WorkItemKeysetRow[]>`
      SELECT w."id",
             w."kind"::text       AS "kind",
             w."type"::text       AS "type",
             w."key",
             w."identifier",
             w."title",
             w."status",
             w."priority"::text   AS "priority",
             w."assigneeId",
             w."reporterId",
             w."dueDate",
             w."estimateMinutes",
             w."storyPoints",
             w."createdAt",
             w."updatedAt",
             ${hasDescriptionSql('w')} AS "hasDescription",
             w."obsolescence"::text AS "obsolescence",
             w."obsolescenceNoteMd"
        FROM "work_item" w
        WHERE ${projectIssuesScopeSql(projectId, workspaceId, filter)}
          ${afterSql}
        ORDER BY w."createdAt" ASC, w."id" ASC
        LIMIT ${page.limit + 1}`;
  },

  /**
   * COUNT of a project's non-archived issues matching the SAME filter axes as
   * `findProjectIssuesFlat` (Subtask 2.5.12) — the denominator of the List's
   * "1–50 of N" pager, so it tracks the active 2.5.4 filter. A single
   * `COUNT(*)` over `work_item` (no joins — the filter predicate only touches
   * `work_item` columns), the same `projectId` + `workspaceId` tenant gate
   * (finding #26). `::int` casts Postgres' `bigint` count to a JS number (a
   * project's row count is far under 2^53). Read-only path → `db` singleton.
   */
  async countProjectIssues(
    projectId: string,
    workspaceId: string,
    filter: RepoIssueFilter = {},
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = tx ?? dbRead;
    const matched = buildIssueFilterSql(filter, 'w');
    const rows = await client.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS "count"
        FROM "work_item" w
        WHERE w."projectId" = ${projectId}
          AND w."workspaceId" = ${workspaceId}
          AND w."archivedAt" IS NULL
          AND ${notInTriageSql('w')}
          AND ${notExcludedSql('w', filter.excludeIds)}
          AND (${matched})`;
    return rows[0]?.count ?? 0;
  },

  /**
   * The ARCHIVED items of a project (Subtask 2.9.2) — the inverse of the
   * pervasive `archivedAt IS NULL` row filter: a single non-recursive scan of
   * the soft-deleted (`archivedAt IS NOT NULL`) items, un-nested (archive is
   * single-node — a parent's archive does NOT cascade, so archived items are a
   * FLAT set, never a forest; this deliberately does NOT reuse the recursive
   * `findProjectForest` CTE). Same `projectId` + `workspaceId` tenant gate as
   * the active reads (finding #26) and the same triage exclusion (the public
   * submission inbox has its own surface), so this is the literal complement of
   * the `/items` list within the management views. Ordered by `archivedAt DESC`
   * (most-recently archived first) with a stable `key ASC` tiebreak so OFFSET
   * paging is deterministic, and windowed by `page` (LIMIT/OFFSET) so it never
   * ships the whole archive. The archiver is resolved in the SAME read via a
   * LATERAL pick of the latest `'archived'` revision joined to `user`. Read-only
   * path → `db` singleton.
   *
   * The projection carries EVERY `WorkItemListRow` column — `type` included
   * (MOTIR-2108, where it was missing): `$queryRaw<ArchivedWorkItemRow[]>` is an
   * UNCHECKED cast, so a column this SELECT omits is `undefined` at runtime on
   * every row rather than a compile error, and the DTO's `null`-means-container
   * contract silently breaks for the first consumer to read it.
   */
  async findArchivedByProject(
    projectId: string,
    workspaceId: string,
    page: { limit: number; offset: number },
    tx?: Prisma.TransactionClient,
  ): Promise<ArchivedWorkItemRow[]> {
    const client = tx ?? dbRead;
    return client.$queryRaw<ArchivedWorkItemRow[]>`
      SELECT w."id",
             w."kind"::text       AS "kind",
             w."type"::text       AS "type",
             w."key",
             w."identifier",
             w."title",
             w."status",
             w."ciState",
             w."fixReason"::text  AS "fixReason",
             w."priority"::text   AS "priority",
             w."assigneeId",
             w."reporterId",
             w."dueDate",
             w."estimateMinutes",
             w."storyPoints",
             w."updatedAt",
             ${hasDescriptionSql('w')} AS "hasDescription",
             w."obsolescence"::text AS "obsolescence",
             w."obsolescenceNoteMd",
             w."archivedAt",
             ar."changedById"     AS "archivedById",
             abu."name"           AS "archivedByName",
             abu."image"          AS "archivedByImage"
        FROM "work_item" w
        LEFT JOIN LATERAL (
          SELECT r."changedById"
            FROM "work_item_revision" r
            WHERE r."workItemId" = w."id"
              AND r."changeKind" = 'archived'
            ORDER BY r."changedAt" DESC
            LIMIT 1
        ) ar ON TRUE
        LEFT JOIN "user" abu ON abu."id" = ar."changedById"
        WHERE w."projectId" = ${projectId}
          AND w."workspaceId" = ${workspaceId}
          AND w."archivedAt" IS NOT NULL
          AND ${notInTriageSql('w')}
        ORDER BY w."archivedAt" DESC, w."key" ASC
        LIMIT ${page.limit} OFFSET ${page.offset}`;
  },

  /**
   * COUNT of a project's ARCHIVED items (Subtask 2.9.2) — the denominator of the
   * archive view's pager, the same `projectId` + `workspaceId` + triage gate as
   * {@link findArchivedByProject} but counting the `archivedAt IS NOT NULL` set.
   * `::int` casts Postgres' `bigint`. Read-only path → `db` singleton.
   */
  async countArchivedByProject(
    projectId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = tx ?? dbRead;
    const rows = await client.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS "count"
        FROM "work_item" w
        WHERE w."projectId" = ${projectId}
          AND w."workspaceId" = ${workspaceId}
          AND w."archivedAt" IS NOT NULL
          AND ${notInTriageSql('w')}`;
    return rows[0]?.count ?? 0;
  },

  /**
   * COUNT of a project's LIVE (non-archived) work items — the denominator of
   * `coverage` on the semantic candidate-finder (Story MOTIR-2694 · Subtask
   * MOTIR-2697, `docs/decisions/plan-tree-embeddings.md` §6.1).
   *
   * ⚠️ ITS PREDICATE IS DELIBERATELY THE EMBEDDING-RANK PREDICATE MINUS THE
   * EMBEDDING JOIN, and that is why it is NOT
   * {@link countProjectIssues}/{@link countArchivedByProject}'s shape: those two
   * also exclude TRIAGE rows, and the embedding write path does not — a triaged
   * item is embedded like any other, so it is counted by
   * `workItemEmbeddingRepository.countRankable`. Reusing a triage-excluding count
   * as the denominator would let `embedded` exceed `total` in any project with a
   * triage queue, which is the one thing a coverage RATIO must never do. The pair
   * is composed in `aiBoundaryService.findSimilarWorkItems`; change one predicate
   * and you must change the other.
   *
   * `::int` casts Postgres' `bigint`. Takes the caller's `tx` because it is read
   * inside the ranking transaction, under the workspace GUC that RLS reads.
   */
  async countLiveByProject(
    projectId: string,
    workspaceId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS "count"
        FROM "work_item" w
        WHERE w."projectId" = ${projectId}
          AND w."workspaceId" = ${workspaceId}
          AND w."archivedAt" IS NULL`;
    return rows[0]?.count ?? 0;
  },

  /**
   * Count a project's non-archived, non-triage work items grouped by workflow
   * status CATEGORY (Story 6.12 · Subtask 6.12.4) — the Overview stat strip's
   * Planned / In progress / Shipped denominators, in ONE aggregate (no
   * per-category round-trip). Joins `workflow_status` to resolve each item's
   * `status` key → its category (`todo` / `in_progress` / `done`); an item whose
   * status maps to no live workflow status falls outside every bucket (omitted),
   * same as the board's unmapped handling. The explicit `workspaceId` gate is
   * the app-layer tenancy check atop RLS (finding #26). Read-only → `db`
   * singleton. Returns a per-category count map (absent categories ⇒ 0).
   */
  async countByStatusCategory(
    projectId: string,
    workspaceId: string,
    opts: { excludeIds?: readonly string[] } = {},
    tx?: Prisma.TransactionClient,
  ): Promise<{ todo: number; in_progress: number; done: number }> {
    const client = tx ?? dbRead;
    const rows = await client.$queryRaw<Array<{ category: string; count: number }>>`
      SELECT ws."category"::text AS "category", COUNT(*)::int AS "count"
        FROM "work_item" w
        JOIN "workflow_status" ws
          ON ws."project_id" = w."projectId" AND ws."key" = w."status"
        WHERE w."projectId" = ${projectId}
          AND w."workspaceId" = ${workspaceId}
          AND w."archivedAt" IS NULL
          AND ${notInTriageSql('w')}
          AND ${notExcludedSql('w', opts.excludeIds)}
        GROUP BY ws."category"`;
    const out = { todo: 0, in_progress: 0, done: 0 };
    for (const r of rows) {
      if (r.category === 'todo' || r.category === 'in_progress' || r.category === 'done') {
        out[r.category] = r.count;
      }
    }
    return out;
  },

  /**
   * The DIRECT-children status aggregate behind the upward status rollup (Story
   * MOTIR-1615 · Subtask MOTIR-1619; `docs/decisions/status-derivation.md` §3) —
   * exactly the counts the ladder evaluates, in ONE round-trip, so a parent with
   * hundreds of children costs one aggregate rather than a row load.
   *
   * DIRECT children only (`parentId = ?`), never the subtree — the rollup
   * transitions one level and lets re-emission carry the next, so a subtree
   * aggregate would answer the wrong question. Contrast `countRoadmapProgress`,
   * which IS a subtree roll-up.
   *
   * Buckets come from the project's OWN `workflow_status.category`, joined on the
   * status key, so a team that renamed or added statuses still aggregates
   * correctly — no hardcoded key list. The exceptions are `inReview` and
   * `implemented`, NEITHER of which can be derived from the category (both share
   * the `in_progress` one): the CALLER resolves which status means each for this
   * project — through the same `workflowsService.resolveStatusKey` the rest of the
   * derivation uses — and passes both keys here. `inProgress` then EXCLUDES those
   * children, so the three buckets partition the `in_progress` category. Pass
   * `null` for either when the project's workflow has no such status: that bucket
   * is 0 and those children count under `inProgress`, which is the correct
   * degenerate reading (that project simply never reaches that rung).
   *
   * ⚠️ `implemented` JOINED THE SPLIT IN MOTIR-3229, and the reason is the same
   * one that put `inReview` here — one rung further along the loop. `implemented`
   * (MOTIR-3003) is what a run sets when it has pushed and opened a pull request,
   * so "every child is implemented" is the precise state a story run ends in, and
   * while it collapsed into `inProgress` the ladder could not express it at all:
   * MOTIR-1343 claimed `implemented`, then `in_review`, then `done` over two
   * `todo` children, and the merge cascaded both closed. A caller that only wants
   * the shipped four buckets passes `implementedStatusKey: null` and gets exactly
   * the previous behaviour.
   *
   * Excludes archived + triage rows, the uniform child-read exclusion
   * `findChildren` applies. Read-only → `db` singleton unless a `tx` is supplied
   * (the rollup reads it inside the transaction that locked the parent).
   *
   * The category join is an INNER join, so a child whose `status` resolves to no
   * `workflow_status` row is not counted at all — it would otherwise land in no
   * bucket while still inflating `total`, and a bucket-less child can only make
   * the ladder's "every child is done" test unanswerable. No live row can reach
   * that state: every item is created in the workflow's initial status, and a
   * status that is IN USE cannot be deleted (`workflowsService.deleteStatus`).
   *
   * `lastChangedAt` (MOTIR-2965) rides along because it answers a question about
   * the SAME set in the SAME round-trip: WHEN did this child set last change?
   * The backward arm of the recompute compares it against the parent's own last
   * status change, so that a derived claim about these children cannot overwrite
   * a status a person set knowing about them. It is `MAX(GREATEST(createdAt,
   * updatedAt))` over the live children and `null` for an empty set — which is
   * the same set the counts describe, deliberately: a row that LEFT the set
   * (archived, re-parented, deleted) is invisible here, which is exactly why the
   * child-set triggers pass their own instant instead (ADR §5).
   */
  async aggregateChildrenStatus(
    parentId: string,
    ladderKeys: {
      reviewStatusKey: string | null;
      implementedStatusKey: string | null;
      approvedStatusKey?: string | null;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<{
    total: number;
    todo: number;
    inProgress: number;
    implemented: number;
    inReview: number;
    approved: number;
    done: number;
    lastChangedAt: Date | null;
  }> {
    const client = tx ?? dbRead;
    const { reviewStatusKey, implementedStatusKey } = ladderKeys;
    // MOTIR-5140. OPTIONAL on the parameter so a caller that predates the rung
    // keeps compiling and keeps its old answer — `null` buckets nothing, which
    // is exactly how a project without the `approved` backfill behaves.
    const approvedStatusKey = ladderKeys.approvedStatusKey ?? null;
    const rows = await client.$queryRaw<
      Array<{
        category: string;
        is_review: boolean;
        is_implemented: boolean;
        is_approved: boolean;
        count: number;
        last_changed_at: Date | null;
      }>
    >`
      SELECT ws."category"::text AS "category",
             (${reviewStatusKey}::text IS NOT NULL AND w."status" = ${reviewStatusKey}::text)
               AS "is_review",
             (${implementedStatusKey}::text IS NOT NULL
               AND w."status" = ${implementedStatusKey}::text)
               AS "is_implemented",
             (${approvedStatusKey}::text IS NOT NULL
               AND w."status" = ${approvedStatusKey}::text)
               AS "is_approved",
             COUNT(*)::int AS "count",
             MAX(GREATEST(w."createdAt", w."updatedAt")) AS "last_changed_at"
        FROM "work_item" w
        JOIN "workflow_status" ws
          ON ws."project_id" = w."projectId" AND ws."key" = w."status"
        WHERE w."parentId" = ${parentId}
          AND w."archivedAt" IS NULL
          AND ${notInTriageSql('w')}
        GROUP BY ws."category", "is_review", "is_implemented", "is_approved"`;

    const out = {
      total: 0,
      todo: 0,
      inProgress: 0,
      implemented: 0,
      inReview: 0,
      approved: 0,
      done: 0,
      lastChangedAt: null as Date | null,
    };
    for (const r of rows) {
      out.total += r.count;
      // The NEWEST edit to the live child SET, folded across the GROUP BY's
      // per-category rows (MOTIR-2965). It is what a backward derivation's claim
      // is dated FROM: a parent status written after it was written by someone
      // who already knew about these children. `updatedAt` is the honest signal —
      // a transition, an archive-in and an ordinary field edit all bump it, and
      // over-freshness merely leaves the shipped behaviour in place, whereas
      // under-freshness would suppress a legitimate recompute.
      if (r.last_changed_at && (!out.lastChangedAt || r.last_changed_at > out.lastChangedAt)) {
        out.lastChangedAt = r.last_changed_at;
      }
      // A review status is reported as `inReview` whatever category it sits in —
      // it is the caller's declared review stage, and splitting it out is the
      // entire reason this method takes the key.
      //
      // ⚠️ `implemented` is split out the SAME WAY, and for the same reason
      // (Bug MOTIR-3229). It is an `in_progress`-category status, so without its
      // own bucket a parent whose children are all implemented is indistinguishable
      // from one whose children merely STARTED — which is exactly why the ladder
      // could not express "everything below me is built" and a container could
      // claim `implemented` over `todo` children. REVIEW takes precedence on the
      // (pathological) project that aliased both onto one key, matching
      // `rankOfStatus`'s ordering in `lib/workItems/statusLadder.ts`.
      //
      // ⚠️ AND `inProgress` NO LONGER COUNTS THEM. A reader asking "has any child
      // started?" must ask `inProgress > 0 || implemented > 0 || inReview > 0` —
      // the same obligation the review split already imposed, now on two buckets.
      // ⚠️ APPROVED IS TESTED FIRST (MOTIR-5140), which is the same
      // higher-rung-wins precedence `rankOfStatus` uses — the two orderings are
      // one decision and must not drift. `approved` outranks `in_review`, so on
      // the pathological project that aliased them onto one key this bucket
      // claims the row.
      if (r.is_approved) out.approved += r.count;
      else if (r.is_review) out.inReview += r.count;
      else if (r.is_implemented) out.implemented += r.count;
      else if (r.category === 'todo') out.todo += r.count;
      else if (r.category === 'in_progress') out.inProgress += r.count;
      else if (r.category === 'done') out.done += r.count;
    }
    return out;
  },

  /**
   * Count a project's TRIAGE-queued items (Story 6.12 · Subtask 6.12.4) — the
   * Overview "Public requests" stat. Triage items are the submission inbox
   * (`triagedAt IS NOT NULL`), which 6.12.5's public submit feeds; today this is
   * typically 0. Archived items are excluded. Read-only → `db` singleton.
   */
  async countTriageItems(
    projectId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = tx ?? dbRead;
    return client.workItem.count({
      where: { projectId, workspaceId, archivedAt: null, triagedAt: { not: null } },
    });
  },

  /**
   * The BOUNDED card set of a board column (Subtask 3.1.4 / 3.8.2, finding #57):
   * a project's non-archived work items whose `status` is one of `statusKeys`
   * (the column's mapped statuses), ordered for the board and capped with `take`
   * so the projection never ships an unbounded column. `order` is whitelisted
   * (NOT user input): `'position'` ranks by the board rank (`position` asc — the
   * fractional-index string sorts lexicographically) for an active column;
   * `'recent'` orders by `updatedAt` desc for a terminal (done) column, so its
   * bounded window is the most-recent work. A stable `key` asc tiebreak keeps
   * the order total/deterministic.
   *
   * `opts.limit` caps the load at the board-level cap (Subtask 3.8.2 — there is
   * no more per-column cursor paging; the whole bounded set loads at once and
   * virtualizes client-side). `opts.updatedSince`, when present, applies the
   * **Done-age window** (3.8.2): only cards touched on/after that instant load —
   * the age-based shape Jira uses for terminal columns, while the FULL count is
   * still surfaced separately via `countProjectIssues`. The explicit `projectId`
   * + `workspaceId` gate is the app-layer tenancy check atop RLS (finding #26).
   * Empty `statusKeys` short-circuits to `[]` (a column mapping no live status
   * has no cards). Read-only → `db` singleton (optional `tx`).
   */
  async findColumnCards(
    projectId: string,
    workspaceId: string,
    statusKeys: string[],
    order: 'position' | 'recent',
    opts: {
      limit: number;
      updatedSince?: Date;
      sprintId?: string;
      // The advanced board filter (Story 6.15.2) — a compiled FilterAST AND-ed
      // into the card read so a column shows ONLY matching cards. Omitted on the
      // unfiltered board (the byte-for-byte 3.8.2 builder read below).
      ast?: FilterAst;
      referents?: ProjectFilterReferents;
      // Epic-privacy public exclusion (Story 6.14 · Subtask 6.14.4) — drop
      // descendants of a private epic for a non-member viewer (resolved by
      // `findPublicHiddenDescendantIds`). Absent/empty ⇒ no clause (the internal
      // board + the no-private-epic case read the unchanged projection).
      excludeIds?: readonly string[];
    },
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItem[]> {
    if (statusKeys.length === 0) return [];
    const client = tx ?? dbRead;

    // Advanced filter active (Story 6.15.2): AND the compiled FilterAST (alias
    // `w`) into the column read. The AST can't be expressed through the Prisma
    // query builder — it compiles to a parameterized SQL fragment over the full
    // row (incl. the 6.1.2 label/component/custom-field EXISTS probes) — so we
    // resolve the matching, ordered, capped ids in ONE raw query that applies
    // the SAME base predicates as the builder path, then hydrate the real
    // `WorkItem` rows through the builder (keeping the row type exact for the
    // board mapper) and restore the raw query's order. No AST → the existing
    // builder read, byte-for-byte the 3.8.2 projection (no regression).
    if (opts.ast && opts.ast.conditions.length > 0) {
      const orderSql =
        order === 'recent'
          ? Prisma.sql`w."updatedAt" DESC, w."key" ASC`
          : Prisma.sql`w."position" ASC, w."key" ASC`;
      // Bind the cutoff as a JS Date param (never SQL NOW()) so the comparison
      // stays timestamptz-correct, mirroring `aggregateCreatedByBucket`.
      const updatedSinceSql = opts.updatedSince
        ? Prisma.sql`AND w."updatedAt" >= ${opts.updatedSince}`
        : Prisma.empty;
      const sprintScope = opts.sprintId
        ? Prisma.sql`AND w."sprintId" = ${opts.sprintId}`
        : Prisma.empty;
      const idRows = await client.$queryRaw<Array<{ id: string }>>`
        SELECT w."id"
          FROM "work_item" w
          WHERE w."projectId" = ${projectId}
            AND w."workspaceId" = ${workspaceId}
            AND w."archivedAt" IS NULL
            AND ${notInTriageSql('w')}
            AND w."status" = ANY(${statusKeys})
            ${updatedSinceSql}
            ${sprintScope}
            AND ${notExcludedSql('w', opts.excludeIds)}
            AND (${compileFilterConditionsSql(opts.ast, opts.referents)})
          ORDER BY ${orderSql}
          LIMIT ${opts.limit}`;
      const ids = idRows.map((r) => r.id);
      if (ids.length === 0) return [];
      const rows = await client.workItem.findMany({ where: { id: { in: ids } } });
      const byId = new Map(rows.map((r) => [r.id, r]));
      // `findMany({ id: { in } })` does not preserve the id list order — restore
      // the raw query's order/window so the board rank is honoured.
      return ids.map((id) => byId.get(id)).filter((r): r is WorkItem => r !== undefined);
    }

    const orderBy: Prisma.WorkItemOrderByWithRelationInput[] =
      order === 'recent'
        ? [{ updatedAt: 'desc' }, { key: 'asc' }]
        : [{ position: 'asc' }, { key: 'asc' }];
    return client.workItem.findMany({
      where: {
        projectId,
        workspaceId,
        archivedAt: null,
        // Read-exclusion (Subtask 6.11.3): a triage item never appears as a
        // board card — same predicate as the swimlane lane aggregates below.
        triagedAt: null,
        status: { in: statusKeys },
        ...(opts.updatedSince ? { updatedAt: { gte: opts.updatedSince } } : {}),
        // Sprint scope (Story 4.5.2) — a SCRUM board's projection passes the
        // active sprint's id so the column loads only that sprint's issues; a
        // kanban board omits it (unscoped, byte-for-byte the 3.1.4 load).
        ...(opts.sprintId ? { sprintId: opts.sprintId } : {}),
        // Epic-privacy public exclusion (Subtask 6.14.4) — drop a private epic's
        // descendants for a non-member viewer; empty ⇒ no clause.
        ...(opts.excludeIds && opts.excludeIds.length > 0
          ? { id: { notIn: opts.excludeIds as string[] } }
          : {}),
      },
      orderBy,
      take: opts.limit,
    });
  },

  /**
   * One LAZY tree level (Subtask 2.5.13, finding #57) — the project's ROOTS
   * (`parentId === null`) or one parent's DIRECT children (`parentId === <id>`),
   * sorted by the whitelisted column + paged with `take`/`offset`. Each row
   * carries `hasChildren` (a correlated `EXISTS` over non-archived children) so
   * the client renders the expand chevron WITHOUT loading the subtree — the fix
   * for the whole-forest read that didn't scale.
   *
   * The explicit `workspaceId` + `projectId` gate (finding #26 — RLS is inert
   * under the dev/CI superuser) means a row can never cross tenants. The sort
   * column is whitelisted through `ISSUE_SORT_SQL` (never raw user input), and
   * `key ASC` is the stable tiebreaker that makes the order total (so paging
   * never skips/repeats a row). Fetches `take + 1` so the caller can derive
   * `hasMore` without a separate COUNT. UNfiltered only — a filtered tree uses
   * `findProjectForest` (context-preserving over the bounded result).
   */
  async findProjectTreeLevel(
    projectId: string,
    workspaceId: string,
    parentId: string | null,
    sort: IssueSort,
    page: {
      take: number;
      offset: number;
      ids?: readonly string[] | undefined;
      /** The epic-privacy exclusion (MOTIR-6644, a Visitor's tree): dropped from the
       *  level AND from the `hasChildren` probe. Absent ⇒ no clause. */
      excludeIds?: readonly string[] | undefined;
    },
    sprintId: string | null = null,
    tx?: Prisma.TransactionClient,
    folderLevel?: TreeFolderLevel,
  ): Promise<WorkItemTreeRow[]> {
    const client = tx ?? dbRead;
    const orderCol = ISSUE_SORT_SQL[sort.column];
    const dir = sort.direction === 'desc' ? Prisma.sql`DESC` : Prisma.sql`ASC`;
    // Sprint scope (MOTIR-1381): the ROOT level is re-rooted at the TOPMOST
    // in-sprint members (a member story, or the in-sprint subtasks of a non-member
    // story — never the epic/story ancestors), so the view never pulls the
    // top-level epics in. Below a shown root member the tree is the NORMAL,
    // UNSCOPED read (drill + hasChildren + progress are the whole subtree), since a
    // shown member is the committed unit. So sprint scope only rewrites the root
    // level's node selection; every other level is byte-for-byte the whole-project
    // read. `sprintId` null (or a non-root drill) ⇒ the normal parent predicate.
    // ⚠️ AN EXPLICIT ID SET IS A LEVEL TOO (MOTIR-3895). A dispatch RUN's members
    // are not one parent's children — `motir batch` and `motir auto` take
    // whatever was ready, across parents — so the run surface asks for a level
    // BY ID. It is the same level in every other respect: the same tenant gate,
    // the same archived/triage exclusions, the same columns and the same
    // `hasChildren` probe, so the canvas adapter downstream needs no second
    // shape. It takes precedence over the parent arm because a caller supplying
    // ids is naming the set outright.
    const parentPred =
      page.ids !== undefined
        ? Prisma.sql`w."id" IN (${Prisma.join([...page.ids])})`
        : sprintId != null && parentId === null
          ? Prisma.sql`w."id" IN ${topInSprintMembersSql(projectId, workspaceId, sprintId)}`
          : parentId === null
            ? Prisma.sql`w."parentId" IS NULL`
            : Prisma.sql`w."parentId" = ${parentId}`;

    return client.$queryRaw<WorkItemTreeRow[]>`
      SELECT w."id",
             w."parentId",
             w."kind"::text       AS "kind",
             w."type"::text       AS "type",
             w."executor"::text   AS "executor",
             w."key",
             w."identifier",
             w."title",
             w."status",
             w."ciState",
             w."fixReason"::text  AS "fixReason",
             w."priority"::text   AS "priority",
             w."assigneeId",
             w."reporterId",
             w."dueDate",
             w."estimateMinutes",
             w."storyPoints",
             w."updatedAt",
             w."sprintId",
             ${hasDescriptionSql('w')} AS "hasDescription",
             w."obsolescence"::text AS "obsolescence",
             w."obsolescenceNoteMd",
             w."publicChildrenHidden",
             EXISTS (
               SELECT 1 FROM "work_item" ch
                WHERE ch."parentId" = w."id" AND ch."archivedAt" IS NULL
                  AND ${notInTriageSql('ch')}
                  AND ${notExcludedSql('ch', page.excludeIds)}
             )                    AS "hasChildren"
        FROM "work_item" w
        LEFT JOIN "user" au ON au."id" = w."assigneeId"
        LEFT JOIN "user" ru ON ru."id" = w."reporterId"
        LEFT JOIN "workflow_status" ws
               ON ws."project_id" = w."projectId" AND ws."key" = w."status"
        WHERE w."projectId" = ${projectId}
          AND w."workspaceId" = ${workspaceId}
          AND w."archivedAt" IS NULL
          AND ${notInTriageSql('w')}
          AND ${notExcludedSql('w', page.excludeIds)}
          AND ${treeLevelPredicate(parentPred, parentId, page.ids !== undefined, folderLevel)}
        ORDER BY ${orderCol} ${dir} NULLS LAST, w."key" ASC
        LIMIT ${page.take + 1} OFFSET ${page.offset}`;
  },

  /**
   * The FULL child count of one lazy tree level (Subtask 2.5.14) — the project's
   * roots (`parentId === null`) or a parent's direct children — for an honest
   * `aria-setsize` ("19 of 128") + the "Showing N of M" affordance, independent
   * of paging. Same `workspaceId`+`projectId` gate as `findProjectTreeLevel`.
   * COUNT comes back as `bigint`; coerced to `number` (a project's per-node
   * child count is well within `Number.MAX_SAFE_INTEGER`).
   */
  async countProjectTreeLevel(
    projectId: string,
    workspaceId: string,
    parentId: string | null,
    sprintId: string | null = null,
    tx?: Prisma.TransactionClient,
    ids?: readonly string[] | undefined,
    folderLevel?: TreeFolderLevel,
    /** The epic-privacy exclusion (MOTIR-6644) — the level read's, so the two agree. */
    excludeIds?: readonly string[],
  ): Promise<number> {
    const client = tx ?? dbRead;
    // The SAME level predicate `findProjectTreeLevel` builds, sprint arm included
    // (MOTIR-3490). A count taken with a different predicate than the read it
    // reports on is worse than no count: the roadmap's truncation tile says
    // "Showing N of M", and in sprint scope an unscoped M would claim rows the
    // level could never show. Kept literally parallel to the read's `parentPred`
    // so the two cannot drift.
    const parentPred =
      ids !== undefined
        ? Prisma.sql`w."id" IN (${Prisma.join([...ids])})`
        : sprintId != null && parentId === null
          ? Prisma.sql`w."id" IN ${topInSprintMembersSql(projectId, workspaceId, sprintId)}`
          : parentId === null
            ? Prisma.sql`w."parentId" IS NULL`
            : Prisma.sql`w."parentId" = ${parentId}`;
    const rows = await client.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS "count"
        FROM "work_item" w
        WHERE w."projectId" = ${projectId}
          AND w."workspaceId" = ${workspaceId}
          AND w."archivedAt" IS NULL
          AND ${notInTriageSql('w')}
          AND ${notExcludedSql('w', excludeIds)}
          AND ${treeLevelPredicate(parentPred, parentId, ids !== undefined, folderLevel)}`;
    return Number(rows[0]?.count ?? 0);
  },

  /**
   * One LAZY level of the PUBLIC work-item TREE (Story 6.14 · Subtask 6.14.10) —
   * the project's roots (`parentId === null`) or one parent's DIRECT children,
   * key-ordered + paged with `take`/`offset`, projected to the PUBLIC-safe
   * columns only (the {@link PublicWorkItemTreeRow} shape — no assignee /
   * estimate / story points / reporter is SELECTed, so the public boundary is
   * structural). `excludeIds` is the epic-privacy exclusion set (6.14.4): a
   * non-member's level drops every descendant of a private epic — both the rows
   * AND the `hasChildren` EXISTS probe exclude them, so a private epic reports
   * `hasChildren = false` (its placeholder chevron is driven by
   * `publicChildrenHidden`, the mapper's marker). A member passes `[]`, reading
   * the unfiltered tree.
   *
   * The explicit `workspaceId` + `projectId` gate (finding #26 — RLS is inert
   * under the dev/CI superuser) means a row can never cross tenants. `key ASC` is
   * a total order, so paging never skips/repeats a row. Fetches `take + 1` so the
   * caller derives `hasMore` without a separate COUNT. UNfiltered + UNsorted
   * (the public tree has no sort headers) — the read mirrors
   * {@link findProjectTreeLevel} minus the internal columns + the user joins.
   */
  async findPublicProjectTreeLevel(
    projectId: string,
    workspaceId: string,
    parentId: string | null,
    page: { take: number; offset: number },
    excludeIds: readonly string[],
    tx?: Prisma.TransactionClient,
  ): Promise<PublicWorkItemTreeRow[]> {
    const client = tx ?? dbRead;
    const parentPred =
      parentId === null ? Prisma.sql`w."parentId" IS NULL` : Prisma.sql`w."parentId" = ${parentId}`;

    return client.$queryRaw<PublicWorkItemTreeRow[]>`
      SELECT w."id",
             w."parentId",
             w."kind"::text       AS "kind",
             w."key",
             w."identifier",
             w."title",
             w."status",
             w."priority"::text   AS "priority",
             w."publicChildrenHidden",
             EXISTS (
               SELECT 1 FROM "work_item" ch
                WHERE ch."parentId" = w."id" AND ch."archivedAt" IS NULL
                  AND ${notInTriageSql('ch')}
                  AND ${notExcludedSql('ch', excludeIds)}
             )                    AS "hasChildren"
        FROM "work_item" w
        WHERE w."projectId" = ${projectId}
          AND w."workspaceId" = ${workspaceId}
          AND w."archivedAt" IS NULL
          AND ${notInTriageSql('w')}
          AND ${notExcludedSql('w', excludeIds)}
          AND ${parentPred}
        ORDER BY w."key" ASC
        LIMIT ${page.take + 1} OFFSET ${page.offset}`;
  },

  /**
   * The PUBLIC CHANGELOG page (Story 8.9 · Subtask 8.9.3) — the project's
   * shipped items, newest first, cursor-paged. ONE bounded `$queryRaw`; no
   * per-row round trip (finding #57).
   *
   * WHAT "SHIPPED" MEANS HERE IS NOT A NEW DEFINITION — it is the existing one
   * with the existing public correction applied. The `shipped` CTE reuses the
   * done-transition predicate the four report aggregates in
   * `workItemRevisionRepository` share — join `workflow_status` on the revision
   * diff's `from`/`to` keys, take a `done`-category `to` from a non-done `from`
   * — so the public stream and the internal reports cannot disagree about a
   * status change. `aggregateResolutionTimeByBucket`'s own note says why: *"so
   * every report agrees on 'done'"*.
   *
   * ⚠️ AND `cancelled` IS A `done`-CATEGORY STATUS (`defaultWorkflow.ts`), so
   * "category = done" alone would announce cancelled work as shipped — a false
   * public claim, and one a feed reader keeps. The reports are right to count
   * it: they measure RESOLUTION, and a "won't do" is resolved. A changelog
   * makes a SHIPPED statement, so it excludes it — which is not a new judgement
   * either. The public ROADMAP's Done column has excluded the same key since
   * 6.12.7 (*"a cancelled item is sealed-not-shipped"*), and both surfaces now
   * read the ONE literal in `lib/publicProjects/shippedStatus.ts`.
   *
   * So "shipped" here is `category = 'done' AND key <> 'cancelled'`, applied to
   * all THREE status joins: an item that moves `cancelled → done` has genuinely
   * shipped and must appear, which it only does if `cancelled` is not-shipped on
   * the `from` side too.
   *
   * `shippedAt` is `MAX(changedAt)` — the item's MOST RECENT into-done
   * transition, a deliberate divergence from `aggregateAverageAgeByBucket`,
   * which takes the FIRST. The two answer different questions: age-to-resolution
   * asks *how long did this take*, so the first resolution is the honest one; a
   * time-ordered feed asks *what shipped, when*, and an item reopened and
   * re-shipped last week shipped last week. Filing it under a date the readers
   * have already scrolled past is the same as not publishing it.
   *
   * AND THE ITEM MUST STILL BE DONE. `MAX` over into-done transitions is blind
   * to a later move OUT of done, so the `cs` join re-tests the item's CURRENT
   * status against the same `category = 'done'`. An item that was reopened
   * therefore leaves the changelog and re-enters, higher, when it ships again
   * (ADR §2). An item CREATED at a done status has no status revision at all —
   * the importer's authoritative set writes none, as
   * `workItemRevisionRepository.findLatestStatusChange` documents — so it is
   * absent, which is what keeps an imported backlog of closed issues from
   * flooding a project's first changelog.
   *
   * FOUR EXCLUSIONS, not three. `excludeIds` is the 6.14 private-epic
   * descendant set, `triagedAt IS NULL` drops submissions that are not planned
   * work, and `archivedAt IS NULL` is the usual gate. The FOURTH has no helper
   * and is specific to this read: **a private epic's OWN row is excluded**.
   * `findPublicHiddenDescendantIds` returns descendants only — deliberately,
   * because in the TREE the private epic's row stays visible as the "this epic
   * is not public" placeholder. That is right for a tree and wrong for a
   * stream: a changelog entry asserts that a specific thing shipped, and there
   * is no such thing as a placeholder entry. Without this predicate a private
   * epic reaching `done` would publish its title — the one field 6.14 leaves
   * visible — into a feed, permanently.
   *
   * The epic chip walks UP at most three PK lookups (`p1`/`p2`/`p3`): the tree
   * caps at four levels (epic → story → task → subtask) and an epic is always a
   * root, so a bounded chain of LEFT JOINs answers it without a recursive CTE.
   * A row whose own kind is `epic` carries no chip — it would name itself.
   *
   * Fetches `take + 1` so the caller derives `hasMore` without a COUNT, the
   * convention {@link findPublicProjectTreeLevel} sets. Read-only cross-org
   * path → `db` singleton, with the explicit `workspaceId` + `projectId` gate
   * that means a row can never cross tenants (finding #26 — RLS is inert under
   * the dev/CI superuser).
   */
  async findPublicChangelogEntries(
    projectId: string,
    workspaceId: string,
    options: { take: number; cursor?: PublicChangelogCursor; withDescription?: boolean },
    excludeIds: readonly string[],
    tx?: Prisma.TransactionClient,
  ): Promise<PublicChangelogRow[]> {
    const client = tx ?? dbRead;
    // Projected only for the feed (see `PublicChangelogRow.descriptionMd`).
    const descriptionSql = options.withDescription
      ? Prisma.sql`w."descriptionMd" AS "descriptionMd",`
      : Prisma.empty;
    const cursorPred = options.cursor
      ? Prisma.sql`AND (
            s."shipped_at" < ${options.cursor.shippedAt}
            OR (s."shipped_at" = ${options.cursor.shippedAt} AND w."key" < ${options.cursor.key})
          )`
      : Prisma.empty;
    // "Shipped" = a done-category status that is not the sealed-not-shipped one.
    const notShipped = PUBLIC_NOT_SHIPPED_DONE_KEY;

    return client.$queryRaw<PublicChangelogRow[]>`
      WITH shipped AS (
        SELECT r."workItemId" AS "work_item_id",
               MAX(r."changedAt") AS "shipped_at"
          FROM "work_item_revision" r
          JOIN "work_item" iw
            ON iw."id" = r."workItemId"
           AND iw."projectId" = ${projectId}
           AND iw."workspaceId" = ${workspaceId}
          LEFT JOIN "workflow_status" fs
            ON fs."project_id" = iw."projectId"
           AND fs."key" = (r."diff" -> 'status' ->> 'from')
          JOIN "workflow_status" ts
            ON ts."project_id" = iw."projectId"
           AND ts."key" = (r."diff" -> 'status' ->> 'to')
         WHERE r."changeKind" = 'updated'
           AND r."diff" -> 'status' IS NOT NULL
           AND ts."category" = 'done'
           AND ts."key" <> ${notShipped}
           AND (
             fs."category" IS NULL
             OR fs."category" <> 'done'
             OR fs."key" = ${notShipped}
           )
         GROUP BY r."workItemId"
      )
      SELECT w."id",
             ${descriptionSql}
             w."kind"::text     AS "kind",
             w."key",
             w."identifier",
             w."title",
             w."status",
             w."priority"::text AS "priority",
             s."shipped_at"     AS "shippedAt",
             CASE
               WHEN w."kind"::text = 'epic'  THEN NULL
               WHEN p1."kind"::text = 'epic' THEN p1."identifier"
               WHEN p2."kind"::text = 'epic' THEN p2."identifier"
               WHEN p3."kind"::text = 'epic' THEN p3."identifier"
             END                AS "epicIdentifier",
             CASE
               WHEN w."kind"::text = 'epic'  THEN NULL
               WHEN p1."kind"::text = 'epic' THEN p1."title"
               WHEN p2."kind"::text = 'epic' THEN p2."title"
               WHEN p3."kind"::text = 'epic' THEN p3."title"
             END                AS "epicTitle"
        FROM shipped s
        JOIN "work_item" w ON w."id" = s."work_item_id"
        JOIN "workflow_status" cs
          ON cs."project_id" = w."projectId"
         AND cs."key" = w."status"
         AND cs."category" = 'done'
         AND cs."key" <> ${notShipped}
        LEFT JOIN "work_item" p1 ON p1."id" = w."parentId"
        LEFT JOIN "work_item" p2 ON p2."id" = p1."parentId"
        LEFT JOIN "work_item" p3 ON p3."id" = p2."parentId"
       WHERE w."projectId" = ${projectId}
         AND w."workspaceId" = ${workspaceId}
         AND w."archivedAt" IS NULL
         AND ${notInTriageSql('w')}
         AND ${notExcludedSql('w', excludeIds)}
         AND NOT (w."kind"::text = 'epic' AND w."publicChildrenHidden" = true)
         ${cursorPred}
       ORDER BY s."shipped_at" DESC, w."key" DESC
       LIMIT ${options.take + 1}`;
  },

  /**
   * The FULL child count of one PUBLIC tree level (Subtask 6.14.10) — the
   * project's roots or a parent's direct children — for an honest
   * `aria-setsize` / "Showing N of M", independent of paging. Same
   * `workspaceId`+`projectId` + epic-privacy `excludeIds` exclusion as
   * {@link findPublicProjectTreeLevel} (so the denominator never counts a hidden
   * descendant — an aggregate-tell leak). COUNT → `bigint`, coerced to `number`.
   */
  async countPublicProjectTreeLevel(
    projectId: string,
    workspaceId: string,
    parentId: string | null,
    excludeIds: readonly string[],
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = tx ?? dbRead;
    const parentPred =
      parentId === null ? Prisma.sql`w."parentId" IS NULL` : Prisma.sql`w."parentId" = ${parentId}`;
    const rows = await client.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS "count"
        FROM "work_item" w
        WHERE w."projectId" = ${projectId}
          AND w."workspaceId" = ${workspaceId}
          AND w."archivedAt" IS NULL
          AND ${notInTriageSql('w')}
          AND ${notExcludedSql('w', excludeIds)}
          AND ${parentPred}`;
    return Number(rows[0]?.count ?? 0);
  },

  /**
   * Create a work item. Required `tx`. The DB triggers validate the
   * kind-parent matrix + depth on insert; their SQLSTATE-23514 rejections and
   * a P2002 unique violation are translated to typed errors here.
   */
  async create(data: WorkItemCreateInput, tx: Prisma.TransactionClient): Promise<WorkItem> {
    try {
      return await tx.workItem.create({ data });
    } catch (err) {
      throw translateWriteError(err);
    }
  },

  /**
   * Count ALL work items across an organization (§4.1 headline cap, 8.1.11) —
   * every project in every workspace of the org, joined `work_item → workspace`.
   * A PLAIN ROW COUNT with NO archive filter: §4 counts archived AND active
   * items ("archiving does NOT free room" — the deliberate divergence from
   * Linear's non-archived cap that closes the archive loophole). Takes `tx` so
   * the count + the guarded create run in one transaction, serialized by the org
   * row lock (`organizationRepository.lockByIdForUpdate`). Raw SQL because the
   * count crosses the workspace join at the org boundary (the ungameable org-wide
   * count §4 mandates), not the active-workspace scope a Prisma `count` sees.
   */
  async countByOrganization(organizationId: string, tx: Prisma.TransactionClient): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) AS count
      FROM "work_item" wi
      JOIN "workspace" w ON w."id" = wi."workspaceId"
      WHERE w."organizationId" = ${organizationId}
    `;
    return Number(rows[0]?.count ?? 0);
  },

  // --- Board swimlane lane aggregates (Subtask 3.3.4, finding #57) ----------
  // Each returns one row PER LANE (a grouped/distinct aggregate), NOT one row
  // per card — so the board never fetches every card to discover its lanes.
  // `statusKeys` is the union of the board's mapped column statuses (a card on
  // the board has a status in this set); an empty set short-circuits.
  //
  // `sprintId` (Story 4.5.2) is the optional SCRUM scope: when present the lane
  // aggregate counts only the active sprint's issues, so swimlanes compose with
  // the sprint filter exactly as the columns do; omitted on a kanban board
  // (unscoped, byte-for-byte the 3.3.4 lane counts).

  /**
   * Per-assignee card counts among the board's cards — one row per distinct
   * `assigneeId` (incl. `null` = the unassigned/catch-all bucket). The service
   * resolves the null bucket + the assignee display names into lane DTOs.
   */
  async aggregateBoardLanesByAssignee(
    projectId: string,
    workspaceId: string,
    statusKeys: string[],
    sprintId?: string,
    filter?: BoardCardFilter,
    tx?: Prisma.TransactionClient,
  ): Promise<Array<{ assigneeId: string | null; count: number }>> {
    if (statusKeys.length === 0) return [];
    // Raw GROUP BY (not the Prisma builder) so the optional 6.15.2 FilterAST —
    // a parameterized SQL fragment over alias `w` — can be AND-ed in; the lane
    // counts then track the FILTERED board exactly as `findColumnCards` does.
    // No filter → the fragment is `TRUE`, so the counts are byte-for-byte the
    // 3.3.4 aggregate. Read-exclusion (6.11.3): a triage item never counts.
    const sprintScope = sprintId ? Prisma.sql`AND w."sprintId" = ${sprintId}` : Prisma.empty;
    const client = tx ?? dbRead;
    return client.$queryRaw<Array<{ assigneeId: string | null; count: number }>>`
      SELECT w."assigneeId" AS "assigneeId", COUNT(*)::int AS "count"
        FROM "work_item" w
        WHERE w."projectId" = ${projectId}
          AND w."workspaceId" = ${workspaceId}
          AND w."archivedAt" IS NULL
          AND ${notInTriageSql('w')}
          AND w."status" = ANY(${statusKeys})
          ${sprintScope}
          AND (${boardCardFilterSql(filter)})
        GROUP BY w."assigneeId"`;
  },

  /**
   * Per-priority card counts among the board's cards — one row per distinct
   * `priority`. `priority` is non-null (default `medium`), so there is no
   * catch-all lane for this dimension.
   */
  async aggregateBoardLanesByPriority(
    projectId: string,
    workspaceId: string,
    statusKeys: string[],
    sprintId?: string,
    filter?: BoardCardFilter,
    tx?: Prisma.TransactionClient,
  ): Promise<Array<{ priority: WorkItemPriority; count: number }>> {
    if (statusKeys.length === 0) return [];
    // Raw GROUP BY so the optional 6.15.2 FilterAST AND-s in (see
    // `aggregateBoardLanesByAssignee`); `priority::text` returns the enum's
    // string value (= the WorkItemPriority union members), so the shape matches
    // the prior `groupBy` result. No filter → `TRUE` (byte-for-byte 3.3.4).
    const sprintScope = sprintId ? Prisma.sql`AND w."sprintId" = ${sprintId}` : Prisma.empty;
    const client = tx ?? dbRead;
    return client.$queryRaw<Array<{ priority: WorkItemPriority; count: number }>>`
      SELECT w."priority"::text AS "priority", COUNT(*)::int AS "count"
        FROM "work_item" w
        WHERE w."projectId" = ${projectId}
          AND w."workspaceId" = ${workspaceId}
          AND w."archivedAt" IS NULL
          AND ${notInTriageSql('w')}
          AND w."status" = ANY(${statusKeys})
          ${sprintScope}
          AND (${boardCardFilterSql(filter)})
        GROUP BY w."priority"`;
  },

  /**
   * Per-ANCESTOR-EPIC card counts among the board's cards — one row per epic
   * that is the nearest epic ancestor of at least one board card. A recursive
   * CTE walks each card UP its `parentId` chain, stopping at the first `epic`
   * (an epic has no epic ancestor, so each card maps to AT MOST one epic), then
   * GROUPs in SQL — so this returns lane rows, never a row per card (finding
   * #57). A card whose chain has no epic contributes no row here; the service
   * derives the "No epic" catch-all count by subtraction (total − Σ epic
   * counts). A board card that IS an epic counts in its own lane.
   * `workspaceId` is filtered on both the anchor and the climb (no cross-tenant
   * leak).
   */
  async aggregateBoardLanesByEpic(
    projectId: string,
    workspaceId: string,
    statusKeys: string[],
    sprintId?: string,
    filter?: BoardCardFilter,
    tx?: Prisma.TransactionClient,
  ): Promise<Array<{ epicId: string; count: number }>> {
    if (statusKeys.length === 0) return [];
    // Sprint scope (Story 4.5.2): only the anchor (the board CARDS) is sprint-
    // filtered; the upward climb to the ancestor epic must NOT be (an epic
    // ancestor is rarely itself in the sprint). Bound param, never interpolated.
    // The 6.15.2 FilterAST likewise constrains only the anchor CARDS (the climb
    // is structural) — so the epic lanes/counts track the FILTERED board. No
    // filter → `TRUE` (byte-for-byte the 3.3.4 epic aggregate).
    const sprintScope = sprintId ? Prisma.sql`AND w."sprintId" = ${sprintId}` : Prisma.empty;
    const client = tx ?? dbRead;
    return client.$queryRaw<Array<{ epicId: string; count: number }>>`
      WITH RECURSIVE up AS (
        SELECT w."id" AS card_id, w."id" AS node_id, w."parentId", w."kind"::text AS kind
          FROM "work_item" w
          WHERE w."projectId" = ${projectId}
            AND w."workspaceId" = ${workspaceId}
            AND w."archivedAt" IS NULL
            AND ${notInTriageSql('w')}
            AND w."status" = ANY(${statusKeys})
            ${sprintScope}
            AND (${boardCardFilterSql(filter)})
        UNION ALL
        SELECT u.card_id, p."id", p."parentId", p."kind"::text
          FROM up u
          JOIN "work_item" p ON p."id" = u."parentId" AND p."workspaceId" = ${workspaceId}
          WHERE u.kind <> 'epic'
      )
      SELECT node_id AS "epicId", COUNT(*)::int AS "count"
        FROM up
        WHERE kind = 'epic'
        GROUP BY node_id`;
  },

  /**
   * Does one work item satisfy an automation rule's condition group (Story 6.6
   * · Subtask 6.6.2)? Compiles the FilterAST through the 6.1.1 compiler over
   * alias `w` (stale referents → match-nothing, the 6.1.2 rule) and tests it
   * against the SINGLE triggering item — `WHERE w.id = :id AND (<conditions>)`,
   * one indexed point read. An empty condition group compiles to `TRUE`, so the
   * predicate reduces to "the item still exists" (the always-match rule). A
   * deleted/missing item returns false (it can't be acted on). Read-only path →
   * `db` singleton (the engine has no surrounding write tx when it evaluates).
   */
  async matchesAutomationCondition(
    workItemId: string,
    ast: FilterAst,
    referents?: ProjectFilterReferents,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const astSql = compileFilterConditionsSql(ast, referents);
    const client = tx ?? dbRead;
    const rows = await client.$queryRaw<Array<{ ok: number }>>`
      SELECT 1 AS ok FROM "work_item" w
      WHERE w."id" = ${workItemId} AND (${astSql})
      LIMIT 1`;
    return rows.length > 0;
  },

  /**
   * The CREATED series of the created-vs-resolved report (Story 6.3 · Subtask
   * 6.3.2): non-archived items whose `createdAt` falls inside the inclusive
   * window, COUNTed per `date_trunc(period, createdAt)` bucket in ONE grouped
   * query (finding #57 — never a row load + JS reduce; the result is bounded
   * by the bucket cap the service validates). `period` is a closed
   * `day|week|month` union bound as a parameter (never SQL text). The
   * optional compiled FilterAST (the 6.2 saved-filter scope — Subtask 6.1.1's
   * compiler over alias `w`, stale referents → match-nothing per 6.1.2)
   * narrows the set; a project scope passes none. `workspaceId` gates the
   * read (finding #26). Buckets with no events return no row (the service
   * fills the axis). Read-only path → `db` singleton.
   */
  async aggregateCreatedByBucket(
    projectId: string,
    workspaceId: string,
    period: 'day' | 'week' | 'month',
    window: { start: Date; end: Date },
    filter?: { ast?: FilterAst; referents?: ProjectFilterReferents },
    tx?: Prisma.TransactionClient,
  ): Promise<Array<{ bucket: string; count: number }>> {
    const astSql = filter?.ast
      ? compileFilterConditionsSql(filter.ast, filter.referents)
      : Prisma.sql`TRUE`;
    const client = tx ?? dbRead;
    return client.$queryRaw<Array<{ bucket: string; count: number }>>`
      SELECT
        to_char(date_trunc(${period}, w."createdAt"), 'YYYY-MM-DD') AS "bucket",
        COUNT(*)::int AS "count"
      FROM "work_item" w
      WHERE w."projectId" = ${projectId}
        AND w."workspaceId" = ${workspaceId}
        AND w."archivedAt" IS NULL
        AND ${notInTriageSql('w')}
        AND w."createdAt" >= ${window.start}
        AND w."createdAt" <= ${window.end}
        AND (${astSql})
      GROUP BY 1
      ORDER BY 1`;
  },

  /**
   * The DISTRIBUTION (donut) aggregate (Story 6.3 · Subtask 6.3.2): one
   * bounded GROUP-BY count over the scoped non-archived items, per the TOTAL
   * `DistributionGroupBy` descriptor (`lib/reports/statisticTypes.ts` —
   * mistake #29: the switch below is total over every descriptor the
   * registry can emit; descriptors select FIXED SQL literals, only values
   * bind). Strategies:
   *   • `column` — a `work_item` scalar (kind/status/priority/assignee/
   *     reporter/sprint), labelled via its referent table where one exists
   *     (workflow_status label, user/sprint name; enum ids self-describe).
   *   • `join` — the 5.4.1 label/component join: one row per (item, join
   *     row), so a multi-labelled item lands in multiple segments (the
   *     verified Jira behaviour) and a no-label item falls into the NULL
   *     ("None") segment via LEFT JOIN.
   *   • `customField` — the 5.3.1 typed-EAV probe on the `[workItemId,
   *     fieldId]` unique / `[fieldId, value*]` indexes, narrowed to the
   *     enum-ish value columns (select-option / user).
   * The optional compiled FilterAST narrows the item set (the saved-filter
   * scope). The result is bounded by the statistic's value vocabulary —
   * segments, never items (finding #57). Read-only path → `db` singleton.
   */
  async aggregateDistribution(
    projectId: string,
    workspaceId: string,
    groupBy: DistributionGroupBy,
    filter?: { ast?: FilterAst; referents?: ProjectFilterReferents },
    tx?: Prisma.TransactionClient,
  ): Promise<Array<{ id: string | null; label: string | null; count: number }>> {
    const astSql = filter?.ast
      ? compileFilterConditionsSql(filter.ast, filter.referents)
      : Prisma.sql`TRUE`;
    const { idExpr, labelExpr, joinSql } = distributionGroupBySql(groupBy);
    const client = tx ?? dbRead;
    return client.$queryRaw<Array<{ id: string | null; label: string | null; count: number }>>`
      SELECT ${idExpr} AS "id", ${labelExpr} AS "label", COUNT(*)::int AS "count"
      FROM "work_item" w
      ${joinSql}
      WHERE w."projectId" = ${projectId}
        AND w."workspaceId" = ${workspaceId}
        AND w."archivedAt" IS NULL
        AND ${notInTriageSql('w')}
        AND (${astSql})
      GROUP BY 1, 2
      ORDER BY 3 DESC, 2 ASC NULLS LAST, 1 ASC NULLS LAST`;
  },

  /**
   * The WORKLOAD aggregate (Story 8.8 · Subtask 8.8.13): one bounded GROUP-BY
   * over the scoped, non-archived, NON-triage, OPEN (current status NOT in a
   * `done`-category) `work_item` rows, per `assigneeId` — both the summed
   * `storyPoints` (an unestimated item contributes 0, never `NaN`) and the issue
   * COUNT, so the Measure toggle (story points ↔ issue count) is a client re-rank
   * with no refetch. The unassigned bucket is the `NULL` `assigneeId` row
   * (LEFT-joined name `NULL` — the UI's neutral "None"). "Done" resolves like
   * every report: join `workflow_status` on the item's CURRENT status key and
   * read `category = 'done'` (a `NULL` join — a status with no matching row —
   * counts as open, never silently dropped). The optional compiled FilterAST
   * (the 6.2 saved-filter scope) narrows the set; a project scope passes none.
   * `workspaceId` gates the read (finding #26). Bounded by the team size
   * (segments, never items — finding #57). Read-only path → `db` singleton.
   */
  async aggregateWorkloadByAssignee(
    projectId: string,
    workspaceId: string,
    filter?: { ast?: FilterAst; referents?: ProjectFilterReferents },
    tx?: Prisma.TransactionClient,
  ): Promise<
    Array<{ assigneeId: string | null; name: string | null; points: number; count: number }>
  > {
    const astSql = filter?.ast
      ? compileFilterConditionsSql(filter.ast, filter.referents)
      : Prisma.sql`TRUE`;
    const client = tx ?? dbRead;
    return client.$queryRaw<
      Array<{ assigneeId: string | null; name: string | null; points: number; count: number }>
    >`
      SELECT
        w."assigneeId"                          AS "assigneeId",
        au."name"                               AS "name",
        COALESCE(SUM(w."storyPoints"), 0)::float8 AS "points",
        COUNT(*)::int                           AS "count"
      FROM "work_item" w
      LEFT JOIN "user" au ON au."id" = w."assigneeId"
      LEFT JOIN "workflow_status" cs
        ON cs."project_id" = w."projectId"
       AND cs."key" = w."status"
      WHERE w."projectId" = ${projectId}
        AND w."workspaceId" = ${workspaceId}
        AND w."archivedAt" IS NULL
        AND ${notInTriageSql('w')}
        AND (cs."category" IS NULL OR cs."category" <> 'done')
        AND (${astSql})
      GROUP BY 1, 2
      ORDER BY "points" DESC, "count" DESC, 2 ASC NULLS LAST, 1 ASC NULLS LAST`;
  },

  /**
   * The WINDOWED workload aggregate (Story MOTIR-8919): work that was OPEN at
   * any point in `[window.start, window.end]`, one bar per PERSON — the item's
   * assignee, else its reporter, else the `NULL` "Unassigned" bar. A second
   * method, not a branch of {@link aggregateWorkloadByAssignee}: that one reads
   * current rows only and feeds the dashboard gadget, which must not move.
   *
   * An item counts when it is scoped, non-archived, non-triage, created by
   * `end`, and either (a) its CURRENT status is not `done`-category (a `NULL`
   * join counts as open, as in the snapshot) or (b) its LAST move into a done
   * category — from a status that is not done — is at or after `start`. The
   * `last_done` CTE takes `MAX(changedAt)`, deliberately not the `MIN` that
   * `aggregateAverageAgeByBucket` takes: resolved before the window, reopened
   * and resolved again inside it must still count. An item that is done now
   * with no done-entry revision has no recorded open time and is not counted.
   *
   * Attribution is by the item's CURRENT assignee / reporter / `storyPoints`.
   * Per person it returns the totals plus the assigned (`assigneeId IS NOT
   * NULL`) and unassigned-but-reported (`assigneeId IS NULL AND reporterId IS
   * NOT NULL`) segments; the person-less row carries only totals (its segment
   * fields are 0). Rows are people, never items (finding #57). `workspaceId`
   * gates the read (finding #26).
   */
  async aggregateWorkloadByPersonInWindow(
    projectId: string,
    workspaceId: string,
    window: { start: Date; end: Date },
    filter?: { ast?: FilterAst; referents?: ProjectFilterReferents },
    tx?: Prisma.TransactionClient,
  ): Promise<
    Array<{
      assigneeId: string | null;
      name: string | null;
      points: number;
      count: number;
      assignedPoints: number;
      assignedCount: number;
      unassignedPoints: number;
      unassignedCount: number;
    }>
  > {
    const astSql = filter?.ast
      ? compileFilterConditionsSql(filter.ast, filter.referents)
      : Prisma.sql`TRUE`;
    const client = tx ?? dbRead;
    return client.$queryRaw<
      Array<{
        assigneeId: string | null;
        name: string | null;
        points: number;
        count: number;
        assignedPoints: number;
        assignedCount: number;
        unassignedPoints: number;
        unassignedCount: number;
      }>
    >`
      WITH last_done AS (
        SELECT r."workItemId" AS "work_item_id",
               MAX(r."changedAt") AS "last_done_at"
          FROM "work_item_revision" r
          JOIN "work_item" iw
            ON iw."id" = r."workItemId"
           AND iw."projectId" = ${projectId}
           AND iw."workspaceId" = ${workspaceId}
          LEFT JOIN "workflow_status" fs
            ON fs."project_id" = iw."projectId"
           AND fs."key" = (r."diff" -> 'status' ->> 'from')
          JOIN "workflow_status" ts
            ON ts."project_id" = iw."projectId"
           AND ts."key" = (r."diff" -> 'status' ->> 'to')
         WHERE r."changeKind" = 'updated'
           AND r."diff" -> 'status' IS NOT NULL
           AND ts."category" = 'done'
           AND (fs."category" IS NULL OR fs."category" <> 'done')
         GROUP BY r."workItemId"
      )
      SELECT
        COALESCE(w."assigneeId", w."reporterId")  AS "assigneeId",
        pu."name"                                 AS "name",
        COALESCE(SUM(w."storyPoints"), 0)::float8 AS "points",
        COUNT(*)::int                             AS "count",
        COALESCE(SUM(w."storyPoints") FILTER (WHERE w."assigneeId" IS NOT NULL), 0)::float8
                                                  AS "assignedPoints",
        (COUNT(*) FILTER (WHERE w."assigneeId" IS NOT NULL))::int
                                                  AS "assignedCount",
        COALESCE(SUM(w."storyPoints") FILTER (
          WHERE w."assigneeId" IS NULL AND w."reporterId" IS NOT NULL), 0)::float8
                                                  AS "unassignedPoints",
        (COUNT(*) FILTER (
          WHERE w."assigneeId" IS NULL AND w."reporterId" IS NOT NULL))::int
                                                  AS "unassignedCount"
      FROM "work_item" w
      LEFT JOIN "user" pu ON pu."id" = COALESCE(w."assigneeId", w."reporterId")
      LEFT JOIN "workflow_status" cs
        ON cs."project_id" = w."projectId"
       AND cs."key" = w."status"
      LEFT JOIN last_done ld ON ld."work_item_id" = w."id"
      WHERE w."projectId" = ${projectId}
        AND w."workspaceId" = ${workspaceId}
        AND w."archivedAt" IS NULL
        AND ${notInTriageSql('w')}
        AND w."createdAt" <= ${window.end}
        AND (
          cs."category" IS NULL
          OR cs."category" <> 'done'
          OR ld."last_done_at" >= ${window.start}
        )
        AND (${astSql})
      GROUP BY 1, 2
      ORDER BY "points" DESC, "count" DESC, 2 ASC NULLS LAST, 1 ASC NULLS LAST`;
  },

  /**
   * Resolve the nearest ANCESTOR-EPIC id for each of `itemIds` (the loaded
   * board page) — the per-card half of the epic group-by, so the client never
   * re-derives lane membership. Same upward recursive walk as
   * `aggregateBoardLanesByEpic`, but anchored on a BOUNDED id set (≤ the loaded
   * page) and returning (card → epic) pairs instead of grouping. A card with no
   * epic ancestor yields no row (the service buckets it into the catch-all).
   */
  async findEpicAncestors(
    itemIds: string[],
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Array<{ cardId: string; epicId: string }>> {
    if (itemIds.length === 0) return [];
    const client = tx ?? dbRead;
    return client.$queryRaw<Array<{ cardId: string; epicId: string }>>`
      WITH RECURSIVE up AS (
        SELECT w."id" AS card_id, w."id" AS node_id, w."parentId", w."kind"::text AS kind
          FROM "work_item" w
          WHERE w."id" = ANY(${itemIds}) AND w."workspaceId" = ${workspaceId}
        UNION ALL
        SELECT u.card_id, p."id", p."parentId", p."kind"::text
          FROM up u
          JOIN "work_item" p ON p."id" = u."parentId" AND p."workspaceId" = ${workspaceId}
          WHERE u.kind <> 'epic'
      )
      SELECT card_id AS "cardId", node_id AS "epicId"
        FROM up
        WHERE kind = 'epic'`;
  },

  /**
   * Patch a work item. Required `tx`. The triggers re-validate on a
   * parentId/kind change (and reject re-parent cycles); a missing row yields
   * a typed not-found error.
   */
  async update(
    id: string,
    patch: WorkItemUpdateInput,
    tx: Prisma.TransactionClient,
  ): Promise<WorkItem> {
    try {
      return await tx.workItem.update({ where: { id }, data: patch });
    } catch (err) {
      throw translateWriteError(err, { id });
    }
  },

  /**
   * Write a card's to-fix answer (Story MOTIR-6588 · MOTIR-6600) — `fixReason` and
   * `fixDetail` together, the only writer `fixReasonService.recomputeWorkItemFixReason`
   * uses. A cleared detail writes SQL NULL through `Prisma.DbNull`, never the JSON value
   * `null`, so `fixDetail IS NULL` holds exactly when `fixReason` does.
   */
  /**
   * Write a card's `resumeState` and the gated run it is about, together (Story
   * MOTIR-7701 · MOTIR-7707). The only writer is
   * `resumeStateService.recomputeWorkItemResumeState`.
   */
  async updateResumeState(
    id: string,
    value: { resumeState: WorkItemResumeState | null; resumeRunId: string | null },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.workItem.update({
      where: { id },
      data: { resumeState: value.resumeState, resumeRunId: value.resumeRunId },
    });
  },

  async updateFixReason(
    id: string,
    value: { fixReason: WorkItemFixReason | null; fixDetail: FixDetailDto | null },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.workItem.update({
      where: { id },
      data: {
        fixReason: value.fixReason,
        // A plain data record — every field a string, number, boolean or null, and a
        // dead run's branch list re-spelled as literal objects (an interface carries no
        // index signature, so the JSON input type refuses it as declared).
        fixDetail:
          value.fixDetail === null
            ? Prisma.DbNull
            : {
                ...value.fixDetail,
                branches:
                  value.fixDetail.branches?.map((b) => ({
                    repository: b.repository,
                    branch: b.branch,
                  })) ?? null,
              },
      },
    });
  },

  /**
   * Soft-delete: stamp `archivedAt = now()`. Work items are NEVER hard-deleted
   * (the Project pattern) — revision history (1.4.6) must survive an archive.
   */
  async archive(id: string, tx: Prisma.TransactionClient): Promise<WorkItem> {
    try {
      return await tx.workItem.update({ where: { id }, data: { archivedAt: new Date() } });
    } catch (err) {
      throw translateWriteError(err, { id });
    }
  },

  /**
   * Restore a soft-deleted item — clear `archivedAt` (Subtask 7.8.14, the
   * Jira "restore" action). The inverse of {@link archive}: a single-op update,
   * the same P2025→WorkItemNotFoundError translation. Re-archiving an already-
   * live row (archivedAt already null) is a harmless no-op write.
   */
  async unarchive(id: string, tx: Prisma.TransactionClient): Promise<WorkItem> {
    try {
      return await tx.workItem.update({ where: { id }, data: { archivedAt: null } });
    } catch (err) {
      throw translateWriteError(err, { id });
    }
  },

  /**
   * PERMANENT delete of a whole subtree (Story 2.8 · Subtask 2.8.2) — the
   * destructive counterpart of {@link archive}. The caller (`deleteWorkItem`)
   * resolves the full id set via {@link findSubtree} (root + every descendant)
   * and passes it here; this is the single-op leaf that removes them.
   *
   * ONE statement (`deleteMany ... WHERE id IN (...)`) removes the root AND its
   * children together. The self-FK (`work_item.parentId → work_item.id`) is
   * `onDelete: NoAction`, and SQL `NO ACTION` (unlike `RESTRICT`) defers the
   * referential check to END-OF-STATEMENT — so a single delete that removes a
   * parent and all its referencing children passes with no per-level ordering.
   * Every OTHER inbound FK is `Cascade` (links from+to, comments,
   * labels/components/watchers, custom-field values, notifications, votes,
   * revisions, sprint-report entries) or `SetNull` (attachments → orphan-GC,
   * automation-execution audit), so the DB removes/decouples those rows for us:
   * no orphaned links or rows survive. Returns the deleted-row count. Write →
   * `tx` REQUIRED (the service runs it inside its delete transaction). An empty
   * id set short-circuits so we never issue a degenerate `IN ()`.
   */
  async deleteSubtree(ids: string[], tx: Prisma.TransactionClient): Promise<number> {
    if (ids.length === 0) return 0;
    const r = await tx.workItem.deleteMany({ where: { id: { in: ids } } });
    return r.count;
  },

  // --- Sprint association + backlog rank (Story 4.1 · Subtask 4.1.2) ---------
  // The `work_item` sprint/rank methods live HERE (the entity owns them — the
  // repository-name-matches-entity rule), not in a new repo. `sprintId` /
  // `backlogRank` are camelCase columns on `work_item` (NOT `@map`-ed — within-
  // table consistency, schema rung-2 decision), so raw SQL double-quotes them
  // verbatim. The service (4.1.4) computes the rank via `positioning.ts`; these
  // methods just persist/read it. Bounded reads only — never load-all (finding
  // #57). Writes require `tx`; reads carry the explicit `workspaceId` gate
  // (finding #26).

  /**
   * Associate an issue with a sprint, or move it back to the backlog
   * (`sprintId = null`). Single write; `tx` REQUIRED. The same-project guard
   * and the 1.4.6 revision write are the SERVICE's job (4.1.4) — this is the
   * bare association write.
   */
  async setSprint(
    itemId: string,
    sprintId: string | null,
    tx: Prisma.TransactionClient,
  ): Promise<WorkItem> {
    try {
      return await tx.workItem.update({ where: { id: itemId }, data: { sprintId } });
    } catch (err) {
      throw translateWriteError(err, { id: itemId });
    }
  },

  /**
   * Write an issue's global `backlogRank` (the opaque base-62 fractional index
   * the service computes via `positioning.ts` `keyBetween`). Single write; `tx`
   * REQUIRED. One row changes — there is no N-row renumber (the fractional index
   * is the whole point).
   */
  async setBacklogRank(
    itemId: string,
    rank: string,
    tx: Prisma.TransactionClient,
  ): Promise<WorkItem> {
    try {
      return await tx.workItem.update({ where: { id: itemId }, data: { backlogRank: rank } });
    } catch (err) {
      throw translateWriteError(err, { id: itemId });
    }
  },

  // --- Story points + estimation roll-ups (Story 4.3 · Subtask 4.3.3) --------
  // The agile `storyPoints` estimate lives on `work_item` (the entity owns it —
  // the repository-name-matches-entity rule), SEPARATE from `estimateMinutes`
  // (the TIME estimate, 2.3.6). `storyPoints` is a camelCase column (NOT
  // `@map`-ed — within-table consistency, schema rung-2), so raw SQL
  // double-quotes it verbatim. The roll-ups are BOUNDED aggregates (finding
  // #57) — one grouped/recursive query, NEVER a load-all + client sum. The
  // write requires `tx`; the aggregate reads carry the explicit `workspaceId`
  // gate (finding #26) and take an optional `tx`.

  /**
   * Set or clear (`points = null`) an issue's `storyPoints`. Single write; `tx`
   * REQUIRED. The value validation + the 1.4.6 revision are the SERVICE's job
   * (estimationService) — this is the bare column write. `Prisma.Decimal`
   * accepts a JS `number`, so the service passes the validated number through.
   */
  async setStoryPoints(
    itemId: string,
    points: number | null,
    tx: Prisma.TransactionClient,
  ): Promise<WorkItem> {
    try {
      return await tx.workItem.update({ where: { id: itemId }, data: { storyPoints: points } });
    } catch (err) {
      throw translateWriteError(err, { id: itemId });
    }
  },

  /**
   * The BOUNDED sprint points roll-up (finding #57): the configured `statistic`
   * summed over a sprint's non-archived issues, in ONE grouped aggregate.
   * `committed` is the total; `completed` is the same sum scoped — via an
   * aggregate `FILTER` over the LEFT-joined `workflow_status` — to issues whose
   * status maps to a `category = 'done'` workflow status (the finding-#21
   * terminal predicate). The `workspaceId` gate keeps the aggregate
   * tenant-scoped. NULL/empty sums `COALESCE` to 0, so an empty / wholly
   * unestimated sprint returns `{ committed: 0, completed: 0 }` (the single
   * aggregate row always exists). NEVER loads the rows.
   */
  async sumPointsForSprint(
    sprintId: string,
    workspaceId: string,
    statistic: EstimationStatistic,
    tx?: Prisma.TransactionClient,
    /** A Visitor's private-epic exclusion (MOTIR-6644). Absent ⇒ no clause. */
    excludeIds?: readonly string[],
  ): Promise<{ committed: number; completed: number }> {
    const client = tx ?? dbRead;
    const committed = pointsAggExpr(statistic, 'w', false);
    const completed = pointsAggExpr(statistic, 'w', true);
    const rows = await client.$queryRaw<Array<{ committed: number; completed: number }>>`
      SELECT ${committed}::float8 AS "committed",
             ${completed}::float8 AS "completed"
        FROM "work_item" w
        LEFT JOIN "workflow_status" ws
               ON ws."project_id" = w."projectId" AND ws."key" = w."status"
       WHERE w."sprintId" = ${sprintId}
         AND w."workspaceId" = ${workspaceId}
         AND w."archivedAt" IS NULL
         AND ${notExcludedSql('w', excludeIds)}`;
    return rows[0] ?? { committed: 0, completed: 0 };
  },

  /**
   * The BOUNDED current STARTED sum of a sprint (Story 8.14.4) — the configured
   * `statistic` summed over a sprint's non-archived issues whose status has LEFT
   * the `todo` category (i.e. is in an `in_progress`- OR `done`-category status —
   * "started" in Linear's cycle-graph sense). An aggregate `FILTER` over the
   * LEFT-joined `workflow_status`; a NULL category (no status row) is the initial
   * not-yet-started state and is excluded. The `workspaceId` gate keeps it
   * tenant-scoped; the sum `COALESCE`s to 0 (the single aggregate row always
   * exists). Used to ANCHOR the cycle graph's started series to the live present
   * (`startedAtStart = currentStarted − Σ startedDelta`). NEVER loads the rows.
   */
  async sumStartedForSprint(
    sprintId: string,
    workspaceId: string,
    statistic: EstimationStatistic,
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const startedFilter = Prisma.sql` FILTER (WHERE ws."category" IS NOT NULL AND ws."category" <> 'todo')`;
    const expr =
      statistic === 'issue_count'
        ? Prisma.sql`COUNT(*)${startedFilter}`
        : statistic === 'story_points'
          ? Prisma.sql`COALESCE(SUM(w."storyPoints")${startedFilter}, 0)`
          : Prisma.sql`COALESCE(SUM(w."estimateMinutes")${startedFilter}, 0)`;
    const client = tx ?? dbRead;
    const rows = await client.$queryRaw<Array<{ started: number }>>`
      SELECT ${expr}::float8 AS "started"
        FROM "work_item" w
        LEFT JOIN "workflow_status" ws
               ON ws."project_id" = w."projectId" AND ws."key" = w."status"
       WHERE w."sprintId" = ${sprintId}
         AND w."workspaceId" = ${workspaceId}
         AND w."archivedAt" IS NULL`;
    return rows[0]?.started ?? 0;
  },

  /**
   * The BOUNDED per-STATUS points breakdown of a sprint (Story 4.5.2) — the
   * configured `statistic` summed over the sprint's non-archived issues, GROUPED
   * by `work_item.status`, in ONE grouped aggregate (never a load-all + client
   * sum, finding #57). The board service folds these per-status sums into the
   * scrum board's `columnPoints` (one column = a set of mapped statuses), so the
   * per-column "sprint health" total comes from the DB, not the loaded card
   * page. A status with no estimated points sums to 0 (the `COALESCE` in
   * `pointsAggExpr`); a status with no sprint issues yields no row (the service
   * defaults an absent column to 0). `workspaceId` is the tenant gate (finding
   * #26). Returns one row per distinct status present in the sprint.
   */
  async sumPointsBySprintAndStatus(
    sprintId: string,
    workspaceId: string,
    statistic: EstimationStatistic,
    tx?: Prisma.TransactionClient,
    /** A Visitor's private-epic exclusion (MOTIR-6644). Absent ⇒ no clause. */
    excludeIds?: readonly string[],
  ): Promise<Array<{ status: string; points: number }>> {
    const client = tx ?? dbRead;
    const points = pointsAggExpr(statistic, 'w', false);
    return client.$queryRaw<Array<{ status: string; points: number }>>`
      SELECT w."status" AS "status",
             ${points}::float8 AS "points"
        FROM "work_item" w
       WHERE w."sprintId" = ${sprintId}
         AND w."workspaceId" = ${workspaceId}
         AND w."archivedAt" IS NULL
         AND ${notExcludedSql('w', excludeIds)}
       GROUP BY w."status"`;
  },

  /**
   * The BOUNDED epic/parent subtree roll-up (finding #57): the configured
   * `statistic` summed over the parent's DESCENDANTS at any depth, via a
   * recursive CTE walking DOWN the `parentId` edge — in ONE query, never a
   * load-the-subtree-and-sum. The anchor is the parent's DIRECT children (the
   * parent's own estimate is excluded — a roll-up of descendants), and the
   * recursion + the `workspaceId` gate on both the anchor and the recursive
   * step keep it tenant-scoped (finding #26). An empty subtree → `{ total: 0 }`
   * (the COALESCE/COUNT over zero rows). The walk is naturally bounded (the tree
   * depth is capped at 4, Story 1.4).
   */
  async sumPointsForParent(
    parentId: string,
    workspaceId: string,
    statistic: EstimationStatistic,
    tx?: Prisma.TransactionClient,
    /** A Visitor's private-epic exclusion (MOTIR-6652): the walk neither counts
     *  nor descends through a withheld row. Absent ⇒ no clause. */
    excludeIds?: readonly string[],
  ): Promise<{ total: number }> {
    const client = tx ?? dbRead;
    const total = pointsAggExpr(statistic, 's', false);
    const rows = await client.$queryRaw<Array<{ total: number }>>`
      WITH RECURSIVE subtree AS (
        SELECT w."id", w."storyPoints", w."estimateMinutes"
          FROM "work_item" w
          WHERE w."parentId" = ${parentId}
            AND w."workspaceId" = ${workspaceId}
            AND w."archivedAt" IS NULL
            AND ${notExcludedSql('w', excludeIds)}
        UNION ALL
        SELECT c."id", c."storyPoints", c."estimateMinutes"
          FROM "work_item" c
          JOIN subtree p ON c."parentId" = p."id"
          WHERE c."workspaceId" = ${workspaceId}
            AND c."archivedAt" IS NULL
            AND ${notExcludedSql('c', excludeIds)}
      )
      SELECT ${total}::float8 AS "total" FROM subtree s`;
    return rows[0] ?? { total: 0 };
  },

  /**
   * One bounded page of a project's BACKLOG — non-archived issues with
   * `sprintId IS NULL`, in `backlogRank` order (the `(projectId, sprintId,
   * backlogRank)` composite index, 4.1.1). Fetches `take + 1` so the service can
   * tell whether a next page exists and derive the next cursor (finding #57 —
   * NEVER load-all). `cursor` is a work-item id; the row at the cursor is skipped
   * so paging doesn't repeat it. `id` is the orderBy tiebreaker (backlogRank is
   * unique in practice, but the tiebreaker keeps the cursor walk total).
   */
  async findBacklogPage(
    projectId: string,
    workspaceId: string,
    options: {
      take: number;
      cursor?: string;
      excludeStatusKeys?: string[];
      // The shared backlog filter (Story 8.8 · Subtask 8.8.17) — a compiled
      // FilterAST AND-ed into the page read so the backlog shows only matching
      // issues. Omitted on the unfiltered backlog (the byte-for-byte 4.1.1
      // builder read below). Resolved by `backlogService.resolveBacklogFilter`.
      filter?: { ast: FilterAst; referents?: ProjectFilterReferents };
    },
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItem[]> {
    const client = tx ?? dbRead;
    const { take, cursor, excludeStatusKeys = [], filter } = options;

    // Advanced filter active (Subtask 8.8.17): AND the compiled FilterAST (alias
    // `w`) into the page read. The AST can't be expressed through the Prisma
    // query builder — it compiles to a parameterized SQL fragment over the full
    // row (incl. the 6.1.2 label/component/custom-field EXISTS probes) — so we
    // resolve the matching, seek-paginated, capped ids in ONE raw query that
    // applies the SAME base predicates as the builder path, then hydrate the
    // real `WorkItem` rows through Prisma and restore the raw query's order (the
    // 6.15.2 `findColumnCards` precedent, exactly). No filter → the existing
    // builder read, byte-for-byte the 4.1.1 projection (no regression).
    if (filter && filter.ast.conditions.length > 0) {
      const excludeSql =
        excludeStatusKeys.length > 0
          ? Prisma.sql`AND w."status" <> ALL(${excludeStatusKeys})`
          : Prisma.empty;
      // The seek predicate replicates Prisma's `cursor: { id }, skip: 1` over
      // `orderBy [backlogRank asc, id asc]`: continue STRICTLY AFTER the cursor
      // row in (backlogRank, id) order. The cursor row's keys are read by id
      // (its filter-match is irrelevant — the page boundary is filter-
      // independent, exactly as Prisma's cursor). The row-value `>` gives the
      // lexicographic (backlogRank, id) walk; both columns are text, so it
      // sorts identically to the Prisma orderBy.
      const cursorSql = cursor
        ? Prisma.sql`AND (w."backlogRank", w."id") > (
            SELECT c."backlogRank", c."id" FROM "work_item" c WHERE c."id" = ${cursor}
          )`
        : Prisma.empty;
      const idRows = await client.$queryRaw<Array<{ id: string }>>`
        SELECT w."id"
          FROM "work_item" w
          WHERE w."projectId" = ${projectId}
            AND w."workspaceId" = ${workspaceId}
            AND w."sprintId" IS NULL
            AND w."archivedAt" IS NULL
            AND ${notInTriageSql('w')}
            ${excludeSql}
            ${cursorSql}
            AND (${compileFilterConditionsSql(filter.ast, filter.referents)})
          ORDER BY w."backlogRank" ASC, w."id" ASC
          LIMIT ${take + 1}`;
      const ids = idRows.map((r) => r.id);
      if (ids.length === 0) return [];
      const rows = await client.workItem.findMany({ where: { id: { in: ids } } });
      const byId = new Map(rows.map((r) => [r.id, r]));
      // `findMany({ id: { in } })` does not preserve the id list order — restore
      // the raw query's (backlogRank, id) seek order + window.
      return ids.map((id) => byId.get(id)).filter((r): r is WorkItem => r !== undefined);
    }

    return client.workItem.findMany({
      where: {
        projectId,
        workspaceId,
        sprintId: null,
        archivedAt: null,
        // Read-exclusion (Subtask 6.11.3): a triage item is created parentless +
        // unsprinted, so without this it would surface in the backlog (a core
        // planning surface). The marker keeps it out until accept/promote.
        triagedAt: null,
        // The backlog is the to-be-planned pile, so issues in a `done`-category
        // status are excluded (mirror rung 1: Jira hides the Done column from the
        // backlog; in-progress unsprinted issues stay). The service passes the
        // project's done-category status keys; none → no filter.
        ...(excludeStatusKeys.length > 0 ? { status: { notIn: excludeStatusKeys } } : {}),
      },
      orderBy: [{ backlogRank: 'asc' }, { id: 'asc' }],
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  },

  /**
   * Total count of a project's backlog (non-archived, `sprintId IS NULL`, not in
   * a `done`-category status) — the "N issues" header the 4.2 backlog UI shows.
   * Scope matches `findBacklogPage` exactly (same `excludeStatusKeys`). Carries
   * the explicit `workspaceId` gate.
   */
  async countBacklog(
    projectId: string,
    workspaceId: string,
    excludeStatusKeys: string[] = [],
    // The same shared backlog filter `findBacklogPage` takes (Subtask 8.8.17):
    // when present the count is the FILTERED total (the "N issues" header tracks
    // the filtered page). Omitted → the byte-for-byte 4.1.1 Prisma count.
    filter?: { ast: FilterAst; referents?: ProjectFilterReferents },
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = tx ?? dbRead;

    // Filtered total (Subtask 8.8.17): COUNT over the SAME base predicates as
    // `findBacklogPage`'s raw read with the compiled FilterAST AND-ed in, so the
    // header denominator matches the filtered page exactly.
    if (filter && filter.ast.conditions.length > 0) {
      const excludeSql =
        excludeStatusKeys.length > 0
          ? Prisma.sql`AND w."status" <> ALL(${excludeStatusKeys})`
          : Prisma.empty;
      const rows = await client.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS "count"
          FROM "work_item" w
          WHERE w."projectId" = ${projectId}
            AND w."workspaceId" = ${workspaceId}
            AND w."sprintId" IS NULL
            AND w."archivedAt" IS NULL
            AND ${notInTriageSql('w')}
            ${excludeSql}
            AND (${compileFilterConditionsSql(filter.ast, filter.referents)})`;
      return rows[0]?.count ?? 0;
    }

    return client.workItem.count({
      where: {
        projectId,
        workspaceId,
        sprintId: null,
        archivedAt: null,
        triagedAt: null, // read-exclusion (6.11.3) — matches findBacklogPage
        ...(excludeStatusKeys.length > 0 ? { status: { notIn: excludeStatusKeys } } : {}),
      },
    });
  },

  /**
   * A sprint's non-archived issues, in `backlogRank` order (the one global rank
   * field orders within a sprint too). A sprint is smaller than the backlog, but
   * the read is still bounded by `take` (paged-capable, not unbounded — finding
   * #57). `workspaceId` gates the read.
   */
  async findSprintIssues(
    sprintId: string,
    workspaceId: string,
    options: {
      take: number;
      cursor?: string;
      // The shared backlog filter (Story 8.8 · Subtask 8.8.20) — a compiled
      // FilterAST AND-ed into the sprint page read so a filtered backlog
      // re-projects its sprint containers too (the 8.8.16 design). Omitted on the
      // unfiltered read (the byte-for-byte 4.1.4 builder read below). Resolved by
      // `backlogService.resolveBacklogFilter`, exactly as `findBacklogPage`.
      filter?: { ast: FilterAst; referents?: ProjectFilterReferents };
    },
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItem[]> {
    const client = tx ?? dbRead;
    const { take, cursor, filter } = options;

    // Advanced filter active (Subtask 8.8.20): AND the compiled FilterAST (alias
    // `w`) into the page read — the SAME raw-id-then-hydrate shape `findBacklogPage`
    // uses (the 6.15.2 `findColumnCards` precedent). The sprint base predicate
    // differs from the backlog's: `sprintId = X` (not `IS NULL`), and a sprint
    // KEEPS its done + triage-free issues (no `excludeStatusKeys` / `notInTriage`
    // — a sprint shows its whole committed set, matching the unfiltered read
    // below; `getSprintIssues` keeps done issues). No filter → the existing
    // builder read, byte-for-byte the 4.1.4 projection (no regression).
    if (filter && filter.ast.conditions.length > 0) {
      // Same seek predicate as `findBacklogPage`: continue STRICTLY AFTER the
      // cursor row in (backlogRank, id) order (replicates Prisma `cursor/skip:1`).
      const cursorSql = cursor
        ? Prisma.sql`AND (w."backlogRank", w."id") > (
            SELECT c."backlogRank", c."id" FROM "work_item" c WHERE c."id" = ${cursor}
          )`
        : Prisma.empty;
      const idRows = await client.$queryRaw<Array<{ id: string }>>`
        SELECT w."id"
          FROM "work_item" w
          WHERE w."sprintId" = ${sprintId}
            AND w."workspaceId" = ${workspaceId}
            AND w."archivedAt" IS NULL
            ${cursorSql}
            AND (${compileFilterConditionsSql(filter.ast, filter.referents)})
          ORDER BY w."backlogRank" ASC, w."id" ASC
          LIMIT ${take + 1}`;
      const ids = idRows.map((r) => r.id);
      if (ids.length === 0) return [];
      const rows = await client.workItem.findMany({ where: { id: { in: ids } } });
      const byId = new Map(rows.map((r) => [r.id, r]));
      // `findMany({ id: { in } })` does not preserve id-list order — restore the
      // raw query's (backlogRank, id) seek order + window.
      return ids.map((id) => byId.get(id)).filter((r): r is WorkItem => r !== undefined);
    }

    return client.workItem.findMany({
      where: { sprintId, workspaceId, archivedAt: null },
      orderBy: [{ backlogRank: 'asc' }, { id: 'asc' }],
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  },

  /**
   * Count of a sprint's non-archived issues (the committed-issue count). With a
   * `filter` (Subtask 8.8.20) the count is the FILTERED total — the numerator of
   * the design's "1 of 5" sprint badge; the unfiltered "of 5" denominator is the
   * separate `/api/sprints` metadata count (`sprintsService`), which never passes
   * a filter. Omitted → the byte-for-byte 4.1.4 Prisma count.
   */
  async countSprintIssues(
    sprintId: string,
    workspaceId: string,
    filter?: { ast: FilterAst; referents?: ProjectFilterReferents },
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = tx ?? dbRead;

    // Filtered total (Subtask 8.8.20): COUNT over the SAME base predicates as
    // `findSprintIssues`'s raw read with the compiled FilterAST AND-ed in.
    if (filter && filter.ast.conditions.length > 0) {
      const rows = await client.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS "count"
          FROM "work_item" w
          WHERE w."sprintId" = ${sprintId}
            AND w."workspaceId" = ${workspaceId}
            AND w."archivedAt" IS NULL
            AND (${compileFilterConditionsSql(filter.ast, filter.referents)})`;
      return rows[0]?.count ?? 0;
    }

    return client.workItem.count({ where: { sprintId, workspaceId, archivedAt: null } });
  },

  /**
   * A sprint's non-archived issues whose `status` is NOT one of
   * `excludeStatusKeys`, in `backlogRank` order (Story 4.4.3). With the
   * project's `done`-category status keys passed as the exclusion set, this is
   * the sprint's **unfinished** set — the issues `completeSprint` carries over
   * (the done issues stay on the completed sprint). An empty `excludeStatusKeys`
   * applies no status filter (every issue is "unfinished"). NOT `take`-bounded:
   * carry-over must move the WHOLE unfinished set atomically, so the caller
   * reads it inside the completion transaction; the set is bounded by the
   * sprint's own scope (a team sprint, not the unbounded backlog). `workspaceId`
   * gates the read (finding #26). The `backlogRank` order is what makes the
   * carried-over issues re-appear in the backlog in their existing order.
   */
  async findSprintIssuesExcludingStatuses(
    sprintId: string,
    workspaceId: string,
    excludeStatusKeys: string[],
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItem[]> {
    const client = tx ?? dbRead;
    return client.workItem.findMany({
      where: {
        sprintId,
        workspaceId,
        archivedAt: null,
        ...(excludeStatusKeys.length > 0 ? { status: { notIn: excludeStatusKeys } } : {}),
      },
      orderBy: [{ backlogRank: 'asc' }, { id: 'asc' }],
    });
  },

  /**
   * Sum of `storyPoints` over a sprint's non-archived issues — the committed-
   * points baseline `startSprint` snapshots at activation (Story 4.4.2). NULL-
   * estimate issues contribute nothing, and a wholly-unestimated sprint sums to
   * `null` (Prisma's `_sum` of all-NULLs) — the service maps that to a null
   * committed baseline (graceful "—", finding #57: the data layer stays total).
   * One aggregate Prisma op; the `workspaceId` filter is the tenant gate
   * (finding #26). Reusable by Story 4.3/4.6 roll-ups; defined here on the entity
   * that owns `storyPoints`.
   */
  async sumStoryPointsForSprint(
    sprintId: string,
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Prisma.Decimal | null> {
    const client = tx ?? dbRead;
    const result = await client.workItem.aggregate({
      where: { sprintId, workspaceId, archivedAt: null },
      _sum: { storyPoints: true },
    });
    return result._sum.storyPoints;
  },

  /**
   * One bounded, cursor-paginated page of a sprint's non-archived issues split
   * by done-category MEMBERSHIP (Story 4.4.4 — the sprint report's completed vs.
   * incomplete lists). With the project's `done`-category status keys as
   * `statusKeys`:
   *   • `include: true`  → issues whose `status` IS one of them — the COMPLETED
   *     list. An EMPTY `statusKeys` means the project has no done-category status,
   *     so NOTHING is complete: `status IN ()` matches no row (the empty-input
   *     guard the coverage gate requires a direct test for).
   *   • `include: false` → issues whose `status` is NOT one of them — the
   *     INCOMPLETE list. An EMPTY `statusKeys` applies no status filter, so EVERY
   *     issue is incomplete (mirrors `findSprintIssuesExcludingStatuses`).
   * In `backlogRank` order with the `id` tiebreak (the deterministic cursor
   * ordering `findSprintIssues` uses); takes `take + 1` so the service can detect
   * a next page. `workspaceId` gates the read (finding #26).
   */
  async findSprintIssuesByDoneMembership(
    sprintId: string,
    workspaceId: string,
    params: { statusKeys: string[]; include: boolean; take: number; cursor?: string },
    tx?: Prisma.TransactionClient,
  ): Promise<WorkItem[]> {
    const client = tx ?? dbRead;
    const { take, cursor } = params;
    return client.workItem.findMany({
      where: {
        sprintId,
        workspaceId,
        archivedAt: null,
        ...doneMembershipFilter(params.statusKeys, params.include),
      },
      orderBy: [{ backlogRank: 'asc' }, { id: 'asc' }],
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  },

  /**
   * Count of a sprint's non-archived issues split by done-category membership
   * (Story 4.4.4) — the grouped aggregate behind the report's completed /
   * incomplete COUNTS (never a loaded-page sum). Same `statusKeys` + `include`
   * semantics (and the same empty-`statusKeys` edge cases) as
   * `findSprintIssuesByDoneMembership`. One Prisma `count`; `workspaceId` gates it.
   */
  async countSprintIssuesByDoneMembership(
    sprintId: string,
    workspaceId: string,
    params: { statusKeys: string[]; include: boolean },
    tx?: Prisma.TransactionClient,
  ): Promise<number> {
    const client = tx ?? dbRead;
    return client.workItem.count({
      where: {
        sprintId,
        workspaceId,
        archivedAt: null,
        ...doneMembershipFilter(params.statusKeys, params.include),
      },
    });
  },

  /**
   * The `backlogRank` of each requested issue (the neighbour ranks `rankIssue`
   * needs when the client drops a card between two explicit neighbours). One
   * Prisma op; `workspaceId` gates the read; an empty id list short-circuits to
   * `[]` (the empty-input guard the coverage gate requires a direct test for).
   * Returns the id + rank only — the service picks the prev/next ranks and feeds
   * them to `positioning.ts` `keyBetween`.
   */
  async findBacklogRankByIds(
    itemIds: string[],
    workspaceId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<Array<{ id: string; backlogRank: string | null }>> {
    if (itemIds.length === 0) return [];
    const client = tx ?? dbRead;
    return client.workItem.findMany({
      where: { id: { in: itemIds }, workspaceId },
      select: { id: true, backlogRank: true },
    });
  },

  /**
   * The boundary `backlogRank` of a rank scope — the FIRST (`edge: 'min'`) or
   * LAST (`edge: 'max'`) non-archived issue's rank in either the backlog
   * (`sprintId = null`) or a sprint (`sprintId` set). Powers the degenerate
   * prepend (`min`) / append (`max`) cases of `rankIssue` when there is no
   * explicit neighbour on one side. One Prisma op (a single ordered row);
   * `workspaceId` gates the read. Returns `null` when the scope is empty (the
   * first issue placed — the service seeds an initial key).
   */
  async findBoundaryBacklogRank(
    projectId: string,
    workspaceId: string,
    sprintId: string | null,
    edge: 'min' | 'max',
    tx?: Prisma.TransactionClient,
  ): Promise<string | null> {
    const client = tx ?? dbRead;
    const row = await client.workItem.findFirst({
      where: { projectId, workspaceId, sprintId, archivedAt: null },
      orderBy: { backlogRank: edge === 'min' ? 'asc' : 'desc' },
      select: { backlogRank: true },
    });
    return row?.backlogRank ?? null;
  },
};

/**
 * The `status` `where` fragment for a done-category MEMBERSHIP split (Story
 * 4.4.4). `include` selects the COMPLETED side (`status IN keys`), `!include`
 * the INCOMPLETE side (`status NOT IN keys`). The empty-`statusKeys` edges are
 * deliberate and asymmetric: an `include` over `[]` yields `status: { in: [] }`
 * (matches nothing — when a project has no done-category status, nothing is
 * complete), while an exclude over `[]` returns `{}` (no filter — every issue is
 * incomplete), mirroring `findSprintIssuesExcludingStatuses`.
 */
function doneMembershipFilter(statusKeys: string[], include: boolean): Prisma.WorkItemWhereInput {
  if (include) return { status: { in: statusKeys } };
  return statusKeys.length > 0 ? { status: { notIn: statusKeys } } : {};
}

// --- Prisma/Postgres error → typed error translation (repository edge) ------

/**
 * Translate a write-path error into a typed work-items error. Trigger
 * rejections arrive (via the pg driver adapter) as an error whose `cause.code`
 * is SQLSTATE 23514 and whose message carries one of the WI_* markers; we key
 * on the marker (unique strings we control) and confirm via the SQLSTATE.
 * P2002 → key conflict; P2025 → not found. Anything else is rethrown
 * unchanged. Always throws — return type is `never`.
 */
/**
 * Escape the LIKE/ILIKE metacharacters (`\`, `%`, `_`) in a user-supplied
 * substring so `findProjectForest`'s text filter matches them LITERALLY — a
 * search for "50%" finds the literal "50%", not "50<anything>". The value is
 * still passed as a bound parameter (never string-interpolated), so this guards
 * pattern semantics, not injection. Backslash is the default ILIKE ESCAPE.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * The shared, multi-select filter shape the project reads accept — the tree
 * forest (`findProjectForest`) and the flat List (`findProjectIssuesFlat`).
 * Each faceted axis is a SET: `kinds` / `statuses` / `assigneeIds` match "any
 * of", AND-ed across facets (Jira's basic filters; the 2.5.4 filter bar). The
 * assignee facet is the UNION of `assigneeIds` (specific members) with
 * `includeUnassigned` (items with a null `assigneeId`). Callers pass only the
 * non-empty axes (an empty facet is omitted, not an empty array). `text` is a
 * single substring.
 */
export interface RepoIssueFilter {
  kinds?: WorkItemKind[];
  /** The work-item TYPE facet (the 6.15 quick-filter facet) — "any of" these
   * `WorkItemType` members, UNION-ed with `includeUntyped` (a null `type`).
   * `type` is nullable, so the union COALESCEs to a clean boolean exactly like
   * the assignee facet. */
  types?: WorkItemType[];
  /** Include items with a null `type` (the "Untyped" bucket), OR-ed with `types`. */
  includeUntyped?: boolean;
  statuses?: string[];
  assigneeIds?: string[];
  includeUnassigned?: boolean;
  text?: string;
  /**
   * Sprint scope (Story 4.5.2) — restrict to issues in this sprint. Used by the
   * scrum board's `countProjectIssues` (the per-column `totalCount` + the
   * truncation denominator + the epic catch-all), which scans the full
   * `work_item` table (alias `w`, all columns available). The forest read
   * (`findProjectForest`, alias `f`) projects a fixed column set that does NOT
   * include `sprintId`, so it MUST NOT be passed this axis — its callers (the
   * issue tree) never do.
   */
  sprintId?: string;
  /**
   * The advanced filter builder's compiled axis (Story 6.1 · 6.1.1) — a
   * validated {@link FilterAst}, AND-ed with the facet axes above (the facet
   * shape REMAINS as the degenerate all-AND quick path; this is the
   * superseding rich shape). Compiled over the full `work_item` row (alias
   * `w`) by {@link compileFilterConditionsSql}; the forest read satisfies
   * that by joining `work_item` back onto the CTE for the `matched` flag (the
   * CTE's fixed projection lacks `sprintId` / `createdAt` / `descriptionMd`).
   */
  ast?: FilterAst;
  /**
   * The per-project referent set the AST's Epic-5 conditions (labels /
   * components / `cf:<fieldId>` custom fields, Subtask 6.1.2) resolve
   * against — loaded by the SERVICE from bounded reads over the ids the
   * filter references. Omitted (or missing an id) ⇒ those conditions are
   * STALE referents and compile to match-nothing `FALSE` (the deleted-id
   * degrade rule, never an error). Built-in-only ASTs don't need it.
   */
  filterReferents?: ProjectFilterReferents;
  /**
   * The epic-privacy public exclusion (Story 6.14 · Subtask 6.14.4) — a hard
   * row-exclusion set (the descendants of a private epic) applied by the flat
   * COUNT read {@link workItemRepository.countProjectIssues} so a non-member's
   * board denominators never count a hidden subtree. Resolved by {@link
   * workItemRepository.findPublicHiddenDescendantIds}. Honored as a real WHERE
   * filter by `countProjectIssues`, by the flat List and keyset reads (through
   * `projectIssuesScopeSql`) and by the forest's recursion (MOTIR-6644 — a
   * Visitor reads those in-app views); it is deliberately NOT emitted by {@link
   * buildIssueFilterSql} (whose output is the forest read's `matched` SELECT
   * FLAG, not a WHERE filter — emitting it there would mis-flag rather than
   * exclude). Absent/empty ⇒ no-op (members + the no-private-epic case read the
   * unchanged projection).
   */
  excludeIds?: readonly string[];
}

/**
 * The optional advanced-filter axis for the BOARD reads (Story 6.15.2) — a
 * compiled {@link FilterAst} (+ the per-project Epic-5 {@link
 * ProjectFilterReferents} its label/component/custom-field conditions resolve
 * against) AND-ed into the board's card read + lane aggregates so a filtered
 * board shows ONLY matching cards (and the cap/`truncated`/lane counts are
 * computed over that filtered set). The board reads take it positionally rather
 * than through {@link RepoIssueFilter} because they already thread `statusKeys`
 * / `sprintId` positionally; the service resolves the same `{ ast, referents }`
 * it passes to `countProjectIssues` via `RepoIssueFilter`.
 */
export interface BoardCardFilter {
  ast?: FilterAst;
  referents?: ProjectFilterReferents;
  /** The epic-privacy exclusion (MOTIR-6644) — a Visitor's board lanes never
   *  count a private epic's descendant. Absent/empty ⇒ no clause. */
  excludeIds?: readonly string[];
}

/** The board filter as a `Prisma.Sql` predicate over alias `w`: the compiled
 * FilterAST when one is active, else `TRUE` (so an absent filter is a no-op and
 * the board read stays byte-for-byte the unfiltered projection), AND-ed with the
 * Visitor's exclusion when one is given. */
function boardCardFilterSql(filter?: BoardCardFilter): Prisma.Sql {
  const ast =
    filter?.ast && filter.ast.conditions.length > 0
      ? Prisma.sql`(${compileFilterConditionsSql(filter.ast, filter.referents)})`
      : Prisma.sql`TRUE`;
  if (!filter?.excludeIds || filter.excludeIds.length === 0) return ast;
  return Prisma.sql`${ast} AND ${notExcludedSql('w', filter.excludeIds)}`;
}

// ---------------------------------------------------------------------------
// The FilterAST compiler (Subtask 6.1.1) — AST → parameterized WHERE fragment
// ---------------------------------------------------------------------------

/**
 * Fixed column references for the registered built-in fields, over the full
 * `work_item` alias `w`. Field/operator ids NEVER reach SQL text — they
 * resolve through this map (and the operator switch below) to fixed literals;
 * every user VALUE binds as a `Prisma.sql` parameter. Enum columns cast
 * `::text` so bound text arrays compare text-to-text (the
 * `buildIssueFilterSql` convention).
 */
const FILTER_FIELD_COLUMN_SQL: Record<Exclude<BuiltInFilterFieldId, 'text'>, Prisma.Sql> = {
  kind: Prisma.sql`w."kind"::text`,
  status: Prisma.sql`w."status"`,
  ciState: Prisma.sql`w."ciState"`,
  fixReason: Prisma.sql`w."fixReason"::text`,
  priority: Prisma.sql`w."priority"::text`,
  type: Prisma.sql`w."type"::text`,
  difficulty: Prisma.sql`w."difficulty"::text`,
  obsolescence: Prisma.sql`w."obsolescence"::text`,
  assignee: Prisma.sql`w."assigneeId"`,
  reporter: Prisma.sql`w."reporterId"`,
  sprint: Prisma.sql`w."sprintId"`,
  created: Prisma.sql`w."createdAt"`,
  updated: Prisma.sql`w."updatedAt"`,
  due: Prisma.sql`w."dueDate"`,
  storyPoints: Prisma.sql`w."storyPoints"`,
  estimate: Prisma.sql`w."estimateMinutes"`,
};

/**
 * Enum-list membership — `col = ANY(values)` OR-ed with `IS NULL` when the
 * list carries the field's empty-bucket sentinel ("Unassigned" / "Backlog"),
 * COALESCE-d to a clean boolean (NULL-safe three-valued logic, the
 * buildIssueFilterSql assignee precedent). `is_none_of` is its negation —
 * which, on a nullable column WITHOUT the sentinel in the list, includes the
 * empty bucket (an unassigned issue is assigned to "none of" any member
 * list), and excludes it when the sentinel IS listed.
 */
function enumListSql(
  column: Prisma.Sql,
  values: string[],
  sentinel: string | undefined,
  negate: boolean,
): Prisma.Sql {
  const includeEmpty = sentinel !== undefined && values.includes(sentinel);
  const ids = sentinel === undefined ? values : values.filter((v) => v !== sentinel);
  const terms: Prisma.Sql[] = [];
  if (ids.length > 0) terms.push(Prisma.sql`${column} = ANY(${ids})`);
  if (includeEmpty) terms.push(Prisma.sql`${column} IS NULL`);
  /* istanbul ignore next -- defensive: validation requires ≥1 value, so terms is never empty */
  if (terms.length === 0) return Prisma.sql`FALSE`;
  const membership = Prisma.sql`COALESCE((${Prisma.join(terms, ' OR ')}), FALSE)`;
  return negate ? Prisma.sql`NOT (${membership})` : membership;
}

/** The free-text contains-match — title OR description (the story's scope),
 * pattern-escaped, ILIKE backed by the pg_trgm GIN index this subtask's
 * migration adds (finding #57). The positive form stays a PLAIN two-arm OR:
 * wrapping the nullable-description arm in COALESCE defeats the index
 * (BitmapOr needs directly-indexable clauses), and WHERE treats the NULL it
 * can yield as unmatched anyway; the projection site that needs a clean
 * boolean (the forest's `matched` column) COALESCEs the WHOLE fragment. The
 * negation keeps the inner COALESCE — `NOT` must not turn a NULL description
 * into a dropped row, and a NOT-ILIKE can't use the index regardless. */
function textMatchSql(value: string, negate: boolean): Prisma.Sql {
  const pattern = `%${escapeLikePattern(value.trim())}%`;
  if (negate) {
    return Prisma.sql`NOT (w."title" ILIKE ${pattern} OR COALESCE(w."descriptionMd" ILIKE ${pattern}, FALSE))`;
  }
  return Prisma.sql`(w."title" ILIKE ${pattern} OR w."descriptionMd" ILIKE ${pattern})`;
}

const NUMBER_COMPARE_SQL: Record<'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte', Prisma.Sql> = {
  eq: Prisma.sql`=`,
  ne: Prisma.sql`<>`,
  lt: Prisma.sql`<`,
  lte: Prisma.sql`<=`,
  gt: Prisma.sql`>`,
  gte: Prisma.sql`>=`,
};

// ---------------------------------------------------------------------------
// The Epic-5 condition compilers (Subtask 6.1.2) — the documented join
// contracts: `work_item_label` / `work_item_component` EXISTS probes (5.4.1)
// and the typed-EAV `custom_field_value` probes over the four
// `[fieldId, value*]` indexes (5.3.1). Each condition is a self-contained
// correlated subquery with its own alias scope, so any number of conditions
// compose under either combinator with no join collision (bounded by the
// 20-row cap). Table/column names are fixed literals selected by enum
// switches — only VALUES bind as parameters.
// ---------------------------------------------------------------------------

const JOIN_LIST_SQL = {
  lbl: {
    table: Prisma.sql`"work_item_label"`,
    idColumn: Prisma.sql`"label_id"`,
  },
  cmp: {
    table: Prisma.sql`"work_item_component"`,
    idColumn: Prisma.sql`"component_id"`,
  },
} as const;

/**
 * A label/component condition → the 5.4.1 EXISTS probe. `is_any_of` walks the
 * reverse-edge index (`[labelId]` / `[componentId]`); `is_none_of` is its
 * NOT-EXISTS (which — join rows being absent — includes the no-labels bucket,
 * the enum none-of rule); `is empty` = no join rows at all.
 */
function joinListConditionSql(entity: 'lbl' | 'cmp', condition: FilterCondition): Prisma.Sql {
  const { table, idColumn } = JOIN_LIST_SQL[entity];
  switch (condition.operator) {
    case 'is_any_of':
    case 'is_none_of': {
      const ids = condition.value as string[];
      const exists = Prisma.sql`EXISTS (SELECT 1 FROM ${table} j WHERE j."work_item_id" = w."id" AND j.${idColumn} = ANY(${ids}))`;
      return condition.operator === 'is_none_of' ? Prisma.sql`NOT ${exists}` : exists;
    }
    case 'is_empty':
      return Prisma.sql`NOT EXISTS (SELECT 1 FROM ${table} j WHERE j."work_item_id" = w."id")`;
    case 'is_not_empty':
      return Prisma.sql`EXISTS (SELECT 1 FROM ${table} j WHERE j."work_item_id" = w."id")`;
    /* istanbul ignore next -- defensive: resolveFilterAst pins lbl/cmp to the enum operator set before this switch */
    default:
      throw new UnknownFilterOperatorError(condition.field, condition.operator);
  }
}

/**
 * "Today", anchored in **UTC** — the boundary every relative date window
 * (`in_last_days` / `in_next_days`) is measured from. NEVER `CURRENT_DATE`
 * (MOTIR-2056).
 *
 * **The defect this replaces.** `CURRENT_DATE` is evaluated in the Postgres
 * **session** timezone, while the stored values it was compared against are
 * UTC: `w."createdAt"` / `"updatedAt"` / `"dueDate"` are `timestamp(3)`
 * WITHOUT time zone holding UTC instants (so `col::date` is the UTC calendar
 * date), and `custom_field_value.value_date` is a `date` written from the
 * date-only-ISO/UTC convention. On any session whose timezone is not UTC the
 * two sides are different calendars, so the window was off by one day for the
 * hours where the local and UTC dates disagree — a row created one second ago
 * did not match `created in_last_days 1`. It never showed up in CI because CI
 * runs a UTC session; it was a real defect on every other deployment. Same
 * class as the `NOW()`-vs-naive-`timestamp(3)` rule already pinned in
 * `CLAUDE.md`: never let a naive UTC column meet a session-local instant.
 *
 * **The decision: UTC, not session-local and not viewer-local.** UTC is what
 * the storage means, and it is already the app's pinned display zone
 * (`lib/utils/datetime.ts` renders every issue timestamp in UTC, and the
 * dashboard/reports/filter surfaces pass it explicitly). Anchoring here keeps
 * the relative operators agreeing with both the stored value and what the user
 * is shown, and makes the result independent of whichever timezone the
 * database session happens to carry. `now()` is `timestamptz`, so
 * `AT TIME ZONE 'UTC'` re-reads that instant as a naive UTC timestamp and
 * `::date` truncates it to the UTC calendar day.
 *
 * **The ABSOLUTE operators (`on_or_before` / `on_or_after` / `between`) stay
 * as they are — deliberately.** They compare `col::date` against a
 * caller-supplied `'YYYY-MM-DD'::date`. Neither side reads the session
 * timezone, so unlike the relative windows they were never skewed; a client
 * date already means a *UTC calendar day*, which is the same meaning the
 * relative windows now carry and the same one the UI renders. Making them
 * viewer-local instead would need a timezone threaded from the request down
 * into this compiler and would then disagree with every rendered timestamp —
 * a product change, not a bug fix. Recorded here so the choice stays explicit.
 */
const UTC_TODAY_SQL = Prisma.sql`(now() AT TIME ZONE 'UTC')::date`;

/** The typed value column a custom field's conditions probe (the 5.3.1
 * `[fieldId, value*]` index family), per field type. */
const CF_VALUE_COLUMN_SQL: Record<CustomFieldFilterType, Prisma.Sql> = {
  text: Prisma.sql`v."value_text"`,
  number: Prisma.sql`v."value_number"`,
  date: Prisma.sql`v."value_date"`,
  select: Prisma.sql`v."value_option_id"`,
  user: Prisma.sql`v."value_user_id"`,
};

/** The correlated probe: does this issue carry a value row for the field
 * satisfying `valuePredicate`? The `[fieldId, value*]` composite indexes
 * serve the (field_id, value) pair; the `[workItemId, fieldId]` unique
 * serves the correlation. */
function cfExistsSql(fieldId: string, valuePredicate: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`EXISTS (SELECT 1 FROM "custom_field_value" v WHERE v."work_item_id" = w."id" AND v."field_id" = ${fieldId} AND ${valuePredicate})`;
}

/**
 * A `cf:<fieldId>` condition → its typed-EAV probe (the 5.3.1 contract).
 * Empty == no value row (clearing DELETES the row — no tombstones), so
 * `is empty` compiles to NOT EXISTS; the `IS NOT NULL` arm additionally
 * covers the one nullable-in-place case (a deleted user SetNulls
 * `value_user_id`, leaving the row behind). The negative value operators
 * keep the JQL `!=`/`!~` rule the built-ins pin: `ne`/`not_contains`
 * require a value row (empties don't match — `is empty` is the explicit
 * operator), while `is_none_of`'s NOT-EXISTS includes the empty bucket
 * (the enum none-of rule).
 */
function customFieldConditionSql(
  condition: FilterCondition,
  cf: { id: string; fieldType: CustomFieldFilterType },
): Prisma.Sql {
  const column = CF_VALUE_COLUMN_SQL[cf.fieldType];
  const { operator, value } = condition;
  switch (operator) {
    case 'is_any_of':
    case 'is_none_of': {
      const exists = cfExistsSql(cf.id, Prisma.sql`${column} = ANY(${value as string[]})`);
      return operator === 'is_none_of' ? Prisma.sql`NOT ${exists}` : exists;
    }
    case 'is_empty':
      return Prisma.sql`NOT ${cfExistsSql(cf.id, Prisma.sql`${column} IS NOT NULL`)}`;
    case 'is_not_empty':
      return cfExistsSql(cf.id, Prisma.sql`${column} IS NOT NULL`);
    case 'eq':
    case 'ne':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return cfExistsSql(
        cf.id,
        Prisma.sql`${column} ${NUMBER_COMPARE_SQL[operator]} ${value as number}`,
      );
    case 'contains':
    case 'not_contains': {
      const pattern = `%${escapeLikePattern((value as string).trim())}%`;
      return operator === 'contains'
        ? cfExistsSql(cf.id, Prisma.sql`${column} ILIKE ${pattern}`)
        : cfExistsSql(cf.id, Prisma.sql`NOT (${column} ILIKE ${pattern})`);
    }
    case 'on_or_before':
      return cfExistsSql(cf.id, Prisma.sql`${column} <= (${value as string})::date`);
    case 'on_or_after':
      return cfExistsSql(cf.id, Prisma.sql`${column} >= (${value as string})::date`);
    case 'between': {
      const [from, to] = value as [string, string];
      return cfExistsSql(cf.id, Prisma.sql`${column} BETWEEN (${from})::date AND (${to})::date`);
    }
    // `value_date` is a `date` written from the date-only-ISO/UTC convention,
    // so the window boundary is UTC too — see UTC_TODAY_SQL (MOTIR-2056).
    case 'in_last_days':
      return cfExistsSql(
        cf.id,
        Prisma.sql`${column} >= ${UTC_TODAY_SQL} - (${value as number})::int AND ${column} <= ${UTC_TODAY_SQL}`,
      );
    case 'in_next_days':
      return cfExistsSql(
        cf.id,
        Prisma.sql`${column} >= ${UTC_TODAY_SQL} AND ${column} <= ${UTC_TODAY_SQL} + (${value as number})::int`,
      );
  }
}

/**
 * The work-item TREE-DEPTH limit — a root is depth 1, and the
 * `enforce_work_item_depth_limit` trigger raises `WI_DEPTH_LIMIT_EXCEEDED`
 * (→ `DepthLimitExceededError`) past 4 (prisma/migrations/
 * 20260817160000_work_item_parent_tenancy). So any item reaches its root in at
 * most `WORK_ITEM_MAX_DEPTH - 1` parent hops.
 */
const WORK_ITEM_MAX_DEPTH = 4;

/**
 * `w`'s EFFECTIVE folder (Story MOTIR-5309 · MOTIR-5376): its own `folderId`,
 * else its ROOT ancestor's. Only a root can carry a folder — the CHECK
 * `work_item_parent_xor_folder` keeps `parentId` and `folderId` apart — so at
 * most one link of the parent chain is non-null and a COALESCE down it is exact.
 * The hops are built from {@link WORK_ITEM_MAX_DEPTH}, so the walk covers the
 * whole chain the trigger allows. Aliases are fixed literals; nothing binds.
 */
const EFFECTIVE_FOLDER_SQL: Prisma.Sql = (() => {
  const folders: Prisma.Sql[] = [Prisma.sql`w."folderId"`];
  const joins: Prisma.Sql[] = [];
  let child = Prisma.sql`w`;
  for (let hop = 1; hop < WORK_ITEM_MAX_DEPTH; hop++) {
    const alias = Prisma.raw(`"fp${hop}"`);
    joins.push(Prisma.sql`LEFT JOIN "work_item" ${alias} ON ${alias}."id" = ${child}."parentId"`);
    folders.push(Prisma.sql`${alias}."folderId"`);
    child = alias;
  }
  return Prisma.sql`(SELECT COALESCE(${Prisma.join(folders, ', ')}) FROM (SELECT 1) "fp0" ${Prisma.join(joins, ' ')})`;
})();

/**
 * The chosen folder ids PLUS every folder beneath them — a recursive walk DOWN
 * `folder.parent_folder_id`, the reverse of `folderRepository.findAncestorIds`,
 * bounded like it. UNCORRELATED on purpose, so Postgres evaluates it once per
 * query rather than once per row; it needs no `w."projectId"` scope because every
 * id reaching SQL survived the referent check (`loadFilterReferents` keeps only
 * this project's folders — any other id is stale and compiles to `FALSE` before
 * this runs), and a folder's subtree never leaves its project (the folder service
 * refuses a cross-project move with `CrossProjectFolderError`).
 */
function folderSubtreeIdsSql(folderIds: string[]): Prisma.Sql {
  return Prisma.sql`ARRAY(
    WITH RECURSIVE "fsel" AS (
      SELECT f."id", 0 AS depth FROM "folder" f WHERE f."id" = ANY(${folderIds})
      UNION ALL
      SELECT c."id", s.depth + 1 FROM "folder" c JOIN "fsel" s ON c."parent_folder_id" = s."id"
       WHERE s.depth < 1000
    )
    SELECT "id" FROM "fsel")`;
}

/**
 * A FOLDER condition → its predicate over the effective folder. `is_any_of` is
 * membership in the chosen folders' subtrees; `is_none_of` is its negation,
 * which — the effective folder being NULL for an unfiled item — includes the
 * unfiled bucket (the enum none-of rule); the empty pair reads the effective
 * folder's presence.
 */
function folderConditionSql(condition: FilterCondition): Prisma.Sql {
  switch (condition.operator) {
    case 'is_any_of':
    case 'is_none_of': {
      const member = Prisma.sql`COALESCE(${EFFECTIVE_FOLDER_SQL} = ANY(${folderSubtreeIdsSql(condition.value as string[])}), FALSE)`;
      return condition.operator === 'is_none_of' ? Prisma.sql`NOT ${member}` : member;
    }
    case 'is_empty':
      return Prisma.sql`${EFFECTIVE_FOLDER_SQL} IS NULL`;
    case 'is_not_empty':
      return Prisma.sql`${EFFECTIVE_FOLDER_SQL} IS NOT NULL`;
    // resolveFilterAst pins `folder` to the enum operator set before this switch.
    /* v8 ignore next 2 */
    default:
      throw new UnknownFilterOperatorError(condition.field, condition.operator);
  }
}

/** One resolved condition → its parenthesized predicate fragment. */
function compileConditionSql(condition: FilterCondition, def: FilterFieldDef): Prisma.Sql {
  if (def.customField) return customFieldConditionSql(condition, def.customField);
  if (def.id === 'lbl' || def.id === 'cmp') return joinListConditionSql(def.id, condition);
  if (def.id === 'folder') return folderConditionSql(condition);
  const { field, operator, value } = condition;
  if (field === 'text') {
    // Validation pinned the text ops + a string value.
    return textMatchSql(value as string, operator === 'not_contains');
  }
  const column = FILTER_FIELD_COLUMN_SQL[field as Exclude<BuiltInFilterFieldId, 'text'>];
  switch (operator) {
    case 'is_any_of':
    case 'is_none_of': {
      return enumListSql(column, value as string[], def.emptySentinel, operator === 'is_none_of');
    }
    case 'is_empty':
      return Prisma.sql`${column} IS NULL`;
    case 'is_not_empty':
      return Prisma.sql`${column} IS NOT NULL`;
    case 'eq':
    case 'ne':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      // `ne` deliberately excludes the empty bucket (NULL <> v is NULL →
      // unmatched) — the documented JQL `!=` rule the registry mirrors.
      return Prisma.sql`${column} ${NUMBER_COMPARE_SQL[operator]} ${value as number}`;
    case 'on_or_before':
      return Prisma.sql`${column}::date <= (${value as string})::date`;
    case 'on_or_after':
      return Prisma.sql`${column}::date >= (${value as string})::date`;
    case 'between': {
      const [from, to] = value as [string, string];
      return Prisma.sql`${column}::date BETWEEN (${from})::date AND (${to})::date`;
    }
    // `col::date` on a naive-UTC `timestamp(3)` is the UTC calendar date, so
    // the window boundary must be UTC too — see UTC_TODAY_SQL (MOTIR-2056).
    case 'in_last_days':
      return Prisma.sql`${column}::date >= ${UTC_TODAY_SQL} - (${value as number})::int AND ${column}::date <= ${UTC_TODAY_SQL}`;
    case 'in_next_days':
      return Prisma.sql`${column}::date >= ${UTC_TODAY_SQL} AND ${column}::date <= ${UTC_TODAY_SQL} + (${value as number})::int`;
    // A text operator on a NON-text field. GENUINELY unreachable, and I first
    // concluded otherwise (MOTIR-2815): a repository is normally a leaf that
    // trusts its caller, so this looked testable from the repository's own
    // surface. It is not. Every path into this switch goes through
    // `compileFilterConditionsSql` -> `resolveFilterAst` ->
    // `validateResolvedCondition`, which throws `UnknownFilterOperatorError`
    // (`lib/filters/registry.ts`) for exactly this shape BEFORE the compiler runs.
    //
    // ⚠️ THE TEST THAT "COVERED" IT WAS PASSING ON THE VALIDATOR'S THROW — same
    // error class, different layer — which CI's coverage report caught and a
    // green assertion did not. So: a directive, not a test.
    //
    // ⚠️ ONE LINE on purpose. `next N` counts from the DIRECTIVE'S OWN line, so a
    // multi-line comment makes the range swallow its own text and cover nothing
    // (measured — it cost a 33-minute run). And it is spelled for V8, not
    // istanbul: the provider is `v8`, so the `istanbul ignore` this replaced never
    // applied and the branch was counted uncovered all along.
    /* v8 ignore next 3 */
    case 'contains':
    case 'not_contains':
      throw new UnknownFilterOperatorError(field, operator);
  }
}

/**
 * Compile a FilterAST into one parameterized predicate over the `work_item`
 * alias `w` (Subtask 6.1.1; Epic-5 conditions 6.1.2). Re-resolves against the
 * registry + the referents first (defence in depth — typed 422s, mistake #29:
 * no unvalidated AST can reach SQL even through a future second caller), then
 * joins the per-condition fragments under the AND/OR combinator. A STALE
 * condition (a deleted field/option/label/component referent — including the
 * no-referents default, under which every Epic-5 condition is stale) compiles
 * to `FALSE`: it matches nothing under either combinator, never errors, and
 * none of its input reaches SQL at all. An empty row set compiles to `TRUE`
 * (match all). Exported for the injection/operator test matrix.
 */
export function compileFilterConditionsSql(
  ast: FilterAst,
  referents?: ProjectFilterReferents,
): Prisma.Sql {
  const resolved = resolveFilterAst(ast, referents);
  if (resolved.conditions.length === 0) return Prisma.sql`TRUE`;
  const fragments = resolved.conditions.map((rc) =>
    rc.stale !== null || rc.def === null
      ? Prisma.sql`(FALSE)`
      : Prisma.sql`(${compileConditionSql(rc.condition, rc.def)})`,
  );
  return Prisma.join(fragments, ast.combinator === 'or' ? ' OR ' : ' AND ');
}

// ---------------------------------------------------------------------------
// The distribution group-by fragments (Story 6.3 · Subtask 6.3.2)
// ---------------------------------------------------------------------------

/**
 * Map a TOTAL `DistributionGroupBy` descriptor to its fixed SQL fragments —
 * the id/label projections and the (LEFT) joins they read through. Table and
 * column names are FIXED LITERALS selected by the closed switches below
 * (the `FILTER_FIELD_COLUMN_SQL` rule — descriptor ids never reach SQL
 * text); the only bound value is the custom-field id. LEFT joins everywhere
 * so the empty bucket (no assignee / no sprint / no label / no value row)
 * groups under NULL — the designed "None" segment. The label/component join
 * rides the 5.4.1 reverse-edge indexes; the custom-field probe rides the
 * 5.3.1 `[workItemId, fieldId]` unique.
 */
/** The `column`-strategy fragments — `work_item` scalars, labelled through
 * their referent table where one exists. Status keys label through the
 * project's `workflow_status` rows (one project per scope — saved filters
 * are project-contained); enum columns (kind/priority) self-describe, the
 * UI translates. */
function columnGroupBySql(
  column: 'kind' | 'status' | 'priority' | 'assignee' | 'reporter' | 'sprint',
): { idExpr: Prisma.Sql; labelExpr: Prisma.Sql; joinSql: Prisma.Sql } {
  switch (column) {
    case 'kind':
      return {
        idExpr: Prisma.sql`w."kind"::text`,
        labelExpr: Prisma.sql`NULL::text`,
        joinSql: Prisma.empty,
      };
    case 'priority':
      return {
        idExpr: Prisma.sql`w."priority"::text`,
        labelExpr: Prisma.sql`NULL::text`,
        joinSql: Prisma.empty,
      };
    case 'status':
      return {
        idExpr: Prisma.sql`w."status"`,
        labelExpr: Prisma.sql`st."label"`,
        joinSql: Prisma.sql`LEFT JOIN "workflow_status" st ON st."project_id" = w."projectId" AND st."key" = w."status"`,
      };
    case 'assignee':
      return {
        idExpr: Prisma.sql`w."assigneeId"`,
        labelExpr: Prisma.sql`au."name"`,
        joinSql: Prisma.sql`LEFT JOIN "user" au ON au."id" = w."assigneeId"`,
      };
    case 'reporter':
      return {
        idExpr: Prisma.sql`w."reporterId"`,
        labelExpr: Prisma.sql`ru."name"`,
        joinSql: Prisma.sql`LEFT JOIN "user" ru ON ru."id" = w."reporterId"`,
      };
    case 'sprint':
      return {
        idExpr: Prisma.sql`w."sprintId"`,
        labelExpr: Prisma.sql`sp."name"`,
        joinSql: Prisma.sql`LEFT JOIN "sprint" sp ON sp."id" = w."sprintId"`,
      };
  }
}

function distributionGroupBySql(groupBy: DistributionGroupBy): {
  idExpr: Prisma.Sql;
  labelExpr: Prisma.Sql;
  joinSql: Prisma.Sql;
} {
  switch (groupBy.kind) {
    case 'column':
      return columnGroupBySql(groupBy.column);
    case 'join':
      return groupBy.entity === 'label'
        ? {
            idExpr: Prisma.sql`l."id"`,
            labelExpr: Prisma.sql`l."name"`,
            joinSql: Prisma.sql`LEFT JOIN "work_item_label" jl ON jl."work_item_id" = w."id" LEFT JOIN "label" l ON l."id" = jl."label_id"`,
          }
        : {
            idExpr: Prisma.sql`c."id"`,
            labelExpr: Prisma.sql`c."name"`,
            joinSql: Prisma.sql`LEFT JOIN "work_item_component" jc ON jc."work_item_id" = w."id" LEFT JOIN "component" c ON c."id" = jc."component_id"`,
          };
    case 'customField':
      return groupBy.fieldType === 'select'
        ? {
            idExpr: Prisma.sql`v."value_option_id"`,
            labelExpr: Prisma.sql`o."label"`,
            joinSql: Prisma.sql`LEFT JOIN "custom_field_value" v ON v."work_item_id" = w."id" AND v."field_id" = ${groupBy.fieldId} LEFT JOIN "custom_field_option" o ON o."id" = v."value_option_id"`,
          }
        : {
            idExpr: Prisma.sql`v."value_user_id"`,
            labelExpr: Prisma.sql`vu."name"`,
            joinSql: Prisma.sql`LEFT JOIN "custom_field_value" v ON v."work_item_id" = w."id" AND v."field_id" = ${groupBy.fieldId} LEFT JOIN "user" vu ON vu."id" = v."value_user_id"`,
          };
  }
}

/**
 * The single, total "not in triage" exclusion (Subtask 6.11.3, per
 * docs/decisions/triage-model.md §2). A submission is born a `work_item`
 * carrying a `triagedAt` marker that hides it from EVERY normal read until it
 * graduates (accept/promote clear the marker); decline/merge KEEP the marker so
 * a parentless cancelled submission can never resurface as a tree root (ADR §5).
 * So "is this item part of the planned workspace?" reduces to this one
 * predicate — `triagedAt IS NULL` — with no status/`cancelled` special-casing.
 *
 * Defined ONCE here and ANDed into every normal read OUTSIDE any user-supplied
 * FilterAST (so no filter can opt back in to triage items): the tree forest +
 * lazy tree level (+ their counts), the flat List (+ count), each board column
 * + every swimlane lane aggregate, the ready set, quick search, and the report
 * aggregates. The triage-queue read (`findTriageQueue`) is the ONLY read that
 * inverts it. The `alias` is a fixed internal literal (never user input), as in
 * `buildIssueFilterSql`. The Prisma-builder reads (`findColumnCards`, the lane
 * `groupBy`s) express the same predicate as `{ triagedAt: null }`.
 */
/**
 * A lazy tree level's node predicate with its FOLDER treatment applied — one
 * function for `findProjectTreeLevel` and `countProjectTreeLevel`, so a level's
 * rows and its "Showing N of M" total can never disagree about what the level is.
 * Applied at the ROOT only (both root arms, sprint included): a work item's
 * children are never filed, because the CHECK keeps `parentId` and `folderId`
 * apart.
 */
function treeLevelPredicate(
  parentPred: Prisma.Sql,
  parentId: string | null,
  hasIds: boolean,
  folderLevel: TreeFolderLevel | undefined,
): Prisma.Sql {
  if (folderLevel === undefined || hasIds) return parentPred;
  if (folderLevel.kind === 'folder') return Prisma.sql`w."folderId" = ${folderLevel.folderId}`;
  if (parentId !== null) return parentPred;
  const band =
    folderLevel.band === 'epics'
      ? Prisma.sql` AND w."kind" = 'epic'`
      : folderLevel.band === 'others'
        ? Prisma.sql` AND w."kind" <> 'epic'`
        : Prisma.empty;
  return Prisma.sql`${parentPred} AND w."folderId" IS NULL${band}`;
}

function notInTriageSql(alias: string): Prisma.Sql {
  return Prisma.sql`${Prisma.raw(alias)}."triagedAt" IS NULL`;
}

/**
 * "Does this item have a description?" as a projected BOOLEAN (MOTIR-2098) —
 * the LEAF face of the shared Plan / Re-plan rule (`planEntranceFace` rule 2:
 * a leaf WITH a description offers Re-plan, without one Plan).
 *
 * It is the ONE description signal the list/tree reads carry, and deliberately
 * not the body: `descriptionMd` is a Markdown blob and these reads fan out over
 * every row of a project (the forest CTE re-projects each row through the
 * recursion), which is precisely why that projection excludes it. A boolean
 * costs one byte per row and answers the only question the row needs to.
 *
 * An EMPTY STRING counts as NO description — that is what an emptied editor
 * writes, and the shared rule's contract says so. NULL and `''` therefore reach
 * the same verdict. Never NULL itself: `IS NOT NULL` and `<> ''` are both
 * total, so the projected column is a real boolean the DTO can carry (the same
 * care the forest's `matched` column takes with its COALESCE).
 *
 * The `alias` is a fixed internal literal (never user input), as in
 * {@link notInTriageSql} — the forest CTE passes both of its arms' aliases.
 */
function hasDescriptionSql(alias: string): Prisma.Sql {
  const a = Prisma.raw(alias);
  return Prisma.sql`(${a}."descriptionMd" IS NOT NULL AND ${a}."descriptionMd" <> '')`;
}

/**
 * The sprint-scope predicate for the per-level roadmap read (MOTIR-1381). The
 * roadmap is a HIERARCHY shown one level at a time, but sprint membership is a
 * FLAT `work_item.sprintId` — epics/stories carry no `sprintId` (only the leaves
 * a sprint commits to do), so a naive `sprintId = ?` filter would empty the ROOT
 * level (no epic is a member) and break drill-down. Instead a node is in scope
 * iff it is ITSELF a sprint member OR an ANCESTOR of one: a recursive CTE seeds
 * on every in-sprint item (non-archived, not-in-triage, same project+workspace)
 * and walks UP the `parentId` edge, so the id set is `members ∪ all-ancestors`.
 * The level read ANDs `<alias>."id" IN (that set)`; with no `sprintId` it returns
 * `TRUE` (the whole-project read, byte-for-byte unchanged). The `alias` is a
 * fixed internal literal (`w` for the row, `ch` for the hasChildren probe),
 * never user input. The same `projectId`+`workspaceId` tenant gate (finding #26)
 * is repeated inside the CTE seed so the scope set can never cross tenants.
 */
/**
 * The TOP-IN-SPRINT-MEMBER subquery for the sprint-scoped roadmap root level
 * (MOTIR-1381, revised). The sprint-scoped roadmap is rooted at the TOPMOST
 * in-sprint items — NOT their epic/story ancestors. A node is a "root member"
 * iff it is itself a sprint member AND none of its ancestors is a sprint member:
 * so a member STORY shows as a root (and its full subtree drills normally below
 * it), while a non-member story whose SUBTASKS are members contributes only those
 * subtasks (the story/epic above them is elided). Epics are never members, so they
 * are never roots — the view never "pulls the top-level epics in".
 *
 * Computed with a recursive CTE that walks UP each member's `parentId` chain and
 * keeps only members whose chain contains no other member. The same
 * `projectId`+`workspaceId` tenant gate (finding #26) is repeated in the seed so
 * the set can never cross tenants. Used ONLY at the root level; drilling below a
 * shown root member is the normal, unscoped tree read.
 */
function topInSprintMembersSql(
  projectId: string,
  workspaceId: string,
  sprintId: string,
): Prisma.Sql {
  return Prisma.sql`(
    WITH RECURSIVE sprint_member AS (
      SELECT m."id", m."parentId"
        FROM "work_item" m
        WHERE m."projectId" = ${projectId}
          AND m."workspaceId" = ${workspaceId}
          AND m."archivedAt" IS NULL
          AND ${notInTriageSql('m')}
          AND m."sprintId" = ${sprintId}
    ),
    -- every STRICT ancestor of each member, carried back to the member it came from
    ancestor_walk AS (
      SELECT sm."id" AS member_id, sm."parentId" AS anc_id
        FROM sprint_member sm
      UNION ALL
      SELECT aw.member_id, p."parentId"
        FROM ancestor_walk aw
        JOIN "work_item" p ON p."id" = aw.anc_id
    )
    -- a member is a ROOT member iff NONE of its strict ancestors is itself a member
    SELECT sm."id"
      FROM sprint_member sm
      WHERE NOT EXISTS (
        SELECT 1 FROM ancestor_walk aw
         WHERE aw.member_id = sm."id"
           AND aw.anc_id IN (SELECT "id" FROM sprint_member)
      )
  )`;
}

/**
 * The epic-privacy exclusion predicate for the PUBLIC reads (Story 6.14 ·
 * Subtask 6.14.4) — drop the rows whose ids are in `excludeIds` (the descendants
 * of a private epic, resolved once by {@link workItemRepository.findPublicHiddenDescendantIds}).
 * An EMPTY / absent set returns `TRUE`, so a member viewer (or a project with no
 * private epic) reads byte-for-byte the prior projection — the predicate is a
 * pure no-op unless a non-member is reading a public project that actually has a
 * private epic. `<> ALL(array)` binds the id set as ONE Postgres array param
 * (never interpolated), mirroring the `= ANY(...)` convention; the `alias` is a
 * fixed internal literal, not user input.
 */
function notExcludedSql(
  alias: 'w' | 'f' | 'ch' | 'c',
  excludeIds: readonly string[] | undefined,
): Prisma.Sql {
  if (!excludeIds || excludeIds.length === 0) return Prisma.sql`TRUE`;
  return Prisma.sql`${Prisma.raw(alias)}."id" <> ALL(${excludeIds as string[]})`;
}

/**
 * The shared filter predicate for the project reads — the tree forest
 * (`findProjectForest`, alias `f`) and the flat List (`findProjectIssuesFlat`,
 * alias `w`). Each axis is a bound-param `Prisma.Sql` fragment (values are
 * never interpolated — multi-value axes bind as a single array via `= ANY(...)`;
 * the `alias` is a fixed internal literal, not user input). The assignee facet
 * OR-s `assigneeId = ANY(ids)` with an `IS NULL` test for `includeUnassigned`;
 * a blank `text` is ignored by callers before this point. No axis → `TRUE`
 * (match all).
 */
/**
 * The COMPLETE predicate of a project's flat List read: the tenant gate, the
 * pervasive row exclusions, and the caller's filter.
 *
 * ⚠️ Extracted (Story 11.2 · Subtask 11.2.3 — MOTIR-2041) so the OFFSET-paged
 * read (`findProjectIssuesFlat`) and the KEYSET-paged read
 * (`findProjectIssuesKeyset`) compile ONE predicate rather than two copies of
 * it. That is the whole basis of the ADR's Amendment 1 carve-out: the v1 read is
 * a new page ADDRESSING over an unchanged predicate, and the result SET is
 * byte-for-byte what the `/items` view returns for the same filter. Two
 * predicates for one filter is how the API and the web app start disagreeing
 * about what a filter MEANS — which is exactly what the parity criterion exists
 * to catch, and it cannot drift if there is only one of them.
 *
 * (`countProjectIssues` deliberately keeps its own WHERE: it carries an extra
 * `excludeIds` clause the row reads do not. Folding it in here would silently
 * change the List's denominator, which is not this card's to change.)
 */
function projectIssuesScopeSql(
  projectId: string,
  workspaceId: string,
  filter: RepoIssueFilter,
): Prisma.Sql {
  return Prisma.sql`w."projectId" = ${projectId}
          AND w."workspaceId" = ${workspaceId}
          AND w."archivedAt" IS NULL
          AND ${notInTriageSql('w')}
          AND ${notExcludedSql('w', filter.excludeIds)}
          AND (${buildIssueFilterSql(filter, 'w')})`;
}

function buildIssueFilterSql(filter: RepoIssueFilter, alias: 'f' | 'w'): Prisma.Sql {
  const t = Prisma.raw(alias);
  const predicates: Prisma.Sql[] = [];
  if (filter.kinds && filter.kinds.length > 0) {
    // Cast the bound text[] to the enum array so `kind::text = ANY(...)` compares text-to-text.
    const kinds = filter.kinds.map((k) => k as string);
    predicates.push(Prisma.sql`${t}."kind"::text = ANY(${kinds})`);
  }
  const types = filter.types ?? [];
  if (types.length > 0 || filter.includeUntyped) {
    // The work-type facet (the 6.15 quick filter). `type` is nullable (epics /
    // stories / legacy rows are null), so — like the assignee group — OR the
    // selected types with an `IS NULL` test for the "Untyped" bucket and
    // COALESCE the whole group to a clean boolean (an unmatched null `type`
    // yields SQL NULL through `= ANY`, which must read as FALSE for the
    // projected `matched` flag, not a null DTO field).
    const terms: Prisma.Sql[] = [];
    if (types.length > 0) {
      const typeStrs = types.map((ty) => ty as string);
      terms.push(Prisma.sql`${t}."type"::text = ANY(${typeStrs})`);
    }
    if (filter.includeUntyped) terms.push(Prisma.sql`${t}."type" IS NULL`);
    predicates.push(Prisma.sql`COALESCE((${Prisma.join(terms, ' OR ')}), FALSE)`);
  }
  if (filter.statuses && filter.statuses.length > 0) {
    predicates.push(Prisma.sql`${t}."status" = ANY(${filter.statuses})`);
  }
  if (filter.sprintId) {
    // Sprint scope (Story 4.5.2) — only the scrum-board count path sets this; it
    // scans `work_item` (alias `w`), which carries `sprintId`. (The forest read,
    // alias `f`, never sets it — see RepoIssueFilter.sprintId.)
    predicates.push(Prisma.sql`${t}."sprintId" = ${filter.sprintId}`);
  }
  const assigneeIds = filter.assigneeIds ?? [];
  if (assigneeIds.length > 0 || filter.includeUnassigned) {
    const terms: Prisma.Sql[] = [];
    // `NULL = ANY(array)` is NULL in SQL three-valued logic (assigneeId is
    // nullable), so an unassigned row would yield a NULL `matched` instead of
    // FALSE; COALESCE the whole assignee group to a clean boolean.
    if (assigneeIds.length > 0) terms.push(Prisma.sql`${t}."assigneeId" = ANY(${assigneeIds})`);
    if (filter.includeUnassigned) terms.push(Prisma.sql`${t}."assigneeId" IS NULL`);
    predicates.push(Prisma.sql`COALESCE((${Prisma.join(terms, ' OR ')}), FALSE)`);
  }
  const text = filter.text?.trim();
  if (text) {
    const pattern = `%${escapeLikePattern(text)}%`;
    predicates.push(
      Prisma.sql`(${t}."identifier" ILIKE ${pattern} OR ${t}."title" ILIKE ${pattern})`,
    );
  }
  if (filter.ast && filter.ast.conditions.length > 0) {
    // The advanced-builder axis (6.1.1). Compiled over the FULL `work_item`
    // alias `w` — callers on the fixed-projection forest alias `f` must strip
    // it and compose the fragment over a joined `w` instead (findProjectForest
    // does); reaching here with alias `f` is a programming error, not input.
    /* v8 ignore next 3 -- defensive: see above; no caller can reach it with `f`. */
    if (alias !== 'w') {
      throw new Error('RepoIssueFilter.ast requires the full work_item alias (w)');
    }
    predicates.push(
      Prisma.sql`(${compileFilterConditionsSql(filter.ast, filter.filterReferents)})`,
    );
  }
  return predicates.length ? Prisma.join(predicates, ' AND ') : Prisma.sql`TRUE`;
}

function translateWriteError(err: unknown, ctx?: { id?: string }): never {
  const message = extractMessage(err);
  const sqlState = sqlStateOf(err);

  if (sqlState === '23514' || isTriggerMarker(message)) {
    // Both tenancy markers (MOTIR-2895) land on the SAME typed error the service
    // layer already throws for this rule on all three of its paths — the DB check
    // backstops `workItemsService`'s `CrossProjectParentError`, it does not
    // introduce a second vocabulary for the same mistake. The marker itself
    // distinguishes the workspace case from the project case, and it rides along
    // in the message.
    if (
      message.includes('WI_PARENT_CROSS_WORKSPACE') ||
      message.includes('WI_PARENT_CROSS_PROJECT')
    ) {
      throw new CrossProjectParentError(message);
    }
    // A filed item's folder in another tenant (MOTIR-5312's trigger) — the same
    // typed error `workItemsService.fileWorkItem` raises for it ahead of the write.
    if (
      message.includes('WI_FOLDER_CROSS_WORKSPACE') ||
      message.includes('WI_FOLDER_CROSS_PROJECT')
    ) {
      throw new CrossProjectFolderError(message);
    }
    if (message.includes('WI_ILLEGAL_PARENT_TYPE') || message.includes('WI_SUBTASK_NEEDS_PARENT')) {
      throw new IllegalParentTypeError(message);
    }
    if (message.includes('WI_DEPTH_LIMIT_EXCEEDED')) {
      throw new DepthLimitExceededError(message);
    }
    if (message.includes('WI_PARENT_CYCLE')) {
      throw new ParentCycleError(message);
    }
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') throw new WorkItemKeyConflictError();
    /* istanbul ignore next -- defensive default: the P2025 path is only reached via update/archive, which always pass ctx.id, so the '(unknown)' fallback is unreachable */
    if (err.code === 'P2025') throw new WorkItemNotFoundError(ctx?.id ?? '(unknown)');
  }

  /* istanbul ignore next -- defensive rethrow: every work_item write error is a 23514 trigger marker or a Prisma P2002/P2025, all handled above */
  throw err;
}

function isTriggerMarker(message: string): boolean {
  return (
    message.includes('WI_PARENT_CROSS_WORKSPACE') ||
    message.includes('WI_PARENT_CROSS_PROJECT') ||
    message.includes('WI_ILLEGAL_PARENT_TYPE') ||
    message.includes('WI_SUBTASK_NEEDS_PARENT') ||
    message.includes('WI_DEPTH_LIMIT_EXCEEDED') ||
    message.includes('WI_PARENT_CYCLE') ||
    message.includes('WI_FOLDER_CROSS_WORKSPACE') ||
    message.includes('WI_FOLDER_CROSS_PROJECT')
  );
}

/** SQLSTATE from a pg driver-adapter error's `cause`, if present. */

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  /* istanbul ignore next -- defensive: work_item write errors are always Error instances; these branches guard a non-Error throw */
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  /* istanbul ignore next -- defensive: see above */
  return String(err);
}
