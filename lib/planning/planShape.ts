import type { PlanReviewItemDto } from '@/lib/dto/planReview';
import { isMarkChangeField } from '@/lib/dto/planReview';
import { folderIdFromNodeId, folderNodeId } from '@/lib/planning/projectCanvasModel';

// THE SHAPE OF A PLAN — how its proposals are spread across containers
// (MOTIR-3260, `design/ai-planning/design-notes.md` Part IX).
//
// A plan is not a tree; it is a SCATTER of proposals across somebody else's tree.
// Two surfaces need to reason about that scatter and neither should re-derive it:
// the canvas needs the level the plan most FILLS (so it opens there), and the
// plan detail needs to know whether the plan STRADDLES containers (so it can
// choose which body to open in — MOTIR-3262).
//
// PURE by construction: no React, no fetch, no clock. It takes `PlanReviewItemDto[]`
// — the model the island already holds — and answers questions about it, so both
// consumers can be unit-tested against plain fixtures.

/** One container the plan proposes into, and how much of the plan sits there. */
export interface PlanContainer {
  /**
   * The container's canvas node id, or `null` for the TOP LEVEL — a proposal with
   * no parent at all.
   *
   * ⚠️ It may name a COMMITTED work item OR another PROPOSAL. That is the whole
   * point of counting `parentNodeId` rather than `parentIdentifier`: an intra-plan
   * (`planItem:`) parent has a node id and deliberately has no identifier, because
   * the canvas draws it and the breadcrumb does not (`lib/dto/planReview.ts`).
   *
   * Counted with `{ folders: true }` it may also be a FOLDER's level,
   * `folder:<id>` (Bug MOTIR-5782) — see {@link proposalLevelKey}.
   */
  parentNodeId: string | null;
  /** How many of the plan's proposals sit directly under it. */
  count: number;
  /** How deep it sits — the length of the committed ancestor chain plus one crumb
   *  per PROPOSED container above it. The tie-break reads this. */
  depth: number;
}

/** Every container the plan touches, most-filled first, deeper first on a tie. */
export function planContainers(
  items: PlanReviewItemDto[],
  opts: PlanShapeOptions = {},
): PlanContainer[] {
  const keyOf = opts.folders
    ? proposalLevelKey
    : (item: PlanReviewItemDto) => item.parentNodeId ?? null;
  const byNode = new Map<string | null, { count: number; first: number }>();
  items.forEach((item, index) => {
    const key = keyOf(item);
    const entry = byNode.get(key);
    if (entry) entry.count += 1;
    else byNode.set(key, { count: 1, first: index });
  });

  const containers = [...byNode].map(([parentNodeId, { count, first }]) => ({
    parentNodeId,
    count,
    depth: containerDepth(items, parentNodeId, opts.folders === true),
    first,
  }));

  containers.sort(
    (a, b) =>
      b.count - a.count ||
      b.depth - a.depth ||
      // The folder-aware rule's exact tie goes to the level holding the plan's
      // FIRST proposal in list order (design Part XVIII §18.2) — the order the
      // rail and the list already use. The legacy count keeps its id order.
      (opts.folders
        ? a.first - b.first
        : String(a.parentNodeId).localeCompare(String(b.parentNodeId))),
  );
  return containers.map(({ parentNodeId, count, depth }) => ({ parentNodeId, count, depth }));
}

/**
 * Whether a FOLDER is a level (Bug MOTIR-5782; design Part XVIII §18.2). The plan
 * review's canvas draws folders, so a folder-filed proposal sits on its folder's
 * level and the arrival rule counts it there, with folder crumbs counted in the
 * depth tie-break. Off, the count is the shipped one — by `parentNodeId` — which
 * the review read's arrival-size and the derived default view still read.
 */
export interface PlanShapeOptions {
  folders?: boolean;
}

/**
 * The canvas LEVEL a proposal sits on once folders are levels (Part XVIII decision
 * 2): its parent when it has one; else its folder's level (`folder:<id>`) when it is
 * filed into a folder that still exists; else the project root. A proposal whose
 * folder was deleted stays at the root (decision 6).
 */
export function proposalLevelKey(
  item: Pick<PlanReviewItemDto, 'parentNodeId' | 'folderId' | 'folderMissing'>,
): string | null {
  if (item.parentNodeId != null) return item.parentNodeId;
  return item.folderId != null && !item.folderMissing ? folderNodeId(item.folderId) : null;
}

/** How many folder crumbs stand above a proposal's committed chain. `?? []`: a
 *  payload older than MOTIR-5798 carries no trail and reads as "no folder". */
function folderCrumbCount(item: PlanReviewItemDto): number {
  return item.folderMissing ? 0 : (item.folderTrail ?? []).length;
}

function containerDepth(
  items: PlanReviewItemDto[],
  parentNodeId: string | null,
  folders: boolean,
): number {
  if (parentNodeId === null) return 0;
  // A FOLDER level is as deep as its crumbs — the folder chain down to it.
  if (folders && folderIdFromNodeId(parentNodeId) !== null) {
    const namer = items.find((item) => proposalLevelKey(item) === parentNodeId);
    return namer ? folderCrumbCount(namer) : 1;
  }
  const byNodeId = new Map(items.map((item) => [item.nodeId, item]));

  let depth = 0;
  let cursor: string | null = parentNodeId;
  const seen = new Set<string>();
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    depth += 1;
    const proposal: PlanReviewItemDto | undefined = byNodeId.get(cursor);
    if (!proposal) {
      const namer = items.find((item) => item.parentNodeId === cursor);
      return (
        depth +
        (namer ? Math.max(namer.parentTrail.length - 1, 0) : 0) +
        (folders && namer ? folderCrumbCount(namer) : 0)
      );
    }
    cursor = proposal.parentNodeId;
    if (cursor === null)
      return (
        depth +
        Math.max(proposal.parentTrail.length, 0) +
        (folders ? folderCrumbCount(proposal) : 0)
      );
  }
  return depth;
}

export function planContainerCount(items: PlanReviewItemDto[]): number {
  return planContainers(items).length;
}

/**
 * Is this proposal a MARK-ONLY `modify` (Bug MOTIR-12097) — one whose every
 * changed field is in the {@link PLAN_ITEM_MARK_CHANGE_FIELDS} group, so it only
 * records that a card's standing changed (outdated, deprecated, superseded) and
 * moves nothing about the card itself?
 *
 * Read off `proposal.changedFields`, the key set `buildChanges` emits, through the
 * same field predicate the canvas's lock rule uses (`isLockedProposal`), so the two
 * cannot disagree about which `modify` is a mark. An EMPTY change set is not
 * mark-only — it marks nothing — which is `isMarkOnlyPatch`'s rule on the patch.
 */
export function isMarkOnlyProposal(item: Pick<PlanReviewItemDto, 'op' | 'proposal'>): boolean {
  if (item.op !== 'modify') return false;
  const fields = item.proposal.changedFields;
  return fields.length > 0 && fields.every((field) => isMarkChangeField(field));
}

/**
 * The container the plan most FILLS — where the canvas should open — or `null`
 * for a plan with no proposals, or one that lives entirely at the top level.
 *
 * ⚠️ ONLY A CONTAINER WHERE THE PLAN DOES WORK CAN WIN (Bug MOTIR-12097). A plan
 * that replaces old work typically marks several FINISHED cards outdated and adds
 * a few new ones elsewhere; counted alike, the marks out-number the adds and the
 * canvas opened on a finished story whose cards are not changing, with the new
 * cards one hidden level away. So the candidates are the containers holding at
 * least one `add`, `remove` or non-mark `modify`. Within those the ranking is
 * {@link planContainers}' own, over EVERY item — a mark-only proposal beside an
 * add still counts toward its container. Only a plan made of nothing but marks
 * falls back to every container, because the marks are then its whole content.
 *
 * `planContainers` and {@link planContainerCount} are untouched: the rail, the
 * list and the straddle question still see every item.
 */
export function fullestContainer(
  items: PlanReviewItemDto[],
  opts: PlanShapeOptions = {},
): PlanContainer | null {
  const keyOf = opts.folders ? proposalLevelKey : (item: PlanReviewItemDto) => item.parentNodeId;
  const workLevels = new Set(items.filter((item) => !isMarkOnlyProposal(item)).map(keyOf));
  const containers = planContainers(items, opts);
  const [first] =
    workLevels.size > 0
      ? containers.filter((container) => workLevels.has(container.parentNodeId))
      : containers;
  if (!first || first.parentNodeId === null) return null;
  return first;
}

/**
 * WHICH NODES THIS PLAN PUTS A CHILD UNDER — the canvas node ids that appear as
 * some proposal's parent (bug MOTIR-4266).
 *
 * The one predicate behind *"a childless card the plan proposes work under MUST
 * be drillable, or the proposal is unreachable"*, which is the commonest shape
 * an expansion produces. It had been written out TWICE — `indexPlanReview` (for
 * a proposed add's own `hasChildren`) and the plan-change canvas's own level
 * builder (deleted by MOTIR-6299) — and NOT AT ALL on the plan-review canvas,
 * which is the surface a reviewer actually approves from. Two copies and one
 * omission is what a shared predicate is for.
 *
 * STRUCTURALLY typed on purpose: the call sites hold two different item
 * shapes (`PlanReviewItemDto` and `ProposedAdd`) and both answer the same
 * question off the same field. `null` is the TOP level and never a node id, so
 * it is dropped rather than represented.
 */
export function proposedParentNodeIds(
  items: ReadonlyArray<{ parentNodeId: string | null }>,
): Set<string> {
  return new Set(items.map((item) => item.parentNodeId).filter((id): id is string => id !== null));
}
