import type {
  WorkItemKindDto,
  WorkItemListItemDto,
  WorkItemObsolescenceDto,
  WorkItemSummaryDto,
} from '@/lib/dto/workItems';
import type { FolderPickerNodeDto } from '@/lib/dto/folders';
import type {
  AiDecisionBlock,
  PlanTreeFolder,
  PlanTreeSkeletonItem,
  BlockingEdge,
  OrgContextResponse,
  PendingPlanRow,
  SearchResultRow,
  SimilarWorkItemRow,
} from '@/lib/dto/ai';
import type { PlanDto } from '@/lib/dto/plans';
import type { WorkItemEmbeddingRankRow } from '@/lib/repositories/workItemEmbeddingRepository';
import type { OrgFootprintDTO } from '@/lib/dto/organizations';
import type { WorkItemDeliveryWithChecks } from '@/lib/repositories/workItemDeliveryRepository';
import type { InFlightDeliveryFact } from '@/lib/services/inFlightCode';
import { toLinkedPullRequestDto } from '@/lib/mappers/githubMappers';

// The structural minimum every skeleton projection needs — the fields shared by
// WorkItemSummaryDto (the flat breadth read), WorkItemSubtreeDto (the depth-
// bounded subtree walk), and the blocking-closure nodes. Keeping the mapper keyed
// to this shape lets the whole 7.5 read family reuse ONE projection.
export interface SkeletonSourceRow {
  id: string;
  parentId: string | null;
  kind: WorkItemKindDto;
  identifier: string;
  title: string;
  status: string;
  // The OBSOLESCENCE mark (MOTIR-6582) — REQUIRED on every source, so a read
  // whose projection forgot the column fails to compile rather than reporting
  // every marked card as current (the subtree CTE is a raw SELECT).
  obsolescence: WorkItemObsolescenceDto | null;
}

// Map a set of work-item rows to the plan-tree skeleton (contract §6).
// `parentKey` is resolved from `parentId` via an in-batch id→identifier map — a
// parent outside the batch (a subtree root's own parent, an unrelated blocker's
// container) resolves to null rather than a dangling id. `revisionByItemId` is
// the batched latest-revision lookup the service computed once for the whole read
// (MOTIR-1531); a row with no revision entry projects `revision: null`.
// `folderIdByItemId` is the batched FILED-placement lookup (MOTIR-5410) — only a
// filed item has an entry, so every other row projects `folderId: null`. It is a
// required argument on purpose: a read that forgot it would report every filed
// item as an ordinary root, which is exactly the defect it exists to remove.
export function toSkeletonRows(
  rows: SkeletonSourceRow[],
  revisionByItemId: Map<string, string>,
  folderIdByItemId: Map<string, string>,
  // A decision's deciding gate (MOTIR-5958, MOTIR-10146) — only such an item has an entry,
  // so every other row projects `decision: null`. Required for the same reason
  // `folderIdByItemId` is: a read that forgot it would report every decision undated.
  decisionByItemId: Map<string, AiDecisionBlock>,
): PlanTreeSkeletonItem[] {
  const idToKey = new Map(rows.map((r) => [r.id, r.identifier]));
  return rows.map((r) => ({
    key: r.identifier,
    id: r.id,
    kind: r.kind,
    title: r.title,
    status: r.status,
    parentKey: r.parentId ? (idToKey.get(r.parentId) ?? null) : null,
    revision: revisionByItemId.get(r.id) ?? null,
    folderId: folderIdByItemId.get(r.id) ?? null,
    decision: decisionByItemId.get(r.id) ?? null,
    obsolescence: r.obsolescence,
  }));
}

// Map the flat work-item summaries (the breadth read) to the plan-tree skeleton.
// The whole-project read returns every parent, so `parentKey` always resolves.
export function toPlanTreeSkeleton(
  items: WorkItemSummaryDto[],
  revisionByItemId: Map<string, string>,
  folderIdByItemId: Map<string, string>,
  decisionByItemId: Map<string, AiDecisionBlock>,
): PlanTreeSkeletonItem[] {
  return toSkeletonRows(items, revisionByItemId, folderIdByItemId, decisionByItemId);
}

// Map the project's folder picker nodes to the tree read's folder list
// (MOTIR-5410). FIELD-BY-FIELD, not a spread, for the reason
// `toSimilarWorkItemRows` gives: the picker DTO carries a `position` the planner
// has no use for, and a spread would carry whatever the picker grows next across
// the open-core boundary unannounced.
export function toPlanTreeFolders(nodes: FolderPickerNodeDto[]): PlanTreeFolder[] {
  return nodes.map((n) => ({
    id: n.id,
    parentFolderId: n.parentFolderId,
    name: n.name,
    path: n.path,
  }));
}

// Map the transitive is_blocked_by closure's edges (item ids) to identifier
// keys via the id→key map the caller built from the root + closure nodes. An
// id absent from the map falls back to the raw id (never happens for a
// well-formed closure — every edge endpoint is the root or a returned node).
export function toBlockingEdges(
  edges: Array<{ blockedId: string; blockerId: string }>,
  idToKey: Map<string, string>,
): BlockingEdge[] {
  return edges.map((e) => ({
    blockedKey: idToKey.get(e.blockedId) ?? e.blockedId,
    blockerKey: idToKey.get(e.blockerId) ?? e.blockerId,
  }));
}

// Map the shipped List rows (the `/items` breadth read `getProjectIssuesList`
// returns, Subtask 7.5.2) to the flat search projection. `WorkItemListItemDto`
// carries no `parentId`, so — unlike `toSkeletonRows` — there is no parent to
// resolve; a filtered hit-set is a flat page, not a neighbourhood. The `type` +
// `priority` the List row already surfaces pass through so the planner can rank
// hits before spending a DEPTH read. `id` + `revision` (the latter from the
// service's one batched lookup, MOTIR-1531) carry the modify/remove anchor so a
// hit can be reconciled without a follow-up `get-item`.
export function toSearchResultRows(
  items: WorkItemListItemDto[],
  revisionByItemId: Map<string, string>,
): SearchResultRow[] {
  return items.map((i) => ({
    key: i.identifier,
    id: i.id,
    kind: i.kind,
    type: i.type,
    title: i.title,
    status: i.status,
    priority: i.priority,
    revision: revisionByItemId.get(i.id) ?? null,
    obsolescence: i.obsolescence,
  }));
}

// Map the ranked embedding rows to the semantic candidate projection (ADR §6.1,
// Subtask MOTIR-2697), converting cosine DISTANCE to cosine SIMILARITY.
//
// ⚠️ THIS FUNCTION IS THE KEYS-NOT-PROSE INVARIANT'S ENFORCEMENT POINT (ADR §2),
// which is why it names all three fields explicitly instead of spreading the row.
// A spread would make the wire shape a function of whatever the ranking query
// happens to SELECT, so the day someone adds a column to that query for a
// perfectly good internal reason, body text starts crossing the boundary silently
// and no test that was written against today's row would notice. Constructing the
// object field-by-field means a new field on {@link WorkItemEmbeddingRankRow} is
// inert here until someone deliberately adds it — and adding it is a change to
// the ADR.
//
// Two units, ONE conversion, in one named place: the repository ranks by `<=>`
// (distance, lower = closer, mirroring `motir-ai`'s `lessonRepository`); the wire
// carries similarity (higher = closer), because a caller filtering on a
// `minScore` should not have to remember which way the number runs.
export function toSimilarWorkItemRows(rows: WorkItemEmbeddingRankRow[]): SimilarWorkItemRow[] {
  return rows.map((r) => ({
    key: r.identifier,
    title: r.title,
    score: 1 - r.distance,
  }));
}

// Map the org-domain footprint summary to the AI boundary's wire shape (contract
// §6, Subtask 7.3.45). Only the org id + name cross — the boundary doesn't expose
// the slug; the counts + the capped name sample pass through unchanged.
export function toOrgContextResponse(footprint: OrgFootprintDTO): OrgContextResponse {
  return {
    organization: { id: footprint.organization.id, name: footprint.organization.name },
    workspaceCount: footprint.workspaceCount,
    projectCount: footprint.projectCount,
    projectNames: footprint.projectNames,
    memberCount: footprint.memberCount,
  };
}

// Map the plan list rows to the AI boundary's PENDING-PLAN projection
// (MOTIR-4106).
//
// ⚠️ FIELD-BY-FIELD, NOT A SPREAD, for the same reason `toSimilarWorkItemRows`
// is: this is where the payload bound is ENFORCED. `PlanDto` carries a `summary`
// (free prose a user wrote), a `sourceJobId`, the author triple and two
// decider ids — none of which a planner needs to know that a plan is in flight,
// and all of which would start crossing the open-core boundary the day somebody
// adds a field to `PlanDto` for a perfectly good reason on the Plans page. A
// constructed object means a new field is inert here until somebody adds it
// deliberately.
export function toPendingPlanRows(plans: PlanDto[]): PendingPlanRow[] {
  return plans.map((p) => ({
    id: p.id,
    title: p.title,
    status: p.status,
    itemCount: p.itemCount,
    createdAt: p.createdAt,
  }));
}

// A delivery row → the fact the in-flight derivation reads (MOTIR-6618). The
// pull-request half goes through `toLinkedPullRequestDto` UNCHANGED, so `repo`
// (`owner/name`), the link-out URL and the head commit are literally the values
// the Development surface and the delivery set publish — not a parallel mapping.
// `branch` is the row's `headRef`, which that DTO does not carry: the branch NAME
// is what a planner reads at. The head commit falls back to the one the
// mergeability was last observed at when no check row was ever recorded.
export function toInFlightDeliveryFact(row: WorkItemDeliveryWithChecks): InFlightDeliveryFact {
  const pr = toLinkedPullRequestDto({
    ...row.pullRequest,
    repo: row.repo,
    checkRuns: row.pullRequest.checkRuns,
  });
  return {
    workItemId: row.workItemId,
    repo: pr.repo,
    branch: row.pullRequest.headRef,
    headSha: pr.headSha ?? row.pullRequest.mergeableStateHeadSha ?? null,
    prNumber: pr.number,
    prUrl: pr.url,
    draft: row.pullRequest.draft === true,
    baseRef: row.pullRequest.baseRef,
    open: pr.state === 'open',
    merged: row.pullRequest.merged,
  };
}
