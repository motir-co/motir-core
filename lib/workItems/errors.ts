// Typed errors for the work-items domain. Kept in their own file so callers
// — the service layer (1.4.4), route handlers, server actions — can import
// them without pulling in the Prisma client.
//
// These wrap the DB-layer reality: the kind-parent / depth / cycle rules are
// enforced by Postgres triggers (prisma/sql/work_item_triggers.sql), which
// reject with SQLSTATE 23514 + a message marker. workItemRepository catches
// those at its edge and rethrows the matching class here, so the service
// layer never inspects raw Postgres error codes (the 4-layer rule).
//
// Every class carries a string `tag` discriminant. The service layer can
// `switch (err.tag)` over a `WorkItemError` union exhaustively without
// `instanceof` chains or Prisma-code sniffing. `code` mirrors `tag` and is
// what the route layer (Epic 2) maps to an HTTP status, matching the
// `readonly code` convention the workspaces/projects domains established.

import type { PlanHoldDTO } from '@/lib/dto/plans';

export type WorkItemErrorTag =
  | 'ILLEGAL_PARENT_TYPE'
  | 'DEPTH_LIMIT_EXCEEDED'
  | 'PARENT_CYCLE'
  | 'WORK_ITEM_NOT_FOUND'
  | 'KEY_CONFLICT'
  | 'CROSS_PROJECT_PARENT'
  | 'REPORTER_NOT_IN_WORKSPACE'
  | 'ASSIGNEE_NOT_IN_WORKSPACE'
  | 'UNKNOWN_STATUS'
  | 'ILLEGAL_TRANSITION'
  | 'STALE_WORK_ITEM'
  | 'TYPE_NOT_ALLOWED_ON_KIND'
  | 'DIFFICULTY_NOT_ALLOWED_ON_KIND'
  | 'INVALID_OBSOLESCENCE'
  | 'INVALID_CONTENT_LANGUAGE'
  | 'OBSOLESCENCE_REQUIRES_FINISHED'
  | 'MARKED_CARD_CANNOT_REOPEN'
  | 'NOT_EPIC'
  | 'UNKNOWN_TARGET_REPO'
  | 'UNKNOWN_PROJECT_REPO_REF'
  | 'CONTAINER_REPO_SET_NOT_WRITABLE'
  | 'ARCHIVED_TARGET_REPO'
  | 'CONFLICTING_TARGET_REPO_INPUT'
  | 'MISSING_ARTIFACT_EVIDENCE'
  | 'CONTAINER_HAS_OPEN_CHILDREN'
  | 'APPROVAL_GATE_PENDING'
  | 'PLAN_TARGET_HELD'
  | 'WORK_ITEM_IN_TRIAGE';

/**
 * Base class for every work-items typed error. Concrete subclasses set a
 * literal `tag` (the discriminant) and a matching `code`.
 */
export abstract class WorkItemError extends Error {
  abstract readonly tag: WorkItemErrorTag;
  abstract readonly code: WorkItemErrorTag;
}

/**
 * The kind-parent matrix was violated — either an illegal parent kind for the
 * child's kind, or the orphan-subtask case (a subtask with no parent). Both
 * trigger markers (WI_ILLEGAL_PARENT_TYPE and WI_SUBTASK_NEEDS_PARENT) map
 * here: structurally they are both "this parent configuration is illegal."
 */
export class IllegalParentTypeError extends WorkItemError {
  readonly tag = 'ILLEGAL_PARENT_TYPE' as const;
  readonly code = 'ILLEGAL_PARENT_TYPE' as const;
  constructor(message = 'Illegal parent for this work-item kind.') {
    super(message);
    this.name = 'IllegalParentTypeError';
  }
}

/**
 * The tree-depth limit (4 levels) would be exceeded by this insert/move.
 */
export class DepthLimitExceededError extends WorkItemError {
  readonly tag = 'DEPTH_LIMIT_EXCEEDED' as const;
  readonly code = 'DEPTH_LIMIT_EXCEEDED' as const;
  constructor(message = 'Work-item tree depth limit (4 levels) exceeded.') {
    super(message);
    this.name = 'DepthLimitExceededError';
  }
}

/**
 * A re-parent would create a cycle (an ancestor moved under its descendant,
 * or a self-parent).
 */
export class ParentCycleError extends WorkItemError {
  readonly tag = 'PARENT_CYCLE' as const;
  readonly code = 'PARENT_CYCLE' as const;
  constructor(message = 'Re-parenting would create a cycle in the work-item tree.') {
    super(message);
    this.name = 'ParentCycleError';
  }
}

/**
 * No work item matched the id / identifier looked up.
 */
export class WorkItemNotFoundError extends WorkItemError {
  readonly tag = 'WORK_ITEM_NOT_FOUND' as const;
  readonly code = 'WORK_ITEM_NOT_FOUND' as const;
  readonly idOrIdentifier: string;
  constructor(idOrIdentifier: string) {
    super(`Work item ${idOrIdentifier} not found.`);
    this.name = 'WorkItemNotFoundError';
    this.idOrIdentifier = idOrIdentifier;
  }
}

/**
 * A unique-constraint violation on (projectId, key) or (projectId, identifier)
 * — translated from Prisma P2002. In practice the service allocates keys
 * gap-free inside the create transaction, so this should not surface in normal
 * operation; it exists so the repository never leaks a raw Prisma error past
 * its boundary.
 */
export class WorkItemKeyConflictError extends WorkItemError {
  readonly tag = 'KEY_CONFLICT' as const;
  readonly code = 'KEY_CONFLICT' as const;
  constructor(message = 'A work item with this key or identifier already exists in the project.') {
    super(message);
    this.name = 'WorkItemKeyConflictError';
  }
}

/**
 * A parent was specified that lives in a DIFFERENT project — or, since
 * MOTIR-2895, a different WORKSPACE — than the child (Subtask 1.4.4). The
 * work-item tree is project-local, so a cross-project parent is structurally
 * illegal. Distinct from IllegalParentTypeError (the DB trigger's kind-matrix
 * class): a cross-project parent might still be a kind-legal pair, so it needs
 * its own typed error.
 *
 * TWO layers now raise it, and deliberately the same class from both:
 *   * `workItemsService`'s pre-flight check (create + both re-parent paths) —
 *     the friendly, explicit guard, which is what users normally hit.
 *   * `enforce_work_item_parent_tenancy()`, the DB trigger MOTIR-2895 added,
 *     via `workItemRepository`'s 23514 translation of the
 *     `WI_PARENT_CROSS_WORKSPACE` / `WI_PARENT_CROSS_PROJECT` markers. Until
 *     then the database compared parent tenancy nowhere at all, which left the
 *     kind/depth/cycle triggers' own parent lookups resting on this
 *     service-layer check — the circularity that card exists to break.
 * A caller must not have to learn a second vocabulary depending on which layer
 * caught the same mistake, so the marker (not the class) carries which boundary
 * was crossed, and it rides along in the message.
 */
export class CrossProjectParentError extends WorkItemError {
  readonly tag = 'CROSS_PROJECT_PARENT' as const;
  readonly code = 'CROSS_PROJECT_PARENT' as const;
  constructor(message = 'A work item parent must belong to the same project as the child.') {
    super(message);
    this.name = 'CrossProjectParentError';
  }
}

/**
 * The reporter (the acting user creating the work item) is not a member of
 * the project's workspace (Subtask 1.4.4). A service-layer membership gate;
 * the RLS policy landing in 1.4.5 is the structural backstop.
 */
export class ReporterNotInWorkspaceError extends WorkItemError {
  readonly tag = 'REPORTER_NOT_IN_WORKSPACE' as const;
  readonly code = 'REPORTER_NOT_IN_WORKSPACE' as const;
  constructor(message = 'The reporter is not a member of this workspace.') {
    super(message);
    this.name = 'ReporterNotInWorkspaceError';
  }
}

/**
 * The proposed assignee is not a member of the project's workspace (Subtask
 * 1.4.4). Guards createWorkItem / updateWorkItem / assignWorkItem — you
 * cannot assign an issue to someone outside its tenant. Un-assigning (null
 * assignee) skips this check.
 */
export class AssigneeNotInWorkspaceError extends WorkItemError {
  readonly tag = 'ASSIGNEE_NOT_IN_WORKSPACE' as const;
  readonly code = 'ASSIGNEE_NOT_IN_WORKSPACE' as const;
  constructor(message = 'The assignee is not a member of this workspace.') {
    super(message);
    this.name = 'AssigneeNotInWorkspaceError';
  }
}

/**
 * The target status key isn't one of the project's workflow statuses (Subtask
 * 2.2.4). Thrown by updateStatus (the move target) and by createWorkItem when
 * a caller supplies an explicit status that the project's workflow doesn't
 * define. A client error → 422.
 */
export class UnknownStatusError extends WorkItemError {
  readonly tag = 'UNKNOWN_STATUS' as const;
  readonly code = 'UNKNOWN_STATUS' as const;
  readonly statusKey: string;
  constructor(statusKey: string) {
    super(`Unknown status "${statusKey}" for this project's workflow.`);
    this.name = 'UnknownStatusError';
    this.statusKey = statusKey;
  }
}

/**
 * The requested status move is not a legal transition under the project's
 * workflow (Subtask 2.2.4) — `restricted` mode with no `workflow_transition`
 * row connecting the (from, to) pair. The message names the offending pair.
 * A client error → 422.
 */
export class IllegalTransitionError extends WorkItemError {
  readonly tag = 'ILLEGAL_TRANSITION' as const;
  readonly code = 'ILLEGAL_TRANSITION' as const;
  readonly fromKey: string;
  readonly toKey: string;
  constructor(fromKey: string, toKey: string) {
    super(`Illegal status transition: "${fromKey}" → "${toKey}".`);
    this.name = 'IllegalTransitionError';
    this.fromKey = fromKey;
    this.toKey = toKey;
  }
}

/**
 * Optimistic-concurrency conflict (Subtask 2.3.6): the edit form submitted the
 * `updatedAt` it read at render time, and by commit the row's `updatedAt` had
 * moved — someone else edited the issue in between. A client error → 409. The
 * UI surfaces "this issue was edited by someone else — refresh and retry";
 * last-write-wins is the shipped behavior, but the user sees the conflict
 * instead of silently clobbering the other edit.
 */
export class StaleWorkItemError extends WorkItemError {
  readonly tag = 'STALE_WORK_ITEM' as const;
  readonly code = 'STALE_WORK_ITEM' as const;
  constructor() {
    super('This issue was edited by someone else. Refresh and try again.');
    this.name = 'StaleWorkItemError';
  }
}

/**
 * A `type` / `executor` was set on a work item whose `kind` is a CONTAINER
 * (epic / story), not an executable leaf (Story 2.7 · Subtask 2.7.3). `type`
 * is the nature of executable work and is leaf-only by the 2.7.2 ADR; epics
 * and stories organise work, they don't execute it. A client error → 422
 * (the route layer's blanket `WorkItemError` mapping). There is no DB-trigger
 * backstop for this rule (a single nullable column can't express "only on
 * these kinds"), so this service-layer assertion is the primary guard.
 */
export class TypeNotAllowedOnKindError extends WorkItemError {
  readonly tag = 'TYPE_NOT_ALLOWED_ON_KIND' as const;
  readonly code = 'TYPE_NOT_ALLOWED_ON_KIND' as const;
  constructor(kind: string) {
    super(`A ${kind} cannot carry a type or executor (those are leaf-only).`);
    this.name = 'TypeNotAllowedOnKindError';
  }
}

/**
 * A `difficulty` would END UP on a work item whose `kind` is a CONTAINER (epic /
 * story) — Story MOTIR-6016 · MOTIR-6096. Leaf-only by the same `isTypeableKind`
 * predicate as {@link TypeNotAllowedOnKindError}, but its OWN code: a caller
 * that sent a difficulty and is told that TYPE is not allowed is told something
 * false. Covers a `kind` change onto a container that keeps a difficulty, not
 * only a direct write. A client error → 422 (the blanket `WorkItemError`
 * mapping); like `type`, no DB constraint backs it.
 */
export class DifficultyNotAllowedOnKindError extends WorkItemError {
  readonly tag = 'DIFFICULTY_NOT_ALLOWED_ON_KIND' as const;
  readonly code = 'DIFFICULTY_NOT_ALLOWED_ON_KIND' as const;
  constructor(kind: string) {
    super(`A ${kind} cannot carry a difficulty (it is leaf-only).`);
    this.name = 'DifficultyNotAllowedOnKindError';
  }
}

/**
 * An `obsolescence` value OUTSIDE the closed `WorkItemObsolescence` enum reached
 * the service — Story MOTIR-6574 · MOTIR-6579. The shape of
 * {@link DifficultyNotAllowedOnKindError} WITHOUT a kind: the mark is kind- and
 * status-agnostic, so the only way to write it wrong is an unknown member. The
 * wire schemas narrow the value first; this is the service's own backstop so a
 * caller that bypasses them (an internal path, a loosely-typed body) still writes
 * nothing. A client error → 422 (the blanket `WorkItemError` mapping).
 */
export class InvalidObsolescenceError extends WorkItemError {
  readonly tag = 'INVALID_OBSOLESCENCE' as const;
  readonly code = 'INVALID_OBSOLESCENCE' as const;
  constructor(value: unknown) {
    super(
      `${JSON.stringify(value) ?? String(value)} is not an obsolescence (expected "outdated", "deprecated" or null).`,
    );
    this.name = 'InvalidObsolescenceError';
  }
}

/**
 * A recorded content language outside the eleven locales (Story MOTIR-7731 ·
 * MOTIR-8096) — `lib/i18n/locales.ts` is the list. A client error → 422 (the
 * blanket `WorkItemError` mapping), raised before anything is written.
 */
export class InvalidWorkItemLanguageError extends WorkItemError {
  readonly tag = 'INVALID_CONTENT_LANGUAGE' as const;
  readonly code = 'INVALID_CONTENT_LANGUAGE' as const;
  constructor(value: unknown) {
    super(`${JSON.stringify(value) ?? String(value)} is not a supported content language.`);
    this.name = 'InvalidWorkItemLanguageError';
  }
}

/**
 * An `outdated` / `deprecated` mark would be SET on a work item whose status sits
 * OUTSIDE the project's `done` category — Story MOTIR-6575 · MOTIR-6672. Both
 * marks are a FINISHED card's state (`canCarryObsolescence`), so a card nobody
 * will finish is archived, not marked. Clearing a mark (`null`) is never refused,
 * and neither is a patch that leaves the mark untouched. A client error → 422
 * (the blanket `WorkItemError` mapping).
 */
export class ObsolescenceRequiresFinishedError extends WorkItemError {
  readonly tag = 'OBSOLESCENCE_REQUIRES_FINISHED' as const;
  readonly code = 'OBSOLESCENCE_REQUIRES_FINISHED' as const;
  /** The card's `KEY-n`. */
  readonly key: string;
  /** The status the card is at (or is being created at). */
  readonly statusKey: string;
  /** That status's category — never `done`, or the mark would be legal. */
  readonly statusCategory: string | null;
  constructor(args: { key: string; statusKey: string; statusCategory: string | null }) {
    super(
      `${args.key} is at ${args.statusKey}: only a finished work item can be marked outdated or ` +
        'deprecated. A work item nobody will finish is archived, not marked.',
    );
    this.name = 'ObsolescenceRequiresFinishedError';
    this.key = args.key;
    this.statusKey = args.statusKey;
    this.statusCategory = args.statusCategory;
  }
}

/**
 * A MARKED work item would be REOPENED — Story MOTIR-6575 · MOTIR-6672. A card
 * carrying `outdated` or `deprecated` stays finished: a move to any status
 * outside the `done` category is refused, for a person and for Motir's own
 * system movers alike, and so is new work under it (a child created or
 * re-parented beneath it), which would reopen it through status derivation. A
 * move WITHIN the done category (`done ↔ cancelled`) is untouched. Cleared by a
 * person clearing the mark, so a REFUSAL in `STATUS_TRANSITION_REFUSALS`, never
 * a fault. A client error → 422 (the blanket `WorkItemError` mapping).
 */
export class MarkedCardCannotReopenError extends WorkItemError {
  readonly tag = 'MARKED_CARD_CANNOT_REOPEN' as const;
  readonly code = 'MARKED_CARD_CANNOT_REOPEN' as const;
  /** The MARKED card's `KEY-n` — the parent, when the refused write is a child. */
  readonly key: string;
  /** Its mark. */
  readonly obsolescence: 'outdated' | 'deprecated';
  /** The status the refused move targeted, or null for a refused child write. */
  readonly toStatusKey: string | null;
  constructor(args: {
    key: string;
    obsolescence: 'outdated' | 'deprecated';
    toStatusKey: string | null;
    /** Set when the refused write is a CHILD created or moved under the card. */
    childKey?: string | null;
  }) {
    super(
      args.toStatusKey === null
        ? `${args.key} is marked ${args.obsolescence}: a new child${args.childKey ? ` (${args.childKey})` : ''} ` +
            'would reopen it. Clear the mark to reopen this item.'
        : `${args.key} is marked ${args.obsolescence}: clear the mark to reopen this item.`,
    );
    this.name = 'MarkedCardCannotReopenError';
    this.key = args.key;
    this.obsolescence = args.obsolescence;
    this.toStatusKey = args.toStatusKey;
  }
}

/**
 * A work item still in TRIAGE (`triagedAt` set) would be placed into the planned
 * tree — bug MOTIR-11339. A triage submission lives OUTSIDE the planned tree until
 * a person accepts it (the triage-model decision, MOTIR-399), and every normal
 * read hides it (`triagedAt IS NULL`). So filing it into a folder, re-parenting it
 * under a card, or hanging a new child under it would put work where nobody can
 * see it: the card, and everything under it, stays invisible on the canvas and in
 * every list until somebody happens to press Accept.
 *
 * `role` says which end of the write is in triage: `item` — the card being filed
 * or moved; `parent` — the card a child would be created or moved under. Accept in
 * Triage is the one way out (`triageService`), and it clears the marker, after
 * which the same write succeeds. A state conflict the person resolves → 409 on
 * `/api/v1`; the blanket `WorkItemError` mapping everywhere else.
 */
export class WorkItemInTriageError extends WorkItemError {
  readonly tag = 'WORK_ITEM_IN_TRIAGE' as const;
  readonly code = 'WORK_ITEM_IN_TRIAGE' as const;
  /** The `KEY-n` of the card that is still in triage. */
  readonly key: string;
  /** Which end of the refused write is in triage. */
  readonly role: 'item' | 'parent';
  constructor(args: { key: string; role: 'item' | 'parent' }) {
    super(
      args.role === 'item'
        ? `${args.key} is still in Triage, so it cannot be filed into a folder or placed under ` +
            'another work item. Accept it in Triage first.'
        : `${args.key} is still in Triage, so no work item can be created or placed under it. ` +
            'Accept it in Triage first.',
    );
    this.name = 'WorkItemInTriageError';
    this.key = args.key;
    this.role = args.role;
  }
}

/**
 * Epic privacy (Story 6.14 · `publicChildrenHidden`) was set on a non-epic work
 * item. The flag is meaningful ONLY for an epic-kind item (ADR §1) — hiding "an
 * epic's children + aggregate tells" has no meaning on a story/task/subtask. The
 * write layer (`setEpicPrivacy`) REJECTS rather than silently coercing to a
 * no-op, so a caller bug surfaces instead of returning a misleading 200. The
 * route maps this to 422 (a malformed-for-this-target request).
 */
export class NotEpicError extends WorkItemError {
  readonly tag = 'NOT_EPIC' as const;
  readonly code = 'NOT_EPIC' as const;
  constructor(kind: string) {
    super(`Epic privacy can only be set on an epic — this work item is a ${kind}.`);
    this.name = 'NotEpicError';
  }
}

/**
 * A work item's `targetRepo` (Story 7.9 · MOTIR-1804) named a repo that is NOT
 * in the workspace's CONNECTED set. The connected set (the 7.10.3 installation
 * mirror) is the single repo registry — validating against it is what keeps a
 * pin meaningful, since the CLI resolves the stored name to a checkout directory
 * and an unknown name can only ever resolve to a path that does not exist.
 * REJECTED rather than stored-as-typed: a silent bad pin surfaces much later, as
 * an agent dispatched into the wrong (or a missing) working tree. A client error
 * → 422 (the route layer's blanket `WorkItemError` mapping); over MCP it is a
 * clean tool error the agent self-corrects from, so the message NAMES the
 * connected set.
 */
/**
 * WHICH domain a rejected pin was checked against (MOTIR-1783) — the project's
 * own repository SET (`project_repository`) when it has one, else the workspace's
 * connected repos. It changes only the MESSAGE, but that message is the whole
 * value of the error: told the wrong set, the author corrects the wrong thing.
 */
export type UnknownTargetRepoScope = 'workspace' | 'project';

export class UnknownTargetRepoError extends WorkItemError {
  readonly tag = 'UNKNOWN_TARGET_REPO' as const;
  readonly code = 'UNKNOWN_TARGET_REPO' as const;
  constructor(
    repoName: string,
    connectedRefs: string[],
    scope: UnknownTargetRepoScope = 'workspace',
  ) {
    const empty =
      scope === 'project'
        ? `Unknown target repo "${repoName}" — this project's repository set is empty. ` +
          'Add the repository to the project first, or leave targetRepo unset.'
        : `Unknown target repo "${repoName}" — this workspace has no connected repositories. ` +
          'Connect the repo first, or leave targetRepo unset.';
    const known =
      scope === 'project'
        ? `Unknown target repo "${repoName}". This project's repositories: ${connectedRefs.join(', ')}.`
        : `Unknown target repo "${repoName}". Connected repositories: ${connectedRefs.join(', ')}.`;
    super(connectedRefs.length === 0 ? empty : known);
    this.name = 'UnknownTargetRepoError';
  }
}

/**
 * A write supplied BOTH `targetRepo` and `targetRepos` (Story MOTIR-2725 ·
 * MOTIR-2727, ADR `docs/decisions/work-item-repository-set.md` §3.4).
 *
 * The scalar is the PRIMARY of the set — `targetRepos[0] ?? null` — and is
 * derived, never independently writable. A caller that sends both is describing
 * the same fact twice, and the two descriptions can disagree.
 *
 * A REFUSAL rather than a precedence rule, and that is the whole decision. "The
 * array wins" is the obvious alternative and it is silent: the losing value is a
 * repository the caller believed they had recorded, dropped with no signal on a
 * field whose entire job is to say where work ships. There is also no case that
 * needs both — a caller who wants a one-element set sends either field.
 *
 * A `WorkItemError`, so the route layer maps it to 422 and an MCP caller sees a
 * self-correctable tool error naming both fields rather than an opaque 500.
 */
export class ConflictingTargetRepoInputError extends WorkItemError {
  readonly tag = 'CONFLICTING_TARGET_REPO_INPUT' as const;
  readonly code = 'CONFLICTING_TARGET_REPO_INPUT' as const;
  constructor() {
    super(
      'Send exactly ONE of targetRepo, targetRepos or targetRepositories — targetRepo is the ' +
        'FIRST element of targetRepos, and both are the resolved NAMES of targetRepositories, ' +
        'so supplying more than one describes the same field twice. Use targetRepositories to ' +
        'pin repository ROWS, targetRepos for names, and either field for a single repository.',
    );
    this.name = 'ConflictingTargetRepoInputError';
  }
}

/**
 * A write tried to set the repositories of a CONTAINER (Story MOTIR-2732 ·
 * MOTIR-2978, ADR "Amendment 2026-08-18" §A6).
 *
 * A container never authors its repositories — they are the UNION of its
 * non-archived leaf descendants', recomputed on every write that can move one.
 * So a value supplied here is not merely redundant: the next recompute erases it,
 * and the caller has no way to know that happened.
 *
 * **A REFUSAL rather than accept-and-ignore, and that is the decision.** Ignoring
 * it is the tempting option because the field is already read-only on both
 * surfaces, so "nobody sends this" — but a silent accept is exactly the shape
 * §3.4 rejected for the both-fields case: the losing value is a decision the
 * caller believed they had recorded, dropped with no signal, on the field whose
 * whole job is to say where work ships.
 *
 * A `WorkItemError`, so the route layer maps it to 422 and an MCP caller sees a
 * self-correctable tool error naming the leaf as the place to pin.
 */
export class ContainerRepoSetNotWritableError extends WorkItemError {
  readonly tag = 'CONTAINER_REPO_SET_NOT_WRITABLE' as const;
  readonly code = 'CONTAINER_REPO_SET_NOT_WRITABLE' as const;
  constructor() {
    super(
      "A container's repositories are DERIVED — the union of its subtasks' — so they cannot be " +
        'set directly. Pin the repository on the subtask that ships in it, and the story, task or ' +
        'epic above it picks it up automatically.',
    );
    this.name = 'ContainerRepoSetNotWritableError';
  }
}

/**
 * A write named a `project_repository` ROW that is not one of the item's OWN
 * project's repositories (Story MOTIR-2732 · MOTIR-3039, ADR
 * `docs/decisions/work-item-repository-set.md` "Amendment 2026-08-18" §A2).
 *
 * The reference counterpart of {@link UnknownTargetRepoError}, and it exists for
 * the same reason that one does even though a foreign key now backs the column:
 * **the foreign key cannot see this.** `project_repository.project_id` and
 * `work_item.project_id` are two columns nothing relates, so a row belonging to a
 * SIBLING project of the same workspace satisfies the constraint perfectly while
 * pinning the card to a repository that has nothing to do with it — exactly the
 * defect `docs/decisions/target-repo-attribution.md`'s 2026-07-30 amendment made
 * a typed error for the NAME path. Moving the pin from a string to an id does not
 * move that check into the database; it moves it onto an id.
 *
 * ONE error for "no such row" and "another project's row", deliberately, matching
 * `projectAccessService`'s no-existence-leak posture: a caller learns which
 * repositories this project HAS, and nothing about which ones it does not.
 *
 * A `WorkItemError`, so the route layer maps it to 422 and an MCP caller sees a
 * self-correctable tool error naming the project's rows rather than an opaque 500.
 */
export class UnknownProjectRepoRefError extends WorkItemError {
  readonly tag = 'UNKNOWN_PROJECT_REPO_REF' as const;
  readonly code = 'UNKNOWN_PROJECT_REPO_REF' as const;
  constructor(ref: string, knownRefs: readonly string[]) {
    super(
      knownRefs.length === 0
        ? `Unknown repository reference "${ref}" — this project has no repository set. ` +
            'Add the repository to the project first, or leave targetRepositories unset.'
        : `Unknown repository reference "${ref}". This project's repositories: ${knownRefs.join(', ')}.`,
    );
    this.name = 'UnknownProjectRepoRefError';
  }
}

/**
 * The repository an item's dispatch resolved to is ARCHIVED on the host
 * (MOTIR-1959) — read-only, so no branch and no pull request can be opened
 * against it, by an admin or by anyone else.
 *
 * DISTINCT from {@link UnknownTargetRepoError}, which is a typo or a
 * wrong-project name at AUTHORING time. This one fires at DISPATCH, about a name
 * that is entirely correct and a repository that plainly exists — what changed is
 * the repository, usually long after the item was written. Conflating the two
 * would tell the user to fix the pin, which is the one thing that will not help.
 *
 * The message names the repository AND the reason AND where the fix is, because
 * the fix is not in Motir: only someone with admin on the host can un-archive it,
 * so an error that merely says "cannot dispatch" leaves the reader with nothing
 * to do. A `WorkItemError`, so the route layer maps it to 422 and an MCP caller
 * sees a self-correctable tool error rather than an opaque 500.
 */
export class ArchivedTargetRepoError extends WorkItemError {
  readonly tag = 'ARCHIVED_TARGET_REPO' as const;
  readonly code = 'ARCHIVED_TARGET_REPO' as const;
  constructor(repoName: string, repoRef: string) {
    super(
      `Target repo "${repoName}" (${repoRef}) is archived on the host, so it is read-only — ` +
        'no branch or pull request can be opened against it. Un-archive it, or point this work ' +
        "at a different repository in the project's set.",
    );
    this.name = 'ArchivedTargetRepoError';
  }
}

/**
 * A `type: 'deploy'` work item was moved into a `done`-category status while no
 * comment on it records what got published (MOTIR-2709;
 * `lib/workItems/artifactEvidence.ts` carries the rule and its evidence).
 *
 * A client error → 422. The message TEACHES rather than merely refusing: it
 * names the three accepted forms and the declared exemption, so the person who
 * hits it can satisfy it in one hop instead of guessing what "evidence" means.
 * That matters more here than on most refusals — this is the one gate that fires
 * at the moment somebody has decided they are finished.
 */
export class MissingArtifactEvidenceError extends WorkItemError {
  readonly tag = 'MISSING_ARTIFACT_EVIDENCE' as const;
  readonly code = 'MISSING_ARTIFACT_EVIDENCE' as const;
  readonly statusKey: string;
  constructor(statusKey: string) {
    super(
      `A "deploy" work item cannot reach "${statusKey}" until a comment on it records the ` +
        'artifact it published — a version (1.4.0), a registry digest (sha256:…) or an ' +
        'integrity hash (sha512-…). If this deliverable genuinely has no identifier (a DNS ' +
        'cutover, a console toggle), say so in a comment beginning "NO ARTIFACT:" followed by ' +
        'the reason.',
    );
    this.name = 'MissingArtifactEvidenceError';
    this.statusKey = statusKey;
  }
}

/**
 * A CONTAINER was moved into a status that CLAIMS its work is built —
 * `implemented` or `in_review` — while at least one of its own live children has
 * not reached `implemented` (Bug MOTIR-3229;
 * `lib/workItems/statusLadder.ts` carries the bar and its reasoning).
 *
 * A client error → 422. The message NAMES the open children, because the whole
 * failure this closes is that nobody looked at the child set: MOTIR-1343 claimed
 * `implemented`, then In Review, then Done over two `todo` children, opened and
 * merged a pull request on that claim, and the merge's downward cascade closed
 * both of them. An error that merely says "children are open" leaves the reader
 * to go and find which; one that lists them is actionable in one hop.
 *
 * ⚠️ NOT an `IllegalTransitionError`, deliberately. The transition IS legal —
 * the project's workflow allows it and would allow it again the moment the
 * children land. What is refused is the CLAIM, and a caller told "no such
 * workflow transition" would go and edit their workflow. Same argument
 * `MISSING_ARTIFACT_EVIDENCE` makes for being its own third code on this
 * sub-resource rather than a flavour of the other two.
 */
export class ContainerHasOpenChildrenError extends WorkItemError {
  readonly tag = 'CONTAINER_HAS_OPEN_CHILDREN' as const;
  readonly code = 'CONTAINER_HAS_OPEN_CHILDREN' as const;
  readonly statusKey: string;
  /** The identifiers of the children that have not reached the bar. */
  readonly openChildren: readonly string[];
  constructor(statusKey: string, openChildren: readonly string[]) {
    const named = openChildren.slice(0, 5).join(', ');
    const rest = openChildren.length > 5 ? ` (+${openChildren.length - 5} more)` : '';
    super(
      `This item cannot reach "${statusKey}" while ${openChildren.length} of its children ` +
        `${openChildren.length === 1 ? 'has' : 'have'} not been implemented: ${named}${rest}. ` +
        'A parent at that status claims everything under it is built, and its pull request is ' +
        'opened on that claim. Land the children, re-parent them out if they are no longer in ' +
        'scope, or move this item to Done — which completes them deliberately rather than as a ' +
        'side effect.',
    );
    this.name = 'ContainerHasOpenChildrenError';
    this.statusKey = statusKey;
    this.openChildren = openChildren;
  }
}

/**
 * THE APPROVAL-GATE GUARD's refusal (Story MOTIR-4887 · Subtask MOTIR-5526; ADR
 * `docs/decisions/approval-gates.md` §6d AMENDMENT, rules 1–5).
 *
 * A work item carries an `awaiting` approval gate whose kind OWNS the status this
 * move targets — the status approving that gate would itself write. Moving there
 * by hand would skip the decision, so the move is refused and every other move
 * stays legal.
 *
 * ⚠️ ITS OWN CODE, NOT `ILLEGAL_TRANSITION`. The edge IS legal: a caller told
 * otherwise goes and edits their workflow, which fixes nothing. The fix is to
 * decide the gate, and only this code can say so — the same argument
 * {@link ContainerHasOpenChildrenError} makes for its own.
 *
 * Kind-agnostic: it names the gate's kind and never assumes it is a design. The
 * doors enrich it into the render payload (`{ itemKey, kind, canDecide,
 * routedToLabel }`) through `approvalGatesService.describePendingRefusal`, AFTER
 * the refused transaction has rolled back — which is why it carries ids rather
 * than the payload itself.
 */
export class ApprovalGatePendingError extends WorkItemError {
  readonly tag = 'APPROVAL_GATE_PENDING' as const;
  readonly code = 'APPROVAL_GATE_PENDING' as const;
  readonly statusKey: string;
  /** The awaiting gate being waited on, or null when the item's pull request is
   *  open and no gate has been raised yet (rule 2b). */
  readonly gateId: string | null;
  readonly gateKind: string;
  /** The work item's `KEY-n`, for a message and a link a person can follow. */
  readonly itemKey: string;
  readonly workItemId: string;
  /**
   * WHAT the held move is waiting for (ADR §6d AMENDMENT, rule 2b):
   * - `decision` — the gate is `awaiting`, and approving it makes this move;
   * - `merge` — the item has an OPEN delivering pull request, so the MERGE is the
   *   one writer of this status (rule 2b).
   */
  readonly waitingOn: 'decision' | 'merge';
  constructor(args: {
    statusKey: string;
    gateId: string | null;
    gateKind: string;
    itemKey: string;
    workItemId: string;
    waitingOn?: 'decision' | 'merge';
  }) {
    const kindLabel = args.gateKind.replace(/_/g, ' ');
    super(
      args.waitingOn === 'merge'
        ? `${args.itemKey} cannot be moved to "${args.statusKey}" directly: it has an open ` +
            'pull request, and merging it is what makes this move. Approve and merge the pull ' +
            'request, or move the item somewhere else — only this move is held.'
        : `${args.itemKey} cannot be moved to "${args.statusKey}" directly: a ${kindLabel} ` +
            'approval is waiting on it, and approving that decision is what makes this move. ' +
            'Decide it in Motir, or move the item somewhere else — only this one move is held.',
    );
    this.waitingOn = args.waitingOn ?? 'decision';
    this.name = 'ApprovalGatePendingError';
    this.statusKey = args.statusKey;
    this.gateId = args.gateId;
    this.gateKind = args.gateKind;
    this.itemKey = args.itemKey;
    this.workItemId = args.workItemId;
  }
}

/**
 * THE PLAN HOLD's refusal (Story MOTIR-6017 · Subtask MOTIR-6265;
 * `docs/decisions/agent-authored-plans.md` AMENDMENT 21 §2).
 *
 * The work item sits at `planning` under an UNDECIDED plan's lock — the plan is
 * rewriting it — so no hand move out of `planning` is the person's to make until
 * the plan is decided. EVERY target is refused, not one: where an approval gate
 * owns one status ({@link ApprovalGatePendingError}), an open plan owns them all.
 *
 * ⚠️ ITS OWN CODE, for the reason the gate's has one: the edge is legal, and the
 * way out is to decide the plan (or withdraw the proposal naming the card), which
 * only this code can say.
 *
 * Unlike the gate's refusal it carries its WHOLE render payload: every field is
 * read on the refused transaction under the item lock the funnel already holds,
 * and `sessionId` + `anchorKey` are exactly what `planRowDestination` needs to
 * send the surface's Review plan door where the plan is (§2's table). No
 * enrichment read follows.
 */
export class PlanTargetHeldError extends WorkItemError {
  readonly tag = 'PLAN_TARGET_HELD' as const;
  readonly code = 'PLAN_TARGET_HELD' as const;
  /** The status the refused move targeted. */
  readonly statusKey: string;
  /** The held card's `KEY-n`. */
  readonly itemKey: string;
  readonly workItemId: string;
  /** The whole hold — a PLAN's, or an open SESSION's (AMENDMENT 23 §5). */
  readonly hold: PlanHoldDTO;
  constructor(args: { statusKey: string } & PlanHoldDTO) {
    const { statusKey, ...hold } = args;
    super(
      hold.kind === 'session'
        ? `${hold.itemKey} cannot be moved out of Planning while a planning conversation holds it: ` +
            'the card is being planned, so its status stays Planning until that conversation ends.'
        : `${hold.itemKey} cannot be moved out of Planning while a plan is open: the plan is ` +
            'rewriting this item, so its status is the plan’s until the plan is decided. Approve or ' +
            'decline the plan, or withdraw the proposal that names this item.',
    );
    this.name = 'PlanTargetHeldError';
    this.statusKey = statusKey;
    this.itemKey = hold.itemKey;
    this.workItemId = hold.workItemId;
    this.hold = hold as PlanHoldDTO;
  }

  /** The plan holding it, or null for a session hold. */
  get planId(): string | null {
    return this.hold.planId;
  }

  /** The plan's undecided status, or null for a session hold. */
  get planStatus(): PlanHoldDTO['planStatus'] {
    return this.hold.planStatus;
  }

  /** The holding session — the plan's, or the session that holds it. */
  get sessionId(): string | null {
    return this.hold.sessionId;
  }

  get anchorKey(): string | null {
    return this.hold.anchorKey;
  }

  /** The wire payload every door returns under `plan` — AMENDMENT 21 §2's table,
   *  with AMENDMENT 23 §5's session form. */
  get payload(): PlanHoldDTO {
    return this.hold;
  }
}

/**
 * A project has no initial workflow status (Subtask 2.2.4) — a corrupt/missing
 * seed. This is a SERVER INVARIANT violation, not a client error: every
 * project is seeded with exactly one initial status at creation (2.2.2). So it
 * is deliberately NOT a `WorkItemError` (the route layer blanket-maps those to
 * 422); it propagates unhandled → 500, the right signal for "the data is in a
 * state that should be impossible."
 */
export class NoInitialStatusError extends Error {
  readonly code = 'NO_INITIAL_STATUS' as const;
  constructor(projectId: string) {
    super(`Project ${projectId} has no initial workflow status (corrupt seed).`);
    this.name = 'NoInitialStatusError';
  }
}

/**
 * motir-ai returned a vector whose length is not the pinned column dimension
 * (Story MOTIR-2694 · Subtask MOTIR-2696).
 *
 * Like {@link NoInitialStatusError} this is a SERVER INVARIANT violation, not a
 * client error, so it is deliberately not a `WorkItemError`: both sides of the
 * boundary pin N = 1536 from the same decision record
 * (`motir-ai`'s `docs/decisions/embedding-provider.md`), so a disagreement means
 * one of them was re-configured without the other.
 *
 * It is raised BEFORE the write rather than left to Postgres because the failure
 * modes are not equivalent. `vector(1536)` would reject a wrong-length literal
 * with a raw cast error naming neither the item nor the model — and, worse, a
 * future widening of the column would let a mismatched vector land silently and
 * rank against incomparable neighbours forever. The embedding job treats it as
 * terminal: retrying a mis-configured provider cannot help, and the item stays
 * "not yet a candidate", which is never an error to a user (ADR §6.3.5).
 */
export class EmbeddingDimensionMismatchError extends Error {
  readonly code = 'EMBEDDING_DIMENSION_MISMATCH' as const;
  constructor(
    readonly expected: number,
    readonly received: number,
    readonly model: string,
  ) {
    super(
      `Model ${model} returned a ${received}-dimension vector; the work_item_embedding ` +
        `column is vector(${expected}).`,
    );
    this.name = 'EmbeddingDimensionMismatchError';
  }
}
