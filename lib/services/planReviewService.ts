import { createHash } from 'node:crypto';
import type { PlanStatus, WorkItem } from '@/generated/prisma/client';

import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemLinkRepository } from '@/lib/repositories/workItemLinkRepository';
import { workItemTodoRepository } from '@/lib/repositories/workItemTodoRepository';
import { fullestContainer } from '@/lib/planning/planShape';
import { TREE_LEVEL_MAX_TAKE } from '@/lib/planning/levelCaps';
import { userRepository } from '@/lib/repositories/userRepository';
import { planRevisionRepository } from '@/lib/repositories/planRevisionRepository';
import { planStepRepository } from '@/lib/repositories/planStepRepository';
import { planProgressService } from '@/lib/services/planProgressService';
import {
  toPlanNarrationDto,
  toPlanNarrationSessionDto,
  toPlanStepDto,
} from '@/lib/mappers/planMappers';
import { planNarrationRepository } from '@/lib/repositories/planNarrationRepository';
import { PLAN_NARRATION_READ_WINDOW } from '@/lib/plans/planNarration';
import {
  DERIVED_EVENT_KINDS,
  TRAIL_ONLY_KINDS,
  mergeTimeline,
  revisionCount,
} from '@/lib/plans/timeline';
import { redactNativeActor, redactNativeProvenance } from '@/lib/plans/redactNativeModel';
import {
  revisionLeaseOf,
  REVISION_STARTED_KIND,
  REVISION_ENDED_KIND,
} from '@/lib/planChange/revisionLease';

import { plansService } from '@/lib/services/plansService';
import { buildProjection, projectedEdgeDisposition } from '@/lib/services/planProjectionService';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import {
  allClearStaleness,
  planStalenessService,
  planStatusCanBeStale,
} from '@/lib/services/planStalenessService';
import { workflowsService } from '@/lib/services/workflowsService';
import { resolveWorkItemRefSummaries } from '@/lib/workItems/resolveWorkItemRefs';
import { parseWorkItemTokenIds } from '@/lib/mentions/workItemRefs';
import { planStatusChangeOf } from '@/lib/plans/planStatusRow';
import { planTargetLockRepository } from '@/lib/repositories/planTargetLockRepository';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';

import type {
  PlanItemDto,
  PlanItemPatch,
  PlanItemProposedFields,
  PlanNarrationPageDto,
  PlanNarrationReadDto,
  PlanWithItemsDto,
  StaleReason,
} from '@/lib/dto/plans';
import type { ExecutorDto, WorkItemRefMap, WorkItemTypeDto } from '@/lib/dto/workItems';
import { resolveExecutor } from '@/lib/issues/executorDefaults';
import { isContainerKind } from '@/lib/plans/validateProposedKind';
import type { PlanRevision, Prisma } from '@/generated/prisma/client';
import { planRepository } from '@/lib/repositories/planRepository';
import {
  isMarkChangeField,
  OBSOLESCENCE_CURRENT,
  PLAN_ITEM_SETTABLE_RAIL_FIELDS,
} from '@/lib/dto/planReview';
import type {
  PlanBlockerStubDto,
  PlanCommittedBlockerDto,
  PlanEdgeCoverageDto,
  PlanFolderCrumbDto,
  PlanHistoryEventDto,
  PlanItemChangeDto,
  PlanItemChangeField,
  PlanParentCrumbDto,
  PlanPlacementSideDto,
  PlanRefChipDto,
  PlanReviewDto,
  PlanReviewUnchangedDto,
  PlanConversationDto,
  PlanReviewGateDto,
  PlanReviewItemDto,
  PlanReviewTodoDto,
} from '@/lib/dto/planReview';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { visitorServiceContext, type VisitorReadContext } from '@/lib/visitor/context';
import { isVisitorContext, openVisitorRead } from '@/lib/visitor/readScope';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { PlanNotFoundError } from '@/lib/plans/errors';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { folderRepository } from '@/lib/repositories/folderRepository';
import { folderRefId, isFolderRef, isTempRef, SUPERSEDES_PATCH_SITES } from '@/lib/plans/refs';
import type { WorkItemObsolescenceDto } from '@/lib/dto/workItems';

// The plan-detail READ assembly (Story 7.21 · Subtask 7.4.5 / MOTIR-847). A pure
// READ orchestrator: it composes the substrate's own reads — `getPlan`
// (MOTIR-1336) + `computePlanStaleness` (MOTIR-1340) — and enriches each
// proposed item with what the canvas needs to DRAW it: the live target's fields
// (the OLD side of a `modify` diff, the node identity of a `modify`/`remove`),
// the proposed forest's parent/blocker node ids (refs resolved), and the
// decider's NAME for the history timeline. No writes, no transaction; the live
// targets load in ONE batched, workspace-scoped read (no N+1). It NEVER reads the
// 7.4 generation stream — the "live while generating" UI re-calls this read
// (poll), so 7.21 keeps no dependency on 7.4.

const TEMP_REF_PREFIX = 'planItem:';

/** Resolve a PlanItem ref to a canvas node id: an intra-plan temp-ref
 *  (`planItem:<id>`) → the referenced add's node id; a real work-item id → itself. */
function resolveRef(ref: string): string {
  return ref.startsWith(TEMP_REF_PREFIX) ? ref.slice(TEMP_REF_PREFIX.length) : ref;
}

/**
 * The folder a proposal NAMES as its placement (MOTIR-5415): the id inside an
 * `add`'s `parentRef` or a `modify`'s `patch.parentRef` when that ref is
 * `folder:<id>`; `null` when the proposal names a NON-folder placement (a work
 * item, a temp-ref, or the root); `undefined` when it names no placement at
 * all — a `remove`, or a `modify` that leaves its target where it is.
 */
function namedFolderIdOf(item: PlanItemDto): string | null | undefined {
  if (item.parentRef) return isFolderRef(item.parentRef) ? folderRefId(item.parentRef) : null;
  if (item.op === 'modify' && item.patch?.parentRef !== undefined) {
    const ref = item.patch.parentRef;
    return ref !== null && isFolderRef(ref) ? folderRefId(ref) : null;
  }
  return undefined;
}

/**
 * How much of a long prose body the diff cell carries per side (bug MOTIR-3191).
 *
 * A PREVIEW rather than the whole body, and the bound is deliberate: the review
 * model is read on every poll of a `generating` plan, and a plan of thirty
 * `modify` proposals would otherwise put sixty full descriptions on the wire to
 * fill two truncated cells. 140 characters is roughly the first sentence, which
 * is where a rewritten description tells you it was rewritten.
 */
const PROSE_PREVIEW_CHARS = 140;

/**
 * One long Markdown body as a single readable line: whitespace squeezed (a body
 * is multi-paragraph and the cell is one line) and cut at
 * {@link PROSE_PREVIEW_CHARS}. `null` for an absent or blank body, which is what
 * the diff cell renders as "nothing there before".
 */
function prosePreview(value: string | null | undefined): string | null {
  if (value == null) return null;
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return null;
  return flat.length > PROSE_PREVIEW_CHARS ? `${flat.slice(0, PROSE_PREVIEW_CHARS - 1)}…` : flat;
}

/** A repo pin as the APPROVE will store it: a blank / whitespace-only string is
 *  an UNPIN, exactly as `PlanItemPatch.targetRepo` documents and as
 *  `resolveAuthoredTargetRepoInProject` applies it (MOTIR-3868). Diffing the raw
 *  string instead would render `motir-core → "  "` as a change to a repository
 *  whose name is two spaces, and would report a no-op unpin of an already-null
 *  pin as a change. */
function blankToNull(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * A content BODY the proposal is ASKING FOR — on EVERY op (bug MOTIR-4134).
 *
 * This is the same question `title` answers (MOTIR-4018, its comment at the
 * call site), applied to the two fields a reviewer actually reads. Both used to
 * be `item.op === 'add' ? proposed : null`, which was COHERENT while the DTO fed
 * only the canvas node and the list row: neither reads the flat bodies — a
 * change is SPELLED through `changes[]` — so a flat field would have been a
 * second, staler copy. It stopped being coherent when a list row became a door
 * onto `ProposalQuickView`, which renders the flat bodies INLINE and has no diff
 * rendering at all. A `modify` opened there read *"No description yet."* /
 * *"No explanation yet."* over a patch carrying both, rewritten — on the one
 * surface whose whole purpose is to be read before somebody presses Approve, and
 * for the op the whole re-plan path is made of.
 *
 * ⚠️ THE TEST IS PRESENCE (`!== undefined`), NOT NULLISHNESS (`??`), and that is
 * the one place this may NOT copy `title`. `PlanItemPatch.title` is `string`, so
 * `?? target?.title` is exactly right there. Both bodies are `string | null`,
 * and the patch is SPARSE with the two meanings `applyModify` and `buildChanges`
 * already give it: absent leaves the body untouched, an explicit `null` CLEARS
 * it. Under `??` an explicit `null` would fall through to the target's CURRENT
 * body — showing the reviewer the text approval is about to DELETE, as the text
 * approval is about to keep. That is this bug's own failure mode inverted, so it
 * would ship as the fix for it.
 *
 * A `remove` reports the target's bodies, which are the only ones it has — the
 * same rule `title` follows, and what makes the archive a reviewer is being
 * asked to approve legible at all.
 */
function proposedBody(
  key: 'descriptionMd' | 'explanationMd',
  item: PlanItemDto,
  proposed: PlanItemProposedFields | null,
  target: WorkItem | undefined,
): string | null {
  return proposedValue(key, item, proposed?.[key] ?? null, target?.[key] ?? null);
}

/**
 * THE VALUE THIS PROPOSAL IS ASKING FOR — the rule {@link proposedBody} states
 * at length, as one function, for every field that has one (bug MOTIR-4143).
 *
 * `add` → what the proposal proposes. `modify` → the patch's value when the
 * patch CARRIES the key, else the target's live value. `remove` → the target's.
 * The caller supplies both ends already narrowed, so each field keeps its own
 * type and its own conversion (a `Decimal` target, a column that no longer
 * exists) instead of this function knowing about any of them.
 *
 * ⚠️ PRESENCE (`!== undefined`), NOT NULLISHNESS. The patch is SPARSE and an
 * explicit `null` CLEARS a field, so `??` would fall through to the value
 * approval is about to DELETE and show it as the value approval will keep.
 * `applyModify` and `buildChanges` test presence for the same reason.
 *
 * ⚠️ WHY THE RAIL FIELDS NOW COME THROUGH HERE, HAVING BEEN add-ONLY UNTIL NOW.
 * The reason they were gated is written out in
 * `tests/dto/planReviewFieldParity.test.ts` and it was a real one: these are
 * RAIL rows, the rail has no old→new affordance, and a change to any of them IS
 * shown to the approver — in the `changes` diff, which is built to show two
 * sides at once. That argument holds for the LIST ROW, which renders the diff.
 * It does not hold for `ProposalQuickView`, which renders NO diff at all and is
 * the only surface these fields reach: on a `modify` the whole rail collapsed to
 * the one field that was never gated (`parentIdentifier`), so the surface a
 * person approves from showed a re-scoped, re-pinned, re-typed card as a single
 * Parent row. Reported from the running app (MOTIR-4143).
 *
 * The accepted cost, stated rather than discovered: a rail row does not say
 * whether the value it shows is proposed or unchanged. The card's header names
 * the op and the list spells the diff — and *the value this card will have* is
 * strictly more than the nothing it showed before.
 */
function proposedValue<T>(key: PatchedFieldKey, item: PlanItemDto, addValue: T, targetValue: T): T {
  if (item.op === 'add') return addValue;
  if (item.op === 'modify') {
    const patched = item.patch?.[key];
    if (patched !== undefined) return patched as T;
  }
  return targetValue;
}

/** An ordered repository set as ONE diff cell — `null` for the empty set, which
 *  is what an unpinned card looks like on either side of a re-pin. */
function repoSetCell(repos: readonly string[]): string | null {
  const named = repos.map((r) => r.trim()).filter((r) => r.length > 0);
  return named.length === 0 ? null : named.join(', ');
}

/** The patch keys that name a value a reviewer reads back off the proposal. */
type PatchedFieldKey = Extract<
  keyof PlanItemPatch,
  | 'descriptionMd'
  | 'explanationMd'
  | 'priority'
  | 'type'
  | 'storyPoints'
  | 'estimateMinutes'
  | 'difficulty'
  | 'targetRepo'
  | 'targetRepos'
  | 'targetRepoRole'
>;

/**
 * The executor a `modify` leaves its target with (bug MOTIR-6259): the target's
 * own, unless the patch re-types a target that has none — then the type's
 * default, by `resolveExecutor`, the one rule `applyModify` and the direct door
 * both write through. `null` when there is no target to read.
 */
function seededExecutor(
  patch: PlanItemPatch | null,
  target: WorkItem | undefined,
): ExecutorDto | null {
  const current = (target?.executor ?? null) as ExecutorDto | null;
  if (!target || !patch) return current;
  // A RE-KIND to a container DERIVES it to `null` (bug MOTIR-8192 · AMENDMENT
  // 25) — `applyModify` clears it beside the `kind` write.
  if (patch.kind !== undefined && patch.kind !== target.kind && isContainerKind(patch.kind)) {
    return null;
  }
  if (patch.type === undefined) return current;
  return resolveExecutor((patch.type ?? null) as WorkItemTypeDto | null, undefined, current);
}

/** The OLD → NEW field changes a `modify` proposes (its diff overlay).
 *
 *  `nameParent` renders a parent id as the reader's own word for it — the
 *  identifier where one is resolvable, `null` for the project root — so the
 *  re-parent row reads `PROD-14 → PROD-9` rather than as two cuids (MOTIR-3859).
 */
function buildChanges(
  patch: PlanItemPatch | null,
  target: WorkItem | undefined,
  nameParent: (id: string | null) => string | null,
  statusByKey: ReadonlyMap<string, WorkflowStatusDto>,
  placementSides: PlacementSides,
  refChipOf: (ref: string) => PlanRefChipDto,
  targetTodos?: { total: number; done: number },
  statusContext: {
    /** The target's park — whose holder moved it to `planning`, and from where. */
    park?: { priorStatus: string; statusHeld: boolean; planId: string | null } | undefined;
    /** Whether this plan lays children under the target too. */
    gainsChildren: boolean;
  } = { gainsChildren: false },
): PlanItemChangeDto[] {
  if (!patch) return [];
  // Typed to the CLOSED wire vocabulary, so a new `field:` literal here is a
  // compile error until it is added to `PLAN_ITEM_CHANGE_FIELDS` — which is what
  // `plan-change-field-labels.test.tsx` then demands copy for. MOTIR-1532 added
  // two of these and their labels never followed (MOTIR-3151); nothing on this
  // path could have noticed.
  const changes: (PlanItemChangeDto & { field: PlanItemChangeField })[] = [];
  if (patch.title !== undefined && patch.title !== target?.title) {
    changes.push({ field: 'title', from: target?.title ?? null, to: patch.title });
  }
  if (patch.priority !== undefined && patch.priority !== (target?.priority ?? null)) {
    changes.push({ field: 'priority', from: target?.priority ?? null, to: patch.priority ?? null });
  }
  // A RE-KIND (bug MOTIR-8192 · AMENDMENT 25) — `Kind  task → story`, read live
  // from the target on the left. Directly before `type`, the leaf field a
  // container re-kind must clear in the same patch.
  if (patch.kind !== undefined && patch.kind !== (target?.kind ?? null)) {
    changes.push({ field: 'kind', from: target?.kind ?? null, to: patch.kind });
  }
  if (patch.type !== undefined && patch.type !== (target?.type ?? null)) {
    changes.push({ field: 'type', from: target?.type ?? null, to: patch.type ?? null });
  }
  // THE SEEDED EXECUTOR (bug MOTIR-6259) — no patch key produces it; the approve
  // DERIVES it, through the SAME `resolveExecutor` `applyModify` calls, so this
  // row and the write cannot disagree. It appears only when a re-type lands on a
  // target with no executor, which is exactly when the approve will write one.
  const seeded = seededExecutor(patch, target);
  if (seeded !== (target?.executor ?? null)) {
    changes.push({ field: 'executor', from: target?.executor ?? null, to: seeded });
  }
  // Leaf sizing re-scope (MOTIR-1532) — surface it so the approver SEES the new
  // points/estimate before approving. `storyPoints` is a Prisma Decimal on the
  // target; compare + render it numerically (as a string, the change-cell shape).
  const targetPoints = target?.storyPoints == null ? null : Number(target.storyPoints);
  if (patch.storyPoints !== undefined && patch.storyPoints !== targetPoints) {
    changes.push({
      field: 'storyPoints',
      from: targetPoints === null ? null : String(targetPoints),
      to: patch.storyPoints === null ? null : String(patch.storyPoints),
    });
  }
  if (
    patch.estimateMinutes !== undefined &&
    patch.estimateMinutes !== (target?.estimateMinutes ?? null)
  ) {
    changes.push({
      field: 'estimateMinutes',
      from: target?.estimateMinutes == null ? null : String(target.estimateMinutes),
      to: patch.estimateMinutes === null ? null : String(patch.estimateMinutes),
    });
  }
  // A leaf's DIFFICULTY (story MOTIR-6095 · MOTIR-6137, design Part XX §20.5) —
  // the sizing group's third member, so it follows `estimateMinutes`. The cells
  // carry the WIRE words (`low`, `high`); every surface renders them as the item
  // page's labels (`labels.difficulty.*`), so the reviewer reads `Low → High` in
  // their own locale. Presence-triggered like its siblings: an explicit `null`
  // CLEARS it and reads `Medium → —`.
  if (patch.difficulty !== undefined && patch.difficulty !== (target?.difficulty ?? null)) {
    changes.push({
      field: 'difficulty',
      from: target?.difficulty ?? null,
      to: patch.difficulty ?? null,
    });
  }
  if (
    patch.descriptionMd !== undefined &&
    patch.descriptionMd !== (target?.descriptionMd ?? null)
  ) {
    // ⚠️ A REAL old→new pair, not the word "updated" (bug MOTIR-3191). This cell
    // used to read `— → updated`, which is a notification rather than a diff: it
    // told a reviewer that the half of the card they most need to judge had moved
    // and refused to say where to. Panel B of `design/ai-planning/design-notes.md`
    // has always specified *"an inline old→new diff (old read live from the
    // target, new from `patch`)"* for a `modify`, and prose is the one field that
    // never honoured it. It is a PREVIEW of each side (see `prosePreview`) — the
    // cell is one line — but it is a preview of the ACTUAL values.
    changes.push({
      field: 'description',
      from: prosePreview(target?.descriptionMd),
      to: prosePreview(patch.descriptionMd),
    });
  }
  // …and the SECOND body (MOTIR-3111). Same treatment as the description above —
  // long prose, so each side is previewed. It is listed because the
  // explanation is the half a reviewer reads to decide whether a proposed
  // re-shape is right: a `modify` that silently rewrote the WHY while the review
  // surface showed nothing would defeat the point of putting the plan in front of
  // a person at all.
  if (
    patch.explanationMd !== undefined &&
    patch.explanationMd !== (target?.explanationMd ?? null)
  ) {
    changes.push({
      field: 'explanation',
      from: prosePreview(target?.explanationMd),
      to: prosePreview(patch.explanationMd),
    });
  }
  // THE STEPS a `modify` REPLACES (MOTIR-8668 · AMENDMENT 27) — the row that
  // makes D2's cost visible instead of forbidden. FROM is the live list as a
  // count, with how many of those steps are ticked (`5 (2 ✓)`), because ticked
  // rows are a person's progress and the replacement deletes them; TO is the new
  // list itself, numbered, previewed like a body, so the reviewer reads WHICH
  // steps rather than how many. A clear (`[]` / `null`) is an empty NEW side.
  if (patch.todos !== undefined) {
    const total = targetTodos?.total ?? 0;
    const done = targetTodos?.done ?? 0;
    const incoming = patch.todos ?? [];
    if (total > 0 || incoming.length > 0) {
      changes.push({
        field: 'todos',
        from: total === 0 ? null : done > 0 ? `${total} (${done} ✓)` : String(total),
        to: prosePreview(incoming.map((t, i) => `${i + 1}. ${t.text}`).join(' · ')),
      });
    }
  }
  // WHERE THE CARD SITS (MOTIR-3859) — the SITS half of D3's pair, and the most
  // structural thing a `modify` can now say. It is listed for the same reason the
  // explanation is: routing a re-parent through the proposal door buys nothing at
  // all if the surface the approver reads does not show the move. An explicit
  // `null` renders as an empty NEW side, which is what "the project root" looks
  // like in a diff cell.
  //
  // A FOLDER can sit on either side now (MOTIR-5415): `patch.parentRef` may name
  // `folder:<id>`, and the target may be filed. So each side is resolved TYPED —
  // root / work item / folder — and the row carries both in `placement`, which
  // is what lets the surface label it `Placement` and draw the folder glyph
  // (`design-notes.md` Part XVII §17.4). The `from` / `to` words keep their old
  // meaning for a work-item → work-item move, byte for byte. A move that
  // involves a folder LEADS the list, so a card's one diff line is spent on it.
  let leadingPlacement: PlanItemChangeDto | null = null;
  if (patch.parentRef !== undefined) {
    const fromSide = placementSides.current(target);
    const toSide = placementSides.proposed(patch.parentRef ?? null);
    if (placementKey(fromSide) !== placementKey(toSide)) {
      const row: PlanItemChangeDto & { field: PlanItemChangeField } = {
        field: 'parent',
        from: placementWord(fromSide, nameParent),
        to: placementWord(toSide, nameParent),
        placement: { from: fromSide, to: toSide },
      };
      if (fromSide.kind === 'folder' || toSide.kind === 'folder') leadingPlacement = row;
      else changes.push(row);
    }
  }
  // WHERE THE CARD SHIPS (MOTIR-1884 / MOTIR-1912, surfaced by bug MOTIR-3868) —
  // the SHIPS half of the pair `parent` above completes. Both keys reached
  // `applyModify` and neither reached this producer, so a `modify` carrying only
  // a re-pin rendered with an EMPTY change list. That is silent in the direction
  // that hides it: an empty `changes` array is a legal, ordinary shape (a
  // `remove` has one), so nothing rendered wrong and nothing failed — the
  // approver's only options were to approve a change they could not see or
  // decline a plan that may have been entirely correct.
  //
  // Blank normalizes to null, mirroring the patch's own documented contract
  // (*"an explicit `null` (or a blank string, which normalizes to `null`)
  // UNPINS"*) and `resolveAuthoredTargetRepoInProject`, which is what actually
  // applies it — so the cell renders the value the approve will write, not the
  // string that was typed. An explicit unpin is an empty NEW side.
  if (patch.targetRepo !== undefined) {
    const from = blankToNull(target?.targetRepo ?? null);
    const to = blankToNull(patch.targetRepo);
    if (from !== to) changes.push({ field: 'targetRepo', from, to });
  }
  // …and the SET forms of the same axis (bug MOTIR-4904), on the SAME row. They
  // are one field in three spellings, mutually exclusive at the append, so at
  // most one of these three blocks can fire for any one patch.
  //
  // Rendered as the joined list rather than as a count: a reviewer approving a
  // re-pin needs to read WHICH repositories, and "2 repositories" is MOTIR-3191's
  // `— → updated` with a number in it. `targetRepositories` names ROWS, whose
  // names this producer cannot resolve without a read it does not make — so the
  // cell shows the ids and says so, which is worse to read and better than
  // silence, the failure MOTIR-3868 was filed about.
  if (patch.targetRepos !== undefined) {
    const from = repoSetCell(target?.targetRepos ?? []);
    const to = repoSetCell(patch.targetRepos);
    if (from !== to) changes.push({ field: 'targetRepo', from, to });
  }
  if (patch.targetRepositories !== undefined) {
    changes.push({
      field: 'targetRepo',
      from: repoSetCell(target?.targetRepos ?? []),
      to: repoSetCell(patch.targetRepositories.map((id) => `row ${id}`)),
    });
  }
  // …and the singular ROW-ID pin (Story MOTIR-2732 · MOTIR-3045, surfaced by
  // MOTIR-4924), the `modify` mirror of the `add` path's `targetRepositoryRef`.
  // Same presence-triggered row as the SET form directly above: it cannot resolve
  // the ref to a name without a read it does not make, so the cell shows the id
  // and says so — worse to read and better than silence, the failure MOTIR-3868
  // was filed about.
  if (patch.targetRepositoryRef !== undefined) {
    changes.push({
      field: 'targetRepo',
      from: repoSetCell(target?.targetRepos ?? []),
      to: patch.targetRepositoryRef == null ? null : `row ${patch.targetRepositoryRef}`,
    });
  }
  // …and the ROLE, which is emitted on KEY PRESENCE rather than on a difference,
  // because there is NO OLD SIDE TO COMPARE AGAINST.
  //
  // ⚠️ `work_item.targetRepoRole` is RETIRED (Story MOTIR-2732 · MOTIR-3040, ADR
  // `work-item-repository-set.md` §A3). The role is an ADDRESSING MODE resolved
  // at approve — `proposalRepoRef(name, role, refs)` picks a `project_repo` row
  // by name first and by role second — not an attribute stored on the item, so
  // `target` cannot supply a `from` and a difference cannot be computed. Presence
  // is exactly the right trigger regardless: `applyModify` rewrites the item's
  // repository reference whenever this key is present (`repoPins.has(item.id) ||
  // patch.targetRepoRole !== undefined`), including when the resolved name does
  // not change. So the row appears precisely when the approve will act.
  //
  // A null `from` is honest here and is NOT MOTIR-3191's `— → updated`: that cell
  // hid a value that EXISTED. This one names the new role on the side that has
  // one, and the absent old side is the schema's own shape.
  if (patch.targetRepoRole !== undefined) {
    changes.push({ field: 'targetRepoRole', from: null, to: patch.targetRepoRole ?? null });
  }
  const added = patch.blockedByAdd?.length ?? 0;
  const removed = patch.blockedByRemove?.length ?? 0;
  if (added > 0 || removed > 0) {
    const parts: string[] = [];
    if (added > 0) parts.push(`+${added}`);
    if (removed > 0) parts.push(`−${removed}`);
    changes.push({
      field: 'links',
      from: null,
      to: `${parts.join(' / ')} blocker${added + removed === 1 ? '' : 's'}`,
    });
  }
  // THE OBSOLESCENCE MARK, its NOTE and the SUPERSEDES edges (Story MOTIR-6577 ·
  // MOTIR-6632, design Part XXIV §24.3 / §24.6 / §24.7) — the mark group, emitted
  // after `links`. A mark `modify` is mark-only (a finished card accepts nothing
  // else), so these rows lead its list in practice.
  //
  // The MARK's both sides are wire words and never null: "no mark" is a value
  // (`current`), so a set reads `Current → Outdated` and a clear `Deprecated →
  // Current`. The FROM side is the LIVE target's mark — on a `done` card, which is
  // the only card a plan may mark, that is the value approve replaces. Presence-
  // triggered and compared, like `difficulty`: a patch re-stating the current mark
  // moves nothing and draws nothing.
  if (patch.obsolescence !== undefined && patch.obsolescence !== (target?.obsolescence ?? null)) {
    changes.push({
      field: 'obsolescence',
      from: target?.obsolescence ?? OBSOLESCENCE_CURRENT,
      to: patch.obsolescence ?? OBSOLESCENCE_CURRENT,
    });
  }
  // The NOTE — the WHOLE text on `to` (each surface takes the first line or
  // clamps), never a preview, and never the old note (§24.6: no FROM side). A
  // blank note is a clear, which reads `—`.
  if (
    patch.obsolescenceNoteMd !== undefined &&
    patch.obsolescenceNoteMd !== (target?.obsolescenceNoteMd ?? null)
  ) {
    const note = patch.obsolescenceNoteMd;
    changes.push({
      field: 'obsolescenceNote',
      from: null,
      to: note !== null && note.trim().length > 0 ? note : null,
    });
  }
  // The two EDGE rows, one per DIRECTION — unlike `blockedBy` they are not folded
  // into one count, because no canvas edge draws them (§24.7): the chips are the
  // whole of what the reviewer sees. Each ref is resolved to a chip on the server,
  // and `to` repeats the set as words (`+PROD-52 · −PROD-9`) for an older client.
  const edgeRow = (
    field: 'supersedes' | 'supersededBy',
    added: readonly string[] | null | undefined,
    removed: readonly string[] | null | undefined,
  ) => {
    const add = (added ?? []).map(refChipOf);
    const remove = (removed ?? []).map(refChipOf);
    if (add.length === 0 && remove.length === 0) return;
    const word = (chip: PlanRefChipDto) => chip.identifier ?? chip.title;
    changes.push({
      field,
      from: null,
      to: [...add.map((c) => `+${word(c)}`), ...remove.map((c) => `−${word(c)}`)].join(' · '),
      refs: { added: add, removed: remove },
    });
  };
  edgeRow('supersedes', patch.supersedesAdd, patch.supersedesRemove);
  edgeRow('supersededBy', patch.supersededByAdd, patch.supersededByRemove);
  const statusRow = target ? planStatusChangeOf(patch, target, statusByKey, statusContext) : null;
  if (statusRow) changes.push(statusRow);
  return leadingPlacement ? [leadingPlacement, ...changes] : changes;
}

/** Resolves a proposal's placement SIDES — built once per review read, over
 *  the batched folder paths (MOTIR-5415). */
interface PlacementSides {
  /** Where the live target sits TODAY: its parent, else its folder, else root. */
  current(target: WorkItem | undefined): PlanPlacementSideDto;
  /** Where a `parentRef` puts it: `null` root, `folder:<id>`, or a work item. */
  proposed(ref: string | null): PlanPlacementSideDto;
}

/** Identity of a side, for "did the placement change?". */
function placementKey(side: PlanPlacementSideDto): string {
  if (side.kind === 'root') return 'root';
  return side.kind === 'folder' ? `folder:${side.folderId}` : `item:${side.id}`;
}

/** A side as the reader's word: a key, a folder path, or null for the root. A
 *  deleted folder has no name left, so its cell names the ref instead. */
function placementWord(
  side: PlanPlacementSideDto,
  nameParent: (id: string | null) => string | null,
): string | null {
  if (side.kind === 'root') return null;
  if (side.kind === 'workItem') return nameParent(side.id);
  return side.folderPath ? side.folderPath.join(' ▸ ') : `folder:${side.folderId}`;
}

/**
 * When the plan's LATEST revision began, or null if it has never been revised.
 *
 * Walks backwards to the most recent `revision_started`, whether or not it has
 * been terminated — a LANDED revision is exactly the case the *Revised* pill
 * exists for, so stopping at a terminator (as the lease predicate must) would
 * blank the marker the moment the thing it marks finished.
 */
function lastRevisionStartAt(
  rows: readonly { changeKind: string; changedAt: Date }[],
): Date | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i]!.changeKind === REVISION_STARTED_KIND) return rows[i]!.changedAt;
  }
  return null;
}

/**
 * The proposals the latest revision touched — every trail row at or after
 * `startedAt` that names one.
 *
 * The two BRACKET rows are excluded: they carry no `planItemId` (they are about
 * the plan, not a proposal), so they contribute nothing either way, and naming
 * them here would be a claim about a row that has no target.
 */
function revisedSince(
  rows: readonly { changeKind: string; changedAt: Date; planItemId: string | null }[],
  startedAt: Date | null,
): Set<string> {
  const touched = new Set<string>();
  if (!startedAt) return touched;
  for (const r of rows) {
    if (r.changedAt < startedAt) continue;
    if (r.changeKind === REVISION_STARTED_KIND || r.changeKind === REVISION_ENDED_KIND) continue;
    if (r.planItemId) touched.add(r.planItemId);
  }
  return touched;
}

/**
 * Every work-item id a plan's MARK carriers name (Story MOTIR-6577 · MOTIR-6631,
 * shared with MOTIR-6632): each real ref on the five `supersedes` carriers, and
 * each `modify` target that touches `obsolescence` (whose CURRENT mark is the old
 * side of the change). A `planItem:` ref is a proposal, not an id; a `folder:` ref
 * names no work item. ONE collection rule, read by `resolveProposalMarkRefs`
 * (`get_plan`'s line) and by `getPlanReview`'s batched row read (the review's chips)
 * — so the two surfaces cannot disagree about which cards a mark names.
 */
function markRefIdsOf(plan: PlanWithItemsDto): Set<string> {
  const ids = new Set<string>();
  const take = (ref: string) => {
    if (!isTempRef(ref) && !isFolderRef(ref)) ids.add(ref);
  };
  for (const item of plan.items) {
    for (const ref of item.supersedesRefs ?? []) take(ref);
    if (item.op !== 'modify' || !item.patch) continue;
    for (const site of SUPERSEDES_PATCH_SITES) for (const ref of item.patch[site] ?? []) take(ref);
    if (item.workItemId && item.patch.obsolescence !== undefined) ids.add(item.workItemId);
  }
  return ids;
}

/**
 * The Visitor's gate for ONE plan (Story MOTIR-6170 · MOTIR-6645): the plan must
 * be in the Visitor's project and must not be withheld — a proposal naming a
 * hidden id, or a withheld session. Every refusal is {@link PlanNotFoundError},
 * the answer an unknown id gets.
 */
async function visitorPlanReader(
  planId: string,
  reader: VisitorReadContext,
): Promise<ServiceContext> {
  const { workspaceId, excludeIds } = openVisitorRead(reader.project.id, reader, 'plan:view_any');
  const refused = await withWorkspaceServiceContext(workspaceId, async (tx) => {
    const plan = await planRepository.findById(planId, workspaceId, tx);
    if (!plan || plan.projectId !== reader.project.id) return true;
    return planChangeSessionRepository.isPlanWithheld(planId, excludeIds, tx);
  });
  if (refused) throw new PlanNotFoundError(planId);
  return visitorServiceContext(reader);
}

/**
 * THE ONE READER RESOLUTION both plan reads make (MOTIR-8063): the review read
 * and the narration page. A Visitor passes {@link visitorPlanReader} first; then
 * the plan is read for the resulting context, which admits by the Plans room's
 * scope. Shared so the paged narration read can never become a side door into a
 * plan the review read would refuse — every refusal is the same not-found.
 */
async function readerContextOf(
  planId: string,
  reader: ServiceContext | VisitorReadContext,
): Promise<ServiceContext> {
  return isVisitorContext(reader) ? visitorPlanReader(planId, reader) : reader;
}

/**
 * The plan's REVIEW VERSION (MOTIR-8127): its status and a token over everything the review shows
 * that can move while the plan is written (`planRepository.readReviewFingerprint`). One small
 * statement. `null` only for a plan that vanished between the admit and this read.
 */
async function readReviewVersion(
  planId: string,
  ctx: ServiceContext,
): Promise<{ status: PlanStatus; token: string } | null> {
  const row = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
    planRepository.readReviewFingerprint(planId, tx),
  );
  if (!row) return null;
  return { status: row.status, token: REVIEW_VERSION_PREFIX + hashParts(row.parts) };
}

/** Versions a later change to the fingerprint's parts is `rv2.`, never a silent edit. */
const REVIEW_VERSION_PREFIX = 'rv1.';

function hashParts(parts: string): string {
  return createHash('sha256').update(parts).digest('hex').slice(0, 32);
}

async function resolvePlanReader(
  planId: string,
  reader: ServiceContext | VisitorReadContext,
): Promise<{ ctx: ServiceContext; plan: PlanWithItemsDto }> {
  const ctx = isVisitorContext(reader) ? await visitorPlanReader(planId, reader) : reader;
  const plan = await plansService.getPlanForReader(planId, ctx);
  return { ctx, plan };
}

/** A page's `earlierCount` from its first entry — `seq` is gapless from 1. */
function earlierCountOf(entries: readonly { seq: number }[]): number {
  return entries.length === 0 ? 0 : entries[0]!.seq - 1;
}

export const planReviewService = {
  /**
   * An EARLIER page of a plan's narration sentences (MOTIR-8063): up to `limit`
   * sentences immediately before `beforeSeq`, ascending, with the page's own
   * `earlierCount`. Gated exactly as {@link getPlanReview} is, through
   * {@link resolvePlanReader}, before any narration row is read. The session step
   * words are NOT repeated: the review read already carries all of them.
   */
  async listPlanNarration(
    planId: string,
    reader: ServiceContext | VisitorReadContext,
    page: { beforeSeq: number; limit?: number },
  ): Promise<PlanNarrationPageDto> {
    const { ctx } = await resolvePlanReader(planId, reader);
    const limit = Math.min(
      Math.max(page.limit ?? PLAN_NARRATION_READ_WINDOW, 1),
      PLAN_NARRATION_READ_WINDOW,
    );
    // BOUND, not `db`: the policy joins to `plan`, so an unbound read is empty.
    const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      planNarrationRepository.listBeforeSeq(planId, page.beforeSeq, limit, tx),
    );
    const entries = rows.map(toPlanNarrationDto);
    return { entries, earlierCount: earlierCountOf(entries) };
  },

  /**
   * Assemble the plan-detail review model for `planId`. Reads the plan + its
   * items (`getPlan`), the per-item staleness (`computePlanStaleness`), the live
   * `modify`/`remove` targets (one batched read), and the decider's name. Access
   * is enforced by `getPlan` (it asserts `canBrowse` on the plan's project, and a
   * missing/cross-tenant plan throws `PlanNotFoundError`).
   */
  /**
   * The folder each proposal NAMES, with its path (MOTIR-5415) — keyed by plan
   * item id, for the proposals whose `parentRef` / `patch.parentRef` is
   * `folder:<id>` and for no others.
   *
   * This is the proposal's OWN placement, the same register as `parentRef` /
   * `parentKey` on `/api/v1` and `get_plan`'s structured payload: what the plan
   * SAYS. {@link getPlanReview} additionally reads a target's current folder,
   * because the canvas draws where a card will SIT; a wire payload carrying
   * refs does not. `folderPath` is `null` for a folder that no longer exists in
   * the plan's project. ONE read for the whole plan.
   */
  async resolveProposalFolders(
    plan: PlanWithItemsDto,
    ctx: ServiceContext,
  ): Promise<Map<string, { folderId: string; folderPath: string[] | null }>> {
    const named = plan.items
      .map((item) => ({ item, folderId: namedFolderIdOf(item) }))
      .filter((n): n is { item: PlanItemDto; folderId: string } => !!n.folderId);
    if (named.length === 0) return new Map();
    const rows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      folderRepository.findPathsByIds(
        Array.from(new Set(named.map((n) => n.folderId))),
        ctx.workspaceId,
        tx,
      ),
    );
    const pathById = new Map(
      rows.filter((f) => f.projectId === plan.projectId).map((f) => [f.id, f.path]),
    );
    return new Map(
      named.map(({ item, folderId }) => [
        item.id,
        { folderId, folderPath: pathById.get(folderId) ?? null },
      ]),
    );
  },

  /**
   * What `get_plan`'s one-line render needs to print a proposed MARK (Story
   * MOTIR-6577 · MOTIR-6631): each real work-item ref on the five `supersedes`
   * carriers — and each `modify` target that touches `obsolescence` — resolved to
   * its KEY, and those targets' CURRENT mark, so a line reads
   * `mark: none → outdated · supersedes +ACME-3`. ONE workspace-scoped read for
   * the whole plan, and none at all when no proposal carries a mark key.
   *
   * A row outside the plan's own project is left out of both maps (the render
   * then prints the ref verbatim), the same reach `resolveProposalFolders` keeps
   * — a plan reader was admitted to this project and no other. A `planItem:` ref
   * is not an id and is never read.
   */
  async resolveProposalMarkRefs(
    plan: PlanWithItemsDto,
    ctx: ServiceContext,
  ): Promise<{
    keyById: Map<string, string>;
    markById: Map<string, WorkItemObsolescenceDto | null>;
    todoCountById: Map<string, { total: number; done: number }>;
  }> {
    const ids = markRefIdsOf(plan);
    // …and the `modify` targets whose patch REPLACES the step list (MOTIR-8668),
    // whose live count and ticked count the line prints beside the change.
    const todoTargetIds = plan.items
      .filter((i) => i.op === 'modify' && i.workItemId && i.patch?.todos !== undefined)
      .map((i) => i.workItemId!);
    if (ids.size === 0 && todoTargetIds.length === 0) {
      return { keyById: new Map(), markById: new Map(), todoCountById: new Map() };
    }
    const { rows, counts } = await withWorkspaceServiceContext(ctx.workspaceId, async (tx) => ({
      rows:
        ids.size === 0
          ? []
          : await workItemRepository.findByIdsInWorkspace([...ids], ctx.workspaceId, tx),
      counts: await workItemTodoRepository.countByWorkItems(todoTargetIds, tx),
    }));
    const own = rows.filter((row) => row.projectId === plan.projectId);
    return {
      keyById: new Map(own.map((row) => [row.id, row.identifier])),
      markById: new Map(own.map((row) => [row.id, row.obsolescence ?? null])),
      todoCountById: counts,
    };
  },

  /**
   * THE LIVE STREAM'S PLAN READ (Story MOTIR-8542 · MOTIR-8730): a watched plan's
   * status and review version, for this reader — or `null`.
   *
   * ⚠️ `null` FOR EVERY REFUSAL AND FOR A PLAN THAT IS GONE, never an error. The
   * stream writes a frame only for a version it read, so a plan the reader may
   * not browse produces no frame, no error frame and no hint that it exists. The
   * admission is the review read's own ({@link readerContextOf} then
   * `plansService.admitPlanReader`), so the stream can never see a plan the review
   * read would refuse. Any other error propagates.
   */
  async readReviewVersionForReader(
    planId: string,
    reader: ServiceContext | VisitorReadContext,
  ): Promise<{ status: PlanStatus; reviewVersion: string } | null> {
    try {
      const ctx = await readerContextOf(planId, reader);
      await plansService.admitPlanReader(planId, ctx);
      const version = await readReviewVersion(planId, ctx);
      return version ? { status: version.status, reviewVersion: version.token } : null;
    } catch (err) {
      // `ProjectNotFoundError` is how a project-bound token is refused a plan in
      // another project — a refusal like the other two, so the same `null`.
      if (
        err instanceof PlanNotFoundError ||
        err instanceof ProjectAccessDeniedError ||
        err instanceof ProjectNotFoundError
      ) {
        return null;
      }
      throw err;
    }
  },

  /**
   * The poll's read (MOTIR-8127): the review when anything it shows has moved, and
   * {@link PlanReviewUnchangedDto} — a few bytes — when it has not.
   *
   * ⚠️ UNCHANGED IS ANSWERED ONLY FOR A `generating` PLAN, only after the reader has been ADMITTED
   * (an unadmitted reader gets the same refusal a full read gives, never a token comparison), and
   * only when the token the client holds equals the plan's CURRENT one AND that token was minted
   * for a `generating` plan. Anything else — no token, a stale one, a plan that has since been
   * planned, declined or approved — falls through to the full read, so the poll can only ever
   * learn LESS cheaply, never be told a settled plan is unchanged.
   */
  async getPlanReviewIfChanged(
    planId: string,
    reader: ServiceContext | VisitorReadContext,
    since: string | null,
  ): Promise<PlanReviewDto | PlanReviewUnchangedDto> {
    if (since) {
      const ctx = await readerContextOf(planId, reader);
      await plansService.admitPlanReader(planId, ctx);
      const version = await readReviewVersion(planId, ctx);
      if (version && version.status === 'generating' && version.token === since) {
        return { unchanged: true, reviewVersion: version.token };
      }
    }
    return planReviewService.getPlanReview(planId, reader);
  },

  async getPlanReview(
    planId: string,
    reader: ServiceContext | VisitorReadContext,
  ): Promise<PlanReviewDto> {
    // A Visitor reads a plan of THEIR public project that touches no private
    // epic's descendant (MOTIR-6645); anything else is the same not-found an
    // unknown id is. Past that gate the read runs on the Visitor's narrowed
    // service context, which resolves the Visitor key set and nothing more.
    // A READ for an actor (the plan page, `GET /api/plans/[id]`, `get_plan`'s
    // placements), so it admits by the Plans room's scope: a plan outside the
    // reader's view is the same not-found as an unknown id (MOTIR-6330). The
    // resolution is shared with the narration page read (MOTIR-8063).
    // The admit, then the version token, THEN the item read (MOTIR-8127): the token is taken before
    // the review's own reads so a write that lands between them leaves the token OLDER than the
    // data, and the next poll reads in full once instead of ever skipping a change.
    const ctx = await readerContextOf(planId, reader);
    const admitted = await plansService.admitPlanReader(planId, ctx);
    const version = await readReviewVersion(planId, ctx);
    const plan = await plansService.loadAdmittedPlanWithItems(admitted, ctx);
    // Only an undecided plan can be stale. `getPlanForReader` above has ALREADY admitted the reader and read
    // the plan with every item, so for any other status the all-clear verdict is built from those items
    // instead of asking `computePlanStaleness` to re-read the plan, re-run the browse check and re-read every
    // item to return the same constant — the poll of a `generating` plan paid that on every tick (MOTIR-8103).
    const staleness = planStatusCanBeStale(plan.status)
      ? await planStalenessService.computePlanStaleness(planId, ctx)
      : allClearStaleness(planId, plan.items);
    // The plan's CONTENT trail (MOTIR-3536) — ONE query for the whole history,
    // walking the `(plan_id, changed_at)` index. It rides the plan read rather
    // than a per-event query because this model is re-read on every poll of a
    // `generating` plan, which is exactly the surface a row-per-round-trip would
    // punish hardest.
    //
    // ⚠️ BOUND, not the `db` singleton: `plan_revision` carries no `workspace_id`
    // and its policy joins to the parent `plan`, so an unbound read returns an
    // EMPTY trail rather than an error — a plan's whole history silently gone.
    // The plan's LIVE-PROGRESS facts (Story MOTIR-7820 · MOTIR-7822): when it last
    // did anything, and the step each running planner session is on. Bound for
    // the same reason as the trail — `plan_step`'s policy joins to `plan`, so an
    // unbound read is an empty set, which reads as "nobody is working on it".
    // The steps are read only while the plan is `generating`: a session that
    // never cleared must not outlive its plan on any surface.
    //
    // THE PLAN'S CONVERSATION (MOTIR-6037) — the decision surfaces say whether there is
    // one to return to. The gate row's own read, so the two agree on what "has a
    // conversation" means.
    //
    // THE PLANNER'S NARRATION (MOTIR-8063) — every session's step words and the
    // newest window of sentences, at EVERY status: unlike `inFlightSteps` it is
    // kept history. Bound for the trail's reason — both policies join to `plan`.
    //
    // ⚠️ ONE TRANSACTION FOR THE FOUR INDEPENDENT READS (MOTIR-8127). They used to open one each,
    // and every `withWorkspaceServiceContext` is a BEGIN, a `set_config` and a COMMIT around its
    // statements: three round trips of overhead apiece, paid on every tick of the poll. None of them
    // reads what another wrote, so they share the one.
    const { revisions, lastActivityAt, inFlightSteps, conversation, narration } =
      await withWorkspaceServiceContext(ctx.workspaceId, async (tx) => {
        const trail = await planRevisionRepository.listByPlan(planId, tx);
        const row = await planRepository.findById(planId, ctx.workspaceId, tx);
        const steps =
          plan.status === 'generating' ? await planStepRepository.listByPlan(planId, tx) : [];
        const conversation = await readPlanConversation(planId, tx);
        const sessions = await planNarrationRepository.listSessionsByPlan(planId, tx);
        const rows = await planNarrationRepository.listLatestByPlan(
          planId,
          PLAN_NARRATION_READ_WINDOW,
          tx,
        );
        const entries = rows.map(toPlanNarrationDto);
        const narration: PlanNarrationReadDto = {
          sessions: sessions.map(toPlanNarrationSessionDto),
          entries,
          earlierCount: earlierCountOf(entries),
        };
        return {
          revisions: trail,
          lastActivityAt: (row?.lastActivityAt ?? new Date(plan.createdAt)).toISOString(),
          inFlightSteps: steps.map(toPlanStepDto),
          conversation,
          narration,
        };
      });

    // ── THE REVISION, read off the SAME trail (Subtask MOTIR-3601) ────────────
    // The lease IS a `revision_started` with no `revision_ended` after it, inside
    // the window (`agent-authored-plans.md` AMENDMENT 10 D2) — so the surface
    // that must hold Approve and the timeline that tells the reviewer WHY read
    // one fact from one place, and nothing needed a column.
    const lease = revisionLeaseOf(revisions, new Date());
    // THE PLAN'S QUESTION (MOTIR-6038) — its gate and the stamp a press hands back, read
    // on every poll so a reader's stamp follows the version they are looking at.
    const gate = await readPlanGate(planId, ctx);
    const revisionStartedAt = lastRevisionStartAt(revisions);
    // WHICH proposals the latest revision touched. Every trail row written at or
    // after that start names its `planItemId`, so the set falls out of rows this
    // method already has. An unrevised plan yields an empty set and every row
    // renders exactly as it did before this story.
    const revisedItemIds = revisedSince(revisions, revisionStartedAt);

    // One batched, workspace-scoped read of every existing target (modify/remove)
    // — includes archived rows, so a "will be archived" / drifted target still
    // resolves; a hard-deleted / cross-tenant id simply doesn't come back.
    //
    // ⚠️ A MATERIALIZED `add` is in this set too (MOTIR-3160). `approvePlan`
    // stamps `plan_item.workItemId` for every add it creates, so an approved
    // proposal HAS a live target — and until this filter stopped excluding it by
    // `op`, the review model could not read the identifier of the very card the
    // approval produced.
    const targetIds = plan.items.filter((i) => i.workItemId).map((i) => i.workItemId!);
    // …AND every COMMITTED parent (MOTIR-3083). A `parentRef` is either an
    // intra-plan temp-ref (`planItem:<id>`, which already has a node in the
    // proposed set) or a real work-item id — and the second kind is the one the
    // canvas has to open a LEVEL at and the breadcrumb has to name. It rides the
    // SAME batched read rather than a per-item query: a plan of thirty proposals
    // under one parent must still cost one round trip.
    //
    // A `folder:<id>` ref (MOTIR-5415) names no work item, so it joins neither
    // this list nor the re-parent one below — it is resolved by the folder read.
    const committedParentIds = plan.items
      .map((i) => i.parentRef)
      .filter(
        (ref): ref is string => !!ref && !ref.startsWith(TEMP_REF_PREFIX) && !isFolderRef(ref),
      );
    // …AND the parent a `modify` proposes to MOVE its target to (MOTIR-3859).
    // It is a committed work item like any other parent — the append refuses a
    // temp-ref there — so it rides the same batched read, and both the diff cell
    // and the canvas placement below need its row.
    const reparentIds = plan.items
      .map((i) => (i.op === 'modify' ? (i.patch?.parentRef ?? null) : null))
      .filter(
        (ref): ref is string => !!ref && !ref.startsWith(TEMP_REF_PREFIX) && !isFolderRef(ref),
      );
    // …AND the COMMITTED `blocked_by` EDGES of every target (bug MOTIR-4951).
    //
    // The canvas builds a level from the roadmap read of that level's CURRENT
    // children ∪ this plan's proposals at it. That is complete for a proposal
    // that stays where it is, and it is silently incomplete for one the plan
    // RE-PARENTS onto the level: the moving card is not among the destination's
    // current children, so its committed edges are in `committed.deps` nowhere —
    // and they are not in the two carriers either, because a relocation proposes
    // no edge. The card was drawn as a node and never as an endpoint, and a
    // relocation plan — whose whole subject is moving cards into a container so
    // they can be worked in some order — rendered as unrelated cards side by
    // side. Approving made the arrows appear, which is the tell.
    //
    // ONE query for the whole plan, on the same "never an N+1" rule the target
    // read below states. `findBlockerEdgesForItems` already carries the blocker's
    // STATUS, which is the other half of what the level builder needs: a
    // committed edge is drawn `firm` or `pending` by whether its blocker is
    // `done` (`buildWorkItemLevel`), and the level builder cannot look that up —
    // the blocker may be a card this same plan is relocating, in which case it is
    // not in the roadmap read for this level either.
    //
    // ⚠️ THE EDGE READ, THE TARGET READ AND THE ANCESTOR WALK SHARE ONE TRANSACTION (MOTIR-8127).
    // They are one dependent chain — the edges name blockers the target read must include, and the
    // target read's parents seed the walk — with only pure id arithmetic between them, and they
    // used to open a transaction EACH (the walk one per tree level). Every one is a BEGIN, a
    // `set_config` and a COMMIT paid on every tick of the poll.
    const { committedBlockersByItemId, targetById, ancestorById, todoCountById, parkPriorById } =
      await withWorkspaceServiceContext(ctx.workspaceId, async (tx) => {
        const committedEdgeRows = await workItemLinkRepository.findBlockerEdgesForItems(
          targetIds,
          ctx.workspaceId,
          tx,
        );
        const committedBlockersByItemId = new Map<string, PlanCommittedBlockerDto[]>();
        for (const row of committedEdgeRows) {
          const list = committedBlockersByItemId.get(row.fromId) ?? [];
          list.push({ nodeId: row.blockerId, isDone: row.blockerStatus === 'done' });
          committedBlockersByItemId.set(row.fromId, list);
        }

        // …AND every BLOCKER the plan names (bug MOTIR-5387) — a proposal's own
        // (`blockedByRefs`, `patch.blockedByAdd`) and the ones its target already
        // carries — so the canvas can NAME one that sits on another level. The
        // roadmap draws such a blocker as a ghost anchor naming it; the edge carriers
        // name ids only, so before approve there was nothing to put on the anchor and
        // the canvas drew no edge at all. They join the SAME batched row read as the
        // targets, which is why the edge read above now runs first: one more id list,
        // not one more query. A `planItem:` ref is a proposal, named from the review
        // model itself once it is built.
        const blockerIds = [
          ...committedEdgeRows.map((r) => r.blockerId),
          ...plan.items.flatMap((i) => [...i.blockedByRefs, ...(i.patch?.blockedByAdd ?? [])]),
        ].filter((ref) => !ref.startsWith(TEMP_REF_PREFIX));
        // …AND every card a MARK carrier names (Story MOTIR-6577 · MOTIR-6632) — the
        // `supersedes` refs on an `add` and on a `modify`'s patch — so each chip can
        // carry its key, title and kind. The SAME collection `get_plan` reads
        // (`markRefIdsOf`), joined to the SAME batched read: one more id list, not one
        // more query. A marked target's CURRENT mark is on its own row, already here.
        const lookupIds = Array.from(
          new Set([
            ...targetIds,
            ...committedParentIds,
            ...reparentIds,
            ...blockerIds,
            ...markRefIdsOf(plan),
          ]),
        );
        const targets = await workItemRepository.findByIdsInWorkspace(
          lookupIds,
          ctx.workspaceId,
          tx,
        );
        const targetById = new Map(targets.map((t) => [t.id, t]));

        // …AND the LIVE PARENT of every proposal that names a TARGET instead of a
        // parent (bug MOTIR-3191).
        //
        // A `modify` / `remove` carries NO `parentRef` and cannot: its parent is
        // whatever the live card already has, and the contract deliberately forbids a
        // proposal from re-parenting anything (`docs/decisions/agent-authored-plans.md`).
        // Reading placement off `parentRef` ALONE therefore gave it a null parent —
        // which every consumer reads as *a root*. So an amendment to a subtask five
        // levels down drew at the PROJECT ROOT, beside the `add`s the plan rules
        // reserve that level for, and a reviewer applying the root-is-for-epics rule
        // to what the surface showed was correct to decline it. The parent is not
        // absent; it is on the TARGET, one field away.
        const targetParentIds = plan.items
          .map((i) => (i.workItemId ? (targetById.get(i.workItemId)?.parentId ?? null) : null))
          .filter((id): id is string => id !== null);

        // …AND the committed parents' OWN ancestors (bug MOTIR-3152), because the
        // breadcrumb the canvas opens with is the whole CHAIN down to the level, not
        // its last link. The read above resolves the parent; walking UP from it is a
        // second question and needs a second read.
        //
        // ONE batched read PER TREE LEVEL, not one per item: the ids of each round's
        // parents are collected and fetched together, and the loop stops when a round
        // adds nothing new. The tree is depth-capped (Story 1.4), so a plan of thirty
        // proposals under one parent still costs at most a handful of round trips —
        // the same "never an N+1" property the target read above has.
        //
        // A `findAncestors` per parent would be the obvious alternative and is the
        // one this deliberately avoids: it is one query PER PARENT, and a plan may
        // legitimately propose under many.
        //
        // The frontier is seeded with every id that must END UP in `ancestorById`:
        // the committed parents' own parents (their rows came back in round 1),
        // — MOTIR-3191 — the inherited parents themselves, which did not, and
        // — bug MOTIR-5272 — the RE-PARENT DESTINATIONS' own parents, which are the
        // third carrier and were the one this seeding never named.
        //
        // ⚠️ ALL THREE CARRIERS, because `lookupIds` has three and this list had two.
        // `reparentIds` (a `modify`'s `patch.parentRef`, MOTIR-3859) rode the batched
        // ROW read and nothing else, so a proposed MOVE resolved its destination and
        // then walked the chain the card is LEAVING — `targetParentIds` is the
        // target's CURRENT parent. `trailFor` therefore broke at the destination's
        // own parent and returned the destination alone, and the breadcrumb drew
        // `Roadmap › <destination>` with every ancestor above it missing: the exact
        // shape `PlanReviewCanvas.trailTo` uses to mean *an archived ancestor*.
        // Every earlier re-parent test moved a card onto a ROOT epic, where a
        // one-element trail is correct, which is why this held for so long.
        const ancestorById = new Map(targets.map((t) => [t.id, t]));
        let frontier = Array.from(
          new Set([
            ...committedParentIds
              .map((id) => targetById.get(id)?.parentId)
              .filter((id): id is string => !!id),
            ...reparentIds
              .map((id) => targetById.get(id)?.parentId)
              .filter((id): id is string => !!id),
            ...targetParentIds,
          ]),
        );
        // A hard bound as well as the natural one: a cycle in `parentId` is not
        // representable through the API, but this loop must terminate on a corrupt
        // row rather than hang the plan page.
        for (let depth = 0; depth < 16 && frontier.length > 0; depth++) {
          const unseen = frontier.filter((id) => !ancestorById.has(id));
          if (unseen.length === 0) break;
          const rows = await workItemRepository.findByIdsInWorkspace(unseen, ctx.workspaceId, tx);
          for (const row of rows) ancestorById.set(row.id, row);
          frontier = Array.from(
            new Set(rows.map((r) => r.parentId).filter((id): id is string => !!id)),
          );
        }
        // …AND the live STEP COUNT of every target a `modify` REPLACES the list of
        // (MOTIR-8668 · AMENDMENT 27), so the `todos` change row can say how many
        // steps the replacement drops and how many of them were ticked. One
        // grouped read, and only when a patch carries `todos`.
        const todoCountById = await workItemTodoRepository.countByWorkItems(
          plan.items
            .filter((i) => i.op === 'modify' && i.workItemId && i.patch?.todos !== undefined)
            .map((i) => i.workItemId!),
          tx,
        );
        // …AND the status every PARKED `modify` target was parked FROM (bug
        // MOTIR-10102): the card reads `planning` while a plan or a session holds
        // it, so the re-scope row's question — did this card claim built work? —
        // is answered by its lock. One batched read over the modify targets.
        const parkPriors = await planTargetLockRepository.listParkPriorsByWorkItemIds(
          plan.items.filter((i) => i.op === 'modify' && i.workItemId).map((i) => i.workItemId!),
          tx,
        );
        const parkPriorById = new Map(parkPriors.map((p) => [p.workItemId, p]));
        return {
          committedBlockersByItemId,
          targetById,
          ancestorById,
          todoCountById,
          parkPriorById,
        };
      });

    /**
     * The committed ancestor path down to `parentId`, ROOT FIRST and the parent
     * itself LAST. `[]` when there is no committed parent, and a chain that runs
     * out (an archived / hard-deleted ancestor the read did not return) simply
     * STOPS there — the crumbs above it are lost, the ones below it are not, and
     * nothing throws. That is the same degrade-rather-than-fail contract the
     * parent fields themselves carry.
     */
    const trailFor = (parentId: string | null): PlanParentCrumbDto[] => {
      const trail: PlanParentCrumbDto[] = [];
      let cursor = parentId;
      const guard = new Set<string>();
      while (cursor && !guard.has(cursor)) {
        guard.add(cursor);
        const row = ancestorById.get(cursor);
        if (!row) break;
        trail.unshift({ id: row.id, identifier: row.identifier, title: row.title });
        cursor = row.parentId;
      }
      return trail;
    };

    /** A parent id as the reader's own word for it (MOTIR-3859): its identifier
     *  when the row is resolvable, `null` for the project root — and, for a row
     *  neither read returned (archived, hard-deleted), the id itself rather than
     *  nothing, so the cell degrades to something checkable instead of claiming
     *  the card moved to the root. */
    // A `planItem:<id>` parent is an `add` in this plan (AMENDMENT 18 §1). It
    // is named by the key approve CREATED once it is materialized, and until
    // then it has no key at all — the surface names it `New · <title>` from
    // `proposedTitle` (Part XIX §19.3). Never the temp-ref: that is an internal
    // token, and a placeholder key would assert a work item that does not exist.
    const addById = new Map(plan.items.filter((i) => i.op === 'add').map((i) => [i.id, i]));
    const proposedAddOf = (id: string) =>
      id.startsWith(TEMP_REF_PREFIX) ? addById.get(resolveRef(id)) : undefined;
    const proposedTitleOf = (add: PlanItemDto): string =>
      add.proposedFields?.title ?? 'Untitled item';
    const nameParent = (id: string | null): string | null => {
      if (id === null) return null;
      const add = proposedAddOf(id);
      if (add) {
        return add.workItemId
          ? (targetById.get(add.workItemId)?.identifier ?? null)
          : proposedTitleOf(add);
      }
      const row = targetById.get(id) ?? ancestorById.get(id);
      return row?.identifier ?? id;
    };

    /**
     * One `supersedes` ref as the CHIP that draws it (Story MOTIR-6577 ·
     * MOTIR-6632, design Part XXIV §24.7). A `planItem:` ref names an `add` of this
     * plan: until approve it has no key, so the chip is PROPOSED and carries the
     * title the add asks for and its PlanItem id (which opens its peek); once
     * materialized it names the key approve CREATED. A real id names its row from
     * the batched read. Never the temp-ref, and never a placeholder key; a ref
     * neither read resolves degrades to the ref itself, as `nameParent` does.
     */
    const refChipOf = (ref: string): PlanRefChipDto => {
      if (ref.startsWith(TEMP_REF_PREFIX)) {
        const add = addById.get(resolveRef(ref));
        if (!add) return { identifier: ref, title: '', kind: 'task', proposed: false };
        const created = add.workItemId ? targetById.get(add.workItemId) : undefined;
        if (created) {
          return {
            identifier: created.identifier,
            title: created.title,
            kind: created.kind,
            proposed: false,
            planItemId: add.id,
          };
        }
        return {
          identifier: null,
          title: proposedTitleOf(add),
          kind: add.proposedFields?.kind ?? 'task',
          proposed: true,
          planItemId: add.id,
        };
      }
      const row = targetById.get(ref);
      return row
        ? { identifier: row.identifier, title: row.title, kind: row.kind, proposed: false }
        : { identifier: ref, title: '', kind: 'task', proposed: false };
    };

    // ── FOLDER PLACEMENTS (MOTIR-5415) ────────────────────────────────────────
    // Every folder the review has to name: the ones a proposal NAMES
    // (`parentRef` / `patch.parentRef` = `folder:<id>`) and the ones a target is
    // filed in TODAY (a `modify` / `remove` that does not move it sits there, and
    // a move OUT of a folder needs it as its `from` side). ONE recursive read for
    // the whole plan, however many proposals are folder-placed — the same "never
    // an N+1" rule the target read above states. A folder that no longer exists,
    // or that sits in another project, does not resolve and reads as MISSING:
    // the stale state the design draws and approve refuses.
    const folderIds = Array.from(
      new Set([
        ...plan.items.map(namedFolderIdOf).filter((id): id is string => !!id),
        ...plan.items
          .map((i) => (i.workItemId ? (targetById.get(i.workItemId)?.folderId ?? null) : null))
          .filter((id): id is string => !!id),
      ]),
    );
    // The TRAIL read (MOTIR-5798): ids as well as names, so the planning canvases
    // can key and navigate a folder LEVEL. The path of names is derived from it,
    // so `folderPath` is byte-for-byte what `findPathsByIds` returned.
    const folderRows = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
      folderRepository.findTrailsByIds(folderIds, ctx.workspaceId, tx),
    );
    const folderTrailById = new Map<string, PlanFolderCrumbDto[]>(
      folderRows.filter((f) => f.projectId === plan.projectId).map((f) => [f.id, f.trail]),
    );
    const folderPathById = new Map(
      Array.from(folderTrailById, ([id, trail]) => [id, trail.map((t) => t.name)] as const),
    );
    const folderSide = (folderId: string): PlanPlacementSideDto => {
      const path = folderPathById.get(folderId) ?? null;
      return { kind: 'folder', folderId, folderPath: path, folderMissing: path === null };
    };
    const placementSides: PlacementSides = {
      current: (target) => {
        if (target?.parentId) {
          return { kind: 'workItem', id: target.parentId, identifier: nameParent(target.parentId) };
        }
        return target?.folderId ? folderSide(target.folderId) : { kind: 'root' };
      },
      proposed: (ref) => {
        if (ref === null) return { kind: 'root' };
        if (isFolderRef(ref)) return folderSide(folderRefId(ref));
        const add = proposedAddOf(ref);
        if (add && !add.workItemId) {
          return {
            kind: 'workItem',
            id: ref,
            identifier: null,
            proposedTitle: proposedTitleOf(add),
          };
        }
        return { kind: 'workItem', id: ref, identifier: nameParent(ref) };
      },
    };
    /** The folder a proposal will SIT in: the one it names, else — when it names
     *  no placement at all — its target's current folder. */
    const effectiveFolderIdOf = (item: PlanItemDto): string | null => {
      const named = namedFolderIdOf(item);
      if (named !== undefined) return named;
      const target = item.workItemId ? targetById.get(item.workItemId) : undefined;
      return target?.parentId ? null : (target?.folderId ?? null);
    };

    const staleByItem = new Map(staleness.items.map((s) => [s.planItemId, s]));

    // The project's WORKFLOW, so a target's status can carry its own identity —
    // label + lifecycle category — to the canvas chip (bug MOTIR-3170). The chip
    // used to receive a bare key and narrow it against a six-member literal,
    // which drew a `modify` whose target sits at `implemented` as "To Do". One
    // read per plan page; the statuses are per-project and there is one project.
    const statusByKey = new Map(
      (await workflowsService.listStatusesByProject(plan.projectId, ctx.workspaceId)).map((s) => [
        s.key,
        s,
      ]),
    );

    // Resolve node ids first, so `hasChildren` can be computed across the forest.
    //
    // ONE rule for all three ops (MOTIR-3160): the work item this proposal is
    // ABOUT, falling back to the plan-item id when there is not one yet. An
    // un-materialized `add` still keys by its own id — it is not about anything
    // yet — and `modify` / `remove` are unchanged, since they always had a
    // target. What changes is the `add` that has BEEN materialized: it used to
    // keep the plan-item id even after approve wrote down which work item it
    // became, so `mergePlanLevel` (which matches proposals to committed nodes by
    // node id) could never land it ON that node and pushed it out as a second,
    // keyless ghost beside the real one.
    const withNodeIds = plan.items.map((item) => ({
      item,
      nodeId: item.workItemId ?? item.id,
    }));
    // …and once a node id can DIFFER from the plan-item id, an intra-plan
    // (`planItem:<id>`) ref can no longer resolve to the referenced id itself:
    // it has to resolve to that item's NODE id, or a materialized parent's
    // children point at a node that is not on the canvas. Same for a
    // `blocked_by` edge between two proposals in one plan.
    const nodeIdByPlanItemId = new Map(withNodeIds.map(({ item, nodeId }) => [item.id, nodeId]));
    const resolveNodeRef = (ref: string): string => {
      const resolved = resolveRef(ref);
      return ref.startsWith(TEMP_REF_PREFIX)
        ? (nodeIdByPlanItemId.get(resolved) ?? resolved)
        : resolved;
    };
    /**
     * Every blocker this proposal declares, as canvas NODE ids — from BOTH
     * carriers (bug MOTIR-3366).
     *
     * A plan states a `blocked_by` edge in two places, and which one it uses is
     * decided by the OP, not by the author: an `add` names its blockers in its
     * own `blockedByRefs`, while a `modify` names them in `patch.blockedByAdd` —
     * the only way to propose an edge ONTO a card that already exists, and
     * therefore the shape of every mid-run correction (`add` the prerequisite,
     * `modify` the in-flight card to be blocked by it, one approval for both).
     *
     * This read took the first carrier alone, so a `modify`'s edges reached the
     * canvas as an empty array: `mergePlanLevel` draws one arrow per entry, had
     * none, and the proposed card rendered beside the card it blocks with no
     * line between them. The patch was already being read eleven lines up to
     * produce the `links` diff row, so the edge was present as a counted word
     * and absent as a shape — which is why nothing looked broken.
     *
     * `blockedByRemove` is deliberately NOT here, and STILL is not: an edge the
     * plan would DELETE is not a blocker this proposal declares, and drawing it
     * as one would say the opposite of what the plan proposes. That reasoning
     * was right and is unchanged — what was missing is the OTHER half, and it
     * is {@link blockedByRemovedNodeIdsOf} below (bug MOTIR-4092).
     *
     * `planProjectionService` unions the same two carriers for the projected
     * reads — one rule, two consumers.
     */
    const blockedByNodeIdsOf = (item: PlanItemDto): string[] => {
      const refs = [...item.blockedByRefs, ...(item.patch?.blockedByAdd ?? [])];
      return [...new Set(refs.map(resolveNodeRef))];
    };
    /**
     * Every COMMITTED blocked-by edge this proposal would DELETE, as canvas node
     * ids (bug MOTIR-4092) — the second half of the sentence above.
     *
     * The exclusion from `blockedByNodeIdsOf` deferred a *treatment the canvas
     * does not have* to "its own card". Until that card, the consequence was
     * that a removal reached the canvas as NOTHING: `mergePlanLevel` started
     * from the committed deps verbatim, so the edge the plan is deleting kept
     * rendering exactly like one it is keeping.
     *
     * ⚠️ THE SHAPE THAT MAKES IT WRONG RATHER THAN MERELY INCOMPLETE is an EDGE
     * SWAP — the correction for an inverted dependency, and the standard output
     * of the run-time correction path. It is necessarily two proposals
     * (`modify A` removing `B`, `modify B` adding `A`), so with the removal
     * unread the canvas drew A → B AND B → A: a mutual block, i.e. a cycle the
     * approve will not produce. The only correct reading of that picture is
     * *"this plan is broken"*, and the plan is fine — so the surface was at its
     * least accurate on exactly the plans a reviewer cannot re-derive by hand.
     *
     * The canvas answers it by SUBTRACTION, not by a marking (bug MOTIR-4098):
     * `mergePlanLevel`
     * drops the committed dep this names, so the graph shows the edge set the
     * approve would leave behind. A marked-as-going-away edge was tried first
     * and reverted — a drawn arrow is read as structure however it is skinned,
     * and the words for the change already exist in the `links` diff row.
     *
     * A removal only bites where the edge EXISTS to begin with, so this resolves
     * refs and leaves it to the level builder to intersect them with the
     * committed deps — a `blockedByRemove` naming an edge that is not on this
     * level simply subtracts nothing, which is the same tolerance the add
     * carrier already has.
     */
    const blockedByRemovedNodeIdsOf = (item: PlanItemDto): string[] => {
      const refs = item.patch?.blockedByRemove ?? [];
      return [...new Set(refs.map(resolveNodeRef))];
    };
    /**
     * What the target ALREADY BRINGS — its committed `blocked_by` edges, as
     * canvas node ids (bug MOTIR-4951). The third carrier, and the only one the
     * plan does not state.
     *
     * ⚠️ NO REF RESOLUTION HERE, and that is not an omission. The two resolvers
     * above turn a PLAN's refs into node ids, and a temp-ref has to be followed
     * to the item it names. These endpoints are committed work items, whose node
     * id IS their work-item id by the one rule at the top of this function — so
     * the row's `blockerId` is already the answer.
     *
     * `[]` for an un-materialized `add`: no `workItemId`, nothing in the map, and
     * nothing it could carry — it is not a work item yet.
     */
    const committedBlockedByOf = (item: PlanItemDto): PlanCommittedBlockerDto[] =>
      (item.workItemId ? committedBlockersByItemId.get(item.workItemId) : undefined) ?? [];
    /**
     * Where this proposal SITS — one rule for all three ops (bug MOTIR-3191).
     *
     * An `add` says so itself, in `parentRef`. A `modify` says so too now — in
     * `patch.parentRef`, the re-parent key (MOTIR-3859). A `remove` cannot, and a
     * `modify` that does not touch the parent cannot either: its placement is the
     * live card's, read off that card.
     *
     * ⚠️ THIS COMMENT USED TO SAY *"a proposal may not move anything"*, and that
     * was true when it was written. It is the sentence MOTIR-3859 makes false, and
     * the canvas is the surface where the difference has to show: a re-parent that
     * drew the card in its OLD level would be the plan review showing the approver
     * the opposite of what approving does. The `undefined` / `null` split is
     * load-bearing here as everywhere in a sparse patch — absent means the parent
     * is unchanged, an explicit `null` means the PROJECT ROOT.
     *
     * A materialized `add` has both; `parentRef` wins, and the two agree.
     */
    const parentNodeIdOf = (item: PlanItemDto): string | null => {
      // A folder is not a node on the canvas: a folder-placed proposal is a ROOT
      // there, and says where it is filed through `folderPath` (MOTIR-5415).
      if (item.parentRef)
        return isFolderRef(item.parentRef) ? null : resolveNodeRef(item.parentRef);
      if (item.op === 'modify' && item.patch?.parentRef !== undefined) {
        const ref = item.patch.parentRef;
        return ref === null || isFolderRef(ref) ? null : resolveNodeRef(ref);
      }
      const target = item.workItemId ? targetById.get(item.workItemId) : undefined;
      return target?.parentId ?? null;
    };
    const childParentIds = new Set(
      withNodeIds.map(({ item }) => parentNodeIdOf(item)).filter((p): p is string => p !== null),
    );
    // The committed cards this plan lays NEW children under — the approve's
    // `gainsChildren` (MOTIR-10102), read off the `add`s alone, as materialize reads it.
    const addParentIds = new Set(
      plan.items
        .filter((i) => i.op === 'add')
        .map((i) => i.parentRef)
        .filter((ref): ref is string => !!ref && !isTempRef(ref) && !isFolderRef(ref)),
    );

    // ── THE FOLDER TRAIL (Bug MOTIR-5782 · MOTIR-5798; design Part XVIII §18.7) ──
    // The folder chain a proposal sits under, with ids, so a canvas can draw a
    // folder as a LEVEL. Its LEAF is, in order: the proposal's own folder
    // (`effectiveFolderIdOf`); else the folder of its ROOT-MOST committed
    // ancestor — a root's own `folderId` is its effective folder, since it has
    // no parent to inherit one from; else, under an intra-plan parent, that
    // proposed parent's leaf, walked up the plan. The ancestor rows are already
    // in hand (the walk above), so the only extra cost is ONE more batched trail
    // read, for the leaves the placement read did not cover.
    const planItemById = new Map(plan.items.map((i) => [i.id, i]));
    const rootFolderIdOf = (workItemId: string): string | null => {
      let cursor: string | null = workItemId;
      const seen = new Set<string>();
      while (cursor && !seen.has(cursor)) {
        seen.add(cursor);
        const row: { parentId: string | null; folderId: string | null } | undefined =
          targetById.get(cursor) ?? ancestorById.get(cursor);
        if (!row) return null;
        if (!row.parentId) return row.folderId ?? null;
        cursor = row.parentId;
      }
      return null;
    };
    const tempParentOf = (item: PlanItemDto): PlanItemDto | undefined => {
      const ref =
        item.parentRef ??
        (item.op === 'modify' && item.patch?.parentRef ? item.patch.parentRef : null);
      return ref && ref.startsWith(TEMP_REF_PREFIX)
        ? planItemById.get(ref.slice(TEMP_REF_PREFIX.length))
        : undefined;
    };
    const folderLeafOf = (item: PlanItemDto, seen = new Set<string>()): string | null => {
      if (seen.has(item.id)) return null;
      seen.add(item.id);
      const own = effectiveFolderIdOf(item);
      if (own) return own;
      const proposedParent = tempParentOf(item);
      if (proposedParent) return folderLeafOf(proposedParent, seen);
      const parentId = parentNodeIdOf(item);
      return parentId ? rootFolderIdOf(parentId) : null;
    };
    const folderLeafByItemId = new Map(plan.items.map((i) => [i.id, folderLeafOf(i)]));
    const unresolvedLeafIds = Array.from(
      new Set(
        Array.from(folderLeafByItemId.values()).filter(
          (id): id is string => !!id && !folderTrailById.has(id),
        ),
      ),
    );
    if (unresolvedLeafIds.length > 0) {
      const extra = await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        folderRepository.findTrailsByIds(unresolvedLeafIds, ctx.workspaceId, tx),
      );
      for (const f of extra) if (f.projectId === plan.projectId) folderTrailById.set(f.id, f.trail);
    }
    const folderTrailOf = (item: PlanItemDto): PlanFolderCrumbDto[] => {
      const leaf = folderLeafByItemId.get(item.id) ?? null;
      return leaf ? (folderTrailById.get(leaf) ?? []) : [];
    };

    const items: PlanReviewItemDto[] = withNodeIds.map(({ item, nodeId }) => {
      const target = item.workItemId ? targetById.get(item.workItemId) : undefined;
      const stale = staleByItem.get(item.id);
      const reasons: StaleReason[] = stale?.reasons ?? [];
      // A `remove`'s WHY (AMENDMENT 18 §3), verbatim; nothing else carries one.
      const removeReason = item.op === 'remove' ? (item.reason ?? null) : null;
      const proposed = item.proposedFields as PlanItemProposedFields | null;
      // Never names Motir's own model (MOTIR-7225); the stored row keeps it.
      const provenance = redactNativeProvenance(proposed?.planningProvenance) ?? null;

      const targetMissing = item.op !== 'add' && !target;
      // ONE computation of the diff, read twice: `changes` is the list row's
      // old→new overlay and `proposal.changedFields` is its key set. Computing
      // them separately is the drift this card exists to make impossible.
      const changes =
        item.op === 'modify'
          ? buildChanges(
              item.patch,
              target,
              nameParent,
              statusByKey,
              placementSides,
              refChipOf,
              item.workItemId ? todoCountById.get(item.workItemId) : undefined,
              {
                park: item.workItemId ? parkPriorById.get(item.workItemId) : undefined,
                gainsChildren: item.workItemId ? addParentIds.has(item.workItemId) : false,
              },
            )
          : [];
      // An `add`'s SUPERSEDES chips (MOTIR-6632, Part XXIV §24.8) — ONE local, two
      // carriers (the item and the envelope), as `resolvedTodos` below.
      const supersedesChips: PlanRefChipDto[] =
        item.op === 'add' ? (item.supersedesRefs ?? []).map(refChipOf) : [];
      // A `modify`'s MARK-GROUP rows (§24.12) — the SAME objects as `changes`,
      // filtered, never a second diff.
      const markChanges = changes.filter((c) => isMarkChangeField(c.field));

      // THE PROPOSED STEPS, resolved for READING (MOTIR-4622 · AMENDMENT 14 D5,
      // D6; `design/ai-planning/design-notes.md` Part XV).
      //
      // ⚠️ `executor` IS RESOLVED HERE — `row.executor ?? proposal.executor ??
      // 'human'` is exactly what `plansService.materialize` writes, so the peek
      // shows WHAT APPROVE WILL WRITE rather than the raw field. Sending the
      // null and resolving on the client would put one seed rule in two places,
      // and the client's copy is the one nothing tests against materialize.
      //
      // ⚠️ `add` ONLY. A `modify`'s target is a committed card whose list is a
      // person's PROGRESS: `QuickViewData` carries no to-do field and a `modify`
      // patch carries no `todos`, so there is nothing to show and nothing this
      // plan could change (D2). An `add` with no rows is `null` too, so the peek
      // renders no section at all — a row's absence is a statement about the
      // SUBJECT (Part XIV §1), and an empty `0 of 0` would assert that a planner
      // considered the steps and proposed none.
      //
      // The op gate is written AT THE TWO CARRIERS below rather than here, in the
      // literal `field: item.op === 'add' ? … : null` shape every other add-only
      // field on this DTO uses — `tests/dto/planReviewFieldParity.test.ts` reads
      // the service SOURCE for that shape, so a disposition declared there and a
      // gate hidden behind a local would be a claim the guard cannot check.
      const resolvedTodos: PlanReviewTodoDto[] | null =
        proposed?.todos && proposed.todos.length > 0
          ? proposed.todos.map((row) => ({
              text: row.text,
              notesMd: row.notesMd ?? null,
              commandText: row.commandText ?? null,
              executor: (row.executor ??
                proposed?.executor ??
                'human') as PlanReviewTodoDto['executor'],
            }))
          : null;

      // The COMMITTED parent, when there is one. Two sources now (MOTIR-3191):
      // a `parentRef` naming a real work item — an `add`, saying where it wants
      // to land — and the parent a `modify` / `remove` INHERITS from its target,
      // which is the only way a proposal about an existing card can name one. An
      // intra-plan (`planItem:`) parent is neither: it already has a node in the
      // proposed set, so the canvas draws it and the breadcrumb does not.
      //
      // The row comes from either batched map: a `parentRef` target was read in
      // round 1, an inherited parent by the ancestor walk. An archived or
      // hard-deleted parent is in neither, and the item then reads as a root —
      // degrade, never throw (MOTIR-3083 AC 5).
      const parentNodeId = parentNodeIdOf(item);
      const committedParentId = item.parentRef
        ? item.parentRef.startsWith(TEMP_REF_PREFIX) || isFolderRef(item.parentRef)
          ? null
          : item.parentRef
        : parentNodeId;
      const folderId = effectiveFolderIdOf(item);
      const folderPath = folderId ? (folderPathById.get(folderId) ?? null) : null;
      // `parentNodeIdOf` already prefers a `modify`'s `patch.parentRef`
      // (MOTIR-3859), so the breadcrumb and the level follow the PROPOSED
      // placement rather than the one the card is leaving.
      const committedParent = committedParentId
        ? (targetById.get(committedParentId) ?? ancestorById.get(committedParentId))
        : undefined;

      return {
        planItemId: item.id,
        op: item.op,
        nodeId,
        parentNodeId,
        parentIdentifier: committedParent?.identifier ?? null,
        parentTitle: committedParent?.title ?? null,
        parentKind: committedParent?.kind ?? null,
        // MOTIR-3152's committed ancestor trail — unchanged by this merge.
        parentTrail: committedParent ? trailFor(committedParent.id) : [],
        folderId,
        folderPath,
        folderMissing: folderId !== null && folderPath === null,
        folderTrail: folderId !== null && folderPath === null ? [] : folderTrailOf(item),
        blockedByNodeIds: blockedByNodeIdsOf(item),
        blockedByRemovedNodeIds: blockedByRemovedNodeIdsOf(item),
        committedBlockedBy: committedBlockedByOf(item),
        // Filled once every item is built — the naming-stub pass below (bug
        // MOTIR-5387) names a blocker that is itself a proposal by this model.
        blockerStubs: [],
        // The target's key, for EVERY op that has a target (MOTIR-3160). An
        // un-materialized `add` still reports null — it has no key and inventing
        // one would be the surface asserting a work item that does not exist —
        // but an approved one now names the card it became, which is what lets a
        // reader answer *what did I just say yes to?* on the surface that asked.
        identifier: target?.identifier ?? null,
        // THE TITLE THE PROPOSAL IS ASKING FOR (MOTIR-4018, Part XIII §1).
        //
        // A `modify` carrying `patch.title` reports THAT, not the name the card
        // is about to stop being called. `buildChanges` eleven lines up already
        // knew — it emits `{ field: 'title', from: target, to: patch.title }` —
        // so the same response was carrying the proposed title in one field and
        // refusing it in the other.
        //
        // The fix is at the PRODUCER, once: every consumer reads this field and
        // none of them should have to learn about `patch` (the shape MOTIR-3191
        // established one axis over, for the same model getting a `modify`'s
        // PLACEMENT wrong). The patch is SPARSE, so `?? target?.title` is
        // load-bearing: an absent `title` means the name is unchanged.
        title:
          item.op === 'add'
            ? (proposed?.title ?? 'Untitled item')
            : ((item.op === 'modify' ? item.patch?.title : undefined) ??
              target?.title ??
              'Unavailable item'),
        kind: item.op === 'add' ? (proposed?.kind ?? 'task') : (target?.kind ?? 'task'),
        // THE RAIL, ON EVERY OP (bug MOTIR-4143) — the value the card will have
        // if this proposal is approved, which is the question the quick view's
        // rail is asked. See `proposedValue` for why these stopped being
        // add-only and what that costs.
        priority: proposedValue(
          'priority',
          item,
          proposed?.priority ?? null,
          target?.priority ?? null,
        ),
        type: proposedValue('type', item, proposed?.type ?? null, target?.type ?? null),
        // THE BODY THE PROPOSAL IS ASKING FOR, ON EVERY OP (bug MOTIR-4134) —
        // see `proposedBody` for why this is not `op === 'add' ? … : null`.
        descriptionMd: proposedBody('descriptionMd', item, proposed, target),
        // The rest of the proposed set (MOTIR-3084) — everything `materialize`
        // writes onto the created item, so the reviewer sees what approval will
        // make. Read off `proposed` rather than enumerated by hand anywhere else;
        // the parity test is what keeps this list honest as the type grows.
        explanationMd: proposedBody('explanationMd', item, proposed, target),
        // ⚠️ `explanationSource` stays add-ONLY, deliberately, and the op-axis
        // guard in `tests/dto/planReviewFieldParity.test.ts` is where that is
        // written down. `PlanItemPatch` has no `explanationSource` twin ON
        // PURPOSE — a patch that could write it would let a plan forge
        // provenance — and `applyModify` leaves the target's value alone. So a
        // `modify` has nothing to say here: reporting the TARGET's source
        // beside a REWRITTEN body would attribute the new text to whoever wrote
        // the old, which is the same class of false statement this bug is
        // about, pointing the other way.
        explanationSource: item.op === 'add' ? (proposed?.explanationSource ?? null) : null,
        // ⚠️ The target's points are a Prisma `Decimal`; `buildChanges` converts
        // the same column the same way, and the DTO is a number.
        storyPoints: proposedValue(
          'storyPoints',
          item,
          proposed?.storyPoints ?? null,
          target?.storyPoints == null ? null : Number(target.storyPoints),
        ),
        estimateMinutes: proposedValue(
          'estimateMinutes',
          item,
          proposed?.estimateMinutes ?? null,
          target?.estimateMinutes ?? null,
        ),
        // A leaf's DIFFICULTY (story MOTIR-6095 · MOTIR-6137) — patch-or-target on
        // every op, as `storyPoints` is: the peek's rail and the card's top row
        // read the value approve will WRITE. A container never carries one.
        difficulty: proposedValue(
          'difficulty',
          item,
          proposed?.difficulty ?? null,
          target?.difficulty ?? null,
        ),
        targetRepo: proposedValue(
          'targetRepo',
          item,
          proposed?.targetRepo ?? null,
          target?.targetRepo ?? null,
        ),
        // THE SET (bug MOTIR-4904) — patch-or-target on every op, the same rule
        // `targetRepo` above follows and for the same reason: the quick view has
        // no diff, so the rail answers what the card WILL BE. A proposal that
        // pinned the singular reports it as the one-element set it means, so the
        // row never reads "no repositories" for a card that has one.
        targetRepos: proposedValue(
          'targetRepos',
          item,
          proposed?.targetRepos ?? (proposed?.targetRepo ? [proposed.targetRepo] : []),
          target?.targetRepos ?? [],
        ),
        // ⚠️ `add`-ONLY, and the reason is at the field on the DTO: these are row
        // cuids, an authoring form rather than a value a reviewer reads, and the
        // names they resolve to are what `targetRepos` directly above carries.
        targetRepositories: item.op === 'add' ? (proposed?.targetRepositories ?? null) : null,
        // The singular ROW-ID pin (Story MOTIR-2732 · MOTIR-3045, surfaced by
        // MOTIR-4924) — `add`-ONLY for exactly the same reason: a cuid is an
        // authoring form, not a value a reviewer reads, and the repository it names
        // is what `targetRepo` / `targetRepos` carry once resolved. On a `modify`
        // the re-pin is read off the DIFF (`buildChanges`, under `targetRepo`), so
        // the rail need not repeat it.
        targetRepositoryRef: item.op === 'add' ? (proposed?.targetRepositoryRef ?? null) : null,
        // ⚠️ NO TARGET FALLBACK, and that is not an omission: `work_item.
        // targetRepoRole` is RETIRED (Story MOTIR-2732 · MOTIR-3040), so a
        // committed card HAS no role to report. A `modify` shows the role only
        // when its own patch names one, which is the same rule with the target
        // side empty — see `buildChanges`, which says so at its own row.
        targetRepoRole: proposedValue(
          'targetRepoRole',
          item,
          proposed?.targetRepoRole ?? null,
          null,
        ),
        // ⚠️ `executor` HAS NO PATCH KEY — a plan cannot choose who executes a
        // committed card — so a `modify` has no proposed side. What it CAN do is
        // re-type a target that has no executor, and then the approve SEEDS the
        // type's default (bug MOTIR-6259); the rail answers what the card WILL
        // BE, so it reads the same derivation `applyModify` writes. It does not
        // go through `proposedValue` because that function's parameter is a
        // patch key.
        executor:
          item.op === 'add'
            ? (proposed?.executor ?? null)
            : item.op === 'modify'
              ? seededExecutor(item.patch as PlanItemPatch | null, target)
              : (target?.executor ?? null),
        planningProvenance: item.op === 'add' ? provenance : null,
        // ⚠️ `add`-ONLY, on `planningProvenance`'s own terms (Story MOTIR-5062 ·
        // MOTIR-5065): the subject describes the PASS that derived it, not the
        // card. `PlanItemPatch` has no `subject` twin, so a `modify` proposes
        // none — and reporting the TARGET's here would credit this pass with a
        // coordinate an earlier one derived, which is the `explanationSource`
        // mistake one field up. The op-axis guard is where that is written down.
        subject: item.op === 'add' ? (proposed?.subject ?? null) : null,
        // Same rule, same source, same read (MOTIR-3160): a materialized `add`
        // has a live status because it is a live work item. Populating the
        // identifier off `target` and leaving the status null would split one
        // batched read across two cards for no reason.
        status: target?.status ?? null,
        // The status's own IDENTITY (bug MOTIR-3170) — its label and lifecycle
        // category, so the canvas chip can name a status it has no per-key
        // treatment for instead of coercing it to `todo`. Resolved off the SAME
        // `target`, and therefore under MOTIR-3160's rule directly above rather
        // than the `op === 'add'` guard that rule removed: a status that is
        // non-null must be nameable, or the chip is back to guessing.
        statusLabel: statusByKey.get(target?.status ?? '')?.label ?? null,
        statusCategory: statusByKey.get(target?.status ?? '')?.category ?? null,
        hasChildren: childParentIds.has(nodeId),
        changes,
        // THE PROPOSED STEPS (Story MOTIR-3810 · MOTIR-4622 · Part XV).
        //
        // ⚠️ ONE LOCAL, TWO CARRIERS, NO SECOND DERIVATION — the discipline
        // `changedFields` states four lines down. It rides the ITEM because the
        // review model is what a projection test reads, and the ENVELOPE because
        // the envelope is what reaches the peek; the envelope's copy below is
        // this same resolved list, never a re-read of `proposed`.
        todos: item.op === 'add' ? resolvedTodos : null,
        // A RECENCY fact, not a second reading of `op` (Part XII §E).
        revised: revisedItemIds.has(item.id),
        stale: reasons.length > 0,
        staleReasons: reasons,
        targetMissing,
        // WHAT ONLY A PROPOSAL HAS (MOTIR-4183, design Part XIV §2 as amended).
        //
        // ⚠️ `changedFields` is the key set of the SAME `changes` array three
        // lines up — not a second comparison. A marker computed from its own
        // diff would be right the day it shipped and would drift the first time
        // a field was added to only one of them, invisibly, because each surface
        // would stay self-consistent. One source is the criterion (AC 4), and
        // reading it off `changes` is how that is guaranteed rather than tested.
        //
        // ⚠️ NO PAYLOAD IS MERGED IN HERE. A `modify` / `remove` names a real
        // work item and the shipped peek is already client-fetched by key from
        // both hosts, so the overlay happens ON OPEN. Merging here would mean
        // `getQuickView` — ~14 reads — once per proposal, on a read whose header
        // advertises ONE batched target read and no N+1.
        proposal: {
          op: item.op,
          identifier: target?.identifier ?? null,
          changedFields: changes.map((c) => c.field as PlanItemChangeField),
          settableRailFields: PLAN_ITEM_SETTABLE_RAIL_FIELDS,
          todos: item.op === 'add' ? resolvedTodos : null,
          removeReason,
          markChanges,
          supersedesRefs: supersedesChips,
        },
        removeReason,
        supersedesRefs: supersedesChips,
      };
    });

    // ── THE NAMING STUBS (bug MOTIR-5387) ──────────────────────────────────────
    //
    // A SECOND PASS, because a blocker that is itself a PROPOSAL is named by what
    // this model says about it — the title it asks for, and the level it lands on
    // (`parentNodeIdOf`, so a blocker the plan re-parents reports its
    // DESTINATION). Both exist only once every item is built. A committed blocker
    // the plan says nothing about is named off its row from the batched read.
    //
    // `parentNodeId` is what lets the canvas tell a blocker OFF the level from a
    // member of it that the capped level read did not carry (MOTIR-5043). An
    // archived row gets no stub, and neither does a proposal whose target is gone:
    // the canvas draws nothing it cannot name, and `stale` reports those.
    const itemByNodeId = new Map(items.map((i) => [i.nodeId, i]));
    const blockerStubOf = (nodeId: string): PlanBlockerStubDto | null => {
      const proposal = itemByNodeId.get(nodeId);
      if (proposal && !proposal.targetMissing) {
        return {
          nodeId,
          identifier: proposal.identifier,
          title: proposal.title,
          isDone: proposal.status === 'done',
          parentNodeId: proposal.parentNodeId,
        };
      }
      const row = targetById.get(nodeId);
      if (!row || row.archivedAt) return null;
      return {
        nodeId,
        identifier: row.identifier,
        title: row.title,
        isDone: row.status === 'done',
        parentNodeId: row.parentId,
      };
    };
    for (const item of items) {
      const blockerNodeIds = new Set([
        ...item.blockedByNodeIds,
        ...item.committedBlockedBy.map((b) => b.nodeId),
      ]);
      item.blockerStubs = [...blockerNodeIds]
        .map(blockerStubOf)
        .filter((stub): stub is PlanBlockerStubDto => stub !== null);
    }

    // ── THE PROPOSED BODIES' WORK-ITEM CHIPS (bug MOTIR-9355) ──────────────────
    //
    // Every `[KEY](motir:<id>)` in a proposal's title and two bodies is resolved
    // HERE, in ONE batched read for the whole plan, and each item carries the
    // summaries of its own links. The peek renders the PROPOSED bodies, so it
    // needs THEIR refs: an `add` has no work item to read a map from, and a
    // `modify`'s target map is resolved from the target's stored description
    // alone. Resolved for the ORIGINAL reader, so a Visitor gets the Visitor's
    // narrowing and nothing beyond it. A plan whose bodies link nothing pays no
    // read at all (`resolveWorkItemRefSummaries` returns `{}` for an empty set).
    const refIdsByItem = new Map(
      items.map((i) => [
        i.planItemId,
        parseWorkItemTokenIds(
          // A proposed step's NOTES draw in the peek too (bug MOTIR-10023).
          [i.title, i.descriptionMd, i.explanationMd, ...(i.todos ?? []).map((t) => t.notesMd)]
            .filter(Boolean)
            .join('\n'),
        ),
      ]),
    );
    // The plan's own SUMMARY (the briefing) rides the SAME read (bug MOTIR-9697):
    // both surfaces that draw it — the review rail and the overlay's briefing
    // bubble — had no map built from it, so every chip in it was drawn deleted.
    const summaryRefIds = plan.summary ? parseWorkItemTokenIds(plan.summary) : [];
    const bodyRefs = await resolveWorkItemRefSummaries(
      { ids: [...new Set([...refIdsByItem.values()].flat().concat(summaryRefIds))], keys: [] },
      plan.projectId,
      reader,
    );
    for (const item of items) {
      item.workItemRefs = Object.fromEntries(
        (refIdsByItem.get(item.planItemId) ?? []).flatMap((id) => {
          const summary = bodyRefs[id];
          return summary ? [[id, summary]] : [];
        }),
      );
    }
    const summaryRefs: WorkItemRefMap = Object.fromEntries(
      summaryRefIds.flatMap((id) => {
        const summary = bodyRefs[id];
        return summary ? [[id, summary]] : [];
      }),
    );

    // ── WHAT EACH OFF-LEVEL EDGE DRAWS AFTER APPROVE (MOTIR-6362) ──────────────
    //
    // The committed roadmap draws an off-level edge by its DISPOSITION (MOTIR-6359:
    // `covered` draws nothing, `exempt` a neutral anchor, `uncovered` / `cross_level`
    // the "blocked elsewhere" flag), and the review canvas must show the level the
    // reviewer gets once they approve. So the question is asked of the PROJECTION —
    // the tree this plan leaves behind — not of the committed tree, in two places:
    //
    //  - every blocker a proposal carries (its stub), because a plan that adds X →
    //    Y may also wire X's parent to Y's parent, and then the edge is covered;
    //  - the COMMITTED edges whose parents' edge this plan adds or removes (a
    //    `modify`'s `blockedByAdd` / `blockedByRemove` on the parent), because the
    //    committed level the canvas reads was judged against a parent edge the
    //    plan is changing. Those arrive as `edgeCoverage` overrides.
    //
    // A DECIDED plan is not projected: its proposals have materialized or never
    // will, and the canvas keeps the roadmap read's own dispositions for it.
    let edgeCoverage: PlanEdgeCoverageDto[] = [];
    if (plan.status === 'generating' || plan.status === 'planned') {
      // The plan this read already admitted and loaded is handed over so the projection does not
      // admit the reader and read every proposal a second time on each tick (MOTIR-8127), and the
      // FOCUSED scope (MOTIR-8146) reads only the nodes this plan names, their ancestors and the
      // edges between them — not the project's whole live item set.
      const proj = await buildProjection(planId, ctx, { plan, scope: 'edge_coverage' });
      const projIdOf = (nodeId: string): string => {
        const proposal = itemByNodeId.get(nodeId);
        return proposal && proposal.op === 'add' && proposal.nodeId === proposal.planItemId
          ? `${TEMP_REF_PREFIX}${proposal.planItemId}`
          : nodeId;
      };
      const nodeIdOfProj = (projId: string): string =>
        projId.startsWith(TEMP_REF_PREFIX)
          ? (nodeIdByPlanItemId.get(projId.slice(TEMP_REF_PREFIX.length)) ??
            projId.slice(TEMP_REF_PREFIX.length))
          : projId;
      for (const item of items) {
        for (const stub of item.blockerStubs) {
          const coverage = projectedEdgeDisposition(
            proj,
            projIdOf(item.nodeId),
            projIdOf(stub.nodeId),
          );
          if (coverage !== undefined) stub.coverage = coverage;
        }
      }
      // The parent pairs this plan's `modify`s link or unlink, and every projected
      // child edge running between them.
      const seenEdge = new Set<string>();
      for (const planItem of plan.items) {
        if (planItem.op !== 'modify' || !planItem.workItemId) continue;
        const refs = [
          ...(planItem.patch?.blockedByAdd ?? []),
          ...(planItem.patch?.blockedByRemove ?? []),
        ];
        for (const ref of refs) {
          // The projection keys an `add` by its `planItem:` temp-ref, exactly as the
          // ref is written — so the ref is used as-is, never through `resolveRef`.
          const blockerParent = ref;
          for (const child of proj.childrenByParent.get(planItem.workItemId) ?? []) {
            for (const blocker of proj.blockedBy.get(child) ?? []) {
              if (proj.nodes.get(blocker)?.parentId !== blockerParent) continue;
              const key = `${child} ${blocker}`;
              if (seenEdge.has(key)) continue;
              seenEdge.add(key);
              const coverage = projectedEdgeDisposition(proj, child, blocker);
              if (coverage === undefined) continue;
              edgeCoverage.push({
                blockedId: nodeIdOfProj(child),
                blockerId: nodeIdOfProj(blocker),
                coverage,
              });
            }
          }
        }
      }
      edgeCoverage = edgeCoverage.sort(
        (a, b) => a.blockedId.localeCompare(b.blockedId) || a.blockerId.localeCompare(b.blockerId),
      );
    }

    const decidedByName = plan.decidedById
      ? ((await userRepository.findById(plan.decidedById))?.name ?? null)
      : null;
    // WHO ASKED (MOTIR-2991) — resolved exactly as the decider is, one plan and
    // one lookup. (The LIST does this batched, across a page; here there is a
    // single row, so a second `findById` is the right shape and matches the
    // pattern immediately above rather than inventing one.)
    const createdByName = plan.createdById
      ? ((await userRepository.findById(plan.createdById))?.name ?? null)
      : null;

    const derived: PlanHistoryEventDto[] = [
      { id: 'lifecycle:created', kind: 'created', at: plan.createdAt },
    ];
    if (plan.plannedAt)
      derived.push({ id: 'lifecycle:planned', kind: 'planned', at: plan.plannedAt });
    if (plan.status === 'approved' || plan.status === 'declined') {
      // The EVENT kind, which for a `declined` plan is not the status
      // (MOTIR-3189). One status covers three histories — a person rejected a
      // finished plan, a person discarded one mid-generation, the sweep
      // terminated a dead producer — and the timeline is where the difference
      // has to be visible. `reviewed` and a null reason both land on `declined`:
      // an unrecorded reason is the pre-column default, and inventing a more
      // specific event for it would be a guess.
      const kind =
        plan.status === 'declined' && plan.decisionReason && plan.decisionReason !== 'reviewed'
          ? plan.decisionReason
          : plan.status;
      derived.push({ id: `lifecycle:${kind}`, kind, at: plan.decidedAt, byName: decidedByName });
    }

    // The CONTENT half. Every actor NAME the trail needs resolves in ONE batched
    // read — a plan deepened proposal by proposal has a row per proposal, and a
    // `findById` per row is the N+1 this surface cannot afford.
    const actorIds = Array.from(
      new Set(revisions.map((r) => r.changedById).filter((id): id is string => !!id)),
    );
    const actorNameById = new Map(
      (actorIds.length > 0 ? await userRepository.findByIds(actorIds) : []).map((u) => [
        u.id,
        u.name,
      ]),
    );
    const stored: PlanHistoryEventDto[] = revisions
      // The four the derived events already say, dropped HERE rather than at the
      // write: the trail is the audit record and must be complete; the timeline
      // is a reading of it and must not say the same thing twice. The lease's
      // heartbeat (MOTIR-7988) is dropped for the other reason: it is no event.
      .filter(
        (r: PlanRevision) =>
          !DERIVED_EVENT_KINDS.has(r.changeKind) && !TRAIL_ONLY_KINDS.has(r.changeKind),
      )
      .map((r: PlanRevision) => ({
        id: r.id,
        kind: r.changeKind,
        at: r.changedAt.toISOString(),
        count: revisionCount(r.diff),
        byName: r.changedById ? (actorNameById.get(r.changedById) ?? null) : null,
        actorSource: r.actorSource,
        actorHarness: r.actorHarness,
        // Never names Motir's own model (MOTIR-7225); the trail row keeps it.
        actorModel: redactNativeActor(r.actorSource, r.actorModel),
      }));

    const history = mergeTimeline(derived, stored);

    const staleCount = items.filter((i) => i.stale).length;

    // ── HOW BIG IS THE LEVEL THE CANVAS ARRIVES AT (MOTIR-4024, Part XIII §6) ──
    //
    // The derived default view has to answer *can the canvas hold this plan's
    // cards together?* BEFORE the canvas has drawn anything, and the answer is
    // about the level's COMMITTED neighbourhood, which the plan's own items say
    // nothing about. So it is read once, here, where the arrival container is
    // already resolved — `fullestContainer` is the same function the arrival
    // level itself reads, so the two cannot name different levels.
    //
    // A container that is ITSELF a proposal has no committed children, and the
    // count comes back 0 without a special case: no work item carries that id.
    const arrivalContainer = fullestContainer(items);
    const arrivalParentId = arrivalContainer?.parentNodeId ?? null;
    const arrivalLevelTotal =
      (await withWorkspaceServiceContext(ctx.workspaceId, (tx) =>
        workItemRepository.countSiblingsInWorkspace(
          plan.projectId,
          arrivalParentId,
          ctx.workspaceId,
          tx,
        ),
      )) +
      // The plan's own `add`s draw a node each and no committed row backs them.
      // A `modify` / `remove` SHARES its node with the committed card it targets,
      // so counting it again would double it.
      items.filter((i) => i.op === 'add' && (i.parentNodeId ?? null) === arrivalParentId).length;
    // What the canvas will actually DRAW: the level read is capped, so a level
    // past the cap draws the cap, not its total. Both numbers are carried because
    // the two arms of the rule read different ones — the legibility arm reads what
    // is drawn, the truncation arm reads what was dropped.
    const arrivalLevelSize = Math.min(arrivalLevelTotal, TREE_LEVEL_MAX_TAKE);

    // THE PLAN'S PROGRESS (Story MOTIR-7820 · MOTIR-7825) — the one derivation,
    // built from the items and steps this read already holds. The committed rows
    // it read for targets and ancestors already name most step targets, so the
    // poll gains at most one small titles read.
    const knownTitles = new Map<string, string>();
    for (const row of ancestorById.values()) knownTitles.set(row.id, row.title);
    const progress = await planProgressService.snapshotForReview(
      {
        id: plan.id,
        projectId: plan.projectId,
        status: plan.status,
        createdAt: plan.createdAt,
        lastActivityAt,
        authorSource: plan.authorSource,
        sessionId: plan.sessionId,
      },
      plan.items,
      inFlightSteps,
      ctx,
      knownTitles,
    );

    return {
      id: plan.id,
      projectId: plan.projectId,
      status: plan.status,
      title: plan.title,
      summary: plan.summary,
      summaryRefs,
      itemCount: plan.itemCount,
      createdAt: plan.createdAt,
      plannedAt: plan.plannedAt,
      decidedAt: plan.decidedAt,
      decidedByName,
      // WHY it ended (MOTIR-3189) — read by the outcome block, which otherwise
      // tells somebody their half-generated plan was reviewed and rejected.
      decisionReason: plan.decisionReason,
      // The three-party attribution the header renders (`design-notes.md`
      // Part III §6). `origin` separates *nobody asked* from a plan somebody
      // requested; the authorship triple now answers *who wrote it* on its own,
      // so `sourceJobId` is no longer carried (MOTIR-2996) — it named WHICH JOB
      // and was only ever here to stand in for WHO.
      origin: plan.origin,
      createdByName,
      authorSource: plan.authorSource,
      authorHarness: plan.authorHarness,
      authorModel: redactNativeActor(plan.authorSource, plan.authorModel),
      // Present ⟺ the lease is HELD. A null is one check at the call site and
      // cannot be misread as *a revision that finished*.
      revision: lease
        ? {
            heldBy: lease.heldBy,
            expiresAt: lease.expiresAt.toISOString(),
            startedAt: (revisionStartedAt ?? new Date()).toISOString(),
          }
        : null,
      lastActivityAt,
      // Only a `generating` plan is polled, so only it is handed a token to poll with.
      ...(version?.status === 'generating' ? { reviewVersion: version.token } : {}),
      inFlightSteps,
      progress,
      gate,
      conversation,
      narration,
      history,
      items,
      edgeCoverage,
      stale: staleCount > 0,
      staleCount,
      arrivalLevelSize,
      arrivalLevelTotal,
    };
  },
};

/** The plan's question as the planning surface reads it — the gate's render read,
 *  narrowed to what a press needs (MOTIR-6038). */
async function readPlanGate(
  planId: string,
  ctx: ServiceContext,
): Promise<PlanReviewGateDto | null> {
  const read = await approvalGatesService.getForPlan({ planId }, ctx);
  if (!read.gate) return null;
  return {
    id: read.gate.id,
    state: read.gate.state,
    stamp: read.stamp,
    held: read.gate.held ?? null,
    canDecide: read.canDecide,
    routedToName: read.routedToLabel,
  };
}

/** The plan's planning session, as {@link PlanConversationDto} — or null when it has
 *  none (MOTIR-6037). Reads through the plan gate row's own projection. */
async function readPlanConversation(
  planId: string,
  tx: Prisma.TransactionClient,
): Promise<PlanConversationDto | null> {
  const [plan] = await planRepository.findManyForGateSummary([planId], tx);
  if (!plan?.sessionId) return null;
  return {
    sessionId: plan.sessionId,
    hasTurns: (plan.session?.turnCount ?? 0) > 0,
    targetKeys: plan.session?.targetKeys ?? [],
  };
}
