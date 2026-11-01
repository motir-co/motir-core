// The RENDER-READY plan-review model (Story 7.21 · Subtask 7.4.5 / MOTIR-847).
// The plan-detail UI mounts the reusable `ProjectRoadmapCanvas` (MOTIR-1194) fed
// the plan's PlanItems as data and draws each by its `op`. To draw a `modify` /
// `remove` it needs the EXISTING target's live fields (the OLD side of the diff,
// the node identity), and the history surface needs the decider's NAME — neither
// is on the raw `PlanWithItemsDto`. `planReviewService.getPlanReview` ASSEMBLES
// the plan + its staleness (MOTIR-1340) + the live targets (one batched read) +
// the decider into THIS shape, so the client renders without touching the
// service layer or issuing N work-item reads.
//
// Refs are RESOLVED to canvas node ids server-side, by ONE rule for all three
// ops (MOTIR-3160): a node id is the WORK ITEM the proposal is about, falling
// back to the PlanItem id when there is not one yet. So a `modify`/`remove` is
// the SAME node as the existing item rather than a ghost copy; an
// un-materialized `add` keys by its own id, because it is not about anything
// yet; and an `add` that HAS been materialized keys by the work item it became,
// which is what lets a decided proposal land ON that node instead of beside it.
// The intra-plan temp-ref (`planItem:<id>`) is resolved to the referenced item's
// NODE id — not to the referenced id itself, which would point at a node that is
// no longer on the canvas once that item materialized; a real work-item ref
// stays as-is.

import type { EdgeDisposition } from '@/lib/workItems/edgeDisposition';
import type { ApprovalGateStateDTO, PlanGateHeldDTO } from '@/lib/dto/approvalGate';
import type { StatusCategoryDto } from '@/lib/dto/workflows';
import type { PlanNarrationReadDto, PlanStepDto } from '@/lib/dto/plans';
import type { PlanProgressSnapshot } from '@/lib/plans/planProgress';
import type { ExecutorDto, WorkItemDifficultyDto, WorkItemRefMap } from '@/lib/dto/workItems';
import type {
  PlanItemOpDto,
  PlanItemPatch,
  PlanStatusDto,
  PlanDecisionReasonDto,
  StaleReason,
  PlanAuthorSourceDto,
  PlanOriginDto,
} from '@/lib/dto/plans';

/**
 * Every field name `planReviewService.buildChanges` can emit on a `modify`'s
 * diff overlay — the WIRE vocabulary the review surfaces localize.
 *
 * It is a closed list on purpose (MOTIR-3151). Each surface names its label by
 * interpolating the field into a message key (`field_<name>`), which no compiler
 * can follow — so when MOTIR-1532 taught `buildChanges` to emit `storyPoints` /
 * `estimateMinutes` and stopped at the producer, the plan-review canvas rendered
 * `planReview.field_storyPoints` at a reader for weeks and nothing failed.
 * Adding a member here is what makes
 * `tests/components/plan-change-field-labels.test.tsx` demand its copy — in both
 * catalogs, and in each of the three maps that stand between a field and a word.
 */
export const PLAN_ITEM_CHANGE_FIELDS = [
  'title',
  'priority',
  /** A RE-KIND of the target (bug MOTIR-8192 · `agent-authored-plans.md`
   *  AMENDMENT 25) — `patch.kind`, emitted directly before `type`, the leaf
   *  field a re-kind to a container clears in the same patch. Both sides are
   *  the WIRE kinds (`task` → `story`); the FROM side is read off the target. */
  'kind',
  'type',
  /** The target's EXECUTOR when the approve will SEED it (bug MOTIR-6259) — a
   *  `modify` that re-types a card with no executor gets the type's default, by
   *  the direct door's seed-if-absent rule. Like `status` below, no patch key
   *  produces it: the approve DERIVES it, and it is the field that decides which
   *  decision gate (if any) the card will raise, so the reviewer sees it first. */
  'executor',
  'storyPoints',
  'estimateMinutes',
  /** A leaf's DIFFICULTY (story MOTIR-6095 · MOTIR-6137) — the sizing group's
   *  third member, emitted directly after `estimateMinutes` (design Part XX
   *  §20.5). The row's values are the WIRE words; each surface renders them as
   *  the item page's labels (`labels.difficulty.*`). */
  'difficulty',
  'description',
  'explanation',
  /** The STEPS a `modify` REPLACES (MOTIR-8668 · `agent-authored-plans.md`
   *  AMENDMENT 27) — `patch.todos`. FROM is the live list's count with its ticked
   *  count (`5 (2 ✓)`), because the replacement deletes ticked rows; TO is the new
   *  list, numbered and previewed. A clear is an empty NEW side. */
  'todos',
  'links',
  /** The OBSOLESCENCE mark a `modify` sets, changes or clears (Story MOTIR-6577 ·
   *  MOTIR-6632, design Part XXIV §24.3) — emitted directly after `links`. Both
   *  sides are the WIRE words `current` · `outdated` · `deprecated`, never null:
   *  "no mark" IS a value, so a set reads `Current → Outdated` and a clear
   *  `Deprecated → Current`. The FROM side is read off the live target. */
  'obsolescence',
  /** The mark's NOTE — `to` carries the WHOLE note (or null for a clear); each
   *  surface takes the first line or clamps it. The old note is never quoted, so
   *  `from` is always null (§24.6). */
  'obsolescenceNote',
  /** The `supersedes` edges a `modify` adds / removes with its target as the NEWER
   *  card (`patch.supersedesAdd` / `supersedesRemove`, MOTIR-6630) — the chips ride
   *  {@link PlanItemChangeDto.refs}; `to` is the same set as plain words. */
  'supersedes',
  /** …and with its target as the OLDER card (`patch.supersededByAdd` /
   *  `supersededByRemove`). */
  'supersededBy',
  /** Where the target SITS — a `modify`'s `patch.parentRef` (MOTIR-3859). The
   *  approver has to SEE a re-parent: it is the most structural thing a plan can
   *  say about a card, and the whole reason the move was routed through the
   *  proposal door rather than applied directly. */
  'parent',
  /** Where the target SHIPS — a `modify`'s `patch.targetRepo` (MOTIR-1884) and
   *  `patch.targetRepoRole` (MOTIR-1912), the other half of D3's `SITS or SHIPS`
   *  pair `parent` above completes (bug MOTIR-3868).
   *
   *  Neither had a row at all, so a `modify` carrying ONLY a re-pin rendered as a
   *  proposal with an EMPTY change list — a row that says a card is being changed
   *  and declines to say how — while `applyModify` read and applied both. A re-pin
   *  decides which repository the card ships in, which checkout the CLI is
   *  dispatched into, and (through the container rollup) the derived repository set
   *  of every ancestor; it is the wrong field to be silent about. */
  'targetRepo',
  'targetRepoRole',
  /** The target's STATUS when the approve will RESET it (bug MOTIR-5359) — a
   *  `modify` that re-scopes a card in the `in_progress` category walks it back to
   *  the initial status. The only member no patch key produces: the approve
   *  DERIVES it, and the reviewer has to see it before approving. */
  'status',
] as const;

export type PlanItemChangeField = (typeof PLAN_ITEM_CHANGE_FIELDS)[number];

/**
 * The MARK GROUP of change rows (Story MOTIR-6577 · MOTIR-6632, design Part XXIV
 * §24.4 / §24.12) — the rows the six `PLAN_ITEM_MARK_PATCH_KEYS` produce. A `modify`
 * whose every row is in this group is the one `modify` a FINISHED card accepts
 * (MOTIR-6629's mark-only carve-out), so the canvas does not draw it locked; and
 * the peek's rail reads exactly these rows off {@link PlanProposalPeekDto.markChanges}.
 */
export const PLAN_ITEM_MARK_CHANGE_FIELDS = [
  'obsolescence',
  'obsolescenceNote',
  'supersedes',
  'supersededBy',
] as const satisfies readonly PlanItemChangeField[];

export type PlanItemMarkChangeField = (typeof PLAN_ITEM_MARK_CHANGE_FIELDS)[number];

/** Is `field` one of the {@link PLAN_ITEM_MARK_CHANGE_FIELDS}? */
export function isMarkChangeField(field: string): field is PlanItemMarkChangeField {
  return (PLAN_ITEM_MARK_CHANGE_FIELDS as readonly string[]).includes(field);
}

/**
 * The wire word for "this card carries no mark" on an `obsolescence` change row
 * (Part XXIV §24.3). Rendered as `planReview.obsolescenceCurrent`.
 */
export const OBSOLESCENCE_CURRENT = 'current' as const;

/**
 * EVERY `PlanItemPatch` key, mapped to the rail row it moves — or `null` when it
 * moves something that is not a rail row (MOTIR-4183, design Part XIV §3).
 *
 * ⚠️ `satisfies Record<keyof PlanItemPatch, …>` is the whole point: the map is
 * TOTAL over the patch type, so a key added to `PlanItemPatch` is a COMPILE
 * ERROR here until somebody dispositions it. The peek's count line reads
 * *"{n} of {m} fields it can set"*, and `m` is derived from this map rather
 * than written down — a denominator stated as a constant is one that drifts
 * from what a plan can actually do, silently, the first time the patch grows.
 *
 * **Two keys, one row.** `targetRepo` and `targetRepoRole` both move the
 * `Repositories` rail row, so the row set below de-duplicates to SEVEN.
 *
 * **`title` / `descriptionMd` / `explanationMd` are `null` here and that is not
 * an oversight** — they are patchable, and they are marked in the peek's MAIN
 * COLUMN. A line at the foot of the RAIL that counted them would answer about
 * fields the reader cannot see from where it sits (Part XIV §3).
 * `blockedByAdd` / `blockedByRemove` are edges: the canvas draws them (Part IX).
 *
 * **The mark keys ARE rail rows** (Story MOTIR-6577 · MOTIR-6632, Part XXIV
 * §24.10): the mark and its note sit under Status, the two supersedes rows last.
 * Unlike `blockedByAdd`, the supersedes edges are NOT drawn on the canvas (no
 * canvas edge, §24.7), so they are shown as rows of their own — the four lists
 * collapse onto two rows, which is why the row set de-duplicates to ELEVEN.
 *
 * Exported for the story gate's CONTRACT GUARD (Story MOTIR-6577 · MOTIR-6633,
 * `tests/integration/plans/planMarkStoryGate.test.ts`), which holds its keys to
 * `PLAN_ITEM_PATCH_KEYS` and the MCP `patchSchema` at runtime, and its mark keys'
 * rows to {@link PLAN_ITEM_MARK_CHANGE_FIELDS}. Read it; never write it.
 */
export const PATCH_KEY_RAIL_ROW = {
  title: null,
  descriptionMd: null,
  explanationMd: null,
  blockedByAdd: null,
  blockedByRemove: null,
  priority: 'priority',
  type: 'type',
  // A RE-KIND (bug MOTIR-8192) moves no RAIL row — the peek's rail has none for
  // the hierarchy kind, and adding one would change the count line's
  // denominator for every plan. The reviewer reads it as a `kind` CHANGE row on
  // the canvas node and in the list, like the bodies above.
  kind: null,
  // The STEPS (MOTIR-8668) move no RAIL row — like the bodies, they are long and
  // the peek's rail has no row for them. The reviewer reads a `todos` CHANGE row.
  todos: null,
  storyPoints: 'storyPoints',
  estimateMinutes: 'estimateMinutes',
  // A leaf's DIFFICULTY (MOTIR-6133 carries it, MOTIR-6137 renders it) — the
  // seventh settable rail row (design Part XX §20.5).
  difficulty: 'difficulty',
  targetRepo: 'targetRepo',
  // The SET forms (bug MOTIR-4904) join the same row: `Repositories` is one rail
  // row about one axis, and `targetRepo` / `targetRepos` / `targetRepositories`
  // are that axis in three spellings — mutually exclusive at the boundary, so at
  // most one of them can move the row on any given patch.
  targetRepos: 'targetRepo',
  targetRepositories: 'targetRepo',
  targetRepoRole: 'targetRepo',
  // The singular ROW-ID pin (Story MOTIR-2732 · MOTIR-3045, surfaced by MOTIR-4924)
  // joins the same row for the same reason: it is the same axis in another spelling,
  // mutually exclusive with the four above at the append.
  targetRepositoryRef: 'targetRepo',
  parentRef: 'parent',
  // The OBSOLESCENCE mark and its note (MOTIR-6629 carries them onto a `modify`,
  // MOTIR-6632 renders them — Part XXIV §24.10): the Mark and Note rail rows,
  // directly under Status.
  obsolescence: 'obsolescence',
  obsolescenceNoteMd: 'obsolescenceNote',
  // The four `supersedes` edge lists (MOTIR-6630) — two rows, one per DIRECTION:
  // an Add and its Remove move the same row (§24.10).
  supersedesAdd: 'supersedes',
  supersedesRemove: 'supersedes',
  supersededByAdd: 'supersededBy',
  supersededByRemove: 'supersededBy',
  // `languages` (MOTIR-8743) is no row and no key here: it annotates the text
  // keys above, outside `PLAN_ITEM_PATCH_KEYS`, and changes nothing by itself.
} satisfies Record<Exclude<keyof PlanItemPatch, 'languages'>, PlanItemChangeField | null>;

/**
 * The rail rows a `modify` CAN move — the denominator of the peek's count line.
 * DERIVED from {@link PATCH_KEY_RAIL_ROW}, never listed.
 *
 * ⚠️ `executor` is deliberately absent, and it is the one a reader expects to
 * find. `PlanItemPatch` has no `executor` key: it is settable on an `add` and
 * deepenable (`agent-authored-plans.md` AMENDMENT 4 D3a), and on every other op
 * it is the TARGET's. Part XIV's first draft marked it changeable on a `modify`
 * and was corrected against this type. The one thing a `modify` does to it is
 * DERIVED, not set (bug MOTIR-6259): re-typing a target that has NO executor
 * seeds the type's default at approve, reported as an `executor` CHANGE row the
 * way the resting `status` is — never a rail field the author can move.
 */
export const PLAN_ITEM_SETTABLE_RAIL_FIELDS: readonly PlanItemChangeField[] = Array.from(
  // `flatMap` rather than `filter` + a predicate: the map's value type is a
  // NARROWER union than `PlanItemChangeField` (it holds only the rail rows), so
  // a `row is PlanItemChangeField` predicate is not assignable to its own
  // parameter. `flatMap` narrows by construction and needs no assertion.
  new Set(Object.values(PATCH_KEY_RAIL_ROW).flatMap((row) => (row === null ? [] : [row]))),
);

/**
 * ONE proposed STEP, as the REVIEW surface shows it (Story MOTIR-3810 ·
 * MOTIR-4622) — `design/ai-planning/design-notes.md` Part XV.
 *
 * ⚠️ `executor` IS RESOLVED HERE, not carried raw. `agent-authored-plans.md`
 * AMENDMENT 14 D5 seeds a materialized row's executor as
 * `row.executor ?? proposal.executor ?? 'human'`, and the whole point of this
 * surface is that **the reviewer reads what approve will WRITE**. Sending the
 * raw `null` and letting the client decide would put the seed rule in two
 * places, and the client's copy would be the one nobody tests against
 * materialize.
 */
export interface PlanReviewTodoDto {
  text: string;
  notesMd: string | null;
  commandText: string | null;
  /** RESOLVED — never null on the wire. */
  executor: ExecutorDto;
}

/**
 * What only a PROPOSAL has, carried BESIDE the payload the shipped quick view
 * reads (MOTIR-4183, story MOTIR-4181).
 *
 * ⚠️ THE PAYLOAD ITSELF IS NOT HERE, AND THAT IS THE DECISION (Part XIV §2, as
 * amended). A `modify` / `remove` names a real work item, and the shipped peek
 * is ALREADY client-fetched by key from both hosts
 * (`WorkItemQuickView.tsx:75`, `IssueQuickViewController.tsx:70`). Merging the
 * target's `QuickViewData` in HERE would mean `workItemsService.getQuickView` —
 * ~14 reads — once per proposal, on a plan-review read whose own header
 * advertises ONE batched target read and no N+1: ~280 reads for a plan with
 * twenty `modify`s, to serve a peek the reviewer opens at most one of.
 *
 * So the overlay happens ON OPEN, in the host, over the request it already
 * makes. This envelope is what the plan read owes and all it owes.
 */
export interface PlanProposalPeekDto {
  /** WHICH kind of change this is — the peek header's op chip. */
  op: PlanItemOpDto;
  /** The target's key, or `null` for an un-materialized `add`, which has none
   *  until approve materializes it — the same rule `PlanReviewItemDto.identifier`
   *  states, repeated here so a consumer of the envelope alone can tell whether
   *  there is a payload to fetch at all. `null` IS the signal: no key, no fetch,
   *  and the proposed values below are the whole of what can be shown. */
  identifier: string | null;
  /**
   * The fields this plan MOVES — the key set `buildChanges` emits for the same
   * proposal, not a second comparison.
   *
   * ⚠️ ONE SOURCE, deliberately. A marker computed from its own diff would be
   * right the day it was written and would drift the first time a field was
   * added to only one of them — and the drift would be invisible, because each
   * surface would be self-consistent. Empty for an `add` (everything is
   * proposed, which the count line says in words) and for a `remove` (which
   * changes no field).
   */
  changedFields: PlanItemChangeField[];
  /** The rail rows a patch CAN move — {@link PLAN_ITEM_SETTABLE_RAIL_FIELDS},
   *  carried so an older client renders the denominator the SERVER's patch type
   *  supports rather than the one its own bundle was built against. */
  settableRailFields: readonly PlanItemChangeField[];
  /**
   * The card's proposed STEPS, read-only (MOTIR-4622 · Part XV).
   *
   * On an `add` that carries them; **`null` on a `modify` and a `remove`, and
   * that is a decision rather than a gap** (AMENDMENT 14 D6). A `modify`'s
   * target is a COMMITTED card whose list is a person's PROGRESS, so its live
   * list is not shown here as if approve would write it. Since AMENDMENT 27
   * (MOTIR-8668) a `modify` MAY replace that list; the replacement reaches the
   * reviewer as a `todos` CHANGE row (live count and ticked count → the new
   * steps), not through this field.
   *
   * It rides the ENVELOPE and not the payload for the reason the header above
   * gives: the payload of a `modify` is the target's, fetched on open, and an
   * `add` has no target at all — its steps exist nowhere else.
   */
  todos: PlanReviewTodoDto[] | null;
  /**
   * WHY a `remove` is proposed (MOTIR-6055 · Part XIX §19.5): the SAME string as
   * {@link PlanReviewItemDto.removeReason}, carried here because the envelope is
   * what reaches the peek, which draws it as a band under the header row.
   * Absent reads as `null` — no band — which is also what an envelope built
   * before this field existed means.
   */
  removeReason?: string | null;
  /**
   * A `modify`'s MARK-GROUP change rows (Story MOTIR-6577 · MOTIR-6632, Part XXIV
   * §24.10 / §24.12) — the SAME objects as the item's `changes` rows whose field is
   * in {@link PLAN_ITEM_MARK_CHANGE_FIELDS}, filtered from the one array, never a
   * second derivation. The peek's rail draws a Mark / Note / Supersedes /
   * Superseded-by row for each. Absent or empty ⇒ no rows (an `add`, a `remove`, a
   * `modify` that touches no mark key, an envelope from an older server).
   */
  markChanges?: PlanItemChangeDto[];
  /**
   * An `add`'s `supersedesRefs`, resolved to chips (MOTIR-6632, §24.8) — the SAME
   * array as {@link PlanReviewItemDto.supersedesRefs}. The rail's last row. Absent
   * or empty ⇒ no row.
   */
  supersedesRefs?: PlanRefChipDto[];
}

/**
 * ONE card a supersedes edge names, resolved ON THE SERVER for the chip that draws
 * it (Story MOTIR-6577 · MOTIR-6632, design Part XXIV §24.7 / §24.12) — so the
 * client renders what it is handed and never re-derives which refs are proposals.
 */
export interface PlanRefChipDto {
  /** The card's key — `null` for an un-materialized `add` of this plan, which has
   *  none (its chip reads `New` in the key slot). After approve it is the CREATED
   *  key. For a ref no read could resolve, the raw ref, so the chip degrades to
   *  something checkable rather than to nothing. */
  identifier: string | null;
  /** The card's title — for a proposal, the title the proposal asks for. */
  title: string;
  /** The work-item kind, for the type icon. */
  kind: string;
  /** A proposal of THIS plan that approve has not created yet — drawn in the
   *  proposed treatment (dashed accent frame, `New`). */
  proposed: boolean;
  /** The PlanItem id when the ref names a proposal of this plan — what opens that
   *  proposal's peek. Absent for a committed card. */
  planItemId?: string;
}

/** One field's OLD → NEW change in a `modify` proposal (the diff overlay). */
export interface PlanItemChangeDto {
  /**
   * The changed field. The producer emits one of {@link PLAN_ITEM_CHANGE_FIELDS}
   * and is typed to (`buildChanges`), but this stays a plain `string`: a client
   * bundle can be older than the server that answered it, and a surface that
   * cannot even REPRESENT a field it does not know cannot fall back for one.
   */
  field: string;
  /** The live OLD value (read from the target), or null when there was none. */
  from: string | null;
  /** The proposed NEW value, or null when the change removes it. */
  to: string | null;
  /**
   * Both sides of a `parent` change, TYPED (MOTIR-5415) — present on the
   * `parent` row only. `from` / `to` above stay the reader's words (a key, a
   * folder path joined `▸`, or null for the root) so an older client keeps
   * rendering; a surface that must tell a FOLDER from a WORK ITEM from the
   * PROJECT ROOT — the glyph, the `Placement` label — reads these instead
   * (`design/ai-planning/design-notes.md` Part XVII §17.8).
   */
  placement?: { from: PlanPlacementSideDto; to: PlanPlacementSideDto };
  /**
   * The cards a `supersedes` / `supersededBy` row adds and removes, as resolved
   * chips (Story MOTIR-6577 · MOTIR-6632, Part XXIV §24.7) — present on those two
   * rows only. `to` stays the same set as plain words, so an older client keeps
   * rendering.
   */
  refs?: { added: PlanRefChipDto[]; removed: PlanRefChipDto[] };
}

/**
 * One side of a proposal's placement (MOTIR-5415): the project root, a
 * committed work item, or a folder. A folder side carries its path ROOT FIRST,
 * and `folderMissing` when the folder no longer exists in the plan's project —
 * then `folderPath` is null, because the name went with the row.
 */
export type PlanPlacementSideDto =
  | { kind: 'root' }
  | {
      kind: 'workItem';
      id: string;
      identifier: string | null;
      /**
       * The TITLE of the `add` a `planItem:<id>` side names, while that add is
       * not yet materialized (MOTIR-6055 · `design-notes.md` Part XIX §19.3).
       * The surface draws it as `New · <title>` — the proposed crumb's own
       * grammar — and never the temp-ref. Absent for a committed parent, and for
       * an approved add, whose created key is `identifier`.
       */
      proposedTitle?: string;
    }
  | { kind: 'folder'; folderId: string; folderPath: string[] | null; folderMissing: boolean };

/** One folder on a proposal's {@link PlanReviewItemDto.folderTrail} (MOTIR-5798). */
export interface PlanFolderCrumbDto {
  id: string;
  name: string;
}

/**
 * One crumb on the COMMITTED ancestor path a proposal's parent sits on — the
 * breadcrumb the plan canvas opens with (bug MOTIR-3152).
 *
 * `PlanReviewItemDto` carried the IMMEDIATE parent only, so the canvas could
 * synthesise exactly one crumb and every ancestor above it was missing. The
 * design (`design/ai-planning/design-notes.md` Part V §2 panel E) asks for *"the
 * committed ancestor path down to the focused level, exactly as the roadmap draws
 * it"* — which is a CHAIN, and a chain has to be carried rather than invented.
 */
export interface PlanParentCrumbDto {
  id: string;
  identifier: string;
  title: string;
}

/**
 * One COMMITTED blocked-by edge a proposal's target already carries (bug
 * MOTIR-4951) — see {@link PlanReviewItemDto.committedBlockedBy}.
 *
 * A pair rather than a bare node id, because the canvas's committed treatment is
 * status-derived and the level builder cannot recover the status: the blocker may
 * be a card the plan is relocating too, in which case it is not in the roadmap
 * read for this level either.
 */
export interface PlanCommittedBlockerDto {
  /** The blocker's canvas node id — its work-item id. */
  nodeId: string;
  /** The blocker sits at `done`, so the edge draws `firm` rather than `pending` —
   *  `buildWorkItemLevel`'s rule for every within-level committed edge. */
  isDone: boolean;
}

/**
 * What the canvas needs to NAME one blocker a proposal carries (bug MOTIR-5387)
 * — see {@link PlanReviewItemDto.blockerStubs}.
 *
 * The roadmap draws a blocker that sits on another level as a ghost anchor
 * NAMING it, and the two edge carriers name a blocker by node id alone. So before
 * approve the review canvas had nothing to put on an anchor, and drew none.
 */
export interface PlanBlockerStubDto {
  /** The blocker's canvas node id — the id the edge carriers name. */
  nodeId: string;
  /** Its key, or `null` for an un-materialized `add`, which has none — its
   *  anchor puts the proposed word in the key's slot (Part IX §1.3). */
  identifier: string | null;
  /** The title it has; for a proposal, the title the proposal asks for. */
  title: string;
  /** `status === 'done'` — the predicate every committed edge is drawn by. */
  isDone: boolean;
  /**
   * Where the blocker SITS once the plan is approved: the placement the plan
   * gives it when the plan names it, the committed row's parent otherwise. It is
   * how the canvas tells a blocker OFF the level from a member of the level that
   * the capped read did not carry (bug MOTIR-5043).
   */
  parentNodeId: string | null;
  /**
   * What the canvas draws for this edge once the plan is approved (MOTIR-6362) —
   * the proposal's edge to THIS blocker, judged over the PROJECTED tree by the
   * same `edgeDisposition` the roadmap read uses: `covered` draws nothing,
   * `exempt` a neutral anchor, `uncovered` / `cross_level` the flag. Absent on a
   * decided plan and on an end the projection cannot place, where the canvas
   * keeps the pre-MOTIR-6362 flag.
   */
  coverage?: EdgeDisposition;
}

/** A proposed operation, enriched for the canvas + review rail. */
export interface PlanReviewItemDto {
  /** The PlanItem id — the stable review key. */
  planItemId: string;
  op: PlanItemOpDto;
  /** The canvas node id: the target work-item id whenever the proposal HAS one
   *  (a `modify` / `remove`, or an `add` that has been materialized — same id,
   *  not a ghost copy); the PlanItem id for an `add` that has not. */
  nodeId: string;
  /**
   * The resolved parent node id (drill placement), or null for a root.
   *
   * ONE rule for all three ops (bug MOTIR-3191): an `add` names its parent in
   * `parentRef`; a `modify` / `remove` names none — it cannot, since its parent
   * is the live card's and a proposal may not move anything — so its placement is
   * read off the TARGET's own `parentId`. Before that, a proposal ABOUT an
   * existing card arrived with a null parent and every consumer drew it as a
   * ROOT, which is where the plan rules put epics and nothing else.
   */
  parentNodeId: string | null;
  /**
   * The COMMITTED parent this proposal sits under — resolved from the same
   * batched read, for a `parentRef` naming a real work item AND for the parent a
   * `modify` / `remove` inherits from its target (MOTIR-3083, MOTIR-3191).
   *
   * It is what the canvas opens a LEVEL at and what the breadcrumb names. Before
   * this the review model carried no field that could name the parent at all, so
   * a proposal under a committed item drew at the top level indistinguishable
   * from a genuine root — `isRoot` is true both for "no parent" and for "a parent
   * outside the rendered set", which is correct for a partial subtree and wrong
   * for this. The distinction lives here, in the plan's own model, rather than in
   * that shared predicate.
   *
   * All three are null for a root, for an intra-plan (`planItem:`) parent, and
   * for a parent that has been archived or hard-deleted — the last case degrades
   * to the root rendering rather than failing the read.
   */
  parentIdentifier: string | null;
  parentTitle: string | null;
  parentKind: string | null;
  /**
   * The COMMITTED ancestor path down to `parentNodeId` — ROOT FIRST, the parent
   * itself LAST (bug MOTIR-3152). This is what the canvas breadcrumb walks: the
   * roadmap names a level by its whole chain, and the three fields above can only
   * name its last link.
   *
   * `[]` in exactly the cases the three fields above are null: a root proposal, an
   * intra-plan (`planItem:`) parent, and an archived / hard-deleted parent — the
   * last degrading to the root rendering rather than failing the read.
   */
  parentTrail: PlanParentCrumbDto[];
  /**
   * The FOLDER this proposal will sit in, when its effective placement is one
   * (MOTIR-5415): an `add`'s `parentRef` or a `modify`'s `patch.parentRef`
   * naming `folder:<id>`, else — for a `modify` / `remove` that does not move
   * its target — the target's own folder. Null otherwise.
   *
   * A folder-placed proposal is a ROOT: `parentNodeId` and the four parent
   * fields above are null / `[]` for it, exactly as for an unfiled root.
   */
  folderId: string | null;
  /** That folder's names, ROOT FIRST — null when there is no folder, or when
   *  it no longer exists (see {@link folderMissing}). */
  folderPath: string[] | null;
  /**
   * The folder named by {@link folderId} no longer exists in the plan's
   * project — deleted after the plan was written. Approve refuses such a plan
   * (MOTIR-5423); the review surface draws the stale state (MOTIR-5406).
   */
  folderMissing: boolean;
  /**
   * The FOLDER CHAIN this proposal sits under, ROOT FIRST, each step its id and
   * name (Bug MOTIR-5782 · MOTIR-5798; `design/ai-planning/design-notes.md`
   * Part XVIII decision 7). The planning canvases draw a folder as a LEVEL, so
   * they need what {@link folderPath} cannot carry: an id per folder, to key an
   * ancestor folder's level, count a closed folder's proposals DEEP, and make
   * each folder crumb navigate.
   *
   * Resolved, in order: the proposal's own folder when it is folder-placed (its
   * {@link folderId}); else the folder of its ROOT-MOST committed ancestor — the
   * first link of {@link parentTrail}, whose own folder is its effective one
   * because a root has no parent; else, under an intra-plan (`planItem:`) parent,
   * the root-most PROPOSED ancestor's; else `[]`. `[]` too when
   * {@link folderMissing}: the folder is gone and there is no chain to walk.
   * For a folder-placed proposal `folderTrail.map((t) => t.name)` equals
   * {@link folderPath} — both come from one read.
   */
  folderTrail: PlanFolderCrumbDto[];
  /** Resolved blocked-by node ids (within the proposed forest). */
  blockedByNodeIds: string[];
  /**
   * Resolved node ids of the committed blocked-by edges this proposal would
   * DELETE — `patch.blockedByRemove`, as canvas node ids (bug MOTIR-4092).
   *
   * ⚠️ A SEPARATE FIELD, NOT A MERGE INTO {@link blockedByNodeIds}, and that is
   * the whole design. An edge the plan deletes is not a blocker the proposal
   * declares: folding it in would draw it as an arriving dependency and say the
   * OPPOSITE of what the plan proposes. It travels on its own channel so the
   * canvas can SUBTRACT it (bug MOTIR-4098) — `mergePlanLevel` drops the matching
   * committed dep, so the graph shows the edge set approving would leave behind
   * and the removal is reported in words by the `links` diff row rather than as
   * a marked arrow.
   *
   * Empty for an `add` and for a `remove` (neither carries a patch), and for any
   * `modify` whose patch does not touch the edge set.
   */
  blockedByRemovedNodeIds: string[];
  /**
   * The blocked-by edges the TARGET ALREADY CARRIES — committed, untouched by
   * the plan, resolved to canvas node ids (bug MOTIR-4951).
   *
   * ⚠️ THE THIRD CARRIER, AND IT IS THE ONLY ONE THE PLAN DOES NOT STATE. The two
   * above are what a proposal SAYS about edges — `blockedByRefs` /
   * `patch.blockedByAdd` for an arriving one, `patch.blockedByRemove` for a
   * departing one — and both are correct and complete for a proposal that stays
   * where it is, because `mergePlanLevel` gets everything else from the COMMITTED
   * level the roadmap read returned.
   *
   * A `modify` that RE-PARENTS its target (`patch.parentRef`, MOTIR-3859) breaks
   * that arrangement, and it breaks it silently. The card is drawn at its new
   * level — MOTIR-3867 taught the projection WHERE it goes, and
   * `parentNodeIdOf` puts it there — but the committed level it lands on is the
   * destination's CURRENT children, which is exactly the set the moving card is
   * not in yet. So its committed edges are in neither source: not in
   * `committed.deps` (it is not a child there yet) and not in the two carriers
   * above (a relocation proposes no edge — the edge already exists). The
   * relocated card arrived as a NODE and never as an ENDPOINT, and a reviewer
   * reading the canvas for what blocks what saw a set of unrelated cards.
   *
   * That is why this field says what the card BRINGS rather than what the plan
   * CHANGES, and why it is populated on every op that has a target rather than
   * on a re-parenting `modify` alone: an already-at-level target's edges are in
   * `committed.deps` too, so including them is a no-op the level builder
   * de-duplicates — while a rule keyed on `patch.parentRef` would go quiet the
   * first time a card reaches a level by some other route.
   *
   * `isDone` rides along because the canvas's committed treatment is
   * status-derived: `buildWorkItemLevel` draws a within-level edge `firm` when
   * its blocker is `done` and `pending` otherwise, and these edges must be drawn
   * by that same rule — approving creates nothing here, so the canvas must not
   * draw them the way it draws an edge approving WOULD create.
   *
   * Empty for an un-materialized `add` (it is not a work item yet, so it carries
   * nothing) and for any target with no committed blockers. ARCHIVED blockers are
   * excluded, the same rule the readiness reads apply.
   */
  committedBlockedBy: PlanCommittedBlockerDto[];
  /**
   * A NAMING STUB for every blocker the two edge carriers above name —
   * `blockedByNodeIds` ∪ `committedBlockedBy`, one per node id (bug MOTIR-5387).
   *
   * A blocker ON the proposal's level is drawn from the level's own nodes and
   * needs nothing here. A blocker OFF it takes the roadmap's off-level treatment
   * — the `cross` arrow, a ghost anchor naming it, and the dependent's "blocked
   * elsewhere" chip — and an anchor has to say what it stands for. With ids
   * alone, `mergePlanLevel` dropped every such edge, and the bad-plan signal
   * first appeared after approve, when the roadmap read supplied the stub.
   *
   * Resolved from the SAME batched row read as the targets, never a per-item
   * query. A blocker neither the plan nor that read can resolve (archived,
   * deleted, outside the workspace) has no stub, and the canvas draws nothing
   * for it rather than an anchor it cannot name.
   */
  blockerStubs: PlanBlockerStubDto[];
  /** The target's identifier (`PROD-12`) — null for an un-materialized `add`,
   *  which has no key, and the target's real key for every proposal that does. */
  identifier: string | null;
  /**
   * The display title — **the title this proposal is ASKING for**, on every op
   * (MOTIR-4018, design Part XIII §1).
   *
   * An `add` reports its proposed title; a `modify` reports `patch.title` when
   * the patch carries one and the target's live title when it does not; a
   * `remove` reports the target's, which is the only title it has.
   *
   * ⚠️ IT USED TO REPORT THE TARGET'S TITLE FOR EVERY NON-`add` OP, and the
   * sentence describing that is worth keeping because the defect it produced is
   * the kind nothing catches: a plan renaming a card drew the node, its
   * breadcrumb crumb, its search text and the list row's headline under the name
   * the card is about to STOP being called — while the same response carried the
   * proposed one three lines away, as a `changes` row. The surface named the card
   * by what it is called and, much more quietly, by what it will be called.
   *
   * The `changes` array is UNCHANGED and still carries both sides
   * (`{ field: 'title', from: <live>, to: <proposed> }`): the node is a SIGNAL and
   * the list is where a change is SPELLED (Part VIII §3), so this field says what
   * the card will BE and the diff says what it is leaving.
   */
  title: string;
  /** The work-item kind (`epic`/`story`/`task`/`bug`/`subtask`); defaults `task`. */
  kind: string;
  /**
   * The PRIORITY this proposal is asking for — **on every op** (bug
   * MOTIR-4143), the rule `title` and both bodies already state above.
   *
   * An `add` reports its proposed value; a `modify` reports `patch.priority`
   * when the patch CARRIES the key (presence, so an explicit `null` clears)
   * and the target's live value when it does not; a `remove` reports the
   * target's. `null` only when nobody has one.
   *
   * ⚠️ IT USED TO BE `null` FOR EVERY OP BUT `add`, on the ground that a rail
   * has no old→new affordance while the `changes` diff does — which is true of
   * the list row and false of `ProposalQuickView`, the only surface this field
   * reaches and one with no diff at all. A `modify` opened there rendered its
   * ENTIRE rail as a single Parent row.
   */
  priority: string | null;
  /** The work-item TYPE (`code`/`design`/…) this proposal is asking for — on
   *  every op, the same rule and the same reason as `priority` above. */
  type: string | null;
  /**
   * The DESCRIPTION this proposal is asking for — **on every op** (bug
   * MOTIR-4134), the same rule `title` states above and for the same reason.
   *
   * An `add` reports its proposed body; a `modify` reports `patch.descriptionMd`
   * when the patch CARRIES the key and the target's live body when it does not;
   * a `remove` reports the target's, which is the only one it has.
   *
   * ⚠️ CARRIES, not "is non-null". The patch is sparse and an explicit `null`
   * CLEARS the body, so `planReviewService`'s `proposedBody` tests presence —
   * the same `!== undefined` `applyModify` and `buildChanges` already test.
   *
   * ⚠️ IT USED TO BE `null` FOR EVERY OP BUT `add`, and this sentence is kept
   * because the defect was in the COMPOSITION rather than in either half. That
   * was coherent while the DTO fed the canvas node and the list row, neither of
   * which reads it — a change is SPELLED through `changes[]`, and a flat field
   * would have been a second, staler copy. It stopped being coherent when a
   * list row became a door onto `ProposalQuickView`, which renders the flat
   * bodies INLINE and has no diff rendering at all: a `modify` opened there read
   * *"No description yet."* over a patch carrying a full rewritten body, on the
   * surface a person approves from. The `changes` array is UNCHANGED and still
   * carries a previewed old→new pair, exactly as with `title`: this field says
   * what the card will BE and the diff says what it is leaving.
   */
  descriptionMd: string | null;
  /**
   * EVERY remaining `PlanItemProposedFields` value that `materialize` writes onto
   * the created work item (MOTIR-3084).
   *
   * ⚠️ CORRECTED (bug MOTIR-4134). This used to read *"All `null` for a `modify`
   * / `remove`, which describe an existing item rather than propose a new one"*,
   * and it was the DOCUMENTED intent behind the defect above, so it is corrected
   * rather than left to be contradicted by the code. **`explanationMd` follows
   * `descriptionMd`'s rule and is populated on every op**, and so — since bug
   * MOTIR-4143 — does every RAIL field below it: `storyPoints`,
   * `estimateMinutes`, `targetRepo`, `targetRepoRole` and `executor` all report
   * the value the card will HAVE, because the quick view that renders them has
   * no diff to read the change out of. What remains add-only is
   * `explanationSource` and `planningProvenance`, each stated at its own field
   * and for the same reason: neither describes the CARD. The op axis is held field by field by
   * `tests/dto/planReviewFieldParity.test.ts`, so which side a field is on is a
   * decision somebody writes down rather than one a reader infers from here.
   *
   * They are here because the review surface is a stop on the seam and was
   * missing from it: `explanationMd` is carried on the proposal, diffed, and
   * materialized, and NOTHING in the review surface read it — a reviewer
   * approved a second content body they were never shown. `targetRepo` is the
   * same failure with a sharper consequence: it routes dispatch, and it was
   * invisible at the one moment a person could still correct it.
   *
   * ⚠️ This list is not a place to be conservative. `tests/dto/planReviewFieldParity.test.ts`
   * holds it against `PlanItemProposedFields` and goes RED when the two diverge —
   * which is the durable half of this fix, because the four fields above are only
   * today's instance. `planningProvenance` is the proof: it was added to the
   * proposal and not to this model while the card to fix that was in the backlog.
   */
  explanationMd: string | null;
  /**
   * The LIVE summaries of the work items this proposal's title, `descriptionMd`
   * and `explanationMd` link to with `[KEY](motir:<id>)` (bug MOTIR-9355) — the
   * map the peek's body renderer looks each chip up in, keyed by work-item id.
   *
   * Resolved from the bodies ABOVE, which are the PROPOSED ones, in ONE batched
   * read for the whole plan (`planReviewService.getPlanReview`), never per
   * proposal and never on open. Before it, an `add`'s peek rendered with an empty
   * map and a `modify`'s with its TARGET's map, resolved from the target's stored
   * description only — so every link a proposed body carried was drawn as a
   * deleted card. An id that resolves to nothing is absent, which is exactly the
   * struck-through state a link to a genuinely deleted card owes.
   *
   * Optional only for the hand-built review items tests and the sprint planner
   * construct; the plan-review read always sets it.
   */
  workItemRefs?: WorkItemRefMap;
  /**
   * ⚠️ The one field that stays `add`-ONLY on purpose (bug MOTIR-4134), while
   * the body directly above it moved to every op.
   *
   * `PlanItemPatch` has NO `explanationSource` twin, deliberately — that column
   * is not the caller's to set, so a patch that could write it would let a plan
   * forge provenance — and `applyModify` leaves the target's value alone. A
   * `modify` therefore has nothing to say here, and reporting the TARGET's
   * source beside a REWRITTEN explanation would attribute the new text to
   * whoever wrote the old one: the same false statement MOTIR-4134 is about,
   * pointing the other way.
   */
  explanationSource: string | null;
  storyPoints: number | null;
  estimateMinutes: number | null;
  /**
   * A leaf's DIFFICULTY (story MOTIR-6095 · MOTIR-6137, design Part XX §20.8) —
   * the value approve will WRITE, on EVERY op like `storyPoints`: an `add`'s
   * proposed value, a `modify`'s patch when it carries the key (an explicit
   * `null` CLEARS it) else the target's, a `remove`'s target's. Always `null`
   * on a container, which cannot carry one (MOTIR-6133 refuses it).
   */
  difficulty: WorkItemDifficultyDto | null;
  targetRepo: string | null;
  /**
   * EVERY repository the card will ship in (bug MOTIR-4904) — the SET beside
   * `targetRepo`'s primary, so a reviewer approving a two-repository card can
   * see the second one.
   *
   * Patch-or-target on every op, exactly as `targetRepo` is: the quick view has
   * no diff to read the change out of, so the rail answers *what the card will
   * BE*. Empty for a proposal that pins nothing.
   */
  targetRepos: string[] | null;
  /**
   * The repository axis as `project_repository` ROW IDS, when the proposal
   * authored it that way (bug MOTIR-4904).
   *
   * ⚠️ `add`-ONLY, on purpose, and it is the one repository field that is. These
   * are cuids: they are an AUTHORING form, not a value a reviewer reads, and the
   * names they resolve to are what `targetRepos` above already carries. On a
   * `modify` the committed side would be a second read producing the same names
   * under different strings — so the honest answer for every other op is that
   * this field has nothing to say, and the rail draws the names.
   */
  targetRepositories: string[] | null;
  /**
   * The singular `project_repository` ROW-ID pin (Story MOTIR-2732 · MOTIR-3045,
   * surfaced by MOTIR-4924) — `add`-ONLY for exactly the reason
   * {@link targetRepositories} is: a cuid is an authoring form, not a value a
   * reviewer reads, and the name it resolves to is what {@link targetRepo} /
   * {@link targetRepos} already carry. The diff row a re-pin by ref produces lives
   * in `changes` (under `targetRepo`), so the rail need not repeat it.
   */
  targetRepositoryRef: string | null;
  targetRepoRole: string | null;
  executor: string | null;
  planningProvenance: { source?: string; harness?: string | null; model?: string | null } | null;
  /**
   * WHICH SUBJECT MATTER the pass composed this card's rule packs from (Story
   * MOTIR-5062 · MOTIR-5065) — the fourth selector coordinate, reported to the
   * reviewer BESIDE `planningProvenance` because it is the same kind of fact.
   *
   * ⚠️ `add`-ONLY, and it joins the arm for {@link planningProvenance}'s reason
   * rather than a new one: it describes the PASS, not the card. A `modify`
   * proposes no subject of its own — `PlanItemPatch` has no twin — so reporting
   * the target's would attribute a coordinate derived by an earlier pass to this
   * one, which is `explanationSource`'s failure mode exactly.
   *
   * WHY IT IS ON THIS SURFACE AT ALL, stated because it was decided against two
   * alternatives: hiding it leaves a pass that composed the wrong rules with no
   * record of why, and putting it on the CARD as an editable field teaches a
   * reader something false — its value set is *which pack files exist*, so a
   * blank means the corpus has no pack for this subject, not that the work has
   * none. The review surface puts it in front of the one person who can act on
   * it, at the one moment acting is cheap: before approve.
   *
   * Null where the proposal carries none, which is the common case and stays
   * common — the corpus ships four members and most cards will carry no subject
   * for a long time.
   */
  subject: string | null;
  /** The target's current status key — null for an un-materialized `add` (it is
   *  not a work item yet); the live status for every proposal that has one. */
  status: string | null;
  /** The target status's own display LABEL, from the project's workflow (bug
   *  MOTIR-3170). Null for an `add`, and for a target whose status the workflow
   *  no longer holds. The canvas chip cannot name a CUSTOM status out of the
   *  `labels.defaultStatus` catalog, so the identity travels beside the key. */
  statusLabel: string | null;
  /** The target status's lifecycle CATEGORY — the chip's fallback tone when the
   *  canvas has no per-key treatment (see `statusLabel`). */
  statusCategory: StatusCategoryDto | null;
  /** Has children in the proposed forest → the canvas can DRILL into it. */
  hasChildren: boolean;
  /** The `modify` diff (old→new) — empty for `add` / `remove`. */
  changes: PlanItemChangeDto[];
  /** This item is flagged stale (`reasons.length > 0`). */
  /**
   * This proposal MOVED in the plan's latest revision (Subtask MOTIR-3601;
   * `design-notes.md` Part XII §E).
   *
   * ⚠️ A RECENCY fact, and NOT the same question `op` answers. `op` says WHICH
   * KIND of change this proposal is; this says THAT this one moved since the
   * reviewer last looked. Orthogonal, exactly as Part IX §L2 holds for the
   * canvas's emphasis — a build must not read either as an alternative to the
   * other.
   *
   * Derived from the trail's `planItemId`, so it needs no column: the rows
   * written between the latest `revision_started` and its terminator name every
   * proposal that revision touched. False on every plan that has never been
   * revised, which is every plan written before this story.
   */
  revised: boolean;

  stale: boolean;
  staleReasons: StaleReason[];
  /** `remove` / drifted `modify`: the live target is archived or hard-deleted. */
  targetMissing: boolean;
  /**
   * What only a PROPOSAL has, for the peek that reads it (MOTIR-4183).
   *
   * ⚠️ ADDITIVE. Every field above keeps its value and its meaning — the canvas
   * node and the list row read none of this and are unchanged by it. The peek is
   * a new READING of the same model, which is the whole shape of this story.
   */
  proposal: PlanProposalPeekDto;
  /**
   * The card's proposed STEPS (MOTIR-4622 · Part XV) — on an `add` that carries
   * them, `null` on a `modify` / `remove` and on an `add` with none.
   *
   * ⚠️ THE SAME ARRAY AS {@link PlanProposalPeekDto.todos}, ASSIGNED FROM ONE
   * LOCAL IN ONE RETURN — not a second computation. `changedFields` three fields
   * up carries the identical warning for the identical reason: two derivations
   * of one fact stay self-consistent on both surfaces while drifting from each
   * other, invisibly. This one is on the ITEM because the review MODEL is what a
   * projection test reads, and on the ENVELOPE because the envelope is what
   * reaches the peek; neither is derived from the other.
   */
  todos: PlanReviewTodoDto[] | null;
  /**
   * WHY the planner proposes this `remove` — `PlanItem.reason`, written by the
   * planner FOR the reviewer and shown verbatim (MOTIR-6055 · `design-notes.md`
   * Part XIX §19.5; AMENDMENT 18 §3). `null` on an `add` / `modify`, and on every
   * `remove` written before the column existed, and `null` draws NOTHING: no
   * empty row, no dash, no band.
   */
  removeReason: string | null;
  /**
   * The older cards an `add` SUPERSEDES — its `supersedesRefs` (MOTIR-6630),
   * resolved to chips (Story MOTIR-6577 · MOTIR-6632, Part XXIV §24.8). `[]` on a
   * `modify` / `remove` (a `modify` carries its edges on the patch, drawn as
   * change rows) and on an `add` with none, and `[]` draws NOTHING — no row, no
   * `Supersedes 0`. OPTIONAL on the type only so hand-built review fixtures stay
   * valid; `getPlanReview` always sets it.
   */
  supersedesRefs?: PlanRefChipDto[];
}

/**
 * The LIFECYCLE half of the timeline's vocabulary — a state the plan REACHED,
 * derived from the `Plan` row's own columns and never stored.
 *
 * `created` / `planned` / `approved`, and the THREE endings a `declined` plan
 * can have — `declined` (a person reviewed it and said no), `discarded` (a
 * person ended it mid-generation) and `abandoned` (the sweep terminated a dead
 * producer).
 *
 * ⚠️ The kind is the EVENT, not the status (MOTIR-3189). All three endings leave
 * `Plan.status = 'declined'`; what separates them is `Plan.decisionReason`, and
 * the timeline is the surface whose whole job is to say what happened. Before
 * this the service pushed one `declined` event for all three and the rail
 * rendered them identically — you could see that a plan ended and not why.
 */
export type PlanLifecycleEventKind =
  | 'created'
  | 'planned'
  | 'approved'
  | 'declined'
  | 'discarded'
  | 'abandoned';

/**
 * A history event on the plan's timeline — a LIFECYCLE transition (above) or,
 * since MOTIR-3536, a CONTENT act somebody performed on the plan.
 *
 * ⚠️ ONE SEQUENCE, ONE SHAPE, and the KIND's own wording is what tells a reader
 * which of the two it is reading (`design/ai-planning/design-notes.md` Part X
 * §2). A lifecycle kind names a state the plan reached; a content kind names an
 * act, and carries a `count` of the proposals it covered. There is deliberately
 * no second treatment, no second dot and no grouping into two blocks: nobody
 * filters this list and nothing acts differently on the two halves, so a second
 * visual language would ask the reader to learn a distinction that pays nothing.
 *
 * ⚠️ THE FOUR DERIVED EVENTS ARE UNCHANGED BY THE WIDENING. Every field this
 * interface gained is optional, and a lifecycle event sets none of them — so a
 * plan created before the trail existed produces exactly the event list it
 * produced before, which is the state EVERY pre-existing plan is in.
 */
export interface PlanHistoryEventDto {
  /**
   * A stable per-EVENT identity — the revision's own id for a stored event,
   * `lifecycle:<kind>` for a derived one.
   *
   * It exists because the rail keyed its rows by `kind`, which was unique only
   * for as long as each kind occurred at most once. Content events repeat, and
   * React then reconciles a list of duplicate keys (measured while drawing the
   * asset: eight events with a repeated kind render, and log *"Encountered two
   * children with the same key"*).
   */
  id: string;
  /** A lifecycle transition, or a stored content act (`appended`, `edited`, …). */
  kind: PlanLifecycleEventKind | string;
  /** ISO timestamp, or null for a not-yet-reached event (the pending decision). */
  at: string | null;
  /**
   * A collapsed RUN's LAST instant, `at` being its first — rendered as a span in
   * the same slot a single event's timestamp uses. Absent on every event that is
   * not a collapsed run (Part X §5).
   */
  until?: string | null;
  /** How many PROPOSALS a content event covered. Absent on a lifecycle event. */
  count?: number;
  /** The actor's display name — the decider on a decision event, the acting
   *  person on a content one. Null when nobody acted as a person. */
  byName?: string | null;
  /**
   * WHICH AGENT acted, when one did (Part X §4). `actorSource` picks the KIND of
   * label — `mcp` renders the harness, `native` renders Motir — and `actorModel`
   * is deliberately NOT rendered on a row: measured at the rail's 298px text
   * column, the model costs every row a second line, and the header carries it
   * once already. It rides the DTO so the row can carry it as a `title`.
   */
  actorSource?: PlanAuthorSourceDto | null;
  actorHarness?: string | null;
  actorModel?: string | null;
}

/** The whole plan-detail review model. */
/**
 * A revision in flight, as the review surface reads it (Subtask MOTIR-3601).
 *
 * Present ⟺ the lease is HELD. There is no `inFlight: false` shape, deliberately:
 * a null is one check at the call site and cannot be misread as *a revision that
 * finished*, which a `{ inFlight: false }` object routinely is.
 */
export interface PlanRevisionStateDto {
  /** The harness running it, when the trail recorded one. */
  heldBy: string | null;
  /** When the lease ages out if the job never reports back — the ONLY thing that
   *  recovers a plan whose revision job died. */
  expiresAt: string;
  /** WHEN it started, so the surface can say how long it has been running. */
  startedAt: string;
}

/** A plan's gate as the planning surface reads it (MOTIR-6038) — see
 *  {@link PlanReviewDto.gate}. */
export interface PlanReviewGateDto {
  id: string;
  state: ApprovalGateStateDTO;
  /** The stamp a press hands back — null unless the gate is `awaiting`. */
  stamp: string | null;
  /** Why an `awaiting` gate refuses both verbs right now (a revision in flight). */
  held: PlanGateHeldDTO | null;
  /** Whether THIS reader holds the plan's decide permission (`ai:decide_plan`). */
  canDecide: boolean;
  /** WHO the gate was routed to — the see-but-not-decide line's *Waiting on {name}*
   *  (MOTIR-6037; design Part XXII §22.5). Null when nobody resolves. OPTIONAL on the
   *  type for the same fixture reason as {@link PlanReviewDto.gate}. */
  routedToName?: string | null;
}

/**
 * THE PLAN'S CONVERSATION, as the decision surfaces read it (Story MOTIR-6012 ·
 * MOTIR-6037; design Part XXII §22.2, §22.5): whether the plan has a planning session with
 * turns to return to, and what it targeted. A plan with none opens on its own page,
 * which says why; one with a conversation is reopened on the planning surface.
 */
export interface PlanConversationDto {
  sessionId: string;
  /** The session has at least one turn — an agent-authored MCP plan's may have none. */
  hasTurns: boolean;
  /** The session's `targetKeys`, in stored order. */
  targetKeys: string[];
}

/**
 * A COMMITTED edge whose disposition this plan changes (MOTIR-6362): its parents'
 * edge is one a `modify` adds (`blockedByAdd`) or removes (`blockedByRemove`), so
 * the roadmap read's verdict on it is stale for the level the plan leaves behind.
 * The review canvas overrides the committed edge's `coverage` with this one.
 */
export interface PlanEdgeCoverageDto {
  blockedId: string;
  blockerId: string;
  coverage: EdgeDisposition;
}

export interface PlanReviewDto {
  id: string;
  projectId: string;
  status: PlanStatusDto;
  title: string | null;
  summary: string | null;
  /**
   * The LIVE summaries of the work items `summary` links to with
   * `[KEY](motir:<id>)` (bug MOTIR-9697), keyed by work-item id — the map both
   * surfaces that draw the briefing (`PlanReviewRail`, `PlanChangeRail`'s
   * briefing bubble) render its chips from.
   *
   * Resolved in the SAME batched read as each proposal's `workItemRefs`
   * (`planReviewService.getPlanReview`), for the reader, so a Visitor gets the
   * no-access summary and never a title. Before it, the rail rendered the summary
   * with no map and the overlay with the chat session's turn-only map, so every
   * link was drawn as a deleted card. An id that resolves to nothing is absent,
   * which is the struck-through state a genuinely deleted card owes.
   *
   * Optional only for the hand-built reviews tests construct; the plan-review
   * read always sets it.
   */
  summaryRefs?: WorkItemRefMap;
  itemCount: number;
  createdAt: string;
  plannedAt: string | null;
  decidedAt: string | null;
  /** The decider's display name, resolved from `decidedById`. */
  decidedByName: string | null;
  /**
   * WHY a `declined` plan ended (MOTIR-3189) — what the outcome block reads to
   * avoid telling a reader their half-generated plan was reviewed and rejected.
   *
   * Null on every plan that is not `declined`, and on a `declined` row written
   * before the column existed. A null is *not recorded*, so the surface falls
   * back to the plain declined wording rather than inventing a reason.
   */
  decisionReason: PlanDecisionReasonDto | null;
  /**
   * The plan's THREE-party attribution (Story MOTIR-2982 · MOTIR-2991) — see
   * `design/ai-planning/design-notes.md` Part III.
   *
   * The detail is fed by THIS shape, not by `PlanDto`, so the fields have to be
   * carried here as well: without them the header has nothing to render however
   * complete the carrier is.
   *
   * `createdByName` is resolved from `Plan.createdById` the same way
   * `decidedByName` is; `authorSource` alone answers WHO WROTE it — `mcp` is an
   * agent, `native` is Motir (MOTIR-2996) — and *nobody asked* is
   * `origin === 'cadence'`.
   *
   * ⚠️ `sourceJobId` used to be carried here purely so the header could tell a
   * Motir generation from an unattributed plan, back when the generator recorded
   * no author. It is GONE (MOTIR-2996): the generator records `native · Motir`,
   * so the fact has one source rather than two, and the DTO no longer ships a
   * field whose only reader was an inference.
   *
   * ⚠️ Unlike the LIST row, the header keeps the requester on a DECIDED plan: it
   * names the roles in words, and its decider lives in `history` below rather
   * than in the same line, so neither reason the row drops it applies here.
   */
  origin: PlanOriginDto;
  createdByName: string | null;
  authorSource: PlanAuthorSourceDto | null;
  authorHarness: string | null;
  authorModel: string | null;
  /** The lifecycle timeline (created → planned → decision). */
  history: PlanHistoryEventDto[];
  /** The proposed items, enriched for the canvas. */
  /**
   * The REVISION the reviewer is watching, or null when none is running (Story
   * MOTIR-3595 · Subtask MOTIR-3601; `design/ai-planning/design-notes.md`
   * Part XII §C).
   *
   * ⚠️ DERIVED FROM THE PLAN'S OWN TRAIL — no column, no table. A
   * `revision_started` with no `revision_ended` after it, inside the lease
   * window, IS the lease (`agent-authored-plans.md` AMENDMENT 10 D2), and it is
   * the same pair the timeline renders. So the surface that must disable Approve
   * and the surface that tells the reviewer WHY read one fact from one place.
   *
   * `heldBy` is the HARNESS, never the model — the discriminator Part X §4 fixed
   * for the timeline clause, reused here for the same reason: a harness name is
   * what a reader recognises and a model is one level of detail below what a
   * held button needs to say.
   */
  revision: PlanRevisionStateDto | null;

  /**
   * WHEN anything last happened to the plan (Story MOTIR-7820 · MOTIR-7822) —
   * stamped by every planner step signal and every content write, never by a
   * decision. What tells a stalled plan from a busy one. OPTIONAL on the type
   * only so hand-built review fixtures stay valid; `getPlanReview` always sets it.
   */
  lastActivityAt?: string;
  /**
   * THE REVIEW'S VERSION TOKEN (MOTIR-8127) — set while the plan is `generating`, the only status
   * a client polls. Hand it back as `?since=` and the read answers {@link PlanReviewUnchangedDto}
   * instead of the whole review when nothing the review shows has moved. It is read BEFORE the
   * review's own reads, so a write that lands in between makes the next poll read in full rather
   * than skip it. Opaque: compare it, never parse it. OPTIONAL on the type only so hand-built
   * review fixtures stay valid.
   */
  reviewVersion?: string;
  /**
   * The step each RUNNING planner session is on, oldest first (MOTIR-7822) — raw
   * refs as the planner sent them. ALWAYS `[]` when the plan is not
   * `generating`, so a session that never cleared cannot outlive its plan on any
   * surface. OPTIONAL on the type only so hand-built review fixtures stay valid;
   * `getPlanReview` always sets it.
   */
  inFlightSteps?: PlanStepDto[];
  /**
   * The plan's PROGRESS — the ONE derivation's server half (Story MOTIR-7820 ·
   * MOTIR-7825; `lib/plans/planProgress.ts`): the steps resolved to phrases and
   * titles (withdrawn targets dropped, untargeted steps kept), N of M authored,
   * the start, the last activity and the server instant it was built at.
   * NON-NULL EXACTLY while the plan is `generating`. A surface reads it through
   * `readPlanProgress(progress, serverNow(…))` and derives nothing itself.
   * OPTIONAL on the type only so hand-built review fixtures stay valid;
   * `getPlanReview` always sets it.
   */
  progress?: PlanProgressSnapshot | null;

  /**
   * THE PLAN'S QUESTION — its latest `plan_approval` gate, as the render read returns it
   * (Story MOTIR-6012 · MOTIR-6038; ADR `approval-gates.md` §11.3, §11.5c, §11.8). Null
   * when the plan has none: a `generating` plan, an empty close, or a `planned` plan
   * from before the raise shipped — which every entrance refuses as *not decidable yet*.
   *
   * ⚠️ `stamp` IS WHAT A PRESS HANDS BACK. Approve and Decline send it with the press
   * (`approvePlanRequest` / `declinePlanRequest`), and the decide door refuses a stamp
   * taken before the proposals moved (a revision, a correction) as stale. It is null
   * unless the gate is `awaiting`. OPTIONAL on the type only so hand-built review
   * fixtures that predate it stay valid; `getPlanReview` always sets it.
   */
  gate?: PlanReviewGateDto | null;

  /**
   * THE PLAN'S CONVERSATION (MOTIR-6037) — null when the plan has no planning session.
   * OPTIONAL on the type only so hand-built review fixtures stay valid;
   * `getPlanReview` always sets it.
   */
  conversation?: PlanConversationDto | null;

  /**
   * THE PLANNER'S NARRATION (MOTIR-8063) — every planner session's step words
   * plus the newest `PLAN_NARRATION_READ_WINDOW` sentences, at EVERY status (unlike
   * `inFlightSteps`): it is kept history, readable after a session ends and after
   * the plan is decided. A plan with none carries
   * `{ sessions: [], entries: [], earlierCount: 0 }`. Earlier sentence pages come
   * from `GET /api/plans/[id]/narration` (`fetchPlanNarrationPage`). OPTIONAL on
   * the type only so hand-built review fixtures stay valid; `getPlanReview`
   * always sets it.
   */
  narration?: PlanNarrationReadDto;

  items: PlanReviewItemDto[];
  /** The committed edges this plan re-judges (MOTIR-6362) — see
   *  {@link PlanEdgeCoverageDto}. Optional: absent from an older server, and empty
   *  on a decided plan. */
  edgeCoverage?: PlanEdgeCoverageDto[];
  /** Roll-up: any item is stale (the plan-level "N may be out of date"). */
  stale: boolean;
  /** How many items are stale (the summary count). */
  staleCount: number;

  /**
   * HOW MANY NODES THE ARRIVAL LEVEL DRAWS (MOTIR-4024, design Part XIII §6) —
   * the committed siblings the level read will return, plus the plan's own
   * proposals under that container.
   *
   * ⚠️ THE CLIENT CANNOT COMPUTE IT. `defaultPlanView` runs before the canvas has
   * fetched anything, and the answer is about the level's COMMITTED
   * neighbourhood, which the plan's own items say nothing about. So it is read
   * once here, where the level's container is already resolved.
   *
   * Read by `defaultPlanView` (`lib/planning/planView.ts`) and by nothing else.
   * It is the level's TOTAL, not the plan's share of it: the arrival SCALE is a
   * function of how many nodes the canvas DRAWS, and a plan of three cards under
   * a container of two hundred is exactly the case the rule exists for.
   */
  arrivalLevelSize: number;
  /**
   * The same level's UNTRUNCATED size — what it holds before
   * `TREE_LEVEL_MAX_TAKE` caps the read (MOTIR-4024, Part XIII §6, second arm).
   *
   * The level read sorts key-ASCENDING and discards the HIGHEST keys, which are
   * the most recently created cards — and a `modify` or `remove` targets a
   * committed work item, so the cards a plan is most likely to be about are
   * exactly the ones truncation drops. Past the cap the canvas can draw two
   * hundred cards, ring none of them, and show a reviewer a plan whose subject is
   * not on the screen.
   */
  arrivalLevelTotal: number;
}

/**
 * What `GET /api/plans/[id]?since=<token>` answers when the plan is `generating` and the token is
 * still current (MOTIR-8127): a few bytes in place of the whole review. The client keeps the
 * snapshot it already holds.
 */
export interface PlanReviewUnchangedDto {
  unchanged: true;
  reviewVersion: string;
}
