import type { User, WorkItem } from '@/generated/prisma/client';
import type {
  ArchivedWorkItemRow,
  WorkItemForestRow,
  WorkItemListRow,
  WorkItemSubtreeRow,
  WorkItemTreeRow,
} from '@/lib/repositories/workItemRepository';
import type { WorkItemRepoWithRow } from '@/lib/repositories/workItemRepoRepository';
import type {
  ArchivedWorkItemDto,
  RoadmapNodeDto,
  RoadmapProgressDto,
  WorkItemDto,
  WorkItemListItemDto,
  WorkItemSummaryDto,
  WorkItemMentionCandidateDto,
  WorkItemRefAssigneeDto,
  WorkItemRefSummaryDto,
  WorkItemRefStatusDto,
  WorkItemSubtreeDto,
  WorkItemTreeNodeDto,
  WorkItemTreeRowDto,
  WorkItemRepositoryDto,
} from '@/lib/dto/workItems';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import { storedAssetUrl } from '@/lib/blob/referencedUrls';
import { personName } from '@/lib/people/personLabel';
import { readRecordedLanguage } from '@/lib/workItems/contentLanguage';

// Prisma → DTO converters for the work-item domain. The service calls these
// just before returning so no Prisma row shape (Date objects, Decimal
// instances, Prisma enums) leaks across the API boundary. Mirrors the shape
// of lib/mappers/projectMappers.ts.

/**
 * Full detail-view DTO. The nullable dates are normalized to wire-safe ISO
 * strings here; `position` is already a fractional-index string on the row.
 */
/**
 * The resolved REPOSITORIES of a work item (Story MOTIR-2732 · MOTIR-3041) — the
 * `work_item_repository` rows joined to what they point at.
 *
 * The NAME follows ADR §A4's rule: the REALIZED repository's own once the row is
 * realized, else the row's authored intent. Stated per row rather than borrowed
 * from `toProjectRepoNames`, for the reason `roleResolution.ts` gives for the same
 * choice — that helper de-duplicates by name, which would collapse two rows whose
 * realized repositories happen to share a bare name, and telling those apart is
 * what a reference is for.
 */
export function toWorkItemRepositoryDtos(
  rows: readonly WorkItemRepoWithRow[],
): WorkItemRepositoryDto[] {
  return rows.map((r, i) => ({
    ref: r.projectRepoId,
    name: r.projectRepo.githubRepo?.name ?? r.projectRepo.name,
    role: r.projectRepo.role,
    label: r.projectRepo.label,
    state: r.projectRepo.state,
    primary: i === 0,
  }));
}

/**
 * `repositories` is OPTIONAL and ABSENT means "not loaded", never "none" — a bare
 * row cannot be joined from here, so a read that needs the references passes them
 * in and one that does not pays no join (see `WorkItemDto.targetRepositories`).
 */
export function toWorkItemDto(
  row: WorkItem,
  repositories?: readonly WorkItemRepoWithRow[],
): WorkItemDto {
  return {
    ...(repositories === undefined
      ? {}
      : { targetRepositories: toWorkItemRepositoryDtos(repositories) }),
    id: row.id,
    projectId: row.projectId,
    parentId: row.parentId,
    kind: row.kind,
    key: row.key,
    identifier: row.identifier,
    title: row.title,
    descriptionMd: row.descriptionMd,
    explanationMd: row.explanationMd,
    explanationSource: row.explanationSource,
    // The recorded languages (Story MOTIR-7731 · MOTIR-8096) — NULL stays null;
    // a defaulted `en` would be indistinguishable from a real one.
    languages: {
      title: readRecordedLanguage(row.titleLanguage),
      description: readRecordedLanguage(row.descriptionLanguage),
      explanation: readRecordedLanguage(row.explanationLanguage),
    },
    status: row.status,
    priority: row.priority,
    assigneeId: row.assigneeId,
    reporterId: row.reporterId,
    dueDate: row.dueDate ? row.dueDate.toISOString() : null,
    estimateMinutes: row.estimateMinutes,
    // Work-item type + executor (Story 2.7) — nullable enums; pass straight
    // through (Prisma enums are plain string unions on the row).
    type: row.type,
    executor: row.executor,
    // How hard the work is to reason about (Story MOTIR-6016) — a nullable
    // enum, passed straight through like `type` / `executor`.
    difficulty: row.difficulty,
    // The `Decimal(6, 2)` story-point estimate (Story 4.3) → a wire-safe number
    // (or null when unestimated); Decimals don't survive JSON otherwise.
    storyPoints: row.storyPoints === null ? null : Number(row.storyPoints),
    position: row.position,
    sprintId: row.sprintId,
    backlogRank: row.backlogRank,
    // Epic-level privacy flag (Story 6.14). Pass the raw boolean through on the
    // INTERNAL DTO; the public PROJECTION (6.14.4) is where it gets stripped /
    // turned into the "children-hidden" marker for a non-member viewer.
    publicChildrenHidden: row.publicChildrenHidden,
    // The integration branch (Story 7.8 · Subtask 7.8.11) — non-null while the
    // item is integrated-awaiting-review; null once it reaches done. Pass through.
    sessionBranch: row.sessionBranch,
    // The repo pin (Story 7.9 · MOTIR-1804) — the EXPLICIT attribution, passed
    // through verbatim. No default is applied on the detail DTO: "pinned to the
    // only connected repo" and "not pinned" are different states here, and only
    // the DISPATCH mapper collapses them (a dispatching agent needs an answer).
    targetRepo: row.targetRepo,
    // The repository SET (Story MOTIR-2725 · MOTIR-2728) — the whole ordered list,
    // passed through beside the scalar it derives. Same reasoning as the pin: no
    // default and no collapsing here, because the empty set and a one-element set
    // are different states on a detail surface.
    targetRepos: row.targetRepos,
    // Work-item provenance (Story MOTIR-1685) — the planning + implementation
    // triples; nullable enums + free-text. A null triple is the "unknown / —"
    // state the detail (MOTIR-1693) renders.
    //
    // NATIVE model is RECORDED-but-NOT-EXPOSED (Yue, 2026-07-10): for
    // `planningSource = native` the underlying LLM is stored on the row (for
    // internal analysis) but STRIPPED here so it never reaches the frontend/API —
    // Motir abstracts its own model; a native item reads "Native · Motir", never
    // the specific model. MCP/BYOK expose their model (the user reported their
    // OWN). This is the single detail-read choke-point, so the strip is total.
    planningSource: row.planningSource,
    planningHarness: row.planningHarness,
    planningModel: row.planningSource === 'native' ? null : row.planningModel,
    implementationSource: row.implementationSource,
    implementationHarness: row.implementationHarness,
    implementationModel: row.implementationModel,
    // The SUBJECT coordinate (Story MOTIR-5062 · MOTIR-5074) — passed through
    // VERBATIM, with no strip and no normalisation. Note it does NOT inherit the
    // native-model strip directly above: that exists because Motir abstracts its
    // own model, whereas the subject names a rule pack in the open corpus and is
    // the same fact whoever planned the card. There is nothing here to hide and
    // nothing to collapse — an unrecognised member reaches the rail intact,
    // because the rail is where a person would first notice one.
    subject: row.subject,
    // The OBSOLESCENCE mark + note (Story MOTIR-6574 · MOTIR-6579) — a nullable
    // enum and a nullable Markdown column, passed straight through.
    obsolescence: row.obsolescence,
    obsolescenceNoteMd: row.obsolescenceNoteMd,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Lighter list/tree-row DTO — omits the two Markdown `@db.Text` content
 * fields so list queries don't ship them per row.
 */
export function toWorkItemSummaryDto(row: WorkItem): WorkItemSummaryDto {
  return {
    id: row.id,
    parentId: row.parentId,
    kind: row.kind,
    key: row.key,
    identifier: row.identifier,
    title: row.title,
    status: row.status,
    priority: row.priority,
    assigneeId: row.assigneeId,
    position: row.position,
    estimateMinutes: row.estimateMinutes,
    storyPoints: row.storyPoints === null ? null : Number(row.storyPoints),
    // A marked child reads as marked from its parent (MOTIR-6579).
    obsolescence: row.obsolescence,
    obsolescenceNoteMd: row.obsolescenceNoteMd,
    subject: row.subject,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
  };
}

/**
 * Accessible reference-summary DTO (Subtask 5.8.6) — the LIVE internal-link
 * chip's payload for a target the caller may browse: the CURRENT identifier ·
 * title · kind · archived flag, plus the resolved status meta (label + category
 * for the dot) the service looks up against the target's project workflow.
 * Inaccessible / deleted targets are NOT built here — the service emits the
 * `{ accessible: false }` / absent forms directly (no title/status leak).
 */
export function toWorkItemRefSummaryDto(
  row: WorkItem,
  status: WorkItemRefStatusDto | null,
  assignee: WorkItemRefAssigneeDto | null,
): WorkItemRefSummaryDto {
  return {
    accessible: true,
    id: row.id,
    identifier: row.identifier,
    title: row.title,
    kind: row.kind,
    archived: row.archivedAt != null,
    status,
    type: row.type,
    assignee,
  };
}

/** A member row as a reference summary's assignee — the avatar as `toArchivedWorkItemDto` maps it. */
export function toWorkItemRefAssigneeDto(
  user: Pick<User, 'id' | 'name' | 'image'>,
): WorkItemRefAssigneeDto {
  return { id: user.id, name: user.name, image: storedAssetUrl(user.image) };
}

/**
 * The same assignee for a VISITOR: an id and a display name, never an avatar —
 * `image: null` here means WITHHELD (`personLabel.ts`, MOTIR-6646).
 */
export function toVisitorRefAssigneeDto(user: Pick<User, 'id' | 'name'>): WorkItemRefAssigneeDto {
  return { id: user.id, name: personName(user.name), image: null };
}

/** One search row plus its resolved assignee, as the picker's candidate (see {@link WorkItemMentionCandidateDto}). */
export function toWorkItemMentionCandidateDto(
  row: WorkItem,
  assignee: WorkItemRefAssigneeDto | null,
): WorkItemMentionCandidateDto {
  return {
    id: row.id,
    identifier: row.identifier,
    title: row.title,
    kind: row.kind,
    status: row.status,
    type: row.type,
    assignee,
  };
}

/**
 * Subtree-row DTO (Subtask 1.4.4). Maps the recursive-CTE projection
 * (WorkItemSubtreeRow — already plain scalars: `kind` cast to text,
 * `position` a text column, `depth` an int) straight through. No date
 * normalization needed; the projection carries no Date columns. Kept
 * separate from toWorkItemSummaryDto because the source row is the tree-walk
 * shape, not a full WorkItem.
 */
export function toWorkItemSubtreeDto(row: WorkItemSubtreeRow): WorkItemSubtreeDto {
  return {
    id: row.id,
    parentId: row.parentId,
    kind: row.kind,
    key: row.key,
    identifier: row.identifier,
    title: row.title,
    status: row.status,
    position: row.position,
    obsolescence: row.obsolescence,
    subject: row.subject,
    depth: row.depth,
  };
}

/**
 * Tree-node DTO (Subtask 2.5.1). Maps one `findProjectForest` projection row
 * (already plain scalars — `kind` cast to text, `matched`/`assigneeId` direct
 * columns) plus its ALREADY-BUILT `children` array into a `WorkItemTreeNodeDto`.
 * The nesting / sibling-ordering / ancestor-retention pruning are the service's
 * tree work (workItemsService.getProjectTree); this mapper just shapes a single
 * node and keeps `hasChildren` consistent with the children it was handed.
 * `dueDate` is the projection's one Date column — normalized to a wire-safe
 * ISO string here (matching `toWorkItemDto`).
 */
export function toWorkItemTreeNodeDto(
  row: WorkItemForestRow,
  children: WorkItemTreeNodeDto[],
): WorkItemTreeNodeDto {
  return {
    id: row.id,
    parentId: row.parentId,
    kind: row.kind,
    type: row.type,
    key: row.key,
    identifier: row.identifier,
    title: row.title,
    status: row.status,
    ciState: row.ciState,
    fixReason: row.fixReason,
    priority: row.priority,
    assigneeId: row.assigneeId,
    reporterId: row.reporterId,
    dueDate: row.dueDate ? row.dueDate.toISOString() : null,
    estimateMinutes: row.estimateMinutes,
    storyPoints: row.storyPoints === null ? null : Number(row.storyPoints),
    updatedAt: row.updatedAt.toISOString(),
    hasDescription: row.hasDescription,
    obsolescence: row.obsolescence,
    obsolescenceNoteMd: row.obsolescenceNoteMd,
    depth: row.depth,
    hasChildren: children.length > 0,
    matched: row.matched,
    children,
  };
}

/**
 * Roadmap LEVEL-node DTO (Subtask 7.20.4 re-plan, MOTIR-1010). Maps one
 * `findProjectTreeLevel` row — already carrying the lazy `hasChildren` drill flag —
 * into a flat {@link RoadmapNodeDto}. `isDone` (the node's own done-ness) and
 * `progress` (the subtree done/total roll-up, Subtask 7.20.6 / MOTIR-1013) are the
 * service's call — it holds the project's done-status keys and runs the one extra
 * recursive count over the level's CONTAINERS. `progress` is `null` on a leaf
 * (`!hasChildren`); the service passes it through here. `inActiveSprint` is the
 * service's call too — it holds the resolved active sprint and compares each
 * row's `sprintId` to it (always `false` in project scope, where no sprint is
 * resolved).
 */
export function toRoadmapNodeDto(
  row: WorkItemTreeRow,
  isDone: boolean,
  progress: RoadmapProgressDto | null,
  ready: boolean,
  inActiveSprint: boolean,
  status: Pick<WorkflowStatusDto, 'label' | 'category'> | null,
): RoadmapNodeDto {
  return {
    id: row.id,
    parentId: row.parentId,
    kind: row.kind,
    type: row.type,
    executor: row.executor,
    key: row.key,
    identifier: row.identifier,
    title: row.title,
    status: row.status,
    // The status's OWN identity (bug MOTIR-3170), resolved from the project's
    // workflow by the service — the same list it already loads to compute
    // `isDone` / `ready`. A row whose status the workflow no longer holds
    // degrades to the raw key + no category, which the canvas draws as the
    // neutral chip rather than as To Do.
    statusLabel: status?.label ?? row.status,
    statusCategory: status?.category ?? null,
    isDone,
    hasChildren: row.hasChildren,
    progress,
    ready,
    inActiveSprint,
    fixReason: row.fixReason,
  };
}

/**
 * Flat List-item DTO (Subtask 2.5.8). Maps one `findProjectIssuesFlat`
 * projection row (already plain scalars — `kind`/`priority` cast to text) into
 * a `WorkItemListItemDto`. The List is un-nested + pre-sorted by the read, so
 * there is no tree metadata to carry. `dueDate` is normalized to a wire-safe
 * ISO string here (matching the tree-node mapper).
 */
export function toWorkItemListItemDto(row: WorkItemListRow): WorkItemListItemDto {
  return {
    id: row.id,
    kind: row.kind,
    type: row.type,
    key: row.key,
    identifier: row.identifier,
    title: row.title,
    status: row.status,
    ciState: row.ciState,
    fixReason: row.fixReason,
    priority: row.priority,
    assigneeId: row.assigneeId,
    reporterId: row.reporterId,
    dueDate: row.dueDate ? row.dueDate.toISOString() : null,
    estimateMinutes: row.estimateMinutes,
    storyPoints: row.storyPoints === null ? null : Number(row.storyPoints),
    updatedAt: row.updatedAt.toISOString(),
    hasDescription: row.hasDescription,
    // The OBSOLESCENCE mark + note (MOTIR-6579), projected by every list read.
    obsolescence: row.obsolescence,
    obsolescenceNoteMd: row.obsolescenceNoteMd,
  };
}

/**
 * A lazy tree-level row (Subtask 2.5.13) → DTO: the flat-list shape plus the
 * tree-placement fields (`parentId`, `hasChildren`).
 */
export function toWorkItemTreeRowDto(row: WorkItemTreeRow): WorkItemTreeRowDto {
  return {
    ...toWorkItemListItemDto(row),
    parentId: row.parentId,
    hasChildren: row.hasChildren,
  };
}

/**
 * An archived-list row (Subtask 2.9.2) → DTO: the flat-list shape plus the
 * archive metadata — the `archivedAt` stamp (ISO-normalized) and the resolved
 * `archivedBy` actor. The actor is `null` when the read found no `'archived'`
 * revision author (the row keeps its archived `id`, the view shows a "former
 * member" fallback).
 */
export function toArchivedWorkItemDto(row: ArchivedWorkItemRow): ArchivedWorkItemDto {
  return {
    ...toWorkItemListItemDto(row),
    archivedAt: row.archivedAt.toISOString(),
    archivedBy: row.archivedById
      ? {
          id: row.archivedById,
          name: row.archivedByName,
          image: storedAssetUrl(row.archivedByImage),
        }
      : null,
  };
}
