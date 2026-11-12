// The `/api/v1` error envelope (Story 11.1 · Subtask 11.1.2 — MOTIR-1858).
//
// ONE failure shape for the whole public API: `{ code, error }` plus the HTTP
// status — the convention `app/api/work-items/[id]/route.ts` already
// established, kept rather than forked (a second error shape means every client
// writes two parsers). Pinned in `docs/decisions/public-api-conventions.md` §4.
//
//   `code`  — a STABLE machine identifier. SCREAMING_SNAKE_CASE, never
//             localized, never reworded, never re-purposed. Clients branch on
//             it, so changing one is a breaking change.
//   `error` — a human sentence for a developer reading a terminal. Reworded
//             freely; nothing may parse it.
//
// The one deliberate exception is 500: an unexpected fault carries NO `code`
// (there is no stable contract for it), no stack, and no driver text. See
// `INTERNAL_ERROR_BODY`.

import type { V1ErrorStatus } from '@/lib/api/v1/openapi/statuses';

/** The wire body of a v1 failure. */
export interface ApiV1ErrorBody {
  code: string;
  error: string;
  /** `OBSOLESCENCE_REQUIRES_FINISHED` (MOTIR-6673): the card and the unfinished
   *  status it is at — `obsolescenceRequiresFinishedSchema`. */
  item?: { key: string; statusKey: string; statusCategory: string | null };
  /** `MARKED_CARD_CANNOT_REOPEN` (MOTIR-6673): the marked card, its mark and the
   *  refused target (null for a refused child write) — `markedCardCannotReopenSchema`. */
  mark?: { key: string; obsolescence: string; toStatusKey: string | null };
  /** `RATE_LIMIT_EXCEEDED` (MOTIR-8600): whole seconds to wait before retrying —
   *  the same number as the `Retry-After` header. */
  retryAfterSeconds?: number;
  /** `INVALID_SECTIONS` (MOTIR-9031): the sections the registry refused for the
   *  item's kind × type, by name — the same three lists the MCP tool names in its
   *  message. */
  sections?: {
    missing: string[];
    unknown: string[];
    invalid: { section: string; message: string }[];
  };
}

/**
 * An error the v1 wrapper knows how to render: it carries its own stable code
 * and HTTP status. Thrown by the wrapper itself (auth, scope, rate limit) and
 * by v1-layer parsing (an invalid cursor or limit); a route may throw one too
 * when the condition is an HTTP-shaped one with no domain error behind it.
 */
export class ApiV1Error extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiV1Error';
  }
}

/**
 * 401 — no token, malformed header, unknown token, revoked token, expired
 * token. All five produce THIS error with THIS message: the response never
 * distinguishes them.
 *
 * That is deliberate and load-bearing. Telling a caller which case applies
 * turns the endpoint into a token oracle — a probe that answers "does this
 * secret exist?" and "is it merely expired?". The shipped bearer gate already
 * refuses to distinguish them (`lib/apiTokens/routeAuth.ts` maps invalid /
 * revoked / expired to one `unauthenticated` reason); v1 matches it, and the
 * tests assert the five cases against ONE shared expectation so a future
 * "helpful" message cannot silently re-open the oracle.
 */
export class UnauthenticatedError extends ApiV1Error {
  constructor() {
    super('UNAUTHENTICATED', 401, 'Authentication required.');
    this.name = 'UnauthenticatedError';
  }
}

/**
 * 403 — a VALID token whose granted scopes do not include the one this route
 * declares. Distinct from 401 (which says nothing about the credential's
 * validity) and never a 200 with an empty body: a silent empty result would
 * make a permission problem look like missing data.
 */
export class InsufficientPermissionError extends ApiV1Error {
  constructor(requiredPermission: string) {
    super(
      'INSUFFICIENT_PERMISSION',
      403,
      `This token is not granted the '${requiredPermission}' permission required for this operation.`,
    );
    this.name = 'InsufficientPermissionError';
  }
}

/**
 * 403 — a RUN token (MOTIR-688) presented at a door that does not admit one.
 * A run token is a valid credential bound to ONE hosted dispatch run, and only
 * that run's ingest and its card's dispatch prompt accept it (`withV1Route`'s
 * `acceptsRunToken`). Its own code rather than `INSUFFICIENT_PERMISSION`,
 * because the grant is not what refused it — it holds the key the route asks
 * for — and a caller told "not granted `work_item:edit`" would look for a key
 * it already has.
 */
export class RunTokenNotAllowedError extends ApiV1Error {
  constructor() {
    super(
      'RUN_TOKEN_NOT_ALLOWED',
      403,
      'A hosted-run credential may only report to its own run and read its own card.',
    );
    this.name = 'RunTokenNotAllowedError';
  }
}

/**
 * 422 — a malformed request the caller can fix: an invalid cursor, an
 * out-of-range or non-numeric `limit`, a failed body validation.
 */
export class InvalidRequestError extends ApiV1Error {
  constructor(code: string, message: string) {
    super(code, 422, message);
    this.name = 'InvalidRequestError';
  }
}

/**
 * The DOMAIN error code → v1 status map. A typed service error carries a
 * stable `code` (the `readonly code` convention every `lib/<domain>/errors.ts`
 * follows); this is where v1 decides what that means over HTTP.
 *
 * Recognition is by CODE, not by class, so the wrapper does not import every
 * domain's error module — and, critically, an UNLISTED code is NOT rendered:
 * it falls through to a bare 500. A new endpoint that can raise a new domain
 * error adds its row here deliberately, which is the point — an error reaching
 * a client is part of the public contract and should never appear by accident.
 *
 * Seeded with exactly what Story 11.1's endpoints can raise. Stories 11.2 /
 * 11.3 extend it as their resources land.
 *
 * ⚠️ The VALUE type is `V1ErrorStatus` (Story 11.4 · Subtask 11.4.3), not
 * `number`: the statuses this API documents are a closed vocabulary
 * (`lib/api/v1/openapi/statuses.ts`, ADR §4's table in code), so a row mapped to
 * a status the emitted OpenAPI document has no word for is a COMPILE error here
 * rather than an undocumented response discovered by a client. Adding a status
 * is a contract change — ADR §8 permits a new CONDITION getting one (409 and 412
 * arrived that way) and forbids an existing condition changing one — so it is
 * made in the vocabulary, deliberately, and this map then compiles against it.
 */
export const DOMAIN_ERROR_STATUS: Readonly<Record<string, V1ErrorStatus>> = Object.freeze({
  // A token bound to workspace A asking about workspace B. 404, never 403 —
  // a 403 would confirm the resource EXISTS, an existence oracle over another
  // tenant's data. 403 answers "your token may not do this KIND of thing";
  // 404 answers "there is no such resource *for you*". (ADR §4.)
  NOT_A_MEMBER: 404,
  // 403 — the token is valid but its workspace's ORGANIZATION is suspended by
  // Motir staff (MOTIR-748). Raised by `apiTokensService.verify` only after the
  // credential is proven, so it is no existence oracle: the holder's own token
  // already names the org. Distinct from the 404 so a CLI can say why.
  ORGANIZATION_SUSPENDED: 403,
  // 403 — a per-org KILL-SWITCH is off for the token's organization (MOTIR-750):
  // `ai_planning`, `hosted_runs` or `web_search`. The body names the switch via
  // the message; the holder's own org, so no existence oracle.
  ORG_FEATURE_DISABLED: 403,

  // ── Story MOTIR-1789, the DISPATCH RUN ingest (MOTIR-1792) ────────────────
  // Every row is driven through the wrapper by a real service error in
  // `tests/api/v1/dispatch-runs-route.test.ts` — an unproven row is
  // indistinguishable from a missing one, and a missing one is a silent 500.
  //
  // 404 for a run in another workspace as well as one that never existed: RLS
  // makes the read return nothing, so the service cannot tell the two apart even
  // if it wanted to. The existence-oracle contract falls out of the tenancy gate
  // rather than being re-implemented on top of it (ADR §4).
  DISPATCH_RUN_NOT_FOUND: 404,
  // 409 — the run is already closed. Well-formed, and would have been accepted a
  // moment earlier, which is what a conflict means. Raised by BOTH the append and
  // the close from the SAME locked read.
  DISPATCH_RUN_TERMINAL: 409,
  // 403 — a hosted run's own credential naming another run, or opening one
  // (MOTIR-688). Checked before the run is read, so it is not an existence
  // oracle: the answer is the same for a run that exists and one that does not.
  DISPATCH_RUN_TOKEN_OUT_OF_SCOPE: 403,
  // 422 — a run-found report's reason empty or over its bound (MOTIR-8698). The body
  // schema refuses it first as `INVALID_BODY`; this row is the service's own guard.
  RUN_FOUND_REPORT_REASON_INVALID: 422,
  // ── MOTIR-8722, the run's discrepancy and STOP reports (`…/discrepancy`, `…/stop`) ──
  // 422 — a malformed discrepancy record or stop report; the body schema refuses the same
  // input first as `INVALID_BODY`, these rows are the services' own guards.
  RUN_DISCREPANCY_INVALID: 422,
  RUN_STOP_REPORT_INVALID: 422,
  // 409 — the leg already carries a discrepancy record (the agent made the call itself).
  DISCREPANCY_ALREADY_RECORDED: 409,
  // ── MOTIR-11055, the run's REPOSITORY door (`POST …/dispatch-runs/{id}/repository`) ──
  // 422 — the run's card is not an init card, or it declares another repository name.
  RUN_CARD_NOT_INIT_CARD: 422,
  RUN_REPOSITORY_NAME_MISMATCH: 422,
  // The creation sequence's own refusals (MOTIR-11038), at the statuses the repository-set
  // routes already answer them with (`lib/projectRepos/errorResponse.ts`) — so one refusal
  // has one status whichever door it came through.
  REPO_EXISTS_WITH_OTHER_SPEC: 409,
  REPO_ESTABLISH_BUSY: 409,
  PROJECT_REPO_NAME_TAKEN: 409,
  PROJECT_REPO_INVALID_FIELD: 422,
  PROJECT_REPO_SEED_REFUSED: 422,
  ai_plan_required: 402,
  plan_unknown: 503,
  // MOTIR-10877 — the run's How to test (`POST …/dispatch-runs/{id}/how-to-test`) answers the
  // record's own refusals, each one a request the CLI can fix.
  TEST_INSTRUCTIONS_WORK_ITEM_NOT_FOUND: 404,
  TEST_INSTRUCTIONS_REPO_NOT_IN_PROJECT: 422,
  TEST_INSTRUCTIONS_CAP_EXCEEDED: 422,
  TEST_INSTRUCTIONS_INVALID_FIELD: 422,
  TEST_INSTRUCTIONS_CONFLICT: 409,
  // ── MOTIR-6821, a hosted REVIEW run's prompt and verdict (`hosted-agent-run.md` §8) ──
  // 403 — not a review run's own credential: a PAT, a device token, a BUILD run's token.
  REVIEW_RUN_TOKEN_REQUIRED: 403,
  // 404 — the card has no `agent_review` gate at all; nothing to review or answer.
  REVIEW_GATE_NOT_FOUND: 404,
  // 409 — this run already gave its ONE verdict (§8.4).
  REVIEW_VERDICT_ALREADY_SUBMITTED: 409,
  // 409 — a LATE verdict (`approval-gates.md` §12.5): a version the gate no longer asks
  // about, or a gate already superseded or decided. Recorded on the run; nothing decided.
  REVIEW_STALE: 409,
  // ── MOTIR-10333, the USER-TOKEN verdict door (`approval-gates.md` §12.11–§12.13) ──
  // 404 — the card delivers no pull request: there is no version a review could be about.
  REVIEW_NOTHING_TO_REVIEW: 404,
  // 409 — a LATE verdict (a version the card no longer has) or a SECOND one (the version
  // was already reviewed). Stored with that outcome; nothing decided.
  REVIEW_VERDICT_LATE: 409,
  REVIEW_VERDICT_SECOND: 409,
  // 422 — the card is not a run target; the message names the one to review instead.
  REVIEW_TARGET_NOT_RUN_TARGET: 422,
  // 422 — the service's own body guard (findings on a send-back, evidence on `met`, a
  // harness and a model); the body schema refuses the same input first as `INVALID_BODY`.
  INVALID_REVIEW_VERDICT: 422,
  // ── MOTIR-10334, DISMISS THE REVIEW (`approval-gates.md` §12.15) ──
  // 403 — the caller holds `work_item:edit` but is not the routed person (§12.3).
  REVIEW_DISMISSAL_FORBIDDEN: 403,
  // 409 — nothing to dismiss at the current version, already dismissed, or a push moved
  // the version so the send-back has ended. Nothing written.
  NO_STANDING_REVIEW_SENDBACK: 409,
  REVIEW_SENDBACK_ALREADY_DISMISSED: 409,
  REVIEW_DISMISSAL_STALE: 409,
  // 422 — the reason is empty once trimmed, or over 2000 characters.
  REASON_REQUIRED: 422,
  // ── MOTIR-6538, a hosted run's git credentials ─────────────────────────────
  // 409 — the run ended between its read and the mint (a close racing the call).
  // The same fact as DISPATCH_RUN_TERMINAL, raised from the mint's own re-read.
  RUN_CREDENTIAL_RUN_NOT_LIVE: 409,
  // 409 — a repository of the run can no longer be written by its App (the
  // installation lost it, or its write permissions are not accepted). The run
  // cannot go on; the message names every such repository and its fix.
  hosted_repository_not_writable: 409,
  // 503 — GitHub could not be reached, or the App a repository needs is not
  // configured here: a Motir-side fault the run can retry, not a refusal.
  run_git_credential_unavailable: 503,
  // 409 — two opens raced on one idempotency key. The ordinary repeat is not this
  // (it returns the existing run); this is the narrow window in which the unique
  // index is the arbiter, and it exists so a `P2002` never escapes as a bare 500.
  DUPLICATE_DISPATCH_RUN: 409,
  // 422 — a close-out prompt asked for a run with no run target (an unscoped
  // batch). Refused rather than defaulted (MOTIR-5357).
  NO_RUN_TARGET: 422,
  // 422 — an event names a card the run does not own. A client bug rather than a
  // card to add: the SET is the plan the run published, and letting it grow
  // behind that plan would defeat the record.
  UNKNOWN_DISPATCH_RUN_CARD: 422,
  // 422 — `model` on an event that is not `agent_exited` (MOTIR-7502). The leg's
  // model has one producer, the agent's exit; refused by name, never dropped.
  DISPATCH_RUN_EVENT_MODEL_NOT_ALLOWED: 422,
  // 413 — an over-sized opt-in log body. REFUSED rather than truncated: a
  // silently shortened log reads as the whole tail, and the line that mattered is
  // the one that was cut.
  DISPATCH_RUN_BODY_TOO_LARGE: 413,
  // 422 — the run has reached its per-run event ceiling, the bound that makes
  // accepting a log body safe at all. The run stays closable.
  DISPATCH_RUN_EVENT_LIMIT: 422,
  // MOTIR-6531 — `dispatch-prompt?continueFrom=` naming a run that cannot be
  // continued (open, succeeded, not this item's, another tenant's).
  CONTINUE_FROM_INVALID: 422,

  // ── Story 11.2, the work-item resource ────────────────────────────────────
  // Each row is added deliberately and each is exercised by a test that drives
  // the REAL error through the wrapper — an unproven row is indistinguishable
  // from a missing one, and a missing one is a silent 500.

  // 11.2.2 (MOTIR-2040) — the single-item read.
  WORK_ITEM_NOT_FOUND: 404,
  PROJECT_NOT_FOUND: 404,

  // MOTIR-5048 — `POST …/work-items/{key}/pull-requests` naming a repository
  // that is not CONNECTED to the caller's workspace.
  //
  // 404, and for the same reason as every other row here rather than by
  // analogy: a 403 would confirm the repository exists somewhere, over a
  // resource belonging to another tenant. `owner/name` is a name the caller
  // chose, so "there is no such repository *for you*" is the whole of the
  // honest answer.
  //
  // ⚠️ IT WAS A 500 UNTIL THIS ROW EXISTED, which is why the row is here rather
  // than left to the wrapper's default: an unmapped domain error is an internal
  // error, and this one is entirely ordinary — a typo in a repository name is
  // the commonest way to call this operation wrong. Driven through the wrapper
  // by `work-item-pull-requests-route.test.ts`, per the note above.
  GITHUB_REPO_NOT_FOUND: 404,
  // ⚠️ 404, NOT 403. A 403 on a project the caller cannot browse confirms that
  // the project EXISTS — the same existence-oracle argument ADR §4 makes for
  // cross-tenant access, applied WITHIN a tenant. A caller who may not browse a
  // project must not be able to enumerate which project keys are real.
  PROJECT_ACCESS_DENIED: 404,

  // 11.2.6 (MOTIR-2046) — the write pair. Every one is a request the caller can
  // fix, proven by a test that drives the REAL service error through the wrapper.
  ILLEGAL_PARENT_TYPE: 422,
  CROSS_PROJECT_PARENT: 422,
  PARENT_CYCLE: 422,
  DEPTH_LIMIT_EXCEEDED: 422,
  TYPE_NOT_ALLOWED_ON_KIND: 422,
  DIFFICULTY_NOT_ALLOWED_ON_KIND: 422,
  // MOTIR-6581 — an `obsolescence` outside the closed `outdated · deprecated`
  // enum. Reached over v1 by BOTH checks with one code: the body schema's refusal
  // is re-coded to this (`TYPED_FIELD_REFUSALS` in `workItems/schema.ts`), and
  // the service's own `InvalidObsolescenceError` backstop maps here rather than
  // falling through to a 500.
  INVALID_OBSOLESCENCE: 422,
  // The sections write interface (Story MOTIR-9023 · MOTIR-9031): `sections` the
  // registry refuses for the item's kind × type (a missing, unknown or invalid
  // section, named in the `sections` field), and `sections` beside `descriptionMd`.
  INVALID_SECTIONS: 422,
  SECTIONS_AND_DESCRIPTION_CONFLICT: 422,
  // MOTIR-6672 · MOTIR-6673 — a mark SET on a card whose status is outside the
  // done category. The value is valid; the card is not finished, and the remedy is
  // to archive it instead (or finish it first). Its payload rides as `item`.
  OBSOLESCENCE_REQUIRES_FINISHED: 422,
  ASSIGNEE_NOT_IN_WORKSPACE: 422,
  REPORTER_NOT_IN_WORKSPACE: 422,
  UNKNOWN_TARGET_REPO: 422,
  // MOTIR-3039 — a write naming a `project_repository` ROW that is not one of the
  // item's own project's. The reference model's counterpart of the row above, and
  // a 422 for the same reason: the caller can fix it, and the message names the
  // project's rows so they can.
  UNKNOWN_PROJECT_REPO_REF: 422,
  // MOTIR-2978 — a write setting a CONTAINER's repositories, which are derived
  // from its subtasks'. A 422 rather than a silent accept: the next recompute
  // would erase the value with no signal to the caller.
  CONTAINER_REPO_SET_NOT_WRITABLE: 422,
  ARCHIVED_TARGET_REPO: 422,

  // ── Story MOTIR-3000, the general attachment door (MOTIR-3057) ────────────
  // Every one of these is thrown by `attachmentsService`, unchanged, on the
  // path the BROWSER route already uses — so the two entrances answer one rule
  // with one status. `tests/api/v1/attachments-route.test.ts` drives each
  // through BOTH routes in the same file, which is what makes "no gate
  // re-implemented" checkable rather than a review opinion.
  FILE_TOO_LARGE: 413,
  UNSUPPORTED_FILE_TYPE: 415,
  // The per-user upload throttle inside the service — distinct from the
  // wrapper's per-token budget, which answers 429 before the handler runs. Same
  // status either way: from the caller's seat both mean "slow down".
  RATE_LIMITED: 429,
  // `attachment:create` refused on the item's project. 403, not 404: the caller
  // could BROWSE the item to get here (a non-browsable one is already 404 via
  // WORK_ITEM_NOT_FOUND), so no existence is revealed by saying they may not
  // write to it.
  ATTACHMENT_FORBIDDEN: 403,
  // The organization's TOTAL storage cap. 402 rather than 413: the file is not
  // too large, the account is too full, and the fix is an upgrade rather than a
  // smaller file.
  ENTITLEMENT_EXCEEDED: 402,
  // MOTIR-2728 — a write supplying BOTH `targetRepo` and `targetRepos`. The
  // scalar IS the set's first element, so the two can disagree; a refusal beats a
  // precedence rule that drops a repository the caller believed they recorded.
  CONFLICTING_TARGET_REPO_INPUT: 422,
  INVALID_ESTIMATE: 422,
  // ⚠️ 412, a status ADR §4's table does not yet list. A new CONDITION getting a
  // status is additive under §8 (unlike an existing condition changing one), so
  // the row is appended to the ADR rather than emitted undocumented.
  STALE_WORK_ITEM: 412,

  // 11.2.7 (MOTIR-2048) — the transitions sub-resource. Two DISTINCT codes:
  // collapsing them would make a typo (a status the workflow does not define)
  // and a workflow rule (a real status not reachable from here) indistinguishable,
  // and a client can fix only one of those.
  ILLEGAL_TRANSITION: 422,
  UNKNOWN_STATUS: 422,
  // MOTIR-2709 — the close-out artifact-evidence gate: a `type: deploy` item
  // moved to a done-category status with no comment recording what it published.
  // A THIRD distinct code for the same sub-resource, for the same reason the two
  // above are distinct: the caller's fix is neither a different status nor a
  // different spelling, it is to record the artifact (or declare there is none),
  // and only its own code can say that. No new STATUS, so no ADR §4 row — 422
  // already covers a request refused on the resource's own rules.
  MISSING_ARTIFACT_EVIDENCE: 422,
  // MOTIR-3229 — the container-completeness gate: an item with open children
  // moved into a status that claims its work is built. A FOURTH distinct code on
  // this sub-resource, for the reason the three above are distinct: the caller's
  // fix is neither a different status, a different spelling, nor a recorded
  // artifact — it is to land (or re-parent, or deliberately complete) the
  // children the error names. No new STATUS, so no ADR §4 row.
  CONTAINER_HAS_OPEN_CHILDREN: 422,
  // MOTIR-5526 — the approval-gate guard: an item whose `awaiting` approval gate
  // OWNS the target status (ADR `approval-gates.md` §6d AMENDMENT). A FIFTH
  // distinct code on this sub-resource, for the reason the four above are
  // distinct: the edge is legal, the status is spelled right, nothing is missing
  // — the fix is for a person to decide the gate. No new STATUS, so no ADR §4 row.
  APPROVAL_GATE_PENDING: 422,
  // MOTIR-6265 — an UNDECIDED plan holds the card at Planning (`agent-authored-plans.md`
  // AMENDMENT 21). The same status as the gate's refusal, for the same reason: the
  // edge is legal and the fix is a person deciding the plan.
  PLAN_TARGET_HELD: 422,
  // MOTIR-6672 · MOTIR-6673 — a MARKED card stays finished: a move out of the done
  // category, or new work under it, is refused until a person clears the mark. The
  // same status as the plan hold, for the same reason: the edge is legal and the
  // fix is a person's (clear the mark). Its payload rides as `mark`.
  MARKED_CARD_CANNOT_REOPEN: 422,

  // 11.2.9 (MOTIR-2051) — the link edges.
  SELF_LINK: 422,
  WORK_ITEM_LINK_CYCLE: 422,
  // ⚠️ 409, a status ADR §4's table does not list either — appended with its
  // condition, as a NEW condition rather than a changed one. A duplicate link is
  // a conflict with existing STATE, not a malformed request: the caller's body
  // is perfectly valid, the edge simply already exists.
  DUPLICATE_LINK: 409,
  // 404 on the TARGET key, not 403: confirming that the other item exists in
  // another tenant is precisely the existence oracle ADR §4 forbids.
  CROSS_WORKSPACE_LINK: 404,
  WORKSPACE_MISMATCH_LINK: 404,
  WORK_ITEM_LINK_NOT_FOUND: 404,

  // 11.2.8 (MOTIR-2049) — comments.
  COMMENT_NOT_FOUND: 404,
  EMPTY_COMMENT_BODY: 422,
  INVALID_PARENT_COMMENT: 422,
  REPLY_DEPTH_EXCEEDED: 422,
  // ⚠️ 403, NOT 404 — the one place in this story the existence-oracle rule does
  // NOT apply. The item's own visibility is settled BEFORE the comment gate
  // runs, so the caller can already see the item; this is a genuine "you may not
  // do this KIND of thing" refusal, which is exactly what ADR §4 says 403 means.
  COMMENT_FORBIDDEN: 403,

  // 11.2.4 (MOTIR-2042) — the FilterAST the collection endpoint accepts. Every
  // one is a malformed REQUEST the caller can fix, so every one is a 422 with a
  // code specific enough to act on: which field, which operator, which value.
  UNKNOWN_FILTER_FIELD: 422,
  UNKNOWN_FILTER_OPERATOR: 422,
  INVALID_FILTER_VALUE: 422,
  FILTER_TOO_LARGE: 422,
  MALFORMED_FILTER: 422,

  // ── Story 11.3, the planning resources ────────────────────────────────────
  // Same discipline as 11.2's rows: each is added by the card whose endpoint can
  // raise it, and each is exercised by a test that drives the REAL error through
  // the wrapper. An unlisted code is a bare 500, which is exactly why a row is
  // never added speculatively.

  // 11.3.4 (MOTIR-2061) — the sprint reads. 404, not 403: `getById` is
  // workspace-gated, so a sprint in another tenant and one that never existed
  // are the same answer (ADR §4's existence-oracle rule).
  SPRINT_NOT_FOUND: 404,

  // 11.3.5 (MOTIR-2062) — the sprint write pair.
  //
  // ⚠️ 403, and DELIBERATELY a different `code` from `INSUFFICIENT_PERMISSION`. Every
  // sprint write calls `assertSprintAdmin`, so a token that DOES carry
  // `sprint:manage` is still refused when its OWNER is an ordinary project
  // member — a scope narrows the owner's role and never widens it (ADR §3).
  // "My token has the scope and I still get 403" is the single most confusing
  // thing this endpoint can do to an integrator, and a shared code would leave
  // them re-issuing tokens forever against a problem no token can fix.
  NOT_SPRINT_ADMIN: 403,

  // MOTIR-2291 — the shared permission gate's 403: `PermissionDeniedError`,
  // raised by `projectAccessService.assertPermission` for a BROWSER who does not
  // hold the key. Same 403-not-INSUFFICIENT_PERMISSION reasoning as the row above, and the same
  // fix on the caller's side (a role change, never a new token) — but the message
  // NAMES the missing key, so it is a distinct code rather than a second alias.
  // A NON-browser never produces it: the gate raises the 404 first.
  PERMISSION_DENIED: 403,
  INVALID_SPRINT_NAME: 422,
  SPRINT_WINDOW_INVALID: 422,
  // A conflict with existing STATE, not a malformed request: the body is fine,
  // the sprint is simply frozen.
  CANNOT_MODIFY_COMPLETED_SPRINT: 409,

  // 11.3.6 (MOTIR-2063) — the lifecycle moves, the only read-derived writes in
  // this story.
  //
  // ⚠️ 409, not 422. Losing the race to activate is a conflict with STATE the
  // caller could not have known about: the request was valid when it was sent and
  // another one committed first. A 422 would tell a client to fix its body, which
  // is exactly the wrong instruction — the right one is to re-read and retry.
  // This is what the shipped `FOR UPDATE` guard turns a lost race INTO, so a
  // concurrent start can never surface as a raw unique-violation 500.
  SPRINT_ALREADY_ACTIVE: 409,
  // 422: the sprint is in the wrong STATE for the move and the caller can see
  // that from a read — starting a non-planned sprint, completing a non-active one.
  SPRINT_NOT_STARTABLE: 422,
  SPRINT_NOT_COMPLETABLE: 422,
  INVALID_CARRY_OVER_TARGET: 422,

  // MOTIR-3049 — `POST /api/v1/scope-claims` asked to claim a project's ACTIVE
  // sprint and the project has none.
  //
  // ⚠️ 409, not 404 and not 422. The body is well-formed and the project exists,
  // so 422 would tell the caller to fix a request that is already correct; and
  // the sprint is not a resource this request ADDRESSED, so 404 would read as
  // "that project is not there". What is wrong is the project's STATE, and the
  // caller's fix is to start a sprint — the same reasoning
  // `CANNOT_MODIFY_COMPLETED_SPRINT` above records. The error itself predates
  // this route (`validate_sprint` has raised it since 7.8.15); this line is the
  // first time a v1 route can surface it, which is why it is mapped now and not
  // then — the map is grown by the operation that can produce the code, never
  // speculatively.
  NO_ACTIVE_SPRINT: 409,

  // 11.3.7 (MOTIR-2064) — the membership moves.
  //
  // 422: the batch is too large for one atomic move. The service's message names
  // the cap, so a caller can split the batch rather than guess at it. NOT
  // silently truncated — a partial move is exactly what the atomicity of these
  // endpoints exists to prevent.
  BULK_BATCH_TOO_LARGE: 422,
  // 422: the item and the sprint belong to different projects. A request the
  // caller can fix, and one that rejects the WHOLE batch before any write.
  CROSS_PROJECT_SPRINT_ASSIGNMENT: 422,

  // ── Story 11.7, the work-loop operations ──────────────────────────────────
  // Same discipline again: added by the card whose endpoint can raise it, each
  // driven through the wrapper by a test.

  // 11.7.5 (MOTIR-2239) — expansion and the plan reads.
  //
  // 404, not 403: `plansService.getPlan` is workspace-scoped and then applies
  // `assertCanBrowse`, so a plan in another tenant and one that never existed
  // are the same answer (§4's existence-oracle rule).
  PLAN_NOT_FOUND: 404,
  // MOTIR-3021 / MOTIR-3023 — the automatic-approval BOUND
  // (`run-findings-protocol.md` Q2, B1). 422, not 403 or 404: the caller's
  // credential is fine and the card exists — there is simply no plan of this
  // card's own to approve. 403 would read as "you may not approve", which is
  // false; 404 would deny the card, which the caller can see.
  NO_PLAN_FOR_WORK_ITEM: 422,
  // The one-shot approve guard, reaching the public entrance for the first time
  // (MOTIR-3021). 409 — the SAME status the in-app approve answers, because it
  // is the same condition arriving through a second door: the plan already left
  // `planned`. Mirrored deliberately rather than softened into a no-op; two
  // entrances answering one condition two ways is what "no second approval
  // implementation" is meant to prevent.
  PLAN_NOT_IN_EXPECTED_STATUS: 409,
  // MOTIR-6105 — a `planned` plan holding NO proposals (the legacy row MOTIR-4124
  // left unmigrated). 409, the status the in-app approve answers for the same
  // `PlanHasNoProposalsError`: the request is fine, the plan's STATE is what
  // cannot be approved, and the answer the reviewer is owed is Decline. Unmapped,
  // the wrapper logged a correct refusal as an unhandled fault and answered 500.
  PLAN_HAS_NO_PROPOSALS: 409,
  // ⚠️ 422 HERE, where the BROWSER route answers 400 — and the difference is
  // the published vocabulary, not a disagreement about the condition. v1's
  // statuses are a closed set (`lib/api/v1/openapi/statuses.ts`, ADR §4's table
  // in code) and 400 is not in it; every "we refused before writing anything,
  // and here is what to fix" on this API is a 422. Adding 400 to the vocabulary
  // would be a contract change of its own, made in the ADR rather than as a side
  // effect of a new route — so the confirmation gate's two refusals take the
  // status this API already has a word for.
  PLAN_GRAMMAR_VIOLATION: 422,
  INVALID_PLAN_REF_GRAPH: 422,
  PLAN_TARGET_IMMUTABLE: 409,
  // MOTIR-6663 — the approve gate refusing a `modify` that MARKS a target no
  // longer finished (reopened since the append). 422, as at the proposal doors.
  INVALID_PROPOSAL: 422,
  PLAN_ITEM_UNKNOWN_TARGET_REPO: 422,
  PLAN_ITEM_UNKNOWN_TARGET_REPO_ROLE: 422,
  // MOTIR-11039 — a vocabulary role the project's set resolves to no single row.
  PLAN_ITEM_UNRESOLVABLE_TARGET_REPO_ROLE: 422,
  UNRESOLVED_PLAN_REF: 422,
  PLAN_ITEM_TARGET_MISSING: 422,
  // 422, and it means exactly ONE thing here: the target is a LEAF, which
  // cannot be expanded. The service raises this same error for a key naming no
  // item too — which would be a 404, not a 422 — so the route reads the item
  // FIRST and lets that read raise its own `WORK_ITEM_NOT_FOUND`. A status map
  // cannot split one error class after the fact; the route has to not conflate
  // them in the first place.
  INVALID_TARGET: 422,
  // ⚠️ 402, a status ADR §4's table did not list. A NEW condition getting a
  // status, which §8 permits (409 and 412 arrived the same way). The request was
  // valid and was refused for want of BALANCE — 422 would tell a client to fix
  // its body, 429 would tell it to wait for a window that never refills, and
  // both are the wrong instruction. The right one is "top up".
  MOTIR_AI_OUT_OF_CREDITS: 402,
  CI_CREDITS_EXHAUSTED: 402,
  // ⚠️ 503, also new, also a new condition. An upstream dependency being down or
  // misconfigured is not an UNEXPECTED fault, so §4's bare 500 ("no code, no
  // stack") would tell a client nothing it could act on. 503 says "the request
  // was fine, come back" — the one answer that makes a retry loop correct rather
  // than a way to hammer an outage.
  MOTIR_AI_UNAVAILABLE: 503,
  MOTIR_AI_CONFIG: 503,
  MOTIR_AI_UNAUTHORIZED: 503,

  // 11.7.6 (MOTIR-2240) — the planning conversation.
  //
  // 404: the thread does not exist for this scope. Same existence-oracle rule —
  // a scope in another tenant never reaches the service, because the project
  // read answers 404 first.
  PLAN_CHANGE_SESSION_NOT_FOUND: 404,
  // MOTIR-6028: a `sessionId` that names no session of THIS project — 404, the
  // same no-existence-leak answer as a missing thread.
  PLAN_SESSION_NOT_FOUND: 404,
  // ⚠️ 409, not 422. Two writers appended to one thread and lost the race for a
  // `seq`; the body was perfectly valid when it was sent. 422 would tell the
  // caller to fix its body, which is the wrong instruction — the right one is to
  // re-read and retry.
  PLAN_CHANGE_TURN_CONFLICT: 409,
  // 422: a submit on a thread with nothing on it. The caller can fix that by
  // appending a turn, and it must NOT be a 500 — an empty thread is an ordinary
  // state, not a fault.
  PLAN_CHANGE_EMPTY_INTENT: 422,
  // 422: an empty turn body.
  PLAN_CHANGE_EMPTY_TURN: 422,
  // 422: the anchor set exceeds `MAX_SCOPE_TARGETS`. Refused BEFORE the
  // resolution fan-out, because the cost of a huge set is that fan-out.
  PLAN_CHANGE_TOO_MANY_TARGETS: 422,
  // ⚠️ 409, not 403. Another planning session holds one of this scope's targets
  // (MOTIR-2787). The caller is permitted to plan it — a permission answer would
  // be a lie, and would tell them to go get access they already have. It is a
  // STATE conflict, and a self-clearing one: the message names the item, the
  // holder, and the time the lease runs out, so "retry later" is actionable
  // rather than a shrug.
  PLAN_TARGET_LOCKED: 409,
  // 409: a turn on a session that has ENDED (AMENDMENT 23 §3; MOTIR-7639). The
  // session exists and is finished — a state, not a permission or a body fault.
  PLAN_SESSION_ENDED: 409,
  // 409: a copy of a session that is open, or ended by a decision or a restart
  // (AMENDMENT 23 §6; MOTIR-7641).
  PLAN_SESSION_NOT_COPYABLE: 409,

  // ── Story MOTIR-9023, the SECTION SETS read (MOTIR-9029) ───────────────────
  // 422 — a `kind` or `type` that names no cell of the registry. The caller can
  // fix it, and it is never answered with a default set.
  UNKNOWN_SECTION_CELL: 422,

  // ── Story MOTIR-5310, the FOLDER resource (MOTIR-5408) ────────────────────
  // The statuses `lib/folders/errors.ts`' own header names, so the tree's
  // actions and this door describe one refusal one way. Each is driven through
  // the wrapper by `tests/api/v1/folders-routes.test.ts`; before these rows every
  // one of them rendered as a bare 500.
  //
  // 404 for a folder in another workspace or a project the token is not bound to
  // as well as one that never existed — the existence-oracle rule (ADR §4).
  FOLDER_NOT_FOUND: 404,
  // 422 — empty after trimming, or over the name cap. The caller can fix it.
  INVALID_FOLDER_NAME: 422,
  // 409 — a sibling already has this name, case-insensitively. The body is fine;
  // the level's STATE is not what the request assumed.
  FOLDER_NAME_TAKEN: 409,
  // 422 — a folder moved into itself or one of its own folders.
  FOLDER_CYCLE: 422,
  // 422 — a destination folder in another project. Folders are project-local.
  CROSS_PROJECT_FOLDER: 422,
  // 409 — deleting a ROOT folder would leave a subtask with neither a parent nor
  // a folder. A conflict with what the folder holds, fixed by moving it first.
  SUBTASK_NEEDS_PLACEMENT: 409,
  // 422 — a work item named BOTH a work-item parent and a folder (MOTIR-5412, the
  // `/api/v1` work-item placement). An item hangs under a work item or sits in a
  // folder, never both, and the request describes one placement twice. The caller
  // can fix it by sending one of the two.
  PLACEMENT_CONFLICT: 422,

  // 11.7.7 (MOTIR-2241) — the activity read. Its own failure modes are the
  // wrapper's (401/403/429), the shared cursor 422, and `WORK_ITEM_NOT_FOUND`
  // above; the view and order parameters raise `InvalidRequestError` directly,
  // which is already a v1 error rather than a domain one.

  // ⚠️ DELIBERATELY ABSENT, and this comment is the deliberation:
  //   • `MOTIR_AI_BAD_REQUEST` — motir-ai rejected a payload MOTIR-CORE built.
  //     That is our bug, not the caller's, and §4's bare 500 is exactly the
  //     right answer: no `code` to branch on, because there is no stable
  //     contract for one of our own faults. A row here would leak an internal
  //     message as a public code.
  //   • `MOTIR_AI_JOB_NOT_FOUND` / `MOTIR_AI_JOB_FAILED` — neither escapes these
  //     endpoints. `resolveJobState` catches every `MotirAiError` and reports it
  //     as `job.reachable: false` / `job.failure`, because the PLAN read already
  //     succeeded and degrading the job block beats failing an answer we have.
});

/** The 500 body: no `code`, no stack, no driver text. */
export const INTERNAL_ERROR_BODY: Readonly<{ error: string }> = Object.freeze({
  error: 'Internal server error.',
});

/** Anything carrying a string `code` — the shape every typed domain error has. */
/**
 * The additive payload the two finished-card refusals carry (MOTIR-6673), read off
 * the error's own fields by CODE — this module maps domain errors by their code and
 * imports none of them, so it stays importable from the request path. Every other
 * code carries nothing extra.
 */
function obsolescencePayload(err: { code: string }): Pick<ApiV1ErrorBody, 'item' | 'mark'> {
  const e = err as Record<string, unknown>;
  if (err.code === 'OBSOLESCENCE_REQUIRES_FINISHED') {
    return {
      item: {
        key: String(e['key']),
        statusKey: String(e['statusKey']),
        statusCategory: typeof e['statusCategory'] === 'string' ? e['statusCategory'] : null,
      },
    };
  }
  if (err.code === 'MARKED_CARD_CANNOT_REOPEN') {
    return {
      mark: {
        key: String(e['key']),
        obsolescence: String(e['obsolescence']),
        toStatusKey: typeof e['toStatusKey'] === 'string' ? e['toStatusKey'] : null,
      },
    };
  }
  return {};
}

/**
 * The `INVALID_SECTIONS` body's by-name findings (MOTIR-9031), read off the error's
 * own fields by CODE — like {@link obsolescencePayload}, this module imports no
 * domain class.
 */
function sectionsPayload(err: { code: string }): Pick<ApiV1ErrorBody, 'sections'> {
  if (err.code !== 'INVALID_SECTIONS') return {};
  const e = err as Record<string, unknown>;
  const names = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  const invalid = Array.isArray(e['invalid'])
    ? (e['invalid'] as { section?: unknown; message?: unknown }[]).map((i) => ({
        section: String(i.section),
        message: String(i.message),
      }))
    : [];
  return { sections: { missing: names(e['missing']), unknown: names(e['unknown']), invalid } };
}

function hasStringCode(err: unknown): err is { code: string; message: string } {
  return (
    typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string'
  );
}

/**
 * The rate-limit refusal's numeric retry field (MOTIR-8600). Detected by CODE
 * plus a numeric field rather than by class, so this module keeps importing no
 * domain class it did not already import (`RateLimitExceededError` lives in
 * `rateLimit.ts`, which imports THIS file).
 */
function retryAfterPayload(err: ApiV1Error): Pick<ApiV1ErrorBody, 'retryAfterSeconds'> {
  if (err.code !== 'RATE_LIMIT_EXCEEDED') return {};
  const seconds = (err as { retryAfterSeconds?: unknown }).retryAfterSeconds;
  return typeof seconds === 'number' && Number.isFinite(seconds)
    ? { retryAfterSeconds: seconds }
    : {};
}

/**
 * Classify a thrown value into the v1 envelope.
 *
 * Returns `undefined` for anything unrecognised — a raw `Error`, a Prisma
 * fault, a domain error whose code is not in {@link DOMAIN_ERROR_STATUS} — so
 * the caller renders {@link INTERNAL_ERROR_BODY} at 500 rather than leaking a
 * message that was never meant to be a public contract.
 */
export function classifyApiV1Error(
  err: unknown,
): { status: number; body: ApiV1ErrorBody } | undefined {
  if (err instanceof ApiV1Error) {
    return {
      status: err.status,
      body: { code: err.code, error: err.message, ...retryAfterPayload(err) },
    };
  }
  if (hasStringCode(err)) {
    const status = DOMAIN_ERROR_STATUS[err.code];
    if (status !== undefined) {
      return {
        status,
        body: {
          code: err.code,
          error: err.message,
          ...obsolescencePayload(err),
          ...sectionsPayload(err),
        },
      };
    }
  }
  return undefined;
}
