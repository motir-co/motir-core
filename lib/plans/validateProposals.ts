// ── The confirmation gate, at the persist boundary (Subtask 7.12.5 · MOTIR-911) ─
//
// No proposed tree change becomes rows except through an explicit human approve
// of that proposal — and that approve RE-VALIDATES the proposal INDEPENDENTLY
// before it writes anything. This module is that re-validation: a PURE function
// (no DB, no Prisma client) over a plan's PlanItems plus the small live-state
// bag the service resolves for it, so it can run BEFORE the approve transaction
// opens and again INSIDE it, under the row locks, without a second code path.
//
// WHY IT EXISTS. `plansService.materialize` took `kind = pf.kind ?? 'task'` and
// inserted straight through `workItemRepository.create`, so the only backstop
// against a malformed proposal was the DB trigger — which surfaces a raw
// SQLSTATE 23514 as a 500, mid-transaction, for what is really a bad proposal.
// And nothing stopped a `modify`/`remove` from rewriting COMPLETED work: the
// planner locks done nodes (7.4.4), but the approved proposal set can be edited
// between generation and approve (`updateProposal`), so the proposal is NOT
// trusted here. Core re-checks — defense in depth.
//
// WHAT IT DOES NOT DO. It never re-encodes the kind-parent matrix: the grammar
// verdict comes from `lib/issues/parentRules.ts` (`assertValidParent`), the SAME
// single source of truth `workItemsService` gates every human create/move on.
// This module only resolves each proposal's EFFECTIVE parent kind (through the
// intra-plan temp-ref graph) and asks that gate.
//
// ATOMICITY is the point of doing all of it up front: a rejection must leave the
// tree byte-identical, so every check completes before the first write.

import {
  assertValidParent,
  assertValidPlacement,
  isIssueType,
  type IssueType,
} from '@/lib/issues/parentRules';
import { isWorkItemType, WORK_ITEM_TYPES } from '@/lib/issues/executorDefaults';
import { describeSubjectShape, isWellFormedSubject } from '@/lib/plans/subjectShape';
import { isDifficultyRefusedOnKind } from '@/lib/plans/validateProposedDifficulty';
import { isContainerKind, isModifyKindTarget } from '@/lib/plans/validateProposedKind';
import { MODIFY_KIND_TARGETS } from '@/lib/dto/plans';
import { isMarkOnlyPatch } from '@/lib/plans/markOnlyPatch';
import {
  assertMarkTargetIsFinished,
  patchSetsObsolescence,
} from '@/lib/plans/validateProposedObsolescence';
import type { StatusCategoryDto } from '@/lib/dto/workflows';
import { IllegalParentTypeError } from '@/lib/workItems/errors';
import { crossLevelReason, isCrossLevelEdge } from '@/lib/workItems/edgeLevel';
import {
  FOLDER_REF_PREFIX,
  folderRefId,
  isFolderRef,
  isTempRef,
  isWorkItemRef,
  SUPERSEDES_PATCH_SITES,
  tempRefId,
  TEMP_REF_PREFIX,
} from '@/lib/plans/refs';
import { PlanGrammarError, PlanRefGraphError, PlanTargetImmutableError } from '@/lib/plans/errors';

/** The kind `materialize` falls back to when an `add` proposes none. */
export const DEFAULT_PROPOSED_KIND = 'task';

/**
 * One proposal, in the minimal shape the gate reads. A structural subset of the
 * Prisma `PlanItem` row (whose `proposedFields` / `patch` are `Json`), so the
 * validator stays free of Prisma types and is unit-testable without a DB.
 */
export interface ProposalNode {
  id: string;
  op: 'add' | 'modify' | 'remove';
  /** The existing target of a `modify`/`remove` (null on an un-materialized `add`). */
  workItemId: string | null;
  /**
   * A real work-item id, an intra-plan `planItem:<id>` temp-ref, a
   * `folder:<id>` placement (MOTIR-5414), or null.
   */
  parentRef: string | null;
  blockedByRefs: string[];
  /**
   * `add` only — the OLDER cards the created card SUPERSEDES (MOTIR-6630), each
   * a real work-item id or a `planItem:` temp-ref. Optional so a node built
   * before the column reads as none; the service projects it from the row.
   */
  supersedesRefs?: readonly string[];
  /**
   * `add` only — the gate reads the two CLOSED-SET columns it can reject before
   * a write: the proposed `kind` and the proposed `type` (MOTIR-3654) — plus the
   * proposed `title`, which it never JUDGES and only ever NAMES (MOTIR-3936): a
   * proposal on a rejected cycle has no work-item key yet, so its title is the
   * only identity a message can give a reader.
   */
  proposedFields: {
    kind?: string | null;
    type?: string | null;
    title?: string | null;
    /** The SUBJECT coordinate (MOTIR-5065) — shape- and kind-checked here; its
     *  MEMBERSHIP is deliberately not this repository's to know. */
    subject?: string | null;
    /** A leaf's DIFFICULTY (MOTIR-6133) — refused on a container kind
     *  (`difficulty_on_container`). Membership is the proposal doors'. */
    difficulty?: string | null;
  } | null;
  /**
   * `modify` only — the gate reads the edge refs, and (MOTIR-3859) the
   * `parentRef` a re-parent travels on. `undefined` and `null` are DIFFERENT
   * here, as everywhere in a sparse patch: absent leaves the parent alone, an
   * explicit `null` moves the target to the project root.
   */
  patch: {
    parentRef?: string | null;
    /** A re-judged DIFFICULTY (MOTIR-6133) — refused when the TARGET's
     *  PROJECTED kind is a container (`difficulty_on_container`). */
    difficulty?: string | null;
    /** A REPLACEMENT step list (MOTIR-8668 · AMENDMENT 27) — refused when the
     *  TARGET's PROJECTED kind is a container and the list is non-empty
     *  (`todos_on_container`). The rows' caps are the proposal doors'. */
    todos?: unknown[] | null;
    /** A RE-KIND of the target (bug MOTIR-8192 · AMENDMENT 25) — judged against
     *  the projected tree by {@link assertKindChangesLegal}, and the kind every
     *  other placement question in this gate reads for the target. */
    kind?: string | null;
    /** A re-type (read here only by the re-kind's leaf-field check). */
    type?: string | null;
    blockedByAdd?: string[] | null;
    blockedByRemove?: string[] | null;
    /** The obsolescence MARK and its note (MOTIR-6629) — membership is the
     *  proposal doors'; step 4 reads whether the patch carries mark keys ALONE
     *  (`isMarkOnlyPatch`), which admits it to a terminal target, and step 4b
     *  (MOTIR-6663) refuses a patch SETTING a mark on an unfinished target. The gate reads the patch's whole KEY SET for that, so every other
     *  key the row holds counts against the carve-out even though it is not
     *  typed here. */
    obsolescence?: string | null;
    obsolescenceNoteMd?: string | null;
    /** The four `supersedes` edge lists (MOTIR-6630): the target is the NEWER
     *  end of `supersedesAdd` / `supersedesRemove` and the OLDER end of
     *  `supersededByAdd` / `supersededByRemove`. Checked like the blocker lists
     *  and walked by `assertSupersedesGraphAcyclic`; no level rule. */
    supersedesAdd?: string[] | null;
    supersedesRemove?: string[] | null;
    supersededByAdd?: string[] | null;
    supersededByRemove?: string[] | null;
  } | null;
}

/**
 * What a `modify` that RE-KINDS its target needs to know about the COMMITTED
 * tree around it (bug MOTIR-8192 · AMENDMENT 25) — the target's place and its
 * leaf fields, and its live children. Resolved by the service
 * (`plansService.resolveKindChangeContexts`) in batched reads, so the gate stays
 * pure. Keyed by the target's work-item id.
 */
export interface KindChangeContext {
  /** The target's committed parent, or `null` at the root (filed or not). */
  parentId: string | null;
  /** That parent's live kind, or `null` at the root. */
  parentKind: string | null;
  /** The target sits in a FOLDER (MOTIR-5414) — a placement admitting any kind. */
  filed: boolean;
  /** The target's live `type` and `difficulty` — what a container would keep
   *  when the patch does not clear them. */
  type: string | null;
  difficulty: string | null;
  /** The target's live (non-archived) children. */
  children: ReadonlyArray<{ id: string; key: string; title: string; kind: string }>;
}

/** A live work item the plan references (a real parent, or a modify/remove target). */
export interface LiveWorkItemState {
  id: string;
  /**
   * The `<PREFIX>-<n>` key a person reads (MOTIR-3936). Carried so a refusal can
   * NAME the work item it is about instead of only the proposal id that mentions
   * it: a reviewer handed `Proposal cmte…'s patch.blockedByRemove names no work
   * item` has no way to find the card, and the id is already in the row the gate
   * reads.
   */
  key: string;
  /** The work item's title — the other half of the identity above. */
  title: string;
  kind: string;
  status: string;
  /**
   * The project the live row sits in. Read by the PARENT-tenancy check only —
   * a `blocked_by` ref deliberately does NOT consult it, because a cross-project
   * dependency edge is supported (MOTIR-3581).
   */
  projectId: string;
}

/**
 * A live FOLDER a proposal files into (MOTIR-5414) — `folder:<id>` at a parent
 * site. Only its PROJECT is judged: a folder admits any kind, sits at no depth a
 * work item counts, and cannot close a cycle through the work-item tree.
 */
export interface LiveFolderState {
  id: string;
  projectId: string;
  /** The folder's name — the identity a refusal names, as a work item's key is. */
  name: string;
}

export interface ValidatePlanProposalsInput {
  /** Every PlanItem bundled in the plan being approved. */
  items: readonly ProposalNode[];
  /**
   * The live rows for every REAL work-item id the plan references, by id.
   * Resolved by the service (workspace-scoped) so this stays pure. An id absent
   * from the map is a ref that resolves to nothing in this workspace.
   */
  liveById: ReadonlyMap<string, LiveWorkItemState>;
  /**
   * The project's TERMINAL status keys — every `category = 'done'` status
   * (`workflowsService.getTerminalStatusKeys`), never a hardcoded `'done'`, so
   * `cancelled` is terminal too.
   */
  terminalStatusKeys: ReadonlySet<string>;
  /**
   * The project the PLAN belongs to — the project every card it materializes is
   * created in. Read by the parent-tenancy check (step 3b), which is the only
   * question in this gate whose answer depends on WHERE a live row sits.
   */
  planProjectId: string;
  /**
   * The ANCESTOR CHAIN of every work item a `modify` proposes as a new parent
   * (MOTIR-3859) — `parentId → … → root`, nearest first — resolved by the
   * service in one batched read (`workItemRepository.findAncestorIdsForItems`).
   *
   * It is what makes the CYCLE and DEPTH questions answerable in a pure
   * function: a re-parent's legality is a property of the tree above the new
   * parent, which is the only thing in this gate that neither the proposal set
   * nor a single row can supply. An id with no entry reads as a ROOT (an empty
   * chain), which is what an item with no parent actually has — so a caller that
   * resolves nothing degrades to "the parent is a root", the permissive answer,
   * and the DB triggers stay the backstop.
   *
   * REQUIRED rather than optional, deliberately: an optional map defaulting to
   * empty would let a caller that forgot it pass a cycle silently.
   */
  ancestorIdsById: ReadonlyMap<string, readonly string[]>;
  /**
   * The COMMITTED `is_blocked_by` edges the plan's own edges join onto
   * (MOTIR-3936) — `{ blockedId, blockerId }`, the transitive closure downstream
   * of every endpoint the plan writes, resolved by
   * `plansService.runPersistGate`.
   *
   * It is what makes the cycle question answerable at all. A `modify`'s
   * `patch.blockedByAdd` names work items that ALREADY EXIST, so two patches in
   * one plan can close a cycle that the `planItem:` ref graph cannot see, and one
   * patch can close a cycle through a chain of edges nobody proposed. Both are
   * refused by `enforce_work_item_link_no_cycle` halfway through `materialize`,
   * as a raw SQLSTATE — which is the failure this input exists to move forward to
   * the close, where the author can still fix it.
   *
   * REQUIRED rather than optional, for the reason `ancestorIdsById` is: an
   * optional set defaulting to empty would let a caller that forgot it pass a
   * cycle silently.
   */
  existingBlockedByEdges: readonly BlockedByEdge[];
  /**
   * The COMMITTED `supersedes` links the plan's own supersedes edges join onto
   * (MOTIR-6630) — `{ fromId, toId }` (from = the NEWER card), the transitive
   * closure downstream of every endpoint the plan writes, resolved by
   * `plansService.runPersistGate`.
   *
   * The database does NOT refuse a supersedes cycle (the no-cycle trigger judges
   * `is_blocked_by` only), so this walk is the ONLY guard on the plan path.
   * REQUIRED for the reason `existingBlockedByEdges` is: an optional list
   * defaulting to empty would let a caller that forgot it pass a cycle silently.
   */
  existingSupersedesEdges: readonly SupersedesEdge[];
  /**
   * The workflow-status CATEGORY of every `modify` target whose patch SETS an
   * obsolescence mark (MOTIR-6663), by work-item id — read against the target's
   * OWN project's workflow by `plansService.runPersistGate`, so a custom
   * done-category status (`shipped`) counts as finished and a status key is
   * never judged.
   *
   * REQUIRED, and its absence fails in the SAFE direction: a mark target missing
   * from the map reads as not finished, so a caller that forgot to resolve it
   * refuses a mark rather than writing one onto an unfinished card.
   */
  markTargetStatusCategoryById: ReadonlyMap<string, StatusCategoryDto>;
  /**
   * The live FOLDERS every `folder:<id>` ref names, by id (MOTIR-5414) — resolved
   * by the service in one batched, workspace-scoped read with the project
   * narrowing lifted, so a folder in ANOTHER project is visible to be refused
   * for the right reason.
   *
   * OPTIONAL, unlike the two inputs above, because its absence fails in the SAFE
   * direction: a folder ref missing from the map is refused as naming no folder,
   * so a caller that forgot to resolve folders refuses a plan rather than passing
   * one. The two inputs above would, missing, pass a cycle silently.
   */
  folderById?: ReadonlyMap<string, LiveFolderState>;
  /**
   * The COMMITTED ancestor chain (nearest first) of every live work item the
   * plan's edges and placements name (MOTIR-6411) — what places a live end for
   * the same-level check. OPTIONAL and permissive when absent: a live end with no
   * chain is skipped, never guessed.
   */
  edgeAncestorsById?: ReadonlyMap<string, readonly string[]>;
  /**
   * The committed tree around every target a `modify` RE-KINDS (bug MOTIR-8192 ·
   * AMENDMENT 25), by target id — see {@link KindChangeContext}.
   *
   * OPTIONAL, and permissive when absent: a re-kind whose target has no entry is
   * judged for its membership and through the placements the plan itself
   * writes, never against committed children it was not shown. Every service
   * caller resolves it (`runPersistGate`, and the append's
   * `assertKindChangesLegalAtAppend`). Under the write, the `work_item` kind
   * trigger backstops the PARENT half only — it judges a row against its own
   * parent, never against its children — which is why the children half is
   * this gate's to ask.
   */
  kindChangeContextById?: ReadonlyMap<string, KindChangeContext>;
}

/** One committed `is_blocked_by` edge: `blockedId` is blocked BY `blockerId`. */
export interface BlockedByEdge {
  blockedId: string;
  blockerId: string;
}

/** One committed `supersedes` link: `fromId` (the NEWER card) supersedes `toId`. */
export interface SupersedesEdge {
  fromId: string;
  toId: string;
}

/** The proposed kind of an `add`, defaulted the way `materialize` defaults it. */
function proposedKindOf(item: ProposalNode): string {
  const kind = item.proposedFields?.kind;
  return typeof kind === 'string' && kind.length > 0 ? kind : DEFAULT_PROPOSED_KIND;
}

/** The proposed kind as a validated `IssueType`, or a typed rejection. */
function issueKindOf(item: ProposalNode): IssueType {
  const kind = proposedKindOf(item);
  if (!isIssueType(kind)) {
    throw new PlanGrammarError(
      'unknown_kind',
      item.id,
      `Proposal ${item.id} proposes kind "${kind}", which is not a valid issue type.`,
    );
  }
  return kind;
}

/**
 * The proposed `type`, checked against the fourteen `WorkItemType` members, or a
 * typed rejection (MOTIR-3654).
 *
 * The twin of `issueKindOf` above, owed by this module's own header argument:
 * the approved set can be edited between generation and approve
 * (`updateProposal`), so the proposal is NOT trusted here and core re-checks.
 * `kind` had that arm from the start; `type` did not, and the asymmetry is the
 * whole defect — an out-of-enum `type` passed `validate_plan` cleanly and then
 * raised a `PrismaClientValidationError` from inside `materialize`.
 *
 * A null / absent `type` is legal (a leaf may be untyped, and a container may
 * not carry one at all), so only a PRESENT non-member is a violation. The
 * message lists the legal members, because the caller correcting this is
 * usually an agent that can act on a list and cannot act on a refusal.
 */
function assertProposedTypeKnown(item: ProposalNode): void {
  const type = item.proposedFields?.type;
  if (type == null || type === '') return;
  if (isWorkItemType(type)) return;
  throw new PlanGrammarError(
    'unknown_type',
    item.id,
    `Proposal ${item.id} proposes type "${String(type)}", which is not a valid work type. Legal members: ${WORK_ITEM_TYPES.join(', ')}.`,
  );
}

/**
 * The proposed `subject` — the fourth planning-rule selector coordinate — checked
 * for SHAPE only (Story MOTIR-5062 · MOTIR-5065; the KIND half retired by
 * MOTIR-5607).
 *
 * The twin of {@link assertProposedTypeKnown} directly above, and owed by the same
 * argument this module's header makes: the approved set can be edited between
 * generation and approve (`updateProposal`), so nothing the planner self-checked
 * is trusted here.
 *
 * ⚠️ ONE CHECK NOW, AND TWO THINGS DELIBERATELY ABSENT.
 *
 *   · SHAPE — a bounded lowercase slug (`lib/plans/subjectShape.ts`). A value that
 *     could not name a `subject-<name>.md` rule pack could not be a member however
 *     the corpus grows, so refusing it costs nothing and keeps the column clean.
 *   · KIND — **NO LONGER CHECKED (MOTIR-5607).** A subject was once refused on a
 *     container, mirroring `type`; that refusal is retired by decision. A subject
 *     says what a work item is ABOUT, and a container is about something exactly as
 *     much as a leaf is, so `epic` and `story` carry one too.
 *     ⚠️ `TYPEABLE_KINDS` still gates `type` / `executor` and is deliberately NOT
 *     consulted here any more — the two axes stopped sharing a predicate, which is
 *     the substance of that decision rather than a side effect of it. Re-coupling
 *     them would grant an epic a `type`, which nothing decided.
 *   · MEMBERSHIP — **NOT CHECKED, ON PURPOSE.** The vocabulary IS the pack file
 *     set in `motir-meta`, mirrored by motir-ai's `PACKS_BY_SUBJECT`, so this
 *     repository holding the list would put a schema change, a migration and a
 *     platform deploy in front of every new rule pack. A well-formed unrecognised
 *     member persists here and is refused by the RESOLVER, one hop later, which is
 *     the system that owns the vocabulary. That cost is stated rather than hidden,
 *     and `tests/plans/proposedSubject.test.ts` pins the acceptance deliberately so
 *     a later reader does not "fix" it into a vocabulary check.
 */
function assertProposedSubjectValid(item: ProposalNode): void {
  const subject = item.proposedFields?.subject;
  if (subject == null || subject === '') return;

  if (!isWellFormedSubject(subject)) {
    throw new PlanGrammarError(
      'malformed_subject',
      item.id,
      `Proposal ${item.id} proposes subject "${String(subject)}", which is not a well-formed subject. ${describeSubjectShape()}`,
    );
  }
}

/**
 * A `modify`'s replacement STEP LIST on a container, refused at APPROVE
 * (MOTIR-8668 · AMENDMENT 27) — the twin of {@link assertDifficultyOnLeaf} for
 * the path the proposal doors cannot see: a target re-kinded to a container
 * after the append. `isContainerKind` reads `TYPEABLE_KINDS`, the leaf set the
 * doors' `validateProposedTodos` reads, so the two cannot disagree. An empty list or a
 * `null` (a clear) is never refused, and a target that resolves to nothing is
 * left to `materialize`.
 */
function assertTodosOnLeaf(
  item: ProposalNode,
  liveById: ValidatePlanProposalsInput['liveById'],
): void {
  if (item.op !== 'modify' || !item.workItemId) return;
  const todos = item.patch?.todos;
  if (!Array.isArray(todos) || todos.length === 0) return;
  const target = liveById.get(item.workItemId);
  if (!target || !isContainerKind(target.kind)) return;
  throw new PlanGrammarError(
    'todos_on_container',
    item.id,
    `${describeSubject(item, liveById)} replaces the steps of a \`${target.kind}\`, which is a container: its steps are its children. The plan's author must drop \`patch.todos\` or send \`[]\`.`,
  );
}

/**
 * A DIFFICULTY on a container, refused at APPROVE (Story MOTIR-6095 · MOTIR-6133;
 * AMENDMENT 19). The proposal doors refuse it at append, deepen and correct
 * through `lib/plans/validateProposedDifficulty.ts`; this is the one path they
 * cannot see — a `modify` whose COMMITTED target was re-kinded to an `epic` /
 * `story` after the append — and, by the module header's own argument, the
 * backstop for any `add` edited between generation and approve. The predicate
 * is the shared module's, so the approve and the doors cannot disagree.
 *
 * A `modify` whose target resolves to nothing is left to `materialize`, as
 * step 4 of the gate leaves it. `null` (a clear) is never refused.
 */
function assertDifficultyOnLeaf(
  item: ProposalNode,
  liveById: ValidatePlanProposalsInput['liveById'],
): void {
  if (item.op === 'add') {
    const difficulty = item.proposedFields?.difficulty;
    const kind = proposedKindOf(item);
    if (!isDifficultyRefusedOnKind(difficulty, kind)) return;
    throw new PlanGrammarError(
      'difficulty_on_container',
      item.id,
      `${describeSubject(item, liveById)} proposes a \`${kind}\` with difficulty "${String(difficulty)}". A container cannot carry a difficulty — set it on its leaves, or clear it.`,
    );
  }
  if (item.op !== 'modify' || !item.workItemId) return;
  const difficulty = item.patch?.difficulty;
  const target = liveById.get(item.workItemId);
  if (!target || !isDifficultyRefusedOnKind(difficulty, target.kind)) return;
  throw new PlanGrammarError(
    'difficulty_on_container',
    item.id,
    item.patch?.kind !== undefined
      ? `${describeSubject(item, liveById)} re-kinds its target to a \`${target.kind}\` and sets difficulty "${String(difficulty)}" on it. A container cannot carry a difficulty — send \`difficulty: null\` with the new kind.`
      : `${describeSubject(item, liveById)} sets difficulty "${String(difficulty)}" on a \`${target.kind}\`, which is a container and cannot carry one. The target is a container now; the plan's author must drop \`patch.difficulty\` or set it to null.`,
  );
}

/**
 * Every REAL (non-temp) work-item id a plan references — the parents its `add`s
 * hang from, the blockers its edges name, and the targets its `modify`/`remove`
 * ops touch. The service resolves exactly this set into `liveById` (one batched
 * read), so the gate never issues a query itself.
 */
export function collectReferencedWorkItemIds(items: readonly ProposalNode[]): string[] {
  const ids = new Set<string>();
  const addReal = (ref: string | null | undefined): void => {
    if (ref && isWorkItemRef(ref)) ids.add(ref);
  };
  for (const item of items) {
    addReal(item.parentRef);
    for (const ref of item.blockedByRefs) addReal(ref);
    if (item.op === 'modify' || item.op === 'remove') addReal(item.workItemId);
    // The RE-PARENT target (MOTIR-3859) — the new parent has to be in `liveById`
    // for every one of its guards, and it is the one ref site that is a single
    // nullable value rather than a list.
    if (item.op === 'modify' && item.patch?.parentRef) addReal(item.patch.parentRef);
    for (const ref of item.patch?.blockedByAdd ?? []) addReal(ref);
    for (const ref of item.patch?.blockedByRemove ?? []) addReal(ref);
    // The `supersedes` carriers (MOTIR-6630) — resolved like the blocker lists.
    for (const ref of item.supersedesRefs ?? []) addReal(ref);
    if (item.op === 'modify') {
      for (const key of SUPERSEDES_PATCH_SITES) {
        for (const ref of item.patch?.[key] ?? []) addReal(ref);
      }
    }
  }
  return [...ids];
}

/**
 * Every FOLDER id a plan names at a parent site (MOTIR-5414) — an `add`'s
 * `parentRef` and a `modify`'s `patch.parentRef`. The service resolves exactly
 * this set into `folderById`. A folder ref at a BLOCKER site is not collected:
 * the self-consistency pass refuses it before anything resolves.
 */
export function collectReferencedFolderIds(items: readonly ProposalNode[]): string[] {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.parentRef && isFolderRef(item.parentRef)) ids.add(folderRefId(item.parentRef));
    const patchParent = item.op === 'modify' ? item.patch?.parentRef : null;
    if (patchParent && isFolderRef(patchParent)) ids.add(folderRefId(patchParent));
  }
  return [...ids];
}

/** Where a ref was written, for the rejection message. */
type RefSite =
  | 'parentRef'
  | 'blockedByRefs'
  | 'patch.parentRef'
  | 'patch.blockedByAdd'
  | 'patch.blockedByRemove'
  | 'supersedesRefs'
  | 'patch.supersedesAdd'
  | 'patch.supersedesRemove'
  | 'patch.supersededByAdd'
  | 'patch.supersededByRemove';

/** True for the five `supersedes` carriers (MOTIR-6630). */
function isSupersedesSite(where: RefSite): boolean {
  return where.startsWith('supersedes') || where.startsWith('patch.supersede');
}

/**
 * Every (site, refs) pair one proposal carries, so the two passes below walk the
 * SAME set of refs and cannot drift apart. A `modify`'s patch sides are read
 * only for a `modify`, exactly as before.
 */
function refSitesOf(item: ProposalNode): Array<[RefSite, readonly string[]]> {
  const sites: Array<[RefSite, readonly string[]]> = [];
  if (item.parentRef !== null) sites.push(['parentRef', [item.parentRef]]);
  sites.push(['blockedByRefs', item.blockedByRefs]);
  if (item.op === 'modify') {
    // An explicit `null` is a move to the ROOT and names nothing, so it carries
    // no ref to resolve — only a non-null value is a site (MOTIR-3859).
    if (item.patch?.parentRef) sites.push(['patch.parentRef', [item.patch.parentRef]]);
    sites.push(['patch.blockedByAdd', item.patch?.blockedByAdd ?? []]);
    sites.push(['patch.blockedByRemove', item.patch?.blockedByRemove ?? []]);
    for (const key of SUPERSEDES_PATCH_SITES) {
      sites.push([`patch.${key}`, item.patch?.[key] ?? []]);
    }
  }
  // An `add`'s supersedes set (MOTIR-6630). Read off an `add` only — the column
  // means nothing on another op, and the append refuses it there.
  if (item.op === 'add') sites.push(['supersedesRefs', item.supersedesRefs ?? []]);
  return sites;
}

/**
 * The PURE half of the ref check (MOTIR-3573): a ref list may not repeat a ref,
 * and a proposal may not name ITSELF. Both are facts about the proposal set
 * alone — no workspace read can change either answer — which is why they run at
 * the APPEND rather than waiting for approve.
 */
function assertRefsSelfConsistent(
  item: ProposalNode,
  refs: readonly string[],
  where: RefSite,
): void {
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref)) {
      throw new PlanRefGraphError(
        'duplicate',
        item.id,
        `Proposal ${item.id} lists "${ref}" twice in ${where}; a ${isSupersedesSite(where) ? 'supersedes' : 'blocked-by'} edge can only be created once.`,
      );
    }
    seen.add(ref);

    // A folder is a PLACEMENT, never an edge (MOTIR-5414): it blocks nothing and
    // nothing blocks it, so at a blocker site it can only be a mistake — most
    // likely a placement written into the wrong field. A fact about the proposal
    // alone, so it is refused here, at the append.
    if (isFolderRef(ref) && where !== 'parentRef' && where !== 'patch.parentRef') {
      throw new PlanRefGraphError(
        'dangling',
        item.id,
        `Proposal ${item.id}'s ${where} "${ref}" names a folder. A folder is a place a card is FILED, ` +
          `not a dependency — it blocks nothing. Put \`${FOLDER_REF_PREFIX}<id>\` in \`parentRef\` to file the card there.`,
      );
    }

    if (isTempRef(ref) && tempRefId(ref) === item.id) {
      throw new PlanRefGraphError(
        'cycle',
        item.id,
        `Proposal ${item.id} references ITSELF in ${where}.`,
      );
    }

    // A `modify` naming its OWN target on a supersedes carrier (MOTIR-6630) — a
    // card cannot replace itself. A fact about the proposal alone, like the
    // temp-ref case above; the blocker carriers leave the same shape to the
    // link trigger's WI_LINK_SELF, which the database does raise for them.
    if (isSupersedesSite(where) && item.op === 'modify' && ref === item.workItemId) {
      throw new PlanRefGraphError(
        'cycle',
        item.id,
        `Proposal ${item.id}'s ${where} names its own target "${ref}"; a card cannot supersede itself.`,
      );
    }
  }
}

/**
 * The half that needs LIVE STATE: every ref resolves — to a same-plan `add`
 * (temp-ref) or to a work item that exists in this workspace (real id). The
 * real-id arm is what costs a batched read, which is why this pass cannot run at
 * the append and runs at the CLOSE instead (`plansService.markPlanned`).
 */
function assertRefsResolvable(
  item: ProposalNode,
  refs: readonly string[],
  liveById: ValidatePlanProposalsInput['liveById'],
  addIds: ReadonlySet<string>,
  where: RefSite,
  folderById: ReadonlyMap<string, LiveFolderState>,
): void {
  for (const ref of refs) {
    if (isFolderRef(ref)) {
      assertFolderRefResolvable(item, ref, where, liveById, folderById);
    } else if (isTempRef(ref)) {
      const targetId = tempRefId(ref);
      if (!addIds.has(targetId)) {
        throw new PlanRefGraphError(
          'dangling',
          item.id,
          `${describeSubject(item, liveById)}'s ${where} "${ref}" names no \`add\` in this plan.`,
        );
      }
    } else if (!liveById.has(ref)) {
      throw new PlanRefGraphError(
        'dangling',
        item.id,
        `${describeSubject(item, liveById)}'s ${where} "${ref}" names no work item in this workspace. ` +
          `A ref names a work item's ID (a \`cm…\` cuid) or a \`${TEMP_REF_PREFIX}<id>\` proposal in this plan — never a \`<PREFIX>-<n>\` key.`,
      );
    }
  }
}

/**
 * A `folder:<id>` ref names a folder that exists in this workspace (MOTIR-5414).
 * Shared by the gate's resolution step, the re-parent gate and the append, so
 * all three name an unknown folder in the same words.
 */
function assertFolderRefResolvable(
  item: ProposalNode,
  ref: string,
  where: RefSite,
  liveById: ValidatePlanProposalsInput['liveById'],
  folderById: ReadonlyMap<string, LiveFolderState>,
): LiveFolderState {
  const folder = folderById.get(folderRefId(ref));
  if (!folder) {
    throw new PlanRefGraphError(
      'dangling',
      item.id,
      `${describeSubject(item, liveById)}'s ${where} "${ref}" names no folder in this workspace. ` +
        `A \`${FOLDER_REF_PREFIX}<id>\` ref names a folder's id — the folder may have been deleted, or the id mistyped.`,
    );
  }
  return folder;
}

/**
 * A resolved folder ref files the proposal into a folder of the PLAN's own
 * project (MOTIR-5414). A work item's folder must live in its own project — the
 * `trg_work_item_cotenancy_folder` trigger and `CrossProjectFolderError` enforce
 * it for every direct write — so a plan cannot be the door that admits another
 * project's folder.
 */
function assertFolderInPlanProject(
  item: ProposalNode,
  ref: string,
  where: RefSite,
  folder: LiveFolderState,
  planProjectId: string,
  liveById: ValidatePlanProposalsInput['liveById'],
): void {
  if (folder.projectId !== planProjectId) {
    throw new PlanGrammarError(
      'illegal_parent',
      item.id,
      `${describeSubject(item, liveById)}'s ${where} "${ref}" (folder "${folder.name}") names a folder in a DIFFERENT project of this workspace. ` +
        `A work item can only be filed into a folder of its own project.`,
    );
  }
}

/**
 * Assert every `folder:` placement in `items` resolves to a folder of the plan's
 * project (MOTIR-5414) — resolution, then tenancy. Exported for the APPEND, which
 * judges folder refs where they are written: an unknown folder cannot become
 * known by a later call, so deferring the refusal to the close buys nothing.
 * `validatePlanProposals` asks the same two questions through its own ordered
 * steps.
 */
export function assertFolderPlacementsLegal(
  items: readonly ProposalNode[],
  folderById: ReadonlyMap<string, LiveFolderState>,
  planProjectId: string,
): void {
  const noLive: ValidatePlanProposalsInput['liveById'] = new Map();
  for (const item of items) {
    const sites: Array<[RefSite, string | null | undefined]> = [['parentRef', item.parentRef]];
    if (item.op === 'modify') sites.push(['patch.parentRef', item.patch?.parentRef]);
    for (const [where, ref] of sites) {
      if (!ref || !isFolderRef(ref)) continue;
      const folder = assertFolderRefResolvable(item, ref, where, noLive, folderById);
      assertFolderInPlanProject(item, ref, where, folder, planProjectId, noLive);
    }
  }
}

/**
 * THE PURE GATE (MOTIR-3573) — everything about a proposal set that is knowable
 * WITHOUT a workspace read: no ref is listed twice, no proposal references
 * itself, and the intra-plan `parentRef` graph admits a parent-before-child
 * order. Takes no `liveById` BY DESIGN: a real work-item id is not this
 * function's business, and a plan may legitimately reference an item created
 * between the append and the close.
 *
 * `plansService.addProposals` calls it under the plan lock before the first
 * insert, and `validatePlanProposals` calls it as its own first step — one
 * implementation, so the append and the approve can never disagree about what a
 * self-consistent plan is.
 */
export function assertProposalSetSelfConsistent(items: readonly ProposalNode[]): void {
  for (const item of items) {
    for (const [where, refs] of refSitesOf(item)) {
      assertRefsSelfConsistent(item, refs, where);
    }
  }
  assertParentRefsAcyclic(items.filter((i) => i.op === 'add'));
}

/**
 * Assert the intra-plan `parentRef` graph is ACYCLIC — i.e. a parent-before-child
 * creation order exists (`materialize`'s topological walk). A cycle is caught
 * HERE, before any write, rather than by that walk mid-transaction.
 *
 * PURE, and it runs BEFORE resolution (MOTIR-3573), so an unresolvable temp-ref
 * is simply not walked — `byId.get` misses and the guarded `if (parent)` skips
 * it. The dangling ref is then reported by `assertRefsResolvable`, which is the
 * more specific reason for it.
 */
function assertParentRefsAcyclic(adds: readonly ProposalNode[]): void {
  const byId = new Map(adds.map((a) => [a.id, a]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (item: ProposalNode): void => {
    if (visited.has(item.id)) return;
    if (visiting.has(item.id)) {
      throw new PlanRefGraphError(
        'cycle',
        item.id,
        `The plan's ${TEMP_REF_PREFIX} parent refs form a cycle through proposal ${item.id}; no parent-before-child order exists.`,
      );
    }
    visiting.add(item.id);
    if (item.parentRef && isTempRef(item.parentRef)) {
      // A ref that resolves to nothing is left to `assertRefsResolvable`.
      const parent = byId.get(tempRefId(item.parentRef));
      if (parent) visit(parent);
    }
    visiting.delete(item.id);
    visited.add(item.id);
  };

  for (const add of adds) visit(add);
}

/**
 * The EFFECTIVE parent kind an `add` would be created under: `null` for a
 * top-level add, the referenced same-plan `add`'s proposed kind for a temp-ref,
 * the live row's kind for a real id.
 */
function effectiveParentKind(
  item: ProposalNode,
  addsById: ReadonlyMap<string, ProposalNode>,
  liveById: ValidatePlanProposalsInput['liveById'],
): IssueType | null {
  const ref = item.parentRef;
  // A FOLDER is not a work-item parent (MOTIR-5414): a filed card is a root, so
  // it has no parent KIND. The caller reads the filing itself off the ref.
  if (!ref || isFolderRef(ref)) return null;

  if (isTempRef(ref)) {
    // Resolution is guaranteed by `assertRefsResolvable`.
    const parent = addsById.get(tempRefId(ref))!;
    return issueKindOf(parent);
  }

  // Resolution is guaranteed by `assertRefsResolvable`.
  const live = liveById.get(ref)!;
  if (!isIssueType(live.kind)) {
    // Unreachable through the schema (`work_item.kind` is an enum of exactly the
    // five issue types) — guarded so a future kind can never fall through the
    // grammar check silently.
    throw new PlanGrammarError(
      'unknown_kind',
      item.id,
      `Proposal ${item.id}'s parent work item ${live.id} has kind "${live.kind}", which is not a valid issue type.`,
    );
  }
  return live.kind;
}

// ── The RE-PARENT gate (MOTIR-3859) ──────────────────────────────────────────
//
// A `modify` may now move its target (`patch.parentRef`), which is the ONE patch
// key whose legality is a question about the TREE rather than about the row. The
// five checks below are the same five the interactive path is subject to — three
// of them asserted by `workItemsService.moveWorkItem` and two by the `work_item`
// triggers — collected into one pure function so the APPEND and the APPROVE ask
// them identically. That is the whole reason it is a function and not two
// inlined copies: a re-parent refused at the append and admitted at approve, or
// the reverse, is worse than either answer.

/**
 * The tree's depth cap, mirrored from `enforce_work_item_depth_limit`
 * (`prisma/sql/work_item_triggers.sql`): a root is depth 1, and a row whose
 * resulting depth exceeds this raises `WI_DEPTH_LIMIT_EXCEEDED`.
 *
 * ⚠️ A MIRROR, and therefore a thing to keep in lockstep — the trigger is the
 * backstop and stays authoritative. It is duplicated here for the reason the
 * kind-parent matrix is NOT (that one is a shared module this file imports): the
 * cap lives in SQL, there is no TypeScript module owning it, and inventing one
 * to hold a single integer would put a third name on a two-name fact.
 */
const MAX_WORK_ITEM_DEPTH = 4;

/**
 * Assert one `modify`'s proposed re-parent is legal, or throw the typed
 * rejection that says why (MOTIR-3859). A no-op for every proposal that does not
 * carry `patch.parentRef` — which is all of them, on the overwhelming majority
 * of plans.
 *
 * PURE. Everything it needs is resolved by the caller: the live rows in
 * `liveById` (the target and the new parent), and `ancestorIdsById` — the new
 * parent's ancestor chain, which is what makes the CYCLE and DEPTH questions
 * answerable without a query. `workItemRepository.findAncestorIdsForItems` is
 * the one batched read that supplies it.
 *
 * The order is the same discipline the gate above follows — a malformed
 * re-parent fails with the MOST specific reason:
 *
 *   1. a temp-ref parent — a proposed `add` on this plan — judged against the
 *      PROJECTION instead (AMENDMENT 18 §1, MOTIR-6050): see
 *      {@link assertReparentUnderProposalLegal}
 *   2. tenancy — the parent is in this project
 *   3. self / descendant — the move would create a cycle
 *   4. depth — the resulting depth is within the cap
 *   5. the kind-parent matrix, and the parent is not terminal
 *
 * A target that resolves to NOTHING is left alone: `materialize` raises
 * `PlanItemTargetMissingError` for it and rolls the approve back, which is the
 * more specific reason, and step 4 of the gate already declines to invent one.
 */
export function assertReparentLegal(
  item: ProposalNode,
  liveById: ValidatePlanProposalsInput['liveById'],
  ancestorIdsById: ValidatePlanProposalsInput['ancestorIdsById'],
  terminalStatusKeys: ReadonlySet<string>,
  planProjectId: string,
  folderById: ReadonlyMap<string, LiveFolderState> = new Map(),
  addsById: ReadonlyMap<string, ProposalNode> = new Map(),
): void {
  if (item.op !== 'modify') return;
  const ref = item.patch?.parentRef;
  if (ref === undefined) return;

  const target = item.workItemId ? liveById.get(item.workItemId) : undefined;
  // Left to `materialize`, which raises the specific reason (see the doc above).
  if (!target) return;
  if (!isIssueType(target.kind)) {
    // Unreachable through the schema, guarded for the same reason
    // `effectiveParentKind`'s twin is.
    throw new PlanGrammarError(
      'unknown_kind',
      item.id,
      `Proposal ${item.id}'s target ${target.id} has kind "${target.kind}", which is not a valid issue type.`,
    );
  }

  // An explicit `null` moves the target to the PROJECT ROOT. The only thing that
  // can be wrong with it is the kind — a subtask has no legal top-level
  // placement — and `assertValidParent` is the arm that says so.
  if (ref === null) {
    assertParentKindLegal(item, null, target.kind, liveById);
    return;
  }

  // 0. FILING into a folder (MOTIR-5414). None of the tree's five questions
  //    applies: a filed card is a ROOT (depth 1), no cycle can run through a
  //    folder, and a folder admits ANY kind, `subtask` included — the placement
  //    rule `assertValidPlacement` states, asked here rather than restated. What
  //    remains is that the folder exists and is in this project.
  if (isFolderRef(ref)) {
    const folder = assertFolderRefResolvable(item, ref, 'patch.parentRef', liveById, folderById);
    assertFolderInPlanProject(item, ref, 'patch.parentRef', folder, planProjectId, liveById);
    assertValidPlacement({ parentKind: null, filed: true }, target.kind);
    return;
  }

  // 1. A PROPOSED parent (AMENDMENT 18 §1, MOTIR-6050). AMENDMENT 11 D2 refused
  //    this outright because every guard was a question about a live row; the
  //    plan's own `add`s now answer them, read off the projected chain.
  if (isTempRef(ref)) {
    assertReparentUnderProposalLegal(
      item,
      target,
      ref,
      liveById,
      ancestorIdsById,
      terminalStatusKeys,
      addsById,
    );
    return;
  }

  // Resolution is guaranteed by `assertRefsResolvable`.
  const parent = liveById.get(ref)!;

  // 2. TENANCY — same rule, same reason and deliberately the same message shape
  //    as an `add`'s parentRef (step 3b): parentage is same-project by invariant
  //    on three enforcing layers, while a `blocked_by` edge is workspace-scoped
  //    by design.
  if (parent.projectId !== planProjectId) {
    throw new PlanGrammarError(
      'illegal_parent',
      item.id,
      `${describeSubject(item, liveById)}'s patch.parentRef "${ref}"${refSuffix(ref, liveById)} names a work item in a DIFFERENT project of this workspace. A work item's parent must live in the same project (a cross-project parent is refused by workItemsService and by the work_item parent-tenancy trigger).`,
    );
  }

  // 3. CYCLE — the target itself, or anything below it. `enforce_work_item_no_cycle`
  //    walks UP from the new parent and rejects when the chain reaches the row
  //    being moved; this is that walk, taken from the chain the caller resolved.
  const chain = ancestorIdsById.get(parent.id) ?? [];
  if (parent.id === target.id) {
    throw new PlanRefGraphError(
      'cycle',
      item.id,
      `${describeSubject(item, liveById)} would re-parent work item ${describeNode(target.id, [], liveById)} under ITSELF.`,
    );
  }
  if (chain.includes(target.id)) {
    throw new PlanRefGraphError(
      'cycle',
      item.id,
      `${describeSubject(item, liveById)} would re-parent work item ${describeNode(target.id, [], liveById)} under ${describeNode(parent.id, [], liveById)}, which is one of its own DESCENDANTS — the move would create a cycle.`,
    );
  }

  // 4. DEPTH — the new parent's own chain plus the parent plus the moved row.
  //    `chain` holds the parent's ANCESTORS, so the parent sits at
  //    `chain.length + 1` and the target would land at `chain.length + 2`, which
  //    is exactly `ancestor_depth + 1` in the trigger's arithmetic.
  const resultingDepth = chain.length + 2;
  if (resultingDepth > MAX_WORK_ITEM_DEPTH) {
    throw new PlanGrammarError(
      'parent_depth_limit',
      item.id,
      `${describeSubject(item, liveById)} would place work item ${describeNode(target.id, [], liveById)} at depth ${resultingDepth}, past the limit of ${MAX_WORK_ITEM_DEPTH}.`,
    );
  }

  // 5a. The kind-parent matrix — asked of `lib/issues/parentRules.ts`, the same
  //     single source of truth every human create / move is gated on.
  if (!isIssueType(parent.kind)) {
    throw new PlanGrammarError(
      'unknown_kind',
      item.id,
      `Proposal ${item.id}'s patch.parentRef work item ${parent.id} has kind "${parent.kind}", which is not a valid issue type.`,
    );
  }
  assertParentKindLegal(item, parent.kind, target.kind, liveById);

  // 5b. …and the parent is not FINISHED. See `PlanGrammarViolation`'s
  //     `parent_terminal` member for why this one is not cosmetic: the derived
  //     re-open walks the whole ancestor chain, and an approve has nobody
  //     watching it.
  if (terminalStatusKeys.has(parent.status)) {
    throw new PlanGrammarError(
      'parent_terminal',
      item.id,
      `${describeSubject(item, liveById)} would re-parent work item ${describeNode(target.id, [], liveById)} under ${describeNode(parent.id, [], liveById)}, which is in the terminal status "${parent.status}". Completing work is derived from a container's CURRENT child set, so giving a finished parent a new open child re-opens it and every ancestor above it.`,
    );
  }
}

/**
 * Walk a proposed parent's chain UP through the plan's own `add`s (AMENDMENT 18
 * §1): the `add`s above it, in order, and the first COMMITTED row the chain
 * reaches — the ANCHOR the proposed subtree is created under. `anchorId` is
 * `null` when the chain ends at the project root or in a folder, where a filed
 * card is a root.
 *
 * Exported because the service needs the anchors BEFORE the gate runs: they are
 * the rows whose live ancestor chains `findAncestorIdsForItems` has to read.
 * Refs that do not resolve, and parent-ref cycles among the `add`s, are other
 * checks' refusals (`assertRefsResolvable`, `assertParentRefsAcyclic`), so the
 * walk simply stops at them rather than inventing a second message.
 */
export function projectedParentChain(
  ref: string,
  addsById: ReadonlyMap<string, ProposalNode>,
): { proposedAncestors: ProposalNode[]; anchorId: string | null } {
  const proposedAncestors: ProposalNode[] = [];
  const seen = new Set<string>();
  let node = addsById.get(tempRefId(ref));
  let next = node?.parentRef ?? null;
  while (node && next && isTempRef(next) && !seen.has(node.id)) {
    seen.add(node.id);
    node = addsById.get(tempRefId(next));
    if (!node) return { proposedAncestors, anchorId: null };
    proposedAncestors.push(node);
    next = node.parentRef;
  }
  const anchorId = next && !isTempRef(next) && !isFolderRef(next) ? next : null;
  return { proposedAncestors, anchorId };
}

/** Every COMMITTED anchor a `modify` in `items` reaches through a proposed parent. */
export function proposedParentAnchorIds(items: readonly ProposalNode[]): string[] {
  const addsById = new Map(items.filter((n) => n.op === 'add').map((n) => [n.id, n]));
  const anchors = new Set<string>();
  for (const item of items) {
    const ref = item.op === 'modify' ? item.patch?.parentRef : undefined;
    if (typeof ref !== 'string' || !isTempRef(ref)) continue;
    const { anchorId } = projectedParentChain(ref, addsById);
    if (anchorId) anchors.add(anchorId);
  }
  return [...anchors];
}

/**
 * A `modify` moving its committed target under a PROPOSED `add` (AMENDMENT 18
 * §1). The same five questions {@link assertReparentLegal} asks of a live
 * parent, answered against the projection:
 *
 *   - TENANCY needs no check: an `add` is created in the plan's own project, and
 *     a ref naming another plan's proposal, or a `modify` / `remove`, does not
 *     resolve (`assertRefsResolvable` / the append's temp-ref check).
 *   - CYCLE: the moving card must not sit in the projected chain — the anchor or
 *     any of its live ancestors. The case a proposal CAN create: an `add` under
 *     the moving card's own child.
 *   - DEPTH: the proposed `add`s above the parent, plus the anchor's committed
 *     chain, plus the parent and the moved row.
 *   - KIND: the proposed `add`'s kind, defaulted the way `materialize` defaults it.
 *   - TERMINAL: the proposed parent is born open, so D3's refusal lands on the
 *     ANCHOR — the committed row that gains the new open subtree.
 */
function assertReparentUnderProposalLegal(
  item: ProposalNode,
  target: LiveWorkItemState,
  ref: string,
  liveById: ValidatePlanProposalsInput['liveById'],
  ancestorIdsById: ValidatePlanProposalsInput['ancestorIdsById'],
  terminalStatusKeys: ReadonlySet<string>,
  addsById: ReadonlyMap<string, ProposalNode>,
): void {
  const parent = addsById.get(tempRefId(ref));
  if (!parent) {
    // The append checks temp-refs against the persisted `add`s and the gate's
    // step 2 against the plan's; this arm is what keeps the function total when
    // a caller runs it alone.
    throw new PlanRefGraphError(
      'dangling',
      item.id,
      `${describeSubject(item, liveById)}'s patch.parentRef "${ref}" names no \`add\` in this plan.`,
    );
  }
  const { proposedAncestors, anchorId } = projectedParentChain(ref, addsById);
  const committedChain = anchorId ? [anchorId, ...(ancestorIdsById.get(anchorId) ?? [])] : [];
  const parentName = describeProposal(parent);

  if (committedChain.includes(target.id)) {
    throw new PlanRefGraphError(
      'cycle',
      item.id,
      `${describeSubject(item, liveById)} would re-parent work item ${describeNode(target.id, [], liveById)} under ${parentName}, which this plan creates BELOW that work item — the move would create a cycle.`,
    );
  }

  const resultingDepth = proposedAncestors.length + committedChain.length + 2;
  if (resultingDepth > MAX_WORK_ITEM_DEPTH) {
    throw new PlanGrammarError(
      'parent_depth_limit',
      item.id,
      `${describeSubject(item, liveById)} would place work item ${describeNode(target.id, [], liveById)} under ${parentName} at depth ${resultingDepth}, past the limit of ${MAX_WORK_ITEM_DEPTH}.`,
    );
  }

  assertParentKindLegal(item, issueKindOf(parent), target.kind as IssueType, liveById);

  const anchor = anchorId ? liveById.get(anchorId) : undefined;
  if (anchor && terminalStatusKeys.has(anchor.status)) {
    throw new PlanGrammarError(
      'parent_terminal',
      item.id,
      `${describeSubject(item, liveById)} would re-parent work item ${describeNode(target.id, [], liveById)} under ${parentName}, which this plan creates under ${describeNode(anchor.id, [], liveById)} — in the terminal status "${anchor.status}". Giving a finished work item a new open subtree re-opens it and every ancestor above it.`,
    );
  }
}

/** A proposed `add` named for a reader: its title when it has one, else its id. */
function describeProposal(add: ProposalNode): string {
  const title = add.proposedFields?.title;
  return title
    ? `proposed ${proposedKindOf(add)} "${title}" (${TEMP_REF_PREFIX}${add.id})`
    : `${TEMP_REF_PREFIX}${add.id}`;
}

/** `assertValidParent`, with its `IllegalParentTypeError` re-thrown as the plan
 *  gate's own typed rejection — the same translation step 3 makes for an `add`. */
function assertParentKindLegal(
  item: ProposalNode,
  parentKind: IssueType | null,
  childKind: IssueType,
  liveById: ValidatePlanProposalsInput['liveById'],
): void {
  try {
    assertValidParent(parentKind, childKind);
  } catch (err) {
    if (err instanceof IllegalParentTypeError) {
      throw new PlanGrammarError(
        'illegal_parent',
        item.id,
        `${describeSubject(item, liveById)} is not a legal placement: ${err.message}`,
      );
    }
    throw err;
  }
}

// ── The RE-KIND a `modify` may now propose (bug MOTIR-8192 · AMENDMENT 25) ────
//
// `patch.kind` turns a committed work item into another kind on approve. Every
// question `workItemsService.updateWorkItem`'s kind path asks is asked here,
// against the PROJECTED tree rather than the live one: the parent admits the new
// kind, the new kind admits every child the target keeps, and a container keeps
// no leaf field. The plan's OWN placements (an `add` under the target, a
// `modify` moving a card under it, a re-parent of the target itself) read the
// projected kind through {@link withProjectedKinds}, so steps 3 and 3c judge
// them against the kind the target will HAVE, not the kind it has.

/**
 * The kind every `modify` in `items` re-kinds its target to, by target id. Only a
 * WELL-FORMED re-kind (a `MODIFY_KIND_TARGETS` member) projects; a malformed one
 * leaves the live kind standing and is refused by {@link assertKindChangesLegal}.
 */
export function projectedKindOverrides(items: readonly ProposalNode[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const item of items) {
    if (item.op !== 'modify' || !item.workItemId) continue;
    const kind = item.patch?.kind;
    if (isModifyKindTarget(kind)) out.set(item.workItemId, kind);
  }
  return out;
}

/** `liveById` with each re-kinded target's `kind` replaced by its projected one. */
export function withProjectedKinds(
  liveById: ValidatePlanProposalsInput['liveById'],
  overrides: ReadonlyMap<string, string>,
): ValidatePlanProposalsInput['liveById'] {
  if (overrides.size === 0) return liveById;
  const out = new Map(liveById);
  for (const [id, kind] of overrides) {
    const live = out.get(id);
    if (live) out.set(id, { ...live, kind });
  }
  return out;
}

/**
 * Assert every `modify`'s re-kind is legal against the projected tree, or throw
 * the typed rejection that says why (bug MOTIR-8192 · AMENDMENT 25). PURE: the
 * committed tree around each target arrives in `kindChangeContextById`.
 *
 *   1. membership — `unknown_kind` for anything outside `MODIFY_KIND_TARGETS`
 *      (no `epic`);
 *   2. the PARENT admits the new kind — `illegal_parent`. Skipped when the same
 *      patch re-parents the target: step 3c judges that move with the projected
 *      kind already;
 *   3. the new kind admits every committed CHILD the target keeps —
 *      `illegal_parent`, naming the child. A child the plan moves away or
 *      removes is not kept; a child the plan re-kinds is judged by its own
 *      projected kind;
 *   4. a CONTAINER keeps no leaf field — `type_on_container` /
 *      `difficulty_on_container` when the patch leaves the target's own value
 *      standing. Refused rather than cleared: AMENDMENT 25 §3.
 *
 * A target that resolves to nothing, or has no context, is left to
 * `materialize` and to the doors, as step 4 of the gate leaves it.
 */
export function assertKindChangesLegal(
  items: readonly ProposalNode[],
  liveById: ValidatePlanProposalsInput['liveById'],
  kindChangeContextById: ReadonlyMap<string, KindChangeContext>,
): void {
  const overrides = projectedKindOverrides(items);
  const kindOf = (id: string, live: string): string => overrides.get(id) ?? live;
  const notKept = new Set<string>();
  for (const item of items) {
    if (!item.workItemId) continue;
    if (item.op === 'remove') notKept.add(item.workItemId);
    if (item.op === 'modify' && item.patch?.parentRef !== undefined) notKept.add(item.workItemId);
  }

  for (const item of items) {
    if (item.op !== 'modify' || !item.workItemId || item.patch?.kind === undefined) continue;
    const next = item.patch.kind;
    if (!isModifyKindTarget(next)) {
      throw new PlanGrammarError(
        'unknown_kind',
        item.id,
        `${describeSubject(item, liveById)} re-kinds its target to "${String(next)}", which is not a kind a work item can be re-kinded to. Legal values: ${MODIFY_KIND_TARGETS.join(', ')}.`,
      );
    }
    const target = liveById.get(item.workItemId);
    const context = target ? kindChangeContextById.get(target.id) : undefined;
    if (!target || !context) continue;
    const subject = `${describeSubject(item, liveById)} re-kinds ${describeNode(target.id, [], liveById)} from \`${target.kind}\` to \`${next}\``;

    if (item.patch.parentRef === undefined) {
      const parentKind =
        context.parentId === null ? null : kindOf(context.parentId, context.parentKind ?? '');
      if (parentKind === null || isIssueType(parentKind)) {
        try {
          assertValidPlacement({ parentKind, filed: context.filed }, next);
        } catch (err) {
          if (err instanceof IllegalParentTypeError) {
            throw new PlanGrammarError(
              'illegal_parent',
              item.id,
              `${subject}, which its current parent does not admit: ${err.message}`,
            );
          }
          throw err;
        }
      }
    }

    for (const child of context.children) {
      if (notKept.has(child.id)) continue;
      const childKind = kindOf(child.id, child.kind);
      if (!isIssueType(childKind)) continue;
      try {
        assertValidParent(next, childKind);
      } catch (err) {
        if (err instanceof IllegalParentTypeError) {
          throw new PlanGrammarError(
            'illegal_parent',
            item.id,
            `${subject}, which cannot parent its child ${child.key} "${child.title}" (a \`${childKind}\`): ${err.message} Move or re-kind that child in the same plan, or keep the kind.`,
          );
        }
        throw err;
      }
    }

    if (isContainerKind(next)) {
      const type = 'type' in item.patch ? (item.patch.type ?? null) : context.type;
      if (type !== null) {
        throw new PlanGrammarError(
          'type_on_container',
          item.id,
          `${subject}, but the target would keep its type "${type}". A \`${next}\` is a container and cannot carry a type — add \`type: null\` to the patch.`,
        );
      }
      const difficulty =
        'difficulty' in item.patch ? (item.patch.difficulty ?? null) : context.difficulty;
      if (difficulty !== null) {
        throw new PlanGrammarError(
          'difficulty_on_container',
          item.id,
          `${subject}, but the target would keep its difficulty "${difficulty}". A \`${next}\` is a container and cannot carry a difficulty — add \`difficulty: null\` to the patch.`,
        );
      }
    }
  }
}

/**
 * The KIND-PARENT half of the gate for ONE proposed `add` whose kind a door just
 * changed (bug MOTIR-8192 · AMENDMENT 25 §4): its own placement under the kind
 * of its parent, and the placement of every proposal the plan hangs UNDER it — a
 * child `add`, or a `modify` moving its target there. The same two matrices
 * step 3 and step 3c ask over the whole plan, asked here of the one proposal the
 * edit touched, so a correction or a deepen cannot re-kind an `add` into a shape
 * the plan's own tree refuses and leave it for the reviewer to meet at approve.
 *
 * `liveById` must hold the add's real parent (when it has one) and every
 * `modify` target moving under it; a row missing from it is skipped, never
 * guessed — the close's whole-plan gate is the backstop.
 */
export function assertAddKindPlacementLegal(
  addId: string,
  items: readonly ProposalNode[],
  liveById: ValidatePlanProposalsInput['liveById'],
): void {
  const addsById = new Map(items.filter((i) => i.op === 'add').map((a) => [a.id, a]));
  const add = addsById.get(addId);
  if (!add) return;
  const projected = withProjectedKinds(liveById, projectedKindOverrides(items));
  const kind = issueKindOf(add);
  const placeAdd = (node: ProposalNode, parentKind: IssueType | null): void => {
    const filed = node.parentRef !== null && isFolderRef(node.parentRef);
    try {
      assertValidPlacement({ parentKind, filed }, issueKindOf(node));
    } catch (err) {
      if (err instanceof IllegalParentTypeError) {
        throw new PlanGrammarError(
          'illegal_parent',
          node.id,
          `${describeProposal(node)} is not a legal placement: ${err.message}`,
        );
      }
      throw err;
    }
  };

  const ref = add.parentRef;
  if (!ref || isFolderRef(ref)) {
    placeAdd(add, null);
  } else if (isTempRef(ref)) {
    const parent = addsById.get(tempRefId(ref));
    if (parent) placeAdd(add, issueKindOf(parent));
  } else {
    const parentKind = projected.get(ref)?.kind;
    if (parentKind !== undefined && isIssueType(parentKind)) placeAdd(add, parentKind);
  }

  const under = `${TEMP_REF_PREFIX}${add.id}`;
  for (const node of items) {
    if (node.op === 'add' && node.parentRef === under) placeAdd(node, kind);
    if (node.op === 'modify' && node.workItemId && node.patch?.parentRef === under) {
      const target = projected.get(node.workItemId);
      if (target && isIssueType(target.kind)) {
        assertParentKindLegal(node, kind, target.kind, liveById);
      }
    }
  }
}

// ── NAMING THE WORK ITEM A REFUSAL IS ABOUT (MOTIR-3936) ─────────────────────
//
// Every message below used to identify its subject as `Proposal <cuid>`. That is
// the right subject for the AUTHOR, who can look the proposal up, and the wrong
// one for the REVIEWER, who is holding a tree of cards and has no surface that
// takes a plan-item id. So a refusal now names the WORK ITEM too, wherever one is
// resolvable — by key and title, in the reviewer's own vocabulary.
//
// APPENDED rather than substituted, deliberately: the proposal id is what the
// author corrects through, so both identities ride on one message.

/** `MOTIR-7 "Wire the gate"`, or `null` when the ref names no live work item. */
function describeLive(
  ref: string | null | undefined,
  liveById: ValidatePlanProposalsInput['liveById'],
): string | null {
  if (!ref || isTempRef(ref)) return null;
  const live = liveById.get(ref);
  return live ? `${live.key} "${live.title}"` : null;
}

/**
 * How a refusal names the proposal's own subject: the plan-item id always, plus
 * the work item it targets when there is one. An `add` has no work item yet —
 * that is what an `add` IS — so it degrades to the proposal id alone, which is
 * also the only identity anybody could act on for it.
 */
function describeSubject(
  item: ProposalNode,
  liveById: ValidatePlanProposalsInput['liveById'],
): string {
  const live = describeLive(item.workItemId, liveById);
  return live ? `Proposal ${item.id} (${live})` : `Proposal ${item.id}`;
}

/** The trailing ` (MOTIR-7 "…")` clause for a ref, or the empty string. */
function refSuffix(ref: string, liveById: ValidatePlanProposalsInput['liveById']): string {
  const live = describeLive(ref, liveById);
  return live ? ` (${live})` : '';
}

// ── THE `blocked_by` EDGE GRAPH (MOTIR-3936) ─────────────────────────────────
//
// The checks above read the plan's `planItem:` REF graph — which proposal points
// at which proposal. This one reads the EDGES the plan would WRITE, which is a
// different graph and the one `enforce_work_item_link_no_cycle` judges:
//
//   * an `add`'s `blockedByRefs` — a new node blocked by a proposal or a card;
//   * a `modify`'s `patch.blockedByAdd` — an EXISTING card blocked by another
//     EXISTING card, carrying no temp-ref at all;
//   * a `modify`'s `patch.blockedByRemove` — the same edge taken away;
//   * every COMMITTED edge the chain runs through, which no proposal mentions.
//
// The second is why a per-proposal read cannot answer this. Two `modify` patches
// in ONE batch are two halves of a single graph edit, and each half is legal on
// its own: `MOTIR-3895 blocked_by MOTIR-3923` and `MOTIR-3923 blocked_by
// MOTIR-3895` were appended, closed, and validated VALID by three separate
// checks before approve raised `WI_LINK_CYCLE` from a BEFORE ROW trigger and the
// route answered a bare 500 three times.
//
// The walk mirrors the trigger's recursive CTE exactly — follow `is_blocked_by`
// from the new edge's far end and reject when the chain comes back — so the two
// cannot disagree about what a cycle is. It runs at the CLOSE, where the plan is
// still `generating` and the author can drop the edge — and, since MOTIR-9267,
// at every door that WRITES an edge onto a `generating` plan (`addProposals`,
// `correctProposal`), because a planner schedules its author sessions by these
// edges before the close and a ring there has no order to schedule.

/** The graph node an `add` proposal contributes (it has no work-item id yet). */
function addNodeId(proposalId: string): string {
  return `${TEMP_REF_PREFIX}${proposalId}`;
}

/** The node a ref denotes: a temp-ref keeps its `planItem:` form, a real id its own. */
function edgeNodeOf(ref: string): string {
  return isTempRef(ref) ? addNodeId(tempRefId(ref)) : ref;
}

/**
 * Build the `blocked_by` adjacency the plan would leave behind: every committed
 * edge, MINUS the ones its `modify`s remove, PLUS the ones its `add`s and
 * `modify`s write. Keyed blocked → blockers, which is the direction the trigger
 * walks.
 *
 * Each proposed edge remembers WHICH proposal wrote it, so a cycle can be
 * reported against the proposal a person would go and correct rather than
 * against whichever node the walk happened to enter on.
 */
function buildBlockedByGraph(
  items: readonly ProposalNode[],
  existingBlockedByEdges: readonly BlockedByEdge[],
): {
  adjacency: Map<string, string[]>;
  authorOf: Map<string, ProposalNode>;
} {
  const adjacency = new Map<string, string[]>();
  const authorOf = new Map<string, ProposalNode>();
  const edgeKey = (from: string, to: string): string => `${from}\u0000${to}`;

  const add = (from: string, to: string, author: ProposalNode | null): void => {
    // A self-edge is `WI_LINK_SELF`'s business and is already refused by
    // `assertRefsSelfConsistent` for a proposal naming itself; dropping it here
    // keeps the walk about CYCLES rather than re-reporting that one as one.
    if (from === to) return;
    const blockers = adjacency.get(from);
    if (blockers) {
      if (!blockers.includes(to)) blockers.push(to);
    } else {
      adjacency.set(from, [to]);
    }
    if (author && !authorOf.has(edgeKey(from, to))) authorOf.set(edgeKey(from, to), author);
  };

  // The edges the plan TAKES AWAY, resolved first so a plan that swaps an edge
  // for its reverse is judged on the graph it actually leaves.
  const removed = new Set<string>();
  for (const item of items) {
    if (item.op !== 'modify' || !item.workItemId) continue;
    for (const ref of item.patch?.blockedByRemove ?? []) {
      removed.add(edgeKey(item.workItemId, edgeNodeOf(ref)));
    }
  }

  for (const edge of existingBlockedByEdges) {
    if (removed.has(edgeKey(edge.blockedId, edge.blockerId))) continue;
    add(edge.blockedId, edge.blockerId, null);
  }

  for (const item of items) {
    if (item.op === 'add') {
      const from = addNodeId(item.id);
      for (const ref of item.blockedByRefs) add(from, edgeNodeOf(ref), item);
      continue;
    }
    if (item.op !== 'modify' || !item.workItemId) continue;
    for (const ref of item.patch?.blockedByAdd ?? []) {
      add(item.workItemId, edgeNodeOf(ref), item);
    }
  }

  return { adjacency, authorOf };
}

/** How a node reads in a message: a work item by key + title, else its ref. */
function describeNode(
  node: string,
  items: readonly ProposalNode[],
  liveById: ValidatePlanProposalsInput['liveById'],
): string {
  const live = liveById.get(node);
  if (live) return `${live.key} "${live.title}"`;
  if (isTempRef(node)) {
    const title = items.find((i) => i.id === tempRefId(node))?.proposedFields?.title;
    return title ? `${node} "${title}"` : node;
  }
  return node;
}

/**
 * Assert the `blocked_by` graph the plan would leave is ACYCLIC (MOTIR-3936).
 *
 * Reported against the PROPOSAL that closed the cycle — the one whose edge is on
 * the ring and was written by this plan. A ring made entirely of committed edges
 * is not this gate's business and cannot occur anyway: the trigger refused it at
 * the time it would have been created.
 */
export function assertBlockedByGraphAcyclic(
  items: readonly ProposalNode[],
  liveById: ValidatePlanProposalsInput['liveById'],
  existingBlockedByEdges: readonly BlockedByEdge[],
): void {
  const { adjacency, authorOf } = buildBlockedByGraph(items, existingBlockedByEdges);
  if (adjacency.size === 0) return;

  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>();
  const stack: string[] = [];

  const report = (ring: readonly string[]): never => {
    // The proposal to name is the author of an edge ON the ring — the plan's own
    // contribution to it, and the one a correction removes.
    let author: ProposalNode | null = null;
    for (let i = 0; i < ring.length; i += 1) {
      const found = authorOf.get(`${ring[i]}\u0000${ring[(i + 1) % ring.length]}`);
      if (found) {
        author = found;
        break;
      }
    }
    /* istanbul ignore next -- defensive: a ring with no proposed edge cannot exist (the trigger refused it when the committed edges were written) */
    const subject = author ? describeSubject(author, liveById) : 'This plan';
    const path = ring.map((n) => describeNode(n, items, liveById)).join(' blocked_by ');
    throw new PlanRefGraphError(
      'cycle',
      /* istanbul ignore next -- defensive: see above */
      author ? author.id : (items[0]?.id ?? 'unknown'),
      `${subject} closes a dependency CYCLE: ${path} blocked_by ${describeNode(ring[0]!, items, liveById)}. ` +
        `Every edge on that ring would exist once this plan is approved, and \`is_blocked_by\` may not come back to where it started ` +
        `(the work_item_link no-cycle trigger raises WI_LINK_CYCLE for it mid-approve). Drop one of the edges.`,
    );
  };

  const visit = (node: string): void => {
    colour.set(node, GREY);
    stack.push(node);
    for (const blocker of adjacency.get(node) ?? []) {
      const seen = colour.get(blocker) ?? WHITE;
      if (seen === GREY) {
        report(stack.slice(stack.indexOf(blocker)));
      }
      if (seen === WHITE) visit(blocker);
    }
    stack.pop();
    colour.set(node, BLACK);
  };

  for (const node of adjacency.keys()) {
    if ((colour.get(node) ?? WHITE) === WHITE) visit(node);
  }
}

// ── THE `supersedes` EDGE GRAPH (Story MOTIR-6577 · MOTIR-6630) ──────────────
//
// The sibling of the blocker walk above, deliberately a SEPARATE function: the
// blocker passes carry level and readiness semantics this kind must not inherit.
// `supersedes` is directed NEWER → OLDER, and a ring (A replaces B replaces A)
// is nonsense a reader cannot resolve. Unlike `is_blocked_by`, the database
// does NOT refuse one — `enforce_work_item_link_no_cycle` returns early for any
// other kind — so this walk is the only guard on the plan path.
//
// The plan's contribution, over the committed links:
//   * an `add`'s `supersedesRefs`         — created card → each ref;
//   * a `modify`'s `patch.supersedesAdd`   — target → each ref;
//   * a `modify`'s `patch.supersededByAdd` — each ref → target (the SAME row the
//     newer card's `supersedesAdd` would write, spelled from the other end);
//   * the two `…Remove` lists take the matching committed row away first.

/**
 * Build the `supersedes` adjacency the plan would leave behind, keyed newer →
 * older, each proposed edge remembering the proposal that wrote it.
 */
function buildSupersedesGraph(
  items: readonly ProposalNode[],
  existing: readonly SupersedesEdge[],
): { adjacency: Map<string, string[]>; authorOf: Map<string, ProposalNode> } {
  const adjacency = new Map<string, string[]>();
  const authorOf = new Map<string, ProposalNode>();
  const edgeKey = (from: string, to: string): string => `${from}\u0000${to}`;
  const add = (from: string, to: string, author: ProposalNode | null): void => {
    // A self-edge is refused by `assertRefsSelfConsistent`; the walk is about rings.
    if (from === to) return;
    const olders = adjacency.get(from);
    if (olders) {
      if (!olders.includes(to)) olders.push(to);
    } else {
      adjacency.set(from, [to]);
    }
    if (author && !authorOf.has(edgeKey(from, to))) authorOf.set(edgeKey(from, to), author);
  };

  const removed = new Set<string>();
  for (const item of items) {
    if (item.op !== 'modify' || !item.workItemId) continue;
    for (const ref of item.patch?.supersedesRemove ?? []) {
      removed.add(edgeKey(item.workItemId, edgeNodeOf(ref)));
    }
    for (const ref of item.patch?.supersededByRemove ?? []) {
      removed.add(edgeKey(edgeNodeOf(ref), item.workItemId));
    }
  }

  for (const edge of existing) {
    if (removed.has(edgeKey(edge.fromId, edge.toId))) continue;
    add(edge.fromId, edge.toId, null);
  }

  for (const item of items) {
    if (item.op === 'add') {
      const from = addNodeId(item.id);
      for (const ref of item.supersedesRefs ?? []) add(from, edgeNodeOf(ref), item);
      continue;
    }
    if (item.op !== 'modify' || !item.workItemId) continue;
    for (const ref of item.patch?.supersedesAdd ?? []) {
      add(item.workItemId, edgeNodeOf(ref), item);
    }
    for (const ref of item.patch?.supersededByAdd ?? []) {
      add(edgeNodeOf(ref), item.workItemId, item);
    }
  }
  return { adjacency, authorOf };
}

/**
 * Assert the `supersedes` graph the plan would leave is ACYCLIC (MOTIR-6630),
 * refused as `INVALID_PLAN_REF_GRAPH` / `cycle` against the proposal whose edge
 * closes the ring. There is NO level rule: a story may supersede a task or an
 * epic. Exported for the APPEND, which runs it where the edge is written.
 */
export function assertSupersedesGraphAcyclic(
  items: readonly ProposalNode[],
  liveById: ValidatePlanProposalsInput['liveById'],
  existingSupersedesEdges: readonly SupersedesEdge[],
): void {
  const { adjacency, authorOf } = buildSupersedesGraph(items, existingSupersedesEdges);
  if (adjacency.size === 0) return;

  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>();
  const stack: string[] = [];

  const report = (ring: readonly string[]): never => {
    let author: ProposalNode | null = null;
    for (let i = 0; i < ring.length; i += 1) {
      const found = authorOf.get(`${ring[i]}\u0000${ring[(i + 1) % ring.length]}`);
      if (found) {
        author = found;
        break;
      }
    }
    /* istanbul ignore next -- defensive: a ring of committed links only is not this plan's to refuse, and the walk only enters it through a proposed edge */
    const subject = author ? describeSubject(author, liveById) : 'This plan';
    const path = ring.map((n) => describeNode(n, items, liveById)).join(' supersedes ');
    throw new PlanRefGraphError(
      'cycle',
      /* istanbul ignore next -- defensive: see above */
      author ? author.id : (items[0]?.id ?? 'unknown'),
      `${subject} closes a SUPERSEDES cycle: ${path} supersedes ${describeNode(ring[0]!, items, liveById)}. ` +
        `A card cannot be replaced, however indirectly, by a card it replaces. Drop one of the edges.`,
    );
  };

  const visit = (node: string): void => {
    colour.set(node, GREY);
    stack.push(node);
    for (const older of adjacency.get(node) ?? []) {
      const seen = colour.get(older);
      if (seen === GREY) report(stack.slice(stack.indexOf(older)));
      if (seen === undefined) visit(older);
    }
    stack.pop();
    colour.set(node, BLACK);
  };

  for (const node of adjacency.keys()) {
    if (!colour.has(node)) visit(node);
  }
}

// ── THE LEVEL OF A `blocked_by` EDGE (Story MOTIR-6015 · MOTIR-6367 / 6411) ───
//
// A `blocked_by` joins two work items on the SAME LEVEL — the same depth below
// their nearest common ancestor (`lib/workItems/edgeLevel.ts`, the POSITION rule
// of MOTIR-6387). It may cross parents: nothing below compares PARENTS. What it
// may not do is join two levels.
//
// Each end's position is read from the PROJECTION the plan would leave: an
// `add` sits under its `parentRef` (a proposal or a live row; a folder or none
// makes it a root), a `modify` that re-parents (`patch.parentRef`) sits under its
// new parent, and any other live row keeps its committed ancestor chain up to
// the nearest ancestor the plan re-parents, above which it follows that move
// (`ancestorsById`, one batched read by the caller). `blockedByRemove` is never
// judged, so a plan can always take a bad edge away.
//
// An end whose position is not known here is SKIPPED rather than guessed: an
// unresolvable ref is `assertRefsResolvable`'s refusal, and a live row the caller
// did not read is left to a gate that reads it.

/**
 * The PROJECTED ancestor chain (nearest first) of the node a ref names, or
 * `undefined` when it cannot be placed here. A proposal's chain element is its
 * `planItem:` node id, a live row's its own id — the same node ids the cycle walk
 * uses, so two chains through one proposed parent share it.
 */
function projectedChain(
  ref: string,
  addsById: ReadonlyMap<string, ProposalNode>,
  reparentOf: ReadonlyMap<string, string | null>,
  ancestorsById: ReadonlyMap<string, readonly string[]>,
  visiting: Set<string> = new Set(),
): readonly string[] | undefined {
  if (isFolderRef(ref)) return undefined;
  const node = edgeNodeOf(ref);
  if (visiting.has(node)) return undefined; // a parent cycle is another check's refusal
  visiting.add(node);
  const under = (parent: string | null | undefined): readonly string[] | undefined => {
    if (!parent || isFolderRef(parent)) return [];
    const above = projectedChain(parent, addsById, reparentOf, ancestorsById, visiting);
    return above === undefined ? undefined : [edgeNodeOf(parent), ...above];
  };
  if (isTempRef(ref)) {
    const add = addsById.get(tempRefId(ref));
    return add ? under(add.parentRef) : undefined;
  }
  if (reparentOf.has(ref)) return under(reparentOf.get(ref));
  // A live row the plan does not move keeps its committed chain only up to the
  // nearest ancestor the plan DOES move; above that it sits where the move puts
  // it (MOTIR-9756). Read raw, the chain would place a committed child of a
  // moved card at its pre-move depth while a new sibling is placed after it.
  const committed = ancestorsById.get(ref);
  if (committed === undefined) return undefined;
  const moved = committed.findIndex((ancestor) => reparentOf.has(ancestor));
  if (moved === -1) return committed;
  const above = projectedChain(committed[moved]!, addsById, reparentOf, ancestorsById, visiting);
  return above === undefined ? undefined : [...committed.slice(0, moved + 1), ...above];
}

/**
 * Refuse the first `blocked_by` the plan would WRITE between two different
 * levels, as `INVALID_PLAN_REF_GRAPH` / `cross_level`.
 *
 * `subjectIds`, when given, narrows WHICH proposals' edges are judged — the
 * append judges only what the batch writes, so a plan closed before this rule
 * existed is not locked out of an unrelated append. The refs still resolve
 * against every proposal in `items`.
 */
export function assertBlockedByLevels(
  items: readonly ProposalNode[],
  liveById: ValidatePlanProposalsInput['liveById'],
  ancestorsById: ReadonlyMap<string, readonly string[]>,
  subjectIds?: ReadonlySet<string>,
): void {
  const addsById = new Map(items.filter((i) => i.op === 'add').map((a) => [a.id, a]));
  const reparentOf = new Map<string, string | null>();
  for (const item of items) {
    if (item.op === 'modify' && item.workItemId && item.patch && 'parentRef' in item.patch) {
      reparentOf.set(item.workItemId, item.patch.parentRef ?? null);
    }
  }
  const chain = (ref: string) => projectedChain(ref, addsById, reparentOf, ancestorsById);
  // Each end's PROJECTED kind — an add's proposed kind, else the live row's
  // (Amendment 1: an epic pairs only with an epic). Undefined = not judged here.
  const kindOf = (ref: string): string | undefined => {
    if (isFolderRef(ref)) return undefined;
    if (isTempRef(ref)) return addsById.get(tempRefId(ref))?.proposedFields?.kind ?? undefined;
    return liveById.get(ref)?.kind;
  };
  for (const item of items) {
    if (subjectIds && !subjectIds.has(item.id)) continue;
    let subjectRef: string;
    let refs: readonly string[];
    if (item.op === 'add') {
      subjectRef = addNodeId(item.id);
      refs = item.blockedByRefs;
    } else if (item.op === 'modify' && item.workItemId) {
      subjectRef = item.workItemId;
      refs = item.patch?.blockedByAdd ?? [];
    } else {
      continue;
    }
    if (refs.length === 0) continue;
    const subjectChain = chain(subjectRef);
    const subjectKind = kindOf(subjectRef);
    if (subjectChain === undefined || subjectKind === undefined) continue;
    const subjectEnd = { kind: subjectKind, ancestors: subjectChain };
    for (const ref of refs) {
      const blockerChain = chain(ref);
      const blockerKind = kindOf(ref);
      if (blockerChain === undefined || blockerKind === undefined) continue;
      const blockerEnd = { kind: blockerKind, ancestors: blockerChain };
      if (!isCrossLevelEdge(subjectEnd, blockerEnd)) continue;
      const subject =
        item.op === 'add'
          ? `Proposal ${item.id} (${describeProposal(item)})`
          : describeSubject(item, liveById);
      const where = item.op === 'add' ? 'blockedByRefs' : 'patch.blockedByAdd';
      throw new PlanRefGraphError(
        'cross_level',
        item.id,
        `cross_level: ${crossLevelReason(
          { ...subjectEnd, label: subject },
          {
            ...blockerEnd,
            label: `its ${where} "${ref}" (${describeNode(edgeNodeOf(ref), items, liveById)})`,
          },
        )}`,
      );
    }
  }
}

/**
 * THE GATE. Re-validate an approved proposal set independently, before it
 * becomes rows. Throws the first violation as a typed error — `PlanRefGraphError`
 * / `PlanGrammarError` (→ 400), `PlanTargetImmutableError` (→ 409), or
 * `InvalidProposalError` (→ 422) for a mark on an unfinished target — and
 * writes nothing, ever (it is pure). An empty / all-declined plan is a valid
 * no-op and passes.
 *
 * Order matters: the plan is self-consistent → its refs resolve → the grammar
 * holds → done work is immutable. Each step's guarantees are what the next one
 * relies on, so a malformed plan always fails with the MOST specific reason.
 *
 * ⚠️ STEP 1 IS THE SAME FUNCTION `addProposals` RUNS AT THE APPEND (MOTIR-3573).
 * It is called here rather than re-implemented so the two stages cannot disagree
 * about what a self-consistent plan is; everything below it needs `liveById` and
 * therefore cannot move earlier than the CLOSE.
 */
export function validatePlanProposals(input: ValidatePlanProposalsInput): void {
  const {
    items,
    liveById,
    terminalStatusKeys,
    planProjectId,
    ancestorIdsById,
    existingBlockedByEdges,
    existingSupersedesEdges,
    markTargetStatusCategoryById,
  } = input;
  const folderById = input.folderById ?? new Map<string, LiveFolderState>();

  const adds = items.filter((i) => i.op === 'add');
  const addsById = new Map(adds.map((a) => [a.id, a]));
  const addIds = new Set(addsById.keys());
  // The live rows with every RE-KINDED target at the kind it will HAVE (bug
  // MOTIR-8192 · AMENDMENT 25) — what every placement question below reads, so
  // an `add` under a task the plan turns into a story is judged under a story.
  const projectedLiveById = withProjectedKinds(liveById, projectedKindOverrides(items));

  // 1. PURE — no blocker listed twice, no self-reference, no `parentRef` cycle.
  //    Already enforced at the append; re-run here because the approve path
  //    trusts nothing (a proposal set can be edited between the two).
  assertProposalSetSelfConsistent(items);

  // 2. Every ref resolves — the arm that needs the batched workspace read.
  for (const item of items) {
    for (const [where, refs] of refSitesOf(item)) {
      assertRefsResolvable(item, refs, liveById, addIds, where, folderById);
    }
  }

  // 2b. The `blocked_by` EDGE graph the plan would leave behind — its own
  //     proposed edges joined onto the committed ones (MOTIR-3936). Runs AFTER
  //     resolution, because a walk over unresolvable refs would report a cycle
  //     where the specific reason is a dangling ref, and BEFORE the grammar,
  //     because a plan that cannot be wired is not a plan whose placements are
  //     worth discussing.
  // 2a. Every edge the plan WRITES joins two items on the SAME LEVEL (Story
  //     MOTIR-6015 · MOTIR-6367). After resolution, so a dangling ref is reported
  //     as dangling; before the cycle walk, because an edge that may not exist
  //     at all is the more specific reason than a ring it happens to close.
  assertBlockedByLevels(items, liveById, input.edgeAncestorsById ?? new Map());

  assertBlockedByGraphAcyclic(items, liveById, existingBlockedByEdges);

  // 2c. The `supersedes` EDGE graph (MOTIR-6630) — same tier, same reason, and
  //     no level rule before it: `supersedes` orders nothing.
  assertSupersedesGraphAcyclic(items, liveById, existingSupersedesEdges);

  // 3. The kind-parent grammar — asked of `lib/issues/parentRules.ts`, the same
  //    matrix every human create/move is gated on. Independent of whatever the
  //    planner self-checked, and of any human edit through `updateProposal`.
  for (const item of adds) {
    // 3a. The proposed `type` is a member of the schema enum (MOTIR-3654). Runs
    //     BEFORE the parent grammar for the same reason step 1 runs before step
    //     2: a malformed plan should fail with the most specific reason, and a
    //     bad `type` is a property of the proposal alone — it needs no graph.
    assertProposedTypeKnown(item);
    // 3a-bis. The proposed `subject` is well-formed (MOTIR-5065; the container
    //     half retired by MOTIR-5607 — a subject is legal on every kind). Same
    //     tier and same argument as the `type` check above — a property of the
    //     proposal alone, needing no graph.
    assertProposedSubjectValid(item);
    const childKind = issueKindOf(item);
    const parentKind = effectiveParentKind(item, addsById, projectedLiveById);
    // A `folder:` parent FILES the card (MOTIR-5414), and a folder admits any
    // kind — so a `subtask` filed into a folder is legal while the same subtask
    // at the project root is still refused. `assertValidPlacement` is the
    // folder-aware twin of `assertValidParent`, from the same module.
    const filed = item.parentRef !== null && isFolderRef(item.parentRef);
    try {
      assertValidPlacement({ parentKind, filed }, childKind);
    } catch (err) {
      if (err instanceof IllegalParentTypeError) {
        throw new PlanGrammarError(
          'illegal_parent',
          item.id,
          `${describeSubject(item, liveById)} is not a legal placement: ${err.message}`,
        );
      }
      throw err;
    }
  }

  // 3b. PARENT TENANCY — a `parentRef` naming a live work item in ANOTHER
  //     project is refused HERE, with the real reason, rather than by the
  //     `WI_PARENT_CROSS_PROJECT` trigger halfway through `materialize`.
  //
  //     ⚠️ THIS IS NOT THE CROSS-PROJECT RULE — a `blocked_by` ref is checked by
  //     step 2 and NOTHING ELSE, and that asymmetry is the product's, not this
  //     gate's (MOTIR-3581):
  //
  //       * A DEPENDENCY is workspace-scoped BY DESIGN. `work_item_link` carries
  //         the workspace gate and deliberately no project narrowing ("cross-project
  //         links inside one workspace are a v1 use case" —
  //         `20260601074342_add_work_item_rls`), `link_work_items` promises it in
  //         its own contract, and `planValidityService` treats a cross-project
  //         blocker as a first-class case. A shared platform project gating an
  //         application's work is the ordinary shape.
  //       * PARENTAGE is same-project BY INVARIANT, on three enforcing layers:
  //         `workItemsService` throws `CrossProjectParentError` on create and on
  //         both re-parent paths, the `work_item` parent-tenancy trigger raises
  //         `WI_PARENT_CROSS_PROJECT` (`20260817160000_work_item_parent_tenancy`),
  //         and `move_to_parent` refuses it. A plan cannot be the one door that
  //         admits it.
  //
  //     So the two refs are treated differently because they ARE different, and
  //     the message says which is which — the failure this whole card is about was
  //     a refusal whose stated reason the caller could observe to be false.
  for (const item of adds) {
    const ref = item.parentRef;
    if (!ref || isTempRef(ref)) continue;
    // A FOLDER's tenancy is the same rule over a different table (MOTIR-5414).
    if (isFolderRef(ref)) {
      assertFolderInPlanProject(
        item,
        ref,
        'parentRef',
        folderById.get(folderRefId(ref))!,
        planProjectId,
        liveById,
      );
      continue;
    }
    // Resolution is guaranteed by `assertRefsResolvable`.
    const parent = liveById.get(ref)!;
    if (parent.projectId !== planProjectId) {
      throw new PlanGrammarError(
        'illegal_parent',
        item.id,
        `${describeSubject(item, liveById)}'s parentRef "${ref}"${refSuffix(ref, liveById)} names a work item in a DIFFERENT project of this workspace. ` +
          `A work item's parent must live in the same project (a cross-project parent is refused by ` +
          `workItemsService and by the work_item parent-tenancy trigger). A cross-project ` +
          `blocked_by edge IS supported — if this is a dependency rather than a placement, move the ref to ` +
          `blockedByRefs.`,
      );
    }
  }

  // 3b-bis. A DIFFICULTY on a container (MOTIR-6133) — on an `add`'s proposed
  //     kind, and on a `modify`'s LIVE target kind, which is the case the doors
  //     cannot see (a target re-kinded after the append). A property of the
  //     proposal plus the one row it names, so it sits with the grammar.
  for (const item of items) assertDifficultyOnLeaf(item, projectedLiveById);
  // 3b-ter. A `modify`'s replacement STEPS on a container (MOTIR-8668), on the
  //     same projected target kind and for the same reason.
  for (const item of items) assertTodosOnLeaf(item, projectedLiveById);

  // 3c. The RE-PARENT a `modify` may now propose (MOTIR-3859) — tenancy, cycle,
  //     depth, the kind matrix, and the terminal-parent refusal, in that order.
  //     It sits with the other placement questions rather than with step 4
  //     because it IS one: everything it asks is about where a card may SIT.
  //     `addProposals` runs the same function at the APPEND, which is where the
  //     author still has the plan to fix.
  for (const item of items) {
    assertReparentLegal(
      item,
      projectedLiveById,
      ancestorIdsById,
      terminalStatusKeys,
      planProjectId,
      folderById,
      addsById,
    );
  }

  // 3d. The RE-KIND a `modify` may now propose (bug MOTIR-8192 · AMENDMENT 25) —
  //     membership, the parent, the children it keeps and the leaf fields a
  //     container may not keep. With the placements above because it IS one:
  //     a kind is legal only where it sits and over what it holds.
  assertKindChangesLegal(items, liveById, input.kindChangeContextById ?? new Map());

  // 4. Done-work immutability. A `modify`/`remove` never rewrites completed work.
  //    A target that resolves to nothing is left to `materialize`, which raises
  //    `PlanItemTargetMissingError` and rolls the whole approve back.
  //
  //    ONE CARVE-OUT (Story MOTIR-6577 · MOTIR-6629): a `modify` whose patch
  //    carries ONLY `PLAN_ITEM_MARK_PATCH_KEYS` — the obsolescence mark and its
  //    note — may reach a terminal target, because marking finished work is what
  //    the mark is for, and it changes the card's standing, never its work. It is
  //    keyed on the patch's KEYS (`isMarkOnlyPatch`), so any other key beside a
  //    mark is still refused, and a `remove` of a terminal card always is.
  for (const item of items) {
    if (item.op !== 'modify' && item.op !== 'remove') continue;
    if (!item.workItemId) continue;
    if (item.op === 'modify' && isMarkOnlyPatch(item.patch)) continue;
    const target = liveById.get(item.workItemId);
    if (target && terminalStatusKeys.has(target.status)) {
      throw new PlanTargetImmutableError(
        item.id,
        target.id,
        target.status,
        target.key,
        target.title,
      );
    }
  }
  // 4b. A MARK lands only on a FINISHED card (MOTIR-6663) — the direct doors'
  //     rule (MOTIR-6575), carried onto the plan path through the same shared
  //     predicate. Re-asked HERE, against the LIVE row, because a target that was
  //     finished at the append can be reopened (after its mark is cleared) while
  //     the plan waits. Clearing (`null`) and a patch that leaves the mark alone
  //     pass; a target that resolves to nothing is left to `materialize`.
  for (const item of items) {
    if (item.op !== 'modify' || !item.workItemId) continue;
    if (!patchSetsObsolescence(item.patch)) continue;
    const target = liveById.get(item.workItemId);
    if (!target) continue;
    assertMarkTargetIsFinished(
      item.patch,
      {
        key: target.key,
        status: target.status,
        statusCategory: markTargetStatusCategoryById.get(target.id) ?? null,
      },
      // The doors' own `proposalLabel` wording, so every moment reads alike.
      `the \`modify\` of work item ${item.workItemId}`,
      item.id,
    );
  }
}
