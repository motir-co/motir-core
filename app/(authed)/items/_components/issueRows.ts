import { personDisplayName } from '@/lib/people/personLabel';
import type { CardReviewDTO, CardReviewMap } from '@/lib/dto/reviewState';
import type { WorkItemFixReasonDto } from '@/lib/dto/fixReason';
import type {
  WorkItemKindDto,
  WorkItemListItemDto,
  WorkItemObsolescenceDto,
  WorkItemPriorityDto,
  WorkItemTreeNodeDto,
  WorkItemTypeDto,
} from '@/lib/dto/workItems';
import type { StatusCategoryDto, WorkflowStatusDto, WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { PendingDecisionDTO } from '@/lib/dto/approvalGate';
import type { TreeTableRow } from '@/components/ui/TreeTable';
import { formatDate } from '@/lib/utils/datetime';
import { formatDurationMinutes } from '@/lib/utils/duration';
import { formatStoryPoints } from '@/lib/estimation/scales';
import { defaultLocale, type Locale } from '@/lib/i18n/locales';

// Pure view-shaping for the /items list route (Subtask 2.5.3): turn the
// `getProjectTree` forest (2.5.1) into the serializable nested-row model the
// client TreeTable renders. Resolving the status (key → label + category for
// the Pill tone) and the assignee (id → display name) happens HERE, on the
// server, against the project workflow + workspace members the page already
// loads — so the client receives plain data, not the whole workflow/member
// tables, and the render-props in IssueTreeTable stay trivial. Kept Prisma-free
// and React-free so it unit-tests in isolation (the AC's "page data shaping").

/** The row payload the TreeTable cells render. Fully serializable. */
export interface IssueRowData {
  /** The work-item id — the target of the inline-edit Server Actions (2.5.5). */
  id: string;
  identifier: string;
  title: string;
  /** Drives the type-hued IssueTypeIcon. */
  kind: WorkItemKindDto;
  /** A Visitor's PRIVATE epic (MOTIR-6170 · MOTIR-6648): its row carries the
   *  "Not public" pill. Set only when the read marked it — a member never sees it. */
  childrenHidden?: boolean;
  /** The leaf's work TYPE (Story 2.7) → the Type-column `WorkItemTypeChip`
   *  (Subtask 8.8.9); `null` on containers (epic/story) → a muted em-dash. */
  type: WorkItemTypeDto | null;
  /** The raw workflow status KEY (not the label) — what the inline StatusPicker
   *  edits + `changeStatusAction` commits (2.5.5); `statusLabel` is its display. */
  status: string;
  /** Human status label (workflow label, or the raw key as a fallback). */
  statusLabel: string;
  /**
   * The status's lifecycle category → the Pill tone. `null` when the project's
   * bundled workflow can't classify the key (a defensive fallback → neutral
   * Pill showing the raw key), mirroring the detail page's ChildList.
   */
  statusCategory: StatusCategoryDto | null;
  /** The item's CI verdict over its whole delivery set (MOTIR-5470). The row draws
   *  the GLYPH form only, and only for `failing` / `running` off the `done`
   *  category — `ciBadgeState`, shared with the board card (MOTIR-5474). */
  ciState: string | null;
  /** Why the card is stuck until something is repaired (MOTIR-6600). The row draws
   *  the To fix tag's GLYPH form in the Status cell, and only off the `done`
   *  category — `toFixTagState`, shared with the board card (MOTIR-6610). */
  fixReason: WorkItemFixReasonDto | null;
  /** The head of the To fix entry this card is carried by (MOTIR-7589) — the tag's
   *  name gains *· with {head}*; null otherwise. */
  fixHeadKey?: string | null;
  /** FIXING (MOTIR-10309): a fix was pushed and its checks are running — the status cell's
   *  tag draws the Fixing state. */
  fixing?: boolean;
  /** The OBSOLESCENCE mark (MOTIR-6677) — the status cell draws its GLYPH after the
   *  status pill. Nothing hides, dims or re-sorts a marked row. */
  obsolescence: WorkItemObsolescenceDto | null;
  /** The raw assignee userId (or null) — what the inline AssigneePicker edits +
   *  `updateIssueAction` commits (2.5.5); `assigneeName` is its display. */
  assigneeId: string | null;
  /** Resolved assignee display name, or null when unassigned. */
  assigneeName: string | null;
  /** ISO-8601 last-modified stamp — the `expectedUpdatedAt` the inline assignee
   *  edit submits for optimistic concurrency (2.5.5). */
  updatedAt: string;
  /** Priority value → the shared PRIORITY_META chip; the raw value the inline
   *  PriorityPicker edits (2.5.5). */
  priority: WorkItemPriorityDto;
  /** Resolved reporter display name (a reporter is always set). */
  reporterName: string;
  /** Raw due date (ISO-8601) or null. No list/tree view renders a Due column
   *  (MOTIR-1307) and its inline editor is gone (MOTIR-10591); the row still
   *  carries the value, for a Due column restored on purpose. */
  dueDate: string | null;
  /** Pre-formatted due date ("Jun 4, 2026"), or null when none. */
  dueLabel: string | null;
  /** Raw estimate in whole minutes or null — what the inline estimate field edits (2.5.5). */
  estimateMinutes: number | null;
  /** Pre-formatted estimate ("2h 30m"), or null when unestimated. */
  estimateLabel: string | null;
  /** Raw story-point estimate or null — what the inline `EstimateBadge` edits (4.3.4). */
  storyPoints: number | null;
  /** Pre-formatted story points ("5", "0.5"), or null when unestimated. */
  storyPointsLabel: string | null;
  /**
   * Whether this row has descendants (Subtask 4.3.5) — drives the Points
   * column's epic/parent subtree roll-up badge (a parent shows the rolled-up
   * subtree total instead of its own estimate; a leaf shows its own estimate).
   * Carried by the tree DTOs; the flat List item has no hierarchy, so it
   * defaults to `false` (the roll-up is a tree-parent concept — the design's
   * `.trow` form has the expand chevron).
   */
  hasChildren: boolean;
  /**
   * Does the row's item carry a non-empty description (MOTIR-2098)? The LEAF
   * face of the shared Plan / Re-plan rule (`planEntranceFace` rule 2), which
   * the row ⋯ menu asks so a described task/bug/subtask offers **Re-plan** and
   * an undescribed one **Expand**. A boolean the reads project — the row never
   * carries the description body.
   */
  hasDescription: boolean;
  /**
   * Whether a decision is waiting on this row's item, and whether it is the
   * READER's (Story MOTIR-4908 · MOTIR-5881) — `pendingDecisionsFor`'s answer for
   * this id, `null` when none. It arrives BESIDE the row DTOs as a map
   * ({@link PendingDecisionMap}), never inside them: the list/tree DTOs are shared
   * with `/api/v1` and the AI search, where a per-reader field would be wrong.
   */
  pendingDecision: PendingDecisionDTO | null;
  /** The routed person's display name, resolved here like the assignee's; `null`
   *  when no marker, or when the member list cannot name them (the marker then
   *  reads *this work item's assignee*). */
  pendingRoutedToName: string | null;
  /**
   * The agent review's marker, Reviewed state and container count (Story MOTIR-10327 ·
   * MOTIR-10341) — `reviewStateService.cardReviewsFor`'s answer for this id, carried
   * BESIDE the DTOs as a {@link CardReviewMap} for the per-reader reason above. `null`
   * when the row wears neither.
   */
  review?: CardReviewDTO | null;
}

/** `pendingDecisionsFor`'s answer for one load, keyed by work-item id — serializable,
 *  so it crosses the Server → Client boundary and the level actions' results. */
export type PendingDecisionMap = Record<string, PendingDecisionDTO>;

/** Every work-item id in a forest, for the ONE `pendingDecisionsFor` call its load owes. */
export function collectTreeIds(nodes: WorkItemTreeNodeDto[]): string[] {
  const ids: string[] = [];
  const walk = (list: WorkItemTreeNodeDto[]) => {
    for (const node of list) {
      ids.push(node.id);
      walk(node.children);
    }
  };
  walk(nodes);
  return ids;
}

/**
 * Shape the project forest into `TreeTableRow<IssueRowData>[]`, preserving the
 * tree's nesting + sibling order. `workflow` classifies each node's status key;
 * `members` resolves each `assigneeId`/`reporterId` to a display name (name,
 * falling back to email). Due date + estimate are formatted here with the same
 * helpers the detail page uses, so the client cell just renders strings. The
 * lookup maps are built once so the walk stays O(n).
 */
/** The lookups both shapers build once: status key → status, user id → name. */
function buildLookups(workflow: WorkflowDto, members: WorkspaceMemberDTO[]) {
  return {
    statusByKey: new Map<string, WorkflowStatusDto>(workflow.statuses.map((s) => [s.key, s])),
    nameById: new Map(members.map((m) => [m.userId, personDisplayName(m)])),
  };
}

/**
 * Shape ONE item (a tree node or a flat list item — both carry the same render
 * fields) into the `IssueRowData` the cell render-props read. Resolves the
 * status (key → label + category for the Pill tone) and the assignee/reporter
 * (id → display name); formats the due date + estimate. Shared by the Tree
 * (`toIssueRows`) and List (`toIssueListRows`) so a row renders identically in
 * either view.
 */
function shapeRowData(
  // The tree DTOs (`WorkItemTreeNodeDto` / `WorkItemTreeRowDto`) carry
  // `hasChildren`; the flat List item does not — so accept it optionally and
  // default to `false` (no roll-up in the un-nested List).
  item: WorkItemListItemDto & { hasChildren?: boolean },
  statusByKey: Map<string, WorkflowStatusDto>,
  nameById: Map<string, string>,
  locale: Locale,
  pending: PendingDecisionMap = {},
  reviews: CardReviewMap = {},
): IssueRowData {
  const status = statusByKey.get(item.status);
  const pendingDecision = pending[item.id] ?? null;
  return {
    id: item.id,
    identifier: item.identifier,
    title: item.title,
    kind: item.kind,
    ...(item.childrenHidden ? { childrenHidden: true } : {}),
    type: item.type,
    status: item.status,
    statusLabel: status?.label ?? item.status,
    statusCategory: status?.category ?? null,
    ciState: item.ciState,
    fixReason: item.fixReason,
    fixHeadKey: item.fixHeadKey ?? null,
    fixing: item.fixing === true,
    obsolescence: item.obsolescence,
    assigneeId: item.assigneeId,
    assigneeName: item.assigneeId ? (nameById.get(item.assigneeId) ?? null) : null,
    updatedAt: item.updatedAt,
    priority: item.priority,
    // The reporter always exists; fall back to its id only if the member is
    // somehow missing (e.g. left the workspace) so the cell never blanks.
    reporterName: nameById.get(item.reporterId) ?? item.reporterId,
    dueDate: item.dueDate,
    dueLabel: item.dueDate ? formatDate(item.dueDate, locale) : null,
    estimateMinutes: item.estimateMinutes,
    estimateLabel:
      item.estimateMinutes != null ? formatDurationMinutes(item.estimateMinutes) : null,
    storyPoints: item.storyPoints,
    storyPointsLabel: item.storyPoints != null ? formatStoryPoints(item.storyPoints) : null,
    hasChildren: item.hasChildren ?? false,
    hasDescription: item.hasDescription,
    pendingDecision,
    pendingRoutedToName: pendingDecision?.routedToId
      ? (nameById.get(pendingDecision.routedToId) ?? null)
      : null,
    review: reviews[item.id] ?? null,
  };
}

/**
 * A reusable per-row shaper (Subtask 2.5.14) — builds the status/name lookups
 * ONCE, then maps each `WorkItemListItemDto` / `WorkItemTreeRowDto` to
 * `IssueRowData`. The lazy Tree (IssueTreeTable) needs this on the CLIENT to
 * shape children fetched on expand, so it's exported (the workflow + members
 * cross to the client once; the lazy levels arrive as raw DTOs).
 */
export function makeRowShaper(
  workflow: WorkflowDto,
  members: WorkspaceMemberDTO[],
  locale: Locale = defaultLocale,
): (
  item: WorkItemListItemDto,
  pending?: PendingDecisionMap,
  reviews?: CardReviewMap,
) => IssueRowData {
  const { statusByKey, nameById } = buildLookups(workflow, members);
  return (item, pending, reviews) =>
    shapeRowData(item, statusByKey, nameById, locale, pending, reviews);
}

export function toIssueRows(
  nodes: WorkItemTreeNodeDto[],
  workflow: WorkflowDto,
  members: WorkspaceMemberDTO[],
  locale: Locale = defaultLocale,
  pending: PendingDecisionMap = {},
  reviews: CardReviewMap = {},
): TreeTableRow<IssueRowData>[] {
  const { statusByKey, nameById } = buildLookups(workflow, members);

  const shape = (node: WorkItemTreeNodeDto): TreeTableRow<IssueRowData> => ({
    id: node.id,
    data: shapeRowData(node, statusByKey, nameById, locale, pending, reviews),
    children: node.children.map(shape),
  });

  return nodes.map(shape);
}

/**
 * The FLAT view-shaping for the List view (Subtask 2.5.8): map the already-
 * sorted `getProjectIssuesList` items into a flat `IssueRowData[]`, preserving
 * the read's order (the DB did the sort — no JS re-sorting). Same per-row
 * resolution as the tree, just un-nested.
 */
export function toIssueListRows(
  items: WorkItemListItemDto[],
  workflow: WorkflowDto,
  members: WorkspaceMemberDTO[],
  locale: Locale = defaultLocale,
  pending: PendingDecisionMap = {},
  reviews: CardReviewMap = {},
): IssueRowData[] {
  const { statusByKey, nameById } = buildLookups(workflow, members);
  return items.map((item) => shapeRowData(item, statusByKey, nameById, locale, pending, reviews));
}
