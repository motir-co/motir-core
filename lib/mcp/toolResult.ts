import { OrgFeatureDisabledError } from '@/lib/featureFlags/errors';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  AssigneeNotInWorkspaceError,
  CrossProjectParentError,
  DepthLimitExceededError,
  IllegalParentTypeError,
  IllegalTransitionError,
  MissingArtifactEvidenceError,
  ContainerHasOpenChildrenError,
  ApprovalGatePendingError,
  PlanTargetHeldError,
  ParentCycleError,
  ReporterNotInWorkspaceError,
  TypeNotAllowedOnKindError,
  DifficultyNotAllowedOnKindError,
  InvalidObsolescenceError,
  MarkedCardCannotReopenError,
  ObsolescenceRequiresFinishedError,
  UnknownStatusError,
  ContainerRepoSetNotWritableError,
  UnknownProjectRepoRefError,
  UnknownTargetRepoError,
  WorkItemKeyConflictError,
  WorkItemNotFoundError,
} from '@/lib/workItems/errors';
import {
  PermissionDeniedError,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';
import { NotAMemberError } from '@/lib/workspaces/errors';
import {
  CrossWorkspaceLinkError,
  SelfLinkError,
  WorkItemLinkCycleError,
  WorkItemLinkNotFoundError,
} from '@/lib/workItems/linkErrors';
import {
  CommentForbiddenError,
  CommentNotFoundError,
  EmptyCommentBodyError,
  InvalidParentCommentError,
  ReplyDepthExceededError,
} from '@/lib/comments/errors';
import { InvalidActivityCursorError } from '@/lib/activity/errors';
import {
  InvalidSectionsError,
  SectionsWithDescriptionError,
  UnknownSectionCellError,
} from '@/lib/workItems/sections/errors';
import { InvalidReadyCursorError } from '@/lib/workItems/readyFilter';
import { FilterValidationError } from '@/lib/filters/errors';
import { InvalidEstimateError } from '@/lib/estimation/errors';
import {
  BulkBatchTooLargeError,
  CannotDeleteActiveSprintError,
  CannotModifyCompletedSprintError,
  CrossProjectSprintAssignmentError,
  InvalidCarryOverTargetError,
  InvalidSprintNameError,
  InvalidSprintTransitionError,
  NoActiveSprintError,
  NotSprintAdminError,
  SprintAlreadyActiveError,
  SprintNotCompletableError,
  SprintNotFoundError,
  SprintNotStartableError,
  SprintWindowInvalidError,
} from '@/lib/sprints/errors';
import {
  DuplicatePlanTargetError,
  InvalidProposalError,
  NoPlanForJobError,
  PlanItemNotFoundError,
  PlanNotFoundError,
  PlanNotGeneratingError,
  InvalidPlanStepError,
  PlanNotInExpectedStatusError,
  UnresolvedPlanRefError,
  PlanNotEditableError,
  PlanRevisionInFlightError,
  PlanProposalReferencedError,
  PlanPersistenceError,
  PlanGrammarError,
  PlanRefGraphError,
  PlanTargetImmutableError,
  PlanRevisionClassificationInvalidError,
  InvalidPlanHistoryCursorError,
  ApprovedShapeVerdictTooManyIdsError,
  ApprovedShapeChildKeyNotAChildError,
} from '@/lib/plans/errors';
import {
  EmptyPlanChangeIntentError,
  EmptyPlanChangeTurnError,
  PlanChangeSessionNotFoundError,
  PlanChangeTurnConflictError,
  PlanSessionNotFoundError,
  PlanSessionEndedError,
  PlanTargetLockedError,
  TooManyPlanChangeTargetsError,
} from '@/lib/planChange/errors';
import { InvalidTargetError } from '@/lib/services/aiPlanEditsService';
import { MotirAiError } from '@/lib/ai/errors';
import {
  AgentRunEventKindNotAllowedError,
  AgentRunNoOpenRunError,
  AgentRunNotClaimedError,
  AgentRunNotYoursError,
  AgentRunReportInvalidError,
  ContinueFromInvalidError,
  ContinueRunRefusedError,
  DiscrepancyAlreadyRecordedError,
  DispatchRunNotFoundError,
  RepairRunRefusedError,
  RunDiscrepancyInvalidError,
  RunFoundReportReasonInvalidError,
} from '@/lib/dispatchRuns/errors';
import { CiCreditsExhaustedError } from '@/lib/ciMetering/errors';
import { AttachmentError } from '@/lib/blob/errors';
import { DesignEvidenceError } from '@/lib/designEvidence/errors';
import { DecisionPageError } from '@/lib/decisionPages/errors';
import { TestInstructionsError } from '@/lib/testInstructions/errors';
import { PageError, PageRevisionConflictError, PageTreeError } from '@/lib/pages';
import { PageSearchQueryEmptyError, PageSearchQueryTooLongError } from '@/lib/pages/searchErrors';
import {
  EmptyTodoTextError,
  TodoCommandTooLongError,
  TodoNotesTooLongError,
  TodoReorderConflictError,
  TodoTextTooLongError,
  WorkItemTodoNotFoundError,
} from '@/lib/workItemTodos/errors';
import { AcceptanceEvidenceError } from '@/lib/acceptanceEvidence/errors';
import {
  GithubNotConnectedError,
  GithubPullRequestNotFoundError,
  GithubRepoNotFoundError,
} from '@/lib/github/errors';
import { EntitlementExceededError } from '@/lib/billing/errors';
import {
  CrossProjectFolderError,
  FolderCycleError,
  FolderNameTakenError,
  FolderNotFoundError,
  InvalidFolderNameError,
  PlacementConflictError,
  SubtaskNeedsPlacementError,
} from '@/lib/folders/errors';
import type { FilterDecodeResult } from '@/lib/filters/ast';
import { McpMissingContextError } from './context';
import { InvalidSearchCursorError } from './searchCursor';
import type { McpPayload } from './payloads/brand';
import { RATE_LIMITED_CODE } from '@/lib/rateLimit/guard';

// Tool-result helpers (Story 7.8 · Subtask 7.8.4, extended by 7.8.5) — the MCP
// analogue of the route layer's typed-error → HTTP-status mapping.
//
// Two jobs:
//  1. `toolOk` builds the MCP DUAL-CONTENT result every tool returns — a
//     compact human-readable `text` block AND `structuredContent`. Agents parse
//     `structuredContent`; a human watching the session reads the text.
//
//     ⚠️ SUPERSEDED 2026-08-06 (MOTIR-2227 · ADR Amendment 7). This comment used
//     to say: "We deliberately do NOT declare an `outputSchema` on the tools, so
//     `structuredContent` is free-form DTO JSON — the route layer ships these
//     exact DTOs already; re-deriving a zod mirror of every DTO would be
//     duplicate surface for no gain." That was SOUND under Story 7.8's premises:
//     the only routes then were the internal cookie-authenticated ones, and they
//     do pass DTOs through. ADR Amendment 2 (2026-08-03) then pinned that a v1
//     response is a v1 SCHEMA's output and never a DTO passed through, and
//     11.2/11.3 shipped it — so the premise died, and with it the conclusion.
//     `structuredContent` now has a SECOND consumer whose shape is versioned, and
//     a schema two surfaces are checked against is not duplicate surface; it is
//     the only place they meet. (The founding defect: `list_ready` and
//     `search_work_items` carried a `dependencies` block, `get_work_item` did
//     not, invisibly — MOTIR-1849.)
//
//     What Amendment 7 decides, so this file is not read as the old rule:
//      · `structuredContent` DERIVES from the shared `lib/api/v1/*/schema.ts`
//        shapes — every field a v1 resource schema declares appears under the
//        same key with the same value, from the same `present*` mapper the route
//        calls. Extras are a declared `.extend`, omissions a declared
//        `.pick`/`.omit`; a hand-authored look-alike is what is forbidden.
//      · We still do NOT declare the SDK's `outputSchema`, for NEW reasons: it is
//        published in `tools/list` (caller-visible churn on the surface that
//        exists to churn freely) and the SDK VALIDATES against it and THROWS, so
//        a drift would surface as a runtime `McpError` in front of an agent
//        instead of a red build. The guarantee comes from deriving plus the CI
//        drift guard, not from advertising.
//      · Tool names, descriptions, argument shapes and scopes stay MCP's OWN and
//        SHOULD churn. Only the DATA SHAPE — the half with two consumers — is
//        frozen.
//  2. `toToolError` maps the typed service errors to a clean `isError` tool
//     result, preserving the 404-not-403 cross-tenant contract: a missing work
//     item and a cross-tenant one both surface as the SAME "not found" message
//     (the service already throws the same `WorkItemNotFoundError` /
//     `ProjectNotFoundError` for both — no existence leak). Errors we don't
//     recognise are re-thrown so the SDK reports them as a JSON-RPC internal
//     error rather than us inventing a misleading message.
//
// The write tools (7.8.5) add their services' typed errors here so a structural
// failure (bad parent/kind pair, illegal status move, empty comment body, …)
// reads as a clean tool error the agent can self-correct from, never an opaque
// JSON-RPC internal error. `transition_status` catches `IllegalTransitionError`
// at the tool BEFORE `toToolError` so it can enrich the message with the legal
// targets; the entry here is the plain-message fallback.

/**
 * Build a dual-content (text + structuredContent) successful tool result.
 *
 * ⚠️ `structuredContent` is an {@link McpPayload} (MOTIR-2228 · ADR Amendment 7
 * Q4), not a bare object: the ONLY two ways to make one are `derived` (from a
 * declared shared schema) and `exempt` (a tool with no v1 resource to derive
 * from, reason recorded). SEALED by MOTIR-2231 — there is no third column.
 * A tool in neither cannot call this function — which is what makes
 * "every tool's payload derives from a schema" a compile error rather than a
 * review habit, the same way `TOOL_SCOPES` makes an ungated tool one.
 *
 * This constrains the DATA SHAPE only. The `text` block below, the tool's name,
 * its `tools/list` description, its arguments and its scope stay MCP's own and
 * SHOULD churn freely.
 */
export function toolOk(text: string, structuredContent: McpPayload): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent,
  };
}

/**
 * Build an `isError` tool result carrying a stable code + message. Exported so a
 * tool that enriches an error before returning (e.g. `transition_status`'s
 * allowed-targets message) builds the same shape `toToolError` does.
 */
export function toolError(code: string, message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: `${code}: ${message}` }],
    isError: true,
  };
}

/**
 * Build the `isError` result for a RATE-LIMITED tool call (MOTIR-8600): the
 * same text {@link toolError} renders, plus `structuredContent` carrying the
 * retry seconds as a NUMBER, so a client waits without parsing a sentence.
 *
 * The payload is a bare object rather than an {@link McpPayload} on purpose: an
 * error result is validated against no `outputSchema` (the MCP spec applies a
 * tool's declared output schema to successful results only), so there is no
 * shared schema to derive it from and `toolOk`'s brand does not apply. The
 * contract it carries is written once, in `lib/rateLimit/guard.ts`.
 */
export function rateLimitedToolError(retryAfterSeconds: number, message: string): CallToolResult {
  return {
    ...toolError(RATE_LIMITED_CODE, message),
    structuredContent: { code: RATE_LIMITED_CODE, retryAfterSeconds },
  };
}

/** Stable codes for a {@link FilterDecodeResult} failure reason — the codec's
 * version/structure verdict surfaced to an agent (one per `reason`). */
const FILTER_DECODE_CODES: Record<Exclude<FilterDecodeResult, { ok: true }>['reason'], string> = {
  malformed: 'MALFORMED_FILTER',
  'unsupported-version': 'UNSUPPORTED_FILTER_VERSION',
  invalid: 'INVALID_FILTER',
  // Split out of `invalid` by MOTIR-2042 so an over-cap filter reports the same
  // code the registry's `FilterTooLargeError` maps to, on EVERY carrier.
  'too-large': 'FILTER_TOO_LARGE',
};

/**
 * Map a non-`ok` {@link FilterDecodeResult} (a `search_work_items` envelope that
 * fails the SHARED 6.1.1 codec — a foreign version, a non-`v1` envelope, or a
 * structurally-broken shape) to a clean `isError` tool result. The codec
 * returns a typed FAILURE VALUE (it never throws), so this is the decode-path
 * analogue of {@link toToolError}'s thrown-error mapping.
 */
export function toFilterDecodeToolError(
  decoded: Exclude<FilterDecodeResult, { ok: true }>,
): CallToolResult {
  return toolError(FILTER_DECODE_CODES[decoded.reason], decoded.detail);
}

/**
 * Map a thrown service error to an `isError` tool result, or re-throw if it
 * isn't one of the tools' expected typed errors. Every branch surfaces the
 * service's own `code` + `message`, so the contract the routes enforce (and the
 * 404-not-403 cross-tenant rule) carries to the MCP surface unchanged.
 */
export function toToolError(err: unknown): CallToolResult {
  // A per-org kill-switch (MOTIR-750) — the message names the switch, so an
  // agent reports "planning is paused for this organization" rather than retrying.
  if (err instanceof OrgFeatureDisabledError) return toolError(err.code, err.message);
  // 404-not-403: identical message whether the row is absent or cross-tenant.
  if (err instanceof WorkItemNotFoundError || err instanceof ProjectNotFoundError) {
    return toolError(err.code, err.message);
  }
  // 6.4 access gate: a non-browser sees a project-level denial; a read-only
  // member sees the edit denial on a write tool. Both carry their own message.
  if (err instanceof ProjectAccessDeniedError) {
    return toolError(err.code, err.message);
  }
  // The MOTIR-2256 / MOTIR-2291 shared gate's 403: a BROWSER who does not hold
  // the key `assertPermission` asked for. Its message names the key, so an agent
  // refused by `sprint:manage` on `move_to_sprint` is told which permission it
  // lacks rather than seeing an opaque internal error. (A NON-browser never
  // reaches here — the gate raises `ProjectNotFoundError` first, above, which is
  // the no-existence-leak ordering.)
  if (err instanceof PermissionDeniedError) {
    return toolError(err.code, err.message);
  }
  // Write-tool structural / validation errors (7.8.5): create-path kind/parent
  // + membership + key, status transitions, and the comment service's guards.
  if (
    err instanceof UnknownStatusError ||
    err instanceof IllegalTransitionError ||
    // The close-out artifact-evidence gate (MOTIR-2709). This is the surface it
    // most needs to reach: `transition_status` is how an agent closes a card,
    // and the message names the three accepted forms + the declared exemption,
    // so the agent records the digest it already holds instead of seeing an
    // opaque internal error at the last step of a release.
    err instanceof MissingArtifactEvidenceError ||
    // The container-completeness gate (MOTIR-3229). Same surface, same argument:
    // `transition_status` is how an agent moves a container to `implemented` at
    // the end of a run, and the message NAMES the children that are still open —
    // so the agent lands them, re-parents them out, or reports, instead of seeing
    // an opaque internal error at the step it believed was the last one.
    err instanceof ContainerHasOpenChildrenError ||
    // The approval-gate guard (MOTIR-5526). `transition_status` is how an agent
    // closes a card, and the message names the pending decision and says that
    // approving it is what makes the move — so the agent reports the gate rather
    // than retrying or editing a workflow that is not wrong.
    err instanceof ApprovalGatePendingError ||
    // The plan hold (MOTIR-6265). The message says a plan is rewriting the card
    // and that deciding the plan (or withdrawing the proposal naming it) is the
    // way out — so an agent reports the plan instead of retrying the move.
    err instanceof PlanTargetHeldError ||
    // A MARKED card stays finished (MOTIR-6672 · MOTIR-6673). The message names the
    // card and its mark and says to clear the mark first — on `transition_status`,
    // and on `create_work_item` / `update_work_item` / `move_to_parent` for a child
    // under a marked parent — so an agent reports it rather than retrying.
    err instanceof MarkedCardCannotReopenError ||
    err instanceof IllegalParentTypeError ||
    err instanceof DepthLimitExceededError ||
    // Re-parent cycle (move_to_parent, MOTIR-1017): the DB cycle trigger's
    // backstop for an item moved under one of its own descendants. The
    // kind-parent matrix rejects most such moves first (it is strictly
    // hierarchical), but the trigger is the last line of defense, so map it to a
    // clean self-correctable tool error rather than an opaque internal error.
    err instanceof ParentCycleError ||
    err instanceof CrossProjectParentError ||
    err instanceof ReporterNotInWorkspaceError ||
    err instanceof AssigneeNotInWorkspaceError ||
    err instanceof TypeNotAllowedOnKindError ||
    // The difficulty twin (Story MOTIR-6016): a non-null difficulty on an epic or
    // story — or a re-kind onto one that keeps a difficulty. Its own code, so the
    // agent is told which field to clear rather than that TYPE is not allowed.
    err instanceof DifficultyNotAllowedOnKindError ||
    // The OBSOLESCENCE backstop (Story MOTIR-6574 · MOTIR-6582): a value outside
    // `outdated` · `deprecated` that reached the service on create_work_item /
    // update_work_item. The input schema narrows it first; this arm keeps a caller
    // that bypasses it (a direct runner call, a looser future schema) on a typed
    // `INVALID_OBSOLESCENCE` naming the field instead of an opaque internal error.
    err instanceof InvalidObsolescenceError ||
    // …and the FINISHED-card rule (MOTIR-6672 · MOTIR-6673): a mark set on an
    // unfinished card. The message names the card and its status and says to
    // archive instead — a refusal an agent acts on, never an internal error.
    err instanceof ObsolescenceRequiresFinishedError ||
    // Target-repo validation (MOTIR-1804; project-scoped in MOTIR-1783): a
    // `targetRepo` naming a repo outside the item's PROJECT repository set on
    // create_work_item / update_work_item — a workspace-connected repo the
    // project never linked included (MOTIR-4955). The message NAMES the repos of the
    // scope it checked, so the agent self-corrects in one hop instead of
    // guessing — the MCP analogue of the route's 422.
    err instanceof UnknownTargetRepoError ||
    // The reference-model counterpart (MOTIR-3039): a `targetRepositories` element
    // naming a repository row outside the item's project. Its message lists the
    // project's rows as `id (name)`, so the agent self-corrects in one hop — the
    // same contract as the name error above, on an id.
    err instanceof UnknownProjectRepoRefError ||
    // A container's repositories are derived (MOTIR-2978), so a tool call setting
    // them is a mistake the agent can fix in one hop: pin the leaf instead. The
    // message says so, which is why this is a tool error and not a silent no-op.
    err instanceof ContainerRepoSetNotWritableError ||
    // Story-point value validation (7.8.21): a malformed `storyPoints` on
    // create_work_item / update_work_item — out of the Decimal(6, 2) range,
    // negative, or > 2 decimals — surfaces as a clean 422-equivalent tool error
    // the agent can self-correct from, the MCP analogue of the route's 422.
    err instanceof InvalidEstimateError ||
    err instanceof WorkItemKeyConflictError ||
    err instanceof CommentForbiddenError ||
    err instanceof EmptyCommentBodyError ||
    err instanceof InvalidParentCommentError ||
    err instanceof ReplyDepthExceededError ||
    err instanceof CommentNotFoundError
  ) {
    return toolError(err.code, err.message);
  }
  // Attachment tools (MOTIR-3058) — mapped on the ABSTRACT BASE rather than
  // member by member, deliberately. Every `AttachmentError` carries a `code` and
  // every one is something the agent can act on: too large, wrong media type,
  // rate-limited, not found, forbidden, editor-sourced. Enumerating them would
  // mean a subclass added later silently becomes an opaque internal error at the
  // exact moment an agent most needs to be told what to fix — the same failure
  // shape `docs/decisions/attachment-api-door.md` §1 rejects for gates.
  if (err instanceof AttachmentError) {
    return toolError(err.code, err.message);
  }
  // The design-publish door's typed refusals (MOTIR-3782) — mapped on the
  // ABSTRACT BASE for exactly the reason the arm above is, and the stakes are
  // higher here because more of them are reachable in normal use. A container
  // target (`DESIGN_EVIDENCE_NOT_A_LEAF`), a key that is not a child of the
  // declared container (`…NOT_A_CHILD`), an empty asset list, a pathname outside
  // the item's prefix, a blob that never landed and a supersede race all carry a
  // code and a message an agent can act on in one hop. Left unmapped they would
  // surface as an opaque internal error at the end of a design card — the
  // moment the card's whole deliverable is at stake and the agent has the bytes
  // in hand to retry.
  if (err instanceof DesignEvidenceError) {
    return toolError(err.code, err.message);
  }
  // The DECISION-PAGE publish door's named refusals (MOTIR-7434) — on the base,
  // so every refusal reaches the agent by its code (NOT_A_DECISION_CARD,
  // PAGE_IS_EMPTY, CARD_IS_FINISHED, …) rather than as an internal error.
  if (err instanceof DecisionPageError) {
    return toolError(err.code, err.message);
  }
  // The ACCEPTANCE publish door's typed refusals (MOTIR-4704) — mapped on the
  // ABSTRACT BASE for the same reason as the two arms above, and the one that
  // matters most is reachable on an ordinary first attempt: a key that resolves
  // to a container with no story parent (`ACCEPTANCE_EVIDENCE_NOT_A_STORY`,
  // 422). A blob the caller never actually PUT to its grant, a pathname outside
  // the story's own prefix, and a story that takes no receipt right now (closed,
  // or still standing on an approved one — MOTIR-5872) are the others, and each is something the agent can act on in one hop —
  // upload it, use the pathname you were given, stop. Unmapped they would reach
  // the agent as an opaque JSON-RPC internal error at the last step of a run,
  // holding a recording it cannot re-make.
  if (err instanceof AcceptanceEvidenceError) {
    return toolError(err.code, err.message);
  }
  // The HOW TO TEST door's typed refusals (MOTIR-5331) — on the ABSTRACT BASE for
  // the reason the arms above give. A repository outside the project (the message
  // names the valid set), a cap exceeded (naming the field and the limit), a
  // click-path that is both or neither, and a malformed field are each fixable in
  // one hop, and an agent refused with an opaque internal error instead carries on
  // as though its instructions landed.
  // The to-do family (MOTIR-6725) — the three to-do tools reach the shipped
  // `workItemTodosService`, whose refusals are each the caller's to act on: a
  // step id that is not on this card (not-found, the same for a cross-tenant
  // id), and the store's own caps on text, notes and command. Enumerated
  // because `lib/workItemTodos/errors.ts` has no base class. The caps' messages
  // say what to do (split the step; move the notes to a card), which is only
  // worth writing if the sentence reaches the agent rather than a JSON-RPC
  // internal error.
  if (
    err instanceof WorkItemTodoNotFoundError ||
    err instanceof EmptyTodoTextError ||
    err instanceof TodoTextTooLongError ||
    err instanceof TodoNotesTooLongError ||
    err instanceof TodoCommandTooLongError ||
    err instanceof TodoReorderConflictError
  ) {
    return toolError(err.code, err.message);
  }
  if (err instanceof TestInstructionsError) {
    return toolError(err.code, err.message);
  }
  // The page tools (MOTIR-5760). Every refusal `@motir/pages` raises carries its
  // own code — `PAGE_NOT_FOUND` (one message whether the page is unknown or in
  // another project: the 404-not-403 rule), the size caps, the placement rules,
  // and `PAGE_REVISION_CONFLICT`, whose message tells the agent to re-read.
  // A stale `update_page` (MOTIR-7411) is the one an agent must ACT on, so its
  // sentence is an instruction rather than the package's description: the two
  // revisions, and the read-redo-resend loop that resolves it.
  if (err instanceof PageRevisionConflictError) {
    return toolError(
      err.code,
      `The page is at revision ${err.actual}; you sent ${err.expected}. Someone saved since you ` +
        `read it, and nothing was written — call get_page, apply your change to what it ` +
        `returns, and send revision ${err.actual}.`,
    );
  }
  // Page search's query refusals (MOTIR-9553) are not `PageError`s — they live in
  // `lib/pages/searchErrors.ts` — so they are named here, by the same code the REST
  // search route returns. Its cursor refusal is a `PageError` and is covered above.
  if (
    err instanceof PageError ||
    err instanceof PageTreeError ||
    err instanceof PageSearchQueryEmptyError ||
    err instanceof PageSearchQueryTooLongError
  ) {
    return toolError(err.code, err.message);
  }
  // The organization's storage cap. Not an AttachmentError (it is a billing
  // one), but it reaches an agent through the same call and is equally
  // actionable — the message names the entitlement and the limit.
  if (err instanceof EntitlementExceededError) {
    return toolError(err.code, err.message);
  }
  // The pull-request LINK door's typed refusals (MOTIR-3526). All three are
  // things the agent can act on in one hop — name the repository as it is
  // connected, check the number, connect the repository — and all three collapse
  // "absent" and "someone else's" into ONE message, so a cross-workspace probe
  // learns nothing (the 404-not-403 rule, carried onto a coordinate).
  if (
    err instanceof GithubRepoNotFoundError ||
    err instanceof GithubPullRequestNotFoundError ||
    err instanceof GithubNotConnectedError
  ) {
    return toolError(err.code, err.message);
  }
  if (err instanceof InvalidReadyCursorError || err instanceof InvalidSearchCursorError) {
    return toolError(err.code, err.message);
  }
  // `get_work_item_activity` (MOTIR-1999): a hand-edited / foreign composite
  // cursor on the All stream. The route maps it to 400; here it reads as a
  // clean INVALID_ACTIVITY_CURSOR the agent self-corrects from by dropping the
  // cursor and re-reading from the top, rather than an opaque internal error.
  if (err instanceof InvalidActivityCursorError) {
    return toolError(err.code, err.message);
  }
  // Link tools (7.8.13): the work-item-link structural guards — a self-link,
  // a dependency CYCLE, and a cross-workspace link surface verbatim so the agent
  // self-corrects (the message names the violation). `WorkItemLinkNotFoundError`
  // keeps the 404-not-403 contract. A DUPLICATE_LINK never reaches here — the
  // `link_work_items` tool treats it as an idempotent success.
  if (
    err instanceof SelfLinkError ||
    err instanceof WorkItemLinkCycleError ||
    err instanceof CrossWorkspaceLinkError ||
    err instanceof WorkItemLinkNotFoundError
  ) {
    return toolError(err.code, err.message);
  }
  // Sprint tools (7.8.10): the sprint-entity + backlog-association typed errors.
  // `SprintNotFoundError` keeps the 404-not-403 contract (a foreign/unknown
  // sprint is an indistinguishable not-found); the state-machine + admin-gate +
  // window/name + carry-over + bulk-cap errors surface verbatim so an agent can
  // self-correct (e.g. "complete the active sprint first", "only a planned
  // sprint is startable").
  if (
    err instanceof SprintNotFoundError ||
    // validate_sprint (7.8.15): no active sprint + no sprintId → a clean tool
    // error ("plan a sprint / pass a sprintId"), never an opaque 500.
    err instanceof NoActiveSprintError ||
    err instanceof NotSprintAdminError ||
    err instanceof InvalidSprintNameError ||
    err instanceof SprintWindowInvalidError ||
    err instanceof InvalidSprintTransitionError ||
    err instanceof CannotModifyCompletedSprintError ||
    err instanceof CannotDeleteActiveSprintError ||
    err instanceof SprintAlreadyActiveError ||
    err instanceof SprintNotStartableError ||
    err instanceof SprintNotCompletableError ||
    err instanceof InvalidCarryOverTargetError ||
    err instanceof CrossProjectSprintAssignmentError ||
    err instanceof BulkBatchTooLargeError
  ) {
    return toolError(err.code, err.message);
  }
  // `get_section_sets` (MOTIR-9029): a `kind` / `type` that names no cell. The message
  // names the value and lists the legal ones, so the agent corrects it — it is never
  // answered with a default set.
  if (err instanceof UnknownSectionCellError) {
    return toolError(err.code, err.message);
  }
  // `create_work_item` / `update_work_item` with `sections` (MOTIR-9031): a missing,
  // unknown or invalid section is refused BY NAME (the message lists each), and
  // `sections` beside `descriptionMd` is refused before anything is written. Both
  // are the caller's own input, fixable in one hop.
  if (err instanceof InvalidSectionsError || err instanceof SectionsWithDescriptionError) {
    return toolError(err.code, err.message);
  }
  if (err instanceof FilterValidationError) {
    // `search_work_items` (7.8.6): the registry's typed 422 — an unknown
    // field/operator id or a value that fails its (field, operator) arity —
    // surfaced as a clean tool error, the MCP analogue of the route's 422.
    return toolError(err.code, err.message);
  }
  // AI plan-expansion tools (MOTIR-1825). `InvalidTargetError` is the leaf /
  // wrong-project rejection `submitExpand` already throws (a subtask cannot be
  // expanded); the plan-lookup misses keep the 404-not-403 contract. Every
  // motir-ai failure — out of credits, unconfigured, unreachable, a 4xx from the
  // service — is a `MotirAiError` subclass carrying its own code, so the agent
  // reads "OUT_OF_CREDITS" or "AI_UNAVAILABLE" and self-corrects (or gives up
  // honestly) instead of seeing an opaque JSON-RPC internal error.
  if (
    err instanceof InvalidTargetError ||
    err instanceof PlanNotFoundError ||
    err instanceof NoPlanForJobError ||
    err instanceof MotirAiError
  ) {
    return toolError(err.code, err.message);
  }
  // Plan-AUTHORING refusals (MOTIR-3090). The proposal substrate's typed errors
  // reached MCP for the first time with `add_plan_items` and were never mapped,
  // so they fell through to the `throw` below and surfaced as an opaque JSON-RPC
  // internal error — which an agent can only retry blindly. Each one here is
  // ACTIONABLE and says what to do next:
  //   · PLAN_ITEM_NOT_FOUND — that id is not a proposal in this plan (a stale
  //     `planItemIds` entry, or an id from a different plan). 404-not-403 holds:
  //     the service throws the same error for a cross-tenant id.
  //   · PLAN_NOT_IN_EXPECTED_STATUS — the plan has moved on. The message NAMES the
  //     actual status, so `final: true` already sent, or a person already decided
  //     it, reads as TERMINAL rather than as something to retry.
  //   · PLAN_NOT_GENERATING — the append twin of the above, from `addProposals`.
  //   · INVALID_PROPOSAL — a grammar or sizing refusal (an `add`-only rule broken,
  //     points outside the Fibonacci range, a negative estimate). Fixable by the
  //     caller in one hop, which is exactly what an opaque 500 prevented.
  //   · DUPLICATE_PLAN_TARGET (MOTIR-3194) — a second `modify`/`remove` for a work
  //     item the plan already proposes against. The message names the item AND the
  //     two ways out (fold the patches into one proposal; or, for an edge between
  //     items that already exist, `link_work_items`), because what it replaces is
  //     the one refusal on this surface that named neither: Prisma's own
  //     ``Unique constraint failed on the (not available)``, reaching an agent
  //     verbatim through the `throw` at the bottom of this function.
  //   · PLAN_PERSISTENCE_FAILED (MOTIR-3194) — ANY other ORM failure inside the
  //     append, contained at the service boundary. It is still a server-side
  //     failure and still not the caller's fault; the difference is that it now
  //     arrives as a stable code and a sentence rather than as an ORM invocation
  //     trace. Mapped here rather than re-thrown DELIBERATELY: re-throwing is what
  //     put the ORM's prose in front of an agent in the first place.
  if (
    err instanceof PlanItemNotFoundError ||
    err instanceof PlanNotInExpectedStatusError ||
    err instanceof PlanNotGeneratingError ||
    err instanceof InvalidProposalError ||
    // PLAN_STEP_INVALID (MOTIR-7824) — `report_plan_step`'s refusal of a step it
    // cannot record: a target on `settle` / `end`, a ref naming nothing on this
    // plan. The signal is ADVISORY, so an emitter must be able to match the code
    // and carry on, which it cannot do with a JSON-RPC internal error.
    err instanceof InvalidPlanStepError ||
    err instanceof DuplicatePlanTargetError ||
    // UNRESOLVED_PLAN_REF (MOTIR-3539) — an intra-plan `planItem:` ref naming no
    // proposal, now refused AT THE APPEND rather than discovered at approve. It
    // is mapped for the same reason as the rest of this list: it is the caller's
    // own typo, fixable in one hop, and the message names the ref, the proposal
    // and the rule it broke. Unmapped, it fell through to the `throw` at the
    // bottom and reached the agent as a JSON-RPC internal error.
    err instanceof UnresolvedPlanRefError ||
    // PLAN_NOT_EDITABLE / PLAN_PROPOSAL_REFERENCED (MOTIR-3540) — the two
    // refusals the correction door owes an agent. Both name what to do next
    // (`update_work_item` on the materialized card; the referrers to clear
    // first), which is only worth writing if the sentence actually reaches the
    // caller rather than a JSON-RPC internal error.
    err instanceof PlanNotEditableError ||
    err instanceof PlanProposalReferencedError ||
    // PLAN_REVISION_IN_FLIGHT (MOTIR-7988) — `hold_plan_revision`'s `start` while
    // another revision holds the plan. The message names who holds it and until
    // when, which is the retry instruction an agent needs.
    err instanceof PlanRevisionInFlightError ||
    err instanceof PlanPersistenceError ||
    // INVALID_PLAN_REF_GRAPH / PLAN_GRAMMAR_VIOLATION AT THE APPEND (MOTIR-5414).
    // The append now judges a `folder:<id>` placement where it is written — an
    // unknown folder is `dangling`, another project's is `illegal_parent` — and
    // the self-consistency and re-parent gates already threw these two there.
    // Unmapped, every one reached the agent without its code; mapped, the agent
    // reads the same code approve's route returns for the same verdict.
    err instanceof PlanRefGraphError ||
    err instanceof PlanGrammarError ||
    // PLAN_TARGET_IMMUTABLE AT A CORRECTION (Story MOTIR-6577 · MOTIR-6633). A
    // mark-only `modify` of a `done` / `cancelled` card is legal, so the proposal
    // exists; `update_plan_proposal` giving it a non-mark key re-runs the persist
    // gate and is refused here — with its code, as `validate_plan` names it,
    // rather than as a JSON-RPC internal error.
    err instanceof PlanTargetImmutableError ||
    // PLAN_REVISION_CLASSIFICATION_INVALID (MOTIR-5543). Every refusal this one
    // raises names the caller's next move — file the bug first and pass its key,
    // drop the key on a no-bug branch, supply evidence, pass ONE of id/key — and
    // an agent can only act on that sentence if it arrives as a tool error
    // carrying the code, not as a JSON-RPC internal error.
    err instanceof PlanRevisionClassificationInvalidError ||
    // The approved-shape verdict door's three refusals (MOTIR-6227): a
    // `childKeys` entry that is not a child of `key` (named), a set larger than
    // one read answers, and a malformed plan-history cursor. Each is the
    // caller's own input, fixable in one hop, and each must arrive as a code —
    // a verdict read that fails opaquely is one an agent retries or guesses past.
    err instanceof ApprovedShapeChildKeyNotAChildError ||
    err instanceof ApprovedShapeVerdictTooManyIdsError ||
    err instanceof InvalidPlanHistoryCursorError ||
    // RUN_FOUND_REPORT_REASON_INVALID (MOTIR-6286) — `report_unbuildable_target`'s
    // `reason` empty or over 4000 characters once trimmed. The runner's own
    // input, fixable in one hop (send the same text as the card comment); the
    // bound is the SERVICE's, so it must reach the runner as this code rather
    // than as a JSON-RPC internal error.
    err instanceof RunFoundReportReasonInvalidError ||
    // RUN_DISCREPANCY_INVALID / DISCREPANCY_ALREADY_RECORDED (MOTIR-8657) —
    // `record_run_discrepancy`'s points empty, too many or over-long (the message names the
    // point and field), and a second record on a leg that already has one. Each is the
    // runner's own input or its own repeat, fixable in one hop, and must reach it as a code.
    err instanceof RunDiscrepancyInvalidError ||
    err instanceof DiscrepancyAlreadyRecordedError ||
    // REPAIR_RUN_NOT_FOUND / REPAIR_RUN_NOT_YOURS (MOTIR-6807) — a
    // `touch_work_item_repair` / `close_work_item_repair` naming a run that is not
    // the caller's own repair run of that card. Refused before anything is
    // written; the message says to claim first, or that somebody else holds it.
    err instanceof RepairRunRefusedError ||
    // CONTINUE_RUN_NOT_FOUND / CONTINUE_RUN_NOT_YOURS (MOTIR-7262) — the same
    // refusal for `touch_work_item_continue` / `close_work_item_continue`.
    err instanceof ContinueRunRefusedError ||
    // The RUN tools' refusals (MOTIR-7451) — a close of somebody else's run, an
    // event kind an agent may not send in a runner's run, a malformed action, and
    // a run id that is not the caller's agent run on that key. Each is raised
    // before anything is written and names the caller's next move. (A start
    // without the claim and a report with no open run are RESULTS, answered by
    // the tools themselves.)
    err instanceof AgentRunNotYoursError ||
    err instanceof AgentRunEventKindNotAllowedError ||
    err instanceof AgentRunReportInvalidError ||
    err instanceof AgentRunNotClaimedError ||
    err instanceof AgentRunNoOpenRunError ||
    err instanceof DispatchRunNotFoundError ||
    // CONTINUE_FROM_INVALID (MOTIR-7262) — `dispatch_prompt`'s `continueFrom`
    // names a run that cannot be continued: the same code the REST route answers
    // with a 422, so the two doors refuse a bad run identically.
    err instanceof ContinueFromInvalidError
  ) {
    return toolError(err.code, err.message);
  }
  // Plan-change CONVERSATION tools (MOTIR-1832) — the same typed errors the
  // cookie routes map to 404 / 400 / 409, surfaced verbatim so the agent can
  // self-correct in one hop: submit a thread that was never opened
  // (PLAN_CHANGE_SESSION_NOT_FOUND — open it and add a turn), submit one with no
  // turns yet (PLAN_CHANGE_EMPTY_INTENT — say what to change first), an empty
  // turn body, too many anchors, or a lost `seq` race (retryable). The submit
  // path's motir-ai failures are `MotirAiError`s, already mapped above.
  if (
    err instanceof PlanChangeSessionNotFoundError ||
    // A `sessionId` that names no session of this project (MOTIR-6028).
    err instanceof PlanSessionNotFoundError ||
    err instanceof EmptyPlanChangeIntentError ||
    err instanceof EmptyPlanChangeTurnError ||
    err instanceof TooManyPlanChangeTargetsError ||
    err instanceof PlanChangeTurnConflictError ||
    // MOTIR-2787 — another session holds one of the scope's targets. The message
    // names the item, the holder and the lease expiry, which is what lets an
    // agent decide between waiting and planning something else instead of
    // retrying the same refused call.
    err instanceof PlanTargetLockedError ||
    // MOTIR-7639 — a turn on an ENDED session; the agent opens a new one.
    err instanceof PlanSessionEndedError
  ) {
    return toolError(err.code, err.message);
  }
  // Workspace-membership gate (MOTIR-1879): `list_projects` calls a service
  // whose FIRST act is `projectsService.assertMembership` against the token's
  // bound workspace. The bearer gate already vouched for that membership, so
  // this is only reachable in the race where it was revoked mid-request — map it
  // to a clean tool error so an agent reads NOT_A_MEMBER and stops, rather than
  // an opaque JSON-RPC internal error.
  // The folder family (MOTIR-5409). Enumerated rather than matched on a base,
  // because `lib/folders/errors.ts` has none — each class is its own. Every one
  // is something an agent can act on: a folder id that is gone (a retried
  // delete), a name already taken at that level (a retried create — the message
  // names it), a move into its own subtree, another project's folder, a subtask
  // that would be left with no parent and no folder, and a work item given a
  // parent AND a folder at once (MOTIR-5407's placement rule, which the work-item
  // tools reach through the same service).
  if (
    err instanceof FolderNotFoundError ||
    err instanceof InvalidFolderNameError ||
    err instanceof FolderNameTakenError ||
    err instanceof FolderCycleError ||
    err instanceof CrossProjectFolderError ||
    err instanceof SubtaskNeedsPlacementError ||
    err instanceof PlacementConflictError
  ) {
    return toolError(err.code, err.message);
  }
  if (err instanceof NotAMemberError) {
    return toolError(err.code, err.message);
  }
  if (err instanceof McpMissingContextError) {
    return toolError(err.code, err.message);
  }
  // The CI-credit dispatch refusal (MOTIR-1901 · `ci-minutes-allowance.md`
  // §6.2–6.3). `next_ready` / `claim_next_ready` are dispatch paths, so an
  // exhausted org hits this instead of receiving work. The message already names
  // the minutes used, the pool, and the balance — §6.3 requires the surface to be
  // able to say WHY — so an agent reads CI_CREDITS_EXHAUSTED and stops honestly
  // rather than retrying against an opaque internal error. The sibling condition
  // one domain over (`MOTIR_AI_OUT_OF_CREDITS`) is mapped the same way above.
  if (err instanceof CiCreditsExhaustedError) {
    return toolError(err.code, err.message);
  }
  throw err;
}
