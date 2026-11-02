// DTOs for the ai→core read-back surface (boundary contract §6). motir-ai reads
// these (the cheap skeleton) and submits a delta; the rich graph-traversal
// retrieval supersedes the read in Story 7.5.

import type {
  RelationshipLinkGroups,
  WorkItemDto,
  WorkItemKindDto,
  WorkItemObsolescenceDto,
  WorkItemPriorityDto,
  WorkItemRevisionDto,
  WorkItemTypeDto,
} from '@/lib/dto/workItems';
import type { CommentsPageDTO } from '@/lib/dto/comments';
import type { PlanStatusDto } from '@/lib/dto/plans';

/**
 * A DECISION's deciding gate, as the planner reads it (Story MOTIR-5871 · MOTIR-5958;
 * ADR `approval-gates.md` §1's MOTIR-5952 amendment, points 9–10; widened to the
 * planner's own decisions by Bug MOTIR-10146) — so a pass can order an epic's
 * decisions by when they were decided and see which were overturned, and why.
 * ADDITIVE: null on every item that is not a `decision` work item, and a consumer
 * that ignores a field is unaffected — so the two repositories deploy in either order.
 *
 * - `kind` — the gate that decides it: `decision_confirmation` for a `human` decision
 *   (a person confirms what the planner wrote), `decision_approval` for a
 *   `coding_agent` one (the planner's own record, published as a page and approved).
 * - `state` — `confirmed` (the gate was approved) · `overturned` · `awaiting` (asked,
 *   or sent back for a new version) · `none` (no live gate: a body that does not
 *   parse, a page not yet published, or a question withdrawn).
 * - `decidedAt` — ISO, the deciding gate's; null unless confirmed or overturned.
 * - `replanOwed` — the overturned decision's `## Supersedes` keys; null otherwise.
 * - `noteMd` — the reason the person wrote when they overturned it; null otherwise.
 */
export interface AiDecisionBlock {
  kind: 'decision_confirmation' | 'decision_approval';
  state: 'awaiting' | 'confirmed' | 'overturned' | 'none';
  decidedAt: string | null;
  replanOwed: string[] | null;
  noteMd: string | null;
}

// One node of the plan-tree breadth projection: the cheap fields the planner
// needs to reason over the tree, keyed by work-item identifier.
export interface PlanTreeSkeletonItem {
  key: string; // e.g. "MOTIR-481"
  // The real work-item cuid — the resolvable `workItemId` a generator emits on a
  // modify/remove PlanItem (materialize locks the target by cuid, not key). Folded
  // onto the breadth read (MOTIR-1531) so the generator no longer needs a
  // per-target `get-item` round-trip to recover it.
  id: string;
  kind: WorkItemKindDto;
  title: string;
  status: string;
  parentKey: string | null;
  // The id of the item's LATEST `work_item_revision` (null when it has none) — the
  // optimistic-concurrency `baseRevision` a modify/remove PlanItem stores (7.21.3
  // base-revision drift compares it to the target's current latest). Populated by
  // ONE batched `findLatestIdsByWorkItemIds` on the read (MOTIR-1531), never N+1.
  revision: string | null;
  // The folder the item is FILED in — its OWN placement, never an ancestor's
  // (Story MOTIR-5310 · MOTIR-5410). Only a root can carry one: the
  // `work_item_parent_xor_folder` CHECK keeps `parentKey` and `folderId` apart,
  // so a story under a filed epic reads `folderId: null` and its placement is
  // derivable from its ancestors' keys. Populated by ONE batched lookup per read.
  folderId: string | null;
  // A decision's deciding gate (MOTIR-5958, MOTIR-10146) — null on every other item.
  // Populated by ONE batched read per response, never N+1.
  decision: AiDecisionBlock | null;
  // The OBSOLESCENCE mark (Story MOTIR-6574 · MOTIR-6582) — `outdated` ·
  // `deprecated`, null when the card is still true of the code. The MARK only:
  // the note is a body, and bodies stay off the breadth read (`get-item` carries
  // it). Informational — no read in this family drops or re-sorts a marked row.
  obsolescence: WorkItemObsolescenceDto | null;
}

// One folder of the project, as the tree read carries it (MOTIR-5410). `path` is
// the folder's name and every ancestor's, ROOT FIRST — what a planner shows a
// filed item under ("Parked ▸ 2025"). Folders travel BESIDE the work items, never
// as rows of `items`: motir-ai reads `items` untyped, and a folder row there would
// be taken for a work item.
export interface PlanTreeFolder {
  id: string;
  parentFolderId: string | null;
  name: string;
  path: string[];
}

export interface PlanTreeResponse {
  project: { projectId: string; projectKey: string };
  items: PlanTreeSkeletonItem[];
  // Every folder of the project in tree order, bounded by the folder picker's own
  // cap. `foldersTruncated` says the project holds more than were read, so a
  // consumer never mistakes a capped list for the whole set. Always present: an
  // EMPTY array means the project has no folders (a consumer reading an older
  // core that omits the key treats the set as unknown, not as empty).
  folders: PlanTreeFolder[];
  foldersTruncated: boolean;
}

// ── Story 7.5 — the plan-tree GRAPH-TRAVERSAL read family ──────────────────
// The DEPTH reads the planning agent walks (get_item / get_subtree /
// walk_blocking), layered over the SAME job-scoped-token auth + tenant gate as
// the 7.1.6 skeleton (`skeleton` re-exposes that breadth read as a named tool
// in the family). Every response is bounded — comments are cursor-paginated,
// subtrees depth-bounded, the blocking closure node-capped (finding #57).

// One cursor-paged window of a work item's revision (status/field change) log —
// the "why is this item shaped this way" depth signal (mirrors CommentsPageDTO's
// take+1 next-page probe; newest-first, `nextCursor` null on the last page).
export interface WorkItemHistoryPage {
  revisions: WorkItemRevisionDto[];
  nextCursor: string | null;
}

// GET /api/internal/ai/get-item — one work item by key, plus (on request) the
// DEPTH context 7.1.6 deferred: the full comment thread and the change log, each
// bounded/paginated. `comments` / `history` are present ONLY when asked for.
/**
 * The AI boundary's item shape: the work-item DTO PLUS every relationship group
 * (MOTIR-4063; `supersedes` / `supersededBy` since MOTIR-6580). The DTO half
 * carries the OBSOLESCENCE mark and its note (`obsolescence`,
 * `obsolescenceNoteMd` — MOTIR-6579 / MOTIR-6582), so the planner reads whether
 * a card is still current, why, and what replaced it from this one item.
 *
 * ⚠️ The links ride the ITEM rather than sitting beside it, because that is
 * where the planner reads them (`motir-ai` `readLinks` indexes `blockedBy` /
 * `blocks` / `relatesTo` / `duplicates` / `clones` off the item object) — and
 * because a link IS a property of the item, unlike `comments` / `history`,
 * which are separately-paginated windows a caller asks for.
 *
 * ADDITIVE, deliberately: a `motir-ai` that predates this ignores the new keys,
 * so the two repositories deploy in either order. The consumer distinguishes an
 * ABSENT arm from an EMPTY one and reports the absent ones as `unavailable`, so
 * an arm arriving here silently becomes readable with no change on that side.
 */
export type AiWorkItemDto = WorkItemDto & RelationshipLinkGroups;

/**
 * Where a card's UNMERGED code lives in one repository (MOTIR-6618) — the open
 * pull request's branch, read off the delivery rows with no provider call.
 *
 * - `repo` is `owner/name`, exactly the `repoRef` `GET /api/internal/ai/repo-file`
 *   (motir-ai's `read_file`) accepts, so the planner passes it straight through
 *   together with `branch` as the `ref`.
 * - `branch` is the pull request's `headRef` — the NAME a reader reads at.
 *   `headSha` only dates the observation (the head the latest check rows ran on,
 *   else the head the mergeability was last observed at; null when neither was
 *   ever recorded).
 * - `source: 'own'` — the card's own open delivery in that repository.
 *   `source: 'inherited'` — the card has none there, so the entry is the NEAREST
 *   ancestor's open delivery in that repository (the story's
 *   `parent/MOTIR-<id>-<slug>` branch a child's commit rides); `fromKey` names
 *   that ancestor.
 * - `draft` is true only for a pull request recorded as a draft (null — never
 *   recorded — reads as false, as every other reader of the row treats it).
 */
export type InFlightCodeDto = {
  repo: string;
  branch: string;
  headSha: string | null;
  prNumber: number;
  prUrl: string;
  draft: boolean;
  baseRef: string | null;
} & ({ source: 'own' } | { source: 'inherited'; fromKey: string });

/**
 * The in-flight half of the get-item read (MOTIR-6618). Both are ARRAYS on every
 * item, never null: empty is the ordinary answer.
 *
 * `mergedRepos` names the repositories where the card's OWN delivery has merged
 * and no in-flight entry (own or inherited) remains — so a reader can tell "on
 * the default branch now" (`inFlightCode: []`, `mergedRepos: ['o/r']`) from
 * "nothing was ever written" (both empty).
 */
export interface AiInFlightCodeFields {
  inFlightCode: InFlightCodeDto[];
  mergedRepos: string[];
}

export interface GetItemResponse {
  // `decision` — a decision's deciding gate (MOTIR-5958, MOTIR-10146), null otherwise.
  // `inFlightCode` / `mergedRepos` — the card's unmerged code (MOTIR-6618).
  item: AiWorkItemDto & { decision: AiDecisionBlock | null } & AiInFlightCodeFields;
  comments?: CommentsPageDTO;
  history?: WorkItemHistoryPage;
}

// GET /api/internal/ai/get-subtree — an epic/story + its descendants, bounded by
// `depth` (0 = the root alone; NO whole-tree read — Epic-7 Principle #2). Each
// node is the same cheap skeleton row the planner folds into context. `depth` is
// the EFFECTIVE (clamped) descendant-level bound the read applied.
export interface SubtreeResponse {
  project: { projectId: string; projectKey: string };
  root: string; // the root's key, e.g. "MOTIR-806"
  depth: number;
  nodes: PlanTreeSkeletonItem[];
}

// One edge of the transitive is_blocked_by closure (`blockedKey` is_blocked_by
// `blockerKey`), keyed by identifier so the planner reads the DAG directly.
export interface BlockingEdge {
  blockedKey: string;
  blockerKey: string;
}

// GET /api/internal/ai/walk-blocking — the transitive is_blocked_by closure for
// an item ("what must land before this"). `nodes` are the transitive blockers
// (skeleton rows, excluding the root); `edges` spell out the DAG. `truncated` is
// true when the walk hit the node/-depth cap before exhausting the graph — the
// cycle-safe, node-capped defense (a pathological graph can't exhaust the job).
export interface BlockingClosureResponse {
  root: string; // the root's key
  nodes: PlanTreeSkeletonItem[];
  edges: BlockingEdge[];
  truncated: boolean;
}

// One matching row of the FilterAST search (Subtask 7.5.2) — the cheap
// projection the planner triages on. Deliberately flatter than the tree
// skeleton (`PlanTreeSkeletonItem`): a search hit-set is a flat filtered page,
// not a neighbourhood, so there is no meaningful `parentKey` to resolve (a
// filtered page rarely contains a hit's parent). It carries `type` + `priority`
// — the extra signal the shipped List row already surfaces — so the planner can
// rank hits before spending a `get_item` DEPTH read on the ones it cares about.
export interface SearchResultRow {
  key: string; // e.g. "MOTIR-852"
  // The real work-item cuid + its latest `work_item_revision` id (null when none)
  // — the modify/remove anchor a generator needs, carried consistently with the
  // tree skeleton so a hit can be reconciled without a follow-up `get-item`
  // (MOTIR-1531; `revision` from the SAME batched lookup, never N+1).
  id: string;
  kind: WorkItemKindDto;
  type: WorkItemTypeDto | null;
  title: string;
  status: string;
  priority: WorkItemPriorityDto;
  revision: string | null;
  // The OBSOLESCENCE mark (MOTIR-6582) — the same cheap field the skeleton row
  // carries, so a hit can be triaged as stale before a `get-item` depth read.
  obsolescence: WorkItemObsolescenceDto | null;
}

// POST /api/internal/ai/search-work-items (Subtask 7.5.2) — the on-demand SEARCH
// the planner runs to find the work items related to X without transmitting the
// whole tree. Rides the SHIPPED 6.1.1 versioned FilterAST + the `/items` List
// read (`getProjectIssuesList`), so it pages IDENTICALLY to the surface humans
// see: `nextCursor` is null on the last page (an opaque page cursor, never a
// "return all"). `total` is the full matching count across pages.
export interface SearchWorkItemsResponse {
  items: SearchResultRow[];
  total: number;
  nextCursor: string | null;
}

// POST /api/internal/ai/similar-work-items (Story MOTIR-2694 · Subtask
// MOTIR-2697) — one SEMANTIC candidate.
//
// ⚠️ THREE FIELDS, AND THE LIST IS THE CONTRACT, not a current selection
// (`docs/decisions/plan-tree-embeddings.md` §2): `key`, `title`, `score` — no
// `descriptionMd`, no `explanationMd`, no comment, no acceptance criterion, no
// excerpt, no snippet. **Adding a fourth content field is a change to that ADR,
// not a change to this type.**
//
// The reason is the whole shape of the feature. Semantic search PROPOSES; the
// existing keyed reads (`get-item` / `get-subtree` / `search-work-items`) DISPOSE
// — so no text ever enters a planning prompt because a cosine distance happened
// to be small, and every claim that reaches a plan traces to a keyed read of the
// real record. That is what makes this an EXTENSION of the product's no-RAG
// stance rather than an abandonment of it.
//
// `title` is in the contract and is not a violation of it: a title is the item's
// IDENTITY (the string the key resolves to, and the one every keyed read returns
// first), not its content. Returning a bare key would force a second read per
// candidate purely to render a name.
export interface SimilarWorkItemRow {
  key: string; // e.g. "MOTIR-2694"
  title: string;
  /** Cosine SIMILARITY in [-1, 1] — `1 - distance`, higher is closer. The
   *  repository ranks by `<=>` DISTANCE; the conversion happens exactly once,
   *  here at the DTO boundary (ADR §6.1). */
  score: number;
}

// The semantic candidate-finder's response (ADR §6.1). `model` echoes the model
// the ranking actually ran IN — a HARD filter, not a label, since two vectors
// from different models are not comparable.
//
// `coverage` is two integers and no prose. It exists so a caller can tell "I
// searched a fully-indexed project and there is genuinely nothing" apart from "I
// searched a project that is 3% indexed" — reporting the first when the second is
// true is the exact false "nothing matches" this whole story was written to
// remove, and a candidate-finder that cannot distinguish them reintroduces it one
// layer up. `embedded` counts the project's RANKABLE rows (this model, not
// archived); `total` counts the same population before the embedding join.
//
// `{ embedded: 0, total: 0 }` is the DEGRADED reading — the embedding store could
// not be read at all — and is deliberately distinguishable from `{ embedded: 0,
// total: 419 }`, which is a real project that nothing has indexed yet.
export interface SimilarWorkItemsResponse {
  results: SimilarWorkItemRow[];
  model: string;
  coverage: { embedded: number; total: number };
}

// The MCP semantic-search response (Story MOTIR-3098 · Subtask MOTIR-3101, per
// `docs/decisions/plan-tree-embeddings.md` Amendment 2) — the SAME ranking as
// `SimilarWorkItemsResponse`, reached from TEXT instead of a vector, plus the
// one field that keeps its failure modes apart.
//
// ⚠️ `outcome` EXISTS BECAUSE AN EMPTY ARRAY MEANS THREE DIFFERENT THINGS, and
// an agent that reads the wrong one re-creates the very defect this story was
// written to remove (MOTIR-3079: a capability rebuilt because the search that
// should have found it could not). `coverage` already separates two of them and
// requires arithmetic; embedding the query from text adds a third that coverage
// cannot express at all, because when the query cannot be embedded the search
// never ran. So the discriminator is COMPUTED SERVER-SIDE and travels beside the
// raw numbers rather than instead of them:
//
//   'ranked'          — candidates found.
//   'nothing-similar' — the project IS indexed and nothing is close. An answer.
//   'not-indexed'     — the project has no vectors for this model. NOT evidence
//                       that nothing exists.
//   'unavailable'     — the query could not be embedded (no AI backend, or it is
//                       unreachable). The search DID NOT HAPPEN.
//
// `coverage` is null on `unavailable` for the same reason: nothing was counted,
// and reporting `{ embedded: 0, total: 0 }` there would be indistinguishable from
// a degraded read of a real project.
export type SemanticSearchOutcome = 'ranked' | 'nothing-similar' | 'not-indexed' | 'unavailable';

export interface SemanticSearchResponse {
  outcome: SemanticSearchOutcome;
  results: SimilarWorkItemRow[];
  /** The model the ranking ran in; null when nothing was embedded or ranked. */
  model: string | null;
  coverage: { embedded: number; total: number } | null;
  /** A readable sentence for the human half of the dual content — what state this
   *  is and, on the two non-answers, what to do instead. */
  message: string;
}

// One applied operation's result — the resolved key + id core assigned.
export interface PlanDeltaAppliedEntry {
  op: 'create' | 'update';
  ref?: string;
  key: string;
  id: string;
}

export interface CommitPlanDeltaResponse {
  applied: PlanDeltaAppliedEntry[];
}

// GET /api/internal/ai/org-context (Subtask 7.3.45) — the calling org's
// existing footprint, the read-back the discovery interview weighs when it
// classifies a new project (an org already running several projects with a
// multi-person team skews startup/enterprise). The wire shape the planner reads;
// derived from the org domain's OrgFootprintDTO but owns its own contract (only
// the org id + name cross — no slug). Scoped to the job token's org, read AS the
// token's user.
export interface OrgContextResponse {
  organization: { id: string; name: string };
  workspaceCount: number;
  projectCount: number;
  projectNames: string[];
  memberCount: number;
}

// ── GET /api/internal/ai/pending-plans (MOTIR-4106) ───────────────────────────
// WHAT IS ALREADY PROPOSED on the token's project. Every other read in this
// family answers about the COMMITTED tree (`plan-tree`, `get-item`,
// `get-subtree`, `search-work-items`), and `plan-proposals` answers about ONE
// plan — the caller's own, resolved by `sourceJobId`. Neither answers "is
// somebody else's plan already in flight here?", which is the input GATE 1 is
// most likely to be changed by: a plan awaiting approval is work somebody
// decided on and nobody has merged, so proposing beside it duplicates it, and
// the duplicate arrives looking exactly like new work.

/**
 * The plan statuses that count as PENDING — a plan a person still has to decide
 * about (MOTIR-4106).
 *
 * ⚠️ THE SET IS NAMED HERE, ONCE, AND NO CALLER CHOOSES IT. That is the point:
 * "is this plan still in flight?" is one product decision, and a boundary that
 * took a status filter would have every consumer answer it separately and
 * differently.
 *
 * ⚠️ AND `stale` IS A MEMBER, WHICH IS NOT WHAT AN ENUMERATION OF THE OBVIOUS
 * TWO WOULD SAY. `PlanStatus`'s own schema comment settles it: *"`stale` … is
 * NOT terminal and NOT decided: the plan is live and awaiting action, and its
 * exits are the drift reversing (back to `planned`) or a reviewer declining
 * it."* A `stale` plan is a proposal sitting in front of a reviewer that cannot
 * be approved until its drift is resolved — the strongest possible case of work
 * already proposed and not yet merged, and precisely the plan a second proposal
 * would duplicate. `plansService.findPendingPlanIdForJob` reaches the same
 * answer from the other side, by EXCLUDING the decided pair rather than listing
 * the pending ones.
 *
 * The complement is the whole of what is excluded and it is two values:
 * `approved` (the proposals are the tree now) and `declined` (they are history).
 * Stated as an exclusion in the assertion below, so adding a sixth status to
 * `PlanStatus` fails a test rather than silently falling out of this set.
 */
export const AI_PENDING_PLAN_STATUSES = [
  'generating',
  'planned',
  'stale',
] as const satisfies readonly PlanStatusDto[];

/** The statuses a pending read must NEVER return — the decided pair. Written as
 *  its own list so the two together are TOTAL over `PlanStatusDto`, which is
 *  what `tests/integration/ai/pendingPlansRoute.test.ts` asserts: a status added
 *  to the vocabulary lands in neither list and turns that assertion red, instead
 *  of being quietly treated as decided. */
export const AI_DECIDED_PLAN_STATUSES = [
  'approved',
  'declined',
] as const satisfies readonly PlanStatusDto[];

/**
 * How many pending plans the boundary will return, at most (MOTIR-4106).
 *
 * A BOUND, not a page size: this seam has no cursor and is not meant to grow
 * one. Its answer goes into a prompt, where the useful fact is *there are plans
 * in flight, and here is enough to name them* — a project holding forty
 * undecided plans does not need forty rows to establish that, and
 * `truncated` says the list was cut. Ten matches the Plans list's own page
 * (`DEFAULT_PAGE_LIMIT`), so a planner and a reviewer see the same first screen.
 */
export const AI_PENDING_PLANS_LIMIT = 10;

/**
 * One pending plan, as the AI boundary reports it — deliberately NARROWER than
 * `PlanDto`.
 *
 * The row carries what a planner needs to DECIDE whether to keep going (is
 * there a plan, what is it called, how far along is it, how big is it, how old
 * is it) and nothing else. `itemCount` rather than the items themselves is the
 * whole shape of the bound: the proposals of an in-flight plan are exactly the
 * unbounded payload a prompt must not swallow, and a caller that genuinely
 * needs one plan's contents asks for that plan.
 */
export interface PendingPlanRow {
  id: string;
  title: string | null;
  status: PlanStatusDto;
  /** How many proposals the plan holds — the SIZE signal, never the items. */
  itemCount: number;
  createdAt: string;
}

export interface PendingPlansResponse {
  plans: PendingPlanRow[];
  /**
   * TRUE when the project holds more pending plans than
   * {@link AI_PENDING_PLANS_LIMIT} returned. Carried rather than left to be
   * inferred from `plans.length === limit`, which is ambiguous at exactly the
   * boundary and is the inference a consumer gets wrong.
   */
  truncated: boolean;
}

// ── The project's TERMINAL STATUS KEYS (MOTIR-4158) ──────────────────────────
//
// `GET /api/internal/ai/terminal-statuses` — the narrowest read on this
// boundary: no subtree, no closure, no plan state, just the set of status keys
// that mean FINISHED for the token's project.
//
// ⚠️ IT IS A SET DERIVED FROM `category = 'done'`, NEVER A LITERAL PAIR. The
// whole reason this crosses the wire is that `motir-ai` had been answering the
// question with a hardcoded `'done'`, which silently excludes `cancelled` — a
// status the DEFAULT workflow ships — and excludes outright whatever else a
// customer has configured as terminal. `workflowsService.getTerminalStatusKeys`
// is the one place that predicate lives, and it is the same set
// `lib/plans/validateProposals.ts` step 4 already refuses `modify` / `remove`
// against, so the persistence guard and any consumer of this read cannot
// disagree.
export interface TerminalStatusesResponse {
  /**
   * Every status key in the project whose category is `done` — `done` AND
   * `cancelled` out of the box, plus any the project defines. SORTED, so the
   * wire shape is stable across reads and a consumer may compare two answers
   * directly; a consumer that wants membership builds its own `Set`.
   */
  terminalStatusKeys: string[];
}
