// DTOs for the work-item endpoints + surfaces. These define EXACTLY what
// crosses the HTTP / Server-Action boundary — no Prisma model leaks. The
// service layer (1.4.4) returns these, never raw Prisma rows.
//
// Wire-safe scalar choices: enums are string-literal unions (mirroring the
// Prisma enum labels, but defined here so the DTO module stays Prisma-free);
// `DateTime` becomes an ISO-8601 `string`; the `Decimal` position becomes a
// `string` (a fractional-index key is already a string and Decimals don't
// JSON-serialize losslessly as numbers). The mapper owns those conversions.

import type { FixDetailDto, FixGroupPointerDto, WorkItemFixReasonDto } from '@/lib/dto/fixReason';
import type { EdgeDisposition } from '@/lib/workItems/edgeDisposition';
import type { ChoiceBodyDTO } from '@/lib/dto/approvalGate';
import type { FilterAst } from '@/lib/filters/ast';
import type { Locale } from '@/lib/i18n/locales';
import type { WorkItemSections } from '@/lib/workItems/sections/registry';
import type { WorkflowDto, StatusCategoryDto } from './workflows';
import type { SprintBlockerDto } from './sprints';
import type { RelationshipKind } from './workItemLinks';
import type { LabelDto } from './labels';
import type { ComponentDto } from './components';
import type { ProjectRepoRoleDto, ProjectRepoStateDto } from './projectRepos';
import type { CustomFieldWithValueDto } from './customFieldValues';

export type WorkItemKindDto = 'epic' | 'story' | 'task' | 'bug' | 'subtask';
export type WorkItemPriorityDto = 'lowest' | 'low' | 'medium' | 'high' | 'highest';
export type WorkItemExplanationSourceDto = 'user_authored' | 'ai_draft' | 'user_edited';

/**
 * Work-item PROVENANCE source enums (Story MOTIR-1685,
 * docs/decisions/work-item-provenance.md) — the closed AUTHOR-CATEGORY sets. The
 * accompanying `harness`/`model` are open free-text strings, not enums.
 */
export type WorkItemPlanningSourceDto = 'native' | 'mcp' | 'manual' | 'api';
export type WorkItemImplementationSourceDto = 'hosted' | 'byok' | 'manual';
/**
 * The work-item TYPE — the NATURE of executable work (Story 2.7). A FIXED
 * FOURTEEN-member set, in the canonical order the 2.7.2 ADR
 * (docs/decisions/work-item-type-taxonomy.md) froze and its **Amendment 1**
 * (MOTIR-2629) extended, mirroring the `WorkItemType` Prisma enum 1:1.
 * DISTINCT from `kind`; carried only on executable leaves (task / subtask /
 * bug) — epics/stories + legacy rows are `null`. Fixed (not free text) so
 * Story 7.6's per-type prompt generator is a TOTAL function over it and the
 * 2.7.6 filter facet is a closed set.
 *
 * Amendment 1 admitted `copy` / `translate` / `legal` / `verification` and
 * declared `doc` an alias of `content` and `spike` an alias of `research` —
 * neither alias is a member. It also NARROWED `content` to documentation and
 * authored long-form material, with a precedence rule: when a card fits
 * `copy`, `translate` or `legal`, the specific member wins over `content`.
 */
export type WorkItemTypeDto =
  | 'code'
  | 'design'
  | 'test'
  | 'content'
  | 'copy'
  | 'translate'
  | 'research'
  | 'review'
  | 'verification'
  | 'decision'
  | 'choice'
  | 'deploy'
  | 'manual'
  | 'legal'
  | 'chore';
/**
 * WHO executes a piece of work (Story 2.7) — mirrors the `Executor` Prisma
 * enum. Seeded from the type→executor default map (`lib/issues/executorDefaults.ts`)
 * when a type is first chosen, and overridable.
 */
export type ExecutorDto = 'coding_agent' | 'human';
/**
 * How HARD a leaf is to REASON about (Story MOTIR-6016) — mirrors the
 * `WorkItemDifficulty` Prisma enum, whose members `lib/issues/difficulty.ts`
 * lists in order and asserts total. Leaf-only, exactly as `type` is.
 */
export type WorkItemDifficultyDto = 'trivial' | 'low' | 'medium' | 'high';
/**
 * Whether a work item is still TRUE OF THE CODE (Story MOTIR-6574 · MOTIR-6579)
 * — mirrors the `WorkItemObsolescence` Prisma enum, whose members
 * `lib/issues/obsolescence.ts` lists in order and asserts total. Unlike
 * `difficulty`, it is KIND- and STATUS-agnostic: any card may carry it.
 */
export type WorkItemObsolescenceDto = 'outdated' | 'deprecated';

/**
 * The full work-item shape for the detail view. Carries both content axes
 * (descriptionMd / explanationMd) and the explanation provenance enum so the
 * UI can render the "AI-drafted — review me" badge.
 */
/**
 * One repository an item ships in, as the `project_repository` row it REFERENCES
 * (Story MOTIR-2732 · MOTIR-3041).
 *
 * The reference is the identity; the name is what it resolves to. Everything else
 * here is a fact about the ROW that a bare name could never carry, and that the
 * surfaces need in order to say what a reader is looking at: a repository that
 * does not exist yet is not the same as one whose pull request is late.
 */
export interface WorkItemRepositoryDto {
  /** The `project_repository` row id — stable across a rename, and across the row
   *  being edited before it is established. */
  ref: string;
  /** The REALIZED repository's own name once the row is realized, else the row's
   *  authored intent (ADR §A4's resolved-name rule). */
  name: string;
  role: ProjectRepoRoleDto;
  /** The free-form label that distinguishes two rows of a repeated role. */
  label: string | null;
  /** The establish state — a `proposed` row names no repository that exists. */
  state: ProjectRepoStateDto;
  /** Element 0 — the repository a dispatch routes to (ADR §2). */
  primary: boolean;
}

/** The recorded language of a work item's three text fields; `null` = none recorded. */
export interface WorkItemLanguagesDto {
  title: Locale | null;
  description: Locale | null;
  explanation: Locale | null;
}

/** The fields a work-item write can record a language for. */
export type WorkItemLanguageField = keyof WorkItemLanguagesDto;

export interface WorkItemDto {
  id: string;
  projectId: string;
  parentId: string | null;
  kind: WorkItemKindDto;
  key: number;
  identifier: string;
  title: string;
  descriptionMd: string | null;
  explanationMd: string | null;
  explanationSource: WorkItemExplanationSourceDto;
  /**
   * The language each text field was written in (Story MOTIR-7731 · MOTIR-8096).
   * `null` means no language was recorded — text written before the story, or
   * an empty field — and is never read as `en`.
   */
  languages: WorkItemLanguagesDto;
  status: string;
  priority: WorkItemPriorityDto;
  assigneeId: string | null;
  reporterId: string;
  dueDate: string | null;
  estimateMinutes: number | null;
  /**
   * The NATURE of the work (Story 2.7) — one of the ten `WorkItemTypeDto`
   * members, or `null` on a container kind (epic/story) or an untyped leaf.
   * DISTINCT from `kind`.
   */
  type: WorkItemTypeDto | null;
  /**
   * WHO executes the work (Story 2.7) — `coding_agent` | `human`, seeded from
   * the type→executor default when a type is chosen and overridable. `null`
   * when no type is set.
   */
  executor: ExecutorDto | null;
  /**
   * How HARD the work is to reason about (Story MOTIR-6016) — `low` | `medium`
   * | `high`, set by a person (or, later, the planner). `null` when unset, and
   * always `null` on a container kind (epic/story): the service refuses one.
   */
  difficulty: WorkItemDifficultyDto | null;
  /**
   * The agile STORY-POINT estimate (Story 4.3 · Subtask 4.3.3) — a separate
   * numeric estimate from `estimateMinutes` (TIME). Null = unestimated. The
   * project's `estimationStatistic` config picks which of the two the planning
   * surfaces display + the roll-ups sum. The `Decimal(6, 2)` column is mapped
   * to a wire-safe `number` here.
   */
  storyPoints: number | null;
  position: string;
  /**
   * The sprint this issue is committed to, or null when it sits in the backlog
   * (Subtask 4.1.4). Lets an association mutation's result describe the new
   * placement without a re-fetch.
   */
  sprintId: string | null;
  /**
   * The global backlog/sprint rank — the opaque fractional-index ordering
   * within the backlog AND a sprint (Subtask 4.1.4). Orthogonal to `position`
   * (which orders the issue TREE). Null only on a row predating the 4.1.1
   * backfill (none in practice).
   */
  backlogRank: string | null;
  /**
   * Epic-level privacy (Story 6.14 · Subtask 6.14.3). When `true` on an
   * EPIC-kind item, a public/non-member viewer of a public project sees the
   * epic ROW but NOT its children or aggregate tells (the server-side exclusion
   * lands in 6.14.4). A no-op marker on any other kind / non-public project.
   * Carried on the internal (member/admin) DTO so the 6.14.7 admin control can
   * seed its toggle from the authoritative value.
   */
  publicChildrenHidden: boolean;
  /**
   * The integration branch this item's work currently sits on (Story 7.8 ·
   * Subtask 7.8.11), or `null`. NON-NULL ⇔ the item is integrated-awaiting-review
   * (status moved to `in_review` via `mark_integrated`): its work is mergeable,
   * so it unblocks dependents (the integrated-dep readiness rule) and the issue
   * detail surfaces it as a read-only line. CLEARED back to null the moment the
   * item reaches a `done`-category status. Carried on the DTO so the issue detail
   * + the MCP tool results render the authoritative value.
   */
  sessionBranch: string | null;
  /**
   * The repo this item's work ships in (Story 7.9 · MOTIR-1804) — the bare repo
   * NAME (`motir-core`), or `null` when no repo has been pinned. This is the
   * EXPLICIT pin exactly as stored: the detail surface and the authoring tools
   * must be able to tell "pinned to the only connected repo" from "not pinned",
   * so no default is applied here. (`ReadyItemDispatchDto.targetRepo` is the
   * RESOLVED counterpart — that one falls back to the workspace's single
   * connected repo, because a dispatching agent needs an answer, not a state.)
   */
  targetRepo: string | null;
  /**
   * EVERY repository this item's work ships in (Story MOTIR-2725 · MOTIR-2728,
   * ADR `docs/decisions/work-item-repository-set.md` §3) — ordered, with
   * **element 0 the PRIMARY**, which is exactly what `targetRepo` above holds.
   *
   * The two are not two facts: `targetRepo === targetRepos[0] ?? null`, always.
   * The scalar survives because `/api/v1` publishes it and §8 of
   * `public-api-conventions.md` forbids removing, renaming or retyping a
   * published field without a new major — so the set is ADDITIVE here and on
   * every exposed shape, and a consumer that reads only the scalar keeps getting
   * the repository dispatch routes to.
   *
   * `[]` is the empty set — the same state the null pin has always meant, and the
   * state most cards are in. It is legitimate and optional by design; nothing
   * anywhere may present the field as required.
   */
  targetRepos: string[];
  /**
   * The item's repositories as RESOLVED REFERENCES (Story MOTIR-2732 · MOTIR-3041,
   * ADR "Amendment 2026-08-18" §A4) — one entry per `project_repository` row the
   * item points at, in set order, element 0 the primary.
   *
   * ADDITIVE beside the two name fields, which keep their shape and meaning: they
   * are the NAMES these references resolve to. That is what makes a repository
   * RENAME change every display and nothing about what any card points at.
   *
   * ⚠️ **ABSENT (not `[]`) when the read did not load them** — the reserved-hole
   * convention, and the distinction a consumer needs: *"this card has no
   * repositories"* and *"this read did not ask"* are different answers, and an
   * empty array collapses them. `toWorkItemDto` maps a bare row and cannot join,
   * so the surfaces that publish this field (the item detail, `/api/v1`, the MCP
   * item payload) pass the resolved rows in; a read that does not need them pays
   * no join. Never infer emptiness from absence.
   */
  targetRepositories?: WorkItemRepositoryDto[];
  /**
   * Work-item PROVENANCE (Story MOTIR-1685) — how the item was PLANNED and how it
   * was IMPLEMENTED, each a `source · harness · model` triple. All six nullable:
   * a null triple is the "unknown / —" state (pre-feature rows; items never
   * executed). `source` is one of the closed enum members; `harness`/`model` are
   * free-text (recorded as self-reported, no verification implied). Carried on the
   * detail DTO so the work-item detail (MOTIR-1693) renders both triples.
   */
  planningSource: WorkItemPlanningSourceDto | null;
  planningHarness: string | null;
  planningModel: string | null;
  implementationSource: WorkItemImplementationSourceDto | null;
  implementationHarness: string | null;
  implementationModel: string | null;
  /**
   * WHICH SUBJECT MATTER the planner composed this card's rule packs from (Story
   * MOTIR-5062 · MOTIR-5074) — the fourth selector coordinate, and the READ half
   * of the column MOTIR-5065 persists. It joins the two triples above because it
   * is the same KIND of fact: a record of how the card came to be PLANNED, not a
   * property of the work. The rail draws it as the third `Provenance` group.
   *
   * ⚠️ A BARE `string`, NOT a closed union, and that is deliberate rather than
   * lax. The member vocabulary IS the rule-pack file set in motir-meta — a member
   * exists iff `subject-<name>.md` does — so motir-core cannot enumerate it
   * without putting a schema change in front of every new pack. The consequence
   * the renderer has to honour: a value this build has never heard of is LEGAL
   * and must render as its own text (never blank, never a lookup with a
   * fallback). `null` is the common case and stays common.
   */
  subject: string | null;
  /**
   * The OBSOLESCENCE mark (Story MOTIR-6574 · MOTIR-6579) — `outdated` (the card
   * no longer matches what shipped) or `deprecated` (its work was superseded),
   * `null` when unmarked. Settable on ANY kind in ANY status, archived included.
   */
  obsolescence: WorkItemObsolescenceDto | null;
  /** The Markdown note saying WHY the card is marked; `null` when none. */
  obsolescenceNoteMd: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The lighter shape for list / tree views — just what a row renders (kind
 * icon, identifier, title, assignee avatar, status badge) plus the tree
 * wiring (parentId, position). Omits the heavy Markdown content fields so a
 * list query doesn't ship two `@db.Text` blobs per row.
 */
export interface WorkItemSummaryDto {
  id: string;
  parentId: string | null;
  kind: WorkItemKindDto;
  key: number;
  identifier: string;
  title: string;
  status: string;
  priority: WorkItemPriorityDto;
  assigneeId: string | null;
  position: string;
  /**
   * The TIME estimate in whole minutes (Story 2.3.6) + the agile STORY-POINT
   * estimate (Story 4.3.4) — both nullable, both carried on the summary so the
   * inline `EstimateBadge` can render whichever the project's
   * `estimationStatistic` selects on a backlog / sprint row without a re-fetch.
   * (The backlog reads full work-item rows, so adding these is free.)
   */
  estimateMinutes: number | null;
  storyPoints: number | null;
  /**
   * The OBSOLESCENCE mark + its note (Story MOTIR-6574 · MOTIR-6579) — carried on
   * the summary so a marked CHILD reads as marked from its parent's child rows
   * and every summary list. `null` when unmarked / no note.
   */
  obsolescence: WorkItemObsolescenceDto | null;
  obsolescenceNoteMd: string | null;
  archivedAt: string | null;
}

/**
 * The CURRENT status of a referenced work item, shaped for the internal-link
 * chip's status DOT (Story 5.8 · Subtask 5.8.6): the machine `key`, its display
 * `label`, and the `category` that picks the dot hue (todo · in_progress · done).
 */
export interface WorkItemRefStatusDto {
  key: string;
  label: string;
  category: StatusCategoryDto;
}

/**
 * The resolved summary of ONE referenced work item, for rendering a
 * `[KEY](motir:<id>)` token (or a bare `KEY-N` in a title) as a LIVE
 * internal-link chip (Subtask 5.8.6). A reference NEVER breaks the body, so the
 * shape is a small discriminated union by view scope:
 *
 *  - `accessible: true` — the caller may browse the target's project, so the
 *    chip shows the CURRENT `identifier` · `title` · `status` (+ `archived` for
 *    the muted/dashed treatment). `status` is null only when the stored
 *    `work_item.status` no longer resolves to a workflow status.
 *  - `accessible: false` — the target exists in the workspace but sits in a
 *    project the caller can't view, so NOTHING but the id crosses the wire (no
 *    title / status leak); the chip renders the bare authored key only.
 *
 * A token id that resolves to NOTHING (deleted / cross-workspace) is simply
 * ABSENT from the map — the chip then renders the bare authored key struck
 * through. Keyed in {@link WorkItemRefMap} by BOTH the work-item id (the token
 * href payload) and, when accessible, its current identifier (the bare-key /
 * title path).
 */
export type WorkItemRefSummaryDto =
  | {
      accessible: true;
      id: string;
      identifier: string;
      title: string;
      kind: WorkItemKindDto;
      archived: boolean;
      status: WorkItemRefStatusDto | null;
      /**
       * The work item's NATURE — `null` for what carries none (an epic, a story,
       * an untyped leaf), never "not loaded". The two client-built summaries that
       * hold only a key and a title (`GuideRail`, `PlanChangeRail`) are the only
       * place a `null` here means "not carried".
       */
      type: WorkItemTypeDto | null;
      /** The assignee's display, or `null` for an unassigned item (see {@link WorkItemRefAssigneeDto}). */
      assignee: WorkItemRefAssigneeDto | null;
    }
  | { accessible: false; id: string };

/**
 * An assignee as a reference summary carries them: enough to draw a name and an
 * avatar, resolved server-side so a page reader needs no member directory. On the
 * member path `name` is `null` when the member has none (the renderer picks its
 * fallback); on the Visitor path it is `personName`'s label and `image` is `null`
 * meaning WITHHELD, not "no avatar" (MOTIR-6646).
 */
export interface WorkItemRefAssigneeDto {
  id: string;
  name: string | null;
  image: string | null;
}

/**
 * One row of the `@` / page-embed picker's candidate read
 * (`GET /api/work-items/mention-search`). Its own wire shape rather than a
 * widened {@link WorkItemSummaryDto}: that is a row mapper handed no join, so an
 * assignee field on it would be `null` on every board and backlog read — a
 * `null` that says "not loaded" where `null` already means "unassigned".
 * `status` is the raw key; the client derives its provisional Pill from it.
 */
export interface WorkItemMentionCandidateDto {
  id: string;
  identifier: string;
  title: string;
  kind: WorkItemKindDto;
  status: string;
  type: WorkItemTypeDto | null;
  assignee: WorkItemRefAssigneeDto | null;
}

/**
 * A body/title's resolved work-item references, keyed by the work-item id (the
 * `motir:<id>` token payload the render layer looks up) AND, for accessible
 * targets, the current identifier key (e.g. `MOTIR-805`, the title-linkify
 * path). Unresolvable ids are absent (rendered as a struck-through bare key).
 */
export type WorkItemRefMap = Record<string, WorkItemRefSummaryDto>;

/**
 * The aggregate read backing the issue DETAIL page (Story 2.4 · Subtask 2.4.1).
 * One service call assembles everything the page renders in a single round-trip:
 * the work item, its full ANCESTOR chain (root→self, backing the parent
 * breadcrumb — 2.4.3) + its immediate parent (the rail's Parent field — 2.4.2)
 * + direct children (the child list — 2.4.3), its blocked-by / blocks
 * dependency links resolved to summaries (the relationships panel + readiness
 * badge — 2.4.5), and the project's workflow (the status control's
 * legal-transition source — 2.4.4). `ancestors` is ordered root→self and
 * EXCLUDES the item itself (a top-level item has `ancestors: []`); `parent` is
 * the immediate parent, kept as its own field so the 2.4.2 rail need not
 * re-derive it. `blockedBy` = items THIS item is blocked by; `blocks` = it blocks.
 * Each relationship group is a {@link RelationshipLinkDto} — the linked item
 * summary PLUS the `work_item_link.id` of the edge, so the 2.4.9 inline remove
 * can target the exact link without re-deriving it.
 */
export interface RelationshipLinkDto {
  /** The `work_item_link.id` of THIS edge — what `unlinkWorkItems` deletes. */
  linkId: string;
  item: WorkItemSummaryDto;
  /** WHY the edge exists (MOTIR-9827) — the one line an approved plan's
   *  `blocked_by` carried, saying what the waiting card consumes. Present only on
   *  an edge that has one. */
  reason?: string;
}

/**
 * ALL SEVEN relationship groups of one work item, each `key ASC` (MOTIR-4063,
 * widened by MOTIR-6580).
 *
 * `blockedBy` = items this item `is_blocked_by` (its OUT edges of that kind);
 * `blocks` = the items it blocks (the IN edges of the same kind); `relatesTo` /
 * `duplicates` / `clones` = its OUT edges of those kinds (`relates_to` persists
 * a reciprocal row, so its OUT set already covers both directions);
 * `supersedes` / `supersededBy` = the OUT / IN edges of the directed
 * `supersedes` kind (`from` is the NEWER item, no reciprocal).
 *
 * ⚠️ The five are ONE CONCEPT and were, until MOTIR-4063, THREE ROUTES: the item
 * detail assembled all five for the UI/MCP, the AI boundary carried none of them
 * on its item payload, and `blocked_by` reached a planner only through its own
 * `walk-blocking` closure — which has no inverse, so `blocks` was unreachable
 * for the same reason as the other three rather than available like its pair
 * (planning bug MOTIR-4090). Naming the whole group in one type is what stops
 * the next reader classifying a member by its neighbour instead of its route.
 */
export interface RelationshipLinkGroups {
  blockedBy: RelationshipLinkDto[];
  blocks: RelationshipLinkDto[];
  relatesTo: RelationshipLinkDto[];
  duplicates: RelationshipLinkDto[];
  clones: RelationshipLinkDto[];
  /** The OLDER items this one replaces — its OUT `supersedes` edges (MOTIR-6580). */
  supersedes: RelationshipLinkDto[];
  /** The NEWER items that replace this one — its IN `supersedes` edges. */
  supersededBy: RelationshipLinkDto[];
}

/**
 * ONE end of a dependency edge, as a LIST row renders it (Subtask 7.9.0f /
 * MOTIR-1842). Deliberately thinner than {@link RelationshipLinkDto}: a list
 * projection names the far end and shows whether it is still open — it never
 * offers the inline remove, so it carries no `linkId`, and it never renders a
 * full summary card, so it carries no assignee / dates / points.
 *
 * `key` is the `PROD-<n>` IDENTIFIER string, matching the Ready surface's
 * agent-facing vocabulary (see `lib/dto/ready.ts`'s naming note) rather than the
 * core DTOs' numeric `key` — an agent renders `blocked by PROD-3`, never
 * `blocked by 3`. `status` is the raw workflow status key (`todo` / `done` / …),
 * the same string `WorkItemListItemDto.status` carries.
 */
export interface WorkItemEdgeSummaryDto {
  /** The `PROD-<n>` identifier of the item at the far end of the edge. */
  key: string;
  title: string;
  /** The far end's raw workflow status key (e.g. `todo`, `in_progress`, `done`). */
  status: string;
}

/**
 * The per-row dependency projection the MCP list reads attach (Subtask 7.9.0f /
 * MOTIR-1842) — BOTH directions of the `is_blocked_by` graph around one item:
 * `blockedBy` = what gates it, `blocks` = what it gates.
 *
 * TOTAL by construction: an item with no edges carries two EMPTY arrays, never a
 * missing key, so a renderer never branches on presence. The whole page's
 * projection comes from TWO batched queries regardless of page size
 * (`workItemsService.getDependencyEdgesForItems`) — never one read per row.
 */
export interface WorkItemDependencyEdgesDto {
  blockedBy: WorkItemEdgeSummaryDto[];
  blocks: WorkItemEdgeSummaryDto[];
}

/**
 * One work item PLUS its ancestor chain — the LINEAGE read (MOTIR-2070). The
 * thin sibling of {@link IssueDetailDto} for a caller that needs where an item
 * SITS in the tree and nothing else: the planning workspace resolves its `?item=`
 * anchor and has to seed the drill-down canvas at the anchor's own level, which
 * needs each ancestor's `identifier` + `title` for the breadcrumb — data the bare
 * `getWorkItemByIdentifier` read cannot supply and the full detail aggregate
 * (thirteen parallel reads) is far too heavy to buy.
 *
 * `ancestors` is ordered root→self and EXCLUDES the item itself, so a top-level
 * item carries `[]` — the same contract, and the same ordering, as
 * `IssueDetailDto.ancestors`.
 */
export interface WorkItemLineageDto {
  item: WorkItemDto;
  ancestors: WorkItemSummaryDto[];
}

/**
 * The planning surface's ANCHOR read (MOTIR-7621) — the lineage plus whether the
 * item has anything INSIDE it. The canvas opens inside a target only when there
 * is a level to open onto; a childless story, task or bug arrives on its own
 * level instead, beside its siblings, so the item the conversation is about is
 * on screen rather than hidden behind an empty level.
 *
 * `hasChildren` counts with the SAME predicate the lazy tree loads a parent's
 * level with (`countProjectTreeLevel`: live, not in triage), so "has children"
 * and "the level the canvas would load is non-empty" are one answer.
 */
export interface PlanningAnchorLineageDto extends WorkItemLineageDto {
  hasChildren: boolean;
}

/**
 * The folder a work item EFFECTIVELY sits in (Story MOTIR-5309 · MOTIR-5375) —
 * its own, else its root ancestor's. Only a root can be filed (the CHECK
 * `work_item_parent_xor_folder`), so a story under a filed epic lives in the
 * epic's folder without recording one.
 */
export interface PlacementFolderDto {
  folderId: string;
  /** The folder's name path, ROOT FIRST ("Later", "2025"). */
  path: string[];
  /** The root ancestor the folder is inherited from, or `null` when filed directly. */
  via: WorkItemSummaryDto | null;
}

/**
 * Where ONE work item sits right now — the placement slice of
 * {@link IssueDetailDto}, built by the same mapper, which the work item page
 * re-asks after the item moves on the page (MOTIR-5375).
 */
export interface WorkItemPlacementDto {
  /** The item's OWN folder (never inherited), as on `IssueDetailDto.folderId`. */
  folderId: string | null;
  parent: WorkItemSummaryDto | null;
  ancestors: WorkItemSummaryDto[];
  placementFolder: PlacementFolderDto | null;
}

export interface IssueDetailDto {
  item: WorkItemDto;
  /**
   * The folder the item is filed in, or `null` (Story MOTIR-5308 · MOTIR-5352).
   * Read off the SAME row the detail read loads — it rides the aggregate rather
   * than `WorkItemDto`, whose wire shape `/api/v1` and the MCP publish.
   */
  folderId: string | null;
  /**
   * The item's EFFECTIVE folder, or `null` (MOTIR-5375) — what the page's Folder
   * field and breadcrumb read. ⚠️ Kept OUT of MCP `get_work_item` (which spreads
   * this aggregate) and `/api/v1`: how agents learn folders is Story MOTIR-5310's.
   */
  placementFolder: PlacementFolderDto | null;
  /**
   * Why the card is stuck until something is repaired (`WorkItem.fixReason`,
   * MOTIR-6600), or `null` (Story MOTIR-6589). Read off the SAME row the detail
   * read loads, and carried on the aggregate rather than `WorkItemDto` for the
   * reason `folderId` is. The quick view's header draws the To fix tag off it
   * (MOTIR-6610) and the item page its banner (MOTIR-6611).
   */
  fixReason: WorkItemFixReasonDto | null;
  /**
   * What the item page's To fix banner names for that reason — the check, the
   * base, the reviewer and their note, and the repair command (`WorkItem.fixDetail`,
   * MOTIR-6600). `null` exactly when `fixReason` is (MOTIR-6611).
   */
  fixDetail: FixDetailDto | null;
  /**
   * The To fix ENTRY this card is one of, when it holds other cards (MOTIR-7589) — the
   * banner names the head and only the head shows a command; the quick view's tag names
   * the head. `null` for a card stuck alone or not stuck, and for a Visitor.
   */
  fixGroup: FixGroupPointerDto | null;
  ancestors: WorkItemSummaryDto[];
  parent: WorkItemSummaryDto | null;
  children: WorkItemSummaryDto[];
  /** A PRIVATE epic read by a Visitor (MOTIR-6652, `epic-privacy.md` §4): its
   *  children are withheld, so `children` is empty and the item's sizing is
   *  nulled. Absent on every member read and every other item. */
  childrenHidden?: true;
  blockedBy: RelationshipLinkDto[];
  blocks: RelationshipLinkDto[];
  relatesTo: RelationshipLinkDto[];
  duplicates: RelationshipLinkDto[];
  clones: RelationshipLinkDto[];
  /** See {@link RelationshipLinkGroups.supersedes} (MOTIR-6580). */
  supersedes: RelationshipLinkDto[];
  /** See {@link RelationshipLinkGroups.supersededBy} (MOTIR-6580). */
  supersededBy: RelationshipLinkDto[];
  readiness: ReadinessVerdictDto;
  /**
   * A CHOICE'S BODY, parsed (Story MOTIR-4914 · MOTIR-5891) — the options, or the
   * reasons it cannot be asked yet. `null` for every item that is not
   * `type: choice`. A defective body raises no gate, so this is how the page
   * learns its state: the port renders the defect from it (MOTIR-5896).
   */
  choiceBody: ChoiceBodyDTO | null;
  workflow: WorkflowDto;
  /**
   * The issue's labels, name-ordered (Subtask 5.4.2 — rides the detail
   * read's parallel fetch, one bounded query; the 5.4.8 rail card renders
   * these as chips). Bounded in practice by the per-issue cap.
   */
  labels: LabelDto[];
  /**
   * The issue's components, name-ordered (Subtask 5.4.3 — rides the detail
   * read's parallel fetch, one bounded query; the 5.4.8 rail card renders
   * these as chips). Bounded by the project's admin-curated taxonomy.
   */
  components: ComponentDto[];
  /**
   * The project's custom-field definitions in position order, each with its
   * option set and THIS issue's resolved value (Subtask 5.3.3 — one bounded
   * query in the detail read's parallel fetch, ≤50 by the project cap).
   * Fields the issue holds no value for ship with `value: null` — the 5.3.7
   * rail collapses those behind "Show more fields".
   */
  customFields: CustomFieldWithValueDto[];
  /**
   * How many people watch this issue — the header eye-count (Subtask 5.4.4;
   * two point reads riding the detail read's parallel fetch, no extra
   * round-trip). The full roster stays behind the paged watchers route.
   */
  watcherCount: number;
  /** Whether the CALLER watches it — the eye control's filled/outline state. */
  viewerIsWatching: boolean;
  /**
   * Who archived this item (Story 2.9 · Subtask 2.9.6) — present ONLY when the
   * item is archived (`item.archivedAt != null`), resolved from the latest
   * `'archived'` revision (the same source as the 2.9.3 list view). `null` for
   * an active item, OR when the item is archived but no `'archived'` revision
   * resolved an actor (defensive — `item.archivedAt` carries the WHEN
   * regardless). The detail page's archived banner names the WHO from this and
   * the WHEN from `item.archivedAt`.
   */
  archivedBy: ArchivedByActorDto | null;
}

/**
 * A readiness verdict for a work item (Subtask 2.4.5 — the first PRODUCTION
 * wiring of 2.2.6's `isReady` / finding #21). `ready` is true iff EVERY
 * `is_blocked_by` blocker has reached a TERMINAL status in ITS OWN project's
 * workflow (`category = done`, so `done` AND `cancelled` count). An item with
 * no blockers is trivially `ready`. `openBlockers` lists the non-terminal
 * blockers (empty when `ready`) so the ready/blocked banner can NAME the reason
 * it's blocked; each is the same `WorkItemSummaryDto` the relationships panel
 * renders, so the page never re-derives which blockers are open. This is the
 * presentational `ReadinessBadge`'s input — Epic 3 boards + Epic 6 reports
 * consume the same verdict shape.
 */
export interface ReadinessVerdictDto {
  ready: boolean;
  openBlockers: WorkItemSummaryDto[];
  /**
   * The nearest ANCESTOR whose OWN blocker is still open — the cascade cause
   * (Subtask 7.0.13) when an item's own blockers are all clear but a blocked
   * parent / grandparent holds it out of the ready set. `null` when the item is
   * ready, or when no ancestor is itself own-blocked. Populated independently of
   * `openBlockers` (an item can have both); the banner shows own blockers first
   * and falls back to this so a cascade-blocked item is never a bare "Blocked"
   * with nothing to point at.
   */
  blockedByAncestor: WorkItemSummaryDto | null;
}

/**
 * A row of the subtree projection (Subtask 1.4.4) — the wire shape of
 * `workItemRepository.findSubtree`'s recursive-CTE result. Carries the tree
 * wiring (parentId, position, depth) plus the row-render fields, but NOT the
 * heavy Markdown content (a tree view never renders description/explanation
 * inline). `depth` is 1 for the root passed in, 2 for its children, … so the
 * client can indent without recomputing ancestry.
 */
export interface WorkItemSubtreeDto {
  id: string;
  parentId: string | null;
  kind: WorkItemKindDto;
  key: number;
  identifier: string;
  title: string;
  status: string;
  position: string;
  /** The OBSOLESCENCE mark (MOTIR-6582) — carried so the AI `get-subtree` read's
   *  rows say whether each node is still current. `null` when unmarked. */
  obsolescence: WorkItemObsolescenceDto | null;
  depth: number;
}

/**
 * The optional filter `workItemsService.getProjectTree` (Subtask 2.5.1, the
 * multi-select facets of the 2.5.4 filter bar) applies to the project forest.
 * Every field is optional; an absent / empty field is "don't filter on this
 * axis", so an all-empty filter ({}) returns the full tree.
 *
 * Each faceted axis is a SET (OR within the facet, AND across facets) — Jira's
 * basic filters, the mirror product, are multi-select, and the filter-bar design
 * (`design/work-items/filter.mock.html`) draws multiple kinds / statuses /
 * assignees selected at once. So `kinds` matches "any of these kinds", `statuses`
 * "any of these status keys", and the assignee facet is the union of
 * `assigneeIds` (specific members) with `includeUnassigned` — the MEANINGFUL
 * "Unassigned" bucket (items with a null `assigneeId`), distinct from an empty
 * assignee facet ("any assignee"). `text` is a single case-insensitive substring
 * matched against BOTH `identifier` and `title`; an empty/whitespace-only string
 * is treated as absent.
 *
 * The matching is context-preserving at the service layer: a node that matches
 * retains its ancestor chain so the tree stays navigable (see `getProjectTree`),
 * rather than a flat `WHERE` that would orphan children.
 */
export interface ProjectTreeFilter {
  kinds?: WorkItemKindDto[];
  /** The work-item TYPE facet (the 6.15 quick-filter facet) — match any of these
   * `WorkItemType` members. */
  types?: WorkItemTypeDto[];
  /** Include items with NO work type (the "Untyped" null bucket), OR-ed with `types`. */
  includeUntyped?: boolean;
  statuses?: string[];
  assigneeIds?: string[];
  /** Include items with NO assignee (the "Unassigned" bucket), OR-ed with `assigneeIds`. */
  includeUnassigned?: boolean;
  text?: string;
  /**
   * The advanced filter builder's AST (Story 6.1 · 6.1.1) — validated against
   * the operator registry at the service boundary (typed 422s on unknown
   * field/operator ids or bad values), AND-ed with the facet axes above. The
   * facets remain the quick path; this is the superseding rich shape.
   */
  ast?: FilterAst;
}

/**
 * A node of the project issue-tree (Subtask 2.5.1) — the wire shape backing
 * the `/items` list view's tree-table (Story 2.5). Unlike the flat
 * `WorkItemSubtreeDto`, this nests: each node carries its `children` (same
 * `key`-asc order as the roots). Per-row render fields the tree-table shows —
 * `kind` (its type icon hue), `identifier`, `title`, `status` (the status
 * pill), `assigneeId` (the assignee cell) — plus `depth` (1 for roots, for
 * indentation) and `hasChildren` (drives the expand chevron — true iff this
 * node has at least one child IN THE RETURNED forest).
 *
 * `matched` reflects the active filter: it is `true` for a node that itself
 * matched the filter (or for EVERY node when no filter is active), and `false`
 * for a node retained ONLY because a descendant matched — those ancestor rows
 * render muted/non-matching so the tree stays navigable without pretending the
 * ancestor was a hit. `hasChildren` and `children` are always consistent
 * (`hasChildren === children.length > 0`).
 */
export interface WorkItemTreeNodeDto {
  /** See {@link WorkItemListItemDto.childrenHidden} — a Visitor's private epic. */
  childrenHidden?: true;
  id: string;
  parentId: string | null;
  kind: WorkItemKindDto;
  /** The NATURE of the leaf's work (Story 2.7) — `code`/`design`/… — surfaced as
   *  the row Type chip (Subtask 8.8.9). `null` on containers (epic/story), which
   *  carry no work type; the row renders a muted em-dash there. */
  type: WorkItemTypeDto | null;
  key: number;
  identifier: string;
  title: string;
  status: string;
  /** The item's CI verdict over its whole delivery set (`WorkItem.ciState`,
   *  MOTIR-5470) — `failing` / `running` / `passing` / `null`. The row draws only
   *  `failing` and `running`, and only off the `done` category (`ciBadgeState`,
   *  MOTIR-5474); the raw value travels so every surface applies ONE rule. */
  ciState: string | null;
  /** Why the card is stuck until something is repaired (`WorkItem.fixReason`,
   *  MOTIR-6600), or `null`. The row draws the To fix tag off it, and only off the
   *  `done` category (`toFixTagState`, MOTIR-6610); the raw value travels so every
   *  surface applies ONE rule. */
  fixReason: WorkItemFixReasonDto | null;
  /**
   * The HEAD of the To fix entry this card is carried by (MOTIR-7589), when it is not
   * the head itself — the tag's name gains *· with {head}*. Absent otherwise.
   */
  fixHeadKey?: string;
  // The remaining core properties the list row shows alongside status/assignee
  // (the same fields the detail page's core-fields panel carries): priority,
  // reporter, due date, estimate. `reporterId` is always set; `dueDate` is a
  // wire-safe ISO-8601 string (or null); `estimateMinutes` is whole minutes.
  priority: WorkItemPriorityDto;
  assigneeId: string | null;
  reporterId: string;
  dueDate: string | null;
  estimateMinutes: number | null;
  /** The agile STORY-POINT estimate (Story 4.3.4) — the inline `EstimateBadge`
   *  renders it (or the time estimate / nothing) per the project statistic. */
  storyPoints: number | null;
  /** ISO-8601 last-modified stamp — the `expectedUpdatedAt` an inline edit
   *  (Subtask 2.5.5) submits for optimistic concurrency on `updateIssueAction`. */
  updatedAt: string;
  /** Does the node carry a non-empty description (MOTIR-2098)? The LEAF face of
   *  the shared Plan / Re-plan rule — see {@link WorkItemListItemDto}. Carried
   *  here too because the FILTERED tree renders from these nodes, not from
   *  `WorkItemTreeRowDto`, and both views share one row shaper. */
  hasDescription: boolean;
  /** The OBSOLESCENCE mark + note (MOTIR-6579) — carried for the same reason as
   *  `hasDescription`: the filtered tree renders from these nodes through the
   *  List's row shaper. `null` when unmarked / no note. */
  obsolescence: WorkItemObsolescenceDto | null;
  obsolescenceNoteMd: string | null;
  depth: number;
  hasChildren: boolean;
  matched: boolean;
  children: WorkItemTreeNodeDto[];
}

/**
 * The done/total progress roll-up for a CONTAINER node on the project roadmap
 * (Subtask 7.19.2) — counted over the container's DESCENDANT LEAF work items
 * (the executable units; a leaf is a node with no children), so a deep epic
 * aggregates every subtask under all its stories WITHOUT double-counting the
 * intermediate story/epic containers.
 *
 * `total` EXCLUDES `cancelled` leaves (a sealed "won't do / duplicate" — the
 * same exclusion the public roadmap applies via `ROADMAP_EXCLUDED_DONE_KEY`),
 * so a container whose only remnants are cancelled is not held permanently
 * below 100%. `done` counts the leaves whose status is a `done`-category
 * workflow status OTHER than `cancelled`. A container with no countable leaves
 * (empty, or all-cancelled) is `{ done: 0, total: 0, verified: 0 }` — the view
 * renders an empty meter.
 *
 * `verified` (Subtask 7.10.6 / MOTIR-894) is the Story-level "N of M verified"
 * roll-up: the subset of countable descendants whose CI signal is `passing` (a
 * merged-AND-checks-passed leaf). It rides the SAME recursive count as done/total
 * — a Story is truly done when its children merged AND their checks passed, not
 * merely when they merged. `verified ≤ total`, and is 0 until CI feeds a signal
 * back.
 */
export interface RoadmapProgressDto {
  done: number;
  total: number;
  verified: number;
}

/**
 * A per-container PROGRESS roll-up (Subtask 7.20.6 / MOTIR-1013) — the done /
 * total descendant counts the roadmap draws as a thin meter on an epic / story
 * node. `total` is every non-archived descendant whose status is NOT the sealed
 * `cancelled` key; `done` is the subset in a `done`-category status (also
 * excluding `cancelled`) — so a container whose only remnants are cancelled is
 * not held permanently incomplete (mirrors the public roadmap meter). Computed
 * over the WHOLE subtree in one recursive-CTE round-trip, NOT a per-level read.
 * `verified` is the CI-passed subset (Subtask 7.10.6 / MOTIR-894), on the same
 * round-trip.
 */
export interface RoadmapProgressDto {
  done: number;
  total: number;
  verified: number;
}

/**
 * One node of the project ROADMAP (Subtask 7.20.4 / MOTIR-1010) — the epic →
 * story → subtask tree the planning canvas (MOTIR-1194) renders ONE LEVEL at a
 * time. A trimmed sibling of {@link WorkItemTreeNodeDto}: only the fields a
 * roadmap node draws (no priority / assignee / estimate / filter metadata), plus
 * the per-node `isDone` flag and, on containers, a `progress` roll-up.
 *
 * Roots and every sibling set come back `key`-asc (the stable PROD-N order).
 * `progress` is non-null EXACTLY on container nodes (those with `hasChildren` —
 * epics and stories, plus any task that has subtasks); leaves carry `null`
 * (Subtask 7.20.6 / MOTIR-1013). `isDone` is `true` when the node's OWN `status`
 * resolves to a `done`-category status other than `cancelled` (the node's
 * status, independent of its meter).
 */
export interface RoadmapNodeDto {
  /** A Visitor's PRIVATE epic (MOTIR-6644, `epic-privacy.md` §4): its level is
   *  withheld, so it has no drill and no progress. Absent on every member read. */
  childrenHidden?: true;
  id: string;
  parentId: string | null;
  kind: WorkItemKindDto;
  type: WorkItemTypeDto | null;
  /** WHO executes the work (Story 2.7) — `coding_agent` / `human` / `null`.
   *  Carried alongside `type` so the canvas node can flag a human-gated item
   *  (`executor === 'human' || type === 'manual'`, the shipped `isManualReadyItem`
   *  predicate; MOTIR-1642 / 8.8.36). `null` on a container kind or untyped leaf. */
  executor: ExecutorDto | null;
  key: number;
  identifier: string;
  title: string;
  status: string;
  /** The status's own DISPLAY LABEL, from the project's workflow (bug MOTIR-3170).
   *  The canvas chip used to name a status out of the `labels.defaultStatus`
   *  catalog alone, which by construction has no entry for a project's CUSTOM
   *  status — so the identity has to travel on the wire beside the key. Falls
   *  back to the raw key for a row pointing at a status the workflow no longer
   *  holds. */
  statusLabel: string;
  /** The status's lifecycle CATEGORY (bug MOTIR-3170) — the chip's fallback tone
   *  when the renderer has no treatment for the key itself, exactly as
   *  `statusPillTone` / `statusElVar` fall back. `null` only for a row whose
   *  status is not in the project's workflow at all. */
  statusCategory: StatusCategoryDto | null;
  /** This node's OWN done-ness (a `done`-category status other than `cancelled`). */
  isDone: boolean;
  /** Has at least one non-archived child → the canvas can DRILL into it. Computed
   *  lazily (an `EXISTS`), so the read never loads the subtree. */
  hasChildren: boolean;
  /** The subtree done/total roll-up — non-null EXACTLY on container nodes
   *  (`hasChildren`), `null` on leaves (Subtask 7.20.6 / MOTIR-1013). */
  progress: RoadmapProgressDto | null;
  /** READY TO START (MOTIR-1417): the node is in a startable (`todo`-category)
   *  status AND every item it is `blocked_by` is done — the dispatch-ready
   *  condition (the shipped own-blocker readiness). Drives the "ready" highlight.
   *  A done / in-progress / open-blocked node is `false`. */
  ready: boolean;
  /** Whether the node is itself a member of the ACTIVE sprint (MOTIR-1379
   *  follow-up). In SPRINT scope the root level shows only in-sprint members, but
   *  drilling into a committed root reveals its WHOLE subtree — including children
   *  the sprint did not commit to. This flag lets the canvas render such a
   *  drilled-in NON-member differently ("not in sprint"), so a committed unit is
   *  visually distinct from the rest of its subtree. Always `true` for a shown root
   *  member; `false` for a non-member descendant. In PROJECT scope no sprint is
   *  resolved, so this is always `false` (the whole-project view ignores it). */
  inActiveSprint: boolean;
}

/**
 * One `is_blocked_by` dependency EDGE on the roadmap (Subtask 7.20.2 /
 * MOTIR-1194): `blockedId` cannot start until `blockerId` is done. The canvas
 * draws these between visible nodes — a within-parent arrow, or the cross-parent
 * "bad-plan" flag when the two ends sit under different parents. Only edges whose
 * BOTH ends are in this project's forest are returned (a cross-project blocker is
 * dropped — there is no node to anchor it to).
 */
export interface RoadmapEdgeDto {
  blockedId: string;
  blockerId: string;
  /**
   * What the canvas draws for an OFF-LEVEL edge (MOTIR-6359; design
   * `design/roadmap/design-notes.md` § "Covered cross-parent edges"): `uncovered`
   * and `cross_level` are INVALID and flagged "blocked elsewhere"; `covered` is
   * valid and drawn one level up, so nothing is drawn here; `exempt` is valid with
   * no level above to draw it, so it keeps a neutral anchor. Set only on an
   * off-level edge in PROJECT scope — absent on a within-level edge, in sprint
   * scope, and from an older server, where the canvas keeps its old treatment.
   */
  coverage?: EdgeDisposition;
}

/**
 * A stub for an OFF-LEVEL blocker (Subtask 7.20.2 / MOTIR-1331). When an edge's
 * blocker is not in the current level, the canvas anchors a red "cross-story" edge
 * to a chip NAMING it — its `identifier` + `title` + the container it lives in
 * (`parentTitle`). Only blockers NOT on this level appear here.
 */
export interface RoadmapBlockerStubDto {
  id: string;
  identifier: string;
  title: string;
  parentTitle: string | null;
  /** The blocker's EFFECTIVE folder path, root first — its own folder, else its
   *  root ancestor's — or `null` for an unfiled chain (Bug MOTIR-5710 ·
   *  MOTIR-5739). The ghost anchor names this door in place of the parent line. */
  folderPath: string[] | null;
  /** Whether the blocker is in a terminal (`done`-category) status — a done
   *  dependency is SATISFIED, so the sprint-scoped view does not flag it
   *  (MOTIR-1379). */
  isDone: boolean;
  /** Whether the blocker is a member of the ACTIVE sprint. In sprint scope this
   *  separates an in-sprint dependency (fine) from one OUTSIDE the sprint (the
   *  sprint-validity signal, replacing "cross-story"). Always `false` in project
   *  scope (no sprint is resolved). */
  inActiveSprint: boolean;
}

/**
 * A blocker that IS a member of this level and that the level read did not return
 * (bug MOTIR-5043) — the level is capped at `TREE_LEVEL_MAX_TAKE`, key-ASCENDING,
 * so a level with more children than the cap silently drops its highest keys, and
 * a blocker among them is a plain SIBLING of the row it blocks.
 *
 * It carries no naming fields, and that is the point: there is no node on screen
 * for it and nothing to anchor a chip to, so the canvas draws nothing. What the
 * canvas needs is only to know that this blocker is NOT the cross-story tangle —
 * every off-level effect (the red `cross` arrow, the `blocked elsewhere` flag on
 * the dependent, the ghost anchor) is a verdict about a plan, and about this
 * blocker it would be false. The reader is already told rows are missing by the
 * level's own "+ N more" truncation tile, which is the honest signal for it.
 *
 * `isDone` is `status === 'done'` — the WITHIN-level arrow's own predicate, not the
 * terminal (`done`-category, `cancelled`-inclusive) set the off-level stub carries.
 */
export interface RoadmapLevelMemberBlockerDto {
  id: string;
  isDone: boolean;
}

/**
 * ONE LEVEL of the project roadmap (Subtask 7.20.4 re-plan, MOTIR-1010): the
 * roots (`parentId = null`) OR one parent's direct children, each with a lazy
 * `hasChildren` drill flag, PLUS the `is_blocked_by` {@link RoadmapEdgeDto}s FROM
 * those nodes. The canvas (MOTIR-1194) displays one level at a time and fetches
 * the next on drill — so the read is per-level (reusing `findProjectTreeLevel`),
 * never a whole-tree round-trip (mistake #91). Each container node ALSO carries a
 * subtree `progress` roll-up (Subtask 7.20.6 / MOTIR-1013) — one extra recursive
 * count over the level's containers, not a whole-tree load. An empty level →
 * `{ nodes: [], edges: [] }`.
 */
/**
 * A FOLDER on a roadmap level (Bug MOTIR-5710 · MOTIR-5738,
 * `design/roadmap/design-notes.md` § *A FOLDER on the canvas*). A folder carries
 * no workflow, so it has none of a node's status, readiness or progress — only
 * its name, its place and its DIRECT contents (decision 3: not recursive, not a
 * status tally). It is never an edge end.
 */
export interface RoadmapFolderDto {
  id: string;
  parentFolderId: string | null;
  name: string;
  position: string;
  /** Folders filed directly inside this one. */
  childFolderCount: number;
  /** Work items filed directly inside this one — archived and triaged excluded. */
  itemCount: number;
}

export interface ProjectRoadmapDto {
  nodes: RoadmapNodeDto[];
  edges: RoadmapEdgeDto[];
  /** Stubs for the edges' blockers that are NOT on this level (the cross-story
   *  anchors the canvas draws the red signal to). Empty when the level is a clean
   *  tree (every blocker is an on-level sibling). */
  offLevelBlockers: RoadmapBlockerStubDto[];
  /**
   * Blockers this level HAS but the read could not carry — the rows
   * {@link RoadmapLevelMemberBlockerDto} describes (MOTIR-5043). They are NOT in
   * {@link offLevelBlockers}, because they are not off the level: the cap dropped
   * them. Empty on any level that fits under the cap, which is the ordinary case.
   */
  levelMemberBlockers: RoadmapLevelMemberBlockerDto[];
  /**
   * How many rows this level actually HAS, independent of how many `nodes`
   * carries (MOTIR-3490). The level read is capped, and until this field existed
   * the cap was SILENT: the canvas drew 200 nodes and had no way to know a 201st
   * row was dropped — key-ascending, so the rows lost were the newest epics. The
   * canvas compares this against `nodes.length` and draws its "+ N more" tile
   * when they differ; equal counts render nothing, which is the ordinary case.
   *
   * Counted with the SAME predicate as the read, sprint arm included, so
   * "Showing N of M" is a statement about this level rather than about the
   * project. Absent on a level served synthetically by the client (the grouped
   * node's, the pre-plan stations') — nothing was read, so nothing was capped.
   */
  levelTotal: number;
  /**
   * The level's FOLDERS, in position order (Bug MOTIR-5710 · MOTIR-5738) —
   * present ONLY when the caller asked for the folder treatment and it applies
   * (project scope, no explicit id set). Absent otherwise, so every read that
   * does not ask is byte-for-byte what it was. Never capped: a level's folders
   * are read whole (decision 4), and `levelTotal` counts work items only.
   */
  folders?: RoadmapFolderDto[];
}

/**
 * One row of the flat, sortable List view (Subtask 2.5.8) — the same per-item
 * render fields as a tree node, but WITHOUT the tree metadata (`depth` /
 * `hasChildren` / `matched` / `children`). The List is the project's issues
 * un-nested and ordered by the active sort, so there is no hierarchy to carry.
 * `workItemsService.getProjectIssuesList` returns these already sorted; the
 * route shapes them into the SAME `IssueRowData` the tree row uses, so both
 * views render identical cells.
 */
export interface WorkItemListItemDto {
  id: string;
  kind: WorkItemKindDto;
  /** The NATURE of the leaf's work (Story 2.7) — surfaced as the row Type chip
   *  (Subtask 8.8.9); `null` on containers (epic/story) → muted em-dash.
   *  `WorkItemTreeRowDto` / `ArchivedWorkItemDto` inherit it. */
  type: WorkItemTypeDto | null;
  key: number;
  identifier: string;
  title: string;
  status: string;
  /** The item's CI verdict over its whole delivery set (`WorkItem.ciState`,
   *  MOTIR-5470) — `failing` / `running` / `passing` / `null`. The row draws only
   *  `failing` and `running`, and only off the `done` category (`ciBadgeState`,
   *  MOTIR-5474); the raw value travels so every surface applies ONE rule. */
  ciState: string | null;
  /** Why the card is stuck until something is repaired (`WorkItem.fixReason`,
   *  MOTIR-6600), or `null`. The row draws the To fix tag off it, and only off the
   *  `done` category (`toFixTagState`, MOTIR-6610); the raw value travels so every
   *  surface applies ONE rule. */
  fixReason: WorkItemFixReasonDto | null;
  /**
   * The HEAD of the To fix entry this card is carried by (MOTIR-7589), when it is not
   * the head itself — the tag's name gains *· with {head}*. Absent otherwise.
   */
  fixHeadKey?: string;
  priority: WorkItemPriorityDto;
  assigneeId: string | null;
  reporterId: string;
  dueDate: string | null;
  estimateMinutes: number | null;
  /** The agile STORY-POINT estimate (Story 4.3.4) — rendered by the inline
   *  `EstimateBadge` in the List view's Points column. */
  storyPoints: number | null;
  /** A PRIVATE epic's row as a Visitor reads it (MOTIR-6644, `epic-privacy.md`
   *  §4): its children are withheld and its sizing nulled. Absent on every
   *  member read and on every other row. */
  childrenHidden?: true;
  /** ISO-8601 last-modified stamp — the `expectedUpdatedAt` an inline edit
   *  (Subtask 2.5.5) submits for optimistic concurrency on `updateIssueAction`.
   *  `WorkItemTreeRowDto` inherits it for the lazy Tree's inline edits. */
  updatedAt: string;
  /**
   * Does the item carry a non-empty description (MOTIR-2098)? A BOOLEAN, never
   * the body — the list/tree reads project `descriptionMd IS NOT NULL AND <> ''`
   * so a row costs one byte, not a Markdown blob.
   *
   * It exists for the shared Plan / Re-plan rule's LEAF face (`planEntranceFace`
   * rule 2 — a leaf WITH a description offers Re-plan, without one Plan), which
   * the `/items` row ⋯ menu had to degrade past while no list row carried a
   * description signal. An empty string counts as NO description (what an
   * emptied editor writes). `WorkItemTreeRowDto` / `ArchivedWorkItemDto` /
   * `WorkItemKeysetItemDto` inherit it.
   */
  hasDescription: boolean;
  /**
   * The OBSOLESCENCE mark + its note (Story MOTIR-6574 · MOTIR-6579) — `null`
   * when unmarked / no note. Projected by every list/tree/archived/keyset read
   * (`$queryRaw` is an unchecked cast, so each SELECT names both columns).
   * `WorkItemTreeRowDto` / `ArchivedWorkItemDto` / `WorkItemKeysetItemDto`
   * inherit them.
   */
  obsolescence: WorkItemObsolescenceDto | null;
  obsolescenceNoteMd: string | null;
}

/**
 * One server-paged page of the flat List (Subtask 2.5.12, finding #57): the
 * page's `items` (≤ `pageSize`), the `total` count of the CURRENTLY FILTERED set
 * (so the "1–50 of N" range tracks the 2.5.4 filter), the 1-based `page` (already
 * clamped to the last page when the request overshot), and the `pageSize`
 * constant. The List is `LIMIT/OFFSET`-paged — it never ships the whole backlog.
 */
export interface PagedIssueListDto {
  items: WorkItemListItemDto[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * A row of the KEYSET-paged project read (Story 11.2 · Subtask 11.2.3) — the
 * flat List row plus the two halves of its keyset POSITION.
 *
 * `id` and `createdAt` are here because the caller has to mint the cursor for
 * the next page from the last row it received, and that cursor is
 * `{ createdAt, id }`. They are the page ADDRESSING, which is exactly what the
 * ADR's Amendment 1 carve-out permits — `WorkItemListItemDto` itself is
 * untouched, so the `/items` view's wire shape is unchanged.
 *
 * `createdAt` is a `Date` rather than an ISO string: it is a sort key the caller
 * encodes, not a field it renders, and round-tripping it through a string would
 * lose sub-millisecond precision that the tuple comparison depends on.
 */
export interface WorkItemKeysetItemDto extends WorkItemListItemDto {
  id: string;
  createdAt: Date;
}

/**
 * The actor who archived a work item (Subtask 2.9.2), resolved from the latest
 * `'archived'` revision — Avatar · name, the same shape the activity feed and
 * comment author use. `name` / `image` are nullable so a deleted-but-restricted
 * referent renders a "former member" fallback instead of crashing the view; the
 * `id` is always kept. The whole object is `null` when no `'archived'` revision
 * resolved an actor.
 */
export interface ArchivedByActorDto {
  id: string;
  name: string | null;
  image: string | null;
}

/**
 * One row of the ARCHIVED items view (Story 2.9 · Subtask 2.9.2) — a flat List
 * item PLUS the archive metadata the management surface shows and restores from:
 * the `archivedAt` ISO stamp (the list's sort key) and the `archivedBy` actor.
 * Archived items are a FLAT set (archive is single-node — no cascade), so there
 * is no tree metadata, exactly like {@link WorkItemListItemDto}.
 */
export interface ArchivedWorkItemDto extends WorkItemListItemDto {
  /** ISO-8601 soft-delete instant — the list is ordered most-recent first. */
  archivedAt: string;
  /** Who archived it (latest `'archived'` revision), or `null` if unresolved. */
  archivedBy: ArchivedByActorDto | null;
}

/**
 * One server-paged page of the archived view (Subtask 2.9.2) — the same paging
 * envelope as {@link PagedIssueListDto}: the page's `items` (≤ `pageSize`), the
 * `total` archived count, the 1-based `page` (clamped to the last page when the
 * request overshot), and the `pageSize`. LIMIT/OFFSET-paged — never the whole
 * archive at once.
 */
export interface PagedArchivedWorkItemsDto {
  items: ArchivedWorkItemDto[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * One node of a LAZY tree level (Subtask 2.5.13, finding #57) — the same render
 * fields as a flat List item PLUS `parentId` (placement) and `hasChildren`
 * (drives the expand chevron without pre-loading the subtree). Returned by
 * `listRootIssues` / `listChildIssues`; the client (2.5.14) fetches one level at
 * a time on expand rather than the whole forest.
 */
export interface WorkItemTreeRowDto extends WorkItemListItemDto {
  parentId: string | null;
  hasChildren: boolean;
}

/**
 * A FOLDER row in a lazy tree level (Story MOTIR-5308 · MOTIR-5314) — a named,
 * nestable place that carries no workflow, so it has none of a work item's cells.
 * `kind: 'folder'` is the discriminant: no work-item kind is called that.
 *
 * `parentId` is ALWAYS `null` and is present so the row answers the same
 * placement question a work-item row does: a folder never sits under a work
 * item. Its own container is `parentFolderId`.
 */
export interface FolderTreeRowDto {
  kind: 'folder';
  id: string;
  parentId: null;
  parentFolderId: string | null;
  name: string;
  position: string;
  /** A child folder, or a filed work item that is neither archived nor in triage. */
  hasChildren: boolean;
}

/** One row of a lazy tree level: a folder, or a work item. */
export type ProjectTreeRowDto = FolderTreeRowDto | WorkItemTreeRowDto;

/**
 * One page of a lazy tree level: the level's rows + `hasMore` (another page
 * exists — drives "Load more children") + `total` (the level's FULL child
 * count, regardless of paging). `hasMore` is the `take + 1` probe; `total` is a
 * cheap COUNT the tree render (2.5.14) needs for an honest `aria-setsize` (a row
 * announces "19 of 128" even when only a window is loaded) + the "Showing 50 of
 * 128" affordance.
 */
export interface TreeLevelDto {
  /**
   * Inside a folder: its folders (by position), then its work items (by the
   * active sort). At the project root: its epics, then its folders, then its
   * other work items (MOTIR-5550).
   */
  rows: ProjectTreeRowDto[];
  hasMore: boolean;
  total: number;
  /**
   * The level's WORK-ITEM count, its folders excluded — set on a level that can
   * hold folders (the project root, or one folder) and absent on a work item's
   * children, which hold none. The /items first-run rule reads the root's: the
   * unfiltered Tree shows its empty state when it is zero, whatever folders the
   * root holds (MOTIR-5541, `design/work-items/design-notes.md` § `/items` first run).
   */
  workItemTotal?: number;
}

/**
 * Input to `workItemsService.createWorkItem` (Subtask 1.4.4). The reporter is
 * taken from the ServiceContext (`ctx.userId`), and key / identifier /
 * position are allocated by the service — so none of those appear here. The
 * caller supplies the content + placement. `kind` and `projectId` are fixed
 * at creation (both immutable thereafter). Omitted optional fields fall back
 * to the column defaults (status='open', priority='medium',
 * explanationSource='user_authored'). `dueDate` is an ISO-8601 string on the
 * wire; the service converts it to a Date.
 */
/**
 * Work-item PROVENANCE write input (Story MOTIR-1685) — the structured param the
 * create service accepts to stamp how the item was planned / implemented. Each
 * triple's `source` is server-set at the write-seam (never taken from untrusted
 * client input); `harness`/`model` are the self-reported free-text values.
 * Omitting a sub-object leaves those columns null (the no-op default).
 */
export interface WorkItemPlanningProvenanceInput {
  source: WorkItemPlanningSourceDto;
  harness?: string | null;
  model?: string | null;
}
export interface WorkItemImplementationProvenanceInput {
  source: WorkItemImplementationSourceDto;
  harness?: string | null;
  model?: string | null;
}
export interface WorkItemProvenanceInput {
  planning?: WorkItemPlanningProvenanceInput;
  implementation?: WorkItemImplementationProvenanceInput;
}

/**
 * The `sections` input of a work-item write (Story MOTIR-9023 · MOTIR-9031): the
 * card's sections as separate typed values, rendered into `descriptionMd` by the
 * service. On an UPDATE it is a SPARSE patch at the section key — an omitted
 * section is kept, an explicit `null` clears it, a list replaces the list. A
 * write input only: nothing structured is stored and no read returns it.
 */
export type WorkItemSectionsInput = { [K in keyof WorkItemSections]?: WorkItemSections[K] | null };

export interface CreateWorkItemInput {
  projectId: string;
  /**
   * Sections to render into `descriptionMd` (MOTIR-9031). Checked against the
   * registry for `kind` × `type`; a missing, unknown or invalid section is
   * `InvalidSectionsError`, and `sections` beside `descriptionMd` is
   * `SectionsWithDescriptionError`. Omitted, `descriptionMd` is stored as sent.
   */
  sections?: WorkItemSectionsInput;
  /**
   * The language this write's text is in (Story MOTIR-7731 · MOTIR-8096):
   * `language` for every text field written, `languages` per field (wins).
   * Omitted, a written field records the organisation's content language. A
   * code outside the eleven locales is `InvalidWorkItemLanguageError` (422).
   */
  language?: Locale;
  languages?: Partial<Record<WorkItemLanguageField, Locale>>;
  /**
   * `'unrecorded'` stores NULL as the language of every field this write
   * touches, whatever `language` / `languages` say (MOTIR-8097). For a writer
   * that cannot vouch for the text's language — an import. Absent, the rule
   * above applies.
   */
  languageRecording?: 'unrecorded';
  parentId?: string | null;
  /**
   * File the new item straight into a folder of the SAME project (Story
   * MOTIR-5310 · MOTIR-5407) — it is created with `parentId` null, appended
   * last at that folder's level. Any kind may be filed, `subtask` included.
   * Supplying it together with `parentId` is `PlacementConflictError` (422); an
   * unknown or other-workspace folder is `FolderNotFoundError` (404), another
   * project's is `CrossProjectFolderError` (422). Omitted / null → not filed.
   */
  folderId?: string | null;
  kind: WorkItemKindDto;
  title: string;
  descriptionMd?: string | null;
  explanationMd?: string | null;
  explanationSource?: WorkItemExplanationSourceDto;
  assigneeId?: string | null;
  priority?: WorkItemPriorityDto;
  dueDate?: string | null; // ISO 8601
  estimateMinutes?: number | null;
  /**
   * The story-point estimate (Story 4.3 · exposed on create in 7.8.21). The
   * single `storyPoints` Decimal(6, 2) column — distinct from the TIME estimate
   * (`estimateMinutes`). Validated by the shared `validateStoryPoints` (finite,
   * non-negative, ≤ 9999.99, ≤ 2 decimals) — the SAME rule the UI estimation
   * surface (`estimationService.setEstimate`) enforces, so the agent surface is
   * never stricter or looser than the human one. Omitted → null (unestimated,
   * the column default); `null` is also accepted to be explicit.
   */
  storyPoints?: number | null;
  /**
   * The work-item TYPE (Story 2.7) — leaf-only: supplying it on an epic/story
   * kind is rejected with `TypeNotAllowedOnKindError` (422). When a `type` is
   * supplied WITHOUT an explicit `executor`, the service seeds `executor` from
   * the type→executor default map (`defaultExecutorForType`). Omitted → the
   * column stays null (an untyped leaf), unchanged from pre-2.7.
   */
  type?: WorkItemTypeDto | null;
  /**
   * WHO executes the work (Story 2.7). Overrides the type→executor default
   * when supplied alongside `type`. Setting it on an epic/story kind (or with
   * no type) follows the same leaf-only rule as `type`.
   */
  executor?: ExecutorDto | null;
  /**
   * How HARD the work is to reason about (Story MOTIR-6016). Leaf-only by KIND,
   * as `type` is: a non-null value on an epic/story is rejected with
   * `DifficultyNotAllowedOnKindError` (422). Omitted → the column stays null.
   */
  difficulty?: WorkItemDifficultyDto | null;
  /**
   * The OBSOLESCENCE mark (Story MOTIR-6574 · MOTIR-6579) — accepted on ANY kind
   * (no kind guard, unlike `difficulty`). A value outside the enum is refused
   * with `InvalidObsolescenceError` (422). Omitted → the column stays null.
   */
  obsolescence?: WorkItemObsolescenceDto | null;
  /** The Markdown note beside the mark. Omitted → the column stays null. */
  obsolescenceNoteMd?: string | null;
  /**
   * Pin the repo this item's work ships in (Story 7.9 · MOTIR-1804) — the bare
   * repo NAME, or the `owner/name` ref form (normalized to the name). Validated
   * against the PROJECT's repository set (MOTIR-4955) — a repository connected to
   * the workspace but not linked to the project is rejected with
   * `UnknownTargetRepoError` (422), as is an unknown name. Omitted / null / blank →
   * unpinned, and the dispatch payload falls back to the project's single
   * established repository when that is unambiguous.
   */
  targetRepo?: string | null;
  /**
   * The full repository SET this item's work ships in (Story MOTIR-2725 ·
   * MOTIR-2727, ADR `docs/decisions/work-item-repository-set.md` §1) — ordered,
   * with **element 0 the PRIMARY** that {@link CreateWorkItemInput.targetRepo}
   * mirrors and that dispatch resolves. Each element is a bare repo NAME or the
   * `owner/name` ref form, validated against the same project-scoped domain one
   * pin is validated against; duplicates collapse (first occurrence wins), blank
   * elements are dropped, and the FIRST unknown element is rejected with
   * `UnknownTargetRepoError` (422) — validation is all-or-nothing.
   *
   * ⚠️ MUTUALLY EXCLUSIVE with `targetRepo` (§3.4): the scalar IS this list's
   * first element, so supplying both describes one field twice and raises
   * `ConflictingTargetRepoInputError` (422). Omitted → the set comes from
   * `targetRepo` (a one-element set, or empty); `[]` → the empty set, which is
   * the same state an unpinned card has always been in.
   */
  targetRepos?: string[];
  /**
   * The repository REFERENCES this item's work ships in (Story MOTIR-2732 ·
   * MOTIR-3039, ADR `docs/decisions/work-item-repository-set.md` "Amendment
   * 2026-08-18") — the `project_repository` row ids, ORDERED, element 0 the
   * PRIMARY that dispatch routes to.
   *
   * The reference-native form of the two fields above, and the AUTHORED state
   * once §A7's expand → contract sequence completes: `targetRepo` and
   * `targetRepos` are the NAMES these references resolve to, which is why a
   * repository rename changes what a card displays and nothing about what it
   * points at. An element that is not one of THIS project's repository rows is
   * rejected with `UnknownProjectRepoRefError` (422) — the FIRST one, all-or-
   * nothing, exactly as an unknown name is; duplicates collapse (first occurrence
   * wins).
   *
   * ⚠️ MUTUALLY EXCLUSIVE with BOTH `targetRepo` and `targetRepos` (§3.4, widened
   * to three): they describe one field, so supplying two of them raises
   * `ConflictingTargetRepoInputError` (422) rather than silently picking a winner.
   *
   * A project with NO repository set has no rows to name, so its callers keep
   * sending names — §A7's compatibility rung, unchanged.
   */
  targetRepositories?: string[];
  /**
   * Work-item PROVENANCE (Story MOTIR-1685) — stamp how the item was planned
   * and/or implemented at create time. The stamper subtasks (MOTIR-1689/1691)
   * supply `planning` with a server-set `source`; omitting it leaves all six
   * provenance columns null (a no-op for every existing caller). See
   * docs/decisions/work-item-provenance.md.
   */
  provenance?: WorkItemProvenanceInput;
  /**
   * Create the issue directly INTO a sprint (Subtask 4.2.2 — the backlog /
   * sprint-planning "+ Create issue" row that targets a sprint container). When
   * set, the new issue is born already assigned to this sprint, appended to the
   * sprint's rank tail, in the SAME create transaction — so a quick-create into
   * a sprint is atomic (never created-then-orphaned by a failed follow-up
   * assign). The sprint must exist in the workspace and share the issue's
   * project (the same-project guard `backlogService.assignToSprint` enforces,
   * pulled to create time): a foreign/unknown sprint → `SprintNotFoundError`
   * (404), a cross-project sprint → `CrossProjectSprintAssignmentError` (422).
   * Omitted/null → the issue is born in the backlog (`sprintId IS NULL`),
   * unchanged from Story 1.4 / 4.1.4.
   */
  sprintId?: string | null;
  /**
   * Links to create ATOMICALLY with the issue (Subtask 2.4.10 — the create
   * modal's "Linked issues" section). Each entry is the user-facing
   * (relationship, target) pair — NOT a directed storage edge — because at
   * create time the new item has no id yet, so the from/to direction can't be
   * resolved by the caller. The service maps each via `relationshipToLink`
   * once the row exists (the single source of truth for the `blocks` flip),
   * and writes the `work_item_link` rows inside the same transaction as the
   * item insert (issue + links commit or roll back together). Omitted/empty →
   * a plain create, unchanged from 1.4.4.
   */
  links?: CreateWorkItemLinkInput[];
  /**
   * Components to assign ATOMICALLY with the issue (Subtask 5.4.3 — the
   * create modal's Components picker). Every id must resolve to a component
   * of the SAME project (unknown / cross-workspace → 404 `ComponentNotFoundError`,
   * another project's → `CrossProjectComponentError` 422), pre-checked before
   * the create transaction so a denied create never burns a work-item key;
   * the join rows are written inside the create transaction (issue +
   * components commit or roll back together, the links rule). Carrying
   * components also arms the verified at-create default-assignee rule: an
   * issue created with components and NO assignee takes the default assignee
   * of its first-alphabetical component that has one (create-time only —
   * later component changes never touch the assignee). Omitted/empty → a
   * plain create.
   */
  componentIds?: string[];
  /**
   * Triage intake (Story 6.11 · Subtask 6.11.4). When set, the new work_item is
   * born in the TRIAGE inbox: the service stamps `triagedAt = now()` and records
   * `submittedByUserId` (the human who submitted it). A triage item is excluded
   * from EVERY normal read — the tree, every board, every list, the ready set,
   * and search — until an admin promotes it (6.11.5); the triage-queue read is
   * the only read that returns it. Created through the SAME `createWorkItem`
   * authority as an ordinary item (one create = one transaction), so a triage
   * submission still allocates a key, records its `created` revision, and runs
   * the kind-parent + access gates. The triage `triageService.createSubmission`
   * caller passes a parentless `bug`/`task` and this marker; omitted → an
   * ordinary create, unchanged.
   */
  triage?: { submittedByUserId: string };
}

/**
 * One pending link collected in the create modal (Subtask 2.4.10): the chosen
 * relationship + the target issue's id. Distinct from {@link LinkWorkItemsInput}
 * (the directed `fromId → toId` storage shape) — here the new item's id isn't
 * known until it's created, so the pair stays in the UI's
 * {@link RelationshipKind} terms and the service resolves direction.
 */
export interface CreateWorkItemLinkInput {
  targetId: string;
  relationship: RelationshipKind;
}

/**
 * Input to `workItemsService.updateWorkItem` (Subtask 1.4.4) — a sparse patch.
 * EVERY field is optional; an absent field (`undefined`) means "leave it
 * untouched", while an explicit `null` clears a nullable column. An empty
 * patch is a no-op (the service returns the current DTO without writing a
 * revision). `projectId` and `kind` are NOT here — both are immutable post-
 * creation. `parentId` IS patchable (a re-parent is validated for same-project
 * + kind before the DB trigger backstops it). `status` is DELIBERATELY ABSENT
 * (Subtask 2.3.6, finding #46): a status change is NOT a free-form patch — it
 * must go through `workItemsService.updateStatus`, the gated 2.2.4 path that
 * validates the transition against the project's workflow. Putting `status`
 * back here re-opens the ungated dual-write hole this Subtask closed. The
 * explanation-source state machine: supplying `explanationMd` while the current
 * source is `ai_draft`, WITHOUT also setting `explanationSource`, auto-
 * transitions the source to `user_edited`.
 */
export interface UpdateWorkItemInput {
  /**
   * Sections to merge over the stored body and render into `descriptionMd`
   * (MOTIR-9031), judged on the card's FINAL kind × type. See
   * {@link WorkItemSectionsInput}. Refused beside `descriptionMd`.
   */
  sections?: WorkItemSectionsInput;
  /**
   * The language this write's text is in (Story MOTIR-7731 · MOTIR-8096):
   * `language` for every text field written, `languages` per field (wins).
   * Omitted, an EDITED field records the organisation's content language. A
   * code outside the eleven locales is `InvalidWorkItemLanguageError` (422).
   */
  language?: Locale;
  languages?: Partial<Record<WorkItemLanguageField, Locale>>;
  /**
   * `'unrecorded'` stores NULL as the language of every field this write
   * touches, whatever `language` / `languages` say (MOTIR-8097). For a writer
   * that cannot vouch for the text's language — an import. Absent, the rule
   * above applies.
   */
  languageRecording?: 'unrecorded';
  parentId?: string | null;
  /**
   * Change the item's FOLDER placement in the same transaction as every other
   * field in the patch (Story MOTIR-5310 · MOTIR-5407), with the semantics of
   * `workItemsService.fileWorkItem`: a folder id files the item (clearing its
   * work-item parent and appending it last at that folder's level); `null`
   * takes it out of its folder to the root, which a subtask may not occupy.
   * Supplying it together with `parentId` is `PlacementConflictError` (422).
   */
  folderId?: string | null;
  // `kind` is now mutable (user directive): changing an issue's type is
  // re-validated against its CURRENT parent and ALL its children via the
  // kind-parent matrix (`assertValidParent`), so a change that would orphan an
  // illegal parent/child pair is rejected (IllegalParentTypeError → 422).
  kind?: WorkItemKindDto;
  title?: string;
  descriptionMd?: string | null;
  explanationMd?: string | null;
  explanationSource?: WorkItemExplanationSourceDto;
  assigneeId?: string | null;
  priority?: WorkItemPriorityDto;
  dueDate?: string | null; // ISO 8601
  estimateMinutes?: number | null;
  /**
   * Patch the story-point estimate (Story 4.3 · exposed on this patch in
   * 7.8.21). Set / change / clear (`null`) the single `storyPoints`
   * Decimal(6, 2) column — distinct from the TIME estimate (`estimateMinutes`).
   * Validated by the shared `validateStoryPoints` (finite, non-negative,
   * ≤ 9999.99, ≤ 2 decimals → `InvalidEstimateError`), the SAME rule the UI
   * estimation path (`estimationService.setEstimate`) enforces. Recorded in the
   * revision diff as `{ storyPoints: { from, to } }` (numeric, not Decimal),
   * sharing the single 'updated' revision with any other field in the patch.
   */
  storyPoints?: number | null;
  /**
   * Patch the work-item TYPE (Story 2.7). Leaf-only — set/changing it on an
   * epic/story is rejected (`TypeNotAllowedOnKindError`, 422). An explicit
   * `null` clears the type. SEED-IF-ABSENT semantics for the executor (the same
   * rule create uses): when `type` is patched to a non-null value, `executor`
   * is NOT supplied, AND the row currently has no executor, the service seeds
   * `executor` from `defaultExecutorForType` — the "first chosen" case from the
   * 2.7.2 ADR. If the row already HAS an executor (a prior override), a bare
   * `type` change never clobbers it.
   */
  type?: WorkItemTypeDto | null;
  /** Patch the executor (Story 2.7) — same leaf-only rule as `type`. */
  executor?: ExecutorDto | null;
  /**
   * Patch the difficulty (Story MOTIR-6016) — set / change / clear (`null`).
   * Leaf-only by KIND: an epic/story may only ever END UP with `null`, so a
   * `kind` change onto a container that keeps a difficulty is refused
   * (`DifficultyNotAllowedOnKindError`, 422) unless this clears it.
   */
  difficulty?: WorkItemDifficultyDto | null;
  /**
   * Patch the OBSOLESCENCE mark (Story MOTIR-6574 · MOTIR-6579) — set / change /
   * clear (`null`) on ANY kind in ANY status, a `done` or archived card included
   * (marking finished work is the field's purpose). A value outside the enum is
   * refused with `InvalidObsolescenceError` (422); re-sending the current value
   * records nothing.
   */
  obsolescence?: WorkItemObsolescenceDto | null;
  /** Patch the mark's Markdown note — set / change / clear (`null`). */
  obsolescenceNoteMd?: string | null;
  /**
   * Patch the repo pin (Story 7.9 · MOTIR-1804): set / change / clear (`null`,
   * or a blank string) the bare repo NAME this item's work ships in. The
   * `owner/name` ref form is accepted and normalized to the name. Validated
   * against the PROJECT's repository set — the SAME rule create uses, so
   * the patch surface is never looser than the create one. Recorded in the
   * revision diff as `{ targetRepo: { from, to } }`, sharing the single 'updated'
   * revision with any other field in the patch.
   */
  targetRepo?: string | null;
  /**
   * Patch the repository SET (Story MOTIR-2725 · MOTIR-2727): replace it
   * wholesale with this ordered list, or clear it with `[]`. Same validation,
   * same de-duplication, same all-or-nothing rule as the create shape, and the
   * same mutual exclusion with `targetRepo` — the patch surface is never looser
   * than the create one.
   *
   * A REORDER is a real change and is recorded as one: element 0 is the
   * repository dispatch routes to, so `[a, b]` → `[b, a]` moves where an agent
   * runs. Recorded in the revision diff as `{ targetRepos: { from, to } }`
   * alongside `{ targetRepo: { from, to } }` when the primary moved too — the
   * two columns always move together, because the scalar is derived from the
   * list and must never describe a different repository than its first element.
   */
  targetRepos?: string[];
  /**
   * Patch the repository REFERENCES (Story MOTIR-2732 · MOTIR-3039): replace them
   * wholesale with this ordered list of `project_repository` row ids, or clear
   * them with `[]`.
   *
   * Same validation, same de-duplication, same all-or-nothing rule and the same
   * mutual exclusion — now three-way — as the create shape; the patch surface is
   * never looser than the create one. A REORDER is a real change for the same
   * reason it is on the name path: element 0 is where dispatch routes.
   *
   * The references are the AUTHORED state, so a patch through this field and a
   * patch through `targetRepos` reach the same place; what differs is whether the
   * caller is naming a ROW (stable across a rename) or a NAME (not).
   */
  targetRepositories?: string[];
}

/**
 * Placeholder forward-compatibility type. The work_item_revision table and
 * its mapper land in Subtask 1.4.6 (revision audit). The DTO shape is fixed
 * here now so downstream consumers (Epic 5's activity feed, Epic 7's
 * "what changed since last planning pass") can type against it before the
 * table exists. `diff` mirrors the planned `{field: {from, to}}` JSON shape.
 */
export interface WorkItemRevisionDto {
  id: string;
  workItemId: string;
  changedById: string;
  changedAt: string;
  changeKind: 'created' | 'updated' | 'archived' | 'unarchived' | 'comment_deleted' | 'deleted';
  diff: Record<string, { from: unknown; to: unknown }>;
}

/** The per-item outcome of a `complete_session` bulk close-out (Subtask 7.8.11):
 *  `completed` (transitioned to done), `already_done` (was already in a done
 *  status — a no-op, idempotent), or `failed` (the move was rejected — e.g. an
 *  illegal transition or an unknown done status in a custom workflow; `reason`
 *  carries the typed error message). */
export type CompleteSessionOutcome = 'completed' | 'already_done' | 'failed';

export interface CompleteSessionItemResultDto {
  /** The `PROD-<n>` identifier of the recorded item. */
  key: string;
  outcome: CompleteSessionOutcome;
  /** Present (and only present) on `failed` — the typed error's message. */
  reason?: string;
}

/**
 * The result of `complete_session(sessionBranch)` (Subtask 7.8.11) — the bulk
 * close-out after a human merges the session PR. Every work item recorded on the
 * branch is transitioned to done (clearing the branch) in ONE transaction; the
 * per-item `results` surface partial failures (an item whose workflow has no
 * legal path to done) without rolling back the items that DID complete. The
 * legal-transition check runs before any write, so a rejected item leaves the
 * transaction healthy for the rest.
 */
export interface CompleteSessionResultDto {
  sessionBranch: string;
  results: CompleteSessionItemResultDto[];
}

/**
 * The cascade impact of a PERMANENT delete (Story 2.8 · Subtask 2.8.7) — the
 * figures the delete-confirm dialog (2.8.4) reads BEFORE the user confirms, so
 * the irreversible cascade is named in words (not colour alone). `totalCount` is
 * the number of rows the delete removes — the root PLUS every descendant — i.e.
 * the "Delete N items" button magnitude; `descendantCount` is `totalCount − 1`;
 * `byKind` is the per-kind breakdown of the DESCENDANTS only (e.g.
 * `{ subtask: 5, task: 1, bug: 1 }`), the zero-count kinds omitted. A leaf item
 * returns `{ totalCount: 1, descendantCount: 0, byKind: {} }`. This is a READ —
 * the destructive write is `deleteWorkItem` (2.8.2).
 *
 * `liveDescendantCount` + `liveByKind` (Story 2.9 · Subtask 2.9.9) split out the
 * NON-archived descendants the cascade would ALSO destroy. Motir's archive is
 * single-node (archiving a parent never archives its children —
 * `workItemsService.archiveWorkItem`), so an archived parent can still own LIVE
 * descendants on the active boards/lists, and `deleteWorkItem` cascades the WHOLE
 * subtree (`findSubtree`) — permanently destroying those live items too. The
 * archived-item delete-confirm (2.9.10) warns about exactly that count.
 * `liveDescendantCount` is a strict subset of `descendantCount` (the root is
 * excluded from both; archived descendants are in `descendantCount`/`byKind` but
 * not here); `liveByKind` is its per-kind breakdown, zero-count kinds omitted.
 */
export interface WorkItemDeletePreviewDto {
  totalCount: number;
  descendantCount: number;
  byKind: Partial<Record<WorkItemKindDto, number>>;
  liveDescendantCount: number;
  liveByKind: Partial<Record<WorkItemKindDto, number>>;
}

/**
 * Whether a work item is FINISHABLE (Subtask 7.8.23) — the single-item analogue
 * of `SprintValidityDto`. Let `S` = the target + all its descendants (its
 * subtree). The item is VALID ⟺ for every not-`done` item in `S`, every
 * `blocked_by` dependency is satisfied — IN `S`, or (under `loose`) `done`. A
 * blocker INSIDE the subtree is the target's own work and never gates; only an
 * out-of-subtree dependency can. The `condition` (`loose`/`tight`) tunes the
 * out-of-subtree `done` case exactly as for `validate_sprint` (see
 * {@link ValidityCondition}). Reuses {@link SprintBlockerDto} for each blocker:
 * `item` is the in-subtree item gated by out-of-subtree work `blockedBy`.
 */
/**
 * ONE cross-parent `blocked_by` the parents do not carry (Story MOTIR-6015 ·
 * MOTIR-6370): `item` waits on `blockedBy`, the two sit on the same level under
 * DIFFERENT parents, and `itemParent` is not directly `blocked_by`
 * `blockerParent`. The remedy is to wire that parent edge (and, one level up,
 * the same question of it) — `lib/workItems/crossParentCoverage.ts` is the rule.
 */
export interface InvalidEdgeDto {
  item: string;
  blockedBy: string;
  itemParent: string;
  blockerParent: string;
}

/**
 * A `blocked_by` that joins two different LEVELS (MOTIR-6509,
 * `docs/decisions/edge-level-is-position.md` Amendment 2) — two items at
 * different depths below their nearest common ancestor, or an epic paired with a
 * non-epic. The link doors WRITE such an edge (it holds the card out of the ready
 * set like any other); the validators report it here and it makes `valid` false.
 * The remedy — re-wire it to the same-level item really waited on, or between
 * the containers — is a reader's decision, so the verdict names both ends.
 */
export interface CrossLevelEdgeDto {
  /** The blocked item — the end that carries the edge. */
  item: string;
  /** Its blocker, on another level. */
  blockedBy: string;
  /** How many levels below the project root `item` sits (a folder adds none). */
  itemDepth: number;
  /** How many levels below the project root the blocker sits. */
  blockedByDepth: number;
  /** Why the edge is invalid — the user's ruling: the dependency lives elsewhere. */
  reason: 'blocked_elsewhere';
  /** The sentence that explains it, worded by `lib/workItems/edgeLevel.ts`. */
  explanation: string;
}

export interface WorkItemValidityDto {
  /** The validated work item's identifier (e.g. "MOTIR-1337"). */
  key: string;
  /**
   * True ⟺ every in-subtree item's blocked_by closure is satisfied AND no
   * cross-parent edge is uncovered (`invalidEdges` empty, MOTIR-6370) AND no
   * edge crosses levels (`crossLevelEdges` empty, MOTIR-6509). A gate that asks
   * only "can this be finished?" reads `blockers`, never this.
   */
  valid: boolean;
  /** The in-subtree items gated by out-of-subtree, unsatisfied work; empty when valid. */
  blockers: SprintBlockerDto[];
  /**
   * The subset of `blockers` the plan does NOT own (MOTIR-9021) — an edge in place
   * before the plan, on a card still being worked. A WAIT, not a defect: the
   * subtree is finishable once that card lands, so a planner keeps the edge and
   * must not drop it to make the verdict pass. A SUBSET, so `valid` and `blockers`
   * are byte-identical whether or not this is present. Absent when empty, and from
   * the committed verdict.
   */
  waits?: SprintBlockerDto[];
  /**
   * Every same-level `blocked_by` FROM a not-done subtree member whose two ends
   * sit under different parents that carry no matching edge (MOTIR-6370).
   * Empty when every cross-parent edge is covered.
   */
  invalidEdges: InvalidEdgeDto[];
  /**
   * Every `blocked_by` FROM a not-done subtree member to an item on ANOTHER
   * LEVEL (MOTIR-6509) — "blocked elsewhere". Empty when every edge is
   * same-level. A cross-level edge is never also reported in `invalidEdges`.
   */
  crossLevelEdges: CrossLevelEdgeDto[];
  /**
   * PROSE-vs-GRAPH advisories (MOTIR-1969) plus the CONTAINER-COVERAGE family
   * (MOTIR-5362) — a SEPARATE channel from `blockers`, and **never** a blocker.
   * See {@link WorkItemValidityAdvisoryDto}: `valid` and `blockers` are
   * byte-identical whether or not this array is empty.
   */
  advisories: WorkItemValidityAdvisoryDto[];
  /**
   * The target's SOFT blocks (MOTIR-6354 / MOTIR-6368) — every open `blocked_by`
   * edge of an ANCESTOR of the target (parent → … → root), i.e. a block that
   * reaches the target only through the readiness cascade and that a run may
   * override with `--allow-soft-block`. **Never gating**: `valid` and `blockers`
   * ask "can this subtree finish", and are byte-identical whatever this holds.
   * "Open" = the blocker is not in its own project's `done` set (the same
   * done-ness `blockers` judges by). Sorted by `via.key`, then `blockedBy.key`;
   * empty when no ancestor is blocked.
   */
  softBlocks: WorkItemSoftBlockDto[];
  /**
   * Per-card SECTION findings (MOTIR-9032) — the body PARSED against the section
   * registry for the card's kind × type, one entry per not-done subtree card that
   * misses a required section or carries one it cannot read. A SEPARATE advisory
   * channel, **never a blocker**: `valid` and `blockers` are byte-identical
   * whether or not this array is empty. Sorted by `item`; empty when every card
   * reads clean.
   */
  sectionFindings: SectionFindingDto[];
}

/**
 * One card's section finding (MOTIR-9032): what parsing its stored (or
 * projected) body against the registry for its kind × type found missing.
 * Advisory — see {@link WorkItemValidityDto.sectionFindings}.
 */
export interface SectionFindingDto {
  /** The card's identifier (a real key, or the plan item's projected key). */
  item: string;
  /** The card's kind and type — the registry cell its body was read against. */
  kind: string;
  type: string | null;
  /** `unstructured` — the body has no section headings at all (or is empty);
   *  `incomplete` — it has some, and a required one is missing or unreadable. */
  state: 'unstructured' | 'incomplete';
  /** Required sections absent or empty, in registry order. */
  missing: string[];
  /** Sections found but unreadable into their shape, with why. */
  invalid: { section: string; message: string }[];
  /** Headings the body carries that the registry does not define for this cell. */
  otherHeadings: string[];
  /** The parser's diagnostics (`empty`, `no-headings`, `quoted-gutter`, …). */
  signals: string[];
}

/** A `{ key, title }` reference to a work item, as a soft block names one. */
export interface WorkItemKeyTitleDto {
  /** The work item's identifier (e.g. "MOTIR-1337"). */
  key: string;
  title: string;
}

/**
 * One SOFT block on a validated target (MOTIR-6368): the ancestor `via` is
 * `blocked_by` the open item `blockedBy`, whose raw workflow status key is
 * `blockerStatus`. Not a blocker — see {@link WorkItemValidityDto.softBlocks}.
 */
export interface WorkItemSoftBlockDto {
  /** The target's ancestor that owns the `blocked_by` edge. */
  via: WorkItemKeyTitleDto;
  /** The open item the ancestor is blocked by. */
  blockedBy: WorkItemKeyTitleDto;
  /** The blocker's raw workflow status key (e.g. "todo"). */
  blockerStatus: string;
}

/**
 * How strongly a body reference suggests a MISSING `blocked_by` edge
 * (MOTIR-1969) — `advisory` when the not-done item is named anywhere in the
 * body, `likely-missing-edge` when it is named inside the card's own
 * acceptance-criteria section. Mirrors `ProseAdvisorySeverity`
 * (`lib/workItems/proseVsGraph.ts`), which carries the full rationale.
 */
export type WorkItemProseAdvisorySeverityDto = 'advisory' | 'likely-missing-edge';

/**
 * The severity of a SHAPE advisory (MOTIR-2175) — a defect the card asserts
 * about ITSELF, with no second work item involved. Six members: gate 14's
 * ORDERING axis, gate 1's repo column (MOTIR-2177), the ESTIMATION GATE's two
 * sizing ceilings (MOTIR-3110), and the DESIGN gate's degenerate reading — a
 * card that is its own design blocker (MOTIR-3178), and an explicit counted
 * claim about the card's blocker siblings that disagrees with its edges
 * (MOTIR-5428). A sixth, the BODY EDIT sitting above a FIELD MOVE (MOTIR-5399),
 * is the one member read off the card's revision trail rather than its row —
 * and the one named as a fact rather than a `likely-…` defect, because the
 * trail cannot tell a revert from a correction.
 *
 * ⚠️ Only the first two carry the single `criterionIndex` their remedy cuts at.
 * The sizing member is a defect in two of the card's own COLUMNS and has no
 * criterion to point at; the self-blocking-design member has TWO, because its
 * remedy LIFTS one criterion out rather than cutting the list at a line. That is
 * why {@link WorkItemProseShapeAdvisoryBaseDto} carries only what all five share
 * and the single criterion index sits one level down — see
 * {@link WorkItemProseCriterionShapeAdvisoryBaseDto}.
 */
export type WorkItemProseShapeSeverityDto =
  | 'likely-ordering-violation'
  | 'likely-repo-straddle'
  | 'likely-over-gate-sizing'
  | 'likely-self-blocking-design'
  | 'likely-post-merge-child-under-container'
  | 'body-edit-above-field-move'
  | 'likely-blocker-count-mismatch'
  | 'under-authored'
  | 'likely-mislabelled-link';

/**
 * ONE prose-vs-graph advisory (MOTIR-1969): an in-subtree card whose
 * `descriptionMd` NAMES a not-`done` work item it carries no `blocked_by` edge
 * to. Let **N** = the items a body names via `motir:` link tokens and **E** =
 * the items it has a `blocked_by` edge to; one advisory is emitted per member of
 * `N \ E` that is not `done`, not the card itself, and not one of its ancestors.
 *
 * ⚠️ **ADVISORY, NEVER A BLOCKER — the load-bearing design decision.** It does
 * not gate readiness and does not appear as a finishability blocker: a card with
 * advisories is still `valid` / `ready`. A card legitimately names cards it does
 * not depend on (out-of-scope sections, "the owner of the other half is X",
 * context refs, superseded-by notes, sibling record cards), so a hard gate would
 * make almost every well-written card unready and the fix would be to write
 * WORSE card bodies — the opposite of what the corpus wants. That asymmetry is
 * the whole point: it makes the prose-vs-graph gap VISIBLE at authoring time
 * without making it ENFORCEABLE, which matches what the human check actually is.
 *
 * Deliberately shaped like {@link SprintBlockerDto}: `item` is the card whose
 * body names the reference; `referenced` is the far end.
 */
export interface WorkItemProseReferenceAdvisoryDto {
  /**
   * The union discriminant — see {@link WorkItemProseAdvisoryDto}. OPTIONAL and
   * never emitted, because this variant is the wire shape three shipped
   * consumers already read; the tag rides on the NEW variant instead, so
   * widening the union changed no byte of the old one.
   */
  kind?: 'reference';
  /** The in-subtree card whose `descriptionMd` names the reference. */
  item: string;
  /** The referenced item's identifier (or a `planItem:<id>` temp-ref, projected). */
  referenced: string;
  /** The referenced item's raw workflow status key (e.g. `todo`, `in_progress`). */
  referencedStatus: string;
  /** How strongly this reference suggests a missing `blocked_by` edge. */
  severity: WorkItemProseAdvisorySeverityDto;
}

/**
 * What EVERY shape advisory carries (MOTIR-2175): a card whose own ACCEPTANCE
 * CRITERIA are mis-shaped, with no second work item involved anywhere in the
 * finding, plus the 1-based index of the criterion the remedy cuts at.
 *
 * ⚠️ Same channel, same never-a-blocker contract as
 * {@link WorkItemProseReferenceAdvisoryDto} — `valid` / `blockers` and the
 * issue-detail `ready` / `openBlockers` are byte-identical whether or not this
 * is emitted, at EVERY severity. Each member states its own reason why a gate
 * here would be actively harmful.
 */
interface WorkItemProseShapeAdvisoryBaseDto {
  /** The union discriminant — see {@link WorkItemProseAdvisoryDto}. */
  kind: 'shape';
  /** The card that carries the defect. */
  item: string;
  /** Which shape defect this is. */
  severity: WorkItemProseShapeSeverityDto;
}

/**
 * What every CRITERION-shaped member adds (MOTIR-2175 / MOTIR-2177): the 1-based
 * index of the criterion the remedy cuts at.
 *
 * ⚠️ **A second base rather than a field on the first, and NOT an optional
 * field on the first.** `criterionIndex` is the actionable half of these two
 * findings, not decoration, and both number criteria the same way
 * (`criterionRepoPaths` reuses `firstPostMergeCriterion`'s attribution) so a
 * card carrying both can be read against ONE numbering. The sizing member
 * (MOTIR-3110) has no criterion at all — its finding is about two COLUMNS — and
 * making the index optional would weaken it to `number | undefined` for the two
 * members whose remedy IS the number, on a shape the public `/api/v1` schema
 * already publishes as required (`public-api-conventions.md` §8 forbids the
 * nullability change outright). So the split runs the other way: the shared base
 * holds what all three share, and this one holds what the two criterion members
 * add. A renderer reading `.criterionIndex` must narrow to a member that has
 * one — {@link isOrderingAdvisory} / {@link isRepoStraddleAdvisory} already do.
 */
interface WorkItemProseCriterionShapeAdvisoryBaseDto extends WorkItemProseShapeAdvisoryBaseDto {
  /** 1-based index of the offending criterion — where the remedy cuts. */
  criterionIndex: number;
}

/**
 * Gate 14's ORDERING axis, mechanized (MOTIR-2175). A card's boundary ends at
 * *PR opened* (a project's `Project.prMergeMode` is `manual` unless it chose
 * `auto`), so a criterion whose truth requires the merge belongs to a different
 * card and the remedy is to CUT the card at that line. The premise holds until
 * something actually merges on that setting's say-so — Story MOTIR-4882, the
 * merge gate, is what changes it.
 *
 * ⚠️ Never a gate, for a reason specific to this check: a release *cut* card is
 * DEFINED by needing the merge (see `isOrderingCheckExempt`, which suppresses
 * exactly that shape).
 */
export interface WorkItemProseOrderingAdvisoryDto extends WorkItemProseCriterionShapeAdvisoryBaseDto {
  severity: 'likely-ordering-violation';
  /** The gate-14 phrase that matched, in its canonical list form. */
  phrase: string;
}

/**
 * Gate 1's criterion-by-criterion repo column, mechanized (MOTIR-2177) — as a
 * CONTRADICTION, never a count. An acceptance criterion names a repo-qualified
 * path whose owning repo is not the card's `targetRepo`; ONE SUBTASK = ONE REPO
 * = ONE PR, so that criterion cannot be discharged inside the card's own pull
 * request. See {@link reason} for the unpinned arm.
 *
 * ⚠️ Never a gate, for a reason specific to this check too — and a blunter one:
 * a BOUNDARY-CONTRACT card (a producer plus its mirrored consumer, two
 * coordinated PRs, legitimately one card) fires here, knowingly. That accepted
 * false positive costs one line of output precisely BECAUSE the channel never
 * blocks; as a gate it would make a legitimate card unbuildable. It is also why
 * this is the first check to withdraw if advisory fatigue shows.
 *
 * ⚠️ It does NOT cover the bare-SYMBOL form of the same tell (MOTIR-1983's
 * `SHARED_PLANNING_RULES`) — that needs a cross-repo index. Gate 1's prose stays
 * in force; this narrows the prose's job, it does not retire it.
 */
export interface WorkItemProseRepoStraddleAdvisoryDto extends WorkItemProseCriterionShapeAdvisoryBaseDto {
  severity: 'likely-repo-straddle';
  /** The repo-qualified path the criterion names, as it wrote it. */
  path: string;
  /** The repo that path resolves to — never the card's own `targetRepo`. */
  repo: string;
  /**
   * `contradiction` — the card pins `targetRepo` and {@link repo} is not it.
   * `unpinnable` — the card pins nothing and its criteria name two or more
   * distinct repos, so the pin is not merely missing: there is no single value
   * it could take.
   */
  reason: 'contradiction' | 'unpinnable';
}

/**
 * Which of the estimation gate's two ceilings a card crossed (MOTIR-3110) —
 * `both` when it crossed each, because one over-sized card is ONE finding.
 * Mirrors `OverGateThreshold` (`lib/workItems/proseVsGraph.ts`).
 */
export type WorkItemProseSizingThresholdDto = 'story_points' | 'estimate_minutes' | 'both';

/**
 * THE ESTIMATION GATE, mechanized (MOTIR-3110) — a childless `coding_agent` card
 * sized at or above 8 story points, or estimated at more than 70 TOTAL minutes.
 *
 * ⚠️ **Only ONE of those two is the gate's own number** (corrected by
 * MOTIR-3271). `8+` is the gate's literal SPLIT signal, read off the card's own
 * points column. The gate's minutes ceiling is on the AGENT RUN ALONE, excluding
 * CI, while `estimateMinutes` is defined as agent run **plus** CI — so the
 * minutes arm is a PROXY, and `70` is the top of the largest band the gate's
 * calibration table endorses (5 points, ~50–70 total) rather than the hour the
 * rule names. `ESTIMATION_GATE_ESTIMATE_MINUTES` carries the derivation and the
 * residual error classes.
 *
 * ⚠️ A `shape` member and not its own family, unlike
 * {@link WorkItemProseSubsumptionAdvisoryDto}, and the discriminator is what the
 * finding is ABOUT rather than what it carries: this is a defect the card
 * asserts about itself with no second party anywhere in it — the shape family's
 * definition — while a subsumption finding has a far end (a merged pull
 * request). What it does NOT carry is a `criterionIndex`, because its remedy is
 * *split this card*, not *cut it at line N*: see
 * {@link WorkItemProseCriterionShapeAdvisoryBaseDto} for why that lives on a
 * second base rather than becoming optional on the first.
 *
 * ⚠️ **Never a gate, for a reason specific to this check.** A large card is
 * sometimes the honest intermediate state of a re-plan in progress, and gating
 * readiness on it would trade a missed split for a stuck board. Reporting
 * without blocking is the whole design: the size becomes VISIBLE when the author
 * seals the card and when a run claims it, instead of surfacing only when a
 * session opens the description and reads a sentence asking it not to proceed.
 *
 * ⚠️ **No opt-out, deliberately** — no `isOverGateSizingCheckExempt` to match
 * {@link isSubsumptionCheckExempt}. A mute would only re-create the field the
 * plan does not read, and a large card is often the honest intermediate state of
 * a re-plan in progress.
 *
 * ⚠️ **CORRECTED IN PLACE (MOTIR-3271), because the reason given for that
 * absence was wrong.** This paragraph used to read: *"The other two checks have
 * false-positive classes a card can legitimately be in (a boundary contract, a
 * release cut); this one has none. Its input is two integers and an enum, so a
 * card that fires is over the gate, full stop."* **What it was wrong about: one
 * of those two integers is not the integer the rule is about.**
 * `estimateMinutes` sums agent time and CI time; the gate ceilings agent time
 * alone. So the MINUTES arm does have a false-positive class — a short run
 * behind a heavy CI leg — and MOTIR-3239 (5 SP / 65 min, inside the calibration
 * table's own 50–70 band) was a measured member of it under the old `60`
 * threshold. The POINTS arm's half of the claim stands unaltered: `8+` is the
 * gate's literal signal and fires on exactly what the rule names. The remedy
 * chosen was to move the threshold and to SAY the minutes arm is a proxy
 * wherever a finding is rendered — not to add a mute, which would put the
 * answer back into a field nothing reads.
 */
export interface WorkItemProseSizingAdvisoryDto extends WorkItemProseShapeAdvisoryBaseDto {
  severity: 'likely-over-gate-sizing';
  /**
   * Which ceiling(s) the card crossed — and with what authority: `story_points`
   * IS the gate's rule, `estimate_minutes` is a proxy for it (MOTIR-3271).
   */
  threshold: WorkItemProseSizingThresholdDto;
  /** The card's own `storyPoints`, as observed — `null` when unestimated. */
  storyPoints: number | null;
  /**
   * The card's own `estimateMinutes`, as observed — `null` when unestimated.
   * The SUM of agent run time and CI time, which is what makes the minutes arm
   * a proxy rather than the rule.
   */
  estimateMinutes: number | null;
}

/**
 * THE DESIGN GATE'S DEGENERATE READING, mechanized (MOTIR-3178) — a CHILDLESS
 * card one of whose acceptance criteria produces a DESIGN ASSET while another
 * builds the RENDERED SURFACE that drawing decides.
 *
 * The planning-time design gate (`plan-rules/kind-leaf.md`) requires a
 * UI-touching card to be linked to the asset AND to *"the `type: design` subtask
 * that produced (or will produce) it"*. On a card that draws its own design that
 * second link resolves to the card itself — literally satisfied, and Principle
 * #13 exactly inverted: the drawing and the files written to match it arrive in
 * one pull request, approved by one click. MOTIR-3154 was `ready: true`,
 * `openBlockers: []` and `valid: true` in precisely that shape (`notes.html`
 * #329; planning bug MOTIR-3158).
 *
 * ⚠️ TWO criterion indices, which is why this extends the plain base rather than
 * {@link WorkItemProseCriterionShapeAdvisoryBaseDto}. The other criterion members
 * report ONE number because their remedy is a cut — *every criterion below this
 * line belongs to a different card*. This one's remedy is a LIFT: the design
 * criterion becomes its own `type: design` card, and what is left is `blocked_by`
 * it. A reader needs BOTH ends of the inversion to make that move, and reusing
 * the singular field would have named the half they already knew about.
 *
 * ⚠️ **Never a gate, and here the false-positive class is real** (decided on
 * MOTIR-3158). The predicate is lexical over criterion prose, so a card that
 * amends an asset and adjusts the one rendered surface reading it can fire.
 * Blocking would hold such a card out of the ready set with no override — and a
 * card that is its own design blocker is exactly the card a re-plan is in the
 * middle of splitting. The enforcement that must bite already does: `run.md`
 * guard #3 PAUSES a run about to build UI with no drawing. This advisory makes
 * the composition VISIBLE where acting on it is cheap — at seal time and at
 * claim time — instead of leaving a session to work out for itself that the
 * drawing it needs is criterion one of the card in its hand.
 *
 * ⚠️ **CHILDLESS is the condition, not the kind.** A `bug` or `task` that HOLDS
 * children is gated by its subtree — its design child can be reviewed before its
 * code children run — so it is out of scope by construction, exactly as the
 * estimation gate scopes itself by POSITION rather than by kind.
 *
 * ⚠️ **And a `type: design` card is never reported (MOTIR-6245).** It IS the
 * card the LIFT would create, so the remedy is incoherent for it — and its own
 * criteria routinely read as building a surface (panels named by number, a
 * render of the shipped surface before drawing), which the per-criterion asset
 * exclusion cannot see.
 */
export interface WorkItemProseSelfBlockingDesignAdvisoryDto extends WorkItemProseShapeAdvisoryBaseDto {
  severity: 'likely-self-blocking-design';
  /** 1-based index of the criterion whose deliverable is the DESIGN ASSET. */
  designCriterionIndex: number;
  /** 1-based index of the criterion that BUILDS the surface that drawing decides. */
  surfaceCriterionIndex: number;
}

/**
 * A CHILD that can only start after the deployment, laid INSIDE the runnable
 * container whose merge it waits on (MOTIR-8863). The advisory is emitted on the
 * CHILD (`item`), naming the container.
 *
 * ⚠️ A runnable container is ONE deliverable that ends at its pull request; a
 * production check in the middle means TWO containers, the second `blocked_by`
 * the first — not a child of the first. The remedy is placement: lay the child as
 * a sibling the container `blocks`, or split the container. Advisory like its
 * siblings, never a gate; `validate_plan` reports it on the projected tree so a
 * plan can be repaired before approval. A container of kind `epic` is out of
 * scope: a card beside a story is where the remedy puts it.
 */
export interface WorkItemProsePostMergeChildAdvisoryDto extends WorkItemProseShapeAdvisoryBaseDto {
  severity: 'likely-post-merge-child-under-container';
  /** The deployment-reading phrase the child's body carries. */
  phrase: string;
  /** The container (the child's parent) whose merge the child waits on. */
  container: string;
}

/** One end of a {@link WorkItemProseBodyAboveFieldMoveAdvisoryDto}: one revision of the card. */
export interface WorkItemRevisionEndDto {
  /** When the revision was written (ISO-8601). */
  at: string;
  /**
   * The fields it moved that the check reads — the body columns on the edit, the
   * watched fields on the move — never the bookkeeping that shared the row.
   */
  fields: string[];
}

/**
 * A BODY EDIT sitting directly above a FIELD MOVE in the card's own history
 * (MOTIR-5399): the newest write that moved a body (`descriptionMd` /
 * `explanationMd`) moved none of the fields a body describes, and the write
 * beneath it — skipping rows that moved neither — DID move one (`title`, `type`,
 * `executor`, `targetRepo` / `targetRepos`, `kind`, `storyPoints`,
 * `estimateMinutes`).
 *
 * The body was therefore written, or rewritten, AFTER the fields last moved, by a
 * write that did not touch them. MOTIR-4513 is the specimen: re-typed `decision →
 * content`, then a body-only edit put the decision framing back, and `readiness`,
 * `validate_work_item` and every other advisory reported the card healthy until
 * the dispatched run stopped on it (planning bug MOTIR-4577).
 *
 * ⚠️ **A PROMPT TO RE-READ, NOT A DEFECT CLAIM — which is why the severity is not
 * `likely-…`.** Re-typing a card and then rewriting its body to MATCH is the
 * ordinary correction, and it leaves exactly this trail. Telling the two apart
 * needs the prose, which is the comparison this check exists to avoid; so the
 * finding names both writes with their instants and fields, and the reader reads
 * the body against the move.
 *
 * ⚠️ **No criterion index**, like {@link WorkItemProseSizingAdvisoryDto}: the
 * finding is about two WRITES, not a line of the card, so there is nothing to cut
 * at, and a dispatched run PROCEEDS on it (`run.md` guard #4's no-index arm).
 *
 * ⚠️ **Never a gate.** Its false-positive class is the ordinary correction above,
 * and a gate would hold that card out of the ready set with no override.
 */
export interface WorkItemProseBodyAboveFieldMoveAdvisoryDto extends WorkItemProseShapeAdvisoryBaseDto {
  severity: 'body-edit-above-field-move';
  /** The newer write — it moved a body and no watched field. */
  bodyEdit: WorkItemRevisionEndDto;
  /** The write directly beneath it — it moved at least one watched field. */
  fieldMove: WorkItemRevisionEndDto;
}

/** A counted claim about this card's own blockers that disagrees with its edges. */
export interface WorkItemProseBlockerCountAdvisoryDto extends WorkItemProseShapeAdvisoryBaseDto {
  severity: 'likely-blocker-count-mismatch';
  /** The exact normalized prose fragment whose number was checked. */
  claim: string;
  /** The number stated by the card. */
  claimedCount: number;
  /** The number of `blocked_by` edges currently held by the card. */
  blockerCount: number;
}

/**
 * A CHILDLESS card carrying nothing: no enumerated acceptance criterion and null
 * `storyPoints`, `estimateMinutes`, `type` and `executor` (MOTIR-5427).
 *
 * Named as a FACT, not `likely-…`, like {@link WorkItemProseBodyAboveFieldMoveAdvisoryDto}:
 * every input is an absent field, so there is no judgement in it and no
 * false-positive space. What it cannot tell is WHY the fields are absent.
 *
 * ⚠️ **Never a gate, and the reason is the scratchpad.** Plan-rules gate 20 calls
 * such a card UNSEALABLE, which argues for a refusal; a card is also routinely
 * saved mid-authoring, and a refusal would make the tracker unusable as a
 * scratchpad. The advisory channel is the decided answer for every shape family
 * (see {@link WorkItemProseSizingAdvisoryDto}): visible at seal time and at claim
 * time, never in readiness. `docs/decisions/under-authored-shape-family.md`.
 *
 * ⚠️ Childless is the scope, as for the sizing and self-blocking members: gate 20
 * is a leaf bar, so a container is never reported. No criterion index, because
 * the finding is about the ABSENCE of criteria.
 */
export interface WorkItemProseUnderAuthoredAdvisoryDto extends WorkItemProseShapeAdvisoryBaseDto {
  severity: 'under-authored';
  /** Whether the `## Acceptance criteria` heading is missing or just empty. */
  criteria: 'no-heading' | 'no-criterion';
}

/**
 * A `[label](motir:<id>)` link in the card's body whose label names one work-item
 * key while its id opens a different card — or whose id opens no card the reader
 * can see at all (MOTIR-9007).
 *
 * The reader of a body trusts the LABEL and the chip opens the ID, so a mismatch
 * sends them, or an agent dispatched on the card, to the wrong card silently.
 * Every author writing ids from memory makes it, and no other check reads the
 * label. `targetKey` is the card the link really opens, or `null` when the id
 * resolves to nothing — a deleted or invented id, another workspace's, or one in a
 * project the reader cannot browse, which are deliberately indistinguishable so
 * the finding leaks no existence. A label that is a NAME rather than a key is
 * checked only for the `null` arm.
 *
 * ⚠️ Never a gate, like every member: a broken link is a defect in prose, and the
 * card is as finishable with it as without. No criterion index — a link can sit
 * anywhere in the body.
 */
export interface WorkItemProseMislabelledLinkAdvisoryDto extends WorkItemProseShapeAdvisoryBaseDto {
  severity: 'likely-mislabelled-link';
  /** The link's label exactly as written. */
  label: string;
  /** The work-item id the link opens. */
  targetId: string;
  /** The key of the card that id opens, or `null` when it opens none. */
  targetKey: string | null;
}

/**
 * ONE SHAPE advisory — narrowed by {@link WorkItemProseShapeAdvisoryDto.severity}
 * once `kind === 'shape'` has narrowed the outer union.
 *
 * ⚠️ Not every member carries `criterionIndex` since MOTIR-3110, and since
 * MOTIR-3178 one member carries a PAIR of indices under different names —
 * narrow to a SEVERITY before reading either, which the predicates below force.
 */
export type WorkItemProseShapeAdvisoryDto =
  | WorkItemProseOrderingAdvisoryDto
  | WorkItemProseRepoStraddleAdvisoryDto
  | WorkItemProseSizingAdvisoryDto
  | WorkItemProseSelfBlockingDesignAdvisoryDto
  | WorkItemProsePostMergeChildAdvisoryDto
  | WorkItemProseBodyAboveFieldMoveAdvisoryDto
  | WorkItemProseBlockerCountAdvisoryDto
  | WorkItemProseUnderAuthoredAdvisoryDto
  | WorkItemProseMislabelledLinkAdvisoryDto;

/**
 * The severity of a SUBSUMPTION advisory (MOTIR-2903). Named rather than inlined
 * so the family reads like its two siblings and a member cannot arrive without
 * every renderer's `switch` noticing — which is what happened: MOTIR-3230 added
 * the second.
 *
 * The two are OPPOSITE INSTRUCTIONS, not degrees of the same one:
 *  - **`likely-already-shipped`** — a MERGED pull request touched the path. Read
 *    its diff; close this card if the work is subsumed.
 *  - **`likely-in-flight`** — an OPEN pull request is touching the path now. Do
 *    NOT file a second card and do NOT cut a branch off the default branch to
 *    rebuild their half; go and coordinate. Two fixes for one defect are each
 *    green alone and cancel when both merge.
 */
export type WorkItemProseSubsumptionSeverityDto = 'likely-already-shipped' | 'likely-in-flight';

/**
 * A card whose DELIVERABLE MAY ALREADY BE IN THE REPOSITORY (MOTIR-2903): a path
 * its body names was touched by a merged pull request that is not this card's
 * own and that merged AFTER the card was filed.
 *
 * ⚠️ **Its own family, not a third `shape` severity, and the difference is not
 * cosmetic.** A shape advisory is defined as a defect in what the card's own
 * ACCEPTANCE CRITERIA ask for, with no second party anywhere in the finding, and
 * it carries the 1-based `criterionIndex` the remedy cuts at. This finding has a
 * far end (a merged pull request), is scoped to the whole BODY rather than the
 * criteria — the path that catches the canonical fixture sits in its Context
 * refs — and its remedy is not a cut but *read the diff, and close the card if
 * it is already done*. Squeezing it into `shape` would have needed an optional
 * `criterionIndex`, which §8 forbids on a published schema anyway.
 *
 * ⚠️ **Never a gate, for a reason specific to this check.** It is a heuristic
 * that fails toward the FALSE POSITIVE: two cards working the same file in
 * sequence is the ordinary case, not the defect. As a blocker it would make
 * legitimately-ready cards unstartable and train authors to stop naming paths in
 * card bodies — the same inversion {@link WorkItemProseReferenceAdvisoryDto}
 * records for the reference tier. MOTIR-2075's lesson is that a non-blocking
 * notice is only as good as the step that reads it; the answer taken here is to
 * fix the step's INPUT (it rides in `claim_next_ready`'s claim payload, which a
 * run cannot start without reading), not to make a heuristic authoritative.
 *
 * The opt-out is `isSubsumptionCheckExempt` — a boundary-contract card shares
 * paths with its sibling by design, and unlike the other two findings this one
 * re-fires on every dispatch until the card closes.
 */
export interface WorkItemProseSubsumptionAdvisoryBaseDto {
  /** The union discriminant — see {@link WorkItemProseAdvisoryDto}. */
  kind: 'subsumption';
  /** The card whose body names the covered path. */
  item: string;
  severity: WorkItemProseSubsumptionSeverityDto;
  /** The FIRST path the body names that a qualifying merge touched. */
  path: string;
  /** The covering pull request, as `owner/name#number` — where to read the diff. */
  pullRequest: string;
  /** That pull request's title, or `null` when the mirror row carries none. */
  pullRequestTitle: string | null;
}

/**
 * The two arms of a subsumption finding (MOTIR-3230), as a DISCRIMINATED pair
 * rather than one shape with a nullable instant.
 *
 * `state` is the discriminator a consumer branches on, so the two dispositions are
 * separable without parsing `severity`. Modelling it as a union rather than
 * `mergedAt: string | null` is what makes both producers TOTAL: a merged finding
 * cannot be constructed without its instant, and an open one cannot be constructed
 * carrying one, so neither needs a fallback that would paper over the mistake.
 */
export type WorkItemProseSubsumptionAdvisoryDto = WorkItemProseSubsumptionAdvisoryBaseDto &
  (
    | {
        state: 'merged';
        /** When it merged, ISO-8601 — always AFTER the card's own `createdAt`. */
        mergedAt: string;
      }
    | {
        state: 'open';
        /** Null, always — an open pull request has not merged. */
        mergedAt: null;
      }
  );

/**
 * ONE prose advisory — a discriminated union over `kind` (MOTIR-2175).
 *
 * Three families, ONE non-blocking channel:
 *  - **`reference`** — the card NAMES a not-done work item it has no
 *    `blocked_by` edge to ({@link WorkItemProseReferenceAdvisoryDto}).
 *  - **`shape`** — the card contradicts itself; there is no far end at all
 *    ({@link WorkItemProseShapeAdvisoryDto}). Its criteria are mis-shaped, its
 *    own sizing columns are over the estimation gate (MOTIR-3110), or it is its
 *    OWN design blocker (MOTIR-3178).
 *  - **`subsumption`** — a path the card's body names is already in a merged
 *    diff, so its deliverable may be shipped ({@link WorkItemProseSubsumptionAdvisoryDto}).
 *
 * ⚠️ **Narrow POSITIVELY, never with `a.kind !== 'shape'`.** That catch-all was
 * correct while `reference` was the only untagged member and became a latent
 * mis-render the moment a third family arrived (MOTIR-2903): it would have fed a
 * subsumption advisory to a renderer reading `a.referenced`. Use
 * {@link isReferenceAdvisory} / {@link isSubsumptionAdvisory} — a type predicate
 * narrows the array, so a FOURTH family cannot be added without every renderer
 * failing to compile, which is the property this union was shaped for.
 *
 * ⚠️ **The discriminant is OPTIONAL on `reference` and REQUIRED on `shape`, and
 * that asymmetry is deliberate.** Every field of the reference variant but
 * `item` presumes a referenced work item, so a shape advisory cannot be squeezed
 * into it without empty strings — hence the union rather than a widened
 * interface. But the reference shape is already published: it crosses the MCP
 * wire in `validate_work_item`'s `structuredContent`, in `claim_next_ready`'s
 * payload, and in `dispatch_prompt`'s DTO. Tagging the OLD variant would have
 * changed those bytes for every existing consumer to buy nothing; tagging the
 * NEW one discriminates just as well. Narrow with `a.kind === 'shape'` — the
 * `else` branch narrows to `reference`, tag present or not.
 */
export type WorkItemProseAdvisoryDto =
  | WorkItemProseReferenceAdvisoryDto
  | WorkItemProseShapeAdvisoryDto
  | WorkItemProseSubsumptionAdvisoryDto;

/**
 * A CONTAINER criterion that no child OWNS (MOTIR-5362): a container whose
 * acceptance criteria name something none of its direct children's titles
 * carry, reported only when at least one of those children was created BEFORE
 * the container — ADOPTED, and so scoped and sealed against a different parent.
 *
 * ⚠️ **Its own family, not a `shape` severity, and not a `reference` one.** A
 * shape finding is a card contradicting ITSELF with no second party; a reference
 * finding is one card NAMING another. This one is a relationship between a
 * container and the SET of its children, and its remedy is neither a cut nor an
 * edge: widen the adopted child on the record, or file the sibling that covers
 * the difference.
 *
 * ⚠️ **It rides `validate_work_item` ONLY.** The dispatch surfaces
 * (`dispatch_prompt`, `claim_next_ready`, `/api/v1`) hand out leaves, and a leaf
 * has no children to own anything — so this family never reaches the dispatch
 * advisory union ({@link WorkItemProseAdvisoryDto}) and no wire schema grows.
 *
 * ⚠️ **Never a gate, and its false-positive class is real.** Ownership is read
 * off child TITLES by noun overlap, so a child whose body delivers a criterion
 * its title does not name is reported. That was measured and accepted on
 * MOTIR-5362 against the opposite reading, which read child BODIES and was blind
 * to the one genuine instance on the live tree.
 */
export interface WorkItemCoverageAdvisoryDto {
  /** The union discriminant — see {@link WorkItemValidityAdvisoryDto}. */
  kind: 'coverage';
  /** The CONTAINER whose criterion has no owner. */
  item: string;
  severity: 'likely-unowned-criterion';
  /** 1-based index of the unowned criterion, numbered as the shape checks number them. */
  criterionIndex: number;
  /** The children created BEFORE the container — the adopted ones that gated the finding. */
  adoptedChildren: string[];
}

/**
 * A CONTAINER whose body never mentions a word its own TITLE carries (MOTIR-8647).
 * Every work item laid under a container is laid against its body, not its title,
 * so a body that silently drops a named part of the title narrows the requirement
 * for the whole subtree with nothing marking it as a choice. The remedy is the
 * author's: restore the part in the body, or state it as excluded with the work
 * item that owns it.
 *
 * ⚠️ Its own `kind`, not a severity on {@link WorkItemCoverageAdvisoryDto}: that
 * family is keyed by `criterionIndex` and `adoptedChildren`, and a reader that
 * narrowed on `kind: 'coverage'` would print a finding about a criterion this one
 * does not have. Rides `validate_work_item` only, advisory and never a gate.
 */
export interface WorkItemTitleCoverageAdvisoryDto {
  /** The union discriminant — see {@link WorkItemValidityAdvisoryDto}. */
  kind: 'title-coverage';
  /** The CONTAINER whose body does not carry its title. */
  item: string;
  severity: 'likely-unnamed-title-part';
  /** The title's distinguishing words (stemmed) that the body never mentions. */
  words: string[];
}

/**
 * A criterion naming a FILE another open work item also names, where the file
 * does not exist yet and no `blocked_by` orders the two (MOTIR-5424) — the
 * reference family's PATH arm. The key-based {@link WorkItemProseReferenceAdvisoryDto}
 * sees a sibling only when a body names it by `MOTIR-<n>`; a criterion citing
 * the sibling's deliverable by path (`design/<area>/<surface>.mock.html`) is the
 * same missing edge with nothing for that scan to key on (MOTIR-4856).
 *
 * ⚠️ **Its own discriminant, not a severity on the reference variant.** That
 * variant's wire shape is published untagged and carries no `path`, and a
 * renderer reading it as "names <referenced>" would print a finding about a KEY
 * the body never wrote. The remedy is the reference family's — wire the edge —
 * which is why the name says so.
 *
 * ⚠️ **It rides `validate_work_item` ONLY**, like the coverage family: it reads
 * every open work item in the project and asks the repository host whether a
 * path exists, which is a validation question and too heavy for the dispatch
 * surfaces' per-claim payload. So it never reaches {@link WorkItemProseAdvisoryDto}.
 *
 * ⚠️ **Never a gate.** Two cards naming one not-yet-existing file are usually
 * creator and consumer, not always — both may be consumers of a third card that
 * names it only by key.
 */
export interface WorkItemPathReferenceAdvisoryDto {
  /** The union discriminant — see {@link WorkItemValidityAdvisoryDto}. */
  kind: 'path-reference';
  /** The card whose acceptance criterion names the path. */
  item: string;
  severity: 'likely-missing-path-edge';
  /** The repository-relative path, as the criterion wrote it. */
  path: string;
  /** 1-based index of the criterion naming it, numbered as the shape checks number them. */
  criterionIndex: number;
  /** The repository whose default branch the path does NOT resolve on (its top-level directory does). */
  repo: string;
  /** The OTHER not-done work item naming the same path — one advisory per such item. */
  referenced: string;
  /** That item's raw workflow status key. */
  referencedStatus: string;
}

/**
 * ONE advisory on `validate_work_item`'s verdict: every prose family the dispatch
 * surfaces also carry, plus the two validate-only families — CONTAINER-COVERAGE
 * (MOTIR-5362) and PATH-REFERENCE (MOTIR-5424). Narrow positively —
 * {@link isCoverageAdvisory} / {@link isPathReferenceAdvisory} / {@link isProseAdvisory}.
 */
export type WorkItemValidityAdvisoryDto =
  | WorkItemProseAdvisoryDto
  | WorkItemCoverageAdvisoryDto
  | WorkItemTitleCoverageAdvisoryDto
  | WorkItemPathReferenceAdvisoryDto;

/** Narrow an advisory to the TITLE-COVERAGE family (MOTIR-8647). */
export function isTitleCoverageAdvisory(
  a: WorkItemValidityAdvisoryDto,
): a is WorkItemTitleCoverageAdvisoryDto {
  return a.kind === 'title-coverage';
}

/** Narrow an advisory to the PATH-REFERENCE family (MOTIR-5424). */
export function isPathReferenceAdvisory(
  a: WorkItemValidityAdvisoryDto,
): a is WorkItemPathReferenceAdvisoryDto {
  return a.kind === 'path-reference';
}

/** Narrow an advisory to the CONTAINER-COVERAGE family (MOTIR-5362). */
export function isCoverageAdvisory(
  a: WorkItemValidityAdvisoryDto,
): a is WorkItemCoverageAdvisoryDto {
  return a.kind === 'coverage';
}

/**
 * Narrow an advisory to the families the DISPATCH surfaces share (MOTIR-5362).
 * Positive, per the union note above: a family added later is excluded until it
 * is named here, rather than swept in by a `kind !== 'coverage'` catch-all.
 */
export function isProseAdvisory(a: WorkItemValidityAdvisoryDto): a is WorkItemProseAdvisoryDto {
  return (
    a.kind === undefined || a.kind === 'reference' || a.kind === 'shape' || a.kind === 'subsumption'
  );
}

/**
 * Narrow an advisory to the REFERENCE family (MOTIR-2903).
 *
 * The positive form of the `a.kind !== 'shape'` catch-all every renderer used
 * to carry. The discriminant is absent on this variant by design (see the union
 * note), so the test is "tagged `reference`, or not tagged at all" — which keeps
 * a payload from a server predating the tag reading as a reference, exactly as
 * before, while a NEWER family is no longer swept in.
 */
export function isReferenceAdvisory(
  a: WorkItemValidityAdvisoryDto,
): a is WorkItemProseReferenceAdvisoryDto {
  return a.kind === undefined || a.kind === 'reference';
}

/** Narrow an advisory to the SUBSUMPTION family (MOTIR-2903). */
export function isSubsumptionAdvisory(
  a: WorkItemValidityAdvisoryDto,
): a is WorkItemProseSubsumptionAdvisoryDto {
  return a.kind === 'subsumption';
}

/**
 * Narrow an advisory to the ORDERING shape (MOTIR-2175).
 *
 * A predicate rather than an inline `filter(a => a.severity === …)`, because a
 * boolean predicate does not narrow: every renderer would then read `.phrase`
 * off the whole union. Kept beside the union — the same disposition
 * `isManualReadyItem` has in `lib/dto/ready.ts` — so all five server-side
 * renderers narrow identically and a THIRD member cannot be added without every
 * one of them failing to compile.
 */
export function isOrderingAdvisory(
  a: WorkItemValidityAdvisoryDto,
): a is WorkItemProseOrderingAdvisoryDto {
  return a.kind === 'shape' && a.severity === 'likely-ordering-violation';
}

/** Narrow an advisory to the REPO-STRADDLE shape (MOTIR-2177). */
export function isRepoStraddleAdvisory(
  a: WorkItemValidityAdvisoryDto,
): a is WorkItemProseRepoStraddleAdvisoryDto {
  return a.kind === 'shape' && a.severity === 'likely-repo-straddle';
}

/**
 * Narrow an advisory to the ESTIMATION-GATE SIZING shape (MOTIR-3110).
 *
 * The predicate earns its keep twice over here: it narrows to the one shape
 * member that has no `criterionIndex`, so a renderer that reached for the index
 * on the whole `shape` family stops compiling rather than printing `undefined`.
 */
export function isSizingAdvisory(
  a: WorkItemValidityAdvisoryDto,
): a is WorkItemProseSizingAdvisoryDto {
  return a.kind === 'shape' && a.severity === 'likely-over-gate-sizing';
}

/**
 * Narrow an advisory to the SELF-BLOCKING-DESIGN shape (MOTIR-3178).
 *
 * Earns its keep the same way {@link isSizingAdvisory} does: it narrows to the
 * one shape member whose criterion indices are a PAIR, so a renderer that
 * reached for the singular `criterionIndex` on the whole `shape` family stops
 * compiling rather than printing `undefined`.
 */
export function isSelfBlockingDesignAdvisory(
  a: WorkItemValidityAdvisoryDto,
): a is WorkItemProseSelfBlockingDesignAdvisoryDto {
  return a.kind === 'shape' && a.severity === 'likely-self-blocking-design';
}

/**
 * Narrow an advisory to the POST-MERGE-CHILD shape (MOTIR-8863).
 */
export function isPostMergeChildAdvisory(
  a: WorkItemValidityAdvisoryDto,
): a is WorkItemProsePostMergeChildAdvisoryDto {
  return a.kind === 'shape' && a.severity === 'likely-post-merge-child-under-container';
}

/**
 * Narrow an advisory to the BODY-EDIT-ABOVE-FIELD-MOVE shape (MOTIR-5399).
 *
 * The third shape member with no `criterionIndex`, so — like
 * {@link isSizingAdvisory} — a renderer that reached for the index on the whole
 * `shape` family stops compiling rather than printing `undefined`.
 */
export function isBodyAboveFieldMoveAdvisory(
  a: WorkItemValidityAdvisoryDto,
): a is WorkItemProseBodyAboveFieldMoveAdvisoryDto {
  return a.kind === 'shape' && a.severity === 'body-edit-above-field-move';
}

/** Narrow an advisory to the UNDER-AUTHORED shape (MOTIR-5427). */
export function isUnderAuthoredAdvisory(
  a: WorkItemValidityAdvisoryDto,
): a is WorkItemProseUnderAuthoredAdvisoryDto {
  return a.kind === 'shape' && a.severity === 'under-authored';
}

/** Narrow an advisory to the MISLABELLED-LINK shape (MOTIR-9007). */
export function isMislabelledLinkAdvisory(
  a: WorkItemValidityAdvisoryDto,
): a is WorkItemProseMislabelledLinkAdvisoryDto {
  return a.kind === 'shape' && a.severity === 'likely-mislabelled-link';
}

/** Narrow an advisory to the counted-own-blockers shape (MOTIR-5428). */
export function isBlockerCountAdvisory(
  a: WorkItemValidityAdvisoryDto,
): a is WorkItemProseBlockerCountAdvisoryDto {
  return a.kind === 'shape' && a.severity === 'likely-blocker-count-mismatch';
}
